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

// ── full-sheet editing ──────────────────────────────────────────────────────────────────────────
/** An editable full-sheet cell. Profile cells save to mkt_product_profile; "task" adds an action-plan row. */
export type SheetEdit =
  | { kind: "text"; field: "primary_audience" | "secondary_audience" | "fba_weight_note" }
  | { kind: "number"; field: "tam_value" }
  | { kind: "multi"; field: "retarget"; options: readonly string[] }
  | { kind: "bool"; field: "content"; key: string }
  | { kind: "task" };

export type SheetRowProfile = {
  tam: number | null; primary: string | null; secondary: string | null; fba_weight?: string | null;
  retarget_yes: string[] | null; content: Record<string, boolean> | null;
};

/**
 * What one profile-cell edit writes, and how the sheet row changes. Only the edited column is sent, so
 * an upsert never blanks the profile's other fields (ad keywords, notes …). Empty text → null,
 * not "": a cleared cell reads as "not filled in". Returns an error string for invalid input.
 */
export function profileEdit(row: SheetRowProfile, edit: Exclude<SheetEdit, { kind: "task" }>, value: unknown):
  { db: Record<string, unknown>; row: Partial<SheetRowProfile> } | { error: string } {
  if (edit.kind === "number") {
    const s = String(value ?? "").replace(/[,\s₹]/g, "");
    if (s === "") return { db: { tam_value: null }, row: { tam: null } };
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { error: "Enter a number (₹), e.g. 38595700000" };
    return { db: { tam_value: n }, row: { tam: n } };
  }
  if (edit.kind === "text") {
    const s = String(value ?? "").trim() || null;
    const key = edit.field === "primary_audience" ? "primary" : edit.field === "secondary_audience" ? "secondary" : "fba_weight";
    return { db: { [edit.field]: s }, row: { [key]: s } };
  }
  if (edit.kind === "multi") {
    const picked = new Set(Array.isArray(value) ? value.map(String) : []);
    const map = Object.fromEntries(edit.options.map((o) => [o, picked.has(o)]));
    return { db: { retarget: map }, row: { retarget_yes: edit.options.filter((o) => picked.has(o)) } };
  }
  const content = { ...(row.content ?? {}), [edit.key]: Boolean(value) };
  return { db: { content }, row: { content } };
}

// ── delivery vs FBA, by forecast zone ───────────────────────────────────────────────────────────
// Ship state → FBA forecast zone, exactly as the daily "FBA Forecasting <date>.xlsx" groups sales
// (its 30_days_sales tab, 16 Nov 2026). States absent there (Lakshadweep …) have no zone.
export const STATE_ZONE: Record<string, string> = {
  "Andaman & Nicobar Islands": "Tamilnadu_zone", "Andhra Pradesh": "Telangana_zone", "Arunachal Pradesh": "Assam_zone", Assam: "Assam_zone",
  Bihar: "bihar_zone", Chandigarh: "Punjab_zone", Chhattisgarh: "Nagpur_zone", "Dadra and Nagar Haveli and Daman and Diu": "Maharashtra_zone",
  Delhi: "Delhi_zone", Goa: "Karnataka_zone", Gujarat: "gujarat_zone", Haryana: "Delhi_zone", "Himachal Pradesh": "Punjab_zone",
  "Jammu & Kashmir": "Punjab_zone", Jharkhand: "bihar_zone", Karnataka: "Karnataka_zone", Kerala: "Karnataka_zone", Ladakh: "Punjab_zone",
  "Madhya Pradesh": "Nagpur_zone", Maharashtra: "Maharashtra_zone", Manipur: "Assam_zone", Meghalaya: "Assam_zone", Mizoram: "Assam_zone",
  Nagaland: "Assam_zone", Odisha: "Odisha_zone", Puducherry: "Tamilnadu_zone", Punjab: "Punjab_zone", Rajasthan: "Rajasthan_zone",
  Sikkim: "Assam_zone", "Tamil Nadu": "Tamilnadu_zone", Telangana: "Telangana_zone", Tripura: "Assam_zone", "Uttar Pradesh": "Uttarpradesh_zone",
  Uttarakhand: "Delhi_zone", "West Bengal": "WestBengal_zone",
};
export const zoneLabel = (z: string) => z.replace(/_zone$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

export type ZoneFacts = { zone: string; pincodes: number; avg_days: number | null; max_days: number | null; slow: number; unavailable: number; orders_30d: number | null; stock: number | null };
export type ZoneVerdict = { code: "no-check" | "slow-no-orders" | "slow-selling" | "no-stock" | "fast-no-orders" | "ok"; text: string; tone: "critical" | "warning" | "info" | "good" | "none" };

/** Slow delivery days alone are a guess at why orders are missing, so the wording says "likely", and
 *  "no orders" is only said when the forecast has a 0 for that zone (a missing row is not 0). */
export const SLOW_DAYS = 5;
export function zoneVerdict(f: ZoneFacts): ZoneVerdict {
  if (!f.pincodes || f.avg_days === null) return { code: "no-check", text: "No delivery check in this zone", tone: "none" };
  const slow = f.avg_days > SLOW_DAYS;
  const noOrders = f.orders_30d === 0;
  if (slow && noOrders) return { code: "slow-no-orders", text: `Delivery ${f.avg_days} d avg and no orders in 30 d — slow delivery is the likely reason; send FBA stock here`, tone: "critical" };
  if (f.stock === 0 && noOrders) return { code: "no-stock", text: "No FBA stock and no orders — stock this zone to test demand", tone: "warning" };
  if (slow) return { code: "slow-selling", text: `Selling despite ${f.avg_days} d delivery — faster stock here could add orders`, tone: "warning" };
  if (noOrders) return { code: "fast-no-orders", text: `Delivery is fine (${f.avg_days} d) but no orders — demand / ads / listing, not delivery`, tone: "info" };
  return { code: "ok", text: "Delivery and orders look fine", tone: "good" };
}

/** A competitor_analysis row belongs to our product when its our_asin is the ASIN, or its "|"-separated
 *  our_sku list shares a SKU with the product's listing SKUs (Flipkart rows carry no our_asin). */
export function ourProduct(c: { our_asin?: string | null; our_sku?: string | null }, asin: string, skus: string[]): boolean {
  if (c.our_asin && c.our_asin === asin) return true;
  if (!c.our_sku || !skus.length) return false;
  const norm = (s: string) => s.replace(/\((AM|FK|Meesho)\)$/i, "").trim().toUpperCase();
  const mine = new Set(skus.map(norm));
  return c.our_sku.split("|").some((s) => mine.has(norm(s)));
}

// ── ads on / off suggestion ─────────────────────────────────────────────────────────────────────
// Stock gate = the client's FBA ad-status rule (fbaWarehouseAlerts.ts, 2026-10-09): ads need stock in
// 8+ of the "Yes" FCs; a stocked FC at 20 units or less is a warning. Then rating, then same-product
// price. A rule, not a forecast: every suggestion carries its reasons, and missing data is said, not
// assumed.
export const ADS_MIN_FCS = 8;
export const ADS_LOW_UNITS = 20;
export const ADS_MIN_STAR = 3.5;
export const ADS_PRICE_GAP = 1.5; // our price above 1.5x the cheapest same-product competitor
export type AdsInput = {
  fcKnown: boolean; fcStocked: number; fcOnboarded: number; fcLow: number;
  star: number | null; ourPrice: number | null; compPrice: number | null; adOn: boolean;
};
export type AdsSuggestion = { action: "Turn ON" | "Keep ON" | "Turn OFF" | "Keep OFF" | "Review first" | "Check data"; tone: "good" | "critical" | "warning" | "none"; reasons: string[] };
export function adsSuggestion(i: AdsInput): AdsSuggestion {
  const off = (reason: string, extra: string[] = []): AdsSuggestion => ({ action: i.adOn ? "Turn OFF" : "Keep OFF", tone: "critical", reasons: [reason, ...extra] });
  if (!i.fcKnown) return { action: "Check data", tone: "none", reasons: ["No FBA stock file imported — cannot judge"] };
  if (i.fcStocked < ADS_MIN_FCS) {
    return off(`Stock in only ${i.fcStocked} of ${i.fcOnboarded} FBA FCs (needs ${ADS_MIN_FCS}+) — buyers would get slow delivery`);
  }
  if (i.star !== null && i.star < ADS_MIN_STAR) return off(`Rating ${i.star}★ — fix reviews before paying for clicks`);
  const reasons = [`Stock in ${i.fcStocked} of ${i.fcOnboarded} FCs`];
  reasons.push(i.star === null ? "No rating on file" : `Rating ${i.star}★`);
  if (i.fcLow > 0) reasons.push(`${i.fcLow} stocked FC${i.fcLow > 1 ? "s" : ""} at ≤${ADS_LOW_UNITS} units — restock soon`);
  const gap = i.ourPrice !== null && i.compPrice !== null && i.compPrice > 0 && i.ourPrice > i.compPrice * ADS_PRICE_GAP;
  if (gap) {
    reasons.push(`Same product sells at ₹${i.compPrice} vs our ₹${i.ourPrice} — ads may not convert`);
    return { action: i.adOn ? "Keep ON" : "Review first", tone: "warning", reasons: i.adOn ? [...reasons, "Watch ACOS closely"] : [...reasons, "Check price before turning ads on"] };
  }
  if (i.compPrice === null) reasons.push("No same-product competitor price on file");
  return { action: i.adOn ? "Keep ON" : "Turn ON", tone: i.fcLow > 0 ? "warning" : "good", reasons };
}

// ── our selling price ───────────────────────────────────────────────────────────────────────────
// barm_amazon_price_listing.price is the M.R.P. (the All-Listings export has no price column, so the
// upload saves M.R.P. there — see the "Price upload MRP fallback" note). The selling price comes from
// the rating & review bot's Amazon page price, else the FBA inventory report's your-price.
export type OurPrice = { price: number | null; source: "rating bot (Amazon page)" | "FBA inventory report" | null; mrp: number | null };
export function ourSellingPrice(botPrice: unknown, fbaPrice: unknown, listingPrice: unknown): OurPrice {
  const n = (v: unknown) => { const x = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(x) || x <= 0 ? null : x; };
  const mrp = n(listingPrice);
  if (n(botPrice) !== null) return { price: n(botPrice), source: "rating bot (Amazon page)", mrp };
  if (n(fbaPrice) !== null) return { price: n(fbaPrice), source: "FBA inventory report", mrp };
  return { price: null, source: null, mrp };
}

// ── TAM suggestions ─────────────────────────────────────────────────────────────────────────────
// TAM = potential buyers in India × our selling price, the template's own formula (Postpartum kit:
// 1,43,00,000 × ₹2,699). Buyers come from researched public figures stored per audience group in
// mkt_tam_research (with sources); this maps a product to its group. A suggestion only — the team
// accepts it into mkt_product_profile.tam_value. Order matters: specific before general.
const TAM_RULES: [RegExp, string][] = [
  [/insemination|iui|conception cup|male fertility/i, "fertility_home_insemination"],
  [/ovulation|pregnancy kit/i, "trying_to_conceive_testing"],
  [/menopause/i, "menopause"],
  [/c-?\s?section|postpartum|perineal|ice maxi|sitz|bidet|pregnancy soak/i, "postpartum"],
  [/breast|nipple|flange|lactation|nursing cup/i, "breastfeeding"],
  [/dilator|\bvd combo/i, "vaginal_dilator"],
  [/period pain|tens\b/i, "dysmenorrhea"],
  [/\buti\b/i, "uti_women"],
  [/cradle|neem wood comb/i, "cradle_cap"],
  [/eye patch/i, "amblyopia_eye_patch"],
  [/nasal (syringe )?aspirator/i, "infant_nasal_aspirator"],
  [/nebuli/i, "nebulizer"],
  [/peak\s?flow/i, "peak_flow_meter"],
  [/\brmt\b|respiratory muscle/i, "respiratory_muscle_trainer"],
  [/nasal (suction )?(power )?(suction )?irrigat|nascool/i, "nasal_irrigation"],
  [/\bmrd\b|mucus/i, "mucus_removal_device"],
  [/gluco/i, "diabetes_self_monitoring"],
  [/\bbp monitor/i, "hypertension_bp_monitor"],
  [/lacto\s?spark|lactate/i, "lactate_meter"],
  [/suture|anatomy/i, "medical_students_suturing"],
  [/stethe?o?scope|stethescope/i, "healthcare_professionals_stethoscope"],
  [/headache/i, "migraine_headache"],
  [/nail fungus/i, "onychomycosis"],
  [/hook therapy|therapy stick|ir ther(a)?py lamp/i, "chronic_back_neck_pain"],
  [/iv set|winset/i, "clinics_iv_sets"],
  [/chewy|teething|oral muscle|articulation|jaw|lip muscle|tongue|speech therapy|sensory brush|therapressure/i, "speech_oral_motor_therapy"],
  [/fidget|iq puzzle/i, "sensory_fidget_iq_puzzles"],
  [/chok/i, "choking_rescue_device"],
  [/thermometer|insect bite|cutlery/i, "household_thermometer_ir"],
  [/epsom/i, "epsom_salt_bath"],
  [/muscle exerciser|resistance/i, "adult_fitness_muscle_exerciser"],
];
export function tamGroup(productName: string | null | undefined): string | null {
  const n = productName ?? "";
  return TAM_RULES.find(([re]) => re.test(n))?.[1] ?? null;
}
export function tamSuggestion(buyers: number | null | undefined, price: number | null | undefined): number | null {
  if (!buyers || !price || buyers <= 0 || price <= 0) return null;
  return Math.round(buyers * price);
}
