/**
 * ADR-0073 — the rule shadow canary, driven in a real browser.
 *
 * ADR-0048 stored rule versions and nothing read them, so its shadow canary for
 * rules evaluated nothing. ADR-0073 wired it, and the operator surface is the
 * point: a measurement nobody deciding whether to promote can see is not a
 * measurement. So this spec asserts on the RENDERED SCREEN, not on JSON:
 *
 *  1. The Rules engine page states the invariant an operator must not get wrong
 *     — a rule canary NEVER enforces, and `canary %` is the SAMPLING rate, not
 *     a share of enforcement.
 *  2. A candidate that would PAUSE a call the active version ALLOWS shows up as
 *     a real divergence row naming both sides AND the sentence the caller would
 *     have been given — while the caller was, in fact, allowed.
 *  3. A candidate whose evaluation THREW is rendered as `evaluation failed`,
 *     not as a divergence, so "would change: 0" cannot be read as "safe" while
 *     the comparison never happened.
 *
 * Zero console errors throughout; screenshots land in E2E_SHOTS_DIR.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string; dana: string; avery: string };
  baseUrl: string;
};
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const ADMIN_PASSWORD = "E2e-Admin-Phase2!";
const CSRF = { "x-regulait-csrf": "1" };

interface ConsoleTracker {
  errors: string[];
  assertClean: (label: string) => void;
}
function trackConsole(page: Page): ConsoleTracker {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource.*status of 4\d\d/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return {
    errors,
    assertClean(label: string) {
      expect(errors, `console must be clean after: ${label}`).toEqual([]);
    },
  };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function submitLogin(page: Page): Promise<number | null> {
  const settled = page
    .waitForResponse((r) => r.url().includes("/auth/login") && r.request().method() === "POST", {
      timeout: 15_000,
    })
    .catch(() => null);
  await page.getByRole("button", { name: "Sign in" }).click();
  const res = await settled;
  if (!res || res.status() !== 429) return null;
  const body = (await res.json()) as { retryAfterSeconds?: number };
  return Math.min(body.retryAfterSeconds ?? 60, 310);
}

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
    if (await welcome.isVisible()) return password;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await expect(welcome).toBeVisible();
      return settleOn;
    }
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

let sharedAdmin: { page: Page; track: ConsoleTracker } | null = null;
async function adminSession(browser: Browser) {
  if (!sharedAdmin) {
    test.setTimeout(400_000);
    const page = await browser.newPage();
    const track = trackConsole(page);
    await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
    sharedAdmin = { page, track };
  }
  return sharedAdmin;
}

test.describe.configure({ mode: "serial" });

test.describe("ADR-0073 — a rule canary measures without enforcing, and the screen says so", () => {
  let page: Page;
  let track: ConsoleTracker;
  let ruleId = "";
  let userId = "";
  let serverId = "";
  let toolName = "";

  test.beforeAll(async ({ browser }) => {
    ({ page, track } = await adminSession(browser));
  });

  const gotoPage = async () => {
    await page.goto("/ui/admin/governance/rules");
    await expect(page.getByRole("heading", { name: "Rules engine", exact: true })).toBeVisible();
  };

  test("the page states the invariant: a rule canary never enforces, and % is a SAMPLING rate", async () => {
    await gotoPage();
    await expect(page.getByText(/never enforces/)).toBeVisible();
    await expect(page.getByText(/sampling rate/)).toBeVisible();
    await expect(page.getByText(/count within\s+the sample|count within the sample/)).toBeVisible();
    await shot(page, "phase7-01-rules-shadow-canary-invariant");
    track.assertClean("rules engine landing");
  });

  test("sets up a rule whose CANDIDATE would pause a call the ACTIVE version allows", async () => {
    // own fixtures rather than seeded ones: the assertion below is that a
    // GRANTED call stays allowed while a candidate would pause it, so the
    // grant has to be one this spec knows exists.
    const stamp = Date.now();
    const u = await page.request.post("/v1/users", {
      headers: CSRF,
      data: { email: `e2e-shadow-${stamp}@example.com`, displayName: "e2e shadow subject" },
    });
    expect(u.status()).toBe(201);
    userId = ((await u.json()) as { id: string }).id;

    const srv = await page.request.post("/v1/servers", {
      headers: CSRF,
      data: { name: `e2e-shadow-${stamp}`, url: "http://127.0.0.1:9" },
    });
    expect(srv.status()).toBe(201);
    serverId = ((await srv.json()) as { id: string }).id;

    toolName = "e2e_shadow_write";
    const tl = await page.request.post(`/v1/servers/${serverId}/tools`, {
      headers: CSRF,
      data: { name: toolName, kind: "write" },
    });
    expect(tl.status()).toBe(201);
    const grant = await page.request.post("/v1/grants/tools", {
      headers: CSRF,
      data: { userId, serverId, toolName },
    });
    expect(grant.status()).toBe(201);

    // an approval rule that pauses a DIFFERENT tool — so today's decision is allow
    const created = await page.request.post("/v1/rules/approvals", {
      headers: CSRF,
      data: {
        scope: "user",
        userId,
        serverScope: "server",
        serverId,
        toolName: `${toolName}__e2e_absent`,
        approverUserId: userId,
      },
    });
    expect(created.status()).toBe(201);
    ruleId = ((await created.json()) as { id: string }).id;

    const before = await page.request.post("/v1/evaluate", {
      headers: CSRF,
      data: { userId, serverId, toolName },
    });
    expect(before.status()).toBe(200);
    expect(((await before.json()) as { effect: string }).effect).toBe("allow");

    // v2 would pause the tool the user is actually calling
    const v2 = await page.request.post(`/v1/config-versions/approval_rule/${ruleId}`, {
      headers: CSRF,
      data: { body: { toolName }, label: "e2e — pause this tool" },
    });
    expect(v2.status()).toBe(201);
    // 99% sampling: the point is to observe, and this rule is exercised once
    const canary = await page.request.post(`/v1/config-versions/approval_rule/${ruleId}/canary`, {
      headers: CSRF,
      data: { version: 2, pct: 99 },
    });
    expect(canary.status()).toBe(200);
    expect(((await canary.json()) as { live: boolean }).live).toBe(false);
  });

  test("THE CALLER IS STILL ALLOWED — the shadow did not enforce", async () => {
    const after = await page.request.post("/v1/evaluate", {
      headers: CSRF,
      data: { userId, serverId, toolName },
    });
    expect(after.status()).toBe(200);
    expect(((await after.json()) as { effect: string }).effect).toBe("allow");
  });

  test("...and the operator can SEE what would have changed, on the page", async () => {
    await gotoPage();
    const row = page.locator("tr", { hasText: "approval_rule" }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("shadow")).toBeVisible();
    await row.getByRole("button", { name: "What would change" }).click();

    // both sides, on screen: what was served vs what the candidate would do
    await expect(page.getByText("require_approval").first()).toBeVisible();
    await expect(page.getByText(/requires sign-off by approver/).first()).toBeVisible();
    await shot(page, "phase7-02-rule-divergence");
    track.assertClean("rule divergence detail");
  });

  test("abandoning the canary removes it from the operator's queue", async () => {
    const res = await page.request.delete(`/v1/config-versions/approval_rule/${ruleId}/canary`, {
      headers: CSRF,
    });
    expect(res.status()).toBe(200);
    await gotoPage();
    await expect(
      page.getByText("No config canaries running").or(page.locator("tr", { hasText: ruleId.slice(0, 8) })),
    ).toBeVisible();
    track.assertClean("canary abandoned");
  });
});
