/**
 * ADR-0160 + ADR-0173 — the pure half of the Traces "Evaluation" tab.
 *
 *  - the content-evaluation summary (`GET /v1/governance/trace-evaluations`)
 *    and the sweep result (`POST …/run`), read as sentences;
 *  - the deterministic scorer form, built into exactly the body
 *    `POST /v1/evals/traces/evaluate` accepts (`evaluateTracesSchema`,
 *    packages/shared/src/evals.ts — strict, so nothing extra is sent).
 */
import { UUID_RE } from "../../../api/format";

/** the scorers that need no model (DETERMINISTIC_SCORER_KINDS; pinned by the unit test) */
export const DETERMINISTIC_TRACE_SCORERS = [
  "exact",
  "contains",
  "regex",
  "json_schema",
  "numeric",
  "rubric",
  "claim_support",
  "context_precision",
  "context_recall",
  "answer_relevance",
] as const;
export type TraceScorerKind = (typeof DETERMINISTIC_TRACE_SCORERS)[number];

/** EVAL_TRACE_ROWS_MAX */
export const TRACE_SCORER_MAX_SPANS = 200;
export const TRACE_EVAL_WINDOWS = [1, 7, 30, 90] as const;
export const TRACE_EVAL_DEFAULT_DAYS = 7;
const SCORE_NAME_RE = /^[a-z0-9_.-]{1,64}$/;

export interface AgentTraceSummary {
  agentId: string;
  agentName: string | null;
  spans: number;
  evaluated: number;
  withheld: number;
  noContent: number;
  flagged: number;
  leaksByDetector: Record<string, number>;
  attemptsByDetector: Record<string, number>;
  coveragePct: number | null;
}

export interface TraceEvaluationSummary {
  window: { days: number };
  lastEvaluatedAt: string | null;
  totals: { spans: number; evaluated: number; flagged: number; withheld: number; noContent: number };
  agents: AgentTraceSummary[];
  notes: { method: string; leaks: string; coverage: string };
}

export interface TraceSweepResult {
  scanned: number;
  evaluated: number;
  flagged: number;
  withheld: number;
  noContent: number;
  capped: boolean;
}

export function sweepSentence(r: TraceSweepResult): string {
  if (r.scanned === 0) return "No completed model calls were waiting for evaluation.";
  const parts = [
    `${r.evaluated} evaluated`,
    `${r.flagged} flagged`,
    ...(r.withheld ? [`${r.withheld} withheld (a block fired)`] : []),
    ...(r.noContent ? [`${r.noContent} with no captured content`] : []),
  ];
  return `${r.scanned} model ${r.scanned === 1 ? "call" : "calls"} examined: ${parts.join(", ")}.${r.capped ? " The batch limit was reached; run again to continue." : ""}`;
}

/** "pii 3 · secrets 1", largest first — an empty map reads as "none" */
export function detectorList(counts: Record<string, number>): string {
  const rows = Object.entries(counts).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  return rows.length ? rows.map(([k, n]) => `${k.replaceAll("_", " ")} ${n}`).join(" · ") : "none";
}

export const coverageText = (pct: number | null): string => (pct === null ? "—" : `${Math.round(pct)}%`);

export interface ScorerForm {
  scorerKind: TraceScorerKind;
  spanIds: string;
  /** a JSON object, or blank for the scorer's defaults */
  config: string;
  expected: string;
  expectedIsJson: boolean;
  scoreName: string;
}

export const EMPTY_SCORER_FORM: ScorerForm = {
  scorerKind: "contains",
  spanIds: "",
  config: '{"needles": ["refund"]}',
  expected: "",
  expectedIsJson: false,
  scoreName: "",
};

export interface ScorerBody {
  scorerKind: TraceScorerKind;
  scorerConfig: Record<string, unknown>;
  spanIds: string[];
  expected?: unknown;
  scoreName?: string;
}

/** span ids from free text: one per line, or separated by commas or spaces */
export function parseSpanIds(raw: string): { ids: string[]; invalid: string[]; duplicates: number } {
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const ids: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const t of tokens) {
    if (!UUID_RE.test(t)) invalid.push(t);
    else if (ids.includes(t.toLowerCase())) duplicates += 1;
    else ids.push(t.toLowerCase());
  }
  return { ids, invalid, duplicates };
}

export function scorerBody(form: ScorerForm): { ok: true; body: ScorerBody } | { ok: false; problem: string } {
  const spans = parseSpanIds(form.spanIds);
  if (spans.invalid.length) {
    return { ok: false, problem: `Not a span id: ${spans.invalid.slice(0, 3).join(", ")}${spans.invalid.length > 3 ? "…" : ""}.` };
  }
  if (spans.ids.length === 0) return { ok: false, problem: "Give at least one span id to score." };
  if (spans.ids.length > TRACE_SCORER_MAX_SPANS) {
    return { ok: false, problem: `At most ${TRACE_SCORER_MAX_SPANS} spans per run; ${spans.ids.length} were given.` };
  }
  let scorerConfig: Record<string, unknown> = {};
  if (form.config.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(form.config);
    } catch {
      return { ok: false, problem: "The scorer configuration is not valid JSON." };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, problem: "The scorer configuration must be a JSON object." };
    }
    scorerConfig = parsed as Record<string, unknown>;
  }
  const body: ScorerBody = { scorerKind: form.scorerKind, scorerConfig, spanIds: spans.ids };
  if (form.expected.trim()) {
    if (form.expectedIsJson) {
      try {
        const parsed: unknown = JSON.parse(form.expected);
        if (parsed === null || typeof parsed === "boolean") {
          return { ok: false, problem: "The expected value must be text, a number, an object or an array." };
        }
        body.expected = parsed;
      } catch {
        return { ok: false, problem: "The expected value is not valid JSON. Untick “read as JSON” to send it as text." };
      }
    } else {
      body.expected = form.expected;
    }
  }
  const name = form.scoreName.trim();
  if (name) {
    if (!SCORE_NAME_RE.test(name)) {
      return { ok: false, problem: "A score name is 1 to 64 lowercase letters, digits, dots, dashes or underscores." };
    }
    body.scoreName = name;
  }
  return { ok: true, body };
}

export type ScoredSpan =
  | { spanId: string; traceId: string; outcome: "evaluated"; score: number; passed: boolean; traceScoreId: string }
  | { spanId: string; outcome: "not_evaluated"; reason: string };

export interface ScorerRun {
  ok: true;
  evaluated: number;
  notEvaluated: number;
  results: ScoredSpan[];
  scoreName: string;
  runRef: string;
}

const SKIP_WORDS: Record<string, string> = {
  not_found: "no such span",
  content_withheld: "content withheld (a block fired)",
  no_content: "no output captured",
  duplicate_in_request: "listed twice",
  unusable_scorer_config: "the scorer configuration cannot score it",
};
export const skipWords = (reason: string): string => SKIP_WORDS[reason] ?? reason.replaceAll("_", " ");

export const TRACE_SCORER_REFUSALS = {
  deterministic_scorer_required: "Only scorers that need no model can run over stored trace previews.",
  too_many_rows: `At most ${TRACE_SCORER_MAX_SPANS} spans per run.`,
  unusable_scorer_config: "That scorer configuration cannot tell a good output from a bad one, so nothing was scored.",
} as const;

/** the model-call spans of a loaded trace tree — what the scorer can read */
export function modelCallSpanIds(tree: ReadonlyArray<{ id: string; kind: string; children: unknown[] }>): string[] {
  const out: string[] = [];
  const walk = (nodes: ReadonlyArray<{ id: string; kind: string; children: unknown[] }>) => {
    for (const n of nodes) {
      if (n.kind === "llm" || n.kind === "fallback_hop") out.push(n.id);
      walk(n.children as ReadonlyArray<{ id: string; kind: string; children: unknown[] }>);
    }
  };
  walk(tree);
  return out;
}
