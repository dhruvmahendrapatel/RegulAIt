/**
 * Rule-like AI step detection (ADR-0327, slice 1: read-only detector).
 *
 * Given the recorded runs of one AI-powered step (each run: a few structured
 * input fields and the step's output), find the smallest set of input fields
 * whose exact-match lookup table reproduces the output. A step that passes is
 * "rule-like": a deterministic table could replace the model call for the
 * inputs it has seen, and every input outside the table falls back to the AI.
 *
 * Pure and zero-I/O like the rest of this kernel. It never decides access:
 * the gateway only feeds it runs the caller may already read, and nothing here
 * changes routing. Switching a step to the rule is a later, approved, audited
 * slice (ADR-0327 §Decision 3).
 *
 * Open source first (ADR-0176): no maintained, permissively licensed JS
 * learner was found (ml-cart: last release 2022-01; decision-tree: ID3 only,
 * last release 2025-09, lodash dependency). Exact-match table induction is a
 * group-by with a held-out agreement check, so it is written here; decision
 * tree induction over numeric fields is deferred to a sandboxed engine image.
 *
 * Strict by default (ADR-0180): thresholds default high and cannot be set below
 * the hard floors, cells that are not near-pure are left out (they fall back to
 * the AI), and agreement is measured on held-out folds, never on training rows.
 */

export type FieldValue = string | number | boolean | null;

export interface StepRun {
  /** structured input fields of one run; an absent field is distinct from null */
  fields: Readonly<Record<string, FieldValue>>;
  /** the step's output for that run */
  output: string;
}

export interface RuleInductionOptions {
  /** fewest runs before a step is judged at all */
  minRuns: number;
  /** held-out agreement a rule must reach on the inputs it covers (0..1) */
  minAgreement: number;
  /** share of held-out runs the rule must cover (the rest fall back to the AI) */
  minCoverage: number;
  /** runs a table cell needs before it is trusted */
  minCellSupport: number;
  /** largest number of input fields a rule may key on */
  maxFields: number;
  /** most distinct outputs a rule-like step may have (enumerated outputs only) */
  maxOutputClasses: number;
  /** most cells a rule table may have (keeps the rule readable) */
  maxCells: number;
  /** most candidate fields searched (bounds the subset search) */
  maxCandidateFields: number;
  /** runs considered; later runs beyond this are ignored */
  maxRuns: number;
  /** held-out folds */
  folds: number;
}

export const DEFAULT_RULE_INDUCTION_OPTIONS: Readonly<RuleInductionOptions> = Object.freeze({
  minRuns: 200,
  minAgreement: 0.99,
  minCoverage: 0.9,
  minCellSupport: 5,
  maxFields: 3,
  maxOutputClasses: 20,
  maxCells: 200,
  maxCandidateFields: 24,
  maxRuns: 5_000,
  folds: 5,
});

/** an org may tighten any threshold, and relax it only down to these floors */
export const RULE_INDUCTION_FLOORS = Object.freeze({
  minRuns: 50,
  minAgreement: 0.95,
  minCoverage: 0.5,
  minCellSupport: 3,
});

/** hard ceilings on search size, whatever an org sets */
export const RULE_INDUCTION_CEILINGS = Object.freeze({
  maxFields: 4,
  maxOutputClasses: 100,
  maxCells: 1_000,
  maxCandidateFields: 32,
  maxRuns: 20_000,
  folds: 10,
});

export interface RuleCell {
  /** values of rule.fields, in order; `undefined` (absent) is encoded as the absent marker */
  key: readonly (FieldValue | AbsentMarker)[];
  output: string;
  /** runs in this cell */
  support: number;
}

export interface AbsentMarker {
  readonly absent: true;
}

export const ABSENT: AbsentMarker = Object.freeze({ absent: true as const });

export interface InducedRule {
  /** input fields the rule keys on, sorted; empty = the step always returns one output */
  fields: readonly string[];
  cells: readonly RuleCell[];
}

export interface RuleEvidence {
  runs: number;
  outputClasses: number;
  /** held-out agreement on covered runs */
  agreement: number;
  /** held-out share of runs the rule covered */
  coverage: number;
  folds: number;
}

export type RuleInductionResult =
  | { status: "rule_like"; rule: InducedRule; evidence: RuleEvidence }
  | {
      status: "not_rule_like";
      reason: "too_few_runs" | "too_many_output_classes" | "no_rule_met_thresholds";
      runs: number;
      outputClasses: number;
      /** the closest candidate, for explanation only; never usable as a rule */
      closest?: { fields: readonly string[]; agreement: number; coverage: number };
    };

export type RuleApplication = { matched: true; output: string } | { matched: false };

/** Resolve options: org overrides on top of the strict defaults, clamped to floors and ceilings. */
export function resolveRuleInductionOptions(overrides: Partial<RuleInductionOptions> = {}): RuleInductionOptions {
  const o: RuleInductionOptions = { ...DEFAULT_RULE_INDUCTION_OPTIONS, ...stripUndefined(overrides) };
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new RangeError(`rule induction option ${k} must be a finite number`);
  }
  if (o.minAgreement > 1 || o.minCoverage > 1) throw new RangeError("minAgreement and minCoverage are fractions in 0..1");
  if (o.minRuns < RULE_INDUCTION_FLOORS.minRuns) throw new RangeError(`minRuns may not be below ${RULE_INDUCTION_FLOORS.minRuns}`);
  if (o.minAgreement < RULE_INDUCTION_FLOORS.minAgreement)
    throw new RangeError(`minAgreement may not be below ${RULE_INDUCTION_FLOORS.minAgreement}`);
  if (o.minCoverage < RULE_INDUCTION_FLOORS.minCoverage)
    throw new RangeError(`minCoverage may not be below ${RULE_INDUCTION_FLOORS.minCoverage}`);
  if (o.minCellSupport < RULE_INDUCTION_FLOORS.minCellSupport)
    throw new RangeError(`minCellSupport may not be below ${RULE_INDUCTION_FLOORS.minCellSupport}`);
  for (const k of Object.keys(RULE_INDUCTION_CEILINGS) as (keyof typeof RULE_INDUCTION_CEILINGS)[]) {
    if (!Number.isInteger(o[k]) || o[k] < 1 || o[k] > RULE_INDUCTION_CEILINGS[k]) {
      throw new RangeError(`${k} must be an integer in 1..${RULE_INDUCTION_CEILINGS[k]}`);
    }
  }
  if (o.folds < 2) throw new RangeError("folds must be at least 2");
  if (!Number.isInteger(o.minRuns) || !Number.isInteger(o.minCellSupport)) {
    throw new RangeError("minRuns and minCellSupport must be integers");
  }
  return o;
}

/** Normalise a step output for comparison: trim and collapse whitespace. Case is kept (strict). */
export function normalizeStepOutput(output: string): string {
  return output.trim().replace(/\s+/g, " ");
}

/**
 * Flatten a recorded JSON input into scalar fields (top level, and one nested
 * object level as `parent.child`). Returns null when the text is not a JSON
 * object (including a truncated preview), so the run is skipped, not guessed.
 */
export function extractStepFields(inputText: string): Record<string, FieldValue> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const out: Record<string, FieldValue> = Object.create(null);
  for (const [k, v] of Object.entries(parsed)) {
    if (isScalar(v)) out[k] = v;
    else if (isPlainObject(v)) {
      for (const [k2, v2] of Object.entries(v)) if (isScalar(v2)) out[`${k}.${k2}`] = v2;
    }
  }
  return out;
}

/** Apply an induced rule. An input outside the table never gets a guess: it falls back to the AI. */
export function applyInducedRule(rule: InducedRule, fields: Readonly<Record<string, FieldValue>>): RuleApplication {
  const key = encodeKey(rule.fields, fields);
  for (const cell of rule.cells) {
    if (encodeCellKey(cell.key) === key) return { matched: true, output: cell.output };
  }
  return { matched: false };
}

/** Render a rule as readable lines, one per cell, plus the fallback line. Values are JSON-quoted so they cannot be misread. */
export function renderInducedRule(rule: InducedRule): string[] {
  const show = (v: FieldValue | AbsentMarker): string => (isAbsent(v) ? "(absent)" : JSON.stringify(v));
  const lines = rule.cells.map((c) => {
    const when = rule.fields.length === 0 ? "always" : `when ${rule.fields.map((f, i) => `${f} = ${show(c.key[i]!)}`).join(" and ")}`;
    return `${when} -> ${JSON.stringify(c.output)} (${c.support} runs)`;
  });
  lines.push("otherwise -> ask the AI (input not covered by this rule)");
  return lines;
}

/** Find the smallest exact-match rule that reproduces a step's outputs, or explain why none does. */
export function induceStepRule(runsIn: readonly StepRun[], overrides: Partial<RuleInductionOptions> = {}): RuleInductionResult {
  const o = resolveRuleInductionOptions(overrides);
  const runs = runsIn.slice(0, o.maxRuns).map((r) => ({ fields: r.fields, output: normalizeStepOutput(r.output) }));
  const outputClasses = new Set(runs.map((r) => r.output)).size;
  if (runs.length < o.minRuns) return { status: "not_rule_like", reason: "too_few_runs", runs: runs.length, outputClasses };
  if (outputClasses > o.maxOutputClasses) {
    return { status: "not_rule_like", reason: "too_many_output_classes", runs: runs.length, outputClasses };
  }

  const candidates = candidateFields(runs, o);
  let closest: { fields: readonly string[]; agreement: number; coverage: number } | undefined;

  for (let size = 0; size <= Math.min(o.maxFields, candidates.length); size++) {
    let best: { fields: string[]; agreement: number; coverage: number } | undefined;
    for (const subset of combinations(candidates, size)) {
      const cv = crossValidate(runs, subset, o);
      if (cv === null) continue;
      if (!closest || better(cv, closest)) closest = { fields: subset, ...cv };
      if (cv.agreement >= o.minAgreement && cv.coverage >= o.minCoverage && (!best || better(cv, best))) {
        best = { fields: subset, ...cv };
      }
    }
    if (best) {
      const cells = buildTable(runs, best.fields, o);
      if (cells !== null && cells.length > 0) {
        return {
          status: "rule_like",
          rule: { fields: best.fields, cells },
          evidence: { runs: runs.length, outputClasses, agreement: best.agreement, coverage: best.coverage, folds: o.folds },
        };
      }
    }
  }
  return closest
    ? { status: "not_rule_like", reason: "no_rule_met_thresholds", runs: runs.length, outputClasses, closest }
    : { status: "not_rule_like", reason: "no_rule_met_thresholds", runs: runs.length, outputClasses };
}

// ---------------------------------------------------------------- internals

type NormRun = { fields: Readonly<Record<string, FieldValue>>; output: string };

function better(a: { agreement: number; coverage: number }, b: { agreement: number; coverage: number }): boolean {
  // subsets arrive in a fixed order, so ties keep the first (deterministic)
  return a.agreement > b.agreement || (a.agreement === b.agreement && a.coverage > b.coverage);
}

/** fields with at most maxCells distinct values, by fewest distinct values then name; at most maxCandidateFields */
function candidateFields(runs: readonly NormRun[], o: RuleInductionOptions): string[] {
  const values = new Map<string, Set<string>>();
  for (const r of runs) for (const k of Object.keys(r.fields)) if (!values.has(k)) values.set(k, new Set());
  for (const r of runs) {
    for (const [k, set] of values) {
      if (set.size <= o.maxCells) set.add(encodeValue(Object.hasOwn(r.fields, k) ? r.fields[k] : ABSENT));
    }
  }
  return [...values.entries()]
    .filter(([, set]) => set.size >= 2 && set.size <= o.maxCells)
    .sort(([a, sa], [b, sb]) => sa.size - sb.size || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, o.maxCandidateFields)
    .map(([k]) => k)
    .sort();
}

function* combinations(items: readonly string[], size: number, start = 0, acc: string[] = []): Generator<string[]> {
  if (acc.length === size) {
    yield [...acc];
    return;
  }
  for (let i = start; i <= items.length - (size - acc.length); i++) {
    acc.push(items[i]!);
    yield* combinations(items, size, i + 1, acc);
    acc.pop();
  }
}

/** trusted cells: support >= minCellSupport and majority share >= minAgreement; null if over maxCells */
function buildTable(runs: readonly NormRun[], fields: readonly string[], o: RuleInductionOptions): RuleCell[] | null {
  const groups = new Map<string, { key: (FieldValue | AbsentMarker)[]; counts: Map<string, number>; n: number }>();
  for (const r of runs) {
    const k = encodeKey(fields, r.fields);
    let g = groups.get(k);
    if (!g) {
      g = { key: fields.map((f) => (Object.hasOwn(r.fields, f) ? r.fields[f]! : ABSENT)), counts: new Map(), n: 0 };
      groups.set(k, g);
      if (groups.size > o.maxCells) return null;
    }
    g.n++;
    g.counts.set(r.output, (g.counts.get(r.output) ?? 0) + 1);
  }
  const cells: RuleCell[] = [];
  for (const [, g] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (g.n < o.minCellSupport) continue;
    let top = "";
    let topN = 0;
    for (const [out, n] of [...g.counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (n > topN) {
        top = out;
        topN = n;
      }
    }
    if (topN / g.n < o.minAgreement) continue;
    cells.push({ key: g.key, output: top, support: g.n });
  }
  return cells;
}

/** held-out agreement and coverage; folds by run index (deterministic) */
function crossValidate(
  runs: readonly NormRun[],
  fields: readonly string[],
  o: RuleInductionOptions,
): { agreement: number; coverage: number } | null {
  let covered = 0;
  let correct = 0;
  for (let f = 0; f < o.folds; f++) {
    const train = runs.filter((_, i) => i % o.folds !== f);
    const cells = buildTable(train, fields, o);
    if (cells === null) return null;
    const rule: InducedRule = { fields, cells };
    const lookup = new Map(cells.map((c) => [encodeCellKey(c.key), c.output]));
    for (let i = f; i < runs.length; i += o.folds) {
      const out = lookup.get(encodeKey(rule.fields, runs[i]!.fields));
      if (out === undefined) continue;
      covered++;
      if (out === runs[i]!.output) correct++;
    }
  }
  if (covered === 0) return { agreement: 0, coverage: 0 };
  return { agreement: correct / covered, coverage: covered / runs.length };
}

function encodeValue(v: FieldValue | AbsentMarker | undefined): string {
  if (v === undefined || (typeof v === "object" && v !== null)) return "\u0000absent";
  return `${typeof v}:${String(v)}`;
}

function encodeKey(fields: readonly string[], values: Readonly<Record<string, FieldValue>>): string {
  return JSON.stringify(fields.map((f) => encodeValue(Object.hasOwn(values, f) ? values[f] : ABSENT)));
}

function encodeCellKey(key: readonly (FieldValue | AbsentMarker)[]): string {
  return JSON.stringify(key.map((v) => encodeValue(v)));
}

function isAbsent(v: FieldValue | AbsentMarker): v is AbsentMarker {
  return typeof v === "object" && v !== null;
}

function isScalar(v: unknown): v is FieldValue {
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** ADR-0327 shadow mode: how a rule would have done on runs the AI answered (counts only) */
export interface ShadowTally {
  /** structured runs considered */
  runs: number;
  /** runs the rule answers (an input inside its table) */
  covered: number;
  /** covered runs where the rule's answer equals the AI's (both normalised as at induction) */
  agreed: number;
}

/**
 * Measure a rule against live runs without changing anything: for each run, apply the rule; a covered run agrees when
 * the rule's output equals the AI's output after `normalizeStepOutput`. Pure; cost `runs + cells`.
 */
export function tallyShadow(rule: InducedRule, runs: readonly StepRun[]): ShadowTally {
  // one lookup per run (the same encoding `applyInducedRule` compares), so the cost is runs + cells, not runs × cells
  const byKey = new Map<string, string>();
  for (const cell of rule.cells) byKey.set(encodeCellKey(cell.key), cell.output);
  let covered = 0;
  let agreed = 0;
  for (const run of runs) {
    const output = byKey.get(encodeKey(rule.fields, run.fields));
    if (output === undefined) continue;
    covered += 1;
    if (output === normalizeStepOutput(run.output)) agreed += 1;
  }
  return { runs: runs.length, covered, agreed };
}
