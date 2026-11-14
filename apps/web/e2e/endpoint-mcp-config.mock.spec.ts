/**
 * MCP servers on employee machines, on the Discovery sources page: the inventory read through the endpoint agent
 * (GET /v1/discovery/endpoint-mcp-servers), the admin link to an approved server and its removal (POST …-links,
 * POST …-links/remove), and the org switch under Settings (PUT /v1/discovery/settings, `settings_relax` step-up to
 * turn it on, none to turn it off). Every /v1 and /auth call is answered by an in-test mock that follows
 * apps/gateway/src/endpoint-mcp-config.ts and discovery-routes.ts: shapes, keyset cursor, filters and the 404s.
 * Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const uuid = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ME = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
const NOW = "2026-11-10T10:00:00.000Z";
const DEVICE_A = uuid("61000000", 1);
const DEVICE_B = uuid("61000000", 2);
const APPROVED = uuid("62000000", 1);
const HELD = uuid("62000000", 2);
const UNSCANNED = uuid("62000000", 3);
const CLEARED = uuid("62000000", 4);
const FINDING = uuid("63000000", 1);
const ON = "Endpoint MCP config discovery is on: enrolled endpoint agents read the MCP host configs the signed collection pack names, read-only.";
const OFF = "Endpoint MCP config discovery is off: no endpoint agent reads MCP host configs, and any such fact a device sends is refused, not stored.";

type Kind = "package" | "host" | "command";
interface Row {
  id: string;
  deviceId: string;
  devicePseudonym: string;
  serverName: string;
  kind: Kind;
  value: string;
  risks: string[];
  secretTypes: string[];
  host?: string;
}
// 30 rows: the first page (25) and a second one behind the cursor
const ROWS: Row[] = Array.from({ length: 30 }, (_, i) => ({
  id: uuid("60000000", i + 1),
  deviceId: i % 2 ? DEVICE_B : DEVICE_A,
  devicePseudonym: i % 2 ? "psn:bbbbbbbbbbbbbbbbbbbbbbbb" : "psn:aaaaaaaaaaaaaaaaaaaaaaaa",
  serverName: i === 0 ? "acme-files" : i === 1 ? "acme-shell" : i === 2 ? "acme-remote" : `acme-tool-${i}`,
  kind: i === 1 ? "command" : i === 2 ? "host" : "package",
  value: i === 1 ? "acme-runner" : i === 2 ? "mcp.example.test" : `acme-mcp-${i}`,
  risks: i === 0 ? ["unpinned_package", "secret_in_args"] : [],
  secretTypes: i === 0 ? ["generic-api-key"] : [],
  host: i === 2 ? "mcp.example.test" : undefined,
}));

interface Opts {
  enabled?: boolean;
  empty?: boolean;
  failList?: number;
  linkNotFound?: boolean;
}
async function mockApi(page: Page, opts: Opts = {}) {
  const calls: Array<{ method: string; path: string; q: URLSearchParams; body: unknown }> = [];
  const links = new Map<string, string>(); // `${kind}\0${value}` -> server id
  let enabled = opts.enabled ?? true;
  let version = 1;
  let failList = opts.failList ?? 0;
  const status = (r: Row) => (links.has(`${r.kind}\0${r.value}`) ? "linked" : r.host === "mcp.example.test" ? "registered" : "unregistered");
  const view = (r: Row) => {
    const st = status(r);
    const sid = st === "linked" ? links.get(`${r.kind}\0${r.value}`)! : st === "registered" ? APPROVED : null;
    return {
      id: r.id, deviceId: r.deviceId, devicePseudonym: r.devicePseudonym,
      hostApp: { signatureId: "sig-desktop", provider: "acme_desktop" },
      config: { root: "home", path: ".acme/mcp.json" },
      serverName: r.serverName,
      transport: r.host ? "http" : "stdio",
      command: r.kind === "command" ? r.value : r.host ? null : "npx",
      package: r.kind === "package" ? r.value : null,
      packageVersion: r.kind === "package" && r.risks.length === 0 ? "1.0.0" : null,
      host: r.host ?? null,
      identity: { kind: r.kind, value: r.value },
      disabled: false, risks: r.risks, riskyTools: r.risks.length ? ["write_file"] : [], autoApprovedTools: [], secretTypes: r.secretTypes,
      registry: { status: st, mcpServerId: sid, mcpServerName: sid ? "Acme approved files" : null },
      verdict: st === "unregistered" ? "UNREGISTERED: this MCP server matches no server in this deployment's registry." : st === "linked" ? "Linked by an admin to the approved server 'Acme approved files'." : "Its host is the registered server 'Acme approved files'.",
      findingId: r.serverName === "acme-files" ? FINDING : null,
      firstSeenAt: NOW, lastSeenAt: NOW,
    };
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ method, path: p, q: url.searchParams, body });
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p === "/v1/discovery/endpoint-mcp-servers") {
      if (failList > 0) { failList -= 1; return json(route, { error: "internal_error" }, 500); }
      const q = url.searchParams;
      const limit = Number(q.get("limit") ?? 50);
      let rows = opts.empty || !enabled ? [] : [...ROWS];
      if (q.get("status")) rows = rows.filter((r) => status(r) === q.get("status"));
      if (q.get("risky") === "true") rows = rows.filter((r) => r.risks.length > 0);
      if (q.get("secrets") === "true") rows = rows.filter((r) => r.secretTypes.length > 0);
      if (q.get("deviceId")) rows = rows.filter((r) => r.deviceId === q.get("deviceId"));
      const cursor = q.get("cursor");
      if (cursor) rows = rows.filter((r) => r.id > cursor);
      const pageRows = rows.slice(0, limit);
      return json(route, { enabled, posture: enabled ? ON : OFF, items: pageRows.map(view), nextCursor: rows.length > limit ? pageRows[pageRows.length - 1]!.id : null });
    }
    if (p === "/v1/discovery/endpoint-mcp-server-links" && method === "POST") {
      const b = body as { identityKind: Kind; identity: string; mcpServerId: string };
      if (opts.linkNotFound) return json(route, { error: "mcp_server_not_found", detail: "no MCP server with that id is registered; register it first" }, 404);
      links.set(`${b.identityKind}\0${b.identity}`, b.mcpServerId);
      return json(route, { identityKind: b.identityKind, identity: b.identity, mcpServerId: b.mcpServerId, mcpServerName: "Acme approved files" }, 201);
    }
    if (p === "/v1/discovery/endpoint-mcp-server-links/remove" && method === "POST") {
      const b = body as { identityKind: Kind; identity: string };
      if (!links.delete(`${b.identityKind}\0${b.identity}`)) return json(route, { error: "link_not_found", detail: "that identity is not linked to any server" }, 404);
      return json(route, { identityKind: b.identityKind, identity: b.identity, removed: true });
    }
    if (p === "/v1/servers") return json(route, { servers: [{ id: APPROVED, name: "Acme approved files", url: "https://mcp.example.test", admissionState: "clean" }, { id: HELD, name: "Acme held server", url: "https://held.example.test", admissionState: "held" }, { id: UNSCANNED, name: "Acme unscanned server", url: "https://new.example.test", admissionState: "unscanned" }, { id: CLEARED, name: "Acme cleared server", url: "https://cleared.example.test", admissionState: "cleared" }] });
    if (p === "/v1/discovery/settings" && method === "PUT") {
      const b = body as { endpointMcpConfig?: boolean };
      if (b.endpointMcpConfig !== undefined) enabled = b.endpointMcpConfig;
      version += 1;
    }
    if (p === "/v1/discovery/settings") return json(route, { credentialWarningAgeDays: 90, endpointRetentionDays: 90, families: { saas: false, identity: false, ml_platform: false }, endpointMcpConfig: enabled, version });
    if (p === "/v1/discovery/scanners") return json(route, { kinds: [{ kind: "endpoint_agent", label: "Endpoint agent", family: "endpoint", slice: "SD4", evidenceKinds: ["endpoint_scan"], subjectKinds: ["device"], built: true, requiresCredential: false }] });
    if (p === "/v1/discovery/sources") return json(route, { sources: [], posture: { sourcesTotal: 0, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "No discovery source is enabled." } });
    if (p === "/v1/discovery/runs") return json(route, { items: [], nextCursor: null, nextOffset: null, total: 0, totalIsEstimate: false, failed: 0 });
    if (p === "/v1/discovery/federation") return json(route, { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} });
    return json(route, {});
  });
  return calls;
}

const PAGE = "/ui/admin/shadow-ai/discovery-sources";
const card = (page: Page) => page.getByTestId("endpoint-mcp-card").locator("xpath=ancestor::section[@data-rg-card][1]");
const inventoryCalls = (calls: Awaited<ReturnType<typeof mockApi>>) => calls.filter((c) => c.path === "/v1/discovery/endpoint-mcp-servers");

test.use({ viewport: { width: 1440, height: 900 } });

test("the inventory: posture, columns, filters, keyset Load more, and the finding link", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(PAGE);
  const c = card(page);
  await expect(page.getByTestId("endpoint-mcp-posture")).toHaveText(ON);
  await expect(c.getByText("MCP servers on employee machines", { exact: true })).toBeVisible();
  await expect(c.locator("tbody tr")).toHaveCount(25);
  const first = c.locator("tbody tr").filter({ hasText: "acme-files" });
  await expect(first).toContainText("acme-mcp-0");
  await expect(first).toContainText("Unpinned package");
  await expect(first).toContainText("Secrets: generic-api-key");
  await expect(first).toContainText("Risky tools: write_file");
  await expect(first).toContainText("Unregistered");
  await expect(first.getByRole("link", { name: /^Finding, for acme-files/ })).toHaveAttribute("href", /\/admin\/shadow-ai\?tab=findings$/);
  await expect(c.locator("tbody tr").filter({ hasText: "acme-remote" })).toContainText("Registered");
  expect(inventoryCalls(calls)[0]!.q.get("limit")).toBe("25");
  await expectAxeClean(page, "MCP servers on employee machines: the inventory");

  await c.getByRole("button", { name: "Load more" }).click();
  await expect(c.locator("tbody tr")).toHaveCount(30);
  await expect(c.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(inventoryCalls(calls).at(-1)!.q.get("cursor")).toBe(ROWS[24]!.id);

  await c.getByLabel("Registry state").selectOption("unregistered");
  await c.getByLabel("With risk flags").check();
  await c.getByLabel("With secrets").check();
  await expect(c.locator("tbody tr")).toHaveCount(1);
  const q = inventoryCalls(calls).at(-1)!.q;
  expect([q.get("status"), q.get("risky"), q.get("secrets")]).toEqual(["unregistered", "true", "true"]);
  await c.getByLabel("With risk flags").uncheck();
  await c.getByLabel("With secrets").uncheck();
  await c.getByLabel("Registry state").selectOption("");

  await c.getByRole("button", { name: /^Only this device, psn:bbbb/ }).first().click();
  await expect(c.locator("tbody tr")).toHaveCount(15);
  expect(inventoryCalls(calls).at(-1)!.q.get("deviceId")).toBe(DEVICE_B);
  await c.getByRole("button", { name: "Show every device" }).click();
  // back to the unfiltered list: the pages already loaded for it are kept
  await expect(c.locator("tbody tr")).toHaveCount(30);
});

test("link by command warns it approves everything that command launches; unlink asks first; both are sent as the gateway expects", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(PAGE);
  const c = card(page);
  await expect(c.getByText("Links audited")).toBeVisible();
  await c.getByRole("button", { name: "Link to an approved server, acme-shell" }).click();
  const dialog = page.getByRole("dialog", { name: "Link acme-shell to an approved server" });
  await expect(dialog).toContainText("every server any device launches with 'acme-runner' is approved by this one link");
  await expect(dialog).toContainText("Wide link");
  // nothing pre-selected; only admitted (clean, cleared) servers are offered, never held or unscanned
  await expect(dialog.getByLabel("Approved server")).toHaveValue("");
  await expect(dialog.getByRole("option", { name: "Acme approved files" })).toHaveCount(1);
  await expect(dialog.getByRole("option", { name: "Acme cleared server" })).toHaveCount(1);
  await expect(dialog.getByRole("option", { name: "Acme held server" })).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: "Acme unscanned server" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Link" }).click();
  await expect(dialog).toContainText("Choose the approved server to link it to.");
  await expectAxeClean(page, "MCP servers on employee machines: the link dialog");
  await dialog.getByLabel("Approved server").selectOption(APPROVED);
  await dialog.getByRole("button", { name: "Link" }).click();
  await expect(dialog).toHaveCount(0);
  const sent = calls.find((x) => x.path === "/v1/discovery/endpoint-mcp-server-links");
  expect(sent!.body).toEqual({ identityKind: "command", identity: "acme-runner", mcpServerId: APPROVED });
  const row = c.locator("tbody tr").filter({ hasText: "acme-shell" });
  await expect(row).toContainText("Linked");

  await row.getByRole("button", { name: "Unlink, acme-shell" }).click();
  const confirm = page.getByRole("dialog", { name: "Unlink acme-shell?" });
  await expect(confirm).toContainText("every server any device launches with 'acme-runner'");
  await confirm.getByRole("button", { name: "Unlink" }).click();
  await expect(row).toContainText("Unregistered");
  expect(calls.find((x) => x.path === "/v1/discovery/endpoint-mcp-server-links/remove")!.body).toEqual({ identityKind: "command", identity: "acme-runner" });
});

test("a link refused with mcp_server_not_found is said inline in the dialog", async ({ page }) => {
  await mockApi(page, { linkNotFound: true });
  await page.goto(PAGE);
  const c = card(page);
  await c.getByRole("button", { name: "Link to an approved server, acme-files" }).click();
  const dialog = page.getByRole("dialog", { name: "Link acme-files to an approved server" });
  await expect(dialog).toContainText("Every device whose config names the package 'acme-mcp-0' is covered by this link.");
  await dialog.getByLabel("Approved server").selectOption(APPROVED);
  await dialog.getByRole("button", { name: "Link" }).click();
  await expect(dialog).toContainText(/register it first/);
});

test("the Settings switch: on asks for the step-up, off does not; off shows the off posture and its empty state", async ({ page }) => {
  const calls = await mockApi(page, { enabled: false });
  await page.goto(PAGE);
  const c = card(page);
  await expect(page.getByTestId("endpoint-mcp-posture")).toHaveText(OFF);
  await expect(c.getByText("MCP config discovery is off", { exact: true })).toBeVisible();
  await expectAxeClean(page, "MCP servers on employee machines: off");
  const sw = page.getByLabel(/^MCP config discovery on employee machines/);
  await expect(sw).not.toBeChecked();
  const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/discovery/settings", kind: "settings_relax", when: (b) => (b as { endpointMcpConfig?: boolean })?.endpointMcpConfig === true });
  await sw.check();
  await page.getByRole("button", { name: "Save settings (confirm it's you)" }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[1]!.body).toEqual({ version: 1, endpointMcpConfig: true });
  await expect(page.getByTestId("endpoint-mcp-posture")).toHaveText(ON);
  await expect(sw).toBeChecked();

  await sw.uncheck();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByTestId("endpoint-mcp-posture")).toHaveText(OFF);
  const puts = calls.filter((x) => x.path === "/v1/discovery/settings" && x.method === "PUT");
  expect(puts.at(-1)!.body).toEqual({ version: 2, endpointMcpConfig: false });
  expect(su.attempts).toHaveLength(2);
});

test("a failed read shows the error with Retry; an empty inventory says so", async ({ page }) => {
  // the app retries a failed read once on its own, so two failures reach the screen
  await mockApi(page, { failList: 2 });
  await page.goto(PAGE);
  const c = card(page);
  await expect(c.getByRole("alert")).toBeVisible();
  await expectAxeClean(page, "MCP servers on employee machines: a failed read");
  await c.getByRole("button", { name: "Retry" }).click();
  await expect(c.locator("tbody tr")).toHaveCount(25);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockApi(page, { empty: true });
  await page.reload();
  await expect(card(page).getByText("No MCP server reported yet")).toBeVisible();
});
