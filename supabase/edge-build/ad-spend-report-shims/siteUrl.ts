// Edge (Deno) stand-in for src/lib/siteUrl.ts — same value as the live v62 bundle.
// deno-lint-ignore no-explicit-any
declare const Deno: any;
export const SITE_URL: string = Deno.env.get("NEXT_PUBLIC_SITE_URL") || "https://amazon-ppc-analytics-dashboard.vercel.app";
