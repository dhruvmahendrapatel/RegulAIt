import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  eq,
  isNull,
  orchestrationRuns,
  pmConnections,
  pmLinks,
  users,
  workflowInstances,
  type Db,
} from "@regulait/db";
import {
  PmProviderError,
  mappingFor,
  resolveApprovalAction,
  resolvePmProvider,
  resolveStatus,
  resolveTaskFields,
} from "@regulait/pm-provider";
import type { TaskGraph } from "@regulait/orchestration-kernel";
import type { WorkflowDefinition } from "@regulait/workflow-kernel";
import { createPmConnectionSchema, pmSyncSchema } from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { z } from "zod";

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
    const [row] = await db
      .insert(pmConnections)
      .values({
        name: body.name,
        provider: body.provider,
        baseUrl: body.baseUrl ?? null,
        project: body.project,
        tokenCiphertext: encryptSecret(opts.dataKey, body.token),
        mapping: body.mapping ?? null,
      })
      .returning(CONNECTION_COLUMNS);
    return reply.status(201).send(row);
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
    const links = await db
      .select()
      .from(pmLinks)
      .where(and(eq(pmLinks.objectType, "run_node"), eq(pmLinks.objectId, q.runId)));
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
