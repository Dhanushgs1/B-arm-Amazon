"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopNav } from "@/components/TopNav";
import { CampaignDetailDrawer } from "@/components/CampaignDetailDrawer";
import { ProductDetailDrawer } from "@/components/ProductDetailDrawer";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { BidsPrefetcher } from "@/components/BidsPrefetcher";
import { getMarketplaceTab } from "@/lib/marketplace";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // These two are Amazon/SellerMate-specific — irrelevant (and, for the
  // banner, actively misleading) on the Flipkart/Meesho/Compare pages.
  const isAmazon = getMarketplaceTab(pathname) === "amazon";

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)} />
      <div className="flex flex-col flex-1 min-w-0">
        <TopNav onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-5 relative">
          {isAmazon && <ConnectionBanner />}
          {/* Silently prefetch bids in background so Bid Adjustment page is instant */}
          {isAmazon && <BidsPrefetcher />}
          {children}
        </main>
      </div>
      <CampaignDetailDrawer />
      <ProductDetailDrawer />
    </div>
  );
}
