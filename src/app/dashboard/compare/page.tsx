"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Brain, ArrowRight, GitCompare } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";
import { AllMarketplacesSummary } from "@/components/marketplace/AllMarketplacesSummary";
import { OverallDashboard } from "@/components/marketplace/OverallDashboard";

// The "All" tab. Everything on it comes from AllMarketplacesSummary, i.e. the same Supabase data
// and rules as each marketplace's own reports. The earlier Amazon + Flipkart sections were built on
// SellerMate's live retail endpoint, whose sales run ~1.7-2.2x high at the source, and showed
// Flipkart as ₹0 — they were replaced on 29 Sep 2026.
export default function ComparePage() {
  const { startDate, endDate } = useDashboard();
  const dot = (d: string) => (d ? d.split("-").reverse().join(".") : "");

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-900 via-purple-900 to-slate-900 p-6 border border-indigo-500/30 shadow-xl">
        <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute -bottom-8 -left-8 w-36 h-36 rounded-full bg-purple-500/10 blur-3xl" />
        <div className="relative flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-xl bg-white/10 flex items-center justify-center">
                <GitCompare className="w-4 h-4 text-indigo-300" />
              </div>
              <span className="text-indigo-300 text-[10px] font-black uppercase tracking-widest">Overall</span>
            </div>
            <h1 className="text-2xl font-black tracking-tight text-white">Marketplace Intelligence Dashboard</h1>
            <p className="text-indigo-300/80 text-xs mt-1 font-semibold">
              {dot(startDate)} – {dot(endDate)} · Amazon, Flipkart, Meesho, Shopify, Google Ads &amp; Meta
            </p>
          </div>
          <Link
            href="/dashboard/ai"
            className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white border border-white/20 px-4 py-2 rounded-xl text-xs font-black transition-all backdrop-blur-sm"
          >
            <Brain className="w-3.5 h-3.5" /> Ask AI Assistant <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      <OverallDashboard />

      {/* returns, net orders and cancellations per marketplace; shares the sales loads above */}
      <AllMarketplacesSummary />
    </motion.div>
  );
}
