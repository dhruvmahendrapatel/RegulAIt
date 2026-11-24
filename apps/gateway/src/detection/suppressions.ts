/**
 * ADR-0333 §5b (slice 4) — per-rule detection suppressions.
 *
 * A suppression names ONE rule of the pack and ONE group (`user:`, `grant:` or `endpoint:` key, never a wildcard: a
 * rule silenced for everyone is a pack edit, which has its own step-up). While it is `active` and before `expires_at`,
 * the sweep raises no incident for that rule in that group; each suppressed match is still counted, in one
 * `detection-suppressed` audit row per suppression per batch, so a suppression never hides that the rule fired.
 *
 *   refused  a `critical` rule (`suppression_not_allowed_for_severity`), and a group that is the requester's own: their
 *            `user:` key, or a delegation tree whose root they sponsor (`cannot_suppress_own_detection`; review of #1157).
 *            Another admin must decide those. The sweep also never applies a suppression to its creator's own calls.
 *   bound    to the rule's digest (`ruleDigest`: its JSON plus the tool-class globs it uses): an edited rule raises again.
 *   create  a relaxation: `settings_relax` step-up bound to {rule, group, hours, reason digest}; at most 1 to 720 hours
 *           (the database caps the row at 30 days); the rule must exist in the active pack; at most
 *           SUPPRESSION_LIMITS.active unexpired suppressions at once; one per (rule, group). Audited.
 *   revoke  a narrowing (no step-up), through DETECTION_SUPPRESSION_MACHINE and `whereFrom`. Audited.
 *   expire  derived from `expires_at`; nothing is written when a suppression lapses.
 *
 * One deployment is one tenant (ADR-0041); the table's RLS keeps it to admins and the sweep (`system_task`).
 */
import { and, auditLog, detectionSuppressions, eq, gt, sql, type Db } from "@regulait/db";
import { DETECTION_SUPPRESSION_MACHINE } from "@regulait/shared";
import { whereFrom } from "../state-transition.js";
import type { DetectionMatch } from "./engine.js";
import { ruleDigest, type DetectionPack } from "./pack.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const SUPPRESSION_LIMITS = { active: 200, hoursMax: 720, reasonMax: 500 } as const;

export const SUPPRESSION_RULE_IDS = {
  created: "detection-suppression-created",
  revoked: "detection-suppression-revoked",
  suppressed: "detection-suppressed",
} as const;

/** the derived state a reader sees: `expired` is never stored */
export function suppressionState(row: { status: "active" | "revoked"; expiresAt: Date }, now = new Date()): "active" | "revoked" | "expired" {
  if (row.status === "active" && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return row.status;
}

export function describeSuppression(row: { status: "active" | "revoked"; expiresAt: Date }, now = new Date()) {
  const state = suppressionState(row, now);
  return {
    state,
    lifecycle: DETECTION_SUPPRESSION_MACHINE.describe(row.status, state === "expired" ? { revoke: "the suppression has expired, so it already suppresses nothing" } : {}),
  };
}

export interface SuppressedMatch {
  suppressionId: string;
  ruleId: string;
  group: string;
  triggerSeq: number;
}

/**
 * Split a batch's matches into those to raise and those an active, unexpired suppression covers. One query per
 * batch, bounded by the groups the batch touched.
 */
export async function splitSuppressed(
  db: Pick<Db, "select">,
  pack: DetectionPack,
  matches: DetectionMatch[],
): Promise<{ kept: DetectionMatch[]; suppressed: SuppressedMatch[] }> {
  if (matches.length === 0) return { kept: matches, suppressed: [] };
  const groups = [...new Set(matches.map((m) => m.group))];
  const active = await db
    .select({
      id: detectionSuppressions.id,
      ruleId: detectionSuppressions.ruleId,
      groupKey: detectionSuppressions.groupKey,
      ruleDigest: detectionSuppressions.ruleDigest,
      createdBy: detectionSuppressions.createdBy,
    })
    .from(detectionSuppressions)
    .where(
      and(
        eq(detectionSuppressions.status, "active"),
        gt(detectionSuppressions.expiresAt, sql`now()`),
        sql`${detectionSuppressions.groupKey} = ANY(ARRAY[${sql.join(groups.map((g) => sql`${g}`), sql`, `)}]::text[])`,
      ),
    );
  if (active.length === 0) return { kept: matches, suppressed: [] };
  const by = new Map(active.map((s) => [`${s.ruleId}\u0000${s.groupKey}`, s]));
  const digests = new Map<string, string>();
  const digestOf = (m: DetectionMatch) => {
    const known = digests.get(m.rule.id);
    if (known) return known;
    const d = ruleDigest(pack, m.rule);
    digests.set(m.rule.id, d);
    return d;
  };
  const kept: DetectionMatch[] = [];
  const suppressed: SuppressedMatch[] = [];
  for (const m of matches) {
    const s = by.get(`${m.rule.id}\u0000${m.group}`);
    const applies =
      s !== undefined &&
      // review of #1157 [2]: only the rule as it was when suppressed; an edited rule raises again
      s.ruleDigest === digestOf(m) &&
      // review of #1157 [1], defence in depth: a suppression never covers the creating admin's own calls
      (s.createdBy === null || m.trigger.userId !== s.createdBy);
    if (applies) suppressed.push({ suppressionId: s.id, ruleId: m.rule.id, group: m.group, triggerSeq: m.trigger.seq });
    else kept.push(m);
  }
  return { kept, suppressed };
}

/** One audit row per suppression that held back matches in this batch (in the batch's transaction). */
export async function auditSuppressed(tx: Db, actorUserId: string, suppressed: SuppressedMatch[], historical: boolean): Promise<void> {
  if (suppressed.length === 0) return;
  const per = new Map<string, SuppressedMatch[]>();
  for (const s of suppressed) per.set(s.suppressionId, [...(per.get(s.suppressionId) ?? []), s]);
  await tx.insert(auditLog).values(
    [...per.entries()].map(([id, list]) => ({
      userId: actorUserId,
      objectType: "detection_suppression" as const,
      objectId: id,
      detail: {
        subsystem: "agent-detection",
        adr: "0333",
        rule: list[0]!.ruleId,
        group: list[0]!.group,
        suppressedMatches: list.length,
        triggerSeqs: list.slice(0, 20).map((s) => s.triggerSeq),
        historical,
      },
      // the rule fired and nothing was raised: allow, recorded so the suppression's effect is visible
      effect: "allow" as const,
      ruleId: SUPPRESSION_RULE_IDS.suppressed,
      ruleChain: [],
      reason: `Detection rule ${list[0]!.ruleId} matched ${list.length} time(s) under an active suppression; no incident raised`,
    })),
  );
}

export type CreateSuppressionOutcome =
  | { ok: true; row: typeof detectionSuppressions.$inferSelect }
  | { ok: false; status: 409 | 422; code: "suppression_exists" | "suppression_limit" | "unknown_rule"; detail: string };

/** Create one suppression (the route has checked the admin, the pack rule and spent the step-up). */
export async function createSuppression(
  db: Db,
  args: { ruleId: string; groupKey: string; hours: number; reason: string; ruleDigest: string; actorUserId: string; stepUp: string },
): Promise<CreateSuppressionOutcome> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    // one writer at a time, so the cap and the one-per-(rule, group) check cannot race
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('detection_suppressions'))`);
    const live = await tx
      .select({ id: detectionSuppressions.id, ruleId: detectionSuppressions.ruleId, groupKey: detectionSuppressions.groupKey })
      .from(detectionSuppressions)
      .where(and(eq(detectionSuppressions.status, "active"), gt(detectionSuppressions.expiresAt, sql`now()`)));
    if (live.some((s) => s.ruleId === args.ruleId && s.groupKey === args.groupKey)) {
      return { ok: false as const, status: 409 as const, code: "suppression_exists" as const, detail: "an active suppression already covers this rule and group; revoke it first" };
    }
    if (live.length >= SUPPRESSION_LIMITS.active) {
      return { ok: false as const, status: 409 as const, code: "suppression_limit" as const, detail: `at most ${SUPPRESSION_LIMITS.active} suppressions may be active at once` };
    }
    const [row] = await tx
      .insert(detectionSuppressions)
      .values({
        ruleId: args.ruleId,
        groupKey: args.groupKey,
        reason: args.reason,
        ruleDigest: args.ruleDigest,
        expiresAt: sql`now() + make_interval(hours => ${args.hours})`,
        createdBy: args.actorUserId,
        createStepUp: args.stepUp,
      })
      .returning();
    await tx.insert(auditLog).values({
      userId: args.actorUserId,
      objectType: "detection_suppression",
      objectId: row!.id,
      detail: { subsystem: "agent-detection", adr: "0333", rule: args.ruleId, ruleDigest: args.ruleDigest, group: args.groupKey, hours: args.hours, expiresAt: row!.expiresAt.toISOString(), stepUp: args.stepUp },
      effect: "allow",
      ruleId: SUPPRESSION_RULE_IDS.created,
      ruleChain: [],
      reason: `A detection suppression was created for rule ${args.ruleId} (a relaxation, after a step-up)`,
    });
    return { ok: true as const, row: row! };
  });
}

/** Revoke one suppression early. Narrowing: no step-up. Returns null when none is active with that id. */
export async function revokeSuppression(db: Db, args: { id: string; actorUserId: string | null }): Promise<typeof detectionSuppressions.$inferSelect | null> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [row] = await tx
      .update(detectionSuppressions)
      .set({ status: "revoked", revokedAt: sql`now()`, revokedBy: args.actorUserId })
      .where(
        and(
          eq(detectionSuppressions.id, args.id),
          whereFrom(detectionSuppressions.status, DETECTION_SUPPRESSION_MACHINE, "revoke"),
          // an expired suppression already suppresses nothing; revoking it would only rewrite its history
          gt(detectionSuppressions.expiresAt, sql`now()`),
        ),
      )
      .returning();
    if (!row) return null;
    await tx.insert(auditLog).values({
      userId: args.actorUserId ?? NIL_UUID,
      objectType: "detection_suppression",
      objectId: row.id,
      detail: { subsystem: "agent-detection", adr: "0333", rule: row.ruleId, group: row.groupKey },
      effect: "deny",
      ruleId: SUPPRESSION_RULE_IDS.revoked,
      ruleChain: [],
      reason: `A detection suppression for rule ${row.ruleId} was revoked; the rule raises incidents for that group again`,
    });
    return row;
  });
}
