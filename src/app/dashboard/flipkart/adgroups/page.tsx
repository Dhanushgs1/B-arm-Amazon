import { MarketplaceAdGroups } from "@/components/marketplace/MarketplaceAdGroups";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartAdGroupsPage() {
  return (
    <FlipkartDemoGate title="Ad Groups">
      <MarketplaceAdGroups marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
