/**
 * ADR-0338 — GOVERNED VENDOR AGENT CONTROL: the gateway half (slice 1, the vendor-neutral framework).
 *
 * An admin asks to disable or quarantine an agent a discovery registry source found inside its vendor platform, or to
 * restore one taken out of service earlier. Nothing reaches the vendor until a second administrator approves it
 * (ADR-0186) and the requester executes it with a fresh step-up. The lifecycle is ADR-0348's `VENDOR_ACTION_MACHINE`
 * (@regulait/shared): every move is a conditional `UPDATE … WHERE status IN (sourcesOf(event))` with its audit row in
 * the same transaction, and the vendor call never runs inside a database transaction.
 *
 * STRICT DEFAULT (ADR-0180), at three levels:
 *   - the org switch `discovery_settings.vendor_agent_control_enabled` is off; turning it on is a `settings_relax`
 *     step-up through `PUT /v1/discovery/settings` (discovery-routes.ts);
 *   - a registry offers control only once its adapter declares a `control` member (`VendorAgentControl`). No adapter
 *     declares one in slice 1, so the control map is empty in production and every request answers
 *     `409 control_not_offered`. It is injectable only through buildApp's code-only test seam (`vendorAgentControl`);
 *   - the control credential (a `platform_write` `discovery_credentials` row, slice 1b) resolves to nothing in
 *     production, so a request answers `409 no_control_credential`.
 *
 * The kill switch (ADR-0124, owner decision 2): `killSwitchNarrowingOnly` guards the `execute` event, so disable and
 * quarantine run under any dial and restore only under `normal`. `runExternalWrite` exempts only the
 * `vendor_agent_control.apply` operation (external-effects.ts). A settle only reads, so it runs under any dial.
 *
 * Admin routes (admin-only: none is in NON_ADMIN_ROUTES; every write audited in its own transaction):
 *   POST /v1/vendor-agent-control/actions               request: `settings_relax` step-up, queues the approval
 *   GET  /v1/vendor-agent-control/actions               list contract, newest first
 *   GET  /v1/vendor-agent-control/actions/:id           one action, its lifecycle and the execute guard's reason
 *   POST /v1/vendor-agent-control/actions/:id/execute   the requester, a fresh `settings_relax` step-up, once
 *   POST /v1/vendor-agent-control/actions/:id/settle    an `unknown` action, by a state read only (step-up)
 *   POST /v1/vendor-agent-control/actions/:id/cancel    before execution (narrows: no step-up)
 * The approval is decided through the one decide path (`POST /v1/approvals/:id/decide`, app.ts), never by the
 * requester, only by an admin in the approval's pool, with an `approval_decide` step-up bound to {approvalId, decision,
 * argumentsDigest}.
 *
 * Open source first (ADR-0176): the lifecycle is the repo's own ADR-0348 table helper (xstate was compared and not
 * adopted, ADR-0348); the transport is the repo's guarded fetch. No module was needed.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  agentRegistryRecords,
  and,
  approvals,
  auditLog,
  discoverySettings,
  eq,
  inArray,
  isNull,
  sql,
  users,
  vendorAgentActions,
  type Db,
  type SQL,
  type VendorAgentActionRow,
} from "@regulait/db";
import {
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  changeOfDirection,
  killSwitchNarrowingOnly,
  scrubAuditText,
  targetStateOf,
  VENDOR_ACTION_MACHINE,
  VENDOR_AGENT_ACTION_STATES,
  VENDOR_AGENT_REQUEST_ACTIONS,
  type ControlOp,
  type ControlResult,
  type VendorAgentServiceState,
} from "@regulait/shared";
import { loadApprovalPool, requestedAtOf } from "./approval-pool.js";
import type { ControlContext, VendorAgentControl, VendorAgentRef } from "./vendor-agent-control-contract.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { loadDiscoverySettings } from "./discovery-posture.js";
import { createGuardedFetch, type EgressResolver } from "./egress-guard.js";
import { loadExecutionMode } from "./execution-posture.js";
import { ExternalEffectBlockedError, runExternalWrite, type ExternalWriteOperation } from "./external-effects.js";
import { filterParams, parseListPage, runListPage, sendListError, type ListReader, type ListSpec } from "./list-contract.js";
import { whereFrom } from "./state-transition.js";
import { checkStepUp, isStepUpPrompt, type StepUpCheckArgs } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Bounds (secure by default, ADR-0180: each is the strict value)
// ---------------------------------------------------------------------------

/** the approval's `stage_id` names its action */
export const VENDOR_AGENT_CONTROL_APPROVAL_PREFIX = "__vendor_agent_control__:";
/** the vendor deadline of one execution: ONE signal shared by its prior read, its apply and its observed read, so the
 * whole sequence ends inside the lease (#1096 review 2) */
export const VENDOR_CONTROL_DEADLINE_MS = 30_000;
/** the execution lease: the shared deadline plus 60 seconds of margin (ADR-0338 §4) */
export const VENDOR_CONTROL_LEASE_SECONDS = VENDOR_CONTROL_DEADLINE_MS / 1000 + 60;
/** the most bytes one vendor answer may carry (a state read or an apply is a small JSON object) */
const VENDOR_RESPONSE_MAX_BYTES = 256 * 1024;
/** the approval window without a setting: the strict default */
export const VENDOR_CONTROL_DEFAULT_TTL_HOURS = 24;
/** the open states: at most one per agent (the migration's partial unique index) */
export const OPEN_ACTION_STATES = ["requested", "approved", "executing", "unknown"] as const;

// ---------------------------------------------------------------------------
// Injected dependencies (code-only test seams; empty / null in production)
// ---------------------------------------------------------------------------

/** a live control credential: its row id (bound into the approval digest, so a replaced credential is refused) and token */
export interface ControlCredential {
  readonly id: string;
  readonly token: string;
}
export interface VendorAgentControlDeps {
  /** registry name → its adapter's control member; empty until an adapter declares one (slice 1b) */
  controls?: Readonly<Record<string, VendorAgentControl>>;
  /** the source's live `platform_write` credential, or null; null in production until slice 1b */
  credentialFor?: (db: Db, sourceId: string) => Promise<ControlCredential | null>;
  /** TEST SEAMS for the guarded fetch (never set in production) */
  fetchImpl?: typeof fetch;
  resolve?: EgressResolver;
}

// ---------------------------------------------------------------------------
// Bodies (strict: an unknown member is refused)
// ---------------------------------------------------------------------------

const printable = (s: string) => [...s].every((c) => c >= " " && c !== "\u007f");
export const requestActionSchema = z
  .object({
    recordId: z.string().uuid(),
    action: z.enum(VENDOR_AGENT_REQUEST_ACTIONS),
    /** a restore names the succeeded action it reverses; the other actions name none */
    reverses: z.string().uuid().optional(),
    /** the second administrator who decides the approval (ADR-0186): never the requester */
    approverUserId: z.string().uuid(),
    reason: z.string().trim().min(1).max(500).refine(printable, { message: "printable" }),
  })
  .strict()
  .refine((b) => (b.action === "restore") === (b.reverses !== undefined), { message: "a restore names the action it reverses (`reverses`), and only a restore does" });
export type RequestActionBody = z.infer<typeof requestActionSchema>;

const idParam = z.object({ id: z.string().uuid() });
const emptyBody = z.object({}).strict();

// ---------------------------------------------------------------------------
// Facts, digests and step-ups
// ---------------------------------------------------------------------------

/** what an action asks for, canonically, from the stored row (the approval digest is computed over it) */
export interface ActionFacts {
  recordId: string;
  sourceId: string;
  registry: string;
  vendorId: string;
  action: "disable" | "quarantine" | "restore";
  reverses: string | null;
  credentialId: string;
}
const factsOfRow = (r: VendorAgentActionRow, credentialId: string): ActionFacts => ({
  recordId: r.recordId,
  sourceId: r.sourceId,
  registry: r.registry,
  vendorId: r.externalId,
  action: r.direction === "reverse" ? "restore" : r.action,
  reverses: r.reversesActionId,
  credentialId,
});
/** ADR-0338 §4: the approval digest and preview, over the same facts */
export const actionArgumentsDigest = (f: ActionFacts) => approvalArgumentsDigest({ projectId: null, arguments: { op: "vendor_agent_control", ...f } });

/** the request's step-up: bound to the record, the action, what it reverses and the approver */
export const vendorControlRequestStepUp = (b: RequestActionBody): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { op: "vendor_agent_control", recordId: b.recordId.toLowerCase(), action: b.action, reverses: b.reverses?.toLowerCase() ?? null, approverUserId: b.approverUserId.toLowerCase() },
});
/** the execute step-up: the same facts plus the action id */
export const vendorControlExecuteStepUp = (r: VendorAgentActionRow): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { op: "vendor_agent_control_execute", actionId: r.id, recordId: r.recordId, action: r.direction === "reverse" ? "restore" : r.action, reverses: r.reversesActionId },
});
/** the settle step-up: bound to the action id */
export const vendorControlSettleStepUp = (actionId: string): StepUpCheckArgs => ({ kind: "settings_relax", facts: { op: "vendor_agent_control_settle", actionId } });
/** the approver's step-up: bound to the approval, the decision and the digest of what will run */
export const vendorControlDecideStepUp = (approvalId: string, decision: "approved" | "denied", argumentsDigest: string): StepUpCheckArgs => ({
  kind: "approval_decide",
  facts: { op: "vendor_agent_control", approvalId, decision, argumentsDigest },
});

const opOf = (r: Pick<VendorAgentActionRow, "action" | "direction">): ControlOp => ({ action: r.action, direction: r.direction });
const writeOperationOf = (op: ControlOp): ExternalWriteOperation => (op.direction === "apply" ? "vendor_agent_control.apply" : "vendor_agent_control.reverse");
const refOf = (r: VendorAgentActionRow): VendorAgentRef => ({ recordId: r.recordId, sourceId: r.sourceId, registry: r.registry, externalId: r.externalId });

// ---------------------------------------------------------------------------
// Views and lists (ADR-0226 list contract)
// ---------------------------------------------------------------------------

/** the execute guard's refusal for an action under the current dial (what `describe` reports) */
const guardFor = (r: Pick<VendorAgentActionRow, "direction">, dial: Awaited<ReturnType<typeof loadExecutionMode>>) => killSwitchNarrowingOnly({ dial, direction: changeOfDirection(r.direction) });

function actionView(r: VendorAgentActionRow, dial: Awaited<ReturnType<typeof loadExecutionMode>>) {
  const reason = guardFor(r, dial);
  return {
    id: r.id,
    recordId: r.recordId,
    sourceId: r.sourceId,
    registry: r.registry,
    vendorId: r.externalId,
    action: r.direction === "reverse" ? "restore" : r.action,
    reverses: r.reversesActionId,
    targetState: targetStateOf(opOf(r)),
    reason: r.reason,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    approvalId: r.approvalId,
    status: r.status,
    priorState: r.priorState,
    observedState: r.observedState,
    outcomeCode: r.outcomeCode,
    httpStatus: r.httpStatus,
    leaseExpiresAt: r.leaseExpiresAt?.toISOString() ?? null,
    settledAt: r.settledAt?.toISOString() ?? null,
    /** the declared machine's view, with the kill-switch guard's refusal on `execute` (readable by people and agents) */
    lifecycle: VENDOR_ACTION_MACHINE.describe(r.status, reason ? { execute: reason } : {}),
  };
}
type ActionListRow = ReturnType<typeof actionView>;

export const VENDOR_ACTIONS_LIST: ListSpec<ActionListRow> = {
  id: "vendor-agent-actions",
  sorts: {
    created: { expr: vendorAgentActions.createdAt, keysetAt: vendorAgentActions.createdAt },
    status: { expr: vendorAgentActions.status },
  },
  columns: {
    agent: { label: "Agent", value: (r) => `${r.registry} ${r.vendorId}` },
    action: { label: "Action", value: (r) => r.action },
    status: { label: "Status", value: (r) => (r.outcomeCode ? `${r.status} (${r.outcomeCode})` : r.status) },
    created: { label: "Requested", value: (r) => new Date(r.createdAt) },
  },
  filters: ["status"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: vendorAgentActions.id,
};
const listFilter = z.object({ status: z.enum(VENDOR_AGENT_ACTION_STATES).optional(), recordId: z.string().uuid().optional() }).strict();

interface Refusal {
  status: number;
  body: Record<string, unknown>;
}
const refusal = (status: number, error: string, detail: string, extra: Record<string, unknown> = {}): Refusal => ({ status, body: { error, detail, ...extra } });
const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && "status" in x && "body" in x;

type AuditFn = (t: Db, objectId: string | null, ruleId: string, effect: "allow" | "deny" | "require_approval", reason: string, detail: Record<string, unknown>) => Promise<unknown>;
const auditWith = (userId: string): AuditFn => (t, objectId, ruleId, effect, reason, detail) =>
  t.insert(auditLog).values({
    userId,
    objectType: "vendor_agent_control",
    objectId,
    detail: { subsystem: "vendor-agent-control", adr: "0338", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
/** the fixed fields every transition's audit row carries (ADR-0338 §5): never vendor text */
const fixedFields = (r: VendorAgentActionRow) => ({
  actionId: r.id,
  recordId: r.recordId,
  sourceId: r.sourceId,
  registry: r.registry,
  vendorId: r.externalId,
  action: r.direction === "reverse" ? "restore" : r.action,
  reverses: r.reversesActionId,
  priorState: r.priorState,
  observedState: r.observedState,
  outcomeCode: r.outcomeCode,
  httpStatus: r.httpStatus,
});

// ---------------------------------------------------------------------------
// Moves written when an action is next touched (ADR-0338 §4: nothing runs on a timer)
// ---------------------------------------------------------------------------

/**
 * Inside a transaction: an open action whose approval expired moves `requested|approved → cancelled`
 * (`approval_expired`, its approval superseded), and an execution whose lease passed moves `executing → unknown`
 * (`lease_expired`). Both are conditional on the source states, so a live execution is never taken over.
 */
export async function touchDue(t: Db, scope: SQL | undefined, audit: AuditFn): Promise<void> {
  const expired = await t
    .update(vendorAgentActions)
    .set({ status: VENDOR_ACTION_MACHINE.next("requested", "expire"), outcomeCode: "approval_expired", settledAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        scope,
        whereFrom(vendorAgentActions.status, VENDOR_ACTION_MACHINE, "expire"),
        sql`EXISTS (SELECT 1 FROM ${approvals} p WHERE p.id = ${vendorAgentActions.approvalId} AND p.expires_at <= now())`,
      ),
    )
    .returning();
  if (expired.length) {
    await t
      .update(approvals)
      .set({ status: "superseded" })
      .where(and(inArray(approvals.id, expired.map((r) => r.approvalId)), inArray(approvals.status, ["pending", "approved"])));
    for (const r of expired) {
      await audit(t, r.id, "vendor-agent-control-expired", "deny", "a vendor agent control action's approval expired before it ran; nothing was sent (ADR-0338)", fixedFields(r));
    }
  }
  const lost = await t
    .update(vendorAgentActions)
    .set({ status: VENDOR_ACTION_MACHINE.next("executing", "lose_track"), outcomeCode: "lease_expired", updatedAt: sql`now()` })
    .where(and(scope, whereFrom(vendorAgentActions.status, VENDOR_ACTION_MACHINE, "lose_track"), sql`${vendorAgentActions.leaseExpiresAt} < now()`))
    .returning();
  for (const r of lost) {
    await audit(t, r.id, "vendor-agent-control-lease-expired", "deny", "a vendor agent control execution stopped before its outcome was recorded; it is settled by a state read (ADR-0338)", fixedFields(r));
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerVendorAgentControlRoutes(app: FastifyInstance, db: Db, deps: VendorAgentControlDeps = {}): void {
  const controls = deps.controls ?? {};
  const credentialFor = deps.credentialFor ?? (async () => null);
  const actorOf = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const notOpen = (status: VendorAgentActionRow["status"], what: string) =>
    refusal(409, "action_not_" + what, `an action that is ${status} cannot be ${what === "executable" ? "executed" : what === "settleable" ? "settled" : "cancelled"}`, { lifecycle: VENDOR_ACTION_MACHINE.describe(status) });
  const controlFor = (registry: string, op: ControlOp): VendorAgentControl | null => {
    const c = Object.prototype.hasOwnProperty.call(controls, registry) ? controls[registry] : undefined;
    return c && c.actions.includes(op.action) ? c : null;
  };
  const guardedFetch = async () =>
    createGuardedFetch({
      allowList: await loadEgressAllowList(db),
      maxResponseBytes: VENDOR_RESPONSE_MAX_BYTES,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
    });
  const readState = async (control: VendorAgentControl, r: VendorAgentActionRow, token: string, signal: AbortSignal): Promise<VendorAgentServiceState> => {
    try {
      const s = await control.readState({ fetch: await guardedFetch(), signal, token }, refOf(r));
      return s.state;
    } catch {
      return "unknown";
    }
  };
  const lockAction = (t: Db, id: string) => t.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, id)).for("update");

  // ---- request ----------------------------------------------------------------------------------------------------
  app.post("/v1/vendor-agent-control/actions", async (req, reply) => {
    const parsed = requestActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const b = parsed.data;
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "person_required", detail: "a vendor agent control action is requested by a signed-in administrator" });
    const audit = auditWith(userId);
    const recordId = b.recordId.toLowerCase();
    const approverUserId = b.approverUserId.toLowerCase();
    const reverses = b.reverses?.toLowerCase() ?? null;
    const out = await db.transaction(async (tx): Promise<Refusal | { row: VendorAgentActionRow; idempotent: boolean }> => {
      const t = tx as unknown as Db;
      // FOR SHARE: a concurrent switch-off (FOR UPDATE in PUT /v1/discovery/settings) waits for this request, or wins
      const [settings] = await t
        .select({ on: discoverySettings.vendorAgentControlEnabled, ttl: discoverySettings.vendorAgentControlApprovalTtlHours })
        .from(discoverySettings)
        .where(eq(discoverySettings.id, 1))
        .for("share");
      if (!settings?.on) {
        return refusal(403, "vendor_agent_control_disabled", "vendor agent control is off: an admin turns it on in the discovery settings (that asks you to confirm it's you, and is audited)");
      }
      const [record] = await t.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, recordId)).for("share");
      if (!record) return refusal(404, "not_found", "no such discovered agent");
      if (record.absentSince) return refusal(409, "agent_absent", "the vendor registry no longer lists that agent");
      // an expired approval or a lost execution for this agent moves first, so it never blocks a new request
      await touchDue(t, eq(vendorAgentActions.recordId, recordId), audit);
      // a restore reverses one action of this agent that took it out of service and has not been restored
      let op: ControlOp;
      if (reverses) {
        const [prior] = await t.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, reverses));
        if (!prior || prior.recordId !== recordId || prior.direction !== "apply" || !(prior.status === "succeeded" || prior.status === "already_in_state")) {
          return refusal(409, "nothing_to_restore", "a restore reverses a disable or quarantine of this agent that succeeded");
        }
        op = { action: prior.action, direction: "reverse" };
      } else {
        op = { action: b.action as ControlOp["action"], direction: "apply" };
      }
      const [open] = await t.select().from(vendorAgentActions).where(and(eq(vendorAgentActions.recordId, recordId), inArray(vendorAgentActions.status, [...OPEN_ACTION_STATES])));
      if (open) {
        const same = open.createdBy === userId && open.action === op.action && open.direction === op.direction && (open.reversesActionId ?? null) === reverses;
        if (same) return { row: open, idempotent: true };
        return refusal(409, "action_already_open", "another control action for this agent is still open; cancel it or let it finish first", { actionId: open.id });
      }
      if (reverses) {
        const [restored] = await t
          .select({ id: vendorAgentActions.id })
          .from(vendorAgentActions)
          .where(and(eq(vendorAgentActions.reversesActionId, reverses), sql`${vendorAgentActions.status} NOT IN ('cancelled', 'denied', 'failed')`));
        if (restored) return refusal(409, "already_restored", "that action was already restored");
      }
      // the registry offers the action only once its adapter declares it, and only with a live control credential
      if (!controlFor(record.registry, op)) return refusal(409, "control_not_offered", `the ${record.registry} registry offers no ${op.action} control`);
      const credential = await credentialFor(t, record.sourceId);
      if (!credential) return refusal(409, "no_control_credential", "the source has no live control credential (a separate platform_write credential, never the read credential)");
      // the second person: an active admin in the approval pool (never the requester, nor anyone delegation-linked)
      if (approverUserId === userId) return refusal(422, "approver_is_requester", "a control action is approved by a second administrator, not the person who asks for it");
      const [approver] = await t.select({ id: users.id }).from(users).where(and(eq(users.id, approverUserId), eq(users.isAdmin, true), isNull(users.disabledAt)));
      const pool = approver ? await loadApprovalPool(t, { namedApproverUserId: approverUserId, approverRoleId: null, callerUserId: userId }) : null;
      if (!pool || !pool.members.includes(approverUserId)) {
        return refusal(422, "approver_not_eligible", "the approver must be another active administrator who is not linked to you by a delegation");
      }
      // the grant is spent in this transaction, with the writes it authorises
      const stepUp = vendorControlRequestStepUp(b);
      const su = await checkStepUp(t, req, stepUp, { spend: true });
      if (!su.ok) {
        if (!isStepUpPrompt(su.body)) {
          await audit(t, null, "vendor-agent-control-step-up-refused", "deny", `a vendor agent control request was refused: ${String(su.body.error)} (ADR-0338)`, { actionKind: stepUp.kind, error: su.body.error, recordId });
        }
        return { status: su.status, body: su.body };
      }
      const id = randomUUID();
      const draft = { id, recordId, sourceId: record.sourceId, registry: record.registry, externalId: record.externalId, action: op.action, direction: op.direction, reversesActionId: reverses } as VendorAgentActionRow;
      const facts = factsOfRow(draft, credential.id);
      const ttl = settings.ttl ?? VENDOR_CONTROL_DEFAULT_TTL_HOURS;
      const [approval] = await t
        .insert(approvals)
        .values({
          userId,
          objectType: "vendor_agent_control",
          approverUserId,
          stageId: `${VENDOR_AGENT_CONTROL_APPROVAL_PREFIX}${id}`,
          argumentsDigest: actionArgumentsDigest(facts),
          argumentsPreview: approvalArgumentsPreview({ ...facts }),
          argumentsPreviewKind: "arguments_v1",
          expiresAt: sql`now() + make_interval(hours => ${ttl})`,
        })
        .returning({ id: approvals.id, expiresAt: approvals.expiresAt });
      const [row] = await t
        .insert(vendorAgentActions)
        .values({ ...draft, reason: b.reason, createdBy: userId, approvalId: approval!.id })
        .returning();
      await audit(
        t,
        id,
        "vendor-agent-control-requested",
        "require_approval",
        `${b.action} of the ${record.registry} agent requested, awaiting a second administrator's approval (step-up ${su.method}) (ADR-0338)`,
        { ...fixedFields(row!), reason: scrubAuditText(b.reason), approvalId: approval!.id, approverUserId, credentialId: credential.id, expiresAt: approval!.expiresAt?.toISOString() ?? null, stepUp: su.method },
      );
      return { row: row!, idempotent: false };
    });
    if (isRefusal(out)) return reply.status(out.status).send(out.body);
    const dial = await loadExecutionMode(db);
    return reply.status(out.idempotent ? 200 : 201).send({ action: actionView(out.row, dial), idempotent: out.idempotent });
  });

  // ---- reads ------------------------------------------------------------------------------------------------------
  app.get("/v1/vendor-agent-control/actions", async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const f = listFilter.parse(filterParams(q));
      const page = parseListPage(VENDOR_ACTIONS_LIST, q);
      // a read is a touch: overdue moves are written first, with their audit rows
      await db.transaction((tx) => touchDue(tx as unknown as Db, f.recordId ? eq(vendorAgentActions.recordId, f.recordId.toLowerCase()) : undefined, auditWith(actorOf(req))));
      const dial = await loadExecutionMode(db);
      const reader: ListReader<ActionListRow> = {
        fetch: async (lq) => {
          const rows = await db.select({ r: vendorAgentActions, _cursorAt: lq.cursorAt }).from(vendorAgentActions).where(lq.where).orderBy(...lq.orderBy).limit(lq.limit).offset(lq.offset);
          return rows.map((x) => ({ ...actionView(x.r, dial), _cursorAt: x._cursorAt }));
        },
        countable: (where) => db.select({ one: sql`1` }).from(vendorAgentActions).where(where),
        idOf: (r) => r.id,
      };
      const where = and(f.status ? eq(vendorAgentActions.status, f.status) : undefined, f.recordId ? eq(vendorAgentActions.recordId, f.recordId.toLowerCase()) : undefined);
      const [out, settings] = await Promise.all([runListPage(db, VENDOR_ACTIONS_LIST, reader, where, page), loadDiscoverySettings(db)]);
      return reply.send({ ...out, enabled: settings.vendorAgentControl, controlledRegistries: Object.keys(controls).sort() });
    } catch (e) {
      if (e instanceof z.ZodError) return badRequest(reply, e);
      return sendListError(reply, e);
    }
  });

  app.get("/v1/vendor-agent-control/actions/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "id must be a uuid" });
    const id = p.data.id.toLowerCase();
    const row = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await touchDue(t, eq(vendorAgentActions.id, id), auditWith(actorOf(req)));
      const [r] = await t.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, id));
      return r ?? null;
    });
    if (!row) return reply.status(404).send({ error: "not_found", detail: "no such action" });
    return reply.send({ action: actionView(row, await loadExecutionMode(db)) });
  });

  // ---- execute ----------------------------------------------------------------------------------------------------
  app.post("/v1/vendor-agent-control/actions/:id/execute", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "id must be a uuid" });
    const eb = emptyBody.safeParse(req.body ?? {});
    if (!eb.success) return badRequest(reply, eb.error);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "person_required", detail: "an action is executed by the administrator who requested it" });
    const audit = auditWith(userId);
    const id = p.data.id.toLowerCase();
    const started = await db.transaction(async (tx): Promise<Refusal | { row: VendorAgentActionRow; control: VendorAgentControl; credential: ControlCredential }> => {
      const t = tx as unknown as Db;
      await touchDue(t, eq(vendorAgentActions.id, id), audit);
      const [r] = await lockAction(t, id);
      if (!r) return refusal(404, "not_found", "no such action");
      if (r.createdBy !== userId) return refusal(403, "not_the_requester", "an approved action is executed by the administrator who requested it");
      if (!VENDOR_ACTION_MACHINE.can(r.status, "execute")) return notOpen(r.status, "executable");
      // the kill-switch guard on the transition (ADR-0338 §7): narrowing under any dial, widening only under normal
      const dial = await loadExecutionMode(db);
      const blocked = guardFor(r, dial);
      if (blocked) {
        return refusal(409, new ExternalEffectBlockedError(writeOperationOf(opOf(r)), dial).code, blocked, { lifecycle: VENDOR_ACTION_MACHINE.describe(r.status, { execute: blocked }) });
      }
      // every input is re-read: the switch, the record, the control, the credential and the digest
      const [settings] = await t.select({ on: discoverySettings.vendorAgentControlEnabled }).from(discoverySettings).where(eq(discoverySettings.id, 1)).for("share");
      if (!settings?.on) return refusal(403, "vendor_agent_control_disabled", "vendor agent control was turned off");
      const [record] = await t.select().from(agentRegistryRecords).where(eq(agentRegistryRecords.id, r.recordId)).for("share");
      const control = controlFor(r.registry, opOf(r));
      const credential = record ? await credentialFor(t, record.sourceId) : null;
      const [approval] = await t.select().from(approvals).where(eq(approvals.id, r.approvalId)).for("update");
      const moved =
        !record || record.absentSince || record.sourceId !== r.sourceId || record.registry !== r.registry || record.externalId !== r.externalId
          ? "record_changed"
          : !control
            ? "control_not_offered"
            : !credential
              ? "no_control_credential"
              : !approval?.argumentsDigest || actionArgumentsDigest(factsOfRow(r, credential.id)) !== approval.argumentsDigest
                ? "approval_payload_mismatch"
                : null;
      if (moved) {
        await audit(t, r.id, "vendor-agent-control-execute-refused", "deny", `a vendor agent control action was not executed: ${moved} (ADR-0338)`, { ...fixedFields(r), why: moved });
        return refusal(409, "approval_payload_mismatch", `what was approved no longer matches (${moved}); ask again`, { why: moved });
      }
      const su = await checkStepUp(t, req, vendorControlExecuteStepUp(r), { spend: true });
      if (!su.ok) return { status: su.status, body: su.body };
      // single use: the approval is consumed with a conditional update, so it executes at most once
      const consumed = await t.update(approvals).set({ status: "consumed" }).where(and(eq(approvals.id, r.approvalId), eq(approvals.status, "approved"))).returning({ id: approvals.id });
      if (consumed.length === 0) return refusal(409, "approval_not_approved", "the approval is not (or no longer) approved");
      const [executing] = await t
        .update(vendorAgentActions)
        .set({ status: VENDOR_ACTION_MACHINE.next(r.status, "execute"), leaseExpiresAt: sql`now() + make_interval(secs => ${VENDOR_CONTROL_LEASE_SECONDS})`, updatedAt: sql`now()` })
        .where(and(eq(vendorAgentActions.id, r.id), whereFrom(vendorAgentActions.status, VENDOR_ACTION_MACHINE, "execute")))
        .returning();
      await audit(t, r.id, "vendor-agent-control-executing", "allow", `a vendor agent control action is executing (step-up ${su.method}) (ADR-0338)`, { ...fixedFields(executing!), dial, stepUp: su.method });
      return { row: executing!, control: control!, credential: credential! };
    });
    if (isRefusal(started)) return reply.status(started.status).send(started.body);

    // the vendor calls run outside any database transaction (ADR-0338 §4)
    const { row, control, credential } = started;
    const op = opOf(row);
    const target = targetStateOf(op);
    // one deadline for the whole sequence (prior read, the call, the observed read), so it ends inside the lease
    const deadline = AbortSignal.timeout(VENDOR_CONTROL_DEADLINE_MS);
    const prior = await readState(control, row, credential.token, deadline);
    // ADR-0338 §4 step 3: the prior state is recorded BEFORE the vendor call, so a crash after it still leaves the row
    // with what the agent was in (#1096 review 1); conditional on the row still executing
    await db
      .update(vendorAgentActions)
      .set({ priorState: prior, updatedAt: sql`now()` })
      .where(and(eq(vendorAgentActions.id, row.id), eq(vendorAgentActions.status, "executing")));
    let event: "succeed" | "find_in_state" | "fail" | "lose_track";
    let code: string;
    let httpStatus: number | null = null;
    let observed: VendorAgentServiceState | null = null;
    try {
      const fetchForCall = await guardedFetch();
      const ctx: ControlContext = { fetch: fetchForCall, signal: deadline, token: credential.token };
      const effect = { userId, objectType: "vendor_agent_control" as const, objectId: row.id, detail: { registry: row.registry, direction: op.direction }, summarize: (x: ControlResult) => ({ outcome: x.outcome, code: x.code, httpStatus: x.httpStatus ?? null }) };
      // one classified operation per contract method: `apply` narrows (the one dial exemption), `reverse` widens
      const result: ControlResult =
        op.direction === "apply"
          ? await runExternalWrite(db, "vendor_agent_control.apply", () => control.apply(ctx, refOf(row), op.action), effect)
          : await runExternalWrite(db, "vendor_agent_control.reverse", () => control.reverse(ctx, refOf(row), op.action), effect);
      httpStatus = typeof result.httpStatus === "number" && result.httpStatus >= 100 && result.httpStatus <= 599 ? result.httpStatus : null;
      code = /^[a-z][a-z0-9_]{0,63}$/.test(result.code) ? result.code : "vendor_code_invalid";
      if (result.outcome === "already_in_state") event = "find_in_state";
      else if (result.outcome === "refused" || result.outcome === "failed") event = "fail";
      else {
        observed = await readState(control, row, credential.token, deadline);
        event = observed === target ? "succeed" : "lose_track";
        if (event === "lose_track") code = "not_confirmed";
      }
    } catch (e) {
      // the dial moved between the guard and the call: nothing was sent
      if (e instanceof ExternalEffectBlockedError) {
        event = "fail";
        code = e.code;
      } else {
        // a timeout or transport error: the vendor may have acted, so the outcome is settled by a read, never a retry
        event = "lose_track";
        code = "vendor_timeout";
      }
    }
    const final = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [done] = await t
        .update(vendorAgentActions)
        .set({
          status: VENDOR_ACTION_MACHINE.next("executing", event),
          priorState: prior,
          observedState: observed,
          outcomeCode: code,
          httpStatus,
          updatedAt: sql`now()`,
          ...(VENDOR_ACTION_MACHINE.isTerminal(VENDOR_ACTION_MACHINE.next("executing", event)) ? { settledAt: sql`now()` } : {}),
        })
        .where(and(eq(vendorAgentActions.id, row.id), whereFrom(vendorAgentActions.status, VENDOR_ACTION_MACHINE, event), eq(vendorAgentActions.status, "executing")))
        .returning();
      if (done) {
        await audit(t, row.id, `vendor-agent-control-${done.status}`, done.status === "succeeded" || done.status === "already_in_state" ? "allow" : "deny", `a vendor agent control action ended ${done.status} (${code}) (ADR-0338)`, fixedFields(done));
        return done;
      }
      // the lease expired and another touch moved it to unknown first: its settle reads the state
      const [now] = await t.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, row.id));
      return now!;
    });
    return reply.send({ action: actionView(final, await loadExecutionMode(db)) });
  });

  // ---- settle -----------------------------------------------------------------------------------------------------
  app.post("/v1/vendor-agent-control/actions/:id/settle", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "id must be a uuid" });
    const eb = emptyBody.safeParse(req.body ?? {});
    if (!eb.success) return badRequest(reply, eb.error);
    const audit = auditWith(actorOf(req));
    const id = p.data.id.toLowerCase();
    const ready = await db.transaction(async (tx): Promise<Refusal | { row: VendorAgentActionRow; control: VendorAgentControl; credential: ControlCredential }> => {
      const t = tx as unknown as Db;
      await touchDue(t, eq(vendorAgentActions.id, id), audit);
      const [r] = await lockAction(t, id);
      if (!r) return refusal(404, "not_found", "no such action");
      if (r.status !== "unknown") return notOpen(r.status, "settleable");
      const control = controlFor(r.registry, opOf(r));
      const credential = await credentialFor(t, r.sourceId);
      if (!control || !credential) return refusal(409, control ? "no_control_credential" : "control_not_offered", "the state cannot be read without the control and its credential");
      const su = await checkStepUp(t, req, vendorControlSettleStepUp(r.id), { spend: true });
      if (!su.ok) return { status: su.status, body: su.body };
      await audit(t, r.id, "vendor-agent-control-settle-started", "allow", `a vendor agent control action is being settled by a state read (step-up ${su.method}) (ADR-0338)`, fixedFields(r));
      return { row: r, control, credential };
    });
    if (isRefusal(ready)) return reply.status(ready.status).send(ready.body);
    const { row, control, credential } = ready;
    // a read only, under any dial: never a second apply
    const state = await readState(control, row, credential.token, AbortSignal.timeout(VENDOR_CONTROL_DEADLINE_MS));
    const target = targetStateOf(opOf(row));
    // decided from the direction, never only from a stored prior (#1096 review 1): the target state means the call took
    // effect; any other KNOWN state means it did not (`apply` left the agent in service, `reverse` left it out of
    // service), so the action ends `failed / not_applied` and the agent is free for a new request. Only an unreadable
    // state keeps it `unknown`.
    const event = state === target ? "succeed" : state !== "unknown" ? "fail" : null;
    const final = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      if (!event) {
        await audit(t, row.id, "vendor-agent-control-settle-unresolved", "deny", "a vendor agent control action's state could not be confirmed; it stays unknown and open (ADR-0338)", { ...fixedFields(row), read: state });
        return row;
      }
      const [done] = await t
        .update(vendorAgentActions)
        .set({ status: VENDOR_ACTION_MACHINE.next("unknown", event), observedState: state, outcomeCode: event === "fail" ? "not_applied" : "settled_by_read", settledAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(vendorAgentActions.id, row.id), whereFrom(vendorAgentActions.status, VENDOR_ACTION_MACHINE, event), eq(vendorAgentActions.status, "unknown")))
        .returning();
      if (!done) return (await t.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, row.id)))[0]!;
      await audit(t, row.id, `vendor-agent-control-settled-${done.status}`, done.status === "succeeded" ? "allow" : "deny", `a vendor agent control action was settled ${done.status} by a state read (ADR-0338)`, fixedFields(done));
      return done;
    });
    return reply.send({ action: actionView(final, await loadExecutionMode(db)), settled: final.status !== "unknown" });
  });

  // ---- cancel -----------------------------------------------------------------------------------------------------
  app.post("/v1/vendor-agent-control/actions/:id/cancel", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "id must be a uuid" });
    const eb = emptyBody.safeParse(req.body ?? {});
    if (!eb.success) return badRequest(reply, eb.error);
    const audit = auditWith(actorOf(req));
    const id = p.data.id.toLowerCase();
    // cancelling narrows, so it needs no step-up; the action, its approval and the audit row commit together
    const out = await db.transaction(async (tx): Promise<Refusal | { row: VendorAgentActionRow; alreadyCancelled: boolean }> => {
      const t = tx as unknown as Db;
      await touchDue(t, eq(vendorAgentActions.id, id), audit);
      const [r] = await lockAction(t, id);
      if (!r) return refusal(404, "not_found", "no such action");
      if (r.status === "cancelled") return { row: r, alreadyCancelled: true };
      if (!VENDOR_ACTION_MACHINE.can(r.status, "cancel")) return notOpen(r.status, "cancellable");
      const [cancelled] = await t
        .update(vendorAgentActions)
        .set({ status: VENDOR_ACTION_MACHINE.next(r.status, "cancel"), outcomeCode: "cancelled_by_admin", settledAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(vendorAgentActions.id, r.id), whereFrom(vendorAgentActions.status, VENDOR_ACTION_MACHINE, "cancel")))
        .returning();
      // the queued (or approved, not yet consumed) approval is withdrawn, so nobody can decide or execute it later
      await t.update(approvals).set({ status: "superseded" }).where(and(eq(approvals.id, r.approvalId), inArray(approvals.status, ["pending", "approved"])));
      await audit(t, r.id, "vendor-agent-control-cancelled", "allow", "a vendor agent control action was cancelled before it ran; nothing was sent (ADR-0338)", { ...fixedFields(cancelled!), from: r.status });
      return { row: cancelled!, alreadyCancelled: false };
    });
    if (isRefusal(out)) return reply.status(out.status).send(out.body);
    return reply.send({ action: actionView(out.row, await loadExecutionMode(db)), alreadyCancelled: out.alreadyCancelled });
  });
}

// ---------------------------------------------------------------------------
// The decide path's two hooks (app.ts decideOneApprovalUnguarded), as ADR-0331's removal
// ---------------------------------------------------------------------------

type DecideRefusal = { status: number; body: Record<string, unknown> };
type ApprovalLike = { id: string; userId: string; approverUserId: string; approverRoleId: string | null; argumentsDigest: string | null };

const actionOfApproval = (db: Db, approvalId: string) => db.select().from(vendorAgentActions).where(eq(vendorAgentActions.approvalId, approvalId));

/**
 * Before anything is written: the decider is not the requester (by any route), is an active admin in the approval's
 * pool, and holds an `approval_decide` step-up bound to {approvalId, decision, argumentsDigest}. Only the HTTP decide
 * route carries the request a step-up needs, so bulk and ChatOps decisions of this kind are refused by name. The dial
 * is not checked here: the kill-switch guard runs at execute (a narrowing action may be approved during a halt).
 */
export async function precheckVendorAgentControlDecision(
  db: Db,
  approval: ApprovalLike,
  deciderUserId: string,
  decision: "approved" | "denied",
  req: FastifyRequest | undefined,
): Promise<DecideRefusal | null> {
  const [r] = await actionOfApproval(db, approval.id);
  if (!r) return null;
  if (r.createdBy === deciderUserId || approval.userId === deciderUserId) {
    return { status: 403, body: { error: "cannot_approve_own_vendor_action", detail: "the decider asked for this action; another administrator must decide it" } };
  }
  const [decider] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, deciderUserId), eq(users.isAdmin, true), isNull(users.disabledAt)));
  const pool = await loadApprovalPool(db, { namedApproverUserId: approval.approverUserId, approverRoleId: approval.approverRoleId, callerUserId: approval.userId, asOf: requestedAtOf(approval.id) });
  if (!decider || !pool.members.includes(deciderUserId)) {
    return { status: 403, body: { error: "not_an_eligible_approver", detail: "a vendor agent control action is decided by the administrator it names (or their delegate), never by an override" } };
  }
  if (!req) return { status: 403, body: { error: "step_up_required", actionKind: "approval_decide", methods: [], detail: "decide a vendor agent control action from the approval itself, confirming it is you" } };
  if (!approval.argumentsDigest) return { status: 409, body: { error: "approval_unbound", detail: "this approval carries no arguments digest" } };
  // only looks here (the grant is spent inside the decision's transaction, with its writes)
  const su = await checkStepUp(db, req, vendorControlDecideStepUp(approval.id, decision, approval.argumentsDigest), { spend: false });
  if (!su.ok) return { status: su.status, body: su.body };
  return null;
}

/** the approvals queue's label for each control approval */
export async function vendorAgentControlApprovalLabels(db: Db, stageIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(stageIds.filter((s): s is string => !!s?.startsWith(VENDOR_AGENT_CONTROL_APPROVAL_PREFIX)).map((s) => s.slice(VENDOR_AGENT_CONTROL_APPROVAL_PREFIX.length)))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: vendorAgentActions.id, action: vendorAgentActions.action, direction: vendorAgentActions.direction, registry: vendorAgentActions.registry, name: agentRegistryRecords.displayName })
    .from(vendorAgentActions)
    .innerJoin(agentRegistryRecords, eq(agentRegistryRecords.id, vendorAgentActions.recordId))
    .where(inArray(vendorAgentActions.id, ids));
  for (const r of rows) {
    const verb = r.direction === "reverse" ? `restore (undo ${r.action}) of` : r.action;
    out.set(`${VENDOR_AGENT_CONTROL_APPROVAL_PREFIX}${r.id}`, `${verb} the ${r.registry} agent '${r.name}'`);
  }
  return out;
}

/** the decision's own failure inside its transaction: the whole decision rolls back */
export class VendorAgentControlDecideError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "VendorAgentControlDecideError";
  }
}

/**
 * Inside the decision's transaction. The approver's grant is spent here, with the writes. Approved: the action moves
 * `requested → approved` (the requester may execute it once). Denied: it moves `requested → denied`; nothing is sent.
 */
export async function applyVendorAgentControlDecision(
  tx: Db,
  approval: ApprovalLike,
  decision: "approved" | "denied",
  deciderUserId: string,
  req: FastifyRequest | undefined,
): Promise<void> {
  const [r] = await tx.select().from(vendorAgentActions).where(eq(vendorAgentActions.approvalId, approval.id)).for("update");
  if (!r || r.status !== "requested") return;
  if (!req || !approval.argumentsDigest) throw new VendorAgentControlDecideError(403, "step_up_required", "a vendor agent control action needs the approver's step-up");
  const su = await checkStepUp(tx, req, vendorControlDecideStepUp(approval.id, decision, approval.argumentsDigest), { spend: true });
  if (!su.ok) throw new VendorAgentControlDecideError(su.status, String(su.body.error ?? "step_up_required"), "the approver's step-up was not accepted");
  const event = decision === "approved" ? "approve" : "deny";
  const [moved] = await tx
    .update(vendorAgentActions)
    .set({ status: VENDOR_ACTION_MACHINE.next(r.status, event), updatedAt: sql`now()`, ...(event === "deny" ? { outcomeCode: "denied_by_approver", settledAt: sql`now()` } : {}) })
    .where(and(eq(vendorAgentActions.id, r.id), whereFrom(vendorAgentActions.status, VENDOR_ACTION_MACHINE, event)))
    .returning();
  if (!moved) return;
  await auditWith(deciderUserId)(tx, r.id, `vendor-agent-control-${moved.status}`, event === "approve" ? "allow" : "deny", `a vendor agent control action was ${moved.status} by the approver (step-up ${su.method}) (ADR-0338)`, {
    ...fixedFields(moved),
    approvalId: approval.id,
    stepUp: su.method,
  });
}
