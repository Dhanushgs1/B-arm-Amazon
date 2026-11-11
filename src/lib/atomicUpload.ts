// All-or-nothing replace for an upload: stage the file's rows, then swap them into the target table
// in ONE database transaction (public.barm_commit_staged_upload — see
// supabase/proposed/atomic_uploads). A failure at any point leaves the existing data untouched.
//
// Returns false when the database side is not installed yet; the caller then uses its previous
// delete-then-insert path. No imports, so every upload module can use it and it is unit-testable.

export type DeleteSpec =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "range"; column: string; gte: string; lte?: string; lt?: string }
  | { kind: "in"; column: string; values: string[] };

type Err = { code?: string; message: string } | null;

export interface AtomicUploadDeps {
  stage: (sessionId: string, batchIndex: number, table: string, rows: unknown[]) => Promise<Err>;
  commit: (sessionId: string, table: string, del: DeleteSpec, expectedRows: number, onConflict: string | null) => Promise<{ written: number | null; error: Err }>;
  discard: (sessionId: string) => Promise<void>;
  newSessionId: () => string;
}

// "relation/function does not exist" in PostgREST and Postgres terms.
const NOT_INSTALLED = new Set(["PGRST205", "PGRST202", "42P01", "42883"]);
const STAGE_BATCH = 300;
let knownNotInstalled = false;

export function resetAtomicUploadProbe() { knownNotInstalled = false; }

export async function runAtomicReplace(
  deps: AtomicUploadDeps,
  table: string,
  rows: unknown[],
  del: DeleteSpec,
  onConflict: string | null = null,
): Promise<boolean> {
  if (knownNotInstalled) return false;
  if (rows.length === 0) throw new Error("No valid rows found in this file. Existing data was left unchanged.");
  const session = deps.newSessionId();
  const fail = async (what: string, e: Err) => {
    await deps.discard(session).catch(() => {});
    return new Error(`${what} failed: ${e?.message ?? "unknown error"}. Existing ${table} data was left unchanged.`);
  };
  for (let i = 0, b = 0; i < rows.length; i += STAGE_BATCH, b++) {
    const err = await deps.stage(session, b, table, rows.slice(i, i + STAGE_BATCH));
    if (!err) continue;
    if (b === 0 && err.code && NOT_INSTALLED.has(err.code)) { knownNotInstalled = true; return false; }
    throw await fail("Staging the upload", err);
  }
  const { written, error } = await deps.commit(session, table, del, rows.length, onConflict);
  if (error) {
    if (error.code && NOT_INSTALLED.has(error.code)) { knownNotInstalled = true; await deps.discard(session).catch(() => {}); return false; }
    throw await fail("Saving the upload", error);
  }
  if (written !== rows.length) throw new Error(`Upload check failed: ${written} of ${rows.length} rows were saved to ${table}.`);
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a supabase-js client, passed in to avoid an import cycle
export function atomicReplace(client: any, table: string, rows: unknown[], del: DeleteSpec, onConflict: string | null = null): Promise<boolean> {
  return runAtomicReplace(
    {
      newSessionId: () => crypto.randomUUID(),
      stage: async (session_id, batch_index, target_table, r) =>
        (await client.from("barm_upload_staging").insert({ session_id, batch_index, target_table, rows: r })).error,
      commit: async (p_session, p_table, p_delete, p_expected_rows, p_on_conflict) => {
        const { data, error } = await client.rpc("barm_commit_staged_upload", { p_session, p_table, p_delete, p_expected_rows, p_on_conflict });
        return { written: typeof data === "number" ? data : null, error };
      },
      discard: async (session_id) => { await client.from("barm_upload_staging").delete().eq("session_id", session_id); },
    },
    table, rows, del, onConflict,
  );
}
