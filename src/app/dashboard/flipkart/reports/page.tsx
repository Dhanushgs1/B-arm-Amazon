import { MarketplaceReports } from "@/components/marketplace/MarketplaceReports";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartReportsPage() {
  return (
    <FlipkartDemoGate title="Reports">
      <MarketplaceReports marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
