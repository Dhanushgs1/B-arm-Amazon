import { redirect } from "next/navigation";

// The FBA Forecast page was taken off the dashboard (user, 2026-10-16); old links land on the Overview.
// The FBA stock email and the generate-fba-forecast-report endpoints are unchanged.
export default function FbaRemoved() {
  redirect("/dashboard");
}
