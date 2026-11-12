// Server-side cache for the dashboard's read-only data loaders, shared by /api/data/loader (what
// the browser calls, see src/lib/viaServer.ts) and the Overall page pre-load (overallPreload.ts).
//
// A result is fresh for 5 minutes. After that the stored copy is still returned at once (for up to
// 12 hours) while a new one is loaded in the background, so nobody waits on the database twice.
// Results are also kept on disk, so a restart or deploy does not empty the cache. A load that fails
// never replaces a stored copy. Only the loaders listed below can be called, and every argument is
// checked.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fetchAmazonSummary, fetchBarmSummary, fetchFlipkartAllSummary, fetchFlipkartOrderSummary, fetchMeeshoSummary } from "@/lib/channelSummary";
import { loadMarketplaceAds, loadSpendWindows } from "@/lib/overallData";
import { fetchShopifyAllSummary, fetchShopifyOrders, fetchShopifySummary } from "@/lib/shopifyOrders";
import { fetchChannelLastDataDate } from "@/lib/channelLastDataDate";
import { loadErpProfit, loadProductAds } from "@/lib/profitData";
import type { MarketplaceTab } from "@/lib/marketplace";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dates = (a: string[]) => a.length === 2 && DATE.test(a[0]) && DATE.test(a[1]) && a[0] <= a[1];
const keyed = (keys: string[]) => (a: string[]) => a.length === 3 && keys.includes(a[0]) && dates(a.slice(1));

export const LOADERS: Record<string, { valid: (a: string[]) => boolean; run: (a: string[]) => Promise<unknown> }> = {
  fetchAmazonSummary: { valid: dates, run: (a) => fetchAmazonSummary(a[0], a[1]) },
  fetchFlipkartAllSummary: { valid: dates, run: (a) => fetchFlipkartAllSummary(a[0], a[1]) },
  fetchFlipkartOrderSummary: { valid: dates, run: (a) => fetchFlipkartOrderSummary(a[0], a[1]) },
  fetchMeeshoSummary: { valid: dates, run: (a) => fetchMeeshoSummary(a[0], a[1]) },
  fetchBarmSummary: { valid: dates, run: (a) => fetchBarmSummary(a[0], a[1]) },
  fetchShopifyAllSummary: { valid: dates, run: (a) => fetchShopifyAllSummary(a[0], a[1]) },
  fetchShopifySummary: { valid: dates, run: (a) => fetchShopifySummary(a[0], a[1]) },
  fetchShopifyOrders: { valid: (a) => a.length === 0, run: () => fetchShopifyOrders() },
  loadMarketplaceAds: { valid: keyed(["amazon", "flipkart", "meesho"]), run: (a) => loadMarketplaceAds(a[0] as "amazon", a[1], a[2]) },
  fetchChannelLastDataDate: { valid: (a) => a.length === 1 && ["amazon", "flipkart", "meesho", "shopify", "barm", "compare"].includes(a[0]), run: (a) => fetchChannelLastDataDate(a[0] as MarketplaceTab) },
  loadSpendWindows: { valid: keyed(["google", "meta"]), run: (a) => loadSpendWindows(a[0] as "google", a[1], a[2]) },
  loadErpProfit: { valid: (a) => a.length === 0, run: () => loadErpProfit() },
  loadProductAds: { valid: dates, run: (a) => loadProductAds(a[0], a[1]) },
};

export const FRESH_MS = 5 * 60_000;
export const MAX_STALE_MS = 12 * 3_600_000;
const MAX_ENTRIES = 300;
type Entry = { at: number; data: unknown; building: Promise<unknown> | null };
const store = globalThis as typeof globalThis & { __m360Loaders?: Map<string, Entry> };
const cache = (store.__m360Loaders ??= new Map());
const DIR = path.join(process.cwd(), ".cache", "loaders");
const file = (key: string) => path.join(DIR, `${crypto.createHash("sha1").update(key).digest("hex")}.json`);

function fromDisk(key: string): Entry | null {
  try {
    const s = JSON.parse(fs.readFileSync(file(key), "utf8")) as { key: string; at: number; data: unknown };
    return s.key === key ? { at: s.at, data: s.data, building: null } : null;
  } catch { return null; }
}
function toDisk(key: string, e: Entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file(key)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ key, at: e.at, data: e.data }));
    fs.renameSync(tmp, file(key));
  } catch (err) { console.error("[loader cache] could not save:", err); }
}

/** This database has bursts of statement timeouts while its scheduled jobs run; a load that fails
 *  is tried again after a pause (3 tries, 4 s then 10 s apart) before the error is shown. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  const waits = [4_000, 10_000];
  for (let i = 0; ; i++) {
    try { return await run(); } catch (e) {
      if (i >= waits.length) throw e;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

function load(key: string, run: () => Promise<unknown>, entry: Entry | undefined): Promise<unknown> {
  const e = entry ?? { at: 0, data: undefined, building: null };
  if (!entry) cache.set(key, e);
  if (!e.building) {
    e.building = withRetry(run)
      .then((data) => {
        e.data = data; e.at = Date.now(); toDisk(key, e);
        if (cache.size > MAX_ENTRIES) { // drop the oldest results
          const oldest = [...cache.entries()].filter(([, v]) => !v.building).sort((x, y) => x[1].at - y[1].at).slice(0, cache.size - MAX_ENTRIES);
          for (const [k] of oldest) cache.delete(k);
        }
        return data;
      })
      .finally(() => { e.building = null; });
  }
  return e.building;
}

/** Bump when a loader's figures change meaning, so stored copies from before are not served.
 *  v5 (12 Nov 2026): Amazon / Flipkart / Meesho summaries use the B-ARM ERP invoice figures. */
const CACHE_VERSION = "v5";
/** Per-loader bumps, so a change to one channel does not empty everyone's cache (a cold load is slow).
 *  fk2 (12 Nov 2026): Flipkart ads include campaign-performance days before the daily upload began. */
const versionOf = (name: string, args: string[]) => (name === "fetchFlipkartAllSummary" || (name === "loadMarketplaceAds" && args[0] === "flipkart") ? "|fk2" : "");
const keyOf = (name: string, args: string[]) => `${CACHE_VERSION}${versionOf(name, args)}|${name}|${args.join("|")}`;
function lookup(key: string): Entry | undefined {
  let entry = cache.get(key);
  if (!entry) { const d = fromDisk(key); if (d) { cache.set(key, d); entry = d; } }
  return entry;
}

export class UnknownLoaderError extends Error {}

/** What a viewer gets: the stored copy at once if it is under 12 hours old (refreshed in the
 *  background once it is over 5 minutes old), otherwise a fresh load. A failed load falls back to
 *  any older copy. */
export async function getCached(name: string, args: string[]): Promise<{ data: unknown; ageSeconds: number }> {
  const loader = LOADERS[name];
  if (!loader || !loader.valid(args)) throw new UnknownLoaderError("Unknown data request");
  const key = keyOf(name, args);
  const entry = lookup(key);
  const age = entry && entry.data !== undefined ? Date.now() - entry.at : Infinity;
  try {
    if (entry && entry.data !== undefined && age < MAX_STALE_MS) {
      if (age > FRESH_MS) load(key, () => loader.run(args), entry).catch((e) => console.error(`[loader cache] ${name} refresh failed:`, e));
      return { data: entry.data, ageSeconds: Math.round(age / 1000) };
    }
    return { data: await load(key, () => loader.run(args), entry), ageSeconds: 0 };
  } catch (err) {
    console.error(`[loader cache] ${name} failed:`, err);
    if (entry && entry.data !== undefined) return { data: entry.data, ageSeconds: Math.round(age / 1000) }; // an older copy beats an error
    throw err;
  }
}

/** Pre-load: makes sure a result is stored and no older than `maxAgeMs`, loading it (and waiting)
 *  only when it is missing or older. Returns "cached" or "loaded"; a failed load throws and leaves
 *  any stored copy in place. */
export async function ensureCached(name: string, args: string[], maxAgeMs: number): Promise<"cached" | "loaded"> {
  const loader = LOADERS[name];
  if (!loader || !loader.valid(args)) throw new UnknownLoaderError(`Unknown data request ${name}`);
  const key = keyOf(name, args);
  const entry = lookup(key);
  if (entry && entry.data !== undefined && Date.now() - entry.at < maxAgeMs) return "cached";
  await load(key, () => loader.run(args), entry);
  return "loaded";
}
