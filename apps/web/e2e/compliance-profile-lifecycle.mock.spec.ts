/**
 * ADR-0208 (G7) — compliance profiles on the real contracts, mocked: the create-only card, Edit profile with a
 * reviewed diff (POST …/versions → 202 pending), and Retire with its step-up and its in-use refusal, which keeps
 * the dialog open with the typed reason.
 */
import { expect, test, type Page } from "@playwright/test";
import { ISO, json, mockApi } from "./proto-fixtures";

const usage = (projects: string[], extra: Partial<Record<"pendingProjects" | "teams" | "resources", string[]>> = {}) => ({
  projects,
  pendingProjects: [],
  teams: [],
  resources: [],
  ...extra,
});

const hipaa = (u: ReturnType<typeof usage>) => ({
  id: "cp-hipaa",
  tag: "hipaa",
  version: 3,
  status: "active",
  retiredAt: null,
  retiredReason: null,
  pendingReview: null,
  createdAt: ISO,
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
  usage: u,
});
const base = { retiredAt: null, retiredReason: null, pendingReview: null, createdAt: ISO, requiredTemplateIds: [], mcpDefaultMode: "read_only" };
const PROFILES = (u: ReturnType<typeof usage>) => [
  hipaa(u),
  {
    ...base, id: "cp-pci", tag: "pci-dss", version: 1, status: "active", piiMode: "warn", auditRetentionDays: 365, backupRetentionDays: 30,
    patchCadenceDays: 14, usage: usage(["Credit operations"], { resources: ["prod-cp"] }),
    pendingReview: { approvalId: "ap-1", version: 2, reviewerUserId: "11111111-1111-4111-8111-111111111112" },
  },
  {
    ...base, id: "cp-gdpr", tag: "gdpr-2024", version: 4, status: "retired", retiredAt: ISO, retiredReason: "replaced", piiMode: "block",
    auditRetentionDays: 730, backupRetentionDays: null, patchCadenceDays: null, usage: usage([]),
  },
];

async function open(page: Page, u = usage(["Credit operations", "Support desk", "Limit assistant"], { teams: ["team-17"], resources: ["prod-cp", "backup-eu"] }), retire?: Parameters<typeof json>[1] & object) {
  const api = await mockApi(page, (p, method, _b, route) => {
    if (p === "/v1/compliance/profiles" && method === "GET") return json(route, { profiles: PROFILES(u) });
    if (p === "/v1/workflows/templates")
      return json(route, { templates: [{ id: "t-mcr", name: "Model change review", definition: {} }, { id: "t-2p", name: "Two-person release", definition: {} }] });
    if (p === "/v1/compliance/profiles/cp-hipaa/versions")
      return json(route, { pending: true, approvalId: "ap-7781", version: 4, changes: [], loosens: ["piiMode"], reach: u }, 202);
    if (p === "/v1/compliance/profiles/cp-hipaa/retire") return json(route, retire ?? { ...hipaa(u), status: "retired", retiredAt: ISO }, retire ? 409 : 200);
    return undefined;
  });
  await page.goto("/ui/admin/compliance");
  await expect(page.getByRole("button", { name: "Edit profile hipaa" })).toBeVisible({ timeout: 30_000 });
  return api;
}

test("g7 profiles list, edit form, review, send for review", async ({ page }) => {
  const api = await open(page);
  // a profile with a change in review cannot be edited again until it is decided
  await expect(page.getByText("v2 in review")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit profile pci-dss" })).toBeDisabled();
  await page.getByRole("button", { name: /^Retired/ }).click();
  await expect(page.getByText(/Read-only · retired/)).toBeVisible();
  await page.getByRole("button", { name: /^Active/ }).click();

  await page.getByRole("button", { name: "Edit profile hipaa" }).click();
  const dialog = page.getByRole("dialog", { name: /Edit profile “hipaa”/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("PII mode").selectOption("warn");
  await dialog.getByLabel("Patch cadence (days, at most)").fill("14");
  await dialog.getByRole("button", { name: "Review change" }).click();
  const review = page.getByRole("dialog", { name: /Review the change/ });
  await expect(review).toContainText("This change creates version 4 and needs a reviewer before it applies.");
  await expect(review).toContainText("Affects 3 projects, 1 team and 2 infrastructure resources");
  await expect(review).toContainText("loosens");
  await review.getByLabel("Reviewer").selectOption({ label: "Avery Approver" });
  await review.getByLabel(/Reason/).fill("Support desk needs warn-level PII handling for the pilot");
  await review.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText("Sent to Avery Approver for review")).toBeVisible();
  const sent = api.calls.find((c) => c.path === "/v1/compliance/profiles/cp-hipaa/versions");
  expect(sent?.body).toMatchObject({ piiMode: "warn", patchCadenceDays: 14, reviewerUserId: "11111111-1111-4111-8111-111111111112" });
  // the carried floors go back unchanged
  expect(sent?.body).toMatchObject({ maxProjectBudgetUsd: 5000, minIsolationClass: "user_space_kernel", redteamMinTrials: 3 });
});

test("g7 retire is blocked by any carrier, listed by kind", async ({ page }) => {
  await open(page, usage([], { teams: ["team-17"] }));
  const blocked = page.getByTestId("retire-blocked-hipaa");
  await expect(blocked).toContainText("In use by 1 team");
  await blocked.getByRole("button", { name: /what uses hipaa/ }).click();
  await expect(page.getByText("Teams (default classification): team-17")).toBeVisible();
});

test("g7 retire: confirm, then a server refusal keeps the dialog and the typed reason", async ({ page }) => {
  const refusal = { error: "compliance_profile_in_use", projects: [], pendingProjects: ["Late project"], teams: [], resources: [] };
  const api = await open(page, usage([]), refusal);
  await page.getByRole("button", { name: "Retire hipaa" }).click();
  const dialog = page.getByRole("dialog", { name: /Retire profile “hipaa”/ });
  await expect(dialog).toContainText("No project, team or resource can be tagged");
  const reason = "Replaced by the hipaa-2026 profile";
  await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: "Retire profile" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Still in use by 1 pending project");
  await expect(dialog.getByLabel("Reason")).toHaveValue(reason);
  expect(api.calls.find((c) => c.path === "/v1/compliance/profiles/cp-hipaa/retire")?.body).toEqual({ reason });
});

test("g7 retire succeeds and closes", async ({ page }) => {
  await open(page, usage([]));
  await page.getByRole("button", { name: "Retire hipaa" }).click();
  const dialog = page.getByRole("dialog", { name: /Retire profile “hipaa”/ });
  await dialog.getByLabel("Reason").fill("Replaced by the hipaa-2026 profile");
  await dialog.getByRole("button", { name: "Retire profile" }).click();
  await expect(page.getByText("Profile “hipaa” retired")).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("g7 the new-profile card refuses an existing tag and points to Edit profile", async ({ page }) => {
  await open(page);
  await page.getByLabel("Tag").fill("hipaa");
  await expect(page.getByText(/“hipaa” already exists/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create profile" })).toBeDisabled();
  await page.getByLabel("Tag").fill("sox");
  await expect(page.getByRole("button", { name: "Create profile" })).toBeEnabled();
});
