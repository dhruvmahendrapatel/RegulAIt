/**
 * ADR-0317 (lane L6, gap G4): RegulAIt is ASSIGNABLE from Jira and Azure Boards.
 *
 * Assigning a work item to RegulAIt's agent identity, @mentioning it in a comment, or a tool-side rule (a Jira
 * Automation "Send web request" with the `regulait:assign` event) starts the pillar-2 workflow for that item. The
 * delivery is the plain inbound webhook ADR-0010 already verifies (Jira URL token or X-Hub-Signature, Azure DevOps
 * service-hook basic auth) with its replay walls (in-body creation time, per-connection delivery record). No
 * Atlassian Forge app (its licence is unchecked against ADR-0176: owner question open).
 *
 *   - OFF by default per connection (ADR-0180). Enabling it is a step-up relaxation, audited.
 *   - The workflow runs AS the assigning user and never as more: the PM-side actor must be mapped to a RegulAIt user
 *     by an admin (pm_identity_links, the ChatOps identity-link model); the template is matched on that user's own
 *     roles and the project's classifications; the project must be one the user can charge; no admin-only path
 *     (an explicit template) is reachable. An unmapped, disabled or missing actor starts nothing.
 *   - At most one workflow per work item (pm_assignment_starts). The started instance is linked to the EXISTING item
 *     (pm_links, objectType workflow_instance), so approval decisions mirror back through mirrorApprovalDecision and
 *     decision records through POST /v1/decisions, unchanged; the start itself is written back as a comment.
 *   - Every outcome, started or refused, is one row in the single audit trail.
 *
 * This module imports nothing from pm.ts (the gateway import-cycle ratchet): the PM write-back is injected.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  eq,
  gt,
  pmAssignmentStarts,
  pmAssignmentTriggers,
  pmConnections,
  pmIdentityLinks,
  pmLinks,
  projects,
  sql,
  users,
  type Db,
} from "@regulait/db";
import type { NormalizedInboundEvent } from "@regulait/pm-provider";
import { errMessage } from "./err-serializer.js";
import { requireStepUp } from "./step-up.js";
import { matchedTemplateIds, resolveServerChange, startWorkflowInstanceWithTemplates, withCascadeTemplates } from "./workflows.js";
import { SHADOW_AI_REMEDIATION_CHANGE_TYPE } from "./shadow-ai-remediation.js";

/** the system actor for refusals with no RegulAIt user to attribute them to (pm.ts uses the same id) */
const SYSTEM_IDENTITY = "00000000-0000-0000-0000-000000000000";

export const PM_ASSIGNMENT_RULE_IDS = {
  triggerUpdated: "pm-assignment-trigger-updated",
  identityLinked: "pm-identity-linked",
  identityUnlinked: "pm-identity-unlinked",
  started: "pm-assignment-started",
  disabled: "pm-assignment-disabled",
  noActor: "pm-assignment-no-actor",
  selfActor: "pm-assignment-self",
  unmappedActor: "pm-assignment-unmapped-actor",
  alreadyStarted: "pm-assignment-already-started",
  noWorkflow: "pm-assignment-no-workflow",
  refused: "pm-assignment-refused",
  writebackFailed: "pm-assignment-writeback-failed",
} as const;

/** providers whose inbound parser reports assignment signals (ADR-0317); generic/mock carry them on the normalized
 * contract directly */
export const PM_ASSIGNMENT_PROVIDERS = ["jira", "azure_devops", "generic_webhook", "mock"] as const;

type Conn = typeof pmConnections.$inferSelect;
type TriggerKind = "assigned" | "mentioned" | "automation";

export type AssignmentOutcome =
  | { assignment: "started"; instanceId: string; writeBack: "commented" | "failed" }
  | {
      assignment:
        | "disabled"
        | "no_actor"
        | "self"
        | "unmapped_actor"
        | "already_started"
        | "no_workflow"
        | "refused";
      instanceId?: string;
    };

/** Azure DevOps compares identities case-insensitively; Jira accountIds are opaque and compared exactly. */
const normalizeRef = (provider: string, v: string): string =>
  provider === "azure_devops" ? v.trim().toLowerCase() : v.trim();

/** Which of the event's signals addresses the agent, if any (an explicit rule first, then assignment, then a mention). */
export function assignmentTriggerFor(
  provider: string,
  agentRef: string,
  event: Pick<NormalizedInboundEvent, "trigger" | "assignee" | "mentions">,
): TriggerKind | null {
  const ref = normalizeRef(provider, agentRef);
  if (event.trigger === "automation") return "automation";
  if (event.assignee !== undefined && normalizeRef(provider, event.assignee) === ref) return "assigned";
  if (event.mentions?.some((m) => normalizeRef(provider, m) === ref)) return "mentioned";
  return null;
}

/** The browser link recorded on the pm_links row (display only; the external id is the key). */
function workItemUrl(conn: Conn, externalId: string, key: string | undefined): string {
  const base = (conn.baseUrl ?? "").replace(/\/+$/, "");
  if (conn.provider === "jira" && base) return `${base}/browse/${encodeURIComponent(key ?? externalId)}`;
  if (conn.provider === "azure_devops" && base) {
    return `${base}/${encodeURIComponent(conn.project)}/_workitems/edit/${encodeURIComponent(externalId)}`;
  }
  return `${base || conn.provider}#${encodeURIComponent(externalId)}`;
}

async function audit(
  db: Db,
  row: {
    userId: string;
    objectType: "pm_connection" | "workflow";
    objectId: string;
    ruleId: string;
    effect: "allow" | "deny";
    reason: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({ ...row, ruleChain: [] });
}

class StartRefused extends Error {
  constructor(
    readonly outcome: "no_workflow" | "refused",
    readonly detail: Record<string, unknown>,
  ) {
    super(outcome);
  }
}

export interface AssignmentDeps {
  dataKey: string | undefined;
  /** the governed PM write: pm.ts runs it through providerFor, whose addComment is inside runExternalWrite, as the mapped user */
  writeBackComment: (userId: string, externalId: string, text: string) => Promise<void>;
}

/**
 * Act on one verified, de-duplicated inbound event. Returns null when the connection has no trigger or the event
 * does not address the agent (nothing to do, nothing audited); otherwise the outcome, already audited. Never throws
 * for a refusal: the webhook is acknowledged either way (a sender disables endpoints that error).
 */
export async function handleAssignmentEvent(
  db: Db,
  conn: Conn,
  event: NormalizedInboundEvent,
  deps: AssignmentDeps,
): Promise<AssignmentOutcome | null> {
  if (event.event === "deleted") return null;
  const [trigger] = await db.select().from(pmAssignmentTriggers).where(eq(pmAssignmentTriggers.connectionId, conn.id));
  if (!trigger) return null;
  const kind = assignmentTriggerFor(conn.provider, trigger.agentRef, event);
  if (!kind) return null;
  const base = { connection: conn.name, provider: conn.provider, externalId: event.externalId, trigger: kind };
  const refuse = async (
    outcome: Exclude<AssignmentOutcome["assignment"], "started">,
    ruleId: string,
    reason: string,
    extra: Record<string, unknown> = {},
    userId: string = SYSTEM_IDENTITY,
  ): Promise<AssignmentOutcome> => {
    await audit(db, {
      userId,
      objectType: "pm_connection",
      objectId: conn.id,
      ruleId,
      effect: "deny",
      reason: `PM connection '${conn.name}', work item ${event.key ?? event.externalId}: ${reason}`,
      detail: { phase: "assignment", ...base, ...(event.actor ? { actor: event.actor } : {}), ...extra },
    });
    return { assignment: outcome, ...(typeof extra.instanceId === "string" ? { instanceId: extra.instanceId } : {}) };
  };

  if (!trigger.enabled) {
    return refuse("disabled", PM_ASSIGNMENT_RULE_IDS.disabled, "the assignment trigger is off for this connection; nothing was started");
  }
  if (!event.actor) {
    return refuse("no_actor", PM_ASSIGNMENT_RULE_IDS.noActor, "the delivery names no acting user, so there is no one to run the workflow as; nothing was started");
  }
  if (normalizeRef(conn.provider, event.actor) === normalizeRef(conn.provider, trigger.agentRef)) {
    return refuse("self", PM_ASSIGNMENT_RULE_IDS.selfActor, "the acting user is the agent identity itself; nothing was started");
  }
  const actorRef = normalizeRef(conn.provider, event.actor);
  const [link] = await db
    .select({ userId: pmIdentityLinks.userId, disabledAt: users.disabledAt })
    .from(pmIdentityLinks)
    .innerJoin(users, eq(users.id, pmIdentityLinks.userId))
    .where(and(eq(pmIdentityLinks.connectionId, conn.id), eq(pmIdentityLinks.externalUserId, actorRef)));
  if (!link || link.disabledAt) {
    return refuse(
      "unmapped_actor",
      PM_ASSIGNMENT_RULE_IDS.unmappedActor,
      link
        ? "the acting user is linked to a disabled RegulAIt user; nothing was started"
        : "the acting user is not linked to a RegulAIt user by an admin; nothing was started",
    );
  }
  const userId = link.userId;

  const title =
    (typeof event.fields?.summary === "string" && event.fields.summary) ||
    (typeof event.fields?.title === "string" && event.fields.title) ||
    "";
  const label = event.key ?? event.externalId;
  const description = `${conn.provider} work item ${label}${title ? `: ${title}` : ""}`.slice(0, 2000);

  let started: { instanceId: string };
  try {
    started = await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const [claim] = await tx
        .insert(pmAssignmentStarts)
        .values({ connectionId: conn.id, externalId: event.externalId, initiatorUserId: userId, actorExternalId: actorRef, trigger: kind })
        .onConflictDoNothing({ target: [pmAssignmentStarts.connectionId, pmAssignmentStarts.externalId] })
        .returning({ id: pmAssignmentStarts.id });
      if (!claim) {
        const [existing] = await tx
          .select({ instanceId: pmAssignmentStarts.workflowInstanceId })
          .from(pmAssignmentStarts)
          .where(and(eq(pmAssignmentStarts.connectionId, conn.id), eq(pmAssignmentStarts.externalId, event.externalId)));
        throw new StartRefused("refused", { already: true, instanceId: existing?.instanceId ?? null });
      }
      const projectId = trigger.projectId ?? null;
      // the same server-side facts and §8.3 cascade as the start route (resolveServerChange)
      const { change, cascadeTemplateIds } = await resolveServerChange(
        tx,
        userId,
        {
          description,
          paths: [],
          changeType: trigger.changeType,
          environment: trigger.environment,
          ...(trigger.targetSystem ? { targetSystem: trigger.targetSystem } : {}),
        },
        projectId,
      );
      const templateIds = withCascadeTemplates(await matchedTemplateIds(tx, change), cascadeTemplateIds);
      if (templateIds.length === 0) throw new StartRefused("no_workflow", { changeType: trigger.changeType });
      // never more than the user: isAdmin is false, so no admin-only path is reachable, and the project
      // attribution is checked against this user's own membership
      const out = await startWorkflowInstanceWithTemplates(tx, deps.dataKey, {
        templateIds,
        initiatorUserId: userId,
        change,
        projectId,
        isAdmin: false,
      });
      if (!out.ok) throw new StartRefused("refused", { status: out.status, error: (out.body as { error?: unknown }).error ?? null });
      await tx.update(pmAssignmentStarts).set({ workflowInstanceId: out.instance.id }).where(eq(pmAssignmentStarts.id, claim.id));
      await tx.insert(pmLinks).values({
        connectionId: conn.id,
        objectType: "workflow_instance",
        objectId: out.instance.id,
        externalId: event.externalId,
        externalUrl: workItemUrl(conn, event.externalId, event.key),
      });
      await audit(tx, {
        userId,
        objectType: "workflow",
        objectId: out.instance.id,
        ruleId: PM_ASSIGNMENT_RULE_IDS.started,
        effect: "allow",
        reason: `PM connection '${conn.name}': work item ${label} ${kind === "automation" ? "was sent by a tool-side rule" : `${kind} RegulAIt`}; its workflow started as the assigning user (ADR-0317)`,
        detail: { phase: "assignment", ...base, actor: actorRef, templateIds, projectId },
      });
      return { instanceId: out.instance.id };
    });
  } catch (err) {
    if (!(err instanceof StartRefused)) throw err;
    if (err.detail.already) {
      return refuse(
        "already_started",
        PM_ASSIGNMENT_RULE_IDS.alreadyStarted,
        "a workflow was already started for this work item; nothing new was started",
        { instanceId: err.detail.instanceId },
        userId,
      );
    }
    if (err.outcome === "no_workflow") {
      return refuse(
        "no_workflow",
        PM_ASSIGNMENT_RULE_IDS.noWorkflow,
        `no workflow assignment rule matches change type '${trigger.changeType}'; an admin must assign a template to it`,
        err.detail,
        userId,
      );
    }
    return refuse("refused", PM_ASSIGNMENT_RULE_IDS.refused, "the workflow start was refused for this user", err.detail, userId);
  }

  // write-back: a comment on the item, as the mapped user, through the governed PM write; a failure is audited and
  // leaves the instance running (approvals still mirror through the link)
  let writeBack: "commented" | "failed" = "commented";
  try {
    await deps.writeBackComment(
      userId,
      event.externalId,
      `RegulAIt workflow ${started.instanceId} started for this item (${kind}). Approvals and decisions are recorded here as they happen.`,
    );
  } catch (err) {
    writeBack = "failed";
    await audit(db, {
      userId,
      objectType: "workflow",
      objectId: started.instanceId,
      ruleId: PM_ASSIGNMENT_RULE_IDS.writebackFailed,
      effect: "deny",
      reason: `PM connection '${conn.name}': the start comment could not be written to work item ${label}; the workflow runs and its approvals still mirror`,
      detail: { phase: "assignment-writeback", ...base, error: errMessage(err).slice(0, 300) },
    });
  }
  return { assignment: "started", instanceId: started.instanceId, writeBack };
}

// ---------------------------------------------------------------------------
// Admin routes: the trigger and the identity links, per connection
// ---------------------------------------------------------------------------

const nameParams = z.object({ name: z.string().min(1).max(200) }).strict();
const idParams = z.object({ name: z.string().min(1).max(200), linkId: z.string().uuid() }).strict();
const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const putAssignmentTriggerSchema = z
  .object({
    enabled: z.boolean(),
    agentRef: trimmed(256),
    changeType: trimmed(128),
    environment: trimmed(128),
    targetSystem: trimmed(128).nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const createIdentityLinkSchema = z
  .object({ externalUserId: trimmed(256), userId: z.string().uuid() })
  .strict();

const listQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().uuid().optional() })
  .strict();

const actorOf = (req: FastifyRequest): string => req.authCtx.userId ?? SYSTEM_IDENTITY;

export function registerPmAssignmentRoutes(app: FastifyInstance, db: Db): void {
  const loadConn = async (reply: FastifyReply, params: unknown): Promise<Conn | null> => {
    const p = nameParams.safeParse(params);
    if (!p.success) {
      await reply.status(400).send({ error: "invalid_request" });
      return null;
    }
    const [conn] = await db.select().from(pmConnections).where(eq(pmConnections.name, p.data.name));
    if (!conn) {
      await reply.status(404).send({ error: "pm_connection_not_found" });
      return null;
    }
    return conn;
  };

  app.get("/v1/pm/connections/:name/assignment-trigger", async (req, reply) => {
    const conn = await loadConn(reply, req.params);
    if (!conn) return reply;
    const [row] = await db.select().from(pmAssignmentTriggers).where(eq(pmAssignmentTriggers.connectionId, conn.id));
    return {
      connection: conn.name,
      provider: conn.provider,
      supported: (PM_ASSIGNMENT_PROVIDERS as readonly string[]).includes(conn.provider),
      trigger: row ? triggerView(row) : null,
    };
  });

  // on is a relaxation (ADR-0180): a step-up bound to this connection, audited; any change is audited
  app.put("/v1/pm/connections/:name/assignment-trigger", async (req, reply) => {
    const conn = await loadConn(reply, req.params);
    if (!conn) return reply;
    if (!(PM_ASSIGNMENT_PROVIDERS as readonly string[]).includes(conn.provider)) {
      return reply.status(422).send({
        error: "assignment_not_supported",
        detail: `the ${conn.provider} adapter reports no assignment signals; supported: ${PM_ASSIGNMENT_PROVIDERS.join(", ")}`,
      });
    }
    const body = putAssignmentTriggerSchema.parse(req.body);
    if (body.changeType === SHADOW_AI_REMEDIATION_CHANGE_TYPE) {
      return reply.status(422).send({ error: "change_type_reserved", detail: "the shadow-AI remediation change type starts only from its own plan" });
    }
    if (body.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId));
      if (!project) return reply.status(404).send({ error: "project_not_found" });
    }
    const [before] = await db.select().from(pmAssignmentTriggers).where(eq(pmAssignmentTriggers.connectionId, conn.id));
    const relaxing = body.enabled && !before?.enabled;
    let stepUp: string | null = null;
    if (relaxing) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { pmAssignmentTrigger: "enable", connectionId: conn.id, provider: conn.provider },
      });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    const userId = req.authCtx.userId ?? null;
    const values = {
      enabled: body.enabled,
      agentRef: normalizeRef(conn.provider, body.agentRef),
      changeType: body.changeType,
      environment: body.environment,
      targetSystem: body.targetSystem ?? null,
      projectId: body.projectId ?? null,
      updatedByUserId: userId,
      updatedAt: new Date(),
    };
    const saved = await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const [row] = await tx
        .insert(pmAssignmentTriggers)
        .values({ connectionId: conn.id, ...values })
        .onConflictDoUpdate({ target: pmAssignmentTriggers.connectionId, set: { ...values, updatedAt: sql`now()` } })
        .returning();
      await audit(tx, {
        userId: actorOf(req),
        objectType: "pm_connection",
        objectId: conn.id,
        ruleId: PM_ASSIGNMENT_RULE_IDS.triggerUpdated,
        effect: relaxing ? "deny" : "allow",
        reason: relaxing
          ? `PM connection '${conn.name}': the assignment trigger was enabled; assigning or mentioning '${values.agentRef}' starts a workflow as the assigning user (step-up ${stepUp}) (ADR-0317)`
          : `PM connection '${conn.name}': the assignment trigger was ${body.enabled ? "updated" : "set off"} (ADR-0317)`,
        detail: {
          phase: "assignment-trigger",
          connection: conn.name,
          from: before ? triggerView(before) : null,
          to: triggerView(row!),
          relaxation: relaxing,
          ...(stepUp ? { stepUp } : {}),
        },
      });
      return row!;
    });
    return { trigger: triggerView(saved) };
  });

  app.get("/v1/pm/connections/:name/identity-links", async (req, reply) => {
    const conn = await loadConn(reply, req.params);
    if (!conn) return reply;
    const q = listQuery.parse(req.query ?? {});
    const rows = await db
      .select({
        id: pmIdentityLinks.id,
        externalUserId: pmIdentityLinks.externalUserId,
        userId: pmIdentityLinks.userId,
        email: users.email,
        disabled: sql<boolean>`${users.disabledAt} IS NOT NULL`,
        createdAt: pmIdentityLinks.createdAt,
      })
      .from(pmIdentityLinks)
      .innerJoin(users, eq(users.id, pmIdentityLinks.userId))
      .where(and(eq(pmIdentityLinks.connectionId, conn.id), q.cursor ? gt(pmIdentityLinks.id, q.cursor) : undefined))
      .orderBy(asc(pmIdentityLinks.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { links: page, nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
  });

  app.post("/v1/pm/connections/:name/identity-links", async (req, reply) => {
    const conn = await loadConn(reply, req.params);
    if (!conn) return reply;
    const body = createIdentityLinkSchema.parse(req.body);
    const adminId = req.authCtx.userId ?? null;
    const [target] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, body.userId));
    if (!target) return reply.status(404).send({ error: "user_not_found" });
    if (target.disabledAt) return reply.status(422).send({ error: "user_disabled" });
    const externalUserId = normalizeRef(conn.provider, body.externalUserId);
    const created = await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const [row] = await tx
        .insert(pmIdentityLinks)
        .values({ connectionId: conn.id, externalUserId, userId: body.userId, createdByUserId: adminId })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      await audit(tx, {
        userId: actorOf(req),
        objectType: "pm_connection",
        objectId: conn.id,
        ruleId: PM_ASSIGNMENT_RULE_IDS.identityLinked,
        effect: "allow",
        reason: `PM connection '${conn.name}': PM user '${externalUserId}' linked to a RegulAIt user; their assignments run as that user (ADR-0317)`,
        detail: { phase: "identity-link", connection: conn.name, linkId: row.id, externalUserId, linkedUserId: body.userId },
      });
      return row;
    });
    if (!created) return reply.status(409).send({ error: "identity_link_exists", detail: "the PM user or the RegulAIt user is already linked on this connection" });
    return reply.status(201).send({ link: { id: created.id, externalUserId, userId: created.userId, createdAt: created.createdAt } });
  });

  app.delete("/v1/pm/connections/:name/identity-links/:linkId", async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request" });
    const conn = await loadConn(reply, { name: p.data.name });
    if (!conn) return reply;
    const adminId = actorOf(req);
    const removed = await db.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      const [row] = await tx
        .delete(pmIdentityLinks)
        .where(and(eq(pmIdentityLinks.id, p.data.linkId), eq(pmIdentityLinks.connectionId, conn.id)))
        .returning();
      if (!row) return null;
      await audit(tx, {
        userId: adminId,
        objectType: "pm_connection",
        objectId: conn.id,
        ruleId: PM_ASSIGNMENT_RULE_IDS.identityUnlinked,
        effect: "allow",
        reason: `PM connection '${conn.name}': PM user '${row.externalUserId}' unlinked; their assignments start nothing (ADR-0317)`,
        detail: { phase: "identity-link", connection: conn.name, linkId: row.id, externalUserId: row.externalUserId, linkedUserId: row.userId },
      });
      return row;
    });
    if (!removed) return reply.status(404).send({ error: "identity_link_not_found" });
    return reply.status(204).send();
  });
}

function triggerView(row: typeof pmAssignmentTriggers.$inferSelect) {
  return {
    enabled: row.enabled,
    agentRef: row.agentRef,
    changeType: row.changeType,
    environment: row.environment,
    targetSystem: row.targetSystem,
    projectId: row.projectId,
    updatedAt: row.updatedAt,
  };
}
