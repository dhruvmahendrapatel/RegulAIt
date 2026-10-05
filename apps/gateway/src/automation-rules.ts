/**
 * ADR-0173 batch 2c (K) — AUTOMATION RULES over traces, and RETENTION HOLDS.
 *
 *   GET    /v1/automation-rules                      rules, with today's and total match counts
 *   POST   /v1/automation-rules                      create (the caller becomes the author)
 *   PATCH  /v1/automation-rules/:ruleId              edit, pause or resume
 *   DELETE /v1/automation-rules/:ruleId              delete (its match log goes with it)
 *   POST   /v1/automation-rules/:ruleId/backfill     explicit backfill, at most 7 days
 *   GET    /v1/automation-rules/:ruleId/matches      the match log
 *   POST   /v1/automation-rules/sweep                run one pass now
 *   GET    /v1/retention-holds                       holds (by trace or by the trace's person)
 *   POST   /v1/retention-holds/release               release holds; reason `erasure` or `admin`
 *
 * All admin-only (none is in NON_ADMIN_ROUTES): a rule acts on every user's
 * traces, so writing one is a policy act.
 *
 * THE SWEEP (`runAutomationRuleSweep`, the `automation-rule-sweep` scheduler
 * job and the sweep route). For each ACTIVE rule:
 *   1. The author must still be an active admin. Otherwise the rule is
 *      PAUSED (audited, `automation.rule.paused`), never run as somebody else.
 *   2. Matches left in `retry` (older than a 5-minute lease) re-run ONLY their
 *      pending or failed-and-retryable actions, up to 3 attempts per action.
 *   3. Traces that ENDED after the rule's keyset cursor, under the rule's
 *      filter (the shared trace filter, unscoped — the author is an admin),
 *      oldest first. Each is SAMPLED by `sha256(ruleId:traceId)` (shared
 *      `automationSampled`), so a trace gets the same answer on every pass.
 *   3b. LATE ARRIVALS. A rule whose filter reads a tag, a score or the flag
 *      (all of which land after the trace ends) also re-reads, behind its
 *      cursor, the traces that ended in the last 24 hours (never before the
 *      rule existed) that now match, are sampled and are not matched yet
 *      (`automationLateArrivalsQuery`). Older late arrivals need a backfill.
 *   4. A sampled trace is CLAIMED by inserting its (rule, trace) match; the
 *      unique index makes a re-run, an overlapping backfill or a concurrent
 *      pass a no-op, so no action ever runs twice for one trace.
 *   5. The actions run AS THE AUTHOR through the injected
 *      `AutomationActionDeps`, each outcome recorded with a fixed reason code
 *      (never error text). `automation.matched` goes to every subscription
 *      selecting it; a final failure emits `automation.action.failed`.
 * Bounds: 500 traces and 45 s per pass across all rules, and a per-rule daily
 * cap on matches acted on (UTC day). The cursor never moves past a trace the
 * pass did not decide, so a capped or truncated rule resumes where it stopped.
 *
 * NEVER SILENT. A new rule's cursor is its creation time: it matches nothing
 * that ended before it existed. Reaching back is an explicit, audited
 * backfill of at most 7 days; its matches are marked `backfill`.
 *
 * RETENTION HOLDS (owner decision, 2026-10-05). The `retention` action holds a
 * trace for `days` from its start, at most twice the §8.3 floor and at most
 * three years (a larger request is refused, never clamped). The prune
 * (`runAuditPruneOnce`) skips a live hold and deletes the trace once the hold
 * expires. An ERASURE REQUEST ALWAYS RELEASES A HOLD, audited per hold, and a
 * hold released for erasure is never re-applied. The product has no
 * data-subject erasure workflow yet (no DSAR / erasure path exists in the
 * gateway, and no user is ever flagged as erased: ADR-0022 deactivates, never
 * deletes), so `releaseRetentionHoldsForErasure` is the primitive that
 * workflow must call, and `POST /v1/retention-holds/release` with
 * `reason: "erasure"` is how an admin acts on a request today.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  automationMatches,
  automationRules,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  sql,
  traceRetentionHolds,
  traceSpans,
  traces,
  users,
  webhookDeliveries,
  webhookSubscriptions,
  type AutomationActionResult,
  type AutomationRuleRow,
  type Db,
} from "@regulait/db";
import {
  AUTOMATION_LIMITS,
  automationBackfillSchema,
  automationFilterIsPostHoc,
  automationFilterSchema,
  automationRuleCreateSchema,
  automationRuleUpdateSchema,
  automationSampled,
  maxRetentionHoldDays,
  retentionHoldUntil,
  type AutomationAction,
  type AutomationFailureCode,
  type WebhookEventName,
} from "@regulait/shared";
import { traceFilterConditions } from "./trace-scores.js";
import { enqueueWebhookEvent, kickWebhookDeliveries } from "./outbound-webhooks.js";
import { retentionFloorDays } from "./org-settings.js";
import { enqueueAnnotationItems } from "./annotations.js";
import { addTracesToDataset } from "./eval-dataset-sources.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 86_400_000;
/** a match left in `retry` is retried only after this, so the pass that
 * created it (at most 45 s) has long finished with it */
const RETRY_LEASE_MS = 5 * 60_000;
const RETRIES_PER_RULE = 50;

export const AUTOMATION_AUDIT_RULE_IDS = {
  created: "automation-rule-created",
  updated: "automation-rule-updated",
  deleted: "automation-rule-deleted",
  paused: "automation-rule-paused",
  resumed: "automation-rule-resumed",
  backfill: "automation-rule-backfill",
  matched: "automation-rule-matched",
  retried: "automation-action-retried",
  sweep: "automation-sweep-run",
  holdExtended: "trace-retention-extended",
  holdReleased: "trace-retention-hold-released",
} as const;

// ---------------------------------------------------------------------------
// THE ACTION SEAM
// ---------------------------------------------------------------------------

/** what every action receives */
export interface AutomationActionInput {
  ruleId: string;
  ruleName: string;
  matchId: string;
  traceId: string;
  /** the rule's author: every action runs as this person (an active admin, checked before the pass) */
  actorUserId: string;
  now: Date;
}

export type AutomationActionOutcome =
  | { ok: true }
  | { ok: false; reason: AutomationFailureCode; retryable: boolean };

/**
 * THE INJECTED ACTIONS. Tests pass fakes; production builds them with
 * `automationActionDeps` (see `productionAutomationActionDeps`, the one
 * wiring point). Each must be idempotent for one (rule, trace): the sweep
 * may retry a failed action, never one that succeeded.
 */
export interface AutomationActionDeps {
  /** send the trace to an annotation queue (Q's `enqueueAnnotationItems`) */
  enqueueToQueue(db: Db, a: AutomationActionInput & { queueId: string }): Promise<AutomationActionOutcome>;
  /** add the trace's model-call spans to a dataset (E's `addTracesToDataset`) */
  addToDataset(db: Db, a: AutomationActionInput & { datasetId: string }): Promise<AutomationActionOutcome>;
  /** deliver `automation.matched` to ONE subscription. `alreadyDelivered` = the
   * normal fan-out of this match already enqueued a delivery to it. */
  sendWebhook(
    db: Db,
    a: AutomationActionInput & { subscriptionId: string; payload: Record<string, unknown>; alreadyDelivered: boolean },
  ): Promise<AutomationActionOutcome>;
  /** hold the trace for `days` from its start (bounded; see `placeRetentionHold`) */
  extendRetention(db: Db, a: AutomationActionInput & { days: number }): Promise<AutomationActionOutcome>;
}

/** Q's export. `ruleId` lands on the item, its audit row and `trace.queued`;
 * the returned `deliveryIds` are pending `trace.queued` deliveries the caller
 * kicks (Q enqueues them inside its transaction). */
export type EnqueueAnnotationItemsFn = (
  db: Db,
  a: { queueId: string; subjects: Array<{ kind: "trace"; id: string }>; actorUserId: string; ruleId: string },
) => Promise<{ added: number; skipped: Array<{ id: string; reason: string }>; deliveryIds?: string[] | undefined }>;
/** E's export. `ruleId` lands on its audit row and `trace.added_to_dataset`;
 * `dataKey` signs the deliveries it kicks (without it every attempt fails
 * unsigned and is spent). */
export type AddTracesToDatasetFn = (
  db: Db,
  a: { datasetId: string; spanIds: string[]; actorUserId: string; ruleId: string; dataKey: string | undefined },
) => Promise<{ added: number; skipped: Array<{ id: string; reason: string }> }>;

/** a skip reason from Q or E, as an outcome. "Already there" is success: the action is idempotent. */
export function outcomeFromSkip(reason: string): AutomationActionOutcome {
  const r = reason.toLowerCase();
  if (/duplicate|already|exists/.test(r)) return { ok: true };
  if (/frozen/.test(r)) return { ok: false, reason: "target_frozen", retryable: false };
  if (/withheld|empty|no_content|pruned/.test(r)) return { ok: false, reason: "content_withheld", retryable: false };
  if (/not_found|missing|unknown|gone/.test(r)) return { ok: false, reason: "target_not_found", retryable: false };
  if (/self|permit|forbidden|denied|reviewer|admin/.test(r)) return { ok: false, reason: "not_permitted", retryable: false };
  return { ok: false, reason: "internal_error", retryable: false };
}

/** a thrown error from a dependency, as an outcome (never its text) */
export function outcomeFromError(err: unknown): AutomationActionOutcome {
  const status = (err as { statusCode?: number; status?: number })?.statusCode ?? (err as { status?: number })?.status;
  if (status === 404) return { ok: false, reason: "target_not_found", retryable: false };
  if (status === 403) return { ok: false, reason: "not_permitted", retryable: false };
  if (status === 409 || status === 422) return { ok: false, reason: "target_frozen", retryable: false };
  return { ok: false, reason: "internal_error", retryable: true };
}

/** the trace's model-call spans: what "add this trace to a dataset" adds */
export async function datasetSpanIdsForTrace(db: Db, traceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: traceSpans.id })
    .from(traceSpans)
    .where(and(eq(traceSpans.traceId, traceId), inArray(traceSpans.kind, ["llm", "fallback_hop"])))
    .orderBy(asc(traceSpans.seq));
  return rows.map((r) => r.id);
}

/**
 * Build the action deps. `sendWebhook` and `extendRetention` are real here;
 * the queue and dataset actions need Q's and E's functions and answer
 * `action_unavailable` until they are passed.
 */
export function automationActionDeps(
  opts: {
    dataKey?: string | undefined;
    enqueueAnnotationItems?: EnqueueAnnotationItemsFn | undefined;
    addTracesToDataset?: AddTracesToDatasetFn | undefined;
  } = {},
): AutomationActionDeps {
  return {
    async enqueueToQueue(db, a) {
      if (!opts.enqueueAnnotationItems) return { ok: false, reason: "action_unavailable", retryable: false };
      const r = await opts.enqueueAnnotationItems(db, {
        queueId: a.queueId,
        subjects: [{ kind: "trace", id: a.traceId }],
        actorUserId: a.actorUserId,
        ruleId: a.ruleId,
      });
      // Q enqueues `trace.queued` in its transaction and leaves the kick to its caller
      if (r.deliveryIds?.length) kickWebhookDeliveries(db, opts.dataKey, r.deliveryIds);
      if (r.added > 0) return { ok: true };
      return r.skipped[0] ? outcomeFromSkip(r.skipped[0].reason) : { ok: true };
    },
    async addToDataset(db, a) {
      if (!opts.addTracesToDataset) return { ok: false, reason: "action_unavailable", retryable: false };
      const spanIds = await datasetSpanIdsForTrace(db, a.traceId);
      if (!spanIds.length) return { ok: false, reason: "no_eligible_spans", retryable: false };
      const r = await opts.addTracesToDataset(db, {
        datasetId: a.datasetId,
        spanIds,
        actorUserId: a.actorUserId,
        ruleId: a.ruleId,
        dataKey: opts.dataKey,
      });
      if (r.added > 0) return { ok: true };
      return r.skipped[0] ? outcomeFromSkip(r.skipped[0].reason) : { ok: true };
    },
    async sendWebhook(db, a) {
      if (a.alreadyDelivered) return { ok: true };
      const ids = await enqueueWebhookEvent(db, "automation.matched", a.payload, a.now, { onlySubscriptionId: a.subscriptionId });
      // F's contract: an empty result means the target is gone or inactive
      if (!ids.length) return { ok: false, reason: "target_inactive", retryable: false };
      kickWebhookDeliveries(db, opts.dataKey, ids);
      return { ok: true };
    },
    async extendRetention(db, a) {
      const r = await placeRetentionHold(db, {
        traceId: a.traceId,
        days: a.days,
        ruleId: a.ruleId,
        actorUserId: a.actorUserId,
        now: a.now,
        dataKey: opts.dataKey,
      });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason, retryable: false };
    },
  };
}

/**
 * THE ONE WIRING POINT for production (the app's routes and the scheduler job
 * both call this). The integrator passes Q's `enqueueAnnotationItems` and E's
 * `addTracesToDataset` here; until then those two actions record
 * `action_unavailable`.
 */
export function productionAutomationActionDeps(dataKey?: string): AutomationActionDeps {
  // the integrator's wiring (ADR-0173 batch 2c): Q's queue enqueue and E's
  // dataset-from-traces, behind the same adapters the tests drive with fakes
  return automationActionDeps({
    dataKey,
    enqueueAnnotationItems,
    // E's call can also fail as a whole (unknown or frozen dataset, bad body):
    // that becomes a single skip whose fixed error code `outcomeFromSkip` maps
    addTracesToDataset: async (db, a) => {
      const r = await addTracesToDataset(db, a);
      return r.ok ? { added: r.added, skipped: r.skipped } : { added: 0, skipped: [{ id: a.datasetId, reason: r.error }] };
    },
  });
}

// ---------------------------------------------------------------------------
// retention holds
// ---------------------------------------------------------------------------

export type PlaceHoldResult =
  | { ok: true; holdUntil: Date; previousHoldUntil: Date | null; changed: boolean }
  | { ok: false; reason: "target_not_found" | "no_retention_floor" | "hold_exceeds_bound" | "erasure_released"; maxDays?: number | null };

/**
 * Hold one trace for `days` from its start. Refused (never clamped) above
 * min(2x the §8.3 floor, 3 years), refused with no floor (nothing is pruned),
 * and refused for a trace whose hold an erasure request released. A shorter
 * request never shortens an existing hold. Audited and announced
 * (`trace.retention_extended`) only when the hold actually moved.
 */
export async function placeRetentionHold(
  db: Db,
  a: { traceId: string; days: number; ruleId: string | null; actorUserId: string; now: Date; dataKey?: string | undefined; floorDays?: number | null },
): Promise<PlaceHoldResult> {
  const [t] = await db.select({ startedAt: traces.startedAt }).from(traces).where(eq(traces.id, a.traceId));
  if (!t) return { ok: false, reason: "target_not_found" };
  const floor = a.floorDays !== undefined ? a.floorDays : await retentionFloorDays(db);
  const bound = retentionHoldUntil(t.startedAt, a.days, floor);
  if (!bound.ok) return { ok: false, reason: bound.reason, maxDays: bound.maxDays };
  const [prior] = await db.select().from(traceRetentionHolds).where(eq(traceRetentionHolds.traceId, a.traceId));
  if (prior?.releaseReason === "erasure") return { ok: false, reason: "erasure_released" };
  const previousHoldUntil = prior && prior.releasedAt === null ? prior.holdUntil : null;
  const [row] = await db
    .insert(traceRetentionHolds)
    .values({ traceId: a.traceId, holdUntil: bound.holdUntil, ruleId: a.ruleId, createdByUserId: a.actorUserId })
    .onConflictDoUpdate({
      target: traceRetentionHolds.traceId,
      set: {
        holdUntil: sql`case when ${traceRetentionHolds.releasedAt} is null then greatest(${traceRetentionHolds.holdUntil}, excluded.hold_until) else excluded.hold_until end`,
        ruleId: a.ruleId,
        createdByUserId: a.actorUserId,
        updatedAt: a.now,
        releasedAt: null,
        releasedByUserId: null,
        releaseReason: null,
      },
      // an erasure release that landed after the read above still wins
      setWhere: sql`${traceRetentionHolds.releaseReason} is distinct from 'erasure'`,
    })
    .returning({ holdUntil: traceRetentionHolds.holdUntil });
  if (!row) return { ok: false, reason: "erasure_released" };
  const changed = previousHoldUntil === null || row.holdUntil.getTime() !== previousHoldUntil.getTime();
  if (changed) {
    await db.insert(auditLog).values({
      userId: a.actorUserId,
      objectType: "trace",
      objectId: a.traceId,
      detail: {
        holdUntil: row.holdUntil.toISOString(),
        previousHoldUntil: previousHoldUntil?.toISOString() ?? null,
        days: a.days,
        floorDays: floor,
        ruleId: a.ruleId,
      },
      effect: "allow",
      ruleId: AUTOMATION_AUDIT_RULE_IDS.holdExtended,
      ruleChain: [],
      reason: `trace retention held until ${row.holdUntil.toISOString()} (at most ${maxRetentionHoldDays(floor)} days under a ${floor}-day floor)`,
    });
    const ids = await enqueueWebhookEvent(
      db,
      "trace.retention_extended",
      {
        traceId: a.traceId,
        holdUntil: row.holdUntil.toISOString(),
        previousHoldUntil: previousHoldUntil?.toISOString() ?? null,
        extendedByUserId: a.actorUserId,
        ruleId: a.ruleId,
      },
      a.now,
    );
    kickWebhookDeliveries(db, a.dataKey, ids);
  }
  return { ok: true, holdUntil: row.holdUntil, previousHoldUntil, changed };
}

/**
 * ERASURE ALWAYS WINS. Release every live hold on every trace of the named
 * person (erasure), or on the named traces or person (an admin release);
 * audited one row per hold. A hold released for erasure is never re-applied
 * by a rule (`placeRetentionHold` refuses), so an ERASURE release is scoped to
 * a PERSON, never to a hand-picked list of trace ids: an erasure request is
 * about someone, and "erasure" on arbitrary traces would permanently disarm
 * holds on other people's traces. This is the primitive a data-subject
 * erasure workflow calls.
 */
export type ReleaseRetentionHoldsInput = { reference: string; actorUserId: string | null; now?: Date } & (
  | { reason: "erasure"; userId: string; traceIds?: undefined }
  | { reason: "admin"; userId?: string | undefined; traceIds?: string[] | undefined }
);

export async function releaseRetentionHolds(db: Db, a: ReleaseRetentionHoldsInput): Promise<{ released: number; traceIds: string[] }> {
  const now = a.now ?? new Date();
  if (a.reason === "erasure" && (!a.userId || a.traceIds !== undefined)) {
    throw new Error("an erasure release names the person (userId), never trace ids");
  }
  const scope = a.traceIds?.length
    ? inArray(traceRetentionHolds.traceId, a.traceIds)
    : a.userId
      ? sql`${traceRetentionHolds.traceId} in (select ${traces.id} from ${traces} where ${traces.userId} = ${a.userId})`
      : sql`false`;
  const rows = await db
    .update(traceRetentionHolds)
    .set({ releasedAt: now, releasedByUserId: a.actorUserId, releaseReason: a.reason, updatedAt: now })
    .where(and(scope, a.reason === "erasure" ? sql`${traceRetentionHolds.releaseReason} is distinct from 'erasure'` : isNull(traceRetentionHolds.releasedAt)))
    .returning({ traceId: traceRetentionHolds.traceId, holdUntil: traceRetentionHolds.holdUntil });
  for (const r of rows) {
    await db.insert(auditLog).values({
      userId: a.actorUserId ?? NIL_USER,
      objectType: "trace",
      objectId: r.traceId,
      detail: { reason: a.reason, reference: a.reference, holdUntil: r.holdUntil.toISOString(), ...(a.userId ? { subjectUserId: a.userId } : {}) },
      effect: "allow",
      ruleId: AUTOMATION_AUDIT_RULE_IDS.holdReleased,
      ruleChain: [],
      reason:
        a.reason === "erasure"
          ? `retention hold released by an erasure request (${a.reference}); the trace now follows the normal retention floor`
          : `retention hold released by an admin (${a.reference})`,
    });
  }
  return { released: rows.length, traceIds: rows.map((r) => r.traceId) };
}

/** convenience for an erasure workflow: every hold on this person's traces */
export function releaseRetentionHoldsForErasure(
  db: Db,
  a: { userId: string; reference: string; actorUserId: string | null; now?: Date },
): Promise<{ released: number; traceIds: string[] }> {
  return releaseRetentionHolds(db, { userId: a.userId, reason: "erasure", reference: a.reference, actorUserId: a.actorUserId, ...(a.now ? { now: a.now } : {}) });
}

// ---------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------

export interface AutomationSweepResult {
  rules: number;
  examined: number;
  matched: number;
  actionsOk: number;
  actionsFailed: number;
  retried: number;
  paused: string[];
  capped: string[];
  /** the pass hit its trace or time budget; the cursor resumes where it stopped */
  truncated: boolean;
}

export interface AutomationSweepOptions {
  now?: Date;
  dataKey?: string | undefined;
  /** default AUTOMATION_LIMITS.tracesPerPass */
  maxTraces?: number;
  /** default AUTOMATION_LIMITS.passBudgetMs */
  budgetMs?: number;
  /** TEST SEAM: the clock the time budget reads. Absent in production. */
  clock?: () => number;
  /** run this one rule only (the sweep route may name one) */
  ruleId?: string;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function authorStanding(db: Db, userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [u] = await db.select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId));
  if (!u) return { ok: false, reason: "author_not_found" };
  if (u.disabledAt) return { ok: false, reason: "author_deactivated" };
  if (!u.isAdmin) return { ok: false, reason: "author_not_admin" };
  return { ok: true };
}

export async function pauseAutomationRule(
  db: Db,
  rule: Pick<AutomationRuleRow, "id" | "name" | "authorUserId">,
  reason: string,
  pausedByUserId: string | null,
  now: Date,
  dataKey?: string,
): Promise<boolean> {
  const [r] = await db
    .update(automationRules)
    .set({ status: "paused", pausedReason: reason, pausedAt: now, updatedAt: now })
    .where(and(eq(automationRules.id, rule.id), eq(automationRules.status, "active")))
    .returning({ id: automationRules.id });
  if (!r) return false;
  await db.insert(auditLog).values({
    userId: pausedByUserId ?? NIL_USER,
    objectType: "automation_rule",
    objectId: rule.id,
    detail: { reason, authorUserId: rule.authorUserId, automatic: pausedByUserId === null },
    effect: pausedByUserId === null ? "deny" : "allow",
    ruleId: AUTOMATION_AUDIT_RULE_IDS.paused,
    ruleChain: [],
    reason:
      pausedByUserId === null
        ? `automation rule '${rule.name}' paused automatically: ${reason.replace(/_/g, " ")} (actions run as the author, who must be an active admin)`
        : `automation rule '${rule.name}' paused`,
  });
  const ids = await enqueueWebhookEvent(
    db,
    "automation.rule.paused",
    { ruleId: rule.id, ruleName: rule.name, reason, authorUserId: rule.authorUserId, pausedByUserId, pausedAt: now.toISOString() },
    now,
  );
  kickWebhookDeliveries(db, dataKey, ids);
  return true;
}

function matchStatus(results: AutomationActionResult[]): "done" | "retry" | "failed" {
  if (results.some((r) => r.status === "pending" || (r.status === "failed" && r.retryable))) return "retry";
  if (results.some((r) => r.status === "failed")) return "failed";
  return "done";
}

/** run the not-yet-done actions of one match, as the author; returns the new results */
async function runMatchActions(
  db: Db,
  deps: AutomationActionDeps,
  rule: AutomationRuleRow,
  matchId: string,
  traceId: string,
  results: AutomationActionResult[],
  fannedOutTo: ReadonlySet<string>,
  now: Date,
  dataKey: string | undefined,
): Promise<AutomationActionResult[]> {
  const actions = rule.actions as unknown as AutomationAction[];
  const base: AutomationActionInput = { ruleId: rule.id, ruleName: rule.name, matchId, traceId, actorUserId: rule.authorUserId, now };
  const payload = {
    ruleId: rule.id,
    ruleName: rule.name,
    matchId,
    traceId,
    actions: actions.map((x) => x.type),
    matchedAt: now.toISOString(),
  };
  const out: AutomationActionResult[] = [];
  for (const [i, action] of actions.entries()) {
    const prior = results[i] ?? { type: action.type, status: "pending" as const, reason: null, attempts: 0, retryable: true };
    const due = prior.status === "pending" || (prior.status === "failed" && prior.retryable);
    if (!due) {
      out.push(prior);
      continue;
    }
    let outcome: AutomationActionOutcome;
    try {
      switch (action.type) {
        case "queue":
          outcome = await deps.enqueueToQueue(db, { ...base, queueId: action.queueId });
          break;
        case "dataset":
          outcome = await deps.addToDataset(db, { ...base, datasetId: action.datasetId });
          break;
        case "webhook":
          outcome = await deps.sendWebhook(db, {
            ...base,
            subscriptionId: action.subscriptionId,
            payload,
            alreadyDelivered: fannedOutTo.has(action.subscriptionId),
          });
          break;
        case "retention":
          outcome = await deps.extendRetention(db, { ...base, days: action.days });
          break;
      }
    } catch (err) {
      outcome = outcomeFromError(err);
    }
    const attempts = prior.attempts + 1;
    const next: AutomationActionResult = outcome.ok
      ? { type: action.type, status: "ok", reason: null, attempts, retryable: false }
      : {
          type: action.type,
          status: "failed",
          reason: outcome.reason,
          attempts,
          retryable: outcome.retryable && attempts < AUTOMATION_LIMITS.maxAttempts,
        };
    out.push(next);
    if (next.status === "failed" && !next.retryable) {
      const ids = await enqueueWebhookEvent(
        db,
        "automation.action.failed",
        { ruleId: rule.id, ruleName: rule.name, matchId, traceId, action: action.type, reason: next.reason, attempts },
        now,
      );
      kickWebhookDeliveries(db, dataKey, ids);
    }
  }
  return out;
}

async function recordMatchResults(
  db: Db,
  rule: AutomationRuleRow,
  matchId: string,
  traceId: string,
  results: AutomationActionResult[],
  attempts: number,
  retry: boolean,
): Promise<void> {
  const status = matchStatus(results);
  await db.update(automationMatches).set({ actionResults: results, status, attempts }).where(eq(automationMatches.id, matchId));
  await db.insert(auditLog).values({
    userId: rule.authorUserId,
    objectType: "automation_rule",
    objectId: rule.id,
    detail: { matchId, traceId, status, actions: results },
    effect: results.some((r) => r.status === "failed") ? "deny" : "allow",
    ruleId: retry ? AUTOMATION_AUDIT_RULE_IDS.retried : AUTOMATION_AUDIT_RULE_IDS.matched,
    ruleChain: [],
    reason:
      `automation rule '${rule.name}' ${retry ? "retried actions on" : "matched"} trace ${traceId}: ` +
      results.map((r) => `${r.type} ${r.status}${r.reason ? ` (${r.reason})` : ""}`).join(", "),
  });
}

/** claim one (rule, trace) and run its actions; `created: false` = it was already matched */
async function matchAndAct(
  db: Db,
  deps: AutomationActionDeps,
  rule: AutomationRuleRow,
  traceId: string,
  backfill: boolean,
  now: Date,
  dataKey: string | undefined,
): Promise<{ created: boolean; ok: number; failed: number }> {
  const actions = rule.actions as unknown as AutomationAction[];
  const pending: AutomationActionResult[] = actions.map((x) => ({ type: x.type, status: "pending", reason: null, attempts: 0, retryable: true }));
  const [m] = await db
    .insert(automationMatches)
    .values({ ruleId: rule.id, traceId, matchedAt: now, backfill, status: "retry", attempts: 1, actionResults: pending })
    .onConflictDoNothing({ target: [automationMatches.ruleId, automationMatches.traceId] })
    .returning({ id: automationMatches.id });
  if (!m) return { created: false, ok: 0, failed: 0 };
  // the normal fan-out of `automation.matched`; a webhook action to a
  // subscription this already reached does not send it twice
  const payload = { ruleId: rule.id, ruleName: rule.name, matchId: m.id, traceId, actions: actions.map((x) => x.type), matchedAt: now.toISOString() };
  const deliveryIds = await enqueueWebhookEvent(db, "automation.matched" satisfies WebhookEventName, payload, now);
  const fannedOutTo = new Set<string>();
  if (deliveryIds.length) {
    for (const d of await db
      .select({ subscriptionId: webhookDeliveries.subscriptionId })
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.id, deliveryIds))) {
      fannedOutTo.add(d.subscriptionId);
    }
    kickWebhookDeliveries(db, dataKey, deliveryIds);
  }
  const results = await runMatchActions(db, deps, rule, m.id, traceId, pending, fannedOutTo, now, dataKey);
  await recordMatchResults(db, rule, m.id, traceId, results, 1, false);
  return {
    created: true,
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}

/** re-run the due actions of this rule's matches left in `retry` */
async function retryMatches(
  db: Db,
  deps: AutomationActionDeps,
  rule: AutomationRuleRow,
  now: Date,
  dataKey: string | undefined,
): Promise<{ retried: number; ok: number; failed: number }> {
  const due = await db
    .select()
    .from(automationMatches)
    .where(
      and(
        eq(automationMatches.ruleId, rule.id),
        eq(automationMatches.status, "retry"),
        lt(automationMatches.matchedAt, new Date(now.getTime() - RETRY_LEASE_MS)),
      ),
    )
    .orderBy(asc(automationMatches.matchedAt))
    .limit(RETRIES_PER_RULE);
  let retried = 0;
  let ok = 0;
  let failed = 0;
  for (const m of due) {
    // claim: a concurrent pass that already took this attempt leaves it alone
    const [claimed] = await db
      .update(automationMatches)
      .set({ attempts: m.attempts + 1 })
      .where(and(eq(automationMatches.id, m.id), eq(automationMatches.status, "retry"), eq(automationMatches.attempts, m.attempts)))
      .returning({ id: automationMatches.id });
    if (!claimed) continue;
    retried += 1;
    const before = m.actionResults;
    const results = await runMatchActions(db, deps, rule, m.id, m.traceId, before, new Set(), now, dataKey);
    await recordMatchResults(db, rule, m.id, m.traceId, results, m.attempts + 1, true);
    for (const [i, r] of results.entries()) {
      if (before[i]?.status === "ok") continue;
      if (r.status === "ok") ok += 1;
      else if (r.status === "failed") failed += 1;
    }
  }
  return { retried, ok, failed };
}

/**
 * THE KEYSET EXPRESSION: a trace's end, in UTC, truncated to the millisecond a
 * JS `Date` (and so the stored cursor) can hold. Truncating keeps a trace
 * that ended at .123456 from sorting after a cursor of .123 forever.
 *
 * It is written EXACTLY as migration 0151's `traces_ended_ms_id_idx` indexes
 * it (`date_trunc('milliseconds', ended_at AT TIME ZONE 'UTC'), id`, partial
 * on `ended_at IS NOT NULL`): the `AT TIME ZONE 'UTC'` makes it immutable, so
 * it can be indexed at all, and the keyset compare and the ORDER BY then walk
 * that index instead of sorting every finished trace. Change one, change the
 * other (zz-k-automation's EXPLAIN test fails if they drift).
 */
const endedMsUtc = sql`date_trunc('milliseconds', ${traces.endedAt} at time zone 'UTC')`;
const endedMsText = sql<string>`to_char(${endedMsUtc}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const keyOf = (at: Date, id: string | null) =>
  sql`((${at.toISOString()}::timestamptz at time zone 'UTC'), ${id ?? NIL_USER}::uuid)`;

/** the keyset scan: traces that ended after the cursor, in (ended_at ms, id) order */
export function automationCandidatesQuery(
  db: Db,
  rule: Pick<AutomationRuleRow, "cursorEndedAt" | "cursorTraceId">,
  filter: z.infer<typeof automationFilterSchema>,
  now: Date,
  limit: number,
) {
  return db
    .select({ id: traces.id, endedAt: endedMsText })
    .from(traces)
    .where(
      and(
        traceFilterConditions(filter, { scopeUserId: null }),
        isNotNull(traces.endedAt),
        lte(traces.endedAt, now),
        sql`(${endedMsUtc}, ${traces.id}) > ${keyOf(rule.cursorEndedAt, rule.cursorTraceId)}`,
      ),
    )
    .orderBy(endedMsUtc, asc(traces.id))
    .limit(limit);
}

/**
 * The sampling decision in SQL, for the late-arrival rescan only: the first 8
 * bytes of `sha256("<ruleId>:<traceId>")` against `rate * 2^64`, the same
 * comparison as shared `automationSampled` (bytea compares as unsigned
 * big-endian). It only keeps traces the rule would never act on out of the
 * rescan; `automationSampled` still decides every trace. `null` = everything
 * is in the sample.
 */
function sampledInSql(ruleId: string, rate: number) {
  if (rate >= 1) return null;
  const bound = BigInt(Math.ceil(rate * 2 ** 64));
  if (bound >= 2n ** 64n) return null;
  const hex = bound.toString(16).padStart(16, "0");
  return sql`substring(sha256(convert_to(${ruleId}::text || ':' || ${traces.id}::text, 'UTF8')) from 1 for 8) < decode(${hex}, 'hex')`;
}

/**
 * LATE ARRIVALS. A tag, a score or the ADR-0160 flag lands AFTER its trace
 * ends, so the keyset scan (which only moves forward on `ended_at`) can pass a
 * trace before the thing the rule's filter reads exists. For a rule whose
 * filter reads one (`automationFilterIsPostHoc`), each pass also re-reads the
 * traces it already passed that ended in the last
 * `AUTOMATION_LIMITS.lateArrivalWindowHours` (24 h), never before the rule
 * existed, and that now match, are in its sample, and have no match yet.
 * Excluding matched and unsampled traces in SQL keeps every row this returns
 * a real new match, so the rescan cannot spend a pass re-reading the same
 * traces; the (rule, trace) unique index still makes it idempotent. Oldest
 * first; what a pass leaves (the 500-trace / 45 s / daily caps) the next one
 * picks up, because a matched trace drops out.
 */
export function automationLateArrivalsQuery(
  db: Db,
  rule: Pick<AutomationRuleRow, "id" | "samplingRate" | "createdAt">,
  cursor: { endedAt: Date; traceId: string | null },
  filter: z.infer<typeof automationFilterSchema>,
  now: Date,
  limit: number,
) {
  const windowStart = new Date(
    Math.max(now.getTime() - AUTOMATION_LIMITS.lateArrivalWindowHours * 3_600_000, rule.createdAt.getTime()),
  );
  return db
    .select({ id: traces.id, endedAt: endedMsText })
    .from(traces)
    .where(
      and(
        traceFilterConditions(filter, { scopeUserId: null }),
        isNotNull(traces.endedAt),
        lte(traces.endedAt, now),
        sql`${endedMsUtc} >= (${windowStart.toISOString()}::timestamptz at time zone 'UTC')`,
        sql`(${endedMsUtc}, ${traces.id}) <= ${keyOf(cursor.endedAt, cursor.traceId)}`,
        sampledInSql(rule.id, rule.samplingRate) ?? undefined,
        sql`not exists (select 1 from ${automationMatches} where ${automationMatches.ruleId} = ${rule.id} and ${automationMatches.traceId} = ${traces.id})`,
      ),
    )
    .orderBy(endedMsUtc, asc(traces.id))
    .limit(limit);
}

export async function runAutomationRuleSweep(
  db: Db,
  deps: AutomationActionDeps,
  opts: AutomationSweepOptions = {},
): Promise<AutomationSweepResult> {
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const maxTraces = opts.maxTraces ?? AUTOMATION_LIMITS.tracesPerPass;
  const budgetMs = opts.budgetMs ?? AUTOMATION_LIMITS.passBudgetMs;
  const overBudget = () => clock() - startedAt >= budgetMs;
  const out: AutomationSweepResult = {
    rules: 0,
    examined: 0,
    matched: 0,
    actionsOk: 0,
    actionsFailed: 0,
    retried: 0,
    paused: [],
    capped: [],
    truncated: false,
  };
  const rules = await db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.status, "active"), opts.ruleId ? eq(automationRules.id, opts.ruleId) : undefined))
    .orderBy(asc(automationRules.createdAt), asc(automationRules.id));
  const dayStart = utcDayStart(now);

  for (const rule of rules) {
    if (overBudget() || out.examined >= maxTraces) {
      out.truncated = true;
      break;
    }
    out.rules += 1;
    const standing = await authorStanding(db, rule.authorUserId);
    if (!standing.ok) {
      if (await pauseAutomationRule(db, rule, standing.reason, null, now, opts.dataKey)) out.paused.push(rule.id);
      continue;
    }
    const filter = automationFilterSchema.safeParse(rule.filter);
    if (!filter.success) {
      if (await pauseAutomationRule(db, rule, "invalid_filter", null, now, opts.dataKey)) out.paused.push(rule.id);
      continue;
    }

    const r = await retryMatches(db, deps, rule, now, opts.dataKey);
    out.retried += r.retried;
    out.actionsOk += r.ok;
    out.actionsFailed += r.failed;

    const [{ used }] = (await db
      .select({ used: count() })
      .from(automationMatches)
      .where(and(eq(automationMatches.ruleId, rule.id), gte(automationMatches.matchedAt, dayStart)))) as [{ used: number }];
    let remaining = rule.dailyActionCap - Number(used);
    if (remaining <= 0) {
      out.capped.push(rule.id);
      continue;
    }

    const limit = maxTraces - out.examined;
    const candidates = await automationCandidatesQuery(db, rule, filter.data, now, limit);
    let cursor: { endedAt: Date; traceId: string | null } = { endedAt: rule.cursorEndedAt, traceId: rule.cursorTraceId };
    let stopped = false;
    for (const t of candidates) {
      if (overBudget()) {
        out.truncated = true;
        stopped = true;
        break;
      }
      const endedAt = new Date(t.endedAt);
      if (automationSampled(rule.id, t.id, rule.samplingRate)) {
        if (remaining <= 0) {
          out.capped.push(rule.id);
          stopped = true;
          break;
        }
        const backfill = rule.backfillUntil !== null && endedAt.getTime() <= rule.backfillUntil.getTime();
        const res = await matchAndAct(db, deps, rule, t.id, backfill, now, opts.dataKey);
        if (res.created) {
          out.matched += 1;
          out.actionsOk += res.ok;
          out.actionsFailed += res.failed;
          remaining -= 1;
        }
      }
      out.examined += 1;
      cursor = { endedAt, traceId: t.id };
    }
    if (!stopped && candidates.length === limit && out.examined >= maxTraces) out.truncated = true;
    if (cursor.traceId !== rule.cursorTraceId || cursor.endedAt.getTime() !== rule.cursorEndedAt.getTime()) {
      const backfillDone = rule.backfillUntil !== null && cursor.endedAt.getTime() >= rule.backfillUntil.getTime();
      await db
        .update(automationRules)
        .set({ cursorEndedAt: cursor.endedAt, cursorTraceId: cursor.traceId, ...(backfillDone ? { backfillUntil: null } : {}) })
        .where(eq(automationRules.id, rule.id));
    }

    // LATE ARRIVALS (see automationLateArrivalsQuery): only behind the cursor,
    // inside the same pass budget and daily cap
    if (stopped || !automationFilterIsPostHoc(filter.data) || !(rule.samplingRate > 0)) continue;
    if (overBudget() || out.examined >= maxTraces) {
      out.truncated = true;
      continue;
    }
    const lateLimit = maxTraces - out.examined;
    const late = await automationLateArrivalsQuery(db, rule, cursor, filter.data, now, lateLimit);
    for (const t of late) {
      if (overBudget()) {
        out.truncated = true;
        break;
      }
      if (automationSampled(rule.id, t.id, rule.samplingRate)) {
        if (remaining <= 0) {
          out.capped.push(rule.id);
          break;
        }
        const res = await matchAndAct(db, deps, rule, t.id, false, now, opts.dataKey);
        if (res.created) {
          out.matched += 1;
          out.actionsOk += res.ok;
          out.actionsFailed += res.failed;
          remaining -= 1;
        }
      }
      out.examined += 1;
    }
    if (late.length === lateLimit && out.examined >= maxTraces) out.truncated = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const ruleIdParam = z.object({ ruleId: z.string().uuid() });
const matchesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });
const sweepBody = z.object({ ruleId: z.string().uuid().optional() }).strict().default({});
const holdsQuery = z.object({
  traceId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
/** the erasure request's or ticket's reference, kept in the audit row */
const releaseReference = z.string().trim().min(1).max(200);
/** an ERASURE release is scoped to the person (all of their traces); only an
 * admin release may name trace ids (see `releaseRetentionHolds`) */
const releaseBody = z
  .discriminatedUnion("reason", [
    z.object({ reason: z.literal("erasure"), userId: z.string().uuid(), reference: releaseReference }).strict(),
    z
      .object({
        reason: z.literal("admin"),
        userId: z.string().uuid().optional(),
        traceIds: z.array(z.string().uuid()).min(1).max(500).optional(),
        reference: releaseReference,
      })
      .strict(),
  ])
  .superRefine((b, ctx) => {
    if (b.reason === "admin" && (b.userId === undefined) === (b.traceIds === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["traceIds"], message: "name a userId or traceIds, not both" });
    }
  });

type RuleView = ReturnType<typeof ruleView>;
function ruleView(r: AutomationRuleRow, extra: { authorName: string | null; stats?: Record<string, unknown> }) {
  return {
    id: r.id,
    name: r.name,
    filter: r.filter,
    samplingRate: r.samplingRate,
    actions: r.actions,
    status: r.status,
    pausedReason: r.pausedReason,
    pausedAt: r.pausedAt?.toISOString() ?? null,
    author: { id: r.authorUserId, name: extra.authorName },
    dailyActionCap: r.dailyActionCap,
    cursorEndedAt: r.cursorEndedAt.toISOString(),
    backfillUntil: r.backfillUntil?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    ...(extra.stats ? { stats: extra.stats } : {}),
  };
}

export function registerAutomationRuleRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string | undefined; deps?: AutomationActionDeps } = {},
): void {
  const deps = opts.deps ?? productionAutomationActionDeps(opts.dataKey);
  const audit = (userId: string | null, objectId: string, ruleId: string, reason: string, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({ userId: userId ?? NIL_USER, objectType: "automation_rule", objectId, detail, effect: "allow", ruleId, ruleChain: [], reason });

  /** what a rule's actions may name, checked on write: the hold bound and the webhook target */
  async function actionProblem(actions: AutomationAction[]): Promise<{ status: number; body: Record<string, unknown> } | null> {
    const retention = actions.find((a): a is Extract<AutomationAction, { type: "retention" }> => a.type === "retention");
    if (retention) {
      const floor = await retentionFloorDays(db);
      const max = maxRetentionHoldDays(floor);
      if (max === null) {
        return {
          status: 422,
          body: {
            error: "no_retention_floor",
            detail: "no retention floor is set, so traces are never pruned and a hold has nothing to extend",
          },
        };
      }
      if (retention.days > max) {
        return {
          status: 422,
          body: {
            error: "hold_exceeds_bound",
            detail: `a hold may keep a trace at most ${max} days (twice the ${floor}-day floor, and never more than three years)`,
            maxDays: max,
          },
        };
      }
    }
    const webhook = actions.find((a): a is Extract<AutomationAction, { type: "webhook" }> => a.type === "webhook");
    if (webhook) {
      const [sub] = await db
        .select({ active: webhookSubscriptions.active })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, webhook.subscriptionId));
      if (!sub || !sub.active) {
        return { status: 422, body: { error: "webhook_target_inactive", detail: "the webhook action names no active subscription" } };
      }
    }
    return null;
  }

  app.get("/v1/automation-rules", async () => {
    const now = new Date();
    const rows = await db
      .select({ r: automationRules, authorName: users.displayName })
      .from(automationRules)
      .leftJoin(users, eq(users.id, automationRules.authorUserId))
      .orderBy(asc(automationRules.createdAt));
    const ids = rows.map((x) => x.r.id);
    const stats = new Map<string, { today: number; total: number; retrying: number; failed: number; lastMatchedAt: string | null }>();
    if (ids.length) {
      for (const s of await db
        .select({
          ruleId: automationMatches.ruleId,
          total: sql<number>`count(*)::int`,
          today: sql<number>`(count(*) filter (where ${automationMatches.matchedAt} >= ${utcDayStart(now).toISOString()}::timestamptz))::int`,
          retrying: sql<number>`(count(*) filter (where ${automationMatches.status} = 'retry'))::int`,
          failed: sql<number>`(count(*) filter (where ${automationMatches.status} = 'failed'))::int`,
          last: sql<string | null>`max(${automationMatches.matchedAt})`,
        })
        .from(automationMatches)
        .where(inArray(automationMatches.ruleId, ids))
        .groupBy(automationMatches.ruleId)) {
        stats.set(s.ruleId, {
          today: Number(s.today),
          total: Number(s.total),
          retrying: Number(s.retrying),
          failed: Number(s.failed),
          lastMatchedAt: s.last ? new Date(s.last).toISOString() : null,
        });
      }
    }
    const floor = await retentionFloorDays(db);
    return {
      rules: rows.map(({ r, authorName }): RuleView =>
        ruleView(r, { authorName, stats: stats.get(r.id) ?? { today: 0, total: 0, retrying: 0, failed: 0, lastMatchedAt: null } }),
      ),
      limits: AUTOMATION_LIMITS,
      retention: { floorDays: floor, maxHoldDays: maxRetentionHoldDays(floor) },
    };
  });

  app.post("/v1/automation-rules", async (req, reply) => {
    const userId = req.authCtx.userId ?? null;
    if (!userId) {
      return reply.status(403).send({ error: "identity_required", detail: "a rule's actions run as its author; the bootstrap token has no identity" });
    }
    const body = automationRuleCreateSchema.parse(req.body);
    const problem = await actionProblem(body.actions);
    if (problem) return reply.status(problem.status).send(problem.body);
    const now = new Date();
    const [row] = await db
      .insert(automationRules)
      .values({
        name: body.name,
        filter: body.filter as Record<string, unknown>,
        samplingRate: body.samplingRate,
        actions: body.actions as Array<Record<string, unknown>>,
        dailyActionCap: body.dailyActionCap,
        authorUserId: userId,
        // never silent: nothing that ended before the rule existed is matched
        cursorEndedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit(userId, row!.id, AUTOMATION_AUDIT_RULE_IDS.created, `automation rule '${row!.name}' created`, {
      filter: row!.filter,
      samplingRate: row!.samplingRate,
      actions: row!.actions,
      dailyActionCap: row!.dailyActionCap,
    });
    return reply.status(201).send(ruleView(row!, { authorName: null }));
  });

  app.patch("/v1/automation-rules/:ruleId", async (req, reply) => {
    const { ruleId } = ruleIdParam.parse(req.params);
    const userId = req.authCtx.userId ?? null;
    if (!userId) {
      return reply.status(403).send({ error: "identity_required", detail: "a rule's actions run as its author; the bootstrap token has no identity" });
    }
    const body = automationRuleUpdateSchema.parse(req.body);
    const [prior] = await db.select().from(automationRules).where(eq(automationRules.id, ruleId));
    if (!prior) return reply.status(404).send({ error: "not_found" });
    if (body.actions) {
      const problem = await actionProblem(body.actions);
      if (problem) return reply.status(problem.status).send(problem.body);
    }
    const now = new Date();
    // whoever changes what a rule does, or turns it back on, becomes its
    // author: from then on its actions run as them
    const takesAuthorship =
      body.filter !== undefined || body.actions !== undefined || body.samplingRate !== undefined || (body.status === "active" && prior.status === "paused");
    if (body.status === "paused" && prior.status === "active") {
      await pauseAutomationRule(db, prior, "paused_by_admin", userId, now, opts.dataKey);
    }
    const [row] = await db
      .update(automationRules)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.filter !== undefined ? { filter: body.filter as Record<string, unknown> } : {}),
        ...(body.samplingRate !== undefined ? { samplingRate: body.samplingRate } : {}),
        ...(body.actions !== undefined ? { actions: body.actions as Array<Record<string, unknown>> } : {}),
        ...(body.dailyActionCap !== undefined ? { dailyActionCap: body.dailyActionCap } : {}),
        ...(body.status === "active" ? { status: "active" as const, pausedReason: null, pausedAt: null } : {}),
        ...(takesAuthorship ? { authorUserId: userId } : {}),
        updatedAt: now,
      })
      .where(eq(automationRules.id, ruleId))
      .returning();
    const changed = Object.keys(body).filter((k) => k !== "status");
    if (changed.length || takesAuthorship) {
      await audit(userId, ruleId, AUTOMATION_AUDIT_RULE_IDS.updated, `automation rule '${row!.name}' changed`, {
        changed,
        ...(takesAuthorship && prior.authorUserId !== userId ? { previousAuthorUserId: prior.authorUserId, authorUserId: userId } : {}),
      });
    }
    if (body.status === "active" && prior.status === "paused") {
      await audit(userId, ruleId, AUTOMATION_AUDIT_RULE_IDS.resumed, `automation rule '${row!.name}' resumed`, {
        previousPausedReason: prior.pausedReason,
      });
    }
    return ruleView(row!, { authorName: null });
  });

  app.delete("/v1/automation-rules/:ruleId", async (req, reply) => {
    const { ruleId } = ruleIdParam.parse(req.params);
    const [row] = await db.delete(automationRules).where(eq(automationRules.id, ruleId)).returning();
    if (!row) return reply.status(404).send({ error: "not_found" });
    await audit(req.authCtx.userId ?? null, ruleId, AUTOMATION_AUDIT_RULE_IDS.deleted, `automation rule '${row.name}' deleted`, {
      actions: row.actions,
    });
    return { deleted: true };
  });

  app.post("/v1/automation-rules/:ruleId/backfill", async (req, reply) => {
    const { ruleId } = ruleIdParam.parse(req.params);
    const { days } = automationBackfillSchema.parse(req.body);
    const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, ruleId));
    if (!rule) return reply.status(404).send({ error: "not_found" });
    const now = new Date();
    const from = new Date(now.getTime() - days * DAY_MS);
    const rewinds = from.getTime() < rule.cursorEndedAt.getTime();
    const until = rule.backfillUntil && rule.backfillUntil > rule.cursorEndedAt ? rule.backfillUntil : rule.cursorEndedAt;
    if (rewinds) {
      await db
        .update(automationRules)
        .set({ cursorEndedAt: from, cursorTraceId: null, backfillUntil: until, updatedAt: now })
        .where(eq(automationRules.id, ruleId));
    }
    // never silent: the request is audited whether or not it moved the cursor
    await audit(req.authCtx.userId ?? null, ruleId, AUTOMATION_AUDIT_RULE_IDS.backfill, `automation rule '${rule.name}' backfill of ${days} day(s) requested`, {
      days,
      from: from.toISOString(),
      until: until.toISOString(),
      rewound: rewinds,
    });
    return {
      ruleId,
      days,
      from: from.toISOString(),
      until: until.toISOString(),
      rewound: rewinds,
      note: rewinds
        ? "Traces that ended in this window are matched on the next pass (or Run now); their matches are marked as backfill."
        : "The rule already covers this window; nothing was moved.",
    };
  });

  app.get("/v1/automation-rules/:ruleId/matches", async (req, reply) => {
    const { ruleId } = ruleIdParam.parse(req.params);
    const { limit } = matchesQuery.parse(req.query);
    const [rule] = await db.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.id, ruleId));
    if (!rule) return reply.status(404).send({ error: "not_found" });
    const rows = await db
      .select({
        id: automationMatches.id,
        traceId: automationMatches.traceId,
        traceName: traces.name,
        matchedAt: automationMatches.matchedAt,
        backfill: automationMatches.backfill,
        status: automationMatches.status,
        attempts: automationMatches.attempts,
        actionResults: automationMatches.actionResults,
      })
      .from(automationMatches)
      .leftJoin(traces, eq(traces.id, automationMatches.traceId))
      .where(eq(automationMatches.ruleId, ruleId))
      .orderBy(desc(automationMatches.matchedAt), desc(automationMatches.id))
      .limit(limit);
    return {
      matches: rows.map((m) => ({ ...m, matchedAt: m.matchedAt.toISOString() })),
    };
  });

  app.post("/v1/automation-rules/sweep", async (req) => {
    const body = sweepBody.parse(req.body ?? {});
    const out = await runAutomationRuleSweep(db, deps, { dataKey: opts.dataKey, ...(body.ruleId ? { ruleId: body.ruleId } : {}) });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_USER,
      objectType: "automation_rule",
      objectId: body.ruleId ?? null,
      detail: { ...out },
      effect: "allow",
      ruleId: AUTOMATION_AUDIT_RULE_IDS.sweep,
      ruleChain: [],
      reason: `automation sweep run by hand: ${out.matched} match(es) over ${out.examined} trace(s)`,
    });
    return out;
  });

  app.get("/v1/retention-holds", async (req) => {
    const q = holdsQuery.parse(req.query);
    const rows = await db
      .select({
        traceId: traceRetentionHolds.traceId,
        traceUserId: traces.userId,
        holdUntil: traceRetentionHolds.holdUntil,
        ruleId: traceRetentionHolds.ruleId,
        createdByUserId: traceRetentionHolds.createdByUserId,
        releasedAt: traceRetentionHolds.releasedAt,
        releaseReason: traceRetentionHolds.releaseReason,
      })
      .from(traceRetentionHolds)
      .innerJoin(traces, eq(traces.id, traceRetentionHolds.traceId))
      .where(and(q.traceId ? eq(traceRetentionHolds.traceId, q.traceId) : undefined, q.userId ? eq(traces.userId, q.userId) : undefined))
      .orderBy(desc(traceRetentionHolds.updatedAt))
      .limit(q.limit);
    const floor = await retentionFloorDays(db);
    return {
      holds: rows.map((h) => ({ ...h, holdUntil: h.holdUntil.toISOString(), releasedAt: h.releasedAt?.toISOString() ?? null })),
      retention: { floorDays: floor, maxHoldDays: maxRetentionHoldDays(floor) },
    };
  });

  app.post("/v1/retention-holds/release", async (req) => {
    const b = releaseBody.parse(req.body);
    const actorUserId = req.authCtx.userId ?? null;
    return b.reason === "erasure"
      ? releaseRetentionHolds(db, { reason: "erasure", userId: b.userId, reference: b.reference, actorUserId })
      : releaseRetentionHolds(db, { reason: "admin", userId: b.userId, traceIds: b.traceIds, reference: b.reference, actorUserId });
  });
}
