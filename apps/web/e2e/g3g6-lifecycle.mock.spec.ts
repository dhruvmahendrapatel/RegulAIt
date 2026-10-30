/**
 * ADR-0207 (G3–G6) — the lifecycle actions of the integration pages against mocked gateway routes: connectors and MCP
 * servers (disable with a reason, enable, delete with an in-use refusal), MCP server edit and registry delete, git
 * connections (edit, replace token, egress refusal) and PM connections (edit, replace token, rotate the webhook
 * secret with the 24-hour overlap). Each test asserts the request the page sends, so the UI and the gateway contract
 * (`@regulait/shared`'s ADR-0207 schemas) cannot drift apart unseen.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ISO = "2026-10-20T10:00:00.000Z";

test.use({ colorScheme: "light", timezoneId: "Europe/London", locale: "en-GB" });

interface Sent {
  method: string;
  path: string;
  body: unknown;
}
type Handler = (route: Route, method: string, path: string, body: unknown) => Promise<void> | void | false;

/** answers GETs from `routes`, hands every other call to `handler`, and records each non-GET call in `sent` */
async function mockApi(page: Page, routes: Record<string, unknown>, handler: Handler): Promise<Sent[]> {
  const sent: Sent[] = [];
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
  await page.addInitScript(() => {
    try {
      localStorage.setItem("regulait.theme", "light");
    } catch {
      /* ignore */
    }
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (req.method() !== "GET") {
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      sent.push({ method: req.method(), path: p, body });
      const out = await handler(route, req.method(), p, body);
      if (out !== false) return;
      return json(route, {});
    }
    if (p in routes) return json(route, routes[p]);
    return json(route, {});
  });
  return sent;
}

const users = { users: [{ id: "u-admin", email: "ada@example.test", displayName: "Ada Admin", isAdmin: true }] };
const REASON = "Vendor contract under review; pause all calls.";

// ---------------------------------------------------------------- G3
const connectors = {
  connectors: [
    { id: "c1", name: "team-17-support-desk", kind: "ticketing", providerKind: "http", baseUrl: null, pricePerCallUsd: 0.002, ownership: "owned", enabled: true },
    {
      id: "c3",
      name: "legacy-crm",
      kind: "crm",
      providerKind: null,
      baseUrl: null,
      pricePerCallUsd: null,
      ownership: "orphaned",
      enabled: false,
      disabledReason: "Replaced by the new CRM; no grants should use it any more.",
      disabledAt: "2026-10-27T09:42:00.000Z",
      disabledBy: "ada@example.test",
    },
  ],
};

test("G3 connectors: disable sends the reason, enable and delete call the real routes, an in-use delete is explained", async ({ page }) => {
  const sent = await mockApi(page, { "/v1/connectors": connectors, "/v1/users": users }, (route, method, p) => {
    if (method === "DELETE" && p === "/v1/connectors/c3") return json(route, { error: "connector_in_use", approvals: 3, chatopsConnections: 1 }, 409);
    if (method === "POST" && p.endsWith("/enabled")) return json(route, { enabled: true });
    return false;
  });
  await page.goto("/ui/admin/connectors");
  await expect(page.getByRole("row", { name: /legacy-crm/ })).toBeVisible();
  // a live connector cannot be deleted until it is disabled
  await expect(page.getByRole("button", { name: "Delete connector team-17-support-desk, unavailable: disable it first" })).toBeVisible();

  await page.getByRole("button", { name: "Disable connector team-17-support-desk" }).click();
  const dlg = page.getByRole("dialog", { name: /Disable connector/ });
  await dlg.getByLabel("Reason").fill(REASON);
  await dlg.getByRole("button", { name: "Disable connector" }).click();
  await expect.poll(() => sent.find((s) => s.path === "/v1/connectors/c1/enabled")?.body).toEqual({ enabled: false, reason: REASON });

  await page.getByRole("button", { name: "Enable connector legacy-crm" }).click();
  await page.getByRole("dialog", { name: /Enable connector/ }).getByRole("button", { name: "Enable connector" }).click();
  await expect.poll(() => sent.find((s) => s.path === "/v1/connectors/c3/enabled")?.body).toEqual({ enabled: true });

  await page.getByRole("button", { name: "Delete connector legacy-crm", exact: true }).click();
  const del = page.getByRole("dialog", { name: /Delete connector/ });
  await del.getByRole("button", { name: "Delete connector" }).click();
  await expect(del.getByTestId("delete-refusal")).toContainText("3 approvals and 1 chat connection");
  expect(sent.some((s) => s.method === "DELETE" && s.path === "/v1/connectors/c3")).toBe(true);
});

// ---------------------------------------------------------------- G4
const servers = {
  servers: [
    { id: "s1", name: "credit-ops-tools", url: "https://mcp.example.test/credit", transport: "streamable_http", admissionState: "clean", ownership: "owned", pricePerCallUsd: 0.01, enabled: true },
    {
      id: "s2",
      name: "doc-archive",
      url: "https://mcp.example.test/docs",
      transport: "streamable_http",
      admissionState: "clean",
      ownership: "owned",
      pricePerCallUsd: null,
      enabled: false,
      disabledReason: "Tool started returning customer data outside the approved scope.",
      disabledAt: "2026-10-28T14:05:00.000Z",
      disabledBy: "ada@example.test",
    },
  ],
};
const registries = {
  deployMode: "standard",
  federationRefused: false,
  federationRefusedReason: null,
  maxPagesPerSync: 20,
  maxRegistriesPerSweep: 5,
  registries: [
    { id: "r1", name: "team-17 catalogue", url: "https://registry.example.test", enabled: true, allowPrivateRanges: null, lastSyncAt: ISO, lastSyncOutcome: "ok", lastSyncDetail: null, createdAt: ISO },
    { id: "r2", name: "old pilot catalogue", url: "https://pilot.example.test", enabled: false, allowPrivateRanges: null, lastSyncAt: ISO, lastSyncOutcome: "ok", lastSyncDetail: null, createdAt: ISO },
  ],
};

test("G4 MCP servers: actions sit next to the name; edit, disable and an in-use delete; registry delete", async ({ page }) => {
  const sent = await mockApi(page, { "/v1/servers": servers, "/v1/users": users, "/v1/mcp-registries": registries }, (route, method, p) => {
    if (method === "DELETE" && p === "/v1/servers/s2") return json(route, { error: "mcp_server_in_use", approvals: 2, agentGrants: 4, approvalRules: 1 }, 409);
    if (method === "DELETE" && p === "/v1/mcp-registries/r2") return json(route, { removed: true, entriesRemoved: 3, detachedServers: [] });
    if (method === "PATCH" && p === "/v1/servers/s1") return json(route, { ...servers.servers[0], name: "credit-ops-tools-v2" });
    if (method === "POST" && p.endsWith("/enabled")) return json(route, { enabled: false });
    return false;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/ui/admin/mcp-servers");
  await expect(page.getByRole("link", { name: /doc-archive/ })).toBeVisible();
  // G4: the table is wide; the actions column is the second one, so its buttons are on screen without scrolling
  const serverTable = page.getByRole("table").filter({ has: page.getByRole("link", { name: /doc-archive/ }) });
  // the header row (its cells are the column headers as the table kit renders them)
  const headers = await serverTable.getByRole("row").first().getByRole("cell").allTextContents();
  expect(headers.slice(0, 2).map((h) => h.trim())).toEqual(["Name", "Actions"]);
  await expect(page.getByRole("button", { name: "Disable MCP server credit-ops-tools" })).toBeInViewport();

  // a disabled server is read-only: its Edit is unavailable
  await expect(page.getByRole("button", { name: "Edit MCP server doc-archive" })).toBeDisabled();
  await page.getByRole("button", { name: "Edit MCP server credit-ops-tools" }).click();
  const edit = page.getByRole("dialog", { name: /Edit MCP server/ });
  await edit.getByLabel("Name").fill("credit-ops-tools-v2");
  await edit.getByLabel("URL").fill("https://mcp.example.test/credit-v2");
  // a url move warns that identity propagation and the upstream credential do not follow it
  await expect(edit.getByRole("note")).toContainText("deletes the stored upstream credential");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => sent.find((s) => s.method === "PATCH" && s.path === "/v1/servers/s1")?.body).toEqual({
    name: "credit-ops-tools-v2",
    url: "https://mcp.example.test/credit-v2",
  });

  await page.getByRole("button", { name: "Disable MCP server credit-ops-tools" }).click();
  const dlg = page.getByRole("dialog", { name: /Disable MCP server/ });
  await dlg.getByLabel("Reason").fill("Suspected prompt injection in a tool description.");
  await dlg.getByRole("button", { name: "Disable MCP server" }).click();
  await expect.poll(() => sent.find((s) => s.path === "/v1/servers/s1/enabled")?.body).toEqual({
    enabled: false,
    reason: "Suspected prompt injection in a tool description.",
  });

  await page.getByRole("button", { name: "Delete MCP server doc-archive", exact: true }).click();
  const del = page.getByRole("dialog", { name: /Delete MCP server/ });
  await del.getByRole("button", { name: "Delete MCP server" }).click();
  await expect(del.getByTestId("delete-refusal")).toContainText("2 approvals, 4 agent grants and 1 approval rule");
  await del.getByRole("button", { name: "Close" }).click();

  await page.goto("/ui/admin/mcp-servers?tab=registries");
  await expect(page.getByRole("row", { name: /old pilot catalogue/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete registry team-17 catalogue, unavailable: disable it first" })).toBeVisible();
  await page.getByRole("button", { name: "Delete registry old pilot catalogue" }).click();
  await page.getByRole("dialog", { name: /Delete registry/ }).getByRole("button", { name: "Delete registry" }).click();
  await expect.poll(() => sent.some((s) => s.method === "DELETE" && s.path === "/v1/mcp-registries/r2")).toBe(true);
});

// ---------------------------------------------------------------- G5
const git = {
  connections: [
    { id: "g1", name: "credit-ops-git", provider: "github", baseUrl: null, createdAt: ISO },
    { id: "g2", name: "demo-git", provider: "mock", baseUrl: null, createdAt: ISO },
  ],
};

test("G5 git connections: replace the token, and an egress refusal on edit is answered in the dialog", async ({ page }) => {
  const sent = await mockApi(page, { "/v1/git/connections": git }, (route, method, p) => {
    if (method === "PATCH" && p === "/v1/git/connections/credit-ops-git") return json(route, { error: "egress_blocked", code: "host_not_allowlisted", detail: "not allowed" }, 400);
    if (method === "POST" && p.endsWith("/token")) return json(route, { replaced: true, secretSetAt: ISO });
    return false;
  });
  await page.goto("/ui/admin/git-connections");
  await expect(page.getByRole("row", { name: /credit-ops-git/ })).toBeVisible();

  await page.getByRole("button", { name: "Replace token: credit-ops-git" }).click();
  const rep = page.getByRole("dialog", { name: /Replace the token/ });
  await rep.getByLabel("New token").fill("example-token-value");
  await rep.getByRole("button", { name: "Replace token" }).click();
  await expect(page.getByText("Token replaced. Revoke the old token in the git host.")).toBeVisible();
  expect(sent.find((s) => s.path === "/v1/git/connections/credit-ops-git/token")?.body).toEqual({ token: "example-token-value" });

  await page.getByRole("button", { name: "Edit credit-ops-git" }).click();
  const edit = page.getByRole("dialog", { name: /Edit git connection/ });
  await edit.getByLabel(/Base URL/).fill("https://git.example.test/api/v3");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.getByTestId("edit-refusal")).toContainText("egress allow-list");
  expect(sent.find((s) => s.method === "PATCH")?.body).toEqual({ baseUrl: "https://git.example.test/api/v3" });
});

// ---------------------------------------------------------------- G6
const pm = {
  connections: [
    { id: "p1", name: "credit-ops-pm", provider: "jira", project: "CREDOPS", baseUrl: null, apiVersion: 3, driftResolution: "manual", createdAt: ISO, previousSecretValidUntil: "2099-10-30T15:10:00.000Z" },
    { id: "p2", name: "team-17-support", provider: "mock", project: "T17", baseUrl: null, apiVersion: null, driftResolution: "prefer_regulait", createdAt: ISO, previousSecretValidUntil: null },
  ],
};

test("G6 PM connections: Rotate secret with the overlap, a rotation in progress, edit and replace token", async ({ page }) => {
  const sent = await mockApi(page, { "/v1/pm/connections": pm }, (route, method, p, body) => {
    if (method === "POST" && p === "/v1/pm/connections/credit-ops-pm/webhook-secret/rotate") {
      if ((body as { immediate?: boolean } | null)?.immediate) return json(route, { webhookSecret: "rglwh_EXAMPLEONLY_9f2c41d7b0e8", previousValidUntil: null });
      return json(route, { error: "rotation_in_progress", previousValidUntil: "2099-10-30T15:10:00.000Z" }, 409);
    }
    if (method === "POST" && p === "/v1/pm/connections/team-17-support/webhook-secret/rotate")
      return json(route, { webhookSecret: "rglwh_EXAMPLEONLY_4b7e0a19c3d2", previousValidUntil: "2099-10-30T15:10:00.000Z" });
    if (method === "PATCH") return json(route, pm.connections[0]);
    if (method === "POST" && p.endsWith("/token")) return json(route, { replaced: true, secretSetAt: ISO });
    return false;
  });
  await page.goto("/ui/admin/pm-connections");
  await expect(page.getByRole("row", { name: /credit-ops-pm/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /credit-ops-pm/ })).toContainText("previous secret valid until");
  await expect(page.getByRole("button", { name: "Rotate webhook secret: team-17-support" })).toHaveText("Rotate secret");

  await page.getByRole("button", { name: "Rotate webhook secret: credit-ops-pm" }).click();
  const rot = page.getByRole("dialog", { name: /Rotate the webhook secret/ });
  await expect(rot).toContainText("keeps working for 24 hours");
  await rot.getByRole("button", { name: "Rotate secret" }).click();
  await expect(rot.getByTestId("rotation-in-progress")).toBeVisible();
  await rot.getByRole("button", { name: "Rotate immediately" }).click();
  await expect(page.getByTestId("revealed-secret")).toBeVisible();
  const rotations = sent.filter((s) => s.path === "/v1/pm/connections/credit-ops-pm/webhook-secret/rotate").map((s) => s.body);
  expect(rotations).toEqual([{}, { immediate: true }]);

  await page.getByRole("button", { name: "Edit credit-ops-pm" }).click();
  const edit = page.getByRole("dialog", { name: /Edit PM connection/ });
  await edit.getByLabel("Project").fill("CREDOPS2");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => sent.find((s) => s.method === "PATCH")?.body).toEqual({ project: "CREDOPS2", baseUrl: null, apiVersion: 3, driftResolution: "manual" });

  await page.getByRole("button", { name: "Replace token: team-17-support" }).click();
  const rep = page.getByRole("dialog", { name: /Replace the token/ });
  await rep.getByLabel("New token").fill("example-pm-token");
  await rep.getByRole("button", { name: "Replace token" }).click();
  await expect.poll(() => sent.find((s) => s.path === "/v1/pm/connections/team-17-support/token")?.body).toEqual({ token: "example-pm-token" });
});
