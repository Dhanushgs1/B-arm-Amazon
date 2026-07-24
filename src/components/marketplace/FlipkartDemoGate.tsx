"use client";

import { useRouter } from "next/navigation";
import { Database, ArrowRight } from "lucide-react";
import { useDashboard } from "@/lib/DashboardContext";

/**
 * These Flipkart pages (Ad Groups, Placements, Keywords, Bids, Search Terms,
 * Rules & Optimization, Inventory, Market Share, Reports) render deterministic
 * DEMO data because Flipkart exposes no ads API. That demo data is fine for the
 * "Lkn" showcase account, but the real "Barm" account must never see fabricated
 * numbers — it should show a clean "No Data" state until real data exists.
 *
 * Rendering the demo child conditionally (rather than gating inside each of the
 * nine components) keeps the demo generation from running at all for Barm and
 * avoids touching every component's hooks.
 */
export function FlipkartDemoGate({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { loggedInUser } = useDashboard();
  const router = useRouter();

  if (loggedInUser !== "Barm") return <>{children}</>;

  return (
    <div className="space-y-6 pb-12">
      <div className="border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">
          {title}
        </h1>
        <p className="text-slate-500 dark:text-slate-400 text-xs">
          Barm Flipkart Store
        </p>
      </div>

      <div className="flex flex-col items-center justify-center py-20 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 text-center px-6 gap-5">
        <div className="h-16 w-16 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center border border-slate-200 dark:border-slate-700">
          <Database className="h-8 w-8" />
        </div>
        <div className="space-y-1.5">
          <h3 className="font-extrabold text-lg text-slate-900 dark:text-white">No Data Yet</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed max-w-md">
            No records found for this workspace. Upload your Flipkart exports to see
            live metrics and reports here.
          </p>
        </div>
        <button
          onClick={() => router.push("/dashboard/flipkart/hub")}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs px-5 py-2.5 rounded-lg transition shadow-md"
        >
          Go to Upload Data <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
