/**
 * #609 follow-up (owner 2026-10-30, #453): "Sync tools now" in a server's own tools card (Integrations > MCP
 * servers). It asks for the step-up, posts `POST /v1/servers/:serverId/tools/sync` once with the grant, says what
 * it synced and re-reads the tool list. The release-age cooldown's own code shows its guidance, with a link to
 * Admission review. The register form's next steps no longer say the first tools/list call syncs tools.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const SERVER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Docs MCP",
  url: "https://mcp.example.test/",
  transport: "streamable_http",
  admissionState: "clean",
  pricePerCallUsd: null,
  allowPrivateRanges: null,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mock(page: Page, sync: { status: number; body: unknown }) {
  const state = { tools: [] as Array<{ name: string; kind: string; description: string | null }>, syncs: 0, toolReads: 0 };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!path.startsWith("/v1") && !path.startsWith("/auth")) return route.continue();
    if (path === "/auth/me" || path === "/v1/me") {
      return json(route, { userId: "mcp-admin", isAdmin: true, via: "session", user: { id: "mcp-admin", email: "admin@example.test", displayName: "Mcp Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    }
    if (path === "/v1/servers") return json(route, { servers: [SERVER] });
    if (path === `/v1/servers/${SERVER.id}/tools` && req.method() === "GET") {
      state.toolReads++;
      return json(route, { tools: state.tools.map((t) => ({ ...t, serverId: SERVER.id, pricePerCallUsd: null })) });
    }
    if (path === `/v1/servers/${SERVER.id}/tools/sync` && req.method() === "POST") {
      state.syncs++;
      if (sync.status === 200) state.tools = [{ name: "search_docs", kind: "read", description: "Search the docs" }];
      return json(route, sync.body, sync.status);
    }
    if (path === "/v1/users") return json(route, { users: [] });
    if (path === "/v1/org/settings") return json(route, { settings: { mcpProtocolMethods: [], mcpUpstreamTransports: ["streamable_http"] } });
    return json(route, {});
  });
  return state;
}

async function openTools(page: Page) {
  await page.goto("/ui/admin/mcp-servers");
  await page.getByRole("link", { name: `Show tools on ${SERVER.name}` }).click();
  await expect(page.getByText(`Tools on ${SERVER.name}`)).toBeVisible();
}

test("Sync tools now: the step-up, one sync with the grant, a summary, and the tool list re-read", async ({ page }) => {
  const state = await mock(page, { status: 200, body: { serverId: SERVER.id, toolCount: 1, added: ["search_docs"], admissionState: "clean" } });
  const su = await requireStepUpOn(page, { method: "POST", path: `/v1/servers/${SERVER.id}/tools/sync`, kind: "settings_relax" });
  await openTools(page);
  await expect(page.getByText("No tools synced from this server yet")).toBeVisible();
  const readsBefore = state.toolReads;

  const button = page.getByRole("button", { name: `Sync tools now on ${SERVER.name}` });
  await button.click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(state.syncs).toBe(1);
  await expect(page.getByText("Synced 1 tool from Docs MCP (1 new)")).toBeVisible();
  await expect.poll(() => state.toolReads).toBeGreaterThan(readsBefore);
  await expect(page.getByText("search_docs", { exact: true })).toBeVisible();
  await expect(button).toBeFocused();

  const a11y = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(a11y.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
});

test("the release-age cooldown is its own refusal, with the way to allow the server sooner", async ({ page }) => {
  const state = await mock(page, {
    status: 403,
    body: {
      error: "mcp_release_age_cooldown",
      detail: "MCP server 'Docs MCP' is in release-age quarantine",
      readyAt: "2026-11-06T00:00:00.000Z",
      remedy: "An admin can allow this server before the cooldown ends",
    },
  });
  await openTools(page);
  await page.getByRole("button", { name: `Sync tools now on ${SERVER.name}` }).click();
  await expect(page.getByText("waits out the release-age cooldown").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Admission review (administrators)" })).toHaveAttribute("href", "/ui/admin/admission");
  expect(state.syncs).toBe(1);
  expect(state.tools).toEqual([]);
});

test("an unreachable server is said in words, and nothing is listed", async ({ page }) => {
  await mock(page, { status: 502, body: { error: "mcp_upstream_unreachable", detail: "x" } });
  await openTools(page);
  await page.getByRole("button", { name: `Sync tools now on ${SERVER.name}` }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The server could not be reached" })).toBeVisible();
  await expect(page.getByText("No tools synced from this server yet")).toBeVisible();
});

test("the register form's next steps point at Sync tools now, not at a first tools/list call", async ({ page }) => {
  await mock(page, { status: 200, body: {} });
  await page.goto("/ui/admin/mcp-servers");
  const steps = page.getByTestId("mcp-next-steps");
  await expect(steps).toContainText("Sync tools now");
  await expect(steps).not.toContainText("tools/list");
});
