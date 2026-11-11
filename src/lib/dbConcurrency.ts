// A cap on how many Supabase reads are in flight at once, shared by every paged read.
//
// The database gives each query from the dashboard 3 seconds. A page that loads several
// marketplaces at once (the Overall page) used to be able to start dozens of reads together; they
// slowed each other down until some passed the limit, failed, and were retried on top of the rest.
// Queued reads start as earlier ones finish, so the same work completes with fewer failures.
const LIMIT = 6;
let active = 0;
const waiting: (() => void)[] = [];

export async function withDbSlot<T>(run: () => PromiseLike<T>): Promise<T> {
  if (active >= LIMIT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await run();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
