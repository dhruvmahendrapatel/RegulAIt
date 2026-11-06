/**
 * ADR-0220 — TRAINED RUNTIME DETECTORS: the pure half.
 *
 * The ADR-0042 detectors in `guardrails.ts` are heuristic (regular expressions
 * and term lists). This file adds three TRAINED detectors that run as models
 * in a scoring service the operator hosts (the sidecar under
 * `agents/trained-detectors/`, weights baked into its image, no runtime
 * downloads), reached through the ADR-0088 external-scorer contract and the
 * egress-guarded fetch:
 *
 *   kind               the model                     reports under detector
 *   pii                a PII recogniser              pii
 *   prompt_injection   a prompt-injection classifier prompt_injection
 *   harm               a harm (toxicity) classifier  toxicity
 *
 * Rules this file enforces, so every enforcement site behaves the same:
 *
 *  1. OPT-IN PER ORG. A kind with no row, or a row with `enabled: false`, does
 *     nothing and costs nothing: no network call, no change to the heuristic
 *     result (ADR-0180: the feature is default-off; the strict values apply
 *     once an admin turns it on).
 *  2. THE HEURISTIC ALWAYS RUNS. A trained verdict ADDS findings; it never
 *     removes a heuristic one.
 *  3. FAIL CLOSED. A scorer failure (timeout, HTTP error, non-conforming reply,
 *     egress refusal, missing scorer) with `onFailure: "block"` (the default)
 *     is treated as if the detector had fired: a `trained_unavailable` hit at
 *     the detector's effective mode, so a down scorer never weakens what the
 *     detector enforces. `onFailure: "heuristic"` (an audited relaxation behind
 *     step-up) records the same hit at `log` and lets the heuristic decide.
 *  4. COUNTS ONLY. A verdict becomes per-category COUNTS. A reason string is
 *     kept only when it is a bare label (`^[a-z][a-z0-9_]{0,39}$`, e.g. an
 *     entity type); anything else is dropped unread, because a scorer's prose
 *     could quote the prompt. No text from the call is ever returned.
 *
 * Pure: no I/O, no clock, no fetch.
 */

import { z } from "zod";
import {
  strictestMode,
  type GuardrailDetectorId,
  type GuardrailEvaluation,
  type GuardrailFinding,
  type GuardrailHit,
  type GuardrailMode,
  type GuardrailModes,
  type GuardrailPhase,
} from "./guardrails.js";

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export const TRAINED_DETECTOR_KINDS = ["pii", "prompt_injection", "harm"] as const;
export type TrainedDetectorKind = (typeof TRAINED_DETECTOR_KINDS)[number];

/** the heuristic detector each trained kind reports under (and whose
 * effective mode — org default, override, compliance floor — it inherits) */
export const TRAINED_DETECTOR_TARGET: Record<TrainedDetectorKind, GuardrailDetectorId> = {
  pii: "pii",
  prompt_injection: "prompt_injection",
  harm: "toxicity",
};

/** the external-scorer kind a scoring service claims for each trained kind */
export const TRAINED_DETECTOR_SCORER_KIND: Record<TrainedDetectorKind, `guardrail_${TrainedDetectorKind}`> = {
  pii: "guardrail_pii",
  prompt_injection: "guardrail_prompt_injection",
  harm: "guardrail_harm",
};

export const GUARDRAIL_SCORER_KINDS = [
  "guardrail_pii",
  "guardrail_prompt_injection",
  "guardrail_harm",
] as const;
export type GuardrailScorerKind = (typeof GUARDRAIL_SCORER_KINDS)[number];

export function isGuardrailScorerKind(kind: string): kind is GuardrailScorerKind {
  return (GUARDRAIL_SCORER_KINDS as readonly string[]).includes(kind);
}

/** which phases each kind scans. PII and harm scan both; an injection
 * classifier judges what is SENT to a model or tool, so input only. */
export const TRAINED_DETECTOR_PHASES: Record<TrainedDetectorKind, readonly GuardrailPhase[]> = {
  pii: ["input", "output"],
  prompt_injection: ["input"],
  harm: ["input", "output"],
};

export const TRAINED_ON_FAILURE = ["block", "heuristic"] as const;
export type TrainedOnFailure = (typeof TRAINED_ON_FAILURE)[number];

/** the modes a trained detector may be set to ('off' is `enabled: false`) */
export const TRAINED_MODES = ["log", "warn", "block"] as const;
export type TrainedMode = (typeof TRAINED_MODES)[number];

/** the strict values a newly enabled detector starts from (ADR-0180) */
export const TRAINED_DETECTOR_DEFAULTS = {
  mode: "block" as TrainedMode,
  threshold: 0.5,
  onFailure: "block" as TrainedOnFailure,
  timeoutMs: 2000,
};

export const TRAINED_TIMEOUT_MIN_MS = 200;
export const TRAINED_TIMEOUT_MAX_MS = 10_000;
/** longer text is not truncated (a truncated scan would pass what it never
 * read); it takes the failure path instead */
export const TRAINED_MAX_TEXT_CHARS = 256_000;

/** the hit category a failed call records */
export const TRAINED_UNAVAILABLE_CATEGORY = "trained_unavailable";

/** one kind's settings, as the gateway loads them */
export interface TrainedDetectorSetting {
  kind: TrainedDetectorKind;
  enabled: boolean;
  /** the registered external scorer's name; null until one is chosen */
  scorerName: string | null;
  mode: GuardrailMode;
  threshold: number;
  onFailure: TrainedOnFailure;
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// admin write shape
// ---------------------------------------------------------------------------

export const putTrainedDetectorSchema = z
  .object({
    enabled: z.boolean(),
    scorerId: z.string().uuid().nullable().optional(),
    mode: z.enum(TRAINED_MODES).optional(),
    threshold: z.number().gt(0).max(1).optional(),
    onFailure: z.enum(TRAINED_ON_FAILURE).optional(),
    timeoutMs: z.number().int().min(TRAINED_TIMEOUT_MIN_MS).max(TRAINED_TIMEOUT_MAX_MS).optional(),
  })
  .strict();
export type PutTrainedDetector = z.infer<typeof putTrainedDetectorSchema>;

export const trainedDetectorKindSchema = z.enum(TRAINED_DETECTOR_KINDS);

/**
 * Which fields of a write RELAX the detector against what is stored now, for
 * the settings_relax step-up. Turning a detector off, lowering its mode,
 * raising its threshold (fewer hits) and moving off fail-closed are each a
 * relaxation; turning one on, raising its mode or lowering its threshold are
 * not. A first enable is never a relaxation unless it fails open.
 *
 * Two more, from the PR #634 review:
 *  - SWAPPING THE SCORER of an enabled detector is a relaxation. Any enabled
 *    scorer that claims the kind may be named, including one that always
 *    answers `score: 0`, so a swap can turn a detector off in effect.
 *  - LOWERING THE TIME LIMIT while the detector fails open is a relaxation:
 *    with `onFailure: heuristic`, a limit the scorer cannot meet makes every
 *    call a logged failure, which is close to off.
 */
export function trainedDetectorRelaxations(
  before: Pick<TrainedDetectorSetting, "enabled" | "mode" | "threshold" | "onFailure" | "timeoutMs"> & {
    scorerId: string | null;
  } | null,
  after: Pick<TrainedDetectorSetting, "enabled" | "mode" | "threshold" | "onFailure" | "timeoutMs"> & {
    scorerId: string | null;
  },
): string[] {
  if (!before || !before.enabled) return after.onFailure === "heuristic" ? ["onFailure"] : [];
  const out: string[] = [];
  if (!after.enabled) out.push("enabled");
  if (after.enabled && after.scorerId !== before.scorerId) out.push("scorerId");
  if (strictestMode(before.mode, after.mode) === before.mode && before.mode !== after.mode) out.push("mode");
  if (after.threshold > before.threshold) out.push("threshold");
  if (before.onFailure === "block" && after.onFailure === "heuristic") out.push("onFailure");
  if (after.enabled && after.onFailure === "heuristic" && after.timeoutMs < before.timeoutMs) out.push("timeoutMs");
  return out;
}

// ---------------------------------------------------------------------------
// planning: which calls one phase needs
// ---------------------------------------------------------------------------

export interface TrainedCallPlan {
  kind: TrainedDetectorKind;
  detector: GuardrailDetectorId;
  /** strictest(row mode, the heuristic detector's effective mode) */
  mode: GuardrailMode;
  setting: TrainedDetectorSetting;
}

/**
 * The trained detectors to run for one phase. `modes` is the policy's
 * effective heuristic modes; PII's is 'off' there (it has its own path), so a
 * PII recogniser runs at its own row mode.
 */
export function planTrainedDetectors(
  settings: readonly TrainedDetectorSetting[],
  phase: GuardrailPhase,
  modes: Partial<GuardrailModes>,
): TrainedCallPlan[] {
  const out: TrainedCallPlan[] = [];
  for (const s of settings) {
    if (!s.enabled) continue;
    if (!TRAINED_DETECTOR_PHASES[s.kind].includes(phase)) continue;
    const detector = TRAINED_DETECTOR_TARGET[s.kind];
    const mode = strictestMode(s.mode, modes[detector] ?? "off");
    if (mode === "off") continue;
    out.push({ kind: s.kind, detector, mode, setting: s });
  }
  return out;
}

/** the wire request for one trained call (the ADR-0088 contract): the text
 * rides in `input` on the input phase and in `output` on the output phase */
export function trainedScorerRequest(kind: TrainedDetectorKind, phase: GuardrailPhase, text: string) {
  return {
    input: phase === "input" ? text : "",
    output: phase === "output" ? text : "",
    context: [] as string[],
    scorerKind: TRAINED_DETECTOR_SCORER_KIND[kind],
  };
}

// ---------------------------------------------------------------------------
// verdict -> findings
// ---------------------------------------------------------------------------

const LABEL = /^[a-z][a-z0-9_]{0,39}$/;

/** A conforming verdict into counts-only hits. Below threshold: no hits. */
export function trainedVerdictHits(
  plan: Pick<TrainedCallPlan, "kind" | "detector">,
  verdict: { score: number; reasons: readonly string[] },
  threshold: number,
): GuardrailHit[] {
  if (!(verdict.score >= threshold)) return [];
  const counts = new Map<string, number>();
  for (const r of verdict.reasons) {
    const label = r.trim().toLowerCase();
    if (!LABEL.test(label)) continue; // prose is dropped unread
    const category = `trained_${label}`;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size === 0) counts.set(`trained_${plan.kind}`, 1);
  return [...counts].map(([category, count]) => ({ detector: plan.detector, category, count }));
}

/** the finding a failed call contributes (rule 3) */
export function trainedFailureFinding(plan: TrainedCallPlan): GuardrailFinding {
  const mode: GuardrailMode = plan.setting.onFailure === "block" ? plan.mode : "log";
  return {
    detector: plan.detector,
    mode,
    action: modeAction(mode),
    hits: [{ detector: plan.detector, category: TRAINED_UNAVAILABLE_CATEGORY, count: 1 }],
  };
}

function modeAction(mode: GuardrailMode): GuardrailFinding["action"] {
  return mode === "block" ? "block" : mode === "warn" ? "warn" : "log";
}

/** one call's outcome, as the gateway reports it to the merge */
export type TrainedCallOutcome =
  | { plan: TrainedCallPlan; ok: true; verdict: { score: number; reasons: readonly string[] } }
  | { plan: TrainedCallPlan; ok: false };

const ACTION_RANK = { allow: 0, log: 1, warn: 2, block: 3 } as const;

/**
 * Merge trained outcomes into the heuristic evaluation. A trained finding for
 * a detector that already has a heuristic finding joins it (hits appended,
 * the stricter mode wins); otherwise it is a new finding. The overall action
 * and the blocking list are recomputed.
 */
export function mergeTrainedOutcomes(
  base: GuardrailEvaluation,
  outcomes: readonly TrainedCallOutcome[],
): GuardrailEvaluation {
  if (outcomes.length === 0) return base;
  const findings: GuardrailFinding[] = base.findings.map((f) => ({ ...f, hits: [...f.hits] }));
  for (const o of outcomes) {
    let add: GuardrailFinding | null;
    if (o.ok) {
      const hits = trainedVerdictHits(o.plan, o.verdict, o.plan.setting.threshold);
      add = hits.length ? { detector: o.plan.detector, mode: o.plan.mode, action: modeAction(o.plan.mode), hits } : null;
    } else {
      add = trainedFailureFinding(o.plan);
    }
    if (!add) continue;
    const existing = findings.find((f) => f.detector === add.detector);
    if (existing) {
      existing.hits.push(...add.hits);
      existing.mode = strictestMode(existing.mode, add.mode);
      existing.action = modeAction(existing.mode);
    } else {
      findings.push(add);
    }
  }
  let action: GuardrailEvaluation["action"] = "allow";
  for (const f of findings) if (ACTION_RANK[f.action] > ACTION_RANK[action]) action = f.action;
  return { phase: base.phase, findings, action, blocking: findings.filter((f) => f.action === "block") };
}

/** one line an admin screen shows per kind */
export const TRAINED_DETECTOR_COPY: Record<TrainedDetectorKind, { label: string; summary: string }> = {
  pii: {
    label: "PII recogniser",
    summary: "A trained recogniser for personal data such as names, addresses and identifiers, in prompts and responses.",
  },
  prompt_injection: {
    label: "Prompt-injection classifier",
    summary: "A trained classifier for attempts to override instructions, scanned on what is sent to a model or tool.",
  },
  harm: {
    label: "Harm classifier",
    summary: "A trained classifier for toxic and abusive content, in prompts and responses. Reports under toxicity.",
  },
};
