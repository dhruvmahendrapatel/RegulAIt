import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  decisions,
  desc,
  eq,
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
  resolveApprovalAction,
  resolveDecisionAction,
  resolvePmProvider,
  resolveStatus,
  resolveTaskFields,
} from "@regulait/pm-provider";
import type { RunState, TaskGraph } from "@regulait/orchestration-kernel";
import type { WorkflowDefinition } from "@regulait/workflow-kernel";
import {
  createDecisionSchema,
  createPmConnectionSchema,
  pmSyncSchema,
  pmWebhookSchema,
} from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
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
  createdAt: pmConnections.createdAt,
};

function providerFor(
  conn: { provider: (typeof pmConnections.$inferSelect)["provider"]; baseUrl: string | null; tokenCiphertext: string },
  dataKey: string,
) {
  return resolvePmProvider({
    provider: conn.provider,
    token: decryptSecret(dataKey, conn.tokenCiphertext),
    baseUrl: conn.baseUrl,
  });
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
  const [link] = await db
    .select()
    .from(pmLinks)
    .where(
      and(eq(pmLinks.objectType, "run_node"), eq(pmLinks.objectId, runId), eq(pmLinks.nodeId, nodeId)),
    );
  if (!link || !dataKey) return null;
  const [conn] = await db.select().from(pmConnections).where(eq(pmConnections.id, link.connectionId));
  if (!conn) return null;
  const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
  const state = resolveStatus(mapping, nodeStatus);
  if (state === null) return null;
  try {
    await providerFor(conn, dataKey).transitionState(conn.project, link.externalId, state);
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
  let linkWhere;
  if (approvalRow.objectType === "workflow" && approvalRow.instanceId) {
    linkWhere = and(
      eq(pmLinks.objectType, "workflow_instance"),
      eq(pmLinks.objectId, approvalRow.instanceId),
      isNull(pmLinks.nodeId),
    );
  } else if (
    approvalRow.objectType === "run" &&
    approvalRow.runId &&
    !approvalRow.stageId.startsWith("__budget__")
  ) {
    linkWhere = and(
      eq(pmLinks.objectType, "run_node"),
      eq(pmLinks.objectId, approvalRow.runId),
      eq(pmLinks.nodeId, approvalRow.stageId),
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
  const action =
    approvalRow.status === "approved"
      ? resolveApprovalAction(mapping, approvalRow.stageId)
      : ({ kind: "comment" } as const);
  try {
    const provider = providerFor(conn, dataKey);
    const [decider] = await db.select({ email: users.email }).from(users).where(eq(users.id, deciderUserId));
    const note =
      `[RegulAIt] sign-off '${approvalRow.stageId}' ${approvalRow.status} by ${decider?.email ?? deciderUserId}` +
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
      ruleId: "pm-approval-mirrored",
      ruleChain: [],
      reason: `sign-off '${approvalRow.stageId}' (${approvalRow.status}) mirrored as ${action.kind}`,
    });
    return { ok: true, action: action.kind };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerPmRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string }) {
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
      resolvePmProvider({ provider: body.provider, token: body.token, baseUrl: body.baseUrl ?? null });
    } catch (err) {
      if (err instanceof PmProviderError) {
        return reply.status(422).send({ error: "unsupported_pm_provider", detail: err.message });
      }
      throw err; // zod mapping errors → 400 via the app error handler
    }
    // ADR-0010: per-connection webhook secret — plaintext returned exactly
    // once, only the hash is stored (same discipline as API keys).
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
        webhookSecretHash: sha256(webhookSecret),
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
      provider = providerFor(conn, opts.dataKey);
    } catch (err) {
      if (err instanceof PmProviderError) {
        return reply.status(422).send({ error: "unsupported_pm_provider", detail: err.message });
      }
      throw err;
    }
    const existing = await db
      .select()
      .from(pmLinks)
      .where(and(eq(pmLinks.objectType, "run_node"), eq(pmLinks.objectId, runId)));
    const linked = new Set(existing.map((l) => l.nodeId));

    // Run-level parent item (idempotent): the anchor for run-scoped records —
    // §4 decisions and, later, budget approvals — that no single node owns.
    const [runLink] = await db
      .select()
      .from(pmLinks)
      .where(and(eq(pmLinks.objectType, "run"), eq(pmLinks.objectId, runId), isNull(pmLinks.nodeId)));
    if (!runLink) {
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
      const ref = await provider.createWorkItem(
        conn.project,
        mapping.task.workItemType,
        resolveTaskFields(mapping, { title: node.title }),
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
      return reply
        .status(200)
        .send({ created: false, externalId: existing.externalId, externalUrl: existing.externalUrl });
    }

    const def = instance.definition as WorkflowDefinition;
    const change = instance.change as { description: string };
    const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
    let provider;
    try {
      provider = providerFor(conn, opts.dataKey);
    } catch (err) {
      if (err instanceof PmProviderError) {
        return reply.status(422).send({ error: "unsupported_pm_provider", detail: err.message });
      }
      throw err;
    }
    const ref = await provider.createWorkItem(
      conn.project,
      mapping.task.workItemType,
      resolveTaskFields(mapping, { title: `${def.workflow}: ${change.description}` }),
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

  // ADR-0010 inbound: the normalized webhook. Authenticated by the
  // per-connection secret (constant-time compare against the stored hash) —
  // NOT by a bearer token; the global auth hook exempts exactly this route.
  // Inbound state is recorded, never applied to the state machine; divergence
  // surfaces as drift in the links view and the one audit trail.
  app.post("/v1/pm/webhooks/:connectionName", async (req, reply) => {
    const { connectionName } = z
      .object({ connectionName: z.string().min(1) })
      .parse(req.params);
    const [conn] = await db
      .select()
      .from(pmConnections)
      .where(eq(pmConnections.name, connectionName));
    const presented = req.headers["x-regulait-webhook-secret"];
    if (!conn || !conn.webhookSecretHash || typeof presented !== "string") {
      return reply.status(401).send({ error: "unauthenticated" });
    }
    const presentedHash = Buffer.from(sha256(presented), "hex");
    const storedHash = Buffer.from(conn.webhookSecretHash, "hex");
    if (presentedHash.length !== storedHash.length || !timingSafeEqual(presentedHash, storedHash)) {
      return reply.status(401).send({ error: "unauthenticated" });
    }

    const body = pmWebhookSchema.parse(req.body);
    const [link] = await db
      .select()
      .from(pmLinks)
      .where(and(eq(pmLinks.connectionId, conn.id), eq(pmLinks.externalId, body.externalId)));
    await db.insert(pmSyncEvents).values({
      connectionId: conn.id,
      linkId: link?.id ?? null,
      externalId: body.externalId,
      kind: body.event,
      payload: { ...(body.state ? { state: body.state } : {}), ...(body.fields ? { fields: body.fields } : {}) },
    });
    if (!link) return reply.status(202).send({ matched: false });

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
          detail: { externalId: link.externalId, linkType: link.objectType, event: "deleted" },
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
          if (expected !== null && body.state !== expected) {
            drift = true;
            await db.insert(auditLog).values({
              userId: run.initiatingUserId,
              objectType: "pm_work_item",
              objectId: link.objectId,
              detail: {
                nodeId: link.nodeId,
                externalId: link.externalId,
                reportedState: body.state,
                expectedState: expected,
              },
              effect: "allow",
              ruleId: "pm-drift-detected",
              ruleChain: [],
              reason: `PM tool reports '${body.state}' for node '${link.nodeId}' but RegulAIt's status maps to '${expected}' — drift surfaced, state machine untouched`,
            });
          }
        }
      }
    }
    return reply.status(202).send({ matched: true, drift });
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
    if (body.objectType === "run") {
      const [run] = await db
        .select({ owner: orchestrationRuns.initiatingUserId })
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, body.objectId));
      ownerUserId = run?.owner ?? null;
    } else {
      const [instance] = await db
        .select({ owner: workflowInstances.initiatorUserId })
        .from(workflowInstances)
        .where(eq(workflowInstances.id, body.objectId));
      ownerUserId = instance?.owner ?? null;
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
      reason: `decision recorded on ${body.objectType} '${body.objectId}'`,
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
        ),
      );
    if (parentLink && opts.dataKey) {
      const [conn] = await db
        .select()
        .from(pmConnections)
        .where(eq(pmConnections.id, parentLink.connectionId));
      if (conn) {
        try {
          const provider = providerFor(conn, opts.dataKey);
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
      return reply.status(404).send({ error: "unavailable" });
    }
    const rows = await db
      .select()
      .from(decisions)
      .where(and(eq(decisions.objectType, q.objectType), eq(decisions.objectId, q.objectId)))
      .orderBy(desc(decisions.createdAt));
    return { decisions: rows };
  });

  // §3 read-through: RegulAIt stores only the linkage. live=true resolves the
  // PM-authoritative fields (priority/description/…) from the tool right now —
  // there is no cached copy to serve stale.
  app.get("/v1/pm/links", async (req, reply) => {
    const q = z
      .object({ runId: z.string().uuid(), live: z.coerce.boolean().default(false) })
      .parse(req.query);
    const [run] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, q.runId));
    if (!run) return reply.status(404).send({ error: "unavailable" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== run.initiatingUserId) {
      return reply.status(404).send({ error: "unavailable" });
    }
    const rawLinks = await db
      .select()
      .from(pmLinks)
      .where(and(eq(pmLinks.objectType, "run_node"), eq(pmLinks.objectId, q.runId)));
    // ADR-0010: drift annotation — the PM tool's last reported state vs the
    // mapped state for the node's current status. Surfaced, never auto-fixed.
    let driftMapping: ReturnType<typeof mappingFor> | null = null;
    if (rawLinks.length > 0) {
      const [driftConn] = await db
        .select()
        .from(pmConnections)
        .where(eq(pmConnections.id, rawLinks[0]!.connectionId));
      if (driftConn) driftMapping = mappingFor(driftConn.provider, driftConn.mapping ?? undefined);
    }
    const runState = run.state as RunState;
    const links = rawLinks.map((link) => {
      let drift = false;
      if (driftMapping && link.inboundState && link.nodeId) {
        const nodeStatus = runState.nodeStatuses[link.nodeId];
        const expected = nodeStatus ? resolveStatus(driftMapping, nodeStatus) : null;
        drift = expected !== null && link.inboundState !== expected;
      }
      return { ...link, drift };
    });
    if (!q.live || links.length === 0) return { links };
    if (!opts.dataKey) return reply.status(503).send({ error: "pm_connections_require_data_key" });
    const [conn] = await db
      .select()
      .from(pmConnections)
      .where(eq(pmConnections.id, links[0]!.connectionId));
    if (!conn) return { links };
    const provider = providerFor(conn, opts.dataKey);
    const live = await Promise.all(
      links.map(async (link) => {
        try {
          const item = await provider.getWorkItem(conn.project, link.externalId);
          return { ...link, live: { state: item.state, fields: item.fields, comments: item.comments } };
        } catch (err) {
          return { ...link, live: null, liveError: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return { links: live };
  });
}
