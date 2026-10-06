import { NextResponse } from "next/server";
import { checkSession } from "@/lib/apiAuth";
import { rejectUnlessAllowed } from "@/lib/appRouteAuth";
import { fetchLiveInventory } from "@/lib/sellerMateLiveInventory";

// Live Inventory: everything SellerMate has for an account, fetched fresh on every request (no
// cache — "Last fetched" on the page is this request's time). SellerMate's own data is still its
// daily ledger snapshot; the ledger date is returned alongside.
//
// Fetching (ASIN-batched, because SellerMate's offset paging is unstable) lives in
// src/lib/sellerMateLiveInventory.ts → fetchLiveInventory.
//
// GET ?slot=A|B&workspace_id=…&amazon_account_id=…

const BASE = "https://api.sellermate.ai/public/v1/tools";
const BATCH = 50;

function apiKey(slot: string | null): string | undefined {
  return slot === "B"
    ? process.env.SELLERMATE_API_KEY_B || process.env.SELLERMATE_API_KEY_BARM || process.env.SELLERMATE_API_KEY
    : process.env.SELLERMATE_API_KEY_A || process.env.SELLERMATE_API_KEY_LKN || process.env.SELLERMATE_API_KEY;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(key: string, tool: string, args: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/${tool}`, { method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(args), cache: "no-store" });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (attempt >= 4 || !retryable) throw new Error(`SellerMate ${tool} failed (${res.status}): ${text.slice(0, 200)}`);
    // rate-limited / transient: honour Retry-After when given, else back off
    const after = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : 800 * (attempt + 1)));
  }
}

export async function GET(req: Request) {
  const rejected = rejectUnlessAllowed(req, checkSession, { bucket: "live-inventory", limit: 30, windowMs: 60_000 });
  if (rejected) return rejected;
  const url = new URL(req.url);
  const slot = url.searchParams.get("slot");
  const workspace_id = url.searchParams.get("workspace_id");
  const amazon_account_id = url.searchParams.get("amazon_account_id");
  if (!workspace_id || !amazon_account_id) return NextResponse.json({ error: "workspace_id and amazon_account_id are required" }, { status: 400 });
  const key = apiKey(slot);
  if (!key) return NextResponse.json({ error: `Server is missing the SellerMate API key for slot "${slot || "A"}".` }, { status: 500 });
  const base = { workspace_id, amazon_account_id };

  try {
    const result = await fetchLiveInventory((tool, args) => call(key, tool, args), base, BATCH);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
