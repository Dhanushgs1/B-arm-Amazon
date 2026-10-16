import test from "node:test";
import assert from "node:assert/strict";
import { listingProblems, skuState } from "./listingCheck.ts";

const master = [
  { product: "Blades", sku: "BL-1", platform: "Amazon" },
  { product: "Blades", sku: "BL-2", platform: "Amazon\r\n" },
  { product: "Blades", sku: "BL-FK", platform: "Flipkart" },
  { product: "Brush", sku: "BR-1", platform: "Amazon" },
  { product: "Brush", sku: "BR-2", platform: "Amazon" },
  { product: "Pad", sku: "PD-1", platform: "Amazon" },
];

test("flagged only when every Amazon SKU is inactive or not on Amazon", () => {
  const catalog = new Map<string, unknown>([["BL-1", ["INACTIVE"]], ["BR-1", "SUPPRESSED"], ["BR-2", ["BUYABLE", "DISCOVERABLE"]], ["PD-1", "INACTIVE"]]);
  const { problems, noSku } = listingProblems(["blades", "Brush", "Pad", "Pad", "Unknown thing"], master, catalog);
  assert.deepEqual(problems.map((p) => [p.product, p.skus.map((s) => `${s.sku}:${s.state}`)]), [
    ["blades", ["BL-1:inactive", "BL-2:missing"]],
    ["Pad", ["PD-1:inactive"]],
  ]);
  assert.deepEqual(noSku, ["Unknown thing"]);
});

test("unknown or empty status never counts as inactive", () => {
  assert.equal(skuState(null), "active");
  assert.equal(skuState(["SOMETHING_NEW"]), "active");
  assert.equal(skuState(["DISCOVERABLE"]), "active");
  assert.equal(skuState("Inactive"), "inactive");
});
