export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { stats, topCampaigns, topProducts, currency } = req.body || {};

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Gemini API key is not configured.' });
  }

  const prompt = `You are an expert Amazon PPC Analyst. Analyze the following Amazon PPC performance metrics and provide up to 4 highly actionable, data-driven optimization recommendations.

Performance Metrics:
- Total Sales: ${stats.totalSales || 0} ${currency}
- Ad Sales: ${stats.adSales || 0} ${currency}
- Organic Sales: ${stats.organicSales || 0} ${currency}
- Ad Spend: ${stats.adSpend || 0} ${currency}
- Overall ACOS: ${stats.acos || 0}%
- Overall ROAS: ${stats.roas || 0}x
- TACOS: ${stats.tacos || 0}%
- CTR: ${stats.ctr || 0}%
- CVR: ${stats.cvr || 0}%

Top Campaigns:
${JSON.stringify(topCampaigns || [], null, 2)}

Top Products:
${JSON.stringify(topProducts || [], null, 2)}

Return ONLY a JSON array containing recommendation objects with the following schema:
[
  {
    "icon": "A single emoji representing the recommendation status or type (e.g. ⚠️, 🚀, 📉, 🎯)",
    "title": "A short descriptive title (e.g., 'High ACOS Alert', 'Budget Scale Up')",
    "body": "A detailed, actionable recommendation body based on the metrics, specific campaign names, or ASINs",
    "tag": "A short category tag (e.g., 'Bid Optimization', 'Budget', 'Performance', 'Inventory')",
    "color": "Choose exactly one of: 'text-orange-600 bg-orange-50 border-orange-200' (for warnings/bids), 'text-red-600 bg-red-50 border-red-200' (for critical issues), 'text-green-700 bg-green-50 border-green-200' (for opportunities/healthy metrics), 'text-purple-600 bg-purple-50 border-purple-200' (for general campaign advice), 'text-blue-600 bg-blue-50 border-blue-200' (for info/products)"
  }
]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("Gemini API error response:", errText);
      return res.status(upstream.status).json({ error: `Gemini API returned error: ${errText}` });
    }

    const data = await upstream.json();
    const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textResponse) {
      return res.status(500).json({ error: 'Empty response from Gemini API.' });
    }

    const parsedRecs = JSON.parse(textResponse);
    return res.status(200).json({ recommendations: parsedRecs });
  } catch (error) {
    console.error("Error in recommendations proxy:", error);
    return res.status(500).json({ error: `Internal Server Error: ${error.message}` });
  }
}
