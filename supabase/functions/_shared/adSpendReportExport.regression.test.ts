import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { spendTax, computeCpc, computeAcos, actionSheetAcos, ACOS_UNDEFINED_SENTINEL, acosCell, acosSortRank, getDateWindow, groupProductsByName, flipkartRowRevenue, adStatusHasSales } from "./adSpendReportExport.ts";

Deno.test("spendTax applies the flat 1.18 GST multiplier when none is tagged", () => {
  assertEquals(spendTax({ spend: 100, units: 5 }), 118);
});

Deno.test("computeCpc falls back to spendTax when units is 0", () => {
  assertEquals(computeCpc({ spend: 100, units: 0 }), 118);
});

Deno.test("computeAcos: no ad-attribution data of any kind now uses CPC/Price as the last-resort fallback (the seller's confirmed change)", () => {
  // A bare WindowAgg — no adAttributedSales (Amazon) and adOrders not > 0 (Flipkart/Meesho) — is the
  // true "no ad-attribution data at all" case (e.g. an Amazon SB/SD-only SKU). With no listingPrice
  // argument, this uses the CALLER's `price` parameter as CPC's denominator. CPC is spendTax(a)/units
  // (WITH tax) — a deliberate, confirmed change from the old fallback, which divided raw a.spend (no
  // tax) by Total Sales instead.
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20), computeCpc({ spend: 100, units: 10 }) / 20);
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20), (118 / 10) / 20);
  // adOrders explicitly 0 (not just undefined), with no adAttributedSales either, behaves
  // identically to undefined — NOT a real Sponsored Products row (that would also set
  // adAttributedSales — see the dedicated Amazon-priority test below for that case).
  assertEquals(computeAcos({ spend: 100, units: 10, adOrders: 0 }, 20), computeCpc({ spend: 100, units: 10 }) / 20);
  // listingPrice, when provided and positive, wins over the `price` parameter — the seller's whole
  // point: `price` can be a stale master-table snapshot, listingPrice is the current live listing.
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20, 45), computeCpc({ spend: 100, units: 10 }) / 45);
  // listingPrice of 0/undefined/negative all degrade to the `price` parameter, exactly like a SKU
  // the listing table doesn't cover yet (or Meesho, which has no listing table at all).
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20, 0), computeCpc({ spend: 100, units: 10 }) / 20);
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20, undefined), computeCpc({ spend: 100, units: 10 }) / 20);
  // Both price AND listingPrice non-positive, with real spend on file, is a genuinely unknown ratio
  // — the sentinel, blanked by acosCell — same convention the old fallback used.
  assertEquals(computeAcos({ spend: 100, units: 10 }, 0), ACOS_UNDEFINED_SENTINEL);
  assertEquals(computeAcos({ spend: 100, units: 10 }, 0, 0), ACOS_UNDEFINED_SENTINEL);
  // No price of any kind AND no spend at all -> 0, nothing to report.
  assertEquals(computeAcos({ spend: 0, units: 10 }, 0), 0);
  // `revenue` (the old real-per-order-sales fallback field) no longer changes anything once this
  // last-resort branch is reached — it's gone entirely, per the seller's explicit instruction (see
  // computeAcos's own comment).
  assertEquals(computeAcos({ spend: 100, units: 10, revenue: 150 }, 20), computeCpc({ spend: 100, units: 10, revenue: 150 }) / 20);
});

Deno.test("computeAcos: a real Amazon Sponsored Products row keeps its own Ad Spend/Ad-Attributed-Sales ratio even when adOrders reads 0 this window", () => {
  // Regression for the exact gap caught in review of an earlier version of this gate: Amazon's own
  // "7 Day Total Sales" and "7 Day Total Orders" are independently reported fields on the raw
  // Sponsored Products export, so a real SP row can legitimately show adAttributedSales > 0 with
  // adOrders === 0 that same window. An adOrders-checked-first gate would have incorrectly sent this
  // to the new CPC/Price fallback instead of Amazon's own ratio — checking adAttributedSales first
  // (unconditionally, regardless of adOrders) fixes that; this pins the contract directly.
  const spRowZeroOrders = { spend: 100, units: 10, adAttributedSpend: 100, adAttributedSales: 200, adOrders: 0 };
  assertEquals(computeAcos(spRowZeroOrders, 20), 0.5);
  // Confirm it's NOT silently falling through to CPC/Price (which would give a different number).
  assertEquals(computeAcos(spRowZeroOrders, 20) === computeCpc(spRowZeroOrders) / 20, false);
  // Same with adOrders undefined instead of explicitly 0 (a real SP row that never had this field
  // populated at all) — identical result, since the check is `!== undefined` on adAttributedSales,
  // not conditioned on adOrders in any way.
  const spRowNoOrdersField = { spend: 100, units: 10, adAttributedSpend: 100, adAttributedSales: 200 };
  assertEquals(computeAcos(spRowNoOrdersField, 20), 0.5);
  // A real SP row, adOrders===0, zero attributed SALES too: per the seller's later, confirmed
  // instruction (see computeAcos's own comment), this is NO LONGER the sentinel -- it falls back
  // to CPC/Price like every other "attribution is exactly 0" case now does.
  const spRowZeroEverything = { spend: 50, units: 10, adAttributedSpend: 50, adAttributedSales: 0, adOrders: 0 };
  assertEquals(computeAcos(spRowZeroEverything, 20), computeCpc(spRowZeroEverything) / 20);
  assertEquals(computeAcos(spRowZeroEverything, 20) === ACOS_UNDEFINED_SENTINEL, false);
  // A listingPrice argument is correctly ignored entirely for a real Amazon SP row — it's an
  // Ad-Spend/Ad-Sales ratio, not a CPC/Price one, regardless of what listingPrice the caller passes.
  assertEquals(computeAcos(spRowZeroOrders, 20, 999), 0.5);
});

Deno.test("computeAcos prefers Flipkart's adSales / Meesho's adOrders x price over Total Sales, per the seller's final explicit instruction (Total Ad Orders > 0, clearing the new gate)", () => {
  // Every fixture below now needs an explicit positive adOrders to clear the new Total-Ad-Orders
  // gate (see the gate's own test group above) and reach this Ad Spend/Ad-Attributed-Sales logic
  // at all — adOrders wasn't part of the original fixtures (added here, matching this branch's own
  // real-world data: Flipkart's WindowAgg always sets adOrders alongside adSales, Meesho's adOrders
  // IS the ad-attribution signal itself), so this still proves the ">0" branch is unchanged.
  // Final answer, verified against a real example: "Chewy tube (Green - Spiral model)", Flipkart,
  // 11-to-17-09-2026 — Spend 1,504.01 / Ad Sales 7,587 = 19.8%, matching the seller's own manual
  // math exactly (real per-order Total Sales for that same window was a different, larger 12,182,
  // which is what this branch deliberately does NOT divide by).
  assertEquals(Math.round(computeAcos({ spend: 1504.01, units: 53, revenue: 12182, adSales: 7587, adOrders: 40 }, 229.27) * 10000) / 10000, 0.1982);
  // adSales present but exactly 0 (real spend, zero ad-attributed sales this window, even with a
  // real Total Sales/revenue on file): per the seller's later, confirmed instruction, this falls
  // back to CPC/Price now, NOT the sentinel and NOT a silent fall-through to Total Sales/revenue.
  assertEquals(
    Math.round(computeAcos({ spend: 120.7, units: 1, revenue: 373, adSales: 0, adOrders: 3 }, 365.89) * 10000) / 10000,
    0.3893
  );
  // Meesho's adOrders x price is used the same way, since Meesho's ad export has no currency sales
  // figure directly.
  assertEquals(computeAcos({ spend: 50, units: 5, revenue: 500, adOrders: 2 }, 100), 50 / 200);
  // The old "no adSales/adOrders field at all -> falls back to Total Sales/revenue" case (this
  // file's previous version of this test) is now structurally UNREACHABLE via the new gate: reaching
  // this file's totalSales/revenue branch requires adOrders to be simultaneously >0 (to clear the
  // new gate above) and undefined (for the adSalesFigure ternary just below the gate to fall
  // through) — a contradiction. See computeAcos's own comment for the full explanation; the
  // equivalent real-world scenario (no ad-attribution data at all) is covered by the new gate's own
  // test group above instead, which now returns CPC/Price rather than this Spend/Total-Sales proxy.
  // Amazon is unaffected — its adAttributedSales branch still takes priority over everything else.
  assertEquals(computeAcos({ spend: 100, units: 10, adAttributedSpend: 100, adAttributedSales: 200, adOrders: 5 }, 20), 0.5);
});

Deno.test("computeAcos: an Amazon SKU with spend + price + orders but no Sponsored Products row gets a real percentage, never blank", () => {
  // Regression for the bug reported against a live Ad Spend Report export: SB/SD-only Amazon SKUs
  // (e.g. Therapressure Brush (Green), Polyglycolic suture thread) had valid Spend/CPC/Price but
  // ACOS rendered as a blank cell. This exact scenario — no Sponsored Products row, so no adOrders
  // field at all — is now handled directly by the Total-Ad-Orders gate itself (CPC/Price), rather
  // than the old real-revenue-proxy fallback this test originally pinned; the underlying contract
  // this regression cares about — a SKU with real spend/price never renders as the blank sentinel —
  // still holds, just via the new formula.
  const fixture = { spend: 379.97, units: 4, revenue: 23936.01 };
  const v = computeAcos(fixture, 5671);
  assertEquals(v, computeCpc(fixture) / 5671);
  assertEquals(v === ACOS_UNDEFINED_SENTINEL, false);
  assertEquals(acosCell(fixture, 5671), Math.round((computeCpc(fixture) / 5671) * 10000) / 10000);
  // A current live listing price (listingPrice), when on file, wins over the stale `price`
  // argument — the exact fix this whole feature was built for on precisely this kind of SB/SD-only
  // SKU, which has no Ad Spend/Ad Sales ratio to fall back to at all.
  const listingPrice = 5999;
  assertEquals(computeAcos(fixture, 5671, listingPrice), computeCpc(fixture) / listingPrice);
});

Deno.test("actionSheetAcos: a real Sponsored Products row with zero attributed sales this window uses its own Spend/Total Sales fallback, a different formula from computeAcos's CPC/Price", () => {
  // Regression for the bug reported against a live Ad Spend Report export's Action Sheet: a
  // Suture thread-KT row — Orders 1, Spend (no tax) 436.86, Spend (with tax) 515.49, Price 721,
  // Total Sales 721 — rendered as a literal "999%" because it HAS a Sponsored Products row on file
  // for this window, just with adAttributedSales === 0. computeAcos now ALSO computes a real
  // percentage here (CPC/Price, per the seller's later instruction — see its own dedicated test
  // group), but via a different formula/denominator than actionSheetAcos's Spend(no tax)/Total
  // Sales — the two are no longer expected to agree on this fixture shape, only on a genuine
  // positive Sponsored Products attribution (see below).
  // adOrders: 1 added to both fixtures below (not part of the original bug report) purely so
  // computeAcos's own comparison assertions here still exercise its adAttributedSales branch rather
  // than the Orders=0 gate (see that gate's own test group) — actionSheetAcos itself has no such
  // gate and is completely unaffected either way.
  const suturethreadKT = { spend: 436.86, units: 1, revenue: 721, adAttributedSpend: 436.86, adAttributedSales: 0, adOrders: 1 };
  // computeAcos: CPC/Price now, not the sentinel — computeCpc(suturethreadKT)/721.
  assertEquals(computeAcos(suturethreadKT, 721), computeCpc(suturethreadKT) / 721);
  assertEquals(computeAcos(suturethreadKT, 721) === ACOS_UNDEFINED_SENTINEL, false);
  // actionSheetAcos (Action Sheet only): its own real 60.59%, a different number from computeAcos's.
  const v = actionSheetAcos(suturethreadKT, 721);
  assertEquals(Math.round(v * 10000) / 100, 60.59);
  assertEquals(v === ACOS_UNDEFINED_SENTINEL, false);
  assertEquals(v === computeAcos(suturethreadKT, 721), false);
  // A genuine positive Sponsored Products attribution is untouched — same number as computeAcos.
  const attributed = { spend: 999, units: 999, adAttributedSpend: 516.18, adAttributedSales: 379.04, adOrders: 10 };
  assertEquals(actionSheetAcos(attributed, 999), computeAcos(attributed, 999));
  // No Sponsored Products row at all (undefined, not 0) — same fallback as computeAcos's own.
  assertEquals(actionSheetAcos({ spend: 436.86, units: 1, revenue: 721 }, 721), 436.86 / 721);
  // Genuinely nothing to compute from at all (no orders, no revenue, no attribution) — still the
  // sentinel, so the >14% threshold check still surfaces a real-spend/zero-signal row.
  assertEquals(actionSheetAcos({ spend: 100, units: 0 }, 721), ACOS_UNDEFINED_SENTINEL);
});

Deno.test("computeAcos prefers Amazon's own ad-attributed spend/sales when on file (Total Ad Orders > 0), ignoring GST and real-order units/price entirely", () => {
  // adOrders: added to every fixture below to clear the new Total-Ad-Orders gate (see that gate's
  // own test group) — none of these were part of the original fixtures, since this test predates
  // that feature; the point here is that the ">0" branch itself is completely unchanged.
  // Matches the raw Sponsored Products Advertised Product export's own ACOS
  // (Spend / 7 Day Total Sales, no GST) rather than this report's usual
  // real-order-based CPC/Price formula — per the seller's explicit request
  // that ACOS match the raw export number-for-number.
  assertEquals(
    computeAcos({ spend: 999, units: 999, adAttributedSpend: 516.18, adAttributedSales: 379.04, adOrders: 30 }, 999),
    516.18 / 379.04
  );
  // units: 0 here means real Orders is 0 -- since the seller's later, confirmed instruction (see the
  // dedicated override test group below) makes that ALWAYS win over Amazon's own adAttributedSpend/
  // Sales ratio, this no longer reads as the 9.99 sentinel: real a.spend is 0, so CPC (spendTax(a),
  // since units is 0) is 0, so ACOS is 0 -- not 9.99. (Before that later instruction, this fixture's
  // adAttributedSpend: 50/adAttributedSales: 0 combination WOULD have produced the sentinel; that
  // old contract is still pinned separately, with units > 0, by the dedicated Amazon-SP-row test
  // group above.)
  assertEquals(computeAcos({ spend: 0, units: 0, adAttributedSpend: 50, adAttributedSales: 0, adOrders: 4 }, 100), 0);
  // No spend and no attributed sales at all -> 0, not the sentinel.
  assertEquals(computeAcos({ spend: 0, units: 0, adAttributedSpend: 0, adAttributedSales: 0, adOrders: 4 }, 100), 0);
  // adAttributedSales undefined (skips Amazon's own branch entirely) WITH adOrders > 0 takes the
  // Flipkart/Meesho-style branch instead — adOrders x price, since adSales isn't set here — no
  // longer the old Spend(no tax)/Total Sales proxy this test originally pinned before this feature
  // existed. The realistic version of "no Sponsored Products row at all" (SB/SD-only Amazon spend)
  // is adOrders undefined/0, which is covered by the last-resort CPC/Price test group instead.
  assertEquals(computeAcos({ spend: 100, units: 10, adOrders: 4 }, 20), 100 / 80);
});

Deno.test("computeAcos: real Orders = 0 always uses CPC/Price, overriding real Amazon Sponsored Products and Flipkart/Meesho ad-attribution data (seller's confirmed reversal)", () => {
  // The seller's newest instruction is a deliberate, explicitly-confirmed reversal of the
  // "Amazon's own SP-row check always wins" contract pinned above: whenever real Orders (a.units,
  // NOT Total Ad Orders/a.adOrders) is 0, ACOS is unconditionally CPC/Price — even when a genuine
  // Amazon Sponsored Products row (adAttributedSales) or real Flipkart/Meesho ad-attribution data
  // (adOrders > 0) is present for that same SKU/window. Confirmed directly: "Yes, unconditionally —
  // override the Amazon exception too."
  const amazonSpRowZeroOrders = { spend: 100, units: 0, adAttributedSpend: 100, adAttributedSales: 200, adOrders: 0 };
  // Pre-this-instruction, this returned 0.5 (Amazon's own 100/200 ratio) — now it's CPC/Price.
  assertEquals(computeAcos(amazonSpRowZeroOrders, 20), computeCpc(amazonSpRowZeroOrders) / 20);
  assertEquals(computeAcos(amazonSpRowZeroOrders, 20) === 0.5, false);
  // listingPrice still wins over the `price` parameter for this override, same as the pre-existing
  // last-resort fallback already did.
  assertEquals(computeAcos(amazonSpRowZeroOrders, 20, 45), computeCpc(amazonSpRowZeroOrders) / 45);

  const flipkartAdOrdersZeroUnits = { spend: 50, units: 0, revenue: 500, adSales: 400, adOrders: 5 };
  // Pre-this-instruction, this returned 50/400 = 0.125 (Flipkart's own ad-attributed-sales ratio).
  assertEquals(computeAcos(flipkartAdOrdersZeroUnits, 100), computeCpc(flipkartAdOrdersZeroUnits) / 100);
  assertEquals(computeAcos(flipkartAdOrdersZeroUnits, 100) === 0.125, false);

  const meeshoAdOrdersZeroUnits = { spend: 50, units: 0, revenue: 500, adOrders: 2 };
  // Pre-this-instruction, this returned 50/(2*100) = 0.25 (Meesho's adOrders x price proxy).
  assertEquals(computeAcos(meeshoAdOrdersZeroUnits, 100), computeCpc(meeshoAdOrdersZeroUnits) / 100);
  assertEquals(computeAcos(meeshoAdOrdersZeroUnits, 100) === 0.25, false);

  // Concrete numeric proof matching the seller's own worked example: Spend (with tax) = Rs 1,000,
  // Orders = 0, Price = Rs 500 -> CPC = Rs 1,000 (computeCpc falls back to spendTax when units is 0,
  // i.e. CPC = Spend with tax directly), ACOS = 200%.
  const spend1000WithTax = { spend: 1000 / 1.18, units: 0 };
  assertEquals(Math.round(computeCpc(spend1000WithTax) * 100) / 100, 1000);
  assertEquals(Math.round(computeAcos(spend1000WithTax, 500) * 100) / 100, 2);
  // Spend (with tax) = Rs 500, Orders = 0, Price = Rs 500 -> ACOS = 100%.
  const spend500WithTax = { spend: 500 / 1.18, units: 0 };
  assertEquals(Math.round(computeCpc(spend500WithTax) * 100) / 100, 500);
  assertEquals(Math.round(computeAcos(spend500WithTax, 500) * 100) / 100, 1);
});

Deno.test("computeAcos: real Orders = 0 and Spend = 0 -> ACOS = 0%, not the blank sentinel", () => {
  assertEquals(computeAcos({ spend: 0, units: 0 }, 100), 0);
  // Still 0 even with a real price/listingPrice on file and real ad-attribution fields present but
  // zero-valued — genuinely nothing spent, nothing to report.
  assertEquals(computeAcos({ spend: 0, units: 0, adAttributedSpend: 0, adAttributedSales: 0, adOrders: 0 }, 100, 250), 0);
  // Genuinely unpriced (no price, no listingPrice) AND no spend -> still 0, not the sentinel —
  // there's nothing to divide by, but also nothing to report.
  assertEquals(computeAcos({ spend: 0, units: 0 }, 0), 0);
});

Deno.test("computeAcos: real Orders > 0 is completely unaffected by the new Orders=0 override (regression proof)", () => {
  // Same fixture shapes as the Orders=0 override test group above, but with real Orders > 0 — must
  // reproduce the pre-existing Amazon/Flipkart/Meesho ad-attribution-preferred behavior exactly.
  const amazonSpRow = { spend: 100, units: 5, adAttributedSpend: 100, adAttributedSales: 200, adOrders: 0 };
  assertEquals(computeAcos(amazonSpRow, 20), 0.5);
  assertEquals(computeAcos(amazonSpRow, 20) === computeCpc(amazonSpRow) / 20, false);

  const flipkartAdOrders = { spend: 50, units: 5, revenue: 500, adSales: 400, adOrders: 5 };
  assertEquals(computeAcos(flipkartAdOrders, 100), 50 / 400);

  const meeshoAdOrders = { spend: 50, units: 5, revenue: 500, adOrders: 2 };
  assertEquals(computeAcos(meeshoAdOrders, 100), 50 / 200);

  // No ad-attribution data at all, real Orders > 0 -> CPC/Price last resort, unchanged from before
  // this instruction (see the dedicated last-resort test group near the top of this file).
  const noAdData = { spend: 100, units: 10 };
  assertEquals(computeAcos(noAdData, 20), computeCpc(noAdData) / 20);
});

Deno.test("computeAcos: real Orders > 0 but Ad Sales exactly 0 now uses CPC/Price instead of the blank sentinel (seller's confirmed reversal, live report review)", () => {
  // Regression for a live generated report review: SKU A001-5 (Amazon, real Orders 2, real Spend,
  // Total Ad Sales 0, Total Ad Orders 0) rendered ACOS as blank when it should read as a real
  // percentage. Confirmed directly, reversing the "a real SP row with 0 attributed sales stays the
  // sentinel" contract that was pinned as correct only a short time earlier this session.
  const amazonZeroAdSales = { spend: 99.91, units: 2, adAttributedSpend: 99.91, adAttributedSales: 0, adOrders: 0 };
  assertEquals(computeAcos(amazonZeroAdSales, 2699), computeCpc(amazonZeroAdSales) / 2699);
  assertEquals(computeAcos(amazonZeroAdSales, 2699) === ACOS_UNDEFINED_SENTINEL, false);
  // Same for Flipkart's adSales === 0 (with real adOrders on file, i.e. NOT "no ad data at all" —
  // that case was already CPC/Price before this instruction, this is the narrower reversal).
  const flipkartZeroAdSales = { spend: 50, units: 5, revenue: 500, adSales: 0, adOrders: 3 };
  assertEquals(computeAcos(flipkartZeroAdSales, 100), computeCpc(flipkartZeroAdSales) / 100);
  // And Meesho's adOrders x price landing on exactly 0 (adOrders itself is 0, so adSalesFigure is
  // 0 x price = 0) -- covered by the pre-existing "no ad-attribution data at all" gate already,
  // unaffected by this change, still CPC/Price.
  const meeshoNoAdOrders = { spend: 50, units: 5, revenue: 500 };
  assertEquals(computeAcos(meeshoNoAdOrders, 100), computeCpc(meeshoNoAdOrders) / 100);
  // A real, positive attribution figure still keeps its own ratio -- this reversal only affects the
  // exactly-0 case, nothing else.
  const amazonRealAttribution = { spend: 100, units: 10, adAttributedSpend: 100, adAttributedSales: 200, adOrders: 5 };
  assertEquals(computeAcos(amazonRealAttribution, 20), 0.5);
});

Deno.test("acosCell blanks out the ACOS_UNDEFINED_SENTINEL to null instead of showing a literal 999% cell", () => {
  // Real bug this was written for: a single day where Amazon attributed zero sales despite real ad
  // spend rendered as a spreadsheet cell showing "999%", read by the seller as a data error. Every
  // xlsx/DB/email ACOS write goes through acosCell instead of pct(computeAcos(...)) directly so this
  // case renders as a blank cell instead.
  // adOrders added below (not part of the original fixture) to clear the Total-Ad-Orders gate.
  // units: 0 (real Orders 0) now takes priority over that gate entirely (see the dedicated override
  // test group in computeAcos's own tests): real a.spend is 0, so this reads as ACOS 0%, not the
  // sentinel -- acosCell(0) is 0, not null. The sentinel-blanking behavior itself is still pinned
  // separately just below, with a fixture real Orders (units) > 0.
  assertEquals(acosCell({ spend: 0, units: 0, adAttributedSpend: 50, adAttributedSales: 0, adOrders: 2 }, 100), 0);
  // A real SP row with 0 attributed sales, real Orders (units) > 0, and a real price on file no
  // longer produces the sentinel either — per the seller's later, confirmed instruction, it now
  // falls back to CPC/Price like every other "attribution is exactly 0" case (see computeAcos's own
  // test group for this exact fixture shape).
  assertEquals(acosCell({ spend: 50, units: 10, adAttributedSpend: 50, adAttributedSales: 0, adOrders: 0 }, 100), Math.round((computeCpc({ spend: 50, units: 10 }) / 100) * 10000) / 10000);
  // The actual sentinel-blanking contract this test is named for is now reachable only for a
  // genuinely unpriced row (no price and no listingPrice at all) with real spend — there's truly
  // nothing to divide by, even after falling back to CPC/Price.
  assertEquals(acosCell({ spend: 50, units: 10, adAttributedSpend: 50, adAttributedSales: 0 }, 0), null);
  // A real, computable ACOS still comes through as the normal rounded fraction.
  assertEquals(acosCell({ spend: 999, units: 999, adAttributedSpend: 516.18, adAttributedSales: 379.04, adOrders: 30 }, 999), Math.round((516.18 / 379.04) * 10000) / 10000);
  // No spend, no sales, no ad data at all -> 0, not blank (nothing to report, not "unknown") — this
  // one now goes through the new Total-Ad-Orders gate (adOrders undefined) instead of the old
  // adAttributedSales branch, landing on the same 0 result either way (computeCpc is 0 when spend
  // and units are both 0, so 0/price is still 0).
  assertEquals(acosCell({ spend: 0, units: 0 }, 100), 0);
});

Deno.test("acosSortRank puts a known, finite ACOS above the sentinel in a worst-ACOS-first sort", () => {
  // Real bug this was written for: the Summary sheet's top-3 shortlist and the email's "high
  // spending product" table both sort by descending ACOS. Since the sentinel (9.99) is
  // numerically larger than any real ACOS, three blank "zero attributed sales" Amazon rows
  // pushed Chewy tube bump's concrete, known 136% ACOS entirely off the visible top-3 list.
  // acosSortRank must rank the sentinel LAST, not first, so a real number always wins.
  // adOrders added to every fixture below (not part of the original bug report) to clear the
  // Total-Ad-Orders gate, same reasoning as the computeAcos test groups above. sentinelBlank now
  // needs BOTH real Orders (units) > 0 (to clear the Orders=0 override, which would otherwise
  // return a finite CPC/Price number itself) AND no valid price at all (price 0 below, no
  // listingPrice) — since a real SP row with 0 attributed sales no longer produces the sentinel by
  // itself (see computeAcos's own test group); only a genuinely unpriced row still does.
  const knownHigh = { spend: 999, units: 999, adAttributedSpend: 516.18, adAttributedSales: 379.04, adOrders: 30 }; // 136.18%
  const sentinelBlank = { spend: 50, units: 1, adAttributedSpend: 185.72, adAttributedSales: 0, adOrders: 5 }; // real spend, zero attribution, no price
  const rows = [{ label: "blank", agg: sentinelBlank }, { label: "known", agg: knownHigh }]
    .sort((a, b) => acosSortRank(b.agg, 0) - acosSortRank(a.agg, 0));
  assertEquals(rows[0].label, "known");
  assertEquals(rows[1].label, "blank");
  // A real ACOS still sorts by its own magnitude, unaffected by the sentinel remap.
  assertEquals(acosSortRank({ spend: 50, units: 50, adAttributedSpend: 50, adAttributedSales: 100, adOrders: 8 }, 10) < acosSortRank(knownHigh, 199), true);
});

Deno.test("getDateWindow computes a pure UTC-midnight trailing window, not local time", () => {
  assertEquals(getDateWindow("2026-09-08", 7), { start: "2026-09-02", end: "2026-09-08" });
});

Deno.test("groupProductsByName sums spend/units across SKU variants of the same product", () => {
  const rows = groupProductsByName([
    { platform: "Amazon" as const, sku: "SKU-A", name: "Widget", price: 100, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
    { platform: "Amazon" as const, sku: "SKU-B", name: "widget", price: 0, day: { spend: 5, units: 1 }, range: { spend: 20, units: 2 } },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].day.spend, 15);
  assertEquals(rows[0].range.units, 7);
  assertEquals(rows[0].sku, "SKU-A, SKU-B");
});

Deno.test("groupProductsByName merges a legacy \"(Old)\"-suffixed SKU group into its renamed live counterpart", () => {
  const rows = groupProductsByName([
    { platform: "Amazon" as const, sku: "B-CT-Y", name: "Chewy tube (Yellow) - Spiral model", price: 247, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
    { platform: "Amazon" as const, sku: "B-CT-Y-1", name: "Chewy tube (Yellow) - Spiral model", price: 247, day: { spend: 2, units: 0 }, range: { spend: 10, units: 1 } },
    { platform: "Amazon" as const, sku: "B-CT-Y(Old)", name: "Chewy tube (Yellow)", price: 247, day: { spend: 5, units: 1 }, range: { spend: 20, units: 2 } },
    { platform: "Amazon" as const, sku: "B-CT-Y-1(Old)", name: "Chewy tube (Yellow)", price: 247, day: { spend: 1, units: 0 }, range: { spend: 5, units: 1 } },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].name, "Chewy tube (Yellow) - Spiral model");
  assertEquals(rows[0].day.spend, 18);
  assertEquals(rows[0].range.units, 9);
});

Deno.test("groupProductsByName folds sibling SKUs into one row via master_product_skuid identity, even when they resolved to different display names", () => {
  // Real bug this was written for: two SKUs of the same physical product resolved to different
  // final display names (e.g. only one had a master_product_marketing entry, so the other fell
  // through to a raw fallback name) and printed as two separate, incomplete rows with wrong
  // Spend/Orders/ACOS each. skuToMasterSkuidName lets groupProductsByName recognize they're the
  // same product via master_product_skuid's own "Product Name", regardless of the name mismatch.
  const skuToMasterSkuidName = new Map([
    ["SKU-A", "Chewy Tube Combo Pack"],
    ["SKU-B", "Chewy Tube Combo Pack"],
  ]);
  const rows = groupProductsByName(
    [
      { platform: "Amazon" as const, sku: "SKU-A", name: "Chewy Tube Combo Pack", price: 199, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
      // Different resolved display name (e.g. fell through to the raw marketing title) — would
      // print as a separate row under the old name-only grouping.
      { platform: "Amazon" as const, sku: "SKU-B", name: "B-COMBO-2 raw title", price: 0, day: { spend: 5, units: 1 }, range: { spend: 20, units: 2 } },
    ],
    undefined,
    skuToMasterSkuidName
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].day.spend, 15);
  assertEquals(rows[0].range.units, 7);
  assertEquals(rows[0].sku, "SKU-A, SKU-B");

  // Without skuToMasterSkuidName, the same two rows stay split (documents the bug this fixes).
  const withoutFix = groupProductsByName([
    { platform: "Amazon" as const, sku: "SKU-A", name: "Chewy Tube Combo Pack", price: 199, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
    { platform: "Amazon" as const, sku: "SKU-B", name: "B-COMBO-2 raw title", price: 0, day: { spend: 5, units: 1 }, range: { spend: 20, units: 2 } },
  ]);
  assertEquals(withoutFix.length, 2);
});

Deno.test("groupProductsByName merges a \"-S\"-suffixed SKU (no master_product_skuid entry of its own) into its base SKU's group", () => {
  // Real case this was written for: A015-S, B-CT-G-BUMP-S, B-SENBR-S etc. have no row of their
  // own in master_product_skuid, so they resolve through a different fallback path than their
  // base SKU and land on a different display name — splitting one product into two incomplete
  // rows with wrong Spend/Orders/ACOS each, exactly like the "(Old)" suffix case above.
  const rows = groupProductsByName([
    { platform: "Amazon" as const, sku: "A015", name: "Sensory/Therapressure brush - Auto", price: 399, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
    // Different resolved name for the "-S" SKU (fell through to a raw fallback) — would print as
    // a separate row under name-only grouping.
    { platform: "Amazon" as const, sku: "A015-S", name: "A015-S raw title", price: 0, day: { spend: 2, units: 0 }, range: { spend: 8, units: 1 } },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].day.spend, 12);
  assertEquals(rows[0].range.units, 6);
  assertEquals(rows[0].sku, "A015, A015-S");
  // The base (non-"-S") SKU's name wins as the merged row's display name.
  assertEquals(rows[0].name, "Sensory/Therapressure brush - Auto");
});

Deno.test("groupProductsByName keeps genuinely different SKU families separate even with similar names", () => {
  const rows = groupProductsByName([
    { platform: "Amazon" as const, sku: "B-CT-G", name: "Chewy tube (Green - Spiral model)", price: 239, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
    { platform: "Amazon" as const, sku: "B-CT-G-BUMP", name: "Chewy tube Green (Bump model New)", price: 199, day: { spend: 5, units: 1 }, range: { spend: 20, units: 2 } },
  ]);
  assertEquals(rows.length, 2);
});

Deno.test("groupProductsByName sums adAttributedSpend/Sales across merged SKU variants, and keeps it undefined only when neither side has any", () => {
  // Real case this was built for: B-CT-G-BUMP (no Sponsored Products row, all zero) merged with
  // B-CT-G-BUMP-1 (the actual advertised SKU) must carry B-CT-G-BUMP-1's ad-attributed figures
  // forward untouched, not drop them because one side of the merge had none.
  const merged = groupProductsByName([
    { platform: "Amazon" as const, sku: "B-CT-G-BUMP", name: "Chewy tube Green (Bump model New)", price: 199, day: { spend: 0, units: 0 }, range: { spend: 0, units: 0 } },
    {
      platform: "Amazon" as const,
      sku: "B-CT-G-BUMP-1",
      name: "Chewy tube Green (Bump model New)",
      price: 199,
      day: { spend: 516.18, units: 14, adAttributedSpend: 516.18, adAttributedSales: 379.04 },
      range: { spend: 3260.74, units: 90, adAttributedSpend: 3260.74, adAttributedSales: 4965.62 },
    },
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].day.adAttributedSpend, 516.18);
  assertEquals(merged[0].day.adAttributedSales, 379.04);
  assertEquals(merged[0].range.adAttributedSales, 4965.62);

  // Neither side has a Sponsored Products row at all -> stays undefined (falls back to
  // real-order ACOS for the merged row), not a false 0.
  const noAdData = groupProductsByName([
    { platform: "Amazon" as const, sku: "SKU-A", name: "Widget", price: 100, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
    { platform: "Amazon" as const, sku: "SKU-B", name: "widget", price: 0, day: { spend: 5, units: 1 }, range: { spend: 20, units: 2 } },
  ]);
  assertEquals(noAdData[0].day.adAttributedSales, undefined);
});

Deno.test("groupProductsByName's DAY ad-attributed merge sums every variant's spend and sales, matching the seller's own displayed Spend total; RANGE keeps summing as before", () => {
  // Reverted from an earlier "pick the worse of two real-sale rows outright, drop every zero-sale
  // row's spend from the pair" design (which matched exactly one raw Sponsored Products row's own
  // ACOS, but left the displayed Spend total inconsistent with an ACOS computed from only part of
  // it — real case: "Chewy tube (Yellow) - Spiral model" on 17-09-2026 showed Spend 711.62 (summed
  // across 5 rows) next to an ACOS of 247%, which is 561.82/227.62 — one single row's own ratio,
  // not 711.62's). Per the seller's explicit request, day Spend and Sales are now both a plain
  // total across every row, exactly like every other column (Orders, CPC) on this same merged row.
  const rows = groupProductsByName([
    {
      platform: "Amazon" as const, sku: "B-CT-G-8", name: "Chewy tube (Green - Spiral model)", price: 239,
      // adOrders: 1 added below (not part of the original bug report) purely so this test's own
      // computeAcos assertion clears the new Total-Ad-Orders gate and still exercises the
      // adAttributedSales branch this test is actually about — see that gate's own test group.
      day: { spend: 195.19, units: 1, adAttributedSpend: 195.19, adAttributedSales: 189.52, adOrders: 1 },
      range: { spend: 1150.58, units: 45, adAttributedSpend: 1150.58, adAttributedSales: 10355.19, adOrders: 1 },
    },
    {
      platform: "Amazon" as const, sku: "B-CT-G-1", name: "Chewy tube (Green - Spiral model)", price: 239,
      day: { spend: 38.77, units: 0, adAttributedSpend: 38.77, adAttributedSales: 0, adOrders: 0 },
      range: { spend: 220.0, units: 0, adAttributedSpend: 220.0, adAttributedSales: 0, adOrders: 0 },
    },
  ]);
  assertEquals(rows.length, 1);
  // DAY: both variants' spend is summed regardless of which one converted (zero-sale spend is no
  // longer dropped from the ACOS pair) — Sales sums too, so a zero-sale variant contributes 0.
  assertEquals(rows[0].day.adAttributedSpend, 195.19 + 38.77);
  assertEquals(rows[0].day.adAttributedSales, 189.52);
  assertEquals(computeAcos(rows[0].day, rows[0].price), (195.19 + 38.77) / 189.52);
  assertEquals(rows[0].day.spend, 195.19 + 38.77);
  // RANGE: unchanged, always summed this same way.
  assertEquals(rows[0].range.adAttributedSpend, 1150.58 + 220.0);
  assertEquals(rows[0].range.adAttributedSales, 10355.19);

  // Two variants that BOTH landed a sale the same day are now summed on both sides too — an
  // honest combined ratio, and consistent with the displayed (summed) Spend total.
  const bothConverted = groupProductsByName([
    {
      platform: "Amazon" as const, sku: "SKU-A", name: "Two-Winner Product", price: 100,
      day: { spend: 100, units: 1, adAttributedSpend: 100, adAttributedSales: 200 },
      range: { spend: 100, units: 1 },
    },
    {
      platform: "Amazon" as const, sku: "SKU-B", name: "Two-Winner Product", price: 100,
      day: { spend: 50, units: 1, adAttributedSpend: 50, adAttributedSales: 80 },
      range: { spend: 50, units: 1 },
    },
  ]);
  assertEquals(bothConverted[0].day.adAttributedSpend, 150);
  assertEquals(bothConverted[0].day.adAttributedSales, 280);

  // Two variants that BOTH spent with zero sales still sum to (spend, 0) — the existing
  // ACOS_UNDEFINED_SENTINEL behavior for a product that earned nothing anywhere that day.
  const bothZero = groupProductsByName([
    {
      platform: "Amazon" as const, sku: "SKU-C", name: "No-Winner Product", price: 100,
      day: { spend: 20, units: 0, adAttributedSpend: 20, adAttributedSales: 0 },
      range: { spend: 20, units: 0 },
    },
    {
      platform: "Amazon" as const, sku: "SKU-D", name: "No-Winner Product", price: 100,
      day: { spend: 30, units: 0, adAttributedSpend: 30, adAttributedSales: 0 },
      range: { spend: 30, units: 0 },
    },
  ]);
  assertEquals(bothZero[0].day.adAttributedSpend, 50);
  assertEquals(bothZero[0].day.adAttributedSales, 0);
});

Deno.test("flipkartRowRevenue: real Invoice Amount wins, falls back to quantity x current listing price only when it's missing", () => {
  // Real bug this was written for: some uploaded Flipkart "Orders" exports are a logistics/
  // returns-style report (delivery SLAs, dispatch dates, cancellation reasons) with no Invoice
  // Amount/price column under any name at all, rather than the report type this was designed
  // against — confirmed directly against Supabase data, not a parsing bug. That silently zeroed out
  // Flipkart's Summary sheet "Overall Sales Value" and the Ad spend report/SKU Wise Report's Total
  // Sales column for every SKU in that upload.
  // 1. A real, positive Invoice Amount on the row always wins, regardless of what the listing
  // price map has on file for that SKU — real order data is never overridden.
  assertEquals(flipkartRowRevenue(500, 2, 100), 500);
  assertEquals(flipkartRowRevenue(500, 2, undefined), 500);
  // 2. No real Invoice Amount (0, this row's own export has no such column) falls back to this
  // row's own quantity x its SKU's current barm_flipkart_listings selling price.
  assertEquals(flipkartRowRevenue(0, 2, 150), 300);
  // 3. Neither a real Invoice Amount NOR a listing-table price for this SKU -> 0, same as before
  // this fallback existed (no third fallback invented).
  assertEquals(flipkartRowRevenue(0, 2, undefined), 0);
  assertEquals(flipkartRowRevenue(0, 2, 0), 0);
});

Deno.test("adStatusHasSales: the Ad Status Report's per-platform indicator is real Sales/Orders only, never Spend alone", () => {
  // Bug this was written for: the indicator used to be spendTax(p.range) > 0, so a product with
  // real ad spend and zero real orders that range window still showed "1" (live) for that
  // platform. Per the seller's explicit instruction, Spend alone must never make this 1.
  // 1. Sales = 0 (units: 0), Spend = 0 -> 0 (nothing on file at all).
  assertEquals(adStatusHasSales({ spend: 0, units: 0 }), false);
  // 2. Sales = 0 (units: 0), Spend > 0 -> 0, even with a real Amazon Sponsored Products row or
  // real Flipkart/Meesho ad-attribution data on file for that same window — the exact regression
  // this fix targets, since spendTax(p.range) > 0 used to read this case as 1.
  assertEquals(adStatusHasSales({ spend: 100, units: 0 }), false);
  assertEquals(adStatusHasSales({ spend: 100, units: 0, adAttributedSpend: 100, adAttributedSales: 200, adOrders: 5 }), false);
  // 3. Sales > 0 (units > 0) -> 1, regardless of spend/price/ad-attribution fields.
  assertEquals(adStatusHasSales({ spend: 0, units: 1 }), true);
  assertEquals(adStatusHasSales({ spend: 100, units: 5 }), true);
});
