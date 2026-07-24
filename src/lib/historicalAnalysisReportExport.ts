import * as XLSX from "xlsx-js-style";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { fetchFullCatalog, fetchInventoryByLocation, fcToState, type ToolCaller } from "@/lib/analysisReportExport";
import { mcp } from "@/lib/api";

// ── Historical Analysis Report (Ad Performance) ─────────────────────────────
// Same Analysis-Report shape as analysisReportExport.ts (Price, Spend+Tax,
// Units, Orders, Returns, CPC, ACOS, TACOS), but for two reasons this is a
// separate builder rather than a parameter change to the live one:
//
// 1. The live report is locked to a trailing 30/7-day window ending today —
//    it can never reproduce a fixed historical range (e.g. 23 May–21 Jun).
//    This one takes an arbitrary start/end date and reads from the manually
//    uploaded report tables (src/lib/amazonReportUpload.ts) instead of the
//    live SellerMate API for orders/returns/ad-spend.
// 2. The live API only exposes ad/retail data per ASIN. The uploaded raw
//    Amazon exports carry the real SKU, so this report is genuinely per-SKU —
//    one row per SKU, not one row per ASIN with a single "primary" SKU shown.
//
// Price, FBA/MFN channel, and FBA inventory availability prefer the uploaded
// Price / FBA Inventory / Inventory Ledger reports (also current-moment-ish,
// but exported closer to the reported period, and the Ledger gives a genuine
// as-of-date snapshot rather than "today"). When those haven't been uploaded,
// this falls back to the live SellerMate catalog/inventory (fetchFullCatalog /
// fetchInventoryByLocation, reused unchanged from analysisReportExport.ts) —
// which reflects today's catalog, not necessarily what was true during an
// older uploaded period. Falls back independently per field, so uploading
// just the Price file (say) still improves accuracy even without the Ledger.

const GST_MULTIPLIER = 1.18;

function dotDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function nextDayIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Same courier-RTO exclusion the live report uses for FBA customer returns
// (an UNDELIVERABLE/refused parcel never reached the customer).
function isGenuineFbaReturn(r: { reason?: string }): boolean {
  return !String(r.reason || "").toUpperCase().startsWith("UNDELIVERABLE");
}
// AM returns (Seller Central return-requests export) signals the same thing
// via "Return type" = "Undelivered" instead of a reason-code prefix.
function isGenuineAmReturn(r: { return_type?: string }): boolean {
  return String(r.return_type || "").toLowerCase() !== "undelivered";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllRows(table: string, apply: (q: any) => any): Promise<any[]> {
  const all: unknown[] = [];
  const PAGE = 1000;
  let from = 0;
  for (let i = 0; i < 200; i++) {
    const { data, error } = await apply(supabasePublic.from(table).select("*")).range(from, from + PAGE - 1);
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

interface SkuAgg {
  sku: string;
  name: string;
  price: number;
  channel: string;
  isFba: boolean;
  fbaTotal: number;
  fbmQty: number;
  stateBalances: Map<string, number>;
  spendTax: number;
  advUnits: number;
  totalUnits: number;
  orders: number;
  returns: number;
}

function emptySku(sku: string): SkuAgg {
  return {
    sku, name: sku, price: 0, channel: "", isFba: false, fbaTotal: 0, fbmQty: 0,
    stateBalances: new Map(), spendTax: 0, advUnits: 0, totalUnits: 0, orders: 0, returns: 0,
  };
}

function computeCpc(s: SkuAgg): number {
  return s.advUnits > 0 ? s.spendTax / s.advUnits : s.spendTax;
}
function computeAcos(s: SkuAgg): number {
  return s.price > 0 ? computeCpc(s) / s.price : 0;
}
function computeTacos(s: SkuAgg): number {
  const final = Math.max(0, s.orders - s.returns);
  const denom = s.price * (final || 1);
  return denom > 0 ? s.spendTax / denom : 0;
}

interface BuildOpts {
  call: ToolCaller;
  accountId: string | undefined;
  workspaceId: string | undefined;
  accountName: string | undefined;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string;
}

export async function buildHistoricalAnalysisReportWorkbook(opts: BuildOpts) {
  const { call, accountId, workspaceId, accountName, startDate, endDate } = opts;
  const baseArgs = { amazon_account_id: accountId, workspace_id: workspaceId };
  const endExclusive = nextDayIso(endDate);

  const [
    spRows, sbRows, sdRows, orderRows, amReturnRows, fbaReturnRows, mapRows,
    priceListingRows, fbaInventoryRows, ledgerRows, ledgerRawRows, sfReturnRows,
  ] = await Promise.all([
    fetchAllRows("barm_amazon_sp_advertised_product", (q) => q.gte("report_date", startDate).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sb_campaign", (q) => q.gte("report_date", startDate).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sd_campaign", (q) => q.gte("report_date", startDate).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_am_orders", (q) => q.gte("purchase_date", startDate).lte("purchase_date", endDate)),
    fetchAllRows("barm_amazon_am_returns", (q) => q.gte("return_request_date", startDate).lte("return_request_date", endDate)),
    fetchAllRows("barm_amazon_fba_returns", (q) => q.gte("return_date", `${startDate}T00:00:00Z`).lt("return_date", `${endExclusive}T00:00:00Z`)),
    fetchAllRows("barm_amazon_campaign_sku_map", (q) => q),
    fetchAllRows("barm_amazon_price_listing", (q) => q),
    fetchAllRows("barm_amazon_fba_inventory", (q) => q),
    // Ledger "as of" this report's end date — every SELLABLE row up to and
    // including endDate; the latest one per (SKU, location) is that
    // location's true balance as of the report period, not today.
    fetchAllRows("barm_amazon_inventory_ledger", (q) => q.lte("ledger_date", endDate).eq("disposition", "SELLABLE")),
    // Separate from the aggregation query above: the raw "Inventory ledger"
    // sheet mirrors what was actually uploaded for this date range (every
    // disposition, not just SELLABLE), matching how the Orders/returns raw
    // sheets aren't disposition-filtered either.
    fetchAllRows("barm_amazon_inventory_ledger", (q) => q.gte("ledger_date", startDate).lte("ledger_date", endDate)),
    fetchAllRows("barm_amazon_sf_return", (q) => q.gte("pickup_date", startDate).lte("pickup_date", endDate)),
  ]);

  const campaignSkuMap = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapRows.forEach((r: any) => campaignSkuMap.set(r.campaign_name, r.sku));

  // Price/channel from the uploaded Price (All-Listings) report, keyed by SKU.
  const priceBySku = new Map<string, { price: number; channel: string; isFba: boolean; fbmQty: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  priceListingRows.forEach((r: any) => {
    if (!r.seller_sku) return;
    const isFbaSku = typeof r.fulfillment_channel === "string" && r.fulfillment_channel.toUpperCase().startsWith("AMAZON");
    const cur = priceBySku.get(r.seller_sku) || { price: 0, channel: "", isFba: false, fbmQty: 0 };
    cur.isFba = isFbaSku;
    cur.channel = isFbaSku ? "AMAZON_IN" : "DEFAULT";
    if (r.price > 0) cur.price = r.price;
    if (!isFbaSku) cur.fbmQty += Number(r.quantity) || 0;
    priceBySku.set(r.seller_sku, cur);
  });
  const hasUploadedPrice = priceBySku.size > 0;

  // Inbound-shipped-quantity from the uploaded FBA Inventory report — the one
  // figure the live SellerMate inventory feed never exposes at all.
  const inboundShippedBySku = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fbaInventoryRows.forEach((r: any) => {
    if (!r.sku) return;
    inboundShippedBySku.set(r.sku, (inboundShippedBySku.get(r.sku) || 0) + (r.afn_inbound_shipped_quantity || 0));
  });
  const hasUploadedFbaInv = inboundShippedBySku.size > 0;

  // Ledger -> latest SELLABLE ending balance per (SKU, location) as of endDate.
  const ledgerLatestByKey = new Map<string, { ledger_date: string; msku: string; location: string; ending_balance: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ledgerRows.forEach((r: any) => {
    if (!r.msku) return;
    const key = `${r.msku}|${r.location}`;
    const cur = ledgerLatestByKey.get(key);
    if (!cur || r.ledger_date > cur.ledger_date) ledgerLatestByKey.set(key, r);
  });
  const ledgerBySku = new Map<string, { fbaTotal: number; stateBalances: Map<string, number> }>();
  const ledgerStates = new Set<string>();
  ledgerLatestByKey.forEach((r) => {
    const bal = r.ending_balance || 0;
    if (bal <= 0) return;
    let s = ledgerBySku.get(r.msku);
    if (!s) { s = { fbaTotal: 0, stateBalances: new Map() }; ledgerBySku.set(r.msku, s); }
    s.fbaTotal += bal;
    const state = fcToState(r.location);
    s.stateBalances.set(state, (s.stateBalances.get(state) || 0) + bal);
    ledgerStates.add(state);
  });
  const hasUploadedLedger = ledgerBySku.size > 0;

  // Only hit the (slow) live SellerMate API for whichever pieces the seller
  // hasn't uploaded a replacement for.
  const [catalog, inventory] = await Promise.all([
    hasUploadedPrice ? Promise.resolve([]) : fetchFullCatalog(call, baseArgs).catch(() => []),
    hasUploadedLedger ? Promise.resolve([]) : fetchInventoryByLocation(call, baseArgs).catch(() => []),
  ]);

  const skus = new Map<string, SkuAgg>();
  const ensure = (sku: string): SkuAgg => {
    let s = skus.get(sku);
    if (!s) { s = emptySku(sku); skus.set(sku, s); }
    return s;
  };

  const UNMAPPED = "__UNMAPPED__";

  // SP: true SKU-level ad spend + ad-attributed units, straight from the CSV.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows.forEach((r: any) => {
    if (!r.advertised_sku) return;
    const s = ensure(r.advertised_sku);
    s.spendTax += (r.spend || 0) * GST_MULTIPLIER;
    s.advUnits += r.advertised_sku_units_7d || 0;
  });

  // SB/SD: campaign-level only (no SKU column in Amazon's own export) — routed
  // to a SKU via the seller-maintained campaign->SKU map; unmapped campaigns
  // land in an explicit "Unmapped" bucket instead of being silently dropped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyCampaignAdRow(r: any, unitsField: string) {
    const sku = campaignSkuMap.get(r.campaign_name) || UNMAPPED;
    const s = ensure(sku);
    if (sku === UNMAPPED) s.name = "⚠ Unmapped SB/SD campaigns — assign a SKU on the Upload page";
    s.spendTax += (r.spend || 0) * GST_MULTIPLIER;
    s.advUnits += r[unitsField] || 0;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sbRows.forEach((r: any) => applyCampaignAdRow(r, "units"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdRows.forEach((r: any) => applyCampaignAdRow(r, "units_14d"));

  // Orders: the real total (all-channel) units sold per SKU, from the actual
  // Orders export — not an ad-derived estimate like the live report has to use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderRows.forEach((r: any) => {
    if (!r.sku) return;
    const s = ensure(r.sku);
    s.orders += r.quantity || 0;
    s.totalUnits += r.quantity || 0;
    if (r.product_name && s.name === s.sku) s.name = r.product_name;
  });

  // Returns: AM returns (Seller Central) + FBA customer returns, both filtered
  // to genuine customer returns (excluding courier RTO / undeliverable).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  amReturnRows.forEach((r: any) => {
    if (!r.merchant_sku || !isGenuineAmReturn(r)) return;
    ensure(r.merchant_sku).returns += r.return_quantity || 0;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fbaReturnRows.forEach((r: any) => {
    if (!r.sku || !isGenuineFbaReturn(r)) return;
    ensure(r.sku).returns += r.quantity || 0;
  });

  // Price / FBA-MFN channel — the uploaded Price report when available,
  // otherwise the live catalog. Matched directly by SKU either way.
  if (hasUploadedPrice) {
    priceBySku.forEach((info, sku) => {
      const s = ensure(sku);
      s.isFba = info.isFba;
      s.channel = info.channel;
      if (info.price > 0) s.price = info.price;
      s.fbmQty += info.fbmQty;
    });
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    catalog.forEach((c: any) => {
      if (!c.sku) return;
      const s = ensure(c.sku);
      if (c.itemName && s.name === s.sku) s.name = c.itemName;
      const isFbaSku = typeof c.fulfillmentChannel === "string" && c.fulfillmentChannel.toUpperCase().startsWith("AMAZON");
      s.isFba = isFbaSku;
      s.channel = isFbaSku ? "AMAZON_IN" : "DEFAULT";
      const price = Number(c.price) || 0;
      if (price > 0) s.price = price;
      if (!isFbaSku) s.fbmQty += Number(c.quantity) || 0;
    });
  }

  // FBA inventory availability — the uploaded Inventory Ledger (as of
  // endDate) when available, otherwise the live per-location breakdown.
  const accountStates = new Set<string>();
  if (hasUploadedLedger) {
    ledgerBySku.forEach((info, sku) => {
      const s = ensure(sku);
      s.isFba = true;
      s.fbaTotal += info.fbaTotal;
      info.stateBalances.forEach((v, st) => s.stateBalances.set(st, (s.stateBalances.get(st) || 0) + v));
    });
    ledgerStates.forEach((st) => accountStates.add(st));
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inventory.forEach((i: any) => {
      for (const loc of i.fba?.byLocation || []) {
        const sku = loc.sku || i.sku;
        if (!sku) continue;
        const bal = loc.endingWarehouseBalance || 0;
        const s = ensure(sku);
        s.isFba = true;
        if (bal <= 0) continue;
        s.fbaTotal += bal;
        const state = fcToState(loc.location);
        s.stateBalances.set(state, (s.stateBalances.get(state) || 0) + bal);
        accountStates.add(state);
      }
      if (!(i.fba?.byLocation?.length) && (i.fba?.endingWarehouseBalance || 0) > 0 && i.sku) {
        const s = ensure(i.sku);
        s.isFba = true;
        s.fbaTotal += i.fba.endingWarehouseBalance;
      }
    });
  }

  const rows = [...skus.values()].filter((s) => s.spendTax || s.orders || s.returns || s.fbaTotal || s.fbmQty);
  rows.sort((a, b) => (b.spendTax - a.spendTax) || (b.orders - a.orders));

  const buildAvailCells = (s: SkuAgg): (string | number)[] => {
    if (!s.isFba && s.fbaTotal <= 0) return ["0", "", "", "", ""];
    const withStock = [...s.stateBalances.entries()].filter(([, v]) => v > 0).map(([st]) => st).sort();
    const available = withStock.length ? withStock.join(", ") : "0";
    const notAvailable = Math.max(0, accountStates.size - withStock.length);
    const inbound = hasUploadedFbaInv ? (inboundShippedBySku.get(s.sku) || 0) : "—";
    return [available, s.fbaTotal, inbound, notAvailable, notAvailable > 0 ? "No" : "Yes"];
  };

  // ── Analysis report sheet ──
  const WIN_COLS = ["Spend+Tax", "Advertised SKU Units (#)", "Total Units (#)", "Orders", "Returns", "Final", "CPC", "ACOS", "TACOS"];
  const AVAIL_COLS = ["Available", "Grand Total", "Inbound-shipped-quantity", "Number of FBA Not Available", "All FBA"];
  const LEAD_COLS = ["Product", "SKU ID", "FBA/MFN", "Price"];
  const header = [...LEAD_COLS, ...WIN_COLS, ...AVAIL_COLS];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aoa: any[][] = [header];

  rows.forEach((s) => {
    // Unclamped (Orders − Returns), matching the =H-I formula this becomes
    // below — the reference sheet's own Final formula has no max(0, …) guard
    // either, so a SKU with more returns than orders shows a genuine negative
    // here (still flagged red by the styling pass further down).
    const final = s.orders - s.returns;
    aoa.push([
      s.name, s.sku === UNMAPPED ? "—" : s.sku, s.channel, Math.round(s.price),
      s.spendTax, s.advUnits, s.totalUnits, s.orders, s.returns, final,
      computeCpc(s), computeAcos(s), computeTacos(s),
      ...buildAvailCells(s),
    ]);
  });

  const grandRowIdx = aoa.length;
  let gSpendTax = 0, gAdvUnits = 0, gTotalUnits = 0, gOrders = 0, gReturns = 0, gAcosDenom = 0, gTacosDenom = 0, gFbaTotal = 0;
  rows.forEach((s) => {
    gSpendTax += s.spendTax; gAdvUnits += s.advUnits; gTotalUnits += s.totalUnits;
    gOrders += s.orders; gReturns += s.returns;
    gAcosDenom += s.price * s.advUnits;
    gTacosDenom += s.price * Math.max(0, s.orders - s.returns);
    gFbaTotal += s.fbaTotal;
  });
  const gFinal = Math.max(0, gOrders - gReturns);
  aoa.push([
    "GRAND TOTAL", "", "", "",
    gSpendTax, gAdvUnits, gTotalUnits, gOrders, gReturns, gFinal,
    gAdvUnits > 0 ? gSpendTax / gAdvUnits : gSpendTax,
    gAcosDenom > 0 ? gSpendTax / gAcosDenom : 0,
    gTacosDenom > 0 ? gSpendTax / gTacosDenom : 0,
    "", gFbaTotal, "", "", "",
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = header.length;
  const winStart = LEAD_COLS.length;
  const availStart = winStart + WIN_COLS.length;

  // Final / CPC / ACOS as real Excel formulas (Final = Orders − Returns; CPC =
  // Spend+Tax ÷ Advertised Units; ACOS = CPC ÷ Price) — matching the seller's
  // original manual workbook exactly. TACOS stays a computed value: its
  // max(0, orders − returns) guard isn't a clean single-cell Excel formula,
  // and the original sheet leaves it as a value too.
  const colLetter = (c: number) => XLSX.utils.encode_col(c);
  const priceCol = colLetter(3);
  const spendTaxCol = colLetter(winStart);
  const advUnitsCol = colLetter(winStart + 1);
  const ordersCol = colLetter(winStart + 3);
  const returnsCol = colLetter(winStart + 4);
  const finalCol = colLetter(winStart + 5);
  const cpcCol = colLetter(winStart + 6);
  const acosCol = colLetter(winStart + 7);
  for (let r = 1; r < grandRowIdx; r++) {
    const excelRow = r + 1;
    const finalAddr = `${finalCol}${excelRow}`;
    const cpcAddr = `${cpcCol}${excelRow}`;
    const acosAddr = `${acosCol}${excelRow}`;
    if (ws[finalAddr]) ws[finalAddr].f = `${ordersCol}${excelRow}-${returnsCol}${excelRow}`;
    if (ws[cpcAddr]) {
      ws[cpcAddr].f = `IF(${advUnitsCol}${excelRow}=0,${spendTaxCol}${excelRow},${spendTaxCol}${excelRow}/${advUnitsCol}${excelRow})`;
    }
    if (ws[acosAddr]) ws[acosAddr].f = `${cpcCol}${excelRow}/${priceCol}${excelRow}`;
  }

  for (let c = 0; c < totalCols; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    const fill = c >= availStart ? "065F46" : "312E81";
    ws[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
      fill: { fgColor: { rgb: fill } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: { bottom: { style: "medium", color: { rgb: "1E1B4B" } } },
    };
  }

  const acosColor = (v: number) => (v < 0.25 ? "92D050" : v > 0.4 ? "FF0000" : "FFCC00");

  for (let r = 1; r < aoa.length; r++) {
    const isGrand = r === grandRowIdx;
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style: any = {
        font: { color: { rgb: "1F2937" }, bold: isGrand },
        alignment: { vertical: "center", horizontal: c === 0 ? "left" : "center" },
        border: {
          bottom: { style: isGrand ? "medium" : "thin", color: { rgb: isGrand ? "312E81" : "E5E7EB" } },
          ...(isGrand ? { top: { style: "medium", color: { rgb: "312E81" } } } : {}),
        },
      };
      const posInWin = c >= winStart && c < availStart ? c - winStart : -1;
      if (c === 3) {
        style.numFmt = "#,##0";
      } else if (posInWin >= 0) {
        if (posInWin === 0 || posInWin === 6) style.numFmt = "#,##0.00";
        else if (posInWin >= 1 && posInWin <= 5) style.numFmt = "#,##0";
        else if (posInWin === 7 || posInWin === 8) {
          style.numFmt = "0.00%";
          if (typeof cell.v === "number" && cell.v > 0) {
            style.fill = { fgColor: { rgb: acosColor(cell.v) } };
            style.font = { color: { rgb: cell.v > 0.4 ? "FFFFFF" : "000000" }, bold: true };
          }
        }
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

  const cols = [{ wch: 46 }, { wch: 20 }, { wch: 11 }, { wch: 10 },
    { wch: 11 }, { wch: 13 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 10 }, { wch: 9 }, { wch: 9 },
    { wch: 46 }, { wch: 11 }, { wch: 22 }, { wch: 24 }, { wch: 8 }];
  ws["!cols"] = cols;
  ws["!rows"] = [{ hpt: 30 }];
  ws["!views"] = [{ state: "frozen", xSplit: 4, ySplit: 1 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Analysis report");

  // ── TACOS sheet ── one row per SKU: Spend+Tax / Orders / Returns / Final
  // orders / CPC / TACOS, mirroring the seller's original pivot's single-window
  // block. Note this sheet's CPC is a different metric than the Analysis
  // report's CPC — here it's Spend+Tax ÷ Final orders (cost per net order),
  // not Spend+Tax ÷ Advertised Units — exactly as the original sheet defined
  // it. TACOS (= CPC ÷ Price) still comes out equal to the Analysis report's
  // TACOS = Spend+Tax ÷ (Price × Final) either way.
  const tacosRows = rows.filter((s) => s.sku !== UNMAPPED);
  const tacosAoa: (string | number)[][] = [
    ["SKU ID", "Price", "Spend+Tax", "Orders", "Returns", "Final orders", "CPC", "TACOS"],
  ];
  tacosRows.forEach((s) => {
    // Unclamped, matching the =D-E formula below (see the same note on the
    // Analysis report rows above) — and the CPC cache mirrors the formula's
    // own IF(Final=0, Spend, Spend/Final) exactly, including what happens
    // when Final is negative (division by a negative number, not a fallback).
    const final = s.orders - s.returns;
    const cpc = final === 0 ? s.spendTax : s.spendTax / final;
    const tacos = s.price > 0 ? cpc / s.price : 0;
    tacosAoa.push([s.sku, Math.round(s.price), s.spendTax, s.orders, s.returns, final, cpc, tacos]);
  });
  const wsTacos = XLSX.utils.aoa_to_sheet(tacosAoa);
  for (let i = 0; i < tacosRows.length; i++) {
    const r = i + 2; // header occupies excel row 1
    if (wsTacos[`F${r}`]) wsTacos[`F${r}`].f = `D${r}-E${r}`;
    if (wsTacos[`G${r}`]) wsTacos[`G${r}`].f = `IF(F${r}=0,C${r},C${r}/F${r})`;
    if (wsTacos[`H${r}`]) wsTacos[`H${r}`].f = `G${r}/B${r}`;
  }
  for (let c = 0; c < 8; c++) {
    const addr = `${colLetter(c)}1`;
    if (!wsTacos[addr]) wsTacos[addr] = { t: "s", v: "" };
    wsTacos[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "4F46E5" } },
      alignment: { horizontal: "center", vertical: "center" },
    };
  }
  wsTacos["!cols"] = [{ wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 10 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(wb, wsTacos, "TACOS");

  // ── FBA status sheet ── one row per FBA SKU: stock-on-hand pivoted by state
  // (account-wide state columns, same set the Analysis report's availability
  // block uses), plus the seller's original Available / Number-of-FBA-Not-
  // Available / All-FBA formulas. Grand Total and Inbound-shipped-quantity
  // stay plain values (sums/uploads), matching the original sheet — only
  // Available / Not-Available / All-FBA were ever formulas there.
  const fbaRows = rows.filter((s) => s.sku !== UNMAPPED && (s.isFba || s.fbaTotal > 0));
  const stateList = [...accountStates].sort();
  const fbaHeader = ["SKU ID", ...stateList, "Available", "Grand Total", "Inbound-shipped-quantity", "Number of FBA Not Available", "All FBA"];
  const fbaAoa: (string | number)[][] = [fbaHeader];
  fbaRows.forEach((s) => {
    const stateVals = stateList.map((st) => s.stateBalances.get(st) || 0);
    const inbound = hasUploadedFbaInv ? (inboundShippedBySku.get(s.sku) || 0) : "—";
    fbaAoa.push([s.sku, ...stateVals, "", s.fbaTotal, inbound, "", ""]);
  });
  const wsFba = XLSX.utils.aoa_to_sheet(fbaAoa);
  if (stateList.length > 0) {
    const stateColStart = colLetter(1);
    const stateColEnd = colLetter(stateList.length);
    const availCol = colLetter(1 + stateList.length);
    const notAvailCol = colLetter(1 + stateList.length + 2);
    const allFbaCol = colLetter(1 + stateList.length + 3);
    for (let i = 0; i < fbaRows.length; i++) {
      const r = i + 2;
      const ifParts = stateList
        .map((_, si) => {
          const letter = colLetter(1 + si);
          return `IF(${letter}${r}>0,$${letter}$1&", ","")`;
        })
        .join("&");
      wsFba[`${availCol}${r}`] = { t: "s", f: `TRIM(SUBSTITUTE(${ifParts},", "," ",LEN(${ifParts})-LEN(SUBSTITUTE(${ifParts},",",""))))` };
      wsFba[`${notAvailCol}${r}`] = { t: "n", f: `COUNTIF(${stateColStart}${r}:${stateColEnd}${r},0)` };
      wsFba[`${allFbaCol}${r}`] = { t: "s", f: `IF(${notAvailCol}${r}>0,"No","Yes")` };
    }
  }
  for (let c = 0; c < fbaHeader.length; c++) {
    const addr = `${colLetter(c)}1`;
    if (!wsFba[addr]) wsFba[addr] = { t: "s", v: "" };
    wsFba[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "059669" } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
    };
  }
  wsFba["!cols"] = [{ wch: 20 }, ...stateList.map(() => ({ wch: 12 })), { wch: 46 }, { wch: 11 }, { wch: 22 }, { wch: 24 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, wsFba, "FBA status");

  // ── Orders / Returns / Adspend leaderboards sheet ──
  // The seller's original workbook built this from 4 independent "top N"
  // lists side by side (Orders by SKU, Returns by SKU, Adspend by campaign,
  // Adspend by SKU), each sorted on its own — row 3 col A and row 3 col C are
  // unrelated SKUs, not a joined table. The original also split each into a
  // 30-day/7-day pair, but that's the LIVE report's trailing-window concept
  // (analysisReportExport.ts) — it doesn't map onto this report's arbitrary
  // date range, so here each list covers this report's own single
  // startDate–endDate window instead of a fabricated 30/7 split.
  const lbOrders = rows
    .filter((s) => s.sku !== UNMAPPED && s.orders > 0)
    .map((s): [string, number] => [s.sku, s.orders])
    .sort((a, b) => b[1] - a[1]);
  const lbReturns = rows
    .filter((s) => s.sku !== UNMAPPED && s.returns > 0)
    .map((s): [string, number] => [s.sku, s.returns])
    .sort((a, b) => b[1] - a[1]);

  const campaignSpend = new Map<string, { spend: number; sku: string }>();
  const addCampaignSpend = (campaignName: string | undefined, sku: string | undefined, spend: number | undefined) => {
    if (!campaignName) return;
    const cur = campaignSpend.get(campaignName) || { spend: 0, sku: sku || "" };
    cur.spend += spend || 0;
    if (!cur.sku && sku) cur.sku = sku;
    campaignSpend.set(campaignName, cur);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spRows.forEach((r: any) => addCampaignSpend(r.campaign_name, r.advertised_sku, r.spend));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sbRows.forEach((r: any) => addCampaignSpend(r.campaign_name, campaignSkuMap.get(r.campaign_name), r.spend));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdRows.forEach((r: any) => addCampaignSpend(r.campaign_name, campaignSkuMap.get(r.campaign_name), r.spend));
  const lbAdspendByCampaign = [...campaignSpend.entries()]
    .filter(([, v]) => v.spend > 0)
    .map((entry): [string, number] => [`${entry[0]}*${entry[1].sku}`, entry[1].spend])
    .sort((a, b) => b[1] - a[1]);

  // spendTax is already GST-inclusive (spendTax = raw spend × 1.18) — divide
  // back out so this sheet can show the same raw-then-formula pattern as the
  // reference (raw spend value, with a =×1.18 formula computing Spend+Tax).
  const lbAdspendBySku = rows
    .filter((s) => s.sku !== UNMAPPED && s.spendTax > 0)
    .map((s): [string, number, number] => [s.sku, s.spendTax / GST_MULTIPLIER, s.advUnits])
    .sort((a, b) => b[1] - a[1]);

  const lbRowCount = Math.max(lbOrders.length, lbReturns.length, lbAdspendByCampaign.length, lbAdspendBySku.length);
  const lbAoa: (string | number)[][] = [
    ["Orders", "", "Returns", "", "Adspend (by campaign)", "", "", "Adspend (by SKU)", "", "", ""],
    ["SKU", "Orders", "SKU", "Returns", "Campaign*SKU", "Spend", "Spend+Tax", "SKU", "Spend", "Spend+Tax", "Advertised SKU Units"],
  ];
  for (let i = 0; i < lbRowCount; i++) {
    lbAoa.push([
      lbOrders[i]?.[0] ?? "", lbOrders[i]?.[1] ?? "",
      lbReturns[i]?.[0] ?? "", lbReturns[i]?.[1] ?? "",
      lbAdspendByCampaign[i]?.[0] ?? "", lbAdspendByCampaign[i]?.[1] ?? "", "",
      lbAdspendBySku[i]?.[0] ?? "", lbAdspendBySku[i]?.[1] ?? "", "",
      lbAdspendBySku[i]?.[2] ?? "",
    ]);
  }
  const wsLb = XLSX.utils.aoa_to_sheet(lbAoa);
  for (let i = 0; i < lbRowCount; i++) {
    const r = i + 3; // 2 header rows
    if (lbAdspendByCampaign[i]) wsLb[`G${r}`] = { t: "n", f: `F${r}*1.18` };
    if (lbAdspendBySku[i]) wsLb[`J${r}`] = { t: "n", f: `I${r}*1.18` };
  }
  wsLb["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 0, c: 3 } },
    { s: { r: 0, c: 4 }, e: { r: 0, c: 6 } },
    { s: { r: 0, c: 7 }, e: { r: 0, c: 10 } },
  ];
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < 11; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!wsLb[addr]) wsLb[addr] = { t: "s", v: "" };
      wsLb[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" }, sz: r === 0 ? 11 : 10 },
        fill: { fgColor: { rgb: r === 0 ? "312E81" : "4F46E5" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
    }
  }
  wsLb["!cols"] = [
    { wch: 20 }, { wch: 9 }, { wch: 20 }, { wch: 9 },
    { wch: 46 }, { wch: 11 }, { wch: 11 },
    { wch: 20 }, { wch: 11 }, { wch: 11 }, { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(wb, wsLb, "Orders, returns, adspend");

  // ── Raw sheets (mirror the 4 uploaded transactional files) ──
  //
  // These use a lighter renderer than buildStyledSheet (excelExport.ts):
  // xlsx-js-style stores a full style object per styled cell with no
  // deduplication, and these sheets can run to 8,000+ rows (a month of
  // Orders), so per-cell styling alone was ballooning the file to ~8MB for
  // 3x more sheets/rows than the seller's original ~2.4MB workbook. Only the
  // header row is styled here; the Analysis report sheet above (the one
  // that's actually meant to be read closely) keeps its full styling.
  interface LightCol {
    key: string;
    label: string;
    percent?: boolean;
    // Value comes from a raw CSV-export column (all-string) — coerce to a
    // real number when parseable, so Excel can sort/format it as one instead
    // of a text string.
    numeric?: boolean;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildLightSheet(rows: any[], columns: LightCol[]) {
    const lightAoa: unknown[][] = [columns.map((c) => c.label)];
    rows.forEach((row) => {
      lightAoa.push(columns.map((c) => {
        const v = row[c.key] ?? "";
        if (c.numeric && v !== "") {
          const n = Number(v);
          if (Number.isFinite(n)) return n;
        }
        return v;
      }));
    });
    const lws = XLSX.utils.aoa_to_sheet(lightAoa);
    for (let c = 0; c < columns.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (!lws[addr]) continue;
      lws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "4F46E5" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
    }
    if (columns.some((c) => c.percent)) {
      const percentCols = new Set(columns.map((c, i) => (c.percent ? i : -1)).filter((i) => i >= 0));
      for (let r = 1; r < lightAoa.length; r++) {
        percentCols.forEach((c) => {
          const addr = XLSX.utils.encode_cell({ r, c });
          if (lws[addr] && typeof lws[addr].v === "number") lws[addr].s = { numFmt: "0.00%" };
        });
      }
    }
    lws["!cols"] = columns.map((c) => ({ wch: Math.max(12, c.label.length + 4) }));
    return lws;
  }

  const ORDER_COLS: LightCol[] = [
    { key: "purchase_date", label: "Purchase Date" },
    { key: "amazon_order_id", label: "Order ID" },
    { key: "order_status", label: "Status" },
    { key: "fulfillment_channel", label: "Fulfillment" },
    { key: "sku", label: "SKU" },
    { key: "asin", label: "ASIN" },
    { key: "product_name", label: "Product" },
    { key: "quantity", label: "Qty" },
    { key: "item_price", label: "Item Price" },
    { key: "item_tax", label: "Item Tax" },
    { key: "shipping_price", label: "Shipping" },
    { key: "ship_city", label: "City" },
    { key: "ship_state", label: "State" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(orderRows, ORDER_COLS), "Orders");

  const AM_RETURN_COLS: LightCol[] = [
    { key: "return_request_date", label: "Return Request Date" },
    { key: "order_date", label: "Order Date" },
    { key: "order_id", label: "Order ID" },
    { key: "asin", label: "ASIN" },
    { key: "merchant_sku", label: "SKU" },
    { key: "item_name", label: "Item Name" },
    { key: "return_quantity", label: "Qty" },
    { key: "return_reason", label: "Reason" },
    { key: "return_type", label: "Return Type" },
    { key: "resolution", label: "Resolution" },
    { key: "order_amount", label: "Order Amount" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(amReturnRows, AM_RETURN_COLS), "AM returns");

  const FBA_RETURN_COLS: LightCol[] = [
    { key: "return_date", label: "Return Date" },
    { key: "order_id", label: "Order ID" },
    { key: "sku", label: "SKU" },
    { key: "asin", label: "ASIN" },
    { key: "product_name", label: "Product" },
    { key: "quantity", label: "Qty" },
    { key: "fulfillment_center_id", label: "FC" },
    { key: "detailed_disposition", label: "Disposition" },
    { key: "reason", label: "Reason" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(fbaReturnRows, FBA_RETURN_COLS), "FBA returns");

  const SF_RETURN_COLS: LightCol[] = [
    { key: "pickup_date", label: "Pick-up Date" },
    { key: "customer_order_id", label: "Order ID" },
    { key: "sku", label: "SKU" },
    { key: "msku", label: "mSKU" },
    { key: "asin", label: "ASIN" },
    { key: "units", label: "Units" },
    { key: "return_type", label: "Return Type" },
    { key: "return_status", label: "Return Status" },
    { key: "carrier", label: "Carrier" },
    { key: "returned_with_otp", label: "Returned with OTP" },
    { key: "days_in_transit", label: "Days In-transit" },
    { key: "days_since_return_complete", label: "Days Since Return Complete" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(sfReturnRows, SF_RETURN_COLS), "SF returns");

  const adRows = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...spRows.map((r: any) => ({
      reportType: "SP", date: r.report_date, campaign: r.campaign_name, sku: r.advertised_sku,
      spend: r.spend, sales: r.sales_7d, units: r.advertised_sku_units_7d, acos: r.acos, roas: r.roas,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...sbRows.map((r: any) => ({
      reportType: "SB", date: r.report_date, campaign: r.campaign_name, sku: campaignSkuMap.get(r.campaign_name) || "",
      spend: r.spend, sales: r.sales, units: r.units, acos: r.acos, roas: r.roas,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...sdRows.map((r: any) => ({
      reportType: "SD", date: r.report_date, campaign: r.campaign_name, sku: campaignSkuMap.get(r.campaign_name) || "",
      spend: r.spend, sales: r.sales_14d, units: r.units_14d, acos: r.acos, roas: r.roas,
    })),
  ];
  const ADSPEND_COLS: LightCol[] = [
    { key: "reportType", label: "Report" },
    { key: "date", label: "Date" },
    { key: "campaign", label: "Campaign" },
    { key: "sku", label: "SKU" },
    { key: "spend", label: "Spend" },
    { key: "sales", label: "Sales" },
    { key: "units", label: "Units" },
    { key: "acos", label: "ACOS", percent: true },
    { key: "roas", label: "ROAS" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(adRows, ADSPEND_COLS), "Adspend");

  // ── Catalog/inventory raw sheets (mirror the 3 uploaded snapshot files) ──
  const PRICE_COLS: LightCol[] = [
    { key: "seller_sku", label: "Seller SKU" },
    { key: "asin1", label: "ASIN" },
    { key: "item_name", label: "Item Name" },
    { key: "price", label: "Price" },
    { key: "business_price", label: "Business Price" },
    { key: "quantity", label: "Quantity" },
    { key: "fulfillment_channel", label: "Fulfillment Channel" },
    { key: "item_condition", label: "Condition" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(priceListingRows, PRICE_COLS), "Price");

  // ── All Listings sheet (the seller's original "Sheet3") ──
  // No separate upload needed: the Price (All Listings) upload's CSV row is
  // already kept in full in its `raw` column (mapPriceListingRow in
  // amazonReportUpload.ts only lifts 8 fields into named columns, but stores
  // every column Amazon's export has) — this sheet just reads the rest of it
  // back out, straight from the same upload already on file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allListingsRows = priceListingRows.map((r: any) => r.raw || {});
  const ALL_LISTINGS_COLS: LightCol[] = [
    { key: "item-name", label: "Item Name" },
    { key: "item-description", label: "Item Description" },
    { key: "listing-id", label: "Listing ID" },
    { key: "seller-sku", label: "Seller SKU" },
    { key: "price", label: "Price", numeric: true },
    { key: "quantity", label: "Quantity", numeric: true },
    { key: "open-date", label: "Open Date" },
    { key: "image-url", label: "Image URL" },
    { key: "item-is-marketplace", label: "Item Is Marketplace" },
    { key: "product-id-type", label: "Product ID Type" },
    { key: "zshop-shipping-fee", label: "Zshop Shipping Fee", numeric: true },
    { key: "item-note", label: "Item Note" },
    { key: "item-condition", label: "Item Condition" },
    { key: "zshop-category1", label: "Zshop Category1" },
    { key: "zshop-browse-path", label: "Zshop Browse Path" },
    { key: "zshop-storefront-feature", label: "Zshop Storefront Feature" },
    { key: "asin1", label: "ASIN1" },
    { key: "asin2", label: "ASIN2" },
    { key: "asin3", label: "ASIN3" },
    { key: "will-ship-internationally", label: "Will Ship Internationally" },
    { key: "expedited-shipping", label: "Expedited Shipping" },
    { key: "zshop-boldface", label: "Zshop Boldface" },
    { key: "product-id", label: "Product ID" },
    { key: "bid-for-featured-placement", label: "Bid For Featured Placement" },
    { key: "add-delete", label: "Add Delete" },
    { key: "pending-quantity", label: "Pending Quantity", numeric: true },
    { key: "fulfillment-channel", label: "Fulfillment Channel" },
    { key: "Business Price", label: "Business Price", numeric: true },
    { key: "Quantity Price Type", label: "Quantity Price Type" },
    { key: "Quantity Lower Bound 1", label: "Quantity Lower Bound 1", numeric: true },
    { key: "Quantity Price 1", label: "Quantity Price 1", numeric: true },
    { key: "Quantity Lower Bound 2", label: "Quantity Lower Bound 2", numeric: true },
    { key: "Quantity Price 2", label: "Quantity Price 2", numeric: true },
    { key: "Quantity Lower Bound 3", label: "Quantity Lower Bound 3", numeric: true },
    { key: "Quantity Price 3", label: "Quantity Price 3", numeric: true },
    { key: "Quantity Lower Bound 4", label: "Quantity Lower Bound 4", numeric: true },
    { key: "Quantity Price 4", label: "Quantity Price 4", numeric: true },
    { key: "Quantity Lower Bound 5", label: "Quantity Lower Bound 5", numeric: true },
    { key: "Quantity Price 5", label: "Quantity Price 5", numeric: true },
    { key: "optional-payment-type-exclusion", label: "Optional Payment Type Exclusion" },
    { key: "Progressive Price Type", label: "Progressive Price Type" },
    { key: "Progressive Lower Bound 1", label: "Progressive Lower Bound 1", numeric: true },
    { key: "Progressive Price 1", label: "Progressive Price 1", numeric: true },
    { key: "Progressive Lower Bound 2", label: "Progressive Lower Bound 2", numeric: true },
    { key: "Progressive Price 2", label: "Progressive Price 2", numeric: true },
    { key: "Progressive Lower Bound 3", label: "Progressive Lower Bound 3", numeric: true },
    { key: "Progressive Price 3", label: "Progressive Price 3", numeric: true },
    { key: "maximum-retail-price", label: "Maximum Retail Price", numeric: true },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(allListingsRows, ALL_LISTINGS_COLS), "All Listings");

  const FBA_INVENTORY_COLS: LightCol[] = [
    { key: "sku", label: "SKU" },
    { key: "fnsku", label: "FNSKU" },
    { key: "asin", label: "ASIN" },
    { key: "product_name", label: "Product" },
    { key: "condition", label: "Condition" },
    { key: "your_price", label: "Your Price" },
    { key: "mfn_fulfillable_quantity", label: "MFN Fulfillable Qty" },
    { key: "afn_fulfillable_quantity", label: "AFN Fulfillable Qty" },
    { key: "afn_total_quantity", label: "AFN Total Qty" },
    { key: "afn_unsellable_quantity", label: "AFN Unsellable Qty" },
    { key: "afn_reserved_quantity", label: "AFN Reserved Qty" },
    { key: "afn_inbound_working_quantity", label: "AFN Inbound Working Qty" },
    { key: "afn_inbound_shipped_quantity", label: "AFN Inbound Shipped Qty" },
    { key: "afn_inbound_receiving_quantity", label: "AFN Inbound Receiving Qty" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(fbaInventoryRows, FBA_INVENTORY_COLS), "FBA inventory");

  const LEDGER_COLS: LightCol[] = [
    { key: "ledger_date", label: "Date" },
    { key: "fnsku", label: "FNSKU" },
    { key: "asin", label: "ASIN" },
    { key: "msku", label: "MSKU" },
    { key: "title", label: "Title" },
    { key: "disposition", label: "Disposition" },
    { key: "starting_balance", label: "Starting Balance" },
    { key: "customer_shipments", label: "Customer Shipments" },
    { key: "customer_returns", label: "Customer Returns" },
    { key: "ending_balance", label: "Ending Balance" },
    { key: "location", label: "Location" },
  ];
  XLSX.utils.book_append_sheet(wb, buildLightSheet(ledgerRawRows, LEDGER_COLS), "Inventory ledger");

  // ── Notes sheet ──
  const wsNote = XLSX.utils.aoa_to_sheet([
    ["Historical Analysis Report — Ad Performance"],
    [`Account: ${accountName || "-"}`],
    [`Range: ${dotDate(startDate)} to ${dotDate(endDate)}`],
    [""],
    ["Sourced from the manually uploaded reports (Upload Reports page), not the live SellerMate API — this is what lets it cover a fixed historical range instead of only 'last 30/7 days from today'."],
    ["One row per SKU (not per ASIN) — Sponsored Products' Advertised Product report, the Orders report, and both returns reports all carry the real SKU."],
    ["Sponsored Brands and Sponsored Display only export campaign-level ad reports (Amazon does not include a SKU column on either) — their spend is routed to a SKU via the Campaign -> SKU map maintained on the Upload page. Unmapped campaigns are grouped under the '⚠ Unmapped SB/SD campaigns' row instead of being dropped."],
    ["Spend+Tax = ad spend x 1.18 (18% GST). Final = Orders - Returns."],
    ["Advertised SKU Units = ad-attributed units (SP's own 'Advertised SKU Units', or SB/SD's mapped-campaign units)."],
    ["Orders / Total Units = real total units sold for the SKU across all channels, from the uploaded Orders export (not an estimate)."],
    ["CPC = Spend+Tax / Advertised SKU Units. ACOS = CPC / Price. TACOS = Spend+Tax / (Price x Final)."],
    ["Returns exclude courier RTO / undeliverable (AM returns: Return Type = 'Undelivered'; FBA returns: reason starting with 'UNDELIVERABLE')."],
    [
      hasUploadedPrice
        ? "Price and FBA/MFN channel come from the uploaded Price (All Listings) report."
        : "Price and FBA/MFN channel come from the LIVE product catalog (today's snapshot) — no Price report has been uploaded, so this may not match what price actually was during this date range.",
    ],
    [
      hasUploadedLedger
        ? `FBA availability comes from the uploaded Inventory Ledger report, as of ${dotDate(endDate)} (the latest SELLABLE balance per SKU/location on or before that date) — not today.`
        : "FBA availability comes from the LIVE inventory feed (today's snapshot) — no Inventory Ledger report has been uploaded, so this may not match actual stock during this date range.",
    ],
    [
      hasUploadedFbaInv
        ? "Inbound-shipped-quantity comes from the uploaded FBA Inventory report."
        : "Inbound-shipped-quantity shows '—': not exposed by the live inventory feed, and no FBA Inventory report has been uploaded.",
    ],
    ["TACOS sheet: same per-SKU figures as the Analysis report, but CPC here = Spend+Tax / Final orders (cost per net order) rather than Spend+Tax / Advertised SKU Units — matching the seller's original workbook. TACOS (= CPC / Price) comes out the same either way."],
    ["FBA status sheet: per-state stock pivot for FBA SKUs only, with the same Available / Number of FBA Not Available / All FBA formulas as the seller's original workbook."],
    ["Price / All Listings / FBA inventory / Inventory ledger sheets: raw dumps of the uploaded snapshot/ledger files, for reference — not filtered or aggregated. All Listings reuses the same Price upload (no separate file needed) — Amazon's export has far more columns than the Price sheet's 8, and all of them are already saved per-row in that upload, this sheet just surfaces the rest."],
    ["SF returns sheet: raw dump of uploaded SellerFlex (self-fulfilled) returns for this date range, if any were uploaded. Not currently folded into the Returns / Final / ACOS / TACOS figures elsewhere in this workbook — those still only count AM returns + FBA returns, same as before this sheet was added."],
    ["'Orders, returns, adspend' sheet: 4 independent top-N lists side by side (Orders by SKU, Returns by SKU, Adspend by campaign, Adspend by SKU) — each column-group is sorted on its own, so a given row is NOT one record; SKU X in the Orders columns has no relation to whatever SKU appears in the Returns columns of that same row. The seller's original workbook split each list into a 30-day/7-day pair, but that's the live dashboard's trailing-window convention — it doesn't apply to this report's arbitrary date range, so each list here covers this report's own start–end window only (no 7-day variant)."],
  ]);
  wsNote["!cols"] = [{ wch: 110 }];
  wsNote["A1"].s = { font: { bold: true, sz: 13, color: { rgb: "312E81" } } };
  XLSX.utils.book_append_sheet(wb, wsNote, "Notes");

  const filename = `Historical_Analysis_Report_${startDate}_to_${endDate}.xlsx`;
  return {
    wb,
    filename,
    skuCount: rows.length,
    unmappedCampaignSpend: skus.get(UNMAPPED)?.spendTax || 0,
  };
}

export async function exportHistoricalAnalysisReport(opts: {
  startDate: string;
  endDate: string;
  account: { id?: string; workspace_id?: string; name?: string } | null | undefined;
  keySlot: string;
}) {
  const { account, keySlot, startDate, endDate } = opts;
  const call: ToolCaller = (tool, args) => mcp(tool, args, keySlot);
  const { wb, filename, ...stats } = await buildHistoricalAnalysisReportWorkbook({
    call,
    accountId: account?.id,
    workspaceId: account?.workspace_id,
    accountName: account?.name,
    startDate,
    endDate,
  });
  // bookSST forces a shared-string table instead of xlsx-js-style's default of
  // inlining every string cell — with thousands of Orders rows repeating the
  // same ~150-char product names, this is the difference between an ~8MB and
  // ~1.5MB file for the same data.
  XLSX.writeFile(wb, filename, { bookSST: true });
  return { filename, ...stats };
}
