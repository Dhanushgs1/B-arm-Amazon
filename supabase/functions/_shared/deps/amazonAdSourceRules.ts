// COPY of src/lib/amazonAdSourceRules.ts for the Edge job — keep the two identical.
// Which uploaded rows each Amazon report may read (user rule, 27 Oct 2026): ONLY the 7-Day Ad Spend
// Report uses the daily combined "Last 7 days" upload. Every other report and shared loader reads the
// dedicated Upload-page cards alone — Sponsored Products — Advertised Product (SP), Sponsored Brands —
// Campaign report (SB), Sponsored Display — Campaign report (SD).
//
// Until that rule, the combined upload also wrote into the SP/SB/SD card tables on the same key the
// cards use, so whichever upload ran last overwrote the other's row and every report read a mix. The
// combined upload now writes only its own barm_daily_* copies; the helpers here keep the two apart:
//   - isSpCardRow / isCampaignCardRow pick out card rows, so rows the combined upload left in the card
//     tables before the split are never read as card data;
//   - dailyAmAdsReportRows rebuilds, from barm_daily_am_ads, the SP/SB/SD row sets the Ad Spend Report
//     used to read from the card tables.
// Kept to one sibling import so it can be unit tested directly and copied for the Edge job
// (supabase/functions/_shared/deps/amazonAdSourceRules.ts — keep the two identical).

import { collectSkuLessSpend, type AmAdsSpendRow } from "./amazonSpendRules.ts";

/** raw.source on a Brand/Display campaign row the combined upload saved without an Advertised SKU. */
export const SKU_LESS_SOURCE = "AM ads (no Advertised SKU)";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** The stored source row — an array when the SP card merged several lines sharing one key. */
function firstRaw(r: Row): Row | null {
  const raw = Array.isArray(r?.raw) ? r.raw[0] : r?.raw;
  return raw && typeof raw === "object" ? (raw as Row) : null;
}

/** A barm_amazon_sp_advertised_product row written by the SP card: Amazon's Advertised Product export
 *  has a "Date" column, while the combined upload's "AM ads" sheet has "Start Date"/"End Date". */
export function isSpCardRow(r: Row): boolean {
  const raw = firstRaw(r);
  return !!raw && Object.prototype.hasOwnProperty.call(raw, "Date");
}

/** A barm_amazon_sb_campaign / _sd_campaign row from its card, not a SKU-less row the combined upload saved. */
export function isCampaignCardRow(r: Row): boolean {
  return firstRaw(r)?.source !== SKU_LESS_SOURCE;
}

/**
 * Sponsored Brands / Display campaign spend spread over the SKUs mapped to each campaign on the Upload
 * page, in proportion to their weights — a missing or non-positive weight counts as 1, so a campaign
 * mapped to 3 SKUs with no weights gives each a third (₹300 → ₹100 each). The same rule the Ad Spend
 * and Historical reports use. Spend of a campaign with no mapping is returned in `unmapped`, never
 * dropped; rows with no positive spend are skipped.
 */
export function allocateCampaignSpend(
  campaignRows: Row[],
  mapRows: Row[],
): { allocations: { report_date: string; campaign_name: string; sku: string; spend: number }[]; unmapped: { report_date: string; campaign_name: string; spend: number }[] } {
  const weights = new Map<string, { sku: string; weight: number }[]>();
  for (const m of mapRows) {
    const c = String(m.campaign_name ?? "");
    const sku = String(m.sku ?? "").trim();
    if (!c || !sku) continue;
    const w = Number(m.weight);
    const list = weights.get(c) || [];
    list.push({ sku, weight: Number.isFinite(w) && w > 0 ? w : 1 });
    weights.set(c, list);
  }
  const allocations: { report_date: string; campaign_name: string; sku: string; spend: number }[] = [];
  const unmapped: { report_date: string; campaign_name: string; spend: number }[] = [];
  for (const r of campaignRows) {
    const spend = num(r.spend);
    if (spend <= 0) continue;
    const report_date = String(r.report_date ?? "").slice(0, 10);
    const campaign_name = String(r.campaign_name ?? "");
    const list = weights.get(campaign_name);
    const total = list ? list.reduce((s, e) => s + e.weight, 0) : 0;
    if (!list || total <= 0) {
      unmapped.push({ report_date, campaign_name, spend });
      continue;
    }
    for (const e of list) allocations.push({ report_date, campaign_name, sku: e.sku, spend: (spend * e.weight) / total });
  }
  return { allocations, unmapped };
}

const dayCampaign = (date: unknown, campaign: unknown) => `${String(date ?? "").slice(0, 10)}|${String(campaign ?? "").trim()}`;
const num = (v: unknown) => Number(v) || 0;

/**
 * The 7-Day Ad Spend Report's Amazon ad rows, from the daily combined upload's own copy
 * (barm_daily_am_ads) — the same three sets the report read from the card tables before:
 *   spRows   every "AM ads" line with an Advertised SKU: Sponsored Products, the seller's per-SKU split
 *            of Brand/Display spend, and Sponsored Display lines carrying a SKU.
 *   sbRows / sdRows  the SB/SD card rows, plus one row per Brand/Display campaign-day that reached
 *            "AM ads" with no SKU — unless a card row already has that campaign-day, which stays the
 *            fuller source (the rule the combined upload applied when it saved these rows itself).
 * The report then drops SB/SD rows already split per SKU (isSplitCoveredCampaignRow), as before.
 */
export function dailyAmAdsReportRows(dailyRows: Row[], cardSbRows: Row[], cardSdRows: Row[]): { spRows: Row[]; sbRows: Row[]; sdRows: Row[] } {
  const spRows: Row[] = [];
  const skuLessInput: AmAdsSpendRow[] = [];
  for (const r of dailyRows) {
    const sku = String(r.sku ?? "").trim();
    const report_date = r.report_date ? String(r.report_date).slice(0, 10) : null;
    if (sku) {
      spRows.push({
        report_date,
        campaign_name: String(r.campaign_name ?? ""),
        ad_group_name: String(r.ad_group_name ?? ""),
        advertised_sku: sku,
        advertised_asin: String(r.asin ?? ""),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        spend: num(r.spend),
        sales_7d: num(r.sales_7d),
        orders_7d: num(r.orders_7d),
        units_7d: num(r.units_7d),
        raw: r.raw,
      });
    } else {
      skuLessInput.push({
        report_date,
        campaign_name: String(r.campaign_name ?? ""),
        ad_type: String(firstRaw(r)?.["Ad Type"] ?? ""),
        advertised_sku: "",
        spend: num(r.spend),
      });
    }
  }
  const sbCard = cardSbRows.filter(isCampaignCardRow);
  const sdCard = cardSdRows.filter(isCampaignCardRow);
  const onCard = new Set([...sbCard, ...sdCard].map((r) => dayCampaign(r.report_date, r.campaign_name)));
  const sbRows = [...sbCard];
  const sdRows = [...sdCard];
  for (const d of collectSkuLessSpend(skuLessInput).campaignDays) {
    if (onCard.has(dayCampaign(d.report_date, d.campaign_name))) continue;
    const row = { report_date: d.report_date, campaign_name: d.campaign_name, spend: d.spend, raw: { source: SKU_LESS_SOURCE, ad_type: d.ad_type, rows: d.rows } };
    (d.ad_type === "SD" ? sdRows : sbRows).push(row);
  }
  return { spRows, sbRows, sdRows };
}
