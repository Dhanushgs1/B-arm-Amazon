// Which Meesho data a sheet (or CSV) holds, from its own column headers — kept dependency-free so it
// can be unit tested directly. The Meesho Upload page has ONE card: any Meesho file dropped there is
// split sheet by sheet into the right table (meeshoReportUpload.ts's uploadMeeshoFile):
//
//   Ads export          (Date, Campaign name, SKU ID, Spend, …)          -> barm_meesho_ads
//   Orders sheet / CSV  (Reason for Credit Entry, Sub Order No, …)       -> barm_meesho_orders
//   Returns sheet / CSV (Suborder Number, Return Created Date, …)        -> barm_meesho_returns
//
// Headers decide the kind, so sheet order and sheet names don't matter. The sheet (or file) name
// is only used for a return's stage — "Returns Delivered", "Meesho return intransit …" — since a
// returns sheet's columns don't say which stage it lists.

import type { MeeshoReturnStage } from "./meeshoReturnRules.ts";

export type MeeshoSheetKind = { kind: "ads" } | { kind: "orders" } | { kind: "returns"; stage: MeeshoReturnStage };

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Return stage named in a sheet or file name, or null when the name doesn't say. */
export function returnStageFromName(name: string): MeeshoReturnStage | null {
  const s = norm(name).replace(/[_-]+/g, " ");
  // "Out for Delivery" before "Delivered" — it contains "deliver" too.
  if (/\bofd\b/.test(s) || s.includes("out for deliver")) return "Out for Delivery";
  if (s.includes("deliver")) return "Delivered";
  if (s.includes("transit")) return "In Transit";
  return null;
}

export function classifyMeeshoSheet(name: string, headers: unknown[]): MeeshoSheetKind | null {
  const h = new Set(headers.map(norm));
  if (h.has("suborder number") && h.has("return created date")) {
    // A returns file whose name gives no stage is filed as In Transit — the earliest stage, so the
    // same suborder seen later on a Delivered sheet still moves forward (dedupeReturnsByStage).
    return { kind: "returns", stage: returnStageFromName(name) ?? "In Transit" };
  }
  if (h.has("sub order no")) return { kind: "orders" };
  if (h.has("campaign name") && h.has("spend")) return { kind: "ads" };
  return null;
}
