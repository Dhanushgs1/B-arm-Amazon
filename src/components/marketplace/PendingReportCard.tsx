"use client";

import { Download } from "lucide-react";

// Placeholder Download card for a report whose calculation rules haven't been
// given yet (Meesho / BARM weekly). Same look as the Flipkart Download page's
// cards, but the button stays disabled — no numbers are invented until the
// formulas are confirmed.
export function PendingReportCard({
  title,
  description,
  dataCaption,
}: {
  title: string;
  description: React.ReactNode;
  dataCaption?: React.ReactNode;
}) {
  return (
    <div className="glass rounded-2xl border border-border p-6 shadow-sm">
      <h3 className="font-bold text-sm mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground mb-4">{description}</p>
      <button
        disabled
        title="Calculation rules pending"
        className="px-4 py-2 bg-primary text-primary-foreground text-xs font-bold rounded-lg flex items-center gap-2 shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Download size={14} /> Download Weekly Report
      </button>
      <p className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold mt-3">
        &#9888; Calculation rules pending — this report will be enabled once the formulas are provided.
      </p>
      {dataCaption && <div className="text-[10px] text-muted-foreground mt-2">{dataCaption}</div>}
    </div>
  );
}
