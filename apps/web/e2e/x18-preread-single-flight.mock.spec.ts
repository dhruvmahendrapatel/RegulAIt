/**
 * PR #181 review (round 3): the retention, MCP coverage and Outlook recipient
 * forms re-read the stored values before deciding whether a save relaxes
 * anything. A second submit while that re-read is in flight must not start a
 * second save: exactly one PUT/PATCH, so exactly one audit row.
 *
 * Both submits are fired in the same tick (form.requestSubmit() twice), so the
 * guard is proven to hold before React re-renders the disabled button.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ME = { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };

/** answers every /v1 call; the SECOND and later reads of `slowPath` take 800ms */
async function mockApi(page: Page, answers: Record<string, unknown>, slowPath: string) {
  const writes: string[] = [];
  const reads = new Map<string, number>();
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (method === "PUT" || method === "PATCH") {
      writes.push(`${method} ${p}`);
      return json(route, {});
    }
    if (method === "GET" && p === slowPath) {
      const n = (reads.get(p) ?? 0) + 1;
      reads.set(p, n);
      if (n > 1) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return json(route, answers[p] ?? {});
  });
  return { writes };
}

async function submitTwice(page: Page, button: string) {
  await page.getByRole("button", { name: button }).evaluate((element) => {
    const form = element.closest("form")!;
    form.requestSubmit();
    form.requestSubmit();
  });
}

test("retention: a second submit during the pre-save re-read sends no second PUT", async ({ page }) => {
  const gw = await mockApi(page, {
    "/v1/org/settings": { settings: { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 30 } },
    "/v1/inventory/memory-stores": { stores: [] },
  }, "/v1/org/settings");
  await page.goto("/ui/admin/retention");
  await page.getByLabel("Conversation retention (days)").fill("20");
  await submitTwice(page, "Save retention settings");
  await expect.poll(() => gw.writes.length).toBeGreaterThan(0);
  await page.waitForTimeout(2000);
  expect(gw.writes).toEqual(["PUT /v1/org/settings"]);
});

test("MCP coverage: a second submit during the pre-save re-read sends no second PUT", async ({ page }) => {
  const gw = await mockApi(page, {
    "/v1/org/settings": { settings: { mcpProtocolMethods: ["resources/list"], mcpUpstreamTransports: ["streamable_http"] } },
    "/v1/servers": { servers: [] },
    "/v1/users": { users: [] },
  }, "/v1/org/settings");
  await page.goto("/ui/admin/mcp-servers");
  await page.getByRole("checkbox", { name: "resources/list · read", exact: true }).uncheck();
  await submitTwice(page, "Save MCP coverage");
  await expect.poll(() => gw.writes.length).toBeGreaterThan(0);
  await page.waitForTimeout(2000);
  expect(gw.writes).toEqual(["PUT /v1/org/settings"]);
});

test("Outlook recipients: a second submit during the pre-save re-read sends no second PATCH", async ({ page }) => {
  const outlook = { id: "o1", name: "acme-outlook", provider: "outlook", connectorId: "k2", defaultChannel: "registered@example.test", allowFencedDecide: false, notifyAlertMinSeverity: null, enabled: true, createdAt: "2026-10-01T00:00:00Z", outboundSupported: true, outlookRecipientAllowList: ["a@example.test", "b@example.test"] };
  const gw = await mockApi(page, {
    "/v1/chatops/connections": { connections: [outlook], posture: "" },
    "/v1/chatops/identity-links": { links: [], posture: "" },
    "/v1/connectors": { connectors: [] },
  }, "/v1/chatops/connections");
  await page.goto("/ui/admin/chatops");
  await page.getByLabel("Additional recipients for acme-outlook").fill("a@example.test");
  await submitTwice(page, "Save Outlook recipients");
  await expect.poll(() => gw.writes.length).toBeGreaterThan(0);
  await page.waitForTimeout(2000);
  expect(gw.writes).toEqual(["PATCH /v1/chatops/connections/o1"]);
});

test("retention: a cancelled or confirmed relaxation releases the form; a failed re-read still asks first", async ({ page }) => {
  let failReread = false;
  const writes: string[] = [];
  let reads = 0;
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (method === "PUT") { writes.push(`PUT ${p}`); return json(route, {}); }
    if (p === "/v1/org/settings") {
      reads += 1;
      if (failReread && reads > 1) return json(route, { error: "internal" }, 500);
      return json(route, { settings: { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 30 } });
    }
    return json(route, p === "/v1/inventory/memory-stores" ? { stores: [] } : {});
  });
  await page.goto("/ui/admin/retention");
  const save = page.getByRole("button", { name: "Save retention settings" });
  const dialog = page.getByRole("dialog", { name: "Extend memory retention?" });
  await page.getByLabel("Conversation retention (days)").fill("31");
  await save.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(save).toBeEnabled();
  expect(writes).toEqual([]);
  // the re-read now fails: a tightening is still confirmed rather than assumed
  failReread = true;
  await page.getByLabel("Conversation retention (days)").fill("20");
  await save.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save audited change" }).click();
  await expect.poll(() => writes).toEqual(["PUT /v1/org/settings"]);
  await expect(save).toBeEnabled();
});
