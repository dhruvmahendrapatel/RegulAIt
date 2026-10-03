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
    await expect(alert).toContainText("Something went wrong on the server");
    await expect(alert).toContainText("— database unavailable");
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

test("UIA-03 / UIB-02: a 400 validation refusal reads as field sentences — no raw zod text, no doubled code", async ({ page }) => {
  await routeApi(page, async (route, p, method) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/chatops/connections" && method === "POST")
      return json(route, { error: "validation", issues: [
        { path: ["name"], message: "String must contain at least 1 character(s)" },
        { path: ["connectorId"], message: "Invalid uuid" },
        { path: ["signingSecret"], message: "String must contain at least 8 character(s)" },
      ] }, 400);
    if (p === "/v1/chatops/connections") return json(route, { connections: [], posture: "" });
    if (p === "/v1/chatops/identity-links") return json(route, { links: [], posture: "" });
    if (p === "/v1/connectors") return json(route, { connectors: [] });
    return json(route, {});
  });
  await page.goto("/ui/admin/chatops");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const shown = page.getByText("Name is required; Connector ID is not a valid ID; Signing secret must be at least 8 characters").first();
  await expect(shown).toBeVisible();
  expect(await page.getByText(/validation —/).count()).toBe(0);
  expect(await page.getByText(/character\(s\)|Invalid uuid/).count()).toBe(0);
});

test("UIB-02: a negative virtual-key budget is refused on the form before any request is sent", async ({ page }) => {
  let posted = 0;
  await routeApi(page, async (route, p, method) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/virtual-keys" && method === "POST") { posted += 1; return json(route, { error: "validation", issues: [] }, 400); }
    if (p === "/v1/virtual-keys") return json(route, { keys: [] });
    if (p === "/v1/users") return json(route, { users: [] });
    return json(route, {});
  });
  await page.goto("/ui/admin/virtual-keys");
  await page.getByTestId("vk-name").fill("ci-runner");
  await page.getByTestId("vk-budget").fill("-5");
  await expect(page.getByText("Must be 0 or more")).toBeVisible();
  await expect(page.getByTestId("vk-issue")).toBeDisabled();
  expect(posted).toBe(0);
  await page.getByTestId("vk-budget").fill("5");
  await expect(page.getByTestId("vk-issue")).toBeEnabled();
});

test("UIA-01: an anchor past the chain head is reported as such — never as a red mismatch", async ({ page }) => {
  const verify = {
    status: "ok", algorithm: "sha256", payloadVersion: "regulait.audit.v1",
    genesis: { present: true, seq: 1, expectedRowHash: "a", actualRowHash: "a", matches: true },
    scanned: { fromSeq: 1, toSeq: 406, rows: 406, batches: 1, batchSize: 1000, bounded: false },
    legacy: { unchainedRowsBeforeGenesis: 0, covered: false, disclosure: "" },
    firstBreak: null,
    anchor: {
      checked: true, source: "worm_sink", tamperResistant: false, sinkMode: null, seq: 400,
      expectedRowHash: "b", actualRowHash: "b", matches: true, unanchoredRows: 6,
      disclosure: "The anchor compared against is NOT held on tamper-resistant storage.",
      aheadOfHead: { seq: 567, rowHash: "c", capturedAt: "2026-10-02T15:50:00.000Z", disclosure: "The anchor store also holds an anchor at seq 567, past this chain's head (seq 406). A chain never shrinks, so it was either captured from a different chain that shares this store or rows after it were removed from this one." },
    },
    limits: [],
  };
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/audit/verify") return json(route, verify);
    if (p === "/v1/audit/retention") return json(route, { retainedDays: null, prunable: 0, floorSource: [] });
    if (p === "/v1/audit") return json(route, { entries: [], pageSize: 0, hasMore: false, nextCursor: null });
    if (p === "/v1/users") return json(route, { users: [] });
    return json(route, {});
  });
  await page.goto("/ui/admin/audit");
  await page.getByRole("button", { name: "Verify chain" }).click();
  const report = page.getByTestId("chain-report");
  await expect(report.getByText("chain ok")).toBeVisible();
  await expect(report.getByText("Anchor matches")).toBeVisible();
  await expect(report.getByText("Anchor past chain head (seq 567)")).toBeVisible();
  await expect(report.getByTestId("anchor-ahead")).toContainText("different chain that shares this store");
  expect(await report.getByText("Anchor mismatch").count()).toBe(0);
  expect(await report.getByText("worm_sink").count()).toBe(0);
});

test("UIA-02: the audit log says how many rows are shown and loads older pages on request", async ({ page }) => {
  const entry = (i: number) => ({ id: `e${i}`, at: new Date(Date.UTC(2026, 9, 2, 12, 0, 0) - i * 60_000).toISOString(), userId: USER_A.id, objectType: "mcp_tool", effect: "allow", ruleId: "grant", reason: `row ${i}`, deployMode: null });
  const page1 = Array.from({ length: 100 }, (_, i) => entry(i));
  const page2 = Array.from({ length: 6 }, (_, i) => entry(100 + i));
  let cursorRequests = 0;
  await routeApi(page, async (route, p) => {
    const url = new URL(route.request().url());
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/audit/retention") return json(route, { retainedDays: null, prunable: 0, floorSource: [] });
    if (p === "/v1/audit") {
      if (url.searchParams.get("cursor") === "c1") { cursorRequests += 1; return json(route, { entries: page2, pageSize: 6, hasMore: false, nextCursor: null }); }
      return json(route, { entries: page1, pageSize: 100, hasMore: true, nextCursor: "c1" });
    }
    if (p === "/v1/users") return json(route, { users: [{ id: USER_A.id, email: USER_A.email, displayName: USER_A.displayName }] });
    return json(route, {});
  });
  await page.goto("/ui/admin/audit");
  const paging = page.getByTestId("audit-paging");
  await expect(paging).toContainText("Showing the newest 100 rows — older rows exist");
  expect(await page.getByRole("cell", { name: "row 105" }).count()).toBe(0);
  await paging.getByRole("button", { name: "Load older" }).click();
  await expect(paging).toContainText("Showing all 106 rows");
  await expect(page.getByRole("cell", { name: "row 105" })).toBeVisible();
  expect(cursorRequests).toBe(1);
  expect(await paging.getByRole("button", { name: "Load older" }).count()).toBe(0);
});
