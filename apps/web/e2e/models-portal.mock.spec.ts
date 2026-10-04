/**
 * ADR-0172 — the model portal (/models) and the ModelPicker, from the
 * browser's side against a mocked gateway (the same harness as the other
 * *.mock.spec.ts files: every /v1 and /auth call is answered in-test).
 *
 *  - the portal: one tile per binding with logo, model id, tier and readiness
 *    (ready / needs credentials / halted / suspended), search, provider chips,
 *    selection, the four code-sample tabs, copy (key placeholder only), and a
 *    Run that goes through POST /v1/agents/:id/invoke with dispatch:true;
 *  - refusals by name: a governance deny (403 decision) and a named error
 *    (409 agent_suspended);
 *  - a person's own grants (not the registry), with the needs-credentials
 *    state pointing at their own keys;
 *  - the chat page's agent picker driven entirely by the keyboard, keeping the
 *    accessible name ("Agent") the phase1 spec relies on;
 *  - the agent registry's provider tiles and logo-decorated provider cells;
 *  - axe (WCAG 2.x A/AA) over each screen in BOTH themes.
 *
 * Set GOV_SHOTS_DIR to also save light + dark screenshots of each screen.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SHOTS = process.env.GOV_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const CLAUDE = "aaaaaaaa-0000-4000-8000-000000000001";
const GPT = "aaaaaaaa-0000-4000-8000-000000000002";
const MOCK = "aaaaaaaa-0000-4000-8000-000000000003";
const GROK = "aaaaaaaa-0000-4000-8000-000000000004";
const GEMINI = "aaaaaaaa-0000-4000-8000-000000000005";

const reg = (over: Record<string, unknown>) => ({
  enabled: true, costPerMTokIn: 1, costPerMTokOut: 2, systemPrompt: null, lifecycleStatus: "active", lifecycleReason: null,
  haltedAt: null, haltedReason: null, customProviderId: null, stewardName: null, orphaned: false, reviewOverdue: false, ...over,
});
const registry = [
  reg({ id: CLAUDE, name: "claude-opus", provider: "anthropic", model: "claude-opus-5", tier: 2 }),
  reg({ id: GPT, name: "gpt-fast", provider: "openai", model: "gpt-5-mini", tier: 1 }),
  reg({ id: MOCK, name: "demo-mock", provider: "mock", model: "mock-balanced", tier: 0 }),
  reg({ id: GROK, name: "grok-incident", provider: "xai", model: "grok-4", tier: 2, haltedAt: "2026-10-01T09:00:00Z", haltedReason: "incident 42" }),
  reg({ id: GEMINI, name: "gemini-review", provider: "google", model: "gemini-3-pro", tier: 2, lifecycleStatus: "suspended", lifecycleReason: "vendor review" }),
];
const providerStatus = { providers: { mock: { configured: true }, anthropic: { configured: true }, openai: { configured: false }, google: { configured: true }, xai: { configured: true } } };

const allow = {
  decision: { effect: "allow", ruleId: "grant-direct", reason: "user holds a direct grant for 'claude-opus'" },
  routing: { effect: "allow", selectedAgentId: CLAUDE },
  dispatch: { model: "claude-opus-5", costUsd: 0.0012, outputText: "An AI gateway sits between people and models and governs every call.", usage: { inputTokens: 12, outputTokens: 18 }, credentialSource: "platform" },
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Captured {
  invokes: Array<{ agentId: string; body: Record<string, unknown> }>;
  paths: string[];
  created: unknown[];
}

async function mockApi(page: Page, opts: { admin: boolean }) {
  const cap: Captured = { invokes: [], paths: [], created: [] };
  const me = { userId: "u", isAdmin: opts.admin, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    cap.paths.push(`${method} ${p}`);
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/agents" && method === "GET") return json(route, { agents: registry });
    if (p === "/v1/agents" && method === "POST") {
      cap.created.push(route.request().postDataJSON());
      return json(route, { id: "new" }, 201);
    }
    if (p === "/v1/users/u/agents") {
      return json(route, {
        agents: [
          { agentId: CLAUDE, name: "claude-opus", provider: "anthropic", model: "claude-opus-5", tier: 2, enabled: true, revoked: false, source: "direct", roles: [] },
          { agentId: GPT, name: "gpt-fast", provider: "openai", model: "gpt-5-mini", tier: 1, enabled: true, revoked: false, source: "role", roles: ["developers"] },
          { agentId: MOCK, name: "demo-mock", provider: "mock", model: "mock-balanced", tier: 0, enabled: true, revoked: false, source: "direct", roles: [] },
        ],
        defaultAgentId: null,
      });
    }
    if (p === "/v1/model-providers/status") return json(route, providerStatus);
    if (p === "/v1/users/u/model-credentials") return json(route, { credentials: [] });
    if (p === "/v1/model-credentials") return json(route, { credentials: [] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (p === "/v1/conversations" && method === "GET") return json(route, { conversations: [] });
    if (p === "/v1/conversations" && method === "POST") return json(route, { id: "c0nv0000-0000-4000-8000-000000000000" }, 201);
    if (p.startsWith("/v1/conversations/")) return json(route, { id: "c", agentId: MOCK, projectId: null, messages: [] });
    if (p === "/v1/custom-model-providers") return json(route, { providers: [] });
    if (p === "/v1/users") return json(route, { users: [] });
    const inv = /^\/v1\/agents\/([^/]+)\/invoke$/.exec(p);
    if (inv && method === "POST") {
      const agentId = inv[1]!;
      cap.invokes.push({ agentId, body: route.request().postDataJSON() });
      if (agentId === CLAUDE) return json(route, allow);
      if (agentId === MOCK) {
        return json(route, { decision: { effect: "deny", ruleId: "no-grant", reason: "user u has no grant for agent 'demo-mock' (aaaaaaaa…)" } }, 403);
      }
      if (agentId === GEMINI) {
        return json(route, { error: "agent_suspended", detail: "agent 'gemini-review' is suspended: vendor review — an admin can return it to service" }, 409);
      }
      if (agentId === GPT) {
        return json(route, { decision: allow.decision, error: "no_model_credential", detail: "no openai credential is configured" }, 409);
      }
      return json(route, { error: "agent_halted", detail: "halted" }, 409);
    }
    return json(route, {});
  });
  return cap;
}

/** clipboard writes land in window.__copied (no permission prompt, no real clipboard) */
async function stubClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void ((window as unknown as { __copied: string }).__copied = t) },
    });
  });
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function checkScreen(page: Page, label: string, shot?: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on "${label}" (${theme})`).toEqual([]);
    if (SHOTS && shot) await page.screenshot({ path: path.join(SHOTS, `models-${shot}-${theme}.png`), fullPage: true });
  }
  await setTheme(page, "light");
}

const grid = (page: Page) => page.getByRole("list", { name: "Models" });
const tile = (page: Page, name: string) => grid(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

test.describe("ADR-0172: the model portal", () => {
  test("tiles with readiness, search, provider chips, selection, sample tabs, copy and a governed Run", async ({ page }) => {
    await stubClipboard(page);
    const cap = await mockApi(page, { admin: true });
    await page.goto("/ui/models");
    await expect(page.getByRole("heading", { level: 1, name: "Models" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Choose a model" })).toBeVisible();

    // one tile per binding, each with model id, tier and its readiness
    await expect(grid(page).getByRole("button")).toHaveCount(5);
    await expect(tile(page, "claude-opus")).toContainText("claude-opus-5");
    await expect(tile(page, "claude-opus")).toContainText("Tier 2");
    await expect(tile(page, "claude-opus")).toContainText("Ready");
    await expect(tile(page, "gpt-fast")).toContainText("Needs credentials");
    await expect(tile(page, "grok-incident")).toContainText("Halted");
    await expect(tile(page, "gemini-review")).toContainText("Suspended");
    await expect(tile(page, "demo-mock")).toContainText("Ready");
    // logos are vendored files (never fetched from a third party), and decorative
    const logo = tile(page, "claude-opus").locator("img").first();
    await expect(logo).toHaveAttribute("src", /^(\/ui\/|data:image\/svg)/);
    await checkScreen(page, "Models — nothing selected", "empty");

    // search: model id and provider name both match
    const search = page.getByRole("searchbox", { name: "Search models and providers" });
    await search.fill("gpt-5");
    await expect(grid(page).getByRole("button")).toHaveCount(1);
    await search.fill("google");
    await expect(grid(page).getByRole("button")).toHaveCount(1);
    await expect(tile(page, "gemini-review")).toBeVisible();
    await search.fill("no-such-model");
    await expect(page.getByText("No models match")).toBeVisible();
    await search.fill("");

    // provider chips filter; pressing again clears
    const chips = page.getByRole("group", { name: "Filter by provider" });
    // accessible names (a monogram logo's letter is aria-hidden, so not part of the name)
    const chipNames = ["All 5", "Anthropic 1", "Google 1", "Mock 1", "OpenAI 1", "xAI 1"];
    await expect(chips.getByRole("button")).toHaveCount(chipNames.length);
    for (const [i, name] of chipNames.entries()) await expect(chips.getByRole("button").nth(i)).toHaveAccessibleName(name);
    await chips.getByRole("button", { name: "Mock 1" }).click();
    await expect(chips.getByRole("button", { name: "Mock 1" })).toHaveAttribute("aria-pressed", "true");
    await expect(grid(page).getByRole("button")).toHaveCount(1);
    await chips.getByRole("button", { name: "Mock 1" }).click();
    await expect(grid(page).getByRole("button")).toHaveCount(5);

    // select: the Try it panel fills in, the URL remembers the choice
    await tile(page, "claude-opus").click();
    await expect(tile(page, "claude-opus")).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(new RegExp(`model=${CLAUDE}`));
    const selected = page.getByRole("group", { name: "Selected model" });
    await expect(selected).toContainText("claude-opus");
    await expect(selected).toContainText("Anthropic · tier 2");
    await expect(page.getByTestId("readiness-detail")).toHaveText("Runs on the platform Anthropic credential.");

    // the four sample tabs, each with the endpoint, the pinned binding and a key placeholder
    const tabs = page.getByRole("tablist");
    await expect(tabs.getByRole("tab")).toHaveText(["cURL", "TypeScript", "Python", "Anthropic SDK"]);
    const snippet = page.getByTestId("model-snippet");
    await expect(snippet).toContainText("/v1/chat/completions");
    await expect(snippet).toContainText(`x-regulait-agent-id: ${CLAUDE}`);
    await expect(snippet).toContainText("$REGULAIT_API_KEY");
    await page.getByLabel("Request").fill("Name one thing an AI gateway checks.");
    await expect(snippet).toContainText("Name one thing an AI gateway checks.");
    await tabs.getByRole("tab", { name: "Python" }).click();
    await expect(tabs.getByRole("tab", { name: "Python" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Python sample" })).toContainText('api_key=os.environ["REGULAIT_API_KEY"]');
    await tabs.getByRole("tab", { name: "Anthropic SDK" }).click();
    await expect(snippet).toContainText('import Anthropic from "@anthropic-ai/sdk"');
    await tabs.getByRole("tab", { name: "TypeScript" }).click();
    await expect(snippet).toContainText('import OpenAI from "openai"');

    // copy puts exactly the visible sample on the clipboard
    await page.getByRole("button", { name: "Copy TypeScript sample" }).click();
    await expect(page.getByRole("button", { name: "Copy TypeScript sample" })).toHaveText("Copied");
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? "");
    expect(copied).toBe(await snippet.textContent());
    expect(copied).toContain("process.env.REGULAIT_API_KEY");
    expect(copied).not.toMatch(/sk-[A-Za-z0-9]/);

    // Run → the governed invoke path, executing (dispatch:true), as the person
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const result = page.getByTestId("run-result");
    await expect(result).toContainText("An AI gateway sits between people and models");
    await expect(result).toContainText("Allowed");
    await expect(result).toContainText("grant-direct");
    await expect(result).toContainText("$0.0012");
    await expect(result).toContainText("claude-opus-5");
    await expect(result).toContainText(/\d+ ms|\d\.\d\d s/);
    await expect(result).toContainText("user holds a direct grant for 'claude-opus'");
    await expect(result).toContainText("12 in · 18 out");
    expect(cap.invokes).toHaveLength(1);
    expect(cap.invokes[0]).toEqual({ agentId: CLAUDE, body: { mode: "execute", input: "Name one thing an AI gateway checks.", dispatch: true } });
    await checkScreen(page, "Models — selected and run", "run");
  });

  test("refusals come back by name: a governance deny and a suspended model", async ({ page }) => {
    await mockApi(page, { admin: true });
    await page.goto(`/ui/models?model=${MOCK}`);
    await expect(page.getByRole("group", { name: "Selected model" })).toContainText("demo-mock");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const result = page.getByTestId("run-result");
    await expect(result).toHaveAttribute("role", "alert");
    await expect(result).toContainText("Refused by governance");
    await expect(result).toContainText("no-grant");
    await expect(result).toContainText("has no grant for agent 'demo-mock'");
    await checkScreen(page, "Models — governance refusal", "refused");

    // a suspended binding says so on its tile, and the call's refusal names it
    await tile(page, "gemini-review").click();
    await expect(page.getByTestId("readiness-detail")).toContainText("Suspended: vendor review");
    // a fresh selection starts with no stale result
    await expect(page.getByTestId("run-result")).toHaveCount(0);
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("run-result")).toContainText("agent_suspended");
    await expect(page.getByTestId("run-result")).toContainText("HTTP 409");
    await expect(page.getByTestId("run-result")).toContainText("is suspended: vendor review");
  });

  test("a person's own grants: needs credentials points at their own keys", async ({ page }) => {
    const cap = await mockApi(page, { admin: false });
    await page.goto("/ui/models");
    await expect(grid(page).getByRole("button")).toHaveCount(3);
    // never the admin registry for a non-admin
    expect(cap.paths).toContain("GET /v1/users/u/agents");
    expect(cap.paths).not.toContain("GET /v1/agents");

    await tile(page, "gpt-fast").click();
    await expect(page.getByRole("group", { name: "Selected model" })).toContainText("Needs credentials");
    const detail = page.getByTestId("readiness-detail");
    await expect(detail).toContainText("No OpenAI credential is configured yet");
    await expect(detail.getByRole("link", { name: "Add your own key" })).toHaveAttribute("href", "/ui/account?section=keys");
    await checkScreen(page, "Models — needs credentials", "needs-credentials");

    // the call is still the governed one; its refusal is shown by name
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("run-result")).toContainText("no_model_credential");
  });
});

test.describe("ADR-0172: the model picker", () => {
  test("chat's agent picker works from the keyboard alone and keeps its accessible name", async ({ page }) => {
    const cap = await mockApi(page, { admin: false });
    await page.goto("/ui/chat");
    await expect(page.getByRole("heading", { level: 1, name: "Chat" })).toBeVisible();
    // the name phase1.spec.ts relies on
    const trigger = page.getByLabel("Agent");
    await expect(trigger).toBeVisible();
    // the default is the best live real provider (unchanged): claude-opus
    await expect(trigger).toHaveAccessibleName(/^Agent claude-opus/);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // open with ArrowDown: focus lands in the search box, the chosen option is active
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const dialog = page.getByRole("dialog", { name: "Choose a model" });
    await expect(dialog).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const search = dialog.getByRole("combobox", { name: "Search models" });
    await expect(search).toBeFocused();
    const listbox = dialog.getByRole("listbox", { name: "Models" });
    await expect(listbox.getByRole("option")).toHaveCount(3);
    await expect(listbox.getByRole("option", { selected: true })).toContainText("claude-opus");
    await expect(listbox.getByRole("option", { name: /gpt-fast/ })).toContainText("Needs credentials");
    await checkScreen(page, "Chat — model picker open", "picker");

    // Escape closes and returns focus to the trigger, value unchanged
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAccessibleName(/^Agent claude-opus/);

    // Enter opens too; typing filters; arrows move the active option; Enter picks
    await page.keyboard.press("Enter");
    await expect(search).toBeFocused();
    await page.keyboard.type("mo");
    await expect(listbox.getByRole("option")).toHaveCount(1);
    await search.fill("");
    await expect(listbox.getByRole("option")).toHaveCount(3);
    // options are in name order: claude-opus, demo-mock, gpt-fast; active starts at the first
    await page.keyboard.press("ArrowDown");
    const activeId = await search.getAttribute("aria-activedescendant");
    await expect(page.locator(`[id="${activeId}"]`)).toContainText("demo-mock");
    await page.keyboard.press("End");
    await expect(page.locator(`[id="${await search.getAttribute("aria-activedescendant")}"]`)).toContainText("gpt-fast");
    await page.keyboard.press("ArrowDown"); // wraps
    await expect(page.locator(`[id="${await search.getAttribute("aria-activedescendant")}"]`)).toContainText("claude-opus");
    await page.keyboard.press("ArrowUp"); // wraps back
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAccessibleName(/^Agent demo-mock/);

    // a click outside closes without picking
    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.getByRole("heading", { level: 1, name: "Chat" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toHaveAccessibleName(/^Agent demo-mock/);

    // the pick is what the conversation is sent to
    await page.getByLabel("Message").fill("hello");
    await page.getByLabel("Message").press("Enter");
    await expect.poll(() => cap.invokes.length).toBe(1);
    expect(cap.invokes[0]!.agentId).toBe(MOCK);
  });

  test("agent registry: provider tiles in the register form, logos beside provider names", async ({ page }) => {
    const cap = await mockApi(page, { admin: true });
    await page.goto("/ui/admin/agents");
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
    // the catalog's provider cell keeps its plain text as its accessible name
    const catalog = page.locator("section").filter({ has: page.getByText("Catalog", { exact: true }) }).first();
    await expect(catalog.getByRole("cell", { name: "anthropic", exact: true })).toBeVisible();
    await expect(catalog.getByRole("cell", { name: "anthropic", exact: true }).locator("img")).toHaveCount(1);

    const form = page.locator("form", { has: page.getByRole("button", { name: "Register agent" }) });
    const providers = form.getByRole("group", { name: "Provider" });
    await expect(providers.getByRole("radio")).toHaveCount(6);
    await expect(providers.getByRole("radio", { name: "Anthropic" })).toBeChecked();
    // arrows move between tiles like any radio group
    await providers.getByRole("radio", { name: "Anthropic" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(providers.getByRole("radio", { name: "OpenAI" })).toBeChecked();
    await providers.getByRole("radio", { name: "Mock" }).check();
    // the custom endpoint picker appears only for a custom provider
    await expect(page.getByTestId("agent-custom-endpoint")).toHaveCount(0);
    await form.getByLabel("Name", { exact: true }).fill("e2e-mock");
    await form.getByLabel("Tier (0 = cheapest)").fill("0");
    await form.getByRole("button", { name: "Register agent" }).click();
    await expect.poll(() => cap.created.length).toBe(1);
    expect(cap.created[0]).toMatchObject({ name: "e2e-mock", provider: "mock", tier: 0 });

    await page.getByTestId("agent-provider").getByRole("radio", { name: "Custom endpoint" }).check();
    await expect(page.getByTestId("agent-custom-endpoint")).toBeVisible();
    await checkScreen(page, "Agents — provider tiles", "agents");
  });
});
