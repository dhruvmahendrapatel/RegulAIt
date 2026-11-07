/**
 * ADR-0246 addendum (owner, 2026-11-07) — OFFENSIVE MCP TOOL SERVERS AS HIGH-RISK: the database and request half.
 *
 * RegulAIt never ships offensive-security tooling; it governs it when a customer runs it. This module owns:
 *
 *   1. `recordRiskClassification` — run in `syncUpstreamTools`' transaction over the WHOLE served manifest (blocked
 *      tools included): a server whose tools match our offensive rule set becomes `risk_class = 'high'`, sticky,
 *      audited `mcp-server-high-risk`.
 *   2. `highRiskRefusal` — THE GATE, under `mcp_high_risk_mode = 'enforce'` (the default), on every governed call to
 *      a high-risk server, before the kernel decision and any connect:
 *        - default deny until the POLICY TEMPLATE is applied: a fleet approval rule on the server with quorum >= 2
 *          (the requester is never in the approver pool: ADR-0186 A) and a rate limit on the server, both enforced
 *          by the kernel like any other rule;
 *        - TARGET SCOPING: the call must name its target(s), and every one must be on the admin-maintained
 *          authorised-targets list;
 *        - FULL AUDIT: every call, refused or let through to the kernel, writes a row with its arguments, redacted.
 *   3. The admin API: the server's classification and template, applying the template, and the targets list.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  approvalRules,
  asc,
  auditLog,
  eq,
  gte,
  isNull,
  mcpAuthorisedTargets,
  mcpServers,
  rateLimits,
  type Db,
} from "@regulait/db";
import {
  applyHighRiskPolicySchema,
  checkTargets,
  classifyOffensiveTools,
  createApprovalRuleSchema,
  createAuthorisedTargetSchema,
  extractTargets,
  normaliseAuthorisedTarget,
  redactArgumentsForAudit,
  type AuthorisedTarget,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { createApprovalRuleRow } from "./rule-creates.js";
import { requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export const MCP_HIGH_RISK_RULE_IDS = {
  classified: "mcp-server-high-risk",
  noPolicy: "mcp-high-risk-no-policy",
  targetRequired: "mcp-high-risk-target-required",
  targetRefused: "mcp-high-risk-target-refused",
  call: "mcp-high-risk-call",
  policyApplied: "mcp-high-risk-policy-applied",
  targetAdded: "mcp-authorised-target-added",
  targetRemoved: "mcp-authorised-target-removed",
} as const;

/** The minimum quorum the template sets and the gate requires. */
export const HIGH_RISK_MIN_QUORUM = 2;

/** Classify the served manifest; a server that matches becomes high-risk (never lowered automatically). */
export async function recordRiskClassification(tx: Db, serverId: string, tools: readonly unknown[], trigger: "sync" | "rescan"): Promise<boolean> {
  const verdict = classifyOffensiveTools(tools);
  if (!verdict.highRisk) return false;
  const [server] = await tx
    .select({ name: mcpServers.name, riskClass: mcpServers.riskClass })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  if (!server || server.riskClass === "high") return true;
  await tx
    .update(mcpServers)
    .set({ riskClass: "high", riskClassifiedAt: new Date(), riskFindings: verdict })
    .where(eq(mcpServers.id, serverId));
  await tx.insert(auditLog).values({
    userId: NIL_USER,
    serverId,
    objectType: "mcp_server",
    objectId: serverId,
    detail: { phase: "risk-classification", trigger, ...verdict },
    effect: "allow",
    ruleId: MCP_HIGH_RISK_RULE_IDS.classified,
    ruleChain: [],
    reason:
      `MCP server '${server.name}' classified HIGH-RISK (offensive tooling: ${verdict.categories.join(", ")}). ` +
      `Every call now needs the high-risk policy template and an authorised target.`,
  });
  return true;
}

/** Is the template in force on this server: a fleet approval rule (quorum >= 2, every tool) and a rate limit? */
export async function highRiskPolicyApplied(db: Db, serverId: string): Promise<{ approvalRuleId: string | null; rateLimitId: string | null }> {
  const [rule] = await db
    .select({ id: approvalRules.id })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.serverId, serverId),
        eq(approvalRules.serverScope, "server"),
        eq(approvalRules.scope, "fleet"),
        isNull(approvalRules.toolName),
        eq(approvalRules.writeOnly, false),
        gte(approvalRules.quorum, HIGH_RISK_MIN_QUORUM),
      ),
    )
    .limit(1);
  const [limit] = await db
    .select({ id: rateLimits.id })
    .from(rateLimits)
    .where(and(eq(rateLimits.serverId, serverId), eq(rateLimits.serverScope, "server"), eq(rateLimits.scope, "fleet"), isNull(rateLimits.toolName)))
    .limit(1);
  return { approvalRuleId: rule?.id ?? null, rateLimitId: limit?.id ?? null };
}

async function authorisedTargets(db: Db): Promise<AuthorisedTarget[]> {
  return (await db.select({ kind: mcpAuthorisedTargets.kind, value: mcpAuthorisedTargets.value }).from(mcpAuthorisedTargets)) as AuthorisedTarget[];
}

export interface HighRiskRefusal {
  ruleId: string;
  reason: string;
}

/**
 * THE GATE. Null = not high-risk, the mode is off, or the call passes on to the kernel (which then applies the
 * template's approval and rate limit). Every call to a high-risk server under 'enforce' writes one audit row with
 * its arguments, redacted: a deny when refused here, or `mcp-high-risk-call` when passed on.
 */
export async function highRiskRefusal(
  db: Db,
  call: { userId: string; serverId: string; toolName: string; arguments: Record<string, unknown> | undefined; projectId: string | null },
): Promise<HighRiskRefusal | null> {
  const [server] = await db
    .select({ name: mcpServers.name, riskClass: mcpServers.riskClass })
    .from(mcpServers)
    .where(eq(mcpServers.id, call.serverId));
  if (!server || server.riskClass !== "high") return null;
  if ((await loadOrgSettings(db)).mcpHighRiskMode !== "enforce") return null;

  const redacted = redactArgumentsForAudit(call.arguments ?? {});
  const targets = extractTargets(call.arguments);
  let refusal: HighRiskRefusal | null = null;
  let refused: string[] = [];
  const policy = await highRiskPolicyApplied(db, call.serverId);
  if (!policy.approvalRuleId || !policy.rateLimitId) {
    refusal = {
      ruleId: MCP_HIGH_RISK_RULE_IDS.noPolicy,
      reason:
        `MCP server '${server.name}' is high-risk (offensive tooling) and its policy template is not applied ` +
        `(an approval rule with quorum >= ${HIGH_RISK_MIN_QUORUM} and a rate limit); every call is refused until it is`,
    };
  } else if (targets.length === 0) {
    refusal = {
      ruleId: MCP_HIGH_RISK_RULE_IDS.targetRequired,
      reason: `a call to high-risk MCP server '${server.name}' must name its target (e.g. a 'target', 'host' or 'url' argument)`,
    };
  } else {
    refused = checkTargets(targets, await authorisedTargets(db)).refused;
    if (refused.length > 0) {
      refusal = {
        ruleId: MCP_HIGH_RISK_RULE_IDS.targetRefused,
        reason: `${refused.length} target(s) of this call to high-risk MCP server '${server.name}' are not on the authorised-targets list`,
      };
    }
  }
  await db.insert(auditLog).values({
    userId: call.userId,
    serverId: call.serverId,
    toolName: call.toolName,
    detail: {
      phase: "high-risk",
      projectId: call.projectId,
      // a refusal here is the call's decision; a pass-on is a record of the arguments, and the kernel's row decides
      ...(refusal ? { receiptClass: "decision" as const } : { receiptClass: "excluded" as const }),
      arguments: redacted,
      targets: targets.map((t) => redactArgumentsForAudit(t)),
      refusedTargets: refused.map((t) => redactArgumentsForAudit(t)),
    },
    effect: refusal ? "deny" : "allow",
    ruleId: refusal?.ruleId ?? MCP_HIGH_RISK_RULE_IDS.call,
    ruleChain: [],
    reason: refusal?.reason ?? `call to high-risk MCP server '${server.name}': targets authorised; passed to the policy decision (approval and rate limit)`,
  });
  return refusal;
}

// ---------------------------------------------------------------------------
// The admin API (admin-only through the default gate)
// ---------------------------------------------------------------------------

const serverParam = z.object({ serverId: z.string().uuid() }).strict();
const idParam = z.object({ id: z.string().uuid() }).strict();

export function registerMcpHighRiskRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/servers/:serverId/high-risk-policy", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const [server] = await db
      .select({ name: mcpServers.name, riskClass: mcpServers.riskClass, riskClassifiedAt: mcpServers.riskClassifiedAt, riskFindings: mcpServers.riskFindings })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    const policy = await highRiskPolicyApplied(db, serverId);
    const mode = (await loadOrgSettings(db)).mcpHighRiskMode;
    return { serverId, ...server, mode, policyApplied: !!(policy.approvalRuleId && policy.rateLimitId), ...policy };
  });

  /**
   * THE POLICY TEMPLATE: one fleet approval rule on every tool of the server (quorum >= 2, bound to the exact
   * arguments; the approver pool never includes the requester and must be able to reach the quorum, ADR-0186 A) and
   * one fleet rate limit, written with their audit row in one transaction. Applying it tightens, so no step-up.
   */
  app.post("/v1/servers/:serverId/high-risk-policy", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const body = applyHighRiskPolicySchema.parse(req.body ?? {});
    const [server] = await db.select({ name: mcpServers.name, riskClass: mcpServers.riskClass }).from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    const rule = createApprovalRuleSchema.parse({
      scope: "fleet",
      serverScope: "server",
      serverId,
      toolName: null,
      approvalScope: "action",
      approverUserId: body.approverUserId,
      approverRoleId: body.approverRoleId ?? null,
      quorum: body.quorum,
    });
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const approval = await createApprovalRuleRow(tx, rule);
      const [limit] = await tx
        .insert(rateLimits)
        .values({ scope: "fleet", serverScope: "server", serverId, toolName: null, maxCalls: body.maxCalls, windowSeconds: body.windowSeconds })
        .returning();
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        serverId,
        objectType: "mcp_server",
        objectId: serverId,
        detail: { phase: "high-risk-policy", via: req.authCtx.via, approvalRuleId: approval.id, rateLimitId: limit!.id, quorum: body.quorum, maxCalls: body.maxCalls, windowSeconds: body.windowSeconds },
        effect: "allow",
        ruleId: MCP_HIGH_RISK_RULE_IDS.policyApplied,
        ruleChain: [],
        reason:
          `high-risk policy template applied to MCP server '${server.name}': every call needs ${body.quorum} approvals ` +
          `(requester excluded), at most ${body.maxCalls} calls per ${body.windowSeconds}s, and an authorised target`,
      });
      return { approvalRule: approval, rateLimit: limit };
    });
    return reply.status(201).send({ serverId, riskClass: server.riskClass, ...out });
  });

  app.get("/v1/mcp/authorised-targets", async () => {
    const rows = await db.select().from(mcpAuthorisedTargets).orderBy(asc(mcpAuthorisedTargets.kind), asc(mcpAuthorisedTargets.value)).limit(1000);
    return { targets: rows };
  });

  /** Adding a target widens what a high-risk server may be pointed at: a settings_relax step-up bound to it. */
  app.post("/v1/mcp/authorised-targets", async (req, reply) => {
    const body = createAuthorisedTargetSchema.parse(req.body);
    const target = normaliseAuthorisedTarget(body.kind, body.value);
    if (!target) return reply.status(400).send({ error: "invalid_target", detail: `not a valid ${body.kind}. Nothing was added.` });
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { values: { mcpAuthorisedTarget: [target.kind, target.value] } } });
    if (!su.ok) return reply;
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [inserted] = await tx
        .insert(mcpAuthorisedTargets)
        .values({ kind: target.kind, value: target.value, note: body.note, createdBy: req.authCtx.userId ?? null })
        .onConflictDoNothing()
        .returning();
      if (!inserted) return null;
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        detail: { receiptClass: "configuration", phase: "authorised-targets", via: req.authCtx.via, targetId: inserted.id, kind: target.kind, value: target.value, note: body.note },
        effect: "allow",
        ruleId: MCP_HIGH_RISK_RULE_IDS.targetAdded,
        ruleChain: [],
        reason: `authorised target added for high-risk MCP servers: ${target.kind} ${target.value}`,
      });
      return inserted;
    });
    if (!row) return reply.status(409).send({ error: "target_exists" });
    return reply.status(201).send(row);
  });

  /** Removing a target narrows: no step-up, audited. */
  app.delete("/v1/mcp/authorised-targets/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const removed = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx.delete(mcpAuthorisedTargets).where(eq(mcpAuthorisedTargets.id, id)).returning();
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        detail: { receiptClass: "configuration", phase: "authorised-targets", via: req.authCtx.via, targetId: id, kind: row.kind, value: row.value },
        effect: "allow",
        ruleId: MCP_HIGH_RISK_RULE_IDS.targetRemoved,
        ruleChain: [],
        reason: `authorised target removed: ${row.kind} ${row.value}`,
      });
      return row;
    });
    if (!removed) return reply.status(404).send({ error: "unknown_target" });
    return reply.status(204).send();
  });
}
