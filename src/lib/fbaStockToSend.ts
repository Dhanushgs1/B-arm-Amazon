// Pure rules for the FBA page's "X values" panel — column X of the manual
// FBA analysis sheet ("Stock present per SKU ID for FBA - booked"), the
// stock ready to send, kept as ONE value per SKU in
// barm_fba_sku_stock_to_send and applied to all of that SKU's zones. No
// Supabase imports, so these can be unit tested with plain `node --test`.

/** Warn before Generate once the last X save is older than this. */
export const X_STALE_DAYS = 7;

export type StockToSendParse = { ok: true; value: number | null } | { ok: false; error: string };

/** Blank means "no stock to send" (null, which the report treats as 0).
 *  Otherwise a whole, non-negative number; thousands commas are allowed. */
export function parseStockToSendInput(text: string): StockToSendParse {
  const s = text.trim().replace(/,/g, "");
  if (s === "") return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: "Enter a whole number (0 or more), or leave it blank" };
  return { ok: true, value: Number(s) };
}

/** The SKUs whose edited value differs from what's saved, ready to save. */
export function changedStockToSend(
  saved: Map<string, number | null>,
  edits: Map<string, number | null>
): Array<{ sku: string; stock_to_send: number | null }> {
  const out: Array<{ sku: string; stock_to_send: number | null }> = [];
  for (const [sku, value] of edits) {
    if ((saved.get(sku) ?? null) !== value) out.push({ sku, stock_to_send: value });
  }
  return out;
}

/** How old the most recent X save is, and whether that is stale. */
export function stockToSendStaleness(lastSavedIso: string | null, nowIso: string = new Date().toISOString()): { stale: boolean; ageDays: number | null } {
  if (!lastSavedIso) return { stale: true, ageDays: null };
  const ageDays = Math.floor((Date.parse(nowIso) - Date.parse(lastSavedIso)) / 86400000);
  return { stale: ageDays > X_STALE_DAYS, ageDays };
}

export type StockToSendSource = "manual_migration" | "panel";

/** "10 Sep 2026 (migrated from manual)" for values copied from the manual
 *  sheet, so they never look like an edit made on the panel. Dates are shown
 *  in India time. */
export function lastUpdatedLabel(iso: string | null, source: string | null): string {
  if (!iso) return "never";
  // India time (UTC+5:30), formatted by hand so every browser shows the same text.
  const d = new Date(Date.parse(iso) + 330 * 60000);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return source === "manual_migration" ? `${date} (migrated from manual)` : date;
}

/** The migration note to flag for review, only while the value is still the
 *  migrated one (a panel save means someone has looked at it). */
export function reviewNote(row: { note: string | null; source: string | null }): string | null {
  return row.note && row.source === "manual_migration" ? row.note : null;
}
