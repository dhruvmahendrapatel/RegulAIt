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
