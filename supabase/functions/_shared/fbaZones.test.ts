import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { shipStateToZone, fcToZone } from "./fbaZones.ts";

Deno.test("shipStateToZone matches known states case/whitespace-insensitively", () => {
  assertEquals(shipStateToZone("Maharashtra"), "Maharashtra_zone");
  assertEquals(shipStateToZone("  tn "), "Tamilnadu_zone");
  assertEquals(shipStateToZone("KARNATAKA"), "Karnataka_zone");
  assertEquals(shipStateToZone("Chhattisgarh"), "Nagpur_zone");
  assertEquals(shipStateToZone("Jammu & Kashmir"), "Punjab_zone");
});

// Real 30-day orders export (172922020719.txt) carried both of these; the
// manual formula's exact-match list dropped them to "Unknown".
Deno.test("shipStateToZone maps the '&' spelling of Dadra and Nagar Haveli", () => {
  assertEquals(shipStateToZone("DADRA & NAGAR HAVELI"), "Maharashtra_zone");
});

Deno.test("shipStateToZone reads a known state out of a comma-separated address", () => {
  assertEquals(shipStateToZone("ALAPPUZHA, KERALA, INDIA"), "Karnataka_zone");
  assertEquals(shipStateToZone("Somewhere, Atlantis"), "Unknown");
});

Deno.test("shipStateToZone falls back to Unknown for an unrecognized state", () => {
  assertEquals(shipStateToZone("Atlantis"), "Unknown");
  assertEquals(shipStateToZone(""), "Unknown");
});

Deno.test("fcToZone matches known fulfillment-center codes", () => {
  assertEquals(fcToZone("BLR"), "Karnataka_zone");
  assertEquals(fcToZone("hyd3"), "Telangana_zone");
  assertEquals(fcToZone("BOM7"), "Maharashtra_zone");
  assertEquals(fcToZone("PAX"), "bihar_zone");
});

// Real FBA_stock export (172544020718.csv) carries these 3-letter-prefix
// facilities with a per-dock numeric suffix, not the bare code — confirmed
// bug: 947 of that file's ~2,005 rows fell through to VSNC before the
// prefix-match fix below existed.
Deno.test("fcToZone matches suffixed real-world FC codes by their 3-letter facility prefix", () => {
  assertEquals(fcToZone("GAX1"), "Assam_zone");
  assertEquals(fcToZone("BLR7"), "Karnataka_zone");
  assertEquals(fcToZone("BLR8"), "Karnataka_zone");
  assertEquals(fcToZone("AMD2"), "gujarat_zone");
  assertEquals(fcToZone("CCX1"), "WestBengal_zone");
  assertEquals(fcToZone("CCX2"), "WestBengal_zone");
  assertEquals(fcToZone("PAX1"), "bihar_zone");
  assertEquals(fcToZone("BBX1"), "Odisha_zone");
  assertEquals(fcToZone("DEL2"), "Delhi_zone");
  assertEquals(fcToZone("DEL4"), "Delhi_zone");
  assertEquals(fcToZone("DEL5"), "Delhi_zone");
  assertEquals(fcToZone("DED4"), "Delhi_zone");
  assertEquals(fcToZone("JPX1"), "Rajasthan_zone");
  assertEquals(fcToZone("JPX2"), "Rajasthan_zone");
});

// The 4-character codes must stay exact-match — they're already fully
// distinguishing tokens, not a prefix+suffix pair, so a 3-char slice must
// never accidentally match one of the prefix-matched zones above.
Deno.test("fcToZone keeps 4-character codes as exact matches, not 3-char prefixes", () => {
  assertEquals(fcToZone("CJB1"), "Tamilnadu_zone");
  assertEquals(fcToZone("MAA4"), "Tamilnadu_zone");
  assertEquals(fcToZone("BOM5"), "Maharashtra_zone");
  assertEquals(fcToZone("LKO1"), "Uttarpradesh_zone");
  assertEquals(fcToZone("NAX1"), "Nagpur_zone");
  assertEquals(fcToZone("ATX1"), "Punjab_zone");
});

Deno.test("fcToZone falls back to VSNC for an unrecognized code", () => {
  assertEquals(fcToZone("ZZZ9"), "VSNC");
  assertEquals(fcToZone("VSNC"), "VSNC");
});
