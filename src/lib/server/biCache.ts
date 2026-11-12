// The Business overview dataset's server cache (see src/lib/bi/dataset.ts), shared by
// GET /api/bi/dataset and the background pre-load (overallPreload.ts).
//
// Building it reads seven months of orders, ads and stock (~45 s), so it is built once and shared by
// every signed-in viewer for 20 minutes; after that the old copy is still served instantly while a
// fresh one is built in the background. The last complete copy is saved on disk, so a restart opens
// at once with it. A copy built by older code (BI_VERSION) is never served. The pre-load rebuilds it
// right after the server starts and every 30 minutes, so viewers do not wait for a build.

import fs from "node:fs";
import path from "node:path";
import { BI_VERSION, buildBiDataset } from "@/lib/bi/dataset";
import type { BiDataset } from "@/lib/bi/types";

export const BI_TTL_MS = 20 * 60_000;
type Cache = { at: number; data: BiDataset | null; building: Promise<BiDataset> | null; diskLoaded?: boolean };
const store = globalThis as typeof globalThis & { __m360Bi?: Cache };
const cache: Cache = (store.__m360Bi ??= { at: 0, data: null, building: null });

const DISK = path.join(process.cwd(), ".cache", "bi-dataset.json");
function loadFromDisk() {
  if (cache.diskLoaded) return;
  cache.diskLoaded = true;
  if (cache.data) return;
  try {
    const saved = JSON.parse(fs.readFileSync(DISK, "utf8")) as { savedAt: number; data: BiDataset };
    if (saved?.data?.dates?.length) { cache.data = saved.data; cache.at = saved.savedAt; }
  } catch { /* no saved copy yet */ }
}
function saveToDisk(d: BiDataset) {
  try {
    fs.mkdirSync(path.dirname(DISK), { recursive: true });
    const tmp = `${DISK}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), data: d }));
    fs.renameSync(tmp, DISK); // atomic: a reader never sees half a file
  } catch (e) { console.error("[bi] could not save the dataset to disk:", e); }
}

/** The stored copy (null when none, or when it was built by older code) and whether it is due a rebuild. */
export function biCached(): { data: BiDataset | null; ageMs: number; stale: boolean } {
  loadFromDisk();
  const usable = cache.data && cache.data.version === BI_VERSION ? cache.data : null;
  const ageMs = usable ? Date.now() - cache.at : Infinity;
  return { data: usable, ageMs, stale: !usable || ageMs > BI_TTL_MS };
}

/** Builds a fresh copy (one build at a time; later callers share it). */
export function rebuildBi(): Promise<BiDataset> {
  loadFromDisk();
  if (!cache.building) {
    cache.building = buildBiDataset(cache.data)
      .then((d) => {
        // A rebuild where a source failed must not replace a complete dataset: keep serving the
        // complete one and try again in two minutes instead of twenty.
        if (d.errors.length && cache.data && cache.data.errors.length === 0 && cache.data.version === BI_VERSION) {
          console.error("[bi] rebuild had failed sources, keeping the previous dataset:", d.errors);
          cache.at = Date.now() - BI_TTL_MS + 2 * 60_000;
          return cache.data;
        }
        cache.data = d; cache.at = Date.now();
        if (!d.errors.length) saveToDisk(d);
        return d;
      })
      .finally(() => { cache.building = null; });
  }
  return cache.building;
}

/** Pre-load: rebuild when there is no usable copy or it is due; returns what it did. */
export async function warmBi(): Promise<"fresh" | "rebuilt"> {
  if (!biCached().stale) return "fresh";
  await rebuildBi();
  return "rebuilt";
}
