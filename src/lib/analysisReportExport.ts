import * as XLSX from "xlsx-js-style";
import { mcp } from "@/lib/api";

// ── Analysis Report (Ad Performance) ────────────────────────────────────────
// Recreates the per-product "Analysis report" sheet from the seller's manual
// Amazon-ads workbook, but sourced LIVE from the SellerMate API and rebuilt for
// two fixed trailing windows: Last 30 days and Last 7 days (both ending today,
// matching the dashboard's own "Last 30 Days" convention in DashboardContext).
//
// The seller's original sheet was a per-SKU pivot of raw Amazon report exports
// (SP advertised report + orders report + FBA/returns). The live API is
// per-ASIN and ad-only, so this report is per-ASIN (with SKU(s) shown as a
// column) — format-faithful, not a byte-identical clone. The CPC / ACOS / TACOS
// formulas are reproduced exactly as the original sheet computed them:
//   Spend+Tax = ad spend × 1.18            (18% GST)
//   Final     = Orders − Returns
//   CPC       = Spend+Tax ÷ Advertised SKU Units   (÷1 when units = 0)
//   ACOS      = Spend+Tax ÷ (Price × Total Units)   (÷1 when units = 0)
//   TACOS     = Spend+Tax ÷ (Price × Final)         (÷1 when final = 0)

const GST_MULTIPLIER = 1.18;

// Same courier-RTO filter used across the dashboard (see amazonSalesExport.ts):
// an UNDELIVERABLE "return" never reached the customer, so it isn't a genuine
// product return and is excluded from the Returns count.
function isGenuineReturn(r: any) {
  return !String(r.reason || "").toUpperCase().startsWith("UNDELIVERABLE");
}

// Local-time YYYY-MM-DD, matching DashboardContext.getLocalDateStr so the
// windows line up with the rest of the dashboard (no UTC timezone shift).
function localDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// DD-MM-YYYY for the human-readable window headers ("23-05-2026 to 21-06-2026").
function dotDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

interface WindowStats {
  spendTax: number;   // ad spend × 1.18
  adSales: number;    // ad-attributed sales (for the Total Units estimate)
  advUnits: number;   // Advertised SKU Units (#) — ad orders/purchases
  totalUnits: number; // Total Units (#) — ad-attributed units (adSales ÷ price)
  orders: number;     // total units ordered (all channels)
  returns: number;    // genuine customer returns
}

function emptyWindow(): WindowStats {
  return { spendTax: 0, adSales: 0, advUnits: 0, totalUnits: 0, orders: 0, returns: 0 };
}

interface ProductRow {
  asin: string;
  name: string;
  sku: string;
  channel: string;   // FBA/MFN
  price: number;
  w30: WindowStats;
  w7: WindowStats;
  fbaAvailable: number;
  fbmQty: number;
  allFba: string;    // Yes/No
}

type ToolCaller = (tool: string, args: any) => Promise<any>;

// get_fba_customer_returns rejects start_date === end_date, but our windows are
// always ≥ 7 days so a straight paged fetch is fine here.
async function fetchAllReturns(call: ToolCaller, args: any) {
  const all: any[] = [];
  for (let page = 0; page < 20; page++) {
    const res = await call("get_fba_customer_returns", { ...args, page, page_size: 500 }).catch(() => null);
    const rows = res?.order_returns || [];
    all.push(...rows);
    if (!res?.pagination?.hasMore || rows.length === 0) break;
  }
  return all;
}

async function fetchAllInventory(call: ToolCaller, args: any) {
  const seen = new Set<string>();
  const all: any[] = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const res = await call("get_inventory", { ...args, limit: 200, offset }).catch(() => null);
    const items = res?.items || [];
    for (const item of items) {
      if (item.asin && seen.has(item.asin)) continue;
      if (item.asin) seen.add(item.asin);
      all.push(item);
    }
    if (items.length === 0 || offset + items.length >= (res?.total || 0)) break;
    offset += 200;
  }
  return all;
}

async function fetchFullCatalog(call: ToolCaller, args: any) {
  const all: any[] = [];
  let offset = 0;
  for (let i = 0; i < 30; i++) {
    const res = await call("list_product_catalog", { ...args, limit: 200, offset, include_suppressed: true }).catch(() => null);
    const page = res?.products || [];
    all.push(...page);
    offset += page.length;
    if (page.length < 200 || offset >= (res?.total || 0)) break;
  }
  return all;
}

// Reduce a window's ad + retail + returns rows into per-ASIN WindowStats.
function aggregateWindow(
  rows: Map<string, ProductRow>,
  ensure: (asin: string) => ProductRow,
  pick: (p: ProductRow) => WindowStats,
  adRows: any[],
  retailRows: any[],
  returnRows: any[]
) {
  // Ad spend / ad sales / advertised orders per ASIN.
  adRows.forEach((r: any) => {
    if (!r.adAsin) return;
    const p = ensure(r.adAsin);
    if (p.name === p.asin && r.adProductName) p.name = r.adProductName;
    const w = pick(p);
    w.spendTax += (r.spend || 0) * GST_MULTIPLIER;
    w.adSales += r.sales || 0;
    w.advUnits += r.orders || 0; // purchases — closest per-ASIN unit proxy the API exposes
  });

  // Total orders (units) + selling price per ASIN.
  retailRows.forEach((r: any) => {
    if (!r.asin) return;
    const p = ensure(r.asin);
    if (p.name === p.asin && r.productName) p.name = r.productName;
    const w = pick(p);
    w.orders += r.unitsOrdered || 0;
    const asp = r.averageSellingPrice || (r.unitsOrdered ? (r.totalSales || 0) / r.unitsOrdered : 0);
    if (asp && !p.price) p.price = asp;
  });

  // Genuine customer returns per ASIN.
  const returnsByAsin = new Map<string, number>();
  returnRows.forEach((r: any) => {
    if (!r.asin || !isGenuineReturn(r)) return;
    returnsByAsin.set(r.asin, (returnsByAsin.get(r.asin) || 0) + (r.quantity || 1));
  });
  returnsByAsin.forEach((cnt, asin) => {
    const w = pick(ensure(asin));
    w.returns += cnt;
  });
}

// Finalize the derived Total Units estimate (adSales ÷ price) once prices are known.
function finalizeUnits(w: WindowStats, price: number) {
  if (price > 0 && w.adSales > 0) {
    w.totalUnits = Math.round(w.adSales / price);
  } else {
    w.totalUnits = w.advUnits;
  }
}

// Excel-faithful metric formulas (guarded division as the original sheet did).
function computeCpc(w: WindowStats) {
  return w.advUnits > 0 ? w.spendTax / w.advUnits : w.spendTax;
}
function computeAcos(w: WindowStats, price: number) {
  const denom = price * (w.totalUnits || 1);
  return denom > 0 ? w.spendTax / denom : 0;
}
function computeTacos(w: WindowStats, price: number) {
  const final = Math.max(0, w.orders - w.returns);
  const denom = price * (final || 1);
  return denom > 0 ? w.spendTax / denom : 0;
}

interface BuildOpts {
  call: ToolCaller;
  accountId: string | undefined;
  workspaceId: string | undefined;
  accountName: string | undefined;
  today?: Date; // injectable for testing; defaults to now
}

export async function buildAnalysisReportWorkbook(opts: BuildOpts) {
  const { call, accountId, workspaceId, accountName } = opts;
  const baseArgs = { amazon_account_id: accountId, workspace_id: workspaceId };

  const today = opts.today || new Date();
  const end = localDateStr(today);
  const d30 = new Date(today); d30.setDate(d30.getDate() - 29);
  const d7 = new Date(today); d7.setDate(d7.getDate() - 6);
  const start30 = localDateStr(d30);
  const start7 = localDateStr(d7);

  const label30 = `Last 30 days (${dotDate(start30)} to ${dotDate(end)})`;
  const label7 = `Last 7 days (${dotDate(start7)} to ${dotDate(end)})`;

  const args30 = { ...baseArgs, start_date: start30, end_date: end };
  const args7 = { ...baseArgs, start_date: start7, end_date: end };

  // Fire every fetch concurrently — same fan-out style as the Full report.
  const [
    ad30, ad7, retail30, retail7, returns30, returns7, inventory, catalog,
  ] = await Promise.all([
    mcpAllPagesVia(call, "get_advertised_product_performance", args30),
    mcpAllPagesVia(call, "get_advertised_product_performance", args7),
    mcpAllPagesVia(call, "get_retail_product_performance", args30),
    mcpAllPagesVia(call, "get_retail_product_performance", args7),
    fetchAllReturns(call, args30),
    fetchAllReturns(call, args7),
    fetchAllInventory(call, baseArgs).catch(() => []),
    fetchFullCatalog(call, baseArgs).catch(() => []),
  ]);

  const products = new Map<string, ProductRow>();
  const ensure = (asin: string): ProductRow => {
    let p = products.get(asin);
    if (!p) {
      p = { asin, name: asin, sku: "", channel: "", price: 0, w30: emptyWindow(), w7: emptyWindow(), fbaAvailable: 0, fbmQty: 0, allFba: "No" };
      products.set(asin, p);
    }
    return p;
  };

  // SKU + name from catalog (reliable), then inventory as fallback. One ASIN can
  // carry multiple SKUs (FBA + FBM) — join them so nothing is silently dropped.
  const skusByAsin = new Map<string, string[]>();
  const addSku = (asin?: string, sku?: string) => {
    if (!asin || !sku) return;
    const list = skusByAsin.get(asin) || [];
    if (!list.includes(sku)) list.push(sku);
    skusByAsin.set(asin, list);
  };
  catalog.forEach((c: any) => {
    if (!c.asin) return;
    const p = ensure(c.asin);
    if (p.name === p.asin && c.itemName) p.name = c.itemName;
    addSku(c.asin, c.sku);
  });

  aggregateWindow(products, ensure, (p) => p.w30, ad30, retail30, returns30);
  aggregateWindow(products, ensure, (p) => p.w7, ad7, retail7, returns7);

  // Inventory: FBA on-hand + FBM qty + channel. Also a SKU/price fallback.
  inventory.forEach((i: any) => {
    if (!i.asin) return;
    const p = ensure(i.asin);
    const fba = i.fba?.endingWarehouseBalance || 0;
    const fbm = i.fbm?.quantity || 0;
    p.fbaAvailable += fba;
    p.fbmQty += fbm;
    if (i.price && !p.price) p.price = i.price;
    if (i.itemName && p.name === p.asin) p.name = i.itemName;
    addSku(i.asin, i.sku);
  });

  // Resolve per-row SKU string, channel, derived Total Units.
  products.forEach((p) => {
    p.sku = (skusByAsin.get(p.asin) || []).join(" / ");
    p.allFba = p.fbaAvailable > 0 ? "Yes" : "No";
    p.channel = p.fbaAvailable > 0 ? "AMAZON_IN" : p.fbmQty > 0 ? "DEFAULT" : "";
    finalizeUnits(p.w30, p.price);
    finalizeUnits(p.w7, p.price);
  });

  // Keep rows that had any real activity in either window, or that hold stock —
  // drops the long tail of dormant catalog ASINs with zero everything.
  const rows = [...products.values()].filter((p) => {
    const active = p.w30.spendTax || p.w30.orders || p.w7.spendTax || p.w7.orders || p.fbaAvailable || p.fbmQty;
    return !!active;
  });

  // Sort by 30-day ad spend (biggest ad investment first), then total orders.
  rows.sort((a, b) => (b.w30.spendTax - a.w30.spendTax) || (b.w30.orders - a.w30.orders));

  // ── Build the sheet ──
  const WIN_COLS = ["Spend+Tax", "Advertised SKU Units (#)", "Total Units (#)", "Orders", "Returns", "Final", "CPC", "ACOS", "TACOS"];
  const AVAIL_COLS = ["FBA Available", "FBM Qty", "All FBA"];
  const LEAD_COLS = ["Product", "SKU ID", "FBA/MFN", "Price"];

  const header0: any[] = [...LEAD_COLS];                 // group row
  const header1: any[] = [...LEAD_COLS];                 // column row
  // 30-day block
  header0.push(label30, ...Array(WIN_COLS.length - 1).fill(""));
  header1.push(...WIN_COLS);
  // 7-day block
  header0.push(label7, ...Array(WIN_COLS.length - 1).fill(""));
  header1.push(...WIN_COLS);
  // availability block
  header0.push("FBA Availability (current)", ...Array(AVAIL_COLS.length - 1).fill(""));
  header1.push(...AVAIL_COLS);

  const aoa: any[][] = [header0, header1];

  const buildWinCells = (w: WindowStats, price: number) => {
    const final = Math.max(0, w.orders - w.returns);
    return [
      w.spendTax,
      w.advUnits,
      w.totalUnits,
      w.orders,
      w.returns,
      final,
      computeCpc(w),
      computeAcos(w, price),
      computeTacos(w, price),
    ];
  };

  rows.forEach((p) => {
    aoa.push([
      p.name,
      p.sku,
      p.channel,
      p.price,
      ...buildWinCells(p.w30, p.price),
      ...buildWinCells(p.w7, p.price),
      p.fbaAvailable,
      p.fbmQty,
      p.allFba,
    ]);
  });

  // Grand-total row. Additive columns are summed; the ratio columns (CPC / ACOS
  // / TACOS) are recomputed from the aggregated numerators and denominators —
  // using the SAME denominators the per-row formulas use (Price × Units, Price ×
  // Final), so the total stays consistent with the rows above it rather than
  // being a meaningless average of ratios.
  const totalRowCells = (getW: (p: ProductRow) => WindowStats) => {
    let spendTax = 0, advUnits = 0, totalUnits = 0, orders = 0, returns = 0;
    let acosDenom = 0, tacosDenom = 0;
    rows.forEach((p) => {
      const w = getW(p);
      spendTax += w.spendTax; advUnits += w.advUnits; totalUnits += w.totalUnits;
      orders += w.orders; returns += w.returns;
      acosDenom += p.price * w.totalUnits;
      tacosDenom += p.price * Math.max(0, w.orders - w.returns);
    });
    const final = Math.max(0, orders - returns);
    return [
      spendTax, advUnits, totalUnits, orders, returns, final,
      advUnits > 0 ? spendTax / advUnits : spendTax,
      acosDenom > 0 ? spendTax / acosDenom : 0,
      tacosDenom > 0 ? spendTax / tacosDenom : 0,
    ];
  };
  const totFbaAvail = rows.reduce((a, p) => a + p.fbaAvailable, 0);
  const totFbmQty = rows.reduce((a, p) => a + p.fbmQty, 0);
  const grandRowIdx = aoa.length;
  aoa.push([
    "GRAND TOTAL", "", "", "",
    ...totalRowCells((p) => p.w30),
    ...totalRowCells((p) => p.w7),
    totFbaAvail, totFbmQty, "",
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = header1.length;

  // Merges: lead cols span both header rows; each block spans its columns in row 0.
  const merges: any[] = LEAD_COLS.map((_, c) => ({ s: { r: 0, c }, e: { r: 1, c } }));
  const b30 = LEAD_COLS.length;
  const b7 = b30 + WIN_COLS.length;
  const bAvail = b7 + WIN_COLS.length;
  merges.push({ s: { r: 0, c: b30 }, e: { r: 0, c: b30 + WIN_COLS.length - 1 } });
  merges.push({ s: { r: 0, c: b7 }, e: { r: 0, c: b7 + WIN_COLS.length - 1 } });
  merges.push({ s: { r: 0, c: bAvail }, e: { r: 0, c: bAvail + AVAIL_COLS.length - 1 } });
  ws["!merges"] = merges;

  // Header styling — indigo group row, lighter indigo column row (matches the
  // Amazon Sales report). 7-day block gets a slightly different hue so the two
  // windows read apart at a glance.
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      let fill = r === 0 ? "312E81" : "4F46E5";
      if (c >= b7 && c < bAvail) fill = r === 0 ? "3730A3" : "6366F1"; // 7-day block accent
      if (c >= bAvail) fill = r === 0 ? "065F46" : "059669";          // availability block accent
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: r === 0 ? 11 : 10 },
        fill: { fgColor: { rgb: fill } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
      };
    }
  }

  const acosColor = (v: number) => (v < 0.25 ? "92D050" : v > 0.4 ? "FF0000" : "FFCC00");

  for (let r = 2; r < aoa.length; r++) {
    const isGrand = r === grandRowIdx;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;

      const style: any = {
        font: { color: { rgb: "1F2937" }, bold: isGrand },
        alignment: { vertical: "center", horizontal: c === 0 ? "left" : "center" },
        border: {
          bottom: { style: isGrand ? "medium" : "thin", color: { rgb: isGrand ? "312E81" : "E5E7EB" } },
          ...(isGrand ? { top: { style: "medium", color: { rgb: "312E81" } } } : {}),
        },
      };

      // Determine which logical column this is (Price, or an index within a block).
      const isPriceCol = c === 3;
      let posInWin = -1;
      if (c >= b30 && c < b7) posInWin = c - b30;
      else if (c >= b7 && c < bAvail) posInWin = c - b7;

      if (isPriceCol) {
        style.numFmt = "#,##0.00";
      } else if (posInWin >= 0) {
        // 0 Spend+Tax, 1 AdvUnits, 2 TotalUnits, 3 Orders, 4 Returns, 5 Final, 6 CPC, 7 ACOS, 8 TACOS
        if (posInWin === 0 || posInWin === 6) style.numFmt = "#,##0.00";
        else if (posInWin >= 1 && posInWin <= 5) style.numFmt = "#,##0";
        else if (posInWin === 7 || posInWin === 8) {
          style.numFmt = "0.00%";
          if (typeof cell.v === "number" && cell.v > 0) {
            style.fill = { fgColor: { rgb: acosColor(cell.v) } };
            style.font = { color: { rgb: cell.v > 0.4 ? "FFFFFF" : "000000" }, bold: true };
          }
        }
        // Final < 0 (more returns than orders) flagged red.
        if (posInWin === 5 && typeof cell.v === "number" && cell.v < 0) {
          style.font = { color: { rgb: "B91C1C" }, bold: true };
        }
      } else if (c === 0) {
        style.font = { color: { rgb: "111827" }, bold: true };
      } else if (c === 1) {
        style.font = { color: { rgb: "4338CA" }, bold: true };
      }
      cell.s = style;
    }
  }

  const cols: any[] = [{ wch: 46 }, { wch: 20 }, { wch: 11 }, { wch: 10 }];
  for (let i = 0; i < 2; i++) {
    cols.push({ wch: 11 }, { wch: 13 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 10 }, { wch: 9 }, { wch: 9 });
  }
  cols.push({ wch: 13 }, { wch: 10 }, { wch: 8 });
  ws["!cols"] = cols;
  ws["!rows"] = [{ hpt: 22 }, { hpt: 40 }];
  ws["!views"] = [{ state: "frozen", xSplit: 4, ySplit: 2 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Analysis report");

  // A small notes sheet documenting sourcing + the ~48h Amazon sync lag, so the
  // trailing-day dip isn't mistaken for a real drop.
  const wsNote = XLSX.utils.aoa_to_sheet([
    ["Analysis Report — Ad Performance"],
    [`Account: ${accountName || "-"}`],
    [`Last 30 days: ${dotDate(start30)} to ${dotDate(end)}`],
    [`Last 7 days: ${dotDate(start7)} to ${dotDate(end)}`],
    [""],
    ["Spend+Tax = ad spend x 1.18 (18% GST). Final = Orders - Returns."],
    ["CPC = Spend+Tax / Advertised SKU Units. ACOS = Spend+Tax / (Price x Total Units). TACOS = Spend+Tax / (Price x Final)."],
    ["Advertised SKU Units = ad-attributed orders; Total Units = ad sales / price (estimate)."],
    ["Returns exclude courier RTO / undeliverable (not genuine customer returns)."],
    ["The most recent 1-2 days can look low - that's Amazon's own reporting sync lag, not a real drop."],
  ]);
  wsNote["!cols"] = [{ wch: 110 }];
  wsNote["A1"].s = { font: { bold: true, sz: 13, color: { rgb: "312E81" } } };
  XLSX.utils.book_append_sheet(wb, wsNote, "Notes");

  const filename = `Analysis_Report_Ad_Performance_${start30}_to_${end}.xlsx`;
  return { wb, filename, productCount: rows.length };
}

// Local copy of mcpAllPages that accepts an arbitrary ToolCaller (so this
// builder stays transport-agnostic, mirroring amazonSalesExport.ts).
async function mcpAllPagesVia(call: ToolCaller, tool: string, args: any, maxPages = 24) {
  const all: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await call(tool, { ...args, page, page_size: 500 }).catch(() => null);
    const rows = res?.data || [];
    all.push(...rows);
    if (!res?.pagination?.hasMore || rows.length === 0) break;
  }
  return all;
}

// Browser entry point used by the Reports page — fetches through the /api/tool
// proxy with the account's keySlot, then triggers a real file download.
export async function exportAnalysisReport(opts: {
  account: { id?: string; workspace_id?: string; name?: string } | null | undefined;
  keySlot: string;
}) {
  const { account, keySlot } = opts;
  const call: ToolCaller = (tool, args) => mcp(tool, args, keySlot);
  const { wb, filename, ...stats } = await buildAnalysisReportWorkbook({
    call,
    accountId: account?.id,
    workspaceId: account?.workspace_id,
    accountName: account?.name,
  });
  XLSX.writeFile(wb, filename);
  return { filename, ...stats };
}
