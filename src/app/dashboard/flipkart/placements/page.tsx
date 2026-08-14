import { MarketplacePlacements } from "@/components/marketplace/MarketplacePlacements";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartPlacementsPage() {
  return (
    <FlipkartDemoGate title="Placements">
      <MarketplacePlacements marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
