// "Every Amazon listing of a product is gone" mail to the Listing Team (user, 2026-10-16). For each
// product in the latest Current stock sheet (stock purchase sheet), its Amazon SKU IDs come from
// master_product_skuid. If NONE of them is live on Amazon — each one is inactive / suppressed
// (discontinued) or not on Amazon at all (deleted, maybe by mistake) — the product is mailed.
// A product with at least one active SKU is fine. Live status comes from SellerMate's catalog
// (list_product_catalog with include_suppressed). src/pages/api/listing-alert.ts sends it; every
// check is logged in barm_listing_alerts, shown on the Consolidated Stock Sheet as the mail status.

import { productKey } from "./consolidatedStock.ts";
import { keptGodownName } from "./godownProductAliases.ts";

export const LISTING_ALERT_TO = [
  "\"Sharmila BARM\" <sharmilambarm@gmail.com>", "arun.a@b-arm.com",
];
export const LISTING_ALERT_CC = [
  "\"ceo\" <ceo@barmenterprises.com>", "\"harshineebarm\" <harshineebarm@gmail.com>", "\"Hema Varshini G\" <hema@b-arm.com>",
  "\"jayaprakashbarm\" <jayaprakashbarm@gmail.com>", "\"Prashanth B-Arm\" <prashanthbarm@gmail.com>",
  "\"Kaviyapriya BARM\" <kaviyapriyabarm@gmail.com>", "\"Dan Gibbs\" <dangibbs@b-arm.com>", "\"Nivetha S G\" <nivetha@b-arm.com>",
  "\"Harini BARM\" <harinibarm@gmail.com>", "gokilabarm@gmail.com", "duvaraga@b-arm.com",
];

export type SkuState = "active" | "inactive" | "missing";
export interface SkuCheck { sku: string; state: SkuState; status: string }
export interface ListingProblem { product: string; skus: SkuCheck[] }

/** SellerMate's status (a string or a list, e.g. ["BUYABLE","DISCOVERABLE"] / "INACTIVE"). Anything not
 *  clearly inactive counts as active, so an unknown status never raises a false alarm. */
export function skuState(status: unknown): Exclude<SkuState, "missing"> {
  const tokens = (Array.isArray(status) ? status : [status]).map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean);
  if (!tokens.length) return "active";
  if (tokens.some((t) => ["BUYABLE", "DISCOVERABLE", "ACTIVE"].includes(t))) return "active";
  if (tokens.some((t) => /INACTIVE|SUPPRESS|INCOMPLETE|DISCONTINU|DELETE|CLOSED|STRANDED/.test(t))) return "inactive";
  return "active";
}

const isAmazon = (platform: unknown) => /^amazon/i.test(String(platform ?? "").trim());

/** Products of the Current stock sheet whose Amazon SKUs are all inactive or not on Amazon. Products
 *  with no Amazon SKU in the master table are returned separately (nothing to check). */
export function listingProblems(
  restockNames: string[],
  master: { product: string; sku: string; platform: string }[],
  catalog: Map<string, unknown>,              // SKU → SellerMate status, every SKU on the account
): { problems: ListingProblem[]; noSku: string[] } {
  const skusBy = new Map<string, Set<string>>();
  for (const m of master) {
    const sku = String(m.sku ?? "").trim();
    if (!sku || !isAmazon(m.platform)) continue;
    const k = productKey(keptGodownName(m.product));
    if (!skusBy.has(k)) skusBy.set(k, new Set());
    skusBy.get(k)!.add(sku);
  }
  const problems: ListingProblem[] = [], noSku: string[] = [], seen = new Set<string>();
  for (const raw of restockNames) {
    const name = String(raw ?? "").replace(/\s+/g, " ").trim();
    const k = productKey(keptGodownName(name));
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const skus = [...(skusBy.get(k) ?? [])];
    if (!skus.length) { noSku.push(name); continue; }
    const checks: SkuCheck[] = skus.map((sku) => catalog.has(sku)
      ? { sku, state: skuState(catalog.get(sku)), status: [catalog.get(sku)].flat().join(", ") }
      : { sku, state: "missing", status: "" });
    if (checks.every((c) => c.state !== "active")) problems.push({ product: name, skus: checks });
  }
  return { problems, noSku };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : "—");
export const stateLabel = (c: SkuCheck) => (c.state === "missing" ? "Not on Amazon (deleted?)" : `Inactive / discontinued${c.status ? ` (${c.status})` : ""}`);

export function listingAlertSubject(problems: ListingProblem[], restockDate: string | null) {
  return `Listing alert: ${problems.length} product${problems.length === 1 ? " has" : "s have"} no active Amazon listing (Current stock sheet ${dmy(restockDate)})`;
}

export function listingAlertHtml(problems: ListingProblem[], restockDate: string | null) {
  const rows = problems.map((p, i) => `
    <tr><td style="padding:10px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;vertical-align:top;width:28px;">${i + 1}</td>
    <td style="padding:10px;border-bottom:1px solid #f0f0f0;vertical-align:top;">
      <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#111827;">${esc(p.product)}</p>
      ${p.skus.map((s) => `<p style="margin:0;font-size:12px;color:#374151;">${esc(s.sku)} — <span style="color:${s.state === "missing" ? "#b91c1c" : "#b45309"};font-weight:700;">${esc(stateLabel(s))}</span></p>`).join("")}
    </td></tr>`).join("");
  return `
    <h2 style="margin:0 0 8px;color:#111827;font-size:19px;font-weight:800;">Products with no active Amazon listing</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:14px;line-height:1.5;">
      These ${problems.length} product${problems.length === 1 ? " is" : "s are"} in the <b>Current stock sheet of ${dmy(restockDate)}</b>, but
      <b>every</b> Amazon SKU of ${problems.length === 1 ? "it" : "each"} (from the master SKU sheet) is inactive / discontinued or no longer on Amazon.
      If a listing was discontinued or deleted by mistake, please relist it.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;">
      <tr><td style="padding:8px 10px;background:#f9fafb;font-size:11px;font-weight:800;color:#6b7280;">#</td><td style="padding:8px 10px;background:#f9fafb;font-size:11px;font-weight:800;color:#6b7280;">PRODUCT · AMAZON SKU — STATUS</td></tr>
      ${rows}
    </table>`;
}
