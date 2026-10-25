import test from "node:test";
import assert from "node:assert/strict";
import { googleAdsRatios, mergeGoogleWebsiteOrders, type GoogleCardRow, type ShopifyReportOrder } from "./googleWebsiteOrders.ts";

const card = (id: number, order_date: string, invoice: string, product_name: string, quantity: number, price: number): GoogleCardRow => ({ id, order_date, invoice, product_name, quantity, price: String(price) });
const order = (order_name: string, order_date: string, title: string, price: number, ad_channel: string, opts: { cancelled?: boolean; qty?: number } = {}): ShopifyReportOrder => ({
  order_name,
  order_date,
  is_cancelled: !!opts.cancelled,
  ad_channel,
  items: [{ title, quantity: opts.qty ?? 1, price: price.toFixed(2), line_total: (price * (opts.qty ?? 1)).toFixed(2) }],
});

// Real rows from barm_daily_google_orders and the Shopify orders of 21–24 Oct 2026.
const CARD: GoogleCardRow[] = [
  card(73, "2026-10-21", "ORDER-2026-10-21-Bulb 10.5cm PK5-1", "Bulb 10.5cm PK5", 2, 599),
  card(74, "2026-10-21", "ORDER-2026-10-21-PP belt grey-1", "PP belt grey", 1, 399),
  card(75, "2026-10-22", "ORDER-2026-10-22-menopause cassttes PK3-1", "menopause cassttes PK3", 1, 299),
  card(76, "2026-10-22", "ORDER-2026-10-22-Bulb 10.5cm Pk 5-1", "Bulb 10.5cm Pk 5", 1, 599),
  card(77, "2026-10-22", "ORDER-2026-10-22-VD plastic-1", "VD plastic", 1, 789),
  card(78, "2026-10-22", "ORDER-2026-10-22-Pad Liners & Healing Foam Combo for Mother-1", "Pad Liners & Healing Foam Combo for Mother", 1, 1499),
  card(79, "2026-10-22", "ORDER-2026-10-22-Sitz Bath Salt 400g-1", "Sitz Bath Salt 400g", 1, 203),
  card(80, "2026-10-22", "ORDER-2026-10-22-Neem Wood Comb-1", "Neem Wood Comb", 1, 179),
  card(81, "2026-10-22", "ORDER-2026-10-22-Postpartum 10pic kit-1", "Postpartum 10pic kit", 1, 2699),
  card(82, "2026-10-22", "ORDER-2026-10-22-dual kit pk10-1", "dual kit pk10", 1, 1099),
  card(90, "2026-10-23", "SHOPIFY-2026-10-23-At-Home Bulb Insemination Kit – 10.5cm (Pack of 5)", "At-Home Bulb Insemination Kit – 10.5cm (Pack of 5)", 1, 599),
  card(91, "2026-10-23", "SHOPIFY-2026-10-23-Medical Vaginal Dilator Therapy Set (Firm) – 6 Sizes", "Medical Vaginal Dilator Therapy Set (Firm) – 6 Sizes", 1, 789),
  card(92, "2026-10-23", "SHOPIFY-2026-10-23-Postpartum Recovery Essentials kit", "Postpartum Recovery Essentials kit", 1, 2699),
  card(93, "2026-10-23", "SHOPIFY-2026-10-23-Soft Medical Dilator Set — Pack of 5", "Soft Medical Dilator Set — Pack of 5", 1, 999),
];
const SHOPIFY: ShopifyReportOrder[] = [
  order("#1067", "2026-10-22", "Dual Insemination Kit (Pack of 10)", 1099, "meta_ads"),
  order("#1068", "2026-10-22", "Blood Sugar Control & Headache Relief (Pack of 1)", 999, "google_organic"),
  order("#1069", "2026-10-22", "Postpartum Recovery Essentials kit", 2699, "google_organic"),
  order("#1070", "2026-10-22", "Blood Sugar Control & Headache Relief (Pack of 1)", 999, "google_organic"),
  order("#1071", "2026-10-22", "Dual Insemination Kit (Pack of 4)", 685, "google_ads"),
  order("#1072", "2026-10-22", "At-Home Bulb Insemination Kit – 10.5cm (Pack of 5)", 599, "meta_ads"),
  order("#1073", "2026-10-23", "Postpartum Recovery Essentials kit", 2699, "google_organic"),
  order("#1074", "2026-10-23", "At-Home Bulb Insemination Kit – 10.5cm (Pack of 5)", 599, "meta_ads"),
  order("#1075", "2026-10-23", "Medical Vaginal Dilator Therapy Set (Firm) – 6 Sizes", 789, "direct"),
  order("#1076", "2026-10-23", "Soft Medical Dilator Set — Pack of 5", 999, "google_organic", { cancelled: true }),
  order("#1077", "2026-10-24", "At-Home Bulb Insemination Kit – 10.5cm (Pack of 2)", 599, "google_ads"),
  order("#1078", "2026-10-24", "Glucospark Blood Glucose Test Strips – Pack of 50", 307, "google_organic"),
];

const merged = mergeGoogleWebsiteOrders(CARD, SHOPIFY);
const onDay = (d: string) => merged.lines.filter((l) => l.date === d);
const sum = (ls: { value: number }[]) => Math.round(ls.reduce((t, l) => t + l.value, 0) * 100) / 100;
const units = (ls: { quantity: number }[]) => ls.reduce((t, l) => t + l.quantity, 0);

test("Shopify coverage starts on the first Shopify order day", () => {
  assert.equal(merged.shopifyFrom, "2026-10-22");
});

test("days before Shopify coverage are untouched", () => {
  const d21 = onDay("2026-10-21");
  assert.equal(units(d21), 3);
  assert.equal(sum(d21), 1597);
  assert.ok(d21.every((l) => l.source === "card"));
  assert.ok(!merged.dropped.some((d) => d.date < "2026-10-22"));
});

test("23 Oct: the four Shopify-export rows are replaced by #1073–#1075, cancelled #1076 not counted", () => {
  const dropped23 = merged.dropped.filter((d) => d.date === "2026-10-23");
  assert.deepEqual(dropped23.map((d) => d.matchedOrder).sort(), ["#1073", "#1074", "#1075", "#1076"]);
  const d23 = onDay("2026-10-23");
  assert.deepEqual(d23.map((l) => l.order).sort(), ["#1073", "#1074", "#1075"]);
  assert.equal(units(d23), 3);
  assert.equal(sum(d23), 4087);
  assert.equal(sum(d23.filter((l) => l.googleAds)), 0);
});

test("22 Oct: hand-typed copies of #1067/#1069/#1072 drop, the other five workbook lines stay", () => {
  const dropped22 = merged.dropped.filter((d) => d.date === "2026-10-22");
  assert.deepEqual(dropped22.map((d) => d.matchedOrder).sort(), ["#1067", "#1069", "#1072"]);
  assert.equal(sum(dropped22), 4397);
  const kept = onDay("2026-10-22").filter((l) => l.source === "card");
  assert.deepEqual(kept.map((l) => l.name).sort(), ["Neem Wood Comb", "Pad Liners & Healing Foam Combo for Mother", "Sitz Bath Salt 400g", "VD plastic", "menopause cassttes PK3"]);
  assert.equal(sum(kept), 2969);
  const d22 = onDay("2026-10-22");
  assert.equal(units(d22), 11);
  assert.equal(sum(d22), 10049);
});

test("Google Ads credit only for gclid orders #1071 and #1077", () => {
  const ads = merged.lines.filter((l) => l.googleAds);
  assert.deepEqual(ads.map((l) => l.order), ["#1071", "#1077"]);
  assert.equal(sum(ads), 1284);
});

test("a card row matches at most one Shopify line", () => {
  // Two identical workbook lines, one Shopify order: only one is a duplicate.
  const r = mergeGoogleWebsiteOrders(
    [card(1, "2026-10-22", "ORDER-a", "Bulb", 1, 599), card(2, "2026-10-22", "ORDER-b", "Bulb", 1, 599)],
    [order("#1072", "2026-10-22", "Bulb kit", 599, "meta_ads")]
  );
  assert.equal(r.dropped.length, 1);
  assert.equal(r.lines.filter((l) => l.source === "card").length, 1);
  assert.equal(r.lines.filter((l) => l.source === "shopify").length, 1);
});

test("an unmatched Shopify-export row is still left out once Shopify data exists", () => {
  const r = mergeGoogleWebsiteOrders([card(1, "2026-10-23", "SHOPIFY-2026-10-23-X", "X", 2, 100)], [order("#1073", "2026-10-23", "Y", 50, "direct")]);
  assert.deepEqual(r.dropped, [{ invoice: "SHOPIFY-2026-10-23-X", date: "2026-10-23", value: 200, matchedOrder: null }]);
});

test("no Shopify data at all: every card row counts", () => {
  const r = mergeGoogleWebsiteOrders(CARD, []);
  assert.equal(r.shopifyFrom, null);
  assert.equal(r.dropped.length, 0);
  assert.equal(r.lines.length, CARD.length);
});

test("ratios", () => {
  assert.deepEqual(googleAdsRatios(346.93, 685), { acos: 346.93 / 685, roas: 685 / 346.93 });
  assert.deepEqual(googleAdsRatios(355.62, 0), { acos: null, roas: 0 });
  // 24 Oct case: Shopify Ad Sales exist but no Google Ads spend file yet — not a 0% ACOS.
  assert.deepEqual(googleAdsRatios(0, 599), { acos: null, roas: null });
});
