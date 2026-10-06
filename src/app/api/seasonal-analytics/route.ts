import { NextResponse } from "next/server";
import { checkSession } from "@/lib/apiAuth";
import { rejectUnlessAllowed } from "@/lib/appRouteAuth";
import { supabase } from "@/lib/supabaseClient";
import { analyze, toDetailDto, toListDto, type SeasonalPayload, type SeasonalResult } from "@/lib/seasonalAnalytics";

// Seasonal Analytics: all aggregation happens server side. Postgres builds the daily history from
// the same sources as product_forecast_summary_live_v (public.seasonal_sales_daily(), cached in
// seasonal_sales_cache by a cron tick — see scripts/seasonal_analytics_cache.sql); this route runs
// the analytics engine over it and sends the browser only the per-product results.
//
// GET ?marketplaces=Amazon,Flipkart&from=yyyy-mm-dd&to=yyyy-mm-dd        -> list (KPIs, table, charts)
// GET ...&master=<master product name>                                    -> drill-down for one product

const PAYLOAD_TTL_MS = 5 * 60_000;
let payloadCache: { at: number; payload: SeasonalPayload } | null = null;
let inflight: Promise<SeasonalPayload> | null = null;
// computed results per filter set, invalidated with the payload
const resultCache = new Map<string, SeasonalResult>();

async function loadPayload(): Promise<SeasonalPayload> {
  if (payloadCache && Date.now() - payloadCache.at < PAYLOAD_TTL_MS) return payloadCache.payload;
  inflight ??= (async () => {
    try {
      const { data, error } = await supabase.rpc("get_seasonal_sales_cache");
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Seasonal sales cache is empty — it is built by the seasonal-sales-tick cron job within a minute of the forecast refresh.");
      payloadCache = { at: Date.now(), payload: data as SeasonalPayload };
      resultCache.clear();
      return payloadCache.payload;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const rejected = rejectUnlessAllowed(req, checkSession, { bucket: "seasonal-analytics", limit: 120, windowMs: 60_000 });
  if (rejected) return rejected;
  try {
    const url = new URL(req.url);
    const marketplaces = (url.searchParams.get("marketplaces") || "").split(",").map((s) => s.trim()).filter(Boolean).sort();
    const from = url.searchParams.get("from") || undefined;
    const to = url.searchParams.get("to") || undefined;
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) {
      return NextResponse.json({ error: "from/to must be yyyy-mm-dd" }, { status: 400 });
    }
    const master = url.searchParams.get("master");

    const payload = await loadPayload();
    const key = JSON.stringify([marketplaces, from, to]);
    let result = resultCache.get(key);
    if (!result) {
      result = analyze(payload, { marketplaces, from, to });
      if (resultCache.size > 20) resultCache.delete(resultCache.keys().next().value as string);
      resultCache.set(key, result);
    }

    if (master) {
      const detail = toDetailDto(payload, result, master);
      if (!detail) return NextResponse.json({ error: `Master product not found for the selected filters: ${master}` }, { status: 404 });
      return NextResponse.json(detail);
    }
    return NextResponse.json(toListDto(result, payload.coverage.map((c) => c.marketplace)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
