// FC Forecast tab (2026-11-20) — pure rules shared by the page and the xlsx export. The numbers themselves
// come from the SQL function fc_forecast(); minStock() mirrors its rule for display checks and tests.
// Rule (client's FC forecast sheet): min stock = MAX(ROUND(MAX(peak of 3 blocks, last 30 days) x 1.5), 5).
// Windows (user, 2026-11-20): rolling, up to yesterday — B1 = as_of−29…as_of, B2 = −59…−30, B3 = −89…−60.

export type FcRow = {
  product: string;
  block1: number; block2: number; block3: number;
  peak: number; last30: number; max_units: number; min_stock: number;
  ch_amazon: number; ch_flipkart: number; ch_meesho: number; ch_website: number; ch_sellerflex: number;
  b1_from: string; b1_to: string; b2_from: string; b2_to: string; b3_from: string; b3_to: string;
};
export type FcUnmapped = { sku: string; channel: string; units_90d: number; sample_title: string | null };
export type FcSourceDate = { channel: string; source: string; max_day: string | null };

export const FC_CHANNELS = ["amazon", "flipkart", "meesho", "website", "sellerflex"] as const;
export const FC_CHANNEL_LABEL: Record<string, string> = {
  amazon: "Amazon", flipkart: "Flipkart", meesho: "Meesho", website: "Website", sellerflex: "Seller Flex",
};

const IST_OFFSET_MS = 330 * 60 * 1000;

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Yesterday's date in India (YYYY-MM-DD). */
export function yesterdayIst(now: Date = new Date()): string {
  return addDays(new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10), -1);
}

export function blocks(asOf: string): { b1: [string, string]; b2: [string, string]; b3: [string, string] } {
  return {
    b1: [addDays(asOf, -29), asOf],
    b2: [addDays(asOf, -59), addDays(asOf, -30)],
    b3: [addDays(asOf, -89), addDays(asOf, -60)],
  };
}

/** MAX(ROUND(units x 1.5), 5), rounding half up like Excel/Postgres numeric round(). */
export function minStock(maxUnits: number): number {
  return Math.max(Math.floor(maxUnits * 1.5 + 0.5), 5);
}

/** Channels whose newest data (newest of their sources) is before asOf, or that have no data. */
export function staleChannels(dates: FcSourceDate[], asOf: string): string[] {
  const newest = new Map<string, string | null>();
  for (const d of dates) {
    const prev = newest.get(d.channel);
    if (prev === undefined || (d.max_day && (!prev || d.max_day > prev))) newest.set(d.channel, d.max_day ?? prev ?? null);
  }
  return [...newest].filter(([, day]) => !day || day < asOf).map(([ch]) => ch);
}

export function fcFileName(asOf: string): string {
  const [y, m, d] = asOf.split("-");
  return `FC forecast sheet on ${d}-${m}-${y}.xlsx`;
}

/** "21 Oct – 19 Nov" style label for a block header. */
export function rangeLabel([from, to]: [string, string]): string {
  const f = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(from)} – ${f(to)}`;
}

/** Unmapped-SKU KPI: a failed load shows "–" and never reads as "all mapped" (review fix, 2026-11-20). */
export function unmappedKpi(items: FcUnmapped[] | undefined, failed: boolean): { value: string; ok: boolean } {
  if (failed || !items) return { value: "–", ok: false };
  return { value: String(items.length), ok: items.length === 0 };
}

/** Banner text for the data-up-to line, or null when every channel is current. */
export function sourceCheckNotice(failed: boolean, stale: string[]): string | null {
  if (failed) return "Couldn't check how recent each channel's data is, so a stale source would not be flagged. Reload the page before trusting the last 30 days.";
  if (!stale.length) return null;
  const names = stale.map((c) => FC_CHANNEL_LABEL[c] ?? c).join(", ");
  return `${names} ${stale.length === 1 ? "has" : "have"} no data after the date shown above, so the last 30 days read low for ${stale.length === 1 ? "it" : "them"}. Upload the latest file or pick an earlier as-of date.`;
}
