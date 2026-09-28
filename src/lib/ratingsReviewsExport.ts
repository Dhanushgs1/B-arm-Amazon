import * as XLSX from "xlsx-js-style";
import { buildStyledSheet } from "@/lib/excelExport";
import type { RRProduct } from "@/lib/ratingsReviewsData";
import { isRealRatingsData, ratingsProductColumns, ratingsSourceLine, ratingsUnavailable, type RatingsDatasetWithSource } from "@/lib/ratingsExportRules";

const CATEGORY_COLUMNS = [
  { key: "category", label: "Category" },
  { key: "avgRating", label: "Avg Rating" },
  { key: "productsBelow4", label: "Products Below 4★" },
  { key: "negativeReviewPct", label: "Negative Review %" },
  { key: "returnPct", label: "Return %" },
  { key: "healthScore", label: "Health Score" },
];

const RETURN_REASON_COLUMNS = [
  { key: "name", label: "Product" },
  { key: "reason", label: "Return Reason" },
  { key: "pct", label: "% of Returns" },
];

export function exportRatingsReviewsExcel(dataset: RatingsDatasetWithSource, filename = "ratings_reviews_intelligence") {
  const wb = XLSX.utils.book_new();
  const real = isRealRatingsData(dataset);

  XLSX.utils.book_append_sheet(wb, buildStyledSheet(dataset.products, ratingsProductColumns(real)), "Products");
  XLSX.utils.book_append_sheet(wb, buildStyledSheet(dataset.categories, CATEGORY_COLUMNS), "Categories");

  const returnRows = dataset.products.flatMap((p) => p.returnReasons.map((r) => ({ name: p.name, reason: r.reason, pct: r.pct })));
  XLSX.utils.book_append_sheet(wb, buildStyledSheet(returnRows, RETURN_REASON_COLUMNS), "Return Reasons");

  // Where the numbers come from, and what this source cannot supply (shown as absent, never filled in).
  const unavailable = ratingsUnavailable(dataset);
  const sourceRows = [
    { item: ratingsSourceLine(dataset) },
    ...unavailable.map((u) => ({ item: `Not available from this source: ${u}` })),
  ];
  XLSX.utils.book_append_sheet(wb, buildStyledSheet(sourceRows, [{ key: "item", label: "Data source" }]), "Source");

  XLSX.writeFile(wb, `${filename}.xlsx`);
}

export async function exportRatingsReviewsPDF(dataset: RatingsDatasetWithSource, filename = "ratings_reviews_intelligence") {
  const { default: jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("Ratings & Reviews Intelligence Report", pageWidth / 2, 16, { align: "center" });
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  const real = isRealRatingsData(dataset);
  doc.text(ratingsSourceLine(dataset), pageWidth / 2, 22, { align: "center" });

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Executive Summary", 14, 32);
  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  const summary = dataset.executiveSummary;
  const summaryLines = [
    `Top performing: ${summary.topPerforming.join(", ") || "—"}`,
    `Needs immediate action: ${summary.needsAction.join(", ") || "None"}`,
    `Common complaints: ${summary.commonComplaints.map((c) => c.text).join(", ") || "None"}`,
    `Common return reasons: ${summary.commonReturnReasons.map((r) => `${r.reason} (${r.pct}%)`).join(", ") || "None"}`,
    real ? "Estimated revenue impact: not available from this source" : `Estimated revenue impact: Rs. ${summary.revenueImpact.toLocaleString("en-IN")}`,
  ];
  let y = 38;
  summaryLines.forEach((line) => {
    const wrapped = doc.splitTextToSize(line, pageWidth - 28);
    doc.text(wrapped, 14, y);
    y += wrapped.length * 4.2;
  });

  autoTable(doc, {
    startY: y + 4,
    head: [["Product", "Category", "Platform", "Rating", "Reviews", real ? "Orders Chg %" : "Sales Chg %", "Return %", "Health", "Status"]],
    body: dataset.products
      .slice()
      .sort((a, b) => a.avgRating - b.avgRating)
      .map((p: RRProduct) => [
        p.name, p.category, p.platform, p.avgRating.toFixed(1), p.reviewCount, `${p.salesChangePct}%`, `${p.returnRate}%`, p.healthScore, p.healthStatus,
      ]),
    styles: { fontSize: 7 },
    headStyles: { fillColor: [79, 70, 229] },
    theme: "grid",
  });

  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY + 8,
    head: [["Category", "Avg Rating", "Below 4★", "Negative %", "Return %", "Health Score"]],
    body: dataset.categories.map((c) => [c.category, c.avgRating.toFixed(1), c.productsBelow4, `${c.negativeReviewPct}%`, `${c.returnPct}%`, c.healthScore]),
    styles: { fontSize: 7 },
    headStyles: { fillColor: [79, 70, 229] },
    theme: "grid",
  });

  doc.save(`${filename}.pdf`);
}
