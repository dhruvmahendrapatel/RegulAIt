/**
 * ADR-0179 (AER-015) — Outlook cannot be registered for ChatOps approval cards
 * until an outbound sender exists. From the browser's side, every /v1 and
 * /auth call answered by an in-test mock:
 *
 *  - the provider select still OFFERS outlook, disabled, and says why beneath it;
 *  - slack and teams stay selectable;
 *  - a pre-existing outlook workspace (registered before the refusal) still
 *    lists, flagged "cannot send cards";
 *  - axe (WCAG 2.x A/AA) in BOTH themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const connections = [
  { id: "c1", name: "acme-slack", provider: "slack", connectorId: "k1", defaultChannel: "C0123", allowFencedDecide: false, notifyAlertMinSeverity: null, enabled: true, createdAt: "2026-10-01T00:00:00Z", signingSecretSet: true, outboundSupported: true, botAppId: null, botTenantId: null, botEndpoint: null },
  { id: "c2", name: "legacy-outlook", provider: "outlook", connectorId: "k2", defaultChannel: "approvers@example.test", allowFencedDecide: false, notifyAlertMinSeverity: null, enabled: true, createdAt: "2026-09-25T00:00:00Z", signingSecretSet: false, outboundSupported: false, botAppId: null, botTenantId: null, botEndpoint: null },
];

async function mockApi(page: Page) {
  const posts: unknown[] = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/chatops/connections") {
      if (method === "POST") posts.push(route.request().postDataJSON());
      return json(route, { connections, posture: "The chat surface is a COURIER." });
    }
    if (p === "/v1/chatops/identity-links") return json(route, { links: [], posture: "" });
    if (p === "/v1/connectors") return json(route, { connectors: [{ id: "k1", name: "slack-bot", kind: "chat", providerKind: "slack" }] });
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

test.describe("ADR-0179 AER-015: Outlook is not registrable for ChatOps cards", () => {
  test("outlook is offered disabled with its reason; a legacy outlook row is flagged", async ({ page }) => {
    const { posts } = await mockApi(page);
    await page.goto("/ui/admin/chatops");
    const provider = page.getByLabel("Provider", { exact: true });
    await expect(provider.locator('option[value="outlook"]')).toBeDisabled();
    await expect(provider.locator('option[value="outlook"]')).toHaveText(/unavailable: no outbound sender yet/);
    await expect(provider.locator('option[value="slack"]')).toBeEnabled();
    await expect(provider.locator('option[value="teams"]')).toBeEnabled();
    await expect(page.getByTestId("chatops-unavailable-outlook")).toHaveText(
      "outlook can't be registered for approval cards yet: there is no outbound sender for it, so a workspace would never deliver a card. Inbound outlook stays refused by design.",
    );
    // a disabled option cannot be chosen
    await expect(provider.selectOption("outlook", { timeout: 1000 })).rejects.toThrow();
    await expect(provider).toHaveValue("slack");

    const legacy = page.getByRole("row", { name: /^legacy-outlook/ });
    await expect(legacy.getByText("cannot send cards", { exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: /^acme-slack/ }).getByText("cannot send cards")).toHaveCount(0);
    expect(posts).toEqual([]);

    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on ChatOps (${theme})`).toEqual([]);
    }
    await setTheme(page, "light");
  });
});
