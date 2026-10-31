/**
 * ADR-0208 G8 — infrastructure: Edit / Retire resource (with its 409 refusal shown inside the dialog, the typed reason
 * kept) and Edit / Retire policy (with the fleet fallback stated before confirming). Retired rows are read-only. The
 * mocked routes answer with the gateway's real contracts (status codes, error codes, payload fields).
 */
import { expect, test, type Page } from "@playwright/test";
import { ISO, json, mockApi } from "./proto-fixtures";

const R1 = "a1111111-1111-4111-8111-111111111111";
const R2 = "a2222222-2222-4222-8222-222222222222";
const R3 = "a3333333-3333-4333-8333-333333333333";
const FLEET = "b0000000-0000-4000-8000-000000000000";
const POL_R1 = "b1111111-1111-4111-8111-111111111111";
const POL_R3 = "b3333333-3333-4333-8333-333333333333";
const F1 = "c1111111-1111-4111-8111-111111111111";
const F2 = "c2222222-2222-4222-8222-222222222222";
const REASON = "Control plane moved to the new region";

const active = { status: "active", retiredAt: null, retiredReason: null, retiredByUserId: null };
const RESOURCES = [
  { id: R1, name: "prod-cp", kind: "control_plane", provider: "mock", classifications: ["hipaa"], ...active, effectivePolicy: { policyId: POL_R1, autoRemediateMaxSeverity: "medium", backupRetentionDaysFloor: 35, patchCadenceDaysCeiling: 14 } },
  { id: R2, name: "backup-eu", kind: "backup_target", provider: "mock", classifications: ["hipaa"], ...active, effectivePolicy: { policyId: FLEET, autoRemediateMaxSeverity: "low", backupRetentionDaysFloor: 35, patchCadenceDaysCeiling: 7 } },
  { id: R3, name: "legacy-runtime", kind: "agent_runtime", provider: "mock", classifications: [], status: "retired", retiredAt: ISO, retiredReason: "Decommissioned with the old cluster", retiredByUserId: null, effectivePolicy: { policyId: FLEET } },
];
const policy = (id: string, resourceId: string | null, extra: Record<string, unknown>) => ({
  id,
  resourceId,
  patchCadenceDays: null,
  certRotationDaysBeforeExpiry: null,
  backupSchedule: null,
  backupRetentionDays: null,
  driftBaseline: null,
  autoRemediateMaxSeverity: null,
  ...active,
  createdAt: ISO,
  ...extra,
});
const FLEET_POLICY = policy(FLEET, null, { patchCadenceDays: 7, certRotationDaysBeforeExpiry: 30, backupSchedule: "daily-0200", backupRetentionDays: 30, autoRemediateMaxSeverity: "low" });
const POLICIES = [
  FLEET_POLICY,
  policy(POL_R1, R1, { patchCadenceDays: 14, certRotationDaysBeforeExpiry: 21, backupSchedule: "hourly", backupRetentionDays: 35, autoRemediateMaxSeverity: "medium" }),
  policy(POL_R3, R3, { patchCadenceDays: 30, status: "retired", retiredAt: ISO, retiredReason: "Decommissioned with the old cluster" }),
];

type Reply = { status: number; body: unknown };
async function open(page: Page, replies: { retireResource?: Reply[]; retirePolicy?: Reply; patchResource?: Reply }) {
  const queue = [...(replies.retireResource ?? [])];
  const mocked = await mockApi(page, (p, method, _b, route) => {
    if (p === "/v1/infra/resources" && method === "GET") return json(route, { resources: RESOURCES });
    if (p === "/v1/infra/policies" && method === "GET") return json(route, { policies: POLICIES });
    if (p === "/v1/infra/posture") return json(route, { resources: 2, findings: 5, open: 3, bySeverity: { critical: 0, high: 1, medium: 2, low: 2 }, byKind: {}, byStatus: {}, backup: { missed: 0, targets: 1 } });
    if (["/v1/infra/findings", "/v1/infra/certs", "/v1/infra/patches", "/v1/infra/backups"].includes(p)) return json(route, { findings: [], certs: [], patches: [], backups: [] });
    if (p === "/v1/org/settings") return json(route, { settings: {} });
    if (p === "/v1/compliance/profiles") return json(route, { profiles: [{ tag: "hipaa" }, { tag: "pci-dss" }] });
    if (p === `/v1/infra/resources/${R1}/retire` && method === "POST") {
      const r = queue.shift() ?? { status: 500, body: { error: "unexpected" } };
      return json(route, r.body, r.status);
    }
    if (p === `/v1/infra/resources/${R1}` && method === "PATCH" && replies.patchResource) return json(route, replies.patchResource.body, replies.patchResource.status);
    if (p === `/v1/infra/policies/${POL_R1}/retire` && method === "POST" && replies.retirePolicy) return json(route, replies.retirePolicy.body, replies.retirePolicy.status);
    return undefined;
  });
  await page.goto("/ui/admin/infrastructure");
  await expect(page.getByRole("button", { name: "Retire resource prod-cp" })).toBeVisible({ timeout: 30_000 });
  return mocked;
}

test("retire resource: refused while remediations are pending, shown in the dialog with the reason kept, then retired", async ({ page }) => {
  const { calls } = await open(page, {
    retireResource: [
      { status: 409, body: { error: "infra_resource_remediations_pending", detail: "remediations wait", findingIds: [F1, F2], pendingRemediations: 2 } },
      { status: 200, body: { resource: { ...RESOURCES[0], status: "retired", retiredAt: ISO, retiredReason: REASON }, policiesRetired: [POL_R1] } },
    ],
  });
  await page.getByText("Resources — with cascade-derived floors").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: test.info().outputPath("g8-infra.png") });
  // a retired resource is read-only: no Edit, no Retire
  await expect(page.getByText("Read-only · retired 2026-10-29").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit legacy-runtime" })).toHaveCount(0);

  await page.getByRole("button", { name: "Retire resource prod-cp" }).click();
  const dialog = page.getByRole("dialog", { name: /Retire resource “prod-cp”/ });
  await expect(dialog).toContainText("Scans stop checking ‘prod-cp’");
  await dialog.getByLabel("Reason").fill(REASON);
  await dialog.getByRole("button", { name: "Retire resource" }).click();
  await expect(dialog.getByTestId("infra-retire-refusal")).toHaveText(
    "2 remediations are waiting on approval or approved but not applied for this resource. Decide or apply them first.",
  );
  await expect(dialog.getByLabel("Reason")).toHaveValue(REASON);
  await page.screenshot({ path: test.info().outputPath("g8-retire-refused.png") });

  await dialog.getByRole("button", { name: "Retire resource" }).click();
  await expect(dialog).toBeHidden();
  const posts = calls.filter((c) => c.path === `/v1/infra/resources/${R1}/retire`);
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toEqual({ reason: REASON });
});

test("retire policy: the confirm states the fleet fallback; the fleet policy and a retired policy offer no retire", async ({ page }) => {
  const { calls } = await open(page, {
    retirePolicy: { status: 200, body: { policy: { ...POLICIES[1], status: "retired", retiredAt: ISO, retiredReason: REASON }, fallback: { ...FLEET_POLICY, policyId: FLEET } } },
  });
  await expect(page.getByText("Fleet default: edit, not retire")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retire policy for legacy-runtime" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retire policy for prod-cp" }).click();
  const dialog = page.getByRole("dialog", { name: /Retire the policy for “prod-cp”/ });
  await expect(dialog.getByTestId("policy-fallback")).toContainText("falls back to the fleet policy: patch every 7 days, auto-remediate up to low");
  await page.screenshot({ path: test.info().outputPath("g8-retire-policy.png") });
  await dialog.getByLabel("Reason").fill(REASON);
  await dialog.getByRole("button", { name: "Retire policy" }).click();
  await expect(dialog).toBeHidden();
  expect(calls.find((c) => c.path === `/v1/infra/policies/${POL_R1}/retire`)?.body).toEqual({ reason: REASON });
});

test("edit resource: sends the real PATCH body and keeps a refusal inside the modal", async ({ page }) => {
  const { calls } = await open(page, {
    patchResource: { status: 409, body: { error: "infra_resource_name_taken", detail: "another resource (active or retired) already has this name", name: "backup-eu" } },
  });
  await page.getByRole("button", { name: "Edit prod-cp" }).click();
  const dialog = page.getByRole("dialog", { name: /Edit resource “prod-cp”/ });
  await dialog.getByLabel("Name").fill("backup-eu");
  await dialog.getByRole("button", { name: "Save resource" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(calls.find((c) => c.path === `/v1/infra/resources/${R1}` && c.method === "PATCH")?.body).toEqual({ name: "backup-eu", classifications: ["hipaa"] });
});
