// Product Marketing 360 — writes parsed Drive files to Supabase (shared by the page's upload panel
// and scripts/marketing360-load.ts). The Supabase client is passed in so this file has no "@/"
// imports and runs under plain node.

import type { SupabaseClient } from "@supabase/supabase-js";
import type * as XLSX from "xlsx";
import { dateFromName, detectKind, parseDelivery, parseForecast, parsePositions, parseRating, parseTemplate, type Kind } from "./marketing360Import.ts";

async function upsert(db: SupabaseClient, table: string, rows: object[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

export type ImportResult = { kind: Kind; summary: string };

export async function importWorkbook(db: SupabaseClient, wb: XLSX.WorkBook, fileName: string, opts: { dry?: boolean; date?: string } = {}): Promise<ImportResult> {
  const kind = detectKind(wb);
  if (!kind) throw new Error(`${fileName}: not one of the Marketing 360 files (delivery sweep, rating & review, position tracker, FBA forecast, marketing template).`);
  const dated = () => {
    const d = opts.date ?? dateFromName(fileName);
    if (!d) throw new Error(`${fileName}: no date in the file name — rename it like "… 16 Nov 2026.xlsx" or "… 2026-11-16.xlsx".`);
    return d;
  };
  const write = async (table: string, rows: object[], key: string) => { if (!opts.dry && rows.length) await upsert(db, table, rows, key); };

  if (kind === "delivery") {
    const rows = parseDelivery(wb);
    await write("mkt_delivery_sweep", rows, "week,platform,asin_fsn,pincode");
    if (!opts.dry && rows.length) {
      // the full sheet reads precomputed summaries; rebuild them from the new checks
      const { error } = await db.rpc("mkt_refresh_delivery");
      if (error) throw new Error(`mkt_refresh_delivery: ${error.message}`);
    }
    const weeks = [...new Set(rows.map((r) => r.week))].sort();
    return { kind, summary: `${rows.length} delivery checks, weeks ${weeks.join(", ")}` };
  }
  if (kind === "rating") {
    const date = dated();
    const rows = parseRating(wb, date);
    await write("mkt_rating_weekly", rows, "snapshot_date,sku_id,asin_fsn");
    return { kind, summary: `${rows.length} rating rows for ${date}` };
  }
  if (kind === "positions") {
    const { keywords, competitors } = parsePositions(wb);
    await write("mkt_keyword_positions", keywords, "week,search_term,asin");
    await write("mkt_competitor_positions", competitors, "week,search_term,asin");
    const weeks = [...new Set(keywords.map((r) => r.week))].sort();
    return { kind, summary: `${keywords.length} BARM keyword positions, ${competitors.length} competitor positions, weeks ${weeks.join(", ")}` };
  }
  if (kind === "forecast") {
    const date = dated();
    const { zones, fcStock } = parseForecast(wb, date);
    await write("mkt_fba_forecast_zone", zones, "report_date,sku,zone");
    await write("mkt_fba_fc_stock", fcStock, "report_date,fc,msku,disposition");
    return { kind, summary: `${zones.length} SKU×zone forecast rows and ${fcStock.length} FC stock rows for ${date}` };
  }
  // template: profile fields, action plan, influencers, Sheet1 channel notes
  const { cards, notes } = parseTemplate(wb);
  const skipped: string[] = [];
  if (!opts.dry) {
    for (const c of cards) {
      const { data: existing } = await db.from("mkt_product_profile").select("asin").eq("asin", c.asin).maybeSingle();
      if (!existing) {
        await upsert(db, "mkt_product_profile", [{ asin: c.asin, tam_value: c.tam_value, primary_audience: c.primary_audience, secondary_audience: c.secondary_audience, retarget: c.retarget }], "asin");
      }
      if (c.copied) { skipped.push(c.asin); continue; }
      // only fill an empty plan / influencer list — never duplicate rows on a re-import
      const [{ count: nPlan }, { count: nInf }] = await Promise.all([
        db.from("mkt_action_plan").select("id", { count: "exact", head: true }).eq("asin", c.asin),
        db.from("mkt_influencer_posts").select("id", { count: "exact", head: true }).eq("asin", c.asin),
      ]);
      if (!nPlan && c.actions.length) {
        const { error } = await db.from("mkt_action_plan").insert(c.actions.map((a) => ({ asin: c.asin, ...a })));
        if (error) throw new Error(`mkt_action_plan: ${error.message}`);
      }
      if (!nInf && c.influencers.length) {
        const { error } = await db.from("mkt_influencer_posts").insert(c.influencers.map((x) => ({ asin: c.asin, ...x })));
        if (error) throw new Error(`mkt_influencer_posts: ${error.message}`);
      }
    }
    await upsert(db, "mkt_channel_notes", notes, "product,channel");
  }
  return {
    kind,
    summary: `${cards.length} product cards (${cards.map((c) => c.asin).join(", ")}), ${notes.length} channel notes` +
      (skipped.length || cards.some((c) => c.copied) ? `; action plan / influencers not copied for ${cards.filter((c) => c.copied).map((c) => c.asin).join(", ")} (same as an earlier card)` : ""),
  };
}
