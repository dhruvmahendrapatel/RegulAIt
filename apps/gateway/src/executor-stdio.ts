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
 *                                  GET  /v1/executor-channel/offers/:offerId/stdio?window=  start, stdin, close
 *                                  POST /v1/executor-channel/offers/:offerId/stdio          stdout frames, eof
 *                                both behind the executor's one-use proof (registered inside the channel scope)
 *
 * WHERE A SESSION LIVES. The session (its queued stdin frames and its MCP
 * client) is held in THIS gateway process, keyed by the offer id, from the
 * moment the offer is made. An executor request for a session that this
 * process does not hold is refused `stdio_session_unknown` (fail closed:
 * the call then fails, nothing runs elsewhere). A multi-replica gateway
 * therefore needs the stdio routes to reach the replica that placed the
 * call; see the ADR-0190 "As built: slice I4" section (an open question).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { and, delegationGrants, eq, executionOffers, workloadIdentities, type Db, type ExecutorRow } from "@regulait/db";
import {
  EXECUTOR_CHANNEL_PREFIX,
  EXECUTOR_STREAM_WINDOW,
  STDIO_FRAME_MAX_BYTES,
  STDIO_POST_BODY_LIMIT_BYTES,
  STDIO_SESSION_BUFFER_MAX_BYTES,
  executorStdioPostSchema,
  stdioLineBytes,
  type ExecutionRefusalReason,
  type ExecutorStdioMessage,
  type StdioWorkload,
} from "@regulait/shared";
import { awaitPlacement, offerLinkedPlacement } from "./executor-channel.js";
import { decidePlacement, resolveRequirement, type PlacementRequest } from "./execution-placement.js";

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export class StdioSessionError extends Error {}

/** one placed stdio session, held by the gateway process that placed it */
export class StdioSession {
  /** gateway → sandbox frames not yet written to the executor's window */
  private readonly pending: Array<{ seq: number; data: string }> = [];
  private pendingBytes = 0;
  private nextInSeq = 0;
  /** the next stdout frame the gateway expects from the executor */
  nextOutSeq = 0;
  closed = false;
  ended = false;
  /** a transport (an MCP connect) has taken this session */
  attached = false;
  private waiters: Array<() => void> = [];
  /** the transport's callbacks (set when the transport is attached) */
  onLine: ((line: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(
    readonly offerId: string,
    readonly executorId: string,
    readonly workload: StdioWorkload,
  ) {}

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
    if (this.pendingBytes + n > STDIO_SESSION_BUFFER_MAX_BYTES) throw new StdioSessionError("the sandbox is not reading its input; the session buffer is full");
    this.pending.push({ seq: this.nextInSeq++, data: line });
    this.pendingBytes += n;
    this.wake();
  }

  /** take every queued frame, in order (the executor's window writes them) */
  drain(): Array<{ seq: number; data: string }> {
    const out = this.pending.splice(0, this.pending.length);
    this.pendingBytes = 0;
    return out;
  }

  /** wait until there is something to write, the session closes, or `ms` passes */
  async waitForWork(ms: number): Promise<void> {
    if (this.pending.length > 0 || this.closed || this.ended) return;
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

  /** the sandbox's side ended (eof, or the offer ended): the transport closes */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
    stdioSessions.delete(this.offerId);
    this.onEnd?.();
  }
}

/** the sessions this process holds, by offer id */
const stdioSessions = new Map<string, StdioSession>();

/** the offer ended on the executor's side (its `/end`): a session this process holds ends with it */
export function endStdioSession(offerId: string): void {
  stdioSessions.get(offerId)?.end();
}

/** how many stdio sessions this process holds now (a test reads it) */
export function liveStdioSessions(): number {
  return stdioSessions.size;
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

  constructor(private readonly session: StdioSession) {
    session.attached = true;
    session.onLine = (line) => {
      let msg: JSONRPCMessage;
      try {
        msg = deserializeMessage(line);
      } catch (e) {
        this.onerror?.(e as Error);
        return;
      }
      this.onmessage?.(msg);
    };
    session.onEnd = () => this.fireClose();
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
    // serializeMessage appends the newline; a frame is the line without it
    this.session.push(serializeMessage(message).replace(/\n$/, ""));
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

export type StdioPlacement =
  | { kind: "placed"; session: StdioSession; placementId: string; executorId: string }
  | { kind: "refused"; reason: ExecutionRefusalReason | "execution_profile_mismatch"; placementId: string | null };

/**
 * Decision 7 for one stdio connect, then the executor's accepted report. The
 * session is registered under the offer id BEFORE the executor can report,
 * so its stdio window finds it as soon as the report is accepted. On any
 * refusal the session is removed and nothing reached the server.
 */
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

export async function placeStdioSession(db: Db, input: StdioPlacementInput): Promise<StdioPlacement> {
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
  const placed = await awaitPlacement(db, decision.offerId, input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {});
  if (placed.kind !== "placed") {
    session.end();
    return { kind: "refused", reason: placed.code, placementId: placed.placementId };
  }
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
  if (requirement.kind !== "required") return { kind: "refused", code: "policy_unresolved", placementId: null };
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
export function registerLinkedStdioSession(placed: { offerId: string; executorId: string }, workload: StdioWorkload): StdioSession {
  const session = new StdioSession(placed.offerId, placed.executorId, workload);
  stdioSessions.set(placed.offerId, session);
  const timer = setTimeout(() => {
    if (session.attached) return;
    // the executor's next window says only `close`: a sandbox already started gets no workload and stops; an
    // offer nobody took expires on its own (`no_executor`, the broker's sweep)
    session.close();
  }, LINKED_SESSION_ATTACH_MS);
  timer.unref?.();
  return session;
}

/** the connect of a governed call whose decision placed it: wait for the executor's accepted report */
export async function attachLinkedStdioSession(db: Db, offerId: string, timeoutMs: number): Promise<StdioPlacement> {
  const session = stdioSessions.get(offerId);
  if (!session || session.closed || session.ended) return { kind: "refused", reason: "no_executor", placementId: null };
  session.attached = true;
  const placed = await awaitPlacement(db, offerId, { timeoutMs });
  if (placed.kind !== "placed") {
    session.end();
    return { kind: "refused", reason: placed.code, placementId: placed.placementId };
  }
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
      .object({ window: z.coerce.number().int().min(EXECUTOR_STREAM_WINDOW.min).max(EXECUTOR_STREAM_WINDOW.max).default(EXECUTOR_STREAM_WINDOW.default) })
      .safeParse(req.query ?? {});
    if (!q.success) return deps.refused(reply, 400, "invalid_window", executor);
    if (!(await placedOfferOf(db, executor.id, p.data.offerId))) return deps.refused(reply, 409, "offer_unavailable", executor);
    const session = stdioSessions.get(p.data.offerId);
    if (!session || session.executorId !== executor.id) return deps.refused(reply, 409, "stdio_session_unknown", executor);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", connection: "keep-alive" });
    const write = (m: ExecutorStdioMessage) => reply.raw.write(`${JSON.stringify(m)}\n`);
    let gone = false;
    req.raw.on("close", () => (gone = true));
    const end = Date.now() + q.data.window * 1000;
    let lastKeepalive = Date.now();
    try {
      // a session closed before anything used it gives the sandbox no workload: `close` only
      if (!session.closed) write({ type: "start", workload: session.workload });
      while (!gone && Date.now() < end) {
        for (const f of session.drain()) write({ type: "stdin", seq: f.seq, data: f.data });
        if (session.closed || session.ended) {
          write({ type: "close" });
          break;
        }
        if (Date.now() - lastKeepalive >= deps.keepaliveMs) {
          lastKeepalive = Date.now();
          write({ type: "keepalive" });
        }
        await session.waitForWork(Math.max(1, Math.min(deps.keepaliveMs, end - Date.now())));
      }
      if (!gone && !session.closed && !session.ended) write({ type: "bye", reason: "window" });
    } finally {
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
    if (!session || session.executorId !== executor.id) return deps.refused(reply, 409, "stdio_session_unknown", executor);
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
