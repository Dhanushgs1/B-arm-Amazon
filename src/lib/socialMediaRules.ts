// Pure rules for the Meta (Social Media) ad-spend upload — kept dependency-free so they can be unit
// tested directly. socialMediaReportUpload.ts reads the workbook and saves the rows these produce.
//
// Same rule as the B-Arm Google orders: one campaign on two lines of the same sheet and window
// (e.g. split by ad set / placement, or typed twice) is one campaign whose spend ADDS UP — never
// "last line wins". Campaign names match ignoring case and extra spaces. A campaign repeated in a
// DIFFERENT sheet for the same window is the same figure copied (the seller keeps a single-day sheet
// beside a 7-day sheet), so the later sheet replaces it instead of doubling it.

export function metaCampaignKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface MetaRowLike {
  sheet: string;
  report_start: string | null;
  report_end: string | null;
  campaign_name: string;
  spend: number;
  /** Link clicks when the export has a clicks column, else null. Added up like spend. */
  clicks?: number | null;
  /** Meta-reported purchase value / purchases when the export has those columns, else null. Added up like spend. */
  metaValue?: number | null;
  metaPurchases?: number | null;
}

// Ad-level exports (25 Nov 2026, seller's request: each Meta ad's spend, sales and ACOS). A row of an
// export downloaded at Ad level is saved as "<campaign> :: <ad>" in the same table, so the report
// (adSpendReportExport.ts, metaCampaignPart) groups the ads of a product and still finds the
// campaign's product. Must match META_AD_SEPARATOR there and in the generate-ad-spend-report Edge Function.
export const META_AD_SEPARATOR = " :: ";

export function metaRowName(campaign: string, ad: string): string {
  const c = campaign.replace(/\s+/g, " ").trim();
  const a = ad.replace(/\s+/g, " ").trim();
  return c && a ? `${c}${META_AD_SEPARATOR}${a}` : c;
}

export function metaCampaignPart(name: string): string {
  const i = name.indexOf(META_AD_SEPARATOR);
  return i >= 0 ? name.slice(0, i) : name;
}

interface MetaSavedRow { report_start: string | null; report_end: string | null; campaign_name: string }

/** Ids of saved rows an upload replaces: for every window + campaign in the upload, the saved rows of
 *  that same window + campaign that the upload does not write again — the campaign total when ads are
 *  uploaded, the ads when the campaign total is uploaded, and ads no longer in the export. Without this
 *  a campaign uploaded once at campaign level and once at ad level would count its spend twice. */
export function metaRowsToReplace<T extends MetaSavedRow & { id: number | string }>(saved: T[], incoming: MetaSavedRow[]): (number | string)[] {
  const windowCampaign = (r: MetaSavedRow) => `${r.report_start}|${r.report_end}|${metaCampaignKey(metaCampaignPart(r.campaign_name))}`;
  const exact = (r: MetaSavedRow) => `${r.report_start}|${r.report_end}|${metaCampaignKey(r.campaign_name)}`;
  const touched = new Set(incoming.map(windowCampaign));
  const kept = new Set(incoming.map(exact));
  return saved.filter((r) => touched.has(windowCampaign(r)) && !kept.has(exact(r))).map((r) => r.id);
}

const addOrNull = (a: number | null | undefined, b: number | null | undefined) =>
  a == null && b == null ? null : Math.round(((a ?? 0) + (b ?? 0)) * 100) / 100;

/** Valid rows (campaign + both dates) merged to one row per window + campaign. The saved name is
 *  the first spelling seen (spaces collapsed), so re-uploading the same file keeps the same key. */
export function mergeMetaRows<T extends MetaRowLike>(rows: T[]): T[] {
  const bySheet = new Map<string, Map<string, T>>();
  for (const r of rows) {
    const name = r.campaign_name.replace(/\s+/g, " ").trim();
    if (!name || !r.report_start || !r.report_end) continue;
    const key = `${r.report_start}|${r.report_end}|${metaCampaignKey(name)}`;
    const sheet = bySheet.get(r.sheet) ?? new Map<string, T>();
    bySheet.set(r.sheet, sheet);
    const hit = sheet.get(key);
    if (hit) {
      hit.spend = Math.round((hit.spend + r.spend) * 100) / 100;
      if (hit.clicks != null || r.clicks != null) hit.clicks = (hit.clicks ?? 0) + (r.clicks ?? 0);
      if (hit.metaValue != null || r.metaValue != null) hit.metaValue = addOrNull(hit.metaValue, r.metaValue);
      if (hit.metaPurchases != null || r.metaPurchases != null) hit.metaPurchases = addOrNull(hit.metaPurchases, r.metaPurchases);
    } else sheet.set(key, { ...r, campaign_name: name });
  }
  const out = new Map<string, T>();
  bySheet.forEach((sheet) => sheet.forEach((r, key) => {
    const prev = out.get(key);
    // Keep the first spelling of the name, take the later sheet's figure.
    out.set(key, prev ? { ...r, campaign_name: prev.campaign_name } : r);
  }));
  return [...out.values()];
}
