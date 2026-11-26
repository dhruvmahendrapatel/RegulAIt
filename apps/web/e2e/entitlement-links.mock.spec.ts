/**
 * Apps and agents for a SaaS entitlement source (ADR-0337 §6; owner decision 2026-11-17), from the browser's side.
 * Every /v1 and /auth call is answered by an in-test mock that follows apps/gateway/src/saas-entitlement-routes.ts:
 * the strict queries (sourceId, after, limit), the app rows with `agentLinkState` and `lifecycle.transitions`, the
 * link machine (link from any state; unlink only from auto or admin; auto-link only from none), PUT/DELETE agent-link,
 * the identifier list, POST (exact-id auto-link, `identifier_taken`) and DELETE (204, links kept).
 *
 * Covered: the row link from Discovery sources; link states in words; linking by hand, then unlinking with the "not
 * linked automatically again" copy; declaring an identifier that auto-links the exactly matching app; a refusal kept
 * in the dialog with Try again; no retired agent in the picker; removing an identifier keeps its link; Load more; a failed read with Retry; axe in
 * light and dark. Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";

const NOW = "2026-11-23T00:00:00.000Z";
const SRC = "11111111-1111-4111-8111-111111111111";
const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const RETIRED = "aaaaaaaa-0000-4000-8000-000000000003";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

type State = "none" | "auto" | "admin" | "unlinked";
interface App { id: string; externalId: string; displayName: string | null; agentId: string | null; state: State }

const lifecycle = (state: State) => ({
  machine: "saas_app_agent_link", state, terminal: false,
  transitions: [
    { event: "auto_link", to: "auto", allowed: state === "none", by: ["system"], summary: "matched a declared identifier", ...(state === "none" ? {} : { reason: "auto-link applies only to an app never linked" }) },
    { event: "link", to: "admin", allowed: true, by: ["admin"], summary: "an administrator linked it" },
    { event: "unlink", to: "unlinked", allowed: state === "auto" || state === "admin", by: ["admin"], summary: "an administrator unlinked it", ...(state === "auto" || state === "admin" ? {} : { reason: "nothing is linked" }) },
  ],
});

async function mockApi(page: Page, opts: { failApps?: boolean; manyApps?: boolean } = {}) {
  const st = {
    failApps: opts.failApps === true,
    apps: [
      { id: "b0000000-0000-4000-8000-000000000001", externalId: "sample-bot-client", displayName: "Sample bot", agentId: null, state: "none" },
      { id: "b0000000-0000-4000-8000-000000000002", externalId: "helper-app-7", displayName: "Helper app", agentId: null, state: "none" },
      ...(opts.manyApps ? Array.from({ length: 55 }, (_, i) => ({ id: `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, externalId: `extra-${i}`, displayName: `Extra app ${String(i).padStart(2, "0")}`, agentId: null, state: "none" as State })) : []),
    ] as App[],
    identifiers: [] as Array<{ id: string; agentId: string; platform: string; externalId: string; createdByUserId: string | null; createdAt: string }>,
    calls: [] as Array<{ method: string; path: string; body: unknown; query: URLSearchParams }>,
  };
  const view = (a: App) => ({ id: a.id, sourceId: SRC, externalId: a.externalId, appKind: "slack_app", displayName: a.displayName, publisher: "Sample Co", publisherVerified: true, agentId: a.agentId, agentLinkState: a.state, firstSeenAt: NOW, lastSeenAt: NOW, grants: 2, lifecycle: lifecycle(a.state) });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    st.calls.push({ method, path: p, body, query: url.searchParams });
    if (p === "/auth/me" || p === "/v1/me") {
      return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    }
    if (p === "/v1/discovery/sources") {
      return json(route, {
        sources: [{ id: SRC, name: "Sample workspace", kind: "entitlement_slack", target: { teamId: "T1" }, scope: { orgLevel: true, include: [] }, enabled: true, scheduleIntervalSeconds: 86400, version: 1, nextRunAt: null, lastRunAt: NOW, scannerBuilt: true, credential: null, lastRun: null }],
        posture: { sourcesTotal: 1, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "One source." },
      });
    }
    if (p === "/v1/discovery/scanners") return json(route, { kinds: [{ kind: "entitlement_slack", label: "Chat workspace", family: "saas", slice: "E18", evidenceKinds: ["saas_entitlement"], subjectKinds: ["app"], built: true, requiresCredential: true }] });
    if (p === "/v1/discovery/settings") return json(route, { credentialWarningAgeDays: 90, endpointRetentionDays: 90, families: { saas: true, identity: false, ml_platform: false }, version: 1 });
    if (p === "/v1/discovery/runs") return json(route, { items: [], nextCursor: null, nextOffset: null, total: 0, totalIsEstimate: false, failed: 0 });
    if (p === "/v1/discovery/federation") return json(route, { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} });
    if (p === "/v1/agents") return json(route, { agents: [{ id: A1, name: "Ticket triage agent", provider: "internal", lifecycleStatus: "active" }, { id: A2, name: "Report writer agent", provider: "internal", lifecycleStatus: "active" }, { id: RETIRED, name: "Old agent", provider: "internal", lifecycleStatus: "retired" }] });
    if (p === "/v1/discovery/entitlements/apps" && method === "GET") {
      for (const k of url.searchParams.keys()) if (!["sourceId", "after", "limit"].includes(k)) return json(route, { error: "invalid_request" }, 400);
      if (st.failApps) return json(route, { error: "internal_error" }, 500);
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const rows = after ? st.apps.slice(st.apps.findIndex((a) => a.id === after) + 1) : st.apps;
      const pageRows = rows.slice(0, limit);
      return json(route, { items: pageRows.map(view), nextAfter: rows.length > limit ? pageRows.at(-1)!.id : null, machine: {} });
    }
    const link = p.match(/^\/v1\/discovery\/entitlements\/apps\/([^/]+)\/agent-link$/);
    if (link) {
      const app = st.apps.find((a) => a.id === link[1]);
      if (!app) return json(route, { error: "not_found" }, 404);
      if (method === "PUT") {
        const b = body as { agentId: string };
        if (b.agentId === RETIRED) return json(route, { error: "agent_retired", detail: "that agent is retired" }, 409);
        app.agentId = b.agentId; app.state = "admin";
        return json(route, { appId: app.id, agentLinkState: "admin", agentId: app.agentId, lifecycle: lifecycle("admin") });
      }
      if (method === "DELETE") {
        if (app.state !== "auto" && app.state !== "admin") return json(route, { error: "illegal_transition" }, 409);
        app.agentId = null; app.state = "unlinked";
        return json(route, { appId: app.id, agentLinkState: "unlinked", agentId: null, lifecycle: lifecycle("unlinked") });
      }
    }
    if (p === "/v1/discovery/agent-identifiers" && method === "GET") return json(route, { items: st.identifiers, nextAfter: null });
    if (p === "/v1/discovery/agent-identifiers" && method === "POST") {
      const b = body as { agentId: string; platform: string; externalId: string };
      if (st.identifiers.some((i) => i.platform === b.platform && i.externalId === b.externalId)) return json(route, { error: "identifier_taken", detail: "that app id is already declared on this platform" }, 409);
      const identifier = { id: `d0000000-0000-4000-8000-${String(st.identifiers.length + 1).padStart(12, "0")}`, agentId: b.agentId, platform: b.platform, externalId: b.externalId, createdByUserId: "ada", createdAt: NOW };
      st.identifiers.push(identifier);
      const matched = st.apps.filter((a) => a.state === "none" && a.externalId === b.externalId);
      for (const a of matched) { a.agentId = b.agentId; a.state = "auto"; }
      return json(route, { identifier, autoLinked: matched.map((a) => a.id), autoLinkedSources: matched.length ? [SRC] : [] }, 201);
    }
    const del = p.match(/^\/v1\/discovery\/agent-identifiers\/([^/]+)$/);
    if (del && method === "DELETE") {
      st.identifiers = st.identifiers.filter((i) => i.id !== del[1]);
      return route.fulfill({ status: 204 });
    }
    return json(route, {});
  });
  return st;
}

const card = (page: Page, title: string) => page.locator("[data-rg-card]").filter({ has: page.getByText(title, { exact: true }) });
const PAGE_URL = `/ui/admin/shadow-ai/discovery-sources/apps/${SRC}`;

test.describe("Apps and agents", () => {
  test("link by hand, then unlink: the app is not linked automatically again", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto("/ui/admin/shadow-ai/discovery-sources");
    await page.getByRole("row").filter({ hasText: "Sample workspace" }).getByRole("link", { name: "Apps and agents" }).click();
    await expect(page.getByRole("heading", { name: "Apps and agents: Sample workspace" })).toBeVisible();
    const apps = card(page, "Apps");
    const bot = apps.getByRole("row").filter({ hasText: "Sample bot" });
    await expect(bot).toContainText("Not linked");
    await expect(bot.getByRole("button", { name: "Unlink Sample bot" })).toHaveCount(0);
    await expectAxeClean(page, "apps and agents");

    await bot.getByRole("button", { name: "Link an agent to Sample bot" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("option", { name: "Old agent" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Link", exact: true })).toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel("Agent").selectOption({ label: "Ticket triage agent" });
    await dialog.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "The app is linked to the agent." })).toBeVisible();
    await expect(bot).toContainText("Linked by an administrator");
    await expect(bot).toContainText("Ticket triage agent");
    expect(st.calls.find((c) => c.method === "PUT")!.body).toEqual({ agentId: A1 });

    await bot.getByRole("button", { name: "Unlink Sample bot" }).click();
    await expect(page.getByRole("dialog")).toContainText("not linked automatically again until an administrator links it");
    await page.getByRole("dialog").getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(bot).toContainText("Unlinked");
    await expect(bot.getByRole("button", { name: "Unlink Sample bot" })).toHaveCount(0);
  });

  test("declaring an identifier links the exactly matching app; a refusal stays in the dialog; removing keeps the link", async ({ page }) => {
    const st = await mockApi(page);
    await page.goto(PAGE_URL);
    const ids = card(page, "Agent identifiers");
    await expect(ids).toContainText("on Chat workspace");
    await expect(ids.getByText("No identifiers on this platform")).toBeVisible();

    await ids.getByRole("button", { name: "Declare an identifier" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Agent").selectOption({ label: "Report writer agent" });
    await dialog.getByLabel("Vendor app id").fill("helper app");
    await expect(dialog.getByText(/no spaces/)).toBeVisible();
    await dialog.getByLabel("Vendor app id").fill("helper-app-7");
    await dialog.getByRole("button", { name: "Declare", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 app with exactly that id was linked automatically." })).toBeVisible();
    await expect(card(page, "Apps").getByRole("row").filter({ hasText: "Helper app" })).toContainText("Linked automatically");
    expect(st.calls.find((c) => c.method === "POST")!.body).toEqual({ agentId: A2, platform: "slack", externalId: "helper-app-7" });
    await expectAxeClean(page, "apps and agents: declared");

    // the same id again is refused, and the dialog keeps the form with Try again
    await ids.getByRole("button", { name: "Declare an identifier" }).click();
    await dialog.getByLabel("Agent").selectOption({ label: "Ticket triage agent" });
    await dialog.getByLabel("Vendor app id").fill("helper-app-7");
    await dialog.getByRole("button", { name: "Declare", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Nothing changed");
    await expect(dialog.getByRole("button", { name: "Try again: Declare" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await ids.getByRole("button", { name: "Remove the identifier helper-app-7" }).click();
    await expect(page.getByRole("dialog")).toContainText("stay linked until an administrator unlinks them");
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(ids.getByText("No identifiers on this platform")).toBeVisible();
    await expect(card(page, "Apps").getByRole("row").filter({ hasText: "Helper app" })).toContainText("Linked automatically");
  });

  test("the agent picker never offers a retired agent", async ({ page }) => {
    await mockApi(page);
    await page.goto(PAGE_URL);
    const bot = card(page, "Apps").getByRole("row").filter({ hasText: "Sample bot" });
    await bot.getByRole("button", { name: "Link an agent to Sample bot" }).click();
    await expect(page.getByRole("dialog").getByRole("option", { name: "Old agent" })).toHaveCount(0);
  });

  test("pages the apps with Load more, and a failed read is an error with Retry", async ({ page }) => {
    const st = await mockApi(page, { manyApps: true, failApps: true });
    await page.goto(PAGE_URL);
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No apps yet")).toHaveCount(0);
    st.failApps = false;
    await page.getByRole("button", { name: "Retry" }).first().click();
    const apps = card(page, "Apps");
    await expect(apps.getByRole("row").filter({ hasText: "Extra app 47" })).toBeVisible();
    await expect(apps.getByRole("row").filter({ hasText: "Extra app 54" })).toHaveCount(0);
    await apps.getByRole("button", { name: "Load more apps" }).click();
    await expect(apps.getByRole("row").filter({ hasText: "Extra app 54" })).toBeVisible();
    const gets = st.calls.filter((c) => c.method === "GET" && c.path === "/v1/discovery/entitlements/apps");
    expect(gets.at(-1)!.query.get("after")).toBeTruthy();
    await expect(apps.getByRole("button", { name: "Load more apps" })).toHaveCount(0);
  });
});
