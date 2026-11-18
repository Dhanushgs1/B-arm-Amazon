// Product Marketing 360 — parsers for the marketing team's Drive files (user, 2026-11-17).
// Pure functions over an XLSX workbook (no Supabase, no "@/" imports) so the page's upload panel
// and scripts/marketing360-load.ts share them, and node --test can run them directly.
//
//   delivery   BARM_W41_W44_Sweep_NoRating_NoReviewCount      tabs "W41 Checks" … "W48 Checks"
//   rating     AM FK Rating and Review - <dd Mon yyyy>_Ratings & Reviews (final).xlsx   Sheet1
//   positions  BARM_Gyno_Competitor_Position_Tracker          "BARM Position Tracking", "Competitor Position Tracking"
//   forecast   FBA Forecasting <yyyy-mm-dd>.xlsx              "FBA analysis", "FBA_stock"
//   template   <Product> - Marketing Team Template.xlsx       product cards + Sheet1 channel notes
//
// Missing values stay null (never 0). "NOT FOUND" positions are null.

import * as XLSX from "xlsx";

export type Kind = "delivery" | "rating" | "positions" | "forecast" | "template";
type Cell = string | number | boolean | Date | null;
type Row = Cell[];

const rowsOf = (ws: XLSX.WorkSheet | undefined): Row[] =>
  ws ? XLSX.utils.sheet_to_json<Row>(ws, { header: 1, defval: null, raw: true, blankrows: false }) : [];
const sheet = (wb: XLSX.WorkBook, re: RegExp) => {
  const n = wb.SheetNames.find((s) => re.test(s.trim()));
  return n ? wb.Sheets[n] : undefined;
};
export const str = (v: Cell | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};
export const num = (v: Cell | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
/** Position cells: a number, or "NOT FOUND"/blank → null. */
export const pos = (v: Cell | undefined): number | null => {
  const s = str(v);
  if (!s || /not\s*found|unavailable|not available/i.test(s)) return null;
  const n = num(s);
  return n !== null && n > 0 ? Math.round(n) : null;
};
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** "11-Oct-2026", "2026-11-11 08:01 IST", Excel serial 46340, Date → yyyy-mm-dd. */
export function toIsoDate(v: Cell | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null; // not an Excel date serial
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  return null;
}

/** Which of the five files this workbook is. */
export function detectKind(wb: XLSX.WorkBook): Kind | null {
  const names = wb.SheetNames.map((s) => s.trim());
  if (names.some((n) => /^W\d+ Checks$/i.test(n))) return "delivery";
  if (names.includes("BARM Position Tracking")) return "positions";
  if (names.includes("FBA analysis")) return "forecast";
  const first = rowsOf(wb.Sheets[wb.SheetNames[0]]).slice(0, 6);
  const flat = first.map((r) => r.map((c) => str(c) ?? "").join("|")).join("\n").toLowerCase();
  if (flat.includes("asin&fsn") && flat.includes("star value")) return "rating";
  if (flat.includes("product name") && (flat.includes("tam value") || flat.includes("aamazon"))) return "template";
  return null;
}

/** Date in a file name: "16 Nov 2026", "2026-11-16", "16-11-2026". */
export function dateFromName(name: string): string | null {
  return toIsoDate(name.replace(/_/g, " "));
}

// ── delivery sweep ──────────────────────────────────────────────────────────────────────────────
export type DeliveryRow = {
  week: string; platform: string; asin_fsn: string; pincode: string; tier: string | null; product_name: string | null;
  sku: string | null; location: string | null; delivery_text: string | null; days: number | null; scraped_date: string | null;
  status: string | null; note: string | null;
};
export function parseDelivery(wb: XLSX.WorkBook): DeliveryRow[] {
  const out = new Map<string, DeliveryRow>();
  for (const name of wb.SheetNames.filter((n) => /^W\d+ Checks$/i.test(n.trim()))) {
    const rows = rowsOf(wb.Sheets[name]);
    const h = (rows[0] ?? []).map((c) => (str(c) ?? "").toLowerCase());
    const col = (...keys: string[]) => h.findIndex((x) => keys.some((k) => x === k));
    const c = {
      week: col("week"), platform: col("platform"), tier: col("tier"), product: col("product name"), sku: col("sku"),
      asin: col("asin / fsn", "asin"), pin: col("pincode"), loc: col("location"),
      deliv: col("delivery estimate / availability", "delivery"), days: col("days", "days (numeric)"),
      date: col("scraped date"), status: col("status"), note: col("error / audit note"),
    };
    for (const r of rows.slice(1)) {
      const week = str(r[c.week]);
      const asin = str(r[c.asin]);
      const pin = str(r[c.pin]);
      if (!week || !asin || !pin) continue;
      const row: DeliveryRow = {
        week, platform: (c.platform >= 0 ? str(r[c.platform]) : null) ?? "Amazon", asin_fsn: asin, pincode: pin.replace(/\.0$/, ""),
        tier: str(r[c.tier]), product_name: str(r[c.product]), sku: str(r[c.sku]), location: c.loc >= 0 ? str(r[c.loc]) : null,
        delivery_text: str(r[c.deliv]), days: num(r[c.days]), scraped_date: toIsoDate(r[c.date]), status: str(r[c.status]),
        note: (str(r[c.note]) ?? "").slice(0, 300) || null,
      };
      out.set([row.week, row.platform, row.asin_fsn, row.pincode].join("|"), row); // later rows (re-checks) win
    }
  }
  return [...out.values()];
}

// ── weekly rating & review ──────────────────────────────────────────────────────────────────────
export type RatingRow = {
  snapshot_date: string; sku_id: string; asin_fsn: string; product: string | null; link: string | null;
  last_star: number | null; last_count: number | null; this_star: number | null; this_count: number | null; stock_status: string | null;
};
export function parseRating(wb: XLSX.WorkBook, snapshotDate: string): RatingRow[] {
  const rows = rowsOf(wb.Sheets[wb.SheetNames[0]]);
  const out = new Map<string, RatingRow>();
  let product: string | null = null;
  for (const r of rows.slice(2)) {
    product = str(r[0]) ?? product;
    const sku = str(r[1]);
    const asin = str(r[2]);
    if (!sku || !asin) continue;
    const row: RatingRow = {
      snapshot_date: snapshotDate, sku_id: sku, asin_fsn: asin, product, link: str(r[4]) ?? str(r[3]),
      last_star: num(r[5]), last_count: num(r[6]), this_star: num(r[7]), this_count: num(r[8]), stock_status: str(r[9]),
    };
    out.set(`${sku}|${asin}`, row);
  }
  return [...out.values()];
}

// ── keyword / competitor positions ──────────────────────────────────────────────────────────────
export type KeywordRow = {
  week: string; search_term: string; asin: string; product_group: string | null; brand: string | null;
  sp_position: number | null; sb_position: number | null; organic_position: number | null; status: string | null;
};
export type CompetitorRow = {
  week: string; search_term: string; asin: string; competitor_brand: string | null; product_name: string | null; product_url: string | null;
  sp_position: number | null; sb_position: number | null; organic_position: number | null; status: string | null;
};
function objects(ws: XLSX.WorkSheet | undefined): Record<string, Cell>[] {
  return ws ? XLSX.utils.sheet_to_json<Record<string, Cell>>(ws, { defval: null, raw: true }) : [];
}
export function parsePositions(wb: XLSX.WorkBook): { keywords: KeywordRow[]; competitors: CompetitorRow[] } {
  const kw = new Map<string, KeywordRow>();
  for (const o of objects(sheet(wb, /^BARM Position Tracking$/))) {
    const week = str(o.week), term = str(o.search_term_norm) ?? str(o.search_term), asin = str(o.asin);
    if (!week || !term || !asin) continue;
    kw.set(`${week}|${term}|${asin}`, {
      week, search_term: term, asin, product_group: str(o.gyno_product), brand: str(o.brand),
      sp_position: pos(o.sp_position), sb_position: pos(o.sb_position), organic_position: pos(o.organic_position), status: str(o.status),
    });
  }
  const comp = new Map<string, CompetitorRow>();
  for (const o of objects(sheet(wb, /^Competitor Position Tracking$/))) {
    const week = str(o.week), term = str(o.search_term_norm) ?? str(o.search_term), asin = str(o.asin);
    if (!week || !term || !asin) continue;
    comp.set(`${week}|${term}|${asin}`, {
      week, search_term: term, asin, competitor_brand: str(o.competitor_brand), product_name: str(o.product_name), product_url: str(o.product_url),
      sp_position: pos(o.sp_position), sb_position: pos(o.sb_position), organic_position: pos(o.organic_position), status: str(o.status),
    });
  }
  return { keywords: [...kw.values()], competitors: [...comp.values()] };
}

// ── FBA forecast ────────────────────────────────────────────────────────────────────────────────
export type ForecastZoneRow = {
  report_date: string; sku: string; zone: string; product_name: string | null; orders_30d: number | null; forecast_75d: number | null;
  current_stock: number | null; booked: number | null; intransit: number | null; to_send: number | null; runs_out_days: number | null;
  forecast_35d: number | null; shortfall_35d: number | null; alert_35d: string | null;
};
export type FcStockRow = { report_date: string; fc: string; msku: string; disposition: string; asin: string | null; zone: string | null; quantity: number };
export function parseForecast(wb: XLSX.WorkBook, reportDate: string): { zones: ForecastZoneRow[]; fcStock: FcStockRow[] } {
  const rows = rowsOf(sheet(wb, /^FBA analysis$/));
  const h = (rows[0] ?? []).map((c) => (str(c) ?? "").toLowerCase());
  const col = (re: RegExp) => h.findIndex((x) => re.test(x));
  const c = {
    sku: col(/^skuid$/), name: col(/^product name$/), zone: col(/^zone$/), orders: col(/^total orders in last 30 days/),
    f75: col(/^75 days forecast \(region/), stock: col(/^current stock present region/), booked: col(/^booked$/), intransit: col(/^intransit$/),
    send: col(/^to be send/), runs: col(/^stock runs out/), f35: col(/^35 days forecast/), short: col(/^35d shortfall/), alert: col(/^35d alert/),
  };
  const zones = new Map<string, ForecastZoneRow>();
  for (const r of rows.slice(1)) {
    const sku = str(r[c.sku]), zone = str(r[c.zone]);
    if (!sku || !zone) continue;
    zones.set(`${sku}|${zone}`, {
      report_date: reportDate, sku, zone, product_name: str(r[c.name]), orders_30d: num(r[c.orders]), forecast_75d: num(r[c.f75]),
      current_stock: num(r[c.stock]), booked: num(r[c.booked]), intransit: num(r[c.intransit]), to_send: num(r[c.send]),
      runs_out_days: num(r[c.runs]), forecast_35d: num(r[c.f35]), shortfall_35d: num(r[c.short]), alert_35d: str(r[c.alert]),
    });
  }
  const fc = new Map<string, FcStockRow>();
  for (const o of objects(sheet(wb, /^FBA_stock$/))) {
    const center = str(o["Fulfillment Center"]), msku = str(o.MSKU), disp = str(o.Disposition) ?? "SELLABLE";
    const qty = num(o["Ending Warehouse Balance"]);
    if (!center || !msku || qty === null) continue;
    const key = `${center}|${msku}|${disp}`;
    const prev = fc.get(key);
    if (prev) prev.quantity += qty;
    else fc.set(key, { report_date: toIsoDate(o.Date) ?? reportDate, fc: center, msku, disposition: disp, asin: str(o.ASIN), zone: str(o.ZONE), quantity: qty });
  }
  return { zones: [...zones.values()], fcStock: [...fc.values()] };
}

// ── the marketing team template (one-time import of what was typed into it) ──────────────────────
export const RETARGET_OPTIONS = [
  "Website Based", "Whatsapp", "Add-to-cart retargeting", "Pregnancy-stage targeting", "Milestone-based communication",
  "Cross-selling", "Healthcare partnerships", "WhatsApp/SMS/Email", "Repeat/extended-care campaigns",
] as const;
export const CHANNELS = [
  { key: "am_product", label: "AM Product ads" }, { key: "am_display", label: "AM Display ads" }, { key: "am_brand", label: "AM Brand ads" },
  { key: "am_fba", label: "FBA Stock" }, { key: "am_delivery", label: "Delivery date" }, { key: "am_rating", label: "Ratings and Reviews" },
  { key: "am_price", label: "Price lowest in Market" }, { key: "am_listing", label: "Listing Position" }, { key: "am_awareness", label: "Product Awareness" },
  { key: "fk_pla", label: "FK PLA ads" }, { key: "fk_pca", label: "FK PCA ads" },
  { key: "meesho_cpc", label: "Meesho CPC" }, { key: "meesho_cpo", label: "Meesho CPO" },
  { key: "google", label: "Google ads" }, { key: "social", label: "Social media ads" },
] as const;
// Sheet1 column letters → channel key. B-D Amazon ad types, E-V the Amazon checks (each spans 3 columns),
// W-X Flipkart, Y-Z Meesho, AA Google, AB social.
const SHEET1_COLS: [number, string][] = [
  [1, "am_product"], [2, "am_display"], [3, "am_brand"], [4, "am_fba"], [7, "am_delivery"], [10, "am_rating"], [13, "am_price"],
  [16, "am_listing"], [19, "am_awareness"], [22, "fk_pla"], [23, "fk_pca"], [24, "meesho_cpc"], [25, "meesho_cpo"], [26, "google"], [27, "social"],
];
export type ChannelNote = { product: string; channel: string; note: string };
export type TemplateCard = {
  asin: string; name: string | null; tam_value: number | null; primary_audience: string | null; secondary_audience: string | null;
  retarget: Record<string, boolean>; actions: { plan_date: string | null; task: string }[];
  influencers: { kind: string; language: string | null; influencer_name: string; post_link: string | null; digital_rights: string | null; states: string | null }[];
  /** true when this card's action plan / influencer list is a copy of an earlier card's (skipped on import). */
  copied: boolean;
};
const COL = (letters: string) => XLSX.utils.decode_col(letters);
export function parseTemplate(wb: XLSX.WorkBook): { cards: TemplateCard[]; notes: ChannelNote[] } {
  const cards: TemplateCard[] = [];
  const amazon = wb.SheetNames.find((n) => /amazon/i.test(n));
  if (amazon) {
    const ws = wb.Sheets[amazon];
    const ref = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
    const at = (r: number, c: number): Cell => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      return cell ? (cell.v as Cell) : null;
    };
    const B = 1, C = 2, F = 5, G = 6, H = 7, P = COL("P"), Q = COL("Q");
    const EE = COL("EE"), EF = COL("EF"), EG = COL("EG"), EH = COL("EH"), EJ = COL("EJ"), ED = COL("ED");
    const headers: number[] = [];
    for (let r = ref.s.r; r <= ref.e.r; r++) if (/^product name$/i.test(str(at(r, B)) ?? "") && /^asin$/i.test(str(at(r, C)) ?? "")) headers.push(r);
    const seen = new Set<string>();
    headers.forEach((hr, i) => {
      const end = i + 1 < headers.length ? headers[i + 1] - 1 : ref.e.r;
      let dataRow = -1;
      for (let r = hr + 1; r <= Math.min(hr + 5, end); r++) if (/^B0[A-Z0-9]{8}$/.test(str(at(r, C)) ?? "")) { dataRow = r; break; }
      if (dataRow < 0) return;
      const asin = str(at(dataRow, C))!;
      const retarget: Record<string, boolean> = {};
      for (let r = hr; r <= Math.min(hr + 15, end); r++) {
        const label = str(at(r, P));
        const opt = RETARGET_OPTIONS.find((o) => o.toLowerCase() === (label ?? "").toLowerCase());
        if (opt) retarget[opt] = /^yes/i.test(str(at(r, Q)) ?? "");
      }
      const actions: TemplateCard["actions"] = [];
      let planRow = -1;
      for (let r = dataRow; r <= end; r++) if (/^action plan$/i.test(str(at(r, B)) ?? "")) { planRow = r; break; }
      if (planRow >= 0) {
        for (let r = planRow + 1; r <= end; r++) {
          const task = str(at(r, C));
          if (!task) break;
          actions.push({ plan_date: str(at(r, B)), task });
        }
      }
      const influencers: TemplateCard["influencers"] = [];
      let kind = "organic", language: string | null = null;
      for (let r = hr; r <= end; r++) {
        const sec = str(at(r, ED));
        if (sec && /post ads/i.test(sec)) kind = "ads";
        else if (sec && /organic/i.test(sec)) kind = "organic";
        const lang = str(at(r, EE));
        if (lang && !/^languages?$/i.test(lang)) language = lang;
        const who = str(at(r, EF));
        if (!who || /^influencer name$/i.test(who)) continue;
        influencers.push({ kind, language, influencer_name: who, post_link: str(at(r, EG)), digital_rights: str(at(r, EH)), states: /^yes/i.test(str(at(r, EJ)) ?? "") ? "Posted" : null });
      }
      const sig = JSON.stringify([actions, influencers.map((x) => x.post_link)]);
      const copied = (actions.length > 0 || influencers.length > 0) && seen.has(sig);
      seen.add(sig);
      cards.push({
        asin, name: str(at(dataRow, B)), tam_value: num(at(dataRow, F)), primary_audience: str(at(dataRow, G)), secondary_audience: str(at(dataRow, H)),
        retarget, actions, influencers, copied,
      });
    });
  }
  const notes: ChannelNote[] = [];
  const s1 = wb.SheetNames.find((n) => /^sheet1$/i.test(n.trim()));
  if (s1) {
    const rows = rowsOf(wb.Sheets[s1]);
    for (const r of rows.slice(3)) {
      const product = str(r[0]);
      if (!product) continue;
      for (const [i, channel] of SHEET1_COLS) {
        const note = str(r[i]);
        if (note) notes.push({ product, channel, note });
      }
    }
  }
  return { cards, notes };
}

// ── pincode → state (first digits of the Indian PIN; the mkt_pincode_state table can override) ──
const PIN3: [number, number, string][] = [
  [110, 110, "Delhi"], [121, 136, "Haryana"], [140, 159, "Punjab"], [160, 160, "Chandigarh"], [171, 177, "Himachal Pradesh"],
  [180, 194, "Jammu & Kashmir"], [246, 246, "Uttarakhand"], [248, 249, "Uttarakhand"], [262, 263, "Uttarakhand"],
  [201, 285, "Uttar Pradesh"], [301, 345, "Rajasthan"], [360, 396, "Gujarat"], [403, 403, "Goa"], [400, 445, "Maharashtra"],
  [450, 488, "Madhya Pradesh"], [490, 497, "Chhattisgarh"], [500, 509, "Telangana"], [515, 535, "Andhra Pradesh"],
  [560, 591, "Karnataka"], [600, 643, "Tamil Nadu"], [670, 695, "Kerala"], [700, 743, "West Bengal"], [737, 737, "Sikkim"],
  [751, 770, "Odisha"], [781, 788, "Assam"], [790, 792, "Arunachal Pradesh"], [793, 794, "Meghalaya"], [795, 795, "Manipur"],
  [796, 796, "Mizoram"], [797, 798, "Nagaland"], [799, 799, "Tripura"],
  [814, 816, "Jharkhand"], [822, 822, "Jharkhand"], [825, 835, "Jharkhand"], [800, 855, "Bihar"],
];
export function pincodeState(pin: string): string | null {
  const p = Number(String(pin).slice(0, 3));
  if (!Number.isFinite(p)) return null;
  // most specific range first (Sikkim inside West Bengal, Goa inside Maharashtra, Jharkhand inside Bihar …)
  const hits = PIN3.filter(([a, b]) => p >= a && p <= b).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]));
  return hits[0]?.[2] ?? null;
}
