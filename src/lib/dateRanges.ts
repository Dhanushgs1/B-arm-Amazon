// Small date-range helpers with no imports, so light modules (the date picker's data lookups, the
// Shopify reader) can use them without pulling in the channel-summary and report-export code.

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The window of the same length immediately before [start, end]. */
export function previousRange(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const days = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  const pe = new Date(s); pe.setDate(s.getDate() - 1);
  const ps = new Date(s); ps.setDate(s.getDate() - days);
  return { start: iso(ps), end: iso(pe) };
}
