/**
 * ADR-0196 U1 — focus goes back to the control that opened a dialog, even when the dialog's work disabled that
 * control (against a mocked gateway). The enterprise keyboard journey only checks that focus did not fall to
 * <body>, which parking focus on <main> satisfies by itself; these cases pin where focus actually ends up
 * (`returnFocus` in `src/ui/kit.tsx`).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ISO = "2026-10-07T10:00:00.000Z";

async function mockApi(page: Page) {
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/servers") return json(route, { servers: [] });
    if (p === "/v1/execution") {
      return json(route, {
        mode: "halted", meaning: "Every governed call is refused.", reason: "incident drill", setAt: ISO, setByUserId: "u-admin",
        haltedAgents: [], haltedTools: [], summary: "Execution is halted", note: "", scheduledSweepsNote: "",
      });
    }
    return json(route, {});
  });
}

/** opens "Resume normal execution" from the page's Resume button and submits it, all from the keyboard */
async function submitResume(page: Page) {
  const resume = page.getByRole("button", { name: "Resume" }).first();
  await resume.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: "Resume normal execution" });
  await confirm.getByLabel("Reason").fill("incident closed, verified safe to resume");
  await confirm.getByRole("button", { name: "Resume" }).press("Enter");
  return resume;
}

test.describe("ADR-0196 U1: a dialog hands focus back to its trigger", () => {
  test("Escape on the step-up dialog returns focus to the page's Resume button, not to <main>", async ({ page }) => {
    await mockApi(page);
    await requireStepUpOn(page, { method: "PUT", path: "/v1/execution/mode", kind: "settings_relax", facts: () => ({ values: { executionMode: "normal" } }) });
    await page.goto("/ui/admin/execution");
    const resume = await submitResume(page);
    const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(stepUp).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(stepUp).toBeHidden();
    await expect(resume).toBeFocused({ timeout: 5_000 });
  });

  test("a trigger busy after its dialog closes gets focus back once it is enabled again", async ({ page }) => {
    await mockApi(page);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/v1/execution/mode", async (route) => {
      await held;
      await json(route, { error: "unavailable" }, 503);
    });
    await page.goto("/ui/admin/execution");
    const resume = await submitResume(page);
    await expect(resume).toBeDisabled();
    // parked on <main> while the work runs: the disabled button cannot hold focus
    await expect(page.locator("main")).toBeFocused();
    release();
    await expect(resume).toBeEnabled();
    await expect(resume).toBeFocused({ timeout: 5_000 });
  });

  test("focus the person moved while the trigger was busy stays where they put it", async ({ page }) => {
    await mockApi(page);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/v1/execution/mode", async (route) => {
      await held;
      await json(route, { error: "unavailable" }, 503);
    });
    await page.goto("/ui/admin/execution");
    const resume = await submitResume(page);
    await expect(page.locator("main")).toBeFocused();
    await page.keyboard.press("Tab");
    const moved = await page.evaluate(() => {
      const el = document.activeElement;
      el?.setAttribute("data-focus-moved", "");
      return el !== null && el !== document.body && el.tagName !== "MAIN";
    });
    expect(moved).toBe(true);
    release();
    await expect(resume).toBeEnabled();
    await expect(page.locator("[data-focus-moved]")).toBeFocused();
    await expect(resume).not.toBeFocused();
  });
});
