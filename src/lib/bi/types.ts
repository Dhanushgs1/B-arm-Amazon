// Shape of the executive dashboard's dataset (built on the server by bi/dataset.ts, analysed in the
// browser by bi/analytics.ts). Every series is aligned to `dates`; null = no data for that day
// (outside the channel's uploaded range), never "zero sales".

export type SalesChannelId = "amazon" | "flipkart" | "meesho" | "shopify" | "barm";
export type AdChannelId = "amazon" | "flipkart" | "meesho" | "google" | "meta";
export type Series = (number | null)[];

export interface BiChannel {
  id: SalesChannelId;
  label: string;
  /** How revenue is defined for this channel (shown in the UI). */
  basis: string;
  firstDate: string | null;
  dataThrough: string | null;
  revenue: Series;
  units: Series;
  returns: Series;
  /** null when this channel's returns are not tracked. */
  returnsTracked: boolean;
  /** Set when the channel has stopped (e.g. the old website after the move to Shopify): it stays in
   *  history but is left out of forecasts, freshness and the report end date. */
  closedNote?: string;
}

export interface BiProduct {
  channel: SalesChannelId;
  sku: string;
  name: string;
  category: string | null;
  /** Aligned to BiDataset.productDates; 0 = no sale that day (the channel has data for it). */
  units: number[];
  revenue: number[];
  returns: number[];
}

export interface BiAdChannel {
  id: AdChannelId;
  label: string;
  /** Spend before GST, and the sales the ad platform attributes to ads. null = no ad data that day. */
  spend: Series;
  sales: Series;
  adsThrough: string | null;
  /** How ad sales are counted for this channel. */
  salesBasis: string;
}

export interface BiCampaign {
  channel: AdChannelId;
  name: string;
  spend: number; // last 30 days, before GST
  sales: number;
  orders: number;
  prevSpend: number; // the 30 days before that
  prevSales: number;
}

export interface BiStock {
  sku: string;
  name: string;
  available: number;
  asOf: string | null;
}

/** Warehouse (godown) stock per master product: current_stock, replaced by current_stock_override
 *  where someone has edited it. */
export interface BiWarehouseStock {
  product: string;
  stock: number;
  source: "override" | "current_stock";
  asOf: string | null;
}

/** The report date window from the Intervals table (the same window the weekly reports use). */
export interface BiIntervals { from30: string; to30: string; from7: string; to7: string; setAt: string | null }

export interface BiDataset {
  generatedAt: string;
  /** Last day the dataset covers (yesterday in IST when built). */
  asOf: string;
  dates: string[];
  channels: BiChannel[];
  productDates: string[];
  products: BiProduct[];
  ads: BiAdChannel[];
  /** Range the campaign figures cover. */
  campaignWindow: { start: string; end: string; prevStart: string; prevEnd: string };
  campaigns: BiCampaign[];
  stock: BiStock[];
  warehouse: BiWarehouseStock[];
  intervals: BiIntervals | null;
  gstMultiplier: number;
  /** Sources that failed to load: shown on the page, and their figures are left out, not zeroed. */
  errors: { source: string; message: string }[];
  notes: string[];
}
