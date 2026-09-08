# Daily Ad Spend Report (SKU-wise) — Async Architecture Design

Date: 2026-09-08
Status: Approved by user. Both open decisions resolved (see "Resolved decisions" below). Proceeding to implementation plan.

## Problem

The "Send" button on `reports/page.tsx` (Ad Spend section) synchronously runs the
entire Daily Ad Spend Report pipeline inside a single Vercel serverless
request: a 3-platform Supabase fetch, SKU resolution, GST tagging, Gemini
Action Sheet suggestions, XLSX workbook build, history upsert, and finally an
email send over Gmail SMTP. Real wall-clock time is ~90-200+ seconds. Vercel's
Hobby plan hard-caps every serverless invocation at 10 seconds regardless of
any `maxDuration` config, so this route is effectively broken in production
(silent 504s) whenever the underlying work takes longer than that cap — which
it always does.

Two independent slow paths exist inside this one request:
1. The report computation itself (marketplace fetch + calculation + Gemini calls).
2. The email transport (`send-email.ts`, nodemailer over Gmail SMTP — observed
   65-160+ seconds on its own, per that file's own comments).

## Non-negotiable requirements

- **Do not upgrade the Vercel plan.**
- **Do not depend on a long-running Vercel request** for either computation or
  email dispatch.
- **The selected report date must never change.** Whatever `endDate` string
  the user has picked in the dashboard's date selector must be the literal
  value used for every Supabase query, every calculation, the stored report
  row, and the email — with no silent fallback to "today" and no timezone
  reinterpretation, on the manual (dashboard-triggered) path.
- **Do not modify existing calculation formulas, SKU-mapping rules,
  marketplace integration logic, or date-selection UI behavior** unless
  strictly required by this restructuring. Reuse working logic as-is.
- **Reuse existing Supabase tables/fields instead of duplicating** wherever
  they already cover the need.
- Supabase becomes the source of truth for the *generated* report; Vercel's
  role is reduced to enqueuing work and reading/formatting/dispatching
  already-computed results.

## Why the date is safe to carry through unchanged

`getDateWindow(toDate, days)` in `src/lib/adSpendReportExport.ts:53` computes
the report's date window with pure UTC-midnight arithmetic on the `toDate`
string (`new Date(\`${toDate}T00:00:00Z\`)`, then `setUTCDate`) — it never
reads the server clock or a local timezone. The dashboard's `endDate` is a
plain `"YYYY-MM-DD"` string held in `DashboardContext.tsx`, and every Ad
Spend button on `reports/page.tsx` is disabled until a date is explicitly
picked (`disabled={adSpendGenerating || !endDate}`, `reports/page.tsx:552`,
`:567`). `send-ad-spend-email.ts:44-51` only defaults `endDate` to "yesterday"
when the field is *absent from the request body entirely* — a path exercised
only by the daily cron, never by a user click, since the button cannot fire
without a date. This design does not touch `getDateWindow`, the date picker,
or the cron's own default; it only relocates where the already-selected
string is consumed, and the string is never parsed into a `Date`, reformatted,
or re-derived anywhere in the new pipeline except inside `getDateWindow`
itself.

## Architecture: Supabase Edge Functions do the heavy work

Considered and rejected: (B) chunked/checkpointed computation kept entirely
inside Vercel (fragile 10-20-step resumable state machine, doesn't solve the
slow-email problem either), and (C) an external worker outside both Vercel
and Supabase, e.g. a scheduled GitHub Action (introduces a third hosting
dependency and doesn't make Supabase the thing doing the generation, which
was explicitly requested).

Chosen: a Supabase Edge Function performs the full computation
(fetch → SKU resolution → calculation → Gemini Action Sheet text), invoked
either by `pg_cron`/`pg_net` on a daily schedule or by a thin Vercel route on
a manual "Generate" click. The function acknowledges quickly and continues
via `EdgeRuntime.waitUntil(...)`, decoupling its actual runtime from any
Vercel request lifetime. Vercel's "Send" route becomes read-only: it looks up
job status, reads the persisted report, formats HTML/XLSX from already-fetched
data (fast, in-memory, no Supabase joins), and hands off email dispatch.

### Data flow

```
Dashboard endDate (string, e.g. "2026-09-05")
  → Generate click sends { report_date: endDate, ... } — literal string, no reformatting
  → Vercel /api/generate-ad-spend-report upserts report_generation_jobs.report_date = that exact string
  → Edge Function invocation payload carries the SAME string (no default, no "today")
  → Edge Function calls getDateWindow(report_date, days) — identical function, identical output
  → every Supabase read (Amazon/Flipkart/Meesho/SKU tables) filters on that window/date
  → barm_ad_spend_history rows written with report_date = that exact string
  → daily_ad_spend_reports row written with report_date = that exact string
  → report_generation_jobs.status → completed for that (report_date, report_type, account_name)
  → Send click sends { report_date: endDate, ... } — same literal string from the same dashboard state
  → /api/send-ad-spend-email reads report_generation_jobs / barm_ad_spend_history / daily_ad_spend_reports
    all filtered on that identical string
  → email subject/body/workbook show that date, not "today"
```

### Tables

**Raw/uploaded data (unchanged, reused as-is):** `barm_daily_am_orders`,
`barm_daily_fk_orders`, `barm_amazon_sp_advertised_product`,
`barm_amazon_sb_campaign`, `barm_amazon_sd_campaign`,
`barm_amazon_price_listing`, `barm_flipkart_fsn_report`,
`barm_flipkart_earn_more`, `barm_flipkart_listings`, `barm_meesho_ads`,
`barm_meesho_orders`, `meesho_price_marketing`, plus SKU-resolver tables
`master_product_marketing`, `master_product_skuid`, `barm_product_master`. No
schema changes; read-only from the Edge Function, exactly as
`adSpendReportExport.ts` reads them today.

**Calculated results — reused/extended, not duplicated:**
- `barm_ad_spend_history` (existing) — per-SKU flat metrics, unique on
  `(report_date, platform, sku)`. Extended only if the open "extra metrics"
  decision below calls for new columns.
- `daily_ad_spend_reports` (new) — one JSON row per `(report_date,
  account_name)` holding the Summary/Action Sheet (incl. Gemini text)/Ad
  Status Report/Low Spend Campaigns content the email needs beyond flat
  metrics. Unique on `(report_date, account_name)`.

**Job/status tracking (new):** `report_generation_jobs` — `id, report_date,
report_type, status (pending/processing/completed/failed), started_at,
completed_at, error_message, account_name, email_status, email_sent_at,
email_error, created_at, updated_at`. Unique on `(report_date, report_type,
account_name)`. The `email_*` columns fold "report history" (requirement #9)
into this same table rather than adding a fourth one.

### Duplicate prevention (three layers, all upsert-on-conflict, none recompute)

- `report_generation_jobs` unique `(report_date, report_type, account_name)` —
  Generate checks this key first; an existing `processing`/`completed` job
  for that exact date is returned as-is, no second job created, no duplicate
  Edge Function invocation. The explicit Retry/Regenerate action is the only
  caller allowed to bypass this short-circuit (see "Explicit Generate vs.
  Retry/Regenerate semantics" below).
- `barm_ad_spend_history` unique `(report_date, platform, sku)` (already
  exists) — reruns upsert safely.
- `daily_ad_spend_reports` unique `(report_date, account_name)` (new) — a
  rerun replaces that one row, never inserts a second.

### Historical dates

Every table above is keyed by `report_date` as a literal value, not "most
recent". Moving the date picker back to `2026-09-03` and clicking
Generate/Send queries everything filtered on `report_date = '2026-09-03'`
specifically. An already-generated historical date returns its existing
`completed` job immediately with no recompute; a never-generated one computes
fresh using whatever raw data exists for that date, with the same
tolerant/empty-data behavior as today.

### Send (rewritten, lightweight)

`/api/send-ad-spend-email` takes the selected date from the request body
exactly as it does today, then:
1. Looks up `report_generation_jobs` for `(report_date, 'ad_spend_daily',
   account_name)`.
2. Not `completed` → returns "Report is still being generated" / the stored
   `error_message`; does not start a new job.
3. `completed` → reads `daily_ad_spend_reports` + `barm_ad_spend_history` rows
   filtered by that same `report_date`, builds HTML/XLSX from that data only,
   flips `email_status` to `sending`, and invokes the `send-ad-spend-email`
   Edge Function (awaiting only its fast ack, not the SMTP send itself)
   before returning `{ success, status: "sending" }`. No marketplace fetch,
   no SKU resolution, no Gemini call, no formula execution, and no blocking
   SMTP wait on this path.

### Files expected to change

- `src/pages/api/send-ad-spend-email.ts` — rewritten to be read-only/lightweight.
- `src/pages/api/cron/ad-spend-history.ts` — retired or reduced to a thin
  trigger, replaced by the `pg_cron` → Edge Function path.
- New `src/pages/api/generate-ad-spend-report.ts` — lightweight "Generate" endpoint.
- `src/lib/adSpendReportExport.ts` — computation logic ported into a Supabase
  Edge Function (formulas/resolvers reused verbatim); the Vercel side keeps
  only what's needed to format an already-computed report.
- `src/app/dashboard/reports/page.tsx` — Send/Generate button wiring updated
  to the job-status contract (Generating.../Completed/Sending.../Sent, "still
  generating," "failed — Retry").
- New `supabase/functions/generate-ad-spend-report/` and
  `supabase/functions/send-ad-spend-email/` — the second function runs the
  existing nodemailer/Gmail logic as a background task so Vercel never waits
  on SMTP.
- New SQL migration file(s) under `scripts/` for `daily_ad_spend_reports`,
  `report_generation_jobs`, any `barm_ad_spend_history` extension, and the
  `pg_cron` schedule.
- `vercel.json` — cron entry adjusted or removed if `pg_cron` takes over the
  daily schedule.

## Resolved decisions

1. **Email transport for the async Send: keep Gmail SMTP, make dispatch
   async.** No switch to Resend (not requested; `stratai.io` verification
   status is unconfirmed). Email sending is delegated to a Supabase Edge
   Function background task the same way report generation is: Send flips
   `report_generation_jobs.email_status` to `sending`, invokes the Edge
   Function and awaits only its fast ack, and returns immediately. The Edge
   Function runs the existing nodemailer/Gmail logic from `send-email.ts`
   unmodified inside `EdgeRuntime.waitUntil(...)`, then sets `email_status` to
   `sent` or `failed` (+ `email_error`) and stamps `email_sent_at`. The
   dashboard polls/reflects this field to show "Sending... → Sent
   Successfully" without the Vercel request ever waiting on SMTP.
2. **`clicks`, `impressions`, `roas`, `conversion_rate`: omitted.** They are
   not computed anywhere in the current report logic (ACOS here = CPC/Price,
   not spend/sales; no ROAS/CVR field exists for this report), and inventing
   formulas for them would violate "reuse existing formulas without changing
   business logic." `barm_ad_spend_history` is extended with zero new
   metric columns — only whatever plumbing columns the job/date model
   requires (none are expected; its existing columns already carry
   everything the current formulas produce).

## Explicit Generate vs. Retry/Regenerate semantics

- **Generate** (normal click): checks `report_generation_jobs` for
  `(report_date, 'ad_spend_daily', account_name)` first. `completed` → return
  that job as-is, no recompute. `processing` → return current status, no
  second invocation. Missing or `failed` → create/update the job to `pending`
  and invoke the Edge Function.
- **Retry/Regenerate** (explicit user action, shown only when status is
  `failed`, or as an always-available "Regenerate" affordance): the only path
  that forces recomputation of a date already `completed` — passes an
  explicit `force: true` flag so the API knowingly bypasses the "already
  completed" short-circuit for that one request. Never triggered implicitly.

## Formulas explicitly preserved, not touched

- GST: flat 1.18× multiplier regardless of per-SKU tax rate
  (`gstMultiplierFromTax` in `masterProductSkuid.ts`, deliberate per an
  earlier seller decision — the per-SKU tax plumbing is wired but its result
  is discarded on purpose).
- `spendTax = spend * gstMultiplier`, `CPC = spendTax / units` (or `spendTax`
  if units = 0), `ACOS = CPC / price` (or 0 if price = 0).
- SKU/name resolution precedence: `master_product_marketing` →
  `master_product_skuid` (exact SKU, then SKU-base fallback) →
  `barm_product_master`.
- Order data sourced from `barm_daily_am_orders` / `barm_daily_fk_orders`
  (daily-upload mirrors), not the MIS-pipeline tables.
- Action Sheet: trailing-7-day ACOS > 14% threshold with existing severity
  tiers.
