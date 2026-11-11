/** True when ad rows start on the first day of the previous period and reach the last day of the
 *  current one. Otherwise the two totals cover different numbers of days (uploads that begin
 *  part-way through the previous period read as a +202% jump) and must not be compared. */
export function adSpendCoversBoth(
  prev: { first: string | null },
  cur: { last: string | null },
  prevStart: string,
  curEnd: string,
): boolean {
  return !!prev.first && prev.first <= prevStart && !!cur.last && cur.last >= curEnd;
}
