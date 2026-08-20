/**
 * ADR-0088 — THE EXTERNAL-SCORER CONTRACT AND ITS PURE DECISION LOGIC.
 *
 * The refusal to build or fake an in-house scoring model stands (gap L14,
 * market analysis §4.8: "a partnership or an adapter, not a build"). What an
 * operator MAY do is register a Fiddler-class scoring endpoint they run or
 * buy, and name it from an eval scorer config for a judge-backed metric. The
 * operator brings the instrument; the gateway brings the governance — and
 * every score says where it came from.
 *
 * Three honesty rules, enforced here and in the gateway adapter:
 *
 *  1. METHOD PROVENANCE. A score this instrument produces is stamped
 *     `method: "external:<name>"` — never `lexical-idf-overlap`, never
 *     `model-judged`. The three method families are never blended.
 *  2. THE ADR-0067/0072 REFUSAL CARRIES OVER. A config that names an external
 *     scorer which is unknown / disabled / not claiming that kind / not
 *     reachable refuses the WHOLE RUN with a 422 before a single row is
 *     written — exactly the judge-unreachable path. A mid-run failure is a
 *     recorded scorer ERROR (the `judge_failed` idiom), never a silent 0 or 1.
 *  3. LEXICAL METRICS NEVER ROUTE EXTERNALLY. `externalScorer` is only legal
 *     on a judge-backed kind; a deterministic kind carrying it is refused at
 *     authoring time, and the runner's deterministic branch never consults it.
 *
 * THE WIRE CONTRACT IS OURS, NOT THE VENDOR'S. One POST to the registered
 * baseUrl:
 *
 *   → { "input": string, "output": string, "context": string[],
 *       "scorerKind": string }
 *   ← { "score": number in [0,1], "reasons"?: string[] }
 *
 * An operator whose vendor speaks a different dialect (Fiddler's own API,
 * Lakera's, …) runs a thin translation shim they control — this gateway does
 * not chase vendor API shapes, and says so in ADR-0088.
 *
 * Everything in this file is pure — no I/O, no clock, no fetch — so the
 * decision logic is exhaustively testable without a database or a network.
 */

import { z } from "zod";
import { JUDGE_BACKED_SCORER_KINDS } from "./evals.js";

// ---------------------------------------------------------------------------
// method provenance
// ---------------------------------------------------------------------------

/** the `method` stamp on every row an external instrument scored */
export function externalScorerMethod(name: string): `external:${string}` {
  return `external:${name}`;
}

// ---------------------------------------------------------------------------
// the request/response contract
// ---------------------------------------------------------------------------

/** what the gateway POSTs to the registered endpoint — the whole contract */
export interface ExternalScorerRequest {
  /** the RAW case input (never the context-framed dispatch prompt — the
   * context rides separately, chunk boundaries intact) */
  input: string;
  /** the agent's output, post-guardrail/PII, exactly what local scorers see */
  output: string;
  context: string[];
  scorerKind: string;
}

export interface ExternalScorerVerdict {
  score: number;
  reasons: string[];
}

/** bounded: a vendor's `reasons` array is capped, not trusted */
export const EXTERNAL_SCORER_MAX_REASONS = 20;
export const EXTERNAL_SCORER_MAX_REASON_CHARS = 500;

/**
 * Parse an external endpoint's reply. Deliberately STRICT where the judge
 * parser is tolerant: this is a machine contract we published, not a model's
 * prose. A reply that is not a JSON object with a FINITE NUMBER `score`
 * inside [0,1] is a scorer ERROR — never clamped, never coerced, never a
 * silent 0 or 1. (ADR-0068's errored-trial lesson: an error is an error, not
 * a measurement.)
 */
export function parseExternalScorerResponse(
  raw: string,
): { ok: true; verdict: ExternalScorerVerdict } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "response is not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "response is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const score = obj.score;
  if (typeof score !== "number") {
    return { ok: false, error: "response has no numeric `score` — a non-conforming reply is an error, never a default" };
  }
  if (!Number.isFinite(score)) {
    return { ok: false, error: `\`score\` is not a finite number (${String(score)})` };
  }
  if (score < 0 || score > 1) {
    return {
      ok: false,
      error: `\`score\` ${score} is outside [0,1] — refused rather than clamped, because a clamp would manufacture a measurement the instrument never made`,
    };
  }
  let reasons: string[] = [];
  if (obj.reasons !== undefined) {
    if (!Array.isArray(obj.reasons) || obj.reasons.some((r) => typeof r !== "string")) {
      return { ok: false, error: "`reasons` must be an array of strings when present" };
    }
    reasons = (obj.reasons as string[])
      .slice(0, EXTERNAL_SCORER_MAX_REASONS)
      .map((r) => (r.length > EXTERNAL_SCORER_MAX_REASON_CHARS ? `${r.slice(0, EXTERNAL_SCORER_MAX_REASON_CHARS)}…` : r));
  }
  return { ok: true, verdict: { score, reasons } };
}

// ---------------------------------------------------------------------------
// run pre-flight — the ADR-0067/0072 refusal, extended to the external path
// ---------------------------------------------------------------------------

/** one judge-backed case's request to be scored externally */
export interface ExternalScorerUse {
  kind: string;
  scorer: string;
}

/** the facts the gateway gathered about one registered scorer, as data */
export interface ExternalScorerFacts {
  name: string;
  enabled: boolean;
  scorerKinds: readonly string[];
  /** the egress guard's verdict on the baseUrl (and the data-key check for an
   * authenticated scorer), decided by the caller — this function only judges */
  reachable: boolean;
  detail?: string | null;
}

export type ExternalScorerAvailability =
  | { available: true }
  | {
      available: false;
      error:
        | "external_scorer_unknown"
        | "external_scorer_disabled"
        | "external_scorer_kind_mismatch"
        | "external_scorer_unreachable";
      scorer: string;
      metrics: string[];
      reason: string;
    };

const REFUSAL_TAIL =
  "A named external instrument that cannot honestly score is refused before any row is written — the run " +
  "will NOT fall back to the lexical estimate or to a model judge under the external scorer's name.";

/**
 * THE PRE-FLIGHT DECISION for externally-scored cases, pure and exhaustively
 * testable. Mirrors `judgeAvailabilityFor`: called BEFORE the `eval_runs` row
 * is inserted, so a refusal leaves no run, no results, and no partially
 * scored suite a later reader could mistake for a measurement.
 */
export function externalScorerAvailabilityFor(
  uses: ReadonlyArray<ExternalScorerUse>,
  registry: ReadonlyArray<ExternalScorerFacts>,
): ExternalScorerAvailability {
  for (const use of uses) {
    const metrics = [...new Set(uses.filter((u) => u.scorer === use.scorer).map((u) => u.kind))];
    const facts = registry.find((r) => r.name === use.scorer);
    if (!facts) {
      return {
        available: false,
        error: "external_scorer_unknown",
        scorer: use.scorer,
        metrics,
        reason:
          `this dataset version names external scorer '${use.scorer}' for [${metrics.join(", ")}], and no ` +
          `registered external scorer has that name. ${REFUSAL_TAIL}`,
      };
    }
    if (!facts.enabled) {
      return {
        available: false,
        error: "external_scorer_disabled",
        scorer: use.scorer,
        metrics,
        reason:
          `external scorer '${use.scorer}' is registered but DISABLED — an admin must run its connection ` +
          `test and enable it before a run may use it. ${REFUSAL_TAIL}`,
      };
    }
    if (!facts.scorerKinds.includes(use.kind)) {
      return {
        available: false,
        error: "external_scorer_kind_mismatch",
        scorer: use.scorer,
        metrics: [use.kind],
        reason:
          `external scorer '${use.scorer}' does not claim to serve '${use.kind}' (it claims ` +
          `[${facts.scorerKinds.join(", ")}]). The claim is the operator's registration, not our validation ` +
          `of the instrument — but a metric the instrument never claimed is refused, not guessed. ${REFUSAL_TAIL}`,
      };
    }
    if (!facts.reachable) {
      return {
        available: false,
        error: "external_scorer_unreachable",
        scorer: use.scorer,
        metrics,
        reason:
          `external scorer '${use.scorer}' cannot be reached` +
          `${facts.detail ? ` — ${facts.detail}` : ""}. ${REFUSAL_TAIL}`,
      };
    }
  }
  return { available: true };
}

// ---------------------------------------------------------------------------
// admin write shapes (registration surface)
// ---------------------------------------------------------------------------

/** the kinds an external scorer may claim — EXACTLY the judge-backed set.
 * A deterministic (lexical) kind is not claimable, so the registration
 * surface cannot even express "route claim_support externally". */
export const externalScorerKindSchema = z.enum(
  JUDGE_BACKED_SCORER_KINDS as unknown as [string, ...string[]],
);

export const createExternalScorerSchema = z
  .object({
    name: z.string().min(1).max(120),
    baseUrl: z.string().url(),
    /** null/absent = an endpoint authenticating by network position. Sent as
     * `Authorization: Bearer <key>` when present. */
    apiKey: z.string().min(1).max(4096).nullable().optional(),
    /** which judge-backed kinds the instrument claims to serve */
    scorerKinds: z.array(externalScorerKindSchema).min(1).max(3),
    allowPlaintextHttp: z.boolean().optional(),
  })
  .strict();
export type CreateExternalScorer = z.infer<typeof createExternalScorerSchema>;

export const updateExternalScorerSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(1).max(4096).nullable().optional(),
    scorerKinds: z.array(externalScorerKindSchema).min(1).max(3).optional(),
    allowPlaintextHttp: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "nothing to update — provide at least one field",
  });
export type UpdateExternalScorer = z.infer<typeof updateExternalScorerSchema>;

export const setExternalScorerEnabledSchema = z.object({ enabled: z.boolean() }).strict();

/** the one honest sentence rendered wherever the external option is offered */
export const EXTERNAL_SCORER_DISCLOSURE =
  "An external score is the vendor's opinion. RegulAIt governs the call (egress allow-list, DNS-pinned " +
  "fetch, audit, register→test→enable) and records provenance (method: \"external:<name>\" on every row) — " +
  "it does not validate the instrument, and it never substitutes one method for another.";
