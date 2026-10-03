/**
 * ADR-0169 — the shaded theme and the auto-hiding navigation rail, from the
 * browser's side against a mocked gateway (the same harness as the other
 * *.mock.spec.ts files: every /v1 and /auth call is answered in-test).
 *
 *  - the rail is a slim icon strip by default, and every destination keeps its
 *    accessible name while it is collapsed;
 *  - a resting pointer opens it OVER the content and leaving closes it;
 *  - keyboard focus opens it and the content makes room; Escape closes it;
 *  - choosing a destination closes it, so it never sits over the next click;
 *  - the pin keeps today's full rail, survives a reload, and still works when
 *    storage is unavailable;
 *  - the phone drawer is unchanged;
 *  - the shaded field keeps canvas text at WCAG AA at its WORST point, measured
 *    from rendered pixels in both themes;
 *  - axe (WCAG 2.x A/AA) over collapsed, open and pinned, in both themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const useCases = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Credit-limit-increase assistant", description: "Recommends credit-limit increases.", status: "under_review", euAiActTier: "high", ownerUserId: "u", ownerName: "Avery Admin", createdAt: "2026-10-01T09:00:00Z", decidedAt: null, approvedUntil: null, openConditions: 0, complianceTags: [], workflowInstanceId: "i" },
  { id: "22222222-1111-4111-8111-111111111111", name: "Support ticket summarizer", description: "Summarizes inbound tickets.", status: "approved", euAiActTier: "minimal", ownerUserId: "u", ownerName: "Avery Admin", createdAt: "2026-08-12T09:00:00Z", decidedAt: "2026-08-20T09:00:00Z", approvedUntil: "2027-08-20T09:00:00Z", openConditions: 0, complianceTags: [], workflowInstanceId: "j" },
];

async function mockApi(page: Page) {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "u", isAdmin: true, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } });
    if (p === "/v1/use-cases") return json(route, { useCases });
    if (p === "/v1/approvals") return json(route, { approvals: [] });
    return json(route, {});
  });
}

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

const rail = (page: Page) => page.getByRole("complementary", { name: "Primary navigation" });
const railWidth = async (page: Page) => (await rail(page).boundingBox())!.width;
const mainX = async (page: Page) => (await page.locator("#rgMain").boundingBox())!.x;

async function openRegistry(page: Page) {
  await mockApi(page);
  await page.goto("/ui/admin/use-cases");
  await expect(page.getByRole("heading", { level: 1, name: "AI registry" })).toBeVisible();
}

test.describe("ADR-0169: the auto-hiding rail", () => {
  test("collapsed by default to an icon strip; every destination keeps its accessible name", async ({ page }) => {
    await openRegistry(page);
    const nav = rail(page);
    await expect(nav).toHaveAttribute("data-expanded", "false");
    expect(await railWidth(page)).toBeLessThanOrEqual(64);
    expect(await mainX(page)).toBeLessThanOrEqual(64);
    // the names a screen reader (and every nav spec) relies on are still there
    for (const label of ["Home", "Posture", "Trust & evidence", "Use cases", "AI intake", "Risks"]) {
      const link = nav.getByRole("link", { name: label, exact: true });
      await expect(link, `${label} stays reachable in the strip`).toBeVisible();
      expect((await link.boundingBox())!.width, `${label} fits the strip`).toBeLessThanOrEqual(56);
    }
    await expect(nav.getByRole("link", { name: "Use cases", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByLabel("Filter navigation")).toBeVisible();
    await expect(nav.getByLabel("Switch suite")).toHaveValue("ai-governance");
    await expect(nav.getByRole("button", { name: "Pin navigation" })).toHaveAttribute("aria-pressed", "false");
    await expectAxeClean(page, "registry, rail collapsed");
  });

  test("a resting pointer opens it over the content; leaving closes it", async ({ page }) => {
    await openRegistry(page);
    const before = await mainX(page);
    await rail(page).getByRole("link", { name: "Risks", exact: true }).hover();
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    await expect.poll(() => railWidth(page)).toBeGreaterThanOrEqual(240);
    // overlay: the content did not move
    expect(await mainX(page)).toBe(before);
    await expect(rail(page).getByText("Shadow-AI discovery", { exact: true })).toBeVisible();
    await page.mouse.move(900, 600);
    await expect(rail(page)).toHaveAttribute("data-expanded", "false");
    expect(await railWidth(page)).toBeLessThanOrEqual(64);
  });

  test("keyboard focus opens it and the content makes room; Enter navigates and closes; Escape closes", async ({ page }) => {
    await openRegistry(page);
    await page.keyboard.press("Tab"); // the skip link
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Tab"); // first stop inside the rail
    await expect(rail(page).getByLabel("Filter navigation")).toBeFocused();
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    await expect.poll(() => mainX(page)).toBeGreaterThanOrEqual(240);
    // every destination is reachable by Tab alone
    let reached = false;
    for (let i = 0; i < 20 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await rail(page).getByRole("link", { name: "Risks", exact: true }).evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab reaches Risks").toBe(true);
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/ui\/admin\/risks$/);
    await expect(rail(page)).toHaveAttribute("data-expanded", "false");
    expect(await mainX(page)).toBeLessThanOrEqual(64);
    // back in, then Escape
    await page.keyboard.press("Shift+Tab");
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(rail(page)).toHaveAttribute("data-expanded", "false");
  });

  test('"/" opens it at the filter; the filter finds destinations across suites', async ({ page }) => {
    await openRegistry(page);
    await page.keyboard.press("/");
    await expect(rail(page).getByLabel("Filter navigation")).toBeFocused();
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    await page.keyboard.type("Audit log");
    await expect(rail(page).getByText("Approvals & Audit", { exact: true })).toBeVisible();
    await expectAxeClean(page, "registry, rail open by keyboard with a filter");
    await rail(page).getByRole("link", { name: "Audit log", exact: true }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/audit$/);
    await expect(rail(page)).toHaveAttribute("data-expanded", "false");
  });

  test("a chosen destination never leaves the panel over the next click", async ({ page }) => {
    await openRegistry(page);
    await rail(page).getByRole("link", { name: "Use cases", exact: true }).hover();
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    await rail(page).getByRole("link", { name: "AI intake", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Register AI use case" })).toBeVisible();
    await expect(rail(page)).toHaveAttribute("data-expanded", "false");
    // the pointer is still over the strip, and resting there does not re-open it
    await page.waitForTimeout(400);
    await expect(rail(page)).toHaveAttribute("data-expanded", "false");
    // the first field sits right of the strip and takes a real click
    await page.getByLabel("Use-case name").click();
    await expect(page.getByLabel("Use-case name")).toBeFocused();
  });

  test("the pin keeps the full rail, survives a reload, and unpins", async ({ page }) => {
    await openRegistry(page);
    const pin = rail(page).getByRole("button", { name: "Pin navigation" });
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(900, 600);
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    expect(await railWidth(page)).toBeGreaterThanOrEqual(220);
    expect(await mainX(page)).toBeGreaterThanOrEqual(220);
    expect(await page.evaluate(() => localStorage.getItem("regulait.rail.pinned"))).toBe("1");
    await expectAxeClean(page, "registry, rail pinned");

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "AI registry" })).toBeVisible();
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    await expect(rail(page).getByRole("button", { name: "Pin navigation" })).toHaveAttribute("aria-pressed", "true");
    expect(await mainX(page)).toBeGreaterThanOrEqual(220);

    // unpin by keyboard: the button is reachable and announces its state
    await rail(page).getByRole("button", { name: "Pin navigation" }).focus();
    await page.keyboard.press("Enter");
    await expect(rail(page).getByRole("button", { name: "Pin navigation" })).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    await expect(rail(page)).toHaveAttribute("data-expanded", "false");
    expect(await page.evaluate(() => localStorage.getItem("regulait.rail.pinned"))).toBe("0");
  });

  test("with storage unavailable the rail defaults to auto-hide and the pin still works", async ({ page }) => {
    await page.addInitScript(() => {
      const deny = () => {
        throw new DOMException("blocked", "SecurityError");
      };
      Object.defineProperty(window, "localStorage", { configurable: true, get: deny });
    });
    await openRegistry(page);
    await expect(rail(page)).toHaveAttribute("data-expanded", "false");
    await rail(page).getByRole("button", { name: "Pin navigation" }).click();
    await page.mouse.move(900, 600);
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
  });

  test("phone width: the drawer is unchanged — full labels behind the menu button, no pin", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await openRegistry(page);
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const link = rail(page).getByRole("link", { name: "Risks", exact: true });
    await expect(link).toBeVisible();
    expect((await link.boundingBox())!.width, "full-width labels in the drawer").toBeGreaterThan(150);
    await expect(rail(page).getByRole("button", { name: "Pin navigation" })).toBeHidden();
    await link.click();
    await expect(page).toHaveURL(/\/ui\/admin\/risks$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("ADR-0169: the shaded field", () => {
  /**
   * axe cannot judge text over a gradient (it reports "needs review"), so this
   * measures it: hide everything but the backgrounds, screenshot, and find the
   * field's worst pixel under the canvas and under the rail. The weakest ink
   * that may sit there must still clear 4.5:1 against it.
   */
  for (const theme of THEMES) {
    test(`canvas and rail text keep AA at the field's worst point (${theme})`, async ({ page }) => {
      for (const pinned of [false, true]) {
        await page.addInitScript((p) => localStorage.setItem("regulait.rail.pinned", p ? "1" : "0"), pinned);
        await openRegistry(page);
        await setTheme(page, theme);
        await page.addStyleTag({ content: "#rgMain *, header *, aside * { visibility: hidden !important; } .rg-skip-link { display: none !important; }" });
        await page.mouse.move(1300, 900);
        const railW = Math.round(await railWidth(page));
        const png = (await page.screenshot()).toString("base64");
        const measured = await page.evaluate(
          async ({ png, railW }) => {
            const img = new Image();
            img.src = `data:image/png;base64,${png}`;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
            const lin = (v: number) => {
              const x = v / 255;
              return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
            };
            const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
            const span = (x0: number, x1: number) => {
              let min = 1;
              let max = 0;
              for (let y = 0; y < height; y += 3) {
                for (let x = x0; x < x1; x += 3) {
                  const i = (y * width + x) * 4;
                  const l = lum(data[i]!, data[i + 1]!, data[i + 2]!);
                  if (l < min) min = l;
                  if (l > max) max = l;
                }
              }
              return { min, max };
            };
            const probe = document.createElement("span");
            document.body.appendChild(probe);
            const tok = (name: string) => {
              probe.style.color = `var(${name})`;
              const m = getComputedStyle(probe).color.match(/(\d+(?:\.\d+)?)/g)!;
              return lum(+m[0]!, +m[1]!, +m[2]!);
            };
            const out = {
              canvas: span(railW + 4, width),
              rail: span(2, Math.max(4, railW - 4)),
              inkMuted: tok("--rg-ink-muted"),
              link: tok("--rg-signal-700"),
              railMuted: tok("--rg-rail-muted"),
              railInk: tok("--rg-rail-ink"),
            };
            probe.remove();
            return out;
          },
          { png, railW },
        );
        const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        // the worst ground for dark ink is the field's lightest pixel, and vice versa
        const worst = (ink: number, ground: { min: number; max: number }) =>
          Math.min(ratio(ink, ground.min), ratio(ink, ground.max));
        const label = `${theme}, rail ${pinned ? "pinned" : "collapsed"}`;
        test.info().annotations.push({
          type: "worst-point contrast",
          description: `${label}: muted ink on canvas ${worst(measured.inkMuted, measured.canvas).toFixed(2)}:1, muted ink on rail ${worst(measured.railMuted, measured.rail).toFixed(2)}:1`,
        });
        expect(worst(measured.inkMuted, measured.canvas), `muted ink on the canvas (${label})`).toBeGreaterThanOrEqual(4.5);
        expect(worst(measured.link, measured.canvas), `link ink on the canvas (${label})`).toBeGreaterThanOrEqual(4.5);
        expect(worst(measured.railMuted, measured.rail), `muted ink on the rail (${label})`).toBeGreaterThanOrEqual(4.5);
        expect(worst(measured.railInk, measured.rail), `rail ink on the rail (${label})`).toBeGreaterThanOrEqual(4.5);
        // and it IS shaded: not one flat colour
        expect(measured.canvas.max - measured.canvas.min, `the canvas is a gradient, not a flat fill (${label})`).toBeGreaterThan(0.004);
      }
    });
  }
});
