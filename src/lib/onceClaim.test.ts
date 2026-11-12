import test from "node:test";
import assert from "node:assert/strict";
import { claimOnce, sendOnce, istDate, STALE_MS, type ClaimStore } from "./onceClaim.ts";

function memoryStore() {
  const rows = new Map<string, { status?: string; lastSentAt: string }>();
  const k = (s: string, t: string, e: string) => `${s}|${t}|${e}`;
  const store: ClaimStore = {
    insert: async (s, t, e, now) => { if (rows.has(k(s, t, e))) return "exists"; rows.set(k(s, t, e), { status: "sending", lastSentAt: now }); return "inserted"; },
    read: async (s, t, e) => rows.get(k(s, t, e)) ?? null,
    takeOver: async (s, t, e, expected, now) => { const r = rows.get(k(s, t, e)); if (!r || r.lastSentAt !== expected) return false; rows.set(k(s, t, e), { status: "sending", lastSentAt: now }); return true; },
    complete: async (s, t, e, now) => { rows.set(k(s, t, e), { status: "sent", lastSentAt: now }); },
    release: async (s, t, e) => { if (rows.get(k(s, t, e))?.status === "sending") rows.delete(k(s, t, e)); },
  };
  return { store, rows };
}
const KEY = { slot: "B", type: "cron:dailyDigest", entity: "2026-11-12" };

test("two runs of the same job: only the first sends", async () => {
  const { store } = memoryStore();
  let sends = 0;
  const send = async () => { sends++; return { ok: true, value: "sent" }; };
  const [a, b] = await Promise.all([sendOnce(store, KEY, send), sendOnce(store, KEY, send)]);
  assert.equal(sends, 1);
  assert.deepEqual([a.ran, b.ran].sort(), [false, true]);
  const again = await sendOnce(store, KEY, send);
  assert.deepEqual(again, { ran: false, reason: "already sent" });
  assert.equal(sends, 1);
});

test("a failed send releases the claim, so the next run sends", async () => {
  const { store, rows } = memoryStore();
  const first = await sendOnce(store, KEY, async () => ({ ok: false, value: "smtp down" }));
  assert.deepEqual(first, { ran: true, ok: false, value: "smtp down", degraded: undefined });
  assert.equal(rows.size, 0);
  let sends = 0;
  const second = await sendOnce(store, KEY, async () => { sends++; return { ok: true, value: "sent" }; });
  assert.equal(second.ran && second.ok, true);
  assert.equal(sends, 1);
  await assert.rejects(sendOnce(store, { ...KEY, entity: "2026-11-13" }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(rows.has("B|cron:dailyDigest|2026-11-13"), false); // a throw releases too
});

test("a different day, account or mail kind is a separate claim", async () => {
  const { store } = memoryStore();
  const ok = async () => ({ ok: true, value: 1 });
  assert.equal((await sendOnce(store, KEY, ok)).ran, true);
  assert.equal((await sendOnce(store, { ...KEY, entity: "2026-11-13" }, ok)).ran, true);
  assert.equal((await sendOnce(store, { ...KEY, slot: "A" }, ok)).ran, true);
  assert.equal((await sendOnce(store, { ...KEY, type: "cron:liveAlerts" }, ok)).ran, true);
});

test("a run that died mid-send can be taken over after 15 minutes, not before, and only by one run", async () => {
  const { store } = memoryStore();
  const t0 = new Date("2026-11-12T03:30:00Z");
  assert.deepEqual(await claimOnce(store, "B", "t", "e", t0), { claimed: true });
  assert.deepEqual(await claimOnce(store, "B", "t", "e", new Date(t0.getTime() + STALE_MS - 1000)), { claimed: false, reason: "another run is sending it" });
  const late = new Date(t0.getTime() + STALE_MS + 1000);
  const [x, y] = await Promise.all([claimOnce(store, "B", "t", "e", late), claimOnce(store, "B", "t", "e", late)]);
  assert.deepEqual([x.claimed, y.claimed].sort(), [false, true]);
});

test("if the claim store cannot be reached the mail still goes (degraded), never silently skipped", async () => {
  const broken: ClaimStore = {
    insert: async () => { throw new Error("statement timeout"); },
    read: async () => null, takeOver: async () => false, complete: async () => { throw new Error("x"); }, release: async () => {},
  };
  let sends = 0;
  const r = await sendOnce(broken, KEY, async () => { sends++; return { ok: true, value: 1 }; });
  assert.equal(sends, 1);
  assert.equal(r.ran && r.degraded, "statement timeout");
});

test("istDate: the 09:00 IST run and a late-evening IST run land on the right IST day", () => {
  assert.equal(istDate(new Date("2026-11-12T03:30:00Z")), "2026-11-12"); // 09:00 IST
  assert.equal(istDate(new Date("2026-11-12T19:00:00Z")), "2026-11-13"); // 00:30 IST next day
  assert.equal(istDate(new Date("2026-11-11T18:29:00Z")), "2026-11-11"); // 23:59 IST
});
