import { Sidebar } from "@/components/Sidebar";
import { TopNav } from "@/components/TopNav";
import { CampaignDetailDrawer } from "@/components/CampaignDetailDrawer";
import { ProductDetailDrawer } from "@/components/ProductDetailDrawer";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <TopNav />
        <main className="flex-1 overflow-y-auto p-6 relative">
          {children}
        </main>
      </div>
      <CampaignDetailDrawer />
      <ProductDetailDrawer />
    </div>
  );
}
