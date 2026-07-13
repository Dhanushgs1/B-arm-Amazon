// Server-side proxy for the SellerMate.AI Public API.
//
// Supports up to two separate SellerMate accounts ("key slots"). Each key
// lives ONLY in a Vercel environment variable (Project Settings ->
// Environment Variables) and is never present in this source file or sent
// to the browser:
//   Slot A: SELLERMATE_API_KEY_A  (falls back to legacy SELLERMATE_API_KEY)
//   Slot B: SELLERMATE_API_KEY_B
//
// Only read-only ("reporting") tools are allowlisted below, so this public
// dashboard cannot be used to mutate campaigns/bids/budgets even if someone
// finds the deployment URL.

const ALLOWED_TOOLS = new Set([
  'get_user_context',
  'get_marketplace_summary',
  'get_sellermate_capabilities',
  'list_campaigns',
  'get_campaign_performance',
  'get_placement_performance',
  'get_search_term_performance',
  'get_targeting_performance',
  'list_targets',
  'list_product_catalog',
  'get_retail_product_performance',
  'get_inventory',
  'get_advertised_product_performance',
]);

const SELLERMATE_BASE_URL = 'https://api.sellermate.ai/public/v1/tools';

function resolveApiKey(slot) {
  if (slot === 'B') return process.env.SELLERMATE_API_KEY_B;
  // Slot A (default): prefer the "_A" var, fall back to the original
  // single-account variable name for backward compatibility.
  return process.env.SELLERMATE_API_KEY_A || process.env.SELLERMATE_API_KEY;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
  }
  body = body || {};

  const { tool, args, slot } = body;
  const keySlot = slot === 'B' ? 'B' : 'A';

  if (!tool || typeof tool !== 'string') {
    res.status(400).json({ error: 'Missing "tool" in request body.' });
    return;
  }

  if (!ALLOWED_TOOLS.has(tool)) {
    res.status(403).json({ error: `Tool "${tool}" is not allowed from this dashboard (read-only allowlist).` });
    return;
  }

  const apiKey = resolveApiKey(keySlot);
  if (!apiKey) {
    const varName = keySlot === 'B' ? 'SELLERMATE_API_KEY_B' : 'SELLERMATE_API_KEY_A (or SELLERMATE_API_KEY)';
    res.status(500).json({
      error: `Server is missing ${varName} for Account ${keySlot}. Add it in Vercel settings.`
    });
    return;
  }

  try {
    const upstream = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(args || {}),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).json({ error: `SellerMate API Error: ${errText}` });
      return;
    }

    const data = await upstream.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: `Internal Proxy Error: ${error.message}` });
  }
};