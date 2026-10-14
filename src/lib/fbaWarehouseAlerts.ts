// FBA inventory-based ad status alert — Live Inventory (SellerMate) stock per SKU, evaluated over the
// complete list of eligible FBA FCs at once, never one warehouse in isolation.
//
// Client rule (2026-10-09), applied as written:
//   1. Only FCs marked "Yes" in "FBA warehouse details.xlsx" are eligible ("No" / "In progress" / not
//      in the sheet at all, e.g. VSNC, are not).
//   2. "Has stock" = more than 0 units in that FC.
//   3. Fewer than 8 eligible FCs have stock                          → alert ("fewFcs").
//   4. 8 or more have stock, but any of them holds 20 units or less  → alert ("lowUnits").
//   No alert only when 8+ FCs have stock and every FC with stock holds more than 20 units.
//
// Missing data is never assumed to be zero stock. Per eligible FC a SKU's stock is:
//   known       — a ledger row with known units on the snapshot date;
//   confirmed 0 — no ledger row, but the data is complete: the SKU has rows in the current snapshot
//                 AND the FC itself appears in that snapshot (so SellerMate did report that warehouse);
//   unknown     — a row with unknown units, a row older than the snapshot, or an FC absent from the
//                 snapshot. Excluded from the calculation and listed.
// The verdict is taken from known data only when the unknown FCs cannot change it; otherwise the
// SKU is "undetermined". SKU-level data issues: "noData" (no current row anywhere — not evaluated),
// "undetermined", "partialData" (unknown FCs that cannot change the verdict). noData and
// undetermined are data-quality warnings, kept apart from stock alerts.
//
// Notifications are transition-based (state in barm_alert_state, entity_id = SKU): a SKU is mailed
// when it starts failing, and again only after it has been seen passing and then fails again. Data
// warnings work the same way under their own alert_type. Source: SellerMate's warehouse-wise ledger
// balance (src/lib/sellerMateLiveInventory.ts), a daily snapshot, so this is a daily check.

import type { LiveProduct } from "./sellerMateLiveInventory.ts";

/** A SKU needs stock (> 0 units) in at least this many eligible FCs. */
export const FBA_ALERT_MIN_FCS = 8;
/** Every FC with stock must hold more than this many units. */
export const FBA_ALERT_THRESHOLD = 20;
/** The SellerMate snapshot may be at most this many days older than the run date. SellerMate's
 *  ledger normally lands 1–2 days behind; older than this is treated as stale and not evaluated. */
export const FBA_ALERT_MAX_SNAPSHOT_AGE_DAYS = 3;

// The FCs marked "Yes" in the seller's "FBA warehouse details.xlsx" (2026-10-09). FCs marked "No"
// (DEL2, BLR5, BOM4, the S*/X* H&B and MPS sites…), "In progress" (COX1 Ernakulam, RJX1
// Visakhapatnam) and codes not in the sheet (VSNC) are not eligible until the sheet says Yes.
export const FBA_ALERT_FCS: { code: string; region: string }[] = [
  { code: "DEL4", region: "Gurgaon (Delhi)" },
  { code: "DEL5", region: "Gurgaon (Delhi)" },
  { code: "ATX1", region: "Ludhiana (Punjab)" },
  { code: "JPX1", region: "Jaipur (Rajasthan)" },
  { code: "LKO1", region: "Lucknow (Uttar Pradesh)" },
  { code: "DED4", region: "Gurugram (Delhi)" },
  { code: "JPX2", region: "Bagru (Rajasthan)" },
  { code: "LDX1", region: "Rajpura (Punjab)" },
  { code: "BOM7", region: "Bhiwandi (Mumbai)" },
  { code: "BOM5", region: "Bhiwandi (Mumbai)" },
  { code: "PNQ3", region: "Pune (Mumbai)" },
  { code: "AMD2", region: "Ahmedabad (Gujarat)" },
  { code: "NAX1", region: "Nagpur (Mumbai)" },
  { code: "CCX1", region: "Howrah (West Bengal)" },
  { code: "CCX2", region: "Kolkata (West Bengal)" },
  { code: "GAX1", region: "Guwahati (Assam)" },
  { code: "PAX1", region: "Patna (Bihar)" },
  { code: "BBX1", region: "Bhubaneswar (Odisha)" },
  { code: "BLR7", region: "Bangalore" },
  { code: "BLR8", region: "Bangalore" },
  { code: "MAA4", region: "Chennai" },
  { code: "HYD8", region: "Hyderabad" },
  { code: "HYD3", region: "Hyderabad" },
  { code: "CJB1", region: "Coimbatore" },
];

export const ELIGIBLE_FCS: ReadonlySet<string> = new Set(FBA_ALERT_FCS.map((f) => f.code));

const norm = (location: string) => (location || "").trim().toUpperCase();

/** Normalised FC code if it is an eligible ("Yes") FC, else null. */
export function eligibleFc(location: string, eligible: ReadonlySet<string> = ELIGIBLE_FCS): string | null {
  const up = norm(location);
  return eligible.has(up) ? up : null;
}

export interface LedgerSnapshot {
  /** Latest as-of date across all ledger rows; null when no row carries a date. */
  date: string | null;
  /** FCs with at least one known-units row on `date` — the warehouses SellerMate reported. */
  fcs: ReadonlySet<string>;
}

/** The current ledger snapshot: its date and which warehouses it covers. */
export function ledgerSnapshot(products: LiveProduct[]): LedgerSnapshot {
  let date: string | null = null;
  for (const p of products) for (const s of p.skus) for (const w of s.warehouses) if (w.asOfDate && (!date || w.asOfDate > date)) date = w.asOfDate;
  const fcs = new Set<string>();
  for (const p of products) for (const s of p.skus) for (const w of s.warehouses) {
    if (w.units !== null && (date === null || w.asOfDate === date)) fcs.add(norm(w.location));
  }
  return { date, fcs };
}

/** Whole days between the snapshot date and `today` (YYYY-MM-DD); null when there is no date. */
export function snapshotAgeDays(snapshot: LedgerSnapshot, today: string): number | null {
  if (!snapshot.date) return null;
  return Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(snapshot.date + "T00:00:00Z")) / 86_400_000);
}

export interface FcStock { fc: string; units: number }

export interface SkuCoverage {
  sku: string;
  asin: string;
  title: string | null;
  channel: "FBA" | "MFN" | null;
  /** Eligible FCs with stock (> 0 units, known), most stock first. */
  stocked: FcStock[];
  /** The stocked FCs at or below the threshold, lowest first — the affected FCs for "lowUnits". */
  low: FcStock[];
  /** Eligible FCs with confirmed 0 stock (a 0 row, or no row while the snapshot covers the FC). */
  zeroFcs: string[];
  /** Eligible FCs whose stock is unknown (missing / stale / unreported data) — excluded. */
  unknownFcs: string[];
  /** Stock in this snapshot at locations outside the eligible list (e.g. VSNC), most first. Not part
   *  of the rule — shown so a product with stock only there is not reported as "out of stock". */
  elsewhere: FcStock[];
  totalUnits: number;
  dataIssue: "noData" | "undetermined" | "partialData" | null;
  /** true = passes. false = failing (reason set) or not decidable (dataIssue noData / undetermined). */
  ok: boolean;
  /** fewFcs: fewer than minFcs FCs have stock. lowUnits: minFcs+ have stock, one or more ≤ threshold. */
  reason: "fewFcs" | "lowUnits" | null;
}

/** One verdict per SKU over the complete eligible FC list. A SKU listed under several ASINs is
 *  merged (state and the mail are per SKU). MFN SKUs with no FBA ledger rows are out of scope and
 *  not returned; every other SKU is returned. */
export function skuCoverage(
  products: LiveProduct[],
  threshold = FBA_ALERT_THRESHOLD,
  minFcs = FBA_ALERT_MIN_FCS,
  eligible: ReadonlySet<string> = ELIGIBLE_FCS,
  snapshot: LedgerSnapshot = ledgerSnapshot(products),
): SkuCoverage[] {
  type Acc = { sku: string; asin: string; title: string | null; channel: "FBA" | "MFN" | null; whs: { location: string; units: number | null; asOfDate: string | null }[] };
  const bySku = new Map<string, Acc>();
  for (const p of products) for (const s of p.skus) {
    let a = bySku.get(s.sku);
    if (!a) { a = { sku: s.sku, asin: p.asin, title: p.title, channel: s.channel, whs: [] }; bySku.set(s.sku, a); }
    if (s.warehouses.length && !a.whs.length) { a.asin = p.asin; a.title = p.title; } // prefer the ASIN holding the stock
    a.channel = a.channel ?? s.channel;
    a.whs.push(...s.warehouses);
  }
  const current = (w: { units: number | null; asOfDate: string | null }) => w.units !== null && (snapshot.date === null || w.asOfDate === snapshot.date);

  const out: SkuCoverage[] = [];
  for (const a of bySku.values()) {
    if (!a.whs.length && a.channel === "MFN") continue; // merchant-fulfilled, never had FBA stock: out of scope
    const base = { sku: a.sku, asin: a.asin, title: a.title, channel: a.channel };
    const inSnapshot = a.whs.some(current);
    if (!inSnapshot) {
      out.push({ ...base, stocked: [], low: [], zeroFcs: [], unknownFcs: [...eligible].sort(), elsewhere: [], totalUnits: 0, dataIssue: "noData", ok: false, reason: null });
      continue;
    }
    const known = new Map<string, number>();
    const stale = new Set<string>();
    const outside = new Map<string, number>();
    for (const w of a.whs) {
      const fc = eligibleFc(w.location, eligible);
      if (!fc) {
        if (current(w) && (w.units as number) > 0) outside.set(w.location, (outside.get(w.location) ?? 0) + (w.units as number));
        continue;
      }
      if (current(w)) known.set(fc, (known.get(fc) ?? 0) + (w.units as number));
      else stale.add(fc);
    }
    const stocked: FcStock[] = [];
    const zeroFcs: string[] = [];
    const unknownFcs: string[] = [];
    for (const fc of eligible) {
      if (known.has(fc)) {
        const units = known.get(fc)!;
        if (units > 0) stocked.push({ fc, units }); else zeroFcs.push(fc);
      } else if (!stale.has(fc) && snapshot.fcs.has(fc)) zeroFcs.push(fc); // SKU and FC both reported, no row: 0
      else unknownFcs.push(fc);
    }
    stocked.sort((x, y) => y.units - x.units || x.fc.localeCompare(y.fc));
    const low = stocked.filter((r) => r.units <= threshold).sort((x, y) => x.units - y.units || x.fc.localeCompare(y.fc));
    zeroFcs.sort();
    unknownFcs.sort();
    // Could the unknown FCs make this SKU pass? Only if no known stocked FC is low and the unknowns
    // (if all stocked above the threshold) would lift it to minFcs. If they could, and there are
    // unknowns, the verdict is undetermined; if they could not, known data decides.
    const couldPass = low.length === 0 && stocked.length + unknownFcs.length >= minFcs;
    const reason = couldPass ? null : stocked.length < minFcs ? "fewFcs" : "lowUnits";
    const undetermined = couldPass && unknownFcs.length > 0;
    out.push({
      ...base, stocked, low, zeroFcs, unknownFcs,
      elsewhere: [...outside].map(([fc, units]) => ({ fc, units })).sort((x, y) => y.units - x.units || x.fc.localeCompare(y.fc)),
      totalUnits: stocked.reduce((s, r) => s + r.units, 0),
      dataIssue: undetermined ? "undetermined" : unknownFcs.length ? "partialData" : null,
      ok: reason === null && !undetermined,
      reason,
    });
  }
  return out;
}

/** SKUs whose verdict cannot be decided from the data — reported as data-quality warnings. */
export const isDataGap = (c: SkuCoverage) => c.dataIssue === "noData" || c.dataIssue === "undetermined";

/** Transition detection. prior: SKU → true if it was flagged (and mailed) last time, false if last
 *  seen clear. Returns SKUs that newly became flagged, ones that cleared, and the still-flagged count.
 *  SKUs in `prior` but absent from `items` keep their state (absent ≠ recovered). */
export function findTransitions<T extends { sku: string }>(items: T[], prior: Map<string, boolean>, isFlagged: (x: T) => boolean) {
  const newlyFlagged: T[] = [];
  const cleared: T[] = [];
  let stillFlagged = 0;
  for (const x of items) {
    const was = prior.get(x.sku) === true;
    if (isFlagged(x)) { if (was) stillFlagged++; else newlyFlagged.push(x); }
    else if (was) cleared.push(x);
  }
  return { newlyFlagged, cleared, stillFlagged };
}

/** Stock-rule transitions over decidable SKUs only — a data-gap SKU neither fails nor recovers. */
export function findNewFailures(current: SkuCoverage[], prior: Map<string, boolean>) {
  const t = findTransitions(current.filter((c) => !isDataGap(c)), prior, (c) => c.reason !== null);
  // fewFcs before lowUnits, then fewest stocked FCs, then the emptiest.
  const failing = t.newlyFlagged.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === "fewFcs" ? -1 : 1)
    || a.stocked.length - b.stocked.length || a.totalUnits - b.totalUnits || a.sku.localeCompare(b.sku));
  return { failing, recovered: t.cleared, stillFailing: t.stillFlagged };
}

/** Data-quality transitions: SKUs that newly cannot be evaluated, and ones that became evaluable. */
export function findNewDataGaps(current: SkuCoverage[], prior: Map<string, boolean>) {
  const t = findTransitions(current, prior, isDataGap);
  return { newGaps: t.newlyFlagged.sort((a, b) => a.sku.localeCompare(b.sku)), resolved: t.cleared, stillMissing: t.stillFlagged };
}
