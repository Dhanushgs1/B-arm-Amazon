import test from "node:test";
import assert from "node:assert/strict";
import { ratingsDatasetForDisplay, ratingsProductColumns, ratingsSourceLine, ratingsUnavailable, isRealRatingsData } from "./ratingsExportRules.ts";

const product = (over: Record<string, unknown>) => ({ id: "p", name: "P", sku: "S", sales: 0, estimatedRevenueLost: 0, returnReasons: [], salesChangePct: 0, ...over });
const ds = (products: unknown[], source?: unknown) => ({ products, ratingTrend: [], categories: [], platforms: [], rootCause: [], executiveSummary: {}, ...(source ? { source } : {}) }) as never;

test("real data is displayed as-is: demo Sales/Revenue/return reasons never leak in", () => {
  const real = ds([product({ id: "real-1" })], { kind: "sheet", unavailable: ["Return reasons", "Revenue and revenue-at-risk"] });
  const demo = ds([product({ id: "demo-1", sales: 98765, estimatedRevenueLost: 4321, returnReasons: [{ reason: "Damaged", pct: 40 }], salesChangePct: 12 })]);
  const out = ratingsDatasetForDisplay(real, demo) as { products: { sales: number; estimatedRevenueLost: number; returnReasons: unknown[]; salesChangePct: number }[] };
  assert.equal(out.products[0].sales, 0);
  assert.equal(out.products[0].estimatedRevenueLost, 0);
  assert.deepEqual(out.products[0].returnReasons, []);
  assert.equal(out.products[0].salesChangePct, 0);
});

test("demo data is used only when no real dataset loaded, and is labelled as demo", () => {
  const demo = ds([product({ id: "demo-1" })]);
  const out = ratingsDatasetForDisplay(undefined, demo);
  assert.equal(out, demo);
  assert.equal(isRealRatingsData(out), false);
  assert.match(ratingsSourceLine(out), /^DEMO DATA/);
});

test("export columns: real data drops Sales and labels the change column as Orders Change %", () => {
  const real = ratingsProductColumns(true).map((c) => c.label);
  assert.ok(!real.includes("Sales"));
  assert.ok(real.includes("Orders Change %"));
  const demo = ratingsProductColumns(false).map((c) => c.label);
  assert.ok(demo.includes("Sales") && demo.includes("Sales Change %"));
});

test("real exports state the source and list what it cannot supply", () => {
  const real = ds([], { kind: "sheet", currentDate: "2026-09-21", unavailable: ["Return reasons"] });
  assert.equal(ratingsSourceLine(real), "Source: BARM weekly rating tracker, snapshot 2026-09-21.");
  assert.deepEqual(ratingsUnavailable(real), ["Return reasons"]);
  assert.deepEqual(ratingsUnavailable(ds([])), []);
});
