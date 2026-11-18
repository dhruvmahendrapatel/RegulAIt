/**
 * ADR-0333 — admin API for agent behaviour detection. All admin-only through the default gate; API only (the screens
 * are known UI gaps tracked on #453).
 *
 *   GET /v1/detection/rule-pack                      the active pack, its version, digest and verification state
 *   PUT /v1/detection/rule-pack                      a new signed version (audited; a relaxation needs step-up)
 *   GET /v1/detection/incidents                      incidents, newest first, keyset-paginated
 *   GET /v1/detection/incidents/:incidentId          one incident with its evidence chain and receipts
 *   PUT /v1/detection/incidents/:incidentId/status   acknowledge or close (audited)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  detectionIncidents,
  detectionRulePacks,
  eq,
  sql,
  DETECTION_INCIDENT_STATUSES,
  type Db,
} from "@regulait/db";
import { requireStepUp } from "../step-up.js";
import { ReceiptKeyError, resolveReceiptSigningKey } from "../receipt-signing-key.js";
import { registerReceiptSigningKey } from "../decision-receipts.js";
import { DETECTION_RULE_IDS, loadActiveDetectionPack } from "./sweep.js";
import { DETECTION_INCIDENT_MACHINE, DETECTION_RESPONSE_MACHINE } from "@regulait/shared";
import { whereFrom } from "../state-transition.js";
import { afterCursorDesc, atTextSql, decodeCursor, encodeCursor } from "../pagination.js";
import { packChangeIsRelaxation, packDigest, parseDetectionPack, signDetectionPack } from "./pack.js";

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
const statusBody = z.object({ status: z.enum(["acknowledged", "closed"]) }).strict();
/** the requested status -> the DETECTION_INCIDENT_MACHINE event that lands there (ADR-0348) */
const STATUS_EVENT = { acknowledged: "acknowledge", closed: "close" } as const;

type Rows<T> = { rows: T[] };

export function registerDetectionRoutes(app: FastifyInstance, db: Db): void {
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
    // Slice 1 runs alert-only responses; a stronger response is refused rather than stored and silently ignored.
    if (next.rules.some((r) => r.response !== "alert")) {
      return refuse(reply, 400, "detection_response_not_available", "only the alert response is available in this build");
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

class VersionConflict extends Error {
  constructor() {
    super("detection_pack_version_conflict");
    this.name = "VersionConflict";
  }
}
