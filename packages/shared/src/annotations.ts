/**
 * ADR-0173 batch 2c (Q) — ANNOTATION QUEUES: the shared, pure half.
 *
 * A queue is a named set of items (a trace, a span or an eval result) that
 * named human reviewers score against a RUBRIC. This file holds the shapes the
 * gateway (apps/gateway/src/annotations.ts) and the console both read, and the
 * pure decisions that do not need a database:
 *
 *   - the rubric schema: 1–10 criteria, each a bounded numeric SCORE or a
 *     LABEL from a fixed set; an optional "comment required" flag;
 *   - `checkSubmission(rubric, body)`: every criterion answered, a score inside
 *     [min, max] (on its step when one is set), a label inside the set, a
 *     comment of at most 2000 characters; unknown criteria are refused;
 *   - `annotationDisagreement(rubric, submissions)`: a label criterion
 *     disagrees when the reviewers chose different labels; a score criterion
 *     disagrees when the spread exceeds a quarter of the rubric's range;
 *   - `aggregateAnnotationScores`: the mean per score criterion and the
 *     majority label per label criterion (ties: the label listed first in the
 *     rubric), for the completed-item webhook.
 *
 * A comment is reviewer-written content. It is stored, exported (CSV,
 * injection-safe) and shown to admins and the queue's reviewers; it is NEVER
 * copied into `trace_scores` or a webhook payload.
 */
import { z } from "zod";

export const ANNOTATION_SUBJECT_KINDS = ["trace", "span", "eval_result"] as const;
export type AnnotationSubjectKind = (typeof ANNOTATION_SUBJECT_KINDS)[number];

export const ANNOTATION_ITEM_STATUSES = ["open", "completed"] as const;
export type AnnotationItemStatus = (typeof ANNOTATION_ITEM_STATUSES)[number];

/** why one subject of an enqueue was not added (a fixed code, never free text) */
export const ANNOTATION_SKIP_REASONS = ["duplicate", "not_found"] as const;
export type AnnotationSkipReason = (typeof ANNOTATION_SKIP_REASONS)[number];

export const ANNOTATION_LIMITS = {
  nameChars: 80,
  descriptionChars: 500,
  criteria: 10,
  labelsPerCriterion: 20,
  labelChars: 64,
  criterionDescriptionChars: 300,
  commentChars: 2000,
  /** subjects in one enqueue call (route, automation rule or API) */
  itemsPerEnqueue: 500,
  reviewersPerQueue: 50,
  /** N-person review: 1 = single review, up to 5 distinct reviewers */
  maxRequiredReviews: 5,
  /** the SLA, in hours, from enqueue to completion (30 days) */
  maxSlaHours: 720,
  /** a non-admin reviewer's preview of each input/output, in characters */
  previewChars: 1000,
  /** spans shown for a whole-trace item */
  previewSpans: 50,
} as const;

/** a score criterion disagrees when the reviewers' spread exceeds this
 * fraction of the rubric's range (e.g. more than 1 point on a 1–5 scale) */
export const ANNOTATION_SCORE_DISAGREEMENT_FRACTION = 0.25;

/** shown INSTEAD of content whose capture a block or the capture setting withheld */
export const ANNOTATION_WITHHELD_MARKER = "[content withheld by policy]";
/** shown when the subject has been pruned or erased since it was queued */
export const ANNOTATION_NOT_RETAINED = "no longer retained";

/** criterion names double as `trace_scores.name`, so they share the tag key shape */
export const ANNOTATION_CRITERION_PATTERN = /^[a-z0-9_.-]{1,64}$/;

const criterionName = z
  .string()
  .regex(ANNOTATION_CRITERION_PATTERN, "a criterion name is 1-64 of a-z, 0-9, '_', '.' or '-'");
const criterionDescription = z.string().trim().max(ANNOTATION_LIMITS.criterionDescriptionChars).optional();

const scoreCriterionSchema = z
  .object({
    name: criterionName,
    kind: z.literal("score"),
    description: criterionDescription,
    min: z.number().finite(),
    max: z.number().finite(),
    /** when set, a value must be min + k*step */
    step: z.number().finite().positive().optional(),
  })
  .strict();

const labelCriterionSchema = z
  .object({
    name: criterionName,
    kind: z.literal("label"),
    description: criterionDescription,
    labels: z.array(z.string().trim().min(1).max(ANNOTATION_LIMITS.labelChars)).min(2).max(ANNOTATION_LIMITS.labelsPerCriterion),
  })
  .strict();

export const annotationCriterionSchema = z.discriminatedUnion("kind", [scoreCriterionSchema, labelCriterionSchema]);
export type AnnotationCriterion = z.infer<typeof annotationCriterionSchema>;

export const annotationRubricSchema = z
  .object({
    criteria: z.array(annotationCriterionSchema).min(1).max(ANNOTATION_LIMITS.criteria),
    commentRequired: z.boolean().default(false),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.criteria.forEach((c, i) => {
      if (seen.has(c.name)) ctx.addIssue({ code: "custom", path: ["criteria", i, "name"], message: `duplicate criterion "${c.name}"` });
      seen.add(c.name);
      if (c.kind === "score" && !(c.min < c.max)) {
        ctx.addIssue({ code: "custom", path: ["criteria", i, "max"], message: "max must be greater than min" });
      }
      if (c.kind === "label" && new Set(c.labels).size !== c.labels.length) {
        ctx.addIssue({ code: "custom", path: ["criteria", i, "labels"], message: "labels must be distinct" });
      }
    });
  });
export type AnnotationRubric = z.infer<typeof annotationRubricSchema>;

const reviewerIds = z.array(z.string().uuid()).max(ANNOTATION_LIMITS.reviewersPerQueue);

const queueFields = {
  name: z.string().trim().min(1).max(ANNOTATION_LIMITS.nameChars),
  description: z.string().trim().max(ANNOTATION_LIMITS.descriptionChars).optional(),
  rubric: annotationRubricSchema,
  reviewerUserIds: reviewerIds,
  requiredReviews: z.number().int().min(1).max(ANNOTATION_LIMITS.maxRequiredReviews),
  /** null = no deadline */
  slaHours: z.number().int().min(1).max(ANNOTATION_LIMITS.maxSlaHours).nullable(),
};

/** N distinct reviewers are needed for an N-person review */
function refineReviewerCount(v: { reviewerUserIds?: string[] | undefined; requiredReviews?: number | undefined }, ctx: z.RefinementCtx) {
  if (v.reviewerUserIds && new Set(v.reviewerUserIds).size !== v.reviewerUserIds.length) {
    ctx.addIssue({ code: "custom", path: ["reviewerUserIds"], message: "reviewers must be distinct" });
  }
  if (v.reviewerUserIds && v.requiredReviews !== undefined && v.requiredReviews > new Set(v.reviewerUserIds).size) {
    ctx.addIssue({
      code: "custom",
      path: ["requiredReviews"],
      message: "an N-person review needs at least N named reviewers",
    });
  }
}

export const annotationQueueCreateSchema = z
  .object({
    ...queueFields,
    requiredReviews: queueFields.requiredReviews.default(1),
    slaHours: queueFields.slaHours.default(null),
  })
  .strict()
  .superRefine(refineReviewerCount);
export type AnnotationQueueCreate = z.infer<typeof annotationQueueCreateSchema>;

export const annotationQueueUpdateSchema = z
  .object({
    name: queueFields.name.optional(),
    description: queueFields.description,
    rubric: queueFields.rubric.optional(),
    reviewerUserIds: queueFields.reviewerUserIds.optional(),
    requiredReviews: queueFields.requiredReviews.optional(),
    slaHours: queueFields.slaHours.optional(),
  })
  .strict();
export type AnnotationQueueUpdate = z.infer<typeof annotationQueueUpdateSchema>;
/** re-check the reviewer count against the MERGED queue (update + stored) */
export const annotationQueueMergedSchema = z
  .object({ reviewerUserIds: reviewerIds, requiredReviews: queueFields.requiredReviews })
  .superRefine(refineReviewerCount);

export const annotationSubjectSchema = z
  .object({ kind: z.enum(ANNOTATION_SUBJECT_KINDS), id: z.string().uuid() })
  .strict();
export type AnnotationSubject = z.infer<typeof annotationSubjectSchema>;

/** `POST /v1/annotation-queues/:id/items` */
export const annotationEnqueueSchema = z
  .object({ subjects: z.array(annotationSubjectSchema).min(1).max(ANNOTATION_LIMITS.itemsPerEnqueue) })
  .strict();

/** `POST /v1/annotations/items/:itemId/submissions` */
export const annotationSubmissionSchema = z
  .object({
    /** criterion name -> a number (score) or a string (label) */
    values: z.record(z.string(), z.union([z.number().finite(), z.string()])),
    /** bounded by `checkSubmission` (ANNOTATION_LIMITS.commentChars), not here,
     * so the refusal names the limit */
    comment: z.string().optional(),
  })
  .strict();
export type AnnotationSubmissionBody = z.infer<typeof annotationSubmissionSchema>;

/** one recorded score, the shape `trace_scores` and the webhooks carry */
export interface AnnotationScore {
  name: string;
  value?: number;
  label?: string;
}

export type SubmissionCheck =
  | { ok: true; scores: AnnotationScore[]; comment: string | null }
  | { ok: false; errors: string[] };

function onStep(value: number, min: number, step: number): boolean {
  const k = (value - min) / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
}

/** the rubric bounds, as one decision; see the file header */
export function checkSubmission(rubric: AnnotationRubric, body: AnnotationSubmissionBody): SubmissionCheck {
  const errors: string[] = [];
  const scores: AnnotationScore[] = [];
  const known = new Set(rubric.criteria.map((c) => c.name));
  for (const key of Object.keys(body.values)) {
    if (!known.has(key)) errors.push(`"${key}" is not a criterion of this rubric`);
  }
  for (const c of rubric.criteria) {
    const v = body.values[c.name];
    if (v === undefined) {
      errors.push(`"${c.name}" needs an answer`);
      continue;
    }
    if (c.kind === "score") {
      if (typeof v !== "number") errors.push(`"${c.name}" is a score: a number from ${c.min} to ${c.max}`);
      else if (v < c.min || v > c.max) errors.push(`"${c.name}" must be from ${c.min} to ${c.max}`);
      else if (c.step !== undefined && !onStep(v, c.min, c.step)) errors.push(`"${c.name}" must be in steps of ${c.step} from ${c.min}`);
      else scores.push({ name: c.name, value: v });
    } else if (typeof v !== "string" || !c.labels.includes(v)) {
      errors.push(`"${c.name}" must be one of: ${c.labels.join(", ")}`);
    } else {
      scores.push({ name: c.name, label: v });
    }
  }
  const comment = body.comment?.trim() ? body.comment.trim() : null;
  if (body.comment !== undefined && body.comment.length > ANNOTATION_LIMITS.commentChars) {
    errors.push(`a comment is at most ${ANNOTATION_LIMITS.commentChars} characters`);
  }
  if (rubric.commentRequired && !comment) errors.push("this rubric requires a comment");
  return errors.length ? { ok: false, errors } : { ok: true, scores, comment };
}

export interface DisagreementEntry {
  criterion: string;
  kind: "score" | "label";
  /** the values (scores) or labels the reviewers gave, in submission order */
  values: Array<number | string>;
}

/**
 * Did N reviewers disagree? Only criteria every compared submission answered
 * are compared (a rubric edit between two reviews can drop one). Fewer than
 * two submissions never disagree.
 */
export function annotationDisagreement(
  rubric: AnnotationRubric,
  submissions: ReadonlyArray<{ values: Record<string, number | string> }>,
): { disagreement: boolean; detail: DisagreementEntry[] } {
  if (submissions.length < 2) return { disagreement: false, detail: [] };
  const detail: DisagreementEntry[] = [];
  for (const c of rubric.criteria) {
    const vals = submissions.map((s) => s.values[c.name]).filter((v): v is number | string => v !== undefined);
    if (vals.length < 2) continue;
    if (c.kind === "label") {
      if (new Set(vals.map(String)).size > 1) detail.push({ criterion: c.name, kind: "label", values: vals });
    } else {
      const nums = vals.filter((v): v is number => typeof v === "number");
      if (nums.length < 2) continue;
      const spread = Math.max(...nums) - Math.min(...nums);
      if (spread > (c.max - c.min) * ANNOTATION_SCORE_DISAGREEMENT_FRACTION) detail.push({ criterion: c.name, kind: "score", values: nums });
    }
  }
  return { disagreement: detail.length > 0, detail };
}

/** mean per score criterion, majority label per label criterion (ties: rubric order) */
export function aggregateAnnotationScores(
  rubric: AnnotationRubric,
  submissions: ReadonlyArray<{ values: Record<string, number | string> }>,
): AnnotationScore[] {
  const out: AnnotationScore[] = [];
  for (const c of rubric.criteria) {
    const vals = submissions.map((s) => s.values[c.name]).filter((v) => v !== undefined);
    if (!vals.length) continue;
    if (c.kind === "score") {
      const nums = vals.filter((v): v is number => typeof v === "number");
      if (nums.length) out.push({ name: c.name, value: nums.reduce((a, b) => a + b, 0) / nums.length });
    } else {
      let best: string | null = null;
      let bestCount = 0;
      for (const label of c.labels) {
        const n = vals.filter((v) => v === label).length;
        if (n > bestCount) {
          best = label;
          bestCount = n;
        }
      }
      if (best !== null) out.push({ name: c.name, label: best });
    }
  }
  return out;
}
