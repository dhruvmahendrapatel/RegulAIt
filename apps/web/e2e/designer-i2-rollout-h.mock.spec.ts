/**
 * Batch I-2 rollout H (owner, #453): the approved Tabs pattern (pattern 1) on Settings › Organisation, deferred from
 * #655/#691 while #622 (the organisation theme and its lock) was changing the page. Against a mocked gateway (the
 * *.mock.spec.ts harness).
 *
 *  - a status row stays above the tabs, so the relaxed settings, the credential guard, both IP policies and the theme
 *    lock (with its accessibility exception) show whichever tab is open;
 *  - each tab names its tabpanel, and a tab carries the count of relaxed settings inside it;
 *  - the panels stay mounted, so a half-typed allow-list or agent id survives a tab switch;
 *  - the tablist moves by arrow keys (and Home/End);
 *  - a settings read that fails is an error with Retry, never a status row of defaults;
 *  - axe (WCAG 2.x A/AA, light and dark) through the shared helper.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000a8`;
const ME = { userId: U(99), isAdmin: true, user: { id: U(99), email: "ada@example.test", displayName: "Ada Admin" } };

/** three settings relaxed (one each on Data & audit, Providers & network, Approvals & gates); the rest at the default */
const SETTINGS: Record<string, unknown> = {
  defaultPiiMode: "block",
  envKeyFallbackEnabled: false,
  contentCredentialGuard: false,
  a2aEnabled: true,
  useCaseGateMode: "warn",
  assuranceGateMode: "enforce",
  dispatchAttributionRequired: true,
  approvalQuorum: "all",
  approvalDelegationEnabled: false,
  sessionIpPolicy: "enforce_at_login",
  apiKeyIpPolicy: "off",
  sessionIpAllowlist: ["10.0.0.0/8"],
  themeDefaultPalette: "evergreen",
  themeLocked: true,
  // the two settings cards, at their strict defaults
  piiInternationalCategories: [],
  approvalSignatureMode: "passkey",
  toolApprovalSensitiveQuorum: 2,
  approvalTtlHours: 72,
  approvalBulkMaxItems: 25,
  approvalBulkSensitiveBlocked: true,
};

/** `failSettings` answers the settings read with a 500 until it is set back to false */
async function mockApi(page: Page, opts: { failSettings?: boolean } = {}) {
  const state = { failSettings: opts.failSettings ?? false, settingsReads: 0 };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p === "/v1/org/settings" && req.method() === "GET") {
      state.settingsReads += 1;
      if (state.failSettings) return json(route, { error: "internal", message: "The settings store did not answer" }, 500);
      return json(route, { settings: SETTINGS });
    }
    return json(route, {});
  });
  return state;
}

const TABS = [
  "Cost & limits",
  "Data & audit · 1 relaxed",
  "Providers & network · 1 relaxed",
  "Approvals & gates · 1 relaxed",
  "Assisted features",
  "Themes",
];

test.describe("I-2 rollout H: Organisation keeps its status above the tabs", () => {
  test("the status row shows on every tab, and each tab names its panel", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/organization");
    await expect(page.getByRole("heading", { name: "Organization", level: 1 })).toBeVisible();
    const tablist = page.getByRole("tablist", { name: "Organisation settings" });
    await expect(tablist.getByRole("tab")).toHaveText(TABS);
    // the first tab opens first: the cost dials, section 1
    await expect(tablist.getByRole("tab", { name: "Cost & limits" })).toHaveAttribute("aria-selected", "true");
    const status = page.getByRole("group", { name: "Organisation status" });

    for (const name of TABS) {
      const tab = tablist.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      // the tab and its panel name each other
      const panelId = await tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = page.locator(`#${panelId}`);
      await expect(panel).toHaveAttribute("role", "tabpanel");
      await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id"))!);
      await expect(panel).toBeVisible();
      await expect(page.getByRole("tabpanel")).toHaveCount(1);
      // the standing facts are visible whichever tab is open
      await expect(status.getByText("Relaxed from the default: 3", { exact: true })).toBeVisible();
      await expect(status.getByText("Credential guard for content: off", { exact: true })).toBeVisible();
      await expect(status.getByText("Sign-in IP policy: enforced at sign-in", { exact: true })).toBeVisible();
      await expect(status.getByText("API-key IP policy: off", { exact: true })).toBeVisible();
      await expect(status.getByText("Theme: everyone uses Evergreen", { exact: true })).toBeVisible();
    }

    // which settings are relaxed, and where, is behind the count's (i)
    await status.getByRole("button", { name: "What is the relaxation count?" }).click();
    const note = status.getByRole("note");
    await expect(note).toContainText("Credential guard for content: off (Data & audit)");
    await expect(note).toContainText("Calls to remote agents: on (Providers & network)");
    await expect(note).toContainText("Use-case dispatch gate not enforcing (Approvals & gates)");
    await page.keyboard.press("Escape");

    // the theme lock keeps its accessibility exception in view
    await status.getByRole("button", { name: "What is the theme lock?" }).click();
    await expect(status.getByRole("note")).toContainText("High contrast always stays available to anyone, locked or not");
    await page.keyboard.press("Escape");

    // things moved, nothing went: the guard's warning, the gates' (i), the themes card and its lock
    await tablist.getByRole("tab", { name: "Data & audit · 1 relaxed" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("The guard is off for the whole organisation");
    await expect(page.getByRole("tabpanel").getByTestId("org-pii-international")).toBeVisible();
    await tablist.getByRole("tab", { name: "Approvals & gates · 1 relaxed" }).click();
    const gates = page.getByRole("tabpanel");
    await expect(gates.getByText("5b · AI use-case dispatch gate", { exact: true })).toBeVisible();
    await expect(gates.getByLabel("Use-case dispatch gate")).toHaveValue("warn");
    await expect(gates.getByTestId("org-approval-safeguards")).toBeVisible();
    await gates.getByRole("button", { name: "What is the assurance gate?" }).click();
    await expect(gates.getByRole("note")).toContainText("The strict default is enforce");
    await page.keyboard.press("Escape");
    await tablist.getByRole("tab", { name: "Themes" }).click();
    const themes = page.getByRole("tabpanel").getByTestId("org-themes");
    await expect(themes.getByLabel("Who chooses the theme")).toHaveValue("true");
    await expect(themes.getByLabel("Organisation default theme")).toHaveValue("evergreen");
  });

  test("a half-typed draft survives a tab switch (the panels stay mounted)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/organization");
    const tablist = page.getByRole("tablist", { name: "Organisation settings" });
    await tablist.getByRole("tab", { name: "Providers & network · 1 relaxed" }).click();
    const cidrs = page.getByRole("tabpanel").getByLabel("Allowed CIDR blocks (one per line)");
    await expect(cidrs).toHaveValue("10.0.0.0/8");
    await cidrs.fill("10.0.0.0/8\n203.0.113.0/24");
    await tablist.getByRole("tab", { name: "Assisted features" }).click();
    const judge = page.getByRole("tabpanel").getByLabel("Judge agent id");
    await judge.fill(U(7));
    await tablist.getByRole("tab", { name: "Themes" }).click();
    await page.getByRole("tabpanel").getByLabel("Who chooses the theme").selectOption("false");
    await tablist.getByRole("tab", { name: "Cost & limits" }).click();

    await tablist.getByRole("tab", { name: "Providers & network · 1 relaxed" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Allowed CIDR blocks (one per line)")).toHaveValue("10.0.0.0/8\n203.0.113.0/24");
    await tablist.getByRole("tab", { name: "Assisted features" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Judge agent id")).toHaveValue(U(7));
    await tablist.getByRole("tab", { name: "Themes" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Who chooses the theme")).toHaveValue("false");
    // a draft is not a save: the status row still reads the saved lock
    await expect(page.getByRole("group", { name: "Organisation status" }).getByText("Theme: everyone uses Evergreen")).toBeVisible();
  });

  test("the tablist moves by arrow keys, Home and End", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/organization");
    const tablist = page.getByRole("tablist", { name: "Organisation settings" });
    const tab = (name: string) => tablist.getByRole("tab", { name, exact: true });
    await tab("Cost & limits").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab("Data & audit · 1 relaxed")).toHaveAttribute("aria-selected", "true");
    await expect(tab("Data & audit · 1 relaxed")).toBeFocused();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await tab("Data & audit · 1 relaxed").getAttribute("id"))!);
    await page.keyboard.press("ArrowLeft");
    await expect(tab("Cost & limits")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(tab("Themes")).toHaveAttribute("aria-selected", "true");
    await expect(tab("Themes")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tab("Cost & limits")).toBeFocused();
    await page.keyboard.press("End");
    await expect(tab("Themes")).toHaveAttribute("aria-selected", "true");
    // only the selected tab is in the tab order
    await expect(tablist.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  });

  test("a settings read that fails is an error with Retry, never a status row of defaults", async ({ page }) => {
    const state = await mockApi(page, { failSettings: true });
    await page.goto("/ui/admin/organization");
    const error = page.getByRole("alert").filter({ hasText: "Couldn't load the organisation settings" });
    await expect(error).toBeVisible();
    await expect(error).toContainText("The settings store did not answer");
    await expect(page.getByRole("group", { name: "Organisation status" })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Organisation settings" })).toHaveCount(0);
    await expect(page.getByText("Nothing relaxed from the default")).toHaveCount(0);
    await expectAxeClean(page, "organisation, settings read failed");

    state.failSettings = false;
    await error.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("group", { name: "Organisation status" }).getByText("Relaxed from the default: 3")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Organisation settings" }).getByRole("tab")).toHaveText(TABS);
    await expect(error).toHaveCount(0);
  });

  test("axe is clean in light and dark, on the first tab and with the status row's (i) open", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/organization");
    await expect(page.getByRole("tablist", { name: "Organisation settings" })).toBeVisible();
    await expectAxeClean(page, "organisation, Cost & limits");
    const status = page.getByRole("group", { name: "Organisation status" });
    await status.getByRole("button", { name: "What is the relaxation count?" }).click();
    await expect(status.getByRole("note")).toBeVisible();
    await expectAxeClean(page, "organisation, relaxation count open");
    await page.keyboard.press("Escape");
    await page.getByRole("tablist", { name: "Organisation settings" }).getByRole("tab", { name: "Approvals & gates · 1 relaxed" }).click();
    await expectAxeClean(page, "organisation, Approvals & gates");
    await page.getByRole("tablist", { name: "Organisation settings" }).getByRole("tab", { name: "Themes" }).click();
    await expect(page.getByTestId("org-themes")).toBeVisible();
    await expectAxeClean(page, "organisation, Themes");
  });
});
