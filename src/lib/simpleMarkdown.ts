// A small Markdown reader for the docs shown inside the dashboard (Settings → About & Audit).
// Covers what those docs use — headings, paragraphs, bullet / numbered lists, tables, code blocks,
// rules, and inline **bold**, `code` and [links](url) — and returns plain data, so the page renders
// it as React elements (never as raw HTML). Dependency-free so it can be unit tested.

export type Inline = { t: "text" | "b" | "code"; v: string } | { t: "link"; v: string; href: string };

export type Block =
  | { type: "h"; level: 1 | 2 | 3 | 4; text: Inline[]; id: string }
  | { type: "p"; text: Inline[] }
  | { type: "ul" | "ol"; items: Inline[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "code"; text: string }
  | { type: "hr" };

/** `**bold**`, `` `code` `` and `[text](url)` inside a line; anything else is text. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "b", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
    else out.push({ t: "link", v: m[3], href: m[4] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      out.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push({ type: "h", level: h[1].length as 1 | 2 | 3 | 4, text: parseInline(h[2]), id: slug(h[2]) });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push({ type: "hr" }); i++; continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]).map(parseInline));
      out.push({ type: "table", head, rows });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const re = bullet.test(line) ? bullet : numbered;
      const items: Inline[][] = [];
      for (; i < lines.length && re.test(lines[i]); i++) items.push(parseInline(lines[i].match(re)![1]));
      out.push({ type: re === bullet ? "ul" : "ol", items });
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i]); i++) para.push(lines[i].trim());
    if (!para.length) { para.push(line.trim()); i++; }
    out.push({ type: "p", text: parseInline(para.join(" ")) });
  }
  return out;
}
