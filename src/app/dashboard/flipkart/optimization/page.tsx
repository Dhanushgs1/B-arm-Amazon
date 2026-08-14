import { MarketplaceOptimization } from "@/components/marketplace/MarketplaceOptimization";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartOptimizationPage() {
  return (
    <FlipkartDemoGate title="Rules & Optimization">
      <MarketplaceOptimization marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
