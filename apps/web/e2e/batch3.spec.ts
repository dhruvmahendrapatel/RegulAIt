/** X18: built SPA through the real gateway and an owned fixture. No route mocks.
 * Standard playwright.config.ts prepares a fresh database. Stdio success is
 * exercised when E2E_MCP_STDIO_COMMAND names an operator-allowed executable;
 * without host opt-in the same UI must explain mcp_stdio_unavailable.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { passTotp, reprovisionTotp } from "./totp-sign-in";
import { activate, escapeToTrigger, expectDialogTrap, typeAt } from "./keyboard-audit";

const state = JSON.parse(readFileSync(fileURLToPath(new URL(".e2e-state.json", import.meta.url)), "utf8")) as { baseUrl: string };
const BOOT = { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" };
const RUN = randomUUID();
const EMAIL = `batch3-${RUN}@example.test`;
const SERVER = `batch3-stdio-${RUN}`;
const CONNECTOR = `batch3-connector-${RUN}`;
const EXECUTABLE = process.env.E2E_MCP_STDIO_COMMAND;
const request = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${state.baseUrl}${path}`, { method, headers: BOOT, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json();
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return json;
};
let page: Page;
let adminId: string;
let ownerId: string;
let original: Record<string, unknown>;
let serverId: string | undefined;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  original = (await request("/v1/org/settings")).settings;
  adminId = (await request("/v1/users", "POST", { email: EMAIL, displayName: "Batch 3 UI administrator", isAdmin: true })).id;
  ownerId = (await request("/v1/users", "POST", { email: `owner-${RUN}@example.test`, displayName: "Batch 3 integration owner", isAdmin: false })).id;
  await reprovisionTotp(state.baseUrl, BOOT, EMAIL);
  const minted = await request(`/v1/users/${adminId}/set-initial-password`, "POST", { force: true });
  const context = await browser.newContext();
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/ui");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(minted.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await passTotp(page, EMAIL, page.getByLabel("Current (one-time) password"));
  await page.getByLabel("Current (one-time) password").fill(minted.password);
  await page.getByLabel("New password", { exact: true }).fill("Batch3-Local-Password!");
  await page.getByLabel("Confirm new password").fill("Batch3-Local-Password!");
  await page.getByRole("button", { name: "Set password & continue" }).click();
  await passTotp(page, EMAIL, page.getByRole("heading", { name: /Welcome back/ }).or(page.getByRole("region", { name: "AI policy acknowledgement" })));
  const literacy = await (await page.request.get(`${state.baseUrl}/v1/me/ai-literacy`)).json();
  for (const document of literacy.documents ?? []) if (document.state !== "current") {
    const response = await page.request.post(`${state.baseUrl}/v1/ai-policies/${document.documentId}/acknowledge`, {
      headers: { "x-regulait-csrf": "1" }, data: { version: document.version, digest: document.contentDigest },
    });
    expect(response.ok()).toBe(true);
  }
});
test.afterAll(async () => {
  try {
    if (original) await request("/v1/org/settings", "PUT", {
      semanticCacheTtlSeconds: original.semanticCacheTtlSeconds,
      conversationRetentionDays: original.conversationRetentionDays,
      mcpProtocolMethods: original.mcpProtocolMethods,
      mcpUpstreamTransports: original.mcpUpstreamTransports,
    });
  } finally {
    try {
      const users = (await request("/v1/users")).users;
      for (const id of [adminId, ownerId].filter(Boolean)) {
        if (users.find((user: { id: string; disabledAt: string | null }) => user.id === id)?.disabledAt === null)
          await request(`/v1/users/${id}/deactivate`, "POST", { reason: "Batch 3 UI fixture completed" });
      }
    } finally { await page?.context().close(); }
  }
});

test("retention inventory is honest and an audited extension persists only after confirmation", async () => {
  await page.goto("/ui/admin/retention");
  await expect(page.getByRole("heading", { name: "Memory & retention", exact: true })).toBeVisible();
  await expect(page.getByText("No retention sweep implemented", { exact: true })).toHaveCount(2);
  const metrics = (await request("/v1/org/posture")).metrics;
  expect(metrics).toEqual({ separateListener: "off", mainListener: false, tokenConfigured: false });
  await expect(page.getByText("Separate metrics listener: off.", { exact: true })).toBeVisible();
  await expect(page.getByText("Main listener: no metrics endpoint served.", { exact: true })).toBeVisible();
  await expect(page.getByText("Bearer token configured: no.", { exact: true })).toBeVisible();
  await typeAt(page, page.getByLabel("Conversation retention (days)"), "31");
  const trigger = page.getByRole("button", { name: "Save retention settings" });
  await activate(page, trigger);
  const dialog = page.getByRole("dialog", { name: "Extend memory retention?" });
  await expectDialogTrap(page, dialog);
  expect((await request("/v1/org/settings")).settings.conversationRetentionDays).toBe(original.conversationRetentionDays);
  await escapeToTrigger(page, dialog, trigger);
  await activate(page, trigger);
  await activate(page, page.getByRole("button", { name: "Save audited change" }));
  await expect.poll(async () => (await request("/v1/org/settings")).settings.conversationRetentionDays).toBe(31);
  const audit = await request("/v1/audit?ruleId=org-settings-updated&limit=20");
  expect(audit.entries).toEqual(expect.arrayContaining([expect.objectContaining({
    userId: adminId, detail: expect.objectContaining({
      transitions: expect.objectContaining({ conversationRetentionDays: { from: original.conversationRetentionDays, to: 31 } }),
      relaxed: expect.arrayContaining(["conversationRetentionDays"]),
    }),
  })]));
  const stores = (await request("/v1/inventory/memory-stores")).stores;
  expect(stores.find((row: { kind: string }) => row.kind === "conversations").retention.value).toBe(31);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
});

test("MCP methods require audited enablement and a separate real per-user protocol grant", async () => {
  await page.goto("/ui/admin/mcp-servers");
  await expect(page.getByText("A read-only server grant includes no protocol methods.", { exact: false })).toBeVisible();
  await page.getByRole("checkbox", { name: "resources/list · read", exact: true }).check();
  await page.getByRole("button", { name: "Save MCP coverage" }).click();
  const confirm = page.getByRole("dialog", { name: "Enable more MCP coverage?" });
  await expect(confirm).toBeVisible();
  expect((await request("/v1/org/settings")).settings.mcpProtocolMethods).not.toContain("resources/list");
  await confirm.getByRole("button", { name: "Save audited change" }).click();
  await expect.poll(async () => (await request("/v1/org/settings")).settings.mcpProtocolMethods).toContain("resources/list");
  const servers = (await request("/v1/servers")).servers;
  expect(servers.length).toBeGreaterThan(0);
  await page.getByLabel("Protocol user").selectOption(ownerId);
  await page.getByLabel("Protocol server").selectOption(servers[0].id);
  await page.getByLabel("Protocol grant", { exact: true }).selectOption("mcp:resources");
  const response = page.waitForResponse((r) => r.url().endsWith("/v1/grants/tools") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Add protocol grant" }).click();
  expect((await response).ok()).toBe(true);
  const entitlements = await request(`/v1/users/${ownerId}/servers/${servers[0].id}/entitlements`);
  expect(entitlements.entitlements).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "mcp:resources", source: "direct" })]));
});

test("stdio registration refuses a disabled transport and preserves separate argv strings", async () => {
  await page.goto("/ui/admin/mcp-servers");
  const form = page.getByRole("button", { name: "Register", exact: true }).locator("..");
  await form.getByLabel("Name", { exact: true }).fill(SERVER);
  await page.getByLabel("Upstream transport").selectOption("stdio");
  await page.getByLabel("Executable path", { exact: true }).fill(EXECUTABLE ?? "/opt/mcp/not-enabled");
  await page.getByRole("button", { name: "Add argument", exact: true }).click();
  await page.getByLabel("Argument 1", { exact: true }).fill("--root");
  await page.getByRole("button", { name: "Add argument", exact: true }).click();
  await page.getByLabel("Argument 2", { exact: true }).fill("/srv/data with spaces");
  let response = page.waitForResponse((r) => r.url().endsWith("/v1/servers") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  const refused = await response;
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error).toBe("mcp_transport_disabled");
  await expect(page.getByRole("alert").filter({ hasText: "disabled by your organisation" })).toBeVisible();
  expect(refused.request().postDataJSON().stdio.args).toEqual(["--root", "/srv/data with spaces"]);
  expect(refused.request().postDataJSON()).not.toHaveProperty("allowPrivateRanges");
  await page.getByRole("checkbox", { name: "stdio", exact: true }).check();
  await page.getByRole("button", { name: "Save MCP coverage" }).click();
  await page.getByRole("dialog", { name: "Enable more MCP coverage?" }).getByRole("button", { name: "Save audited change" }).click();
  await expect.poll(async () => (await request("/v1/org/settings")).settings.mcpUpstreamTransports).toContain("stdio");
  response = page.waitForResponse((r) => r.url().endsWith("/v1/servers") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  const registered = await response;
  if (!EXECUTABLE) {
    expect(registered.status()).toBe(422);
    expect((await registered.json()).error).toBe("mcp_stdio_unavailable");
    await expect(page.getByRole("alert").filter({ hasText: "deployment has not enabled local MCP executables" })).toBeVisible();
  } else {
    expect(registered.ok()).toBe(true);
    const row = await registered.json(); serverId = row.id;
    expect(row.stdio.args).toEqual(["--root", "/srv/data with spaces"]);
    expect(row.stdioCommandDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(page.getByRole("link", { name: `Show tools on ${SERVER}`, exact: true })).toContainText(row.stdioCommandDigest);
    await page.getByLabel("Server to assign").selectOption(serverId!);
    await page.getByLabel(`Owner for ${SERVER}`).selectOption(ownerId);
    await page.getByRole("button", { name: "Save owner", exact: true }).click();
    await expect.poll(async () => (await request("/v1/servers")).servers.find((item: { id: string }) => item.id === serverId)?.ownerUserId).toBe(ownerId);
    await page.getByLabel("Stdio server to update").selectOption(serverId!);
    await page.getByLabel("Argument 2", { exact: true }).last().fill("/srv/new root");
    await page.getByRole("button", { name: "Update command and reset admission" }).click();
    await expect.poll(async () => (await request("/v1/servers")).servers.find((item: { id: string }) => item.id === serverId)?.stdio.args).toEqual(["--root", "/srv/new root"]);
    expect((await request("/v1/servers")).servers.find((item: { id: string }) => item.id === serverId).admissionState).toBe("unscanned");
  }
});

test("Outlook recipient changes are audited, confirmed, persisted and explained on refusal", async () => {
  test.skip(!process.env.REGULAIT_PUBLIC_URL, "Outlook registration requires the deployment's pinned public URL");
  const connector = await request("/v1/connectors", "POST", { name: `batch3-outlook-${RUN}`, kind: "email", providerKind: "outlook" });
  await request(`/v1/connectors/${connector.id}/credential`, "POST", { token: JSON.stringify({ tenantId: "example.onmicrosoft.com", appId: randomUUID(), appPassword: "synthetic-registration-only", senderUpn: "sender@example.test" }) });
  const connection = await request("/v1/chatops/connections", "POST", { name: `mail-${RUN}`, provider: "outlook", connectorId: connector.id, defaultChannel: "registered@example.test", allowFencedDecide: false });
  try {
    await page.goto("/ui/admin/chatops");
    const recipients = page.getByLabel(`Additional recipients for mail-${RUN}`);
    await recipients.fill("cab@example.test\nsecurity@example.test");
    await page.getByRole("button", { name: "Save Outlook recipients" }).click();
    const dialog = page.getByRole("dialog", { name: "Allow more Outlook recipients?" });
    await expect(dialog).toBeVisible();
    expect((await request("/v1/chatops/connections")).connections.find((row: { id: string }) => row.id === connection.id).outlookRecipientAllowList).toEqual([]);
    await dialog.getByRole("button", { name: "Save audited recipients" }).click();
    await expect.poll(async () => (await request("/v1/chatops/connections")).connections.find((row: { id: string }) => row.id === connection.id).outlookRecipientAllowList).toEqual(["cab@example.test", "security@example.test"]);
    const audit = await request("/v1/audit?ruleId=chatops-outlook-recipients-changed&limit=20");
    expect(audit.entries).toEqual(expect.arrayContaining([expect.objectContaining({
      objectId: connection.id, userId: adminId, detail: expect.objectContaining({
        transitions: { outlookRecipientAllowList: { from: [], to: ["cab@example.test", "security@example.test"] } }, relaxed: true,
      }),
    })]));
    await recipients.fill("CAB <cab@example.test>");
    await page.getByRole("button", { name: "Save Outlook recipients" }).click();
    const response = page.waitForResponse((r) => r.url().endsWith(`/v1/chatops/connections/${connection.id}`) && r.request().method() === "PATCH");
    await page.getByRole("dialog", { name: "Allow more Outlook recipients?" }).getByRole("button", { name: "Save audited recipients" }).click();
    expect((await response).status()).toBe(400);
    await expect(page.getByRole("alert").filter({ hasText: "exact recipient mailbox addresses" }).first()).toBeVisible();
    expect((await request("/v1/chatops/connections")).connections.find((row: { id: string }) => row.id === connection.id).outlookRecipientAllowList).toEqual(["cab@example.test", "security@example.test"]);
  } finally { await request(`/v1/chatops/connections/${connection.id}`, "DELETE", {}); }
});

test("connector owner assignment, orphaned display and clearing use the live owner endpoint", async () => {
  const connector = await request("/v1/connectors", "POST", { name: CONNECTOR, kind: "batch3-test" });
  await page.goto("/ui/admin/connectors");
  await page.getByLabel("Connector to assign").selectOption(connector.id);
  await page.getByLabel(`Owner for ${CONNECTOR}`).selectOption(ownerId);
  await page.getByRole("button", { name: "Save owner", exact: true }).click();
  await expect.poll(async () => (await request("/v1/connectors")).connectors.find((row: { id: string }) => row.id === connector.id)?.ownerUserId).toBe(ownerId);
  await request(`/v1/users/${ownerId}/deactivate`, "POST", { reason: "Exercise orphaned integration ownership" });
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: CONNECTOR })).toContainText("orphaned");
  await page.getByLabel("Connector to assign").selectOption(connector.id);
  await page.getByLabel(`Owner for ${CONNECTOR}`).selectOption("");
  await page.getByRole("button", { name: "Save owner", exact: true }).click();
  await expect.poll(async () => (await request("/v1/connectors")).connectors.find((row: { id: string }) => row.id === connector.id)?.ownership).toBe("unowned");
  expect(pageErrors).toEqual([]);
});
