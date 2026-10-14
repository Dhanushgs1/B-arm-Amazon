"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileSpreadsheet, Radio, Layers, Activity } from "lucide-react";

// Switch between the inventory views. They never share data:
//   Inventory          = uploaded Amazon FBA Inventory report (barm_amazon_fba_inventory)
//   Live Inventory     = SellerMate API
//   Consolidated Stock = uploaded godown stock sheet (barm_godown_stock / barm_godown_daily)
//   Godown Analytics   = trends over that same godown upload (read-only)
export function InventoryTabs() {
  const pathname = usePathname();
  const live = pathname?.startsWith("/dashboard/inventory/live");
  const consolidated = pathname?.startsWith("/dashboard/inventory/consolidated");
  const analytics = pathname?.startsWith("/dashboard/inventory/analytics");
  const tab = (active: boolean) =>
    `flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${active ? "bg-indigo-600 text-white shadow" : "text-muted-foreground hover:text-foreground"}`;
  return (
    <div className="inline-flex rounded-xl border border-border bg-background p-1 shadow-sm">
      <Link href="/dashboard/inventory" className={tab(!live && !consolidated && !analytics)}><FileSpreadsheet className="w-3.5 h-3.5" /> Inventory</Link>
      <Link href="/dashboard/inventory/live" className={tab(!!live)}><Radio className="w-3.5 h-3.5" /> Live Inventory</Link>
      <Link href="/dashboard/inventory/consolidated" className={tab(!!consolidated)}><Layers className="w-3.5 h-3.5" /> Consolidated Stock</Link>
      <Link href="/dashboard/inventory/analytics" className={tab(!!analytics)}><Activity className="w-3.5 h-3.5" /> Godown Analytics</Link>
    </div>
  );
}
