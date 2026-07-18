import type { NextApiRequest, NextApiResponse } from "next";
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_FROM,
    pass: process.env.SMTP_PASS,
  },
});

function wrap(body: string) {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BARM AI</title></head>
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
                <p style="margin:0;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">&#128640; BARM AI Dashboard</p>
                <p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:13px;">${now} IST</p>
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
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent by BARM AI &nbsp;&#183;&nbsp; <a href="http://localhost:3000/dashboard/settings" style="color:#6D5EF8;text-decoration:none;">Manage alerts</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildHtml(type: string, data: Record<string, any>, toEmail: string): string {
  if (type === "test") {
    return wrap(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" style="padding:8px 0 24px;">
            <table cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;">
              <tr><td align="center" style="padding:24px 32px;">
                <p style="margin:0;font-size:40px;line-height:1;">&#9989;</p>
                <h2 style="margin:12px 0 6px;color:#166534;font-size:20px;font-weight:800;">Email Connected!</h2>
                <p style="margin:0;color:#15803d;font-size:14px;font-weight:600;">Your BARM AI alerts are now active.</p>
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
            <a href="http://localhost:3000/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
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

    return wrap(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" style="padding:8px 0 24px;">
            <table cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;">
              <tr><td align="center" style="padding:24px 32px;">
                <p style="margin:0;font-size:40px;line-height:1;">&#128276;</p>
                <h2 style="margin:12px 0 6px;color:#166534;font-size:20px;font-weight:800;">Alert Settings Saved &amp; Active</h2>
                <p style="margin:0;color:#15803d;font-size:14px;font-weight:600;">Your BARM AI notification preferences are live.</p>
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
            <a href="http://localhost:3000/dashboard/settings" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Manage Alert Settings &#8594;</a>
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

    return wrap(`
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
          <a href="${data.ctaUrl || "http://localhost:3000/dashboard"}" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">${data.ctaText || "Open Dashboard"} &#8594;</a>
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

    return wrap(`
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
          <a href="http://localhost:3000/dashboard/campaigns" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Manage Campaigns &#8594;</a>
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

    return wrap(`
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
          <a href="http://localhost:3000/dashboard/inventory" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">View Inventory &#8594;</a>
        </td></tr>
      </table>`);
  }

  if (type === "campaign") {
    const campaigns: any[] = data.campaigns || [];
    const rows = campaigns.map((c: any) => `
      <tr>
        <td style="padding:12px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:700;color:#111;">${c.name}</td>
        <td align="center" style="padding:12px 10px;border-bottom:1px solid #f0f0f0;">
          <span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800;">${c.acos}%</span>
        </td>
        <td style="padding:12px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:700;color:#059669;">&#8377;${c.sales}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:700;color:#dc2626;">&#8377;${c.spend}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:700;color:#6b7280;">${c.roas}x</td>
      </tr>`).join("");

    return wrap(`
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
          <a href="http://localhost:3000/dashboard/campaigns" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">View Campaigns &#8594;</a>
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
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;color:#111;font-weight:800;text-align:right;">${money(d.sales)}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;color:#6b7280;text-align:right;">${d.units}</td>
        <td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12.5px;color:#6b7280;text-align:right;">${deptTotal ? ((d.sales / deptTotal) * 100).toFixed(1) : "0.0"}%</td>
      </tr>`).join("");

    return wrap(`
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
          <h3 style="margin:0 0 8px;font-size:14px;font-weight:800;color:#111;">&#127973; Department Breakup (this week)</h3>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;">
            <thead><tr style="background:#f9fafb;">
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Department</th>
              <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">Sales</th>
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

        ${moverTable("&#128200;", "Top Gainers (sales up)", data.gainers, true, "Products growing week-over-week — double down here.")}
        ${moverTable("&#128201;", "Top Decliners (sales down)", data.losers, false, "Products dropping week-over-week — check stock, bids & ranking.")}

        <tr><td align="center" style="padding-top:28px;">
          <a href="http://localhost:3000/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
        </td></tr>
      </table>`);
  }

  if (type === "dailyReport") {
    const currency = data.currency === "INR" ? "₹" : "$";
    const money = (v: number) => currency + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(v || 0));
    const n = (v: number) => new Intl.NumberFormat("en-IN").format(Math.round(v || 0));
    const m = data.metrics || {};

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

    const section = (emoji: string, title: string, headCols: string[], rows: string[]) => `
      <tr><td style="padding:22px 0 8px;">
        <h3 style="margin:0;font-size:14px;font-weight:800;color:#111;">${emoji} ${title}</h3>
      </td></tr>
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;">
          <thead><tr style="background:#f9fafb;">
            ${headCols.map((h, i) => `<th style="padding:8px 10px;text-align:${i === 0 ? "left" : "right"};font-size:10px;font-weight:800;color:#6b7280;text-transform:uppercase;">${h}</th>`).join("")}
          </tr></thead>
          <tbody>${rows.join("") || `<tr><td colspan="${headCols.length}" style="padding:12px;font-size:12px;color:#9ca3af;">No data</td></tr>`}</tbody>
        </table>
      </td></tr>`;

    const rank = (i: number) => `<span style="color:#9ca3af;font-weight:800;font-size:11px;">${i + 1}.</span> `;
    const nameCell = (t: string) => `<td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;font-weight:700;color:#111;">${t}</td>`;
    const numCell = (t: string, color = "#374151") => `<td style="padding:9px 10px;border-top:1px solid #f5f5f5;font-size:12px;font-weight:700;color:${color};text-align:right;">${t}</td>`;
    const badgeCell = (h: string) => `<td style="padding:9px 10px;border-top:1px solid #f5f5f5;text-align:right;">${h}</td>`;
    const clip = (s: string, len = 34) => (s || "").length > len ? (s || "").slice(0, len) + "…" : (s || "");

    const topCampaigns = (data.topCampaigns || []).map((c: any, i: number) => `<tr>${nameCell(rank(i) + clip(c.name))}${numCell(money(c.sales), "#059669")}${badgeCell(acosBadge(c.acos))}</tr>`);
    const lossCampaigns = (data.lossCampaigns || []).map((c: any, i: number) => `<tr>${nameCell(rank(i) + clip(c.name))}${numCell(money(c.spend), "#dc2626")}${badgeCell(acosBadge(c.acos))}${numCell(n(c.orders), c.orders === 0 ? "#dc2626" : "#374151")}</tr>`);
    const topTerms = (data.topTerms || []).map((t: any, i: number) => `<tr>${nameCell(rank(i) + clip(t.term))}${numCell(money(t.sales), "#059669")}${numCell(n(t.orders))}</tr>`);
    const topProducts = (data.topProducts || []).map((p: any, i: number) => `<tr>${nameCell(rank(i) + clip(p.name))}${numCell(money(p.sales), "#059669")}${badgeCell(acosBadge(p.acos))}</tr>`);

    const inv = data.inventory || {};
    const al = data.alerts || {};

    return wrap(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding-bottom:6px;">
          <h2 style="margin:0;color:#111;font-size:20px;font-weight:800;">&#128202; Daily Performance Report</h2>
          <p style="margin:4px 0 0;color:#6b7280;font-size:12px;font-weight:600;">Data for: <strong style="color:#374151;">${data.dateLabel || ""}</strong> &nbsp;&#183;&nbsp; ${data.accountName || "B-ARM"}</p>
        </td></tr>

        <tr><td style="padding-top:14px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              ${kpi("Total Sales", money(m.totalSales), "#f0fdf4", "#059669")}
              ${kpi("Ad Spend", money(m.adSpend), "#fef2f2", "#dc2626")}
              ${kpi("Ad Sales", money(m.adSales), "#eff6ff", "#2563eb")}
            </tr>
            <tr><td colspan="3" style="height:8px;"></td></tr>
            <tr>
              ${kpi("ROAS", (m.roas || 0).toFixed(2) + "x", "#f5f3ff", "#6D5EF8")}
              ${kpi("ACOS", (m.acos || 0).toFixed(1) + "%", "#fffbeb", "#d97706")}
              ${kpi("Orders", n(m.orders), "#f0f9ff", "#0891b2")}
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding-top:16px;">
          <table width="100%" cellpadding="12" cellspacing="0" border="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;">
            <tr><td>
              <p style="margin:0;font-size:12px;font-weight:800;color:#991b1b;">&#9888;&#65039; Action needed today</p>
              <p style="margin:5px 0 0;font-size:12px;color:#b91c1c;font-weight:600;line-height:1.6;">
                &#128230; ${n(al.stockout || 0)} products out of stock &nbsp;|&nbsp;
                &#128680; ${n(al.bleeding || 0)} bleeding campaigns &nbsp;|&nbsp;
                &#128184; ${n(al.wastedTerms || 0)} wasted search terms
                ${al.wastedSpend ? `<br><strong>${money(al.wastedSpend)}</strong> ad spend at risk (no orders)` : ""}
              </p>
            </td></tr>
          </table>
        </td></tr>

        ${section("&#127942;", "Top 5 Campaigns (by sales)", ["Campaign", "Sales", "ACOS"], topCampaigns)}
        ${section("&#128201;", "Loss 5 Campaigns (worst ACOS / no orders)", ["Campaign", "Spend", "ACOS", "Orders"], lossCampaigns)}
        ${section("&#128269;", "Top 5 Search Terms", ["Search Term", "Sales", "Orders"], topTerms)}
        ${section("&#128230;", "Top 5 Products", ["Product", "Sales", "ACOS"], topProducts)}

        <tr><td style="padding:22px 0 8px;">
          <h3 style="margin:0;font-size:14px;font-weight:800;color:#111;">&#128230; Inventory Health</h3>
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
          <a href="http://localhost:3000/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
        </td></tr>
      </table>`);
  }

  // Daily / Weekly summary
  const metrics = data.metrics || {};
  return wrap(`
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
        <a href="http://localhost:3000/dashboard" style="background:#6D5EF8;color:#ffffff;padding:13px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:800;display:inline-block;">Open Dashboard &#8594;</a>
      </td></tr>
    </table>`);
}

const SUBJECTS: Record<string, string> = {
  test: "BARM AI - Email Connected Successfully!",
  confirmation: "BARM AI - Alert Settings Saved & Active",
  adAlert: "⚠️ BARM AI - Ad Alert",
  dailyReport: "📊 BARM AI - Daily Performance Report",
  weeklyReport: "📈 BARM AI - Weekly Performance Report",
  stockout: "⚠️ BARM AI - Ad Spend on Out-of-Stock Products",
  inventory: "BARM AI - Low Inventory Alert",
  campaign: "BARM AI - High ACOS Campaign Alert",
  summary: "BARM AI - Performance Summary",
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { type = "test", to, data = {}, subject, attachments } = req.body;

  if (!to) return res.status(400).json({ error: "Recipient email (to) is required" });
  if (!process.env.SMTP_FROM || !process.env.SMTP_PASS) {
    return res.status(500).json({ error: "SMTP credentials not configured" });
  }

  try {
    const html = buildHtml(type, data, to);
    const info = await transporter.sendMail({
      from: `BARM AI Dashboard <${process.env.SMTP_FROM}>`,
      to,
      subject: subject || SUBJECTS[type] || "BARM AI Notification",
      html,
      // attachments: [{ filename, content: <base64 string>, encoding: "base64" }] — content
      // travels as base64 over JSON since raw Buffers don't survive a fetch() body.
      attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
    });
    console.log("Email sent:", info.messageId, "→", to);
    res.status(200).json({ success: true, message: `Email sent to ${to}`, messageId: info.messageId });
  } catch (err: any) {
    console.error("Email send error:", err);
    res.status(500).json({ error: err.message || "Failed to send email" });
  }
}
