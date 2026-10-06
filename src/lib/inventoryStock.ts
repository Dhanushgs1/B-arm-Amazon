// Inventory stock — ONE definition, used by the Inventory page and its reconciliation.
//
// FBA stock = Amazon "Available": FBA units that can be sold right now — the "Available" column in
// Seller Central's FBA inventory and in Amazon's FBA Inventory report. Reserved (customer orders /
// FC processing), inbound and unfulfillable units are shown beside it, never added into it.
// Source: the latest uploaded Amazon FBA Inventory report (barm_amazon_fba_inventory), dated by the
// report's own snapshot-date. It is a daily snapshot, not live stock; the page says "as of" that date.
//
// Why not SellerMate get_inventory's fba.endingWarehouseBalance (what this page used before):
//  • it is an Inventory-Ledger warehouse balance, a different metric from "Available" (it includes
//    reserved and damaged/defective units), from a different day (typically 1–2 days older); and
//  • SellerMate keeps only ONE disposition row per SKU per warehouse — where a warehouse holds e.g.
//    42 sellable + 1 damaged units it reports 1 — so the figure is neither sellable nor total stock.
//    Verified on 2026-10-06 against Amazon's own ledger: 12 of 12 multi-disposition warehouses
//    affected (A019-14 short by 281 units, B-BT-B1-1 by 42).
// The ledger balance is therefore kept only as a labelled reference column, never as "stock", and
// only used as the FBA figure (clearly labelled) for an account that has no FBA report on file.
//
// FBM stock = SellerMate fbm.quantity (listing quantity from Amazon's active listings sync).

export interface SellerMateInventoryItem {
  asin: string;
  sku?: string;
  itemName?: string;
  price?: number;
  mainImageUrl?: string;
  fbm?: { quantity?: number } | null;
  fba?: { endingWarehouseBalance?: number; byLocation?: { location: string; endingWarehouseBalance: number; sku?: string; asOfDate?: string }[] } | null;
}

export interface FbaReportRow {
  sku: string;
  asin: string;
  afn_fulfillable_quantity: number | null;
  afn_reserved_quantity: number | null;
  afn_unsellable_quantity: number | null;
  afn_inbound_working_quantity: number | null;
  afn_inbound_shipped_quantity: number | null;
  afn_inbound_receiving_quantity: number | null;
  mfn_fulfillable_quantity?: number | null;
  snapshot_date: string | null;
  created_at?: string | null;
}

export type FbaSource = "amazon_report" | "sellermate_ledger";
export type StockStatus = "Healthy" | "Low Stock" | "Out of Stock";

export interface InventoryRow {
  asin: string;
  itemName: string;
  mainImageUrl?: string;
  price: number;
  skuList: string;
  fbaSkus: string[]; // SKUs that hold FBA stock in the Amazon report
  fbaAvailable: number | null; // Amazon "Available"; null = no figure (not in report)
  fbaReserved: number | null;
  fbaInbound: number | null;
  fbaUnfulfillable: number | null;
  ledgerBalance: number | null; // SellerMate ledger warehouse balance (reference only)
  fbmQty: number;
  totalQty: number; // sellable now: FBA Available + FBM
  totalValue: number;
  stockStatus: StockStatus;
  fbaSource: FbaSource;
  /** set when the row needs a human check (e.g. Amazon's report doesn't list it but the ledger has units) */
  fbaNote: string | null;
}

export interface InventoryResult {
  rows: InventoryRow[];
  fbaSource: FbaSource;
  reportAsOf: string | null; // snapshot date of the Amazon FBA Inventory report used
  reportUploadedAt: string | null;
  ledgerAsOf: string | null; // latest SellerMate ledger date seen
  reportOlderThanLedger: boolean;
  notes: string[];
}

export const LOW_STOCK_UNITS = 20;

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function stockStatus(totalQty: number): StockStatus {
  return totalQty <= 0 ? "Out of Stock" : totalQty < LOW_STOCK_UNITS ? "Low Stock" : "Healthy";
}

/** The report applies to this account when most of its ASINs are in the account's SellerMate list —
 *  the report table holds one seller's stock, so another account must not borrow its numbers. */
export function reportMatchesAccount(report: FbaReportRow[], items: SellerMateInventoryItem[]): boolean {
  const reportAsins = new Set(report.map((r) => r.asin).filter(Boolean));
  if (!reportAsins.size) return false;
  const accountAsins = new Set(items.map((i) => i.asin));
  let hit = 0;
  for (const a of reportAsins) if (accountAsins.has(a)) hit++;
  return hit / reportAsins.size >= 0.5;
}

export function buildInventory(
  items: SellerMateInventoryItem[],
  skuMap: Record<string, string[]>,
  report: FbaReportRow[],
  ledgerItems: SellerMateInventoryItem[] = [],
  resolveName: (name: string, skus: string) => string = (x) => x,
): InventoryResult {
  const useReport = reportMatchesAccount(report, items);
  const fbaSource: FbaSource = useReport ? "amazon_report" : "sellermate_ledger";

  const reportByAsin = new Map<string, FbaReportRow[]>();
  if (useReport) for (const r of report) {
    if (!r.asin) continue;
    const l = reportByAsin.get(r.asin) ?? [];
    l.push(r); reportByAsin.set(r.asin, l);
  }
  const reportAsOf = useReport ? report.map((r) => r.snapshot_date).filter(Boolean).sort().at(-1) ?? null : null;
  const reportUploadedAt = useReport ? report.map((r) => r.created_at).filter(Boolean).sort().at(-1) ?? null : null;
  const ledgerDates = ledgerItems.flatMap((i) => (i.fba?.byLocation ?? []).map((l) => (l.asOfDate ?? "").slice(0, 10))).filter(Boolean).sort();
  const ledgerAsOf = ledgerDates.at(-1) ?? null;

  const seen = new Set<string>();
  const rows: InventoryRow[] = items.map((i) => {
    seen.add(i.asin);
    const skus = i.sku ? [i.sku] : skuMap[i.asin] ?? [];
    const rep = reportByAsin.get(i.asin);
    const ledger = i.fba?.endingWarehouseBalance ?? null;
    // Not in Amazon's report = Amazon gives no "Available" figure for it: unknown (—), not 0. Amazon
    // leaves a SKU out when it has no active FBA offer; units may still sit in the warehouse.
    const fbaAvailable = useReport ? (rep ? rep.reduce((a, r) => a + n(r.afn_fulfillable_quantity), 0) : null) : ledger;
    const fbaNote = useReport && !rep && n(ledger) > 0
      ? `Not in Amazon's FBA Inventory report, but SellerMate's ledger shows ${ledger} unit(s) in Amazon warehouses — check this listing in Seller Central (inactive/suppressed listing, or damaged units).`
      : null;
    const fbmQty = n(i.fbm?.quantity);
    const totalQty = n(fbaAvailable) + fbmQty;
    return {
      asin: i.asin,
      itemName: resolveName(i.itemName ?? "", skus.join(", ")) || i.itemName || "",
      mainImageUrl: i.mainImageUrl,
      price: n(i.price),
      skuList: skus.join(", ") || "—",
      fbaSkus: rep ? rep.map((r) => r.sku) : [],
      fbaAvailable,
      fbaReserved: rep ? rep.reduce((a, r) => a + n(r.afn_reserved_quantity), 0) : null,
      fbaInbound: rep ? rep.reduce((a, r) => a + n(r.afn_inbound_working_quantity) + n(r.afn_inbound_shipped_quantity) + n(r.afn_inbound_receiving_quantity), 0) : null,
      fbaUnfulfillable: rep ? rep.reduce((a, r) => a + n(r.afn_unsellable_quantity), 0) : null,
      ledgerBalance: ledger,
      fbmQty,
      totalQty,
      totalValue: totalQty * n(i.price),
      stockStatus: stockStatus(totalQty),
      fbaSource,
      fbaNote,
    };
  });

  // ASINs Amazon reports FBA stock for but SellerMate's listing doesn't return — keep them visible
  // rather than silently dropping real stock
  for (const [asin, rep] of reportByAsin) {
    if (seen.has(asin)) continue;
    const fbaAvailable = rep.reduce((a, r) => a + n(r.afn_fulfillable_quantity), 0);
    const skus = rep.map((r) => r.sku);
    rows.push({
      asin, itemName: resolveName("", skus.join(", ")) || skus.join(", "), price: 0, skuList: skus.join(", "), fbaSkus: skus,
      fbaAvailable,
      fbaReserved: rep.reduce((a, r) => a + n(r.afn_reserved_quantity), 0),
      fbaInbound: rep.reduce((a, r) => a + n(r.afn_inbound_working_quantity) + n(r.afn_inbound_shipped_quantity) + n(r.afn_inbound_receiving_quantity), 0),
      fbaUnfulfillable: rep.reduce((a, r) => a + n(r.afn_unsellable_quantity), 0),
      ledgerBalance: null, fbmQty: 0, totalQty: fbaAvailable, totalValue: 0, stockStatus: stockStatus(fbaAvailable), fbaSource,
      fbaNote: "In Amazon's FBA Inventory report but not returned by SellerMate's inventory list.",
    });
  }

  const notes: string[] = [];
  const reportOlderThanLedger = !!(useReport && reportAsOf && ledgerAsOf && reportAsOf < ledgerAsOf);
  if (!useReport) notes.push("No Amazon FBA Inventory report on file for this account — FBA column shows SellerMate's ledger warehouse balance, which is NOT Amazon's \"Available\" figure.");
  if (reportOlderThanLedger) notes.push(`The FBA Inventory report (${reportAsOf}) is older than SellerMate's ledger (${ledgerAsOf}) — upload today's FBA Inventory report for current stock.`);
  return { rows, fbaSource, reportAsOf, reportUploadedAt, ledgerAsOf, reportOlderThanLedger, notes };
}
