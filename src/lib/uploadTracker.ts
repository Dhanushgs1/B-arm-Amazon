// Uploads that keep their status when you leave the page (user, 2026-10-25: "upload on the Amazon page,
// open another tab, come back — no idea if it finished"). An upload's promise already keeps running
// after the page unmounts (client-side navigation keeps the JS alive); what was lost was its status,
// which lived in the page's own state. This store holds it at module level instead, so:
//   - the floating tray (UploadStatusTray, in the dashboard layout) shows every upload on every page,
//   - the upload card shows the same job again when you come back to it.
// Finished jobs are kept in sessionStorage so a reload still shows the last results; a job that was
// still running when the page reloaded was cut off by the reload and is shown as failed.
// Dependency-free (no React) so it can be unit tested.

export type UploadStatus = "running" | "done" | "warning" | "error";

export interface UploadProgress {
  done: number;
  total: number;
  step?: string;
}

export interface UploadJob {
  id: string;
  /** Which card started it, e.g. "amazon:combined" — the card reads its latest job by this. */
  key: string;
  label: string;
  fileName: string;
  /** Page to go back to for the details. */
  href: string;
  status: UploadStatus;
  message?: string;
  progress?: UploadProgress;
  startedAt: number;
  finishedAt?: number;
}

const STORAGE_KEY = "m360_upload_jobs";
const KEEP = 20;

let jobs: UploadJob[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as UploadJob[];
    jobs = saved.map((j) =>
      j.status === "running"
        ? { ...j, status: "error" as const, message: "Stopped — the page was reloaded or closed while this was uploading. Upload the file again.", finishedAt: j.finishedAt ?? Date.now() }
        : j,
    );
  } catch {
    jobs = [];
  }
}

function emit() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(0, KEEP)));
  } catch {
    /* storage full or blocked: the tray still works for this page view */
  }
  for (const l of listeners) l();
}

export function getJobs(): UploadJob[] {
  load();
  return jobs;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function latestJob(key: string): UploadJob | undefined {
  return getJobs().find((j) => j.key === key);
}

export function isAnyRunning(): boolean {
  return getJobs().some((j) => j.status === "running");
}

let seq = 0;
export function startJob(meta: { key: string; label: string; fileName: string; href: string }, now = Date.now()): string {
  load();
  const id = `${now.toString(36)}-${(seq++).toString(36)}`;
  const job: UploadJob = { ...meta, id, status: "running", startedAt: now };
  jobs = [job, ...jobs].slice(0, KEEP);
  emit();
  return id;
}

export function updateJob(id: string, patch: Partial<Pick<UploadJob, "progress" | "message">>) {
  load();
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  emit();
}

export function finishJob(id: string, status: Exclude<UploadStatus, "running">, message: string, now = Date.now()) {
  load();
  jobs = jobs.map((j) => (j.id === id ? { ...j, status, message, finishedAt: now, progress: j.progress && status !== "error" ? { ...j.progress, done: j.progress.total } : j.progress } : j));
  emit();
}

export function dismissJob(id: string) {
  load();
  jobs = jobs.filter((j) => j.id !== id);
  emit();
}

export function dismissFinished() {
  load();
  jobs = jobs.filter((j) => j.status === "running");
  emit();
}

/** Run an upload as a tracked job. `summarize` turns the result into the tray's status line; a throw
 *  marks the job failed with the error and is re-thrown so the card can show it as before. */
export async function trackUpload<T>(
  meta: { key: string; label: string; fileName: string; href: string },
  run: (progress: (p: UploadProgress) => void) => Promise<T>,
  summarize: (result: T) => { status: Exclude<UploadStatus, "running" | "error">; message: string } | { status: "error"; message: string },
): Promise<T> {
  const id = startJob(meta);
  try {
    const result = await run((p) => updateJob(id, { progress: p }));
    const s = summarize(result);
    finishJob(id, s.status, s.message);
    return result;
  } catch (err) {
    finishJob(id, "error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** For tests only. */
export function __resetForTests() {
  jobs = [];
  loaded = true;
  listeners.clear();
}
