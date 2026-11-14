/**
 * Batch I-2 rollout E (owner, #453): the approved Tabs pattern on the identity and settings pages that rollout A
 * deferred (they were being changed by the list-control branches this one stacks on), against a mocked gateway.
 *
 *  - ChatOps, Workload identities, SSO & sessions, and the Users detail: a status row stays above the tabs, so no tab
 *    hides a warning; each tab names its own tabpanel and the panel names it back; exactly one panel shows; a half-typed
 *    draft survives a trip to another tab (the panels stay mounted); the tablist moves by keyboard.
 *  - A failed read behind a status row is an error with Retry, never a zero.
 *  - axe (WCAG 2.x A/AA, light and dark) on each, through the shared helper.
 */
import { expect, test, type Page } from "@playwright/test";
import { json, mockApi } from "./long-pages-identity.fixtures";
import { expectAxeClean } from "./prompts-fixtures";

const T = "2026-10-20T12:00:00.000Z";
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000e5`;

/** each tab names its panel, the panel names the tab back, only one panel shows, and `visible` holds on every tab */
async function expectPairedTabs(page: Page, tablistName: string | RegExp, names: string[], visible: () => Promise<void>) {
  const tablist = page.getByRole("tablist", { name: tablistName });
  await expect(tablist.getByRole("tab")).toHaveText(names);
  for (const name of names) {
    const tab = tablist.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const panelId = await tab.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = page.locator(`#${panelId}`);
    await expect(panel).toHaveAttribute("role", "tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id"))!);
    await expect(panel).toBeVisible();
    await expect(page.getByRole("tabpanel")).toHaveCount(1);
    await visible();
  }
  // the tablist moves by keyboard
  await tablist.getByRole("tab", { name: names[0], exact: true }).click();
  await tablist.getByRole("tab", { name: names[0], exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tablist.getByRole("tab", { name: names[1], exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(tablist.getByRole("tab", { name: names[1], exact: true })).toBeFocused();
  return tablist;
}

const CONNECTION = {
  id: id(1),
  name: "risk-slack",
  provider: "slack",
  defaultChannel: "C0123456789",
  allowFencedDecide: true,
  outboundSupported: true,
  notifyAlertMinSeverity: null,
  botEndpoint: null,
  botTenantId: null,
  enabled: true,
  createdAt: T,
};
const ROUTE = {
  channelId: id(2),
  agentId: id(3),
  agentName: "Credit memo builder",
  provider: "slack",
  connectionId: id(1),
  connectionName: "risk-slack",
  externalChannelId: null,
};

test.describe("I-2 rollout E: ChatOps", () => {
  test("the workspace status stays above the tabs, each tab names its panel, and a route draft survives a switch", async ({ page }) => {
    await mockApi(page);
    await page.route("**/v1/chatops/connections", (route) => json(route, { connections: [CONNECTION], posture: "The bot is a courier." }));
    await page.route("**/v1/chatops/builder-routes", (route) => json(route, { routes: [ROUTE], posture: "" }));
    await page.goto("/ui/admin/chatops");
    await expect(page.getByRole("heading", { name: "ChatOps approvals", level: 1 })).toBeVisible();
    const status = page.getByRole("group", { name: "Workspace status" });

    const tablist = await expectPairedTabs(page, "ChatOps settings", ["Workspaces", "Posting & routes"], async () => {
      // the opt-in that lets a chat tap decide a sensitive approval shows whichever tab is open
      await expect(status.getByText("Workspaces: 1")).toBeVisible();
      await expect(status.getByText("Sensitive approvals chat-decidable: 1")).toBeVisible();
    });

    // the warnings inside the Workspaces table moved nowhere
    await tablist.getByRole("tab", { name: "Workspaces" }).click();
    await expect(page.getByRole("tabpanel").getByText("chat-decidable (opted in)")).toBeVisible();

    // panels stay mounted: a half-typed channel route is still there after a trip to Workspaces
    await tablist.getByRole("tab", { name: "Posting & routes" }).click();
    await page.getByRole("tabpanel").getByLabel("Channel for Credit memo builder (empty = connection-wide)").fill("C0999");
    await tablist.getByRole("tab", { name: "Workspaces" }).click();
    await tablist.getByRole("tab", { name: "Posting & routes" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Channel for Credit memo builder (empty = connection-wide)")).toHaveValue("C0999");

    await expectAxeClean(page, "ChatOps, routes tab");
  });

  test("a workspace read that fails is an error with Retry above the tabs, never 'Workspaces: 0'", async ({ page }) => {
    await mockApi(page);
    await page.route("**/v1/chatops/connections", (route) => json(route, { error: "unavailable" }, 503));
    await page.goto("/ui/admin/chatops");
    await expect(page.getByText("Couldn't load the chat workspaces")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await expect(page.getByText("Workspaces: 0")).toHaveCount(0);
  });
});

test.describe("I-2 rollout E: Workload identities", () => {
  test("the delegation refusal stays above the tabs, each tab names its panel, and a trust-bundle draft survives", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/workload-identities");
    await expect(page.getByRole("heading", { name: "Workload identities", level: 1 })).toBeVisible();

    const tablist = await expectPairedTabs(page, "Identity settings", ["Delegation", "Settings · 1 to review", "Signing & trust"], async () => {
      await expect(page.getByText("External child delegation unavailable")).toBeVisible();
    });

    await tablist.getByRole("tab", { name: "Signing & trust" }).click();
    await page.getByRole("tabpanel").getByLabel("Trust domain", { exact: true }).fill("example.test");
    await tablist.getByRole("tab", { name: "Delegation" }).click();
    await tablist.getByRole("tab", { name: "Signing & trust" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Trust domain", { exact: true })).toHaveValue("example.test");

    await expectAxeClean(page, "Workload identities, trust tab");
  });
});

test.describe("I-2 rollout E: SSO & sessions", () => {
  test("both families' sign-in facts stay above the tabs, each tab names its panel, and a half-typed provider survives", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/sso");
    await expect(page.getByRole("heading", { name: "SSO & sessions", level: 1 })).toBeVisible();
    const status = page.getByRole("group", { name: "Sign-in status" });

    const tablist = await expectPairedTabs(page, "SSO settings", ["OIDC providers", "SAML providers · 1 to review", "Sessions & step-up · 3 to review"], async () => {
      // "SSO only" counts OIDC and SAML together, so both counts show whichever family's tab is open
      await expect(status.getByText("OIDC: 0 enabled")).toBeVisible();
      await expect(status.getByText("SAML: 1 enabled")).toBeVisible();
      await expect(status.getByText("SSO only: off")).toBeVisible();
      await expect(status.getByText("Email sign-in: everyone with a password")).toBeVisible();
    });

    await tablist.getByRole("tab", { name: "OIDC providers" }).click();
    await page.getByRole("tabpanel").getByLabel("Name").fill("okta-prod");
    await tablist.getByRole("tab", { name: "SAML providers · 1 to review" }).click();
    await tablist.getByRole("tab", { name: "OIDC providers" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Name")).toHaveValue("okta-prod");
    // the empty state and the policy requirements moved nowhere
    await expect(page.getByRole("tabpanel").getByText("No OIDC providers")).toBeVisible();
    await tablist.getByRole("tab", { name: "Sessions & step-up · 3 to review" }).click();
    await expect(page.getByTestId("sso-policy-requirements")).toBeVisible();

    await expectAxeClean(page, "SSO, sessions tab");
  });

  test("a provider read that fails is an error with Retry above the tabs, never 'OIDC: 0 enabled'", async ({ page }) => {
    await mockApi(page);
    await page.route("**/v1/auth/oidc-providers", (route) => json(route, { error: "unavailable" }, 503));
    await page.goto("/ui/admin/sso");
    await expect(page.getByText("Couldn't load the sign-in status")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await expect(page.getByText("OIDC: 0 enabled")).toHaveCount(0);
  });
});

test.describe("I-2 rollout E: Users", () => {
  test("the person's status stays above the detail tabs, each tab names its panel, and a rename draft survives", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/users");
    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();

    // Ada is the only active admin: the last-admin guard is stated above the tabs, not only on a disabled button
    await page.getByText("ada@example.test").first().click();
    const status = page.getByRole("group", { name: "User status" });
    await expectPairedTabs(page, "Ada Admin: details", ["Lifecycle", "Sessions", "Passkeys", "Roles", "Overrides"], async () => {
      await expect(status.getByText("admin", { exact: true })).toBeVisible();
      await expect(status.getByText("active", { exact: true })).toBeVisible();
      await expect(status.getByText("Last active admin: cannot be demoted or deactivated")).toBeVisible();
    });

    // Morgan: a member, no guard; a half-typed name survives a trip to Sessions
    await page.getByText("morgan@example.test").first().click();
    const tablist = page.getByRole("tablist", { name: "Morgan Reyes: details" });
    await expect(status.getByText("member", { exact: true })).toBeVisible();
    await expect(status.getByText("MFA: TOTP")).toBeVisible();
    await expect(status.getByText(/Last active admin/)).toHaveCount(0);
    await page.getByRole("tabpanel").getByLabel("Display name").fill("Morgan R. Reyes");
    await tablist.getByRole("tab", { name: "Sessions" }).click();
    await tablist.getByRole("tab", { name: "Lifecycle" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Display name")).toHaveValue("Morgan R. Reyes");
    // the last-admin protection on the buttons is unchanged
    await page.getByText("ada@example.test").first().click();
    await expect(page.getByRole("tabpanel").getByRole("button", { name: "Deactivate" })).toBeDisabled();

    await expectAxeClean(page, "Users, detail open");
  });
});
