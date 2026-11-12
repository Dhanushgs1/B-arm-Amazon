import test from "node:test";
import assert from "node:assert/strict";
import { findPages } from "./pageFinderRules.ts";

test("page finder: names first, then keyword matches; every word must match; SellerMate-only pages absent", () => {
  assert.deepEqual(findPages(""), []);
  assert.equal(findPages("inv")[0].href, "/dashboard/inventory");
  assert.equal(findPages("flipkart up")[0].href, "/dashboard/flipkart/upload");
  assert.ok(findPages("stars").some((p) => p.href === "/dashboard/ratings-reviews")); // keyword match
  assert.deepEqual(findPages("meesho shopify"), []);
  for (const q of ["campaigns", "keywords", "bid", "search terms", "live inventory", "ai assistant"]) {
    assert.ok(!findPages(q).some((p) => /\/dashboard\/(campaigns|keywords|bids|searchterms|inventory\/live|ai)$/.test(p.href)), q);
  }
  assert.ok(findPages("a").length <= 8);
});
