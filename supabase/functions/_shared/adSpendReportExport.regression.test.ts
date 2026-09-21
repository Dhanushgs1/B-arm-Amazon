import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { spendTax, computeCpc, computeAcos, actionSheetAcos, ACOS_UNDEFINED_SENTINEL, acosCell, acosSortRank, getDateWindow, groupProductsByName } from "./adSpendReportExport.ts";

Deno.test("spendTax applies the flat 1.18 GST multiplier when none is tagged", () => {
  assertEquals(spendTax({ spend: 100, units: 5 }), 118);
});

Deno.test("computeCpc falls back to spendTax when units is 0", () => {
  assertEquals(computeCpc({ spend: 100, units: 0 }), 118);
});

Deno.test("computeAcos with no Sponsored Products row falls back to Spend (no tax) / Total Sales, never CPC/Price (which is tax-inclusive)", () => {
  // No `revenue` tracked on the aggregate (a bare WindowAgg) -> Total Sales is
  // estimated as units x price (the Meesho case, which never sets `revenue`).
  // Deliberately NOT 118 / 10 / 20 (the old CPC/Price formula) — that divides
  // by spendTax(), which double-counts GST against a proxy ACOS.
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20), 100 / 200);
  // `revenue` (real per-order sales for the window), when tracked, is the
  // real Total Sales figure — Amazon/Flipkart's own real-order revenue, which
  // can legitimately differ from units x price when price moved mid-window.
  assertEquals(computeAcos({ spend: 100, units: 10, revenue: 150 }, 20), 100 / 150);
  // Total Sales 0 (price 0, so nothing to divide by) with real spend on file
  // is a genuinely unknown ratio, not literal 0% — the sentinel, blanked by
  // acosCell, same convention as the Sponsored Products branch below.
  assertEquals(computeAcos({ spend: 100, units: 10 }, 0), ACOS_UNDEFINED_SENTINEL);
  // Total Sales 0 AND no spend at all -> 0, nothing to report.
  assertEquals(computeAcos({ spend: 0, units: 10 }, 0), 0);
});

Deno.test("computeAcos prefers Meesho's adOrders x price over Total Sales, and still honors adSales when adUnits is absent (Flipkart's OLD path)", () => {
  // adSales was Flipkart's PRIMARY branch until the adUnits branch below superseded it (fetchFlipkartProducts
  // now always sets adUnits too, so this exact shape — adSales with no adUnits — no longer occurs for real
  // Flipkart data). Left intact as generic function behavior: still correct for any caller that only has an
  // ad-platform's own revenue figure and no per-unit/price breakdown. Verified against a real example: "Chewy
  // tube (Green - Spiral model)", Flipkart, 11-to-17-09-2026 — Spend 1,504.01 / Ad Sales 7,587 = 19.8%, matching
  // the seller's own manual math exactly at the time (real per-order Total Sales for that same window was a
  // different, larger 12,182, which this branch deliberately does NOT divide by).
  assertEquals(Math.round(computeAcos({ spend: 1504.01, units: 53, revenue: 12182, adSales: 7587 }, 229.27) * 10000) / 10000, 0.1982);
  // adSales present but exactly 0 (real spend, zero ad-attributed sales this window, even with a
  // real Total Sales/revenue on file) is the same "genuinely unknown ratio" sentinel as Amazon's
  // adAttributedSales branch — a deliberate blank, not a silent fall-through to Total Sales.
  assertEquals(computeAcos({ spend: 120.7, units: 1, revenue: 373, adSales: 0 }, 365.89), ACOS_UNDEFINED_SENTINEL);
  // Meesho's adOrders x price is used the same way, since Meesho's ad export has no currency sales
  // figure directly. Meesho is untouched by the adUnits branch below (fetchMeeshoProducts never sets it).
  assertEquals(computeAcos({ spend: 50, units: 5, revenue: 500, adOrders: 2 }, 100), 50 / 200);
  // No adSales/adOrders/adUnits field at all (undefined, not 0) is the true "no ad-attribution data of
  // any kind" case, and still falls back to Total Sales/revenue.
  assertEquals(computeAcos({ spend: 50, units: 5, revenue: 500 }, 100), 50 / 500);
  // Amazon is unaffected — its adAttributedSales branch still takes priority over everything else.
  assertEquals(computeAcos({ spend: 100, units: 10, adAttributedSpend: 100, adAttributedSales: 200 }, 20), 0.5);
});

Deno.test("computeAcos: Flipkart's adUnits branch (Spend WITH tax / (Direct+Indirect Units Sold x Price)) takes priority over adSales, per the seller's own reference workbook's ACOSS formula", () => {
  // Real example: B-VD-PLAS-TPE, Flipkart, 17-09-2026 — Spend (without tax) 455.54, Direct Units
  // Sold 1, Indirect 0, Price 1439. Spend(with tax) = 455.54 x 1.18 = 537.5372, so ACOS =
  // 537.5372 / (1 x 1439) = 37.35%, not the 31.66% the old Spend(no tax)/Total Revenue formula gave
  // for this same row (Total Revenue happened to equal exactly 1439 that day).
  const b_vd_plas_tpe = { spend: 455.54, units: 0, adUnits: 1 };
  assertEquals(Math.round(computeAcos(b_vd_plas_tpe, 1439) * 10000) / 10000, 0.3735);
  // adUnits present but exactly 0 (real spend, a tracked ad row, but zero ad-attributed conversions
  // this window) is the sentinel — this is the exact case that used to render as a literal #DIV/0!
  // in the seller's own reference workbook's naive Spend/Total Revenue "ACOS" column, which their
  // own "ACOSS" (this formula) fixes by dividing by Units x Price instead.
  assertEquals(computeAcos({ spend: 3.8, units: 0, adUnits: 0 }, 100), ACOS_UNDEFINED_SENTINEL);
  // adUnits set but price is 0 (denominator 0 either way) — still the sentinel, not a crash.
  assertEquals(computeAcos({ spend: 10, units: 0, adUnits: 5 }, 0), ACOS_UNDEFINED_SENTINEL);
  // Zero spend and zero adUnits -> 0, nothing to report.
  assertEquals(computeAcos({ spend: 0, units: 0, adUnits: 0 }, 100), 0);
  // adUnits takes priority over adSales when both are present — this is the real shape
  // fetchFlipkartProducts now produces (adSales is kept only for the Summary sheet's separate
  // "Ad Sales" display column, no longer read for ACOS at all once adUnits is set).
  assertEquals(computeAcos({ spend: 455.54, units: 0, adUnits: 1, adSales: 1439 }, 1439), computeAcos(b_vd_plas_tpe, 1439));
});

Deno.test("computeAcos: an Amazon SKU with spend + price + orders but no Sponsored Products row gets a real percentage, never blank", () => {
  // Regression for the bug reported against a live Ad Spend Report export:
  // SB/SD-only Amazon SKUs (e.g. Therapressure Brush (Green), Polyglycolic
  // suture thread) had valid Spend/CPC/Price but ACOS rendered as a blank
  // cell — the old CPC/Price fallback could never itself return exactly the
  // 9.99 sentinel, but real production data hit this seam another way; this
  // pins the fix's actual contract instead: any SKU with real spend, price,
  // and Total Sales > 0 always resolves to a finite, non-sentinel number.
  const v = computeAcos({ spend: 379.97, units: 4, revenue: 23936.01 }, 5671);
  assertEquals(v, 379.97 / 23936.01);
  assertEquals(v === ACOS_UNDEFINED_SENTINEL, false);
  assertEquals(acosCell({ spend: 379.97, units: 4, revenue: 23936.01 }, 5671), Math.round((379.97 / 23936.01) * 10000) / 10000);
});

Deno.test("actionSheetAcos: a real Sponsored Products row with zero attributed sales this window still falls back to Spend/Total Sales, unlike computeAcos", () => {
  // Regression for the bug reported against a live Ad Spend Report export's Action Sheet: a
  // Suture thread-KT row — Orders 1, Spend (no tax) 436.86, Spend (with tax) 515.49, Price 721,
  // Total Sales 721 — rendered as a literal "999%" because it HAS a Sponsored Products row on file
  // for this window, just with adAttributedSales === 0 (computeAcos's own branch correctly treats
  // that as a genuinely-unknown ratio for every other sheet). The Action Sheet is meant to be
  // acted on, so it uses a real, computable number here instead: Spend(no tax)/Total Sales, exactly
  // like a SKU with no Sponsored Products row at all.
  const suturethreadKT = { spend: 436.86, units: 1, revenue: 721, adAttributedSpend: 436.86, adAttributedSales: 0 };
  // computeAcos (every other sheet): correctly stays the sentinel — has an SP row, attributed 0.
  assertEquals(computeAcos(suturethreadKT, 721), ACOS_UNDEFINED_SENTINEL);
  // actionSheetAcos (Action Sheet only): the real 60.59%, not 999%.
  const v = actionSheetAcos(suturethreadKT, 721);
  assertEquals(Math.round(v * 10000) / 100, 60.59);
  assertEquals(v === ACOS_UNDEFINED_SENTINEL, false);
  // A genuine positive Sponsored Products attribution is untouched — same number as computeAcos.
  const attributed = { spend: 999, units: 999, adAttributedSpend: 516.18, adAttributedSales: 379.04 };
  assertEquals(actionSheetAcos(attributed, 999), computeAcos(attributed, 999));
  // No Sponsored Products row at all (undefined, not 0) — same fallback as computeAcos's own.
  assertEquals(actionSheetAcos({ spend: 436.86, units: 1, revenue: 721 }, 721), 436.86 / 721);
  // Genuinely nothing to compute from at all (no orders, no revenue, no attribution) — still the
  // sentinel, so the >14% threshold check still surfaces a real-spend/zero-signal row.
  assertEquals(actionSheetAcos({ spend: 100, units: 0 }, 721), ACOS_UNDEFINED_SENTINEL);
});

Deno.test("computeAcos prefers Amazon's own ad-attributed spend/sales when on file, ignoring GST and real-order units/price entirely", () => {
  // Matches the raw Sponsored Products Advertised Product export's own ACOS
  // (Spend / 7 Day Total Sales, no GST) rather than this report's usual
  // real-order-based CPC/Price formula — per the seller's explicit request
  // that ACOS match the raw export number-for-number.
  assertEquals(
    computeAcos({ spend: 999, units: 999, adAttributedSpend: 516.18, adAttributedSales: 379.04 }, 999),
    516.18 / 379.04
  );
  // Ad spend with zero attributed sales reads as the same 9.99 "near-infinite"
  // sentinel this file uses elsewhere for a spend/revenue ratio it can't compute.
  assertEquals(computeAcos({ spend: 0, units: 0, adAttributedSpend: 50, adAttributedSales: 0 }, 100), 9.99);
  // No spend and no attributed sales at all -> 0, not the sentinel.
  assertEquals(computeAcos({ spend: 0, units: 0, adAttributedSpend: 0, adAttributedSales: 0 }, 100), 0);
  // adAttributedSales undefined (no Sponsored Products row for this SKU at all, e.g. SB/SD-only
  // spend) falls back to the Spend(no tax)/Total Sales proxy formula instead of reading as a
  // false 0% ACOS.
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20), 100 / 200);
});

Deno.test("acosCell blanks out the ACOS_UNDEFINED_SENTINEL to null instead of showing a literal 999% cell", () => {
  // Real bug this was written for: a single day where Amazon attributed zero sales despite real ad
  // spend rendered as a spreadsheet cell showing "999%", read by the seller as a data error. Every
  // xlsx/DB/email ACOS write goes through acosCell instead of pct(computeAcos(...)) directly so this
  // case renders as a blank cell instead.
  assertEquals(acosCell({ spend: 0, units: 0, adAttributedSpend: 50, adAttributedSales: 0 }, 100), null);
  // A real, computable ACOS still comes through as the normal rounded fraction.
  assertEquals(acosCell({ spend: 999, units: 999, adAttributedSpend: 516.18, adAttributedSales: 379.04 }, 999), Math.round((516.18 / 379.04) * 10000) / 10000);
  // No spend, no sales, no ad data at all -> 0, not blank (nothing to report, not "unknown").
  assertEquals(acosCell({ spend: 0, units: 0 }, 100), 0);
});

Deno.test("acosSortRank puts a known, finite ACOS above the sentinel in a worst-ACOS-first sort", () => {
  // Real bug this was written for: the Summary sheet's top-3 shortlist and the email's "high
  // spending product" table both sort by descending ACOS. Since the sentinel (9.99) is
  // numerically larger than any real ACOS, three blank "zero attributed sales" Amazon rows
  // pushed Chewy tube bump's concrete, known 136% ACOS entirely off the visible top-3 list.
  // acosSortRank must rank the sentinel LAST, not first, so a real number always wins.
  const knownHigh = { spend: 999, units: 999, adAttributedSpend: 516.18, adAttributedSales: 379.04 }; // 136.18%
  const sentinelBlank = { spend: 0, units: 0, adAttributedSpend: 185.72, adAttributedSales: 0 }; // real spend, zero attribution
  const rows = [{ label: "blank", agg: sentinelBlank }, { label: "known", agg: knownHigh }]
    .sort((a, b) => acosSortRank(b.agg, 199) - acosSortRank(a.agg, 199));
  assertEquals(rows[0].label, "known");
  assertEquals(rows[1].label, "blank");
  // A real ACOS still sorts by its own magnitude, unaffected by the sentinel remap.
  assertEquals(acosSortRank({ spend: 50, units: 50, adAttributedSpend: 50, adAttributedSales: 100 }, 10) < acosSortRank(knownHigh, 199), true);
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
      day: { spend: 195.19, units: 1, adAttributedSpend: 195.19, adAttributedSales: 189.52 },
      range: { spend: 1150.58, units: 45, adAttributedSpend: 1150.58, adAttributedSales: 10355.19 },
    },
    {
      platform: "Amazon" as const, sku: "B-CT-G-1", name: "Chewy tube (Green - Spiral model)", price: 239,
      day: { spend: 38.77, units: 0, adAttributedSpend: 38.77, adAttributedSales: 0 },
      range: { spend: 220.0, units: 0, adAttributedSpend: 220.0, adAttributedSales: 0 },
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
