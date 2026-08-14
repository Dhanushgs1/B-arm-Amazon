'use client';
import React, { use,  useState, useEffect } from 'react';
import { BarChart2, Loader2 } from 'lucide-react';

export default function ProductPeriodComparison({ supabaseUrl, supabaseKey, dateTo, productSearch = '', productFilter = 'all' }) {
  const [renderData, setRenderData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actualStartDates, setActualStartDates] = useState(null);

  const formatVal = (val, isPct = false, isRoas = false) => {
    if (val === null || val === undefined || isNaN(val)) return "—";
    if (isPct) return `${val.toFixed(1)}%`;
    if (isRoas) return `${val.toFixed(1)}x`;
    return `₹${val.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
  };

  const getColor = (val, isRoas) => {
    if (val === null || val === undefined || isNaN(val)) return 'text-slate-400';
    if (isRoas) {
      if (val >= 4) return 'text-emerald-600';
      if (val >= 2) return 'text-amber-500';
      return 'text-red-500';
    } else {
      if (val <= 20) return 'text-emerald-600';
      if (val <= 40) return 'text-amber-500';
      return 'text-red-500';
    }
  };

  const endDate = dateTo ? new Date(dateTo) : new Date();
  
  const getPastDateStr = (timestampOrDaysBack) => {
    let d;
    if (typeof timestampOrDaysBack === 'number' && timestampOrDaysBack < 100) {
      d = new Date(endDate);
      d.setDate(d.getDate() - timestampOrDaysBack);
    } else {
      d = new Date(timestampOrDaysBack);
    }
    return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }).toUpperCase();
  };

  const endStr = getPastDateStr(0);

  const header1 = endStr;
  const header7 = actualStartDates?.d7 === endDate.getTime() ? endStr : `${getPastDateStr(actualStartDates?.d7 || 6)} - ${endStr}`;
  const header14 = actualStartDates?.d14 === endDate.getTime() ? endStr : `${getPastDateStr(actualStartDates?.d14 || 13)} - ${endStr}`;
  const header30 = actualStartDates?.d30 === endDate.getTime() ? endStr : `${getPastDateStr(actualStartDates?.d30 || 29)} - ${endStr}`;

  useEffect(() => {
    if (!supabaseUrl || !supabaseKey) {
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      try {
        const d30Date = new Date(endDate);
        d30Date.setDate(d30Date.getDate() - 29);
        const d30Str = d30Date.toISOString().split('T')[0];
        const endDayStr = endDate.toISOString().split('T')[0];

        const headers = {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        };

        const fetchAll = async (table, dateCol) => {
          let results = [];
          let offset = 0;
          const limit = 1000;
          while (true) {
            const url = `${supabaseUrl}/rest/v1/${table}?select=*&${dateCol}=gte.${d30Str}&${dateCol}=lte.${endDayStr}&limit=${limit}&offset=${offset}&order=${dateCol}.desc`;
            try {
              const res = await fetch(url, { headers });
              if (!res.ok) break;
              const data = await res.json();
              
              // Infinite loop failsafe
              if (data.length === 0) break;
              if (results.length > 0 && JSON.stringify(data[0]) === JSON.stringify(results[results.length - data.length])) break;
              
              results = results.concat(data);
              if (data.length < limit) break;
              offset += limit;
              
              if (results.length > 20000) break; // Hard limit failsafe
            } catch (e) {
              break;
            }
          }
          return results;
        };

        const [perfData, salesData] = await Promise.all([
          fetchAll('flipkart_campaign_performance_rows', 'report_date'),
          fetchAll('flipkart_overall_sales_rows', 'order_date')
        ]);

        const d30 = d30Date.getTime();
        const d14Date = new Date(endDate); d14Date.setDate(d14Date.getDate() - 13);
        const d7Date = new Date(endDate); d7Date.setDate(d7Date.getDate() - 6);
        const d1Date = new Date(endDate);
        
        let minFound = Infinity;
        perfData.forEach(r => {
           const t = new Date(r.report_date).getTime();
           if (t < minFound) minFound = t;
        });
        salesData.forEach(r => {
           const t = new Date(r.order_date).getTime();
           if (t < minFound) minFound = t;
        });

        const d14Time = new Date(d14Date.toISOString().split('T')[0]).getTime();
        const d7Time = new Date(d7Date.toISOString().split('T')[0]).getTime();
        const d1Time = new Date(d1Date.toISOString().split('T')[0]).getTime();
        
        setActualStartDates({
           d30: minFound !== Infinity && minFound > d30 ? minFound : d30,
           d14: minFound !== Infinity && minFound > d14Time ? minFound : d14Time,
           d7: minFound !== Infinity && minFound > d7Time ? minFound : d7Time,
        });

        const productMap = {};

        const addMetrics = (sku, name, dateStr, spend, adSales, sales) => {
          if (!productMap[sku]) {
            productMap[sku] = {
              sku,
              product: name || sku,
              d1: { spend: 0, adSales: 0, sales: 0 },
              d7: { spend: 0, adSales: 0, sales: 0 },
              d14: { spend: 0, adSales: 0, sales: 0 },
              d30: { spend: 0, adSales: 0, sales: 0 }
            };
          }
          if (name && productMap[sku].product === sku) {
            productMap[sku].product = name;
          }

          const targetTime = new Date(dateStr).getTime(); // assuming dateStr is YYYY-MM-DD

          if (targetTime >= d30) {
            productMap[sku].d30.spend += spend;
            productMap[sku].d30.adSales += adSales;
            productMap[sku].d30.sales += sales;
          }
          if (targetTime >= d14Time) {
            productMap[sku].d14.spend += spend;
            productMap[sku].d14.adSales += adSales;
            productMap[sku].d14.sales += sales;
          }
          if (targetTime >= d7Time) {
            productMap[sku].d7.spend += spend;
            productMap[sku].d7.adSales += adSales;
            productMap[sku].d7.sales += sales;
          }
          if (targetTime >= d1Time) {
            productMap[sku].d1.spend += spend;
            productMap[sku].d1.adSales += adSales;
            productMap[sku].d1.sales += sales;
          }
        };

        perfData.forEach(r => {
          const sku = r.sku_id || 'UNKNOWN';
          const name = r.product_name;
          addMetrics(sku, name, r.report_date, Number(r.ad_spend || 0), Number(r.total_revenue_rs || 0), 0);
        });

        salesData.forEach(r => {
          const sku = r.sku_id || r.seller_sku_id || 'UNKNOWN';
          const name = r.product_title || r.product_name;
          const sales = Number(r.gmv) || Number(r.final_sale_amount) || 0;
          addMetrics(sku, name, r.order_date, 0, 0, sales);
        });

        const computed = Object.values(productMap).map(p => {
          // Calculate ROAS and ACOS for each period
          ['d1', 'd7', 'd14', 'd30'].forEach(period => {
             // Fallback: If total sales is 0 but we have adSales, use adSales as sales
             p[period].sales = p[period].sales > 0 ? p[period].sales : p[period].adSales;
             p[period].roas = p[period].spend > 0 ? (p[period].adSales / p[period].spend) : 0;
             p[period].acos = p[period].adSales > 0 ? (p[period].spend / p[period].adSales * 100) : 0;
          });
          
          if (p.sku === 'Slim01') {
            p.product = "Lakshmi Krishna Slim & Strength Weight Loss Powder Protein Blends (500 g, No flavor)";
          } else if (p.sku === 'Slim02') {
            p.product = "Lakshmi Krishna Slim & Strength Powder for Weight Loss Protein Blends (1 kg, No flavor)";
          }
          return p;
        });

        // Sort by 30D sales desc, show all products
        computed.sort((a, b) => b.d30.sales - a.d30.sales);
        setRenderData(computed);
      } catch (err) {
        console.error('Failed to fetch product period data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [supabaseUrl, supabaseKey, endDate.getTime()]);

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs mb-6 p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mr-2" />
        <span className="text-slate-500 font-medium">Loading live product period data...</span>
      </div>
    );
  }

  const filteredData = renderData.filter(row => {
    const roas = row.d30.roas || 0;
    const status = roas >= 5.0 ? 'winner' : 'loser';
    if (productFilter !== 'all' && status !== productFilter) return false;

    const search = productSearch.toLowerCase();
    if (search) {
      if (!row.product.toLowerCase().includes(search) && !row.sku.toLowerCase().includes(search)) {
        return false;
      }
    }
    return true;
  });

  if (filteredData.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs mb-6 p-8 flex items-center justify-center">
        <span className="text-slate-500 font-medium">No products match your filters for comparison.</span>
      </div>
    );
  }

  const totals = {
    d1: { sales: 0, spend: 0, adSales: 0 },
    d7: { sales: 0, spend: 0, adSales: 0 },
    d14: { sales: 0, spend: 0, adSales: 0 },
    d30: { sales: 0, spend: 0, adSales: 0 }
  };

  filteredData.forEach(row => {
    ['d1', 'd7', 'd14', 'd30'].forEach(period => {
      totals[period].sales += row[period].sales;
      totals[period].spend += row[period].spend;
      totals[period].adSales += row[period].adSales;
    });
  });

  ['d1', 'd7', 'd14', 'd30'].forEach(period => {
    totals[period].roas = totals[period].spend > 0 ? (totals[period].adSales / totals[period].spend) : 0;
    totals[period].acos = totals[period].adSales > 0 ? (totals[period].spend / totals[period].adSales * 100) : 0;
  });

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-xs mb-6 overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <BarChart2 className="h-5 w-5 text-indigo-500" />
          <h2 className="text-sm font-extrabold text-slate-800">Product Period Comparison (Live)</h2>
        </div>
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          <span className="text-orange-500">1D</span> · <span className="text-blue-500">7D</span> · <span className="text-purple-500">14D</span> · <span className="text-green-500">30D</span>
        </div>
      </div>
      
      <div className="overflow-x-auto max-h-[600px]">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="px-4 py-3 bg-white border-b border-r border-slate-100 font-extrabold text-slate-400 uppercase tracking-wider sticky left-0 z-30 w-[280px]">
                Product
              </th>
              {/* 1 Day */}
              <th className="px-0 py-0 border-b border-r border-slate-100 bg-orange-50" colSpan="3">
                <div className="text-center py-2 border-b border-orange-200">
                  <div className="text-orange-500 font-black text-sm tracking-wider">1D</div>
                  <div className="text-orange-400 font-semibold text-[10px]">{header1}</div>
                </div>
                <div className="flex text-center text-[10px] text-slate-400 font-bold uppercase py-1">
                  <div className="flex-1 px-2">Sales</div>
                  <div className="flex-1 px-2">ROAS</div>
                  <div className="flex-1 px-2">ACOS</div>
                </div>
              </th>
              {/* 7 Days */}
              <th className="px-0 py-0 border-b border-r border-slate-100 bg-blue-50" colSpan="3">
                <div className="text-center py-2 border-b border-blue-200">
                  <div className="text-blue-500 font-black text-sm tracking-wider">7D</div>
                  <div className="text-blue-400 font-semibold text-[10px]">{header7}</div>
                </div>
                <div className="flex text-center text-[10px] text-slate-400 font-bold uppercase py-1">
                  <div className="flex-1 px-2">Sales</div>
                  <div className="flex-1 px-2">ROAS</div>
                  <div className="flex-1 px-2">ACOS</div>
                </div>
              </th>
              {/* 14 Days */}
              <th className="px-0 py-0 border-b border-r border-slate-100 bg-purple-50" colSpan="3">
                <div className="text-center py-2 border-b border-purple-200">
                  <div className="text-purple-500 font-black text-sm tracking-wider">14D</div>
                  <div className="text-purple-400 font-semibold text-[10px]">{header14}</div>
                </div>
                <div className="flex text-center text-[10px] text-slate-400 font-bold uppercase py-1">
                  <div className="flex-1 px-2">Sales</div>
                  <div className="flex-1 px-2">ROAS</div>
                  <div className="flex-1 px-2">ACOS</div>
                </div>
              </th>
              {/* 30 Days */}
              <th className="px-0 py-0 border-b border-slate-100 bg-emerald-50" colSpan="3">
                <div className="text-center py-2 border-b border-emerald-200">
                  <div className="text-emerald-600 font-black text-sm tracking-wider">30D</div>
                  <div className="text-emerald-500 font-semibold text-[10px]">{header30}</div>
                </div>
                <div className="flex text-center text-[10px] text-slate-400 font-bold uppercase py-1">
                  <div className="flex-1 px-2">Sales</div>
                  <div className="flex-1 px-2">ROAS</div>
                  <div className="flex-1 px-2">ACOS</div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredData.map((row, i) => (
              <tr key={i} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3 border-r border-slate-100 bg-white sticky left-0 z-10 w-[280px]">
                  <div className="font-extrabold text-slate-800 truncate w-[260px]" title={row.product}>{row.product}</div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5">{row.sku}</div>
                </td>
                
                {/* Yesterday */}
                <td className="px-3 py-3 text-slate-600 font-semibold bg-orange-50/20 text-center">{formatVal(row.d1.sales)}</td>
                <td className={`px-3 py-3 font-extrabold bg-orange-50/20 text-center ${getColor(row.d1.roas, true)}`}>{formatVal(row.d1.roas, false, true)}</td>
                <td className={`px-3 py-3 border-r border-slate-100 font-extrabold bg-orange-50/20 text-center ${getColor(row.d1.acos, false)}`}>{formatVal(row.d1.acos, true)}</td>
                
                {/* 7 Days */}
                <td className="px-3 py-3 text-slate-600 font-semibold bg-blue-50/20 text-center">{formatVal(row.d7.sales)}</td>
                <td className={`px-3 py-3 font-extrabold bg-blue-50/20 text-center ${getColor(row.d7.roas, true)}`}>{formatVal(row.d7.roas, false, true)}</td>
                <td className={`px-3 py-3 border-r border-slate-100 font-extrabold bg-blue-50/20 text-center ${getColor(row.d7.acos, false)}`}>{formatVal(row.d7.acos, true)}</td>
                
                {/* 14 Days */}
                <td className="px-3 py-3 text-slate-600 font-semibold bg-purple-50/20 text-center">{formatVal(row.d14.sales)}</td>
                <td className={`px-3 py-3 font-extrabold bg-purple-50/20 text-center ${getColor(row.d14.roas, true)}`}>{formatVal(row.d14.roas, false, true)}</td>
                <td className={`px-3 py-3 border-r border-slate-100 font-extrabold bg-purple-50/20 text-center ${getColor(row.d14.acos, false)}`}>{formatVal(row.d14.acos, true)}</td>
                
                {/* 30 Days */}
                <td className="px-3 py-3 text-slate-600 font-semibold bg-emerald-50/20 text-center">{formatVal(row.d30.sales)}</td>
                <td className={`px-3 py-3 font-extrabold bg-emerald-50/20 text-center ${getColor(row.d30.roas, true)}`}>{formatVal(row.d30.roas, false, true)}</td>
                <td className={`px-3 py-3 font-extrabold bg-emerald-50/20 text-center ${getColor(row.d30.acos, false)}`}>{formatVal(row.d30.acos, true)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 z-20 bg-slate-100 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]">
            <tr>
              <td className="px-4 py-3 font-black text-slate-800 uppercase tracking-wider bg-slate-100 sticky left-0 z-30 border-r border-slate-200">
                OVERALL TOTAL
              </td>
              
              {/* Yesterday */}
              <td className="px-3 py-3 font-bold text-slate-700 bg-orange-100/50 text-center border-t border-orange-200">{formatVal(totals.d1.sales)}</td>
              <td className={`px-3 py-3 font-black bg-orange-100/50 text-center border-t border-orange-200 ${getColor(totals.d1.roas, true)}`}>{formatVal(totals.d1.roas, false, true)}</td>
              <td className={`px-3 py-3 border-r border-slate-200 font-black bg-orange-100/50 text-center border-t border-orange-200 ${getColor(totals.d1.acos, false)}`}>{formatVal(totals.d1.acos, true)}</td>
              
              {/* 7 Days */}
              <td className="px-3 py-3 font-bold text-slate-700 bg-blue-100/50 text-center border-t border-blue-200">{formatVal(totals.d7.sales)}</td>
              <td className={`px-3 py-3 font-black bg-blue-100/50 text-center border-t border-blue-200 ${getColor(totals.d7.roas, true)}`}>{formatVal(totals.d7.roas, false, true)}</td>
              <td className={`px-3 py-3 border-r border-slate-200 font-black bg-blue-100/50 text-center border-t border-blue-200 ${getColor(totals.d7.acos, false)}`}>{formatVal(totals.d7.acos, true)}</td>
              
              {/* 14 Days */}
              <td className="px-3 py-3 font-bold text-slate-700 bg-purple-100/50 text-center border-t border-purple-200">{formatVal(totals.d14.sales)}</td>
              <td className={`px-3 py-3 font-black bg-purple-100/50 text-center border-t border-purple-200 ${getColor(totals.d14.roas, true)}`}>{formatVal(totals.d14.roas, false, true)}</td>
              <td className={`px-3 py-3 border-r border-slate-200 font-black bg-purple-100/50 text-center border-t border-purple-200 ${getColor(totals.d14.acos, false)}`}>{formatVal(totals.d14.acos, true)}</td>
              
              {/* 30 Days */}
              <td className="px-3 py-3 font-bold text-slate-700 bg-emerald-100/50 text-center border-t border-emerald-200">{formatVal(totals.d30.sales)}</td>
              <td className={`px-3 py-3 font-black bg-emerald-100/50 text-center border-t border-emerald-200 ${getColor(totals.d30.roas, true)}`}>{formatVal(totals.d30.roas, false, true)}</td>
              <td className={`px-3 py-3 font-black bg-emerald-100/50 text-center border-t border-emerald-200 ${getColor(totals.d30.acos, false)}`}>{formatVal(totals.d30.acos, true)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
