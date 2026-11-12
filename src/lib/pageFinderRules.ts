// What the header page search can find, and how it ranks matches. No imports, so it is testable.
// Only pages that work with uploaded data are listed — the SellerMate-only screens are hidden.

export interface PageEntry { label: string; href: string; group: string; keywords: string }

const PAGES: PageEntry[] = [
  { label: "Overall", href: "/dashboard/compare", group: "Overall", keywords: "all marketplaces summary total sales tacos" },
  { label: "Seasonal Analytics", href: "/dashboard/seasonal", group: "Overall", keywords: "season trend month year" },
  { label: "Ratings & Reviews", href: "/dashboard/ratings-reviews", group: "Overall", keywords: "stars rating review drop" },
  { label: "Master", href: "/dashboard/master", group: "Overall", keywords: "sku product master marketing" },
  { label: "Daily Ad Spend", href: "/dashboard/daily-ad-spend", group: "Overall", keywords: "ad spend report acos sku daily" },
  { label: "Settings", href: "/dashboard/settings", group: "Overall", keywords: "email alerts recipients notifications theme" },
  { label: "Amazon Overview", href: "/dashboard", group: "Amazon", keywords: "amazon sales orders returns ads" },
  { label: "Amazon Upload", href: "/dashboard/upload", group: "Amazon", keywords: "upload file report orders ads last 7 days" },
  { label: "Amazon Download", href: "/dashboard/reports", group: "Amazon", keywords: "download report excel weekly historical" },
  { label: "Inventory", href: "/dashboard/inventory", group: "Amazon", keywords: "stock fba available warehouse" },
  { label: "Consolidated Stock Sheet", href: "/dashboard/inventory/consolidated", group: "Amazon", keywords: "godown stock restock" },
  { label: "Flipkart Overview", href: "/dashboard/flipkart", group: "Flipkart", keywords: "flipkart sales orders returns" },
  { label: "Flipkart Upload", href: "/dashboard/flipkart/upload", group: "Flipkart", keywords: "flipkart upload fsn earn more" },
  { label: "Flipkart Download", href: "/dashboard/flipkart/reports", group: "Flipkart", keywords: "flipkart download report" },
  { label: "Flipkart Campaigns", href: "/dashboard/flipkart/campaigns", group: "Flipkart", keywords: "flipkart ads campaigns" },
  { label: "Meesho Overview", href: "/dashboard/meesho", group: "Meesho", keywords: "meesho sales orders" },
  { label: "Meesho Download", href: "/dashboard/meesho/reports", group: "Meesho", keywords: "meesho download report" },
  { label: "Shopify Overview", href: "/dashboard/shopify", group: "Shopify", keywords: "shopify website orders" },
  { label: "Google & Meta Ads", href: "/dashboard/shopify/sources", group: "Shopify", keywords: "google meta facebook ads spend roas" },
  { label: "Shopify Download", href: "/dashboard/shopify/reports", group: "Shopify", keywords: "shopify download report" },
];

/** Pages whose name or keywords contain every typed word. Exported for tests. */
export function findPages(query: string, pages: PageEntry[] = PAGES): PageEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = pages
    .map((p) => {
      const name = p.label.toLowerCase();
      const hay = `${name} ${p.group.toLowerCase()} ${p.keywords}`;
      if (!words.every((w) => hay.includes(w))) return null;
      const score = name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2;
      return { p, score };
    })
    .filter((x): x is { p: PageEntry; score: number } => !!x)
    .sort((a, b) => a.score - b.score);
  return scored.map((x) => x.p).slice(0, 8);
}
