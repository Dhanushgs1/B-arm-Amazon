// Rules that turn barm_online_orders rows (the B-ARM website's WooCommerce export, before the move to
// Shopify) into orders — moved out of barmOnlineOrders.ts unchanged so they can be unit tested
// (dependency-free; the product-name lookup is passed in).
//   - Same (Order Number, SKU) loaded twice -> the latest load ("created at") wins: no duplicates.
//   - Only rows with an Order Number and a parseable "DD-MM-YYYY…" Order Date become orders. This also
//     keeps out the SKU-only rows pasted into the table after the Shopify move (no order number,
//     status or amount) — those orders belong to Shopify and must not be counted here as well.
//   - Only "Order Status" = Received counts; rows whose shifted columns say "cancelled" (Order Total
//     Tax Amount) or "returned" (COD Fee) are not sales.
//   - Sales = Order Total Amount once per Order Number (repeated on every line of the order).

export interface BarmOnlineOrderLine {
  order_number: string;
  order_date: string;
  sku: string;
  name: string;
  quantity: number;
}

export interface BarmOnlineOrder {
  order_number: string;
  order_date: string;
  total: number;
  lines: BarmOnlineOrderLine[];
}

export type BarmOnlineOrderRow = Record<string, unknown>;

export function parseBarmOrderDate(v: unknown): string | null {
  const m = String(v ?? "").trim().match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return Number(mm) >= 1 && Number(mm) <= 12 ? `${yyyy}-${mm}-${dd}` : null;
}

const num = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export function buildBarmOnlineOrders(
  raw: BarmOnlineOrderRow[],
  resolveName: (itemName: string, sku: string) => string | null | undefined = () => null
): BarmOnlineOrder[] {
  const latest = new Map<string, BarmOnlineOrderRow>();
  raw.forEach((r) => {
    const key = `${String(r["Order Number"] ?? "").trim()}|${String(r["SKU"] ?? "").trim()}`;
    const prev = latest.get(key);
    if (!prev || String(r["created at"] ?? "") > String(prev["created at"] ?? "")) latest.set(key, r);
  });

  const orders = new Map<string, BarmOnlineOrder>();
  latest.forEach((r) => {
    const orderNumber = String(r["Order Number"] ?? "").trim();
    const date = parseBarmOrderDate(r["Order Date"]);
    if (!orderNumber || !date) return;
    if (String(r["Order Status"] ?? "").trim().toLowerCase() !== "received") return;
    // The import shifted some columns: a cancellation can show up as "cancelled" in
    // "Order Total Tax Amount" while Order Status still says Received (orders 29221, 28706, 28722).
    if (String(r["Order Total Tax Amount"] ?? "").trim().toLowerCase() === "cancelled") return;
    // Same shift puts the delivery status in "COD Fee"; a returned order isn't a sale (order 29186).
    if (String(r["COD Fee"] ?? "").trim().toLowerCase() === "returned") return;
    const sku = String(r["SKU"] ?? "").trim();
    const itemName = String(r["Item Name"] ?? "").trim();
    let o = orders.get(orderNumber);
    if (!o) {
      o = { order_number: orderNumber, order_date: date, total: num(r["Order Total Amount"]), lines: [] };
      orders.set(orderNumber, o);
    }
    o.lines.push({
      order_number: orderNumber,
      order_date: date,
      sku,
      name: resolveName(itemName, sku) || itemName || sku || "(no product name)",
      quantity: num(r["Quantity"]) || 1,
    });
  });
  return [...orders.values()];
}
