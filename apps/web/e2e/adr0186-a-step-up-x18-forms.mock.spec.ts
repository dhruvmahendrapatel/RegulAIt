/**
 * ADR-0186 A (B4S-04) × X18 — the three X18 forms whose relaxing save the
 * gateway refuses with 403 `step_up_required` (against a mocked gateway):
 * lengthening a retention, enabling more MCP coverage, and allowing more
 * Outlook recipients. Each keeps its X18 confirmation, then:
 *
 *  - confirming opens "Confirm it's you" while the form is still locked (the
 *    single-flight is held across the step-up);
 *  - completing the step-up resends the SAME write once with the grant: the
 *    gateway's handler receives exactly one write;
 *  - cancelling the step-up writes nothing (only the refused attempt went out),
 *    shows the refusal and re-enables the form.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ME = { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
const OUTLOOK = { id: "o1", name: "acme-outlook", provider: "outlook", connectorId: "k2", defaultChannel: "registered@example.test", allowFencedDecide: false, notifyAlertMinSeverity: null, enabled: true, createdAt: "2026-10-01T00:00:00Z", outboundSupported: true, outlookRecipientAllowList: ["a@example.test"] };

/** every /v1 GET answers from `state`; a write that reaches the handler (it carried a grant) is recorded */
async function mockApi(page: Page) {
  const state: Record<string, unknown> = {
    "/v1/org/settings": { settings: { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 30, mcpProtocolMethods: ["resources/list"], mcpUpstreamTransports: ["streamable_http"] } },
    "/v1/inventory/memory-stores": { stores: [] },
    "/v1/servers": { servers: [] },
    "/v1/users": { users: [] },
    "/v1/chatops/connections": { connections: [OUTLOOK], posture: "" },
    "/v1/chatops/identity-links": { links: [], posture: "" },
    "/v1/connectors": { connectors: [] },
  };
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, ME);
    if (method === "PUT" || method === "PATCH") {
      writes.push({ method, path: p, body: req.postDataJSON() });
      return json(route, {});
    }
    return json(route, state[p] ?? {});
  });
  return writes;
}

interface FormCase {
  name: string;
  url: string;
  method: "PUT" | "PATCH";
  path: string;
  /** make a relaxing edit and pass the form's own X18 confirmation */
  relax(page: Page): Promise<void>;
  save: string;
  expected: Record<string, unknown>;
}

const cases: FormCase[] = [
  {
    name: "retention: lengthening conversation retention",
    url: "/ui/admin/retention",
    method: "PUT",
    path: "/v1/org/settings",
    save: "Save retention settings",
    async relax(page) {
      await expect(page.getByLabel("Conversation retention (days)")).toHaveValue("30");
      await page.getByLabel("Conversation retention (days)").fill("45");
      await page.getByRole("button", { name: "Save retention settings" }).click();
      await page.getByRole("dialog", { name: "Extend memory retention?" }).getByRole("button", { name: "Save audited change" }).click();
    },
    expected: { conversationRetentionDays: 45 },
  },
  {
    name: "MCP coverage: enabling a protocol method",
    url: "/ui/admin/mcp-servers",
    method: "PUT",
    path: "/v1/org/settings",
    save: "Save MCP coverage",
    async relax(page) {
      await page.getByRole("checkbox", { name: "prompts/list · read", exact: true }).check();
      await page.getByRole("button", { name: "Save MCP coverage" }).click();
      await page.getByRole("dialog", { name: "Enable more MCP coverage?" }).getByRole("button", { name: "Save audited change" }).click();
    },
    expected: { mcpProtocolMethods: ["resources/list", "prompts/list"] },
  },
  {
    name: "Outlook recipients: allowing another mailbox",
    url: "/ui/admin/chatops",
    method: "PATCH",
    path: "/v1/chatops/connections/o1",
    save: "Save Outlook recipients",
    async relax(page) {
      await page.getByLabel("Additional recipients for acme-outlook").fill("a@example.test\nb@example.test");
      await page.getByRole("button", { name: "Save Outlook recipients" }).click();
      await page.getByRole("dialog", { name: "Allow more Outlook recipients?" }).getByRole("button", { name: "Save audited recipients" }).click();
    },
    expected: { outlookRecipientAllowList: ["a@example.test", "b@example.test"] },
  },
];

test.describe("ADR-0186 A: the X18 relaxing saves step up inside their held lock", () => {
  for (const c of cases) {
    test(`${c.name}: completing the step-up sends exactly one write`, async ({ page }) => {
      const writes = await mockApi(page);
      const su = await requireStepUpOn(page, { method: c.method, path: c.path, kind: "settings_relax" });
      await page.goto(c.url);
      await c.relax(page);
      await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toBeVisible();
      // the single-flight is held across the step-up: the form cannot be submitted again meanwhile
      await expect(page.getByRole("button", { name: c.save })).toBeDisabled();
      await confirmStepUp(page);
      await su.expectResentOnce();
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]).toMatchObject({ method: c.method, path: c.path, body: c.expected });
    });

    test(`${c.name}: cancelling the step-up writes nothing and re-enables the form`, async ({ page }) => {
      const writes = await mockApi(page);
      const su = await requireStepUpOn(page, { method: c.method, path: c.path, kind: "settings_relax" });
      await page.goto(c.url);
      await c.relax(page);
      const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("alert").filter({ hasText: "confirm it's you" })).toBeVisible();
      await expect(page.getByRole("button", { name: c.save })).toBeEnabled();
      // only the refused attempt went out; nothing reached the handler and no step-up was verified
      expect(su.attempts).toHaveLength(1);
      expect(su.attempts[0]!.header).toBeNull();
      expect(su.verifies).toHaveLength(0);
      expect(writes).toEqual([]);
    });
  }
});
