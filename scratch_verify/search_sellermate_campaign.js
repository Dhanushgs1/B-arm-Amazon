const https = require('https');
require('dotenv').config({ path: '../.env.local' });

const KEY = process.env.SELLERMATE_API_KEY_B || "sm_live_BgO4ZtxiTjEDD59i2FrN92Ydkt2wvb4WRWrUN4pLg-k";

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-API-Key': KEY
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  try {
    const ctxRes = await post('https://api.sellermate.ai/public/v1/tools/get_user_context', {});
    const ctx = JSON.parse(ctxRes.body);
    const account = ctx.accounts?.[0];
    if (!account) return;

    // We can fetch campaigns with state filter or page through more campaigns
    console.log("Fetching all campaigns including archived/paused ones...");
    const res = await post('https://api.sellermate.ai/public/v1/tools/list_campaigns', {
      amazon_account_id: account.id,
      workspace_id: account.workspace_id,
      page_size: 200
    });

    const data = JSON.parse(res.body);
    const campaigns = data.campaigns || [];
    console.log("Total campaigns returned:", campaigns.length);

    campaigns.forEach(c => {
      if (c.name && c.name.toLowerCase().includes('republic')) {
        console.log("FOUND REPUBLIC CAMPAIGN:", c);
      }
    });

  } catch (e) {
    console.error("Error:", e);
  }
}

main();
