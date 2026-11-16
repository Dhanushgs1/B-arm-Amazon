// Where each dashboard number comes from: the source in plain words, the Supabase tables it is read
// from, and how it is worked out. Shown by the "where is this from" box (components/SourceBox.tsx).
// Keep this in step with the loaders named beside each block — it describes them, it does not run them.

export interface SourceInfo {
  /** Where the data comes from, in plain words. */
  source: string;
  /** Supabase tables (or functions) it is read from. */
  tables: string[];
  /** How the number is worked out from those rows. */
  how: string;
}

export type SourceChannel = "amazon" | "flipkart" | "meesho" | "shopify" | "google" | "meta" | "barm";
export type SourceMetric = "sales" | "orders" | "returns" | "cancelled" | "netOrders" | "adSpend" | "adSales";

// Amazon, Flipkart and Meesho: every day the B-ARM ERP's monthly invoice reports cover uses the ERP's
// figures (mis_datas_mv — channelSummary.ts withMisInvoices); other days use the order reports.
const ERP = "B-ARM ERP MIS invoice reports for the days they cover";
const ERP_TABLE = "mis_datas_mv";
const ERP_SALES = "ERP days: invoice value incl. tax, before returns.";
const ERP_UNITS = "ERP days: the ERP's orders and units.";
const ERP_RETURNS = "ERP days: returns the ERP lists (refunded or credited).";
const ERP_NET = "ERP days: the ERP's Qty (sales − returns).";
const CANCEL_NOTE = "Always from the order reports — the ERP leaves cancelled orders out.";
const DAILY_FILL = "Days the orders table has not reached yet come from the daily \"Last 7 days\" upload.";
const SHOPIFY_TABLES = ["barm_shopify_orders_v2", "barm_shopify_orders_summary (function)"];
const AMAZON_AD_TABLES = ["barm_amazon_sp_advertised_product", "barm_amazon_sb_campaign", "barm_amazon_sd_campaign"];
const FK_AD_TABLES = ["barm_daily_fk_ads", "barm_flipkart_campaign_performance"];
const MEESHO_RETURN_TABLES = ["meesho_barm_return_intransit", "meesho_barm_return_ofd", "meesho_barm_return_delivered"];

// Sales side: channelSummary.ts (fetchAmazonSummary, fetchFlipkartAllSummary, fetchMeeshoSummary) and
// shopifyOrders.ts (fetchShopifyAllSummary). Ads side: overallData.ts (loadMarketplaceAds, loadSpendWindows).
export const OVERALL_SOURCES: Record<SourceChannel, Partial<Record<SourceMetric, SourceInfo>>> = {
  amazon: {
    sales: {
      source: `${ERP}; other days: Amazon orders + daily Amazon orders upload`,
      tables: [ERP_TABLE, "amazon_orders", "barm_daily_am_orders"],
      how: `${ERP_SALES} Other days: order item price × units, before returns. ${DAILY_FILL}`,
    },
    orders: {
      source: `${ERP}; other days: Amazon orders + daily Amazon orders upload`,
      tables: [ERP_TABLE, "amazon_orders", "barm_daily_am_orders"],
      how: `${ERP_UNITS} Other days: different order IDs, quantity added up, cancelled lines left out. ${DAILY_FILL}`,
    },
    returns: {
      source: `${ERP}; other days: Amazon returns reports (seller-fulfilled + FBA + Seller Flex)`,
      tables: [ERP_TABLE, "amazon_returns", "amazon_fba_returns", "amazon_seller_flex_return"],
      how: `${ERP_RETURNS} Other days: returned units from the three returns reports added up.`,
    },
    cancelled: {
      source: "Amazon orders + daily Amazon orders upload",
      tables: ["amazon_orders", "barm_daily_am_orders"],
      how: `Orders where every line is cancelled. ${CANCEL_NOTE}`,
    },
    netOrders: {
      source: `${ERP}; other days: Amazon orders and returns reports`,
      tables: [ERP_TABLE, "amazon_orders", "barm_daily_am_orders", "amazon_returns", "amazon_fba_returns", "amazon_seller_flex_return"],
      how: `${ERP_NET} Other days: units − all returned units.`,
    },
    adSpend: {
      source: "Uploaded Amazon ads reports (Sponsored Products, Brands, Display)",
      tables: AMAZON_AD_TABLES,
      how: "Sponsored Products spend + Brand/Display campaign spend not already split per SKU, × 1.18 for GST.",
    },
    adSales: {
      source: "Uploaded Amazon ads reports (Sponsored Products, Brands, Display)",
      tables: AMAZON_AD_TABLES,
      how: "Sales the ads reports credit to the campaigns (7-day sales for Sponsored Products).",
    },
  },
  flipkart: {
    sales: {
      source: `${ERP}; other days: Flipkart orders + daily Flipkart orders upload, priced from the Flipkart listings upload`,
      tables: [ERP_TABLE, "fk_orders", "barm_daily_fk_orders", "barm_flipkart_listings"],
      how: `${ERP_SALES} Other days: listing selling price × units (computed — the order report has no prices). ${DAILY_FILL}`,
    },
    orders: {
      source: `${ERP}; other days: Flipkart orders + daily Flipkart orders upload`,
      tables: [ERP_TABLE, "fk_orders", "barm_daily_fk_orders"],
      how: `${ERP_UNITS} Other days: different order IDs, quantity added up, cancelled and empty lines left out. ${DAILY_FILL}`,
    },
    returns: {
      source: `${ERP}; other days: Flipkart returns report`,
      tables: [ERP_TABLE, "fk_returns"],
      how: `${ERP_RETURNS} Other days: returned units by Return Requested Date.`,
    },
    cancelled: {
      source: "Flipkart orders + daily Flipkart orders upload",
      tables: ["fk_orders", "barm_daily_fk_orders"],
      how: `Orders where every line is cancelled. ${CANCEL_NOTE}`,
    },
    netOrders: {
      source: `${ERP}; other days: Flipkart orders and returns reports`,
      tables: [ERP_TABLE, "fk_orders", "barm_daily_fk_orders", "fk_returns"],
      how: `${ERP_NET} Other days: units − all returned units.`,
    },
    adSpend: {
      source: "Daily Flipkart ads upload; days before it began (13 Aug 2026) from the older campaign-performance upload",
      tables: FK_AD_TABLES,
      how: "Campaign spend added up, × 1.18 for GST.",
    },
    adSales: {
      source: "Daily Flipkart ads upload; days before it began (13 Aug 2026) from the older campaign-performance upload",
      tables: FK_AD_TABLES,
      how: "Revenue the ads report credits to the campaigns.",
    },
  },
  meesho: {
    sales: {
      source: `${ERP}; other days: Meesho orders + daily Meesho orders upload`,
      tables: [ERP_TABLE, "meesho_barm_ord", "barm_daily_ms_barm_orders"],
      how: `${ERP_SALES} Other days: Quantity × Supplier Listed Price, before returns.`,
    },
    orders: {
      source: `${ERP}; other days: Meesho orders + daily Meesho orders upload`,
      tables: [ERP_TABLE, "meesho_barm_ord", "barm_daily_ms_barm_orders"],
      how: `${ERP_UNITS} Other days: different order numbers, quantity added up, cancelled orders left out.`,
    },
    returns: {
      source: `${ERP}; other days: Meesho returns reports (in transit, out for delivery, delivered)`,
      tables: [ERP_TABLE, ...MEESHO_RETURN_TABLES],
      how: `${ERP_RETURNS} Other days: each returned sub-order counted once, courier returns (RTO) included.`,
    },
    cancelled: {
      source: "Meesho orders + daily Meesho orders upload",
      tables: ["meesho_barm_ord", "barm_daily_ms_barm_orders"],
      how: `Orders cancelled before shipping. ${CANCEL_NOTE}`,
    },
    netOrders: {
      source: `${ERP}; other days: Meesho orders and returns reports`,
      tables: [ERP_TABLE, "meesho_barm_ord", "barm_daily_ms_barm_orders", ...MEESHO_RETURN_TABLES],
      how: `${ERP_NET} Other days: units − all returned units.`,
    },
    adSpend: {
      source: "Daily Meesho ads upload (per SKU)",
      tables: ["barm_daily_ms_barm_ads"],
      how: "Spend added up, × 1.18 for GST.",
    },
    adSales: {
      source: "Daily Meesho ads upload + daily Meesho orders upload",
      tables: ["barm_daily_ms_barm_ads", "barm_daily_ms_barm_orders"],
      how: "Estimated: ad orders × that product's average Meesho price over the last 6 weeks (the ads report has no sales amount).",
    },
  },
  shopify: {
    sales: {
      source: "Shopify website orders, sent live by Shopify (webhook)",
      tables: SHOPIFY_TABLES,
      how: "Order total (with tax and shipping) of orders that are not cancelled. Test orders never count.",
    },
    orders: {
      source: "Shopify website orders, sent live by Shopify (webhook)",
      tables: SHOPIFY_TABLES,
      how: "Orders that are not cancelled, by order date in India time; units = item quantities added up.",
    },
    returns: {
      source: "Not tracked",
      tables: [],
      how: "Shopify has no returns data here, so it adds 0.",
    },
    cancelled: {
      source: "Shopify website orders, sent live by Shopify (webhook)",
      tables: SHOPIFY_TABLES,
      how: "Orders marked cancelled in Shopify.",
    },
    netOrders: {
      source: "Shopify website orders, sent live by Shopify (webhook)",
      tables: SHOPIFY_TABLES,
      how: "Units of orders that are not cancelled (no returns data to take off).",
    },
    adSpend: {
      source: "Daily Google Ads upload + daily Meta Ads upload",
      tables: ["barm_daily_google_ad_spend", "barm_daily_social_media"],
      how: "Google Ads spend + Meta Ads spend, × 1.18 for GST.",
    },
    adSales: {
      source: "Shopify orders tagged Google Ads or Meta Ads",
      tables: SHOPIFY_TABLES,
      how: "Sales of Shopify orders that came from Google Ads or Meta Ads, on the days spend is known.",
    },
  },
  google: {
    sales: {
      source: "Shopify website orders that came from Google Ads",
      tables: SHOPIFY_TABLES,
      how: "Order total of non-cancelled Shopify orders whose source is Google Ads. These sales are already inside Shopify's sales.",
    },
    orders: {
      source: "Shopify website orders that came from Google Ads",
      tables: SHOPIFY_TABLES,
      how: "Non-cancelled Shopify orders whose source is Google Ads.",
    },
    adSpend: {
      source: "Daily Google Ads upload (7-day and 1-day files)",
      tables: ["barm_daily_google_ad_spend"],
      how: "Spend per day worked out from the uploaded report windows, × 1.18 for GST. Days with no upload are not counted.",
    },
    adSales: {
      source: "Shopify website orders that came from Google Ads",
      tables: SHOPIFY_TABLES,
      how: "Sales of those orders on the days Google spend is known.",
    },
  },
  meta: {
    sales: {
      source: "Shopify website orders that came from Meta Ads",
      tables: SHOPIFY_TABLES,
      how: "Order total of non-cancelled Shopify orders whose source is Meta Ads. These sales are already inside Shopify's sales.",
    },
    orders: {
      source: "Shopify website orders that came from Meta Ads",
      tables: SHOPIFY_TABLES,
      how: "Non-cancelled Shopify orders whose source is Meta Ads.",
    },
    adSpend: {
      source: "Daily Meta Ads upload",
      tables: ["barm_daily_social_media"],
      how: "Spend per day worked out from the uploaded report windows, × 1.18 for GST. Days with no upload are not counted.",
    },
    adSales: {
      source: "Shopify website orders that came from Meta Ads",
      tables: SHOPIFY_TABLES,
      how: "Sales of those orders on the days Meta spend is known.",
    },
  },
  // The old B-ARM website (WooCommerce), before Shopify took over on 21 Sep 2026: barmSkuPeriodData.ts.
  barm: {
    sales: {
      source: "B-ARM website orders (WooCommerce export, history up to 21 Sep 2026)",
      tables: ["barm_online_orders"],
      how: "Order Total Amount counted once per order (includes shipping).",
    },
    orders: {
      source: "B-ARM website orders (WooCommerce export, history up to 21 Sep 2026)",
      tables: ["barm_online_orders"],
      how: "Orders = different order numbers; units = item quantities added up.",
    },
    returns: {
      source: "Not tracked",
      tables: [],
      how: "The website export has no returns data.",
    },
    netOrders: {
      source: "B-ARM website orders (WooCommerce export, history up to 21 Sep 2026)",
      tables: ["barm_online_orders"],
      how: "Same as units — there is no returns data to take off.",
    },
  },
};

export const SOURCE_CHANNEL_LABEL: Record<SourceChannel, string> = {
  amazon: "Amazon", flipkart: "Flipkart", meesho: "Meesho", shopify: "Shopify", google: "Google Ads", meta: "Meta Ads", barm: "B-ARM Website",
};

/** One line of the box: a channel's share of the number and where that share comes from. */
export interface SourcePart {
  label: string;
  /** This part's value, already formatted; left out when the box is about one channel only. */
  value?: string;
  info: SourceInfo;
  /** Last day this part's data reaches (yyyy-mm-dd), when known. */
  dataThrough?: string | null;
  /** The loader's own note for the selected dates (e.g. which days are ERP figures), when it gives one. */
  note?: string;
}

export interface SourceBoxData {
  title: string;
  value: string;
  /** How the parts become the number, for totals and ratios (e.g. "Ad spend ÷ sales"). */
  formula?: string;
  parts: SourcePart[];
  start: string;
  end: string;
}

/** Parts for a metric across several channels; channels with no entry for it are skipped. */
export function sourceParts<C extends SourceChannel>(
  metric: SourceMetric,
  channels: C[],
  valueOf?: (c: C) => string | undefined,
  dataThroughOf?: (c: C) => string | null | undefined,
  noteOf?: (c: C) => string | undefined,
): SourcePart[] {
  return channels.flatMap((c) => {
    const info = OVERALL_SOURCES[c][metric];
    return info ? [{ label: SOURCE_CHANNEL_LABEL[c], value: valueOf?.(c), info, dataThrough: dataThroughOf?.(c), note: noteOf?.(c) }] : [];
  });
}
