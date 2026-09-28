// Pure rules for the MIS fk_orders feed, shared by the Flipkart weekly and historical reports.

/** A "skeleton" order row: no order_item_id (and no status). The MIS fk_orders table holds 2,408
 *  of them, loaded on 17 Jun, 7 Aug and 4 Sep 2026, and every one repeats the order_id + sku of a
 *  complete row — counting them inflated weekly Orders by ~12% (1,265 vs 1,125 for 28 Aug-3 Sep).
 *  A real Flipkart order line always carries its order_item_id. */
export function isFkSkeletonOrderRow(r: { order_item_id?: unknown }): boolean {
  return !String(r.order_item_id ?? "").trim();
}
