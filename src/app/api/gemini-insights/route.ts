import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const prompt = body.prompt;

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: 'Missing or invalid "prompt" in request body.' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Gemini API key is not configured on the server.' }, { status: 500 });
    }

    // High-speed valid models (fastest first). The old 1.5/2.0 model names are
    // retired or quota-exhausted on this key's free tier (404/429) — the
    // "-latest" aliases stay pointed at whatever current model Google serves.
    const models = [
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'gemini-2.0-flash'
    ];

    let lastStatus = 0;
    let lastErrText = '';

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      // 8-second strict timeout per model fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // The "-latest" flash aliases resolve to thinking-capable models that
            // spend part of maxOutputTokens on hidden reasoning before writing the
            // visible answer — a low maxOutputTokens (previously 500) let thinking
            // eat the whole budget and silently truncated real output to a
            // sentence. thinkingBudget: 0 disable-thinking is rejected as invalid
            // on these models, and even a requested budget (256) is only advisory —
            // observed thinking spend up to ~800 tokens regardless — so the overall
            // ceiling needs generous headroom rather than relying on the budget cap.
            generationConfig: { maxOutputTokens: 2048, temperature: 0.5, thinkingConfig: { thinkingBudget: 256 } },
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 404) {
          continue;
        }

        if (response.status === 429) {
          lastStatus = 429;
          lastErrText = await response.text();
          console.warn(`Gemini 429 rate limit for ${model}, instantly trying next model...`);
          continue;
        }

        if (!response.ok) {
          lastStatus = response.status;
          lastErrText = await response.text();
          console.error(`Gemini API error (${model}):`, lastErrText);
          continue;
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No insights generated.';
        return NextResponse.json({ text, model });

      } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          console.warn(`Gemini fetch timed out for ${model}, trying next model...`);
        } else {
          console.error(`Gemini fetch error (${model}):`, error);
        }
      }
    }

    if (lastStatus === 429) {
      return NextResponse.json({
        error: 'Gemini API Free Tier Rate Limit (429). Google limits free requests per minute. Please wait 15 seconds and click Retry.',
        detail: lastErrText
      }, { status: 429 });
    }

    return NextResponse.json({
      error: 'Gemini service did not respond in time. Please try again.',
      detail: lastErrText
    }, { status: 500 });

  } catch (err: any) {
    console.error("Gemini route error:", err);
    return NextResponse.json({ error: err?.message || "Internal server error" }, { status: 500 });
  }
}
