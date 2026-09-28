// HTML-escaping for values interpolated into the email templates in src/pages/api/send-email.ts.
// Every template builds HTML with template literals, so any string in the request's `data` — an
// accountName, an alert label, a campaign or product name, a shopper-typed search term — would
// otherwise land in the email as live markup. Escaping plain text renders identically (a literal
// "&" still shows as "&"), so legitimate formatting is unchanged.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function escapeDeep(value: unknown): unknown {
  if (typeof value === "string") return escapeHtml(value);
  if (Array.isArray(value)) return value.map(escapeDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeDeep(v)]));
  }
  return value;
}

// Top-level `data` fields that intentionally carry server-built markup, per template. These
// templates are only reachable with the internal signature (see emailSendPolicy.ts), and the
// fields are composed server-side from numbers/labels — e.g. ad-alerts.ts's emoji entity and the
// "· Data: <range>" span in its subtitle. Everything else is escaped.
const RAW_FIELDS: Record<string, string[]> = {
  custom: ["html"],
  adAlert: ["emoji", "subtitle"],
};

export function escapeEmailData(type: string, data: Record<string, unknown>, allowRaw: boolean): Record<string, unknown> {
  const raw = allowRaw ? RAW_FIELDS[type] || [] : [];
  return Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [k, raw.includes(k) ? v : escapeDeep(v)])
  );
}
