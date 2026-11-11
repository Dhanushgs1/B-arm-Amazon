// Server-side gateway for the Flipkart hub's AI features (Groq / Anthropic).
//
// The hub used to call both providers straight from the browser with keys held in client code and
// localStorage. Keys now live only in server env (GROQ_API_KEY, ANTHROPIC_API_KEY); the browser
// sends the provider request body here and never sees a key.
//
//   GET  -> { groq: boolean, anthropic: boolean }   which providers are configured
//   POST -> { provider: "groq" | "anthropic", payload } -> the provider's JSON response, as-is
//
// Requires the dashboard session, is rate limited per IP, and forwards only an allow-listed set of
// request fields with capped output size, so a signed-in browser cannot turn it into a general
// proxy for the account's AI quota.

import type { NextApiRequest, NextApiResponse } from "next";
import { checkSession, clientIp, guard } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";

const PROVIDERS = {
  groq: {
    env: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    headers: (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    fields: ["model", "messages", "temperature", "max_tokens", "response_format", "top_p"],
  },
  anthropic: {
    env: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/messages",
    headers: (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }),
    fields: ["model", "messages", "system", "temperature", "max_tokens"],
  },
} as const;

type Provider = keyof typeof PROVIDERS;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_BODY_CHARS = 400_000;
const UPSTREAM_TIMEOUT_MS = 60_000;

const keyFor = (p: Provider) => process.env[PROVIDERS[p].env] || "";

// Exported for tests: keeps only allow-listed fields and caps max_tokens.
export function sanitizePayload(provider: Provider, payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const src = payload as Record<string, unknown>;
  if (typeof src.model !== "string" || !Array.isArray(src.messages) || src.messages.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const f of PROVIDERS[provider].fields) if (src[f] !== undefined) out[f] = src[f];
  const requested = Number(src.max_tokens);
  out.max_tokens = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_OUTPUT_TOKENS) : 1024;
  return out;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!guard(req, res, checkSession)) return;

  if (req.method === "GET") {
    return res.status(200).json({ groq: !!keyFor("groq"), anthropic: !!keyFor("anthropic") });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const limited = rateLimit(`hub-llm:${clientIp(req.headers)}`, 30, 10 * 60_000);
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfterSec));
    return res.status(429).json({ error: "Too many requests. Try again shortly." });
  }

  const provider = req.body?.provider as Provider;
  if (provider !== "groq" && provider !== "anthropic") return res.status(400).json({ error: "Unknown provider" });
  const key = keyFor(provider);
  if (!key) return res.status(503).json({ error: `${PROVIDERS[provider].env} is not configured on the server` });

  const payload = sanitizePayload(provider, req.body?.payload);
  if (!payload) return res.status(400).json({ error: "Invalid payload: model and messages are required" });
  const body = JSON.stringify(payload);
  if (body.length > MAX_BODY_CHARS) return res.status(413).json({ error: "Request too large" });

  try {
    const upstream = await fetch(PROVIDERS[provider].url, {
      method: "POST",
      headers: PROVIDERS[provider].headers(key),
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    return res.send(text);
  } catch (err) {
    console.error(`[hub-llm] ${provider} request failed:`, err);
    return res.status(502).json({ error: "AI provider request failed" });
  }
}
