// Pure rules for writing the "AM ord" sheet of the combined "Last 7 days" upload
// (combinedAdSpendUpload.ts) — kept dependency-free so they can be unit tested directly.
//
// Amazon's "purchase-date" is a UTC timestamp ("2026-09-15T18:30:42+00:00"), but the seller's
// file covers IST days: its first rows (00:00-05:29 IST) carry the PREVIOUS UTC date. Storing the
// UTC date as report_date, then clearing report_date min..max before inserting, deleted the
// previous upload's rows for that earlier day and put back only the ~25 early-morning orders the
// new file carries for it — 16 of 35 days since 20 Aug 2026 were left with 17-34 rows instead of
// ~230-350. report_date is now the IST business day, and rows are replaced per order rather than
// per date range, so an upload can only ever replace orders it actually contains.

const IST_OFFSET_MINUTES = 330;

/** IST calendar day ("YYYY-MM-DD") of a timestamp that carries its own UTC offset or "Z".
 *  Returns null for anything else (bare dates, Excel serials, blanks), so the caller can fall back
 *  to its existing date parsing — those carry no time of day to shift. */
export function amazonPurchaseIstDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const ms = Date.parse(s.replace(" ", "T"));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** Collapses rows sharing an identity (Amazon's order-item-id), keeping the LAST occurrence —
 *  an order export that repeats a line must not double-count it. Rows with a blank identity are
 *  all kept, since there is nothing to match them on. */
export function dedupeByIdentity<T>(rows: T[], identityOf: (r: T) => string): T[] {
  const byKey = new Map<string, T>();
  const unkeyed: T[] = [];
  for (const r of rows) {
    const k = identityOf(r);
    if (k) byKey.set(k, r);
    else unkeyed.push(r);
  }
  return [...byKey.values(), ...unkeyed];
}

/** Distinct non-blank values of `column` — the set of orders an upload replaces. */
export function replaceKeyValues(rows: Record<string, unknown>[], column: string): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const v = String(r[column] ?? "").trim();
    if (v) out.add(v);
  }
  return [...out];
}

/** What one upload does to the table: delete every existing row whose `keyCol` is in deleteKeys,
 *  then insert insertRows. Rows of orders the file doesn't contain are never touched, and applying
 *  the same plan twice leaves the table unchanged (idempotent). */
export function planReplaceByKey(
  rows: Record<string, unknown>[],
  keyCol: string,
  identityOf?: (r: Record<string, unknown>) => string
): { deleteKeys: string[]; insertRows: Record<string, unknown>[] } {
  const insertRows = identityOf ? dedupeByIdentity(rows, identityOf) : rows;
  return { deleteKeys: replaceKeyValues(insertRows, keyCol), insertRows };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
