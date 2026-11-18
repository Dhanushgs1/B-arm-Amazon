// Product Marketing 360 — pure shaping rules used by /api/marketing-360 (tested in marketing360Rules.test.ts).

import { pincodeState } from "./marketing360Import.ts";

export type DeliveryCheck = {
  week: string; platform: string; pincode: string; tier: string | null; location: string | null;
  delivery_text: string | null; days: number | null; scraped_date: string | null; status: string | null;
};
export type DeliveryCell = DeliveryCheck & { state: string };

/** Latest check per pincode (by scraped date, then week label), with its state. */
export function latestByPincode(rows: DeliveryCheck[], overrides: Record<string, string> = {}): DeliveryCell[] {
  const best = new Map<string, DeliveryCheck>();
  for (const r of rows) {
    const cur = best.get(r.pincode);
    const k = `${r.scraped_date ?? ""}|${r.week}`;
    if (!cur || k > `${cur.scraped_date ?? ""}|${cur.week}`) best.set(r.pincode, r);
  }
  return [...best.values()]
    .map((r) => ({ ...r, state: overrides[r.pincode] ?? pincodeState(r.pincode) ?? "Unknown" }))
    .sort((a, b) => a.state.localeCompare(b.state) || a.pincode.localeCompare(b.pincode));
}

/** Template status words → good / slow / missing, for colouring with a text label alongside. */
export function deliveryTone(c: Pick<DeliveryCheck, "status" | "days">): "fast" | "ok" | "slow" | "none" {
  if (!c.status || /unavailable|not deliverable|no listing|unable/i.test(c.status) || c.days === null) return "none";
  if (c.days <= 2) return "fast";
  if (c.days <= 5) return "ok";
  return "slow";
}

/** Each FC's onboarding state per the seller's "FBA warehouse details" sheet (see fbaWarehouseAlerts.ts). */
export const IN_PROGRESS_FCS = ["COX1", "RJX1"];
export type FcRow = { fc: string; region: string | null; onboarded: "Yes" | "In progress" | "No"; stock: number | null };
export function fcTable(yesFcs: { code: string; region: string }[], stock: { fc: string; quantity: number }[]): FcRow[] {
  const qty = new Map<string, number>();
  for (const s of stock) qty.set(s.fc, (qty.get(s.fc) ?? 0) + s.quantity);
  const rows: FcRow[] = yesFcs.map((f) => ({ fc: f.code, region: f.region, onboarded: "Yes", stock: qty.get(f.code) ?? 0 }));
  for (const code of IN_PROGRESS_FCS) rows.push({ fc: code, region: null, onboarded: "In progress", stock: qty.get(code) ?? 0 });
  const known = new Set(rows.map((r) => r.fc));
  for (const [fc, q] of qty) if (!known.has(fc)) rows.push({ fc, region: null, onboarded: "No", stock: q });
  return rows;
}

/** Ad on/off from the last 7 report days: on = any spend. Absent data stays "No data", never "Off". */
export function adState(spend: number | null): "On" | "Off" | "No data" {
  if (spend === null) return "No data";
  return spend > 0 ? "On" : "Off";
}

/** Words that find a product's Google / Meta campaigns: the profile's list, else the first meaningful word of its name. */
export function campaignKeywords(profileKeywords: string | null | undefined, productName: string | null): string[] {
  const own = (profileKeywords ?? "").split(",").map((s) => s.trim()).filter((s) => s.length >= 3);
  if (own.length) return own;
  const STOP = new Set(["b-arm", "barm", "the", "and", "with", "for", "pack", "kit", "new", "model"]);
  const word = (productName ?? "").toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 4 && !STOP.has(w));
  return word ? [word] : [];
}
