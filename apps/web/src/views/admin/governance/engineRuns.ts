/**
 * ADR-0187 (batch 5, X27) — the engine-run view model, pure half.
 *
 * The Red-teaming and Evaluations pages start and read sidecar engine runs
 * (AgentCoordination §4.10). Two rules this file exists to hold, so that every
 * badge, table and summary on those pages derives from one place:
 *
 *  - **`not_run` and `unknown` are never a pass.** Only the literal verdict
 *    `pass` maps to the positive tone, and a run that did not COMPLETE is never
 *    shown as pass whatever its summary says (the server already guarantees
 *    this; the page does not rely on it). An unrecognised verdict is shown as
 *    unrecognised, never as clean.
 *  - **No raw model text.** The SPA mirrors only the structured fields the
 *    gateway returns (`engineRunItemView` copies an explicit allow-list), so a
 *    field the server might add later — or one a hostile engine smuggled in —
 *    cannot reach the screen by accident.
 *
 * The shapes mirror apps/gateway/src/engine-runs.ts by hand (this app's
 * convention); apps/web/e2e/engines-fixtures.ts is the mock of the same shapes.
 */
import type { Tone } from "../../../ui/kit";

// ---- shapes (structured fields only) ---------------------------------------

export type EngineRunStatus =
  | "awaiting_approval"
  | "queued"
  | "leased"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "not_run";
export type EngineVerdict = "pass" | "fail" | "unknown" | "not_run";

export interface EngineRunSummary {
  verdict: string;
  counts?: { pass: number; fail: number; unknown: number; not_run: number };
  mappedItems?: number;
  unmappedItems?: number;
  asr?: number | null;
  asrInterval?: { lower: number; upper: number } | null;
  asrTrials?: number;
  measurementQuality?: string;
  taxonomyVersion?: number;
  explanation?: string;
  cause?: string;
}

export interface EngineRun {
  id: string;
  engineId: string;
  engineVersion: string;
  status: string;
  trigger: string;
  runAsUserId: string | null;
  projectId: string | null;
  targetKind: string;
  targetAgentId: string | null;
  judgeAgentId: string | null;
  targetArtifactId: string | null;
  config: { sets?: string[]; params?: Record<string, unknown> } | null;
  configHash: string | null;
  trials: number;
  budgetUsd: number;
  costUsd: number;
  timeoutSeconds: number;
  runnerId: string | null;
  approvalId: string | null;
  scheduleId: string | null;
  workflowInstanceId: string | null;
  createdAt: string;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  phase: string | null;
  progress: number | null;
  deadlineAt: string | null;
  cancelRequestedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  summary: EngineRunSummary | null;
  rawReportSha256: string | null;
  rawReportStored: boolean;
  redteamRunId: string | null;
  evalRunId: string | null;
  /** not on the run today (see the X27 report): shown when the gateway adds it */
  imageDigest?: string | null;
  manifestGeneration?: number | null;
}

/** one item as the page keeps it: the allow-listed, structured fields only */
export interface EngineRunItem {
  key: string;
  sourceSystem: string;
  sourceId: string;
  attackClass: string | null;
  severity: string;
  attempts: number;
  defeated: number;
  claimedVerdict: string | null;
  verdict: string;
  /** the gateway's scrubbed, engine-composed sentence (ADR-0187 decision 7) */
  reason: string | null;
  /** the gateway's own note on how it re-derived the verdict */
  verdictNote: string | null;
  notRunReason: string | null;
}

export interface EngineRunner {
  id: string;
  name: string;
  reportedDigest: string | null;
  reportedVersion: string | null;
}

export interface EngineInfo {
  id: string;
  kind: string;
  displayName: string;
  version: string;
  imageDigest: string | null;
  signature: string;
  enabled: boolean;
  maxBudgetUsd: number;
  timeoutSeconds: number;
  needsModelAccess: boolean;
  runners: EngineRunner[];
  manifestGeneration?: number | null;
}

/** the longest note the page shows; the gateway caps these too, this is belt and braces */
export const NOTE_MAX_CHARS = 300;
const clip = (s: string | null | undefined): string | null => {
  if (typeof s !== "string") return null;
  return s.length > NOTE_MAX_CHARS ? `${s.slice(0, NOTE_MAX_CHARS)}…` : s;
};
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/**
 * Copy an item from the API into the page's shape, field by field. Anything
 * not named here (a raw prompt, a model output, a report excerpt) is dropped.
 */
export function engineRunItemView(raw: unknown): EngineRunItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    key: str(r.key) ?? "",
    sourceSystem: str(r.sourceSystem) ?? "",
    sourceId: str(r.sourceId) ?? "",
    attackClass: str(r.attackClass),
    severity: str(r.severity) ?? "",
    attempts: num(r.attempts),
    defeated: num(r.defeated),
    claimedVerdict: str(r.claimedVerdict),
    verdict: str(r.verdict) ?? "unknown",
    reason: clip(str(r.reason)),
    verdictNote: clip(str(r.verdictNote)),
    notRunReason: str(r.notRunReason),
  };
}

// ---- verdicts ---------------------------------------------------------------

export interface VerdictDisplay {
  /** the word shown; never "pass" for anything but a pass */
  label: string;
  tone: Tone;
  /** a sentence for the title/tooltip and for screen readers */
  meaning: string;
}

/**
 * The one verdict → display mapping. Only `pass` is positive. `unknown` and
 * `not_run` say in words that they are not a pass (colour is never the only
 * distinction), and any other string is shown as unrecognised.
 */
export function verdictDisplay(verdict: string | null | undefined): VerdictDisplay {
  switch (verdict) {
    case "pass":
      return { label: "pass", tone: "ok", meaning: "every attempt that ran was graded and none defeated the target" };
    case "fail":
      return { label: "fail", tone: "danger", meaning: "at least one attempt defeated the target" };
    case "unknown":
      return { label: "unknown (not a pass)", tone: "warn", meaning: "no trustworthy result: an error, a timeout or an ungraded attempt; never counted as a pass" };
    case "not_run":
      return { label: "not run (not a pass)", tone: "neutral", meaning: "this did not run, so it says nothing about the target; never counted as a pass" };
    default:
      return { label: `unrecognised verdict${verdict ? ` "${verdict}"` : ""} (not a pass)`, tone: "warn", meaning: "the page does not know this verdict, so it is not shown as a pass" };
  }
}

export const isTerminalStatus = (s: string): boolean =>
  s === "completed" || s === "failed" || s === "timeout" || s === "cancelled" || s === "not_run";
export const isLiveStatus = (s: string): boolean => s === "awaiting_approval" || s === "queued" || s === "leased";

/**
 * The verdict the page shows for a whole run. `null` while the run has not
 * ended (nothing to show yet). A run that did not complete is never a pass:
 * a pass summary on a failed, timed-out or cancelled run is shown as unknown.
 * An ended run with no summary is unknown.
 */
export function runVerdict(run: Pick<EngineRun, "status" | "summary">): string | null {
  if (!isTerminalStatus(run.status)) return null;
  const v = run.summary?.verdict;
  if (run.status === "not_run") return "not_run";
  if (!v) return "unknown";
  if (v === "pass" && run.status !== "completed") return "unknown";
  return v;
}

// ---- statuses ---------------------------------------------------------------

export function runStatusDisplay(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "awaiting_approval":
      return { label: "awaiting approval", tone: "warn" };
    case "queued":
      return { label: "queued", tone: "neutral" };
    case "leased":
      return { label: "running", tone: "info" };
    // a completed run's colour belongs to its VERDICT, not to its status
    case "completed":
      return { label: "completed", tone: "neutral" };
    case "failed":
      return { label: "failed", tone: "danger" };
    case "timeout":
      return { label: "timed out", tone: "danger" };
    case "cancelled":
      return { label: "cancelled", tone: "neutral" };
    case "not_run":
      return { label: "not run", tone: "neutral" };
    default:
      return { label: status.replaceAll("_", " "), tone: "neutral" };
  }
}

/** why an item did not run, in words (ENGINE_NOT_RUN_REASONS in @regulait/shared) */
export const NOT_RUN_REASON_TEXT: Record<string, string> = {
  cloud_only: "needs the engine vendor's cloud service, which this install never calls",
  excluded_licence: "its content licence is not admitted here",
  egress_denied: "it tried to reach the network and the sandbox denied it",
  unsupported_format: "this build has no scanner for the format",
  missing_preseed: "its dataset would be downloaded at run time and is not pre-seeded",
  engine_error: "the engine produced no result for it",
};
export const notRunReasonText = (code: string | null | undefined): string =>
  code ? (NOT_RUN_REASON_TEXT[code] ?? "a reason this page does not know") : "no reason recorded";

/** why a whole run ended without a result (`errorCode` / `summary.cause`) */
export const RUN_END_TEXT: Record<string, string> = {
  approval_denied: "an approver refused it in the Approvals Queue, so nothing ran",
  no_runner: "no runner leased it within 24 hours",
  run_as_gone: "the person it runs as no longer exists",
  run_as_not_entitled: "the person it runs as is no longer entitled to the target or judge",
  agent_not_dispatchable: "the target or judge has no provider model",
  deadline_passed: "the deadline passed before a valid result arrived",
  lease_expired: "the runner stopped sending heartbeats and the lease expired",
  cancelled: "it was cancelled; its key was revoked at once",
  workflow_ended: "its workflow instance ended, which cancelled it",
  runner_revoked: "the runner holding it was revoked",
  lease_retry_refused: "a retried lease was refused, which ended it",
  engine_crashed: "the engine crashed",
  engine_error: "the engine reported an error",
  engine_disabled: "the engine was switched off",
  engine_build_changed: "the engine's build changed",
  engine_self_test_failed: "the engine's self-test failed",
  raw_report_mismatch: "the report did not match its declared hash",
};

// ---- heartbeat --------------------------------------------------------------

/** the gateway's lease length (ADR-0187 decision 5): a lease lapses this long after the last heartbeat */
export const LEASE_SECONDS = 90;

export interface HeartbeatState {
  label: string;
  tone: Tone;
  ageSeconds: number | null;
}

/** what the page says about a leased run's heartbeat; null for any other status */
export function heartbeatState(run: Pick<EngineRun, "status" | "heartbeatAt">, now: number = Date.now()): HeartbeatState | null {
  if (run.status !== "leased") return null;
  if (!run.heartbeatAt) return { label: "no heartbeat yet", tone: "warn", ageSeconds: null };
  const age = Math.max(0, Math.round((now - new Date(run.heartbeatAt).getTime()) / 1000));
  if (age > LEASE_SECONDS)
    return { label: `no heartbeat for ${age}s: the lease lapses and the run ends as timed out`, tone: "warn", ageSeconds: age };
  return { label: `last heartbeat ${age}s ago`, tone: "ok", ageSeconds: age };
}

/** a future instant in words ("in 4m", "in 30s"), or "passed" */
export function until(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "not set";
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(s)) return "not set";
  if (s <= 0) return "passed";
  if (s < 60) return `ends in ${s}s`;
  if (s < 3600) return `ends in ${Math.floor(s / 60)}m`;
  return `ends in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---- provenance -------------------------------------------------------------

export interface Provenance {
  engine: string;
  version: string;
  /** the digest of the build that ran it, when the page can know it; null otherwise */
  digest: string | null;
  digestSource: "run" | "runner" | null;
  generation: number | null;
  signature: string | null;
}

/**
 * Where a run's result came from. The run records its engine and version; the
 * image digest is shown only when it is KNOWN for this run — stamped on the
 * run, or reported by the runner that leased it (while that runner is still
 * registered). The engine's CURRENT digest is never presented as the run's.
 */
export function runProvenance(run: EngineRun, engine: EngineInfo | undefined): Provenance {
  const runner = run.runnerId ? engine?.runners.find((r) => r.id === run.runnerId) : undefined;
  const fromRun = run.imageDigest ?? null;
  const fromRunner = runner && runner.reportedVersion === run.engineVersion ? runner.reportedDigest : null;
  return {
    engine: engine?.displayName ?? run.engineId,
    version: run.engineVersion,
    digest: fromRun ?? fromRunner ?? null,
    digestSource: fromRun ? "run" : fromRunner ? "runner" : null,
    generation: run.manifestGeneration ?? null,
    signature: engine?.signature ?? null,
  };
}

export const shortDigest = (d: string): string => {
  const [algo, hex] = d.includes(":") ? (d.split(":", 2) as [string, string]) : ["", d];
  return `${algo ? `${algo}:` : ""}${hex.slice(0, 12)}…`;
};

// ---- the run form -----------------------------------------------------------

/** the sets typed into the form: comma- or whitespace-separated, de-duplicated */
export function parseSets(text: string): string[] {
  const out: string[] = [];
  for (const s of text.split(/[\s,]+/)) {
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export interface RunFormInput {
  engineId: string;
  agentId: string;
  judgeAgentId: string;
  projectId: string;
  sets: string;
  trials: string;
  budgetUsd: string;
  approverUserId: string;
}

/** the first thing wrong with the form, or null; the server re-checks everything */
export function runFormProblem(f: RunFormInput): string | null {
  if (!f.engineId) return "Choose an enabled engine.";
  if (!f.agentId) return "Choose the agent under test.";
  if (!f.projectId) return "Choose the project the run is billed to; an agent run is pinned to one.";
  if (parseSets(f.sets).length === 0) return "Name at least one set to run.";
  const t = Number(f.trials);
  if (!Number.isInteger(t) || t < 1 || t > 25) return "Trials must be a whole number from 1 to 25.";
  if (f.budgetUsd.trim() !== "") {
    const b = Number(f.budgetUsd);
    if (!Number.isFinite(b) || b <= 0) return "The budget must be a positive amount, or blank for the org default.";
  }
  return null;
}

/** POST /v1/engine-runs body (AgentCoordination §4.10) */
export function runRequestBody(f: RunFormInput): Record<string, unknown> {
  return {
    engineId: f.engineId,
    target: { agentId: f.agentId, ...(f.judgeAgentId ? { judgeAgentId: f.judgeAgentId } : {}) },
    config: { sets: parseSets(f.sets), params: {} },
    projectId: f.projectId,
    trials: Number(f.trials),
    ...(f.budgetUsd.trim() !== "" ? { budgetUsd: Number(f.budgetUsd) } : {}),
    ...(f.approverUserId ? { approverUserId: f.approverUserId } : {}),
  };
}
