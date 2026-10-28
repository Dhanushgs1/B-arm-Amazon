// State normalisation for the Historical Analysis report's state-level demand vs. stock summary.
//
// Two sources feed the state rows, and neither is clean on its own:
//   - Order ship-state (Amazon orders export) carries free-text state names: canonical names,
//     abbreviations (MH, GJ, RJ, AP, JH, MP, UP), missing spaces (TAMILNADU) and
//     alternative spellings of a union territory (PUDUCHERRY (UT), NEW DELHI).
//   - FBA stock is keyed by fulfilment-centre code and mapped to a state by fcToState
//     (analysisReportExport.ts). VSNC is an FC code with no geography, so it is not a state.
//
// Canonical names below match the state names that appear in the order data. Every alias
// is listed here so the mapping is reviewable in one place.

/** Upper-cased raw ship-state (after trim) → canonical state name. */
export const STATE_ALIASES: Record<string, string> = {
  // Abbreviations
  TN: "TAMIL NADU",
  WB: "WEST BENGAL",
  DL: "DELHI",
  UP: "UTTAR PRADESH",
  "U.P.": "UTTAR PRADESH",
  MP: "MADHYA PRADESH",
  BR: "BIHAR",
  AR: "ARUNACHAL PRADESH",
  TG: "TELANGANA",
  MH: "MAHARASHTRA",
  GJ: "GUJARAT",
  RJ: "RAJASTHAN",
  AP: "ANDHRA PRADESH",
  JH: "JHARKHAND",
  // Missing spaces
  TAMILNADU: "TAMIL NADU",
  WESTBENGAL: "WEST BENGAL",
  // Misspellings
  TELENGANA: "TELANGANA",
  HARAYANA: "HARYANA",
  CHATTISGARH: "CHHATTISGARH",
  // Union territories and duplicate forms of one geography
  "NEW DELHI": "DELHI",
  "PUDUCHERRY (UT)": "PUDUCHERRY",
  PONDICHERRY: "PUDUCHERRY",
  "U.T. PUDUCHERRY": "PUDUCHERRY",
};

/** Fulfilment-centre codes that are not geographic. Their stock is reported separately, never as a state. */
export const NON_STATE_LOCATIONS = new Set<string>(["VSNC"]);

/** Canonical state name for a raw ship-state; unknown values are returned upper-cased and trimmed. */
export function normalizeShipState(raw: string): string {
  const key = String(raw || "").trim().replace(/\s+/g, " ").toUpperCase();
  return STATE_ALIASES[key] || key;
}

/** True when an FC-derived "state" is really a fulfilment-centre code and must not be treated as a state. */
export function isNonStateLocation(label: string): boolean {
  return NON_STATE_LOCATIONS.has(String(label || "").trim().toUpperCase());
}
