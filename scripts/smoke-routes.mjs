// Smoke test for every dashboard page and API route, run against a running server WITHOUT logging in:
//   node scripts/smoke-routes.mjs [baseUrl]        (default http://localhost:3011)
// Expected: every /dashboard page redirects to the login page (proxy.ts), and every protected API
// refuses (401 / 403 / 503). A 500 means the route itself is broken; a 200 on a protected API
// means it is open. Sends nothing: no session, no internal or cron secret. Skips /api/sm (an open
// relay to SellerMate — see docs/DASHBOARD_AUDIT.md) and /api/auth/* (login rate limit).
const base = process.argv[2] || "http://localhost:3011";

const PAGES = `/dashboard /dashboard/adgroups /dashboard/ai /dashboard/barm /dashboard/barm/reports /dashboard/bids
/dashboard/campaigns /dashboard/compare /dashboard/daily-ad-spend /dashboard/fba /dashboard/flipkart /dashboard/flipkart/adgroups
/dashboard/flipkart/ai /dashboard/flipkart/bids /dashboard/flipkart/campaigns /dashboard/flipkart/hub /dashboard/flipkart/inventory
/dashboard/flipkart/keywords /dashboard/flipkart/marketshare /dashboard/flipkart/optimization /dashboard/flipkart/orders
/dashboard/flipkart/placements /dashboard/flipkart/products /dashboard/flipkart/ratings-reviews /dashboard/flipkart/reports
/dashboard/flipkart/sales /dashboard/flipkart/searchterms /dashboard/flipkart/settings /dashboard/flipkart/upload /dashboard/inventory
/dashboard/inventory/analytics /dashboard/inventory/consolidated /dashboard/inventory/live /dashboard/keywords /dashboard/marketshare
/dashboard/master /dashboard/meesho /dashboard/meesho/reports /dashboard/optimization /dashboard/placements /dashboard/products
/dashboard/ratings-reviews /dashboard/reports /dashboard/searchterms /dashboard/seasonal /dashboard/settings /dashboard/shopify
/dashboard/shopify/reports /dashboard/shopify/sources /dashboard/upload`.split(/\s+/);

const APIS = `/api/daily-ad-spend-insights /api/gemini-insights /api/generate-historical-report /api/live-inventory /api/seasonal-analytics
/api/ad-alerts /api/ad-spend-report-status /api/campaign-state-check /api/consolidated-mail /api/cron/campaign-monitor
/api/cron/scheduled-reports /api/daily-digest /api/email-settings /api/fba-forecast-report-status /api/fba-warehouse-alerts
/api/fc-name-alert /api/generate-ad-spend-report /api/generate-fba-forecast-report /api/high-acos-report /api/listing-alert
/api/live-alerts /api/rating-drop-alert /api/search-term-monthly-mail /api/send-ad-spend-email /api/send-email
/api/send-historical-email /api/stockout-alert /api/tool /api/weekly-report`.split(/\s+/);

const REFUSED = new Set([401, 403, 503]);
// GET-only routes are checked with GET, so a 405 can never hide an open route.
const GET_ONLY = new Set(["/api/live-inventory", "/api/seasonal-analytics"]);
const rows = [];
const check = async (path, init, ok) => {
  const t = Date.now();
  try {
    const r = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(60_000), ...init });
    const where = r.headers.get("location") || "";
    const pass = ok(r.status, where);
    rows.push({ path, status: r.status, to: where.replace(base, ""), ms: Date.now() - t, pass });
  } catch (e) {
    rows.push({ path, status: "ERR", to: String(e.message || e), ms: Date.now() - t, pass: false });
  }
};

for (const p of PAGES) await check(p, {}, (s, to) => s >= 300 && s < 400 && /\/($|\?)/.test(new URL(to, base).pathname));
for (const a of APIS) await check(a, GET_ONLY.has(a) ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, (s) => REFUSED.has(s));

const failed = rows.filter((r) => !r.pass);
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${String(r.status).padEnd(4)} ${r.path}${r.to ? ` -> ${r.to}` : ""}  (${r.ms} ms)`);
console.log(`\n${rows.length - failed.length}/${rows.length} passed`);
process.exit(failed.length ? 1 : 0);
