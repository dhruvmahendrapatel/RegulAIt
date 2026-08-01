import type { FastifyInstance } from "fastify";
import {
  and,
  approvals,
  auditLog,
  decisions,
  desc,
  eq,
  inArray,
  isNull,
  orchestrationRuns,
  pmConnections,
  pmLinks,
  pmSyncEvents,
  users,
  workflowInstances,
  type Db,
} from "@regulait/db";
import {
  PmProviderError,
  mappingFor,
  parseInboundWebhook,
  resolveApprovalAction,
  resolveDecisionAction,
  resolvePmProvider,
  resolveStatus,
  resolveTaskFields,
  type NormalizedInboundEvent,
} from "@regulait/pm-provider";
import type { RunState, TaskGraph } from "@regulait/orchestration-kernel";
import type { WorkflowDefinition } from "@regulait/workflow-kernel";
import {
  createDecisionSchema,
  createPmConnectionSchema,
  pmSyncSchema,
} from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
import {
  ConnectionEgressBlockedError,
  guardConnectionCall,
  refuseConnectionEgressWrite,
} from "./connection-egress.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const runIdParam = z.object({ runId: z.string().uuid() });

const CONNECTION_COLUMNS = {
  id: pmConnections.id,
  name: pmConnections.name,
  provider: pmConnections.provider,
  baseUrl: pmConnections.baseUrl,
  project: pmConnections.project,
  mapping: pmConnections.mapping,
  apiVersion: pmConnections.apiVersion,
  createdAt: pmConnections.createdAt,
};

/**
 * ADR-0034 amendment #2 — EVERY PM PROVIDER RESOLUTION GOES THROUGH THE EGRESS
 * GUARD.
 *
 * `pm_connections.baseUrl` is admin-typed (the SPA exposes the field) and is
 * the root every Jira/ADO/Linear/Asana/monday call is issued against — and for
 * `generic_webhook` it is a URL this gateway **POSTs work-item content to**, so
 * it is an exfiltration channel as well as an SSRF one. This function is the
 * single chokepoint through which all seven call sites in this file resolve a
 * provider, so guarding it here guards the outbound path once rather than
 * seven times.
 *
 * It is async now, and it can throw `ConnectionEgressBlockedError`. The two
 * `pm-sync` endpoints turn that into a real 403; every other site already sits
 * inside a `try` that surfaces the failure to the caller (a mirror reports
 * `{ok:false,error}` and the link's `lastSyncedAt` stays visibly stale) — in
 * all cases nothing leaves the box.
 *
 * A null `baseUrl` (mock, and Linear/Asana/monday on their vendor defaults) is
 * unchecked and gets the global fetch: nobody can type a compiled endpoint.
 */
async function providerFor(
  db: Db,
  conn: {
    id: string;
    name: string;
    provider: (typeof pmConnections.$inferSelect)["provider"];
    baseUrl: string | null;
    apiVersion: number | null;
    tokenCiphertext: string;
  },
  dataKey: string,
  ctx: { userId?: string | null; detail?: Record<string, unknown> } = {},
) {
  let pmFetch: typeof fetch | undefined;
  if (conn.baseUrl) {
    pmFetch = (
      await guardConnectionCall(db, {
        surface: "pm_connection",
        baseUrl: conn.baseUrl,
        userId: ctx.userId ?? null,
        objectId: conn.id,
        label: `pm connection '${conn.name}' (${conn.provider})`,
        detail: { connection: conn.name, provider: conn.provider, ...(ctx.detail ?? {}) },
      })
    ).fetchImpl;
  }
  return resolvePmProvider(
    {
      provider: conn.provider,
      token: decryptSecret(dataKey, conn.tokenCiphertext),
      baseUrl: conn.baseUrl,
      apiVersion: conn.apiVersion,
    },
    pmFetch as unknown as Parameters<typeof resolvePmProvider>[1],
  );
}

/** §3/§5 outbound mirror: RegulAIt owns node status (it owns the state
 * machine), so status changes flow out through the mapping's statusMap. An
 * unmapped status is skipped, never invented; a provider failure is surfaced
 * to the caller and never fails the run event itself. Returns null when there
 * is nothing to mirror. */
export async function mirrorNodeStatus(
  db: Db,
  dataKey: string | undefined,
  runId: string,
  nodeId: string,
  nodeStatus: string,
  actorUserId: string,
): Promise<{ ok: boolean; state?: string; error?: string } | null> {
  // Orphaned links (item deleted in the tool, or unrepairable at sync time)
  // are dead: mirrors skip them rather than writing into the void.
  const [link] = await db
    .select()
    .from(pmLinks)
    .where(
      and(
        eq(pmLinks.objectType, "run_node"),
        eq(pmLinks.objectId, runId),
        eq(pmLinks.nodeId, nodeId),
        isNull(pmLinks.orphanedAt),
      ),
    );
  if (!link || !dataKey) return null;
  const [conn] = await db.select().from(pmConnections).where(eq(pmConnections.id, link.connectionId));
  if (!conn) return null;
  const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
  const state = resolveStatus(mapping, nodeStatus);
  if (state === null) return null;
  try {
    const provider = await providerFor(db, conn, dataKey, {
      userId: actorUserId,
      detail: { op: "mirror_node_status", runId, nodeId },
    });
    await provider.transitionState(conn.project, link.externalId, state);
    await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, link.id));
    await db.insert(auditLog).values({
      userId: actorUserId,
      objectType: "pm_work_item",
      objectId: runId,
      detail: { nodeId, externalId: link.externalId, state, connection: conn.name },
      effect: "allow",
      ruleId: "pm-status-mirrored",
      ruleChain: [],
      reason: `node '${nodeId}' status '${nodeStatus}' mirrored to PM state '${state}'`,
    });
    return { ok: true, state };
  } catch (err) {
    // §3 "never drift silently": the failure is returned to the caller and
    // the link's lastSyncedAt stays stale — visible, not hidden.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** §5: mirror a decided sign-off onto the linked work item — a status
 * transition when the mapping names one for this stage, a comment otherwise
 * (never a silent drop). Strictly a mirror of the ONE approvals queue: the
 * decision is already made and recorded; a mirror failure never unwinds it. */
export async function mirrorApprovalDecision(
  db: Db,
  dataKey: string | undefined,
  approvalRow: {
    objectType: string;
    instanceId: string | null;
    runId: string | null;
    stageId: string | null;
    status: string;
    decisionReason: string | null;
  },
  deciderUserId: string,
): Promise<{ ok: boolean; action?: string; error?: string } | null> {
  if (!dataKey || !approvalRow.stageId) return null;
  // O8 (ADR-0027): a RUN BUDGET-CAP escalation decision mirrors too — onto
  // the RUN-LEVEL PARENT work item (which exists for exactly this), always
  // as a COMMENT: a budget sanction is not a stage outcome, so it must never
  // enter a customer's "Approved" state. Both directions (approved AND
  // denied) mirror — decide-hook parity with sign-offs.
  const isBudgetEscalation =
    approvalRow.objectType === "run" &&
    (approvalRow.stageId.startsWith("__budget__") ||
      approvalRow.stageId.startsWith("__nodebudget__"));
  let linkWhere;
  if (approvalRow.objectType === "workflow" && approvalRow.instanceId) {
    linkWhere = and(
      eq(pmLinks.objectType, "workflow_instance"),
      eq(pmLinks.objectId, approvalRow.instanceId),
      isNull(pmLinks.nodeId),
      isNull(pmLinks.orphanedAt),
    );
  } else if (isBudgetEscalation && approvalRow.runId) {
    linkWhere = and(
      eq(pmLinks.objectType, "run"),
      eq(pmLinks.objectId, approvalRow.runId),
      isNull(pmLinks.orphanedAt),
    );
  } else if (approvalRow.objectType === "run" && approvalRow.runId) {
    linkWhere = and(
      eq(pmLinks.objectType, "run_node"),
      eq(pmLinks.objectId, approvalRow.runId),
      eq(pmLinks.nodeId, approvalRow.stageId),
      isNull(pmLinks.orphanedAt),
    );
  } else {
    return null;
  }
  const [link] = await db.select().from(pmLinks).where(linkWhere);
  if (!link) return null;
  const [conn] = await db.select().from(pmConnections).where(eq(pmConnections.id, link.connectionId));
  if (!conn) return null;
  const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
  // Sign-off decisions only transition on approval; a denial is always a
  // comment — a customer's "Approved" state must never be entered on a deny.
  // O8: a budget escalation is ALWAYS a comment (never a transition) — a
  // spend sanction is a first-class linked record, not a stage state.
  const action =
    approvalRow.status === "approved" && !isBudgetEscalation
      ? resolveApprovalAction(mapping, approvalRow.stageId)
      : ({ kind: "comment" } as const);
  try {
    const provider = await providerFor(db, conn, dataKey, {
      userId: deciderUserId,
      detail: { op: "mirror_approval_decision", stageId: approvalRow.stageId },
    });
    const [decider] = await db.select({ email: users.email }).from(users).where(eq(users.id, deciderUserId));
    const nodeRef = isBudgetEscalation ? approvalRow.stageId.split(":")[1] : null;
    const note = isBudgetEscalation
      ? `[RegulAIt] budget-cap escalation${nodeRef ? ` (node '${nodeRef}')` : ""} ${approvalRow.status === "approved" ? "SANCTIONED — another attempt may run" : "DENIED — the run stays capped"} by ${decider?.email ?? deciderUserId}` +
        (approvalRow.decisionReason ? `: ${approvalRow.decisionReason}` : "")
      : `[RegulAIt] sign-off '${approvalRow.stageId}' ${approvalRow.status} by ${decider?.email ?? deciderUserId}` +
        (approvalRow.decisionReason ? `: ${approvalRow.decisionReason}` : "");
    if (action.kind === "transition") {
      await provider.transitionState(conn.project, link.externalId, action.state);
    }
    await provider.addComment(conn.project, link.externalId, note);
    await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, link.id));
    await db.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "pm_work_item",
      objectId: approvalRow.instanceId ?? approvalRow.runId,
      detail: {
        stageId: approvalRow.stageId,
        externalId: link.externalId,
        decision: approvalRow.status,
        action: action.kind,
        ...(action.kind === "transition" ? { state: action.state } : {}),
      },
      effect: "allow",
      ruleId: isBudgetEscalation ? "pm-budget-decision-mirrored" : "pm-approval-mirrored",
      ruleChain: [],
      reason: isBudgetEscalation
        ? `budget-cap escalation decision (${approvalRow.status}) mirrored as a comment on the run's parent work item`
        : `sign-off '${approvalRow.stageId}' (${approvalRow.status}) mirrored as ${action.kind}`,
    });
    return { ok: true, action: action.kind };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerPmRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string }) {
  // Read-only widening for the PM strip's GETs, mirroring loadRunFor /
  // loadInstanceFor: the named approver of a PENDING approval on a run or
  // workflow instance may read its links/decisions (200 with [] when there is
  // nothing) — they can already read the object itself, and a guaranteed 404
  // under their cross-read was pure console noise. Every write keeps the
  // admin/initiator gate.
  const isPendingApproverOn = async (
    userId: string | null,
    ref: { runId?: string; instanceId?: string },
  ): Promise<boolean> => {
    if (!userId) return false;
    const scope = ref.runId
      ? eq(approvals.runId, ref.runId)
      : eq(approvals.instanceId, ref.instanceId!);
    const [naming] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(scope, eq(approvals.approverUserId, userId), eq(approvals.status, "pending")),
      )
      .limit(1);
    return Boolean(naming);
  };

  app.post("/v1/pm/connections", async (req, reply) => {
    const body = createPmConnectionSchema.parse(req.body);
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "pm_connections_require_data_key" });
    }
    // Validate the mapping override (or confirm a default exists) and the
    // provider up front — a connection that can never resolve is a 422 now,
    // not a surprise at sync time.
    try {
      mappingFor(body.provider, body.mapping);
      resolvePmProvider({
        provider: body.provider,
        token: body.token,
        baseUrl: body.baseUrl ?? null,
        apiVersion: body.apiVersion ?? null,
      });
    } catch (err) {
      if (err instanceof PmProviderError) {
        return reply.status(422).send({ error: "unsupported_pm_provider", detail: err.message });
      }
      throw err; // zod mapping errors → 400 via the app error handler
    }
    // ADR-0034 amendment #2 — the earliest honest failure for a PM endpoint.
    // NOT a substitute for the per-call check in providerFor: this is so an
    // IMDS/collector URL is a 400 at the moment an admin types it in the SPA.
    if (body.baseUrl) {
      const refusal = await refuseConnectionEgressWrite(db, {
        surface: "pm_connection",
        baseUrl: body.baseUrl,
        userId: req.authCtx.userId ?? null,
        phase: "pm_connection_write",
        label: `pm connection '${body.name}' baseUrl`,
        detail: { name: body.name, provider: body.provider },
      });
      if (refusal) return reply.status(400).send(refusal);
    }
    // ADR-0010: per-connection webhook secret — plaintext returned exactly
    // once. The hash is stored for the legacy shared-secret-header check;
    // an AES-256-GCM ciphertext is stored alongside because provider-native
    // verification (linear/asana HMAC signatures, generic's signed envelope)
    // must re-derive MACs from the secret itself — a hash cannot key an HMAC.
    const webhookSecret = `rglwh_${randomBytes(24).toString("hex")}`;
    const [row] = await db
      .insert(pmConnections)
      .values({
        name: body.name,
        provider: body.provider,
        baseUrl: body.baseUrl ?? null,
        project: body.project,
        tokenCiphertext: encryptSecret(opts.dataKey, body.token),
        mapping: body.mapping ?? null,
        apiVersion: body.apiVersion ?? null,
        webhookSecretHash: sha256(webhookSecret),
        webhookSecretCiphertext: encryptSecret(opts.dataKey, webhookSecret),
        // O7 (ADR-0027): drift policy — manual (today) unless the admin chose
        driftResolution: body.driftResolution ?? "manual",
      })
      .returning(CONNECTION_COLUMNS);
    return reply.status(201).send({ ...row, webhookSecret });
  });

  app.get("/v1/pm/connections", async () => ({
    connections: await db.select(CONNECTION_COLUMNS).from(pmConnections),
  }));

  // §2/§3: link every task-graph node to a real work item in the customer's
  // tool. Idempotent — already-linked nodes are skipped, not duplicated.
  app.post("/v1/runs/:runId/pm-sync", async (req, reply) => {
    const { runId } = runIdParam.parse(req.params);
    const body = pmSyncSchema.parse(req.body);
    const [run] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runId));
    if (!run) return reply.status(404).send({ error: "unavailable" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== run.initiatingUserId) {
      return reply.status(404).send({ error: "unavailable" });
    }
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_sync" });
    if (!opts.dataKey) return reply.status(503).send({ error: "pm_connections_require_data_key" });
    const [conn] = await db
      .select()
      .from(pmConnections)
      .where(eq(pmConnections.name, body.connectionName));
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });

    const graph = run.graph as TaskGraph;
    const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
    let provider;
    try {
      provider = await providerFor(db, conn, opts.dataKey, {
        userId: req.authCtx.userId,
        detail: { op: "run_pm_sync", runId },
      });
    } catch (err) {
      // ADR-0034 amendment #2 — a real 403 at the HTTP boundary that exists on
      // this path, with nothing having left the box and the attempt audited.
      if (err instanceof ConnectionEgressBlockedError) {
        return reply
          .status(403)
          .send({ error: "egress_blocked", code: err.decision.code, detail: err.decision.reason });
      }
      if (err instanceof PmProviderError) {
        return reply.status(422).send({ error: "unsupported_pm_provider", detail: err.message });
      }
      throw err;
    }
    // HONEST sync: every existing link is verified against the provider
    // before this call claims anything. Alive → verified. Missing → repaired
    // in place with a write against the same id (upsert-capable providers —
    // the mock — recreate it, so restart drift heals instead of festering).
    // Unrepairable → orphanedAt set, skipped by all future mirrors, reported.
    const allLinks = await db
      .select()
      .from(pmLinks)
      .where(and(inArray(pmLinks.objectType, ["run", "run_node"]), eq(pmLinks.objectId, runId)));
    const titleFor = (link: (typeof allLinks)[number]) =>
      link.objectType === "run"
        ? `run: ${graph.run}`
        : (graph.nodes.find((n) => n.id === link.nodeId)?.title ?? link.nodeId ?? "task");

    const verified: Array<{ nodeId: string | null; externalId: string }> = [];
    const repaired: Array<{ nodeId: string | null; externalId: string }> = [];
    const orphaned: Array<{ nodeId: string | null; externalId: string; error: string }> = [];
    for (const link of allLinks) {
      if (link.orphanedAt) continue; // known-dead from a previous pass; stays skipped
      try {
        await provider.getWorkItem(conn.project, link.externalId);
        verified.push({ nodeId: link.nodeId, externalId: link.externalId });
        continue;
      } catch (err) {
        if (!(err instanceof PmProviderError)) throw err;
      }
      try {
        await provider.updateFields(
          conn.project,
          link.externalId,
          resolveTaskFields(mapping, { title: titleFor(link) }),
        );
        await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, link.id));
        repaired.push({ nodeId: link.nodeId, externalId: link.externalId });
        await db.insert(auditLog).values({
          userId: req.authCtx.userId,
          objectType: "pm_work_item",
          objectId: runId,
          detail: { nodeId: link.nodeId, externalId: link.externalId, connection: conn.name, phase: "repair" },
          effect: "allow",
          ruleId: "pm-link-repaired",
          ruleChain: [],
          reason: `work item '${link.externalId}' was missing at the provider; recreated in place during sync`,
        });
      } catch (repairErr) {
        if (!(repairErr instanceof PmProviderError)) throw repairErr;
        await db.update(pmLinks).set({ orphanedAt: new Date() }).where(eq(pmLinks.id, link.id));
        orphaned.push({ nodeId: link.nodeId, externalId: link.externalId, error: repairErr.message });
        await db.insert(auditLog).values({
          userId: req.authCtx.userId,
          objectType: "pm_work_item",
          objectId: runId,
          detail: { nodeId: link.nodeId, externalId: link.externalId, connection: conn.name, phase: "orphan" },
          effect: "allow",
          ruleId: "pm-link-orphaned",
          ruleChain: [],
          reason: `work item '${link.externalId}' could not be verified or repaired (${repairErr.message}); link marked orphaned`,
        });
      }
    }

    // Idempotent creation for what has NO link row yet. Orphaned links keep
    // their row (and the unique index) — those objects stay visibly orphaned
    // rather than silently re-linked.
    const linked = new Set(
      allLinks.filter((l) => l.objectType === "run_node").map((l) => l.nodeId),
    );
    const hasRunLink = allLinks.some((l) => l.objectType === "run");
    if (!hasRunLink) {
      const ref = await provider.createWorkItem(
        conn.project,
        mapping.task.workItemType,
        resolveTaskFields(mapping, { title: `run: ${graph.run}` }),
      );
      await db.insert(pmLinks).values({
        connectionId: conn.id,
        objectType: "run",
        objectId: runId,
        nodeId: null,
        externalId: ref.id,
        externalUrl: ref.url,
        lastSyncedAt: new Date(),
      });
    }

    const created: Array<{ nodeId: string; externalId: string; externalUrl: string }> = [];
    for (const node of graph.nodes) {
      if (linked.has(node.id)) continue;
      // The node's multi-sentence instruction (gateway-level enrichment, see
      // orchestration.ts) seeds the work item's description — an INITIAL
      // value the PM tool owns from then on (§3), so it is set at creation
      // and never re-written by later syncs.
      const instruction = (node as { instruction?: unknown }).instruction;
      const ref = await provider.createWorkItem(
        conn.project,
        mapping.task.workItemType,
        resolveTaskFields(mapping, {
          title: node.title,
          ...(typeof instruction === "string" && instruction.trim()
            ? { description: instruction }
            : {}),
        }),
      );
      await db.insert(pmLinks).values({
        connectionId: conn.id,
        objectType: "run_node",
        objectId: runId,
        nodeId: node.id,
        externalId: ref.id,
        externalUrl: ref.url,
        lastSyncedAt: new Date(),
      });
      await db.insert(auditLog).values({
        userId: req.authCtx.userId,
        objectType: "pm_work_item",
        objectId: runId,
        detail: { nodeId: node.id, externalId: ref.id, connection: conn.name, phase: "create" },
        effect: "allow",
        ruleId: "pm-work-item-created",
        ruleChain: [],
        reason: `task-graph node '${node.id}' linked to ${conn.provider} work item '${ref.id}'`,
      });
      created.push({ nodeId: node.id, externalId: ref.id, externalUrl: ref.url });
    }
    return reply.status(201).send({
      created,
      verified,
      repaired,
      orphaned,
      skipped: [...linked].filter((n): n is string => n !== null),
    });
  });

  // §5: link a workflow instance to ONE work item so its sign-offs are
  // visible in the customer's tool without opening RegulAIt.
  app.post("/v1/workflows/instances/:instanceId/pm-sync", async (req, reply) => {
    const { instanceId } = z.object({ instanceId: z.string().uuid() }).parse(req.params);
    const body = pmSyncSchema.parse(req.body);
    const [instance] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    if (!instance) return reply.status(404).send({ error: "unavailable" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== instance.initiatorUserId) {
      return reply.status(404).send({ error: "unavailable" });
    }
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_sync" });
    if (!opts.dataKey) return reply.status(503).send({ error: "pm_connections_require_data_key" });
    const [conn] = await db
      .select()
      .from(pmConnections)
      .where(eq(pmConnections.name, body.connectionName));
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });

    const def = instance.definition as WorkflowDefinition;
    const change = instance.change as { description: string };
    const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
    let provider;
    try {
      provider = await providerFor(db, conn, opts.dataKey, {
        userId: req.authCtx.userId,
        detail: { op: "workflow_pm_sync", instanceId },
      });
    } catch (err) {
      // ADR-0034 amendment #2 — see the run pm-sync endpoint above.
      if (err instanceof ConnectionEgressBlockedError) {
        return reply
          .status(403)
          .send({ error: "egress_blocked", code: err.decision.code, detail: err.decision.reason });
      }
      if (err instanceof PmProviderError) {
        return reply.status(422).send({ error: "unsupported_pm_provider", detail: err.message });
      }
      throw err;
    }
    const title = `${def.workflow}: ${change.description}`;

    // Same honest-sync contract as the run endpoint: an existing link is
    // VERIFIED, not assumed — alive → verified, missing → repaired in place
    // (upsert), unrepairable → orphaned and skipped by future mirrors.
    const [existing] = await db
      .select()
      .from(pmLinks)
      .where(
        and(
          eq(pmLinks.objectType, "workflow_instance"),
          eq(pmLinks.objectId, instanceId),
          isNull(pmLinks.nodeId),
        ),
      );
    if (existing) {
      const base = { created: false, externalId: existing.externalId, externalUrl: existing.externalUrl };
      if (existing.orphanedAt) {
        return reply.status(200).send({ ...base, orphaned: true });
      }
      try {
        await provider.getWorkItem(conn.project, existing.externalId);
        return reply.status(200).send({ ...base, verified: true });
      } catch (err) {
        if (!(err instanceof PmProviderError)) throw err;
      }
      try {
        await provider.updateFields(
          conn.project,
          existing.externalId,
          resolveTaskFields(mapping, { title }),
        );
        await db.update(pmLinks).set({ lastSyncedAt: new Date() }).where(eq(pmLinks.id, existing.id));
        await db.insert(auditLog).values({
          userId: req.authCtx.userId,
          objectType: "pm_work_item",
          objectId: instanceId,
          detail: { externalId: existing.externalId, connection: conn.name, phase: "repair" },
          effect: "allow",
          ruleId: "pm-link-repaired",
          ruleChain: [],
          reason: `work item '${existing.externalId}' was missing at the provider; recreated in place during sync`,
        });
        return reply.status(200).send({ ...base, repaired: true });
      } catch (repairErr) {
        if (!(repairErr instanceof PmProviderError)) throw repairErr;
        await db.update(pmLinks).set({ orphanedAt: new Date() }).where(eq(pmLinks.id, existing.id));
        await db.insert(auditLog).values({
          userId: req.authCtx.userId,
          objectType: "pm_work_item",
          objectId: instanceId,
          detail: { externalId: existing.externalId, connection: conn.name, phase: "orphan" },
          effect: "allow",
          ruleId: "pm-link-orphaned",
          ruleChain: [],
          reason: `work item '${existing.externalId}' could not be verified or repaired (${repairErr.message}); link marked orphaned`,
        });
        return reply.status(200).send({ ...base, orphaned: true, error: repairErr.message });
      }
    }

    const ref = await provider.createWorkItem(
      conn.project,
      mapping.task.workItemType,
      resolveTaskFields(mapping, { title }),
    );
    await db.insert(pmLinks).values({
      connectionId: conn.id,
      objectType: "workflow_instance",
      objectId: instanceId,
      nodeId: null,
      externalId: ref.id,
      externalUrl: ref.url,
      lastSyncedAt: new Date(),
    });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId,
      objectType: "pm_work_item",
      objectId: instanceId,
      detail: { externalId: ref.id, connection: conn.name, phase: "create" },
      effect: "allow",
      ruleId: "pm-work-item-created",
      ruleChain: [],
      reason: `workflow instance linked to ${conn.provider} work item '${ref.id}'`,
    });
    return reply
      .status(201)
      .send({ created: true, externalId: ref.id, externalUrl: ref.url });
  });

  // ADR-0010 inbound processing for ONE normalized event — unchanged
  // semantics: every event lands in the append-only pm_sync_events log;
  // inbound state is recorded, never applied to the state machine; divergence
  // surfaces as drift in the links view and the one audit trail. The
  // provider-native translation layer (below) feeds this path.
  const processInboundEvent = async (
    conn: typeof pmConnections.$inferSelect,
    body: NormalizedInboundEvent,
  ): Promise<{ matched: false } | { matched: true; drift: boolean }> => {
    const [link] = await db
      .select()
      .from(pmLinks)
      .where(and(eq(pmLinks.connectionId, conn.id), eq(pmLinks.externalId, body.externalId)));
    await db.insert(pmSyncEvents).values({
      connectionId: conn.id,
      linkId: link?.id ?? null,
      externalId: body.externalId,
      kind: body.event,
      payload: {
        provider: conn.provider,
        ...(body.state ? { state: body.state } : {}),
        ...(body.fields ? { fields: body.fields } : {}),
      },
    });
    if (!link) return { matched: false };

    // attribute inbound audit rows to the parent object's initiator
    const ownerOf = async (): Promise<string | null> => {
      if (link.objectType === "run_node" || link.objectType === "run") {
        const [run] = await db
          .select({ owner: orchestrationRuns.initiatingUserId })
          .from(orchestrationRuns)
          .where(eq(orchestrationRuns.id, link.objectId));
        return run?.owner ?? null;
      }
      if (link.objectType === "workflow_instance") {
        const [instance] = await db
          .select({ owner: workflowInstances.initiatorUserId })
          .from(workflowInstances)
          .where(eq(workflowInstances.id, link.objectId));
        return instance?.owner ?? null;
      }
      return null;
    };

    let drift = false;
    if (body.event === "deleted") {
      await db.update(pmLinks).set({ orphanedAt: new Date() }).where(eq(pmLinks.id, link.id));
      const owner = await ownerOf();
      if (owner) {
        await db.insert(auditLog).values({
          userId: owner,
          objectType: "pm_work_item",
          objectId: link.objectId,
          detail: {
            externalId: link.externalId,
            linkType: link.objectType,
            event: "deleted",
            provider: conn.provider,
          },
          effect: "allow",
          ruleId: "pm-link-orphaned",
          ruleChain: [],
          reason: `work item '${link.externalId}' was deleted in the PM tool; link marked orphaned`,
        });
      }
    } else if (body.event === "updated" && body.state) {
      await db
        .update(pmLinks)
        .set({ inboundState: body.state, inboundAt: new Date() })
        .where(eq(pmLinks.id, link.id));
      // Drift (run nodes only — status ownership is RegulAIt's): the reported
      // state disagrees with the mapped state for the node's current status.
      if (link.objectType === "run_node" && link.nodeId) {
        const [run] = await db
          .select()
          .from(orchestrationRuns)
          .where(eq(orchestrationRuns.id, link.objectId));
        if (run) {
          const nodeStatus = (run.state as RunState).nodeStatuses[link.nodeId];
          const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
          const expected = nodeStatus ? resolveStatus(mapping, nodeStatus) : null;
          // O7: a state this connection already ADOPTED (prefer_pm) is no
          // longer a divergence — re-reports of it are quiet.
          if (expected !== null && body.state !== expected && body.state !== link.adoptedState) {
            drift = true;
            const auditDrift = async (extra: Record<string, unknown>, reason: string) =>
              db.insert(auditLog).values({
                userId: run.initiatingUserId,
                objectType: "pm_work_item",
                objectId: link.objectId,
                detail: {
                  nodeId: link.nodeId,
                  externalId: link.externalId,
                  reportedState: body.state,
                  expectedState: expected,
                  provider: conn.provider,
                  ...extra,
                },
                effect: "allow",
                ruleId: extra.resolution ? "pm-drift-auto-resolved" : "pm-drift-detected",
                ruleChain: [],
                reason,
              });
            // O7 (ADR-0027): per-connection drift policy. 'manual' (default =
            // today) surfaces only. The two auto modes resolve in the DECLARED
            // direction, audited with before/after; anything that cannot be
            // safely auto-resolved falls back to the surfaced manual path.
            if (conn.driftResolution === "prefer_regulait" && opts.dataKey) {
              try {
                // push RegulAIt's expected state back to the PM tool —
                // status ownership is RegulAIt's, so this direction is safe
                const drifted = await providerFor(db, conn, opts.dataKey, {
                  detail: { op: "drift_resolution", resolution: "prefer_regulait" },
                });
                await drifted.transitionState(conn.project, link.externalId, expected);
                await db
                  .update(pmLinks)
                  .set({ lastSyncedAt: new Date() })
                  .where(eq(pmLinks.id, link.id));
                drift = false;
                await auditDrift(
                  { resolution: "prefer_regulait", before: body.state, after: expected },
                  `PM tool reported '${body.state}' for node '${link.nodeId}' but RegulAIt's status maps to '${expected}' — auto-resolved prefer_regulait: work item transitioned back to '${expected}'`,
                );
              } catch (err) {
                // the push failed — the drift stays SURFACED, never hidden
                await auditDrift(
                  { autoResolveFailed: err instanceof Error ? err.message : String(err) },
                  `PM tool reports '${body.state}' for node '${link.nodeId}' but RegulAIt's status maps to '${expected}' — prefer_regulait push FAILED (${err instanceof Error ? err.message : String(err)}); drift stays surfaced, state machine untouched`,
                );
              }
            } else if (conn.driftResolution === "prefer_pm") {
              // adopt the PM tool's state as authoritative FOR THE LINK. The
              // run state machine is never driven from outside (that would
              // not be safe — e.g. a PM 'Done' cannot complete a running
              // node), so adoption records the declared source of truth and
              // stops flagging this state as drift.
              await db
                .update(pmLinks)
                .set({ adoptedState: body.state })
                .where(eq(pmLinks.id, link.id));
              drift = false;
              await auditDrift(
                { resolution: "prefer_pm", before: expected, after: body.state },
                `PM tool reports '${body.state}' for node '${link.nodeId}' (RegulAIt maps to '${expected}') — auto-resolved prefer_pm: the PM state is adopted as authoritative for this item; the run state machine stays untouched`,
              );
            } else {
              await auditDrift(
                {},
                `PM tool reports '${body.state}' for node '${link.nodeId}' but RegulAIt's status maps to '${expected}' — drift surfaced, state machine untouched`,
              );
            }
          }
        }
      }
    }
    return { matched: true, drift };
  };

  // ADR-0010 inbound + pillar-8 depth: PROVIDER-NATIVE webhooks. The route is
  // authenticated by the per-connection secret using whatever mechanism the
  // tool can actually send (HMAC signature, URL token, basic auth, or the
  // legacy shared-secret header) — NOT by a bearer token; the global auth
  // hook exempts exactly this route. Translation to the normalized shape is
  // @regulait/pm-provider's parseInboundWebhook; the downstream processing
  // above is unchanged.
  //
  // Encapsulated scope: HMAC verification needs the EXACT raw body bytes, so
  // this route — and only this route — swaps the JSON body parser for a
  // raw-string capture (plus a catch-all for handshakes that arrive with an
  // empty or unlabelled body). Global JSON parsing is untouched.
  app.register(async (scope) => {
    const keepRaw = (
      _req: unknown,
      body: string,
      done: (err: Error | null, result?: unknown) => void,
    ) => done(null, body);
    scope.addContentTypeParser("application/json", { parseAs: "string" }, keepRaw);
    scope.addContentTypeParser("*", { parseAs: "string" }, keepRaw);

    scope.post("/v1/pm/webhooks/:connectionName", async (req, reply) => {
      const { connectionName } = z
        .object({ connectionName: z.string().min(1) })
        .parse(req.params);
      const [conn] = await db
        .select()
        .from(pmConnections)
        .where(eq(pmConnections.name, connectionName));
      // ADR-0010: a connection with no secret rejects all webhook traffic
      if (!conn || !conn.webhookSecretHash) {
        return reply.status(401).send({ error: "unauthenticated" });
      }

      const rawBody = typeof req.body === "string" ? req.body : "";
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v[0] : v;
      }
      const query = (req.query ?? {}) as Record<string, string | undefined>;

      // The parsers verify against the PLAINTEXT secret (HMACs cannot be
      // keyed by a hash): decrypt the stored ciphertext. Connections minted
      // before the ciphertext column can still authenticate legacy-header
      // traffic — a presented value whose sha256 matches the stored hash IS
      // the secret.
      let secret: string | null = null;
      if (conn.webhookSecretCiphertext && opts.dataKey) {
        secret = decryptSecret(opts.dataKey, conn.webhookSecretCiphertext);
      } else {
        const presented = headers["x-regulait-webhook-secret"];
        if (typeof presented === "string") {
          const presentedHash = Buffer.from(sha256(presented), "hex");
          const storedHash = Buffer.from(conn.webhookSecretHash, "hex");
          if (presentedHash.length === storedHash.length && timingSafeEqual(presentedHash, storedHash)) {
            secret = presented;
          }
        }
      }
      if (secret === null) return reply.status(401).send({ error: "unauthenticated" });

      let result;
      try {
        result = parseInboundWebhook(conn.provider, {
          headers,
          query,
          rawBody,
          secret,
          connectionProject: conn.project,
        });
      } catch (err) {
        if (err instanceof PmProviderError) {
          // 400 = verified but malformed; anything else = verification
          // failure. Neither response carries secret material.
          return err.status === 400
            ? reply.status(400).send({ error: "invalid_payload", detail: err.message })
            : reply.status(401).send({ error: "unauthenticated" });
        }
        throw err; // zod normalized-shape errors → 400 via the app error handler
      }

      if (result.kind === "handshake") {
        // provider verification challenge — answered, never processed
        if (result.headers) void reply.headers(result.headers);
        return reply.status(result.statusCode ?? 200).send(result.response);
      }
      if (result.kind === "ignored") {
        // valid-but-irrelevant traffic must 200: senders auto-disable
        // webhooks that error on payloads they legitimately deliver
        return reply.status(200).send({ ok: true, ignored: result.reason });
      }
      const results: Array<{ matched: false } | { matched: true; drift: boolean }> = [];
      for (const event of result.events) {
        results.push(await processInboundEvent(conn, event));
      }
      // single-event payloads keep the original ADR-0010 response shape;
      // multi-event payloads (asana batches) report per-event outcomes
      return reply
        .status(202)
        .send(results.length === 1 ? results[0] : { received: results.length, results });
    });
  });

  // §4: first-class decision records. Recorded locally ALWAYS; mirrored to
  // the PM tool as a linked work item of the mapped Decision-like type, or a
  // tagged comment on the parent item when no type is mapped — never dropped.
  app.post("/v1/decisions", async (req, reply) => {
    const body = createDecisionSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_decide" });

    // access: the parent object's initiator (or admin)
    let ownerUserId: string | null = null;
    let objectLabel: string | null = null;
    if (body.objectType === "run") {
      const [run] = await db
        .select({ owner: orchestrationRuns.initiatingUserId, name: orchestrationRuns.name })
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, body.objectId));
      ownerUserId = run?.owner ?? null;
      objectLabel = run?.name ?? null;
    } else {
      const [instance] = await db
        .select({ owner: workflowInstances.initiatorUserId, change: workflowInstances.change })
        .from(workflowInstances)
        .where(eq(workflowInstances.id, body.objectId));
      ownerUserId = instance?.owner ?? null;
      objectLabel = (instance?.change as { description?: string } | null)?.description ?? null;
    }
    if (!ownerUserId) return reply.status(404).send({ error: "unavailable" });
    if (!req.authCtx.isAdmin && userId !== ownerUserId) {
      return reply.status(404).send({ error: "unavailable" });
    }

    const [row] = await db
      .insert(decisions)
      .values({
        objectType: body.objectType,
        objectId: body.objectId,
        decision: body.decision,
        rationale: body.rationale ?? null,
        decisionMakerUserId: userId,
      })
      .returning();
    await db.insert(auditLog).values({
      userId,
      objectType: "decision",
      objectId: row!.id,
      detail: { parentType: body.objectType, parentId: body.objectId },
      effect: "allow",
      ruleId: "decision-recorded",
      ruleChain: [],
      // named in prose, id truncated — the full id lives in detail.parentId
      reason: `decision recorded on ${body.objectType} ${
        objectLabel ? `'${objectLabel}' (${body.objectId.slice(0, 8)}…)` : `'${body.objectId}'`
      }`,
    });

    // §4 mirror — best-effort, surfaced, never blocking the local record.
    let pmMirror: { ok: boolean; action?: string; externalId?: string; error?: string } | null = null;
    const [parentLink] = await db
      .select()
      .from(pmLinks)
      .where(
        and(
          eq(pmLinks.objectType, body.objectType === "run" ? "run" : "workflow_instance"),
          eq(pmLinks.objectId, body.objectId),
          isNull(pmLinks.nodeId),
          isNull(pmLinks.orphanedAt),
        ),
      );
    if (parentLink && opts.dataKey) {
      const [conn] = await db
        .select()
        .from(pmConnections)
        .where(eq(pmConnections.id, parentLink.connectionId));
      if (conn) {
        try {
          const provider = await providerFor(db, conn, opts.dataKey, {
            userId,
            detail: { op: "decision_mirror" },
          });
          const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
          const [maker] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
          const action = resolveDecisionAction(mapping, {
            decision: body.decision,
            rationale: body.rationale ?? null,
            decisionMaker: maker?.email ?? userId,
          });
          if (action.kind === "work_item") {
            const ref = await provider.createWorkItem(conn.project, action.type, action.fields);
            await db.insert(pmLinks).values({
              connectionId: conn.id,
              objectType: "decision",
              objectId: row!.id,
              nodeId: null,
              externalId: ref.id,
              externalUrl: ref.url,
              lastSyncedAt: new Date(),
            });
            // §6 traceability: the parent item points at the decision record
            await provider.addComment(
              conn.project,
              parentLink.externalId,
              `[RegulAIt] decision recorded as ${action.type} '${ref.id}': ${body.decision}`,
            );
            pmMirror = { ok: true, action: "work_item", externalId: ref.id };
          } else {
            await provider.addComment(
              conn.project,
              parentLink.externalId,
              `[RegulAIt] decision by ${maker?.email ?? userId}: ${body.decision}` +
                (body.rationale ? ` — rationale: ${body.rationale}` : ""),
            );
            pmMirror = { ok: true, action: "comment" };
          }
          await db.insert(auditLog).values({
            userId,
            objectType: "pm_work_item",
            objectId: row!.id,
            detail: { parentExternalId: parentLink.externalId, action: pmMirror.action },
            effect: "allow",
            ruleId: "pm-decision-mirrored",
            ruleChain: [],
            reason: `decision mirrored as ${pmMirror.action}`,
          });
        } catch (err) {
          pmMirror = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    return reply.status(201).send({ ...row, ...(pmMirror ? { pmMirror } : {}) });
  });

  app.get("/v1/decisions", async (req, reply) => {
    const q = z
      .object({ objectType: z.enum(["run", "workflow_instance"]), objectId: z.string().uuid() })
      .parse(req.query);
    let ownerUserId: string | null = null;
    if (q.objectType === "run") {
      const [run] = await db
        .select({ owner: orchestrationRuns.initiatingUserId })
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, q.objectId));
      ownerUserId = run?.owner ?? null;
    } else {
      const [instance] = await db
        .select({ owner: workflowInstances.initiatorUserId })
        .from(workflowInstances)
        .where(eq(workflowInstances.id, q.objectId));
      ownerUserId = instance?.owner ?? null;
    }
    if (!ownerUserId) return reply.status(404).send({ error: "unavailable" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== ownerUserId) {
      const widened = await isPendingApproverOn(
        req.authCtx.userId,
        q.objectType === "run" ? { runId: q.objectId } : { instanceId: q.objectId },
      );
      if (!widened) return reply.status(404).send({ error: "unavailable" });
    }
    const rows = await db
      .select()
      .from(decisions)
      .where(and(eq(decisions.objectType, q.objectType), eq(decisions.objectId, q.objectId)))
      .orderBy(desc(decisions.createdAt));
    // Display enrichment, purely additive (same discipline as approvals):
    // the maker's name, and the PM mirror when the decision was materialized
    // as a linked Decision-typed work item. A comment-mirror leaves no link
    // row — those render as plain recorded decisions.
    const makerIds = [...new Set(rows.map((r) => r.decisionMakerUserId))];
    const [makerRows, mirrorLinks] = await Promise.all([
      makerIds.length
        ? db
            .select({ id: users.id, displayName: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, makerIds))
        : [],
      rows.length
        ? db
            .select()
            .from(pmLinks)
            .where(
              and(
                eq(pmLinks.objectType, "decision"),
                inArray(
                  pmLinks.objectId,
                  rows.map((r) => r.id),
                ),
              ),
            )
        : [],
    ]);
    const nameOf = new Map(makerRows.map((u) => [u.id, u.displayName || u.email]));
    const mirrorOf = new Map(mirrorLinks.map((l) => [l.objectId, l]));
    return {
      decisions: rows.map((r) => {
        const mirror = mirrorOf.get(r.id);
        return {
          ...r,
          decisionMakerName: nameOf.get(r.decisionMakerUserId) ?? null,
          pmMirror: mirror
            ? { externalId: mirror.externalId, externalUrl: mirror.externalUrl }
            : null,
        };
      }),
    };
  });

  // §3 read-through: RegulAIt stores only the linkage. live=true resolves the
  // PM-authoritative fields (priority/description/…) from the tool right now —
  // there is no cached copy to serve stale. Scoped to ONE parent object:
  // exactly one of runId (the run's node links plus its run-level parent
  // item) or instanceId (the workflow instance's single item). Each link
  // carries its connection's NAME so a caller can drive the matching
  // pm-sync endpoint without the admin-only connections list.
  app.get("/v1/pm/links", async (req, reply) => {
    const q = z
      .object({
        runId: z.string().uuid().optional(),
        instanceId: z.string().uuid().optional(),
        live: z.coerce.boolean().default(false),
      })
      .refine((v) => Boolean(v.runId) !== Boolean(v.instanceId), {
        message: "exactly one of runId or instanceId is required",
      })
      .parse(req.query);
    let rawLinks: (typeof pmLinks.$inferSelect)[];
    let runState: RunState | null = null;
    if (q.runId) {
      const [run] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, q.runId));
      if (!run) return reply.status(404).send({ error: "unavailable" });
      if (
        !req.authCtx.isAdmin &&
        req.authCtx.userId !== run.initiatingUserId &&
        !(await isPendingApproverOn(req.authCtx.userId, { runId: q.runId }))
      ) {
        return reply.status(404).send({ error: "unavailable" });
      }
      runState = run.state as RunState;
      rawLinks = await db
        .select()
        .from(pmLinks)
        .where(and(inArray(pmLinks.objectType, ["run", "run_node"]), eq(pmLinks.objectId, q.runId)));
    } else {
      const [instance] = await db
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, q.instanceId!));
      if (!instance) return reply.status(404).send({ error: "unavailable" });
      if (
        !req.authCtx.isAdmin &&
        req.authCtx.userId !== instance.initiatorUserId &&
        !(await isPendingApproverOn(req.authCtx.userId, { instanceId: q.instanceId! }))
      ) {
        return reply.status(404).send({ error: "unavailable" });
      }
      rawLinks = await db
        .select()
        .from(pmLinks)
        .where(
          and(eq(pmLinks.objectType, "workflow_instance"), eq(pmLinks.objectId, q.instanceId!)),
        );
    }
    const connIds = [...new Set(rawLinks.map((l) => l.connectionId))];
    const connRows = connIds.length
      ? await db.select().from(pmConnections).where(inArray(pmConnections.id, connIds))
      : [];
    const connById = new Map(connRows.map((c) => [c.id, c]));
    // ADR-0010: drift annotation (run nodes only — status ownership is
    // RegulAIt's) — the PM tool's last reported state vs the mapped state for
    // the node's current status. Surfaced, never auto-fixed.
    const links = rawLinks.map((link) => {
      const conn = connById.get(link.connectionId);
      let drift = false;
      if (runState && conn && link.inboundState && link.nodeId) {
        const nodeStatus = runState.nodeStatuses[link.nodeId];
        const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
        const expected = nodeStatus ? resolveStatus(mapping, nodeStatus) : null;
        // O7: a prefer_pm-ADOPTED state is the declared truth for this item —
        // it no longer counts as drift.
        drift =
          expected !== null &&
          link.inboundState !== expected &&
          link.inboundState !== link.adoptedState;
      }
      return { ...link, connectionName: conn?.name ?? null, drift };
    });
    if (!q.live || links.length === 0) return { links };
    if (!opts.dataKey) return reply.status(503).send({ error: "pm_connections_require_data_key" });
    const live = await Promise.all(
      links.map(async (link) => {
        const conn = connById.get(link.connectionId);
        if (!conn) return { ...link, live: null, liveError: "connection no longer exists" };
        try {
          const liveProvider = await providerFor(db, conn, opts.dataKey!, {
            userId: req.authCtx.userId ?? null,
            detail: { op: "links_live_read" },
          });
          const item = await liveProvider.getWorkItem(conn.project, link.externalId);
          return { ...link, live: { state: item.state, fields: item.fields, comments: item.comments } };
        } catch (err) {
          return { ...link, live: null, liveError: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return { links: live };
  });
}
