// Copies docs/DASHBOARD_AUDIT.md into src/lib/dashboardAuditDoc.ts, the copy Settings → About & Audit
// shows (a client page can't read a repo file). Run after editing the doc:
//   node scripts/sync-audit-doc.mjs
// src/lib/simpleMarkdown.test.ts fails if the two ever differ.
import { readFileSync, writeFileSync } from "node:fs";

const md = readFileSync(new URL("../docs/DASHBOARD_AUDIT.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
writeFileSync(
  new URL("../src/lib/dashboardAuditDoc.ts", import.meta.url),
  `// GENERATED from docs/DASHBOARD_AUDIT.md by scripts/sync-audit-doc.mjs — edit the .md, then re-run.\n\nexport const DASHBOARD_AUDIT_MD = ${JSON.stringify(md)};\n`,
);
console.log(`synced ${md.length} characters`);
