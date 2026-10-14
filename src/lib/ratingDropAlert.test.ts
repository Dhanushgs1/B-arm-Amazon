import test from "node:test";
import assert from "node:assert/strict";
import { findRatingDrops, bareSku, productUrl, isThisWeeksSnapshot, toRatingDrop } from "./ratingDropAlert.ts";
import type { Listing } from "./productRatingMetrics.ts";

const listing = (name: string, prevRating: number | null, rating: number | null, reviews: number, platform = "Amazon", skus = [`${name}-1(AM)`], reviewsDelta: number | null = 1): Listing => ({
  key: name, platform, name, rating, reviews, health: "good", priceMin: null, priceMax: null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skus: skus.map((skuId) => ({ skuId } as any)),
  ratingDelta: null, reviewsDelta, prevRating, isNew: false, lowConfidence: false,
});

test("keeps only listings that went from 4★+ to below 4★, at any review count", () => {
  const rows = findRatingDrops([
    listing("Crossed", 4.0, 3.6, 11),
    listing("Was 4.1", 4.1, 3.8, 10),
    listing("Still above", 5.0, 4.8, 40),     // dropped but still ≥ 4
    listing("Already below", 3.8, 3.5, 30),   // was already under 4
    listing("One review", 4.0, 3.6, 1),       // 1 review still counts (user, 2026-10-12)
    listing("New", null, 3.0, 20),            // no previous rating
    listing("Unrated now", 4.2, null, 20),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["Crossed", "One review", "Was 4.1"]);
});

test("exactly 4.0 now is not below 4", () => {
  assert.equal(findRatingDrops([listing("Edge", 4.3, 4.0, 50)]).length, 0);
});

test("orders lowest rating first, then most reviews", () => {
  const rows = findRatingDrops([listing("B", 4, 3.9, 6), listing("A", 4, 3.6, 8), listing("C", 4, 3.9, 60)]);
  assert.deepEqual(rows.map((r) => r.name), ["A", "C", "B"]);
});

test("strips the channel tag from SKUs", () => {
  assert.equal(bareSku("B-INST-BW-Bl-2(AM)"), "B-INST-BW-Bl-2");
  assert.equal(bareSku("B-FLANGE-FINDER-KIT(FK)"), "B-FLANGE-FINDER-KIT");
  assert.equal(bareSku("PLAIN-SKU"), "PLAIN-SKU");
});

test("builds Amazon and Flipkart product links", () => {
  assert.equal(productUrl("Amazon", "B0GG9VQ7PR"), "https://www.amazon.in/dp/B0GG9VQ7PR");
  assert.equal(productUrl("Flipkart", "BRPHZ6HWXE5UGN9X"), "https://www.flipkart.com/product/p/itme?pid=BRPHZ6HWXE5UGN9X");
  assert.equal(productUrl("Amazon", null), null);
  assert.equal(productUrl("Meesho", "X"), null);
});

test("this week's snapshot is at most 6 days old", () => {
  assert.equal(isThisWeeksSnapshot("2026-10-12", "2026-10-12"), true);
  assert.equal(isThisWeeksSnapshot("2026-10-06", "2026-10-12"), true);
  assert.equal(isThisWeeksSnapshot("2026-10-05", "2026-10-12"), false);
  assert.equal(isThisWeeksSnapshot("2026-10-13", "2026-10-12"), false);
});

test("toRatingDrop resolves the link from any variant SKU", () => {
  const l = listing("Pad", 4.0, 3.6, 11, "Amazon", ["PAD-1(AM)", "PAD(AM)"], 3);
  const d = toRatingDrop(l, new Map([["PAD", "B0GQTV6MZW"]]));
  assert.equal(d.url, "https://www.amazon.in/dp/B0GQTV6MZW");
  assert.equal(d.prevReviews, 8);
  assert.deepEqual(d.skus, ["PAD-1(AM)", "PAD(AM)"]);
});
