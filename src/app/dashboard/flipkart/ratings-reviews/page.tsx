import { RatingsReviewsIntelligence } from "@/components/marketplace/RatingsReviewsIntelligence";
import { FlipkartDemoGate } from "@/components/marketplace/FlipkartDemoGate";

export default function FlipkartRatingsReviewsPage() {
  return (
    <FlipkartDemoGate title="Ratings & Reviews Intelligence">
      <RatingsReviewsIntelligence marketplace="flipkart" />
    </FlipkartDemoGate>
  );
}
