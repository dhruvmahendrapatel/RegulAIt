/** PROTOTYPE (#453 G8) — infrastructure: Edit / Retire resource (with its 409 refusal) and Edit / Retire policy (with the fallback stated). */
import { expect, test, type Page } from "@playwright/test";
import { ISO, SHOTS, json, mockApi } from "./proto-fixtures";

const RESOURCES = [
  { id: "r1", name: "prod-cp", kind: "control_plane", provider: "mock", classifications: ["hipaa"], status: "active", effectivePolicy: { autoRemediateMaxSeverity: "medium", backupRetentionDaysFloor: 35, patchCadenceDaysCeiling: 30 } },
  { id: "r2", name: "backup-eu", kind: "backup_target", provider: "mock", classifications: ["hipaa"], status: "active", effectivePolicy: { autoRemediateMaxSeverity: "low", backupRetentionDaysFloor: 35, patchCadenceDaysCeiling: 30 } },
  { id: "r3", name: "legacy-runtime", kind: "agent_runtime", provider: "mock", classifications: [], status: "retired", retiredAt: ISO, effectivePolicy: {} },
];
const POLICIES = [
  { id: "pol-fleet", resourceId: null, patchCadenceDays: 7, certRotationDaysBeforeExpiry: 30, backupSchedule: "daily-0200", backupRetentionDays: 30, autoRemediateMaxSeverity: "low" },
  { id: "pol-r1", resourceId: "r1", patchCadenceDays: 14, certRotationDaysBeforeExpiry: 21, backupSchedule: "hourly", backupRetentionDays: 35, autoRemediateMaxSeverity: "medium" },
];

async function open(page: Page, retireReply: { status: number; body: unknown }) {
  await mockApi(page, (p, method, _b, route) => {
    if (p === "/v1/infra/resources" && method === "GET") return json(route, { resources: RESOURCES });
    if (p === "/v1/infra/policies" && method === "GET") return json(route, { policies: POLICIES });
    if (p === "/v1/infra/posture") return json(route, { resources: 2, findings: 5, open: 3, bySeverity: { critical: 0, high: 1, medium: 2, low: 2 }, byKind: {}, byStatus: {}, backup: { missed: 0, targets: 1 } });
    if (["/v1/infra/findings", "/v1/infra/certs", "/v1/infra/patches", "/v1/infra/backups"].includes(p)) return json(route, { findings: [], certs: [], patches: [], backups: [] });
    if (p === "/v1/org/settings") return json(route, { settings: {} });
    if (p === "/v1/compliance/profiles") return json(route, { profiles: [{ tag: "hipaa" }, { tag: "pci-dss" }] });
    if (p === "/v1/infra/resources/r1/retire") return json(route, retireReply.body, retireReply.status);
    return undefined;
  });
  await page.goto("/ui/admin/infrastructure");
  await expect(page.getByRole("button", { name: "Retire resource prod-cp" })).toBeVisible({ timeout: 30_000 });
}

test("g8 infra list, retire resource confirm, refusal", async ({ page }) => {
  await open(page, { status: 409, body: { error: "infra_resource_in_use", pendingRemediations: 2 } });
  await page.getByText("Resources — with cascade-derived floors").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/g8-infra.png` });
  await page.getByRole("button", { name: "Retire resource prod-cp" }).click();
  const dialog = page.getByRole("dialog", { name: /Retire resource “prod-cp”/ });
  await expect(dialog).toContainText("Scans stop checking ‘prod-cp’");
  await dialog.getByLabel("Reason").fill("Control plane moved to the new region");
  await page.screenshot({ path: `${SHOTS}/g8-retire-resource.png` });
  await dialog.getByRole("button", { name: "Retire resource" }).click();
  await expect(page.getByTestId("infra-retire-refusal")).toHaveText("2 remediations are waiting on approval for this resource. Decide them first.");
  await page.screenshot({ path: `${SHOTS}/g8-retire-refused.png` });
});

test("g8 retire policy shows the fallback", async ({ page }) => {
  await open(page, { status: 200, body: { retired: true } });
  await page.getByRole("button", { name: "Retire policy for prod-cp" }).click();
  const dialog = page.getByRole("dialog", { name: /Retire the policy for “prod-cp”/ });
  await expect(dialog.getByTestId("policy-fallback")).toContainText("falls back to the fleet policy");
  await page.screenshot({ path: `${SHOTS}/g8-retire-policy.png` });
});
