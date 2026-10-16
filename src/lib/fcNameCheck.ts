// "Name in the Current stock sheet but not in the FC sheet" mail (user, 2026-10-16). After either upload
// on the Consolidated Stock Sheet, every product in the latest Current stock sheet (restock inputs) is
// looked up in the latest godown "FC Stock sheet"; names with no match are mailed to the FC sheet
// handler and the team (FC_ALERT_TO / FC_ALERT_CC) so the FC sheet gets them. src/pages/api/fc-name-alert.ts sends it; every check
// is logged in barm_fc_name_alerts, which the page shows as the mail status.

import { productKey } from "./consolidatedStock.ts";
import { keptGodownName } from "./godownProductAliases.ts";

// Recipients (user, 2026-10-16): arun.a is the FC sheet handler.
export const FC_ALERT_TO = ["sharmilambarm@gmail.com", "arun.a@b-arm.com"];
export const FC_ALERT_CC = [
  "gokilabarm@gmail.com", "mathumithabarm@gmail.com", "deena@b-arm.com", "kavinilavan@b-arm.com", "chandru.m@b-arm.com",
  "sruthisri@barmenterprises.com", "kaviyapriyabarm@gmail.com", "aravindh.l@b-arm.com", "harshineebarm@gmail.com",
  "akshaya.v@b-arm.com", "manoj.j@b-arm.com", "prinesh@b-arm.com", "\"Prashanth B-Arm\" <prashanthbarm@gmail.com>",
  "nivetha@b-arm.com", "sriram@b-arm.com", "duvaraga@b-arm.com",
];

// Never mailed (user, 2026-10-16, after the 25-product mail): Current stock sheet names the team does not
// want in the FC sheet. Matched with productKey, so case / spacing differences do not matter. Anything
// else missing from the FC sheet (e.g. a new product) is still mailed.
export const FC_IGNORED_NAMES = [
  // Not to be added to the FC sheet
  "Neck traction pillow (Blue)",
  "Neck traction pillow (green)",
  "Sensory brush",
  "Suture Practice pad(MW)",
  "Baby nasal aspirator - hand pump (white model)",
  "Contact lens cleaner",
  "Cradle cap scrub",
  "Cradle cap brush",
  "Cradle cap comb - double sided",
  "Syringes for nasal aspirator",
  "Pregnancy kit combo with Ovulation thermometer",
  "IQ puzzles (Autism)",
  "IUI Catheter and Syringes (Insemination kit)",
  "Bulb Syringe IUI applicator -8cm(Pack of 5)",
  "IR Bulb",
  // Not restocked
  "Baby nasal aspirator (hand pump-Pink)",
  "Instant Breast warmers (Red)",
  "Warming Lactation Massager (Green)",
  "Warming Lactation Massager (Dark Pink)",
  "Wearable lactation massager (Purple)",
  "Wearable lactation massager (Grey)",
  "Pelvic muscle floor trainer (screw type) - Blue",
  "Digital pelvic muscle trainer- new model",
  "Nail cleaning device",
  "Semi- Transparent Human Model",
];

export type FcAlertStatus = "sent" | "failed" | "nothing_missing" | "already_sent" | "paused";

export interface FcAlertRow {
  id: number;
  checked_at: string;
  trigger: string;
  restock_date: string | null;
  godown_date: string | null;
  missing: string[];
  recipients: string;
  status: FcAlertStatus;
  error: string | null;
}

/** Current stock sheet names with no product of the same name in the FC sheet, in file order, leaving
 *  out FC_IGNORED_NAMES. Both sides go through the godown aliases (src/lib/godownProductAliases.ts)
 *  and productKey. */
export function missingFromFc(restockNames: string[], godownNames: string[]): string[] {
  const fc = new Set(godownNames.map((n) => productKey(keptGodownName(n))));
  // Ignored names match as written and under their godown rename; the rename map is case-sensitive,
  // so "WEARABLE LACTATION MASSAGER (PURPLE)" is only caught by its own key.
  const ignored = new Set(FC_IGNORED_NAMES.flatMap((n) => [productKey(n), productKey(keptGodownName(n))]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of restockNames) {
    const name = String(raw ?? "").replace(/\s+/g, " ").trim();
    const key = productKey(keptGodownName(name));
    if (!key || fc.has(key) || seen.has(key) || ignored.has(key) || ignored.has(productKey(name))) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Same list of names (any order, any case) — the mail is not sent twice for it. */
export const sameNames = (a: string[], b: string[]) => {
  const k = (x: string[]) => [...new Set(x.map((n) => productKey(n)))].sort().join("\n");
  return k(a) === k(b);
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const dmy = (iso: string | null) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : "—");

export function fcAlertSubject(missing: string[], restockDate: string | null) {
  return `FC sheet: ${missing.length} product${missing.length === 1 ? "" : "s"} from the Current stock sheet of ${dmy(restockDate)} not found`;
}

export function fcAlertHtml(missing: string[], restockDate: string | null, godownDate: string | null) {
  const rows = missing.map((n, i) =>
    `<tr><td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;width:32px;">${i + 1}</td><td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:14px;font-weight:600;color:#111827;">${esc(n)}</td></tr>`).join("");
  return `
    <h2 style="margin:0 0 8px;color:#111827;font-size:19px;font-weight:800;">Products missing in the FC Stock sheet</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:14px;line-height:1.5;">
      These ${missing.length} product name${missing.length === 1 ? " is" : "s are"} in the <b>Current stock sheet of ${dmy(restockDate)}</b>
      but not in the <b>Combined godown stock sheet as on ${dmy(godownDate)}</b> (FC Stock sheet). Please add ${missing.length === 1 ? "it" : "them"}
      to the FC sheet, or correct the spelling to match the FC sheet, so the Consolidated Stock Sheet gets their stock and sales.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;">
      <tr><td style="padding:8px 10px;background:#f9fafb;font-size:11px;font-weight:800;color:#6b7280;">#</td><td style="padding:8px 10px;background:#f9fafb;font-size:11px;font-weight:800;color:#6b7280;">PRODUCT (as in the Current stock sheet)</td></tr>
      ${rows}
    </table>`;
}
