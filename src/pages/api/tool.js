// Server-side proxy for the SellerMate.AI Public API.
//
// Single-account setup. The API key lives ONLY in a Vercel environment
// variable (Project Settings -> Environment Variables) and is never present
// in this source file or sent to the browser:
//   SELLERMATE_API_KEY_BARM  (falls back to SELLERMATE_API_KEY_A / SELLERMATE_API_KEY)
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
  'get_sqp_report',
  'get_fba_customer_returns',
  'get_hourly_performance',
  'get_orders_report',
  'list_automations',
  // Read-only additions: negatives inventory, dayparting schedules, tags.
  'list_negative_targets',
  'list_daypartings',
  'get_dayparting',
  'get_tags',
]);

const SELLERMATE_BASE_URL = 'https://api.sellermate.ai/public/v1/tools';

function resolveApiKey() {
  return (
    process.env.SELLERMATE_API_KEY_BARM ||
    process.env.SELLERMATE_API_KEY_A ||
    process.env.SELLERMATE_API_KEY
  );
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

  const { tool, args } = body;

  if (!tool || typeof tool !== 'string') {
    res.status(400).json({ error: 'Missing "tool" in request body.' });
    return;
  }

  if (!ALLOWED_TOOLS.has(tool)) {
    res.status(403).json({ error: `Tool "${tool}" is not allowed from this dashboard (read-only allowlist).` });
    return;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing SELLERMATE_API_KEY_BARM. Add it in Vercel Project Settings -> Environment Variables and redeploy.',
    });
    return;
  }

  try {
    const upstream = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args || {}),
    });

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { raw: text };
    }

    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: (data && (data.error || data.message)) || `SellerMate API error (${upstream.status}) from ${tool}`,
      });
      return;
    }

    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: `Upstream error calling SellerMate: ${e.message}` });
  }
};
