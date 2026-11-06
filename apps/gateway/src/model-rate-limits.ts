/**
 * ADR-0212 (P12 c) — rate limits keyed on the MODEL, and (P12 b) the admin write of an
 * agent's per-modality prices.
 *
 * A model rate limit binds a subject (user, role, team or fleet, the pillar-1 scopes) to
 * one agent registry entry: at most `maxCalls` dispatches served by that agent inside a
 * sliding window of `windowSeconds`. It is enforced in the one governed-dispatch core
 * (`checkModelRateLimit`, called beside the lifecycle and virtual-key gates), so every
 * dispatch path inherits it. Usage is counted from `usage_events` agent rows, per user
 * (a role, team or fleet limit still counts each user separately, as `rate_limits`
 * does), on the database clock. A refusal is `429 model_rate_limited`, audited.
 *
 * Off by default: limits can be written at any time but bind only once an admin turns
 * enforcement on (`PUT /v1/rules/model-rate-limits/enforcement`, step-up, audited).
 * Turning it off again, and removing a limit, are relaxations and need the step-up too.
 *
 * Like the tool-path limits, the count is taken before the dispatch and the row written
 * after it, so concurrent dispatches from one user can overrun a limit by the number in
 * flight. Disclosed in ADR-0212.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  auditLog,
  modelRateLimits,
  orgSettings,
  ORG_SETTINGS_ID,
  usageEvents,
  and,
  count,
  eq,
  gt,
  inArray,
  or,
  sql,
  type Db,
} from "@regulait/db";
import {
  createModelRateLimitSchema,
  setAgentModalityPricingSchema,
  setModelRateLimitEnforcementSchema,
} from "@regulait/shared";
import { loadScopeMemberships } from "./entitlements.js";
import { requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export interface ModelRateLimitRefusal {
  ok: false;
  status: 429;
  error: "model_rate_limited";
  detail: string;
  ruleId: string;
  retryAfterSeconds: number;
}

async function enforcementEnabled(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ on: orgSettings.modelRateLimitsEnabled })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return row?.on === true;
}

/**
 * The dispatch-time check. `null` = proceed. The first exhausted limit refuses
 * (tightest wins, no summing), and the refusal is audited before it is returned.
 */
export async function checkModelRateLimit(
  db: Db,
  args: { userId: string; agentId: string; agentName: string; projectId?: string | null },
): Promise<ModelRateLimitRefusal | null> {
  if (!(await enforcementEnabled(db))) return null;
  const { roleIds, teamIds } = await loadScopeMemberships(db, args.userId);
  const subject = [
    eq(modelRateLimits.scope, "fleet"),
    and(eq(modelRateLimits.scope, "user"), eq(modelRateLimits.userId, args.userId)),
    ...(roleIds.length ? [and(eq(modelRateLimits.scope, "role"), inArray(modelRateLimits.roleId, roleIds))] : []),
    ...(teamIds.length ? [and(eq(modelRateLimits.scope, "team"), inArray(modelRateLimits.teamId, teamIds))] : []),
  ];
  const limits = await db
    .select()
    .from(modelRateLimits)
    .where(and(eq(modelRateLimits.agentId, args.agentId), or(...subject)))
    .orderBy(modelRateLimits.windowSeconds, modelRateLimits.id);
  for (const limit of limits) {
    const [used] = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, args.userId),
          eq(usageEvents.agentId, args.agentId),
          eq(usageEvents.objectType, "agent"),
          gt(usageEvents.at, sql`now() - make_interval(secs => ${limit.windowSeconds})`),
        ),
      );
    const n = Number(used?.n ?? 0);
    if (n < limit.maxCalls) continue;
    const reason =
      `model rate limit reached for '${args.agentName}': ${n}/${limit.maxCalls} calls in ${limit.windowSeconds}s ` +
      `(${limit.scope} limit)`;
    await db.insert(auditLog).values({
      userId: args.userId,
      objectType: "agent",
      objectId: args.agentId,
      detail: {
        phase: "model-rate-limit",
        modelRateLimitId: limit.id,
        scope: limit.scope,
        maxCalls: limit.maxCalls,
        windowSeconds: limit.windowSeconds,
        used: n,
        ...(args.projectId ? { projectId: args.projectId } : {}),
        receiptClass: "decision",
      },
      effect: "deny",
      ruleId: "model-rate-limit",
      ruleChain: [{ rule: "model-rate-limit", outcome: "deny", grantId: limit.id }],
      reason,
    });
    return {
      ok: false,
      status: 429,
      error: "model_rate_limited",
      detail: reason,
      ruleId: limit.id,
      retryAfterSeconds: limit.windowSeconds,
    };
  }
  return null;
}

const idParam = z.object({ ruleId: z.string().uuid() });
const agentIdParam = z.object({ agentId: z.string().uuid() });

/** Admin-only through the global gate, like every /v1/rules and /v1/agents write. */
export function registerModelRateLimitRoutes(app: FastifyInstance, db: Db) {
  app.get("/v1/rules/model-rate-limits", async () => {
    const [rules, enabled] = await Promise.all([
      db.select().from(modelRateLimits).orderBy(modelRateLimits.createdAt).limit(500),
      enforcementEnabled(db),
    ]);
    return { enforcementEnabled: enabled, rules };
  });

  // Adding a limit only ever restricts, so it needs no step-up; it is audited with the write.
  app.post("/v1/rules/model-rate-limits", async (req, reply) => {
    const body = createModelRateLimitSchema.parse(req.body);
    const [agent] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, body.agentId));
    if (!agent) return reply.status(422).send({ error: "unknown_agent", detail: "no model with that id is registered" });
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(modelRateLimits)
        .values({
          scope: body.scope,
          userId: body.scope === "user" ? body.userId! : null,
          roleId: body.scope === "role" ? body.roleId! : null,
          teamId: body.scope === "team" ? body.teamId! : null,
          agentId: body.agentId,
          maxCalls: body.maxCalls,
          windowSeconds: body.windowSeconds,
          createdBy: req.authCtx.userId ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        objectType: "restriction_rule",
        objectId: created!.id,
        detail: { phase: "model-rate-limit-create", via: req.authCtx.via, rule: created, receiptClass: "configuration" },
        effect: "allow",
        ruleId: "model-rate-limit-created",
        ruleChain: [],
        reason: `model rate limit added for '${agent.name}': ${body.maxCalls} calls per ${body.windowSeconds}s (${body.scope})`,
      });
      return created!;
    });
    return reply.status(201).send(row);
  });

  // Removing a limit removes a restriction: settings_relax step-up, audited in the same transaction.
  app.delete("/v1/rules/model-rate-limits/:ruleId", async (req, reply) => {
    const { ruleId } = idParam.parse(req.params);
    const [existing] = await db.select().from(modelRateLimits).where(eq(modelRateLimits.id, ruleId));
    if (!existing) return reply.status(404).send({ error: "unknown_rule" });
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { values: { modelRateLimitRemoved: { ruleId } } },
    });
    if (!su.ok) return reply;
    const deleted = await db.transaction(async (tx) => {
      const rows = await tx.delete(modelRateLimits).where(eq(modelRateLimits.id, ruleId)).returning();
      if (rows.length === 0) return false;
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        objectType: "restriction_rule",
        objectId: ruleId,
        detail: { phase: "model-rate-limit-delete", via: req.authCtx.via, rule: existing, relaxation: true, stepUp: su.method, receiptClass: "configuration" },
        effect: "allow",
        ruleId: "model-rate-limit-deleted",
        ruleChain: [],
        reason: `model rate limit removed (${existing.maxCalls} calls per ${existing.windowSeconds}s, ${existing.scope}) — a relaxation`,
      });
      return true;
    });
    if (!deleted) return reply.status(404).send({ error: "unknown_rule" });
    return reply.send({ deleted: true });
  });

  // The org opt-in. Off by default; both directions need the step-up (turning it on is the
  // owner's opt-in gate, turning it off lifts every limit at once) and are audited old -> new.
  app.put("/v1/rules/model-rate-limits/enforcement", async (req, reply) => {
    const { enabled } = setModelRateLimitEnforcementSchema.parse(req.body);
    const before = await enforcementEnabled(db);
    if (before === enabled) return reply.send({ enforcementEnabled: enabled, changed: false });
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { values: { modelRateLimitsEnabled: enabled } },
    });
    if (!su.ok) return reply;
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ on: orgSettings.modelRateLimitsEnabled })
        .from(orgSettings)
        .where(eq(orgSettings.id, ORG_SETTINGS_ID))
        .for("update");
      await tx
        .update(orgSettings)
        .set({ modelRateLimitsEnabled: enabled, updatedBy: req.authCtx.userId ?? null, updatedAt: new Date() })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID));
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        objectType: "org_settings",
        objectId: null,
        detail: {
          via: req.authCtx.via,
          changed: { modelRateLimitsEnabled: enabled },
          transitions: { modelRateLimitsEnabled: { from: locked?.on ?? false, to: enabled } },
          ...(enabled ? {} : { relaxed: ["modelRateLimitsEnabled"] }),
          stepUp: su.method,
        },
        effect: "allow",
        ruleId: "org-settings-updated",
        ruleChain: [],
        reason: enabled
          ? "model rate limits turned on — limits keyed on a model now bind"
          : "model rate limits turned off — RELAXED: no model rate limit binds",
      });
    });
    return reply.send({ enforcementEnabled: enabled, changed: true });
  });

  // ADR-0212 (P12 b): an agent's per-modality list prices. A price change moves what spend is
  // attributed, so it is admin-only and audited old -> new in the same transaction. It is not
  // a relaxation of any control, so it needs no step-up (as the text-price PATCH does not).
  app.put("/v1/agents/:agentId/modality-pricing", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const body = setAgentModalityPricingSchema.parse(req.body ?? {});
    const out = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
      if (!existing) return null;
      const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Record<string, number | null>;
      const transitions = Object.fromEntries(
        Object.entries(patch).map(([k, v]) => [k, { from: (existing as Record<string, unknown>)[k] ?? null, to: v }]),
      );
      const [row] = Object.keys(patch).length
        ? await tx.update(agents).set(patch).where(eq(agents.id, agentId)).returning()
        : [existing];
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        objectType: "agent",
        objectId: agentId,
        detail: { phase: "modality-pricing", via: req.authCtx.via, transitions, receiptClass: "configuration" },
        effect: "allow",
        ruleId: "agent-modality-pricing-set",
        ruleChain: [],
        reason: `modality prices of '${existing.name}' set: ${Object.keys(patch).join(", ") || "no change"}`,
      });
      return row!;
    });
    if (!out) return reply.status(404).send({ error: "unknown_agent" });
    return reply.send({
      id: out.id,
      costPerMTokImageIn: out.costPerMTokImageIn,
      costPerMTokImageOut: out.costPerMTokImageOut,
      costPerMTokAudioIn: out.costPerMTokAudioIn,
      costPerMTokAudioOut: out.costPerMTokAudioOut,
    });
  });
}
