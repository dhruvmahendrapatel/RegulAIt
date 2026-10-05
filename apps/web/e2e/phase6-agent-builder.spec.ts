/**
 * ADR-0172 — the agent builder and the model portal against a REAL seeded
 * gateway (no mocks): every step below goes through the Builder API and the
 * governed invoke core exactly as a person would drive them.
 *
 *  1. Dana (NOT an admin) creates an agent from a template, edits its
 *     instructions and sharing, adds a memory item, turns on the template's
 *     schedule (seeded OFF), picks its model in the shared ModelPicker, chats
 *     with it (the mock provider answers) and sees the reply with its cost,
 *     finds the thread in Agent inbox, then sets a tiny monthly limit and is
 *     refused by name once the agent's spend reaches it.
 *  2. An admin opens Agent usage and sees that agent's spend and Dana in it,
 *     and a schedule the admin writes on Dana's agent waits for Dana (it
 *     would run, and spend, as her).
 *  3. Dana's /models portal lists the models she holds and a Run succeeds
 *     through governance.
 *
 * Sign-in is order-independent (M-017): each persona tries the password an
 * earlier spec may have rotated to, then the seeded one-time one, and settles
 * on the shared password. Zero console errors are asserted; the browser's own
 * network lines for the deliberate 4xx refusals are the only filter.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string; dana: string; avery: string };
  baseUrl: string;
};

/** the password phase2 rotates the seeded one-time admin credential to */
const ADMIN_PASSWORD = "E2e-Admin-Phase2!";
/** the password phase1 rotates dana's seeded one-time credential to */
const DANA_PASSWORD = "E2e-Rewrite-2026!";
/** a per-run name, so a re-run against the same database finds its own agent */
const AGENT = `Intake e2e ${Date.now().toString(36)}`;

interface ConsoleTracker {
  assertClean: (label: string) => void;
}
function trackConsole(page: Page): ConsoleTracker {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // the browser's network log for the DELIBERATE refusals (402 limit) and the
    // pre-login 401 probe — emitted by the browser, not by our code
    if (/Failed to load resource.*status of 4\d\d/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return {
    assertClean(label: string) {
      expect(errors, `console must be clean after: ${label}`).toEqual([]);
    },
  };
}

/** the credential bucket is a real control: wait it out rather than weaken it */
async function submitLogin(page: Page): Promise<number | null> {
  const settled = page
    .waitForResponse((r) => r.url().includes("/auth/login") && r.request().method() === "POST", { timeout: 15_000 })
    .catch(() => null);
  await page.getByRole("button", { name: "Sign in" }).click();
  const res = await settled;
  if (!res || res.status() !== 429) return null;
  const body = (await res.json()) as { retryAfterSeconds?: number };
  return Math.min(body.retryAfterSeconds ?? 60, 310);
}

/** Sign in without assuming which earlier spec rotated the password. */
async function signIn(page: Page, email: string, candidates: string[], settleOn: string) {
  for (const [i, password] of candidates.entries()) {
    await page.goto("/ui");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    for (let attempt = 0; ; attempt += 1) {
      const waitFor = await submitLogin(page);
      if (waitFor === null) break;
      expect(attempt, `login stayed rate-limited for ${email}`).toBeLessThan(6);
      await page.waitForTimeout((waitFor + 2) * 1000);
    }
    const welcome = page.getByRole("heading", { name: /Welcome back/ });
    const forcedChange = page.getByText("Your password is one-time");
    const rejected = page.getByText(/password is incorrect/);
    await expect(welcome.or(forcedChange).or(rejected).first()).toBeVisible();
    if (await welcome.isVisible()) return;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await expect(welcome).toBeVisible();
      return;
    }
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

test.describe.configure({ mode: "serial" });

let dana: { page: Page; track: ConsoleTracker };
let agentId = "";

async function danaSession(browser: Browser) {
  if (!dana) {
    const page = await browser.newPage();
    const track = trackConsole(page);
    await signIn(page, "dana@regulait.local", [DANA_PASSWORD, state.passwords.dana], DANA_PASSWORD);
    dana = { page, track };
  }
  return dana;
}

/** ADR-0181: the release-age cooldown (7 days by default) holds every NEW skill
 * version, including the private copies a template makes. This journey is about
 * the builder, not the cooldown, so it relaxes the cooldown through the real
 * audited admin route for its lifetime and restores what it found (M-068). */
let savedMinReleaseAgeDays: number | null = null;
async function orgSettings(baseURL: string, payload?: Record<string, unknown>) {
  const res = await fetch(`${baseURL}/v1/org/settings`, {
    method: payload ? "PUT" : "GET",
    headers: { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  expect(res.ok, `org settings ${payload ? "PUT" : "GET"}: ${res.status}`).toBe(true);
  return (await res.json()) as { settings: { minReleaseAgeDays: number } };
}

test.afterAll(async () => {
  await dana?.page.close();
  if (savedMinReleaseAgeDays !== null) await orgSettings(state.baseUrl, { minReleaseAgeDays: savedMinReleaseAgeDays });
});

/** owner rule (2026-10-04): every builder agent bills to a project. An admin
 * makes one for this run (no budget, so the journey's spend is never capped by
 * the seeded demo budgets) and adds Dana to it. */
const PROJECT_NAME = `Agent builder e2e ${Date.now().toString(36)}`;
let projectId = "";
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  savedMinReleaseAgeDays = (await orgSettings(state.baseUrl)).settings.minReleaseAgeDays;
  await orgSettings(state.baseUrl, { minReleaseAgeDays: 0 });
  const page = await browser.newPage();
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  const CSRF = { "x-regulait-csrf": "1" };
  const made = await page.request.post("/v1/projects", { headers: CSRF, data: { name: PROJECT_NAME } });
  expect(made.status(), await made.text()).toBe(201);
  projectId = ((await made.json()) as { id: string }).id;
  const users = (await (await page.request.get("/v1/users")).json()) as { users?: Array<{ id: string; email: string }> } | Array<{ id: string; email: string }>;
  const list = Array.isArray(users) ? users : (users.users ?? []);
  const danaId = list.find((u) => u.email === "dana@regulait.local")!.id;
  const added = await page.request.post(`/v1/projects/${projectId}/members`, { headers: CSRF, data: { userId: danaId, role: "contributor" } });
  expect(added.status(), await added.text()).toBeLessThan(300);
  await page.close();
});

const panel = (page: Page) => page.getByRole("complementary", { name: "Configure agent" });
const section = (page: Page, title: string) => panel(page).getByRole("region", { name: title });
async function expand(page: Page, title: string) {
  const btn = panel(page).getByRole("button", { name: new RegExp(`^${title}`) });
  if ((await btn.getAttribute("aria-expanded")) === "false") await btn.click();
  await expect(section(page, title)).toBeVisible();
}

/** the agent as the gateway sees it now (the session cookie rides along) */
async function readAgent(page: Page) {
  const res = await page.request.get(`/v1/builder/agents/${agentId}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { agent: Record<string, any> }).agent; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function send(page: Page, text: string) {
  await page.getByLabel(`Message ${AGENT}`).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("a non-admin creates an agent from a template and configures it", async ({ browser }) => {
  test.setTimeout(400_000);
  const { page, track } = await danaSession(browser);

  await page.goto("/ui/builder/templates");
  await expect(page.getByRole("heading", { level: 1, name: "Agent templates" })).toBeVisible();
  await page.getByRole("list", { name: "Templates" }).getByRole("link", { name: /AI intake reviewer/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "AI intake reviewer" })).toBeVisible();
  await page.getByRole("button", { name: "Create agent" }).click();
  const dialog = page.getByRole("dialog", { name: "New agent from AI intake reviewer" });
  await dialog.getByLabel("Name your agent").fill(AGENT);
  // owner rule: an agent is created billed to a project the person belongs to
  await dialog.getByLabel("Bill to project").selectOption({ label: PROJECT_NAME });
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(/\/ui\/builder\/agents\/[0-9a-f-]{36}\?setup=1/);
  agentId = /agents\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByRole("heading", { level: 1, name: AGENT })).toBeVisible();
  await page.getByRole("group", { name: "Agent setup" }).getByRole("button", { name: "Save and continue" }).click();
  await expect(page).not.toHaveURL(/setup=1/);

  // what the template seeded, read back from the gateway
  const seeded = await readAgent(page);
  expect(seeded.templateId).toBe("ai-intake-reviewer");
  expect(seeded.ownerName).toBe("Dana Developer");
  expect(seeded.skills.length).toBeGreaterThan(0);
  expect(seeded.subagents.length).toBeGreaterThan(0);
  expect(seeded.schedules.length).toBeGreaterThan(0);
  expect(seeded.schedules.every((s: { enabled: boolean; nextRunAt: string | null }) => !s.enabled && s.nextRunAt === null)).toBe(true);
  // template skills are Dana's own private copies, pinned at their current version
  expect(seeded.skills.every((k: { updateAvailable: boolean; unavailable: boolean }) => !k.updateAvailable && !k.unavailable)).toBe(true);
  expect(seeded.project).toMatchObject({ id: projectId, name: PROJECT_NAME });

  // instructions
  const kn = section(page, "Knowledge");
  await kn.getByLabel("Instructions").fill("# Purpose\nReview new AI intake requests and list what is missing.\n\n# Rules\n- Never approve anything.");
  await kn.getByRole("button", { name: "Save instructions" }).click();
  await expect(page.getByText("Instructions saved")).toBeVisible();

  // sharing: private → workspace
  const sh = section(page, "Sharing");
  await expect(sh.getByRole("radio", { name: "Private" })).toBeChecked();
  await sh.getByRole("radio", { name: "Workspace" }).check();
  await expect(sh.getByText("Everyone in the workspace can use it.")).toBeVisible();

  // memory
  const mem = section(page, "Memory");
  await mem.getByLabel("Something to remember").fill("The review board meets on Thursdays.");
  await mem.getByRole("button", { name: "Add to memory" }).click();
  await expect(mem.getByRole("list", { name: "Memory" })).toContainText("The review board meets on Thursdays.");

  // the template's schedule arrives OFF; the owner turns it on
  const scheduleName = seeded.schedules[0].name as string;
  const row = section(page, "Schedules").getByRole("listitem").filter({ hasText: scheduleName });
  await expect(row.getByText("Off", { exact: true })).toBeVisible();
  const toggle = row.getByRole("switch", { name: `${scheduleName} on` });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(row).toContainText("next ");

  // the model, in the shared picker: the premium mock binding
  await expand(page, "Advanced");
  const adv = section(page, "Advanced");
  await adv.getByLabel("Model").click();
  const models = page.getByRole("dialog", { name: "Choose a model" }).getByRole("listbox", { name: "Models" });
  await expect(models.getByRole("option", { name: /balanced-mock/ })).toBeVisible();
  await models.getByRole("option", { name: /premium-mock/ }).click();
  await expect(page.getByText("Model saved")).toBeVisible();
  await expect(adv.getByLabel("Model")).toHaveAccessibleName(/^Model premium-mock/);

  const after = await readAgent(page);
  expect(after.instructions).toContain("Never approve anything.");
  expect(after.sharing).toBe("workspace");
  expect(after.memory.map((m: { content: string }) => m.content)).toContain("The review board meets on Thursdays.");
  const on = after.schedules.find((s: { name: string }) => s.name === scheduleName);
  expect(on.enabled).toBe(true);
  expect(on.nextRunAt).not.toBeNull();
  expect(after.modelAgent.name).toBe("premium-mock");
  track.assertClean("create and configure");
});

test("chat answers through the governed core with its cost, and the thread is in Agent inbox", async ({ browser }) => {
  const { page, track } = await danaSession(browser);
  await page.goto(`/ui/builder/agents/${agentId}`);
  await expect(page.getByRole("heading", { level: 1, name: AGENT })).toBeVisible();

  const before = Number((await readAgent(page)).spentThisMonthUsd);
  await send(page, "Which intake requests are missing a data owner?");
  await expect(page).toHaveURL(/thread=[0-9a-f-]{36}/);
  const convo = page.getByRole("region", { name: "Conversation" });
  await expect(convo.getByText(`${AGENT}:`)).toBeVisible({ timeout: 30_000 });
  // the reply carries the served model and the cost the governed core measured
  const after = await readAgent(page);
  expect(Number(after.spentThisMonthUsd)).toBeGreaterThan(before);
  const thread = new URL(page.url()).searchParams.get("thread")!;
  const msgs = (await (await page.request.get(`/v1/builder/threads/${thread}`)).json()) as {
    messages: Array<{ role: string; costUsd: number | null; model: string | null }>;
  };
  const reply = msgs.messages.find((m) => m.role === "agent")!;
  expect(reply.costUsd).toBeGreaterThan(0);
  await expect(convo).toContainText(reply.model!);
  await expect(convo).toContainText(`$${reply.costUsd!.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`);

  // Agent inbox → All: the thread, and opening it shows the conversation
  await page.goto("/ui/builder/inbox?tab=all");
  await expect(page.getByRole("heading", { level: 1, name: "Agent inbox" })).toBeVisible();
  const list = page.getByRole("list", { name: "Threads" });
  await list.getByRole("button", { name: /Which intake requests are missing a data owner\?/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`thread=${thread}`));
  await expect(page.getByText(`${AGENT}:`).first()).toBeVisible();
  track.assertClean("chat and inbox");
});

test("a tiny monthly limit refuses the next message by name", async ({ browser }) => {
  const { page, track } = await danaSession(browser);
  await page.goto(`/ui/builder/agents/${agentId}`);
  await expect(page.getByRole("heading", { level: 1, name: AGENT })).toBeVisible();

  // spend at least the smallest limit the API accepts ($0.01) — the premium
  // mock's measured cost decides how many turns that takes
  for (let i = 0; i < 8 && Number((await readAgent(page)).spentThisMonthUsd) < 0.01; i++) {
    await send(page, `List every open intake request in detail, with owners and dates (pass ${i + 1}).`);
    await expect(page.getByRole("region", { name: "Conversation" }).getByText(`${AGENT}:`).last()).toBeVisible({ timeout: 30_000 });
  }
  expect(Number((await readAgent(page)).spentThisMonthUsd)).toBeGreaterThanOrEqual(0.01);

  await expand(page, "Advanced");
  const adv = section(page, "Advanced");
  await adv.getByLabel("Monthly spend limit (USD)").fill("0.01");
  await adv.getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByText("Spend limit saved")).toBeVisible();
  expect((await readAgent(page)).monthlyLimitUsd).toBe(0.01);

  const chat = page.waitForResponse((r) => r.url().endsWith(`/v1/builder/agents/${agentId}/chat`) && r.request().method() === "POST");
  await send(page, "One more question, please.");
  const res = await chat;
  expect(res.status()).toBe(402);
  expect(((await res.json()) as { error: string }).error).toBe("agent_spend_limit_reached");
  await expect(page.getByRole("alert")).toContainText(/agent spend limit reached/i);
  await expect(page.getByRole("alert")).toContainText("monthly limit");
  track.assertClean("spend limit");
});

test("an admin sees that agent's spend in Agent usage", async ({ browser }) => {
  const page = await browser.newPage();
  const track = trackConsole(page);
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  await page.goto("/ui/builder/usage");
  await expect(page.getByRole("heading", { level: 1, name: "Agent usage" })).toBeVisible();
  const res = await page.request.get("/v1/builder/usage?days=7");
  const usage = (await res.json()) as { byAgent: Array<{ agentId: string; spendUsd: number }> };
  const mine = usage.byAgent.find((a) => a.agentId === agentId);
  expect(mine, "the admin's usage includes Dana's agent").toBeTruthy();
  expect(mine!.spendUsd).toBeGreaterThanOrEqual(0.01);

  const row = page.getByRole("row", { name: new RegExp(AGENT) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("$0.01"); // its limit
  await expect(page.getByRole("meter", { name: `${AGENT} spend against its limit` })).toBeVisible();
  await page.getByRole("tab", { name: "By person" }).click();
  await expect(page.getByRole("row", { name: /Dana Developer/ })).toBeVisible();

  // an admin may write a schedule on Dana's agent, but it runs (and spends) as
  // Dana — so it is saved off and only Dana can turn it on
  const CSRF = { "x-regulait-csrf": "1" };
  const made = await page.request.post(`/v1/builder/agents/${agentId}/schedules`, {
    headers: CSRF,
    data: { name: "Admin digest", cadence: "daily", timeUtc: "07:00", prompt: "Write the digest.", enabled: true },
  });
  expect(made.status()).toBe(201);
  const sc = (await made.json()) as { id: string; enabled: boolean; awaitingOwner: boolean };
  expect(sc).toMatchObject({ enabled: false, awaitingOwner: true });
  const turnOn = await page.request.patch(`/v1/builder/agents/${agentId}/schedules/${sc.id}`, { headers: CSRF, data: { enabled: true } });
  expect(turnOn.status()).toBe(403);
  expect(((await turnOn.json()) as { error: string }).error).toBe("owner_must_enable_schedule");
  expect((await page.request.delete(`/v1/builder/agents/${agentId}/schedules/${sc.id}`, { headers: CSRF })).status()).toBe(204);
  track.assertClean("agent usage");
  await page.close();
});

test("the model portal shows the person's models and a Run succeeds", async ({ browser }) => {
  const { page, track } = await danaSession(browser);
  await page.goto("/ui/models");
  await expect(page.getByRole("heading", { level: 1, name: "Models" })).toBeVisible();
  const grid = page.getByRole("list", { name: "Models" });
  // exactly the bindings Dana holds, one tile each
  const me = (await (await page.request.get("/auth/me")).json()) as { userId: string };
  const held = (await (await page.request.get(`/v1/users/${me.userId}/agents`)).json()) as {
    agents: Array<{ name: string; revoked?: boolean }>;
  };
  const names = held.agents.filter((a) => !a.revoked).map((a) => a.name);
  expect(names).toContain("balanced-mock");
  await expect(grid.getByRole("listitem")).toHaveCount(names.length);
  for (const name of names) await expect(grid.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  await grid.getByRole("button", { name: /balanced-mock/ }).click();
  await expect(page.getByRole("group", { name: "Selected model" })).toContainText("balanced-mock");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const result = page.getByTestId("run-result");
  await expect(result).toContainText("Allowed", { timeout: 30_000 });
  await expect(result).toContainText("$");
  track.assertClean("model portal");
});
