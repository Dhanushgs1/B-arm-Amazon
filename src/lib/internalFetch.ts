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
// `x-forwarded-proto` is absent on some inbound requests to these Pages API routes (seen in
// practice for the cron-triggered and route-to-route calls that matter most here), so every
// caller that used `req.headers["x-forwarded-proto"] || "http"` was silently building an
// http:// URL against an https-only Vercel deployment. Vercel 308-redirects http -> https, and
// that redirect drops the POST body in production, turning every internal report/email call
// into a same-error-looking failure with no indication of why. There is no legitimate case
// where a Vercel production deployment serves plain http, so infer the protocol from the host
// instead of trusting the header: https everywhere except localhost dev.
export function internalOrigin(req: { headers: { host?: string } }): string {
  const host = req.headers.host || "";
  const proto = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  return `${proto}://${host}`;
}

export async function internalFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
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
