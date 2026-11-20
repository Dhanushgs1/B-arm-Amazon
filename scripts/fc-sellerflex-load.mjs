// One-off load of a Seller Flex customer-shipments CSV into barm_sellerflex_shipments, with the same
// parser and upsert the FC Forecast page uses (2026-11-20 initial load: 01-Aug … 17-Nov-2026 file).
// Usage: node scripts/fc-sellerflex-load.mjs <path to .env.local> <path to VSNC-CUSTOMER_SHIPMENTS-ALL-*.csv>

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseSellerFlexCsv } from "../src/lib/sellerFlexShipments.ts";
import { saveSellerFlexRows } from "../src/lib/sellerFlexUpload.ts";

const [, , envPath, csvPath] = process.argv;
if (!envPath || !csvPath) throw new Error("Usage: node scripts/fc-sellerflex-load.mjs <.env.local> <csv>");
const env = Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { rows, minDate, maxDate, skipped } = parseSellerFlexCsv(readFileSync(csvPath, "utf8"));
const saved = await saveSellerFlexRows(db, rows);
console.log(`saved ${saved} shipments (${minDate} … ${maxDate}), skipped ${skipped}`);
