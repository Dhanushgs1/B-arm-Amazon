// Consolidated Stock Sheet (user, 2026-10-12) — rebuilds the client's daily "Consolidate sheet" from
// the godown's "Combined godown stock sheet as on DD.MM.YYYY.xlsx", the file Kavinilavan mails daily.
// Checked against the 26-08-2026 pair of files: current stock and all 10 day columns matched the
// client's sheet for 242 of 243 products.
//
// Godown workbook, tab "FC Stock sheet " (one row per listing; several rows per master product):
//   col D (index 3)            master product name — the Consolidate sheet's product key
//   "Inbound shipped", "unfulfillable", "Final Stock in Warehouse", "QC Godown stock sheet",
//   "Packing godown stock sheet"   → current stock = their sum, summed over the product's rows
//   "Stock as on DD.MM.YYYY" blocks of 4 columns: Opening | Stock IN | Stock Out | Closing
//                                → shipped that day = Stock Out
// Tab "Discontinued products": product names (column A) — never listed as "no sales".
//
// Consolidate sheet columns (client formulas):
//   DAY 10 … DAY 1        Stock Out of the 10 latest dated blocks
//   Average/day          sum ÷ 10
//   Need 180/90/45 days  average × days
//   Qty to restock       need180 − (current + in-transit + order placed)
//   Final qty to restock MAX(qty to restock, purchase-sheet qty)       (never below 0 here)
//   Runs out in (days)   current ÷ average
// Lists: running out = selling and under 30 days of stock; sales dropped = DAY3 > DAY2 > DAY1;
// no sales = 0 shipped all 10 days with stock on hand (discontinued products left out).
// In-transit, order placed and purchase-sheet qty come from the separate "Total Orders and Minimum
// Stock" workbook (client VLOOKUPs: column S = order placed, T = in transit, W = purchase qty).

export const CONSOLIDATED_DAYS = 10;
export const RUNNING_OUT_DAYS = 30;

export interface GodownProduct {
  product: string;
  currentStock: number;
  inboundShipped: number;
  unfulfillable: number;
  warehouse: number;
  qcGodown: number;
  packingGodown: number;
  skuRows: number;
  discontinued: boolean;
}

export interface GodownDay {
  date: string; // YYYY-MM-DD
  product: string;
  opening: number;
  stockIn: number;
  stockOut: number;
  closing: number;
}

export interface GodownParse {
  snapshotDate: string;
  products: GodownProduct[];
  daily: GodownDay[];
  warnings: string[];
}

/** In transit / order placed / Suggested RFQ for a product, from the week's Monday snapshot. */
export interface RestockInput {
  product: string;
  orderPlaced: number | null;
  stockIntransit: number | null;
  purchaseQty: number | null;
}

export interface ConsolidatedRow {
  product: string;
  days: (number | null)[]; // oldest → newest (DAY 10 … DAY 1); null = no data for that date
  avgPerDay: number;
  need180: number;
  need90: number;
  need45: number;
  currentStock: number;
  stockIntransit: number | null;
  orderPlaced: number | null;
  qtyToRestock: number;
  purchaseQty: number | null;
  finalQtyToRestock: number;
  comboQty: number | null; // "Stock to be purchased for Combo products": this product as a component
  peakQty: number | null;   // highest single-day Stock Out across every godown day passed in (null = never shipped)
  peakDate: string | null;  // the day of that peak (the latest one on a tie)

  daysOfStock: number | null; // null = not selling
  discontinued: boolean;
}

type Cell = unknown;
const num = (v: Cell): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};
export const productKey = (s: Cell) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const label = (s: Cell) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** "Stock as on 26.08.2026" → "2026-08-26". */
export function blockDate(header: Cell): string | null {
  const m = String(header ?? "").match(/stock as on\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** Where a date block's columns sit, read from the sub-header row under it. The godown sheet has two
 *  layouts (user's file of 11.10.2026): blocks from 19.07.2026 on are Opening Stock | Stock IN |
 *  Stock Out | Closing Stock; older ones are Stock IN | Stock Out | Total Stock Count. Reading the old
 *  ones with the 4-column offsets took Total Stock Count as Stock Out. No labels at all (older test
 *  files) = the 4-column layout. */
interface Block { date: string; col: number; openingAt: number | null; inAt: number; outAt: number; closingAt: number; incomplete?: string }
function blockLayout(sub: Cell[], col: number, head: Cell[]): Omit<Block, "date" | "col"> {
  let end = col + 1;
  while (end < Math.max(head.length, sub.length) && end < col + 6 && !blockDate(head[end])) end++;
  const at = (re: RegExp) => { for (let c = col; c < end; c++) if (re.test(label(sub[c]))) return c - col; return null; };
  const inAt = at(/^stock in$/), outAt = at(/^stock out$/), closingAt = at(/^(closing stock|total stock count)$/), openingAt = at(/^opening stock$/);
  if (inAt === null || outAt === null || closingAt === null) {
    // Labelled but missing Stock Out or the stock count (the oldest block of 20.11.2024 is cut off at
    // the sheet's last column): skipped, never read with guessed offsets.
    if ([inAt, outAt, closingAt, openingAt].some((v) => v !== null)) {
      return { openingAt: 0, inAt: 1, outAt: 2, closingAt: 3, incomplete: sub.slice(col, end).map((x) => String(x ?? "")).filter(Boolean).join(" | ") };
    }
    return { openingAt: 0, inAt: 1, outAt: 2, closingAt: 3 };
  }
  return { openingAt, inAt, outAt, closingAt };
}

/** Parse the godown workbook's "FC Stock sheet" rows (header row first) and the discontinued list.
 *  dailyDays: how many of the latest dated blocks to keep (the sheet carries ~2 years of them). */
export function parseGodownSheet(rows: Cell[][], discontinuedRows: Cell[][] = [], dailyDays = 31): GodownParse {
  const warnings: string[] = [];
  const head = rows[0] ?? [];
  // Master product name: column D in the old layout ("Products" in A1), column B in the client's
  // template from 05.10.2026 ("Master Data" in B1, listing name in A, master SKU in C).
  const masterCol = /^products?$/i.test(String(head[0] ?? "").trim()) ? 3
    : /^master data$/i.test(String(head[1] ?? "").trim()) ? 1 : -1;
  if (masterCol < 0) {
    throw new Error('This does not look like the godown "FC Stock sheet" — expected "Products" in A1 or "Master Data" in B1.');
  }
  const find = (re: RegExp) => head.findIndex((h) => re.test(label(h)));
  const cols = {
    inboundShipped: find(/^inbound shipped$/),
    unfulfillable: find(/^unfulfillable$/),
    warehouse: find(/^final stock in warehouse$/),
    qc: find(/^qc godown stock sheet$/),
    packing: find(/^packing godown stock sheet$/),
  };
  for (const [k, i] of Object.entries(cols)) if (i < 0) throw new Error(`Column "${k}" not found in the FC Stock sheet header.`);
  const blocks: Block[] = [];
  head.forEach((h, c) => { const d = blockDate(h); if (d) blocks.push({ date: d, col: c, ...blockLayout(rows[1] ?? [], c, head) }); });
  if (!blocks.length) throw new Error('No "Stock as on DD.MM.YYYY" columns found in the FC Stock sheet.');
  blocks.sort((a, b) => (a.date < b.date ? 1 : -1));
  const complete = blocks.filter((b) => !b.incomplete);
  const kept = complete.slice(0, dailyDays);
  // warn about a cut-off block only when it falls inside what is being read (all of history = the import)
  const oldestRead = kept.length === complete.length ? "" : kept[kept.length - 1]?.date ?? "";
  for (const b of blocks.filter((x) => x.incomplete && x.date >= oldestRead)) {
    warnings.push(`Skipped "Stock as on ${b.date.split("-").reverse().join(".")}": only ${b.incomplete} columns (no Stock Out / stock count).`);
  }
  const snapshotDate = kept[0].date;

  const discontinued = new Set(discontinuedRows.slice(1).map((r) => productKey(r[0])).filter(Boolean));
  const byProduct = new Map<string, GodownProduct>();
  const daily = new Map<string, GodownDay>();
  for (const r of rows.slice(2)) {
    const name = String(r[masterCol] ?? "").trim();
    const key = productKey(name);
    if (!key || key === "0") continue; // section headings / rows with no master product
    const p = byProduct.get(key) ?? {
      product: name, currentStock: 0, inboundShipped: 0, unfulfillable: 0, warehouse: 0, qcGodown: 0, packingGodown: 0,
      skuRows: 0, discontinued: discontinued.has(key),
    };
    p.inboundShipped += num(r[cols.inboundShipped]);
    p.unfulfillable += num(r[cols.unfulfillable]);
    p.warehouse += num(r[cols.warehouse]);
    p.qcGodown += num(r[cols.qc]);
    p.packingGodown += num(r[cols.packing]);
    p.currentStock = p.inboundShipped + p.unfulfillable + p.warehouse + p.qcGodown + p.packingGodown;
    p.skuRows++;
    byProduct.set(key, p);
    for (const b of kept) {
      const dk = `${b.date}|${key}`;
      const d = daily.get(dk) ?? { date: b.date, product: p.product, opening: 0, stockIn: 0, stockOut: 0, closing: 0 };
      const stockIn = num(r[b.col + b.inAt]), stockOut = num(r[b.col + b.outAt]), closing = num(r[b.col + b.closingAt]);
      // 3-column blocks have no Opening: derived as Closing − Stock IN + Stock Out.
      d.opening += b.openingAt === null ? closing - stockIn + stockOut : num(r[b.col + b.openingAt]);
      d.stockIn += stockIn;
      d.stockOut += stockOut;
      d.closing += closing;
      daily.set(dk, d);
    }
  }
  if (!byProduct.size) warnings.push("No product rows found (master product name column is empty).");
  return { snapshotDate, products: [...byProduct.values()], daily: [...daily.values()], warnings };
}

export interface ComponentRow {
  component: string;
  required: number | null; // stored "Required Component Quantity" (qty per unit × the product's RFQ)
  stock: number | null;    // stored "Current Stock" of the component
}

export interface ComponentNeed {
  component: string;
  required: number;
  stock: number;
  finalQty: number;
}

/** The tool's Components Sheet (build_stock_purchase_payload_v3): per component, Σ Required Component
 *  Quantity less max(Current Stock), never below 0; blanks count as 0, exactly as the tool does. */
export function componentNeeds(rows: ComponentRow[]): ComponentNeed[] {
  const by = new Map<string, ComponentNeed>();
  for (const r of rows) {
    const key = productKey(r.component);
    if (!key) continue;
    const c = by.get(key) ?? { component: r.component.trim(), required: 0, stock: 0, finalQty: 0 };
    c.required += r.required ?? 0;
    c.stock = Math.max(c.stock, r.stock ?? 0);
    by.set(key, c);
  }
  for (const c of by.values()) c.finalQty = Math.max(0, c.required - c.stock);
  return [...by.values()];
}

/** Monday (yyyy-mm-dd) of the week holding `iso`; weeks run Monday–Sunday. */
export function mondayOf(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Today's date in IST (the business day), yyyy-mm-dd. */
export const istToday = (now = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Rows of barm_weekly_rfq_snapshot / barm_weekly_component_snapshot (the Monday 10:00 IST copy). */
export interface WeeklyRfqRow { product: string; stock_intransit: unknown; order_placed: unknown; suggested_rfq: unknown }
export interface WeeklyComponentRow { component: string; required_qty: unknown; component_stock: unknown }

const numOrNull = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** The week's snapshot as restock inputs and combo needs (blank component stock counts as 0, as in the tool). */
export function weeklyInputs(rfq: WeeklyRfqRow[], components: WeeklyComponentRow[]): { inputs: RestockInput[]; combos: ComponentNeed[] } {
  return {
    inputs: rfq.map((r) => ({ product: String(r.product).trim(), stockIntransit: numOrNull(r.stock_intransit), orderPlaced: numOrNull(r.order_placed), purchaseQty: numOrNull(r.suggested_rfq) })),
    combos: componentNeeds(components.map((c) => ({ component: String(c.component ?? ""), required: numOrNull(c.required_qty), stock: numOrNull(c.component_stock) }))),
  };
}

// Restock inputs upload (user, 2026-10-14): the tool's own exports, given every Friday —
//   "Stock Purchase Sheet.xlsx"  Marketplace | Product | SKU ID | … | Stock intransit | Order placed | Suggested RFQ
//                                one row per SKU; the values are per product, repeated on each SKU row
//   "Components Sheet.xlsx"      Component | Product Entity | Quantities required | RFQ |
//                                Required Component Quantity | Current Stock | Final Components required quantity
// The kind is told by the headers. Rows come out in the Monday snapshot's shape, so weeklyInputs()
// turns either source into the same restock inputs and combo needs.
export type RestockUploadRow = WeeklyRfqRow & { product: string };
export type ComponentUploadRow = WeeklyComponentRow & { product: string | null; qty_per_unit: number | null; rfq: number | null };
export type RestockUpload =
  | { kind: "purchase"; rfq: RestockUploadRow[]; components: [] }
  | { kind: "components"; rfq: []; components: ComponentUploadRow[] };

const cleanName = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const headKey = (v: unknown) => cleanName(v).toLowerCase();

export function parseRestockRows(rows: unknown[][]): RestockUpload {
  for (let h = 0; h < Math.min(rows.length, 10); h++) {
    const head = (rows[h] ?? []).map(headKey);
    const at = (name: string) => head.indexOf(name);
    const body = rows.slice(h + 1);
    const [prod, transit, ordered, rfq] = [at("product"), at("stock intransit"), at("order placed"), at("suggested rfq")];
    if (prod >= 0 && transit >= 0 && ordered >= 0 && rfq >= 0) {
      const by = new Map<string, RestockUploadRow>();
      for (const r of body) {
        const product = cleanName(r[prod]);
        if (!product || by.has(productKey(product))) continue;
        by.set(productKey(product), { product, stock_intransit: numOrNull(r[transit]), order_placed: numOrNull(r[ordered]), suggested_rfq: numOrNull(r[rfq]) });
      }
      if (!by.size) throw new Error("Stock Purchase Sheet has no product rows.");
      return { kind: "purchase", rfq: [...by.values()], components: [] };
    }
    const [comp, entity, per, crfq, req, stock] = [at("component"), at("product entity"), at("quantities required"), at("rfq"), at("required component quantity"), at("current stock")];
    if (comp >= 0 && req >= 0 && stock >= 0) {
      const components = body.filter((r) => cleanName(r[comp])).map((r) => ({
        component: cleanName(r[comp]), product: entity >= 0 ? cleanName(r[entity]) || null : null,
        qty_per_unit: per >= 0 ? numOrNull(r[per]) : null, rfq: crfq >= 0 ? numOrNull(r[crfq]) : null,
        required_qty: numOrNull(r[req]), component_stock: numOrNull(r[stock]),
      }));
      if (!components.length) throw new Error("Components Sheet has no product rows.");
      return { kind: "components", rfq: [], components };
    }
  }
  throw new Error('Not a restock file — upload the tool\'s "Stock Purchase Sheet.xlsx" or "Components Sheet.xlsx".');
}

/** Newest wins (user, 2026-10-14): the Friday upload until the next Monday snapshot is captured. */
export function newerRestockSource(snapshot: { capturedAt: string | null } | null, upload: { uploadedAt: string } | null): "snapshot" | "upload" | null {
  const snapAt = snapshot?.capturedAt ? Date.parse(snapshot.capturedAt) : null;
  if (!upload) return snapAt !== null ? "snapshot" : null;
  return snapAt !== null && snapAt > Date.parse(upload.uploadedAt) ? "snapshot" : "upload";
}

/** The 10 latest dates with data, oldest first (DAY 10 … DAY 1). */
export function lastDates(daily: { date: string }[], n = CONSOLIDATED_DAYS): string[] {
  return [...new Set(daily.map((d) => d.date))].sort().slice(-n);
}

export function buildConsolidated(
  products: GodownProduct[],
  daily: { date: string; product: string; stockOut: number }[],
  inputs: RestockInput[] = [],
  n = CONSOLIDATED_DAYS,
  combos: ComponentNeed[] = [],
): { dates: string[]; rows: ConsolidatedRow[] } {
  const dates = lastDates(daily, n);
  const out = new Map<string, number>();
  for (const d of daily) out.set(`${d.date}|${productKey(d.product)}`, (out.get(`${d.date}|${productKey(d.product)}`) ?? 0) + num(d.stockOut));
  const inputBy = new Map(inputs.map((i) => [productKey(i.product), i]));
  const comboBy = new Map(combos.map((c) => [productKey(c.component), c.finalQty]));
  // Peak sales (user, 2026-10-13): the best single day over all days given, not just the last 10.
  const peak = new Map<string, { qty: number; date: string }>();
  for (const [k, qty] of out) {
    if (qty <= 0) continue;
    const [date, key] = [k.slice(0, 10), k.slice(11)];
    const p = peak.get(key);
    if (!p || qty > p.qty || (qty === p.qty && date > p.date)) peak.set(key, { qty, date });
  }
  const rows = products.map((p) => {
    const key = productKey(p.product);
    const days = dates.map((d) => (out.has(`${d}|${key}`) ? out.get(`${d}|${key}`)! : null));
    const avg = days.reduce<number>((a, v) => a + (v ?? 0), 0) / n;
    const inp = inputBy.get(key);
    const intransit = inp?.stockIntransit ?? null;
    const ordered = inp?.orderPlaced ?? null;
    const need180 = avg * 180;
    const qty = need180 - (p.currentStock + (intransit ?? 0) + (ordered ?? 0));
    const purchase = inp?.purchaseQty ?? null;
    return {
      product: p.product, days, avgPerDay: avg, need180, need90: avg * 90, need45: avg * 45,
      currentStock: p.currentStock, stockIntransit: intransit, orderPlaced: ordered,
      qtyToRestock: qty, purchaseQty: purchase, finalQtyToRestock: Math.max(qty, purchase ?? 0, 0), comboQty: comboBy.get(key) ?? null,
      peakQty: peak.get(key)?.qty ?? null, peakDate: peak.get(key)?.date ?? null,
      daysOfStock: avg > 0 ? p.currentStock / avg : null, discontinued: p.discontinued,
    };
  });
  return { dates, rows };
}

/** Selling, and the stock lasts under RUNNING_OUT_DAYS days. Soonest first. */
export const runningOut = (rows: ConsolidatedRow[], limit = RUNNING_OUT_DAYS) =>
  rows.filter((r) => r.daysOfStock !== null && r.daysOfStock < limit).sort((a, b) => (a.daysOfStock as number) - (b.daysOfStock as number));

/** Shipped less each day for the last 3 days: DAY 3 > DAY 2 > DAY 1. */
export const salesDropped = (rows: ConsolidatedRow[]) =>
  rows.filter((r) => { const [d3, d2, d1] = r.days.slice(-3).map((v) => v ?? 0); return r.days.length >= 3 && d3 > d2 && d2 > d1; });

/** No sales list leaves out products holding fewer than this many units (user, 2026-10-14). */
export const NO_SALES_MIN_STOCK = 5;

/** Nothing shipped in any of the days, at least NO_SALES_MIN_STOCK in stock, not discontinued. Most stock first. */
export const noSales = (rows: ConsolidatedRow[]) =>
  rows.filter((r) => !r.discontinued && r.currentStock >= NO_SALES_MIN_STOCK && r.days.every((v) => !v)).sort((a, b) => b.currentStock - a.currentStock);
