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
      className="relative overflow-hidden rounded-2xl border border-white/40 dark:border-white/5 bg-gradient-to-br from-[#6D5EF8] via-[#7B5CF6] to-[#3B82F6] text-white shadow-[0_12px_40px_-15px_rgba(108,99,255,0.4)]"
    >
      {/* Animated glow + floating shapes */}
      <div className="absolute -top-16 -right-10 w-60 h-60 rounded-full bg-white/10 blur-3xl pointer-events-none animate-pulse" style={{ animationDuration: "5s" }} />
      <div className="absolute -bottom-24 left-1/3 w-64 h-64 rounded-full bg-[#EC4899]/15 blur-3xl pointer-events-none" />
      <div className="absolute top-4 right-1/3 w-16 h-16 rounded-3xl bg-white/5 rotate-12 border border-white/10 pointer-events-none" />

      <div className="relative z-10 px-6 py-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="flex items-center gap-1.5 text-[10px] font-bold bg-emerald-400/20 border border-emerald-300/30 text-emerald-100 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 bg-emerald-300 rounded-full animate-pulse" /> {badge}
              </span>
              {workspace && <span className="text-[10px] font-semibold text-white/80">Workspace: {workspace}</span>}
              {dateRange && <span className="text-[10px] font-semibold text-white/80">· {dateRange}</span>}
            </div>
            <h1 className="text-2xl lg:text-[26px] leading-tight font-bold tracking-tight">{title}</h1>
            <p className="text-white/80 text-xs max-w-2xl font-medium">{subtitle}</p>

            {chips.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {chips.map((chip) => (
                  <div key={chip.label} className="bg-white/10 border border-white/15 rounded-xl px-3 py-1.5 backdrop-blur-sm">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-white/70">{chip.label}</p>
                    <p className={`text-sm font-bold mt-0.5 ${chip.accent || ""}`}>{chip.value}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex lg:flex-row items-stretch gap-2 flex-wrap flex-shrink-0">
            <button onClick={onPrimaryAction || (() => alert("AI generation is disabled in this environment."))} className="flex items-center justify-center gap-1.5 bg-white text-[#5B4FE0] hover:bg-white/90 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all shadow-md">
              <Sparkles className="w-3.5 h-3.5" /> {primaryAction}
            </button>
            <button onClick={onExport} className="flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white border border-blue-500/50 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all shadow-md">
              <Download className="w-3.5 h-3.5" /> Export
            </button>
            <button onClick={onRefresh} className="flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white border border-blue-500/50 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all shadow-md">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <button onClick={() => alert("Bulk Optimize is currently not enabled in this demo environment.")} className="flex items-center justify-center gap-1.5 bg-white/10 hover:bg-white/20 border border-white/20 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all backdrop-blur-sm">
              <Zap className="w-3.5 h-3.5" /> Bulk Optimize
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
