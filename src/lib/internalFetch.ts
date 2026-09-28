import { INTERNAL_AUTH_HEADER, internalSecret } from "@/lib/apiAuth";

// Every automated call this app makes back into its own API routes — the cron route calling
// daily-digest/campaign-state-check/live-alerts/weekly-report, and each of those calling
// send-email — hits the same deployment URL a real visitor would. Vercel Authentication (SSO
// protection) is enabled project-wide except on custom domains, and this project has none, so
// those follow-up server-to-server fetches get a 401 "Protected deployment" response just like
// any other unauthenticated request. Vercel's own Cron trigger is exempted automatically, which
// is why the outer /api/cron/scheduled-reports call succeeds while everything it calls does not.
//
// The fix is Vercel's documented one: a Protection Bypass for Automation secret, generated once
// in Project Settings -> Deployment Protection and exposed to all environments (including
// production) as VERCEL_AUTOMATION_BYPASS_SECRET. Sending it as this header lets the request
// through without disabling protection for real visitors.
//
// The destination is never built from the incoming request's Host header: internalFetch attaches
// secrets (the bypass secret and INTERNAL_API_SECRET), and a forged Host on a self-hosted or dev
// server would have sent them to an attacker's host. Instead, in priority order:
//   1. APP_INTERNAL_ORIGIN — explicit, e.g. "https://marketplace360.example.com"
//   2. https://$VERCEL_URL — set by Vercel itself to this exact deployment's URL (always https;
//      Vercel 308-redirects http, which drops POST bodies)
//   3. http://localhost:$PORT — local `next dev` / `next start`
export function internalOrigin(): string {
  const configured = process.env.APP_INTERNAL_ORIGIN;
  if (configured) return new URL(configured).origin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

// Signs every server-to-server call with INTERNAL_API_SECRET (see src/lib/apiAuth.ts); the cron-
// only and internal routes reject anything unsigned. Refuses outright to send to any origin other
// than internalOrigin(), so the secrets can only ever go back to this app.
export async function internalFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (new URL(url).origin !== internalOrigin()) {
    throw new Error(`internalFetch refused ${new URL(url).origin}: only ${internalOrigin()} may receive internal credentials`);
  }
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const secret = internalSecret();
  if (!secret) {
    console.error("[Marketplace360] INTERNAL_API_SECRET is not set — internal API calls will be rejected. Set it in Vercel -> Project Settings -> Environment Variables.");
  }
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
    ...(secret ? { [INTERNAL_AUTH_HEADER]: secret } : {}),
  };
  const res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    const bodyText = await res.clone().text().catch(() => "");
    if (bodyText.includes("Protected deployment")) {
      console.error(
        `[Marketplace360] Internal call to ${url} was blocked by Vercel Deployment Protection.` +
          (bypass
            ? " A bypass secret was sent but still got rejected — it may be stale; regenerate it in Vercel -> Project Settings -> Deployment Protection -> Protection Bypass for Automation."
            : " VERCEL_AUTOMATION_BYPASS_SECRET is not set in this environment — generate one in Vercel -> Project Settings -> Deployment Protection -> Protection Bypass for Automation, which adds it automatically.")
      );
    }
  }

  return res;
}
