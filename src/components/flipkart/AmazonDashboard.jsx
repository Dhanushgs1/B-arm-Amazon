'use client';
import React, { use,  useState, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { 
  Upload, ShoppingBag, Database, Search, AlertCircle, CheckCircle, 
  BarChart2, Package, Trash2, Tag, TrendingUp, PieChart, MousePointerClick, 
  Award, Sliders, ArrowRight, Terminal, RefreshCw, Percent, DollarSign, 
  Globe, Calendar, Info, ShieldAlert, TrendingDown, Eye
} from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, Legend, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import AmazonPnlSection from './AmazonPnlSection';

// Helper mappings for converting SKUs to friendly names
function formatSkuToName(sku) {
  const mappings = {
    'LKN-HGOIL-200ML': 'Lakshmi Krishna Hair Growth Onion Oil 200ml',
    'LKN_32Herba_FBA': 'Lakshmi Krishna 32 Herbs Hair Growth Oil',
    'LKN_ABC & CHOCO MALT': 'Lakshmi Krishna ABC & Choco Malt Multi Grain Health Drink',
    'LKN-Weight-GAIN01': 'Lakshmi Krishna Weight Gain Powder 250g',
    'LKN-Gain 500gm': 'Lakshmi Krishna Weight Gain Powder 500g',
    'LKN_Nutrtion powder': 'Lakshmi Krishna Nutrition Malt Powder',
    'LKN-Weight-GAIN-1kg': 'Lakshmi Krishna Weight Gain Powder 1kg',
    'sunscreendrops50ml': 'Lakshmi Krishna Sunscreen Drops SPF 50 50ml',
    'LKN_Herb Shamp_FBA': 'Lakshmi Krishna Herbal Hair Growth Shampoo',
    'LKN Forehead Gel': 'Lakshmi Krishna Forehead Gel for Fine Lines',
    'LKN_Tur Wax': 'Lakshmi Krishna Turmeric Facial Wax Powder',
    'abcmalt-200g': 'Lakshmi Krishna ABC Malt 200g',
    'LKN_ABC_FBA': 'Lakshmi Krishna ABC Malt Health Drink',
    'Slim01': 'Lakshmi Krishna Slimming Powder 250g',
    'Slim01-500': 'Lakshmi Krishna Slimming Powder 500g',
    'LKN_Hair Nutrition powder': 'Lakshmi Krishna Hair Nutrition Mix Powder',
    'LKN-Hair frizz serum': 'Lakshmi Krishna Hair Frizz Control Serum',
    'LKN_Nalangu_FBA': 'Lakshmi Krishna Nalangu Maavu Traditional Herbal Bath Powder',
    'LKN-Redensyl serum': 'Lakshmi Krishna Redensyl Hair Growth Serum',
    'LKN_Saffron gel_FBA': 'Lakshmi Krishna Pure Saffron Gel',
    'LKN_GLUTATHIONE': 'Lakshmi Krishna Glutathione Skin Brightening Cream',
    'LKN-Gummies01': 'Lakshmi Krishna Hair & Nail Gummies 30s',
    '54-N90S-Z2EK': 'Lakshmi Krishna Nalangu Maavu Herbal Powder (200g)'
  };
  
  if (mappings[sku]) return mappings[sku];
  return 'Lakshmi Krishna ' + sku.replace(/[_-]/g, ' ')
    .replace(/\b[a-z]/g, letter => letter.toUpperCase())
    .replace(/\bFba\b/i, '(FBA)');
}

// Helper to determine ad type from campaign name
function parseAdType(campaignName) {
  const name = campaignName.toUpperCase();
  if (name.includes('-SB-') || name.includes(' SPONSORED BRANDS ') || name.includes(' BRANDS ')) {
    return 'Sponsored Brands';
  } else if (name.includes('-SD-') || name.includes(' DISPLAY ') || name.includes(' SPONSORED DISPLAY ')) {
    return 'Sponsored Display';
  } else {
    return 'Sponsored Products';
  }
}

export default function AmazonDashboard({ activeTab, supabaseUrl, supabaseKey, dateFrom, dateTo }) {
  const [amazonSearch, setAmazonSearch] = useState('');
  const [adSpendMapping, setAdSpendMapping] = useState({});
  const [mfgCostMapping, setMfgCostMapping] = useState({});
  const [campaignFilter, setCampaignFilter] = useState('all'); // 'all', 'enabled', 'paused'
  const [campaignSearch, setCampaignSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [amazonDailyChart, setAmazonDailyChart] = useState([]);

  // Local states for sync period
  const [syncFrom, setSyncFrom] = useState(dateFrom || "2026-06-01");
  const [syncTo, setSyncTo] = useState(dateTo || "2026-06-28");
  const [syncMode, setSyncMode] = useState("range"); // "range" or "single"

  useEffect(() => {
    if (dateFrom) setSyncFrom(dateFrom);
    if (dateTo) setSyncTo(dateTo);
  }, [dateFrom, dateTo]);


  // Sync state for SellerMate API
  const [syncState, setSyncState] = useState({
    loading: false,
    logs: [],
    progress: 0
  });

  const [toast, setToast] = useState({ message: '', type: '' });

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast({ message: '', type: '' }), 5000);
  };

  const [amazonCampaigns, setAmazonCampaigns] = useState([]);
  const [amazonAdvProducts, setAmazonAdvProducts] = useState([]);
  const [amazonProductsData, setAmazonProductsData] = useState([]);
  const [amazonDates, setAmazonDates] = useState({ txStart: null, txEnd: null, advStart: null, advEnd: null });

  // Dedicated Amazon tables state
  const [campaignsRows, setCampaignsRows] = useState([]);
  const [productsRows, setProductsRows] = useState([]);
  const [retailRows, setRetailRows] = useState([]);
  const [loadingDb, setLoadingDb] = useState(false);

  // Explorer states
  const [explorerTable, setExplorerTable] = useState('amazon_retail');
  const [explorerSearch, setExplorerSearch] = useState('');
  const [explorerPage, setExplorerPage] = useState(1);
  const rowsPerPage = 10;

  const [productFilter, setProductFilter] = useState('all'); // 'all', 'winner', 'loser'

  useEffect(() => {
    if (activeTab === 'amazon-overview' || activeTab === 'amazon-pnl' || activeTab === 'amazon-upload-data' || activeTab === 'amazon-products' || activeTab === 'amazon-campaigns') {
      fetchOverviewData();
      fetchAmazonData();
    }
  }, [activeTab]);

  async function fetchOverviewData() {
    if (!supabaseUrl || !supabaseKey) return;
    try {
      const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };
      
      const resAdv = await fetch(`${supabaseUrl}/rest/v1/amazon_ads_advertised_product_dashboard?select=advertised_product_sku,campaign_name,total_cost,sales,purchases,clicks,impressions,roas,date_start`, { headers });
      if (resAdv.ok) {
        const data = await resAdv.json();
        const bySkuMap = {};
        const byDateMap = {};
        
        data.forEach(row => {
          const sku = row.advertised_product_sku;
          const spend = Number(row.total_cost || 0);
          const dateStart = row.date_start;
          
          if (sku) {
            if (!bySkuMap[sku]) {
              bySkuMap[sku] = { sku, spend: 0, sales: 0, purchases: 0, clicks: 0, impressions: 0 };
            }
            bySkuMap[sku].spend += spend;
            bySkuMap[sku].sales += Number(row.sales || 0);
            bySkuMap[sku].purchases += Number(row.purchases || 0);
            bySkuMap[sku].clicks += Number(row.clicks || 0);
            bySkuMap[sku].impressions += Number(row.impressions || 0);
          }
          
          if (dateStart) {
            const date = dateStart.split('T')[0];
            if (!byDateMap[date]) {
              byDateMap[date] = { date, spend: 0, sales: 0, clicks: 0, impressions: 0 };
            }
            byDateMap[date].spend += spend;
            byDateMap[date].sales += Number(row.sales || 0);
            byDateMap[date].clicks += Number(row.clicks || 0);
            byDateMap[date].impressions += Number(row.impressions || 0);
          }
        });
        
        setAmazonAdvProducts(Object.values(bySkuMap).map(s => ({
          ...s,
          acos: s.sales > 0 ? (s.spend / s.sales * 100) : 0,
          ctr: s.impressions > 0 ? (s.clicks / s.impressions * 100) : 0,
        })).sort((a,b) => b.spend - a.spend));
        
        setAmazonDailyChart(Object.values(byDateMap).sort((a,b) => new Date(a.date) - new Date(b.date)));
      }

      // Fetch Transaction Data for dynamic P&L
      const resTx = await fetch(`${supabaseUrl}/rest/v1/amazon_transactions_dashboard?select=sku,description,quantity,product_sales,selling_fees,fba_fees`, { headers });
      if (resTx.ok) {
        const data = await resTx.json();
        const bySkuMap = {};
        data.forEach(row => {
          if (!row.sku || row.product_sales <= 0) return; // Only take actual sales
          if (!bySkuMap[row.sku]) {
            bySkuMap[row.sku] = { 
              sku: row.sku, 
              name: row.description || row.sku,
              quantity: 0, 
              productSales: 0, 
              sellingFees: 0, 
              fbaFees: 0 
            };
          }
          bySkuMap[row.sku].quantity += row.quantity || 0;
          bySkuMap[row.sku].productSales += row.product_sales || 0;
          bySkuMap[row.sku].sellingFees += Math.abs(row.selling_fees || 0);
          bySkuMap[row.sku].fbaFees += Math.abs(row.fba_fees || 0);
        });

        const pData = Object.values(bySkuMap).map(s => {
          const qty = s.quantity > 0 ? s.quantity : 1;
          const sellingPrice = s.productSales / qty;
          const amzFee = (s.sellingFees + s.fbaFees) / qty;
          const gst = sellingPrice * 0.18; // Approx 18% GST baseline
          const text = sellingPrice * 0.01; // 1% TCS
          
          return {
            name: s.name,
            sku: s.sku,
            quantity: s.quantity,
            sellingPrice: parseFloat(sellingPrice.toFixed(2)),
            gst: parseFloat(gst.toFixed(2)),
            amzFee: parseFloat(amzFee.toFixed(2)),
            tcs: parseFloat(text.toFixed(2)),
            adSpend: 0,
          };
        }).sort((a,b) => b.sellingPrice - a.sellingPrice);
        
        setAmazonProductsData(pData);
      }

      // Fetch dates
      try {
        const txAsc = await fetch(`${supabaseUrl}/rest/v1/amazon_transactions_dashboard?select=date_time&order=date_time.asc&limit=1`, { headers }).then(r => r.json());
        const txDesc = await fetch(`${supabaseUrl}/rest/v1/amazon_transactions_dashboard?select=date_time&order=date_time.desc&limit=1`, { headers }).then(r => r.json());
        
        const advAsc = await fetch(`${supabaseUrl}/rest/v1/amazon_ads_advertised_product_dashboard?select=date_start&order=date_start.asc&limit=1`, { headers }).then(r => r.json());
        const advDesc = await fetch(`${supabaseUrl}/rest/v1/amazon_ads_advertised_product_dashboard?select=date_end&order=date_end.desc&limit=1`, { headers }).then(r => r.json());

        setAmazonDates({
          txStart: txAsc?.[0]?.date_time?.split('T')[0] || null,
          txEnd: txDesc?.[0]?.date_time?.split('T')[0] || null,
          advStart: advAsc?.[0]?.date_start || null,
          advEnd: advDesc?.[0]?.date_end || null,
        });
      } catch (err) {
        console.error("Failed to fetch dates", err);
      }
    } catch (e) {
      console.error("Failed to fetch amazon data", e);
    }
  }

  async function fetchAmazonData() {
    if (!supabaseUrl || !supabaseKey) return;
    setLoadingDb(true);
    try {
      const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };
      
      const [resC, resP, resR] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/amazon_campaigns?select=*&limit=5000`, { headers }).then(r => r.json()),
        fetch(`${supabaseUrl}/rest/v1/amazon_products?select=*&limit=5000`, { headers }).then(r => r.json()),
        fetch(`${supabaseUrl}/rest/v1/amazon_retail?select=*&limit=5000`, { headers }).then(r => r.json())
      ]);

      if (Array.isArray(resC)) setCampaignsRows(resC);
      if (Array.isArray(resP)) setProductsRows(resP);
      if (Array.isArray(resR)) setRetailRows(resR);
    } catch (err) {
      console.error("Error loading Amazon tables:", err);
    } finally {
      setLoadingDb(false);
    }
  }

  const handleSellerMateSync = async () => {
    setSyncState({ loading: true, logs: [], progress: 10 });
    const log = (msg) => setSyncState(s => ({ ...s, logs: [...s.logs, `[${new Date().toLocaleTimeString()}] ${msg}`] }));

    try {
      log("Initializing connection to SellerMate.AI API...");
      
      // Calculate the list of dates to sync
      const datesToSync = [];
      if (syncMode === 'single') {
        datesToSync.push(syncFrom);
      } else {
        let current = new Date(syncFrom);
        const end = new Date(syncTo);
        let count = 0;
        while (current <= end && count < 90) {
          datesToSync.push(current.toISOString().split('T')[0]);
          current.setDate(current.getDate() + 1);
          count++;
        }
      }

      if (datesToSync.length === 0) {
        throw new Error("No valid dates selected for synchronization.");
      }

      const dateLogStr = syncMode === 'single' ? syncFrom : `${syncFrom} to ${syncTo}`;

      log("Fetching listing catalog and campaign registry from Supabase...");
      const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };
      
      const [dbProdsRes, dbCampsRes, dbAdsRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/amazon_products?select=asin,product_name`, { headers }).then(r => r.json()),
        fetch(`${supabaseUrl}/rest/v1/amazon_campaigns?select=campaign_id,campaign_name,ad_type`, { headers }).then(r => r.json()),
        fetch(`${supabaseUrl}/rest/v1/amazon_ads_advertised_product_dashboard?select=campaign_name,advertised_product_sku&limit=1000`, { headers }).then(r => r.json())
      ]);

      const uniqueAsins = {};
      const uniqueCamps = {};

      if (Array.isArray(dbAdsRes) && dbAdsRes.length > 0) {
        dbAdsRes.forEach(item => {
          if (item.advertised_product_sku) {
            uniqueAsins[item.advertised_product_sku] = formatSkuToName(item.advertised_product_sku);
          }
          if (item.campaign_name) {
            uniqueCamps[item.campaign_name] = {
              name: item.campaign_name,
              type: parseAdType(item.campaign_name)
            };
          }
        });
      }

      if (Array.isArray(dbProdsRes)) {
        dbProdsRes.forEach(p => {
          if (p.asin && p.product_name) {
            uniqueAsins[p.asin] = p.product_name;
          }
        });
      }
      if (Array.isArray(dbCampsRes)) {
        dbCampsRes.forEach(c => {
          if (c.campaign_name) {
            uniqueCamps[c.campaign_name] = {
              name: c.campaign_name,
              type: c.ad_type || 'Sponsored Products'
            };
          }
        });
      }

      if (Object.keys(uniqueAsins).length === 0) {
        const fallbacks = [
          { asin: 'B0GDQW22JN', name: 'Lakshmi Krishna Naturals Choco Malt 250g | Multi Grain Health Drink' },
          { asin: 'B0215606306037753', name: 'Lakshmi Krishna Lip Balm for Dark Lips & Hydration' },
          { asin: 'B09XXFACE1', name: 'Lakshmi Krishna Anti-Aging Face Cream 50g' },
          { asin: 'B08YYSHAMP', name: 'Lakshmi Krishna Hair Growth Onion Shampoo 200ml' }
        ];
        fallbacks.forEach(f => { uniqueAsins[f.asin] = f.name; });
      }

      if (Object.keys(uniqueCamps).length === 0) {
        const fallbacks = [
          { name: 'PS-SP-MAN-LKN-Gummies01-Phrase', type: 'Product' },
          { name: 'PS-SP-AUTO-LKN-ChocoMalt-02', type: 'Sponsored Products' },
          { name: 'PS-SP-MAN-LKN-FaceCream-03', type: 'Product' },
          { name: 'PS-SP-EXACT-LKN-Shampoo-04', type: 'Sponsored Products' }
        ];
        fallbacks.forEach(f => { uniqueCamps[f.name] = { name: f.name, type: f.type }; });
      }

      const asins = Object.entries(uniqueAsins).map(([asin, name]) => ({ asin, name }));
      const campaignNames = Object.entries(uniqueCamps).map(([name, item], index) => {
        let existingId = null;
        if (Array.isArray(dbCampsRes)) {
          const found = dbCampsRes.find(c => c.campaign_name === name);
          if (found) existingId = found.campaign_id;
        }
        return {
          id: existingId || String(185192639892700 + index),
          name,
          type: item.type
        };
      });

      log(`Loaded ${asins.length} active products and ${campaignNames.length} campaigns for sync...`);

      log(`Cleaning existing database records for selected period to prevent duplicates...`);
      let deleteQuery = '';
      if (syncMode === 'single') {
        deleteQuery = `date=eq.${syncFrom}`;
      } else {
        deleteQuery = `date=gte.${syncFrom}&date=lte.${syncTo}`;
      }
      
      const deleteHeaders = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };
      await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/amazon_campaigns?${deleteQuery}`, { method: 'DELETE', headers: deleteHeaders }),
        fetch(`${supabaseUrl}/rest/v1/amazon_products?${deleteQuery}`, { method: 'DELETE', headers: deleteHeaders }),
        fetch(`${supabaseUrl}/rest/v1/amazon_retail?${deleteQuery}`, { method: 'DELETE', headers: deleteHeaders })
      ]);

      const campaigns = [];
      const products = [];
      const retail = [];

      let rawRetailData = null;
      let rawCampaignData = null;
      let rawAdvProductData = null;

      try {
        // 1. Fetch credentials from Supabase
        const tokenRes = await fetch(`${supabaseUrl}/rest/v1/sellermate_tokens?select=*&id=eq.default`, { headers });
        if (!tokenRes.ok) throw new Error("Could not load tokens from Supabase");
        const tokenData = await tokenRes.json();
        
        if (tokenData && tokenData.length > 0) {
          const accessToken = tokenData[0].access_token;
          const workspaceId = tokenData[0].client_id || "6a055dc86fe615943b989e75";
          
          log("Connecting to SellerMate MCP SSE server...");
          const sseRes = await fetch("https://api.sellermate.ai/mcp/sse", {
            headers: { "Authorization": `Bearer ${accessToken}` }
          });
          
          if (sseRes.ok) {
            const reader = sseRes.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let endpointUrl = "";
            const pendingCallbacks = {};

            let resolveEndpoint;
            const endpointPromise = new Promise((resolve, reject) => {
              resolveEndpoint = resolve;
              setTimeout(() => reject(new Error("SSE endpoint timeout")), 8000);
            });

            const readStream = async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  buffer += decoder.decode(value, { stream: true });
                  const parts = buffer.split("\n\n");
                  buffer = parts.pop();

                  for (const part of parts) {
                    const lines = part.split("\n");
                    let event = "";
                    let data = "";
                    for (const line of lines) {
                      if (line.startsWith("event: ")) {
                        event = line.replace("event: ", "").trim();
                      } else if (line.startsWith("data: ")) {
                        data = line.replace("data: ", "").trim();
                      }
                    }
                    
                    if (event === "endpoint" && data) {
                      endpointUrl = "https://api.sellermate.ai" + data;
                      resolveEndpoint(endpointUrl);
                    } else if ((event === "" || event === "message") && data && endpointUrl) {
                      try {
                        const rpc = JSON.parse(data);
                        if (rpc.id && pendingCallbacks[rpc.id]) {
                          pendingCallbacks[rpc.id](rpc);
                          delete pendingCallbacks[rpc.id];
                        }
                      } catch(e) {}
                    }
                  }
                }
              } catch(e) {
                console.error("SSE stream read error:", e);
              }
            };

            // Start single reader loop
            readStream();

            // Wait for the endpointUrl to be resolved
            await endpointPromise;

            if (endpointUrl) {
              log("MCP session established! Initializing handshake...");
              
              const postJson = async (body) => {
                const postRes = await fetch(endpointUrl, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${accessToken}`
                  },
                  body: JSON.stringify(body)
                });
                if (!postRes.ok) {
                  throw new Error(`POST request failed with status ${postRes.status}`);
                }
                const text = await postRes.text();
                return text ? JSON.parse(text) : {};
              };

              // Handshake
              const initPromise = new Promise((resolve, reject) => {
                pendingCallbacks[1] = resolve;
                setTimeout(() => reject(new Error("Handshake timeout")), 8000);
              });

              await postJson({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2024-11-05",
                  capabilities: {},
                  clientInfo: { name: "LknDashboardClient", version: "1.0.0" }
                }
              });

              await initPromise;
              await postJson({ jsonrpc: "2.0", method: "notifications/initialized" });

              log("Resolving account context...");
              const contextPromise = new Promise((resolve, reject) => {
                pendingCallbacks[2] = resolve;
                setTimeout(() => reject(new Error("Context timeout")), 8000);
              });

              await postJson({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "get_user_context", arguments: {} }
              });

              const contextRes = await contextPromise;
              const userContext = JSON.parse(contextRes.result.content[0].text);
              const targetWorkspaceId = userContext.workspaces[0]?.id || workspaceId;
              const targetAccountId = userContext.workspaces[0]?.amazonAccounts[0]?.id || "6a0564dbe39dd28f972d3312";

              log("Fetching retail performance data...");
              const retailPromise = new Promise((resolve, reject) => {
                pendingCallbacks[3] = resolve;
                setTimeout(() => reject(new Error("Retail query timeout")), 15000);
              });
              await postJson({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                  name: "get_retail_product_performance",
                  arguments: {
                    workspace_id: targetWorkspaceId,
                    amazon_account_id: targetAccountId,
                    start_date: syncFrom,
                    end_date: syncTo
                  }
                }
              });
              const retailRes = await retailPromise;
              rawRetailData = JSON.parse(retailRes.result.content[0].text);

              log("Fetching campaign performance data...");
              const campaignPromise = new Promise((resolve, reject) => {
                pendingCallbacks[4] = resolve;
                setTimeout(() => reject(new Error("Campaign query timeout")), 15000);
              });
              await postJson({
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: {
                  name: "get_campaign_performance",
                  arguments: {
                    workspace_id: targetWorkspaceId,
                    amazon_account_id: targetAccountId,
                    start_date: syncFrom,
                    end_date: syncTo
                  }
                }
              });
              const campaignRes = await campaignPromise;
              rawCampaignData = JSON.parse(campaignRes.result.content[0].text);

              log("Fetching advertised product performance data...");
              const advPromise = new Promise((resolve, reject) => {
                pendingCallbacks[5] = resolve;
                setTimeout(() => reject(new Error("Advertised product query timeout")), 15000);
              });
              await postJson({
                jsonrpc: "2.0",
                id: 5,
                method: "tools/call",
                params: {
                  name: "get_advertised_product_performance",
                  arguments: {
                    workspace_id: targetWorkspaceId,
                    amazon_account_id: targetAccountId,
                    start_date: syncFrom,
                    end_date: syncTo
                  }
                }
              });
              const advRes = await advPromise;
              rawAdvProductData = JSON.parse(advRes.result.content[0].text);
            }
          }
        }
      } catch(e) {
        log(`Warning: Real API connection bypassed/failed (${e.message}).`);
      }

      if (rawRetailData && rawCampaignData) {
        log("Processing and writing real SellerMate API data to Supabase...");
        
        const rawRetailProducts = rawRetailData.products || rawRetailData.data || [];
        rawRetailProducts.forEach(p => {
          retail.push({
            date: p.date || p.report_date || p.date_start || syncFrom,
            asin: p.asin || p.parent_asin || "",
            product_name: p.product_name || p.title || p.sku || "",
            total_sales: Number(p.sales || p.revenue || p.ordered_revenue || 0),
            units_ordered: Number(p.units_ordered || p.units || p.ordered_units || 0),
            ad_spend: Number(p.ad_spend || p.spend || p.total_cost || 0),
            ad_sales: Number(p.ad_sales || 0),
            ad_orders: Number(p.ad_orders || 0),
            tacos: p.tacos ? Number(p.tacos) : 0
          });
        });

        const rawAdvProducts = rawAdvProductData?.products || rawAdvProductData?.data || [];
        rawAdvProducts.forEach(p => {
          const date = p.date || p.report_date || p.date_start || syncFrom;
          const spend = Number(p.spend || p.total_cost || 0);
          const adSales = Number(p.ad_sales || p.sales || 0);
          const orders = Number(p.orders || p.purchases || 0);
          const clicks = Number(p.clicks || 0);
          const impressions = Number(p.impressions || 0);

          products.push({
            date: date,
            asin: p.asin || p.advertised_product_sku || "",
            product_name: p.product_name || p.sku || "",
            spend,
            ad_sales: adSales,
            orders,
            impressions,
            clicks,
            acos: adSales > 0 ? parseFloat(((spend / adSales) * 100).toFixed(2)) : 0,
            roas: spend > 0 ? parseFloat((adSales / spend).toFixed(2)) : 0,
            ctr: impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(2)) : 0,
            cpc: clicks > 0 ? parseFloat((spend / clicks).toFixed(2)) : 0,
            cvr: clicks > 0 ? parseFloat(((orders / clicks) * 100).toFixed(2)) : 0
          });
        });

        const rawCampaigns = rawCampaignData.campaigns || rawCampaignData.data || [];
        rawCampaigns.forEach(c => {
          const date = c.date || c.report_date || c.date_start || syncFrom;
          const spend = Number(c.spend || c.total_cost || 0);
          const adSales = Number(c.ad_sales || c.sales || 0);
          const orders = Number(c.orders || c.purchases || 0);
          const clicks = Number(c.clicks || 0);
          const impressions = Number(c.impressions || 0);

          campaigns.push({
            date: date,
            campaign_id: c.campaign_id || c.id || "",
            campaign_name: c.campaign_name || c.name || "",
            ad_type: c.sponsored_type || c.type || "Product",
            status: c.status || "ENABLED",
            spend,
            ad_sales: adSales,
            orders,
            impressions,
            clicks,
            acos: adSales > 0 ? parseFloat(((spend / adSales) * 100).toFixed(2)) : 0,
            roas: spend > 0 ? parseFloat((adSales / spend).toFixed(2)) : 0,
            ctr: impressions > 0 ? parseFloat(((clicks / impressions) * 100).toFixed(2)) : 0,
            cpc: clicks > 0 ? parseFloat((spend / clicks).toFixed(2)) : 0,
            cvr: clicks > 0 ? parseFloat(((orders / clicks) * 100).toFixed(2)) : 0
          });
        });

      } else {
        throw new Error("SellerMate API connection failed. Sync aborted to prevent database contamination.");
      }

      setSyncState(s => ({ ...s, progress: 40 }));
      log(`Writing ${campaigns.length} Campaign records to amazon_campaigns...`);
      const writeHeaders = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' };
      
      const resC = await fetch(`${supabaseUrl}/rest/v1/amazon_campaigns`, {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify(campaigns)
      });
      if (!resC.ok) throw new Error("Failed to write to amazon_campaigns");

      setSyncState(s => ({ ...s, progress: 70 }));
      log(`Writing ${products.length} SKU records to amazon_products...`);
      const resP = await fetch(`${supabaseUrl}/rest/v1/amazon_products`, {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify(products)
      });
      if (!resP.ok) throw new Error("Failed to write to amazon_products");

      setSyncState(s => ({ ...s, progress: 90 }));
      log(`Writing ${retail.length} Retail sales records to amazon_retail...`);
      const resR = await fetch(`${supabaseUrl}/rest/v1/amazon_retail`, {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify(retail)
      });
      if (!resR.ok) throw new Error("Failed to write to amazon_retail");

      setSyncState(s => ({ ...s, progress: 100 }));
      log(`🎉 Data Sync Complete! Successfully refreshed data for ${dateLogStr}.`);
      showToast("Sync Successful!", "success");
      fetchAmazonData();
    } catch (err) {
      log(`❌ Error: ${err.message}`);
      showToast("Sync Failed: " + err.message, "error");
    } finally {
      setSyncState(s => ({ ...s, loading: false }));
    }
  };

  // Synced data dates range
  const syncDates = useMemo(() => {
    if (!retailRows || retailRows.length === 0) return { start: null, end: null };
    const dates = retailRows.map(r => r.date).filter(Boolean);
    if (dates.length === 0) return { start: null, end: null };
    dates.sort();
    return {
      start: dates[0],
      end: dates[dates.length - 1]
    };
  }, [retailRows]);

  // Aggregation of Amazon Products
  const aggregatedProducts = useMemo(() => {
    const map = {};
    const filteredRetail = retailRows.filter(r => r.date >= dateFrom && r.date <= dateTo);
    
    filteredRetail.forEach(row => {
      const asin = row.asin;
      if (!asin) return;
      if (!map[asin]) {
        map[asin] = { asin, name: row.product_name || asin, totalSales: 0, unitsOrdered: 0, adSpend: 0, adSales: 0, adOrders: 0 };
      }
      map[asin].totalSales += Number(row.total_sales || 0);
      map[asin].unitsOrdered += Number(row.units_ordered || 0);
      map[asin].adSpend += Number(row.ad_spend || 0);
      map[asin].adSales += Number(row.ad_sales || 0);
      map[asin].adOrders += Number(row.ad_orders || 0);
    });

    return Object.values(map).map(p => {
      const organicSales = Math.max(0, p.totalSales - p.adSales);
      return {
        ...p,
        organicSales,
        organicRatio: p.totalSales > 0 ? (organicSales / p.totalSales) * 100 : 0,
        roas: p.adSpend > 0 ? p.adSales / p.adSpend : 0,
        tacos: p.totalSales > 0 ? (p.adSpend / p.totalSales) * 100 : 0
      };
    }).filter(p => 
      p.asin.toLowerCase().includes(productSearch.toLowerCase()) || 
      p.name.toLowerCase().includes(productSearch.toLowerCase())
    );
  }, [retailRows, dateFrom, dateTo, productSearch]);

  // Aggregation of Amazon Campaigns
  const aggregatedCampaigns = useMemo(() => {
    const map = {};
    const filteredCampaigns = campaignsRows.filter(c => c.date >= dateFrom && c.date <= dateTo);
    
    filteredCampaigns.forEach(row => {
      const name = row.campaign_name;
      if (!name) return;
      if (!map[name]) {
        map[name] = { 
          id: row.campaign_id, 
          name, 
          adType: row.ad_type || 'Sponsored Products', 
          status: row.status || 'ENABLED', 
          spend: 0, 
          sales: 0, 
          orders: 0, 
          impressions: 0, 
          clicks: 0 
        };
      }
      map[name].spend += Number(row.spend || 0);
      map[name].sales += Number(row.ad_sales || 0);
      map[name].orders += Number(row.orders || 0);
      map[name].impressions += Number(row.impressions || 0);
      map[name].clicks += Number(row.clicks || 0);
    });

    return Object.values(map).map(c => ({
      ...c,
      ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
      cpc: c.clicks > 0 ? c.spend / c.clicks : 0,
      cvr: c.clicks > 0 ? (c.orders / c.clicks) * 100 : 0,
      roas: c.spend > 0 ? c.sales / c.spend : 0,
      acos: c.sales > 0 ? (c.spend / c.sales) * 100 : 0
    })).filter(c => {
      const matchSearch = c.name.toLowerCase().includes(campaignSearch.toLowerCase());
      if (campaignFilter === 'all') return matchSearch;
      if (campaignFilter === 'winner') return matchSearch && c.roas >= 2.5;
      if (campaignFilter === 'loser') return matchSearch && (c.roas < 1.5 || (c.spend > 100 && c.sales === 0));
      if (campaignFilter === 'watch') return matchSearch && c.roas < 2.5 && c.roas >= 1.5 && !(c.spend > 100 && c.sales === 0);
      return matchSearch;
    });
  }, [campaignsRows, dateFrom, dateTo, campaignSearch, campaignFilter]);

  // Format Helpers
  const formatCurrency = (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(val);

  const calculateDelta = (currVal, prevVal) => {
    if (prevVal === 0) return currVal > 0 ? 100 : 0;
    return ((currVal - prevVal) / prevVal) * 100;
  };

  // --- Data Calculations for Amazon Overview Dashboard ---
  const overviewMetrics = useMemo(() => {
    const currentRetail = retailRows.filter(r => r.date >= dateFrom && r.date <= dateTo);
    
    const dateDiff = new Date(dateTo) - new Date(dateFrom);
    const prevDateToObj = new Date(new Date(dateFrom).getTime() - 24 * 60 * 60 * 1000);
    const prevDateFromObj = new Date(prevDateToObj.getTime() - dateDiff);
    const prevDateFrom = prevDateFromObj.toISOString().split('T')[0];
    const prevDateTo = prevDateToObj.toISOString().split('T')[0];
    const prevRetail = retailRows.filter(r => r.date >= prevDateFrom && r.date <= prevDateTo);

    const calcStats = (rows) => rows.reduce((acc, row) => {
      acc.sales += Number(row.total_sales || 0);
      acc.units += Number(row.units_ordered || 0);
      acc.spend += Number(row.ad_spend || 0);
      acc.adSales += Number(row.ad_sales || 0);
      acc.adOrders += Number(row.ad_orders || 0);
      return acc;
    }, { sales: 0, units: 0, spend: 0, adSales: 0, adOrders: 0 });

    const curr = calcStats(currentRetail);
    const prev = calcStats(prevRetail);

    const organicSales = Math.max(0, curr.sales - curr.adSales);
    const prevOrganicSales = Math.max(0, prev.sales - prev.adSales);

    const chartMap = {};
    currentRetail.forEach(row => {
      const dStr = row.date;
      if (!dStr) return;
      if (!chartMap[dStr]) {
        chartMap[dStr] = { date: dStr, sales: 0, spend: 0, adSales: 0, organicSales: 0 };
      }
      chartMap[dStr].sales += Number(row.total_sales || 0);
      chartMap[dStr].spend += Number(row.ad_spend || 0);
      chartMap[dStr].adSales += Number(row.ad_sales || 0);
    });

    const chartData = Object.values(chartMap).map(c => {
      c.organicSales = Math.max(0, c.sales - c.adSales);
      return c;
    }).sort((a, b) => new Date(a.date) - new Date(b.date));

    const productMap = {};
    currentRetail.forEach(row => {
      const asin = row.asin;
      if (!asin) return;
      if (!productMap[asin]) {
        productMap[asin] = { name: row.product_name || asin, sales: 0, units: 0 };
      }
      productMap[asin].sales += Number(row.total_sales || 0);
      productMap[asin].units += Number(row.units_ordered || 0);
    });
    const topProducts = Object.values(productMap)
      .sort((a,b) => b.sales - a.sales)
      .slice(0, 4);

    const currentCampaigns = campaignsRows.filter(c => c.date >= dateFrom && c.date <= dateTo);
    const campaignPerfMap = {};
    currentCampaigns.forEach(row => {
      const name = row.campaign_name;
      if (!name) return;
      if (!campaignPerfMap[name]) {
        campaignPerfMap[name] = { name, spend: 0, sales: 0 };
      }
      campaignPerfMap[name].spend += Number(row.spend || 0);
      campaignPerfMap[name].sales += Number(row.ad_sales || 0);
    });
    const topCampaigns = Object.values(campaignPerfMap)
      .map(c => ({ ...c, roas: c.spend > 0 ? (c.sales / c.spend) : 0 }))
      .filter(c => c.spend > 0)
      .sort((a,b) => b.roas - a.roas)
      .slice(0, 2);

    const insights = [];
    
    let wastedSpend = 0;
    Object.values(campaignPerfMap).forEach(c => {
      if (c.spend > 100 && c.sales === 0) {
        wastedSpend += c.spend;
      }
    });
    if (wastedSpend > 0) {
      insights.push({
        title: 'High Wasted Spend Detected',
        issue: `₹${Math.round(wastedSpend).toLocaleString('en-IN')} was spent on keywords with zero sales. Consider pausing these campaigns.`,
        type: 'worry'
      });
    }

    const scaleCamp = topCampaigns[0];
    if (scaleCamp && scaleCamp.roas > 3) {
      insights.push({
        title: 'Winning Campaign Scaling',
        issue: `"${scaleCamp.name}" hit ${scaleCamp.roas.toFixed(2)}x ROAS! scale budgets to scaled levels.`,
        type: 'good'
      });
    }

    const tacos = curr.sales > 0 ? (curr.spend / curr.sales) * 100 : 0;
    if (tacos > 15) {
      insights.push({
        title: 'High TACOS Warning',
        issue: `Your TACOS is at ${tacos.toFixed(1)}%. Total ad spend is eating up too much of your total retail sales.`,
        type: 'worry'
      });
    }

    return {
      curr,
      prev,
      organicSales,
      prevOrganicSales,
      chartData,
      topProducts,
      topCampaigns,
      insights
    };
  }, [retailRows, campaignsRows, dateFrom, dateTo]);

  // Explorer aggregation
  const explorerRows = useMemo(() => {
    let source = [];
    if (explorerTable === 'amazon_retail') source = retailRows;
    else if (explorerTable === 'amazon_products') source = productsRows;
    else if (explorerTable === 'amazon_campaigns') source = campaignsRows;

    let filtered = source.filter(r => r.date >= dateFrom && r.date <= dateTo);

    if (explorerSearch) {
      const q = explorerSearch.toLowerCase();
      filtered = filtered.filter(row => {
        const pName = (row.product_name || row.campaign_name || '').toLowerCase();
        const ident = (row.asin || row.campaign_id || '').toLowerCase();
        return pName.includes(q) || ident.includes(q);
      });
    }

    return filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [explorerTable, retailRows, productsRows, campaignsRows, dateFrom, dateTo, explorerSearch]);

  const paginatedExplorerRows = useMemo(() => {
    const startIdx = (explorerPage - 1) * rowsPerPage;
    return explorerRows.slice(startIdx, startIdx + rowsPerPage);
  }, [explorerRows, explorerPage]);

  // --- Campaign & Product preset aggregations ---
  const campaignCounts = useMemo(() => {
    let winners = 0;
    let losers = 0;
    let watch = 0;
    const map = {};
    const filteredCampaigns = campaignsRows.filter(c => c.date >= dateFrom && c.date <= dateTo);
    filteredCampaigns.forEach(row => {
      const name = row.campaign_name;
      if (!name) return;
      if (!map[name]) map[name] = { spend: 0, sales: 0 };
      map[name].spend += Number(row.spend || 0);
      map[name].sales += Number(row.ad_sales || 0);
    });
    Object.values(map).forEach(c => {
      const roas = c.spend > 0 ? (c.sales / c.spend) : 0;
      if (roas >= 2.5) winners++;
      else if (roas < 1.5 || (c.spend > 100 && c.sales === 0)) losers++;
      else watch++;
    });
    return { winners, losers, watch };
  }, [campaignsRows, dateFrom, dateTo]);

  const productCounts = useMemo(() => {
    let winners = 0;
    let losers = 0;
    aggregatedProducts.forEach(p => {
      if (p.roas >= 2.5) winners++;
      else if (p.roas < 1.8 && p.adSpend > 0) losers++;
    });
    return { winners, losers };
  }, [aggregatedProducts]);

  const campaignLeakage = useMemo(() => {
    let totalWaste = 0;
    let count = 0;
    campaignsRows.filter(c => c.date >= dateFrom && c.date <= dateTo).forEach(row => {
      const roas = row.spend > 0 ? (row.ad_sales / row.spend) : 0;
      if (roas < 1.8 && row.spend > 0) {
        totalWaste += row.spend;
        count++;
      }
    });
    return { totalWaste, count };
  }, [campaignsRows, dateFrom, dateTo]);

  const getProductTrend = (asin) => {
    const pHistory = retailRows.filter(r => r.asin === asin && r.date >= dateFrom && r.date <= dateTo);
    return pHistory.sort((a,b) => new Date(a.date) - new Date(b.date)).map(r => ({ val: Number(r.total_sales || 0) }));
  };

  const getCampaignTrend = (cName) => {
    const cHistory = campaignsRows.filter(c => c.campaign_name === cName && c.date >= dateFrom && c.date <= dateTo);
    return cHistory.sort((a,b) => new Date(a.date) - new Date(b.date)).map(c => ({ val: Number(c.ad_sales || 0) }));
  };

  const renderTableSparkline = (trendData) => {
    if (!trendData || trendData.length < 2) return <span className="text-slate-300 font-bold">-</span>;
    const vals = trendData.map(d => d.val);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min === 0 ? 1 : max - min;
    const width = 60;
    const height = 20;
    const points = trendData.map((d, i) => {
      const x = (i / (trendData.length - 1)) * width;
      const y = height - ((d.val - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    }).join(' ');
    return (
      <svg width={width} height={height} className="mx-auto">
        <polyline fill="none" stroke="#ef4444" strokeWidth="1.5" points={points} />
      </svg>
    );
  };

  return (
    <div className="space-y-6 relative">
      {/* Toast Notification */}
      {toast.message && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 animate-fade-in-up">
          <div className={`px-6 py-3 rounded-full shadow-lg font-bold flex items-center gap-2 ${
            toast.type === 'error' ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
          }`}>
            {toast.type === 'error' ? <AlertCircle className="h-5 w-5" /> : <CheckCircle className="h-5 w-5" />}
            {toast.message}
          </div>
        </div>
      )}

      {/* OVERVIEW TAB */}
      {activeTab === 'amazon-overview' && (() => {
        const ov = overviewMetrics;
        const targetDailyGoal = 200000;
        const days = Math.ceil(Math.abs(new Date(dateTo) - new Date(dateFrom)) / (1000 * 60 * 60 * 24)) + 1 || 1;
        const dailyAvg = ov.curr.sales / days;
        const progressPct = Math.min(100, (dailyAvg / targetDailyGoal) * 100);
        const remaining = Math.max(0, targetDailyGoal - dailyAvg);
        const projectedMonthSales = dailyAvg * 30;
        const isOnTrack = dailyAvg >= targetDailyGoal;

        return (
          <div className="space-y-6 animate-fade-in-up">
            {/* Daily Revenue Target Tracker */}
            <div className="bg-gradient-to-br from-slate-900 via-slate-950 to-red-950 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4 text-white">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-red-500/20 text-red-300 border border-red-500/20">
                    <Award className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-extrabold text-white text-sm tracking-wide">Amazon Daily Revenue Target Tracker</h3>
                    <p className="text-xs text-slate-300 font-medium font-semibold">Goal: <span className="font-bold text-red-400">₹2,00,000 / Day</span></p>
                  </div>
                </div>
                <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg border ${
                  isOnTrack ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                }`}>
                  {isOnTrack ? '✅ On Track' : '⚠️ Below Target'}
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-end text-xs font-semibold text-slate-400">
                  <span>Progress: <span className="font-extrabold text-white">{progressPct.toFixed(1)}%</span></span>
                  <span>{formatCurrency(dailyAvg)} / {formatCurrency(targetDailyGoal)} per day</span>
                </div>
                <div className="w-full bg-slate-800 h-3.5 rounded-full overflow-hidden border border-slate-700 shadow-inner">
                  <div 
                    className={`h-full rounded-full transition-all duration-500 bg-gradient-to-r from-red-500 to-orange-400 shadow-[0_0_10px_rgba(239,68,68,0.5)]`}
                    style={{ width: `${progressPct}%` }}
                  ></div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] font-medium text-slate-400 pt-1">
                <div>
                  {progressPct >= 100 ? (
                    <span className="text-emerald-400 font-bold">🎉 Target Achieved! Excellent daily velocity.</span>
                  ) : (
                    <span>Remaining Daily Average: <span className="font-bold text-slate-200">{formatCurrency(remaining)}/day</span></span>
                  )}
                </div>
                <div className="text-red-200 font-bold">
                  {isOnTrack 
                    ? `On Track: Monthly run-rate is projected to hit ₹${Math.round(projectedMonthSales).toLocaleString('en-IN')}` 
                    : `Goal Projected: Monthly run-rate will reach ₹${Math.round(projectedMonthSales).toLocaleString('en-IN')} (Target: ₹60,00,000)`}
                </div>
              </div>
            </div>

            {/* Simplified & Clean Primary KPIs Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Card 1: Gross Sales */}
              <div 
                className="kpi-card border p-5 rounded-xl shadow-md text-white hover:scale-[1.01] transition-all duration-200" 
                style={{ background: 'linear-gradient(135deg, #b91c1c 0%, #991b1b 50%, #7f1d1d 100%)', borderColor: '#b91c1c' }}
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[11px] font-black uppercase text-red-100 tracking-wider font-semibold">Gross Sales</span>
                  <span className="p-2 bg-white/10 text-red-100 rounded-xl border border-white/10"><ShoppingBag className="w-4.5 h-4.5" /></span>
                </div>
                <div>
                  <h3 className="text-2xl sm:text-3xl font-black text-white">{formatCurrency(ov.curr.sales)}</h3>
                  <div className="text-[11px] font-bold text-red-100/90 uppercase tracking-wide mt-0.5">{ov.curr.units} Units sold</div>
                  <div className="flex items-center gap-1.5 mt-2.5 text-[10px] text-red-100/80 font-semibold">
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-extrabold border bg-white/10 border-white/20 text-white">
                      {calculateDelta(ov.curr.sales, ov.prev.sales) >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Math.abs(calculateDelta(ov.curr.sales, ov.prev.sales)).toFixed(1)}%
                    </span>
                    <span>vs previous period</span>
                  </div>
                </div>
              </div>

              {/* Card 2: Net Revenue (Gross minus Ad Spend) */}
              <div 
                className="kpi-card border p-5 rounded-xl shadow-md text-white hover:scale-[1.01] transition-all duration-200" 
                style={{ background: 'linear-gradient(135deg, #4f46e5 0%, #4338ca 50%, #312e81 100%)', borderColor: '#4f46e5' }}
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[11px] font-black uppercase text-indigo-100 tracking-wider font-semibold">Net Sales</span>
                  <span className="p-2 bg-white/10 text-indigo-100 rounded-xl border border-white/10"><Award className="w-4.5 h-4.5" /></span>
                </div>
                <div>
                  <h3 className="text-2xl sm:text-3xl font-black text-white">{formatCurrency(ov.curr.sales - ov.curr.spend)}</h3>
                  <div className="text-[11px] font-bold text-indigo-100/90 uppercase tracking-wide mt-0.5">After Ad Spend</div>
                  <div className="flex items-center gap-1.5 mt-2.5 text-[10px] text-indigo-100/80 font-semibold">
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-extrabold border bg-white/10 border-white/20 text-white">
                      {calculateDelta(ov.curr.sales - ov.curr.spend, ov.prev.sales - ov.prev.spend) >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Math.abs(calculateDelta(ov.curr.sales - ov.curr.spend, ov.prev.sales - ov.prev.spend)).toFixed(1)}%
                    </span>
                    <span>after cancels/returns</span>
                  </div>
                </div>
              </div>

              {/* Card 3: Ad Spend & Sales */}
              <div 
                className="kpi-card border p-5 rounded-xl shadow-md text-white hover:scale-[1.01] transition-all duration-200" 
                style={{ background: 'linear-gradient(135deg, #d97706 0%, #b45309 50%, #78350f 100%)', borderColor: '#d97706' }}
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[11px] font-black uppercase text-amber-100 tracking-wider font-semibold">Ad Spend & Sales</span>
                  <span className="p-2 bg-white/10 text-amber-100 rounded-xl border border-white/10"><Sliders className="w-4.5 h-4.5" /></span>
                </div>
                <div>
                  <h3 className="text-2xl sm:text-3xl font-black text-white">{formatCurrency(ov.curr.spend)}</h3>
                  <div className="text-[11px] font-bold text-amber-100/90 uppercase tracking-wide mt-0.5">Generated {formatCurrency(ov.curr.adSales)} Ad Sales</div>
                  <div className="flex items-center gap-1.5 mt-2.5 text-[10px] text-amber-100/80 font-semibold">
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-extrabold border bg-white/10 border-white/20 text-white">
                      ROAS: {ov.curr.spend > 0 ? (ov.curr.adSales / ov.curr.spend).toFixed(2) : 0}x
                    </span>
                    <span>ACOS: {ov.curr.adSales > 0 ? ((ov.curr.spend / ov.curr.adSales) * 100).toFixed(1) : 0}%</span>
                  </div>
                </div>
              </div>

              {/* Card 4: Organic Sales */}
              <div 
                className="kpi-card border p-5 rounded-xl shadow-md text-white hover:scale-[1.01] transition-all duration-200" 
                style={{ background: 'linear-gradient(135deg, #0d9488 0%, #0f766e 50%, #115e59 100%)', borderColor: '#0d9488' }}
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[11px] font-black uppercase text-teal-100 tracking-wider font-semibold">Organic Sales</span>
                  <span className="p-2 bg-white/10 text-teal-100 rounded-xl border border-white/10"><Globe className="w-4.5 h-4.5" /></span>
                </div>
                <div>
                  <h3 className="text-2xl sm:text-3xl font-black text-white">{formatCurrency(ov.organicSales)}</h3>
                  <div className="text-[11px] font-bold text-teal-100/90 uppercase tracking-wide mt-0.5">Ratio: {ov.curr.sales > 0 ? ((ov.organicSales / ov.curr.sales) * 100).toFixed(1) : 0}%</div>
                  <div className="flex items-center gap-1.5 mt-2.5 text-[10px] text-teal-100/80 font-semibold">
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-extrabold border bg-white/10 border-white/20 text-white">
                      {calculateDelta(ov.organicSales, ov.prevOrganicSales) >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Math.abs(calculateDelta(ov.organicSales, ov.prevOrganicSales)).toFixed(1)}%
                    </span>
                    <span>vs previous period</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Performance Trend & Insights Section */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Daily Sales Chart */}
              <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col justify-between">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3.5 mb-4">
                  <h3 className="font-extrabold text-slate-800 text-sm flex items-center gap-2">
                    <BarChart2 className="w-4.5 h-4.5 text-red-500" />
                    Performance Trend Chart
                  </h3>
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider bg-slate-50 border border-slate-200 px-3 py-1 rounded-full">Daily Aggregation</span>
                </div>

                <div className="h-64">
                  {ov.chartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={ov.chartData}>
                        <defs>
                          <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.2}/>
                            <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                          </linearGradient>
                          <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.2}/>
                            <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis dataKey="date" tick={{fontSize: 9, fontWeight: 700}} stroke="#94a3b8" />
                        <YAxis tickFormatter={v => '₹' + (v / 1000).toFixed(0) + 'k'} tick={{fontSize: 9, fontWeight: 700}} stroke="#94a3b8" />
                        <Tooltip 
                          formatter={(value) => [formatCurrency(value), '']}
                          contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px', color: '#fff', fontSize: '11px', fontWeight: 'bold' }} 
                        />
                        <Area type="monotone" dataKey="sales" name="Total Sales" stroke="#ef4444" strokeWidth={2.5} fillOpacity={1} fill="url(#salesGrad)" />
                        <Area type="monotone" dataKey="spend" name="Ad Spend" stroke="#f59e0b" strokeWidth={2} fillOpacity={1} fill="url(#spendGrad)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-slate-400 font-bold">No date points available in the current range.</div>
                  )}
                </div>
              </div>

              {/* Smart Insights Panel */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col justify-between">
                <div className="border-b border-slate-100 pb-3.5 mb-4">
                  <h3 className="font-extrabold text-slate-800 text-sm flex items-center gap-2">
                    <Tag className="w-4.5 h-4.5 text-indigo-500" />
                    Smart Insights
                  </h3>
                </div>
                <div className="flex-1 space-y-3.5 overflow-y-auto max-h-60 scrollbar-none pr-1">
                  {ov.insights.map((insight, idx) => (
                    <div 
                      key={idx} 
                      className={`flex gap-3 p-3.5 rounded-xl border text-xs font-semibold ${
                        insight.type === 'good' ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : 'bg-rose-50 border-rose-100 text-rose-800'
                      }`}
                    >
                      {insight.type === 'good' ? (
                        <CheckCircle className="h-5 w-5 shrink-0 text-emerald-600 mt-0.5" />
                      ) : (
                        <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 mt-0.5" />
                      )}
                      <div>
                        <div className="font-extrabold text-slate-900">{insight.title}</div>
                        <div className="mt-1 text-slate-600/90 leading-relaxed font-semibold">{insight.issue}</div>
                      </div>
                    </div>
                  ))}
                  {ov.insights.length === 0 && (
                    <div className="text-slate-400 italic py-16 text-center font-bold">No anomalies or price warnings flagged.</div>
                  )}
                </div>
              </div>
            </div>

            {/* Top Products & Top Campaigns Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Top Products */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3.5 mb-4">
                  <h3 className="font-extrabold text-slate-800 text-sm flex items-center gap-2">
                    <Package className="w-4.5 h-4.5 text-amber-500" />
                    Top Selling Products
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-150">
                        <th className="py-2.5 font-extrabold text-slate-500 uppercase tracking-wider">Product Name</th>
                        <th className="py-2.5 font-extrabold text-slate-500 uppercase tracking-wider text-right">Units</th>
                        <th className="py-2.5 font-extrabold text-slate-500 uppercase tracking-wider text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ov.topProducts.map((p, idx) => (
                        <tr key={idx} className="hover:bg-slate-50 transition-colors">
                          <td className="py-3 font-extrabold text-slate-800 max-w-xs truncate">{p.name}</td>
                          <td className="py-3 text-right font-semibold text-slate-500">{p.units}</td>
                          <td className="py-3 text-right font-bold text-slate-850">{formatCurrency(p.sales)}</td>
                        </tr>
                      ))}
                      {ov.topProducts.length === 0 && (
                        <tr>
                          <td colSpan={3} className="py-6 text-center text-slate-450 font-bold">No selling data found in the current date range.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Top Campaigns */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3.5 mb-4">
                  <h3 className="font-extrabold text-slate-800 text-sm flex items-center gap-2">
                    <Sliders className="w-4.5 h-4.5 text-indigo-500" />
                    Top Performing Campaigns
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-150">
                        <th className="py-2.5 font-extrabold text-slate-500 uppercase tracking-wider">Campaign Name</th>
                        <th className="py-2.5 font-extrabold text-slate-500 uppercase tracking-wider text-right">Spend</th>
                        <th className="py-2.5 font-extrabold text-slate-500 uppercase tracking-wider text-right">ROAS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ov.topCampaigns.map((c, idx) => (
                        <tr key={idx} className="hover:bg-slate-50 transition-colors">
                          <td className="py-3 font-extrabold text-slate-800 max-w-xs truncate">{c.name}</td>
                          <td className="py-3 text-right font-semibold text-slate-500">{formatCurrency(c.spend)}</td>
                          <td className="py-3 text-right">
                            <span className="bg-emerald-50 border border-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-black">{c.roas.toFixed(2)}x</span>
                          </td>
                        </tr>
                      ))}
                      {ov.topCampaigns.length === 0 && (
                        <tr>
                          <td colSpan={3} className="py-6 text-center text-slate-450 font-bold">No active campaigns found in the current date range.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* P&L ANALYZER TAB */}
      {activeTab === 'amazon-pnl' && (
        <div className="space-y-6 animate-fade-in-up">
          <AmazonPnlSection supabaseUrl={supabaseUrl} supabaseKey={supabaseKey} />
        </div>
      )}

      {/* PRODUCTS TAB */}
      {activeTab === 'amazon-products' && (
        <div className="space-y-6 animate-fade-in-up">
          {/* Top KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            {[
              { label: 'Catalog ASINs', value: aggregatedProducts.length, desc: 'Active in catalog' },
              { label: 'Total Revenue', value: formatCurrency(aggregatedProducts.reduce((s, p) => s + p.totalSales, 0)), desc: 'Overall sales' },
              { label: 'Organic Sales', value: formatCurrency(aggregatedProducts.reduce((s, p) => s + p.organicSales, 0)), desc: 'Non-advertising sales' },
              { label: 'Ad Spend', value: formatCurrency(aggregatedProducts.reduce((s, p) => s + p.adSpend, 0)), desc: 'Total ad investment' },
              { 
                label: 'Average ROAS', 
                value: (aggregatedProducts.reduce((s, p) => s + p.adSpend, 0) > 0 
                  ? (aggregatedProducts.reduce((s, p) => s + p.adSales, 0) / aggregatedProducts.reduce((s, p) => s + p.adSpend, 0)).toFixed(2) + 'x' 
                  : '0.00x'), 
                desc: 'Advertising return' 
              },
              { 
                label: 'Overall TACOS', 
                value: (aggregatedProducts.reduce((s, p) => s + p.totalSales, 0) > 0 
                  ? ((aggregatedProducts.reduce((s, p) => s + p.adSpend, 0) / aggregatedProducts.reduce((s, p) => s + p.totalSales, 0)) * 100).toFixed(2) + '%' 
                  : '0.00%'), 
                desc: 'Ad spend vs total revenue' 
              }
            ].map((kpi, idx) => (
              <div key={idx} className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
                <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">{kpi.label}</span>
                <span className="text-xl sm:text-2xl font-black text-slate-800 block mt-1">{kpi.value}</span>
                <span className="text-[10px] font-semibold text-slate-400 block mt-1">{kpi.desc}</span>
              </div>
            ))}
          </div>

          {/* Clickable Filter Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={() => setProductFilter(productFilter === 'winner' ? 'all' : 'winner')}
              className={`rounded-xl p-4 flex items-center justify-between border transition cursor-pointer text-left ${
                productFilter === 'winner'
                  ? 'bg-emerald-100 border-emerald-500 ring-2 ring-emerald-400'
                  : 'bg-emerald-50 border-slate-200 hover:border-emerald-450'
              }`}
            >
              <div>
                <span className="text-xs uppercase font-extrabold text-slate-400 tracking-wider font-semibold">Winning ASINs</span>
                <h4 className="text-2xl font-extrabold text-emerald-700 mt-0.5">{productCounts.winners} Winners</h4>
              </div>
              <span className="text-[10px] font-extrabold bg-emerald-600 text-white px-2 py-0.5 rounded border border-emerald-700 uppercase tracking-wide">Scale up ↑</span>
            </button>

            <button
              onClick={() => setProductFilter(productFilter === 'loser' ? 'all' : 'loser')}
              className={`rounded-xl p-4 flex items-center justify-between border transition cursor-pointer text-left ${
                productFilter === 'loser'
                  ? 'bg-rose-100 border-rose-500 ring-2 ring-rose-400'
                  : 'bg-rose-50 border-slate-200 hover:border-rose-450'
              }`}
            >
              <div>
                <span className="text-xs uppercase font-extrabold text-slate-400 tracking-wider font-semibold">Losing ASINs</span>
                <h4 className="text-2xl font-extrabold text-rose-700 mt-0.5">{productCounts.losers} Losers</h4>
              </div>
              <span className="text-[10px] font-extrabold bg-rose-600 text-white px-2 py-0.5 rounded border border-rose-700 uppercase tracking-wide">Pause ads</span>
            </button>
          </div>

          {/* Table Container */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4 bg-slate-50">
              <div className="relative w-full sm:w-80">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input 
                  type="text" 
                  value={productSearch}
                  onChange={e => setProductSearch(e.target.value)}
                  placeholder="Search ASIN or product..." 
                  className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg w-full text-xs font-semibold focus:outline-none focus:border-red-505 bg-white"
                />
              </div>
              <span className="text-xs font-bold text-slate-500 bg-white border border-slate-200 px-3 py-1 rounded-full">
                {aggregatedProducts
                  .filter(p => productFilter === 'all' ? true : p.roas >= 2.5 ? productFilter === 'winner' : productFilter === 'loser')
                  .filter(p => p.name.toLowerCase().includes(productSearch.toLowerCase()) || p.asin.toLowerCase().includes(productSearch.toLowerCase()))
                  .length} ASINs displayed
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[1000px] text-xs">
                <thead>
                  <tr className="bg-white border-b border-slate-200">
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider">Product Details</th>
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-center">7-Day Trend</th>
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-right">Spend</th>
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-right">Ad Sales</th>
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-right">Organic Sales</th>
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-right">Total Revenue</th>
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-center">Ad ROAS</th>
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-right">Total Orders</th>
                    <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-center">Recommendation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {aggregatedProducts
                    .filter(p => productFilter === 'all' ? true : p.roas >= 2.5 ? productFilter === 'winner' : productFilter === 'loser')
                    .filter(p => p.name.toLowerCase().includes(productSearch.toLowerCase()) || p.asin.toLowerCase().includes(productSearch.toLowerCase()))
                    .map((p, idx) => {
                      const trend = getProductTrend(p.asin);
                      const isWinner = p.roas >= 2.5;
                      const statusStyle = isWinner 
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                        : 'bg-rose-50 text-rose-700 border-rose-100';
                      const statusLabel = isWinner ? 'SCALE ADS ↑' : 'PAUSE ADS';

                      return (
                        <tr key={idx} className="hover:bg-slate-50 transition-colors">
                          <td className="py-3.5 px-4 max-w-sm">
                            <div className="font-extrabold text-slate-800 truncate">{p.name}</div>
                            <div className="text-[10px] font-black text-slate-400 mt-0.5 uppercase font-mono">ASIN: {p.asin}</div>
                          </td>
                          <td className="py-3.5 px-4 text-center">{renderTableSparkline(trend)}</td>
                          <td className="py-3.5 px-4 text-right">{formatCurrency(p.adSpend)}</td>
                          <td className="py-3.5 px-4 text-right text-emerald-600 font-bold">{formatCurrency(p.adSales)}</td>
                          <td className="py-3.5 px-4 text-right">{formatCurrency(p.organicSales)}</td>
                          <td className="py-3.5 px-4 text-right font-bold text-slate-850">{formatCurrency(p.totalSales)}</td>
                          <td className="py-3.5 px-4 text-center">
                            <span className={`px-2 py-0.5 rounded border font-black ${
                              p.roas >= 2.5 ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-rose-50 text-rose-700 border-rose-100'
                            }`}>{p.roas.toFixed(2)}x</span>
                          </td>
                          <td className="py-3.5 px-4 text-right text-slate-500">{p.unitsOrdered}</td>
                          <td className="py-3.5 px-4 text-center">
                            <span className={`px-2 py-0.5 rounded border font-black text-[9px] uppercase ${statusStyle}`}>{statusLabel}</span>
                          </td>
                        </tr>
                      );
                    })}
                  {aggregatedProducts.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-slate-450 font-bold">No products found in current selection.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* CAMPAIGNS TAB */}
      {activeTab === 'amazon-campaigns' && (() => {
        const leak = campaignLeakage;

        return (
          <div className="space-y-6 animate-fade-in-up">
            {/* Waste Alert Banner */}
            <div className="bg-red-50 border border-red-200 rounded-xl p-5 flex items-center justify-between flex-col md:flex-row gap-4 shadow-xs">
              <div className="flex items-center gap-4">
                <span className="h-12 w-12 bg-red-105 border border-red-200 text-red-600 rounded-full flex items-center justify-center shrink-0">
                  <ShieldAlert className="h-6 w-6" />
                </span>
                <div>
                  <h4 className="font-extrabold text-slate-900 text-base">Campaign Spend Leakage Detected</h4>
                  <p className="text-xs text-slate-500 mt-0.5">Pause campaigns matching ROAS &lt; 1.8 to conserve ad capital immediately.</p>
                </div>
              </div>
              <div className="text-center md:text-right shrink-0">
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Total Active Waste</span>
                <h3 className="text-2xl font-extrabold text-red-600 leading-none mt-1">{formatCurrency(leak.totalWaste)}</h3>
              </div>
            </div>

            {/* Top KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              {[
                { label: 'Active Campaigns', value: aggregatedCampaigns.filter(c => c.status === 'ENABLED').length, desc: 'Syncing live states' },
                { label: 'Total PPC Spend', value: formatCurrency(aggregatedCampaigns.reduce((s, c) => s + c.spend, 0)), desc: 'Accumulated ad cost' },
                { label: 'Total PPC Sales', value: formatCurrency(aggregatedCampaigns.reduce((s, c) => s + c.sales, 0)), desc: 'Sales driven by ads' },
                { 
                  label: 'Overall ROAS', 
                  value: (aggregatedCampaigns.reduce((s, c) => s + c.spend, 0) > 0 
                    ? (aggregatedCampaigns.reduce((s, c) => s + c.sales, 0) / aggregatedCampaigns.reduce((s, c) => s + c.spend, 0)).toFixed(2) + 'x' 
                    : '0.00x'), 
                  desc: 'Sponsored products ROAS' 
                },
                { 
                  label: 'Overall ACoS', 
                  value: (aggregatedCampaigns.reduce((s, c) => s + c.sales, 0) > 0 
                    ? ((aggregatedCampaigns.reduce((s, c) => s + c.spend, 0) / aggregatedCampaigns.reduce((s, c) => s + c.sales, 0)) * 100).toFixed(2) + '%' 
                    : '0.00%'), 
                  desc: 'Ad spend vs ad sales' 
                }
              ].map((kpi, idx) => (
                <div key={idx} className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">{kpi.label}</span>
                  <span className="text-xl sm:text-2xl font-black text-slate-800 block mt-1">{kpi.value}</span>
                  <span className="text-[10px] font-semibold text-slate-400 block mt-1">{kpi.desc}</span>
                </div>
              ))}
            </div>

            {/* Campaign Master Filter & Search */}
            <div className="flex flex-col md:flex-row gap-4 mb-4">
              <div className="flex bg-slate-100 p-1 rounded-lg border border-slate-250 overflow-x-auto w-full md:w-auto">
                <button 
                  onClick={() => setCampaignFilter(campaignFilter === 'winner' ? 'all' : 'winner')}
                  className={"flex-grow md:flex-grow-0 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-xs font-bold transition-all whitespace-nowrap cursor-pointer " + (campaignFilter === 'winner' ? 'bg-white text-emerald-600 shadow-xs' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50')}
                >
                  <TrendingUp className="w-3.5 h-3.5" />
                  Winning Campaigns
                  <span className="bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-black">{campaignCounts.winners}</span>
                </button>
                <button 
                  onClick={() => setCampaignFilter(campaignFilter === 'loser' ? 'all' : 'loser')}
                  className={"flex-grow md:flex-grow-0 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-xs font-bold transition-all whitespace-nowrap cursor-pointer " + (campaignFilter === 'loser' ? 'bg-white text-rose-600 shadow-xs' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50')}
                >
                  <TrendingDown className="w-3.5 h-3.5" />
                  Losing Campaigns
                  <span className="bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-black">{campaignCounts.losers}</span>
                </button>
                <button 
                  onClick={() => setCampaignFilter(campaignFilter === 'watch' ? 'all' : 'watch')}
                  className={"flex-grow md:flex-grow-0 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-xs font-bold transition-all whitespace-nowrap cursor-pointer " + (campaignFilter === 'watch' ? 'bg-white text-amber-600 shadow-xs' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50')}
                >
                  <Eye className="w-3.5 h-3.5" />
                  Watchlist
                  <span className="bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-black">{campaignCounts.watch}</span>
                </button>
              </div>
              
              <div className="relative flex-grow">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-4 w-4 text-slate-400" />
                </div>
                <input
                  type="text"
                  className="block w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg bg-white text-xs placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 text-slate-800 font-semibold transition-shadow shadow-xs"
                  placeholder="Search campaigns by name..."
                  value={campaignSearch}
                  onChange={(e) => setCampaignSearch(e.target.value)}
                />
              </div>
            </div>

            {/* Master Campaign Table */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
              <div className="p-4 border-b border-slate-200 bg-slate-50">
                <div className="flex items-center gap-2">
                  <span className={"h-2 w-2 rounded-full " + (campaignFilter === 'winner' ? 'bg-emerald-500' : campaignFilter === 'loser' ? 'bg-rose-500' : campaignFilter === 'watch' ? 'bg-amber-500' : 'bg-red-500')}></span>
                  <h3 className="font-extrabold text-slate-800 text-sm tracking-wide">
                    {campaignFilter === 'winner' ? 'Winning Campaigns (Scaling)' : 
                     campaignFilter === 'loser' ? 'Losing Campaigns (Pause/Reduce)' : 
                     campaignFilter === 'watch' ? 'Watchlist Campaigns (Maintain)' : 
                     'All Campaigns'}
                  </h3>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[1000px] text-xs">
                  <thead>
                    <tr className="bg-white border-b border-slate-200">
                      <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider">Campaign Name</th>
                      <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-center">7-Day Trend</th>
                      <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-right">Spend</th>
                      <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-right">Sales</th>
                      <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-center">ROAS</th>
                      <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-right">Orders</th>
                      <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-center">Match Type</th>
                      <th className="py-3 px-4 font-extrabold text-slate-500 uppercase tracking-wider text-center">Recommendation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                    {aggregatedCampaigns.map((c, idx) => {
                      const trend = getCampaignTrend(c.name);
                      const isWinner = c.roas >= 2.5;
                      const isLoser = c.roas < 1.5 || (c.spend > 100 && c.sales === 0);
                      
                      const statusStyle = isWinner 
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                        : isLoser 
                          ? 'bg-rose-50 text-rose-700 border-rose-100'
                          : 'bg-amber-50 text-amber-700 border-amber-100';
                      
                      const statusLabel = isWinner ? 'SCALE BUDGET ↑' : isLoser ? 'PAUSE BUDGET' : 'MAINTAIN';

                      return (
                        <tr key={idx} className="hover:bg-slate-50 transition-colors cursor-pointer">
                          <td className="py-3.5 px-4 max-w-xs">
                            <div className="font-extrabold text-slate-800 truncate">{c.name}</div>
                            <div className="flex items-center gap-1.5 mt-1">
                              <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded ${
                                c.status === 'ENABLED' ? 'bg-emerald-500/20 text-emerald-700' : 'bg-slate-200 text-slate-600'
                              }`}>{c.status}</span>
                              <span className="text-[9px] font-black text-slate-400 uppercase">{c.adType}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-center">{renderTableSparkline(trend)}</td>
                          <td className="py-3.5 px-4 text-right">{formatCurrency(c.spend)}</td>
                          <td className="py-3.5 px-4 text-right text-emerald-600 font-bold">{formatCurrency(c.sales)}</td>
                          <td className="py-3.5 px-4 text-center">
                            <span className={`px-2 py-0.5 rounded border font-black ${
                              c.roas >= 2.5 ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : c.roas < 1.5 ? 'bg-rose-50 text-rose-700 border-rose-100' : 'bg-amber-50 text-amber-700 border-amber-100'
                            }`}>{c.roas.toFixed(2)}x</span>
                          </td>
                          <td className="py-3.5 px-4 text-right text-slate-500">{c.orders}</td>
                          <td className="py-3.5 px-4 text-center text-slate-400 font-bold uppercase">{c.adType.includes('Sponsored') ? 'Auto/Keyword' : 'Targeted'}</td>
                          <td className="py-3.5 px-4 text-center">
                            <span className={`px-2 py-0.5 rounded border font-black text-[9px] uppercase ${statusStyle}`}>{statusLabel}</span>
                          </td>
                        </tr>
                      );
                    })}
                    {aggregatedCampaigns.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-slate-450 font-bold">No campaigns found in current selection.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {/* UPLOAD / INTEGRATION TAB */}
      {activeTab === 'amazon-upload-data' && (
        <div className="space-y-8 animate-fade-in-up">
          <div className="bg-slate-900 text-white rounded-xl p-6 shadow-xs relative overflow-hidden">
            <div className="absolute right-0 bottom-0 opacity-10 transform translate-x-4 translate-y-4">
              <Database className="h-48 w-48 text-indigo-500" />
            </div>
            <div className="relative z-10 space-y-2 max-w-2xl">
              <span className="bg-indigo-500/20 text-indigo-400 px-2.5 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wide">
                SellerMate.AI API Integration
              </span>
              <h2 className="text-xl sm:text-2xl font-extrabold">Live Amazon Data Synchronization</h2>
              <p className="text-xs sm:text-sm text-slate-400 font-semibold leading-relaxed">
                Connect your Amazon Ads account and retail databases to SellerMate.AI. Live reporting aggregates campaigns, listings catalog, and sales hourly.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Connection Credentials Card */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs flex flex-col justify-between border-t-4 border-t-red-600">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-extrabold text-slate-800 text-sm">Integration Status</h3>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-black bg-emerald-500/20 text-emerald-700 border border-emerald-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
                    Connected
                  </span>
                </div>

                <div className="space-y-3.5 text-xs">
                  <div>
                    <label className="text-[10px] font-extrabold text-slate-400 uppercase block">Endpoint</label>
                    <span className="font-mono text-slate-700 block mt-0.5 break-all">https://api.sellermate.ai/mcp/sse</span>
                  </div>
                  <div>
                    <label className="text-[10px] font-extrabold text-slate-400 uppercase block">API Token</label>
                    <span className="font-mono text-slate-500 block mt-0.5 break-all">sm_live_mdzwmEEc...B4LAQEIftW73o</span>
                  </div>
                  <div>
                    <label className="text-[10px] font-extrabold text-slate-400 uppercase block">Workspace ID</label>
                    <span className="font-mono text-slate-700 block mt-0.5">6a055dc86fe615943b989e75</span>
                  </div>
                  <div>
                    <label className="text-[10px] font-extrabold text-slate-400 uppercase block">Account ID</label>
                    <span className="font-mono text-slate-700 block mt-0.5">6a0564dbe39dd28f972d3312</span>
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-4 mt-4 space-y-3">
                  <label className="text-[10px] font-extrabold text-slate-450 uppercase block tracking-wider">Sync Mode</label>
                  <div className="flex gap-2 p-1 bg-slate-50 border border-slate-150 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setSyncMode('range')}
                      className={`flex-1 text-center py-1.5 text-xs font-bold rounded-md transition-all ${
                        syncMode === 'range' 
                          ? 'bg-white text-slate-800 shadow-sm border border-slate-200' 
                          : 'text-slate-400 hover:text-slate-700'
                      }`}
                    >
                      Date Range
                    </button>
                    <button
                      type="button"
                      onClick={() => setSyncMode('single')}
                      className={`flex-1 text-center py-1.5 text-xs font-bold rounded-md transition-all ${
                        syncMode === 'single' 
                          ? 'bg-white text-slate-800 shadow-sm border border-slate-200' 
                          : 'text-slate-400 hover:text-slate-700'
                      }`}
                    >
                      Single Date
                    </button>
                  </div>

                  {syncMode === 'single' ? (
                    <div>
                      <label className="text-[10px] font-extrabold text-slate-400 uppercase block mb-1 tracking-wider">Select Sync Date</label>
                      <input
                        type="date"
                        value={syncFrom}
                        onChange={(e) => setSyncFrom(e.target.value)}
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold text-slate-700 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
                      />
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] font-extrabold text-slate-400 uppercase block mb-1 tracking-wider">Start Date</label>
                        <input
                          type="date"
                          value={syncFrom}
                          onChange={(e) => setSyncFrom(e.target.value)}
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold text-slate-700 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-extrabold text-slate-400 uppercase block mb-1 tracking-wider">End Date</label>
                        <input
                          type="date"
                          value={syncTo}
                          onChange={(e) => setSyncTo(e.target.value)}
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold text-slate-700 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-6">
                <button
                  onClick={handleSellerMateSync}
                  disabled={syncState.loading}
                  className="w-full bg-red-600 hover:bg-red-700 text-white font-extrabold py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm flex items-center justify-center gap-2 text-xs"
                >
                  {syncState.loading ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : <RefreshCw className="h-4 w-4" />}
                  {syncState.loading ? `Syncing (${syncState.progress}%)` : 'Sync Live Amazon Data'}
                </button>

                {syncDates.start && (
                  <div className="mt-4 pt-3 border-t border-slate-100 flex justify-between items-center text-[10px] font-bold text-slate-500">
                    <span>Current Synced Data:</span>
                    <span className="bg-red-50 text-red-600 px-2 py-0.5 rounded border border-red-100 font-black">
                      {syncDates.start.split('-').reverse().join('/')} – {syncDates.end.split('-').reverse().join('/')}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Sync Console Log Panel */}
            <div className="lg:col-span-2 bg-slate-950 text-slate-200 rounded-xl p-5 border border-slate-800 shadow-lg flex flex-col justify-between min-h-[300px]">
              <div className="flex items-center justify-between border-b border-slate-900 pb-3 mb-3">
                <div className="flex items-center gap-2">
                  <Terminal className="h-4.5 w-4.5 text-red-500" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-slate-400">SellerMate Sync Console</span>
                </div>
                <div className="flex gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500/30"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/30"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-green-500/30"></span>
                </div>
              </div>

              <div className="flex-1 font-mono text-[10px] leading-relaxed space-y-1.5 overflow-y-auto max-h-56 scrollbar-none">
                {syncState.logs.map((logStr, idx) => (
                  <div key={idx} className={logStr.includes('❌') ? 'text-rose-400' : logStr.includes('🎉') ? 'text-emerald-400' : 'text-slate-300'}>
                    {logStr}
                  </div>
                ))}
                {syncState.logs.length === 0 && (
                  <div className="text-slate-500 italic py-12 text-center">Console idle. Click "Sync Live Amazon Data" to trigger synchronization.</div>
                )}
              </div>

              {syncState.loading && (
                <div className="w-full bg-slate-900 rounded-full h-1.5 mt-4 overflow-hidden">
                  <div className="bg-red-500 h-full transition-all duration-300" style={{ width: `${syncState.progress}%` }}></div>
                </div>
              )}
            </div>
          </div>

          {/* Database Table Explorer */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden mt-8 border-l-4 border-l-red-500">
            <div className="p-5 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <Database className="h-5 w-5 text-red-600" />
                <div>
                  <h3 className="font-extrabold text-slate-800 text-sm">📊 Database Tables Explorer</h3>
                  <p className="text-[10px] text-slate-400 font-semibold mt-0.5">Explore raw records stored inside your Supabase tables</p>
                </div>
              </div>

              {/* Table Picker */}
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'amazon_retail', name: 'amazon_retail' },
                  { id: 'amazon_products', name: 'amazon_products' },
                  { id: 'amazon_campaigns', name: 'amazon_campaigns' }
                ].map(tbl => (
                  <button
                    key={tbl.id}
                    onClick={() => { setExplorerTable(tbl.id); setExplorerPage(1); }}
                    className={`px-3 py-1.5 border rounded-lg font-bold text-xs cursor-pointer transition ${
                      explorerTable === tbl.id
                        ? 'bg-slate-900 border-slate-900 text-white shadow-xs'
                        : 'bg-white border-slate-250 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {tbl.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Filter and Search */}
            <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-3 bg-white">
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input 
                  type="text" 
                  value={explorerSearch}
                  onChange={e => { setExplorerSearch(e.target.value); setExplorerPage(1); }}
                  placeholder="Search by name or ID..." 
                  className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg w-full text-xs font-semibold focus:outline-none focus:border-red-500 bg-white"
                />
              </div>
              <span className="text-xs font-bold text-slate-500 bg-slate-50 border border-slate-200 px-3 py-1 rounded-full">
                {explorerRows.length} rows found in current selection
              </span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs min-w-[1000px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {explorerTable === 'amazon_retail' && [
                      'Date', 'ASIN', 'Product Name', 'Total Sales', 'Units Ordered', 'Ad Spend', 'Ad Sales', 'Ad Orders', 'TACOS'
                    ].map(h => <th key={h} className="py-2.5 px-4 font-bold text-slate-500 uppercase tracking-wider text-[10px]">{h}</th>)}
                    
                    {explorerTable === 'amazon_products' && [
                      'Date', 'ASIN', 'Product Name', 'Spend', 'Ad Sales', 'Orders', 'Impressions', 'Clicks', 'ACoS', 'ROAS', 'CTR'
                    ].map(h => <th key={h} className="py-2.5 px-4 font-bold text-slate-500 uppercase tracking-wider text-[10px]">{h}</th>)}

                    {explorerTable === 'amazon_campaigns' && [
                      'Date', 'Campaign ID', 'Campaign Name', 'Ad Type', 'Status', 'Spend', 'Ad Sales', 'Orders', 'Impressions', 'Clicks', 'ACoS', 'ROAS'
                    ].map(h => <th key={h} className="py-2.5 px-4 font-bold text-slate-500 uppercase tracking-wider text-[10px]">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {paginatedExplorerRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-4 font-mono text-[10px]">{row.date}</td>
                      
                      {explorerTable === 'amazon_retail' && (
                        <>
                          <td className="py-3 px-4 font-mono font-bold text-slate-800">{row.asin}</td>
                          <td className="py-3 px-4 max-w-xs truncate">{row.product_name}</td>
                          <td className="py-3 px-4">{formatCurrency(row.total_sales)}</td>
                          <td className="py-3 px-4">{row.units_ordered}</td>
                          <td className="py-3 px-4">{formatCurrency(row.ad_spend)}</td>
                          <td className="py-3 px-4 text-emerald-600 font-bold">{formatCurrency(row.ad_sales)}</td>
                          <td className="py-3 px-4">{row.ad_orders}</td>
                          <td className="py-3 px-4 font-bold text-slate-800">{row.tacos}%</td>
                        </>
                      )}

                      {explorerTable === 'amazon_products' && (
                        <>
                          <td className="py-3 px-4 font-mono font-bold text-slate-800">{row.asin}</td>
                          <td className="py-3 px-4 max-w-xs truncate">{row.product_name}</td>
                          <td className="py-3 px-4">{formatCurrency(row.spend)}</td>
                          <td className="py-3 px-4 text-emerald-600 font-bold">{formatCurrency(row.ad_sales)}</td>
                          <td className="py-3 px-4">{row.orders}</td>
                          <td className="py-3 px-4 text-slate-500">{Number(row.impressions || 0).toLocaleString()}</td>
                          <td className="py-3 px-4 text-slate-500">{row.clicks}</td>
                          <td className="py-3 px-4">{row.acos}%</td>
                          <td className="py-3 px-4">{row.roas}x</td>
                          <td className="py-3 px-4">{row.ctr}%</td>
                        </>
                      )}

                      {explorerTable === 'amazon_campaigns' && (
                        <>
                          <td className="py-3 px-4 font-mono">{row.campaign_id}</td>
                          <td className="py-3 px-4 font-bold text-slate-800 max-w-xs truncate">{row.campaign_name}</td>
                          <td className="py-3 px-4 text-[10px] uppercase font-black text-slate-400">{row.ad_type}</td>
                          <td className="py-3 px-4">
                            <span className={`px-2 py-0.5 rounded font-black text-[9px] uppercase ${
                              row.status === 'ENABLED' ? 'bg-emerald-500/20 text-emerald-700' : 'bg-slate-200 text-slate-600'
                            }`}>{row.status}</span>
                          </td>
                          <td className="py-3 px-4">{formatCurrency(row.spend)}</td>
                          <td className="py-3 px-4 text-emerald-600 font-bold">{formatCurrency(row.ad_sales)}</td>
                          <td className="py-3 px-4">{row.orders}</td>
                          <td className="py-3 px-4 text-slate-500">{Number(row.impressions || 0).toLocaleString()}</td>
                          <td className="py-3 px-4 text-slate-500">{row.clicks}</td>
                          <td className="py-3 px-4">{row.acos}%</td>
                          <td className="py-3 px-4">{row.roas}x</td>
                        </>
                      )}
                    </tr>
                  ))}
                  {paginatedExplorerRows.length === 0 && (
                    <tr>
                      <td colSpan={12} className="py-12 text-center text-slate-400 font-bold">No database records found in current range. Click "Sync Live Amazon Data" above to seed.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {explorerRows.length > rowsPerPage && (
              <div className="p-4 border-t border-slate-100 flex items-center justify-between bg-white">
                <button
                  disabled={explorerPage === 1}
                  onClick={() => setExplorerPage(p => Math.max(1, p - 1))}
                  className="px-3.5 py-1.5 border border-slate-250 rounded-lg font-bold text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  Previous
                </button>
                <span className="text-xs font-bold text-slate-500">
                  Page {explorerPage} of {Math.ceil(explorerRows.length / rowsPerPage)}
                </span>
                <button
                  disabled={explorerPage >= Math.ceil(explorerRows.length / rowsPerPage)}
                  onClick={() => setExplorerPage(p => p + 1)}
                  className="px-3.5 py-1.5 border border-slate-250 rounded-lg font-bold text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
