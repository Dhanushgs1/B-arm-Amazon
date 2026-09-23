// Zone-mapping lookups reverse-engineered from the live formulas in the
// user's real "FBA_forecast sheet(30 days).xlsx": ship-state -> zone (from
// 30_days_sales!G2's nested IF formula) and FC -> zone (from the
// barm-fba-forecast-refresh skill, matching FBA_stock!H2's IFS formula).
// Two independent mappings because sales rows carry a ship-state and
// stock/booked/intransit/active rows carry a fulfillment-center code
// instead. See docs/superpowers/specs/2026-09-22-fba-forecast-refresh-
// design.md for the full source tables. Pure, no I/O — do not modify these
// mappings without re-confirming against the live workbook.

const SHIP_STATE_ZONES: Array<{ zone: string; states: string[] }> = [
  { zone: "Tamilnadu_zone", states: ["TAMILNADU", "TAMIL NADU", "TN", "PALGHAT", "ANDAMAN & NICOBAR ISLANDS", "ANDAMAN ISLANDS", "AN", "PUDUCHERRY"] },
  { zone: "Karnataka_zone", states: ["KARNATAKA", "KA", "GOA", "GA", "LAKSHWADEEP", "LAKSHADWEEP", "KERALA", "KL"] },
  { zone: "Telangana_zone", states: ["TELANGANA", "TELENGANA", "TG", "ANDHRA PRADESH", "ANDHRAPRADESH", "AP", "ANDHARA PRADESH"] },
  { zone: "Maharashtra_zone", states: ["MAHARASHTRA", "MAHARASTRA", "MH", "DADRA AND NAGAR HAVELI AND DAMAN AND DIU", "DAMAN & DIU", "DADRA AND NAGAR HAVELI"] },
  { zone: "gujarat_zone", states: ["GUJARAT", "GUJRAT", "GJ"] },
  { zone: "Nagpur_zone", states: ["MADHYA PRADESH", "MADHYAPRADESH", "MP", "CHHATTISGARH", "CHATTISGARH", "CG"] },
  { zone: "Rajasthan_zone", states: ["RAJASTHAN", "RJ"] },
  { zone: "Uttarpradesh_zone", states: ["UTTAR PRADESH", "UTTARPRADESH", "UTARPRADESH", "UP"] },
  { zone: "bihar_zone", states: ["BIHAR", "BR", "JHARKHAND", "JH"] },
  { zone: "Delhi_zone", states: ["DELHI", "NEW DELHI", "DL", "UTTARAKHAND", "UK", "UTTRAKHAND", "HARYANA", "HARAYANA", "HR"] },
  { zone: "WestBengal_zone", states: ["WEST BENGAL", "WESTBENGAL", "WB"] },
  { zone: "Odisha_zone", states: ["ODISHA", "ORISSA", "OR"] },
  { zone: "Assam_zone", states: ["ASSAM", "AS", "ARUNACHAL PRADESH", "AR", "MANIPUR", "MN", "MEGHALAYA", "ML", "MIZORAM", "MZ", "NAGALAND", "NL", "SIKKIM", "SK", "TRIPURA", "TR"] },
  { zone: "Punjab_zone", states: ["PUNJAB", "PB", "HIMACHAL PRADESH", "HIMACHALPRADESH", "HP", "JAMMU & KASHMIR", "JAMMU AND KASHMIR", "JAMMU KASHMIR", "JK", "LADAKH", "LA", "CHANDIGARH"] },
];

/** Ship-state (e.g. "Maharashtra", "TN") -> zone. Matches the exact
 *  nested-IF formula in the user's live 30_days_sales!G column: upper-cased
 *  and trimmed before matching. Returns "Unknown" for anything unrecognized,
 *  same as the formula's final else-branch. */
export function shipStateToZone(state: string): string {
  const normalized = state.trim().toUpperCase();
  for (const { zone, states } of SHIP_STATE_ZONES) {
    if (states.includes(normalized)) return zone;
  }
  return "Unknown";
}

// Codes that are their own complete, distinguishing token (4+ characters,
// e.g. two different Maharashtra codes BOM5/BOM7) — matched by full
// equality, never truncated.
const FC_ZONES_EXACT: Array<{ zone: string; codes: string[] }> = [
  { zone: "Tamilnadu_zone", codes: ["CJB1", "MAA4"] },
  { zone: "Maharashtra_zone", codes: ["BOM5", "BOM7", "ISK3", "PNQ3"] },
  { zone: "Uttarpradesh_zone", codes: ["LKO1"] },
  { zone: "Nagpur_zone", codes: ["NAX1"] },
  { zone: "Telangana_zone", codes: ["HYD3", "HYD8"] },
  { zone: "Punjab_zone", codes: ["ATX1", "LDX1"] },
];

// Codes matched by their first 3 characters ("LEFT(FC,3)" per the skill's
// own formula description), because the real data carries these as a
// 3-letter facility prefix plus a variable numeric suffix identifying a
// specific dock/bay at that facility — e.g. the real FBA_stock export has
// GAX1, BLR7, BLR8, AMD2, CCX1, CCX2, PAX1, BBX1, DEL2/DEL4/DEL5, JPX1/JPX2,
// DED4, none of which match a bare "GAX"/"BLR"/etc. by exact equality. This
// was found as a real bug (confirmed against 172544020718.csv): 947 of that
// file's ~2,005 rows carried a suffixed code and fell through to the VSNC
// catch-all before this fix, incorrectly reporting stock as "unzoned".
const FC_ZONES_PREFIX: Array<{ zone: string; prefixes: string[] }> = [
  { zone: "Karnataka_zone", prefixes: ["BLR"] },
  { zone: "WestBengal_zone", prefixes: ["CCX"] },
  { zone: "Assam_zone", prefixes: ["GAX"] },
  { zone: "Delhi_zone", prefixes: ["DED", "DEL"] },
  { zone: "Rajasthan_zone", prefixes: ["JPX"] },
  { zone: "Odisha_zone", prefixes: ["BBX"] },
  { zone: "bihar_zone", prefixes: ["PAX"] },
  { zone: "gujarat_zone", prefixes: ["AMD"] },
];

/** Fulfillment-center code (e.g. "BLR7", "HYD3") -> zone. Matches the
 *  FC->zone IFS formula documented in the barm-fba-forecast-refresh skill
 *  (the same formula the live FBA_stock!H column and the booked/intransit/
 *  recently_act "zone" columns all use) — "matches LEFT(FC,3) or exact FC
 *  codes" per the skill's own wording, hence the two-tier lookup below. The
 *  literal fallback for an unrecognized code is "VSNC" — that IS the
 *  formula's own final else-branch output, not a typo; it's unrelated to
 *  the separate ingestion rule (applied in fbaForecastRules.ts on the
 *  client, not here) that drops stock rows where the FC *itself* is
 *  literally "VSNC". */
export function fcToZone(fc: string): string {
  const normalized = fc.trim().toUpperCase();
  for (const { zone, codes } of FC_ZONES_EXACT) {
    if (codes.includes(normalized)) return zone;
  }
  const prefix3 = normalized.slice(0, 3);
  for (const { zone, prefixes } of FC_ZONES_PREFIX) {
    if (prefixes.includes(prefix3)) return zone;
  }
  return "VSNC";
}
