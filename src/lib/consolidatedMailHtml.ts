// Mail body for the Consolidated Stock Sheet mails (user, 2026-11-18: "i want the sheet also and i want the
// table in mail also"): the attached sheet's rows as an HTML table, with the sheet's own colours (yellow =
// lower than the day before, red = runs out in under 30 days). Pure, so the API and previews share it.

export type MailCell = { v: string; bg?: string; fg?: string };
export type MailTable = { name: string; head: string[]; rows: MailCell[][] };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hex = (c: unknown) => (typeof c === "string" && /^[0-9A-Fa-f]{6}$/.test(c) ? `#${c}` : null);

/** Keeps only well-formed tables from a request body (the page builds them; never trust the shape). */
export function cleanTables(x: unknown): MailTable[] {
  if (!Array.isArray(x)) return [];
  return x.slice(0, 4).flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const { name, head, rows } = t as Record<string, unknown>;
    if (typeof name !== "string" || !Array.isArray(head) || !Array.isArray(rows)) return [];
    return [{
      name: name.slice(0, 80),
      head: head.slice(0, 40).map((h) => String(h ?? "").slice(0, 80)),
      rows: rows.slice(0, 1500).filter(Array.isArray).map((r: unknown[]) => r.slice(0, 40).map((c) => {
        const o = (c && typeof c === "object" ? c : { v: c }) as Record<string, unknown>;
        return { v: String(o.v ?? "").slice(0, 200), bg: hex(o.bg)?.slice(1), fg: hex(o.fg)?.slice(1) };
      })),
    }];
  });
}

// Kept small on purpose: Gmail clips a mail body over ~102 KB, and the Consolidated table has ~200 rows.
// Borders and padding come from the table's own border/cellpadding attributes, so plain cells need no style.
const TH = "background:#C5E0B3;font-size:12px;white-space:normal;min-width:52px;max-width:110px;";
/** "DAY 10 (08-11-2026)" → "Day 10" over "08-11", so ten day columns fit a mail. */
const headHtml = (h: string) => {
  const m = h.match(/^DAY (\d+) \((\d\d-\d\d)-\d{4}\)$/);
  return m ? `Day ${m[1]}<br>${m[2]}` : esc(h).replace(" (", "<br>(");
};

export function mailTableHtml(t: MailTable): string {
  const head = t.head.map((h) => `<th style="${TH}">${headHtml(h)}</th>`).join("");
  const td = (c: MailCell, i: number) => {
    const st = `${c.bg ? `background:#${c.bg};` : ""}${c.fg ? `color:#${c.fg};font-weight:700;` : ""}`;
    return `<td${i === 0 ? ' align="left"' : ""}${st || i === 0 ? ` style="${i === 0 ? "white-space:normal;min-width:170px;" : ""}${st}"` : ""}>${esc(c.v)}</td>`;
  };
  const body = t.rows.length
    ? t.rows.map((r) => `<tr>${r.map(td).join("")}</tr>`).join("\n")
    : `<tr><td colspan="${t.head.length}" style="color:#6b7280;">No products</td></tr>`;
  return `
    <h3 style="margin:22px 0 8px;color:#111827;font-size:15px;font-weight:800;">${esc(t.name)} <span style="color:#6b7280;font-weight:600;">(${t.rows.length})</span></h3>
    <div style="overflow-x:auto;">
      <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;border-color:#cbd5e1;font-family:Arial,Helvetica,sans-serif;font-size:12px;text-align:center;white-space:nowrap;">
        <thead><tr>${head}</tr></thead><tbody>${body}</tbody>
      </table>
    </div>`;
}

export function consolidatedMailHtml(title: string, what: string, date: string, rows: number | null, tables: MailTable[]): string {
  const count = rows !== null && Number.isFinite(rows) ? ` (${rows} product${rows === 1 ? "" : "s"})` : "";
  return `
    <h2 style="margin:0 0 8px;color:#111827;font-size:19px;font-weight:800;">${esc(title)} — ${esc(date)}</h2>
    <p style="margin:0;color:#374151;font-size:14px;line-height:1.5;">Attached: ${what} from the Consolidated Stock Sheet as on ${esc(date)}${count}. The same rows are below.</p>
    ${tables.map(mailTableHtml).join("")}
    ${tables.some((t) => t.rows.some((r) => r.some((c) => c.bg))) ? `<p style="margin:14px 0 0;color:#6b7280;font-size:12px;line-height:1.5;"><span style="background:#FFFF00;padding:0 6px;">yellow</span> = lower than the day before &nbsp; <span style="background:#FFC7CE;color:#9C0006;font-weight:700;padding:0 6px;">red</span> = runs out in under 30 days</p>` : ""}`;
}
