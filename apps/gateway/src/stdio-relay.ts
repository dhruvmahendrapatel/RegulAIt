/**
 * ADR-0190 I4 follow-up — STDIO SESSIONS ON A MULTI-REPLICA GATEWAY: the frames table (migration 0206).
 *
 * A stdio session is held by the gateway replica that placed it: its MCP client, and the caller waiting on it, live
 * in that process. The executor's window (`GET …/offers/:id/stdio`) and its stdout POSTs reach whichever replica the
 * load balancer picks. So every replica serves those two routes from the database, and the holder relays between the
 * database and its in-process session (`executor-stdio.ts`, the relay tick). There is no replica-to-replica call and
 * no new endpoint: the executor's channel routes, behind its one-use proof, are the only way in.
 *
 *   stdio_relay_sessions   the holder (a random id per process) and its LEASE, which it renews every
 *                          `STDIO_OWNER_HEARTBEAT_MS`; the sealed `start` line; the counters; one window at a time
 *   stdio_relay_frames     stdin frames until the executor acknowledges them, stdout frames until the holder takes them
 *
 * WHO MAY READ WHAT. A route reads only the row and frames of the offer in its path AND of the executor its proof
 * names (every query joins on both), so one executor never reads another's frames, and no request reads a session
 * other than its own. The holder reads only rows it owns (`owner_replica`). A row's offer, executor and holder never
 * change (a trigger refuses it).
 *
 * FAIL CLOSED WHEN THE HOLDER IS GONE. A route that finds the lease lapsed ends the session `lease_expired` (one
 * conditional UPDATE: of two replicas only one moves it), records it as our own refusal (`recordSessionLost`) and
 * answers 409 `session_lost`, which the executor treats as final and stops the sandbox. A holder that comes back
 * finds its row ended and fails its call as lost. Nothing ever takes a session over.
 *
 * BOUNDS. One frame ≤ 768 KiB; stdin ≤ 4 MiB per session (the holder refuses more); stdout ≤ 4 MiB buffered (the
 * route refuses more and the session is lost: the holder is not draining it). An ended row stays 5 minutes so a late
 * window gets `offer_unavailable`, then `sweepStdioRelay` deletes it with its frames.
 */
import { randomUUID } from "node:crypto";
import { sql, type Db } from "@regulait/db";
import { STDIO_POST_MAX_FRAMES, STDIO_SESSION_BUFFER_MAX_BYTES, stdioLineBytes } from "@regulait/shared";

/** this process's holder id (random per process: a restarted replica holds nothing it held before) */
export const STDIO_REPLICA_ID = randomUUID();
/** a holder's lease: a route that finds it lapsed declares the session lost */
export const STDIO_OWNER_LEASE_MS = 15_000;
/** how often the holder renews its leases (a third of the lease, so one missed beat is not a loss) */
export const STDIO_OWNER_HEARTBEAT_MS = 5_000;
/** how often a window or the holder looks for new frames when nothing in this process woke it */
export const STDIO_RELAY_POLL_MS = 100;
/** an ended row is kept this long (a late window is answered `offer_unavailable`), then deleted */
export const STDIO_RELAY_ENDED_RETENTION_MS = 5 * 60_000;
/** a row whose lease lapsed this long ago is deleted whatever its state */
export const STDIO_RELAY_STALE_MS = 60 * 60_000;

/** how a session ended (`end_code`); the last two are LOSSES (our own refusal, never the server's failure) */
export type StdioRelayEndCode = "ended" | "sequence" | "lease_expired" | "buffer_full";
export const STDIO_RELAY_LOST_CODES: ReadonlySet<StdioRelayEndCode> = new Set(["lease_expired", "buffer_full"]);
export const STDIO_RELAY_LOST_TEXT: Record<"lease_expired" | "buffer_full", string> = {
  lease_expired: "the gateway replica holding the session stopped renewing it",
  buffer_full: "the gateway replica holding the session stopped taking its output",
};

const rowsOf = <R>(r: unknown) => (r as { rows: R[] }).rows;
/** a uuid list as one bound parameter (`= ANY(…)`), never spliced into the text */
const uuidArray = (ids: readonly string[]) => sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;

// ---------------------------------------------------------------------------
// The routing decision (pure: the unit tests drive it)
// ---------------------------------------------------------------------------

/** what a route knows about the session, every time read on the database clock */
export interface StdioRouteState {
  /** the offer in the path is THIS executor's and placed */
  offerPlaced: boolean;
  /** the offer was made less than one lease ago (its holder may not have written the row yet) */
  offerYoung: boolean;
  row: null | { ended: boolean; leaseLive: boolean };
}
export type StdioRouteDecision =
  | { kind: "serve" }
  /** `record`: write the `execution-session-lost` audit row; `endLease`: end the row `lease_expired` first */
  | { kind: "refuse"; code: "offer_unavailable" | "stdio_session_pending" | "session_lost"; record: boolean; endLease: boolean };

/**
 * One rule for both routes:
 *  - an offer that is not this executor's, or not placed, is `offer_unavailable`;
 *  - no row yet for a young offer: its holder writes it within one relay tick, so the window is asked to come back
 *    (`stdio_session_pending`, not final). Only a window may wait: a stdout POST only follows a `start`, which only a
 *    row can give, so `allowPending` is false for it;
 *  - no row for an older offer: the holder never wrote it (it is gone): `session_lost`, recorded;
 *  - an ended row: `offer_unavailable` (the session is over; nothing new to record);
 *  - a lapsed lease: `session_lost`, the row ended `lease_expired` and the loss recorded;
 *  - otherwise the route serves the session.
 */
export function stdioRouteDecision(s: StdioRouteState, allowPending: boolean): StdioRouteDecision {
  if (!s.offerPlaced) return { kind: "refuse", code: "offer_unavailable", record: false, endLease: false };
  if (s.row === null) {
    if (s.offerYoung && allowPending) return { kind: "refuse", code: "stdio_session_pending", record: false, endLease: false };
    return { kind: "refuse", code: "session_lost", record: true, endLease: false };
  }
  if (s.row.ended) return { kind: "refuse", code: "offer_unavailable", record: false, endLease: false };
  if (!s.row.leaseLive) return { kind: "refuse", code: "session_lost", record: true, endLease: true };
  return { kind: "serve" };
}

// ---------------------------------------------------------------------------
// Route side (any replica)
// ---------------------------------------------------------------------------

export interface StdioRelayRow {
  startSealed: string | null;
  inNextSeq: number;
  inAckedTo: number;
  outNextSeq: number;
  outBufferedBytes: number;
  closed: boolean;
  ended: boolean;
  leaseLive: boolean;
}

/** the route's view: the offer (this executor's only) and its row, on the database clock */
export async function stdioRouteState(db: Db, executorId: string, offerId: string): Promise<{ state: StdioRouteState; row: StdioRelayRow | null }> {
  const r = rowsOf<{
    status: string;
    young: boolean;
    has_row: boolean;
    start_sealed: string | null;
    in_next_seq: string | null;
    in_acked_to: string | null;
    out_next_seq: string | null;
    out_buffered_bytes: number | null;
    closed: boolean | null;
    ended: boolean | null;
    lease_live: boolean | null;
  }>(
    await db.execute(sql`
      SELECT o.status,
             o.offered_at > now() - make_interval(secs => ${STDIO_OWNER_LEASE_MS / 1000}) AS young,
             s.offer_id IS NOT NULL AS has_row,
             s.start_sealed, s.in_next_seq, s.in_acked_to, s.out_next_seq, s.out_buffered_bytes,
             s.closed_at IS NOT NULL AS closed, s.ended_at IS NOT NULL AS ended, s.lease_expires_at > now() AS lease_live
        FROM execution_offers o
        LEFT JOIN stdio_relay_sessions s ON s.offer_id = o.id AND s.executor_id = o.executor_id
       WHERE o.id = ${offerId} AND o.executor_id = ${executorId}`),
  )[0];
  if (!r) return { state: { offerPlaced: false, offerYoung: false, row: null }, row: null };
  const row: StdioRelayRow | null = r.has_row
    ? {
        startSealed: r.start_sealed,
        inNextSeq: Number(r.in_next_seq),
        inAckedTo: Number(r.in_acked_to),
        outNextSeq: Number(r.out_next_seq),
        outBufferedBytes: Number(r.out_buffered_bytes),
        closed: r.closed === true,
        ended: r.ended === true,
        leaseLive: r.lease_live === true,
      }
    : null;
  return { state: { offerPlaced: r.status === "placed", offerYoung: r.young, row: row ? { ended: row.ended, leaseLive: row.leaseLive } : null }, row };
}

/** end a session whose lease lapsed (`lease_expired`); true only for the one caller whose UPDATE moved the row */
export async function endLapsedStdioSession(db: Db, executorId: string, offerId: string): Promise<boolean> {
  const moved = rowsOf<{ offer_id: string }>(
    await db.execute(sql`
      UPDATE stdio_relay_sessions SET ended_at = now(), end_code = 'lease_expired', start_sealed = NULL, window_token = NULL, window_until = NULL
       WHERE offer_id = ${offerId} AND executor_id = ${executorId} AND ended_at IS NULL AND lease_expires_at <= now()
       RETURNING offer_id`),
  );
  if (moved.length > 0) await db.execute(sql`DELETE FROM stdio_relay_frames WHERE offer_id = ${offerId}`);
  return moved.length > 0;
}

/** one window at a time, on every replica: a token the window releases, and an expiry if its replica dies */
export async function claimStdioWindow(db: Db, executorId: string, offerId: string, windowSeconds: number): Promise<string | null> {
  const token = randomUUID();
  const r = rowsOf<{ offer_id: string }>(
    await db.execute(sql`
      UPDATE stdio_relay_sessions SET window_token = ${token}, window_until = now() + make_interval(secs => ${windowSeconds + 10})
       WHERE offer_id = ${offerId} AND executor_id = ${executorId} AND ended_at IS NULL AND (window_until IS NULL OR window_until < now())
       RETURNING offer_id`),
  );
  return r.length > 0 ? token : null;
}
export async function releaseStdioWindow(db: Db, offerId: string, token: string): Promise<void> {
  await db.execute(sql`UPDATE stdio_relay_sessions SET window_token = NULL, window_until = NULL WHERE offer_id = ${offerId} AND window_token = ${token}`);
}

/**
 * Review M6 across replicas: the executor acknowledges every stdin frame below `from`. False when `from` names frames
 * already dropped or never written (the window is refused `stdio_from_invalid`).
 */
export async function ackStdioInput(db: Db, executorId: string, offerId: string, from: number): Promise<boolean> {
  const r = rowsOf<{ offer_id: string }>(
    await db.execute(sql`
      UPDATE stdio_relay_sessions SET in_acked_to = ${from}
       WHERE offer_id = ${offerId} AND executor_id = ${executorId} AND ended_at IS NULL AND ${from} >= in_acked_to AND ${from} <= in_next_seq
       RETURNING offer_id`),
  );
  if (r.length === 0) return false;
  await db.execute(sql`DELETE FROM stdio_relay_frames WHERE offer_id = ${offerId} AND direction = 'in' AND seq < ${from}`);
  return true;
}

/** the stdin frames from `cursor` on, in order, and whether the session is closed or over */
export async function stdioInputFrom(
  db: Db,
  executorId: string,
  offerId: string,
  cursor: number,
): Promise<{ frames: Array<{ seq: number; data: string }>; closed: boolean; ended: boolean; leaseLive: boolean }> {
  const state = rowsOf<{ closed: boolean; ended: boolean; lease_live: boolean }>(
    await db.execute(sql`
      SELECT closed_at IS NOT NULL AS closed, ended_at IS NOT NULL AS ended, lease_expires_at > now() AS lease_live
        FROM stdio_relay_sessions WHERE offer_id = ${offerId} AND executor_id = ${executorId}`),
  )[0];
  if (!state) return { frames: [], closed: true, ended: true, leaseLive: false };
  const frames = rowsOf<{ seq: string; data: string }>(
    await db.execute(sql`
      SELECT f.seq, f.data FROM stdio_relay_frames f
        JOIN stdio_relay_sessions s ON s.offer_id = f.offer_id
       WHERE f.offer_id = ${offerId} AND s.executor_id = ${executorId} AND f.direction = 'in' AND f.seq >= ${cursor}
       ORDER BY f.seq LIMIT ${STDIO_POST_MAX_FRAMES}`),
  ).map((f) => ({ seq: Number(f.seq), data: f.data }));
  return { frames, closed: state.closed, ended: state.ended, leaseLive: state.lease_live };
}

export type StdioOutputAppend =
  | { kind: "ok"; nextSeq: number; closed: boolean }
  | { kind: "sequence"; expected: number }
  | { kind: "buffer_full" }
  | { kind: "gone" };

/**
 * The sandbox's stdout, from any replica: in order, never twice (the first frame must be the next one and the batch
 * contiguous; otherwise the session ends `sequence`, as on one replica). The sandbox spoke, so the sealed `start`
 * (and an engine task's secret in it) is dropped. Buffered output past 4 MiB ends the session lost (`buffer_full`).
 */
export async function appendStdioOutput(db: Db, executorId: string, offerId: string, frames: ReadonlyArray<{ seq: number; data: string }>, eof: boolean): Promise<StdioOutputAppend> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const cur = rowsOf<{ out_next_seq: string; out_buffered_bytes: number; closed: boolean; ended: boolean }>(
      await t.execute(sql`
        SELECT out_next_seq, out_buffered_bytes, closed_at IS NOT NULL AS closed, ended_at IS NOT NULL AS ended
          FROM stdio_relay_sessions WHERE offer_id = ${offerId} AND executor_id = ${executorId} FOR UPDATE`),
    )[0];
    if (!cur || cur.ended) return { kind: "gone" as const };
    const next = Number(cur.out_next_seq);
    for (const [i, f] of frames.entries()) {
      if (f.seq !== next + i) {
        await t.execute(sql`UPDATE stdio_relay_sessions SET ended_at = now(), end_code = 'sequence', start_sealed = NULL WHERE offer_id = ${offerId}`);
        await t.execute(sql`DELETE FROM stdio_relay_frames WHERE offer_id = ${offerId}`);
        return { kind: "sequence" as const, expected: next + i };
      }
    }
    const sized = frames.map((f) => ({ ...f, bytes: stdioLineBytes(f.data) }));
    const added = sized.reduce((n, f) => n + f.bytes, 0);
    if (cur.out_buffered_bytes + added > STDIO_SESSION_BUFFER_MAX_BYTES) {
      await t.execute(sql`UPDATE stdio_relay_sessions SET ended_at = now(), end_code = 'buffer_full', start_sealed = NULL WHERE offer_id = ${offerId}`);
      await t.execute(sql`DELETE FROM stdio_relay_frames WHERE offer_id = ${offerId}`);
      return { kind: "buffer_full" as const };
    }
    for (const f of sized) {
      await t.execute(sql`INSERT INTO stdio_relay_frames (offer_id, direction, seq, data, bytes) VALUES (${offerId}, 'out', ${f.seq}, ${f.data}, ${f.bytes})`);
    }
    await t.execute(sql`
      UPDATE stdio_relay_sessions
         SET out_next_seq = out_next_seq + ${frames.length}, out_buffered_bytes = out_buffered_bytes + ${added},
             start_sealed = NULL, eof_at = CASE WHEN ${eof} THEN now() ELSE eof_at END
       WHERE offer_id = ${offerId}`);
    return { kind: "ok" as const, nextSeq: next + frames.length, closed: cur.closed };
  });
}

// ---------------------------------------------------------------------------
// Holder side (the replica that placed the session)
// ---------------------------------------------------------------------------

/**
 * Write the holder's row for a session, with its lease and sealed `start` line. Only for an offer that exists, is
 * this executor's and is committed (an engine task's session is held before its transaction commits: this answers
 * false until it has). True once the row is there.
 */
export async function persistStdioSession(db: Db, s: { offerId: string; executorId: string; startSealed: string | null }): Promise<boolean> {
  const r = rowsOf<{ offer_id: string }>(
    await db.execute(sql`
      INSERT INTO stdio_relay_sessions (offer_id, executor_id, owner_replica, lease_expires_at, start_sealed)
      SELECT o.id, o.executor_id, ${STDIO_REPLICA_ID}, now() + make_interval(secs => ${STDIO_OWNER_LEASE_MS / 1000}), ${s.startSealed}
        FROM execution_offers o WHERE o.id = ${s.offerId} AND o.executor_id = ${s.executorId}
      ON CONFLICT (offer_id) DO NOTHING
      RETURNING offer_id`),
  );
  if (r.length > 0) return true;
  // already there and ours (a retried tick)
  const mine = rowsOf<{ offer_id: string }>(
    await db.execute(sql`SELECT offer_id FROM stdio_relay_sessions WHERE offer_id = ${s.offerId} AND owner_replica = ${STDIO_REPLICA_ID}`),
  );
  return mine.length > 0;
}

/** the holder's stdin frames `[from, from + frames.length)`, and the new `in_next_seq`, in one transaction */
export async function appendStdioInput(db: Db, offerId: string, from: number, frames: ReadonlyArray<{ data: string; bytes: number }>): Promise<boolean> {
  if (frames.length === 0) return true;
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const moved = rowsOf<{ offer_id: string }>(
      await t.execute(sql`
        UPDATE stdio_relay_sessions SET in_next_seq = ${from + frames.length}
         WHERE offer_id = ${offerId} AND owner_replica = ${STDIO_REPLICA_ID} AND ended_at IS NULL AND in_next_seq = ${from}
         RETURNING offer_id`),
    );
    if (moved.length === 0) return false;
    for (const [i, f] of frames.entries()) {
      await t.execute(sql`INSERT INTO stdio_relay_frames (offer_id, direction, seq, data, bytes) VALUES (${offerId}, 'in', ${from + i}, ${f.data}, ${f.bytes})`);
    }
    return true;
  });
}

export interface StdioHolderView {
  offerId: string;
  offerStatus: string;
  inAckedTo: number;
  outNextSeq: number;
  eof: boolean;
  endCode: StdioRelayEndCode | null;
}

/** the holder's rows (only its own), with each offer's status */
export async function stdioHolderView(db: Db, offerIds: readonly string[]): Promise<StdioHolderView[]> {
  if (offerIds.length === 0) return [];
  return rowsOf<{ offer_id: string; status: string; in_acked_to: string; out_next_seq: string; eof: boolean; end_code: StdioRelayEndCode | null }>(
    await db.execute(sql`
      SELECT s.offer_id, o.status, s.in_acked_to, s.out_next_seq, s.eof_at IS NOT NULL AS eof, s.end_code
        FROM stdio_relay_sessions s JOIN execution_offers o ON o.id = s.offer_id
       WHERE s.owner_replica = ${STDIO_REPLICA_ID} AND s.offer_id = ANY(${uuidArray(offerIds)})`),
  ).map((r) => ({ offerId: r.offer_id, offerStatus: r.status, inAckedTo: Number(r.in_acked_to), outNextSeq: Number(r.out_next_seq), eof: r.eof, endCode: r.end_code }));
}

/** the holder takes its stdout frames from `from` on (in order) and frees their space */
export async function takeStdioOutput(db: Db, offerId: string, from: number): Promise<Array<{ seq: number; data: string }>> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const taken = rowsOf<{ seq: string; data: string; bytes: number }>(
      await t.execute(sql`
        DELETE FROM stdio_relay_frames f USING stdio_relay_sessions s
         WHERE f.offer_id = ${offerId} AND s.offer_id = f.offer_id AND s.owner_replica = ${STDIO_REPLICA_ID}
           AND f.direction = 'out' AND f.seq >= ${from}
        RETURNING f.seq, f.data, f.bytes`),
    )
      .map((f) => ({ seq: Number(f.seq), data: f.data, bytes: Number(f.bytes) }))
      .sort((a, b) => a.seq - b.seq);
    const freed = taken.reduce((n, f) => n + f.bytes, 0);
    if (freed > 0) await t.execute(sql`UPDATE stdio_relay_sessions SET out_buffered_bytes = GREATEST(0, out_buffered_bytes - ${freed}) WHERE offer_id = ${offerId}`);
    return taken.map(({ seq, data }) => ({ seq, data }));
  });
}

/** the gateway closed the session: the next window line is `close` */
export async function markStdioClosed(db: Db, offerId: string): Promise<void> {
  await db.execute(sql`UPDATE stdio_relay_sessions SET closed_at = COALESCE(closed_at, now()) WHERE offer_id = ${offerId} AND owner_replica = ${STDIO_REPLICA_ID}`);
}

/** the holder ended the session: the row says so (kept for late windows) and its frames go */
export async function markStdioEnded(db: Db, offerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE stdio_relay_sessions SET ended_at = now(), end_code = 'ended', start_sealed = NULL, window_token = NULL, window_until = NULL
     WHERE offer_id = ${offerId} AND owner_replica = ${STDIO_REPLICA_ID} AND ended_at IS NULL`);
  await db.execute(sql`DELETE FROM stdio_relay_frames f USING stdio_relay_sessions s WHERE f.offer_id = ${offerId} AND s.offer_id = f.offer_id AND s.owner_replica = ${STDIO_REPLICA_ID}`);
}

/** renew this process's leases (one statement for every live session it holds) */
export async function renewStdioLeases(db: Db, offerIds: readonly string[]): Promise<void> {
  if (offerIds.length === 0) return;
  await db.execute(sql`
    UPDATE stdio_relay_sessions SET lease_expires_at = now() + make_interval(secs => ${STDIO_OWNER_LEASE_MS / 1000})
     WHERE owner_replica = ${STDIO_REPLICA_ID} AND ended_at IS NULL AND offer_id = ANY(${uuidArray(offerIds)})`);
}

/** retention: ended rows after 5 minutes, and any row whose lease lapsed an hour ago (frames go with them) */
export async function sweepStdioRelay(db: Db): Promise<number> {
  return rowsOf<{ offer_id: string }>(
    await db.execute(sql`
      DELETE FROM stdio_relay_sessions
       WHERE (ended_at IS NOT NULL AND ended_at < now() - make_interval(secs => ${STDIO_RELAY_ENDED_RETENTION_MS / 1000}))
          OR lease_expires_at < now() - make_interval(secs => ${STDIO_RELAY_STALE_MS / 1000})
      RETURNING offer_id`),
  ).length;
}
