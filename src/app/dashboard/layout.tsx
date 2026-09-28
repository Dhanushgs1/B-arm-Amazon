"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
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
  // banner, actively misleading) on the Flipkart/Compare pages.
  const isAmazon = getMarketplaceTab(pathname) === "amazon";
  const reduceMotion = useReducedMotion();

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)} />
      <div className="flex flex-col flex-1 min-w-0">
        <TopNav onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="premium-canvas flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-5 relative">
          {isAmazon && <ConnectionBanner />}
          {/* Silently prefetch bids in background so Bid Adjustment page is instant */}
          {isAmazon && <BidsPrefetcher />}
          {/* Each page fades up as it opens. Keyed by path, so it replays on every navigation
              (a template.tsx would not: it only remounts when its own segment changes). */}
          <motion.div
            key={pathname}
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            {children}
          </motion.div>
        </main>
      </div>
      <CampaignDetailDrawer />
      <ProductDetailDrawer />
    </div>
  );
}
