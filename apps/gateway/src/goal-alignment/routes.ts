/**
 * ADR-0359 §7 (lane E40) — admin API for goal alignment (OWASP ASI01). Admin-only through the default gate; API only
 * (the screens are known UI gaps tracked on #453).
 *
 *   GET /v1/goal-alignment/purposes/:identityId        an agent identity's declared purpose (null = none declared)
 *   PUT /v1/goal-alignment/purposes/:identityId        declare or change it (widening an existing one: step-up; audited)
 *   GET /v1/goal-alignment/findings                    shadow findings, newest first, keyset-paginated
 *   PUT /v1/goal-alignment/findings/:findingId/status  acknowledge or dismiss (the ADR-0359 finding table; audited)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentPurposeDeclarations,
  agentPurposeTools,
  and,
  auditLog,
  connectors,
  desc,
  eq,
  goalAlignmentFindings,
  inArray,
  lt,
  mcpTools,
  or,
  sql,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { BEHAVIOUR_FINDING_STATUSES, parseAgentGuidance } from "@regulait/shared";
import { requireStepUp } from "../step-up.js";
import { FINDING_STATUS_TRANSITIONS, SETTABLE_FINDING_STATUSES, findingStatusSources } from "../behaviour/lifecycle.js";
import { GOAL_DIVERGENCE_REASONS, GOAL_TARGET_KINDS, targetKey } from "./check.js";
import { GOAL_ALIGNMENT_OBJECT_TYPE, GOAL_ALIGNMENT_RULE_IDS, loadDeclaredPurposes } from "./sweep.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PAGE_MAX = 100;
const TOOLS_MAX = 200;

const identityParam = z.object({ identityId: z.string().uuid() });
const findingParam = z.object({ findingId: z.string().uuid() });
const purposeBody = z
  .object({
    statement: z.string(),
    allowWrite: z.boolean().default(false),
    allowDestructive: z.boolean().default(false),
    allowOpenWorld: z.boolean().default(false),
    tools: z
      .array(z.object({ kind: z.enum(GOAL_TARGET_KINDS), id: z.string().uuid() }).strict())
      .max(TOOLS_MAX)
      .default([]),
  })
  .strict()
  .refine((b) => !b.allowDestructive || b.allowWrite, { message: "allowDestructive needs allowWrite" });
const listQuery = z
  .object({
    status: z.enum(BEHAVIOUR_FINDING_STATUSES).optional(),
    identityId: z.string().uuid().optional(),
    divergence: z.enum(GOAL_DIVERGENCE_REASONS).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
    /** keyset cursor: `<createdAt ISO>_<id>` of the last row of the previous page */
    before: z
      .string()
      .regex(/^[0-9T:.\-+Z]{20,40}_[0-9a-f-]{36}$/)
      .optional(),
  })
  .strict();
const statusBody = z.object({ status: z.enum(SETTABLE_FINDING_STATUSES) }).strict();

export function registerGoalAlignmentRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const refuse = (reply: FastifyReply, status: number, error: string, detail?: string) =>
    reply.status(status).send({ error, ...(detail ? { detail } : {}) });

  app.get("/v1/goal-alignment/purposes/:identityId", async (req, reply) => {
    const p = identityParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "identityId must be a uuid");
    const [identity] = await db.select({ id: workloadIdentities.id, kind: workloadIdentities.kind }).from(workloadIdentities).where(eq(workloadIdentities.id, p.data.identityId));
    if (!identity) return refuse(reply, 404, "not_found");
    const purpose = (await loadDeclaredPurposes(db, [identity.id])).get(identity.id) ?? null;
    return { identityId: identity.id, kind: identity.kind, purpose, mode: "shadow", enforcement: "none" };
  });

  app.put("/v1/goal-alignment/purposes/:identityId", async (req, reply) => {
    const p = identityParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "identityId must be a uuid");
    const b = purposeBody.safeParse(req.body);
    if (!b.success) return refuse(reply, 400, "invalid_request", b.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    // the statement is plain one-line text scanned like steering guidance (ADR-0354): it is shown next to findings
    const text = parseAgentGuidance({ message: b.data.statement });
    if (!text.ok) return refuse(reply, 422, "invalid_statement", text.errors.join("; "));
    const statement = text.guidance.message;
    const [identity] = await db.select({ id: workloadIdentities.id }).from(workloadIdentities).where(eq(workloadIdentities.id, p.data.identityId));
    if (!identity) return refuse(reply, 404, "not_found");
    const tools = [...new Map(b.data.tools.map((t) => [targetKey(t.kind, t.id), t])).values()];
    const mcpIds = tools.filter((t) => t.kind === "mcp_tool").map((t) => t.id);
    const connIds = tools.filter((t) => t.kind === "connector").map((t) => t.id);
    const [knownMcp, knownConn] = await Promise.all([
      mcpIds.length ? db.select({ id: mcpTools.id }).from(mcpTools).where(inArray(mcpTools.id, mcpIds)) : Promise.resolve([]),
      connIds.length ? db.select({ id: connectors.id }).from(connectors).where(inArray(connectors.id, connIds)) : Promise.resolve([]),
    ]);
    const known = new Set([...knownMcp.map((t) => targetKey("mcp_tool", t.id)), ...knownConn.map((c) => targetKey("connector", c.id))]);
    const unknown = tools.filter((t) => !known.has(targetKey(t.kind, t.id)));
    if (unknown.length) return refuse(reply, 422, "unknown_tool", `not in the registry: ${unknown.map((t) => targetKey(t.kind, t.id)).join(", ")}`);

    const prior = (await loadDeclaredPurposes(db, [identity.id])).get(identity.id) ?? null;
    const nextKeys = tools.map((t) => targetKey(t.kind, t.id)).sort();
    // Widening an existing purpose (a new tool or a newly allowed action) means fewer findings: a relaxation, so a
    // step-up bound to the exact change. A first declaration narrows (every call was a no-purpose finding before).
    const added = prior ? nextKeys.filter((k) => !prior.tools.includes(k)) : [];
    const widened =
      !!prior &&
      (added.length > 0 ||
        (b.data.allowWrite && !prior.allowWrite) ||
        (b.data.allowDestructive && !prior.allowDestructive) ||
        (b.data.allowOpenWorld && !prior.allowOpenWorld));
    if (widened) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: {
          goalAlignment: "purpose",
          identityId: identity.id,
          fromVersion: prior!.version,
          addedTools: added.join(","),
          allowWrite: b.data.allowWrite,
          allowDestructive: b.data.allowDestructive,
          allowOpenWorld: b.data.allowOpenWorld,
        },
      });
      if (!su.ok) return reply;
    }
    const version = await db.transaction(async (tx) => {
      const values = {
        statement,
        allowWrite: b.data.allowWrite,
        allowDestructive: b.data.allowDestructive,
        allowOpenWorld: b.data.allowOpenWorld,
        declaredBy: req.authCtx.userId ?? null,
      };
      const [row] = await tx
        .insert(agentPurposeDeclarations)
        .values({ identityId: identity.id, ...values })
        .onConflictDoUpdate({
          target: agentPurposeDeclarations.identityId,
          set: { ...values, version: sql`${agentPurposeDeclarations.version} + 1`, declaredAt: sql`now()` },
        })
        .returning({ version: agentPurposeDeclarations.version });
      await tx.delete(agentPurposeTools).where(eq(agentPurposeTools.identityId, identity.id));
      if (tools.length) await tx.insert(agentPurposeTools).values(tools.map((t) => ({ identityId: identity.id, targetKind: t.kind, refId: t.id })));
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: GOAL_ALIGNMENT_OBJECT_TYPE,
        objectId: identity.id,
        detail: {
          subsystem: "goal-alignment",
          adr: "0359",
          version: row!.version,
          fromVersion: prior?.version ?? null,
          tools: nextKeys.length,
          addedTools: added,
          allowWrite: values.allowWrite,
          allowDestructive: values.allowDestructive,
          allowOpenWorld: values.allowOpenWorld,
          relaxation: widened,
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: GOAL_ALIGNMENT_RULE_IDS.declared,
        ruleChain: [],
        reason: widened
          ? `Agent purpose widened to version ${row!.version} — RELAXED: fewer calls will be flagged (step-up verified)`
          : `Agent purpose declared (version ${row!.version})`,
      });
      return row!.version;
    });
    return { identityId: identity.id, version, relaxed: widened };
  });

  app.get("/v1/goal-alignment/findings", async (req, reply) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) return refuse(reply, 400, "invalid_request");
    const f = goalAlignmentFindings;
    const conds = [];
    if (q.data.status) conds.push(eq(f.status, q.data.status));
    if (q.data.identityId) conds.push(eq(f.identityId, q.data.identityId));
    if (q.data.divergence) conds.push(eq(f.divergence, q.data.divergence));
    if (q.data.before) {
      const cut = q.data.before.lastIndexOf("_");
      const at = new Date(q.data.before.slice(0, cut));
      const id = q.data.before.slice(cut + 1);
      if (!Number.isFinite(at.getTime())) return refuse(reply, 400, "invalid_request", "before is not a valid cursor");
      conds.push(or(lt(f.createdAt, at), and(eq(f.createdAt, at), lt(f.id, id))));
    }
    const rows = await db
      .select()
      .from(f)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(f.createdAt), desc(f.id))
      .limit(q.data.limit + 1);
    const more = rows.length > q.data.limit;
    const page = (more ? rows.slice(0, q.data.limit) : rows).map((r) => ({ ...r, allowedNext: FINDING_STATUS_TRANSITIONS[r.status] }));
    const last = page[page.length - 1];
    return { findings: page, mode: "shadow", enforcement: "none", next: more && last ? `${last.createdAt.toISOString()}_${last.id}` : null };
  });

  app.put("/v1/goal-alignment/findings/:findingId/status", async (req, reply) => {
    const p = findingParam.safeParse(req.params);
    const b = statusBody.safeParse(req.body);
    if (!p.success || !b.success) return refuse(reply, 400, "invalid_request");
    const f = goalAlignmentFindings;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(f)
        .set({ status: b.data.status, statusChangedBy: req.authCtx.userId ?? null, statusChangedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(f.id, p.data.findingId), inArray(f.status, findingStatusSources(b.data.status))))
        .returning({ id: f.id, status: f.status });
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: GOAL_ALIGNMENT_OBJECT_TYPE,
        objectId: row.id,
        detail: { subsystem: "goal-alignment", adr: "0359", status: row.status },
        effect: "allow",
        ruleId: GOAL_ALIGNMENT_RULE_IDS.findingStatus,
        ruleChain: [],
        reason: `Goal-alignment finding ${row.status}`,
      });
      return row;
    });
    if (!updated) {
      const [exists] = await db.select({ status: f.status }).from(f).where(eq(f.id, p.data.findingId));
      if (!exists) return refuse(reply, 404, "not_found");
      return refuse(reply, 409, "invalid_transition", `a ${exists.status} finding cannot move to ${b.data.status}`);
    }
    return updated;
  });
}
