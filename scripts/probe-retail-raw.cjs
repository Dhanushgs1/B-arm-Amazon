// Standalone diagnostic script — NOT part of the app, run manually with:
//   node scripts/probe-retail-raw.cjs
//
// Calls SellerMate's get_retail_product_performance directly (same endpoint the
// dashboard uses) for the BARM account, 24-30 Aug 2026, across every page, and
// dumps the raw rows to a JSON file plus a duplicate/mismatch summary to the
// console — so we can see whether the inflated Total Sales figure is caused by
// duplicate ASIN/SKU rows, a parent+child rollup, or something else entirely.
//
// Optional CLI args: node scripts/probe-retail-raw.cjs [start_date] [end_date] [account_name_substring]
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env.local");
const START_DATE = process.argv[2] || "2026-08-24";
const END_DATE = process.argv[3] || "2026-08-30";
const ACCOUNT_NAME_MATCH = (process.argv[4] || "barm").toLowerCase();
const BASE = "https://api.sellermate.ai/public/v1/tools";

function loadEnv(filePath) {
  const env = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    env[m[1]] = val;
  }
  return env;
}

async function call(apiKey, tool, args) {
  const res = await fetch(`${BASE}/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(args || {}),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { error: true, status: res.status, raw: text };
  }
}

async function findAccount(env) {
  for (const slot of ["A", "B"]) {
    const apiKey = env[`SELLERMATE_API_KEY_${slot}`] || env.SELLERMATE_API_KEY;
    if (!apiKey) continue;
    const ctx = await call(apiKey, "get_user_context", {});
    const accounts = ctx.accounts || [];
    const match = accounts.find((a) => (a.name || "").toLowerCase().includes(ACCOUNT_NAME_MATCH));
    if (match) {
      console.log(`Found account "${match.name}" in key slot ${slot}.`);
      return { apiKey, slot, account: match };
    }
    console.log(`Slot ${slot}: no account matching "${ACCOUNT_NAME_MATCH}" (accounts: ${accounts.map((a) => a.name).join(", ") || "none"})`);
  }
  return null;
}

async function fetchAllPages(apiKey, args) {
  const all = [];
  let summary = null;
  for (let page = 0; page < 20; page++) {
    const res = await call(apiKey, "get_retail_product_performance", { ...args, page, page_size: 500 });
    if (res.error) {
      console.error(`Page ${page} error:`, res);
      break;
    }
    if (page === 0) summary = res.summary || {};
    const rows = res.data || [];
    all.push(...rows);
    console.log(`Page ${page}: ${rows.length} rows, hasMore=${res.pagination?.hasMore}`);
    if (!res.pagination?.hasMore || rows.length === 0) break;
  }
  return { summary, rows: all };
}

(async () => {
  const env = loadEnv(ENV_PATH);
  const found = await findAccount(env);
  if (!found) {
    console.error(`\nNo account matching "${ACCOUNT_NAME_MATCH}" found in either key slot. Pass the account name substring as the 3rd argument.`);
    process.exit(1);
  }
  const { apiKey, account } = found;

  const args = {
    amazon_account_id: account.id,
    workspace_id: account.workspace_id,
    start_date: START_DATE,
    end_date: END_DATE,
  };

  console.log(`\nFetching get_retail_product_performance for ${account.name}, ${START_DATE} to ${END_DATE}...`);
  const { summary, rows } = await fetchAllPages(apiKey, args);

  // --- Diagnostics ---
  const sumAll = rows.reduce((s, r) => s + (r.totalSales || 0), 0);

  const byAsin = new Map();
  for (const r of rows) {
    const key = r.asin || "(no asin)";
    if (!byAsin.has(key)) byAsin.set(key, []);
    byAsin.get(key).push(r);
  }
  const dupeAsins = [...byAsin.entries()].filter(([, list]) => list.length > 1);

  const bySku = new Map();
  for (const r of rows) {
    const key = r.sku || "(no sku)";
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(r);
  }
  const dupeSkus = [...bySku.entries()].filter(([key, list]) => list.length > 1 && key !== "(no sku)");

  const sumDedupedByAsin = [...byAsin.values()].reduce((s, list) => s + (list[0].totalSales || 0), 0);

  console.log("\n========== SUMMARY ==========");
  console.log("API summary object:", JSON.stringify(summary, null, 2));
  console.log(`\nTotal rows returned: ${rows.length}`);
  console.log(`Distinct ASINs: ${byAsin.size}`);
  console.log(`Distinct SKUs: ${bySku.size}`);
  console.log(`Sum of totalSales across ALL rows: ${sumAll}`);
  console.log(`Sum of totalSales after de-duping by ASIN (first row per ASIN kept): ${sumDedupedByAsin}`);
  console.log(`ASINs appearing more than once: ${dupeAsins.length}`);
  if (dupeAsins.length > 0) {
    console.log("\nFirst 10 duplicate ASINs (asin -> totalSales per row):");
    for (const [asin, list] of dupeAsins.slice(0, 10)) {
      console.log(`  ${asin}: [${list.map((r) => r.totalSales).join(", ")}]  productName=${list[0].productName || ""}`);
    }
  }
  console.log(`SKUs appearing more than once: ${dupeSkus.length}`);
  if (dupeSkus.length > 0) {
    console.log("\nFirst 10 duplicate SKUs (sku -> totalSales per row):");
    for (const [sku, list] of dupeSkus.slice(0, 10)) {
      console.log(`  ${sku}: [${list.map((r) => r.totalSales).join(", ")}]  asin=${list[0].asin || ""}`);
    }
  }
  console.log("==============================\n");

  const outPath = path.join(__dirname, "..", `retail_raw_${START_DATE}_to_${END_DATE}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        account: { id: account.id, name: account.name, workspace_id: account.workspace_id },
        dateRange: { start: START_DATE, end: END_DATE },
        summary,
        rowCount: rows.length,
        distinctAsins: byAsin.size,
        distinctSkus: bySku.size,
        sumTotalSalesAllRows: sumAll,
        sumTotalSalesDedupedByAsin: sumDedupedByAsin,
        duplicateAsinCount: dupeAsins.length,
        duplicateAsins: dupeAsins.map(([asin, list]) => ({ asin, rows: list })),
        rows,
      },
      null,
      2
    )
  );
  console.log(`Raw data + diagnostics written to: ${outPath}`);
})().catch((e) => {
  console.error("Script failed:", e);
  process.exit(1);
});
