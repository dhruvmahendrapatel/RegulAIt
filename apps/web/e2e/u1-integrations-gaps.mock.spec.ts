/**
 * Batch U1 — web UI for integration and identity capabilities that had none,
 * against HTTP mocks shaped like the gateway routes (no database):
 *  - ADR-0101 federated MCP registries (a tab on MCP servers);
 *  - ADR-0097 clearing a held MCP server (reason + settings_relax step-up);
 *  - the per-user tools/list preview;
 *  - ADR-0190 executor detail and lifecycle on the Engines page;
 *  - ADR-0187 recurring engine runs;
 *  - ADR-0065 regulAIt-LLM add rows, validate and poll;
 *  - ADR-0175 an agent's expected served model;
 *  - ADR-0188 issuer signing keys and a delegation grant's detail.
 * Each checks the exact body sent, the confirmation, the step-up where the
 * gateway asks for one, a named refusal, and axe in light and dark.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock } from "./builder-fixtures";
import { ENGINE_AGENT, ENGINE_JUDGE, ENGINE_PROJECT, installEnginesMock } from "./engines-fixtures";
import { expectAxeClean } from "./prompts-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = U(1);
const ISO = "2026-10-12T10:00:00.000Z";
const LATER = new Date(Date.now() + 3_600_000).toISOString();

interface Call {
  method: string;
  path: string;
  body: Json;
}
type Handler = (req: { method: string; path: string; body: Json; match: RegExpExecArray }) => { status?: number; body: unknown } | undefined;

/** the shell's reads, then each spec's own routes (first match wins), then `{}` */
async function mockApi(page: Page, routes: Array<[string, RegExp, Handler]>): Promise<Call[]> {
  const calls: Call[] = [];
  const me = { userId: ME, isAdmin: true, user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method, path: p, body });
    for (const [verb, re, handle] of routes) {
      const match = re.exec(p);
      if (verb !== method || !match) continue;
      const out = handle({ method, path: p, body, match });
      if (out) return json(route, out.body, out.status ?? 200);
    }
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    if (p === "/v1/approvals") return json(route, { approvals: [] });
    if (p === "/v1/users") return json(route, { users: [{ id: ME, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null, createdAt: ISO, totpEnabled: true, hasPassword: true }] });
    return json(route, {});
  });
  return calls;
}
/**
 * Axe in light and dark on the MCP servers tab, excluding the server table's
 * Proxy id chips: a PRE-EXISTING target-size finding on that table (the
 * IdChip is 20px tall inside a clickable row), not part of this batch (a logged
 * follow-up). The exclusion names the chip itself (`data-id-chip`), not a column
 * position: ADR-0188 S8 added a column before it and a positional selector
 * silently moved onto another cell.
 */
async function axeMcpServers(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude('tr[aria-label^="Show tools on"] [data-id-chip]')
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe on "${label}" (${theme})`).toEqual([]);
  }
  // heading-order is a best-practice rule, outside the WCAG tags above; other mock specs that axe this page with
  // best practice on caught a skipped heading level that this check missed (#381), so it runs here too
  const order = await new AxeBuilder({ page }).withRules(["heading-order"]).analyze();
  expect(order.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe heading-order on "${label}"`).toEqual([]);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
}
const sent = (calls: Call[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

// ---------------------------------------------------------------------------
// ADR-0101 federated registries
// ---------------------------------------------------------------------------

const REGISTRY = { id: U(100), name: "internal-mirror", url: "https://registry.example.test", enabled: false, allowPrivateRanges: null, lastSyncAt: null, lastSyncOutcome: null, lastSyncDetail: null, createdAt: ISO };
const entry = (n: number, over: Json = {}) => ({
  id: U(200 + n), registryId: REGISTRY.id, upstreamName: `io.example/tool-${n}`, upstreamVersion: "1.0.0", title: `Tool ${n}`, description: null, repositoryUrl: null, websiteUrl: null,
  kind: "remote", remoteUrl: `https://tool-${n}.example.test/mcp`, remoteTransport: "streamable-http", catalogueReason: null, upstreamStatus: "active", upstreamPublishedAt: null, upstreamUpdatedAt: null,
  serverId: null, importedAt: null, importedBy: null, conflictReason: null, conflictServerId: null, remoteUrlDrift: null, firstSeenAt: ISO, lastSeenAt: ISO, lastSyncedAt: ISO, missingSince: null, ...over,
});

function registryRoutes(state: { registries: Json[]; conflictOnImport?: boolean; refuseSync?: boolean }): Array<[string, RegExp, Handler]> {
  return [
    ["GET", /^\/v1\/mcp-registries$/, () => ({ body: { deployMode: "hosted", federationRefused: false, federationRefusedReason: null, maxPagesPerSync: 20, maxRegistriesPerSweep: 10, registries: state.registries } })],
    ["POST", /^\/v1\/mcp-registries$/, ({ body }) => {
      // the unique name, refused by the gateway's global 23505 handler
      if (state.registries.some((r) => r.name === body.name)) return { status: 409, body: { error: "conflict" } };
      const row = { ...REGISTRY, id: U(101), ...body };
      state.registries.push(row);
      return { status: 201, body: row };
    }],
    ["PATCH", /^\/v1\/mcp-registries\/([^/]+)$/, ({ body, match }) => {
      const r = state.registries.find((x) => x.id === match[1]);
      Object.assign(r, body);
      return { body: r };
    }],
    ["POST", /^\/v1\/mcp-registries\/([^/]+)\/sync$/, () => ({
      body: state.refuseSync
        ? { registryId: REGISTRY.id, registryName: REGISTRY.name, outcome: "refused", reason: "the egress guard refused the registry url", pages: 0, truncated: false, entriesSeen: 0, created: 0, updated: 0, remote: 0, catalogueOnly: 0, malformed: 0, markedMissing: 0, driftDetected: 0, conflicts: 0, serversCreated: 0, grantsCreated: 0 }
        : { registryId: REGISTRY.id, registryName: REGISTRY.name, outcome: "ok", reason: "pulled", pages: 1, truncated: false, entriesSeen: 3, created: 3, updated: 0, remote: 2, catalogueOnly: 1, malformed: 0, markedMissing: 0, driftDetected: 0, conflicts: 0, serversCreated: 0, grantsCreated: 0 },
    })],
    ["GET", /^\/v1\/mcp-registries\/([^/]+)\/entries$/, () => ({
      body: { registry: { id: REGISTRY.id, name: REGISTRY.name }, entries: [entry(1), entry(2, { kind: "catalogue_only", remoteUrl: null, remoteTransport: null, catalogueReason: "package_only" }), entry(3, { conflictReason: "name_taken", conflictServerId: U(9) })] },
    })],
    ["POST", /^\/v1\/mcp-registries\/entries\/([^/]+)\/import$/, ({ match }) =>
      state.conflictOnImport
        ? { status: 409, body: { error: "conflict", reason: "name_taken", conflictServerId: U(9), detail: "MCP server 'tool-3' already exists" } }
        : { status: 201, body: { serverId: U(300), name: "tool-1", url: "https://tool-1.example.test/mcp", admissionState: "unscanned", origin: "federated", grantsCreated: 0, toolsCreated: 0, entryId: match[1] } }],
  ];
}

test.describe("MCP servers — federated registries (ADR-0101)", () => {
  test("add disabled by default, confirm an enabled add, sync, browse and import one entry", async ({ page }) => {
    const state = { registries: [{ ...REGISTRY }] };
    const calls = await mockApi(page, registryRoutes(state));
    await page.goto("/ui/admin/mcp-servers?tab=registries");
    await expect(page.getByRole("tab", { name: "Federated registries", selected: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("cell", { name: "internal-mirror", exact: true })).toBeVisible();
    await expectAxeClean(page, "federated registries");

    const form = page.getByRole("form", { name: "Add a registry" });
    await expect(form.getByLabel("Scheduled pulls")).toHaveValue("off");
    await form.getByLabel("Registry name").fill("second");
    await form.getByLabel("Registry base URL").fill("registry.example.test");
    await form.getByRole("button", { name: "Add registry" }).click();
    await expect(form.getByRole("alert")).toContainText("absolute URL");
    await form.getByLabel("Registry base URL").fill("https://second.example.test");
    await form.getByRole("button", { name: "Add registry" }).click();
    await expect.poll(() => sent(calls, "POST", "/v1/mcp-registries")).toEqual([{ name: "second", url: "https://second.example.test", enabled: false, allowPrivateRanges: null }]);
    // the form resets its draft only once the add has resolved; wait for that reset before typing the next one,
    // or it can land after the fills below and wipe them
    await expect(form.getByLabel("Registry name")).toHaveValue("");

    // enabling at creation is a relaxation: confirmed first, then the gateway's settings_relax step-up
    const su = await requireStepUpOn(page, {
      method: "POST",
      path: "/v1/mcp-registries",
      kind: "settings_relax",
      when: (b) => (b as Json).enabled === true || (b as Json).allowPrivateRanges === true,
      facts: (b) => ({ op: "mcp_registry_create", name: (b as Json).name, url: (b as Json).url, values: { enabled: true } }),
    });
    await form.getByLabel("Registry name").fill("third");
    await form.getByLabel("Registry base URL").fill("https://third.example.test");
    await form.getByLabel("Scheduled pulls").selectOption("on");
    await form.getByRole("button", { name: "Add registry" }).click();
    const confirm = page.getByRole("dialog", { name: "Add this registry with a relaxed setting?" });
    await expect(confirm).toContainText("The strict default is disabled");
    await expectAxeClean(page, "relaxed registry confirmation");
    await confirm.getByRole("button", { name: "Add registry" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    await expect.poll(() => sent(calls, "POST", "/v1/mcp-registries").length).toBe(2);
    expect(sent(calls, "POST", "/v1/mcp-registries")[1]).toMatchObject({ name: "third", enabled: true });

    await page.getByRole("button", { name: "Sync registry internal-mirror" }).click();
    await expect(page.getByTestId("registry-sync-result")).toContainText("3 entries seen, 3 new, 0 refreshed, 2 importable, 1 catalogue only. No server and no grant was created.");

    await page.getByRole("button", { name: "Browse entries of internal-mirror" }).click();
    await expect(page.getByText("Catalogue only: package_only")).toBeVisible();
    await expect(page.getByRole("button", { name: "Import io.example/tool-2" })).toBeDisabled();
    await page.getByRole("button", { name: "Import io.example/tool-1" }).click();
    const imp = page.getByRole("dialog", { name: "Import io.example/tool-1?" });
    await expect(imp).toContainText("usable by nobody");
    await imp.getByRole("button", { name: "Import as an MCP server" }).click();
    await expect(page.getByTestId("registry-import-result")).toContainText("with 0 tools and 0 grants");
    expect(calls.some((c) => c.method === "POST" && c.path === `/v1/mcp-registries/entries/${U(201)}/import`)).toBe(true);
    await expectAxeClean(page, "registry catalogue");
  });

  test("a duplicate name and a refused sync are failures; an edit that enables is confirmed; a colliding import is named", async ({ page }) => {
    const state = { registries: [{ ...REGISTRY }], conflictOnImport: true, refuseSync: true };
    const calls = await mockApi(page, registryRoutes(state));
    await page.goto("/ui/admin/mcp-servers?tab=registries");
    const form = page.getByRole("form", { name: "Add a registry" });
    await form.getByLabel("Registry name").fill("internal-mirror", { timeout: 30_000 });
    await form.getByLabel("Registry base URL").fill("https://other.example.test");
    await form.getByRole("button", { name: "Add registry" }).click();
    await expect(form.getByRole("alert")).toHaveText("A registry with this name already exists. Choose another name.");

    // a sync answers 200 for every outcome: a refused one is an error, never a success
    await page.getByRole("button", { name: "Sync registry internal-mirror" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Sync of internal-mirror refused: the egress guard refused the registry url" }).first()).toBeVisible();
    await expect(page.getByTestId("registry-sync-result")).toContainText("refused");

    await page.getByRole("button", { name: "Edit registry internal-mirror" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit registry internal-mirror" });
    await dialog.getByLabel("Scheduled pulls").selectOption("on");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("This relaxes the registry");
    expect(sent(calls, "PATCH", `/v1/mcp-registries/${REGISTRY.id}`)).toEqual([]);
    await expectAxeClean(page, "registry edit relaxation");
    const su = await requireStepUpOn(page, {
      method: "PATCH",
      path: `/v1/mcp-registries/${REGISTRY.id}`,
      kind: "settings_relax",
      when: (b) => (b as Json).enabled === true || (b as Json).allowPrivateRanges === true,
      facts: () => ({ op: "mcp_registry_update", registryId: REGISTRY.id, values: { enabled: true } }),
    });
    await dialog.getByRole("button", { name: "Save the relaxed setting" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ enabled: true });
    await expect.poll(() => sent(calls, "PATCH", `/v1/mcp-registries/${REGISTRY.id}`)).toEqual([{ enabled: true }]);
    // disabling it again is tightening: sent once, no step-up asked (wait for the list to show it enabled first)
    await expect(dialog).toHaveCount(0);
    // the State cell, not the row: a row's text joins its cells with no separator, so a word boundary never matches
    await expect(page.getByRole("row").filter({ hasText: "internal-mirror" }).getByRole("cell", { name: "enabled", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit registry internal-mirror" }).click();
    const again = page.getByRole("dialog", { name: "Edit registry internal-mirror" });
    await again.getByLabel("Scheduled pulls").selectOption("off");
    await again.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => sent(calls, "PATCH", `/v1/mcp-registries/${REGISTRY.id}`)).toEqual([{ enabled: true }, { enabled: false }]);
    expect(su.attempts).toHaveLength(2);

    await page.getByRole("button", { name: "Browse entries of internal-mirror" }).click();
    // a collision recorded at the last sync is a warning; the gateway re-checks it live and decides
    await expect(page.getByText(/At the last sync an existing MCP server had this name/)).toBeVisible();
    await page.getByRole("button", { name: "Import io.example/tool-3" }).click();
    await page.getByRole("dialog", { name: "Import io.example/tool-3?" }).getByRole("button", { name: "Import as an MCP server" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already has this entry's name or URL" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// ADR-0097 admission clear, and the tools/list preview
// ---------------------------------------------------------------------------

const HELD = { id: U(400), name: "records", url: "https://records.example.test/mcp", transport: "streamable_http", admissionState: "held", pricePerCallUsd: null };
const CLEAN = { id: U(401), name: "search", url: "https://search.example.test/mcp", transport: "streamable_http", admissionState: "clean", pricePerCallUsd: null };

test.describe("MCP servers — admission clear and tools/list preview", () => {
  test("a held server is cleared with a reason through the settings_relax step-up", async ({ page }) => {
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/servers$/, () => ({ body: { servers: [HELD, CLEAN] } })],
      ["POST", /^\/v1\/servers\/([^/]+)\/admission\/clear$/, () => ({ body: { ...HELD, admissionState: "cleared" } })],
    ]);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/servers/${HELD.id}/admission/clear`, kind: "settings_relax" });
    await page.goto("/ui/admin/mcp-servers");
    await expect(page.getByRole("button", { name: "Clear admission hold on records" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Clear admission hold on search" })).toHaveCount(0);
    await axeMcpServers(page, "mcp servers with a held server");
    await page.getByRole("button", { name: "Clear admission hold on records" }).click();
    const dialog = page.getByRole("dialog", { name: "Clear the admission hold on records?" });
    await expect(dialog).toContainText("pinned to the manifest that was scanned");
    await dialog.getByRole("button", { name: "Clear the hold" }).click();
    await expect(dialog.getByRole("alert")).toContainText("A reason is required");
    await dialog.getByLabel("Reason").fill("Reviewed the tool descriptions with security");
    await dialog.getByRole("button", { name: "Clear the hold" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ reason: "Reviewed the tool descriptions with security" });
    // the harness answered the first attempt; only the resent one reached the gateway mock
    expect(calls.filter((c) => c.path.endsWith("/admission/clear"))).toHaveLength(1);
  });

  test("allowing a server's private ranges is stepped up at registration and on edit; denying them is not", async ({ page }) => {
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/servers$/, () => ({ body: { servers: [CLEAN] } })],
      ["POST", /^\/v1\/servers$/, ({ body }) => ({ status: 201, body: { ...CLEAN, id: U(402), admissionState: "unscanned", ...body } })],
      ["PATCH", /^\/v1\/servers\/([^/]+)$/, ({ body }) => ({ body: { ...CLEAN, ...body } })],
    ]);
    const opens = (b: unknown) => (b as Json).allowPrivateRanges === true;
    const reg = await requireStepUpOn(page, {
      method: "POST",
      path: "/v1/servers",
      kind: "settings_relax",
      when: opens,
      facts: (b) => ({ op: "mcp_server_create", name: (b as Json).name, url: (b as Json).url, values: { allowPrivateRanges: true } }),
    });
    await page.goto("/ui/admin/mcp-servers");
    const form = page.getByRole("form", { name: "Register an MCP server" });
    await form.getByLabel("Name").fill("lan-tools", { timeout: 30_000 });
    await form.getByLabel("URL").fill("http://10.0.0.5/mcp");
    await form.getByLabel("Private ranges (ADR-0043)").selectOption("true");
    await form.getByRole("button", { name: "Register" }).click();
    await confirmStepUp(page);
    await reg.expectResentOnce();
    expect(reg.attempts[1]!.body).toMatchObject({ name: "lan-tools", url: "http://10.0.0.5/mcp", allowPrivateRanges: true });
    await expect.poll(() => sent(calls, "POST", "/v1/servers").length).toBe(1);

    const edit = await requireStepUpOn(page, {
      method: "PATCH",
      path: `/v1/servers/${CLEAN.id}`,
      kind: "settings_relax",
      when: opens,
      facts: () => ({ op: "mcp_server_update", serverId: CLEAN.id, values: { allowPrivateRanges: true } }),
    });
    const posture = page.getByLabel("Private-range posture for search");
    await posture.selectOption("true");
    await posture.locator("xpath=..").getByRole("button", { name: "Save" }).click();
    await confirmStepUp(page);
    await edit.expectResentOnce();
    await expect.poll(() => sent(calls, "PATCH", `/v1/servers/${CLEAN.id}`)).toEqual([{ allowPrivateRanges: true }]);
    // denying them is tightening: sent once, never refused for a step-up
    await posture.selectOption("false");
    await posture.locator("xpath=..").getByRole("button", { name: "Save" }).click();
    await expect.poll(() => sent(calls, "PATCH", `/v1/servers/${CLEAN.id}`)).toEqual([{ allowPrivateRanges: true }, { allowPrivateRanges: false }]);
    expect(edit.attempts).toHaveLength(2);
  });

  test("a reserved tool name is refused in words; the preview lists what discovery shows", async ({ page }) => {
    await mockApi(page, [
      ["GET", /^\/v1\/servers$/, () => ({ body: { servers: [HELD, CLEAN] } })],
      ["POST", /^\/v1\/servers\/([^/]+)\/admission\/clear$/, () => ({ status: 409, body: { error: "reserved_tool_name", detail: "the upstream must rename the tool" } })],
      ["GET", new RegExp(`^/v1/users/${ME}/servers/${CLEAN.id}/tools$`), () => ({ body: { tools: [{ serverId: CLEAN.id, name: "search_docs", kind: "read" }] } })],
      ["GET", new RegExp(`^/v1/users/${ME}/servers/${HELD.id}/tools$`), () => ({ body: { tools: [] } })],
    ]);
    await page.goto("/ui/admin/mcp-servers");
    await page.getByRole("button", { name: "Clear admission hold on records" }).click({ timeout: 30_000 });
    const dialog = page.getByRole("dialog", { name: "Clear the admission hold on records?" });
    await dialog.getByLabel("Reason").fill("needed for the pilot");
    await dialog.getByRole("button", { name: "Clear the hold" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "reserved mcp: prefix" }).first()).toBeVisible();

    await page.getByLabel("User whose discovery to preview").selectOption(ME);
    await page.getByLabel("Server to preview").selectOption(CLEAN.id);
    await page.getByRole("button", { name: "Preview tools" }).click();
    await expect(page.getByRole("cell", { name: "search_docs" })).toBeVisible();
    await page.getByLabel("Server to preview").selectOption(HELD.id);
    await page.getByRole("button", { name: "Preview tools" }).click();
    await expect(page.getByText("held by the admission scan. While admission is enforced its tools are hidden from everyone")).toBeVisible();
    await axeMcpServers(page, "tools/list preview");
  });
});

// ---------------------------------------------------------------------------
// ADR-0188 S8 identity to upstream (the per-server setting and its card)
// ---------------------------------------------------------------------------

test.describe("MCP servers — identity to upstream (ADR-0188 S8)", () => {
  const row = (page: Page, name: string) => page.getByRole("link", { name: `Show tools on ${name}`, exact: true });
  /** the identity cell's content, by its stable hook (never a column position) */
  const identityCell = (page: Page, name: string) => row(page, name).locator("[data-identity-propagation]");

  test("turning it on is confirmed, then stepped up and resent once; turning it off asks nothing; the card shows the format", async ({ page }) => {
    const SRV: Json = { ...CLEAN, id: U(410), name: "search", url: "https://search.example.test/mcp?key=s3cret", identityPropagation: "none" };
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/servers$/, () => ({ body: { servers: [SRV] } })],
      ["GET", /^\/v1\/servers\/([^/]+)\/tools$/, () => ({ body: { tools: [] } })],
      ["PATCH", /^\/v1\/servers\/([^/]+)$/, ({ body }) => {
        Object.assign(SRV, body);
        return { body: SRV };
      }],
    ]);
    const su = await requireStepUpOn(page, {
      method: "PATCH",
      path: `/v1/servers/${SRV.id}`,
      kind: "settings_relax",
      when: (b) => (b as Json).identityPropagation === "signed_assertion",
      facts: () => ({ op: "mcp_server_update", serverId: SRV.id, url: SRV.url, values: { identityPropagation: "signed_assertion" } }),
    });
    await page.goto("/ui/admin/mcp-servers");
    const setting = page.getByLabel("Identity sent to upstream search");
    await expect(setting).toHaveValue("none", { timeout: 30_000 });
    const form = page.getByRole("form", { name: "Identity to upstream for search" });
    await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
    await axeMcpServers(page, "mcp servers with the identity column");

    // ON: a confirmation that says what is shared, then the step-up, then the request is resent once
    await setting.selectOption("signed_assertion");
    await form.getByRole("button", { name: "Save" }).click();
    const confirm = page.getByRole("dialog", { name: "Send caller identity to search?" });
    await expect(confirm).toContainText("pairwise id for this server (never an email, a name or a global agent id)");
    await axeMcpServers(page, "identity to upstream confirmation");
    await confirm.getByRole("button", { name: "Send a signed assertion" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ identityPropagation: "signed_assertion" });
    await expect.poll(() => sent(calls, "PATCH", `/v1/servers/${SRV.id}`)).toEqual([{ identityPropagation: "signed_assertion" }]);
    // the form resets to the saved value before the next change
    await expect(setting).toHaveValue("signed_assertion");
    await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();

    // the card: the audience without the query, the claims, and the verification example
    await row(page, "search").locator("td").first().click();
    const card = page.locator("section").filter({ has: page.getByText("Identity sent to this upstream", { exact: true }) });
    await expect(card).toContainText("Signed assertion per call");
    await expect(card).toContainText("https://search.example.test/mcp");
    await expect(card).not.toContainText("s3cret");
    const claims = card.getByRole("list", { name: "Claims in the assertion" });
    for (const claim of ["iss", "aud", "sub", "act", "iat / exp", "jti"]) await expect(claims.getByText(claim, { exact: true })).toBeVisible();
    await expect(claims).toContainText("never an email, name or user id");
    await card.getByText("Verification example for the upstream operator (JavaScript, jose)").click();
    const example = card.getByTestId("mcp-identity-verify-example");
    await expect(example).toContainText('typ: "regulait-mcp-identity+jwt"');
    await expect(example).toContainText("createRemoteJWKSet");
    await axeMcpServers(page, "identity card with the example open");

    // OFF: no confirmation and no step-up; sent once
    await setting.selectOption("none");
    await form.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => sent(calls, "PATCH", `/v1/servers/${SRV.id}`)).toEqual([{ identityPropagation: "signed_assertion" }, { identityPropagation: "none" }]);
    await expect(page.getByRole("dialog", { name: "Send caller identity to search?" })).toHaveCount(0);
    expect(su.attempts).toHaveLength(2);
    expect(su.optionsCalls).toHaveLength(1);
    await expect(setting).toHaveValue("none");
    await expect(card).toContainText("Nothing sent (default)");
  });

  test("a stdio server shows not applicable; the gateway's stdio refusal is named in words", async ({ page }) => {
    const STDIO: Json = { ...CLEAN, id: U(411), name: "local-files", url: "stdio:local-files", transport: "stdio", stdio: { command: "/usr/bin/mcp-files", args: [] }, identityPropagation: "none" };
    // a row whose transport the list does not report (an older row shape): the gateway, which reads the row, refuses
    const LEGACY: Json = { id: U(412), name: "legacy", url: "https://legacy.example.test/mcp", admissionState: "clean", pricePerCallUsd: null, identityPropagation: "none" };
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/servers$/, () => ({ body: { servers: [STDIO, LEGACY] } })],
      ["PATCH", /^\/v1\/servers\/([^/]+)$/, () => ({
        status: 409,
        body: { error: "identity_propagation_unsupported", detail: "this server is a stdio upstream: there is no HTTP request to carry an identity assertion. Nothing was saved." },
      })],
    ]);
    await page.goto("/ui/admin/mcp-servers");
    await expect(identityCell(page, "local-files")).toHaveText("Not applicable", { timeout: 30_000 });
    await expect(page.getByLabel("Identity sent to upstream local-files")).toHaveCount(0);

    const setting = page.getByLabel("Identity sent to upstream legacy");
    await expect(setting).toHaveValue("none");
    await setting.selectOption("signed_assertion");
    const form = page.getByRole("form", { name: "Identity to upstream for legacy" });
    await form.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog", { name: "Send caller identity to legacy?" }).getByRole("button", { name: "Send a signed assertion" }).click();
    await expect(form.getByRole("alert")).toContainText("cannot receive an identity assertion");
    expect(sent(calls, "PATCH", `/v1/servers/${LEGACY.id}`)).toEqual([{ identityPropagation: "signed_assertion" }]);
    await expect(identityCell(page, "legacy")).toContainText("cannot receive an identity assertion");
    await axeMcpServers(page, "identity refusal");
  });

  test("S8 follow-up: disclosing agent workload IDs is confirmed in plain words, stepped up and resent once; pairwise saves directly", async ({ page }) => {
    const SRV: Json = { ...CLEAN, id: U(413), name: "search", identityPropagation: "signed_assertion", discloseAgentWorkloadIds: false };
    // sent an assertion in the list, but turned off by someone else since: the gateway refuses with its sentence
    const STALE: Json = { ...CLEAN, id: U(414), name: "stale", url: "https://stale.example.test/mcp", identityPropagation: "signed_assertion", discloseAgentWorkloadIds: false };
    const PLAIN: Json = { ...CLEAN, id: U(415), name: "plain", url: "https://plain.example.test/mcp", identityPropagation: "none", discloseAgentWorkloadIds: false };
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/servers$/, () => ({ body: { servers: [SRV, STALE, PLAIN] } })],
      ["GET", /^\/v1\/servers\/([^/]+)\/tools$/, () => ({ body: { tools: [] } })],
      ["PATCH", /^\/v1\/servers\/([^/]+)$/, ({ body, match }) => {
        if (match[1] === STALE.id) {
          return {
            status: 409,
            body: {
              error: "agent_id_disclosure_needs_assertion",
              detail: "agent workload IDs are sent only inside a signed identity assertion, and this server is not set to receive one. Nothing was saved.",
            },
          };
        }
        Object.assign(SRV, body);
        return { body: SRV };
      }],
    ]);
    const su = await requireStepUpOn(page, {
      method: "PATCH",
      path: `/v1/servers/${SRV.id}`,
      kind: "settings_relax",
      when: (b) => (b as Json).discloseAgentWorkloadIds === true,
      facts: () => ({ op: "mcp_server_update", serverId: SRV.id, url: SRV.url, values: { discloseAgentWorkloadIds: true } }),
    });
    await page.goto("/ui/admin/mcp-servers");
    await row(page, "search").locator("td").first().click({ timeout: 30_000 });
    const card = page.locator("section").filter({ has: page.getByText("Identity sent to this upstream", { exact: true }) });
    /** the control, by its stable hook (never a position) */
    const control = card.locator("[data-agent-id-disclosure]");
    const setting = control.getByLabel("Agent ids sent to upstream search");
    const save = control.getByRole("form", { name: "Agent ids for search" }).getByRole("button", { name: "Save" });
    await expect(setting).toHaveValue("pairwise");
    await expect(save).toBeDisabled();
    await expect(card).toContainText("pairwise id for this server");
    await axeMcpServers(page, "identity card with the agent id control");

    // ON: the confirmation says the IDs are global, correlate the agent across servers, and are sent as typed
    await setting.selectOption("workload_id");
    await save.click();
    const confirm = page.getByRole("dialog", { name: "Disclose agent workload IDs to search?" });
    await expect(confirm).toContainText("Workload IDs are global");
    await expect(confirm).toContainText("upstreams can correlate the same agent across servers");
    await expect(confirm).toContainText("sent exactly as it was typed");
    await axeMcpServers(page, "agent id disclosure confirmation");
    await confirm.getByRole("button", { name: "Disclose workload IDs" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ discloseAgentWorkloadIds: true });
    await expect.poll(() => sent(calls, "PATCH", `/v1/servers/${SRV.id}`)).toEqual([{ discloseAgentWorkloadIds: true }]);
    // the form resets to the saved value before the next change
    await expect(card).toContainText("Agents are named by their workload IDs");
    await expect(setting).toHaveValue("workload_id");
    await expect(save).toBeDisabled();

    // OFF: back to pairwise saves directly: no confirmation, no step-up
    await setting.selectOption("pairwise");
    await save.click();
    await expect.poll(() => sent(calls, "PATCH", `/v1/servers/${SRV.id}`)).toEqual([{ discloseAgentWorkloadIds: true }, { discloseAgentWorkloadIds: false }]);
    await expect(page.getByRole("dialog", { name: "Disclose agent workload IDs to search?" })).toHaveCount(0);
    expect(su.attempts).toHaveLength(2);
    expect(su.optionsCalls).toHaveLength(1);
    await expect(card).toContainText("pairwise id for this server");
    await expect(setting).toHaveValue("pairwise");
    await expect(save).toBeDisabled();

    // the gateway's refusal when the server is no longer sent an assertion is named in words
    await row(page, "stale").locator("td").first().click();
    const staleSetting = control.getByLabel("Agent ids sent to upstream stale");
    await expect(staleSetting).toHaveValue("pairwise");
    await staleSetting.selectOption("workload_id");
    const staleForm = control.getByRole("form", { name: "Agent ids for stale" });
    await staleForm.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog", { name: "Disclose agent workload IDs to stale?" }).getByRole("button", { name: "Disclose workload IDs" }).click();
    await expect(staleForm.getByRole("alert")).toContainText("Turn on the signed assertion first");
    expect(sent(calls, "PATCH", `/v1/servers/${STALE.id}`)).toEqual([{ discloseAgentWorkloadIds: true }]);
    await axeMcpServers(page, "agent id disclosure refusal");

    // a server not sent an assertion is not offered the choice
    await row(page, "plain").locator("td").first().click();
    await expect(card).toContainText("Turn the assertion on first");
    await expect(card.locator("[data-agent-id-disclosure]")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// ADR-0190 executor lifecycle
// ---------------------------------------------------------------------------

const EXEC_BASE = { classesDeclared: ["hardened_container", "user_space_kernel"], quarantineCode: null, runtimeVersion: "runsc-20260901", declaredClass: null, lastSeenAt: ISO, openOffers: 0, attestationStrength: "software_attested", workloadIdentityId: U(500), quarantinedAt: null, reenabledAt: null, createdAt: ISO };

async function setupExecutors(page: Page) {
  await installBuilderMock(page, { isAdmin: true });
  await installEnginesMock(page);
  const execs: Record<string, Json> = {
    e1: { ...EXEC_BASE, executorId: U(601), name: "gvisor-a", backend: "gvisor", status: "active", attestations: [{ profileDigest: "a".repeat(64), fresh: true, class: "user_space_kernel", expiresAt: LATER, reportSha256: "b".repeat(64) }] },
    e2: { ...EXEC_BASE, executorId: U(602), name: "byoc-plane", backend: "customer", classesDeclared: ["customer_declared"], status: "quarantined", quarantineCode: "admin", attestations: [] },
  };
  const calls: Call[] = [];
  const find = (id: string) => Object.values(execs).find((e) => e.executorId === id);
  await page.route(/\/v1\/(org\/settings|executors|execution-profiles|execution-placements)(\/|\?|$)/, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method, path: p, body });
    if (p === "/v1/org/settings") return json(route, { settings: {} });
    if (p === "/v1/executors") return json(route, { executors: Object.values(execs) });
    const m = /^\/v1\/executors\/([^/]+)(\/[a-z-]+)?$/.exec(p);
    if (m) {
      const e = find(m[1]!);
      if (!e) return json(route, { error: "executor_not_found" }, 404);
      const sub = m[2] ?? "";
      if (method === "GET" && sub === "") return json(route, e);
      if (method === "GET" && sub === "/attestations")
        return json(route, {
          attestations: [
            { id: "a1", profileDigest: "a".repeat(64), class: "user_space_kernel", verdict: "pass", reportSha256: "b".repeat(64), report: {}, observedAt: ISO, expiresAt: LATER },
            { id: "a2", profileDigest: "a".repeat(64), class: "user_space_kernel", verdict: "fail", reportSha256: "c".repeat(64), report: {}, observedAt: ISO, expiresAt: LATER },
          ],
          attestationStrength: "software_attested",
        });
      if (method === "POST" && sub === "/quarantine") return json(route, Object.assign(e, { status: "quarantined", quarantineCode: "admin" }));
      if (method === "POST" && sub === "/reenable") return json(route, Object.assign(e, { status: "active", quarantineCode: null }));
      if (method === "POST" && sub === "/revoke") return json(route, Object.assign(e, { status: "revoked" }));
      if (method === "PUT" && sub === "/declared-class") return json(route, Object.assign(e, { declaredClass: body.class }));
    }
    return json(route, { error: "not_built" }, 501);
  });
  return calls;
}

test.describe("Engines — executor lifecycle (ADR-0190 I3)", () => {
  test("detail with self-test history; quarantine is confirmed; revoke needs the typed name", async ({ page }) => {
    const calls = await setupExecutors(page);
    await page.goto("/ui/admin/engines");
    await page.getByRole("button", { name: "Manage executor gvisor-a" }).click({ timeout: 30_000 });
    const detail = page.getByTestId("executor-detail");
    await expect(detail).toContainText("Fresh report");
    await expect(detail.getByText("Failed", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Re-enable" })).toBeDisabled();
    await expect(detail.getByText("Only a quarantined executor can be re-enabled.")).toBeVisible();
    await expect(detail.getByLabel("Declared class mapping")).toHaveCount(0);
    await expectAxeClean(page, "executor detail");

    await detail.getByRole("button", { name: "Quarantine" }).click();
    await page.getByRole("dialog", { name: "Quarantine gvisor-a?" }).getByRole("button", { name: "Quarantine" }).click();
    await expect.poll(() => sent(calls, "POST", `/v1/executors/${U(601)}/quarantine`)).toEqual([{ code: "admin" }]);

    await detail.getByRole("button", { name: "Revoke" }).click();
    const revoke = page.getByRole("dialog", { name: "Revoke gvisor-a?" });
    await expect(revoke.getByRole("button", { name: "Revoke permanently" })).toBeDisabled();
    await expectAxeClean(page, "revoke executor");
    await revoke.getByLabel("Type gvisor-a to confirm").fill("gvisor-a");
    await revoke.getByRole("button", { name: "Revoke permanently" }).click();
    await expect.poll(() => sent(calls, "POST", `/v1/executors/${U(601)}/revoke`)).toEqual([{}]);
  });

  test("re-enable and mapping a customer plane go through the settings_relax step-up", async ({ page }) => {
    const calls = await setupExecutors(page);
    const reenable = await requireStepUpOn(page, { method: "POST", path: `/v1/executors/${U(602)}/reenable`, kind: "settings_relax" });
    await page.goto("/ui/admin/engines");
    await page.getByRole("button", { name: "Manage executor byoc-plane" }).click({ timeout: 30_000 });
    const detail = page.getByTestId("executor-detail");
    await expect(detail.getByLabel("Declared class mapping")).toHaveValue("");
    await detail.getByRole("button", { name: "Re-enable" }).click();
    await page.getByRole("dialog", { name: "Re-enable byoc-plane?" }).getByRole("button", { name: "Re-enable" }).click();
    await confirmStepUp(page);
    await reenable.expectResentOnce();

    const mapping = await requireStepUpOn(page, { method: "PUT", path: `/v1/executors/${U(602)}/declared-class`, kind: "settings_relax" });
    await detail.getByLabel("Declared class mapping").selectOption("microvm");
    await detail.getByRole("button", { name: "Save mapping" }).click();
    const dialog = page.getByRole("dialog", { name: /Map byoc-plane to/ });
    await expect(dialog).toContainText("relaxes the strict default");
    await dialog.getByRole("button", { name: "Map the declared class" }).click();
    await confirmStepUp(page);
    await mapping.expectResentOnce();
    expect(mapping.attempts[1]!.body).toEqual({ class: "microvm" });
    // the harness answered the first attempt; only the resent one reached the executor mock
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ADR-0187 recurring engine runs
// ---------------------------------------------------------------------------

test.describe("Red-teaming — recurring engine runs (ADR-0187)", () => {
  test("a schedule carries the run form's request; only its creator may switch it back on", async ({ page }) => {
    const schedules: Json[] = [
      { id: U(700), engineId: "promptfoo", request: { engineId: "promptfoo", target: { agentId: ENGINE_AGENT }, config: { sets: ["basic"], params: {} }, projectId: ENGINE_PROJECT, trials: 3 }, configHash: "h", runAsUserId: U(999), intervalHours: 24, nextRunAt: LATER, enabled: false, lastRunId: null, lastSkip: "engine disabled", createdAt: ISO, updatedAt: ISO },
      { id: U(701), engineId: "promptfoo", request: { engineId: "promptfoo", target: { agentId: ENGINE_AGENT }, config: { sets: ["basic"], params: {} }, projectId: ENGINE_PROJECT, trials: 3 }, configHash: "h", runAsUserId: ME, intervalHours: 12, nextRunAt: LATER, enabled: true, lastRunId: null, lastSkip: null, createdAt: ISO, updatedAt: ISO },
    ];
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/agents$/, () => ({ body: { agents: [{ id: ENGINE_AGENT, name: "support-bot", provider: "mock", tier: 1, model: "m1", enabled: true }, { id: ENGINE_JUDGE, name: "grader", provider: "mock", tier: 1, model: "m1", enabled: true }] } })],
      ["GET", /^\/v1\/projects$/, () => ({ body: { projects: [{ id: ENGINE_PROJECT, name: "Support assistant", costCenter: null, budgetUsd: null, spentUsd: 0 }] } })],
      ["GET", /^\/v1\/redteam\/attack-classes$/, () => ({ body: { attackClasses: [], disclosure: "", scheduling: { schedulerEnabled: false, posture: "off", note: "" } } })],
      ["GET", /^\/v1\/redteam\/(libraries|runs)$/, () => ({ body: { libraries: [], runs: [], note: "" } })],
    ]);
    await installEnginesMock(page);
    await page.route(/\/v1\/engine-schedules(\/|$)/, async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      const body = req.method() === "GET" ? undefined : req.postDataJSON();
      calls.push({ method: req.method(), path: p, body });
      if (req.method() === "GET") return json(route, { schedules });
      if (req.method() === "POST") return json(route, { schedule: { ...schedules[1], id: U(702), ...body } }, 201);
      const s = schedules.find((x) => p.endsWith(x.id));
      Object.assign(s, body);
      return json(route, { schedule: s });
    });
    await page.goto("/ui/admin/redteam");
    await expect(page.getByText("Recurring runs", { exact: true })).toBeVisible({ timeout: 30_000 });
    const schedule = page.getByRole("button", { name: "Schedule this run" });
    await expect(schedule).toBeDisabled();
    await expect(page.getByText(/Complete the run form above first/)).toBeVisible();

    const f = page.getByTestId("engine-run-form");
    await f.getByLabel("Engine", { exact: true }).selectOption("promptfoo");
    await f.getByLabel("Agent under test", { exact: true }).selectOption(ENGINE_AGENT);
    await f.getByLabel("Judge agent", { exact: true }).selectOption(ENGINE_JUDGE);
    await f.getByLabel("Bill to project", { exact: true }).selectOption(ENGINE_PROJECT);
    await f.getByLabel("Sets", { exact: true }).fill("basic");
    await page.getByLabel("Every (hours)").fill("6");
    await schedule.click();
    await expect.poll(() => sent(calls, "POST", "/v1/engine-schedules")).toEqual([
      { request: { engineId: "promptfoo", target: { agentId: ENGINE_AGENT, judgeAgentId: ENGINE_JUDGE }, config: { sets: ["basic"], params: {} }, projectId: ENGINE_PROJECT, trials: 3 }, intervalHours: 6 },
    ]);

    await expect(page.getByText("Only the person this schedule runs as can switch it back on", { exact: false }).first()).toBeVisible();
    await expectAxeClean(page, "recurring runs");
    await page.getByRole("button", { name: "Switch off" }).click();
    await expect.poll(() => sent(calls, "PATCH", `/v1/engine-schedules/${U(701)}`)).toEqual([{ enabled: false }]);
    await page.getByRole("row").filter({ hasText: "12 h" }).getByRole("button", { name: "Switch on" }).click();
    await page.getByRole("dialog", { name: "Switch this schedule back on?" }).getByRole("button", { name: "Switch on" }).click();
    await expect.poll(() => sent(calls, "PATCH", `/v1/engine-schedules/${U(701)}`)).toEqual([{ enabled: false }, { enabled: true }]);
  });
});

// ---------------------------------------------------------------------------
// ADR-0065 regulAIt-LLM
// ---------------------------------------------------------------------------

test.describe("regulAIt-LLM — add rows, validate, poll (ADR-0065)", () => {
  test("rows are checked by line, a blocked scan is named, validation and poll report back", async ({ page }) => {
    const DS = { id: U(800), name: "faq", version: 1, note: null, format: "prompt_completion", rowCount: 2, charCount: 40, checksum: "sha256:x", piiVerdict: "clean", piiMode: "block", scanFindings: { pii: [], guardrails: [] }, projectId: null, jobCount: 0, frozen: false, createdAt: ISO };
    const JOB = { id: U(810), name: "faq-index", datasetId: DS.id, datasetName: "faq", datasetVersion: 1, backend: "remote-example", method: "lora_sft", baseModel: null, status: "running", progress: 0.4, error: null, estimatedCostUsd: 1, costUsd: null, projectId: null, approvalId: null, createdAt: ISO, durationMs: null };
    let blockNext = true;
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/llm\/backends$/, () => ({ body: { enabled: true, approvalThresholdUsd: 10, note: "", backends: [{ kind: "local", requiresCredential: false, inProcess: true, methods: ["retrieval_index", "text_classifier"], producesQueryableArtifact: true, supportsCancel: true, summary: "", limits: "IT DOES NOT FINE-TUNE A LANGUAGE MODEL", defaultBaseUrl: null, configured: true, configEnabled: true, hasCredential: false, baseUrl: null, lastTestError: null }] } })],
      ["GET", /^\/v1\/llm\/datasets$/, () => ({ body: { datasets: [DS], note: "" } })],
      ["GET", /^\/v1\/llm\/datasets\/([^/]+)$/, () => ({ body: { dataset: DS, rows: [{ id: "r1", idx: 0, input: "q", output: "a" }], versions: [DS], jobs: [], frozen: false } })],
      ["POST", /^\/v1\/llm\/datasets\/([^/]+)\/rows$/, () => {
        if (blockNext) {
          blockNext = false;
          return { status: 422, body: { error: "training_data_refused", detail: "1 email address found at mode block", findings: { pii: [{ category: "email", count: 1 }], guardrails: [] } } };
        }
        return { body: { dataset: DS, added: 1, scan: { verdict: "clean", findings: { pii: [], guardrails: [] } } } };
      }],
      ["POST", /^\/v1\/llm\/datasets\/([^/]+)\/validate$/, () => ({ body: { validation: { ok: true, rowCount: 2, charCount: 40, checksum: "sha256:x", errors: [], warnings: ["one label has 1 example"], labels: [], split: { trainIdx: [0], evalIdx: [1] } }, hyperparameters: { topK: 3 }, hyperparameterErrors: [], estimatedCostUsd: null, capabilities: {} } })],
      ["GET", /^\/v1\/llm\/jobs$/, () => ({ body: { jobs: [JOB] } })],
      ["POST", /^\/v1\/llm\/jobs\/([^/]+)\/poll$/, () => ({ status: 409, body: { error: "job_not_running", detail: "job is 'succeeded'" } })],
      ["GET", /^\/v1\/llm\/artifacts$/, () => ({ body: { artifacts: [], note: "" } })],
    ]);
    await page.goto("/ui/admin/regulait-llm");
    await page.getByRole("cell", { name: "faq", exact: true }).click({ timeout: 30_000 });
    const add = page.getByRole("form", { name: "Add rows to faq v1" });
    await add.getByLabel("Rows to add (JSON Lines)").fill('{"input":"ok"}\n{"output":"no input"}');
    await add.getByRole("button", { name: "Scan and add rows" }).click();
    await expect(add.getByRole("alert")).toHaveText('Line 2 has no "input".');
    expect(sent(calls, "POST", `/v1/llm/datasets/${DS.id}/rows`)).toEqual([]);

    await add.getByLabel("Rows to add (JSON Lines)").fill('{"input":"mail me at a@b.test","output":"sure"}');
    await add.getByRole("button", { name: "Scan and add rows" }).click();
    await expect(page.getByTestId("llm-add-rows-outcome")).toContainText("The ingest scan refused these rows, so nothing was added.");
    await expect(page.getByTestId("llm-add-rows-outcome")).toContainText("email ×1");
    await add.getByRole("button", { name: "Scan and add rows" }).click();
    await expect(page.getByTestId("llm-add-rows-outcome")).toContainText("Added 1.");
    expect(sent(calls, "POST", `/v1/llm/datasets/${DS.id}/rows`)[1]).toEqual({ rows: [{ input: "mail me at a@b.test", output: "sure" }] });

    const validate = page.getByRole("form", { name: "Validate this version" });
    await validate.getByLabel("Neighbours (topK) (default 3)").fill("5");
    await validate.getByRole("button", { name: "Validate" }).click();
    await expect(page.getByTestId("llm-validate-result")).toContainText("would train");
    await expect(page.getByTestId("llm-validate-result")).toContainText("No estimate (price unknown)");
    expect(sent(calls, "POST", `/v1/llm/datasets/${DS.id}/validate`)).toEqual([{ method: "retrieval_index", backend: "local", hyperparameters: { topK: 5 } }]);
    await expectAxeClean(page, "llm dataset tools");

    await page.getByRole("button", { name: "Poll faq-index now" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "not running any more" }).first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// ADR-0175 expected served model
// ---------------------------------------------------------------------------

test.describe("Agents — expected served model (ADR-0175)", () => {
  test("setting it is confirmed as a relaxation and stepped up; clearing sends null and asks nothing", async ({ page }) => {
    const AGENT = { id: U(900), name: "deployment-bot", provider: "mock", tier: 1, model: "prod-deployment", enabled: true, costPerMTokIn: null, costPerMTokOut: null, systemPrompt: null, expectedServedModel: null };
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/agents$/, () => ({ body: { agents: [AGENT] } })],
      ["PUT", /^\/v1\/agents\/([^/]+)\/expected-served-model$/, ({ body }) => {
        AGENT.expectedServedModel = body.expectedServedModel;
        return { body: AGENT };
      }],
    ]);
    const su = await requireStepUpOn(page, {
      method: "PUT",
      path: `/v1/agents/${AGENT.id}/expected-served-model`,
      kind: "settings_relax",
      when: (b) => (b as Json).expectedServedModel !== null,
      facts: (b) => ({ op: "agent_expected_served_model", agentId: AGENT.id, expectedServedModel: (b as Json).expectedServedModel }),
    });
    await page.goto("/ui/admin/agents");
    const card = page.locator("section").filter({ has: page.getByText("Expected served model — drift baseline", { exact: true }) });
    await card.getByLabel("Agent", { exact: true }).selectOption(AGENT.id, { timeout: 30_000 });
    await expect(card).toContainText("the strict default");
    await card.getByLabel("Expected served model (empty = the configured model)").fill("example-served-model-v1");
    await card.getByRole("button", { name: "Save expected model" }).click();
    const dialog = page.getByRole("dialog", { name: "Change what counts as served-model drift?" });
    await expect(dialog).toContainText("relaxes the strict default");
    await expectAxeClean(page, "expected served model confirmation");
    await dialog.getByRole("button", { name: "Set expected model" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    await expect.poll(() => sent(calls, "PUT", `/v1/agents/${AGENT.id}/expected-served-model`)).toEqual([{ expectedServedModel: "example-served-model-v1" }]);
    await card.getByLabel("Expected served model (empty = the configured model)").fill("");
    await card.getByRole("button", { name: "Clear expected model" }).click();
    await expect.poll(() => sent(calls, "PUT", `/v1/agents/${AGENT.id}/expected-served-model`).length).toBe(2);
    expect(sent(calls, "PUT", `/v1/agents/${AGENT.id}/expected-served-model`)[1]).toEqual({ expectedServedModel: null });
    // the clear was never refused for a step-up: the harness saw only the two attempts of the relaxation
    expect(su.attempts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ADR-0188 issuer signing keys and a delegation grant's detail
// ---------------------------------------------------------------------------

test.describe("Workload identities — signing keys and grant detail (ADR-0188)", () => {
  const KEY_ACTIVE = { kid: "kid-active-1", algorithm: "Ed25519", publicJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" }, createdAt: ISO, activatedAt: ISO, retiredAt: null, revokedAt: null };
  const KEY_OLD = { ...KEY_ACTIVE, kid: "kid-old-0", retiredAt: ISO };
  const RUN = U(30);
  const ROOT = { id: U(40), rootGrantId: U(40), parentGrantId: null, path: [], depth: 0, sponsorUserId: ME, actorIdentityId: U(20), runId: RUN, projectId: null, capMicros: 100_000_000, settledMicros: 10_000_000, reservedMicros: 0, environment: "dev", audience: "https://gw.example.test", expiresAt: LATER, revokedAt: null, revokedReason: null, createdAt: ISO };

  async function open(page: Page, rotateRefusal?: Json) {
    const calls = await mockApi(page, [
      ["GET", /^\/v1\/workload-identities$/, () => ({ body: { items: [], nextCursor: null } })],
      ["GET", /^\/v1\/identity\/signing-keys$/, () => ({ body: { items: [KEY_ACTIVE, KEY_OLD] } })],
      ["POST", /^\/v1\/identity\/signing-keys\/rotate$/, () => (rotateRefusal ? { status: 409, body: rotateRefusal } : { body: { kid: "kid-new-2", previousKid: KEY_ACTIVE.kid } })],
      ["POST", /^\/v1\/identity\/signing-keys\/([^/]+)\/revoke$/, ({ match }) => ({ body: { kid: match[1], tokensRevoked: 3 } })],
      ["GET", /^\/v1\/delegation-grants$/, () => ({ body: { items: [ROOT], edges: [], nextCursor: null } })],
      ["GET", /^\/v1\/delegation-grants\/([^/]+)$/, () => ({ body: { ...ROOT, allocation: null, childAllocations: [{ id: U(50), parentGrantId: ROOT.id, childGrantId: U(41), amountMicros: 60_000_000, drawnMicros: 10_000_000, releasedMicros: 0, status: "open", createdAt: ISO, closedAt: null }] } })],
    ]);
    await page.goto("/ui/admin/workload-identities");
    await expect(page.getByText("Issuer signing keys", { exact: true })).toBeVisible({ timeout: 30_000 });
    return calls;
  }

  test("rotate and revoke are confirmed and resent once through the identity_manage step-up", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("row").filter({ hasText: "kid-old-0" })).toContainText("retired");
    await expectAxeClean(page, "signing keys");
    const rotate = await requireStepUpOn(page, { method: "POST", path: "/v1/identity/signing-keys/rotate", kind: "identity_manage" });
    await page.getByRole("button", { name: "Rotate key" }).click();
    await page.getByRole("dialog", { name: "Rotate the issuer signing key?" }).getByRole("button", { name: "Rotate key" }).click();
    await confirmStepUp(page);
    await rotate.expectResentOnce();
    expect(rotate.attempts[1]!.body).toEqual({});

    const revoke = await requireStepUpOn(page, { method: "POST", path: "/v1/identity/signing-keys/kid-active-1/revoke", kind: "identity_manage" });
    await page.getByRole("button", { name: "Revoke signing key kid-active-1" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke this signing key?" });
    await expect(dialog).toContainText("It is the active signer");
    await dialog.getByRole("button", { name: "Revoke key" }).click();
    await confirmStepUp(page);
    await revoke.expectResentOnce();
  });

  test("an ambiguous rotation is named; a grant's detail shows its allocations", async ({ page }) => {
    await open(page, { error: "signing_key_ambiguous", detail: "more than one configured key is available" });
    await page.getByRole("button", { name: "Rotate key" }).click();
    await page.getByRole("dialog", { name: "Rotate the issuer signing key?" }).getByRole("button", { name: "Rotate key" }).click();
    await expect(page.getByText("More than one configured key is available. Name the one to activate.").first()).toBeVisible();

    await page.getByLabel("Run ID").fill(RUN);
    await page.getByRole("button", { name: "Load delegation tree" }).click();
    await page.getByRole("button", { name: /^Details of the grant for / }).click();
    const detail = page.getByTestId("delegation-grant-detail");
    await expect(detail).toContainText("Root grant");
    await expect(detail).toContainText("No incoming allocation (a root grant).");
    await expect(detail).toContainText("allocated $60.00, drawn $10.00");
    await expectAxeClean(page, "delegation grant detail");
  });
});
