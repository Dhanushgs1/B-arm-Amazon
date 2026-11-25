"use client";

// Product Marketing 360 — the marketing team's per-product template on the dashboard (user, 2026-11-17).
// Auto sections come from /api/marketing-360 (stored data only: ad reports, inventory, and the Drive
// files imported into the mkt_* tables). The team's own planning — TAM, audience, retargeting, content,
// influencers, action plan, channel notes — is typed in here and saved to Supabase.
// Missing data is shown as missing ("—" / "No data"), never as zero.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  Loader2, Search, Star, Megaphone, Boxes, MapPin, KeyRound, Users, ClipboardList, Target, ExternalLink,
  AlertTriangle, Plus, Trash2, Save, RefreshCw, StickyNote, Truck, Package, Download, Pencil, X,
} from "lucide-react";
import { supabasePublic as db } from "@/lib/amazonReportUpload";
import { RETARGET_OPTIONS, CHANNELS } from "@/lib/marketing360Import";
import { deliveryTone, profileEdit, zoneLabel, SLOW_DAYS, type SheetEdit } from "@/lib/marketing360Rules";
import type { SourceRow } from "@/lib/marketing360Sources";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Product = { asin: string; name: string; category: string | null; active: boolean; skus: string[]; has_profile: boolean };

const CONTENT_ITEMS = ["How to use video", "QR for pamphlet", "Pamphlets", "Description in listing with SEO", "Audio", "Hashtags"] as const;
const LANGUAGES = ["Hindi", "English", "Bengali", "Marathi", "Telugu", "Tamil", "Gujarati", "Urdu", "Kannada", "Odia", "Malayalam"];

const fmt = (n: number | null | undefined, d = 0) => (n === null || n === undefined || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d }));
const inr = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `₹${fmt(n)}`);
const crore = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n >= 1e7 ? `₹${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 1 })} Cr` : n >= 1e5 ? `₹${(n / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 1 })} L` : inr(n));
const buyersText = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n >= 1e7 ? `${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} crore` : n >= 1e5 ? `${(n / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 1 })} lakh` : fmt(n));
/** FBA inventory report upload: "uploaded 31 Oct 2026", flagged when 3+ days old (user, 2026-11-18). */
const IST_DAY = (t: string | Date) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function reportAge(createdAt: string | null | undefined): { label: string; days: number | null } {
  if (!createdAt) return { label: "upload date unknown", days: null };
  const day = IST_DAY(createdAt);
  const days = Math.round((Date.parse(`${IST_DAY(new Date())}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 864e5);
  return { label: `uploaded ${dateLabel(day)}`, days };
}
const dateLabel = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

function Section({ icon: Icon, title, source, children, right }: { icon: typeof Star; title: string; source?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-extrabold"><Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />{title}</h2>
          {source && <p className="mt-0.5 text-[11px] text-muted-foreground">{source}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

const STATE_CLS: Record<string, string> = {
  On: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800",
  Off: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800",
  "Not set up": "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700",
  "No data": "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-800",
};
const Pill = ({ text, cls }: { text: string; cls?: string }) => (
  <span className={`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${cls ?? STATE_CLS[text] ?? STATE_CLS["No data"]}`}>{text}</span>
);
const TONE: Record<string, { cls: string; label: string }> = {
  fast: { cls: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300", label: "≤2 days" },
  ok: { cls: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300", label: "3–5 days" },
  slow: { cls: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300", label: "6+ days" },
  none: { cls: "border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400", label: "No delivery / unavailable" },
};
const Pos = ({ v }: { v: number | null }) => (v === null ? <span className="text-muted-foreground">—</span> : <b className={v <= 3 ? "text-emerald-700 dark:text-emerald-400" : v <= 10 ? "" : "text-amber-700 dark:text-amber-400"}>#{v}</b>);
const th = "px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground";
const td = "px-2 py-1.5 align-top";
const input = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs";
const btn = "inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-bold hover:bg-muted disabled:opacity-60";
const btnPrimary = "inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60";

// ── manual: profile ───────────────────────────────────────────────────────────────────────────
function ProfileEditor({ asin, profile, onSaved }: { asin: string; profile: any; onSaved: () => void }) {
  const [p, setP] = useState<any>(() => ({ tam_value: "", primary_audience: "", secondary_audience: "", retarget: {}, content: {}, ad_keywords: "", notes: "", fba_weight_note: "", ...(profile ?? {}) }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setMsg(null);
    const row = {
      asin, tam_value: p.tam_value === "" || p.tam_value === null ? null : Number(p.tam_value), primary_audience: p.primary_audience || null,
      secondary_audience: p.secondary_audience || null, retarget: p.retarget ?? {}, content: p.content ?? {}, ad_keywords: p.ad_keywords || null,
      notes: p.notes || null, fba_weight_note: p.fba_weight_note || null, updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("mkt_product_profile").upsert(row, { onConflict: "asin" });
    setBusy(false);
    setMsg(error ? `Not saved: ${error.message}` : "Saved");
    if (!error) onSaved();
  };
  const toggle = (k: "retarget" | "content", key: string) => setP((x: any) => ({ ...x, [k]: { ...(x[k] ?? {}), [key]: !x[k]?.[key] } }));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <label className="block text-[11px] font-bold text-muted-foreground">TAM value (₹)
          <input className={input} inputMode="numeric" value={p.tam_value ?? ""} onChange={(e) => setP({ ...p, tam_value: e.target.value.replace(/[^\d.]/g, "") })} />
        </label>
        <label className="block text-[11px] font-bold text-muted-foreground">Primary audience
          <textarea className={input} rows={3} value={p.primary_audience ?? ""} onChange={(e) => setP({ ...p, primary_audience: e.target.value })} />
        </label>
        <label className="block text-[11px] font-bold text-muted-foreground">Secondary audience
          <textarea className={input} rows={3} value={p.secondary_audience ?? ""} onChange={(e) => setP({ ...p, secondary_audience: e.target.value })} />
        </label>
        <label className="block text-[11px] font-bold text-muted-foreground">Google / Meta campaign words (comma separated — used to find this product&apos;s campaigns)
          <input className={input} placeholder="e.g. postpartum, p0stpartum" value={p.ad_keywords ?? ""} onChange={(e) => setP({ ...p, ad_keywords: e.target.value })} />
        </label>
        <label className="block text-[11px] font-bold text-muted-foreground">FBA in which low-weight products cannot be onboarded (manual)
          <input className={input} placeholder="e.g. SATF, SDEU (H&B)" value={p.fba_weight_note ?? ""} onChange={(e) => setP({ ...p, fba_weight_note: e.target.value })} />
        </label>
      </div>
      <div className="space-y-3">
        <div>
          <p className="mb-1 text-[11px] font-bold text-muted-foreground">Ways retargeting is done</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {RETARGET_OPTIONS.map((o) => (
              <label key={o} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!p.retarget?.[o]} onChange={() => toggle("retarget", o)} />{o}</label>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-bold text-muted-foreground">Content ready</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {CONTENT_ITEMS.map((o) => (
              <label key={o} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!p.content?.[o]} onChange={() => toggle("content", o)} />{o}</label>
            ))}
          </div>
        </div>
        <label className="block text-[11px] font-bold text-muted-foreground">Notes
          <textarea className={input} rows={2} value={p.notes ?? ""} onChange={(e) => setP({ ...p, notes: e.target.value })} />
        </label>
        <div className="flex items-center gap-2">
          <button className={btnPrimary} disabled={busy} onClick={save}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save</button>
          {msg && <span className={`text-xs font-semibold ${msg === "Saved" ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}

// ── manual: rows (action plan / influencers) ──────────────────────────────────────────────────
function ActionPlan({ asin, rows, onChange }: { asin: string; rows: any[]; onChange: () => void }) {
  const [draft, setDraft] = useState({ plan_date: "", task: "" });
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    if (!draft.task.trim()) return;
    const { error } = await db.from("mkt_action_plan").insert({ asin, plan_date: draft.plan_date || null, task: draft.task.trim() });
    if (error) return setErr(error.message);
    setDraft({ plan_date: "", task: "" }); setErr(null); onChange();
  };
  const setStatus = async (id: number, status: string) => { const { error } = await db.from("mkt_action_plan").update({ status }).eq("id", id); if (error) setErr(error.message); else onChange(); };
  const del = async (id: number) => { const { error } = await db.from("mkt_action_plan").delete().eq("id", id); if (error) setErr(error.message); else onChange(); };
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-border"><th className={th}>Date</th><th className={th}>Task</th><th className={th}>Status</th><th className={th} /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td className={td} colSpan={4}><span className="text-muted-foreground">No actions yet.</span></td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border/60">
                <td className={`${td} whitespace-nowrap`}>{r.plan_date ?? "—"}</td>
                <td className={td}>{r.task}</td>
                <td className={td}>
                  <select className="rounded-md border border-border bg-background px-1.5 py-1 text-xs" value={r.status} onChange={(e) => setStatus(r.id, e.target.value)}>
                    {["Open", "In progress", "Done"].map((s) => <option key={s}>{s}</option>)}
                  </select>
                </td>
                <td className={td}><button title="Delete" className="text-muted-foreground hover:text-red-600" onClick={() => del(r.id)}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className={`${input} sm:w-40`} placeholder="Date (e.g. 02.09.2026)" value={draft.plan_date} onChange={(e) => setDraft({ ...draft, plan_date: e.target.value })} />
        <input className={`${input} min-w-0 flex-1`} placeholder="Task" value={draft.task} onChange={(e) => setDraft({ ...draft, task: e.target.value })} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className={btn} onClick={add}><Plus className="h-3.5 w-3.5" /> Add</button>
      </div>
      {err && <p className="text-xs font-semibold text-red-700 dark:text-red-400">{err}</p>}
    </div>
  );
}

function Influencers({ asin, rows, onChange }: { asin: string; rows: any[]; onChange: () => void }) {
  const empty = { kind: "organic", language: "Hindi", influencer_name: "", post_link: "", digital_rights: "", states: "" };
  const [d, setD] = useState(empty);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    if (!d.influencer_name.trim()) return;
    const { error } = await db.from("mkt_influencer_posts").insert({ asin, ...d, influencer_name: d.influencer_name.trim(), post_link: d.post_link || null, digital_rights: d.digital_rights || null, states: d.states || null });
    if (error) return setErr(error.message);
    setD(empty); setErr(null); onChange();
  };
  const del = async (id: number) => { const { error } = await db.from("mkt_influencer_posts").delete().eq("id", id); if (error) setErr(error.message); else onChange(); };
  const byLang = LANGUAGES.map((l) => ({ l, n: rows.filter((r) => r.language === l).length }));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {byLang.map(({ l, n }) => <Pill key={l} text={`${l}: ${n ? `${n} post${n > 1 ? "s" : ""}` : "none"}`} cls={n ? STATE_CLS.On : STATE_CLS["No data"]} />)}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-border"><th className={th}>Type</th><th className={th}>Language</th><th className={th}>Influencer</th><th className={th}>Post</th><th className={th}>Digital rights</th><th className={th}>Status / states</th><th className={th} /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td className={td} colSpan={7}><span className="text-muted-foreground">No influencer posts yet.</span></td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border/60">
                <td className={td}>{r.kind === "ads" ? "Post ad" : "Organic"}</td>
                <td className={td}>{r.language ?? "—"}</td>
                <td className={td}>{r.influencer_name}</td>
                <td className={td}>{r.post_link ? <a className="inline-flex items-center gap-1 text-emerald-700 underline dark:text-emerald-300" href={r.post_link} target="_blank" rel="noreferrer">Open <ExternalLink className="h-3 w-3" /></a> : "—"}</td>
                <td className={td}>{r.digital_rights ?? "—"}</td>
                <td className={td}>{r.states ?? "—"}</td>
                <td className={td}><button title="Delete" className="text-muted-foreground hover:text-red-600" onClick={() => del(r.id)}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <select className={input} value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })}><option value="organic">Organic</option><option value="ads">Post ad</option></select>
        <select className={input} value={d.language} onChange={(e) => setD({ ...d, language: e.target.value })}>{LANGUAGES.map((l) => <option key={l}>{l}</option>)}</select>
        <input className={input} placeholder="Influencer name" value={d.influencer_name} onChange={(e) => setD({ ...d, influencer_name: e.target.value })} />
        <input className={input} placeholder="Post link" value={d.post_link} onChange={(e) => setD({ ...d, post_link: e.target.value })} />
        <input className={input} placeholder="Digital rights" value={d.digital_rights} onChange={(e) => setD({ ...d, digital_rights: e.target.value })} />
        <input className={input} placeholder="Status / states" value={d.states} onChange={(e) => setD({ ...d, states: e.target.value })} />
        <button className={btn} onClick={add}><Plus className="h-3.5 w-3.5" /> Add</button>
      </div>
      {err && <p className="text-xs font-semibold text-red-700 dark:text-red-400">{err}</p>}
    </div>
  );
}

// ── the card ──────────────────────────────────────────────────────────────────────────────────
function ProductCard({ data, reload }: { data: any; reload: () => void }) {
  const ourRating = data.rating.rows.find((r: any) => r.this_star !== null) ?? data.rating.rows[0];
  const cheaper = data.competitors.prices.filter((c: any) => c.is_competitor_cheaper);
  const fcs: any[] = data.fba.fcs;
  const yes = fcs.filter((f) => f.onboarded === "Yes");
  const stocked = yes.filter((f) => (f.stock ?? 0) > 0);
  const zones: any[] = data.forecast.zones;
  const short = zones.filter((z) => z.alert_35d && z.alert_35d !== "OK");
  const deliveryRows = useMemo(() => (data.delivery.latest as any[])
    .map((c) => ({ ...c, city: c.location ? String(c.location).split("/")[0].trim() : "" }))
    .sort((a, b) => a.state.localeCompare(b.state) || (a.city || "~").localeCompare(b.city || "~") || a.pincode.localeCompare(b.pincode)), [data.delivery.latest]);
  const compByTerm = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const c of data.positions.competitors) m.set(c.search_term, [...(m.get(c.search_term) ?? []), c]);
    for (const [k, v] of m) m.set(k, v.filter((c) => c.organic_position !== null || c.sp_position !== null).sort((a, b) => Math.min(a.organic_position ?? 999, a.sp_position ?? 999) - Math.min(b.organic_position ?? 999, b.sp_position ?? 999)).slice(0, 3));
    return m;
  }, [data.positions.competitors]);
  const inv = data.fba.inventory?.[0];

  return (
    <div className="space-y-4">
      {/* headline */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold">{data.productName ?? data.asin}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ASIN <b className="text-foreground">{data.asin}</b> · SKU {data.listing.skus.join(", ") || "—"} · {data.category ?? "No category"} ·{" "}
              <a href={data.listing.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-emerald-700 underline dark:text-emerald-300">Amazon listing <ExternalLink className="h-3 w-3" /></a>
            </p>
          </div>
          <button className={btn} onClick={reload}><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Our price", data.listing.price === null ? "—" : `${inr(Number(data.listing.price))}${data.listing.mrp ? `  (M.R.P. ${inr(Number(data.listing.mrp))})` : ""}`],
            ["Star rating", ourRating?.this_star ? `${ourRating.this_star}★` : "—"],
            ["Ratings", ourRating ? `${fmt(ourRating.this_count)}${ourRating.last_count !== null && ourRating.this_count !== null ? ` (${ourRating.this_count - ourRating.last_count >= 0 ? "+" : ""}${ourRating.this_count - ourRating.last_count} wk)` : ""}` : "—"],
            ["FBA FCs stocked", `${stocked.length} of ${yes.length}`],
            ["Zones short (35 d)", zones.length ? `${short.length} of ${zones.length}` : "—"],
            ["TAM", data.profile?.tam_value ? inr(data.profile.tam_value) : "—"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border/70 bg-background px-3 py-2">
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{k}</p>
              <p className="text-base font-extrabold">{v}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section icon={Star} title="Rating & reviews — ours vs competitors" source={`Ours: Drive weekly rating file, ${dateLabel(data.rating.snapshot_date)} · Competitors: competitor analysis${data.competitors.ratings_week ? `, ${data.competitors.ratings_week}` : ""}`}>
          {data.rating.rows.length === 0 ? <p className="text-xs text-muted-foreground">No rating row for this ASIN in the last imported rating file.</p> : (
            <table className="mb-3 w-full text-xs">
              <thead><tr className="border-b border-border"><th className={th}>SKU</th><th className={th}>Last week</th><th className={th}>This week</th><th className={th}>Stock</th></tr></thead>
              <tbody>{data.rating.rows.map((r: any) => (
                <tr key={r.sku_id} className="border-b border-border/60"><td className={td}>{r.sku_id}</td><td className={td}>{r.last_star ?? "—"}★ · {fmt(r.last_count)}</td><td className={td}><b>{r.this_star ?? "—"}★ · {fmt(r.this_count)}</b></td><td className={td}>{r.stock_status ?? "—"}</td></tr>
              ))}</tbody>
            </table>
          )}
          {/* same-product competitors only, with price (user, 2026-11-25) */}
          {(data.competitors.same ?? []).length === 0 ? <p className="text-xs text-muted-foreground">{data.competitors.blocked ? "Competitor ratings: not readable by the dashboard (same permission as above)." : "No same-product competitor (exact match / close equivalent) stored for this product yet."}</p> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b border-border"><th className={th}>Same-product competitor</th><th className={th}>Marketplace</th><th className={th}>Rating</th><th className={th}>Reviews</th><th className={th}>Price</th><th className={th}>Checked</th></tr></thead>
              <tbody>{data.competitors.same.map((c: any, i: number) => (
                <tr key={i} className="border-b border-border/60">
                  <td className={td}>{c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="text-emerald-700 underline dark:text-emerald-300">{c.name ?? "Competitor"}</a> : c.name ?? "—"}</td>
                  <td className={td}>{c.marketplace ?? "—"}</td>
                  <td className={td}>{c.rating === null ? "—" : `${c.rating}★`}</td>
                  <td className={td}>{fmt(c.reviews)}</td>
                  <td className={td}>{c.price === null ? "—" : <b className={c.cheaper ? "text-red-700 dark:text-red-400" : ""} title={c.our_price === null ? undefined : `Our price ${inr(c.our_price)}`}>{inr(c.price)}</b>}</td>
                  <td className={td}>{c.checked ? dateLabel(c.checked) : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Section>

        <Section icon={Target} title="Price — lowest in market?" source="competitor_analysis (latest checks)" right={data.competitors.prices.length ? <Pill text={cheaper.length ? `${cheaper.length} competitor${cheaper.length > 1 ? "s" : ""} cheaper` : "We are lowest"} cls={cheaper.length ? STATE_CLS.Off : STATE_CLS.On} /> : undefined}>
          {data.competitors.prices.length === 0 ? <p className="text-xs text-muted-foreground">{data.competitors.blocked ? "Competitor prices are not readable by the dashboard yet (the competitor table is limited to signed-in Supabase users)." : "No same-product competitor (exact match / close equivalent) price stored for this ASIN."}</p> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b border-border"><th className={th}>Competitor</th><th className={th}>Their price</th><th className={th}>Our price</th><th className={th}>Checked</th></tr></thead>
              <tbody>{data.competitors.prices.map((c: any, i: number) => (
                <tr key={i} className="border-b border-border/60">
                  <td className={td}>{c.competitor_product_url ? <a href={c.competitor_product_url} target="_blank" rel="noreferrer" className="text-emerald-700 underline dark:text-emerald-300">{c.competitor_product_name ?? c.competitor_seller_name ?? "Competitor"}</a> : c.competitor_product_name ?? "—"} <span className="text-muted-foreground">({c.competitor_marketplace})</span></td>
                  <td className={td}><b className={c.is_competitor_cheaper ? "text-red-700 dark:text-red-400" : ""}>{inr(c.competitor_price)}</b></td>
                  <td className={td}>{inr(c.our_price)}</td>
                  <td className={td}>{dateLabel(c.last_checked_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Section>
      </div>

      {data.adsSuggestion && (
        <Section icon={Megaphone} title="Should ads be on?" source={`A rule, not a forecast: stock in ${8}+ of the "Yes" FBA FCs (the client's ad-status rule), rating ${"≥"} 3.5★, and our price vs the cheapest same-product competitor`}>
          <AdsVerdict s={data.adsSuggestion} />
        </Section>
      )}

      <Section icon={Megaphone} title="Ads status" source={`Amazon product ads: daily upload, last 7 days${data.ads.window ? ` (${dateLabel(data.ads.window.from)} – ${dateLabel(data.ads.window.to)})` : ""} · display ads to ${dateLabel(data.ads.display.to)} · brand ads to ${dateLabel(data.ads.brand.to)} (their latest reports) · Google / Meta: campaign names containing “${data.ads.keywords.join("”, “") || "—"}”, last 7 days to ${dateLabel(data.ads.google.to)}`}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {([["Amazon product ads", data.ads.product], ["Amazon display ads", data.ads.display], ["Amazon brand ads", data.ads.brand], ["Google ads", data.ads.google], ["Meta (Facebook / Instagram)", data.ads.meta]] as [string, any][]).map(([label, a]) => (
            <div key={label} className="rounded-lg border border-border/70 bg-background p-2.5">
              <div className="flex items-center justify-between gap-2"><p className="text-xs font-bold">{label}</p><Pill text={a.state} /></div>
              <p className="mt-1 text-[11px] text-muted-foreground">Spend {inr(a.spend)}{a.sales !== undefined ? ` · Sales ${inr(a.sales)}` : ""}</p>
              {a.campaigns?.length > 0 && <p className="mt-1 line-clamp-3 text-[11px] text-muted-foreground" title={a.campaigns.join("\n")}>{a.campaigns.join(" · ")}</p>}
            </div>
          ))}
        </div>
      </Section>

      <Section icon={Boxes} title="FBA stock by fulfilment centre" source={`Drive FBA forecast file, FC balances as on ${dateLabel(data.fba.report_date)} · onboarding per "FBA warehouse details" sheet`}
        right={inv ? (() => {
          const age = reportAge(inv.created_at);
          const old = age.days === null || age.days >= 3;
          return (
            <span className="text-right text-[11px] text-muted-foreground">
              FBA report: fulfillable {fmt(inv.afn_fulfillable_quantity)} · reserved {fmt(inv.afn_reserved_quantity)} · inbound {fmt((inv.afn_inbound_working_quantity ?? 0) + (inv.afn_inbound_shipped_quantity ?? 0) + (inv.afn_inbound_receiving_quantity ?? 0))}
              <br />
              <span className={old ? "font-semibold text-amber-600 dark:text-amber-400" : ""}>
                {age.label}{age.days !== null && age.days > 0 ? ` (${age.days} day${age.days === 1 ? "" : "s"} old)` : age.days === 0 ? " (today)" : ""}{old ? " · old, upload a fresh FBA inventory report" : ""}
              </span>
            </span>
          );
        })() : undefined}>
        <p className="mb-2 text-xs"><b>{stocked.length}</b> of <b>{yes.length}</b> onboarded FCs hold stock · total sellable <b>{fmt(fcs.reduce((a, f) => a + (f.stock ?? 0), 0))}</b> units</p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-8">
          {fcs.map((f) => (
            <div key={f.fc} className={`rounded-md border px-2 py-1.5 text-[11px] ${f.stock > 0 ? (f.stock <= 20 ? TONE.ok.cls : TONE.fast.cls) : f.onboarded === "Yes" ? TONE.slow.cls : TONE.none.cls}`} title={f.region ?? ""}>
              <p className="font-extrabold">{f.fc} <span className="font-semibold opacity-80">· {f.onboarded}</span></p>
              <p>{fmt(f.stock)} units{f.stock > 0 && f.stock <= 20 ? " (≤20)" : f.onboarded === "Yes" && !f.stock ? " (empty)" : ""}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={Truck} title="Delivery vs FBA orders by zone" source="Delivery sweep (latest check per pincode) beside the FBA forecast's 30-day orders and stock">
        <ZoneTable rows={data.zoneCompare?.rows ?? []} forecastDate={data.zoneCompare?.forecast_date ?? null} date="" />
      </Section>

      <Section icon={Package} title="FBA forecast by zone" source={`Drive FBA forecast file, ${dateLabel(data.forecast.report_date)}`}>
        {zones.length === 0 ? <p className="text-xs text-muted-foreground">This product&apos;s SKUs are not in the last imported FBA forecast.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-border">{["SKU", "Zone", "Orders 30 d", "Forecast 75 d", "Stock", "Booked", "In transit", "To send", "Runs out in", "35 d forecast", "35 d short", "Alert"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody>{zones.map((z) => (
                <tr key={z.sku + z.zone} className="border-b border-border/60">
                  <td className={td}>{z.sku}</td><td className={td}>{z.zone.replace(/_zone$/i, "")}</td><td className={td}>{fmt(z.orders_30d)}</td><td className={td}>{fmt(z.forecast_75d)}</td>
                  <td className={td}>{fmt(z.current_stock)}</td><td className={td}>{fmt(z.booked)}</td><td className={td}>{fmt(z.intransit)}</td><td className={td}><b>{fmt(z.to_send)}</b></td>
                  <td className={td}>{z.runs_out_days === null ? "—" : `${fmt(z.runs_out_days)} d`}</td><td className={td}>{fmt(z.forecast_35d)}</td><td className={td}>{fmt(z.shortfall_35d)}</td>
                  <td className={td}>{z.alert_35d ? <Pill text={z.alert_35d} cls={z.alert_35d === "OK" ? STATE_CLS.On : STATE_CLS.Off} /> : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section icon={KeyRound} title="Listing position by search term" source={data.positions.week ? `Gyno competitor position tracker, week ${data.positions.week}` : "Gyno competitor position tracker"}>
        {data.positions.keywords.length === 0 ? <p className="text-xs text-muted-foreground">No position data for this ASIN — the tracker covers Gynaecology products only so far.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-border"><th className={th}>Search term</th><th className={th}>Our ad (SP)</th><th className={th}>Brand ad (SB)</th><th className={th}>Organic</th><th className={th}>Top competitors on this term</th></tr></thead>
              <tbody>{data.positions.keywords.map((k: any) => (
                <tr key={k.search_term} className="border-b border-border/60">
                  <td className={td}>{k.search_term}</td><td className={td}><Pos v={k.sp_position} /></td><td className={td}><Pos v={k.sb_position} /></td><td className={td}><Pos v={k.organic_position} /></td>
                  <td className={td}>{(compByTerm.get(k.search_term) ?? []).map((c) => (
                    <span key={c.asin} className="mr-2 inline-block">{c.competitor_brand ?? c.asin} <span className="text-muted-foreground">(org {c.organic_position ?? "—"}, ad {c.sp_position ?? "—"})</span></span>
                  ))}{!(compByTerm.get(k.search_term) ?? []).length && <span className="text-muted-foreground">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section icon={Truck} title="Delivery days by state and pincode" source={`Drive delivery sweep · latest check per pincode across ${data.delivery.weeks.length} week tabs (${data.delivery.checks} checks)`}
        right={<div className="flex flex-wrap gap-1">{Object.entries(TONE).map(([k, t]) => <span key={k} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${t.cls}`}>{t.label}</span>)}</div>}>
        {data.delivery.latest.length === 0 ? <p className="text-xs text-muted-foreground">No delivery checks for this ASIN in the imported sweep.</p> : (
          // one row per pincode: State | Pincode | City | Delivery days (user, 2026-11-25), state then city order
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card"><tr className="border-b border-border"><th className={th}>State</th><th className={th}>Pincode</th><th className={th}>City</th><th className={th}>Delivery days</th></tr></thead>
              <tbody>{deliveryRows.map((c: any) => {
                const t = TONE[deliveryTone(c)];
                return (
                  <tr key={c.pincode} className="border-b border-border/60" title={`${c.delivery_text ?? c.status ?? ""} · checked ${dateLabel(c.scraped_date)} (${c.week})`}>
                    <td className={td}>{c.state}</td>
                    <td className={td}>{c.pincode}</td>
                    <td className={td}>{c.city || "—"}</td>
                    <td className={td}><span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${t.cls}`}>{c.days === null ? (c.status ?? "—") : `${c.days} ${c.days === 1 ? "day" : "days"}`}</span></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section icon={Users} title="Audience, TAM, retargeting & content" source="Typed in by the marketing team">
        {data.tamSuggest && (
          <div className="mb-3 rounded-lg border border-border/70 bg-background p-3">
            <p className="mb-1 text-xs font-extrabold">Suggested TAM from research — {data.tamSuggest.group.replace(/_/g, " ")}</p>
            <TamSuggest asin={data.asin} s={data.tamSuggest} current={data.profile?.tam_value === undefined || data.profile?.tam_value === null ? null : Number(data.profile.tam_value)} onSaved={() => reload()} full />
          </div>
        )}
        <ProfileEditor key={JSON.stringify(data.profile)} asin={data.asin} profile={data.profile} onSaved={reload} />
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section icon={ClipboardList} title="Action plan" source="Typed in by the marketing team">
          <ActionPlan asin={data.asin} rows={data.plan} onChange={reload} />
        </Section>
        <Section icon={StickyNote} title="Channel notes for this product" source="Channel Notes tab (matched on the product name)">
          {data.notes.length === 0 ? <p className="text-xs text-muted-foreground">No channel notes under “{data.productName}”. Add them on the Channel Notes tab.</p> : (
            <ul className="space-y-1 text-xs">{data.notes.map((n: any) => <li key={n.channel}><b>{CHANNELS.find((c) => c.key === n.channel)?.label ?? n.channel}:</b> {n.note}</li>)}</ul>
          )}
        </Section>
      </div>

      <Section icon={Users} title="Influencer posts" source="Typed in by the marketing team">
        <Influencers asin={data.asin} rows={data.influencers} onChange={reload} />
      </Section>
    </div>
  );
}

// ── channel notes tab (template Sheet1) ───────────────────────────────────────────────────────
function ChannelNotes({ products }: { products: Product[] }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(db.from("mkt_channel_notes").select("product,channel,note").limit(5000)).then(({ data, error }) => {
      if (!live) return;
      if (error) setErr(error.message);
      setNotes(Object.fromEntries((data ?? []).map((n: any) => [`${n.product}|${n.channel}`, n.note])));
      setLoading(false);
    });
    return () => { live = false; };
  }, []);
  const names = useMemo(() => {
    const s = new Set<string>(Object.keys(notes).map((k) => k.split("|")[0]));
    for (const p of products) if (p.active) s.add(p.name);
    return [...s].filter((n) => n.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => Number(!Object.keys(notes).some((k) => k.startsWith(`${b}|`))) - Number(!Object.keys(notes).some((k) => k.startsWith(`${a}|`))) || a.localeCompare(b));
  }, [notes, products, filter]);
  const save = async (product: string, channel: string, note: string) => {
    const key = `${product}|${channel}`;
    if ((notes[key] ?? "") === note) return;
    setSaving(key);
    const { error } = note.trim()
      ? await db.from("mkt_channel_notes").upsert({ product, channel, note: note.trim(), updated_at: new Date().toISOString() }, { onConflict: "product,channel" })
      : await db.from("mkt_channel_notes").delete().eq("product", product).eq("channel", channel);
    setSaving(null);
    if (error) return setErr(error.message);
    setNotes((n) => { const x = { ...n }; if (note.trim()) x[key] = note.trim(); else delete x[key]; return x; });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" /><input className={`${input} pl-7`} placeholder="Filter products" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <span className="text-[11px] text-muted-foreground">Click a cell to edit; it saves when you leave the cell. Empty a cell to remove the note.</span>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {err && <span className="text-xs font-semibold text-red-700 dark:text-red-400">{err}</span>}
      </div>
      {loading ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading notes…</p> : (
        <div className="max-h-[70vh] overflow-auto rounded-xl border border-border">
          <table className="min-w-[1800px] text-xs">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr><th className={`${th} sticky left-0 z-20 min-w-[240px] bg-muted`}>Product</th>{CHANNELS.map((c) => <th key={c.key} className={`${th} min-w-[140px]`}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {names.map((p) => (
                <tr key={p} className="border-b border-border/60">
                  <td className={`${td} sticky left-0 bg-white font-semibold dark:bg-slate-900`}>{p}</td>
                  {CHANNELS.map((c) => (
                    <td key={c.key} className="p-0 align-top">
                      <textarea defaultValue={notes[`${p}|${c.key}`] ?? ""} rows={2} onBlur={(e) => save(p, c.key, e.target.value)}
                        className="block w-full resize-y border-0 bg-transparent px-2 py-1.5 text-xs focus:bg-emerald-50 focus:outline-none dark:focus:bg-emerald-950/40" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// The researched TAM suggestion (buyers × our selling price) with its sources; Accept copies it into
// the product's TAM (mkt_product_profile.tam_value, only that column).
const CONF_CLS: Record<string, string> = {
  high: STATE_CLS.On, medium: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800", low: STATE_CLS.Off,
};
function TamSuggest({ asin, s, current, onSaved, full }: { asin: string; s: any; current: number | null; onSaved: (tam: number) => void; full?: boolean }) {
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: boolean }>({});
  if (!s) return <span className="text-muted-foreground">—</span>;
  if (!s.researched) return <span className="text-[11px] text-muted-foreground">Research pending</span>;
  if (s.value === null) return <span className="text-[11px] text-muted-foreground" title={s.note ?? ""}>{s.buyers === null ? "No sourced buyer figure" : "No selling price"}</span>;
  const accept = async () => {
    setState({ busy: true });
    const { error } = await db.from("mkt_product_profile").upsert({ asin, tam_value: s.value, updated_at: new Date().toISOString() }, { onConflict: "asin" });
    if (error) return setState({ error: error.message });
    setState({ done: true });
    onSaved(s.value);
  };
  const title = [`${buyersText(s.buyers)} × ${inr(s.price)} = ${crore(s.value)}`, s.definition, s.derivation, ...(s.sources ?? []).map((x: any) => `${x.url} (${x.year}): “${x.quote}”`), s.note].filter(Boolean).join("\n");
  return (
    <div className="space-y-1" title={full ? undefined : title}>
      <div className="flex flex-wrap items-center gap-1.5">
        <b>{crore(s.value)}</b>
        {s.confidence && <span className={`rounded-md border px-1 py-0.5 text-[10px] font-bold ${CONF_CLS[s.confidence] ?? STATE_CLS["No data"]}`}>{s.confidence}</span>}
        {current === s.value || state.done ? <span className="text-[10px] font-bold text-green-700 dark:text-green-400">in use</span>
          : <button type="button" className="rounded-md border border-emerald-300 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-700 dark:text-emerald-300" disabled={state.busy} onClick={accept}>{state.busy ? "Saving…" : current ? "Replace TAM" : "Accept"}</button>}
      </div>
      <p className="text-[10px] text-muted-foreground">{buyersText(s.buyers)} buyers × {inr(s.price)}</p>
      {full && (
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p><b className="text-foreground">Who:</b> {s.definition}</p>
          <p><b className="text-foreground">How:</b> {s.derivation}</p>
          <ul className="list-disc pl-4">{(s.sources ?? []).map((x: any, i: number) => <li key={i}><a href={x.url} target="_blank" rel="noreferrer" className="text-emerald-700 underline dark:text-emerald-300">{new URL(x.url).hostname}</a> ({x.year}): “{x.quote}”</li>)}</ul>
          {s.note && <p><b className="text-foreground">Caveat:</b> {s.note}</p>}
        </div>
      )}
      {state.error && <p className="text-[10px] font-semibold text-red-700 dark:text-red-400">{state.error}</p>}
    </div>
  );
}

// The ads on/off suggestion: the action, then the reasons it rests on.
const ADS_CLS: Record<string, string> = {
  good: STATE_CLS.On, critical: STATE_CLS.Off, none: STATE_CLS["No data"],
  warning: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
};
function AdsVerdict({ s }: { s: { action: string; tone: string; reasons: string[] } }) {
  return (
    <div className="space-y-0.5">
      <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[11px] font-extrabold ${ADS_CLS[s.tone] ?? ADS_CLS.none}`}>{s.action}</span>
      <ul className="list-disc pl-4 text-[11px] text-muted-foreground">{s.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}

// ── full sheet: every product in one wide table, the template's column groups ─────────────────
type SheetCol = { group: string; label: string; get: (r: any) => string | number | null; render?: (r: any) => React.ReactNode; w?: number; edit?: SheetEdit };
const yn = (v: unknown) => (v === null || v === undefined ? "—" : v ? "Yes" : "No");
const SHEET_COLS: SheetCol[] = [
  { group: "Product", label: "ASIN", get: (r) => r.asin },
  { group: "Product", label: "SKU ID", get: (r) => r.skus.join(", "), w: 140 },
  { group: "Product", label: "Category", get: (r) => r.category },
  { group: "Market", label: "TAM value", get: (r) => r.tam, render: (r) => inr(r.tam), edit: { kind: "number", field: "tam_value" } },
{ group: "Market", label: "Suggested TAM (research)", w: 190, get: (r) => r.tam_suggest?.value ?? null },
  { group: "Market", label: "Primary audience", get: (r) => r.primary, w: 220, edit: { kind: "text", field: "primary_audience" } },
  { group: "Market", label: "Secondary audience", get: (r) => r.secondary, w: 220, edit: { kind: "text", field: "secondary_audience" } },
  { group: "Rating & reviews — ours", label: "Star", get: (r) => r.star, render: (r) => (r.star ? `${r.star}★` : "—") },
  { group: "Rating & reviews — ours", label: "Ratings", get: (r) => r.ratings, render: (r) => (r.ratings === null ? "—" : `${fmt(r.ratings)}${r.ratings_change ? ` (${r.ratings_change > 0 ? "+" : ""}${r.ratings_change})` : ""}`) },
  { group: "Rating & reviews — competitor", label: "Star", get: (r) => r.comp_star, w: 170, render: (r) => (r.comp_star === null ? <span className="text-muted-foreground">—</span> : <span title={`${r.comp_rating_name ?? ""}${r.comp_rating_same ? " (same product)" : " (related product, not a like-for-like match)"}`}><b>{r.comp_star}★</b>{r.comp_rating_same ? null : <span className="ml-1 rounded border border-border px-1 text-[10px] text-muted-foreground">related</span>}</span>) },
  { group: "Rating & reviews — competitor", label: "Reviews", get: (r) => r.comp_reviews, render: (r) => fmt(r.comp_reviews) },
  { group: "Price", label: "Our price", get: (r) => r.price, render: (r) => (r.price === null ? <span className="text-muted-foreground">—</span> : <a href={r.link} target="_blank" rel="noreferrer" className="font-bold text-emerald-700 underline dark:text-emerald-300" title={`Selling price from the ${r.price_source}; opens our Amazon listing`}>{inr(r.price)}</a>) },
  { group: "Price", label: "M.R.P.", get: (r) => r.mrp, render: (r) => <span className="text-muted-foreground">{inr(r.mrp)}</span> },
  { group: "Price", label: "Competitor (same product)", get: (r) => (r.comp_lowest ? `${r.comp_lowest.name ?? r.comp_lowest.seller ?? "Competitor"} (${r.comp_lowest.marketplace ?? ""})` : null), w: 220, render: (r) => (r.comp_lowest ? <span className="line-clamp-3">{r.comp_lowest.url ? <a href={r.comp_lowest.url} target="_blank" rel="noreferrer" className="text-emerald-700 underline dark:text-emerald-300" title={`${r.comp_lowest.match} · open their listing`}>{r.comp_lowest.name ?? r.comp_lowest.seller ?? "Competitor"}</a> : r.comp_lowest.name ?? "Competitor"} <span className="text-muted-foreground">({r.comp_lowest.marketplace})</span></span> : <span className="text-muted-foreground">—</span>) },
  { group: "Price", label: "Competitor price", get: (r) => r.comp_lowest?.price ?? null, render: (r) => (r.comp_lowest ? <span className="whitespace-nowrap"><b>{inr(r.comp_lowest.price)}</b>{r.price !== null && r.comp_lowest.price < r.price ? <span className="ml-1 text-[10px] font-bold text-red-700 dark:text-red-400">cheaper</span> : null}</span> : <span className="text-muted-foreground">—</span>) },
  { group: "Retargeting", label: "Ways in use", get: (r) => (r.retarget_yes === null ? null : r.retarget_yes.length ? r.retarget_yes.join(", ") : "None"), w: 180, edit: { kind: "multi", field: "retarget", options: RETARGET_OPTIONS } },
  { group: "Amazon ads", label: "Product ad", get: (r) => r.ad_product, render: (r) => <Pill text={r.ad_product} /> },
  { group: "Amazon ads", label: "Display ad", get: (r) => r.ad_display, render: (r) => <Pill text={r.ad_display} /> },
  { group: "Amazon ads", label: "Brand ad", get: (r) => r.ad_brand, render: (r) => <Pill text={r.ad_brand} /> },
  { group: "FBA stock", label: "Available (FBA report)", get: (r) => r.fba_available, render: (r) => fmt(r.fba_available) },
  { group: "FBA stock", label: "Low-weight FBA (manual)", get: (r) => r.fba_weight, w: 180, edit: { kind: "text", field: "fba_weight_note" } },
  { group: "FBA stock", label: "FCs stocked", get: (r) => `${r.fc_stocked}/${r.fc_onboarded}` },
  { group: "FBA stock", label: "Units in FCs", get: (r) => r.fc_units, render: (r) => fmt(r.fc_units) },
  { group: "FBA stock", label: "Inbound", get: (r) => r.inbound, render: (r) => fmt(r.inbound) },
  { group: "FBA stock", label: "Sales 30 d", get: (r) => r.sales_30d, render: (r) => fmt(r.sales_30d) },
  { group: "FBA stock", label: "Need 120 d", get: (r) => r.need_120d, render: (r) => fmt(r.need_120d) },
  { group: "FBA stock", label: "To send", get: (r) => r.to_send, render: (r) => fmt(r.to_send) },
  { group: "FBA stock", label: "Zones short", get: (r) => (r.zones ? `${r.zones_short}/${r.zones}` : null), render: (r) => (r.zones ? <Pill text={`${r.zones_short}/${r.zones}`} cls={r.zones_short ? STATE_CLS.Off : STATE_CLS.On} /> : "—") },
  { group: "Listing position", label: "Terms", get: (r) => r.kw_terms },
  { group: "Listing position", label: "Best organic", get: (r) => (r.best_organic ? `#${r.best_organic.pos} ${r.best_organic.term}` : null), w: 180 },
  { group: "Listing position", label: "Best ad", get: (r) => (r.best_ad ? `#${r.best_ad.pos} ${r.best_ad.term}` : null), w: 180 },
  { group: "Social media ads", label: "Google", get: (r) => r.google, render: (r) => <Pill text={r.google} /> },
  { group: "Social media ads", label: "Meta", get: (r) => r.meta, render: (r) => <Pill text={r.meta} /> },
  { group: "Influencer posts", label: "Organic", get: (r) => r.infl_organic },
  { group: "Influencer posts", label: "Post ads", get: (r) => r.infl_ads },
  { group: "Influencer posts", label: "Languages", get: (r) => r.infl_languages.join(", ") || null, w: 160 },
  { group: "How to use", label: "Video", get: (r) => (r.content ? yn(r.content["How to use video"]) : null), edit: { kind: "bool", field: "content", key: "How to use video" } },
  { group: "How to use", label: "QR pamphlet", get: (r) => (r.content ? yn(r.content["QR for pamphlet"]) : null), edit: { kind: "bool", field: "content", key: "QR for pamphlet" } },
  { group: "How to use", label: "SEO description", get: (r) => (r.content ? yn(r.content["Description in listing with SEO"]) : null), edit: { kind: "bool", field: "content", key: "Description in listing with SEO" } },
  { group: "Delivery date", label: "Pincodes", get: (r) => r.delivery?.pincodes ?? null },
  { group: "Delivery date", label: "≤2 days", get: (r) => r.delivery?.fast ?? null },
  { group: "Delivery date", label: "6+ days", get: (r) => r.delivery?.slow ?? null },
  { group: "Delivery date", label: "Unavailable", get: (r) => r.delivery?.unavailable ?? null },
  { group: "Delivery date", label: "Avg days", get: (r) => r.delivery?.avg_days ?? null },
  { group: "Action plan", label: "Open", get: (r) => r.plan_open },
  { group: "Action plan", label: "Next task", get: (r) => r.plan_next, w: 240, edit: { kind: "task" } },
  { group: "Channel notes", label: "Notes", get: (r) => r.notes || null },
  { group: "Delivery vs FBA (by zone)", label: "Slow zones, no orders", get: (r) => r.zone_slow_no_orders, render: (r) => (r.zone_slow_no_orders === null ? "—" : <Pill text={String(r.zone_slow_no_orders)} cls={r.zone_slow_no_orders ? STATE_CLS.Off : STATE_CLS.On} />) },
  { group: "Delivery vs FBA (by zone)", label: "Slowest zone", get: (r) => (r.zone_worst ? `${zoneLabel(r.zone_worst.zone)} ${r.zone_worst.avg} d (max ${r.zone_worst.max ?? "—"})` : null), w: 170 },
  { group: "Ads suggestion", label: "Turn ads on?", get: (r) => (r.ads_suggestion ? `${r.ads_suggestion.action}: ${r.ads_suggestion.reasons.join("; ")}` : null), w: 300, render: (r) => (r.ads_suggestion ? <AdsVerdict s={r.ads_suggestion} /> : <span className="text-muted-foreground">—</span>) },
];

// One editable full-sheet cell. Click to edit; Enter or leaving the cell saves, Esc cancels.
// Profile cells write only their own column (profileEdit); "Next task" adds an Open action-plan row.
function EditCell({ row, col, onSaved }: { row: any; col: SheetCol; onSaved: (asin: string, patch: Record<string, unknown>) => void }) {
  const edit = col.edit!;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>("");
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  const start = () => {
    if (edit.kind === "bool") return save(!(row.content?.[edit.key] ?? false));
    setDraft(edit.kind === "multi" ? [...(row.retarget_yes ?? [])] : edit.kind === "task" ? "" : edit.kind === "number" ? (row.tam ?? "") : (edit.field === "primary_audience" ? row.primary : edit.field === "secondary_audience" ? row.secondary : row.fba_weight) ?? "");
    setState({});
    setOpen(true);
  };
  async function save(value: unknown) {
    setState({ busy: true });
    if (edit.kind === "task") {
      const task = String(value ?? "").trim();
      if (!task) { setOpen(false); setState({}); return; }
      const { error } = await db.from("mkt_action_plan").insert({ asin: row.asin, task });
      if (error) return setState({ error: error.message });
      onSaved(row.asin, { plan_open: (row.plan_open ?? 0) + 1, plan_next: row.plan_next ?? task });
    } else {
      const r = profileEdit(row, edit, value);
      if ("error" in r) return setState({ error: r.error });
      const { error } = await db.from("mkt_product_profile").upsert({ asin: row.asin, ...r.db, updated_at: new Date().toISOString() }, { onConflict: "asin" });
      if (error) return setState({ error: error.message });
      onSaved(row.asin, r.row);
    }
    setOpen(false);
    setState({});
  }
  const v = col.get(row);
  const shown = col.render ? col.render(row) : v === null || v === undefined || v === "" ? <span className="text-muted-foreground">—</span> : <span className={col.w ? "line-clamp-3" : "whitespace-nowrap"} title={String(v)}>{v}</span>;
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); setState({}); }
    if (e.key === "Enter" && !e.shiftKey && edit.kind !== "multi") { e.preventDefault(); save(draft); }
  };
  if (!open) {
    return (
      <button type="button" onClick={start} disabled={state.busy} title={state.error ?? (edit.kind === "task" ? "Click to add a task" : edit.kind === "bool" ? "Click to switch Yes / No" : "Click to edit")}
        className={`group flex w-full items-start gap-1 rounded px-1 py-0.5 text-left hover:bg-emerald-50 hover:ring-1 hover:ring-emerald-300 dark:hover:bg-emerald-950/40 ${state.error ? "ring-1 ring-red-400" : ""}`}>
        <span className="min-w-0 flex-1">{edit.kind === "task" && !row.plan_next ? <span className="text-muted-foreground">+ Add task</span> : shown}</span>
        {state.busy ? <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" /> : <Pencil className="mt-0.5 h-3 w-3 shrink-0 opacity-0 group-hover:opacity-60" />}
      </button>
    );
  }
  return (
    <div className="space-y-1" onKeyDown={key}>
      {edit.kind === "multi" ? (
        <div className="space-y-0.5 rounded-md border border-emerald-300 bg-background p-1.5 dark:border-emerald-700">
          {edit.options.map((o) => (
            <label key={o} className="flex items-center gap-1.5 text-[11px]">
              <input type="checkbox" checked={draft.includes(o)} onChange={() => setDraft((d: string[]) => (d.includes(o) ? d.filter((x) => x !== o) : [...d, o]))} />{o}
            </label>
          ))}
          <div className="flex gap-1 pt-1">
            <button type="button" className={btnPrimary} disabled={state.busy} onClick={() => save(draft)}>{state.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save</button>
            <button type="button" className={btn} onClick={() => { setOpen(false); setState({}); }}>Cancel</button>
          </div>
        </div>
      ) : edit.kind === "text" ? (
        <textarea autoFocus rows={3} className={input} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => save(draft)} />
      ) : (
        <input autoFocus className={input} inputMode={edit.kind === "number" ? "numeric" : undefined} placeholder={edit.kind === "task" ? "New task, Enter to add" : "₹"} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => save(draft)} />
      )}
      {state.error && <p className="text-[10px] font-semibold text-red-700 dark:text-red-400">{state.error}</p>}
    </div>
  );
}

// Delivery days beside FBA orders and stock, zone by zone, with the rule-based verdict.
const VERDICT_CLS: Record<string, string> = {
  critical: STATE_CLS.Off, warning: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
  info: "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800", good: STATE_CLS.On, none: STATE_CLS["No data"],
};
function ZoneTable({ rows, forecastDate, date }: { rows: any[]; forecastDate: string | null; date: string }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">No delivery checks or FBA forecast rows for this product.</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        Delivery: {date ? `checks scraped on ${dateLabel(date)}` : "latest check per pincode"} · FBA orders and stock: forecast file {dateLabel(forecastDate)} (30 days) ·
        zones as the FBA forecast groups states. The verdict is a rule, not a certainty: slow = average over {`${SLOW_DAYS} days`}; &quot;no orders&quot; only when the forecast shows 0.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-border">{["Zone", "Pincodes", "Avg days", "Max days", "Slow (6+ d)", "Unavailable", "FBA orders 30 d", "FBA stock", "To send", "What it suggests"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((z) => (
            <tr key={z.zone} className="border-b border-border/60">
              <td className={`${td} font-semibold`}>{zoneLabel(z.zone)}</td><td className={td}>{z.pincodes || "—"}</td>
              <td className={td}><b className={z.avg_days !== null && z.avg_days > SLOW_DAYS ? "text-red-700 dark:text-red-400" : ""}>{z.avg_days ?? "—"}</b></td>
              <td className={td}>{z.max_days ?? "—"}</td><td className={td}>{z.pincodes ? z.slow : "—"}</td><td className={td}>{z.pincodes ? z.unavailable : "—"}</td>
              <td className={td}><b className={z.orders_30d === 0 ? "text-red-700 dark:text-red-400" : ""}>{fmt(z.orders_30d)}</b></td>
              <td className={td}>{fmt(z.stock)}</td><td className={td}>{fmt(z.to_send)}</td>
              <td className={td}><span className={`inline-block rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${VERDICT_CLS[z.verdict.tone]}`}>{z.verdict.text}</span></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function ZoneDetail({ asin, name, date, onClose }: { asin: string; name: string; date: string; onClose: () => void }) {
  const reqKey = `${asin}|${date}`;
  const [resp, setResp] = useState<{ key: string; data?: any; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    getJson(`/api/marketing-360?zones=${encodeURIComponent(asin)}${date ? `&date=${date}` : ""}`)
      .then((d) => { if (live) setResp({ key: reqKey, data: d }); })
      .catch((e) => { if (live) setResp({ key: reqKey, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [asin, date, reqKey]);
  return (
    <div className="rounded-xl border border-emerald-300 bg-card p-3 shadow-sm dark:border-emerald-800">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-sm font-extrabold">{name} — delivery vs FBA orders by zone</p>
        <button type="button" className={btn} onClick={onClose}><X className="h-3.5 w-3.5" /> Close</button>
      </div>
      {resp?.key !== reqKey ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Comparing…</p>
        : resp.error ? <p className="text-xs font-semibold text-red-700 dark:text-red-400">{resp.error}</p>
        : <ZoneTable rows={resp.data.rows} forecastDate={resp.data.forecast_date} date={date} />}
    </div>
  );
}

// The pincodes behind a product's delivery numbers, for the picked date (or the latest check per pincode).
function DeliveryDetail({ asin, name, focus, date, onClose }: { asin: string; name: string; focus: string; date: string; onClose: () => void }) {
  const reqKey = `${asin}|${date}`;
  const [resp, setResp] = useState<{ key: string; rows?: any[]; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    getJson(`/api/marketing-360?delivery=${encodeURIComponent(asin)}${date ? `&date=${date}` : ""}`)
      .then((d) => { if (live) setResp({ key: reqKey, rows: d.rows }); })
      .catch((e) => { if (live) setResp({ key: reqKey, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [asin, date, reqKey]);
  const want = focus === "≤2 days" ? "fast" : focus === "6+ days" ? "slow" : focus === "Unavailable" ? "none" : null;
  const rows = resp?.key === reqKey ? resp.rows ?? [] : [];
  const picked = want ? rows.filter((r) => deliveryTone(r) === want) : rows;
  const byState = new Map<string, any[]>();
  for (const r of picked) byState.set(r.state, [...(byState.get(r.state) ?? []), r]);
  return (
    <div className="rounded-xl border border-emerald-300 bg-card p-3 shadow-sm dark:border-emerald-800">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-extrabold">{name} — delivery {want ? `(${focus})` : ""}</p>
          <p className="text-[11px] text-muted-foreground">{date ? `Checks scraped on ${dateLabel(date)} only` : "Latest check per pincode, any date"} · {picked.length} of {rows.length} pincodes</p>
        </div>
        <button type="button" className={btn} onClick={onClose}><X className="h-3.5 w-3.5" /> Close</button>
      </div>
      {resp?.key !== reqKey ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading pincodes…</p>
        : resp.error ? <p className="text-xs font-semibold text-red-700 dark:text-red-400">{resp.error}</p>
        : !picked.length ? <p className="text-xs text-muted-foreground">No pincodes in this group{date ? " on this date" : ""}.</p> : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {[...byState.entries()].map(([state, cells]) => (
              <div key={state} className="rounded-lg border border-border/70 bg-background p-2">
                <p className="mb-1 flex items-center gap-1 text-xs font-extrabold"><MapPin className="h-3 w-3" />{state}</p>
                <div className="flex flex-wrap gap-1">
                  {cells.map((c) => {
                    const t = TONE[deliveryTone(c)];
                    return <span key={c.pincode} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${t.cls}`} title={`${c.delivery_text ?? c.status ?? ""} · checked ${dateLabel(c.scraped_date)} (${c.week})`}>{c.pincode}{c.location ? ` ${c.location.split("/")[0].trim()}` : ""}: {c.days === null ? (c.status ?? "—") : `${c.days} d`}</span>;
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

function FullSheet({ onOpen }: { onOpen: (asin: string) => void }) {
  const [deliveryDate, setDeliveryDate] = useState(""); // "" = latest check per pincode
  const [resp, setResp] = useState<{ key: string; data?: any; error?: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [patches, setPatches] = useState<Record<string, Record<string, unknown>>>({});
  const [detail, setDetail] = useState<{ kind: "delivery" | "zones"; asin: string; name: string; focus: string } | null>(null);
  useEffect(() => {
    let live = true;
    const key = deliveryDate;
    getJson(`/api/marketing-360?sheet=1${deliveryDate ? `&date=${deliveryDate}` : ""}`)
      .then((d) => { if (live) setResp({ key, data: d }); })
      .catch((e) => { if (live) setResp({ key, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [deliveryDate]);
  const refreshing = resp !== null && resp.key !== deliveryDate;
  const rowsAll: any[] = useMemo(() => (resp?.data?.rows ?? []).map((r: any) => (patches[r.asin] ? { ...r, ...patches[r.asin] } : r)), [resp, patches]);
  const onSaved = useCallback((asin: string, patch: Record<string, unknown>) => setPatches((p) => ({ ...p, [asin]: { ...(p[asin] ?? {}), ...patch } })), []);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rowsAll.filter((r) => `${r.name} ${r.asin} ${r.skus.join(" ")} ${r.category ?? ""}`.toLowerCase().includes(q)) : rowsAll;
  }, [rowsAll, filter]);
  const groups = useMemo(() => {
    const g: { name: string; span: number }[] = [];
    for (const c of SHEET_COLS) { const last = g[g.length - 1]; if (last?.name === c.group) last.span++; else g.push({ name: c.group, span: 1 }); }
    return g;
  }, []);
  const exportXlsx = () => {
    const aoa = [["Product", ...SHEET_COLS.map((c) => c.group)], ["Product name", ...SHEET_COLS.map((c) => c.label)], ...shown.map((r) => [r.name, ...SHEET_COLS.map((c) => c.get(r) ?? "")])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Marketing 360");
    XLSX.writeFile(wb, `Product Marketing 360 - ${new Date().toISOString().slice(0, 10)}.xlsx`);
  };
  if (!resp) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building the sheet for every product…</p>;
  if (resp.error) return <p className="flex items-center gap-1.5 text-sm font-semibold text-red-700 dark:text-red-400"><AlertTriangle className="h-4 w-4" />{resp.error}</p>;
  const a = resp.data.asOf;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" /><input className={`${input} pl-7`} placeholder="Filter product, ASIN, SKU, category" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <button className={btn} onClick={exportXlsx}><Download className="h-3.5 w-3.5" /> Export Excel</button>
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground">
          <Truck className="h-3.5 w-3.5" /> Delivery date
          <select className="rounded-md border border-border bg-background px-2 py-1 text-xs font-semibold text-foreground" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)}>
            <option value="">Latest check per pincode</option>
            {(resp.data.deliveryDates ?? []).map((d: any) => <option key={d.scraped_date} value={d.scraped_date}>{dateLabel(d.scraped_date)} — {fmt(d.checks)} checks, {d.products} products</option>)}
          </select>
          {refreshing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </label>
        <span className="text-[11px] text-muted-foreground">
          {shown.length} products · rating {dateLabel(a.rating)} · FBA {dateLabel(a.fc)} · forecast {dateLabel(a.forecast)} · positions {a.positions ?? "—"} · Amazon product ads {a.amazonAds ? `${dateLabel(a.amazonAds.from)}–${dateLabel(a.amazonAds.to)}` : "—"} · display ads to {dateLabel(a.amazonDisplay)} · brand ads to {dateLabel(a.amazonBrand)} · Google/Meta to {dateLabel(a.google)} · click a product to open its card
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">Shaded columns are editable — click a cell, Enter or click away to save, Esc to cancel. Click a delivery number to see its pincodes.</p>
      {detail?.kind === "delivery" && <DeliveryDetail asin={detail.asin} name={detail.name} focus={detail.focus} date={deliveryDate} onClose={() => setDetail(null)} />}
      {detail?.kind === "zones" && <ZoneDetail asin={detail.asin} name={detail.name} date={deliveryDate} onClose={() => setDetail(null)} />}
      {resp.data.stale && <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">The database is busy, so this shows the copy loaded at {new Date(resp.data.cachedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}. Reload in a minute for fresh numbers.</p>}
      {resp.data.competitorBlocked && <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">Competitor rating columns are empty: the competitor tables are readable only by signed-in Supabase users, not by the dashboard.</p>}
      <div className="max-h-[75vh] overflow-auto rounded-xl border border-border">
        <table className="text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="bg-emerald-100 dark:bg-emerald-950">
              <th className="sticky left-0 z-20 border-b border-r border-border bg-emerald-100 px-2 py-1.5 text-left text-[11px] font-extrabold dark:bg-emerald-950">Product</th>
              {groups.map((g, i) => <th key={i} colSpan={g.span} className="whitespace-nowrap border-b border-r border-border px-2 py-1.5 text-center text-[11px] font-extrabold">{g.name}</th>)}
            </tr>
            <tr className="bg-muted">
              <th className={`${th} sticky left-0 z-20 min-w-[260px] border-r border-border bg-muted`}>Product name</th>
              {SHEET_COLS.map((c, i) => <th key={i} className={`${th} whitespace-nowrap border-r border-border`}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.asin} className="border-b border-border/60 hover:bg-muted/40">
                <td className={`${td} sticky left-0 z-[5] border-r border-border bg-white dark:bg-slate-900`}>
                  <button className="text-left font-semibold text-emerald-700 hover:underline dark:text-emerald-300" onClick={() => onOpen(r.asin)}>{r.name}</button>
                </td>
                {SHEET_COLS.map((c, i) => {
                  const v = c.get(r);
                  return (
                    <td key={i} className={`${td} border-r border-border/40 ${c.edit ? "bg-emerald-50/30 dark:bg-emerald-950/10" : ""}`} style={c.w ? { minWidth: c.w, maxWidth: c.w + 80 } : undefined}>
                      {c.edit ? <EditCell row={r} col={c} onSaved={onSaved} />
                        : c.label === "Suggested TAM (research)" ? <TamSuggest asin={r.asin} s={r.tam_suggest} current={r.tam} onSaved={(tam) => onSaved(r.asin, { tam })} />
                        : c.group === "Delivery date" && r.delivery ? (
                          <button type="button" className="font-semibold text-emerald-700 underline decoration-dotted hover:decoration-solid dark:text-emerald-300" title="Show the pincodes" onClick={() => setDetail({ kind: "delivery", asin: r.asin, name: r.name, focus: c.label })}>{v ?? "—"}</button>
                        )
                        : c.group === "Delivery vs FBA (by zone)" && r.zone_slow_no_orders !== null ? (
                          <button type="button" className="text-left underline decoration-dotted hover:decoration-solid" title="Compare delivery days with FBA orders, zone by zone" onClick={() => setDetail({ kind: "zones", asin: r.asin, name: r.name, focus: c.label })}>{c.render ? c.render(r) : v ?? "—"}</button>
                        )
                        : c.render ? c.render(r) : v === null || v === undefined || v === "" ? <span className="text-muted-foreground">—</span> : <span className={c.w ? "line-clamp-3" : "whitespace-nowrap"} title={String(v)}>{v}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────────────────────
export default function Marketing360Page() {
  const [tab, setTab] = useState<"sheet" | "card" | "notes">("sheet");
  const [products, setProducts] = useState<Product[]>([]);
  const [asin, setAsin] = useState<string>("");
  const [query, setQuery] = useState("");
  // one response per (asin, version); "loading" = the shown response is not for the current request
  const [cardVersion, setCardVersion] = useState(0);
  const productsVersion = 0; // the product list loads once per visit
  const [resp, setResp] = useState<{ key: string; data?: any; error?: string } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const reqKey = `${asin}|${cardVersion}`;
  const loading = !!asin && resp?.key !== reqKey;
  const data = resp?.data && resp.data.asin === asin ? resp.data : null;
  const error = listError ?? (resp?.key === reqKey ? resp.error ?? null : null);
  const reloadCard = useCallback(() => setCardVersion((v) => v + 1), []);
  const pickAsin = (a: string) => {
    setAsin(a);
    try { localStorage.setItem("m360-asin", a); } catch { /* storage blocked */ }
  };

  useEffect(() => {
    let live = true;
    getJson("/api/marketing-360").then((j) => {
      if (!live) return;
      setListError(null);
      setProducts(j.products);
      setAsin((a) => {
        if (a) return a;
        let saved: string | null = null;
        try { saved = localStorage.getItem("m360-asin"); } catch { /* storage blocked */ }
        return saved && j.products.some((p: Product) => p.asin === saved) ? saved : j.products.find((p: Product) => p.has_profile)?.asin ?? j.products[0]?.asin ?? "";
      });
    }).catch((e) => { if (live) setListError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [productsVersion]);
  useEffect(() => {
    if (!asin) return;
    let live = true;
    const key = `${asin}|${cardVersion}`;
    getJson(`/api/marketing-360?asin=${encodeURIComponent(asin)}`)
      .then((d) => { if (live) setResp({ key, data: d }); })
      .catch((e) => { if (live) setResp((r) => ({ key, data: r?.data, error: e instanceof Error ? e.message : String(e) })); });
    return () => { live = false; };
  }, [asin, cardVersion]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? products.filter((p) => `${p.name} ${p.asin} ${p.skus.join(" ")}`.toLowerCase().includes(q)) : products).slice(0, 400);
  }, [products, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Product Marketing 360</h1>
          <p className="mt-1 text-sm text-muted-foreground">The marketing team template per product: rating, competitors, ads, FBA, positions and delivery fill from stored data; plans and influencers are typed in here.</p>
        </div>
        <div className="flex rounded-lg border border-border p-0.5">
          {([["sheet", "Full sheet"], ["card", "Product card"], ["notes", "Channel notes"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 text-xs font-bold ${tab === k ? "bg-emerald-600 text-white" : "hover:bg-muted"}`}>{l}</button>
          ))}
        </div>
      </div>


      <DataSources />

      {tab === "sheet" ? <FullSheet onOpen={(a) => { pickAsin(a); setTab("card"); }} /> : tab === "notes" ? <ChannelNotes products={products} /> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-72"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" /><input className={`${input} pl-7`} placeholder="Search product, ASIN or SKU" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            <select className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs sm:w-[520px]" value={asin} onChange={(e) => pickAsin(e.target.value)}>
              {!products.length && <option>Loading products…</option>}
              {matches.map((p) => <option key={p.asin} value={p.asin}>{p.has_profile ? "● " : ""}{p.name} — {p.asin}{p.active ? "" : " (inactive)"}</option>)}
            </select>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {error && <p className="flex items-center gap-1.5 text-sm font-semibold text-red-700 dark:text-red-400"><AlertTriangle className="h-4 w-4" />{error}</p>}
          {data ? <ProductCard data={data} reload={reloadCard} /> : !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading product…</p>}
        </>
      )}
    </div>
  );
}

/** "Where this data comes from" (user, 2026-11-18): each column group of the Full sheet's first header row,
 *  its exact source, how far the stored copy runs, and whether that is current (src/lib/marketing360Sources.ts). */
function DataSources() {
  const [d, setD] = useState<{ today: string; rows: SourceRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getJson("/api/marketing-360?sources=1").then((j) => { if (live) setD(j); }).catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, []);
  const old = d?.rows.filter((r) => r.status === "old" || r.status === "missing") ?? [];
  const chip: Record<SourceRow["status"], [string, string]> = {
    current: ["Current", "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"],
    old: ["Old", "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"],
    missing: ["No data", "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300"],
    typed: ["Typed in", "bg-muted text-muted-foreground"],
    rule: ["Rule", "bg-muted text-muted-foreground"],
  };
  return (
    <details className="rounded-xl border border-border bg-card" open>
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-bold">
        Where this data comes from
        {d && <span className={`ml-2 text-xs font-semibold ${old.length ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
          {old.length ? `${old.length} source${old.length === 1 ? " is" : "s are"} old: ${old.map((r) => r.group).join(", ")}` : "all sources current"}
        </span>}
      </summary>
      {err && <p className="px-4 pb-3 text-xs text-red-700 dark:text-red-400">Could not load the source dates: {err}</p>}
      {!d && !err && <p className="flex items-center gap-2 px-4 pb-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking each source…</p>}
      {d && (
        <div className="overflow-x-auto px-4 pb-3">
          <table className="w-full min-w-[720px] text-xs">
            <thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 pr-3">Column group (sheet's first row)</th><th className="py-1.5 pr-3">Comes from</th><th className="py-1.5 pr-3 whitespace-nowrap">Data up to</th><th className="py-1.5">Status</th>
            </tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.group} className="border-b border-border/50 align-top last:border-0">
                  <td className="py-1.5 pr-3 font-semibold">{r.group}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{r.from}{r.note && <span className="block font-semibold text-amber-700 dark:text-amber-400">Note: {r.note}</span>}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{r.upTo ? <>{dateLabel(r.upTo)}{r.ageDays !== null && r.ageDays > 0 && <span className="text-muted-foreground"> ({r.ageDays} day{r.ageDays === 1 ? "" : "s"} ago)</span>}</> : "—"}</td>
                  <td className="py-1.5"><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${chip[r.status][1]}`}>{chip[r.status][0]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted-foreground">Drive files are imported into the dashboard's database; uploads come from the dashboard's upload pages. "Old" = the stored copy is more than 3 days behind today (8 days for weekly files). Checked {dateLabel(d.today)}.</p>
        </div>
      )}
    </details>
  );
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { credentials: "same-origin" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? res.statusText);
  return j;
}
