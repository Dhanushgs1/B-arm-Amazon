import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import XLSX from "npm:xlsx-js-style@1.2.0";
import { writeXlsxWithViews } from "./xlsxWriter.ts";

// Mirrors the shapes adSpendReportExport.ts builds: styled 1-row headers frozen
// at ySplit 1, a 2-row merged header frozen at ySplit 2, and one unfrozen sheet.
function sampleWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const hdr = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "6B7280" } } };

  const raw = XLSX.utils.aoa_to_sheet([["Campaign", "Spend", "ACOS"], ["A", 12.5, 0.15], ["B", 0, null]]);
  ["A1", "B1", "C1"].forEach((a) => (raw[a].s = hdr));
  raw["C2"].z = "0.00%";
  raw["!views"] = [{ state: "frozen", ySplit: 1 }];
  XLSX.utils.book_append_sheet(wb, raw, "Raw");

  const sku = XLSX.utils.aoa_to_sheet([["", "Amazon", ""], ["SKU", "Spend", "Units"], ["S1", 100, 4], ["S2", 50.25, 1]]);
  sku["!merges"] = [XLSX.utils.decode_range("B1:C1")];
  sku["D3"] = { t: "n", f: "B3/C3", v: 25 };
  sku["!ref"] = "A1:D4";
  sku["!views"] = [{ state: "frozen", ySplit: 2 }];
  XLSX.utils.book_append_sheet(wb, sku, "SKU Wise");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Note"], ["x"]]), "Notes");

  const both = XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]);
  both["!views"] = [{ state: "frozen", ySplit: 1, xSplit: 1 }];
  XLSX.utils.book_append_sheet(wb, both, "Both");
  return wb;
}

function sheetXml(bytes: Uint8Array, n: number): string {
  // deno-lint-ignore no-explicit-any
  const zip = (XLSX as any).CFB.read(bytes, { type: "buffer" });
  const idx = (zip.FullPaths as string[]).findIndex((p) => p.endsWith(`xl/worksheets/sheet${n}.xml`));
  return new TextDecoder().decode(zip.FileIndex[idx].content);
}

Deno.test("writeXlsxWithViews injects a frozen pane per sheet's !views and leaves unfrozen sheets alone", () => {
  const bytes = writeXlsxWithViews(sampleWorkbook());
  assertEquals(/<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/.test(sheetXml(bytes, 1)), true);
  assertEquals(/<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"\/>/.test(sheetXml(bytes, 2)), true);
  assertEquals(sheetXml(bytes, 3).includes("<pane"), false);
  assertEquals(/<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/>/.test(sheetXml(bytes, 4)), true);
});

Deno.test("writeXlsxWithViews leaves every cell value, formula, merge and number format unchanged vs plain XLSX.write", () => {
  const plain = XLSX.read(XLSX.write(sampleWorkbook(), { type: "buffer", bookType: "xlsx" }), { type: "buffer", cellFormula: true });
  const fixed = XLSX.read(writeXlsxWithViews(sampleWorkbook()), { type: "buffer", cellFormula: true });
  assertEquals(fixed.SheetNames, plain.SheetNames);
  for (const name of plain.SheetNames) {
    const a = plain.Sheets[name], b = fixed.Sheets[name];
    assertEquals(b["!ref"], a["!ref"]);
    assertEquals(b["!merges"], a["!merges"]);
    const cells = (ws: XLSX.WorkSheet) => Object.keys(ws).filter((k) => !k.startsWith("!")).sort()
      .map((k) => [k, ws[k].t, ws[k].v, ws[k].f, ws[k].z]);
    assertEquals(cells(b), cells(a));
  }
});

// Reads a zip's central directory: [name, method] per entry.
function zipEntries(bytes: Uint8Array): Array<[string, number]> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Array<[string, number]> = [];
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true), nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    out.push([new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen)), method]);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

Deno.test("writeXlsxWithViews writes a deflate-compressed zip with exactly the workbook's parts", () => {
  const bytes = writeXlsxWithViews(sampleWorkbook());
  const entries = zipEntries(bytes);
  const names = entries.map(([n]) => n);
  assertEquals(names.includes("[Content_Types].xml"), true);
  assertEquals(names.includes("xl/worksheets/sheet4.xml"), true);
  assertEquals(names.some((n) => n.includes("Sh33tJ5") || n.startsWith("Root Entry")), false);
  // Big XML parts are deflated (method 8), never stored uncompressed.
  assertEquals(entries.find(([n]) => n === "xl/styles.xml")![1], 8);
  // Same parts, same contents as the plain library output (apart from the injected panes).
  // deno-lint-ignore no-explicit-any
  const plain = (XLSX as any).CFB.read(XLSX.write(sampleWorkbook(), { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
  // deno-lint-ignore no-explicit-any
  const ours = (XLSX as any).CFB.read(bytes, { type: "buffer" });
  const text = (z: { FullPaths: string[]; FileIndex: Array<{ content: Uint8Array }> }, n: string) => {
    const i = z.FullPaths.findIndex((p) => p.endsWith(n));
    return new TextDecoder().decode(z.FileIndex[i].content);
  };
  for (const n of ["xl/styles.xml", "xl/workbook.xml", "[Content_Types].xml", "xl/worksheets/sheet3.xml"]) assertEquals(text(ours, n), text(plain, n));
});
