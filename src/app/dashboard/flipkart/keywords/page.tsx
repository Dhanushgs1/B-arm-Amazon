import { MarketplaceKeywords } from "@/components/marketplace/MarketplaceKeywords";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartKeywordsPage() {
  return (
    <FlipkartDemoGate title="Keywords">
      <MarketplaceKeywords marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
