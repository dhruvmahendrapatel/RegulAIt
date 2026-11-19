/**
 * D2 (ADR-0331) — MCP server removals, a sub-page of Discovery sources
 * (`/admin/shadow-ai/discovery-sources/addon-removals`): the request (an `endpoint_remediation` step-up, then a second
 * administrator's approval), the org switch (off by default: a warning and a disabled request; turning it on is a
 * `settings_relax` step-up), the list newest first with per-status target counts, the per-endpoint detail and Cancel
 * (no step-up). Every /v1 and /auth call is answered by an in-test mock that follows
 * apps/gateway/src/endpoint-addon-removal.ts: shapes, the list contract, `enabled` / `signerConfigured` and the
 * refusals. Synthetic names, pseudonyms and ids only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const uuid = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ME_ID = uuid("80000000", 1);
const REVIEWER = uuid("80000000", 2);
const DISABLED_ADMIN = uuid("80000000", 3);
const MEMBER = uuid("80000000", 4);
const ME = { userId: ME_ID, isAdmin: true, user: { id: ME_ID, email: "ada@example.test", displayName: "Ada Admin" } };
const NOW = "2026-11-19T10:00:00.000Z";
const LATER = "2026-11-26T10:00:00.000Z";
const OVERVIEW = "/ui/admin/shadow-ai/discovery-sources";
const PAGE = `${OVERVIEW}/addon-removals`;
const DEVICE_A = uuid("81000000", 1);
const DEVICE_B = uuid("81000000", 2);
const RUNNING = uuid("82000000", 1);

const users = [
  { id: ME_ID, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null },
  { id: REVIEWER, email: "riley@example.test", displayName: "Riley Reviewer", isAdmin: true, disabledAt: null },
  { id: DISABLED_ADMIN, email: "gone@example.test", displayName: "Gone Admin", isAdmin: true, disabledAt: NOW },
  { id: MEMBER, email: "mo@example.test", displayName: "Mo Member", isAdmin: false, disabledAt: null },
].map((u) => ({ ...u, createdAt: NOW, totpEnabled: true, hasPassword: true, mustChangePassword: false }));

const mcpRow = (i: number, deviceId: string, psn: string, name: string, pkg: string, risks: string[]) => ({
  id: uuid("83000000", i), deviceId, devicePseudonym: psn, hostApp: { signatureId: "sig-1", provider: "generic" }, serverName: name, transport: "stdio",
  command: "npx", package: pkg, packageVersion: null, host: null, identity: { kind: "package", value: pkg }, disabled: false, risks, riskyTools: [], secretTypes: [],
  registry: { status: "unregistered", mcpServerId: null, mcpServerName: null }, verdict: "Not in the registry.", findingId: null, lastSeenAt: NOW,
});
const MCP_ROWS = [
  mcpRow(1, DEVICE_A, "psn:aaaaaaaaaaaaaaaaaaaaaaaa", "acme-files", "acme-fs-mcp", ["host_root_mount"]),
  mcpRow(2, DEVICE_B, "psn:bbbbbbbbbbbbbbbbbbbbbbbb", "acme-files", "acme-fs-mcp", ["host_root_mount"]),
  mcpRow(3, DEVICE_A, "psn:aaaaaaaaaaaaaaaaaaaaaaaa", "acme-notes", "acme-notes-mcp", []),
];

const TRANSITIONS: Record<string, string[]> = { approve: ["awaiting_approval"], deny: ["awaiting_approval"], go_stale: ["awaiting_approval"], cancel: ["awaiting_approval", "active"] };
const lifecycle = (status: string) => ({
  machine: "endpoint_addon_removal",
  state: status,
  terminal: ["denied", "stale", "cancelled"].includes(status),
  transitions: Object.entries(TRANSITIONS).map(([event, from]) => ({ event, to: "x", by: ["admin"], summary: event, allowed: from.includes(status), ...(from.includes(status) ? {} : { reason: "not from here" }) })),
});
const counts = (c: Partial<Record<string, number>>) => {
  const base = { pending: 0, delivered: 0, removed: 0, nothing_to_remove: 0, failed: 0, cancelled: 0, ...c };
  return { ...base, total: Object.values(base).reduce((a, b) => a + b, 0) };
};
interface Removal {
  id: string;
  createdBy: string;
  createdAt: string;
  identity: string;
  serverName: string | null;
  status: string;
  targets: ReturnType<typeof counts>;
  reason: string;
}
const view = (r: Removal) => ({
  id: r.id, createdBy: r.createdBy, createdAt: r.createdAt, action: "remove_mcp_server", identityKind: "package", identity: r.identity, packageVersion: null,
  serverName: r.serverName, scope: { kind: "recent", days: 30 }, blockReinstall: true, blockEnforced: false, reason: r.reason, expiresAt: LATER,
  cancelledAt: r.status === "cancelled" ? NOW : null, cancelledBy: r.status === "cancelled" ? ME_ID : null, approvalId: uuid("84000000", 1),
  status: r.status, state: r.status, lifecycle: lifecycle(r.status), targets: r.targets,
});
interface Target {
  id: string;
  devicePseudonym: string;
  status: string;
  code: string | null;
  notified: boolean | null;
}
const TARGETS: Target[] = [
  { id: uuid("85000000", 1), devicePseudonym: "psn:dev000000000000000000003", status: "removed", code: "removed", notified: true },
  { id: uuid("85000000", 2), devicePseudonym: "psn:dev000000000000000000007", status: "failed", code: "parse_failed", notified: false },
  { id: uuid("85000000", 3), devicePseudonym: "psn:dev000000000000000000009", status: "delivered", code: null, notified: null },
  { id: uuid("85000000", 4), devicePseudonym: "psn:dev000000000000000000011", status: "pending", code: null, notified: null },
  { id: uuid("85000000", 5), devicePseudonym: "psn:dev000000000000000000013", status: "pending", code: null, notified: null },
];
const targetView = (t: Target) => ({
  ...t, deviceId: DEVICE_A, identityId: uuid("86000000", 1), deviceUserPseudonym: "psn:usr000000000000000000001", provider: "generic",
  config: { root: "home", path: ".config/acme/mcp.json" }, serverName: "shell-exec-any", deliveredAt: t.status === "pending" ? null : NOW, reportedAt: t.code ? NOW : null,
});

interface Opts {
  enabled?: boolean;
  signer?: boolean;
}
interface Calls {
  all: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
}
async function mockApi(page: Page, opts: Opts = {}): Promise<Calls> {
  const calls: Calls = { all: [] };
  const settings = { credentialWarningAgeDays: 90, endpointRetentionDays: 90, endpointAddonRemoval: opts.enabled ?? true, version: 4 };
  const targets = TARGETS.map((t) => ({ ...t }));
  const removals: Removal[] = [
    { id: RUNNING, createdBy: REVIEWER, createdAt: "2026-11-17T16:40:00.000Z", identity: "shell-exec-any", serverName: "shell-exec-any", status: "active", targets: counts({ removed: 1, failed: 1, delivered: 1, pending: 2 }), reason: "Runs any shell command." },
    { id: uuid("82000000", 2), createdBy: ME_ID, createdAt: "2026-11-12T09:05:00.000Z", identity: "cookie-reader-mcp", serverName: "browser-cookie-reader", status: "cancelled", targets: counts({ removed: 2, cancelled: 6 }), reason: "Reads browser cookies." },
  ];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (req.resourceType() === "document" || (!path.startsWith("/v1") && !path.startsWith("/auth"))) return route.continue();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    calls.all.push({ method: req.method(), path, headers: req.headers(), body });
    if (path === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (path === "/v1/me") return json(route, ME);
    if (path === "/v1/users") return json(route, { users });
    if (path === "/v1/discovery/settings" && req.method() === "GET") return json(route, settings);
    if (path === "/v1/discovery/settings" && req.method() === "PUT") {
      const b = body as { version: number; endpointAddonRemoval?: boolean };
      if (b.version !== settings.version) return json(route, { error: "version_conflict", detail: "reload" }, 409);
      if (b.endpointAddonRemoval !== undefined) settings.endpointAddonRemoval = b.endpointAddonRemoval;
      settings.version += 1;
      return json(route, settings);
    }
    if (path === "/v1/discovery/endpoint-mcp-servers") {
      const risky = url.searchParams.get("risky") === "true";
      return json(route, { enabled: true, posture: "Endpoint MCP config discovery is on.", items: MCP_ROWS.filter((r) => !risky || r.risks.length > 0), nextCursor: null });
    }
    if (path === "/v1/discovery/endpoint-addon-removals" && req.method() === "GET") {
      const items = [...removals].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(view);
      return json(route, { items, nextCursor: null, nextOffset: null, total: url.searchParams.get("count") ? items.length : null, totalIsEstimate: false, enabled: settings.endpointAddonRemoval, signerConfigured: opts.signer ?? true });
    }
    if (path === "/v1/discovery/endpoint-addon-removals" && req.method() === "POST") {
      if (!settings.endpointAddonRemoval) return json(route, { error: "addon_removal_disabled", detail: "removing MCP servers from endpoints is off" }, 403);
      const b = body as { approverUserId: string; reason: string; identity: string; serverName?: string };
      if (b.approverUserId === ME_ID) return json(route, { error: "approver_is_requester", detail: "a second administrator" }, 422);
      const r: Removal = { id: uuid("82000000", 9), createdBy: ME_ID, createdAt: NOW, identity: b.identity, serverName: b.serverName ?? null, status: "awaiting_approval", targets: counts({}), reason: b.reason };
      removals.push(r);
      return json(route, { removal: view(r), resolved: 3, devices: 2 }, 201);
    }
    const one = /^\/v1\/discovery\/endpoint-addon-removals\/([^/]+)$/.exec(path);
    if (one && req.method() === "GET") {
      const r = removals.find((x) => x.id === one[1]);
      if (!r) return json(route, { error: "not_found", detail: "no such removal" }, 404);
      return json(route, { removal: view(r), targets: { items: r.id === RUNNING ? targets.map(targetView) : [], nextCursor: null, nextOffset: null, total: null, totalIsEstimate: false } });
    }
    const cancel = /^\/v1\/discovery\/endpoint-addon-removals\/([^/]+)\/cancel$/.exec(path);
    if (cancel && req.method() === "POST") {
      const r = removals.find((x) => x.id === cancel[1]);
      if (!r) return json(route, { error: "not_found", detail: "no such removal" }, 404);
      if (r.status === "cancelled") return json(route, { removal: view(r), cancelled: 0, alreadyCancelled: true });
      let stopped = 0;
      if (r.id === RUNNING) for (const t of targets) if (t.status === "pending") { t.status = "cancelled"; stopped += 1; }
      r.status = "cancelled";
      const { total: _total, ...c } = r.targets;
      r.targets = counts({ ...c, pending: 0, cancelled: c.cancelled + c.pending });
      return json(route, { removal: view(r), cancelled: stopped, alreadyCancelled: false });
    }
    if (path === "/v1/discovery/sources") return json(route, { sources: [], posture: { sourcesTotal: 0, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "No discovery source." } });
    if (path === "/v1/discovery/scanners") return json(route, { kinds: [] });
    if (path === "/v1/discovery/federation") return json(route, { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} });
    if (path === "/v1/discovery/runs") return json(route, { items: [], nextCursor: null, nextOffset: null, total: 0, totalIsEstimate: false, failed: 0 });
    return json(route, {});
  });
  return calls;
}

const form = (p: Page) => p.getByTestId("removal-request");
const removalRow = (p: Page, name: string) => p.getByTestId("removals").locator("tbody tr").filter({ hasText: name });

test.use({ viewport: { width: 1440, height: 1000 } });

test("the MCP servers card links to Removals, and a flagged row opens the request with its server and device", async ({ page }) => {
  await mockApi(page);
  await page.goto(OVERVIEW);
  const card = page.getByTestId("endpoint-mcp-card").locator("xpath=ancestor::section[@data-rg-card][1]");
  await expect(card.getByRole("link", { name: "Removals" })).toHaveAttribute("href", PAGE);
  // only a flagged row offers it
  await expect(page.getByRole("link", { name: /^Request removal, acme-notes/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Request removal, acme-files on psn:aaaaaaaaaaaaaaaaaaaaaaaa" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "MCP server removals" })).toBeVisible();
  await expect(form(page).getByLabel("Flagged MCP server")).toHaveValue(/acme-fs-mcp/);
  await expect(form(page).getByLabel("Endpoints", { exact: true })).toHaveValue("device");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("MCP servers on employee machines");
});

test("while the org switch is off the page warns and the request is disabled; turning it on asks to confirm it's you", async ({ page }) => {
  const calls = await mockApi(page, { enabled: false, signer: false });
  const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/discovery/settings", kind: "settings_relax", when: (b) => (b as { endpointAddonRemoval?: boolean }).endpointAddonRemoval === true });
  await page.goto(PAGE);
  const warning = page.getByTestId("removal-off");
  await expect(warning).toContainText("Removal is off for this organisation.");
  await expect(form(page).getByRole("button", { name: "Request removal" })).toBeDisabled();
  await expect(form(page)).toContainText("Turn removal on above before you request one.");
  // no directive can be signed yet: said, not hidden
  await expect(page.getByTestId("signer-missing")).toContainText("nothing reaches a device");
  await expectAxeClean(page, "MCP server removals, switched off");
  await warning.getByRole("button", { name: "Turn removal on…" }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[0]!.body).toEqual({ version: 4, endpointAddonRemoval: true });
  await expect(warning).toHaveCount(0);
  await expect(form(page).getByRole("button", { name: "Request removal" })).toBeEnabled();
  expect(calls.all.filter((c) => c.method === "POST" && c.path === "/v1/discovery/endpoint-addon-removals")).toHaveLength(0);
});

test("a request asks to confirm it's you, then waits for the second administrator", async ({ page }) => {
  await mockApi(page);
  const su = await requireStepUpOn(page, { method: "POST", path: "/v1/discovery/endpoint-addon-removals", kind: "endpoint_remediation" });
  await page.goto(PAGE);
  const f = form(page);
  await f.getByLabel("Flagged MCP server").selectOption({ index: 1 });
  // the approver is another active administrator: never you, a disabled admin or a member
  const approver = f.getByLabel("Approver (another admin)");
  await expect(approver.locator("option")).toHaveText(["Choose an administrator", "Riley Reviewer"]);
  await expect(f).toContainText("Then waits for the approver");
  await f.getByRole("button", { name: "Request removal" }).click();
  await expect(f).toContainText("Choose the administrator who approves it.");
  await approver.selectOption({ label: "Riley Reviewer" });
  await expect(f).toContainText("Asks you to confirm it's you");
  await expect(f).toContainText("Then waits for Riley Reviewer");
  await f.getByLabel("Reason (shown to the approver and in the audit log)").fill("Mounts the host root; flagged by the MCP risk scan.");
  await f.getByRole("button", { name: "Request removal" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toBeVisible();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[0]!.body).toEqual({
    identityKind: "package",
    identity: "acme-fs-mcp",
    serverName: "acme-files",
    scope: { kind: "recent", days: 30 },
    blockReinstall: true,
    approverUserId: REVIEWER,
    reason: "Mounts the host root; flagged by the MCP risk scan.",
  });
  await expect(page.getByTestId("removal-requested")).toHaveText("Requested: 3 config entries on 2 endpoints. Waiting for Riley Reviewer to approve it.");
  const row = removalRow(page, "acme-files");
  await expect(row).toContainText("Awaiting approval");
  await expect(row).toContainText("written on approval");
  await expect(page.getByTestId("removals")).toContainText("shell-exec-any");
});

test("the detail shows each endpoint's outcome, and Cancel stops the undelivered ones without a step-up", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(PAGE);
  const running = removalRow(page, "shell-exec-any");
  await expect(running).toContainText("Running");
  await expect(running).toContainText("1 removed");
  await expect(running).toContainText("1 failed");
  await expect(running).toContainText("2 pending");
  // newest first
  await expect(page.getByTestId("removals").locator("tbody tr").first()).toContainText("shell-exec-any");
  // a cancelled removal has no Cancel
  await expect(page.getByRole("button", { name: "Cancel, browser-cookie-reader" })).toHaveCount(0);
  await page.getByRole("button", { name: "Details, shell-exec-any" }).click();
  const detail = page.getByTestId("removal-detail");
  await expect(detail.locator("tbody tr")).toHaveCount(5);
  const failed = detail.locator("tbody tr").filter({ hasText: "psn:dev000000000000000000007" });
  await expect(failed).toContainText("failed");
  await expect(failed).toContainText("parse_failed");
  await expect(failed).toContainText("No");
  await expect(detail.locator("tbody tr").filter({ hasText: "psn:dev000000000000000000003" })).toContainText("Yes");
  await expect(detail).toContainText("Cancelling stops the 2 pending endpoints. The 3 already reached keep their outcome. No step-up; audited.");
  await expectAxeClean(page, "MCP server removals, detail");

  await page.getByRole("button", { name: "Cancel removal" }).click();
  const confirm = page.getByRole("dialog", { name: "Cancel the removal of shell-exec-any?" });
  await expect(confirm).toContainText("keep their real outcome");
  await confirm.getByRole("button", { name: "Cancel removal" }).click();
  await expect(running).toContainText("Cancelled");
  const post = calls.all.find((c) => c.method === "POST" && c.path === `/v1/discovery/endpoint-addon-removals/${RUNNING}/cancel`);
  expect(post).toBeTruthy();
  expect(post!.headers["x-regulait-step-up"]).toBeUndefined();
  // the delivered one keeps its outcome; only the pending two stopped
  await expect(detail.locator("tbody tr").filter({ hasText: "psn:dev000000000000000000009" })).toContainText("delivered");
  await expect(detail.locator("tbody tr").filter({ hasText: "stopped" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Cancel removal" })).toHaveCount(0);
});
