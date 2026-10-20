/**
 * ADR-0190 I4 follow-up — stdio sessions on a multi-replica gateway, on a real database (migration 0204):
 *
 *  - OWNERSHIP: the holder writes its row once, for a committed offer of the executor it names; the offer, executor
 *    and holding replica never change; a row another replica holds is never touched by this one's holder calls.
 *  - NO CROSS-SESSION OR CROSS-EXECUTOR READS: a route reads only the row and frames of the offer in its path AND of
 *    the executor its proof names; another executor sees `offer_unavailable` and no frames; one session's frames
 *    never appear in another's read.
 *  - THE LEASE AND SESSION LOSS: a lapsed lease ends the row `lease_expired` exactly once (a second replica moves
 *    nothing), is `session_lost`, and an ended row stays ended (no revival, no renewal); a placed offer with no row
 *    is pending while young and lost after one lease; the holder that finds its row lost fails its call as lost.
 *  - FRAMES AND BOUNDS: stdin is acknowledged with `from` (dropped below it; `from` past the written frames or below
 *    the acknowledged ones is refused); stdout is contiguous (a gap ends the session `sequence`) and bounded at
 *    4 MiB buffered (`buffer_full`, a loss); one window at a time on every replica.
 *  - SEALED AT REST (review finding 3): no frame is stored in the clear (the CHECK refuses plaintext); a frame put in
 *    another place in the order does not open, and the session ends `unsealed` (a loss) on the route's or the
 *    holder's side, exactly once.
 *  - ONE POISONED SESSION (review finding 1) does not stop the replica's lease renewal: it is lost alone.
 *  - RETENTION: an ended row is deleted after 5 minutes and a long-lapsed one after an hour, frames with them.
 *  - THE 0185 GUARDS: both new functions pin their search_path; both tables refuse TRUNCATE; frames are never
 *    rewritten.
 * A real multi-replica deployment (two gateway processes behind one front, an executor between them) is PENDING
 * EXECUTION (M-041): this suite plays the second replica with rows written under another holder id.
 *
 * Global state (M-068): every row is scoped by this run's ids (offers and executors cannot be deleted by design);
 * this file's sessions are ended before it finishes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { executionProfileDigest, SHIPPED_EXECUTION_PROFILES, STDIO_SESSION_BUFFER_MAX_BYTES } from "@regulait/shared";
import { holdStdioSession, liveStdioSessions, setStdioRelayFailingMsForTest, StdioSession, useRelayDb } from "./executor-stdio.js";
import {
  STDIO_OWNER_HEARTBEAT_MS,
  STDIO_REPLICA_ID,
  ackStdioInput,
  appendStdioInput,
  appendStdioOutput,
  claimStdioWindow,
  endLapsedStdioSession,
  endUnsealedStdioSession,
  markStdioClosed,
  markStdioEnded,
  persistStdioSession,
  releaseStdioWindow,
  renewStdioLeases,
  sealStdioFrame,
  stdioHolderView,
  stdioInputFrom,
  stdioRouteDecision,
  stdioRouteState,
  sweepStdioRelay,
  takeStdioOutput,
} from "./stdio-relay.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const WORKLOAD = { command: "/srv/mcp/relay-server.js", args: ["--label", `relay-${RUN}`] };
const IMAGE = `sha256:${"6".repeat(64)}`;
const DIGEST = executionProfileDigest(SHIPPED_EXECUTION_PROFILES.restricted);

let db: Db;
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
const one = async <T>(stmt: ReturnType<typeof sql>) => rows<T>(await db.execute(stmt))[0]!;
// the database's refusal text is on the driver error drizzle attaches as `cause`, not on its "Failed query" wrapper
const refusedWith = async (stmt: ReturnType<typeof sql>, re: RegExp) => {
  const err = await db.execute(stmt).then(() => null, (e: unknown) => e);
  expect(err, "the statement was refused").not.toBeNull();
  expect(String((err as Error)?.message ?? "") + String((err as { cause?: Error })?.cause?.message ?? "")).toMatch(re);
};
const until = async (cond: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
};

let executorA = "";
let executorB = "";
const held: StdioSession[] = [];

async function newExecutor(name: string): Promise<string> {
  const identity = await one<{ id: string }>(
    sql`insert into workload_identities (kind, identifier, sponsor_user_ids)
        values ('worker_runtime', ${`spiffe://example.org/regulait/test/relay-${name}-${RUN}`}, ARRAY[${randomUUID()}]::uuid[]) returning id`,
  );
  return (
    await one<{ id: string }>(
      sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
          values (${identity.id}, ${`relay-${name}-${RUN}`}, 'gvisor', 'release-20261012.0', '["hardened_container", "user_space_kernel"]'::jsonb) returning id`,
    )
  ).id;
}

/** an offer of `executorId`, moved to placed (forward steps only); `ageSeconds` backdates when it was made */
async function placedOffer(executorId: string, ageSeconds = 0): Promise<string> {
  const o = await one<{ id: string }>(
    sql`insert into execution_offers (executor_id, workload_kind, required_class, required_by, enforcement, profile_digest, image_digest, offered_at, expires_at)
        values (${executorId}, 'mcp_stdio', 'user_space_kernel', 'workload_kind', 'enforce', ${DIGEST}, ${IMAGE},
                now() - make_interval(secs => ${ageSeconds}), now() + interval '1 hour') returning id`,
  );
  await db.execute(sql`update execution_offers set status = 'accepted', accepted_at = now() where id = ${o.id}`);
  const placement = await one<{ id: string }>(
    sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, executor_id, applied_class, report_sha256, outcome)
        values (${randomUUID()}, 'mcp_stdio', 'user_space_kernel', 'workload_kind', 'enforce', ${DIGEST}, ${executorId}, 'user_space_kernel', ${"f".repeat(64)}, 'placed') returning id`,
  );
  await db.execute(sql`update execution_offers set status = 'placed', reported_at = now(), placement_id = ${placement.id} where id = ${o.id}`);
  return o.id;
}

/** this replica's row for a new placed offer of executor A */
async function ownedSession(): Promise<string> {
  const offerId = await placedOffer(executorA);
  expect(await persistStdioSession(db, { offerId, executorId: executorA, startSealed: null })).toBe(true);
  return offerId;
}

const sessionRow = (offerId: string) =>
  one<{ end_code: string | null; ended: boolean; in_next_seq: number; in_acked_to: number; out_next_seq: number; out_buffered_bytes: number; owner_replica: string }>(
    sql`select end_code, ended_at is not null as ended, in_next_seq::int, in_acked_to::int, out_next_seq::int, out_buffered_bytes, owner_replica from stdio_relay_sessions where offer_id = ${offerId}`,
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  executorA = await newExecutor("a");
  executorB = await newExecutor("b");
});

afterAll(async () => {
  for (const s of held) s.end();
  await until(() => liveStdioSessions() === 0).catch(() => undefined);
});

describe("ADR-0190 I4 multi-replica stdio: migration 0204", () => {
  it("is applied (journal idx 204) and keeps the 0185 guards", async () => {
    const tables = rows<{ t: string }>(
      await db.execute(sql`select table_name as t from information_schema.tables where table_schema = 'public' and table_name like 'stdio_relay_%' order by 1`),
    ).map((r) => r.t);
    expect(tables).toEqual(["stdio_relay_frames", "stdio_relay_sessions"]);
    const fns = rows<{ name: string; config: string[] | null }>(
      await db.execute(sql`select proname as name, proconfig as config from pg_proc where proname in ('stdio_relay_sessions_guard', 'stdio_relay_frames_immutable') order by 1`),
    );
    expect(fns.map((f) => f.name)).toEqual(["stdio_relay_frames_immutable", "stdio_relay_sessions_guard"]);
    for (const f of fns) expect(f.config).toContain("search_path=pg_catalog, public, pg_temp");
    await refusedWith(sql`truncate stdio_relay_frames`, /truncate|refus/i);
    await refusedWith(sql`truncate stdio_relay_sessions cascade`, /truncate|refus/i);
  });
});

describe("ADR-0190 I4 multi-replica stdio: ownership and isolation", () => {
  it("the holder writes its row once, for its executor's committed offer only; the row's identity never changes", async () => {
    const offerId = await placedOffer(executorA);
    // the wrong executor for the offer: nothing is written
    expect(await persistStdioSession(db, { offerId, executorId: executorB, startSealed: null })).toBe(false);
    // an offer that does not exist (an engine task's, before its transaction commits): nothing is written
    expect(await persistStdioSession(db, { offerId: randomUUID(), executorId: executorA, startSealed: null })).toBe(false);
    expect(await persistStdioSession(db, { offerId, executorId: executorA, startSealed: null })).toBe(true);
    // a retried tick is harmless
    expect(await persistStdioSession(db, { offerId, executorId: executorA, startSealed: null })).toBe(true);
    expect((await sessionRow(offerId)).owner_replica).toBe(STDIO_REPLICA_ID);
    await refusedWith(sql`update stdio_relay_sessions set owner_replica = ${randomUUID()} where offer_id = ${offerId}`, /never change/);
    await refusedWith(sql`update stdio_relay_sessions set executor_id = ${executorB} where offer_id = ${offerId}`, /never change/);
  });

  it("a row another replica holds: this replica's holder calls never touch it", async () => {
    const offerId = await placedOffer(executorA);
    await db.execute(sql`insert into stdio_relay_sessions (offer_id, executor_id, owner_replica, lease_expires_at) values (${offerId}, ${executorA}, ${randomUUID()}, now() + interval '15 seconds')`);
    expect(await persistStdioSession(db, { offerId, executorId: executorA, startSealed: null })).toBe(false);
    expect(await appendStdioInput(db, offerId, 0, [{ data: "{}", bytes: 2 }])).toBe(false);
    expect(await appendStdioOutput(db, executorA, offerId, [{ seq: 0, data: '{"jsonrpc":"2.0"}' }], false)).toMatchObject({ kind: "ok" });
    expect(await takeStdioOutput(db, offerId, 0)).toEqual([]);
    await markStdioClosed(db, offerId);
    await markStdioEnded(db, offerId);
    await renewStdioLeases(db, [offerId]);
    expect(await endUnsealedStdioSession(db, offerId, "holder")).toBe(false);
    expect(await stdioHolderView(db, [offerId])).toEqual([]);
    const r = await sessionRow(offerId);
    expect(r).toMatchObject({ ended: false, in_next_seq: 0, out_next_seq: 1 });
    expect(rows(await db.execute(sql`select 1 from stdio_relay_sessions where offer_id = ${offerId} and closed_at is null`))).toHaveLength(1);
    // but every replica's ROUTES serve it (that is the point: the executor may reach any replica)
    expect(stdioRouteDecision((await stdioRouteState(db, executorA, offerId)).state, true)).toEqual({ kind: "serve" });
  });

  it("another executor reads nothing of a session: offer_unavailable, no frames, no acknowledgement, no window", async () => {
    const offerId = await ownedSession();
    expect(await appendStdioInput(db, offerId, 0, [{ data: '{"a":1}', bytes: 7 }])).toBe(true);
    const asB = await stdioRouteState(db, executorB, offerId);
    expect(asB.state.offerPlaced).toBe(false);
    expect(asB.row).toBeNull();
    expect(stdioRouteDecision(asB.state, true)).toMatchObject({ kind: "refuse", code: "offer_unavailable", record: false });
    expect((await stdioInputFrom(db, executorB, offerId, 0)).frames).toEqual([]);
    expect(await ackStdioInput(db, executorB, offerId, 1)).toBe(false);
    expect(await claimStdioWindow(db, executorB, offerId, 5)).toBeNull();
    expect(await appendStdioOutput(db, executorB, offerId, [{ seq: 0, data: "{}" }], false)).toEqual({ kind: "gone" });
    // executor A reads its own frame
    expect((await stdioInputFrom(db, executorA, offerId, 0)).frames).toEqual([{ seq: 0, data: '{"a":1}' }]);
  });

  it("one session's frames never appear in another's read, even for the same executor", async () => {
    const first = await ownedSession();
    const second = await ownedSession();
    expect(await appendStdioInput(db, first, 0, [{ data: '"first"', bytes: 7 }])).toBe(true);
    expect(await appendStdioInput(db, second, 0, [{ data: '"second"', bytes: 8 }])).toBe(true);
    expect((await stdioInputFrom(db, executorA, first, 0)).frames.map((f) => f.data)).toEqual(['"first"']);
    expect((await stdioInputFrom(db, executorA, second, 0)).frames.map((f) => f.data)).toEqual(['"second"']);
    expect(await appendStdioOutput(db, executorA, first, [{ seq: 0, data: '"out-first"' }], false)).toMatchObject({ kind: "ok" });
    expect(await takeStdioOutput(db, second, 0)).toEqual([]);
    expect(await takeStdioOutput(db, first, 0)).toEqual([{ seq: 0, data: '"out-first"' }]);
  });
});

describe("ADR-0190 I4 multi-replica stdio: frames, windows and bounds", () => {
  it("stdin is acknowledged with `from`; `from` below the acknowledged or past the written frames is refused", async () => {
    const offerId = await ownedSession();
    expect(await appendStdioInput(db, offerId, 0, [{ data: '"x0"', bytes: 4 }, { data: '"x1"', bytes: 4 }])).toBe(true);
    // a gap the holder did not write is never accepted
    expect(await appendStdioInput(db, offerId, 5, [{ data: '"x5"', bytes: 4 }])).toBe(false);
    expect(await ackStdioInput(db, executorA, offerId, 3)).toBe(false);
    expect(await ackStdioInput(db, executorA, offerId, 1)).toBe(true);
    expect((await stdioInputFrom(db, executorA, offerId, 0)).frames.map((f) => f.seq)).toEqual([1]);
    expect(await ackStdioInput(db, executorA, offerId, 0)).toBe(false);
    expect(await sessionRow(offerId)).toMatchObject({ in_next_seq: 2, in_acked_to: 1 });
    await refusedWith(sql`update stdio_relay_frames set data_sealed = data_sealed where offer_id = ${offerId}`, /never rewritten/);
  });

  it("one window at a time across replicas; a released window can be claimed again", async () => {
    const offerId = await ownedSession();
    const t = await claimStdioWindow(db, executorA, offerId, 5);
    expect(t).not.toBeNull();
    expect(await claimStdioWindow(db, executorA, offerId, 5)).toBeNull();
    await releaseStdioWindow(db, offerId, randomUUID());
    expect(await claimStdioWindow(db, executorA, offerId, 5)).toBeNull();
    await releaseStdioWindow(db, offerId, t!);
    expect(await claimStdioWindow(db, executorA, offerId, 5)).not.toBeNull();
  });

  it("stdout is contiguous: a gap ends the session `sequence` (not a loss) and the row stays ended", async () => {
    const offerId = await ownedSession();
    expect(await appendStdioOutput(db, executorA, offerId, [{ seq: 0, data: '"o0"' }, { seq: 1, data: '"o1"' }], false)).toEqual({ kind: "ok", nextSeq: 2, closed: false });
    expect(await appendStdioOutput(db, executorA, offerId, [{ seq: 1, data: '"o1"' }], false)).toEqual({ kind: "sequence", expected: 2 });
    expect(await sessionRow(offerId)).toMatchObject({ ended: true, end_code: "sequence" });
    expect(stdioRouteDecision((await stdioRouteState(db, executorA, offerId)).state, true)).toMatchObject({ code: "offer_unavailable" });
    await refusedWith(sql`update stdio_relay_sessions set ended_at = null, end_code = null where offer_id = ${offerId}`, /stays ended/);
    expect(rows(await db.execute(sql`select 1 from stdio_relay_frames where offer_id = ${offerId}`))).toHaveLength(0);
  });

  it("stdout past 4 MiB buffered ends the session as lost (`buffer_full`); taking output frees the space", async () => {
    const offerId = await ownedSession();
    const big = `"${"x".repeat(700_000)}"`;
    let seq = 0;
    let out: Awaited<ReturnType<typeof appendStdioOutput>> = { kind: "gone" };
    // the holder takes the first frame (so the counter goes down), then is "stuck"
    expect(await appendStdioOutput(db, executorA, offerId, [{ seq: seq++, data: big }], false)).toMatchObject({ kind: "ok" });
    expect((await takeStdioOutput(db, offerId, 0))?.map((f) => f.seq)).toEqual([0]);
    expect((await sessionRow(offerId)).out_buffered_bytes).toBe(0);
    for (let i = 0; i < Math.ceil(STDIO_SESSION_BUFFER_MAX_BYTES / big.length) + 1; i++) {
      out = await appendStdioOutput(db, executorA, offerId, [{ seq: seq++, data: big }], false);
      if (out.kind !== "ok") break;
    }
    expect(out).toEqual({ kind: "buffer_full" });
    expect(await sessionRow(offerId)).toMatchObject({ ended: true, end_code: "buffer_full", out_buffered_bytes: expect.any(Number) });
  });
});

describe("ADR-0190 I4 multi-replica stdio: the lease and session loss", () => {
  it("a lapsed lease ends the row lease_expired exactly once; an ended row is never renewed or revived", async () => {
    const offerId = await ownedSession();
    expect(stdioRouteDecision((await stdioRouteState(db, executorA, offerId)).state, true)).toEqual({ kind: "serve" });
    await db.execute(sql`update stdio_relay_sessions set lease_expires_at = now() - interval '1 second' where offer_id = ${offerId}`);
    const st = await stdioRouteState(db, executorA, offerId);
    expect(stdioRouteDecision(st.state, true)).toEqual({ kind: "refuse", code: "session_lost", record: true, endLease: true });
    // another executor's route never ends it
    expect(await endLapsedStdioSession(db, executorB, offerId)).toBe(false);
    expect((await sessionRow(offerId)).ended).toBe(false);
    expect(await endLapsedStdioSession(db, executorA, offerId)).toBe(true);
    // the second replica to notice moves nothing
    expect(await endLapsedStdioSession(db, executorA, offerId)).toBe(false);
    expect(await sessionRow(offerId)).toMatchObject({ ended: true, end_code: "lease_expired" });
    await renewStdioLeases(db, [offerId]);
    expect((await stdioRouteState(db, executorA, offerId)).row).toMatchObject({ ended: true, leaseLive: false });
    expect(await appendStdioInput(db, offerId, 0, [{ data: "{}", bytes: 2 }])).toBe(false);
    expect(await claimStdioWindow(db, executorA, offerId, 5)).toBeNull();
  });

  it("a live lease is not ended by another replica's check", async () => {
    const offerId = await ownedSession();
    expect(await endLapsedStdioSession(db, executorA, offerId)).toBe(false);
    expect((await sessionRow(offerId)).ended).toBe(false);
  });

  it("a placed offer with no row: pending while it is younger than a lease, lost after", async () => {
    const young = await placedOffer(executorA);
    expect(stdioRouteDecision((await stdioRouteState(db, executorA, young)).state, true)).toMatchObject({ code: "stdio_session_pending", record: false });
    expect(stdioRouteDecision((await stdioRouteState(db, executorA, young)).state, false)).toMatchObject({ code: "session_lost", record: true });
    const old = await placedOffer(executorA, 60);
    expect(stdioRouteDecision((await stdioRouteState(db, executorA, old)).state, true)).toMatchObject({ code: "session_lost", record: true, endLease: false });
  });

  it("THE HOLDER: persists its session, relays stdin and stdout, and fails its call as LOST when its row is", async () => {
    useRelayDb(db);
    const offerId = await placedOffer(executorA);
    const s = new StdioSession(offerId, executorA, WORKLOAD);
    const got: string[] = [];
    s.onLine = (l) => got.push(l);
    expect(holdStdioSession(s)).toBe(true);
    held.push(s);
    s.watched = true;
    await until(async () => rows(await db.execute(sql`select 1 from stdio_relay_sessions where offer_id = ${offerId} and start_sealed is not null`)).length === 1);
    s.push('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    await until(async () => (await stdioInputFrom(db, executorA, offerId, 0)).frames.length === 1);
    // another replica's route posts the sandbox's answer; the holder takes it and the sealed start is dropped
    expect(await appendStdioOutput(db, executorA, offerId, [{ seq: 0, data: '{"jsonrpc":"2.0","id":1,"result":{}}' }], false)).toMatchObject({ kind: "ok" });
    await until(() => got.length === 1);
    expect(s.nextOutSeq).toBe(1);
    expect(rows(await db.execute(sql`select 1 from stdio_relay_sessions where offer_id = ${offerId} and start_sealed is null`))).toHaveLength(1);
    // the acknowledgement reaches the holder, which drops its copy
    expect(await ackStdioInput(db, executorA, offerId, 1)).toBe(true);
    await until(() => s.ackedThrough === 1);
    // the holder is "gone" (its lease lapsed); a route on another replica ends the row; the holder's call fails as lost
    // (in one transaction, so the holder's own heartbeat cannot slip in between: it waits on the row and then finds it ended)
    const ended = await db.transaction(async (tx) => {
      await tx.execute(sql`update stdio_relay_sessions set lease_expires_at = now() - interval '1 second' where offer_id = ${offerId}`);
      return endLapsedStdioSession(tx as unknown as Db, executorA, offerId);
    });
    expect(ended).toBe(true);
    await until(() => s.ended);
    expect(s.lostReason).toMatch(/stopped renewing/);
  });

  it("THE HOLDER: the offer ending under its session ends the call normally (not a loss), after the output", async () => {
    useRelayDb(db);
    const offerId = await placedOffer(executorA);
    const s = new StdioSession(offerId, executorA, WORKLOAD);
    const got: string[] = [];
    s.onLine = (l) => got.push(l);
    expect(holdStdioSession(s)).toBe(true);
    held.push(s);
    s.watched = true;
    await until(async () => rows(await db.execute(sql`select 1 from stdio_relay_sessions where offer_id = ${offerId}`)).length === 1);
    expect(await appendStdioOutput(db, executorA, offerId, [{ seq: 0, data: '"last"' }], false)).toMatchObject({ kind: "ok" });
    await db.execute(sql`update execution_offers set status = 'ended', end_outcome = 'completed', ended_at = now() where id = ${offerId}`);
    await until(() => s.ended);
    expect(got).toEqual(['"last"']);
    expect(s.lostReason).toBeNull();
    await until(async () => (await sessionRow(offerId)).end_code === "ended");
  });
});

describe("ADR-0190 I4 multi-replica stdio: frames sealed at rest (review finding 3)", () => {
  const frameRows = (offerId: string) =>
    db.execute(sql`select direction, seq::int, data_sealed, bytes from stdio_relay_frames where offer_id = ${offerId} order by direction, seq`).then((r) =>
      rows<{ direction: "in" | "out"; seq: number; data_sealed: string; bytes: number }>(r),
    );

  it("no frame is stored in the clear, and the table refuses one that is", async () => {
    const offerId = await ownedSession();
    const secretArg = `"user-${RUN}@example.org"`;
    expect(await appendStdioInput(db, offerId, 0, [{ data: secretArg, bytes: secretArg.length }])).toBe(true);
    expect(await appendStdioOutput(db, executorA, offerId, [{ seq: 0, data: secretArg }], false)).toMatchObject({ kind: "ok" });
    const stored = await frameRows(offerId);
    expect(stored).toHaveLength(2);
    for (const f of stored) {
      expect(f.data_sealed).not.toContain(`user-${RUN}`);
      expect(f.bytes).toBe(secretArg.length);
    }
    await refusedWith(
      sql`insert into stdio_relay_frames (offer_id, direction, seq, data_sealed, bytes) values (${offerId}, 'in', 1, ${secretArg}, ${secretArg.length})`,
      /stdio_relay_frames_sealed_check/,
    );
    // and they open for the reader they are for
    expect((await stdioInputFrom(db, executorA, offerId, 0)).frames).toEqual([{ seq: 0, data: secretArg }]);
    expect(await takeStdioOutput(db, offerId, 0)).toEqual([{ seq: 0, data: secretArg }]);
  });

  it("stdin put in another place in the order does not open: the route ends the session `unsealed`, once", async () => {
    const offerId = await ownedSession();
    expect(await appendStdioInput(db, offerId, 0, [{ data: '"i0"', bytes: 4 }, { data: '"i1"', bytes: 4 }])).toBe(true);
    const [f0, f1] = await frameRows(offerId);
    // swapped at rest (frames cannot be rewritten in place: deleted and written back in each other's place)
    await db.execute(sql`delete from stdio_relay_frames where offer_id = ${offerId}`);
    await db.execute(sql`insert into stdio_relay_frames (offer_id, direction, seq, data_sealed, bytes)
                         values (${offerId}, 'in', 0, ${f1!.data_sealed}, 4), (${offerId}, 'in', 1, ${f0!.data_sealed}, 4)`);
    const st = await stdioInputFrom(db, executorA, offerId, 0);
    expect(st).toMatchObject({ frames: [], unopened: true });
    expect(await endUnsealedStdioSession(db, offerId, { executorId: executorB })).toBe(false);
    expect(await endUnsealedStdioSession(db, offerId, { executorId: executorA })).toBe(true);
    expect(await endUnsealedStdioSession(db, offerId, { executorId: executorA })).toBe(false);
    expect(await sessionRow(offerId)).toMatchObject({ ended: true, end_code: "unsealed" });
    expect(await frameRows(offerId)).toEqual([]);
  });

  it("stdout reordered at rest is never delivered (null)", async () => {
    const offerId = await ownedSession();
    expect(await appendStdioOutput(db, executorA, offerId, [{ seq: 0, data: '"o0"' }, { seq: 1, data: '"o1"' }], false)).toMatchObject({ kind: "ok" });
    const [f0, f1] = await frameRows(offerId);
    await db.execute(sql`delete from stdio_relay_frames where offer_id = ${offerId}`);
    await db.execute(sql`insert into stdio_relay_frames (offer_id, direction, seq, data_sealed, bytes)
                         values (${offerId}, 'out', 0, ${f1!.data_sealed}, 4), (${offerId}, 'out', 1, ${f0!.data_sealed}, 4)`);
    expect(await takeStdioOutput(db, offerId, 0)).toBeNull();
  });

  it("THE HOLDER: stdout sealed under another root (no shared data key) fails its call as LOST `unsealed`", async () => {
    useRelayDb(db);
    const offerId = await placedOffer(executorA);
    const s = new StdioSession(offerId, executorA, WORKLOAD);
    const got: string[] = [];
    s.onLine = (l) => got.push(l);
    expect(holdStdioSession(s)).toBe(true);
    held.push(s);
    s.watched = true;
    await until(async () => rows(await db.execute(sql`select 1 from stdio_relay_sessions where offer_id = ${offerId}`)).length === 1);
    // what a replica with another data key would have stored
    await db.execute(sql`insert into stdio_relay_frames (offer_id, direction, seq, data_sealed, bytes)
                         values (${offerId}, 'out', 0, ${sealStdioFrame(offerId, "out", 0, '"x"', randomBytes(32))}, 3)`);
    await db.execute(sql`update stdio_relay_sessions set out_next_seq = 1, out_buffered_bytes = 3 where offer_id = ${offerId}`);
    await until(() => s.ended);
    expect(got).toEqual([]);
    expect(s.lostReason).toMatch(/did not open/);
    expect(await sessionRow(offerId)).toMatchObject({ ended: true, end_code: "unsealed" });
  });
});

describe("ADR-0190 I4 multi-replica stdio: one poisoned session (review finding 1)", () => {
  it("does not stop the replica's lease renewal: the healthy session's lease moves on, the poisoned one is lost alone", { timeout: 45_000 }, async () => {
    useRelayDb(db);
    // long enough that a heartbeat falls while the poisoned session is still held and failing
    const failingMs = STDIO_OWNER_HEARTBEAT_MS * 2 + 1_000;
    setStdioRelayFailingMsForTest(failingMs);
    try {
      const offerId = await placedOffer(executorA);
      const good = new StdioSession(offerId, executorA, WORKLOAD);
      expect(holdStdioSession(good)).toBe(true);
      held.push(good);
      good.watched = true;
      await until(async () => rows(await db.execute(sql`select 1 from stdio_relay_sessions where offer_id = ${offerId}`)).length === 1);
      const leaseOf = async () => (await one<{ ms: number }>(sql`select (extract(epoch from lease_expires_at) * 1000)::float8 as ms from stdio_relay_sessions where offer_id = ${offerId}`)).ms;
      // every statement for this session throws (its executor id is not a uuid): a persistent per-session fault
      const poisoned = new StdioSession(await placedOffer(executorA), "not-a-uuid", WORKLOAD);
      expect(holdStdioSession(poisoned)).toBe(true);
      held.push(poisoned);
      await until(() => poisoned.relayFailingSince !== null);
      const before = await leaseOf();
      // the healthy session's lease is renewed on the next heartbeat WHILE the poisoned one fails every tick
      await until(async () => (await leaseOf()) > before, STDIO_OWNER_HEARTBEAT_MS + 2_000);
      expect(poisoned.ended).toBe(false);
      // then the poisoned session alone is lost (and recorded); the healthy one stays live
      await until(() => poisoned.ended, failingMs + 5_000);
      expect(poisoned.lostReason).toMatch(/could not relay/);
      expect(good.ended).toBe(false);
      expect(await sessionRow(offerId)).toMatchObject({ ended: false });
    } finally {
      setStdioRelayFailingMsForTest(null);
    }
  });
});

describe("ADR-0190 I4 multi-replica stdio: retention", () => {
  it("an ended row goes after 5 minutes, a long-lapsed one after an hour, frames with them; a live row stays", async () => {
    const ended = await placedOffer(executorA);
    const stale = await placedOffer(executorA);
    const kept = await ownedSession();
    await db.execute(sql`insert into stdio_relay_sessions (offer_id, executor_id, owner_replica, lease_expires_at, ended_at, end_code)
                         values (${ended}, ${executorA}, ${randomUUID()}, now() - interval '10 minutes', now() - interval '6 minutes', 'ended')`);
    await db.execute(sql`insert into stdio_relay_sessions (offer_id, executor_id, owner_replica, lease_expires_at, in_next_seq)
                         values (${stale}, ${executorA}, ${randomUUID()}, now() - interval '2 hours', 1)`);
    await db.execute(sql`insert into stdio_relay_frames (offer_id, direction, seq, data_sealed, bytes) values (${stale}, 'in', 0, ${sealStdioFrame(stale, "in", 0, "{}")}, 2)`);
    expect(await sweepStdioRelay(db)).toBeGreaterThanOrEqual(2);
    const left = rows<{ offer_id: string }>(await db.execute(sql`select offer_id from stdio_relay_sessions where offer_id in (${ended}, ${stale}, ${kept})`)).map((r) => r.offer_id);
    expect(left).toEqual([kept]);
    expect(rows(await db.execute(sql`select 1 from stdio_relay_frames where offer_id = ${stale}`))).toHaveLength(0);
  });
});
