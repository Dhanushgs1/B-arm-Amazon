'use client';
import React, { use,  useState, useEffect } from 'react';
import { BarChart2, Loader2 } from 'lucide-react';

export default function CampaignPeriodComparison({ supabaseUrl, supabaseKey, dateTo }) {
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
            const url = `${supabaseUrl}/rest/v1/${table}?select=*&${dateCol}=gte.${d30Str}&${dateCol}=lte.${endDayStr}&limit=${limit}&offset=${offset}`;
            try {
              const res = await fetch(url, { headers });
              if (!res.ok) break;
              const data = await res.json();
              results = results.concat(data);
              if (data.length < limit) break;
              offset += limit;
            } catch (e) {
              break;
            }
          }
          return results;
        };

        const perfData = await fetchAll('flipkart_campaign_performance_rows', 'report_date');

        const campMap = {};

        const addMetrics = (campName, dateStr, spend, adSales) => {
          if (!campMap[campName]) {
            campMap[campName] = {
              campaign: campName,
              d1: { spend: 0, adSales: 0 },
              d7: { spend: 0, adSales: 0 },
              d14: { spend: 0, adSales: 0 },
              d30: { spend: 0, adSales: 0 }
            };
          }

          const targetDate = new Date(dateStr).getTime();
          const d30 = d30Date.getTime();
          
          const d14Date = new Date(endDate); d14Date.setDate(d14Date.getDate() - 13);
          const d7Date = new Date(endDate); d7Date.setDate(d7Date.getDate() - 6);
          const d1Date = new Date(endDate);
          
          let minFound = Infinity;
          perfData.forEach(r => {
             const t = new Date(r.report_date).getTime();
             if (t < minFound) minFound = t;
          });

          const d14Time = new Date(d14Date.toISOString().split('T')[0]).getTime();
          const d7Time = new Date(d7Date.toISOString().split('T')[0]).getTime();
          
          setActualStartDates({
             d30: minFound !== Infinity && minFound > d30Date.getTime() ? minFound : d30Date.getTime(),
             d14: minFound !== Infinity && minFound > d14Time ? minFound : d14Time,
             d7: minFound !== Infinity && minFound > d7Time ? minFound : d7Time,
          });

          const d1Time = new Date(d1Date.toISOString().split('T')[0]).getTime();
          const targetTime = new Date(dateStr).getTime();

          if (targetTime >= d30) {
            campMap[campName].d30.spend += spend;
            campMap[campName].d30.adSales += adSales;
          }
          if (targetTime >= d14Time) {
            campMap[campName].d14.spend += spend;
            campMap[campName].d14.adSales += adSales;
          }
          if (targetTime >= d7Time) {
            campMap[campName].d7.spend += spend;
            campMap[campName].d7.adSales += adSales;
          }
          if (targetTime >= d1Time) {
            campMap[campName].d1.spend += spend;
            campMap[campName].d1.adSales += adSales;
          }
        };

        perfData.forEach(r => {
          const campName = r.campaign_name || 'UNKNOWN';
          addMetrics(campName, r.report_date, Number(r.ad_spend || 0), Number(r.total_revenue_rs || 0));
        });

        const computed = Object.values(campMap).map(c => {
          ['d1', 'd7', 'd14', 'd30'].forEach(period => {
             c[period].sales = c[period].adSales;
             c[period].roas = c[period].spend > 0 ? (c[period].adSales / c[period].spend) : 0;
             c[period].acos = c[period].adSales > 0 ? (c[period].spend / c[period].adSales * 100) : 0;
          });
          return c;
        });

        // Sort by 30D spend desc
        computed.sort((a, b) => b.d30.spend - a.d30.spend);
        setRenderData(computed);
      } catch (err) {
        console.error('Failed to fetch campaign period data:', err);
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
        <span className="text-slate-500 font-medium">Loading live campaign period data...</span>
      </div>
    );
  }

  if (renderData.length === 0) {
    return null;
  }

  const totals = {
    d1: { sales: 0, spend: 0, adSales: 0 },
    d7: { sales: 0, spend: 0, adSales: 0 },
    d14: { sales: 0, spend: 0, adSales: 0 },
    d30: { sales: 0, spend: 0, adSales: 0 }
  };

  renderData.forEach(row => {
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
          <h2 className="text-sm font-extrabold text-slate-800">Campaign Period Comparison (Live)</h2>
        </div>
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          <span className="text-orange-500">1D</span> · <span className="text-blue-500">7D</span> · <span className="text-purple-500">14D</span> · <span className="text-green-500">30D</span>
        </div>
      </div>
      
      <div className="overflow-x-auto max-h-[600px]">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="px-4 py-3 bg-white border-b border-r border-slate-100 font-extrabold text-slate-400 uppercase tracking-wider sticky left-0 z-30 w-[240px]">
                Campaign
              </th>
              {/* Yesterday */}
              <th className="px-0 py-0 border-b border-r border-slate-100 bg-orange-50" colSpan="4">
                <div className="text-center py-2 text-orange-500 font-extrabold tracking-wider border-b border-orange-200">{header1}</div>
                <div className="flex text-center text-[10px] text-slate-400 font-bold uppercase py-1">
                  <div className="flex-1 px-2">Sales</div>
                  <div className="flex-1 px-2">Spend</div>
                  <div className="flex-1 px-2">ROAS</div>
                  <div className="flex-1 px-2">ACOS</div>
                </div>
              </th>
              {/* 7 Days */}
              <th className="px-0 py-0 border-b border-r border-slate-100 bg-blue-50" colSpan="4">
                <div className="text-center py-2 text-blue-500 font-extrabold tracking-wider border-b border-blue-200">{header7}</div>
                <div className="flex text-center text-[10px] text-slate-400 font-bold uppercase py-1">
                  <div className="flex-1 px-2">Sales</div>
                  <div className="flex-1 px-2">Spend</div>
                  <div className="flex-1 px-2">ROAS</div>
                  <div className="flex-1 px-2">ACOS</div>
                </div>
              </th>
              {/* 14 Days */}
              <th className="px-0 py-0 border-b border-r border-slate-100 bg-purple-50" colSpan="4">
                <div className="text-center py-2 text-purple-500 font-extrabold tracking-wider border-b border-purple-200">{header14}</div>
                <div className="flex text-center text-[10px] text-slate-400 font-bold uppercase py-1">
                  <div className="flex-1 px-2">Sales</div>
                  <div className="flex-1 px-2">Spend</div>
                  <div className="flex-1 px-2">ROAS</div>
                  <div className="flex-1 px-2">ACOS</div>
                </div>
              </th>
              {/* 30 Days */}
              <th className="px-0 py-0 border-b border-slate-100 bg-emerald-50" colSpan="4">
                <div className="text-center py-2 text-emerald-600 font-extrabold tracking-wider border-b border-emerald-200">{header30}</div>
                <div className="flex text-center text-[10px] text-slate-400 font-bold uppercase py-1">
                  <div className="flex-1 px-2">Sales</div>
                  <div className="flex-1 px-2">Spend</div>
                  <div className="flex-1 px-2">ROAS</div>
                  <div className="flex-1 px-2">ACOS</div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {renderData.map((row, i) => (
              <tr key={i} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3 border-r border-slate-100 bg-white sticky left-0 z-10 w-[240px]">
                  <div className="font-extrabold text-slate-800 truncate w-[220px]" title={row.campaign}>{row.campaign}</div>
                </td>
                
                {/* Yesterday */}
                <td className="px-2 py-3 text-slate-600 font-semibold bg-orange-50/20 text-center">{formatVal(row.d1.sales)}</td>
                <td className="px-2 py-3 text-slate-500 font-semibold bg-orange-50/20 text-center">{formatVal(row.d1.spend)}</td>
                <td className={`px-2 py-3 font-extrabold bg-orange-50/20 text-center ${getColor(row.d1.roas, true)}`}>{formatVal(row.d1.roas, false, true)}</td>
                <td className={`px-2 py-3 border-r border-slate-100 font-extrabold bg-orange-50/20 text-center ${getColor(row.d1.acos, false)}`}>{formatVal(row.d1.acos, true)}</td>
                
                {/* 7 Days */}
                <td className="px-2 py-3 text-slate-600 font-semibold bg-blue-50/20 text-center">{formatVal(row.d7.sales)}</td>
                <td className="px-2 py-3 text-slate-500 font-semibold bg-blue-50/20 text-center">{formatVal(row.d7.spend)}</td>
                <td className={`px-2 py-3 font-extrabold bg-blue-50/20 text-center ${getColor(row.d7.roas, true)}`}>{formatVal(row.d7.roas, false, true)}</td>
                <td className={`px-2 py-3 border-r border-slate-100 font-extrabold bg-blue-50/20 text-center ${getColor(row.d7.acos, false)}`}>{formatVal(row.d7.acos, true)}</td>
                
                {/* 14 Days */}
                <td className="px-2 py-3 text-slate-600 font-semibold bg-purple-50/20 text-center">{formatVal(row.d14.sales)}</td>
                <td className="px-2 py-3 text-slate-500 font-semibold bg-purple-50/20 text-center">{formatVal(row.d14.spend)}</td>
                <td className={`px-2 py-3 font-extrabold bg-purple-50/20 text-center ${getColor(row.d14.roas, true)}`}>{formatVal(row.d14.roas, false, true)}</td>
                <td className={`px-2 py-3 border-r border-slate-100 font-extrabold bg-purple-50/20 text-center ${getColor(row.d14.acos, false)}`}>{formatVal(row.d14.acos, true)}</td>
                
                {/* 30 Days */}
                <td className="px-2 py-3 text-slate-600 font-semibold bg-emerald-50/20 text-center">{formatVal(row.d30.sales)}</td>
                <td className="px-2 py-3 text-slate-500 font-semibold bg-emerald-50/20 text-center">{formatVal(row.d30.spend)}</td>
                <td className={`px-2 py-3 font-extrabold bg-emerald-50/20 text-center ${getColor(row.d30.roas, true)}`}>{formatVal(row.d30.roas, false, true)}</td>
                <td className={`px-2 py-3 font-extrabold bg-emerald-50/20 text-center ${getColor(row.d30.acos, false)}`}>{formatVal(row.d30.acos, true)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 z-20 bg-slate-100 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]">
            <tr>
              <td className="px-4 py-3 font-black text-slate-800 uppercase tracking-wider bg-slate-100 sticky left-0 z-30 border-r border-slate-200">
                OVERALL TOTAL
              </td>
              
              {/* Yesterday */}
              <td className="px-2 py-3 font-bold text-slate-700 bg-orange-100/50 text-center border-t border-orange-200">{formatVal(totals.d1.sales)}</td>
              <td className="px-2 py-3 font-bold text-slate-700 bg-orange-100/50 text-center border-t border-orange-200">{formatVal(totals.d1.spend)}</td>
              <td className={`px-2 py-3 font-black bg-orange-100/50 text-center border-t border-orange-200 ${getColor(totals.d1.roas, true)}`}>{formatVal(totals.d1.roas, false, true)}</td>
              <td className={`px-2 py-3 border-r border-slate-200 font-black bg-orange-100/50 text-center border-t border-orange-200 ${getColor(totals.d1.acos, false)}`}>{formatVal(totals.d1.acos, true)}</td>
              
              {/* 7 Days */}
              <td className="px-2 py-3 font-bold text-slate-700 bg-blue-100/50 text-center border-t border-blue-200">{formatVal(totals.d7.sales)}</td>
              <td className="px-2 py-3 font-bold text-slate-700 bg-blue-100/50 text-center border-t border-blue-200">{formatVal(totals.d7.spend)}</td>
              <td className={`px-2 py-3 font-black bg-blue-100/50 text-center border-t border-blue-200 ${getColor(totals.d7.roas, true)}`}>{formatVal(totals.d7.roas, false, true)}</td>
              <td className={`px-2 py-3 border-r border-slate-200 font-black bg-blue-100/50 text-center border-t border-blue-200 ${getColor(totals.d7.acos, false)}`}>{formatVal(totals.d7.acos, true)}</td>
              
              {/* 14 Days */}
              <td className="px-2 py-3 font-bold text-slate-700 bg-purple-100/50 text-center border-t border-purple-200">{formatVal(totals.d14.sales)}</td>
              <td className="px-2 py-3 font-bold text-slate-700 bg-purple-100/50 text-center border-t border-purple-200">{formatVal(totals.d14.spend)}</td>
              <td className={`px-2 py-3 font-black bg-purple-100/50 text-center border-t border-purple-200 ${getColor(totals.d14.roas, true)}`}>{formatVal(totals.d14.roas, false, true)}</td>
              <td className={`px-2 py-3 border-r border-slate-200 font-black bg-purple-100/50 text-center border-t border-purple-200 ${getColor(totals.d14.acos, false)}`}>{formatVal(totals.d14.acos, true)}</td>
              
              {/* 30 Days */}
              <td className="px-2 py-3 font-bold text-slate-700 bg-emerald-100/50 text-center border-t border-emerald-200">{formatVal(totals.d30.sales)}</td>
              <td className="px-2 py-3 font-bold text-slate-700 bg-emerald-100/50 text-center border-t border-emerald-200">{formatVal(totals.d30.spend)}</td>
              <td className={`px-2 py-3 font-black bg-emerald-100/50 text-center border-t border-emerald-200 ${getColor(totals.d30.roas, true)}`}>{formatVal(totals.d30.roas, false, true)}</td>
              <td className={`px-2 py-3 font-black bg-emerald-100/50 text-center border-t border-emerald-200 ${getColor(totals.d30.acos, false)}`}>{formatVal(totals.d30.acos, true)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
