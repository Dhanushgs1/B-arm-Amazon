// supabase/functions/send-ad-spend-email/index.ts
// Sends the Daily Ad Spend Report email (Gmail SMTP) as a background job, so
// neither the Vercel caller (10s Hobby cap) nor the caller of *this* function
// ever blocks on Gmail SMTP's own observed 65-160s send time. This function
// never calls back into the Vercel `/api/send-email` route — that route is
// itself Vercel-hosted and would still be capped at 10s regardless of who
// calls it; the actual SMTP send happens here, in Deno, where there is no
// such cap.
//
// Reads only what generate-ad-spend-report (Task 4) already wrote to
// daily_ad_spend_reports (result_json, xlsx_storage_path) — never recomputes
// anything.
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { rejectUnlessInternal } from "../_shared/internalAuth.ts";
import { escapeDeep, escapeHtml } from "../_shared/htmlEscape.ts";
import nodemailer from "npm:nodemailer@9.0.3";
import { SITE_URL } from "../_shared/deps/siteUrl.ts";

// ---------------------------------------------------------------------------
// Verbatim port of src/pages/api/send-email.ts's wrap()/channelBar()/CHANNELS
// (source lines 1-75) and the "adSpendDaily" branch of buildHtml() (source
// lines 912-1102, extracted here as its own buildAdSpendDailyHtml() function;
// subject taken from SUBJECTS.adSpendDaily, source line ~1169). Every inline
// style, threshold and column layout is unchanged from what recipients
// already see today. Only mechanical substitutions applied: the SITE_URL
// import now comes from the Deno-ported ../_shared/deps/siteUrl.ts (used
// identically by generate-ad-spend-report's adSpendReportExport.ts already,
// so this reuses the same source of truth instead of re-hardcoding a second,
// divergent copy) and nodemailer is the npm: specifier form.
// ---------------------------------------------------------------------------

// Every email carries a channel badge in the header naming which marketplace the numbers came
// from, plus a muted "Flipkart · soon" chip beside it. Today everything below is Amazon, and
// nothing in the body says so — once Flipkart data lands, a reader looking back through their
// inbox would have no way to tell which channel an old mail described. Pass `channel` in the
// email data to change the active label; add more entries to CHANNELS as they go live.
const CHANNELS: { key: string; label: string }[] = [
  { key: "amazon", label: "Amazon" },
  { key: "flipkart", label: "Flipkart" },
];

function channelBar(active = "amazon") {
  const chips = CHANNELS.map(({ key, label }) => {
    const live = key === active;
    return `<span style="display:inline-block;padding:3px 11px;border-radius:999px;font-size:11px;font-weight:800;margin-right:6px;${
      live
        ? "background:#ffffff;color:#6D5EF8;"
        : "background:rgba(255,255,255,0.14);color:rgba(255,255,255,0.65);"
    }">${label}${live ? "" : " &#183; soon"}</span>`;
  }).join("");
  return `<p style="margin:10px 0 0;">${chips}</p>`;
}

function wrap(body: string, channel: string | null = "amazon", headExtra = "") {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marketplace360</title>${headExtra}</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(135deg,#6D5EF8 0%,#8B5CF6 100%);padding:28px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td>
                <p style="margin:0;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">&#128640; Marketplace360 Dashboard</p>
                <p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:13px;">${now} IST</p>
                ${channel ? channelBar(channel) : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <!-- Body -->
      <tr><td style="padding:28px 32px;">${body}</td></tr>
      <!-- Footer -->
      <tr>
        <td style="padding:20px 32px;border-top:1px solid #f0f0f0;text-align:center;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by Marketplace360 &nbsp;&#183;&nbsp; <a href="${SITE_URL}/dashboard/settings" style="color:#6D5EF8;text-decoration:none;">Manage alerts</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// deno-lint-ignore no-explicit-any
function buildAdSpendDailyHtml(data: Record<string, any>, _toEmail: string): string {
  // Reproduces the exact table layout of the manual daily mail Aparna has sent by hand
  // (Platform | Ad spend without/with tax | High spending product [Product, price] |
  // <day> Spend/Spend(with tax)/Orders/CPC/ACOS | <range> Spend/Spend(with tax)/Orders/CPC/ACOS |
  // Overall sales QTS/Value), one merged row-group per platform covering its up-to-3
  // top-spend products, rather than the card layout previously used here — so recipients
  // used to Aparna's format see the same shape, not a redesign.
  // data: { dayLabel, rangeLabel, currency, platformSummaries: PlatformEmailSummary[],
  //         productCount, lowSpendCampaignCount }
  const currency = data.currency === "INR" ? "₹" : "$";
  const money = (v: number) => currency + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(v || 0);
  // CPC is shown as a bare number in the manual mail (no currency symbol), unlike Spend/price.
  const num = (v: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(v || 0);
  // null means adSpendReportExport.ts's acosCell hit the "ad spend with zero attributed sales"
  // sentinel — a genuinely undefined ratio, not 0%. Rendered as a dash, not coerced to "0%" by
  // the `v || 0` pattern the other formatters here use (that would misleadingly read as a great,
  // zero-cost result instead of "no signal for this window").
  const acosPct = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)}%`);
  // Same thresholds as the Daily Digest's ACOS badge — colours ACOS so a problem product
  // is scannable without reading every number. No colour for the undefined/null case.
  const acosClass = (v: number | null) => (v == null ? "aspd-lo" : v > 0.5 ? "aspd-hi" : v > 0.25 ? "aspd-mid" : "aspd-lo");
  const clip = (s: string, len = 46) => ((s || "").length > len ? (s || "").slice(0, len) + "…" : s || "");
  // deno-lint-ignore no-explicit-any
  const platforms: any[] = data.platformSummaries || [];
  const PLATFORM_COLOR: Record<string, string> = { Amazon: "#FF9900", Flipkart: "#2874F0", Meesho: "#9F2089" };
  const META_COLOR = "#0E7490";
  const GOOGLE_COLOR = "#34A853";
  const tdDiv = 'class="aspd-td aspd-div"';
  // Price "N/A" when no Selling Price is on file; Sell price = that day's order value ÷ units ("-" with no sale).
  const priceText = (v: number | null | undefined) => (v ? money(v) : "N/A");
  const sellText = (v: number | null | undefined) => (v ? money(v) : "-");
  const adOrdersText = (v: number | null | undefined) => (v == null ? "-" : String(v));

  // Every cell below carries a class instead of a repeated inline style attribute — with
  // Amazon/Flipkart's full per-product tables running 20-40+ rows x 11 columns each, inline
  // styles on every <td> pushed the message past Gmail's ~102KB clip threshold, silently
  // truncating the mail (Flipkart's table — the second big one — got cut off entirely). See
  // the <style> block below (only used by this adSpendDaily template).
  const th = 'class="aspd-th"';
  const td = 'class="aspd-td"';
  const tdName = 'class="aspd-name"';
  const styleBlock = `<style>
      .aspd-th{padding:10px 12px;border:1px solid #000000;background:#f3f4f6;font-size:11px;font-weight:800;color:#111;text-transform:uppercase;text-align:center;vertical-align:middle;white-space:nowrap;}
      .aspd-td{padding:10px 12px;border:1px solid #000000;font-size:12.5px;color:#111;text-align:center;vertical-align:middle;white-space:nowrap;}
      .aspd-name{padding:10px 12px;border:1px solid #000000;font-size:12.5px;color:#111;text-align:left;vertical-align:middle;white-space:normal;}
      .aspd-hi{color:#dc2626;font-weight:800;}
      .aspd-mid{color:#d97706;font-weight:800;}
      .aspd-lo{color:#059669;font-weight:800;}
      .aspd-div{border-left:3px solid #111827 !important;}
    </style>`;

  // Social Media (Meta Ads) isn't a real platform in the data model (see the comment where
  // socialMediaSummary is built in adSpendReportExport.ts), so it's rendered here as one bespoke
  // extra row appended after the real platform rows below — same column shape as a one-product
  // platform block, just built from a differently-shaped object (no topProducts/allProducts list,
  // since there's only ever the one product).
  // Orders/CPC render as "-" (ACOS: see metaAcosCell below): Meta's export has spend only, and borrowing the promoted
  // product's Amazon orders double-credited them to two channels (seller's explicit instruction).
  // One row per promoted product (Meta campaigns grouped by product), the channel's day totals
  // spanning them — same shape as a multi-product platform block.
  const socialMedia = data.socialMediaSummary;
  const socialProducts = socialMedia ? (socialMedia.products?.length ? socialMedia.products : [socialMedia]) : [];
  const socialSpan = socialProducts.length > 1 ? ` rowspan="${socialProducts.length}"` : "";
  // Meta channel ACOS (Spend ÷ Shopify sales from a Meta ad click — see SocialMediaEmailSummary),
  // one cell on the first row spanning the products; "N/A" when unverified. A summary without the
  // field (built before Meta ACOS existed) renders "-" on every row, exactly as before.
  const metaAcosKnown = socialMedia != null && socialMedia.dayAcos !== undefined;
  const metaAcosCell = (v: number | null | undefined, i: number) =>
    !metaAcosKnown
      ? `<td ${td}>-</td>`
      : i === 0
        ? `<td class="aspd-td ${acosClass(v ?? null)}"${socialSpan}>${v == null ? "N/A" : acosPct(v)}</td>`
        : "";
  // Per-product Meta figures (24 Nov 2026, seller's request) — only when the report carries them
  // (productBreakdown, see SocialMediaEmailSummary): each product row gets its own Orders and ACOS
  // (+ its Meta Ad Sales on a small line under the ACOS) and its ad names under the product name.
  // Same columns as before; a report saved without productBreakdown renders exactly as before.
  const metaPerProduct = socialMedia?.productBreakdown === true;
  const subLine = (text: string) => `<br><span style="font-size:11px;font-weight:600;color:#4b5563;">${text}</span>`;
  const metaOrdersCell = (orders: number, sales: number | null | undefined) =>
    `<td ${td}>${!metaPerProduct ? "-" : sales == null ? "N/A" : orders}</td>`;
  const metaProductAcosCell = (v: number | null | undefined, sales: number | null | undefined) =>
    `<td class="aspd-td ${acosClass(v ?? null)}">${v == null ? "N/A" : acosPct(v)}${subLine(`Sales ${sales == null ? "N/A" : money(sales)}`)}</td>`;
  // v3 (25 Nov 2026, seller's request): Product -> Ad name layout inside the same Social Media block,
  // same 16 columns. Per product: a heading row, one row per Meta ad, a product total row; then one
  // grand total row. ACOS = spend ÷ attributed sales (each total from its own summed spend and sales,
  // never an average of ad ACOS), "N/A" when sales are unavailable/unverified; "Sales ₹X" rides under
  // the ACOS (no Sales column in this table). Only for summaries that carry adBreakdown — anything
  // older renders exactly as before. Rows are written without indentation to stay under Gmail's clip.
  // ad/product/grand-total sales sub-line label: "Meta-reported" when the summary uses Meta's own purchase value
  const metaAdSalesLabel = socialMedia?.adSalesSource === "meta_reported" ? "Meta-reported" : "Sales";
  const metaAdLayout = socialMedia?.adBreakdown === true && socialProducts.every((p) => Array.isArray(p.ads) && p.total);
  // A Meta ad / total with no sales has ACOS = Spend ÷ 1 (26 Nov 2026, seller's rule): shown as that
  // amount (277.25), the same as the Excel, not as a percentage (27725%).
  // deno-lint-ignore no-explicit-any
  const adAcosText = (b: any) => (b.acos == null ? "N/A" : b.sales == null || b.sales <= 0 ? new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(b.acos) : acosPct(b.acos));
  // deno-lint-ignore no-explicit-any
  const adCells = (b: any, first: boolean) => `<td ${first ? tdDiv : td}>${money(b.spend)}</td><td ${td}>${money(b.spendTax)}</td><td ${td}>${b.orders == null ? "N/A" : b.orders}</td><td ${td}>${b.orders == null ? "N/A" : b.orders}</td><td ${td}>-</td><td class="aspd-td ${b.acos == null ? "" : acosClass(b.acos)}"${b.acos == null ? ' style="color:#6b7280;font-weight:700;"' : ""}>${adAcosText(b)}${subLine(`${metaAdSalesLabel} ${b.sales == null ? "N/A" : money(b.sales)}`)}</td>`;
  // deno-lint-ignore no-explicit-any
  const metaSell = (b: any) => (b && b.sales > 0 && b.orders > 0 ? money(b.sales / b.orders) : "-");
  // deno-lint-ignore no-explicit-any
  const adRow = (label: string, w: { day: any; range: any }, price: string, strong: boolean) =>
    `<tr${strong ? ' style="font-weight:800;background:#f9fafb;"' : ""}><td ${tdName}>${label}</td><td ${td}>${price}</td><td ${td}>${metaSell(w.day)}</td>${adCells(w.day, false)}${adCells(w.range, true)}</tr>`;
  const metaAdRowCount = metaAdLayout ? socialProducts.reduce((n, p) => n + p.ads.length + 2, 0) + 1 : 0;
  const metaAdLeft = (n: number) => `<td ${td} rowspan="${n}" style="font-weight:800;border-left:3px solid ${META_COLOR};">Social Media (Meta)</td><td ${td} rowspan="${n}">${money(socialMedia.daySpend)}</td><td ${td} rowspan="${n}">${money(socialMedia.daySpendTax)}</td>`;
  const metaAdRight = (n: number) => `<td ${td} rowspan="${n}">-</td><td ${td} rowspan="${n}">-</td>`;
  const metaAdHtml = () => {
    const rows: string[] = [];
    socialProducts.forEach((p) => {
      rows.push(`<tr><td ${tdName} colspan="15" style="font-weight:800;background:#eef2ff;">${p.product}${p.price ? ` &#183; ${money(p.price)}` : ""}</td></tr>`);
      // deno-lint-ignore no-explicit-any
      p.ads.forEach((a: any, j: number) => rows.push(adRow(`Ad ${j + 1}: ${a.name}`, a, "-", false)));
      rows.push(adRow(`Total &#8211; ${clip(p.product)}`, p.total, p.price ? money(p.price) : "-", true));
    });
    if (socialMedia.grandTotal) rows.push(adRow("Grand total &#8211; all Meta products", socialMedia.grandTotal, "-", true));
    else rows.push(`<tr><td ${tdName} colspan="15">-</td></tr>`);
    // The channel cells (left) and Overall sales (right) span every row, as in the other blocks.
    rows[0] = rows[0].replace("<tr>", `<tr>${metaAdLeft(metaAdRowCount)}`).replace(/<\/tr>$/, `${metaAdRight(metaAdRowCount)}</tr>`);
    return rows.join("\n");
  };
  const socialMediaRowHtml = socialMedia && metaAdLayout ? metaAdHtml() : socialMedia
    ? socialProducts.map((p, i) => `
        <tr>
          ${i === 0 ? `<td ${td}${socialSpan} style="font-weight:800;border-left:3px solid ${META_COLOR};">Social Media (Meta)</td>
          <td ${td}${socialSpan}>${money(socialMedia.daySpend)}</td>
          <td ${td}${socialSpan}>${money(socialMedia.daySpendTax)}</td>` : ""}
          <td ${tdName}>${clip(p.product)}${metaPerProduct && p.adNames?.length ? subLine(`Ads: ${p.adNames.join("; ")}`) : ""}</td>
          <td ${td}>${p.price ? money(p.price) : "-"}</td>
          <td ${td}>-</td>
          <td ${td}>${money(p.day.spend)}</td>
          <td ${td}>${money(p.day.spendTax)}</td>
          ${metaOrdersCell(p.day.orders, p.daySales)}
          <td ${td}>-</td>
          <td ${td}>-</td>
          ${metaPerProduct ? metaProductAcosCell(p.day.acos, p.daySales) : metaAcosCell(socialMedia.dayAcos, i)}
          <td ${tdDiv}>${money(p.range.spend)}</td>
          <td ${td}>${money(p.range.spendTax)}</td>
          ${metaOrdersCell(p.range.orders, p.rangeSales)}
          <td ${td}>-</td>
          <td ${td}>-</td>
          ${metaPerProduct ? metaProductAcosCell(p.range.acos, p.rangeSales) : metaAcosCell(socialMedia.rangeAcos, i)}
          ${i === 0 ? `<td ${td}${socialSpan}>-</td>
          <td ${td}${socialSpan}>-</td>` : ""}
        </tr>`).join("")
    : "";

  // Google — same bespoke-extra-row treatment as Social Media above. Ad spend comes from the
  // Google Ads "Campaign report" upload (0 when none is on file for the window); QTS/Value are the
  // reporting day's website orders. Orders/CPC stay "-". ACOS = Spend ÷ the Shopify orders whose
  // visit came from a Google Ads click ("–" when there are none), and ROAS rides in the label cell
  // (see GoogleEmailSummary/the Google Summary row in adSpendReportExport.ts). A summary that isn't
  // `attributed` (a reporting day before the first Shopify day, or one saved before this field
  // existed) renders exactly as the row did before: old label, "-" ACOS cells, no ROAS line.
  const google = data.googleSummary;
  const googleAttributed = google?.attributed === true;
  const roasText = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(2));
  const googleAcosCell = (v: number | null | undefined) =>
    googleAttributed ? `<td class="aspd-td ${acosClass(v ?? null)}">${acosPct(v ?? null)}</td>` : `<td ${td}>-</td>`;
  // deno-lint-ignore no-explicit-any
  const gProducts: any[] = googleAttributed && Array.isArray(google?.products) ? google.products : [];
  // deno-lint-ignore no-explicit-any
  const gTotalCells = (b: any, first: boolean) => `<td ${first ? tdDiv : td}>${money(b.spend)}</td><td ${td}>${money(b.spendTax)}</td><td ${td}>${b.orders}</td><td ${td}>${b.orders}</td><td ${td}>-</td><td class="aspd-td ${b.acos == null ? "" : acosClass(b.acos)}"${b.acos == null ? ' style="color:#6b7280;font-weight:700;"' : ""}>${adAcosText(b)}${subLine(`Sales ${money(b.sales)}`)}</td>`;
  // deno-lint-ignore no-explicit-any
  const gSpendCells = (b: any, first: boolean) => `<td ${first ? tdDiv : td}>${money(b.spend)}</td><td ${td}>${money(b.spendTax)}</td><td ${td}>-</td><td ${td}>-</td><td ${td}>-</td><td ${td}>-</td>`;
  const googleBlockHtml = () => {
    const rows: string[] = [];
    gProducts.forEach((p) => {
      rows.push(`<tr><td ${tdName} colspan="15" style="font-weight:800;background:#ecfdf5;">${p.product}</td></tr>`);
      // deno-lint-ignore no-explicit-any
      p.campaigns.forEach((c: any, j: number) => rows.push(`<tr><td ${tdName}>Ad ${j + 1}: ${c.name}</td><td ${td}>-</td><td ${td}>-</td>${gSpendCells(c.day, false)}${gSpendCells(c.range, true)}</tr>`));
      rows.push(`<tr style="font-weight:800;background:#f9fafb;"><td ${tdName}>Total &#8211; ${clip(p.product)}</td><td ${td}>-</td><td ${td}>${sellText(p.total.day.sellPrice)}</td>${gTotalCells(p.total.day, false)}${gTotalCells(p.total.range, true)}</tr>`);
    });
    const grandDay = { spend: google.daySpend, spendTax: google.daySpendTax, orders: google.totalUnits, acos: google.dayAcos, sales: google.dayAdSales ?? 0 };
    const grandRange = { spend: google.rangeSpend, spendTax: google.rangeSpendTax, orders: google.rangeUnits ?? "-", acos: google.rangeAcos, sales: google.rangeAdSales ?? 0 };
    const grandCells = (b: { spend: number; spendTax: number; orders: number | string; acos: number | null; sales: number }, ad: number | null | undefined, first: boolean) =>
      `<td ${first ? tdDiv : td}>${money(b.spend)}</td><td ${td}>${money(b.spendTax)}</td><td ${td}>${b.orders}</td><td ${td}>${adOrdersText(ad)}</td><td ${td}>-</td><td class="aspd-td ${acosClass(b.acos)}">${acosPct(b.acos)}${subLine(`Ad sales ${money(b.sales)}`)}</td>`;
    rows.push(`<tr style="font-weight:800;background:#f9fafb;"><td ${tdName}>Grand total &#8211; all Google</td><td ${td}>-</td><td ${td}>${google.totalUnits > 0 ? money(google.totalValue / google.totalUnits) : "-"}</td>${grandCells(grandDay, google.dayAdOrders, false)}${grandCells(grandRange, google.rangeAdOrders, true)}</tr>`);
    const n = rows.length;
    rows[0] = rows[0].replace("<tr>", `<tr><td ${td} rowspan="${n}" style="font-weight:800;border-left:3px solid ${GOOGLE_COLOR};">Google</td><td ${td} rowspan="${n}">${money(google.daySpend)}</td><td ${td} rowspan="${n}">${money(google.daySpendTax)}</td>`)
      .replace(/<\/tr>$/, `<td ${td} rowspan="${n}">${google.totalUnits}</td><td ${td} rowspan="${n}">${money(google.totalValue)}</td></tr>`);
    return rows.join("\n");
  };
  const googleRowHtml = google && gProducts.length ? googleBlockHtml() : google
    ? `
        <tr>
          <td ${td} style="font-weight:800;border-left:3px solid ${GOOGLE_COLOR};">Google</td>
          <td ${td}>${money(google.daySpend)}</td>
          <td ${td}>${money(google.daySpendTax)}</td>
          <td ${tdName}>${google.daySpend > 0 || google.rangeSpend > 0 ? (googleAttributed ? "(Google Ads spend + website orders)" : "(Google Ads spend + B-Arm orders)") : "(Orders/Sales only — no Google Ads report for this window)"}${googleAttributed ? `<br>ROAS ${roasText(google.dayRoas)} day · ${roasText(google.rangeRoas)} range` : ""}</td>
          <td ${td}>-</td>
          <td ${td}>-</td>
          <td ${td}>${money(google.daySpend)}</td>
          <td ${td}>${money(google.daySpendTax)}</td>
          <td ${td}>-</td>
          <td ${td}>-</td>
          <td ${td}>-</td>
          ${googleAcosCell(google.dayAcos)}
          <td ${tdDiv}>${money(google.rangeSpend)}</td>
          <td ${td}>${money(google.rangeSpendTax)}</td>
          <td ${td}>-</td>
          <td ${td}>-</td>
          <td ${td}>-</td>
          ${googleAcosCell(google.rangeAcos)}
          <td ${td}>${google.totalUnits}</td>
          <td ${td}>${money(google.totalValue)}</td>
        </tr>`
    : "";

  const platformRows = platforms.map((p) => {
    const products = p.topProducts.length
      ? p.topProducts
      : [{ name: "(no ad spend in range)", price: 0, sellPrice: null, day: { spend: 0, spendTax: 0, orders: 0, cpc: 0, acos: 0, adOrders: null }, range: { spend: 0, spendTax: 0, orders: 0, cpc: 0, acos: 0, adOrders: null } }];
    const n = products.length;
    // deno-lint-ignore no-explicit-any
    return products.map((prod: any, i: number) => `
        <tr>
          ${i === 0 ? `
          <td rowspan="${n}" ${td} style="font-weight:800;border-left:3px solid ${PLATFORM_COLOR[p.platform] || "#111"};">${p.platform}</td>
          <td rowspan="${n}" ${td}>${money(p.daySpend)}</td>
          <td rowspan="${n}" ${td}>${money(p.daySpendTax)}</td>` : ""}
          <td ${tdName}>${clip(prod.name)}</td>
          <td ${td}>${priceText(prod.price)}</td>
          <td ${td}>${sellText(prod.sellPrice)}</td>
          <td ${td}>${money(prod.day.spend)}</td>
          <td ${td}>${money(prod.day.spendTax)}</td>
          <td ${td}>${prod.day.orders}</td>
          <td ${td}>${adOrdersText(prod.day.adOrders)}</td>
          <td ${td}>${num(prod.day.cpc)}</td>
          <td class="aspd-td ${acosClass(prod.day.acos)}">${acosPct(prod.day.acos)}</td>
          <td ${tdDiv}>${money(prod.range.spend)}</td>
          <td ${td}>${money(prod.range.spendTax)}</td>
          <td ${td}>${prod.range.orders}</td>
          <td ${td}>${adOrdersText(prod.range.adOrders)}</td>
          <td ${td}>${num(prod.range.cpc)}</td>
          <td class="aspd-td ${acosClass(prod.range.acos)}">${acosPct(prod.range.acos)}</td>
          ${i === 0 ? `
          <td rowspan="${n}" ${td}>${p.overallDayUnits}</td>
          <td rowspan="${n}" ${td}>${money(p.overallDayValue)}</td>` : ""}
        </tr>`).join("");
  }).join("");

  // No channelBar here: unlike the single-platform templates above (where
  // "Amazon live / Flipkart · soon" is accurate today), this report already
  // covers Amazon + Flipkart + Meesho together, so that badge would flatly
  // contradict the Flipkart/Meesho numbers sitting right below it.
  const incompleteDates: { platform: string; missingDates: string[] }[] = data.incompleteDates || [];
  const incompleteBanner = incompleteDates.length
    ? `<tr><td style="padding-bottom:16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;">
            <tr><td style="padding:12px 14px;">
              <p style="margin:0 0 4px;color:#92400e;font-size:12.5px;font-weight:800;">&#9888; Figures below are understated — some days haven't synced yet</p>
              ${incompleteDates.map((d) => `<p style="margin:0;color:#92400e;font-size:11.5px;font-weight:600;">${d.platform}: no data for ${d.missingDates.join(", ")}</p>`).join("")}
            </td></tr>
          </table>
        </td></tr>`
    : "";
  // Amazon Brand/Display spend the report couldn't attribute (adSpendReportExport.ts's
  // amazonSpendWarnings) — amber like the sync banner: understated, not a quiet ₹0.
  const amazonSpendWarnings: string[] = data.amazonSpendWarnings || [];
  const spendWarningBanner = amazonSpendWarnings.length
    ? `<tr><td style="padding-bottom:16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;">
            <tr><td style="padding:12px 14px;">
              <p style="margin:0 0 4px;color:#92400e;font-size:12.5px;font-weight:800;">&#9888; Amazon spend below is understated — some Brand/Display spend isn't attributed to any product</p>
              ${amazonSpendWarnings.map((w) => `<p style="margin:0;color:#92400e;font-size:11.5px;font-weight:600;">${w}</p>`).join("")}
            </td></tr>
          </table>
        </td></tr>`
    : "";
  // A Meesho table that failed to load (see adSpendReportExport.ts's dataLoadErrors) — red, not
  // amber: those figures are missing, not just late, and must not read as a quiet day.
  const dataLoadErrors: { platform: string; error: string }[] = data.dataLoadErrors || [];
  const loadErrorBanner = dataLoadErrors.length
    ? `<tr><td style="padding-bottom:16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fee2e2;border:1px solid #dc2626;border-radius:10px;">
            <tr><td style="padding:12px 14px;">
              <p style="margin:0 0 4px;color:#991b1b;font-size:12.5px;font-weight:800;">&#9888; Some data could not be loaded — these figures are missing, not zero</p>
              ${dataLoadErrors.map((d) => `<p style="margin:0;color:#991b1b;font-size:11.5px;font-weight:600;">${d.platform}: ${d.error}</p>`).join("")}
            </td></tr>
          </table>
        </td></tr>`
    : "";

  // Full per-product breakdown for Amazon and Flipkart specifically — matching the manual
  // mail's separate "Here is the Amazon/Flipkart platform's ad spend report" tables, which
  // list every advertised product (not just the top-3 shortlist above). The manual mail never
  // included a matching table for Meesho, so this intentionally only covers those two.
  const fullTables = ["Amazon", "Flipkart"].map((name) => {
    const p = platforms.find((pl) => pl.platform === name);
    // deno-lint-ignore no-explicit-any
    const items: any[] = p?.allProducts || [];
    if (!items.length) return "";
    const rowsHtml = items.map((prod) => `
        <tr>
          <td ${tdName}>${clip(prod.name)}</td>
          <td ${td}>${priceText(prod.price)}</td>
          <td ${td}>${sellText(prod.sellPrice)}</td>
          <td ${td}>${money(prod.day.spend)}</td>
          <td ${td}>${money(prod.day.spendTax)}</td>
          <td ${td}>${prod.day.orders}</td>
          <td ${td}>${adOrdersText(prod.day.adOrders)}</td>
          <td ${td}>${num(prod.day.cpc)}</td>
          <td class="aspd-td ${acosClass(prod.day.acos)}">${acosPct(prod.day.acos)}</td>
          <td ${tdDiv}>${money(prod.range.spend)}</td>
          <td ${td}>${money(prod.range.spendTax)}</td>
          <td ${td}>${prod.range.orders}</td>
          <td ${td}>${adOrdersText(prod.range.adOrders)}</td>
          <td ${td}>${num(prod.range.cpc)}</td>
          <td class="aspd-td ${acosClass(prod.range.acos)}">${acosPct(prod.range.acos)}</td>
        </tr>`).join("");
    return `
        <tr><td style="padding-top:22px;padding-bottom:6px;">
          <p style="margin:0;font-size:13px;font-weight:700;color:#111;">Here is the ${name} platform's ad spend report.</p>
        </td></tr>
        <tr><td style="padding-top:6px;">
          <div style="overflow-x:auto;">
          <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;min-width:1100px;">
            <thead>
              <tr>
                <th rowspan="2" ${th}>Product Name</th>
                <th rowspan="2" ${th}>Price</th>
                <th rowspan="2" ${th}>Sell price</th>
                <th colspan="6" ${th}>${data.dayLabel || "Day"}</th>
                <th colspan="6" class="aspd-th aspd-div">${data.rangeLabel || "Range"}</th>
              </tr>
              <tr>
                <th ${th}>Spend</th>
                <th ${th}>Spend(with tax)</th>
                <th ${th}>Orders</th>
                <th ${th}>Ad orders</th>
                <th ${th}>CPC</th>
                <th ${th}>ACOS</th>
                <th class="aspd-th aspd-div">Spend</th>
                <th ${th}>Spend(with tax)</th>
                <th ${th}>Orders</th>
                <th ${th}>Ad orders</th>
                <th ${th}>CPC</th>
                <th ${th}>ACOS</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          </div>
        </td></tr>`;
  }).join("");

  return wrap(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:14px;">
          <h2 style="margin:0;color:#111;font-size:20px;font-weight:800;">&#128200; Daily Ad Spend Report</h2>
          <p style="margin:10px 0 0;color:#374151;font-size:13px;line-height:1.7;">
            Hi Team,<br/><br/>
            Below is the Ad spend report for all platforms. The table shows platform-wise ad spend including each platform's top spending products with their past 7 days ACOS, so you can see which products were promoted. The Ad Status Report, Action Sheet (products over 14% 7-day ACOS with a recommended action) and Low Spend Campaigns list are in the attached workbook.<br/><br/>
            Here is the summary of the ad spend report.
          </p>
        </td></tr>
        ${loadErrorBanner}
        ${incompleteBanner}
        ${spendWarningBanner}
        <tr><td style="padding-top:6px;">
          <div style="overflow-x:auto;">
          <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;min-width:1300px;">
            <thead>
              <tr>
                <th rowspan="2" ${th}>Platform</th>
                <th rowspan="2" ${th}>Ad spend<br/>(without tax)</th>
                <th rowspan="2" ${th}>Ad spend<br/>(with tax)</th>
                <th colspan="3" ${th}>High spending product</th>
                <th colspan="6" ${th}>${data.dayLabel || "Day"}</th>
                <th colspan="6" class="aspd-th aspd-div">${data.rangeLabel || "Range"}</th>
                <th colspan="2" ${th}>Overall sales</th>
              </tr>
              <tr>
                <th ${th}>Product</th>
                <th ${th}>Price</th>
                <th ${th}>Sell price</th>
                <th ${th}>Spend</th>
                <th ${th}>Spend(with tax)</th>
                <th ${th}>Orders</th>
                <th ${th}>Ad orders</th>
                <th ${th}>CPC</th>
                <th ${th}>ACOS</th>
                <th class="aspd-th aspd-div">Spend</th>
                <th ${th}>Spend(with tax)</th>
                <th ${th}>Orders</th>
                <th ${th}>Ad orders</th>
                <th ${th}>CPC</th>
                <th ${th}>ACOS</th>
                <th ${th}>QTS</th>
                <th ${th}>Value</th>
              </tr>
            </thead>
            <tbody>${platformRows}${socialMediaRowHtml}${googleRowHtml}</tbody>
          </table>
          </div>
        </td></tr>
        ${fullTables}
        <tr><td>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:11px;line-height:1.6;">
            ${data.productCount || 0} advertised products across platforms${data.lowSpendCampaignCount ? ` &#183; ${data.lowSpendCampaignCount} low-spend campaigns flagged` : ""}.
            Full per-product breakdown, Ad Status Report, Action Sheet and Low Spend Campaigns are in the attached workbook.
          </p>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${SITE_URL}/dashboard/reports" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Reports &#8594;</a>
        </td></tr>
      </table>`, null, styleBlock)
    // Whitespace between tags only (indentation of the row templates): keeps the mail under Gmail's
    // ~102 KB clip limit now that every row has more columns. Rendering is unchanged.
    .replace(/>\s+</g, "><")
    // Short class names in the finished mail (CSS and cells together, so the look is unchanged).
    .replace(/aspd-(name|div|mid|th|td|hi|lo)\b/g, (_m, k: string) => ({ name: "an", div: "av", mid: "am", th: "ah", td: "at", hi: "ax", lo: "al" } as Record<string, string>)[k]);
}
// --- end verbatim port ---

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: Deno.env.get("SMTP_FROM"), pass: Deno.env.get("SMTP_PASS") },
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  // Only the Vercel API routes and the pg_cron job hold INTERNAL_API_SECRET (see _shared/internalAuth.ts).
  const rejected = await rejectUnlessInternal(req);
  if (rejected) return rejected;
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
    try {
      const { error: statusError } = await supabase.from("report_generation_jobs").update({
        email_status: "sending", updated_at: new Date().toISOString(),
      }).eq("id", job_id);
      if (statusError) throw new Error(`Failed to mark email as sending: ${statusError.message}`);

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
        platformTotals: unknown; platformSummaries: unknown; socialMediaSummary: unknown; googleSummary: unknown; lowSpendCampaignCount: number;
        incompleteDates: unknown;
        dataLoadErrors?: unknown;
        amazonSpendWarnings?: unknown;
      };
      // dmy(): 'YYYY-MM-DD' -> 'DD-MM-YYYY' — same as adSpendReportExport.ts's
      // dotDate/send-ad-spend-email.ts's dmy, ported identically.
      const dmy = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}-${m}-${y}`; };
      const dayLabel = dmy(result.endDate);
      const rangeLabel = `${dmy(result.rangeStart)} to ${dmy(result.endDate)}`;

      // buildAdSpendDailyHtml(): the ported adSpendDaily branch body from
      // send-email.ts, called with the same `data` shape send-ad-spend-email.ts
      // already builds today.
      // Escaped like send-email.ts: every interpolated value is text, never markup.
      const html = buildAdSpendDailyHtml(escapeDeep({
        dayLabel, rangeLabel, currency: "INR",
        platformSummaries: result.platformSummaries,
        socialMediaSummary: result.socialMediaSummary,
        googleSummary: result.googleSummary,
        productCount: result.productCount,
        lowSpendCampaignCount: result.lowSpendCampaignCount,
        incompleteDates: result.incompleteDates,
        dataLoadErrors: result.dataLoadErrors,
        amazonSpendWarnings: result.amazonSpendWarnings,
      }), escapeHtml(to));

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
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(run());
  } else {
    // `supabase functions serve` (local dev) has no EdgeRuntime global — fire
    // without awaiting so the HTTP response still returns immediately.
    run();
  }

  return jsonResponse({ accepted: true, job_id, status: "sending" });
});
