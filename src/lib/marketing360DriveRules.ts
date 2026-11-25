// Product Marketing 360 — which Drive files the daily auto-import loads (pure rules, tested in
// marketing360DriveRules.test.ts; the Drive calls live in src/lib/server/marketing360DriveSync.ts).
//
// The import reads Drive with a Google service account (user, 2026-11-25), so it only sees files and
// folders shared with that account's e-mail. Each source picks the newest matching file; a file is
// imported again only when Drive says it changed (modifiedTime) since the last import.

export type DriveFile = { id: string; name: string; mimeType: string; modifiedTime: string };

export type DriveSource = {
  key: string;
  label: string;
  /** Drive search text (name contains …) — narrows the listing; `match` decides. */
  nameContains: string;
  /** The exact name shape to accept (skips copies like "(compact reduced)"). */
  match: RegExp;
  /** "newest" = only the newest matching file; "all" = every matching file (one tracker per category). */
  take: "newest" | "all";
};

export const DRIVE_SOURCES: DriveSource[] = [
  { key: "delivery", label: "Delivery sweep", nameContains: "Sweep_NoRating", match: /Sweep_NoRating/i, take: "newest" },
  { key: "positions", label: "Competitor position trackers", nameContains: "Competitor_Position_Tracker", match: /^BARM_.*Competitor_Position_Tracker$/i, take: "all" },
  { key: "rating", label: "AM FK rating & review", nameContains: "AM FK Rating and Review", match: /^AM FK Rating and Review - \d{1,2} [A-Za-z]{3,9} \d{4}(\.xlsx)?$/i, take: "newest" },
  { key: "forecast", label: "FBA forecast", nameContains: "FBA Forecasting", match: /^FBA Forecasting \d{4}-\d{2}-\d{2}(\.xlsx)?$/i, take: "newest" },
];

/** The files of one source to consider, newest first. */
export function pickFiles(source: DriveSource, files: DriveFile[]): DriveFile[] {
  const ok = files.filter((f) => source.match.test(f.name.trim())).sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  return source.take === "newest" ? ok.slice(0, 1) : ok;
}

/** True when Drive's copy changed since we last imported it (or we never did). */
export function needsImport(file: DriveFile, lastImported: Record<string, string>): boolean {
  const seen = lastImported[file.id];
  return !seen || file.modifiedTime > seen;
}

/** Google Sheets are exported as .xlsx; uploaded .xlsx files are downloaded as they are. */
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export function downloadPath(f: DriveFile): string {
  const id = encodeURIComponent(f.id);
  return f.mimeType === SHEET_MIME
    ? `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
    : `/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
}

/** File name the importer reads its date from — a Sheet export has no extension, so add one. */
export function importName(f: DriveFile): string {
  return /\.xlsx$/i.test(f.name) ? f.name : `${f.name}.xlsx`;
}

/** Drive search query for one source (names containing a quote are escaped). */
export function driveQuery(source: DriveSource): string {
  return `name contains '${source.nameContains.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false and (mimeType = '${SHEET_MIME}' or mimeType = '${XLSX_MIME}')`;
}
