/**
 * ADR-0173 batch 2c (E) — the Evaluations page against a mocked gateway: the
 * Catalog tab (references, OWASP attribution), Compare (a result, and the
 * server's refusal across dataset versions shown as the answer), the judge
 * panel in the run form (the request carries the panel), and the run detail's
 * panel summary and observe-only Judge calibration card. Axe in light and dark.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = "11111111-1111-4111-8111-111111111111";
const DS = "d0000000-0000-4000-8000-000000000001";
const DS2 = "d0000000-0000-4000-8000-000000000002";
const SUBJECT = "a0000000-0000-4000-8000-000000000001";
const JUDGE_A = "a0000000-0000-4000-8000-000000000002";
const JUDGE_B = "a0000000-0000-4000-8000-000000000003";
const RUN_1 = "e0000000-0000-4000-8000-000000000001";
const RUN_2 = "e0000000-0000-4000-8000-000000000002";
const RUN_V2 = "e0000000-0000-4000-8000-000000000003";
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const refs = (nist: string[], iso42001: string[], eu: string[], owasp: string[]) => ({ nistAiRmf: nist, iso42001, euAiAct: eu, owasp });
const CATALOG = {
  evaluators: [
    { id: "scorer:exact", kind: "scorer", name: "exact", summary: "Exact match.", limits: "Brittle by design.", deterministic: true, runnableOn: ["dataset", "trace"], refs: refs(["MEASURE-2.1", "MEASURE-2.5"], ["iso-42001:9.1-monitoring-measurement"], ["eu-ai-act:art-15-accuracy-robustness"], []) },
    { id: "scorer:llm_as_judge", kind: "scorer", name: "llm_as_judge", summary: "A judge agent scores.", limits: "Not free; varies run to run.", deterministic: false, runnableOn: ["dataset"], refs: refs(["MEASURE-2.5"], ["iso-42001:9.1-monitoring-measurement"], [], []) },
    { id: "detector:prompt_injection", kind: "detector", name: "prompt_injection", summary: "Instruction override.", limits: "Lexical.", deterministic: true, runnableOn: ["runtime", "trace"], refs: refs(["MEASURE-2.7"], ["iso-42001:9.1-monitoring-measurement"], ["eu-ai-act:art-15-accuracy-robustness"], ["owasp:llm:01", "owasp:agentic:asi01"]) },
    { id: "redteam:tool_abuse", kind: "redteam_class", name: "tool_abuse", summary: "Induced tool call.", limits: "A decision, never an execution.", deterministic: false, runnableOn: ["redteam"], refs: refs(["MEASURE-2.7"], ["iso-42001:A.6-ai-system-lifecycle"], ["eu-ai-act:art-14-human-oversight"], ["owasp:llm:06", "owasp:agentic:asi02"]) },
  ],
  counts: { scorers: 13, detectors: 5, redteamClasses: 10, externalScorers: 0 },
  owasp: {
    references: [
      { id: "owasp:llm:01", list: "owasp-llm-top-10", name: "Prompt Injection" },
      { id: "owasp:llm:06", list: "owasp-llm-top-10", name: "Excessive Agency" },
      { id: "owasp:agentic:asi01", list: "owasp-agentic-top-10", name: "ASI01: Agent Goal Hijack" },
      { id: "owasp:agentic:asi02", list: "owasp-agentic-top-10", name: "ASI02: Tool Misuse and Exploitation" },
    ],
    source: { project: "promptfoo", release: "0.123.1", commit: "34f74d34e140b5e17d23770dfb2340057b1936b8", licence: "MIT" },
  },
  note: "Every evaluator cites the controls it is evidence for.",
};

const run = (id: string, datasetId: string, version: number, extra: Json = {}) => ({
  id,
  datasetId,
  datasetName: "golden",
  datasetVersion: version,
  agentName: "subject",
  model: "m1",
  trigger: "manual",
  status: "completed",
  cases: 3,
  passedCases: 2,
  meanScore: 0.7,
  passRate: 0.67,
  scoreDelta: null,
  gatePassed: true,
  regression: false,
  gateReason: "first reference",
  isBaseline: false,
  costUsd: 0.01,
  judgeImpl: null,
  startedAt: iso(30),
  ...extra,
});

async function mockApi(page: Page) {
  const calls: Array<{ method: string; path: string; body: Json }> = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method: req.method(), path: p + url.search, body });
    if (p === "/auth/me")
      return json(route, { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: ME, isAdmin: true, user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/agents")
      return json(route, {
        agents: [
          { id: SUBJECT, name: "subject", provider: "mock", tier: 1, model: "m1", enabled: true },
          { id: JUDGE_A, name: "judge-a", provider: "mock", tier: 1, model: "m1", enabled: true },
          { id: JUDGE_B, name: "judge-b", provider: "mock", tier: 1, model: "m1", enabled: true },
        ],
      });
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (p === "/v1/evals/scorers")
      return json(route, { scorers: [{ id: "llm_as_judge", deterministic: false, modelBacked: true, summary: "Judge.", limits: "Not free." }], note: "Scorers." });
    if (p === "/v1/evals/scoring-semantics")
      return json(route, { current: 2, versions: [{ version: 2, adr: "ADR-0072", summary: "Current." }], evalRuns: [{ version: 2, runs: 3, comparableToCurrent: true }], stalePinnedBaselines: [], note: "Semantics." });
    if (p === "/v1/evals/datasets")
      return json(route, { datasets: [{ id: DS, name: "golden", version: 1, note: null, scorerKind: "llm_as_judge", scorerConfig: {}, caseCount: 3, runCount: 2, frozen: true, createdAt: iso(90) }], note: "Datasets freeze." });
    if (p === `/v1/evals/datasets/${DS}`)
      return json(route, { dataset: { id: DS, name: "golden", version: 1, scorerKind: "llm_as_judge" }, cases: [{ id: "c1", input: "What is the status?", expected: "ok", scorerKind: null, tags: [] }], frozen: true });
    if (p === "/v1/evals/runs" && req.method() === "GET")
      return json(route, { runs: [run(RUN_1, DS, 1), run(RUN_2, DS, 1, { agentName: "panel-subject", judgeImpl: "panel:model:judge-a,model:judge-b", judgePanel: [{ agentId: JUDGE_A, agentName: "judge-a", weight: 3 }, { agentId: JUDGE_B, agentName: "judge-b", weight: 1 }], repetitions: 2, scoreCi: { low: 0.55, high: 0.85, level: 0.95, resamples: 1000 } }), run(RUN_V2, DS2, 2)] });
    if (p === "/v1/evals/runs" && req.method() === "POST") return json(route, { run: run(RUN_2, DS, 1), aggregate: {}, gate: {} }, 201);
    if (p === `/v1/evals/runs/${RUN_2}`)
      return json(route, {
        run: run(RUN_2, DS, 1, { agentName: "panel-subject", judgeImpl: "panel:model:judge-a,model:judge-b", judgePanel: [{ agentId: JUDGE_A, agentName: "judge-a", weight: 3 }, { agentId: JUDGE_B, agentName: "judge-b", weight: 1 }], repetitions: 2, scoreCi: { low: 0.55, high: 0.85, level: 0.95, resamples: 1000 } }),
        results: [{ id: "r1", caseId: "c1", scorerKind: "llm_as_judge", score: 0.75, passed: true, latencyMs: 12, costUsd: 0.001, outputText: "ok", judgeRationale: null, error: null, input: "What is the status?", detail: { method: "model-judged" } }],
        baseline: null,
        diff: [],
        verdicts: [1, 2, 3, 4].map((i) => ({ id: `v${i}`, caseId: "c1", judgeName: i <= 2 ? "model:judge-a" : "model:judge-b", weight: i <= 2 ? 3 : 1, repetition: ((i - 1) % 2) + 1, score: i <= 2 ? 1 : 0, error: null })),
      });
    if (p === `/v1/evals/runs/${RUN_2}/calibration`)
      return json(route, {
        judgedResults: 3,
        labelledResults: 3,
        judges: [
          { judge: "model:judge-a", weight: 3, report: { status: "insufficient", pairs: 3, required: 20, kappa: null, agreement: null, interval: null, note: "3 completed paired label(s)" } },
          { judge: "model:judge-b", weight: 1, report: { status: "insufficient", pairs: 3, required: 20, kappa: null, agreement: null, interval: null, note: "3 completed paired label(s)" } },
        ],
        combined: { status: "insufficient", pairs: 3, required: 20, kappa: null, agreement: null, interval: null, note: "3" },
        gate: { gatePassed: true },
        note: "Observe-only.",
      });
    if (p === "/v1/evals/catalog") return json(route, CATALOG);
    if (p === "/v1/evals/compare") {
      const b = url.searchParams.get("b");
      if (b === RUN_V2)
        return json(route, { error: "dataset_version_mismatch", detail: "the two runs scored different dataset versions, so their cases are not the same cases" }, 422);
      const side = (id: string, mean: number) => ({ id, agentName: "subject", model: id === RUN_1 ? "m1" : "m2", tier: 1, configHash: id.replace(/-/g, ""), judgeImpl: null, repetitions: 1, trigger: "manual", meanScore: mean, passRate: 0.67, cases: 2, gatePassed: true, scoreCi: null });
      return json(route, {
        datasetVersion: 1,
        a: side(RUN_1, 0.5),
        b: side(RUN_2, 0.75),
        differs: { model: true, tier: false, systemPrompt: false, configuration: true, judge: false },
        delta: { meanScore: 0.25, passRate: 0 },
        cases: [
          { caseId: "c1", input: "What is the status?", a: { score: 0.5, passed: false }, b: { score: 1, passed: true }, delta: 0.5, changed: true },
          { caseId: "c2", input: "Who owns it?", a: { score: 0.5, passed: true }, b: { score: 0.5, passed: true }, delta: 0, changed: false },
        ],
        changedCases: 1,
      });
    }
    return json(route, {});
  });
  return calls;
}

test.describe("Evaluations — catalog, compare, judge panels and calibration", () => {
  test("the Catalog tab lists evaluators with their control references and the OWASP attribution", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/evals");
    await page.getByRole("tab", { name: "Catalog" }).click();
    await expect(page.getByText("scorer:exact")).toBeVisible();
    await expect(page.getByText("redteam:tool_abuse")).toBeVisible();
    await expect(page.getByTestId("owasp-attribution")).toContainText("promptfoo's framework mapping tables, release 0.123.1");
    await page.getByLabel("Search name or control").fill("owasp:llm:01");
    await expect(page.getByText("detector:prompt_injection")).toBeVisible();
    await expect(page.getByText("scorer:exact")).toHaveCount(0);
    await expectAxeClean(page, "evals catalog");
  });

  test("Compare shows the changed configuration and cases, and a cross-version pair is refused with the server's reason", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/evals");
    await page.getByRole("tab", { name: "Compare" }).click();
    await page.getByLabel("Run A (before)").selectOption(RUN_1);
    await page.getByLabel("Run B (after)").selectOption(RUN_2);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const result = page.getByTestId("compare-result");
    await expect(result).toContainText("Mean score +0.250");
    await expect(result).toContainText("1 case(s) changed pass/fail");
    await expect(result.getByText("flipped")).toBeVisible();
    await expectAxeClean(page, "evals compare");
    await page.getByLabel("Run B (after)").selectOption(RUN_V2);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.getByTestId("compare-refusal")).toContainText("dataset_version_mismatch");
    await expectAxeClean(page, "evals compare refused");
  });

  test("the run form sends a weighted judge panel, and run detail shows the panel, the interval and the calibration card", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/ui/admin/evals");
    await page.getByRole("link", { name: /^golden v1 3 2 llm_as_judge/ }).click();
    await page.getByLabel("Agent under test").selectOption(SUBJECT);
    const panel = page.getByTestId("judge-panel");
    await panel.getByLabel(/Score the judged cases with a weighted panel/).check();
    await expect(page.getByTestId("panel-problem")).toContainText("Choose an agent for every judge");
    await expect(page.getByRole("button", { name: "Run now" })).toBeDisabled();
    await panel.getByLabel("Judge 1", { exact: true }).selectOption(JUDGE_A);
    await panel.getByLabel("Weight of judge 1").fill("3");
    await panel.getByLabel("Judge 2", { exact: true }).selectOption(JUDGE_B);
    await expect(page.getByTestId("panel-problem")).toHaveCount(0);
    await expectAxeClean(page, "evals run form with a judge panel");
    await page.getByRole("button", { name: "Run now" }).click();
    await expect
      .poll(() => calls.find((c) => c.method === "POST" && c.path === "/v1/evals/runs")?.body)
      .toMatchObject({ datasetId: DS, agentId: SUBJECT, repetitions: 1, judgePanel: [{ agentId: JUDGE_A, weight: 3 }, { agentId: JUDGE_B, weight: 1 }] });
    expect(calls.find((c) => c.method === "POST" && c.path === "/v1/evals/runs")?.body.judgeAgentId).toBeUndefined();

    await page.getByRole("link", { name: /panel-subject/ }).click();
    const summary = page.getByTestId("run-panel-summary");
    await expect(summary).toContainText("judge-a ×3");
    await expect(summary).toContainText("0.550 – 0.850");
    await expect(summary).toContainText("verdicts kept");
    const card = page.getByTestId("judge-calibration");
    await expect(card).toContainText("Observe-only");
    await card.getByRole("button", { name: "Calculate agreement" }).click();
    await expect(card).toContainText("insufficient (3 / 20)");
    await expectAxeClean(page, "evals run detail with calibration");
  });
});
