// Correlates live inventory against advertised-product ad spend to find
// products that are out of stock (or below a threshold) yet still burning ad
// budget. Shared by the /api/stockout-alert endpoint (manual trigger) and the
// daily cron in instrumentation.ts (automatic send).

const SELLERMATE_BASE_URL = "https://api.sellermate.ai/public/v1/tools";

export type StockoutItem = {
  asin: string;
  name: string;
  sku: string;
  image: string;
  units: number;
  spend: number;
  campaigns: { name: string; spend: number }[];
};

async function callTool(tool: string, args: Record<string, any>, apiKey: string) {
  const r = await fetch(`${SELLERMATE_BASE_URL}/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${tool}: ${await r.text()}`);
  return r.json();
}

const toDateStr = (d: Date) => d.toISOString().slice(0, 10);

export async function findStockoutAdSpend(opts: {
  apiKey: string;
  amazon_account_id: string;
  workspace_id: string;
  lowStockThreshold?: number;
  lookbackDays?: number;
  now?: Date;
}): Promise<StockoutItem[]> {
  const { apiKey, amazon_account_id, workspace_id } = opts;
  const lowStockThreshold = opts.lowStockThreshold ?? 0;
  const lookbackDays = opts.lookbackDays ?? 7;
  const now = opts.now ?? new Date();

  // 1. Inventory: all pages → ASIN map
  const invByAsin = new Map<string, { name: string; sku: string; image: string; units: number }>();
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const inv = await callTool("get_inventory", { amazon_account_id, workspace_id, limit: 200, offset }, apiKey);
    const items: any[] = inv.items || [];
    for (const it of items) {
      const units = (it.fbm?.quantity || 0) + (it.fba?.endingWarehouseBalance || 0);
      invByAsin.set(it.asin, { name: it.itemName || it.asin, sku: it.sku || it.asin, image: it.mainImageUrl || "", units });
    }
    if (items.length === 0 || offset + items.length >= (inv.total || 0)) break;
    offset += items.length;
  }

  // 2. Ad spend by ASIN + campaign over the lookback window
  const end = now;
  const start = new Date(now);
  start.setDate(start.getDate() - (lookbackDays - 1));
  const spendByAsin = new Map<string, { spend: number; campaigns: Map<string, number> }>();
  let page = 0;
  for (let i = 0; i < 12; i++) {
    const perf = await callTool("get_advertised_product_performance", {
      amazon_account_id, workspace_id,
      start_date: toDateStr(start), end_date: toDateStr(end),
      group_by: ["adAsin", "adProductName", "campaignName"],
      sort_field: "cost", sort_direction: "desc", page, page_size: 200,
    }, apiKey);
    const rows: any[] = perf.data || [];
    for (const r of rows) {
      if (!r.adAsin || !(r.spend > 0)) continue;
      let entry = spendByAsin.get(r.adAsin);
      if (!entry) { entry = { spend: 0, campaigns: new Map() }; spendByAsin.set(r.adAsin, entry); }
      entry.spend += r.spend;
      if (r.campaignName) entry.campaigns.set(r.campaignName, (entry.campaigns.get(r.campaignName) || 0) + r.spend);
    }
    if (!perf.pagination?.hasMore || rows.length === 0) break;
    page++;
  }

  // 3. Correlate: advertised (spend > 0) AND stock <= threshold
  const items: StockoutItem[] = [];
  for (const [asin, s] of spendByAsin) {
    const inv = invByAsin.get(asin);
    if (!inv || inv.units > lowStockThreshold) continue;
    items.push({
      asin,
      name: inv.name,
      sku: inv.sku,
      image: inv.image,
      units: inv.units,
      spend: s.spend,
      campaigns: [...s.campaigns.entries()].map(([name, sp]) => ({ name, spend: sp })).sort((a, b) => b.spend - a.spend),
    });
  }
  items.sort((a, b) => b.spend - a.spend);
  return items;
}

export function resolveSellerMateKey(slot: string): string | undefined {
  if (slot === "B") return process.env.SELLERMATE_API_KEY_B;
  return process.env.SELLERMATE_API_KEY_A || process.env.SELLERMATE_API_KEY;
}
