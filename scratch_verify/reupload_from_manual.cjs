// Push the manual "AM ad performance report" workbook's OWN raw sheets (AM
// orders / AM returns / FBA returns / SF returns) into Supabase for the
// 2026-06-29..2026-07-28 window, so the Historical Report is built from the
// EXACT same data the manual workbook was — closing the "data freshness"
// gap identified earlier (DB had a fresher Jul 30 CSV re-upload than this
// manual file's Jul 29 snapshot).
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://glvnqvjnglvnrgfyaypk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdsdm5xdmpuZ2x2bnJnZnlheXBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1NzUxMjIsImV4cCI6MjA5NDE1MTEyMn0.KLf31A-PZT-rG7PlG0ltk9aieBoEGE4feI4_qIOZgBY";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WORKBOOK_PATH = "C:/Users/91906/Downloads/AM ad performance report - 29.06 - 28.07.xlsx";

function pick(row, re) {
  const key = Object.keys(row).find((k) => re.test(k));
  return key ? (row[key] ?? "").toString().trim() : "";
}
function toNum(v) {
  if (!v) return 0;
  const cleaned = String(v).replace(/[^0-9.-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function toInt(v) {
  return Math.round(toNum(v));
}
const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
function parseDDMonYY(v) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  const year = 2000 + Number(m[3]);
  return `${year}-${mm}-${m[1].padStart(2, "0")}`;
}
function isoDateOnly(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  return m ? m[1] : null;
}
function parseLongDate(v) {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(String(v).trim());
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase().slice(0, 3)];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, "0")}`;
}
function parseMDY(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v).trim());
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
function parseAnySfDate(v) {
  if (!v) return null;
  return isoDateOnly(v) || parseLongDate(v) || parseDDMonYY(v) || parseMDY(v);
}

function mapOrderRow(row) {
  const purchaseRaw = pick(row, /^purchase-date$/i);
  return {
    amazon_order_id: pick(row, /^amazon-order-id$/i),
    order_item_id: pick(row, /^order-item-id$/i),
    purchase_date: isoDateOnly(purchaseRaw),
    purchase_datetime: purchaseRaw || null,
    order_status: pick(row, /^order-status$/i),
    fulfillment_channel: pick(row, /^fulfillment-channel$/i),
    sales_channel: pick(row, /^sales-channel$/i),
    product_name: pick(row, /^product-name$/i),
    sku: pick(row, /^sku$/i),
    asin: pick(row, /^asin$/i),
    item_status: pick(row, /^item-status$/i),
    quantity: toInt(pick(row, /^quantity$/i)),
    currency: pick(row, /^currency$/i),
    item_price: toNum(pick(row, /^item-price$/i)),
    item_tax: toNum(pick(row, /^item-tax$/i)),
    shipping_price: toNum(pick(row, /^shipping-price$/i)),
    item_promotion_discount: toNum(pick(row, /^item-promotion-discount$/i)),
    ship_city: pick(row, /^ship-city$/i),
    ship_state: pick(row, /^ship-state$/i),
    ship_postal_code: pick(row, /^ship-postal-code$/i),
    raw: row,
  };
}

function mapAmReturnRow(row) {
  return {
    order_id: pick(row, /^Order ID$/i),
    order_item_id: pick(row, /^Order Item ID$/i),
    order_date: parseDDMonYY(pick(row, /^Order date$/i)),
    return_request_date: parseDDMonYY(pick(row, /^Return request date$/i)),
    return_request_status: pick(row, /^Return request status$/i),
    asin: pick(row, /^ASIN$/i),
    merchant_sku: pick(row, /Merchant SKU/i),
    item_name: pick(row, /^Item Name$/i),
    return_quantity: toInt(pick(row, /^Return quantity$/i)),
    return_reason: pick(row, /^Return reason$/i),
    in_policy: pick(row, /^In policy$/i),
    return_type: pick(row, /^Return type$/i),
    resolution: pick(row, /^Resolution$/i),
    order_amount: toNum(pick(row, /^Order Amount$/i)),
    order_quantity: toInt(pick(row, /^Order quantity$/i)),
    category: pick(row, /^Category$/i),
    raw: row,
  };
}

function mapFbaReturnRow(row) {
  return {
    return_date: pick(row, /^return-date$/i) || null,
    order_id: pick(row, /^order-id$/i),
    sku: pick(row, /^sku$/i),
    asin: pick(row, /^asin$/i),
    fnsku: pick(row, /^fnsku$/i),
    product_name: pick(row, /^product-name$/i),
    quantity: toInt(pick(row, /^quantity$/i)),
    fulfillment_center_id: pick(row, /^fulfillment-center-id$/i),
    detailed_disposition: pick(row, /^detailed-disposition$/i),
    reason: pick(row, /^reason$/i),
    license_plate_number: pick(row, /^license-plate-number$/i),
    customer_comments: pick(row, /^customer-comments$/i),
    raw: row,
  };
}

function mapSfReturnRow(row) {
  return {
    return_type: pick(row, /^Return Type$/i),
    customer_order_id: pick(row, /^Customer Order ID$/i),
    shipment_id: pick(row, /^Shipment ID$/i),
    sku: pick(row, /^SKU$/i),
    msku: pick(row, /^mSKU$/i),
    asin: pick(row, /^ASIN$/i),
    external_id_1: pick(row, /^External ID1$/i),
    external_id_2: pick(row, /^External ID2$/i),
    external_id_3: pick(row, /^External ID3$/i),
    units: toInt(pick(row, /^Units$/i)),
    forward_leg_tracking_id: pick(row, /^Forward Leg Tracking ID$/i),
    reverse_leg_tracking_id: pick(row, /^Reverse Leg Tracking ID$/i),
    rma_id: pick(row, /^RMA ID$/i),
    return_status: pick(row, /^Return Status$/i),
    carrier: pick(row, /^Carrier$/i),
    pickup_date: parseAnySfDate(pick(row, /^Pick\s*-?\s*up date$/i)),
    last_updated_on: parseAnySfDate(pick(row, /^Last Updated On$/i)),
    returned_with_otp: pick(row, /^Returned with OTP$/i),
    days_in_transit: toInt(pick(row, /^Days In-?transit$/i)),
    days_since_return_complete: toInt(pick(row, /^Days Since Return Complete$/i)),
    raw: row,
  };
}

const REQUIRED_FIELDS = {
  am_orders: ["amazon_order_id", "order_item_id", "purchase_date", "sku"],
  am_returns: ["order_id"],
  fba_returns: ["return_date", "sku", "license_plate_number"],
  sf_return: ["customer_order_id", "sku"],
};
const REPLACE_DATE_FIELD = { am_orders: "purchase_date", am_returns: "return_request_date", fba_returns: "return_date", sf_return: "pickup_date" };
const REPLACE_IS_TIMESTAMP = { fba_returns: true };
const REPORT_TABLE = {
  am_orders: "barm_amazon_am_orders",
  am_returns: "barm_amazon_am_returns",
  fba_returns: "barm_amazon_fba_returns",
  sf_return: "barm_amazon_sf_return",
};
const MAPPERS = { am_orders: mapOrderRow, am_returns: mapAmReturnRow, fba_returns: mapFbaReturnRow, sf_return: mapSfReturnRow };
const SHEET_NAME = { am_orders: "AM orders", am_returns: "AM returns", fba_returns: "FBA returns", sf_return: "SF returns" };

function dedupeExactRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function nextDayIso(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function replaceDateRange(table, dateCol, isTimestamp, minDate, maxDate) {
  let query = supabase.from(table).delete();
  query = isTimestamp
    ? query.gte(dateCol, `${minDate}T00:00:00Z`).lt(dateCol, `${nextDayIso(maxDate)}T00:00:00Z`)
    : query.gte(dateCol, minDate).lte(dateCol, maxDate);
  const { error } = await query;
  if (error) throw new Error(`Delete existing ${table} rows in range failed: ${error.message}`);
}

async function insertInChunks(table, rows, chunkSize = 300) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
  }
}

async function uploadFromSheet(type, wb) {
  const ws = wb.Sheets[SHEET_NAME[type]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: "" });
  const mapper = MAPPERS[type];
  const required = REQUIRED_FIELDS[type];
  const mapped = rawRows.map(mapper);
  const valid = mapped.filter((r) => required.every((f) => r[f] !== null && r[f] !== undefined && r[f] !== ""));
  const deduped = dedupeExactRows(valid);
  const table = REPORT_TABLE[type];
  const replaceDateField = REPLACE_DATE_FIELD[type];
  const dates = deduped.map((r) => r[replaceDateField]).filter(Boolean).sort();
  const minDate = dates[0].slice(0, 10);
  const maxDate = dates[dates.length - 1].slice(0, 10);
  console.log(`[${type}] sheet rows=${rawRows.length} valid=${valid.length} deduped=${deduped.length} range=${minDate}..${maxDate}`);
  await replaceDateRange(table, replaceDateField, !!REPLACE_IS_TIMESTAMP[type], minDate, maxDate);
  await insertInChunks(table, deduped);
  console.log(`[${type}] inserted ${deduped.length} rows into ${table}`);
}

(async () => {
  const wb = XLSX.readFile(WORKBOOK_PATH);
  await uploadFromSheet("am_orders", wb);
  await uploadFromSheet("am_returns", wb);
  await uploadFromSheet("fba_returns", wb);
  await uploadFromSheet("sf_return", wb);
  console.log("Done.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
