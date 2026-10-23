"use client";

// Consolidated Stock Sheet — the client's daily "Consolidate sheet", rebuilt from the godown's
// "Combined godown stock sheet" upload (src/lib/consolidatedStock.ts has the formulas). In transit,
// order placed come from the latest uploaded Current stock sheet (given every Friday), else that week's
// Monday 10:00 IST snapshot; purchase qty = the last uploaded Stock Purchase Sheet (else the snapshot); combo from the snapshot.

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FcNameAlertPanel, ListingAlertPanel, runFcCheck, runListingCheck, FC_ALERTS_KEY, LISTING_ALERTS_KEY } from "@/components/FcNameAlertPanel";
import { InventoryTabs } from "@/components/InventoryTabs";
import { useDashboard } from "@/lib/DashboardContext";
import { KPICard } from "@/components/KPICard";
import { QueryErrorState } from "@/components/QueryErrorState";
import { exportConsolidatedWorkbook, consolidatedMailFiles, CONSOLIDATED_MAIL_TITLE, weeklyLabel, type ConsolidatedMailKind } from "@/lib/consolidatedStockExport";
import { fetchConsolidated, uploadGodownWorkbook, uploadRestockWorkbook, type ConsolidatedData } from "@/lib/consolidatedStockUpload";
import { runningOut, salesDropped, noSales, NO_SALES_MIN_STOCK, RUNNING_OUT_DAYS, CONSOLIDATED_DAYS, type ConsolidatedRow } from "@/lib/consolidatedStock";
import { NOT_LISTED_PRODUCTS, NOT_LISTED_AS_OF } from "@/lib/notListedProducts";
import { readDaily } from "@/lib/godownAnalyticsData";
import { analyzeGodown } from "@/lib/godownAnalytics";
import { Loader2, Upload, Download, Search, Info, CheckCircle2, AlertTriangle, Send } from "lucide-react";

type View = "all" | "running" | "dropped" | "nosales" | "notlisted";

// Missing numbers show as 0, never "—" / null (user, 2026-10-14)
const int = (v: number | null | undefined) => (v === null || v === undefined ? "0" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v)));
const dec = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "0" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: d }).format(v));
const dayLabel = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const dateLong = (iso: string | null) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

/** The client's sheet colours a day yellow when it is lower than the day before. */
const dropCls = (days: (number | null)[], i: number) =>
  i > 0 && (days[i] ?? 0) < (days[i - 1] ?? 0) ? "bg-[#FFFF00] text-black dark:bg-yellow-700/60 dark:text-yellow-50" : "";

function coverChip(days: number | null) {
  // Nothing sold: Excel's #DIV/0! (current ÷ 0 average), as in the client's sheet (user, 2026-10-15).
  if (days === null) return <span className="text-muted-foreground">#DIV/0!</span>;
  // Same as the client's sheet: under 30 days in light red with dark red text.
  const cls = days < RUNNING_OUT_DAYS ? "bg-[#FFC7CE] text-[#9C0006] dark:bg-red-950 dark:text-red-300" : "text-foreground";
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${cls}`}>{dec(days, 0)} days</span>;
}

export default function ConsolidatedStockPage() {
  const [view, setView] = useState<View>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [mailing, setMailing] = useState<ConsolidatedMailKind | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const qc = useQueryClient();
  const godownRef = useRef<HTMLInputElement>(null);
  const restockRef = useRef<HTMLInputElement>(null);

  // The top bar's date picks the sheet: the 10 godown days up to it (user, 2026-10-13).
  const { endDate } = useDashboard();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : undefined;
  const { data, isLoading, isError, error, refetch } = useQuery<ConsolidatedData>({ queryKey: ["consolidated_stock", asOf ?? "latest"], queryFn: () => fetchConsolidated(asOf) });

  const lists = useMemo(() => {
    const rows = data?.rows ?? [];
    return { all: [...rows].sort((a, b) => b.finalQtyToRestock - a.finalQtyToRestock || a.product.localeCompare(b.product)), running: runningOut(rows), dropped: salesDropped(rows), nosales: noSales(rows) };
  }, [data]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (view === "notlisted") return [];
    return lists[view].filter((r) => !q || r.product.toLowerCase().includes(q));
  }, [lists, view, search]);
  const notListed = useMemo(() => {
    const q = search.trim().toLowerCase();
    return NOT_LISTED_PRODUCTS.filter(([p]) => !q || p.toLowerCase().includes(q));
  }, [search]);
  const totalRestock = (data?.rows ?? []).reduce((a, r) => a + r.finalQtyToRestock, 0);

  // After each upload: names in the Current stock sheet missing from the FC sheet are mailed (user, 2026-10-16).
  const fcCheck = async (trigger: "restock" | "godown") => {
    const r = await runFcCheck(trigger);
    await qc.invalidateQueries({ queryKey: FC_ALERTS_KEY });
    if (r.status === "sent") return ` ${r.missing?.length ?? 0} name(s) not in the FC sheet — mail sent.`;
    if (r.status === "failed") return ` FC name check mail failed: ${r.error ?? "unknown error"}.`;
    return "";
  };

  // After a restock upload: products whose every Amazon SKU is inactive / deleted go to the Listing Team (user, 2026-10-16).
  const listingCheck = async () => {
    const r = await runListingCheck("restock");
    await qc.invalidateQueries({ queryKey: LISTING_ALERTS_KEY });
    if (r.status === "sent") return ` ${r.missing?.length ?? 0} product(s) with no active Amazon listing — Listing Team mailed.`;
    if (r.status === "failed") return ` Listing check failed: ${r.error ?? "unknown error"}.`;
    return "";
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await uploadGodownWorkbook(file);
      const fc = await fcCheck("godown");
      setNote({ ok: true, text: `Godown sheet saved: ${r.products} products${r.notRestocked ? ` (+ ${r.notRestocked} on Not restocked Products)` : ""}, stock as on ${dateLong(r.snapshotDate)}, ${r.days} days of movement.${r.warnings.length ? " " + r.warnings.join(" ") : ""}${fc}` });
      await refetch();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setBusy(false);
      if (godownRef.current) godownRef.current.value = "";
    }
  };

  const uploadRestock = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await uploadRestockWorkbook(file);
      if (r.kind === "purchase") {
        setNote({ ok: true, text: `Stock Purchase Sheet saved: ${r.rows} products (purchase sheet qty from Suggested RFQ).` });
      } else {
        const [fc, listing] = await Promise.all([fcCheck("restock"), listingCheck()]);
        setNote({ ok: true, text: `Current stock sheet saved for ${dateLong(r.date)}: ${r.rows} products (in transit, order placed).${fc}${listing}` });
      }
      await refetch();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setBusy(false);
      if (restockRef.current) restockRef.current.value = "";
    }
  };

  // Export adds the "Seasonal Analytics" sheet, built from the full godown history (user, 2026-10-13).
  // If that history can't be read, the workbook is still exported without it and the page says so.
  const withSeasonal = async (d: ConsolidatedData) => {
    const asOf = d.dates[d.dates.length - 1];
    try {
      const a = analyzeGodown(d.rows, await readDaily(asOf), asOf);
      return { ...d, seasonal: { coverage: a.coverage, products: a.products } };
    } catch (e) {
      setNote({ ok: false, text: `Seasonal Analytics sheet left out: ${e instanceof Error ? e.message : "godown history could not be read"}` });
      return { ...d, seasonal: null };
    }
  };

  const exportExcel = async () => {
    if (!data) return;
    setExporting(true);
    setNote(null);
    try {
      exportConsolidatedWorkbook(await withSeasonal(data));
    } finally {
      setExporting(false);
    }
  };

  // Mail buttons (user, 2026-10-16): No sales & Sales dropped, Running out of stock and the Consolidated
  // sheet go separately, each from its own button with its own file and recipients (src/lib/consolidatedMail.ts).
  const sendMail = async (kind: ConsolidatedMailKind) => {
    if (!data) return;
    const title = CONSOLIDATED_MAIL_TITLE[kind];
    if (!window.confirm(`Send the "${title}" mail now?`)) return;
    setMailing(kind);
    setNote(null);
    try {
      const f = consolidatedMailFiles(data).find((x) => x.kind === kind)!;
      let bin = "";
      for (let i = 0; i < f.bytes.length; i += 0x8000) bin += String.fromCharCode(...f.bytes.subarray(i, i + 0x8000));
      const r = await fetch("/api/consolidated-mail", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, filename: f.filename, content: btoa(bin), date: f.date, rows: f.rows }),
      });
      const j = await r.json().catch(() => ({}));
      setNote(r.ok ? { ok: true, text: `"${title}" mail sent.` } : { ok: false, text: `"${title}" mail not sent: ${j?.error || `HTTP ${r.status}`}` });
    } catch (e) {
      setNote({ ok: false, text: `"${title}" mail not sent: ${e instanceof Error ? e.message : "request failed"}` });
    } finally {
      setMailing(null);
    }
  };

  const dates = data?.dates ?? [];
  const tabBtn = (v: View, label: string, n: number) => (
    <button key={v} onClick={() => setView(v)} className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${view === v ? "bg-indigo-600 text-white shadow" : "text-muted-foreground hover:text-foreground"}`}>
      {label} <span className="tabular-nums opacity-80">({n})</span>
    </button>
  );
  const th = "px-2.5 py-2.5 text-right whitespace-nowrap";
  const td = "px-2.5 py-2 text-right tabular-nums";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Consolidated Stock Sheet</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isLoading ? <>Loading godown days up to {dateLong(asOf ?? null)}…</> : dates.length ? <>Days <b className="text-foreground">{dateLong(dates[0])} – {dateLong(dates[dates.length - 1])}</b> (last {CONSOLIDATED_DAYS} godown days up to {dateLong(asOf ?? null)})</> : <>No godown days up to {dateLong(asOf ?? null)}</>}
            {" "}· current stock as on <b className="text-foreground">{dateLong(data?.snapshotDate ?? null)}</b>
          </p>
          {data?.weekly?.status === "ok" && (
            <p className="mt-0.5 text-sm text-muted-foreground" id="weekly-snapshot-label">{weeklyLabel(data.weekly)}</p>
          )}
        </div>
        <InventoryTabs />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input ref={godownRef} id="godown-file" type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
        <button onClick={() => godownRef.current?.click()} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload godown stock sheet
        </button>
        <input ref={restockRef} id="restock-file" type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => uploadRestock(e.target.files?.[0])} />
        <button onClick={() => restockRef.current?.click()} disabled={busy} title='"Current stock sheet-DD-MM-YYYY.xlsx": in transit and order placed · "Stock Purchase Sheet.xlsx": purchase sheet qty' className="flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-background px-3.5 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-950">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload restock inputs
        </button>
        <button onClick={exportExcel} disabled={!data?.rows.length || exporting} className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 py-2 text-xs font-bold hover:bg-muted disabled:opacity-60">
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export Excel
        </button>
{(["runningout", "consolidated", "nosales"] as ConsolidatedMailKind[]).map((k) => (
          <button key={k} onClick={() => sendMail(k)} disabled={!data?.rows.length || mailing !== null} title={`Mail the "${CONSOLIDATED_MAIL_TITLE[k]}" file`} className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 py-2 text-xs font-bold hover:bg-muted disabled:opacity-60">
            {mailing === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Mail: {CONSOLIDATED_MAIL_TITLE[k]}
          </button>
        ))}
        {note && (
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${note.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
            {note.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}{note.text}
          </span>
        )}
      </div>

      {data?.weekly && data.weekly.status !== "ok" && (
        <div role="alert" id="weekly-snapshot-warning" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{weeklyLabel(data.weekly)}</span>
        </div>
      )}

      {!!data?.stockIssues?.length && (
        <div role="alert" id="stock-mapping-warning" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>Godown stock check: {data.stockIssues.length} product{data.stockIssues.length === 1 ? "" : "s"} in the godown file {data.stockIssues.length === 1 ? "does" : "do"} not map cleanly to this sheet.</p>
            <ul className="mt-1 list-disc pl-4 font-normal">
              {data.stockIssues.map((i) => <li key={i.product}><b>{i.product}</b>: {i.note}</li>)}
            </ul>
          </div>
        </div>
      )}

      {!!data?.rfqIssues?.length && (
        <div role="alert" id="rfq-matching-warning" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>Purchase sheet qty check: {data.rfqIssues.length} product name{data.rfqIssues.length === 1 ? "" : "s"} could not be matched safely. Check the spelling in the source file.</p>
            <ul className="mt-1 list-disc pl-4 font-normal">
              {data.rfqIssues.map((i) => <li key={`${i.kind}|${i.product}`}><b>{i.product}</b>: {i.note}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-2">
        <FcNameAlertPanel />
        <ListingAlertPanel />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading stock…</div>
      ) : isError ? (
        <QueryErrorState message={`Consolidated stock couldn't load: ${(error as Error)?.message ?? "unknown error"}`} onRetry={() => refetch()} />
      ) : !data?.snapshotDate ? (
        <div className="glass rounded-2xl border border-border p-10 text-center">
          <p className="text-sm font-semibold">{asOf ? `No godown stock uploaded on or before ${dateLong(asOf)}.` : "No godown stock uploaded yet."}</p>
          <p className="mt-1 text-xs text-muted-foreground">Upload the &quot;Combined godown stock sheet as on DD.MM.YYYY.xlsx&quot; file to build the consolidated sheet.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <KPICard title="Products" value={int(data.rows.length)} subtitle={data.weekly?.transit.from === "current" ? "From the restock inputs sheet" : "From the godown sheet"} accent="purple" />
            <KPICard title={`Running out (< ${RUNNING_OUT_DAYS} days)`} value={int(lists.running.length)} subtitle="Current stock ÷ average per day" accent="orange" onClick={() => setView("running")} />
            <KPICard title="Sales dropped" value={int(lists.dropped.length)} subtitle="Day 3 > Day 2 > Day 1" accent="pink" onClick={() => setView("dropped")} />
            <KPICard title={`No sales (${CONSOLIDATED_DAYS} days)`} value={int(lists.nosales.length)} subtitle={`Stock ${NO_SALES_MIN_STOCK}+, not discontinued`} accent="cyan" onClick={() => setView("nosales")} />
            <KPICard title="Final qty to restock" value={int(totalRestock)} subtitle="Units, for the next 180 days" accent="green" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex flex-wrap rounded-xl border border-border bg-background p-1 shadow-sm">
              {tabBtn("all", "All products", lists.all.length)}
              {tabBtn("running", "Running out of stock", lists.running.length)}
              {tabBtn("dropped", "Sales dropped", lists.dropped.length)}
              {tabBtn("nosales", "No sales", lists.nosales.length)}
              {tabBtn("notlisted", "Not listed on platform", NOT_LISTED_PRODUCTS.length)}
            </div>
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input id="consolidated-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product" className="w-64 rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-xs" />
            </label>
          </div>

          {view === "notlisted" ? (
          <div className="glass overflow-hidden rounded-2xl border border-border">
            <p className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
              Godown stock with no marketplace listing — the client&apos;s own list (no formula), as in their Consolidate sheet of {dateLong(NOT_LISTED_AS_OF)}.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#C5E0B3] text-[10px] uppercase tracking-wider text-[#1f3d12] dark:bg-[#2f4a24] dark:text-[#dcefd0]">
                  <tr><th className="px-3 py-2.5 text-left">Product</th><th className={th}>Quantity</th></tr>
                </thead>
                <tbody>
                  {notListed.map(([p, q], i) => (
                    <tr key={i} className="border-t border-border/60 hover:bg-muted/30">
                      <td className="px-3 py-2 font-semibold">{p}</td>
                      <td className={`${td} font-bold`}>{typeof q === "number" ? int(q) : q}</td>
                    </tr>
                  ))}
                  {!notListed.length && <tr><td colSpan={2} className="px-3 py-10 text-center text-muted-foreground">No products in this list.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          ) : (
          <div className="glass overflow-hidden rounded-2xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#C5E0B3] text-[10px] uppercase tracking-wider text-[#1f3d12] dark:bg-[#2f4a24] dark:text-[#dcefd0]">
                  <tr>
                    <th className="sticky left-0 z-10 bg-[#C5E0B3] px-3 py-2.5 text-left dark:bg-[#2f4a24]">Product</th>
                    {(view === "all" || view === "nosales") && dates.map((d, i) => <th key={d} className={th} title={d}>Day {dates.length - i}<br /><span className="normal-case">{dayLabel(d)}</span></th>)}
                    {view === "dropped" && dates.slice(-3).map((d, i) => <th key={d} className={th}>Day {3 - i}<br /><span className="normal-case">{dayLabel(d)}</span></th>)}
                    {(view === "all" || view === "running") && <th className={th}>Avg / day</th>}
                    {view === "all" && <><th className={th}>Need 180d</th><th className={th}>Need 90d</th><th className={th}>Need 45d</th></>}
                    <th className={th}>Current stock</th>
                    {(view === "dropped" || view === "nosales") && <th className={th} title="Best single day over every godown day up to the picked date">Peak sales</th>}
                    {view === "all" && <><th className={th}>In transit</th><th className={th}>Order placed</th><th className={th}>Qty to restock</th><th className={th}>Purchase sheet qty</th><th className={th}>Final qty to restock</th><th className={th}>Combo stock to buy</th></>}
                    {(view === "all" || view === "running") && <th className={th}>Runs out in</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r: ConsolidatedRow) => (
                    <tr key={r.product} className="border-t border-border/60 hover:bg-muted/30">
                      <td className="sticky left-0 z-10 max-w-[260px] truncate bg-background px-3 py-2 font-semibold" title={r.product}>
                        {r.product}{r.discontinued && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-400">DISCONTINUED</span>}
                      </td>
                      {(view === "all" || view === "nosales") && r.days.map((v, i) => <td key={i} className={`${td} ${dropCls(r.days, i)} ${!v ? "text-muted-foreground" : ""}`}>{v ?? 0}</td>)}
                      {view === "dropped" && r.days.slice(-3).map((v, i, arr) => <td key={i} className={`${td} ${dropCls(arr, i)} font-bold`}>{v ?? 0}</td>)}
                      {(view === "all" || view === "running") && <td className={td}>{dec(r.avgPerDay)}</td>}
                      {view === "all" && <><td className={td}>{int(r.need180)}</td><td className={td}>{int(r.need90)}</td><td className={td}>{int(r.need45)}</td></>}
                      <td className={`${td} font-bold`}>{int(r.currentStock)}</td>
                      {(view === "dropped" || view === "nosales") && (
                        <td className={`${td} whitespace-nowrap`}>{r.peakQty === null ? <span className="text-muted-foreground">Never shipped</span> : <><b>{int(r.peakQty)}</b> <span className="text-muted-foreground">on {dateLong(r.peakDate)}</span></>}</td>
                      )}
                      {view === "all" && <>
                        <td className={td}>{int(r.stockIntransit)}</td>
                        <td className={td}>{int(r.orderPlaced)}</td>
                        <td className={`${td} ${r.qtyToRestock < 0 ? "text-muted-foreground" : ""}`}>{int(r.qtyToRestock)}</td>
                        <td className={td}>{int(r.purchaseQty)}</td>
                        <td className={`${td} font-bold text-indigo-700 dark:text-indigo-300`}>{int(r.finalQtyToRestock)}</td>
                        <td className={td} title="Components Sheet: Σ qty per unit × RFQ of each product it goes into, less its stock">{int(r.comboQty)}</td>
                      </>}
                      {(view === "all" || view === "running") && <td className="px-2.5 py-2 text-right">{coverChip(r.daysOfStock)}</td>}
                    </tr>
                  ))}
                  {!shown.length && <tr><td colSpan={30} className="px-3 py-10 text-center text-muted-foreground">No products in this list.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          )}

          <p className="flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Current stock = inbound shipped + unfulfillable + final stock in warehouse + QC godown + packing godown (godown FC Stock sheet).
              Day columns = Stock Out per day. Average = last {CONSOLIDATED_DAYS} days ÷ {CONSOLIDATED_DAYS}. Qty to restock = 180-day need − (current + in transit + order placed);
              final qty = the larger of that and the purchase-sheet qty (Suggested RFQ from the last uploaded Stock Purchase Sheet, else the week&apos;s Monday snapshot), never below 0. Combo stock to buy is 0 for every product for now. Runs out in = current stock ÷ average per day.
            </span>
          </p>
        </>
      )}
    </div>
  );
}
