/**
 * ADR-0173 batch 2c (Q) — ANNOTATION QUEUES.
 *
 *   admin (default gate)
 *   GET    /v1/annotation-queues                         queues with counts
 *   POST   /v1/annotation-queues                         create (rubric, reviewers, N, SLA)
 *   GET    /v1/annotation-queues/:queueId                one queue, its rubric versions and reviewers
 *   PATCH  /v1/annotation-queues/:queueId                edit; a rubric edit after reviews = a new version
 *   DELETE /v1/annotation-queues/:queueId                remove the queue, its items and reviews
 *   POST   /v1/annotation-queues/:queueId/items          enqueue {subjects:[{kind,id}]} -> {added, skipped}
 *   GET    /v1/annotation-queues/:queueId/items          items (no content)
 *   DELETE /v1/annotation-queues/:queueId/items/:itemId  remove one item
 *   GET    /v1/annotation-queues/:queueId/export         CSV: ids, scores, labels, comments
 *   POST   /v1/annotation-queues/sla-sweep               run the SLA sweep now
 *
 *   a named reviewer (NON_ADMIN_ROUTES, checked in-handler)
 *   GET    /v1/annotations/inbox                         my open items (no content)
 *   GET    /v1/annotations/items/:itemId                 one item: rubric + PREVIEW
 *   POST   /v1/annotations/items/:itemId/submissions     my review
 *
 * THE OWNER'S RULE (2026-10-05). A named reviewer may read the trace PREVIEWS
 * of the items in their queue — previews only (no span attributes, no judge
 * rationale, each text cut to ANNOTATION_LIMITS.previewChars) — and every read
 * is audited. Anyone else who is not an admin gets 403 and a deny audit row.
 * Admins keep full access (the stored previews and attributes). Nobody reviews
 * their own work: the trace's person and the run's initiator (captured at
 * enqueue in `subject_user_ids`) are refused at submit.
 *
 * N-PERSON REVIEW. An item needs `required_reviews` DISTINCT reviewers and
 * completes exactly when the last one submits; a completed item is immutable.
 * Disagreement between the reviewers is recorded on the item. A submit is
 * idempotent per (item, reviewer): an identical replay returns the recorded
 * review, a different second review by the same person is 409.
 *
 * SCORES. Each submission writes one `trace_scores` row per criterion (source
 * `annotation`, `source_ref_id` = the submission) through `recordTraceScore`,
 * in the submit's transaction — names, numbers and labels only, never the
 * comment. An eval result whose run was not traced has no trace to score.
 *
 * WITHHELD AND PRUNED. Content a block or the capture setting withheld shows
 * ANNOTATION_WITHHELD_MARKER, never the stored text. Items reference their
 * subject FK-free, so once the §8.3 prune or an erasure removes it the item
 * reads ANNOTATION_NOT_RETAINED and can no longer be reviewed.
 *
 * Open source first: zod (parsing), drizzle (SQL), the repo's csv-export.ts
 * streaming loop (reused for the export). The access rule, the rubric bounds,
 * N-person completion and the SLA sweep are governance logic, so none fits.
 * The CSV cell escape adds formula neutralisation (OWASP "CSV injection") to
 * the RFC 4180 quoting the other exports use; no CSV library is an approved
 * dependency for this batch, so none fits, because adding one is out of scope.
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  annotationItems,
  annotationQueueReviewers,
  annotationQueues,
  annotationRubricVersions,
  annotationSubmissions,
  asc,
  auditLog,
  count,
  desc,
  eq,
  evalCases,
  evalResults,
  evalRuns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  orchestrationRuns,
  sql,
  traceSpans,
  traces,
  users,
  type AnnotationItemRow,
  type AnnotationQueueRow,
  type Db,
} from "@regulait/db";
import {
  ANNOTATION_LIMITS,
  ANNOTATION_NOT_RETAINED,
  ANNOTATION_WITHHELD_MARKER,
  aggregateAnnotationScores,
  annotationDisagreement,
  annotationEnqueueSchema,
  annotationQueueCreateSchema,
  annotationQueueMergedSchema,
  annotationQueueUpdateSchema,
  annotationRubricSchema,
  annotationSubmissionSchema,
  checkSubmission,
  tracePreview,
  type AnnotationRubric,
  type AnnotationSkipReason,
  type AnnotationSubject,
  type AnnotationSubjectKind,
} from "@regulait/shared";
import { recordTraceScore } from "./trace-scores.js";
import { enqueueWebhookEvent, kickWebhookDeliveries } from "./outbound-webhooks.js";
import { csvBatchRows, csvMaxRows, resolveCsvWindow, streamCsv, type CsvStreamSpec } from "./csv-export.js";
import { afterCursorDesc, atTextSql } from "./pagination.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
/** items one SLA pass marks breached */
const SLA_SWEEP_LIMIT = 500;

export const ANNOTATION_RULE_IDS = {
  queueCreated: "annotation-queue-created",
  queueUpdated: "annotation-queue-updated",
  queueDeleted: "annotation-queue-deleted",
  queueExported: "annotation-queue-exported",
  itemsQueued: "annotation-items-queued",
  itemRemoved: "annotation-item-removed",
  itemRead: "annotation-item-read",
  itemReadDenied: "annotation-item-read-denied",
  submitted: "annotation-submitted",
  submitRefused: "annotation-submit-refused",
  completed: "annotation-item-completed",
  slaBreached: "annotation-sla-breached",
  slaSweep: "annotation-sla-sweep-run",
} as const;

/** a refusal with an HTTP status and a fixed code */
export class AnnotationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Writer = Pick<Db, "insert" | "update" | "select" | "selectDistinct" | "delete" | "execute">;

async function audit(
  db: Writer,
  row: {
    userId: string | null;
    objectType: "annotation_queue" | "annotation_item";
    objectId: string | null;
    ruleId: string;
    reason: string;
    effect?: "allow" | "deny";
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: row.userId ?? NIL_USER,
    objectType: row.objectType,
    objectId: row.objectId,
    detail: row.detail ?? {},
    effect: row.effect ?? "allow",
    ruleId: row.ruleId,
    ruleChain: [],
    reason: row.reason,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

// ---------------------------------------------------------------------------
// subjects: what an item points at, and whose work it is
// ---------------------------------------------------------------------------

interface ResolvedSubject {
  traceId: string | null;
  spanId: string | null;
  /** the trace's person and the run's initiator: never a reviewer of it */
  userIds: string[];
}

const subjectKey = (kind: AnnotationSubjectKind, id: string) => `${kind}:${id}`;

/**
 * Resolve subjects in a handful of queries (never one per subject). A subject
 * that does not exist is absent from the map.
 */
async function resolveSubjects(db: Writer, subjects: readonly AnnotationSubject[]): Promise<Map<string, ResolvedSubject>> {
  const out = new Map<string, ResolvedSubject>();
  const ids = (kind: AnnotationSubjectKind) => uniq(subjects.filter((s) => s.kind === kind).map((s) => s.id));

  // trace and span subjects -> their trace rows
  const spanRows = ids("span").length
    ? await db
        .select({ id: traceSpans.id, traceId: traceSpans.traceId, runId: traceSpans.runId })
        .from(traceSpans)
        .where(inArray(traceSpans.id, ids("span")))
    : [];
  const traceIds = uniq([...ids("trace"), ...spanRows.map((s) => s.traceId)]);
  const traceRows = traceIds.length
    ? await db
        .select({ id: traces.id, userId: traces.userId, kind: traces.kind, rootRefId: traces.rootRefId })
        .from(traces)
        .where(inArray(traces.id, traceIds))
    : [];
  const traceById = new Map(traceRows.map((t) => [t.id, t]));

  // eval-result subjects -> their run, its trace and the case span
  const resultRows = ids("eval_result").length
    ? await db
        .select({ id: evalResults.id, runId: evalResults.runId, caseId: evalResults.caseId, initiator: evalRuns.initiatedByUserId })
        .from(evalResults)
        .innerJoin(evalRuns, eq(evalRuns.id, evalResults.runId))
        .where(inArray(evalResults.id, ids("eval_result")))
    : [];
  const evalRunIds = uniq([
    ...resultRows.map((r) => r.runId),
    ...traceRows.filter((t) => t.kind === "eval" && t.rootRefId && UUID_RE.test(t.rootRefId)).map((t) => t.rootRefId!),
  ]);
  const evalTraceRows = resultRows.length
    ? await db
        .select({ id: traces.id, userId: traces.userId, rootRefId: traces.rootRefId })
        .from(traces)
        .where(and(eq(traces.kind, "eval"), inArray(traces.rootRefId, uniq(resultRows.map((r) => r.runId)))))
    : [];
  const evalTraceByRun = new Map(evalTraceRows.map((t) => [t.rootRefId!, t]));
  const caseSpanRows = evalTraceRows.length
    ? await db
        .select({ id: traceSpans.id, traceId: traceSpans.traceId, caseId: sql<string | null>`${traceSpans.attributes}->>'evalCaseId'` })
        .from(traceSpans)
        .where(and(inArray(traceSpans.traceId, evalTraceRows.map((t) => t.id)), eq(traceSpans.kind, "eval_case")))
    : [];
  const caseSpan = new Map(caseSpanRows.map((s) => [`${s.traceId}:${s.caseId}`, s.id]));
  const evalInitiators = evalRunIds.length
    ? await db.select({ id: evalRuns.id, initiator: evalRuns.initiatedByUserId }).from(evalRuns).where(inArray(evalRuns.id, evalRunIds))
    : [];
  const evalInitiatorById = new Map(evalInitiators.map((r) => [r.id, r.initiator]));

  // orchestration runs under a trace -> their initiators
  const runRows = traceIds.length
    ? await db
        .selectDistinct({ traceId: traceSpans.traceId, runId: traceSpans.runId })
        .from(traceSpans)
        .where(and(inArray(traceSpans.traceId, traceIds), isNotNull(traceSpans.runId)))
    : [];
  const orchIds = uniq([
    ...runRows.map((r) => r.runId!),
    ...traceRows.filter((t) => t.kind === "run" && t.rootRefId && UUID_RE.test(t.rootRefId)).map((t) => t.rootRefId!),
  ]);
  const orchRows = orchIds.length
    ? await db
        .select({ id: orchestrationRuns.id, initiator: orchestrationRuns.initiatingUserId })
        .from(orchestrationRuns)
        .where(inArray(orchestrationRuns.id, orchIds))
    : [];
  const orchInitiator = new Map(orchRows.map((r) => [r.id, r.initiator]));

  const ownersOfTrace = (traceId: string): string[] => {
    const t = traceById.get(traceId);
    if (!t) return [];
    const owners: Array<string | null | undefined> = [t.userId];
    for (const r of runRows) if (r.traceId === traceId) owners.push(orchInitiator.get(r.runId!));
    if (t.rootRefId && t.kind === "run") owners.push(orchInitiator.get(t.rootRefId));
    if (t.rootRefId && t.kind === "eval") owners.push(evalInitiatorById.get(t.rootRefId));
    return uniq(owners.filter((u): u is string => !!u));
  };

  for (const id of ids("trace")) {
    if (traceById.has(id)) out.set(subjectKey("trace", id), { traceId: id, spanId: null, userIds: ownersOfTrace(id) });
  }
  for (const s of spanRows) {
    if (!traceById.has(s.traceId)) continue;
    const owners = ownersOfTrace(s.traceId);
    const own = s.runId ? orchInitiator.get(s.runId) : undefined;
    out.set(subjectKey("span", s.id), { traceId: s.traceId, spanId: s.id, userIds: uniq([...owners, ...(own ? [own] : [])]) });
  }
  for (const r of resultRows) {
    const t = evalTraceByRun.get(r.runId);
    out.set(subjectKey("eval_result", r.id), {
      traceId: t?.id ?? null,
      spanId: t && r.caseId ? (caseSpan.get(`${t.id}:${r.caseId}`) ?? null) : null,
      userIds: uniq([r.initiator, t?.userId].filter((u): u is string => !!u)),
    });
  }
  return out;
}

/** does the subject still exist (not pruned, not erased)? */
async function subjectRetained(db: Writer, item: Pick<AnnotationItemRow, "subjectKind" | "subjectId">): Promise<boolean> {
  if (item.subjectKind === "trace") {
    return (await db.select({ id: traces.id }).from(traces).where(eq(traces.id, item.subjectId))).length > 0;
  }
  if (item.subjectKind === "span") {
    return (await db.select({ id: traceSpans.id }).from(traceSpans).where(eq(traceSpans.id, item.subjectId))).length > 0;
  }
  return (await db.select({ id: evalResults.id }).from(evalResults).where(eq(evalResults.id, item.subjectId))).length > 0;
}

// ---------------------------------------------------------------------------
// enqueue (the route, T's multi-select and K's automation rules)
// ---------------------------------------------------------------------------

export interface EnqueueAnnotationItemsInput {
  queueId: string;
  subjects: Array<{ kind: AnnotationSubjectKind; id: string }>;
  /** who queued them; for an automation rule, the rule's author */
  actorUserId: string | null;
  /** set when an automation rule queued them (carried on the item and the webhook) */
  ruleId?: string | null | undefined;
  now?: Date | undefined;
}

export interface EnqueueAnnotationItemsResult {
  added: number;
  skipped: Array<{ id: string; reason: AnnotationSkipReason }>;
  items: Array<{ itemId: string; subjectKind: AnnotationSubjectKind; subjectId: string }>;
  /** `trace.queued` deliveries, pending; the route kicks them, the webhook sweep retries them */
  deliveryIds: string[];
}

/**
 * Queue up to ANNOTATION_LIMITS.itemsPerEnqueue subjects, at most once per
 * (queue, subject): a subject already in the queue (or repeated in the call)
 * is skipped as `duplicate`, one that does not exist as `not_found`. One
 * audit row per call; one `trace.queued` webhook per added item that has a
 * trace. Throws AnnotationError (404 unknown queue) or a ZodError (bad shape,
 * over the limit) before writing anything.
 */
export async function enqueueAnnotationItems(db: Db, input: EnqueueAnnotationItemsInput): Promise<EnqueueAnnotationItemsResult> {
  const { subjects } = annotationEnqueueSchema.parse({ subjects: input.subjects });
  const now = input.now ?? new Date();
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [queue] = await tx.select().from(annotationQueues).where(eq(annotationQueues.id, input.queueId));
    if (!queue) throw new AnnotationError(404, "unknown_queue", "no annotation queue has this id");

    const skipped: EnqueueAnnotationItemsResult["skipped"] = [];
    const seen = new Set<string>();
    const fresh: AnnotationSubject[] = [];
    for (const s of subjects) {
      const key = subjectKey(s.kind, s.id);
      if (seen.has(key)) skipped.push({ id: s.id, reason: "duplicate" });
      else {
        seen.add(key);
        fresh.push(s);
      }
    }
    const resolved = await resolveSubjects(tx, fresh);
    const rows = [];
    for (const s of fresh) {
      const r = resolved.get(subjectKey(s.kind, s.id));
      if (!r) {
        skipped.push({ id: s.id, reason: "not_found" });
        continue;
      }
      rows.push({
        queueId: queue.id,
        subjectKind: s.kind,
        subjectId: s.id,
        traceId: r.traceId,
        spanId: r.spanId,
        subjectUserIds: r.userIds,
        requiredReviews: queue.requiredReviews,
        dueAt: queue.slaHours ? new Date(now.getTime() + queue.slaHours * 3_600_000) : null,
        enqueuedByUserId: input.actorUserId,
        ruleId: input.ruleId ?? null,
        createdAt: now,
      });
    }
    const inserted = rows.length
      ? await tx
          .insert(annotationItems)
          .values(rows)
          .onConflictDoNothing({ target: [annotationItems.queueId, annotationItems.subjectKind, annotationItems.subjectId] })
          .returning({
            id: annotationItems.id,
            subjectKind: annotationItems.subjectKind,
            subjectId: annotationItems.subjectId,
            traceId: annotationItems.traceId,
            spanId: annotationItems.spanId,
          })
      : [];
    const insertedKeys = new Set(inserted.map((i) => subjectKey(i.subjectKind, i.subjectId)));
    for (const r of rows) if (!insertedKeys.has(subjectKey(r.subjectKind, r.subjectId))) skipped.push({ id: r.subjectId, reason: "duplicate" });

    await audit(tx, {
      userId: input.actorUserId,
      objectType: "annotation_queue",
      objectId: queue.id,
      ruleId: ANNOTATION_RULE_IDS.itemsQueued,
      reason: `queued ${inserted.length} item(s) in annotation queue "${queue.name}"${skipped.length ? `, skipped ${skipped.length}` : ""}`,
      detail: {
        queueName: queue.name,
        added: inserted.length,
        skipped: skipped.length,
        itemIds: inserted.map((i) => i.id),
        ...(input.ruleId ? { automationRuleId: input.ruleId } : {}),
      },
    });
    const deliveryIds: string[] = [];
    for (const i of inserted) {
      if (!i.traceId) continue;
      deliveryIds.push(
        ...(await enqueueWebhookEvent(
          tx,
          "trace.queued",
          {
            traceId: i.traceId,
            spanId: i.spanId ?? undefined,
            queueId: queue.id,
            queueName: queue.name,
            itemId: i.id,
            queuedByUserId: input.actorUserId ?? undefined,
            ruleId: input.ruleId ?? undefined,
          },
          now,
        )),
      );
    }
    return {
      added: inserted.length,
      skipped,
      items: inserted.map((i) => ({ itemId: i.id, subjectKind: i.subjectKind, subjectId: i.subjectId })),
      deliveryIds,
    };
  });
}

// ---------------------------------------------------------------------------
// labels, for judge calibration (E) and the feedback KRI (K)
// ---------------------------------------------------------------------------

export interface AnnotationLabel {
  subjectKind: AnnotationSubjectKind;
  subjectId: string;
  itemId: string;
  queueId: string;
  itemStatus: "open" | "completed";
  rubricVersion: number;
  reviewerUserId: string;
  /** criterion -> score or label; never the comment */
  values: Record<string, number | string>;
  submittedAt: string;
}

/**
 * Every recorded review of these subjects, oldest first. Comments are not
 * returned. At most 1000 ids per call.
 */
export async function annotationLabelsFor(
  db: Db,
  input: { kind: AnnotationSubjectKind; ids: readonly string[] },
): Promise<AnnotationLabel[]> {
  const ids = uniq(input.ids.filter((id) => UUID_RE.test(id))).slice(0, 1000);
  if (!ids.length) return [];
  const rows = await db
    .select({
      subjectKind: annotationItems.subjectKind,
      subjectId: annotationItems.subjectId,
      itemId: annotationItems.id,
      queueId: annotationItems.queueId,
      itemStatus: annotationItems.status,
      rubricVersion: annotationSubmissions.rubricVersion,
      reviewerUserId: annotationSubmissions.reviewerUserId,
      values: annotationSubmissions.values,
      createdAt: annotationSubmissions.createdAt,
    })
    .from(annotationSubmissions)
    .innerJoin(annotationItems, eq(annotationItems.id, annotationSubmissions.itemId))
    .where(and(eq(annotationItems.subjectKind, input.kind), inArray(annotationItems.subjectId, ids)))
    .orderBy(asc(annotationSubmissions.createdAt), asc(annotationSubmissions.id));
  return rows.map(({ createdAt, ...r }) => ({ ...r, submittedAt: createdAt.toISOString() }));
}

// ---------------------------------------------------------------------------
// the SLA sweep
// ---------------------------------------------------------------------------

/**
 * Mark every open item past its deadline as breached, ONCE: the conditional
 * update only claims items whose `sla_breached_at` is still null, so a second
 * pass (or a concurrent one) claims nothing and fires nothing. Each claimed
 * item gets an audit row and an `annotation.sla.breached` webhook.
 */
export async function runAnnotationSlaSweep(
  db: Db,
  dataKey: string | undefined,
  opts: { now?: Date } = {},
): Promise<{ breached: number; itemIds: string[] }> {
  const now = opts.now ?? new Date();
  const { claimed, deliveryIds } = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const due = tx
      .select({ id: annotationItems.id })
      .from(annotationItems)
      .where(and(eq(annotationItems.status, "open"), isNull(annotationItems.slaBreachedAt), lte(annotationItems.dueAt, now)))
      .orderBy(asc(annotationItems.dueAt))
      .limit(SLA_SWEEP_LIMIT);
    const claimed = await tx
      .update(annotationItems)
      .set({ slaBreachedAt: now })
      .where(and(inArray(annotationItems.id, due), isNull(annotationItems.slaBreachedAt)))
      .returning();
    const deliveryIds: string[] = [];
    if (!claimed.length) return { claimed, deliveryIds };
    const queueIds = uniq(claimed.map((c) => c.queueId));
    const queues = await tx.select().from(annotationQueues).where(inArray(annotationQueues.id, queueIds));
    const queueById = new Map(queues.map((q) => [q.id, q]));
    const reviewers = await tx
      .select({ queueId: annotationQueueReviewers.queueId, userId: annotationQueueReviewers.userId })
      .from(annotationQueueReviewers)
      .where(inArray(annotationQueueReviewers.queueId, queueIds));
    for (const item of claimed) {
      const q = queueById.get(item.queueId);
      const reviewerUserIds = reviewers.filter((r) => r.queueId === item.queueId).map((r) => r.userId);
      await audit(tx, {
        userId: null,
        objectType: "annotation_item",
        objectId: item.id,
        ruleId: ANNOTATION_RULE_IDS.slaBreached,
        reason: `annotation item passed its review deadline in queue "${q?.name ?? item.queueId}"`,
        detail: { queueId: item.queueId, dueAt: item.dueAt?.toISOString() ?? null, reviewerUserIds },
      });
      deliveryIds.push(
        ...(await enqueueWebhookEvent(
          tx,
          "annotation.sla.breached",
          {
            queueId: item.queueId,
            queueName: q?.name,
            itemId: item.id,
            subjectKind: item.subjectKind,
            subjectId: item.subjectId,
            traceId: item.traceId ?? undefined,
            dueAt: item.dueAt?.toISOString(),
            reviewerUserIds,
          },
          now,
        )),
      );
    }
    return { claimed, deliveryIds };
  });
  kickWebhookDeliveries(db, dataKey, deliveryIds);
  return { breached: claimed.length, itemIds: claimed.map((c) => c.id) };
}

// ---------------------------------------------------------------------------
// previews
// ---------------------------------------------------------------------------

interface PreviewSpan {
  id: string;
  kind: string;
  name: string;
  status: string;
  model: string | null;
  startedAt: string;
  durationMs: number | null;
  input: string | null;
  output: string | null;
  withheld: boolean;
  /** admins only */
  statusReason?: string | null;
  attributes?: unknown;
}

export interface ItemPreview {
  retained: boolean;
  /** ANNOTATION_NOT_RETAINED when the subject is gone */
  note: string | null;
  /** true = each text was cut to ANNOTATION_LIMITS.previewChars and no attributes are shown */
  previewOnly: boolean;
  trace: { id: string; name: string; kind: string; status: string; startedAt: string } | null;
  spans: PreviewSpan[];
  spansTruncated: boolean;
  evalResult: {
    id: string;
    runId: string;
    scorerKind: string;
    score: number;
    passed: boolean;
    input: string | null;
    output: string | null;
    withheld: boolean;
    judgeRationale?: string | null;
  } | null;
}

async function loadPreview(db: Db, item: AnnotationItemRow, full: boolean): Promise<ItemPreview> {
  const cut = (s: string | null | undefined) => (full ? (s ?? null) : tracePreview(s, ANNOTATION_LIMITS.previewChars));
  const gone: ItemPreview = {
    retained: false,
    note: ANNOTATION_NOT_RETAINED,
    previewOnly: !full,
    trace: null,
    spans: [],
    spansTruncated: false,
    evalResult: null,
  };
  const spanView = (s: typeof traceSpans.$inferSelect): PreviewSpan => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    status: s.status,
    model: s.model,
    startedAt: s.startedAt.toISOString(),
    durationMs: s.durationMs,
    // a withheld span shows the marker, never what is stored
    input: s.contentWithheld ? ANNOTATION_WITHHELD_MARKER : cut(s.inputPreview),
    output: s.contentWithheld ? ANNOTATION_WITHHELD_MARKER : cut(s.outputPreview),
    withheld: s.contentWithheld,
    ...(full ? { statusReason: s.statusReason, attributes: s.attributes } : {}),
  });
  const traceView = (t: typeof traces.$inferSelect) => ({ id: t.id, name: t.name, kind: t.kind, status: t.status, startedAt: t.startedAt.toISOString() });

  if (item.subjectKind === "trace" || item.subjectKind === "span") {
    const traceId = item.traceId;
    const [t] = traceId ? await db.select().from(traces).where(eq(traces.id, traceId)) : [];
    if (!t) return gone;
    let spans: Array<typeof traceSpans.$inferSelect>;
    let spansTruncated = false;
    if (item.subjectKind === "span") {
      spans = await db.select().from(traceSpans).where(eq(traceSpans.id, item.subjectId));
      if (!spans.length) return gone;
    } else {
      spans = await db
        .select()
        .from(traceSpans)
        .where(eq(traceSpans.traceId, t.id))
        .orderBy(asc(traceSpans.seq), asc(traceSpans.id))
        .limit(ANNOTATION_LIMITS.previewSpans + 1);
      spansTruncated = spans.length > ANNOTATION_LIMITS.previewSpans;
      spans = spans.slice(0, ANNOTATION_LIMITS.previewSpans);
    }
    return { retained: true, note: null, previewOnly: !full, trace: traceView(t), spans: spans.map(spanView), spansTruncated, evalResult: null };
  }

  const [r] = await db
    .select({ result: evalResults, caseInput: evalCases.input })
    .from(evalResults)
    .leftJoin(evalCases, eq(evalCases.id, evalResults.caseId))
    .where(eq(evalResults.id, item.subjectId));
  if (!r) return gone;
  // the case's dispatch spans: withheld when a block or the capture setting acted
  let withheld = false;
  let t: typeof traces.$inferSelect | undefined;
  if (item.traceId) [t] = await db.select().from(traces).where(eq(traces.id, item.traceId));
  if (item.spanId) {
    const [w] = await db
      .select({ n: count() })
      .from(traceSpans)
      .where(and(eq(traceSpans.parentSpanId, item.spanId), eq(traceSpans.contentWithheld, true)));
    withheld = (w?.n ?? 0) > 0;
  }
  return {
    retained: true,
    note: null,
    previewOnly: !full,
    trace: t ? traceView(t) : null,
    spans: [],
    spansTruncated: false,
    evalResult: {
      id: r.result.id,
      runId: r.result.runId,
      scorerKind: r.result.scorerKind,
      score: r.result.score,
      passed: r.result.passed,
      input: cut(r.caseInput),
      output: withheld ? ANNOTATION_WITHHELD_MARKER : cut(r.result.outputText),
      withheld,
      ...(full ? { judgeRationale: r.result.judgeRationale } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One CSV cell: RFC 4180 quoting, and a string that a spreadsheet would read
 * as a formula (leading = + - @ tab or CR) is prefixed with a single quote so
 * it opens as text (OWASP CSV injection). Numbers are written as numbers.
 */
export function annotationCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const ANNOTATION_CSV_HEADER = [
  "item_id",
  "subject_kind",
  "subject_id",
  "trace_id",
  "span_id",
  "item_status",
  "disagreement",
  "submission_id",
  "reviewer_user_id",
  "rubric_version",
  "submitted_at",
  "criterion",
  "score",
  "label",
  "comment",
] as const;

// ---------------------------------------------------------------------------
// queue views
// ---------------------------------------------------------------------------

async function loadRubric(db: Writer, queueId: string, version: number): Promise<AnnotationRubric> {
  const [row] = await db
    .select({ rubric: annotationRubricVersions.rubric })
    .from(annotationRubricVersions)
    .where(and(eq(annotationRubricVersions.queueId, queueId), eq(annotationRubricVersions.version, version)));
  if (!row) throw new AnnotationError(500, "rubric_missing", "the queue's rubric version is missing");
  return annotationRubricSchema.parse(row.rubric);
}

async function reviewerIdsOf(db: Writer, queueId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: annotationQueueReviewers.userId })
    .from(annotationQueueReviewers)
    .where(eq(annotationQueueReviewers.queueId, queueId))
    .orderBy(asc(annotationQueueReviewers.createdAt));
  return rows.map((r) => r.userId);
}

async function namesOf(db: Writer, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, uniq(ids)));
  return new Map(rows.map((u) => [u.id, u.displayName || u.email]));
}

/** every reviewer must be an existing, active person */
async function checkReviewers(db: Writer, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(inArray(users.id, ids));
  const active = new Set(rows.filter((r) => !r.disabledAt).map((r) => r.id));
  const bad = ids.filter((id) => !active.has(id));
  if (bad.length) throw new AnnotationError(422, "unknown_reviewer", "every reviewer must be an existing, active person", { userIds: bad });
}

function queueView(q: AnnotationQueueRow, extra: Record<string, unknown> = {}) {
  return {
    id: q.id,
    name: q.name,
    description: q.description,
    rubricVersion: q.rubricVersion,
    requiredReviews: q.requiredReviews,
    slaHours: q.slaHours,
    createdByUserId: q.createdByUserId,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    ...extra,
  };
}

function itemView(i: AnnotationItemRow, submissionCount: number, queueName?: string) {
  return {
    id: i.id,
    queueId: i.queueId,
    ...(queueName !== undefined ? { queueName } : {}),
    subjectKind: i.subjectKind,
    subjectId: i.subjectId,
    traceId: i.traceId,
    spanId: i.spanId,
    status: i.status,
    requiredReviews: i.requiredReviews,
    submissionCount,
    dueAt: i.dueAt?.toISOString() ?? null,
    slaBreached: i.slaBreachedAt !== null,
    disagreement: i.disagreement,
    completedAt: i.completedAt?.toISOString() ?? null,
    ruleId: i.ruleId,
    createdAt: i.createdAt.toISOString(),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function payloadHash(values: Record<string, number | string>, comment: string | null): string {
  const canonical = JSON.stringify({ values: Object.keys(values).sort().map((k) => [k, values[k]]), comment });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const queueParam = z.object({ queueId: z.string().uuid() });
const itemParam = z.object({ itemId: z.string().uuid() });
const queueItemParam = z.object({ queueId: z.string().uuid(), itemId: z.string().uuid() });
const itemsQuery = z.object({
  status: z.enum(["open", "completed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const exportQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

export function registerAnnotationRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  const refuse = (reply: import("fastify").FastifyReply, e: unknown) => {
    if (e instanceof AnnotationError) return reply.status(e.status).send({ error: e.code, detail: e.message, ...e.extra });
    throw e;
  };
  const loadQueue = async (id: string) => (await db.select().from(annotationQueues).where(eq(annotationQueues.id, id)))[0];

  // ---- admin: queues -------------------------------------------------------

  app.get("/v1/annotation-queues", async () => {
    const queues = await db.select().from(annotationQueues).orderBy(asc(annotationQueues.name));
    if (!queues.length) return { queues: [], limits: ANNOTATION_LIMITS };
    const ids = queues.map((q) => q.id);
    const counts = await db
      .select({
        queueId: annotationItems.queueId,
        open: sql<number>`count(*) filter (where ${annotationItems.status} = 'open')::int`,
        completed: sql<number>`count(*) filter (where ${annotationItems.status} = 'completed')::int`,
        breached: sql<number>`count(*) filter (where ${annotationItems.status} = 'open' and ${annotationItems.slaBreachedAt} is not null)::int`,
        disagreements: sql<number>`count(*) filter (where ${annotationItems.disagreement})::int`,
      })
      .from(annotationItems)
      .where(inArray(annotationItems.queueId, ids))
      .groupBy(annotationItems.queueId);
    const reviewers = await db
      .select({ queueId: annotationQueueReviewers.queueId, n: sql<number>`count(*)::int` })
      .from(annotationQueueReviewers)
      .where(inArray(annotationQueueReviewers.queueId, ids))
      .groupBy(annotationQueueReviewers.queueId);
    const byQueue = new Map(counts.map((c) => [c.queueId, c]));
    const reviewerCount = new Map(reviewers.map((r) => [r.queueId, r.n]));
    return {
      queues: queues.map((q) => {
        const c = byQueue.get(q.id);
        return queueView(q, {
          reviewerCount: reviewerCount.get(q.id) ?? 0,
          openItems: c?.open ?? 0,
          completedItems: c?.completed ?? 0,
          breachedItems: c?.breached ?? 0,
          disagreements: c?.disagreements ?? 0,
        });
      }),
      limits: ANNOTATION_LIMITS,
    };
  });

  const queueDetail = async (q: AnnotationQueueRow) => {
    const versions = await db
      .select()
      .from(annotationRubricVersions)
      .where(eq(annotationRubricVersions.queueId, q.id))
      .orderBy(desc(annotationRubricVersions.version));
    const reviewerIds = await reviewerIdsOf(db, q.id);
    const names = await namesOf(db, reviewerIds);
    const current = versions.find((v) => v.version === q.rubricVersion);
    return queueView(q, {
      rubric: current?.rubric ?? null,
      rubricVersions: versions.map((v) => ({ version: v.version, rubric: v.rubric, createdAt: v.createdAt.toISOString() })),
      reviewers: reviewerIds.map((id) => ({ id, name: names.get(id) ?? "" })),
    });
  };

  app.post("/v1/annotation-queues", async (req, reply) => {
    const body = annotationQueueCreateSchema.parse(req.body ?? {});
    try {
      await checkReviewers(db, body.reviewerUserIds);
    } catch (e) {
      return refuse(reply, e);
    }
    const [dupe] = await db.select({ id: annotationQueues.id }).from(annotationQueues).where(sql`lower(${annotationQueues.name}) = lower(${body.name})`);
    if (dupe) return reply.status(409).send({ error: "queue_name_taken", detail: "another annotation queue has this name" });
    const actor = req.authCtx.userId;
    const queue = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [q] = await tx
        .insert(annotationQueues)
        .values({
          name: body.name,
          description: body.description ?? "",
          requiredReviews: body.requiredReviews,
          slaHours: body.slaHours,
          createdByUserId: actor,
        })
        .returning();
      await tx.insert(annotationRubricVersions).values({ queueId: q!.id, version: 1, rubric: body.rubric, createdByUserId: actor });
      if (body.reviewerUserIds.length) {
        await tx.insert(annotationQueueReviewers).values(body.reviewerUserIds.map((userId) => ({ queueId: q!.id, userId })));
      }
      await audit(tx, {
        userId: actor,
        objectType: "annotation_queue",
        objectId: q!.id,
        ruleId: ANNOTATION_RULE_IDS.queueCreated,
        reason: `created annotation queue "${q!.name}"`,
        detail: {
          name: q!.name,
          reviewerUserIds: body.reviewerUserIds,
          requiredReviews: body.requiredReviews,
          slaHours: body.slaHours,
          criteria: body.rubric.criteria.map((c) => c.name),
        },
      });
      return q!;
    });
    return reply.status(201).send(await queueDetail(queue));
  });

  app.get("/v1/annotation-queues/:queueId", async (req, reply) => {
    const { queueId } = queueParam.parse(req.params);
    const q = await loadQueue(queueId);
    if (!q) return reply.status(404).send({ error: "unknown_queue" });
    return queueDetail(q);
  });

  app.patch("/v1/annotation-queues/:queueId", async (req, reply) => {
    const { queueId } = queueParam.parse(req.params);
    const body = annotationQueueUpdateSchema.parse(req.body ?? {});
    const actor = req.authCtx.userId;
    try {
      const updated = await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [q] = await tx.select().from(annotationQueues).where(eq(annotationQueues.id, queueId)).for("update");
        if (!q) throw new AnnotationError(404, "unknown_queue", "no annotation queue has this id");
        const currentReviewers = await reviewerIdsOf(tx, q.id);
        const reviewerIds = body.reviewerUserIds ?? currentReviewers;
        annotationQueueMergedSchema.parse({ reviewerUserIds: reviewerIds, requiredReviews: body.requiredReviews ?? q.requiredReviews });
        if (body.reviewerUserIds) await checkReviewers(tx, body.reviewerUserIds);
        if (body.name !== undefined && body.name.toLowerCase() !== q.name.toLowerCase()) {
          const [dupe] = await tx.select({ id: annotationQueues.id }).from(annotationQueues).where(sql`lower(${annotationQueues.name}) = lower(${body.name})`);
          if (dupe) throw new AnnotationError(409, "queue_name_taken", "another annotation queue has this name");
        }

        // THE RUBRIC RULE: reviews already made against the current version
        // keep it; the edit becomes a new version. With none, it is replaced.
        let rubricVersion = q.rubricVersion;
        let rubricChange: "none" | "replaced" | "new_version" = "none";
        if (body.rubric) {
          const current = await loadRubric(tx, q.id, q.rubricVersion);
          if (!sameJson(current, body.rubric)) {
            const [used] = await tx
              .select({ n: count() })
              .from(annotationSubmissions)
              .where(and(eq(annotationSubmissions.queueId, q.id), eq(annotationSubmissions.rubricVersion, q.rubricVersion)));
            if ((used?.n ?? 0) > 0) {
              rubricVersion = q.rubricVersion + 1;
              rubricChange = "new_version";
              await tx.insert(annotationRubricVersions).values({ queueId: q.id, version: rubricVersion, rubric: body.rubric, createdByUserId: actor });
            } else {
              rubricChange = "replaced";
              await tx
                .update(annotationRubricVersions)
                .set({ rubric: body.rubric })
                .where(and(eq(annotationRubricVersions.queueId, q.id), eq(annotationRubricVersions.version, q.rubricVersion)));
            }
          }
        }
        if (body.reviewerUserIds && !sameJson([...currentReviewers].sort(), [...body.reviewerUserIds].sort())) {
          await tx.delete(annotationQueueReviewers).where(eq(annotationQueueReviewers.queueId, q.id));
          if (body.reviewerUserIds.length) {
            await tx.insert(annotationQueueReviewers).values(body.reviewerUserIds.map((userId) => ({ queueId: q.id, userId })));
          }
        }
        const [u] = await tx
          .update(annotationQueues)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.requiredReviews !== undefined ? { requiredReviews: body.requiredReviews } : {}),
            ...(body.slaHours !== undefined ? { slaHours: body.slaHours } : {}),
            rubricVersion,
            updatedAt: new Date(),
          })
          .where(eq(annotationQueues.id, q.id))
          .returning();
        await audit(tx, {
          userId: actor,
          objectType: "annotation_queue",
          objectId: q.id,
          ruleId: ANNOTATION_RULE_IDS.queueUpdated,
          reason:
            `changed annotation queue "${u!.name}"` +
            (rubricChange === "new_version" ? ` (rubric version ${rubricVersion}; earlier reviews keep version ${q.rubricVersion})` : ""),
          detail: {
            changed: Object.keys(body),
            rubricChange,
            rubricVersion,
            ...(body.reviewerUserIds ? { reviewerUserIds: body.reviewerUserIds, previousReviewerUserIds: currentReviewers } : {}),
            ...(body.requiredReviews !== undefined ? { requiredReviews: body.requiredReviews } : {}),
            ...(body.slaHours !== undefined ? { slaHours: body.slaHours } : {}),
          },
        });
        return u!;
      });
      return queueDetail(updated);
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.delete("/v1/annotation-queues/:queueId", async (req, reply) => {
    const { queueId } = queueParam.parse(req.params);
    const q = await loadQueue(queueId);
    if (!q) return reply.status(404).send({ error: "unknown_queue" });
    const [items] = await db.select({ n: count() }).from(annotationItems).where(eq(annotationItems.queueId, q.id));
    const [subs] = await db.select({ n: count() }).from(annotationSubmissions).where(eq(annotationSubmissions.queueId, q.id));
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.delete(annotationQueues).where(eq(annotationQueues.id, q.id));
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "annotation_queue",
        objectId: q.id,
        ruleId: ANNOTATION_RULE_IDS.queueDeleted,
        reason: `removed annotation queue "${q.name}" with ${items?.n ?? 0} item(s) and ${subs?.n ?? 0} review(s); recorded trace scores stay`,
        detail: { name: q.name, items: items?.n ?? 0, submissions: subs?.n ?? 0 },
      });
    });
    return { deleted: true, id: q.id };
  });

  // ---- admin: items --------------------------------------------------------

  /** T's multi-select "Send to annotation queue" posts exactly this shape */
  app.post("/v1/annotation-queues/:queueId/items", async (req, reply) => {
    const { queueId } = queueParam.parse(req.params);
    const body = annotationEnqueueSchema.parse(req.body ?? {});
    try {
      const out = await enqueueAnnotationItems(db, { queueId, subjects: body.subjects, actorUserId: req.authCtx.userId });
      kickWebhookDeliveries(db, opts.dataKey, out.deliveryIds, req.log);
      return { added: out.added, skipped: out.skipped, items: out.items };
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.get("/v1/annotation-queues/:queueId/items", async (req, reply) => {
    const { queueId } = queueParam.parse(req.params);
    const q = itemsQuery.parse(req.query ?? {});
    const queue = await loadQueue(queueId);
    if (!queue) return reply.status(404).send({ error: "unknown_queue" });
    const rows = await db
      .select()
      .from(annotationItems)
      .where(and(eq(annotationItems.queueId, queueId), q.status ? eq(annotationItems.status, q.status) : undefined))
      .orderBy(desc(annotationItems.createdAt), desc(annotationItems.id))
      .limit(q.limit ?? 100);
    const subs = rows.length
      ? await db
          .select({ itemId: annotationSubmissions.itemId, reviewerUserId: annotationSubmissions.reviewerUserId })
          .from(annotationSubmissions)
          .where(inArray(annotationSubmissions.itemId, rows.map((r) => r.id)))
      : [];
    return {
      items: rows.map((r) => {
        const mine = subs.filter((s) => s.itemId === r.id);
        return { ...itemView(r, mine.length), reviewedByUserIds: mine.map((s) => s.reviewerUserId) };
      }),
    };
  });

  app.delete("/v1/annotation-queues/:queueId/items/:itemId", async (req, reply) => {
    const { queueId, itemId } = queueItemParam.parse(req.params);
    const [item] = await db.select().from(annotationItems).where(and(eq(annotationItems.id, itemId), eq(annotationItems.queueId, queueId)));
    if (!item) return reply.status(404).send({ error: "unknown_item" });
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.delete(annotationItems).where(eq(annotationItems.id, item.id));
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "annotation_item",
        objectId: item.id,
        ruleId: ANNOTATION_RULE_IDS.itemRemoved,
        reason: `removed an annotation item (${item.subjectKind} ${item.subjectId}) from its queue`,
        detail: { queueId, subjectKind: item.subjectKind, subjectId: item.subjectId, status: item.status },
      });
    });
    return { deleted: true, id: item.id };
  });

  /**
   * EXPORT. Ids, scores, labels and comments only — never a preview — one row
   * per (review, criterion), newest review first, through the repo's streaming
   * CSV loop (window and row ceiling disclosed). Every cell is escaped by
   * `annotationCsvCell`, so a comment cannot become a spreadsheet formula.
   * Audited before the first byte, so a broken download is still on record.
   */
  app.get("/v1/annotation-queues/:queueId/export", async (req, reply) => {
    const { queueId } = queueParam.parse(req.params);
    const q = exportQuery.parse(req.query ?? {});
    const queue = await loadQueue(queueId);
    if (!queue) return reply.status(404).send({ error: "unknown_queue" });
    const win = resolveCsvWindow(q.from, q.to);
    const conds = [eq(annotationSubmissions.queueId, queueId)];
    if (win.from) conds.push(gte(annotationSubmissions.createdAt, win.from));
    if (win.to) conds.push(lt(annotationSubmissions.createdAt, win.to));
    const rubrics = new Map<number, AnnotationRubric>();
    const rubricFor = async (v: number) => {
      if (!rubrics.has(v)) rubrics.set(v, await loadRubric(db, queueId, v));
      return rubrics.get(v)!;
    };
    type Row = {
      sub: typeof annotationSubmissions.$inferSelect;
      item: AnnotationItemRow;
      atText: string;
      rubric: AnnotationRubric;
    };
    await audit(db, {
      userId: req.authCtx.userId,
      objectType: "annotation_queue",
      objectId: queueId,
      ruleId: ANNOTATION_RULE_IDS.queueExported,
      reason: `exported the reviews of annotation queue "${queue.name}" as CSV`,
      detail: { window: { from: win.from?.toISOString() ?? null, to: win.to?.toISOString() ?? null, source: win.source } },
    });
    const spec: CsvStreamSpec<Row> = {
      filename: `annotations-${queue.id.slice(0, 8)}.csv`,
      header: ANNOTATION_CSV_HEADER,
      eol: "\r\n",
      batchSize: csvBatchRows(),
      maxRows: csvMaxRows(),
      window: win,
      fetchPage: async (after, limit) => {
        const rows = await db
          .select({ sub: annotationSubmissions, item: annotationItems, atText: atTextSql(annotationSubmissions.createdAt) })
          .from(annotationSubmissions)
          .innerJoin(annotationItems, eq(annotationItems.id, annotationSubmissions.itemId))
          .where(and(...conds, after ? afterCursorDesc(annotationSubmissions.createdAt, annotationSubmissions.id, after) : undefined))
          .orderBy(desc(annotationSubmissions.createdAt), desc(annotationSubmissions.id))
          .limit(limit);
        const out: Row[] = [];
        for (const r of rows) out.push({ ...r, rubric: await rubricFor(r.sub.rubricVersion) });
        return out;
      },
      cursorOf: (r) => ({ at: r.atText, id: r.sub.id }),
      renderRow: (r) => {
        const base = [
          r.item.id,
          r.item.subjectKind,
          r.item.subjectId,
          r.item.traceId,
          r.item.spanId,
          r.item.status,
          r.item.disagreement,
          r.sub.id,
          r.sub.reviewerUserId,
          r.sub.rubricVersion,
          r.sub.createdAt.toISOString(),
        ];
        const lines = r.rubric.criteria
          .filter((c) => r.sub.values[c.name] !== undefined)
          .map((c) => {
            const v = r.sub.values[c.name];
            return [...base, c.name, c.kind === "score" ? v : null, c.kind === "label" ? v : null, r.sub.comment].map(annotationCsvCell).join(",");
          });
        return lines.length ? lines.join("\r\n") : [...base, null, null, null, r.sub.comment].map(annotationCsvCell).join(",");
      },
      hasRowsOutsideWindow: async () => {
        if (!win.from) return false;
        const older = await db
          .select({ id: annotationSubmissions.id })
          .from(annotationSubmissions)
          .where(and(eq(annotationSubmissions.queueId, queueId), lt(annotationSubmissions.createdAt, win.from)))
          .limit(1);
        return older.length > 0;
      },
    };
    await streamCsv(reply, spec);
  });

  app.post("/v1/annotation-queues/sla-sweep", async (req) => {
    const out = await runAnnotationSlaSweep(db, opts.dataKey);
    await audit(db, {
      userId: req.authCtx.userId,
      objectType: "annotation_queue",
      objectId: null,
      ruleId: ANNOTATION_RULE_IDS.slaSweep,
      reason: `ran the annotation SLA sweep by hand: ${out.breached} item(s) newly past their deadline`,
      detail: { breached: out.breached },
    });
    return out;
  });

  // ---- reviewers -----------------------------------------------------------

  /** my open assignments: content-free, so not a content read */
  app.get("/v1/annotations/inbox", async (req, reply) => {
    const me = req.authCtx.userId;
    if (!me) return reply.status(403).send({ error: "identity_required", detail: "an annotation inbox belongs to a person; this credential has no user identity" });
    const rows = await db
      .select({ item: annotationItems, queueName: annotationQueues.name })
      .from(annotationItems)
      .innerJoin(annotationQueues, eq(annotationQueues.id, annotationItems.queueId))
      .innerJoin(
        annotationQueueReviewers,
        and(eq(annotationQueueReviewers.queueId, annotationItems.queueId), eq(annotationQueueReviewers.userId, me)),
      )
      .where(
        and(
          eq(annotationItems.status, "open"),
          sql`not (${annotationItems.subjectUserIds} @> ${JSON.stringify([me])}::jsonb)`,
          sql`not exists (select 1 from ${annotationSubmissions} where ${annotationSubmissions.itemId} = ${annotationItems.id} and ${annotationSubmissions.reviewerUserId} = ${me})`,
        ),
      )
      .orderBy(sql`${annotationItems.dueAt} asc nulls last`, asc(annotationItems.createdAt))
      .limit(100);
    const counts = rows.length
      ? await db
          .select({ itemId: annotationSubmissions.itemId, n: sql<number>`count(*)::int` })
          .from(annotationSubmissions)
          .where(inArray(annotationSubmissions.itemId, rows.map((r) => r.item.id)))
          .groupBy(annotationSubmissions.itemId)
      : [];
    const n = new Map(counts.map((c) => [c.itemId, c.n]));
    return { items: rows.map((r) => itemView(r.item, n.get(r.item.id) ?? 0, r.queueName)) };
  });

  /**
   * ONE ITEM, for review. A named reviewer of the item's queue or an admin;
   * anyone else is 403 with a deny audit row. Every read is audited. A
   * non-admin gets previews only (see the file header).
   */
  app.get("/v1/annotations/items/:itemId", async (req, reply) => {
    const { itemId } = itemParam.parse(req.params);
    const me = req.authCtx.userId;
    const isAdmin = req.authCtx.isAdmin;
    const [row] = await db
      .select({ item: annotationItems, queue: annotationQueues })
      .from(annotationItems)
      .innerJoin(annotationQueues, eq(annotationQueues.id, annotationItems.queueId))
      .where(eq(annotationItems.id, itemId));
    if (!row) return reply.status(404).send({ error: "unknown_item" });
    const { item, queue } = row;
    const reviewerIds = await reviewerIdsOf(db, queue.id);
    const isReviewer = !!me && reviewerIds.includes(me);
    if (!isReviewer && !isAdmin) {
      await audit(db, {
        userId: me,
        objectType: "annotation_item",
        objectId: item.id,
        ruleId: ANNOTATION_RULE_IDS.itemReadDenied,
        effect: "deny",
        reason: "refused a read of an annotation item by someone who is neither a named reviewer of its queue nor an admin",
        detail: { queueId: queue.id, subjectKind: item.subjectKind, subjectId: item.subjectId },
      });
      return reply.status(403).send({
        error: "forbidden",
        detail: "only the queue's named reviewers and admins may read its items; a trace carries another person's prompts",
      });
    }
    const full = isAdmin;
    const preview = await loadPreview(db, item, full);
    await audit(db, {
      userId: me,
      objectType: "annotation_item",
      objectId: item.id,
      ruleId: ANNOTATION_RULE_IDS.itemRead,
      reason: `read annotation item content (${item.subjectKind}) as ${isReviewer ? "a named reviewer" : "an admin"}${full ? "" : ", previews only"}`,
      detail: {
        queueId: queue.id,
        subjectKind: item.subjectKind,
        subjectId: item.subjectId,
        traceId: item.traceId,
        as: isReviewer ? "reviewer" : "admin",
        previewOnly: !full,
        retained: preview.retained,
      },
    });
    const rubric = await loadRubric(db, queue.id, queue.rubricVersion);
    const subs = await db
      .select()
      .from(annotationSubmissions)
      .where(eq(annotationSubmissions.itemId, item.id))
      .orderBy(asc(annotationSubmissions.createdAt));
    const mine = me ? (subs.find((s) => s.reviewerUserId === me) ?? null) : null;
    const selfReview = !!me && item.subjectUserIds.includes(me);
    const blockedReason = !isReviewer
      ? "not_a_reviewer"
      : selfReview
        ? "self_review"
        : mine
          ? "already_submitted"
          : item.status === "completed"
            ? "completed"
            : !preview.retained
              ? "not_retained"
              : null;
    const subView = (s: (typeof subs)[number]) => ({
      id: s.id,
      reviewerUserId: s.reviewerUserId,
      rubricVersion: s.rubricVersion,
      values: s.values,
      comment: s.comment,
      createdAt: s.createdAt.toISOString(),
    });
    return {
      item: itemView(item, subs.length, queue.name),
      queue: { id: queue.id, name: queue.name, description: queue.description, requiredReviews: queue.requiredReviews, slaHours: queue.slaHours },
      rubric: { version: queue.rubricVersion, ...rubric },
      preview,
      you: { isReviewer, isAdmin, selfReview, canSubmit: blockedReason === null, blockedReason, submission: mine ? subView(mine) : null },
      // blind review: a reviewer sees only their own; an admin sees every review
      ...(isAdmin ? { submissions: subs.map(subView), disagreementDetail: item.disagreementDetail } : {}),
    };
  });

  app.post("/v1/annotations/items/:itemId/submissions", async (req, reply) => {
    const { itemId } = itemParam.parse(req.params);
    const body = annotationSubmissionSchema.parse(req.body ?? {});
    const me = req.authCtx.userId;
    const deny = async (item: AnnotationItemRow, code: string, reason: string) => {
      await audit(db, {
        userId: me,
        objectType: "annotation_item",
        objectId: item.id,
        ruleId: ANNOTATION_RULE_IDS.submitRefused,
        effect: "deny",
        reason,
        detail: { queueId: item.queueId, code },
      });
    };
    const [pre] = await db.select().from(annotationItems).where(eq(annotationItems.id, itemId));
    if (!pre) return reply.status(404).send({ error: "unknown_item" });
    if (!me || !(await reviewerIdsOf(db, pre.queueId)).includes(me)) {
      await deny(pre, "not_a_reviewer", "refused an annotation by someone who is not a named reviewer of the queue");
      return reply.status(403).send({ error: "not_a_reviewer", detail: "only the queue's named reviewers may annotate its items" });
    }
    // NO SELF-REVIEW: the trace's person and the run's initiator
    if (pre.subjectUserIds.includes(me)) {
      await deny(pre, "self_review", "refused a self-review: the reviewer is the person whose trace or run this is");
      return reply.status(403).send({ error: "self_review", detail: "nobody reviews their own traces or runs" });
    }
    let completedNow = false;
    try {
      const out = await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        // serialise submits on this item: N-person completion counts exactly
        const [item] = await tx.select().from(annotationItems).where(eq(annotationItems.id, itemId)).for("update");
        if (!item) throw new AnnotationError(404, "unknown_item", "no annotation item has this id");
        const [queue] = await tx.select().from(annotationQueues).where(eq(annotationQueues.id, item.queueId));
        const rubric = await loadRubric(tx, queue!.id, queue!.rubricVersion);
        const commentKey = body.comment?.trim() ? body.comment.trim() : null;
        const hash = payloadHash(body.values, commentKey);

        const [existing] = await tx
          .select()
          .from(annotationSubmissions)
          .where(and(eq(annotationSubmissions.itemId, item.id), eq(annotationSubmissions.reviewerUserId, me)));
        if (existing) {
          // IDEMPOTENT: the same review again is the recorded one; a different
          // one from the same person would count them twice toward N
          if (existing.payloadHash === hash) return { submission: existing, item, replayed: true };
          throw new AnnotationError(409, "already_submitted", "you have already reviewed this item; N-person review needs distinct reviewers");
        }
        if (item.status === "completed") {
          throw new AnnotationError(409, "item_completed", "this item has all its reviews; a completed item cannot change");
        }
        if (!(await subjectRetained(tx, item))) {
          throw new AnnotationError(409, "subject_not_retained", `the ${item.subjectKind} is ${ANNOTATION_NOT_RETAINED}`);
        }
        const check = checkSubmission(rubric, body);
        if (!check.ok) throw new AnnotationError(422, "rubric_violation", check.errors.join("; "), { errors: check.errors });

        const [sub] = await tx
          .insert(annotationSubmissions)
          .values({
            itemId: item.id,
            queueId: item.queueId,
            reviewerUserId: me,
            rubricVersion: queue!.rubricVersion,
            values: body.values,
            comment: check.comment,
            payloadHash: hash,
          })
          .returning();
        // scores: names, numbers and labels — never the comment
        if (item.traceId && (await tx.select({ id: traces.id }).from(traces).where(eq(traces.id, item.traceId))).length) {
          for (const s of check.scores) {
            await recordTraceScore(tx, {
              traceId: item.traceId,
              spanId: item.spanId,
              source: "annotation",
              name: s.name,
              value: s.value ?? null,
              label: s.label ?? null,
              sourceRefId: sub!.id,
            });
          }
        }
        const all = await tx.select().from(annotationSubmissions).where(eq(annotationSubmissions.itemId, item.id));
        let finished = item;
        let aggregate = check.scores;
        if (all.length >= item.requiredReviews) {
          const dis = annotationDisagreement(rubric, all);
          aggregate = aggregateAnnotationScores(rubric, all);
          const [u] = await tx
            .update(annotationItems)
            .set({ status: "completed", completedAt: new Date(), disagreement: dis.disagreement, disagreementDetail: dis.detail as unknown as Array<Record<string, unknown>> })
            .where(and(eq(annotationItems.id, item.id), eq(annotationItems.status, "open")))
            .returning();
          finished = u!;
          completedNow = true;
        }
        const event = {
          queueId: queue!.id,
          queueName: queue!.name,
          itemId: item.id,
          subjectKind: item.subjectKind,
          subjectId: item.subjectId,
          traceId: item.traceId ?? undefined,
          rubricVersion: queue!.rubricVersion,
        };
        await audit(tx, {
          userId: me,
          objectType: "annotation_item",
          objectId: item.id,
          ruleId: ANNOTATION_RULE_IDS.submitted,
          reason: `annotated a ${item.subjectKind} in queue "${queue!.name}" (${all.length} of ${item.requiredReviews} review(s))`,
          detail: { queueId: queue!.id, submissionId: sub!.id, rubricVersion: queue!.rubricVersion, scores: check.scores },
        });
        const deliveryIds = await enqueueWebhookEvent(tx, "annotation.submitted", { ...event, reviewerUserId: me, scores: check.scores });
        if (completedNow) {
          await audit(tx, {
            userId: me,
            objectType: "annotation_item",
            objectId: item.id,
            ruleId: ANNOTATION_RULE_IDS.completed,
            reason: `annotation item completed with ${all.length} review(s)${finished.disagreement ? ", and the reviewers disagreed" : ""}`,
            detail: { queueId: queue!.id, reviewerCount: all.length, disagreement: finished.disagreement, disagreementDetail: finished.disagreementDetail },
          });
          deliveryIds.push(
            ...(await enqueueWebhookEvent(tx, "annotation.item.completed", {
              ...event,
              reviewerCount: all.length,
              disagreement: finished.disagreement,
              scores: aggregate,
              completedAt: finished.completedAt?.toISOString(),
            })),
          );
        }
        return { submission: sub!, item: finished, replayed: false, deliveryIds, count: all.length };
      });
      if ("deliveryIds" in out && out.deliveryIds) kickWebhookDeliveries(db, opts.dataKey, out.deliveryIds, req.log);
      const s = out.submission;
      return reply.status(out.replayed ? 200 : 201).send({
        replayed: out.replayed,
        submission: { id: s.id, rubricVersion: s.rubricVersion, values: s.values, comment: s.comment, createdAt: s.createdAt.toISOString() },
        item: { id: out.item.id, status: out.item.status, disagreement: out.item.disagreement, completedAt: out.item.completedAt?.toISOString() ?? null },
      });
    } catch (e) {
      if (e instanceof AnnotationError && e.status === 409 && e.code === "already_submitted") await deny(pre, e.code, e.message);
      return refuse(reply, e);
    }
  });
}
