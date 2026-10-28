// Test double for "@/lib/supabaseLazy". The upload module reads its client through lazySupabase(), so a test
// aliases that module to this file and gets an in-memory table store with the same query-builder shape
// (select / insert / upsert / delete with gte, lte, gt, lt filters). It also enforces the unique keys
// the real tables have, so a duplicate-key write fails the way Postgres does.

type Row = Record<string, unknown>;
type Filter = { col: string; op: "gte" | "lte" | "gt" | "lt" | "eq"; val: unknown };
export interface FakeCall { op: "insert" | "upsert" | "delete"; table: string; filters: Filter[] }

/** Unique keys per table, mirroring the real indexes. Upserts use the onConflict key given by the caller. */
const UNIQUE_KEYS: Record<string, string[]> = {
  barm_amazon_sp_advertised_product: ["report_date", "campaign_name", "ad_group_name", "advertised_sku"],
};

export const tables = new Map<string, Row[]>();
export const calls: FakeCall[] = [];
let nextId = 1;

export function resetFakeDb(): void {
  tables.clear();
  calls.length = 0;
  nextId = 1;
}

export function rowsOf(table: string): Row[] {
  return tables.get(table) ?? [];
}

function keyOf(row: Row, fields: string[]): string {
  return fields.map((f) => String(row[f] ?? "")).join("\u0000");
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ col, op, val }) => {
    const v = String(row[col] ?? "");
    const t = String(val);
    if (op === "gte") return v >= t;
    if (op === "lte") return v <= t;
    if (op === "gt") return v > t;
    if (op === "eq") return v === t;
    return v < t;
  });
}

function fail(message: string): { error: { message: string } } {
  return { error: { message } };
}

function execute(table: string, op: FakeCall["op"], payload: Row[] | undefined, filters: Filter[], onConflict: string | undefined) {
  calls.push({ op, table, filters: [...filters] });
  const store = tables.get(table) ?? [];
  tables.set(table, store);
  const unique = UNIQUE_KEYS[table];

  if (op === "delete") {
    const kept = store.filter((r) => !matches(r, filters));
    store.splice(0, store.length, ...kept);
    return { error: null };
  }

  if (op === "insert") {
    const seen = new Set<string>();
    for (const row of payload ?? []) {
      const k = unique ? keyOf(row, unique) : "";
      if (unique && (seen.has(k) || store.some((r) => keyOf(r, unique) === k))) {
        return fail(`duplicate key value violates unique constraint on ${table}`);
      }
      seen.add(k);
      store.push({ id: nextId++, ...row });
    }
    return { error: null };
  }

  // upsert: Postgres refuses a second write to the same conflict key inside one statement.
  const fields = onConflict ? onConflict.split(",") : unique ?? [];
  const batch = new Set<string>();
  for (const row of payload ?? []) {
    const k = keyOf(row, fields);
    if (batch.has(k)) return fail(`ON CONFLICT DO UPDATE command cannot affect row a second time on ${table}`);
    batch.add(k);
  }
  for (const row of payload ?? []) {
    const existing = store.find((r) => keyOf(r, fields) === keyOf(row, fields));
    if (existing) Object.assign(existing, row);
    else store.push({ id: nextId++, ...row });
  }
  return { error: null };
}

/** SELECT: filter, order (ascending, by the given columns), then slice by range (inclusive from..to). */
function selectRows(table: string, filters: Filter[], orderCols: string[], from: number | null, to: number | null): Row[] {
  calls.push({ op: "select" as FakeCall["op"], table, filters: [...filters] });
  let rows = rowsOf(table).filter((r) => matches(r, filters));
  if (orderCols.length) {
    rows = [...rows].sort((a, b) => {
      for (const c of orderCols) {
        const av = String(a[c] ?? ""), bv = String(b[c] ?? "");
        if (av !== bv) return av < bv ? -1 : 1;
      }
      return 0;
    });
  }
  return from === null || to === null ? rows : rows.slice(from, to + 1);
}

function builder(table: string) {
  let op: FakeCall["op"] | "select" = "select";
  let payload: Row[] | undefined;
  let onConflict: string | undefined;
  const filters: Filter[] = [];
  const orderCols: string[] = [];
  let rangeFrom: number | null = null;
  let rangeTo: number | null = null;
  const b = {
    select: () => b,
    order: (col: string) => (orderCols.push(col), b),
    range: (from: number, to: number) => ((rangeFrom = from), (rangeTo = to), b),
    delete: () => {
      op = "delete";
      return b;
    },
    insert: (rows: Row[]) => {
      op = "insert";
      payload = rows;
      return b;
    },
    upsert: (rows: Row[], opts?: { onConflict?: string }) => {
      op = "upsert";
      payload = rows;
      onConflict = opts?.onConflict;
      return b;
    },
    gte: (col: string, val: unknown) => (filters.push({ col, op: "gte", val }), b),
    lte: (col: string, val: unknown) => (filters.push({ col, op: "lte", val }), b),
    gt: (col: string, val: unknown) => (filters.push({ col, op: "gt", val }), b),
    lt: (col: string, val: unknown) => (filters.push({ col, op: "lt", val }), b),
    eq: (col: string, val: unknown) => (filters.push({ col, op: "eq", val }), b),
    then<R>(resolve: (v: unknown) => R, reject?: (e: unknown) => R) {
      try {
        if (op === "select") return resolve({ data: selectRows(table, filters, orderCols, rangeFrom, rangeTo), error: null });
        return resolve(execute(table, op, payload, filters, onConflict));
      } catch (e) {
        return reject ? reject(e) : Promise.reject(e);
      }
    },
  };
  return b;
}

const fakeClient = { from: (table: string) => builder(table) };

// The factory would build a real client; the fake ignores it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function lazySupabase<T extends object>(_factory: () => T): T {
  return fakeClient as unknown as T;
}

export const SUPABASE_URL = "http://fake.supabase.local";
export const SUPABASE_ANON_KEY = "fake-anon-key";
export function isSupabaseConfigured(): boolean {
  return true;
}
