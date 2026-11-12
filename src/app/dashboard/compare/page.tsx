"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Brain, ArrowRight, GitCompare } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { AllMarketplacesSummary } from "@/components/marketplace/AllMarketplacesSummary";
import { OverallDashboard } from "@/components/marketplace/OverallDashboard";
import { SELLERMATE_ENABLED } from "@/lib/sellerMate";

// The "All" tab. Everything on it comes from AllMarketplacesSummary, i.e. the same Supabase data
// and rules as each marketplace's own reports. The earlier Amazon + Flipkart sections were built on
// SellerMate's live retail endpoint, whose sales run ~1.7-2.2x high at the source, and showed
// Flipkart as ₹0 — they were replaced on 29 Sep 2026.
export default function ComparePage() {
  const { startDate, endDate } = useDashboard();
  const dot = (d: string) => (d ? d.split("-").reverse().join(".") : "");

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      {/* light page header (user, 12 Nov 2026: no dark banner, light green theme) */}
      <div className="rounded-2xl bg-white dark:bg-slate-900 p-6 border border-emerald-100 dark:border-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 flex items-center justify-center">
                <GitCompare className="w-4 h-4 text-emerald-600 dark:text-emerald-300" />
              </div>
              <span className="text-emerald-700 dark:text-emerald-300 text-[10px] font-black uppercase tracking-widest">Overall</span>
            </div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Marketplace Intelligence Dashboard</h1>
            <p className="text-slate-500 dark:text-slate-400 text-xs mt-1 font-semibold">
              {dot(startDate)} – {dot(endDate)} · Amazon, Flipkart, Meesho, Shopify, Google Ads &amp; Meta
            </p>
          </div>
          {SELLERMATE_ENABLED && <Link
            href="/dashboard/ai"
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-xs font-black transition-all"
          >
            <Brain className="w-3.5 h-3.5" /> Ask AI Assistant <ArrowRight className="w-3 h-3" />
          </Link>}
        </div>
      </div>

      <OverallDashboard />

      {/* returns, net orders and cancellations per marketplace; shares the sales loads above */}
      <AllMarketplacesSummary />
    </motion.div>
  );
}
