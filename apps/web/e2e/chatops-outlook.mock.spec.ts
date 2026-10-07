/**
 * Outlook ChatOps from the browser's side, every /v1 and /auth call answered by
 * an in-test mock.
 *
 * History: ADR-0179 (AER-015) offered outlook disabled, because there was no
 * outbound sender. ADR-0183 batch 2.6 built the sender (a Graph sendMail
 * courier, ADR-0121 amended), so this spec now pins the registration:
 *
 *  - outlook is selectable, labelled send-only, with no "unavailable" reason;
 *  - choosing it swaps the signing secret and the chat-decide opt-in for the
 *    four app registration fields (tenant ID, client ID, client secret, sender
 *    mailbox) and a recipient mailbox;
 *  - Connect stores the app registration on the chosen connector FIRST (the
 *    encrypted connector credential store, JSON {appId, appPassword, tenantId,
 *    senderUpn}), then registers the workspace with no signing secret and no
 *    chat decide; the secret field is emptied afterwards;
 *  - half-filled app registration fields are refused in the page, nothing sent;
 *  - axe (WCAG 2.x A/AA) in BOTH themes with the outlook form showing.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const connections = [
  { id: "c1", name: "acme-slack", provider: "slack", connectorId: "k1", defaultChannel: "C0123", allowFencedDecide: false, notifyAlertMinSeverity: null, enabled: true, createdAt: "2026-10-01T00:00:00Z", signingSecretSet: true, outboundSupported: true, botAppId: null, botTenantId: null, botEndpoint: null },
];

async function mockApi(page: Page) {
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (method === "POST") posts.push({ path: p, body: route.request().postDataJSON() });
    if (p === "/v1/chatops/connections") {
      return method === "POST" ? json(route, { id: "c2", name: "acme-outlook", provider: "outlook" }, 201) : json(route, { connections, posture: "The chat surface is a COURIER." });
    }
    if (p === "/v1/connectors/k2/credential" && method === "POST") return json(route, { connectorId: "k2", baseUrl: null }, 201);
    if (p === "/v1/chatops/identity-links") return json(route, { links: [], posture: "" });
    if (p === "/v1/connectors") {
      return json(route, { connectors: [{ id: "k1", name: "slack-bot", kind: "chat", providerKind: "slack" }, { id: "k2", name: "outlook-mailer", kind: "chat", providerKind: "outlook" }] });
    }
    return json(route, {});
  });
  return { posts };
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }, theme);
}

test.describe("ADR-0183 2.6: Outlook is registrable for ChatOps approval cards", () => {
  test("outlook is selectable and asks for the four app registration fields; Connect stores the credential, then registers", async ({ page }) => {
    const { posts } = await mockApi(page);
    await page.goto("/ui/admin/chatops");
    const provider = page.getByLabel("Provider", { exact: true });
    await expect(provider.locator('option[value="outlook"]')).toBeEnabled();
    await expect(provider.locator('option[value="outlook"]')).toHaveText("outlook (send-only by design, no signing secret)");
    await expect(page.getByTestId("chatops-unavailable-outlook")).toHaveCount(0);

    await page.getByLabel("Name", { exact: true }).fill("acme-outlook");
    await provider.selectOption("outlook");
    // the inbound-only controls are gone; the app registration is asked for
    await expect(page.getByLabel(/^Signing secret/)).toHaveCount(0);
    await expect(page.getByLabel(/Allow deciding SENSITIVE/)).toHaveCount(0);
    await page.getByLabel("Connector (holds the app registration)").selectOption("k2");

    // half-filled: refused in the page, nothing sent
    await page.getByLabel("Tenant ID").fill("contoso.onmicrosoft.com");
    await page.getByLabel("Default recipient mailbox").fill("approvers@example.test");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText("Fill in all four app registration fields", { exact: false }).first()).toBeVisible();
    expect(posts).toEqual([]);

    await page.getByLabel("Client ID").fill("client-1111");
    await page.getByLabel(/^Client secret/).fill("synthetic-client-secret");
    await page.getByLabel("Sender mailbox").fill("regulait-approvals@example.test");

    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on ChatOps outlook form (${theme})`).toEqual([]);
    }
    await setTheme(page, "light");

    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText("Workspace connected")).toBeVisible();
    expect(posts.map((p) => p.path)).toEqual(["/v1/connectors/k2/credential", "/v1/chatops/connections"]);
    expect(JSON.parse((posts[0]!.body as { token: string }).token)).toEqual({
      appId: "client-1111",
      appPassword: "synthetic-client-secret",
      tenantId: "contoso.onmicrosoft.com",
      senderUpn: "regulait-approvals@example.test",
    });
    // the workspace itself carries no secret of any kind, and no chat decide
    expect(posts[1]!.body).toEqual({
      name: "acme-outlook",
      provider: "outlook",
      connectorId: "k2",
      defaultChannel: "approvers@example.test",
      allowFencedDecide: false,
    });
    // the client secret is not kept in the form
    await expect(page.getByLabel(/^Client secret/)).toHaveValue("");
  });
});
