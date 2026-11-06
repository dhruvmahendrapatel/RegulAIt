/**
 * Lane U5 of the #547 feedback scan: the shared kit and shell, from the browser's side against a mocked gateway.
 *
 *  - FS-3: a keyboard-opened drawer heading draws the focus ring (the token is a whole shadow list, so
 *    `0 0 0 2px var(--focus-ring)` computed to none);
 *  - FS-4: a sortable kit Table header is reached with Tab and sorts with Enter;
 *  - FS-15: the success toast sits left of an open side drawer, never over its pinned action row (G5 Acknowledge);
 *  - shell-home-account-01: the user menu follows the menu-button pattern (focus in, arrows, Escape, Tab out);
 *  - shell-home-account-03: the Inbox badge counts a status=pending request and is part of the link's name.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const ME = "u";
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const useCases = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Credit-limit-increase assistant", description: "Recommends credit-limit increases.", status: "under_review", euAiActTier: "high", ownerUserId: ME, ownerName: "Avery Admin", createdAt: "2026-10-01T09:00:00Z", decidedAt: null, approvedUntil: null, openConditions: 0, complianceTags: [], workflowInstanceId: "i" },
  { id: "22222222-1111-4111-8111-111111111111", name: "Support ticket summarizer", description: "Summarizes inbound tickets.", status: "approved", euAiActTier: "minimal", ownerUserId: ME, ownerName: "Avery Admin", createdAt: "2026-08-12T09:00:00Z", decidedAt: "2026-08-20T09:00:00Z", approvedUntil: "2027-08-20T09:00:00Z", openConditions: 0, complianceTags: [], workflowInstanceId: "j" },
];
const pending = (id: string, label: string) => ({ id, status: "pending", objectType: "project", stageId: "__project_budget__", requestedAt: ago(2), userId: "budget", approverUserId: ME, objectLabel: label, requestedByName: "Budget monitor", approverName: "Avery Admin" });
const decided = { id: "D1", status: "approved", objectType: "project", stageId: "__project_budget__", requestedAt: ago(30), decidedAt: ago(24), userId: "budget", approverUserId: ME, objectLabel: "An older decided request", requestedByName: "Budget monitor", decidedByName: "Avery Admin" };
const alert = {
  id: "al", ruleId: "use_case_inherited_high_risk", ruleLabel: "Approved use case carries a high rating", severity: "high", status: "open",
  subject: { key: "use_case:uc", type: "use_case", id: "uc", label: "Credit-limit assistant", context: null },
  title: "Credit-limit assistant inherits a high rating from Acme Model Services",
  detail: { sourceNodeKey: "vendor:v", sourceRiskId: "r1", pathLabels: ["Credit-limit assistant", "Acme Model Services"] },
  firstDetectedAt: ago(4), lastDetectedAt: ago(2), acknowledgedAt: null, acknowledgedBy: null, ackNote: null, resolvedAt: null,
};

let approvals: unknown[] = [];
let alerts: unknown[] = [];
let approvalUrls: string[] = [];

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page: Page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: ME, isAdmin: true, user: { id: ME, email: "avery@example.test", displayName: "Avery Admin" } });
    if (p === "/v1/use-cases") return json(route, { useCases });
    if (p === "/v1/approvals" && method === "GET") {
      approvalUrls.push(url.search);
      const status = url.searchParams.get("status");
      return json(route, { approvals: status ? approvals.filter((a) => (a as { status: string }).status === status) : approvals });
    }
    const decide = method === "POST" ? /^\/v1\/approvals\/([^/]+)\/decide$/.exec(p) : null;
    if (decide) {
      approvals = approvals.map((a) => ((a as { id: string }).id === decide[1] ? { ...(a as object), status: "approved", decidedAt: ago(0) } : a));
      return json(route, { status: "approved" });
    }
    if (method === "POST" && /^\/v1\/governance\/alerts\/[^/]+\/acknowledge$/.test(p)) {
      alerts = alerts.map((a) => ({ ...(a as object), status: "acknowledged", acknowledgedAt: ago(0), acknowledgedBy: "Avery Admin", ackNote: "Avery owns the response." }));
      return json(route, {});
    }
    if (p === "/v1/governance/alerts") return json(route, { alerts, counts: { open: 1, acknowledged: 0, resolved: 0 }, lastEvaluatedAt: ago(1), rules: [] });
    if (/^\/v1\/governance\/alerts\/[^/]+\/remediation$/.test(p)) return json(route, { alert: { id: "al", ruleId: alert.ruleId, status: "open", title: alert.title }, candidates: [], proposals: [], note: "" });
    if (p === "/v1/governance/remediations") return json(route, { proposals: [] });
    if (p === "/v1/annotations/inbox") return json(route, { items: [] });
    if (p === "/v1/users") return json(route, { users: [{ id: ME, email: "avery@example.test", displayName: "Avery Admin" }] });
    if (p === "/v1/users/directory") return json(route, { users: [] });
    return json(route, {});
  });
}

test.beforeEach(async ({ page }) => {
  approvals = [];
  alerts = [alert];
  approvalUrls = [];
  await mockApi(page);
});

const intersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("FS-3: a keyboard-opened drawer heading draws the focus ring", async ({ page }) => {
  approvals = [pending("P1", "team-17 support: monthly budget 112% used")];
  await page.goto("/ui/inbox");
  const review = page.getByRole("button", { name: /^Review / });
  await review.focus();
  await page.keyboard.press("Enter");
  const heading = page.getByTestId("inbox-item").getByRole("heading", { name: /team-17 support/ });
  await expect(heading).toBeFocused();
  await expect.poll(() => heading.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
});

test("FS-4: a sortable header is reached with Tab and sorts with Enter", async ({ page }) => {
  await page.goto("/ui/admin/use-cases");
  await expect(page.getByRole("heading", { level: 1, name: "AI registry" })).toBeVisible();
  const sortName = page.getByRole("button", { name: "Name", exact: true });
  const header = page.locator("th", { has: sortName });
  await expect(header).not.toHaveAttribute("aria-sort", /.*/);
  // Tab reaches it: from the control before it, the next Tab stop is the header's button
  await sortName.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(sortName).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator("tbody tr").first()).toContainText("Support ticket summarizer");
});

test("FS-15: the success toast sits left of an open side drawer, not over its pinned action row (G5 Acknowledge)", async ({ page }) => {
  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("button", { name: /Credit-limit assistant inherits/ }).click();
  const detail = page.getByTestId("alert-detail");
  await detail.getByLabel("Acknowledgement note — required and audited").fill("Avery owns the response.");
  await detail.getByRole("button", { name: "Acknowledge" }).click();
  const toast = page.getByText("Alert acknowledged", { exact: true });
  await expect(toast).toBeVisible();
  await expect(detail).toBeVisible();
  const [t, d] = [await toast.boundingBox(), await detail.boundingBox()];
  expect(intersects(t!, d!), `toast ${JSON.stringify(t)} over drawer ${JSON.stringify(d)}`).toBe(false);
});

test("FS-15: with no drawer open the toast keeps its corner", async ({ page }) => {
  await page.goto("/ui/admin/use-cases");
  await expect(page.getByRole("heading", { level: 1, name: "AI registry" })).toBeVisible();
  // the region is the aria-live channel; with nothing to say it is empty, so read its edge from the stylesheet
  const right = await page.locator("[aria-live=polite]").last().evaluate((el) => getComputedStyle(el).right);
  expect(parseFloat(right)).toBeLessThan(64);
});

test("shell-home-account-01: the user menu takes focus, moves with the arrows, closes on Escape and on Tab out", async ({ page }) => {
  await page.goto("/ui/admin/use-cases");
  const button = page.getByRole("button", { name: "Avery Admin" });
  await button.click();
  const menu = page.getByRole("menu");
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // Tab out of the open menu closes it; it is never left drawn over the page
  await page.keyboard.press("Enter");
  await expect(items.first()).toBeFocused();
  await menu.getByRole("menuitem", { name: "Sign out" }).focus();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);

  // a mouse click on an item still works (the focus-out close never eats the click)
  await button.click();
  await menu.getByRole("menuitem", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/ui\/account$/);
});

test("shell-home-account-03: the Inbox badge counts a status=pending request, names the count in the link, and drops after a decision", async ({ page }) => {
  // decided rows in the unfiltered list do not count, and only a status=pending request feeds the badge
  approvals = [decided, pending("P1", "team-17 support: monthly budget 112% used"), pending("P2", "team-18 support: monthly budget 104% used")];
  await page.goto("/ui/inbox");
  const nav = page.getByRole("complementary", { name: "Primary navigation" });
  await expect(nav.getByRole("link", { name: "Inbox, 2 pending approvals" })).toBeVisible();
  // the server-filtered pending queue, oldest first (the badge shares the Inbox's read); never the unfiltered page
  expect(approvalUrls).toContain("?status=pending&order=asc");
  expect(approvalUrls).not.toContain("");

  await page.getByRole("button", { name: /^Review team-17/ }).click();
  await page.getByTestId("inbox-item").getByRole("button", { name: "Approve" }).click();
  // the success toast (a status badge now reads "Approved" too)
  await expect(page.locator('[aria-live="polite"]').getByText("Approved", { exact: true })).toBeVisible();
  // the decide path invalidates ["approvals"], under which the badge's pending-queue key falls
  await expect(nav.getByRole("link", { name: "Inbox, 1 pending approvals" })).toBeVisible();
});

test("shell-home-account-03: a full page of pending rows reads 99+, not an exact total", async ({ page }) => {
  approvals = Array.from({ length: 100 }, (_, i) => pending(`P${i}`, `Request ${i}`));
  await page.goto("/ui/inbox");
  const link = page.getByRole("complementary", { name: "Primary navigation" }).getByRole("link", { name: "Inbox, 99+ pending approvals" });
  await expect(link).toBeVisible();
});
