// One-off: aggregate the SD "Advertised product report" (ASIN-level) up to
// campaign+day grain and upsert into barm_amazon_sd_campaign, since that
// table's conflict key is (report_date, campaign_name) only — a raw upsert
// of the ASIN-level file hits "ON CONFLICT DO UPDATE command cannot affect
// row a second time" because multiple ASINs share the same campaign+date.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const csvPath = process.argv[2] || "C:\\Users\\91906\\Downloads\\Sponsored_Display_Advertised_product_report.csv";

const envText = fs.readFileSync(path.join(repoRoot, ".env.local"), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

function pick(row, re) {
  const key = Object.keys(row).find((k) => re.test(k));
  return key ? (row[key] ?? "").trim() : "";
}
function toNum(v) {
  if (!v) return 0;
  const cleaned = v.replace(/[^0-9.-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function toInt(v) {
  return Math.round(toNum(v));
}
const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function isoDateOnly(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}
function parseLongDate(v) {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase().slice(0, 3)];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, "0")}`;
}
function parseDDMonYY(v) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  const year = 2000 + Number(m[3]);
  return `${year}-${mm}-${m[1].padStart(2, "0")}`;
}
function parseAnyAmazonDate(v) {
  if (!v) return null;
  return isoDateOnly(v) || parseLongDate(v) || parseDDMonYY(v);
}

const csvText = fs.readFileSync(csvPath, "utf8");
const { data: rows } = Papa.parse(csvText, {
  header: true,
  skipEmptyLines: true,
  transformHeader: (h) => h.trim(),
});

const groups = new Map();
let skipped = 0;

for (const row of rows) {
  const report_date = parseAnyAmazonDate(pick(row, /^Date$/i));
  const campaign_name = pick(row, /^Campaign Name$/i);
  if (!report_date || !campaign_name) {
    skipped++;
    continue;
  }
  const key = `${report_date}||${campaign_name}`;
  if (!groups.has(key)) {
    groups.set(key, {
      report_date,
      campaign_name,
      portfolio_name: pick(row, /^Portfolio/i),
      currency: pick(row, /^Currency$/i),
      cost_type: pick(row, /^Cost Type$/i),
      country: pick(row, /^Country$/i),
      status: pick(row, /^Status$/i),
      impressions: 0,
      clicks: 0,
      spend: 0,
      sales_14d: 0,
      orders_14d: 0,
      units_14d: 0,
      asin_rows: 0,
    });
  }
  const g = groups.get(key);
  g.impressions += toInt(pick(row, /^Impressions$/i));
  g.clicks += toInt(pick(row, /^Clicks$/i));
  g.spend += toNum(pick(row, /^Spend$/i));
  g.sales_14d += toNum(pick(row, /14 Day Total Sales/i));
  g.orders_14d += toInt(pick(row, /14 Day Total Orders/i));
  g.units_14d += toInt(pick(row, /14 Day Total Units/i));
  g.asin_rows += 1;
}

const finalRows = [...groups.values()].map((g) => ({
  report_date: g.report_date,
  portfolio_name: g.portfolio_name,
  currency: g.currency,
  campaign_name: g.campaign_name,
  cost_type: g.cost_type,
  country: g.country,
  status: g.status,
  impressions: g.impressions,
  clicks: g.clicks,
  ctr: g.impressions > 0 ? g.clicks / g.impressions : null,
  cpc: g.clicks > 0 ? g.spend / g.clicks : null,
  spend: g.spend,
  acos: g.sales_14d > 0 ? g.spend / g.sales_14d : null,
  roas: g.spend > 0 ? g.sales_14d / g.spend : null,
  sales_14d: g.sales_14d,
  orders_14d: g.orders_14d,
  units_14d: g.units_14d,
  raw: {
    aggregated_from: "sd_advertised_product_report",
    source_file: path.basename(csvPath),
    asin_rows_combined: g.asin_rows,
  },
}));

console.log(`Parsed ${rows.length} CSV rows, skipped ${skipped} (missing date/campaign).`);
console.log(`Aggregated into ${finalRows.length} campaign+day rows.`);

const chunkSize = 300;
for (let i = 0; i < finalRows.length; i += chunkSize) {
  const chunk = finalRows.slice(i, i + chunkSize);
  const { error } = await supabase
    .from("barm_amazon_sd_campaign")
    .upsert(chunk, { onConflict: "report_date,campaign_name" });
  if (error) {
    console.error(`Upsert failed on chunk ${i}-${i + chunk.length}:`, error.message);
    process.exit(1);
  }
  console.log(`Upserted rows ${i + 1}-${i + chunk.length} of ${finalRows.length}.`);
}

console.log("Done.");
