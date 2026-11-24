/**
 * Codex review slice 11 (INT-002..005): the connector credential form and the per-user entitlement cards.
 *  - INT-002: the credential drafts belong to one connector; switching connector starts a clean form.
 *  - INT-003: a failed credential read is an error with Retry and offers no save, never "no credential"; keyless
 *    adapters say no credential is needed instead of warning that invokes will fail.
 *  - INT-004: the base URL field starts at the stored override, a token-only rotation sends it back, and clearing it is
 *    an explicit choice.
 *  - INT-005: entitlement rows belong to the subject they were read for; changing the subject drops them, so Remove
 *    cannot reach the previous subject's grant.
 * Synthetic fixtures only.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const users = [
  { id: "u", email: "admin@example.test", displayName: "Ada Admin", isAdmin: true, totpEnabled: true, hasPassword: true, disabledAt: null },
  { id: "d", email: "dana@example.test", displayName: "Dana Developer", isAdmin: false, totpEnabled: true, hasPassword: true, disabledAt: null },
];

const connectors = [
  { id: "gh", name: "Code host", kind: "scm", providerKind: "github", baseUrl: "https://api.code.example.test", enabled: true },
  { id: "sl", name: "Chat", kind: "chat", providerKind: "slack", baseUrl: null, enabled: true },
  { id: "mk", name: "Sandbox", kind: "test", providerKind: "mock", baseUrl: null, enabled: true },
  { id: "gv", name: "Ledger", kind: "erp", providerKind: null, baseUrl: null, enabled: true },
  { id: "br", name: "Broken", kind: "crm", providerKind: "github", baseUrl: null, enabled: true },
  // ADR-0255 catalogue pieces (#1229 review R2 [1][2])
  { id: "pj", name: "Tracker", kind: "pm", providerKind: "piece_jira_cloud", baseUrl: null, enabled: true },
  { id: "ps", name: "Team chat", kind: "chat", providerKind: "piece_slack", baseUrl: null, enabled: true },
];

const storedGh = { id: "cred-gh", connectorId: "gh", baseUrl: "https://eu.code.example.test", createdAt: "2026-11-01T00:00:00Z" };

type Write = { method: string; path: string; body: unknown };

async function fixture(page: Page, opts: { brokenReads?: { count: number }; failSave?: boolean; holdDelete?: Promise<void> } = {}) {
  const writes: Write[] = [];
  const me = { userId: "u", isAdmin: true, user: users[0] };
  let brokenLeft = opts.brokenReads?.count ?? Infinity;
  const gets: Record<string, unknown> = {
    "/v1/users": { users },
    "/v1/connectors": { connectors },
    "/v1/connectors/gh/credential": { credential: storedGh },
    "/v1/connectors/sl/credential": { credential: null },
    "/v1/connectors/mk/credential": { credential: null },
    "/v1/connectors/gv/credential": { credential: null },
    "/v1/connectors/pj/credential": { credential: null },
    // a piece saved before the field was hidden: its stale override is dropped on the next save
    "/v1/connectors/ps/credential": { credential: { id: "cred-ps", connectorId: "ps", baseUrl: "https://proxy.example.test", createdAt: "2026-11-01T00:00:00Z" } },
    "/v1/servers": {
      servers: [
        { id: "s1", name: "Records", baseUrl: "https://records.example.test", enabled: true },
        { id: "s2", name: "Tickets", baseUrl: "https://tickets.example.test", enabled: true },
      ],
    },
    "/v1/users/u/connectors": {
      connectors: [{ connectorId: "gh", grantId: "g-ada", name: "Code host", kind: "scm", mode: "read", source: "direct" }],
    },
    "/v1/users/d/connectors": { connectors: [] },
    "/v1/users/u/servers/s1/entitlements": {
      entitlements: [{ grantId: "t-ada", kind: "tool", toolName: "records.read", source: "direct", revoked: false }],
    },
    "/v1/users/d/servers/s1/entitlements": { entitlements: [] },
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!path.startsWith("/v1") && !path.startsWith("/auth"))) return route.continue();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (path === "/v1/me") return json(me);
    if (path === "/v1/me/ai-literacy") return json({ required: false, current: true, documents: [], gateMode: "enforce", noticeDays: 14 });
    if (req.method() === "GET") {
      if (path === "/v1/connectors/br/credential") {
        if (brokenLeft > 0) {
          brokenLeft -= 1;
          return json({ error: "internal", detail: "credential store unavailable" }, 500);
        }
        return json({ credential: null });
      }
      return json(gets[path] ?? {});
    }
    writes.push({ method: req.method(), path, body: req.postDataJSON?.() ?? null });
    if (opts.failSave && req.method() === "POST") return json({ error: "invalid_connector_credential", detail: "the credential does not match this adapter" }, 400);
    if (opts.holdDelete && req.method() === "DELETE") await opts.holdDelete;
    return json({ ok: true, id: "synthetic" }, req.method() === "POST" ? 201 : 200);
  });
  return { writes };
}

const card = (page: Page, title: string): Locator => page.locator("section[data-rg-card]").filter({ hasText: title });
const credCard = (page: Page) => card(page, "Platform credential — write-only, per connector");

test.describe("INT-002..005: connector credentials and per-subject entitlements", () => {
  test("INT-002: switching connector starts a clean credential form", async ({ page }) => {
    await fixture(page);
    await page.goto("/ui/admin/connectors");
    const c = credCard(page);
    await c.getByLabel("Connector").selectOption({ label: "Chat · chat" });
    await c.getByLabel("Token / API key").fill("tok-for-chat");
    await c.getByLabel("Base URL (optional)").fill("https://chat-override.example.test");

    await c.getByLabel("Connector").selectOption({ label: "Broken · crm" });
    await c.getByLabel("Connector").selectOption({ label: "Sandbox · test" });
    await expect(c.getByLabel("Token / API key")).toHaveValue("");
    await expect(c.getByLabel("Base URL (optional)")).toHaveValue("");

    // and back again: the first connector's drafts did not survive either
    await c.getByLabel("Connector").selectOption({ label: "Chat · chat" });
    await expect(c.getByLabel("Token / API key")).toHaveValue("");
    await expect(c.getByLabel("Base URL (optional)")).toHaveValue("");
  });

  test("INT-003: a failed credential read is an error with Retry and no save form", async ({ page }) => {
    const f = await fixture(page, { brokenReads: { count: 2 } }) // the first read and its one automatic retry;
    await page.goto("/ui/admin/connectors");
    const c = credCard(page);
    await c.getByLabel("Connector").selectOption({ label: "Broken · crm" });
    await expect(c.getByText("Couldn't read this connector's credential")).toBeVisible();
    await expect(c.getByText(/no credential/)).toHaveCount(0);
    await expect(c.getByRole("button", { name: /Save credential|Rotate credential/ })).toHaveCount(0);
    await c.getByRole("button", { name: "Retry" }).click();
    await expect(c.getByText("no credential — governed invokes that need one will fail")).toBeVisible();
    await expect(c.getByRole("button", { name: "Save credential" })).toBeVisible();
    expect(f.writes).toEqual([]);
  });

  test("INT-003: keyless adapters say no credential is needed", async ({ page }) => {
    await fixture(page);
    await page.goto("/ui/admin/connectors");
    const c = credCard(page);
    await c.getByLabel("Connector").selectOption({ label: "Sandbox · test" });
    await expect(c.getByText("no credential needed: the mock adapter is keyless")).toBeVisible();
    await expect(c.getByText(/will fail/)).toHaveCount(0);
    await c.getByLabel("Connector").selectOption({ label: "Ledger · erp" });
    await expect(c.getByText(/no credential needed: governance-only/)).toBeVisible();
    await expect(c.getByText(/will fail/)).toHaveCount(0);
  });

  test("INT-004: a token-only rotation keeps the stored base URL; clearing it is explicit", async ({ page }) => {
    const f = await fixture(page);
    await page.goto("/ui/admin/connectors");
    const c = credCard(page);
    await c.getByLabel("Connector").selectOption({ label: "Code host · scm" });
    await expect(c.getByText("credential configured")).toBeVisible();
    await expect(c.getByLabel("Base URL (optional)")).toHaveValue(storedGh.baseUrl);

    await c.getByLabel("Token / API key").fill("tok-rotated-1");
    await c.getByRole("button", { name: "Rotate credential" }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    expect(f.writes[0]).toEqual({
      method: "POST",
      path: "/v1/connectors/gh/credential",
      body: { token: "tok-rotated-1", baseUrl: storedGh.baseUrl },
    });

    // emptying the field is not a silent clear
    await c.getByLabel("Token / API key").fill("tok-rotated-2");
    await c.getByLabel("Base URL (optional)").fill("");
    await c.getByRole("button", { name: "Rotate credential" }).click();
    await expect(c.getByText(/The base URL override is empty/)).toBeVisible();
    expect(f.writes).toHaveLength(1);

    // the explicit choice omits baseUrl, which the gateway stores as null
    await c.getByRole("checkbox", { name: /Clear the override/ }).check();
    await expect(c.getByLabel("Base URL (optional)")).toBeDisabled();
    await c.getByRole("button", { name: "Rotate credential" }).click();
    await expect.poll(() => f.writes.length).toBe(2);
    expect(f.writes[1]).toEqual({ method: "POST", path: "/v1/connectors/gh/credential", body: { token: "tok-rotated-2" } });
  });

  test("INT-005: connector entitlement rows are dropped when the user changes", async ({ page }) => {
    const f = await fixture(page);
    await page.goto("/ui/admin/connectors");
    const c = card(page, "Per-user entitlement");
    await c.getByLabel("User", { exact: true }).selectOption({ label: "Ada Admin · admin@example.test" });
    await c.getByRole("button", { name: "View" }).click();
    await expect(c.getByRole("button", { name: "Remove Code host from this user" })).toBeVisible();

    await c.getByLabel("User", { exact: true }).selectOption({ label: "Dana Developer · dana@example.test" });
    await expect(c.getByRole("button", { name: "Remove Code host from this user" })).toHaveCount(0);
    await expect(c.getByRole("table")).toHaveCount(0);
    await c.getByRole("button", { name: "View" }).click();
    await expect(c.getByText("No entitled connectors")).toBeVisible();
    expect(f.writes).toEqual([]);
  });

  test("INT-005: MCP entitlement rows are dropped when the user or server changes", async ({ page }) => {
    const f = await fixture(page);
    await page.goto("/ui/admin/mcp-servers");
    const c = card(page, "Per-user entitlement");
    await c.getByLabel("User", { exact: true }).selectOption({ label: "Ada Admin · admin@example.test" });
    await c.getByLabel("Server", { exact: true }).selectOption({ label: "Records" });
    await c.getByRole("button", { name: "View" }).click();
    await expect(c.getByRole("button", { name: "Remove records.read from this user" })).toBeVisible();

    await c.getByLabel("User", { exact: true }).selectOption({ label: "Dana Developer · dana@example.test" });
    await expect(c.getByRole("button", { name: "Remove records.read from this user" })).toHaveCount(0);

    await c.getByLabel("User", { exact: true }).selectOption({ label: "Ada Admin · admin@example.test" });
    await c.getByRole("button", { name: "View" }).click();
    await expect(c.getByRole("button", { name: "Remove records.read from this user" })).toBeVisible();
    await c.getByLabel("Server", { exact: true }).selectOption({ label: "Tickets" });
    await expect(c.getByRole("button", { name: "Remove records.read from this user" })).toHaveCount(0);
    expect(f.writes).toEqual([]);
  });

  test("R2 [1]: a catalogue piece offers no base URL and sends none, even over a stale stored override", async ({ page }) => {
    const f = await fixture(page);
    await page.goto("/ui/admin/connectors");
    const c = credCard(page);
    await c.getByLabel("Connector").selectOption({ label: "Team chat · chat" });
    await expect(c.getByText("credential configured")).toBeVisible();
    await expect(c.getByLabel("Base URL (optional)")).toHaveCount(0);
    await expect(c.getByText(/Clear the override/)).toHaveCount(0);
    await expect(c.getByText("A catalogue connector reaches only its vendor's API, so it takes no base URL override.")).toBeVisible();
    await c.getByLabel("Token / API key").fill("xoxb-synthetic");
    await c.getByRole("button", { name: "Rotate credential" }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    expect(f.writes[0]).toEqual({ method: "POST", path: "/v1/connectors/ps/credential", body: { token: "xoxb-synthetic" } });
  });

  test("R2 [2]: a piece whose credential is a document gets the JSON field, its template and its keys", async ({ page }) => {
    const f = await fixture(page);
    await page.goto("/ui/admin/connectors");
    const c = credCard(page);
    await c.getByLabel("Connector").selectOption({ label: "Tracker · pm" });
    await expect(c.getByLabel("Token / API key")).toHaveCount(0);
    const json = c.getByLabel("Credential (JSON — never shown again)");
    await expect(json).toHaveAttribute("placeholder", /"siteUrl"[\s\S]*"email"[\s\S]*"apiToken"/);
    await expect(json).toHaveAttribute("spellcheck", "false");
    await expect(c.getByText(/The piece_jira_cloud credential is a JSON object, not a bare token: \{siteUrl, email, apiToken\}/)).toBeVisible();
    await expect(c.getByLabel("Base URL (optional)")).toHaveCount(0);
    const doc = JSON.stringify({ siteUrl: "https://acme.atlassian.net", email: "svc@example.test", apiToken: "t" });
    await json.fill(doc);
    await c.getByRole("button", { name: "Save credential" }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    expect(f.writes[0]!.body).toEqual({ token: doc });
  });

  test("R2 [3]: a refused save keeps the drafts, shows the error and no success", async ({ page }) => {
    const f = await fixture(page, { failSave: true });
    await page.goto("/ui/admin/connectors");
    const c = credCard(page);
    await c.getByLabel("Connector").selectOption({ label: "Chat · chat" });
    await c.getByLabel("Token / API key").fill("tok-bad");
    await c.getByLabel("Base URL (optional)").fill("https://chat-override.example.test");
    await c.getByRole("button", { name: "Save credential" }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    await expect(c.getByRole("alert")).toContainText(/invalid_connector_credential|does not match this adapter/);
    await expect(page.getByText("Credential saved (encrypted at rest, never returned)")).toHaveCount(0);
    await expect(c.getByLabel("Token / API key")).toHaveValue("tok-bad");
    await expect(c.getByLabel("Base URL (optional)")).toHaveValue("https://chat-override.example.test");
  });

  test("R2 [4]: remove is disabled while a remove is in flight", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const f = await fixture(page, { holdDelete: held });
    await page.goto("/ui/admin/connectors");
    const c = credCard(page);
    await c.getByLabel("Connector").selectOption({ label: "Code host · scm" });
    await c.getByRole("button", { name: "remove" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /remove|confirm/i }).last().click();
    await expect.poll(() => f.writes.filter((w) => w.method === "DELETE").length).toBe(1);
    await expect(c.getByRole("button", { name: "remove" })).toBeDisabled();
    release();
    await expect(c.getByRole("button", { name: "remove" })).toBeEnabled();
    expect(f.writes.filter((w) => w.method === "DELETE")).toHaveLength(1);
  });
});
