// supabase/functions/_shared/xlsxWriter.ts
// Shared workbook writer for the edge functions.
//
// xlsx-js-style 1.2.0 (SheetJS 0.18.5) silently drops `!views` frozen panes
// (the written sheet XML only has <sheetView workbookViewId="0"/>) and has no
// tab-colour support, so both are injected into each sheet's XML after
// writing. Sheet N in the zip is the Nth entry of wb.SheetNames.
import XLSX from "npm:xlsx-js-style@1.2.0";
import zlib from "node:zlib";

export function writeXlsxWithViews(wb: XLSX.WorkBook): Uint8Array {
  // type: "buffer" returns a real Uint8Array under Deno's npm compat;
  // type: "array" gives a bare ArrayBuffer.
  const raw = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
  // deno-lint-ignore no-explicit-any
  const CFB = (XLSX as any).CFB;
  const zip = CFB.read(raw, { type: "buffer" });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name] as Record<string, unknown>;
    const idx = (zip.FullPaths as string[]).findIndex((p) => p.endsWith(`xl/worksheets/sheet${i + 1}.xml`));
    if (idx === -1) return;
    const entry = zip.FileIndex[idx];
    let xml = dec.decode(entry.content);

    const view = (ws["!views"] as Array<{ xSplit?: number; ySplit?: number }> | undefined)?.[0];
    const xs = view?.xSplit || 0, ys = view?.ySplit || 0;
    if (xs || ys) {
      const topLeft = XLSX.utils.encode_cell({ r: ys, c: xs });
      const pane = xs && ys ? "bottomRight" : ys ? "bottomLeft" : "topRight";
      const attrs = `${xs ? ` xSplit="${xs}"` : ""}${ys ? ` ySplit="${ys}"` : ""} topLeftCell="${topLeft}" activePane="${pane}" state="frozen"`;
      xml = xml.replace(/<sheetView([^>]*?)\/>/, `<sheetView$1><pane${attrs}/><selection pane="${pane}" activeCell="${topLeft}" sqref="${topLeft}"/></sheetView>`);
    }
    const tab = ws["!tabColor"] as string | undefined;
    if (tab) {
      if (/<sheetPr[^>]*\/>/.test(xml)) xml = xml.replace(/<sheetPr([^>]*)\/>/, `<sheetPr$1><tabColor rgb="FF${tab}"/></sheetPr>`);
      else if (/<sheetPr[^>]*>/.test(xml)) xml = xml.replace(/<sheetPr([^>]*)>/, `<sheetPr$1><tabColor rgb="FF${tab}"/>`);
      else xml = xml.replace(/(<worksheet[^>]*>)/, `$1<sheetPr><tabColor rgb="FF${tab}"/></sheetPr>`);
    }
    entry.content = enc.encode(xml);
    entry.size = entry.content.length;
  });
  // Re-zip with native zlib rather than CFB.write's pure-JS deflate: on the
  // ~9 MB FBA Forecast workbook that deflate alone cost ~470 ms of CPU and
  // helped push the Edge Function past its limits; native is ~3x faster.
  const root = (zip.FullPaths as string[])[0];
  const parts: Array<{ name: string; data: Uint8Array }> = [];
  (zip.FullPaths as string[]).forEach((path, i) => {
    const e = zip.FileIndex[i];
    if (e.type !== 2 || !e.content || e.name.startsWith("\u0001")) return; // dirs + CFB's internal marker entry
    parts.push({ name: path.slice(root.length), data: e.content instanceof Uint8Array ? e.content : new Uint8Array(e.content) });
  });
  return writeZip(parts);
}

// ── Minimal zip writer (deflate via node:zlib) ────────────────────────────

let crcTable: Uint32Array | null = null;
function jsCrc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// zlib.crc32 only exists on newer runtimes; fall back to the table version.
// deno-lint-ignore no-explicit-any
const crc32 = (data: Uint8Array): number => (typeof (zlib as any).crc32 === "function" ? (zlib as any).crc32(data) >>> 0 : jsCrc32(data));

export function writeZip(parts: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const DOS_DATE = 0x0021; // 1980-01-01, time 00:00 — xlsx parts carry no meaningful mtime
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of parts) {
    const nameBytes = enc.encode(name);
    const deflated = new Uint8Array(zlib.deflateRawSync(data, { level: 6 }));
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true); lv.setUint16(10, 0, true); lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true); cv.setUint16(12, 0, true); cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true); // extra, comment, disk, internal attrs stay 0
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, parts.length, true); ev.setUint16(10, parts.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const chunk of [...locals, ...centrals, eocd]) { out.set(chunk, p); p += chunk.length; }
  return out;
}
