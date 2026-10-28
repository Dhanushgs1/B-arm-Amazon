import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShipState, isNonStateLocation, STATE_ALIASES } from "./historicalStateRules.ts";

test("abbreviations map to canonical state names", () => {
  assert.equal(normalizeShipState("MH"), "MAHARASHTRA");
  assert.equal(normalizeShipState("GJ"), "GUJARAT");
  assert.equal(normalizeShipState("RJ"), "RAJASTHAN");
  assert.equal(normalizeShipState("AP"), "ANDHRA PRADESH");
  assert.equal(normalizeShipState("JH"), "JHARKHAND");
  assert.equal(normalizeShipState("UP"), "UTTAR PRADESH");
  assert.equal(normalizeShipState("MP"), "MADHYA PRADESH");
});

test("PUDUCHERRY and PUDUCHERRY (UT) become one state", () => {
  assert.equal(normalizeShipState("PUDUCHERRY"), "PUDUCHERRY");
  assert.equal(normalizeShipState("PUDUCHERRY (UT)"), "PUDUCHERRY");
  assert.equal(normalizeShipState("Pondicherry"), "PUDUCHERRY");
});

test("NEW DELHI and DELHI become one state", () => {
  assert.equal(normalizeShipState("NEW DELHI"), "DELHI");
  assert.equal(normalizeShipState("DELHI"), "DELHI");
  assert.equal(normalizeShipState("DL"), "DELHI");
});

test("missing-space and misspelt forms map to canonical names", () => {
  assert.equal(normalizeShipState("TAMILNADU"), "TAMIL NADU");
  assert.equal(normalizeShipState("WESTBENGAL"), "WEST BENGAL");
  assert.equal(normalizeShipState("TELENGANA"), "TELANGANA");
  assert.equal(normalizeShipState("HARAYANA"), "HARYANA");
  assert.equal(normalizeShipState("CHATTISGARH"), "CHHATTISGARH");
});

test("whitespace and case are normalised before lookup", () => {
  assert.equal(normalizeShipState("  new   delhi "), "DELHI");
  assert.equal(normalizeShipState("maharashtra"), "MAHARASHTRA");
});

test("unknown states pass through upper-cased and trimmed", () => {
  assert.equal(normalizeShipState("  Goa "), "GOA");
  assert.equal(normalizeShipState(""), "");
});

test("VSNC is a fulfilment-centre code, not a state", () => {
  assert.equal(isNonStateLocation("VSNC"), true);
  assert.equal(isNonStateLocation(" vsnc "), true);
  assert.equal(isNonStateLocation("TAMIL NADU"), false);
  assert.equal(isNonStateLocation("KERALA"), false);
});

test("every alias target is a canonical name that is not itself an alias", () => {
  for (const target of Object.values(STATE_ALIASES)) {
    assert.equal(STATE_ALIASES[target], undefined, `${target} should be canonical`);
  }
});
