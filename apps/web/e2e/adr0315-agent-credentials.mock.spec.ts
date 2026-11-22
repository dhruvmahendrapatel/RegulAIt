/**
 * ADR-0315 (G7) — the agent credential audience registry, against a mocked gateway:
 *
 *  - the list shows each audience's URI, algorithm, binding, lifetime and scope map with resource names;
 *  - registering is checked in the browser first, then confirmed (naming what it loosens), then goes through the
 *    step-up prompt (settings_relax) and is resent once, unchanged;
 *  - disabling is confirmed and sent as a plain POST (no step-up); a disabled audience cannot be disabled again;
 *  - axe (WCAG 2.x A/AA) in light and dark on the page and the confirmation.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const SRV = "11111111-1111-4111-8111-111111111111";
const CON = "22222222-2222-4222-8222-222222222222";
const A1 = "44444444-4444-4444-8444-444444444444";
const A2 = "55555555-5555-4555-8555-555555555555";
const THEMES = ["light", "dark"] as const;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

interface State {
  posts: unknown[];
  disables: string[];
}

async function mock(page: Page): Promise<State> {
  const state: State = { posts: [], disables: [] };
  const rows: Record<string, unknown>[] = [
    {
      id: A1,
      audience: "https://api.example.test/payments",
      name: "payments-api",
      algorithm: "ES256",
      binding: "dpop",
      maxTtlSeconds: 300,
      state: "enabled",
      enabled: true,
      disabledAt: null,
      createdAt: "2026-11-19T00:00:00Z",
      scopes: [{ type: "mcp_tool", serverId: SRV, toolName: "create_refund", connectorId: null, agentId: null, kind: "write", scope: "payments:refund" }],
    },
    {
      id: A2,
      audience: "https://old.example.test/",
      name: "old-gateway",
      algorithm: "EdDSA",
      binding: "bearer",
      maxTtlSeconds: 600,
      state: "disabled",
      enabled: false,
      disabledAt: "2026-11-19T12:00:00Z",
      createdAt: "2026-11-01T00:00:00Z",
      scopes: [{ type: "connector", serverId: null, toolName: null, connectorId: CON, agentId: null, kind: "read", scope: "crm:read" }],
    },
  ];
  const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p === "/v1/servers") return json(route, { servers: [{ id: SRV, name: "Payments MCP", url: "https://mcp.example.test" }] });
    if (p === "/v1/connectors") return json(route, { connectors: [{ id: CON, name: "CRM", kind: "http" }] });
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/agent-credentials/audiences" && m === "GET") return json(route, { audiences: rows });
    if (p === "/v1/agent-credentials/audiences" && m === "POST") {
      state.posts.push(req.postDataJSON());
      return json(route, { id: "66666666-6666-4666-8666-666666666666" }, 201);
    }
    const dis = /^\/v1\/agent-credentials\/audiences\/([^/]+)\/disable$/.exec(p);
    if (dis && m === "POST") {
      state.disables.push(dis[1]!);
      const row = rows.find((r) => r.id === dis[1])!;
      Object.assign(row, { enabled: false, state: "disabled", disabledAt: "2026-11-20T00:00:00Z" });
      return json(route, { id: dis[1], enabled: false });
    }
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return state;
}

test.describe("ADR-0315: agent credential audiences", () => {
  test("lists audiences with their scope maps, and disables one without step-up", async ({ page }) => {
    const state = await mock(page);
    await page.goto("/ui/admin/agent-credentials");
    await expect(page.getByRole("heading", { name: "Agent credentials" })).toBeVisible();
    await expect(page.getByText("MCP tool Payments MCP · create_refund (write)")).toBeVisible();
    await expect(page.getByText("Connector CRM (read)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Disable old-gateway" })).toBeDisabled();
    await expectAxeClean(page, "agent credentials");
    await page.getByRole("button", { name: "Disable payments-api" }).click();
    await page.getByRole("dialog", { name: "Disable payments-api?" }).getByRole("button", { name: "Disable" }).click();
    await expect.poll(() => state.disables).toEqual([A1]);
    await expect(page.getByText("payments-api is disabled. No new credential is issued to it.").first()).toBeVisible();
  });

  test("checks a registration, names what it loosens, and sends it through the step-up prompt", async ({ page }) => {
    const state = await mock(page);
    const su = await requireStepUpOn(page, { method: "POST", path: "/v1/agent-credentials/audiences", kind: "settings_relax" });
    await page.goto("/ui/admin/agent-credentials");
    const form = page.getByRole("form", { name: "Register an audience" });
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("refunds");
    await form.getByRole("textbox", { name: "Audience URI" }).fill("http://refunds.example.test/");
    await form.getByRole("button", { name: "Register audience" }).click();
    await expect(form.getByText("The audience must be an https URL.")).toBeVisible();
    await expect(form.getByText(/Choose the mcp tool/)).toBeVisible();
    expect(state.posts).toEqual([]);

    await form.getByRole("textbox", { name: "Audience URI" }).fill("https://refunds.example.test/");
    await form.getByRole("combobox", { name: "Binding" }).selectOption("bearer");
    const row = form.getByRole("group", { name: "Scope 1" });
    await row.getByRole("combobox", { name: "MCP server" }).selectOption(SRV);
    await row.getByRole("textbox", { name: "Tool name" }).fill("create_refund");
    await row.getByRole("combobox", { name: "Access" }).selectOption("write");
    await row.getByRole("textbox", { name: "Scope at the receiver" }).fill("refunds:write");
    await form.getByRole("button", { name: "Register audience" }).click();

    const confirm = page.getByRole("dialog", { name: "Register refunds?" });
    await expect(confirm.getByText(/accepts a bearer credential/)).toBeVisible();
    await expectAxeClean(page, "register confirmation");
    await confirm.getByRole("button", { name: "Register and confirm it's me" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    const sent = {
      name: "refunds",
      audience: "https://refunds.example.test/",
      algorithm: "ES256",
      binding: "bearer",
      maxTtlSeconds: 300,
      scopes: [{ type: "mcp_tool", serverId: SRV, toolName: "create_refund", kind: "write", scope: "refunds:write" }],
    };
    expect(su.attempts[1]!.body).toEqual(sent);
    expect(su.attempts[0]!.body).toEqual(sent);
  });
});
