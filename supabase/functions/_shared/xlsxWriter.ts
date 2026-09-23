// supabase/functions/_shared/xlsxWriter.ts
// Shared workbook writer for the edge functions.
//
// xlsx-js-style 1.2.0 (SheetJS 0.18.5) silently drops `!views` frozen panes
// (the written sheet XML only has <sheetView workbookViewId="0"/>) and has no
// tab-colour support, so both are injected into each sheet's XML after
// writing. Sheet N in the zip is the Nth entry of wb.SheetNames.
import XLSX from "npm:xlsx-js-style@1.2.0";

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
  return CFB.write(zip, { type: "buffer", fileType: "zip", compression: true }) as Uint8Array;
}
