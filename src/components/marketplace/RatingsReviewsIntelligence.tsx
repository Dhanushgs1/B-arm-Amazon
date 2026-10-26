"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Download,
  Layers,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldAlert,
  Star,
  StarOff,
  Trophy,
  TrendingDown,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MarketplaceId } from "@/lib/marketplace";
import {
  HEALTH_META,
  MIN_REVIEWS,
  crossChannelListings,
  fetchListingHistory,
  fetchRatingMetrics,
  groupListings,
  listingImpact,
  summarize,
  summarizePrevious,
  type Health,
  type Listing,
  type RatingItem,
} from "@/lib/productRatingMetrics";
import { RatingUploadDialog } from "@/components/ratings/RatingUploadDialog";
import { findRatingDrops } from "@/lib/ratingDropAlert";
import { cn } from "@/lib/utils";

const DEFAULT_PLATFORM: Partial<Record<MarketplaceId, string>> = {
  amazon: "Amazon",
  flipkart: "Flipkart",
};

const ALL = "__all__";
const PAGE_SIZE = 25;
const RATED_BANDS: Health[] = ["excellent", "good", "watch", "risk", "critical"];
const PLATFORM_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#06b6d4"];

type SortKey = "rating" | "reviews" | "price" | "name" | "change";
type MinReviews = 0 | 5 | 20 | 100;
type HealthFilter = Health | "all" | "low";

const fmtInt = (n: number) => n.toLocaleString("en-IN");
const fmtRupee = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const fmtDate = (d: string | null) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

function fmtPriceRange(min: number | null, max: number | null) {
  if (min === null || max === null) return "—";
  return min === max ? fmtRupee(min) : `${fmtRupee(min)} – ${fmtRupee(max)}`;
}

// ── Small building blocks ────────────────────────────────────────────────────

function Stars({ rating, size = 12 }: { rating: number | null; size?: number }) {
  if (rating === null) return <span className="text-xs text-muted-foreground">Not rated</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative inline-flex" aria-hidden>
        <span className="flex text-slate-200 dark:text-slate-700">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star key={i} style={{ width: size, height: size }} className="fill-current" />
          ))}
        </span>
        <span className="absolute inset-0 flex overflow-hidden text-amber-400" style={{ width: `${(rating / 5) * 100}%` }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Star key={i} style={{ width: size, height: size }} className="flex-shrink-0 fill-current" />
          ))}
        </span>
      </span>
      <span className="text-sm font-bold tabular-nums text-foreground">{rating.toFixed(1)}</span>
    </span>
  );
}

function HealthBadge({ health }: { health: Health }) {
  const m = HEALTH_META[health];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: `${m.color}1f`, color: m.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

function LowConfidence() {
  return (
    <span
      className="whitespace-nowrap rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400"
      title={`Fewer than ${MIN_REVIEWS} reviews — one more review can move this rating a lot`}
    >
      few reviews
    </span>
  );
}

function Delta({ value, digits = 1, suffix = "", inverse = false }: { value: number | null; digits?: number; suffix?: string; inverse?: boolean }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  if (value === 0) return <span className="text-xs text-muted-foreground">no change</span>;
  const good = inverse ? value < 0 : value > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums",
        good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      )}
    >
      {value > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {value > 0 ? "+" : ""}
      {value.toFixed(digits)}
      {suffix}
    </span>
  );
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-2xl border border-border bg-card p-5 shadow-sm", className)}>{children}</div>;
}

function CardTitle({ icon: Icon, title, hint, right }: { icon?: React.ElementType; title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <div>
          <h3 className="text-sm font-bold text-foreground">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  tone = "default",
  delta,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  icon: React.ElementType;
  tone?: "default" | "good" | "warn" | "bad";
  delta?: React.ReactNode;
}) {
  const toneCls = {
    default: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    good: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bad: "bg-red-500/10 text-red-600 dark:text-red-400",
  }[tone];
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", toneCls)}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums text-foreground">{value}</span>
        {delta}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function ListingLine({ l, showPlatform, right, onOpen }: { l: Listing; showPlatform: boolean; right: React.ReactNode; onOpen: (l: Listing) => void }) {
  return (
    <li>
      <button onClick={() => onOpen(l)} className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted/60">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground" title={l.name}>
            {l.name}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {showPlatform && `${l.platform} · `}
            {l.skus.length > 1 ? `${l.skus.length} variants` : l.skus[0].skuId}
          </span>
        </span>
        {right}
      </button>
    </li>
  );
}

/** Full-width tiny trend line with a soft fill; null points are skipped. */
function Sparkline({ values, color, height = 28 }: { values: (number | null)[]; color: string; height?: number }) {
  const W = 100;
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) return <div style={{ height }} />;
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const span = max - min || 1;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * W;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const line = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(" ");
  const area = `${line} L${x(pts[pts.length - 1].i).toFixed(2)},${height} L${x(pts[0].i).toFixed(2)},${height} Z`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden className="block">
      <path d={area} fill={color} fillOpacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type Risk = "high" | "medium" | "low";
const RISK_META: Record<Risk, { label: string; cls: string; why: string }> = {
  high: { label: "High risk", cls: "bg-red-500/10 text-red-600 dark:text-red-400", why: "Below 3.5★, or below 4★ and still falling" },
  medium: { label: "Medium risk", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300", why: "Below 4★, or dropped 0.2★+ since last week" },
  low: { label: "Low risk", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", why: "4★+ and not falling" },
};

/** Health band plus direction: a 3.9★ listing that is still dropping is worse than a steady one. */
function riskOf(l: Listing): Risk | null {
  if (l.rating === null) return null;
  const falling = (l.ratingDelta ?? 0) < 0;
  if (!l.lowConfidence && (l.rating < 3.5 || (l.rating < 4 && falling))) return "high";
  if (l.rating < 4 || (l.ratingDelta ?? 0) <= -0.2) return "medium";
  return "low";
}

function RiskBadge({ l }: { l: Listing }) {
  const r = riskOf(l);
  if (!r) return null;
  const m = RISK_META[r];
  return (
    <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold", m.cls)} title={m.why}>
      {m.label}
    </span>
  );
}

const shortDate = (v: string) => new Date(`${v}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
};

/** Side panel for one listing: every stored weekly snapshot plus its variant SKUs. */
function ListingDrawer({ l, onClose }: { l: Listing; onClose: () => void }) {
  const keys = l.skus.map((s) => s.skuKey);
  const { data: history, isLoading, isError } = useQuery({
    queryKey: ["rating-listing-history", l.platform, keys],
    queryFn: () => fetchListingHistory(l.platform, keys),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = history ?? [];
  const first = rows.find((r) => r.rating !== null);
  const sinceFirst = first && l.rating !== null && first.date !== rows[rows.length - 1]?.date ? Math.round((l.rating - first.rating!) * 10) / 10 : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={l.name}>
      <button className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} aria-label="Close" />
      <div className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-background shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-border bg-background/95 p-4 backdrop-blur sm:p-5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{l.platform}</p>
            <h2 className="mt-0.5 text-base font-bold leading-snug text-foreground">{l.name}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <HealthBadge health={l.health} />
              <RiskBadge l={l} />
              {l.lowConfidence && <LowConfidence />}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close panel">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Rating", value: <Stars rating={l.rating} size={11} /> },
              { label: "Reviews", value: <span className="text-sm font-bold tabular-nums text-foreground">{fmtInt(l.reviews)}</span> },
              {
                label: "vs last week",
                value: l.isNew ? <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">New</span> : <Delta value={l.ratingDelta} />,
              },
              { label: `Since ${first ? shortDate(first.date) : "first week"}`, value: <Delta value={sinceFirst} /> },
            ].map((s) => (
              <div key={s.label} className="rounded-xl bg-muted/50 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{s.label}</div>
                <div className="mt-0.5">{s.value}</div>
              </div>
            ))}
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold text-muted-foreground">Weekly history</p>
            {isLoading ? (
              <div className="flex h-[180px] items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : isError ? (
              <p className="py-6 text-center text-xs text-red-600 dark:text-red-400">Couldn&apos;t load this listing&apos;s history.</p>
            ) : rows.length < 2 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Only one snapshot so far — history builds up week by week.</p>
            ) : (
              <div className="h-[200px] text-muted-foreground">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} margin={{ top: 5, right: 0, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: "currentColor" }} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="r" domain={[(min: number) => Math.max(0, Math.floor(min * 2) / 2 - 0.5), 5]} tick={{ fontSize: 11, fill: "currentColor" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(1)} />
                    {/* bars stay in the lower part so the rating line reads first */}
                    <YAxis yAxisId="c" orientation="right" hide domain={[0, (max: number) => Math.max(1, max * 2.5)]} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(v) => fmtDate(String(v))}
                      formatter={(v, name) => (name === "Rating" && typeof v === "number" ? `${v.toFixed(1)}★` : typeof v === "number" ? fmtInt(v) : String(v))}
                    />
                    <Bar yAxisId="c" dataKey="reviews" name="Reviews" fill="#6366f1" fillOpacity={0.18} radius={[4, 4, 0, 0]} />
                    <Line yAxisId="r" type="monotone" dataKey="rating" name="Rating" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
            {rows.length > 0 && (
              <table className="mt-3 w-full text-xs">
                <thead className="text-left text-[11px] text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-1.5 font-semibold">Snapshot</th>
                    <th className="py-1.5 text-right font-semibold">Rating</th>
                    <th className="py-1.5 text-right font-semibold">Change</th>
                    <th className="py-1.5 text-right font-semibold">Reviews</th>
                    <th className="py-1.5 text-right font-semibold">New</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[...rows].reverse().map((r, i, arr) => {
                    const prev = arr[i + 1];
                    const dr = prev && prev.rating !== null && r.rating !== null ? Math.round((r.rating - prev.rating) * 10) / 10 : null;
                    const dn = prev && r.rating !== null ? r.reviews - prev.reviews : null;
                    return (
                      <tr key={r.date}>
                        <td className="py-1.5 text-foreground">{fmtDate(r.date)}</td>
                        <td className="py-1.5 text-right tabular-nums text-foreground">{r.rating === null ? "—" : `${r.rating.toFixed(1)}★`}</td>
                        <td className="py-1.5 text-right">{prev ? <Delta value={dr} /> : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-1.5 text-right tabular-nums text-foreground">{r.rating === null ? "—" : fmtInt(r.reviews)}</td>
                        <td className="py-1.5 text-right tabular-nums text-muted-foreground">{dn ? `${dn > 0 ? "+" : ""}${fmtInt(dn)}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold text-muted-foreground">
              {l.skus.length} SKU{l.skus.length === 1 ? "" : "s"} on this listing
            </p>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {l.skus.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground" title={s.productName}>
                      {s.productName}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{s.skuId || "—"}</span>
                  </span>
                  <span className="text-xs tabular-nums text-foreground">{s.price === null ? "—" : fmtRupee(s.price)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function exportExcel(rows: RatingItem[], name: string) {
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Platform: r.platform,
      "SKU ID": r.skuId,
      "Product Name": r.productName,
      Rating: r.rating ?? "",
      Reviews: r.reviews,
      Price: r.price ?? "",
      Health: HEALTH_META[r.health].label,
      "Previous rating": r.prev?.rating ?? "",
      "Rating change": r.ratingDelta ?? "",
      "New reviews": r.reviewsDelta ?? "",
    }))
  );
  sheet["!cols"] = [{ wch: 12 }, { wch: 28 }, { wch: 60 }, { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 11 }, { wch: 14 }, { wch: 13 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Ratings & Reviews");
  XLSX.writeFile(wb, `${name}.xlsx`);
}

// ── Page ─────────────────────────────────────────────────────────────────────

/** `marketplace` picks the channel shown first; without it (the Overall page) every channel is shown. */
export function RatingsReviewsIntelligence({ marketplace }: { marketplace?: MarketplaceId }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["product-rating-review-metrics"],
    queryFn: fetchRatingMetrics,
    staleTime: 5 * 60 * 1000,
  });

  const [platformSel, setPlatformSel] = useState<string | null>(null);
  const [healthSel, setHealthSel] = useState<HealthFilter>("all");
  const [minReviews, setMinReviews] = useState<MinReviews>(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "reviews", dir: "desc" });
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<Listing | null>(null);
  const [trendMetric, setTrendMetric] = useState<"avg" | "below4">("avg");
  const [uploadOpen, setUploadOpen] = useState(false);

  const ratedPlatforms = useMemo(() => data?.ratedPlatforms ?? [], [data]);
  const defaultPlatform = marketplace ? DEFAULT_PLATFORM[marketplace] : undefined;
  const platform = platformSel ?? (defaultPlatform && ratedPlatforms.includes(defaultPlatform) ? defaultPlatform : ALL);
  const showPlatform = platform === ALL;

  // "All" covers the channels that carry ratings; untracked channels would only add "Not rated" noise.
  const scoped = useMemo(() => {
    const items = data?.items ?? [];
    return platform === ALL ? items.filter((i) => ratedPlatforms.includes(i.platform)) : items.filter((i) => i.platform === platform);
  }, [data, platform, ratedPlatforms]);

  const listings = useMemo(() => groupListings(scoped), [scoped]);
  const allListings = useMemo(() => groupListings((data?.items ?? []).filter((i) => ratedPlatforms.includes(i.platform))), [data, ratedPlatforms]);

  const summary = useMemo(() => summarize(scoped), [scoped]);
  const prevSummary = useMemo(() => summarizePrevious(scoped), [scoped]);

  const stats = useMemo(() => {
    const rated = listings.filter((l) => l.rating !== null);
    const bands = Object.fromEntries(RATED_BANDS.map((h) => [h, 0])) as Record<Health, number>;
    for (const l of rated) bands[l.health]++;
    const below4 = rated.filter((l) => l.rating! < 4);
    return {
      listings: listings.length,
      rated: rated.length,
      unrated: listings.length - rated.length,
      bands,
      below4Solid: below4.filter((l) => !l.lowConfidence).length,
      below4Low: below4.filter((l) => l.lowConfidence).length,
      below3Solid: rated.filter((l) => l.rating! < 3 && !l.lowConfidence).length,
      lowConfidence: rated.filter((l) => l.lowConfidence).length,
      newReviews: listings.reduce((a, l) => a + Math.max(0, l.reviewsDelta ?? 0), 0),
      // Same counts as of the previous snapshot, for listings that existed then.
      prev: (() => {
        const old = listings.filter((l) => l.skus.some((s) => s.prev));
        const p = old.map((l) => ({ rating: l.prevRating, reviews: l.reviews - (l.reviewsDelta ?? 0) }));
        const solid = p.filter((x) => x.rating !== null && x.reviews >= MIN_REVIEWS);
        return {
          rated: p.filter((x) => x.rating !== null).length,
          below4Solid: solid.filter((x) => x.rating! < 4).length,
          below3Solid: solid.filter((x) => x.rating! < 3).length,
        };
      })(),
    };
  }, [listings]);

  const attention = useMemo(
    () =>
      listings
        .filter((l) => listingImpact(l) > 0)
        .sort((a, b) => listingImpact(b) - listingImpact(a))
        .slice(0, 6),
    [listings]
  );

  const topRated = useMemo(
    () =>
      listings
        .filter((l) => l.rating !== null && l.rating >= 4.5 && l.reviews >= 20)
        .sort((a, b) => b.reviews - a.reviews)
        .slice(0, 6),
    [listings]
  );

  const changes = useMemo(() => {
    const moved = listings.filter((l) => l.ratingDelta !== null && l.ratingDelta !== 0);
    return {
      drops: moved.filter((l) => l.ratingDelta! < 0).sort((a, b) => a.ratingDelta! - b.ratingDelta! || b.reviews - a.reviews),
      gains: moved.filter((l) => l.ratingDelta! > 0).sort((a, b) => b.ratingDelta! - a.ratingDelta! || b.reviews - a.reviews),
      newlyRated: listings.filter((l) => l.rating !== null && !l.isNew && l.prevRating === null).length,
      newListings: listings.filter((l) => l.isNew).length,
    };
  }, [listings]);

  // Every rated channel side by side, not just the first two.
  const comparison = useMemo(() => {
    if (ratedPlatforms.length < 2) return [];
    return crossChannelListings(allListings, ratedPlatforms).filter((r) => r.spread >= 0.3);
  }, [allListings, ratedPlatforms]);

  const trend = useMemo(() => {
    const plats = platform === ALL ? ratedPlatforms : [platform];
    const byDate = new Map<string, Record<string, number | string | null>>();
    for (const w of data?.weekly ?? []) {
      if (!plats.includes(w.platform)) continue;
      const row = byDate.get(w.date) ?? { date: w.date };
      row[w.platform] = trendMetric === "avg" ? w.avgRating : w.below4;
      byDate.set(w.date, row);
    }
    return { rows: Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date))), plats };
  }, [data, platform, ratedPlatforms, trendMetric]);

  // One at-a-glance card per channel (plus an "All channels" card first): average rating and its change,
  // its weekly trend, how many listings sit below 4★, how many fell below 4★ since the previous snapshot,
  // and new reviews. Clicking a card focuses the page on it.
  const scorecards = useMemo(() => {
    const weekly = data?.weekly ?? [];
    const dates = Array.from(new Set(weekly.map((w) => w.date))).sort();
    const card = (key: string, plats: string[]) => {
      const items = (data?.items ?? []).filter((i) => plats.includes(i.platform));
      const ls = groupListings(items);
      const rated = ls.filter((l) => l.rating !== null);
      // Weekly average across these channels, weighted by how many SKUs each rated that week.
      const spark = dates.map((d) => {
        const ws = weekly.filter((w) => w.date === d && plats.includes(w.platform) && w.avgRating !== null);
        const n = ws.reduce((a, w) => a + w.rated, 0);
        return n ? ws.reduce((a, w) => a + w.avgRating! * w.rated, 0) / n : null;
      });
      return {
        key,
        label: key === ALL ? "All channels" : key,
        avg: summarize(items).weightedRating,
        prevAvg: summarizePrevious(items)?.weightedRating ?? null,
        rated: rated.length,
        below4: rated.filter((l) => l.rating! < 4 && !l.lowConfidence).length,
        crossed: findRatingDrops(ls).length,
        newReviews: ls.reduce((a, l) => a + Math.max(0, l.reviewsDelta ?? 0), 0),
        spark,
        dates: key === ALL ? undefined : data?.platformDates[key],
      };
    };
    return [...(ratedPlatforms.length > 1 ? [card(ALL, ratedPlatforms)] : []), ...ratedPlatforms.map((p) => card(p, [p]))];
  }, [data, ratedPlatforms]);

  const untracked = useMemo(() => (data?.platforms ?? []).filter((p) => !ratedPlatforms.includes(p)), [data, ratedPlatforms]);

  const tableRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = listings.filter(
      (l) =>
        (healthSel === "all" || (healthSel === "low" ? l.lowConfidence : l.health === healthSel)) &&
        l.reviews >= minReviews &&
        (!q || l.name.toLowerCase().includes(q) || l.skus.some((s) => s.skuId.toLowerCase().includes(q) || s.productName.toLowerCase().includes(q)))
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (l: Listing): number | string => {
      switch (sort.key) {
        case "rating":
          return l.rating ?? (sort.dir === "asc" ? 99 : -1);
        case "reviews":
          return l.reviews;
        case "price":
          return l.priceMin ?? (sort.dir === "asc" ? Number.MAX_SAFE_INTEGER : -1);
        case "change":
          return l.ratingDelta ?? (sort.dir === "asc" ? 99 : -99);
        default:
          return l.name.toLowerCase();
      }
    };
    return rows.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || b.reviews - a.reviews;
    });
  }, [listings, healthSel, minReviews, query, sort]);

  const pageCount = Math.max(1, Math.ceil(tableRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = tableRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
    setPage(0);
  };
  const applyHealth = (h: HealthFilter) => {
    setHealthSel((cur) => (cur === h ? "all" : h));
    setPage(0);
    document.getElementById("rr-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (isLoading) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-7 w-7 animate-spin text-indigo-500" />
        <p className="text-sm font-medium">Loading ratings & reviews…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card className="mx-auto mt-10 max-w-lg text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-red-500" />
        <p className="mt-3 text-sm font-semibold text-foreground">Couldn&apos;t load rating data</p>
        <p className="mt-1 text-xs text-muted-foreground">{error instanceof Error ? error.message : "Unknown error"}</p>
        <button onClick={() => refetch()} className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700">
          Try again
        </button>
      </Card>
    );
  }

  const uploadDialog = (
    <RatingUploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onUploaded={() => refetch()} existingDates={data.snapshotDates} />
  );

  if (!data.snapshotDate) {
    return (
      <Card className="mx-auto mt-10 max-w-lg text-center">
        <Upload className="mx-auto h-8 w-8 text-indigo-500" />
        <p className="mt-3 text-sm font-semibold text-foreground">No rating snapshot yet</p>
        <p className="mt-1 text-xs text-muted-foreground">Upload this week&apos;s rating & review sheet to get started.</p>
        <button onClick={() => setUploadOpen(true)} className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700">
          Upload data
        </button>
        {uploadDialog}
      </Card>
    );
  }

  const hasPrev = data.previousDate !== null && prevSummary !== null;
  const d = (now: number | null, before: number | null | undefined) =>
    hasPrev && now !== null && before !== null && before !== undefined ? now - before : null;
  const maxBand = Math.max(1, ...RATED_BANDS.map((h) => stats.bands[h]));
  const scopeLabel = platform === ALL ? "All channels" : platform;
  const colCount = 7 + (showPlatform ? 1 : 0) + (hasPrev ? 1 : 0);

  const sortHead = (k: SortKey, label: string, className?: string) => (
    <th key={k} className={cn("px-3 py-2.5 font-semibold", className)}>
      <button onClick={() => toggleSort(k)} className={cn("inline-flex items-center gap-1 hover:text-foreground", sort.key === k && "text-foreground")}>
        {label}
        {sort.key === k && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-6 pb-16">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Ratings & Reviews</h1>
          {/* Phones: each channel card carries its own snapshot dates, so the header stays one line. */}
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground sm:hidden">
            <CalendarClock className="h-4 w-4" />
            Latest {fmtDate(data.snapshotDate)} · {data.snapshotDates.length} week{data.snapshotDates.length === 1 ? "" : "s"} of history
          </p>
          <p className="mt-1 hidden flex-wrap items-center gap-x-2 text-sm text-muted-foreground sm:flex">
            <CalendarClock className="h-4 w-4" />
            {/* each channel shows its own latest upload (user, 2026-10-16) */}
            {Object.entries(data.platformDates).map(([p, d], i) => (
              <span key={p} className="whitespace-nowrap">
                {i > 0 && <span className="mr-2 text-muted-foreground/50">·</span>}
                <b className="text-foreground">{p}</b> {fmtDate(d.current)}{d.previous ? <> vs {fmtDate(d.previous)}</> : null}
              </span>
            ))}
            <span className="text-muted-foreground/50">·</span>
            {data.snapshotDates.length} week{data.snapshotDates.length === 1 ? "" : "s"} of history
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Refresh
          </button>
          <button
            onClick={() =>
              exportExcel(
                tableRows.flatMap((l) => l.skus),
                `ratings_reviews_${platform === ALL ? "all" : platform.toLowerCase()}_${data.snapshotDate}`
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" /> Export
          </button>
          <button
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            <Upload className="h-3.5 w-3.5" /> Upload weekly data
          </button>
        </div>
      </div>

      {/* Channel cards — they are also the channel switch: click one to focus the whole page on it */}
      <div>
        {/* Phones: a swipeable row; wider screens: a grid that fits however many channels carry ratings */}
        <div className="scrollbar-none -mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 py-1 sm:mx-0 sm:grid sm:overflow-visible sm:px-0 sm:py-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
          {scorecards.map((c) => {
            const change = c.avg !== null && c.prevAvg !== null ? c.avg - c.prevAvg : null;
            const active = platform === c.key;
            const idx = ratedPlatforms.indexOf(c.key);
            const color = idx >= 0 ? PLATFORM_COLORS[idx % PLATFORM_COLORS.length] : "#64748b";
            return (
              <button
                key={c.key}
                aria-pressed={active}
                onClick={() => {
                  setPlatformSel(c.key);
                  setPage(0);
                }}
                className={cn(
                  "relative w-[82%] flex-shrink-0 snap-start overflow-hidden rounded-2xl border bg-card p-4 text-left shadow-sm transition-[transform,box-shadow,border-color] sm:w-auto hover:-translate-y-0.5 hover:shadow-md",
                  active ? "border-indigo-500 ring-2 ring-indigo-500/20" : "border-border hover:border-indigo-300"
                )}
              >
                <span className="absolute inset-x-0 top-0 h-1" style={{ background: color, opacity: active ? 1 : 0.55 }} />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold text-foreground">{c.label}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", c.crossed > 0 ? "bg-red-500/10 text-red-600 dark:text-red-400" : c.below4 > 0 ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}>
                    {c.crossed > 0 ? `${c.crossed} fell below 4★` : c.below4 > 0 ? `${c.below4} at risk` : "Healthy"}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-3xl font-black tracking-tight text-foreground">{c.avg !== null ? c.avg.toFixed(2) : "—"}</span>
                  <Star className="h-4 w-4 flex-shrink-0 fill-amber-400 text-amber-400" />
                  {change !== null && <Delta value={Math.round(change * 100) / 100} digits={2} />}
                </div>
                <div className="mt-1" title={`Weekly average rating, ${c.spark.filter((v) => v !== null).length} snapshots`}>
                  <Sparkline values={c.spark} color={color} />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-[11px]">
                  <div><p className="font-bold tabular-nums text-foreground">{fmtInt(c.rated)}</p><p className="text-muted-foreground">rated</p></div>
                  <div><p className={cn("font-bold tabular-nums", c.below4 ? "text-amber-600 dark:text-amber-400" : "text-foreground")}>{fmtInt(c.below4)}</p><p className="text-muted-foreground">below 4★</p></div>
                  <div><p className="font-bold tabular-nums text-foreground">+{fmtInt(c.newReviews)}</p><p className="text-muted-foreground">new reviews</p></div>
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {c.dates
                    ? <>Snapshot {fmtDate(c.dates.current)}{c.dates.previous ? ` vs ${fmtDate(c.dates.previous)}` : " · first upload"}</>
                    : `${ratedPlatforms.length} channels combined`}
                </p>
              </button>
            );
          })}
        </div>
        {untracked.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground" title={untracked.join(", ")}>
            Ratings tracked for {ratedPlatforms.join(", ")} · {untracked.length} other channel{untracked.length === 1 ? " has" : "s have"} no rating data yet
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span className="font-semibold uppercase tracking-wide">{scopeLabel}</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          label="Average rating"
          value={summary.weightedRating !== null ? `${summary.weightedRating.toFixed(2)}★` : "—"}
          sub={summary.avgRating !== null ? `Weighted by reviews · simple avg ${summary.avgRating.toFixed(2)}★` : undefined}
          icon={Star}
          tone={summary.weightedRating !== null && summary.weightedRating >= 4 ? "good" : "warn"}
          delta={hasPrev && <Delta value={d(summary.weightedRating, prevSummary?.weightedRating)} digits={2} />}
        />
        <Kpi
          label="Total reviews"
          value={fmtInt(summary.totalReviews)}
          sub={hasPrev ? `+${fmtInt(stats.newReviews)} since ${fmtDate(data.previousDate)}` : "Counted once per listing"}
          icon={MessageSquare}
        />
        <Kpi
          label="Rated listings"
          value={`${fmtInt(stats.rated)} / ${fmtInt(stats.listings)}`}
          sub={`${fmtInt(summary.rated)} of ${fmtInt(summary.skus)} SKUs incl. variants`}
          icon={Layers}
          delta={hasPrev && <Delta value={stats.rated - stats.prev.rated} digits={0} />}
        />
        <Kpi
          label="Below 4★"
          value={fmtInt(stats.below4Solid)}
          sub={`listings with ${MIN_REVIEWS}+ reviews · +${stats.below4Low} with fewer`}
          icon={AlertTriangle}
          tone={stats.below4Solid ? "warn" : "good"}
          delta={hasPrev && <Delta value={stats.below4Solid - stats.prev.below4Solid} digits={0} inverse />}
        />
        <Kpi
          label="Critical (below 3★)"
          value={fmtInt(stats.below3Solid)}
          sub={`listings with ${MIN_REVIEWS}+ reviews`}
          icon={ShieldAlert}
          tone={stats.below3Solid ? "bad" : "good"}
          delta={hasPrev && <Delta value={stats.below3Solid - stats.prev.below3Solid} digits={0} inverse />}
        />
      </div>

      {/* Week over week */}
      {!hasPrev ? (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-dashed border-indigo-300 bg-indigo-50/60 px-5 py-4 dark:border-indigo-900 dark:bg-indigo-950/20">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
            <CalendarClock className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">First snapshot saved · {fmtDate(data.snapshotDate)}</p>
            <p className="text-xs text-muted-foreground">
              Upload next week&apos;s sheet to unlock week-over-week changes — rating drops & gains, new reviews and the trend line.
            </p>
          </div>
          <button
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            <Upload className="h-3.5 w-3.5" /> Upload next week
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardTitle
              icon={CalendarClock}
              title="This week vs last week"
              hint={`${fmtDate(data.previousDate)} → ${fmtDate(data.snapshotDate)} · per listing`}
            />
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Rating dropped", value: changes.drops.length, cls: "text-red-600 dark:text-red-400" },
                { label: "Rating improved", value: changes.gains.length, cls: "text-emerald-600 dark:text-emerald-400" },
                { label: "Newly rated", value: changes.newlyRated, cls: "text-indigo-600 dark:text-indigo-400" },
                { label: "New listings", value: changes.newListings, cls: "text-foreground" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl bg-muted/50 px-3 py-2">
                  <div className={cn("text-lg font-bold tabular-nums", s.cls)}>{fmtInt(s.value)}</div>
                  <div className="text-[11px] text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { title: "Biggest drops", list: changes.drops, empty: "No rating dropped this week." },
                { title: "Biggest gains", list: changes.gains, empty: "No rating improved this week." },
              ].map((col) => (
                <div key={col.title}>
                  <p className="mb-1 text-xs font-semibold text-muted-foreground">{col.title}</p>
                  {col.list.length === 0 ? (
                    <p className="py-4 text-xs text-muted-foreground">{col.empty}</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {col.list.slice(0, 5).map((l) => (
                        <ListingLine
                          key={l.key}
                          l={l}
                          showPlatform={showPlatform}
                          onOpen={setDetail}
                          right={
                            <span className="text-right">
                              <span className="block text-xs tabular-nums text-muted-foreground">
                                {l.prevRating?.toFixed(1)} → <span className="font-semibold text-foreground">{l.rating?.toFixed(1)}★</span>
                              </span>
                              <Delta value={l.ratingDelta} />
                            </span>
                          }
                        />
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <CardTitle
              icon={TrendingUp}
              title={trendMetric === "avg" ? "Average rating trend" : "SKUs below 4★"}
              hint={trendMetric === "avg" ? "Simple average of rated SKUs per snapshot" : "Rated SKUs under 4★ per snapshot"}
              right={
                <div className="inline-flex flex-shrink-0 rounded-lg border border-border bg-muted/50 p-0.5">
                  {(
                    [
                      ["avg", "Avg ★"],
                      ["below4", "< 4★"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setTrendMetric(k)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11px] font-semibold",
                        trendMetric === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              }
            />
            <div className="h-[230px] text-muted-foreground">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend.rows} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: "currentColor" }} tickLine={false} axisLine={false} />
                  <YAxis
                    domain={trendMetric === "avg" ? ["dataMin - 0.1", "dataMax + 0.1"] : [0, "auto"]}
                    allowDecimals={trendMetric === "avg"}
                    tickFormatter={(v: number) => (trendMetric === "avg" ? v.toFixed(1) : fmtInt(v))}
                    tick={{ fontSize: 11, fill: "currentColor" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    formatter={(v) => (typeof v !== "number" ? String(v) : trendMetric === "avg" ? `${v.toFixed(2)}★` : `${fmtInt(v)} SKUs`)}
                    labelFormatter={(v) => fmtDate(String(v))}
                    contentStyle={tooltipStyle}
                  />
                  {trend.plats.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
                  {/* Same colour per channel as its card's accent and sparkline */}
                  {trend.plats.map((p) => (
                    <Line key={p} type="monotone" dataKey={p} stroke={PLATFORM_COLORS[Math.max(0, ratedPlatforms.indexOf(p)) % PLATFORM_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}

      {/* Health + attention */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardTitle icon={Star} title="Rating health" hint={`${scopeLabel} · ${fmtInt(stats.rated)} rated listings · click to filter`} />
          {/* Stacked overview bar */}
          <div className="mb-4 flex h-3 overflow-hidden rounded-full bg-muted">
            {RATED_BANDS.map((h) =>
              stats.bands[h] ? (
                <span
                  key={h}
                  className="h-full"
                  style={{ width: `${(stats.bands[h] / Math.max(1, stats.rated)) * 100}%`, background: HEALTH_META[h].color }}
                  title={`${HEALTH_META[h].label}: ${stats.bands[h]}`}
                />
              ) : null
            )}
          </div>
          <div className="space-y-1">
            {RATED_BANDS.map((h) => {
              const m = HEALTH_META[h];
              const n = stats.bands[h];
              const active = healthSel === h;
              return (
                <button
                  key={h}
                  onClick={() => applyHealth(h)}
                  className={cn(
                    "grid w-full grid-cols-[92px_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
                    active ? "bg-muted ring-1 ring-border" : "hover:bg-muted/60"
                  )}
                >
                  <span>
                    <span className="block text-xs font-semibold text-foreground">{m.label}</span>
                    <span className="block text-[10px] text-muted-foreground">{m.range}</span>
                  </span>
                  <span className="h-2 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full" style={{ width: `${(n / maxBand) * 100}%`, background: m.color }} />
                  </span>
                  <span className="min-w-[72px] text-right">
                    <span className="text-sm font-bold tabular-nums text-foreground">{fmtInt(n)}</span>
                    <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
                      {stats.rated ? Math.round((n / stats.rated) * 100) : 0}%
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
            <button
              onClick={() => applyHealth("unrated")}
              className={cn("rounded-lg px-2 py-1.5 text-left hover:bg-muted/60", healthSel === "unrated" && "bg-muted ring-1 ring-border")}
            >
              <span className="block text-sm font-bold tabular-nums text-foreground">{fmtInt(stats.unrated)}</span>
              <span className="block text-[11px] text-muted-foreground">listings not rated yet</span>
            </button>
            <button
              onClick={() => applyHealth("low")}
              className={cn("rounded-lg px-2 py-1.5 text-left hover:bg-muted/60", healthSel === "low" && "bg-muted ring-1 ring-border")}
            >
              <span className="block text-sm font-bold tabular-nums text-foreground">{fmtInt(stats.lowConfidence)}</span>
              <span className="block text-[11px] text-muted-foreground">rated on &lt; {MIN_REVIEWS} reviews</span>
            </button>
          </div>
        </Card>

        <Card className="lg:col-span-3">
          <CardTitle
            icon={AlertTriangle}
            title="Needs attention"
            hint={`Below 4★ with ${MIN_REVIEWS}+ reviews — ranked by stars lost × shoppers reached`}
          />
          {attention.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No listing with {MIN_REVIEWS}+ reviews is below 4★.</p>
          ) : (
            <ul className="divide-y divide-border">
              {attention.map((l) => (
                <ListingLine
                  key={l.key}
                  l={l}
                  showPlatform={showPlatform}
                  onOpen={setDetail}
                  right={
                    <>
                      <span className="text-right">
                        <Stars rating={l.rating} size={11} />
                        <span className="block text-[11px] text-muted-foreground">{fmtInt(l.reviews)} reviews</span>
                      </span>
                      <span className="hidden w-[74px] sm:block">
                        <HealthBadge health={l.health} />
                      </span>
                    </>
                  }
                />
              ))}
            </ul>
          )}
          {stats.below4Low > 0 && (
            <button
              onClick={() => applyHealth("low")}
              className="mt-3 w-full rounded-lg bg-muted/60 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              + {fmtInt(stats.below4Low)} more below 4★ on fewer than {MIN_REVIEWS} reviews — likely to move with the next few reviews →
            </button>
          )}
        </Card>
      </div>

      {/* Top performers + cross-platform */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className={ratedPlatforms.length >= 2 ? "lg:col-span-2" : "lg:col-span-5"}>
          <CardTitle icon={Trophy} title="Top performers" hint="4.5★ and above with 20+ reviews" />
          {topRated.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No listing at 4.5★ with 20+ reviews yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {topRated.map((l) => (
                <ListingLine
                  key={l.key}
                  l={l}
                  showPlatform={showPlatform}
                  onOpen={setDetail}
                  right={
                    <span className="text-right">
                      <Stars rating={l.rating} size={11} />
                      <span className="block text-[11px] text-muted-foreground">{fmtInt(l.reviews)} reviews</span>
                    </span>
                  }
                />
              ))}
            </ul>
          )}
        </Card>

        {ratedPlatforms.length >= 2 && (
          <Card className="lg:col-span-3">
            <CardTitle
              icon={Layers}
              title="Same product, different channel"
              hint={`Rated on 2+ of ${ratedPlatforms.join(", ")} (${MIN_REVIEWS}+ reviews each), spread ≥ 0.3★ · ${comparison.length} products`}
            />
            {comparison.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Ratings line up across channels.</p>
            ) : (
              <div className="max-h-[330px] overflow-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="sticky top-0 z-[1] bg-card text-[11px] text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-2 pr-2 font-semibold">Product</th>
                      {ratedPlatforms.map((p) => (
                        <th key={p} className="px-2 py-2 text-right font-semibold">
                          {p}
                        </th>
                      ))}
                      <th className="py-2 pl-2 text-right font-semibold" title="Best channel rating minus worst">
                        Spread
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {comparison.map((r) => {
                      const rs = Object.values(r.byPlatform).map((x) => x.rating);
                      const best = Math.max(...rs);
                      const worst = Math.min(...rs);
                      return (
                        <tr key={r.name}>
                          <td className="max-w-[200px] truncate py-2 pr-2 text-foreground" title={r.name}>
                            {r.name}
                          </td>
                          {ratedPlatforms.map((p) => {
                            const x = r.byPlatform[p];
                            return (
                              <td key={p} className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                                {x ? (
                                  <span
                                    className={cn(
                                      x.rating === best ? "font-semibold text-emerald-600 dark:text-emerald-400" : x.rating === worst ? "font-semibold text-red-600 dark:text-red-400" : "text-foreground"
                                    )}
                                  >
                                    {x.rating.toFixed(1)}★ <span className="text-[11px] font-normal text-muted-foreground">({fmtInt(x.reviews)})</span>
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                            );
                          })}
                          <td className="py-2 pl-2 text-right font-semibold tabular-nums text-foreground">{r.spread.toFixed(1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* All listings */}
      <div id="rr-table" className="scroll-mt-24">
        <Card className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
            <div>
              <h3 className="text-sm font-bold text-foreground">All listings</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {fmtInt(tableRows.length)} of {fmtInt(listings.length)} listings ({fmtInt(scoped.length)} SKUs) · {scopeLabel}
                {healthSel !== "all" && (
                  <>
                    {" · "}
                    <button onClick={() => setHealthSel("all")} className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                      {healthSel === "low" ? "few reviews" : HEALTH_META[healthSel].label} ✕
                    </button>
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={healthSel}
                onChange={(e) => {
                  setHealthSel(e.target.value as HealthFilter);
                  setPage(0);
                }}
                className="rounded-lg border border-border bg-background px-2.5 py-2 text-xs font-medium text-foreground"
              >
                <option value="all">All ratings</option>
                {[...RATED_BANDS, "unrated" as Health].map((h) => (
                  <option key={h} value={h}>
                    {HEALTH_META[h].label} ({HEALTH_META[h].range})
                  </option>
                ))}
                <option value="low">Few reviews (&lt; {MIN_REVIEWS})</option>
              </select>
              <select
                value={minReviews}
                onChange={(e) => {
                  setMinReviews(Number(e.target.value) as MinReviews);
                  setPage(0);
                }}
                className="rounded-lg border border-border bg-background px-2.5 py-2 text-xs font-medium text-foreground"
              >
                <option value={0}>Any reviews</option>
                <option value={5}>5+ reviews</option>
                <option value={20}>20+ reviews</option>
                <option value={100}>100+ reviews</option>
              </select>
              <div className="relative w-full sm:w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0);
                  }}
                  placeholder="Search product or SKU"
                  className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
            </div>
          </div>

          {/* Phones: one card per listing instead of a sideways-scrolling table */}
          <ul className="divide-y divide-border md:hidden">
            {pageRows.map((l) => (
              <li key={l.key}>
                <button onClick={() => setDetail(l)} className="flex w-full items-start gap-3 px-4 py-3 text-left active:bg-muted/60">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium leading-snug text-foreground">{l.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {showPlatform && `${l.platform} · `}
                      {l.skus.length > 1 ? `${l.skus.length} variants` : l.skus[0].skuId} · {fmtPriceRange(l.priceMin, l.priceMax)}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <HealthBadge health={l.health} />
                      <RiskBadge l={l} />
                      {l.lowConfidence && <LowConfidence />}
                    </span>
                  </span>
                  <span className="flex flex-shrink-0 flex-col items-end gap-0.5">
                    <Stars rating={l.rating} size={10} />
                    {l.rating !== null && <span className="text-[11px] tabular-nums text-muted-foreground">{fmtInt(l.reviews)} reviews</span>}
                    {hasPrev && (l.isNew ? <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">New</span> : <Delta value={l.ratingDelta} />)}
                  </span>
                </button>
              </li>
            ))}
            {pageRows.length === 0 && (
              <li className="py-12 text-center text-sm text-muted-foreground">
                <StarOff className="mx-auto mb-2 h-6 w-6" />
                No listings match these filters.
              </li>
            )}
          </ul>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted/40 text-left text-[11px] text-muted-foreground">
                <tr>
                  {sortHead("name", "Product", "pl-4")}
                  {showPlatform && <th className="px-3 py-2.5 font-semibold">Platform</th>}
                  {sortHead("rating", "Rating")}
                  {sortHead("reviews", "Reviews", "text-right")}
                  {hasPrev && sortHead("change", "vs last week", "text-right")}
                  {sortHead("price", "Price", "text-right")}
                  <th className="px-3 py-2.5 font-semibold">Health</th>
                  <th className="px-3 py-2.5 font-semibold">Risk</th>
                  <th className="w-10 px-3 py-2.5 pr-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageRows.map((l) => {
                  const multi = l.skus.length > 1;
                  return (
                      <tr key={l.key} className="cursor-pointer hover:bg-muted/40" onClick={() => setDetail(l)} title="Open weekly history">
                        <td className="max-w-[380px] py-2.5 pl-4 pr-3">
                          <span className="block truncate font-medium text-foreground" title={l.name}>
                            {l.name}
                          </span>
                          <span className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                            {multi ? (
                              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 font-medium">
                                <Layers className="h-3 w-3" /> {l.skus.length} variants
                              </span>
                            ) : (
                              <span className="font-mono">{l.skus[0].skuId}</span>
                            )}
                          </span>
                        </td>
                        {showPlatform && <td className="px-3 py-2.5 text-xs text-muted-foreground">{l.platform}</td>}
                        <td className="px-3 py-2.5">
                          <span className="flex items-center gap-2">
                            <Stars rating={l.rating} />
                            {l.lowConfidence && <LowConfidence />}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{l.rating === null ? "—" : fmtInt(l.reviews)}</td>
                        {hasPrev && (
                          <td className="px-3 py-2.5 text-right">
                            {l.isNew ? (
                              <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">New</span>
                            ) : (
                              <span className="inline-flex flex-col items-end">
                                <Delta value={l.ratingDelta} />
                                {l.reviewsDelta ? <span className="text-[11px] text-muted-foreground">+{fmtInt(l.reviewsDelta)} reviews</span> : null}
                              </span>
                            )}
                          </td>
                        )}
                        <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-foreground">{fmtPriceRange(l.priceMin, l.priceMax)}</td>
                        <td className="px-3 py-2.5">
                          <HealthBadge health={l.health} />
                        </td>
                        <td className="px-3 py-2.5">
                          <RiskBadge l={l} />
                        </td>
                        <td className="px-3 py-2.5 pr-4 text-muted-foreground">
                          <ChevronRight className="h-4 w-4" />
                        </td>
                      </tr>
                  );
                })}
                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={colCount} className="py-12 text-center text-sm text-muted-foreground">
                      <StarOff className="mx-auto mb-2 h-6 w-6" />
                      No listings match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {tableRows.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
              <span>
                {fmtInt(safePage * PAGE_SIZE + 1)}–{fmtInt(Math.min(tableRows.length, (safePage + 1) * PAGE_SIZE))} of {fmtInt(tableRows.length)}
              </span>
              <div className="flex items-center gap-1">
                <button
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                  className="rounded-md border border-border p-1.5 hover:bg-muted disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="px-2 tabular-nums">
                  {safePage + 1} / {pageCount}
                </span>
                <button
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(safePage + 1)}
                  className="rounded-md border border-border p-1.5 hover:bg-muted disabled:opacity-40"
                  aria-label="Next page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {uploadDialog}
      {detail && <ListingDrawer l={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
