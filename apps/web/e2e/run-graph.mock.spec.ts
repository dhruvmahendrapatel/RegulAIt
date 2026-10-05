/**
 * ADR-0173 batch 2b — the run graph from the browser's side, every /v1 and
 * /auth call answered by an in-test mock:
 *
 *  - builder thread: a "View graph" per turn (none before the person's first
 *    message); it opens the turn's graph in a drawer, read from
 *    GET /v1/run-graph/builder-turn/:threadId/:turn;
 *  - keyboard: each node is focusable and named by its step sentence, Enter
 *    opens its details (focus lands on them), "Close details" returns focus to
 *    the node; the ordered "Steps in order" list is the text alternative and
 *    opens the same details; a result withheld by policy reads as withheld;
 *  - the orchestration run page draws its task graph from
 *    GET /v1/run-graph/orchestration/:runId (an admin gets "Open trace"); a
 *    refused or malformed answer shows the reason and the page keeps working;
 *  - the use-case workspace has a "Decision path" tab;
 *  - axe (WCAG 2.x A/AA) over each screen in BOTH themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock } from "./builder-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const links = (over: Record<string, string | null> = {}) => ({ auditLogId: null, traceId: null, spanId: null, approvalId: null, ...over });
const AUDIT_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const TRACE_1 = "bbbbbbbb-0000-4000-8000-000000000001";
const SPAN_1 = "cccccccc-0000-4000-8000-000000000001";
const APPROVAL_1 = "dddddddd-0000-4000-8000-000000000001";

const turnGraph = {
  kind: "builder_turn",
  subject: { id: "th-0002", label: "Vendor risk assessor · turn 1" },
  generatedAt: "2026-10-05T10:00:00Z",
  nodes: [
    { id: "input", type: "input", label: "Person's message", status: "done", rawStatus: null, statusDetail: null, actor: { kind: "person", id: "u", name: "Avery Admin" }, at: "2026-10-05T09:00:00Z", endedAt: null, costUsd: null, links: links(), facts: [{ label: "Turn", value: "1" }] },
    { id: "model:1", type: "model_step", label: "Model step 1", status: "done", rawStatus: "ok", statusDetail: null, actor: { kind: "model", id: "m", name: "gpt-review" }, at: "2026-10-05T09:00:01Z", endedAt: "2026-10-05T09:00:03Z", costUsd: 0.0123, links: links({ auditLogId: AUDIT_1, traceId: TRACE_1, spanId: SPAN_1 }), facts: [{ label: "Tokens in", value: "812" }] },
    { id: "tool:1", type: "tool_call", label: "search_policies", status: "done", rawStatus: "done", statusDetail: null, actor: { kind: "person", id: "u", name: "Avery Admin" }, at: "2026-10-05T09:00:03Z", endedAt: null, costUsd: 0.002, links: links(), facts: [{ label: "Result", value: "withheld by policy" }] },
    { id: `approval:${APPROVAL_1}`, type: "approval", label: "Organisation approval", status: "waiting", rawStatus: "pending", statusDetail: null, actor: { kind: "person", id: "d", name: "Drew Reviewer" }, at: "2026-10-05T09:00:04Z", endedAt: null, costUsd: null, links: links({ approvalId: APPROVAL_1 }), facts: [] },
    { id: "tool:2", type: "tool_call", label: "update_policy", status: "waiting", rawStatus: "pending_approval", statusDetail: null, actor: { kind: "person", id: "u", name: "Avery Admin" }, at: "2026-10-05T09:00:04Z", endedAt: null, costUsd: null, links: links({ approvalId: APPROVAL_1 }), facts: [] },
  ],
  edges: [
    { from: "input", to: "model:1", kind: "next" },
    { from: "model:1", to: "tool:1", kind: "tool_call" },
    { from: "model:1", to: `approval:${APPROVAL_1}`, kind: "tool_call" },
    { from: `approval:${APPROVAL_1}`, to: "tool:2", kind: "then" },
  ],
  summary: { nodes: 5, costUsd: 0.0143, denied: 0, waiting: 2, errors: 0 },
  notes: ["Message text and tool arguments are not shown here; open the thread to read them."],
};

const RUN = "e1111111-1111-4111-8111-111111111111";
const runGraph = {
  kind: "orchestration",
  subject: { id: RUN, label: "checkout-refactor" },
  generatedAt: "2026-10-05T10:00:00Z",
  nodes: [
    { id: "run", type: "run", label: "Run created", status: "active", rawStatus: "running", statusDetail: null, actor: { kind: "person", id: "u", name: "Ada Admin" }, at: "2026-10-05T09:00:00Z", endedAt: null, costUsd: null, links: links(), facts: [] },
    { id: "task:plan", type: "task", label: "Plan the refactor", status: "done", rawStatus: "done", statusDetail: null, actor: { kind: "agent", id: "a", name: "planner" }, at: "2026-10-05T09:01:00Z", endedAt: "2026-10-05T09:02:00Z", costUsd: 0.04, links: links({ traceId: TRACE_1, spanId: SPAN_1 }), facts: [{ label: "Mode", value: "auto" }] },
    { id: "task:api", type: "task", label: "Change the API", status: "active", rawStatus: "in_progress", statusDetail: null, actor: { kind: "agent", id: "b", name: "coder" }, at: "2026-10-05T09:03:00Z", endedAt: null, costUsd: null, links: links(), facts: [] },
    { id: "task:ui", type: "task", label: "Change the UI", status: "error", rawStatus: "blocked", statusDetail: "the worker hit its node budget", actor: { kind: "agent", id: "c", name: "coder" }, at: "2026-10-05T09:03:00Z", endedAt: null, costUsd: 0.01, links: links(), facts: [] },
    { id: `approval:${APPROVAL_1}`, type: "approval", label: "Escalation approval", status: "waiting", rawStatus: "pending", statusDetail: null, actor: { kind: "person", id: "d", name: "Drew Reviewer" }, at: "2026-10-05T09:04:00Z", endedAt: null, costUsd: null, links: links({ approvalId: APPROVAL_1 }), facts: [] },
  ],
  edges: [
    { from: "run", to: "task:plan", kind: "starts" },
    { from: "task:plan", to: "task:api", kind: "depends_on" },
    { from: "task:plan", to: "task:ui", kind: "depends_on" },
    { from: "task:plan", to: "task:ui", kind: "leads" },
    { from: "task:ui", to: `approval:${APPROVAL_1}`, kind: "escalated" },
  ],
  summary: { nodes: 5, costUsd: 0.05, denied: 0, waiting: 1, errors: 1 },
  notes: ["Edges follow each task's dependencies; a dashed edge is a lead delegating to a worker."],
};
const runDetail = {
  run: {
    id: RUN,
    name: "checkout-refactor",
    status: "running",
    createdAt: "2026-10-05T09:00:00Z",
    initiatingUserId: "ada",
    graph: {
      nodes: [
        { id: "plan", title: "Plan the refactor", instruction: "Plan it", ownerAgentId: "a", dependsOn: [] },
        { id: "api", title: "Change the API", instruction: "Do it", ownerAgentId: "b", dependsOn: ["plan"] },
        { id: "ui", title: "Change the UI", instruction: "Do it", ownerAgentId: "c", dependsOn: ["plan"] },
      ],
    },
    state: { nodeStatuses: { plan: "done", api: "in_progress", ui: "blocked" }, owners: {} },
  },
  events: [],
  pendingApprovals: [],
};

const UC = "c1111111-1111-4111-8111-111111111111";
const useCaseOverview = {
  useCase: { id: UC, name: "Claims triage assistant", description: "Sorts claims.", businessContext: "", status: "approved", euAiActTier: "limited", ownerName: "Dana Developer", complianceTags: [], projectId: null },
  screening: { tier: "limited", reasons: [], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: "2026-10-02T12:00:00Z" },
  risks: [],
  summary: { risks: 0, liveRisks: 0, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: 0 },
  stack: { agents: [], vendors: [] },
  approvals: [],
  audit: [],
};
const useCaseGraph = {
  kind: "use_case",
  subject: { id: UC, label: "Claims triage assistant" },
  generatedAt: "2026-10-05T10:00:00Z",
  nodes: [
    { id: "registered", type: "intake", label: "Registered", status: "done", rawStatus: null, statusDetail: null, actor: { kind: "person", id: "o", name: "Dana Developer" }, at: "2026-10-01T09:00:00Z", endedAt: null, costUsd: null, links: links({ auditLogId: AUDIT_1 }), facts: [] },
    { id: "screening", type: "screening", label: "EU AI Act screening: limited", status: "done", rawStatus: null, statusDetail: null, actor: { kind: "system", id: null, name: null }, at: "2026-10-01T09:05:00Z", endedAt: null, costUsd: null, links: links(), facts: [{ label: "Rule set", value: "v1" }] },
    { id: "decision", type: "decision", label: "Decision: approved", status: "done", rawStatus: "approved", statusDetail: null, actor: { kind: "person", id: "d", name: "Drew Reviewer" }, at: "2026-10-02T12:00:00Z", endedAt: null, costUsd: null, links: links(), facts: [] },
    { id: "expiry", type: "expiry", label: "Approval valid", status: "done", rawStatus: null, statusDetail: null, actor: null, at: "2026-10-02T12:00:00Z", endedAt: null, costUsd: null, links: links(), facts: [{ label: "Valid until", value: "2027-10-02T12:00:00.000Z" }] },
  ],
  edges: [
    { from: "registered", to: "screening", kind: "next" },
    { from: "screening", to: "decision", kind: "next" },
    { from: "decision", to: "expiry", kind: "next" },
  ],
  summary: { nodes: 4, costUsd: null, denied: 0, waiting: 0, errors: 0 },
  notes: [],
};

/** an admin console session, the run and use-case reads, and whatever `graph` answers for the run graph */
async function mockConsole(page: Page, opts: { runGraph?: (route: Route) => Promise<void> } = {}) {
  const calls: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    calls.push(p);
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === `/v1/runs/${RUN}`) return json(route, runDetail);
    if (p === "/v1/users/ada/agents") return json(route, { agents: [], defaultAgentId: null });
    if (p === "/v1/pm/links") return json(route, { links: [] });
    if (p === "/v1/decisions") return json(route, { decisions: [] });
    if (p === `/v1/run-graph/orchestration/${RUN}`) return opts.runGraph ? opts.runGraph(route) : json(route, runGraph);
    if (p === `/v1/use-cases/${UC}/overview`) return json(route, useCaseOverview);
    if (p === `/v1/run-graph/use-case/${UC}`) return json(route, useCaseGraph);
    return json(route, {});
  });
  return calls;
}

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    // finite transitions only, and capped: an infinite animation, or one on an
    // element that is not rendered, never finishes
    const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
    const settled = Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1] ?? ""}`).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

test.describe("ADR-0173 2b: the run graph", () => {
  test("builder thread: View graph per turn opens the turn's graph; keyboard opens details; the list is the text alternative", async ({ page }) => {
    await installBuilderMock(page);
    const graphCalls: string[] = [];
    // registered after the builder mock, so it answers first
    await page.route("**/v1/run-graph/**", async (route) => {
      const p = new URL(route.request().url()).pathname;
      graphCalls.push(p);
      if (p === "/v1/run-graph/builder-turn/th-0002/1") return json(route, turnGraph);
      return json(route, { error: "unknown_turn" }, 404);
    });

    // a scheduled thread has no message from the person: no turn, no graph
    await page.goto("/ui/builder?thread=th-0001");
    await expect(page.getByText("Three new requests.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /View graph/ })).toHaveCount(0);

    await page.goto("/ui/builder?thread=th-0002");
    await expect(page.getByText("All four vendors scored.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /View graph/ })).toHaveCount(1);
    expect(graphCalls).toEqual([]); // nothing is read until it is asked for
    await page.getByRole("button", { name: "View graph of turn 1" }).click();

    const drawer = page.getByRole("dialog", { name: "Turn 1: decision path" });
    await expect(drawer).toBeVisible();
    const canvas = drawer.getByRole("application", { name: "Graph of turn 1" });
    await expect(canvas).toBeVisible();
    expect(graphCalls).toEqual(["/v1/run-graph/builder-turn/th-0002/1"]);
    await expect(drawer.getByRole("status")).toContainText("5 steps · measured cost $0.0143 · 2 waiting");

    // every node is a focusable element named by its step sentence, in decision-path order
    const nodes = canvas.locator(".react-flow__node");
    await expect(nodes).toHaveCount(5);
    await expect(nodes.nth(1)).toHaveAttribute("aria-label", /^Step 2 of 5: Model step 1\. Done\. Model: gpt-review\. .*Cost \$0\.0123\.$/);
    await expect(nodes.nth(1)).toHaveAttribute("tabindex", "0");

    // Enter on a focused node opens its details, and focus lands on them
    await nodes.nth(1).focus();
    await page.keyboard.press("Enter");
    const details = drawer.getByRole("region", { name: "Model step 1" });
    await expect(details).toBeVisible();
    await expect(details.getByRole("heading", { name: "Model step 1" })).toBeFocused();
    await expect(details).toContainText("Tokens in");
    await expect(details).toContainText("Comes after");
    await expect(details.getByRole("link", { name: "Open trace" })).toHaveAttribute("href", `/ui/admin/traces?trace=${TRACE_1}`);
    await expectAxeClean(page, "builder turn graph with details");
    // closing returns focus to the node it came from
    await details.getByRole("button", { name: "Close details" }).click();
    await expect(details).toHaveCount(0);
    await expect(nodes.nth(1)).toBeFocused();

    // the ordered list says the same, and opens the same details
    const list = drawer.getByRole("list", { name: "Steps in order" });
    await expect(list.getByRole("listitem")).toHaveCount(5);
    await expect(list.getByRole("listitem").nth(4)).toContainText("update_policy");
    await expect(list.getByRole("listitem").nth(4)).toContainText("Waiting");
    await list.getByRole("button", { name: "search_policies" }).click();
    const tool = drawer.getByRole("region", { name: "search_policies" });
    await expect(tool.getByRole("heading", { name: "search_policies" })).toBeFocused();
    await expect(tool).toContainText("withheld by policy");
    await page.keyboard.press("Escape"); // the drawer closes; nothing else is left open
    await expect(drawer).toHaveCount(0);
  });

  test("run page: the task graph is the run graph; an admin can open a step's trace", async ({ page }) => {
    const calls = await mockConsole(page);
    await page.goto(`/ui/runs/${RUN}`);
    await expect(page.getByRole("heading", { level: 1, name: "checkout-refactor" })).toBeVisible();
    const canvas = page.getByRole("application", { name: "Run task graph" });
    await expect(canvas).toBeVisible();
    expect(calls).toContain(`/v1/run-graph/orchestration/${RUN}`);
    await expect(canvas.locator(".react-flow__node")).toHaveCount(5);
    // a dashed edge is a lead delegating to a worker; the duplicate pair is drawn once per kind
    await expect(canvas.locator(".react-flow__edge")).toHaveCount(5);
    // left to right: a dependency sits right of what it depends on
    const plan = (await canvas.locator('.react-flow__node[data-id="task:plan"]').boundingBox())!;
    const api = (await canvas.locator('.react-flow__node[data-id="task:api"]').boundingBox())!;
    expect(api.x).toBeGreaterThan(plan.x + plan.width - 1);

    const list = page.getByRole("list", { name: "Steps in order" });
    await expect(list.getByRole("listitem").nth(3)).toContainText("the worker hit its node budget");
    await canvas.locator('.react-flow__node[data-id="task:plan"]').click();
    const details = page.getByRole("region", { name: "Plan the refactor" });
    await expect(details.getByRole("link", { name: "Open trace" })).toHaveAttribute("href", `/ui/admin/traces?trace=${TRACE_1}`);
    await expect(details).toContainText("$0.04");
    await expectAxeClean(page, "run page graph");
  });

  test("run page: a refused or malformed graph says so, and the rest of the page works", async ({ page }) => {
    await mockConsole(page, { runGraph: (route) => json(route, { error: "unknown_run" }, 404) });
    await page.goto(`/ui/runs/${RUN}`);
    await expect(page.getByRole("heading", { level: 1, name: "checkout-refactor" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't load the graph" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abort run" })).toBeVisible();

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockConsole(page, { runGraph: (route) => json(route, {}) });
    await page.reload();
    await expect(page.getByRole("alert").filter({ hasText: "The server did not return a graph." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abort run" })).toBeVisible();
  });

  test("use-case workspace: the Decision path tab", async ({ page }) => {
    const calls = await mockConsole(page);
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    await expect(page.getByRole("heading", { level: 1, name: "Claims triage assistant" })).toBeVisible();
    expect(calls).not.toContain(`/v1/run-graph/use-case/${UC}`);
    await page.getByRole("tab", { name: "Decision path" }).click();
    const canvas = page.getByRole("application", { name: "Decision path of Claims triage assistant" });
    await expect(canvas).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "4 steps · no measured cost" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Steps in order" }).getByRole("listitem").nth(1)).toContainText("System");
    await expectAxeClean(page, "use-case decision path");
  });
});
