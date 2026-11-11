// Shown while a dashboard page's code is loading on navigation, in place of a blank content area.
// Shapes mirror the common page layout (title, KPI row, main panel) so the page does not jump.
export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Loading page" className="space-y-5 animate-pulse">
      <div className="space-y-2">
        <div className="h-7 w-56 rounded-lg bg-muted" />
        <div className="h-4 w-80 max-w-full rounded-md bg-muted" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 rounded-2xl bg-muted" />
        ))}
      </div>
      <div className="h-80 rounded-2xl bg-muted" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
