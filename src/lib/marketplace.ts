// Flipkart doesn't have a connected data source yet (no Seller API keys —
// see Settings > Marketplace Connections), so every number here is
// deterministically generated demo data. It is seeded from the marketplace id
// + date range, so it stays stable while you browse a given period instead of
// re-randomizing on every render, and it swaps out for real numbers with zero
// UI changes once fetchFlipkartOverview is backed by a real API call.

export type MarketplaceId = "amazon" | "flipkart";
// Meesho and BARM (the seller's own Google/B-Arm orders channel) are
// upload-and-download-only tabs with no analytics pages, so they're tabs, not
// MarketplaceIds — none of the demo-data generators below know about them.
// Shopify (the seller's Shopify store, orders by webhook) is the same kind of tab, kept apart from BARM.
export type UploadOnlyTab = "meesho" | "barm" | "shopify";
export type MarketplaceTab = MarketplaceId | UploadOnlyTab | "compare";

export const UPLOAD_ONLY_TAB_META: Record<UploadOnlyTab, { label: string; tagline: string; color: string; home: string }> = {
  meesho: { label: "Meesho", tagline: "Meesho · Overview & Download", color: "#9F2089", home: "/dashboard/meesho" },
  // The B-ARM website's own orders before it moved to Shopify (WooCommerce export, barm_online_orders
  // — last full order 21 Sep 2026). Kept as a read-only history tab; newer website orders are on Shopify.
  barm: { label: "B-ARM Website", tagline: "B-ARM Website (WooCommerce) · order history up to the Shopify move", color: "#10B981", home: "/dashboard/barm" },
  shopify: { label: "Shopify", tagline: "Shopify · Overview & Download", color: "#5E8E3E", home: "/dashboard/shopify" },
};

export function isUploadOnlyTab(tab: MarketplaceTab): tab is UploadOnlyTab {
  return tab === "meesho" || tab === "barm" || tab === "shopify";
}

export interface MarketplaceMeta {
  id: MarketplaceId;
  label: string;
  shortLabel: string;
  tagline: string;
  color: string;
  gradient: string; // tailwind "from-x to-y"
  bg: string; // tailwind bg-x/opacity
  text: string; // tailwind text-x
  border: string; // tailwind border-x
}

export const MARKETPLACE_META: Record<MarketplaceId, MarketplaceMeta> = {
  amazon: {
    id: "amazon",
    label: "Amazon",
    shortLabel: "AMZ",
    tagline: "Live · SellerMate",
    color: "#FF9900",
    gradient: "from-[#FF9900] to-[#232F3E]",
    bg: "bg-[#FF9900]/10",
    text: "text-[#CC7A00] dark:text-[#FFB84D]",
    border: "border-[#FF9900]/25",
  },
  flipkart: {
    id: "flipkart",
    label: "Flipkart",
    shortLabel: "FK",
    tagline: "Demo · Connect API",
    color: "#2874F0",
    gradient: "from-[#2874F0] to-[#FFC200]",
    bg: "bg-[#2874F0]/10",
    text: "text-[#2874F0]",
    border: "border-[#2874F0]/25",
  },
};

export const MOCK_MARKETPLACES: MarketplaceId[] = ["flipkart"];

// ---------------------------------------------------------------------------
// Pathname helpers — the sidebar/topnav derive the active marketplace from
// the URL instead of duplicating it in state, so there is nothing to keep in
// sync.
// ---------------------------------------------------------------------------

export const OVERALL_ONLY_PATHS = ["/dashboard/master", "/dashboard/ratings-reviews", "/dashboard/seasonal", "/dashboard/settings"];

export function getMarketplaceTab(pathname: string | null): MarketplaceTab {
  const p = pathname || "";
  if (p.startsWith("/dashboard/flipkart")) return "flipkart";
  if (p.startsWith("/dashboard/meesho")) return "meesho";
  if (p.startsWith("/dashboard/barm") || p.startsWith("/dashboard/google")) return "barm";
  if (p.startsWith("/dashboard/shopify")) return "shopify";
  if (p.startsWith("/dashboard/compare")) return "compare";
  // Cross-platform pages that live under Overall only (user, 2026-10-25), not under Amazon.
  if (OVERALL_ONLY_PATHS.some((x) => p === x || p.startsWith(`${x}/`))) return "compare";
  return "amazon";
}

export function marketplaceHome(id: MarketplaceId): string {
  if (id === "amazon") return "/dashboard";
  return `/dashboard/${id}`;
}

// ---------------------------------------------------------------------------
// Deterministic seeded RNG — same approach as the KPI trend hash already used
// on the Amazon overview page, just promoted to a proper PRNG so we can draw
// more than one number per seed without them correlating.
// ---------------------------------------------------------------------------

function seedFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seedParts: (string | number | undefined)[]) {
  return mulberry32(seedFromString(seedParts.join("|")));
}

function fmtDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { month: "short", day: "numeric" });
}

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const last = new Date(ey, em - 1, ed);
  if (last < cur) return out;
  while (cur <= last) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export interface MarketplaceTrendPoint {
  rawDate: string;
  date: string;
  sales: number;
  orders: number;
  units: number;
}

export interface MarketplaceProduct {
  name: string;
  sku: string;
  units: number;
  sales: number;
  stock: number;
  rating: number;
}

export interface MarketplaceOrder {
  orderId: string;
  date: string;
  product: string;
  qty: number;
  amount: number;
  status: "Delivered" | "Shipped" | "RTO" | "Cancelled" | "Pending";
  state: string;
}

export interface MarketplaceOverview {
  id: MarketplaceId;
  totalSales: number;
  totalOrders: number;
  totalUnits: number;
  avgOrderValue: number;
  returnRatePct: number;
  growthPct: number;
  rating: number;
  trend: MarketplaceTrendPoint[];
  topProducts: MarketplaceProduct[];
  states: { state: string; value: number; orders: number }[];
}

const PRODUCT_NAMES = [
  "Ovulation Test Kit (30 Strips)",
  "Digital Basal Body Thermometer",
  "TTC Conception Support Kit",
  "Sensory Chew Brush - Therapy Grade",
  "Speech Therapy Tool Set",
  "Baby Grooming Kit - 8 pcs",
  "Postpartum Recovery Belt",
  "Nasal Aspirator for Infants",
  "Silicone Teether Set",
  "Pregnancy Test Strips (10 Pack)",
  "Maternity Support Band",
  "Kids Sensory Fidget Pack",
];

// First-half-vs-second-half average, used consistently for every marketplace
// (including real Amazon daily figures on the Compare page) so "growth" means
// the same thing everywhere instead of mixing a modelled trend with a
// separately-rolled random number.
export function computeGrowthPct(values: number[]): number {
  if (values.length < 2) return 0;
  const mid = Math.floor(values.length / 2);
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const firstHalf = avg(values.slice(0, mid));
  const secondHalf = avg(values.slice(mid));
  return firstHalf ? ((secondHalf - firstHalf) / firstHalf) * 100 : 0;
}

const INDIAN_STATES = [
  "Maharashtra", "Uttar Pradesh", "Karnataka", "Tamil Nadu", "Delhi",
  "West Bengal", "Gujarat", "Telangana", "Rajasthan", "Kerala",
];

// Marketplace "personality" — Flipkart sits mid-market, roughly matching
// real seller reports.
const PROFILE: Record<Exclude<MarketplaceId, "amazon">, {
  aovRange: [number, number];
  ordersPerDay: [number, number];
  returnRateRange: [number, number];
  ratingRange: [number, number];
}> = {
  flipkart: { aovRange: [420, 780], ordersPerDay: [8, 22], returnRateRange: [4, 11], ratingRange: [3.9, 4.5] },
};

export function generateMarketplaceOverview(
  id: Exclude<MarketplaceId, "amazon">,
  startDate: string,
  endDate: string
): MarketplaceOverview {
  const profile = PROFILE[id];
  const rng = makeRng([id, startDate, endDate]);
  const dates = eachDate(startDate, endDate);

  const [aovLo, aovHi] = profile.aovRange;
  const [opdLo, opdHi] = profile.ordersPerDay;

  let totalOrders = 0;
  let totalSales = 0;
  let totalUnits = 0;
  const trend: MarketplaceTrendPoint[] = dates.map((d) => {
    const ordersToday = Math.round(opdLo + rng() * (opdHi - opdLo));
    const aov = aovLo + rng() * (aovHi - aovLo);
    const unitsToday = Math.max(ordersToday, Math.round(ordersToday * (1 + rng() * 0.4)));
    const salesToday = Math.round(ordersToday * aov);
    totalOrders += ordersToday;
    totalSales += salesToday;
    totalUnits += unitsToday;
    return { rawDate: d, date: fmtDayLabel(d), sales: salesToday, orders: ordersToday, units: unitsToday };
  });

  const [rrLo, rrHi] = profile.returnRateRange;
  const returnRatePct = rrLo + rng() * (rrHi - rrLo);
  const [ratLo, ratHi] = profile.ratingRange;
  const rating = ratLo + rng() * (ratHi - ratLo);
  const growthPct = computeGrowthPct(trend.map((t) => t.sales));

  const topProducts: MarketplaceProduct[] = [...PRODUCT_NAMES]
    .sort(() => rng() - 0.5)
    .slice(0, 8)
    .map((name, i) => {
      const units = Math.round(20 + rng() * 400 * (1 - i * 0.08));
      const aov = aovLo + rng() * (aovHi - aovLo);
      return {
        name,
        sku: `${id.slice(0, 2).toUpperCase()}-${seedFromString(name + id).toString(36).slice(0, 6).toUpperCase()}`,
        units,
        sales: Math.round(units * aov),
        stock: Math.round(rng() * 250),
        rating: Math.round((3.2 + rng() * 1.7) * 10) / 10,
      };
    })
    .sort((a, b) => b.sales - a.sales);

  const states = [...INDIAN_STATES]
    .map((state) => {
      const orders = Math.round((totalOrders / INDIAN_STATES.length) * (0.4 + rng() * 1.3));
      return { state, orders, value: Math.round(orders * (aovLo + rng() * (aovHi - aovLo))) };
    })
    .sort((a, b) => b.value - a.value);

  return {
    id,
    totalSales,
    totalOrders,
    totalUnits,
    avgOrderValue: totalOrders ? totalSales / totalOrders : 0,
    returnRatePct,
    growthPct,
    rating,
    trend,
    topProducts,
    states,
  };
}

const ORDER_STATUSES: MarketplaceOrder["status"][] = ["Delivered", "Delivered", "Delivered", "Shipped", "RTO", "Cancelled", "Pending"];

export function generateMarketplaceOrders(
  id: Exclude<MarketplaceId, "amazon">,
  startDate: string,
  endDate: string,
  overview: MarketplaceOverview
): MarketplaceOrder[] {
  const rng = makeRng([id, startDate, endDate, "orders"]);
  const dates = eachDate(startDate, endDate);
  const orders: MarketplaceOrder[] = [];
  const profile = PROFILE[id];
  const [aovLo, aovHi] = profile.aovRange;

  dates.forEach((date) => {
    const point = overview.trend.find((t) => t.rawDate === date);
    const count = point ? point.orders : Math.round(profile.ordersPerDay[0]);
    for (let i = 0; i < count; i++) {
      const product = PRODUCT_NAMES[Math.floor(rng() * PRODUCT_NAMES.length)];
      const qty = 1 + Math.floor(rng() * 3);
      const amount = Math.round((aovLo + rng() * (aovHi - aovLo)) * (qty / 1.4));
      orders.push({
        orderId: `${id.slice(0, 2).toUpperCase()}${seedFromString(date + i + id).toString(36).slice(0, 8).toUpperCase()}`,
        date,
        product,
        qty,
        amount,
        status: ORDER_STATUSES[Math.floor(rng() * ORDER_STATUSES.length)],
        state: INDIAN_STATES[Math.floor(rng() * INDIAN_STATES.length)],
      });
    }
  });

  return orders.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export interface MarketplaceInventoryItem {
  name: string;
  sku: string;
  inStock: number;
  reserved: number;
  price: number;
  status: "In Stock" | "Low Stock" | "Out of Stock";
}

export function generateMarketplaceInventory(
  id: Exclude<MarketplaceId, "amazon">
): MarketplaceInventoryItem[] {
  const rng = makeRng([id, "inventory"]);
  const profile = PROFILE[id];
  const [aovLo, aovHi] = profile.aovRange;

  return PRODUCT_NAMES.map((name) => {
    const inStock = Math.round(rng() * 220);
    const reserved = Math.round(rng() * Math.min(inStock, 30));
    const status: MarketplaceInventoryItem["status"] =
      inStock === 0 ? "Out of Stock" : inStock < 20 ? "Low Stock" : "In Stock";
    return {
      name,
      sku: `${id.slice(0, 2).toUpperCase()}-${seedFromString(name + id + "inv").toString(36).slice(0, 6).toUpperCase()}`,
      inStock,
      reserved,
      price: Math.round((aovLo + rng() * (aovHi - aovLo)) / (1 + rng())),
      status,
    };
  }).sort((a, b) => a.inStock - b.inStock);
}

// ---------------------------------------------------------------------------
// Ad Campaigns, Rules & Bids for Flipkart
// ---------------------------------------------------------------------------

export interface MarketplaceCampaign {
  id: string;
  name: string;
  type: string; // PLA, PCA, Smart ROI, Smart Ads, Brand Ads
  status: "ENABLED" | "PAUSED";
  budget: number;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
  impressions: number;
  acos: number;
  roas: number;
}

export interface MarketplaceRule {
  id: string;
  name: string;
  type: "roas" | "stock" | "rto" | "negative" | "dayparting";
  condition: string;
  action: string;
  enabled: boolean;
  frequency: string;
  lastExecuted: string;
  impactEstimate: string;
  marketplace: Exclude<MarketplaceId, "amazon">;
}

export interface MarketplaceBidTarget {
  id: string;
  campaignName: string;
  target: string;
  matchType: string;
  currentBid: number;
  suggestedBid: number;
  spend: number;
  sales: number;
  acos: number;
  roas: number;
  recommendation: "Increase" | "Reduce" | "Pause" | "Optimal";
}

export function generateMarketplaceCampaigns(
  id: Exclude<MarketplaceId, "amazon">
): MarketplaceCampaign[] {
  const rng = makeRng([id, "campaigns"]);
  const campaignTypes = ["PLA (Product Listing Ads)", "PCA (Product Contextual Ads)", "Smart ROI", "Flipkart Brand Ads"];

  return [
    "High Conversion Top Sellers",
    "Seasonal Festive Boost",
    "New Product Discovery",
    "Competitor Keyword Conquesting",
    "Retargeting & Abandoned Cart",
    "Auto-Targeting Smart ROI",
    "Category Leader Push",
  ].map((baseName, index) => {
    const type = campaignTypes[index % campaignTypes.length];
    const budget = Math.round(500 + rng() * 4500);
    const spend = Math.round(budget * (0.4 + rng() * 0.55));
    const roas = Math.round((1.8 + rng() * 4.5) * 10) / 10;
    const sales = Math.round(spend * roas);
    const orders = Math.round(sales / 550);
    const clicks = Math.round(orders * (8 + rng() * 12));
    const impressions = Math.round(clicks * (25 + rng() * 50));
    const acos = sales ? Math.round((spend / sales) * 1000) / 10 : 0;

    return {
      id: `${id.slice(0, 2).toUpperCase()}-CMP-${100 + index}`,
      name: `[${id.toUpperCase()}] ${baseName}`,
      type,
      status: index === 3 ? "PAUSED" : "ENABLED",
      budget,
      spend,
      sales,
      orders,
      clicks,
      impressions,
      acos,
      roas,
    };
  });
}

export function generateMarketplaceRules(
  id: Exclude<MarketplaceId, "amazon">
): MarketplaceRule[] {
  return [
    {
      id: "fk-rule-1",
        name: "Flipkart Smart ROI Protection Guardrail",
        type: "roas",
        condition: "If Campaign ACOS > 35% over last 7 days",
        action: "Reduce bid by 12% automatically",
        enabled: true,
        frequency: "Daily at 02:00 AM",
        lastExecuted: "Today at 02:00 AM",
        impactEstimate: "Est. Savings ₹8,400/mo",
        marketplace: id,
      },
      {
        id: "fk-rule-2",
        name: "Low Inventory Campaign Pause",
        type: "stock",
        condition: "If SKU Stock < 10 units",
        action: "Pause Flipkart PLA & PCA Ads for SKU",
        enabled: true,
        frequency: "Every 2 hours",
        lastExecuted: "2 hours ago",
        impactEstimate: "Prevents wasted spend on out-of-stock SKUs",
        marketplace: id,
      },
      {
        id: "fk-rule-3",
        name: "High Performing PLA Bid Booster",
        type: "roas",
        condition: "If Target ROAS > 4.5x & Orders >= 5",
        action: "Increase bid by 15% (Max Bid ₹25)",
        enabled: true,
        frequency: "Every 12 hours",
        lastExecuted: "12 hours ago",
        impactEstimate: "+18% Revenue Scale",
        marketplace: id,
      },
      {
        id: "fk-rule-4",
        name: "Wasted Search Term Auto-Negation",
        type: "negative",
        condition: "If Search Term Clicks >= 12 & Orders = 0",
        action: "Add to Flipkart Negative Exact Keyword list",
        enabled: true,
        frequency: "Daily",
        lastExecuted: "Today at 03:00 AM",
        impactEstimate: "Est. Savings ₹5,200/mo",
        marketplace: id,
      },
      {
        id: "fk-rule-5",
        name: "Night Window Dayparting Schedule",
        type: "dayparting",
        condition: "Between 01:00 AM - 06:00 AM",
        action: "Lower bids by 35%",
        enabled: false,
        frequency: "Scheduled Daily",
        lastExecuted: "Not yet run",
        impactEstimate: "Est. Savings ₹3,100/mo",
        marketplace: id,
      },
    ];
}

export function generateMarketplaceBids(
  id: Exclude<MarketplaceId, "amazon">
): MarketplaceBidTarget[] {
  const rng = makeRng([id, "bids"]);
  const targets = [
    "ovulation kit 30 strips",
    "basal body thermometer",
    "speech therapy kit",
    "baby grooming 8 pcs",
    "postpartum belt",
    "sensory chew brush",
    "teether set silicone",
    "maternity support band",
  ];

  return targets.map((target, i) => {
    const currentBid = Math.round((8 + rng() * 14) * 10) / 10;
    const acos = Math.round((18 + rng() * 35) * 10) / 10;
    const roas = Math.round((100 / acos) * 10) / 10;
    const spend = Math.round(1500 + rng() * 8000);
    const sales = Math.round(spend * roas);
    
    let recommendation: MarketplaceBidTarget["recommendation"] = "Optimal";
    let suggestedBid = currentBid;

    if (acos > 40) {
      recommendation = "Reduce";
      suggestedBid = Math.round(currentBid * 0.8 * 10) / 10;
    } else if (roas > 4.2) {
      recommendation = "Increase";
      suggestedBid = Math.round(currentBid * 1.18 * 10) / 10;
    } else if (acos > 50 && roas < 1.8) {
      recommendation = "Pause";
      suggestedBid = 0;
    }

    return {
      id: `${id.slice(0, 2).toUpperCase()}-BID-${i + 1}`,
      campaignName: `[${id.toUpperCase()}] Smart ROI - ${target.split(" ")[0]}`,
      target,
      matchType: i % 2 === 0 ? "Exact" : "Broad",
      currentBid,
      suggestedBid,
      spend,
      sales,
      acos,
      roas,
      recommendation,
    };
  });
}

