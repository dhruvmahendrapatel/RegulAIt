/**
 * #453 prototype screenshots (G3–G6): connectors, MCP servers + registries, git and PM connections.
 * Throwaway: the routes it mocks do not exist yet.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const SHOTS = "/tmp/claude-0/-home-user/ded6cb3a-43af-5029-b67a-cd4793943c17/scratchpad/proposals/shots";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ISO = "2026-10-20T10:00:00.000Z";

test.use({ colorScheme: "light", timezoneId: "Europe/London", locale: "en-GB" });

type Handler = (route: Route, method: string, path: string, body: unknown) => Promise<void> | void | false;

async function mockApi(page: Page, routes: Record<string, unknown>, handler?: Handler) {
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
    if (handler) {
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      const out = await handler(route, req.method(), p, body);
      if (out !== false && out !== undefined) return;
      if (out === undefined && req.method() !== "GET") return; // handler answered
    }
    if (req.method() === "GET" && p in routes) return json(route, routes[p]);
    return json(route, {});
  });
}

const users = { users: [{ id: "u-admin", email: "ada@example.test", displayName: "Ada Admin", isAdmin: true }] };

// ---------------------------------------------------------------- G3
const connectors = {
  connectors: [
    { id: "c1", name: "team-17-support-desk", kind: "ticketing", providerKind: "http", baseUrl: null, pricePerCallUsd: 0.002, ownership: "owned", enabled: true },
    { id: "c2", name: "credit-bureau-lookup", kind: "data", providerKind: "generic", baseUrl: null, pricePerCallUsd: 0.05, ownership: "owned", enabled: true },
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
      disabledBy: "Ada Admin",
    },
  ],
};

test("G3 connectors", async ({ page }) => {
  await mockApi(page, { "/v1/connectors": connectors, "/v1/users": users }, (route, method, p) => {
    if (method === "DELETE" && p === "/v1/connectors/c3") return json(route, { error: "connector_in_use", approvals: 3, chatopsConnections: 1 }, 409);
    if (method === "POST" && p.endsWith("/enabled")) return json(route, { ok: true });
    return false;
  });
  await page.goto("/ui/admin/connectors");
  const catalog = page.getByRole("row", { name: /legacy-crm/ });
  await expect(catalog).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g3-connectors.png` });

  await page.getByRole("button", { name: "Disable connector team-17-support-desk" }).click();
  const dlg = page.getByRole("dialog", { name: /Disable connector/ });
  await dlg.getByLabel("Reason").fill("Vendor contract under review; pause all calls.");
  await page.screenshot({ path: `${SHOTS}/g3-disable-confirm.png` });
  await dlg.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Enable connector legacy-crm" }).click();
  await expect(page.getByRole("dialog", { name: /Enable connector/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g3-enable-confirm.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Delete connector legacy-crm", exact: true }).click();
  const del = page.getByRole("dialog", { name: /Delete connector/ });
  await del.getByRole("button", { name: "Delete connector" }).click();
  await expect(del.getByTestId("delete-refusal")).toContainText("3 approvals and 1 chat connection");
  await page.screenshot({ path: `${SHOTS}/g3-delete-refused.png` });
});

// ---------------------------------------------------------------- G4
const servers = {
  servers: [
    { id: "s1", name: "credit-ops-tools", url: "https://mcp.example.test/credit", transport: "streamable_http", admissionState: "admitted", ownership: "owned", pricePerCallUsd: 0.01, enabled: true },
    {
      id: "s2",
      name: "doc-archive",
      url: "https://mcp.example.test/docs",
      transport: "streamable_http",
      admissionState: "admitted",
      ownership: "owned",
      pricePerCallUsd: null,
      enabled: false,
      disabledReason: "Tool started returning customer data outside the approved scope.",
      disabledAt: "2026-10-28T14:05:00.000Z",
      disabledBy: "Morgan Reyes",
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

test("G4 MCP servers and registries", async ({ page }) => {
  await mockApi(page, { "/v1/servers": servers, "/v1/users": users, "/v1/mcp-registries": registries }, (route, method, p) => {
    if (method === "DELETE" && p === "/v1/servers/s2") return json(route, { error: "mcp_server_in_use", approvals: 2, agentGrants: 4 }, 409);
    return false;
  });
  await page.goto("/ui/admin/mcp-servers");
  await expect(page.getByRole("link", { name: /doc-archive/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g4-servers.png` });
  // the registry table is wide: the row actions sit at its right edge
  await page.getByRole("button", { name: "Disable MCP server credit-ops-tools" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/g4-servers-actions.png` });

  await page.getByRole("button", { name: "Disable MCP server credit-ops-tools" }).click();
  const dlg = page.getByRole("dialog", { name: /Disable MCP server/ });
  await dlg.getByLabel("Reason").fill("Suspected prompt injection in a tool description.");
  await page.screenshot({ path: `${SHOTS}/g4-disable-confirm.png` });
  await dlg.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Delete MCP server doc-archive", exact: true }).click();
  const del = page.getByRole("dialog", { name: /Delete MCP server/ });
  await del.getByRole("button", { name: "Delete MCP server" }).click();
  await expect(del.getByTestId("delete-refusal")).toContainText("2 approvals and 4 agent grants");
  await page.screenshot({ path: `${SHOTS}/g4-delete-refused.png` });
  await del.getByRole("button", { name: "Close" }).click();

  await page.goto("/ui/admin/mcp-servers?tab=registries");
  await expect(page.getByRole("row", { name: /old pilot catalogue/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g4-registries.png` });
  await page.getByRole("button", { name: "Delete registry old pilot catalogue" }).click();
  await expect(page.getByRole("dialog", { name: /Delete registry/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g4-registry-delete.png` });
});

// ---------------------------------------------------------------- G5
const git = {
  connections: [
    { id: "g1", name: "credit-ops-git", provider: "github", baseUrl: null, createdAt: ISO },
    { id: "g2", name: "demo-git", provider: "mock", baseUrl: null, createdAt: ISO },
  ],
};

test("G5 git connections", async ({ page }) => {
  await mockApi(page, { "/v1/git/connections": git }, (route, method, p) => {
    if (method === "PATCH" && p === "/v1/git/connections/credit-ops-git") return json(route, { error: "egress_blocked", host: "redacted" }, 422);
    if (method === "POST" && p.endsWith("/token")) return json(route, { ok: true });
    return false;
  });
  await page.goto("/ui/admin/git-connections");
  await expect(page.getByRole("row", { name: /credit-ops-git/ })).toBeVisible();
  await page.getByRole("table").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/g5-git.png` });

  await page.getByRole("button", { name: "Replace token: credit-ops-git" }).click();
  const rep = page.getByRole("dialog", { name: /Replace the token/ });
  await rep.getByLabel("New token").fill("example-token-value");
  await page.screenshot({ path: `${SHOTS}/g5-replace-token.png` });
  await rep.getByRole("button", { name: "Replace token" }).click();
  await expect(page.getByText("Token replaced. Revoke the old token on the git host.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g5-replace-token-done.png` });

  await page.getByRole("button", { name: "Edit credit-ops-git" }).click();
  const edit = page.getByRole("dialog", { name: /Edit git connection/ });
  await expect(edit).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g5-edit.png` });
  await edit.getByLabel(/Base URL/).fill("https://git.example.test/api/v3");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.getByTestId("edit-refusal")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g5-edit-refused.png` });
});

// ---------------------------------------------------------------- G6
const pm = {
  connections: [
    { id: "p1", name: "credit-ops-pm", provider: "jira", project: "CREDOPS", baseUrl: null, apiVersion: 3, driftResolution: "manual", createdAt: ISO, previousSecretValidUntil: "2026-10-30T15:10:00.000Z" },
    { id: "p2", name: "team-17-support", provider: "mock", project: "T17", baseUrl: null, apiVersion: null, driftResolution: "prefer_regulait", createdAt: ISO, previousSecretValidUntil: null },
  ],
};

test("G6 PM connections", async ({ page }) => {
  await mockApi(page, { "/v1/pm/connections": pm }, (route, method, p, body) => {
    if (method === "POST" && p === "/v1/pm/connections/credit-ops-pm/webhook-secret/rotate") {
      if ((body as { immediate?: boolean } | null)?.immediate) return json(route, { webhookSecret: "rglwh_EXAMPLEONLY_9f2c41d7b0e8", previousValidUntil: null });
      return json(route, { error: "rotation_in_progress", previousValidUntil: "2026-10-30T15:10:00.000Z" }, 409);
    }
    if (method === "POST" && p === "/v1/pm/connections/team-17-support/webhook-secret/rotate")
      return json(route, { webhookSecret: "rglwh_EXAMPLEONLY_4b7e0a19c3d2", previousValidUntil: "2026-10-30T15:10:00.000Z" });
    return false;
  });
  await page.goto("/ui/admin/pm-connections");
  await expect(page.getByRole("row", { name: /credit-ops-pm/ })).toBeVisible();
  await page.getByRole("table").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/g6-pm.png` });

  await page.getByRole("button", { name: "Rotate webhook secret: team-17-support" }).click();
  const rot = page.getByRole("dialog", { name: /Rotate the webhook secret/ });
  await expect(rot).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g6-rotate-confirm.png` });
  await rot.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Rotate webhook secret: credit-ops-pm" }).click();
  const rot2 = page.getByRole("dialog", { name: /Rotate the webhook secret/ });
  await rot2.getByRole("button", { name: "Rotate webhook secret" }).click();
  await expect(rot2.getByTestId("rotation-in-progress")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g6-rotation-in-progress.png` });
  await rot2.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Rotate webhook secret: team-17-support" }).click();
  await page.getByRole("dialog", { name: /Rotate the webhook secret/ }).getByRole("button", { name: "Rotate webhook secret" }).click();
  await expect(page.getByTestId("revealed-secret")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/g6-rotate-reveal.png` });

  await page.getByRole("button", { name: "Edit credit-ops-pm" }).click();
  await expect(page.getByRole("dialog", { name: /Edit PM connection/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g6-edit.png` });
});
