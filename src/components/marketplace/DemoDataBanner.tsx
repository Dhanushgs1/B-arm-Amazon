"use client";

import { FlaskConical, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { MARKETPLACE_META, type MarketplaceId } from "@/lib/marketplace";

// Shown across every Flipkart page — the platform isn't wired to a real
// Seller API yet, so every number on these pages is deterministic demo
// data (see lib/marketplace.ts), not live account data.
export function DemoDataBanner({ marketplace }: { marketplace: Exclude<MarketplaceId, "amazon"> }) {
  const router = useRouter();
  const meta = MARKETPLACE_META[marketplace];

  return (
    <div
      className="flex items-center justify-between gap-4 flex-wrap rounded-2xl border px-5 py-3.5 shadow-sm"
      style={{ borderColor: `${meta.color}40`, background: `${meta.color}0d` }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${meta.color}1a`, border: `1px solid ${meta.color}40` }}>
          <FlaskConical className="w-4 h-4" style={{ color: meta.color }} />
        </div>
        <div className="min-w-0">
          <p className="font-extrabold text-sm" style={{ color: meta.color }}>Showing demo data for {meta.label}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-semibold truncate">
            No {meta.label} Seller API key connected yet — these numbers are illustrative, not your real account.
          </p>
        </div>
      </div>
      <button
        onClick={() => router.push("/dashboard/settings")}
        className="flex items-center gap-1.5 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-sm flex-shrink-0 hover:opacity-90"
        style={{ background: meta.color }}
      >
        Connect {meta.label} <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
