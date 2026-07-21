// Flipkart & Meesho don't have a connected data source yet (no Seller/Supplier
// API keys — see Settings > Marketplace Connections), so every number here is
// deterministically generated demo data. It is seeded from the marketplace id
// + date range, so it stays stable while you browse a given period instead of
// re-randomizing on every render, and it swaps out for real numbers with zero
// UI changes once fetchFlipkartOverview/fetchMeeshoOverview are backed by a
// real API call.

export type MarketplaceId = "amazon" | "flipkart" | "meesho";
export type MarketplaceTab = MarketplaceId | "compare";

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
  meesho: {
    id: "meesho",
    label: "Meesho",
    shortLabel: "MS",
    tagline: "Demo · Connect API",
    color: "#9F2089",
    gradient: "from-[#9F2089] to-[#F43397]",
    bg: "bg-[#9F2089]/10",
    text: "text-[#9F2089]",
    border: "border-[#9F2089]/25",
  },
};

export const MOCK_MARKETPLACES: MarketplaceId[] = ["flipkart", "meesho"];

// ---------------------------------------------------------------------------
// Pathname helpers — the sidebar/topnav derive the active marketplace from
// the URL instead of duplicating it in state, so there is nothing to keep in
// sync.
// ---------------------------------------------------------------------------

export function getMarketplaceTab(pathname: string | null): MarketplaceTab {
  const p = pathname || "";
  if (p.startsWith("/dashboard/flipkart")) return "flipkart";
  if (p.startsWith("/dashboard/meesho")) return "meesho";
  if (p.startsWith("/dashboard/compare")) return "compare";
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

// Marketplace "personality" — Meesho skews to high order volume / low AOV /
// higher RTO, Flipkart sits mid-market, roughly matching real seller reports.
const PROFILE: Record<Exclude<MarketplaceId, "amazon">, {
  aovRange: [number, number];
  ordersPerDay: [number, number];
  returnRateRange: [number, number];
  ratingRange: [number, number];
}> = {
  flipkart: { aovRange: [420, 780], ordersPerDay: [8, 22], returnRateRange: [4, 11], ratingRange: [3.9, 4.5] },
  meesho: { aovRange: [220, 420], ordersPerDay: [15, 40], returnRateRange: [12, 26], ratingRange: [3.5, 4.2] },
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
