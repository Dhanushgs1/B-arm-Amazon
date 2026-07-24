'use client';
import React, { useState, useRef, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
  Upload, FileText, X, TrendingUp, ShoppingBag, Package,
  IndianRupee, BarChart2, AlertCircle, CheckCircle2, RefreshCcw, Info
} from 'lucide-react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend,
  BarController
} from 'chart.js';
import { Bar } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, BarController);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const parseNum = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  return parseFloat(String(v).replace(/,/g, '').trim()) || 0;
};

const parseDate = (raw) => {
  if (!raw) return null;
  // format: "01 May 2026 12:00:00 AM UTC" or ISO
  try {
    const clean = String(raw).replace(' UTC', '').trim();
    const d = new Date(clean);
    if (!isNaN(d)) return d;
  } catch (_) {}
  return null;
};

const fmt = (v) =>
  '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const COLORS = {
  gross:   '#6366f1',
  net:     '#10b981',
  cost:    '#f59e0b',
  adSpend: '#ef4444',
  profit:  '#14b8a6',
  refund:  '#f97316',
};

// ─── Main Component ───────────────────────────────────────────────────────────
export default function AmazonCSVAnalytics() {
  const [txRows, setTxRows]     = useState(null);   // filtered Order rows
  const [adRows, setAdRows]     = useState(null);
  const [txFile, setTxFile]     = useState(null);
  const [adFile, setAdFile]     = useState(null);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const txRef = useRef();
  const adRef = useRef();

  // ── Parse Transaction CSV ──────────────────────────────────────────────────
  const parseTx = (file) => {
    setLoading(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      // Skip first 13 rows (Amazon report header junk)
      const lines = text.split('\n');
      const csvBody = lines.slice(13).join('\n');

      Papa.parse(csvBody, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
        complete: (result) => {
          // Filter only Order type
          const orders = result.data.filter(
            (r) => (r.type || '').trim().toLowerCase() === 'order'
          );
          setTxRows(orders);
          setLoading(false);
        },
        error: (err) => { setError('Transaction CSV parse error: ' + err.message); setLoading(false); }
      });
    };
    reader.readAsText(file);
  };

  const parseAd = (file) => {
    setLoading(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
      complete: (result) => { setAdRows(result.data); setLoading(false); },
      error: (err) => { setError('Ads CSV parse error: ' + err.message); setLoading(false); }
    });
  };

  const handleTx = (f) => { setTxFile(f); parseTx(f); };
  const handleAd = (f) => { setAdFile(f); parseAd(f); };

  // ── Computed Metrics ───────────────────────────────────────────────────────
  const metrics = useMemo(() => {
    if (!txRows) return null;

    // ── KPIs ────────────────────────────────────────────────────────────────
    let grossSales = 0, netPayout = 0, refunds = 0;

    txRows.forEach((r) => {
      grossSales += parseNum(r.product_sales);
      netPayout  += parseNum(r.total);
      if (parseNum(r.product_sales) < 0) refunds += parseNum(r.product_sales);
    });

    const estCost  = grossSales * 0.5;
    const adSpend  = adRows ? adRows.reduce((s, r) => s + parseNum(r.total_cost), 0) : 0;
    const grossProfit = grossSales - estCost - adSpend;

    // ── Daily aggregation ────────────────────────────────────────────────────
    const dailyTx  = {};   // day 1-31 → { gross, net }
    const dailyAds = {};   // day 1-31 → adSpend

    txRows.forEach((r) => {
      const d = parseDate(r['date/time'] || r.date_time || r.date);
      if (!d) return;
      const day = d.getDate();
      if (!dailyTx[day]) dailyTx[day] = { gross: 0, net: 0 };
      dailyTx[day].gross += parseNum(r.product_sales);
      dailyTx[day].net   += parseNum(r.total);
    });

    if (adRows) {
      adRows.forEach((r) => {
        const d = r.date_start ? new Date(r.date_start) : null;
        if (!d || isNaN(d)) return;
        const day = d.getDate();
        if (!dailyAds[day]) dailyAds[day] = 0;
        dailyAds[day] += parseNum(r.total_cost);
      });
    }

    // ── SKU aggregation ──────────────────────────────────────────────────────
    const skuMap = {};
    txRows.forEach((r) => {
      const sku = (r.sku || r['sku'] || 'Unknown').trim();
      if (!skuMap[sku]) skuMap[sku] = { units: 0, gross: 0, net: 0, adSpend: 0 };
      skuMap[sku].units += Math.abs(parseNum(r.quantity));
      skuMap[sku].gross += parseNum(r.product_sales);
      skuMap[sku].net   += parseNum(r.total);
    });

    // Map ad spend to SKU
    if (adRows) {
      adRows.forEach((r) => {
        const sku = (r.advertised_product_sku || '').trim();
        if (skuMap[sku]) {
          skuMap[sku].adSpend += parseNum(r.total_cost);
        } else {
          // Try partial match
          const matchKey = Object.keys(skuMap).find(k =>
            k.toLowerCase().includes(sku.toLowerCase()) ||
            sku.toLowerCase().includes(k.toLowerCase())
          );
          if (matchKey) skuMap[matchKey].adSpend += parseNum(r.total_cost);
        }
      });
    }

    const skuList = Object.entries(skuMap).map(([sku, v]) => {
      const cost50  = v.gross * 0.5;
      const profit  = v.gross - cost50 - v.adSpend;
      const margin  = v.gross > 0 ? (profit / v.gross) * 100 : 0;
      return { sku, ...v, cost50, profit, margin };
    }).sort((a, b) => b.gross - a.gross);

    return { grossSales, netPayout, estCost, adSpend, grossProfit, refunds, dailyTx, dailyAds, skuList };
  }, [txRows, adRows]);

  // ── Chart Configs ──────────────────────────────────────────────────────────
  const dailyChartData = useMemo(() => {
    if (!metrics) return null;
    const days = Array.from({ length: 31 }, (_, i) => i + 1);
    const { dailyTx, dailyAds } = metrics;

    return {
      labels: days,
      datasets: [
        {
          label: 'Gross Sales',
          data: days.map(d => dailyTx[d]?.gross || 0),
          backgroundColor: COLORS.gross + 'cc',
          borderColor: COLORS.gross,
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'y',
          order: 2,
        },
        {
          label: 'Ad Spend',
          data: days.map(d => dailyAds[d] || 0),
          backgroundColor: COLORS.adSpend + 'cc',
          borderColor: COLORS.adSpend,
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'y2',
          order: 1,
        },
      ],
    };
  }, [metrics]);

  const skuBarData = useMemo(() => {
    if (!metrics) return null;
    const top = metrics.skuList.slice(0, 12);
    return {
      labels: top.map(s => s.sku.length > 18 ? s.sku.slice(0, 18) + '…' : s.sku),
      datasets: [
        {
          label: 'Net Payout',
          data: top.map(s => s.net),
          backgroundColor: COLORS.net + 'cc',
          borderRadius: 4,
        },
        {
          label: 'Est. Cost (50%)',
          data: top.map(s => s.cost50),
          backgroundColor: COLORS.cost + 'cc',
          borderRadius: 4,
        },
        {
          label: 'Ad Spend',
          data: top.map(s => s.adSpend),
          backgroundColor: COLORS.adSpend + 'cc',
          borderRadius: 4,
        },
      ],
    };
  }, [metrics]);

  const dailyChartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { font: { weight: 'bold', size: 11 }, padding: 16 } },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.raw)}`,
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { weight: '600', size: 10 } } },
      y: {
        type: 'linear', position: 'left',
        grid: { color: '#f1f5f9' },
        ticks: { callback: (v) => '₹' + (v / 1000).toFixed(0) + 'k', font: { size: 10 } },
        title: { display: true, text: 'Gross Sales (₹)', font: { size: 11, weight: 'bold' }, color: COLORS.gross },
      },
      y2: {
        type: 'linear', position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { callback: (v) => '₹' + (v / 1000).toFixed(0) + 'k', font: { size: 10 } },
        title: { display: true, text: 'Ad Spend (₹)', font: { size: 11, weight: 'bold' }, color: COLORS.adSpend },
      },
    },
  };

  const skuBarOpts = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { font: { weight: 'bold', size: 11 }, padding: 16 } },
      tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.raw)}` } },
    },
    scales: {
      x: {
        grid: { color: '#f1f5f9' },
        ticks: { callback: (v) => '₹' + (v / 1000).toFixed(0) + 'k', font: { size: 10 } },
      },
      y: { grid: { display: false }, ticks: { font: { size: 10, weight: '600' } } },
    },
  };

  const marginPill = (m) => {
    if (m > 30) return 'bg-emerald-100 text-emerald-700 border border-emerald-200';
    if (m > 10) return 'bg-amber-100 text-amber-700 border border-amber-200';
    return 'bg-red-100 text-red-700 border border-red-200';
  };

  // ── Upload Zone ────────────────────────────────────────────────────────────
  const DropZone = ({ label, file, onFile, accept, icon: Icon, color }) => {
    const ref = useRef();
    const [drag, setDrag] = useState(false);
    const onDrop = (e) => {
      e.preventDefault(); setDrag(false);
      const f = e.dataTransfer.files[0];
      if (f) onFile(f);
    };
    return (
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => ref.current.click()}
        className={`relative flex flex-col items-center justify-center p-8 rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-200 ${
          file ? 'border-emerald-400 bg-emerald-50/50' :
          drag  ? `border-${color}-400 bg-${color}-50/30` :
                  'border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-white'
        }`}
      >
        <input ref={ref} type="file" accept={accept} className="hidden" onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
        {file ? (
          <>
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-3" />
            <p className="text-sm font-extrabold text-emerald-700">{file.name}</p>
            <p className="text-[10px] text-emerald-600 font-semibold mt-1">{(file.size / 1024).toFixed(1)} KB — click to replace</p>
          </>
        ) : (
          <>
            <Icon className={`w-10 h-10 text-slate-400 mb-3`} />
            <p className="text-sm font-extrabold text-slate-700">{label}</p>
            <p className="text-[10px] text-slate-400 font-semibold mt-1">Drag & drop or click to upload (.csv)</p>
          </>
        )}
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8 animate-fade-in-up">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
        <BarChart2 className="w-8 h-8 text-red-500" />
        <div>
          <h2 className="text-2xl font-black text-slate-800">Amazon CSV Analytics</h2>
          <p className="text-sm font-semibold text-slate-500">Upload your Monthly Unified Transaction + Ads CSV for instant P&L analysis</p>
        </div>
      </div>

      {/* Upload Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="space-y-2">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
            <span className="text-xs font-extrabold text-slate-600 uppercase tracking-wider">Unified Transaction Report</span>
            <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-bold">skip 13 rows</span>
          </div>
          <DropZone
            label="2026MayMonthlyUnifiedTransaction.csv"
            file={txFile}
            onFile={handleTx}
            accept=".csv"
            icon={FileText}
            color="indigo"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-red-500"></div>
            <span className="text-xs font-extrabold text-slate-600 uppercase tracking-wider">Amazon Ads Report</span>
            <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-bold">Optional</span>
          </div>
          <DropZone
            label="amazon_ads_clean.csv"
            file={adFile}
            onFile={handleAd}
            accept=".csv"
            icon={TrendingUp}
            color="red"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm font-semibold">
          <AlertCircle className="w-5 h-5 shrink-0" />
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <RefreshCcw className="w-8 h-8 text-red-500 animate-spin mr-3" />
          <span className="font-bold text-slate-600 text-lg">Parsing CSV data...</span>
        </div>
      )}

      {/* ── Dashboard ── */}
      {metrics && !loading && (
        <>
          {/* ── ROW 1: KPI Cards ── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {[
              { label: 'Gross Sales',     value: metrics.grossSales,  color: 'indigo',  icon: ShoppingBag },
              { label: 'Net Payout',      value: metrics.netPayout,   color: 'emerald', icon: IndianRupee },
              { label: 'Est. Prod. Cost', value: metrics.estCost,     color: 'amber',   icon: Package,    note: '50% of Gross' },
              { label: 'Ad Spend',        value: metrics.adSpend,     color: 'red',     icon: TrendingUp  },
              { label: 'Gross Profit',    value: metrics.grossProfit, color: metrics.grossProfit >= 0 ? 'teal' : 'rose', icon: BarChart2 },
              { label: 'Refunds',         value: metrics.refunds,     color: 'orange',  icon: RefreshCcw  },
            ].map(({ label, value, color, icon: Icon, note }) => (
              <div key={label} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
                <div className={`text-[10px] font-extrabold uppercase tracking-wider mb-2 text-${color}-600`}>{label}</div>
                {note && <div className="text-[9px] text-slate-400 font-semibold mb-1">{note}</div>}
                <div className={`text-xl font-black ${value < 0 ? 'text-red-600' : 'text-slate-800'}`}>
                  {value < 0 ? '-' : ''}{fmt(value)}
                </div>
              </div>
            ))}
          </div>

          {/* ── ROW 2: Daily Bar Chart ── */}
          {dailyChartData && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
                  <BarChart2 className="w-5 h-5 text-indigo-500" />
                  Daily Gross Sales vs Ad Spend — May 2026
                </h3>
                <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
                  <Info className="w-3 h-3" /> Left Y: Sales · Right Y: Ad Spend
                </div>
              </div>
              <div className="h-80">
                <Bar data={dailyChartData} options={dailyChartOpts} />
              </div>
            </div>
          )}

          {/* ── ROW 3: Horizontal SKU Bar Chart ── */}
          {skuBarData && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h3 className="font-extrabold text-slate-800 text-lg mb-5 flex items-center gap-2">
                <Package className="w-5 h-5 text-amber-500" />
                Per-SKU: Net Payout vs Est. Cost vs Ad Spend
              </h3>
              <div style={{ height: `${Math.min(metrics.skuList.length, 12) * 48 + 60}px` }}>
                <Bar data={skuBarData} options={skuBarOpts} />
              </div>
            </div>
          )}

          {/* ── ROW 4: SKU Table ── */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
                <Package className="w-5 h-5 text-red-500" /> SKU-Level P&L Table
              </h3>
              <span className="text-xs font-bold text-slate-500 bg-white px-3 py-1 rounded-full border border-slate-200">
                {metrics.skuList.length} SKUs
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[900px]">
                <thead>
                  <tr className="bg-white border-b border-slate-200">
                    {['SKU', 'Units', 'Gross ₹', 'Net ₹', 'Cost 50%', 'Ad Spend', 'Gross Profit', 'Margin %'].map((h, i) => (
                      <th key={h} className={`py-3 px-4 text-[10px] font-extrabold text-slate-500 uppercase tracking-wider ${i > 0 ? 'text-right' : ''}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {metrics.skuList.map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-800 text-xs">{row.sku}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-semibold text-slate-600 text-sm">{row.units.toLocaleString('en-IN')}</td>
                      <td className="py-3 px-4 text-right font-bold text-slate-800 text-sm">{fmt(row.gross)}</td>
                      <td className="py-3 px-4 text-right font-semibold text-emerald-600 text-sm">{fmt(row.net)}</td>
                      <td className="py-3 px-4 text-right font-semibold text-amber-600 text-sm">{fmt(row.cost50)}</td>
                      <td className="py-3 px-4 text-right font-semibold text-red-500 text-sm">{fmt(row.adSpend)}</td>
                      <td className="py-3 px-4 text-right">
                        <span className={`font-black text-sm px-2 py-1 rounded-md ${row.profit >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                          {row.profit >= 0 ? '+' : ''}{fmt(row.profit)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className={`text-[10px] font-black px-2 py-1 rounded-full ${marginPill(row.margin)}`}>
                          {row.margin.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}

                  {/* Totals row */}
                  <tr className="bg-slate-800 text-white font-black">
                    <td className="py-3 px-4 text-sm">TOTAL</td>
                    <td className="py-3 px-4 text-right text-sm">
                      {metrics.skuList.reduce((s, r) => s + r.units, 0).toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-4 text-right text-sm">{fmt(metrics.grossSales)}</td>
                    <td className="py-3 px-4 text-right text-sm">{fmt(metrics.netPayout)}</td>
                    <td className="py-3 px-4 text-right text-sm">{fmt(metrics.estCost)}</td>
                    <td className="py-3 px-4 text-right text-sm">{fmt(metrics.adSpend)}</td>
                    <td className="py-3 px-4 text-right text-sm">
                      <span className={metrics.grossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {metrics.grossProfit >= 0 ? '+' : ''}{fmt(metrics.grossProfit)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm">
                      <span className={`px-2 py-1 rounded-full text-[10px] ${
                        metrics.grossSales > 0
                          ? marginPill((metrics.grossProfit / metrics.grossSales) * 100)
                          : ''
                      }`}>
                        {metrics.grossSales > 0 ? ((metrics.grossProfit / metrics.grossSales) * 100).toFixed(1) : 0}%
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!txRows && !loading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Upload className="w-16 h-16 text-slate-300 mb-4" />
          <h3 className="text-xl font-extrabold text-slate-600">Upload your CSV files to begin</h3>
          <p className="text-sm text-slate-400 font-semibold mt-2 max-w-md">
            Upload the Unified Transaction CSV (required) and the Amazon Ads CSV (optional) to generate your P&L dashboard instantly — no server needed.
          </p>
        </div>
      )}
    </div>
  );
}
