import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { spendTax, computeCpc, computeAcos, acosCell, acosSortRank, getDateWindow, groupProductsByName } from "./adSpendReportExport.ts";

Deno.test("spendTax applies the flat 1.18 GST multiplier when none is tagged", () => {
  assertEquals(spendTax({ spend: 100, units: 5 }), 118);
});

Deno.test("computeCpc falls back to spendTax when units is 0", () => {
  assertEquals(computeCpc({ spend: 100, units: 0 }), 118);
});

Deno.test("computeAcos is CPC / price, and 0 when price is 0", () => {
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20), 118 / 10 / 20);
  assertEquals(computeAcos({ spend: 100, units: 10 }, 0), 0);
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
  // spend) falls back to the real-order-based formula instead of reading as a false 0% ACOS.
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20), 118 / 10 / 20);
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

Deno.test("groupProductsByName's DAY ad-attributed merge keeps the sale-bearing variant's own ratio instead of blending in a zero-sale variant's dead spend, matching the raw Sponsored Products export row-for-row; RANGE keeps summing as before", () => {
  // Real case: "Chewy tube (Green - Spiral model)" ran two SKU variants on 16-09-2026 —
  // B-CT-G-8 actually sold (spend 195.19 / sales 189.52 -> raw ACOS 102.99%, matches the export
  // row exactly) while B-CT-G-1 spent 38.77 with zero attributed sales that day. Summing both
  // spends against B-CT-G-8's lone sales figure produced 233.96 / 189.52 = 123.46% — a number
  // that appears on no row of Amazon's own export and outranks products the seller had verified
  // as genuinely worse that day.
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
  // DAY: the zero-sale variant's spend is dropped from the ACOS pair entirely (still counted in
  // WindowAgg.spend for CPC/Orders — untouched, see rows[0].day.spend below).
  assertEquals(rows[0].day.adAttributedSpend, 195.19);
  assertEquals(rows[0].day.adAttributedSales, 189.52);
  assertEquals(computeAcos(rows[0].day, rows[0].price), 195.19 / 189.52);
  assertEquals(rows[0].day.spend, 195.19 + 38.77);
  // RANGE: unaffected by this fix, keeps the plain sum it always had.
  assertEquals(rows[0].range.adAttributedSpend, 1150.58 + 220.0);
  assertEquals(rows[0].range.adAttributedSales, 10355.19);

  // Two variants that BOTH landed a sale the same day do NOT get summed, even though that would be
  // an honest combined ratio mathematically — it still wouldn't match either raw row (real case:
  // "Bulb Syringe IUI applicator (10.5 cm)(Pack of 5)"'s SKU ran under two different campaigns the
  // same day, each with its own sale; summing dropped it from the raw sheet's rank 5 at its own
  // 97.83% down to rank 7 at a blended 56.71%). The worse (higher-ACOS) of the two wins outright —
  // here SKU-A is 100/200=50% and SKU-B is 50/80=62.5%, so SKU-B's own pair carries through untouched.
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
  assertEquals(bothConverted[0].day.adAttributedSpend, 50);
  assertEquals(bothConverted[0].day.adAttributedSales, 80);

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
