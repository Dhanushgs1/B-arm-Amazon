import { redirect } from "next/navigation";

// Godown Stock Analytics was taken off the dashboard (user, 2026-10-16); old links land on the
// Consolidated Stock Sheet. Its numbers still go out in the Excel export's "Seasonal Analytics" sheet.
export default function GodownAnalyticsRemoved() {
  redirect("/dashboard/inventory/consolidated");
}
