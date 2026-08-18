const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const SHEET_PATH = "C:/Users/B ARM/Downloads/Master SKU sheet with Category.xlsx";
const TARGET = path.join(__dirname, "..", "src", "lib", "categoryMap.ts");

// Established spelling already used throughout the codebase (CATEGORY_COLORS,
// EXCLUDED_CATEGORIES elsewhere) — the sheet spells it "Gynecology" (American),
// the app has always used "Gynaecology" (British). Normalize so this update
// doesn't fragment the category into two.
const CATEGORY_ALIASES = { Gynecology: "Gynaecology" };
const normalizeCategory = (c) => CATEGORY_ALIASES[c] || c;

// "Nil"-style placeholders show up as literal SKU values on rows with no real
// SKU assigned yet. They're not real SKUs — several of them map to different
// products/categories in the sheet, so including them as exact-match keys
// would make unrelated products with a literal SKU "Nil" collide.
const isPlaceholderSku = (s) => /^(nil|n\/?a|-+|none|tbd)$/i.test(s.trim());

const wb = XLSX.readFile(SHEET_PATH);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
const data = rows.slice(1);

const categoryEntries = []; // [name, category][], first-seen order, deduped by name
const seenNames = new Set();
const skuCategoryMap = new Map(); // last occurrence wins
const skuNameMap = new Map();
const skuConflicts = [];
let skippedPlaceholderSkus = 0;

data.forEach((r, i) => {
  const [, rawName, rawSku, , rawCat] = r;
  const name = rawName ? String(rawName).trim() : "";
  const sku = rawSku ? String(rawSku).trim() : "";
  const category = normalizeCategory(rawCat ? String(rawCat).trim() : "");
  if (!name || !category) return;

  if (!seenNames.has(name)) {
    seenNames.add(name);
    categoryEntries.push([name, category]);
  }

  if (!sku) return;
  if (isPlaceholderSku(sku)) { skippedPlaceholderSkus++; return; }

  if (skuCategoryMap.has(sku) && skuCategoryMap.get(sku) !== category) {
    skuConflicts.push({ sku, from: skuCategoryMap.get(sku), to: category, row: i + 2, field: "category" });
  }
  skuCategoryMap.set(sku, category);

  if (skuNameMap.has(sku) && skuNameMap.get(sku) !== name) {
    skuConflicts.push({ sku, from: skuNameMap.get(sku), to: name, row: i + 2, field: "name" });
  }
  skuNameMap.set(sku, name);
});

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const categoryEntriesBlock =
  "export const CATEGORY_ENTRIES: [string, string][] = [\n" +
  categoryEntries.map(([n, c]) => `  ["${esc(n)}", "${esc(c)}"],`).join("\n") +
  "\n];";

const skuCategoryMapBlock =
  "export const SKU_CATEGORY_MAP: Record<string, string> = {\n" +
  [...skuCategoryMap.entries()].map(([s, c]) => `  "${esc(s)}": "${esc(c)}",`).join("\n") +
  "\n};";

const skuNameMapBlock =
  "export const SKU_NAME_MAP: Record<string, string> = {\n" +
  [...skuNameMap.entries()].map(([s, n]) => `  "${esc(s)}": "${esc(n)}",`).join("\n") +
  "\n};";

let text = fs.readFileSync(TARGET, "utf8");

function replaceBlock(text, startMarker, endMarker, newBlock, label) {
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`Could not find start marker for ${label}`);
  const end = text.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Could not find end marker for ${label}`);
  const endPos = end + endMarker.length;
  return text.slice(0, start) + newBlock + text.slice(endPos);
}

text = replaceBlock(text, "export const CATEGORY_ENTRIES: [string, string][] = [", "\n];", categoryEntriesBlock, "CATEGORY_ENTRIES");
text = replaceBlock(text, "export const SKU_CATEGORY_MAP: Record<string, string> = {", "\n};", skuCategoryMapBlock, "SKU_CATEGORY_MAP");
text = replaceBlock(text, "export const SKU_NAME_MAP: Record<string, string> = {", "\n};", skuNameMapBlock, "SKU_NAME_MAP");

fs.writeFileSync(TARGET, text, "utf8");

console.log("Rows processed:", data.length);
console.log("CATEGORY_ENTRIES (unique product names):", categoryEntries.length);
console.log("SKU_CATEGORY_MAP / SKU_NAME_MAP (unique real SKUs):", skuCategoryMap.size);
console.log("Placeholder SKUs skipped:", skippedPlaceholderSkus);
console.log("Categories found:", [...new Set(categoryEntries.map((e) => e[1]))].sort());
console.log("SKU conflicts (last-occurrence wins):", skuConflicts.length);
console.log(JSON.stringify(skuConflicts, null, 1));
