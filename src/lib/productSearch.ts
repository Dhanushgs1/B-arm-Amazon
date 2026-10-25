// Product search for the product-wise tables (Flipkart, Meesho, Shopify tabs). Case-insensitive; every
// word typed must appear somewhere in the product's name or SKU(s), in any order — so "glucose 50"
// finds "Glucospark Blood Glucose Test Strips – Pack of 50". Empty query matches everything.
export function matchesProductQuery(query: string, ...fields: (string | string[] | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fields.flat().filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => haystack.includes(w));
}
