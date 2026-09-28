// Deno copy of src/lib/htmlEscape.ts's escaping (Edge Functions can't import from src/). Applied
// to every value the send-ad-spend-email template interpolates, so a product or campaign name
// from an uploaded export can never become live markup in the email. Plain text renders the same.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function escapeDeep<T>(value: T): T {
  if (typeof value === "string") return escapeHtml(value) as T;
  if (Array.isArray(value)) return value.map(escapeDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeDeep(v)])) as T;
  }
  return value;
}
