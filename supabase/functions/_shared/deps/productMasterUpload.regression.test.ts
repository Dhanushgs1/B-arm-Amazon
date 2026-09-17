import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { skuBase } from "./productMasterUpload.ts";

Deno.test("skuBase strips a trailing numeric variant suffix", () => {
  assertEquals(skuBase("B-INSEM-KIT-PK5-1"), "B-INSEM-KIT-PK5");
  assertEquals(skuBase("B-INSEM-KIT-PK5-4"), "B-INSEM-KIT-PK5");
});

Deno.test("skuBase strips a trailing \"-S\" suffix, matching a SKU with no row of its own in any master table to its base product", () => {
  // Real bug this was written for: "-S" SKUs (a listing/campaign variant, e.g. B-INSEM-KIT-PK5-S,
  // A015-S, B-SENBR-S) have no entry of their own in master_product_marketing, master_product_skuid,
  // or barm_product_master. Before this fix, skuBase only stripped a numeric "-<digits>" suffix, so
  // these never matched their base SKU's byBase fallback entry and resolved to the wrong (raw
  // fallback) product name — splitting one product into a separate, incomplete report row.
  assertEquals(skuBase("B-INSEM-KIT-PK5-S"), "B-INSEM-KIT-PK5");
  assertEquals(skuBase("A015-S"), "A015");
  assertEquals(skuBase("B-SENBR-S"), "B-SENBR");
  // Case-insensitive, same as the rest of skuBase's normalization.
  assertEquals(skuBase("a015-s"), "A015");
});

Deno.test("skuBase strips a platform tag, is idempotent on an already-base SKU, and normalizes whitespace/underscores", () => {
  assertEquals(skuBase("B-CT-Y(AM)"), "B-CT-Y");
  assertEquals(skuBase("A015"), "A015");
  assertEquals(skuBase("b ct_y"), "BCTY");
});
