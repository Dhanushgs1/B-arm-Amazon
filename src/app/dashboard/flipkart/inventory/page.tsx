import { MarketplaceInventory } from "@/components/marketplace/MarketplaceInventory";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartInventoryPage() {
  return (
    <FlipkartDemoGate title="Inventory">
      <MarketplaceInventory marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
