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
 * from the moment the offer is made. An executor request for a session this
 * process does not hold is refused `stdio_session_unknown` and RECORDED as
 * our own refusal (review M3: an `execution-session-lost` audit row and,
 * for a governed placement, a `session_lost` report row). The process that
 * holds the session notices the executor ending the offer (a watchdog on
 * the offer's status) and fails the call at once, as our own refusal: the
 * upstream's breaker is never charged and the caller never hangs. A
 * multi-replica gateway therefore needs the stdio routes to reach the
 * replica that placed the call (sticky routing on the offer id), or a
 * shared frames table; both are follow-ups in ADR-0190 "As built: slice I4".
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { and, delegationGrants, eq, executionOffers, workloadIdentities, type Db, type ExecutorRow } from "@regulait/db";
import {
  EXECUTOR_CHANNEL_PREFIX,
  EXECUTOR_STREAM_WINDOW,
  STDIO_FRAME_MAX_BYTES,
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
import { decidePlacement, resolveRequirement, type PlacementRequest } from "./execution-placement.js";
import { stdioSessionLostError, stdioSessionLostResponse } from "./stdio-session-loss.js";

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

  constructor(
    readonly offerId: string,
    readonly executorId: string,
    readonly workload: StdioWorkload,
  ) {
    this.macKey = stdioMacKey(stdioSecretFor(offerId), offerId);
  }

  /** the `start` line, MACed */
  startLine(): ExecutorStdioMessage {
    return { type: "start", workload: this.workload, mac: stdioFrameMac(this.macKey, this.offerId, { type: "start", workload: this.workload }) };
  }

  /** a `stdin` line, MACed */
  stdinLine(f: { seq: number; data: string }): ExecutorStdioMessage {
    return { type: "stdin", seq: f.seq, data: f.data, mac: stdioFrameMac(this.macKey, this.offerId, { type: "stdin", seq: f.seq, data: f.data }) };
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
    this.wake();
    stdioSessions.delete(this.offerId);
    rememberEnded(this.offerId);
    this.onEnd?.();
  }
}

/** the sessions this process holds, by offer id */
const stdioSessions = new Map<string, StdioSession>();

/**
 * Sessions that ended HERE recently: a late window or POST for one of them is answered `offer_unavailable` (the
 * session is over), not recorded as a lost session. Bounded (oldest dropped) and forgotten after five minutes.
 */
const endedHere = new Map<string, number>();
const ENDED_MEMORY_MS = 5 * 60_000;
function rememberEnded(offerId: string): void {
  endedHere.set(offerId, Date.now());
  if (endedHere.size > 4 * STDIO_MAX_LIVE_SESSIONS) endedHere.delete(endedHere.keys().next().value!);
}
function endedRecently(offerId: string): boolean {
  const at = endedHere.get(offerId);
  if (at === undefined) return false;
  if (Date.now() - at > ENDED_MEMORY_MS) {
    endedHere.delete(offerId);
    return false;
  }
  return true;
}

/** the offer ended on the executor's side (its `/end`): a session this process holds ends with it */
export function endStdioSession(offerId: string): void {
  stdioSessions.get(offerId)?.end();
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
 * Review M3: a session whose offer the executor ended (or the gateway withdrew) while the session is still live here
 * lost its executor side, typically because a window or the eof reached another replica. The session then fails at
 * once (`lose`), so the call's pending request ends now instead of at its deadline, and the loss is recorded.
 */
export const STDIO_WATCHDOG_MS = 1_000;
function watchStdioSession(db: Db, session: StdioSession): void {
  const timer = setInterval(() => {
    if (session.ended) {
      clearInterval(timer);
      return;
    }
    // a session the gateway itself closed is ending normally: the executor ending its offer is the expected answer
    if (session.closed) return;
    void (async () => {
      const [o] = await db.select({ status: executionOffers.status }).from(executionOffers).where(eq(executionOffers.id, session.offerId));
      if (session.ended || session.closed) return;
      if (!o || (o.status !== "placed" && o.status !== "offered" && o.status !== "accepted")) {
        const why = `the executor's side of the session ended (offer ${o?.status ?? "gone"}) while the call still held it`;
        session.lose(why);
        clearInterval(timer);
        await recordSessionLost(db, session.offerId, { executorId: session.executorId, where: "holder", why }).catch(() => undefined);
      }
    })().catch(() => undefined);
  }, STDIO_WATCHDOG_MS);
  timer.unref?.();
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
 */
export async function stdioPlacementContext(
  db: Db,
  call: { userId: string; projectId: string | null; delegationGrantId?: string | null },
): Promise<Pick<StdioPlacementInput, "userId" | "projectId" | "agent" | "parentGrantId">> {
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
  return { userId: call.userId, projectId: call.projectId, agent, parentGrantId: call.delegationGrantId ?? null };
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
    imageDigest: input.imageDigest,
    actorUserId: input.userId,
  });
  if (decision.kind === "not_isolable") return { kind: "refused", reason: "policy_unresolved", placementId: null };
  if (decision.kind === "refused") return { kind: "refused", reason: decision.code, placementId: decision.placementId };
  const session = new StdioSession(decision.offerId, decision.executorId, input.workload);
  stdioSessions.set(decision.offerId, session);
  session.attached = true;
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

export type GovernedStdioPlacement =
  | { kind: "offered"; placementId: string; offerId: string; executorId: string }
  | { kind: "refused"; code: ExecutionRefusalReason; placementId: string | null };

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
  call: Pick<StdioPlacementInput, "userId" | "projectId" | "agent" | "parentGrantId" | "mcpServerId" | "imageDigest">,
): Promise<GovernedStdioPlacement> {
  const requirement = await resolveRequirement(tx, {
    workloadKind: "mcp_stdio",
    projectId: call.projectId,
    agent: call.agent,
    mcpServerId: call.mcpServerId,
    parentGrantId: call.parentGrantId ?? null,
  });
  if (requirement.kind !== "required") {
    // review M2: a refused row keyed to the decision even here; its requirement columns are NULL (nothing resolved)
    const placementId = await refusedLinkedPlacement(tx, decisionAuditId, { workloadKind: "mcp_stdio", imageDigest: call.imageDigest }, "policy_unresolved");
    return { kind: "refused", code: "policy_unresolved", placementId };
  }
  if (stdioSessions.size >= STDIO_MAX_LIVE_SESSIONS) {
    // review low: this process holds as many live sessions as it may; no executor can be given another one from here
    const placementId = await refusedLinkedPlacement(
      tx,
      decisionAuditId,
      { workloadKind: requirement.workloadKind, requiredClass: requirement.requiredClass, requiredBy: requirement.requiredBy, profileDigest: requirement.profile.digest, imageDigest: call.imageDigest },
      "no_executor",
    );
    return { kind: "refused", code: "no_executor", placementId };
  }
  const out = await offerLinkedPlacement(tx, decisionAuditId, {
    workloadKind: requirement.workloadKind,
    requiredClass: requirement.requiredClass,
    requiredBy: requirement.requiredBy,
    profileDigest: requirement.profile.digest,
    imageDigest: call.imageDigest,
    ...(testAffinity ? { onlyExecutorIds: testAffinity } : {}),
  });
  return out.kind === "offered" ? { kind: "offered", placementId: out.placementId, offerId: out.offerId, executorId: out.executorId } : out;
}

/**
 * Right after the decision commits: hold the session for the offer, so the executor's stdio window finds it the
 * moment its report is accepted. A session nobody connects to within `LINKED_SESSION_ATTACH_MS` (a later gate
 * refused the call) is closed: its sandbox, if one started, is never given a workload.
 */
export function registerLinkedStdioSession(db: Db, placed: { offerId: string; executorId: string }, workload: StdioWorkload, userId: string | null): StdioSession {
  const session = new StdioSession(placed.offerId, placed.executorId, workload);
  stdioSessions.set(placed.offerId, session);
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

/** the offer is this executor's and placed (its report was accepted): only then do bytes flow */
async function placedOfferOf(db: Db, executorId: string, offerId: string): Promise<boolean> {
  const [o] = await db
    .select({ status: executionOffers.status })
    .from(executionOffers)
    .where(and(eq(executionOffers.id, offerId), eq(executionOffers.executorId, executorId)));
  return o?.status === "placed";
}

export function registerExecutorStdioRoutes(scope: RouteScope, db: Db, deps: StdioRouteDeps): void {
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
    if (!(await placedOfferOf(db, executor.id, p.data.offerId))) return deps.refused(reply, 409, "offer_unavailable", executor);
    const session = stdioSessions.get(p.data.offerId);
    if (!session && endedRecently(p.data.offerId)) return deps.refused(reply, 409, "offer_unavailable", executor);
    if (!session || session.executorId !== executor.id) {
      // review M3: our own refusal, recorded (the process that holds the session, if any, fails its call at once)
      await recordSessionLost(db, p.data.offerId, { executorId: executor.id, where: "window", why: "a stdio window reached a gateway process that does not hold the session" }).catch(() => undefined);
      return deps.refused(reply, 409, "stdio_session_unknown", executor);
    }
    if (session.windowOpen) return deps.refused(reply, 409, "stdio_window_open", executor);
    if (!session.ack(q.data.from)) return deps.refused(reply, 409, "stdio_from_invalid", executor);
    session.windowOpen = true;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", connection: "keep-alive" });
    const write = (m: ExecutorStdioMessage) => reply.raw.write(`${JSON.stringify(m)}\n`);
    let gone = false;
    req.raw.on("close", () => (gone = true));
    const end = Date.now() + q.data.window * 1000;
    let lastKeepalive = Date.now();
    let cursor = q.data.from;
    try {
      // a session closed before anything used it gives the sandbox no workload: `close` only
      if (!session.closed) write(session.startLine());
      while (!gone && Date.now() < end) {
        for (const f of session.framesFrom(cursor)) {
          write(session.stdinLine(f));
          cursor = f.seq + 1;
        }
        if (session.closed || session.ended) {
          write({ type: "close" });
          break;
        }
        if (Date.now() - lastKeepalive >= deps.keepaliveMs) {
          lastKeepalive = Date.now();
          write({ type: "keepalive" });
        }
        await session.waitForWork(Math.max(1, Math.min(deps.keepaliveMs, end - Date.now())), cursor);
      }
      if (!gone && !session.closed && !session.ended) write({ type: "bye", reason: "window" });
    } finally {
      session.windowOpen = false;
      reply.raw.end();
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
    if (!(await placedOfferOf(db, executor.id, p.data.offerId))) return deps.refused(reply, 409, "offer_unavailable", executor);
    const session = stdioSessions.get(p.data.offerId);
    if (!session && endedRecently(p.data.offerId)) return deps.refused(reply, 409, "offer_unavailable", executor);
    if (!session || session.executorId !== executor.id) {
      await recordSessionLost(db, p.data.offerId, { executorId: executor.id, where: "stdout", why: "stdout reached a gateway process that does not hold the session" }).catch(() => undefined);
      return deps.refused(reply, 409, "stdio_session_unknown", executor);
    }
    // in order, never twice: the first frame must be the next one, and the batch contiguous
    for (const [i, f] of body.data.frames.entries()) {
      if (f.seq !== session.nextOutSeq + i) {
        session.end();
        return deps.refused(reply, 409, "stdio_sequence", executor, { expected: session.nextOutSeq + i });
      }
    }
    for (const f of body.data.frames) {
      session.nextOutSeq += 1;
      if (!session.closed) session.onLine?.(f.data);
    }
    if (body.data.eof) session.end();
    return reply.status(200).send({ nextSeq: session.nextOutSeq, closed: session.closed || session.ended });
  });
}
