# API security

How the ppc-dashboard's API routes and Supabase Edge Functions authenticate requests, and what has
to be configured for them to work. Every mechanism **fails closed**: if its secret is missing, the
route refuses to run rather than opening up.

## Mechanisms

| Mechanism | Header / cookie | Secret | Used by |
|---|---|---|---|
| Cron | `Authorization: Bearer <CRON_SECRET>` | `CRON_SECRET` | `/api/cron/scheduled-reports` (Vercel Cron), `/api/cron/campaign-monitor` (external scheduler) |
| Internal | `x-m360-internal: <INTERNAL_API_SECRET>` | `INTERNAL_API_SECRET` | Server-to-server calls via `internalFetch`, Vercel → Edge Functions, pg_cron → Edge Function |
| Dashboard session | `m360_session` HttpOnly cookie | `DASHBOARD_PASSWORD` (+ `INTERNAL_API_SECRET` as signing key) | Every browser-facing API route |

Code: `src/lib/apiAuth.ts`, `src/lib/emailSendPolicy.ts`, `src/lib/internalFetch.ts`,
`src/proxy.ts`, `supabase/functions/_shared/internalAuth.ts`.

## Route map

| Route | Accepts |
|---|---|
| `cron/scheduled-reports`, `cron/campaign-monitor` | Cron only |
| `daily-digest`, `live-alerts`, `campaign-state-check`, `stockout-alert`, `ad-alerts`, App `generate-historical-report` | Internal only |
| `send-email` | Internal (any template), or session (`test` to the typed address; `confirmation`/`campaign` to the **saved** recipients; never `custom`, subject override or attachments) |
| `weekly-report`, `send-historical-email`, `send-ad-spend-email` | Session or internal. Browser requests never choose recipients: saved settings (`recipients:"saved"`) or the fixed distribution list |
| `email-settings`, `generate-ad-spend-report`, `generate-fba-forecast-report`, `*-report-status` | Session or internal |
| `tool` (SellerMate proxy) | Session |
| App `gemini-insights` (30/10 min/IP), `daily-ad-spend-insights` (10/10 min/IP) | Session + rate limit |
| `auth/login`, `auth/logout` | Public (login is rate limited: 10 attempts/15 min/IP) |
| `sm` (`/sm/*` rewrite) | Caller's own SellerMate key; no server credentials |
| Edge `generate-ad-spend-report`, `generate-fba-forecast-report`, `send-ad-spend-email` | Internal only |

## Deployment checklist

1. **Vercel → Project Settings → Environment Variables** (Production and Preview):
   `CRON_SECRET`, `INTERNAL_API_SECRET`, `DASHBOARD_PASSWORD` — long random values.
   Optional: `APP_INTERNAL_ORIGIN` (defaults to `https://$VERCEL_URL`).
2. **External scheduler** (cron-job.org or similar) for `/api/cron/campaign-monitor`: add the header
   `Authorization: Bearer <CRON_SECRET>`.
3. **Supabase function secret**: `supabase secrets set INTERNAL_API_SECRET=<same value>`, then
   redeploy the three Edge Functions (`supabase functions deploy <name>`; `verify_jwt = false` is
   in `supabase/config.toml`).
4. **pg_cron** (only if the daily ad-spend job is scheduled): store the secret in Vault with
   `select vault.create_secret('<same value>', 'internal_api_secret');` and re-run the
   `cron.schedule(...)` in `scripts/ad_spend_report_pg_cron.sql`. The old job sends no header and
   will get 401s.
5. `.env.local` for local dev needs the same three variables. `generate-report-now.sh` needs
   `INTERNAL_API_SECRET` exported in the shell.

Order matters: set the env vars and Supabase secret **before** deploying this code. Otherwise
cron, email and report generation stop — they fail closed.

## Known gaps (not fixed by this change)

- **Supabase RLS is off by design.** The scripts in `scripts/` disable RLS and grant `anon` full
  access to the `barm_*` tables, `email_settings`, `report_generation_jobs`,
  `daily_ad_spend_reports`, `fba_forecast_reports` and the report storage buckets. The anon key
  is public (it ships in the browser bundle), so anyone can read or write those tables directly
  through Supabase's REST API, bypassing every route above — including rewriting
  `email_settings.notifEmail`. Fixing this needs a server-only service-role key, RLS enabled
  with deny-by-default policies, and moving the browser's direct Supabase reads behind API routes.
- **One shared password.** No per-user identity or audit trail; the username only picks a slot.
- **Rate limits are per serverless instance**, not global.
- `/api/sm` is an open CORS proxy (it forwards the caller's own SellerMate key).
