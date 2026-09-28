"use client";

import Link from "next/link";
import { UploadCloud, BarChart3 } from "lucide-react";

export interface DataOnFileItem {
  label: string;
  /** null while still loading */
  value: React.ReactNode | null;
}

// Overview for the upload-only channels (Meesho, BARM). Shows what's been
// uploaded and links to Upload/Download. KPI tiles are intentionally absent
// until the calculation rules are provided — no numbers are invented here.
export function UploadOnlyOverview({
  title,
  subtitle,
  dataOnFile,
  uploadHref,
  downloadHref,
}: {
  title: string;
  subtitle: string;
  dataOnFile: DataOnFileItem[];
  uploadHref: string;
  downloadHref: string;
}) {
  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">{title}</h1>
        <p className="text-muted-foreground text-sm">{subtitle}</p>
      </div>

      <div className="glass rounded-2xl border border-border p-5 shadow-sm">
        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-3">Data on file</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {dataOnFile.map((d) => (
            <div key={d.label} className="rounded-xl border border-border px-4 py-3">
              <p className="text-xs font-bold text-foreground">{d.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{d.value ?? "Checking…"}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 px-5 py-4 text-xs text-amber-700 dark:text-amber-400 font-semibold">
        &#9888; Sales, Orders, Returns, Ad Spend and other KPIs will show here once the calculation rules are provided.
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href={uploadHref}
          className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2 shadow-md"
        >
          <UploadCloud size={14} /> Go to Upload
        </Link>
        <Link
          href={downloadHref}
          className="px-4 py-2 border border-border hover:border-primary/50 text-foreground text-xs font-bold rounded-lg transition-colors flex items-center gap-2"
        >
          <BarChart3 size={14} /> Go to Download
        </Link>
      </div>
    </div>
  );
}
