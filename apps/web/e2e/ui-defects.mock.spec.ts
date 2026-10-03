/**
 * Mocked-gateway regression specs for verified UI defects. Each test routes
 * every /v1 and /auth call to an in-test mock (same harness as
 * demo-governance.mock.spec.ts) so the defect is reproduced from the browser's
 * side alone — no database, no seed, no real session.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

type Persona = { id: string; email: string; displayName: string };
const USER_A: Persona = { id: "user-a", email: "avery@example.test", displayName: "Avery Admin" };
const USER_B: Persona = { id: "user-b", email: "blake@example.test", displayName: "Blake Builder" };

const authMe = (u: Persona) => ({
  userId: u.id, isAdmin: true, via: "session", user: { id: u.id, email: u.email, displayName: u.displayName },
  mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false,
});

/** Route only the API (documents, assets and Vite's own requests pass through). */
async function routeApi(page: Page, handler: (route: Route, pathname: string, method: string) => Promise<void> | void) {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    await handler(route, p, route.request().method());
  });
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function signIn(page: Page, u: Persona) {
  await page.getByLabel("Email or username").fill(u.email);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("L4: signing out clears the previous user's cached data before the next sign-in", async ({ page }) => {
  // the approval only user A holds; user B's inbox is empty on the server
  const approvalForA = {
    id: "ap-a", status: "pending", objectType: "workflow", stageId: "security-signoff",
    requestedAt: "2026-10-02T12:00:00Z", userId: USER_A.id, approverUserId: USER_A.id,
    requestedByName: "Riley Requester", objectLabel: "Credit assistant release",
  };
  let current: Persona | null = USER_A;
  let approvalsRequests = 0;
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return current ? json(route, authMe(current)) : json(route, { error: "unauthenticated" }, 401);
    if (p === "/v1/me") return json(route, current ? { userId: current.id, isAdmin: true, user: current } : {});
    if (p === "/auth/logout") { current = null; return json(route, {}); }
    if (p === "/auth/login") { current = USER_B; return json(route, {}); }
    if (p === "/v1/approvals") {
      approvalsRequests += 1;
      // the second answer is slow on purpose: a stale cache would be painted
      // long before it arrives, which is exactly what the assertion below reads
      if (approvalsRequests > 1) await new Promise((r) => setTimeout(r, 1_000));
      return json(route, { approvals: current?.id === USER_A.id ? [approvalForA] : [] });
    }
    return json(route, {});
  });

  await page.goto("/ui/inbox");
  await expect(page.getByText("Credit assistant release")).toBeVisible();
  expect(approvalsRequests).toBe(1);

  // client-side sign-out from the account menu
  await page.locator("button[aria-haspopup=menu]").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/ui\/login/);

  await signIn(page, USER_B);
  await expect(page).toHaveURL(/\/ui\/inbox/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  // the first paint of B's inbox must not come from A's cache (no auto-retry:
  // this reads what is on screen the moment the page is up)
  expect(await page.getByText("Credit assistant release").count()).toBe(0);
  await expect(page.getByText("Nothing waiting on you")).toBeVisible();
  expect(await page.getByText("Credit assistant release").count()).toBe(0);
  // ...and the server was asked again under B's session
  expect(approvalsRequests).toBe(2);
});

test("UIW-01: a wrong current password is shown on the form — the session is not treated as lost", async ({ page }) => {
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/auth/change-password") return json(route, { error: "current_password_incorrect" }, 401);
    return json(route, {});
  });
  await page.goto("/ui/account?section=password");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await page.getByLabel("Current password").fill("not-my-password");
  await page.getByLabel("New password").fill("a-new-long-passphrase-1");
  await page.getByLabel("Confirm", { exact: true }).fill("a-new-long-passphrase-1");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert")).toContainText("The current password is incorrect.");
  await expect(page).toHaveURL(/\/ui\/account/);
  await expect(page.getByLabel("Current password")).toBeVisible();
});

// UXJ-01: a failed list query renders an error with Retry, never the empty state.
// Five representative query-backed tables, each with its list endpoint failing.
const FAILING_LISTS: Array<{ page: string; endpoint: string; empty: string; recovered: unknown; present: string }> = [
  { page: "/ui/admin/users", endpoint: "/v1/users", empty: "No users yet", recovered: { users: [{ id: "u2", email: "riley@example.test", displayName: "Riley Reviewer" }] }, present: "Riley Reviewer" },
  { page: "/ui/admin/agents", endpoint: "/v1/agents", empty: "No agents registered", recovered: { agents: [{ id: "ag", name: "Credit assistant", provider: "mock", model: "mock-balanced", enabled: true, modes: ["chat"] }] }, present: "Credit assistant" },
  { page: "/ui/admin/roles", endpoint: "/v1/roles", empty: "No roles yet", recovered: { roles: [{ id: "r", name: "Reviewer", description: "", createdAt: "2026-10-02T12:00:00Z" }] }, present: "Reviewer" },
  { page: "/ui/admin/connectors", endpoint: "/v1/connectors", empty: "No connectors", recovered: { connectors: [{ id: "c", name: "GitHub", kind: "github", enabled: true }] }, present: "GitHub" },
  { page: "/ui/admin/mcp-servers", endpoint: "/v1/servers", empty: "No servers registered", recovered: { servers: [{ id: "s", name: "tools-mcp", baseUrl: "https://tools.example", enabled: true }] }, present: "tools-mcp" },
];
for (const c of FAILING_LISTS) {
  test(`UXJ-01: ${c.page} shows an error with Retry when ${c.endpoint} fails, not "${c.empty}"`, async ({ page }) => {
    let failing = true;
    await routeApi(page, async (route, p) => {
      if (p === "/auth/me") return json(route, authMe(USER_A));
      if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
      if (p === c.endpoint) return failing ? json(route, { error: "internal", detail: "database unavailable" }, 500) : json(route, c.recovered);
      return json(route, {});
    });
    await page.goto(c.page);
    const alert = page.getByRole("alert").filter({ hasText: "Couldn't load this list" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("internal — database unavailable");
    expect(await page.getByText(c.empty, { exact: true }).count()).toBe(0);
    // Retry re-asks the server; once it answers, the rows replace the error
    failing = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("cell", { name: c.present, exact: true }).first()).toBeVisible();
    await expect(alert).toHaveCount(0);
  });
}

test("UXJ-06: the intake opens blank — the worked example is loaded only on request", async ({ page }) => {
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/vendors") return json(route, { vendors: [] });
    return json(route, {});
  });
  await page.goto("/ui/admin/governance/intake");
  await expect(page.getByLabel("Use-case name")).toHaveValue("");
  await expect(page.getByLabel("What will the system do?")).toHaveValue("");
  await expect(page.getByLabel("Social scoring")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Draft suggestions" })).toBeDisabled();
  await page.getByRole("button", { name: "Fill in an example" }).click();
  await expect(page.getByLabel("Use-case name")).toHaveValue("Credit-limit-increase assistant");
  await expect(page.getByLabel("Social scoring")).toHaveValue("no");
  await expect(page.getByRole("button", { name: "Draft suggestions" })).toBeEnabled();
});
