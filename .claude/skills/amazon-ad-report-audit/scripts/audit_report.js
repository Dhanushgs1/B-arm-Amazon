#!/usr/bin/env node
/**
 * Audit an Amazon Historical Analysis Report / "Amazon ad performance" workbook.
 *
 * Usage:  node audit_report.js "<path to .xlsx>"
 *
 * Exits 1 if any FAIL-level check trips, so it can gate a release.
 *
 * Every check here exists because a real workbook got it wrong at least once.
 * The header comments on each check say which failure it catches, so a reader
 * can decide whether a WARN matters for their situation rather than treating
 * the output as a black box.
 *
 * Column positions are resolved from the header text, never hardcoded — the
 * sheet has TWO windows using identical column names, so the first occurrence
 * of a name is the 30-day block and the second is the 7-day block. Hardcoded
 * indices break the moment a column is inserted.
 */

const path = require("path");

let XLSX;
for (const cand of ["xlsx", "xlsx-js-style"]) {
  try { XLSX = require(cand); break } catch { /* try next */ }
}
if (!XLSX) {
  console.error("Need the 'xlsx' package. Run from a project that has it (e.g. ppc-dashboard), or: npm i xlsx");
  process.exit(2);
}

const file = process.argv[2];
if (!file) { console.error("Usage: node audit_report.js \"<path to .xlsx>\""); process.exit(2); }

const wb = XLSX.readFile(file);
const sheet = (name) => wb.Sheets[name];
const grid = (name) => (sheet(name) ? XLSX.utils.sheet_to_json(sheet(name), { header: 1, raw: true }) : null);

// ── result collection ───────────────────────────────────────────────────────
const results = [];
const add = (level, check, detail) => results.push({ level, check, detail });
const pass = (c, d) => add("PASS", c, d);
const warn = (c, d) => add("WARN", c, d);
const fail = (c, d) => add("FAIL", c, d);
const info = (c, d) => add("INFO", c, d);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// Relative comparison: these are floats carried through several divisions, so
// exact equality would produce noise. 1e-6 is far tighter than any real error.
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

/** Index of the Nth (1-based) column whose header equals `label`. */
function nthCol(headers, label, n = 1) {
  let seen = 0;
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] ?? "").trim() === label) { seen++; if (seen === n) return i }
  }
  return -1;
}

// ── 1. structure ────────────────────────────────────────────────────────────
// A missing computed sheet means the generator bailed partway; a missing raw
// dump usually just means that export was never uploaded, which is a WARN.
const COMPUTED = ["Analysis report", "TACOS", "Orders, returns, adspend", "FBA status"];
const RAW_ANY = ["Price", "FBA inventory", "Inventory ledger"];

const present = new Set(wb.SheetNames);
const missingComputed = COMPUTED.filter((s) => !present.has(s));
if (missingComputed.length) fail("Computed sheets present", `missing: ${missingComputed.join(", ")}`);
else pass("Computed sheets present", COMPUTED.join(", "));

const missingRaw = RAW_ANY.filter((s) => !present.has(s));
if (missingRaw.length) warn("Raw dump sheets", `absent (likely not uploaded): ${missingRaw.join(", ")}`);

info("Sheets in workbook", `${wb.SheetNames.length} — ${wb.SheetNames.join(", ")}`);

// ── 2. Analysis report ──────────────────────────────────────────────────────
const ar = grid("Analysis report");
if (!ar || ar.length < 3) {
  fail("Analysis report readable", "sheet missing or has no data rows");
} else {
  const H = ar[1] || [];
  const c = {
    sku: nthCol(H, "SKU ID"),
    price: nthCol(H, "Price"),
    st30: nthCol(H, "Spend+Tax", 1), adv30: nthCol(H, "Advertised SKU Units (#)", 1),
    tot30: nthCol(H, "Total Units (#)", 1), ord30: nthCol(H, "Orders", 1),
    ret30: nthCol(H, "Returns", 1), fin30: nthCol(H, "Final", 1),
    cpc30: nthCol(H, "CPC", 1), acos30: nthCol(H, "ACOS", 1), tacos30: nthCol(H, "TACOS", 1),
    st7: nthCol(H, "Spend+Tax", 2), adv7: nthCol(H, "Advertised SKU Units (#)", 2),
    tot7: nthCol(H, "Total Units (#)", 2), ord7: nthCol(H, "Orders", 2),
    ret7: nthCol(H, "Returns", 2), fin7: nthCol(H, "Final", 2),
    cpc7: nthCol(H, "CPC", 2), acos7: nthCol(H, "ACOS", 2), tacos7: nthCol(H, "TACOS", 2),
  };
  const missingCols = Object.entries(c).filter(([, v]) => v === -1).map(([k]) => k);
  if (missingCols.length) {
    fail("Analysis report columns", `could not locate: ${missingCols.join(", ")}`);
  } else {
    pass("Analysis report columns", "both 30-day and 7-day blocks located by header");

    const body = ar.slice(2).filter((r) => r && String(r[0] ?? "").trim() !== "");
    const gtIdx = body.findIndex((r) => String(r[0]).trim().toUpperCase() === "GRAND TOTAL");
    const gt = gtIdx >= 0 ? body[gtIdx] : null;
    const dataRows = (gtIdx >= 0 ? body.slice(0, gtIdx) : body).filter((r) => num(r[c.st30]) !== null);

    info("Analysis report rows", `${dataRows.length} campaign x SKU data rows`);
    if (!gt) warn("GRAND TOTAL row", "absent — the manual workbook omits it; generated reports should include it");

    // ── 2a. per-row arithmetic, both windows ──
    // These are the definitions the seller's own workbook uses. CPC falls back
    // to raw Spend+Tax when a row has 0 advertised units (dividing by zero
    // would otherwise blank the cell and hide real spend).
    // TACOS has TWO defensible conventions in the wild, and mistaking one for
    // the other produces a wall of false failures — so classify rather than
    // assume:
    //   per-SKU  — this SKU's TOTAL spend across all its campaigns / (Price x Final).
    //              The same value repeats on every campaign row of that SKU.
    //              Answers "is this SKU's advertising paying for itself".
    //              This is what the hand-built workbook does, and it matches the
    //              TACOS sheet's own per-SKU definition.
    //   per-row  — just THIS campaign row's spend / (Price x Final). The rows of
    //              one SKU then sum to that SKU's per-SKU TACOS. Answers "which
    //              campaign is eating the margin".
    // Both are coherent; they are not interchangeable, and a workbook should
    // pick one. Final=0 is genuinely undefined (spend but no net orders), so a
    // trailing 0 and the substitute-1 fallback are both accepted variants.
    const rowsPerSku = new Map();
    dataRows.forEach((r) => rowsPerSku.set(r[c.sku], (rowsPerSku.get(r[c.sku]) ?? 0) + 1));

    const skuSpend = new Map();
    const spendKeyFor = (cs) => {
      const m = new Map();
      dataRows.forEach((r) => { const k = r[c.sku]; m.set(k, (m.get(k) ?? 0) + (num(r[cs.st]) ?? 0)) });
      return m;
    };

    const check = (label, cs) => {
      const bad = { final: [], cpc: [], acos: [] };
      const tacosBad = [];
      const tally = { perSku: 0, perRow: 0, zero: 0 };
      const totals = spendKeyFor(cs);
      skuSpend.set(label, totals);
      let n = 0;
      dataRows.forEach((r, i) => {
        const price = num(r[cs.price]) ?? 0, st = num(r[cs.st]), adv = num(r[cs.adv]) ?? 0;
        const ord = num(r[cs.ord]) ?? 0, ret = num(r[cs.ret]) ?? 0;
        const fin = num(r[cs.fin]), cpc = num(r[cs.cpc]), acos = num(r[cs.acos]), tacos = num(r[cs.tacos]);
        if (st === null) return;
        n++;
        const row = i + 3, sku = r[c.sku];
        if (fin !== null && !near(fin, ord - ret)) bad.final.push(`row ${row} ${sku}: ${fin} != ${ord}-${ret}`);
        const expCpc = adv > 0 ? st / adv : st;
        if (cpc !== null && !near(cpc, expCpc)) bad.cpc.push(`row ${row} ${sku}: ${cpc} != ${expCpc.toFixed(4)}`);
        const expAcos = price > 0 ? expCpc / price : 0;
        if (acos !== null && !near(acos, expAcos)) bad.acos.push(`row ${row} ${sku}: ${acos} != ${expAcos.toFixed(6)}`);

        if (tacos === null) return;
        const f = Math.max(0, ord - ret);
        const vRow = price * (f || 1) > 0 ? st / (price * (f || 1)) : 0;
        const vSku = price * (f || 1) > 0 ? (totals.get(sku) ?? st) / (price * (f || 1)) : 0;
        const vZero = f > 0 && price > 0 ? st / (price * f) : 0;
        const okSku = near(tacos, vSku), okRow = near(tacos, vRow);
        // Only a SKU spread over several campaigns can distinguish the two
        // conventions — for a single-campaign SKU they are the same number, so
        // counting those would just elect whichever branch is tested first.
        if (rowsPerSku.get(sku) > 1) {
          if (okSku && !okRow) tally.perSku++;
          else if (okRow && !okSku) tally.perRow++;
        }
        if (okSku || okRow) return;
        if (near(tacos, vZero) || (f === 0 && near(tacos, 0))) { tally.zero++; return }
        tacosBad.push(`row ${row} ${sku}: ${tacos.toFixed(6)} (per-SKU would be ${vSku.toFixed(6)}, per-row ${vRow.toFixed(6)})`);
      });

      const show = (arr) => arr.slice(0, 3).join(" | ") + (arr.length > 3 ? ` … +${arr.length - 3} more` : "");
      for (const [k, arr] of Object.entries(bad)) {
        const name = { final: "Final = Orders - Returns", cpc: "CPC = Spend+Tax / Advertised Units", acos: "ACOS = CPC / Price" }[k];
        if (arr.length) fail(`${label} ${name}`, show(arr));
        else pass(`${label} ${name}`, `${n} rows`);
      }
      // Rows of a single-campaign SKU satisfy both conventions, so the
      // convention is only revealed by multi-campaign SKUs.
      const convention = tally.perSku === 0 && tally.perRow === 0 ? "indeterminate"
        : tally.perSku >= tally.perRow ? "per-SKU" : "per-row";
      if (tacosBad.length) {
        fail(`${label} TACOS = Spend+Tax / (Price x Final)`,
          `${tacosBad.length} rows match neither convention: ${show(tacosBad)}`
          + ` — if the '${label} window re-scoped' check below also failed, this is its downstream symptom: the TACOS column was computed from correctly-scoped spend while the Spend+Tax column shown beside it is stale, so the two disagree.`);
      } else {
        pass(`${label} TACOS = Spend+Tax / (Price x Final)`,
          `${n} rows — convention: ${convention} spend` + (tally.zero ? `, ${tally.zero} rows use the Final=0 -> 0 variant` : ""));
      }
      return convention;
    };
    const conv30 = check("[30d]", { price: c.price, st: c.st30, adv: c.adv30, ord: c.ord30, ret: c.ret30, fin: c.fin30, cpc: c.cpc30, acos: c.acos30, tacos: c.tacos30 });
    check("[7d]", { price: c.price, st: c.st7, adv: c.adv7, ord: c.ord7, ret: c.ret7, fin: c.fin7, cpc: c.cpc7, acos: c.acos7, tacos: c.tacos7 });

    // The TACOS sheet is per-SKU by definition. If the Analysis report splits
    // TACOS per campaign row instead, the same SKU carries different TACOS on
    // the two sheets — not arithmetically wrong, but anyone comparing the sheets
    // (or comparing against the hand-built workbook, which is per-SKU) will see
    // a smaller number per row and conclude the report is under-reporting.
    const multiCampaignSkus = (() => {
      const m = new Map();
      dataRows.forEach((r) => m.set(r[c.sku], (m.get(r[c.sku]) ?? 0) + 1));
      return [...m.values()].filter((v) => v > 1).length;
    })();
    if (multiCampaignSkus === 0) {
      info("TACOS grain (Analysis report vs TACOS sheet)", "every SKU has one campaign, so both conventions coincide — nothing to distinguish");
    } else if (conv30 === "per-row") {
      warn("TACOS grain (Analysis report vs TACOS sheet)",
        `Analysis report splits TACOS per campaign row while the TACOS sheet is per-SKU, so the ${multiCampaignSkus} multi-campaign SKUs show different TACOS on the two sheets (the per-row figures sum to the per-SKU one). The hand-built workbook repeats the per-SKU value on every row — expect a mismatch when reconciling against it.`);
    } else {
      pass("TACOS grain (Analysis report vs TACOS sheet)", `both per-SKU across ${multiCampaignSkus} multi-campaign SKUs`);
    }

    // ── 2b. is the 7-day window actually re-scoped? ──
    // THE headline check. A hand-built pivot often copies the 30-day spend
    // column into the 7-day block without re-filtering the dates. Every 7-day
    // CPC/ACOS/TACOS then divides ~30 days of spend by ~7 days of units, which
    // inflates them several-fold and makes the two windows uncomparable.
    // 7-day spend is a subset of 30-day spend, so it can never exceed it, and
    // it being identical on EVERY spending row is not something real data does.
    const spendRows = dataRows.filter((r) => (num(r[c.st30]) ?? 0) > 0 && num(r[c.st7]) !== null);
    const identical = spendRows.filter((r) => near(num(r[c.st30]), num(r[c.st7])));
    const exceeds = spendRows.filter((r) => num(r[c.st7]) > num(r[c.st30]) * (1 + 1e-9));
    if (spendRows.length === 0) {
      warn("7-day window re-scoped", "no rows with non-zero 30-day spend to test");
    } else if (identical.length === spendRows.length) {
      fail("7-day window re-scoped",
        `all ${spendRows.length} rows with spend have 7-day Spend+Tax IDENTICAL to 30-day — the 7-day block was not re-filtered by date. Every 7-day CPC/ACOS/TACOS is inflated.`);
    } else if (identical.length > spendRows.length * 0.5) {
      warn("7-day window re-scoped",
        `${identical.length}/${spendRows.length} rows have 7-day spend equal to 30-day — suspiciously high, check the date filter`);
    } else {
      pass("7-day window re-scoped", `${spendRows.length - identical.length}/${spendRows.length} rows show genuinely lower 7-day spend`);
    }
    if (exceeds.length) fail("7-day spend <= 30-day spend", `${exceeds.length} rows where the 7-day figure exceeds the 30-day one, which is impossible for a subset window`);

    // ── 2c. GRAND TOTAL grain ──
    // The sheet is one row per campaign x SKU, but Total Units / Orders /
    // Returns are SKU-level figures repeated on each of that SKU's campaign
    // rows. So the total must sum those over DISTINCT SKUs; a plain column
    // SUM() double-counts every multi-campaign SKU. Spend+Tax and Advertised
    // Units are genuinely per-row and do sum plainly.
    const skuCount = new Set(dataRows.map((r) => r[c.sku])).size;
    info("Grain", `${dataRows.length} rows over ${skuCount} distinct SKUs (${dataRows.length - skuCount} repeat-SKU rows)`);

    if (gt) {
      const plain = (ci) => dataRows.reduce((s, r) => s + (num(r[ci]) ?? 0), 0);
      const distinct = (ci) => {
        const seen = new Map();
        dataRows.forEach((r) => { const k = r[c.sku]; if (!seen.has(k)) seen.set(k, num(r[ci]) ?? 0) });
        return [...seen.values()].reduce((s, v) => s + v, 0);
      };

      [["Spend+Tax", c.st30, "plain"], ["Advertised Units", c.adv30, "plain"],
       ["Total Units", c.tot30, "distinct"], ["Orders", c.ord30, "distinct"], ["Returns", c.ret30, "distinct"]]
        .forEach(([label, ci, mode]) => {
          const g = num(gt[ci]);
          if (g === null) return;
          const expected = mode === "plain" ? plain(ci) : distinct(ci);
          const other = mode === "plain" ? distinct(ci) : plain(ci);
          if (near(g, expected, 1e-4)) {
            pass(`GRAND TOTAL ${label} (${mode}-sum)`, `${Math.round(g)}`);
          } else if (near(g, other, 1e-4)) {
            fail(`GRAND TOTAL ${label}`, `is a ${mode === "plain" ? "distinct-SKU" : "plain"} sum (${Math.round(g)}) but should be ${mode} (${Math.round(expected)})`);
          } else {
            warn(`GRAND TOTAL ${label}`, `${Math.round(g)} matches neither plain (${Math.round(plain(ci))}) nor distinct-SKU (${Math.round(distinct(ci))})`);
          }
        });
    }

    // ── 2d. negative Final ──
    // Returns are counted by request date, so a return can belong to an order
    // placed before the window and legitimately outnumber in-window orders.
    // That is real, but it makes Final negative while TACOS internally clamps
    // to 0 then substitutes 1 — producing an enormous meaningless percentage.
    const negFinal = dataRows.filter((r) => (num(r[c.fin30]) ?? 0) < 0);
    if (negFinal.length) {
      warn("Negative Final (returns > orders)",
        negFinal.slice(0, 5).map((r) => `${r[c.sku]}: orders ${num(r[c.ord30])} - returns ${num(r[c.ret30])} = ${num(r[c.fin30])}, TACOS reads ${(100 * (num(r[c.tacos30]) ?? 0)).toFixed(0)}%`).join(" | ")
        + (negFinal.length > 5 ? ` … +${negFinal.length - 5} more` : "")
        + " — legitimate data (returns are dated by request, not by original order) but the TACOS shown is an artifact of the clamp-then-substitute-1 fallback");
    } else {
      pass("Negative Final", "none");
    }

    // ── 2e. unmapped SB/SD spend ──
    // SB/SD exports carry no SKU column, so their spend is split across the
    // SKUs mapped to each campaign. Unmapped campaigns are pooled into one row
    // rather than dropped, so their spend still reaches the totals — but it is
    // attributed to nothing and should be cleared down.
    const unmapped = dataRows.filter((r) => String(r[1] ?? "").toLowerCase().includes("unmapped"));
    const unmappedSpend = unmapped.reduce((s, r) => s + (num(r[c.st30]) ?? 0), 0);
    if (unmapped.length) {
      warn("Unmapped SB/SD campaigns", `${unmapped.length} rows holding Rs ${unmappedSpend.toFixed(2)} of 30-day spend attributed to no SKU — map them on the Upload page`);
    } else {
      pass("Unmapped SB/SD campaigns", "none");
    }

    // stash for cross-sheet comparison
    global.__ar = { c, dataRows };
  }
}

// ── 3. TACOS sheet ──────────────────────────────────────────────────────────
// Keyed per SKU, not per campaign x SKU, because it measures a SKU's whole ad
// cost against its whole net order volume. Its CPC is deliberately a DIFFERENT
// metric from the Analysis report's: cost per NET ORDER, not per advertised
// unit. TACOS still lands identically since (S/Final)/Price == S/(Price*Final).
const tc = grid("TACOS");
if (tc && tc.length > 2) {
  const H = tc[1] || [];
  const t = {
    sku: 0, price: nthCol(H, "Price") === -1 ? 1 : nthCol(H, "Price"),
    st30: nthCol(H, "Spend+Tax", 1), ord30: nthCol(H, "Orders", 1), ret30: nthCol(H, "Returns", 1),
    fin30: nthCol(H, "Final orders", 1), cpc30: nthCol(H, "CPC", 1), tacos30: nthCol(H, "TACOS", 1),
    st7: nthCol(H, "Spend+Tax", 2),
  };
  if (t.st30 === -1 || t.cpc30 === -1) {
    warn("TACOS sheet columns", "could not locate Spend+Tax / CPC headers; skipped");
  } else {
    const rows = tc.slice(2).filter((r) => r && String(r[0] ?? "").trim() !== "" && num(r[t.st30]) !== null);
    let n = 0; const badCpc = [], badTacos = [];
    rows.forEach((r, i) => {
      const price = num(r[t.price]) ?? 0, st = num(r[t.st30]), fin = num(r[t.fin30]) ?? 0;
      const cpc = num(r[t.cpc30]), tacos = num(r[t.tacos30]);
      if (st === null) return;
      n++;
      const expCpc = st / (fin || 1);
      if (cpc !== null && !near(cpc, expCpc)) badCpc.push(`row ${i + 3} ${r[0]}`);
      const expTacos = price > 0 ? expCpc / price : 0;
      if (tacos !== null && !near(tacos, expTacos)) badTacos.push(`row ${i + 3} ${r[0]}`);
    });
    if (badCpc.length) fail("[TACOS sheet] CPC = Spend+Tax / Final orders", `${badCpc.length} rows off: ${badCpc.slice(0, 3).join(", ")}`);
    else pass("[TACOS sheet] CPC = Spend+Tax / Final orders", `${n} rows (cost per net order — intentionally different from the Analysis report's CPC)`);
    if (badTacos.length) fail("[TACOS sheet] TACOS = CPC / Price", `${badTacos.length} rows off: ${badTacos.slice(0, 3).join(", ")}`);
    else pass("[TACOS sheet] TACOS = CPC / Price", `${n} rows`);

    // ── 3a. cross-sheet agreement on 7-day spend ──
    // Both sheets derive 7-day spend from the same source, so a per-SKU
    // disagreement means one of the two blocks was built from a different date
    // filter. This is what exposes a stale copied column even when each sheet
    // looks internally consistent.
    if (global.__ar && t.st7 !== -1) {
      const { c, dataRows } = global.__ar;
      const arBySku = new Map();
      dataRows.forEach((r) => {
        const k = r[c.sku];
        const cur = arBySku.get(k) || { s30: 0, s7: 0 };
        cur.s30 += num(r[c.st30]) ?? 0; cur.s7 += num(r[c.st7]) ?? 0;
        arBySku.set(k, cur);
      });
      const disagree = [];
      rows.forEach((r) => {
        const k = String(r[0]).trim(), a = arBySku.get(k);
        const s7 = num(r[t.st7]);
        if (!a || s7 === null || a.s30 <= 0) return;
        if (!near(a.s7, s7, 1e-4)) disagree.push(`${k}: Analysis ${a.s7.toFixed(2)} vs TACOS ${s7.toFixed(2)}`);
      });
      if (disagree.length) {
        fail("7-day spend agrees across Analysis report and TACOS sheets",
          `${disagree.length} SKUs disagree — the two sheets used different date filters. ${disagree.slice(0, 4).join(" | ")}`);
      } else {
        pass("7-day spend agrees across Analysis report and TACOS sheets", "per-SKU totals match");
      }
    }
  }
}

// ── 3b. formula columns that vanished on write ───────────────────────────────
// xlsx-js-style DROPS a formula cell that carries no cached value, so a column
// written as `{t,f}` with no `v` disappears from the file entirely — headers
// present, every data cell missing. It looks like a data problem and isn't. Any
// computed column that is 100% empty while its neighbours are populated is the
// signature, so check the columns that have actually been lost this way.
{
  const suspects = [
    { sheet: "FBA status", cols: ["Available", "Number of FBA Not Available", "All FBA"], headerRow: 0 },
  ];
  for (const { sheet, cols, headerRow } of suspects) {
    const g = grid(sheet);
    if (!g || g.length < headerRow + 2) continue;
    const H = g[headerRow] || [];
    const body = g.slice(headerRow + 1).filter((r) => r && String(r[0] ?? "").trim() !== "");
    if (!body.length) continue;
    const empty = [];
    for (const name of cols) {
      const i = H.indexOf(name);
      if (i === -1) continue;
      const filled = body.filter((r) => { const v = r[i]; return !(v === undefined || v === null || v === "") }).length;
      if (filled === 0) empty.push(name);
    }
    if (empty.length) {
      fail(`[${sheet}] computed columns populated`,
        `${empty.join(", ")} — every data cell is empty across all ${body.length} rows. These are written as Excel formulas; xlsx-js-style silently drops a formula cell with no cached value, so the fix is to write a computed \`v\` alongside the \`f\`, not to change the formula.`);
    } else {
      pass(`[${sheet}] computed columns populated`, `${cols.filter((n) => H.indexOf(n) !== -1).join(", ")} over ${body.length} rows`);
    }
  }
}

// ── 4. Key Insights state analysis (generated reports only) ─────────────────
// Stock is bucketed by FBA fulfilment-centre label while orders are bucketed by
// customer ship-to state. Several FC labels are CITY names (BANGALORE, HYDERABAD,
// LUCKNOW, JAIPUR) and some are bare FC codes (VSNC), so they never join to the
// state names orders carry (KARNATAKA, TELANGANA, UTTAR PRADESH, RAJASTHAN).
// The result is a mirror-image lie: every FC city reads "Overstocked, no orders"
// and its real state reads "Stockout risk, no stock".
const ki = grid("Key Insights");
if (ki) {
  const CITY_TO_STATE = { BANGALORE: "KARNATAKA", HYDERABAD: "TELANGANA", LUCKNOW: "UTTAR PRADESH", JAIPUR: "RAJASTHAN", DELHI: null };
  const rows = ki.map((r) => (r || []).map((v) => v));
  const header = rows.findIndex((r) => String(r[0] ?? "").trim() === "State");
  if (header === -1) {
    info("Key Insights state table", "not present");
  } else {
    const states = [];
    for (let i = header + 1; i < rows.length; i++) {
      const name = String(rows[i][0] ?? "").trim();
      if (!name || name.startsWith("🧭") || name.startsWith("🚀") || name.startsWith("💡")) break;
      states.push({ name, stock: num(rows[i][1]) ?? 0, value: num(rows[i][2]) ?? 0, orders: num(rows[i][4]) ?? 0 });
    }
    const byName = new Map(states.map((s) => [s.name, s]));
    const clashes = [];
    Object.entries(CITY_TO_STATE).forEach(([city, st]) => {
      if (!st) return;
      const c = byName.get(city), s = byName.get(st);
      if (c && s && c.stock > 0 && c.orders === 0 && s.stock === 0 && s.orders > 0) {
        clashes.push(`${city} (${c.stock}u stock, 0 orders) vs ${st} (0 stock, ${s.orders} orders)`);
      }
    });
    const strandedFc = states.filter((s) => /^[A-Z]{4}\d?$/.test(s.name) && s.stock > 0);
    if (clashes.length) {
      fail("Key Insights: stock and orders bucketed the same way",
        `FC-city stock never joins its real state — ${clashes.join(" | ")}. Verdicts and the REPLENISH/Priority lists derived from this are false.`);
    } else {
      pass("Key Insights: stock and orders bucketed the same way", "no city-vs-state mirror pairs found");
    }
    if (strandedFc.length) {
      warn("Unmapped FC codes in state analysis",
        strandedFc.map((s) => `${s.name} (${s.stock}u, Rs ${Math.round(s.value)})`).join(", ") + " — not in FC_STATE_MAP, so this stock belongs to no state");
    }

    // Duplicate / abbreviated ship_state values fragment order counts, which
    // pushes small slivers of demand into their own bogus "stockout" rows.
    const ABBR = { TN: "TAMIL NADU", TAMILNADU: "TAMIL NADU", WB: "WEST BENGAL", WESTBENGAL: "WEST BENGAL", UP: "UTTAR PRADESH", "U.P.": "UTTAR PRADESH", TG: "TELANGANA", TELENGANA: "TELANGANA", DL: "DELHI", MP: "MADHYA PRADESH", BR: "BIHAR", MH: "MAHARASHTRA", PB: "PUNJAB", RJ: "RAJASTHAN", HP: "HIMACHAL PRADESH", AR: "ARUNACHAL PRADESH", HARAYANA: "HARYANA", CHATTISGARH: "CHHATTISGARH", ANDHRAPRADESH: "ANDHRA PRADESH", "JAMMU AND KASHMIR": "JAMMU & KASHMIR" };
    const dupes = states.filter((s) => ABBR[s.name]);
    if (dupes.length) {
      const units = dupes.reduce((a, s) => a + s.orders, 0);
      warn("Duplicate / abbreviated state names",
        `${dupes.length} rows (${dupes.map((d) => d.name).join(", ")}) carrying ${units} order units that belong to their canonical states — normalise ship_state before bucketing`);
    } else {
      pass("Duplicate / abbreviated state names", "none");
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const ICON = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌", INFO: "ℹ️ " };
const order = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3 };
console.log(`\nAudit — ${path.basename(file)}\n${"=".repeat(76)}`);
results.sort((a, b) => order[a.level] - order[b.level]);
for (const r of results) {
  console.log(`${ICON[r.level]} ${r.check}`);
  if (r.detail) console.log(`     ${r.detail}`);
}
const counts = results.reduce((m, r) => ((m[r.level] = (m[r.level] || 0) + 1), m), {});
console.log(`${"=".repeat(76)}`);
console.log(`${counts.FAIL || 0} failed · ${counts.WARN || 0} warnings · ${counts.PASS || 0} passed\n`);
process.exit((counts.FAIL || 0) > 0 ? 1 : 0);
