import test from "node:test";
import assert from "node:assert/strict";
import {
  judgeCampaign, campaignStatsFromRows, campaignStatsFromSpend, campaignHighlights,
  platformInsights, platformMetrics, platformStatus, type PlatformSnapshot,
} from "./overallRules.ts";
import type { ChannelAdRow } from "./highAcosChannels.ts";

test("campaign verdicts", () => {
  assert.equal(judgeCampaign(100, 0, 200), "small");          // under the minimum spend
  assert.equal(judgeCampaign(300, 0, 200), "losing");         // spent, no sales
  assert.equal(judgeCampaign(300, 3000, 200), "best");        // ACOS 10%
  assert.equal(judgeCampaign(300, 1000, 200), "ok");          // ACOS 30%
  assert.equal(judgeCampaign(300, 600, 200), "losing");       // ACOS 50%
  assert.equal(judgeCampaign(300, null, 200), "spend-only");  // Google / Meta
});

const row = (date: string, id: string, spend: number, sales: number, orders = 1): ChannelAdRow => ({ date, id, name: id.toUpperCase(), spend, sales, orders });

test("campaign stats sum rows inside the range only, biggest spend first", () => {
  const rows = [
    row("2026-10-20", "a", 100, 1000), row("2026-10-21", "a", 150, 1500),
    row("2026-10-21", "b", 400, 0, 0),
    row("2026-10-19", "a", 999, 0), // before the range
    row("2026-10-21", "c", 0, 0, 0), // nothing happened
  ];
  const s = campaignStatsFromRows(rows, "2026-10-20", "2026-10-21", 200);
  assert.deepEqual(s.map((c) => [c.id, c.spend, c.sales, c.verdict]), [["b", 400, 0, "losing"], ["a", 250, 2500, "best"]]);
  assert.equal(s[1].roas, 10);
  assert.equal(s[1].acos, 10);
  assert.equal(s[0].acos, null);
  const h = campaignHighlights(s);
  assert.deepEqual(h.best.map((c) => c.id), ["a"]);
  assert.deepEqual(h.losing.map((c) => c.id), ["b"]);
});

test("Google / Meta campaigns carry spend only", () => {
  const s = campaignStatsFromSpend([{ name: "PMax", spend: 500, clicks: 40 }, { name: "Off", spend: 0, clicks: 0 }, { name: "Search", spend: 900, clicks: 0 }]);
  assert.deepEqual(s.map((c) => [c.name, c.verdict, c.clicks]), [["Search", "spend-only", null], ["PMax", "spend-only", 40]]);
});

const snap = (o: Partial<PlatformSnapshot>): PlatformSnapshot => ({
  key: "x", label: "X", sales: 10000, salesPrev: 10000, orders: 10, adSpend: 1000, adSpendPrev: 1000, adSales: 3000, rangeEnd: "2026-10-24", ...o,
});

test("platform metrics: ROAS on ad sales, TACOS with GST on own sales only", () => {
  const m = platformMetrics(snap({}));
  assert.equal(m.roas, 3);
  assert.equal(Math.round(m.tacos! * 10) / 10, 11.8);
  assert.equal(m.salesGrowth, 0);
  assert.equal(platformMetrics(snap({ attributed: true })).tacos, null);
  assert.equal(platformMetrics(snap({ adSpend: null, adSales: null })).roas, null);
});

test("steady platform says nothing", () => {
  const i = platformInsights(snap({}));
  assert.deepEqual(i, []);
  assert.equal(platformStatus(i), "steady");
});

test("doing well: sales up and strong ROAS", () => {
  const i = platformInsights(snap({ sales: 12000, adSales: 5000 }));
  assert.deepEqual(i.map((x) => x.tone), ["good", "good"]);
  assert.match(i[0].text, /Sales up 20\.0%/);
  assert.equal(platformStatus(i), "good");
});

test("needs attention: stale data, falling sales, weak ROAS, high TACOS, spend up while sales fall", () => {
  const i = platformInsights(snap({ sales: 8000, adSpend: 1500, adSales: 2000, dataThrough: "2026-10-22" }));
  assert.ok(i.every((x) => x.tone === "watch"));
  assert.match(i[0].text, /up to 22\.10\.2026/);
  assert.ok(i.some((x) => /Sales down 20\.0%/.test(x.text)));
  assert.ok(i.some((x) => /only 1\.3x/.test(x.text)));
  assert.ok(i.some((x) => /TACOS above 15%/.test(x.text)));
  assert.ok(i.some((x) => /Ad spend up 50\.0% while sales fell 20\.0%/.test(x.text)));
  assert.equal(platformStatus(i), "watch");
});

test("spend with no credited sales is flagged once (not also as weak ROAS)", () => {
  const i = platformInsights(snap({ adSales: 0, attributed: true, salesPrev: null }));
  assert.deepEqual(i.map((x) => x.text), ["Spent ₹1,000 on ads with no sales credited to them."]);
});
