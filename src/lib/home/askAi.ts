"use client";

// AI answers for the chat when a question is not one answerFromData (chatAnswers.ts) recognises.
// Goes through /api/hub-llm, which holds the key on the server (ANTHROPIC_API_KEY or GROQ_API_KEY).

import type { BiDataset } from "@/lib/bi/types";
import { dataSummaryForAi } from "@/lib/home/chatAnswers";

/** Groq model: the strongest chat model on the account (checked 12 Nov 2026: llama-3.3-70b is not available to it). */
const GROQ_MODEL = "openai/gpt-oss-120b";

export const NO_AI_KEY_ANSWER =
  "I can answer questions about **sales**, **orders**, **top products**, **stock**, **returns** and **ad spend** from your data — try one of the suggestions. Other questions need an AI key (ANTHROPIC_API_KEY or GROQ_API_KEY) set on the server.";

export async function askAi(ds: BiDataset, question: string): Promise<string> {
  const cfg = await fetch("/api/hub-llm").then((r) => (r.ok ? r.json() : { groq: false, anthropic: false })).catch(() => ({ groq: false, anthropic: false }));
  if (!cfg.anthropic && !cfg.groq) return NO_AI_KEY_ANSWER;
  const system = `You are the analyst for B-ARM's Marketplace360 dashboard. Answer briefly (under 120 words), in plain English, using only the data below. Use ₹ and the Indian number format. If the data does not cover the question, say so.\n\n${dataSummaryForAi(ds)}`;
  const provider = cfg.anthropic ? "anthropic" : "groq";
  const payload = provider === "anthropic"
    ? { model: "claude-sonnet-5-5", system, messages: [{ role: "user", content: question }], max_tokens: 600, temperature: 0.2 }
    : { model: GROQ_MODEL, messages: [{ role: "system", content: system }, { role: "user", content: question }], max_tokens: 600, temperature: 0.2 };
  const r = await fetch("/api/hub-llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
  const text = provider === "anthropic" ? j?.content?.[0]?.text : j?.choices?.[0]?.message?.content;
  return String(text || "No answer came back.");
}
