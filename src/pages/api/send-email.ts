import type { NextApiRequest, NextApiResponse } from "next";
import nodemailer from "nodemailer";
import { SITE_URL } from "@/lib/siteUrl";

// Reverted from Resend back to Gmail SMTP by the seller's own request: Resend needs a verified
// domain to send to real recipients (sandboxed to the signup email otherwise), and while that
// verification is pending, sending to the actual team list is what matters — even though Gmail
// SMTP is slow (65-70+ seconds observed from serverless), it works today with zero setup. Revisit
// Resend once a domain is verified there — see git history around 2026-09-08 for that version.
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_FROM,
    pass: process.env.SMTP_PASS,
  },
});

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

function buildHtml(type: string, data: Record<string, any>, toEmail: string): string {
  // Every template below renders through this so the header's channel badge follows the data.
  const w = (body: string) => wrap(body, data.channel || "amazon");
  // Raw-HTML passthrough for callers that already built their own body (e.g. the monthly
  // placeholder in cron/scheduled-reports.ts) rather than needing a named template here.
  if (type === "custom") return w(data.html || "");
  if (type === "test") {
    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" style="padding:8px 0 24px;">
            <table cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;">
              <tr><td align="center" style="padding:24px 32px;">
                <p style="margin:0;font-size:40px;line-height:1;">&#9989;</p>
                <h2 style="margin:12px 0 6px;color:#166534;font-size:20px;font-weight:800;">Email Connected!</h2>
                <p style="margin:0;color:#15803d;font-size:14px;font-weight:600;">Your Marketplace360 alerts are now active.</p>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td>
            <table width="100%" cellpadding="12" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:10px;margin-bottom:20px;">
              <tr style="border-bottom:1px solid #f0f0f0;">
                <td width="80" style="color:#6b7280;font-size:13px;font-weight:700;border-bottom:1px solid #f0f0f0;">FROM</td>
                <td style="color:#111;font-size:13px;font-weight:800;border-bottom:1px solid #f0f0f0;">${process.env.SMTP_FROM}</td>
              </tr>
              <tr>
                <td style="color:#6b7280;font-size:13px;font-weight:700;">TO</td>
                <td style="color:#111;font-size:13px;font-weight:800;">${toEmail}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding-top:8px;">
            <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7;">
              You will receive alerts for:<br>
              &#9642; <strong>Inventory warnings</strong> (low stock / stockout risk)<br>
              &#9642; <strong>High ACOS campaigns</strong> (above your threshold)<br>
              &#9642; <strong>Daily &amp; weekly performance reports</strong>
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding-top:28px;">
            <a href="${SITE_URL}/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
          </td>
        </tr>
      </table>`);
  }

  if (type === "confirmation") {
    const activeAlerts: string[] = data.activeAlerts || [];
    const rows = activeAlerts.map((label: string) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:700;color:#111;">&#9989; ${label}</td>
      </tr>`).join("") || `
      <tr><td style="padding:10px 12px;font-size:13px;font-weight:600;color:#6b7280;">No alert types are enabled yet — turn some on in Settings.</td></tr>`;

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" style="padding:8px 0 24px;">
            <table cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;">
              <tr><td align="center" style="padding:24px 32px;">
                <p style="margin:0;font-size:40px;line-height:1;">&#128276;</p>
                <h2 style="margin:12px 0 6px;color:#166534;font-size:20px;font-weight:800;">Alert Settings Saved &amp; Active</h2>
                <p style="margin:0;color:#15803d;font-size:14px;font-weight:600;">Your Marketplace360 notification preferences are live.</p>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td>
            <table width="100%" cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#f0f0f0;border-radius:10px;margin-bottom:20px;">
              <tbody>${rows}</tbody>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding-top:4px;">
            <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7;">
              ${data.acosThreshold != null ? `&#9642; ACOS alert threshold: <strong>${data.acosThreshold}%</strong><br>` : ""}
              ${data.lowStockThreshold != null ? `&#9642; Low stock alert threshold: <strong>${data.lowStockThreshold} units</strong><br>` : ""}
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding-top:24px;">
            <a href="${SITE_URL}/dashboard/settings" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Manage Alert Settings &#8594;</a>
          </td>
        </tr>
      </table>`);
  }

  if (type === "adAlert") {
    // Generic titled-table alert. data: { emoji, title, subtitle, headerBg,
    // headerBorder, headerColor, columns:[{label,align}], rows:[[cell,...]],
    // ctaText, ctaUrl }. Cells may be strings or { text, color, bold, badge }.
    const cols: any[] = data.columns || [];
    const rows: any[][] = data.rows || [];
    const th = cols.map((c) => `<th style="padding:10px;text-align:${c.align || "left"};font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;">${c.label}</th>`).join("");
    const trs = rows.map((row) => `<tr>${row.map((cell: any, i: number) => {
      const c = typeof cell === "object" && cell !== null ? cell : { text: cell };
      const align = cols[i]?.align || "left";
      const inner = c.badge
        ? `<span style="background:${c.badgeBg || "#fee2e2"};color:${c.color || "#991b1b"};padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;white-space:nowrap;">${c.text}</span>`
        : `<span style="color:${c.color || "#111"};font-weight:${c.bold ? 800 : 600};">${c.text}</span>`;
      return `<td style="padding:11px 10px;border-bottom:1px solid #f0f0f0;font-size:12.5px;text-align:${align};">${inner}</td>`;
    }).join("")}</tr>`).join("");

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:20px;">
          <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:${data.headerBg || "#fef2f2"};border:1px solid ${data.headerBorder || "#fecaca"};border-radius:12px;">
            <tr><td>
              <p style="margin:0;font-size:24px;">${data.emoji || "&#128680;"}</p>
              <h2 style="margin:8px 0 4px;color:${data.headerColor || "#991b1b"};font-size:17px;font-weight:800;">${data.title || "Alert"}</h2>
              <p style="margin:0;color:${data.headerColor || "#b91c1c"};font-size:13px;font-weight:600;">${data.subtitle || ""}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#f0f0f0;">
            <thead><tr style="background:#f9fafb;">${th}</tr></thead>
            <tbody>${trs}</tbody>
          </table>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${data.ctaUrl || `${SITE_URL}/dashboard`}" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">${data.ctaText || "Open Dashboard"} &#8594;</a>
        </td></tr>
      </table>`);
  }

  if (type === "stockout") {
    const items: any[] = data.items || [];
    const currency = data.currency === "INR" ? "₹" : "$";
    const totalWasted = items.reduce((a: number, i: any) => a + (i.spend || 0), 0);
    const fmtMoney = (v: number) => currency + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const cards = items.map((item: any) => {
      const campaigns = (item.campaigns || []) as { name: string; spend: number }[];
      const campRows = campaigns.map((c) => `
        <tr>
          <td style="padding:4px 0;font-size:12px;color:#374151;font-weight:600;">&#9642; ${c.name}</td>
          <td align="right" style="padding:4px 0;font-size:12px;color:#dc2626;font-weight:800;white-space:nowrap;">${fmtMoney(c.spend)}</td>
        </tr>`).join("");
      return `
      <tr>
        <td style="padding:0 0 16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #fecaca;border-radius:14px;overflow:hidden;">
            <tr>
              <td width="88" valign="top" style="padding:14px;">
                <img src="${item.image || ""}" width="72" height="72" alt="" style="width:72px;height:72px;border-radius:10px;object-fit:cover;border:1px solid #f0f0f0;display:block;" />
              </td>
              <td valign="top" style="padding:14px 14px 14px 0;">
                <p style="margin:0 0 4px;font-size:13px;font-weight:800;color:#111;line-height:1.3;">${item.name}</p>
                <p style="margin:0 0 8px;font-size:11px;color:#6b7280;font-weight:600;">SKU: ${item.sku} &nbsp;&#183;&nbsp; ASIN: ${item.asin}</p>
                <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
                  <tr>
                    <td style="padding-right:8px;">
                      <span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;">${item.units === 0 ? "OUT OF STOCK" : item.units + " units left"}</span>
                    </td>
                    <td>
                      <span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;">${fmtMoney(item.spend)} ad spend (7d)</span>
                    </td>
                  </tr>
                </table>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px dashed #f0d0d0;margin-top:4px;">
                  <tr><td colspan="2" style="padding:6px 0 2px;font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;">Campaigns to pause</td></tr>
                  ${campRows}
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
    }).join("");

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:20px;">
          <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;">
            <tr><td>
              <p style="margin:0;font-size:24px;">&#128184;</p>
              <h2 style="margin:8px 0 4px;color:#991b1b;font-size:17px;font-weight:800;">Ad Spend on Out-of-Stock Products</h2>
              <p style="margin:0;color:#b91c1c;font-size:13px;font-weight:600;">${items.length} product${items.length > 1 ? "s" : ""} still being advertised while out of stock &mdash; wasting ${fmtMoney(totalWasted)} in the last 7 days. Pause these campaigns.</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">${cards}</table>
        </td></tr>
        <tr><td align="center" style="padding-top:8px;">
          <a href="${SITE_URL}/dashboard/campaigns" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Manage Campaigns &#8594;</a>
        </td></tr>
      </table>`);
  }

  if (type === "inventory") {
    const items: any[] = data.items || [];
    const rows = items.map((item: any) => `
      <tr>
        <td style="padding:12px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:700;color:#111;">${item.name}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#6b7280;font-weight:600;">${item.sku}</td>
        <td align="center" style="padding:12px 10px;border-bottom:1px solid #f0f0f0;">
          <span style="background:${item.units <= 5 ? "#fee2e2" : "#fef3c7"};color:${item.units <= 5 ? "#991b1b" : "#92400e"};padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;">${item.units} units</span>
        </td>
        <td style="padding:12px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;font-weight:700;color:${item.days <= 7 ? "#dc2626" : "#d97706"};">${item.days} days left</td>
      </tr>`).join("");

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:20px;">
          <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;">
            <tr>
              <td>
                <p style="margin:0;font-size:24px;">&#9888;&#65039;</p>
                <h2 style="margin:8px 0 4px;color:#9a3412;font-size:17px;font-weight:800;">Low Inventory Alert</h2>
                <p style="margin:0;color:#c2410c;font-size:13px;font-weight:600;">${items.length} product${items.length > 1 ? "s" : ""} running low — action needed!</p>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#f0f0f0;border-radius:10px;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:10px 10px;text-align:left;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Product</th>
                <th style="padding:10px 10px;text-align:left;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">SKU</th>
                <th style="padding:10px 10px;text-align:center;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">Stock</th>
                <th style="padding:10px 10px;text-align:left;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">Days Left</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${SITE_URL}/dashboard/inventory" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">View Inventory &#8594;</a>
        </td></tr>
      </table>`);
  }

  if (type === "campaign") {
    const campaigns: any[] = data.campaigns || [];

    // Ad-group breakdown (SP Advertised Product only — SB/SD exports carry
    // no ad-group column) rendered as an indented sub-table directly under
    // its campaign's row, so the reader sees exactly which ad group/SKU
    // inside the flagged campaign is driving the spend. `bottomBorder`
    // controls whether this is the last block for the campaign (no
    // per-campaign suggestion followed it) or one is still coming after.
    const adGroupBreakdown = (c: any, bottomBorder: boolean) => {
      if (!c.adGroups?.length) return "";
      const agRows = c.adGroups
        .map(
          (ag: any) => `
            <tr>
              <td style="padding:6px 8px;font-size:12px;color:#374151;">${ag.adGroupName}${ag.topSkus?.length ? ` <span style="color:#9ca3af;">(${ag.topSkus.join(", ")})</span>` : ""}</td>
              <td align="center" style="padding:6px 8px;font-size:12px;font-weight:700;color:#991b1b;">${ag.acos}%</td>
              <td align="right" style="padding:6px 8px;font-size:12px;color:#059669;">&#8377;${ag.sales}</td>
              <td align="right" style="padding:6px 8px;font-size:12px;color:#dc2626;">&#8377;${ag.spend}</td>
              <td align="center" style="padding:6px 8px;font-size:12px;color:#6b7280;">${ag.orders}</td>
              <td align="center" style="padding:6px 8px;font-size:12px;color:#6b7280;">${ag.ctr}%</td>
              <td align="right" style="padding:6px 8px;font-size:12px;color:#6b7280;">&#8377;${ag.cpc}</td>
            </tr>`
        )
        .join("");
      return `
      <tr><td colspan="5" style="padding:0 10px 14px;${bottomBorder ? "border-bottom:1px solid #f0f0f0;" : ""}">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa;border-radius:8px;">
          <thead>
            <tr>
              <th align="left" style="padding:6px 8px;font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;">Ad Group (top SKU)</th>
              <th style="padding:6px 8px;font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;">ACOS</th>
              <th align="right" style="padding:6px 8px;font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;">Sales</th>
              <th align="right" style="padding:6px 8px;font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;">Spend</th>
              <th style="padding:6px 8px;font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;">Orders</th>
              <th style="padding:6px 8px;font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;">CTR</th>
              <th align="right" style="padding:6px 8px;font-size:10px;font-weight:800;color:#9ca3af;text-transform:uppercase;">CPC</th>
            </tr>
          </thead>
          <tbody>${agRows}</tbody>
        </table>
      </td></tr>`;
    };

    // This campaign's own suggestion (not a shared paragraph across all
    // flagged campaigns) — always the last block for the campaign, so it
    // always carries the row-group's bottom border.
    const campaignSuggestion = (text?: string) => {
      if (!text) return "";
      return `
      <tr><td colspan="5" style="padding:0 10px 16px;border-bottom:1px solid #f0f0f0;">
        <table width="100%" cellpadding="12" cellspacing="0" border="0" style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;">
          <tr><td>
            <p style="margin:0 0 4px;color:#5b21b6;font-size:11px;font-weight:800;text-transform:uppercase;">&#10024; AI Suggestion for this campaign</p>
            <p style="margin:0;font-size:13px;color:#374151;font-weight:500;line-height:1.5;">${text}</p>
          </td></tr>
        </table>
      </td></tr>`;
    };

    const rows = campaigns
      .map((c: any) => {
        const suggestionHtml = campaignSuggestion(c.suggestion);
        const adGroupHtml = adGroupBreakdown(c, !suggestionHtml);
        const mainRowNeedsBorder = !adGroupHtml && !suggestionHtml;
        const border = mainRowNeedsBorder ? "border-bottom:1px solid #f0f0f0;" : "";
        return `
      <tr>
        <td style="padding:12px 10px;${border}font-size:13px;font-weight:700;color:#111;">${c.name}</td>
        <td align="center" style="padding:12px 10px;${border}">
          <span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;">${c.acos}%</span>
        </td>
        <td style="padding:12px 10px;${border}font-size:13px;font-weight:700;color:#059669;">&#8377;${c.sales}</td>
        <td style="padding:12px 10px;${border}font-size:13px;font-weight:700;color:#dc2626;">&#8377;${c.spend}</td>
        <td style="padding:12px 10px;${border}font-size:13px;font-weight:700;color:#6b7280;">${c.roas}x</td>
      </tr>${adGroupHtml}${suggestionHtml}`;
      })
      .join("");

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:20px;">
          <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;">
            <tr><td>
              <p style="margin:0;font-size:24px;">&#128680;</p>
              <h2 style="margin:8px 0 4px;color:#991b1b;font-size:17px;font-weight:800;">High ACOS Campaign Alert</h2>
              <p style="margin:0;color:#b91c1c;font-size:13px;font-weight:600;">${campaigns.length} campaign${campaigns.length > 1 ? "s" : ""} exceeding your ACOS threshold</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#f0f0f0;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:10px;text-align:left;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">Campaign</th>
                <th style="padding:10px;text-align:center;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">ACOS</th>
                <th style="padding:10px;text-align:left;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">Sales</th>
                <th style="padding:10px;text-align:left;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">Spend</th>
                <th style="padding:10px;text-align:left;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">ROAS</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${SITE_URL}/dashboard/campaigns" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">View Campaigns &#8594;</a>
        </td></tr>
      </table>`);
  }

  if (type === "campaignPause") {
    const transitions: any[] = data.transitions || [];
    const rows = transitions.map((t: any) => `
      <tr>
        <td style="padding:12px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:700;color:#111;">${t.campaignName}</td>
        <td align="center" style="padding:12px 10px;border-bottom:1px solid #f0f0f0;">
          <span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;">${t.previousState} &#8594; ${t.newState}</span>
        </td>
      </tr>`).join("");

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:20px;">
          <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;">
            <tr><td>
              <p style="margin:0;font-size:24px;">&#9208;</p>
              <h2 style="margin:8px 0 4px;color:#991b1b;font-size:17px;font-weight:800;">Campaign${transitions.length > 1 ? "s" : ""} Paused</h2>
              <p style="margin:0;color:#b91c1c;font-size:13px;font-weight:600;">${transitions.length} campaign${transitions.length > 1 ? "s" : ""} stopped running since the last check (within the last 30 min)</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#f0f0f0;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:10px;text-align:left;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">Campaign</th>
                <th style="padding:10px;text-align:center;font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;">State change</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${SITE_URL}/dashboard/campaigns" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">View Campaigns &#8594;</a>
        </td></tr>
      </table>`);
  }

  if (type === "weeklyReport") {
    const currency = data.currency === "INR" ? "₹" : "$";
    const money = (v: number) => currency + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const clip = (s: string, len = 32) => (s || "").length > len ? (s || "").slice(0, len) + "…" : (s || "");

    // Δ pill: green when the movement is "good" (up for sales, down for returns/ACOS)
    const delta = (pct: number, goodUp = true) => {
      if (pct == null || !isFinite(pct)) return `<span style="color:#9ca3af;font-weight:700;">—</span>`;
      const up = pct >= 0;
      const good = goodUp ? up : !up;
      const arrow = up ? "&#9650;" : "&#9660;";
      const color = pct === 0 ? "#6b7280" : good ? "#059669" : "#dc2626";
      return `<span style="color:${color};font-weight:800;">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
    };

    const cmpRows = (data.compare || []).map((r: any) => `
      <tr>
        <td style="padding:10px;border-top:1px solid #f5f5f5;font-size:12.5px;font-weight:700;color:#111;">${r.label}</td>
        <td style="padding:10px;border-top:1px solid #f5f5f5;font-size:12.5px;color:#6b7280;text-align:right;">${r.lastStr}</td>
        <td style="padding:10px;border-top:1px solid #f5f5f5;font-size:12.5px;font-weight:800;color:#111;text-align:right;">${r.thisStr}</td>
        <td style="padding:10px;border-top:1px solid #f5f5f5;font-size:12.5px;text-align:right;">${delta(r.deltaPct, r.goodUp !== false)}</td>
      </tr>`).join("");

    const moverRows = (arr: any[], goodUp: boolean) => (arr || []).map((p: any, i: number) => `
      <tr>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;font-weight:700;color:#111;"><span style="color:#9ca3af;font-weight:800;font-size:11px;">${i + 1}.</span> ${clip(p.name)}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;color:#6b7280;text-align:right;">${money(p.last)}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;font-weight:800;color:#111;text-align:right;">${money(p.this)}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;text-align:right;">${delta(p.deltaPct, goodUp)}</td>
      </tr>`).join("");

    const moverTable = (emoji: string, title: string, arr: any[], goodUp: boolean, note: string) => `
      <tr><td style="padding:22px 0 8px;"><h3 style="margin:0;font-size:14px;font-weight:800;color:#111;">${emoji} ${title}</h3>
        <p style="margin:3px 0 0;font-size:11px;color:#9ca3af;font-weight:600;">${note}</p></td></tr>
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;">
          <thead><tr style="background:#f9fafb;">
            <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Product</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Last Wk</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">This Wk</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Change</th>
          </tr></thead>
          <tbody>${moverRows(arr, goodUp) || `<tr><td colspan="4" style="padding:12px;font-size:12px;color:#9ca3af;">No data</td></tr>`}</tbody>
        </table>
      </td></tr>`;

    const platforms: any[] = data.platforms || [];
    const platformTotal = platforms.reduce((a: number, p: any) => a + (p.sales || 0), 0);
    const platformLine = platforms.length
      ? `${platforms.map((p: any) => `<strong style="color:#111;">${p.name}</strong> ${money(p.sales)}`).join(" &nbsp;&#183;&nbsp; ")} &nbsp;&rarr;&nbsp; <strong style="color:#059669;">Total ${money(platformTotal)}</strong>`
      : "";

    const departments: any[] = data.departments || [];
    const deptTotal = departments.reduce((a: number, d: any) => a + (d.sales || 0), 0);
    const deptRows = departments.map((d: any) => `
      <tr>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;font-weight:700;color:#111;">${d.name}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;color:#6b7280;text-align:right;">${money(d.lastSales || 0)}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;color:#111;font-weight:800;text-align:right;">${money(d.sales)}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;text-align:right;">${delta(d.deltaPct, true)}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;color:#6b7280;text-align:right;">${d.units}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;color:#6b7280;text-align:right;">${deptTotal ? ((d.sales / deptTotal) * 100).toFixed(1) : "0.0"}%</td>
      </tr>`).join("");

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:6px;">
          <h2 style="margin:0;color:#111;font-size:20px;font-weight:800;">&#128200; Weekly Performance Report</h2>
          <p style="margin:4px 0 0;color:#6b7280;font-size:12px;font-weight:600;">This week <strong style="color:#374151;">${data.thisLabel || ""}</strong> vs last week <strong style="color:#374151;">${data.lastLabel || ""}</strong> &nbsp;&#183;&nbsp; ${data.accountName || "B-ARM"}</p>
        </td></tr>

        ${platformLine ? `
        <tr><td style="padding-top:14px;">
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background:#f5f3ff;border:1px solid #e9e5ff;border-radius:10px;">
            <tr><td>
              <p style="margin:0 0 4px;font-size:10px;font-weight:800;color:#6D5EF8;text-transform:uppercase;letter-spacing:0.05em;">Platform Sales (this week)</p>
              <p style="margin:0;font-size:13px;">${platformLine}</p>
            </td></tr>
          </table>
        </td></tr>` : ""}

        ${departments.length ? `
        <tr><td style="padding-top:16px;">
          <h3 style="margin:0 0 8px;font-size:14px;font-weight:800;color:#111;">&#127973; Department Breakup</h3>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;">
            <thead><tr style="background:#f9fafb;">
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Department</th>
              <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Last Wk</th>
              <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">This Wk</th>
              <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Change</th>
              <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Units</th>
              <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Share</th>
            </tr></thead>
            <tbody>${deptRows}</tbody>
          </table>
        </td></tr>` : ""}

        <tr><td style="padding-top:14px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;">
            <thead><tr style="background:#f9fafb;">
              <th style="padding:9px 10px;text-align:left;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Metric</th>
              <th style="padding:9px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Last Week</th>
              <th style="padding:9px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">This Week</th>
              <th style="padding:9px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Change</th>
            </tr></thead>
            <tbody>${cmpRows}</tbody>
          </table>
        </td></tr>

        ${moverTable("&#127942;", "Top 5 Best Sellers (by sales)", data.bestSellers, true, "Highest-selling products this week, with last week for comparison.")}
        ${moverTable("&#128200;", "Top Gainers (sales up)", data.gainers, true, "Products growing week-over-week — double down here.")}
        ${moverTable("&#128201;", "Top Decliners (sales down)", data.losers, false, "Products dropping week-over-week — check stock, bids & ranking.")}

        <tr><td align="center" style="padding-top:28px;">
          <a href="${SITE_URL}/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
        </td></tr>
      </table>`);
  }

  // One combined morning email replacing the four that used to arrive separately: the daily
  // performance report, out-of-stock ad spend, bleeding campaigns and wasted search terms.
  // Ordered for a reader who has two minutes — money at risk first, then what to do about it,
  // then how the day actually went. Sections with nothing to report collapse to a single
  // "all clear" line rather than an empty table, so the length tracks the number of problems.
  if (type === "dailyDigest") {
    const currency = data.currency === "INR" ? "₹" : "$";
    const money = (v: number) => currency + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const n = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
    const clip = (s: string, len = 40) => ((s || "").length > len ? (s || "").slice(0, len) + "…" : s || "");
    const m = data.metrics || {};
    const inv = data.inventory || {};
    const dl = data.deltas || {};
    // A bare "Total Sales ₹1,70,815" doesn't say whether that's a good day — the trend arrow
    // against yesterday does. Omitted (not "0%") when the prior day has no comparable data.
    const trend = (v: number | undefined) => {
      if (v == null || !isFinite(v)) return "";
      const up = v >= 0;
      const arrow = up ? "&#9650;" : "&#9660;";
      const color = Math.abs(v) < 0.01 ? "#6b7280" : up ? "#059669" : "#dc2626";
      return ` <span style="color:${color};font-size:11px;font-weight:800;">${arrow}${Math.abs(v * 100).toFixed(0)}%</span>`;
    };

    const stockoutItems: any[] = data.stockoutItems || [];
    const bleedingItems: any[] = data.bleedingItems || [];
    const wastedTerms: any[] = data.wastedTerms || [];
    const atRisk =
      stockoutItems.reduce((a, i) => a + (i.spend || 0), 0) +
      bleedingItems.reduce((a, i) => a + (i.spend || 0), 0) +
      wastedTerms.reduce((a, i) => a + (i.spend || 0), 0);

    const kpi = (label: string, val: string, bg: string, color: string) => `
      <td width="33%" style="padding:4px;">
        <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background:${bg};border-radius:12px;">
          <tr><td>
            <p style="margin:0;color:#6b7280;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;">${label}</p>
            <p style="margin:5px 0 0;color:${color};font-size:20px;font-weight:900;">${val}</p>
          </td></tr>
        </table>
      </td>`;

    const acosBadge = (acos: number | null) => {
      if (acos == null) return `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:800;">no sale</span>`;
      const bg = acos < 25 ? "#dcfce7" : acos > 40 ? "#fee2e2" : "#fef3c7";
      const cl = acos < 25 ? "#166534" : acos > 40 ? "#991b1b" : "#92400e";
      return `<span style="background:${bg};color:${cl};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:800;">${Math.round(acos)}%</span>`;
    };

    const nameCell = (t: string) => `<td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;font-weight:700;color:#111;">${t}</td>`;
    const numCell = (t: string, color = "#374151") => `<td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;font-weight:700;color:${color};text-align:right;">${t}</td>`;
    const badgeCell = (h: string) => `<td style="padding:9px 10px;border-top:1px solid #f5f5f5;text-align:right;">${h}</td>`;
    const rank = (i: number) => `<span style="color:#9ca3af;font-weight:800;font-size:11px;">${i + 1}.</span> `;

    // A section renders its table when there are rows, and a green one-liner when there aren't —
    // "nothing wrong here" is itself worth reporting, and an empty grid doesn't say it.
    const section = (emoji: string, title: string, note: string, headCols: string[], rows: string[], clear: string) => `
      <tr><td style="padding:22px 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:800;color:#111;">${emoji} ${title}</h3>
        ${note ? `<p style="margin:3px 0 0;font-size:11px;color:#6b7280;font-weight:600;">${note}</p>` : ""}
      </td></tr>
      <tr><td>${
        rows.length
          ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;">
               <thead><tr style="background:#f9fafb;">
                 ${headCols.map((h, i) => `<th style="padding:8px 10px;text-align:${i === 0 ? "left" : "right"};font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">${h}</th>`).join("")}
               </tr></thead>
               <tbody>${rows.join("")}</tbody>
             </table>`
          : `<table width="100%" cellpadding="11" cellspacing="0" border="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
               <tr><td style="font-size:12px;font-weight:700;color:#166534;">&#10004; ${clear}</td></tr>
             </table>`
      }</td></tr>`;

    const stockoutRows = stockoutItems.map((it) => `<tr>
      ${nameCell(clip(it.name) + `<br><span style="font-weight:600;color:#9ca3af;font-size:10px;">${it.sku || ""}</span>`)}
      ${badgeCell(`<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:800;">${it.units === 0 ? "OUT" : it.units + " left"}</span>`)}
      ${numCell(money(it.spend), "#dc2626")}
      ${numCell(String((it.campaigns || []).length))}
    </tr>`);

    const bleedingRows = bleedingItems.map((c) => `<tr>
      ${nameCell(clip(c.campaignName))}
      ${numCell(money(c.spend), "#dc2626")}
      ${numCell(money(c.sales), "#059669")}
      ${badgeCell(acosBadge(c.acos))}
      ${numCell(String(c.orders), c.orders === 0 ? "#dc2626" : "#374151")}
    </tr>`);

    const wastedRows = wastedTerms.map((t) => `<tr>
      ${nameCell(clip(t.searchTerm))}
      ${numCell(money(t.spend), "#dc2626")}
      ${numCell(String(t.clicks))}
      ${badgeCell(`<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:800;">0</span>`)}
    </tr>`);

    const topCampaigns = (data.topCampaigns || []).map((c: any, i: number) => `<tr>${nameCell(rank(i) + clip(c.name))}${numCell(money(c.sales), "#059669")}${badgeCell(acosBadge(c.acos))}</tr>`);
    const topProducts = (data.topProducts || []).map((p: any, i: number) => `<tr>${nameCell(rank(i) + clip(p.name))}${numCell(money(p.sales), "#059669")}${badgeCell(acosBadge(p.acos))}</tr>`);
    const topTerms = (data.topTerms || []).map((t: any, i: number) => `<tr>${nameCell(rank(i) + clip(t.term))}${numCell(money(t.sales), "#059669")}${numCell(n(t.orders))}</tr>`);

    const issues = stockoutItems.length + bleedingItems.length + wastedTerms.length;

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:6px;">
          <h2 style="margin:0;color:#111;font-size:20px;font-weight:800;">&#128202; Daily Digest</h2>
          <p style="margin:4px 0 0;color:#6b7280;font-size:12px;font-weight:600;">Data for: <strong style="color:#374151;">${data.dateLabel || ""}</strong> &nbsp;&#183;&nbsp; ${data.accountName || "B-ARM"}</p>
        </td></tr>

        <tr><td style="padding-top:14px;">
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background:${issues ? "#fef2f2" : "#f0fdf4"};border:1px solid ${issues ? "#fecaca" : "#bbf7d0"};border-radius:12px;">
            <tr><td>
              <p style="margin:0;font-size:12px;font-weight:800;color:${issues ? "#991b1b" : "#166534"};">${issues ? "&#9888;&#65039; Action needed today" : "&#10004; Nothing needs action today"}</p>
              ${
                issues
                  ? `<p style="margin:6px 0 0;font-size:13px;color:#b91c1c;font-weight:700;line-height:1.7;">
                       <strong style="font-size:16px;">${money(atRisk)}</strong> of ad spend at risk right now<br>
                       <span style="font-weight:600;font-size:12px;">
                         &#128230; ${n(stockoutItems.length)} out-of-stock products still advertising &nbsp;|&nbsp;
                         &#128680; ${n(bleedingItems.length)} bleeding campaigns &nbsp;|&nbsp;
                         &#128184; ${n(wastedTerms.length)} wasted search terms
                       </span>
                     </p>`
                  : `<p style="margin:5px 0 0;font-size:12px;color:#166534;font-weight:600;">No stockout ad spend, no bleeding campaigns and no wasted search terms were found.</p>`
              }
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding-top:16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              ${kpi("Total Sales", money(m.totalSales) + trend(dl.totalSales), "#f0fdf4", "#059669")}
              ${kpi("Ad Spend", money(m.adSpend) + trend(dl.adSpend), "#fef2f2", "#dc2626")}
              ${kpi("Ad Sales", money(m.adSales), "#eff6ff", "#2563eb")}
            </tr>
            <tr><td colspan="3" style="height:8px;"></td></tr>
            <tr>
              ${kpi("ROAS", (m.roas || 0).toFixed(2) + "x", "#f5f3ff", "#6D5EF8")}
              ${kpi("ACOS", (m.acos || 0).toFixed(1) + "%", "#fffbeb", "#d97706")}
              ${kpi("Orders / Units", `${n(m.orders)} / ${n(m.units)}`, "#f0f9ff", "#0891b2")}
            </tr>
          </table>
        </td></tr>

        ${section("&#128230;", "Ad Spend on Out-of-Stock Products", "Pause these campaigns — the product cannot ship.", ["Product", "Stock", "Spend (7d)", "Campaigns"], stockoutRows, "No out-of-stock product is being advertised.")}
        ${section("&#128680;", "Bleeding Campaigns", "High ACOS or no orders — review bids or pause.", ["Campaign", "Spend", "Sales", "ACOS", "Orders"], bleedingRows, "No campaign is bleeding spend.")}
        ${section("&#128184;", "Wasted Search Terms", "Spend with zero orders — add as negative keywords.", ["Search Term", "Spend", "Clicks", "Orders"], wastedRows, "No search term wasted spend.")}
        ${section("&#127942;", "Top 5 Campaigns", "", ["Campaign", "Sales", "ACOS"], topCampaigns, "No campaign sales recorded.")}
        ${section("&#128269;", "Top 5 Products", "", ["Product", "Sales", "ACOS"], topProducts, "No product sales recorded.")}
        ${section("&#128270;", "Top 5 Search Terms", "", ["Search Term", "Sales", "Orders"], topTerms, "No search term sales recorded.")}

        <tr><td style="padding:22px 0 8px;">
          <h3 style="margin:0;font-size:14px;font-weight:800;color:#111;">&#128202; Inventory Health</h3>
        </td></tr>
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              ${kpi("Out of Stock", n(inv.outOfStock || 0), "#fef2f2", "#dc2626")}
              ${kpi("Low Stock", n(inv.low || 0), "#fffbeb", "#d97706")}
              ${kpi("Inventory Value", money(inv.totalValue || 0), "#f0fdf4", "#059669")}
            </tr>
          </table>
        </td></tr>

        <tr><td align="center" style="padding-top:28px;">
          <a href="${SITE_URL}/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
        </td></tr>
      </table>`);
  }

  // Condition-driven alerts (src/lib/liveAlerts.ts). Only ever sent when something actually
  // fired — there is deliberately no "all clear" variant here, unlike the daily digest, because
  // this one arrives off-schedule and an empty one would train the reader to ignore it.
  if (type === "liveAlerts") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alerts: any[] = data.alerts || [];
    const currency = data.currency === "INR" ? "₹" : "$";
    const money = (v: number) => currency + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const totalImpact = alerts.reduce((a, x) => a + (x.impact || 0), 0);

    const TONE: Record<string, { emoji: string; label: string; bg: string; border: string; color: string }> = {
      spendSpike: { emoji: "&#128200;", label: "Ad Spend Spike", bg: "#fef2f2", border: "#fecaca", color: "#991b1b" },
      stockoutForecast: { emoji: "&#128230;", label: "Running Out Soon", bg: "#fffbeb", border: "#fde68a", color: "#92400e" },
      buyBoxLoss: { emoji: "&#127942;", label: "Buy Box Loss", bg: "#fef2f2", border: "#fecaca", color: "#991b1b" },
      conversionDrop: { emoji: "&#128201;", label: "Conversion Drop", bg: "#f5f3ff", border: "#ddd6fe", color: "#5b21b6" },
    };
    const sevChip = (s: number) => {
      const [bg, cl, txt] = s >= 3 ? ["#fee2e2", "#991b1b", "Urgent"] : s === 2 ? ["#fef3c7", "#92400e", "Watch"] : ["#e5e7eb", "#374151", "FYI"];
      return `<span style="background:${bg};color:${cl};padding:2px 9px;border-radius:999px;font-size:10px;font-weight:800;">${txt}</span>`;
    };

    const cards = alerts.map((a) => {
      const t = TONE[a.type] || TONE.spendSpike;
      return `
      <tr><td style="padding:0 0 12px;">
        <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background:${t.bg};border:1px solid ${t.border};border-radius:12px;">
          <tr><td>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size:10px;font-weight:800;color:${t.color};text-transform:uppercase;letter-spacing:0.05em;">${t.emoji} ${t.label}</td>
                <td align="right">${sevChip(a.severity || 1)}</td>
              </tr>
            </table>
            <p style="margin:8px 0 0;font-size:14px;font-weight:800;color:#111;line-height:1.35;">${a.title}</p>
            <p style="margin:6px 0 0;font-size:12px;color:#374151;font-weight:600;line-height:1.6;">${a.detail}</p>
            <p style="margin:8px 0 0;padding-top:8px;border-top:1px dashed ${t.border};font-size:12px;color:${t.color};font-weight:700;line-height:1.5;">&#8594; ${a.action}</p>
          </td></tr>
        </table>
      </td></tr>`;
    }).join("");

    return w(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:14px;">
          <h2 style="margin:0;color:#111;font-size:20px;font-weight:800;">&#9889; ${alerts.length} thing${alerts.length === 1 ? "" : "s"} need${alerts.length === 1 ? "s" : ""} attention</h2>
          <p style="margin:4px 0 0;color:#6b7280;font-size:12px;font-weight:600;">
            ${data.accountName || "B-ARM"} &nbsp;&#183;&nbsp; about <strong style="color:#b91c1c;">${money(totalImpact)}</strong> at stake
            ${data.windowNote ? `&nbsp;&#183;&nbsp; ${data.windowNote}` : ""}
          </p>
        </td></tr>
        <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0">${cards}</table></td></tr>
        <tr><td align="center" style="padding-top:18px;">
          <a href="${SITE_URL}/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
        </td></tr>
        <tr><td style="padding-top:16px;">
          <p style="margin:0;color:#9ca3af;font-size:11px;line-height:1.6;">
            You are seeing each of these once. The same alert for the same product or campaign will not repeat
            for ${data.cooldownHours || 24} hours unless it gets materially worse.
          </p>
        </td></tr>
      </table>`);
  }

  if (type === "historicalReport") {
    // The attached workbook still carries the full per-campaign/SKU breakdown across both
    // windows — this body adds just enough to be worth opening before the attachment: total
    // spend at both grains, and the worst-ACOS SKUs (the one thing worth reading immediately).
    // data: { endDate, win30Start, win7Start, skuCount, pairCount, unmappedCampaignSpend,
    //         totalSpend30, totalSpend7, topWorstAcos: [{sku,name,spendTax,acos}], currency }
    const currency = data.currency === "INR" ? "₹" : "$";
    const money = (v: number) => currency + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const acosColor = (v: number) => ((v || 0) > 0.5 ? "#dc2626" : (v || 0) > 0.25 ? "#d97706" : "#059669");
    const clip = (s: string, len = 55) => ((s || "").length > len ? (s || "").slice(0, len) + "…" : s || "");
    const topWorstAcos: any[] = data.topWorstAcos || [];
    const acosRows = topWorstAcos.map((r, i) => `
      <tr>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;font-weight:700;color:#111;">
          <span style="color:#9ca3af;font-weight:800;font-size:11px;">${i + 1}.</span> ${clip(r.name)}<br>
          <span style="font-weight:600;color:#9ca3af;font-size:10px;">${r.sku || ""}</span>
        </td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;font-weight:700;color:#dc2626;text-align:right;">${money(r.spendTax)}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;text-align:right;">
          <strong style="color:${acosColor(r.acos)};">${Math.round((r.acos || 0) * 100)}%</strong>
        </td>
      </tr>`).join("");
    return wrap(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:16px;">
          <h2 style="margin:0;color:#111;font-size:20px;font-weight:800;">&#128202; Historical 7/30 Day Analysis Report</h2>
          <p style="margin:4px 0 0;color:#6b7280;font-size:13px;font-weight:600;">
            30-day window from ${data.win30Start || "—"} &nbsp;&#183;&nbsp; 7-day window from ${data.win7Start || "—"} &nbsp;&#183;&nbsp; ending ${data.endDate || ""}
          </p>
        </td></tr>
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="48%" style="padding:4px;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fef2f2;border-radius:12px;">
                  <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">Ad Spend (30d)</p><p style="margin:6px 0 0;color:#dc2626;font-size:24px;font-weight:900;">${money(data.totalSpend30)}</p></td></tr>
                </table>
              </td>
              <td width="4%"></td>
              <td width="48%" style="padding:4px;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fef2f2;border-radius:12px;">
                  <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">Ad Spend (7d)</p><p style="margin:6px 0 0;color:#dc2626;font-size:24px;font-weight:900;">${money(data.totalSpend7)}</p></td></tr>
                </table>
              </td>
            </tr>
            <tr><td colspan="3" style="height:8px;"></td></tr>
            <tr>
              <td width="48%" style="padding:4px;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#f5f3ff;border-radius:12px;">
                  <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">SKUs Covered</p><p style="margin:6px 0 0;color:#6D5EF8;font-size:24px;font-weight:900;">${data.skuCount || 0}</p></td></tr>
                </table>
              </td>
              <td width="4%"></td>
              <td width="48%" style="padding:4px;">
                <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#f0f9ff;border-radius:12px;">
                  <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">Campaign &#215; SKU Rows</p><p style="margin:6px 0 0;color:#0891b2;font-size:24px;font-weight:900;">${data.pairCount || 0}</p></td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td></tr>
        ${data.unmappedCampaignSpend ? `
        <tr><td style="padding-top:16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;">
            <tr><td style="padding:12px 14px;">
              <p style="margin:0;color:#92400e;font-size:12.5px;font-weight:700;">&#9888; ${money(data.unmappedCampaignSpend)} of ad spend couldn't be mapped to a campaign — see the Notes sheet.</p>
            </td></tr>
          </table>
        </td></tr>` : ""}
        ${acosRows ? `
        <tr><td style="padding-top:22px;">
          <h3 style="margin:0 0 8px;font-size:14px;font-weight:800;color:#111;">&#128201; Top 5 Worst ACOS (30-day)</h3>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;">
            <thead><tr style="background:#f9fafb;">
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Product</th>
              <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Spend (30d)</th>
              <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">ACOS</th>
            </tr></thead>
            <tbody>${acosRows}</tbody>
          </table>
        </td></tr>` : ""}
        <tr><td>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:11px;line-height:1.6;">
            Full per-campaign/SKU breakdown, FBA availability and order/returns/ad-spend detail are in the attached workbook.
          </p>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${SITE_URL}/dashboard/reports" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Reports &#8594;</a>
        </td></tr>
      </table>`, null);
  }

  if (type === "adSpendDaily") {
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
    const acosPct = (v: number) => `${Math.round((v || 0) * 100)}%`;
    // Same thresholds as the Daily Digest's ACOS badge — colours ACOS so a problem product
    // is scannable without reading every number.
    const acosClass = (v: number) => ((v || 0) > 0.5 ? "aspd-hi" : (v || 0) > 0.25 ? "aspd-mid" : "aspd-lo");
    const clip = (s: string, len = 46) => ((s || "").length > len ? (s || "").slice(0, len) + "…" : s || "");
    const platforms: any[] = data.platformSummaries || [];
    const PLATFORM_COLOR: Record<string, string> = { Amazon: "#FF9900", Flipkart: "#2874F0", Meesho: "#9F2089" };

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
    </style>`;

    const platformRows = platforms.map((p) => {
      const products = p.topProducts.length
        ? p.topProducts
        : [{ name: "(no ad spend in range)", price: 0, day: { spend: 0, spendTax: 0, orders: 0, cpc: 0, acos: 0 }, range: { spend: 0, spendTax: 0, orders: 0, cpc: 0, acos: 0 } }];
      const n = products.length;
      return products.map((prod: any, i: number) => `
        <tr>
          ${i === 0 ? `
          <td rowspan="${n}" ${td} style="font-weight:800;border-left:3px solid ${PLATFORM_COLOR[p.platform] || "#111"};">${p.platform}</td>
          <td rowspan="${n}" ${td}>${money(p.daySpend)}</td>
          <td rowspan="${n}" ${td}>${money(p.daySpendTax)}</td>` : ""}
          <td ${tdName}>${clip(prod.name)}</td>
          <td ${td}>${prod.price ? money(prod.price) : "-"}</td>
          <td ${td}>${money(prod.day.spend)}</td>
          <td ${td}>${money(prod.day.spendTax)}</td>
          <td ${td}>${prod.day.orders}</td>
          <td ${td}>${num(prod.day.cpc)}</td>
          <td class="aspd-td ${acosClass(prod.day.acos)}">${acosPct(prod.day.acos)}</td>
          <td ${td}>${money(prod.range.spend)}</td>
          <td ${td}>${money(prod.range.spendTax)}</td>
          <td ${td}>${prod.range.orders}</td>
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

    // Full per-product breakdown for Amazon and Flipkart specifically — matching the manual
    // mail's separate "Here is the Amazon/Flipkart platform's ad spend report" tables, which
    // list every advertised product (not just the top-3 shortlist above). The manual mail never
    // included a matching table for Meesho, so this intentionally only covers those two.
    const fullTables = ["Amazon", "Flipkart"].map((name) => {
      const p = platforms.find((pl) => pl.platform === name);
      const items: any[] = p?.allProducts || [];
      if (!items.length) return "";
      const rowsHtml = items.map((prod) => `
        <tr>
          <td ${tdName}>${clip(prod.name)}</td>
          <td ${td}>${prod.price ? money(prod.price) : "-"}</td>
          <td ${td}>${money(prod.day.spend)}</td>
          <td ${td}>${money(prod.day.spendTax)}</td>
          <td ${td}>${prod.day.orders}</td>
          <td ${td}>${num(prod.day.cpc)}</td>
          <td class="aspd-td ${acosClass(prod.day.acos)}">${acosPct(prod.day.acos)}</td>
          <td ${td}>${money(prod.range.spend)}</td>
          <td ${td}>${money(prod.range.spendTax)}</td>
          <td ${td}>${prod.range.orders}</td>
          <td ${td}>${num(prod.range.cpc)}</td>
          <td class="aspd-td ${acosClass(prod.range.acos)}">${acosPct(prod.range.acos)}</td>
        </tr>`).join("");
      return `
        <tr><td style="padding-top:22px;padding-bottom:6px;">
          <p style="margin:0;font-size:13px;font-weight:700;color:#111;">Here is the ${name} platform's ad spend report.</p>
        </td></tr>
        <tr><td style="padding-top:6px;">
          <div style="overflow-x:auto;">
          <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;min-width:900px;">
            <thead>
              <tr>
                <th rowspan="2" ${th}>Product Name</th>
                <th rowspan="2" ${th}>Price</th>
                <th colspan="5" ${th}>${data.dayLabel || "Day"}</th>
                <th colspan="5" ${th}>${data.rangeLabel || "Range"}</th>
              </tr>
              <tr>
                <th ${th}>Spend</th>
                <th ${th}>Spend(with tax)</th>
                <th ${th}>Orders</th>
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
            Below is the Ad spend report for all platforms. The table shows platform-wise ad spend including each platform's top spending products with their past 7 days ACOS, so you can see which products were promoted. The Action Sheet (products over 14% 7-day ACOS with a recommended action) and Low Spend Campaigns list are in the attached workbook.<br/><br/>
            Here is the summary of the ad spend report.
          </p>
        </td></tr>
        ${incompleteBanner}
        <tr><td style="padding-top:6px;">
          <div style="overflow-x:auto;">
          <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;min-width:1100px;">
            <thead>
              <tr>
                <th rowspan="2" ${th}>Platform</th>
                <th rowspan="2" ${th}>Ad spend<br/>(without tax)</th>
                <th rowspan="2" ${th}>Ad spend<br/>(with tax)</th>
                <th colspan="2" ${th}>High spending product</th>
                <th colspan="5" ${th}>${data.dayLabel || "Day"}</th>
                <th colspan="5" ${th}>${data.rangeLabel || "Range"}</th>
                <th colspan="2" ${th}>Overall sales</th>
              </tr>
              <tr>
                <th ${th}>Product</th>
                <th ${th}>Price</th>
                <th ${th}>Spend</th>
                <th ${th}>Spend(with tax)</th>
                <th ${th}>Orders</th>
                <th ${th}>CPC</th>
                <th ${th}>ACOS</th>
                <th ${th}>Spend</th>
                <th ${th}>Spend(with tax)</th>
                <th ${th}>Orders</th>
                <th ${th}>CPC</th>
                <th ${th}>ACOS</th>
                <th ${th}>QTS</th>
                <th ${th}>Value</th>
              </tr>
            </thead>
            <tbody>${platformRows}</tbody>
          </table>
          </div>
        </td></tr>
        ${fullTables}
        <tr><td>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:11px;line-height:1.6;">
            ${data.productCount || 0} advertised products across platforms${data.lowSpendCampaignCount ? ` &#183; ${data.lowSpendCampaignCount} low-spend campaigns flagged` : ""}.
            Full per-product breakdown, Action Sheet and Low Spend Campaigns are in the attached workbook.
          </p>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${SITE_URL}/dashboard/reports" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Reports &#8594;</a>
        </td></tr>
      </table>`, null, styleBlock);
  }

  // Daily / Weekly summary
  const metrics = data.metrics || {};
  return w(`
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding-bottom:20px;">
        <h2 style="margin:0;color:#111;font-size:20px;font-weight:800;">&#128202; ${data.period || "Daily"} Performance Summary</h2>
      </td></tr>
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="48%" style="padding:4px;">
              <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#f0fdf4;border-radius:12px;">
                <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">Total Sales</p><p style="margin:6px 0 0;color:#059669;font-size:24px;font-weight:900;">&#8377;${metrics.sales || 0}</p></td></tr>
              </table>
            </td>
            <td width="4%"></td>
            <td width="48%" style="padding:4px;">
              <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fef2f2;border-radius:12px;">
                <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">Total Spend</p><p style="margin:6px 0 0;color:#dc2626;font-size:24px;font-weight:900;">&#8377;${metrics.spend || 0}</p></td></tr>
              </table>
            </td>
          </tr>
          <tr><td colspan="3" style="padding:4px 0;"></td></tr>
          <tr>
            <td width="48%" style="padding:4px;">
              <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#f5f3ff;border-radius:12px;">
                <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">ROAS</p><p style="margin:6px 0 0;color:#6D5EF8;font-size:24px;font-weight:900;">${metrics.roas || 0}x</p></td></tr>
              </table>
            </td>
            <td width="4%"></td>
            <td width="48%" style="padding:4px;">
              <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fffbeb;border-radius:12px;">
                <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">ACOS</p><p style="margin:6px 0 0;color:#d97706;font-size:24px;font-weight:900;">${metrics.acos || 0}%</p></td></tr>
              </table>
            </td>
          </tr>
          <tr><td colspan="3" style="padding:4px 0;"></td></tr>
          <tr>
            <td width="48%" style="padding:4px;">
              <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#f0f9ff;border-radius:12px;">
                <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">Orders</p><p style="margin:6px 0 0;color:#0891b2;font-size:24px;font-weight:900;">${metrics.orders || 0}</p></td></tr>
              </table>
            </td>
            <td width="4%"></td>
            <td width="48%" style="padding:4px;">
              <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background:#fdf4ff;border-radius:12px;">
                <tr><td><p style="margin:0;color:#6b7280;font-size:11px;font-weight:800;text-transform:uppercase;">Impressions</p><p style="margin:6px 0 0;color:#7c3aed;font-size:24px;font-weight:900;">${(metrics.impressions || 0).toLocaleString()}</p></td></tr>
              </table>
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding-top:28px;">
        <a href="${SITE_URL}/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
      </td></tr>
    </table>`);
}

const SUBJECTS: Record<string, string> = {
  test: "Marketplace360 - Email Connected Successfully!",
  confirmation: "Marketplace360 - Alert Settings Saved & Active",
  adAlert: "⚠️ Marketplace360 - Ad Alert",
  dailyDigest: "📊 Marketplace360 - Daily Digest",
  liveAlerts: "⚡ Marketplace360 - Needs Attention",
  weeklyReport: "📈 Marketplace360 - Weekly Performance Report",
  adSpendDaily: "📈 Ad spend Report",
  historicalReport: "📊 Marketplace360 - Historical 7/30 Day Analysis Report",
  stockout: "⚠️ Marketplace360 - Ad Spend on Out-of-Stock Products",
  inventory: "Marketplace360 - Low Inventory Alert",
  campaign: "Marketplace360 - High ACOS Campaign Alert",
  summary: "Marketplace360 - Performance Summary",
  campaignPause: "⏸️ Marketplace360 - Campaign Paused",
};

// Next.js Pages API routes default to a 1mb body limit — nowhere near enough for
// a base64-encoded workbook attachment. The Historical Analysis Report alone runs
// ~20MB raw / ~28MB base64 once the account has 30+ days of uploaded order/return/
// ad-spend history (Ad Spend Report is smaller but still multi-MB); base64 inflates
// the raw file by ~33% on top of that. Without raising this, every send with an
// attachment above the limit failed with a silent 413 before this route's own
// handler ever ran — including the Reports page's manual "Send" button, not just
// the automated crons. 50mb leaves headroom as the uploaded history keeps growing.
// maxDuration raises this route's Vercel serverless function timeout past the platform default
// (10s on Hobby — hard-capped there regardless of this setting; a low default on Pro unless
// raised, up to 300s without Enterprise). Building the attached workbook + calling Gemini for the
// Action Sheet + sending via Gmail SMTP has been observed taking 70-160+ seconds in practice, which
// silently failed on production as a bare "send-email failed" (a timed-out response has no JSON
// body to read an error from) even though the identical call succeeded locally with no time limit.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "50mb",
    },
  },
  maxDuration: 300,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { type = "test", to, cc, data = {}, subject, attachments } = req.body;

  if (!to) return res.status(400).json({ error: "Recipient email (to) is required" });
  if (!process.env.SMTP_FROM || !process.env.SMTP_PASS) {
    return res.status(500).json({ error: "SMTP credentials not configured" });
  }

  try {
    const html = buildHtml(type, data, to);
    // Gmail silently clips a received message around ~102KB, cutting off whatever comes after —
    // logged here because that failure mode is invisible from the sender's side otherwise (the
    // send still reports success). If this creeps past ~90KB for a template with large generated
    // tables (e.g. adSpendDaily), trim content or move more repeated styling into CSS classes.
    console.log(`[send-email] type=${type} html size=${Buffer.byteLength(html, "utf8")} bytes`);
    const info = await transporter.sendMail({
      from: `Marketplace360 Dashboard <${process.env.SMTP_FROM}>`,
      to,
      cc: cc || undefined,
      subject: subject || SUBJECTS[type] || "Marketplace360 Notification",
      html,
      // attachments: [{ filename, content: <base64 string>, encoding: "base64" }] — content
      // travels as base64 over JSON since raw Buffers don't survive a fetch() body.
      attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
    });
    console.log("Email sent:", info.messageId, "→", to, cc ? `(cc: ${cc})` : "");
    res.status(200).json({ success: true, message: `Email sent to ${to}${cc ? ` (cc: ${cc})` : ""}`, messageId: info.messageId });
  } catch (err: any) {
    console.error("Email send error:", err);
    res.status(500).json({ error: err.message || "Failed to send email" });
  }
}
