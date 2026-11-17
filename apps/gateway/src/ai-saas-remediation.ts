/**
 * ADR-0361 slice 3 — OPTIONAL REMEDIATION: deleting a monitored conversation through the vendor's documented API.
 *
 * Secure by default (ADR-0180), and narrowing only: the one action is a delete (no vendor documents a quarantine, so
 * none is offered, and nothing here can restore, share or widen anything).
 *
 *  - OFF twice: `ai_saas_monitor_policy.remediation_enabled` (on = a `settings_relax` step-up, refused air-gapped), and
 *    a separate delete-capable `remediate` credential per connector (the read key stays read-only).
 *  - REQUEST (`settings_relax` step-up bound to the interaction and action): one transaction writes the action row
 *    (`requested`), a pending approval of kind `ai_saas_remediation` naming an approver who is an active admin other
 *    than the requester, and an audit row. One open action per connector and conversation.
 *  - APPROVE in the existing Approvals Queue (`POST /v1/approvals/:id/decide`): the requester can never decide it
 *    (`cannot_approve_own_ai_saas_remediation`), and every decision needs a fresh `approval_decide` step-up
 *    (`precheckAiSaasRemediationDecision`, wired into the decide path).
 *  - EXECUTE (requester, fresh step-up): re-reads every switch, the delete key and the approval; the approved
 *    approval's digest must equal the action's; the approval is consumed once (conditional update); the action moves
 *    `approved → executing` with a lease; the vendor call runs OUTSIDE any transaction through `runExternalWrite`
 *    (ADR-0124: a non-normal execution mode refuses it); the outcome is written with its audit row.
 *  - A timeout or a crash leaves `unknown` (a lease in the past moves `executing → unknown` the next time the action
 *    is touched). SETTLE reads the conversation where the vendor documents a read, else repeats the same idempotent
 *    delete (a 404 means it is gone); it never runs a different action and needs no second approval.
 *  - Every state change is a conditional UPDATE on `AI_SAAS_REMEDIATION_MACHINE.sourcesOf(event)` (ADR-0348), with
 *    its audit row in the same transaction. The approval's state is folded in lazily when the action is next touched,
 *    as ADR-0338 does: an approval decided, denied or expired moves the action, and nothing runs on a timer.
 *  - No vendor text reaches a row, a response or an audit row: outcomes are fixed codes plus the HTTP status.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiSaasInteractions,
  aiSaasMonitorConnectors,
  aiSaasMonitorPolicy,
  aiSaasRemediations,
  and,
  approvals,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
  users,
  type AiSaasRemediationRow,
  type Db,
} from "@regulait/db";
import {
  AI_SAAS_REMEDIATION_ACTIONS,
  AI_SAAS_REMEDIATION_MACHINE,
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  type AiSaasMonitorVendor,
  type AiSaasRemediationStatus,
} from "@regulait/shared";
import { AI_SAAS_CONNECTORS, ConnectorError, type RemediationTarget } from "./ai-saas-connectors.js";
import { audit, connectorContextFor, liveCredential, loadAiSaasPolicy, type AiSaasMonitorDeps } from "./ai-saas-monitor.js";
import { resolveDeployMode } from "./deploy-posture.js";
import { ExternalEffectBlockedError, runExternalWrite } from "./external-effects.js";
import { loadOrgSettings } from "./org-settings.js";
import { decryptSecret } from "./secrets.js";
import { checkStepUp, requireStepUp } from "./step-up.js";

type RemediationEvent = keyof (typeof AI_SAAS_REMEDIATION_MACHINE)["def"]["transitions"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** the vendor call's own deadline; the lease adds a margin so a live call is never taken over */
const VENDOR_DEADLINE_MS = 30_000;
const LEASE_MARGIN_SECONDS = 60;
const DEFAULT_APPROVAL_TTL_HOURS = 24;
const PAGE = 50;

export const AI_SAAS_REMEDIATION_RULE_IDS = {
  policyChanged: "ai-saas-remediation-policy-changed",
  requested: "ai-saas-remediation-requested",
  transitioned: "ai-saas-remediation-transitioned",
} as const;

const unexpired = () => or(isNull(approvals.expiresAt), gt(approvals.expiresAt, sql`now()`));

/** the facts the approval binds: what will be deleted, where, and who asked (RAW, pre-scrub: ADR-0104) */
function remediationDigest(r: { connectorId: string; conversationRef: string; actorRef: string | null; action: string; requestedBy: string }): string {
  return approvalArgumentsDigest({ arguments: { op: "ai_saas_remediation", ...r } });
}

/**
 * One state change through the declared machine: a conditional UPDATE on the states `event` may leave from, and the
 * audit row in the same transaction. Returns the new row, or null when the row was not in a source state (a race or
 * a stale client), in which case nothing was written.
 */
async function transition(
  tx: Db | Tx,
  row: AiSaasRemediationRow,
  event: RemediationEvent,
  actorUserId: string | null,
  extra: { outcomeCode?: string | null; vendorStatus?: number | null; leaseSeconds?: number } = {},
): Promise<AiSaasRemediationRow | null> {
  const to = AI_SAAS_REMEDIATION_MACHINE.def.transitions[event].to as AiSaasRemediationStatus;
  const terminal = AI_SAAS_REMEDIATION_MACHINE.isTerminal(to);
  const [updated] = await tx
    .update(aiSaasRemediations)
    .set({
      status: to,
      updatedAt: sql`now()`,
      leaseExpiresAt: to === "executing" ? sql`now() + make_interval(secs => ${extra.leaseSeconds ?? VENDOR_DEADLINE_MS / 1000 + LEASE_MARGIN_SECONDS})` : null,
      ...(extra.outcomeCode !== undefined ? { outcomeCode: extra.outcomeCode } : {}),
      ...(extra.vendorStatus !== undefined ? { vendorStatus: extra.vendorStatus } : {}),
      ...(terminal ? { finishedAt: sql`now()` } : {}),
    })
    .where(and(eq(aiSaasRemediations.id, row.id), inArray(aiSaasRemediations.status, [...AI_SAAS_REMEDIATION_MACHINE.sourcesOf(event)])))
    .returning();
  if (!updated) return null;
  await audit(tx, actorUserId, "ai_saas_remediation", row.id, AI_SAAS_REMEDIATION_RULE_IDS.transitioned, to === "failed" || to === "denied" ? "deny" : "allow",
    `AI SaaS remediation ${row.action} ${row.status} -> ${to} (${event})${extra.outcomeCode ? `: ${extra.outcomeCode}` : ""}`,
    {
      remediationId: row.id,
      connectorId: row.connectorId,
      action: row.action,
      conversationRef: row.conversationRef,
      transition: { from: row.status, to, event },
      outcomeCode: extra.outcomeCode ?? null,
      vendorStatus: extra.vendorStatus ?? null,
      machine: AI_SAAS_REMEDIATION_MACHINE.def.id,
    });
  return updated;
}

/**
 * Fold the approval's state and an expired lease into the action, lazily (ADR-0338 §4): a `requested` action whose
 * approval was approved moves to `approved`, denied to `denied`, expired or superseded to `cancelled`; an `approved`
 * one whose approval expired is cancelled; an `executing` one past its lease is `unknown`.
 */
export async function reconcileRemediation(db: Db, row: AiSaasRemediationRow): Promise<AiSaasRemediationRow> {
  let cur = row;
  if (cur.status === "executing" && cur.leaseExpiresAt) {
    const [stale] = await db
      .select({ id: aiSaasRemediations.id })
      .from(aiSaasRemediations)
      .where(and(eq(aiSaasRemediations.id, cur.id), eq(aiSaasRemediations.status, "executing"), lt(aiSaasRemediations.leaseExpiresAt, sql`now()`)));
    if (stale) cur = (await db.transaction((tx) => transition(tx, cur, "lose", null, { outcomeCode: "lease_expired" }))) ?? cur;
    return cur;
  }
  if ((cur.status !== "requested" && cur.status !== "approved") || !cur.approvalId) return cur;
  const [a] = await db
    .select({ status: approvals.status, decidedBy: approvals.decidedBy, live: sql<boolean>`(${approvals.expiresAt} IS NULL OR ${approvals.expiresAt} > now())` })
    .from(approvals)
    .where(eq(approvals.id, cur.approvalId));
  if (!a) return cur;
  const step = async (event: RemediationEvent, by: string | null, code: string | null) =>
    (await db.transaction((tx) => transition(tx, cur, event, by, { outcomeCode: code }))) ?? cur;
  if (cur.status === "requested") {
    if (a.status === "approved" && a.live) return step("approve", a.decidedBy, null);
    if (a.status === "denied") return step("deny", a.decidedBy, "approval_denied");
    if (a.status === "superseded" || ((a.status === "pending" || a.status === "approved") && !a.live)) return step("cancel", null, "approval_expired");
  } else if (cur.status === "approved" && a.status === "approved" && !a.live) {
    return step("cancel", null, "approval_expired");
  }
  return cur;
}

/**
 * The decide path's per-kind guard for `ai_saas_remediation` (wired into `decideOneApprovalUnguarded`): the requester
 * can never decide their own action, and every decision needs a fresh `approval_decide` step-up bound to the
 * approval and the decision, so an API key, a chat tap or a bulk decide cannot decide this kind.
 */
export async function precheckAiSaasRemediationDecision(
  db: Db,
  approval: { id: string; userId: string },
  deciderUserId: string,
  decision: "approved" | "denied",
  req: FastifyRequest | undefined,
  channel: "http" | "chat" | "bulk" | undefined,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (approval.userId === deciderUserId) {
    return { status: 403, body: { error: "cannot_approve_own_ai_saas_remediation", detail: "the person who requested a conversation deletion cannot decide it" } };
  }
  if (!req || (channel && channel !== "http")) {
    return { status: 403, body: { error: "step_up_required", detail: "deciding a conversation deletion needs a fresh step-up, which only an interactive session can give" } };
  }
  const su = await checkStepUp(db, req, { kind: "approval_decide", facts: { op: "ai_saas_remediation", approvalId: approval.id, decision }, channel: "http" });
  return su.ok ? null : { status: su.status, body: su.body };
}

function view(r: AiSaasRemediationRow, blocked: Partial<Record<RemediationEvent, string>> = {}) {
  return {
    id: r.id,
    connectorId: r.connectorId,
    interactionId: r.interactionId,
    action: r.action,
    conversationRef: r.conversationRef,
    status: r.status,
    approvalId: r.approvalId,
    requestedBy: r.requestedBy,
    outcomeCode: r.outcomeCode,
    vendorStatus: r.vendorStatus,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    // ADR-0348: what state it is in and what may happen next, the same answer for people, the UI and agents
    lifecycle: AI_SAAS_REMEDIATION_MACHINE.describe(r.status, blocked),
  };
}

const reason = z.string().trim().min(3).max(500);
const policyBody = z.object({ enabled: z.boolean(), reason }).strict();
const requestBody = z
  .object({ interactionId: z.string().uuid(), action: z.enum(AI_SAAS_REMEDIATION_ACTIONS), approverUserId: z.string().uuid().optional(), reason })
  .strict();
const idParam = z.object({ remediationId: z.string().uuid() }).strict();
const cancelBody = z.object({ reason }).strict();

export function registerAiSaasRemediationRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; deps?: AiSaasMonitorDeps | undefined } = {}): void {
  const actor = (req: FastifyRequest): string | null => req.authCtx.userId ?? null;
  const bad = (detail: string) => ({ error: "invalid_body", detail });
  const registry = () => opts.deps?.connectors ?? AI_SAAS_CONNECTORS;
  const load = async (id: string) => {
    const [r] = await db.select().from(aiSaasRemediations).where(eq(aiSaasRemediations.id, id)).limit(1);
    return r ? reconcileRemediation(db, r) : null;
  };

  /** every switch the vendor call needs, re-read at the moment of use; null = all on */
  const switchesOff = async (connectorId: string, vendor: AiSaasMonitorVendor): Promise<{ status: number; body: Record<string, unknown> } | null> => {
    if (resolveDeployMode() === "air_gapped") return { status: 409, body: { error: "ai_saas_monitor_air_gapped", detail: "this deployment is air-gapped" } };
    const policy = await loadAiSaasPolicy(db);
    if (!policy.enabled) return { status: 409, body: { error: "ai_saas_monitor_disabled", detail: "AI SaaS monitoring is off for the organisation" } };
    if (!policy.remediationEnabled) return { status: 409, body: { error: "ai_saas_remediation_disabled", detail: "AI SaaS remediation is off for the organisation" } };
    if (!registry().get(vendor)?.remediation) return { status: 409, body: { error: "remediation_not_offered", detail: `the ${vendor} API documents no conversation delete` } };
    if (!(await liveCredential(db, connectorId, "remediate"))) return { status: 409, body: { error: "no_remediation_credential", detail: "store the connector's delete-capable credential first" } };
    return null;
  };

  app.put("/v1/ai-saas-monitoring/remediation", async (req, reply) => {
    const parsed = policyBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { enabled: boolean, reason: string (3-500 characters) }"));
    const { enabled } = parsed.data;
    if (enabled && resolveDeployMode() === "air_gapped") return reply.status(409).send({ error: "ai_saas_monitor_air_gapped", detail: "this deployment is air-gapped" });
    const before = await loadAiSaasPolicy(db);
    if (enabled && !before.remediationEnabled && !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { aiSaasRemediation: true, values: { enabled: true } } })).ok) return reply;
    await db.transaction(async (tx) => {
      await tx
        .insert(aiSaasMonitorPolicy)
        .values({ id: "singleton", remediationEnabled: enabled, updatedBy: actor(req) })
        .onConflictDoUpdate({ target: aiSaasMonitorPolicy.id, set: { remediationEnabled: enabled, updatedBy: actor(req), updatedAt: sql`now()` } });
      await audit(tx, actor(req), "ai_saas_monitor_policy", null, AI_SAAS_REMEDIATION_RULE_IDS.policyChanged, "allow",
        `AI SaaS remediation ${before.remediationEnabled ? "on" : "off"} -> ${enabled ? "on" : "off"}: ${parsed.data.reason}`,
        { transition: { from: before.remediationEnabled, to: enabled }, reason: parsed.data.reason, receiptClass: "configuration" });
    });
    return reply.send({ remediation: { enabled } });
  });

  app.post("/v1/ai-saas-monitoring/remediations", async (req, reply) => {
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { interactionId, action: 'delete_conversation', approverUserId?, reason }"));
    const requester = actor(req);
    if (!requester) return reply.status(403).send({ error: "bootstrap_cannot_request", detail: "a remediation is requested by a named admin" });
    const [interaction] = await db.select().from(aiSaasInteractions).where(eq(aiSaasInteractions.id, parsed.data.interactionId)).limit(1);
    if (!interaction) return reply.status(404).send({ error: "not_found" });
    if (!interaction.conversationRef) return reply.status(409).send({ error: "no_conversation", detail: "the interaction names no conversation to delete" });
    const [connector] = await db.select().from(aiSaasMonitorConnectors).where(eq(aiSaasMonitorConnectors.id, interaction.connectorId));
    const off = await switchesOff(connector!.id, connector!.vendor);
    if (off) return reply.status(off.status).send(off.body);
    const facts = { op: "ai_saas_remediation", interactionId: interaction.id, action: parsed.data.action };
    // an identical open request is answered idempotently BEFORE any step-up is spent
    const [open] = await db
      .select()
      .from(aiSaasRemediations)
      .where(and(eq(aiSaasRemediations.connectorId, connector!.id), eq(aiSaasRemediations.conversationRef, interaction.conversationRef), inArray(aiSaasRemediations.status, ["requested", "approved", "executing", "unknown"])));
    if (open) {
      const cur = await reconcileRemediation(db, open);
      if (!AI_SAAS_REMEDIATION_MACHINE.isTerminal(cur.status)) {
        if (cur.requestedBy === requester && cur.action === parsed.data.action) return reply.send({ remediation: view(cur), idempotent: true });
        return reply.status(409).send({ error: "remediation_already_open", remediation: view(cur) });
      }
    }
    const org = await loadOrgSettings(db);
    const approverUserId = parsed.data.approverUserId ?? org.infraApproverUserId ?? null;
    if (!approverUserId) return reply.status(422).send({ error: "approver_required", detail: "name approverUserId, or set a default approver in org settings" });
    if (approverUserId === requester) return reply.status(403).send({ error: "caller_cannot_approve", detail: "the requester cannot approve their own deletion" });
    const [approver] = await db.select({ id: users.id, isAdmin: users.isAdmin, disabledAt: users.disabledAt }).from(users).where(eq(users.id, approverUserId));
    if (!approver || approver.disabledAt || !approver.isAdmin) return reply.status(422).send({ error: "approver_not_eligible", detail: "the approver must be an active admin" });
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts })).ok) return reply;
    const target = { connectorId: connector!.id, conversationRef: interaction.conversationRef, actorRef: interaction.actorRef, action: parsed.data.action, requestedBy: requester };
    const digest = remediationDigest(target);
    const ttlHours = org.approvalTtlHours ?? DEFAULT_APPROVAL_TTL_HOURS;
    try {
      const row = await db.transaction(async (tx) => {
        const [r] = await tx
          .insert(aiSaasRemediations)
          .values({ connectorId: connector!.id, interactionId: interaction.id, action: parsed.data.action, conversationRef: interaction.conversationRef!, actorRef: interaction.actorRef, argumentsDigest: digest, requestedBy: requester, requestReason: parsed.data.reason })
          .returning();
        const [a] = await tx
          .insert(approvals)
          .values({
            userId: requester,
            objectType: "ai_saas_remediation",
            approverUserId,
            stageId: `__ai_saas_remediation__:${r!.id}`,
            argumentsDigest: digest,
            argumentsPreview: approvalArgumentsPreview({ vendor: connector!.vendor, connector: connector!.name, action: parsed.data.action, conversation: interaction.conversationRef, actor: interaction.actorRef }),
            argumentsPreviewKind: "arguments_v1",
            approvalScope: "action",
            status: "pending",
            expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
          })
          .returning({ id: approvals.id });
        const [linked] = await tx.update(aiSaasRemediations).set({ approvalId: a!.id }).where(eq(aiSaasRemediations.id, r!.id)).returning();
        await audit(tx, requester, "ai_saas_remediation", r!.id, AI_SAAS_REMEDIATION_RULE_IDS.requested, "require_approval",
          `deletion of ${connector!.vendor} conversation requested, waiting for approval '${a!.id}': ${parsed.data.reason}`,
          { remediationId: r!.id, approvalId: a!.id, approverUserId, connectorId: connector!.id, action: parsed.data.action, conversationRef: interaction.conversationRef, argumentsDigest: digest, reason: parsed.data.reason });
        return linked!;
      });
      return reply.status(202).send({ remediation: view(row), status: "pending_approval" });
    } catch (err) {
      const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505") return reply.status(409).send({ error: "remediation_already_open" });
      throw err;
    }
  });

  app.get("/v1/ai-saas-monitoring/remediations", async (req, reply) => {
    const q = z.object({ before: z.string().uuid().optional() }).strict().safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send(bad("expected ?before=<remediation id>"));
    let cursor: { createdAt: Date; id: string } | null = null;
    if (q.data.before) {
      const [c] = await db.select({ createdAt: aiSaasRemediations.createdAt, id: aiSaasRemediations.id }).from(aiSaasRemediations).where(eq(aiSaasRemediations.id, q.data.before));
      if (!c) return reply.status(400).send(bad("before must name a remediation"));
      cursor = c;
    }
    const rows = await db
      .select()
      .from(aiSaasRemediations)
      .where(cursor ? sql`(${aiSaasRemediations.createdAt}, ${aiSaasRemediations.id}) < (${cursor.createdAt}, ${cursor.id})` : undefined)
      .orderBy(desc(aiSaasRemediations.createdAt), desc(aiSaasRemediations.id))
      .limit(PAGE);
    const current = await Promise.all(rows.map((r) => reconcileRemediation(db, r)));
    return reply.send({ remediations: current.map((r) => view(r)), machine: AI_SAAS_REMEDIATION_MACHINE.toJSON(), nextBefore: rows.length === PAGE ? rows[rows.length - 1]!.id : null });
  });

  app.get("/v1/ai-saas-monitoring/remediations/:remediationId", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const r = await load(p.data.remediationId);
    if (!r) return reply.status(404).send({ error: "not_found" });
    return reply.send({ remediation: view(r) });
  });

  /** the vendor call, outside any transaction, through the kill switch; a timeout or crash is `unknown`, never a guess */
  const callVendor = async (r: AiSaasRemediationRow, mode: "delete" | "settle"): Promise<{ event: RemediationEvent; outcomeCode: string; vendorStatus: number | null }> => {
    const [connector] = await db.select().from(aiSaasMonitorConnectors).where(eq(aiSaasMonitorConnectors.id, r.connectorId));
    const impl = registry().get(connector!.vendor);
    const cred = await liveCredential(db, r.connectorId, "remediate");
    if (!impl?.remediation || !cred?.secretCiphertext || !opts.dataKey) return { event: "fail", outcomeCode: "no_remediation_credential", vendorStatus: null };
    const secrets: string[] = [];
    const secret = decryptSecret(opts.dataKey, cred.secretCiphertext);
    secrets.push(secret);
    const ctx = await connectorContextFor(db, connector!, impl, secret, secrets, AbortSignal.timeout(VENDOR_DEADLINE_MS), opts.deps);
    const target: RemediationTarget = { conversationRef: r.conversationRef, actorRef: r.actorRef };
    try {
      if (mode === "settle" && impl.remediation.conversationGone) {
        const gone = await impl.remediation.conversationGone(ctx, target);
        return gone ? { event: "succeed", outcomeCode: "verified_absent", vendorStatus: null } : { event: "fail", outcomeCode: "not_applied", vendorStatus: null };
      }
      const out = await runExternalWrite(db, "vendor.delete_conversation", () => impl.remediation!.deleteConversation(ctx, target));
      return { event: "succeed", outcomeCode: out.outcome === "deleted" ? "deleted" : "already_absent", vendorStatus: out.vendorStatus };
    } catch (err) {
      if (err instanceof ExternalEffectBlockedError) return { event: mode === "delete" ? "lose" : "fail", outcomeCode: "execution_mode_blocked", vendorStatus: null };
      if (err instanceof ConnectorError) {
        // the vendor answered and refused: nothing was deleted
        if (err.code === "unauthorized" || err.code === "forbidden" || err.code === "http_error") return { event: "fail", outcomeCode: `vendor_${err.code}`, vendorStatus: null };
      }
      // a timeout, a dropped connection or a throttle: the vendor state is uncertain
      return { event: mode === "delete" ? "lose" : "fail", outcomeCode: mode === "delete" ? "outcome_unknown" : "settle_unreadable", vendorStatus: null };
    }
  };

  app.post("/v1/ai-saas-monitoring/remediations/:remediationId/execute", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    let r = await load(p.data.remediationId);
    if (!r) return reply.status(404).send({ error: "not_found" });
    if (r.requestedBy !== actor(req)) return reply.status(403).send({ error: "not_the_requester", detail: "only the requester runs an approved deletion" });
    if (!AI_SAAS_REMEDIATION_MACHINE.can(r.status, "execute")) {
      return reply.status(409).send({ error: "illegal_transition", remediation: view(r, { execute: r.status === "requested" ? "waiting for approval" : `the action is ${r.status}` }) });
    }
    const [connector] = await db.select().from(aiSaasMonitorConnectors).where(eq(aiSaasMonitorConnectors.id, r.connectorId));
    const off = await switchesOff(connector!.id, connector!.vendor);
    if (off) return reply.status(off.status).send(off.body);
    // the approved payload must be exactly what runs (ADR-0104)
    if (remediationDigest({ connectorId: r.connectorId, conversationRef: r.conversationRef, actorRef: r.actorRef, action: r.action, requestedBy: r.requestedBy }) !== r.argumentsDigest) {
      return reply.status(409).send({ error: "approval_payload_mismatch" });
    }
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "ai_saas_remediation_execute", remediationId: r.id } })).ok) return reply;
    const started = await db.transaction(async (tx) => {
      const spent = await tx
        .update(approvals)
        .set({ status: "consumed" })
        .where(and(eq(approvals.id, r!.approvalId!), eq(approvals.status, "approved"), eq(approvals.argumentsDigest, r!.argumentsDigest), unexpired()))
        .returning({ id: approvals.id });
      if (spent.length !== 1) return null;
      return transition(tx, r!, "execute", actor(req));
    });
    if (!started) return reply.status(409).send({ error: "approval_not_usable", detail: "the approval was already used, expired or changed" });
    r = started;
    const out = await callVendor(r, "delete");
    const done = (await db.transaction((tx) => transition(tx, r!, out.event, actor(req), { outcomeCode: out.outcomeCode, vendorStatus: out.vendorStatus }))) ?? r;
    return reply.status(done.status === "succeeded" ? 200 : done.status === "unknown" ? 202 : 502).send({ remediation: view(done) });
  });

  app.post("/v1/ai-saas-monitoring/remediations/:remediationId/settle", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const r = await load(p.data.remediationId);
    if (!r) return reply.status(404).send({ error: "not_found" });
    if (r.status !== "unknown") return reply.status(409).send({ error: "illegal_transition", remediation: view(r, { succeed: `only an action whose outcome is unknown is settled; this one is ${r.status}` }) });
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "ai_saas_remediation_settle", remediationId: r.id } })).ok) return reply;
    const out = await callVendor(r, "settle");
    // an unreadable vendor leaves it unknown (still open), never a guessed outcome
    if (out.outcomeCode === "settle_unreadable" || out.outcomeCode === "execution_mode_blocked") return reply.status(202).send({ remediation: view(r), settled: false, outcomeCode: out.outcomeCode });
    const done = (await db.transaction((tx) => transition(tx, r, out.event, actor(req), { outcomeCode: out.outcomeCode, vendorStatus: out.vendorStatus }))) ?? r;
    return reply.send({ remediation: view(done), settled: true });
  });

  // withdrawing narrows: no step-up, by the requester or any admin (the default gate is admin-only)
  app.post("/v1/ai-saas-monitoring/remediations/:remediationId/cancel", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const parsed = cancelBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(bad("expected { reason }"));
    const r = await load(p.data.remediationId);
    if (!r) return reply.status(404).send({ error: "not_found" });
    if (!AI_SAAS_REMEDIATION_MACHINE.can(r.status, "cancel")) return reply.status(409).send({ error: "illegal_transition", remediation: view(r) });
    const done = await db.transaction(async (tx) => {
      const moved = await transition(tx, r, "cancel", actor(req), { outcomeCode: "withdrawn" });
      if (moved && r.approvalId) {
        await tx.update(approvals).set({ status: "superseded" }).where(and(eq(approvals.id, r.approvalId), inArray(approvals.status, ["pending", "approved"])));
      }
      return moved;
    });
    if (!done) return reply.status(409).send({ error: "illegal_transition" });
    return reply.send({ remediation: view(done) });
  });
}
