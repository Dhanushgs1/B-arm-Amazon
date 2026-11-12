// Run a data loader on the server instead of in the browser.
//
// The Overall page and the marketplace Overview strips used to run their loaders in the viewer's
// browser: 30+ direct database reads per page view, several of them whole order tables paged 1,000
// rows at a time, each 5–20 s on this database. Called from a browser, these loaders now ask
// /api/data/loader, which runs the very same function once on the server and shares the result
// (cached, and kept on disk) with every viewer. Called on the server (API routes, emails, the
// executive dataset), they run directly exactly as before.

export const inBrowser = () => typeof window !== "undefined";

export async function viaServer<T>(name: string, args: string[]): Promise<T> {
  const qs = new URLSearchParams({ name });
  for (const a of args) qs.append("a", a);
  const res = await fetch(`/api/data/loader?${qs.toString()}`, { credentials: "same-origin" });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (!res.ok || !body || !("data" in body)) throw new Error(body?.error || `Loading ${name} failed (HTTP ${res.status})`);
  return body.data as T;
}
