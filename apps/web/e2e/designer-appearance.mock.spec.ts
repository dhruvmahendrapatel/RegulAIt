/**
 * T1 Phase 1 (owner decision on #453, 2026-10-21): the Account page's Appearance card, against a mocked gateway.
 *
 *  - six palettes and Light / Dark / Match my device, as real radios;
 *  - picking a palette repaints the interactive colour and the choice survives a reload (this browser only);
 *  - no palette re-colours the risk scale;
 *  - Match my device clears the stored mode and follows the OS;
 *  - Aurora is the default and loads no extra stylesheet;
 *  - axe (WCAG 2.x A/AA) over the card in every palette, light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ADA = { id: "ada", email: "ada@example.test", displayName: "Ada Admin" };

async function mockApi(page: Page) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me")
      return json(route, { userId: ADA.id, isAdmin: true, via: "session", user: ADA, mustChangePassword: false, totpEnabled: true, passwordSet: true });
    if (p === "/v1/me") return json(route, { userId: ADA.id, isAdmin: true, user: ADA });
    if (p === "/auth/sessions") return json(route, { sessions: [] });
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    return json(route, {});
  });
}

const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const card = (page: Page) => page.locator("section[data-rg-card]").filter({ has: page.getByRole("group", { name: "Theme" }) });

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test("Appearance: six palettes repaint the interactive colour, are remembered, and never touch the risk scale", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/ui/account?section=appearance");
  const themes = page.getByRole("group", { name: "Theme" });
  for (const name of ["Aurora", "Harbor", "Evergreen", "Graphite", "Orchid", "High contrast"])
    await expect(themes.getByRole("radio", { name: new RegExp(`^${name}`) })).toBeVisible();
  // Aurora by default, with no palette attribute and no extra sheet
  await expect(themes.getByRole("radio", { name: /^Aurora/ })).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-palette", /./);
  const critical = await token(page, "--rg-critical");
  expect(await token(page, "--rg-signal-700")).toBe("#005c70");

  await themes.getByRole("radio", { name: /^Harbor/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "harbor");
  expect(await token(page, "--rg-signal-700")).toBe("#1a46c2");
  expect(await token(page, "--rg-critical")).toBe(critical);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "harbor");
  await expect(page.getByRole("group", { name: "Theme" }).getByRole("radio", { name: /^Harbor/ })).toBeChecked();
  expect(await token(page, "--rg-signal-700")).toBe("#1a46c2");

  // back to the default clears the stored choice
  await page.getByRole("group", { name: "Theme" }).getByRole("radio", { name: /^Aurora/ }).check();
  await expect(page.locator("html")).not.toHaveAttribute("data-palette", /./);
  expect(await page.evaluate(() => localStorage.getItem("regulait.palette"))).toBeNull();
});

test("Appearance: dark values apply both for an explicit Dark and for a dark device", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/ui/account?section=appearance");
  const modes = page.getByRole("group", { name: "Mode" });
  await expect(modes.getByRole("radio", { name: "Match my device" })).toBeChecked();
  await page.getByRole("group", { name: "Theme" }).getByRole("radio", { name: /^Orchid/ }).check();
  // system dark (no data-theme): the palette's dark link colour, not its light one
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  await expect.poll(() => token(page, "--rg-signal-700")).toBe("#d8b4fe");

  await modes.getByRole("radio", { name: "Light" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await token(page, "--rg-signal-700")).toBe("#7e22ce");
  await modes.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await token(page, "--rg-signal-700")).toBe("#d8b4fe");

  // the swatches preview each palette's dark look in dark mode: Harbor's dot is its dark link colour
  const harborDot = page.locator('[data-swatch="harbor"] > span');
  await expect.poll(() => harborDot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(147, 197, 253)");

  // Match my device clears the stored mode
  await modes.getByRole("radio", { name: "Match my device" }).check();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  expect(await page.evaluate(() => localStorage.getItem("regulait.theme"))).toBeNull();
});

test("Appearance: the card passes axe in every palette, light and dark", async ({ page }) => {
  await page.goto("/ui/account?section=appearance");
  for (const name of ["Aurora", "Harbor", "Evergreen", "Graphite", "Orchid", "High contrast"]) {
    await page.getByRole("group", { name: "Theme" }).getByRole("radio", { name: new RegExp(`^${name}`) }).check();
    for (const mode of ["Light", "Dark"]) {
      await page.getByRole("group", { name: "Mode" }).getByRole("radio", { name: mode }).check();
      await expect(card(page)).toBeVisible();
      const result = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(result.violations.map((v) => `${name}/${mode}: ${v.id}`)).toEqual([]);
    }
  }
});

test("Account ?section= links land with the section title below the sticky topbar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  for (const section of ["appearance", "password", "keys"]) {
    await page.goto(`/ui/account?section=${section}`);
    await page.waitForTimeout(400);
    const topbar = await page.locator("header").first().boundingBox();
    const title = await page.evaluate((s) => {
      const heading = s === "appearance" ? "Appearance" : s === "password" ? "Password" : null;
      const cards = [...document.querySelectorAll("section[data-rg-card]")];
      const card = heading ? cards.find((c) => c.textContent?.trimStart().startsWith(heading)) : cards.find((c) => /model keys/i.test(c.textContent ?? ""));
      return card?.getBoundingClientRect().top ?? null;
    }, section);
    expect(title, section).not.toBeNull();
    expect(title!, section).toBeGreaterThanOrEqual(topbar!.y + topbar!.height);
  }
});

