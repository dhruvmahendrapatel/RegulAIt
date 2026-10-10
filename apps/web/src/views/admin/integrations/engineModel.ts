/**
 * ADR-0187 — the Engines page's pure derivations, kept out of the component so
 * each rule is unit-tested on its own (engineModel.test.ts).
 *
 * The one rule every function here serves (ADR-0180, ADR-0187 "Engines page"):
 * nothing that was not measured reads as healthy. A missing self-test, a stale
 * one, an egress probe that was never run, an unbuilt image or an unverified
 * signature are each stated as what they are, in words, never as a pass and
 * never by colour alone.
 */
import { ApiError } from "../../../api/client";
import type { Tone } from "../../../ui/kit";
import type { Engine, EngineEgressProbe, EnginePatch, EngineRunner } from "./engineTypes";

// Mirrors of @regulait/shared constants (the SPA does not depend on that package);
// packages/shared/src/engines/engines.test.ts pins each one to its source. Keep them
// plain numeric literals so that test can read them.
/** ENGINE_SELF_TEST_MAX_AGE_SECONDS × 1000: how long a self-test (engine record or runner report) counts */
export const SELF_TEST_MAX_AGE_MS = 86_400_000;
/** ENGINE_SELF_TEST_FUTURE_SKEW_MS: a runner report dated further ahead than this is stale */
export const SELF_TEST_FUTURE_SKEW_MS = 300_000;
/** ENGINE_REASON_MAX_LENGTH: revokeRunnerSchema's cap on the audited reason */
export const RUNNER_REVOKE_REASON_MAX = 500;

/** PATCH bounds, mirrored from ENGINE_ROW_LIMITS so the form refuses before the round trip */
export const ENGINE_DIAL_LIMITS = {
  timeoutSeconds: { min: 60, max: 7200 },
  maxBudgetUsd: { min: 0.01, max: 10_000 },
  maxConcurrent: { min: 1, max: 20 },
} as const;
export type EngineDial = keyof typeof ENGINE_DIAL_LIMITS;

/** an enrolment token's lifetime bounds in minutes (ENGINE_ENROLLMENT_TTL_MINUTES) */
export const ENROLLMENT_TTL_MINUTES = { min: 1, max: 60, default: 15 } as const;

export interface EngineHealth {
  tone: Tone;
  /** short, stands alone without its colour */
  label: string;
  /** one sentence: why, and what follows from it */
  detail: string;
}

/** did the engine's recorded self-test pass, and is it still fresh enough to admit enabling? */
export function selfTestFresh(engine: Pick<Engine, "selfTest" | "selfTestPassedAt">, now: number): boolean {
  if (!engine.selfTest?.passed || !engine.selfTestPassedAt) return false;
  const at = Date.parse(engine.selfTestPassedAt);
  return Number.isFinite(at) && now - at <= SELF_TEST_MAX_AGE_MS;
}

/** the engine's state as one badge. Only an enabled engine with a fresh passing self-test is "ok". */
export function engineHealth(engine: Engine, now: number): EngineHealth {
  if (engine.imageDigest === null) {
    return {
      tone: "neutral",
      label: "Off — not built",
      detail: "No signed image exists for this build yet, so its self-test fails (image not built) and it cannot be enabled.",
    };
  }
  const fresh = selfTestFresh(engine, now);
  if (engine.enabled) {
    return fresh
      ? { tone: "ok", label: "On — self-test passed", detail: "Enabled; its last self-test passed within the last 24 hours." }
      : {
          tone: "warn",
          label: "On — self-test not current",
          detail: "Enabled, but no passing self-test from the last 24 hours is recorded, so runners are refused until one passes again.",
        };
  }
  if (engine.selfTest && !engine.selfTest.passed) {
    return { tone: "danger", label: "Off — self-test failed", detail: `Off. Its last self-test failed: ${engine.selfTest.failures.map(failureText).join("; ") || "no reason recorded"}.` };
  }
  if (fresh) return { tone: "neutral", label: "Off — ready to enable", detail: "Off. Its last self-test passed within the last 24 hours, so it can be enabled." };
  if (engine.selfTest?.passed) {
    return { tone: "neutral", label: "Off — self-test too old", detail: "Off. Its last passing self-test is older than 24 hours; run it again before enabling." };
  }
  return { tone: "neutral", label: "Off — no self-test", detail: "Off. No self-test is recorded; enrol a runner from the signed image and run the self-test." };
}

/** a self-test failure code as words (the codes stay visible beside them) */
export function failureText(code: string): string {
  if (code.startsWith("usage_env_missing:")) {
    return `the usage-data switch ${code.slice("usage_env_missing:".length)} was not set to its required value`;
  }
  switch (code) {
    case "image_not_built":
      return "no signed image exists for this build";
    case "digest_mismatch":
      return "the runner's image digest is not the build's";
    case "version_mismatch":
      return "the runner's engine version is not the build's";
    case "egress_dns_resolved":
      return "the egress probe resolved a public name (DNS is not blocked)";
    case "egress_connected":
      return "the egress probe connected to a public host";
    case "egress_address_missing":
      return "no public literal address was probed, so routable egress was not tested";
    case "egress_address_connected":
      return "the egress probe connected to a public address";
    case "stale":
      return "the runner's report is older than 24 hours (or dated in the future)";
    case "no_runner":
      return "no runner has reported";
    default:
      return code.replaceAll("_", " ");
  }
}

export interface EgressReading {
  label: string;
  /** what was observed, in words */
  value: string;
  /** true only when egress was shown to be blocked */
  blocked: boolean;
}

/** the last egress probe, reading by reading; null = no probe recorded (never read as blocked) */
export function egressReadings(egress: EngineEgressProbe | null | undefined): EgressReading[] | null {
  if (!egress) return null;
  const hasAddress = Boolean(egress.address);
  return [
    { label: `DNS for ${egress.host}`, value: egress.dnsResolved ? "resolved" : "blocked", blocked: !egress.dnsResolved },
    { label: `Connect to ${egress.host}`, value: egress.connected ? "connected" : "blocked", blocked: !egress.connected },
    hasAddress
      ? {
          label: `Connect to ${egress.address}`,
          value: egress.addressConnected ? "connected" : "blocked",
          blocked: !egress.addressConnected,
        }
      : { label: "Connect to a public address", value: "not probed", blocked: false },
  ];
}

/** does this runner run the engine's CURRENT build? Only such a runner's report counts (ADR-0187 decision 91). */
export function runnerOnCurrentBuild(engine: Pick<Engine, "imageDigest" | "version">, runner: Pick<EngineRunner, "reportedDigest" | "reportedVersion">): boolean {
  return engine.imageDigest !== null && runner.reportedDigest === engine.imageDigest && runner.reportedVersion === engine.version;
}

/**
 * The dials a PATCH raises against the row as loaded: these are relaxations, so
 * the gateway asks for a step-up (mirrors `engineRowRelaxations` for the dials).
 */
export function raisedDials(engine: Pick<Engine, EngineDial>, next: Partial<Record<EngineDial, number>>): EngineDial[] {
  return (Object.keys(ENGINE_DIAL_LIMITS) as EngineDial[]).filter((k) => next[k] !== undefined && next[k]! > engine[k]);
}

/** the PATCH body for the dials form: only the fields that changed */
export function dialPatch(engine: Pick<Engine, EngineDial>, next: Record<EngineDial, number>): EnginePatch {
  const out: EnginePatch = {};
  for (const k of Object.keys(ENGINE_DIAL_LIMITS) as EngineDial[]) {
    if (next[k] !== engine[k]) out[k] = next[k];
  }
  return out;
}

/** a dial value the gateway would refuse, as a sentence; null when it is in range */
export function dialProblem(dial: EngineDial, value: number): string | null {
  const { min, max } = ENGINE_DIAL_LIMITS[dial];
  const name = dial === "timeoutSeconds" ? "Timeout (seconds)" : dial === "maxBudgetUsd" ? "Budget ceiling (USD)" : "Concurrent runs";
  if (!Number.isFinite(value)) return `${name} must be a number`;
  if (dial !== "maxBudgetUsd" && !Number.isInteger(value)) return `${name} must be a whole number`;
  if (value < min || value > max) return `${name} must be between ${min} and ${max}`;
  return null;
}

/** is this the gateway's decision-79 refusal (a build that does not isolate the runner credential)? */
export function isCredentialIsolationRefusal(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409 && err.payload.error === "engine_credential_isolation_missing";
}

/** the existing pages that use an engine (ADR-0177 §3: run surfaces live there, not here) */
export function pagesUsing(kind: string): Array<{ label: string; to: string }> {
  if (kind === "model_scan") return [{ label: "Admission review (model artifacts)", to: "/admin/admission" }, { label: "Model risk (model cards)", to: "/admin/model-risk" }];
  if (kind === "redteam") return [{ label: "Red-teaming", to: "/admin/redteam" }, { label: "Evaluations", to: "/admin/evals" }];
  return [];
}

/** `sha256:abcdef…` → a readable prefix; the full value stays in the title */
export function shortDigest(digest: string | null | undefined): string {
  if (!digest) return "none";
  const [algo, hex] = digest.includes(":") ? (digest.split(":", 2) as [string, string]) : ["", digest];
  return `${algo ? `${algo}:` : ""}${hex.slice(0, 12)}…`;
}

/**
 * PR #230 review: a page left open must not keep showing a self-test as fresh
 * after the gateway stopped accepting it. The earliest future moment one of
 * these engines' passing self-tests crosses the 24 h bound, or null.
 */
export function nextFreshnessExpiry(engines: ReadonlyArray<FreshnessSource>, now: number): number | null {
  let next: number | null = null;
  const consider = (passedAt: string | null | undefined) => {
    if (!passedAt) return;
    const expiry = Date.parse(passedAt) + SELF_TEST_MAX_AGE_MS;
    if (Number.isFinite(expiry) && expiry >= now && (next === null || expiry < next)) next = expiry;
  };
  for (const e of engines) {
    if (e.selfTest?.passed) consider(e.selfTestPassedAt);
    // each runner's passing report expires on its own (PR #230 review)
    for (const r of e.runners ?? []) if (r.selfTestPassed === true) consider(r.selfTestReportedAt);
  }
  return next;
}

type FreshnessSource = Pick<Engine, "selfTest" | "selfTestPassedAt"> & {
  runners?: ReadonlyArray<Pick<EngineRunner, "selfTestPassed" | "selfTestReportedAt">>;
};

/**
 * A runner's own self-test report as one reading. The gateway's lease refuses a
 * runner whose report is older than 24 h (or dated more than 5 minutes ahead), so
 * only a passing report inside that window is green; a recorded "passed" outside
 * it reads "self-test report stale" (PR #230 review).
 */
export function runnerSelfTestReading(
  runner: Pick<EngineRunner, "selfTestPassed" | "selfTestReportedAt">,
  now: number,
): { tone: Tone; label: string } {
  if (runner.selfTestPassed === false) return { tone: "danger", label: "failed" };
  if (runner.selfTestPassed !== true) return { tone: "neutral", label: "no report" };
  if (!runner.selfTestReportedAt) return { tone: "neutral", label: "passed, report time unknown" };
  const at = Date.parse(runner.selfTestReportedAt);
  if (!Number.isFinite(at) || now - at > SELF_TEST_MAX_AGE_MS || at - now > SELF_TEST_FUTURE_SKEW_MS) {
    return { tone: "warn", label: "self-test report stale" };
  }
  return { tone: "ok", label: "passed" };
}

/** the revocation reason as the gateway will judge it (trimmed, 1–RUNNER_REVOKE_REASON_MAX characters); null = fine */
export function revokeReasonProblem(reason: string): string | null {
  const t = reason.trim();
  if (t.length === 0) return "A reason is required — it becomes the audited record.";
  if (t.length > RUNNER_REVOKE_REASON_MAX) return `The reason must be at most ${RUNNER_REVOKE_REASON_MAX} characters (it is ${t.length}).`;
  return null;
}

/** the longest the page goes without re-reading the clock, whatever the next expiry */
export const FRESHNESS_RECHECK_CAP_MS = 5 * 60_000;

/**
 * Calls `onTick(now)` just after the earliest freshness expiry of `getEngines()`
 * (and at least every FRESHNESS_RECHECK_CAP_MS), re-arming after each tick.
 * Returns the function that stops it.
 */
export function startFreshnessClock(
  getEngines: () => ReadonlyArray<FreshnessSource>,
  onTick: (now: number) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    const now = Date.now();
    const expiry = nextFreshnessExpiry(getEngines(), now);
    // +1 ms: fresh means "at most 24 h old", so the reading changes just after the bound
    const delay = expiry === null ? FRESHNESS_RECHECK_CAP_MS : Math.min(expiry - now + 1, FRESHNESS_RECHECK_CAP_MS);
    timer = setTimeout(() => {
      if (stopped) return;
      onTick(Date.now());
      arm();
    }, delay);
  };
  arm();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

/** a run status from the engine's `lastRun` — a status, never a verdict, so never toned as a pass */
export function lastRunText(status: string): string {
  return status.replaceAll("_", " ");
}
