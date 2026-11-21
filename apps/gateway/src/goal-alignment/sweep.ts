/**
 * ADR-0359 §7 (lane E40) — the goal-alignment sweep (OWASP ASI01), shadow mode. Behind one lease, a cursor over
 * committed `audit_log.seq` reads each agent tool call (a row with `actor_identity_id`, on an MCP tool or a connector)
 * once and judges it against that agent's declared purpose (`evaluateGoalAlignment`). A divergent call adds to one
 * finding per (UTC day, identity, primary divergence, target); a new finding also writes one chained audit row, so the
 * ADR-0303 SIEM export carries it.
 *
 * - The first pass starts the cursor at the chain head: history is never judged against a purpose declared later.
 *   For the same reason the behaviour engine's `off` mode (one switch for both, ADR-0359 §4) moves the cursor to the
 *   head without judging.
 * - Nothing here is in a decision path and nothing a finding says changes a decision. Every read and write is the
 *   install's own Postgres: no network, no model (ADR-0015, air-gapped).
 */
import { randomUUID } from "node:crypto";
import { agentPurposeDeclarations, agentPurposeTools, auditLog, inArray, sql, type Db } from "@regulait/db";
import { classifyCallTargets } from "../agent-capabilities.js";
import type { SchedulerJobDefinition } from "../scheduler.js";
import { behaviourMode } from "../behaviour/sweep.js";
import { evaluateGoalAlignment, targetKey, type DeclaredPurpose, type GoalCall, type GoalDivergenceReason, type GoalTargetKind } from "./check.js";

export const GOAL_ALIGNMENT_JOB_NAME = "goal-alignment-sweep";
export const GOAL_ALIGNMENT_OBJECT_TYPE = "goal_alignment" as const;
export const GOAL_ALIGNMENT_RULE_IDS = {
  observed: "goal-divergence-observed",
  findingStatus: "goal-finding-status",
  declared: "agent-purpose-declared",
} as const;
export const GOAL_ALIGNMENT_LIMITS = Object.freeze({ batchSize: 2000, maxBatchesPerPass: 10, leaseSeconds: 120 });

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

async function rows<T>(db: Pick<Db, "execute">, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows;
}

class LeaseLost extends Error {
  constructor() {
    super("goal_alignment_lease_lost");
    this.name = "LeaseLost";
  }
}

async function claim(db: Db, token: string): Promise<{ cursor: number | null } | null> {
  await db.execute(sql`INSERT INTO goal_alignment_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const [c] = await rows<{ cursor: number | string | null }>(
    db,
    sql`UPDATE goal_alignment_state
        SET lease_token = ${token}::uuid, lease_until = now() + make_interval(secs => ${GOAL_ALIGNMENT_LIMITS.leaseSeconds})
        WHERE id = 1 AND (lease_until IS NULL OR lease_until < now())
        RETURNING cursor_seq AS cursor`,
  );
  return c ? { cursor: c.cursor === null ? null : Number(c.cursor) } : null;
}

async function release(db: Db, token: string): Promise<void> {
  await db.execute(sql`UPDATE goal_alignment_state SET lease_until = NULL, lease_token = NULL, last_sweep_at = now()
                       WHERE id = 1 AND lease_token = ${token}::uuid`);
}

/** move the cursor to the chain head without judging (first pass, or `off`) */
async function skipToHead(db: Db, token: string): Promise<number> {
  const [r] = await rows<{ head: number | string }>(
    db,
    sql`UPDATE goal_alignment_state SET cursor_seq = (SELECT coalesce(max(seq), 0) FROM audit_log)
        WHERE id = 1 AND lease_token = ${token}::uuid RETURNING cursor_seq AS head`,
  );
  if (!r) throw new LeaseLost();
  return Number(r.head);
}

interface CallRow {
  seq: number | string;
  day: string;
  identityId: string;
  objectType: GoalTargetKind;
  objectId: string | null;
  serverId: string | null;
  toolName: string | null;
}

/** the declared purposes of `identityIds` (absent = none declared) */
export async function loadDeclaredPurposes(db: Pick<Db, "select">, identityIds: readonly string[]): Promise<Map<string, DeclaredPurpose & { version: number }>> {
  const out = new Map<string, DeclaredPurpose & { version: number }>();
  if (!identityIds.length) return out;
  const [decls, tools] = await Promise.all([
    db.select().from(agentPurposeDeclarations).where(inArray(agentPurposeDeclarations.identityId, [...identityIds])),
    db.select().from(agentPurposeTools).where(inArray(agentPurposeTools.identityId, [...identityIds])),
  ]);
  for (const d of decls) {
    out.set(d.identityId, {
      statement: d.statement,
      allowWrite: d.allowWrite,
      allowDestructive: d.allowDestructive,
      allowOpenWorld: d.allowOpenWorld,
      version: d.version,
      tools: tools.filter((t) => t.identityId === d.identityId).map((t) => targetKey(t.targetKind, t.refId)).sort(),
    });
  }
  return out;
}

interface Pending {
  day: string;
  identityId: string;
  reason: GoalDivergenceReason;
  reasons: GoalDivergenceReason[];
  suggestedResponse: string;
  call: GoalCall;
  key: string;
  declared: Record<string, unknown> | null;
  count: number;
  firstSeq: number;
  lastSeq: number;
  explanation: string;
}

/**
 * One batch: judge the agent tool calls among the next `batchSize` committed rows after `cursor`, add the divergent
 * ones to findings, and move the cursor, in one transaction conditional on the lease.
 */
async function judgeBatch(db: Db, token: string, cursor: number): Promise<{ read: number; findings: number }> {
  return db.transaction(async (tx) => {
    const [range] = await rows<{ last: number | string | null; read: number | string }>(
      tx,
      sql`SELECT max(seq) AS last, count(*) AS read FROM (SELECT seq FROM audit_log WHERE seq > ${cursor} ORDER BY seq LIMIT ${GOAL_ALIGNMENT_LIMITS.batchSize}) b`,
    );
    const read = Number(range?.read ?? 0);
    if (read === 0 || range?.last === null || range?.last === undefined) return { read: 0, findings: 0 };
    const last = Number(range.last);
    const calls = await rows<CallRow>(
      tx,
      sql`SELECT seq, to_char((at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, actor_identity_id AS "identityId",
                 object_type AS "objectType", object_id AS "objectId", server_id AS "serverId", tool_name AS "toolName"
          FROM audit_log
          WHERE seq > ${cursor} AND seq <= ${last} AND actor_identity_id IS NOT NULL AND actor_identity_id <> ${NIL_UUID}::uuid
            AND ((object_type = 'mcp_tool' AND server_id IS NOT NULL AND tool_name IS NOT NULL)
              OR (object_type = 'connector' AND object_id IS NOT NULL))
          ORDER BY seq`,
    );
    const pending = new Map<string, Pending>();
    if (calls.length) {
      const purposes = await loadDeclaredPurposes(tx, [...new Set(calls.map((c) => c.identityId))]);
      const targets = await classifyCallTargets(tx as unknown as Db, {
        mcp: calls.filter((c) => c.objectType === "mcp_tool").map((c) => ({ serverId: c.serverId!, name: c.toolName! })),
        connectorIds: calls.filter((c) => c.objectType === "connector").map((c) => c.objectId!),
      });
      for (const c of calls) {
        const seq = Number(c.seq);
        let call: GoalCall;
        let key: string;
        if (c.objectType === "mcp_tool") {
          const t = targets.mcp.get(`${c.serverId}\u0000${c.toolName}`);
          // fail closed: a tool missing from the registry counts as a destructive, open-world write
          call = t
            ? { targetKind: "mcp_tool", targetId: t.id, targetName: t.name, writes: t.writes, destructive: t.destructive, openWorld: t.openWorld }
            : { targetKind: "mcp_tool", targetId: null, targetName: c.toolName!, writes: true, destructive: true, openWorld: true };
          key = t ? t.id : `unregistered:${c.serverId}:${c.toolName}`.slice(0, 300);
        } else {
          const t = targets.connectors.get(c.objectId!);
          const reads = c.toolName === "read";
          call = t
            ? { targetKind: "connector", targetId: t.id, targetName: t.name, writes: reads ? false : t.writes, destructive: false, openWorld: false }
            : { targetKind: "connector", targetId: null, targetName: c.objectId!, writes: true, destructive: true, openWorld: true };
          key = c.objectId!;
        }
        const purpose = purposes.get(c.identityId) ?? null;
        const v = evaluateGoalAlignment(purpose, call);
        if (v.aligned || !v.primary) continue;
        const k = `${c.day}|${c.identityId}|${v.primary}|${call.targetKind}|${key}`;
        const prior = pending.get(k);
        if (prior) {
          prior.count += 1;
          prior.lastSeq = seq;
          continue;
        }
        pending.set(k, {
          day: c.day,
          identityId: c.identityId,
          reason: v.primary,
          reasons: v.reasons,
          suggestedResponse: v.suggestedResponse!,
          call,
          key,
          declared: purpose
            ? { version: purpose.version, statement: purpose.statement, allowWrite: purpose.allowWrite, allowDestructive: purpose.allowDestructive, allowOpenWorld: purpose.allowOpenWorld, tools: purpose.tools }
            : null,
          count: 1,
          firstSeq: seq,
          lastSeq: seq,
          explanation: v.explanation.slice(0, 2000),
        });
      }
    }
    let created = 0;
    for (const p of pending.values()) {
      const [r] = await rows<{ id: string; inserted: boolean }>(
        tx,
        sql`INSERT INTO goal_alignment_findings
              (day, identity_id, divergence, divergences, suggested_response, target_kind, target_key, target_name,
               observed_write, observed_destructive, observed_open_world, declared, call_count, first_seq, last_seq, explanation)
            VALUES (${p.day}::date, ${p.identityId}::uuid, ${p.reason}, ${`{${p.reasons.join(",")}}`}::text[], ${p.suggestedResponse},
                    ${p.call.targetKind}, ${p.key}, ${p.call.targetName.slice(0, 300)}, ${p.call.writes}, ${p.call.destructive},
                    ${p.call.openWorld}, ${p.declared === null ? null : JSON.stringify(p.declared)}::jsonb, ${p.count}, ${p.firstSeq},
                    ${p.lastSeq}, ${p.explanation})
            ON CONFLICT (day, identity_id, divergence, target_kind, target_key) DO UPDATE
              SET call_count = goal_alignment_findings.call_count + EXCLUDED.call_count,
                  last_seq = greatest(goal_alignment_findings.last_seq, EXCLUDED.last_seq), updated_at = now()
            RETURNING id, (xmax = 0) AS inserted`,
      );
      if (!r?.inserted) continue;
      created += 1;
      await tx.insert(auditLog).values({
        userId: NIL_UUID,
        objectType: GOAL_ALIGNMENT_OBJECT_TYPE,
        objectId: r.id,
        detail: {
          subsystem: "goal-alignment",
          adr: "0359",
          mode: "shadow",
          identityId: p.identityId,
          day: p.day,
          divergence: p.reason,
          divergences: p.reasons,
          suggestedResponse: p.suggestedResponse,
          target: { kind: p.call.targetKind, key: p.key, name: p.call.targetName },
          firstSeq: p.firstSeq,
          declaredVersion: p.declared ? (p.declared.version as number) : null,
        },
        effect: "allow",
        ruleId: GOAL_ALIGNMENT_RULE_IDS.observed,
        ruleChain: [],
        reason: `Goal divergence observed (shadow, not enforced): ${p.explanation}`.slice(0, 2000),
      });
    }
    const moved = await rows<{ id: number }>(
      tx,
      sql`UPDATE goal_alignment_state SET cursor_seq = ${last},
            lease_until = now() + make_interval(secs => ${GOAL_ALIGNMENT_LIMITS.leaseSeconds})
          WHERE id = 1 AND lease_token = ${token}::uuid AND cursor_seq = ${cursor} RETURNING id`,
    );
    if (moved.length === 0) throw new LeaseLost();
    return { read, findings: created };
  });
}

export interface GoalAlignmentSweepResult {
  ran: boolean;
  mode: "shadow" | "off";
  read: number;
  findings: number;
  started?: boolean;
}

export async function runGoalAlignmentSweep(db: Db): Promise<GoalAlignmentSweepResult> {
  const mode = await behaviourMode(db);
  const token = randomUUID();
  const lease = await claim(db, token);
  if (!lease) return { ran: false, mode, read: 0, findings: 0 };
  try {
    if (lease.cursor === null || mode === "off") {
      await skipToHead(db, token);
      return { ran: true, mode, read: 0, findings: 0, started: lease.cursor === null };
    }
    let cursor = lease.cursor;
    let read = 0;
    let findings = 0;
    for (let i = 0; i < GOAL_ALIGNMENT_LIMITS.maxBatchesPerPass; i++) {
      const b = await judgeBatch(db, token, cursor);
      if (b.read === 0) break;
      read += b.read;
      findings += b.findings;
      const [s] = await rows<{ cursor: number | string }>(db, sql`SELECT cursor_seq AS cursor FROM goal_alignment_state WHERE id = 1`);
      cursor = Number(s!.cursor);
      if (b.read < GOAL_ALIGNMENT_LIMITS.batchSize) break;
    }
    return { ran: true, mode, read, findings };
  } catch (err) {
    if (err instanceof LeaseLost) return { ran: false, mode, read: 0, findings: 0 };
    throw err;
  } finally {
    await release(db, token);
  }
}

export function goalAlignmentJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: GOAL_ALIGNMENT_JOB_NAME,
      description:
        "Judge each agent tool call in the audit chain against the agent's declared purpose (OWASP ASI01 goal " +
        "alignment). Shadow mode: findings with a suggested steering response only, never enforcement; reads the " +
        "install's own audit log and is never in a decision path.",
      adr: "ADR-0359",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runGoalAlignmentSweep(ctx.db);
        return { itemsProcessed: out.read, detail: { ran: out.ran, mode: out.mode, findings: out.findings } };
      },
    },
  ];
}
