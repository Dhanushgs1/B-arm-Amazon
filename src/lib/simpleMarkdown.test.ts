import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline } from "./simpleMarkdown.ts";

test("inline bold, code and links", () => {
  assert.deepEqual(parseInline("Run **node --test** via `npm test`, see [docs](https://x.y/z)."), [
    { t: "text", v: "Run " }, { t: "b", v: "node --test" }, { t: "text", v: " via " }, { t: "code", v: "npm test" },
    { t: "text", v: ", see " }, { t: "link", v: "docs", href: "https://x.y/z" }, { t: "text", v: "." },
  ]);
});

test("blocks: heading, paragraph, lists, table, code, rule", () => {
  const b = parseMarkdown([
    "# Title", "", "First line", "continues here.", "", "- one", "- two", "", "1. a", "2. b", "",
    "| Page | Data |", "|---|---|", "| Overall | Supabase |", "", "```", "x = 1", "```", "---",
  ].join("\n"));
  assert.deepEqual(b.map((x) => x.type), ["h", "p", "ul", "ol", "table", "code", "hr"]);
  assert.equal(b[0].type === "h" && b[0].id, "title");
  assert.deepEqual(b[1].type === "p" && b[1].text, [{ t: "text", v: "First line continues here." }]);
  assert.equal(b[2].type === "ul" && b[2].items.length, 2);
  assert.equal(b[4].type === "table" && b[4].rows[0][1][0].v, "Supabase");
  assert.equal(b[5].type === "code" && b[5].text, "x = 1");
});

test("the audit document parses and keeps its sections", async () => {
  const fs = await import("node:fs");
  const md = fs.readFileSync(new URL("../../docs/DASHBOARD_AUDIT.md", import.meta.url), "utf8");
  const { DASHBOARD_AUDIT_MD } = await import("./dashboardAuditDoc.ts");
  // the copy shown in Settings must be the same text as the doc in the repo
  assert.equal(DASHBOARD_AUDIT_MD.replace(/\r\n/g, "\n"), md.replace(/\r\n/g, "\n"));
  const heads = parseMarkdown(md).filter((x) => x.type === "h" && x.level === 2).length;
  assert.ok(heads >= 6, `expected the main sections, got ${heads}`);
});
