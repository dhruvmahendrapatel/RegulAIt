/**
 * ADR-0218 (themes phase 2), against a mocked gateway:
 *
 *  - the Appearance card saves the palette and mode to the account (PUT /auth/appearance, with the CSRF header), and the
 *    account's palette is painted on a fresh browser that has nothing stored;
 *  - a locked organisation offers only its default and High contrast, and High contrast can still be saved;
 *  - a refused save is shown inline and the page goes back to the palette it had;
 *  - Settings › Organisation › Themes saves the default and the lock through PUT /v1/org/settings.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const AVERY = { id: "avery", email: "avery@example.test", displayName: "Avery Approver" };

interface Org {
  defaultPalette: string;
  locked: boolean;
}
interface Saved {
  palette: string | null;
  mode: "light" | "dark" | "system" | null;
}

const allowed = (p: string, org: Org) => !org.locked || p === org.defaultPalette || p === "contrast";
const effective = (s: Saved, org: Org) => (s.palette && allowed(s.palette, org) ? s.palette : org.defaultPalette);

/** a tiny stand-in for the gateway: one account, one organisation, and every write it received */
function mockGateway(page: Page, opts: { org: Org; saved?: Saved; isAdmin?: boolean }) {
  const state = { org: { ...opts.org }, saved: { ...(opts.saved ?? { palette: null, mode: null }) } };
  const writes: Array<{ path: string; body: Record<string, unknown>; csrf: string | null }> = [];
  const appearance = () => ({
    palette: state.saved.palette,
    mode: state.saved.mode,
    effectivePalette: effective(state.saved, state.org),
    org: { ...state.org },
    saved: true,
  });
  void page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (req.method() !== "GET") {
      writes.push({ path: p, body: (req.postDataJSON() ?? {}) as Record<string, unknown>, csrf: req.headers()["x-regulait-csrf"] ?? null });
    }
    if (p === "/auth/me")
      return json(route, {
        userId: AVERY.id,
        isAdmin: opts.isAdmin === true,
        via: "session",
        user: AVERY,
        mustChangePassword: false,
        totpEnabled: true,
        passwordSet: true,
        appearance: appearance(),
      });
    if (p === "/auth/appearance" && req.method() === "PUT") {
      const body = req.postDataJSON() as Partial<Saved>;
      if (body.palette && !allowed(body.palette, state.org))
        return json(route, { error: "palette_locked", detail: "Your organisation has set the theme for everyone." }, 409);
      if (body.palette !== undefined) state.saved.palette = body.palette;
      if (body.mode !== undefined) state.saved.mode = body.mode;
      return json(route, { appearance: appearance() });
    }
    if (p === "/v1/org/settings" && req.method() === "PUT") {
      const body = req.postDataJSON() as { themeDefaultPalette?: string; themeLocked?: boolean };
      if (body.themeDefaultPalette) state.org.defaultPalette = body.themeDefaultPalette;
      if (body.themeLocked !== undefined) state.org.locked = body.themeLocked;
    }
    if (p === "/v1/org/settings")
      return json(route, { settings: { themeDefaultPalette: state.org.defaultPalette, themeLocked: state.org.locked } });
    if (p === "/v1/me") return json(route, { userId: AVERY.id, isAdmin: opts.isAdmin === true, user: AVERY });
    if (p === "/auth/sessions") return json(route, { sessions: [] });
    if (p === "/v1/me/ai-literacy")
      return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    return json(route, {});
  });
  return { state, writes };
}

const themes = (page: Page) => page.getByRole("group", { name: "Theme" });
const radio = (page: Page, name: string) => themes(page).getByRole("radio", { name: new RegExp(`^${name}`) });

test("the account save persists: the palette and mode follow the person to a fresh browser", async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const gw = mockGateway(page, { org: { defaultPalette: "aurora", locked: false } });
  await page.goto("/ui/account?section=appearance");
  await expect(page.getByTestId("appearance-lead")).toHaveText(/saved to your account/);
  for (const name of ["Aurora", "Harbor", "Evergreen", "Graphite", "Orchid", "High contrast"]) await expect(radio(page, name)).toBeVisible();

  await radio(page, "Evergreen").check();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "evergreen");
  await page.getByRole("group", { name: "Mode" }).getByRole("radio", { name: "Dark" }).check();
  await expect.poll(() => gw.state.saved).toEqual({ palette: "evergreen", mode: "dark" });
  const saves = gw.writes.filter((w) => w.path === "/auth/appearance");
  expect(saves.map((w) => w.body)).toEqual([{ palette: "evergreen" }, { mode: "dark" }]);
  for (const w of saves) expect(w.csrf).toBe("1");

  // a second browser with nothing stored paints the account's palette and mode
  const fresh = await browser.newContext({ reducedMotion: "reduce" });
  const other = await fresh.newPage();
  const gw2 = mockGateway(other, { org: { defaultPalette: "aurora", locked: false }, saved: gw.state.saved });
  await other.goto("/ui/account?section=appearance");
  await expect(other.locator("html")).toHaveAttribute("data-palette", "evergreen");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(radio(other, "Evergreen")).toBeChecked();
  // and keeps it as the pre-paint copy for the next visit
  expect(await other.evaluate(() => localStorage.getItem("regulait.palette"))).toBe("evergreen");
  expect(gw2.writes).toEqual([]);
  await fresh.close();
});

test("a locked organisation shows only its default and High contrast, and High contrast can still be saved", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  // Avery chose Orchid before the lock; the lock wins on screen
  const gw = mockGateway(page, { org: { defaultPalette: "harbor", locked: true }, saved: { palette: "orchid", mode: null } });
  await page.addInitScript(() => localStorage.setItem("regulait.palette", "orchid"));
  await page.goto("/ui/account?section=appearance");
  await expect(page.getByTestId("appearance-locked")).toHaveText(/set the theme for everyone\. High contrast is always available/);
  await expect(themes(page).getByRole("radio")).toHaveCount(2);
  await expect(radio(page, "Harbor")).toBeVisible();
  await expect(radio(page, "High contrast")).toBeVisible();
  for (const name of ["Aurora", "Evergreen", "Graphite", "Orchid"]) await expect(radio(page, name)).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "harbor");
  await expect(radio(page, "Harbor")).toBeChecked();

  await radio(page, "High contrast").check();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "contrast");
  await expect.poll(() => gw.state.saved.palette).toBe("contrast");
  await expect(page.getByTestId("appearance-error")).toHaveCount(0);
});

test("a refused save is shown inline and the page goes back to the palette it had", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const gw = mockGateway(page, { org: { defaultPalette: "aurora", locked: false } });
  await page.goto("/ui/account?section=appearance");
  await expect(radio(page, "Aurora")).toBeChecked();
  // the admin locks the theme in another tab; this page still offers every palette until it reloads
  gw.state.org = { defaultPalette: "aurora", locked: true };
  // click, not check(): the radio is meant to fall back unchecked
  await themes(page).locator("label").filter({ hasText: "Graphite" }).click();
  await expect(page.getByTestId("appearance-error")).toHaveText(/set the theme for everyone.*High contrast/);
  await expect(page.getByTestId("appearance-error")).toHaveAttribute("role", "alert");
  await expect(radio(page, "Aurora")).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-palette", /./);
});

test("Settings › Organisation › Themes saves the default and the lock", async ({ page }) => {
  const gw = mockGateway(page, { org: { defaultPalette: "aurora", locked: false }, isAdmin: true });
  await page.goto("/ui/admin/organization");
  const card = page.getByTestId("org-themes");
  await expect(card).toBeVisible();
  await card.getByLabel("Organisation default theme").selectOption("evergreen");
  await card.getByLabel("Who chooses the theme").selectOption("true");
  await card.getByRole("button", { name: "Save theme settings" }).click();
  await expect.poll(() => gw.state.org).toEqual({ defaultPalette: "evergreen", locked: true });
  const put = gw.writes.find((w) => w.path === "/v1/org/settings");
  expect(put?.body).toEqual({ themeDefaultPalette: "evergreen", themeLocked: true });
  expect(put?.csrf).toBe("1");
  // the admin's own console repaints under the new default
  await expect(page.locator("html")).toHaveAttribute("data-palette", "evergreen");
});
