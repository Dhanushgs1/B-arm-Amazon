"use client";

import { motion } from "framer-motion";
import { Sparkles, Download, RefreshCw, Zap } from "lucide-react";

interface HeroChip {
  label: string;
  value: string;
  accent?: string; // text color class for value
}

interface PageHeroProps {
  title: string;
  subtitle: string;
  badge?: string;
  workspace?: string;
  dateRange?: string;
  chips?: HeroChip[];
  primaryAction?: string;
  onPrimaryAction?: () => void;
  onRefresh?: () => void;
  onExport?: () => void;
}

export function PageHero({ title, subtitle, badge = "Live Sync", workspace, dateRange, chips = [], primaryAction = "Generate AI Report", onPrimaryAction, onRefresh, onExport }: PageHeroProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="relative overflow-hidden rounded-2xl border border-emerald-100 dark:border-slate-800 bg-gradient-to-br from-emerald-50 via-white to-white dark:from-slate-900 dark:via-slate-900 dark:to-slate-900 text-slate-900 dark:text-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >

      <div className="relative z-10 px-6 py-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="flex items-center gap-1.5 text-[10px] font-bold bg-emerald-100 border border-emerald-200 text-emerald-700 dark:bg-emerald-500/15 dark:border-emerald-500/20 dark:text-emerald-300 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" /> {badge}
              </span>
              {workspace && <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">Workspace: {workspace}</span>}
              {dateRange && <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">· {dateRange}</span>}
            </div>
            <h1 className="text-2xl lg:text-[26px] leading-tight font-bold tracking-tight">{title}</h1>
            <p className="text-slate-500 dark:text-slate-400 text-xs max-w-2xl font-medium">{subtitle}</p>

            {chips.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {chips.map((chip) => (
                  <div key={chip.label} className="bg-white dark:bg-slate-800 border border-emerald-100 dark:border-slate-700 rounded-xl px-3 py-1.5">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{chip.label}</p>
                    <p className={`text-sm font-bold mt-0.5 ${chip.accent || ""}`}>{chip.value}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex lg:flex-row items-stretch gap-2 flex-wrap flex-shrink-0">
            <button onClick={onPrimaryAction || (() => alert("AI generation is disabled in this environment."))} className="flex items-center justify-center gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm">
              <Sparkles className="w-3.5 h-3.5" /> {primaryAction}
            </button>
            <button onClick={onExport} className="flex items-center justify-center gap-1.5 bg-white hover:bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-slate-800 dark:text-emerald-300 dark:border-slate-700 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all">
              <Download className="w-3.5 h-3.5" /> Export
            </button>
            <button onClick={onRefresh} className="flex items-center justify-center gap-1.5 bg-white hover:bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-slate-800 dark:text-emerald-300 dark:border-slate-700 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <button onClick={() => alert("Bulk Optimize is currently not enabled in this demo environment.")} className="flex items-center justify-center gap-1.5 bg-white hover:bg-emerald-50 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all">
              <Zap className="w-3.5 h-3.5" /> Bulk Optimize
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
