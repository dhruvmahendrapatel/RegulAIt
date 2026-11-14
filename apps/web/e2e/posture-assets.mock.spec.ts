/**
 * Per-asset posture scores, from the browser's side. Every /v1 and /auth call is answered by an in-test mock that
 * follows apps/gateway/src/asset-score.ts: the list `{ kind, objectives, items, nextCursor, limit, disclaimer }` in name
 * order with a keyset cursor (at most 100 a page), and the detail as one score; a caller who cannot read an asset gets
 * a 404 `not_found`, and a credential with no user a 403 `no_user_identity`.
 *
 * Covered: the Posture page's "Scores by asset" list with Load more, the agent / use-case toggle and its empty state,
 * loading then data, a failed read with Retry, a row opening the score in a drawer (estimate label, disclaimer,
 * unmeasured never shown as 0, not-applicable reasons with no score, ranked actions with in-app links), the 404 and
 * 403 states, the score card on the use-case page, and axe in light and dark. There are no mutations. Synthetic names
 * only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";

const UC = "11111111-1111-4111-8111-111111111111";
const A1 = "a1111111-1111-4111-8111-111111111111";
const A2 = "a2222222-2222-4222-8222-222222222222";
const A3 = "a3333333-3333-4333-8333-333333333333";
const GONE = "a9999999-9999-4999-8999-999999999999";
const DISCLAIMER = "An estimate computed from this deployment's own records. It is not a compliance verdict, an audit opinion or a certification, and a high figure does not mean an obligation is met.";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function agentScore(id: string, name: string, score: number) {
  return {
    estimate: true,
    asset: { kind: "agent", id, name },
    score,
    scale: { min: 0, max: 100 },
    method: "The weighted mean of the 4 objectives that apply to an agent, using the published weights.",
    disclaimer: DISCLAIMER,
    weights: [
      { objective: "risk", title: "Risk treatment", weight: 20, sharePct: 28.6 },
      { objective: "adversarial", title: "Adversarial resilience", weight: 20, sharePct: 28.6 },
      { objective: "access", title: "Access hygiene", weight: 15, sharePct: 21.4 },
      { objective: "evaluation", title: "Answer quality", weight: 15, sharePct: 21.4 },
    ],
    notApplicable: [
      { objective: "coverage", title: "Control coverage", why: "compliance packs are evaluated for the organisation or a project, not for one agent" },
      { objective: "spend", title: "Spend control", why: "budgets are set on projects, not on agents" },
    ],
    objectives: [
      { id: "risk", title: "Risk treatment", outcome: "Every AI risk has a treatment.", metric: { label: "Registered risks with a treatment", value: "50%" }, weight: 20, measured: true, score: 50, contribution: 10, inputs: [], formula: "Treated ÷ all.", link: { to: "/admin/risks", label: "Open the risk register" } },
      { id: "adversarial", title: "Adversarial resilience", outcome: "Probes show attacks rarely succeed.", metric: { label: "Attacks resisted, worst case", value: "unmeasured" }, weight: 20, measured: false, score: 0, contribution: 0, inputs: [], formula: "Unmeasured scores 0.", link: { to: "/admin/redteam", label: "Open red-team runs" } },
      { id: "access", title: "Access hygiene", outcome: "An active owner.", metric: { label: "Owner", value: "active owner" }, weight: 15, measured: true, score: 100, contribution: 15, inputs: [], formula: "100 when owned.", link: { to: "/admin/inventory", label: "Open the agent inventory" } },
      { id: "evaluation", title: "Answer quality", outcome: "Grounded answers.", metric: { label: "Latest groundedness pass rate", value: "unmeasured" }, weight: 15, measured: false, score: 0, contribution: 0, inputs: [], formula: "No run scores 0.", link: { to: "/admin/evals", label: "Open evaluations" } },
    ],
    actions: [
      { key: "adversarial:probe", rank: 1, objective: "adversarial", title: `Run a red-team probe against ${name}`, points: 28.6, reason: "no measured attack-success rate exists for this agent", link: { to: "/admin/redteam", label: "Open red-team runs" } },
      { key: "evaluation:run", rank: 2, objective: "evaluation", title: `Run a groundedness evaluation against ${name}`, points: 21.4, reason: "answer quality is unmeasured in the window", link: { to: "/admin/evals", label: "Open evaluations" } },
    ],
  };
}

const useCaseScore = {
  estimate: true,
  asset: { kind: "use_case", id: UC, name: "Claims triage review" },
  score: 43,
  scale: { min: 0, max: 100 },
  method: "The weighted mean of the 2 objectives that apply to a use case.",
  disclaimer: DISCLAIMER,
  weights: [
    { objective: "risk", title: "Risk treatment", weight: 20, sharePct: 57.1 },
    { objective: "access", title: "Access hygiene", weight: 15, sharePct: 42.9 },
  ],
  notApplicable: [{ objective: "evaluation", title: "Answer quality", why: "evaluations run against agents; see the scores of the agents this use case names" }],
  objectives: [
    { id: "risk", title: "Risk treatment", outcome: "Every risk has a treatment.", metric: { label: "Registered risks with a treatment", value: "unmeasured" }, weight: 20, measured: false, score: 0, contribution: 0, inputs: [], formula: "None registered scores 0.", link: { to: `/admin/governance/use-cases/${UC}`, label: "Open the use case" } },
    { id: "access", title: "Access hygiene", outcome: "An active owner.", metric: { label: "Owner", value: "active owner" }, weight: 15, measured: true, score: 100, contribution: 42.9, inputs: [], formula: "100 when owned.", link: { to: `/admin/governance/use-cases/${UC}`, label: "Open the use case" } },
  ],
  actions: [{ key: "risk:register", rank: 1, objective: "risk", title: "Register the AI risks this use case carries", points: 57.1, reason: "no risk names this use case, so treatment is unmeasured", link: { to: `/admin/governance/use-cases/${UC}`, label: "Open the use case" } }],
};

const AGENTS = [agentScore(A1, "Claims triage", 31), agentScore(A2, "Intake summariser", 52), agentScore(A3, "Policy lookup", 76)];

const posture = {
  generatedAt: "2026-11-14T09:00:00.000Z",
  window: { days: 30 },
  packs: { active: [], note: "No pack active." },
  risks: { open: 0, mitigating: 0, accepted: 0, closed: 0, total: 0, attestationOnly: 0 },
  redteam: { measured: false, runsInWindow: 0, latest: null, trend: [], note: "No red-team run" },
  evals: { runsInWindow: 0, groundedness: { runsInWindow: 0, latest: null } },
  spend: { period: { label: "this month" }, totalCostUsd: 0, events: 0, unattributedCostUsd: 0, budgets: [], overBudgetProjects: 0, dailyTrend: [], estimate: true, disclaimer: "List-price estimate." },
  governance: { denials: 0, piiBlocks: 0, approvalsPending: 0, approvalsDecidedInWindow: 0 },
  auditChain: { anchors: 0, latestAnchorAt: null, sink: null, disclosure: "Not anchored." },
  agentOwnership: { total: 3, owned: 3, unowned: 0, orphaned: 0, lifecycle: { active: 3, deprecated: 0, retired: 0 }, note: "Owners." },
  certificationCampaigns: { total: 0, open: 0, completed: 0, expiredIncomplete: 0, note: "None." },
  sod: { rules: 0, enabled: 0, currentViolations: 0, note: "None." },
  accessRecommendations: { rulesVersion: 1, windowDays: 90, byRule: [], totalFindings: 0, totalNotAssessable: 0, note: "None." },
  useCases: { proposed: 0, underReview: 1, approved: 0, rejected: 0, retired: 0, total: 1 },
  note: "Computed at request time.",
};

const overview = {
  useCase: { id: UC, name: "Claims triage review", description: "Routes claims.", businessContext: "Faster triage.", status: "under_review", euAiActTier: "limited", ownerName: "Ada Admin", complianceTags: [], workflowInstanceId: null },
  screening: { tier: "limited", reasons: [], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: "2026-11-02T12:00:00Z" },
  stack: { agents: [], vendors: [] },
  risks: [],
  summary: { risks: 0, liveRisks: 0, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: 0 },
  approvals: [],
  audit: [],
  auditTotal: 0,
};

interface Opts {
  /** answer the agent list with a 500 this many times first */
  failList?: number;
  /** hold the first list response until the returned release() is called */
  holdList?: boolean;
  /** answer every detail read with this status */
  detailStatus?: 403 | 404;
}

async function mockApi(page: Page, opts: Opts = {}) {
  const calls: string[] = [];
  let failList = opts.failList ?? 0;
  let release: () => void = () => {};
  const held = opts.holdList ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    calls.push(`${req.method()} ${p}${url.search}`);
    const user = { id: "ada", email: "ada@example.test", displayName: "Ada Admin" };
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user });
    if (p === "/v1/reports/posture") return json(route, posture);
    if (p === "/v1/reports/posture/assets") {
      const kind = url.searchParams.get("kind");
      const limit = Number(url.searchParams.get("limit") ?? 25);
      if (kind !== "agent" && kind !== "use_case") return json(route, { error: "invalid_query" }, 400);
      if (!(limit >= 1 && limit <= 100)) return json(route, { error: "invalid_query" }, 400);
      if (kind === "use_case") return json(route, { kind, objectives: ["risk", "access"], items: [], nextCursor: null, limit, disclaimer: DISCLAIMER });
      await held;
      if (failList > 0) {
        failList--;
        return json(route, { error: "internal" }, 500);
      }
      // two to a page here, so the keyset Load more is exercised with three agents
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? AGENTS.findIndex((a) => a.asset.id === cursor) + 1 : 0;
      const page2 = AGENTS.slice(start, start + 2);
      const next = start + 2 < AGENTS.length ? page2[page2.length - 1]!.asset.id : null;
      return json(route, { kind, objectives: ["risk", "adversarial", "access", "evaluation"], items: page2, nextCursor: next, limit, disclaimer: DISCLAIMER });
    }
    const d = p.match(/^\/v1\/reports\/posture\/assets\/(agent|use_case)\/([^/]+)$/);
    if (d) {
      if (opts.detailStatus === 403) return json(route, { error: "no_user_identity" }, 403);
      if (opts.detailStatus === 404 || d[2] === GONE) return json(route, { error: "not_found" }, 404);
      const doc = d[1] === "use_case" ? (d[2] === UC ? useCaseScore : null) : AGENTS.find((a) => a.asset.id === d[2]);
      return doc ? json(route, doc) : json(route, { error: "not_found" }, 404);
    }
    if (p === "/v1/use-cases") return json(route, { useCases: [] });
    if (p === `/v1/use-cases/${UC}/overview`) return json(route, overview);
    if (p === `/v1/use-cases/${UC}`) return json(route, { useCase: { id: UC, status: "under_review" }, conditions: [], reviews: [], risks: [], discovery: null });
    if (p === "/v1/users/directory") return json(route, { users: [] });
    return json(route, {});
  });
  return { calls, release: () => release() };
}

const section = (page: Page) => page.getByRole("region", { name: "Scores by asset" });

test.describe("per-asset posture scores", () => {
  test("the Posture page lists agents in pages, toggles to use cases, and opens a score in a drawer", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto("/ui/admin/posture");
    const s = section(page);
    await expect(s.getByText(DISCLAIMER)).toBeVisible();
    await expect(s.getByRole("link", { name: "Open the posture score of Claims triage" })).toContainText("31 of 100");
    await expect(s.getByRole("link", { name: "Open the posture score of Intake summariser" })).toBeVisible();
    await expect(s.getByRole("link", { name: "Open the posture score of Policy lookup" })).toHaveCount(0);
    expect(calls).toContain("GET /v1/reports/posture/assets?kind=agent&limit=100");

    // keyset: the next page is asked for with the cursor the last page returned, and appended
    await s.getByRole("button", { name: "Load more" }).click();
    await expect(s.getByRole("link", { name: "Open the posture score of Policy lookup" })).toContainText("76 of 100");
    expect(calls).toContain(`GET /v1/reports/posture/assets?kind=agent&limit=100&cursor=${A2}`);
    await expect(s.getByRole("button", { name: "Load more" })).toHaveCount(0);

    // a row opens the asset's score, read from the detail route
    await s.getByRole("link", { name: "Open the posture score of Claims triage" }).click();
    const drawer = page.getByRole("dialog", { name: "Claims triage" });
    await expect(drawer.getByText("Estimate", { exact: true })).toBeVisible();
    await expect(drawer.getByText(DISCLAIMER)).toBeVisible();
    expect(calls).toContain(`GET /v1/reports/posture/assets/agent/${A1}`);
    // unmeasured says so and never shows its zero
    const adv = drawer.getByRole("row").filter({ hasText: "Adversarial resilience" });
    await expect(adv).toContainText("Unmeasured");
    await expect(adv).toContainText("28.6%");
    await expect(adv).not.toContainText("0 of 100");
    await expect(drawer.getByRole("row").filter({ hasText: "Access hygiene" })).toContainText("100 of 100");
    // not applicable: its reason, and no score
    await expect(drawer.getByText("Spend control: not applicable, budgets are set on projects, not on agents.")).toBeVisible();
    // ranked actions, each with its points and an in-app link
    const actions = drawer.getByRole("listitem").filter({ hasText: /^Run a / });
    await expect(actions.first()).toContainText("Run a red-team probe against Claims triage");
    await expect(actions.first()).toContainText("+28.6 points");
    await expect(drawer.getByRole("link", { name: "Open red-team runs" })).toHaveAttribute("href", "/ui/admin/redteam");
    await expect(page.locator("body")).not.toContainText(/\bcompliant\b|\bcertified\b/i);
    await expectAxeClean(page, "Posture: per-asset scores, drawer open");

    await drawer.getByRole("button", { name: /close/i }).click();
    await expect(drawer).toHaveCount(0);

    // the use-case toggle reads its own kind; none readable is an empty state, not a zero
    await s.getByRole("tab", { name: "Use cases" }).click();
    await expect(s.getByText("No use case you can read")).toBeVisible();
    expect(calls).toContain("GET /v1/reports/posture/assets?kind=use_case&limit=100");
    await expectAxeClean(page, "Posture: per-asset scores, empty use cases");
  });

  test("loading then data: the list announces it is loading until the page arrives", async ({ page }) => {
    const gw = await mockApi(page, { holdList: true });
    await page.goto("/ui/admin/posture");
    const panel = section(page).getByRole("tabpanel");
    await expect(panel.locator("table[aria-busy=true]")).toBeVisible();
    await expect(panel.getByRole("link", { name: /Open the posture score/ })).toHaveCount(0);
    gw.release();
    await expect(panel.getByRole("link", { name: "Open the posture score of Claims triage" })).toBeVisible();
  });

  test("a failed read is an error with Retry, never an empty list", async ({ page }) => {
    await mockApi(page, { failList: 1 });
    await page.goto("/ui/admin/posture");
    const s = section(page);
    await expect(s.getByRole("alert")).toBeVisible();
    await expect(s.getByText("No agent you can read")).toHaveCount(0);
    await expectAxeClean(page, "Posture: per-asset scores, failed read");
    await s.getByRole("button", { name: "Retry" }).click();
    await expect(s.getByRole("link", { name: "Open the posture score of Claims triage" })).toBeVisible();
  });

  test("a score the caller cannot read is 'No such asset'; a credential with no user gets the access message", async ({ page }) => {
    await mockApi(page, { detailStatus: 404 });
    await page.goto("/ui/admin/posture");
    await section(page).getByRole("link", { name: "Open the posture score of Claims triage" }).click();
    const drawer = page.getByRole("dialog", { name: "Claims triage" });
    await expect(drawer.getByText("No such asset")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Retry" })).toHaveCount(0);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApi(page, { detailStatus: 403 });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    const card = page.locator("[data-rg-card]").filter({ has: page.getByText("Posture score", { exact: true }) });
    await expect(card.getByText("You don't have access to this asset")).toBeVisible();
  });

  test("the use-case page carries the use case's score card", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    const card = page.locator("[data-rg-card]").filter({ has: page.getByText("Posture score", { exact: true }) });
    await expect(card.getByText("43", { exact: true })).toBeVisible();
    await expect(card.getByText("Estimate", { exact: true })).toBeVisible();
    await expect(card.getByText(DISCLAIMER)).toBeVisible();
    await expect(card.getByRole("row").filter({ hasText: "Risk treatment" })).toContainText("Unmeasured");
    await expect(card.getByText("Answer quality: not applicable, evaluations run against agents; see the scores of the agents this use case names.")).toBeVisible();
    await expect(card.getByRole("link", { name: "Open the use case" })).toHaveAttribute("href", `/ui/admin/governance/use-cases/${UC}`);
    expect(calls).toContain(`GET /v1/reports/posture/assets/use_case/${UC}`);
    await expectAxeClean(page, "Use case: posture score card");
  });
});
