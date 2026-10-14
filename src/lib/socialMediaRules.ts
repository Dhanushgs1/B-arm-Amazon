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
}

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
    if (hit) hit.spend = Math.round((hit.spend + r.spend) * 100) / 100;
    else sheet.set(key, { ...r, campaign_name: name });
  }
  const out = new Map<string, T>();
  bySheet.forEach((sheet) => sheet.forEach((r, key) => {
    const prev = out.get(key);
    // Keep the first spelling of the name, take the later sheet's figure.
    out.set(key, prev ? { ...r, campaign_name: prev.campaign_name } : r);
  }));
  return [...out.values()];
}
