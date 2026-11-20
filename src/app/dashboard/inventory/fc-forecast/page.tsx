"use client";

// FC Forecast — the client's weekly "FC forecast sheet" (min stock per product for B-ARM's own warehouse),
// rebuilt from Supabase instead of pasted by hand (2026-11-20, docs/superpowers/specs/2026-11-20-fc-forecast-design.md).
// Min stock = MAX(ROUND(MAX(peak of three rolling 30-day blocks, last 30 days) x 1.5), 5), as of yesterday (IST).

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { InventoryTabs } from "@/components/InventoryTabs";
import { KPICard } from "@/components/KPICard";
import { QueryErrorState } from "@/components/QueryErrorState";
import { supabasePublic } from "@/lib/amazonReportUpload";
import { FC_KEYS, fetchFcForecast, fetchFcProductNames, fetchFcSourceDates, fetchFcUnmapped, saveSkuMapping } from "@/lib/fcForecastData";
import { blocks, rangeLabel, staleChannels, sourceCheckNotice, unmappedKpi, yesterdayIst, FC_CHANNELS, FC_CHANNEL_LABEL, type FcRow, type FcUnmapped } from "@/lib/fcForecastRules";
import { exportFcWorkbook } from "@/lib/fcForecastExport";
import { uploadSellerFlexCsv } from "@/lib/sellerFlexUpload";
import { Loader2, Upload, Download, Search, CheckCircle2, AlertTriangle } from "lucide-react";

const int = (v: number | null | undefined) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v ?? 0));
const dateLong = (iso: string | null | undefined) =>
  iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "no data";

type SortKey = "product" | "block3" | "block2" | "block1" | "peak" | "max_units" | "min_stock" | "ch_amazon" | "ch_flipkart" | "ch_meesho" | "ch_website" | "ch_sellerflex";

export default function FcForecastPage() {
  const qc = useQueryClient();
  const yesterday = yesterdayIst();
  const [asOf, setAsOf] = useState(yesterday);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "min_stock", desc: true });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const forecast = useQuery({ queryKey: FC_KEYS.forecast(asOf), queryFn: () => fetchFcForecast(asOf) });
  const unmapped = useQuery({ queryKey: FC_KEYS.unmapped(asOf), queryFn: () => fetchFcUnmapped(asOf) });
  const sources = useQuery({ queryKey: FC_KEYS.sources, queryFn: fetchFcSourceDates });
  const productNames = useQuery({ queryKey: FC_KEYS.products, queryFn: fetchFcProductNames, staleTime: 10 * 60 * 1000 });

  const b = blocks(asOf);
  const stale = useMemo(() => staleChannels(sources.data ?? [], asOf), [sources.data, asOf]);
  const newestByChannel = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of sources.data ?? []) {
      const prev = m.get(s.channel);
      if (prev === undefined || (s.max_day && (!prev || s.max_day > prev))) m.set(s.channel, s.max_day ?? prev ?? null);
    }
    return m;
  }, [sources.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (forecast.data ?? []).filter((r) => !q || r.product.toLowerCase().includes(q));
    const { key, desc } = sort;
    return [...list].sort((x, y) => {
      const c = key === "product" ? x.product.localeCompare(y.product) : (x[key] as number) - (y[key] as number);
      return (desc ? -c : c) || x.product.localeCompare(y.product);
    });
  }, [forecast.data, search, sort]);

  const totalMin = (forecast.data ?? []).reduce((a, r) => a + r.min_stock, 0);
  const unmappedUnits = (unmapped.data ?? []).reduce((a, u) => a + u.units_90d, 0);
  const umKpi = unmappedKpi(unmapped.data, unmapped.isError);
  const sourceNotice = sourceCheckNotice(sources.isError, stale);

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["fc_forecast"] }),
      qc.invalidateQueries({ queryKey: ["fc_unmapped_skus"] }),
      qc.invalidateQueries({ queryKey: FC_KEYS.sources }),
      qc.invalidateQueries({ queryKey: FC_KEYS.products }),
    ]);
  };

  const uploadSellerFlex = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await uploadSellerFlexCsv(supabasePublic, file);
      setNote({ ok: true, text: `Seller Flex: ${int(r.saved)} shipments saved (${dateLong(r.minDate)} – ${dateLong(r.maxDate)})${r.skipped ? `, ${r.skipped} rows skipped` : ""}.` });
      await refreshAll();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "product" }));
  const th = "px-2.5 py-2.5 text-right whitespace-nowrap cursor-pointer select-none hover:text-foreground";
  const td = "px-2.5 py-2 text-right tabular-nums";
  const arrow = (k: SortKey) => (sort.key === k ? (sort.desc ? " ↓" : " ↑") : "");
  const head = (k: SortKey, label: string, sub?: string, className = th) => (
    <th key={k} className={className} onClick={() => sortBy(k)}>{label}{arrow(k)}{sub && <div className="font-normal normal-case">{sub}</div>}</th>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">FC Forecast</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Minimum stock for our own warehouse = MAX(ROUND(highest 30-day block of the last 90 days × 1.5), 5). Self-ship orders only (no FBA / FBF), cancelled orders left out.
          </p>
        </div>
        <InventoryTabs />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-bold">
          As of
          <input id="fc-as-of" type="date" value={asOf} max={yesterday} onChange={(e) => e.target.value && setAsOf(e.target.value)} className="bg-transparent text-xs font-semibold outline-none" />
        </label>
        <button
          onClick={() => forecast.data && unmapped.data && exportFcWorkbook(forecast.data, unmapped.data, asOf)}
          disabled={!forecast.data?.length || !unmapped.data}
          title={unmapped.isError ? "The unmapped-SKU list failed to load; reload before downloading" : undefined}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          <Download className="h-3.5 w-3.5" /> Download xlsx
        </button>
        <input ref={fileRef} id="sellerflex-file" type="file" accept=".csv" className="hidden" onChange={(e) => uploadSellerFlex(e.target.files?.[0])} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title='Amazon Seller Flex "VSNC-CUSTOMER_SHIPMENTS-ALL-<from>-<to>.csv"'
          className="flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-background px-3.5 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-950"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload Seller Flex shipments CSV
        </button>
        {note && (
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${note.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
            {note.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}{note.text}
          </span>
        )}
      </div>

      <div id="fc-data-up-to" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-bold text-foreground">Data up to:</span>
        {FC_CHANNELS.map((c) => (
          <span key={c} className={stale.includes(c) ? "font-semibold text-amber-700 dark:text-amber-300" : ""}>
            {FC_CHANNEL_LABEL[c]}: {dateLong(newestByChannel.get(c))}{stale.includes(c) ? " (before the as-of date)" : ""}
          </span>
        ))}
      </div>

      {sourceNotice && (
        <div role="alert" id="fc-stale-warning" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{sourceNotice}</span>
        </div>
      )}

      {forecast.isLoading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building the forecast…</div>
      ) : forecast.isError ? (
        <QueryErrorState message={`The FC forecast couldn't load: ${(forecast.error as Error)?.message ?? "unknown error"}`} onRetry={() => forecast.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KPICard title="Products" value={int(forecast.data?.length)} subtitle="Client list + any product sold in 90 days" accent="purple" />
            <KPICard title="Total minimum stock" value={int(totalMin)} subtitle="Units, all products" accent="green" />
            <KPICard title="Last 30 days sold" value={int((forecast.data ?? []).reduce((a, r) => a + r.last30, 0))} subtitle={rangeLabel(b.b1)} accent="blue" />
            <KPICard title="Unmapped SKUs" value={umKpi.value} subtitle={unmapped.isError ? "Couldn't load the unmapped list" : `${int(unmappedUnits)} units in 90 days not in any product`} accent="orange" />
          </div>

          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product…" className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm" />
          </div>

          <div className="glass overflow-x-auto rounded-2xl border border-border">
            <table id="fc-forecast-table" className="w-full text-xs">
              <thead className="bg-muted/60 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                <tr>
                  {head("product", "Product", undefined, "sticky left-0 z-10 bg-muted px-2.5 py-2.5 text-left cursor-pointer select-none")}
                  {head("block3", "Block 3", rangeLabel(b.b3))}
                  {head("block2", "Block 2", rangeLabel(b.b2))}
                  {head("block1", "Last 30 days", rangeLabel(b.b1))}
                  {head("peak", "Peak")}
                  {head("max_units", "Max")}
                  {head("min_stock", "Min stock")}
                  {FC_CHANNELS.map((c) => head(`ch_${c}` as SortKey, FC_CHANNEL_LABEL[c], "last 30 days"))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r: FcRow) => (
                  <tr key={r.product} className="border-t border-border hover:bg-muted/40">
                    <td className="sticky left-0 z-10 bg-background px-2.5 py-2 font-semibold">{r.product}</td>
                    <td className={td}>{int(r.block3)}</td>
                    <td className={td}>{int(r.block2)}</td>
                    <td className={td}>{int(r.block1)}</td>
                    <td className={td}>{int(r.peak)}</td>
                    <td className={td}>{int(r.max_units)}</td>
                    <td className={`${td} font-extrabold text-indigo-700 dark:text-indigo-300`}>{int(r.min_stock)}</td>
                    <td className={td}>{int(r.ch_amazon)}</td>
                    <td className={td}>{int(r.ch_flipkart)}</td>
                    <td className={td}>{int(r.ch_meesho)}</td>
                    <td className={td}>{int(r.ch_website)}</td>
                    <td className={td}>{int(r.ch_sellerflex)}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={12} className="px-3 py-10 text-center text-muted-foreground">No products match.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <UnmappedPanel items={unmapped.data ?? []} loading={unmapped.isLoading} error={unmapped.isError ? ((unmapped.error as Error)?.message ?? "unknown error") : null} onRetry={() => unmapped.refetch()} names={productNames.data ?? []} onSaved={refreshAll} />
        </>
      )}
    </div>
  );
}

function UnmappedPanel({ items, loading, error, onRetry, names, onSaved }: { items: FcUnmapped[]; loading: boolean; error: string | null; onRetry: () => void; names: string[]; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (u: FcUnmapped) => {
    const key = `${u.sku}|${u.channel}`;
    setSaving(key);
    setMsg(null);
    try {
      await saveSkuMapping(u.sku, draft[key] ?? "");
      setMsg({ ok: true, text: `${u.sku} → ${(draft[key] ?? "").trim()} saved.` });
      await onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div id="fc-unmapped" className="glass rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-extrabold">Unmapped SKUs (last 90 days)</h2>
          <p className="text-xs text-muted-foreground">These sales are not in any product above. Pick a product (or type a new name) and save; the forecast updates.</p>
        </div>
        {msg && <span className={`text-xs font-semibold ${msg.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>{msg.text}</span>}
      </div>
      <datalist id="fc-product-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
      ) : error ? (
        <div className="mt-3"><QueryErrorState message={`The unmapped-SKU list couldn't load: ${error}`} onRetry={onRetry} /></div>
      ) : !items.length ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-green-700 dark:text-green-400"><CheckCircle2 className="h-3.5 w-3.5" /> Every SKU sold in the last 90 days is mapped to a product.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-2 py-2 text-left">SKU</th><th className="px-2 py-2 text-left">Channel</th><th className="px-2 py-2 text-right">Units</th><th className="px-2 py-2 text-left">Title</th><th className="px-2 py-2 text-left">Product</th></tr>
            </thead>
            <tbody>
              {items.map((u) => {
                const key = `${u.sku}|${u.channel}`;
                return (
                  <tr key={key} className="border-t border-border">
                    <td className="px-2 py-2 font-mono font-semibold">{u.sku}</td>
                    <td className="px-2 py-2">{FC_CHANNEL_LABEL[u.channel] ?? u.channel}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{int(u.units_90d)}</td>
                    <td className="max-w-xs truncate px-2 py-2 text-muted-foreground" title={u.sample_title ?? ""}>{u.sample_title ?? ""}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1.5">
                        <input list="fc-product-names" value={draft[key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} placeholder="Product name" className="w-64 rounded-md border border-border bg-background px-2 py-1 text-xs" />
                        <button onClick={() => save(u)} disabled={saving !== null || !(draft[key] ?? "").trim()} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-60">
                          {saving === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
