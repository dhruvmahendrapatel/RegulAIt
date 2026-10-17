/**
 * ADR-0190 slice I4 — STDIO MCP OVER THE EXECUTOR'S CHANNEL, gateway side.
 *
 * A stdio MCP server runs in a sandbox an executor started (gVisor `runsc`
 * at L2), never as a child of this process (OWNER DECISION 2). This module
 * is the gateway's end of the session:
 *
 *   placeStdioSession(db, req)   decision 7 for the call (`decidePlacement`), then wait for the executor's
 *                                per-placement report to be ACCEPTED (`awaitPlacement`). Any refusal comes back
 *                                with decision 7's fixed reason; there is no fallback to anything in-process
 *   ExecutorStdioTransport       the MCP SDK `Transport` over that session (the SDK's own `serializeMessage` /
 *                                `deserializeMessage`, one JSON-RPC message per line, as its stdio transport)
 *   registerExecutorStdioRoutes  the two channel routes the executor uses for the bytes:
 *                                  GET  /v1/executor-channel/offers/:offerId/stdio?window=&from=  start, stdin, close
 *                                  POST /v1/executor-channel/offers/:offerId/stdio                stdout frames, eof
 *                                both behind the executor's one-use proof (registered inside the channel scope)
 *
 * THE WINDOW (review M4, M6). Every `start` and `stdin` line carries an
 * HMAC under the session's key (derived from the gateway's data key and the
 * offer id, handed to the executor in the report answer); the executor acts
 * on no line that fails it. stdin frames stay here until the executor
 * acknowledges them (`from` = the next sequence it expects), so a window
 * lost in transit loses nothing: the next one re-sends from `from`. One
 * window per session at a time (`stdio_window_open`).
 *
 * WHERE A SESSION LIVES. The session (its unacknowledged stdin frames and
 * its MCP client) is held in THIS gateway process, keyed by the offer id,
 * from the moment the offer is made. The executor's window and stdout POSTs
 * may reach ANY replica, so the routes serve the session from the database
 * (the frames table, `stdio-relay.ts`, migration 0204) and the holder relays
 * between the database and its session (`relayOnce`, every
 * `STDIO_RELAY_POLL_MS` and at once when this process has news). The holder
 * renews a lease on its row; a route that finds the lease lapsed ends the
 * session as LOST (`session_lost`, recorded as our own refusal, review M3).
 * The holder also watches the offer: the executor ending the offer under a
 * live session ends the call, and an offer withdrawn under it is a loss. The
 * upstream's breaker is never charged and the caller never hangs.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { delegationGrants, eq, workloadIdentities, type Db, type ExecutorRow } from "@regulait/db";
import {
  EXECUTOR_CHANNEL_PREFIX,
  EXECUTOR_STREAM_WINDOW,
  STDIO_FRAME_MAX_BYTES,
  STDIO_POST_MAX_FRAMES,
  STDIO_MAX_LIVE_SESSIONS,
  STDIO_POST_BODY_LIMIT_BYTES,
  STDIO_SESSION_BUFFER_MAX_BYTES,
  executorStdioPostSchema,
  stdioFrameMac,
  stdioLineBytes,
  stdioMacKey,
  stdioSessionSecret,
  type ExecutionRefusalReason,
  type ExecutorStdioMessage,
  type StdioWorkload,
} from "@regulait/shared";
import { awaitPlacement, cancelOffer, offerLinkedPlacement, recordSessionLost, refusedLinkedPlacement } from "./executor-channel.js";
import { decidePlacement, interactivePersonCaller, resolveRequirement, type PersonStdioRelaxationUse, type PlacementRequest } from "./execution-placement.js";
import { stdioSessionLostError, stdioSessionLostResponse } from "./stdio-session-loss.js";
import {
  STDIO_OWNER_HEARTBEAT_MS,
  STDIO_RELAY_LOST_CODES,
  STDIO_RELAY_LOST_TEXT,
  STDIO_RELAY_POLL_MS,
  ackStdioInput,
  appendStdioInput,
  appendStdioOutput,
  claimStdioWindow,
  endLapsedStdioSession,
  markStdioClosed,
  markStdioEnded,
  persistStdioSession,
  releaseStdioWindow,
  renewStdioLeases,
  stdioHolderView,
  stdioInputFrom,
  stdioRouteDecision,
  stdioRouteState,
  sweepStdioRelay,
  takeStdioOutput,
} from "./stdio-relay.js";

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export class StdioSessionError extends Error {}

// ---------------------------------------------------------------------------
// Review M4: the session MAC root
// ---------------------------------------------------------------------------

/**
 * The root every session secret is derived from: HKDF of the gateway's deploy-time data key (so every replica derives
 * the same secret for an offer), or, with no data key configured, a random per-process root (a single replica still
 * works; secure by default either way: never a fixed value).
 */
let macRoot: Buffer = randomBytes(32);
export function setStdioMacRoot(dataKey: string | undefined): void {
  if (typeof dataKey === "string" && dataKey.length >= 32) {
    macRoot = Buffer.from(hkdfSync("sha256", Buffer.from(dataKey, "utf8"), Buffer.alloc(0), "regulait/adr0190/stdio-mac-root/v1", 32));
  }
}
/** the session secret the gateway hands the executor in its answer to the accepted report */
export function stdioSecretFor(offerId: string): string {
  return stdioSessionSecret(macRoot, offerId);
}

/**
 * The `start` line as the relay stores it (it may carry an engine task's secret): AES-256-GCM under a key derived
 * from the same root (so every replica with the data key can open it, and one without cannot), with the offer id as
 * associated data (a sealed line moved to another session's row does not open). The row drops it once the sandbox
 * has spoken.
 */
function startSealKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", macRoot, Buffer.alloc(0), "regulait/adr0190/stdio-start-seal/v1", 32));
}
export function sealStdioStart(offerId: string, line: ExecutorStdioMessage): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", startSealKey(), iv);
  c.setAAD(Buffer.from(offerId, "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(line), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}
/** null when the line does not open here (another root, another offer, altered): the window is refused, fail closed */
export function openStdioStart(offerId: string, sealed: string): Extract<ExecutorStdioMessage, { type: "start" }> | null {
  try {
    const [iv, tag, ct] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    if (!iv || !tag || !ct || iv.length !== 12 || tag.length !== 16) return null;
    const d = createDecipheriv("aes-256-gcm", startSealKey(), iv);
    d.setAAD(Buffer.from(offerId, "utf8"));
    d.setAuthTag(tag);
    const line = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8")) as ExecutorStdioMessage;
    return line.type === "start" ? (line as Extract<ExecutorStdioMessage, { type: "start" }>) : null;
  } catch {
    return null;
  }
}

/** a `stdin` line, MACed under the session's key (any replica derives the same key for the offer) */
function stdinLineFor(macKey: Buffer, offerId: string, f: { seq: number; data: string }): ExecutorStdioMessage {
  return { type: "stdin", seq: f.seq, data: f.data, mac: stdioFrameMac(macKey, offerId, { type: "stdin", seq: f.seq, data: f.data }) };
}

/** one placed stdio session, held by the gateway process that placed it */
export class StdioSession {
  /** gateway → sandbox frames not yet ACKNOWLEDGED by the executor (review M6: kept until `from` passes them) */
  private readonly frames: Array<{ seq: number; data: string; bytes: number }> = [];
  private bufferedBytes = 0;
  private nextInSeq = 0;
  /** every frame below this was acknowledged and dropped */
  private ackedTo = 0;
  /** the next stdout frame the gateway expects from the executor */
  nextOutSeq = 0;
  closed = false;
  ended = false;
  /** a transport (an MCP connect) has taken this session */
  attached = false;
  /** a window of this session is open now (one at a time) */
  windowOpen = false;
  /** review M3: the session ended because the executor's side was lost (our own refusal, never the upstream's) */
  lostReason: string | null = null;
  /** review M4: the session's MAC key */
  readonly macKey: Buffer;
  private waiters: Array<() => void> = [];
  /** the transport's callbacks (set when the transport is attached) */
  onLine: ((line: string) => void) | null = null;
  onEnd: (() => void) | null = null;
  /**
   * ADR-0190 I5: an engine task's secret (the run's key), sent only in the MACed `start` line. Dropped as soon as the
   * sandbox has spoken (its first stdout POST proves the release happened) and when the session ends.
   */
  secret: string | undefined = undefined;
  /** the relay (migration 0204): the row is written; every stdin frame below `persistedTo` is in the table */
  persisted = false;
  persistedTo = 0;
  closeMarked = false;
  /** the holder watches the offer (set once the placement is accepted) */
  watched = false;
  /** the relay's work on this session runs one step at a time (stdout is delivered in order, once) */
  relayChain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly offerId: string,
    readonly executorId: string,
    readonly workload: StdioWorkload,
  ) {
    this.macKey = stdioMacKey(stdioSecretFor(offerId), offerId);
  }

  /** the `start` line, MACed */
  startLine(): ExecutorStdioMessage {
    const secret = this.secret;
    return {
      type: "start",
      workload: this.workload,
      ...(secret !== undefined ? { secret } : {}),
      mac: stdioFrameMac(this.macKey, this.offerId, { type: "start", workload: this.workload, secret }),
    };
  }

  /** a `stdin` line, MACed */
  stdinLine(f: { seq: number; data: string }): ExecutorStdioMessage {
    return stdinLineFor(this.macKey, this.offerId, f);
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** queue one line for the sandbox's stdin (refused past the buffer bound: the session fails closed) */
  push(line: string): void {
    if (this.closed || this.ended) throw new StdioSessionError("the stdio session is closed");
    const n = stdioLineBytes(line);
    if (n > STDIO_FRAME_MAX_BYTES) throw new StdioSessionError(`a message of ${n} bytes is above the ${STDIO_FRAME_MAX_BYTES}-byte frame limit`);
    if (this.bufferedBytes + n > STDIO_SESSION_BUFFER_MAX_BYTES) throw new StdioSessionError("the sandbox is not reading its input; the session buffer is full");
    this.frames.push({ seq: this.nextInSeq++, data: line, bytes: n });
    this.bufferedBytes += n;
    this.wake();
    kickRelay();
  }

  /** the relay: the stdin frames not yet written to the table, in order */
  unpersistedFrames(): Array<{ data: string; bytes: number }> {
    return this.frames.filter((f) => f.seq >= this.persistedTo).map((f) => ({ data: f.data, bytes: f.bytes }));
  }

  /** every frame below this was acknowledged */
  get ackedThrough(): number {
    return this.ackedTo;
  }

  /**
   * Review M6: the executor acknowledges every frame below `from` (the next one it expects). False when `from` names
   * frames already dropped or never sent: the window is refused (`stdio_from_invalid`).
   */
  ack(from: number): boolean {
    if (from < this.ackedTo || from > this.nextInSeq) return false;
    while (this.frames.length > 0 && this.frames[0]!.seq < from) this.bufferedBytes -= this.frames.shift()!.bytes;
    this.ackedTo = from;
    return true;
  }

  /** the frames from `cursor` on, in order (a window writes each once; the next window starts from its `from`) */
  framesFrom(cursor: number): Array<{ seq: number; data: string }> {
    return this.frames.filter((f) => f.seq >= cursor);
  }

  /** the next stdin sequence number (a window's cursor after it wrote everything) */
  get nextSeq(): number {
    return this.nextInSeq;
  }

  /** wait until there is a frame at or after `cursor`, the session closes, or `ms` passes */
  async waitForWork(ms: number, cursor: number): Promise<void> {
    if (this.nextInSeq > cursor || this.closed || this.ended) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** the gateway closed the MCP session: the next window line is `close` */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
    kickRelay();
    // the executor's next window says `close`; a session nobody collects is dropped after a grace period
    setTimeout(() => this.end(), 60_000).unref?.();
  }

  /** review M3: the executor's side was lost (the offer ended or was withdrawn under a live session): fail fast */
  lose(reason: string): void {
    if (this.ended) return;
    this.lostReason = reason;
    this.end();
  }

  /** the sandbox's side ended (eof, or the offer ended): the transport closes */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.secret = undefined;
    this.wake();
    if (stdioSessions.get(this.offerId) === this) {
      stdioSessions.delete(this.offerId);
      if (this.persisted) endingInDb.add(this.offerId);
      kickRelay();
    }
    this.onEnd?.();
  }
}

/** the sessions this process holds, by offer id */
const stdioSessions = new Map<string, StdioSession>();

/**
 * ADR-0190 I5: hold a session created elsewhere (an engine task's) under its offer id, so the stdio routes serve it
 * exactly as a stdio server's. Refused past the live-session cap (the caller then refuses the placement).
 */
export function holdStdioSession(session: StdioSession): boolean {
  if (stdioSessions.size >= STDIO_MAX_LIVE_SESSIONS || stdioSessions.has(session.offerId)) return false;
  stdioSessions.set(session.offerId, session);
  kickRelay();
  return true;
}

/** ADR-0190 I5: the holder's watchdog on a session it holds (the executor ending the offer fails it at once) */
export function watchHeldStdioSession(db: Db, session: StdioSession): void {
  watchStdioSession(db, session);
}

/**
 * The offer ended on the executor's side (its `/end`, on whichever replica it landed): a session this process holds
 * takes the output the relay still holds for it, then ends with its sandbox. A session another replica holds ends
 * there, when its relay sees the offer ended.
 */
export async function endStdioSession(db: Db, offerId: string): Promise<void> {
  useRelayDb(db);
  const s = stdioSessions.get(offerId);
  if (!s) return;
  if (s.persisted) await inSessionOrder(s, () => drainOutput(db, s)).catch(() => undefined);
  s.end();
}

/** how many stdio sessions this process holds now (a test reads it; the cap is checked against it) */
export function liveStdioSessions(): number {
  return stdioSessions.size;
}

/** tests only: drop a session from this process as if another replica held it (review M3) */
export function forgetStdioSessionForTest(offerId: string): StdioSession | null {
  const s = stdioSessions.get(offerId) ?? null;
  stdioSessions.delete(offerId);
  return s;
}

/**
 * Review M3: once its placement is accepted, the holder watches the offer. The executor ending it under a live session
 * ends the call (after the output the relay holds); an offer withdrawn, expired or gone under it is a LOSS (`lose`):
 * the call's pending request ends now instead of at its deadline, and the loss is recorded.
 */
function watchStdioSession(db: Db, session: StdioSession): void {
  useRelayDb(db);
  session.watched = true;
  kickRelay();
}

// ---------------------------------------------------------------------------
// The relay (migration 0204): this process's sessions <-> the frames table
// ---------------------------------------------------------------------------

let relayDb: Db | null = null;
let relayTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let again = false;
let lastHeartbeat = 0;
let lastSweep = 0;
const RELAY_SWEEP_MS = 60_000;
/** sessions that ended here whose row still says live */
const endingInDb = new Set<string>();
/** windows (on this replica) waiting for news of a session */
const windowWaiters = new Map<string, Set<() => void>>();

/** the database the relay works against (the latest the app or a placement gave; one per gateway in the product) */
export function useRelayDb(db: Db): void {
  relayDb = db;
  if (relayTimer === null) {
    relayTimer = setInterval(() => void runRelay(), STDIO_RELAY_POLL_MS);
    relayTimer.unref?.();
  }
}

/** this process has news (a frame pushed, a session closed or ended, output posted): relay now */
function kickRelay(): void {
  if (relayDb === null) return;
  if (ticking) {
    again = true;
    return;
  }
  setImmediate(() => void runRelay());
}

function wakeWindows(offerId: string): void {
  const w = windowWaiters.get(offerId);
  if (!w) return;
  windowWaiters.delete(offerId);
  for (const f of w) f();
}
/** a window waits for news of its session from this process, or `ms` (news from another replica is polled) */
function waitForRelay(offerId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let set = windowWaiters.get(offerId);
    if (!set) windowWaiters.set(offerId, (set = new Set()));
    const done = () => {
      clearTimeout(t);
      windowWaiters.get(offerId)?.delete(done);
      resolve();
    };
    const t = setTimeout(done, ms);
    set.add(done);
  });
}

function inSessionOrder<T>(s: StdioSession, step: () => Promise<T>): Promise<T> {
  const run = s.relayChain.then(step, step);
  s.relayChain = run.catch(() => undefined);
  return run;
}

async function runRelay(): Promise<void> {
  const db = relayDb;
  if (db === null) return;
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  try {
    do {
      again = false;
      await relayOnce(db);
    } while (again);
  } catch {
    // the next tick retries; a session whose row cannot be kept loses its lease, and the routes fail it closed
  } finally {
    ticking = false;
  }
}

/** the holder takes the output the routes stored for a session, in order, and hands it to the transport */
async function drainOutput(db: Db, s: StdioSession): Promise<void> {
  const frames = await takeStdioOutput(db, s.offerId, s.nextOutSeq);
  for (const f of frames) {
    if (f.seq !== s.nextOutSeq) {
      // never a gap (the routes keep stdout contiguous); if one appears, fail closed
      s.end();
      return;
    }
    s.nextOutSeq += 1;
    // I5: the sandbox spoke, so the release (and any task secret with it) reached it: the gateway forgets the secret
    s.secret = undefined;
    if (!s.closed) s.onLine?.(f.data);
  }
}

const LIVE_OFFER = new Set(["placed", "offered", "accepted"]);

async function relayOnce(db: Db): Promise<void> {
  // 1. the rows of sessions that ended here
  for (const offerId of [...endingInDb]) {
    await markStdioEnded(db, offerId);
    endingInDb.delete(offerId);
    wakeWindows(offerId);
  }
  // 2. new sessions get their row; pushed stdin and a local close reach the table
  const held = [...stdioSessions.values()];
  for (const s of held) {
    if (s.ended) continue;
    if (!s.persisted) {
      s.persisted = await persistStdioSession(db, { offerId: s.offerId, executorId: s.executorId, startSealed: sealStdioStart(s.offerId, s.startLine()) });
      if (!s.persisted) continue;
      // it ended while its row was being written: the row says so at once (no lease is left to lapse into a "loss")
      if (s.ended) {
        await markStdioEnded(db, s.offerId);
        continue;
      }
    }
    const pending = s.unpersistedFrames();
    if (pending.length > 0 && (await appendStdioInput(db, s.offerId, s.persistedTo, pending))) {
      s.persistedTo += pending.length;
      wakeWindows(s.offerId);
    }
    if (s.closed && !s.closeMarked) {
      await markStdioClosed(db, s.offerId);
      s.closeMarked = true;
      wakeWindows(s.offerId);
    }
  }
  // 3. what the routes did: acknowledgements, output, ends, and the offer under each watched session
  const persisted = held.filter((s) => s.persisted && !s.ended);
  const views = await stdioHolderView(db, persisted.map((s) => s.offerId));
  const seen = new Set<string>();
  for (const v of views) {
    seen.add(v.offerId);
    const s = stdioSessions.get(v.offerId);
    if (!s || s.ended) continue;
    if (v.inAckedTo > s.ackedThrough) s.ack(v.inAckedTo);
    if (v.outNextSeq > s.nextOutSeq) await inSessionOrder(s, () => drainOutput(db, s));
    if (s.ended) continue;
    if (v.endCode !== null) {
      if (STDIO_RELAY_LOST_CODES.has(v.endCode)) s.lose(STDIO_RELAY_LOST_TEXT[v.endCode as "lease_expired" | "buffer_full"]);
      else s.end();
      continue;
    }
    const drained = s.nextOutSeq >= v.outNextSeq;
    if (v.eof && drained) {
      s.end();
      continue;
    }
    // the executor ended its offer (its `/end`, on any replica): the session ends with it, once its output is in
    if (v.offerStatus === "ended") {
      if (drained) s.end();
      continue;
    }
    if (!s.watched || LIVE_OFFER.has(v.offerStatus)) continue;
    if (s.closed) {
      // a session the gateway itself closed is ending normally: its offer going away is the expected answer
      s.end();
    } else {
      const why = `the executor's side of the session ended (offer ${v.offerStatus}) while the call still held it`;
      s.lose(why);
      await recordSessionLost(db, s.offerId, { executorId: s.executorId, where: "holder", why }).catch(() => undefined);
    }
  }
  // a row that is gone (swept after its lease lapsed): the session is lost
  for (const s of persisted) {
    if (!seen.has(s.offerId) && !s.ended) s.lose(STDIO_RELAY_LOST_TEXT.lease_expired);
  }
  // 4. the leases, and retention
  const now = Date.now();
  if (now - lastHeartbeat >= STDIO_OWNER_HEARTBEAT_MS) {
    lastHeartbeat = now;
    await renewStdioLeases(
      db,
      [...stdioSessions.values()].filter((s) => s.persisted && !s.ended).map((s) => s.offerId),
    );
  }
  if (now - lastSweep >= RELAY_SWEEP_MS) {
    lastSweep = now;
    await sweepStdioRelay(db);
  }
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * The MCP SDK transport over a placed session. Messages are serialised with
 * the SDK's own stdio functions, so the bytes the sandboxed server sees are
 * exactly those its stdio transport expects.
 */
export class ExecutorStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private closedOnce = false;
  /** review M3: the ids of the requests sent and not yet answered (answered by the gateway itself if the session is lost) */
  private readonly pending = new Set<string | number>();

  constructor(private readonly session: StdioSession) {
    session.attached = true;
    session.onLine = (line) => {
      // a blank line is not a JSON-RPC message: skipped, never fatal (review low)
      if (line.trim() === "") return;
      let msg: JSONRPCMessage;
      try {
        msg = deserializeMessage(line);
      } catch (e) {
        this.onerror?.(e as Error);
        return;
      }
      if ("id" in msg && !("method" in msg)) this.pending.delete(msg.id as string | number);
      this.onmessage?.(msg);
    };
    session.onEnd = () => {
      if (session.lostReason !== null) {
        // our own refusal: every pending request fails now, recognisably (never charged to the server's breaker)
        for (const id of [...this.pending]) this.onmessage?.(stdioSessionLostResponse(id, session.lostReason));
        this.pending.clear();
      }
      this.fireClose();
    };
  }

  private fireClose() {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.onclose?.();
  }

  async start(): Promise<void> {
    if (this.session.ended || this.session.closed) throw new StdioSessionError("the stdio session has already ended");
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.session.lostReason !== null) throw stdioSessionLostError(this.session.lostReason);
    // serializeMessage appends the newline; a frame is the line without it
    this.session.push(serializeMessage(message).replace(/\n$/, ""));
    if ("method" in message && "id" in message) this.pending.add(message.id as string | number);
  }

  async close(): Promise<void> {
    this.session.close();
    this.fireClose();
  }
}

// ---------------------------------------------------------------------------
// Placement for one stdio connect
// ---------------------------------------------------------------------------

export interface StdioPlacementInput {
  /** who the call runs for, the project it is attributed to, the agent and grant (decision 7's inputs) */
  userId: string | null;
  projectId: string | null;
  agent: PlacementRequest["agent"];
  parentGrantId?: string | null;
  /** owner decision C: an interactive person's own call (`interactivePersonCaller`); absent = not interactive */
  interactivePerson?: boolean;
  mcpServerId: string;
  imageDigest: string;
  workload: StdioWorkload;
  /** how long to wait for the executor's report to be accepted (default the offer TTLs) */
  timeoutMs?: number;
}

/**
 * The decision 7 inputs of a governed MCP call: the person, the project, and
 * — on a delegated call — the grant and the agent that is its actor (read
 * from the grant's actor identity, never from the request). A call with no
 * grant names no agent: decision 7 item 5 then places it as an unknown agent.
 *
 * Owner decision C: `principal` is the request's SERVER-DERIVED session facts (`abacPrincipalFromRequest`). Only a
 * person's interactive session with no grant is `interactivePerson`; a caller that supplies none (a worker loop,
 * a builder agent) never is.
 */
export async function stdioPlacementContext(
  db: Db,
  call: { userId: string; projectId: string | null; delegationGrantId?: string | null; principal?: { sessionOrigin?: string | null } | null },
): Promise<Pick<StdioPlacementInput, "userId" | "projectId" | "agent" | "parentGrantId" | "interactivePerson">> {
  let agent: PlacementRequest["agent"] = null;
  if (call.delegationGrantId) {
    const [g] = await db
      .select({ agentId: workloadIdentities.agentId, builderAgentId: workloadIdentities.builderAgentId })
      .from(delegationGrants)
      .innerJoin(workloadIdentities, eq(workloadIdentities.id, delegationGrants.actorIdentityId))
      .where(eq(delegationGrants.id, call.delegationGrantId));
    if (g?.agentId) agent = { kind: "agent", id: g.agentId };
    else if (g?.builderAgentId) agent = { kind: "builder_agent", id: g.builderAgentId };
  }
  return {
    userId: call.userId,
    projectId: call.projectId,
    agent,
    parentGrantId: call.delegationGrantId ?? null,
    interactivePerson: agent === null && interactivePersonCaller(call.principal, call.delegationGrantId),
  };
}

/** I4 (review lows): the session failures that are not decision 7 refusals, each with its own label (never no_executor) */
export type StdioSessionFailure = "placement_timeout" | "session_lost";
export type StdioPlacement =
  | { kind: "placed"; session: StdioSession; placementId: string; executorId: string }
  | { kind: "refused"; reason: ExecutionRefusalReason | "execution_profile_mismatch" | StdioSessionFailure; placementId: string | null };

/**
 * Tests only: restrict stdio placements to these executors (the broker's
 * `onlyExecutorIds` affinity). Every gateway test file shares one database,
 * so executors other files registered would otherwise be eligible. Null (the
 * default, and always in the product) = every executor.
 */
let testAffinity: readonly string[] | null = null;
export function setStdioPlacementAffinityForTest(ids: readonly string[] | null): void {
  testAffinity = ids;
}

/**
 * THE UNLINKED PLACEMENT (review M1). Decision 7 for one stdio connect that no governed decision placed, then the
 * executor's accepted report. Its only caller is the PRE-DECISION MANIFEST SYNC (a tools/call for a tool the
 * gateway has not seen yet, and a tools/list that needs the manifest: mcp-proxy.ts), which reads the manifest
 * before any tool decision exists. Its placement row is keyed to its OWN `execution-placement` audit row (written by
 * the broker), not to a decision: it is NOT governed decision evidence and is explicitly OUTSIDE the I4/I8 contract
 * (no decision's facts name it, and no decision BOM shows it). Governed tools/call and protocol methods never come
 * here: they place inside their decision's transaction (`placeGovernedStdio`) and attach to that session.
 *
 * The session is registered under the offer id BEFORE the executor can report, so its stdio window finds it as soon
 * as the report is accepted. On any refusal the session is removed and nothing reached the server.
 */
export async function placeStdioSession(db: Db, input: StdioPlacementInput): Promise<StdioPlacement> {
  if (stdioSessions.size >= STDIO_MAX_LIVE_SESSIONS) return { kind: "refused", reason: "no_executor", placementId: null };
  const decision = await decidePlacement(db, {
    ...(testAffinity ? { onlyExecutorIds: testAffinity } : {}),
    workloadKind: "mcp_stdio",
    projectId: input.projectId,
    agent: input.agent,
    mcpServerId: input.mcpServerId,
    parentGrantId: input.parentGrantId ?? null,
    interactivePerson: input.interactivePerson === true,
    imageDigest: input.imageDigest,
    actorUserId: input.userId,
  });
  if (decision.kind === "not_isolable") return { kind: "refused", reason: "policy_unresolved", placementId: null };
  if (decision.kind === "refused") return { kind: "refused", reason: decision.code, placementId: decision.placementId };
  const session = new StdioSession(decision.offerId, decision.executorId, input.workload);
  stdioSessions.set(decision.offerId, session);
  session.attached = true;
  useRelayDb(db);
  kickRelay();
  const placed = await awaitPlacement(db, decision.offerId, input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {});
  if (placed.kind !== "placed") {
    session.end();
    // review low: a timeout withdraws the offer (a sandbox already started is told to close) and is labelled as such
    if (placed.code === "placement_timeout") await cancelOffer(db, decision.offerId, "placement_timeout", { userId: input.userId });
    return { kind: "refused", reason: placed.code, placementId: placed.placementId };
  }
  watchStdioSession(db, session);
  return { kind: "placed", session, placementId: placed.placementId, executorId: placed.executorId };
}

// ---------------------------------------------------------------------------
// I4 with the I8 contract: the placement of a GOVERNED stdio tool call
// ---------------------------------------------------------------------------

/** how long a decision-time session waits for its call to connect before it is abandoned (closed, offer withdrawn) */
export const LINKED_SESSION_ATTACH_MS = 60_000;

/** owner decision C: each outcome names the relaxation its requirement relied on (null = none), for the decision row */
export type GovernedStdioPlacement =
  | { kind: "offered"; placementId: string; offerId: string; executorId: string; relaxation: PersonStdioRelaxationUse | null }
  | { kind: "refused"; code: ExecutionRefusalReason; placementId: string | null; relaxation: PersonStdioRelaxationUse | null };

/**
 * Decision 7 for one governed `tools/call` on a stdio server, INSIDE the transaction that writes the call's
 * decision audit row and BEFORE that row (so the decision's facts read it, ADR-0189 B2 / ADR-0190 I8). The
 * placement row is keyed to the decision's audit id; an `offered` one names the chosen executor, its attestation,
 * the image and the runtime flags hash, and the offer is made in the same transaction. A refusal here makes the
 * decision itself the refusal (rule id `execution-profile`).
 */
export async function placeGovernedStdio(
  tx: Db,
  decisionAuditId: string,
  call: Pick<StdioPlacementInput, "userId" | "projectId" | "agent" | "parentGrantId" | "interactivePerson" | "mcpServerId" | "imageDigest">,
): Promise<GovernedStdioPlacement> {
  const requirement = await resolveRequirement(tx, {
    workloadKind: "mcp_stdio",
    projectId: call.projectId,
    agent: call.agent,
    mcpServerId: call.mcpServerId,
    parentGrantId: call.parentGrantId ?? null,
    interactivePerson: call.interactivePerson === true,
  });
  if (requirement.kind !== "required") {
    // review M2: a refused row keyed to the decision even here; its requirement columns are NULL (nothing resolved)
    const placementId = await refusedLinkedPlacement(tx, decisionAuditId, { workloadKind: "mcp_stdio", imageDigest: call.imageDigest }, "policy_unresolved");
    return { kind: "refused", code: "policy_unresolved", placementId, relaxation: null };
  }
  const relaxation = requirement.relaxation;
  if (stdioSessions.size >= STDIO_MAX_LIVE_SESSIONS) {
    // review low: this process holds as many live sessions as it may; no executor can be given another one from here
    const placementId = await refusedLinkedPlacement(
      tx,
      decisionAuditId,
      { workloadKind: requirement.workloadKind, requiredClass: requirement.requiredClass, requiredBy: requirement.requiredBy, profileDigest: requirement.profile.digest, imageDigest: call.imageDigest },
      "no_executor",
    );
    return { kind: "refused", code: "no_executor", placementId, relaxation };
  }
  const out = await offerLinkedPlacement(tx, decisionAuditId, {
    workloadKind: requirement.workloadKind,
    requiredClass: requirement.requiredClass,
    requiredBy: requirement.requiredBy,
    profileDigest: requirement.profile.digest,
    imageDigest: call.imageDigest,
    ...(testAffinity ? { onlyExecutorIds: testAffinity } : {}),
  });
  return out.kind === "offered"
    ? { kind: "offered", placementId: out.placementId, offerId: out.offerId, executorId: out.executorId, relaxation }
    : { kind: "refused", code: out.code, placementId: out.placementId, relaxation };
}

/**
 * Right after the decision commits: hold the session for the offer, so the executor's stdio window finds it the
 * moment its report is accepted. A session nobody connects to within `LINKED_SESSION_ATTACH_MS` (a later gate
 * refused the call) is closed: its sandbox, if one started, is never given a workload.
 */
export function registerLinkedStdioSession(db: Db, placed: { offerId: string; executorId: string }, workload: StdioWorkload, userId: string | null): StdioSession {
  const session = new StdioSession(placed.offerId, placed.executorId, workload);
  stdioSessions.set(placed.offerId, session);
  useRelayDb(db);
  kickRelay();
  const timer = setTimeout(() => {
    if (session.attached || session.ended) return;
    // nothing connected: the offer is withdrawn (`cancelled`, session_abandoned) and the executor's next window says
    // only `close`, so a sandbox already started gets no workload and stops
    session.close();
    void cancelOffer(db, placed.offerId, "session_abandoned", { userId }).catch(() => undefined);
  }, LINKED_SESSION_ATTACH_MS);
  timer.unref?.();
  return session;
}

/**
 * Review low: a governed call whose decision offered a placement and that a LATER gate refused (an approval, a
 * budget, a policy re-check: anything after the decision that returned before the connect). The offer is withdrawn
 * and its evidence says `cancelled` (later_gate), never `placed`: the sandbox, if one started, gets no workload.
 */
export async function cancelUnattachedStdioSession(db: Db, session: StdioSession, userId: string | null): Promise<void> {
  // a connect took the session: the call ran (or failed at its connect, which records its own outcome)
  if (session.attached) return;
  session.close();
  session.end();
  await cancelOffer(db, session.offerId, "later_gate", { userId });
}

/** the connect of a governed call whose decision placed it: wait for the executor's accepted report */
export async function attachLinkedStdioSession(db: Db, offerId: string, timeoutMs: number, userId: string | null = null): Promise<StdioPlacement> {
  const session = stdioSessions.get(offerId);
  if (!session || session.closed || session.ended) return { kind: "refused", reason: "session_lost", placementId: null };
  session.attached = true;
  const placed = await awaitPlacement(db, offerId, { timeoutMs });
  if (placed.kind !== "placed") {
    session.end();
    if (placed.code === "placement_timeout") await cancelOffer(db, offerId, "placement_timeout", { userId });
    return { kind: "refused", reason: placed.code, placementId: placed.placementId };
  }
  watchStdioSession(db, session);
  return { kind: "placed", session, placementId: placed.placementId, executorId: placed.executorId };
}

// ---------------------------------------------------------------------------
// The channel routes
// ---------------------------------------------------------------------------

export interface StdioRouteDeps {
  /** the channel's authentication (the executor's one-use proof), as the other channel routes use it */
  authed: (req: FastifyRequest, reply: FastifyReply) => Promise<ExecutorRow | null>;
  refused: (reply: FastifyReply, status: number, code: string, executor: ExecutorRow | null, extra?: Record<string, unknown>) => FastifyReply;
  /** the raw body (kept as a string for the proof's body hash) */
  jsonOf: (req: FastifyRequest) => unknown;
  keepaliveMs: number;
}

interface RouteScope {
  get(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): unknown;
  post(path: string, opts: { bodyLimit: number }, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): unknown;
}

const offerParam = z.object({ offerId: z.string().uuid() });

export function registerExecutorStdioRoutes(scope: RouteScope, db: Db, deps: StdioRouteDeps): void {
  useRelayDb(db);

  /** the one routing rule (`stdioRouteDecision`); a refusal is answered here, a loss recorded first */
  async function route(reply: FastifyReply, executor: ExecutorRow, offerId: string, where: "window" | "stdout") {
    const { state, row } = await stdioRouteState(db, executor.id, offerId);
    const d = stdioRouteDecision(state, where === "window");
    if (d.kind === "serve") return { row: row! };
    if (d.endLease && !(await endLapsedStdioSession(db, executor.id, offerId))) {
      // another replica ended it first (and recorded it): the session is over
      return { refusal: deps.refused(reply, 409, "session_lost", executor) };
    }
    if (d.record) {
      const why = d.endLease
        ? `the gateway replica holding the session stopped renewing it (a ${where === "window" ? "stdio window" : "stdout POST"} found its lease lapsed)`
        : `no gateway replica holds the session (a ${where === "window" ? "stdio window" : "stdout POST"} found no row for its placed offer)`;
      await recordSessionLost(db, offerId, { executorId: executor.id, where, why }).catch(() => undefined);
    }
    return { refusal: deps.refused(reply, 409, d.code, executor) };
  }

  // ---- gateway → sandbox: one window of start, stdin frames, close ------------------------------------------------
  scope.get(`${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/stdio`, async (req, reply) => {
    const executor = await deps.authed(req, reply);
    if (!executor) return reply;
    const p = offerParam.safeParse(req.params);
    if (!p.success) return deps.refused(reply, 400, "invalid_offer", executor);
    const q = z
      .object({
        window: z.coerce.number().int().min(EXECUTOR_STREAM_WINDOW.min).max(EXECUTOR_STREAM_WINDOW.max).default(EXECUTOR_STREAM_WINDOW.default),
        // review M6: the next stdin sequence the executor expects (acknowledges every frame before it)
        from: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return deps.refused(reply, 400, "invalid_window", executor);
    const offerId = p.data.offerId;
    const r = await route(reply, executor, offerId, "window");
    if ("refusal" in r) return r.refusal;
    // the start line, opened before anything is claimed: one that does not open here is never sent (fail closed)
    let start: ExecutorStdioMessage | null = null;
    if (!r.row.closed && r.row.startSealed !== null) {
      start = openStdioStart(offerId, r.row.startSealed);
      if (start === null) return deps.refused(reply, 409, "stdio_unkeyed", executor);
    }
    const token = await claimStdioWindow(db, executor.id, offerId, q.data.window);
    if (token === null) return deps.refused(reply, 409, "stdio_window_open", executor);
    if (!(await ackStdioInput(db, executor.id, offerId, q.data.from))) {
      await releaseStdioWindow(db, offerId, token);
      return deps.refused(reply, 409, "stdio_from_invalid", executor);
    }
    const macKey = stdioMacKey(stdioSecretFor(offerId), offerId);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", connection: "keep-alive" });
    const write = (m: ExecutorStdioMessage) => reply.raw.write(`${JSON.stringify(m)}\n`);
    let gone = false;
    req.raw.on("close", () => (gone = true));
    const end = Date.now() + q.data.window * 1000;
    let lastKeepalive = Date.now();
    let cursor = q.data.from;
    let lost = false;
    try {
      // a session closed before anything used it gives the sandbox no workload: `close` only. A sandbox that already
      // spoke had its start (the row dropped it): none is sent again
      if (start !== null) write(start);
      while (!gone && Date.now() < end) {
        const st = await stdioInputFrom(db, executor.id, offerId, cursor);
        for (const f of st.frames) {
          write(stdinLineFor(macKey, offerId, f));
          cursor = f.seq + 1;
        }
        if (st.frames.length === STDIO_POST_MAX_FRAMES) continue;
        if (st.closed || st.ended) {
          write({ type: "close" });
          break;
        }
        if (!st.leaseLive) {
          // the holder is gone: the session is lost, and the executor's next window is told it is over
          lost = await endLapsedStdioSession(db, executor.id, offerId);
          break;
        }
        if (Date.now() - lastKeepalive >= deps.keepaliveMs) {
          lastKeepalive = Date.now();
          write({ type: "keepalive" });
        }
        await waitForRelay(offerId, Math.max(1, Math.min(STDIO_RELAY_POLL_MS, deps.keepaliveMs, end - Date.now())));
      }
      if (!gone && !lost && Date.now() >= end) write({ type: "bye", reason: "window" });
    } finally {
      await releaseStdioWindow(db, offerId, token).catch(() => undefined);
      reply.raw.end();
    }
    if (lost) {
      await recordSessionLost(db, offerId, { executorId: executor.id, where: "window", why: "the gateway replica holding the session stopped renewing it (an open stdio window found its lease lapsed)" }).catch(() => undefined);
    }
    return reply;
  });

  // ---- sandbox → gateway: stdout frames, eof ------------------------------------------------------------------------
  scope.post(`${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/stdio`, { bodyLimit: STDIO_POST_BODY_LIMIT_BYTES }, async (req, reply) => {
    const executor = await deps.authed(req, reply);
    if (!executor) return reply;
    const p = offerParam.safeParse(req.params);
    if (!p.success) return deps.refused(reply, 400, "invalid_offer", executor);
    const body = executorStdioPostSchema.safeParse(deps.jsonOf(req));
    if (!body.success) return deps.refused(reply, 400, "invalid_body", executor);
    const offerId = p.data.offerId;
    const r = await route(reply, executor, offerId, "stdout");
    if ("refusal" in r) return r.refusal;
    // in order, never twice: the first frame must be the next one, and the batch contiguous (on every replica)
    const out = await appendStdioOutput(db, executor.id, offerId, body.data.frames, body.data.eof === true);
    // this replica's holder (if it is this one) takes the output now; another replica's polls for it
    if (stdioSessions.has(offerId)) kickRelay();
    wakeWindows(offerId);
    if (out.kind === "sequence") return deps.refused(reply, 409, "stdio_sequence", executor, { expected: out.expected });
    if (out.kind === "gone") return deps.refused(reply, 409, "offer_unavailable", executor);
    if (out.kind === "buffer_full") {
      await recordSessionLost(db, offerId, { executorId: executor.id, where: "stdout", why: "the gateway replica holding the session stopped taking its output (4 MiB buffered)" }).catch(() => undefined);
      return deps.refused(reply, 409, "session_lost", executor);
    }
    return reply.status(200).send({ nextSeq: out.nextSeq, closed: out.closed });
  });
}
