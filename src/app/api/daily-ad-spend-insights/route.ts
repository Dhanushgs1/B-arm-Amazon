import { NextResponse } from "next/server";
import { checkSession } from "@/lib/apiAuth";
import { rejectUnlessAllowed } from "@/lib/appRouteAuth";

// One Gemini call for the whole product list (not one call per product) —
// same reasoning as gemini-insights/route.ts: keep this to a single request
// so a day with hundreds of advertised SKUs doesn't fan out into hundreds of
// API calls. Same multi-model fallback cascade as gemini-insights/route.ts.
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.0-flash"];

interface InsightProduct {
  sku: string;
  platform: string;
  name: string;
  price: number;
  spendTax: number;
  orders: number;
  cpc: number;
  acos: number;
  sales: number;
}

export async function POST(req: Request) {
  // Spends the company's Gemini key: signed-in session only, capped at 10 calls per 10 minutes per IP.
  const rejected = rejectUnlessAllowed(req, checkSession, { bucket: "daily-ad-spend-insights", limit: 10, windowMs: 10 * 60_000 });
  if (rejected) return rejected;
  try {
    const body = await req.json().catch(() => ({}));
    const products: InsightProduct[] = Array.isArray(body.products) ? body.products : [];
    if (!products.length) {
      return NextResponse.json({ error: "No products supplied." }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Gemini API key is not configured on the server." }, { status: 500 });
    }

    // Keeps the prompt (and the model's JSON output) a bounded size — the page
    // only ever sends products with real spend, and 150 rows of one day's ad
    // spend already comfortably covers every seller's actual daily campaign
    // count, so this cap should never actually bind in practice.
    const capped = products.slice(0, 150);

    const prompt = `You are an expert cross-marketplace PPC analyst covering Amazon, Flipkart, and Meesho ads for one seller.
For EACH product below (ad-spend data for the selected date range), decide ONE action based on its CPC, ACOS, Orders, Spend and Sales.

Action must be exactly one of: "Scale Up", "Maintain", "Reduce Bid", "Pause Campaign".
Guidance (use judgement, these are not hard cutoffs): ACOS under ~20% with orders > 0 -> Scale Up. ACOS 20-40% -> Maintain. ACOS over ~40% -> Reduce Bid. Real spend but zero orders -> Pause Campaign.

"sales" in the input is orders x price (a rough revenue estimate for this product's ad-attributed orders). Comparing it to spendTax is exactly what should drive the action — spend close to or above sales is a real warning sign worth naming, not something to soften.

Products (JSON):
${JSON.stringify(capped)}

Return ONLY a JSON array, one object per product, in the SAME ORDER as the input, with this schema:
[{"sku": "<same sku string as input>", "action": "Scale Up|Maintain|Reduce Bid|Pause Campaign", "reason": "One well-written, natural sentence (15-25 words) a real PPC analyst would say out loud — not a comma-separated dump of numbers. It must still reference spend vs sales explicitly (e.g. 'spend of ₹X against ₹Y in sales'), but woven into a proper sentence with a clear verb and rationale for the action, in plain conversational English."}]`;

    let lastStatus = 0;
    let lastErrText = "";

    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 8192, temperature: 0.3, responseMimeType: "application/json" },
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.status === 404) continue;
        if (response.status === 429) { lastStatus = 429; lastErrText = await response.text(); continue; }
        if (!response.ok) { lastStatus = response.status; lastErrText = await response.text(); continue; }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) continue;

        let parsed: { sku: string; action: string; reason: string }[];
        try {
          parsed = JSON.parse(text);
        } catch {
          continue; // malformed JSON from this model — try the next one
        }
        return NextResponse.json({ recommendations: parsed, model });
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        if (!(error instanceof Error && error.name === "AbortError")) {
          console.error(`Gemini fetch error (${model}):`, error);
        }
      }
    }

    if (lastStatus === 429) {
      return NextResponse.json(
        { error: "Gemini API free-tier rate limit hit. Wait a moment and retry.", detail: lastErrText },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "Gemini service did not return usable recommendations. Please retry.", detail: lastErrText },
      { status: 500 }
    );
  } catch (err: unknown) {
    console.error("daily-ad-spend-insights route error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Internal server error" }, { status: 500 });
  }
}
