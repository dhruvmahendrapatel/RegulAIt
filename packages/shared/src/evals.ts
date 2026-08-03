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
] as const;
export type EvalScorerKind = (typeof EVAL_SCORER_KINDS)[number];

/** The scorer kinds that need no model, no network and no key. */
export const DETERMINISTIC_SCORER_KINDS = EVAL_SCORER_KINDS.filter(
  (k) => k !== "llm_as_judge",
) as ReadonlyArray<Exclude<EvalScorerKind, "llm_as_judge">>;

export function isDeterministicScorer(kind: string): boolean {
  return (DETERMINISTIC_SCORER_KINDS as readonly string[]).includes(kind);
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
        "NON-DETERMINISTIC AND NOT FREE. Scores jitter run to run, the judge is itself an agent that can regress, and a gate built purely on it will occasionally red a good change. Corroboration, not a load-bearing gate.",
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
    // llm_as_judge
    instructions: z.string().max(4000).optional(),
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
): string | null {
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
  kind: Exclude<EvalScorerKind, "llm_as_judge">;
  expected: unknown;
  output: string;
  config: EvalScorerConfig;
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
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
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
}

export interface EvalJudgeVerdict {
  score: number;
  passed: boolean;
  /** the judge's stated reasoning — stored on the result row so a red gate can
   * be argued with rather than merely obeyed */
  rationale: string;
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
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) {
      try {
        const v = JSON.parse(brace[0]) as unknown;
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
  const { current, baseline, tolerance } = input;
  const scoreDelta = baseline ? round4(current.meanScore - baseline.meanScore) : null;
  const passRateDelta = baseline ? round4(current.passRate - baseline.passRate) : null;
  const base = { scoreDelta, passRateDelta };

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
  if (!baseline) {
    if (input.requireBaseline) {
      return {
        ...base,
        passed: false,
        regression: false,
        reason: "no baseline run exists for this dataset version and agent, and this check requires one",
      };
    }
    return {
      ...base,
      passed: true,
      regression: false,
      reason: `no baseline for this dataset version and agent — this run stands as the first reference (mean ${current.meanScore}, pass rate ${current.passRate})`,
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
});

export const setEvalBaselineSchema = z.object({
  isBaseline: z.boolean().default(true),
});
