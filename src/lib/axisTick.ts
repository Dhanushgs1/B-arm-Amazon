/** Chart Y-axis tick in the Indian short form (75K, 1.2L, 2.5Cr) so large values fit the axis instead
 *  of being cut off (e.g. "₹100000" showed as "00000"); tooltips still show the full number. */
export function axisTick(val: unknown, prefix = ""): string {
  const n = Number(val);
  if (val === null || val === undefined || val === "" || !Number.isFinite(n)) return `${prefix}${val ?? ""}`;
  const a = Math.abs(n);
  const short = (v: number, unit: string) => `${Number(v.toFixed(v < 10 ? 1 : 0))}${unit}`;
  const body = a >= 1e7 ? short(a / 1e7, "Cr") : a >= 1e5 ? short(a / 1e5, "L") : a >= 1e3 ? short(a / 1e3, "K") : String(Number(a.toFixed(2)));
  return `${n < 0 ? "-" : ""}${prefix}${body}`;
}
