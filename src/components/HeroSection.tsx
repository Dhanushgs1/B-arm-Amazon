"use client";

import { motion } from "framer-motion";
import { Hexagon, Sparkles, TrendingUp, AlertTriangle, ShieldCheck, ArrowUpRight } from "lucide-react";
import { useState, useEffect } from "react";

export default function HeroSection() {
  const [sales, setSales] = useState(3847290);
  const [roas, setRoas] = useState(5.42);
  const [acos, setAcos] = useState(18.24);

  // Live numbers ticking up gently to show real-time ingestion
  useEffect(() => {
    const interval = setInterval(() => {
      setSales(prev => prev + Math.floor(Math.random() * 85) + 15);
      setRoas(prev => {
        const delta = (Math.random() * 0.04 - 0.02);
        return parseFloat(Math.max(4.0, Math.min(8.0, prev + delta)).toFixed(2));
      });
      setAcos(prev => {
        const delta = (Math.random() * 0.08 - 0.04);
        return parseFloat(Math.max(10.0, Math.min(30.0, prev + delta)).toFixed(2));
      });
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  const formattedSales = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(sales);

  return (
    <div className="relative w-full h-full bg-[#070B17] text-white p-12 flex flex-col justify-between overflow-hidden">
      {/* Background Subtle Particle Glows */}
      <div className="absolute top-1/4 left-1/4 w-80 h-80 bg-indigo-500/10 rounded-full blur-[80px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-purple-500/10 rounded-full blur-[80px] pointer-events-none" />

      {/* Top Branding Section */}
      <div className="relative z-10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-500/15 rounded-xl flex items-center justify-center text-[#6C63FF] border border-indigo-500/20 shadow-[0_0_20px_rgba(20,184,166,0.15)]">
            <Hexagon size={22} fill="currentColor" className="text-[#6C63FF]" />
          </div>
          <div>
            <span className="font-extrabold text-xl tracking-tight block">Marketplace360</span>
            <small className="text-[10px] text-indigo-400 font-bold uppercase tracking-widest block -mt-1">
              Amazon Analytics Platform
            </small>
          </div>
        </div>

        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.03] border border-white/5 text-[11px] text-[#22D3EE] font-bold shadow-sm">
          <span className="flex w-1.5 h-1.5 rounded-full bg-[#22D3EE] animate-pulse" />
          Enterprise Live SP-API Ingestion
        </div>
      </div>

      {/* Center Animated Mockup & Copy */}
      <div className="relative z-10 grid grid-cols-1 gap-8 my-auto">
        <div className="max-w-xl space-y-4">
          <h1 className="text-4xl xl:text-5xl font-extrabold tracking-tight leading-[1.1] mb-2">
            Turn advertising data into{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-[#22D3EE]">
              profitable decisions
            </span>
          </h1>
          <p className="text-sm text-slate-400 max-w-md leading-relaxed">
            Marketplace360 aggregates Seller Central telemetry, running real-time optimizations, budget pacing, and stock replenishment forecasts.
          </p>
        </div>

        {/* Live-Animating Dashboard Canvas */}
        <div className="relative w-full max-w-lg aspect-[1.5] rounded-3xl bg-white/[0.02] border border-white/5 p-6 shadow-2xl backdrop-blur-md flex flex-col justify-between overflow-hidden group">
          {/* Neon Grid Overlay inside the canvas */}
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff02_1px,transparent_1px),linear-gradient(to_bottom,#ffffff02_1px,transparent_1px)] bg-[size:16px_16px] pointer-events-none" />

          {/* Dynamic Floating Widget 1: Live Ingestion Performance */}
          <div className="flex justify-between items-start z-10">
            <div className="space-y-1">
              <span className="text-[10px] text-slate-400 uppercase tracking-widest font-black">Live Ad Revenue</span>
              <h2 className="text-3xl font-black tracking-tight text-white transition-all duration-300">
                {formattedSales}
              </h2>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20 font-bold flex items-center gap-1">
              <ArrowUpRight size={10} /> +14.8%
            </span>
          </div>

          {/* SVG Animated Chart Line */}
          <div className="w-full h-24 my-3 z-10 relative">
            <svg className="w-full h-full" viewBox="0 0 400 100" preserveAspectRatio="none">
              {/* Grid Lines */}
              <line x1="0" y1="20" x2="400" y2="20" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
              <line x1="0" y1="50" x2="400" y2="50" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
              <line x1="0" y1="80" x2="400" y2="80" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
              
              {/* Glowing Gradient Area */}
              <defs>
                <linearGradient id="chartGlow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6C63FF" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#6D5EF8" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path
                d="M0 70 Q 50 30, 100 60 T 200 40 T 300 80 T 400 30 L 400 100 L 0 100 Z"
                fill="url(#chartGlow)"
              />

              {/* Glowing Neon Line */}
              <motion.path
                d="M0 70 Q 50 30, 100 60 T 200 40 T 300 80 T 400 30"
                fill="none"
                stroke="url(#lineGradient)"
                strokeWidth="3.5"
                strokeLinecap="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 2, ease: "easeInOut" }}
              />

              <linearGradient id="lineGradient" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#6C63FF" />
                <stop offset="50%" stopColor="#6D5EF8" />
                <stop offset="100%" stopColor="#22D3EE" />
              </linearGradient>
            </svg>
          </div>

          {/* Bottom Grid of Live Floating Cards */}
          <div className="grid grid-cols-3 gap-3 z-10">
            {/* ROAS Card */}
            <motion.div
              animate={{ y: [0, -4, 0] }}
              transition={{ repeat: Infinity, duration: 4, ease: "easeInOut", delay: 0 }}
              className="p-3 rounded-2xl bg-white/[0.02] border border-white/5 backdrop-blur-md"
            >
              <span className="text-[9px] text-slate-400 font-bold block uppercase">ROAS</span>
              <span className="text-sm font-black text-indigo-400 mt-0.5 block">{roas}x</span>
            </motion.div>

            {/* ACOS Card */}
            <motion.div
              animate={{ y: [0, -4, 0] }}
              transition={{ repeat: Infinity, duration: 4, ease: "easeInOut", delay: 0.8 }}
              className="p-3 rounded-2xl bg-white/[0.02] border border-white/5 backdrop-blur-md"
            >
              <span className="text-[9px] text-slate-400 font-bold block uppercase">ACOS</span>
              <span className="text-sm font-black text-[#22D3EE] mt-0.5 block">{acos}%</span>
            </motion.div>

            {/* AI Optimization Event Indicator */}
            <motion.div
              animate={{ y: [0, -4, 0] }}
              transition={{ repeat: Infinity, duration: 4, ease: "easeInOut", delay: 1.6 }}
              className="p-3 rounded-2xl bg-[#10B981]/5 border border-[#10B981]/20 backdrop-blur-md flex flex-col justify-between"
            >
              <div className="flex items-center justify-between">
                <span className="text-[8px] text-green-400 font-bold uppercase">AI Status</span>
                <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-ping" />
              </div>
              <span className="text-[10px] font-bold text-white mt-1 block truncate">Bid Adjusted</span>
            </motion.div>
          </div>

          {/* Floating Widget 3: Live Recommendation Feed overlay */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1 }}
            className="absolute top-24 right-4 z-20 p-3 rounded-xl bg-slate-950/75 border border-white/10 shadow-2xl backdrop-blur-md flex gap-2.5 items-start max-w-[200px]"
          >
            <ShieldCheck size={14} className="text-indigo-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[9px] font-bold text-indigo-300">PPC Automation</p>
              <p className="text-[9px] text-slate-300 mt-0.5 leading-normal">Harvested 18 high-ROAS search terms.</p>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.5 }}
            className="absolute bottom-28 left-4 z-20 p-3 rounded-xl bg-slate-950/75 border border-white/10 shadow-2xl backdrop-blur-md flex gap-2.5 items-start max-w-[200px]"
          >
            <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[9px] font-bold text-amber-400">Inventory Alert</p>
              <p className="text-[9px] text-slate-300 mt-0.5 leading-normal">Replenish Nebulizer SKU within 8 days.</p>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
