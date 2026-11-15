/**
 * ADR-0333 — the detection sweep: reads committed audit rows behind one leased cursor, evaluates the active rule pack,
 * and raises incidents with their evidence chain.
 *
 * NEVER IN THE DECISION PATH. It runs only on the `agent-detection-sweep` scheduler job, reads the audit log, and
 * writes only its own tables plus one audit row per incident (which ADR-0303 then delivers to the SIEM). A failed
 * sweep leaves the cursor where it was, so the next pass re-reads the same rows; incidents are idempotent per (rule,
 * trigger row). Its own audit rows (`detection_incident`, `detection_rule_pack`) are skipped, so it never feeds itself.
 */
import { randomUUID } from "node:crypto";
import {
  auditLog,
  desc,
  detectionEngineState,
  detectionIncidentEvidence,
  detectionIncidents,
  detectionRulePacks,
  eq,
  receiptSigningKeys,
  sql,
  type Db,
} from "@regulait/db";
import type { SchedulerJobDefinition } from "../scheduler.js";

/** the scheduler's system actor (`SCHEDULER_SYSTEM_ACTOR`), restated to keep this module type-only on the scheduler */
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";
import { evaluateDetections, raisedKey, type DetectionEvent, type DetectionMatch } from "./engine.js";
import { DEFAULT_DETECTION_PACK, packDigest, parseDetectionPack, verifyDetectionPack, type DetectionPack } from "./pack.js";

export const DETECTION_SWEEP_JOB_NAME = "agent-detection-sweep";
export const DETECTION_OWN_OBJECT_TYPES = ["detection_incident", "detection_rule_pack"] as const;

export const DETECTION_SWEEP_LIMITS = {
  batchSize: 500,
  maxBatchesPerPass: 10,
  /** look-back rows loaded per batch for the groups the batch touches */
  lookbackRows: 5000,
  leaseSeconds: 60,
} as const;

export const DETECTION_RULE_IDS = {
  packUpdated: "detection-pack-updated",
  packUnverified: "detection-pack-unverified",
  incidentStatus: "detection-incident-status",
} as const;

export interface ActivePack {
  pack: DetectionPack;
  /** null = the built-in default pack */
  version: number | null;
  digest: string;
  /** a stored version exists but did not verify, so the built-in pack is in use */
  unverifiedVersion: number | null;
}

/** The pack the engine uses: the latest stored version if it parses and verifies, else the built-in default. */
export async function loadActiveDetectionPack(db: Pick<Db, "select">): Promise<ActivePack> {
  const [row] = await db
    .select({
      version: detectionRulePacks.version,
      pack: detectionRulePacks.pack,
      signature: detectionRulePacks.signature,
      digest: detectionRulePacks.packDigest,
      publicJwk: receiptSigningKeys.publicJwk,
      retiredAt: receiptSigningKeys.retiredAt,
    })
    .from(detectionRulePacks)
    .innerJoin(receiptSigningKeys, eq(receiptSigningKeys.keyId, detectionRulePacks.keyId))
    .orderBy(desc(detectionRulePacks.version))
    .limit(1);
  const builtIn = { pack: DEFAULT_DETECTION_PACK, version: null, digest: packDigest(DEFAULT_DETECTION_PACK) };
  if (!row) return { ...builtIn, unverifiedVersion: null };
  try {
    const pack = parseDetectionPack(row.pack);
    if (packDigest(pack) === row.digest && verifyDetectionPack(pack, row.signature, row.publicJwk)) {
      return { pack, version: row.version, digest: row.digest, unverifiedVersion: null };
    }
  } catch {
    /* falls through: a stored pack that does not parse is unverified */
  }
  return { ...builtIn, unverifiedVersion: row.version };
}

interface EventRow {
  auditId: string;
  seq: number | string;
  atMs: number | string;
  group: string;
  userId: string;
  objectType: string;
  effect: DetectionEvent["effect"];
  ruleId: string;
  toolName: string | null;
  serverId: string | null;
  phase: string | null;
  dataScoped: boolean;
  addonSeverity: DetectionEvent["addonSeverity"];
  delegationGrantId: string | null;
  actorIdentityId: string | null;
  actorChain: string[] | null;
  userKnown: boolean;
  grantKnown: boolean;
  identityKnown: boolean;
}

/** foreign keys the incident row may carry: only ids that still resolve (the audit trail itself is FK-free) */
export interface DetectionEventRefs {
  userKnown: boolean;
  grantKnown: boolean;
  identityKnown: boolean;
}
type FreshEvent = DetectionEvent & DetectionEventRefs;

const toEvent = (r: EventRow): FreshEvent => {
  const { atMs, ...rest } = r;
  return { ...rest, seq: Number(r.seq), at: Number(atMs) };
};

/** the event projection: the group key, the data-scope flag and the add-on's admission severity, from one row */
const EVENT_SELECT = sql`
  a.id AS "auditId", a.seq AS seq, (extract(epoch FROM a.at) * 1000)::float8 AS "atMs",
  CASE WHEN a.delegation_grant_id IS NOT NULL THEN 'grant:' || coalesce(g.root_grant_id, a.delegation_grant_id)::text
       ELSE 'user:' || a.user_id::text END AS "group",
  a.user_id AS "userId", a.object_type AS "objectType", a.effect AS effect, a.rule_id AS "ruleId",
  a.tool_name AS "toolName", a.server_id AS "serverId", a.detail->>'phase' AS phase,
  (jsonb_typeof(a.rule_chain) = 'array' AND a.rule_chain @> '[{"rule":"data-scope"}]'::jsonb) AS "dataScoped",
  CASE WHEN a.object_type = 'mcp_tool' THEN s.admission_severity ELSE NULL END AS "addonSeverity",
  a.delegation_grant_id AS "delegationGrantId", a.actor_identity_id AS "actorIdentityId", a.actor_chain AS "actorChain",
  (u.id IS NOT NULL) AS "userKnown", (g.id IS NOT NULL) AS "grantKnown", (wi.id IS NOT NULL) AS "identityKnown"`;
const EVENT_FROM = sql`FROM audit_log a
  LEFT JOIN delegation_grants g ON g.id = a.delegation_grant_id
  LEFT JOIN mcp_servers s ON s.id = a.server_id
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN workload_identities wi ON wi.id = a.actor_identity_id`;
const NOT_OWN = sql`a.object_type NOT IN ('detection_incident', 'detection_rule_pack')`;

async function rows<T>(db: Pick<Db, "execute">, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

export interface DetectionSweepResult {
  outcome: "not_claimed" | "idle" | "evaluated";
  rowsRead: number;
  incidents: number;
  packVersion: number | null;
  lookbackTruncated: boolean;
}

/** Start the cursor at the chain head on first run: detection is forward-looking, history is not replayed. */
async function ensureState(db: Db): Promise<void> {
  await db.execute(sql`
    INSERT INTO detection_engine_state (id, cursor_seq)
    SELECT 1, coalesce((SELECT max(seq) FROM audit_log), 0)
    ON CONFLICT (id) DO NOTHING`);
}

async function claim(db: Db, token: string): Promise<number | null> {
  const claimed = await rows<{ cursor: number | string }>(
    db,
    sql`UPDATE detection_engine_state
        SET lease_token = ${token}::uuid, lease_until = now() + make_interval(secs => ${DETECTION_SWEEP_LIMITS.leaseSeconds})
        WHERE id = 1 AND (lease_until IS NULL OR lease_until < now())
        RETURNING cursor_seq AS cursor`,
  );
  return claimed[0] ? Number(claimed[0].cursor) : null;
}

async function release(db: Db, token: string): Promise<void> {
  await db.execute(sql`UPDATE detection_engine_state SET lease_token = NULL, lease_until = NULL, last_sweep_at = now()
    WHERE id = 1 AND lease_token = ${token}::uuid`);
}

async function reportUnverified(db: Db, actorUserId: string | null, active: ActivePack): Promise<void> {
  if (active.unverifiedVersion === null) return;
  await db.transaction(async (tx) => {
    const updated = await rows<{ id: number }>(
      tx,
      sql`UPDATE detection_engine_state SET unverified_pack_version = ${active.unverifiedVersion}
          WHERE id = 1 AND unverified_pack_version IS DISTINCT FROM ${active.unverifiedVersion} RETURNING id`,
    );
    if (updated.length === 0) return;
    await tx.insert(auditLog).values({
      userId: actorUserId ?? SYSTEM_ACTOR,
      objectType: "detection_rule_pack",
      detail: { subsystem: "agent-detection", adr: "0333", version: active.unverifiedVersion, fallback: "built-in" },
      effect: "deny",
      ruleId: DETECTION_RULE_IDS.packUnverified,
      ruleChain: [],
      reason: "The stored detection rule pack did not verify; the built-in default pack is in use",
    });
  });
}

/** One pass: claim the lease, evaluate batches until caught up or the per-pass cap, release. */
export async function runDetectionSweep(db: Db, actorUserId: string | null): Promise<DetectionSweepResult> {
  await ensureState(db);
  const token = randomUUID();
  const claimed = await claim(db, token);
  const active = await loadActiveDetectionPack(db);
  const result: DetectionSweepResult = { outcome: "not_claimed", rowsRead: 0, incidents: 0, packVersion: active.version, lookbackTruncated: false };
  if (claimed === null) return result;
  let cursor: number = claimed;
  result.outcome = "idle";
  try {
    await reportUnverified(db, actorUserId, active);
    const maxSpanSeconds = Math.max(0, ...active.pack.rules.map((r) => (r.type === "single" ? 0 : r.timespanSeconds)));
    for (let b = 0; b < DETECTION_SWEEP_LIMITS.maxBatchesPerPass; b++) {
      const batch: EventRow[] = await rows<EventRow>(
        db,
        sql`SELECT ${EVENT_SELECT} ${EVENT_FROM} WHERE a.seq > ${cursor} ORDER BY a.seq LIMIT ${DETECTION_SWEEP_LIMITS.batchSize}`,
      );
      if (batch.length === 0) break;
      result.outcome = "evaluated";
      result.rowsRead += batch.length;
      const lastSeq: number = Number(batch[batch.length - 1]!.seq);
      const fresh = batch.filter((r) => !(DETECTION_OWN_OBJECT_TYPES as readonly string[]).includes(r.objectType)).map(toEvent);
      const matches = await evaluateBatch(db, active, fresh, cursor, maxSpanSeconds, result);
      const raised = await commitBatch(db, token, active, matches, lastSeq);
      result.incidents += raised;
      cursor = lastSeq;
      if (batch.length < DETECTION_SWEEP_LIMITS.batchSize) break;
    }
  } finally {
    await release(db, token);
  }
  return result;
}

async function evaluateBatch(
  db: Db,
  active: ActivePack,
  fresh: FreshEvent[],
  cursor: number,
  maxSpanSeconds: number,
  result: DetectionSweepResult,
): Promise<DetectionMatch[]> {
  if (fresh.length === 0) return [];
  const groups = [...new Set(fresh.map((e) => e.group))];
  const groupList = sql`ARRAY[${sql.join(groups.map((g) => sql`${g}`), sql`, `)}]::text[]`;
  let lookback: DetectionEvent[] = [];
  if (maxSpanSeconds > 0) {
    const since = Math.min(...fresh.map((e) => e.at)) - maxSpanSeconds * 1000;
    const loaded = await rows<EventRow>(
      db,
      sql`SELECT * FROM (
            SELECT ${EVENT_SELECT} ${EVENT_FROM}
            WHERE a.seq <= ${cursor} AND a.seq IS NOT NULL AND ${NOT_OWN}
              AND a.at >= to_timestamp(${since / 1000}::float8)
            ORDER BY a.seq DESC
          ) w WHERE w."group" = ANY(${groupList})
          ORDER BY w.seq DESC LIMIT ${DETECTION_SWEEP_LIMITS.lookbackRows + 1}`,
    );
    if (loaded.length > DETECTION_SWEEP_LIMITS.lookbackRows) {
      result.lookbackTruncated = true;
      loaded.length = DETECTION_SWEEP_LIMITS.lookbackRows;
    }
    lookback = loaded.map(toEvent).reverse();
  }
  const raisedRows = await rows<{ ruleId: string; firstSeq: number | string }>(
    db,
    sql`SELECT i.rule_id AS "ruleId", min(e.audit_seq) AS "firstSeq"
        FROM detection_incidents i JOIN detection_incident_evidence e ON e.incident_id = i.id
        WHERE i.group_key = ANY(${groupList})
          AND i.created_at >= now() - make_interval(secs => ${Math.max(maxSpanSeconds, 60) * 2})
        GROUP BY i.id, i.rule_id`,
  );
  const raised = new Set(raisedRows.map((r) => raisedKey(r.ruleId, Number(r.firstSeq))));
  const events = [...lookback, ...fresh];
  return evaluateDetections(active.pack, events, new Set(fresh.map((e) => e.seq)), raised);
}

/** Incidents, evidence, audit rows and the cursor move commit together, conditional on this pass's lease. */
async function commitBatch(db: Db, token: string, active: ActivePack, matches: DetectionMatch[], lastSeq: number): Promise<number> {
  return db.transaction(async (tx) => {
    let raised = 0;
    for (const m of matches) {
      const refs = m.trigger as FreshEvent;
      const [incident] = await tx
        .insert(detectionIncidents)
        .values({
          ruleId: m.rule.id,
          packVersion: active.version,
          severity: m.rule.severity,
          groupKey: m.group,
          triggerAuditId: m.trigger.auditId,
          triggerAuditSeq: m.trigger.seq,
          userId: refs.userKnown ? m.trigger.userId : null,
          delegationGrantId: refs.grantKnown ? m.trigger.delegationGrantId : null,
          actorIdentityId: refs.identityKnown ? m.trigger.actorIdentityId : null,
          actorChain: m.trigger.actorChain,
          response: "alert",
        })
        .onConflictDoNothing()
        .returning({ id: detectionIncidents.id });
      if (!incident) continue;
      raised++;
      await tx
        .insert(detectionIncidentEvidence)
        .values(m.evidence.map((e, i) => ({ incidentId: incident.id, auditId: e.auditId, auditSeq: e.seq, stepIndex: i })));
      await tx.insert(auditLog).values({
        userId: m.trigger.userId,
        objectType: "detection_incident",
        objectId: incident.id,
        detail: {
          subsystem: "agent-detection",
          adr: "0333",
          rule: m.rule.id,
          ruleType: m.rule.type,
          severity: m.rule.severity,
          packVersion: active.version,
          packDigest: active.digest,
          group: m.group,
          evidenceAuditIds: m.evidence.map((e) => e.auditId),
          response: "alert",
        },
        // alert only: the incident records a detection and restricts nothing
        effect: "allow",
        ruleId: `detection:${m.rule.id}`,
        ruleChain: [],
        reason: `Detection rule ${m.rule.id} matched (${m.rule.severity})`,
      });
    }
    const moved = await rows<{ id: number }>(
      tx,
      sql`UPDATE detection_engine_state SET cursor_seq = ${lastSeq}, lease_until = now() + make_interval(secs => ${DETECTION_SWEEP_LIMITS.leaseSeconds})
          WHERE id = 1 AND lease_token = ${token}::uuid AND cursor_seq < ${lastSeq} RETURNING id`,
    );
    if (moved.length === 0) throw new Error("detection_lease_lost");
    return raised;
  });
}

export function detectionJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: DETECTION_SWEEP_JOB_NAME,
      description:
        "Evaluate the active detection rule pack over new audit-chain rows (per delegation tree or user, in a bounded " +
        "window) and raise incidents with their evidence chain. Deterministic rules only; reads the audit log and is " +
        "never in a decision path.",
      adr: "ADR-0333",
      defaultIntervalSeconds: 15,
      run: async (ctx) => {
        const out = await runDetectionSweep(ctx.db, ctx.actorUserId);
        return {
          itemsProcessed: out.rowsRead,
          detail: { outcome: out.outcome, incidents: out.incidents, packVersion: out.packVersion, lookbackTruncated: out.lookbackTruncated },
        };
      },
    },
  ];
}
