// The dashboard writes with the anon key, and Postgres cancels any anon statement after 3 seconds
// ("canceling statement due to statement timeout"). On this project's small database a 300-row
// insert or a week-wide delete normally takes 0.3–1.5 s but crosses 3 s under load, which failed
// the 12 Nov 2026 "Last 7 days" upload part-way (rows deleted, not all re-inserted).
//
// A statement that timed out was rolled back by the database, so running it again is safe.
// Dependency-free so it can be unit tested.

export type WriteResult = { error: { message: string } | null };

export const isStatementTimeout = (message: string | undefined | null) => /statement timeout/i.test(message ?? "");

/** Runs one write, retrying (with a short pause) only when it failed on the statement timeout. */
export async function retryOnTimeout(
  run: () => PromiseLike<WriteResult>,
  { attempts = 4, pauseMs = 1500, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<WriteResult> {
  let last: WriteResult = { error: null };
  for (let i = 0; i < attempts; i++) {
    last = await run();
    if (!last.error || !isStatementTimeout(last.error.message)) return last;
    if (i < attempts - 1) await sleep(pauseMs * (i + 1));
  }
  return last;
}

/** Every calendar day from `from` to `to` (YYYY-MM-DD, inclusive), or null when either is not a
 *  plain date — the caller then falls back to one range statement. */
export function daysBetween(from: string, to: string): string[] | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(from) || !iso.test(to) || from > to) return null;
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
