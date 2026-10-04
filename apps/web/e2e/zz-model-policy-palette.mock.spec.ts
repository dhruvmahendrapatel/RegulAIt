/**
 * ADR-0173 §3–4 — the model policy matrix, "Not allowed here" in the model
 * picker, and the command palette, against a mocked gateway (every /v1 and
 * /auth call answered in-test, like the other *.mock.spec.ts files).
 *
 *  - Model policy (admin): the matrix restricts a feature, allows a binding,
 *    picks a default, adds a data-class rule, and saves the exact PUT body;
 *    a gateway refusal is shown by name.
 *  - The Chat picker shows a binding the policy forbids for Chat as a disabled
 *    option with the reason, and Enter on it picks nothing.
 *  - The palette: Ctrl-K and the top-bar button open it; combobox + listbox;
 *    arrows, Enter and Escape; focus is trapped inside and returns on close;
 *    recent items; a non-admin is never offered an admin page; an admin is.
 *  - axe (WCAG 2.x A/AA) over each screen in both themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const CLAUDE = "bbbbbbbb-0000-4000-8000-000000000001";
const MOCK = "bbbbbbbb-0000-4000-8000-000000000002";
const GPT = "bbbbbbbb-0000-4000-8000-000000000003";
const AGENT = "cccccccc-0000-4000-8000-000000000001";
const THREAD = "dddddddd-0000-4000-8000-000000000001";
const PROJECT = "eeeeeeee-0000-4000-8000-000000000001";
const USE_CASE = "ffffffff-0000-4000-8000-000000000001";

const reg = (over: Record<string, unknown>) => ({
  enabled: true, costPerMTokIn: 1, costPerMTokOut: 2, systemPrompt: null, lifecycleStatus: "active", lifecycleReason: null,
  haltedAt: null, haltedReason: null, customProviderId: null, stewardName: null, orphaned: false, reviewOverdue: false, ...over,
});
const registry = [
  reg({ id: CLAUDE, name: "claude-opus", provider: "anthropic", model: "claude-opus-5", tier: 2 }),
  reg({ id: MOCK, name: "demo-mock", provider: "mock", model: "mock-balanced", tier: 0 }),
  reg({ id: GPT, name: "gpt-fast", provider: "openai", model: "gpt-5-mini", tier: 1 }),
];
const granted = [
  { agentId: CLAUDE, name: "claude-opus", provider: "anthropic", model: "claude-opus-5", tier: 2, enabled: true, revoked: false },
  { agentId: MOCK, name: "demo-mock", provider: "mock", model: "mock-balanced", tier: 0, enabled: true, revoked: false },
];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Cap {
  puts: unknown[];
  paths: string[];
}

async function mockApi(page: Page, opts: { admin: boolean; policy?: unknown; refusePut?: boolean }) {
  const cap: Cap = { puts: [], paths: [] };
  const me = { userId: "u", isAdmin: opts.admin, user: { id: "u", email: "avery@example.test", displayName: "Avery Example" } };
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    cap.paths.push(`${method} ${p}`);
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/model-policy" && method === "GET") return json(route, { scope: opts.admin ? "organisation" : "you", updatedAt: null, ...((opts.policy as object) ?? { rules: [] }) });
    if (p === "/v1/model-policy" && method === "PUT") {
      cap.puts.push(route.request().postDataJSON());
      if (opts.refusePut) {
        return json(route, { error: "default_not_allowed", detail: "the default for Chat is not allowed by the policy itself" }, 422);
      }
      return json(route, { changed: true, rules: (route.request().postDataJSON() as { rules: unknown[] }).rules });
    }
    if (p === "/v1/agents" && method === "GET") return json(route, { agents: registry });
    if (p === "/v1/users/u/agents") return json(route, { agents: granted, defaultAgentId: null });
    if (p === "/v1/model-providers/status") return json(route, { providers: { mock: { configured: true }, anthropic: { configured: true }, openai: { configured: true } } });
    if (p === "/v1/users/u/model-credentials") return json(route, { credentials: [] });
    if (p === "/v1/projects") return json(route, { projects: [{ id: PROJECT, name: "Northwind rollout" }] });
    if (p === "/v1/conversations" && method === "GET") return json(route, { conversations: [] });
    if (p === "/v1/builder/agents") {
      return json(route, { agents: [{ id: AGENT, name: "Vendor reviewer", description: "", color: "#2563eb", ownerUserId: "u", ownerName: "Avery Example", sharing: "private", modelAgent: null, templateId: null, monthlyLimitUsd: null, spentThisMonthUsd: 0, toolCount: 0, skillCount: 0, scheduleCount: 0, updatedAt: "2026-10-04T08:00:00Z", canEdit: true }] });
    }
    if (p === "/v1/builder/threads") {
      return json(route, { threads: [{ id: THREAD, agentId: AGENT, agentName: "Vendor reviewer", agentColor: "#2563eb", title: "Q3 vendor list", status: "active", source: "chat", lastMessagePreview: "", updatedAt: "2026-10-04T09:00:00Z" }] });
    }
    if (p === "/v1/use-cases") return json(route, { useCases: [{ id: USE_CASE, name: "Claims triage assistant", status: "under_review" }] });
    return json(route, {});
  });
  return cap;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function checkScreen(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

test.describe("ADR-0173: model policy", () => {
  test("admin matrix: restrict, allow, default, a data-class rule, and the exact PUT body", async ({ page }) => {
    const cap = await mockApi(page, { admin: true });
    await page.goto("/ui/admin/model-policy");
    await expect(page.getByRole("heading", { level: 1, name: "Model policy" })).toBeVisible();
    const matrix = page.getByRole("table", { name: "Allowed models per feature" });
    await expect(matrix.getByRole("columnheader")).toHaveCount(8);
    // unrestricted: no per-binding checkboxes yet, "any" everywhere
    await expect(matrix.getByRole("checkbox", { name: "Allow claude-opus for Chat" })).toHaveCount(0);
    await checkScreen(page, "Model policy — empty");

    // restrict Chat (the first Restrict switch is Chat's column)
    await matrix.getByRole("columnheader").nth(1).getByRole("checkbox", { name: "Restrict" }).check();
    await expect(page.getByRole("status").filter({ hasText: "restricted with no model allowed" })).toBeVisible();
    await matrix.getByRole("checkbox", { name: "Allow claude-opus for Chat" }).check();
    await matrix.getByRole("checkbox", { name: "Allow every Mock model for Chat" }).check();
    // a binding covered by its provider entry is shown allowed and locked
    await expect(matrix.getByRole("checkbox", { name: /Allow demo-mock for Chat/ })).toBeDisabled();
    await expect(matrix.getByRole("radio", { name: "Default for Chat: gpt-fast" })).toBeDisabled();
    await matrix.getByRole("radio", { name: "Default for Chat: claude-opus" }).check();

    // a stricter rule for regulated data in the intake assistant
    await page.getByLabel("Feature", { exact: true }).selectOption("intake_assist");
    await page.getByLabel("Data class", { exact: true }).selectOption("regulated");
    await page.getByRole("group", { name: /Models allowed for Intake assistant with regulated data/ }).getByRole("checkbox", { name: "claude-opus" }).check();
    await expect(page.getByRole("list", { name: "Data-class rules" })).toContainText("Intake assistant");
    await checkScreen(page, "Model policy — edited");

    await page.getByRole("button", { name: "Save policy" }).click();
    await expect.poll(() => cap.puts.length).toBe(1);
    expect(cap.puts[0]).toEqual({
      rules: [
        { feature: "chat", dataClass: null, restricted: true, allowedAgentIds: [CLAUDE], allowedProviders: ["mock"], defaultAgentId: CLAUDE },
        { feature: "intake_assist", dataClass: "regulated", restricted: true, allowedAgentIds: [CLAUDE], allowedProviders: [], defaultAgentId: null },
      ],
    });
  });

  test("a refused save is shown by its code", async ({ page }) => {
    await mockApi(page, { admin: true, refusePut: true });
    await page.goto("/ui/admin/model-policy");
    const matrix = page.getByRole("table", { name: "Allowed models per feature" });
    await matrix.getByRole("radio", { name: "Default for Chat: gpt-fast" }).check();
    await page.getByRole("button", { name: "Save policy" }).click();
    const outcome = page.getByTestId("model-policy-outcome");
    await expect(outcome).toContainText("Refused");
    await expect(outcome).toContainText("default_not_allowed");
  });

  test("the Chat picker shows a forbidden binding as 'Not allowed here' and will not pick it", async ({ page }) => {
    await mockApi(page, {
      admin: false,
      policy: { rules: [{ feature: "chat", dataClass: null, restricted: true, allowedAgentIds: [CLAUDE], allowedProviders: [], defaultAgentId: CLAUDE }] },
    });
    await page.goto("/ui/chat");
    const trigger = page.getByRole("button", { name: /^Agent/ });
    await expect(trigger).toHaveAccessibleName(/^Agent claude-opus/);
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const dialog = page.getByRole("dialog", { name: "Choose a model" });
    const listbox = dialog.getByRole("listbox", { name: "Models" });
    const forbidden = listbox.getByRole("option", { name: /demo-mock/ });
    await expect(forbidden).toHaveAttribute("aria-disabled", "true");
    await expect(forbidden).toContainText("Not allowed here");
    await expect(forbidden).toHaveAccessibleDescription(/does not allow this model for Chat/);
    await expect(listbox.getByRole("option", { name: /claude-opus/ })).not.toHaveAttribute("aria-disabled", "true");
    await checkScreen(page, "Chat — picker with a forbidden model");
    // Enter on the forbidden option picks nothing
    await page.keyboard.press("ArrowDown");
    const search = dialog.getByRole("combobox", { name: "Search models" });
    await expect(page.locator(`[id="${await search.getAttribute("aria-activedescendant")}"]`)).toContainText("demo-mock");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAccessibleName(/^Agent claude-opus/);
  });
});

test.describe("ADR-0173: command palette", () => {
  test("keyboard: Ctrl-K, search, arrows, Enter, Escape, focus trap and return, recent items", async ({ page }) => {
    await mockApi(page, { admin: false });
    await page.goto("/ui/chat");
    await expect(page.getByRole("heading", { level: 1, name: "Chat" })).toBeVisible();
    const opener = page.getByRole("button", { name: "Search", exact: true });
    await opener.focus();

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Search pages and your work" });
    await expect(dialog).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    const input = dialog.getByRole("combobox", { name: "Search pages, agents, models and projects" });
    await expect(input).toBeFocused();
    const listbox = dialog.getByRole("listbox", { name: "Results" });
    await expect(input).toHaveAttribute("aria-controls", (await listbox.getAttribute("id"))!);
    // empty query: pages
    await expect(listbox.getByRole("group", { name: "Pages" })).toBeVisible();
    await checkScreen(page, "Palette — open");

    // entities the person may open, grouped
    await input.fill("vendor");
    await expect(listbox.getByRole("group", { name: "Builder agents" }).getByRole("option", { name: /Vendor reviewer/ })).toBeVisible();
    await expect(listbox.getByRole("group", { name: "Recent agent threads" }).getByRole("option", { name: /Q3 vendor list/ })).toBeVisible();
    await input.fill("northwind");
    await expect(listbox.getByRole("option", { name: /Northwind rollout/ })).toBeVisible();
    await input.fill("claude");
    await expect(listbox.getByRole("group", { name: "Models" }).getByRole("option", { name: /claude-opus/ })).toBeVisible();
    await input.fill("zzzz nothing");
    await expect(dialog.getByRole("status")).toContainText("Nothing you can open matches");

    // arrows move the active option (aria-activedescendant), wrapping
    await input.fill("models");
    const activeText = async () => page.locator(`[id="${await input.getAttribute("aria-activedescendant")}"]`).innerText();
    expect(await activeText()).toContain("Models");
    await page.keyboard.press("ArrowUp");
    const last = await activeText();
    await page.keyboard.press("ArrowDown");
    expect(await activeText()).toContain("Models");
    expect(last).not.toBe("");

    // focus is trapped: Tab cycles between the input and the close button
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close search" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Close search" })).toBeFocused();
    await input.focus();

    // Escape closes and returns focus to the opener
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    // the button opens it; Enter opens the active result
    await opener.click();
    await input.fill("models");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/ui\/models$/);

    // reopening shows what was just opened under Recent
    await page.keyboard.press("Control+k");
    await expect(listbox.getByRole("group", { name: "Recent" }).getByRole("option", { name: /^Models/ })).toBeVisible();
    // Ctrl-K again closes it
    await page.keyboard.press("Control+k");
    await expect(dialog).toHaveCount(0);
  });

  test("a non-admin is never offered an admin page; an admin is, and use cases too", async ({ page }) => {
    await mockApi(page, { admin: false });
    await page.goto("/ui/");
    // the shell (and its shortcut) exists once the session has loaded
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Search pages and your work" });
    const input = dialog.getByRole("combobox", { name: "Search pages, agents, models and projects" });
    for (const q of ["model policy", "audit log", "users", "rules engine", "claims"]) {
      await input.fill(q);
      await expect(dialog.getByRole("option", { name: /Model policy|Audit log|Rules engine|Claims triage/ })).toHaveCount(0);
    }
    // positive control: the same search box does find the person's own pages
    await input.fill("model");
    await expect(dialog.getByRole("group", { name: "Pages" }).getByRole("option", { name: /^Models/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.unrouteAll({ behavior: "ignoreErrors" });

    await mockApi(page, { admin: true });
    await page.goto("/ui/");
    // the shell (and its shortcut) exists once the session has loaded
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
    await page.keyboard.press("Control+k");
    await input.fill("model policy");
    await expect(dialog.getByRole("group", { name: "Pages" }).getByRole("option", { name: /^Model policy/ })).toBeVisible();
    await input.fill("claims");
    await expect(dialog.getByRole("group", { name: "Use cases" }).getByRole("option", { name: /Claims triage assistant/ })).toBeVisible();
    await input.fill("model policy");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/ui\/admin\/model-policy$/);
    await expect(page.getByRole("heading", { level: 1, name: "Model policy" })).toBeVisible();
  });
});
