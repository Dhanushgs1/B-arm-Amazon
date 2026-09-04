/**
 * Merges rows that share the same upsert conflict key before they reach
 * Postgres — `ON CONFLICT DO UPDATE` throws "cannot affect row a second time"
 * if one upsert statement contains that key twice. `sumFields` are added
 * together across the duplicates; every other field keeps the first row's
 * value. Same convention as combinedAdSpendUpload.ts's local helper of the
 * same name.
 */
export function mergeByConflictKey(
  rows: Record<string, unknown>[],
  keyCols: string[],
  sumFields: string[]
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = keyCols.map((c) => row[c]).join("");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    for (const f of sumFields) existing[f] = (Number(existing[f]) || 0) + (Number(row[f]) || 0);
  }
  return [...merged.values()];
}
