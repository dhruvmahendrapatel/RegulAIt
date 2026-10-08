/**
 * PR #181 review (round 5): a confirmation dialog can stay open for as long as
 * a person takes to read it. Confirming must re-read the stored values and
 * re-apply THIS admin's change to them, so a change another admin made while
 * the dialog was open survives; a value that already equals what is stored is
 * not written at all (no no-effect write, no audit row).
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ME = { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };

/** every /v1 GET answers from `state` (mutable: a concurrent admin edits it); writes are recorded, not applied */
async function mockApi(page: Page, state: Record<string, unknown>) {
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (method === "PUT" || method === "PATCH") {
      writes.push({ method, path: p, body: route.request().postDataJSON() });
      return json(route, {});
    }
    return json(route, state[p] ?? {});
  });
  return writes;
}

test("MCP coverage: a method another admin enabled while the dialog was open survives the confirmed save", async ({ page }) => {
  const settings = { mcpProtocolMethods: ["resources/list"], mcpUpstreamTransports: ["streamable_http"] };
  const state: Record<string, unknown> = { "/v1/org/settings": { settings }, "/v1/servers": { servers: [] }, "/v1/users": { users: [] } };
  const writes = await mockApi(page, state);
  await page.goto("/ui/admin/mcp-servers");
  await page.getByRole("checkbox", { name: "prompts/list · read", exact: true }).check();
  await page.getByRole("button", { name: "Save MCP coverage" }).click();
  const dialog = page.getByRole("dialog", { name: "Enable more MCP coverage?" });
  await expect(dialog).toBeVisible();
  // another admin enables completion/complete while this dialog is open
  state["/v1/org/settings"] = { settings: { ...settings, mcpProtocolMethods: ["resources/list", "completion/complete"] } };
  await dialog.getByRole("button", { name: "Save audited change" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.path).toBe("/v1/org/settings");
  expect([...(writes[0]!.body.mcpProtocolMethods as string[])].sort()).toEqual(["completion/complete", "prompts/list", "resources/list"]);
  expect(writes[0]!.body).not.toHaveProperty("mcpUpstreamTransports");
});

test("Outlook recipients: a recipient another admin added while the dialog was open survives the confirmed save", async ({ page }) => {
  const outlook = { id: "o1", name: "acme-outlook", provider: "outlook", connectorId: "k2", defaultChannel: "registered@example.test", allowFencedDecide: false, notifyAlertMinSeverity: null, enabled: true, createdAt: "2026-10-01T00:00:00Z", outboundSupported: true, outlookRecipientAllowList: ["a@example.test"] };
  const state: Record<string, unknown> = {
    "/v1/chatops/connections": { connections: [outlook], posture: "" },
    "/v1/chatops/identity-links": { links: [], posture: "" },
    "/v1/connectors": { connectors: [] },
  };
  const writes = await mockApi(page, state);
  await page.goto("/ui/admin/chatops");
  await page.getByLabel("Additional recipients for acme-outlook").fill("a@example.test\nb@example.test");
  await page.getByRole("button", { name: "Save Outlook recipients" }).click();
  const dialog = page.getByRole("dialog", { name: "Allow more Outlook recipients?" });
  await expect(dialog).toBeVisible();
  state["/v1/chatops/connections"] = { connections: [{ ...outlook, outlookRecipientAllowList: ["a@example.test", "c@example.test"] }], posture: "" };
  await dialog.getByRole("button", { name: "Save audited recipients" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.path).toBe("/v1/chatops/connections/o1");
  expect([...(writes[0]!.body.outlookRecipientAllowList as string[])].sort()).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
});

test("retention: a value already equal to what is stored now is not written, at submit or at confirmation", async ({ page }) => {
  // the form's own query keeps answering 30; only the NEXT read (the pre-save
  // or confirm-time re-read) sees the other admin's value
  const base = { settings: { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 30 } };
  let nextRead: unknown = null;
  const writes: string[] = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (method === "PUT") { writes.push(`PUT ${p}`); return json(route, {}); }
    if (p === "/v1/org/settings") {
      const body = nextRead ?? base;
      nextRead = null;
      return json(route, body);
    }
    return json(route, p === "/v1/inventory/memory-stores" ? { stores: [] } : {});
  });
  await page.goto("/ui/admin/retention");
  const save = page.getByRole("button", { name: "Save retention settings" });
  await expect(page.getByLabel("Conversation retention (days)")).toHaveValue("30");
  // at submit: another admin already set 20 → entering 20 writes nothing
  await page.getByLabel("Conversation retention (days)").fill("20");
  nextRead = { settings: { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 20 } };
  await save.click();
  await expect(page.getByRole("alert").filter({ hasText: "already match your change; nothing was saved" })).toBeVisible();
  expect(writes).toEqual([]);
  // at confirmation: 31 relaxes the stored 30; another admin sets 31 while the dialog is open
  await page.getByLabel("Conversation retention (days)").fill("31");
  await save.click();
  const dialog = page.getByRole("dialog", { name: "Extend memory retention?" });
  await expect(dialog).toBeVisible();
  nextRead = { settings: { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 31 } };
  await dialog.getByRole("button", { name: "Save audited change" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already match your change; nothing was saved" })).toBeVisible();
  await expect(save).toBeEnabled();
  expect(writes).toEqual([]);
});

test("MCP coverage: a confirmed change that now enables something the dialog did not show asks again", async ({ page }) => {
  const settings = { mcpProtocolMethods: ["resources/list"], mcpUpstreamTransports: ["streamable_http"] };
  const state: Record<string, unknown> = { "/v1/org/settings": { settings }, "/v1/servers": { servers: [] }, "/v1/users": { users: [] } };
  const writes = await mockApi(page, state);
  await page.goto("/ui/admin/mcp-servers");
  await page.getByRole("checkbox", { name: "prompts/list · read", exact: true }).check();
  await page.getByRole("checkbox", { name: "completion/complete · read", exact: true }).check();
  // another admin had already enabled completion/complete: the dialog shows only prompts/list as new
  state["/v1/org/settings"] = { settings: { ...settings, mcpProtocolMethods: ["resources/list", "completion/complete"] } };
  await page.getByRole("button", { name: "Save MCP coverage" }).click();
  const dialog = page.getByRole("dialog", { name: "Enable more MCP coverage?" });
  await expect(dialog).toBeVisible();
  // ...and disables it again while the dialog is open: confirming would now enable it too
  state["/v1/org/settings"] = { settings };
  await dialog.getByRole("button", { name: "Save audited change" }).click();
  await expect(dialog).toContainText("changed while this was open");
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "Save audited change" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect([...(writes[0]!.body.mcpProtocolMethods as string[])].sort()).toEqual(["completion/complete", "prompts/list", "resources/list"]);
});
