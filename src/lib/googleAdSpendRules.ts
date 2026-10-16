// Pure rules for the Google Ads spend upload — kept dependency-free so they can be unit tested
// directly. googleOrdersUpload.ts reads the workbook and saves the rows these produce.
//
// Google Ads' "Campaign report" export (Reports → Campaigns → download .xlsx) looks like:
//
//   Campaign report
//   October 15, 2026 - October 15, 2026          <- the reporting window (one day or a range)
//   Network (with search partners) | Campaign status | Campaign | ... | Cost | Conversions | ...
//   Google Search   | Enabled | bulb-insemination-shopping-oct 15 | ... | 87.95 | ...
//   Search partners | Enabled | bulb-insemination-shopping-oct 15 | ... | 38.57 | ...
//   ...
//    --             | Total: Campaigns | --  | ... | 126.52
//                   | Total: Account   |     | ... | 126.52
//
// One campaign is split across one line per network (Google Search, Search partners, YouTube …),
// and every network line is its own slice of the spend, so a campaign's spend is the SUM of its
// lines. Every "Total: …" line (Total: Campaigns / Account / Shopping / Search …, with or without a
// network) is a roll-up of the lines above it and is never stored — keeping it would double the
// spend. The blank-network "Total: Account" line is used only as a check: the stored campaigns
// must add up to it.

export interface GoogleAdSpendCampaign {
  campaign_name: string;
  spend: number;
  clicks: number;
  conversions: number;
  conv_value: number;
  currency: string;
  /** The campaign's own per-network lines, as read (for the raw jsonb column). */
  lines: Record<string, unknown>[];
}

export interface GoogleAdSpendSheet {
  report_start: string;
  report_end: string;
  campaigns: GoogleAdSpendCampaign[];
  /** Cost on the blank-network "Total: Account" line, or null when the export has none. */
  accountTotal: number | null;
  /** Sum of the campaigns' spend — must equal accountTotal when that line exists. */
  campaignTotal: number;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = str(v).replace(/[^0-9.eE+-]/g, "");
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: unknown) => str(s).replace(/\s+/g, " ").toLowerCase();
/** Google writes an empty cell as " --". */
const isBlank = (v: unknown) => { const s = str(v); return s === "" || s === "--"; };

function monthDayYear(s: string): string | null {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  return mon ? `${m[3]}-${mon}-${m[2].padStart(2, "0")}` : null;
}

/** "October 15, 2026 - October 15, 2026" / "Oct 9, 2026 – Oct 15, 2026" → [start, end]. */
export function parseGoogleReportWindow(text: string): [string, string] | null {
  const parts = text.split(/\s+[-–—]\s+/);
  if (parts.length !== 2) return null;
  const start = monthDayYear(parts[0]);
  const end = monthDayYear(parts[1]);
  if (!start || !end || start > end) return null;
  return [start, end];
}

/** Index of the header row (has both a "Campaign" and a "Cost" cell), or -1. */
export function findGoogleAdSpendHeader(aoa: unknown[][]): number {
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const cells = (aoa[i] || []).map(norm);
    if (cells.includes("campaign") && cells.includes("cost")) return i;
  }
  return -1;
}

/** True when the sheet is a Google Ads campaign report (not a B-Arm orders sheet). */
export function isGoogleAdSpendSheet(aoa: unknown[][]): boolean {
  return findGoogleAdSpendHeader(aoa) >= 0;
}

/** Parses one sheet. Throws with a readable message when it is a campaign report that can't be
 *  saved as-is (no date window line), so nothing half-read is stored. */
export function parseGoogleAdSpendSheet(aoa: unknown[][]): GoogleAdSpendSheet {
  const headerIdx = findGoogleAdSpendHeader(aoa);
  if (headerIdx < 0) throw new Error("No \"Campaign\" + \"Cost\" header row found.");

  let window: [string, string] | null = null;
  for (let i = 0; i < headerIdx && !window; i++) {
    for (const cell of aoa[i] || []) {
      window = parseGoogleReportWindow(str(cell));
      if (window) break;
    }
  }
  if (!window) throw new Error("No reporting date line (e.g. \"October 15, 2026 - October 15, 2026\") above the header — download the report again with its title rows.");

  const headers = (aoa[headerIdx] || []).map((h) => str(h));
  const col = (...names: string[]) => {
    const wanted = names.map((n) => n.toLowerCase());
    return headers.findIndex((h) => wanted.includes(norm(h)));
  };
  const cCampaign = col("Campaign");
  const cStatus = col("Campaign status");
  const cCost = col("Cost");
  const cClicks = col("Clicks");
  const cConv = col("Conversions");
  const cConvValue = col("Conv. value", "Conversion value");
  const cCurrency = col("Currency code", "Currency");
  const cNetwork = headers.findIndex((h) => norm(h).startsWith("network"));
  const at = (cells: unknown[], c: number) => (c >= 0 ? cells[c] : "");

  const byCampaign = new Map<string, GoogleAdSpendCampaign>();
  let accountTotal: number | null = null;
  for (const cells of aoa.slice(headerIdx + 1)) {
    if (!cells || cells.every((c) => str(c) === "")) continue;
    const status = str(at(cells, cStatus));
    if (/^total:/i.test(status) || /^total:/i.test(str(at(cells, cCampaign)))) {
      if (/^total:\s*account$/i.test(status) && isBlank(at(cells, cNetwork))) accountTotal = round2(num(at(cells, cCost)));
      continue;
    }
    const name = str(at(cells, cCampaign)).replace(/\s+/g, " ");
    if (isBlank(name)) continue;
    const key = name.toLowerCase();
    const line: Record<string, unknown> = {};
    headers.forEach((h, i) => { if (h) line[h] = cells[i] ?? ""; });
    const acc = byCampaign.get(key) ?? {
      campaign_name: name, spend: 0, clicks: 0, conversions: 0, conv_value: 0,
      currency: isBlank(at(cells, cCurrency)) ? "INR" : str(at(cells, cCurrency)), lines: [],
    };
    acc.spend = round2(acc.spend + num(at(cells, cCost)));
    acc.clicks += Math.round(num(at(cells, cClicks)));
    acc.conversions = round2(acc.conversions + num(at(cells, cConv)));
    acc.conv_value = round2(acc.conv_value + num(at(cells, cConvValue)));
    acc.lines.push(line);
    byCampaign.set(key, acc);
  }
  const campaigns = [...byCampaign.values()];
  return {
    report_start: window[0],
    report_end: window[1],
    campaigns,
    accountTotal,
    campaignTotal: round2(campaigns.reduce((s, c) => s + c.spend, 0)),
  };
}
