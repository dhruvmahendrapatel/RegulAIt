/**
 * Lane U4, design lead D6 policies-gates-06, against a mocked gateway: the Source tiers badge says what its tier
 * means through an (i) button rather than a hover-only title, the tier reads as a word, and the delivered digest is
 * the kit's copyable IdChip rather than a titled <code>. axe (WCAG 2.x A/AA) clean in both themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const DIGEST = "a".repeat(64);

async function mockApi(page: Page) {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "u", isAdmin: true, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } });
    if (p === "/v1/content-trust")
      return json(route, {
        tiers: ["untrusted", "standard", "trusted"],
        defaultTier: "untrusted",
        writeFloor: "trusted",
        writeFloors: ["standard", "trusted"],
        sources: [{ sourceKind: "mcp_server", sourceId: "s1", name: "Ticket search", tier: "untrusted", explicit: false, setByUserId: null, setAt: null }],
      });
    if (p === "/v1/content-provenance/records")
      return json(route, {
        records: [
          { id: "r1", auditId: "a1", decisionAuditId: "d1", contextId: null, sourceKind: "mcp_server", sourceId: "s1", sourceDetail: "Ticket search", trustTier: "untrusted", classification: "clean", digestAlg: "sha256", digestKeyId: null, upstreamDigest: DIGEST, deliveredDigest: DIGEST, createdAt: "2026-10-24T09:00:00Z", anchor: null },
          { id: "r2", auditId: "a2", decisionAuditId: "d2", contextId: null, sourceKind: "connector", sourceId: "c1", sourceDetail: null, trustTier: "trusted", classification: "unscanned", digestAlg: "unavailable", digestKeyId: null, upstreamDigest: null, deliveredDigest: null, createdAt: "2026-10-24T09:00:00Z", anchor: null },
        ],
      });
    return json(route, {});
  });
}

test("D6: the tier meaning is an (i) button, the tier a word, the digest a copyable chip; axe-clean", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/admin/content-trust");
  const sourceRow = page.getByRole("row").filter({ hasText: "Ticket search" }).first();
  await expect(sourceRow.getByText("Untrusted (default)", { exact: true })).toBeVisible();
  await expect(sourceRow.locator('[title^="Untrusted:"]')).toHaveCount(0);
  await sourceRow.getByRole("button", { name: "what untrusted means" }).click();
  await expect(page.getByText("Untrusted: its content can never drive a write")).toBeVisible();
  await page.keyboard.press("Escape");

  const records = page.locator("section[data-rg-card]").filter({ hasText: "Provenance evidence" }).first();
  await expect(records.locator("[data-id-chip]")).toHaveCount(1);
  await expect(records.locator("[data-id-chip]")).toHaveText("aaaaaaaa…");
  await expect(records.getByText("none stored", { exact: true })).toBeVisible();
  await expect(records.locator(`code[title="${DIGEST}"]`)).toHaveCount(0);

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((next) => (document.documentElement.dataset.theme = next), theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(" ")}`), `axe (${theme})`).toEqual([]);
  }
});
