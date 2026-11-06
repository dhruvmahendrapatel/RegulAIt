/**
 * ADR-0216 review (#614): revoking a trusted signing key is permanent, so the Model artifacts tab asks first. The
 * dialog names the key and the consequence; Cancel sends nothing; only the confirmed revocation is POSTed. The keys
 * table follows X7 (an empty primary slot, Revoke in the last slot, the same slots on a revoked row).
 * Mocked API (builder and engines fixtures, synthetic keys only).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock } from "./builder-fixtures";
import { installEnginesMock } from "./engines-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const TRUSTED = { id: "99999999-9999-4000-8000-000000000216", name: "release key", algorithm: "ecdsa_p256_sha256", keyHint: "a".repeat(64), publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n", createdAt: "2026-10-30T10:00:00.000Z", revokedAt: null as string | null };
const REVOKED = { ...TRUSTED, id: "99999999-9999-4000-8000-000000000217", name: "old key", keyHint: "b".repeat(64), revokedAt: "2026-10-29T10:00:00.000Z" };

async function setup(page: Page) {
  await installBuilderMock(page);
  await installEnginesMock(page);
  await page.route("**/v1/admission/skills", (route) => json(route, { scannerVersion: "skill-admission/2", holdAt: "medium", refuseAt: "high", rules: [], skills: [] }));
  await page.route("**/v1/release-quarantine", (route) => json(route, { enabled: false, minReleaseAgeDays: 7, recommendedDays: 7, servers: [], skills: [] }));
  await page.route("**/v1/mcp/admission", (route) => json(route, { mode: "log", enforcing: false, servers: [] }));
  await page.route("**/v1/org/settings", (route) => json(route, { settings: { modelArtifactMaxMegabytes: 512, modelArtifactRetentionDays: 30 } }));
  const keys = [{ ...TRUSTED }, { ...REVOKED }];
  const revokes: string[] = [];
  await page.route("**/v1/model-signing-keys", (route) => json(route, { keys, algorithms: ["ecdsa_p256_sha256"] }));
  await page.route("**/v1/model-signing-keys/*/revoke", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    revokes.push(id);
    const k = keys.find((x) => x.id === id)!;
    k.revokedAt = "2026-10-31T10:00:00.000Z";
    return json(route, { key: k, changed: true });
  });
  return { revokes };
}

const keysCard = (page: Page) => page.locator("section", { hasText: "Trusted signing keys" }).last();

test.describe("ADR-0216: trusted signing keys", () => {
  test("revoking a key asks first, names the key and the consequence, and Cancel sends nothing", async ({ page }) => {
    const { revokes } = await setup(page);
    await page.goto("/ui/admin/admission?tab=artifacts");
    const card = keysCard(page);
    await expect(card.getByRole("cell", { name: "release key", exact: true })).toBeVisible();
    // a revoked key offers no Revoke
    await expect(card.getByRole("button", { name: "Revoke old key" })).toHaveCount(0);

    await card.getByRole("button", { name: "Revoke release key" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke signing key release key?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Model files signed only by this key will be blocked at once, and the key can never be trusted again.");
    expect(revokes).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(revokes).toEqual([]);

    await card.getByRole("button", { name: "Revoke release key" }).click();
    await page.getByRole("dialog", { name: "Revoke signing key release key?" }).getByRole("button", { name: "Revoke key" }).click();
    await expect.poll(() => revokes).toEqual([TRUSTED.id]);
    await expect(card.getByRole("button", { name: "Revoke release key" })).toHaveCount(0);
  });

  test("X7: the actions column has an empty primary slot and Revoke in the last slot, on every row", async ({ page }) => {
    await setup(page);
    await page.goto("/ui/admin/admission?tab=artifacts");
    const card = keysCard(page);
    await expect(card.getByRole("cell", { name: "old key", exact: true })).toBeVisible();
    for (const name of ["release key", "old key"]) {
      const row = card.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
      const grid = row.getByRole("cell").last().locator(":scope > div");
      await expect(grid.locator(":scope > span"), name).toHaveCount(3);
      await expect(grid.locator(":scope > span").first(), name).toBeEmpty();
    }
    const trusted = card.getByRole("row").filter({ has: page.getByRole("cell", { name: "release key", exact: true }) });
    await expect(trusted.getByRole("cell").last().locator(":scope > div > span").nth(2).getByRole("button", { name: "Revoke release key" })).toBeVisible();
  });
});
