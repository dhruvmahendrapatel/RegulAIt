/**
 * ADR-0045 — the MODEL RISK MANAGEMENT registry's PURE half.
 *
 * Division of labour, drawn exactly where ADR-0042/0044 drew it:
 *
 *   THIS FILE            the zod shapes, the EFFECTIVE-STATUS computation, the
 *                        card-completeness assessment, and the gate decision.
 *                        No db, no clock of its own (every function that needs
 *                        "now" takes it), no provider.
 *   `apps/gateway/src/mrm.ts`
 *                        persistence, the admin API, the sign-off that rides
 *                        the ONE Approvals Queue, the expiry sweep, and the
 *                        audit rows.
 *
 * THE ONE IDEA WORTH STATING TWICE
 *
 *   `modelCardApprovals.status` is a CACHE of the comparison
 *   `validUntil < now`, kept fresh by an operator/cron-driven sweep. Nothing in
 *   this file — and nothing in the dispatch gate — is allowed to trust that
 *   cache on its own, because a deployment that never runs the sweep would
 *   otherwise keep dispatching under a lapsed risk acceptance. `effectiveStatus`
 *   below recomputes from `validUntil` every single time it is asked. That is
 *   the fail-safe reading of ADR-0045 §3/§4, and it is what makes expiry an
 *   enforced consequence rather than a badge.
 *
 * WHAT THIS FILE DOES NOT DO
 *
 *   It does not measure bias or fairness. `assessBiasFairness` inspects the
 *   DECLARED slots on a card and reports whether they are present, stale, or
 *   missing. It has no opinion whatsoever about whether a model IS fair — that
 *   requires running the model, and the honest thing is to say so here, in the
 *   code, rather than only in a doc.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const MODEL_CARD_APPROVAL_STATUSES = [
  "draft",
  "pending",
  "approved",
  "denied",
  "expired",
  "revoked",
  "superseded",
] as const;
export type MrmApprovalStatus = (typeof MODEL_CARD_APPROVAL_STATUSES)[number];

export const BIAS_FAIRNESS_STATUSES = ["not_assessed", "in_progress", "assessed", "waived"] as const;
export type BiasFairnessStatus = (typeof BIAS_FAIRNESS_STATUSES)[number];

export const biasFairnessEntrySchema = z.object({
  dimension: z.string().min(1).max(200),
  method: z.string().min(1).max(500),
  /** an eval_run id, a URL, or a document reference. Free-form on purpose: the
   * platform records WHERE the evidence lives; it never fetches or grades it. */
  resultRef: z.string().max(2000).nullish(),
  status: z.enum(BIAS_FAIRNESS_STATUSES),
  assessedAt: z.string().max(64).nullish(),
  assessedBy: z.string().max(200).nullish(),
  note: z.string().max(4000).nullish(),
});
export type BiasFairnessEntryInput = z.infer<typeof biasFairnessEntrySchema>;

export const createModelCardSchema = z
  .object({
    agentId: z.string().uuid().optional(),
    customProviderId: z.string().uuid().optional(),
    intendedUse: z.string().min(1).max(2000),
    dataClaims: z.record(z.string(), z.unknown()).default({}),
    limitations: z.string().max(20_000).nullish(),
    biasFairness: z.array(biasFairnessEntrySchema).max(50).default([]),
    standardRefs: z.array(z.string().min(1).max(200)).max(50).default([]),
    note: z.string().max(4000).nullish(),
    /** ADR-0175 A4 — the exact model version this risk position was taken on;
     * any other served id raises a high-severity served_model_drift alert */
    pinnedModelVersion: z.string().trim().min(1).max(200).nullish(),
  })
  // the API twin of the DB CHECK: a card is about a registry agent OR a
  // self-hosted endpoint, never both and never neither
  .refine((b) => (b.agentId ? 1 : 0) + (b.customProviderId ? 1 : 0) === 1, {
    message: "exactly one of agentId / customProviderId must be given",
  });

export const updateModelCardSchema = z.object({
  intendedUse: z.string().min(1).max(2000).optional(),
  dataClaims: z.record(z.string(), z.unknown()).optional(),
  limitations: z.string().max(20_000).nullish(),
  biasFairness: z.array(biasFairnessEntrySchema).max(50).optional(),
  standardRefs: z.array(z.string().min(1).max(200)).max(50).optional(),
  note: z.string().max(4000).nullish(),
  /** null clears the pin */
  pinnedModelVersion: z.string().trim().min(1).max(200).nullish(),
});

export const requestModelCardSignOffSchema = z
  .object({
    approverUserId: z.string().uuid(),
    /** the recertification date. Required unless the caller explicitly says
     * they want a never-expiring acceptance — a risk sign-off with no expiry is
     * exactly what recertification exists to prevent, so it must be typed out. */
    validUntil: z.string().datetime().optional(),
    acknowledgeNoExpiry: z.boolean().default(false),
    reason: z.string().max(4000).optional(),
  })
  .refine((b) => Boolean(b.validUntil) !== b.acknowledgeNoExpiry, {
    message:
      "give a validUntil recertification date, or set acknowledgeNoExpiry to accept a sign-off that never lapses (not both)",
  });

export const attachModelCardEvidenceSchema = z
  .object({
    // ADR-0187 B5-M: `engine_scan` cites a model-artifact scan (artifact_scans) as evidence
    kind: z.enum(["eval_run", "external", "engine_scan"]),
    evalRunId: z.string().uuid().optional(),
    externalRef: z.string().min(1).max(2000).optional(),
    artifactScanId: z.string().uuid().optional(),
    label: z.string().max(200).nullish(),
    note: z.string().max(4000).nullish(),
  })
  .refine(
    (b) =>
      (b.kind === "eval_run" && Boolean(b.evalRunId) && !b.externalRef && !b.artifactScanId) ||
      (b.kind === "external" && Boolean(b.externalRef) && !b.evalRunId && !b.artifactScanId) ||
      (b.kind === "engine_scan" && Boolean(b.artifactScanId) && !b.evalRunId && !b.externalRef),
    { message: "kind 'eval_run' needs evalRunId; kind 'external' needs externalRef; kind 'engine_scan' needs artifactScanId" },
  );

export const revokeModelCardApprovalSchema = z.object({
  reason: z.string().min(1).max(4000),
});

// ---------------------------------------------------------------------------
// Effective status — recomputed from validUntil, never read from the cache
// ---------------------------------------------------------------------------

export interface MrmApprovalLike {
  status: MrmApprovalStatus | string;
  validUntil: Date | string | null;
}

function toMs(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The EFFECTIVE status of a sign-off record at instant `now`.
 *
 * The only transformation applied is the one that must never be missed: an
 * `approved` record whose `validUntil` has passed reads back as `expired`,
 * whatever the stored column says. Every other stored status is returned
 * unchanged — a revoked record does not un-revoke because a sweep has not run,
 * and a pending record does not become approved because time passed.
 */
export function effectiveApprovalStatus(row: MrmApprovalLike, now: Date): MrmApprovalStatus {
  const stored = (
    (MODEL_CARD_APPROVAL_STATUSES as readonly string[]).includes(row.status) ? row.status : "draft"
  ) as MrmApprovalStatus;
  if (stored !== "approved") return stored;
  const until = toMs(row.validUntil);
  if (until === null) return "approved"; // an acknowledged never-expiring acceptance
  return until <= now.getTime() ? "expired" : "approved";
}

/** true iff this record is a LIVE risk acceptance at `now`. */
export function isLiveApproval(row: MrmApprovalLike, now: Date): boolean {
  return effectiveApprovalStatus(row, now) === "approved";
}

/** whole days until `validUntil` (negative once lapsed); null = never expires */
export function daysUntilExpiry(row: MrmApprovalLike, now: Date): number | null {
  const until = toMs(row.validUntil);
  if (until === null) return null;
  return Math.floor((until - now.getTime()) / 86_400_000);
}

export type MrmCardState = "unsigned" | "pending" | "approved" | "expiring" | "expired" | "revoked";

/**
 * Roll the chain of sign-off records for ONE card up into a single state a
 * reviewer can act on. Deliberately conservative: `approved` requires a live
 * record, and a card whose newest record has lapsed reads `expired` rather than
 * falling back to some older still-valid one.
 */
export function cardState(
  approvalsForCard: MrmApprovalLike[],
  now: Date,
  warnDays: number,
): { state: MrmCardState; live: MrmApprovalLike | null; daysLeft: number | null } {
  const live = approvalsForCard.find((a) => isLiveApproval(a, now)) ?? null;
  if (live) {
    const daysLeft = daysUntilExpiry(live, now);
    return {
      state: daysLeft !== null && daysLeft <= warnDays ? "expiring" : "approved",
      live,
      daysLeft,
    };
  }
  const statuses = approvalsForCard.map((a) => effectiveApprovalStatus(a, now));
  if (statuses.includes("pending")) return { state: "pending", live: null, daysLeft: null };
  if (statuses.includes("expired")) {
    const lapsed = approvalsForCard.find((a) => effectiveApprovalStatus(a, now) === "expired") ?? null;
    return { state: "expired", live: null, daysLeft: lapsed ? daysUntilExpiry(lapsed, now) : null };
  }
  if (statuses.includes("revoked")) return { state: "revoked", live: null, daysLeft: null };
  return { state: "unsigned", live: null, daysLeft: null };
}

// ---------------------------------------------------------------------------
// Completeness — what a REVIEWER is told is missing (not a measurement)
// ---------------------------------------------------------------------------

export interface BiasFairnessAssessment {
  /** declared slots on the card */
  declared: number;
  /** slots whose status is 'assessed' */
  assessed: number;
  /** slots explicitly waived, with the waiver visible rather than implied */
  waived: number;
  /** 'assessed' slots carrying no resultRef — a claim with nowhere to check it */
  unevidenced: number;
  complete: boolean;
  /** always present, always the same sentence: this is a declaration check */
  disclaimer: string;
}

const BIAS_DISCLAIMER =
  "This is a DECLARATION check over the card's recorded slots. RegulAIt does not measure bias or " +
  "fairness — measuring requires running the model against a purpose-built dataset. A 'complete' " +
  "result means an assessment was recorded and pointed at evidence, never that the model is fair.";

export function assessBiasFairness(entries: BiasFairnessEntryInput[]): BiasFairnessAssessment {
  const declared = entries.length;
  const assessed = entries.filter((e) => e.status === "assessed").length;
  const waived = entries.filter((e) => e.status === "waived").length;
  const unevidenced = entries.filter(
    (e) => e.status === "assessed" && !(e.resultRef && e.resultRef.trim()),
  ).length;
  return {
    declared,
    assessed,
    waived,
    unevidenced,
    // complete = at least one slot, every slot resolved (assessed or waived),
    // and every 'assessed' slot points somewhere. An empty list is NEVER
    // complete — "we did not look" must not read the same as "we looked".
    complete: declared > 0 && assessed + waived === declared && unevidenced === 0,
    disclaimer: BIAS_DISCLAIMER,
  };
}

export interface CardCompleteness {
  complete: boolean;
  missing: string[];
  bias: BiasFairnessAssessment;
}

export function assessCardCompleteness(card: {
  intendedUse: string;
  limitations?: string | null;
  dataClaims?: Record<string, unknown> | null;
  biasFairness: BiasFairnessEntryInput[];
  standardRefs?: string[] | null;
  evidenceCount?: number;
}): CardCompleteness {
  const missing: string[] = [];
  if (!card.intendedUse.trim()) missing.push("intended_use");
  if (!card.limitations || !card.limitations.trim()) missing.push("limitations");
  if (!card.dataClaims || Object.keys(card.dataClaims).length === 0) missing.push("data_claims");
  const bias = assessBiasFairness(card.biasFairness);
  if (!bias.complete) missing.push("bias_fairness");
  if ((card.evidenceCount ?? 0) === 0) missing.push("evidence");
  return { complete: missing.length === 0, missing, bias };
}

// ---------------------------------------------------------------------------
// The dispatch gate decision
// ---------------------------------------------------------------------------

export type MrmGateReason =
  | "not_enforced"
  | "approved"
  | "no_card"
  | "no_approval"
  | "expired"
  | "revoked";

export interface MrmGateDecision {
  allowed: boolean;
  reason: MrmGateReason;
  /** the STABLE audit ruleId for this outcome */
  ruleId: string;
  detail: string;
  /** which card/approval carried the decision, when there is one */
  cardId: string | null;
  approvalId: string | null;
  /** for an expired outcome: when it lapsed, so the refusal names the date */
  validUntil: string | null;
}

export interface MrmGateCard {
  id: string;
  intendedUse: string;
  approvals: Array<MrmApprovalLike & { id: string }>;
}

/**
 * THE GATE. Given every model card for the model about to be dispatched, decide
 * whether the dispatch may proceed.
 *
 * Fail-safe by construction:
 *  - `enforced: false` short-circuits to allowed — today's behaviour, byte
 *    identical, no card lookup consequence at all.
 *  - Otherwise the dispatch proceeds ONLY on a LIVE approval, recomputed from
 *    `validUntil` against `now`. No card, no approved record, a lapsed record,
 *    or a revoked one all refuse. There is no "warn" tier and no grace period:
 *    ADR-0045 §4 says refuse, and a gate with a soft edge is not a gate.
 *  - The three refusal outcomes carry DIFFERENT ruleIds (`mrm-no-card`,
 *    `mrm-approval-required`, `mrm-approval-expired`) so an operator reading the
 *    audit trail can tell "never reviewed" from "review lapsed" — very
 *    different remediation — while the caller sees one stable error code.
 */
export function evaluateMrmGate(input: {
  enforced: boolean;
  cards: MrmGateCard[];
  now: Date;
}): MrmGateDecision {
  if (!input.enforced) {
    return {
      allowed: true,
      reason: "not_enforced",
      ruleId: "mrm-not-enforced",
      detail: "model risk management is DECLARED but not enforced by this deployment",
      cardId: null,
      approvalId: null,
      validUntil: null,
    };
  }
  if (input.cards.length === 0) {
    return {
      allowed: false,
      reason: "no_card",
      ruleId: "mrm-no-card",
      detail:
        "no model card exists for this model — it has never been reviewed for any intended use, " +
        "and mrmEnforced refuses dispatch of an unreviewed model",
      cardId: null,
      approvalId: null,
      validUntil: null,
    };
  }
  for (const card of input.cards) {
    const live = card.approvals.find((a) => isLiveApproval(a, input.now));
    if (live) {
      return {
        allowed: true,
        reason: "approved",
        ruleId: "mrm-approved",
        detail: `model card '${card.intendedUse}' carries a live risk sign-off`,
        cardId: card.id,
        approvalId: live.id,
        validUntil: live.validUntil ? new Date(live.validUntil).toISOString() : null,
      };
    }
  }
  // No live acceptance. Prefer the most specific refusal: a LAPSED approval is
  // a different operational story from one that was never granted.
  const lapsed = input.cards
    .flatMap((c) => c.approvals.map((a) => ({ card: c, a })))
    .filter(({ a }) => effectiveApprovalStatus(a, input.now) === "expired")
    .sort((x, y) => (toMs(y.a.validUntil) ?? 0) - (toMs(x.a.validUntil) ?? 0))[0];
  if (lapsed) {
    const until = lapsed.a.validUntil ? new Date(lapsed.a.validUntil).toISOString() : null;
    return {
      allowed: false,
      reason: "expired",
      ruleId: "mrm-approval-expired",
      detail:
        `the risk sign-off on model card '${lapsed.card.intendedUse}' LAPSED` +
        (until ? ` on ${until}` : "") +
        " — recertify it (a new sign-off superseding the old one) to restore dispatch",
      cardId: lapsed.card.id,
      approvalId: lapsed.a.id,
      validUntil: until,
    };
  }
  const revoked = input.cards
    .flatMap((c) => c.approvals.map((a) => ({ card: c, a })))
    .find(({ a }) => effectiveApprovalStatus(a, input.now) === "revoked");
  if (revoked) {
    return {
      allowed: false,
      reason: "revoked",
      ruleId: "mrm-approval-revoked",
      detail: `the risk sign-off on model card '${revoked.card.intendedUse}' was REVOKED`,
      cardId: revoked.card.id,
      approvalId: revoked.a.id,
      validUntil: null,
    };
  }
  return {
    allowed: false,
    reason: "no_approval",
    ruleId: "mrm-approval-required",
    detail:
      `a model card exists for this model ('${input.cards[0]!.intendedUse}') but carries no approved ` +
      "risk sign-off — request one through the Approvals Queue",
    cardId: input.cards[0]!.id,
    approvalId: null,
    validUntil: null,
  };
}

/**
 * The HONEST POSTURE LABEL (ADR-0045 §4, copied from ADR-0024's shape). The UI
 * must never say "enforced" when a toggle does not back it, and must never say
 * "not applicable" when cards exist and are simply inert.
 */
export function mrmPosture(input: { enforced: boolean; cardCount: number; approvedCount: number }): {
  posture: "enforced" | "declared" | "absent";
  label: string;
} {
  if (input.enforced) {
    return {
      posture: "enforced",
      label:
        "ENFORCED by this deployment — a dispatch of a model with no unexpired approved card is refused (409)",
    };
  }
  if (input.cardCount > 0) {
    return {
      posture: "declared",
      label:
        "DECLARED but NOT enforced — cards and sign-offs are recorded and expire, but nothing is refused at dispatch. " +
        "Turn on mrmEnforced to make this a gate.",
    };
  }
  return {
    posture: "absent",
    label: "No model cards exist. An empty registry enforces nothing, whatever the toggle says.",
  };
}
