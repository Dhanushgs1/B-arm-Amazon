import { NextResponse } from "next/server";
import { checkSession } from "@/lib/apiAuth";
import { rejectUnlessAllowed } from "@/lib/appRouteAuth";
import { supabase } from "@/lib/supabaseClient";
import { FBA_ALERT_FCS } from "@/lib/fbaWarehouseAlerts";
import { sourceRows, type SourceDates } from "@/lib/marketing360Sources";
import { latestByPincode, fcTable, adState, campaignKeywords, zoneVerdict, ourProduct, ratingRowMatches, topCompetitorRating, adsSuggestion, ADS_LOW_UNITS, ourSellingPrice, tamGroup, tamSuggestion, type DeliveryCheck, type ZoneFacts } from "@/lib/marketing360Rules";

// Product Marketing 360 — one product's marketing card, built from stored data only (Supabase).
//   GET                -> product list (Amazon listings grouped by ASIN, with master name + category)
//   GET ?asin=B0…      -> the card: listing, rating, competitors, ads, FBA, forecast, positions, delivery,
//                         and the team's manual sections (profile, action plan, influencers, channel notes)
// The Drive files feed the mkt_* tables through the page's import panel (src/lib/marketing360Store.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
type Q = { data: any[] | null; error: { message: string } | null };
const TIMEOUT = /statement timeout|canceling statement/i;
/** Rows of a Supabase query. A statement timeout (the project's 10 s anon limit, hit when the database
 *  is busy) is retried once after a short pause; awaiting the query builder again re-sends it. */
const rows = async (p: PromiseLike<Q>): Promise<any[]> => {
  let { data, error } = await p;
  if (error && TIMEOUT.test(error.message)) {
    await new Promise((r) => setTimeout(r, 1500));
    ({ data, error } = await p);
  }
  if (error) throw new Error(error.message);
  return data ?? [];
};
/** All rows of a query, 1000 at a time (PostgREST caps a response). Needs a stable .order(). */
async function allRows(make: (from: number, to: number) => PromiseLike<Q>): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const page = await rows(make(from, from + 999));
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
/** allRows() for a source the anon key may be refused: rows, or the refusal message. */
async function optionalAll(make: (from: number, to: number) => PromiseLike<Q>): Promise<{ rows: any[]; blocked: string | null }> {
  try {
    return { rows: await allRows(make), blocked: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/permission denied/i.test(msg)) return { rows: [], blocked: msg };
    throw e;
  }
}
const ASIN = /^[A-Z0-9]{10}$/;
const isoMinus = (d: string, days: number) => new Date(Date.parse(d) - days * 86_400_000).toISOString().slice(0, 10);

async function productList() {
  const listing = await rows(supabase.from("barm_amazon_price_listing").select("asin1,seller_sku,item_name,status,price").limit(5000) as any);
  const skus = [...new Set(listing.map((l) => l.seller_sku).filter(Boolean))];
  const master = new Map<string, { name: string; category: string | null }>();
  for (let i = 0; i < skus.length; i += 300) {
    for (const m of await rows(supabase.from("master_product_skuid").select('"SKU ID","Product Name","Category"').in("SKU ID", skus.slice(i, i + 300)) as any)) {
      if (!master.has(m["SKU ID"])) master.set(m["SKU ID"], { name: m["Product Name"], category: m.Category });
    }
  }
  const profiles = new Set((await rows(supabase.from("mkt_product_profile").select("asin") as any)).map((p) => p.asin));
  const by = new Map<string, any>();
  for (const l of listing) {
    if (!l.asin1) continue;
    const cur = by.get(l.asin1) ?? { asin: l.asin1, name: null, category: null, item_name: l.item_name, active: false, price: null, skus: [] as string[], has_profile: profiles.has(l.asin1) };
    const m = master.get(l.seller_sku);
    cur.name ??= m?.name ?? null;
    cur.category ??= m?.category ?? null;
    cur.active ||= l.status === "Active";
    cur.price ??= l.price ? Number(l.price) : null;
    if (l.seller_sku && !cur.skus.includes(l.seller_sku)) cur.skus.push(l.seller_sku);
    by.set(l.asin1, cur);
  }
  return [...by.values()].map((p) => ({ ...p, name: p.name ?? p.item_name })).sort((a, b) => Number(b.active) - Number(a.active) || String(a.name).localeCompare(String(b.name)));
}

async function card(asin: string) {
  const listing = await rows(supabase.from("barm_amazon_price_listing").select("seller_sku,item_name,status,price,fulfillment_channel").eq("asin1", asin) as any);
  const skus = [...new Set(listing.map((l) => l.seller_sku).filter(Boolean))] as string[];
  const master = skus.length ? await rows(supabase.from("master_product_skuid").select('"SKU ID","Product Name","Category"').in("SKU ID", skus) as any) : [];
  const productName: string | null = master[0]?.["Product Name"] ?? listing[0]?.item_name ?? null;

  const [profileRows, plan, influencers] = await Promise.all([
    rows(supabase.from("mkt_product_profile").select("*").eq("asin", asin) as any),
    rows(supabase.from("mkt_action_plan").select("*").eq("asin", asin).order("id") as any),
    rows(supabase.from("mkt_influencer_posts").select("*").eq("asin", asin).order("id") as any),
  ]);
  const profile = profileRows[0] ?? null;

  // ── rating (latest weekly Drive file) ───────────────────────────────────────────────────────
  const ratingLatest = await rows(supabase.from("mkt_rating_weekly").select("snapshot_date").eq("asin_fsn", asin).order("snapshot_date", { ascending: false }).limit(1) as any);
  const rating = ratingLatest.length
    ? await rows(supabase.from("mkt_rating_weekly").select("*").eq("asin_fsn", asin).eq("snapshot_date", ratingLatest[0].snapshot_date) as any)
    : [];

  // ── competitors (price + rating) — RLS lets only signed-in Supabase users read these tables, so
  // a refusal is reported on the card instead of failing it ──────────────────────────────────
  const [cp, cw] = await Promise.all([
    optionalAll((a, b) => supabase.rpc("mkt_competitor_prices").order("our_sku").order("competitor_product_url").range(a, b) as any),
    // competitor ratings via mkt_competitor_ratings() (latest week, one row per competitor; user approved 2026-11-18)
    optionalAll((a, b) => supabase.rpc("mkt_competitor_ratings").order("our_sku").order("marketplace").order("slot").range(a, b) as any),
  ]);
  const SAME = /^(EXACT MATCH|CLOSE EQUIVALENT)$/i;
  // same-product competitors (mkt_competitor_prices only returns EXACT MATCH / CLOSE EQUIVALENT), matched on our ASIN or any of our SKUs
  const compPrice = cp.rows.filter((c: any) => SAME.test(c.match_status ?? "") && c.competitor_price !== null && ourProduct(c, asin, skus))
    .map((c: any) => ({ ...c, is_competitor_cheaper: c.our_price !== null ? Number(c.competitor_price) < Number(c.our_price) : null }))
    .sort((a: any, b: any) => Number(a.competitor_price) - Number(b.competitor_price));
  const competitorBlocked = cp.blocked ?? cw.blocked;
  // same-product competitors first, then the rest, each by review count
  const compRatings: any[] = cw.rows.filter((r: any) => ratingRowMatches(r.our_sku, skus))
    .map((r: any) => ({ marketplace: r.marketplace, name: r.product_name, url: r.url, rating: r.rating, reviews: r.reviews, week: r.week_tag, match_status: r.match_status, same: SAME.test(r.match_status ?? "") }))
    .sort((a: any, b: any) => Number(b.same) - Number(a.same) || (Number(b.reviews) || 0) - (Number(a.reviews) || 0));
  const latestWide = cw.rows[0]?.week_tag;

  // ── Amazon ads, last 7 report days of each source ──────────────────────────────────────────
  // Product ads come from the daily Sponsored Products upload (barm_daily_am_ads, one row per day; user,
  // 2026-11-18); the older SP table stopped on 29 Oct. Display / brand ads have no daily upload, so each
  // reads its own latest 7 days and says how far it runs.
  const latestDay = async (table: string) => (await rows(supabase.from(table).select("report_date").order("report_date", { ascending: false }).limit(1) as any))[0]?.report_date ?? null;
  const [spMax, sdMax, sbMax] = await Promise.all([latestDay("barm_daily_am_ads"), latestDay("barm_amazon_sd_campaign"), latestDay("barm_amazon_sb_campaign")]);
  const since = spMax ? isoMinus(spMax, 6) : null;
  const sdSince = sdMax ? isoMinus(sdMax, 6) : null, sbSince = sbMax ? isoMinus(sbMax, 6) : null;
  const sp = since ? await rows(supabase.from("barm_daily_am_ads").select("campaign_name,spend,sales_7d,orders_7d").eq("asin", asin).gte("report_date", since) as any) : [];
  const [sdMaster, sbMaster] = await Promise.all([
    rows(supabase.from("am_display_ad_masters").select('"Display campaign name"').eq("ASIN", asin) as any),
    rows(supabase.from("brand_ads_master_sheet").select('"Campaign Name"').eq("ASIN", asin) as any),
  ]);
  // the ASIN→campaign masters, else campaigns whose name carries the product's campaign words
  // (am_display_ad_masters is RLS-hidden from the anon key, so it is often empty here)
  const words = campaignKeywords(profile?.ad_keywords, productName);
  const byWords = async (table: string, from: string | null) => {
    if (!from || !words.length) return [];
    const r = await rows(supabase.from(table).select("campaign_name").or(words.map((w) => `campaign_name.ilike.%${w.replace(/[%,()]/g, "")}%`).join(",")).gte("report_date", from) as any);
    return [...new Set(r.map((x) => x.campaign_name))];
  };
  let sdNames: string[] = sdMaster.map((m) => m["Display campaign name"]).filter(Boolean);
  let sbNames: string[] = sbMaster.map((m) => m["Campaign Name"]).filter(Boolean);
  const sdFromWords = !sdNames.length, sbFromWords = !sbNames.length;
  if (sdFromWords) sdNames = await byWords("barm_amazon_sd_campaign", sdSince);
  if (sbFromWords) sbNames = await byWords("barm_amazon_sb_campaign", sbSince);
  const [sd, sb] = await Promise.all([
    sdSince && sdNames.length ? rows(supabase.from("barm_amazon_sd_campaign").select("campaign_name,spend,sales_14d").in("campaign_name", sdNames).gte("report_date", sdSince) as any) : Promise.resolve(null),
    sbSince && sbNames.length ? rows(supabase.from("barm_amazon_sb_campaign").select("campaign_name,spend,sales").in("campaign_name", sbNames).gte("report_date", sbSince) as any) : Promise.resolve(null),
  ]);
  const sum = (xs: any[] | null, k: string) => (xs === null ? null : xs.reduce((a, x) => a + (Number(x[k]) || 0), 0));
  const campaigns = (xs: any[] | null) => [...new Set((xs ?? []).filter((x) => Number(x.spend) > 0).map((x) => x.campaign_name))];

  // ── Google / Meta by campaign-name keywords ─────────────────────────────────────────────────
  const nameFilter = words.map((w) => `campaign_name.ilike.%${w.replace(/[%,()]/g, "")}%`).join(",");
  const [gMax, mMax] = await Promise.all([
    rows(supabase.from("barm_daily_google_ad_spend").select("report_end").order("report_end", { ascending: false }).limit(1) as any),
    rows(supabase.from("barm_daily_social_media").select("report_end").order("report_end", { ascending: false }).limit(1) as any),
  ]);
  const [google, meta] = await Promise.all([
    nameFilter && gMax[0] ? rows(supabase.from("barm_daily_google_ad_spend").select("campaign_name,spend,report_end").or(nameFilter).gte("report_end", isoMinus(gMax[0].report_end, 6)) as any) : Promise.resolve(null),
    nameFilter && mMax[0] ? rows(supabase.from("barm_daily_social_media").select("campaign_name,spend,report_end").or(nameFilter).gte("report_end", isoMinus(mMax[0].report_end, 6)) as any) : Promise.resolve(null),
  ]);
  const gSpend = sum(google, "spend"), mSpend = sum(meta, "spend");

  // ── FBA: per-FC stock + zone forecast (latest daily forecast file) ──────────────────────────
  const fcDate = (await rows(supabase.from("mkt_fba_fc_stock").select("report_date").order("report_date", { ascending: false }).limit(1) as any))[0]?.report_date ?? null;
  const fcStock = fcDate ? await rows(supabase.from("mkt_fba_fc_stock").select("fc,msku,disposition,quantity").eq("asin", asin).eq("report_date", fcDate) as any) : [];
  const sellable = fcStock.filter((r) => /sellable/i.test(r.disposition) && !/unsellable/i.test(r.disposition));
  const fcDateZone = (await rows(supabase.from("mkt_fba_forecast_zone").select("report_date").order("report_date", { ascending: false }).limit(1) as any))[0]?.report_date ?? null;
  const zones = fcDateZone && skus.length ? await rows(supabase.from("mkt_fba_forecast_zone").select("*").in("sku", skus).eq("report_date", fcDateZone).order("sku").order("zone") as any) : [];
  const inv = await rows(supabase.from("barm_amazon_fba_inventory").select("sku,your_price,afn_fulfillable_quantity,afn_reserved_quantity,afn_inbound_working_quantity,afn_inbound_shipped_quantity,afn_inbound_receiving_quantity,afn_unsellable_quantity,created_at").eq("asin", asin) as any);

  // ── keyword positions + competitors on the same search terms ────────────────────────────────
  const kwWeek = (await rows(supabase.from("mkt_keyword_positions").select("week").eq("asin", asin).order("week", { ascending: false }).limit(1) as any))[0]?.week ?? null;
  const keywords = kwWeek ? await rows(supabase.from("mkt_keyword_positions").select("*").eq("asin", asin).eq("week", kwWeek).order("search_term") as any) : [];
  const terms = keywords.map((k) => k.search_term);
  const compPos = terms.length ? await rows(supabase.from("mkt_competitor_positions").select("search_term,asin,competitor_brand,product_name,product_url,sp_position,sb_position,organic_position").eq("week", kwWeek).in("search_term", terms) as any) : [];

  // ── delivery days ───────────────────────────────────────────────────────────────────────────
  const delivery: DeliveryCheck[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await rows(supabase.from("mkt_delivery_sweep").select("week,platform,pincode,tier,location,delivery_text,days,scraped_date,status").eq("asin_fsn", asin).order("week").order("pincode").range(from, from + 999) as any);
    delivery.push(...page);
    if (page.length < 1000) break;
  }
  const overrides = Object.fromEntries((await rows(supabase.from("mkt_pincode_state").select("pincode,state") as any)).map((o) => [o.pincode, o.state]));
  const deliveryLatest = latestByPincode(delivery.filter((d) => d.platform === "Amazon"), overrides);

  const notes = productName ? await rows(supabase.from("mkt_channel_notes").select("*").ilike("product", productName) as any) : [];
  const botPrice = (await rows(supabase.from("product_rating_review_metrics").select("price").eq("platform", "Amazon").eq("marketplace_product_id", asin).gt("price", 0).limit(1) as any))[0]?.price;
  const our = ourSellingPrice(botPrice, inv.find((x: any) => Number(x.your_price) > 0)?.your_price, listing.find((l) => l.price)?.price);
  const tamGroupKey = tamGroup(productName);
  const tamRow = tamGroupKey ? (await rows(supabase.from("mkt_tam_research").select("*").eq("group_key", tamGroupKey) as any))[0] : undefined;

  return {
    asin, productName, category: master[0]?.Category ?? null,
    listing: { skus, items: listing, price: our.price, price_source: our.source, mrp: our.mrp, link: `https://www.amazon.in/dp/${asin}` },
    profile, plan, influencers, notes, tamSuggest: tamInfo(tamRow, tamGroupKey, our.price),
    rating: { snapshot_date: ratingLatest[0]?.snapshot_date ?? null, rows: rating },
    competitors: { prices: compPrice, ratings: compRatings, ratings_week: latestWide ?? null, blocked: competitorBlocked },
    ads: {
      window: since ? { from: since, to: spMax } : null,
      product: { state: adState(sp.length || since ? sum(sp, "spend") : null), spend: sum(sp, "spend"), sales: sum(sp, "sales_7d"), campaigns: campaigns(sp) },
      display: { state: sdNames.length ? adState(sum(sd, "spend")) : "Not set up", spend: sum(sd, "spend"), campaigns: sdNames, matched: sdFromWords ? "name" : "master", to: sdMax },
      brand: { state: sbNames.length ? adState(sum(sb, "spend")) : "Not set up", spend: sum(sb, "spend"), campaigns: sbNames, matched: sbFromWords ? "name" : "master", to: sbMax },
      google: { state: words.length ? adState(gSpend) : "No data", spend: gSpend, campaigns: campaigns(google), to: gMax[0]?.report_end ?? null },
      meta: { state: words.length ? adState(mSpend) : "No data", spend: mSpend, campaigns: campaigns(meta), to: mMax[0]?.report_end ?? null },
      keywords: words,
    },
    fba: { report_date: fcDate, fcs: fcTable(FBA_ALERT_FCS, sellable), other: fcStock.filter((r) => !sellable.includes(r)), inventory: inv },
    adsSuggestion: (() => {
      const yes = fcTable(FBA_ALERT_FCS, sellable).filter((f) => f.onboarded === "Yes");
      const star = rating.find((x: any) => x.this_star !== null)?.this_star;
      return adsSuggestion({
        fcKnown: !!fcDate, fcStocked: yes.filter((f) => (f.stock ?? 0) > 0).length, fcOnboarded: yes.length,
        fcLow: yes.filter((f) => (f.stock ?? 0) > 0 && (f.stock ?? 0) <= ADS_LOW_UNITS).length,
        star: star === undefined || star === null ? null : Number(star),
        ourPrice: our.price,
        compPrice: compPrice[0] ? Number(compPrice[0].competitor_price) : null,
        adOn: (sum(sp, "spend") ?? 0) > 0,
      });
    })(),
    forecast: { report_date: fcDateZone, zones },
    zoneCompare: { forecast_date: fcDateZone, rows: zoneCompare(await rows(supabase.from("mkt_delivery_zone_mv").select("*").eq("asin", asin) as any), zones) },
    positions: { week: kwWeek, keywords, competitors: compPos },
    delivery: { checks: delivery.length, latest: deliveryLatest, weeks: [...new Set(delivery.map((d) => d.week))].sort() },
  };
}

/** Delivery per zone (mkt_delivery_zone_summary rows for one product) beside the FBA forecast's orders and
 *  stock for the same zone (summed over the product's SKUs), with the rule-based verdict. Zones with neither
 *  delivery checks nor forecast rows are left out. */
function zoneCompare(delivery: any[], forecast: any[]) {
  const fz = new Map<string, { orders: number; stock: number; toSend: number }>();
  for (const z of forecast) {
    const cur = fz.get(z.zone) ?? { orders: 0, stock: 0, toSend: 0 };
    cur.orders += Number(z.orders_30d) || 0;
    cur.stock += Number(z.current_stock) || 0;
    cur.toSend += Number(z.to_send) || 0;
    fz.set(z.zone, cur);
  }
  const dz = new Map(delivery.map((d) => [d.zone, d]));
  const zones = [...new Set([...dz.keys(), ...fz.keys()])];
  return zones.map((zone) => {
    const d = dz.get(zone), f = fz.get(zone);
    const facts: ZoneFacts = {
      zone, pincodes: d?.pincodes ?? 0, avg_days: d?.avg_days === null || d?.avg_days === undefined ? null : Number(d.avg_days),
      max_days: d?.max_days ?? null, slow: d?.slow ?? 0, unavailable: d?.unavailable ?? 0,
      orders_30d: f ? f.orders : null, stock: f ? f.stock : null,
    };
    return { ...facts, to_send: f?.toSend ?? null, verdict: zoneVerdict(facts) };
  }).sort((a, b) => (b.avg_days ?? -1) - (a.avg_days ?? -1));
}

/** One product's delivery-vs-FBA table by zone (for the sheet's click-through). */
async function zoneRows(asin: string, date: string | null) {
  const skus = [...new Set((await rows(supabase.from("barm_amazon_price_listing").select("seller_sku").eq("asin1", asin) as any)).map((l) => l.seller_sku).filter(Boolean))] as string[];
  const fDate = (await rows(supabase.from("mkt_fba_forecast_zone").select("report_date").order("report_date", { ascending: false }).limit(1) as any))[0]?.report_date ?? null;
  const forecast = fDate && skus.length ? await rows(supabase.from("mkt_fba_forecast_zone").select("sku,zone,orders_30d,current_stock,to_send").in("sku", skus).eq("report_date", fDate) as any) : [];
  const delivery = await rows((date ? supabase.rpc("mkt_delivery_zone_summary", { d: date, p_asin: asin }) : supabase.from("mkt_delivery_zone_mv").select("*").eq("asin", asin)) as any);
  return { forecast_date: fDate, rows: zoneCompare(delivery, forecast) };
}

/** One product's Amazon delivery checks by pincode: those scraped on `date`, else the latest per pincode. */
async function deliveryRows(asin: string, date: string | null) {
  const all = await allRows((a, b) => {
    let q = supabase.from("mkt_delivery_sweep").select("week,platform,pincode,tier,location,delivery_text,days,scraped_date,status").eq("asin_fsn", asin).eq("platform", "Amazon");
    if (date) q = q.eq("scraped_date", date);
    return q.order("week").order("pincode").range(a, b) as any;
  });
  const overrides = Object.fromEntries((await rows(supabase.from("mkt_pincode_state").select("pincode,state") as any)).map((o) => [o.pincode, o.state]));
  return latestByPincode(all, overrides);
}

// ── the full sheet: every product as one row, the template's column groups ──────────────────
// The heavy, rarely-changing sources (ad reports, Drive imports, competitor prices, delivery) are
// cached per delivery date for 10 minutes, and an expired copy is served if a reload fails (the
// database is often busy). The team's own typed fields are always read fresh.
const SHEET_TTL_MS = 10 * 60_000;
const sheetCache = new Map<string, { at: number; data: any }>();
const sheetInflight = new Map<string, Promise<any>>();
async function sheetBaseCached(deliveryDate: string | null) {
  const key = deliveryDate ?? "latest";
  const hit = sheetCache.get(key);
  if (hit && Date.now() - hit.at < SHEET_TTL_MS) return { ...hit.data, cachedAt: hit.at };
  let job = sheetInflight.get(key);
  if (!job) {
    job = sheetBase(deliveryDate).finally(() => sheetInflight.delete(key));
    sheetInflight.set(key, job);
  }
  try {
    const data = await job;
    sheetCache.set(key, { at: Date.now(), data });
    return { ...data, cachedAt: Date.now() };
  } catch (e) {
    if (hit) return { ...hit.data, cachedAt: hit.at, stale: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

async function sheetBase(deliveryDate: string | null) {
  const products = (await productList()).filter((p: any) => p.active || p.has_profile);
  const latestOf = async (table: string, col: string) => (await rows(supabase.from(table).select(col).order(col, { ascending: false }).limit(1) as any))[0]?.[col] ?? null;
  const [ratingDate, fcDate, zoneDate, kwWeek, spMax, gMax, mMax] = await Promise.all([
    latestOf("mkt_rating_weekly", "snapshot_date"), latestOf("mkt_fba_fc_stock", "report_date"), latestOf("mkt_fba_forecast_zone", "report_date"),
    latestOf("mkt_keyword_positions", "week"), latestOf("barm_daily_am_ads", "report_date"),
    latestOf("barm_daily_google_ad_spend", "report_end"), latestOf("barm_daily_social_media", "report_end"),
  ]);
  const since = spMax ? isoMinus(spMax, 6) : null;
  const [sdMax, sbMax] = await Promise.all([latestOf("barm_amazon_sd_campaign", "report_date"), latestOf("barm_amazon_sb_campaign", "report_date")]);
  const sdSince = sdMax ? isoMinus(sdMax, 6) : null, sbSince = sbMax ? isoMinus(sbMax, 6) : null;
  const [ratings, fcStock, zones, keywords, sp, sd, sb, google, meta, inv, botPrices, delivery, sdMaster, sbMaster, compWide, compPrices, zoneDelivery, deliveryDates] = await Promise.all([
    ratingDate ? allRows((a, b) => supabase.from("mkt_rating_weekly").select("asin_fsn,sku_id,this_star,this_count,last_count").eq("snapshot_date", ratingDate).order("sku_id").order("asin_fsn").range(a, b) as any) : [],
    fcDate ? allRows((a, b) => supabase.from("mkt_fba_fc_stock").select("asin,fc,disposition,quantity").eq("report_date", fcDate).order("fc").order("msku").order("disposition").range(a, b) as any) : [],
    zoneDate ? allRows((a, b) => supabase.from("mkt_fba_forecast_zone").select("sku,zone,orders_30d,current_stock,booked,intransit,to_send,alert_35d").eq("report_date", zoneDate).order("sku").order("zone").range(a, b) as any) : [],
    kwWeek ? allRows((a, b) => supabase.from("mkt_keyword_positions").select("asin,search_term,sp_position,organic_position").eq("week", kwWeek).order("search_term").order("asin").range(a, b) as any) : [],
    since ? allRows((a, b) => supabase.from("barm_daily_am_ads").select("id,advertised_asin:asin,spend").gte("report_date", since).order("id").range(a, b) as any) : [],
    sdSince ? allRows((a, b) => supabase.from("barm_amazon_sd_campaign").select("id,campaign_name,spend").gte("report_date", sdSince).order("id").range(a, b) as any) : [],
    sbSince ? allRows((a, b) => supabase.from("barm_amazon_sb_campaign").select("id,campaign_name,spend").gte("report_date", sbSince).order("id").range(a, b) as any) : [],
    gMax ? allRows((a, b) => supabase.from("barm_daily_google_ad_spend").select("id,campaign_name,spend").gte("report_end", isoMinus(gMax, 6)).order("id").range(a, b) as any) : [],
    mMax ? allRows((a, b) => supabase.from("barm_daily_social_media").select("id,campaign_name,spend").gte("report_end", isoMinus(mMax, 6)).order("id").range(a, b) as any) : [],
    rows(supabase.from("barm_amazon_fba_inventory").select("asin,afn_fulfillable_quantity,your_price") as any),
    allRows((a, b) => supabase.from("product_rating_review_metrics").select("id,marketplace_product_id,price").eq("platform", "Amazon").gt("price", 0).order("id").range(a, b) as any),
    // latest-per-pincode summaries are precomputed (mkt_delivery_*_mv, refreshed on import); a picked date is computed live
    deliveryDate ? rows(supabase.rpc("mkt_delivery_summary_on", { d: deliveryDate }) as any) : rows(supabase.from("mkt_delivery_summary_mv").select("*") as any),
    rows(supabase.from("am_display_ad_masters").select('"Display campaign name","ASIN"') as any),
    rows(supabase.from("brand_ads_master_sheet").select('"Campaign Name","ASIN"') as any),
    optionalAll((a, b) => supabase.rpc("mkt_competitor_ratings").order("our_sku").order("marketplace").order("slot").range(a, b) as any),
    optionalAll((a, b) => supabase.rpc("mkt_competitor_prices").order("our_sku").order("competitor_product_url").range(a, b) as any),
    deliveryDate
      ? allRows((a, b) => supabase.rpc("mkt_delivery_zone_summary", { d: deliveryDate }).order("asin").order("zone").range(a, b) as any)
      : allRows((a, b) => supabase.from("mkt_delivery_zone_mv").select("*").order("asin").order("zone").range(a, b) as any),
    rows(supabase.rpc("mkt_delivery_dates") as any),
  ]);
  return { products, ratingDate, fcDate, zoneDate, kwWeek, spMax, gMax, mMax, since, sdMax, sbMax, ratings, fcStock, zones, keywords, sp, sd, sb, google, meta, inv, botPrices, delivery, sdMaster, sbMaster, compWide, compPrices, zoneDelivery, deliveryDates };
}

async function fullSheet(deliveryDate: string | null) {
  const base = await sheetBaseCached(deliveryDate);
  const { products, ratingDate, fcDate, zoneDate, kwWeek, spMax, gMax, mMax, since, sdMax, sbMax, ratings, fcStock, zones, keywords, sp, sd, sb, google, meta, inv, botPrices, delivery, sdMaster, sbMaster, compWide, compPrices, zoneDelivery, deliveryDates } = base;
  // the team's own fields: always fresh, so an edit shows on the next load
  const [profiles, plan, influencers, notes, tamResearch] = await Promise.all([
    rows(supabase.from("mkt_product_profile").select("*") as any),
    rows(supabase.from("mkt_action_plan").select("asin,task,status,plan_date").order("id") as any),
    rows(supabase.from("mkt_influencer_posts").select("asin,kind,language") as any),
    allRows((a, b) => supabase.from("mkt_channel_notes").select("product,channel").order("product").order("channel").range(a, b) as any),
    rows(supabase.from("mkt_tam_research").select("*") as any),
  ]);
  const group = <T,>(xs: T[], key: (x: T) => string | null | undefined) => {
    const m = new Map<string, T[]>();
    for (const x of xs) { const k = key(x); if (k) m.set(k, [...(m.get(k) ?? []), x]); }
    return m;
  };
  const ratingBy = group(ratings, (r: any) => r.asin_fsn), fcBy = group(fcStock, (r: any) => r.asin), zoneBy = group(zones, (r: any) => r.sku);
  const kwBy = group(keywords, (r: any) => r.asin), spBy = group(sp, (r: any) => r.advertised_asin), invBy = group(inv, (r: any) => r.asin);
  const botPriceBy = new Map<string, number>();
  for (const b of botPrices) if (!botPriceBy.has(b.marketplace_product_id)) botPriceBy.set(b.marketplace_product_id, Number(b.price));
  const planBy = group(plan, (r: any) => r.asin), infBy = group(influencers, (r: any) => r.asin);
  const notesBy = group(notes, (r: any) => String(r.product).toLowerCase());
  const delBy = new Map(delivery.map((d: any) => [d.asin, d]));
  const profBy = new Map(profiles.map((p: any) => [p.asin, p]));
  const sdMap = group(sdMaster, (r: any) => r.ASIN), sbMap = group(sbMaster, (r: any) => r.ASIN);
  const yesFcs = new Set(FBA_ALERT_FCS.map((f) => f.code));
  const spendOf = (xs: any[]) => xs.reduce((a, x) => a + (Number(x.spend) || 0), 0);
  const byName = (xs: any[], names: string[] | null, words: string[]) =>
    xs.filter((x) => (names?.length ? names.includes(x.campaign_name) : words.some((w) => String(x.campaign_name).toLowerCase().includes(w.toLowerCase()))));
  const compRows: any[] = compPrices.rows;
  const zoneDelBy = group(zoneDelivery, (z: any) => z.asin);

  const priceOf = (p: any) => ourSellingPrice(botPriceBy.get(p.asin), (invBy.get(p.asin) ?? []).find((x: any) => Number(x.your_price) > 0)?.your_price, p.price);
  const tamBy = new Map(tamResearch.map((t: any) => [t.group_key, t]));
  const tamOf = (name: string | null, price: number | null) => tamInfo(tamBy.get(tamGroup(name) ?? ""), tamGroup(name), price);
  const out = products.map((p: any) => {
    const prof: any = profBy.get(p.asin) ?? null;
    const words = campaignKeywords(prof?.ad_keywords, p.name);
    const r = (ratingBy.get(p.asin) ?? []).find((x: any) => x.this_star !== null) ?? (ratingBy.get(p.asin) ?? [])[0];
    const fc = (fcBy.get(p.asin) ?? []).filter((x: any) => /sellable/i.test(x.disposition) && !/unsellable/i.test(x.disposition));
    const fcQty = new Map<string, number>();
    for (const x of fc) fcQty.set(x.fc, (fcQty.get(x.fc) ?? 0) + Number(x.quantity));
    const z = p.skus.flatMap((s: string) => zoneBy.get(s) ?? []);
    const kw = kwBy.get(p.asin) ?? [];
    const bestOrg = kw.filter((k: any) => k.organic_position !== null).sort((a: any, b: any) => a.organic_position - b.organic_position)[0];
    const bestSp = kw.filter((k: any) => k.sp_position !== null).sort((a: any, b: any) => a.sp_position - b.sp_position)[0];
    const sdNames = (sdMap.get(p.asin) ?? []).map((m: any) => m["Display campaign name"]);
    const sbNames = (sbMap.get(p.asin) ?? []).map((m: any) => m["Campaign Name"]);
    const sdRows = sdMax ? byName(sd, sdNames, words) : null, sbRows = sbMax ? byName(sb, sbNames, words) : null;
    const g = gMax && words.length ? byName(google, null, words) : null, m = mMax && words.length ? byName(meta, null, words) : null;
    const spRows = spBy.get(p.asin) ?? [];
    const infl = infBy.get(p.asin) ?? [];
    const pl = planBy.get(p.asin) ?? [];
    const open = pl.filter((x: any) => x.status !== "Done");
    const topComp = topCompetitorRating(compWide.rows.filter((c: any) => ratingRowMatches(c.our_sku, p.skus)).map((c: any) => ({ marketplace: c.marketplace, product_name: c.product_name, url: c.url, rating: c.rating === null ? null : Number(c.rating), reviews: c.reviews === null ? null : Number(c.reviews), match_status: c.match_status })));
    const orders30 = z.reduce((a: number, x: any) => a + (Number(x.orders_30d) || 0), 0);
    const d: any = delBy.get(p.asin);
    const zc = zoneCompare(zoneDelBy.get(p.asin) ?? [], z);
    const lowest = compRows.filter((c) => ourProduct(c, p.asin, p.skus)).sort((a: any, b: any) => Number(a.competitor_price) - Number(b.competitor_price))[0];
    const slowNoOrders = zc.filter((x) => x.verdict.code === "slow-no-orders");
    const worst = zc.find((x) => x.avg_days !== null); // zoneCompare sorts slowest first
    return {
      asin: p.asin, name: p.name, skus: p.skus, category: p.category, link: `https://www.amazon.in/dp/${p.asin}`,
      tam: prof?.tam_value ?? null, primary: prof?.primary_audience ?? null, secondary: prof?.secondary_audience ?? null,
      star: r?.this_star ?? null, ratings: r?.this_count ?? null, ratings_change: r && r.this_count !== null && r.last_count !== null ? r.this_count - r.last_count : null,
      comp_star: topComp?.rating ?? null, comp_reviews: topComp?.reviews ?? null, comp_rating_same: topComp?.same ?? null, comp_rating_name: topComp?.product_name ?? null, comp_rating_url: topComp?.url ?? null,
      price: priceOf(p).price, price_source: priceOf(p).source, mrp: priceOf(p).mrp,
      comp_lowest: compPrices.blocked ? null : lowest ? { price: Number(lowest.competitor_price), name: lowest.competitor_product_name, seller: lowest.competitor_seller_name, marketplace: lowest.competitor_marketplace, url: lowest.competitor_product_url, match: lowest.match_status } : null,
      ads_suggestion: adsSuggestion({
        fcKnown: !!fcDate, fcStocked: [...yesFcs].filter((c) => (fcQty.get(c) ?? 0) > 0).length, fcOnboarded: yesFcs.size,
        fcLow: [...yesFcs].filter((c) => { const q = fcQty.get(c) ?? 0; return q > 0 && q <= ADS_LOW_UNITS; }).length,
        star: r?.this_star === null || r?.this_star === undefined ? null : Number(r.this_star),
        ourPrice: priceOf(p).price, compPrice: lowest && !compPrices.blocked ? Number(lowest.competitor_price) : null,
        adOn: since ? spendOf(spRows) > 0 : false,
      }),
      fba_weight: prof?.fba_weight_note ?? null,
      retarget_yes: prof ? Object.entries(prof.retarget ?? {}).filter(([, v]) => v).map(([k]) => k) : null,
      ad_product: since ? adState(spRows.length ? spendOf(spRows) : 0) : "No data",
      ad_display: sdRows === null ? "No data" : sdRows.length ? adState(spendOf(sdRows)) : "Not set up",
      ad_brand: sbRows === null ? "No data" : sbRows.length ? adState(spendOf(sbRows)) : "Not set up",
      fba_available: invBy.get(p.asin)?.reduce((a: number, x: any) => a + (Number(x.afn_fulfillable_quantity) || 0), 0) ?? null,
      fc_stocked: [...yesFcs].filter((c) => (fcQty.get(c) ?? 0) > 0).length, fc_onboarded: yesFcs.size,
      fc_units: fcDate ? [...fcQty.values()].reduce((a, b) => a + b, 0) : null,
      inbound: z.length ? z.reduce((a: number, x: any) => a + (Number(x.booked) || 0) + (Number(x.intransit) || 0), 0) : null,
      sales_30d: z.length ? orders30 : null, need_120d: z.length ? orders30 * 4 : null,
      zones_short: z.length ? z.filter((x: any) => x.alert_35d && x.alert_35d !== "OK").length : null, zones: z.length || null,
      to_send: z.length ? z.reduce((a: number, x: any) => a + (Number(x.to_send) || 0), 0) : null,
      kw_terms: kw.length || null, best_organic: bestOrg ? { pos: bestOrg.organic_position, term: bestOrg.search_term } : null, best_ad: bestSp ? { pos: bestSp.sp_position, term: bestSp.search_term } : null,
      google: g === null ? "No data" : adState(spendOf(g)), meta: m === null ? "No data" : adState(spendOf(m)),
      infl_organic: infl.filter((x: any) => x.kind !== "ads").length, infl_ads: infl.filter((x: any) => x.kind === "ads").length,
      infl_languages: [...new Set(infl.map((x: any) => x.language).filter(Boolean))],
      content: prof?.content ?? null,
      delivery: d ? { pincodes: d.pincodes, fast: d.fast, slow: d.slow, unavailable: d.unavailable, avg_days: d.avg_days, last_checked: d.last_checked } : null,
      plan_open: pl.length ? open.length : null, plan_next: open[0]?.task ?? null,
      notes: (notesBy.get(String(p.name).toLowerCase()) ?? []).length,
      zone_slow_no_orders: zc.length ? slowNoOrders.length : null,
      zone_worst: worst ? { zone: worst.zone, avg: worst.avg_days, max: worst.max_days } : null,
      tam_suggest: tamOf(p.name, priceOf(p).price),
    };
  });
  return {
    rows: out,
    asOf: { rating: ratingDate, fc: fcDate, forecast: zoneDate, positions: kwWeek, amazonAds: since ? { from: since, to: spMax } : null, amazonDisplay: sdMax, amazonBrand: sbMax, google: gMax, meta: mMax },
    competitorBlocked: compWide.blocked ?? compPrices.blocked,
    deliveryDate, deliveryDates, cachedAt: base.cachedAt, stale: base.stale ?? null,
  };
}

export async function GET(req: Request) {
  const rejected = rejectUnlessAllowed(req, checkSession, { bucket: "marketing-360", limit: 120, windowMs: 60_000 });
  if (rejected) return rejected;
  try {
    const params = new URL(req.url).searchParams;
    const date = params.get("date");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be yyyy-mm-dd" }, { status: 400 });
    if (params.get("sheet")) return NextResponse.json(await fullSheet(date));
    if (params.get("sources")) return NextResponse.json(await sources());
    const zonesAsin = params.get("zones");
    if (zonesAsin) {
      if (!ASIN.test(zonesAsin)) return NextResponse.json({ error: "zones must be a 10-character Amazon ASIN" }, { status: 400 });
      return NextResponse.json(await zoneRows(zonesAsin, date));
    }
    const deliveryAsin = params.get("delivery");
    if (deliveryAsin) {
      if (!ASIN.test(deliveryAsin)) return NextResponse.json({ error: "delivery must be a 10-character Amazon ASIN" }, { status: 400 });
      return NextResponse.json({ rows: await deliveryRows(deliveryAsin, date) });
    }
    const asin = params.get("asin");
    if (!asin) return NextResponse.json({ products: await productList() });
    if (!ASIN.test(asin)) return NextResponse.json({ error: "asin must be a 10-character Amazon ASIN" }, { status: 400 });
    return NextResponse.json(await card(asin));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** The TAM suggestion shown for a product: its audience group, the researched buyers (with sources), and
 *  buyers × our selling price. Null value when the group has no researched figure yet. */
function tamInfo(t: any, group: string | null, price: number | null) {
  if (!group) return null;
  return {
    group, price, value: tamSuggestion(t?.buyers ? Number(t.buyers) : null, price),
    buyers: t?.buyers ? Number(t.buyers) : null, definition: t?.buyer_definition ?? null, derivation: t?.derivation ?? null,
    sources: t?.sources ?? [], confidence: t?.confidence ?? null, note: t?.note ?? null, researched: !!t,
  };
}

/** "Where this data comes from": how far each source's stored copy runs (user, 2026-11-18). One small
 *  query per source; a source the anon key cannot read shows as missing instead of failing the panel. */
async function sources() {
  const one = async (q: PromiseLike<Q>, col: string): Promise<string | null> => {
    try { return (await rows(q))[0]?.[col] ?? null; } catch { return null; }
  };
  const latest = (table: string, col: string, f?: (q: any) => any) => {
    let q: any = supabase.from(table).select(col);
    if (f) q = f(q);
    return one(q.order(col, { ascending: false }).limit(1), col);
  };
  const [rating, fc, forecast, positions, delivery, amazonAds, amazonDisplay, amazonBrand, google, meta, compPrices, compRatingsWeek, fbaReport, priceListing, botPrice] = await Promise.all([
    latest("mkt_rating_weekly", "snapshot_date"), latest("mkt_fba_fc_stock", "report_date"), latest("mkt_fba_forecast_zone", "report_date"),
    latest("mkt_keyword_positions", "week"),
    // the latest check date from mkt_delivery_dates() (sorting the ~60k sweep rows directly is too slow for the anon key)
    one(supabase.rpc("mkt_delivery_dates").select("scraped_date").order("scraped_date", { ascending: false }).limit(1) as any, "scraped_date"),
    latest("barm_daily_am_ads", "report_date"), latest("barm_amazon_sd_campaign", "report_date"), latest("barm_amazon_sb_campaign", "report_date"),
    latest("barm_daily_google_ad_spend", "report_end"), latest("barm_daily_social_media", "report_end"),
    one(supabase.rpc("mkt_competitor_prices").select("last_checked_at").order("last_checked_at", { ascending: false, nullsFirst: false }).limit(1) as any, "last_checked_at"),
    one(supabase.rpc("mkt_competitor_ratings").select("week_tag").order("week_tag", { ascending: false }).limit(1) as any, "week_tag"),
    latest("barm_amazon_fba_inventory", "created_at"), latest("barm_amazon_price_listing", "created_at"),
    latest("product_rating_review_metrics", "updated_at", (q) => q.eq("platform", "Amazon")),
  ]);
  const dates: SourceDates = { rating, fc, forecast, positions, delivery, amazonAds, amazonDisplay, amazonBrand, google, meta, compPrices, compRatingsWeek, fbaReport, priceListing, botPrice };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return { today, dates, rows: sourceRows(dates, today) };
}
