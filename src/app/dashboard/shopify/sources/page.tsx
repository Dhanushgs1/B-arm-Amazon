"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { ShopifySourcesView } from "@/components/marketplace/ShopifySourcesView";

export default function ShopifySourcesPage() {
  return (
    <div className="space-y-6 pb-12">
      <div className="space-y-1 border-b border-slate-200/50 dark:border-slate-800/50 pb-4">
        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Google &amp; Meta</h1>
        <p className="text-slate-500 dark:text-slate-400 text-xs">Shopify · where orders came from, next to Google Ads and Meta spend</p>
      </div>
      {/* useSearchParams (the ?source= filter) needs a Suspense boundary */}
      <Suspense
        fallback={
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-10 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        }
      >
        <ShopifySourcesView />
      </Suspense>
    </div>
  );
}
