// Standalone diagnostic — run with: node scripts/probe-date-windows.cjs
//
// Tests whether get_retail_product_performance actually honors the requested
// start_date/end_date window, by querying several overlapping ranges for the
// BARM account and comparing totals against the known-correct ground truth
// from the exported weekly report:
//   17-23 Aug 2026 (last week)   ground truth ≈ 577,970
//   24-30 Aug 2026 (this week)   ground truth ≈ 662,092  (API returned 1,271,976.76 — the bug)
//   17-30 Aug 2026 (both weeks)  ground truth ≈ 1,240,062
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env.local");
const ACCOUNT_NAME_MATCH = (process.argv[2] || "b-arm").toLowerCase();
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
    if (match) return { apiKey, slot, account: match };
  }
  return null;
}

async function windowTotal(apiKey, account, start, end) {
  const res = await call(apiKey, "get_retail_product_performance", {
    amazon_account_id: account.id,
    workspace_id: account.workspace_id,
    start_date: start,
    end_date: end,
    page_size: 500,
  });
  if (res.error) return { start, end, error: res };
  return {
    start,
    end,
    totalSales: res.summary?.totalSales,
    totalUnitsOrdered: res.summary?.totalUnitsOrdered,
    rowCount: (res.data || []).length,
    pagination: res.pagination,
  };
}

(async () => {
  const env = loadEnv(ENV_PATH);
  const found = await findAccount(env);
  if (!found) {
    console.error(`No account matching "${ACCOUNT_NAME_MATCH}" found.`);
    process.exit(1);
  }
  const { apiKey, account } = found;
  console.log(`Using account "${account.name}" (slot ${found.slot})\n`);

  const windows = [
    { label: "17-23 Aug (last week)", start: "2026-08-17", end: "2026-08-23", groundTruth: 577970 },
    { label: "24-30 Aug (this week)", start: "2026-08-24", end: "2026-08-30", groundTruth: 662092 },
    { label: "17-30 Aug (both weeks combined)", start: "2026-08-17", end: "2026-08-30", groundTruth: 1240062 },
    { label: "24-29 Aug (this week minus last day)", start: "2026-08-24", end: "2026-08-29", groundTruth: null },
    { label: "29-30 Aug (last 2 days of this week)", start: "2026-08-29", end: "2026-08-30", groundTruth: null },
    { label: "1-30 Aug (whole month so far)", start: "2026-08-01", end: "2026-08-30", groundTruth: null },
  ];

  const results = [];
  for (const w of windows) {
    const r = await windowTotal(apiKey, account, w.start, w.end);
    results.push({ ...w, ...r });
    console.log(
      `${w.label.padEnd(35)} [${w.start} .. ${w.end}]  totalSales=${r.totalSales}` +
        (w.groundTruth ? `  (ground truth ≈ ${w.groundTruth}, ratio=${(r.totalSales / w.groundTruth).toFixed(3)})` : "") +
        `  rows=${r.rowCount}`
    );
  }

  const outPath = path.join(__dirname, "..", "retail_date_window_probe.json");
  fs.writeFileSync(outPath, JSON.stringify({ account: account.name, results }, null, 2));
  console.log(`\nFull results written to: ${outPath}`);
})().catch((e) => {
  console.error("Script failed:", e);
  process.exit(1);
});
