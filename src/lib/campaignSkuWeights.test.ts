import test from "node:test";
import assert from "node:assert/strict";
import {
  campaignShares, draftRowsFromStored, validateSkuWeightDraft, DEFAULT_NEW_WEIGHT,
  type SkuWeightDraftRow, type SkuWeightEntry,
} from "./campaignSkuWeights.ts";

const CHEWY_STORED: SkuWeightEntry[] = [
  { sku: "B-CT-G-8", weight: 1.5 },
  { sku: "B-CT-G-9", weight: 1.5 },
  { sku: "B-CT-R-1", weight: 1 },
  { sku: "B-CT-R-6", weight: 1 },
  { sku: "B-CT-R-7", weight: 1 },
  { sku: "B-CT-Y-1", weight: 1 },
  { sku: "B-CT-Y-3", weight: 1 },
  { sku: "B-CT-Y-6", weight: 1 },
];

/** Round to paise, as the report shows it. */
const paise = (v: number) => Math.round(v * 100) / 100;

/** Save path the editor takes: stored → draft rows → validate → entries to persist. */
function roundTrip(stored: SkuWeightEntry[]): SkuWeightEntry[] {
  const check = validateSkuWeightDraft(draftRowsFromStored(stored));
  assert.equal(check.ok, true);
  return check.ok ? check.entries : [];
}

test("existing weights survive editing and re-saving without changes", () => {
  assert.deepEqual(roundTrip(CHEWY_STORED), CHEWY_STORED);
  // Saving a second time from the saved state changes nothing either.
  assert.deepEqual(roundTrip(roundTrip(CHEWY_STORED)), CHEWY_STORED);
});

test("editing one SKU's weight keeps the other stored weights", () => {
  const rows: SkuWeightDraftRow[] = draftRowsFromStored([{ sku: "A", weight: 2 }, { sku: "B", weight: 0.5 }]);
  rows[1] = { ...rows[1], weight: "3" };
  const check = validateSkuWeightDraft(rows);
  assert.deepEqual(check, { ok: true, entries: [{ sku: "A", weight: 2 }, { sku: "B", weight: 3 }] });
});

test("a new SKU row defaults to weight 1", () => {
  assert.deepEqual(draftRowsFromStored([]), [{ sku: "", weight: DEFAULT_NEW_WEIGHT }]);
  assert.equal(DEFAULT_NEW_WEIGHT, "1");
});

test("new weights are persisted as typed, trimmed and numeric", () => {
  const check = validateSkuWeightDraft([
    { sku: "  B-CT-G-8 ", weight: " 1.5 " },
    { sku: "A015", weight: ".25" },
    { sku: "A006-2", weight: "4." },
  ]);
  assert.deepEqual(check, {
    ok: true,
    entries: [{ sku: "B-CT-G-8", weight: 1.5 }, { sku: "A015", weight: 0.25 }, { sku: "A006-2", weight: 4 }],
  });
});

test("blank trailing rows are ignored and no usable rows clears the mapping", () => {
  assert.deepEqual(
    validateSkuWeightDraft([{ sku: "A", weight: "1" }, { sku: "", weight: "" }]),
    { ok: true, entries: [{ sku: "A", weight: 1 }] },
  );
  assert.deepEqual(validateSkuWeightDraft([{ sku: "", weight: "" }]), { ok: true, entries: [] });
  assert.deepEqual(validateSkuWeightDraft([]), { ok: true, entries: [] });
});

test("invalid weights are rejected with a message naming the SKU", () => {
  for (const bad of ["", "   ", "abc", "0", "0.0", "-1", "-0.5", "1e3", "0x10", "1,5", "Infinity", "NaN", "1.2.3"]) {
    const check = validateSkuWeightDraft([{ sku: "B-CT-G-8", weight: bad }]);
    assert.equal(check.ok, false, `weight "${bad}" should be rejected`);
    if (!check.ok) assert.match(check.error, /B-CT-G-8/, `error for "${bad}" should name the SKU`);
  }
});

test("a SKU without a weight, or a weight without a SKU, is rejected", () => {
  const noWeight = validateSkuWeightDraft([{ sku: "B-CT-G-8", weight: "  " }]);
  assert.equal(noWeight.ok, false);
  const noSku = validateSkuWeightDraft([{ sku: "  ", weight: "2" }]);
  assert.equal(noSku.ok, false);
  if (!noSku.ok) assert.match(noSku.error, /Row 1/);
});

test("the same SKU listed twice is rejected before it can hit the unique key", () => {
  const check = validateSkuWeightDraft([{ sku: "A", weight: "1" }, { sku: " A ", weight: "2" }]);
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.error, /more than once/);
});

test("Chewy Tube Brand-ad: weights totalling 9 split ₹9,151.94 as ₹1,525.32 per 1.5 SKU and ₹1,016.88 per 1.0 SKU", () => {
  const spend = 9151.94;
  const shares = campaignShares(CHEWY_STORED);
  const amount = Object.fromEntries(shares.map((s) => [s.sku, paise(spend * s.share)]));
  assert.equal(amount["B-CT-G-8"], 1525.32);
  assert.equal(amount["B-CT-G-9"], 1525.32);
  for (const sku of ["B-CT-R-1", "B-CT-R-6", "B-CT-R-7", "B-CT-Y-1", "B-CT-Y-3", "B-CT-Y-6"]) {
    assert.equal(amount[sku], 1016.88, sku);
  }
  // Rounding: the eight rounded amounts can differ from the campaign total by a paisa or two.
  const total = Object.values(amount).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - spend) < 0.05, `allocated ${total} vs spend ${spend}`);
});

test("Speech-combo 35:65 allocation is unchanged", () => {
  const shares = campaignShares([{ sku: "B-SPEECH-COMBO-3HEADS", weight: 35 }, { sku: "B-SPEECH-COMBO-3HEADS-1", weight: 65 }]);
  const spend = 187.32;
  assert.equal(paise(spend * shares[0].share), 65.56);
  assert.equal(paise(spend * shares[1].share), 121.76);
});

test("campaignShares of nothing is empty and of equal weights is an equal split", () => {
  assert.deepEqual(campaignShares([]), []);
  assert.deepEqual(campaignShares([{ sku: "A", weight: 1 }, { sku: "B", weight: 1 }]).map((s) => s.share), [0.5, 0.5]);
});
