import { MarketplaceBids } from "@/components/marketplace/MarketplaceBids";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartBidsPage() {
  return (
    <FlipkartDemoGate title="Bid Adjustment">
      <MarketplaceBids marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
