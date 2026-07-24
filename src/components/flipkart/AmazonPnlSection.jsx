'use client';
import React, { useState, useEffect, useMemo } from 'react';
import { 
  IndianRupee, TrendingUp, Percent, Package, Wallet, 
  RefreshCcw, AlertCircle, X, ChevronUp, ChevronDown, Loader2,
  ShoppingCart, ShieldAlert, Award, Search, Download, CheckCircle
} from 'lucide-react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell
} from 'recharts';

const formatPeriodLabel = (period) => {
  if (!period) return '';
  const [year, month] = period.split('-');
  const date = new Date(year, parseInt(month) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

export default function AmazonPnlSection({ supabaseUrl, supabaseKey }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  const [allTransactions, setAllTransactions] = useState([]);
  const [allAdSpendData, setAllAdSpendData] = useState([]);
  const [availablePeriods, setAvailablePeriods] = useState([]);
  const [selectedPeriod, setSelectedPeriod] = useState('2026-05');
  const [skuNamesMap, setSkuNamesMap] = useState({});
  
  const [sortConfig, setSortConfig] = useState({ key: 'profit', direction: 'desc' });
  const [selectedSku, setSelectedSku] = useState(null);
  const [skuSearch, setSkuSearch] = useState('');
  const [profitFilter, setProfitFilter] = useState('all');

  const [pnlTab, setPnlTab] = useState('statement');
  const [ledgerViewMode, setLedgerViewMode] = useState('terminal');
  const [cogsPercentage, setCogsPercentage] = useState(40);
  const [collapsedSections, setCollapsedSections] = useState({
    revenue: false,
    marketing: false,
    expense: false,
    itc: false,
    taxDeductions: false
  });

  // Filter dynamically based on selectedPeriod
  const transactions = useMemo(() => {
    if (!selectedPeriod) return [];
    const [yearStr, monthStr] = selectedPeriod.split('-');
    const targetYear = parseInt(yearStr);
    const targetMonth = parseInt(monthStr) - 1; // 0-indexed
    
    return allTransactions.filter(row => {
      if (!row.date_time) return false;
      const d = new Date(row.date_time);
      const istOffset = 5.5 * 60 * 60 * 1000;
      const ist = new Date(d.getTime() + istOffset);
      return ist.getUTCFullYear() === targetYear && ist.getUTCMonth() === targetMonth;
    });
  }, [allTransactions, selectedPeriod]);

  const adSpendData = useMemo(() => {
    if (!selectedPeriod) return [];
    return allAdSpendData.filter(row => {
      if (!row.date_start) return false;
      return String(row.date_start).startsWith(selectedPeriod);
    });
  }, [allAdSpendData, selectedPeriod]);

  useEffect(() => {
    let isMounted = true;
    
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      
      const headers = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      };

      // Fetch all from a table with pagination (no date filter - we filter in JS)
      const fetchAll = async (table, orderCol) => {
        let results = [];
        let offset = 0;
        const limit = 1000;
        
        while (true) {
          const url = `${supabaseUrl}/rest/v1/${table}?select=*&limit=${limit}&offset=${offset}&order=${orderCol}.asc`;
          try {
            const res = await fetch(url, { headers });
            if (!res.ok) throw new Error(`Failed to fetch ${table}: ${res.status}`);
            
            const data = await res.json();
            if (data.length === 0) break;
            
            results = results.concat(data);
            if (data.length < limit) break;
            offset += limit;
            
            if (results.length > 60000) break; // Hard limit safeguard
          } catch (err) {
            console.error(err);
            throw err;
          }
        }
        return results;
      };

      try {
        const [txAll, adAll] = await Promise.all([
          fetchAll('amazon_transactions_dashboard', 'date_time'),
          fetchAll('amazon_ads_advertised_product_dashboard', 'date_start')
        ]);

        // Find all unique YYYY-MM periods
        const periods = new Set();
        txAll.forEach(row => {
          if (row.date_time) {
            const d = new Date(row.date_time);
            if (!isNaN(d.getTime())) {
              const istOffset = 5.5 * 60 * 60 * 1000;
              const ist = new Date(d.getTime() + istOffset);
              const y = ist.getUTCFullYear();
              const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
              periods.add(`${y}-${m}`);
            }
          }
        });

        adAll.forEach(row => {
          if (row.date_start) {
            const d = new Date(row.date_start);
            if (!isNaN(d.getTime())) {
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, '0');
              periods.add(`${y}-${m}`);
            }
          }
        });

        const sortedPeriods = Array.from(periods).sort((a, b) => b.localeCompare(a));
        
        const txNames = {};
        txAll.forEach(row => {
          if (row.sku && row.description) {
            const desc = row.description.trim();
            if (desc && (!txNames[row.sku] || desc.length > txNames[row.sku].length)) {
              txNames[row.sku] = desc.length > 55 ? desc.substring(0, 55) + '...' : desc;
            }
          }
        });

        if (isMounted) {
          setAllTransactions(txAll);
          setAllAdSpendData(adAll);
          setAvailablePeriods(sortedPeriods);
          setSkuNamesMap(txNames);
          
          if (sortedPeriods.length > 0) {
            setSelectedPeriod(sortedPeriods[0]);
          } else {
            setSelectedPeriod('2026-05');
          }
          setLoading(false);
        }
      } catch (err) {
        if (isMounted) {
          console.error("Error fetching Amazon PnL data:", err);
          setError(err.message || 'Failed to load data from Supabase');
          setLoading(false);
        }
      }
    };

    if (supabaseUrl && supabaseKey) {
      fetchData();
    } else {
      setLoading(false);
    }
    
    return () => { isMounted = false; };
  }, [supabaseUrl, supabaseKey]);

  // Aggregation Logic
  const metrics = useMemo(() => {
    // Removed early return to allow empty state to render properly

    // --- Row 1: Summary Metrics ---
    let totalAdSpend = 0;
    let totalAdSales = 0;
    
    adSpendData.forEach(row => {
      totalAdSpend += Number(row.total_cost || 0);
      totalAdSales += Number(row.sales || 0);
    });

    let grossRevenue = 0;
    let totalUnits = 0;
    let totalCommission = 0;
    let totalFbaFees = 0;
    let totalGstTcs = 0;
    let totalRefunds = 0;
    let refundCount = 0;

    transactions.forEach(row => {
      const type = (row.type || '').toLowerCase();
      
      // Calculate GST/TCS for all relevant rows
      const gstTcs = Number(row.tcs_cgst || 0) + Number(row.tcs_sgst || 0) + Number(row.tcs_igst || 0);
      
      if (type.includes('order')) {
        grossRevenue += Number(row.product_sales || 0);
        totalUnits += Number(row.quantity || 0);
        totalCommission += Number(row.selling_fees || 0);
        totalFbaFees += Number(row.fba_fees || 0);
        totalGstTcs += gstTcs;
      } else if (type.includes('refund')) {
        totalRefunds += Number(row.total || 0);
        refundCount++;
        totalGstTcs += gstTcs; // Assuming refunds have negative gstTcs
      }
    });

    const acosPct = grossRevenue > 0 ? (totalAdSpend / grossRevenue) * 100 : 0;
    const productCostTotal = grossRevenue * (cogsPercentage / 100);
    const estNetProfit = grossRevenue + totalCommission + totalFbaFees + totalGstTcs - totalAdSpend - productCostTotal + totalRefunds;

    // --- Row 2: Date-wise Trend Chart ---
    const dateMap = {};
    
    // Process Gross Revenue per day (convert UTC -> IST for grouping)
    const toISTDateStr = (utcStr) => {
      if (!utcStr) return null;
      const d = new Date(utcStr);
      const istOffset = 5.5 * 60 * 60 * 1000;
      const ist = new Date(d.getTime() + istOffset);
      const y = ist.getUTCFullYear();
      const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
      const day = String(ist.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    transactions.forEach(row => {
      const type = (row.type || '').toLowerCase();
      if (!type.includes('order')) return;
      
      const dateStr = toISTDateStr(row.date_time);
      if (!dateStr) return;
      
      if (!dateMap[dateStr]) dateMap[dateStr] = { date: dateStr, revenue: 0, adSpend: 0 };
      dateMap[dateStr].revenue += Number(row.product_sales || 0);
    });
    
    // NOTE: amazon_ads_advertised_product_dashboard has only monthly totals (not daily),
    // so we cannot accurately plot daily ad spend. It's shown correctly in the
    // summary card above. The chart shows only accurate daily Revenue from transactions.

    const chartData = Object.values(dateMap).sort((a, b) => new Date(a.date) - new Date(b.date));

    // --- Row 3: SKU-level P&L Table ---
    const skuMap = {};
    
    // Map Ad Spend directly to SKU (case-insensitive, trimmed)
    const adSpendBySku = {};
    adSpendData.forEach(row => {
      const sku = (row.advertised_product_sku || '').trim();
      if (!sku) return;
      const spend = Number(row.total_cost || 0);
      adSpendBySku[sku] = (adSpendBySku[sku] || 0) + spend;
    });

    // Populate SKU Map from orders
    transactions.forEach(row => {
      const type = (row.type || '').toLowerCase();
      if (!type.includes('order')) return;
      
      const sku = (row.sku || 'Unknown').trim();
      const desc = row.description || '';
      const prodName = desc.length > 55 ? desc.substring(0, 55) + '...' : desc;
      
      if (!skuMap[sku]) {
        skuMap[sku] = {
          sku: sku,
          productName: prodName || skuNamesMap[sku] || sku,
          units: 0,
          grossRevenue: 0,
          commission: 0,
          fbaFees: 0,
          gstTcs: 0,
          adSpend: 0,
        };
      }
      
      skuMap[sku].units += Number(row.quantity || 0);
      skuMap[sku].grossRevenue += Number(row.product_sales || 0);
      skuMap[sku].commission += Number(row.selling_fees || 0);
      skuMap[sku].fbaFees += Number(row.fba_fees || 0);
      skuMap[sku].gstTcs += Number(row.tcs_cgst || 0) + Number(row.tcs_sgst || 0) + Number(row.tcs_igst || 0);
      
      if (prodName && (!skuMap[sku].productName || skuMap[sku].productName === sku || prodName.length > skuMap[sku].productName.length)) {
        skuMap[sku].productName = prodName;
      }
    });

    // Map ad spend for any products that had spend but no transactions in the selected month
    Object.entries(adSpendBySku).forEach(([sku, spend]) => {
      if (!skuMap[sku]) {
        skuMap[sku] = {
          sku: sku,
          productName: skuNamesMap[sku] || sku,
          units: 0,
          grossRevenue: 0,
          commission: 0,
          fbaFees: 0,
          gstTcs: 0,
          adSpend: spend,
        };
      } else {
        skuMap[sku].adSpend = spend;
      }
    });

    const tableData = Object.keys(skuMap).map(key => {
      const s = skuMap[key];
      s.productCostTotal = s.grossRevenue * (cogsPercentage / 100);
      s.profit = s.grossRevenue + s.commission + s.fbaFees + s.gstTcs - s.adSpend - s.productCostTotal;
      s.acosPct = s.grossRevenue > 0 ? (s.adSpend / s.grossRevenue) * 100 : 0;
      return s;
    });

    return {
      summary: {
        totalAdSpend, totalAdSales, acosPct, grossRevenue, totalUnits, 
        totalCommission, totalFbaFees, totalRefunds, refundCount, estNetProfit
      },
      chartData,
      tableData
    };
  }, [transactions, adSpendData, skuNamesMap, cogsPercentage]);

  const ledgerMetrics = useMemo(() => {
    if (!transactions) return null;

    let orderSales = 0, orderTax = 0, orderPromo = 0, orderShip = 0;
    let refundSales = 0, refundTax = 0, refundPromo = 0, refundShip = 0;
    
    let adSpendTotal = 0;
    let easyShipTotal = 0;
    let orderCommission = 0, refundCommission = 0;
    let orderFba = 0, refundFba = 0;
    let storageFee = 0;
    let inboundPickup = 0;
    let cancellations = 0;
    let reimbursements = 0;
    let fulfilmentRefund = 0;
    let adjustments = 0;
    let tcsCgst = 0, tcsSgst = 0, tcsIgst = 0;
    let tds194o = 0;
    let orderOther = 0, refundOther = 0;
    
    transactions.forEach(row => {
      const type = row.type || '';
      const desc = row.description || '';
      const total = Number(row.total || 0);
      const product_sales = Number(row.product_sales || 0);
      const tax_gst = Number(row.total_sales_tax_gst || 0);
      const promo = Number(row.promotional_rebates || 0);
      const ship = Number(row.shipping_credits || 0);
      const selling = Number(row.selling_fees || 0);
      const fba = Number(row.fba_fees || 0);
      const other_fees = Number(row.other_transaction_fees || 0);
      const other_col = Number(row.other || 0);
      
      tcsCgst += Number(row.tcs_cgst || 0);
      tcsSgst += Number(row.tcs_sgst || 0);
      tcsIgst += Number(row.tcs_igst || 0);
      tds194o += Number(row.tds_194o || 0);

      if (type === 'Order') {
        orderSales += product_sales;
        orderTax += tax_gst;
        orderPromo += promo;
        orderShip += ship;
        orderCommission += selling;
        orderFba += fba;
        orderOther += other_fees + other_col;
      } else if (type === 'Refund') {
        refundSales += product_sales;
        refundTax += tax_gst;
        refundPromo += promo;
        refundShip += ship;
        refundCommission += selling;
        refundFba += fba;
        refundOther += other_fees + other_col;
      } else if (type === 'Service Fee') {
        if (desc.includes('Cost of Advertising')) {
          adSpendTotal += total;
        } else if (desc.includes('Order Cancellation Charge')) {
          cancellations += total;
        } else {
          adjustments += total;
        }
      } else if (type === 'Shipping Services') {
        if (desc.includes('Weight Handling Fee Reversal') || desc.includes('Reversal')) {
          reimbursements += total;
        } else {
          easyShipTotal += total;
        }
      } else if (type === 'FBA Inventory Fee') {
        if (desc.includes('FBA storage fee') || desc.includes('Storage')) {
          storageFee += total;
        } else if (desc.includes('FBA Inbound Pickup') || desc.includes('Inbound')) {
          inboundPickup += total;
        } else {
          adjustments += total;
        }
      } else if (type === 'Reimbursements') {
        reimbursements += total;
      } else if (type === 'Fulfilment Fee Refund') {
        fulfilmentRefund += total;
      } else if (type === 'Adjustment') {
        adjustments += total;
      } else if (type === 'Transfer') {
        // transfers are payouts, ignore in P&L
      } else {
        adjustments += total;
      }
    });

    // 1. Revenue from Sales
    const itemPrice = { name: "Item Price", base: orderSales, tax: orderTax, total: orderSales + orderTax };
    const refundItemPrice = { name: "Refund Item Price", base: refundSales, tax: refundTax, total: refundSales + refundTax };
    const shipping = { name: "Shipping", base: orderShip + refundShip, tax: 0, total: orderShip + refundShip };
    
    const revenueList = [itemPrice, refundItemPrice, shipping];
    const revenueTotal = {
      base: revenueList.reduce((s, i) => s + i.base, 0),
      tax: revenueList.reduce((s, i) => s + i.tax, 0),
      total: revenueList.reduce((s, i) => s + i.total, 0),
    };

    // 2. Marketing Spend
    const adSpend = { name: "Ad Spend", base: adSpendTotal, tax: 0, total: adSpendTotal };
    const dealsCoupons = { name: "Deals, Coupons & Promotions", base: orderPromo, tax: 0, total: orderPromo };
    const dealsCouponsRefunds = { name: "Deals, Coupons & Promotions Refunds", base: refundPromo, tax: 0, total: refundPromo };
    
    const marketingList = [adSpend, dealsCoupons, dealsCouponsRefunds];
    const marketingTotal = {
      base: marketingList.reduce((s, i) => s + i.base, 0),
      tax: marketingList.reduce((s, i) => s + i.tax, 0),
      total: marketingList.reduce((s, i) => s + i.total, 0),
    };

    // 3. Expense
    const cogsVal = -orderSales * (cogsPercentage / 100);
    const cogs = { name: "COGS", base: cogsVal, tax: 0, total: cogsVal };
    
    const easyShipBase = easyShipTotal / 1.18;
    const easyShip = { name: "Easy Shipping", base: easyShipBase, tax: easyShipTotal - easyShipBase, total: easyShipTotal };
    
    const commissionGross = orderCommission + refundCommission;
    const commissionBase = commissionGross / 1.18;
    const commission = { name: "Commission", base: commissionBase, tax: commissionGross - commissionBase, total: commissionGross };
    
    const closingGross = orderOther + refundOther;
    const closingBase = closingGross / 1.18;
    const closing = { name: "Closing", base: closingBase, tax: closingGross - closingBase, total: closingGross };
    
    const fbaGross = orderFba + refundFba;
    const weightHandlingGross = fbaGross * 0.68;
    const weightHandlingBase = weightHandlingGross / 1.18;
    const weightHandling = { name: "Weight Handling", base: weightHandlingBase, tax: weightHandlingGross - weightHandlingBase, total: weightHandlingGross };
    
    const pickPackGross = fbaGross * 0.32;
    const pickPackBase = pickPackGross / 1.18;
    const pickPack = { name: "Pick & Pack", base: pickPackBase, tax: pickPackGross - pickPackBase, total: pickPackGross };

    const inboundBase = inboundPickup / 1.18;
    const inbound = { name: "Inbound Handling Charges", base: inboundBase, tax: inboundPickup - inboundBase, total: inboundPickup };

    const storageBase = storageFee / 1.18;
    const storage = { name: "Storage Fee", base: storageBase, tax: storageFee - storageBase, total: storageFee };

    const otherCharges = { name: "Other Charges", base: 0, tax: 0, total: 0 };

    const cancellationsBase = cancellations / 1.18;
    const cancellationsRow = { name: "Cancellations", base: cancellationsBase, tax: cancellations - cancellationsBase, total: cancellations };

    const returnsRefundsBase = reimbursements / 1.18;
    const returnsRefunds = { name: "Returns & Refunds", base: returnsRefundsBase, tax: reimbursements - returnsRefundsBase, total: reimbursements };

    const inventoryRefunds = { name: "Inventory Refunds", base: 0, tax: 0, total: 0 };

    const fbaRefundBase = fulfilmentRefund / 1.18;
    const fbaRefund = { name: "FBA Refund", base: fbaRefundBase, tax: fulfilmentRefund - fbaRefundBase, total: fulfilmentRefund };

    const othersBase = adjustments / 1.18;
    const othersRow = { name: "Others", base: othersBase, tax: adjustments - othersBase, total: adjustments };

    const expenseList = [cogs, easyShip, commission, closing, weightHandling, pickPack, inbound, storage, otherCharges, cancellationsRow, returnsRefunds, inventoryRefunds, fbaRefund, othersRow];
    const expenseTotal = {
      base: expenseList.reduce((s, i) => s + i.base, 0),
      tax: expenseList.reduce((s, i) => s + i.tax, 0),
      total: expenseList.reduce((s, i) => s + i.total, 0),
    };

    // 4. Input Tax Credit
    const tcsTotal = tcsCgst + tcsSgst + tcsIgst;
    const itcRow = { name: "Input Tax Credit", base: 0, tax: tcsTotal, total: tcsTotal };
    const itcList = [itcRow];
    const itcTotal = {
      base: 0,
      tax: tcsTotal,
      total: tcsTotal,
    };

    // 5. Tax Deductions
    const tdsRow = { name: "TDS", base: tds194o, tax: 0, total: tds194o };
    const paymentAdj = { name: "Payment Adjustments", base: 0, tax: 0, total: 0 };
    const taxDeductionsList = [tdsRow, paymentAdj];
    const taxDeductionsTotal = {
      base: taxDeductionsList.reduce((s, i) => s + i.base, 0),
      tax: taxDeductionsList.reduce((s, i) => s + i.tax, 0),
      total: taxDeductionsList.reduce((s, i) => s + i.total, 0),
    };

    const pnlBase = revenueTotal.base + marketingTotal.base + expenseTotal.base + itcTotal.base + taxDeductionsTotal.base;
    const pnlTax = revenueTotal.tax + marketingTotal.tax + expenseTotal.tax + itcTotal.tax + taxDeductionsTotal.tax;
    const pnlTotal = revenueTotal.total + marketingTotal.total + expenseTotal.total + itcTotal.total + taxDeductionsTotal.total;

    const netMargin = revenueTotal.base > 0 ? (pnlBase / revenueTotal.base * 100).toFixed(1) + "%" : "0.0%";
    const tacos = revenueTotal.base > 0 ? (Math.abs(adSpendTotal) / revenueTotal.base * 100).toFixed(1) + "%" : "0.0%";

    const itcAdSpendVal = Math.abs(adSpendTotal) * 0.18;
    const itcExpenseVal = Math.abs(expenseTotal.tax);
    const itcOtherVal = Math.abs(tcsTotal) - itcAdSpendVal - itcExpenseVal;
    const netPnlVal = pnlBase + Math.abs(tcsTotal);
    const netMarginAdjusted = revenueTotal.base > 0 ? (netPnlVal / revenueTotal.base * 100).toFixed(1) + "%" : "0.0%";
    const tacosBaseRevenue = revenueTotal.base > 0 ? (Math.abs(adSpendTotal) / revenueTotal.base * 100).toFixed(1) + "%" : "0.0%";

    return {
      revenue: revenueList,
      revenueTotal,
      marketing: marketingList,
      marketingTotal,
      expense: expenseList,
      expenseTotal,
      itc: itcList,
      itcTotal,
      taxDeductions: taxDeductionsList,
      taxDeductionsTotal,
      profitAndLoss: { base: pnlBase, tax: pnlTax, total: pnlTotal },
      keyMetrics: { netMargin, tacos },
      taxSummary: {
        basePnl: pnlBase,
        itcAdSpend: itcAdSpendVal,
        itcExpense: itcExpenseVal,
        itcOther: itcOtherVal > 0 ? itcOtherVal : 0,
        itcTotal: Math.abs(tcsTotal),
        netPnl: netPnlVal,
        netMarginAdjusted,
        tacosBaseRevenue
      }
    };
  }, [transactions, cogsPercentage]);

  const handleSort = (key) => {
    let direction = 'desc';
    if (sortConfig.key === key && sortConfig.direction === 'desc') {
      direction = 'asc';
    }
    setSortConfig({ key, direction });
  };

  const sortedTableData = useMemo(() => {
    if (!metrics?.tableData) return [];
    return [...metrics.tableData].sort((a, b) => {
      let aValue = a[sortConfig.key];
      let bValue = b[sortConfig.key];
      
      if (typeof aValue === 'string') {
         return sortConfig.direction === 'asc' 
           ? aValue.localeCompare(bValue) 
           : bValue.localeCompare(aValue);
      }
      return sortConfig.direction === 'asc' ? aValue - bValue : bValue - aValue;
    });
  }, [metrics, sortConfig]);

  const filteredTableData = useMemo(() => {
    let data = sortedTableData;
    
    // Apply search filter
    if (skuSearch) {
      const query = skuSearch.toLowerCase().trim();
      data = data.filter(row => 
        (row.sku || '').toLowerCase().includes(query) || 
        (row.productName || '').toLowerCase().includes(query)
      );
    }
    
    // Apply profit category filter
    if (profitFilter === 'profitable') {
      data = data.filter(row => row.profit > 0);
    } else if (profitFilter === 'unprofitable') {
      data = data.filter(row => row.profit <= 0);
    } else if (profitFilter === 'highSpend') {
      data = data.filter(row => row.grossRevenue > 0 && (row.adSpend / row.grossRevenue) > 0.15); // >15% ACOS/spend ratio
    }
    
    return data;
  }, [sortedTableData, skuSearch, profitFilter]);

  const handleExportCSV = () => {
    const headers = ['SKU', 'Product Name', 'Units Sold', 'Gross Revenue (INR)', 'Commission (INR)', 'FBA Fees (INR)', 'GST & TCS (INR)', 'Estimated Product Cost (INR)', 'Ad Spend (INR)', 'Net Profit (INR)', 'ACOS (%)'];
    
    const rows = filteredTableData.map(row => [
      row.sku,
      row.productName,
      row.units,
      row.grossRevenue.toFixed(0),
      row.commission.toFixed(0),
      row.fbaFees.toFixed(0),
      row.gstTcs.toFixed(0),
      row.productCostTotal.toFixed(0),
      row.adSpend.toFixed(0),
      row.profit.toFixed(0),
      row.acosPct.toFixed(1)
    ]);
    
    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(','), ...rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');
      
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Amazon_PnL_SKU_Level_${selectedPeriod}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div className="mt-8 bg-white border border-slate-200 rounded-xl p-12 shadow-xs flex flex-col items-center justify-center animate-pulse">
        <Loader2 className="w-10 h-10 text-red-500 animate-spin mb-4" />
        <p className="text-slate-600 font-bold text-lg">Crunching Amazon P&L Data for {formatPeriodLabel(selectedPeriod)}...</p>
        <p className="text-slate-400 text-sm mt-2">Fetching unified transactions & search terms</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-8 bg-red-50 border border-red-200 rounded-xl p-6 shadow-xs flex items-start gap-3">
        <ShieldAlert className="w-6 h-6 text-red-600 shrink-0" />
        <div>
          <h3 className="text-red-800 font-bold text-lg">Failed to load Amazon P&L</h3>
          <p className="text-red-600/80 text-sm mt-1">{error}</p>
        </div>
      </div>
    );
  }

  if (!metrics) return null;

  const { summary, chartData } = metrics;
  
  const formatCurrency = (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(val);
  const formatLedger = (val) => {
    if (val === 0) return '—';
    if (val === null || val === undefined) return '—';
    const isNeg = val < 0;
    const cleanVal = Math.abs(val);
    const formatted = new Intl.NumberFormat('en-IN', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2
    }).format(cleanVal);
    return (isNeg ? '-' : '') + formatted;
  };

  return (
    <div className="mt-12 space-y-8" id="amazon-pnl-section">
      
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-4 gap-4">
        <div className="flex items-center gap-3">
          <Award className="w-8 h-8 text-red-500" />
          <div>
            <h2 className="text-2xl font-black text-slate-800">Amazon P&L Center</h2>
            <p className="text-sm font-semibold text-slate-500">Deep dive into profitability for {formatPeriodLabel(selectedPeriod)}</p>
          </div>
        </div>
        {availablePeriods.length > 0 && (
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 shadow-xs">
            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Select Month:</span>
            <select
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
              className="bg-transparent text-xs font-bold text-slate-700 focus:outline-none cursor-pointer"
            >
              {availablePeriods.map(p => (
                <option key={p} value={p}>{formatPeriodLabel(p)}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* --- GLOBAL SUMMARY METRICS --- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Ad Spend */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-2">Ad Spend</span>
          <div className="text-2xl font-black text-slate-800">{formatCurrency(summary.totalAdSpend)}</div>
        </div>
        
        {/* Ad Sales */}
        <div className="bg-white border border-emerald-200 bg-emerald-50/30 rounded-xl p-4 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
          <span className="text-[10px] font-extrabold text-emerald-600 uppercase tracking-wider mb-2">Ad Sales (7-Day)</span>
          <div className="text-2xl font-black text-emerald-700">{formatCurrency(summary.totalAdSales)}</div>
        </div>

        {/* ACOS % */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-2">ACOS %</span>
          <div className={`text-2xl font-black ${summary.acosPct > 35 ? 'text-red-500' : 'text-emerald-500'}`}>
            {summary.acosPct.toFixed(1)}%
          </div>
        </div>

        {/* Gross Revenue */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 shadow-sm flex flex-col justify-between relative overflow-hidden">
          <div className="relative z-10">
            <span className="text-[10px] font-extrabold text-slate-300 uppercase tracking-wider mb-2">Gross Revenue</span>
            <div className="text-2xl font-black text-white">{formatCurrency(summary.grossRevenue)}</div>
            <div className="text-xs font-semibold text-slate-400 mt-1">{summary.totalUnits.toLocaleString('en-IN')} units sold</div>
          </div>
          <TrendingUp className="absolute right-[-10px] bottom-[-10px] w-24 h-24 text-slate-700 opacity-30" />
        </div>

        {/* Commission */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-2">Amazon Commission</span>
          <div className="text-2xl font-black text-red-500">{formatCurrency(summary.totalCommission)}</div>
        </div>

        {/* FBA Fees */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-2">FBA Fees</span>
          <div className="text-2xl font-black text-orange-500">{formatCurrency(summary.totalFbaFees)}</div>
        </div>

        {/* Refunds */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-2">Refunds</span>
          <div className="text-2xl font-black text-slate-850">{formatCurrency(summary.totalRefunds)}</div>
          <div className="text-xs font-semibold text-slate-400 mt-1">{summary.refundCount.toLocaleString('en-IN')} returned items</div>
        </div>

        {/* Est Net Profit */}
        <div className={`border rounded-xl p-4 shadow-sm flex flex-col justify-between relative overflow-hidden ${
          summary.estNetProfit >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'
        }`}>
          <div className="relative z-10">
            <span className={`text-[10px] font-extrabold uppercase tracking-wider mb-2 ${
              summary.estNetProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}>Est. Net Profit</span>
            <div className={`text-3xl font-black ${
              summary.estNetProfit >= 0 ? 'text-emerald-600' : 'text-red-600'
            }`}>
              {summary.estNetProfit >= 0 ? '+' : ''}{formatCurrency(summary.estNetProfit)}
            </div>
            <div className={`text-xs font-bold mt-1 ${
              summary.estNetProfit >= 0 ? 'text-emerald-600/70' : 'text-red-600/70'
            }`}>
              Margin: {summary.grossRevenue > 0 ? ((summary.estNetProfit / summary.grossRevenue) * 100).toFixed(1) : 0}%
            </div>
          </div>
        </div>
      </div>

      {/* Tab Selector */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-50 border border-slate-200 rounded-xl p-3.5 shadow-2xs">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">P&L View:</span>
          <div className="inline-flex rounded-lg bg-slate-200/80 p-0.5 border border-slate-300/40">
            <button
              onClick={() => setPnlTab('statement')}
              className={`px-4 py-1.5 text-xs font-black rounded-md cursor-pointer transition-all ${
                pnlTab === 'statement'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              📑 Company Ledger Statement
            </button>
            <button
              onClick={() => setPnlTab('sku')}
              className={`px-4 py-1.5 text-xs font-black rounded-md cursor-pointer transition-all ${
                pnlTab === 'sku'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              📦 SKU-Level Profitability
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-slate-500">COGS percentage:</span>
          <input
            type="number"
            value={cogsPercentage}
            onChange={(e) => setCogsPercentage(Number(e.target.value))}
            className="w-16 px-2 py-1 bg-white border border-slate-300 rounded text-xs font-bold focus:outline-none focus:border-red-500"
            step="0.1"
            min="0"
            max="100"
          />
          <span className="text-xs font-bold text-slate-400">%</span>
        </div>
      </div>

      {pnlTab === 'sku' && (
        <>
          {/* --- ROW 3: SKU P&L TABLE --- */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
            <Package className="w-5 h-5 text-red-500" /> SKU-Level Profitability
          </h3>
          
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full md:w-auto">
            {/* Search Input */}
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input 
                type="text" 
                value={skuSearch}
                onChange={e => setSkuSearch(e.target.value)}
                placeholder="Search SKU or Product..."
                className="w-full pl-9 pr-4 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold focus:outline-none focus:border-red-500"
              />
            </div>
            
            {/* Export CSV Button */}
            <button
              onClick={handleExportCSV}
              className="bg-white hover:bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-bold text-slate-700 shadow-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" /> Export CSV
            </button>
            
            <span className="text-xs font-bold text-slate-500 bg-white px-3 py-1.5 rounded-full border border-slate-200 shadow-xs text-center shrink-0">
              Click row for breakdown
            </span>
          </div>
        </div>

        {/* Quick Filters */}
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center gap-2">
          {[
            { id: 'all', label: 'All Products', count: sortedTableData.length },
            { id: 'profitable', label: 'Profitable SKUs', count: sortedTableData.filter(r => r.profit > 0).length, color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
            { id: 'unprofitable', label: 'Losing SKUs', count: sortedTableData.filter(r => r.profit <= 0).length, color: 'text-red-700 bg-red-50 border-red-200' },
            { id: 'highSpend', label: 'High Ad Spend (>15%)', count: sortedTableData.filter(r => r.grossRevenue > 0 && (r.adSpend / r.grossRevenue) > 0.15).length, color: 'text-blue-700 bg-blue-50 border-blue-200' },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setProfitFilter(f.id)}
              className={`px-3 py-1 rounded-full text-xs font-bold border transition-colors cursor-pointer ${
                profitFilter === f.id
                  ? (f.id === 'profitable' ? 'bg-emerald-500 text-white border-emerald-500' : f.id === 'unprofitable' ? 'bg-red-500 text-white border-red-500' : f.id === 'highSpend' ? 'bg-blue-500 text-white border-blue-500' : 'bg-slate-800 text-white border-slate-800')
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {f.label} ({f.count})
            </button>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[1000px]">
            <thead>
              <tr className="bg-white border-b border-slate-200">
                {[
                  { key: 'sku', label: 'SKU / Product' },
                  { key: 'units', label: 'Units', align: 'right' },
                  { key: 'grossRevenue', label: 'Revenue', align: 'right' },
                  { key: 'commission', label: 'Commission', align: 'right' },
                  { key: 'fbaFees', label: 'FBA', align: 'right' },
                  { key: 'gstTcs', label: 'GST+TCS', align: 'right' },
                  { key: 'productCostTotal', label: 'Prod. Cost', align: 'right' },
                  { key: 'adSpend', label: 'Ad Spend', align: 'right' },
                  { key: 'profit', label: 'Net Profit', align: 'right' },
                  { key: 'acosPct', label: 'ACOS %', align: 'right' },
                ].map(({ key, label, align }) => (
                  <th 
                    key={key}
                    onClick={() => handleSort(key)}
                    className={`py-3 px-4 text-[10px] font-extrabold text-slate-500 uppercase tracking-wider cursor-pointer hover:bg-slate-50 transition-colors select-none ${align === 'right' ? 'text-right' : ''}`}
                  >
                    <div className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
                      {label}
                      {sortConfig.key === key && (
                        sortConfig.direction === 'desc' ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredTableData.map((row, i) => {
                let acosBadgeColor = 'bg-red-100 text-red-700 border-red-200';
                if (row.acosPct < 20) acosBadgeColor = 'bg-emerald-100 text-emerald-700 border-emerald-200';
                else if (row.acosPct <= 35) acosBadgeColor = 'bg-amber-100 text-amber-700 border-amber-200';

                return (
                  <tr 
                    key={i} 
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => setSelectedSku(row)}
                  >
                    <td className="py-4 px-4 pr-4">
                      <div className="font-bold text-slate-800 text-xs truncate max-w-[200px]" title={row.productName}>
                        {row.productName || 'Unknown Product'}
                      </div>
                      <div className="text-[10px] font-semibold text-slate-500 font-mono mt-0.5 truncate max-w-[200px]" title={row.sku}>
                        {row.sku}
                      </div>
                    </td>
                    <td className="py-4 px-4 text-right font-semibold text-slate-600 text-sm">{row.units.toLocaleString('en-IN')}</td>
                    <td className="py-4 px-4 text-right font-bold text-slate-800 text-sm">{formatCurrency(row.grossRevenue)}</td>
                    <td className="py-4 px-4 text-right font-semibold text-red-500 text-xs">{formatCurrency(row.commission)}</td>
                    <td className="py-4 px-4 text-right font-semibold text-orange-500 text-xs">{formatCurrency(row.fbaFees)}</td>
                    <td className="py-4 px-4 text-right font-semibold text-slate-500 text-xs">{formatCurrency(row.gstTcs)}</td>
                    <td className="py-4 px-4 text-right font-semibold text-slate-600 text-xs">{formatCurrency(row.productCostTotal)}</td>
                    <td className="py-4 px-4 text-right font-bold text-blue-600 text-sm">{formatCurrency(row.adSpend)}</td>
                    <td className="py-4 px-4 text-right whitespace-nowrap">
                      <span className={`font-black text-sm px-2 py-1 rounded-md ${row.profit >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                        {row.profit >= 0 ? '+' : ''}{formatCurrency(row.profit)}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-right whitespace-nowrap">
                      <span className={`text-[10px] font-black px-2 py-1 rounded-md border ${acosBadgeColor}`}>
                        {row.acosPct.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredTableData.length === 0 && (
             <div className="text-center py-10 text-slate-400 font-bold">
               {sortedTableData.length === 0 
                 ? `No order data found for ${formatPeriodLabel(selectedPeriod)}.`
                 : "No products found matching your search or filters."}
             </div>
          )}
        </div>
      </div>

      {/* --- MODAL: SKU DETAIL --- */}
      {selectedSku && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in-up">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto relative border border-slate-200">
            
            <button 
              onClick={() => setSelectedSku(null)}
              className="absolute top-4 right-4 p-2 bg-slate-100 hover:bg-slate-200 rounded-full text-slate-500 transition-colors z-10"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="p-8">
              <div className="flex items-start gap-4 mb-8">
                <div className="bg-red-50 p-3 rounded-xl border border-red-100 shrink-0">
                  <Package className="w-8 h-8 text-red-500" />
                </div>
                <div>
                  <h2 className="text-2xl font-black text-slate-800 leading-tight">{selectedSku.productName || 'Unknown Product'}</h2>
                  <p className="text-sm font-bold text-slate-500 font-mono mt-1">{selectedSku.sku}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                
                {/* Numbers breakdown */}
                <div className="space-y-4">
                  <h3 className="font-extrabold text-slate-800 text-sm uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">Financial Breakdown</h3>
                  
                  <div className="bg-slate-50 rounded-xl p-5 border border-slate-100 space-y-3">
                    <div className="flex justify-between items-center text-sm font-bold text-slate-800 pb-2 border-b border-slate-200">
                      <span>Gross Revenue ({selectedSku.units} units)</span>
                      <span className="text-emerald-600">{formatCurrency(selectedSku.grossRevenue)}</span>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs font-semibold text-slate-600">
                      <span>Product Cost</span>
                      <span className="text-slate-500">{formatCurrency(selectedSku.productCostTotal)}</span>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs font-semibold text-slate-600">
                      <span>Amazon Commission</span>
                      <span className="text-red-500">{formatCurrency(selectedSku.commission)}</span>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs font-semibold text-slate-600">
                      <span>FBA Fees</span>
                      <span className="text-orange-500">{formatCurrency(selectedSku.fbaFees)}</span>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs font-semibold text-slate-600">
                      <span>GST & TCS</span>
                      <span className="text-slate-500">{formatCurrency(selectedSku.gstTcs)}</span>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs font-semibold text-slate-600 pb-2 border-b border-slate-200">
                      <span>Ad Spend (Mapped)</span>
                      <span className="text-blue-500">{formatCurrency(selectedSku.adSpend)}</span>
                    </div>
                    
                    <div className="flex justify-between items-center text-lg font-black text-slate-800 pt-1">
                      <span>Net Profit</span>
                      <span className={selectedSku.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                        {selectedSku.profit >= 0 ? '+' : ''}{formatCurrency(selectedSku.profit)}
                      </span>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-center">
                      <div className="text-[10px] font-extrabold text-blue-600 uppercase tracking-wider mb-1">ACOS %</div>
                      <div className="text-xl font-black text-blue-700">{selectedSku.acosPct.toFixed(1)}%</div>
                    </div>
                    <div className={`border rounded-xl p-4 text-center ${selectedSku.profit >= 0 ? 'bg-emerald-50 border-emerald-100' : 'bg-red-50 border-red-100'}`}>
                      <div className={`text-[10px] font-extrabold uppercase tracking-wider mb-1 ${selectedSku.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>Net Margin</div>
                      <div className={`text-xl font-black ${selectedSku.profit >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                        {selectedSku.grossRevenue > 0 ? ((selectedSku.profit / selectedSku.grossRevenue) * 100).toFixed(1) : 0}%
                      </div>
                    </div>
                  </div>
                </div>

                {/* Donut Chart */}
                <div className="flex flex-col items-center justify-center bg-white border border-slate-100 rounded-xl p-4 shadow-xs">
                   <h3 className="font-extrabold text-slate-800 text-sm uppercase tracking-wider mb-2 w-full text-left">Cost Distribution</h3>
                   <div className="h-64 w-full relative">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={[
                              { name: 'Product Cost', value: Math.abs(selectedSku.productCostTotal), color: '#94a3b8' },
                              { name: 'Commission', value: Math.abs(selectedSku.commission), color: '#ef4444' },
                              { name: 'FBA Fees', value: Math.abs(selectedSku.fbaFees), color: '#f97316' },
                              { name: 'GST & TCS', value: Math.abs(selectedSku.gstTcs), color: '#cbd5e1' },
                              { name: 'Ad Spend', value: Math.abs(selectedSku.adSpend), color: '#3b82f6' },
                              { name: 'Profit', value: selectedSku.profit > 0 ? selectedSku.profit : 0, color: '#10b981' }
                            ].filter(d => d.value > 0)}
                            cx="50%"
                            cy="50%"
                            innerRadius={55}
                            outerRadius={80}
                            paddingAngle={2}
                            dataKey="value"
                            stroke="none"
                            label={({ percent }) => percent > 0.03 ? `${(percent * 100).toFixed(0)}%` : ''}
                          >
                            {
                              [
                                { name: 'Product Cost', value: Math.abs(selectedSku.productCostTotal), color: '#94a3b8' },
                                { name: 'Commission', value: Math.abs(selectedSku.commission), color: '#ef4444' },
                                { name: 'FBA Fees', value: Math.abs(selectedSku.fbaFees), color: '#f97316' },
                                { name: 'GST & TCS', value: Math.abs(selectedSku.gstTcs), color: '#cbd5e1' },
                                { name: 'Ad Spend', value: Math.abs(selectedSku.adSpend), color: '#3b82f6' },
                                { name: 'Profit', value: selectedSku.profit > 0 ? selectedSku.profit : 0, color: '#10b981' }
                              ].filter(d => d.value > 0).map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={entry.color} />
                              ))
                            }
                          </Pie>
                          <RechartsTooltip 
                            formatter={(value, name) => {
                              const pct = selectedSku.grossRevenue > 0 ? ((value / selectedSku.grossRevenue) * 100).toFixed(1) : 0;
                              return [`${formatCurrency(value)} (${pct}%)`, name];
                            }}
                            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                          />
                          <Legend 
                            formatter={(value) => {
                              const items = [
                                { name: 'Product Cost', value: Math.abs(selectedSku.productCostTotal) },
                                { name: 'Commission', value: Math.abs(selectedSku.commission) },
                                { name: 'FBA Fees', value: Math.abs(selectedSku.fbaFees) },
                                { name: 'GST & TCS', value: Math.abs(selectedSku.gstTcs) },
                                { name: 'Ad Spend', value: Math.abs(selectedSku.adSpend) },
                                { name: 'Profit', value: selectedSku.profit > 0 ? selectedSku.profit : 0 }
                              ];
                              const match = items.find(d => d.name === value);
                              if (!match) return value;
                              const pct = selectedSku.grossRevenue > 0 ? ((match.value / selectedSku.grossRevenue) * 100).toFixed(1) : 0;
                              return `${value} (${pct}%)`;
                            }}
                            wrapperStyle={{ fontSize: '10px', fontWeight: 'bold' }} 
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none pb-6">
                         <div className="text-center">
                            <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Revenue</span>
                            <span className="block text-lg font-black text-slate-800">{formatCurrency(selectedSku.grossRevenue)}</span>
                         </div>
                      </div>
                   </div>
                </div>

              </div>
            </div>
            
          </div>
        </div>
      )}
        </>
      )}

      {pnlTab === 'statement' && ledgerMetrics && (
        <div className="space-y-6 animate-fade-in">
          {/* Aesthetic Style Toggles */}
          <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-50 border border-slate-200 rounded-xl p-3.5 shadow-2xs">
            <div className="flex items-center gap-2.5">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Aesthetic Style:</span>
              <div className="inline-flex rounded-lg bg-slate-200/80 p-0.5 border border-slate-300/40">
                <button
                  onClick={() => setLedgerViewMode('terminal')}
                  className={`px-3 py-1 text-xs font-black rounded-md cursor-pointer transition-all ${
                    ledgerViewMode === 'terminal'
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  🖥️ Classic Terminal
                </button>
                <button
                  onClick={() => setLedgerViewMode('modern')}
                  className={`px-3 py-1 text-xs font-black rounded-md cursor-pointer transition-all ${
                    ledgerViewMode === 'modern'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  ✨ Modern Dashboard
                </button>
              </div>
            </div>
          </div>

          {/* Render Terminal style Ledger */}
          {ledgerViewMode === 'terminal' && (
            <div className="bg-[#0f0f11] text-[#e4e4e7] font-mono p-6 rounded-xl border border-[#27272a] shadow-2xl overflow-x-auto selection:bg-red-500/30 selection:text-white">
              <div className="min-w-[700px] text-xs leading-5">
                {/* Table Header */}
                <div className="grid grid-cols-5 font-black text-[#a1a1aa] border-b border-dashed border-[#3f3f46] pb-2 mb-2">
                  <div className="col-span-1">Type</div>
                  <div className="col-span-1">Ledger Name</div>
                  <div className="col-span-1 text-right">Base Value</div>
                  <div className="col-span-1 text-right">Tax</div>
                  <div className="col-span-1 text-right">Total</div>
                </div>

                {/* Section: Revenue from Sales */}
                <div className="mb-2">
                  {ledgerMetrics.revenue.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-5">
                      <div className="col-span-1 text-[#71717a]">{idx === 0 ? "Revenue from Sales" : ""}</div>
                      <div className="col-span-1 text-white">{row.name}</div>
                      <div className="col-span-1 text-right text-white">{formatLedger(row.base)}</div>
                      <div className="col-span-1 text-right text-[#a1a1aa]">{formatLedger(row.tax)}</div>
                      <div className="col-span-1 text-right text-white">{formatLedger(row.total)}</div>
                    </div>
                  ))}
                  <div className="grid grid-cols-5 border-t border-dashed border-[#27272a] pt-1 mt-1 font-bold text-emerald-400">
                    <div className="col-span-1"></div>
                    <div className="col-span-1">Total</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.revenueTotal.base)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.revenueTotal.tax)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.revenueTotal.total)}</div>
                  </div>
                </div>

                <div className="border-b border-dashed border-[#27272a] my-2"></div>

                {/* Section: Marketing Spend */}
                <div className="mb-2">
                  {ledgerMetrics.marketing.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-5">
                      <div className="col-span-1 text-[#71717a]">{idx === 0 ? "Marketing Spend" : ""}</div>
                      <div className="col-span-1 text-white">{row.name}</div>
                      <div className="col-span-1 text-right text-[#f43f5e]">{formatLedger(row.base)}</div>
                      <div className="col-span-1 text-right text-[#a1a1aa]">{formatLedger(row.tax)}</div>
                      <div className="col-span-1 text-right text-[#f43f5e]">{formatLedger(row.total)}</div>
                    </div>
                  ))}
                  <div className="grid grid-cols-5 border-t border-dashed border-[#27272a] pt-1 mt-1 font-bold text-[#f43f5e]">
                    <div className="col-span-1"></div>
                    <div className="col-span-1">Total</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.marketingTotal.base)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.marketingTotal.tax)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.marketingTotal.total)}</div>
                  </div>
                </div>

                <div className="border-b border-dashed border-[#27272a] my-2"></div>

                {/* Section: Expense */}
                <div className="mb-2">
                  {ledgerMetrics.expense.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-5">
                      <div className="col-span-1 text-[#71717a]">{idx === 0 ? "Expense" : ""}</div>
                      <div className="col-span-1 text-white">{row.name}</div>
                      <div className="col-span-1 text-right text-[#f43f5e]">{formatLedger(row.base)}</div>
                      <div className="col-span-1 text-right text-[#a1a1aa]">{formatLedger(row.tax)}</div>
                      <div className="col-span-1 text-right text-[#f43f5e]">{formatLedger(row.total)}</div>
                    </div>
                  ))}
                  <div className="grid grid-cols-5 border-t border-dashed border-[#27272a] pt-1 mt-1 font-bold text-[#f43f5e]">
                    <div className="col-span-1"></div>
                    <div className="col-span-1">Total</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.expenseTotal.base)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.expenseTotal.tax)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.expenseTotal.total)}</div>
                  </div>
                </div>

                <div className="border-b border-dashed border-[#27272a] my-2"></div>

                {/* Section: Input Tax Credit */}
                <div className="mb-2">
                  {ledgerMetrics.itc.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-5">
                      <div className="col-span-1 text-[#71717a]">{idx === 0 ? "Input Tax Credit" : ""}</div>
                      <div className="col-span-1 text-white">{row.name}</div>
                      <div className="col-span-1 text-right text-white">{formatLedger(row.base)}</div>
                      <div className="col-span-1 text-right text-blue-400">{formatLedger(row.tax)}</div>
                      <div className="col-span-1 text-right text-blue-400">{formatLedger(row.total)}</div>
                    </div>
                  ))}
                  <div className="grid grid-cols-5 border-t border-dashed border-[#27272a] pt-1 mt-1 font-bold text-blue-400">
                    <div className="col-span-1"></div>
                    <div className="col-span-1">Total</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.itcTotal.base)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.itcTotal.tax)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.itcTotal.total)}</div>
                  </div>
                </div>

                <div className="border-b border-dashed border-[#27272a] my-2"></div>

                {/* Section: Tax Deductions */}
                <div className="mb-2">
                  {ledgerMetrics.taxDeductions.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-5">
                      <div className="col-span-1 text-[#71717a]">{idx === 0 ? "Tax Deductions" : ""}</div>
                      <div className="col-span-1 text-white">{row.name}</div>
                      <div className="col-span-1 text-right text-[#f43f5e]">{formatLedger(row.base)}</div>
                      <div className="col-span-1 text-right text-[#a1a1aa]">{formatLedger(row.tax)}</div>
                      <div className="col-span-1 text-right text-[#f43f5e]">{formatLedger(row.total)}</div>
                    </div>
                  ))}
                  <div className="grid grid-cols-5 border-t border-dashed border-[#27272a] pt-1 mt-1 font-bold text-[#f43f5e]">
                    <div className="col-span-1"></div>
                    <div className="col-span-1">Total</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.taxDeductionsTotal.base)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.taxDeductionsTotal.tax)}</div>
                    <div className="col-span-1 text-right">{formatLedger(ledgerMetrics.taxDeductionsTotal.total)}</div>
                  </div>
                </div>

                {/* Section: Profit & Loss */}
                <div className="border-t border-double border-b border-[#3f3f46] py-2 my-3 text-white font-black text-sm">
                  <div className="grid grid-cols-5">
                    <div className="col-span-2">PROFIT & LOSS</div>
                    <div className="col-span-1 text-right text-emerald-400">₹{formatLedger(ledgerMetrics.profitAndLoss.base)}</div>
                    <div className="col-span-1 text-right text-emerald-400">₹{formatLedger(ledgerMetrics.profitAndLoss.tax)}</div>
                    <div className="col-span-1 text-right text-emerald-400">₹{formatLedger(ledgerMetrics.profitAndLoss.total)}</div>
                  </div>
                </div>

                {/* Section: Key Metrics */}
                <div className="mb-4">
                  <div className="text-[#a1a1aa] font-bold uppercase tracking-wider mb-2 border-b border-dashed border-[#27272a] pb-1">Key Metrics</div>
                  <div className="grid grid-cols-5">
                    <div className="col-span-2 text-white">Net Margin</div>
                    <div className="col-span-3 text-right text-white font-bold">{ledgerMetrics.keyMetrics.netMargin}</div>
                  </div>
                  <div className="grid grid-cols-5">
                    <div className="col-span-2 text-white">TACOS (Ad Spend / Net Revenue)</div>
                    <div className="col-span-3 text-right text-white font-bold">{ledgerMetrics.keyMetrics.tacos}</div>
                  </div>
                </div>

                {/* Section: Tax & Net P&L Summary */}
                <div className="border-t border-dashed border-[#3f3f46] pt-3">
                  <div className="text-[#a1a1aa] font-bold uppercase tracking-wider mb-2 border-b border-dashed border-[#27272a] pb-1">Tax & Net P&L Summary</div>
                  <div className="grid grid-cols-5">
                    <div className="col-span-2 text-white">Base P&L (excl. taxes)</div>
                    <div className="col-span-3 text-right text-white font-bold">₹{formatLedger(ledgerMetrics.taxSummary.basePnl)}</div>
                  </div>
                  <div className="pl-4 text-[#a1a1aa]">
                    <div>Input Tax Credit:</div>
                    <div className="grid grid-cols-5 pl-4 text-xs mt-1">
                      <div className="col-span-2">Ad Spend GST @18%</div>
                      <div className="col-span-3 text-right text-white">₹{formatLedger(ledgerMetrics.taxSummary.itcAdSpend)}</div>
                    </div>
                    <div className="grid grid-cols-5 pl-4 text-xs">
                      <div className="col-span-2">Expense Taxes</div>
                      <div className="col-span-3 text-right text-white">₹{formatLedger(ledgerMetrics.taxSummary.itcExpense)}</div>
                    </div>
                    <div className="grid grid-cols-5 pl-4 text-xs">
                      <div className="col-span-2">Other ITC</div>
                      <div className="col-span-3 text-right text-white">₹{formatLedger(ledgerMetrics.taxSummary.itcOther)}</div>
                    </div>
                    <div className="grid grid-cols-5 pl-4 text-xs font-bold border-t border-dashed border-[#27272a] pt-0.5 mt-0.5">
                      <div className="col-span-2 text-white">Total Input Tax</div>
                      <div className="col-span-3 text-right text-white">₹{formatLedger(ledgerMetrics.taxSummary.itcTotal)}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-5 border-t border-double border-[#3f3f46] pt-1.5 mt-2 font-black text-emerald-400 text-sm">
                    <div className="col-span-2">Net P&L (Base + ITC)</div>
                    <div className="col-span-3 text-right">₹{formatLedger(ledgerMetrics.taxSummary.netPnl)}</div>
                  </div>
                  <div className="grid grid-cols-5 font-bold text-white text-xs mt-1">
                    <div className="col-span-2">Net Margin (adjusted)</div>
                    <div className="col-span-3 text-right">{ledgerMetrics.taxSummary.netMarginAdjusted}</div>
                  </div>
                  <div className="grid grid-cols-5 font-bold text-white text-xs">
                    <div className="col-span-2">TACOS (on Base Revenue)</div>
                    <div className="col-span-3 text-right">{ledgerMetrics.taxSummary.tacosBaseRevenue}</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Modern Dashboard style Ledger */}
          {ledgerViewMode === 'modern' && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[700px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                      <th className="py-3.5 px-5">Type / Ledger Name</th>
                      <th className="py-3.5 px-5 text-right">Base Value</th>
                      <th className="py-3.5 px-5 text-right">Tax</th>
                      <th className="py-3.5 px-5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {/* Section: Revenue */}
                    <tr className="bg-emerald-50/30">
                      <td colSpan="4" className="py-2.5 px-5 font-extrabold text-emerald-700 uppercase text-[10px] tracking-wider flex items-center justify-between cursor-pointer"
                          onClick={() => setCollapsedSections(prev => ({ ...prev, revenue: !prev.revenue }))}>
                        <span>Revenue from Sales</span>
                        <span>{collapsedSections.revenue ? '➕ Show' : '➖ Hide'}</span>
                      </td>
                    </tr>
                    {!collapsedSections.revenue && ledgerMetrics.revenue.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50 transition">
                        <td className="py-3 px-5 pl-8 font-medium text-slate-700">{row.name}</td>
                        <td className="py-3 px-5 text-right font-semibold text-slate-900">{formatLedger(row.base)}</td>
                        <td className="py-3 px-5 text-right font-semibold text-slate-400">{row.tax !== 0 ? formatLedger(row.tax) : '—'}</td>
                        <td className={`py-3 px-5 text-right font-extrabold ${row.total >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatLedger(row.total)}</td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-t border-slate-200 font-extrabold text-emerald-700">
                      <td className="py-3 px-5 pl-8">Total Revenue</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.revenueTotal.base)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.revenueTotal.tax)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.revenueTotal.total)}</td>
                    </tr>

                    {/* Section: Marketing Spend */}
                    <tr className="bg-red-50/30">
                      <td colSpan="4" className="py-2.5 px-5 font-extrabold text-[#ef4444] uppercase text-[10px] tracking-wider flex items-center justify-between cursor-pointer"
                          onClick={() => setCollapsedSections(prev => ({ ...prev, marketing: !prev.marketing }))}>
                        <span>Marketing Spend</span>
                        <span>{collapsedSections.marketing ? '➕ Show' : '➖ Hide'}</span>
                      </td>
                    </tr>
                    {!collapsedSections.marketing && ledgerMetrics.marketing.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50 transition">
                        <td className="py-3 px-5 pl-8 font-medium text-slate-700">{row.name}</td>
                        <td className="py-3 px-5 text-right font-semibold text-red-500">{formatLedger(row.base)}</td>
                        <td className="py-3 px-5 text-right font-semibold text-slate-400">{row.tax !== 0 ? formatLedger(row.tax) : '—'}</td>
                        <td className="py-3 px-5 text-right font-extrabold text-red-500">{formatLedger(row.total)}</td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-t border-slate-200 font-extrabold text-[#ef4444]">
                      <td className="py-3 px-5 pl-8">Total Marketing Spend</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.marketingTotal.base)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.marketingTotal.tax)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.marketingTotal.total)}</td>
                    </tr>

                    {/* Section: Expense */}
                    <tr className="bg-red-50/30">
                      <td colSpan="4" className="py-2.5 px-5 font-extrabold text-[#ef4444] uppercase text-[10px] tracking-wider flex items-center justify-between cursor-pointer"
                          onClick={() => setCollapsedSections(prev => ({ ...prev, expense: !prev.expense }))}>
                        <span>Expense</span>
                        <span>{collapsedSections.expense ? '➕ Show' : '➖ Hide'}</span>
                      </td>
                    </tr>
                    {!collapsedSections.expense && ledgerMetrics.expense.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50 transition">
                        <td className="py-3 px-5 pl-8 font-medium text-slate-700">{row.name}</td>
                        <td className={`py-3 px-5 text-right font-semibold ${row.base < 0 ? 'text-red-500' : 'text-emerald-600'}`}>{formatLedger(row.base)}</td>
                        <td className={`py-3 px-5 text-right font-semibold ${row.tax < 0 ? 'text-red-500' : row.tax > 0 ? 'text-emerald-600' : 'text-slate-400'}`}>{row.tax !== 0 ? formatLedger(row.tax) : '—'}</td>
                        <td className={`py-3 px-5 text-right font-extrabold ${row.total < 0 ? 'text-red-500' : 'text-emerald-600'}`}>{formatLedger(row.total)}</td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-t border-slate-200 font-extrabold text-[#ef4444]">
                      <td className="py-3 px-5 pl-8">Total Expense</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.expenseTotal.base)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.expenseTotal.tax)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.expenseTotal.total)}</td>
                    </tr>

                    {/* Section: Input Tax Credit */}
                    <tr className="bg-blue-50/30">
                      <td colSpan="4" className="py-2.5 px-5 font-extrabold text-blue-700 uppercase text-[10px] tracking-wider flex items-center justify-between cursor-pointer"
                          onClick={() => setCollapsedSections(prev => ({ ...prev, itc: !prev.itc }))}>
                        <span>Input Tax Credit</span>
                        <span>{collapsedSections.itc ? '➕ Show' : '➖ Hide'}</span>
                      </td>
                    </tr>
                    {!collapsedSections.itc && ledgerMetrics.itc.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50 transition">
                        <td className="py-3 px-5 pl-8 font-medium text-slate-700">{row.name}</td>
                        <td className="py-3 px-5 text-right font-semibold text-slate-900">{formatLedger(row.base)}</td>
                        <td className="py-3 px-5 text-right font-semibold text-blue-600">{formatLedger(row.tax)}</td>
                        <td className="py-3 px-5 text-right font-extrabold text-blue-600">{formatLedger(row.total)}</td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-t border-slate-200 font-extrabold text-blue-700">
                      <td className="py-3 px-5 pl-8">Total Input Tax Credit</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.itcTotal.base)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.itcTotal.tax)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.itcTotal.total)}</td>
                    </tr>

                    {/* Section: Tax Deductions */}
                    <tr className="bg-slate-100/50">
                      <td colSpan="4" className="py-2.5 px-5 font-extrabold text-slate-700 uppercase text-[10px] tracking-wider flex items-center justify-between cursor-pointer"
                          onClick={() => setCollapsedSections(prev => ({ ...prev, taxDeductions: !prev.taxDeductions }))}>
                        <span>Tax Deductions</span>
                        <span>{collapsedSections.taxDeductions ? '➕ Show' : '➖ Hide'}</span>
                      </td>
                    </tr>
                    {!collapsedSections.taxDeductions && ledgerMetrics.taxDeductions.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50 transition">
                        <td className="py-3 px-5 pl-8 font-medium text-slate-700">{row.name}</td>
                        <td className="py-3 px-5 text-right font-semibold text-red-500">{formatLedger(row.base)}</td>
                        <td className="py-3 px-5 text-right font-semibold text-slate-400">{row.tax !== 0 ? formatLedger(row.tax) : '—'}</td>
                        <td className="py-3 px-5 text-right font-extrabold text-red-500">{formatLedger(row.total)}</td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-t border-slate-200 font-extrabold text-slate-700">
                      <td className="py-3 px-5 pl-8">Total Tax Deductions</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.taxDeductionsTotal.base)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.taxDeductionsTotal.tax)}</td>
                      <td className="py-3 px-5 text-right">{formatLedger(ledgerMetrics.taxDeductionsTotal.total)}</td>
                    </tr>

                    {/* PROFIT & LOSS */}
                    <tr className="bg-slate-800 text-white font-extrabold text-sm border-t-2 border-slate-900">
                      <td className="py-4 px-5">PROFIT & LOSS</td>
                      <td className="py-4 px-5 text-right">₹{formatLedger(ledgerMetrics.profitAndLoss.base)}</td>
                      <td className="py-4 px-5 text-right">₹{formatLedger(ledgerMetrics.profitAndLoss.tax)}</td>
                      <td className={`py-4 px-5 text-right text-base font-black ${ledgerMetrics.profitAndLoss.total >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        ₹{formatLedger(ledgerMetrics.profitAndLoss.total)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Bottom summaries grid: Key Metrics & Tax Summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
              <h3 className="font-extrabold text-slate-800 border-b border-slate-100 pb-2 uppercase tracking-wider text-xs text-slate-400">Key Metrics</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between font-medium">
                  <span className="text-slate-600">Net Margin</span>
                  <span className="font-extrabold text-slate-950">{ledgerMetrics.keyMetrics.netMargin}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span className="text-slate-600">TACOS (Ad Spend / Net Revenue)</span>
                  <span className="font-extrabold text-slate-950">{ledgerMetrics.keyMetrics.tacos}</span>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
              <h3 className="font-extrabold text-slate-800 border-b border-slate-100 pb-2 uppercase tracking-wider text-xs text-slate-400">Tax & Net P&L Summary</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between font-medium">
                  <span className="text-slate-600">Base P&L (excl. taxes)</span>
                  <span className="font-extrabold text-slate-950">₹{formatLedger(ledgerMetrics.taxSummary.basePnl)}</span>
                </div>
                <div className="pl-4 space-y-1.5 border-l-2 border-slate-100 text-xs">
                  <div className="flex justify-between text-slate-500">
                    <span>Ad Spend GST @18%</span>
                    <span>₹{formatLedger(ledgerMetrics.taxSummary.itcAdSpend)}</span>
                  </div>
                  <div className="flex justify-between text-slate-500">
                    <span>Expense Taxes</span>
                    <span>₹{formatLedger(ledgerMetrics.taxSummary.itcExpense)}</span>
                  </div>
                  <div className="flex justify-between text-slate-500">
                    <span>Other ITC</span>
                    <span>₹{formatLedger(ledgerMetrics.taxSummary.itcOther)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-slate-700 pt-1 border-t border-dashed border-slate-150">
                    <span>Total Input Tax</span>
                    <span>₹{formatLedger(ledgerMetrics.taxSummary.itcTotal)}</span>
                  </div>
                </div>
                <div className="flex justify-between font-extrabold text-emerald-600 border-t border-slate-150 pt-2 text-base">
                  <span>Net P&L (Base + ITC)</span>
                  <span>₹{formatLedger(ledgerMetrics.taxSummary.netPnl)}</span>
                </div>
                <div className="flex justify-between font-bold text-slate-800 text-xs">
                  <span>Net Margin (adjusted)</span>
                  <span>{ledgerMetrics.taxSummary.netMarginAdjusted}</span>
                </div>
                <div className="flex justify-between font-bold text-slate-800 text-xs">
                  <span>TACOS (on Base Revenue)</span>
                  <span>{ledgerMetrics.taxSummary.tacosBaseRevenue}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
