// Per-day ad spend for any date range, from the uploaded Google Ads / Meta (social media) campaign
// reports (barm_daily_google_ad_spend, barm_daily_social_media). Dependency-free so it can be unit
// tested.
//
// Each upload is one reporting window (report_start..report_end): the seller loads a 1-day and a
// 7-day report every day, so windows overlap and adding every row up would count the same day's
// spend several times. Instead:
//   1. A day with a 1-day report takes that report (a campaign missing from it spent 0 that day).
//   2. A day without one is worked out exactly when a multi-day report covers it and every other day
//      of that report is already known: day = window total − the known days (per campaign). This is
//      repeated until nothing more can be worked out.
//   3. Any other day is "not available" — never guessed. Callers show the coverage.
// The same window loaded twice keeps only its latest load per campaign. Campaign names are matched
// ignoring case and spacing (same as the uploads and the Ad Spend Report).

export interface AdSpendRow {
  report_start: string;
  report_end: string;
  campaign_name: string | null;
  spend: number | string | null;
  clicks?: number | string | null;
  created_at?: string | null;
}

export type SpendSource = "daily" | "derived" | null;

export interface DailySpend {
  date: string;
  spend: number | null;
  clicks: number | null;
  source: SpendSource;
}

export interface CampaignSpend {
  name: string;
  spend: number;
  clicks: number;
}

export interface ResolvedSpend {
  days: DailySpend[];
  campaigns: CampaignSpend[];
  coveredDays: number;
  totalDays: number;
  spend: number;
  clicks: number;
}

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const keyOf = (name: unknown) => String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const displayOf = (name: unknown) => String(name ?? "").replace(/\s+/g, " ").trim() || "(unnamed campaign)";
const addDays = (iso: string, k: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (start: string, end: string) => {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 3700; d = addDays(d, 1)) out.push(d);
  return out;
};

type Vals = { spend: number; clicks: number };

export function resolveDailySpend(rows: AdSpendRow[], start: string, end: string): ResolvedSpend {
  // latest load per (window, campaign)
  const latest = new Map<string, AdSpendRow>();
  rows.forEach((r) => {
    if (!r.report_start || !r.report_end || r.report_end < r.report_start) return;
    const k = `${r.report_start}|${r.report_end}|${keyOf(r.campaign_name)}`;
    const prev = latest.get(k);
    if (!prev || String(r.created_at ?? "") >= String(prev.created_at ?? "")) latest.set(k, r);
  });

  const names = new Map<string, string>();
  const windows = new Map<string, { start: string; end: string; byCampaign: Map<string, Vals> }>();
  latest.forEach((r) => {
    const w = `${r.report_start}|${r.report_end}`;
    const win = windows.get(w) ?? { start: r.report_start, end: r.report_end, byCampaign: new Map<string, Vals>() };
    const ck = keyOf(r.campaign_name);
    if (!names.has(ck)) names.set(ck, displayOf(r.campaign_name));
    const v = win.byCampaign.get(ck) ?? { spend: 0, clicks: 0 };
    v.spend += n(r.spend);
    v.clicks += n(r.clicks);
    win.byCampaign.set(ck, v);
    windows.set(w, win);
  });

  // day -> campaign -> values, and how each day became known
  const known = new Map<string, Map<string, Vals>>();
  const how = new Map<string, "daily" | "derived">();
  windows.forEach((w) => {
    if (w.start !== w.end) return;
    known.set(w.start, new Map(w.byCampaign));
    how.set(w.start, "daily");
  });

  const multi = [...windows.values()].filter((w) => w.start !== w.end);
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of multi) {
      const span = daysBetween(w.start, w.end);
      const unknown = span.filter((d) => !known.has(d));
      if (unknown.length !== 1) continue;
      const day = unknown[0];
      const vals = new Map<string, Vals>();
      const campaigns = new Set<string>([...w.byCampaign.keys()]);
      span.forEach((d) => known.get(d)?.forEach((_, ck) => campaigns.add(ck)));
      campaigns.forEach((ck) => {
        const total = w.byCampaign.get(ck) ?? { spend: 0, clicks: 0 };
        let spend = total.spend;
        let clicks = total.clicks;
        span.forEach((d) => {
          if (d === day) return;
          const v = known.get(d)!.get(ck);
          if (v) { spend -= v.spend; clicks -= v.clicks; }
        });
        // rounding in the exports can leave a few paise either way
        spend = Math.round(spend * 100) / 100;
        clicks = Math.round(clicks);
        if (spend > 0.005 || clicks > 0) vals.set(ck, { spend: Math.max(0, spend), clicks: Math.max(0, clicks) });
      });
      known.set(day, vals);
      how.set(day, "derived");
      changed = true;
    }
  }

  const campaignTotals = new Map<string, Vals>();
  const days: DailySpend[] = daysBetween(start, end).map((date) => {
    const v = known.get(date);
    if (!v) return { date, spend: null, clicks: null, source: null };
    let spend = 0;
    let clicks = 0;
    v.forEach((x, ck) => {
      spend += x.spend;
      clicks += x.clicks;
      const t = campaignTotals.get(ck) ?? { spend: 0, clicks: 0 };
      t.spend += x.spend;
      t.clicks += x.clicks;
      campaignTotals.set(ck, t);
    });
    return { date, spend: Math.round(spend * 100) / 100, clicks: Math.round(clicks), source: how.get(date) ?? null };
  });

  const covered = days.filter((d) => d.source);
  return {
    days,
    campaigns: [...campaignTotals.entries()]
      .map(([ck, v]) => ({ name: names.get(ck) ?? ck, spend: Math.round(v.spend * 100) / 100, clicks: Math.round(v.clicks) }))
      .filter((c) => c.spend > 0 || c.clicks > 0)
      .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name)),
    coveredDays: covered.length,
    totalDays: days.length,
    spend: Math.round(covered.reduce((t, d) => t + (d.spend ?? 0), 0) * 100) / 100,
    clicks: covered.reduce((t, d) => t + (d.clicks ?? 0), 0),
  };
}
