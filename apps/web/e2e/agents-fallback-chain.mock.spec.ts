/**
 * ADR-0179 — two Agents-page usability items, from the browser's side, every
 * /v1 and /auth call answered by an in-test mock:
 *
 *  - UX-AG-1: the fallback chain is a DRAFT. Add, reorder and remove change
 *    nothing on the server; "Unsaved changes" says so; the primary-agent picker
 *    is locked while the draft differs; "Cancel" restores the saved chain with
 *    no request sent; "Save chain" sends exactly ONE PUT with the ordered ids;
 *    a refused save keeps the draft and shows the gateway's reason.
 *  - UX-AG-5: a role-granted agent's unavailable Remove explains itself with a
 *    link to the Roles page, and the link goes there.
 *  - axe (WCAG 2.x A/AA) over each state in BOTH themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const OPUS = "a1111111-1111-4111-8111-111111111111";
const GROK = "a2222222-2222-4222-8222-222222222222";
const GPT = "a3333333-3333-4333-8333-333333333333";

const users = [
  { id: "ada", email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null },
  { id: "dana", email: "dana@example.test", displayName: "Dana Developer", isAdmin: false, disabledAt: null },
];
const base = { provider: "mock", tier: 1, model: "mock-balanced", enabled: true, costPerMTokIn: 1, costPerMTokOut: 2, systemPrompt: null, lifecycleReason: null, lastReviewedAt: null, lastReviewedByName: null, stewardDeactivated: false, successorDeactivated: false, highestUseCaseTier: null, reviewCadenceMonths: 12, ownerUserId: "ada", stewardUserId: "ada", stewardName: "Ada Admin", successorUserId: null, successorName: null, lifecycleStatus: "active", nextReviewAt: "2027-04-03T12:00:00.000Z", orphaned: false, reviewOverdue: false };
const agents = [
  { ...base, id: OPUS, name: "claude-opus" },
  { ...base, id: GROK, name: "grok" },
  { ...base, id: GPT, name: "gpt-5" },
];
const rung = (id: string, position: number) => {
  const agent = agents.find((x) => x.id === id)!;
  return { position, agentId: id, name: agent.name, provider: agent.provider, model: agent.model, enabled: true };
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page: Page, opts: { putStatus?: number } = {}) {
  const puts: unknown[] = [];
  let chain = [GROK];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/agents") return json(route, { agents });
    if (p === "/v1/users") return json(route, { users });
    if (p === "/v1/custom-model-providers") return json(route, { providers: [] });
    if (p === `/v1/agents/${OPUS}/fallbacks`) {
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { fallbackAgentIds: string[] };
        puts.push(body);
        if (opts.putStatus) return json(route, { error: "duplicate_fallback", detail: "each fallback target may appear once" }, opts.putStatus);
        chain = body.fallbackAgentIds;
        return json(route, { fallbacks: chain.map(rung) });
      }
      return json(route, { fallbacks: chain.map(rung) });
    }
    if (p === "/v1/users/dana/agents") {
      return json(route, {
        agents: [
          { agentId: GROK, name: "grok", provider: "mock", tier: 1, source: "role", roles: ["engineering"] },
          { agentId: GPT, name: "gpt-5", provider: "mock", tier: 1, source: "direct", grantId: "g-1" },
        ],
        defaultAgentId: null,
        ceilingAgentId: null,
        routingMode: null,
        runBudgetUsd: null,
        runBudgetBreachAction: null,
      });
    }
    return json(route, {});
  });
  return { puts };
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    // finite animations only, and never more than 1 s
    await Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }, theme);
}

async function checkScreen(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

const chainCard = (page: Page) =>
  page.locator("section").filter({ has: page.getByText(/^Fallback chain \(ADR-0066\)/) }).first();

const order = (page: Page) => chainCard(page).locator("ol li strong");

test.describe("ADR-0179 UX-AG-1: the fallback chain is saved explicitly", () => {
  test("add, reorder and cancel send nothing; Save chain sends one PUT with the ordered ids", async ({ page }) => {
    const { puts } = await mockApi(page);
    await page.goto("/ui/admin/agents");
    const card = chainCard(page);
    const primary = card.getByLabel("Primary agent");
    await primary.selectOption(OPUS);
    await expect(order(page)).toHaveText(["grok"]);

    // stage an add: it shows in the list and NOTHING is written (before
    // ADR-0179 this click was itself a PUT)
    await card.getByLabel("Add a fallback (tried in order, after the ones above)").selectOption(GPT);
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await expect(order(page)).toHaveText(["grok", "gpt-5"]);
    expect(puts, "an add must not write").toEqual([]);
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(order(page)).toHaveText(["grok"]);
    await expect(card.getByText("Saved — this is the chain in force.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Save chain" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Cancel" })).toBeDisabled();

    // stage an add and a reorder
    await card.getByLabel("Add a fallback (tried in order, after the ones above)").selectOption(GPT);
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await card.getByRole("button", { name: "Move gpt-5 up" }).click();
    await expect(order(page)).toHaveText(["gpt-5", "grok"]);
    await expect(card.getByText("Unsaved changes")).toBeVisible();
    await expect(primary).toBeDisabled();
    await expect(card.getByText("Save or cancel the chain below before choosing another agent.")).toBeVisible();
    expect(puts, "staging must not write").toEqual([]);
    await checkScreen(page, "Fallback chain with unsaved changes");

    // cancel restores the saved chain and still writes nothing
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(order(page)).toHaveText(["grok"]);
    await expect(card.getByText("Unsaved changes")).toHaveCount(0);
    await expect(primary).toBeEnabled();
    expect(puts).toEqual([]);

    // a staged remove is a draft too
    await card.getByRole("button", { name: "Remove grok from the chain" }).click();
    await expect(chainCard(page).getByText(/^No fallbacks\./)).toBeVisible();
    await expect(card.getByText("Unsaved changes")).toBeVisible();
    expect(puts).toEqual([]);
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(order(page)).toHaveText(["grok"]);

    // stage again, then save: ONE request carrying the whole ordered list
    await card.getByLabel("Add a fallback (tried in order, after the ones above)").selectOption(GPT);
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await card.getByRole("button", { name: "Move gpt-5 up" }).click();
    await card.getByRole("button", { name: "Save chain" }).click();
    await expect(card.getByText("Saved — this is the chain in force.")).toBeVisible();
    expect(puts).toEqual([{ fallbackAgentIds: [GPT, GROK] }]);
    await expect(order(page)).toHaveText(["gpt-5", "grok"]);
    await expect(primary).toBeEnabled();
    await checkScreen(page, "Fallback chain saved");
  });

  test("a refused save keeps the draft and shows the gateway's reason", async ({ page }) => {
    const { puts } = await mockApi(page, { putStatus: 400 });
    await page.goto("/ui/admin/agents");
    const card = chainCard(page);
    await card.getByLabel("Primary agent").selectOption(OPUS);
    await expect(order(page)).toHaveText(["grok"]);
    await card.getByLabel("Add a fallback (tried in order, after the ones above)").selectOption(GPT);
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await card.getByRole("button", { name: "Save chain" }).click();
    await expect(card.getByRole("alert")).toContainText(/appear once|duplicate_fallback/);
    expect(puts).toHaveLength(1);
    await expect(order(page)).toHaveText(["grok", "gpt-5"]);
    await expect(card.getByText("Unsaved changes")).toBeVisible();
  });
});

test.describe("ADR-0179 UX-AG-5: a role grant links to the Roles page", () => {
  test("the unavailable Remove's reason carries a working link to the Roles page", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/agents");
    const card = page.locator("section").filter({ has: page.getByText("Per-user entitlement", { exact: true }) }).first();
    await card.getByLabel("User").selectOption("dana");
    await card.getByRole("button", { name: "View" }).click();
    const row = card.getByRole("row", { name: /^grok/ });
    await expect(row.getByText("role: engineering")).toBeVisible();
    await row.getByRole("button", { name: /the reason grok from this user cannot be removed here/ }).click();
    const link = page.getByRole("link", { name: "Open the Roles page" });
    await expect(link).toBeVisible();
    await expect(page.getByText(/Granted by role engineering\. Remove it from the role/)).toBeVisible();
    await checkScreen(page, "Role-granted reason with its link");
    await link.click();
    await expect(page).toHaveURL(/\/ui\/admin\/roles$/);
  });
});
