/**
 * Upstream token exchange — the card on a selected MCP server (Integrations > MCP servers) and on a connector
 * (Integrations > Connectors), from the browser's side. Every /v1 and /auth call is answered by an in-test mock that
 * follows apps/gateway/src/upstream-token-exchange.ts: `{ tokenExchange }` reads that never carry the secret, the
 * 201/200 PUT, the 404 DELETE when nothing is set, the 409 `upstream_token_exchange_refused` codes (sent before the
 * step-up), the 400 `invalid_request` with its fixed sentence, and the `settings_relax` step-up on every write.
 *
 * Covered: loading then data, not configured, inline https check (nothing sent), the scope map with the server's
 * tool names suggested, save with the step-up (the secret is sent once and cleared, the switch is never pre-ticked),
 * each refusal code inline, clear behind a confirmation with the step-up, an error with Retry, a connector with
 * read/write suggested, no card on a stdio server, and axe in light and dark. Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectAxeClean } from "./builder-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const SERVER = { id: "11111111-1111-4111-8111-111111111111", name: "Docs MCP", url: "https://mcp.example.test/", transport: "streamable_http", admissionState: "clean", pricePerCallUsd: null, allowPrivateRanges: null };
const STDIO = { ...SERVER, id: "22222222-2222-4222-8222-222222222222", name: "Local stdio", url: null, transport: "stdio" };
const CONNECTOR = { id: "33333333-3333-4333-8333-333333333333", name: "Acme tickets", kind: "ticketing", providerKind: "http", baseUrl: "https://tickets.example.test", pricePerCallUsd: null };
const SECRET = "s3cret-for-the-exchange-wxyz";
const FIXED_400 =
  "expected { enabled, tokenEndpoint (https), subjectTokenAudience, audience, resource? (https), clientId, clientSecret?, " +
  "maxTokenTtlSeconds? (30-900), scopes: { <action>: [<scope>, ...] } } with RFC 6749 scope tokens";
const REFUSAL_DETAIL: Record<string, string> = {
  stdio: "a stdio server has no HTTP request to carry a token",
  profile_conflict: "this server's oidc_bearer assertion already rides in Authorization: return it to the regulait_header profile first",
  bearer_credential_conflict: "this server already sends a static Bearer credential: clear it first",
};

const empty = { configured: false, enabled: false, tokenEndpoint: null, subjectTokenAudience: null, audience: null, resource: null, clientId: null, clientSecretLast4: null, maxTokenTtlSeconds: null, scopes: {}, setBy: null, secretSetAt: null };
const stored = {
  configured: true,
  enabled: true,
  tokenEndpoint: "https://auth.example.test/token",
  subjectTokenAudience: "https://auth.example.test",
  audience: "acme-docs",
  resource: null,
  clientId: "regulait-gw",
  clientSecretLast4: "abcd",
  maxTokenTtlSeconds: 120,
  scopes: { search_docs: ["docs.read"] },
  setBy: "ada",
  secretSetAt: "2026-11-10T09:00:00.000Z",
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Opts {
  start?: typeof empty;
  /** answer the read with a 500 this many times first */
  failReads?: number;
  /** hold the first read until this resolves */
  hold?: Promise<void>;
  /** answer every PUT with this 409 refusal code */
  refuse?: string;
}

async function mockApi(page: Page, opts: Opts = {}) {
  const state = { view: { ...(opts.start ?? empty) } as Record<string, unknown>, puts: [] as Array<Record<string, unknown>>, deletes: 0, reads: 0 };
  let failReads = opts.failReads ?? 0;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me" || p === "/v1/me") {
      return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    }
    if (p === "/v1/users") return json(route, { users: [{ id: "ada", email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null }] });
    if (p === "/v1/servers") return json(route, { servers: [SERVER, STDIO] });
    if (p === "/v1/connectors") return json(route, { connectors: [CONNECTOR] });
    if (p === `/v1/servers/${SERVER.id}/tools`) {
      return json(route, { tools: ["search_docs", "write_doc"].map((name) => ({ name, kind: "read", serverId: SERVER.id, description: null, pricePerCallUsd: null })) });
    }
    if (p === "/v1/org/settings") return json(route, { settings: { mcpProtocolMethods: [], mcpUpstreamTransports: ["streamable_http"] } });
    const m = p.match(/^\/v1\/(servers|connectors)\/([^/]+)\/token-exchange$/);
    if (m) {
      if (method === "GET") {
        state.reads++;
        if (state.reads === 1 && opts.hold) await opts.hold;
        if (failReads > 0) {
          failReads--;
          return json(route, { error: "internal_error" }, 500);
        }
        return json(route, { tokenExchange: state.view });
      }
      if (method === "PUT") {
        const body = req.postDataJSON() as Record<string, unknown>;
        state.puts.push(body);
        if (opts.refuse) return json(route, { error: "upstream_token_exchange_refused", code: opts.refuse, detail: REFUSAL_DETAIL[opts.refuse] }, 409);
        if (body.audience === "send-a-bad-body") return json(route, { error: "invalid_request", detail: FIXED_400 }, 400);
        const created = !state.view.configured;
        const secret = body.clientSecret as string | undefined;
        state.view = {
          configured: true,
          enabled: body.enabled,
          tokenEndpoint: body.tokenEndpoint,
          subjectTokenAudience: body.subjectTokenAudience,
          audience: body.audience,
          resource: body.resource ?? null,
          clientId: body.clientId,
          clientSecretLast4: secret ? secret.slice(-4) : state.view.clientSecretLast4,
          maxTokenTtlSeconds: body.maxTokenTtlSeconds ?? 300,
          scopes: body.scopes,
          setBy: "ada",
          secretSetAt: secret ? "2026-11-14T10:00:00.000Z" : state.view.secretSetAt,
        };
        return json(route, { tokenExchange: state.view }, created ? 201 : 200);
      }
      if (method === "DELETE") {
        if (!state.view.configured) return json(route, { error: "no_token_exchange", detail: "nothing is configured" }, 404);
        state.deletes++;
        state.view = { ...empty };
        return json(route, { tokenExchange: state.view });
      }
    }
    return json(route, {});
  });
  return state;
}

async function openServer(page: Page, name = SERVER.name) {
  await page.goto("/ui/admin/mcp-servers");
  await page.getByRole("link", { name: `Show tools on ${name}` }).click();
}

const form = (page: Page, name = SERVER.name) => page.getByRole("form", { name: `Token exchange for ${name}` });

/**
 * The MCP servers page as a whole carries older 13 px checkboxes in other cards (a WCAG 2.2 target-size finding that
 * is not this card's), so on that page axe runs over this card's form only, with the same tags, in light and dark.
 * The connectors page is checked whole with `expectAxeClean`.
 */
async function expectFormAxeClean(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const r = await new AxeBuilder({ page }).include(`form[aria-label="Token exchange for ${name}"]`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe (${theme})`).toEqual([]);
  }
}

test("MCP server: loading, then set up with the step-up; the secret is sent once and never shown", async ({ page }) => {
  let release!: () => void;
  const state = await mockApi(page, { hold: new Promise<void>((r) => (release = r)) });
  const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/servers/${SERVER.id}/token-exchange`, kind: "settings_relax" });
  await openServer(page);
  await expect(page.getByText("Token exchange", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").first()).toBeVisible();
  release();

  const f = form(page);
  await expect(page.getByText("Not configured (default)")).toBeVisible();
  await expect(page.getByText("A tool with no scopes here is refused while exchange is on.")).toBeVisible();
  await expect(page.getByText(/must be on Egress Allow Hosts, over https/)).toBeVisible();
  // the server's tool names are offered for the action
  await expect(page.locator(`datalist#tx-${SERVER.id} option`)).toHaveCount(2);
  await expect(f.getByRole("checkbox", { name: /Turn token exchange on/ })).not.toBeChecked();

  // an http endpoint is refused next to the field and nothing is sent
  await f.getByLabel("Token endpoint (https)").fill("http://auth.example.test/token");
  await f.getByRole("button", { name: "Save token exchange" }).click();
  await expect(f.getByText("Enter a full https address, with no credentials or # part.")).toBeVisible();
  await expect(f.getByText("Enter the secret: 16 to 512 characters, no spaces.")).toBeVisible();
  expect(state.puts).toHaveLength(0);

  await f.getByLabel("Token endpoint (https)").fill("https://auth.example.test/token");
  await f.getByLabel("Subject token audience").fill("https://auth.example.test");
  await f.getByLabel("Audience (pinned)").fill("acme-docs");
  await f.getByLabel("Client id").fill("regulait-gw");
  await f.getByLabel("Client secret").fill(SECRET);
  await f.getByLabel("Action 1", { exact: true }).fill("search_docs");
  await f.getByLabel("Scopes for action 1, separated by spaces").fill("docs.read");
  await f.getByRole("button", { name: "Add an action" }).click();
  await f.getByLabel("Action 2", { exact: true }).fill("write_doc");
  await f.getByLabel("Scopes for action 2, separated by spaces").fill("docs.read docs.write");
  await f.getByRole("checkbox", { name: /Turn token exchange on/ }).check();
  await f.getByRole("button", { name: "Save token exchange" }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();

  expect(state.puts.at(-1)).toEqual({
    enabled: true,
    tokenEndpoint: "https://auth.example.test/token",
    subjectTokenAudience: "https://auth.example.test",
    audience: "acme-docs",
    clientId: "regulait-gw",
    clientSecret: SECRET,
    maxTokenTtlSeconds: 300,
    scopes: { search_docs: ["docs.read"], write_doc: ["docs.read", "docs.write"] },
  });
  await expect(page.getByText("Exchange on", { exact: true })).toBeVisible();
  await expect(page.getByText(/Client secret ending wxyz, set by Ada Admin on/)).toBeVisible();
  await expect(f.getByLabel("Rotate secret (optional)")).toHaveValue("");
  await expect(page.getByText(SECRET)).toHaveCount(0);
  // the switch is never pre-ticked, even while exchange is on
  await expect(f.getByRole("checkbox", { name: /it is on now: tick to keep it on/ })).not.toBeChecked();
  await expectFormAxeClean(page, SERVER.name);
});

test("MCP server: each 409 refusal and the 400 fixed sentence are shown inline", async ({ page }) => {
  for (const [code, words] of [
    ["profile_conflict", "already sends its identity assertion in Authorization"],
    ["bearer_credential_conflict", "Clear it under Upstream credential first"],
    ["stdio", "A stdio server has no HTTP request to carry a token."],
  ] as const) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const state = await mockApi(page, { start: stored, refuse: code });
    await openServer(page);
    const f = form(page);
    await expect(f.getByLabel("Client id")).toHaveValue("regulait-gw");
    await f.getByRole("button", { name: "Save token exchange" }).click();
    await expect(f.getByRole("alert").filter({ hasText: words })).toBeVisible();
    // the stored secret is kept: no secret typed, none sent
    expect(state.puts.at(-1)).not.toHaveProperty("clientSecret");
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockApi(page, { start: stored });
  await requireStepUpOn(page, { method: "PUT", path: `/v1/servers/${SERVER.id}/token-exchange`, kind: "settings_relax" });
  await openServer(page);
  const f = form(page);
  await f.getByLabel("Audience (pinned)").fill("send-a-bad-body");
  await f.getByRole("button", { name: "Save token exchange" }).click();
  await confirmStepUp(page);
  await expect(f.getByRole("alert").filter({ hasText: "with RFC 6749 scope tokens" })).toBeVisible();
});

test("MCP server: clear asks first, then the step-up, then shows not configured", async ({ page }) => {
  const state = await mockApi(page, { start: stored });
  const su = await requireStepUpOn(page, { method: "DELETE", path: `/v1/servers/${SERVER.id}/token-exchange`, kind: "settings_relax" });
  await openServer(page);
  await expect(page.getByText(/Client secret ending abcd, set by Ada Admin on/)).toBeVisible();
  await form(page).getByRole("button", { name: "Clear token exchange" }).click();
  const dialog = page.getByRole("dialog", { name: `Clear token exchange for ${SERVER.name}?` });
  await expect(dialog).toContainText("stored client secret are destroyed");
  await dialog.getByRole("button", { name: "Clear token exchange" }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(state.deletes).toBe(1);
  await expect(page.getByText("Not configured (default)")).toBeVisible();
});

test("a failed read is an error with Retry, and a stdio server has no card", async ({ page }) => {
  await mockApi(page, { failReads: 2 }); // the client retries a transient failure once
  await openServer(page);
  await expect(page.getByRole("alert").first()).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Not configured (default)")).toBeVisible();

  await page.getByRole("link", { name: `Show tools on ${SERVER.name}` }).click();
  await page.getByRole("link", { name: `Show tools on ${STDIO.name}` }).click();
  await expect(page.getByText("Token exchange", { exact: true })).toHaveCount(0);
});

test("connector: pick one, map read and write, save with the step-up", async ({ page }) => {
  const state = await mockApi(page);
  const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/connectors/${CONNECTOR.id}/token-exchange`, kind: "settings_relax" });
  await page.goto("/ui/admin/connectors");
  await page.getByLabel("Connector for token exchange").selectOption(CONNECTOR.id);
  const f = form(page, CONNECTOR.name);
  await expect(page.getByText("An operation with no scopes here is refused while exchange is on.")).toBeVisible();
  await expect(page.locator(`datalist#tx-${CONNECTOR.id} option`)).toHaveCount(2);
  await f.getByLabel("Token endpoint (https)").fill("https://auth.example.test/token");
  await f.getByLabel("Subject token audience").fill("https://auth.example.test");
  await f.getByLabel("Audience (pinned)").fill("acme-tickets");
  await f.getByLabel("Resource, https (optional)").fill("https://tickets.example.test");
  await f.getByLabel("Client id").fill("regulait-gw");
  await f.getByLabel("Client secret").fill(SECRET);
  await f.getByLabel("Action 1", { exact: true }).fill("read");
  await f.getByLabel("Scopes for action 1, separated by spaces").fill("tickets.read");
  await f.getByRole("button", { name: "Save token exchange" }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(state.puts.at(-1)).toMatchObject({ enabled: false, resource: "https://tickets.example.test", scopes: { read: ["tickets.read"] } });
  await expect(page.getByText("Exchange off", { exact: true })).toBeVisible();
  await expectAxeClean(page, "token exchange on a connector");
});
