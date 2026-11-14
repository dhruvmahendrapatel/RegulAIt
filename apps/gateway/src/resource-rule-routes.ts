/**
 * ADR-0251 (P-01 remainder, review #715 finding 4) — the admin routes for the governed core's resource rules:
 *
 *   GET    /v1/rules/resource/approval-rules            list (keyset-paginated, optional resourceType filter)
 *   POST   /v1/rules/resource/approval-rules            add a rule (only ever restricts: no step-up)
 *   PATCH  /v1/rules/resource/approval-rules/:ruleId    change the approver or writeOnly
 *   DELETE /v1/rules/resource/approval-rules/:ruleId    remove a rule (a relaxation: step-up)
 *   GET    /v1/rules/resource/rate-limits               list
 *   POST   /v1/rules/resource/rate-limits               add a limit (only ever restricts: no step-up)
 *   PATCH  /v1/rules/resource/rate-limits/:ruleId       change maxCalls or windowSeconds
 *   DELETE /v1/rules/resource/rate-limits/:ruleId       remove a limit (a relaxation: step-up)
 *
 * Admin only through the global gate, like every /v1/rules write. Every removal or loosening needs a `settings_relax`
 * step-up bound to the exact change; tightening needs none. Every write is audited in the SAME transaction as the
 * write, with the row before and after (`objectType: restriction_rule`, `receiptClass: configuration`), so the log can
 * never disagree with the table. A rule's subject and resource binding are its identity: they are not editable
 * (delete it and create a new one), as for the MCP rule kinds (ADR-0073 §2).
 *
 * What counts as a loosening:
 *  - approval rule: removing it; turning `writeOnly` on (it then holds fewer calls); changing the approver (a
 *    different person releases the calls, which can only be judged by a person, so it is always stepped up).
 *  - rate limit: removing it; more calls, or the same calls over a shorter window (`rateLimitChangeRelaxes`).
 *
 * The tables need no new migration: they shipped with ADR-0251 slice 1 (`governed_core_resource_rules`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  a2aAgents,
  agents,
  and,
  asc,
  auditLog,
  connectors,
  eq,
  gt,
  resourceApprovalRules,
  resourceRateLimits,
  roles,
  teams,
  users,
  type Db,
} from "@regulait/db";
import {
  createResourceApprovalRuleSchema,
  createResourceRateLimitSchema,
  listResourceRulesQuerySchema,
  rateLimitChangeRelaxes,
  updateResourceApprovalRuleSchema,
  updateResourceRateLimitSchema,
} from "@regulait/shared";
import { requireStepUp } from "./step-up.js";

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

/**
 * The approver must be an active user who is not the rule's own subject: the caller is never in their own approval
 * pool (ADR-0186 A), so such a rule could only ever refuse, and should be refused when it is written instead.
 */
async function approverRefusal(db: Db, approverUserId: string, subject: Subject): Promise<Refusal | null> {
  const [a] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, approverUserId));
  if (!a) return { status: 422, error: "unknown_approver", detail: "no user with that approverUserId" };
  if (a.disabledAt) return { status: 422, error: "approver_disabled", detail: "the approver's account is disabled; name an active user" };
  if (subject.scope === "user" && subject.userId === approverUserId) {
    return {
      status: 422,
      error: "approver_is_subject",
      detail: "a person can never approve their own call, so this rule could only refuse; name a different approver",
    };
  }
  return null;
}

const send = (reply: FastifyReply, r: Refusal) => reply.status(r.status).send({ error: r.error, detail: r.detail });
const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_USER;

export function registerResourceRuleRoutes(app: FastifyInstance, db: Db) {
  // ---------------------------------------------------------------------------------------------------------------
  // resource_approval_rules
  // ---------------------------------------------------------------------------------------------------------------

  app.get("/v1/rules/resource/approval-rules", async (req) => {
    const q = listResourceRulesQuerySchema.parse(req.query ?? {});
    const rows = await db
      .select()
      .from(resourceApprovalRules)
      .where(
        and(
          q.resourceType ? eq(resourceApprovalRules.resourceType, q.resourceType) : undefined,
          q.after ? gt(resourceApprovalRules.id, q.after) : undefined,
        ),
      )
      .orderBy(asc(resourceApprovalRules.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { rules: page, next: rows.length > q.limit ? page[page.length - 1]!.id : null };
  });

  // Adding a rule only ever holds more calls, so it needs no step-up; it is audited with the write.
  app.post("/v1/rules/resource/approval-rules", async (req, reply) => {
    const body = createResourceApprovalRuleSchema.parse(req.body);
    const refused =
      (await resourceRefusal(db, body.resourceType, body.resourceId)) ??
      (await subjectRefusal(db, body)) ??
      (await approverRefusal(db, body.approverUserId, body));
    if (refused) return send(reply, refused);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(resourceApprovalRules)
        .values({
          resourceType: body.resourceType,
          ...resourceColumns(body.resourceType, body.resourceId),
          ...subjectColumns(body),
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
    const [existing] = await db.select().from(resourceApprovalRules).where(eq(resourceApprovalRules.id, ruleId));
    if (!existing) return reply.status(404).send({ error: "unknown_rule" });
    if (patch.writeOnly === true && existing.resourceType === "model") {
      return reply.status(400).send({ error: "validation", detail: "a model call is never a write: writeOnly cannot be set on a model rule" });
    }
    const next = { writeOnly: patch.writeOnly ?? existing.writeOnly, approverUserId: patch.approverUserId ?? existing.approverUserId };
    if (next.writeOnly === existing.writeOnly && next.approverUserId === existing.approverUserId) {
      return reply.send({ rule: existing, changed: false });
    }
    if (next.approverUserId !== existing.approverUserId) {
      const refused = await approverRefusal(db, next.approverUserId, existing);
      if (refused) return send(reply, refused);
    }
    const relaxed: string[] = [];
    if (!existing.writeOnly && next.writeOnly) relaxed.push("writeOnly");
    if (next.approverUserId !== existing.approverUserId) relaxed.push("approverUserId");
    let stepUp: string | null = null;
    if (relaxed.length) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { values: { resourceApprovalRuleChanged: { ruleId, ...next } } },
      });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    const out = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(resourceApprovalRules).where(eq(resourceApprovalRules.id, ruleId)).for("update");
      if (!locked) return null;
      // the step-up judged the row as read above; a concurrent edit in between is re-judged, never assumed
      if (!relaxed.length && ((!locked.writeOnly && next.writeOnly) || locked.approverUserId !== next.approverUserId)) return "stale" as const;
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
          ...(relaxed.length ? { relaxed, stepUp } : {}),
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "resource-approval-rule-updated",
        ruleChain: [],
        reason: `approval rule for ${locked.resourceType} calls changed${relaxed.length ? ` — RELAXED: ${relaxed.join(", ")}` : ""}`,
      });
      return row!;
    });
    if (out === null) return reply.status(404).send({ error: "unknown_rule" });
    if (out === "stale") {
      return reply.status(409).send({ error: "rule_changed", detail: "the rule changed while this edit was being made; read it again and retry" });
    }
    return reply.send({ rule: out, changed: true });
  });

  // Removing a rule releases every call it held: settings_relax step-up, audited in the same transaction.
  app.delete("/v1/rules/resource/approval-rules/:ruleId", async (req, reply) => {
    const { ruleId } = idParam.parse(req.params);
    const [existing] = await db.select().from(resourceApprovalRules).where(eq(resourceApprovalRules.id, ruleId));
    if (!existing) return reply.status(404).send({ error: "unknown_rule" });
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { values: { resourceApprovalRuleRemoved: { ruleId } } },
    });
    if (!su.ok) return reply;
    const deleted = await db.transaction(async (tx) => {
      const rows = await tx.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, ruleId)).returning();
      if (rows.length === 0) return false;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "restriction_rule",
        objectId: ruleId,
        detail: { phase: "resource-approval-rule-delete", via: req.authCtx.via, rule: rows[0], relaxation: true, stepUp: su.method, receiptClass: "configuration" },
        effect: "allow",
        ruleId: "resource-approval-rule-deleted",
        ruleChain: [],
        reason: `approval rule for ${existing.resourceType} calls removed — a relaxation`,
      });
      return true;
    });
    if (!deleted) return reply.status(404).send({ error: "unknown_rule" });
    return reply.send({ deleted: true });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // resource_rate_limits
  // ---------------------------------------------------------------------------------------------------------------

  app.get("/v1/rules/resource/rate-limits", async (req, reply) => {
    const q = listResourceRulesQuerySchema.parse(req.query ?? {});
    if (q.resourceType === "model") {
      return reply.status(400).send({ error: "validation", detail: "model rate limits are listed at /v1/rules/model-rate-limits" });
    }
    const rows = await db
      .select()
      .from(resourceRateLimits)
      .where(
        and(
          q.resourceType ? eq(resourceRateLimits.resourceType, q.resourceType) : undefined,
          q.after ? gt(resourceRateLimits.id, q.after) : undefined,
        ),
      )
      .orderBy(asc(resourceRateLimits.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { rules: page, next: rows.length > q.limit ? page[page.length - 1]!.id : null };
  });

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
    const [existing] = await db.select().from(resourceRateLimits).where(eq(resourceRateLimits.id, ruleId));
    if (!existing) return reply.status(404).send({ error: "unknown_rule" });
    const next = { maxCalls: patch.maxCalls ?? existing.maxCalls, windowSeconds: patch.windowSeconds ?? existing.windowSeconds };
    if (next.maxCalls === existing.maxCalls && next.windowSeconds === existing.windowSeconds) {
      return reply.send({ rule: existing, changed: false });
    }
    const relaxes = rateLimitChangeRelaxes(existing, next);
    let stepUp: string | null = null;
    if (relaxes) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { values: { resourceRateLimitChanged: { ruleId, ...next } } },
      });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    const out = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(resourceRateLimits).where(eq(resourceRateLimits.id, ruleId)).for("update");
      if (!locked) return null;
      // the step-up judged the row as read above; a concurrent edit in between is re-judged, never assumed
      if (!relaxes && rateLimitChangeRelaxes(locked, next)) return "stale" as const;
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
          ...(relaxes ? { relaxed: ["maxCalls", "windowSeconds"], stepUp } : {}),
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "resource-rate-limit-updated",
        ruleChain: [],
        reason:
          `rate limit for ${locked.resourceType} calls changed from ${locked.maxCalls}/${locked.windowSeconds}s to ` +
          `${next.maxCalls}/${next.windowSeconds}s${relaxes ? " — RELAXED" : ""}`,
      });
      return row!;
    });
    if (out === null) return reply.status(404).send({ error: "unknown_rule" });
    if (out === "stale") {
      return reply.status(409).send({ error: "rule_changed", detail: "the limit changed while this edit was being made; read it again and retry" });
    }
    return reply.send({ rule: out, changed: true });
  });

  app.delete("/v1/rules/resource/rate-limits/:ruleId", async (req, reply) => {
    const { ruleId } = idParam.parse(req.params);
    const [existing] = await db.select().from(resourceRateLimits).where(eq(resourceRateLimits.id, ruleId));
    if (!existing) return reply.status(404).send({ error: "unknown_rule" });
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { values: { resourceRateLimitRemoved: { ruleId } } },
    });
    if (!su.ok) return reply;
    const deleted = await db.transaction(async (tx) => {
      const rows = await tx.delete(resourceRateLimits).where(eq(resourceRateLimits.id, ruleId)).returning();
      if (rows.length === 0) return false;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "restriction_rule",
        objectId: ruleId,
        detail: { phase: "resource-rate-limit-delete", via: req.authCtx.via, rule: rows[0], relaxation: true, stepUp: su.method, receiptClass: "configuration" },
        effect: "allow",
        ruleId: "resource-rate-limit-deleted",
        ruleChain: [],
        reason: `rate limit for ${existing.resourceType} calls removed (${existing.maxCalls} calls per ${existing.windowSeconds}s, ${existing.scope}) — a relaxation`,
      });
      return true;
    });
    if (!deleted) return reply.status(404).send({ error: "unknown_rule" });
    return reply.send({ deleted: true });
  });
}
