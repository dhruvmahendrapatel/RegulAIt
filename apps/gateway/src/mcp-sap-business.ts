/**
 * ADR-0230 slice A2 (gateway part) — SAP BUSINESS MCP SERVERS: every SAP write is approve-first.
 *
 * The SAP business tools live in the ABAP MCP server (ADR-0230 §1); the gateway decides who may call them. This module
 * owns the gateway's part of §5:
 *
 *   1. MARKING. `POST /v1/servers/:serverId/system-class` marks a server `sap_business` and, in the same transaction
 *      and audited, seeds the strict defaults as ordinary rows the admin can see and change:
 *        - a fleet approval rule on the server's WRITE tools: quorum 2, bound to the exact arguments, approvers the
 *          marking admin plus a role the admin must name (the requester is never in the pool, ADR-0186 A);
 *        - a fleet rate limit on the server's WRITE tools: 10 calls per user per hour (`rate_limits.write_only`, so one
 *          row covers write tools discovered later and never counts reads).
 *      Marking tightens, so it needs no step-up. Relaxing a seeded row goes through the ordinary rule paths, which
 *      already need the settings_relax step-up (rule-loosening.ts, DELETE /v1/rules). The tools stay unassigned: no
 *      person can call one until an admin grants it (the existing default-deny).
 *   2. UNMARKING (`DELETE`) drops the project requirement below: a settings_relax step-up bound to the server, audited.
 *      The seeded rows stay; they are ordinary rules.
 *   3. THE PROJECT REQUIREMENT (`sapWriteRefusal`, called by the proxy before the kernel decision): a write to an SAP
 *      business server must be attributed to a live project with a budget. Unattributed, unknown, archived or
 *      unbudgeted is refused (`sap-write-needs-project`), audited, and not costed. The existing project budget gate
 *      then applies to the attributed call as to any other.
 *
 * Out of this slice (ADR-0230 A2, blocked on slice A0): identity release, subject-token retention and the
 * confirm-by-fresh-step-up execution state.
 */
import { createHmac, hkdfSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, approvalRules, auditLog, eq, gte, isNull, mcpServers, projects, rateLimits, sql, type Db } from "@regulait/db";
import { canonicalMcpAudience, createApprovalRuleSchema } from "@regulait/shared";
import { pairwiseSubject } from "./delegated-token.js";
import { identitySecretsFor } from "./oauth/common.js";
import { createApprovalRuleRow } from "./rule-creates.js";
import { requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export const SAP_BUSINESS_RULE_IDS = {
  marked: "mcp-server-sap-business",
  unmarked: "mcp-server-sap-business-unmarked",
  needsProject: "sap-write-needs-project",
  keyRequired: "sap-idempotency-key-required",
  keyUnavailable: "sap-idempotency-key-unavailable",
  keyReused: "sap-idempotency-key-reused",
  outcome: "sap-business-outcome",
} as const;

/** ADR-0230 §5's proposed defaults: secure, and ordinary rows an admin may relax (stepped up, audited). */
export const SAP_BUSINESS_DEFAULTS = {
  quorum: 2,
  maxCalls: 10,
  windowSeconds: 3600,
} as const;

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

/** The seeded rows still in force on a server: the write-only fleet approval rule and the write-only fleet rate limit. */
async function seededDefaults(db: Db, serverId: string): Promise<{ approvalRuleIds: string[]; rateLimitIds: string[] }> {
  const rules = await db
    .select({ id: approvalRules.id })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.serverId, serverId),
        eq(approvalRules.serverScope, "server"),
        eq(approvalRules.scope, "fleet"),
        isNull(approvalRules.toolName),
        eq(approvalRules.writeOnly, true),
      ),
    )
    .limit(100);
  const limits = await db
    .select({ id: rateLimits.id })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.serverId, serverId),
        eq(rateLimits.serverScope, "server"),
        eq(rateLimits.scope, "fleet"),
        isNull(rateLimits.toolName),
        eq(rateLimits.writeOnly, true),
      ),
    )
    .limit(100);
  return { approvalRuleIds: rules.map((r) => r.id), rateLimitIds: limits.map((l) => l.id) };
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
    const rule = createApprovalRuleSchema.parse({
      scope: "fleet",
      serverScope: "server",
      serverId,
      toolName: null,
      writeOnly: true,
      approvalScope: "action",
      approverUserId: adminId,
      approverRoleId: body.approverRoleId,
      quorum: SAP_BUSINESS_DEFAULTS.quorum,
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
        const approval = await createApprovalRuleRow(tx, rule);
        const [limit] = await tx
          .insert(rateLimits)
          .values({
            scope: "fleet",
            serverScope: "server",
            serverId,
            toolName: null,
            writeOnly: true,
            maxCalls: SAP_BUSINESS_DEFAULTS.maxCalls,
            windowSeconds: SAP_BUSINESS_DEFAULTS.windowSeconds,
          })
          .returning();
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
            approverRoleId: body.approverRoleId,
            rateLimitId: limit!.id,
            quorum: SAP_BUSINESS_DEFAULTS.quorum,
            maxCalls: SAP_BUSINESS_DEFAULTS.maxCalls,
            windowSeconds: SAP_BUSINESS_DEFAULTS.windowSeconds,
          },
          effect: "allow",
          ruleId: SAP_BUSINESS_RULE_IDS.marked,
          ruleChain: [],
          reason:
            `MCP server '${server.name}' marked SAP business: every write tool needs ${SAP_BUSINESS_DEFAULTS.quorum} approvals ` +
            `(requester excluded), at most ${SAP_BUSINESS_DEFAULTS.maxCalls} write calls per user per hour, and a budgeted project`,
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

// ---------------------------------------------------------------------------
// ADR-0230 A3 (with A2's HMAC key): the idempotency key, the approval binding, and the audit and usage detail
// ---------------------------------------------------------------------------

/** The argument an SAP business write carries its caller-chosen key in (ADR-0230 §2). */
export const SAP_IDEMPOTENCY_ARGUMENT = "idempotencyKey";
/** How far back the gateway looks for an earlier use of a key: the server store's default retention (§2). */
export const SAP_IDEMPOTENCY_RETENTION_DAYS = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The business object a known tool writes; a tool not listed here may name its own in its result (validated). */
const KNOWN_SAP_TOOLS: Readonly<Record<string, { service: string; entitySet: string }>> = {
  create_sales_order: { service: "API_SALES_ORDER_SRV", entitySet: "A_SalesOrder" },
};

const hkdfCache = new Map<string, Buffer>();
function sapKeyBase(dataKey: string): Buffer {
  let k = hkdfCache.get(dataKey);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", Buffer.from(dataKey, "utf8"), Buffer.alloc(0), "regulait/adr0230/sap-idempotency/v1", 32));
    hkdfCache.set(dataKey, k);
  }
  return k;
}

/**
 * THE STORED KEY (ADR-0230 §2, "Squatting"): HMAC-SHA256(per-server secret, tenant ‖ pairwise sub ‖ caller key). The
 * per-server secret is derived from the data key (domain-separated, so it never equals the pairwise or nonce keys);
 * the tenant is this deployment, which the data key already names; the pairwise `sub` is the one the server's identity
 * assertion carries for this person. Two people with the same caller key get different stored keys, so one cannot
 * claim the other's. Formatted as a GUID so the server can send it to SAP as `RequestID`. Null without a data key.
 */
export function deriveSapIdempotencyKey(
  dataKey: string | undefined,
  server: { id: string; url: string },
  userId: string,
  callerKey: string,
): string | null {
  const secrets = identitySecretsFor(dataKey);
  if (!secrets || !dataKey) return null;
  const serverSecret = createHmac("sha256", sapKeyBase(dataKey)).update(`server\u0000${server.id}`).digest();
  const sub = pairwiseSubject(secrets.pairwiseKey, canonicalMcpAudience(server.url) ?? `mcp-server:${server.id}`, userId);
  const h = createHmac("sha256", serverSecret).update(`deployment\u0000${sub}\u0000${callerKey.toLowerCase()}`).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** What the audit and usage rows record about an SAP business call: identifiers only, never prices or addresses. */
export interface SapCallFacts {
  service: string | null;
  entitySet: string | null;
  /** the STORED (derived) key, never the caller's */
  idempotencyKey: string;
}

export type SapWritePreparation =
  | { kind: "not_sap" }
  | { kind: "prepared"; arguments: Record<string, unknown>; facts: SapCallFacts }
  | { kind: "refused"; ruleId: string; reason: string };

/**
 * Before the decision: an SAP business write must carry a UUID `idempotencyKey`. The gateway replaces it with the
 * stored key, so the approval's payload binding (ADR-0104) covers the stored key and the upstream never sees the
 * caller's. A stored key used before (within the retention) with OTHER arguments is refused. Every refusal is audited.
 */
export async function prepareSapWrite(
  db: Db,
  dataKey: string | undefined,
  call: {
    userId: string;
    server: { id: string; url: string; name: string; systemClass: string | null };
    toolName: string;
    toolKind: "read" | "write";
    projectId: string | null;
    arguments: Record<string, unknown> | undefined;
    argumentsDigestOf: (args: Record<string, unknown>) => string;
  },
): Promise<SapWritePreparation> {
  if (call.server.systemClass !== "sap_business" || call.toolKind !== "write") return { kind: "not_sap" };
  const refuse = async (ruleId: string, reason: string, extra: Record<string, unknown> = {}): Promise<SapWritePreparation> => {
    await db.insert(auditLog).values({
      userId: call.userId,
      serverId: call.server.id,
      toolName: call.toolName,
      detail: { phase: "sap-business", toolKind: call.toolKind, projectId: call.projectId, receiptClass: "decision", ...extra },
      effect: "deny",
      ruleId,
      ruleChain: [],
      reason,
    });
    return { kind: "refused", ruleId, reason };
  };
  const callerKey = call.arguments?.[SAP_IDEMPOTENCY_ARGUMENT];
  if (typeof callerKey !== "string" || !UUID_RE.test(callerKey)) {
    return refuse(
      SAP_BUSINESS_RULE_IDS.keyRequired,
      `write tool '${call.toolName}' on SAP business server '${call.server.name}' refused: it must carry '${SAP_IDEMPOTENCY_ARGUMENT}', a UUID chosen by the caller`,
    );
  }
  const stored = deriveSapIdempotencyKey(dataKey, call.server, call.userId, callerKey);
  if (!stored) {
    return refuse(
      SAP_BUSINESS_RULE_IDS.keyUnavailable,
      `write tool '${call.toolName}' on SAP business server '${call.server.name}' refused: the gateway data key is not configured, so the idempotency key cannot be derived`,
    );
  }
  const args = { ...call.arguments, [SAP_IDEMPOTENCY_ARGUMENT]: stored };
  const digest = call.argumentsDigestOf(args);
  const known = KNOWN_SAP_TOOLS[call.toolName];
  const facts: SapCallFacts = { service: known?.service ?? null, entitySet: known?.entitySet ?? null, idempotencyKey: stored };
  // the key's earlier decisions, by this person on this server (the stored key embeds both, so this is exact)
  const [earlier] = await db
    .select({ digest: sql<string | null>`${auditLog.detail}->>'argumentsDigest'` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, call.userId),
        eq(auditLog.serverId, call.server.id),
        gte(auditLog.at, sql`now() - make_interval(days => ${SAP_IDEMPOTENCY_RETENTION_DAYS})`),
        sql`${auditLog.detail}->'sap'->>'idempotencyKey' = ${stored}`,
        sql`${auditLog.detail}->>'argumentsDigest' IS NOT NULL`,
        sql`${auditLog.detail}->>'argumentsDigest' <> ${digest}`,
      ),
    )
    .limit(1);
  if (earlier) {
    return refuse(
      SAP_BUSINESS_RULE_IDS.keyReused,
      `write tool '${call.toolName}' on SAP business server '${call.server.name}' refused: this idempotency key was already used with other arguments; choose a new key`,
      { sap: facts },
    );
  }
  return { kind: "prepared", arguments: args, facts };
}

const SAP_IDENT_RE = /^[A-Za-z0-9_]{1,64}$/;
const SAP_DOC_RE = /^[A-Za-z0-9_-]{1,40}$/;
const businessDocumentSchema = z
  .object({
    service: z.string().regex(SAP_IDENT_RE).optional(),
    entitySet: z.string().regex(SAP_IDENT_RE).optional(),
    documentNumber: z.string().regex(SAP_DOC_RE).optional(),
    replayed: z.boolean().optional(),
    errorCode: z.string().regex(SAP_IDENT_RE).optional(),
  })
  .passthrough();

export interface SapOutcome extends SapCallFacts {
  documentNumber: string | null;
  replayed: boolean;
  errorCode: string | null;
}

/**
 * Read the server's result contract (`structuredContent.businessDocument`, ADR-0230 §2's result): the document number,
 * whether it was an idempotent replay, and on an SAP error its code. Each value is shape-checked and anything else is
 * dropped, because the result is the upstream's text: SAP's error text, prices and partner data never reach the audit.
 */
export function readSapOutcome(facts: SapCallFacts, result: unknown): SapOutcome {
  const raw = (result as { structuredContent?: { businessDocument?: unknown } } | null)?.structuredContent?.businessDocument;
  const parsed = businessDocumentSchema.safeParse(raw);
  const doc = parsed.success ? parsed.data : {};
  return {
    service: facts.service ?? doc.service ?? null,
    entitySet: facts.entitySet ?? doc.entitySet ?? null,
    idempotencyKey: facts.idempotencyKey,
    documentNumber: doc.documentNumber ?? null,
    replayed: doc.replayed === true,
    errorCode: doc.errorCode ?? null,
  };
}

/** The outcome row: what the reviewer needs about the business call, beside the decision row. */
export async function recordSapOutcome(
  db: Db,
  call: { userId: string; serverId: string; toolName: string; projectId: string | null; approvalId: string | null; decisionAuditId: string },
  outcome: SapOutcome,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: call.userId,
    serverId: call.serverId,
    toolName: call.toolName,
    detail: {
      phase: "sap-business",
      receiptClass: "excluded",
      projectId: call.projectId,
      decisionAuditId: call.decisionAuditId,
      approvalId: call.approvalId,
      sap: outcome,
    },
    effect: "allow",
    ruleId: SAP_BUSINESS_RULE_IDS.outcome,
    ruleChain: [],
    reason: outcome.errorCode
      ? `SAP business call '${call.toolName}' failed upstream with SAP error code ${outcome.errorCode}`
      : outcome.replayed
        ? `SAP business call '${call.toolName}' replayed an earlier result for its idempotency key${outcome.documentNumber ? ` (document ${outcome.documentNumber})` : ""}; not charged`
        : `SAP business call '${call.toolName}' ran${outcome.documentNumber ? `, document ${outcome.documentNumber}` : ""}`,
  });
}
