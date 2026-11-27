// Bundled for deploy (26 Nov 2026 IST): src/lib/adSpendReportExport.ts of Vercel commit 96dea9c with its src/lib deps,
// amazonReportUpload/siteUrl replaced by Deno stand-ins (same as v62). Source of truth = that commit.
// src/lib/adSpendReportExport.ts
import XLSX4 from "npm:xlsx-js-style@1.2.0";

// supabase/edge-build/ad-spend-report-shims/amazonReportUpload.ts
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
var supabasePublic = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_ANON_KEY"));
async function upsertInChunks(table, rows, onConflict, chunkSize = 300) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabasePublic.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  }
}

// src/lib/amazonSpendRules.ts
var key = (campaign, date) => `${campaign}\0${date}`;
function spCampaignDays(spRows) {
  const out = /* @__PURE__ */ new Set();
  for (const r of spRows) {
    const c = String(r.campaign_name ?? "").trim();
    const d = String(r.report_date ?? "").slice(0, 10);
    if (c && d) out.add(key(c, d));
  }
  return out;
}
function isSplitCoveredCampaignRow(r, spDays) {
  const c = String(r.campaign_name ?? "").trim();
  const d = String(r.report_date ?? "").slice(0, 10);
  return !!c && !!d && spDays.has(key(c, d));
}
function collectSkuLessSpend(rows) {
  const byCampaign = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const d = String(r.report_date ?? "").slice(0, 10);
    const spend = Number(r.spend) || 0;
    if (!d || spend <= 0 || String(r.advertised_sku ?? "").trim()) continue;
    const c = String(r.campaign_name ?? "").trim();
    if (!c) {
      const e2 = byDay.get(d) || { report_date: d, spend: 0, rows: 0 };
      e2.spend += spend;
      e2.rows += 1;
      byDay.set(d, e2);
      continue;
    }
    const adType = /^(sd|sponsored display)$/i.test(String(r.ad_type ?? "").trim()) ? "SD" : "SB";
    const k = `${adType}|${key(c, d)}`;
    const e = byCampaign.get(k) || { report_date: d, campaign_name: c, ad_type: adType, spend: 0, rows: 0 };
    e.spend += spend;
    e.rows += 1;
    byCampaign.set(k, e);
  }
  const byDateThenName = (a, b) => a.report_date.localeCompare(b.report_date) || String(a.campaign_name ?? "").localeCompare(String(b.campaign_name ?? ""));
  return { campaignDays: [...byCampaign.values()].sort(byDateThenName), unattributable: [...byDay.values()].sort(byDateThenName) };
}
function unmappedCampaignSpend(rows, isMapped) {
  const out = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const spend = Number(r.spend) || 0;
    const c = String(r.campaign_name ?? "").trim();
    if (spend <= 0 || isMapped(String(r.campaign_name ?? ""))) continue;
    const e = out.get(c) || { campaign_name: c, spend: 0, dates: /* @__PURE__ */ new Set() };
    e.spend += spend;
    e.dates.add(String(r.report_date ?? "").slice(0, 10));
    out.set(c, e);
  }
  return [...out.values()].map((e) => ({ campaign_name: e.campaign_name, spend: e.spend, dates: [...e.dates].sort() })).sort((a, b) => b.spend - a.spend);
}
function campaignsMissingOnDay(sbSdRows, spRows, day) {
  const seenOnDay = /* @__PURE__ */ new Set();
  const lastRow = /* @__PURE__ */ new Map();
  const visit = (r) => {
    const c = String(r.campaign_name ?? "").trim();
    const d = String(r.report_date ?? "").slice(0, 10);
    if (!c || !d) return;
    if (d === day) {
      seenOnDay.add(c);
      return;
    }
    if (d > day) return;
    const spend = Number(r.spend) || 0;
    const prev = lastRow.get(c);
    if (!prev || d > prev.date) lastRow.set(c, { date: d, spend });
    else if (d === prev.date) prev.spend += spend;
  };
  sbSdRows.forEach(visit);
  spRows.filter((r) => !String(r.ad_group_name ?? "").trim()).forEach(visit);
  return [...lastRow.entries()].filter(([c, v]) => v.spend > 0 && !seenOnDay.has(c)).map(([campaign_name, v]) => ({ campaign_name, lastSpendDate: v.date, lastSpend: v.spend })).sort((a, b) => a.campaign_name.localeCompare(b.campaign_name));
}

// src/lib/amazonReportShared.ts
async function fetchAllRows(table, apply, orderBy = "id") {
  const all = [];
  const PAGE = 1e3;
  const orderCols = Array.isArray(orderBy) ? orderBy : [orderBy];
  let from = 0;
  for (let i = 0; i < 200; i++) {
    let q = apply(supabasePublic.from(table).select("*"));
    for (const col of orderCols) q = q.order(col, { ascending: true });
    let error = null;
    let rows = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await q.range(from, from + PAGE - 1);
      error = res.error;
      if (!error) {
        rows = res.data || [];
        break;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`);
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}
function isCancelledOrder(r) {
  return String(r.order_status || "").trim().toLowerCase().startsWith("cancel");
}
function isStandardOrderId(orderId) {
  return /^\d{3}-\d{7}-\d{7}$/.test(String(orderId || "").trim());
}
function istDayWindowUtc(start, end) {
  const prevDay = (iso) => {
    const d = /* @__PURE__ */ new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  return { gte: `${prevDay(start)}T18:30:00.000Z`, lt: `${end}T18:30:00.000Z` };
}

// src/lib/amazonAdSourceRules.ts
var SKU_LESS_SOURCE = "AM ads (no Advertised SKU)";
function firstRaw(r) {
  const raw = Array.isArray(r?.raw) ? r.raw[0] : r?.raw;
  return raw && typeof raw === "object" ? raw : null;
}
function isCampaignCardRow(r) {
  return firstRaw(r)?.source !== SKU_LESS_SOURCE;
}
var dayCampaign = (date, campaign) => `${String(date ?? "").slice(0, 10)}|${String(campaign ?? "").trim()}`;
var num = (v) => Number(v) || 0;
function dailyAmAdsReportRows(dailyRows, cardSbRows, cardSdRows) {
  const spRows = [];
  const skuLessInput = [];
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
        raw: r.raw
      });
    } else {
      skuLessInput.push({
        report_date,
        campaign_name: String(r.campaign_name ?? ""),
        ad_type: String(firstRaw(r)?.["Ad Type"] ?? ""),
        advertised_sku: "",
        spend: num(r.spend)
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

// src/lib/socialMediaRules.ts
var META_AD_SEPARATOR = " :: ";
function metaCampaignPart(name) {
  const i = name.indexOf(META_AD_SEPARATOR);
  return i >= 0 ? name.slice(0, i) : name;
}

// src/lib/googleWebsiteOrders.ts
var num2 = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
var cents = (v) => Math.round(v * 100);
var isShopifyExportRow = (r) => /^SHOPIFY-/i.test(String(r.invoice ?? ""));
function mergeGoogleWebsiteOrders(cardRows, shopifyOrders) {
  const shopifyFrom = shopifyOrders.reduce((m, o) => o.order_date && (!m || o.order_date < m) ? o.order_date : m, null);
  const shopifyLines = [...shopifyOrders].sort((a, b) => a.order_name.localeCompare(b.order_name, void 0, { numeric: true })).flatMap(
    (o) => o.items.map((i) => {
      const quantity = num2(i.quantity);
      const value = i.line_total == null || i.line_total === "" ? quantity * num2(i.price) : num2(i.line_total);
      return { o, i, quantity, value, unitPrice: num2(i.price), used: false };
    })
  );
  const matchKey = (date, unitPrice, quantity) => `${date}|${cents(unitPrice)}|${quantity}`;
  const unmatched = /* @__PURE__ */ new Map();
  shopifyLines.forEach((l) => {
    const k = matchKey(l.o.order_date, l.unitPrice, l.quantity);
    unmatched.set(k, [...unmatched.get(k) ?? [], l]);
  });
  const lines = [];
  const dropped = [];
  [...cardRows].sort((a, b) => num2(a.id) - num2(b.id)).forEach((r) => {
    const date = r.order_date ?? "";
    const quantity = num2(r.quantity);
    const price = num2(r.price);
    const value = quantity * price;
    const covered = !!shopifyFrom && !!date && date >= shopifyFrom;
    if (covered) {
      const match = unmatched.get(matchKey(date, price, quantity))?.find((l) => !l.used);
      if (match) match.used = true;
      if (match || isShopifyExportRow(r)) {
        dropped.push({ invoice: String(r.invoice ?? ""), date, value, matchedOrder: match ? match.o.order_name : null });
        return;
      }
    }
    lines.push({
      date,
      name: String(r.product_name ?? "").replace(/\s+/g, " ").trim() || "(no product name)",
      quantity,
      price,
      value,
      source: "card",
      order: null,
      googleAds: false
    });
  });
  shopifyLines.filter((l) => !l.o.is_cancelled).forEach((l) => {
    const title = String(l.i.title ?? "").replace(/\s+/g, " ").trim() || "(no product name)";
    lines.push({
      date: l.o.order_date,
      name: title,
      quantity: l.quantity,
      price: l.quantity ? l.value / l.quantity : l.unitPrice,
      value: l.value,
      source: "shopify",
      order: l.o.order_name,
      googleAds: l.o.ad_channel === "google_ads"
    });
  });
  return { lines, dropped, shopifyFrom };
}
function googleAdsRatios(spend, adSales) {
  if (!(spend > 0)) return { acos: null, roas: null };
  return {
    acos: adSales > 0 ? spend / adSales : null,
    roas: adSales / spend
  };
}
function metaAdsAttributedSales(shopifyOrders, start, end) {
  let value = 0;
  let orders = 0;
  shopifyOrders.filter((o) => !o.is_cancelled && o.ad_channel === "meta_ads" && o.order_date >= start && o.order_date <= end).forEach((o) => {
    orders += 1;
    value += o.items.reduce((s, i) => s + (i.line_total == null || i.line_total === "" ? num2(i.quantity) * num2(i.price) : num2(i.line_total)), 0);
  });
  return { value: Math.round(value * 100) / 100, orders };
}

// src/lib/meeshoReportUpload.ts
import * as XLSX from "npm:xlsx@0.18.5";
function str(v) {
  if (v === null || v === void 0) return "";
  return String(v).trim();
}
var MONTH_ABBR = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12"
};
function toDate(v) {
  if (typeof v === "number" && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = str(v);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[0];
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const dMonY = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
  if (dMonY) {
    const mon = MONTH_ABBR[dMonY[2].toLowerCase()];
    if (mon) {
      const year = dMonY[3].length === 2 ? `20${dMonY[3]}` : dMonY[3];
      return `${year}-${mon}-${dMonY[1].padStart(2, "0")}`;
    }
  }
  const monDY = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (monDY) {
    const mon = MONTH_ABBR[monDY[1].slice(0, 3).toLowerCase()];
    if (mon) return `${monDY[3]}-${mon}-${monDY[2].padStart(2, "0")}`;
  }
  return null;
}

// src/lib/categoryMap.ts
var CATEGORY_ENTRIES = [
  ["Gluco Spark Bare Sugar test device (Inhouse& in FBA)", "General"],
  ["gluco spark Meter With 10 Strips & 10 lancets", "General"],
  ["gluco spark Meter With 25 Strips & 25 lancets", "General"],
  ["gluco spark Meter With 50 Strips & 25 lancets", "General"],
  ["gluco spark Meter With 50 Strips & 50 lancets", "General"],
  ["Gluco spark (Pack of 25) Strips", "General"],
  ["Gluco spark (Pack of 50) Strips", "General"],
  ["Glucospark 50 strips and 100 lancets (without meter)", "General"],
  ["Glucospark 100 strips and 100 lancets (without meter)", "General"],
  ["Gluco spark (Pack of 100) Strips", "General"],
  ["Lancing device", "General"],
  ["Pack of 100 lancets", "General"],
  ["Lactospark Lactate meter 25 strips and 25 lancets", "General"],
  ["Lactospark Lactatemeter25 strips", "General"],
  ["Lactospark Strips (Pack of 50)", "General"],
  ["Mesh nebulizer MY123", "Pulmonology"],
  ["Mesh Nebulizer MY135B (Grey)", "Pulmonology"],
  ["Mesh nebulizer MY135B (Blue)", "Pulmonology"],
  ["Meditubes Winset IV set pack of 25", "General"],
  ["Neck traction pillow (Blue)", "General"],
  ["Neck traction pillow (green)", "General"],
  ["Sonmol Peak Flow meter (without BLE)", "Pulmonology"],
  ["Sonmol Peak Flow meter (with BLE)", "Pulmonology"],
  ["Sonmol RMT without manometer (Inhouse and FBA)", "Pulmonology"],
  ["Sonmol RMT with manometer", "Pulmonology"],
  ["Sonmol Mucus removal Device", "Pulmonology"],
  ["MIR SmartOne", "Pulmonology"],
  ["MIR Spirobank Oxi", "Pulmonology"],
  ["MIR Spirobank Smart", "Pulmonology"],
  ["Hemospark STD without strips", "General"],
  ["Hemo meter whole KIT (50 Strips + STD incl 25 lancets)", "General"],
  ["Hemospark 50 strips", "General"],
  ["Hemospark 25 strips and 25 lancets", "General"],
  ["Nascool nasal power suction irrigation system", "Pulmonology"],
  ["Sonmol Anti Choking Device", "General"],
  ["Nail cleaning device", "General"],
  ["Insect bite healer", "General"],
  ["Suture Practice Kit - combo 2", "General"],
  ["Ovulation thermometer", "Gynaecology"],
  ["Breast Shell (New Model)", "Gynaecology"],
  ["Therapressure brush (White)", "Occupational Therapy"],
  ["Sensory brush", "Occupational Therapy"],
  ["Therapressure Brush (Green)", "Occupational Therapy"],
  ["Freezer analog thermometer", "General"],
  ["Suture Practice pad- Big size", "General"],
  ["Baby nasal aspirator (hand pump-Pink)", "Pulmonology"],
  ["Chewy tube MW (Green)", "Occupational Therapy"],
  ["Chewy tube (Green - Spiral model)", "Occupational Therapy"],
  ["Chewy tube (Yellow)", "Occupational Therapy"],
  ["Chewy tube (Yellow) - Spiral model", "Occupational Therapy"],
  ["Chewy tube (Blue)", "Occupational Therapy"],
  ["Chewy tube (Blue) - Spiral model", "Occupational Therapy"],
  ["Chewy tube (Red)", "Occupational Therapy"],
  ["Chewy tube (Red) - Spiral model", "Occupational Therapy"],
  ["Pelvic muscle floor trainer (screw type) - Blue", "Gynaecology"],
  ["Pelvic muscle floor trainer (screw type) - Pink", "Gynaecology"],
  ["Self Hook therapy stick Blue", "General"],
  ["Pelvic muscle floor trainer (digital type) - Black", "Gynaecology"],
  ["Pelvic muscle floor trainer (digital type) - Purple", "Gynaecology"],
  ["Cradle Comb (Blue-Bear)", "General"],
  ["Vaginal dilator", "Gynaecology"],
  ["Chewy tube Combo (Pack of 4)", "Occupational Therapy"],
  ["Chewy tube Combo (Pack of 3)", "Occupational Therapy"],
  ["Nylon 19mm Suture Thread", "General"],
  ["Nylon 24mm Suture Thread", "General"],
  ["Silk 19mm Suture Thread", "General"],
  ["Polypropylene 19mm Suture Thread", "General"],
  ["Baby nasal aspirator - hand pump (white model)", "Pulmonology"],
  ["Contact lens cleaner", "General"],
  ["Cradle cap kit (Set of 3)", "Occupational Therapy"],
  ["Cradle cap scrub", "Occupational Therapy"],
  ["Cradle cap brush", "Occupational Therapy"],
  ["Cradle cap comb - double sided", "General"],
  ["Postpartum Recovery Essentials care kit (10 pcs kit)", "Gynaecology"],
  ["Perineal Healing foam", "Gynaecology"],
  ["Instant Ice Maxi Pad(Pack of 5)", "Gynaecology"],
  ["Perineal Cooling Pad Liner", "Gynaecology"],
  ["Postpartum Underwears", "Gynaecology"],
  ["Postpartum Recovery Essentials care kit (6 pcs kit)", "Gynaecology"],
  ["Nail fungus cleaning device (new)", "General"],
  ["Choking rescue device", "General"],
  ["Cutlery Holder with Plastic stand (Black)", "General"],
  ["Cutlery Holder with Plastic stand (Brown)", "General"],
  ["Cutlery Holder with Plastic stand (Peach)", "General"],
  ["Cutlery Holder with Plastic stand (Ivory)", "General"],
  ["Cutlery Holder with Plastic stand (Blue)", "General"],
  ["Cutlery Holder with Plastic stand (Yellow)", "General"],
  ["Respiratory Muscle Trainer (I6E6)", "Pulmonology"],
  ["Nasal syringe aspirator pack of 2", "Pulmonology"],
  ["Nasal syringe aspirator pack of 4", "Pulmonology"],
  ["Silicone Tip", "General"],
  ["Syringes for nasal aspirator", "Pulmonology"],
  ["Nylon 2-0 19mm suture thread", "General"],
  ["Silk 2-0 19mm suture thread", "General"],
  ["Polypropylene 2-0 19mm suture thread", "General"],
  ["Sensory Fidget toy", "Occupational Therapy"],
  ["Venom extractor", "General"],
  ["RMT (Black) - white print model", "Pulmonology"],
  ["RMT (Black) - Black print model", "Pulmonology"],
  ["Warming Lactation Massager (Dark Pink)", "Gynaecology"],
  ["Warming Lactation Massager (Green)", "Gynaecology"],
  ["Sensory Book", "Occupational Therapy"],
  ["Sensory Brush-New Model", "Occupational Therapy"],
  ["Electric baby nasal aspirator- Blue", "General"],
  ["Electric baby nasal aspirator- Yellow", "General"],
  ["Instant Breast warmers (Blue)", "Gynaecology"],
  ["Instant Breast warmers (Red)", "Gynaecology"],
  ["Wearable breast pump", "Gynaecology"],
  ["Self Hook Therapy Stick Black", "General"],
  ["Transparent Human Model", "General"],
  ["Semi- Transparent Human Model", "General"],
  ["Glow in the Dark Model", "General"],
  ["Pregnancy kit combo without Ovulation thermometer", "Gynaecology"],
  ["Pregnancy kit combo with Ovulation thermometer", "Gynaecology"],
  ["Self Hook Therapy Stick (Pink)", "General"],
  ["RMT with ERMT App", "Pulmonology"],
  ["Digital pelvic muscle trainer- new model", "Gynaecology"],
  ["Guasha Massager", "General"],
  ["RMT with Jawline Exerciser", "Pulmonology"],
  ["MRD with filter", "Pulmonology"],
  ["MRD Grey", "Pulmonology"],
  ["IQ puzzles (normal)", "Occupational Therapy"],
  ["IQ puzzles (Autism)", "Occupational Therapy"],
  ["Kids Microscope pink", "General"],
  ["Kids Microscope White", "General"],
  ["Wearable lactation massager (Purple)", "Gynaecology"],
  ["Wearable lactation massager (Grey)", "Gynaecology"],
  ["IR therpy lamp and holder", "General"],
  ["Anti- cellulite massager", "General"],
  ["Headache Relief tool pack of 2", "General"],
  ["Headache Relief tool pack of 3", "General"],
  ["Headache Relief tool pack of 4", "General"],
  ["Headache Relief tool pack of 5", "General"],
  ["Headache Relief tool pack of 1", "General"],
  ["Electric guasha massager", "General"],
  ["Insemination kit (Pack of 2)", "Gynaecology"],
  ["Insemination kit (Pack of 5)", "Gynaecology"],
  ["IUI Catheter and Syringes(Insemination kit)", "Gynaecology"],
  ["Collection Cup (Insemination kit)", "Gynaecology"],
  ["Suture Practice Kit - combo 3", "General"],
  ["Suture Practice Kit - combo 1", "General"],
  ["Breast shell 50ML Capacity (Model 3)", "Gynaecology"],
  ["Sensory fidget toy large model", "Occupational Therapy"],
  ["Breast shell SS model", "Gynaecology"],
  ["Hydrogel nipple pad pack of 2", "Gynaecology"],
  ["Hydrogel nipple pad pack of 4", "Gynaecology"],
  ["Hydrogel nipple pad", "Gynaecology"],
  ["Suture pad Defective", "General"],
  ["Soft Vaginal Dilator", "Gynaecology"],
  ["Jaw grading bite blocks (Pack of 1)", "Occupational Therapy"],
  ["Jaw grading bite blocks (Pack of 2)", "Occupational Therapy"],
  ["Postpartum Belt - Grey", "Gynaecology"],
  ["Oral swabs pack of 50", "General"],
  ["Oral swabs pack of 100", "General"],
  ["Wearable breast pump bottle type", "Gynaecology"],
  ["Electric guasha massager (Pink)", "General"],
  ["IR thermometer White", "General"],
  ["IR thermometer Black", "General"],
  ["Wearable Breast pump with Base", "Gynaecology"],
  ["BP monitor with Bluetooth", "General"],
  ["BP monitor without Bluetooth", "General"],
  ["RMT Black pack of 2", "Pulmonology"],
  ["Bulb Syringe IUI applicator -8cm(Pack of 5)", "Gynaecology"],
  ["Ovulation cassette (Pack of 5)", "Gynaecology"],
  ["Ovulation Strips (Pack of 5)", "Gynaecology"],
  ["Articulation Spoon", "Occupational Therapy"],
  ["MRD Blue", "Pulmonology"],
  ["MRD Violet", "Pulmonology"],
  ["MRD Pink", "Pulmonology"],
  ["Postpartum Belt- Green lines", "Gynaecology"],
  ["Lip Muscle Trainer", "Occupational Therapy"],
  ["Hand therapy putty- Blue", "Occupational Therapy"],
  ["Male Fertility Kit", "Gynaecology"],
  ["Mesh nebulizer - 3 modes", "Pulmonology"],
  ["Conception Cup", "Gynaecology"],
  ["Soft and Plastic VD combo", "Gynaecology"],
  ["Air purifier", "General"],
  ["Jaw trainer tool- red", "Occupational Therapy"],
  ["Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)", "Gynaecology"],
  ["Oral Muscle trainer- 3 heads", "Occupational Therapy"],
  ["Insemination Dual kit (Pack of 4)", "Gynaecology"],
  ["Insemination Dual kit (Pack of 10)", "Gynaecology"],
  ["Oral Muscle trainer- 4 heads", "Occupational Therapy"],
  ["Male fertility kit supplier 1", "Gynaecology"],
  ["Tongue tip exerciser", "Occupational Therapy"],
  ["Oral muscle trainer- 5 heads", "Occupational Therapy"],
  ["Anti choking device- Red & Black", "General"],
  ["Anti choking device- Yellow & Blue", "General"],
  ["Automatic Choking device", "General"],
  ["Polyglactin suture thread", "General"],
  ["Polyglycolic suture thread", "General"],
  ["IR therapy lamp Red on glass", "General"],
  ["Mini Portable Bidet attachment", "Gynaecology"],
  ["Pregnancy soak salt", "Gynaecology"],
  ["Epsom salt - 250 grams", "General"],
  ["Epsom salt - 400 grams", "General"],
  ["Epsom salt - 900 grams", "General"],
  ["Ovulation strips (Pack of 10)", "Gynaecology"],
  ["Ovulation strips (Pack of 20)", "Gynaecology"],
  ["Eye patch Skin color- Pack of 10", "General"],
  ["Eye patch Skin color- Pack of 20", "General"],
  ["Eye patch Skin color- Pack of 30", "General"],
  ["Eye patch White color- Pack of 10", "General"],
  ["Eye patch White color- Pack of 20", "General"],
  ["Eye patch White color- Pack of 30", "General"],
  ["Nasal suction irrigator- Rechargeable", "Pulmonology"],
  ["C-Section Recovery kit- 15 pcs", "Gynaecology"],
  ["Hanging thermometer", "General"],
  ["Fertility-friendly lubricant", "Gynaecology"],
  ["Teething Tube Combo (Green Red Yellow)", "Occupational Therapy"],
  ["Refrigerator thermometer", "General"],
  ["Sitz bath tub", "Gynaecology"],
  ["Bulb Syringe IUI applicator (10.5 cm)(Pack of 5)", "Gynaecology"],
  ["Insemination Kit- Catheter type-12cm (Pack of 2)", "Gynaecology"],
  ["Insemination Kit- Catheter type-12cm (Pack of 5)", "Gynaecology"],
  ["Bulb Syringe IUI applicator (10.5 cm)(Pack of 2)", "Gynaecology"],
  ["Bulb Syringe IUI applicator -8cm(Pack of 2)", "Gynaecology"],
  ["Sitz Bath salt- 400 Grams", "Gynaecology"],
  ["Insemination Kit- Catheter type-15cm (Pack of 2)", "Gynaecology"],
  ["Insemination Kit- Catheter type-15cm (Pack of 5)", "Gynaecology"],
  ["Digital stethescope", "General"],
  ["Nylon suture thread 2-0 - 30MM", "General"],
  ["Nylon suture thread 2-0 - 24MM", "General"],
  ["Nylon Suture thread 4-0 - 30MM", "General"],
  ["Silk Suture thread 2-0- 30MM", "General"],
  ["Silk Suture thread 4-0- 30MM", "General"],
  ["Polypropylene suture thread 2-0 - 30MM", "General"],
  ["Polypropylene suture thread 4-0 - 30MM", "General"],
  ["Manual Breast pump", "Gynaecology"],
  ["IR Bulb", "General"],
  ["Guasha massage- Second Quality", "General"],
  ["Car Seat Belt adjuster for pregnant women", "Gynaecology"],
  ["Fetal Doppler", "Gynaecology"],
  ["Anti cellulite massager- Green", "General"],
  ["Nasal Wash Salt- 400 grams", "Pulmonology"],
  ["Cracked Nipple Spray", "Gynaecology"],
  ["Chewy tube combo- Red and green", "Occupational Therapy"],
  ["Chewy tube green- Pack of 2", "Occupational Therapy"],
  ["Speech Therapy Combo with 3 heads", "Occupational Therapy"],
  ["Postpartum Mini Kit", "Gynaecology"],
  ["Perineal Massage Wand- White", "Gynaecology"],
  ["Suture Practice Pad- Normal", "General"],
  ["Oral Swabs-White (Pack of 50)", "General"],
  ["Oral Swabs- White (Pack of 100)", "General"],
  ["Menopause test Cassette pack of 3", "Gynaecology"],
  ["Perineal Healing foam and padliners combo", "Gynaecology"],
  ["Insemination kit-17cm Supplier 2 (Pack of 2)", "Gynaecology"],
  ["Insemination kit-17cm Supplier 2 (Pack of 5)", "Gynaecology"],
  ["Rechargeble PeakFlow meter with Memory & Bluetooth", "Pulmonology"],
  ["Silver Nursing Cup- Regular", "Gynaecology"],
  ["Speech Therapy Combo with 5 heads", "Occupational Therapy"],
  ["Breastfeeding Essential Kit", "Gynaecology"],
  ["Silver Nursing Cup- Large", "Gynaecology"],
  ["Menopause Test Strips (Pack of 4)", "Gynaecology"],
  ["Chewy tube Green (Bump model New)", "Occupational Therapy"],
  ["UTI Test Strips (Pack of 4)", "Gynaecology"],
  ["Flange Finder Kit", "Gynaecology"],
  ["Human Anatomy Cube", "General"],
  ["Inflatable Donut Pillow", "Gynaecology"],
  ["Neem Wood Comb", "Gynaecology"],
  ["Flange Inserts for Breast Pump", "Gynaecology"],
  ["GlucoSpark Strips (Pack of 200)", "General"],
  ["GlucoSpark Strips (Pack of 150)", "General"],
  ["Eye Patch - Dark Colour (Pack of 10)", "General"]
];
var SKU_NAME_MAP = {
  "SCGSB1": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SCG-B-1": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SCGSB1-1": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "GS-BARE": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SC-GLUCO-BARE-1": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SCG-B-2": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SCG-B-3": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "GSB01": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SCGSB": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SC-GLUCO-BARE": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SCB": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SCB(1MG)": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "SCGSB1-S": "Gluco Spark Bare Sugar test device (Inhouse& in FBA)",
  "GS10S10L": "gluco spark Meter With 10 Strips & 10 lancets",
  "GS10S10L-1": "gluco spark Meter With 10 Strips & 10 lancets",
  "GS10S10L-2": "gluco spark Meter With 10 Strips & 10 lancets",
  "GS10S10L-3": "gluco spark Meter With 10 Strips & 10 lancets",
  "GS10S10L-4": "gluco spark Meter With 10 Strips & 10 lancets",
  "GS10S10L-5": "gluco spark Meter With 10 Strips & 10 lancets",
  "GS10S10L-S": "gluco spark Meter With 10 Strips & 10 lancets",
  "SCGS25SL": "gluco spark Meter With 25 Strips & 25 lancets",
  "SCGS25SL-1": "gluco spark Meter With 25 Strips & 25 lancets",
  "SCGS25SL-2": "gluco spark Meter With 25 Strips & 25 lancets",
  "SC3": "gluco spark Meter With 25 Strips & 25 lancets",
  "glucospark-glucometer-blue": "gluco spark Meter With 25 Strips & 25 lancets",
  "SCGS25SL-S": "gluco spark Meter With 25 Strips & 25 lancets",
  "SC-GLUCO-50S25L": "gluco spark Meter With 50 Strips & 25 lancets",
  "SC-GLUCO-50S25L-1": "gluco spark Meter With 50 Strips & 25 lancets",
  "SC-GLUCO-50S25L-2": "gluco spark Meter With 50 Strips & 25 lancets",
  "SC-GLUCO-50S25L-3": "gluco spark Meter With 50 Strips & 25 lancets",
  "SC-GLUCO-50S25L-4": "gluco spark Meter With 50 Strips & 25 lancets",
  "SC-GLUCO-50S25L-S": "gluco spark Meter With 50 Strips & 25 lancets",
  "GS50S50L": "gluco spark Meter With 50 Strips & 50 lancets",
  "GS50S50L-2": "gluco spark Meter With 50 Strips & 50 lancets",
  "GS50S50L-1": "gluco spark Meter With 50 Strips & 50 lancets",
  "GS50S50L-3": "gluco spark Meter With 50 Strips & 50 lancets",
  "GS50S50L-4": "gluco spark Meter With 50 Strips & 50 lancets",
  "GS50S50L-5": "gluco spark Meter With 50 Strips & 50 lancets",
  "GS50S50L-S": "gluco spark Meter With 50 Strips & 50 lancets",
  "SC25": "Gluco spark (Pack of 25) Strips",
  "GLUCO-STRIPS-PK25": "Gluco spark (Pack of 25) Strips",
  "GLUCO-STRIPS-PK25-1": "Gluco spark (Pack of 25) Strips",
  "SC25-S-1": "Gluco spark (Pack of 25) Strips",
  "SC25-S-2": "Gluco spark (Pack of 25) Strips",
  "GS25": "Gluco spark (Pack of 25) Strips",
  "SC25-1": "Gluco spark (Pack of 25) Strips",
  "SC25-2": "Gluco spark (Pack of 25) Strips",
  "SC25-3": "Gluco spark (Pack of 25) Strips",
  "SC-GLUCO-STR-PK25": "Gluco spark (Pack of 25) Strips",
  "GLUCO-STRIPS-PK50": "Gluco spark (Pack of 50) Strips",
  "SC50": "Gluco spark (Pack of 50) Strips",
  "SC50-S-1": "Gluco spark (Pack of 50) Strips",
  "SC50-S-2": "Gluco spark (Pack of 50) Strips",
  "SC50-S-3": "Gluco spark (Pack of 50) Strips",
  "SC50-1": "Gluco spark (Pack of 50) Strips",
  "SC50-2": "Gluco spark (Pack of 50) Strips",
  "SC50-3": "Gluco spark (Pack of 50) Strips",
  "SCGS50": "Gluco spark (Pack of 50) Strips",
  "SC-GLUCO-STR-PK50": "Gluco spark (Pack of 50) Strips",
  "SCG-50S100L": "Glucospark 50 strips and 100 lancets (without meter)",
  "SCG-50S100L-1": "Glucospark 50 strips and 100 lancets (without meter)",
  "SCG-50S100L-S": "Glucospark 50 strips and 100 lancets (without meter)",
  "SCG-100S100L": "Glucospark 100 strips and 100 lancets (without meter)",
  "SCG-100S100L-1": "Glucospark 100 strips and 100 lancets (without meter)",
  "SCG-100S100L-2": "Glucospark 100 strips and 100 lancets (without meter)",
  "SCG-100S100L-3": "Glucospark 100 strips and 100 lancets (without meter)",
  "SCG-100S100L-4": "Glucospark 100 strips and 100 lancets (without meter)",
  "SCG-100S100L-5": "Glucospark 100 strips and 100 lancets (without meter)",
  "SCG-100S100L-S": "Glucospark 100 strips and 100 lancets (without meter)",
  "SCG-100S100L-1-S": "Glucospark 100 strips and 100 lancets (without meter)",
  "GLUCO-STRIPS-PK100": "Gluco spark (Pack of 100) Strips",
  "GLUCO-STRIPS-PK100-1": "Gluco spark (Pack of 100) Strips",
  "GLUCO-STRIPS-PK100-2": "Gluco spark (Pack of 100) Strips",
  "GLUCO-STRIPS-PK100-3": "Gluco spark (Pack of 100) Strips",
  "GLUCO-STRIPS-PK100-4": "Gluco spark (Pack of 100) Strips",
  "GLUCO-STRIPS-PK100-5": "Gluco spark (Pack of 100) Strips",
  "GLUCO-STRIPS-PK100-S": "Gluco spark (Pack of 100) Strips",
  "GLUCO-STRIPS-PK100-1-S": "Gluco spark (Pack of 100) Strips",
  "SCGLD": "Lancing device",
  "SC-LACTO-25S25L": "Lactospark Lactate meter 25 strips and 25 lancets",
  "SC-LACTO-25S25L-1": "Lactospark Lactate meter 25 strips and 25 lancets",
  "SC-LACTO-25S25L-2": "Lactospark Lactate meter 25 strips and 25 lancets",
  "SC-LACTO-25S25L-3": "Lactospark Lactate meter 25 strips and 25 lancets",
  "SC-LACTO-25S25L-4": "Lactospark Lactate meter 25 strips and 25 lancets",
  "SC-LACTO-25S25L-5": "Lactospark Lactate meter 25 strips and 25 lancets",
  "SC-LACTO-25S25L-6": "Lactospark Lactate meter 25 strips and 25 lancets",
  "LSLM-1": "Lactospark Lactate meter 25 strips and 25 lancets",
  "SC-LACTO-25S25L-S": "Lactospark Lactate meter 25 strips and 25 lancets",
  "SC-LACTO-STR-PK25": "Lactospark Lactatemeter25 strips",
  "SC-LACTO-STR-PK25-1": "Lactospark Lactatemeter25 strips",
  "SC-LACTO-STR-PK25-S-1": "Lactospark Lactatemeter25 strips",
  "SC-LACTO-STR-PK50": "Lactospark Strips (Pack of 50)",
  "SC-LACTO-STR-PK50-1": "Lactospark Strips (Pack of 50)",
  "SC-LACTO-STR-PK50-S": "Lactospark Strips (Pack of 50)",
  "BMN123": "Mesh nebulizer MY123",
  "BMN123-1": "Mesh nebulizer MY123",
  "BMN123-2": "Mesh nebulizer MY123",
  "BMN123-3": "Mesh nebulizer MY123",
  "BMN123-4": "Mesh nebulizer MY123",
  "BMN123-5": "Mesh nebulizer MY123",
  "BMN123-6": "Mesh nebulizer MY123",
  "BMN123-S": "Mesh nebulizer MY123",
  "BMN123-1-S": "Mesh nebulizer MY123",
  "BMN132": "Mesh Nebulizer MY135B (Grey)",
  "BMN132-1": "Mesh Nebulizer MY135B (Grey)",
  "BMN132-2": "Mesh Nebulizer MY135B (Grey)",
  "BMN132-3": "Mesh Nebulizer MY135B (Grey)",
  "BMN132-4": "Mesh Nebulizer MY135B (Grey)",
  "BMN132-5": "Mesh Nebulizer MY135B (Grey)",
  "BMN132-1-S": "Mesh Nebulizer MY135B (Grey)",
  "BMN132-S": "Mesh Nebulizer MY135B (Grey)",
  "BMN132B": "Mesh nebulizer MY135B (Blue)",
  "BMN132B-1": "Mesh nebulizer MY135B (Blue)",
  "BMN132B-2": "Mesh nebulizer MY135B (Blue)",
  "BMN132B-3": "Mesh nebulizer MY135B (Blue)",
  "BMN132B-4": "Mesh nebulizer MY135B (Blue)",
  "BMN132B-S": "Mesh nebulizer MY135B (Blue)",
  "MT-IV-PK25-1": "Meditubes Winset IV set pack of 25",
  "MT-IV-PK25-3": "Meditubes Winset IV set pack of 25",
  "MT-IV-PK25-4": "Meditubes Winset IV set pack of 25",
  "MT-IV-PK25-5": "Meditubes Winset IV set pack of 25",
  "MP03-2": "Neck traction pillow (Blue)",
  "MP04": "Neck traction pillow (Blue)",
  "MP03-1": "Neck traction pillow (Blue)",
  "NSRCTD": "Neck traction pillow (green)",
  "NRCTD1": "Neck traction pillow (green)",
  "NRCTD4": "Neck traction pillow (green)",
  "NRCTD3": "Neck traction pillow (green)",
  "RNP": "Neck traction pillow (green)",
  "SMPF-01": "Sonmol Peak Flow meter (without BLE)",
  "SMPF-01-1": "Sonmol Peak Flow meter (without BLE)",
  "SMPF-01-2": "Sonmol Peak Flow meter (without BLE)",
  "SMPF-01-3": "Sonmol Peak Flow meter (without BLE)",
  "SMPF-01-4": "Sonmol Peak Flow meter (without BLE)",
  "SMPF-01-5": "Sonmol Peak Flow meter (without BLE)",
  "SMPF-01-6": "Sonmol Peak Flow meter (without BLE)",
  "SONM-PKFLW-W/O-BLE": "Sonmol Peak Flow meter (without BLE)",
  "SMPF-01-S": "Sonmol Peak Flow meter (without BLE)",
  "SMPF-01-1-S": "Sonmol Peak Flow meter (without BLE)",
  "SONM-PKFLW-W-BLE": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-1": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-2": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-3": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-4": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-5": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-6": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-7": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-8": "Sonmol Peak Flow meter (with BLE)",
  "SMPF-01-B": "Sonmol Peak Flow meter (with BLE)",
  "SONM-PKFLW-W-BLE-S": "Sonmol Peak Flow meter (with BLE)",
  "SMPF-012B": "Sonmol Peak Flow meter (with BLE)",
  "SonmolRmtz": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BSonmolRmtz": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz": "Sonmol RMT without manometer (Inhouse and FBA)",
  "Bsonmol-2": "Sonmol RMT without manometer (Inhouse and FBA)",
  "Bsonmol": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-1": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-2": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-3": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-4": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-5": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-6": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-7": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-8": "Sonmol RMT without manometer (Inhouse and FBA)",
  "Bsonmol-1": "Sonmol RMT without manometer (Inhouse and FBA)",
  "Sonmol": "Sonmol RMT without manometer (Inhouse and FBA)",
  "SonmolRmt2": "Sonmol RMT without manometer (Inhouse and FBA)",
  "SONM-RMT-W/O-MANO": "Sonmol RMT without manometer (Inhouse and FBA)",
  "SonmolRmtz(1MG)": "Sonmol RMT without manometer (Inhouse and FBA)",
  "SonmolRMT1": "Sonmol RMT without manometer (Inhouse and FBA)",
  "RMT007": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-S": "Sonmol RMT without manometer (Inhouse and FBA)",
  "BRmtz-1-S": "Sonmol RMT without manometer (Inhouse and FBA)",
  "SonmolRmtz-S": "Sonmol RMT without manometer (Inhouse and FBA)",
  "SRMT1": "Sonmol RMT with manometer",
  "BSRMT": "Sonmol RMT with manometer",
  "BSRMT-1": "Sonmol RMT with manometer",
  "BSRMT-2": "Sonmol RMT with manometer",
  "BSRMT-3": "Sonmol RMT with manometer",
  "BSRMT-4": "Sonmol RMT with manometer",
  "BSRMT-5": "Sonmol RMT with manometer",
  "SRMT": "Sonmol RMT with manometer",
  "BSRMT-S": "Sonmol RMT with manometer",
  "SRMT-S": "Sonmol RMT with manometer",
  "BSMRD": "Sonmol Mucus removal Device",
  "BSMRD-1": "Sonmol Mucus removal Device",
  "SMRD": "Sonmol Mucus removal Device",
  "BSMRD-2": "Sonmol Mucus removal Device",
  "BSMRD-3": "Sonmol Mucus removal Device",
  "BSMRD-4": "Sonmol Mucus removal Device",
  "BSMRD-5": "Sonmol Mucus removal Device",
  "BSMRD-6": "Sonmol Mucus removal Device",
  "BSMRD-7": "Sonmol Mucus removal Device",
  "MUCUS-REM1": "Sonmol Mucus removal Device",
  "MUCUS-REM2": "Sonmol Mucus removal Device",
  "SMRD-1": "Sonmol Mucus removal Device",
  "BSMRD(1MG)": "Sonmol Mucus removal Device",
  "BSMRD-S": "Sonmol Mucus removal Device",
  "BSMRD-1-S": "Sonmol Mucus removal Device",
  "SMRD-S": "Sonmol Mucus removal Device",
  "MIR_SMRT1": "MIR SmartOne",
  "AA-S6RI-AWL7": "MIR SmartOne",
  "SMRT1SPIRO": "MIR SmartOne",
  "AA-S6RI-AWL5": "MIR SmartOne",
  "MIR-SMRTONE": "MIR SmartOne",
  "MIR_SPIROBANK_SMART_SPL": "MIR SmartOne",
  "SMRT1SPIRO(1MG)": "MIR SmartOne",
  "MIR_BANKOXI": "MIR Spirobank Oxi",
  "MSBO": "MIR Spirobank Oxi",
  "MIR_SPIROBANK_SMART": "MIR Spirobank Smart",
  "MIRSBS": "MIR Spirobank Smart",
  "SBST": "MIR Spirobank Smart",
  "SC6": "Hemospark STD without strips",
  "SC6-1": "Hemospark 25 strips and 25 lancets",
  "HSHM": "Hemospark STD without strips",
  "SC-HEMO-STD-S-1": "Hemospark STD without strips",
  "SC-HEMO-STD-S": "Hemospark STD without strips",
  "SC-HEMO-KIT50S25L": "Hemo meter whole KIT (50 Strips + STD incl 25 lancets)",
  "HSHM50TS": "Hemo meter whole KIT (50 Strips + STD incl 25 lancets)",
  "SC-HEMO-50S25L-S-1": "Hemo meter whole KIT (50 Strips + STD incl 25 lancets)",
  "SC8": "Hemospark 50 strips",
  "SC8-1": "Hemospark 50 strips",
  "SC8-S": "Hemospark 50 strips",
  "SC-HEMO-KIT25S25L": "Hemospark 25 strips and 25 lancets",
  "SC-HEMO-KIT25S25L-2": "Hemospark 25 strips and 25 lancets",
  "SC-HEMO-KIT25S25L-4": "Hemospark 25 strips and 25 lancets",
  "SC-HEMO-KIT25S25L-1": "Hemospark 25 strips and 25 lancets",
  "SC-HEMO-KIT25S25L-3": "Hemospark 25 strips and 25 lancets",
  "SC-HEMO-KIT25S25L(Del)": "Hemospark 25 strips and 25 lancets",
  "SC-HEMO-25S25L-S-1": "Hemospark 25 strips and 25 lancets",
  "SC-HEMO-KIT25S25L-S": "Hemospark 25 strips and 25 lancets",
  "NASCOOL-SUCSYS-1": "Nascool nasal power suction irrigation system",
  "NASCOOL-SUCSYS-2": "Nascool nasal power suction irrigation system",
  "NASCOOL-SUCSYS-3": "Nascool nasal power suction irrigation system",
  "NASCOOL-SUCSYS-4": "Nascool nasal power suction irrigation system",
  "NASCOOL-SUCSYS-5": "Nascool nasal power suction irrigation system",
  "NASCOOL-SUCSYS-6": "Nascool nasal power suction irrigation system",
  "NASCOOL-SUCSYS-7": "Nascool nasal power suction irrigation system",
  "NASCOOL-SUCSYS-S": "Nascool nasal power suction irrigation system",
  "SONM-ANTICHOK-1": "Sonmol Anti Choking Device",
  "SONM-ANTICHOK-2": "Sonmol Anti Choking Device",
  "NASCOOL-ANTICHOK-1": "Sonmol Anti Choking Device",
  "SONM-ANTICHOK-3": "Sonmol Anti Choking Device",
  "SONM-ANTICHOK-4": "Sonmol Anti Choking Device",
  "SONM-ANTICHOK-5": "Sonmol Anti Choking Device",
  "SONM-ANTICHOK-6": "Sonmol Anti Choking Device",
  "SONM-ANTICHOK-7": "Sonmol Anti Choking Device",
  "SONM-ANTICHOK-S": "Sonmol Anti Choking Device",
  "B-NCD-RK-6000FL-1": "Nail cleaning device",
  "B-NCD-RK-6000FL-2": "Nail cleaning device",
  "B-NCD-RK-6000FL-S": "Nail cleaning device",
  "B-IBHEAL-1": "Insect bite healer",
  "B-IBHEAL-2": "Insect bite healer",
  "B-IBHEAL-3": "Insect bite healer",
  "B-IBHEAL-4": "Insect bite healer",
  "B-IBHEAL-5": "Insect bite healer",
  "B-IBHEAL-S": "Insect bite healer",
  "B-SUTPRAC-KIT-1": "Suture Practice Kit - combo 2",
  "B-SUTPRAC-KIT": "Suture Practice Kit - combo 2",
  "B-SUTPRAC-KIT-2": "Suture Practice Kit - combo 2",
  "B-SUTPRAC-KIT-3": "Suture Practice Kit - combo 2",
  "B-SUTPRAC-KIT-4": "Suture Practice Kit - combo 2",
  "B-SUTPRAC-KIT-5": "Suture Practice Kit - combo 2",
  "B-SUTPRAC-KIT-S": "Suture Practice Kit - combo 2",
  "B-OT-DT12-1": "Ovulation thermometer",
  "B-OT-DT12-2": "Ovulation thermometer",
  "B-OT-DT12-3": "Ovulation thermometer",
  "B-OT-DT12-4": "Ovulation thermometer",
  "B-OT-DT12-5": "Ovulation thermometer",
  "B-OT-DT12-6": "Ovulation thermometer",
  "B-OT-DT12-2-S": "Ovulation thermometer",
  "B-OT-DT12-S": "Ovulation thermometer",
  "A006": "Breast Shell (New Model)",
  "A006-1": "Breast Shell (New Model)",
  "A006-2": "Breast Shell (New Model)",
  "A006-3": "Breast Shell (New Model)",
  "A006-4": "Breast Shell (New Model)",
  "A006-5": "Breast Shell (New Model)",
  "A006-1-S": "Breast Shell (New Model)",
  "A006-S": "Breast Shell (New Model)",
  "A015": "Therapressure brush (White)",
  "A015-1": "Therapressure brush (White)",
  "A015-2": "Therapressure brush (White)",
  "A015-3": "Therapressure brush (White)",
  "A015-S-1": "Therapressure brush (White)",
  "A015-S": "Therapressure brush (White)",
  "A016": "Sensory brush",
  "A016-1": "Sensory brush",
  "A016-2": "Sensory brush",
  "A016-3": "Sensory brush",
  "A016-4": "Sensory brush",
  "A016-5": "Sensory brush",
  "A016-S": "Sensory brush",
  "B-TB-G": "Therapressure Brush (Green)",
  "B-TB-G-2": "Therapressure Brush (Green)",
  "B-TB-G-3": "Therapressure Brush (Green)",
  "B-TB-G-1": "Therapressure Brush (Green)",
  "B-TB-G-S": "Therapressure Brush (Green)",
  "B-FAT-L1E-1": "Freezer analog thermometer",
  "B-FAT-L1E-2": "Freezer analog thermometer",
  "B-FAT-L1E-3": "Freezer analog thermometer",
  "B-FAT-L1E-4": "Freezer analog thermometer",
  "B-FAT-L1E-5": "Freezer analog thermometer",
  "B-FAT-L1E-6": "Freezer analog thermometer",
  "B-FAT-L1E": "Freezer analog thermometer",
  "B-FAT-L1E-S": "Freezer analog thermometer",
  "B-SUTPRAC-PAD-1": "Suture Practice pad- Big size",
  "B-SUTPRAC-PAD-2": "Suture Practice pad- Big size",
  "B-SUTPRAC-PAD-3": "Suture Practice pad- Big size",
  "B-SUTPRAC-PAD-5": "Suture Practice pad- Big size",
  "M-SUTPRAC-PAD": "Suture Practice pad- Big size",
  "B-SUTPRAC-PAD": "Suture Practice pad- Big size",
  "B-SUTPRAC-PAD-S": "Suture Practice pad- Big size",
  "B-SUTPRAC-PAD-4": "Suture Practice pad- Big size",
  "B-SUTPRAC-PAD-S-2": "Suture Practice pad- Big size",
  "B-BBYASP-HP-1": "Baby nasal aspirator (hand pump-Pink)",
  "B-BBYASP-HP-2": "Baby nasal aspirator (hand pump-Pink)",
  "B-BBYASP-HP-3": "Baby nasal aspirator (hand pump-Pink)",
  "B-BBYASP-HP-S": "Baby nasal aspirator (hand pump-Pink)",
  "B-CT-G-1(Old)": "Chewy tube MW (Green)",
  "B-CT-G-2(Old)": "Chewy tube MW (Green)",
  "B-CT-G-3(Old)": "Chewy tube MW (Green)",
  "B-CT-G-5": "Chewy tube MW (Green)",
  "B-CT-G-6(Old)": "Chewy tube MW (Green)",
  "B-CT-G-7": "Chewy tube MW (Green)",
  "B-CT-G-8(Old)": "Chewy tube MW (Green)",
  "B-CT-G-9(Old)": "Chewy tube MW (Green)",
  "B-CT-G": "Chewy tube (Green - Spiral model)",
  "B-CT-G-S": "Chewy tube MW (Green)",
  "B-CT-SPIRAL-G": "Chewy tube (Green - Spiral model)",
  "B-CT-G-1": "Chewy tube (Green - Spiral model)",
  "B-CT-G-2": "Chewy tube (Green - Spiral model)",
  "B-CT-G-3": "Chewy tube (Green - Spiral model)",
  "B-CT-G-6": "Chewy tube (Green - Spiral model)",
  "B-CT-G-8": "Chewy tube (Green - Spiral model)",
  "B-CT-G-9": "Chewy tube (Green - Spiral model)",
  "M-CT-G": "Chewy tube (Green - Spiral model)",
  "B-CT-Y-1": "Chewy tube (Yellow) - Spiral model",
  "B-CT-Y-1(Old)": "Chewy tube (Yellow)",
  "B-CT-Y-2": "Chewy tube (Yellow)",
  "B-CT-Y-3(Old)": "Chewy tube (Yellow)",
  "B-CT-Y-4(Old)": "Chewy tube (Yellow)",
  "B-CT-Y-5": "Chewy tube (Yellow)",
  "B-CT-Y-6(Old)": "Chewy tube (Yellow)",
  "B-CT-Y(Old)": "Chewy tube (Yellow)",
  "B-CT-Y-S": "Chewy tube (Yellow)",
  "B-CT-Y": "Chewy tube (Yellow) - Spiral model",
  "B-CT-SPIRAL-Y": "Chewy tube (Yellow) - Spiral model",
  "B-CT-Y-4": "Chewy tube (Yellow) - Spiral model",
  "B-CT-Y-3": "Chewy tube (Yellow) - Spiral model",
  "B-CT-Y-6": "Chewy tube (Yellow) - Spiral model",
  "M-CT-Y": "Chewy tube (Yellow) - Spiral model",
  "B-CT-B-1(Old)": "Chewy tube (Blue)",
  "B-CT-B-1": "Chewy tube (Blue) - Spiral model",
  "B-CT-B-3(Old)": "Chewy tube (Blue)",
  "B-CT-B-2": "Chewy tube (Blue)",
  "B-CT-B-4": "Chewy tube (Blue)",
  "B-CT-B-5": "Chewy tube (Blue)",
  "B-CT-B-6(Old)": "Chewy tube (Blue)",
  "B-CT-B-S": "Chewy tube (Blue)",
  "B-CT-B": "Chewy tube (Blue)",
  "B-CT-B-3": "Chewy tube (Blue) - Spiral model",
  "B-CT-B-6": "Chewy tube (Blue) - Spiral model",
  "M-CT-B": "Chewy tube (Blue) - Spiral model",
  "B-CT-R-1(Old)": "Chewy tube (Red)",
  "B-CT-R-2(Old)": "Chewy tube (Red)",
  "B-CT-R-3": "Chewy tube (Red)",
  "B-CT-R-4(Old)": "Chewy tube (Red)",
  "B-CT-R-5": "Chewy tube (Red)",
  "B-CT-R-6(Old)": "Chewy tube (Red)",
  "B-CT-R-7(Old)": "Chewy tube (Red)",
  "B-CT-R-S": "Chewy tube (Red)",
  "B-CT-R": "Chewy tube (Red)",
  "B-CT-R-1": "Chewy tube (Red) - Spiral model",
  "B-CT-R-2": "Chewy tube (Red) - Spiral model",
  "B-CT-R-4": "Chewy tube (Red) - Spiral model",
  "B-CT-R-6": "Chewy tube (Red) - Spiral model",
  "B-CT-R-7": "Chewy tube (Red) - Spiral model",
  "M-CT-R": "Chewy tube (Red) - Spiral model",
  "BARM-PLVFLRMUS-SCR-B-1": "Pelvic muscle floor trainer (screw type) - Blue",
  "BARM-PLVFLRMUS-SCR-B-S": "Pelvic muscle floor trainer (screw type) - Blue",
  "BARM-PLVFLRMUS-SCR-P-1": "Pelvic muscle floor trainer (screw type) - Pink",
  "BARM-PLVFLRMUS-SCR-P-2": "Pelvic muscle floor trainer (screw type) - Pink",
  "BARM-PLVFLRMUS-SCR-P-3": "Pelvic muscle floor trainer (screw type) - Pink",
  "BARM-PLVFLRMUS-SCR-P-4": "Pelvic muscle floor trainer (screw type) - Pink",
  "BARM-PLVFLRMUS-SCR-P-S": "Pelvic muscle floor trainer (screw type) - Pink",
  "B-SHTS-B": "Self Hook therapy stick Blue",
  "B-SHTS-B-1": "Self Hook therapy stick Blue",
  "B-SHTS-B-2": "Self Hook therapy stick Blue",
  "B-SHTS-B-3": "Self Hook therapy stick Blue",
  "B-SHTS-B-4": "Self Hook therapy stick Blue",
  "B-SHTS-B-5": "Self Hook therapy stick Blue",
  "B-SHTS-B-6": "Self Hook therapy stick Blue",
  "B-SHTS-B-7": "Self Hook therapy stick Blue",
  "B-SHTS-B-8": "Self Hook therapy stick Blue",
  "B-SHTS-B-9": "Self Hook therapy stick Blue",
  "B-SHTS-B-S": "Self Hook therapy stick Blue",
  "BARM-PLVFLRMUS-DG-1": "Pelvic muscle floor trainer (digital type) - Black",
  "BARM-PLVFLRMUS-DG-2": "Pelvic muscle floor trainer (digital type) - Black",
  "BARM-PLVFLRMUS-DG-3": "Pelvic muscle floor trainer (digital type) - Black",
  "BARM-PLVFLRMUS-DG-S": "Pelvic muscle floor trainer (digital type) - Black",
  "BARM-PLVFLRMUS-DGP-1": "Pelvic muscle floor trainer (digital type) - Purple",
  "BARM-PLVFLRMUS-DGP-2": "Pelvic muscle floor trainer (digital type) - Purple",
  "BARM-PLVFLRMUS-DGP-3": "Pelvic muscle floor trainer (digital type) - Purple",
  "BARM-PLVFLRMUS-DGP-4": "Pelvic muscle floor trainer (digital type) - Purple",
  "BARM-PLVFLRMUS-DGP-S": "Pelvic muscle floor trainer (digital type) - Purple",
  "A010": "Cradle Comb (Blue-Bear)",
  "A010-1": "Cradle Comb (Blue-Bear)",
  "A010-2": "Cradle Comb (Blue-Bear)",
  "A010-3": "Cradle Comb (Blue-Bear)",
  "A010-1-S": "Cradle Comb (Blue-Bear)",
  "A010-S": "Cradle Comb (Blue-Bear)",
  "A019": "Vaginal dilator",
  "A019-1": "Vaginal dilator",
  "A019-2": "Vaginal dilator",
  "A019-3": "Vaginal dilator",
  "A019-4": "Vaginal dilator",
  "A019-5": "Vaginal dilator",
  "A019-6": "Vaginal dilator",
  "A019-7": "Vaginal dilator",
  "A019-8": "Vaginal dilator",
  "A019-9": "Vaginal dilator",
  "A019-10": "Vaginal dilator",
  "A019-11": "Vaginal dilator",
  "A019-12": "Vaginal dilator",
  "A019-13": "Vaginal dilator",
  "A019-14": "Vaginal dilator",
  "A019-15": "Vaginal dilator",
  "A019-1-S": "Vaginal dilator",
  "A019-S": "Vaginal dilator",
  "A017": "Chewy tube Combo (Pack of 4)",
  "A017-S": "Chewy tube Combo (Pack of 4)",
  "A018": "Chewy tube Combo (Pack of 3)",
  "A018-1": "Chewy tube Combo (Pack of 3)",
  "A018-S": "Chewy tube Combo (Pack of 3)",
  "A011": "Nylon 19mm Suture Thread",
  "A011-M": "Nylon 19mm Suture Thread",
  "A011-1": "Nylon 19mm Suture Thread",
  "A011-2": "Nylon 19mm Suture Thread",
  "A011-S": "Nylon 19mm Suture Thread",
  "A011-M-S": "Nylon 19mm Suture Thread",
  "A012": "Nylon 24mm Suture Thread",
  "A012-M": "Nylon 24mm Suture Thread",
  "A012-S": "Nylon 24mm Suture Thread",
  "A012-M-S": "Nylon 24mm Suture Thread",
  "A013": "Silk 19mm Suture Thread",
  "A013-M": "Silk 19mm Suture Thread",
  "A013-1": "Silk 19mm Suture Thread",
  "A013-M-1": "Silk 19mm Suture Thread",
  "A013-S": "Silk 19mm Suture Thread",
  "A013-M-S": "Silk 19mm Suture Thread",
  "A014": "Polypropylene 19mm Suture Thread",
  "A014-M": "Polypropylene 19mm Suture Thread",
  "A014-M-1": "Polypropylene 19mm Suture Thread",
  "A014-S": "Polypropylene 19mm Suture Thread",
  "A014-M-S": "Polypropylene 19mm Suture Thread",
  "A008": "Baby nasal aspirator - hand pump (white model)",
  "A008-S": "Baby nasal aspirator - hand pump (white model)",
  "B-CLC-W": "Contact lens cleaner",
  "B-CLC-W-S": "Contact lens cleaner",
  "B-CCS3-1": "Cradle cap kit (Set of 3)",
  "B-CCS3-2": "Cradle cap kit (Set of 3)",
  "B-CCS3-3": "Cradle cap kit (Set of 3)",
  "B-CCS3-4": "Cradle cap kit (Set of 3)",
  "B-CCS3": "Cradle cap kit (Set of 3)",
  "A001": "Postpartum Recovery Essentials care kit (10 pcs kit)",
  "A001-1": "Postpartum Recovery Essentials care kit (10 pcs kit)",
  "A001-2": "Postpartum Recovery Essentials care kit (10 pcs kit)",
  "A001-3": "Postpartum Recovery Essentials care kit (10 pcs kit)",
  "A001-4": "Postpartum Recovery Essentials care kit (10 pcs kit)",
  "A001-5": "Postpartum Recovery Essentials care kit (10 pcs kit)",
  "A001-S": "Postpartum Recovery Essentials care kit (10 pcs kit)",
  "A003": "Perineal Healing foam",
  "A003-1": "Perineal Healing foam",
  "A003-3": "Perineal Healing foam",
  "A003-4": "Perineal Healing foam",
  "A003-5": "Perineal Healing foam",
  "A003-6": "Perineal Healing foam",
  "A003-7": "Perineal Healing foam",
  "A003-8": "Perineal Healing foam",
  "A003-9": "Perineal Healing foam",
  "A003-S": "Perineal Healing foam",
  "A005": "Instant Ice Maxi Pad(Pack of 5)",
  "A005-1": "Instant Ice Maxi Pad(Pack of 5)",
  "B-ICEMAXI-PADSICLES": "Instant Ice Maxi Pad(Pack of 5)",
  "B-ICEMAXI-PADSICLES-1": "Instant Ice Maxi Pad(Pack of 5)",
  "A005-S": "Instant Ice Maxi Pad(Pack of 5)",
  "A004": "Perineal Cooling Pad Liner",
  "A004-1": "Perineal Cooling Pad Liner",
  "A004-2": "Perineal Cooling Pad Liner",
  "A004-3": "Perineal Cooling Pad Liner",
  "A004-4": "Perineal Cooling Pad Liner",
  "A004-5": "Perineal Cooling Pad Liner",
  "A004-S": "Perineal Cooling Pad Liner",
  "A002": "Postpartum Recovery Essentials care kit (6 pcs kit)",
  "A002-1": "Postpartum Recovery Essentials care kit (6 pcs kit)",
  "A002-2": "Postpartum Recovery Essentials care kit (6 pcs kit)",
  "A002-3": "Postpartum Recovery Essentials care kit (6 pcs kit)",
  "A002-4": "Postpartum Recovery Essentials care kit (6 pcs kit)",
  "A002-5": "Postpartum Recovery Essentials care kit (6 pcs kit)",
  "A002-S": "Postpartum Recovery Essentials care kit (6 pcs kit)",
  "B-NCD-L2202-A": "Nail fungus cleaning device (new)",
  "B-NCD-L2202-A-2": "Nail fungus cleaning device (new)",
  "B-NCD-L2202-A-3": "Nail fungus cleaning device (new)",
  "B-NCD-L2202-A-4": "Nail fungus cleaning device (new)",
  "B-NCD-L2202-A-S": "Nail fungus cleaning device (new)",
  "B-CRD": "Choking rescue device",
  "B-CRD-2": "Choking rescue device",
  "B-CRD-3": "Choking rescue device",
  "B-CRD-4": "Choking rescue device",
  "B-CRD-5": "Choking rescue device",
  "B-CRD-6": "Choking rescue device",
  "B-CRD-S": "Choking rescue device",
  "B-CH-PS-B": "Cutlery Holder with Plastic stand (Black)",
  "B-CH-PS-B-1": "Cutlery Holder with Plastic stand (Black)",
  "B-CH-PS-B-2": "Cutlery Holder with Plastic stand (Black)",
  "B-CH-PS-B-3": "Cutlery Holder with Plastic stand (Black)",
  "B-CH-PS-B-S-1": "Cutlery Holder with Plastic stand (Black)",
  "B-CH-PS-B-S": "Cutlery Holder with Plastic stand (Black)",
  "B-CH-PS-Br": "Cutlery Holder with Plastic stand (Brown)",
  "B-CH-PS-Br-1": "Cutlery Holder with Plastic stand (Brown)",
  "B-CH-PS-Br-2": "Cutlery Holder with Plastic stand (Brown)",
  "B-CH-PS-Br-3": "Cutlery Holder with Plastic stand (Brown)",
  "B-CH-PS-Br-4": "Cutlery Holder with Plastic stand (Brown)",
  "B-CH-PS-Br-5": "Cutlery Holder with Plastic stand (Brown)",
  "B-CH-PS-Br-S": "Cutlery Holder with Plastic stand (Brown)",
  "B-CH-PS-P": "Cutlery Holder with Plastic stand (Peach)",
  "B-CH-PS-P-1": "Cutlery Holder with Plastic stand (Peach)",
  "B-CH-PS-P-2": "Cutlery Holder with Plastic stand (Peach)",
  "B-CH-PS-P-3": "Cutlery Holder with Plastic stand (Peach)",
  "B-CH-PS-P-4": "Cutlery Holder with Plastic stand (Peach)",
  "B-CH-PS-P-5": "Cutlery Holder with Plastic stand (Peach)",
  "B-CH-PS-P-S-1": "Cutlery Holder with Plastic stand (Peach)",
  "B-CH-PS-P-S": "Cutlery Holder with Plastic stand (Peach)",
  "B-CH-PS-Iv": "Cutlery Holder with Plastic stand (Ivory)",
  "B-CH-PS-Iv-1": "Cutlery Holder with Plastic stand (Ivory)",
  "B-CH-PS-Iv-2": "Cutlery Holder with Plastic stand (Ivory)",
  "B-CH-PS-Iv-3": "Cutlery Holder with Plastic stand (Ivory)",
  "B-CH-PS-Iv-4": "Cutlery Holder with Plastic stand (Ivory)",
  "B-CH-PS-Iv-5": "Cutlery Holder with Plastic stand (Ivory)",
  "B-CH-PS-Iv-S-1": "Cutlery Holder with Plastic stand (Ivory)",
  "B-CH-PS-Iv-S": "Cutlery Holder with Plastic stand (Ivory)",
  "B-CH-PS-Bl": "Cutlery Holder with Plastic stand (Blue)",
  "B-CH-PS-Bl-1": "Cutlery Holder with Plastic stand (Blue)",
  "B-CH-PS-Bl-2": "Cutlery Holder with Plastic stand (Blue)",
  "B-CH-PS-Bl-3": "Cutlery Holder with Plastic stand (Blue)",
  "B-CH-PS-Bl-S-1": "Cutlery Holder with Plastic stand (Blue)",
  "B-CH-PS-Bl-S": "Cutlery Holder with Plastic stand (Blue)",
  "B-CH-PS-Y": "Cutlery Holder with Plastic stand (Yellow)",
  "B-CH-PS-Y-1": "Cutlery Holder with Plastic stand (Yellow)",
  "B-CH-PS-Y-2": "Cutlery Holder with Plastic stand (Yellow)",
  "B-CH-PS-Y-3": "Cutlery Holder with Plastic stand (Yellow)",
  "B-CH-PS-Y-S-1": "Cutlery Holder with Plastic stand (Yellow)",
  "B-CH-PS-Y-S": "Cutlery Holder with Plastic stand (Yellow)",
  "RMT-I6E6": "Respiratory Muscle Trainer (I6E6)",
  "RMT-I6E6-1": "Respiratory Muscle Trainer (I6E6)",
  "RMT-I6E6-2": "Respiratory Muscle Trainer (I6E6)",
  "RMT-I6E6-3": "Respiratory Muscle Trainer (I6E6)",
  "RMT-I6E6-S": "Respiratory Muscle Trainer (I6E6)",
  "B-BBYASP-SYR": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-1": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-2": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-3": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-4": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-PK2": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-PK2-1": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-1": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-S": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-1-S": "Nasal syringe aspirator pack of 2",
  "B-BBYASP-SYR-PK4": "Nasal syringe aspirator pack of 4",
  "B-BBYASP-SYR-PK4-1": "Nasal syringe aspirator pack of 4",
  "B-BBYASP-SYR-PK4-2": "Nasal syringe aspirator pack of 4",
  "B-BBYASP-SYR-PK4-3": "Nasal syringe aspirator pack of 4",
  "B-BBYASP-SYR-PK4-S": "Nasal syringe aspirator pack of 4",
  "B-ST-NY": "Nylon 2-0 19mm suture thread",
  "B-ST-NY-M": "Nylon 2-0 19mm suture thread",
  "B-ST-NY-1": "Nylon 2-0 19mm suture thread",
  "B-ST-NY-2": "Nylon 2-0 19mm suture thread",
  "B-ST-NY-M-1": "Nylon 2-0 19mm suture thread",
  "B-ST-NY-M-2": "Nylon 2-0 19mm suture thread",
  "B-ST-NY-S": "Nylon 2-0 19mm suture thread",
  "B-ST-NY-M-S": "Nylon 2-0 19mm suture thread",
  "B-ST-SK": "Silk 2-0 19mm suture thread",
  "B-ST-SK-M": "Silk 2-0 19mm suture thread",
  "B-ST-SK-1": "Silk 2-0 19mm suture thread",
  "B-ST-SK-M-1": "Silk 2-0 19mm suture thread",
  "B-ST-SK-S": "Silk 2-0 19mm suture thread",
  "B-ST-SK-M-S": "Silk 2-0 19mm suture thread",
  "B-ST-PP": "Polypropylene 2-0 19mm suture thread",
  "B-ST-PP-M": "Polypropylene 2-0 19mm suture thread",
  "B-ST-PP-1": "Polypropylene 2-0 19mm suture thread",
  "B-ST-PP-S": "Polypropylene 2-0 19mm suture thread",
  "B-ST-PP-M-S": "Polypropylene 2-0 19mm suture thread",
  "B-SENFDT": "Sensory Fidget toy",
  "B-SENFDT-1": "Sensory Fidget toy",
  "B-SENFDT-2": "Sensory Fidget toy",
  "B-SENFDT-3": "Sensory Fidget toy",
  "B-SENFDT-4": "Sensory Fidget toy",
  "B-SENFDT-5": "Sensory Fidget toy",
  "M-SENFDT": "Sensory Fidget toy",
  "B-SENFDT-S": "Sensory Fidget toy",
  "B-VENEXT": "Venom extractor",
  "B-VENEXT-1": "Venom extractor",
  "B-VENEXT-2": "Venom extractor",
  "B-VENEXT-3": "Venom extractor",
  "B-VENEXT-4": "Venom extractor",
  "B-VENEXT-S": "Venom extractor",
  "B-BT-B1": "RMT (Black) - white print model",
  "B-BT-B1-1": "RMT (Black) - white print model",
  "B-RMT-SPORTS-US": "RMT (Black) - white print model",
  "B-RMT-SPORTS-US-1": "RMT (Black) - white print model",
  "B-BT-B1-S": "RMT (Black) - white print model",
  "B-BT-B2": "RMT (Black) - Black print model",
  "B-BT-B2-1": "RMT (Black) - Black print model",
  "B-BT-B2-2": "RMT (Black) - Black print model",
  "B-BT-B2-S": "RMT (Black) - Black print model",
  "B-BLACMAS-DP": "Warming Lactation Massager (Dark Pink)",
  "B-BLACMAS-DP-1": "Warming Lactation Massager (Dark Pink)",
  "B-BLACMAS-DP-S": "Warming Lactation Massager (Dark Pink)",
  "B-BLACMAS-G": "Warming Lactation Massager (Green)",
  "B-BLACMAS-G-1": "Warming Lactation Massager (Green)",
  "B-BLACMAS-G-S": "Warming Lactation Massager (Green)",
  "B-SENBK-INS": "Sensory Book",
  "B-SENBK-INS-1": "Sensory Book",
  "B-SENBK-INS-2": "Sensory Book",
  "B-SENBK-INS-3": "Sensory Book",
  "B-SENBK-INS-S": "Sensory Book",
  "B-SENBR": "Sensory Brush-New Model",
  "B-SENBR-1": "Sensory Brush-New Model",
  "B-SENBR-2": "Sensory Brush-New Model",
  "B-SENBR-S": "Sensory Brush-New Model",
  "B-BBYASP-E-ZLY-Bl": "Electric baby nasal aspirator- Blue",
  "B-BBYASP-E-ZLY-Bl-1": "Electric baby nasal aspirator- Blue",
  "B-BBYASP-E-ZLY-Bl-2": "Electric baby nasal aspirator- Blue",
  "B-BBYASP-E-ZLY-Bl-3": "Electric baby nasal aspirator- Blue",
  "B-BBYASP-E-ZLY-Bl-S": "Electric baby nasal aspirator- Blue",
  "B-BBYASP-E-ZLY-Y": "Electric baby nasal aspirator- Yellow",
  "B-BBYASP-E-ZLY-Y-1": "Electric baby nasal aspirator- Yellow",
  "B-BBYASP-E-ZLY-Y-2": "Electric baby nasal aspirator- Yellow",
  "B-BBYASP-E-ZLY-Y-S": "Electric baby nasal aspirator- Yellow",
  "B-INST-BW-Bl": "Instant Breast warmers (Blue)",
  "B-INST-BW-Bl-1": "Instant Breast warmers (Blue)",
  "B-INST-BW-Bl-2": "Instant Breast warmers (Blue)",
  "B-INST-BW-Bl-3": "Instant Breast warmers (Blue)",
  "B-INST-BW-Bl-4": "Instant Breast warmers (Blue)",
  "B-INST-BW-Bl-5": "Instant Breast warmers (Blue)",
  "B-INST-BW-Bl-S": "Instant Breast warmers (Blue)",
  "B-INST-BW-R": "Instant Breast warmers (Red)",
  "B-INST-BW-R-1": "Instant Breast warmers (Red)",
  "B-INST-BW-R-S": "Instant Breast warmers (Red)",
  "B-EWBP": "Wearable breast pump",
  "B-EWBP-2": "Wearable breast pump",
  "B-EWBP-1": "Wearable breast pump",
  "B-EWBP-3": "Wearable breast pump",
  "B-EWBP-4": "Wearable breast pump",
  "B-EWBP-S": "Wearable breast pump",
  "B-SHTS-BLK": "Self Hook Therapy Stick Black",
  "B-SHTS-BLK-1": "Self Hook Therapy Stick Black",
  "B-SHTS-BLK-2": "Self Hook Therapy Stick Black",
  "B-SHTS-BLK-3": "Self Hook Therapy Stick Black",
  "B-SHTS-BLK-4": "Self Hook Therapy Stick Black",
  "B-SHTS-BLK-5": "Self Hook Therapy Stick Black",
  "B-SHTS-BLK-6": "Self Hook Therapy Stick Black",
  "B-SHTS-BLK-7": "Self Hook Therapy Stick Black",
  "B-SHTS-BLK-S": "Self Hook Therapy Stick Black",
  "B-THM": "Transparent Human Model",
  "B-THM-1": "Transparent Human Model",
  "B-THM-S": "Transparent Human Model",
  "B-STHM": "Semi- Transparent Human Model",
  "B-STHM-1": "Semi- Transparent Human Model",
  "B-STHM-S": "Semi- Transparent Human Model",
  "B-GDTHM": "Glow in the Dark Model",
  "B-GDTHM-1": "Glow in the Dark Model",
  "B-GDTHM-S": "Glow in the Dark Model",
  "B-NEPREG-CB": "Pregnancy kit combo without Ovulation thermometer",
  "B-NEPREG-CB-1": "Pregnancy kit combo without Ovulation thermometer",
  "B-NEPREG-CB-S": "Pregnancy kit combo without Ovulation thermometer",
  "B-NEPREG-CB-OT": "Pregnancy kit combo with Ovulation thermometer",
  "B-NEPREG-CB-OT-1": "Pregnancy kit combo with Ovulation thermometer",
  "B-SHTS-PK": "Self Hook Therapy Stick (Pink)",
  "B-SHTS-PK-1": "Self Hook Therapy Stick (Pink)",
  "B-SHTS-PK-2": "Self Hook Therapy Stick (Pink)",
  "B-SHTS-PK-3": "Self Hook Therapy Stick (Pink)",
  "B-SHTS-PK-S": "Self Hook Therapy Stick (Pink)",
  "B-ERMT-DM": "RMT with ERMT App",
  "B-ERMT-DM-1": "RMT with ERMT App",
  "B-ERMT-DM-2": "RMT with ERMT App",
  "B-ERMT-DM-3": "RMT with ERMT App",
  "B-ERMT-DM-S": "RMT with ERMT App",
  "BMINI-DPT-P": "Digital pelvic muscle trainer- new model",
  "BMINI-DPT-P-1": "Digital pelvic muscle trainer- new model",
  "BMINI-DPT-P-S": "Digital pelvic muscle trainer- new model",
  "B-GSM": "Guasha Massager",
  "B-GSM-1": "Guasha Massager",
  "B-GSM-S": "Guasha Massager",
  "B-BTJW-B1": "RMT with Jawline Exerciser",
  "B-BTJW-B2": "RMT with Jawline Exerciser",
  "B-BTJW-B2-1": "RMT with Jawline Exerciser",
  "B-BTJW-B1-1": "RMT with Jawline Exerciser",
  "B-BTJW-B1-S": "RMT with Jawline Exerciser",
  "B-MRD-FIL": "MRD with filter",
  "B-MRD-FIL-1": "MRD with filter",
  "B-MRD-FIL-2": "MRD with filter",
  "B-MRD-FIL-3": "MRD with filter",
  "B-MRD-FIL-S": "MRD with filter",
  "B-MRD-WT": "MRD Grey",
  "B-MRD-WT-1": "MRD Grey",
  "B-MRD-WT-2": "MRD Grey",
  "B-MRD-WT-S": "MRD Grey",
  "M-IQ-PZ": "IQ puzzles (normal)",
  "M-IQ-PZ-1": "IQ puzzles (normal)",
  "B-IQ-PZ": "IQ puzzles (normal)",
  "B-IQ-PZ-1": "IQ puzzles (normal)",
  "M-IQ-PZ-S": "IQ puzzles (normal)",
  "M-IQ-PZ-A": "IQ puzzles (Autism)",
  "M-IQ-PZ-A-1": "IQ puzzles (Autism)",
  "M-IQ-PZ-A-S": "IQ puzzles (Autism)",
  "M-KIDMICRO-PK": "Kids Microscope pink",
  "M-KIDMICRO-PK-1": "Kids Microscope pink",
  "M-KIDMICRO-PK-2": "Kids Microscope pink",
  "M-KIDMICRO-PK-3": "Kids Microscope pink",
  "M-KIDMICRO-PK-4": "Kids Microscope pink",
  "M-KIDMICRO-PK-5": "Kids Microscope pink",
  "M-KIDMICRO-PK-6": "Kids Microscope pink",
  "M-KIDMICRO-PK-S": "Kids Microscope pink",
  "M-KIDMICRO-WT": "Kids Microscope White",
  "M-KIDMICRO-WT-1": "Kids Microscope White",
  "M-KIDMICRO-WT-S": "Kids Microscope White",
  "B-LACBRA-P": "Wearable lactation massager (Purple)",
  "B-LACBRA-P-1": "Wearable lactation massager (Purple)",
  "B-LACBRA-P-S": "Wearable lactation massager (Purple)",
  "B-LACBRA-G": "Wearable lactation massager (Grey)",
  "B-LACBRA-G-1": "Wearable lactation massager (Grey)",
  "B-LACBRA-G-S": "Wearable lactation massager (Grey)",
  "B-IR-LP-200": "IR therpy lamp and holder",
  "B-IR-LP-200-1": "IR therpy lamp and holder",
  "B-IR-LP-200-S": "IR therpy lamp and holder",
  "B-ANTI-C-MASS": "Anti- cellulite massager",
  "B-ANTI-C-MASS-1": "Anti- cellulite massager",
  "B-ANTI-C-MASS-S": "Anti- cellulite massager",
  "M-HRC-PK2": "Headache Relief tool pack of 2",
  "M-HRC-PK2-1": "Headache Relief tool pack of 2",
  "M-HRC-PK2-2": "Headache Relief tool pack of 2",
  "M-HRC-PK2-3": "Headache Relief tool pack of 2",
  "M-HRC-PK2-MOQ2": "Headache Relief tool pack of 2",
  "M-HRC-PK2-MOQ2-1": "Headache Relief tool pack of 2",
  "B-HRC-PK2": "Headache Relief tool pack of 2",
  "B-HRC-PK2-1": "Headache Relief tool pack of 2",
  "B-HRC-PK2-MOQ2": "Headache Relief tool pack of 2",
  "B-HRC-PK2-MOQ2-1": "Headache Relief tool pack of 2",
  "M-HRC-PK2-S": "Headache Relief tool pack of 2",
  "M-HRC-PK3": "Headache Relief tool pack of 3",
  "M-HRC-PK3-1": "Headache Relief tool pack of 3",
  "M-HRC-PK3-2": "Headache Relief tool pack of 3",
  "M-HRC-PK3-3": "Headache Relief tool pack of 3",
  "B-HRC-PK3": "Headache Relief tool pack of 3",
  "B-HRC-PK3-1": "Headache Relief tool pack of 3",
  "M-HRC-PK3-S": "Headache Relief tool pack of 3",
  "M-HRC-PK4": "Headache Relief tool pack of 4",
  "M-HRC-PK4-1": "Headache Relief tool pack of 4",
  "M-HRC-PK4-2": "Headache Relief tool pack of 4",
  "M-HRC-PK4-3": "Headache Relief tool pack of 4",
  "M-HRC-PK4-4": "Headache Relief tool pack of 4",
  "M-HRC-PK4-5": "Headache Relief tool pack of 4",
  "B-HRC-PK4": "Headache Relief tool pack of 4",
  "B-HRC-PK4-1": "Headache Relief tool pack of 4",
  "M-HRC-PK4-S": "Headache Relief tool pack of 4",
  "M-HRC-PK5": "Headache Relief tool pack of 5",
  "M-HRC-PK5-1": "Headache Relief tool pack of 5",
  "M-HRC-PK5-2": "Headache Relief tool pack of 5",
  "M-HRC-PK5-3": "Headache Relief tool pack of 5",
  "M-HRC-PK5-4": "Headache Relief tool pack of 5",
  "M-HRC-PK5-5": "Headache Relief tool pack of 5",
  "B-HRC-PK5": "Headache Relief tool pack of 5",
  "B-HRC-PK5-1": "Headache Relief tool pack of 5",
  "M-HRC-PK5-S": "Headache Relief tool pack of 5",
  "M-HRC-PK1": "Headache Relief tool pack of 1",
  "M-HRC-PK1-1": "Headache Relief tool pack of 1",
  "B-HRC-PK1": "Headache Relief tool pack of 1",
  "B-HRC-PK1-1": "Headache Relief tool pack of 1",
  "B-EGSM": "Electric guasha massager",
  "B-EGSM-1": "Electric guasha massager",
  "B-EGSM-S": "Electric guasha massager",
  "B-INSEM-KIT-PK2": "Insemination kit (Pack of 2)",
  "B-INSEM-KIT-PK2-1": "Insemination kit (Pack of 2)",
  "B-INSEM-KIT-PK2-S": "Insemination kit (Pack of 2)",
  "B-INSEM-KIT-PK5": "Insemination kit (Pack of 5)",
  "B-INSEM-KIT-PK5-1": "Insemination kit (Pack of 5)",
  "B-INSEM-KIT-PK5-2": "Insemination kit (Pack of 5)",
  "B-INSEM-KIT-PK5-3": "Insemination kit (Pack of 5)",
  "B-INSEM-KIT-PK5-4": "Insemination kit (Pack of 5)",
  "B-INSEM-KIT-PK5-S": "Insemination kit (Pack of 5)",
  "B-SUTPRAC-KIT-GL": "Suture Practice Kit - combo 3",
  "B-SUTPRAC-KIT-GL-1": "Suture Practice Kit - combo 3",
  "B-SUTPRAC-KIT-GL-2": "Suture Practice Kit - combo 3",
  "B-SUTPRAC-KIT-GL-3": "Suture Practice Kit - combo 3",
  "B-SUTPRAC-KIT-GL-4": "Suture Practice Kit - combo 3",
  "B-SUTPRAC-KIT-GL-S": "Suture Practice Kit - combo 3",
  "B-SUTPRAC-KIT-3TOOL": "Suture Practice Kit - combo 1",
  "B-SUTPRAC-KIT-3TOOL-1": "Suture Practice Kit - combo 1",
  "B-SUTPRAC-KIT-3TOOL-2": "Suture Practice Kit - combo 1",
  "B-SUTPRAC-KIT-3TOOL-3": "Suture Practice Kit - combo 1",
  "B-SUTPRAC-KIT-3TOOL-4": "Suture Practice Kit - combo 1",
  "B-SUTPRAC-KIT-3TOOL-S": "Suture Practice Kit - combo 1",
  "B-BRESHE-50ML": "Breast shell 50ML Capacity (Model 3)",
  "B-BRESHE-50ML-1": "Breast shell 50ML Capacity (Model 3)",
  "B-BRESHE-50ML-S": "Breast shell 50ML Capacity (Model 3)",
  "B-SENFDT-L": "Sensory fidget toy large model",
  "B-SENFDT-L-1": "Sensory fidget toy large model",
  "B-SENFDT-L-2": "Sensory fidget toy large model",
  "B-SENFDT-L-3": "Sensory fidget toy large model",
  "B-SENFDT-L-4": "Sensory fidget toy large model",
  "B-SENFDT-L-5": "Sensory fidget toy large model",
  "B-SENFDT-L-S": "Sensory fidget toy large model",
  "B-BRESHE-SNOW": "Breast shell SS model",
  "B-BRESHE-SNOW-1": "Breast shell SS model",
  "B-BRESHE-SNOW-S": "Breast shell SS model",
  "B-HYDRO-PAD-PK2": "Hydrogel nipple pad pack of 2",
  "B-HYDRO-PAD-PK2-1": "Hydrogel nipple pad pack of 2",
  "B-HYDRO-PAD-PK2-2": "Hydrogel nipple pad pack of 2",
  "B-HYDRO-PAD-PK2-3": "Hydrogel nipple pad pack of 2",
  "B-HYDRO-PAD-PK2-S": "Hydrogel nipple pad pack of 2",
  "B-HYDRO-PAD-PK4": "Hydrogel nipple pad pack of 4",
  "B-HYDRO-PAD-PK4-1": "Hydrogel nipple pad pack of 4",
  "B-HYDRO-PAD-PK4-S": "Hydrogel nipple pad pack of 4",
  "B-SUTPRAC-PAD-DEFECT": "Suture pad Defective",
  "B-VD-TPE-PK5": "Soft Vaginal Dilator",
  "B-VD-TPE-PK5-1": "Soft Vaginal Dilator",
  "B-VD-TPE-PK5-2": "Soft Vaginal Dilator",
  "B-VD-TPE-PK5-3": "Soft Vaginal Dilator",
  "B-VD-TPE-PK5-S": "Soft Vaginal Dilator",
  "B-JAWBITE-PK1": "Jaw grading bite blocks (Pack of 1)",
  "B-JAWBITE-PK1-1": "Jaw grading bite blocks (Pack of 1)",
  "B-JAWBITE-PK1-S": "Jaw grading bite blocks (Pack of 1)",
  "B-JAWBITE-PK2": "Jaw grading bite blocks (Pack of 2)",
  "B-JAWBITE-PK2-1": "Jaw grading bite blocks (Pack of 2)",
  "B-JAWBITE-PK2-2": "Jaw grading bite blocks (Pack of 2)",
  "B-JAWBITE-PK2-3": "Jaw grading bite blocks (Pack of 2)",
  "B-JAWBITE-PK2-S": "Jaw grading bite blocks (Pack of 2)",
  "B-PPBELT-GREY": "Postpartum Belt - Grey",
  "B-PPBELT-GREY-1": "Postpartum Belt - Grey",
  "B-PPBELT-GREY-S": "Postpartum Belt - Grey",
  "B-ORALSWAB-PK50": "Oral swabs pack of 50",
  "B-ORALSWAB-PK50-1": "Oral swabs pack of 50",
  "B-ORAL-SWAB-PK50-2": "Oral swabs pack of 50",
  "B-ORAL-SWAB-PK50-3": "Oral swabs pack of 50",
  "B-ORALSWAB-PK50-S": "Oral swabs pack of 50",
  "B-ORALSWAB-PK100": "Oral swabs pack of 100",
  "B-ORALSWAB-PK100-1": "Oral swabs pack of 100",
  "B-ORALSWAB-PK100-S": "Oral swabs pack of 100",
  "B-EWBP-BOT-TYP": "Wearable breast pump bottle type",
  "B-EWBP-TNK": "Wearable breast pump bottle type",
  "B-EWBP-BOT-TYP-1": "Wearable breast pump bottle type",
  "B-EWBP-TNK-1": "Wearable breast pump bottle type",
  "B-EGSM-PK": "Electric guasha massager (Pink)",
  "B-IR-THERMO-WT": "IR thermometer White",
  "B-IR-THERMO-WT-1": "IR thermometer White",
  "B-IR-THERMO-BK": "IR thermometer Black",
  "B-IR-THERMO-BK-1": "IR thermometer Black",
  "B-EWBP-BASE-PK": "Wearable Breast pump with Base",
  "B-EWBP-BASE-PK-1": "Wearable Breast pump with Base",
  "B-BP-MON-W-BLE": "BP monitor with Bluetooth",
  "B-BP-MON-W-BLE-1": "BP monitor with Bluetooth",
  "B-BP-MON": "BP monitor without Bluetooth",
  "B-BP-MON-1": "BP monitor without Bluetooth",
  "B-BP-MON-2": "BP monitor without Bluetooth",
  "B-BP-MON-3": "BP monitor without Bluetooth",
  "B-BT-B-PK2": "RMT Black pack of 2",
  "B-BT-B-PK2-1": "RMT Black pack of 2",
  "B-BULB-INSEM-KIT-PK5": "Bulb Syringe IUI applicator -8cm(Pack of 5)",
  "B-BULB-INSEM-KIT-PK5-1": "Bulb Syringe IUI applicator -8cm(Pack of 5)",
  "B-OVU-CASSETTE-PK5": "Ovulation cassette (Pack of 5)",
  "B-OVU-CASSETTE-PK5-1": "Ovulation cassette (Pack of 5)",
  "B-OVU-STRIPS-PK5": "Ovulation Strips (Pack of 5)",
  "B-OVU-STRIPS-PK5-1": "Ovulation Strips (Pack of 5)",
  "B-ARTI-SPOON": "Articulation Spoon",
  "B-ARTI-SPOON-1": "Articulation Spoon",
  "B-MRD-Bl": "MRD Blue",
  "B-MRD-VIO": "MRD Violet",
  "B-MRD-PK": "MRD Pink",
  "B-PPBELT-GREEN": "Postpartum Belt- Green lines",
  "B-PPBELT-GREEN-1": "Postpartum Belt- Green lines",
  "B-LIPTRAINER-G": "Lip Muscle Trainer",
  "B-LIPTRAINER-G-1": "Lip Muscle Trainer",
  "B-THERA-PUTTY-Bl": "Hand therapy putty- Blue",
  "B-THERA-PUTTY-Bl-1": "Hand therapy putty- Blue",
  "B-MALE-FERTILITY-KIT": "Male Fertility Kit",
  "B-MALE-FERTILITY-KIT-1": "Male Fertility Kit",
  "B-MALE-FERTILITY-KIT-2": "Male Fertility Kit",
  "B-MALE-FERTILITY-KIT-3": "Male Fertility Kit",
  "B-MALE-FERTILITY-KIT-4": "Male Fertility Kit",
  "B-MALE-FERTILITY-KIT-5": "Male Fertility Kit",
  "B-MESHNEB-3MODES": "Mesh nebulizer - 3 modes",
  "B-MESHNEB-3MODES-1": "Mesh nebulizer - 3 modes",
  "B-CONCEP-CUP": "Conception Cup",
  "B-CONCEP-CUP-1": "Conception Cup",
  "B-VD-PLAS-TPE": "Soft and Plastic VD combo",
  "B-VD-PLAS-TPE-1": "Soft and Plastic VD combo",
  "B-AIR-PURIFIER": "Air purifier",
  "B-AIR-PURIFIER-1": "Air purifier",
  "B-JAW-TRAINER-CLIP": "Jaw trainer tool- red",
  "B-JAW-TRAINER-CLIP-1": "Jaw trainer tool- red",
  "B-JAW-TRAINER-CLIP-2": "Jaw trainer tool- red",
  "B-JAW-TRAINER-CLIP-3": "Jaw trainer tool- red",
  "B-NEPREG-CB-1PK": "Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)",
  "B-NEPREG-CB-1PK-1": "Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)",
  "B-NEPREG-CB-1PK-2": "Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)",
  "B-NEPREG-CB-1PK-3": "Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)",
  "B-ORAL-TRAINER-3HEAD": "Oral Muscle trainer- 3 heads",
  "B-ORAL-TRAINER-3HEAD-1": "Oral Muscle trainer- 3 heads",
  "B-BULB-CATH-PK4": "Insemination Dual kit (Pack of 4)",
  "B-BULB-CATH-PK4-1": "Insemination Dual kit (Pack of 4)",
  "B-BULB-CATH-PK4-2": "Insemination Dual kit (Pack of 4)",
  "B-BULB-CATH-PK4-3": "Insemination Dual kit (Pack of 4)",
  "B-BULB-CATH-PK10": "Insemination Dual kit (Pack of 10)",
  "B-BULB-CATH-PK10-1": "Insemination Dual kit (Pack of 10)",
  "B-BULB-CATH-PK10-2": "Insemination Dual kit (Pack of 10)",
  "B-BULB-CATH-PK10-3": "Insemination Dual kit (Pack of 10)",
  "B-ORAL-TRAINER-4HEAD": "Oral Muscle trainer- 4 heads",
  "B-ORAL-TRAINER-4HEAD-1": "Oral Muscle trainer- 4 heads",
  "B-MALE-FERTILITY-KIT-SUP1": "Male fertility kit supplier 1",
  "B-MALE-FERTILITY-KIT-SUP1-1": "Male fertility kit supplier 1",
  "B-MALE-FERTILITY-KIT-SUP1-2": "Male fertility kit supplier 1",
  "B-MALE-FERTILITY-KIT-SUP1-3": "Male fertility kit supplier 1",
  "B-TONGUE-TIP-3PC": "Tongue tip exerciser",
  "B-TONGUE-TIP-3PC-1": "Tongue tip exerciser",
  "B-ORAL-TRAINER-5HEAD": "Oral muscle trainer- 5 heads",
  "B-ORAL-TRAINER-5HEAD-1": "Oral muscle trainer- 5 heads",
  "B-ORAL-TRAINER-5HEAD-2": "Oral muscle trainer- 5 heads",
  "B-ORAL-TRAINER-5HEAD-3": "Oral muscle trainer- 5 heads",
  "M-ANTICHOK-RED&BLACK": "Anti choking device- Red & Black",
  "M-ANTICHOK-RED&BLACK-1": "Anti choking device- Red & Black",
  "B-ANTI-CHOK-BLK&RED-1": "Anti choking device- Red & Black",
  "B-ANTI-CHOK-BLK&RED-2": "Anti choking device- Red & Black",
  "M-ANTICHOK-YEL&BLUE": "Anti choking device- Yellow & Blue",
  "M-ANTICHOK-YEL&BLUE-1": "Anti choking device- Yellow & Blue",
  "B-ANTICHOK-YEL&BLUE-1": "Anti choking device- Yellow & Blue",
  "B-ANTICHOK-YEL&BLUE-2": "Anti choking device- Yellow & Blue",
  "M-ANTICHOK-AUTO": "Automatic Choking device",
  "M-ANTICHOK-AUTO-1": "Automatic Choking device",
  "B-ANTICHOK-AUTO-1": "Automatic Choking device",
  "B-ANTICHOK-AUTO-2": "Automatic Choking device",
  "B-ST-POLYGLACTIN": "Polyglactin suture thread",
  "B-ST-POLYGLACTIN-1": "Polyglactin suture thread",
  "B-ST-POLYGLYCOLIC": "Polyglycolic suture thread",
  "B-ST-POLYGLYCOLIC-1": "Polyglycolic suture thread",
  "B-IR-ROG-LP-200": "IR therapy lamp Red on glass",
  "B-IR-ROG-LP-200-1": "IR therapy lamp Red on glass",
  "B-IR-ROG-LP-200-2": "IR therapy lamp Red on glass",
  "B-IR-ROG-LP-200-3": "IR therapy lamp Red on glass",
  "B-BIDET-ATTACHMENT": "Mini Portable Bidet attachment",
  "B-BIDET-ATTACHMENT-1": "Mini Portable Bidet attachment",
  "B-PREG-SALT-400G": "Pregnancy soak salt",
  "B-PREG-SALT-400G-1": "Pregnancy soak salt",
  "B-EPSOM-250G": "Epsom salt - 250 grams",
  "B-EPSOM-250G-1": "Epsom salt - 250 grams",
  "M-EPSOM-250G": "Epsom salt - 250 grams",
  "B-EPSOM-400G": "Epsom salt - 400 grams",
  "B-EPSOM-400G-1": "Epsom salt - 400 grams",
  "M-EPSOM-400G": "Epsom salt - 400 grams",
  "B-EPSOM-900G": "Epsom salt - 900 grams",
  "B-EPSOM-900G-1": "Epsom salt - 900 grams",
  "M-EPSOM-900G": "Epsom salt - 900 grams",
  "B-OVU-STRIPS-PK10": "Ovulation strips (Pack of 10)",
  "B-OVU-STRIPS-PK10-1": "Ovulation strips (Pack of 10)",
  "B-OVU-STRIPS-PK10-2": "Ovulation strips (Pack of 10)",
  "B-OVU-STRIPS-PK10-3": "Ovulation strips (Pack of 10)",
  "B-OVU-STRIPS-PK20": "Ovulation strips (Pack of 20)",
  "B-OVU-STRIPS-PK20-1": "Ovulation strips (Pack of 20)",
  "B-OVU-STRIPS-PK20-2": "Ovulation strips (Pack of 20)",
  "B-OVU-STRIPS-PK20-3": "Ovulation strips (Pack of 20)",
  "B-EYE-PATCH-PK10": "Eye patch Skin color- Pack of 10",
  "B-EYE-PATCH-PK10-1": "Eye patch Skin color- Pack of 10",
  "B-EYE-PATCH-PK20": "Eye patch Skin color- Pack of 20",
  "B-EYE-PATCH-PK20-1": "Eye patch Skin color- Pack of 20",
  "B-EYE-PATCH-PK30": "Eye patch Skin color- Pack of 30",
  "B-EYE-PATCH-PK30-1": "Eye patch Skin color- Pack of 30",
  "B-EYE-PATCH-WT-PK10": "Eye patch White color- Pack of 10",
  "B-EYE-PATCH-WT-PK10-1": "Eye patch White color- Pack of 10",
  "B-EYE-PATCH-WT-PK20": "Eye patch White color- Pack of 20",
  "B-EYE-PATCH-WT-PK20-1": "Eye patch White color- Pack of 20",
  "B-EYE-PATCH-WT-PK30": "Eye patch White color- Pack of 30",
  "B-EYE-PATCH-WT-PK30-1": "Eye patch White color- Pack of 30",
  "M-NASALSUC-RECHARGE": "Nasal suction irrigator- Rechargeable",
  "M-NASALSUC-RECHARGE-1": "Nasal suction irrigator- Rechargeable",
  "M-NASALSUC-RECHARGE-2": "Nasal suction irrigator- Rechargeable",
  "B-NASALSUC-RECHARGE": "Nasal suction irrigator- Rechargeable",
  "B-NASALSUC-RECHARGE-1": "Nasal suction irrigator- Rechargeable",
  "B-CSECTION-KIT-15PCS": "C-Section Recovery kit- 15 pcs",
  "B-CSECTION-KIT-15PCS-1": "C-Section Recovery kit- 15 pcs",
  "B-CSECTION-KIT-15PCS-2": "C-Section Recovery kit- 15 pcs",
  "B-CSECTION-KIT-15PCS-3": "C-Section Recovery kit- 15 pcs",
  "B-HANG-THERMO": "Hanging thermometer",
  "B-HANG-THERMO-1": "Hanging thermometer",
  "B-FER-LUBRICANT-50ML": "Fertility-friendly lubricant",
  "B-FER-LUBRICANT-50ML-1": "Fertility-friendly lubricant",
  "B-TEETHTUBE-GYR": "Teething Tube Combo (Green Red Yellow)",
  "B-TEETHTUBE-GYR-1": "Teething Tube Combo (Green Red Yellow)",
  "B-REF-THERMO": "Refrigerator thermometer",
  "B-REF-THERMO-1": "Refrigerator thermometer",
  "B-SITZ-TUB": "Sitz bath tub",
  "B-SITZ-TUB-1": "Sitz bath tub",
  "B-BULB-10.5-INSEM-PK5": "Bulb Syringe IUI applicator (10.5 cm)(Pack of 5)",
  "B-BULB-10.5-INSEM-PK5-1": "Bulb Syringe IUI applicator (10.5 cm)(Pack of 5)",
  "B-INSEM-12CM-KIT-PK2": "Insemination Kit- Catheter type-12cm (Pack of 2)",
  "B-INSEM-12CM-PK2-KIT-3": "Insemination Kit- Catheter type-12cm (Pack of 2)",
  "B-INSEM-12CM-KIT-PK2-1": "Insemination Kit- Catheter type-12cm (Pack of 2)",
  "B-INSEM-12CM-KIT-PK5": "Insemination Kit- Catheter type-12cm (Pack of 5)",
  "B-INSEM-12CM-KIT-PK5-1": "Insemination Kit- Catheter type-12cm (Pack of 5)",
  "B-BULB-10.5-INSEM-PK2": "Bulb Syringe IUI applicator (10.5 cm)(Pack of 2)",
  "B-BULB-10.5-INSEM-PK2-1": "Bulb Syringe IUI applicator (10.5 cm)(Pack of 2)",
  "B-BULB-INSEM-KIT-PK2": "Bulb Syringe IUI applicator -8cm(Pack of 2)",
  "B-BULB-INSEM-KIT-PK2-1": "Bulb Syringe IUI applicator -8cm(Pack of 2)",
  "B-SITZ-SALT-400G": "Sitz Bath salt- 400 Grams",
  "B-SITZ-SALT-400G-1": "Sitz Bath salt- 400 Grams",
  "B-INSEM-15CM-KIT-PK2": "Insemination Kit- Catheter type-15cm (Pack of 2)",
  "B-INSEM-15CM-KIT-PK2-1": "Insemination Kit- Catheter type-15cm (Pack of 2)",
  "B-INSEM-15CM-KIT-PK5": "Insemination Kit- Catheter type-15cm (Pack of 5)",
  "B-INSEM-15CM-KIT-PK5-1": "Insemination Kit- Catheter type-15cm (Pack of 5)",
  "B-DIGITAL-STETHOSCOPE": "Digital stethescope",
  "B-DIGITAL-STETHOSCOPE-1": "Digital stethescope",
  "B-ST-NY-2-0-30MM": "Nylon suture thread 2-0 - 30MM",
  "B-ST-NY-2-0-30MM-1": "Nylon suture thread 2-0 - 30MM",
  "B-ST-NY-2-0-24MM": "Nylon suture thread 2-0 - 24MM",
  "B-ST-NY-2-0-24MM-1": "Nylon suture thread 2-0 - 24MM",
  "B-ST-NY-4-0-30MM": "Nylon Suture thread 4-0 - 30MM",
  "B-ST-NY-4-0-30MM-1": "Nylon Suture thread 4-0 - 30MM",
  "B-ST-SK-2-0-30MM": "Silk Suture thread 2-0- 30MM",
  "B-ST-SK-2-0-30MM-1": "Silk Suture thread 2-0- 30MM",
  "B-ST-SK-4-0-30MM": "Silk Suture thread 4-0- 30MM",
  "B-ST-SK-4-0-30MM-1": "Silk Suture thread 4-0- 30MM",
  "B-ST-PP-2-0-30MM": "Polypropylene suture thread 2-0 - 30MM",
  "B-ST-PP-2-0-30MM-1": "Polypropylene suture thread 2-0 - 30MM",
  "B-ST-PP-4-0-30MM": "Polypropylene suture thread 4-0 - 30MM",
  "B-ST-PP-4-0-30MM-1": "Polypropylene suture thread 4-0 - 30MM",
  "B-MANUAL-BREAST-PUMP": "Manual Breast pump",
  "B-MANUAL-BREAST-PUMP-1": "Manual Breast pump",
  "B-MANUAL-BREAST-PUMP-2": "Manual Breast pump",
  "B-MANUAL-BREAST-PUMP-3": "Manual Breast pump",
  "B-IR-BULB": "IR Bulb",
  "B-GSM-2-QUALITY": "Guasha massage- Second Quality",
  "B-SEAT-BELT-ADJUSTER": "Car Seat Belt adjuster for pregnant women",
  "B-FETAL-DOPPLER": "Fetal Doppler",
  "B-FETAL-DOPPLER-1": "Fetal Doppler",
  "B-ANTI-C-MASS-GREEN": "Anti cellulite massager- Green",
  "B-ANTI-C-MASS-GREEN-1": "Anti cellulite massager- Green",
  "B-NASAL-WASH-POWDER": "Nasal Wash Salt- 400 grams",
  "B-NASAL-WASH-POWDER-1": "Nasal Wash Salt- 400 grams",
  "B-CRACKNIP-SPRAY-100ML": "Cracked Nipple Spray",
  "B-CRACKNIP-SPRAY-100ML-1": "Cracked Nipple Spray",
  "B-CT-G-R": "Chewy tube combo- Red and green",
  "B-CT-G-R-1": "Chewy tube combo- Red and green",
  "B-CT-G-PK2": "Chewy tube green- Pack of 2",
  "B-CT-G-PK2-1": "Chewy tube green- Pack of 2",
  "B-SPEECH-COMBO-3HEADS": "Speech Therapy Combo with 3 heads",
  "B-SPEECH-COMBO-3HEADS-1": "Speech Therapy Combo with 3 heads",
  "B-POSTPARTUM-MINI-KIT": "Postpartum Mini Kit",
  "B-POSTPARTUM-MINI-KIT-1": "Postpartum Mini Kit",
  "B-PERI-WAND-MAS": "Perineal Massage Wand- White",
  "B-PERI-WAND-MAS-1": "Perineal Massage Wand- White",
  "B-SUTPRAC-PAD-NORMAL": "Suture Practice Pad- Normal",
  "B-SUTPRAC-PAD-NORMAL-1": "Suture Practice Pad- Normal",
  "B-ORALSWAB-WT-PK50": "Oral Swabs-White (Pack of 50)",
  "B-ORALSWAB-WT-PK50-1": "Oral Swabs-White (Pack of 50)",
  "B-ORALSWAB-WT-PK100": "Oral Swabs- White (Pack of 100)",
  "B-ORALSWAB-WT-PK100-1": "Oral Swabs- White (Pack of 100)",
  "B-MENO-CASSETTE-PK3": "Menopause test Cassette pack of 3",
  "B-MENO-CASSETTE-PK3-1": "Menopause test Cassette pack of 3",
  "B-FOAM-LINER-COMBO": "Perineal Healing foam and padliners combo",
  "B-FOAM-LINER-COMBO-1": "Perineal Healing foam and padliners combo",
  "B-FOAM-LINER-COMBO-2": "Perineal Healing foam and padliners combo",
  "B-FOAM-LINER-COMBO-3": "Perineal Healing foam and padliners combo",
  "B-INS-KIT-17CM-SUP2-PK2": "Insemination kit-17cm Supplier 2 (Pack of 2)",
  "B-INS-KIT-17CM-SUP2-PK2-1": "Insemination kit-17cm Supplier 2 (Pack of 2)",
  "B-INS-KIT-17CM-SUP2-PK5": "Insemination kit-17cm Supplier 2 (Pack of 5)",
  "B-INS-KIT-17CM-SUP2-PK5-1": "Insemination kit-17cm Supplier 2 (Pack of 5)",
  "B-PFM-BLW-MEM": "Rechargeble PeakFlow meter with Memory & Bluetooth",
  "B-PFM-BLW-MEM-1": "Rechargeble PeakFlow meter with Memory & Bluetooth",
  "B-SILVER-NURCUP-R": "Silver Nursing Cup- Regular",
  "B-SILVER-NURCUP-R-1": "Silver Nursing Cup- Regular",
  "B-SPEECH-COMBO-5HEADS": "Speech Therapy Combo with 5 heads",
  "B-SPEECH-COMBO-5HEADS-1": "Speech Therapy Combo with 5 heads",
  "B-BRE-ESSEN-KIT": "Breastfeeding Essential Kit",
  "B-BRE-ESSEN-KIT-1": "Breastfeeding Essential Kit",
  "B-BRE-ESSEN-KIT-2": "Breastfeeding Essential Kit",
  "B-SILVER-NURCUP-L": "Silver Nursing Cup- Large",
  "B-SILVER-NURCUP-L-1": "Silver Nursing Cup- Large",
  "B-MENO-STRIPS-PK4": "Menopause Test Strips (Pack of 4)",
  "B-MENO-STRIPS-PK4-1": "Menopause Test Strips (Pack of 4)",
  "B-CT-G-BUMP": "Chewy tube Green (Bump model New)",
  "B-CT-G-BUMP-1": "Chewy tube Green (Bump model New)",
  "B-UTI-3PARA-PK3": "UTI Test Strips (Pack of 4)",
  "B-UTI-3PARA-PK3-1": "UTI Test Strips (Pack of 4)",
  "B-FLANGE-FINDER-KIT": "Flange Finder Kit",
  "B-FLANGE-FINDER-KIT-1": "Flange Finder Kit",
  "B-HUMAN-CUBE": "Human Anatomy Cube",
  "B-HUMAN-CUBE-1": "Human Anatomy Cube",
  "B-INFLATE-DONUT-PLW": "Inflatable Donut Pillow",
  "B-INFLATE-DONUT-PLW-1": "Inflatable Donut Pillow",
  "B-NEEMWOOD-COMB": "Neem Wood Comb",
  "B-NEEMWOOD-COMB-1": "Neem Wood Comb",
  "B-5FLANGE-INSERTS": "Flange Inserts for Breast Pump",
  "B-5FLANGE-INSERTS-1": "Flange Inserts for Breast Pump",
  "GLUCO-STRIPS-PK200": "GlucoSpark Strips (Pack of 200)",
  "GLUCO-STRIPS-PK200-1": "GlucoSpark Strips (Pack of 200)",
  "GLUCO-STRIPS-PK150": "GlucoSpark Strips (Pack of 150)",
  "GLUCO-STRIPS-PK150-1": "GlucoSpark Strips (Pack of 150)",
  "B-EYE-PATCH-DK-PK10": "Eye Patch - Dark Colour (Pack of 10)",
  "B-EYE-PATCH-DK-PK10-1": "Eye Patch - Dark Colour (Pack of 10)"
};
function resolveProductName(rawName, sku) {
  if (sku) {
    for (const candidate of sku.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (SKU_NAME_MAP[candidate]) return SKU_NAME_MAP[candidate];
    }
  }
  return rawName || "";
}
var SUPPLEMENTAL_ENTRIES = [
  ["3M Littmann Classic III Monitoring Stethoscope, Rainbow-Finish, Raspberry Tube, 27 inch, 5806", "General"],
  ["B-Arm Gua sha Facial Tool for Face, Neck, Eye |Non-Glossy Body Scraping Tool for Foot, Shoulder & Lymphatic Drainage |Skin Care Tool |Stainless Steel Gua Sha for Glowing Skin & Reducing Eye Puffiness", "General"],
  ["Glucospark kit with 10 Strips and 10 Lancets - Sugar Test Machine for Home Use (B-Arm)", "General"],
  ["B-Arm USP/Pharma Grade Epsom Salt(900g) for Bath, Foot Soak, Muscle Pain Relief, Skin Care| 100% Natural, Unscented, Easy Dissolve Magnesium Sulfate Crystal salts for bath, Dry Skin, Swelling", "General"],
  ["Glucospark Digital Glucometer kit with 10 Strips And 10 Lancets | Blood Glucose Monitor And Accurate Blood Sugar Test Machine For Home (B-Arm)", "General"],
  ["Glucospark Blood glucose Test Strips | Pack of 25 strips | Sugar Test Strips compatible with Glucospark glucose meter only and not with any other glucose meters", "General"],
  ["Glucospark Glucometer Test Strips (Pack of 25) Suitable Only with Glucospark Sugar Test Machine \u2013 Fast & Accurate Results | Minimum Order: 2 Packs (2 x 25 Strips) | Sugar Test Strips (B-Arm)", "General"],
  ["B-Arm USP/Pharma Grade Epsom Salt(400g) for Bath, Foot Soak, Muscle Pain Relief, Skin Care| 100% Natural, Unscented, Easy Dissolve Magnesium Sulfate Crystal salts for bath, Dry Skin, Swelling", "General"],
  ["B-Arm Applicator for Menstrual Cup And Tampon- Make Insertion & Removal Easy | Menstruation Cup And Tampon Inserter Compatible with Most Period Cups And Tampons | Reusable Period Cup Applicator And Easy To Use", "Discontinued"],
  ["B-Arm Menstrual Cup Inserter Tool \u2013 Easier Application/Removal of Period Cup | Compatible with most of the Menstrual Cups | Reusable Menstruation Cup Applicator", "Discontinued"],
  ["B-Arm USP/Pharma Grade Epsom Salt(250g) for Bath, Foot Soak, Muscle Pain Relief, Skin Care| 100% Natural, Unscented, Easy Dissolve Magnesium Sulfate Crystal salts for bath, Dry Skin, Swelling", "General"],
  ["Millwright 4X Mini Microscope with Adjustable Focus|1000X Scientist Toy with 8 LED & 2-Inch Screen|Cloth Samples Included|Handheld Microscope with Memory & Camera|Science Experiment Toy for 3+ Years", "General"],
  ["B-Arm Digital Infrared Thermometer with 1 Sec Quick Reading", "General"]
];
var STOPWORDS = /* @__PURE__ */ new Set(["pack", "of", "with", "without", "and", "the", "for", "a", "an", "in", "kit", "new", "model", "type", "size"]);
var tokenize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t)).map((t) => t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
var ENTRY_TOKENS = [...CATEGORY_ENTRIES, ...SUPPLEMENTAL_ENTRIES].map(([name, category]) => ({
  tokens: tokenize(name),
  category
}));

// src/lib/productMasterUpload.ts
import * as XLSX2 from "npm:xlsx@0.18.5";
var TABLE = "barm_product_master";
async function fetchProductMasterMap() {
  try {
    const { data, error } = await supabasePublic.from(TABLE).select("sku, product_name, category");
    if (error || !data) return /* @__PURE__ */ new Map();
    const map = /* @__PURE__ */ new Map();
    data.forEach((r) => {
      if (r.sku && r.product_name) map.set(r.sku, { name: r.product_name, category: r.category || "" });
    });
    return map;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function skuBase(sku) {
  return sku.trim().toUpperCase().replace(/\((AM|FK|MS)\)$/i, "").replace(/-\d+$/, "").replace(/-S$/i, "").replace(/[\s_]+/g, "");
}
function buildProductMasterResolver(master) {
  const byBase = /* @__PURE__ */ new Map();
  master.forEach((entry, sku) => {
    const base = skuBase(sku);
    if (!byBase.has(base)) byBase.set(base, entry);
  });
  const lookup = (sku) => master.get(sku) || byBase.get(skuBase(sku));
  return {
    resolveName: (sku, fallback) => lookup(sku)?.name || fallback,
    resolveCategory: (sku, fallback) => lookup(sku)?.category || fallback
  };
}

// src/lib/masterProductSkuid.ts
var TABLE2 = "master_product_skuid";
var CATEGORY_ALIASES = {
  gynecology: "Gynaecology"
};
function normalizeCategory(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return CATEGORY_ALIASES[trimmed.toLowerCase()] || trimmed;
}
function toNullableNumber(v) {
  if (v === null || v === void 0 || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function fetchMasterSkuidMap() {
  try {
    const data = await fetchAllRows(TABLE2, (q) => q);
    const map = /* @__PURE__ */ new Map();
    data.forEach((r) => {
      const sku = String(r["SKU ID"] ?? "").trim();
      const name = String(r["Product Name"] ?? "").trim();
      if (!sku || !name || map.has(sku)) return;
      map.set(sku, {
        name,
        category: normalizeCategory(String(r["Category"] ?? "")),
        tax: toNullableNumber(r["Tax"]),
        costPrice: toNullableNumber(r["Cost Price"])
      });
    });
    return map;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
async function fetchMasterSkuidsByName() {
  try {
    const data = await fetchAllRows(TABLE2, (q) => q);
    const out = /* @__PURE__ */ new Map();
    data.forEach((r) => {
      const sku = String(r["SKU ID"] ?? "").trim();
      const name = String(r["Product Name"] ?? "").trim();
      const platform = String(r["Platform"] ?? "").trim();
      if (!sku || !name || !platform) return;
      const key2 = name.toLowerCase();
      let byPlatform = out.get(key2);
      if (!byPlatform) {
        byPlatform = /* @__PURE__ */ new Map();
        out.set(key2, byPlatform);
      }
      const list = byPlatform.get(platform) || [];
      if (!list.includes(sku)) list.push(sku);
      byPlatform.set(platform, list);
    });
    return out;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
async function fetchMasterSkuidAmazonCatalog() {
  try {
    const data = await fetchAllRows(TABLE2, (q) => q.eq("Platform", "Amazon"));
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    data.forEach((r) => {
      const sku = String(r["SKU ID"] ?? "").trim();
      const name = String(r["Product Name"] ?? "").trim();
      if (!sku || !name || seen.has(sku)) return;
      seen.add(sku);
      out.push({ sku, name, category: normalizeCategory(String(r["Category"] ?? "")) });
    });
    return out;
  } catch {
    return [];
  }
}
function buildMasterSkuidResolver(master) {
  const byBase = /* @__PURE__ */ new Map();
  master.forEach((entry, sku) => {
    const base = skuBase(sku);
    if (!byBase.has(base)) byBase.set(base, entry);
  });
  const lookup = (sku) => master.get(sku) || byBase.get(skuBase(sku));
  return {
    resolveName: (sku, fallback) => lookup(sku)?.name || fallback,
    resolveCategory: (sku, fallback) => lookup(sku)?.category || fallback,
    resolveTax: (sku) => lookup(sku)?.tax ?? null,
    resolveCostPrice: (sku) => lookup(sku)?.costPrice ?? null
  };
}
var DEFAULT_GST_MULTIPLIER = 1.18;
function gstMultiplierFromTax(_tax) {
  return DEFAULT_GST_MULTIPLIER;
}

// src/lib/productMarketingUpload.ts
import * as XLSX3 from "npm:xlsx@0.18.5";
var TABLE3 = "master_product_marketing";
async function fetchProductMarketingMap() {
  try {
    const data = await fetchAllRows(TABLE3, (q) => q);
    const map = /* @__PURE__ */ new Map();
    data.forEach((r) => {
      const sku = String(r.sku ?? "").trim();
      const name = String(r.product_name ?? "").trim();
      if (!sku || !name || map.has(sku)) return;
      map.set(sku, { name, category: String(r.category ?? "").trim() });
    });
    return map;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function buildProductMarketingResolver(marketing) {
  const byBase = /* @__PURE__ */ new Map();
  marketing.forEach((entry, sku) => {
    const base = skuBase(sku);
    if (!byBase.has(base)) byBase.set(base, entry);
  });
  const lookup = (sku) => marketing.get(sku) || byBase.get(skuBase(sku));
  return {
    resolveName: (sku, fallback) => lookup(sku)?.name || fallback,
    resolveCategory: (sku, fallback) => lookup(sku)?.category || fallback
  };
}

// supabase/edge-build/ad-spend-report-shims/siteUrl.ts
var SITE_URL = Deno.env.get("NEXT_PUBLIC_SITE_URL") || "https://amazon-ppc-analytics-dashboard.vercel.app";

// src/lib/adSpendReportExport.ts
var LOW_SPEND_THRESHOLD = 50;
var ACOS_SHORTLIST_MIN_SPEND = 100;
function getDateWindow(toDate2, days) {
  const end = /* @__PURE__ */ new Date(`${toDate2}T00:00:00Z`);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function missingDates(datesPresent, start, endDate) {
  const missing = [];
  const cur = /* @__PURE__ */ new Date(`${start}T00:00:00Z`);
  const end = /* @__PURE__ */ new Date(`${endDate}T00:00:00Z`);
  while (cur.getTime() <= end.getTime()) {
    const iso = cur.toISOString().slice(0, 10);
    if (!datesPresent.has(iso)) missing.push(iso);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return missing;
}
function dotDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}
function num3(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
var emptyAgg = () => ({ spend: 0, units: 0 });
var spendTax = (a) => a.spend * (a.gstMultiplier ?? DEFAULT_GST_MULTIPLIER);
var computeCpc = (a) => a.units > 0 ? spendTax(a) / a.units : spendTax(a);
var sellPriceCell = (a) => a.units > 0 && (a.revenue ?? 0) > 0 ? Math.round((a.revenue ?? 0) / a.units * 100) / 100 : "\u2013";
var adOrdersCell = (a) => a.adOrders !== void 0 ? a.adOrders : "\u2013";
var noSalesAcos = (spend) => Math.round(spend / 100 * 1e4) / 1e4;
var adStatusHasSpend = (a) => spendTax(a) > 0;
var ACOS_UNDEFINED_SENTINEL = 9.99;
var acosCpcOverPrice = (a, price, listingPrice) => {
  const p = listingPrice && listingPrice > 0 ? listingPrice : price;
  if (!p || p <= 0) return a.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
  const cpc = computeCpc(a);
  return cpc > 0 ? cpc / p : 0;
};
var computeAcos = (a, price, listingPrice) => {
  if (a.units === 0) return acosCpcOverPrice(a, price, listingPrice);
  if (a.adAttributedSales !== void 0) {
    if (a.adAttributedSales > 0) return (a.adAttributedSpend ?? 0) / a.adAttributedSales;
    return acosCpcOverPrice(a, price, listingPrice);
  }
  if ((a.adOrders ?? 0) > 0) {
    const adSalesFigure = a.adSales !== void 0 ? a.adSales : a.adOrders * price;
    if (adSalesFigure > 0) return a.spend / adSalesFigure;
    return acosCpcOverPrice(a, price, listingPrice);
  }
  return acosCpcOverPrice(a, price, listingPrice);
};
function actionSheetAcos(a, price) {
  if (a.adAttributedSales !== void 0 && a.adAttributedSales > 0) {
    return (a.adAttributedSpend ?? 0) / a.adAttributedSales;
  }
  const totalSales = a.revenue ?? a.units * price;
  if (totalSales > 0) return a.spend / totalSales;
  return a.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
}
var emptySales = () => ({ units: 0, value: 0 });
var stripLegacySkuSuffix = (sku) => sku.trim().toLowerCase().replace(/\s*\(old\)\s*$/i, "").replace(/-s$/i, "");
var isLiveSku = (sku) => sku.trim().toLowerCase() === stripLegacySkuSuffix(sku);
var sumOptional = (a, b) => a === void 0 && b === void 0 ? void 0 : (a ?? 0) + (b ?? 0);
function groupProductsByName(products, masterSkuidsByName, skuToMasterSkuidName) {
  const byName = /* @__PURE__ */ new Map();
  products.forEach((p) => {
    const key2 = p.name.trim().toLowerCase();
    const existing = byName.get(key2);
    if (!existing) {
      byName.set(key2, { ...p, day: { ...p.day }, range: { ...p.range }, skuSet: /* @__PURE__ */ new Set([p.sku]) });
      return;
    }
    existing.day.spend += p.day.spend;
    existing.day.units += p.day.units;
    existing.day.revenue = sumOptional(existing.day.revenue, p.day.revenue);
    existing.day.adOrders = sumOptional(existing.day.adOrders, p.day.adOrders);
    existing.day.adSales = sumOptional(existing.day.adSales, p.day.adSales);
    existing.day.adAttributedSpend = sumOptional(existing.day.adAttributedSpend, p.day.adAttributedSpend);
    existing.day.adAttributedSales = sumOptional(existing.day.adAttributedSales, p.day.adAttributedSales);
    existing.range.spend += p.range.spend;
    existing.range.units += p.range.units;
    existing.range.revenue = sumOptional(existing.range.revenue, p.range.revenue);
    existing.range.adOrders = sumOptional(existing.range.adOrders, p.range.adOrders);
    existing.range.adSales = sumOptional(existing.range.adSales, p.range.adSales);
    existing.range.adAttributedSpend = sumOptional(existing.range.adAttributedSpend, p.range.adAttributedSpend);
    existing.range.adAttributedSales = sumOptional(existing.range.adAttributedSales, p.range.adAttributedSales);
    if (!existing.price && p.price) existing.price = p.price;
    existing.skuSet.add(p.sku);
  });
  const parent = new Map([...byName.keys()].map((k) => [k, k]));
  const find = (k) => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const skuNormToKeys = /* @__PURE__ */ new Map();
  byName.forEach((group, key2) => {
    group.skuSet.forEach((s) => {
      const norm = stripLegacySkuSuffix(s);
      skuNormToKeys.set(norm, [...skuNormToKeys.get(norm) ?? [], key2]);
    });
  });
  skuNormToKeys.forEach((keys) => {
    for (let i = 1; i < keys.length; i++) {
      const ra = find(keys[0]);
      const rb = find(keys[i]);
      if (ra !== rb) parent.set(ra, rb);
    }
  });
  if (skuToMasterSkuidName) {
    const masterNameToKeys = /* @__PURE__ */ new Map();
    byName.forEach((group, key2) => {
      group.skuSet.forEach((s) => {
        const masterName = skuToMasterSkuidName.get(s)?.trim().toLowerCase();
        if (!masterName) return;
        masterNameToKeys.set(masterName, [...masterNameToKeys.get(masterName) ?? [], key2]);
      });
    });
    masterNameToKeys.forEach((keys) => {
      for (let i = 1; i < keys.length; i++) {
        const ra = find(keys[0]);
        const rb = find(keys[i]);
        if (ra !== rb) parent.set(ra, rb);
      }
    });
  }
  const merged = /* @__PURE__ */ new Map();
  byName.forEach((group, key2) => {
    const root = find(key2);
    const groupHasLive = [...group.skuSet].some(isLiveSku);
    const existing = merged.get(root);
    if (!existing) {
      merged.set(root, { ...group, day: { ...group.day }, range: { ...group.range }, skuSet: new Set(group.skuSet), hasLiveSku: groupHasLive });
      return;
    }
    existing.day.spend += group.day.spend;
    existing.day.units += group.day.units;
    existing.day.revenue = sumOptional(existing.day.revenue, group.day.revenue);
    existing.day.adOrders = sumOptional(existing.day.adOrders, group.day.adOrders);
    existing.day.adSales = sumOptional(existing.day.adSales, group.day.adSales);
    existing.day.adAttributedSpend = sumOptional(existing.day.adAttributedSpend, group.day.adAttributedSpend);
    existing.day.adAttributedSales = sumOptional(existing.day.adAttributedSales, group.day.adAttributedSales);
    existing.range.spend += group.range.spend;
    existing.range.units += group.range.units;
    existing.range.revenue = sumOptional(existing.range.revenue, group.range.revenue);
    existing.range.adOrders = sumOptional(existing.range.adOrders, group.range.adOrders);
    existing.range.adSales = sumOptional(existing.range.adSales, group.range.adSales);
    existing.range.adAttributedSpend = sumOptional(existing.range.adAttributedSpend, group.range.adAttributedSpend);
    existing.range.adAttributedSales = sumOptional(existing.range.adAttributedSales, group.range.adAttributedSales);
    if (!existing.price && group.price) existing.price = group.price;
    group.skuSet.forEach((s) => existing.skuSet.add(s));
    if (!existing.hasLiveSku && groupHasLive) {
      existing.name = group.name;
      existing.hasLiveSku = true;
    }
  });
  return [...merged.values()].map(({ skuSet, hasLiveSku, ...p }) => {
    const masterSkus = masterSkuidsByName?.get(p.name.trim().toLowerCase())?.get(p.platform);
    const sku = masterSkus && masterSkus.length ? [...masterSkus].sort().join(", ") : [...skuSet].join(", ");
    return { ...p, sku };
  });
}
async function fetchDailyAmazonOrders(range, endDate) {
  const rows = await fetchAllRows(
    "barm_daily_am_orders",
    (q) => q.gte("report_date", range.start).lte("report_date", endDate),
    ["report_date", "id"]
  );
  return rows.map((r) => {
    const raw = r.raw || {};
    return {
      amazon_order_id: r.order_id,
      order_item_id: String(raw["order-item-id"] ?? r.order_id),
      purchase_datetime: r.purchase_datetime,
      order_status: r.order_status,
      item_status: raw["item-status"] ?? r.order_status,
      sku: r.sku,
      product_name: r.product_name,
      quantity: r.quantity,
      item_price: r.item_price,
      raw
    };
  });
}
async function fetchDailyFlipkartOrders(range, endDate) {
  const rows = await fetchAllRows(
    "barm_daily_fk_orders",
    (q) => q.gte("report_date", range.start).lte("report_date", endDate),
    ["report_date", "id"]
  );
  return rows.map((r) => {
    const raw = r.raw || {};
    return {
      order_item_id: r.order_item_id,
      order_id: r.order_id,
      order_date: r.report_date || toDate(raw["Ordered On"]),
      order_item_status: r.order_status,
      sku: r.sku,
      fsn: r.fsn,
      product_title: r.product_name,
      quantity: r.quantity,
      raw
    };
  });
}
async function fetchAmazonProducts(range, endDate) {
  const [dailyAdRows, sbCardRows, sdCardRows, mapRows, orderRowsRaw, priceRows] = await Promise.all([
    fetchAllRows("barm_daily_am_ads", (q) => q.gte("report_date", range.start).lte("report_date", endDate), ["report_date", "id"]),
    fetchAllRows("barm_amazon_sb_campaign", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    fetchAllRows("barm_amazon_sd_campaign", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    // No "id" column on this hand-maintained mapping table — order by its
    // natural key instead (fetchAllRows would otherwise error on "id").
    fetchAllRows("barm_amazon_campaign_sku_map", (q) => q, ["campaign_name", "sku"]),
    fetchDailyAmazonOrders(range, endDate),
    fetchAllRows("barm_amazon_price_listing", (q) => q)
  ]);
  const { spRows: spRowsRaw, sbRows, sdRows } = dailyAmAdsReportRows(dailyAdRows, sbCardRows, sdCardRows);
  const spRows = spRowsRaw;
  const splitDays = spCampaignDays(spRows);
  const sbSdRows = [...sbRows, ...sdRows].filter((r) => !isSplitCoveredCampaignRow(r, splitDays));
  const seenOrderRow = /* @__PURE__ */ new Set();
  const orderRows = orderRowsRaw.filter((r) => {
    const key2 = `${r.order_item_id}|${r.item_status}|${r.quantity}`;
    if (seenOrderRow.has(key2)) return false;
    seenOrderRow.add(key2);
    return true;
  });
  const campaignSkuMap = /* @__PURE__ */ new Map();
  mapRows.forEach((r) => {
    const weight = Number(r.weight);
    const list = campaignSkuMap.get(r.campaign_name) || [];
    list.push({ sku: r.sku, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 });
    campaignSkuMap.set(r.campaign_name, list);
  });
  const campaignShares = (campaignName) => {
    const list = campaignSkuMap.get(campaignName);
    if (!list || !list.length) return null;
    const total = list.reduce((s, e) => s + e.weight, 0);
    if (total <= 0) return null;
    return list.map((e) => ({ sku: e.sku, share: e.weight / total }));
  };
  const priceBySku = /* @__PURE__ */ new Map();
  priceRows.forEach((r) => {
    if (r.seller_sku && num3(r.price) > 0) priceBySku.set(r.seller_sku, num3(r.price));
  });
  const listedSkus = /* @__PURE__ */ new Set();
  priceRows.forEach((r) => {
    if (r.seller_sku && (num3(r.price) > 0 || num3(r.mrp) > 0)) listedSkus.add(r.seller_sku);
  });
  const nameBySku = /* @__PURE__ */ new Map();
  orderRows.forEach((r) => {
    if (r.sku && r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name);
  });
  priceRows.forEach((r) => {
    if (r.seller_sku && r.item_name && !nameBySku.has(r.seller_sku)) nameBySku.set(r.seller_sku, r.item_name);
  });
  const spendBySku = /* @__PURE__ */ new Map();
  const ensureSpend = (sku) => {
    let a = spendBySku.get(sku);
    if (!a) {
      a = emptyAgg();
      spendBySku.set(sku, a);
    }
    return a;
  };
  let unmappedSpend = 0;
  const campaignSpendByDay = /* @__PURE__ */ new Map();
  const addCampaignSpend = (campaign, spend) => {
    if (!campaign) return;
    campaignSpendByDay.set(campaign, (campaignSpendByDay.get(campaign) || 0) + spend);
  };
  const adSpendRangeBySku = /* @__PURE__ */ new Map();
  const adSalesRangeBySku = /* @__PURE__ */ new Map();
  const adSpendDayBySku = /* @__PURE__ */ new Map();
  const adSalesDayBySku = /* @__PURE__ */ new Map();
  const adOrdersRangeBySku = /* @__PURE__ */ new Map();
  const adOrdersDayBySku = /* @__PURE__ */ new Map();
  spRows.forEach((r) => {
    if (!r.advertised_sku) return;
    const spend = num3(r.spend);
    const a = ensureSpend(r.advertised_sku);
    a.spend += spend;
    if (r.report_date === endDate) addCampaignSpend(r.campaign_name || "", spend);
    const sku = r.advertised_sku;
    const sales7d = num3(r.sales_7d);
    const orders7d = num3(r.orders_7d);
    adSpendRangeBySku.set(sku, (adSpendRangeBySku.get(sku) || 0) + spend);
    adSalesRangeBySku.set(sku, (adSalesRangeBySku.get(sku) || 0) + sales7d);
    adOrdersRangeBySku.set(sku, (adOrdersRangeBySku.get(sku) || 0) + orders7d);
    if (r.report_date === endDate) {
      adSpendDayBySku.set(sku, (adSpendDayBySku.get(sku) || 0) + spend);
      adSalesDayBySku.set(sku, (adSalesDayBySku.get(sku) || 0) + sales7d);
      adOrdersDayBySku.set(sku, (adOrdersDayBySku.get(sku) || 0) + orders7d);
    }
  });
  sbSdRows.forEach((r) => {
    const spend = num3(r.spend);
    if (r.report_date === endDate) addCampaignSpend(r.campaign_name || "", spend);
    if (spend <= 0) return;
    const shares = campaignShares(r.campaign_name || "");
    if (!shares) {
      unmappedSpend += spend;
      return;
    }
    shares.forEach(({ sku, share }) => {
      ensureSpend(sku).spend += spend * share;
    });
  });
  const unmappedCampaigns = unmappedCampaignSpend(sbSdRows, (c) => !!campaignShares(c));
  const unmappedSpendDay = unmappedCampaignSpend(sbSdRows.filter((r) => r.report_date === endDate), (c) => !!campaignShares(c)).reduce((s, c) => s + c.spend, 0);
  const campaignsMissingOnEndDate = campaignsMissingOnDay([...sbRows, ...sdRows], spRows, endDate);
  const spendBySkuDay = /* @__PURE__ */ new Map();
  const addDay = (sku, spend) => spendBySkuDay.set(sku, (spendBySkuDay.get(sku) || 0) + spend);
  spRows.filter((r) => r.report_date === endDate).forEach((r) => {
    if (r.advertised_sku) addDay(r.advertised_sku, num3(r.spend));
  });
  sbSdRows.filter((r) => r.report_date === endDate).forEach((r) => {
    const spend = num3(r.spend);
    if (spend <= 0) return;
    const shares = campaignShares(r.campaign_name || "");
    if (!shares) return;
    shares.forEach(({ sku, share }) => addDay(sku, spend * share));
  });
  const dayIst = istDayWindowUtc(endDate, endDate);
  const dayGte = Date.parse(dayIst.gte);
  const dayLt = Date.parse(dayIst.lt);
  const unitsBySku = /* @__PURE__ */ new Map();
  const ensureUnits = (sku) => {
    let a = unitsBySku.get(sku);
    if (!a) {
      a = emptyAgg();
      unitsBySku.set(sku, a);
    }
    return a;
  };
  const revenueBySku = /* @__PURE__ */ new Map();
  const overallDay = emptySales();
  const overallRange = emptySales();
  orderRows.forEach((r) => {
    const qty = num3(r.quantity);
    overallRange.units += qty;
    overallRange.value += num3(r.item_price);
    const ts = Date.parse(String(r.purchase_datetime || ""));
    if (Number.isFinite(ts) && ts >= dayGte && ts < dayLt) {
      overallDay.units += qty;
      overallDay.value += num3(r.item_price);
    }
    if (!r.sku || isCancelledOrder(r) || !isStandardOrderId(r.amazon_order_id)) return;
    ensureUnits(r.sku).units += qty;
    revenueBySku.set(r.sku, (revenueBySku.get(r.sku) || 0) + num3(r.item_price));
  });
  const skus = new Set([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys(), ...listedSkus].filter(Boolean));
  const products = /* @__PURE__ */ new Map();
  skus.forEach((sku) => {
    const rangeSpend = spendBySku.get(sku)?.spend || 0;
    const daySpend = spendBySkuDay.get(sku) || 0;
    const rangeUnits = unitsBySku.get(sku)?.units || 0;
    const hasSpRow = adSalesRangeBySku.has(sku) || adSpendRangeBySku.has(sku);
    products.set(sku, {
      platform: "Amazon",
      sku,
      name: resolveProductName(nameBySku.get(sku), sku) || nameBySku.get(sku) || sku,
      price: priceBySku.get(sku) || 0,
      day: {
        spend: daySpend,
        units: 0,
        revenue: 0,
        // adOrders (Sponsored Products' own "7 Day Total Orders") is gated behind the same hasSpRow
        // check as adAttributedSpend/Sales below, not set unconditionally: computeAcos's Amazon
        // branch (adAttributedSales !== undefined) already short-circuits before ever inspecting
        // adOrders whenever hasSpRow is true, so this only matters for an SB/SD-only SKU (no SP
        // row) — there it MUST stay undefined so computeAcos falls through to its real-revenue
        // fallback, not a false adOrders=0-driven blank.
        ...hasSpRow ? { adAttributedSpend: adSpendDayBySku.get(sku) || 0, adAttributedSales: adSalesDayBySku.get(sku) || 0, adOrders: adOrdersDayBySku.get(sku) || 0 } : {}
      },
      range: {
        spend: rangeSpend,
        units: rangeUnits,
        revenue: revenueBySku.get(sku) || 0,
        ...hasSpRow ? { adAttributedSpend: adSpendRangeBySku.get(sku) || 0, adAttributedSales: adSalesRangeBySku.get(sku) || 0, adOrders: adOrdersRangeBySku.get(sku) || 0 } : {}
      }
    });
  });
  orderRows.forEach((r) => {
    if (!r.sku || isCancelledOrder(r) || !isStandardOrderId(r.amazon_order_id)) return;
    const ts = Date.parse(String(r.purchase_datetime || ""));
    if (!(Number.isFinite(ts) && ts >= dayGte && ts < dayLt)) return;
    const p = products.get(r.sku);
    if (!p) return;
    const qty = num3(r.quantity);
    p.day.units += qty;
    p.day.revenue = (p.day.revenue || 0) + num3(r.item_price);
  });
  const campaigns = [...campaignSpendByDay.entries()].filter(([, spend]) => spend > 0).map(([campaign, spend]) => ({ platform: "Amazon", campaign, spend }));
  const reportDates = /* @__PURE__ */ new Set();
  [...spRows, ...sbRows, ...sdRows].forEach((r) => {
    if (r.report_date) reportDates.add(r.report_date);
  });
  return { products, overallDay, overallRange, campaigns, unmappedSpend, unmappedSpendDay, unmappedCampaigns, campaignsMissingOnEndDate, reportDates, spRows, spRowsRaw, orderRows, revenueRangeBySku: revenueBySku };
}
async function fetchAmazonListingPriceMap() {
  const rows = await fetchAllRows("barm_amazon_price_listing", (q) => q);
  const map = /* @__PURE__ */ new Map();
  rows.forEach((r) => {
    if (r.seller_sku && num3(r.price) > 0) map.set(r.seller_sku, num3(r.price));
  });
  return map;
}
function flipkartRowRevenue(rawInvoiceAmount, quantity, listingPrice) {
  if (rawInvoiceAmount > 0) return rawInvoiceAmount;
  return quantity * (listingPrice && listingPrice > 0 ? listingPrice : 0);
}
async function fetchFlipkartProducts(range, endDate, flipkartListingPriceMap = /* @__PURE__ */ new Map()) {
  const [fsnRows, orderRowsRaw, earnRows, listingRows, priceListRows] = await Promise.all([
    fetchAllRows("barm_flipkart_fsn_report", (q) => q.gte("report_date", range.start).lte("report_date", endDate)),
    fetchDailyFlipkartOrders(range, endDate),
    fetchAllRows("barm_flipkart_earn_more", (q) => q.gte("order_date", range.start).lte("order_date", endDate)).catch(() => []),
    fetchAllRows("barm_flipkart_listings", (q) => q).catch(() => []),
    // flipkart_price_list (scripts/flipkart_price_list_table.sql) holds the
    // seller's own manual master-price-list workbook, filtered to the
    // Flipkart-tagged rows — a fallback below barm_flipkart_listings (which
    // stays authoritative when Flipkart's own official Listings export has
    // been uploaded) for a SKU neither that table nor real orders cover yet.
    // Wrapped in .catch(() => []) like the tables above: if this table
    // hasn't been created yet, Flipkart just falls through to the existing
    // Earn More ASP fallback rather than breaking the report.
    fetchAllRows("flipkart_price_list", (q) => q).catch(() => [])
  ]);
  const seen = /* @__PURE__ */ new Set();
  const orderRows = orderRowsRaw.filter((r) => {
    const key2 = `${r.order_item_id}|${r.order_item_status}|${r.quantity}`;
    if (seen.has(key2)) return false;
    seen.add(key2);
    return true;
  });
  const priceBySku = /* @__PURE__ */ new Map();
  listingRows.forEach((r) => {
    if (r.seller_sku_id && num3(r.selling_price) > 0) priceBySku.set(r.seller_sku_id, num3(r.selling_price));
  });
  const priceListBySku = /* @__PURE__ */ new Map();
  priceListRows.forEach((r) => {
    if (r.sku_id && num3(r.price) > 0) priceListBySku.set(r.sku_id, num3(r.price));
  });
  const aspAcc = /* @__PURE__ */ new Map();
  earnRows.forEach((r) => {
    if (!r.sku_id) return;
    const a = aspAcc.get(r.sku_id) || { amount: 0, units: 0 };
    a.amount += num3(r.final_sale_amount);
    a.units += num3(r.final_sale_units) || num3(r.gross_units);
    aspAcc.set(r.sku_id, a);
  });
  const nameBySku = /* @__PURE__ */ new Map();
  fsnRows.forEach((r) => {
    if (r.sku_id && r.product_name && !nameBySku.has(r.sku_id)) nameBySku.set(r.sku_id, r.product_name);
  });
  orderRows.forEach((r) => {
    if (r.sku && r.product_title && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_title);
  });
  const spendBySku = /* @__PURE__ */ new Map();
  const spendBySkuDay = /* @__PURE__ */ new Map();
  const campaignSpendDay = /* @__PURE__ */ new Map();
  const ensureSpend = (sku) => {
    let a = spendBySku.get(sku);
    if (!a) {
      a = emptyAgg();
      spendBySku.set(sku, a);
    }
    return a;
  };
  const adSalesRangeBySku = /* @__PURE__ */ new Map();
  const adSalesDayBySku = /* @__PURE__ */ new Map();
  const adOrdersRangeBySku = /* @__PURE__ */ new Map();
  const adOrdersDayBySku = /* @__PURE__ */ new Map();
  fsnRows.forEach((r) => {
    if (!r.sku_id) return;
    const spend = num3(r.ad_spend);
    ensureSpend(r.sku_id).spend += spend;
    const adSales = num3(r.total_revenue);
    const adOrders = num3(r.direct_units_sold) + num3(r.indirect_units_sold);
    adSalesRangeBySku.set(r.sku_id, (adSalesRangeBySku.get(r.sku_id) || 0) + adSales);
    adOrdersRangeBySku.set(r.sku_id, (adOrdersRangeBySku.get(r.sku_id) || 0) + adOrders);
    if (r.report_date === endDate) {
      spendBySkuDay.set(r.sku_id, (spendBySkuDay.get(r.sku_id) || 0) + spend);
      if (spend > 0) campaignSpendDay.set(r.campaign_name || "", (campaignSpendDay.get(r.campaign_name || "") || 0) + spend);
      adSalesDayBySku.set(r.sku_id, (adSalesDayBySku.get(r.sku_id) || 0) + adSales);
      adOrdersDayBySku.set(r.sku_id, (adOrdersDayBySku.get(r.sku_id) || 0) + adOrders);
    }
  });
  const unitsBySku = /* @__PURE__ */ new Map();
  const ensureUnits = (sku) => {
    let a = unitsBySku.get(sku);
    if (!a) {
      a = emptyAgg();
      unitsBySku.set(sku, a);
    }
    return a;
  };
  const overallDay = emptySales();
  const overallRange = emptySales();
  const invoiceAcc = /* @__PURE__ */ new Map();
  const rangeRevenueBySku = /* @__PURE__ */ new Map();
  orderRows.forEach((r) => {
    const qty = num3(r.quantity);
    const invoiceAmount = num3(r.raw?.["Invoice Amount"]);
    const revenueAmount = flipkartRowRevenue(invoiceAmount, qty, flipkartListingPriceMap.get(r.sku || ""));
    overallRange.units += qty;
    overallRange.value += revenueAmount;
    if (r.order_date === endDate) {
      overallDay.units += qty;
      overallDay.value += revenueAmount;
    }
    if (!r.sku) return;
    const status = String(r.order_item_status || "").toUpperCase();
    if (status.startsWith("CANCEL")) return;
    ensureUnits(r.sku).units += qty;
    if (qty > 0 && invoiceAmount > 0) {
      const acc = invoiceAcc.get(r.sku) || { amount: 0, units: 0 };
      acc.amount += invoiceAmount;
      acc.units += qty;
      invoiceAcc.set(r.sku, acc);
    }
    if (qty > 0 && revenueAmount > 0) {
      rangeRevenueBySku.set(r.sku, (rangeRevenueBySku.get(r.sku) || 0) + revenueAmount);
    }
  });
  const skus = new Set([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys()].filter(Boolean));
  const products = /* @__PURE__ */ new Map();
  skus.forEach((sku) => {
    const inv = invoiceAcc.get(sku);
    let price = inv && inv.units > 0 ? inv.amount / inv.units : 0;
    if (price <= 0) price = priceBySku.get(sku) || 0;
    if (price <= 0) price = priceListBySku.get(sku) || 0;
    if (price <= 0) {
      const a = aspAcc.get(sku);
      if (a && a.units > 0) price = a.amount / a.units;
    }
    products.set(sku, {
      platform: "Flipkart",
      sku,
      name: resolveProductName(nameBySku.get(sku), sku) || nameBySku.get(sku) || sku,
      price,
      day: { spend: spendBySkuDay.get(sku) || 0, units: 0, revenue: 0, adSales: adSalesDayBySku.get(sku) || 0, adOrders: adOrdersDayBySku.get(sku) || 0 },
      range: { spend: spendBySku.get(sku)?.spend || 0, units: unitsBySku.get(sku)?.units || 0, revenue: rangeRevenueBySku.get(sku) || 0, adSales: adSalesRangeBySku.get(sku) || 0, adOrders: adOrdersRangeBySku.get(sku) || 0 }
    });
  });
  orderRows.forEach((r) => {
    if (!r.sku || r.order_date !== endDate) return;
    const status = String(r.order_item_status || "").toUpperCase();
    if (status.startsWith("CANCEL")) return;
    const p = products.get(r.sku);
    if (!p) return;
    const qty = num3(r.quantity);
    p.day.units += qty;
    const invoiceAmount = num3(r.raw?.["Invoice Amount"]);
    p.day.revenue = (p.day.revenue || 0) + flipkartRowRevenue(invoiceAmount, qty, flipkartListingPriceMap.get(r.sku));
  });
  const campaigns = [...campaignSpendDay.entries()].filter(([, spend]) => spend > 0).map(([campaign, spend]) => ({ platform: "Flipkart", campaign, spend }));
  const reportDates = /* @__PURE__ */ new Set();
  fsnRows.forEach((r) => {
    if (r.report_date) reportDates.add(r.report_date);
  });
  const revenueRangeBySku = rangeRevenueBySku;
  return { products, overallDay, overallRange, campaigns, reportDates, fsnRows, orderRows, revenueRangeBySku };
}
async function fetchFlipkartListingPriceMap() {
  const rows = await fetchAllRows("barm_flipkart_listings", (q) => q);
  const map = /* @__PURE__ */ new Map();
  rows.forEach((r) => {
    if (r.seller_sku_id && num3(r.selling_price) > 0) map.set(r.seller_sku_id, num3(r.selling_price));
  });
  return map;
}
async function fetchMeeshoDailyOrderRows(start, end) {
  const rows = await fetchAllRows("barm_daily_ms_barm_orders", (q) => q.gte("report_date", start).lte("report_date", end));
  return rows.map((r) => ({
    ...r,
    order_date: r.report_date,
    supplier_listed_price: r.listed_price,
    supplier_discounted_price: r.discounted_price
  }));
}
async function fetchMeeshoProducts(range, endDate) {
  const loadErrors = [];
  const loadFailed = (table) => (e) => {
    loadErrors.push(`${table}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  };
  const [adsRows, orderRows, marketingRows] = await Promise.all([
    // barm_meesho_ads was dropped (29 Sep 2026); barm_daily_ms_barm_ads is the
    // combined upload's "MS BARM ads" copy with the same columns and rows.
    fetchAllRows("barm_daily_ms_barm_ads", (q) => q.gte("report_date", range.start).lte("report_date", endDate)).catch(loadFailed("barm_daily_ms_barm_ads")),
    fetchMeeshoDailyOrderRows(range.start, endDate).catch(loadFailed("barm_daily_ms_barm_orders")),
    // meesho_price_marketing (scripts/meesho_price_marketing_table.sql) holds
    // the live scraped Meesho listing price per SKU — the same role
    // barm_amazon_price_listing/barm_flipkart_listings play for the other two
    // platforms. A failure is recorded like the tables above, and Meesho
    // falls back to its order-derived price below rather than breaking the
    // report.
    fetchAllRows("meesho_price_marketing", (q) => q).catch(loadFailed("meesho_price_marketing"))
  ]);
  const isCancelled = (status) => String(status || "").toUpperCase().startsWith("CANCEL");
  const orderPriceOf = (r) => num3(r.supplier_discounted_price) || num3(r.supplier_listed_price);
  const nameBySku = /* @__PURE__ */ new Map();
  orderRows.forEach((r) => {
    if (r.sku && r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name);
  });
  adsRows.forEach((r) => {
    if (r.sku && r.product_name && !nameBySku.has(r.sku)) nameBySku.set(r.sku, r.product_name);
  });
  const priceBySku = /* @__PURE__ */ new Map();
  marketingRows.forEach((r) => {
    const price = num3(r.price);
    if (r.sku_id && price > 0) priceBySku.set(r.sku_id, price);
  });
  orderRows.forEach((r) => {
    if (!r.sku || priceBySku.has(r.sku)) return;
    const price = orderPriceOf(r);
    if (price > 0) priceBySku.set(r.sku, price);
  });
  const spendBySku = /* @__PURE__ */ new Map();
  const spendBySkuDay = /* @__PURE__ */ new Map();
  const campaignSpendDay = /* @__PURE__ */ new Map();
  const ensureSpend = (sku) => {
    let a = spendBySku.get(sku);
    if (!a) {
      a = emptyAgg();
      spendBySku.set(sku, a);
    }
    return a;
  };
  const adOrdersRangeBySku = /* @__PURE__ */ new Map();
  const adOrdersDayBySku = /* @__PURE__ */ new Map();
  adsRows.forEach((r) => {
    if (!r.sku) return;
    const spend = num3(r.spend);
    ensureSpend(r.sku).spend += spend;
    const adOrders = num3(r.orders_by_ad);
    adOrdersRangeBySku.set(r.sku, (adOrdersRangeBySku.get(r.sku) || 0) + adOrders);
    if (r.report_date === endDate) {
      spendBySkuDay.set(r.sku, (spendBySkuDay.get(r.sku) || 0) + spend);
      if (spend > 0) campaignSpendDay.set(r.campaign_name || "", (campaignSpendDay.get(r.campaign_name || "") || 0) + spend);
      adOrdersDayBySku.set(r.sku, (adOrdersDayBySku.get(r.sku) || 0) + adOrders);
    }
  });
  const unitsBySku = /* @__PURE__ */ new Map();
  const ensureUnits = (sku) => {
    let a = unitsBySku.get(sku);
    if (!a) {
      a = emptyAgg();
      unitsBySku.set(sku, a);
    }
    return a;
  };
  const revenueBySku = /* @__PURE__ */ new Map();
  const overallDay = emptySales();
  const overallRange = emptySales();
  orderRows.forEach((r) => {
    const qty = num3(r.quantity);
    const price = num3(r.supplier_listed_price);
    const value = price * qty;
    overallRange.units += qty;
    overallRange.value += value;
    if (r.order_date === endDate) {
      overallDay.units += qty;
      overallDay.value += value;
    }
    if (!r.sku || isCancelled(r.order_status)) return;
    ensureUnits(r.sku).units += qty;
    revenueBySku.set(r.sku, (revenueBySku.get(r.sku) || 0) + value);
  });
  const skus = new Set([...spendBySku.keys(), ...unitsBySku.keys(), ...priceBySku.keys()].filter(Boolean));
  const products = /* @__PURE__ */ new Map();
  skus.forEach((sku) => {
    products.set(sku, {
      platform: "Meesho",
      sku,
      name: resolveProductName(nameBySku.get(sku), sku) || nameBySku.get(sku) || sku,
      price: priceBySku.get(sku) || 0,
      day: { spend: spendBySkuDay.get(sku) || 0, units: 0, revenue: 0, adOrders: adOrdersDayBySku.get(sku) || 0 },
      // revenue: real per-order Quantity x Supplier Listed Price (revenueBySku, same raw source as
      // the Order Value fix above) — per the seller's later, confirmed instruction that Meesho's
      // Total Sales (Summary/Ad spend report/SKU Wise Report) must match raw data too, not stay on
      // the flat Price(meesho_price_marketing) x Orders estimate this used to fall back to. The
      // display "Price" column (priceBySku above) and the ACOS CPC/Price fallback are unaffected —
      // both still read meesho_price_marketing as before; only Total Sales changed.
      range: { spend: spendBySku.get(sku)?.spend || 0, units: unitsBySku.get(sku)?.units || 0, revenue: revenueBySku.get(sku) || 0, adOrders: adOrdersRangeBySku.get(sku) || 0 }
    });
  });
  orderRows.forEach((r) => {
    if (!r.sku || r.order_date !== endDate || isCancelled(r.order_status)) return;
    const p = products.get(r.sku);
    if (!p) return;
    p.day.units += num3(r.quantity);
    p.day.revenue = (p.day.revenue || 0) + num3(r.quantity) * num3(r.supplier_listed_price);
  });
  const campaigns = [...campaignSpendDay.entries()].filter(([, spend]) => spend > 0).map(([campaign, spend]) => ({ platform: "Meesho", campaign, spend }));
  const reportDates = /* @__PURE__ */ new Set();
  adsRows.forEach((r) => {
    if (r.report_date) reportDates.add(r.report_date);
  });
  return { products, overallDay, overallRange, campaigns, reportDates, adsRows, orderRows, revenueRangeBySku: revenueBySku, loadErrors };
}
async function fetchSocialMediaAdSpend(range, endDate) {
  return fetchWindowedAdSpend("barm_daily_social_media", range, endDate, { fullWindowOnly: true });
}
var SOCIAL_MEDIA_CAMPAIGN_PRODUCTS = [
  { match: /peak\s*flow/i, product: "Sonmol Peak Flow meter (without BLE)" },
  { match: /insemin/i, product: "Insemination kit (Pack of 5)" },
  // Pack-size split (24 Nov 2026): a postpartum campaign/ad naming "6 pcs" or "10 pcs" lands on that
  // kit. These two must stay before the generic postpartum rule (no pack size → the 10 pcs kit).
  { match: /post\s*pa.*(?:^|[^0-9])6\s*-?\s*(?:pcs|pc|pieces|piece)\b/i, product: "Postpartum Recovery Essentials care kit (6 pcs kit)" },
  { match: /post\s*pa.*(?:^|[^0-9])10\s*-?\s*(?:pcs|pc|pieces|piece)\b/i, product: "Postpartum Recovery Essentials care kit (10 pcs kit)" },
  { match: /post\s*pa/i, product: "Postpartum Recovery Essentials care kit (10 pcs kit)" }
];
var GOOGLE_CAMPAIGN_PRODUCTS = [
  ...SOCIAL_MEDIA_CAMPAIGN_PRODUCTS,
  { match: /\bv\.?\s?d\b|dilator/i, product: "Vaginal Dilator" },
  { match: /lacto/i, product: "Lacto Spark lactate meter" }
];
function googleProductFor(name) {
  const clean = name.replace(/\s+/g, " ").trim();
  return GOOGLE_CAMPAIGN_PRODUCTS.find((m) => m.match.test(clean))?.product ?? clean;
}
function socialMediaProductFor(campaign) {
  const campaignPart = metaCampaignPart(campaign);
  return SOCIAL_MEDIA_CAMPAIGN_PRODUCTS.find((m) => m.match.test(campaignPart))?.product ?? campaignPart;
}
var META_AD_SALES_SOURCE = "meta_reported";
async function fetchWindowedAdSpend(table, range, endDate, opts = {}) {
  const rows = await fetchAllRows(
    table,
    (q) => q.lte("report_start", endDate).gte("report_end", range.start)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).catch(() => []);
  const campaignKey = (r) => String(r.campaign_name || "").replace(/\s+/g, " ").trim().toLowerCase();
  const campaigns = /* @__PURE__ */ new Map();
  const campaignFor = (r) => {
    const key2 = campaignKey(r);
    const hit = campaigns.get(key2) ?? {
      name: String(r.campaign_name || "").replace(/\s+/g, " ").trim(),
      daySpend: 0,
      rangeSpend: 0,
      adNames: [],
      dayMetaValue: null,
      rangeMetaValue: null,
      dayMetaPurchases: null,
      rangeMetaPurchases: null
    };
    campaigns.set(key2, hit);
    return hit;
  };
  const adNamesOf = (r) => String(r.raw?.["Ad name"] ?? "").split(";").map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean);
  const rawNum = (r, col) => r.raw && col in r.raw ? num3(r.raw[col]) : null;
  const addNum = (a, b) => a == null && b == null ? null : (a ?? 0) + (b ?? 0);
  rows.filter((r) => r.report_start === endDate && r.report_end === endDate).forEach((r) => {
    const c = campaignFor(r);
    c.daySpend += num3(r.spend);
    c.dayMetaValue = addNum(c.dayMetaValue, rawNum(r, "Meta purchase value"));
    c.dayMetaPurchases = addNum(c.dayMetaPurchases, rawNum(r, "Meta purchases"));
    if (num3(r.spend) > 0) adNamesOf(r).forEach((a) => {
      if (!c.adNames.includes(a)) c.adNames.push(a);
    });
  });
  const byCampaign = /* @__PURE__ */ new Map();
  rows.filter((r) => r.report_start >= range.start && r.report_end <= endDate).forEach((r) => {
    const key2 = campaignKey(r);
    const list2 = byCampaign.get(key2) ?? [];
    list2.push(r);
    byCampaign.set(key2, list2);
  });
  const hasFullWindowExport = !!opts.fullWindowOnly && rows.some((r) => r.report_start === range.start && r.report_end === endDate);
  byCampaign.forEach((campaignRows) => {
    const wideRows = campaignRows.filter((r) => r.report_start === range.start && r.report_end === endDate);
    if (hasFullWindowExport && !wideRows.length) return;
    const used = wideRows.length ? wideRows : campaignRows;
    const c = campaignFor(campaignRows[0]);
    c.rangeSpend += used.reduce((s, r) => s + num3(r.spend), 0);
    used.forEach((r) => {
      c.rangeMetaValue = addNum(c.rangeMetaValue, rawNum(r, "Meta purchase value"));
      c.rangeMetaPurchases = addNum(c.rangeMetaPurchases, rawNum(r, "Meta purchases"));
    });
  });
  const list = [...campaigns.values()].map((c) => ({
    name: c.name,
    daySpend: round2(c.daySpend),
    rangeSpend: round2(c.rangeSpend),
    adNames: c.adNames,
    dayMetaValue: c.dayMetaValue == null ? null : round2(c.dayMetaValue),
    rangeMetaValue: c.rangeMetaValue == null ? null : round2(c.rangeMetaValue),
    dayMetaPurchases: c.dayMetaPurchases,
    rangeMetaPurchases: c.rangeMetaPurchases
  })).filter((c) => c.daySpend > 0 || c.rangeSpend > 0);
  return {
    daySpend: round2(list.reduce((s, c) => s + c.daySpend, 0)),
    rangeSpend: round2(list.reduce((s, c) => s + c.rangeSpend, 0)),
    campaigns: list
  };
}
async function fetchGoogleOrders(range, endDate) {
  const [cardRows, shopify] = await Promise.all([
    fetchAllRows(
      "barm_daily_google_orders",
      (q) => q.gte("order_date", range.start).lte("order_date", range.end)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).catch(() => []),
    // Every real Shopify order (small), so the first Shopify day is known — see googleWebsiteOrders.ts.
    // GET: the function is read-only, and a report build must send no writes (readonly.test.ts).
    supabasePublic.rpc("barm_shopify_orders_summary", {}, { get: true }).then(
      ({ data, error }) => error ? { orders: [], error: error.message } : { orders: data ?? [], error: null },
      (e) => ({ orders: [], error: e instanceof Error ? e.message : String(e) })
    )
  ]);
  const merged = mergeGoogleWebsiteOrders(cardRows, shopify.orders);
  const rows = merged.lines.filter((l) => l.date >= range.start && l.date <= range.end);
  const byProduct = /* @__PURE__ */ new Map();
  const byDateProduct = /* @__PURE__ */ new Map();
  let dayUnits = 0;
  let dayValue = 0;
  let rangeUnits = 0;
  let rangeValue = 0;
  let adDayValue = 0;
  let adRangeValue = 0;
  const adDayOrders = /* @__PURE__ */ new Set();
  const adRangeOrders = /* @__PURE__ */ new Set();
  rows.forEach((r) => {
    const name = r.name;
    const nameKey = name.toLowerCase().replace(/[\s\-_.]+/g, "");
    const date = r.date;
    const qty = r.quantity;
    const price = r.price;
    const value = r.value;
    rangeUnits += qty;
    rangeValue += value;
    if (r.googleAds) {
      adRangeValue += value;
      if (r.order) adRangeOrders.add(r.order);
      if (r.date === endDate) {
        adDayValue += value;
        if (r.order) adDayOrders.add(r.order);
      }
    }
    const acc = byProduct.get(nameKey) || { name, quantity: 0, priceSum: 0, priceCount: 0 };
    acc.quantity += qty;
    if (price > 0) {
      acc.priceSum += price;
      acc.priceCount += 1;
    }
    byProduct.set(nameKey, acc);
    if (r.date === endDate) {
      dayUnits += qty;
      dayValue += value;
    }
    const dateKey = `${date}\0${nameKey}`;
    const dateAcc = byDateProduct.get(dateKey) || { date, name, quantity: 0, priceSum: 0, priceCount: 0 };
    dateAcc.quantity += qty;
    if (price > 0) {
      dateAcc.priceSum += price;
      dateAcc.priceCount += 1;
    }
    byDateProduct.set(dateKey, dateAcc);
  });
  const metaDay = metaAdsAttributedSales(shopify.orders, endDate, endDate);
  const metaRange = metaAdsAttributedSales(shopify.orders, range.start, range.end);
  const dailyPerProduct = [...byDateProduct.values()].map((acc) => ({ name: acc.name, date: acc.date, quantity: acc.quantity, price: acc.priceCount ? acc.priceSum / acc.priceCount : 0 })).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return {
    perProduct: [...byProduct.values()].map((acc) => ({ name: acc.name, quantity: acc.quantity, price: acc.priceCount ? acc.priceSum / acc.priceCount : 0 })).sort((a, b) => b.quantity * b.price - a.quantity * a.price),
    dailyPerProduct,
    dayUnits,
    dayValue: Math.round(dayValue * 100) / 100,
    rangeUnits,
    rangeValue: Math.round(rangeValue * 100) / 100,
    adDayValue: Math.round(adDayValue * 100) / 100,
    adRangeValue: Math.round(adRangeValue * 100) / 100,
    adDayOrders: adDayOrders.size,
    adRangeOrders: adRangeOrders.size,
    adLines: rows.filter((r) => r.googleAds).map((r) => ({ date: r.date, name: r.name, quantity: r.quantity, value: r.value, order: r.order })),
    metaAdDayValue: metaDay.value,
    metaAdRangeValue: metaRange.value,
    metaAdDayOrders: metaDay.orders,
    metaAdRangeOrders: metaRange.orders,
    metaAdOrders: shopify.orders.filter((o) => !o.is_cancelled && o.ad_channel === "meta_ads" && o.order_date >= range.start && o.order_date <= range.end),
    dropped: merged.dropped.filter((d) => d.date >= range.start && d.date <= range.end),
    shopifyLoadError: shopify.error,
    shopifyFrom: merged.shopifyFrom
  };
}
function styleHeader(ws, row, cols, fill, colStart = 0) {
  for (let c = colStart; c < colStart + cols; c++) {
    const addr = XLSX4.utils.encode_cell({ r: row, c });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    ws[addr].s = {
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
      fill: { fgColor: { rgb: fill } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true }
    };
  }
}
function styleLabel(ws, addr, fill) {
  if (!ws[addr]) ws[addr] = { t: "s", v: "" };
  ws[addr].s = { font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11 }, fill: { fgColor: { rgb: fill } } };
}
function blockDivider(ws, col, rows) {
  rows.forEach((r) => {
    const addr = XLSX4.utils.encode_cell({ r, c: col });
    const cell = ws[addr] ?? (ws[addr] = { t: "s", v: "" });
    cell.s = { ...cell.s ?? {}, border: { ...cell.s?.border ?? {}, left: { style: "thick", color: { rgb: "1F2937" } } } };
  });
}
var CURRENCY_FMT = '"\u20B9"#,##0.00';
var PERCENT_FMT = "0%";
function applyNumberFormats(ws, rowStart, rowEnd, colFormats) {
  for (let r = rowStart; r < rowEnd; r++) {
    for (const [colStr, fmt] of Object.entries(colFormats)) {
      const addr = XLSX4.utils.encode_cell({ r, c: Number(colStr) });
      const cell = ws[addr];
      if (cell && typeof cell.v === "number") cell.z = fmt;
    }
  }
}
function extractJsonBlock(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return fenced ? fenced[1] : text;
}
async function callGeminiText(prompt) {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return null;
  const models = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.0-flash"];
  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8e3);
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 2048, temperature: 0.5, thinkingConfig: { thinkingBudget: 256 } }
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) continue;
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch {
    }
  }
  return null;
}
var OPT_MIN_SPEND = 100;
var OPT_ACOS_THRESHOLD = 0.14;
function buildSkuCampaignMap(rows, f) {
  const bySku = /* @__PURE__ */ new Map();
  rows.forEach((r) => {
    const campaignName = r[f.campaign];
    const sku = r[f.sku];
    if (!campaignName || !sku) return;
    const perCampaign = bySku.get(sku) || /* @__PURE__ */ new Map();
    perCampaign.set(campaignName, (perCampaign.get(campaignName) || 0) + num3(r[f.spend]));
    bySku.set(sku, perCampaign);
  });
  const result = /* @__PURE__ */ new Map();
  bySku.forEach((perCampaign, sku) => {
    let best = null;
    let bestSpend = -1;
    perCampaign.forEach((spend, name) => {
      if (spend > bestSpend) {
        bestSpend = spend;
        best = name;
      }
    });
    if (best) result.set(sku, best);
  });
  return result;
}
function aggregateForOptimization(rows, f) {
  const campaigns = /* @__PURE__ */ new Map();
  rows.forEach((r) => {
    const campaignName = r[f.campaign];
    if (!campaignName) return;
    const spend = num3(r[f.spend]);
    const revenue = num3(r[f.revenue]);
    const units = f.units.reduce((s, field) => s + num3(r[field]), 0);
    let c = campaigns.get(campaignName);
    if (!c) {
      c = { name: campaignName, spend: 0, revenue: 0, units: 0, adGroups: /* @__PURE__ */ new Map() };
      campaigns.set(campaignName, c);
    }
    c.spend += spend;
    c.revenue += revenue;
    c.units += units;
    const agName = r[f.adGroup] || "(no ad group)";
    let ag = c.adGroups.get(agName);
    if (!ag) {
      ag = { name: agName, spend: 0, revenue: 0, units: 0, skus: /* @__PURE__ */ new Map() };
      c.adGroups.set(agName, ag);
    }
    ag.spend += spend;
    ag.revenue += revenue;
    ag.units += units;
    const sku = r[f.sku];
    if (sku) ag.skus.set(sku, (ag.skus.get(sku) || 0) + spend);
  });
  return campaigns;
}
async function enrichOptimizationActionRows(actionRows, platform, campaigns, skuToCampaignName, platformLabel, searchTermTool, aiSuggestions) {
  const acosOf = (c) => c.revenue > 0 ? c.spend / c.revenue : c.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
  const acosLabel = (frac) => frac === ACOS_UNDEFINED_SENTINEL ? "unavailable" : `${Math.round(frac * 100)}%`;
  const flagged = [...campaigns.values()].filter((c) => c.spend >= OPT_MIN_SPEND && acosOf(c) >= OPT_ACOS_THRESHOLD).sort((a, b) => b.spend - a.spend).slice(0, 15);
  const suggestionByCampaign = /* @__PURE__ */ new Map();
  flagged.forEach((c) => {
    const worst = [...c.adGroups.values()].sort((a, b) => b.spend - a.spend)[0];
    const acosFrac = acosOf(c);
    const cut = Math.round(acosFrac * 100) >= 90 ? 50 : Math.round(acosFrac * 100) >= 60 ? 35 : 20;
    const pauseNote = worst && worst.units === 0 ? ` Cut this ad group's bids as close to 80% as the platform allows \u2014 zero units sold on \u20B9${round2(worst.spend)} spend.` : "";
    suggestionByCampaign.set(
      c.name,
      `Cut bids ${cut}% on ad group "${worst?.name || c.name}" (ACOS ${acosLabel(acosFrac)}, \u20B9${round2(worst?.spend ?? c.spend)} spend).${pauseNote} Open that ad group's search-term report in ${searchTermTool} first to add negative keywords for zero-conversion terms.`
    );
  });
  if (flagged.length && aiSuggestions) {
    const promptLines = flagged.map((c) => {
      const topAdGroups = [...c.adGroups.values()].sort((a, b) => b.spend - a.spend).slice(0, 5);
      const agLines = topAdGroups.map((ag) => {
        const agAcosFrac = ag.revenue > 0 ? ag.spend / ag.revenue : ag.spend > 0 ? ACOS_UNDEFINED_SENTINEL : 0;
        const topSkus = [...ag.skus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sku]) => sku);
        return `    - Ad group "${ag.name}" (top SKUs: ${topSkus.join(", ") || "n/a"}): spend \u20B9${round2(ag.spend)}, revenue \u20B9${round2(ag.revenue)}, ACOS ${acosLabel(agAcosFrac)}, units sold ${ag.units}`;
      }).join("\n");
      return `- Campaign "${c.name}": spend \u20B9${round2(c.spend)}, revenue \u20B9${round2(c.revenue)}, ACOS ${acosLabel(acosOf(c))}, units sold ${c.units}
  Ad groups within this campaign:
${agLines}`;
    }).join("\n");
    const prompt = `You are a ${platformLabel} PPC analyst. Over the trailing 7 days, these campaigns exceeded the 14% ACOS threshold, broken down by ad group and top SKU:

${promptLines}

Return ONLY a JSON object, no markdown fences, no text outside the JSON, of this exact shape:
{"campaigns":[{"name":"<exact campaign name as given above>","suggestion":"<1-2 sentences: a specific bid or budget cut % on a named ad group \u2014 never tell the seller to pause or stop a campaign, always give a concrete % cut instead (use an aggressive cut like 70-80% for an ad group with 0 units sold); end by naming which ad group to open ${searchTermTool}'s search-term report for first to add negative keywords \u2014 never invent a specific search term or keyword, since none is available in this data>"}]}
Include every one of the ${flagged.length} campaigns listed above, using their exact name string.`;
    try {
      const geminiText = await callGeminiText(prompt);
      if (geminiText) {
        const parsed = JSON.parse(extractJsonBlock(geminiText));
        const entries = parsed?.campaigns || [];
        entries.forEach((e) => {
          if (e.name && e.suggestion && suggestionByCampaign.has(e.name)) suggestionByCampaign.set(e.name, e.suggestion);
        });
      }
    } catch {
    }
  }
  actionRows.forEach((r) => {
    if (r.platform !== platform) return;
    const skus = r.sku ? r.sku.split(",").map((s) => s.trim()).filter(Boolean) : [];
    let bestCampaign = null;
    for (const sku of skus) {
      const hit = skuToCampaignName.get(sku);
      if (hit) {
        bestCampaign = hit;
        break;
      }
    }
    if (!bestCampaign) return;
    r.campaign = bestCampaign;
    const suggestion = suggestionByCampaign.get(bestCampaign);
    if (suggestion) {
      r.action = suggestion;
      return;
    }
    const acosPct = Math.round(r.acos * 100);
    const cut = acosPct >= 90 ? 50 : acosPct >= 60 ? 35 : 20;
    r.action = `Cut bids ~${cut}% on campaign "${bestCampaign}" (this SKU's 7-day ACOS ${acosLabel(r.acos)}). Open ${searchTermTool}'s search-term report for this campaign to add negative keywords for zero-conversion terms.`;
  });
}
async function enrichFlipkartActionRows(actionRows, fsnRows, aiSuggestions) {
  const campaigns = aggregateForOptimization(fsnRows, {
    campaign: "campaign_name",
    adGroup: "adgroup_name",
    sku: "sku_id",
    spend: "ad_spend",
    revenue: "total_revenue",
    units: ["direct_units_sold", "indirect_units_sold"]
  });
  const skuToCampaignName = buildSkuCampaignMap(fsnRows, { campaign: "campaign_name", sku: "sku_id", spend: "ad_spend" });
  await enrichOptimizationActionRows(actionRows, "Flipkart", campaigns, skuToCampaignName, "Flipkart Ads", "Flipkart Ads Manager", aiSuggestions);
}
async function enrichAmazonActionRows(actionRows, spRows, endDate, aiSuggestions) {
  const dayRows = spRows.filter((r) => r.report_date === endDate);
  const campaigns = aggregateForOptimization(dayRows, {
    campaign: "campaign_name",
    adGroup: "ad_group_name",
    sku: "advertised_sku",
    spend: "spend",
    revenue: "sales_7d",
    units: ["orders_7d"]
  });
  const skuToCampaignName = buildSkuCampaignMap(spRows, { campaign: "campaign_name", sku: "advertised_sku", spend: "spend" });
  await enrichOptimizationActionRows(actionRows, "Amazon", campaigns, skuToCampaignName, "Amazon Ads", "Amazon Ads Console", aiSuggestions);
}
function rawRowsToSheet(wb, sheetName, rows, sideBlock, emptyText = "(no data in range)") {
  const rawRows = rows.map((r) => r?.raw).filter((r) => !!r);
  const writeSideBlock = (ws2, colStart) => {
    if (!sideBlock) return;
    XLSX4.utils.sheet_add_aoa(ws2, [sideBlock.header, ...sideBlock.rows], { origin: { r: 0, c: colStart } });
    styleHeader(ws2, 0, sideBlock.header.length, "6B7280", colStart);
    applyNumberFormats(
      ws2,
      1,
      sideBlock.rows.length + 1,
      Object.fromEntries(sideBlock.currencyCols.map((c) => [colStart + c, CURRENCY_FMT]))
    );
    if (!ws2["!cols"]) ws2["!cols"] = [];
    const wsCols = ws2["!cols"];
    while (wsCols.length < colStart) wsCols.push({ wch: 16 });
    wsCols.push({ wch: 40 }, ...sideBlock.header.slice(1).map(() => ({ wch: 12 })));
  };
  if (!rawRows.length) {
    const ws2 = XLSX4.utils.aoa_to_sheet([[emptyText]]);
    writeSideBlock(ws2, 2);
    XLSX4.utils.book_append_sheet(wb, ws2, sheetName);
    return;
  }
  const cols = [];
  const seen = /* @__PURE__ */ new Set();
  rawRows.forEach((r) => Object.keys(r).forEach((k) => {
    if (!seen.has(k)) {
      seen.add(k);
      cols.push(k);
    }
  }));
  const DATE_HEADER_RE = /date/i;
  const SWAPPED_DM_HEADER_RE = /\(mm\/dd\/yy\)/i;
  const excelSerialToDmy = (v, swapDayMonth) => {
    try {
      const d = XLSX4.SSF?.parse_date_code(v);
      if (!d || !d.y) return null;
      const day = swapDayMonth ? d.m : d.d;
      const month = swapDayMonth ? d.d : d.m;
      return `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${d.y}`;
    } catch {
      return null;
    }
  };
  const mdyTextToDmy = (v) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(v.trim());
    if (!m) return null;
    const [, mm, dd, yy] = m;
    return `${dd.padStart(2, "0")}-${mm.padStart(2, "0")}-20${yy}`;
  };
  const aoa = [cols];
  rawRows.forEach((r) => {
    aoa.push(
      cols.map((c) => {
        const v = r[c];
        if (v === null || v === void 0) return "";
        if (typeof v === "number" && DATE_HEADER_RE.test(c)) {
          const formatted = excelSerialToDmy(v, SWAPPED_DM_HEADER_RE.test(c));
          if (formatted) return formatted;
        }
        if (typeof v === "string" && SWAPPED_DM_HEADER_RE.test(c)) {
          const formatted = mdyTextToDmy(v);
          if (formatted) return formatted;
        }
        return typeof v === "number" || typeof v === "string" ? v : String(v);
      })
    );
  });
  const ws = XLSX4.utils.aoa_to_sheet(aoa);
  styleHeader(ws, 0, cols.length, "6B7280");
  ws["!views"] = [{ state: "frozen", ySplit: 1 }];
  ws["!cols"] = cols.map(() => ({ wch: 16 }));
  const PERCENT_HEADER_RE = /ACOS|Conversion Rate|Click-?Thru Rate|\bCTR\b/i;
  const percentCols = {};
  cols.forEach((c, i) => {
    if (PERCENT_HEADER_RE.test(c)) percentCols[i] = "0.00%";
  });
  if (Object.keys(percentCols).length) applyNumberFormats(ws, 1, aoa.length, percentCols);
  writeSideBlock(ws, cols.length + 1);
  XLSX4.utils.book_append_sheet(wb, ws, sheetName);
}
var PLATFORM_FILL = { Amazon: "FF9900", Flipkart: "2874F0", Meesho: "9F2089" };
var META_FILL = "0E7490";
var GOOGLE_FILL = "34A853";
var priceCell = (price) => price > 0 ? price : "N/A";
var productAoaRow = (p, listingPrice) => [
  p.name,
  priceCell(p.price),
  round2(p.day.spend),
  round2(spendTax(p.day)),
  p.day.units,
  round2(computeCpc(p.day)),
  acosCell(p.day, p.price, listingPrice),
  round2(p.range.spend),
  round2(spendTax(p.range)),
  p.range.units,
  round2(computeCpc(p.range)),
  acosCell(p.range, p.price, listingPrice)
];
function round2(n) {
  return Math.round(n * 100) / 100;
}
function pct(n) {
  return Math.round(n * 1e4) / 1e4;
}
function acosCell(a, price, listingPrice) {
  const v = computeAcos(a, price, listingPrice);
  return v === ACOS_UNDEFINED_SENTINEL ? null : pct(v);
}
function acosSortRank(a, price, listingPrice) {
  const v = computeAcos(a, price, listingPrice);
  return v === ACOS_UNDEFINED_SENTINEL ? -1 : v;
}
async function saveAdSpendHistory(platforms, endDate, rangeStart, listingPriceFor) {
  const rows = [];
  platforms.forEach(({ platform, products }) => {
    products.forEach((p) => {
      if (spendTax(p.range) <= 0 && p.range.units <= 0) return;
      const listingPrice = listingPriceFor(platform, p.sku);
      rows.push({
        report_date: endDate,
        range_start: rangeStart,
        platform,
        sku: p.sku,
        product_name: p.name,
        price: p.price,
        day_spend: round2(p.day.spend),
        day_spend_tax: round2(spendTax(p.day)),
        day_orders: p.day.units,
        day_cpc: round2(computeCpc(p.day)),
        day_acos: acosCell(p.day, p.price, listingPrice),
        range_spend: round2(p.range.spend),
        range_spend_tax: round2(spendTax(p.range)),
        range_orders: p.range.units,
        range_cpc: round2(computeCpc(p.range)),
        range_acos: acosCell(p.range, p.price, listingPrice)
      });
    });
  });
  if (!rows.length) return 0;
  try {
    await upsertInChunks("barm_ad_spend_history", rows, "report_date,platform,sku");
    return rows.length;
  } catch (err) {
    console.error("[adSpendReportExport] Failed to save ad spend history:", err);
    return 0;
  }
}
async function saveAdSpendHistory30d(endDate, flipkartListingPriceMap, resolveProducts, listingPriceFor) {
  try {
    const range30 = getDateWindow(endDate, 30);
    const [amz, fk, ms] = await Promise.all([
      fetchAmazonProducts(range30, endDate),
      fetchFlipkartProducts(range30, endDate, flipkartListingPriceMap),
      fetchMeeshoProducts(range30, endDate)
    ]);
    const rows = [];
    [["Amazon", amz.products], ["Flipkart", fk.products], ["Meesho", ms.products]].forEach(([platform, products]) => {
      resolveProducts(products);
      products.forEach((p) => {
        if (spendTax(p.range) <= 0 && p.range.units <= 0) return;
        rows.push({
          report_date: endDate,
          range30_start: range30.start,
          platform,
          sku: p.sku,
          product_name: p.name,
          price: p.price,
          spend: round2(p.range.spend),
          spend_tax: round2(spendTax(p.range)),
          orders: p.range.units,
          cpc: round2(computeCpc(p.range)),
          acos: acosCell(p.range, p.price, listingPriceFor(platform, p.sku))
        });
      });
    });
    if (!rows.length) return 0;
    await upsertInChunks("barm_ad_spend_history_30d", rows, "report_date,platform,sku");
    return rows.length;
  } catch (err) {
    console.error("[adSpendReportExport] Failed to save 30D ad spend history:", err);
    return 0;
  }
}
async function buildAdSpendReportWorkbook(opts) {
  const { endDate, accountName } = opts;
  const aiSuggestions = opts.aiSuggestions !== false;
  const rangeDays = opts.rangeDays && opts.rangeDays > 0 ? opts.rangeDays : 7;
  const range = getDateWindow(endDate, rangeDays);
  const [amazonListingPriceMap, flipkartListingPriceMap] = await Promise.all([
    fetchAmazonListingPriceMap(),
    fetchFlipkartListingPriceMap()
  ]);
  const [master, masterSkuid, masterSkuidCatalog, masterSkuidsByName, productMarketing, amz, fk, ms, socialMedia, googleOrders, googleAdSpend] = await Promise.all([
    fetchProductMasterMap(),
    fetchMasterSkuidMap(),
    fetchMasterSkuidAmazonCatalog(),
    fetchMasterSkuidsByName(),
    fetchProductMarketingMap(),
    fetchAmazonProducts(range, endDate),
    fetchFlipkartProducts(range, endDate, flipkartListingPriceMap),
    fetchMeeshoProducts(range, endDate),
    fetchSocialMediaAdSpend(range, endDate),
    fetchGoogleOrders(range, endDate),
    // Google Ads spend — same windowed table shape and day/range rule as Meta's.
    fetchWindowedAdSpend("barm_daily_google_ad_spend", range, endDate)
  ]);
  const listingPriceOne = (platform, sku) => platform === "Amazon" ? amazonListingPriceMap.get(sku) : platform === "Flipkart" ? flipkartListingPriceMap.get(sku) : void 0;
  const listingPriceFor = (platform, sku) => {
    const direct = listingPriceOne(platform, sku);
    if (direct !== void 0 || !sku.includes(",")) return direct;
    for (const part of sku.split(",")) {
      const p = listingPriceOne(platform, part.trim());
      if (p !== void 0) return p;
    }
    return void 0;
  };
  const { resolveName: resolveBarmName } = buildProductMasterResolver(master);
  const { resolveName: resolveSkuidName, resolveTax: resolveSkuidTax } = buildMasterSkuidResolver(masterSkuid);
  const { resolveName: resolveMarketingName } = buildProductMarketingResolver(productMarketing);
  const resolveName = (sku, fallback) => resolveMarketingName(sku, resolveSkuidName(sku, resolveBarmName(sku, fallback)));
  const skuToMasterSkuidName = new Map([...masterSkuid.entries()].map(([sku, entry]) => [sku, entry.name]));
  const resolveProducts = (products) => {
    products.forEach((p) => {
      p.name = resolveName(p.sku, p.name);
      const gst = gstMultiplierFromTax(resolveSkuidTax(p.sku));
      p.day.gstMultiplier = gst;
      p.range.gstMultiplier = gst;
    });
  };
  [amz.products, fk.products, ms.products].forEach(resolveProducts);
  masterSkuidCatalog.forEach((entry) => {
    if (amz.products.has(entry.sku)) return;
    amz.products.set(entry.sku, {
      platform: "Amazon",
      sku: entry.sku,
      name: resolveName(entry.sku, entry.name),
      price: 0,
      day: { spend: 0, units: 0, gstMultiplier: gstMultiplierFromTax(resolveSkuidTax(entry.sku)) },
      range: { spend: 0, units: 0, gstMultiplier: gstMultiplierFromTax(resolveSkuidTax(entry.sku)) }
    });
  });
  if (!amz.products.size && !fk.products.size && !ms.products.size) {
    throw new Error(
      `No uploaded Amazon, Flipkart or Meesho ad/order data in ${dotDate(range.start)} to ${dotDate(endDate)}. Upload the reports for that period on the Upload pages first.` + (ms.loadErrors.length ? ` Meesho data could not be loaded: ${ms.loadErrors.join("; ")}` : "")
    );
  }
  const platforms = [
    { platform: "Amazon", products: amz.products, overallDay: amz.overallDay, overallRange: amz.overallRange, campaigns: amz.campaigns, revenueRangeBySku: amz.revenueRangeBySku },
    { platform: "Flipkart", products: fk.products, overallDay: fk.overallDay, overallRange: fk.overallRange, campaigns: fk.campaigns, revenueRangeBySku: fk.revenueRangeBySku },
    { platform: "Meesho", products: ms.products, overallDay: ms.overallDay, overallRange: ms.overallRange, campaigns: ms.campaigns, revenueRangeBySku: ms.revenueRangeBySku }
  ];
  const meeshoAdView = (p) => {
    const view = (a) => ({ ...a, units: a.adOrders || 0, revenue: (a.adOrders || 0) * p.price });
    return { ...p, day: view(p.day), range: view(p.range) };
  };
  const adPlatforms = platforms.map((pl) => {
    if (pl.platform !== "Meesho") return pl;
    const products = new Map([...pl.products].map(([sku, p]) => [sku, meeshoAdView(p)]));
    return { ...pl, products, revenueRangeBySku: new Map([...products].map(([sku, p]) => [sku, p.range.revenue || 0])) };
  });
  const incompleteDates = [
    { platform: "Amazon", reportDates: amz.reportDates },
    { platform: "Flipkart", reportDates: fk.reportDates },
    { platform: "Meesho", reportDates: ms.reportDates }
  ].filter(({ reportDates }) => reportDates.size > 0).map(({ platform, reportDates }) => ({ platform, missingDates: missingDates(reportDates, range.start, endDate) })).filter(({ missingDates: missingDates2 }) => missingDates2.length > 0);
  const amazonSpendWarnings = [
    ...amz.unmappedCampaigns.map((c) => `Amazon "${c.campaign_name}": \u20B9${round2(c.spend).toFixed(2)} (\u20B9${round2(c.spend * DEFAULT_GST_MULTIPLIER).toFixed(2)} with tax) of Brand/Display spend on ${c.dates.map(dotDate).join(", ")} has no SKU split and no SKU mapping \u2014 NOT in any product's figures or the Amazon totals. Map the campaign on the Upload page (or split it per SKU in AM ads), then regenerate.`),
    ...amz.campaignsMissingOnEndDate.map((c) => `Amazon "${c.campaign_name}": spent \u20B9${round2(c.lastSpend).toFixed(2)} on ${dotDate(c.lastSpendDate)} but has no row at all for ${dotDate(endDate)} \u2014 if it was still running, that day's spend is missing (not \u20B90). Upload its ${dotDate(endDate)} data (AM ads, or the Sponsored Brands/Display campaign report), then regenerate.`)
  ];
  const [historyRowsSaved] = await Promise.all([
    opts.persistHistory ? saveAdSpendHistory(platforms, endDate, range.start, listingPriceFor) : 0,
    opts.persistHistory || opts.persistHistory30dOnly ? saveAdSpendHistory30d(endDate, flipkartListingPriceMap, resolveProducts, listingPriceFor) : 0
  ]);
  const wb = XLSX4.utils.book_new();
  const dayLabel = dotDate(endDate);
  const rangeLabel = `${dotDate(range.start)} to ${dotDate(endDate)}`;
  const METRIC_NAMES = ["Spend", "Spend(with tax)", "Orders", "CPC", "ACOS"];
  const SUM_COLS = 21;
  const SUMMARY_METRIC_NAMES = ["Spend", "Spend(with tax)", "Total Orders", "Total Sales", "CPC", "ACOS", "Ad Sales"];
  const sumAoa = [
    Array(SUM_COLS).fill(""),
    ["Summary", ...Array(SUM_COLS - 1).fill("")],
    Array(SUM_COLS).fill(""),
    ["Platform", "Ad spend (without tax)", "Ad spend (with tax)", "Worst ACOS product", "", dayLabel, "", "", "", "", "", "", rangeLabel, "", "", "", "", "", "", `Overall sales (${dayLabel})`, ""],
    ["", "", "", "Product", "price", ...SUMMARY_METRIC_NAMES, ...SUMMARY_METRIC_NAMES, "QTS", "Value"]
  ];
  const sumMerges = [
    { s: { r: 1, c: 0 }, e: { r: 1, c: SUM_COLS - 1 } },
    { s: { r: 3, c: 0 }, e: { r: 4, c: 0 } },
    { s: { r: 3, c: 1 }, e: { r: 4, c: 1 } },
    { s: { r: 3, c: 2 }, e: { r: 4, c: 2 } },
    { s: { r: 3, c: 3 }, e: { r: 3, c: 4 } },
    { s: { r: 3, c: 5 }, e: { r: 3, c: 11 } },
    { s: { r: 3, c: 12 }, e: { r: 3, c: 18 } },
    { s: { r: 3, c: 19 }, e: { r: 3, c: 20 } }
  ];
  const sumHeaderRowsStyled = [3, 4];
  const sumExtras = /* @__PURE__ */ new Map([[4, ["Sell price", "Ad orders", "Ad orders"]]]);
  const sumPlainAcos = [];
  const sumLabelCells = [];
  const platformTotals = [];
  const platformSummaries = [];
  const ACTION_ACOS_THRESHOLD = 0.14;
  const actionRows = [];
  const bidCutPct = (acosPct) => acosPct >= 90 ? 50 : acosPct >= 60 ? 35 : 20;
  const actionFor = (acosFrac) => {
    const note = "No matching campaign found in the uploaded ad data to confirm which ad group/keyword to open.";
    if (acosFrac === ACOS_UNDEFINED_SENTINEL) {
      return `Reduce bid urgently \u2014 cut bids ~50% (7-day ACOS unavailable \u2014 real ad spend with no order data to estimate sales from this window). ${note}`;
    }
    const acosPct = Math.round(acosFrac * 100);
    const cut = bidCutPct(acosPct);
    if (acosPct > 50) return `Reduce bid urgently \u2014 cut bids ~${cut}% (7-day ACOS ${acosPct}%). ${note}`;
    if (acosPct > 25) return `Reduce bid ~${cut}% (7-day ACOS ${acosPct}%). ${note}`;
    return `Monitor / review keywords \u2014 trim bids ~${cut}% (7-day ACOS ${acosPct}%). ${note}`;
  };
  const TOP_N = 3;
  adPlatforms.forEach(({ platform, products, overallDay, overallRange }) => {
    const rows = groupProductsByName([...products.values()], void 0, skuToMasterSkuidName).filter((p) => spendTax(p.range) > 0);
    rows.forEach((p) => {
      const rangeAcos = platform === "Meesho" ? computeAcos(p.range, p.price, listingPriceFor(platform, p.sku)) : actionSheetAcos(p.range, p.price);
      if (rangeAcos > ACTION_ACOS_THRESHOLD) {
        actionRows.push({
          platform,
          name: p.name,
          sku: p.sku,
          price: p.price,
          // Spend/Orders here are the 7-day range, matching the ACOS column's window — showing
          // the single reporting day's spend (which can be ₹0 for a SKU with no activity today
          // but real ad spend earlier in the week) produced rows reading "₹0.00 spend, 91% ACOS",
          // which looked wrong even though it wasn't. The Summary sheet nearby still has the
          // single-day figures.
          spend: round2(p.range.spend),
          spendTax: round2(spendTax(p.range)),
          orders: p.range.units,
          acos: pct(rangeAcos),
          action: actionFor(rangeAcos)
        });
      }
    });
    const rangeSpendRaw = rows.reduce((s, p) => s + p.range.spend, 0);
    const daySpendRaw = rows.reduce((s, p) => s + p.day.spend, 0);
    const daySpendTaxTotal = rows.reduce((s, p) => s + spendTax(p.day), 0);
    const rangeSpendTaxTotal = rows.reduce((s, p) => s + spendTax(p.range), 0);
    platformTotals.push({ platform, daySpendTax: daySpendTaxTotal, rangeSpendTax: rangeSpendTaxTotal });
    const shortlist = rows.filter((p) => spendTax(p.range) > ACOS_SHORTLIST_MIN_SPEND).sort((a, b) => acosSortRank(b.day, b.price, listingPriceFor(platform, b.sku)) - acosSortRank(a.day, a.price, listingPriceFor(platform, a.sku))).slice(0, TOP_N);
    const emailProduct = (p) => {
      const listingPrice = listingPriceFor(platform, p.sku);
      const sell = sellPriceCell(p.day);
      return {
        name: p.name,
        price: p.price,
        sellPrice: typeof sell === "number" ? sell : null,
        day: { spend: round2(p.day.spend), spendTax: round2(spendTax(p.day)), orders: p.day.units, cpc: round2(computeCpc(p.day)), acos: acosCell(p.day, p.price, listingPrice), adOrders: p.day.adOrders ?? null },
        range: { spend: round2(p.range.spend), spendTax: round2(spendTax(p.range)), orders: p.range.units, cpc: round2(computeCpc(p.range)), acos: acosCell(p.range, p.price, listingPrice), adOrders: p.range.adOrders ?? null }
      };
    };
    platformSummaries.push({
      platform,
      daySpend: round2(daySpendRaw),
      daySpendTax: round2(daySpendTaxTotal),
      rangeSpend: round2(rangeSpendRaw),
      rangeSpendTax: round2(rangeSpendTaxTotal),
      overallDayUnits: overallDay.units,
      overallDayValue: round2(overallDay.value),
      overallRangeUnits: overallRange.units,
      overallRangeValue: round2(overallRange.value),
      topProducts: shortlist.map(emailProduct),
      allProducts: [...rows].sort((a, b) => acosSortRank(b.day, b.price, listingPriceFor(platform, b.sku)) - acosSortRank(a.day, a.price, listingPriceFor(platform, a.sku))).map(emailProduct)
    });
    const blockStart = sumAoa.length;
    const blockRows = Math.max(shortlist.length, 1);
    sumLabelCells.push({ row: blockStart, platform });
    if (shortlist.length) {
      shortlist.forEach((p, i) => {
        const dayTotalSales = round2(p.day.revenue || 0);
        const rangeTotalSales = round2(p.range.revenue || 0);
        const dayAdSales = platform === "Amazon" ? p.day.adAttributedSales !== void 0 ? round2(p.day.adAttributedSales) : null : platform === "Flipkart" ? round2(p.day.adSales || 0) : round2((p.day.adOrders || 0) * p.price);
        const rangeAdSales = platform === "Amazon" ? p.range.adAttributedSales !== void 0 ? round2(p.range.adAttributedSales) : null : platform === "Flipkart" ? round2(p.range.adSales || 0) : round2((p.range.adOrders || 0) * p.price);
        const listingPrice = listingPriceFor(platform, p.sku);
        const daySummaryAcos = acosCell(p.day, p.price, listingPrice);
        const rangeSummaryAcos = acosCell(p.range, p.price, listingPrice);
        sumExtras.set(sumAoa.length, [sellPriceCell(p.day), adOrdersCell(p.day), adOrdersCell(p.range)]);
        sumAoa.push([
          // "Ad spend (without/with tax)" here is the SINGLE-DAY total, matching
          // the seller's own manual workbook's Summary sheet convention — the
          // 7-day range total is still shown per-product further right, and is
          // preserved separately in platformTotals.rangeSpendTax for the
          // post-generate toast on the Download page.
          i === 0 ? platform : "",
          i === 0 ? round2(daySpendRaw) : "",
          i === 0 ? round2(daySpendTaxTotal) : "",
          p.name,
          priceCell(p.price),
          round2(p.day.spend),
          round2(spendTax(p.day)),
          p.day.units,
          dayTotalSales,
          round2(computeCpc(p.day)),
          daySummaryAcos,
          dayAdSales,
          round2(p.range.spend),
          round2(spendTax(p.range)),
          p.range.units,
          rangeTotalSales,
          round2(computeCpc(p.range)),
          rangeSummaryAcos,
          rangeAdSales,
          // Overall sales QTS/Value is the SINGLE reporting day's total (matches
          // the dayLabel header above), not the 7-day range — the seller's own
          // manual workbook tracks this figure daily, not as a weekly rollup.
          // The range total is still available per-platform in platformTotals /
          // platformSummaries.overallRangeUnits/-Value for the emailed summary.
          i === 0 ? overallDay.units : "",
          i === 0 ? round2(overallDay.value) : ""
        ]);
      });
    } else {
      sumAoa.push([platform, 0, 0, platform === "Meesho" && ms.loadErrors.length ? "\u26A0 Meesho data could not be loaded \u2014 see Notes" : "(no ad spend in range)", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", overallDay.units, round2(overallDay.value)]);
    }
    if (blockRows > 1) {
      [0, 1, 2, 19, 20].forEach((c) => sumMerges.push({ s: { r: blockStart, c }, e: { r: blockStart + blockRows - 1, c } }));
    }
  });
  let socialMediaRow = null;
  const socialHeadRows = [];
  const socialBoldRows = [];
  let socialMediaSummary = null;
  const metaDayVerified = !!googleOrders.shopifyFrom && endDate >= googleOrders.shopifyFrom;
  const metaRangeVerified = !!googleOrders.shopifyFrom && range.start >= googleOrders.shopifyFrom;
  const metaAcos = (verified, spend, adSales) => verified && spend > 0 && adSales > 0 ? Math.round(spend / adSales * 1e4) / 1e4 : null;
  const metaDayAcos = metaAcos(metaDayVerified, socialMedia.daySpend, googleOrders.metaAdDayValue);
  const metaRangeAcos = metaAcos(metaRangeVerified, socialMedia.rangeSpend, googleOrders.metaAdRangeValue);
  const metaDayAdSales = metaDayVerified ? round2(googleOrders.metaAdDayValue) : null;
  const metaRangeAdSales = metaRangeVerified ? round2(googleOrders.metaAdRangeValue) : null;
  const metaDayOrders = metaDayVerified ? googleOrders.metaAdDayOrders : null;
  const metaRangeOrders = metaRangeVerified ? googleOrders.metaAdRangeOrders : null;
  const socialMediaProducts = [];
  if (socialMedia.daySpend > 0 || socialMedia.rangeSpend > 0) {
    const amazonRowsForSocial = groupProductsByName([...amz.products.values()], void 0, skuToMasterSkuidName);
    const byProduct = /* @__PURE__ */ new Map();
    socialMedia.campaigns.forEach((c) => {
      const product = socialMediaProductFor(c.name);
      const hit = byProduct.get(product) ?? { campaigns: [], adNames: [], ads: [], daySpend: 0, rangeSpend: 0 };
      hit.campaigns.push(c.name);
      hit.ads.push(c);
      c.adNames.forEach((a) => {
        if (!hit.adNames.includes(a)) hit.adNames.push(a);
      });
      hit.daySpend += c.daySpend;
      hit.rangeSpend += c.rangeSpend;
      byProduct.set(product, hit);
    });
    byProduct.forEach((v, product) => {
      const amazonRow = amazonRowsForSocial.find((p) => p.name.trim().toLowerCase() === product.toLowerCase());
      socialMediaProducts.push({
        product: amazonRow?.name ?? product,
        campaigns: v.campaigns,
        adNames: v.adNames,
        ads: v.ads,
        price: amazonRow?.price ?? 0,
        dayAgg: { spend: round2(v.daySpend), units: 0 },
        rangeAgg: { spend: round2(v.rangeSpend), units: 0 }
      });
    });
    socialMediaProducts.sort((a, b) => b.rangeAgg.spend - a.rangeAgg.spend || b.dayAgg.spend - a.dayAgg.spend);
    const socialSummaryProducts = socialMedia.daySpend > 0 ? socialMediaProducts.filter((p) => p.dayAgg.spend > 0) : socialMediaProducts;
    const dayTotalAgg = { spend: socialMedia.daySpend, units: 0 };
    const metaSalesFor = (product, start, end) => {
      const key2 = product.trim().toLowerCase();
      let value = 0;
      let orders = 0;
      googleOrders.metaAdOrders.filter((o) => o.order_date >= start && o.order_date <= end).forEach((o) => {
        const lines = o.items.filter((i) => (skuToMasterSkuidName.get(String(i.sku ?? "").trim()) ?? "").trim().toLowerCase() === key2);
        if (!lines.length) return;
        orders += 1;
        value += lines.reduce((s, i) => s + (i.line_total == null || i.line_total === "" ? num3(i.quantity) * num3(i.price) : num3(i.line_total)), 0);
      });
      return { value: round2(value), orders };
    };
    const productMeta = new Map(socialSummaryProducts.map((p) => {
      const d = metaSalesFor(p.product, endDate, endDate);
      const r = metaSalesFor(p.product, range.start, endDate);
      return [p.product, {
        dayOrders: metaDayVerified ? d.orders : null,
        daySales: metaDayVerified ? d.value : null,
        dayAcos: metaAcos(metaDayVerified, p.dayAgg.spend, d.value),
        rangeOrders: metaRangeVerified ? r.orders : null,
        rangeSales: metaRangeVerified ? r.value : null,
        rangeAcos: metaAcos(metaRangeVerified, p.rangeAgg.spend, r.value)
      }];
    }));
    socialMediaRow = sumAoa.length;
    const block = (agg) => ({ spend: round2(agg.spend), spendTax: round2(spendTax(agg)), orders: 0, cpc: 0, acos: null });
    const metaReported = META_AD_SALES_SOURCE === "meta_reported";
    const adBlock = (spend, sales, orders, verified) => ({
      spend: round2(spend),
      spendTax: round2(spendTax({ spend, units: 0 })),
      orders: verified ? orders : null,
      sales: verified && sales != null ? round2(sales) : null,
      // ACOS = Spend (without tax) ÷ Sales; with no sales (0 or not reported) the divisor is 1, so
      // ACOS = Spend ÷ 1 (seller's rule, 26 Nov 2026, confirmed again 27 Nov).
      acos: spend > 0 ? verified && sales != null && sales > 0 ? Math.round(spend / sales * 1e4) / 1e4 : noSalesAcos(spend) : null
    });
    const adLabel = (c) => {
      const i = c.name.indexOf(META_AD_SEPARATOR);
      if (i < 0) return c.adNames.length ? c.adNames.join("; ") : c.name;
      const parts = c.name.slice(i + META_AD_SEPARATOR.length).split(META_AD_SEPARATOR).map((x) => x.trim()).filter(Boolean);
      return [...new Set(parts)].join(META_AD_SEPARATOR);
    };
    const sumOrNull = (xs) => xs.every((x) => x == null) ? null : xs.reduce((s, x) => s + (x ?? 0), 0);
    const products = socialSummaryProducts.map((p) => {
      const m = productMeta.get(p.product);
      const ads = p.ads.slice().sort((a, b) => b.rangeSpend - a.rangeSpend || b.daySpend - a.daySpend).map((c) => ({
        name: adLabel(c),
        day: metaReported ? adBlock(c.daySpend, c.dayMetaValue, c.dayMetaPurchases, c.dayMetaValue != null) : adBlock(c.daySpend, null, null, false),
        range: metaReported ? adBlock(c.rangeSpend, c.rangeMetaValue, c.rangeMetaPurchases, c.rangeMetaValue != null) : adBlock(c.rangeSpend, null, null, false)
      }));
      const total = metaReported ? {
        day: adBlock(p.dayAgg.spend, sumOrNull(ads.map((a) => a.day.sales)), sumOrNull(ads.map((a) => a.day.orders)), ads.some((a) => a.day.sales != null)),
        range: adBlock(p.rangeAgg.spend, sumOrNull(ads.map((a) => a.range.sales)), sumOrNull(ads.map((a) => a.range.orders)), ads.some((a) => a.range.sales != null))
      } : {
        day: adBlock(p.dayAgg.spend, m.daySales, m.dayOrders, m.daySales != null),
        range: adBlock(p.rangeAgg.spend, m.rangeSales, m.rangeOrders, m.rangeSales != null)
      };
      return {
        product: p.product,
        campaigns: p.campaigns,
        price: p.price,
        day: { ...block(p.dayAgg), orders: m.dayOrders ?? 0, acos: m.dayAcos },
        range: { ...block(p.rangeAgg), orders: m.rangeOrders ?? 0, acos: m.rangeAcos },
        adNames: p.adNames,
        daySales: m.daySales,
        rangeSales: m.rangeSales,
        ads,
        total
      };
    });
    const grandBlock = (spend, totals) => adBlock(spend, sumOrNull(totals.map((t) => t.sales)), sumOrNull(totals.map((t) => t.orders)), totals.some((t) => t.sales != null));
    const grandTotal = {
      day: grandBlock(socialMedia.daySpend, products.map((p) => p.total.day)),
      range: grandBlock(socialMedia.rangeSpend, products.map((p) => p.total.range))
    };
    const metaCells = (b) => [b.spend, b.spendTax, b.orders ?? "N/A", b.sales ?? "N/A", "", b.acos ?? "N/A", b.sales ?? "N/A"];
    const blank7 = ["", "", "", "", "", "", ""];
    const metaExtra = (d, r) => [
      d.sales != null && d.sales > 0 && d.orders != null && d.orders > 0 ? round2(d.sales / d.orders) : "\u2013",
      d.orders ?? "N/A",
      r.orders ?? "N/A"
    ];
    const pushSocial = (label, price, day, range2, extra) => {
      if (extra) sumExtras.set(sumAoa.length, extra);
      [[day, 10], [range2, 17]].forEach(([b, c]) => {
        if ((b[3] === "N/A" || b[3] === 0) && typeof b[5] === "number") sumPlainAcos.push({ r: sumAoa.length, c });
      });
      const first = sumAoa.length === socialMediaRow;
      sumAoa.push([
        first ? "Social Media (Meta)" : "",
        first ? round2(socialMedia.daySpend) : "",
        first ? round2(spendTax(dayTotalAgg)) : "",
        label,
        price,
        ...day,
        ...range2,
        "",
        ""
      ]);
    };
    products.forEach((p) => {
      socialHeadRows.push(sumAoa.length);
      pushSocial(`${p.product}${p.price ? ` \xB7 \u20B9${p.price.toLocaleString("en-IN")}` : ""}`, "", blank7, blank7);
      p.ads.forEach((a, i) => pushSocial(`Ad ${i + 1}: ${a.name}`, "", metaCells(a.day), metaCells(a.range), metaExtra(a.day, a.range)));
      socialBoldRows.push(sumAoa.length);
      pushSocial(`Total \u2013 ${p.product}`, p.price || "", metaCells(p.total.day), metaCells(p.total.range), metaExtra(p.total.day, p.total.range));
    });
    socialBoldRows.push(sumAoa.length);
    pushSocial("Grand total \u2013 all Meta products", "", metaCells(grandTotal.day), metaCells(grandTotal.range), metaExtra(grandTotal.day, grandTotal.range));
    if (sumAoa.length - socialMediaRow > 1) {
      [0, 1, 2, 19, 20].forEach((c) => sumMerges.push({ s: { r: socialMediaRow, c }, e: { r: sumAoa.length - 1, c } }));
    }
    socialMediaSummary = {
      daySpend: round2(socialMedia.daySpend),
      daySpendTax: round2(spendTax(dayTotalAgg)),
      product: products[0].product,
      price: products[0].price,
      day: products[0].day,
      range: products[0].range,
      productBreakdown: true,
      adBreakdown: true,
      adSalesSource: META_AD_SALES_SOURCE,
      grandTotal,
      products,
      dayAcos: metaDayAcos,
      rangeAcos: metaRangeAcos,
      dayAdSales: metaDayAdSales,
      rangeAdSales: metaRangeAdSales
    };
  }
  let googleRow = null;
  const googleDetailRows = [];
  const googleMailProducts = [];
  let googleSummary = null;
  const googleDayAgg = { spend: googleAdSpend.daySpend, units: 0 };
  const googleRangeAgg = { spend: googleAdSpend.rangeSpend, units: 0 };
  const hasGoogleSpend = googleAdSpend.daySpend > 0 || googleAdSpend.rangeSpend > 0;
  const googleAttributed = !!googleOrders.shopifyFrom && endDate >= googleOrders.shopifyFrom;
  const googleDayRatios = googleAdsRatios(googleDayAgg.spend, googleOrders.adDayValue);
  const googleRangeRatios = googleAdsRatios(googleRangeAgg.spend, googleOrders.adRangeValue);
  const ratio4 = (v) => v === null ? null : Math.round(v * 1e4) / 1e4;
  if (googleOrders.rangeUnits > 0 || googleOrders.rangeValue > 0 || hasGoogleSpend) {
    googleRow = sumAoa.length;
    const googleExtra = [
      googleOrders.dayUnits > 0 ? round2(googleOrders.dayValue / googleOrders.dayUnits) : "\u2013",
      googleAttributed ? googleOrders.adDayOrders : "",
      googleAttributed ? googleOrders.adRangeOrders : ""
    ];
    const googleTotals = [
      "Google",
      round2(googleDayAgg.spend),
      round2(spendTax(googleDayAgg)),
      hasGoogleSpend ? googleAttributed ? "(Google Ads spend + website orders)" : "(Google Ads spend + B-Arm orders)" : "(Orders/Sales only \u2014 no Google Ads report for this window)",
      "",
      round2(googleDayAgg.spend),
      round2(spendTax(googleDayAgg)),
      googleOrders.dayUnits,
      round2(googleOrders.dayValue),
      "",
      googleAttributed ? ratio4(googleDayRatios.acos) ?? "" : "",
      googleAttributed ? round2(googleOrders.adDayValue) : "",
      round2(googleRangeAgg.spend),
      round2(spendTax(googleRangeAgg)),
      googleOrders.rangeUnits,
      round2(googleOrders.rangeValue),
      "",
      googleAttributed ? ratio4(googleRangeRatios.acos) ?? "" : "",
      googleAttributed ? round2(googleOrders.adRangeValue) : "",
      googleOrders.dayUnits,
      round2(googleOrders.dayValue)
    ];
    if (hasGoogleSpend && googleAttributed && googleAdSpend.campaigns.length) {
      const gProducts = /* @__PURE__ */ new Map();
      const gAcc = (product) => {
        const hit = gProducts.get(product) ?? { campaigns: [], daySales: 0, rangeSales: 0, dayUnits: 0, rangeUnits: 0, dayOrders: /* @__PURE__ */ new Set(), rangeOrders: /* @__PURE__ */ new Set() };
        gProducts.set(product, hit);
        return hit;
      };
      googleAdSpend.campaigns.forEach((c) => gAcc(googleProductFor(c.name)).campaigns.push(c));
      googleOrders.adLines.forEach((l) => {
        const a = gAcc(googleProductFor(l.name));
        a.rangeSales += l.value;
        a.rangeUnits += l.quantity;
        if (l.order) a.rangeOrders.add(l.order);
        if (l.date === endDate) {
          a.daySales += l.value;
          a.dayUnits += l.quantity;
          if (l.order) a.dayOrders.add(l.order);
        }
      });
      const rangeSpendOf = (p) => p.campaigns.reduce((s, c) => s + c.rangeSpend, 0);
      const daySpendOf = (p) => p.campaigns.reduce((s, c) => s + c.daySpend, 0);
      const ordered = [...gProducts.entries()].sort((a, b) => rangeSpendOf(b[1]) - rangeSpendOf(a[1]) || b[1].rangeSales - a[1].rangeSales);
      const blank7G = ["", "", "", "", "", "", ""];
      const spendCells = (spend) => [round2(spend), round2(spendTax({ spend, units: 0 })), "", "", "", "", ""];
      const totalCells = (spend, orders, sales) => [
        round2(spend),
        round2(spendTax({ spend, units: 0 })),
        orders,
        round2(sales),
        "",
        spend > 0 ? sales > 0 ? Math.round(spend / sales * 1e4) / 1e4 : noSalesAcos(spend) : "",
        round2(sales)
      ];
      const pushGoogle = (label, day, range2, extra) => {
        if (extra) sumExtras.set(sumAoa.length, extra);
        [[day, 10], [range2, 17]].forEach(([b, c]) => {
          if (b[3] === 0 && typeof b[5] === "number") sumPlainAcos.push({ r: sumAoa.length, c });
        });
        const first = sumAoa.length === googleRow;
        sumAoa.push([
          first ? "Google" : "",
          first ? googleTotals[1] : "",
          first ? googleTotals[2] : "",
          label,
          "",
          ...day,
          ...range2,
          first ? googleTotals[19] : "",
          first ? googleTotals[20] : ""
        ]);
      };
      ordered.forEach(([product, p]) => {
        socialHeadRows.push(sumAoa.length);
        pushGoogle(product, blank7G, blank7G);
        p.campaigns.slice().sort((a, b) => b.rangeSpend - a.rangeSpend || b.daySpend - a.daySpend).forEach((c, i) => pushGoogle(`Ad ${i + 1}: ${c.name}`, spendCells(c.daySpend), spendCells(c.rangeSpend)));
        socialBoldRows.push(sumAoa.length);
        const productExtra = [p.dayUnits > 0 ? round2(p.daySales / p.dayUnits) : "\u2013", p.dayOrders.size, p.rangeOrders.size];
        pushGoogle(
          `Total \u2013 ${product}`,
          totalCells(daySpendOf(p), p.dayOrders.size, p.daySales),
          totalCells(rangeSpendOf(p), p.rangeOrders.size, p.rangeSales),
          productExtra
        );
        const detailBlock = (spend, orders, sales) => [
          round2(spend),
          round2(spendTax({ spend, units: 0 })),
          orders,
          "",
          spend > 0 ? sales > 0 ? Math.round(spend / sales * 1e4) / 1e4 : noSalesAcos(spend) : ""
        ];
        googleDetailRows.push({
          cells: [
            p.campaigns.map((c) => c.name).join(", ") || "(no Google Ads campaign)",
            product,
            "",
            ...detailBlock(daySpendOf(p), p.dayOrders.size, p.daySales),
            ...detailBlock(rangeSpendOf(p), p.rangeOrders.size, p.rangeSales)
          ],
          extra: productExtra,
          // ACOS columns (original 7 = day, 12 = range) holding Spend ÷ 1: shown as the amount.
          plainAcosCols: [
            ...daySpendOf(p) > 0 && p.daySales <= 0 ? [7] : [],
            ...rangeSpendOf(p) > 0 && p.rangeSales <= 0 ? [12] : []
          ]
        });
        const mailTotal = (spend, orders, sales, units) => ({
          spend: round2(spend),
          spendTax: round2(spendTax({ spend, units: 0 })),
          orders,
          sales: round2(sales),
          acos: spend > 0 ? sales > 0 ? Math.round(spend / sales * 1e4) / 1e4 : noSalesAcos(spend) : null,
          sellPrice: units > 0 && sales > 0 ? round2(sales / units) : null
        });
        googleMailProducts.push({
          product,
          campaigns: p.campaigns.slice().sort((a, b) => b.rangeSpend - a.rangeSpend || b.daySpend - a.daySpend).map((c) => ({
            name: c.name,
            day: { spend: round2(c.daySpend), spendTax: round2(spendTax({ spend: c.daySpend, units: 0 })) },
            range: { spend: round2(c.rangeSpend), spendTax: round2(spendTax({ spend: c.rangeSpend, units: 0 })) }
          })),
          total: {
            day: mailTotal(daySpendOf(p), p.dayOrders.size, p.daySales, p.dayUnits),
            range: mailTotal(rangeSpendOf(p), p.rangeOrders.size, p.rangeSales, p.rangeUnits)
          }
        });
      });
      socialBoldRows.push(sumAoa.length);
      pushGoogle("Grand total \u2013 all Google", googleTotals.slice(5, 12), googleTotals.slice(12, 19), googleExtra);
      if (sumAoa.length - googleRow > 1) {
        [0, 1, 2, 19, 20].forEach((c) => sumMerges.push({ s: { r: googleRow, c }, e: { r: sumAoa.length - 1, c } }));
      }
    } else {
      sumExtras.set(sumAoa.length, googleExtra);
      sumAoa.push(googleTotals);
    }
    googleSummary = {
      totalUnits: googleOrders.dayUnits,
      totalValue: round2(googleOrders.dayValue),
      daySpend: round2(googleDayAgg.spend),
      daySpendTax: round2(spendTax(googleDayAgg)),
      rangeSpend: round2(googleRangeAgg.spend),
      rangeSpendTax: round2(spendTax(googleRangeAgg)),
      attributed: googleAttributed,
      dayAdSales: googleAttributed ? round2(googleOrders.adDayValue) : null,
      rangeAdSales: googleAttributed ? round2(googleOrders.adRangeValue) : null,
      dayAcos: googleAttributed ? ratio4(googleDayRatios.acos) : null,
      rangeAcos: googleAttributed ? ratio4(googleRangeRatios.acos) : null,
      dayRoas: googleAttributed ? ratio4(googleDayRatios.roas) : null,
      rangeRoas: googleAttributed ? ratio4(googleRangeRatios.roas) : null,
      rangeUnits: googleOrders.rangeUnits,
      dayAdOrders: googleAttributed ? googleOrders.adDayOrders : null,
      rangeAdOrders: googleAttributed ? googleOrders.adRangeOrders : null,
      ...googleMailProducts.length ? { products: googleMailProducts } : {}
    };
  }
  let meeshoErrorRow = null;
  if (ms.loadErrors.length) {
    meeshoErrorRow = sumAoa.length + 1;
    sumAoa.push([], [`\u26A0 Meesho data could not be loaded (database/query error, not an empty day) \u2014 Meesho figures above are missing or incomplete: ${ms.loadErrors.join("; ")}`]);
  }
  await enrichAmazonActionRows(actionRows, amz.spRows, endDate, aiSuggestions);
  await enrichFlipkartActionRows(actionRows, fk.fsnRows, aiSuggestions);
  const sumCol = (c) => c + (c >= 5 ? 1 : 0) + (c >= 8 ? 1 : 0) + (c >= 15 ? 1 : 0);
  sumAoa.forEach((row, r) => {
    if (row.length < 15) return;
    const [sell, adDay, adRange] = sumExtras.get(r) ?? ["", "", ""];
    row.splice(15, 0, adRange);
    row.splice(8, 0, adDay);
    row.splice(5, 0, sell);
  });
  sumMerges.forEach((m) => {
    m.s.c = sumCol(m.s.c);
    m.e.c = sumCol(m.e.c);
  });
  const worstHeadMerge = sumMerges.find((m) => m.s.r === 3 && m.s.c === 3);
  if (worstHeadMerge) worstHeadMerge.e.c = 5;
  const SUM_COLS_OUT = sumCol(SUM_COLS - 1) + 1;
  const wsSummary = XLSX4.utils.aoa_to_sheet(sumAoa);
  wsSummary["!merges"] = sumMerges;
  if (wsSummary["A2"]) wsSummary["A2"].s = { font: { bold: true, sz: 13 } };
  sumHeaderRowsStyled.forEach((row) => styleHeader(wsSummary, row, SUM_COLS_OUT, "312E81"));
  sumLabelCells.forEach(({ row, platform }) => styleLabel(wsSummary, XLSX4.utils.encode_cell({ r: row, c: 0 }), PLATFORM_FILL[platform]));
  sumLabelCells.forEach(({ row, platform }) => {
    const addr = XLSX4.utils.encode_cell({ r: row, c: 0 });
    const cell = wsSummary[addr];
    if (!cell) return;
    cell.l = { Target: `${SITE_URL}/dashboard/daily-ad-spend`, Tooltip: `Open ${platform} in the Daily Ad Spend dashboard` };
  });
  if (socialMediaRow !== null) styleLabel(wsSummary, XLSX4.utils.encode_cell({ r: socialMediaRow, c: 0 }), META_FILL);
  if (googleRow !== null) styleLabel(wsSummary, XLSX4.utils.encode_cell({ r: googleRow, c: 0 }), GOOGLE_FILL);
  const meeshoErrorCell = meeshoErrorRow !== null ? wsSummary[XLSX4.utils.encode_cell({ r: meeshoErrorRow, c: 0 })] : void 0;
  if (meeshoErrorCell) meeshoErrorCell.s = { font: { bold: true, color: { rgb: "B91C1C" } } };
  const sumWidths = [
    { wch: 20 },
    { wch: 16 },
    { wch: 16 },
    { wch: 60 },
    { wch: 10 },
    { wch: 13 },
    { wch: 13 },
    { wch: 13 },
    { wch: 24 },
    { wch: 13 },
    { wch: 13 },
    { wch: 13 },
    // day block: Spend, Spend(with tax), Total Orders, Total Sales (wider header), CPC, ACOS, Ad Sales
    { wch: 13 },
    { wch: 13 },
    { wch: 13 },
    { wch: 24 },
    { wch: 13 },
    { wch: 13 },
    { wch: 13 },
    // range block: same shape
    { wch: 10 },
    { wch: 14 }
  ];
  sumWidths.splice(15, 0, { wch: 11 });
  sumWidths.splice(8, 0, { wch: 11 });
  sumWidths.splice(5, 0, { wch: 13 });
  sumWidths[4] = { wch: 13 };
  wsSummary["!cols"] = sumWidths;
  const sumFormats = {
    1: CURRENCY_FMT,
    2: CURRENCY_FMT,
    4: CURRENCY_FMT,
    5: CURRENCY_FMT,
    6: CURRENCY_FMT,
    8: CURRENCY_FMT,
    9: CURRENCY_FMT,
    10: PERCENT_FMT,
    11: CURRENCY_FMT,
    12: CURRENCY_FMT,
    13: CURRENCY_FMT,
    15: CURRENCY_FMT,
    16: CURRENCY_FMT,
    17: PERCENT_FMT,
    18: CURRENCY_FMT,
    20: CURRENCY_FMT
  };
  applyNumberFormats(wsSummary, 5, sumAoa.length, {
    ...Object.fromEntries(Object.entries(sumFormats).map(([c, f]) => [sumCol(Number(c)), f])),
    5: CURRENCY_FMT
    // Sell price
  });
  for (let r = 5; r < sumAoa.length; r++) {
    const addr = XLSX4.utils.encode_cell({ r, c: 3 });
    if (wsSummary[addr]) wsSummary[addr].s = { alignment: { wrapText: true, vertical: "top" } };
  }
  const emphasise = (r, fill) => {
    for (let c = 3; c <= sumCol(18); c++) {
      const addr = XLSX4.utils.encode_cell({ r, c });
      const cell = wsSummary[addr] ?? (wsSummary[addr] = { t: "s", v: "" });
      cell.s = { ...cell.s ?? {}, font: { ...cell.s?.font ?? {}, bold: true }, ...fill ? { fill: { fgColor: { rgb: fill } } } : {} };
    }
  };
  socialHeadRows.forEach((r) => emphasise(r, "EEF2FF"));
  socialBoldRows.forEach((r) => emphasise(r));
  blockDivider(wsSummary, sumCol(12), sumAoa.map((row, r) => r >= 3 && row.length >= SUM_COLS_OUT ? r : -1).filter((r) => r >= 0));
  XLSX4.utils.book_append_sheet(wb, wsSummary, "Summary");
  const DETAIL_COLS = 13;
  const detailAoa = [];
  const detailHeaderRows = [];
  const detailLabelCells = [];
  const detailMerges = [];
  const detailExtras = /* @__PURE__ */ new Map();
  const detailPlainAcos = [];
  adPlatforms.forEach(({ platform, products }) => {
    const rows = groupProductsByName([...products.values()], masterSkuidsByName, skuToMasterSkuidName).filter((p) => spendTax(p.range) > 0).sort((a, b) => acosSortRank(b.day, b.price, listingPriceFor(platform, b.sku)) - acosSortRank(a.day, a.price, listingPriceFor(platform, a.sku)));
    detailLabelCells.push({ addr: XLSX4.utils.encode_cell({ r: detailAoa.length, c: 0 }), platform });
    detailAoa.push([platform, ...Array(DETAIL_COLS - 1).fill("")]);
    detailAoa.push(Array(DETAIL_COLS).fill(""));
    const groupRow = detailAoa.length;
    detailHeaderRows.push(groupRow);
    detailAoa.push(["SKU(s)", "Product Name", "Price", dayLabel, "", "", "", "", rangeLabel, "", "", "", ""]);
    detailAoa.push(["", "", "", ...METRIC_NAMES, ...METRIC_NAMES]);
    detailMerges.push(
      { s: { r: groupRow, c: 0 }, e: { r: groupRow + 1, c: 0 } },
      { s: { r: groupRow, c: 1 }, e: { r: groupRow + 1, c: 1 } },
      { s: { r: groupRow, c: 2 }, e: { r: groupRow + 1, c: 2 } },
      { s: { r: groupRow, c: 3 }, e: { r: groupRow, c: 7 } },
      { s: { r: groupRow, c: 8 }, e: { r: groupRow, c: 12 } }
    );
    detailExtras.set(groupRow, ["Sell price", "", ""]);
    detailExtras.set(groupRow + 1, ["", "Ad orders", "Ad orders"]);
    rows.forEach((p) => {
      detailExtras.set(detailAoa.length, [sellPriceCell(p.day), adOrdersCell(p.day), adOrdersCell(p.range)]);
      detailAoa.push([p.sku, ...productAoaRow(p, listingPriceFor(platform, p.sku))]);
    });
    if (!rows.length) detailAoa.push(["(no advertised products with activity in range)", ...Array(DETAIL_COLS - 1).fill("")]);
    detailAoa.push([]);
  });
  let socialDetailLabelRow = null;
  if (socialMediaProducts.length) {
    socialDetailLabelRow = detailAoa.length;
    detailAoa.push(["Social Media (Meta)", ...Array(DETAIL_COLS - 1).fill("")]);
    detailAoa.push(Array(DETAIL_COLS).fill(""));
    const groupRow = detailAoa.length;
    detailHeaderRows.push(groupRow);
    detailAoa.push(["Campaign(s)", "Product Name", "Price", dayLabel, "", "", "", "", rangeLabel, "", "", "", ""]);
    detailAoa.push(["", "", "", ...METRIC_NAMES, ...METRIC_NAMES]);
    detailMerges.push(
      { s: { r: groupRow, c: 0 }, e: { r: groupRow + 1, c: 0 } },
      { s: { r: groupRow, c: 1 }, e: { r: groupRow + 1, c: 1 } },
      { s: { r: groupRow, c: 2 }, e: { r: groupRow + 1, c: 2 } },
      { s: { r: groupRow, c: 3 }, e: { r: groupRow, c: 7 } },
      { s: { r: groupRow, c: 8 }, e: { r: groupRow, c: 12 } }
    );
    detailExtras.set(groupRow, ["Sell price", "", ""]);
    detailExtras.set(groupRow + 1, ["", "Ad orders", "Ad orders"]);
    const firstProductRow = detailAoa.length;
    socialMediaProducts.forEach((_p, i) => detailExtras.set(firstProductRow + i, ["\u2013", i === 0 ? metaDayOrders ?? "N/A" : "", i === 0 ? metaRangeOrders ?? "N/A" : ""]));
    socialMediaProducts.forEach((p, i) => detailAoa.push([
      p.campaigns.join(", "),
      p.product,
      p.price || "",
      round2(p.dayAgg.spend),
      round2(spendTax(p.dayAgg)),
      i === 0 ? metaDayOrders ?? "N/A" : "",
      "",
      i === 0 ? metaDayAcos ?? "N/A" : "",
      round2(p.rangeAgg.spend),
      round2(spendTax(p.rangeAgg)),
      i === 0 ? metaRangeOrders ?? "N/A" : "",
      "",
      i === 0 ? metaRangeAcos ?? "N/A" : ""
    ]));
    if (socialMediaProducts.length > 1) {
      [5, 7, 10, 12].forEach((c) => detailMerges.push({ s: { r: firstProductRow, c }, e: { r: firstProductRow + socialMediaProducts.length - 1, c } }));
    }
    detailAoa.push([]);
  }
  let googleDetailLabelRow = null;
  let googleDetailHeaderRow = null;
  if (googleDetailRows.length) {
    googleDetailLabelRow = detailAoa.length;
    detailAoa.push(["Google", ...Array(DETAIL_COLS - 1).fill("")]);
    detailAoa.push(Array(DETAIL_COLS).fill(""));
    const groupRow = detailAoa.length;
    detailHeaderRows.push(groupRow);
    detailAoa.push(["Campaign(s)", "Product Name", "Price", dayLabel, "", "", "", "", rangeLabel, "", "", "", ""]);
    detailAoa.push(["", "", "", ...METRIC_NAMES, ...METRIC_NAMES]);
    detailMerges.push(
      { s: { r: groupRow, c: 0 }, e: { r: groupRow + 1, c: 0 } },
      { s: { r: groupRow, c: 1 }, e: { r: groupRow + 1, c: 1 } },
      { s: { r: groupRow, c: 2 }, e: { r: groupRow + 1, c: 2 } },
      { s: { r: groupRow, c: 3 }, e: { r: groupRow, c: 7 } },
      { s: { r: groupRow, c: 8 }, e: { r: groupRow, c: 12 } }
    );
    detailExtras.set(groupRow, ["Sell price", "", ""]);
    detailExtras.set(groupRow + 1, ["", "Ad orders", "Ad orders"]);
    googleDetailRows.forEach((g) => {
      detailExtras.set(detailAoa.length, g.extra);
      g.plainAcosCols.forEach((c) => detailPlainAcos.push({ r: detailAoa.length, c }));
      detailAoa.push(g.cells);
    });
    detailAoa.push([]);
  }
  if (googleOrders.perProduct.length) {
    if (googleDetailLabelRow === null) {
      googleDetailLabelRow = detailAoa.length;
      detailAoa.push(["Google"]);
    } else {
      detailAoa.push([`All website orders, ${rangeLabel}`]);
    }
    googleDetailHeaderRow = detailAoa.length;
    detailAoa.push(["Product", "Quantity", "Price", "Sales"]);
    googleOrders.perProduct.forEach((p) => detailAoa.push([p.name, p.quantity, round2(p.price), round2(p.quantity * p.price)]));
    detailAoa.push([]);
  }
  const detCol = (c) => c + (c >= 3 ? 1 : 0) + (c >= 6 ? 1 : 0) + (c >= 11 ? 1 : 0);
  detailAoa.forEach((row, r) => {
    if (row.length < DETAIL_COLS) return;
    const [sell, adDay, adRange] = detailExtras.get(r) ?? ["", "", ""];
    row.splice(11, 0, adRange);
    row.splice(6, 0, adDay);
    row.splice(3, 0, sell);
  });
  detailMerges.forEach((m) => {
    m.s.c = detCol(m.s.c);
    m.e.c = detCol(m.e.c);
  });
  detailHeaderRows.forEach((row) => detailMerges.push({ s: { r: row, c: 3 }, e: { r: row + 1, c: 3 } }));
  const DETAIL_COLS_OUT = detCol(DETAIL_COLS - 1) + 1;
  const wsDetail = XLSX4.utils.aoa_to_sheet(detailAoa);
  wsDetail["!merges"] = detailMerges;
  detailLabelCells.forEach(({ addr, platform }) => styleLabel(wsDetail, addr, PLATFORM_FILL[platform]));
  detailHeaderRows.forEach((row) => {
    styleHeader(wsDetail, row, DETAIL_COLS_OUT, "312E81");
    styleHeader(wsDetail, row + 1, DETAIL_COLS_OUT, "312E81");
  });
  if (socialDetailLabelRow !== null) styleLabel(wsDetail, XLSX4.utils.encode_cell({ r: socialDetailLabelRow, c: 0 }), META_FILL);
  if (googleDetailLabelRow !== null) styleLabel(wsDetail, XLSX4.utils.encode_cell({ r: googleDetailLabelRow, c: 0 }), GOOGLE_FILL);
  if (googleDetailHeaderRow !== null) styleHeader(wsDetail, googleDetailHeaderRow, 4, "312E81");
  wsDetail["!cols"] = [{ wch: 30 }, { wch: 60 }, { wch: 13 }, { wch: 13 }, ...Array.from({ length: DETAIL_COLS_OUT - 4 }, () => ({ wch: 13 }))];
  const detailFormats = {
    2: CURRENCY_FMT,
    3: CURRENCY_FMT,
    4: CURRENCY_FMT,
    6: CURRENCY_FMT,
    7: PERCENT_FMT,
    8: CURRENCY_FMT,
    9: CURRENCY_FMT,
    11: CURRENCY_FMT,
    12: PERCENT_FMT
  };
  applyNumberFormats(wsDetail, 0, detailAoa.length, {
    ...Object.fromEntries(Object.entries(detailFormats).map(([c, f]) => [detCol(Number(c)), f])),
    3: CURRENCY_FMT
    // Sell price
  });
  for (let r = 0; r < detailAoa.length; r++) {
    [0, 1].forEach((c) => {
      const addr = XLSX4.utils.encode_cell({ r, c });
      if (wsDetail[addr] && wsDetail[addr].v) wsDetail[addr].s = { ...wsDetail[addr].s, alignment: { wrapText: true, vertical: "top" } };
    });
  }
  blockDivider(wsDetail, detCol(8), detailAoa.map((row, r) => row.length >= DETAIL_COLS_OUT ? r : -1).filter((r) => r >= 0));
  XLSX4.utils.book_append_sheet(wb, wsDetail, "Ad spend report");
  const SKU_WISE_METRIC_NAMES = ["Spend (without tax)", "Spend (with tax)", "Orders", "Total Sales", "CPC", "ACOS", "Total Ad Sales", "Total Ad Orders"];
  const SKU_WISE_COLS = 3 + SKU_WISE_METRIC_NAMES.length * 2;
  const skuWiseRows = [];
  adPlatforms.forEach(({ platform, products, revenueRangeBySku }) => {
    [...products.values()].filter((p) => spendTax(p.range) > 0).forEach((p) => {
      const dayTotalSales = p.day.revenue || 0;
      const rangeTotalSales = revenueRangeBySku.get(p.sku) || 0;
      const dayAdSales = platform === "Amazon" ? p.day.adAttributedSales !== void 0 ? round2(p.day.adAttributedSales) : null : platform === "Flipkart" ? round2(p.day.adSales || 0) : round2((p.day.adOrders || 0) * p.price);
      const rangeAdSales = platform === "Amazon" ? p.range.adAttributedSales !== void 0 ? round2(p.range.adAttributedSales) : null : platform === "Flipkart" ? round2(p.range.adSales || 0) : round2((p.range.adOrders || 0) * p.price);
      const dayAdOrders = platform === "Amazon" ? p.day.adOrders !== void 0 ? p.day.adOrders : null : p.day.adOrders || 0;
      const rangeAdOrders = platform === "Amazon" ? p.range.adOrders !== void 0 ? p.range.adOrders : null : p.range.adOrders || 0;
      const listingPrice = listingPriceFor(platform, p.sku);
      skuWiseRows.push([
        p.sku,
        platform,
        priceCell(p.price),
        round2(p.day.spend),
        round2(spendTax(p.day)),
        p.day.units,
        round2(dayTotalSales),
        round2(computeCpc(p.day)),
        acosCell(p.day, p.price, listingPrice),
        dayAdSales,
        dayAdOrders,
        round2(p.range.spend),
        round2(spendTax(p.range)),
        p.range.units,
        round2(rangeTotalSales),
        round2(computeCpc(p.range)),
        acosCell(p.range, p.price, listingPrice),
        rangeAdSales,
        rangeAdOrders
      ]);
    });
  });
  const SKU_WISE_RANGE_TOTAL_SALES_COL = 3 + SKU_WISE_METRIC_NAMES.length + SKU_WISE_METRIC_NAMES.indexOf("Total Sales");
  skuWiseRows.sort((a, b) => Number(b[SKU_WISE_RANGE_TOTAL_SALES_COL]) - Number(a[SKU_WISE_RANGE_TOTAL_SALES_COL]));
  const skuWiseAoa = [
    ["", "", "", dayLabel, "", "", "", "", "", "", "", rangeLabel, "", "", "", "", "", "", ""],
    ["SKU ID", "Platform", "Price", ...SKU_WISE_METRIC_NAMES, ...SKU_WISE_METRIC_NAMES],
    ...skuWiseRows
  ];
  const wsSkuWise = XLSX4.utils.aoa_to_sheet(skuWiseAoa);
  wsSkuWise["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },
    { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
    { s: { r: 0, c: 3 }, e: { r: 0, c: 2 + SKU_WISE_METRIC_NAMES.length } },
    { s: { r: 0, c: 3 + SKU_WISE_METRIC_NAMES.length }, e: { r: 0, c: 2 + SKU_WISE_METRIC_NAMES.length * 2 } }
  ];
  styleHeader(wsSkuWise, 0, SKU_WISE_COLS, "312E81");
  styleHeader(wsSkuWise, 1, SKU_WISE_COLS, "312E81");
  wsSkuWise["!views"] = [{ state: "frozen", ySplit: 2 }];
  wsSkuWise["!cols"] = [
    { wch: 24 },
    { wch: 10 },
    { wch: 10 },
    ...Array.from({ length: SKU_WISE_METRIC_NAMES.length * 2 }, () => ({ wch: 14 }))
  ];
  const dayBlockStart = 3;
  const rangeBlockStart = 3 + SKU_WISE_METRIC_NAMES.length;
  applyNumberFormats(wsSkuWise, 2, skuWiseAoa.length, {
    2: CURRENCY_FMT,
    [dayBlockStart]: CURRENCY_FMT,
    [dayBlockStart + 1]: CURRENCY_FMT,
    [dayBlockStart + 3]: CURRENCY_FMT,
    [dayBlockStart + 4]: CURRENCY_FMT,
    [dayBlockStart + 5]: PERCENT_FMT,
    [dayBlockStart + 6]: CURRENCY_FMT,
    [rangeBlockStart]: CURRENCY_FMT,
    [rangeBlockStart + 1]: CURRENCY_FMT,
    [rangeBlockStart + 3]: CURRENCY_FMT,
    [rangeBlockStart + 4]: CURRENCY_FMT,
    [rangeBlockStart + 5]: PERCENT_FMT,
    [rangeBlockStart + 6]: CURRENCY_FMT
  });
  if (!skuWiseRows.length) XLSX4.utils.sheet_add_aoa(wsSkuWise, [["(no advertised SKUs with activity in range)"]], { origin: { r: 2, c: 0 } });
  XLSX4.utils.book_append_sheet(wb, wsSkuWise, "SKU Wise Report");
  const statusKey = (name) => name.trim().toLowerCase();
  const statusNames = /* @__PURE__ */ new Map();
  const statusHasSpend = { Amazon: /* @__PURE__ */ new Set(), Flipkart: /* @__PURE__ */ new Set(), Meesho: /* @__PURE__ */ new Set() };
  platforms.forEach(({ platform, products }) => {
    products.forEach((p) => {
      const key2 = statusKey(p.name);
      if (!statusNames.has(key2)) statusNames.set(key2, p.name);
      if (adStatusHasSpend(p.range)) statusHasSpend[platform].add(key2);
    });
  });
  const statusAoa = [["Product", "Amazon", "Flipkart", "Meesho"]];
  const liveCount = (key2) => (statusHasSpend.Amazon.has(key2) ? 1 : 0) + (statusHasSpend.Flipkart.has(key2) ? 1 : 0) + (statusHasSpend.Meesho.has(key2) ? 1 : 0);
  [...statusNames.entries()].sort((a, b) => liveCount(b[0]) - liveCount(a[0]) || a[1].localeCompare(b[1])).forEach(([key2, name]) => {
    statusAoa.push([name, statusHasSpend.Amazon.has(key2) ? 1 : 0, statusHasSpend.Flipkart.has(key2) ? 1 : 0, statusHasSpend.Meesho.has(key2) ? 1 : 0]);
  });
  const wsStatus = XLSX4.utils.aoa_to_sheet(statusAoa);
  styleHeader(wsStatus, 0, 4, "312E81");
  wsStatus["!cols"] = [{ wch: 60 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
  wsStatus["!views"] = [{ state: "frozen", ySplit: 1 }];
  XLSX4.utils.book_append_sheet(wb, wsStatus, "Ad Status Report");
  const actionAoa = [
    ["Platform", "Campaign Name", "SKU ID", "Price", `Spend (${dotDate(range.start)} to ${dotDate(endDate)})`, `Spend with tax (${dotDate(range.start)} to ${dotDate(endDate)})`, "Orders", `ACOS (${dotDate(range.start)} to ${dotDate(endDate)})`, "Recommended Action"]
  ];
  [...actionRows].sort((a, b) => b.acos - a.acos).forEach((r) => actionAoa.push([
    r.platform,
    r.campaign || "-",
    r.sku,
    r.price,
    r.spend,
    r.spendTax,
    r.orders,
    // The residual sentinel (see actionSheetAcos) blanks here instead of rendering as a literal
    // "999%" — same convention acosCell uses everywhere else in this workbook.
    r.acos === pct(ACOS_UNDEFINED_SENTINEL) ? "" : r.acos,
    r.action
  ]));
  if (!actionRows.length) actionAoa.push(["(no products over the 14% 7-day ACOS threshold)", "", "", "", "", "", "", "", ""]);
  const wsAction = XLSX4.utils.aoa_to_sheet(actionAoa);
  styleHeader(wsAction, 0, 9, "B91C1C");
  wsAction["!cols"] = [{ wch: 12 }, { wch: 34 }, { wch: 20 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 16 }, { wch: 32 }];
  wsAction["!views"] = [{ state: "frozen", ySplit: 1 }];
  applyNumberFormats(wsAction, 1, actionAoa.length, { 3: CURRENCY_FMT, 4: CURRENCY_FMT, 5: CURRENCY_FMT, 7: PERCENT_FMT });
  XLSX4.utils.book_append_sheet(wb, wsAction, "Action Sheet");
  const lowSpend = [...amz.campaigns, ...fk.campaigns, ...ms.campaigns].filter((c) => c.spend <= LOW_SPEND_THRESHOLD).sort((a, b) => a.spend - b.spend);
  const lowAoa = [["Platform", "Campaign Name", `Spend (${dotDate(endDate)})`]];
  lowSpend.forEach((c) => lowAoa.push([c.platform, c.campaign, round2(c.spend)]));
  if (!lowSpend.length) lowAoa.push(["(no campaigns at or under the threshold)", "", ""]);
  const wsLow = XLSX4.utils.aoa_to_sheet(lowAoa);
  styleHeader(wsLow, 0, 3, "6B7280");
  wsLow["!cols"] = [{ wch: 12 }, { wch: 50 }, { wch: 16 }];
  wsLow["!views"] = [{ state: "frozen", ySplit: 1 }];
  applyNumberFormats(wsLow, 1, lowAoa.length, { 2: CURRENCY_FMT });
  XLSX4.utils.book_append_sheet(wb, wsLow, "Low Spend Campaigns");
  rawRowsToSheet(wb, "Amazon Spend", amz.spRowsRaw);
  rawRowsToSheet(wb, "Amazon orders", amz.orderRows);
  rawRowsToSheet(wb, "Flipkart Spend", fk.fsnRows);
  rawRowsToSheet(wb, "Flipkart Orders", fk.orderRows);
  const meeshoEmptyText = (table) => {
    const err = ms.loadErrors.find((e) => e.startsWith(`${table}:`));
    return err ? `\u26A0 Could not load Meesho data \u2014 ${err}. This is a database/query error, not an empty day: regenerate the report once it's fixed.` : void 0;
  };
  rawRowsToSheet(wb, "Meesho (B Arm) Spend", ms.adsRows, void 0, meeshoEmptyText("barm_daily_ms_barm_ads"));
  const meeshoLeaderboardRows = groupProductsByName([...ms.products.values()], void 0, skuToMasterSkuidName).filter((p) => p.range.units > 0).sort((a, b) => b.range.units * b.price - a.range.units * a.price).map((p) => [p.name, p.range.units, p.price, round2(p.price * p.range.units)]);
  rawRowsToSheet(wb, "Meesho (B Arm) orders", ms.orderRows, {
    header: ["Product", "Quantity", "Price", "Sales"],
    rows: meeshoLeaderboardRows,
    currencyCols: [2, 3]
  }, meeshoEmptyText("barm_daily_ms_barm_orders"));
  const bArmAoa = [["Product", "Date", "Quantity", "Price", "Sales"]];
  googleOrders.dailyPerProduct.filter((p) => p.quantity > 0).forEach((p) => bArmAoa.push([p.name, dotDate(p.date), p.quantity, round2(p.price), round2(p.quantity * p.price)]));
  const wsBArm = XLSX4.utils.aoa_to_sheet(bArmAoa);
  styleHeader(wsBArm, 0, 5, "6B7280");
  wsBArm["!cols"] = [{ wch: 60 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
  wsBArm["!views"] = [{ state: "frozen", ySplit: 1 }];
  applyNumberFormats(wsBArm, 1, bArmAoa.length, { 3: CURRENCY_FMT, 4: CURRENCY_FMT });
  XLSX4.utils.book_append_sheet(wb, wsBArm, "B Arm orders");
  const wsNotes = XLSX4.utils.aoa_to_sheet([
    ["Ad Spend Report \u2014 methodology"],
    [""],
    [`Generated for ${accountName || "this account"} \xB7 reporting day ${dotDate(endDate)} \xB7 range ${dotDate(range.start)} to ${dotDate(endDate)} (${rangeDays} days)`],
    [""],
    ...amazonSpendWarnings.length ? [
      [
        `\u26A0 AMAZON BRAND/DISPLAY SPEND NOT IN THE FIGURES BELOW \u2014 unmapped: \u20B9${round2(amz.unmappedSpend).toFixed(2)} over the range (\u20B9${round2(amz.unmappedSpendDay).toFixed(2)} on ${dotDate(endDate)}), before tax. Every product row and the Amazon totals are understated by this much until it's fixed and the report is regenerated:`
      ],
      ...amazonSpendWarnings.map((w) => [`  ${w}`]),
      [""]
    ] : [],
    ...incompleteDates.length ? [
      [
        "\u26A0 INCOMPLETE DATA \u2014 every platform's own ad-spend export lags about a day (today's spend isn't downloadable until tomorrow). The figures below are understated until the missing day(s) are re-uploaded and this report is regenerated:"
      ],
      ...incompleteDates.map(({ platform, missingDates: md }) => [`  ${platform}: no ad-spend rows for ${md.map(dotDate).join(", ")}`]),
      [""]
    ] : [],
    ...ms.loadErrors.length ? [
      ["\u26A0 MEESHO DATA COULD NOT BE LOADED \u2014 a database/query error, not an empty day. Every Meesho figure in this report is missing or understated until it's fixed and the report is regenerated:"],
      ...ms.loadErrors.map((e) => [`  ${e}`]),
      [""]
    ] : [],
    ["Spend (with tax) = raw ad spend x 1.18 (a flat 18% GST for every product), applied once after summing \u2014 never a per-row multiply."],
    ["CPC = Spend(with tax) / Orders. When Orders = 0, CPC = Spend(with tax) (undefined ratio, shown as the spend itself rather than blank)."],
    [`ACOS (23 Sep 2026 rule \u2014 every ACOS column on the Summary, Ad spend report and SKU Wise sheets, and the email; the Action Sheet keeps its own ranking ACOS): Spend (without tax) / the SKU's own ad-attributed sales \u2014 Amazon: raw Sponsored Products Spend / "7 Day Total Sales" (no GST); Flipkart: its ads-export Total Revenue; Meesho: its ad-attributed order count x price \u2014 ONLY when the window has real Orders > 0 AND ad-attributed sales > 0. In every other case ACOS = CPC / Price, where CPC = Spend (with tax) / Orders (Spend (with tax) when Orders = 0) and Price is the listing price on file (barm_amazon_price_listing / barm_flipkart_listings / meesho_price_marketing), else the report price. ACOS is blank only for a row with spend but no price on file anywhere.`],
    ['"Orders" = units sold of that product in the window, from the Orders/Order report, cancelled orders excluded. This is NOT ad-click-attributed units.'],
    [`Meesho ad metrics count ad orders only \u2014 Summary, Ad spend report, SKU Wise Report, Action Sheet and the daily email: Orders = "Orders by ad" from Meesho's own Ads report (matches the Meesho (B Arm) Spend sheet 1:1 for the same SKU and date), Total Sales = Ad Sales (Ad Orders x Price), CPC = Spend (with tax) / Ad Orders, ACOS = Spend / Ad Sales, or CPC / Price when there are no ad orders. Overall sales QTS/Value and the Meesho (B Arm) orders leaderboard still count every Meesho order. The orders sheet's "Order source = Ad order" tag is NOT used \u2014 Meesho's two exports don't always agree on it. Amazon/Flipkart are unaffected.`],
    ['"Day" = the single reporting day above. "Range" = that day and the', rangeDays - 1, "days before it, inclusive."],
    [""],
    [`Amazon: spend is a plain sum of your daily "Last 7 days" upload's AM-ads sheet (its copy in barm_daily_am_ads \u2014 this is the only report that uses that upload; every other report reads the Upload-page cards), which also carries your per-SKU split of Sponsored Brands/Display spend (each campaign-day's first split row is named, the rest have a blank campaign) \u2014 that split is how Brand/Display spend reaches each product here. An SB/SD campaign-day with no such split is spread over the SKUs mapped to it on the Upload page; SB/SD spend with neither a split nor a mapping for the range window: \u20B9` + round2(amz.unmappedSpend) + (amz.unmappedSpend > 0 ? " \u2014 not attributed to any product below (see the \u26A0 warning at the top)." : " \u2014 every SB/SD campaign row on file is split or mapped.") + " Unsplit SB/SD rows in AM ads (no Advertised SKU) are counted here per campaign, never dropped; where the SB/SD campaign report card also has that campaign-day, the card's figure is used." + (amz.campaignsMissingOnEndDate.length ? " Some Brand/Display campaigns have no row on the reporting day \u2014 see the \u26A0 warning at the top." : "")],
    ["Flipkart: FSN report spend is per-SKU for every campaign type, so no apportioning is needed. Price comes from the SKU's own FK Orders Invoice Amount for the window (summed Invoice Amount / summed quantity, non-cancelled rows); only a SKU with no real order in the window falls back to the Listings snapshot (then the Earn more report's realised price)."],
    ["Meesho: Ads report spend is per-SKU. Overall sales Value / Total Sales = Quantity x each order row's own Supplier Listed Price (Incl. GST + Commission), from the Orders report only. meesho_price_marketing (the live scraped listing price) is used only for the displayed Price and as the Price in the ACOS CPC / Price fallback. Column names come from the seller's own workbook, not a native Meesho export seen directly \u2014 see src/lib/meeshoReportUpload.ts if a real export's headers turn out to differ."],
    [`Social-media (Meta) spend appears as its own Summary-sheet block when uploaded, separate from the three marketplace platforms: one row per promoted product (Meta campaigns are matched to products by campaign name), with each campaign listed in the Ad spend report sheet's Social Media section. Google Ads spend (the Google Ads "Campaign report" uploaded on the Upload page's Google card) fills the Google row's Ad spend columns: the day block from that day's own export, the range block from an export covering exactly the range, else the daily exports inside it. \u20B90 there means no Google Ads report is on file for that window, not \u20B90 spent. Social Media Orders / Total Sales / Ad Sales / ACOS are the Meta channel's own (first row, merged): Orders, Total Sales and Ad Sales = only the Shopify orders whose visit came from a Meta ad click (fbclid on the landing URL), cancelled orders excluded; ACOS = Meta Spend (without tax) / Ad Sales. N/A when it can't be verified \u2014 Shopify orders not on file for the whole window, no Meta spend, or no attributed sales. CPC stays blank.` + (googleAttributed ? ` The Google row's Orders/Sales are the website orders: the Google card's B-Arm orders plus the Shopify orders received by webhook, cancelled and test orders excluded. From the first day Shopify orders are on file, Google card rows from a Shopify "Total sales by product" export, and B-Arm lines that are the same sale as a Shopify order (same date, unit price and quantity), are left out so nothing is counted twice; no row is deleted. Google Ads Ad Sales = only the Shopify orders whose visit came from a Google Ads click (gclid / gbraid / wbraid / gad_* on the landing URL) \u2014 Google Ads' own export reports 0 conversions. ACOS = Spend (without tax) / Ad Sales, blank when there are no Ad Sales or no Google Ads report; ROAS = Ad Sales / Spend (without tax). CPC stays blank.` : " The Google row's Orders/Sales are the B-Arm orders; its CPC/ACOS stay blank since those orders are not attributed to the ads.")],
    ...googleAttributed ? [[
      `Google, this report: ROAS ${googleDayRatios.roas === null ? "\u2014" : googleDayRatios.roas.toFixed(2)} on ${dotDate(endDate)} (Ad Sales \u20B9${round2(googleOrders.adDayValue).toFixed(2)}, ${googleOrders.adDayOrders} order(s)), ${googleRangeRatios.roas === null ? "\u2014" : googleRangeRatios.roas.toFixed(2)} over the range (Ad Sales \u20B9${round2(googleOrders.adRangeValue).toFixed(2)}, ${googleOrders.adRangeOrders} order(s)).` + (googleOrders.dropped.length ? ` Left out as Shopify duplicates: ${googleOrders.dropped.map((d) => `${d.invoice} (\u20B9${round2(d.value).toFixed(2)}${d.matchedOrder ? ` = ${d.matchedOrder}` : ""})`).join("; ")}.` : "")
    ]] : [],
    ...googleOrders.shopifyLoadError ? [[`\u26A0 SHOPIFY ORDERS COULD NOT BE LOADED (${googleOrders.shopifyLoadError}) \u2014 the Google row uses the Google card rows alone, so Shopify orders are missing and Ad Sales/ACOS/ROAS read as 0 until it's fixed and the report is regenerated.`]] : [],
    [""],
    ["Ad Status Report matches products across Amazon, Flipkart and Meesho by product NAME only (no cross-platform SKU mapping exists) \u2014 two listings with different titles for the same physical product will show as separate rows."],
    ["Action Sheet lists every SKU whose trailing 7-day ACOS is above 14%, worst first (identified by Campaign Name + SKU ID, not product name; Spend/Spend with tax/Orders/ACOS are all the 7-day range here, unlike every other sheet's single-day figures). Every row carries a concrete bid-cut %: rows matched to a real campaign in the uploaded Amazon/Flipkart ad data get one sized to that campaign's own ad-group/SKU performance (AI-assisted); unmatched rows (e.g. Meesho, which has no campaign data in this app, or a SKU that matched no campaign) get one computed from the SKU's own 7-day ACOS instead (20%/35%/50% cut for 14-60%/60-90%/90%+ ACOS). No specific search-term/keyword name is ever invented \u2014 that data isn't captured anywhere in this app; only a live SellerMate pull (Amazon only, on request) has real keyword-level detail."],
    [`Low Spend Campaigns lists every campaign spending \u20B9${LOW_SPEND_THRESHOLD} or less on the single reporting day above, across all platforms, ascending by spend.`],
    [""],
    [opts.persistHistory ? `Every product with activity in the range window above was also upserted into the barm_ad_spend_history table (Spend/Orders/CPC/ACOS, day and range) \u2014 a running history independent of this file, keyed on (report_date, platform, sku). Rows saved this run: ${historyRowsSaved}.` : "Preview build \u2014 nothing was saved to the barm_ad_spend_history table."]
  ]);
  wsNotes["!cols"] = [{ wch: 110 }];
  if (wsNotes["A1"]) wsNotes["A1"].s = { font: { bold: true, sz: 13 } };
  XLSX4.utils.book_append_sheet(wb, wsNotes, "Notes");
  const filename = `Ad_Spend_Report_${endDate}.xlsx`;
  return {
    wb,
    filename,
    endDate,
    rangeStart: range.start,
    productCount: amz.products.size + fk.products.size + ms.products.size,
    platformTotals,
    platformSummaries,
    socialMediaSummary,
    googleSummary,
    unmappedAmazonSpend: round2(amz.unmappedSpend),
    amazonSpendWarnings,
    lowSpendCampaignCount: lowSpend.length,
    historyRowsSaved,
    incompleteDates,
    dataLoadErrors: ms.loadErrors.map((error) => ({ platform: "Meesho", error }))
  };
}
async function exportAdSpendReport(opts) {
  const { wb, ...stats } = await buildAdSpendReportWorkbook(opts);
  XLSX4.writeFile(wb, stats.filename, { bookSST: true, compression: true });
  return stats;
}
export {
  ACOS_UNDEFINED_SENTINEL,
  META_AD_SALES_SOURCE,
  acosCell,
  acosSortRank,
  actionSheetAcos,
  adOrdersCell,
  adStatusHasSpend,
  buildAdSpendReportWorkbook,
  computeAcos,
  computeCpc,
  exportAdSpendReport,
  fetchAmazonListingPriceMap,
  fetchAmazonProducts,
  fetchFlipkartListingPriceMap,
  fetchFlipkartProducts,
  fetchMeeshoProducts,
  flipkartRowRevenue,
  getDateWindow,
  groupProductsByName,
  noSalesAcos,
  sellPriceCell,
  spendTax
};
