/**
 * ADR-0180 §2 — the continuous-assurance gate toggle on Organization settings,
 * against a mocked gateway (the *.mock.spec.ts harness):
 *
 *  - the strict default reads `enforce`, and the card says so;
 *  - saving sends the mode to its OWN admin-only, audited route
 *    (`PUT /v1/org/settings/assurance-gate-mode`), never the general org PUT,
 *    which does not take the key;
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Captured {
  modePuts: unknown[];
  orgPuts: unknown[];
}

async function mockApi(page: Page, mode = "enforce"): Promise<Captured> {
  const cap: Captured = { modePuts: [], orgPuts: [] };
  const settings = { assuranceGateMode: mode, useCaseGateMode: "off" };
  const me = { userId: "u", isAdmin: true, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/org/settings/assurance-gate-mode" && method === "PUT") {
      const body = req.postDataJSON() as { mode: string };
      cap.modePuts.push(body);
      settings.assuranceGateMode = body.mode;
      return json(route, { mode: body.mode, defaultMode: "enforce", strictDefault: body.mode === "enforce" });
    }
    if (p === "/v1/org/settings" && method === "PUT") {
      cap.orgPuts.push(req.postDataJSON());
      return json(route, { settings });
    }
    if (p === "/v1/org/settings") return json(route, { settings, envKeys: [] });
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0180: the continuous-assurance gate setting", () => {
  test("reads enforce by default, says so, and saves through its own audited route", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/organization");
    const card = page.locator("section[data-rg-card]").filter({ hasText: "Continuous-assurance deploy gate" }).first();
    await expect(card).toBeVisible();
    const select = card.getByLabel("Continuous-assurance gate");
    await expect(select).toHaveValue("enforce");
    await expect(card.getByRole("option", { name: /enforce — hold the release \(strict default\)/ })).toBeAttached();
    await expect(card).toContainText("The strict default is enforce");
    await expectAxeClean(page, "organization settings with the assurance gate");

    await select.selectOption("warn");
    await card.getByRole("button", { name: "Save assurance gate" }).click();
    await expect.poll(() => cap.modePuts).toEqual([{ mode: "warn" }]);
    expect(cap.orgPuts).toEqual([]);
  });
});

// ADR-0186 A: the Organization page's settings writes go through withStepUp — refused, confirmed, the SAME PUT resent once
test("ADR-0186 A: relaxing the use-case gate asks to confirm it's you and resends the same PUT once", async ({ page }) => {
  const cap = await mockApi(page);
  const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/org/settings", kind: "settings_relax" });
  await page.goto("/ui/admin/organization");
  const card = page.locator("section[data-rg-card]").filter({ hasText: "AI use-case dispatch gate" }).first();
  await card.getByLabel("Use-case dispatch gate").selectOption("warn");
  await card.getByRole("button", { name: "Save use-case gate" }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(cap.orgPuts).toEqual([{ useCaseGateMode: "warn" }]);
});
