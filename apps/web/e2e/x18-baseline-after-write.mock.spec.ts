/**
 * PR #181 review (round 6): after a successful write a form's baseline must be
 * the server's state. While the refetch is pending — or after it failed — the
 * form stays locked, so a second submit cannot write the same value again or
 * put back a value another admin has changed meanwhile.
 */
import { expect, test, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ME = { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
const PERSON = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", displayName: "Olive Owner", isAdmin: false, disabledAt: null, createdAt: "2026-10-01T00:00:00Z", totpEnabled: true, hasPassword: true, mustChangePassword: false };

test("owner: saved, refetch failing → Save stays disabled, a second submit sends no PUT, Retry reloads", async ({ page }) => {
  const server = { id: "s1", name: "Fixture server", url: "https://mcp.example.test/mcp", transport: "streamable_http", enabled: true, stdio: null, stdioCommandDigest: null, admissionState: "admitted", ownerUserId: null, ownership: "unowned" };
  let serversFail = false;
  const puts: string[] = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (method === "PUT" && p === "/v1/servers/s1/owner") {
      puts.push(p);
      serversFail = true;
      return json(route, { ...server, ownerUserId: PERSON.id, ownership: "owned" });
    }
    if (p === "/v1/servers") return serversFail ? json(route, { error: "internal" }, 500) : json(route, { servers: [server] });
    if (p === "/v1/users") return json(route, { users: [PERSON] });
    if (p === "/v1/org/settings") return json(route, { settings: { mcpProtocolMethods: [], mcpUpstreamTransports: ["streamable_http"] } });
    return json(route, {});
  });
  await page.goto("/ui/admin/mcp-servers");
  await page.getByLabel("Server to assign").selectOption("s1");
  await page.getByLabel("Owner for Fixture server").selectOption(PERSON.id);
  const save = page.getByRole("button", { name: "Save owner", exact: true });
  await save.click();
  await expect.poll(() => puts.length).toBe(1);
  // the refetch of the servers list fails (after its one retry)
  await expect(page.getByRole("alert").filter({ hasText: "could not be reloaded" })).toBeVisible({ timeout: 15_000 });
  await expect(save).toBeDisabled();
  await save.evaluate((element) => element.closest("form")!.requestSubmit());
  await page.waitForTimeout(500);
  expect(puts).toEqual(["/v1/servers/s1/owner"]);
  // Retry: the server now reports the saved owner, which becomes the baseline
  server.ownerUserId = PERSON.id;
  server.ownership = "owned";
  serversFail = false;
  await page.getByRole("button", { name: "Retry loading current values" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be reloaded" })).toHaveCount(0);
  await expect(page.getByLabel("Owner for Fixture server")).toHaveValue(PERSON.id);
  await expect(save).toBeDisabled(); // unchanged from the new baseline
  expect(puts).toHaveLength(1);
});

test("Outlook recipients: saved, connections refetch failing → the form stays locked and sends no second PATCH", async ({ page }) => {
  const outlook = { id: "o1", name: "acme-outlook", provider: "outlook", connectorId: "k2", defaultChannel: "registered@example.test", allowFencedDecide: false, notifyAlertMinSeverity: null, enabled: true, createdAt: "2026-10-01T00:00:00Z", outboundSupported: true, outlookRecipientAllowList: ["a@example.test", "b@example.test"] };
  let fail = false;
  const patches: string[] = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (method === "PATCH") { patches.push(p); fail = true; return json(route, {}); }
    if (p === "/v1/chatops/connections") return fail ? json(route, { error: "internal" }, 500) : json(route, { connections: [outlook], posture: "" });
    if (p === "/v1/chatops/identity-links") return json(route, { links: [], posture: "" });
    return json(route, p === "/v1/connectors" ? { connectors: [] } : {});
  });
  await page.goto("/ui/admin/chatops");
  await page.getByLabel("Additional recipients for acme-outlook").fill("a@example.test");
  const save = page.getByRole("button", { name: "Save Outlook recipients" });
  await save.click();
  await expect.poll(() => patches.length).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: "could not be reloaded" })).toBeVisible({ timeout: 15_000 });
  await expect(save).toBeDisabled();
  await save.evaluate((element) => element.closest("form")!.requestSubmit());
  await page.waitForTimeout(500);
  expect(patches).toHaveLength(1);
});

test("protocol grants: after a grant is added the choices are cleared, so a second submit sends no second POST", async ({ page }) => {
  const posts: unknown[] = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (method === "POST" && p === "/v1/grants/tools") { posts.push(route.request().postDataJSON()); return json(route, { id: "g1" }, 201); }
    if (p === "/v1/users") return json(route, { users: [PERSON] });
    if (p === "/v1/servers") return json(route, { servers: [{ id: "s1", name: "Fixture server", url: "https://mcp.example.test/mcp", transport: "streamable_http", enabled: true, stdio: null, ownerUserId: null }] });
    if (p === "/v1/org/settings") return json(route, { settings: { mcpProtocolMethods: [], mcpUpstreamTransports: ["streamable_http"] } });
    return json(route, {});
  });
  await page.goto("/ui/admin/mcp-servers");
  await page.getByLabel("Protocol user").selectOption(PERSON.id);
  await page.getByLabel("Protocol server").selectOption("s1");
  const add = page.getByRole("button", { name: "Add protocol grant" });
  await add.click();
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.getByLabel("Protocol user")).toHaveValue("");
  await add.evaluate((element) => element.closest("form")!.requestSubmit());
  await page.waitForTimeout(500);
  expect(posts).toHaveLength(1);
});
