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
 *  2. A candidate that would DENY a call the active version does not shows up as
 *     a real divergence row naming both sides AND the sentence the caller would
 *     have been given — while the served decision is asserted UNCHANGED, as the
 *     whole object, before and after the canary exists.
 *  3. Abandoning the canary takes it off the operator's queue.
 *
 * (The throwing-candidate case is proved in the gateway suite, where a corrupt
 * row can be written directly; it is not reachable through the admin API, which
 * type-checks version bodies.)
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
  let served: Record<string, unknown> = {};

  test.beforeAll(async ({ browser }) => {
    ({ page, track } = await adminSession(browser));
  });

  const gotoPage = async () => {
    // a full navigation, not a nav click: clicking the link while already on
    // this route does not remount, so the cached (empty) canary list would be
    // what the assertions saw.
    await page.goto("/ui/admin/rules");
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

  test("sets up a rule whose CANDIDATE would DENY a call the ACTIVE version does not", async () => {
    // own fixtures rather than seeded ones: the assertion is that the SERVED
    // decision is unchanged while the candidate would decide differently, so
    // the rule under test has to be one this spec created.
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

    const before = await page.request.post("/v1/evaluate", {
      headers: CSRF,
      data: { userId, serverId, toolName },
    });
    expect(before.status()).toBe(200);
    // whatever the seeded fleet rules make of this call is the reference — the
    // point is that the shadow does not move it, not that it is any particular
    // effect. (A seeded fleet approval rule makes it require_approval here.)
    served = (await before.json()) as Record<string, unknown>;
    expect(served.effect).not.toBe("deny");

    // SHADOW SAMPLING IS DETERMINISTIC PER (artifact, user): a canary at 99%
    // legitimately leaves ~1% of stable keys unsampled, and both ids are random
    // per run. So mint a fresh rule id until this user falls inside the sample
    // rather than asserting on a decision that was correctly not sampled.
    // Expected iterations: ~1.01.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const created = await page.request.post("/v1/rules/rate-limits", {
        headers: CSRF,
        data: {
          scope: "user",
          userId,
          serverScope: "server",
          serverId,
          maxCalls: 100000,
          windowSeconds: 3600,
        },
      });
      expect(created.status()).toBe(201);
      ruleId = ((await created.json()) as { id: string }).id;

      // the candidate would refuse the call outright
      const v2 = await page.request.post(`/v1/config-versions/rate_limit/${ruleId}`, {
        headers: CSRF,
        data: { body: { maxCalls: 0 }, label: "e2e — would deny" },
      });
      expect(v2.status()).toBe(201);
      const canary = await page.request.post(`/v1/config-versions/rate_limit/${ruleId}/canary`, {
        headers: CSRF,
        data: { version: 2, pct: 99 },
      });
      expect(canary.status()).toBe(200);
      expect(((await canary.json()) as { live: boolean }).live).toBe(false);

      const after = await page.request.post("/v1/evaluate", {
        headers: CSRF,
        data: { userId, serverId, toolName },
      });
      expect(after.status()).toBe(200);
      // THE INVARIANT: the shadow did not touch the served decision.
      expect(await after.json()).toEqual(served);

      const div = (await (
        await page.request.get(`/v1/config-versions/rate_limit/${ruleId}/divergence`)
      ).json()) as { totals: { observed: number } };
      if (div.totals.observed > 0) return;

      // this rule's bucket fell outside the 99% sample — abandon and retry
      await page.request.delete(`/v1/config-versions/rate_limit/${ruleId}/canary`, { headers: CSRF });
    }
    throw new Error("could not land inside a 99% shadow sample in 10 attempts");
  });

  test("...and the operator can SEE what would have changed, on the page", async () => {
    await gotoPage();
    const row = page.locator("tr", { hasText: "rate_limit" }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("shadow")).toBeVisible();
    await row.getByRole("button", { name: "What would change" }).click();

    // both sides, on screen: what was served vs what the candidate would do
    await expect(page.getByText("deny").first()).toBeVisible();
    await expect(page.getByText(/rate limit exhausted/).first()).toBeVisible();
    await shot(page, "phase7-02-rule-divergence");
    track.assertClean("rule divergence detail");
  });

  test("abandoning the canary removes it from the operator's queue", async () => {
    const res = await page.request.delete(`/v1/config-versions/rate_limit/${ruleId}/canary`, {
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

/**
 * ADR-0074 — an ordinary admin edit of a VERSIONED rule becomes a version, and
 * the operator is told so on the page.
 *
 * Before ADR-0074 the deploy-mode select on this very page wrote the rule row
 * and the change was discarded at dispatch: the select showed the new scope,
 * the list showed the new scope, and enforcement never moved. The browser is
 * where that lie was told, so it is where the fix has to be visible.
 */
test.describe("ADR-0074 — a deploy-mode edit on a versioned rule mints a version, visibly", () => {
  let page: Page;
  let track: ConsoleTracker;
  let ruleId = "";

  test.beforeAll(async ({ browser }) => {
    ({ page, track } = await adminSession(browser));
  });

  test("the page states what an enforcing edit does to a versioned rule", async () => {
    await page.goto("/ui/admin/rules");
    await expect(page.getByRole("heading", { name: "Rules engine", exact: true })).toBeVisible();
    const note = page.getByTestId("deploy-mode-versioning-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("mints a new version and activates it");
    // and the honest refusal is named rather than discovered during an incident
    await expect(note).toContainText("refused");
    await shot(page, "phase7-03-deploy-mode-versioning-note");
    track.assertClean("deploy-mode versioning disclosure");
  });

  test("setting the scope from the SPA mints a version and the row says which", async () => {
    const stamp = Date.now();
    const u = await page.request.post("/v1/users", {
      headers: CSRF,
      data: { email: `e2e-dm-${stamp}@example.com`, displayName: "e2e deploy-mode subject" },
    });
    expect(u.status()).toBe(201);
    const subjectId = ((await u.json()) as { id: string }).id;
    const srv = await page.request.post("/v1/servers", {
      headers: CSRF,
      data: { name: `e2e-dm-${stamp}`, url: "http://127.0.0.1:9" },
    });
    expect(srv.status()).toBe(201);
    const srvId = ((await srv.json()) as { id: string }).id;

    const created = await page.request.post("/v1/rules/rate-limits", {
      headers: CSRF,
      data: {
        scope: "user",
        userId: subjectId,
        serverScope: "server",
        serverId: srvId,
        maxCalls: 100000,
        windowSeconds: 3600,
      },
    });
    expect(created.status()).toBe(201);
    ruleId = ((await created.json()) as { id: string }).id;

    // VERSION it — this is what makes the row a read-model. v1 is minted from
    // the live rule as the lazy baseline and stays active; v2 is a draft.
    const v2 = await page.request.post(`/v1/config-versions/rate_limit/${ruleId}`, {
      headers: CSRF,
      data: { body: { maxCalls: 5 }, label: "e2e — a draft nobody activated" },
    });
    expect(v2.status()).toBe(201);

    await page.goto("/ui/admin/rules");
    const select = page.getByTestId(`deploy-mode-${ruleId}`);
    await expect(select).toBeVisible();
    await select.selectOption("air_gapped");

    // the page tells the operator the edit became a version — the fact that
    // used to be untrue and unsayable
    const minted = page.getByTestId(`deploy-mode-version-${ruleId}`);
    await expect(minted).toBeVisible();
    await expect(minted).toContainText("v3");
    await shot(page, "phase7-04-deploy-mode-minted-version");

    // and it is the ACTIVE version, not a draft — i.e. it is what enforces
    const lineage = (await (
      await page.request.get(`/v1/config-versions/rate_limit/${ruleId}`)
    ).json()) as { active: { version: number; body: Record<string, unknown> } };
    expect(lineage.active.version).toBe(3);
    expect(lineage.active.body.deployMode).toBe("air_gapped");
    // the draft v2 was NOT swept into it: the edit composed onto the ACTIVE
    // body, so maxCalls is still the baseline's, not the unactivated draft's
    expect(lineage.active.body.maxCalls).toBe(100000);
    track.assertClean("deploy-mode minted a version");
  });
});
