/**
 * ADR-0302 — the retention sweep for third-party ingest evidence (ADR-0261, backlog P37).
 *
 * `third_party_ingest_records` is append-only evidence. ADR-0261 left it with no retention and said it should follow
 * the compliance cascade (pillar 3) like the audit log. This sweep does that:
 *
 *  - THE FLOOR IS THE AUDIT LOG'S. `retentionFloor` composes every compliance profile's `auditRetentionDays` with the
 *    org default (longest wins, ADR-0021). With no floor configured nothing is ever deleted (fail-safe: keep all).
 *    There is deliberately no evidence-specific knob, for the reason ADR-0070 gives for traces: a second dial would
 *    let an operator shorten what a framework says to keep.
 *  - PER-MODE OVERRIDES EXTEND IT. Evidence rows carry no deploy mode, so the longest effective per-mode override
 *    (ADR-0179 A4, MAX-only) applies to all of them. For evidence the safe direction is keeping longer; traces take
 *    the shorter one because they hold prompts, and these rows hold none (ADR-0261 decision 5).
 *  - THE DATABASE CLOCK DECIDES (M-075). The cutoff is computed from `now()` and compared with `received_at`, which the
 *    database wrote. The guard trigger re-checks both (migration `third_party_evidence_retention`), so a process clock
 *    running ahead cannot delete evidence early.
 *  - ONE AUDIT ROW PER PASS THAT DELETES, IN THE SAME TRANSACTION as the delete, naming the floor, the cutoff and the
 *    count per source. A pass that deletes nothing writes nothing (the job's run row already records it).
 *  - BOUNDED. At most `BATCH` rows per transaction and `MAX_BATCHES` transactions per pass; a backlog drains over
 *    later passes.
 */
import { and, auditLog, inArray, lt, sql, thirdPartyIngestRecords, type Db } from "@regulait/db";
import { retentionFloor } from "./org-settings.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const THIRD_PARTY_EVIDENCE_RETENTION_JOB_NAME = "third-party-evidence-retention-sweep";
export const THIRD_PARTY_EVIDENCE_RETENTION_RULE_ID = "third-party-evidence-retention-purged";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const BATCH = 2000;
const MAX_BATCHES = 10;
const DAY_MS = 24 * 3600 * 1000;

export interface ThirdPartyEvidenceRetentionResult {
  deleted: number;
  /** the days applied (the composed floor, extended by the longest per-mode override); null = keep everything */
  retainedDays: number | null;
  floorSource: string[];
  cutoff: string | null;
}

export async function runThirdPartyEvidenceRetentionSweep(
  db: Db,
  opts: { actorUserId?: string | null } = {},
): Promise<ThirdPartyEvidenceRetentionResult> {
  const f = await retentionFloor(db);
  if (f.retainedDays == null || f.cutoff == null) {
    return { deleted: 0, retainedDays: null, floorSource: [], cutoff: null };
  }
  const retainedDays = Math.max(f.retainedDays, ...f.modeOverrides.map((o) => o.retainedDays));
  // f.cutoff was taken from the database clock for f.retainedDays; move it back by any extension
  const cutoff = new Date(f.cutoff.getTime() - (retainedDays - f.retainedDays) * DAY_MS);
  const floorSource = [
    ...f.floorSource,
    ...f.modeOverrides.filter((o) => o.retainedDays === retainedDays && retainedDays > f.retainedDays!).map((o) => `mode:${o.mode}`),
  ];

  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // the guard trigger lets a DELETE through only for rows older than this cutoff (transaction-local)
      await tx.execute(sql`SELECT set_config('regulait.tpi_retention_cutoff', ${cutoff.toISOString()}, true)`);
      const due = await tx
        .select({ id: thirdPartyIngestRecords.id })
        .from(thirdPartyIngestRecords)
        .where(lt(thirdPartyIngestRecords.receivedAt, cutoff))
        .orderBy(thirdPartyIngestRecords.receivedAt)
        .limit(BATCH);
      if (due.length === 0) return 0;
      const removed = await tx
        .delete(thirdPartyIngestRecords)
        .where(and(inArray(thirdPartyIngestRecords.id, due.map((d) => d.id)), lt(thirdPartyIngestRecords.receivedAt, cutoff)))
        .returning({ sourceId: thirdPartyIngestRecords.sourceId });
      const bySource: Record<string, number> = {};
      for (const r of removed) bySource[r.sourceId] = (bySource[r.sourceId] ?? 0) + 1;
      await tx.insert(auditLog).values({
        userId: opts.actorUserId ?? NO_IDENTITY,
        objectType: "third_party_ingest_source",
        objectId: null,
        detail: {
          subsystem: "third-party-ingest",
          adr: "0302",
          phase: "evidence-retention",
          deleted: removed.length,
          retainedDays,
          floorSource,
          cutoff: cutoff.toISOString(),
          bySource,
          attribution: "third_party",
        },
        effect: "allow",
        ruleId: THIRD_PARTY_EVIDENCE_RETENTION_RULE_ID,
        ruleChain: [],
        reason:
          `deleted ${removed.length} third-party evidence record(s) received before ${cutoff.toISOString()} ` +
          `(retention ${retainedDays}d from [${floorSource.join(", ")}]) (ADR-0302)`,
      });
      return removed.length;
    });
    deleted += n;
    if (n < BATCH) break;
  }
  return { deleted, retainedDays, floorSource, cutoff: cutoff.toISOString() };
}

export function thirdPartyIngestJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: THIRD_PARTY_EVIDENCE_RETENTION_JOB_NAME,
      description:
        "Delete third-party ingest evidence (ADR-0261) received before the compliance-cascade audit-retention floor " +
        "(the longest per-mode override extends it), audited in the same transaction. With no floor configured " +
        "nothing is deleted.",
      adr: "ADR-0302",
      defaultIntervalSeconds: 24 * 3600,
      run: async (ctx) => {
        const out = await runThirdPartyEvidenceRetentionSweep(ctx.db, { actorUserId: ctx.actorUserId });
        return { itemsProcessed: out.deleted, detail: { ...out } };
      },
    },
  ];
}
