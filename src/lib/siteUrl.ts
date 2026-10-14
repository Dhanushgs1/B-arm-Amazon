// Base URL for links embedded in outbound emails (Open Dashboard, Manage Alerts,
// View Inventory, etc). Defaults to the production Vercel deployment; override with
// NEXT_PUBLIC_SITE_URL (e.g. once a custom domain is attached) without another code change.
// A localhost override (.env.local sets one so local Ad Spend Report links resolve) is ignored on
// the production deployment, so a leaked local value can never put localhost links in real mail.
export const PRODUCTION_SITE_URL = "https://amazon-ppc-analytics-dashboard.vercel.app";

export function resolveSiteUrl(env: Record<string, string | undefined> = process.env): string {
  const v = env.NEXT_PUBLIC_SITE_URL;
  if (!v) return PRODUCTION_SITE_URL;
  if (env.VERCEL_ENV === "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(v)) return PRODUCTION_SITE_URL;
  return v;
}

export const SITE_URL = resolveSiteUrl();
