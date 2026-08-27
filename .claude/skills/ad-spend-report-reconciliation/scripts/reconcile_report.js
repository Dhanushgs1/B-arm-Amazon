#!/usr/bin/env node
/**
 * Reconcile a generated Ad Spend Report (SKU-wise) against the raw
 * per-platform "Last 7 days"-type source workbook it was built from.
 *
 * Usage:  node reconcile_report.js "<raw source .xlsx>" "<generated report .xlsx>"
 *
 * Exits 1 if any FAIL-level check trips, so it can gate sending/publishing.
 *
 * Sheet and column names come from the header text, with a candidate list per
 * field (platform export formats and hand-consolidated tracker workbooks both
 * exist in the wild) — never hardcoded positions. Missing sheets/columns are
 * reported as WARN/INFO rather than crashing, since a raw file legitimately
 * won't have every platform every time.
 */

const path = require("path");

let XLSX;
for (const cand of ["xlsx", "xlsx-js-style"]) {
  try { XLSX = require(cand); break; } catch { /* try next */ }
}
if (!XLSX) {
  console.error("Need the 'xlsx' package. Run from a project that has it (e.g. ppc-dashboard), or: npm i xlsx");
  process.exit(2);
}

const [rawPath, reportPath] = process.argv.slice(2);
if (!rawPath || !reportPath) {
  console.error('Usage: node reconcile_report.js "<raw source .xlsx>" "<generated report .xlsx>"');
  process.exit(2);
}

// ── result collection (same convention as amazon-ad-report-audit) ──────────
const results = [];
const add = (level, check, detail) => results.push({ level, check, detail });
const pass = (c, d) => add("PASS", c, d);
const warn = (c, d) => add("WARN", c, d);
const fail = (c, d) => add("FAIL", c, d);
const info = (c, d) => add("INFO", c, d);

const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") { const n = parseFloat(v.replace(/[^0-9.eE+-]/g, "")); return Number.isFinite(n) ? n : null; }
  return null;
};
const near = (a, b, tolPct = 0.02) => Math.abs(a - b) <= tolPct * Math.max(1, Math.abs(a), Math.abs(b));
const money = (n) => `Rs ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// Excel serial or a text date ("Aug 19, 2026", "2026-08-19", "19/08/2026") -> 'YYYY-MM-DD', UTC-safe.
function toISODate(v) {
  if (typeof v === "number" && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[0];
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const d = new Date(s + " UTC");
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function normalizeHeaderKey(s) { return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase(); }

/** First column index whose header matches one of `candidates` (case/space-insensitive). */
function findCol(headerRow, candidates) {
  const norm = headerRow.map((h) => normalizeHeaderKey(h));
  for (const cand of candidates) {
    const i = norm.indexOf(normalizeHeaderKey(cand));
    if (i !== -1) return i;
  }
  return -1;
}

function sheetGrid(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
}

/** Best-effort sheet lookup by platform + type (ads/orders), trying several
 *  naming conventions seen across seller-tool exports and hand-built trackers.
 *  Returns ALL matches (e.g. Meesho often has separate "B Arm"/"Millwright"
 *  sub-sheets that should both be summed), not just the first. */
function findSheets(wb, patterns) {
  return wb.SheetNames.filter((n) => patterns.some((re) => re.test(n)));
}

const SHEET_PATTERNS = {
  Amazon: { ads: [/amazon.*ad/i, /^am\s*ads?$/i], orders: [/amazon.*ord/i, /^am\s*ord/i] },
  Flipkart: { ads: [/flipkart.*ad/i, /^fk\s*ads?$/i], orders: [/flipkart.*ord/i, /^fk\s*ord/i] },
  Meesho: { ads: [/meesho.*ad/i, /^ms\b.*ad/i], orders: [/meesho.*ord/i, /^ms\b.*ord/i] },
};

// Per-platform column candidates — first match wins. Add more aliases here as
// new export formats show up rather than hardcoding a single name.
const COLS = {
  Amazon: {
    adsDate: ["Start Date"], adsSpend: ["Spend"],
    ordDate: ["Date ", "Date", "purchase-date"], ordQty: ["quantity"], ordValue: ["item-price"],
  },
  Flipkart: {
    adsDate: ["Date"], adsSpend: ["Ad Spend", "Spend"],
    ordDate: ["Ordered On", "order_date", "Order Date"], ordQty: ["Quantity"], ordValue: ["Invoice Amount"],
  },
  Meesho: {
    adsDate: ["Date"], adsSpend: ["Spend"],
    ordDate: ["Order Date"], ordQty: ["Quantity"],
    ordValue: ["Supplier Listed Price (Incl. GST + Commission)", "Supplier Discounted Price (Incl GST and Commision)"],
  },
};

const PLATFORMS = ["Amazon", "Flipkart", "Meesho"];

// ── load workbooks ───────────────────────────────────────────────────────────
const rawWb = XLSX.readFile(rawPath);
const reportWb = XLSX.readFile(reportPath);
info("Files", `raw: ${path.basename(rawPath)} | report: ${path.basename(reportPath)}`);
info("Raw workbook sheets", rawWb.SheetNames.join(", "));

// ── figure out the report's own labeled window (from the Summary sheet) ─────
// Summary row 4 (0-based row 3) carries "<dd-mm-yyyy>" (day) and
// "<dd-mm-yyyy> to <dd-mm-yyyy>" (range) — see adSpendReportExport.ts's
// dayLabel/rangeLabel. Scanning cell text rather than a fixed address, so a
// column shuffle doesn't silently break this.
function dmyToIso(s) { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }
let reportDay = null, reportRangeStart = null, reportRangeEnd = null;
{
  const g = sheetGrid(reportWb, "Summary");
  if (g) {
    for (const row of g) {
      for (const cell of row) {
        const s = String(cell ?? "").trim();
        const range = /^(\d{2}-\d{2}-\d{4}) to (\d{2}-\d{2}-\d{4})$/.exec(s);
        if (range && !reportRangeStart) { reportRangeStart = dmyToIso(range[1]); reportRangeEnd = dmyToIso(range[2]); }
        else if (/^\d{2}-\d{2}-\d{4}$/.test(s) && !reportDay) reportDay = dmyToIso(s);
      }
    }
  }
}
if (!reportDay || !reportRangeStart) {
  fail("Locate report's labeled date window", "couldn't find a day label and a 'X to Y' range label on the Summary sheet — is this an Ad Spend Report (SKU-wise) workbook?");
} else {
  info("Report's labeled window", `day ${reportDay} | range ${reportRangeStart} to ${reportRangeEnd}`);
}

// ── per-platform raw aggregation ─────────────────────────────────────────────
const rawAgg = {};
for (const platform of PLATFORMS) {
  const cols = COLS[platform];
  const adsSheets = findSheets(rawWb, SHEET_PATTERNS[platform].ads);
  const ordSheets = findSheets(rawWb, SHEET_PATTERNS[platform].orders);

  const agg = { platform, adsSheets, ordSheets, adsMin: null, adsMax: null, adsSpendRange: 0, adsSpendDay: 0,
    ordMin: null, ordMax: null, qtyRange: 0, valueRange: 0, qtyDay: 0, valueDay: 0, adsRowsSeen: 0, ordRowsSeen: 0 };
  rawAgg[platform] = agg;

  if (!adsSheets.length) warn(`[${platform}] raw ads sheet found`, `none of the expected sheet names present — checked patterns ${SHEET_PATTERNS[platform].ads.map(String).join(", ")}`);
  if (!ordSheets.length) { warn(`[${platform}] raw orders sheet found`, "none matched — QTS/Value check for this platform will be skipped"); continue; }

  for (const sheetName of adsSheets) {
    const g = sheetGrid(rawWb, sheetName);
    if (!g || g.length < 2) continue;
    const H = g[0];
    const dCol = findCol(H, cols.adsDate), sCol = findCol(H, cols.adsSpend);
    if (dCol === -1 || sCol === -1) { warn(`[${platform}] ${sheetName} columns`, `couldn't find ${dCol === -1 ? cols.adsDate.join("/") : cols.adsSpend.join("/")}`); continue; }
    for (const row of g.slice(1)) {
      const spend = num(row[sCol]);
      if (spend === null) continue;
      agg.adsRowsSeen++;
      const iso = toISODate(row[dCol]);
      if (iso) { if (!agg.adsMin || iso < agg.adsMin) agg.adsMin = iso; if (!agg.adsMax || iso > agg.adsMax) agg.adsMax = iso; }
      if (!reportRangeStart || (iso && iso >= reportRangeStart && iso <= reportRangeEnd)) agg.adsSpendRange += spend;
      if (reportDay && iso === reportDay) agg.adsSpendDay += spend;
    }
  }

  for (const sheetName of ordSheets) {
    const g = sheetGrid(rawWb, sheetName);
    if (!g || g.length < 2) continue;
    const H = g[0];
    const dCol = findCol(H, cols.ordDate), qCol = findCol(H, cols.ordQty), vCol = findCol(H, cols.ordValue);
    if (dCol === -1 || qCol === -1 || vCol === -1) {
      warn(`[${platform}] ${sheetName} columns`, `couldn't find one of: date=${dCol}, qty=${qCol}, value=${vCol} (looked for ${cols.ordDate.join("/")}, ${cols.ordQty.join("/")}, ${cols.ordValue.join("/")})`);
      continue;
    }
    for (const row of g.slice(1)) {
      const qty = num(row[qCol]);
      if (qty === null) continue;
      agg.ordRowsSeen++;
      const iso = toISODate(row[dCol]);
      const value = num(row[vCol]) ?? 0;
      if (iso) { if (!agg.ordMin || iso < agg.ordMin) agg.ordMin = iso; if (!agg.ordMax || iso > agg.ordMax) agg.ordMax = iso; }
      if (!reportRangeStart || (iso && iso >= reportRangeStart && iso <= reportRangeEnd)) { agg.qtyRange += qty; agg.valueRange += value; }
      if (reportDay && iso === reportDay) { agg.qtyDay += qty; agg.valueDay += value; }
    }
  }
}

// ── 1. date range validation ─────────────────────────────────────────────────
for (const platform of PLATFORMS) {
  const a = rawAgg[platform];
  if (!a.adsMin && !a.ordMin) continue;
  const rawMin = [a.adsMin, a.ordMin].filter(Boolean).sort()[0];
  const rawMax = [a.adsMax, a.ordMax].filter(Boolean).sort().pop();
  if (!reportRangeStart) continue;
  if (rawMin === reportRangeStart && rawMax === reportRangeEnd) {
    pass(`[${platform}] date range matches report label`, `${rawMin} to ${rawMax}`);
  } else {
    const oneDayLag = rawMax && reportRangeEnd && new Date(rawMax) < new Date(reportRangeEnd)
      && (new Date(reportRangeEnd) - new Date(rawMax)) / 86400000 <= 1;
    if (oneDayLag) {
      warn(`[${platform}] date range vs report label`, `raw data ends ${rawMax}, report is labeled through ${reportRangeEnd} — looks like the platform's normal 1-day reporting lag (today's spend isn't downloadable until tomorrow), not a bug. Confirm the report's own Notes sheet flags this date as incomplete.`);
    } else {
      fail(`[${platform}] date range vs report label`, `raw data spans ${rawMin} to ${rawMax}, report is labeled ${reportRangeStart} to ${reportRangeEnd} — more than a 1-day gap, investigate the upload/date filter.`);
    }
  }
  if (reportDay) {
    const dayAdsHasData = a.adsSpendDay > 0;
    if (!dayAdsHasData && a.adsRowsSeen > 0) {
      warn(`[${platform}] day-of (${reportDay}) ad spend`, "raw ads data has zero spend on the report's single reporting day — expected if the platform hasn't finalized that day yet, not necessarily a broken formula. Cross-check against the report's own Notes sheet.");
    }
  }
}

// ── 2. structural check (report side only — SKU(s) column, duplicate names) ─
{
  const g = sheetGrid(reportWb, "Ad spend report");
  if (!g || g.length < 4) {
    fail("Locate 'Ad spend report' sheet", "missing or empty — is this the SKU-wise Ad Spend Report?");
  } else {
    // The per-platform block's own header spans TWO rows: SKU(s)/Product
    // Name/Price on one, the day/range metric names (Spend, Orders, ...) on
    // the next — merge them so a lookup doesn't miss whichever row it isn't on.
    const H = (g[2] || []).map((v, i) => v || (g[3] || [])[i] || "");
    const skuCol = findCol(H, ["SKU(s)", "SKU"]);
    if (skuCol === -1) warn("'Ad spend report' has a SKU(s) column", "not found — rows can only be grouped by product name, which silently merges distinct SKUs at different prices into one row");
    else pass("'Ad spend report' has a SKU(s) column", `column ${skuCol + 1}`);

    const nameCol = findCol(H, ["Product Name"]);
    if (nameCol !== -1) {
      let platform = null;
      const seenByPlatform = {};
      for (const row of g) {
        const a0 = String(row[0] ?? "").trim();
        if (PLATFORMS.includes(a0)) { platform = a0; seenByPlatform[platform] = seenByPlatform[platform] || new Map(); continue; }
        if (!platform || !row[nameCol]) continue;
        const m = seenByPlatform[platform];
        m.set(row[nameCol], (m.get(row[nameCol]) || 0) + 1);
      }
      const dupeReport = [];
      for (const [p, m] of Object.entries(seenByPlatform)) {
        const dupes = [...m.entries()].filter(([, c]) => c > 1);
        if (dupes.length) dupeReport.push(`${p}: ${dupes.map(([n, c]) => `"${n}" x${c}`).join(", ")}`);
      }
      if (dupeReport.length) {
        warn("Duplicate product-name rows within a platform", `${dupeReport.join(" | ")} — confirm these are genuinely different SKUs sharing a name (fine) rather than a grouping bug that should have merged them (not fine, would double-count if summed)`);
      } else {
        pass("Duplicate product-name rows within a platform", "none — no silent double-count signature");
      }
    }
  }
}

// ── 3. total reconciliation (raw ads spend vs report's per-SKU rollup) ──────
for (const platform of PLATFORMS) {
  const raw = rawAgg[platform];
  if (!raw.adsSheets.length) continue;
  const g = sheetGrid(reportWb, "Ad spend report");
  if (!g) continue;
  const H4 = g[3] || [];
  // Resolve BOTH occurrences of "Spend(with tax)" (day block, then range block) by header text.
  const headerNorm = H4.map((h) => normalizeHeaderKey(h));
  const spendTaxIdx = headerNorm.reduce((acc, h, i) => (h === "spend(with tax)" ? [...acc, i] : acc), []);
  if (spendTaxIdx.length < 2) { warn(`[${platform}] 'Ad spend report' rollup columns`, "couldn't locate both day and range 'Spend(with tax)' columns"); continue; }
  const [dayTaxCol, rangeTaxCol] = spendTaxIdx;

  let platform2 = null, rollupRangeTax = 0, rollupDayTax = 0, rows = 0;
  for (const row of g) {
    const a0 = String(row[0] ?? "").trim();
    if (PLATFORMS.includes(a0)) { platform2 = a0; continue; }
    if (platform2 !== platform) continue;
    const rt = num(row[rangeTaxCol]);
    const dt = num(row[dayTaxCol]);
    if (rt !== null) { rollupRangeTax += rt; rows++; }
    if (dt !== null) rollupDayTax += dt;
  }

  const expectedRangeTax = raw.adsSpendRange * 1.18;
  const expectedDayTax = raw.adsSpendDay * 1.18;
  if (near(rollupRangeTax, expectedRangeTax)) {
    pass(`[${platform}] total reconciliation (range, with tax)`, `raw ${money(raw.adsSpendRange)} x 1.18 = ${money(expectedRangeTax)} vs rollup ${money(rollupRangeTax)} across ${rows} rows`);
  } else {
    const gap = rollupRangeTax - expectedRangeTax;
    fail(`[${platform}] total reconciliation (range, with tax)`, `raw ${money(raw.adsSpendRange)} x 1.18 = ${money(expectedRangeTax)} but rollup sums to ${money(rollupRangeTax)} — gap ${money(gap)} (${((gap / expectedRangeTax) * 100).toFixed(1)}%). ${gap > 0 ? "Rollup HIGHER than raw is the signature of double-counting (check #2 above) — a SKU grouped by name only, or a re-uploaded overlapping file not deduped." : "Rollup LOWER than raw — rows are being dropped somewhere between raw and the per-SKU table (a status filter or unmapped-campaign spend not being attributed)."}`);
  }
  if (raw.adsSpendDay > 0) {
    if (near(rollupDayTax, expectedDayTax)) pass(`[${platform}] total reconciliation (day, with tax)`, `raw ${money(raw.adsSpendDay)} x 1.18 = ${money(expectedDayTax)} vs rollup ${money(rollupDayTax)}`);
    else fail(`[${platform}] total reconciliation (day, with tax)`, `raw ${money(raw.adsSpendDay)} x 1.18 = ${money(expectedDayTax)} but rollup sums to ${money(rollupDayTax)}`);
  }

  // Cross-check against the Summary sheet's own platform-level day total (B/C columns).
  const sg = sheetGrid(reportWb, "Summary");
  if (sg) {
    let sp = null;
    for (const row of sg) {
      if (String(row[0] ?? "").trim() === platform) { sp = num(row[2]); break; } // col C = "Ad spend (with tax)"
    }
    if (sp !== null) {
      if (near(sp, expectedDayTax)) pass(`[${platform}] Summary sheet day total`, `${money(sp)} matches raw x 1.18`);
      else fail(`[${platform}] Summary sheet day total`, `Summary shows ${money(sp)}, raw x 1.18 is ${money(expectedDayTax)}`);
    }
  }
}

// ── 4. Overall sales (QTS/Value) verification ────────────────────────────────
for (const platform of PLATFORMS) {
  const raw = rawAgg[platform];
  if (!raw.ordSheets.length) continue;
  const sg = sheetGrid(reportWb, "Summary");
  if (!sg) continue;
  let qts = null, value = null;
  for (const row of sg) {
    if (String(row[0] ?? "").trim() === platform) {
      // P/Q are the last two columns of the 17-col Summary layout (indices 15, 16).
      qts = num(row[15]); value = num(row[16]);
      break;
    }
  }
  if (qts === null) { warn(`[${platform}] Overall sales QTS/Value located on Summary sheet`, "couldn't find the platform's label row or its QTS/Value cells"); continue; }

  const qtsGapPct = raw.qtyRange > 0 ? Math.abs(qts - raw.qtyRange) / raw.qtyRange * 100 : 0;
  const valueGapPct = raw.valueRange > 0 ? Math.abs(value - raw.valueRange) / raw.valueRange * 100 : 0;

  if (near(qts, raw.qtyRange, 0.01)) pass(`[${platform}] Overall sales QTS`, `raw SUM(qty) ${raw.qtyRange} = report ${qts}`);
  else if (qtsGapPct <= 3) warn(`[${platform}] Overall sales QTS`, `raw ${raw.qtyRange} vs report ${qts} (${qtsGapPct.toFixed(1)}%) — within normal order-status drift between when the raw file was pulled and when the report was generated (new orders / cancellations / returns land between pulls). Not a formula error unless it doesn't shrink when you re-pull both at the same moment.`);
  else fail(`[${platform}] Overall sales QTS`, `raw SUM(qty) ${raw.qtyRange} vs report ${qts} — gap ${(qts - raw.qtyRange)} (${qtsGapPct.toFixed(1)}%), too large for normal drift. Check for a status filter still applied on the Overall sales accumulation (it should sum every order status, unfiltered) or a date-window boundary mismatch.`);

  if (near(value, raw.valueRange, 0.01)) pass(`[${platform}] Overall sales Value`, `raw SUM(value) ${money(raw.valueRange)} = report ${money(value)}`);
  else if (valueGapPct <= 3) warn(`[${platform}] Overall sales Value`, `raw ${money(raw.valueRange)} vs report ${money(value)} (${valueGapPct.toFixed(1)}%) — within normal order-status drift, same reasoning as QTS above.`);
  else fail(`[${platform}] Overall sales Value`, `raw SUM(value) ${money(raw.valueRange)} vs report ${money(value)} — gap ${money(value - raw.valueRange)} (${valueGapPct.toFixed(1)}%). Confirm Value is summed straight from the order sheet's own price column (${COLS[platform].ordValue[0]}) for this platform, not from a different report (e.g. Flipkart's separate Earn More export) or with a status filter still applied.`);
}

// ── report ──────────────────────────────────────────────────────────────────
const ICON = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌", INFO: "ℹ️ " };
const order = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3 };
console.log(`\nAd Spend Report reconciliation\n${"=".repeat(76)}`);
results.sort((a, b) => order[a.level] - order[b.level]);
for (const r of results) {
  console.log(`${ICON[r.level]} ${r.check}`);
  if (r.detail) console.log(`     ${r.detail}`);
}
const counts = results.reduce((m, r) => ((m[r.level] = (m[r.level] || 0) + 1), m), {});
console.log(`${"=".repeat(76)}`);
console.log(`${counts.FAIL || 0} failed · ${counts.WARN || 0} warnings · ${counts.PASS || 0} passed\n`);
process.exit((counts.FAIL || 0) > 0 ? 1 : 0);
