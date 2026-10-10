import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import {
  dialPatch,
  dialProblem,
  FRESHNESS_RECHECK_CAP_MS,
  egressReadings,
  engineHealth,
  failureText,
  isCredentialIsolationRefusal,
  nextFreshnessExpiry,
  pagesUsing,
  raisedDials,
  RUNNER_REVOKE_REASON_MAX,
  revokeReasonProblem,
  runnerOnCurrentBuild,
  runnerSelfTestReading,
  selfTestFresh,
  shortDigest,
  startFreshnessClock,
} from "./engineModel";
import type { Engine } from "./engineTypes";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const DIGEST = `sha256:${"a".repeat(64)}`;

function engine(over: Partial<Engine> = {}): Engine {
  return {
    id: "promptfoo",
    kind: "redteam",
    displayName: "promptfoo",
    version: "0.124.0",
    imageDigest: DIGEST,
    signature: "unverified",
    licence: "MIT",
    maintainerCount: null,
    usageDataPosture: { switches: {}, unverified: [], airGappedReducedSet: [] },
    lastVerified: "2026-10-08",
    reCheckBy: "2027-01-08",
    enabled: false,
    timeoutSeconds: 1800,
    maxBudgetUsd: 5,
    maxConcurrent: 1,
    selfTest: null,
    selfTestPassedAt: null,
    needsModelAccess: true,
    airGappedReducedSet: [],
    unverified: [],
    runners: [],
    lastRun: null,
    ...over,
  };
}
const passed = (at: string) => ({ passed: true, failures: [], runnerId: null, imageDigest: DIGEST, version: "0.124.0", egress: null, at });

describe("engineHealth: nothing unmeasured reads as healthy", () => {
  it("only an enabled engine with a fresh passing self-test is ok", () => {
    const h = engineHealth(engine({ enabled: true, selfTest: passed(hoursAgo(1)), selfTestPassedAt: hoursAgo(1) }), NOW);
    expect(h.tone).toBe("ok");
    expect(h.label).toMatch(/On/);
  });

  it("an enabled engine whose passing self-test is older than 24 h is a warning, not ok", () => {
    const h = engineHealth(engine({ enabled: true, selfTest: passed(hoursAgo(25)), selfTestPassedAt: hoursAgo(25) }), NOW);
    expect(h.tone).toBe("warn");
    expect(h.label).toBe("On — self-test not current");
  });

  it("an engine with no image is 'not built' and never ok, whatever else the row says", () => {
    const h = engineHealth(engine({ imageDigest: null, signature: "not_built", enabled: true, selfTest: passed(hoursAgo(1)), selfTestPassedAt: hoursAgo(1) }), NOW);
    expect(h.tone).not.toBe("ok");
    expect(h.label).toBe("Off — not built");
  });

  it("a failed self-test is danger and names its reasons in words", () => {
    const h = engineHealth(engine({ selfTest: { ...passed(hoursAgo(1)), passed: false, failures: ["egress_dns_resolved"] } }), NOW);
    expect(h.tone).toBe("danger");
    expect(h.detail).toContain("resolved a public name");
  });

  it("no self-test at all is neutral and says so", () => {
    const h = engineHealth(engine(), NOW);
    expect(h.tone).toBe("neutral");
    expect(h.label).toBe("Off — no self-test");
  });

  it("a passing record without its passedAt is not fresh (the gateway would refuse to enable)", () => {
    expect(selfTestFresh({ selfTest: passed(hoursAgo(1)), selfTestPassedAt: null }, NOW)).toBe(false);
    expect(selfTestFresh({ selfTest: passed(hoursAgo(1)), selfTestPassedAt: hoursAgo(1) }, NOW)).toBe(true);
  });

  it("every health label states the on/off state in words (no colour-only distinction)", () => {
    const cases = [
      engine(),
      engine({ imageDigest: null }),
      engine({ enabled: true, selfTest: passed(hoursAgo(1)), selfTestPassedAt: hoursAgo(1) }),
      engine({ enabled: true }),
      engine({ selfTest: { ...passed(hoursAgo(1)), passed: false, failures: [] } }),
      engine({ selfTest: passed(hoursAgo(1)), selfTestPassedAt: hoursAgo(1) }),
      engine({ selfTest: passed(hoursAgo(30)), selfTestPassedAt: hoursAgo(30) }),
    ];
    for (const e of cases) expect(engineHealth(e, NOW).label).toMatch(/^(On|Off) — /);
  });
});

describe("egressReadings", () => {
  it("no probe recorded is null, never read as blocked", () => {
    expect(egressReadings(null)).toBeNull();
  });

  it("a probe that reached the network is not blocked", () => {
    const r = egressReadings({ host: "example.com", dnsResolved: true, connected: false, address: "93.184.215.14", addressConnected: true })!;
    expect(r.map((x) => [x.value, x.blocked])).toEqual([
      ["resolved", false],
      ["blocked", true],
      ["connected", false],
    ]);
  });

  it("a missing public address is 'not probed', not blocked", () => {
    const r = egressReadings({ host: "example.com", dnsResolved: false, connected: false, address: null, addressConnected: false })!;
    expect(r[2]).toEqual({ label: "Connect to a public address", value: "not probed", blocked: false });
  });
});

describe("dials", () => {
  const e = engine();
  it("raising a dial is a relaxation; lowering one is not", () => {
    expect(raisedDials(e, { timeoutSeconds: 3600, maxBudgetUsd: 1, maxConcurrent: 1 })).toEqual(["timeoutSeconds"]);
    expect(raisedDials(e, { timeoutSeconds: 600, maxBudgetUsd: 1, maxConcurrent: 1 })).toEqual([]);
  });

  it("the PATCH carries only the fields that changed", () => {
    expect(dialPatch(e, { timeoutSeconds: 1800, maxBudgetUsd: 2.5, maxConcurrent: 1 })).toEqual({ maxBudgetUsd: 2.5 });
    expect(dialPatch(e, { timeoutSeconds: 1800, maxBudgetUsd: 5, maxConcurrent: 1 })).toEqual({});
  });

  it("refuses out-of-range and fractional values before the round trip", () => {
    expect(dialProblem("timeoutSeconds", 59)).toMatch(/between 60 and 7200/);
    expect(dialProblem("maxConcurrent", 1.5)).toMatch(/whole number/);
    expect(dialProblem("maxBudgetUsd", 0.5)).toBeNull();
    expect(dialProblem("maxBudgetUsd", Number.NaN)).toMatch(/must be a number/);
  });
});

describe("misc", () => {
  it("recognises only the decision-79 refusal", () => {
    expect(isCredentialIsolationRefusal(new ApiError(409, { error: "engine_credential_isolation_missing" }))).toBe(true);
    expect(isCredentialIsolationRefusal(new ApiError(409, { error: "engine_self_test_required" }))).toBe(false);
    expect(isCredentialIsolationRefusal(new Error("engine_credential_isolation_missing"))).toBe(false);
  });

  it("a runner on another build does not count", () => {
    expect(runnerOnCurrentBuild(engine(), { reportedDigest: DIGEST, reportedVersion: "0.124.0" })).toBe(true);
    expect(runnerOnCurrentBuild(engine(), { reportedDigest: DIGEST, reportedVersion: "0.123.1" })).toBe(false);
    expect(runnerOnCurrentBuild(engine({ imageDigest: null }), { reportedDigest: DIGEST, reportedVersion: "0.124.0" })).toBe(false);
  });

  it("failure codes read as words, including the per-switch one", () => {
    expect(failureText("usage_env_missing:PROMPTFOO_DISABLE_TELEMETRY")).toContain("PROMPTFOO_DISABLE_TELEMETRY");
    expect(failureText("something_new")).toBe("something new");
  });

  it("pages and digests", () => {
    expect(pagesUsing("model_scan").map((p) => p.to)).toContain("/admin/admission");
    expect(pagesUsing("redteam").map((p) => p.to)).toEqual(["/admin/redteam", "/admin/evals"]);
    expect(shortDigest(DIGEST)).toBe("sha256:aaaaaaaaaaaa…");
    expect(shortDigest(null)).toBe("none");
  });
});

describe("the freshness clock (PR #230 review: no stale green while the page is open)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const greenFor = (passedHoursAgo: number) =>
    engine({ enabled: true, selfTest: passed(hoursAgo(passedHoursAgo)), selfTestPassedAt: hoursAgo(passedHoursAgo) });

  it("the next expiry is the earliest future one; past and missing ones are ignored", () => {
    expect(nextFreshnessExpiry([greenFor(1), greenFor(20), greenFor(30), engine()], NOW)).toBe(NOW + 4 * 3600_000);
    expect(nextFreshnessExpiry([engine(), greenFor(30)], NOW)).toBeNull();
  });

  it("green before expiry, not green after it, with no action but the clock", () => {
    const engines = [greenFor(23.5)]; // expires in 30 minutes
    const labels: string[] = [];
    const stop = startFreshnessClock(() => engines, (now) => labels.push(engineHealth(engines[0]!, now).label));
    expect(engineHealth(engines[0]!, Date.now()).tone).toBe("ok");
    vi.advanceTimersByTime(29 * 60_000);
    expect(labels.at(-1)).toBe("On — self-test passed"); // re-checked under the cap, still fresh
    vi.advanceTimersByTime(2 * 60_000);
    expect(labels.at(-1)).toBe("On — self-test not current");
    stop();
  });

  it("re-checks at least every cap even when the earliest expiry is far off, and stops when stopped", () => {
    const engines = [greenFor(0)];
    let ticks = 0;
    const stop = startFreshnessClock(() => engines, () => ticks++);
    vi.advanceTimersByTime(FRESHNESS_RECHECK_CAP_MS);
    expect(ticks).toBe(1);
    vi.advanceTimersByTime(FRESHNESS_RECHECK_CAP_MS);
    expect(ticks).toBe(2);
    stop();
    vi.advanceTimersByTime(10 * FRESHNESS_RECHECK_CAP_MS);
    expect(ticks).toBe(2);
  });
});

describe("a runner's self-test reading (PR #230 review: a stale report never reads passed)", () => {
  const runner = (over: { selfTestPassed?: boolean | null; selfTestReportedAt?: string | null; selfTestFailures?: string[] }) => ({
    selfTestPassed: true as boolean | null,
    selfTestFailures: [] as string[],
    selfTestReportedAt: hoursAgo(1) as string | null,
    ...over,
  });

  it("a passing report from the last 24 h is the only green reading", () => {
    expect(runnerSelfTestReading(runner({}), NOW)).toEqual({ tone: "ok", label: "passed" });
  });

  it("a passing report older than 24 h reads stale, never passed", () => {
    const r = runnerSelfTestReading(runner({ selfTestReportedAt: hoursAgo(25) }), NOW);
    expect(r.label).toBe("self-test report stale");
    expect(r.tone).not.toBe("ok");
  });

  it("a report dated more than 5 minutes ahead is stale too (the gateway's rule)", () => {
    const r = runnerSelfTestReading(runner({ selfTestReportedAt: new Date(NOW + 10 * 60_000).toISOString() }), NOW);
    expect(r.label).toBe("self-test report stale");
  });

  it("a passing report with no time (an older gateway) is not green", () => {
    const r = runnerSelfTestReading(runner({ selfTestReportedAt: null }), NOW);
    expect(r.tone).not.toBe("ok");
    expect(r.label).toBe("passed, report time unknown");
  });

  it("a failed report is failed whatever its age; no report is no report", () => {
    expect(runnerSelfTestReading(runner({ selfTestPassed: false, selfTestReportedAt: hoursAgo(30) }), NOW)).toEqual({ tone: "danger", label: "failed" });
    expect(runnerSelfTestReading(runner({ selfTestPassed: null }), NOW)).toEqual({ tone: "neutral", label: "no report" });
  });

  it("the freshness clock also wakes at a runner report's expiry", () => {
    const e = engine({
      runners: [{ id: "r", name: "r", reportedDigest: DIGEST, reportedVersion: "0.124.0", selfTestPassed: true, selfTestFailures: [], selfTestReportedAt: hoursAgo(23), registeredAt: hoursAgo(30), lastSeenAt: null }],
    });
    expect(nextFreshnessExpiry([e], NOW)).toBe(NOW + 3600_000);
  });
});

describe("the revocation reason (the gateway's revokeRunnerSchema bound)", () => {
  it("is required and at most RUNNER_REVOKE_REASON_MAX characters, trimmed as the gateway trims it", () => {
    expect(RUNNER_REVOKE_REASON_MAX).toBe(500);
    expect(revokeReasonProblem("   ")).toMatch(/required/);
    expect(revokeReasonProblem("x".repeat(500))).toBeNull();
    expect(revokeReasonProblem(`  ${"x".repeat(500)}  `)).toBeNull();
    expect(revokeReasonProblem("x".repeat(501))).toMatch(/at most 500/);
  });
});
