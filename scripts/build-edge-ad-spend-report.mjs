// Builds supabase/functions/_shared/adSpendReportExport.ts — the file the generate-ad-spend-report Edge
// Function runs — as one Deno bundle of src/lib/adSpendReportExport.ts and its src/lib deps. Since v62 the
// deployed function is this bundle (not a hand port), so the emailed report is the website's report.
// amazonReportUpload / siteUrl are swapped for the Deno stand-ins in supabase/edge-build/ad-spend-report-shims/.
//
//   ESBUILD_PATH=<path to an esbuild package dir> node scripts/build-edge-ad-spend-report.mjs <commit> [--check]
//
// <commit> is written into the banner (the commit whose src/lib this is). --check writes nothing and exits 1
// when the committed file differs from a fresh build (line endings ignored). v64 (26 Nov 2026) = commit
// d749702 built with esbuild 0.28.2. This script only builds; deploying stays a separate, approved step.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [commit, flag] = process.argv.slice(2);
if (!commit) throw new Error("usage: node scripts/build-edge-ad-spend-report.mjs <commit> [--check]");
const esbuildEntry = process.env.ESBUILD_PATH
  ? pathToFileURL(path.join(process.env.ESBUILD_PATH, "lib", "main.js")).href
  : "esbuild";
const { build } = await import(esbuildEntry);

const out = path.join(root, "supabase", "functions", "_shared", "adSpendReportExport.ts");
const shimDir = path.join(root, "supabase", "edge-build", "ad-spend-report-shims");
const shims = {
  "@/lib/amazonReportUpload": path.join(shimDir, "amazonReportUpload.ts"),
  "@/lib/siteUrl": path.join(shimDir, "siteUrl.ts"),
};
const npmPins = {
  "xlsx-js-style": "npm:xlsx-js-style@1.2.0",
  xlsx: "npm:xlsx@0.18.5",
  papaparse: "npm:papaparse@5.5.4",
  "@supabase/supabase-js": "npm:@supabase/supabase-js@2.110.8",
};

const plugin = {
  name: "edge-resolve",
  setup(b) {
    b.onResolve({ filter: /^@\/lib\// }, (a) => {
      if (shims[a.path]) return { path: shims[a.path] };
      const base = path.join(root, "src", "lib", a.path.slice("@/lib/".length));
      for (const ext of [".ts", ".tsx", "/index.ts"]) if (fs.existsSync(base + ext)) return { path: base + ext };
      return { errors: [{ text: `cannot resolve ${a.path}` }] };
    });
    b.onResolve({ filter: /^[^./@]|^@supabase\// }, (a) => {
      if (a.kind === "entry-point" || path.isAbsolute(a.path)) return undefined;
      if (a.path.startsWith("npm:")) return { path: a.path, external: true };
      if (npmPins[a.path]) return { path: npmPins[a.path], external: true };
      return { errors: [{ text: `unpinned package ${a.path}` }] };
    });
  },
};

const r = await build({
  entryPoints: [path.join(root, "src", "lib", "adSpendReportExport.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
  plugins: [plugin],
  logLevel: "warning",
});
const banner =
  `// Bundled for deploy (26 Nov 2026 IST): src/lib/adSpendReportExport.ts of Vercel commit ${commit} with its src/lib deps,\n` +
  `// amazonReportUpload/siteUrl replaced by Deno stand-ins (same as v62). Source of truth = that commit.\n`;
// Deno specifics: xlsx-js-style as a default import (its CJS namespace has no named exports under Deno),
// and the Gemini key from Deno.env.
let text = r.outputFiles[0].text;
const fixes = [
  [/import \* as XLSX4 from "npm:xlsx-js-style@1\.2\.0";/, 'import XLSX4 from "npm:xlsx-js-style@1.2.0";'],
  [/process\.env\.GEMINI_API_KEY/, 'Deno.env.get("GEMINI_API_KEY")'],
];
for (const [re, to] of fixes) {
  if (!re.test(text)) throw new Error(`fix not applied: ${re}`);
  text = text.replace(re, to);
}
if (/process\.env|\bwindow\.|\bdocument\./.test(text)) throw new Error("browser/Node-only reference left in bundle");
const built = banner + text;

if (flag === "--check") {
  const norm = (s) => s.replace(/\r\n/g, "\n");
  const same = fs.existsSync(out) && norm(fs.readFileSync(out, "utf8")) === norm(built);
  console.log(same ? "up to date" : "OUT OF DATE: rebuild supabase/functions/_shared/adSpendReportExport.ts");
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(out, built);
console.log("wrote", path.relative(root, out), Math.round(built.length / 1024), "KB");
