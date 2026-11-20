// FC Forecast seeds (2026-11-20): reads the client's weekly "FC_forecast_sheet_on <date>.xlsx" and writes
//   supabase/seed/fc_sku_product_map_<date>.json  — [{ sku, product }] from the "SKUID,NAME" tab
//   supabase/seed/fc_products_<date>.json         — [{ product }] from the "FORECAST SHEET" tab
// SKUs are normalized exactly like SQL fc_norm_sku(): invisible marks (U+200B–U+200F, U+FEFF) removed,
// trimmed, lowercased. The first product listed for a normalized SKU wins.
// Usage: node scripts/fc-forecast-seed.mjs "<path to xlsx>" [date-label, default 2026-11-18]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const [, , file, label = "2026-11-18"] = process.argv;
if (!file) throw new Error("Pass the forecast xlsx path.");

export const normSku = (s) => String(s ?? "").replace(/[​-‏﻿]/g, "").trim().toLowerCase();

const wb = XLSX.read(readFileSync(file), { type: "buffer" });
const mapRows = XLSX.utils.sheet_to_json(wb.Sheets["SKUID,NAME"], { raw: false, defval: "" });
const seen = new Map();
for (const r of mapRows) {
  const sku = normSku(r.SKUID);
  const product = String(r.Product ?? "").trim();
  if (!sku || !product || seen.has(sku)) continue;
  seen.set(sku, product);
}
const map = [...seen].map(([sku, product]) => ({ sku, product }));

const fcRows = XLSX.utils.sheet_to_json(wb.Sheets["FORECAST SHEET"], { raw: false, defval: "" });
const products = [...new Set(fcRows.map((r) => String(r["PRODUCT NAME"] ?? "").trim()).filter(Boolean))].map((product) => ({ product }));

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "seed");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, `fc_sku_product_map_${label}.json`), JSON.stringify(map, null, 1));
writeFileSync(path.join(out, `fc_products_${label}.json`), JSON.stringify(products, null, 1));
console.log(`map rows ${map.length} (from ${mapRows.length}), products ${products.length}`);
