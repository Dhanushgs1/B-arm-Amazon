// Pure coverage check shared by the Amazon report builders: a return source that stops syncing
// before the report's end date must be called out, never shown as a silent zero. (AM returns in
// the MIS amazon_returns table stopped on 3 Sep 2026 while every other source ran to 17 Sep, and
// every report simply showed 0 AM returns for the later days.)

export type SourceCoverage = { label: string; maxDate: string | null; error?: string };

/** One READ-THIS-FIRST line per source that does not reach `endDate` ("YYYY-MM-DD"), or whose
 *  coverage could not be read. `consequence` says what that does to this particular report. */
export function staleSourceWarnings(
  sources: SourceCoverage[],
  endDate: string,
  consequence: string,
  fmt: (iso: string) => string = (d) => d
): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (s.error || !s.maxDate) {
      out.push(`⚠ READ THIS FIRST — could not check how far ${s.label} reaches${s.error ? ` (${s.error})` : ""}, so its figures may be incomplete for this report.`);
    } else if (s.maxDate < endDate) {
      out.push(`⚠ READ THIS FIRST — ${s.label} only reaches ${fmt(s.maxDate)}, but this report runs to ${fmt(endDate)}. Anything after ${fmt(s.maxDate)} is missing from the synced data, not zero — ${consequence}`);
    }
  }
  return out;
}
