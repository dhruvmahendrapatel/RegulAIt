/**
 * Codex review cards UIS-01, UIS-02, UIS-03, UIS-07 and UIS-09 (narrow part), against a mocked gateway:
 *  - UIS-01: at phone width the closed drawer is inert, so Tab never lands in it; Escape closes the open drawer and
 *    focus returns to the hamburger;
 *  - UIS-02: a Field error is announced through the control's aria-describedby, and the control is aria-invalid;
 *  - UIS-03: Ctrl-K inside an open Modal does not open the command palette behind it;
 *  - UIS-07: the topbar theme icon follows a `data-theme` change made by another writer;
 *  - UIS-09: a Modal whose save is in flight ignores Escape and keeps its Cancel disabled.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ME = { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
const SERVER = { id: "s1", name: "Fixture server", url: "https://mcp.example.test/mcp", transport: "streamable_http", enabled: true, stdio: null, stdioCommandDigest: null, admissionState: "admitted", ownerUserId: null, ownership: "unowned" };

async function mockGateway(page: Page, opts: { hangPatch?: boolean } = {}) {
  const patches: string[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (p === "/auth/sessions") return json(route, { sessions: [] });
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    if (req.method() === "PATCH" && p === "/v1/servers/s1") {
      patches.push(p);
      if (opts.hangPatch) return; // never answered: the save stays in flight
      return json(route, SERVER);
    }
    if (p === "/v1/servers") return json(route, { servers: [SERVER] });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/org/settings") return json(route, { settings: { literacyGateMode: "enforce", literacyDefaultValidityDays: 365, mcpProtocolMethods: [], mcpUpstreamTransports: ["streamable_http"] } });
    return json(route, {});
  });
  return { patches };
}

test.describe("UIS-01: the phone drawer", () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test("closed, Tab never lands in the rail; Escape closes it open and focus returns to the hamburger", async ({ page }) => {
    await mockGateway(page);
    await page.goto("/ui/");
    const rail = page.getByTestId("nav-rail");
    const hamburger = page.getByRole("button", { name: "Toggle navigation" });
    await expect(hamburger).toBeVisible();
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    await expect(rail).toHaveAttribute("inert", "");

    const inRail = () => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="nav-rail"]')));
    await page.locator("body").click({ position: { x: 300, y: 700 } });
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      expect(await inRail(), `Tab ${i + 1} landed in the closed rail`).toBe(false);
    }

    await hamburger.click();
    await expect(hamburger).toHaveAttribute("aria-expanded", "true");
    await expect(rail).not.toHaveAttribute("inert", "");
    // the open drawer is reachable: focus a link inside it, then Escape
    await rail.getByRole("link", { name: "Home" }).focus();
    expect(await inRail()).toBe(true);
    await page.keyboard.press("Escape");
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    await expect(hamburger).toBeFocused();
    await expect(rail).toHaveAttribute("inert", "");
  });

  test("choosing a route closes the drawer and focus returns to the hamburger", async ({ page }) => {
    await mockGateway(page);
    await page.goto("/ui/");
    const rail = page.getByTestId("nav-rail");
    const hamburger = page.getByRole("button", { name: "Toggle navigation" });
    await hamburger.click();
    const link = rail.getByRole("link", { name: "Home" });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    await expect(hamburger).toBeFocused();
    await expect(rail).toHaveAttribute("inert", "");
  });
});

test("UIS-01: on a desktop the rail is never inert and keyboard focus still opens it (ADR-0169)", async ({ page }) => {
  await mockGateway(page);
  await page.goto("/ui/");
  const rail = page.getByTestId("nav-rail");
  await expect(rail).not.toHaveAttribute("inert", "");
  await page.getByRole("link", { name: "Skip to main content" }).focus();
  await page.keyboard.press("Tab");
  await expect(rail).toHaveAttribute("data-expanded", "true");
});

test("UIS-02: a Field error is announced through aria-describedby and aria-invalid", async ({ page }) => {
  await mockGateway(page);
  await page.goto("/ui/admin/governance/literacy");
  const days = page.getByLabel("Default validity (days, 30 to 730)");
  await expect(days).toHaveValue("365");
  await expect(days).not.toHaveAttribute("aria-invalid", "true");
  await days.fill("5");
  await expect(days).toHaveAttribute("aria-invalid", "true");
  await expect(days).toHaveAccessibleDescription("30 to 730 days");
  await days.fill("90");
  await expect(days).not.toHaveAttribute("aria-invalid", "true");
  await expect(days).toHaveAccessibleDescription("");
});

test("UIS-03: Ctrl-K inside an open Modal does not open the palette behind it", async ({ page }) => {
  await mockGateway(page);
  await page.goto("/ui/admin/mcp-servers");
  await page.getByRole("button", { name: "Edit MCP server Fixture server" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit MCP server “Fixture server”" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").focus();
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search" })).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
  // with the Modal closed, the shortcut works as before
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // from the topbar: the row's action buttons sit in a span that stops key events (LifecycleActions), out of scope here
  await page.getByRole("button", { name: "Search", exact: true }).focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
});

test("UIS-07: the topbar theme icon follows a data-theme change from another writer", async ({ page }) => {
  await mockGateway(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/ui/");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect(page.getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
  // what the Appearance card (theme/mode.ts) or an account appearance load does
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
  // "Match my device": the attribute is removed and the OS decides
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await expect(page.getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
});

test("UIS-09: a Modal whose save is in flight ignores Escape and keeps Cancel disabled", async ({ page }) => {
  const cap = await mockGateway(page, { hangPatch: true });
  await page.goto("/ui/admin/mcp-servers");
  await page.getByRole("button", { name: "Edit MCP server Fixture server" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit MCP server “Fixture server”" });
  await dialog.getByLabel("Name").fill("Renamed server");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => cap.patches.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("Renamed server");
  // busy wins over dirty: no discard prompt while the save is in flight
  await expect(page.getByRole("dialog", { name: "Discard changes?" })).toHaveCount(0);
});

test.describe("UIS-09: unsaved changes ask before the dialog closes (owner, 2026-11-22)", () => {
  const open = async (page: Page) => {
    await mockGateway(page);
    await page.goto("/ui/admin/mcp-servers");
    await page.getByRole("button", { name: "Edit MCP server Fixture server" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit MCP server “Fixture server”" });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const prompt = (page: Page) => page.getByRole("dialog", { name: "Discard changes?" });

  test("dirty: Escape asks; Keep editing (focused by default) keeps the draft", async ({ page }) => {
    const dialog = await open(page);
    await dialog.getByLabel("Name").fill("Renamed server");
    await page.keyboard.press("Escape");
    await expect(prompt(page)).toBeVisible();
    const keep = prompt(page).getByRole("button", { name: "Keep editing" });
    await expect(keep).toBeFocused();
    await keep.click();
    await expect(prompt(page)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveValue("Renamed server");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  });

  test("dirty: Discard closes the dialog", async ({ page }) => {
    const dialog = await open(page);
    await dialog.getByLabel("Name").fill("Renamed server");
    await page.keyboard.press("Escape");
    await prompt(page).getByRole("button", { name: "Discard" }).click();
    await expect(prompt(page)).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
  });

  test("clean: Escape closes at once, with no prompt", async ({ page }) => {
    const dialog = await open(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(prompt(page)).toHaveCount(0);
  });
});
