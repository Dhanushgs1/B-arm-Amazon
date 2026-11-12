// "Claim, then send": makes a mail that should go out once (per account, per kind, per day or
// upload) go out once even when the job that sends it fires twice, is retried, or races another
// caller.
//
// The old order was check -> send -> record. Two runs could both pass the check before either
// recorded, and a failed record after a successful send meant the next run sent again. Here the
// record is written FIRST, as a claim, on a unique key (barm_alert_state: key_slot, alert_type,
// entity_id): only one run can insert it, and only that run sends.
//
//   claim     -> "sending" row inserted. Someone else's row already there -> not claimed.
//   complete  -> row marked "sent".
//   release   -> row removed after a FAILED send, so a later run can try again.
//   A "sending" row older than STALE_MS belongs to a run that died mid-send; it can be taken over.
//
// If the claim store itself cannot be reached, the mail is still sent (claimed: true, degraded):
// a brief database blip must not stop the morning emails. No imports, so it is unit-testable.

export const STALE_MS = 15 * 60_000;

export interface ClaimRow {
  status?: string;
  lastSentAt: string;
}

export interface ClaimStore {
  /** Insert the claim. "exists" when the unique key is already taken. */
  insert: (slot: string, type: string, entity: string, nowIso: string) => Promise<"inserted" | "exists">;
  read: (slot: string, type: string, entity: string) => Promise<ClaimRow | null>;
  /** Take over a stale claim; true only if the row still had the lastSentAt we read. */
  takeOver: (slot: string, type: string, entity: string, expectedLastSentAt: string, nowIso: string) => Promise<boolean>;
  complete: (slot: string, type: string, entity: string, nowIso: string, details: Record<string, unknown>) => Promise<void>;
  release: (slot: string, type: string, entity: string) => Promise<void>;
}

export type ClaimResult =
  | { claimed: true; degraded?: string }
  | { claimed: false; reason: "already sent" | "another run is sending it" };

export async function claimOnce(store: ClaimStore, slot: string, type: string, entity: string, now = new Date()): Promise<ClaimResult> {
  const nowIso = now.toISOString();
  try {
    if ((await store.insert(slot, type, entity, nowIso)) === "inserted") return { claimed: true };
    const row = await store.read(slot, type, entity);
    // Removed between the insert and the read (the other run failed and released): try once more.
    if (!row) return (await store.insert(slot, type, entity, nowIso)) === "inserted" ? { claimed: true } : { claimed: false, reason: "another run is sending it" };
    if (row.status !== "sending") return { claimed: false, reason: "already sent" };
    const age = now.getTime() - Date.parse(row.lastSentAt);
    if (Number.isFinite(age) && age > STALE_MS && (await store.takeOver(slot, type, entity, row.lastSentAt, nowIso))) return { claimed: true };
    return { claimed: false, reason: "another run is sending it" };
  } catch (err) {
    return { claimed: true, degraded: err instanceof Error ? err.message : String(err) };
  }
}

/** Runs `send` at most once for (slot, type, entity). `send` reports whether the work succeeded. */
export async function sendOnce<T>(
  store: ClaimStore,
  key: { slot: string; type: string; entity: string },
  send: () => Promise<{ ok: boolean; value: T }>,
  now = new Date(),
): Promise<{ ran: true; ok: boolean; value: T; degraded?: string } | { ran: false; reason: string }> {
  const c = await claimOnce(store, key.slot, key.type, key.entity, now);
  if (!c.claimed) return { ran: false, reason: c.reason };
  let out: { ok: boolean; value: T };
  try {
    out = await send();
  } catch (err) {
    await store.release(key.slot, key.type, key.entity).catch(() => {});
    throw err;
  }
  // A store failure after the send is only logged by the caller's own logging: the mail has gone
  // (or failed) either way, and throwing here would report a sent mail as an error.
  if (out.ok) await store.complete(key.slot, key.type, key.entity, new Date().toISOString(), {}).catch(() => {});
  else await store.release(key.slot, key.type, key.entity).catch(() => {});
  return { ran: true, ok: out.ok, value: out.value, degraded: c.degraded };
}

const STATE_TABLE = "barm_alert_state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a supabase-js client, passed in
export function alertStateClaimStore(client: any): ClaimStore {
  const where = (q: any, slot: string, type: string, entity: string) => q.eq("key_slot", slot).eq("alert_type", type).eq("entity_id", entity); // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    insert: async (slot, type, entity, nowIso) => {
      const { error } = await client.from(STATE_TABLE).insert({ key_slot: slot, alert_type: type, entity_id: entity, severity: 0, last_sent_at: nowIso, details: { status: "sending" } });
      if (!error) return "inserted";
      if (error.code === "23505") return "exists";
      throw new Error(`claim insert failed: ${error.message}`);
    },
    read: async (slot, type, entity) => {
      const { data, error } = await where(client.from(STATE_TABLE).select("details,last_sent_at"), slot, type, entity).limit(1);
      if (error) throw new Error(`claim read failed: ${error.message}`);
      const r = data?.[0];
      return r ? { status: r.details?.status, lastSentAt: r.last_sent_at } : null;
    },
    takeOver: async (slot, type, entity, expected, nowIso) => {
      const { data, error } = await where(client.from(STATE_TABLE).update({ last_sent_at: nowIso, details: { status: "sending" } }), slot, type, entity).eq("last_sent_at", expected).select("id");
      if (error) throw new Error(`claim take-over failed: ${error.message}`);
      return (data || []).length === 1;
    },
    complete: async (slot, type, entity, nowIso, details) => {
      const { error } = await where(client.from(STATE_TABLE).update({ severity: 1, last_sent_at: nowIso, details: { ...details, status: "sent" } }), slot, type, entity);
      if (error) throw new Error(`claim complete failed: ${error.message}`);
    },
    release: async (slot, type, entity) => {
      const { error } = await where(client.from(STATE_TABLE).delete(), slot, type, entity).eq("details->>status", "sending");
      if (error) throw new Error(`claim release failed: ${error.message}`);
    },
  };
}

/** Today's date in IST (the day the 09:00 IST run belongs to). */
export function istDate(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}
