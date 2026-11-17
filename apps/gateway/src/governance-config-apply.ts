/**
 * ADR-0357 slice 1b: apply a governance-config document.
 *
 *   POST /v1/governance-config/apply   { content | document, planHash }
 *
 * The order, every step of which refuses rather than guesses:
 *  1. plan it again (the dry run), unlocked: a document error is a 400, an unresolved name is a 422, a planHash that
 *     is not this plan's is a 409 `plan_stale` (what is written is exactly what was reviewed);
 *  2. a `settings_relax` step-up bound to `{op: "governance_config_apply", planHash, widenings}` — the relaxation path
 *     the UI's grant mint uses (ADR-0250), asked on every apply that writes anything;
 *  3. one transaction under an advisory lock: read the live configuration and plan AGAIN; a different planHash or a
 *     new issue is `changed_concurrently` (409). Then every change is written through the store the UI writes, and
 *     any refusal rolls every change back (all or nothing).
 *
 * Writers reused, not re-implemented: `lockRoleOrRefuse` (the steward serialization), `checkSodMint` (ADR-0091),
 * `approverPoolShiftFacts` + `lockApproverRoles` (ADR-0229, a role delete), `applyRuleEdit` and `deleteRuleArtifact`
 * (ADR-0074 versioned rate limits), `applyProjectPatch` (the project PATCH core). A rule writer's own loosening guard
 * still runs: it is handed a callback that accepts a loosening only where the plan classified that change as
 * widening, so a classification gap fails closed instead of slipping past the step-up.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  connectors,
  eq,
  inArray,
  mcpServers,
  projects,
  rateLimits,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  roles,
  sql,
  teams,
  type Db,
} from "@regulait/db";
import {
  GOVERNANCE_CONFIG_LIMITS,
  canonicalJson,
  normalizeSpec,
  planGovernanceConfig,
  planWidenings,
  type GovernanceChange,
  type GovernancePlan,
  type NormalBudget,
  type NormalRateLimit,
  type NormalRole,
} from "@regulait/shared";
import { approverPoolShiftFacts, lockApproverRoles } from "./approval-pool.js";
import { deleteRuleArtifact } from "./config-versions.js";
import {
  GovernanceDocumentError,
  parseGovernanceDocument,
  planGovernanceDocument,
  readLive,
  referenceIssues,
  type LiveIndex,
  type PlanIssue,
} from "./governance-config.js";
import { applyProjectPatch } from "./projects.js";
import { applyRuleEdit, isRuleEditRefusal } from "./rule-writes.js";
import { checkSodMint, type SodMint } from "./sod.js";
import { requireStepUp } from "./step-up.js";
import { lockRoleOrRefuse, RoleNotFoundError } from "./workload-identity-admin.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const APPLY_ROUTE = "POST /v1/governance-config/apply";

/** a refusal inside the apply transaction: thrown, so the transaction rolls back, then answered */
export class ApplyRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly error: string,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
  }
}

/** sections apply writes today; a plan with changes elsewhere is refused whole (ADR-0357 slicing) */
export const APPLIABLE_SECTIONS = ["roles", "rateLimits", "budgets"] as const;

/** the settings_relax step-up an apply is bound to: the plan and exactly the changes in it that widen */
export function applyStepUpFacts(plan: GovernancePlan) {
  return { op: "governance_config_apply", planHash: plan.planHash, widenings: planWidenings(plan) };
}

// ---------------------------------------------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------------------------------------------

interface Ctx {
  tx: Db;
  actor: string | null;
  plan: GovernancePlan;
  index: LiveIndex;
  roleIds: Map<string, string>;
}

/** Plans again inside the lock and writes every change; throws ApplyRefusal to roll back. */
export async function applyLocked(tx: Db, content: string, planHash: string, actor: string | null): Promise<GovernancePlan> {
  // one apply at a time (a second waits, then re-plans and finds its planHash stale)
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('regulait.governance_config.apply'))`);
  const doc = parseGovernanceDocument(content);
  const desired = normalizeSpec(doc.spec);
  const { spec, index } = await readLive(tx);
  const plan = planGovernanceConfig(spec, desired);
  if (plan.planHash !== planHash) {
    throw new ApplyRefusal(409, "changed_concurrently", "the live configuration changed after the plan was made; plan again and review the new diff", {
      planHash: plan.planHash,
    });
  }
  const issues = await referenceIssues(tx, plan, desired);
  if (issues.length) throw new ApplyRefusal(409, "changed_concurrently", "a name the plan resolved no longer resolves; plan again", { issues });

  const ctx: Ctx = { tx, actor, plan, index, roleIds: new Map(index.roleIds) };
  const by = (s: GovernanceChange["section"]) => plan.changes.filter((c) => c.section === s);
  // roles first (a limit may name a role the same file creates); a role's deletion last (it cascades its limits)
  for (const c of by("roles").filter((c) => c.op !== "delete")) await writeRole(ctx, c);
  for (const c of by("rateLimits")) await writeRateLimit(ctx, c);
  for (const c of by("budgets")) await writeBudget(ctx, c);
  for (const c of by("roles").filter((c) => c.op === "delete")) await deleteRole(ctx, c);

  for (const c of plan.changes) {
    await tx.insert(auditLog).values({
      userId: actor ?? NIL_USER,
      objectType: "governance_config",
      objectId: null,
      detail: { phase: "apply-change", planHash, section: c.section, key: c.key, op: c.op, effect: c.effect, findings: c.findings, patch: c.patch },
      effect: "allow",
      ruleId: "governance_config.apply.change",
      ruleChain: [],
      reason: `${c.section} ${c.key}: ${c.op} (${c.effect})`,
    });
  }
  await tx.insert(auditLog).values({
    userId: actor ?? NIL_USER,
    objectType: "governance_config",
    objectId: null,
    detail: { phase: "apply", planHash, liveRevision: plan.liveRevision, desiredRevision: plan.desiredRevision, sections: plan.sections, summary: plan.summary },
    effect: "allow",
    ruleId: "governance_config.apply",
    reason: `governance configuration applied: ${plan.changes.length} change(s)`,
    ruleChain: [],
  });
  return plan;
}

/** a rule writer's loosening guard, answered from the plan: only a change the plan marked as widening may loosen */
const looseningGuard = (c: GovernanceChange) => async () => {
  if (c.effect !== "widens") {
    throw new ApplyRefusal(409, "classification_mismatch", `the rule writer found a loosening in ${c.section} ${c.key} that the plan did not mark as widening; nothing was applied`);
  }
};

async function sodOrRefuse(ctx: Ctx, c: GovernanceChange, mint: SodMint) {
  const conflict = await checkSodMint(ctx.tx, mint);
  if (conflict) {
    throw new ApplyRefusal(409, "sod_conflict", `${c.section} ${c.key}: the grant would give a holder both sides of separation-of-duties rule '${conflict.rule.name}'`, {
      mint: mint as unknown as Record<string, unknown>,
    });
  }
}

async function idsByName<T extends { id: string; name: string }>(rows: Promise<T[]>): Promise<Map<string, string>> {
  return new Map((await rows).map((r) => [r.name, r.id]));
}

const EMPTY_ROLE: NormalRole = { name: "", description: null, toolGrants: [], serverGrants: [], agentGrants: [], connectorGrants: [] };

async function writeRole(ctx: Ctx, c: GovernanceChange) {
  const { tx } = ctx;
  const before = (c.before as NormalRole | null) ?? EMPTY_ROLE;
  const after = c.after as NormalRole;
  let roleId = ctx.roleIds.get(after.name);
  if (c.op === "create") {
    const [row] = await tx.insert(roles).values({ name: after.name, description: after.description }).returning({ id: roles.id });
    roleId = row!.id;
    ctx.roleIds.set(after.name, roleId);
  } else {
    try {
      await lockRoleOrRefuse(tx, roleId!);
    } catch (e) {
      if (e instanceof RoleNotFoundError) throw new ApplyRefusal(409, "changed_concurrently", `role ${after.name} no longer exists; plan again`);
      throw e;
    }
    if (before.description !== after.description) await tx.update(roles).set({ description: after.description }).where(eq(roles.id, roleId!));
  }
  const id = roleId!;
  const serverNames = [...new Set([...after.toolGrants, ...after.serverGrants, ...before.toolGrants, ...before.serverGrants].map((g) => g.server))];
  const agentNames = [...new Set([...after.agentGrants, ...before.agentGrants].map((g) => g.agent))];
  const connectorNames = [...new Set([...after.connectorGrants, ...before.connectorGrants].map((g) => g.connector))];
  // one query at a time: this runs on the apply transaction's single connection
  const none = new Map<string, string>();
  const serverIds = serverNames.length ? await idsByName(tx.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(inArray(mcpServers.name, serverNames))) : none;
  const agentIds = agentNames.length ? await idsByName(tx.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.name, agentNames))) : none;
  const connectorIds = connectorNames.length
    ? await idsByName(tx.select({ id: connectors.id, name: connectors.name }).from(connectors).where(inArray(connectors.name, connectorNames)))
    : none;
  const key = <T>(xs: T[], k: (v: T) => string) => new Map(xs.map((x) => [k(x), x]));

  // tool grants: add or remove (a tool grant has no values)
  const tk = (g: { server: string; tool: string }) => `${g.server}\u0000${g.tool}`;
  const bt = key(before.toolGrants, tk);
  const at = key(after.toolGrants, tk);
  for (const [k, g] of bt) {
    if (!at.has(k)) await tx.delete(roleToolGrants).where(and(eq(roleToolGrants.roleId, id), eq(roleToolGrants.serverId, serverIds.get(g.server)!), eq(roleToolGrants.toolName, g.tool)));
  }
  for (const [k, g] of at) {
    if (bt.has(k)) continue;
    const serverId = serverIds.get(g.server)!;
    await sodOrRefuse(ctx, c, { kind: "role_tool", roleId: id, serverId, toolName: g.tool });
    await tx.insert(roleToolGrants).values({ roleId: id, serverId, toolName: g.tool });
  }

  // server grants
  const bs = key(before.serverGrants, (g) => g.server);
  const as = key(after.serverGrants, (g) => g.server);
  for (const [k] of bs) if (!as.has(k)) await tx.delete(roleServerGrants).where(and(eq(roleServerGrants.roleId, id), eq(roleServerGrants.serverId, serverIds.get(k)!)));
  for (const [k, g] of as) {
    const serverId = serverIds.get(k)!;
    const was = bs.get(k);
    if (was && was.readOnlyAll === g.readOnlyAll) continue;
    if (g.readOnlyAll && !was?.readOnlyAll) await sodOrRefuse(ctx, c, { kind: "role_server", roleId: id, serverId });
    if (was) await tx.update(roleServerGrants).set({ readOnlyAll: g.readOnlyAll }).where(and(eq(roleServerGrants.roleId, id), eq(roleServerGrants.serverId, serverId)));
    else await tx.insert(roleServerGrants).values({ roleId: id, serverId, readOnlyAll: g.readOnlyAll });
  }

  // agent grants
  const ba = key(before.agentGrants, (g) => g.agent);
  const aa = key(after.agentGrants, (g) => g.agent);
  for (const [k] of ba) if (!aa.has(k)) await tx.delete(roleAgentGrants).where(and(eq(roleAgentGrants.roleId, id), eq(roleAgentGrants.agentId, agentIds.get(k)!)));
  for (const [k, g] of aa) {
    const agentId = agentIds.get(k)!;
    const was = ba.get(k);
    if (was && canonicalJson(was) === canonicalJson(g)) continue;
    if (!was) {
      await sodOrRefuse(ctx, c, { kind: "role_agent", roleId: id, agentId });
      await tx.insert(roleAgentGrants).values({ roleId: id, agentId, allowedModes: g.allowedModes });
    } else {
      await tx.update(roleAgentGrants).set({ allowedModes: g.allowedModes }).where(and(eq(roleAgentGrants.roleId, id), eq(roleAgentGrants.agentId, agentId)));
    }
  }

  // connector grants
  const bc = key(before.connectorGrants, (g) => g.connector);
  const ac = key(after.connectorGrants, (g) => g.connector);
  for (const [k] of bc) if (!ac.has(k)) await tx.delete(roleConnectorGrants).where(and(eq(roleConnectorGrants.roleId, id), eq(roleConnectorGrants.connectorId, connectorIds.get(k)!)));
  for (const [k, g] of ac) {
    const connectorId = connectorIds.get(k)!;
    const was = bc.get(k);
    if (was && canonicalJson(was) === canonicalJson(g)) continue;
    // a new grant, or read → readwrite, confers a capability the SoD rules may forbid
    if (!was || (was.mode === "read" && g.mode === "readwrite")) await sodOrRefuse(ctx, c, { kind: "role_connector", roleId: id, connectorId, mode: g.mode });
    if (was) {
      await tx
        .update(roleConnectorGrants)
        .set({ mode: g.mode, allowedObjects: g.allowedObjects })
        .where(and(eq(roleConnectorGrants.roleId, id), eq(roleConnectorGrants.connectorId, connectorId)));
    } else {
      await tx.insert(roleConnectorGrants).values({ roleId: id, connectorId, mode: g.mode, allowedObjects: g.allowedObjects });
    }
  }
}

async function deleteRole(ctx: Ctx, c: GovernanceChange) {
  const { tx } = ctx;
  const roleId = ctx.index.roleIds.get(c.key)!;
  await lockApproverRoles(tx, [roleId]);
  // a held role, or one whose deletion moves who approves (ADR-0229), is not a file decision: the plan reports both
  // as issues, and the re-plan above refuses them; this is the check under the lock
  const held = await tx.select({ userId: roleAssignments.userId }).from(roleAssignments).where(eq(roleAssignments.roleId, roleId)).limit(1);
  if (held.length) throw new ApplyRefusal(409, "changed_concurrently", `role ${c.key} gained a holder after the plan; plan again`);
  if (await approverPoolShiftFacts(tx, { change: "delete", objectType: "role", objectId: roleId })) {
    throw new ApplyRefusal(409, "changed_concurrently", `deleting role ${c.key} now moves who approves calls; plan again`);
  }
  await tx.delete(roles).where(eq(roles.id, roleId));
}

async function writeRateLimit(ctx: Ctx, c: GovernanceChange) {
  const { tx } = ctx;
  const used = ((ctx as Ctx & { usedLimits?: Set<string> }).usedLimits ??= new Set<string>());
  const pick = (before: NormalRateLimit) => {
    const row = ctx.index.rateLimitRows.find((r) => !used.has(r.id) && canonicalJson(r.limit) === canonicalJson(before));
    if (!row) throw new ApplyRefusal(409, "changed_concurrently", `rate limit ${c.key} is not as planned; plan again`);
    used.add(row.id);
    return row.id;
  };
  if (c.op === "create") {
    const l = c.after as NormalRateLimit;
    const roleId = l.scope === "role" ? ctx.roleIds.get(l.subject!) : null;
    const teamId = l.scope === "team" ? (await tx.select({ id: teams.id }).from(teams).where(eq(teams.name, l.subject!)))[0]?.id : null;
    const serverId = l.server !== null ? (await tx.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, l.server)))[0]?.id : null;
    if ((l.scope === "role" && !roleId) || (l.scope === "team" && !teamId) || (l.server !== null && !serverId)) {
      throw new ApplyRefusal(409, "changed_concurrently", `a name rate limit ${c.key} needs no longer resolves; plan again`);
    }
    await tx.insert(rateLimits).values({
      scope: l.scope,
      serverScope: l.server !== null ? "server" : "all",
      roleId: roleId ?? null,
      teamId: teamId ?? null,
      serverId: serverId ?? null,
      toolName: l.tool,
      deployMode: l.deployMode,
      maxCalls: l.maxCalls,
      windowSeconds: l.windowSeconds,
      writeOnly: l.writeOnly,
    });
    return;
  }
  const id = pick(c.before as NormalRateLimit);
  if (c.op === "delete") {
    const res = await deleteRuleArtifact(tx, { artifactType: "rate_limit", artifactId: id, actorUserId: ctx.actor, routeLabel: APPLY_ROUTE, stepUp: looseningGuard(c) });
    if (!res.ok) throw new ApplyRefusal(409, "changed_concurrently", `rate limit ${c.key}: ${res.detail}`);
    return;
  }
  const a = c.after as NormalRateLimit;
  const res = await applyRuleEdit(tx, {
    artifactType: "rate_limit",
    artifactId: id,
    patch: { maxCalls: a.maxCalls, windowSeconds: a.windowSeconds },
    actorUserId: ctx.actor,
    label: `applied via ${APPLY_ROUTE}`,
    auditObjectType: "restriction_rule",
    auditRuleId: "rule-crud-edited",
    auditDetail: { phase: "governance-config-apply", planHash: ctx.plan.planHash, key: c.key },
    stepUp: looseningGuard(c),
  });
  if (isRuleEditRefusal(res)) throw new ApplyRefusal(res.status, res.error, `rate limit ${c.key}: ${res.detail}`);
}

async function writeBudget(ctx: Ctx, c: GovernanceChange) {
  const name = (c.after ?? c.before) as NormalBudget;
  const [p] = await ctx.tx.select({ id: projects.id }).from(projects).where(eq(projects.name, name.project));
  if (!p) throw new ApplyRefusal(409, "changed_concurrently", `project ${name.project} no longer exists; plan again`);
  const a = c.after as NormalBudget | null;
  const patch =
    a === null
      ? { budgetUsd: null }
      : { budgetUsd: a.budgetUsd, budgetPeriod: a.period, alertThresholdPct: a.alertThresholdPct, budgetApproverUserId: a.approverUserId };
  const res = await applyProjectPatch(ctx.tx, {
    projectId: p.id,
    patch,
    actorUserId: ctx.actor,
    auditDetail: { via: APPLY_ROUTE, planHash: ctx.plan.planHash },
  });
  if (!res.ok) throw new ApplyRefusal(res.status, res.error, `budget ${name.project}: ${res.detail}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------------------------

const applyBodySchema = z
  .object({
    content: z.string().min(1).optional(),
    document: z.unknown().optional(),
    /** the planHash of the dry run the caller reviewed */
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .refine((b) => (b.content === undefined) !== (b.document === undefined), { message: "send exactly one of content or document" });

export function registerGovernanceConfigApplyRoute(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? null;
  const deny = (req: FastifyRequest, error: string, reason: string, detail: Record<string, unknown> = {}) =>
    db.insert(auditLog).values({
      userId: actor(req) ?? NIL_USER,
      objectType: "governance_config",
      objectId: null,
      detail: { phase: "apply-refused", error, ...detail },
      effect: "deny",
      ruleId: "governance_config.apply",
      ruleChain: [],
      reason,
    });

  app.post(APPLY_ROUTE.slice(5), { bodyLimit: GOVERNANCE_CONFIG_LIMITS.documentBytes + 64 * 1024 }, async (req, reply) => {
    const body = applyBodySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_body", issues: body.error.issues });
    const content = body.data.content ?? JSON.stringify(body.data.document);

    // 1. the dry run again
    let pre: Awaited<ReturnType<typeof planGovernanceDocument>>;
    try {
      pre = await planGovernanceDocument(db, content);
    } catch (e) {
      if (!(e instanceof GovernanceDocumentError)) throw e;
      await deny(req, e.code, e.message);
      return reply.status(e.code === "too_large" ? 413 : 400).send({ error: e.code, message: e.message, issues: e.issues });
    }
    const { plan } = pre;
    if (pre.issues.length) {
      await deny(req, "plan_has_issues", "the plan has unresolved issues", { planHash: plan.planHash, issues: pre.issues.length });
      return reply.status(422).send({ error: "plan_has_issues", issues: pre.issues satisfies PlanIssue[] });
    }
    if (plan.planHash !== body.data.planHash) {
      await deny(req, "plan_stale", "the planHash sent is not this document's plan against the live configuration", { sent: body.data.planHash, planHash: plan.planHash });
      return reply.status(409).send({
        error: "plan_stale",
        detail: "the planHash sent is not this document's plan against the live configuration now; plan again and review the new diff",
        planHash: plan.planHash,
      });
    }
    const notYet = plan.changes.filter((c) => !(APPLIABLE_SECTIONS as readonly string[]).includes(c.section));
    if (notYet.length) {
      const sections = [...new Set(notYet.map((c) => c.section))];
      await deny(req, "section_not_appliable", `apply does not write ${sections.join(", ")} yet`, { sections });
      return reply.status(422).send({
        error: "section_not_appliable",
        detail: `apply writes ${APPLIABLE_SECTIONS.join(", ")} today; this plan also changes ${sections.join(", ")} (change those through their own screens, or leave the section out of the file)`,
        sections,
      });
    }
    if (plan.changes.length === 0) return reply.send({ applied: false, planHash: plan.planHash, summary: plan.summary, detail: "nothing to change" });

    // 2. the relaxation path the UI uses, bound to this plan and its widenings
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: applyStepUpFacts(plan) })).ok) return reply;

    // 3. all or nothing, under the lock, re-planned
    try {
      const applied = await db.transaction(async (tx) => applyLocked(tx as unknown as Db, content, body.data.planHash, actor(req)));
      return reply.send({ applied: true, planHash: applied.planHash, summary: applied.summary, changes: applied.changes.map((c) => ({ section: c.section, key: c.key, op: c.op, effect: c.effect })) });
    } catch (e) {
      if (!(e instanceof ApplyRefusal)) throw e;
      await deny(req, e.error, e.detail, { planHash: body.data.planHash, ...e.extra });
      return reply.status(e.status).send({ error: e.error, detail: e.detail, ...e.extra });
    }
  });
}
