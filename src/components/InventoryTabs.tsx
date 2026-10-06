"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileSpreadsheet, Radio } from "lucide-react";

// Switch between the two inventory views. They never share data:
//   Inventory      = uploaded Amazon FBA Inventory report (barm_amazon_fba_inventory)
//   Live Inventory = SellerMate API
export function InventoryTabs() {
  const pathname = usePathname();
  const live = pathname?.startsWith("/dashboard/inventory/live");
  const tab = (active: boolean) =>
    `flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${active ? "bg-indigo-600 text-white shadow" : "text-muted-foreground hover:text-foreground"}`;
  return (
    <div className="inline-flex rounded-xl border border-border bg-background p-1 shadow-sm">
      <Link href="/dashboard/inventory" className={tab(!live)}><FileSpreadsheet className="w-3.5 h-3.5" /> Inventory</Link>
      <Link href="/dashboard/inventory/live" className={tab(!!live)}><Radio className="w-3.5 h-3.5" /> Live Inventory</Link>
    </div>
  );
}
