// COPY of src/lib/googleWebsiteOrders.ts for the Edge job — keep the two identical.
// Google (website) orders for the Ad Spend Report's Google row — which order lines count, and which
// of them Google Ads can take credit for. Dependency-free so it can be unit tested;
// supabase/functions/_shared/deps/googleWebsiteOrders.ts is a copy for the Edge job — keep the two
// identical.
//
// Two sources (seller's approval, 24 Oct 2026):
//   - barm_daily_google_orders: the Google card uploads — the hand-kept "B-Arm Orders" workbook,
//     old invoices, and Shopify "Total sales by product" exports (invoice "SHOPIFY-…").
//   - Shopify orders by webhook (barm_shopify_orders_v2, read through barm_shopify_orders_summary).
// From the first day Shopify webhook data exists ("shopifyFrom"), Shopify is the source of truth:
//   - a card row from a Shopify export is always left out;
//   - any other card row is left out only when it is the same sale as a Shopify line — same unit
//     price and quantity, dated the same day as the Shopify order or the day after (the workbook is
//     often filled in the next morning; seller's approval, 25 Oct 2026) — matched one-to-one,
//     same-day matches first; unmatched card rows are kept (non-Shopify orders);
//   - Shopify lines are added, except cancelled orders (test orders never reach this code).
// Before shopifyFrom every card row counts, exactly as before. No row is deleted anywhere.
// Google Ads credit = Shopify lines whose order's visit came from a Google Ads click
// (ad_channel "google_ads": gclid / gbraid / wbraid / gad_* on the landing URL).

export interface GoogleCardRow {
  id?: number | null;
  order_date: string | null;
  invoice: string | null;
  product_name: string | null;
  quantity: number | string | null;
  price: number | string | null;
}

export interface ShopifyReportItem {
  title: string | null;
  variant_title?: string | null;
  quantity: number | string | null;
  price: number | string | null;
  line_total?: number | string | null;
}

export interface ShopifyReportOrder {
  order_name: string;
  order_date: string;
  is_cancelled: boolean;
  ad_channel: string | null;
  items: ShopifyReportItem[];
}

export interface GoogleWebsiteLine {
  date: string;
  name: string;
  quantity: number;
  /** Unit price (value ÷ quantity for a Shopify line). */
  price: number;
  value: number;
  source: "card" | "shopify";
  /** Shopify order name, for Shopify lines. */
  order: string | null;
  googleAds: boolean;
}

export interface DroppedCardRow {
  invoice: string;
  date: string;
  value: number;
  /** The Shopify order it duplicates; null for a Shopify-export row with no matching order. */
  matchedOrder: string | null;
}

export interface GoogleWebsiteOrders {
  lines: GoogleWebsiteLine[];
  dropped: DroppedCardRow[];
  shopifyFrom: string | null;
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const cents = (v: number) => Math.round(v * 100);
/** 'YYYY-MM-DD' moved by `days` calendar days (UTC arithmetic, so no time-zone drift). */
const shiftDate = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const isShopifyExportRow = (r: GoogleCardRow): boolean => /^SHOPIFY-/i.test(String(r.invoice ?? ""));

/**
 * `shopifyOrders` must be EVERY real Shopify order on file (not only the report window), so the
 * first Shopify day is known; `cardRows` may be just the window. Lines come back for every date
 * the inputs cover — the caller filters them to its window.
 */
export function mergeGoogleWebsiteOrders(cardRows: GoogleCardRow[], shopifyOrders: ShopifyReportOrder[]): GoogleWebsiteOrders {
  const shopifyFrom = shopifyOrders.reduce<string | null>((m, o) => (o.order_date && (!m || o.order_date < m) ? o.order_date : m), null);

  // Every Shopify line, cancelled orders included — a card row copying a cancelled order is still
  // a duplicate, it just isn't a sale.
  const shopifyLines = [...shopifyOrders]
    .sort((a, b) => a.order_name.localeCompare(b.order_name, undefined, { numeric: true }))
    .flatMap((o) =>
      o.items.map((i) => {
        const quantity = num(i.quantity);
        const value = i.line_total == null || i.line_total === "" ? quantity * num(i.price) : num(i.line_total);
        return { o, i, quantity, value, unitPrice: num(i.price), used: false };
      })
    );
  const matchKey = (date: string, unitPrice: number, quantity: number) => `${date}|${cents(unitPrice)}|${quantity}`;
  const unmatched = new Map<string, typeof shopifyLines>();
  shopifyLines.forEach((l) => {
    const k = matchKey(l.o.order_date, l.unitPrice, l.quantity);
    unmatched.set(k, [...(unmatched.get(k) ?? []), l]);
  });

  const rows = [...cardRows]
    .sort((a, b) => num(a.id) - num(b.id))
    .map((r) => {
      const date = r.order_date ?? "";
      const quantity = num(r.quantity);
      const price = num(r.price);
      return { r, date, quantity, price, value: quantity * price, covered: !!shopifyFrom && !!date && date >= shopifyFrom, match: null as (typeof shopifyLines)[number] | null };
    });
  // Two passes, one-to-one: first every card row against a Shopify line on its own date, then the
  // rows still unmatched against one on the day before (the B-Arm workbook often logs an order the
  // next day). Same-day matches are settled first so a next-day row can never take a Shopify line
  // that another row matches exactly.
  [0, 1].forEach((daysBefore) => {
    rows
      .filter((x) => x.covered && !x.match)
      .forEach((x) => {
        const match = unmatched.get(matchKey(shiftDate(x.date, -daysBefore), x.price, x.quantity))?.find((l) => !l.used);
        if (match) {
          match.used = true;
          x.match = match;
        }
      });
  });

  const lines: GoogleWebsiteLine[] = [];
  const dropped: DroppedCardRow[] = [];
  rows.forEach(({ r, date, quantity, price, value, covered, match }) => {
    if (covered && (match || isShopifyExportRow(r))) {
      dropped.push({ invoice: String(r.invoice ?? ""), date, value, matchedOrder: match ? match.o.order_name : null });
      return;
    }
    lines.push({
      date,
      name: String(r.product_name ?? "").replace(/\s+/g, " ").trim() || "(no product name)",
      quantity,
      price,
      value,
      source: "card",
      order: null,
      googleAds: false,
    });
  });

  shopifyLines
    .filter((l) => !l.o.is_cancelled)
    .forEach((l) => {
      const title = String(l.i.title ?? "").replace(/\s+/g, " ").trim() || "(no product name)";
      lines.push({
        date: l.o.order_date,
        name: title,
        quantity: l.quantity,
        price: l.quantity ? l.value / l.quantity : l.unitPrice,
        value: l.value,
        source: "shopify",
        order: l.o.order_name,
        googleAds: l.o.ad_channel === "google_ads",
      });
    });

  return { lines, dropped, shopifyFrom };
}

/** Google Ads ACOS (Spend without tax ÷ Ad Sales) and ROAS (Ad Sales ÷ Spend without tax). Both
 *  null when spend is 0 — that means no Google Ads report is on file for the window, not free ads —
 *  and ACOS is null when there are no Ad Sales. */
export function googleAdsRatios(spend: number, adSales: number): { acos: number | null; roas: number | null } {
  if (!(spend > 0)) return { acos: null, roas: null };
  return {
    acos: adSales > 0 ? spend / adSales : null,
    roas: adSales / spend,
  };
}
