/** PROTOTYPE (#453 G7) — compliance profiles: create-only card, Edit profile with a reviewed diff, Retire with its in-use refusal. */
import { expect, test, type Page } from "@playwright/test";
import { ISO, SHOTS, json, mockApi } from "./proto-fixtures";

const hipaa = (projects: string[]) => ({
  id: "cp-hipaa",
  tag: "hipaa",
  version: 3,
  status: "active",
  requiredTemplateIds: ["t-mcr"],
  mcpDefaultMode: "read_only",
  piiMode: "block",
  auditRetentionDays: 2190,
  backupRetentionDays: 35,
  patchCadenceDays: 30,
  maxProjectBudgetUsd: 5000,
  budgetEnforcement: "block",
  guardrailModes: { pii: "block", prompt_injection: "block", jailbreak: "warn" },
  redteamGatingClasses: ["prompt_injection", "data_exfiltration", "pii_leak"],
  redteamMinTrials: 3,
  redteamFailOnSeverity: "high",
  minIsolationClass: "user_space_kernel",
  usage: { projects, teams: ["team-17"], resources: ["prod-cp", "backup-eu"] },
});
const PROFILES = (hipaaProjects: string[]) => [
  hipaa(hipaaProjects),
  {
    id: "cp-pci", tag: "pci-dss", version: 1, status: "active", requiredTemplateIds: [], mcpDefaultMode: "read_only", piiMode: "warn",
    auditRetentionDays: 365, backupRetentionDays: 30, patchCadenceDays: 14, usage: { projects: ["Credit operations"], teams: [], resources: ["prod-cp"] },
  },
  {
    id: "cp-gdpr", tag: "gdpr-2024", version: 4, status: "retired", retiredAt: ISO, requiredTemplateIds: [], mcpDefaultMode: "read_only", piiMode: "block",
    auditRetentionDays: 730, backupRetentionDays: null, patchCadenceDays: null, usage: { projects: [], teams: [], resources: [] },
  },
];

async function open(page: Page, hipaaProjects = ["Credit operations", "team-17 support", "Credit-limit-increase assistant"]) {
  const api = await mockApi(page, (p, method, _b, route) => {
    if (p === "/v1/compliance/profiles" && method === "GET") return json(route, { profiles: PROFILES(hipaaProjects) });
    if (p === "/v1/workflows/templates")
      return json(route, { templates: [{ id: "t-mcr", name: "Model change review", definition: {} }, { id: "t-2p", name: "Two-person release", definition: {} }] });
    if (p === "/v1/compliance/profiles/cp-hipaa/versions") return json(route, { pending: true, approvalId: "ap-7781" }, 202);
    if (p.endsWith("/retire")) return json(route, { retired: true });
    return undefined;
  });
  await page.goto("/ui/admin/compliance");
  await expect(page.getByRole("button", { name: "Edit profile hipaa" })).toBeVisible({ timeout: 30_000 });
  return api;
}

test("g7 profiles list, edit form, review, send", async ({ page }) => {
  const api = await open(page);
  await page.screenshot({ path: `${SHOTS}/g7-profiles.png`, fullPage: true });
  await page.getByRole("button", { name: /^Retired/ }).click();
  await expect(page.getByText("Read-only")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g7-profiles-retired.png` });
  await page.getByRole("button", { name: /^Active/ }).click();

  await page.getByRole("button", { name: "Edit profile hipaa" }).click();
  const dialog = page.getByRole("dialog", { name: /Edit profile “hipaa”/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("PII mode").selectOption("warn");
  await dialog.getByLabel("Patch cadence (days, at most)").fill("14");
  await dialog.getByLabel("Gating classes").selectOption(["prompt_injection", "data_exfiltration"]);
  await dialog.getByLabel("Minimum isolation class").selectOption("microvm");
  await dialog.screenshot({ path: `${SHOTS}/g7-edit-form.png` });
  await dialog.getByRole("button", { name: "Review change" }).click();
  const review = page.getByRole("dialog", { name: /Review the change/ });
  await expect(review).toContainText("This change creates version 4 and needs a reviewer before it applies.");
  await expect(review).toContainText("Affects 3 projects, 1 team and 2 infrastructure resources");
  await review.getByLabel("Reviewer").selectOption({ label: "Avery Approver" });
  await review.getByLabel(/Reason/).fill("Support desk needs warn-level PII handling for the pilot");
  await review.screenshot({ path: `${SHOTS}/g7-edit-review.png` });
  await review.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText("Sent to Avery Approver for review")).toBeVisible();
  expect(api.calls.map((c) => c.path)).toContain("/v1/compliance/profiles/cp-hipaa/versions");
});

test("g7 retire blocked while in use", async ({ page }) => {
  await open(page);
  const blocked = page.getByTestId("retire-blocked-hipaa");
  await expect(blocked).toContainText("In use by 3 projects");
  await blocked.getByRole("button", { name: /projects using hipaa/ }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/g7-retire-blocked.png` });
});

test("g7 retire confirm when unused by projects", async ({ page }) => {
  await open(page, []);
  await page.getByRole("button", { name: "Retire hipaa" }).click();
  const dialog = page.getByRole("dialog", { name: /Retire profile “hipaa”/ });
  await expect(dialog).toContainText("stop inheriting its floors");
  await dialog.getByLabel("Reason").fill("Replaced by the hipaa-2026 profile");
  await page.screenshot({ path: `${SHOTS}/g7-retire-confirm.png` });
});
