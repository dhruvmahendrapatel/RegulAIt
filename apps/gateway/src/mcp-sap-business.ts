/**
 * ADR-0230 slice A2 (gateway part) — SAP BUSINESS MCP SERVERS: every SAP write is approve-first.
 *
 * The SAP business tools live in the ABAP MCP server (ADR-0230 §1); the gateway decides who may call them. This module
 * owns the gateway's part of §5:
 *
 *   1. MARKING. `POST /v1/servers/:serverId/system-class` marks a server `sap_business` and, in the same transaction
 *      and audited, seeds the strict defaults as ordinary rows the admin can see and change:
 *        - a fleet approval rule on the server's WRITE tools (every tool under `sapReadsApproveFirst`): the org's quorum
 *          (`sapApprovalQuorum`, default 2, never below 1), bound to the exact arguments, approvers the
 *          marking admin plus a role the admin must name (the requester is never in the pool, ADR-0186 A);
 *        - a fleet rate limit on the server's WRITE tools: `sapWriteRatePerHour` calls per user per hour (default 10) (`rate_limits.write_only`, so one
 *          row covers write tools discovered later and never counts reads).
 *      Marking tightens, so it needs no step-up. Relaxing a seeded row goes through the ordinary rule paths, which
 *      already need the settings_relax step-up (rule-loosening.ts, DELETE /v1/rules). The tools stay unassigned: no
 *      person can call one until an admin grants it (the existing default-deny).
 *   2. UNMARKING (`DELETE`) drops the project requirement below: a settings_relax step-up bound to the server, audited.
 *      The seeded rows stay; they are ordinary rules.
 *   3. THE PROJECT REQUIREMENT (`sapWriteRefusal`, called by the proxy after the entitlement decision): a write to an SAP
 *      business server must be attributed to a live project with a budget. Unattributed, unknown, archived or
 *      unbudgeted is refused (`sap-write-needs-project`); unattributed runs only under `sapUnattributedWritesAllowed`
 *      (owner decision 2026-11-15, a stepped-up relaxation), audited, and not costed. The existing project budget gate
 *      then applies to the attributed call as to any other.
 *
 * On an SAP business server every tool is a write (the proxy ignores the upstream's `readOnlyHint`, review #798), so
 * the rule, the limit and the requirement below cannot be skipped by a manifest that calls a posting tool read-only.
 *
 * Out of this slice (ADR-0230 A2, blocked on slice A0): identity release, subject-token retention and the
 * confirm-by-fresh-step-up execution state.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, approvalRules, auditLog, eq, inArray, mcpServers, mcpTools, projects, rateLimits, sql, type Db } from "@regulait/db";
import { createApprovalRuleSchema } from "@regulait/shared";
import { seedServerPolicyTemplate, type ServerPolicyTemplateMatch } from "./rule-creates.js";
import { loadOrgSettings } from "./org-settings.js";
import { requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export const SAP_BUSINESS_RULE_IDS = {
  marked: "mcp-server-sap-business",
  unmarked: "mcp-server-sap-business-unmarked",
  needsProject: "sap-write-needs-project",
} as const;

/**
 * ADR-0230 §5's shipped defaults (owner decision 2026-11-15: kept as the defaults, each one an org setting). They are
 * the column defaults of `org_settings.sap_*`; `sapBusinessSettings` reads what the org has set.
 */
export const SAP_BUSINESS_DEFAULTS = {
  quorum: 2,
  maxCalls: 10,
  windowSeconds: 3600,
  unattributedWritesAllowed: false,
  readsApproveFirst: false,
} as const;

export interface SapBusinessSettings {
  /** the approval quorum a mark seeds: at least 1 (CHECK), and the requester never counts towards it */
  quorum: number;
  /** SAP writes per user per `windowSeconds` on the seeded write-only limit */
  maxCalls: number;
  windowSeconds: number;
  /** true = an SAP write with no project runs unattributed (a relaxation); a named project must still be live and budgeted */
  unattributedWritesAllowed: boolean;
  /** true = the seeded approval rule covers every tool on the server, not only writes (a tightening) */
  readsApproveFirst: boolean;
}

/** The org's SAP business settings (owner decision 2026-11-15), relaxed only through the stepped-up settings PUT. */
export async function sapBusinessSettings(db: Db): Promise<SapBusinessSettings> {
  const org = await loadOrgSettings(db);
  return {
    // belt and braces: the CHECK already holds it at 1 or more
    quorum: Math.max(1, org.sapApprovalQuorum),
    maxCalls: org.sapWriteRatePerHour,
    windowSeconds: SAP_BUSINESS_DEFAULTS.windowSeconds,
    unattributedWritesAllowed: org.sapUnattributedWritesAllowed,
    readsApproveFirst: org.sapReadsApproveFirst,
  };
}

export interface SapWriteRefusal {
  ruleId: string;
  reason: string;
}

/**
 * THE PROJECT REQUIREMENT. Null = not an SAP business server, a read tool, or a write attributed to a live budgeted
 * project (the call goes on to the kernel and the budget gate). A refusal writes its own audit row and is never costed.
 */
export async function sapWriteRefusal(
  db: Db,
  call: {
    userId: string;
    serverId: string;
    serverName: string;
    systemClass: string | null;
    toolName: string;
    toolKind: "read" | "write";
    projectId: string | null;
  },
): Promise<SapWriteRefusal | null> {
  if (call.systemClass !== "sap_business" || call.toolKind !== "write") return null;
  let why: string | null = null;
  if (!call.projectId) {
    // owner decision 2026-11-15: an org may allow unattributed SAP writes (a stepped-up, audited relaxation)
    if ((await sapBusinessSettings(db)).unattributedWritesAllowed) return null;
    why = "it is not attributed to a project";
  } else {
    const [project] = await db
      .select({ budgetUsd: projects.budgetUsd, archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, call.projectId));
    if (!project) why = "its project does not exist";
    else if (project.archivedAt) why = "its project is archived";
    else if (project.budgetUsd == null) why = "its project has no budget";
  }
  if (!why) return null;
  const refusal: SapWriteRefusal = {
    ruleId: SAP_BUSINESS_RULE_IDS.needsProject,
    reason: `write tool '${call.toolName}' on SAP business server '${call.serverName}' refused: ${why}; an SAP write must be attributed to a project with an active budget`,
  };
  await db.insert(auditLog).values({
    userId: call.userId,
    serverId: call.serverId,
    toolName: call.toolName,
    detail: { phase: "sap-business", toolKind: call.toolKind, projectId: call.projectId, receiptClass: "decision" },
    effect: "deny",
    ruleId: refusal.ruleId,
    ruleChain: [],
    reason: refusal.reason,
  });
  return refusal;
}

/**
 * The rows the marks of this server SEEDED and that still exist (code review #798): read from the marks' own audit
 * rows, so a rule or limit an admin created by hand on the same server (a high-risk template rule, say) is never
 * reported as a seeded default.
 */
async function seededDefaults(db: Db, serverId: string): Promise<{ approvalRuleIds: string[]; rateLimitIds: string[] }> {
  const marks = await db
    .select({ ruleId: sql<string | null>`${auditLog.detail}->>'approvalRuleId'`, limitId: sql<string | null>`${auditLog.detail}->>'rateLimitId'` })
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, SAP_BUSINESS_RULE_IDS.marked), eq(auditLog.serverId, serverId)))
    .limit(100);
  const ruleIds = [...new Set(marks.map((m) => m.ruleId).filter((x): x is string => !!x))];
  const limitIds = [...new Set(marks.map((m) => m.limitId).filter((x): x is string => !!x))];
  const rules = ruleIds.length ? await db.select({ id: approvalRules.id }).from(approvalRules).where(inArray(approvalRules.id, ruleIds)) : [];
  const limits = limitIds.length ? await db.select({ id: rateLimits.id }).from(rateLimits).where(inArray(rateLimits.id, limitIds)) : [];
  return { approvalRuleIds: rules.map((r) => r.id), rateLimitIds: limits.map((l) => l.id) };
}

/**
 * What a re-mark may reuse (review #798): rows at least as strict as the org's current settings, not scoped to a
 * deploy mode, and (for the rule) naming the approver pool this request names. Anything else is not reused, so a new
 * seeded row applies beside it (strictest wins). The shared template finder (rule-creates.ts) does the matching.
 */
function sapTemplateMatch(
  serverId: string,
  approvers: { approverUserId: string; approverRoleId: string },
  settings: SapBusinessSettings,
): ServerPolicyTemplateMatch {
  return {
    serverId,
    // a rule covering every tool is at least as strict as a write-only one; under readsApproveFirst only it is
    ruleCovers: settings.readsApproveFirst ? "all" : "writes",
    minQuorum: settings.quorum,
    actionScoped: true,
    approvers,
    limitCovers: "writes",
    maxCalls: settings.maxCalls,
    minWindowSeconds: settings.windowSeconds,
  };
}

const serverParam = z.object({ serverId: z.string().uuid() }).strict();
export const markSapBusinessSchema = z
  .object({
    systemClass: z.literal("sap_business"),
    /** the approver role the marking admin must name (ADR-0230 §5.1); the admin is the named approver */
    approverRoleId: z.string().uuid(),
  })
  .strict();

class AlreadyMarked extends Error {}

export function registerMcpSapBusinessRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/servers/:serverId/system-class", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const [server] = await db.select({ name: mcpServers.name, systemClass: mcpServers.systemClass }).from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    return { serverId, name: server.name, systemClass: server.systemClass, ...(await seededDefaults(db, serverId)) };
  });

  /** Mark a server SAP business and seed the defaults, in one transaction with its audit row. Tightens: no step-up. */
  app.post("/v1/servers/:serverId/system-class", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const body = markSapBusinessSchema.parse(req.body);
    const adminId = req.authCtx.userId;
    if (!adminId) {
      return reply.status(400).send({ error: "approver_required", detail: "marking a server SAP business names the marking admin as an approver; sign in as a person. Nothing was changed." });
    }
    // owner decision 2026-11-15: the seeded values are the org's settings (defaults: quorum 2, 10 writes an hour)
    const settings = await sapBusinessSettings(db);
    const rule = createApprovalRuleSchema.parse({
      scope: "fleet",
      serverScope: "server",
      serverId,
      toolName: null,
      writeOnly: !settings.readsApproveFirst,
      approvalScope: "action",
      approverUserId: adminId,
      approverRoleId: body.approverRoleId,
      quorum: settings.quorum,
    });
    try {
      const out = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        // the server row's lock serialises two concurrent marks: the second sees the first's class and stops
        const [server] = await tx
          .select({ name: mcpServers.name, systemClass: mcpServers.systemClass })
          .from(mcpServers)
          .where(eq(mcpServers.id, serverId))
          .for("update");
        if (!server) return null;
        if (server.systemClass === "sap_business") throw new AlreadyMarked(server.name);
        await tx.update(mcpServers).set({ systemClass: "sap_business" }).where(eq(mcpServers.id, serverId));
        // security review #798: every stored tool kind on the server becomes 'write' with the mark, in the same
        // transaction, so no reader of mcp_tools.kind sees an upstream-claimed read
        await tx.update(mcpTools).set({ kind: "write" }).where(eq(mcpTools.serverId, serverId));
        // review #798: a re-mark (mark, unmark, mark) reuses the rows the first mark seeded while they still hold the
        // settings, instead of seeding a second pair; one shared template seed with the ADR-0246 high-risk policy
        const seeded = await seedServerPolicyTemplate(
          tx,
          { rule, limit: { serverId, writeOnly: true, maxCalls: settings.maxCalls, windowSeconds: settings.windowSeconds } },
          sapTemplateMatch(serverId, { approverUserId: adminId, approverRoleId: body.approverRoleId }, settings),
        );
        const approval = seeded.approvalRule;
        const limit = seeded.rateLimit;
        const kept = { approvalRule: seeded.approvalRuleReused ? approval : null, rateLimit: seeded.rateLimitReused ? limit : null };
        await tx.insert(auditLog).values({
          userId: adminId,
          serverId,
          objectType: "mcp_server",
          objectId: serverId,
          detail: {
            receiptClass: "configuration",
            phase: "sap-business",
            via: req.authCtx.via,
            systemClass: "sap_business",
            approvalRuleId: approval.id,
            approvalRuleReused: kept.approvalRule !== null,
            rateLimitReused: kept.rateLimit !== null,
            // the approver pool of the rule actually in force (reused only when it matches this request)
            approverUserId: approval.approverUserId,
            approverRoleId: approval.approverRoleId,
            rateLimitId: limit.id,
            // the values of the rows in force (a reused row may be stricter than the settings)
            quorum: approval.quorum,
            writeOnly: approval.writeOnly,
            maxCalls: limit.maxCalls,
            windowSeconds: limit.windowSeconds,
            unattributedWritesAllowed: settings.unattributedWritesAllowed,
          },
          effect: "allow",
          ruleId: SAP_BUSINESS_RULE_IDS.marked,
          ruleChain: [],
          reason:
            `MCP server '${server.name}' marked SAP business: every ${approval.writeOnly ? "write " : ""}tool needs ${approval.quorum} approval(s) ` +
            `(requester excluded), at most ${limit.maxCalls} write calls per user per hour, and ` +
            (settings.unattributedWritesAllowed ? "a live, budgeted project when one is named" : "a budgeted project"),
        });
        return { approvalRule: approval, rateLimit: limit! };
      });
      if (!out) return reply.status(404).send({ error: "unknown_server" });
      return reply.status(201).send({ serverId, systemClass: "sap_business" as const, ...out });
    } catch (err) {
      if (err instanceof AlreadyMarked) {
        return reply.status(409).send({ error: "already_sap_business", detail: `MCP server '${err.message}' is already marked SAP business. Nothing was changed.` });
      }
      throw err;
    }
  });

  /** Unmarking drops the project requirement: a relaxation, so a settings_relax step-up bound to the server. */
  app.delete("/v1/servers/:serverId/system-class", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const [server] = await db.select({ name: mcpServers.name, systemClass: mcpServers.systemClass }).from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    if (server.systemClass === null) return reply.status(409).send({ error: "not_classified", detail: `MCP server '${server.name}' has no system class. Nothing was changed.` });
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { serverId, values: { mcpSystemClass: null } } });
    if (!su.ok) return reply;
    const changed = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx
        .update(mcpServers)
        .set({ systemClass: null })
        .where(and(eq(mcpServers.id, serverId), eq(mcpServers.systemClass, "sap_business")))
        .returning({ id: mcpServers.id });
      if (!row) return false;
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        serverId,
        objectType: "mcp_server",
        objectId: serverId,
        detail: { receiptClass: "configuration", phase: "sap-business", via: req.authCtx.via, systemClass: null, previous: "sap_business", stepUp: su.method },
        effect: "allow",
        ruleId: SAP_BUSINESS_RULE_IDS.unmarked,
        ruleChain: [],
        reason:
          `MCP server '${server.name}' is no longer marked SAP business: its writes no longer need a budgeted project. ` +
          `The seeded approval rule and rate limit stay until an admin changes them.`,
      });
      return true;
    });
    if (!changed) return reply.status(409).send({ error: "not_classified", detail: "the server's class changed meanwhile. Nothing was changed." });
    return reply.status(200).send({ serverId, systemClass: null });
  });
}
