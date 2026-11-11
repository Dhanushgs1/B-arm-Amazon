// One switch for the SellerMate integration on the DASHBOARD SCREENS.
//
// Off (the default since Phase 2, 2026-11): no page, component or browser request touches
// SellerMate. Amazon screens that had no other data source are hidden from the menu and show a
// notice if opened directly; the Amazon Overview, Downloads and Settings run on the uploaded
// reports stored in Supabase only. Set NEXT_PUBLIC_SELLERMATE_ENABLED=true to bring it all back
// exactly as it was; nothing was deleted.
//
// NOT covered by this switch, on purpose: the scheduled emails (Daily Digest, Things Need
// Attention, stock-out, campaign-paused, Weekly Summary). They call SellerMate from the server with
// their own keys and keep running unchanged.

export const SELLERMATE_ENABLED = process.env.NEXT_PUBLIC_SELLERMATE_ENABLED === "true";

export class SellerMateDisabledError extends Error {
  constructor() {
    super("SellerMate is switched off for the dashboard.");
    this.name = "SellerMateDisabledError";
  }
}

// Amazon-side routes whose only data source is SellerMate.
export const SELLERMATE_ONLY_PATHS = [
  "/dashboard/campaigns",
  "/dashboard/adgroups",
  "/dashboard/placements",
  "/dashboard/keywords",
  "/dashboard/searchterms",
  "/dashboard/bids",
  "/dashboard/optimization",
  "/dashboard/marketshare",
  "/dashboard/products",
  "/dashboard/ai",
  "/dashboard/inventory/live",
] as const;

// (/dashboard/inventory is not in the list: with SellerMate off it is built from the uploaded FBA
// Inventory report alone. Only its Live tab is SellerMate-only.)
export function isSellerMateOnlyPath(pathname: string | null | undefined): boolean {
  const p = (pathname || "").replace(/\/+$/, "");
  return SELLERMATE_ONLY_PATHS.some((x) => p === x || p.startsWith(`${x}/`));
}

// Sidebar item ids (Amazon and Overall menus) that lead to SellerMate-only screens.
export const SELLERMATE_ONLY_NAV_IDS = new Set([
  "campaigns", "adgroups", "placements", "keywords", "searchterms", "bids", "optimization",
  "marketshare", "products", "live", "ai",
]);

// The account record used to come from SellerMate's get_user_context. With the integration off
// the dashboard still needs a name (stored reports are filed under it) and a currency.
// Module-level constants so the object identity is stable across renders.
const BARM_ACCOUNT = { id: "", name: "B-ARM", workspace_id: "", currency: "INR" };
const LKN_ACCOUNT = { id: "", name: "LKN", workspace_id: "", currency: "INR" };
export function staticAccountFor(loggedInUser: string): { id: string; name: string; workspace_id: string; currency: string } {
  return loggedInUser === "Barm" ? BARM_ACCOUNT : LKN_ACCOUNT;
}

// Server routes read the switch at request time (bracket access is not inlined at build), so the
// browser-facing SellerMate proxies refuse to relay while the integration is off.
export function sellerMateEnabledOnServer(): boolean {
  return process.env["NEXT_PUBLIC_SELLERMATE_ENABLED"] === "true";
}
