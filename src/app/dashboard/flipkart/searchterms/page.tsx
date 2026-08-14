import { MarketplaceSearchTerms } from "@/components/marketplace/MarketplaceSearchTerms";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartSearchTermsPage() {
  return (
    <FlipkartDemoGate title="Search Terms">
      <MarketplaceSearchTerms marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
