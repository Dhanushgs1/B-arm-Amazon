// Base URL for links embedded in outbound emails (Open Dashboard, Manage Alerts,
// View Inventory, etc). Defaults to the production Vercel deployment; override with
// NEXT_PUBLIC_SITE_URL (e.g. once a custom domain is attached) without another code change.
export const SITE_URL = Deno.env.get("NEXT_PUBLIC_SITE_URL") || "https://amazon-ppc-analytics-dashboard.vercel.app";
