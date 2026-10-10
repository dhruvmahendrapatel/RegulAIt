/**
 * MFA enrolment shows a scannable QR code (ui/TotpQrCode.tsx) on both screens
 * that enrol an authenticator, with every /v1 and /auth call mocked:
 *
 *  - the forced enrolment at sign-in (views/auth/ForcedMfaEnroll), reached when
 *    `/auth/me` says `mfaSetupRequired`;
 *  - self-service enrolment on the Account page's two-step section.
 *
 * Each asserts the QR image is visible, named for assistive technology, about
 * 200px and drawn on white in BOTH themes; that the manual key and the otpauth
 * URI are still readable text (the locator the real-gateway journeys use to read
 * the secret, e2e/totp-sign-in.ts, still finds the URI); that the secret is in
 * no request the page makes and in no browser storage; and runs axe (WCAG 2.x
 * A/AA) in light and dark with the code showing. A URI the screen cannot draw
 * leaves only the manual block, never a broken image.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ADA = { id: "ada", email: "ada@example.test", displayName: "Ada Admin" };
const SECRET = "JBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/RegulAIt:ada%40example.test?secret=${SECRET}&issuer=RegulAIt&algorithm=SHA1&digits=6&period=30`;
const QR_NAME = "QR code for your authenticator app";

interface Seen {
  /** every request the page made after load: URL plus body */
  requests: string[];
}

async function mockApi(page: Page, opts: { forced: boolean; enrol: { secret: string; otpauthUri?: string } }): Promise<Seen> {
  const seen: Seen = { requests: [] };
  page.on("request", (req) => seen.requests.push(`${req.method()} ${req.url()} ${req.postData() ?? ""}`));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me")
      return json(route, {
        userId: ADA.id, isAdmin: true, via: "session", user: ADA, mustChangePassword: false,
        totpEnabled: false, passwordSet: true, mfaSetupRequired: opts.forced,
      });
    if (p === "/v1/me") return json(route, { userId: ADA.id, isAdmin: true, user: ADA });
    if (p === "/auth/sessions") return json(route, { sessions: [] });
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    if (p === "/auth/totp/enroll" && method === "POST") return json(route, opts.enrol);
    return json(route, {});
  });
  return seen;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }, theme);
}

/** the QR is drawn dark-on-white whatever the theme: white field behind the SVG and in its quiet zone */
async function expectWhiteField(page: Page) {
  const qr = page.getByRole("img", { name: QR_NAME });
  const colours = await qr.evaluate((svg) => ({
    background: getComputedStyle(svg).backgroundColor,
    field: svg.querySelector("rect")?.getAttribute("fill"),
    modules: svg.querySelector("path")?.getAttribute("fill"),
  }));
  expect(colours).toEqual({ background: "rgb(255, 255, 255)", field: "#ffffff", modules: "#000000" });
}

/** `scope`: limit axe to one region (a CSS selector) when the rest of the page is not this spec's subject */
async function axeBothThemes(page: Page, label: string, scope?: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await expectWhiteField(page);
    const builder = new AxeBuilder({ page });
    if (scope) builder.include(scope);
    const results = await builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on ${label} (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

async function expectQrThenManual(page: Page) {
  const qr = page.getByRole("img", { name: QR_NAME });
  await expect(qr).toBeVisible();
  const box = await qr.boundingBox();
  expect(box?.width).toBe(200);
  expect(box?.height).toBe(200);
  // an SVG path, not an <img> source or a data: URL that could be copied or stored
  expect(await qr.evaluate((el) => el.tagName.toLowerCase())).toBe("svg");
  expect((await qr.locator("path").getAttribute("d"))?.length ?? 0).toBeGreaterThan(100);
  await expect(page.getByText("Scan this QR code with your authenticator app")).toBeVisible();
  await expect(page.getByText("Shown exactly once.")).toBeVisible();
  // the manual route is still there, as text
  const manual = page.getByRole("group", { name: "Can't scan? Enter this key manually" });
  await expect(manual).toBeVisible();
  await expect(manual.getByText(SECRET, { exact: true })).toBeVisible();
  const uri = page.getByText(/^otpauth:\/\/totp\//);
  await expect(uri).toBeVisible();
  expect((await uri.textContent())?.trim()).toBe(URI);
  // QR first, then the manual block
  const qrTop = box!.y;
  const manualTop = (await manual.boundingBox())!.y;
  expect(qrTop).toBeLessThan(manualTop);
}

/** the secret went nowhere: not in any request the page made, not in browser storage */
async function expectSecretStayedOnPage(page: Page, seen: Seen) {
  expect(seen.requests.filter((r) => r.includes(SECRET))).toEqual([]);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(SECRET);
  expect(stored).not.toContain("data:image");
}

test.describe("MFA enrolment shows a QR code", () => {
  test("forced enrolment at sign-in: QR first, manual key below, axe clean in both themes", async ({ page }) => {
    const seen = await mockApi(page, { forced: true, enrol: { secret: SECRET, otpauthUri: URI } });
    await page.goto("/ui/");
    await page.getByRole("button", { name: "Generate enrollment secret" }).click();
    await expectQrThenManual(page);
    await expect(page.getByLabel("Code from your authenticator")).toBeVisible();
    await axeBothThemes(page, "forced MFA enrolment with QR");
    await expectSecretStayedOnPage(page, seen);
  });

  test("account page enrolment: QR first, manual key below, axe clean in both themes", async ({ page }) => {
    const seen = await mockApi(page, { forced: false, enrol: { secret: SECRET, otpauthUri: URI } });
    await page.goto("/ui/account?section=mfa");
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await page.getByRole("button", { name: "Enroll an authenticator" }).click();
    await expectQrThenManual(page);
    await expect(page.getByRole("button", { name: "Activate" })).toBeVisible();
    // axe covers the two-factor card: another Account-page card has its own,
    // unrelated finding (a colour-only link in the model keys card)
    await page.getByRole("img", { name: QR_NAME }).evaluate((el) => {
      let card: HTMLElement | null = el.parentElement;
      while (card && !card.textContent?.trimStart().startsWith("Two-factor authentication")) card = card.parentElement;
      card?.setAttribute("data-axe-scope", "mfa");
    });
    await expect(page.locator("[data-axe-scope=mfa]")).toHaveCount(1);
    await axeBothThemes(page, "account MFA enrolment with QR", "[data-axe-scope=mfa]");
    await expectSecretStayedOnPage(page, seen);
  });

  test("no usable otpauth URI: no image at all, the manual key alone", async ({ page }) => {
    await mockApi(page, { forced: true, enrol: { secret: SECRET } });
    await page.goto("/ui/");
    await page.getByRole("button", { name: "Generate enrollment secret" }).click();
    const manual = page.getByRole("group", { name: "Enter this key in your authenticator app" });
    await expect(manual).toBeVisible();
    await expect(manual.getByText(SECRET, { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: QR_NAME })).toHaveCount(0);
    await expect(page.locator("main svg[role=img]")).toHaveCount(0);
    await expect(page.getByText("Scan this QR code with your authenticator app")).toHaveCount(0);
    await expect(page.getByText("Shown exactly once.")).toBeVisible();
  });
});
