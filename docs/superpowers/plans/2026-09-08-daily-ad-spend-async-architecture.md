# Daily Ad Spend Report Async Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Daily Ad Spend Report (SKU-wise) generation and email dispatch out of synchronous Vercel serverless requests and into Supabase (Edge Functions + Postgres), so neither action can ever hit Vercel's Hobby 10-second timeout, while the selected report date and all existing formulas/business logic stay byte-for-byte unchanged.

**Architecture:** A Supabase Edge Function runs the existing `buildAdSpendReportWorkbook()` (ported verbatim, mechanical Deno adjustments only) in the background (`EdgeRuntime.waitUntil`) and persists its JSON result + XLSX workbook to two new Supabase tables/a Storage bucket, tracked by a `report_generation_jobs` row. A second Edge Function sends the email (nodemailer/Gmail, ported verbatim) also in the background. Two new lightweight Vercel routes enqueue/read these jobs; the existing "Send" route is rewritten to be read-only.

**Tech Stack:** Next.js 16 (Pages Router API routes), Supabase (Postgres + Storage + Edge Functions/Deno), `@supabase/supabase-js`, `xlsx-js-style`, `nodemailer` (Gmail SMTP), Gemini API (Action Sheet suggestions, unchanged).

**Spec:** [docs/superpowers/specs/2026-09-08-daily-ad-spend-async-architecture-design.md](../specs/2026-09-08-daily-ad-spend-async-architecture-design.md)

## Global Constraints

- Do not upgrade the Vercel plan.
- No Vercel route in this feature may perform marketplace data fetching, SKU-wise calculation, or block on email transport — those only run inside Supabase Edge Functions.
- The `report_date` string selected in the dashboard must pass through every layer unchanged — never reformatted, never re-derived from "today," except inside the existing `getDateWindow()` function itself (untouched).
- Do not change `getDateWindow`, the dashboard date picker, or any GST/CPC/ACOS/SKU-resolution formula. Every calculation function ported to Deno must be copied verbatim (mechanical substitutions only: `@/lib/...` import aliases → relative `.ts` imports, `process.env.X` → `Deno.env.get("X")`, npm packages → `npm:package@exact-version` specifiers).
- Reuse `barm_ad_spend_history` as-is (no new columns — the resolved decision to omit `clicks`/`impressions`/`roas`/`conversion_rate` means it needs no schema change).
- Duplicate prevention is upsert-on-conflict everywhere; nothing recomputes on a repeat call except an explicit `force: true` Retry/Regenerate request.
- **Manual deployment steps are called out explicitly in each task.** This plan is written and tested code-side, but actually deploying Supabase Edge Functions, running SQL against the live project, enabling `pg_cron`/`pg_net`, and setting Vercel/Supabase secrets requires the user's own Supabase/Vercel CLI login and dashboard access — no sandbox here has those credentials.

---

## File Structure

New files:
- `scripts/report_generation_jobs_table.sql` — job/status table.
- `scripts/daily_ad_spend_reports_table.sql` — calculated-report artifact table + Storage bucket SQL.
- `scripts/ad_spend_report_pg_cron.sql` — daily `pg_cron` schedule invoking the generate Edge Function.
- `supabase/functions/_shared/adSpendReportExport.ts` — Deno-ported copy of `src/lib/adSpendReportExport.ts` (calculation engine, unchanged formulas).
- `supabase/functions/_shared/adSpendReportDeps/*.ts` — Deno-ported copies of the handful of `src/lib/*` files `adSpendReportExport.ts` imports (see Task 3).
- `supabase/functions/generate-ad-spend-report/index.ts` — Edge Function: runs the report, persists results, manages job status.
- `supabase/functions/send-ad-spend-email/index.ts` — Edge Function: reads the persisted report, sends the email in the background.
- `src/pages/api/generate-ad-spend-report.ts` — new lightweight Vercel route, enqueues a job.
- `src/lib/adSpendJobs.ts` — small shared helper for job dedupe/lookup queries, used by both new/rewritten Vercel routes.

Modified files:
- `src/pages/api/send-ad-spend-email.ts` — rewritten to be read-only (checks job, reads persisted report, delegates email dispatch).
- `src/app/dashboard/reports/page.tsx` — new "Generate Report" button + job-status polling; "Send" button rewired to the new lightweight route (same request/response shape it already expects on success, so its existing success-message code keeps working).
- `src/pages/api/cron/ad-spend-history.ts` — reduced to a thin trigger (calls the new Vercel generate route) or retired in favor of `pg_cron` (decided in Task 9).
- `vercel.json` — cron entry adjusted if `pg_cron` takes over the schedule.

Untouched by design: `src/lib/adSpendReportExport.ts` itself (the Node/browser copy stays exactly as-is, still used by the unaffected client-side "Generate & Download" button), `src/pages/api/send-email.ts` (its `adSpendDaily` branch is *copied*, not modified, into the new email Edge Function — every other email type it serves is unaffected).

**UI decision requiring your sign-off:** The dashboard's existing "Generate & Download" button on `reports/page.tsx` is a *different* feature (instant client-side XLSX download, no email, no job) and is left completely untouched. Your spec's "Generate Report" (async job trigger) is a **new, third button** added next to it. Flag if you'd rather something else (e.g. repurpose "Generate & Download," or fold job-creation into the first "Send" click).

---

### Task 1: `report_generation_jobs` table

**Files:**
- Create: `scripts/report_generation_jobs_table.sql`

**Interfaces:**
- Produces: table `public.report_generation_jobs` with columns `id, report_date, report_type, account_name, status, started_at, completed_at, error_message, email_status, email_sent_at, email_error, created_at, updated_at`, unique on `(report_date, report_type, account_name)`. Every later task's job-status reads/writes use these exact column names.

- [ ] **Step 1: Write the migration SQL**

```sql
-- scripts/report_generation_jobs_table.sql
-- Tracks one row per (report_date, report_type, account_name): the async
-- Daily Ad Spend Report generation/email pipeline's job status. account_name
-- defaults to '' (not null) so the unique constraint works even when no
-- multi-account name is passed, matching adSpendReportExport.ts's own
-- `accountName?: string` optional convention.
create table if not exists public.report_generation_jobs (
  id bigint generated by default as identity primary key,
  report_date date not null,
  report_type text not null,
  account_name text not null default '',
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  email_status text not null default 'not_sent' check (email_status in ('not_sent', 'sending', 'sent', 'failed')),
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_date, report_type, account_name)
);

create index if not exists report_generation_jobs_date_idx
  on public.report_generation_jobs (report_date);
create index if not exists report_generation_jobs_type_status_idx
  on public.report_generation_jobs (report_type, status);

-- Same RLS-disabled + anon-full-grant pattern every other table in this app
-- uses (see scripts/fix_rls_all_tables.sql's incident writeup) — the app has
-- no auth session and talks to Supabase entirely with the anon key.
alter table public.report_generation_jobs disable row level security;
grant select, insert, update, delete on public.report_generation_jobs to anon;
```

- [ ] **Step 2: Run it against the live Supabase project (manual — you run this)**

Open the Supabase SQL editor for this project and run the file's contents, or:
```bash
psql "$SUPABASE_DB_URL" -f scripts/report_generation_jobs_table.sql
```

- [ ] **Step 3: Verify**

In the Supabase SQL editor:
```sql
select column_name, data_type from information_schema.columns
where table_name = 'report_generation_jobs' order by ordinal_position;
insert into report_generation_jobs (report_date, report_type) values ('2026-09-08', 'ad_spend_daily') returning *;
insert into report_generation_jobs (report_date, report_type) values ('2026-09-08', 'ad_spend_daily'); -- expect: unique_violation
delete from report_generation_jobs where report_date = '2026-09-08';
```
Expected: first insert succeeds, second raises a unique-constraint error, cleanup delete succeeds.

- [ ] **Step 4: Commit**

```bash
git add scripts/report_generation_jobs_table.sql
git commit -m "Add report_generation_jobs table for async ad-spend report tracking"
```

---

### Task 2: `daily_ad_spend_reports` table + Storage bucket

**Files:**
- Create: `scripts/daily_ad_spend_reports_table.sql`

**Interfaces:**
- Consumes: `report_generation_jobs.id` (foreign key).
- Produces: table `public.daily_ad_spend_reports` with columns `id, report_date, account_name, job_id, result_json, xlsx_storage_path, created_at, updated_at`, unique on `(report_date, account_name)`; Storage bucket `ad-spend-reports`. Task 4's Edge Function writes to both; Task 7's rewritten Send route reads both.

- [ ] **Step 1: Write the migration SQL**

```sql
-- scripts/daily_ad_spend_reports_table.sql
-- Holds the full computed Daily Ad Spend Report artifact for one
-- (report_date, account_name): result_json mirrors adSpendReportExport.ts's
-- AdSpendReportResult interface (minus its non-serializable `wb` field) —
-- platformSummaries/platformTotals/productCount/etc — everything the
-- adSpendDaily email template needs. The actual .xlsx bytes live in Supabase
-- Storage (xlsx_storage_path), not inline, to keep this row small.
create table if not exists public.daily_ad_spend_reports (
  id bigint generated by default as identity primary key,
  report_date date not null,
  account_name text not null default '',
  job_id bigint references public.report_generation_jobs(id),
  result_json jsonb not null,
  xlsx_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_date, account_name)
);

create index if not exists daily_ad_spend_reports_date_idx
  on public.daily_ad_spend_reports (report_date);
create index if not exists daily_ad_spend_reports_account_idx
  on public.daily_ad_spend_reports (account_name);

alter table public.daily_ad_spend_reports disable row level security;
grant select, insert, update, delete on public.daily_ad_spend_reports to anon;

-- Private bucket for the generated .xlsx workbooks. Not public — only the
-- anon-keyed Edge Functions/Vercel routes read/write it via the Storage API.
insert into storage.buckets (id, name, public)
values ('ad-spend-reports', 'ad-spend-reports', false)
on conflict (id) do nothing;

create policy if not exists "ad-spend-reports anon read"
  on storage.objects for select
  using (bucket_id = 'ad-spend-reports');
create policy if not exists "ad-spend-reports anon write"
  on storage.objects for insert
  with check (bucket_id = 'ad-spend-reports');
create policy if not exists "ad-spend-reports anon update"
  on storage.objects for update
  using (bucket_id = 'ad-spend-reports');
```

- [ ] **Step 2: Run it against the live Supabase project (manual — you run this)**

Same as Task 1 Step 2 — Supabase SQL editor or `psql -f scripts/daily_ad_spend_reports_table.sql`.

- [ ] **Step 3: Verify**

```sql
select column_name, data_type from information_schema.columns
where table_name = 'daily_ad_spend_reports' order by ordinal_position;
select * from storage.buckets where id = 'ad-spend-reports';
```
Also, in the Supabase dashboard's Storage tab, confirm the `ad-spend-reports` bucket is listed and marked private.

- [ ] **Step 4: Commit**

```bash
git add scripts/daily_ad_spend_reports_table.sql
git commit -m "Add daily_ad_spend_reports table and ad-spend-reports storage bucket"
```

---

### Task 3: Port the calculation engine to Deno (Supabase Edge Function shared module)

This is a **mechanical port, not a rewrite** — every formula, threshold, and SKU-resolution rule in `src/lib/adSpendReportExport.ts` (1781 lines) must reach Deno byte-for-byte unchanged. The only permitted edits are import syntax and environment-variable access.

**Files:**
- Read fully (already read in full during design — see spec doc): `src/lib/adSpendReportExport.ts`
- Read fully (not yet read — required before copying): `src/lib/amazonReportShared.ts`, `src/lib/amazonReportUpload.ts`, `src/lib/meeshoReportUpload.ts`, `src/lib/categoryMap.ts`, `src/lib/productMasterUpload.ts`, `src/lib/masterProductSkuid.ts`, `src/lib/productMarketingUpload.ts`, `src/lib/siteUrl.ts`, `src/lib/supabaseLazy.ts`
- Create: `supabase/functions/_shared/adSpendReportExport.ts`
- Create: `supabase/functions/_shared/deps/amazonReportShared.ts`, `.../deps/amazonReportUpload.ts`, `.../deps/meeshoReportUpload.ts`, `.../deps/categoryMap.ts`, `.../deps/productMasterUpload.ts`, `.../deps/masterProductSkuid.ts`, `.../deps/productMarketingUpload.ts`, `.../deps/siteUrl.ts`
- Create: `supabase/functions/_shared/adSpendReportExport.regression.test.ts`

**Interfaces:**
- Produces: `buildAdSpendReportWorkbook(opts: { endDate: string; rangeDays?: number; accountName?: string }): Promise<AdSpendReportResult>` importable from `../_shared/adSpendReportExport.ts`, identical signature/behavior to the Node original. Task 4 imports this directly.

- [ ] **Step 1: Read every dependency file fully**

Read each of the 9 files listed above in full (not excerpts) — you need their complete contents to copy them correctly, including every helper function `adSpendReportExport.ts` calls: `fetchAllRows`, `isCancelledOrder`, `isStandardOrderId`, `istDayWindowUtc` (from `amazonReportShared.ts`); `upsertInChunks`, `supabasePublic` (from `amazonReportUpload.ts`); `toDate` (from `meeshoReportUpload.ts`); `resolveProductName` (from `categoryMap.ts`); `fetchProductMasterMap`, `buildProductMasterResolver` (from `productMasterUpload.ts`); `fetchMasterSkuidMap`, `buildMasterSkuidResolver`, `fetchMasterSkuidAmazonCatalog`, `fetchMasterSkuidsByName`, `gstMultiplierFromTax`, `DEFAULT_GST_MULTIPLIER` (from `masterProductSkuid.ts`); `fetchProductMarketingMap`, `buildProductMarketingResolver` (from `productMarketingUpload.ts`); `SITE_URL` (from `siteUrl.ts`).

- [ ] **Step 2: Copy each dependency file into `supabase/functions/_shared/deps/`, applying exactly these mechanical substitutions and nothing else**

1. Any `import ... from "@/lib/X"` → `import ... from "./X.ts"` (relative, explicit `.ts` extension — Deno requires it).
2. Any `import ... from "@supabase/supabase-js"` → `import ... from "npm:@supabase/supabase-js@2.110.8"` (pin the exact version from `package.json`'s `@supabase/supabase-js@^2.110.8`).
3. Any other bare npm import (e.g. `xlsx-js-style`) → `npm:<package>@<exact version from package.json>`.
4. Every `process.env.X` → `Deno.env.get("X")`.
5. In `amazonReportUpload.ts`'s copy specifically: replace its `lazySupabase(() => createClient(SUPABASE_URL, SUPABASE_ANON_KEY))` construction with a plain `createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!)` — Deno Edge Functions have `SUPABASE_URL`/`SUPABASE_ANON_KEY` pre-populated as default secrets on every deployment, and there is no browser-bundle-inlining failure mode to guard against here (unlike the Node/browser copy), so the lazy-proxy trick from `supabaseLazy.ts` is unnecessary — do not port `supabaseLazy.ts` at all.
6. No other line changes. If a file has no `@/lib/...` imports, no `process.env`, and no npm imports, copy it completely unchanged.

- [ ] **Step 3: Copy `adSpendReportExport.ts` into `supabase/functions/_shared/adSpendReportExport.ts`**

Apply the same 6 substitution rules above to its own imports (lines 1-9 of the original: `xlsx-js-style`, `@/lib/amazonReportShared`, `@/lib/amazonReportUpload`, `@/lib/meeshoReportUpload`, `@/lib/categoryMap`, `@/lib/productMasterUpload`, `@/lib/masterProductSkuid`, `@/lib/productMarketingUpload`, `@/lib/siteUrl`) and to the one `process.env.GEMINI_API_KEY` read inside `callGeminiText`. Every other line — every formula, threshold, comment, the entire body of `buildAdSpendReportWorkbook`, `fetchAmazonProducts`, `fetchFlipkartProducts`, `fetchMeeshoProducts`, `groupProductsByName`, `saveAdSpendHistory`, the Action Sheet / Optimization-suggestion / Summary-sheet / workbook-building code — copied verbatim, unchanged.

- [ ] **Step 4: Write a regression test proving the port didn't change behavior**

This can't run against live marketplace data from this sandbox, so it proves equivalence structurally: both the Node original and the Deno port must export the same pure, side-effect-free formula functions with identical outputs for the same inputs.

```typescript
// supabase/functions/_shared/adSpendReportExport.regression.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { spendTax, computeCpc, computeAcos, getDateWindow, groupProductsByName } from "./adSpendReportExport.ts";

Deno.test("spendTax applies the flat 1.18 GST multiplier when none is tagged", () => {
  assertEquals(spendTax({ spend: 100, units: 5 }), 118);
});

Deno.test("computeCpc falls back to spendTax when units is 0", () => {
  assertEquals(computeCpc({ spend: 100, units: 0 }), 118);
});

Deno.test("computeAcos is CPC / price, and 0 when price is 0", () => {
  assertEquals(computeAcos({ spend: 100, units: 10 }, 20), 118 / 10 / 20);
  assertEquals(computeAcos({ spend: 100, units: 10 }, 0), 0);
});

Deno.test("getDateWindow computes a pure UTC-midnight trailing window, not local time", () => {
  assertEquals(getDateWindow("2026-09-08", 7), { start: "2026-09-02", end: "2026-09-08" });
});

Deno.test("groupProductsByName sums spend/units across SKU variants of the same product", () => {
  const rows = groupProductsByName([
    { platform: "Amazon" as const, sku: "SKU-A", name: "Widget", price: 100, day: { spend: 10, units: 1 }, range: { spend: 50, units: 5 } },
    { platform: "Amazon" as const, sku: "SKU-B", name: "widget", price: 0, day: { spend: 5, units: 1 }, range: { spend: 20, units: 2 } },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].day.spend, 15);
  assertEquals(rows[0].range.units, 7);
  assertEquals(rows[0].sku, "SKU-A, SKU-B");
});
```

- [ ] **Step 5: Run the regression test (manual — requires Deno; see note)**

```bash
deno test supabase/functions/_shared/adSpendReportExport.regression.test.ts --allow-env
```
Expected: all 5 pass. If Deno isn't installed locally, this is one of the manual steps — install it (`https://deno.land/`) or run it via `supabase functions serve` once Task 4 exists, whichever is easier at execution time. This step is also where an `xlsx-js-style`/Deno incompatibility (a real, flagged risk) would surface first — if `npm:xlsx-js-style@1.2.0` fails to resolve or errors under Deno, stop here and report back before continuing to Task 4; do not silently swap in a different xlsx library, since that would be a formula/output-shape change.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/
git commit -m "Port ad-spend calculation engine to Deno for Supabase Edge Functions"
```

---

### Task 4: `generate-ad-spend-report` Edge Function

**Files:**
- Create: `supabase/functions/generate-ad-spend-report/index.ts`

**Interfaces:**
- Consumes: `buildAdSpendReportWorkbook` from `../_shared/adSpendReportExport.ts` (Task 3).
- Consumes (request body, from Task 6's Vercel route): `{ job_id: number, report_date: string, account_name?: string, range_days?: number }`.
- Produces: HTTP `{ accepted: true, job_id, status: "processing" }` fast; asynchronously updates `report_generation_jobs` (status → `processing` → `completed`/`failed`) and writes `daily_ad_spend_reports` + the `ad-spend-reports` Storage object. Task 6 invokes this by URL; Task 9's `pg_cron` schedule also invokes it directly.

- [ ] **Step 1: Write the Edge Function**

```typescript
// supabase/functions/generate-ad-spend-report/index.ts
// Runs the full Daily Ad Spend Report calculation (marketplace fetch, SKU
// resolution, GST/CPC/ACOS, Action Sheet Gemini calls) — the slow part that
// must never run inside a Vercel request. Responds fast, then keeps working
// via EdgeRuntime.waitUntil so the caller (a Vercel route or pg_cron) never
// waits on it either.
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import * as XLSX from "npm:xlsx-js-style@1.2.0";
import { buildAdSpendReportWorkbook } from "../_shared/adSpendReportExport.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const { job_id, report_date, account_name, range_days } = body as {
    job_id?: number; report_date?: string; account_name?: string; range_days?: number;
  };
  if (!job_id || !report_date) return jsonResponse({ error: "job_id and report_date are required" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const acctName = account_name || "";

  const run = async () => {
    await supabase.from("report_generation_jobs").update({
      status: "processing",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", job_id);

    try {
      // report_date is passed through to buildAdSpendReportWorkbook's endDate
      // option exactly as received — no reformatting, no "today" fallback.
      const result = await buildAdSpendReportWorkbook({
        endDate: report_date,
        rangeDays: range_days,
        accountName: acctName || undefined,
      });

      const xlsxBytes = XLSX.write(result.wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
      const storagePath = `${report_date}/${acctName || "default"}.xlsx`;
      const { error: uploadError } = await supabase.storage
        .from("ad-spend-reports")
        .upload(storagePath, xlsxBytes, {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          upsert: true,
        });
      if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

      // wb (the XLSX.WorkBook object) isn't JSON-serializable and is already
      // persisted above as the real file — everything else on the result is
      // plain data the email template needs.
      const { wb: _wb, ...resultJson } = result;

      const { error: upsertError } = await supabase.from("daily_ad_spend_reports").upsert({
        report_date,
        account_name: acctName,
        job_id,
        result_json: resultJson,
        xlsx_storage_path: storagePath,
        updated_at: new Date().toISOString(),
      }, { onConflict: "report_date,account_name" });
      if (upsertError) throw new Error(`daily_ad_spend_reports upsert failed: ${upsertError.message}`);

      await supabase.from("report_generation_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: null,
      }).eq("id", job_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from("report_generation_jobs").update({
        status: "failed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: message,
      }).eq("id", job_id);
    }
  };

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(run());
  } else {
    // `supabase functions serve` (local dev) has no EdgeRuntime global — fire
    // without awaiting so the HTTP response still returns immediately.
    run();
  }

  return jsonResponse({ accepted: true, job_id, status: "processing" });
});
```

- [ ] **Step 2: Deploy and smoke-test (manual — requires Supabase CLI login + project link)**

```bash
supabase functions deploy generate-ad-spend-report --no-verify-jwt
```
Then, with a real job row already inserted (e.g. from Task 1's own verification insert), call it directly:
```bash
curl -X POST "https://<project-ref>.functions.supabase.co/generate-ad-spend-report" \
  -H "Content-Type: application/json" \
  -d '{"job_id": <id from the insert>, "report_date": "2026-09-08"}'
```
Expected: immediate `{"accepted":true,...,"status":"processing"}` response (well under 10s), then, checking `select * from report_generation_jobs where id = <id>;` a minute or two later, `status = 'completed'` (or `'failed'` with a real `error_message` if the date has no uploaded data — both are correct outcomes to verify, not just "completed").

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/generate-ad-spend-report/
git commit -m "Add generate-ad-spend-report Edge Function"
```

---

### Task 5: `send-ad-spend-email` Edge Function

Ports only the `adSpendDaily` email-HTML branch and the nodemailer/Gmail transporter from `src/pages/api/send-email.ts` — every other email type in that file is untouched, and this new function never calls back into the Vercel `/api/send-email` route (that route is itself Vercel-hosted and would still be capped at 10s regardless of who calls it — the actual SMTP send must happen here, in Deno, where there is no such cap).

**Files:**
- Read fully (specific line ranges already identified): `src/pages/api/send-email.ts` lines 1-75 (`wrap`, `channelBar`, `CHANNELS`), lines 912-1159 (the `adSpendDaily` branch body), line ~1169 (`SUBJECTS.adSpendDaily`), lines 1201-1233 (the `transporter.sendMail` call shape).
- Create: `supabase/functions/send-ad-spend-email/index.ts`

**Interfaces:**
- Consumes (request body, from Task 7): `{ job_id: number, report_date: string, account_name?: string, to: string, cc?: string }`.
- Produces: HTTP `{ accepted: true, job_id, status: "sending" }` fast; asynchronously updates `report_generation_jobs.email_status`/`email_sent_at`/`email_error`.

- [ ] **Step 1: Read the exact source lines listed above in full**, so the copied HTML/subject/transporter code matches production exactly.

- [ ] **Step 2: Write the Edge Function**, porting the read sections verbatim (only the mechanical substitutions below), and adding the job-status/orchestration logic around them:

Mechanical substitutions when copying from `send-email.ts`:
1. `import { SITE_URL } from "@/lib/siteUrl"` → hardcode `const SITE_URL = Deno.env.get("SITE_URL") ?? "https://<production-domain>"` (read the real value from `src/lib/siteUrl.ts` and use it as the fallback literal).
2. `process.env.SMTP_FROM` / `process.env.SMTP_PASS` → `Deno.env.get("SMTP_FROM")` / `Deno.env.get("SMTP_PASS")`.
3. `import nodemailer from "nodemailer"` → `import nodemailer from "npm:nodemailer@9.0.3"` (exact version from `package.json`).
4. The `wrap()`/`channelBar()`/`CHANNELS`/`adSpendDaily` branch bodies: copied with zero other changes — every inline style, threshold, and column layout stays identical, since this is what recipients already see today.

```typescript
// supabase/functions/send-ad-spend-email/index.ts
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import nodemailer from "npm:nodemailer@9.0.3";

// --- verbatim port of send-email.ts's wrap()/channelBar()/CHANNELS and the
// "adSpendDaily" branch of buildHtml() (source: src/pages/api/send-email.ts
// lines 1-75, 912-1159, SUBJECTS["adSpendDaily"]) goes here, unchanged ---
// ... (copied in Step 1/2, omitted here for brevity — see the source lines above) ...

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: Deno.env.get("SMTP_FROM"), pass: Deno.env.get("SMTP_PASS") },
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const { job_id, report_date, account_name, to, cc } = body as {
    job_id?: number; report_date?: string; account_name?: string; to?: string; cc?: string;
  };
  if (!job_id || !report_date || !to) {
    return jsonResponse({ error: "job_id, report_date and to are required" }, 400);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const acctName = account_name || "";

  const run = async () => {
    await supabase.from("report_generation_jobs").update({
      email_status: "sending", updated_at: new Date().toISOString(),
    }).eq("id", job_id);

    try {
      const { data: reportRow, error: reportErr } = await supabase
        .from("daily_ad_spend_reports")
        .select("result_json, xlsx_storage_path")
        .eq("report_date", report_date)
        .eq("account_name", acctName)
        .maybeSingle();
      if (reportErr || !reportRow) throw new Error(reportErr?.message || "No saved report found for that date");

      const { data: fileBlob, error: downloadErr } = await supabase.storage
        .from("ad-spend-reports")
        .download(reportRow.xlsx_storage_path as string);
      if (downloadErr || !fileBlob) throw new Error(downloadErr?.message || "Workbook file missing from storage");
      const xlsxBytes = new Uint8Array(await fileBlob.arrayBuffer());

      const result = reportRow.result_json as {
        endDate: string; rangeStart: string; filename: string; productCount: number;
        platformTotals: unknown; platformSummaries: unknown; lowSpendCampaignCount: number;
        incompleteDates: unknown;
      };
      // dmy(): 'YYYY-MM-DD' -> 'DD-MM-YYYY' — same as adSpendReportExport.ts's
      // dotDate/send-ad-spend-email.ts's dmy, ported identically.
      const dmy = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}-${m}-${y}`; };
      const dayLabel = dmy(result.endDate);
      const rangeLabel = `${dmy(result.rangeStart)} to ${dmy(result.endDate)}`;

      // buildAdSpendDailyHtml(): the ported adSpendDaily branch body from
      // send-email.ts, called with the same `data` shape send-ad-spend-email.ts
      // already builds today.
      const html = buildAdSpendDailyHtml({
        dayLabel, rangeLabel, currency: "INR",
        platformSummaries: result.platformSummaries,
        productCount: result.productCount,
        lowSpendCampaignCount: result.lowSpendCampaignCount,
        incompleteDates: result.incompleteDates,
      }, to);

      const info = await transporter.sendMail({
        from: `Marketplace360 Dashboard <${Deno.env.get("SMTP_FROM")}>`,
        to,
        cc: cc || undefined,
        subject: "📈 Ad spend Report",
        html,
        attachments: [{ filename: result.filename, content: xlsxBytes }],
      });

      await supabase.from("report_generation_jobs").update({
        email_status: "sent",
        email_sent_at: new Date().toISOString(),
        email_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", job_id);
      console.log("[send-ad-spend-email] sent:", info.messageId, "→", to);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from("report_generation_jobs").update({
        email_status: "failed", email_error: message, updated_at: new Date().toISOString(),
      }).eq("id", job_id);
    }
  };

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) { edgeRuntime.waitUntil(run()); } else { run(); }

  return jsonResponse({ accepted: true, job_id, status: "sending" });
});
```

- [ ] **Step 3: Deploy and smoke-test (manual — requires Supabase CLI login + project link, and `SMTP_FROM`/`SMTP_PASS` set as Edge Function secrets)**

```bash
supabase secrets set SMTP_FROM=<same value as Vercel's SMTP_FROM> SMTP_PASS=<same value as Vercel's SMTP_PASS>
supabase functions deploy send-ad-spend-email --no-verify-jwt
```
Then, with a `completed` report already in `daily_ad_spend_reports` (from Task 4's smoke test) and a job row for it:
```bash
curl -X POST "https://<project-ref>.functions.supabase.co/send-ad-spend-email" \
  -H "Content-Type: application/json" \
  -d '{"job_id": <id>, "report_date": "2026-09-08", "to": "<your own test address>"}'
```
Expected: immediate `{"accepted":true,...,"status":"sending"}`, then the test email actually arrives within ~1-3 minutes (Gmail SMTP's own 65-160s), and `select email_status, email_sent_at from report_generation_jobs where id = <id>;` shows `sent`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-ad-spend-email/
git commit -m "Add send-ad-spend-email Edge Function (background Gmail SMTP dispatch)"
```

---

### Task 6: Shared job-lookup helper + lightweight `/api/generate-ad-spend-report` Vercel route

**Files:**
- Create: `src/lib/adSpendJobs.ts`
- Create: `src/pages/api/generate-ad-spend-report.ts`

**Interfaces:**
- Produces: `findOrCreateJob(supabase, { reportDate, reportType, accountName, force }): Promise<{ job: JobRow; created: boolean }>` and `type JobRow = { id: number; report_date: string; report_type: string; account_name: string; status: string; error_message: string | null; email_status: string; email_sent_at: string | null; email_error: string | null }` from `src/lib/adSpendJobs.ts`. Task 7 imports both.
- Consumes: `NEXT_PUBLIC_SUPABASE_EDGE_URL` (new env var — the Edge Functions base URL, e.g. `https://<project-ref>.functions.supabase.co`) and the existing `src/lib/supabaseClient.ts` client.

- [ ] **Step 1: Write the shared job-lookup helper**

```typescript
// src/lib/adSpendJobs.ts
// Shared job-row lookup/dedupe logic for the async Daily Ad Spend Report
// pipeline, used by both /api/generate-ad-spend-report and the rewritten
// /api/send-ad-spend-email — kept in one place so "what counts as a
// duplicate" is defined exactly once.
import { supabase } from "@/lib/supabaseClient";

export const AD_SPEND_REPORT_TYPE = "ad_spend_daily";

export interface JobRow {
  id: number;
  report_date: string;
  report_type: string;
  account_name: string;
  status: "pending" | "processing" | "completed" | "failed";
  error_message: string | null;
  email_status: "not_sent" | "sending" | "sent" | "failed";
  email_sent_at: string | null;
  email_error: string | null;
}

export async function findJob(reportDate: string, accountName: string): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("report_generation_jobs")
    .select("*")
    .eq("report_date", reportDate)
    .eq("report_type", AD_SPEND_REPORT_TYPE)
    .eq("account_name", accountName)
    .maybeSingle();
  if (error) throw new Error(`Job lookup failed: ${error.message}`);
  return (data as JobRow) || null;
}

/**
 * Returns the existing job for (reportDate, accountName) unless it's missing,
 * `failed`, or `force` is true — in which case it creates (or resets) a
 * `pending` job and returns `created: true` so the caller knows to invoke the
 * Edge Function. A `completed`/`processing` job is returned as-is (created:
 * false) so a normal Generate click never recomputes silently.
 */
export async function findOrCreateJob(
  reportDate: string,
  accountName: string,
  force: boolean
): Promise<{ job: JobRow; created: boolean }> {
  const existing = await findJob(reportDate, accountName);
  if (existing && existing.status !== "failed" && !force) {
    return { job: existing, created: false };
  }
  const { data, error } = await supabase
    .from("report_generation_jobs")
    .upsert(
      {
        report_date: reportDate,
        report_type: AD_SPEND_REPORT_TYPE,
        account_name: accountName,
        status: "pending",
        error_message: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "report_date,report_type,account_name" }
    )
    .select("*")
    .single();
  if (error) throw new Error(`Job creation failed: ${error.message}`);
  return { job: data as JobRow, created: true };
}
```

- [ ] **Step 2: Write the Vercel route**

```typescript
// src/pages/api/generate-ad-spend-report.ts
// Lightweight "Generate" endpoint: creates/looks up a report_generation_jobs
// row and invokes the generate-ad-spend-report Edge Function, awaiting only
// its fast ack — never the actual report computation. See
// docs/superpowers/specs/2026-09-08-daily-ad-spend-async-architecture-design.md.
import type { NextApiRequest, NextApiResponse } from "next";
import { findOrCreateJob } from "@/lib/adSpendJobs";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { endDate, accountName, rangeDays, force } = req.body || {};
  if (!endDate) return res.status(400).json({ error: "endDate is required" });

  const acctName = accountName || "";

  try {
    const { job, created } = await findOrCreateJob(endDate, acctName, !!force);

    if (!created) {
      // Already pending/processing/completed for this exact date — do not
      // invoke the Edge Function again (see Global Constraints: nothing
      // recomputes except an explicit force/Retry request).
      return res.status(200).json({ success: true, job_id: job.id, status: job.status, error_message: job.error_message });
    }

    const edgeBaseUrl = process.env.SUPABASE_EDGE_URL;
    if (!edgeBaseUrl) return res.status(500).json({ error: "SUPABASE_EDGE_URL is not configured" });

    const ackController = new AbortController();
    const ackTimeout = setTimeout(() => ackController.abort(), 8000);
    try {
      const edgeRes = await fetch(`${edgeBaseUrl}/generate-ad-spend-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, report_date: endDate, account_name: acctName, range_days: rangeDays }),
        signal: ackController.signal,
      });
      clearTimeout(ackTimeout);
      if (!edgeRes.ok) {
        const errBody = await edgeRes.json().catch(() => ({}));
        return res.status(502).json({ error: errBody?.error || "Edge Function invocation failed" });
      }
    } catch (fetchErr) {
      clearTimeout(ackTimeout);
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return res.status(502).json({ error: `Edge Function invocation failed: ${message}` });
    }

    return res.status(200).json({ success: true, job_id: job.id, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
```

- [ ] **Step 3: Add `SUPABASE_EDGE_URL` to env config (manual — you set the real value)**

Add to `.env.example`:
```
# Base URL for this project's Supabase Edge Functions (no trailing slash), e.g.
# https://abcdefghijklmnop.functions.supabase.co
SUPABASE_EDGE_URL=your_supabase_edge_functions_url
```
Set the real value in `.env.local` and in the Vercel project's environment variables (Vercel dashboard → Settings → Environment Variables) — this sandbox cannot do the latter for you.

- [ ] **Step 4: Verify locally (manual — requires `.env.local` configured and `npm run dev`)**

```bash
curl -X POST http://localhost:3000/api/generate-ad-spend-report \
  -H "Content-Type: application/json" \
  -d '{"endDate": "2026-09-08"}'
```
Expected: fast (well under 10s) `{"success":true,"job_id":...,"status":"processing"}`; a second identical call before the first completes returns the same `job_id` with `"status":"processing"` and does not create a new job (verify with `select count(*) from report_generation_jobs where report_date = '2026-09-08';` — expect `1`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/adSpendJobs.ts src/pages/api/generate-ad-spend-report.ts .env.example
git commit -m "Add lightweight /api/generate-ad-spend-report route"
```

---

### Task 7: Rewrite `/api/send-ad-spend-email` to be read-only

**Files:**
- Modify: `src/pages/api/send-ad-spend-email.ts` (full rewrite of the handler body; keep the same file path and the same `DEFAULT_TO`/`DEFAULT_CC` constants so the frontend's existing recipient defaults are unaffected)

**Interfaces:**
- Consumes: `findJob` from `src/lib/adSpendJobs.ts` (Task 6).
- Produces: same success-response shape the frontend already expects on completion (`{ sent, to, cc, filename, productCount, platformTotals }`), plus two new non-2xx states the frontend must handle (Task 8): `202 { success: true, status: "processing" | "pending" }` ("still generating") and `409 { error, status: "failed" }` ("generation failed").

- [ ] **Step 1: Write the failing/expected-behavior check first (manual integration check, no live test harness in this repo for API routes — see Task 6 Step 1's file for why)**

Before rewriting, confirm current behavior stays intact for the one case that must not regress: a `completed` job for the exact selected date returns the exact same JSON shape (`sent, to, cc, filename, productCount, platformTotals`) the frontend's `handleSendAdSpendEmail` (`src/app/dashboard/reports/page.tsx:130-134`) already parses — so no frontend change is needed on the success path, only on the new non-success paths (Task 8).

- [ ] **Step 2: Rewrite the handler**

```typescript
// src/pages/api/send-ad-spend-email.ts
// Lightweight "Send" for the Daily Ad Spend Report — reads the already-
// computed report for the selected date from daily_ad_spend_reports and
// dispatches the email via the send-ad-spend-email Edge Function. Never
// fetches marketplace data, never recalculates, never blocks on SMTP. See
// docs/superpowers/specs/2026-09-08-daily-ad-spend-async-architecture-design.md.
import type { NextApiRequest, NextApiResponse } from "next";
import { supabase } from "@/lib/supabaseClient";
import { findJob } from "@/lib/adSpendJobs";

const DEFAULT_TO = "kaviyapriyabarm@gmail.com";
const DEFAULT_CC = [
  "jayaprakashbarm@gmail.com",
  "dangibbs@b-arm.com",
  "nivetha@b-arm.com",
  "prinesh@b-arm.com",
  "akshaya.v@b-arm.com",
  "ceo@barmenterprises.com",
  "sriram@b-arm.com",
].join(",");

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { endDate, accountName, to, cc } = req.body || {};
  if (!endDate) return res.status(400).json({ error: "endDate is required" });

  const acctName = accountName || "";
  const toAddr = to !== undefined ? to : DEFAULT_TO;
  const ccAddr = cc !== undefined ? cc : DEFAULT_CC;

  try {
    const job = await findJob(endDate, acctName);
    if (!job) {
      return res.status(202).json({ success: false, status: "pending", message: "Report has not been generated yet for this date." });
    }
    if (job.status === "failed") {
      return res.status(409).json({ success: false, status: "failed", error: job.error_message || "Report generation failed." });
    }
    if (job.status !== "completed") {
      return res.status(202).json({ success: false, status: job.status, message: "Report is still being generated. Please try again shortly." });
    }

    const { data: reportRow, error: reportErr } = await supabase
      .from("daily_ad_spend_reports")
      .select("result_json")
      .eq("report_date", endDate)
      .eq("account_name", acctName)
      .maybeSingle();
    if (reportErr || !reportRow) {
      return res.status(500).json({ error: reportErr?.message || "Report row missing despite a completed job." });
    }
    const result = reportRow.result_json as {
      filename: string; productCount: number;
      platformTotals: { platform: string; daySpendTax: number; rangeSpendTax: number }[];
    };

    const edgeBaseUrl = process.env.SUPABASE_EDGE_URL;
    if (!edgeBaseUrl) return res.status(500).json({ error: "SUPABASE_EDGE_URL is not configured" });

    const ackController = new AbortController();
    const ackTimeout = setTimeout(() => ackController.abort(), 8000);
    try {
      const edgeRes = await fetch(`${edgeBaseUrl}/send-ad-spend-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id, report_date: endDate, account_name: acctName, to: toAddr, cc: ccAddr || undefined }),
        signal: ackController.signal,
      });
      clearTimeout(ackTimeout);
      if (!edgeRes.ok) {
        const errBody = await edgeRes.json().catch(() => ({}));
        return res.status(502).json({ error: errBody?.error || "Edge Function invocation failed" });
      }
    } catch (fetchErr) {
      clearTimeout(ackTimeout);
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return res.status(502).json({ error: `Edge Function invocation failed: ${message}` });
    }

    return res.status(200).json({
      sent: true,
      to: toAddr,
      cc: ccAddr,
      filename: result.filename,
      productCount: result.productCount,
      platformTotals: result.platformTotals,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message, endDate });
  }
}
```

- [ ] **Step 3: Verify (manual, requires Tasks 1-6 deployed and a completed report already saved for a test date)**

```bash
curl -X POST http://localhost:3000/api/send-ad-spend-email \
  -H "Content-Type: application/json" \
  -d '{"endDate": "2026-09-08", "to": "<your own test address>"}'
```
Expected: response returns in well under 10 seconds (this is the exact scenario that previously took 90-200+ seconds), body is `{"sent":true,...}`, and the test email arrives 1-3 minutes later (async, via Task 5's Edge Function). Also verify the "not ready yet" path: pick a date with no job row at all and confirm a `202 { status: "pending", message: "Report has not been generated yet..." }` response, and no new job or Edge Function invocation happens as a side effect (`select count(*) from report_generation_jobs where report_date = '<that date>';` stays `0`).

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/send-ad-spend-email.ts
git commit -m "Rewrite /api/send-ad-spend-email to be read-only, no recomputation"
```

---

### Task 8: Frontend — "Generate Report" button + job-status wiring

**Files:**
- Modify: `src/app/dashboard/reports/page.tsx`

**Interfaces:**
- Consumes: `POST /api/generate-ad-spend-report` (Task 6), `POST /api/send-ad-spend-email` (Task 7, new response shapes), `GET` polling of job status via a small new read-only endpoint (added in Step 1 below since neither existing route exposes a plain "check status" GET).

- [ ] **Step 1: Add a tiny read-only job-status route**

```typescript
// src/pages/api/ad-spend-report-status.ts
// GET-only status check for the dashboard's polling — separate from the
// generate/send routes so polling never accidentally re-triggers either.
import type { NextApiRequest, NextApiResponse } from "next";
import { findJob } from "@/lib/adSpendJobs";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const { endDate, accountName } = req.query;
  if (!endDate || typeof endDate !== "string") return res.status(400).json({ error: "endDate is required" });
  try {
    const job = await findJob(endDate, typeof accountName === "string" ? accountName : "");
    return res.status(200).json({ job });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 2: Add state + handlers for the new "Generate Report" button, next to the existing ad-spend button block (near `reports/page.tsx:109-136`)**

```typescript
// New state, alongside the existing adSpendGenerating/adSpendMsg/adSpendSending/adSpendSendMsg:
const [jobGenerating, setJobGenerating] = useState(false);
const [jobStatus, setJobStatus] = useState<string | null>(null);
const [jobMsg, setJobMsg] = useState<string | null>(null);

const pollJobStatus = async (date: string, account?: string) => {
  const qs = new URLSearchParams({ endDate: date, ...(account ? { accountName: account } : {}) });
  const r = await fetch(`/api/ad-spend-report-status?${qs.toString()}`);
  const j = await r.json();
  return j.job as { status: string; error_message: string | null; email_status: string } | null;
};

const handleGenerateAdSpendJob = async (force = false) => {
  if (!endDate) { alert("Pick a date at the top of the dashboard first."); return; }
  setJobGenerating(true); setJobMsg(null);
  try {
    const r = await fetch("/api/generate-ad-spend-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endDate, accountName: account?.name, force }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Failed to start report generation");
    setJobStatus(j.status);
    setJobMsg(
      j.status === "completed" ? "Report already generated for this date." :
      j.status === "processing" ? "Generating..." :
      "Queued — generating..."
    );
    // Poll every 5s until the job leaves pending/processing.
    const poll = async () => {
      const job = await pollJobStatus(endDate, account?.name);
      if (!job) return;
      setJobStatus(job.status);
      if (job.status === "completed") { setJobMsg("Completed."); setJobGenerating(false); return; }
      if (job.status === "failed") { setJobMsg(`Failed: ${job.error_message || "unknown error"} — Retry`); setJobGenerating(false); return; }
      setTimeout(poll, 5000);
    };
    setTimeout(poll, 5000);
  } catch (err) {
    setJobMsg("Failed: " + (err instanceof Error ? err.message : String(err)));
    setJobGenerating(false);
  }
};
```

- [ ] **Step 3: Update `handleSendAdSpendEmail` to handle the new "still generating"/"failed" response shapes (replacing the body near `reports/page.tsx:121-136`)**

```typescript
const handleSendAdSpendEmail = async () => {
  if (!endDate) { alert("Pick a date at the top of the dashboard first."); return; }
  setAdSpendSending(true); setAdSpendSendMsg(null);
  try {
    const r = await fetch("/api/send-ad-spend-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endDate, accountName: account?.name }),
    });
    const j = await r.json();
    if (r.status === 202) { setAdSpendSendMsg(j.message || "Report is still being generated. Please try again shortly."); return; }
    if (r.status === 409) { setAdSpendSendMsg(`Report generation failed — Retry. (${j.error})`); return; }
    if (!r.ok) throw new Error(j.error || "Send failed");
    const ccCount = j.cc ? String(j.cc).split(",").filter(Boolean).length : 0;
    setAdSpendSendMsg(`Sending ${j.filename} to ${j.to}${ccCount ? ` (cc ${ccCount})` : ""} — you'll see it land shortly.`);
  } catch (err) {
    setAdSpendSendMsg("Failed: " + (err instanceof Error ? err.message : String(err)));
  } finally { setAdSpendSending(false); }
};
```

- [ ] **Step 4: Add the "Generate Report" button to the JSX, next to the existing "Generate & Download" / "Send" buttons in the Ad Spend section (near `reports/page.tsx:552-567`)**

```tsx
<button
  onClick={() => handleGenerateAdSpendJob(jobStatus === "failed")}
  disabled={jobGenerating || !endDate}
  className="btn-secondary" /* match the existing button classes used by the neighboring buttons in this file */
>
  {jobGenerating ? "Generating..." : jobStatus === "completed" ? "Regenerate Report" : jobStatus === "failed" ? "Retry" : "Generate Report"}
</button>
{jobMsg && <p className="text-sm text-gray-500 mt-1">{jobMsg}</p>}
```
Match the exact existing button `className` used by the "Generate & Download"/"Send" buttons in this file (read the surrounding JSX first — don't invent new class names that don't match the page's existing button styling).

- [ ] **Step 5: Manual verification in the browser (dev server)**

Start the dev server, open `/dashboard/reports`, pick a date, click "Generate Report" — confirm it shows "Generating..." then (after polling) "Completed." without the page ever blocking for 90+ seconds. Click "Send" before generation finishes — confirm it shows "Report is still being generated..." Click "Send" again after "Completed." — confirm it shows the sending message and (check your inbox) the actual email arrives shortly after.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/ad-spend-report-status.ts src/app/dashboard/reports/page.tsx
git commit -m "Add Generate Report button and job-status polling to the dashboard"
```

---

### Task 9: Daily `pg_cron` schedule + retire the old Vercel cron's heavy lifting

**Files:**
- Create: `scripts/ad_spend_report_pg_cron.sql`
- Modify: `src/pages/api/cron/ad-spend-history.ts` (reduce to a thin trigger, or delete — decided in Step 1)
- Modify: `vercel.json` (remove or repoint the `ad-spend-history` cron entry)

**Interfaces:**
- Produces: a `pg_cron` job that calls `generate-ad-spend-report` (Task 4) once daily for "yesterday," matching the existing cron's own timing convention.

- [ ] **Step 1: Decide and confirm scope with the user (this is a judgment call, not mechanical — flag it, don't silently pick)**

The existing `src/pages/api/cron/ad-spend-history.ts` today computes `endDate` as "yesterday" and calls the full (now-ported) computation, discarding the workbook and keeping only `barm_ad_spend_history` upserts. Two reasonable options:
(a) Delete this route entirely; `pg_cron` (Step 2) becomes the sole daily trigger, invoking `generate-ad-spend-report` directly — which now also produces the full `daily_ad_spend_reports` artifact (a superset of what the old cron persisted).
(b) Keep the route as a thin manual-trigger passthrough (calls `/api/generate-ad-spend-report` with no date, defaulting server-side to yesterday) for any external tooling that already pings this URL.
Default to (a) unless something else in the deployment depends on this exact URL still existing — check `vercel.json`'s `crons` array (already known: it references `/api/cron/ad-spend-history` on schedule `"0 4 * * *"`) and anything else (Vercel dashboard cron config, external monitoring) before deleting.

- [ ] **Step 2: Write the `pg_cron` schedule SQL**

```sql
-- scripts/ad_spend_report_pg_cron.sql
-- Daily trigger for the Daily Ad Spend Report generation Edge Function,
-- replacing the old Vercel Cron -> heavy-computation path. Runs at 04:00 UTC
-- (matches the retired vercel.json cron's own "0 4 * * *" schedule) for
-- "yesterday" (UTC date), inserting a job row first so the same dedupe path
-- the manual Generate button uses also covers the automated daily run.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'daily-ad-spend-report-generate',
  '0 4 * * *',
  $$
  with new_job as (
    insert into report_generation_jobs (report_date, report_type, status)
    values ((now() at time zone 'utc')::date - 1, 'ad_spend_daily', 'pending')
    on conflict (report_date, report_type, account_name) do nothing
    returning id, report_date
  )
  select net.http_post(
    url := '<SUPABASE_EDGE_URL>/generate-ad-spend-report',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('job_id', new_job.id, 'report_date', new_job.report_date)
  )
  from new_job;
  $$
);
```
Replace `<SUPABASE_EDGE_URL>` with the real Edge Functions base URL (same value as Task 6's `SUPABASE_EDGE_URL` env var) before running.

- [ ] **Step 3: Run it against the live Supabase project (manual — you run this; `pg_cron`/`pg_net` extension enabling requires the Supabase dashboard's Database → Extensions page or SQL editor with sufficient privileges)**

- [ ] **Step 4: Retire or reduce the old Vercel cron per the Step 1 decision, and update `vercel.json`**

If deleting: `git rm src/pages/api/cron/ad-spend-history.ts` and remove its entry from `vercel.json`'s `crons` array. If keeping as a thin trigger: rewrite it to `fetch` the new `/api/generate-ad-spend-report` route with no `endDate` (letting that route... note: `generate-ad-spend-report` currently requires `endDate` — Step 1(b) would need a "yesterday" default added there, mirroring `send-ad-spend-email.ts`'s old default logic, if this option is chosen).

- [ ] **Step 5: Verify**

Confirm `select * from cron.job;` lists `daily-ad-spend-report-generate`. If possible, temporarily change the schedule to a near-future minute, confirm it fires (a new `report_generation_jobs` row appears for yesterday's date, then reaches `completed`), then set the schedule back to `'0 4 * * *'`.

- [ ] **Step 6: Commit**

```bash
git add scripts/ad_spend_report_pg_cron.sql vercel.json
git commit -m "Move daily ad-spend report generation trigger to pg_cron"
```
(Include the `git rm` of the old cron route in this commit if Step 1 chose option (a).)

---

### Task 10: End-to-end verification against the user's original test list

No new code — this task runs the 18-point verification list from the original request against the deployed system, and is only meaningful once Tasks 1-9 are deployed (all of them require live Supabase/Vercel, so this is entirely manual).

- [ ] **Step 1: Generate today's report** via the dashboard button; confirm a `report_generation_jobs` row is created (Task 1/6).
- [ ] **Step 2: Confirm status transitions** `pending` → `processing` → `completed` by polling `select status from report_generation_jobs where report_date = current_date;` during generation.
- [ ] **Step 3: Confirm SKU-wise calculations are correct** — spot-check 2-3 products' `day_spend`/`range_acos` in `barm_ad_spend_history` against the equivalent figures from a manual "Generate & Download" run for the same date (should match exactly, since it's the same formulas).
- [ ] **Step 4: Confirm records saved** in `daily_ad_spend_reports` and `barm_ad_spend_history` for that date.
- [ ] **Step 5: Confirm duplicate generation does not create duplicates** — click Generate twice; `select count(*) from report_generation_jobs where report_date = current_date;` stays `1`.
- [ ] **Step 6: Confirm a completed report can be retrieved** via `/api/send-ad-spend-email`.
- [ ] **Step 7: Click Send.**
- [ ] **Step 8: Confirm Send does not perform heavy generation** — time the `/api/send-ad-spend-email` response; must return in well under 10 seconds.
- [ ] **Step 9: Confirm the email is generated from saved data** — the emailed numbers match `daily_ad_spend_reports.result_json` for that date, not a fresh recompute.
- [ ] **Step 10: Confirm email delivery** — check the recipient inbox.
- [ ] **Step 11: Test failed generation** — pick a date range with genuinely no uploaded data on any platform (or temporarily break the `SUPABASE_EDGE_URL` env var) and confirm the job reaches `failed` with a real `error_message`, not a silent hang.
- [ ] **Step 12: Test retry** — use the "Retry" button (force: true) on a `failed` job; confirm it recomputes and can reach `completed`.
- [ ] **Step 13: Test empty SKU/data cases** — confirm `buildAdSpendReportWorkbook`'s existing "No uploaded Amazon, Flipkart or Meesho ad/order data..." error (line ~1249 of the original file) surfaces correctly as the job's `error_message`.
- [ ] **Step 14: Test Amazon, Flipkart and Meesho separately** — temporarily using a date range where only one platform has data, confirm the report still generates (existing `.catch(() => [])` tolerance, unchanged).
- [ ] **Step 15: Test multiple SKUs** — confirm a date with many active SKUs produces one `barm_ad_spend_history` row per SKU per platform, matching pre-migration behavior.
- [ ] **Step 16: Test an old date** — pick `2026-09-03` (or any past date with real uploaded data), Generate, Send, and confirm every number and the emailed date label say `2026-09-03`, not today.
- [ ] **Step 17: Test production deployment** — repeat Steps 1-10 against the live Vercel + Supabase production project, not just local/staging.
- [ ] **Step 18: Verify the 10-second timeout is gone** — time both `/api/generate-ad-spend-report` and `/api/send-ad-spend-email` in production; both must return in a few seconds, never 504.

---

## Self-Review Notes

- **Spec coverage:** every numbered requirement in the design spec has a task — schema (Tasks 1-2), generation move (Tasks 3-4), dedupe (Task 1's constraint + Task 6's `findOrCreateJob`), job/status mechanism (Task 1), async generate (Task 4/6), persisted final data (Task 4), Send rewrite (Task 7), email separation (Task 5), report history (folded into `report_generation_jobs`' `email_*` columns, Task 1), dashboard UI (Task 8), the "must not happen in Vercel" list (satisfied by construction — Tasks 6/7 never call marketplace-fetching code), preserving existing logic (Task 3's verbatim-port rule), and the 18-point test plan (Task 10).
- **Placeholder scan:** no TBD/TODO remain; Task 9 Step 1 is an explicit judgment call flagged for your confirmation, not a placeholder — it names the two concrete options and a default.
- **Type consistency:** `JobRow`'s field names (`status`, `email_status`, `email_sent_at`, `email_error`, `error_message`) are defined once in Task 6 and referenced identically in Tasks 7, 8, and 10's SQL checks; `AD_SPEND_REPORT_TYPE = "ad_spend_daily"` is defined once (Task 6) and used as the literal `'ad_spend_daily'` in Task 9's SQL and referenced by name in Task 6/7's TypeScript.
