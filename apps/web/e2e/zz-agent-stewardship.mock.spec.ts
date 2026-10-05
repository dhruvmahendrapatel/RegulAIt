/**
 * Agent stewardship (ADR-0168 item 6) from the browser's side, every /v1 and
 * /auth call answered by an in-test mock (the registry-registration harness):
 *
 *  - the agent inventory's Stewardship card: steward, successor, status, next
 *    review, the Orphaned / Review overdue flags and the filter chips;
 *  - the edit drawer: one audited save of only what changed, the two refusals a
 *    person can see coming (successor = steward is not offered; a non-active
 *    status needs a reason), the gateway's own refusal surfaced, "Record
 *    review", Escape returning focus to the row's Manage button;
 *  - the use-case record's Stack tab: each agent's steward and an Orphaned flag;
 *  - axe (WCAG 2.x A/AA) over each screen in BOTH themes.
 *
 * Set AGENT_SHOTS_DIR to also save light + dark screenshots.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SHOTS = process.env.AGENT_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const OPUS = "a1111111-1111-4111-8111-111111111111";
const GROK = "a2222222-2222-4222-8222-222222222222";
const GPT = "a3333333-3333-4333-8333-333333333333";
const UC = "c1111111-1111-4111-8111-111111111111";

const users = [
  { id: "ada", email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null },
  { id: "dana", email: "dana@example.test", displayName: "Dana Developer", isAdmin: false, disabledAt: null },
  { id: "avery", email: "avery@example.test", displayName: "Avery Approver", isAdmin: false, disabledAt: null },
  { id: "lee", email: "lee@example.test", displayName: "Lee Leaver", isAdmin: false, disabledAt: "2026-09-01T00:00:00Z" },
];
const base = { provider: "mock", tier: 1, model: "mock-balanced", enabled: true, costPerMTokIn: 1, costPerMTokOut: 2, systemPrompt: null, lifecycleReason: null, lastReviewedAt: null, lastReviewedByName: null, stewardDeactivated: false, successorDeactivated: false, highestUseCaseTier: null, reviewCadenceMonths: 12 };
const agents = [
  { ...base, id: OPUS, name: "claude-opus", ownerUserId: "dana", stewardUserId: "dana", stewardName: "Dana Developer", successorUserId: "ada", successorName: "Ada Admin", lifecycleStatus: "active", nextReviewAt: "2027-04-03T12:00:00.000Z", lastReviewedAt: "2026-10-03T09:00:00.000Z", lastReviewedByName: "Ada Admin", orphaned: false, reviewOverdue: false, highestUseCaseTier: "high", reviewCadenceMonths: 6 },
  { ...base, id: GROK, name: "grok", ownerUserId: null, stewardUserId: null, stewardName: null, successorUserId: "dana", successorName: "Dana Developer", lifecycleStatus: "active", nextReviewAt: "2027-01-13T12:00:00.000Z", orphaned: true, reviewOverdue: false, highestUseCaseTier: "limited" },
  { ...base, id: GPT, name: "gpt-5", ownerUserId: "avery", stewardUserId: "avery", stewardName: "Avery Approver", successorUserId: "ada", successorName: "Ada Admin", lifecycleStatus: "under_review", lifecycleReason: "Quarterly access check", nextReviewAt: "2026-09-20T12:00:00.000Z", orphaned: false, reviewOverdue: true },
];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page: Page, opts: { patchStatus?: number } = {}) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/agents") return json(route, { agents });
    if (p === "/v1/users") return json(route, { users });
    if (p === "/v1/custom-providers") return json(route, { providers: [] });
    const m = /^\/v1\/agents\/([^/]+)\/stewardship(\/review)?$/.exec(p);
    if (m) {
      sent.push({ method, path: p, body: route.request().postDataJSON() });
      if (opts.patchStatus && method === "PATCH") return json(route, { error: "not_agent_steward", detail: "only an admin or this agent's current steward can change its stewardship or record a review" }, opts.patchStatus);
      return json(route, agents.find((a) => a.id === m[1]) ?? {});
    }
    if (p === `/v1/use-cases/${UC}/overview`) return json(route, overview);
    if (p === `/v1/agents/${GROK}/card`) return json(route, grokCard);
    if (p === "/v1/users/directory") return json(route, { users: [] });
    return json(route, {});
  });
  return { sent };
}

const overview = {
  useCase: { id: UC, name: "Financial forecasting assistant", description: "Drafts quarterly forecasts for analyst review.", businessContext: "", status: "approved", euAiActTier: "limited", ownerName: "Dana Developer", complianceTags: [] },
  screening: { tier: "limited", reasons: [], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: "2026-10-02T12:00:00Z" },
  risks: [],
  summary: { risks: 0, liveRisks: 0, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: 0 },
  stack: { agents: [{ id: GROK, name: "grok", provider: "xai", model: "grok-4", lifecycleStatus: "active", halted: false, modelCards: [], modelCardApproved: false }], vendors: [] },
  approvals: [],
  audit: [],
};
const grokCard = {
  agent: { id: GROK, name: "grok", provider: "xai", model: "grok-4", tier: "1", modes: ["chat"], enabled: true, lifecycleStatus: "active", halted: false, haltedReason: null, hasSystemPrompt: false },
  owner: { id: null, name: null, state: "unowned" },
  stewardship: { stewardUserId: null, stewardName: null, stewardDeactivated: false, successorUserId: "dana", successorName: "Dana Developer", successorDeactivated: false, orphaned: true, reviewOverdue: false, nextReviewAt: "2027-01-13T12:00:00.000Z", lastReviewedAt: null, lastReviewedByName: null, reviewCadenceMonths: 12, highestUseCaseTier: "limited" },
  purpose: { intendedUses: ["Forecast drafting"], limitations: [], source: "model_cards" },
  dataSources: { declared: [], note: "" },
  guardrails: { modes: {}, blocksInput: false, blocksOutput: false, provenance: [] },
  oversight: { modelCards: 0, modelCardApproved: false, note: "" },
};

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
}

async function checkScreen(page: Page, label: string, shot?: string, fullPage = true) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on "${label}" (${theme})`).toEqual([]);
    if (SHOTS && shot) await page.screenshot({ path: path.join(SHOTS, `${shot}-${theme}.png`), fullPage });
  }
  await setTheme(page, "light");
}

test.describe("ADR-0168 item 6: agent stewardship", () => {
  test("the inventory shows steward, successor, status, next review and the flags, with filter chips", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/agents");
    const card = page.locator("section").filter({ has: page.getByText("Stewardship", { exact: true }) }).first();
    const table = card.getByRole("table");
    await expect(table.locator("thead th")).toHaveText(["Agent", "Steward", "Successor", "Status", "Next review", "Flags", ""]);
    const grok = table.getByRole("row", { name: /^grok/ });
    await expect(grok).toContainText("No steward");
    await expect(grok).toContainText("Dana Developer");
    await expect(grok.getByText("Orphaned", { exact: true })).toBeVisible();
    const gpt = table.getByRole("row", { name: /^gpt-5/ });
    await expect(gpt).toContainText("Under review");
    await expect(gpt).toContainText("Overdue since 20 Sept 2026");
    await expect(gpt.getByText("Review overdue", { exact: true })).toBeVisible();
    const opus = table.getByRole("row", { name: /^claude-opus/ });
    await expect(opus).toContainText("Riskiest use case: high");
    await expect(opus).toContainText("3 Apr 2027");
    await expect(opus.getByText(/Orphaned|Review overdue/)).toHaveCount(0);

    const chips = card.getByRole("group", { name: "Stewardship filter" });
    await expect(chips.getByRole("button")).toHaveText(["All 3", "Orphaned 1", "Review overdue 1"]);
    await checkScreen(page, "Agent inventory", "inventory");

    await chips.getByRole("button", { name: /^Orphaned/ }).click();
    await expect(chips.getByRole("button", { name: /^Orphaned/ })).toHaveAttribute("aria-pressed", "true");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.getByRole("row", { name: /^grok/ })).toBeVisible();
    await chips.getByRole("button", { name: /^Review overdue/ }).click();
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.getByRole("row", { name: /^gpt-5/ })).toBeVisible();
    await chips.getByRole("button", { name: /^All/ }).click();
    await expect(table.locator("tbody tr")).toHaveCount(3);
  });

  test("the drawer saves only what changed, explains refusals, records a review and returns focus", async ({ page }) => {
    const { sent } = await mockApi(page);
    await page.goto("/ui/admin/agents");
    const manage = page.getByRole("button", { name: "Manage stewardship of grok" });
    await manage.click();
    const drawer = page.getByRole("dialog", { name: "grok" });
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "grok" })).toBeFocused();
    await expect(drawer.getByRole("note")).toContainText("No steward is named. Dana Developer is the named successor.");
    await expect(drawer).toContainText("Never recorded");
    await expect(drawer).toContainText("Reviewed every 12 months. Its highest-risk use case is limited risk.");
    // nothing changed yet: nothing to save
    await expect(drawer.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // a deactivated person is not offered; the steward is never offered as successor
    const steward = drawer.getByLabel("Steward", { exact: true });
    await expect(steward.locator("option", { hasText: "Lee Leaver" })).toHaveCount(0);
    await steward.selectOption({ label: "Avery Approver" });
    await expect(drawer.getByLabel("Successor", { exact: true }).locator("option", { hasText: "Avery Approver" })).toHaveCount(0);
    // a non-active status needs a reason — said before the request, not instead of it
    await drawer.getByLabel("Status", { exact: true }).selectOption("suspended");
    await expect(drawer.getByText("Out of service: every call is refused until it returns to active.")).toBeVisible();
    await drawer.getByRole("button", { name: "Save changes" }).click();
    await expect(drawer.getByRole("alert")).toHaveText("Give a reason for moving this agent to suspended.");
    expect(sent).toHaveLength(0);
    await drawer.getByLabel("Reason for this status").fill("Incident under investigation");
    await checkScreen(page, "Stewardship drawer", "drawer", false);
    await drawer.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({
      method: "PATCH",
      path: `/v1/agents/${GROK}/stewardship`,
      body: { stewardUserId: "avery", lifecycleStatus: "suspended", lifecycleReason: "Incident under investigation" },
    });

    await drawer.getByRole("button", { name: "Record review" }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ method: "POST", path: `/v1/agents/${GROK}/stewardship/review` });

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(manage).toBeFocused();
  });

  test("a refusal from the gateway is shown in its own words", async ({ page }) => {
    await mockApi(page, { patchStatus: 403 });
    await page.goto("/ui/admin/agents");
    await page.getByRole("button", { name: "Manage stewardship of gpt-5" }).click();
    const drawer = page.getByRole("dialog", { name: "gpt-5" });
    await drawer.getByLabel("Successor", { exact: true }).selectOption({ label: "Dana Developer" });
    await drawer.getByRole("button", { name: "Save changes" }).click();
    await expect(drawer.getByRole("alert")).toContainText("only an admin or this agent's current steward");
  });

  test("the use-case record's Stack tab shows each agent's steward and flags an orphaned one", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/ui/admin/governance/use-cases/${UC}?tab=stack`);
    await expect(page.getByText("Declared purpose")).toBeVisible();
    const line = page.getByText(/^Steward: none · Successor: Dana Developer$/);
    await expect(line).toBeVisible();
    await expect(page.locator(`#agent-${GROK}`).getByText("Orphaned", { exact: true })).toBeVisible();
    await checkScreen(page, "Use case Stack tab", "use-case-stack");
  });
});
