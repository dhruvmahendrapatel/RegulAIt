/**
 * ADR-0187 (X27) — the engine-run views never render `not_run` or `unknown`
 * as a pass, and never render a raw text field. Rendered with
 * react-dom/server (no DOM): the markup the components emit is the evidence.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { EngineProvenanceChip, EngineRunStatusBadge, EngineVerdictBadge } from "./EngineRunBadges";
import { EngineRunDetailView } from "./EngineRunsPanel";
import {
  engineRunItemView,
  heartbeatState,
  parseSets,
  runFormProblem,
  runProvenance,
  runRequestBody,
  runVerdict,
  verdictDisplay,
  type EngineInfo,
  type EngineRun,
} from "./engineRuns";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const at = (secsAgo: number) => new Date(NOW - secsAgo * 1000).toISOString();

const run = (over: Partial<EngineRun>): EngineRun => ({
  id: "99999999-1111-4000-8000-000000000004",
  engineId: "promptfoo",
  engineVersion: "0.123.1",
  status: "completed",
  trigger: "manual",
  runAsUserId: null,
  projectId: null,
  targetKind: "agent",
  targetAgentId: null,
  judgeAgentId: null,
  targetArtifactId: null,
  config: { sets: ["basic"], params: {} },
  configHash: null,
  trials: 3,
  budgetUsd: 2,
  costUsd: 0,
  timeoutSeconds: 1800,
  runnerId: null,
  approvalId: null,
  scheduleId: null,
  workflowInstanceId: null,
  createdAt: at(600),
  leasedAt: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  phase: null,
  progress: null,
  deadlineAt: null,
  cancelRequestedAt: null,
  finishedAt: at(60),
  errorCode: null,
  summary: null,
  rawReportSha256: null,
  rawReportStored: false,
  redteamRunId: null,
  evalRunId: null,
  ...over,
});

const engine: EngineInfo = {
  id: "promptfoo",
  kind: "redteam",
  displayName: "promptfoo",
  version: "0.123.1",
  imageDigest: `sha256:${"c".repeat(64)}`,
  signature: "unverified",
  enabled: true,
  maxBudgetUsd: 5,
  timeoutSeconds: 1800,
  needsModelAccess: true,
  runners: [{ id: "r1", name: "runner-1", reportedDigest: `sha256:${"a".repeat(64)}`, reportedVersion: "0.123.1" }],
};

/** an item as the API returns it, plus fields that must never reach the screen */
const RAW_MARKERS = ["RAW-MODEL-OUTPUT-7731", "RAW-PROMPT-7731", "RAW-RESPONSE-7731", "RAW-REPORT-7731", "RAW-TRANSCRIPT-7731"];
const apiItem = (over: Record<string, unknown>) => ({
  key: "pi-1",
  sourceSystem: "promptfoo",
  sourceId: "prompt-injection",
  attackClass: "prompt_injection",
  scorerKind: null,
  claimedClass: null,
  severity: "high",
  attempts: 3,
  defeated: 0,
  claimedVerdict: "pass",
  verdict: "pass",
  reason: null,
  verdictNote: null,
  notRunReason: null,
  dispatchAuditIds: [],
  output: RAW_MARKERS[0],
  prompt: RAW_MARKERS[1],
  response: RAW_MARKERS[2],
  rawReport: RAW_MARKERS[3],
  transcript: RAW_MARKERS[4],
  ...over,
});

const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
/** the visible label inside every verdict badge on a page */
const verdictLabels = (markup: string): string[] =>
  [...markup.matchAll(/data-testid="engine-verdict" data-verdict="([^"]*)"[^>]*><span[^>]*>([^<]*)<\/span>/g)].map((m) => `${m[1]}=>${m[2]}`);

describe("verdicts: only `pass` is a pass", () => {
  it("maps pass to the positive tone and every other verdict to words that say it is not a pass", () => {
    expect(verdictDisplay("pass")).toMatchObject({ label: "pass", tone: "ok" });
    expect(verdictDisplay("fail")).toMatchObject({ label: "fail", tone: "danger" });
    for (const v of ["unknown", "not_run", "skipped", "", null, undefined]) {
      const d = verdictDisplay(v);
      expect(d.tone, String(v)).not.toBe("ok");
      expect(d.label, String(v)).not.toBe("pass");
      expect(d.label, String(v)).toContain("not a pass");
    }
  });

  it("renders the unknown and not_run badges with their words, never the pass label or tone", () => {
    for (const verdict of ["unknown", "not_run"]) {
      const markup = html(<EngineVerdictBadge verdict={verdict} />);
      expect(markup).not.toMatch(/>pass</);
      expect(markup).toContain("not a pass");
      expect(markup).not.toContain(renderToStaticMarkup(<EngineVerdictBadge verdict="pass" />).match(/class="([^"]+)"/)![1]);
    }
  });

  it("never shows a run that did not complete as a pass, whatever its summary claims", () => {
    for (const status of ["failed", "timeout", "cancelled"]) {
      expect(runVerdict({ status, summary: { verdict: "pass" } })).toBe("unknown");
    }
    expect(runVerdict({ status: "not_run", summary: { verdict: "pass" } })).toBe("not_run");
    expect(runVerdict({ status: "completed", summary: null })).toBe("unknown");
    expect(runVerdict({ status: "leased", summary: null })).toBeNull();
    expect(runVerdict({ status: "completed", summary: { verdict: "pass" } })).toBe("pass");
  });

  it("run detail: a timed-out run with a (hostile) pass summary and unknown/not_run items shows no pass anywhere", () => {
    const markup = html(
      <EngineRunDetailView
        surface="redteam"
        run={run({ status: "timeout", errorCode: "deadline_passed", summary: { verdict: "pass", counts: { pass: 0, fail: 0, unknown: 1, not_run: 1 } } })}
        items={[apiItem({ key: "u1", verdict: "unknown", claimedVerdict: "pass" }), apiItem({ key: "n1", verdict: "not_run", claimedVerdict: "pass", notRunReason: "egress_denied" })].map(engineRunItemView)}
        engine={engine}
        now={NOW}
      />,
    );
    const labels = verdictLabels(markup);
    expect(labels).toEqual(["unknown=>unknown (not a pass)", "unknown=>unknown (not a pass)", "not_run=>not run (not a pass)"]);
    expect(labels.some((l) => l.endsWith("=>pass"))).toBe(false);
    expect(markup).toContain("pass (overridden)");
    expect(markup).toContain("timed out");
  });

  it("a completed pass with excluded items says the pass covers only what ran", () => {
    const markup = html(
      <EngineRunDetailView surface="evals" run={run({ summary: { verdict: "pass", counts: { pass: 2, fail: 0, unknown: 0, not_run: 1 } } })} items={[]} engine={engine} now={NOW} />,
    );
    expect(markup).toContain("the pass covers only the items that ran; the 1 others are not a pass");
  });
});

describe("no raw model text", () => {
  it("engineRunItemView keeps the allow-listed fields only", () => {
    const view = engineRunItemView(apiItem({}));
    expect(Object.keys(view).sort()).toEqual(
      ["attackClass", "attempts", "claimedVerdict", "defeated", "key", "notRunReason", "reason", "severity", "sourceId", "sourceSystem", "verdict", "verdictNote"].sort(),
    );
    for (const m of RAW_MARKERS) expect(JSON.stringify(view)).not.toContain(m);
  });

  it("run detail renders none of an item's raw fields, and the raw report only as its hash", () => {
    const markup = html(
      <EngineRunDetailView
        surface="redteam"
        run={run({ rawReportSha256: "e".repeat(64), rawReportStored: true, summary: { verdict: "fail", counts: { pass: 1, fail: 1, unknown: 0, not_run: 0 }, explanation: "run completed: 1 pass, 1 fail" } })}
        items={[apiItem({}), apiItem({ key: "pii-1", verdict: "fail", defeated: 1, verdictNote: "1 of 3 attempts defeated the target" })].map(engineRunItemView)}
        engine={engine}
        now={NOW}
      />,
    );
    for (const m of RAW_MARKERS) expect(markup).not.toContain(m);
    expect(markup).toContain("1 of 3 attempts defeated the target");
    expect(markup).toContain("stored encrypted, not shown here");
  });

  it("clips an over-long note", () => {
    expect(engineRunItemView(apiItem({ reason: "x".repeat(1000) })).reason).toHaveLength(301);
  });
});

describe("not-run list, status, heartbeat, provenance", () => {
  it("lists each not-run item with its reason code and meaning", () => {
    const markup = html(
      <EngineRunDetailView
        surface="redteam"
        run={run({ summary: { verdict: "fail", counts: { pass: 0, fail: 1, unknown: 0, not_run: 2 } } })}
        items={[
          apiItem({ key: "pi-egress", verdict: "not_run", notRunReason: "egress_denied" }),
          apiItem({ key: "cloud-thing", verdict: "not_run", notRunReason: "cloud_only" }),
          apiItem({ key: "pii-1", verdict: "fail", defeated: 1 }),
        ].map(engineRunItemView)}
        engine={engine}
        now={NOW}
      />,
    );
    const list = markup.slice(markup.indexOf('data-testid="engine-not-run-list"'));
    expect(list).toContain("Not run (2)");
    expect(list).toContain("egress_denied");
    expect(list).toContain("the sandbox denied it");
    expect(list).toContain("cloud_only");
    expect(list).not.toContain("pii-1");
  });

  it("labels statuses in words", () => {
    expect(html(<EngineRunStatusBadge status="awaiting_approval" />)).toContain("awaiting approval");
    expect(html(<EngineRunStatusBadge status="leased" />)).toContain("running");
    expect(html(<EngineRunStatusBadge status="not_run" />)).toContain("not run");
  });

  it("reports a fresh heartbeat, a stale one, and none for a run that is not leased", () => {
    expect(heartbeatState({ status: "leased", heartbeatAt: at(10) }, NOW)).toMatchObject({ tone: "ok", label: "last heartbeat 10s ago" });
    expect(heartbeatState({ status: "leased", heartbeatAt: at(200) }, NOW)?.tone).toBe("warn");
    expect(heartbeatState({ status: "leased", heartbeatAt: null }, NOW)?.label).toBe("no heartbeat yet");
    expect(heartbeatState({ status: "queued", heartbeatAt: at(1) }, NOW)).toBeNull();
  });

  it("shows the digest of the runner that ran it, never the engine's current one as if it were the run's", () => {
    const p = runProvenance(run({ runnerId: "r1" }), engine);
    expect(p).toMatchObject({ engine: "promptfoo", version: "0.123.1", digest: `sha256:${"a".repeat(64)}`, digestSource: "runner" });
    const none = runProvenance(run({ runnerId: null }), engine);
    expect(none.digest).toBeNull();
    const chip = html(<EngineProvenanceChip provenance={none} />);
    expect(chip).toContain("image digest not recorded on this run");
    expect(chip).not.toContain("c".repeat(12));
    const stamped = runProvenance(run({ imageDigest: `sha256:${"d".repeat(64)}`, manifestGeneration: 2 }), engine);
    expect(html(<EngineProvenanceChip provenance={stamped} />)).toContain("manifest gen. 2");
  });
});

describe("the run form", () => {
  const base = { engineId: "promptfoo", agentId: "a", judgeAgentId: "", projectId: "p", sets: "basic, agentic basic", trials: "3", budgetUsd: "", approverUserId: "" };
  it("parses sets and refuses an incomplete form", () => {
    expect(parseSets("basic, agentic basic")).toEqual(["basic", "agentic"]);
    expect(runFormProblem(base)).toBeNull();
    expect(runFormProblem({ ...base, projectId: "" })).toMatch(/project/);
    expect(runFormProblem({ ...base, sets: " , " })).toMatch(/set/);
    expect(runFormProblem({ ...base, trials: "26" })).toMatch(/1 to 25/);
    expect(runFormProblem({ ...base, budgetUsd: "-1" })).toMatch(/budget/);
  });
  it("builds the §4.10 request body, omitting blank optionals", () => {
    expect(runRequestBody(base)).toEqual({ engineId: "promptfoo", target: { agentId: "a" }, config: { sets: ["basic", "agentic"], params: {} }, projectId: "p", trials: 3 });
    expect(runRequestBody({ ...base, judgeAgentId: "j", budgetUsd: "4.5", approverUserId: "u" })).toMatchObject({ target: { agentId: "a", judgeAgentId: "j" }, budgetUsd: 4.5, approverUserId: "u" });
  });
});
