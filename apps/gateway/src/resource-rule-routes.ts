/**
 * ADR-0251 (P-01 remainder, review #715 finding 4) — the admin routes for the governed core's resource rules:
 *
 *   GET    /v1/rules/resource/approval-rules            list (the ADR-0226 list contract; optional resourceType)
 *   GET    /v1/rules/resource/approval-rules/export.xlsx the same list as an Excel file
 *   POST   /v1/rules/resource/approval-rules            add a rule (only ever restricts: no step-up)
 *   PATCH  /v1/rules/resource/approval-rules/:ruleId    change the approver or writeOnly
 *   DELETE /v1/rules/resource/approval-rules/:ruleId    remove a rule (a relaxation: step-up)
 *   GET    /v1/rules/resource/rate-limits               list (the ADR-0226 list contract; optional resourceType)
 *   GET    /v1/rules/resource/rate-limits/export.xlsx   the same list as an Excel file
 *   POST   /v1/rules/resource/rate-limits               add a limit (only ever restricts: no step-up)
 *   PATCH  /v1/rules/resource/rate-limits/:ruleId       change maxCalls or windowSeconds
 *   DELETE /v1/rules/resource/rate-limits/:ruleId       remove a limit (a relaxation: step-up)
 *
 * Admin only through the global gate, like every /v1/rules write. Every removal or loosening needs a `settings_relax`
 * step-up bound to the exact change; tightening needs none. Every write is audited in the SAME transaction as the
 * write, with the row before and after (object type restriction_rule, receipt class "configuration"), so the log can
 * never disagree with the table. A rule's subject and resource binding are its identity: they are not editable
 * (delete it and create a new one), as for the MCP rule kinds (ADR-0073 §2).
 *
 * Reuse (review of #818): an approval-rule write goes through THE ONE GUARD every approval-rule writer uses
 * (`assertApprovalRuleWritable`: a pool that can never approve, an approver who is the subject, a disabled or
 * unknown approver), and its loosening is judged by the same pool predicate as the MCP kinds (`approvalRuleLoosens`,
 * `assertApprovalRuleLooseningStepUp`, `assertRuleRemovalStepUp`), with the step-up asked inside the writer's lock
 * (`approvalRuleStepUp`). The lists answer the shared list contract (`answerListPage`, `answerListExport`).
 *
 * What counts as a loosening:
 *  - approval rule: removing it; a wider approver pool (`approvalRuleLoosens`); and, resource-specific, turning
 *    `writeOnly` on (the rule then holds fewer calls).
 *  - rate limit: removing it; more calls, or the same calls over a shorter window (`rateLimitChangeRelaxes`).
 *
 * The tables need no new migration: they shipped with ADR-0251 slice 1 (`governed_core_resource_rules`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  a2aAgents,
  agents,
  auditLog,
  connectors,
  eq,
  getTableColumns,
  resourceApprovalRules,
  resourceRateLimits,
  roles,
  sql,
  teams,
  users,
  type Db,
} from "@regulait/db";
import {
  createResourceApprovalRuleSchema,
  createResourceRateLimitSchema,
  RESOURCE_APPROVAL_RULE_TYPES,
  RESOURCE_RATE_LIMIT_TYPES,
  rateLimitChangeRelaxes,
  updateResourceApprovalRuleSchema,
  updateResourceRateLimitSchema,
} from "@regulait/shared";
import {
  approvalRuleLoosens,
  approvalRuleShape,
  assertApprovalRuleLooseningStepUp,
  assertApprovalRuleWritable,
  assertRuleRemovalStepUp,
  requireRuleStepUp,
} from "./approval-pool.js";
import type { ListSpec } from "./list-contract.js";
import { answerListExport, answerListPage, type ContractList } from "./list-contract-route.js";
import { approvalRuleStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const idParam = z.object({ ruleId: z.string().uuid() });

type ResourceType = "model" | "connector" | "a2a";
type Subject = {
  scope: "user" | "role" | "team" | "fleet";
  userId?: string | null | undefined;
  roleId?: string | null | undefined;
  teamId?: string | null | undefined;
};

/** the one resource column a rule binds, for its type */
function resourceColumns(type: ResourceType, id: string | null | undefined) {
  return {
    agentId: type === "model" ? (id ?? null) : null,
    connectorId: type === "connector" ? (id ?? null) : null,
    a2aAgentId: type === "a2a" ? (id ?? null) : null,
  };
}

function subjectColumns(s: Subject) {
  return {
    scope: s.scope,
    userId: s.scope === "user" ? (s.userId ?? null) : null,
    roleId: s.scope === "role" ? (s.roleId ?? null) : null,
    teamId: s.scope === "team" ? (s.teamId ?? null) : null,
  };
}

type Refusal = { status: number; error: string; detail: string };

/** a named resource exists for its type; null = every resource of the type */
async function resourceRefusal(db: Db, type: ResourceType, id: string | null | undefined): Promise<Refusal | null> {
  if (!id) return null;
  const table = type === "model" ? agents : type === "connector" ? connectors : a2aAgents;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id));
  return row ? null : { status: 422, error: "unknown_resource", detail: `no ${type === "model" ? "model" : type === "a2a" ? "remote agent" : "connector"} with that id is registered` };
}

async function subjectRefusal(db: Db, s: Subject): Promise<Refusal | null> {
  if (s.scope === "user") {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, s.userId!));
    return u ? null : { status: 422, error: "unknown_user", detail: "no user with that id" };
  }
  if (s.scope === "role") {
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, s.roleId!));
    return r ? null : { status: 422, error: "unknown_role", detail: "no role with that id" };
  }
  if (s.scope === "team") {
    const [t] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, s.teamId!));
    return t ? null : { status: 422, error: "unknown_team", detail: "no team with that id" };
  }
  return null;
}

const send = (reply: FastifyReply, r: Refusal) => reply.status(r.status).send({ error: r.error, detail: r.detail });
const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_USER;

type ApprovalRuleRow = typeof resourceApprovalRules.$inferSelect;
type RateLimitRow = typeof resourceRateLimits.$inferSelect;

const subjectOf = (r: { scope: string; userId: string | null; roleId: string | null; teamId: string | null }) =>
  r.scope === "user" ? r.userId : r.scope === "role" ? r.roleId : r.scope === "team" ? r.teamId : null;
const resourceOf = (r: { agentId?: string | null; connectorId: string | null; a2aAgentId: string | null }) =>
  r.agentId ?? r.connectorId ?? r.a2aAgentId ?? null;

/** ADR-0226: the governed core's approval rules under the shared list contract */
export const RESOURCE_APPROVAL_RULES_LIST: ListSpec<ApprovalRuleRow> = {
  id: "resource-approval-rules",
  sorts: {
    created: { expr: resourceApprovalRules.createdAt, keysetAt: resourceApprovalRules.createdAt },
    type: { expr: resourceApprovalRules.resourceType },
    scope: { expr: resourceApprovalRules.scope },
    writeOnly: { expr: resourceApprovalRules.writeOnly },
    approver: { expr: resourceApprovalRules.approverUserId },
  },
  columns: {
    type: { label: "Calls", value: (r) => r.resourceType },
    resource: { label: "Resource", value: (r) => resourceOf(r) ?? "every resource" },
    scope: { label: "Applies to", value: (r) => r.scope },
    subject: { label: "Subject", value: (r) => subjectOf(r) },
    writeOnly: { label: "Writes only", value: (r) => r.writeOnly },
    approver: { label: "Approver", value: (r) => r.approverUserId },
    created: { label: "Created", value: (r) => new Date(r.createdAt) },
  },
  filters: ["resourceType"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: resourceApprovalRules.id,
};

/** ADR-0226: the governed core's rate limits under the shared list contract */
export const RESOURCE_RATE_LIMITS_LIST: ListSpec<RateLimitRow> = {
  id: "resource-rate-limits",
  sorts: {
    created: { expr: resourceRateLimits.createdAt, keysetAt: resourceRateLimits.createdAt },
    type: { expr: resourceRateLimits.resourceType },
    scope: { expr: resourceRateLimits.scope },
    maxCalls: { expr: resourceRateLimits.maxCalls },
    window: { expr: resourceRateLimits.windowSeconds },
  },
  columns: {
    type: { label: "Calls", value: (r) => r.resourceType },
    resource: { label: "Resource", value: (r) => resourceOf(r) ?? "every resource" },
    scope: { label: "Applies to", value: (r) => r.scope },
    subject: { label: "Subject", value: (r) => subjectOf(r) },
    maxCalls: { label: "Calls allowed", value: (r) => r.maxCalls },
    window: { label: "Window (s)", value: (r) => r.windowSeconds },
    created: { label: "Created", value: (r) => new Date(r.createdAt) },
  },
  filters: ["resourceType"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: resourceRateLimits.id,
};

/** the fail-closed refusal detail when a writer has no request to step up (never a silent loosening) */
const APPROVAL_RELAX =
  "this change loosens an approval rule (fewer calls held, or a wider approver pool) and needs a step-up, which " +
  "this write path cannot ask for: make the change as an admin in RegulAIt";
const RATE_RELAX =
  "this change loosens a rate limit (more calls, or the same calls over a shorter window) and needs a step-up, which " +
  "this write path cannot ask for: make the change as an admin in RegulAIt";

export function registerResourceRuleRoutes(app: FastifyInstance, db: Db) {
  // ---------------------------------------------------------------------------------------------------------------
  // resource_approval_rules
  // ---------------------------------------------------------------------------------------------------------------

  const approvalRulesList: ContractList<ApprovalRuleRow, { resourceType?: (typeof RESOURCE_APPROVAL_RULE_TYPES)[number] }> = {
    spec: RESOURCE_APPROVAL_RULES_LIST,
    filters: z.object({ resourceType: z.enum(RESOURCE_APPROVAL_RULE_TYPES).optional() }).strict(),
    reader: {
      fetch: (q) =>
        db
          .select({ ...getTableColumns(resourceApprovalRules), _cursorAt: q.cursorAt })
          .from(resourceApprovalRules)
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset),
      countable: (where) => db.select({ one: sql`1` }).from(resourceApprovalRules).where(where),
      idOf: (r) => r.id,
    },
    where: (_req, f) => (f.resourceType ? eq(resourceApprovalRules.resourceType, f.resourceType) : undefined),
  };
  app.get("/v1/rules/resource/approval-rules/export.xlsx", async (req, reply) => answerListExport(db, req, reply, approvalRulesList));
  app.get("/v1/rules/resource/approval-rules", async (req, reply) => answerListPage(db, req, reply, approvalRulesList));

  // Adding a rule only ever holds more calls, so it needs no step-up; it is audited with the write.
  app.post("/v1/rules/resource/approval-rules", async (req, reply) => {
    const body = createResourceApprovalRuleSchema.parse(req.body);
    const refused = (await resourceRefusal(db, body.resourceType, body.resourceId)) ?? (await subjectRefusal(db, body));
    if (refused) return send(reply, refused);
    const subject = subjectColumns(body);
    const row = await db.transaction(async (tx) => {
      // THE ONE GUARD (ADR-0186 A), inside the writer's transaction: a rule whose pool can never approve is refused
      await assertApprovalRuleWritable(tx, approvalRuleShape({ approverUserId: body.approverUserId, ...subject }));
      const [created] = await tx
        .insert(resourceApprovalRules)
        .values({
          resourceType: body.resourceType,
          ...resourceColumns(body.resourceType, body.resourceId),
          ...subject,
          writeOnly: body.writeOnly,
          approverUserId: body.approverUserId,
          createdBy: req.authCtx.userId ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "restriction_rule",
        objectId: created!.id,
        detail: { phase: "resource-approval-rule-create", via: req.authCtx.via, rule: created, receiptClass: "configuration" },
        effect: "allow",
        ruleId: "resource-approval-rule-created",
        ruleChain: [],
        reason: `approval rule added for ${body.resourceType} calls (${body.resourceId ?? "every resource"}, ${body.scope})`,
      });
      return created!;
    });
    return reply.status(201).send(row);
  });

  app.patch("/v1/rules/resource/approval-rules/:ruleId", async (req, reply) => {
    const { ruleId } = idParam.parse(req.params);
    const patch = updateResourceApprovalRuleSchema.parse(req.body ?? {});
    const stepUp = approvalRuleStepUp(db, req);
    const out = await db.transaction(async (tx) => {
      // every decision is taken on the row as locked here, so a concurrent edit cannot turn a judged tightening into
      // an unjudged loosening
      const [locked] = await tx.select().from(resourceApprovalRules).where(eq(resourceApprovalRules.id, ruleId)).for("update");
      if (!locked) return null;
      if (patch.writeOnly === true && locked.resourceType === "model") return "model_write_only" as const;
      const next = { writeOnly: patch.writeOnly ?? locked.writeOnly, approverUserId: patch.approverUserId ?? locked.approverUserId };
      if (next.writeOnly === locked.writeOnly && next.approverUserId === locked.approverUserId) return { rule: locked, changed: false };
      const before = approvalRuleShape(locked);
      const after = approvalRuleShape({ ...locked, ...next });
      await assertApprovalRuleWritable(tx, after);
      // the shared pool predicate (the MCP kinds use it too), plus the resource-specific writeOnly-on: one step-up
      const poolLoosens = await approvalRuleLoosens(tx, before, after);
      const writeOnlyOn = !locked.writeOnly && next.writeOnly;
      const relaxed = [...(writeOnlyOn ? ["writeOnly"] : []), ...(poolLoosens ? ["approverUserId"] : [])];
      if (relaxed.length) {
        const values = {
          quorum: after.quorum ?? 1,
          approverRoleId: after.approverRoleId ?? null,
          approverUserId: after.approverUserId,
          ...(writeOnlyOn ? { writeOnly: true } : {}),
        };
        await requireRuleStepUp(tx, { ruleId, values }, stepUp, APPROVAL_RELAX);
      }
      const [row] = await tx.update(resourceApprovalRules).set(next).where(eq(resourceApprovalRules.id, ruleId)).returning();
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "restriction_rule",
        objectId: ruleId,
        detail: {
          phase: "resource-approval-rule-update",
          via: req.authCtx.via,
          transitions: {
            ...(locked.writeOnly !== next.writeOnly ? { writeOnly: { from: locked.writeOnly, to: next.writeOnly } } : {}),
            ...(locked.approverUserId !== next.approverUserId ? { approverUserId: { from: locked.approverUserId, to: next.approverUserId } } : {}),
          },
          ...(relaxed.length ? { relaxed, stepUp: "settings_relax" } : {}),
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "resource-approval-rule-updated",
        ruleChain: [],
        reason: `approval rule for ${locked.resourceType} calls changed${relaxed.length ? ` — RELAXED: ${relaxed.join(", ")}` : ""}`,
      });
      return { rule: row!, changed: true };
    });
    if (out === null) return reply.status(404).send({ error: "unknown_rule" });
    if (out === "model_write_only") {
      return reply.status(400).send({ error: "validation", detail: "a model call is never a write: writeOnly cannot be set on a model rule" });
    }
    return reply.send(out);
  });

  // Removing a rule releases every call it held: the shared loosening guard (a removal always loosens) asks the
  // settings_relax step-up inside the lock; audited in the same transaction.
  app.delete("/v1/rules/resource/approval-rules/:ruleId", async (req, reply) => {
    const { ruleId } = idParam.parse(req.params);
    const stepUp = approvalRuleStepUp(db, req);
    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(resourceApprovalRules).where(eq(resourceApprovalRules.id, ruleId)).for("update");
      if (!locked) return false;
      await assertApprovalRuleLooseningStepUp(tx, { ruleId, before: approvalRuleShape(locked), after: null, stepUp });
      await tx.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, ruleId));
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "restriction_rule",
        objectId: ruleId,
        detail: { phase: "resource-approval-rule-delete", via: req.authCtx.via, rule: locked, relaxation: true, stepUp: "settings_relax", receiptClass: "configuration" },
        effect: "allow",
        ruleId: "resource-approval-rule-deleted",
        ruleChain: [],
        reason: `approval rule for ${locked.resourceType} calls removed — a relaxation`,
      });
      return true;
    });
    if (!deleted) return reply.status(404).send({ error: "unknown_rule" });
    return reply.send({ deleted: true });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // resource_rate_limits (model limits stay in model_rate_limits: one fact in one place)
  // ---------------------------------------------------------------------------------------------------------------

  const rateLimitsList: ContractList<RateLimitRow, { resourceType?: (typeof RESOURCE_RATE_LIMIT_TYPES)[number] }> = {
    spec: RESOURCE_RATE_LIMITS_LIST,
    filters: z.object({ resourceType: z.enum(RESOURCE_RATE_LIMIT_TYPES).optional() }).strict(),
    reader: {
      fetch: (q) =>
        db
          .select({ ...getTableColumns(resourceRateLimits), _cursorAt: q.cursorAt })
          .from(resourceRateLimits)
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset),
      countable: (where) => db.select({ one: sql`1` }).from(resourceRateLimits).where(where),
      idOf: (r) => r.id,
    },
    where: (_req, f) => (f.resourceType ? eq(resourceRateLimits.resourceType, f.resourceType) : undefined),
  };
  app.get("/v1/rules/resource/rate-limits/export.xlsx", async (req, reply) => answerListExport(db, req, reply, rateLimitsList));
  app.get("/v1/rules/resource/rate-limits", async (req, reply) => answerListPage(db, req, reply, rateLimitsList));

  app.post("/v1/rules/resource/rate-limits", async (req, reply) => {
    const body = createResourceRateLimitSchema.parse(req.body);
    const refused = (await resourceRefusal(db, body.resourceType, body.resourceId)) ?? (await subjectRefusal(db, body));
    if (refused) return send(reply, refused);
    const row = await db.transaction(async (tx) => {
      const { agentId: _agentId, ...resource } = resourceColumns(body.resourceType, body.resourceId);
      const [created] = await tx
        .insert(resourceRateLimits)
        .values({
          resourceType: body.resourceType,
          ...resource,
          ...subjectColumns(body),
          maxCalls: body.maxCalls,
          windowSeconds: body.windowSeconds,
          createdBy: req.authCtx.userId ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "restriction_rule",
        objectId: created!.id,
        detail: { phase: "resource-rate-limit-create", via: req.authCtx.via, rule: created, receiptClass: "configuration" },
        effect: "allow",
        ruleId: "resource-rate-limit-created",
        ruleChain: [],
        reason: `rate limit added for ${body.resourceType} calls: ${body.maxCalls} calls per ${body.windowSeconds}s (${body.scope})`,
      });
      return created!;
    });
    return reply.status(201).send(row);
  });

  app.patch("/v1/rules/resource/rate-limits/:ruleId", async (req, reply) => {
    const { ruleId } = idParam.parse(req.params);
    const patch = updateResourceRateLimitSchema.parse(req.body ?? {});
    const stepUp = approvalRuleStepUp(db, req);
    const out = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(resourceRateLimits).where(eq(resourceRateLimits.id, ruleId)).for("update");
      if (!locked) return null;
      const next = { maxCalls: patch.maxCalls ?? locked.maxCalls, windowSeconds: patch.windowSeconds ?? locked.windowSeconds };
      if (next.maxCalls === locked.maxCalls && next.windowSeconds === locked.windowSeconds) return { rule: locked, changed: false };
      // judged on the locked row; the step-up is asked inside the lock, like every rule writer (ADR-0186 decision 28)
      const relaxes = rateLimitChangeRelaxes(locked, next);
      if (relaxes) await requireRuleStepUp(tx, { ruleId, values: { ...next } }, stepUp, RATE_RELAX);
      const [row] = await tx.update(resourceRateLimits).set(next).where(eq(resourceRateLimits.id, ruleId)).returning();
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "restriction_rule",
        objectId: ruleId,
        detail: {
          phase: "resource-rate-limit-update",
          via: req.authCtx.via,
          transitions: {
            maxCalls: { from: locked.maxCalls, to: next.maxCalls },
            windowSeconds: { from: locked.windowSeconds, to: next.windowSeconds },
          },
          ...(relaxes ? { relaxed: ["maxCalls", "windowSeconds"], stepUp: "settings_relax" } : {}),
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "resource-rate-limit-updated",
        ruleChain: [],
        reason:
          `rate limit for ${locked.resourceType} calls changed from ${locked.maxCalls}/${locked.windowSeconds}s to ` +
          `${next.maxCalls}/${next.windowSeconds}s${relaxes ? " — RELAXED" : ""}`,
      });
      return { rule: row!, changed: true };
    });
    if (out === null) return reply.status(404).send({ error: "unknown_rule" });
    return reply.send(out);
  });

  app.delete("/v1/rules/resource/rate-limits/:ruleId", async (req, reply) => {
    const { ruleId } = idParam.parse(req.params);
    const stepUp = approvalRuleStepUp(db, req);
    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(resourceRateLimits).where(eq(resourceRateLimits.id, ruleId)).for("update");
      if (!locked) return false;
      await assertRuleRemovalStepUp(tx, { ruleId, stepUp });
      await tx.delete(resourceRateLimits).where(eq(resourceRateLimits.id, ruleId));
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "restriction_rule",
        objectId: ruleId,
        detail: { phase: "resource-rate-limit-delete", via: req.authCtx.via, rule: locked, relaxation: true, stepUp: "settings_relax", receiptClass: "configuration" },
        effect: "allow",
        ruleId: "resource-rate-limit-deleted",
        ruleChain: [],
        reason: `rate limit for ${locked.resourceType} calls removed (${locked.maxCalls} calls per ${locked.windowSeconds}s, ${locked.scope}) — a relaxation`,
      });
      return true;
    });
    if (!deleted) return reply.status(404).send({ error: "unknown_rule" });
    return reply.send({ deleted: true });
  });
}
