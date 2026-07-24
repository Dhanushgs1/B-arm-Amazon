"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { MARKETPLACE_META, type MarketplaceId } from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { BarChart3, Download, FileText, CheckCircle2 } from "lucide-react";

export function MarketplaceReports({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const meta = MARKETPLACE_META[marketplace];

  const reports = [
    { title: `${meta.label} Executive Sales Summary`, type: "PDF / Excel", freq: "Weekly", lastGenerated: "Yesterday" },
    { title: `${meta.label} Ad Campaign & Search Term Audit`, type: "CSV / XLSX", freq: "Daily", lastGenerated: "Today at 06:00 AM" },
    { title: `${meta.label} Inventory & Replenishment Alert`, type: "XLSX", freq: "Daily", lastGenerated: "Today at 08:30 AM" },
    { title: `${meta.label} Automated Rules Execution Log`, type: "CSV", freq: "Realtime", lastGenerated: "12 mins ago" },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="space-y-6 pb-12">
      <PageHero
        title={`${meta.label} Reports & Data Exports`}
        subtitle={`Generate, schedule, and export comprehensive sales and ad report files for ${meta.label}.`}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {reports.map((r, i) => (
          <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.08, duration: 0.5 }} className="p-5 rounded-2xl bg-card border border-border shadow-sm flex items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                <h4 className="font-extrabold text-sm text-slate-900 dark:text-white">{r.title}</h4>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">Format: {r.type} • Schedule: {r.freq}</p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">Last generated: {r.lastGenerated}</p>
            </div>
            <button className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow transition-all cursor-pointer flex-shrink-0">
              <Download className="w-3.5 h-3.5" /> Download
            </button>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
