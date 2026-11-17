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
import { runDetectionResponse, type DetectionResponseTarget } from "./responses.js";
import { RESPONSE_PENDING_STATES } from "./lifecycle.js";
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
  /** the admin who stored the active version (null for the built-in pack): the actor of its responses */
  createdBy: string | null;
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
      createdBy: detectionRulePacks.createdBy,
    })
    .from(detectionRulePacks)
    .innerJoin(receiptSigningKeys, eq(receiptSigningKeys.keyId, detectionRulePacks.keyId))
    .orderBy(desc(detectionRulePacks.version))
    .limit(1);
  const builtIn = { pack: DEFAULT_DETECTION_PACK, version: null, digest: packDigest(DEFAULT_DETECTION_PACK), createdBy: null };
  if (!row) return { ...builtIn, unverifiedVersion: null };
  try {
    const pack = parseDetectionPack(row.pack);
    if (packDigest(pack) === row.digest && verifyDetectionPack(pack, row.signature, row.publicJwk)) {
      return { pack, version: row.version, digest: row.digest, unverifiedVersion: null, createdBy: row.createdBy };
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
  /** ADR-0333 D1: the highest admission severity among the acting builder agent's attached skills (0-3) */
  skillSeverityRank: number | string | null;
}

const SEVERITY_BY_RANK = ["low", "medium", "high", "critical"] as const;
const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** foreign keys the incident row may carry: only ids that still resolve (the audit trail itself is FK-free) */
export interface DetectionEventRefs {
  userKnown: boolean;
  grantKnown: boolean;
  identityKnown: boolean;
}
type FreshEvent = DetectionEvent & DetectionEventRefs;

/** the add-on severity of an event: the higher of its MCP server's and its builder agent's skills' (ADR-0333 D1) */
function addonSeverity(server: DetectionEvent["addonSeverity"], skillRank: number | string | null): DetectionEvent["addonSeverity"] {
  const skill = skillRank === null ? -1 : Number(skillRank);
  const best = Math.max(server === null ? -1 : RANK[server]!, Number.isInteger(skill) ? skill : -1);
  return best < 0 ? null : SEVERITY_BY_RANK[best]!;
}

const toEvent = (r: EventRow): FreshEvent => {
  const { atMs, skillSeverityRank, ...rest } = r;
  return { ...rest, seq: Number(r.seq), at: Number(atMs), addonSeverity: addonSeverity(r.addonSeverity, skillSeverityRank) };
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
  (SELECT max(CASE bs.admission_severity WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 WHEN 'low' THEN 0 END)
     FROM builder_agent_skills bas JOIN builder_skills bs ON bs.id = bas.skill_id
     WHERE bas.agent_id = CASE WHEN (a.detail->>'builderAgentId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                               THEN (a.detail->>'builderAgentId')::uuid END) AS "skillSeverityRank",
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
  /** configured responses run in this pass (done or failed) */
  responses: number;
  packVersion: number | null;
  lookbackTruncated: boolean;
  /** ADR-0333 D2: history rows replayed in this pass, and whether the replay has finished */
  replayed: number;
  replayComplete: boolean;
}

/**
 * ADR-0333 D2 (owner, 2026-11-15): on first run the live cursor starts at the chain head and the retained history
 * is REPLAYED behind a second cursor, from the first retained row up to that head. The replay runs after the live
 * batches in each pass, a bounded number of batches at a time, and checkpoints after every batch, so a long history
 * never delays live detection and a restart resumes where it stopped.
 */
async function ensureState(db: Db): Promise<void> {
  await db.execute(sql`
    INSERT INTO detection_engine_state (id, cursor_seq, replay_cursor_seq, replay_until_seq)
    SELECT 1, h.head, 0, h.head FROM (SELECT coalesce(max(seq), 0) AS head FROM audit_log) h
    ON CONFLICT (id) DO NOTHING`);
}

type SweepMode = "live" | "replay";

interface Claimed {
  cursor: number;
  replayCursor: number;
  replayUntil: number;
}

async function claim(db: Db, token: string): Promise<Claimed | null> {
  const claimed = await rows<{ cursor: number | string; replayCursor: number | string; replayUntil: number | string }>(
    db,
    sql`UPDATE detection_engine_state
        SET lease_token = ${token}::uuid, lease_until = now() + make_interval(secs => ${DETECTION_SWEEP_LIMITS.leaseSeconds})
        WHERE id = 1 AND (lease_until IS NULL OR lease_until < now())
        RETURNING cursor_seq AS cursor, replay_cursor_seq AS "replayCursor", replay_until_seq AS "replayUntil"`,
  );
  const c = claimed[0];
  return c ? { cursor: Number(c.cursor), replayCursor: Number(c.replayCursor), replayUntil: Number(c.replayUntil) } : null;
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
  const result: DetectionSweepResult = {
    outcome: "not_claimed",
    rowsRead: 0,
    incidents: 0,
    responses: 0,
    packVersion: active.version,
    lookbackTruncated: false,
    replayed: 0,
    replayComplete: false,
  };
  if (claimed === null) return result;
  result.outcome = "idle";
  try {
    await reportUnverified(db, actorUserId, active);
    // a pass that ended between an incident's commit and its response leaves it pending: run it now
    result.responses += await runPendingResponses(db, actorUserId);
    const maxSpanSeconds = Math.max(0, ...active.pack.rules.map((r) => (r.type === "single" ? 0 : r.timespanSeconds)));
    // live first, so the replay of a long history never delays detection of what is happening now
    const live = await runRange(db, token, active, "live", claimed.cursor, null, maxSpanSeconds, result);
    result.rowsRead += live;
    // configured responses run for live incidents only (replayed ones are historical and alert-only)
    result.responses += await runPendingResponses(db, actorUserId);
    result.replayComplete = claimed.replayCursor >= claimed.replayUntil;
    if (!result.replayComplete) {
      const replayed = await runRange(db, token, active, "replay", claimed.replayCursor, claimed.replayUntil, maxSpanSeconds, result);
      result.replayed = replayed;
      result.rowsRead += replayed;
    }
  } finally {
    await release(db, token);
  }
  return result;
}

/** Evaluate batches over (from, until] in chain order, each committed with its cursor checkpoint. Returns rows read. */
async function runRange(
  db: Db,
  token: string,
  active: ActivePack,
  mode: SweepMode,
  from: number,
  until: number | null,
  maxSpanSeconds: number,
  result: DetectionSweepResult,
): Promise<number> {
  let cursor = from;
  let read = 0;
  for (let b = 0; b < DETECTION_SWEEP_LIMITS.maxBatchesPerPass; b++) {
    const bound = until === null ? sql`` : sql`AND a.seq <= ${until}`;
    const batch: EventRow[] = await rows<EventRow>(
      db,
      sql`SELECT ${EVENT_SELECT} ${EVENT_FROM} WHERE a.seq > ${cursor} ${bound} ORDER BY a.seq LIMIT ${DETECTION_SWEEP_LIMITS.batchSize}`,
    );
    // a replay whose remaining rows were all pruned still finishes: the checkpoint jumps to its end
    const lastSeq: number = batch.length > 0 ? Number(batch[batch.length - 1]!.seq) : mode === "replay" && until !== null ? until : cursor;
    if (lastSeq <= cursor) break;
    result.outcome = "evaluated";
    read += batch.length;
    const fresh = batch.filter((r) => !(DETECTION_OWN_OBJECT_TYPES as readonly string[]).includes(r.objectType)).map(toEvent);
    const matches = await evaluateBatch(db, active, fresh, cursor, maxSpanSeconds, result);
    result.incidents += await commitBatch(db, token, active, matches, lastSeq, mode);
    cursor = lastSeq;
    if (batch.length < DETECTION_SWEEP_LIMITS.batchSize) break;
  }
  return read;
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

/**
 * ADR-0333 §5: run every configured response that has not run yet, oldest first, each recorded on its incident. The
 * actor is the author of the pack version that raised the incident (the admin who passed the step-up).
 */
async function runPendingResponses(db: Db, actorUserId: string | null): Promise<number> {
  const pending = await rows<Omit<DetectionResponseTarget, "auditUserId">>(
    db,
    sql`SELECT i.id AS "incidentId", i.rule_id AS "ruleId", i.response AS response, i.group_key AS "groupKey",
               i.user_id AS "userId", i.actor_identity_id AS "actorIdentityId", p.created_by AS "packAuthor"
        FROM detection_incidents i LEFT JOIN detection_rule_packs p ON p.version = i.pack_version
        WHERE i.response <> 'alert' AND i.response_state IN (${sql.join(RESPONSE_PENDING_STATES.map((st) => sql`${st}`), sql`, `)})
        ORDER BY i.created_at, i.id LIMIT 100`,
  );
  for (const target of pending) await runDetectionResponse(db, { ...target, auditUserId: actorUserId ?? SYSTEM_ACTOR });
  return pending.length;
}

/** Incidents, evidence, audit rows and the cursor move commit together, conditional on this pass's lease. */
async function commitBatch(
  db: Db,
  token: string,
  active: ActivePack,
  matches: DetectionMatch[],
  lastSeq: number,
  mode: SweepMode,
): Promise<number> {
  const historical = mode === "replay";
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
          historical,
          // ADR-0333 D2: a replayed incident is historical and never triggers a response
          response: historical ? "alert" : m.rule.response,
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
          historical,
          response: historical ? "alert" : m.rule.response,
        },
        // raising the incident restricts nothing; a configured response writes its own row (responses.ts)
        effect: "allow",
        ruleId: `detection:${m.rule.id}`,
        ruleChain: [],
        reason: `Detection rule ${m.rule.id} matched (${m.rule.severity})${historical ? " in the history replay" : ""}`,
      });
    }
    const moved = await rows<{ id: number }>(
      tx,
      historical
        ? sql`UPDATE detection_engine_state SET replay_cursor_seq = ${lastSeq},
                replay_completed_at = CASE WHEN ${lastSeq} >= replay_until_seq THEN now() ELSE NULL END,
                lease_until = now() + make_interval(secs => ${DETECTION_SWEEP_LIMITS.leaseSeconds})
              WHERE id = 1 AND lease_token = ${token}::uuid AND replay_cursor_seq < ${lastSeq} RETURNING id`
        : sql`UPDATE detection_engine_state SET cursor_seq = ${lastSeq}, lease_until = now() + make_interval(secs => ${DETECTION_SWEEP_LIMITS.leaseSeconds})
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
          detail: {
            outcome: out.outcome,
            incidents: out.incidents,
            responses: out.responses,
            replayed: out.replayed,
            replayComplete: out.replayComplete,
            packVersion: out.packVersion,
            lookbackTruncated: out.lookbackTruncated,
          },
        };
      },
    },
  ];
}
