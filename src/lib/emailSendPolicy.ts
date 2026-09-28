// Who may ask /api/send-email to send what, and to whom.
//
//  - Internal (signed by internalFetch): any template, caller-chosen recipients, subject and
//    attachments — these callers are this app's own server routes, which choose recipients from
//    saved settings or the fixed distribution lists.
//  - Browser (signed-in dashboard session): only the three templates the UI sends itself, never a
//    subject override or attachments, and never "custom" HTML.
//      * test         — goes to the address the user typed, on purpose: "Send Test Email" exists to
//                       check an address before saving it. Its content is fixed.
//      * confirmation, campaign — production alerts. Recipients are resolved server-side from the
//                       saved settings for the request's keySlot; any to/cc in the body is ignored.
//  - Anyone else: rejected.

import { checkSession, isInternalRequest, type HeaderBag } from "./apiAuth.ts";

export const BROWSER_TYPES = new Set(["test", "confirmation", "campaign"]);

export type SendDecision =
  | { ok: false; status: number; error: string }
  | { ok: true; internal: boolean; recipients: "body" | "saved" };

export function decideSend(h: HeaderBag, body: Record<string, unknown>): SendDecision {
  if (isInternalRequest(h)) return { ok: true, internal: true, recipients: "body" };
  const session = checkSession(h);
  if (!session.ok) return session;
  const type = typeof body.type === "string" ? body.type : "test";
  if (!BROWSER_TYPES.has(type) || body.subject || body.attachments) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, internal: false, recipients: type === "test" ? "body" : "saved" };
}
