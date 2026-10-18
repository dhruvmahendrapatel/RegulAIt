/**
 * ADR-0196 U4: route-level code splitting, on the production build. A screen's chunk that fails to load (a tab opened
 * before a gateway upgrade asks for an old hash; a dropped link) shows a recovery panel with Reload, never the
 * router's developer page with a stack trace; a slow chunk shows the loading fallback inside the shell.
 *
 * Not a ratchet check: these hold on every run, with no baseline.
 */
import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./mock-api";

// /admin/organization is in the admin-settings chunk (src/screens/admin-settings.ts); sign-in is in the auth chunk
const SETTINGS_CHUNK = /\/ui\/assets\/admin-settings-[\w-]+\.js$/;
const AUTH_CHUNK = /\/ui\/assets\/auth-[\w-]+\.js$/;

/** abort a chunk until the returned function is called */
async function failChunk(page: Page, chunk: RegExp) {
  let fail = true;
  await page.route(chunk, (route) => (fail ? route.abort("failed") : route.continue()));
  return () => {
    fail = false;
  };
}

async function expectNoDeveloperPage(page: Page) {
  const body = (await page.locator("body").innerText()) ?? "";
  expect(body).not.toContain("Unexpected Application Error");
  expect(body).not.toContain("Hey developer");
  expect(body).not.toContain("dynamically imported module");
  expect(body).not.toContain("/assets/");
}

test.describe("route chunks", () => {
  test("a chunk that fails on a direct load shows the recovery panel inside the shell, and Reload recovers", async ({ page }) => {
    await mockApi(page);
    const restore = await failChunk(page, SETTINGS_CHUNK);
    await page.goto("/ui/admin/organization");
    const alert = page.getByRole("alert").filter({ hasText: "This page failed to load" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(page.locator(".rg-skip-link")).toHaveCount(1);
    await expect(page.locator("#rgMain")).toContainText("This page failed to load");
    await expectNoDeveloperPage(page);

    restore();
    await alert.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "This page failed to load" })).toHaveCount(0);
    await expect(page.locator("#rgMain h1").first()).toBeVisible();
  });

  test("a chunk that fails on a client navigation shows the panel, and navigating away clears it", async ({ page }) => {
    await mockApi(page);
    await failChunk(page, SETTINGS_CHUNK);
    await page.goto("/ui/");
    await expect(page.locator("#rgMain h1").first()).toBeVisible();
    // a client-side navigation: the router reads the location on popstate, as it does for Back and Forward
    await page.evaluate(() => {
      history.pushState({ idx: 1, key: "probe", usr: null }, "", "/ui/admin/organization");
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    const alert = page.getByRole("alert").filter({ hasText: "This page failed to load" });
    await expect(alert).toBeVisible();
    await expect(page.locator(".rg-skip-link")).toHaveCount(1);
    await expectNoDeveloperPage(page);

    await page.goBack();
    await expect(page).toHaveURL(/\/ui\/$/);
    await expect(alert).toHaveCount(0);
    await expect(page.locator("#rgMain h1").first()).toBeVisible();
  });

  test("a chunk outside the shell (sign-in) shows the panel from the root route, not the developer page", async ({ page }) => {
    await mockApi(page, { signedOut: true });
    await failChunk(page, AUTH_CHUNK);
    await page.goto("/ui/login");
    const alert = page.getByRole("alert").filter({ hasText: "This page failed to load" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
    await expectNoDeveloperPage(page);
  });

  test("a slow chunk shows the fallback inside the shell, announced, with focus left alone", async ({ page }) => {
    await mockApi(page);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(SETTINGS_CHUNK, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/ui/admin/organization", { waitUntil: "domcontentloaded" });
    const region = page.getByTestId("route-loading");
    await expect(region).toHaveText("Loading page");
    await expect(region).toHaveAttribute("aria-live", "polite");
    await expect(page.locator(".rg-skip-link")).toHaveCount(1);
    await expect(page.locator("#rgMain [role=status], #rgMain [aria-busy=true]")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

    release();
    await expect(page.locator("#rgMain h1").first()).toBeVisible();
    await expect(region).toHaveText("");
  });
});
