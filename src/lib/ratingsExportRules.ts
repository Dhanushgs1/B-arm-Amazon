// Pure rules for what the Ratings & Reviews page shows and exports — kept dependency-free so they can
// be unit tested. The real source (barmRatingReviewData.ts, the weekly rating tracker sheet) has no
// sales, revenue, return-reason, sentiment or keyword data at all (see its SHEET_UNAVAILABLE). The page
// used to fill every one of those gaps from the demo generator, so exports carried made-up Sales and
// "Revenue Lost" figures next to real ratings. Real data is now shown and exported as-is.
import type { RatingsReviewsDataset } from "./ratingsReviewsData";

export type RatingsSource = { kind: string; currentDate?: string; unavailable?: readonly string[] };
export type RatingsDatasetWithSource = RatingsReviewsDataset & { source?: RatingsSource };

/** Real dataset whenever one loaded — never enriched with demo values; the demo dataset only when
 *  there is no real data at all (and then it is marked as demo via the absent `source`). */
export function ratingsDatasetForDisplay(real: RatingsDatasetWithSource | undefined, demo: RatingsReviewsDataset): RatingsDatasetWithSource {
  return real ?? demo;
}

export const isRealRatingsData = (d: { source?: RatingsSource }) => d.source?.kind === "sheet";

type Col = { key: string; label: string };

/** Products sheet columns. For real data, "Sales" is dropped (the source has none — it would read as
 *  a real ₹0) and salesChangePct is labelled for what it really is: the change in orders. */
export function ratingsProductColumns(real: boolean): Col[] {
  const cols: Col[] = [
    { key: "name", label: "Product" },
    { key: "category", label: "Category" },
    { key: "platform", label: "Platform" },
    { key: "avgRating", label: "Avg Rating" },
    { key: "reviewCount", label: "Review Count" },
    ...(real ? [] : [{ key: "sales", label: "Sales" }]),
    { key: "salesChangePct", label: real ? "Orders Change %" : "Sales Change %" },
    { key: "returnRate", label: "Return Rate %" },
    { key: "healthScore", label: "Health Score" },
    { key: "healthStatus", label: "Status" },
    { key: "actionRequired", label: "Action Required" },
  ];
  return cols;
}

/** One-line provenance statement for the export header / Source sheet. */
export function ratingsSourceLine(d: { source?: RatingsSource }): string {
  if (!isRealRatingsData(d)) return "DEMO DATA — generated sample figures, not real business data.";
  return `Source: BARM weekly rating tracker${d.source?.currentDate ? `, snapshot ${d.source.currentDate}` : ""}.`;
}

/** Metrics the export must state as unavailable instead of showing numbers for. */
export function ratingsUnavailable(d: { source?: RatingsSource }): string[] {
  return isRealRatingsData(d) ? [...(d.source?.unavailable ?? [])] : [];
}
