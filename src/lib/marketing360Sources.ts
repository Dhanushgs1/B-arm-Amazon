// "Where this data comes from" panel on Product Marketing 360 (user, 2026-11-18: "explain in dashboard also
// the 1st row comes from here and here"). One row per column group of the Full sheet's first header row:
// the exact source, how far its stored copy runs, and whether that is current. Pure, so it is tested.

export type SourceDates = {
  rating: string | null;          // mkt_rating_weekly.snapshot_date
  fc: string | null;              // mkt_fba_fc_stock.report_date (ledger date inside the forecast file)
  forecast: string | null;        // mkt_fba_forecast_zone.report_date (the forecast file's date)
  positions: string | null;       // mkt_keyword_positions.week
  delivery: string | null;        // mkt_delivery_sweep max scraped_date
  amazonAds: string | null;       // barm_amazon_sp_advertised_product max report_date (what the Amazon ads columns read)
  amazonDaily: string | null;     // barm_daily_am_ads max report_date (newer daily upload, shown for comparison)
  google: string | null;          // barm_daily_google_ad_spend max report_end
  meta: string | null;            // barm_daily_social_media max report_end
  compPrices: string | null;      // mkt_competitor_prices() max last_checked_at
  compRatingsWeek: string | null; // mkt_competitor_ratings() week_tag, e.g. "WK2026-43"
  fbaReport: string | null;       // barm_amazon_fba_inventory max created_at (upload time)
  priceListing: string | null;    // barm_amazon_price_listing max created_at (upload time)
  botPrice: string | null;        // product_rating_review_metrics (Amazon) max updated_at
};

export type SourceStatus = "current" | "old" | "missing" | "typed" | "rule";
export type SourceRow = { group: string; from: string; upTo: string | null; ageDays: number | null; status: SourceStatus; note?: string };

const day = (s: string | null) => (s ? s.slice(0, 10) : null);

/** "WK2026-43" → the Monday of ISO week 43 of 2026 (yyyy-mm-dd). */
export function weekTagDate(tag: string | null | undefined): string | null {
  const m = String(tag ?? "").match(/(\d{4})\D*(\d{1,2})$/);
  if (!m) return null;
  const year = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday1 = new Date(jan4.getTime() - (((jan4.getUTCDay() + 6) % 7) * 864e5));
  return new Date(monday1.getTime() + (week - 1) * 7 * 864e5).toISOString().slice(0, 10);
}

function ageOf(upTo: string | null, today: string): number | null {
  if (!upTo) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${upTo}T00:00:00Z`)) / 864e5);
}

/** Old when the stored copy is more than `maxAge` days behind today. */
function row(group: string, from: string, upTo: string | null, maxAge: number, today: string, note?: string): SourceRow {
  const ageDays = ageOf(upTo, today);
  return { group, from, upTo, ageDays, status: upTo === null ? "missing" : (ageDays ?? 0) > maxAge ? "old" : "current", ...(note ? { note } : {}) };
}

export function sourceRows(d: SourceDates, today: string): SourceRow[] {
  const ads = day(d.amazonAds), daily = day(d.amazonDaily);
  const fbaReport = day(d.fbaReport);
  const priceDay = day(d.botPrice) ?? day(d.priceListing);
  return [
    { group: "Product", from: "Master product list (master_product_skuid): ASIN, SKU ID, category", upTo: null, ageDays: null, status: "typed" },
    { group: "Market", from: "TAM, audiences: typed in by the marketing team · Suggested TAM: researched buyers × our selling price (31 audience groups, with sources)", upTo: null, ageDays: null, status: "typed" },
    row("Rating & reviews — ours", "Drive: \"AM FK Rating and Review - <date>_Ratings & Reviews (final).xlsx\", Sheet1 (weekly)", day(d.rating), 8, today),
    row("Rating & reviews — competitor", "Competitor analysis, weekly ratings sheet (competitor_analysis_wide)", weekTagDate(d.compRatingsWeek), 8, today,
      d.compRatingsWeek ? `week ${d.compRatingsWeek}` : undefined),
    row("Price — ours", "Rating bot's Amazon price (else the FBA report's price) · M.R.P. from the All Listings upload", priceDay, 8, today),
    row("Price — competitor", "Competitor analysis price checks (competitor_analysis, same-product matches only)", day(d.compPrices), 8, today),
    { group: "Retargeting", from: "Typed in by the marketing team", upTo: null, ageDays: null, status: "typed" },
    row("Amazon ads", "Uploaded Amazon ad reports: Sponsored Products, Display, Brand (last 7 report days)", ads, 3, today,
      daily && ads && daily > ads ? `the daily Amazon ads upload already runs to ${daily}` : undefined),
    row("FBA stock — FCs, sales, to send", "Drive: \"FBA Forecasting <date>.xlsx\" — FBA_stock tab (per-FC balance) and FBA analysis tab (30-day orders, to send by zone)", day(d.forecast), 3, today,
      d.fc && d.forecast && d.fc !== d.forecast ? `FC balances inside that file are as on ${day(d.fc)}` : undefined),
    row("FBA stock — Available, Inbound", "Uploaded Amazon FBA inventory report (Inventory page upload)", fbaReport, 3, today),
    { group: "FBA stock — Low-weight FBA", from: "Typed in by the team", upTo: null, ageDays: null, status: "typed" },
    row("Listing position", "Drive: \"BARM_Gyno_Competitor_Position_Tracker\", BARM Position Tracking tab (weekly, Gynaecology only)", day(d.positions), 8, today),
    row("Social media ads — Google", "Daily Google Ads upload, campaigns whose name contains the product's ad words (last 7 days)", day(d.google), 3, today),
    row("Social media ads — Meta", "Daily Meta (Facebook / Instagram) upload, same name match (last 7 days)", day(d.meta), 3, today),
    { group: "Influencer posts · How to use · Action plan", from: "Typed in by the marketing team on this page", upTo: null, ageDays: null, status: "typed" },
    row("Delivery date", "Drive: \"BARM_W41_W44_Sweep_NoRating_NoReviewCount\", one tab per week — Amazon checks, latest per pincode", day(d.delivery), 3, today),
    { group: "Channel notes", from: "Channel Notes tab, matched on the product name", upTo: null, ageDays: null, status: "typed" },
    row("Delivery vs FBA (by zone)", "Delivery sweep (above) beside the FBA forecast file's orders and stock per zone", day(d.delivery) && day(d.forecast) ? [day(d.delivery)!, day(d.forecast)!].sort()[0] : null, 3, today),
    { group: "Ads suggestion", from: "A rule over the columns above: 8+ \"Yes\" FBA FCs stocked, rating ≥ 3.5★, our price vs the cheapest same-product competitor", upTo: null, ageDays: null, status: "rule" },
  ];
}
