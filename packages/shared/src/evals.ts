/**
 * ADR-0044 — the EVALUATION HARNESS's pure half: the scorer registry, the
 * aggregate math, and the baseline-comparison gate decision. No I/O, no clock,
 * no db, no provider. Exactly the split ADR-0042's guardrails and §8.4's PII
 * classifier already use, and for the same reason: the part of a gate that
 * decides pass/fail must be executable in a unit test with no infrastructure,
 * or nobody can prove the gate is a gate.
 *
 * WHAT IS DETERMINISTIC HERE AND WHAT IS NOT — READ THIS BEFORE TRUSTING A SCORE
 *
 *   Six of the seven scorer kinds below (`exact`, `contains`, `regex`,
 *   `json_schema`, `numeric`, `rubric`) are pure functions of (expected,
 *   output, config). Same inputs, same score, forever, at zero cost and zero
 *   variance. They are the ones a BLOCKING gate should be built on.
 *
 *   The seventh, `llm_as_judge`, is a model call. It costs tokens, it varies
 *   run to run, and the judge is itself an agent that can regress. This module
 *   contains only its *deterministic* parts — the prompt builder and the
 *   verdict parser — so those can be tested; the judgment itself lives behind
 *   the `EvalJudge` interface and is executed by the gateway through the one
 *   governed dispatch core (entitlement-checked, metered, audited). ADR-0044's
 *   own words: lean on deterministic scorers for anything load-bearing and
 *   treat the judge as corroboration.
 *
 * SCORE / PASS SEPARATION. Every scorer returns a continuous `score` in [0,1]
 * AND a boolean `passed`. `passed` is always `score >= threshold` where the
 * threshold defaults to 1 (config may lower it for the graded kinds). The
 * continuous score is what the regression delta is computed from — a suite
 * that only ever reported booleans could not distinguish "still failing the
 * same way" from "failing much worse", which is the signal a regression gate
 * exists to see.
 */
import { z } from "zod";
import {
  DEFAULT_CLAIM_THRESHOLD,
  scoreAnswerRelevance,
  scoreClaimSupport,
  scoreContextPrecision,
  scoreContextRecall,
  type ClaimSupport,
  type JudgedClaimVerdict,
} from "./groundedness.js";
import { JUDGE_PANEL_LIMITS, judgePanelSchema } from "./judge-panels.js";
import { fencedBlockBody, firstBraceBlock } from "./linear-scan.js";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const EVAL_SCORER_KINDS = [
  "exact",
  "contains",
  "regex",
  "json_schema",
  "numeric",
  "rubric",
  "llm_as_judge",
  // ADR-0067 — groundedness. The first four are locally computable and need no
  // provider; the last two are model calls that REFUSE rather than degrade.
  "claim_support",
  "context_precision",
  "context_recall",
  "answer_relevance",
  "groundedness_judge",
  "answer_relevance_judge",
] as const;
export type EvalScorerKind = (typeof EVAL_SCORER_KINDS)[number];

/**
 * THE MODEL-BACKED KINDS, enumerated EXPLICITLY rather than derived by
 * exclusion. ADR-0044 wrote this as `filter(k => k !== "llm_as_judge")`, which
 * was correct with one judged kind and becomes a silent hazard with three: the
 * default for a newly added kind under that rule is "deterministic", so a
 * future model-backed scorer would be classified as free, offline and
 * non-degrading by DEFAULT. Reversing the polarity makes the dangerous case the
 * one you have to opt into.
 */
export const JUDGE_BACKED_SCORER_KINDS = [
  "llm_as_judge",
  "groundedness_judge",
  "answer_relevance_judge",
] as const;
export type JudgeBackedScorerKind = (typeof JUDGE_BACKED_SCORER_KINDS)[number];

export function isJudgeBackedScorer(kind: string): kind is JudgeBackedScorerKind {
  return (JUDGE_BACKED_SCORER_KINDS as readonly string[]).includes(kind);
}

/**
 * THE KINDS THAT REFUSE A RUN OUTRIGHT when no model is reachable.
 *
 * ADR-0072 (2026-08-07) — THIS IS NOW ALL THREE JUDGE-BACKED KINDS, AND THE
 * PREVIOUS ASYMMETRY IS GONE ON PURPOSE.
 *
 * ADR-0067 introduced this list with only its own two kinds in it, and said in
 * writing that ADR-0044's `llm_as_judge` keeping its score-0-with-a-named-error
 * behaviour was the weaker posture, left alone only because changing it would
 * amend an accepted ADR from inside a slice about a different metric. ADR-0072
 * is that amendment, taken deliberately and with an explicit baseline reset.
 *
 * The reason the old behaviour was wrong IN KIND rather than merely weak: a
 * MISSING INSTRUMENT was being recorded as a BAD MEASUREMENT. The zero was then
 * averaged into `meanScore`, compared against a drift baseline, read by a
 * promotion gate as "the model answered badly", and stored where an ADR-0045
 * model card could cite it. Nothing downstream could tell "we could not measure
 * this" from "we measured it and it was terrible".
 *
 * So `refusesWithoutJudge` and `isJudgeBackedScorer` are now the same predicate
 * over the same members — but they remain SEPARATE names, because they answer
 * different questions ("does this cost tokens?" vs "does a missing judge kill
 * the run?") and a future scorer could legitimately answer them differently.
 * The boundary test in `groundedness.test.ts` pins the membership in BOTH
 * directions so neither can drift by accident.
 */
export const JUDGE_REFUSING_SCORER_KINDS = [
  "llm_as_judge",
  "groundedness_judge",
  "answer_relevance_judge",
] as const;

export function refusesWithoutJudge(kind: string): boolean {
  return (JUDGE_REFUSING_SCORER_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// ADR-0072 — SCORING SEMANTICS VERSIONING (the baseline reset)
// ---------------------------------------------------------------------------

/**
 * WHAT A STORED SCORE MEANS, VERSIONED.
 *
 * ADR-0072 changed the MEANING of two stored numbers without changing their
 * shape, which is the single most dangerous kind of change a measurement system
 * can make: every old row still parses, still averages, still renders, and is
 * no longer comparable to a new one. A drift gate that silently compares across
 * that boundary reports a regression (or an improvement) that never happened —
 * exactly the class of bug ADR-0072 exists to remove, so it must not introduce
 * one.
 *
 * The fix is to make the semantics a FIELD on the row rather than a fact about
 * the deploy date. Every `eval_runs` / `redteam_runs` row states which semantics
 * produced it; migration 0083 stamps every pre-existing row as version 1 by
 * DEFAULT and mutates nothing else. History is MARKED, never rewritten and never
 * deleted.
 *
 * Version 1 — ADR-0044 + ADR-0057 + ADR-0067 as originally accepted:
 *   • an `llm_as_judge` case with no judge scored 0 and was averaged in
 *   • a governance-BLOCKED red-team dispatch scored as a probe DEFEAT
 * Version 2 — ADR-0072:
 *   • a missing judge REFUSES the run (422) and writes nothing
 *   • a governance-blocked red-team dispatch is a PLATFORM HOLD, never a defeat
 */
export const SCORING_SEMANTICS_VERSION = 2;

/** the semantics every row written before ADR-0072 was produced under */
export const LEGACY_SCORING_SEMANTICS_VERSION = 1;

export const SCORING_SEMANTICS_CHANGELOG: ReadonlyArray<{
  version: number;
  adr: string;
  summary: string;
}> = [
  {
    version: 1,
    adr: "ADR-0044 / ADR-0057 / ADR-0067",
    summary:
      "An llm_as_judge case with no judge configured scored 0 and was averaged into meanScore. A red-team probe whose dispatch was stopped by a governance decision was scored as a failed eval case, which red-team polarity read as the ATTACK SUCCEEDING.",
  },
  {
    version: 2,
    adr: "ADR-0072",
    summary:
      "A judge-backed case with no dispatchable judge REFUSES the whole run with a 422 before any row is written — a missing instrument is never recorded as a bad measurement. A governance-blocked red-team dispatch is a PLATFORM HOLD: the probe is not defeated, it is counted in platform_held, and it never enters the attack-success rate as a success.",
  },
];

export function scoringSemanticsSummary(version: number): string {
  return (
    SCORING_SEMANTICS_CHANGELOG.find((c) => c.version === version)?.summary ??
    `unknown scoring semantics version ${version}`
  );
}

/**
 * THE ONE SENTENCE an operator needs when their history straddles the change.
 * Deliberately names re-pinning, because a pinned baseline is the case a person
 * has to act on rather than merely read about.
 */
export function scoringSemanticsMismatchReason(current: number, baseline: number): string {
  return (
    `SCORING-SEMANTICS MISMATCH: this run was scored under semantics v${current} and the baseline was scored under ` +
    `v${baseline}. Those numbers are not comparable — v${baseline}: ${scoringSemanticsSummary(baseline)} ` +
    `v${current}: ${scoringSemanticsSummary(current)} ` +
    `Comparing them would report a drift that never happened, so no delta is computed. ` +
    `RE-PIN the baseline: run this dataset version and agent again under the current semantics and pin THAT run.`
  );
}

/** The scorer kinds that need no model, no network and no key. */
export const DETERMINISTIC_SCORER_KINDS = EVAL_SCORER_KINDS.filter(
  (k) => !isJudgeBackedScorer(k),
) as ReadonlyArray<Exclude<EvalScorerKind, JudgeBackedScorerKind>>;

export function isDeterministicScorer(kind: string): boolean {
  return (DETERMINISTIC_SCORER_KINDS as readonly string[]).includes(kind);
}

/** The ADR-0067 kinds that are meaningless without the context an answer was
 * supposed to be grounded in. A case using one of these MUST carry context; the
 * authoring-time validator refuses otherwise. */
export const CONTEXT_REQUIRED_SCORER_KINDS = [
  "claim_support",
  "context_precision",
  "context_recall",
  "groundedness_judge",
] as const;

export function requiresContext(kind: string): boolean {
  return (CONTEXT_REQUIRED_SCORER_KINDS as readonly string[]).includes(kind);
}

export interface EvalScorerInfo {
  id: EvalScorerKind;
  deterministic: boolean;
  /** does running this scorer cost a governed model call? */
  modelBacked: boolean;
  summary: string;
  /** the honest failure mode, rendered next to the scorer in the admin UI */
  limits: string;
}

/**
 * The registry, rendered verbatim in the admin screen. Each entry states what
 * it CANNOT do next to what it does — the same discipline ADR-0042's detector
 * registry uses, so an admin reads the limitation at the moment they choose a
 * scorer rather than in an ADR they will never open.
 */
export function evalScorerRegistry(): EvalScorerInfo[] {
  return [
    {
      id: "exact",
      deterministic: true,
      modelBacked: false,
      summary:
        "Exact match against `expected`: normalized string equality, or deep JSON equality when `expected` is an object or array.",
      limits:
        "Brittle by design. Any rewording, added preamble, or changed key order in prose fails it. Use it for structured or single-token outputs, not for free text.",
    },
    {
      id: "contains",
      deterministic: true,
      modelBacked: false,
      summary:
        "Required substrings (all, or any) plus optional forbidden substrings. Graded: score is the fraction of required needles found.",
      limits:
        "Substring presence is not comprehension. An output can contain every required phrase and still be wrong, and a correct paraphrase scores zero.",
    },
    {
      id: "regex",
      deterministic: true,
      modelBacked: false,
      summary: "A single regular expression that must match (or, with negate, must not match).",
      limits:
        "Only as good as the pattern. A pattern that matches everything is a scorer that passes everything — a suite where no case can fail proves nothing.",
    },
    {
      id: "json_schema",
      deterministic: true,
      modelBacked: false,
      summary:
        "The output must parse as JSON and conform to a schema. Supports a documented subset: type, required, properties, items, enum, minimum/maximum, minLength/maxLength.",
      limits:
        "A SHAPE check, not a correctness check — a structurally perfect answer with wrong values scores 1.0. Unsupported schema keywords are ignored, never guessed at.",
    },
    {
      id: "numeric",
      deterministic: true,
      modelBacked: false,
      summary:
        "Extracts the first number in the output and compares it to a numeric `expected` within an absolute (or relative) tolerance.",
      limits:
        "Takes the FIRST number it sees. An output that restates the question numerically before answering will be scored on the wrong number.",
    },
    {
      id: "rubric",
      deterministic: true,
      modelBacked: false,
      summary:
        "A weighted checklist: each criterion is a deterministic contains/regex match with a weight. Score is the weighted fraction satisfied, and the per-criterion outcome is stored.",
      limits:
        "Makes quality explicit and reviewable but is still only its criteria. A rubric nobody revises measures last quarter's definition of good.",
    },
    {
      id: "llm_as_judge",
      deterministic: false,
      modelBacked: true,
      summary:
        "A judge agent from the registry scores the output against `expected`/`rubric`. The judge call runs through the one governed dispatch core, so it is entitlement-checked, metered into usage_events, and audited like any other dispatch.",
      limits:
        "NEEDS A PROVIDER AND REFUSES WITHOUT ONE (ADR-0072, changed from ADR-0044's original behaviour): a run whose cases use this metric is rejected with 422 before any row is written when no dispatchable judge agent is named — it no longer scores the case zero, because a missing instrument is not a bad answer. Beyond that: NON-DETERMINISTIC AND NOT FREE. Scores jitter run to run, the judge is itself an agent that can regress, and a gate built purely on it will occasionally red a good change. Corroboration, not a load-bearing gate.",
    },
    // ------------------------------------------------------------------
    // ADR-0067 — groundedness
    // ------------------------------------------------------------------
    {
      id: "claim_support",
      deterministic: true,
      modelBacked: false,
      summary:
        "Splits the answer into claims and scores each against the case's supplied context by IDF-weighted term coverage of the single best-matching chunk. Score is the supported fraction, and the claims that FAILED are stored verbatim on the result row.",
      limits:
        "LEXICAL, NOT ENTAILMENT. It catches fabricated names, figures and whole-cloth invention (an unsupported number caps the claim's score outright). It CANNOT see negation flips, swapped attribution ('Ana approved Ben's change' vs the reverse), or invalid reasoning over valid premises, and it scores a correct paraphrase written in synonyms as UNSUPPORTED. Use `groundedness_judge` when entailment is the claim you need to make.",
    },
    {
      id: "context_precision",
      deterministic: true,
      modelBacked: false,
      summary:
        "Retrieval utilisation: the fraction of supplied context chunks that were the best support for at least one supported claim. Answers 'how much of what you retrieved did the answer actually rest on'.",
      limits:
        "NOT Ragas's rank-aware context precision, which needs a relevance judgement this cannot make without a model. A chunk that was relevant but that the model ignored counts as UNUSED here, so a low score can mean a bad retriever or a lazy generator and this metric cannot tell you which.",
    },
    {
      id: "context_recall",
      deterministic: true,
      modelBacked: false,
      summary:
        "Measures the RETRIEVER, not the generator: the fraction of the reference answer's (`expected`) claims that the supplied context could support. Missing claims are listed — that is the retrieval gap.",
      limits:
        "Requires a reference answer, and inherits every lexical blind spot of claim_support. High claim-support with low context-recall is the signature of a model being faithful to context that never contained the answer; that diagnosis is the metric's whole value, and it is a hint, not a proof.",
    },
    {
      id: "answer_relevance",
      deterministic: true,
      modelBacked: false,
      summary:
        "Does the answer address the question at all: the greater of the question's distinct-term coverage and the question/answer TF-IDF cosine. A non-committal answer ('I don't know', 'the context does not say') scores 0 with the reason stated.",
      limits:
        "TOPICAL OVERLAP, NOT CORRECTNESS. An answer that restates the question and then says something false scores HIGH. A terse correct answer that shares little vocabulary with the question scores LOW. Alone it proves only that the model did not change the subject.",
    },
    {
      id: "groundedness_judge",
      deterministic: false,
      modelBacked: true,
      summary:
        "A judge agent decides, claim by claim, whether the answer is ENTAILED BY the supplied context — the measurement `claim_support` approximates. Per-claim verdicts and reasons are stored. Runs through the one governed dispatch core: entitlement-checked, metered, audited.",
      limits:
        "NEEDS A PROVIDER AND REFUSES WITHOUT ONE. A run whose cases use this metric is rejected with 422 before any row is written when no dispatchable judge agent is named — it will NEVER quietly fall back to the lexical estimate under this name. Beyond that it carries every llm_as_judge caveat: non-deterministic, not free, and the judge can itself regress.",
    },
    {
      id: "answer_relevance_judge",
      deterministic: false,
      modelBacked: true,
      summary:
        "A judge agent rates how directly the answer addresses the question, without the vocabulary-overlap assumption the lexical version depends on.",
      limits:
        "NEEDS A PROVIDER AND REFUSES WITHOUT ONE, exactly like groundedness_judge. Non-deterministic and not free; a judge is an opinion, not an oracle.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Scorer configuration (zod, per kind)
// ---------------------------------------------------------------------------

const matchConfig = z.object({
  /** substrings that must be present */
  needles: z.array(z.string().min(1)).default([]),
  /** true = any needle is enough; false (default) = all of them */
  anyOf: z.boolean().default(false),
  /** substrings whose presence forces a zero, regardless of the needles */
  forbidden: z.array(z.string().min(1)).default([]),
  caseSensitive: z.boolean().default(false),
});

export const evalScorerConfigSchema = z
  .object({
    /** score >= threshold ⇒ passed. Default 1 (nothing partial passes unless asked). */
    threshold: z.number().min(0).max(1).optional(),
    // exact
    caseSensitive: z.boolean().optional(),
    trim: z.boolean().optional(),
    // contains
    needles: z.array(z.string().min(1)).optional(),
    anyOf: z.boolean().optional(),
    forbidden: z.array(z.string().min(1)).optional(),
    // regex
    pattern: z.string().min(1).optional(),
    flags: z.string().max(8).optional(),
    negate: z.boolean().optional(),
    // json_schema
    schema: z.record(z.unknown()).optional(),
    // numeric
    tolerance: z.number().min(0).optional(),
    relative: z.boolean().optional(),
    // rubric
    criteria: z
      .array(
        matchConfig.partial().extend({
          id: z.string().min(1),
          weight: z.number().positive().default(1),
          pattern: z.string().min(1).optional(),
          flags: z.string().max(8).optional(),
        }),
      )
      .optional(),
    // llm_as_judge + the ADR-0067 judged metrics
    instructions: z.string().max(4000).optional(),
    // ADR-0067: a claim at or above this weighted-coverage score counts as
    // supported. Per-metric, per-case, and it is the dial an admin turns when
    // their corpus is unusually terse or unusually boilerplate-heavy.
    claimThreshold: z.number().min(0).max(1).optional(),
    // ADR-0088: the NAME of a registered external scorer that should score
    // this case INSTEAD of the model judge. Legal on judge-backed kinds only
    // (`validateScorerConfig` refuses it elsewhere — a lexical metric never
    // routes externally). Rows it scores are stamped `method:
    // "external:<name>"`, and a named-but-unusable scorer refuses the run
    // with 422 before any row is written, exactly like a missing judge.
    externalScorer: z.string().min(1).max(120).optional(),
  })
  .strict();
export type EvalScorerConfig = z.infer<typeof evalScorerConfigSchema>;

/**
 * Reject a scorer configuration that cannot possibly discriminate, at the
 * moment it is authored. A `contains` with no needles or a `regex` with no
 * pattern would pass every output ever produced, which is the single most
 * common way an eval suite becomes theatre. Returns an error string, or null
 * when the config is usable.
 */
export function validateScorerConfig(
  kind: EvalScorerKind,
  config: EvalScorerConfig,
  expected: unknown,
  /** ADR-0067: the retrieved/reference context the case carries. A groundedness
   * metric with no context is the groundedness equivalent of a `contains`
   * scorer with no needles — it would pass (or fail) every output alike. */
  context: ReadonlyArray<string> = [],
): string | null {
  if (requiresContext(kind) && context.length === 0) {
    return `${kind} scorer needs the case to carry \`context\` — groundedness is undefined without the material an answer was supposed to be grounded in`;
  }
  // ADR-0088: an external instrument may stand in for the MODEL JUDGE, and
  // for nothing else. A lexical metric routed to a network endpoint would be a
  // different measurement wearing a deterministic metric's name — the exact
  // dishonesty ADR-0067 exists to prevent — so it is refused at authoring
  // time, where the author can still fix it.
  if (config.externalScorer && !isJudgeBackedScorer(kind)) {
    return (
      `\`externalScorer\` is only legal on a judge-backed scorer kind (${JUDGE_BACKED_SCORER_KINDS.join(", ")}) — ` +
      `'${kind}' is computed locally and NEVER routes to an external endpoint`
    );
  }
  switch (kind) {
    case "exact":
      if (expected === null || expected === undefined) return "exact scorer needs an `expected` value";
      return null;
    case "contains":
      if (!config.needles?.length && !config.forbidden?.length) {
        return "contains scorer needs at least one needle or forbidden string — one with neither passes every output";
      }
      return null;
    case "regex": {
      if (!config.pattern) return "regex scorer needs a pattern";
      try {
        new RegExp(config.pattern, config.flags ?? "");
      } catch (e) {
        return `regex scorer pattern is invalid: ${(e as Error).message}`;
      }
      return null;
    }
    case "json_schema":
      if (!config.schema) return "json_schema scorer needs a schema";
      return null;
    case "numeric":
      if (typeof expected !== "number") return "numeric scorer needs a numeric `expected` value";
      return null;
    case "rubric":
      if (!config.criteria?.length) return "rubric scorer needs at least one criterion";
      for (const c of config.criteria) {
        if (!c.needles?.length && !c.pattern) {
          return `rubric criterion '${c.id}' needs needles or a pattern`;
        }
        if (c.pattern) {
          try {
            new RegExp(c.pattern, c.flags ?? "");
          } catch (e) {
            return `rubric criterion '${c.id}' pattern is invalid: ${(e as Error).message}`;
          }
        }
      }
      return null;
    case "llm_as_judge":
      if (expected === null && !config.instructions) {
        return "llm_as_judge scorer needs an `expected`/`rubric` reference or explicit instructions";
      }
      return null;
    case "context_recall":
      if (typeof expected !== "string" || expected.trim().length === 0) {
        return "context_recall scorer needs a string `expected` reference answer — it measures whether the RETRIEVER supplied what the ground truth needed";
      }
      return null;
    case "claim_support":
    case "context_precision":
    case "answer_relevance":
    case "groundedness_judge":
    case "answer_relevance_judge":
      // context (where required) is checked above; nothing else is mandatory —
      // these score the model's own output against the case, not against a
      // reference the author has to write.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface EvalScoreDetail {
  [k: string]: unknown;
}

export interface EvalScore {
  /** continuous quality in [0,1] — what the regression delta is computed from */
  score: number;
  passed: boolean;
  /** machine-readable evidence: which needles hit, which criteria failed, … */
  detail: EvalScoreDetail;
}

export interface DeterministicScoreInput {
  kind: Exclude<EvalScorerKind, JudgeBackedScorerKind>;
  expected: unknown;
  output: string;
  config: EvalScorerConfig;
  /** ADR-0067: the case's retrieved/reference context. Absent for every
   * pre-ADR-0067 scorer, which ignores it — so an existing call site is
   * byte-identical. */
  context?: ReadonlyArray<string> | undefined;
  /** ADR-0067: the case's input, needed by `answer_relevance` to know what
   * question the answer was supposed to address. */
  caseInput?: string | undefined;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round4 = (n: number) => Number(n.toFixed(4));

function norm(s: string, caseSensitive: boolean, trim: boolean): string {
  let out = trim ? s.trim().replace(/\s+/g, " ") : s;
  if (!caseSensitive) out = out.toLowerCase();
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidate = (fencedBlockBody(text, true) ?? text).trim();
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * A deliberately SMALL JSON-Schema subset validator. It supports exactly the
 * keywords listed in the registry entry and IGNORES everything else rather
 * than pretending to understand it — a validator that silently no-ops on
 * `oneOf` while reporting "valid" would be worse than not having one.
 * Returns the list of violations (empty = conformant).
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errs: string[] = [];
  const type = schema.type as string | undefined;
  const typeOf = (v: unknown): string =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;
  if (type) {
    const actual = typeOf(value);
    const ok =
      actual === type ||
      (type === "number" && (actual === "integer" || actual === "number")) ||
      (type === "object" && actual === "object");
    if (!ok) errs.push(`${path}: expected type ${type}, got ${actual}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errs.push(`${path}: value is not one of the permitted enum members`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errs.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errs.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errs.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errs.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errs.push(`${path}: missing required property '${req}'`);
    }
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) errs.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
      }
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    const items = schema.items as Record<string, unknown>;
    value.forEach((v, i) => errs.push(...validateAgainstSchema(v, items, `${path}[${i}]`)));
  }
  return errs;
}

function scoreContains(
  output: string,
  cfg: { needles: string[]; anyOf: boolean; forbidden: string[]; caseSensitive: boolean },
): { score: number; detail: EvalScoreDetail } {
  const hay = cfg.caseSensitive ? output : output.toLowerCase();
  const prep = (s: string) => (cfg.caseSensitive ? s : s.toLowerCase());
  const found = cfg.needles.filter((n) => hay.includes(prep(n)));
  const missing = cfg.needles.filter((n) => !hay.includes(prep(n)));
  const banned = cfg.forbidden.filter((n) => hay.includes(prep(n)));
  let score: number;
  if (banned.length > 0) score = 0;
  else if (cfg.needles.length === 0) score = 1; // forbidden-only check, nothing banned
  else if (cfg.anyOf) score = found.length > 0 ? 1 : 0;
  else score = found.length / cfg.needles.length;
  return { score, detail: { found, missing, forbiddenHits: banned } };
}

/**
 * The one deterministic scoring entry point. Pure: same inputs, same output,
 * no network, no clock, no key.
 */
export function scoreDeterministic(input: DeterministicScoreInput): EvalScore {
  const { kind, expected, output, config } = input;
  const context = input.context ?? [];
  const claimOpts = { claimThreshold: config.claimThreshold ?? DEFAULT_CLAIM_THRESHOLD };
  /** claims are slices of model output and inherit its storage posture: the
   * runner has already applied the PII/guardrail withholding, and these are
   * truncated by `scoreClaimSupport` and capped in number. */
  const claimDetail = (c: ClaimSupport) => ({
    claim: c.claim,
    score: c.score,
    supported: c.supported,
    bestChunk: c.bestChunk,
    missingTerms: c.missingTerms,
    ...(c.unsupportedNumbers.length > 0 ? { unsupportedNumbers: c.unsupportedNumbers } : {}),
    ...(c.negationMismatch ? { negationMismatch: true } : {}),
  });
  const threshold = config.threshold ?? 1;
  const finish = (score: number, detail: EvalScoreDetail): EvalScore => {
    const s = round4(clamp01(score));
    return { score: s, passed: s >= threshold, detail: { ...detail, threshold } };
  };

  switch (kind) {
    case "exact": {
      if (expected !== null && typeof expected === "object") {
        const parsed = tryParseJson(output);
        if (!parsed.ok) return finish(0, { reason: "output is not JSON", parseError: parsed.error });
        return finish(deepEqual(parsed.value, expected) ? 1 : 0, {
          reason: deepEqual(parsed.value, expected) ? "deep JSON equality" : "JSON differs from expected",
        });
      }
      const caseSensitive = config.caseSensitive ?? false;
      const trim = config.trim ?? true;
      const want = norm(String(expected ?? ""), caseSensitive, trim);
      const got = norm(output, caseSensitive, trim);
      return finish(want === got ? 1 : 0, { expectedNormalized: want, gotNormalized: got.slice(0, 500) });
    }
    case "contains": {
      const r = scoreContains(output, {
        needles: config.needles ?? [],
        anyOf: config.anyOf ?? false,
        forbidden: config.forbidden ?? [],
        caseSensitive: config.caseSensitive ?? false,
      });
      return finish(r.score, r.detail);
    }
    case "regex": {
      if (!config.pattern) return finish(0, { reason: "no pattern configured" });
      let re: RegExp;
      try {
        re = new RegExp(config.pattern, config.flags ?? "");
      } catch (e) {
        return finish(0, { reason: "invalid pattern", error: (e as Error).message });
      }
      const matched = re.test(output);
      const wanted = config.negate ? !matched : matched;
      return finish(wanted ? 1 : 0, { matched, negate: config.negate ?? false });
    }
    case "json_schema": {
      if (!config.schema) return finish(0, { reason: "no schema configured" });
      const parsed = tryParseJson(output);
      if (!parsed.ok) return finish(0, { reason: "output is not JSON", parseError: parsed.error });
      const errs = validateAgainstSchema(parsed.value, config.schema);
      return finish(errs.length === 0 ? 1 : 0, { violations: errs });
    }
    case "numeric": {
      if (typeof expected !== "number") return finish(0, { reason: "expected is not numeric" });
      const m = output.match(/-?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?/);
      if (!m) return finish(0, { reason: "no number found in output" });
      const got = Number(m[0].replace(",", "."));
      if (!Number.isFinite(got)) return finish(0, { reason: "unparseable number", raw: m[0] });
      const tolerance = config.tolerance ?? 0;
      const err = Math.abs(got - expected);
      const scale = config.relative ? Math.max(Math.abs(expected), Number.EPSILON) : 1;
      const relErr = err / scale;
      const within = relErr <= tolerance;
      // graded: full marks inside tolerance, decaying outside it so "much
      // worse" is distinguishable from "just outside"
      const score = within ? 1 : clamp01(1 - relErr / Math.max(Math.abs(expected) || 1, Number.EPSILON));
      return finish(score, { expected, got, error: round4(err), tolerance, relative: config.relative ?? false, within });
    }
    case "rubric": {
      const criteria = config.criteria ?? [];
      if (criteria.length === 0) return finish(0, { reason: "no criteria configured" });
      let weightSum = 0;
      let earned = 0;
      const detail: Array<{ id: string; weight: number; score: number; passed: boolean }> = [];
      for (const c of criteria) {
        const weight = c.weight ?? 1;
        weightSum += weight;
        let sub: number;
        if (c.pattern) {
          let re: RegExp | null = null;
          try {
            re = new RegExp(c.pattern, c.flags ?? "");
          } catch {
            re = null;
          }
          sub = re ? (re.test(output) ? 1 : 0) : 0;
        } else {
          sub = scoreContains(output, {
            needles: c.needles ?? [],
            anyOf: c.anyOf ?? false,
            forbidden: c.forbidden ?? [],
            caseSensitive: c.caseSensitive ?? false,
          }).score;
        }
        earned += weight * sub;
        detail.push({ id: c.id, weight, score: round4(sub), passed: sub >= 1 });
      }
      return finish(weightSum > 0 ? earned / weightSum : 0, { criteria: detail });
    }
    // ------------------------------------------------------------------
    // ADR-0067 — the locally-computable groundedness metrics
    // ------------------------------------------------------------------
    case "claim_support": {
      const r = scoreClaimSupport(output, context, claimOpts);
      return finish(r.ratio, {
        method: "lexical-idf-overlap",
        claimThreshold: r.claimThreshold,
        verifiableClaims: r.verifiableClaims,
        supportedClaims: r.supportedClaims,
        skippedClaims: r.skippedClaims,
        truncatedClaims: r.truncatedClaims,
        contextChunks: context.length,
        // THE THING A COMPLIANCE REVIEWER READS: the claims that failed, not
        // just the number that failed.
        unsupportedClaims: r.unsupportedClaims.map(claimDetail),
        claims: r.claims.map(claimDetail),
        ...(r.refusal ? { note: r.refusal } : {}),
      });
    }
    case "context_precision": {
      const r = scoreContextPrecision(output, context, claimOpts);
      return finish(r.score, {
        method: "retrieval-utilisation",
        usedChunks: r.usedChunks,
        unusedChunks: r.unusedChunks,
        totalChunks: r.totalChunks,
        ...(r.refusal ? { note: r.refusal } : {}),
      });
    }
    case "context_recall": {
      const reference = typeof expected === "string" ? expected : "";
      const r = scoreContextRecall(reference, context, claimOpts);
      return finish(r.score, {
        method: "reference-claims-attributable-to-context",
        attributable: r.attributable,
        totalReferenceClaims: r.total,
        contextChunks: context.length,
        missingFromContext: r.missing.map(claimDetail),
        ...(r.refusal ? { note: r.refusal } : {}),
      });
    }
    case "answer_relevance": {
      const r = scoreAnswerRelevance(input.caseInput ?? "", output);
      return finish(r.score, {
        method: "question-term-coverage-or-tfidf-cosine",
        questionCoverage: r.questionCoverage,
        similarity: r.similarity,
        unaddressedTerms: r.unaddressedTerms,
        noncommittal: r.noncommittal,
        ...(r.refusal ? { note: r.refusal } : {}),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// llm_as_judge — the deterministic parts only
// ---------------------------------------------------------------------------

export interface EvalJudgeRequest {
  /** the case's input, as given to the agent under test */
  caseInput: string;
  /** the reference answer, if the case has one */
  expected: unknown;
  /** the case's rubric, if it has one */
  rubric: unknown;
  /** what the agent under test actually produced */
  output: string;
  /** extra grading instructions from the scorer config */
  instructions?: string | null | undefined;
  /** ADR-0067: WHICH judged metric is being asked for. Absent = the ADR-0044
   * `llm_as_judge` behaviour, unchanged. */
  metric?: JudgeBackedScorerKind | undefined;
  /** ADR-0067: the case's retrieved/reference context, for the groundedness
   * judge. */
  context?: ReadonlyArray<string> | undefined;
}

export interface EvalJudgeVerdict {
  score: number;
  passed: boolean;
  /** the judge's stated reasoning — stored on the result row so a red gate can
   * be argued with rather than merely obeyed */
  rationale: string;
  /** ADR-0067: per-claim entailment verdicts, present only for
   * `groundedness_judge`. Same shape the lexical metric stores, so a reviewer
   * reads one thing in both cases. */
  claims?: JudgedClaimVerdict[] | undefined;
}

/**
 * ADR-0067 §4 — THE TYPED REFUSAL.
 *
 * Why this is a discriminated union rather than a boolean: "we could not
 * measure this" and "we measured it and it scored zero" must be impossible to
 * confuse at the type level, because confusing them is precisely how a
 * hallucination rate gets reported that nobody measured.
 */
export type JudgeAvailability =
  | { available: true }
  | {
      available: false;
      /** the machine-readable refusal code the gateway returns as a real 4xx */
      error: "judge_required" | "judge_not_dispatchable";
      /** the metrics that forced the refusal, so the message names them */
      metrics: JudgeBackedScorerKind[];
      reason: string;
    };

/**
 * THE PRE-FLIGHT DECISION, as a pure function so it is exhaustively testable
 * without a database.
 *
 * Called BEFORE the `eval_runs` row is inserted. A refusal therefore leaves no
 * run, no results, and no partially-scored suite that a later reader could
 * mistake for a measurement.
 */
export function judgeAvailabilityFor(
  scorerKinds: ReadonlyArray<string>,
  judge: { named: boolean; dispatchable: boolean; detail?: string | null },
): JudgeAvailability {
  // ADR-0072: EVERY judge-backed kind refuses, `llm_as_judge` included. A
  // missing instrument is never recorded as a bad measurement. See the comment
  // on JUDGE_REFUSING_SCORER_KINDS.
  const metrics = [
    ...new Set(scorerKinds.filter(refusesWithoutJudge)),
  ] as JudgeBackedScorerKind[];
  if (metrics.length === 0) return { available: true };
  if (!judge.named) {
    return {
      available: false,
      error: "judge_required",
      metrics,
      reason:
        `this dataset version uses model-backed scorer(s) [${metrics.join(", ")}] and no judge agent was named. ` +
        "These metrics are a model's entailment judgement; they will NOT fall back to a lexical estimate reported " +
        "under the same name. Name a `judgeAgentId` with a working model credential, or score these cases with " +
        "`claim_support` / `answer_relevance`, which state their lexical limits.",
    };
  }
  if (!judge.dispatchable) {
    return {
      available: false,
      error: "judge_not_dispatchable",
      metrics,
      reason:
        `this dataset version uses model-backed scorer(s) [${metrics.join(", ")}] but the named judge agent cannot be dispatched` +
        `${judge.detail ? ` — ${judge.detail}` : ""}. A judged metric with no reachable model is refused rather than estimated.`,
    };
  }
  return { available: true };
}

/**
 * The judge behind an interface, so the runner never depends on a model being
 * connected. The gateway ships a model-backed implementation that routes
 * through `executeGovernedDispatch`; tests inject a deterministic stub.
 */
export interface EvalJudge {
  /** identifies the measuring instrument on the run record */
  readonly id: string;
  judge(req: EvalJudgeRequest): Promise<EvalJudgeVerdict>;
}

/** The judge's grading prompt. Pure and therefore testable; whether a model
 * OBEYS it is not something this function can promise. */
export function buildJudgePrompt(req: EvalJudgeRequest, threshold: number): string {
  const parts = [
    "You are grading one output from another AI agent. Be strict and literal.",
    "",
    `PROMPT GIVEN TO THE AGENT:\n${req.caseInput}`,
  ];
  if (req.expected !== null && req.expected !== undefined) {
    parts.push(
      `REFERENCE ANSWER:\n${typeof req.expected === "string" ? req.expected : JSON.stringify(req.expected)}`,
    );
  }
  if (req.rubric !== null && req.rubric !== undefined) {
    parts.push(`RUBRIC:\n${typeof req.rubric === "string" ? req.rubric : JSON.stringify(req.rubric, null, 2)}`);
  }
  if (req.instructions) parts.push(`ADDITIONAL GRADING INSTRUCTIONS:\n${req.instructions}`);
  parts.push(
    `AGENT OUTPUT:\n${req.output}`,
    "",
    "Reply with ONLY a JSON object and nothing else:",
    `{"score": <number between 0 and 1>, "passed": <true if score >= ${threshold}>, "rationale": "<one or two sentences>"}`,
  );
  return parts.join("\n\n");
}

/**
 * Parse a judge's reply. Deliberately tolerant of a fenced block or leading
 * prose, and deliberately INTOLERANT of anything it cannot find a numeric
 * score in — an unparseable verdict is an error, never a silent pass. This
 * function is fully covered by tests; the model that produces its input is
 * not connected in this environment (see the ADR amendment).
 */
export function parseJudgeVerdict(
  text: string,
  threshold: number,
): { ok: true; verdict: EvalJudgeVerdict } | { ok: false; error: string } {
  const parsed = tryParseJson(text);
  let obj: Record<string, unknown> | null =
    parsed.ok && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)
      ? (parsed.value as Record<string, unknown>)
      : null;
  if (!obj) {
    // fall back to the first {...} block in the text
    const brace = firstBraceBlock(text);
    if (brace !== undefined) {
      try {
        const v = JSON.parse(brace) as unknown;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
      } catch {
        obj = null;
      }
    }
  }
  if (!obj) return { ok: false, error: "judge reply is not a JSON object" };
  const rawScore = obj.score;
  const score = typeof rawScore === "number" ? rawScore : Number(rawScore);
  if (!Number.isFinite(score)) return { ok: false, error: "judge reply has no numeric score" };
  const clamped = round4(clamp01(score));
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  const passed = typeof obj.passed === "boolean" ? obj.passed && clamped >= threshold : clamped >= threshold;
  return { ok: true, verdict: { score: clamped, passed, rationale } };
}

// ---------------------------------------------------------------------------
// Aggregation and the regression gate
// ---------------------------------------------------------------------------

export interface EvalAggregate {
  cases: number;
  passedCases: number;
  failedCases: number;
  /** mean of the continuous per-case scores */
  meanScore: number;
  /** fraction of cases whose `passed` was true */
  passRate: number;
}

export function aggregateEvalResults(
  results: ReadonlyArray<{ score: number; passed: boolean }>,
): EvalAggregate {
  const cases = results.length;
  if (cases === 0) return { cases: 0, passedCases: 0, failedCases: 0, meanScore: 0, passRate: 0 };
  const passedCases = results.filter((r) => r.passed).length;
  const meanScore = results.reduce((a, r) => a + r.score, 0) / cases;
  return {
    cases,
    passedCases,
    failedCases: cases - passedCases,
    meanScore: round4(meanScore),
    passRate: round4(passedCases / cases),
  };
}

export interface EvalGateInput {
  current: EvalAggregate;
  /** the named baseline's aggregate, or null when this suite has no baseline yet */
  baseline: EvalAggregate | null;
  /** how far the mean score may drop below the baseline before it is a
   * regression. 0 = any drop at all fails. */
  tolerance: number;
  /** an absolute floor on the mean score, independent of any baseline */
  minScore?: number | null | undefined;
  /** an absolute floor on the pass rate, independent of any baseline */
  minPassRate?: number | null | undefined;
  /** true = a missing baseline FAILS instead of passing as "first reference" */
  requireBaseline?: boolean | undefined;
  /**
   * ADR-0072 — the scoring semantics that produced `current`. Defaults to the
   * current version; supplied explicitly so the gate can be tested across the
   * boundary without a database.
   */
  currentSemantics?: number | undefined;
  /** ADR-0072 — the scoring semantics that produced `baseline`. */
  baselineSemantics?: number | undefined;
  /**
   * ADR-0072 — an ADMIN-PINNED baseline that was EXCLUDED from resolution
   * because it predates the current scoring semantics. This is not a missing
   * baseline: a human deliberately pinned that run, and silently falling back
   * to some other run would be a comparison they did not ask for. The gate
   * REFUSES and names the run to re-pin.
   */
  pinnedBaselineIncomparable?:
    | { runId: string; semantics: number }
    | null
    | undefined;
  /**
   * ADR-0072 — how many otherwise-eligible completed runs were skipped during
   * auto-resolution purely because they predate the current semantics. Reported
   * so "you have no baseline yet" and "your entire history predates the
   * correction" are never the same sentence.
   */
  incomparableCandidates?: number | undefined;
}

export interface EvalGateDecision {
  passed: boolean;
  /** true only when the failure was specifically a drop vs. the baseline */
  regression: boolean;
  /** current.meanScore - baseline.meanScore; null with no baseline.
   * Zero for identical results, positive for improvement, negative for a drop. */
  scoreDelta: number | null;
  passRateDelta: number | null;
  reason: string;
  /**
   * ADR-0072 — false when a baseline existed but could not honestly be compared
   * to this run. A consumer reading `scoreDelta: null` alone cannot tell "first
   * run ever" from "the history is not comparable"; this field can.
   */
  baselineComparable: boolean;
  /** ADR-0072 — the stated reason, whenever `baselineComparable` is false. */
  baselineIncomparableReason: string | null;
}

/**
 * THE GATE. Pure, so the block-on-regression decision can be tested exhaustively
 * without a database, a workflow, or a model.
 *
 * Order matters: absolute floors are checked BEFORE the baseline comparison,
 * because a suite that has degraded to the same low score twice must not pass
 * on the grounds that it "did not regress".
 */
export function evaluateEvalGate(input: EvalGateInput): EvalGateDecision {
  const { current, tolerance } = input;
  const currentSemantics = input.currentSemantics ?? SCORING_SEMANTICS_VERSION;
  const baselineSemantics = input.baselineSemantics ?? currentSemantics;

  // ADR-0072 — THE CROSS-SEMANTICS REFUSAL, APPLIED BEFORE THE DELTA EXISTS.
  // A baseline scored under different semantics is not a weaker baseline, it is
  // a different measurement, and subtracting one from the other produces a
  // number with no meaning. It is dropped here rather than divided — the delta
  // is never computed at all, so there is nothing for a later reader to find and
  // trust.
  const semanticsMismatch = Boolean(input.baseline) && baselineSemantics !== currentSemantics;
  const baseline = semanticsMismatch ? null : input.baseline;
  const scoreDelta = baseline ? round4(current.meanScore - baseline.meanScore) : null;
  const passRateDelta = baseline ? round4(current.passRate - baseline.passRate) : null;
  const incomparableReason = semanticsMismatch
    ? scoringSemanticsMismatchReason(currentSemantics, baselineSemantics)
    : input.pinnedBaselineIncomparable
      ? `the ADMIN-PINNED baseline run ${input.pinnedBaselineIncomparable.runId} was scored under semantics ` +
        `v${input.pinnedBaselineIncomparable.semantics}. ` +
        scoringSemanticsMismatchReason(currentSemantics, input.pinnedBaselineIncomparable.semantics)
      : null;
  const base = {
    scoreDelta,
    passRateDelta,
    baselineComparable: incomparableReason === null,
    baselineIncomparableReason: incomparableReason,
  };

  if (current.cases === 0) {
    return { ...base, passed: false, regression: false, reason: "the dataset version has no cases — an empty suite cannot certify anything" };
  }
  if (input.minScore != null && current.meanScore < input.minScore) {
    return {
      ...base,
      passed: false,
      regression: false,
      reason: `mean score ${current.meanScore} is below the required floor ${input.minScore}`,
    };
  }
  if (input.minPassRate != null && current.passRate < input.minPassRate) {
    return {
      ...base,
      passed: false,
      regression: false,
      reason: `pass rate ${current.passRate} is below the required floor ${input.minPassRate}`,
    };
  }
  // ADR-0072 — AN ADMIN-PINNED BASELINE THAT PREDATES THE CORRECTION FAILS THE
  // GATE. A human pinned that specific run as "the comparison"; quietly using a
  // different run, or quietly passing with no comparison at all, would both be
  // answers to a question nobody asked. The refusal names the run so re-pinning
  // is a task rather than a discovery.
  if (input.pinnedBaselineIncomparable) {
    return {
      ...base,
      passed: false,
      regression: false,
      reason: `BASELINE NOT COMPARABLE — ${incomparableReason}`,
    };
  }
  if (!baseline) {
    const stranded = semanticsMismatch
      ? ` ${incomparableReason}`
      : (input.incomparableCandidates ?? 0) > 0
        ? ` NOTE: ${input.incomparableCandidates} earlier completed run(s) exist for this dataset version and agent, but every one of them was scored under an older scoring semantics (ADR-0072) and NONE was compared against. This history is not lost and has not been rewritten — it is marked and stranded. Re-run and re-pin to establish a comparable baseline.`
        : "";
    if (input.requireBaseline) {
      return {
        ...base,
        passed: false,
        regression: false,
        reason:
          "no comparable baseline run exists for this dataset version and agent, and this check requires one." +
          stranded,
      };
    }
    return {
      ...base,
      passed: true,
      regression: false,
      reason:
        `no comparable baseline for this dataset version and agent — this run stands as the first reference under scoring semantics v${currentSemantics} (mean ${current.meanScore}, pass rate ${current.passRate}).` +
        stranded,
    };
  }
  if (scoreDelta! < -tolerance) {
    return {
      ...base,
      passed: false,
      regression: true,
      reason: `REGRESSION: mean score ${current.meanScore} is ${round4(-scoreDelta!)} below the baseline ${baseline.meanScore}, past the ${tolerance} tolerance`,
    };
  }
  return {
    ...base,
    passed: true,
    regression: false,
    reason:
      scoreDelta! > 0
        ? `improved by ${scoreDelta} over the baseline ${baseline.meanScore}`
        : scoreDelta === 0
          ? `identical to the baseline ${baseline.meanScore}`
          : `within the ${tolerance} tolerance of the baseline ${baseline.meanScore} (delta ${scoreDelta})`,
  };
}

// ---------------------------------------------------------------------------
// Admin write shapes
// ---------------------------------------------------------------------------

export const evalScorerKindSchema = z.enum(EVAL_SCORER_KINDS);

export const createEvalDatasetSchema = z.object({
  name: z.string().min(1).max(120),
  note: z.string().max(2000).optional(),
  /** the dataset-level default scorer; a case may override both */
  scorerKind: evalScorerKindSchema.default("contains"),
  scorerConfig: evalScorerConfigSchema.default({}),
});

export const createEvalCaseSchema = z.object({
  /** what is sent to the agent under test */
  input: z.string().min(1).max(100_000),
  /** the reference answer: a string, a number, or a JSON object/array */
  expected: z.union([z.string(), z.number(), z.record(z.unknown()), z.array(z.unknown())]).nullish(),
  rubric: z.union([z.string(), z.record(z.unknown())]).nullish(),
  /**
   * ADR-0067 — THE RETRIEVED/REFERENCE CONTEXT this answer is supposed to be
   * grounded in. One entry per retrieved chunk: chunk boundaries are load-
   * bearing, because a claim supported only by stitching two chunks together is
   * exactly the fabrication a groundedness metric exists to catch.
   *
   * STORAGE POSTURE: this is CONTENT and it is stored on the case row beside
   * `input` and `expected`, under the same authoring-time authority — it is not
   * a new class of data and it is not a storage bypass. When it rides the
   * prompt (the default) it passes through the SAME §8.4 PII classifier and
   * ADR-0042 guardrails every other dispatch input does.
   */
  context: z.array(z.string().min(1).max(20_000)).max(50).default([]),
  /**
   * true (default) = the context is PREPENDED to the prompt, so the metric
   * measures the model against material it actually saw. false = the context is
   * held back and used for SCORING ONLY, which is how you measure whether a
   * model's parametric answer happens to be grounded in a reference corpus.
   * Two different questions; the flag says which one you asked.
   */
  contextInPrompt: z.boolean().default(true),
  tags: z.array(z.string().min(1).max(60)).default([]),
  /** per-case scorer override (ADR §2: "selected per dataset (or per case)") */
  scorerKind: evalScorerKindSchema.optional(),
  scorerConfig: evalScorerConfigSchema.optional(),
});

export const startEvalRunSchema = z.object({
  datasetId: z.string().uuid(),
  /** the agent under test */
  agentId: z.string().uuid(),
  /** the registry entry used as the judge, for llm_as_judge cases */
  judgeAgentId: z.string().uuid().nullish(),
  /** pillar 5: which project this run's spend bills to */
  projectId: z.string().uuid().nullish(),
  /** the entitlement MODE the eval dispatches are evaluated under */
  mode: z.string().min(1).max(64).default("execute"),
  tolerance: z.number().min(0).max(1).default(0.05),
  minScore: z.number().min(0).max(1).nullish(),
  minPassRate: z.number().min(0).max(1).nullish(),
  /** pin the comparison to a specific prior run instead of the resolved baseline */
  baselineRunId: z.string().uuid().nullish(),
  note: z.string().max(2000).optional(),
  /**
   * ADR-0173 batch 2c — a weighted panel of 2–5 judges for the judge-backed
   * cases, instead of `judgeAgentId`. Every verdict is kept; the case score is
   * their weighted mean. Mutually exclusive with `judgeAgentId`.
   */
  judgePanel: judgePanelSchema.optional(),
  /** ADR-0173 batch 2c — judge each judge-backed case this many times (1–5) */
  repetitions: z.number().int().min(1).max(JUDGE_PANEL_LIMITS.maxRepetitions).default(1),
});

export const setEvalBaselineSchema = z.object({
  isBaseline: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// ADR-0173 batch 2c — datasets from traces, and evaluators on traces
// ---------------------------------------------------------------------------

/** at most this many span ids per "add to dataset" or "evaluate traces" call */
export const EVAL_TRACE_ROWS_MAX = 200;

/**
 * Why a span was not added to a dataset (or not evaluated). Fixed codes, so a
 * caller (the traces page, an automation rule) can count them without parsing.
 */
export const EVAL_TRACE_SKIP_REASONS = [
  "not_found",
  "content_withheld",
  "no_content",
  "already_in_dataset",
  "duplicate_in_request",
  "unusable_scorer_config",
  /** a trace (the `traceIds` form) with no model-call span to turn into a row */
  "no_model_call",
] as const;
export type EvalTraceSkipReason = (typeof EVAL_TRACE_SKIP_REASONS)[number];

/**
 * `spanIds` (rows chosen span by span) or `traceIds` (whole traces: each
 * trace's model-call spans become rows) — EXACTLY ONE of them. The route
 * answers 422 for both or neither, so this schema leaves both optional.
 */
export const datasetFromTracesSchema = z
  .object({
    spanIds: z.array(z.string().uuid()).min(1).max(EVAL_TRACE_ROWS_MAX).optional(),
    traceIds: z.array(z.string().uuid()).min(1).max(EVAL_TRACE_ROWS_MAX).optional(),
  })
  .strict();

/**
 * Run ONE deterministic scorer over trace span previews. Judge-backed kinds are
 * refused: an evaluator on traces never dispatches a model, and it reads only
 * the stored preview, never more content than the trace already holds.
 */
export const evaluateTracesSchema = z
  .object({
    scorerKind: evalScorerKindSchema,
    scorerConfig: evalScorerConfigSchema.default({}),
    /** the reference, for the scorers that need one (exact, numeric, …) */
    expected: z.union([z.string(), z.number(), z.record(z.unknown()), z.array(z.unknown())]).nullish(),
    spanIds: z.array(z.string().uuid()).min(1).max(EVAL_TRACE_ROWS_MAX),
    /** the trace-score name the results are recorded under */
    scoreName: z.string().regex(/^[a-z0-9_.-]{1,64}$/).optional(),
  })
  .strict();
