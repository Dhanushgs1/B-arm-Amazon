// Saves a Seller Flex customer-shipments CSV into barm_sellerflex_shipments (FC Forecast tab).
// Upsert on (shipment_id, sku): re-uploading an overlapping date range refreshes statuses, never duplicates.
// The client is passed in so this runs in the browser and from scripts/fc-sellerflex-load.mjs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSellerFlexCsv, type SellerFlexRow } from "./sellerFlexShipments.ts";

export const SELLERFLEX_TABLE = "barm_sellerflex_shipments";

export async function saveSellerFlexRows(db: SupabaseClient, rows: SellerFlexRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(SELLERFLEX_TABLE).upsert(rows.slice(i, i + 500), { onConflict: "shipment_id,sku" });
    if (error) throw new Error(`Saving Seller Flex shipments failed: ${error.message}`);
  }
  return rows.length;
}

export async function uploadSellerFlexCsv(
  db: SupabaseClient,
  file: File
): Promise<{ saved: number; minDate: string | null; maxDate: string | null; skipped: number }> {
  const { rows, minDate, maxDate, skipped } = parseSellerFlexCsv(await file.text());
  if (!rows.length) throw new Error("No shipments found — is this the Seller Flex CUSTOMER_SHIPMENTS CSV? Nothing was saved.");
  return { saved: await saveSellerFlexRows(db, rows), minDate, maxDate, skipped };
}
