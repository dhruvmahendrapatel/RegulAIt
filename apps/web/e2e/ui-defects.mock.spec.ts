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
  await page.getByText("Use-case name", { exact: true }).click();
  await expect(page.getByLabel("Use-case name")).toBeFocused();
  // ADR-0168: the field explains itself in a hint under it, read as its description
  await expect(page.getByLabel("Use-case name")).toHaveAccessibleDescription(/A name reviewers will recognize/);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  // the classification also opens blank: reach it with a name and purpose typed in
  await page.getByLabel("Use-case name").fill("Blank check");
  await page.getByLabel("What will the system do?").fill("Checks that nothing is pre-selected.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Social scoring")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Draft suggestions" })).toBeDisabled();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Fill in an example" }).click();
  await expect(page.getByLabel("Use-case name")).toHaveValue("Credit-limit-increase assistant");
  await page.getByRole("button", { name: "Continue" }).click();
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

  // On a TAMPER-RESISTANT store the same fact withholds the verdict: a
  // truncated tail looks exactly like this, so it must never read green.
  const withheld = {
    ...verify,
    anchor: {
      ...verify.anchor,
      tamperResistant: true,
      sinkMode: "compliance",
      matches: null,
      disclosure: "The anchor compared against is held outside this database.",
      aheadOfHead: { ...verify.anchor.aheadOfHead, disclosure: "The tamper-resistant anchor store holds an anchor at seq 567, past this chain's head (seq 406). A chain never shrinks: either rows after the head were removed from this chain — a break — or another chain shares this store. Verification cannot tell which, so this chain is NOT reported as verified." },
    },
  };
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/audit/verify") return json(route, withheld);
    if (p === "/v1/audit/retention") return json(route, { retainedDays: null, prunable: 0, floorSource: [] });
    if (p === "/v1/audit") return json(route, { entries: [], pageSize: 0, hasMore: false, nextCursor: null });
    if (p === "/v1/users") return json(route, { users: [] });
    return json(route, {});
  });
  await page.getByRole("button", { name: "Re-verify" }).click();
  await expect(report.getByText("Not verified — anchor past chain head (seq 567)")).toBeVisible();
  await expect(report.getByTestId("anchor-ahead")).toContainText("NOT reported as verified");
  expect(await report.getByText("Anchor matches").count()).toBe(0);
  expect(await report.getByText("Anchor past chain head (seq 567)", { exact: true }).count()).toBe(0);
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

test("UIW-07: an empty change description cannot be started — nothing is posted as 'untitled change'", async ({ page }) => {
  let posted = 0;
  await routeApi(page, async (route, p, method) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/workflows/instances" && method === "POST") { posted += 1; return json(route, { id: "wf-new" }, 201); }
    if (p === "/v1/workflows/instances") return json(route, { instances: [], changeTypes: ["feature", "deploy-demo"], routes: [{ changeType: "feature", templates: ["pipeline-demo"] }] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    return json(route, {});
  });
  await page.goto("/ui/workflows");
  const start = page.getByRole("button", { name: "Start workflow" });
  await expect(start).toBeDisabled();
  // UIW-09: the type select and the routing hint carry names, not identifiers
  await expect(page.getByLabel("Type")).toContainText("Deploy demo");
  await expect(page.getByText("→ runs the “Pipeline demo” workflow")).toBeVisible();
  await page.getByLabel("Describe the change").fill("Tighten the checkout retry budget");
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page).toHaveURL(/\/ui\/workflows\/wf-new/);
  expect(posted).toBe(1);
});

test("UIW-02 / UIW-09: the workflow page names its stages and renders the questionnaire as a document", async ({ page }) => {
  const content = [
    "# AI use-case intake questionnaire", "", "## 1. Purpose and business context", "Recommends credit-limit increases with human review.", "",
    "## 9. EU AI Act risk screening (structured, ADR-0085)", "```eu-ai-act-answers",
    JSON.stringify({ purposeDomain: "essential-services", affectedPersons: ["customers"], decisionAutonomy: "human-reviews", biometricUse: "none", emotionRecognition: false, socialScoring: false, manipulativeTechniques: false, profilesNaturalPersons: true, safetyComponent: false, interactsWithHumans: true, generatesSyntheticContent: true }),
    "```", "",
  ].join("\n");
  const detail = {
    instance: {
      id: "wf-1", status: "blocked_on_approval", createdAt: "2026-10-02T12:00:00Z", initiatorUserId: USER_A.id,
      change: { description: "Govern the credit assistant", changeType: "ai-use-case-intake", environment: "staging" },
      definition: { stages: [{ id: "intake", type: "trigger" }, { id: "plan", type: "planning" }, { id: "questionnaire", type: "artifact_generation", output: "use_case_questionnaire" }, { id: "signoff", type: "human_approval" }] },
      state: { currentStageIndex: 3, stageStatuses: { 0: "completed", 1: "completed", 2: "completed", 3: "running" } },
      context: {},
    },
    artifacts: [{ id: "a1", output: "use_case_questionnaire", version: 1, content }],
    pendingApprovals: [],
  };
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/workflows/instances/wf-1") return json(route, detail);
    if (p === "/v1/approvals") return json(route, { approvals: [] });
    return json(route, {});
  });
  await page.goto("/ui/workflows/wf-1");
  const chip = page.locator('[title="questionnaire · artifact_generation"]');
  await expect(chip).toHaveText("QuestionnaireArtifact generation");
  await expect(page.locator('[title="signoff · human_approval"]')).toHaveText("Sign-offHuman approval");
  expect(await page.getByText("artifact_generation").count()).toBe(0);
  expect(await page.getByText("use_case_questionnaire").count()).toBe(0);
  await page.getByText("Use case questionnaire (v1)").click();
  await expect(page.locator("p", { hasText: "Recommends credit-limit increases with human review." })).toBeVisible();
  // the fenced JSON is read as a labelled list; the raw markdown (fence, JSON,
  // platform aside) stays behind "View source", not on the page
  await expect(page.getByText("Essential services", { exact: false }).first()).toBeVisible();
  await expect(page.locator("pre", { hasText: "eu-ai-act-answers" })).toBeHidden();
  await expect(page.getByText("ADR-0085").locator("visible=true")).toHaveCount(0);
  await expect(page.getByText("\"purposeDomain\"").locator("visible=true")).toHaveCount(0);
});

test("UXJ-02: selecting the lowest alert brings its detail into the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const alert = (i: number) => ({
    id: `al-${i}`, ruleId: "use_case_inherited_high_risk", ruleLabel: "Approved use case carries a high rating", severity: "high", status: "open",
    subject: { key: `use_case:${i}`, type: "use_case", id: `uc-${i}`, label: `Use case ${i}`, context: null },
    title: i === 11 ? "Model in production without an approved model card" : `Use case ${i} inherits a HIGH rating`,
    detail: { pathLabels: [] }, firstDetectedAt: "2026-10-02T10:00:00Z", lastDetectedAt: "2026-10-02T12:00:00Z", acknowledgedAt: null, acknowledgedBy: null, ackNote: null, resolvedAt: null,
  });
  const alerts = Array.from({ length: 12 }, (_, i) => alert(i));
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/governance/alerts") return json(route, { alerts, counts: { open: 12, acknowledged: 0, resolved: 0 }, lastEvaluatedAt: "2026-10-02T12:00:00Z", rules: [] });
    if (p.startsWith("/v1/governance/alerts/") && p.endsWith("/remediation")) return json(route, { alert: alerts[11], candidates: [], proposals: [], note: "" });
    return json(route, {});
  });
  await page.goto("/ui/admin/governance/alerts");
  const last = page.getByRole("button", { name: /without an approved model card/ });
  await last.scrollIntoViewIfNeeded();
  await last.click();
  const detail = page.getByTestId("alert-detail");
  await expect(detail.getByText("Use case 11", { exact: true })).toBeVisible();
  const box = await detail.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(768);
});

test("UIA-04: a long fingerprint wraps inside its stat tile instead of being clipped", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const fp = "dk1:79a20fde8909002a635b1c4d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f";
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/security/data-key") return json(route, { fingerprint: fp, recordedFingerprint: fp, recordedAt: "2026-10-02T12:00:00Z", lastVerifiedAt: null, rotatedFrom: null, rotatedAt: null, matches: true, attested: false, attestationCount: 0, latestAttestation: null, warnings: [], derivation: "sha256" });
    if (p === "/v1/security/data-key/attestations") return json(route, { attestations: [] });
    return json(route, {});
  });
  await page.goto("/ui/admin/data-key");
  const codes = page.locator("code", { hasText: fp });
  await expect(codes).toHaveCount(2);
  const clipped = await codes.evaluateAll((els) =>
    els.map((el) => {
      const tile = el.parentElement!;
      return { scroll: tile.scrollWidth, client: tile.clientWidth, right: el.getBoundingClientRect().right, tileRight: tile.getBoundingClientRect().right };
    }),
  );
  for (const c of clipped) {
    expect(c.scroll).toBeLessThanOrEqual(c.client + 1);
    expect(c.right).toBeLessThanOrEqual(c.tileRight + 1);
  }
});

test("UIW-06: at phone width the run page's header actions wrap under the title instead of over it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const run = {
    run: {
      id: "run-1", name: "checkout-refactor", status: "running", createdAt: "2026-10-02T12:00:00Z", initiatingUserId: USER_A.id,
      graph: { nodes: [{ id: "n1", title: "Plan the refactor", instruction: "Plan it", ownerAgentId: "ag" }] },
      state: { nodeStatuses: { n1: "in_progress" }, owners: { n1: "ag" } },
    },
    events: [],
    pendingApprovals: [],
  };
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, authMe(USER_A));
    if (p === "/v1/me") return json(route, { userId: USER_A.id, isAdmin: true, user: USER_A });
    if (p === "/v1/runs/run-1") return json(route, run);
    if (p === `/v1/users/${USER_A.id}/agents`) return json(route, { agents: [], defaultAgentId: null });
    if (p === "/v1/pm/links") return json(route, { links: [] });
    if (p === "/v1/decisions") return json(route, { decisions: [] });
    return json(route, {});
  });
  await page.goto("/ui/runs/run-1");
  const h1 = page.getByRole("heading", { level: 1, name: "checkout-refactor" });
  await expect(h1).toBeVisible();
  const abort = page.getByRole("button", { name: "Abort run" });
  await expect(abort).toBeVisible();
  const title = (await h1.boundingBox())!;
  for (const name of ["Auto-advance", "Abort run"]) {
    const b = (await page.getByRole("button", { name }).boundingBox())!;
    const overlaps = b.x < title.x + title.width && b.x + b.width > title.x && b.y < title.y + title.height && b.y + b.height > title.y;
    expect(overlaps, `${name} overlaps the title`).toBe(false);
  }
  // the title keeps a readable width — it is no longer squeezed beside the buttons
  expect(title.width).toBeGreaterThan(150);
});

test("UIW-03: a non-admin on an admin URL sees the Workspace navigation beside the refusal, not the admin rail", async ({ page }) => {
  await routeApi(page, async (route, p) => {
    if (p === "/auth/me") return json(route, { ...authMe(USER_B), isAdmin: false });
    if (p === "/v1/me") return json(route, { userId: USER_B.id, isAdmin: false, user: USER_B });
    if (p === "/v1/users") return json(route, { error: "admin_only" }, 403);
    return json(route, {});
  });
  await page.goto("/ui/admin/users");
  await expect(page.getByText("This is an administrative surface and your account does not hold the administrator role.", { exact: false })).toBeVisible();
  expect(await page.getByText("Identity & access", { exact: false }).count()).toBe(0);
  expect(await page.getByRole("link", { name: "Virtual keys" }).count()).toBe(0);
  await expect(page.getByRole("link", { name: "Inbox", exact: true }).first()).toBeVisible();
});
