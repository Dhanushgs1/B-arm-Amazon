// Pre-loads the Overall page (/dashboard/compare) on the server so its first visit of the day is
// instant. The page's dates follow the last day that has data, so every day it asks for a new date
// range that nobody has loaded yet, and the first viewer used to wait ~30 s for it. Every 30 minutes
// this works out the ranges the page will ask for ("Last 30 Days", the default, and "Last 7 Days")
// and loads any that are missing or over 3 hours old into the shared loader cache
// (loaderCache.ts), one at a time so the shared database never gets a burst.
//
// Read-only: it only runs the same data loaders a viewer would. It never sends email and is
// separate from the email scheduler (src/instrumentation.ts), so it also runs on hosts where
// that scheduler is off (DISABLE_SCHEDULER, e.g. mna.b-arm.org). DISABLE_PRELOAD=true turns it off.

import { overallPreloadRequests } from "@/lib/server/overallPreloadPlan";
import { ensureCached, getCached } from "@/lib/server/loaderCache";

export const PRELOAD_EVERY_MS = 30 * 60_000;
export const PRELOAD_MAX_AGE_MS = 3 * 3_600_000;
const LAST_DATE_MAX_AGE_MS = 25 * 60_000;
const FIRST_RUN_DELAY_MS = 10_000;
const PAUSE_BETWEEN_LOADS_MS = 2_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One pass: refresh the Overall page's last data date, then load whatever its windows still lack. */
export async function preloadOverallOnce(): Promise<{ lastDate: string | null; loaded: number; cached: number; failed: number }> {
  await ensureCached("fetchChannelLastDataDate", ["compare"], LAST_DATE_MAX_AGE_MS);
  const lastDate = (await getCached("fetchChannelLastDataDate", ["compare"])).data;
  if (typeof lastDate !== "string" || !DATE.test(lastDate)) return { lastDate: null, loaded: 0, cached: 0, failed: 0 };
  let loaded = 0, cached = 0, failed = 0;
  // the Profit & actions page: ERP profit lines and the last 30 days of ads per product
  const profitRequests: [string, string[]][] = [["loadErpProfit", []], ["loadProductAds", [overallPreloadRequests(lastDate, [30])[0][1][0], lastDate]]];
  for (const [name, args] of [...overallPreloadRequests(lastDate), ...profitRequests]) {
    try {
      if ((await ensureCached(name, args, PRELOAD_MAX_AGE_MS)) === "cached") { cached++; continue; }
      loaded++;
      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_LOADS_MS));
    } catch (e) {
      failed++;
      console.error(`[preload] ${name}(${args.join(", ")}) failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { lastDate, loaded, cached, failed };
}

const flag = globalThis as typeof globalThis & { __m360Preload?: boolean };

/** Starts the 30-minute pre-load on a long-running Node server. Not on Vercel (no long-running
 *  process there; each function instance would just add load), not in `next dev`. */
export function startOverallPreload() {
  if (flag.__m360Preload) return;
  if (process.env.NODE_ENV !== "production" || process.env.VERCEL) return;
  if (/^(1|true|yes|on)$/i.test((process.env.DISABLE_PRELOAD ?? "").trim())) {
    console.log("[preload] Overall page pre-load disabled (DISABLE_PRELOAD)");
    return;
  }
  flag.__m360Preload = true;
  let running = false;
  const tick = async () => {
    if (running) return; // never two passes at once
    running = true;
    const t0 = Date.now();
    try {
      // Business overview / Home / chat data first: one shared build, the slowest thing to wait for
      const tb = Date.now();
      try {
        const { warmBi } = await import("@/lib/server/biCache");
        const did = await warmBi();
        console.log(`[preload] Business overview data: ${did} (${Math.round((Date.now() - tb) / 1000)} s)`);
      } catch (e) { console.error("[preload] Business overview data failed:", e instanceof Error ? e.message : e); }
      const r = await preloadOverallOnce();
      console.log(`[preload] Overall page: last data date ${r.lastDate ?? "unknown"} — ${r.loaded} loaded, ${r.cached} already cached, ${r.failed} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
    } catch (e) {
      console.error("[preload] Overall page pass failed:", e instanceof Error ? e.message : e);
    } finally { running = false; }
  };
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
  setInterval(tick, PRELOAD_EVERY_MS).unref?.();
  console.log("[preload] Overall page pre-load on — every 30 min (read-only, no email)");
}
