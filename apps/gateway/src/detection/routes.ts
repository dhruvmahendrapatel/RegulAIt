/**
 * ADR-0333 — admin API for agent behaviour detection. All admin-only through the default gate; API only (the screens
 * are known UI gaps tracked on #453).
 *
 *   GET /v1/detection/rule-pack                      the active pack, its version, digest and verification state
 *   PUT /v1/detection/rule-pack                      a new signed version (audited; a relaxation needs step-up)
 *   GET /v1/detection/incidents                      incidents, newest first, keyset-paginated
 *   GET /v1/detection/incidents/:incidentId          one incident with its evidence chain and receipts
 *   PUT /v1/detection/incidents/:incidentId/status   acknowledge or close (audited)
 *   POST /v1/detection/rule-pack/dry-run             ADR-0333 §5b: evaluate the active or a proposed pack over a past
 *                                                    window, read-only; per-rule hit counts (audited)
 *   GET  /v1/detection/suppressions                  per-rule suppressions (§5b), newest first, keyset-paginated
 *   POST /v1/detection/suppressions                  create one: `settings_relax` step-up bound to its terms (audited)
 *   POST /v1/detection/suppressions/:suppressionId/revoke
 *                                                    end one early (narrowing; audited)
 *   GET  /v1/detection/quarantines                   device quarantines (ADR-0333 §6), newest first, keyset-paginated
 *   GET  /v1/detection/quarantines/:quarantineId     one quarantine and its lifecycle
 *   POST /v1/detection/quarantines/:quarantineId/release
 *                                                    a human admin ends it early: `settings_relax` step-up bound to the
 *                                                    quarantine, only under the `normal` execution dial (audited)
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  detectionIncidents,
  detectionRulePacks,
  detectionSuppressions,
  DETECTION_SUPPRESSION_STATUSES,
  endpointDeviceQuarantines,
  ENDPOINT_DEVICE_QUARANTINE_STATUSES,
  eq,
  sql,
  DETECTION_INCIDENT_STATUSES,
  type Db,
} from "@regulait/db";
import { requireStepUp } from "../step-up.js";
import { ReceiptKeyError, resolveReceiptSigningKey } from "../receipt-signing-key.js";
import { registerReceiptSigningKey } from "../decision-receipts.js";
import { DETECTION_RULE_IDS, DRY_RUN_LIMITS, dryRunDetectionPack, loadActiveDetectionPack } from "./sweep.js";
import { DETECTION_INCIDENT_MACHINE, DETECTION_RESPONSE_MACHINE, ENDPOINT_DEVICE_QUARANTINE_MACHINE } from "@regulait/shared";
import { whereFrom } from "../state-transition.js";
import { afterCursorDesc, atTextSql, decodeCursor, encodeCursor } from "../pagination.js";
import { packChangeIsRelaxation, packDigest, parseDetectionPack, signDetectionPack } from "./pack.js";
import { QUARANTINE_DEVICE_ENFORCEMENT, releaseQuarantine } from "./quarantine.js";
import { createSuppression, describeSuppression, revokeSuppression, SUPPRESSION_LIMITS } from "./suppressions.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PAGE_MAX = 100;

const putPackBody = z
  .object({
    pack: z.unknown(),
    /** the version the admin edited (null = the built-in pack): a concurrent edit is refused, never overwritten */
    expectedVersion: z.number().int().min(1).nullable(),
  })
  .strict();
const incidentParam = z.object({ incidentId: z.string().uuid() });
const listQuery = z
  .object({
    status: z.enum(DETECTION_INCIDENT_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
    /** the previous page's `next`: the ADR-0031 opaque keyset cursor (microsecond-exact `created_at`, then id) */
    before: z.string().min(1).max(200).optional(),
  })
  .strict();
const quarantineParam = z.object({ quarantineId: z.string().uuid() });
const quarantineListQuery = z
  .object({
    status: z.enum(ENDPOINT_DEVICE_QUARANTINE_STATUSES).optional(),
    deviceId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
    before: z.string().min(1).max(200).optional(),
  })
  .strict();
const statusBody = z.object({ status: z.enum(["acknowledged", "closed"]) }).strict();
/** the requested status -> the DETECTION_INCIDENT_MACHINE event that lands there (ADR-0348) */
const STATUS_EVENT = { acknowledged: "acknowledge", closed: "close" } as const;

type Rows<T> = { rows: T[] };

export function registerDetectionRoutes(app: FastifyInstance, db: Db): void {
  registerQuarantineRoutes(app, db);
  registerSuppressionRoutes(app, db);
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const refuse = (reply: FastifyReply, status: number, error: string, detail?: string) =>
    reply.status(status).send({ error, ...(detail ? { detail } : {}) });

  app.get("/v1/detection/rule-pack", async () => {
    const active = await loadActiveDetectionPack(db);
    return {
      source: active.version === null ? "built-in" : "stored",
      version: active.version,
      digest: active.digest,
      unverifiedVersion: active.unverifiedVersion,
      pack: active.pack,
    };
  });

  app.put("/v1/detection/rule-pack", async (req, reply) => {
    const body = putPackBody.safeParse(req.body);
    if (!body.success) return refuse(reply, 400, "invalid_request", "body must be { pack, expectedVersion }");
    let next;
    try {
      next = parseDetectionPack(body.data.pack);
    } catch (err) {
      const issue = err instanceof z.ZodError ? err.issues[0] : undefined;
      return refuse(reply, 400, "invalid_detection_pack", issue ? `${issue.path.join(".")}: ${issue.message}` : undefined);
    }
    const active = await loadActiveDetectionPack(db);
    const [latest] = await db.select({ version: detectionRulePacks.version }).from(detectionRulePacks).orderBy(desc(detectionRulePacks.version)).limit(1);
    const latestVersion = latest?.version ?? null;
    if (body.data.expectedVersion !== latestVersion) {
      return refuse(reply, 409, "detection_pack_version_conflict", `the latest version is ${latestVersion ?? "the built-in pack"}`);
    }
    const digest = packDigest(next);
    const relaxed = packChangeIsRelaxation(active.pack, next);
    if (relaxed) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { detection: "rule-pack", fromDigest: active.digest, toDigest: digest },
      });
      if (!su.ok) return reply;
    }
    const key = resolveReceiptSigningKey();
    if (!key) return refuse(reply, 409, "detection_signing_unavailable", "no receipt signing key is configured");
    const version = (latestVersion ?? 0) + 1;
    try {
      await db.transaction(async (tx) => {
        await registerReceiptSigningKey(tx, key, new Date(), "detection-rule-pack");
        const inserted = await tx
          .insert(detectionRulePacks)
          .values({ version, pack: next, packDigest: digest, signature: signDetectionPack(next, key.privateKey), keyId: key.keyId, createdBy: req.authCtx.userId ?? null })
          .onConflictDoNothing()
          .returning({ version: detectionRulePacks.version });
        if (inserted.length === 0) throw new VersionConflict();
        await tx.insert(auditLog).values({
          userId: actor(req),
          objectType: "detection_rule_pack",
          detail: { subsystem: "agent-detection", adr: "0333", version, fromDigest: active.digest, toDigest: digest, relaxed, rules: next.rules.length },
          effect: "allow",
          ruleId: DETECTION_RULE_IDS.packUpdated,
          ruleChain: [],
          reason: relaxed ? "Detection rule pack changed (relaxation, step-up verified)" : "Detection rule pack extended",
        });
      });
    } catch (err) {
      if (err instanceof VersionConflict) return refuse(reply, 409, "detection_pack_version_conflict");
      if (err instanceof ReceiptKeyError) return refuse(reply, 503, "detection_signing_unavailable");
      throw err;
    }
    return reply.status(201).send({ version, digest, relaxed });
  });

  app.get("/v1/detection/incidents", async (req, reply) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) return refuse(reply, 400, "invalid_request");
    const conds = [];
    if (q.data.status) conds.push(eq(detectionIncidents.status, q.data.status));
    if (q.data.before) {
      // A Date cursor keeps milliseconds only, and one sweep batch inserts every incident at the same now(): a
      // millisecond cursor would skip the rest of that batch. The shared cursor is microsecond-exact (ADR-0031).
      const cursor = decodeCursor(q.data.before);
      if (!cursor) return refuse(reply, 400, "invalid_request", "before is not a valid cursor");
      conds.push(afterCursorDesc(detectionIncidents.createdAt, detectionIncidents.id, cursor));
    }
    const rows = await db
      .select({
        id: detectionIncidents.id,
        ruleId: detectionIncidents.ruleId,
        packVersion: detectionIncidents.packVersion,
        severity: detectionIncidents.severity,
        groupKey: detectionIncidents.groupKey,
        status: detectionIncidents.status,
        response: detectionIncidents.response,
        responseState: detectionIncidents.responseState,
        historical: detectionIncidents.historical,
        userId: detectionIncidents.userId,
        delegationGrantId: detectionIncidents.delegationGrantId,
        triggerAuditId: detectionIncidents.triggerAuditId,
        createdAt: detectionIncidents.createdAt,
        cursorAt: atTextSql(detectionIncidents.createdAt),
      })
      .from(detectionIncidents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(detectionIncidents.createdAt), desc(detectionIncidents.id))
      .limit(q.data.limit + 1);
    const more = rows.length > q.data.limit;
    const page = more ? rows.slice(0, q.data.limit) : rows;
    const last = page[page.length - 1];
    return {
      incidents: page.map(({ cursorAt: _cursorAt, ...row }) => row),
      next: more && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    };
  });

  app.get("/v1/detection/incidents/:incidentId", async (req, reply) => {
    const p = incidentParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "incidentId must be a uuid");
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, p.data.incidentId));
    if (!incident) return refuse(reply, 404, "not_found");
    // The evidence chain: each audit row (if the retention prune has not removed it) and its signed receipt, if any.
    const evidence = (await db.execute(sql`
      SELECT e.step_index AS "stepIndex", e.audit_id AS "auditId", e.audit_seq AS "auditSeq",
             a.at AS "at", a.object_type AS "objectType", a.effect AS effect, a.rule_id AS "ruleId",
             a.server_id AS "serverId", a.tool_name AS "toolName", a.row_hash AS "rowHash",
             a.delegation_grant_id AS "delegationGrantId", a.actor_chain AS "actorChain",
             r.receipt_seq AS "receiptSeq", r.key_id AS "receiptKeyId", (a.id IS NOT NULL) AS "auditPresent"
      FROM detection_incident_evidence e
      LEFT JOIN audit_log a ON a.id = e.audit_id
      LEFT JOIN decision_receipts r ON r.audit_id = e.audit_id
      WHERE e.incident_id = ${incident.id}
      ORDER BY e.step_index, e.audit_seq
      LIMIT 1000`)) as unknown as Rows<Record<string, unknown>>;
    // ADR-0348: what may happen next and why not, from the same tables the server enforces
    const lifecycle = {
      status: DETECTION_INCIDENT_MACHINE.describe(incident.status),
      response: DETECTION_RESPONSE_MACHINE.describe(incident.responseState),
    };
    return { incident, lifecycle, evidence: evidence.rows };
  });

  app.put("/v1/detection/incidents/:incidentId/status", async (req, reply) => {
    const p = incidentParam.safeParse(req.params);
    const b = statusBody.safeParse(req.body);
    if (!p.success || !b.success) return refuse(reply, 400, "invalid_request");
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(detectionIncidents)
        .set({ status: b.data.status, statusChangedBy: req.authCtx.userId ?? null, statusChangedAt: sql`now()` })
        .where(and(eq(detectionIncidents.id, p.data.incidentId), whereFrom(detectionIncidents.status, DETECTION_INCIDENT_MACHINE, STATUS_EVENT[b.data.status])))
        .returning({ id: detectionIncidents.id, status: detectionIncidents.status });
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "detection_incident",
        objectId: row.id,
        detail: { subsystem: "agent-detection", adr: "0333", status: row.status },
        effect: "allow",
        ruleId: DETECTION_RULE_IDS.incidentStatus,
        ruleChain: [],
        reason: `Detection incident ${row.status}`,
      });
      return row;
    });
    if (!updated) return refuse(reply, 404, "not_found", "no open or acknowledged incident with that id");
    return updated;
  });
}

/** register the ADR-0333 §6 quarantine routes (called from registerDetectionRoutes) */
function registerQuarantineRoutes(app: FastifyInstance, db: Db): void {
  const refuse = (reply: FastifyReply, status: number, error: string, detail?: string) =>
    reply.status(status).send({ error, ...(detail ? { detail } : {}) });
  const view = (q: typeof endpointDeviceQuarantines.$inferSelect) => ({
    ...q,
    deviceEnforcement: QUARANTINE_DEVICE_ENFORCEMENT,
    lifecycle: ENDPOINT_DEVICE_QUARANTINE_MACHINE.describe(q.status),
  });

  app.get("/v1/detection/quarantines", async (req, reply) => {
    const q = quarantineListQuery.safeParse(req.query);
    if (!q.success) return refuse(reply, 400, "invalid_request");
    const conds = [];
    if (q.data.status) conds.push(eq(endpointDeviceQuarantines.status, q.data.status));
    if (q.data.deviceId) conds.push(eq(endpointDeviceQuarantines.deviceId, q.data.deviceId));
    if (q.data.before) {
      const cursor = decodeCursor(q.data.before);
      if (!cursor) return refuse(reply, 400, "invalid_request", "before is not a valid cursor");
      conds.push(afterCursorDesc(endpointDeviceQuarantines.createdAt, endpointDeviceQuarantines.id, cursor));
    }
    const rows = await db
      .select({ q: endpointDeviceQuarantines, cursorAt: atTextSql(endpointDeviceQuarantines.createdAt) })
      .from(endpointDeviceQuarantines)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(endpointDeviceQuarantines.createdAt), desc(endpointDeviceQuarantines.id))
      .limit(q.data.limit + 1);
    const more = rows.length > q.data.limit;
    const page = more ? rows.slice(0, q.data.limit) : rows;
    const last = page[page.length - 1];
    return {
      quarantines: page.map((r) => view(r.q)),
      next: more && last ? encodeCursor({ at: last.cursorAt, id: last.q.id }) : null,
    };
  });

  app.get("/v1/detection/quarantines/:quarantineId", async (req, reply) => {
    const p = quarantineParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "quarantineId must be a uuid");
    const [row] = await db.select().from(endpointDeviceQuarantines).where(eq(endpointDeviceQuarantines.id, p.data.quarantineId));
    if (!row) return refuse(reply, 404, "not_found");
    return { quarantine: view(row) };
  });

  app.post("/v1/detection/quarantines/:quarantineId/release", async (req, reply) => {
    const p = quarantineParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "quarantineId must be a uuid");
    const body = z.object({}).strict().safeParse(req.body ?? {});
    if (!body.success) return refuse(reply, 400, "invalid_request", "the body takes no fields");
    const actorUserId = req.authCtx.userId;
    if (!actorUserId || actorUserId === NIL_UUID) return refuse(reply, 403, "human_admin_required", "a release is a human admin's decision");
    const [row] = await db.select({ status: endpointDeviceQuarantines.status }).from(endpointDeviceQuarantines).where(eq(endpointDeviceQuarantines.id, p.data.quarantineId));
    if (!row) return refuse(reply, 404, "not_found");
    if (row.status !== "active") return refuse(reply, 409, "quarantine_not_active", `the quarantine is ${row.status}`);
    // a release widens the device's access: a settings_relax step-up bound to this quarantine
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { detection: "device-quarantine-release", quarantineId: p.data.quarantineId } });
    if (!su.ok) return reply;
    const out = await releaseQuarantine(db, { quarantineId: p.data.quarantineId, actorUserId, stepUp: su.method });
    if (!out.ok) {
      const status = out.code === "quarantine_not_found" ? 404 : 409;
      return refuse(reply, status, out.code, out.detail);
    }
    const [after] = await db.select().from(endpointDeviceQuarantines).where(eq(endpointDeviceQuarantines.id, p.data.quarantineId));
    return { quarantine: view(after!) };
  });
}

const GROUP_KEY = /^(grant|user|endpoint):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const suppressionParam = z.object({ suppressionId: z.string().uuid() });
const createSuppressionBody = z
  .object({
    ruleId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    groupKey: z.string().regex(GROUP_KEY, "a grant:, user: or endpoint: key with one uuid; never a wildcard"),
    hours: z.number().int().min(1).max(SUPPRESSION_LIMITS.hoursMax),
    reason: z.string().trim().min(1).max(SUPPRESSION_LIMITS.reasonMax),
  })
  .strict();
const suppressionListQuery = z
  .object({
    status: z.enum(DETECTION_SUPPRESSION_STATUSES).optional(),
    ruleId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
    before: z.string().min(1).max(200).optional(),
  })
  .strict();
const dryRunBody = z
  .object({
    /** a proposed pack to try; omitted = the active pack */
    pack: z.unknown().optional(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict();

/** ADR-0333 §5b: suppressions and the dry run (called from registerDetectionRoutes) */
function registerSuppressionRoutes(app: FastifyInstance, db: Db): void {
  const refuse = (reply: FastifyReply, status: number, error: string, detail?: string) =>
    reply.status(status).send({ error, ...(detail ? { detail } : {}) });
  const view = (row: typeof detectionSuppressions.$inferSelect) => ({ ...row, ...describeSuppression(row) });
  const human = (req: FastifyRequest): string | null => {
    const id = req.authCtx.userId;
    return id && id !== NIL_UUID ? id : null;
  };

  app.post("/v1/detection/rule-pack/dry-run", async (req, reply) => {
    const body = dryRunBody.safeParse(req.body);
    if (!body.success) return refuse(reply, 400, "invalid_request", "body must be { from, to, pack? } with ISO timestamps");
    const from = new Date(body.data.from);
    const to = new Date(body.data.to);
    if (!(from < to)) return refuse(reply, 400, "invalid_window", "from must be before to");
    if (to.getTime() > Date.now() + 60_000) return refuse(reply, 400, "invalid_window", "a dry run covers the past only");
    if ((to.getTime() - from.getTime()) / 1000 > DRY_RUN_LIMITS.maxWindowSeconds) {
      return refuse(reply, 400, "invalid_window", `the window is at most ${DRY_RUN_LIMITS.maxWindowSeconds / 86400} days`);
    }
    let pack;
    let source: "active" | "proposed" = "active";
    if (body.data.pack !== undefined) {
      try {
        pack = parseDetectionPack(body.data.pack);
        source = "proposed";
      } catch (err) {
        const issue = err instanceof z.ZodError ? err.issues[0] : undefined;
        return refuse(reply, 400, "invalid_detection_pack", issue ? `${issue.path.join(".")}: ${issue.message}` : undefined);
      }
    } else {
      pack = (await loadActiveDetectionPack(db)).pack;
    }
    const result = await dryRunDetectionPack(db, pack, { from, to });
    // the dry run reads the audit trail: who ran it, over which window and pack, is itself audited
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_UUID,
      objectType: "detection_rule_pack",
      detail: { subsystem: "agent-detection", adr: "0333", dryRun: true, source, packDigest: packDigest(pack), from: result.window.from, to: result.window.to, rowsRead: result.rowsRead, truncated: result.truncated },
      effect: "allow",
      ruleId: DETECTION_RULE_IDS.packDryRun,
      ruleChain: [],
      reason: `Detection rule pack dry run (${source} pack) over a past window; nothing was raised`,
    });
    return { source, packDigest: packDigest(pack), ...result };
  });

  app.get("/v1/detection/suppressions", async (req, reply) => {
    const q = suppressionListQuery.safeParse(req.query);
    if (!q.success) return refuse(reply, 400, "invalid_request");
    const conds = [];
    if (q.data.status) conds.push(eq(detectionSuppressions.status, q.data.status));
    if (q.data.ruleId) conds.push(eq(detectionSuppressions.ruleId, q.data.ruleId));
    if (q.data.before) {
      const cursor = decodeCursor(q.data.before);
      if (!cursor) return refuse(reply, 400, "invalid_request", "before is not a valid cursor");
      conds.push(afterCursorDesc(detectionSuppressions.createdAt, detectionSuppressions.id, cursor));
    }
    const rows = await db
      .select({ s: detectionSuppressions, cursorAt: atTextSql(detectionSuppressions.createdAt) })
      .from(detectionSuppressions)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(detectionSuppressions.createdAt), desc(detectionSuppressions.id))
      .limit(q.data.limit + 1);
    const more = rows.length > q.data.limit;
    const page = more ? rows.slice(0, q.data.limit) : rows;
    const last = page[page.length - 1];
    return { suppressions: page.map((r) => view(r.s)), next: more && last ? encodeCursor({ at: last.cursorAt, id: last.s.id }) : null };
  });

  app.post("/v1/detection/suppressions", async (req, reply) => {
    const body = createSuppressionBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return refuse(reply, 400, "invalid_request", issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : undefined);
    }
    const actorUserId = human(req);
    if (!actorUserId) return refuse(reply, 403, "human_admin_required", "a suppression is a human admin's decision");
    const active = await loadActiveDetectionPack(db);
    if (!active.pack.rules.some((r) => r.id === body.data.ruleId)) {
      return refuse(reply, 422, "unknown_rule", "the active rule pack has no rule with that id");
    }
    // a suppression relaxes detection: a settings_relax step-up bound to exactly these terms
    const reasonDigest = createHash("sha256").update(body.data.reason).digest("hex");
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { detection: "suppression", ruleId: body.data.ruleId, groupKey: body.data.groupKey, hours: body.data.hours, reasonDigest },
    });
    if (!su.ok) return reply;
    const out = await createSuppression(db, { ...body.data, actorUserId, stepUp: su.method });
    if (!out.ok) return refuse(reply, out.status, out.code, out.detail);
    return reply.status(201).send({ suppression: view(out.row) });
  });

  app.post("/v1/detection/suppressions/:suppressionId/revoke", async (req, reply) => {
    const p = suppressionParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "suppressionId must be a uuid");
    const body = z.object({}).strict().safeParse(req.body ?? {});
    if (!body.success) return refuse(reply, 400, "invalid_request", "the body takes no fields");
    // a narrowing: any admin principal may end a suppression early (no step-up); the audit row names who
    const row = await revokeSuppression(db, { id: p.data.suppressionId, actorUserId: human(req) });
    if (!row) {
      const [exists] = await db.select().from(detectionSuppressions).where(eq(detectionSuppressions.id, p.data.suppressionId));
      if (!exists) return refuse(reply, 404, "not_found");
      return refuse(reply, 409, "suppression_not_active", `the suppression is ${describeSuppression(exists).state}`);
    }
    return { suppression: view(row) };
  });
}

class VersionConflict extends Error {
  constructor() {
    super("detection_pack_version_conflict");
    this.name = "VersionConflict";
  }
}
