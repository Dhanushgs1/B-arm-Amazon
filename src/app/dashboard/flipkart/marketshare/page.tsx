import { MarketplaceMarketShare } from "@/components/marketplace/MarketplaceMarketShare";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartMarketSharePage() {
  return (
    <FlipkartDemoGate title="Market Share">
      <MarketplaceMarketShare marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
