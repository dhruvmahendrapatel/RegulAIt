/**
 * D1 (ADR-0337 §6) — SaaS app links, a sub-page of Discovery sources (`/admin/shadow-ai/discovery-sources/apps`):
 * the apps one entitlement source holds, their agent link, the admin link and unlink (only the transitions the
 * gateway's declared machine allows next), and the declared agent app ids (list, declare, remove). Every /v1 and
 * /auth call is answered by an in-test mock that follows apps/gateway/src/saas-entitlement-routes.ts: shapes, the
 * `sourceId` query, the link machine's `describe()` view and the 201/204 answers. Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const uuid = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ME = { userId: uuid("70000000", 1), isAdmin: true, user: { id: uuid("70000000", 1), email: "ada@example.test", displayName: "Ada Admin" } };
const NOW = "2026-11-18T10:00:00.000Z";
const OVERVIEW = "/ui/admin/shadow-ai/discovery-sources";
const SOURCE = uuid("71000000", 1);
const OTHER_SOURCE = uuid("71000000", 2);
const AGENT_CLAIMS = uuid("72000000", 1);
const AGENT_MINUTES = uuid("72000000", 2);
const AGENT_RETIRED = uuid("72000000", 3);

const sources = [
  { id: SOURCE, name: "Demo tenant app grants", kind: "entitlement_m365", target: {}, scope: { orgLevel: true, include: [] }, enabled: true, scheduleIntervalSeconds: 86400, version: 1, nextRunAt: null, lastRunAt: NOW, scannerBuilt: true, credential: null, lastRun: { status: "succeeded" } },
  { id: OTHER_SOURCE, name: "Fleet agent", kind: "endpoint_agent", target: {}, scope: { orgLevel: true, include: [] }, enabled: true, scheduleIntervalSeconds: 86400, version: 1, nextRunAt: null, lastRunAt: null, scannerBuilt: true, credential: null, lastRun: null },
];
const agents = [
  { id: AGENT_CLAIMS, name: "Claims triage bot", provider: "custom", tier: 1, model: null, enabled: true, lifecycleStatus: "active" },
  { id: AGENT_MINUTES, name: "Meeting minutes agent", provider: "custom", tier: 1, model: null, enabled: true, lifecycleStatus: "active" },
  { id: AGENT_RETIRED, name: "Old retired helper", provider: "custom", tier: 1, model: null, enabled: false, lifecycleStatus: "retired" },
];

/** SAAS_APP_AGENT_LINK_MACHINE.describe(state), as the gateway sends it */
const MACHINE: Record<string, { from: string[]; to: string; by: string[] }> = {
  auto_link: { from: ["none"], to: "auto", by: ["system"] },
  link: { from: ["none", "auto", "admin", "unlinked"], to: "admin", by: ["admin"] },
  unlink: { from: ["auto", "admin"], to: "unlinked", by: ["admin"] },
};
const describe = (state: string) => ({
  machine: "saas_app_agent_link",
  state,
  terminal: false,
  transitions: Object.entries(MACHINE).map(([event, t]) =>
    t.from.includes(state)
      ? { event, to: t.to, by: t.by, summary: event, allowed: true }
      : { event, to: t.to, by: t.by, summary: event, allowed: false, reason: `'${event}' is allowed only from ${t.from.map((s) => `'${s}'`).join(", ")}, and this is '${state}'` },
  ),
});

interface App {
  id: string;
  externalId: string;
  displayName: string;
  agentId: string | null;
  agentLinkState: "none" | "auto" | "admin" | "unlinked";
  grants: number;
}
const seedApps = (): App[] => [
  { id: uuid("73000000", 1), externalId: "9c1e0000-0000-4000-8000-00000000a07f", displayName: "Claims triage assistant", agentId: AGENT_CLAIMS, agentLinkState: "auto", grants: 4 },
  { id: uuid("73000000", 2), externalId: "41bd0000-0000-4000-8000-00000000e2c9", displayName: "Contract summariser", agentId: AGENT_CLAIMS, agentLinkState: "admin", grants: 2 },
  { id: uuid("73000000", 3), externalId: "77f00000-0000-4000-8000-000000001b3d", displayName: "Meeting notes helper", agentId: null, agentLinkState: "none", grants: 6 },
  { id: uuid("73000000", 4), externalId: "b8120000-0000-4000-8000-000000004c60", displayName: "Policy questions", agentId: null, agentLinkState: "unlinked", grants: 1 },
];
const appView = (a: App) => ({
  ...a,
  sourceId: SOURCE,
  appKind: "service_principal",
  publisher: "Example Publisher Ltd",
  publisherVerified: false,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  lifecycle: describe(a.agentLinkState),
});

interface Calls {
  all: Array<{ method: string; path: string; q: URLSearchParams; body: unknown }>;
}
async function mockApi(page: Page): Promise<Calls> {
  const calls: Calls = { all: [] };
  const apps = seedApps();
  const identifiers: Json[] = [{ id: uuid("74000000", 1), agentId: AGENT_CLAIMS, platform: "m365", externalId: "9c1e0000-0000-4000-8000-00000000a07f", createdByUserId: ME.userId, createdAt: NOW }];
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
    calls.all.push({ method: req.method(), path, q: url.searchParams, body });
    if (path === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (path === "/v1/me") return json(route, ME);
    if (path === "/v1/discovery/sources") return json(route, { sources, posture: { sourcesTotal: 2, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "2 of 2 discovery sources are enabled." } });
    if (path === "/v1/discovery/scanners") return json(route, { kinds: [{ kind: "entitlement_m365", label: "SaaS app grants", family: "saas", slice: "E18", evidenceKinds: ["saas_entitlement"], subjectKinds: ["app"], built: true, requiresCredential: true }] });
    if (path === "/v1/discovery/settings") return json(route, { credentialWarningAgeDays: 90, endpointRetentionDays: 90, version: 1 });
    if (path === "/v1/discovery/federation") return json(route, { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} });
    if (path === "/v1/discovery/runs") return json(route, { items: [], nextCursor: null, nextOffset: null, total: 0, totalIsEstimate: false, failed: 0 });
    if (path === "/v1/agents") return json(route, { agents });
    if (path === "/v1/discovery/entitlements/apps" && req.method() === "GET") {
      if (url.searchParams.get("sourceId") !== SOURCE) return json(route, { error: "invalid_request", detail: "sourceId" }, 400);
      return json(route, { items: apps.map(appView), nextAfter: null, machine: {} });
    }
    const link = /^\/v1\/discovery\/entitlements\/apps\/([^/]+)\/agent-link$/.exec(path);
    if (link) {
      const app = apps.find((x) => x.id === link[1]);
      if (!app) return json(route, { error: "not_found", detail: "no such entitlement app" }, 404);
      const event = req.method() === "PUT" ? "link" : "unlink";
      if (!MACHINE[event]!.from.includes(app.agentLinkState)) return json(route, { error: "illegal_transition", detail: "not allowed" }, 409);
      app.agentLinkState = MACHINE[event]!.to as App["agentLinkState"];
      if (event === "link") app.agentId = (body as { agentId: string }).agentId;
      return json(route, { appId: app.id, agentLinkState: app.agentLinkState, agentId: app.agentId, lifecycle: describe(app.agentLinkState) });
    }
    if (path === "/v1/discovery/agent-identifiers" && req.method() === "GET") return json(route, { items: identifiers, nextAfter: null });
    if (path === "/v1/discovery/agent-identifiers" && req.method() === "POST") {
      const b = body as { agentId: string; platform: string; externalId: string };
      const row = { id: uuid("74000000", identifiers.length + 1), ...b, createdByUserId: ME.userId, createdAt: NOW };
      identifiers.push(row);
      const matched = apps.filter((x) => x.externalId === b.externalId && x.agentLinkState === "none");
      for (const m of matched) {
        m.agentLinkState = "auto";
        m.agentId = b.agentId;
      }
      return json(route, { identifier: row, autoLinked: matched.map((m) => m.id), autoLinkedSources: matched.length ? [SOURCE] : [] }, 201);
    }
    const ident = /^\/v1\/discovery\/agent-identifiers\/([^/]+)$/.exec(path);
    if (ident && req.method() === "DELETE") {
      const i = identifiers.findIndex((x) => x.id === ident[1]);
      if (i < 0) return json(route, { error: "not_found", detail: "no such identifier" }, 404);
      identifiers.splice(i, 1);
      return route.fulfill({ status: 204, body: "" });
    }
    return json(route, {});
  });
  return calls;
}

const appsTable = (p: Page) => p.getByTestId("entitlement-apps");
const appRow = (p: Page, name: string) => appsTable(p).locator("tbody tr").filter({ hasText: name });

test.use({ viewport: { width: 1440, height: 1000 } });

test("an entitlement source's row on Discovery sources opens its apps, and the breadcrumb goes back", async ({ page }) => {
  await mockApi(page);
  await page.goto(OVERVIEW);
  const link = page.getByRole("link", { name: "View apps, Demo tenant app grants" });
  await expect(link).toHaveAttribute("href", `${OVERVIEW}/apps?source=${SOURCE}`);
  // only an entitlement source has one
  await expect(page.getByRole("link", { name: "View apps, Fleet agent" })).toHaveCount(0);
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "Apps in Demo tenant app grants" })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toContainText("Demo tenant app grants");
  await crumbs.getByRole("link", { name: "Discovery sources" }).click();
  await expect(page).toHaveURL(OVERVIEW);
});

test("the apps, their link state, and only the actions the link machine allows next", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${OVERVIEW}/apps?source=${SOURCE}`);
  await expect(appsTable(page).locator("tbody tr")).toHaveCount(4);
  await expect(appRow(page, "Claims triage assistant")).toContainText("Linked automatically");
  await expect(appRow(page, "Claims triage assistant")).toContainText("Claims triage bot");
  await expect(appRow(page, "Contract summariser")).toContainText("Linked by an admin");
  await expect(appRow(page, "Meeting notes helper")).toContainText("No agent yet");
  await expect(appRow(page, "Policy questions")).toContainText("Unlinked by an admin");
  // unlink is offered only from a linked state
  await expect(page.getByRole("button", { name: "Unlink, Meeting notes helper" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unlink, Policy questions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unlink, Claims triage assistant" })).toBeVisible();
  // the counts
  await expect(page.getByText("No agent yet", { exact: true }).first()).toBeVisible();
  // the filter
  await page.getByLabel("Link state").selectOption("none");
  await expect(appsTable(page).locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Link state").selectOption("");
  await page.getByLabel("Search apps").fill("77f0");
  await expect(appsTable(page).locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Search apps").fill("");
  await expectAxeClean(page, "SaaS app links");
});

test("an admin links a near match to an agent, then unlinks an automatic link", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(`${OVERVIEW}/apps?source=${SOURCE}`);
  await page.getByRole("button", { name: "Link to agent, Meeting notes helper" }).click();
  const dialog = page.getByRole("dialog", { name: "Link “Meeting notes helper” to an agent" });
  await expect(dialog).toContainText("partial or near match");
  const agentSelect = dialog.getByLabel("Agent");
  // a retired agent is never offered
  await expect(agentSelect.locator("option", { hasText: "Old retired helper" })).toHaveCount(0);
  // never pre-selected: Link app without a choice says so
  await dialog.getByRole("button", { name: "Link app" }).click();
  await expect(dialog).toContainText("Choose the agent to link it to.");
  await agentSelect.selectOption({ label: "Meeting minutes agent" });
  await dialog.getByRole("button", { name: "Link app" }).click();
  await expect(dialog).toHaveCount(0);
  const put = calls.all.find((c) => c.method === "PUT" && c.path.endsWith("/agent-link"));
  expect(put?.body).toEqual({ agentId: AGENT_MINUTES });
  await expect(appRow(page, "Meeting notes helper")).toContainText("Linked by an admin");
  await expect(appRow(page, "Meeting notes helper")).toContainText("Meeting minutes agent");

  await page.getByRole("button", { name: "Unlink, Claims triage assistant" }).click();
  const confirm = page.getByRole("dialog", { name: "Unlink Claims triage assistant?" });
  await expect(confirm).toContainText("not linked automatically again");
  await confirm.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect.poll(() => calls.all.some((c) => c.method === "DELETE" && c.path.endsWith(`${seedApps()[0]!.id}/agent-link`))).toBe(true);
  await expect(appRow(page, "Claims triage assistant")).toContainText("Unlinked by an admin");
  await expect(page.getByRole("button", { name: "Unlink, Claims triage assistant" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Link to agent, Claims triage assistant" })).toBeVisible();
});

test("an admin declares an agent app id, its exact match links automatically, and removing it keeps the links", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(`${OVERVIEW}/apps?source=${SOURCE}`);
  const card = page.getByTestId("agent-identifiers");
  await expect(card).toContainText("Removing an id keeps existing links");
  await expect(card.locator("tbody tr")).toHaveCount(1);
  await card.getByLabel("Agent").selectOption({ label: "Meeting minutes agent" });
  // the platform comes from the source
  await expect(card.getByLabel("Platform")).toHaveValue("m365");
  await card.getByLabel("App id", { exact: true }).fill("has a space");
  await card.getByRole("button", { name: "Declare id" }).click();
  await expect(card).toContainText("no spaces");
  await card.getByLabel("App id", { exact: true }).fill("77f00000-0000-4000-8000-000000001b3d");
  await card.getByRole("button", { name: "Declare id" }).click();
  await expect(card.locator("tbody tr")).toHaveCount(2);
  const post = calls.all.find((c) => c.method === "POST" && c.path === "/v1/discovery/agent-identifiers");
  expect(post?.body).toEqual({ agentId: AGENT_MINUTES, platform: "m365", externalId: "77f00000-0000-4000-8000-000000001b3d" });
  await expect(appRow(page, "Meeting notes helper")).toContainText("Linked automatically");

  await card.getByRole("button", { name: "Remove app id 77f00000-0000-4000-8000-000000001b3d" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove this app id?" });
  await expect(confirm).toContainText("keep their link until an admin unlinks them");
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card.locator("tbody tr")).toHaveCount(1);
  expect(calls.all.some((c) => c.method === "DELETE" && c.path === `/v1/discovery/agent-identifiers/${uuid("74000000", 2)}`)).toBe(true);
  // the link it made stays
  await expect(appRow(page, "Meeting notes helper")).toContainText("Linked automatically");
  await expectAxeClean(page, "SaaS app links after declaring");
});
