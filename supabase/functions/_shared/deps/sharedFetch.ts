// Deno copy of src/lib/sharedFetch.ts for the Edge Functions — keep the two in sync.
// One in-flight/fresh download per key: several parts of the same page (a summary strip, a
// "data on file" caption, the date picker's last-data date) often need the same whole table at
// once, and each used to download it separately. A failed load is dropped so the next call retries.
const entries = new Map<string, { at: number; promise: Promise<unknown> }>();

export function sharedFetch<T>(key: string, load: () => Promise<T>, ttlMs = 60_000): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;
  const promise = load().catch((e) => {
    entries.delete(key);
    throw e;
  });
  entries.set(key, { at: Date.now(), promise });
  return promise;
}
