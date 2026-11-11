// Legacy serverless proxy → SellerMate Public API, for callers that bring their own key in the
// x-api-key header (never stored server-side). The dashboard itself uses /api/tool.
// Same-origin only and behind the dashboard session: without that it was an open relay anyone on
// the internet could drive through this deployment's IP and quota.
import { checkSession, guard } from "@/lib/apiAuth";

const BASE = "https://api.sellermate.ai/public/v1";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });
  if (!guard(req, res, checkSession)) return;

  const key = req.headers["x-api-key"];
  if (!key) return res.status(401).json({ message: "Missing X-API-Key" });

  const path = Array.isArray(req.query.path) ? req.query.path.join("/") : req.query.path;
  if (!path || !/^tools(\/[a-z0-9_]+)?$/.test(path)) {
    return res.status(400).json({ message: "Invalid path" });
  }

  try {
    const upstream = await fetch(`${BASE}/${path}`, {
      method: req.method,
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: req.method === "POST" ? JSON.stringify(req.body || {}) : undefined,
    });
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ message: "Upstream error: " + e.message });
  }
}
