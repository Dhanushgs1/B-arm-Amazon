"use client";

import { motion } from "framer-motion";

export function ScoreRing({ value, label, color }: { value: number; label: string; color: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-16 h-16">
        <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r={r} fill="none" stroke="var(--muted)" strokeWidth="6" />
          <motion.circle
            cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
            strokeDasharray={c}
            initial={{ strokeDashoffset: c }}
            animate={{ strokeDashoffset: c - (c * v) / 100 }}
            transition={{ duration: 1, ease: "easeOut" }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-sm font-extrabold">{Math.round(v)}</span>
      </div>
      <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground text-center leading-tight">{label}</p>
    </div>
  );
}
