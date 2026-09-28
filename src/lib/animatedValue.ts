// Pure parsing/formatting behind <AnimatedNumber> (the KPI cards' count-up) — kept dependency-free
// so it can be unit tested. A KPI value arrives already formatted ("₹12,48,300", "3.42x", "18.5%",
// "1,204 units"); the count-up animates only its number and re-formats every frame exactly the way
// the final string is written — same prefix/suffix, same decimals, Indian digit grouping only when
// the original used it — so the last frame is character-for-character the value the page passed.

export interface DisplayValueParts {
  prefix: string;
  value: number;
  decimals: number;
  grouped: boolean;
  suffix: string;
}

/** Splits a display string around its single number, or null when it can't be animated safely
 *  (no number, or more than one — e.g. "12 / 30" — where counting one of them would mislead). */
export function parseDisplayValue(display: string): DisplayValueParts | null {
  // Non-greedy prefix: "-₹500" keeps "-₹" as the prefix, "₹-500" / "-500" put the sign on the number.
  const m = /^(.*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/.exec(display);
  if (!m) return null;
  const [, prefix, numText, suffix] = m;
  if (/\d/.test(suffix)) return null;
  const plain = numText.replace(/,/g, "");
  const value = Number(plain);
  if (!Number.isFinite(value)) return null;
  const dot = plain.indexOf(".");
  return { prefix, value, decimals: dot < 0 ? 0 : plain.length - dot - 1, grouped: numText.includes(","), suffix };
}

export function formatDisplayValue(parts: DisplayValueParts, value: number): string {
  const text = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: parts.decimals,
    maximumFractionDigits: parts.decimals,
    useGrouping: parts.grouped,
  }).format(value);
  return `${parts.prefix}${text}${parts.suffix}`;
}
