// Vercel serverless proxy → SellerMate Public API
// Avoids browser CORS issues. The API key is passed per-request from the
// client's x-api-key header and never stored server-side.
const BASE = "https://api.sellermate.ai/public/v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

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
