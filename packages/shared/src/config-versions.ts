/**
 * ADR-0048 — IMMUTABLE VERSIONING / CANARY / ROLLBACK, the PURE half.
 *
 *   THIS FILE            the vocabularies, the zod shapes, the DETERMINISTIC
 *                        canary bucketing, the version RESOLUTION, and the
 *                        eval-gated promotion decision. No db, no clock of its
 *                        own, no crypto dependency.
 *   `apps/gateway/src/config-versions.ts`
 *                        persistence, the admin API, the activation ledger,
 *                        the audit rows, and the dispatch-time resolver.
 *
 * THE ONE IDEA WORTH STATING TWICE
 *
 *   `canaryBucket` is a PURE FUNCTION OF A STABLE KEY. Not a coin flip, not
 *   `Math.random()`, not the wall clock. Two consequences, both load-bearing:
 *
 *     - A multi-turn run cannot flip its base prompt mid-conversation (§2:
 *       "sticky, not per-call"). The key is the run id, else the conversation
 *       id, else the user id.
 *     - The split is AUDITABLE and REPRODUCIBLE. Given the artifact id, the
 *       stable key and the percentage, anyone can recompute which side a
 *       request fell on, months later, from the ledger row alone.
 *
 *   The hash is FNV-1a 32-bit, implemented here rather than imported. It is not
 *   a cryptographic hash and does not need to be: nothing about bucketing is a
 *   secret, and what IS required — determinism, no dependency, and an
 *   implementation a reviewer can read in ten lines — is exactly what a
 *   crypto library would obscure. Stated so nobody later "upgrades" it to
 *   sha256 and silently re-buckets every in-flight canary.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const CONFIG_ARTIFACT_TYPES = [
  "agent_system_prompt",
  "agent_config",
  "approval_rule",
  "rate_limit",
  "data_scope_rule",
  "compliance_profile",
] as const;
export type ConfigArtifactType = (typeof CONFIG_ARTIFACT_TYPES)[number];

export const CONFIG_VERSION_STATUSES = [
  "draft",
  "canary",
  "active",
  "rolled_back",
  "superseded",
] as const;
export type ConfigVersionStatus = (typeof CONFIG_VERSION_STATUSES)[number];

/**
 * ADR-0048 §2 — WHICH artifact types canary LIVE and which canary in SHADOW.
 *
 * A prompt or a routing config sits on the GENERATIVE hot path: a 10% split
 * produces a 10% sample of differently-worded answers, which is a measurement.
 * A restriction rule sits on the ALLOW/DENY path: a 10%-enforced `deny` would
 * non-deterministically block real work, which is an outage with a percentage
 * sign on it. So restriction rules canary in shadow — evaluated and logged,
 * never enforcing — and the set is closed here rather than decided per call.
 */
export const LIVE_CANARY_ARTIFACT_TYPES: readonly ConfigArtifactType[] = [
  "agent_system_prompt",
  "agent_config",
];

export function canaryIsLive(t: ConfigArtifactType): boolean {
  return LIVE_CANARY_ARTIFACT_TYPES.includes(t);
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const createConfigVersionSchema = z
  .object({
    body: z.record(z.unknown()),
    label: z.string().min(1).max(200).nullish(),
    /** activate immediately (the behaviour an in-place UPDATE used to have,
     * except the previous version row survives) */
    activate: z.boolean().default(false),
  })
  .strict();
export type CreateConfigVersion = z.infer<typeof createConfigVersionSchema>;

export const activateConfigVersionSchema = z
  .object({ version: z.number().int().positive(), reason: z.string().max(2000).nullish() })
  .strict();

export const startCanarySchema = z
  .object({
    version: z.number().int().positive(),
    pct: z.number().int().min(1).max(99),
    reason: z.string().max(2000).nullish(),
  })
  .strict();

export const promoteCanarySchema = z
  .object({
    /** the ADR-0044 run that proves the canary did not regress */
    evalRunId: z.string().uuid().nullish(),
    /** the honest escape hatch — refused unless a reason accompanies it */
    override: z.boolean().default(false),
    reason: z.string().max(2000).nullish(),
  })
  .strict();

export const rollbackConfigSchema = z
  .object({ reason: z.string().min(1).max(2000) })
  .strict();

// ---------------------------------------------------------------------------
// Deterministic canary bucketing
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Deliberately simple and deliberately NOT cryptographic —
 * see the file header before replacing it. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in uint32 via Math.imul
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which of 100 buckets a request falls in. The artifact id is mixed in so two
 * artifacts canarying at the same time do not put the SAME users on the canary
 * side of both — a user who is unlucky once should not be systematically
 * unlucky everywhere.
 */
export function canaryBucket(artifactId: string, stableKey: string): number {
  return fnv1a32(`${artifactId}:${stableKey}`) % 100;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface VersionLike {
  id: string;
  version: number;
  status: ConfigVersionStatus;
  canaryPct: number | null;
  body: Record<string, unknown>;
}

export interface ResolvedVersion {
  versionId: string;
  version: number;
  body: Record<string, unknown>;
  /** true when the CANARY served this request */
  canary: boolean;
  /** the bucket, recorded so the split is reproducible from the ledger */
  bucket: number | null;
  reason: string;
}

/**
 * Pick the version that serves ONE request. Total, and total on purpose:
 *
 *  - no rows at all            → null (the caller falls back to the
 *                                pre-versioning value; behaviour-preserving)
 *  - active only               → active
 *  - active + canary, live     → canary iff bucket < pct, else active
 *  - active + canary, shadow   → ACTIVE always (the canary is evaluated
 *                                elsewhere and never enforces)
 *  - canary but no active      → the canary, because there is nothing else;
 *                                this is only reachable for an artifact whose
 *                                first version is being trialled
 */
export function resolveVersion(input: {
  artifactType: ConfigArtifactType;
  artifactId: string;
  versions: VersionLike[];
  stableKey: string;
}): ResolvedVersion | null {
  const active = input.versions.find((v) => v.status === "active") ?? null;
  const canary = input.versions.find((v) => v.status === "canary") ?? null;

  if (canary && canaryIsLive(input.artifactType)) {
    const bucket = canaryBucket(input.artifactId, input.stableKey);
    if (bucket < (canary.canaryPct ?? 0)) {
      return {
        versionId: canary.id,
        version: canary.version,
        body: canary.body,
        canary: true,
        bucket,
        reason: `canary v${canary.version} at ${canary.canaryPct}% — stable-key bucket ${bucket}`,
      };
    }
    if (active) {
      return {
        versionId: active.id,
        version: active.version,
        body: active.body,
        canary: false,
        bucket,
        reason: `active v${active.version} — stable-key bucket ${bucket} is outside the ${canary.canaryPct}% canary`,
      };
    }
    // a first-ever version being trialled: there is no active to fall back to
    return {
      versionId: canary.id,
      version: canary.version,
      body: canary.body,
      canary: true,
      bucket,
      reason: `canary v${canary.version} — no active version exists to fall back to`,
    };
  }

  if (active) {
    return {
      versionId: active.id,
      version: active.version,
      body: active.body,
      canary: false,
      bucket: null,
      reason:
        canary && !canaryIsLive(input.artifactType)
          ? `active v${active.version} — a canary exists but ${input.artifactType} canaries in SHADOW and never enforces`
          : `active v${active.version}`,
    };
  }
  return null;
}

/** the prompt out of an `agent_system_prompt` body, or null if the version
 * carries no prompt (a deliberately-cleared base) */
export function promptFromBody(body: Record<string, unknown>): string | null {
  const v = body["systemPrompt"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Eval-gated promotion (ADR-0048 §4)
// ---------------------------------------------------------------------------

export interface EvalEvidence {
  id: string;
  status: string;
  gatePassed: boolean | null;
  regression: boolean | null;
  /** the run must post-date the version it is claimed to prove */
  startedAt: Date;
}

export interface PromotionDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
  evalRunId: string | null;
  override: boolean;
}

/**
 * A canary may be promoted to active when an ADR-0044 run against a version
 * created NO EARLIER than the canary passed its thresholds. Otherwise promotion
 * is possible only as an explicit, audited manual override WITH A REASON —
 * `ruleId: canary-promote-override`, exactly as §4 names it.
 *
 * The "no earlier than" check is the part that makes this a gate rather than a
 * checkbox: without it, a passing run from before the change would satisfy the
 * gate for the change it never measured.
 */
export function evaluatePromotion(input: {
  canaryCreatedAt: Date;
  evidence: EvalEvidence | null;
  override: boolean;
  reason: string | null | undefined;
}): PromotionDecision {
  const ev = input.evidence;
  if (ev && ev.status === "completed" && ev.gatePassed === true && ev.startedAt >= input.canaryCreatedAt) {
    return {
      allowed: true,
      ruleId: "canary-promoted-eval-gated",
      reason: `promotion gated by ADR-0044 eval run ${ev.id}, which passed against this canary version`,
      evalRunId: ev.id,
      override: false,
    };
  }

  const why = !ev
    ? "no ADR-0044 eval run was cited"
    : ev.startedAt < input.canaryCreatedAt
      ? `eval run ${ev.id} predates the canary version and therefore never measured it`
      : ev.status !== "completed"
        ? `eval run ${ev.id} is '${ev.status}', not completed`
        : `eval run ${ev.id} did not pass the regression thresholds`;

  if (!input.override) {
    return {
      allowed: false,
      ruleId: "canary-promote-blocked",
      reason: `${why} — promote with an explicit override and a reason, or run an eval that passes`,
      evalRunId: ev?.id ?? null,
      override: false,
    };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return {
      allowed: false,
      ruleId: "canary-promote-override-no-reason",
      reason: "an override of the quality gate must state why; an unexplained bypass is not accepted",
      evalRunId: ev?.id ?? null,
      override: true,
    };
  }
  return {
    allowed: true,
    ruleId: "canary-promote-override",
    reason: `promoted WITHOUT a passing eval gate (${why}) — manual override: ${input.reason}`,
    evalRunId: ev?.id ?? null,
    override: true,
  };
}

/**
 * The stable key a dispatch buckets on, in ADR-0048 §2's priority order:
 * run id, else conversation id, else the initiating user. Extracted so the
 * ordering is one testable decision rather than an inline `??` chain.
 */
export function stableKeyFor(ctx: {
  runId?: string | null;
  conversationId?: string | null;
  userId: string;
}): string {
  return ctx.runId ?? ctx.conversationId ?? ctx.userId;
}
