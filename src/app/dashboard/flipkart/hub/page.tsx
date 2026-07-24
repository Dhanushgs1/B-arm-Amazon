"use client";
import dynamic from 'next/dynamic';
import '@/components/flipkart/index.css';

// The original Flipkart mini-app — kept alive here for features not yet
// rebuilt on the Amazon-style architecture: Upload Data (the only way real
// numbers get into Supabase), P&L Analyzer, Campaign Manager editing,
// Keyword Planner, and price-alert history. /dashboard/flipkart itself now
// renders the clean FlipkartOverview instead of this component.
const FlipkartApp = dynamic(() => import('@/components/flipkart/App'), { ssr: false });

export default function FlipkartHubPage() {
  return (
    <div className="w-full h-full min-h-screen">
      <FlipkartApp initialTab="upload-data" />
    </div>
  );
}
