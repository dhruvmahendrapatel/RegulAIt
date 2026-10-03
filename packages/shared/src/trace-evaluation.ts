/**
 * ADR-0160 — CONTINUOUS TRACE EVALUATION: the platform's own guardrail
 * detectors, re-run after the fact over what model calls actually returned.
 *
 * Why, when guardrails already run inline: an inline detector set to `log` or
 * `warn` (or off) lets content through by design. This answers the question
 * the inline path cannot — "what got OUT of our agents this week that a
 * detector would have flagged?" — per agent, as counts.
 *
 *   OUTPUT  pii · semantic_dlp (credential material, sensitive terms) · toxicity
 *           → a hit is a LEAK: content that left the platform. Flags the span.
 *   INPUT   prompt_injection · jailbreak
 *           → a hit is an ATTEMPT: recorded and counted, never a flag on the
 *             agent, because the attacker chose the input, not the agent.
 *
 * Deterministic heuristics only (the shipped detector tier) — no model call,
 * no cost. Counts only: the evaluation never copies matched text anywhere.
 * Spans whose content was withheld (a block fired, or capture is off) are
 * NOT evaluated and are reported as such, so coverage is never overstated.
 */
import { GUARDRAIL_DETECTORS, type GuardrailDetectorId } from "./guardrails.js";

export const TRACE_OUTPUT_DETECTORS: readonly GuardrailDetectorId[] = ["pii", "semantic_dlp", "toxicity"];
export const TRACE_INPUT_DETECTORS: readonly GuardrailDetectorId[] = ["prompt_injection", "jailbreak"];

/** the ADR-0099 scrub marker — `[redacted:aws_key:20:0123456789ab]` */
const SCRUB_MARKER = /\[redacted:[a-z0-9_+]+:\d+:[0-9a-f]{12}\]/g;

export const TRACE_EVALUATION_OUTCOMES = ["evaluated", "withheld", "no_content"] as const;
export type TraceEvaluationOutcome = (typeof TRACE_EVALUATION_OUTCOMES)[number];

export interface TraceFinding {
  phase: "input" | "output";
  detector: GuardrailDetectorId;
  category: string;
  count: number;
}

export interface TraceEvaluation {
  outcome: TraceEvaluationOutcome;
  findings: TraceFinding[];
  /** true when any OUTPUT detector hit — content that left the platform */
  flagged: boolean;
}

export function evaluateTraceContent(span: {
  inputPreview: string | null;
  outputPreview: string | null;
  contentWithheld: boolean;
}): TraceEvaluation {
  if (span.contentWithheld) return { outcome: "withheld", findings: [], flagged: false };
  if (!span.outputPreview && !span.inputPreview) return { outcome: "no_content", findings: [], flagged: false };
  const findings: TraceFinding[] = [];
  const run = (phase: "input" | "output", ids: readonly GuardrailDetectorId[], text: string | null) => {
    if (!text) return;
    for (const id of ids) {
      for (const h of GUARDRAIL_DETECTORS[id].detect(text)) {
        if (h.count > 0) findings.push({ phase, detector: id, category: h.category, count: h.count });
      }
    }
  };
  run("output", TRACE_OUTPUT_DETECTORS, span.outputPreview);
  // Credentials in trace previews are scrubbed AT WRITE TIME (ADR-0102 /
  // ADR-0111), so the stored text holds `[redacted:<kind>:<len>:<hash>]`
  // instead of the secret. The marker is itself the evidence: the model
  // returned credential material. Counted as such, never re-identified.
  const scrubbed = span.outputPreview?.match(SCRUB_MARKER) ?? [];
  if (scrubbed.length > 0) {
    findings.push({ phase: "output", detector: "semantic_dlp", category: "credential_material_scrubbed", count: scrubbed.length });
  }
  run("input", TRACE_INPUT_DETECTORS, span.inputPreview);
  return { outcome: "evaluated", findings, flagged: findings.some((f) => f.phase === "output") };
}

export interface AgentTraceSummary {
  agentId: string;
  spans: number;
  evaluated: number;
  withheld: number;
  noContent: number;
  /** evaluated spans with at least one OUTPUT hit */
  flagged: number;
  /** output hits by detector (span counts, not match counts) */
  leaksByDetector: Record<string, number>;
  /** input hits by detector (span counts) */
  attemptsByDetector: Record<string, number>;
  /** evaluated / spans, or null when there were none */
  coveragePct: number | null;
}

export function summarizeTraceEvaluations(
  rows: ReadonlyArray<{ agentId: string; outcome: TraceEvaluationOutcome; flagged: boolean; findings: TraceFinding[] }>,
): AgentTraceSummary[] {
  const by = new Map<string, AgentTraceSummary>();
  for (const r of rows) {
    const s =
      by.get(r.agentId) ??
      ({
        agentId: r.agentId,
        spans: 0,
        evaluated: 0,
        withheld: 0,
        noContent: 0,
        flagged: 0,
        leaksByDetector: {},
        attemptsByDetector: {},
        coveragePct: null,
      } satisfies AgentTraceSummary);
    s.spans += 1;
    if (r.outcome === "evaluated") s.evaluated += 1;
    else if (r.outcome === "withheld") s.withheld += 1;
    else s.noContent += 1;
    if (r.flagged) s.flagged += 1;
    const seen = new Set<string>();
    for (const f of r.findings) {
      const key = `${f.phase}:${f.detector}`;
      if (seen.has(key)) continue; // one span counts once per detector
      seen.add(key);
      const bucket = f.phase === "output" ? s.leaksByDetector : s.attemptsByDetector;
      bucket[f.detector] = (bucket[f.detector] ?? 0) + 1;
    }
    by.set(r.agentId, s);
  }
  for (const s of by.values()) s.coveragePct = s.spans ? Math.round((s.evaluated / s.spans) * 100) : null;
  return [...by.values()].sort((a, b) => b.flagged - a.flagged || a.agentId.localeCompare(b.agentId));
}

export const TRACE_EVALUATION_NOTES = {
  method:
    "The platform's shipped heuristic detectors (the same ones guardrails run inline), re-run over stored trace " +
    "previews. Deterministic, local, no model call.",
  leaks:
    "Output hits are content that left the platform — usually because the inline detector for it is set to log or " +
    "warn, not block. Input hits are attempts and are never held against the agent.",
  coverage:
    "Spans whose content was withheld (a block fired) or not captured (capture off) are not evaluated; coverage " +
    "says how many were. Previews are truncated to the capture limit, so a hit past it is not seen.",
} as const;
