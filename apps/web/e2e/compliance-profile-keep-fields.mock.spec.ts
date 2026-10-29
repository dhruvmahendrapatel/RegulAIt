/**
 * #453 — the compliance profile form never clears a floor it does not show (against a mocked gateway).
 * `POST /v1/compliance/profiles` replaces the whole profile, so an update from this form sends back the budget,
 * guardrail, red-team and isolation floors the profile already holds; a new profile starts at the strict defaults.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const HIPAA = {
  id: "cp-1",
  tag: "hipaa",
  requiredTemplateIds: null,
  mcpDefaultMode: "read_only",
  auditRetentionDays: 2190,
  piiMode: "block",
  backupRetentionDays: 30,
  patchCadenceDays: 14,
  maxProjectBudgetUsd: 500,
  budgetEnforcement: "block",
  guardrailModes: { prompt_injection: "block" },
  redteamGatingClasses: ["prompt_injection"],
  redteamMinTrials: 3,
  redteamFailOnSeverity: "high",
  minIsolationClass: "microvm",
};

async function mockApi(page: Page) {
  const me = { userId: "u-ada", isAdmin: true, user: { id: "u-ada", email: "ada@example.test", displayName: "Ada Admin" } };
  const posts: Array<Record<string, unknown>> = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/compliance/profiles" && req.method() === "POST") {
      posts.push(req.postDataJSON());
      return json(route, { profile: HIPAA });
    }
    if (p === "/v1/compliance/profiles") return json(route, { profiles: [HIPAA] });
    if (p === "/v1/workflows/templates") return json(route, { templates: [] });
    return json(route, {});
  });
  return { posts };
}

const form = (page: Page) => page.locator("section", { has: page.getByRole("button", { name: /Save profile|Update profile/ }) });

test("a new profile starts at the strict defaults", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/ui/admin/compliance");
  const card = form(page);
  await card.getByLabel("Tag", { exact: true }).fill("pci");
  await expect(card.getByLabel("MCP default mode")).toHaveValue("read_only");
  await expect(card.getByLabel("PII mode")).toHaveValue("block");
  await card.getByRole("button", { name: "Save profile" }).click();
  await expect.poll(() => api.posts.length).toBe(1);
  expect(api.posts[0]).toMatchObject({ tag: "pci", mcpDefaultMode: "read_only", piiMode: "block" });
  expect(api.posts[0]).not.toHaveProperty("guardrailModes");
});

test("updating an existing tag loads it and sends back every floor the form does not show", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/ui/admin/compliance");
  const card = form(page);
  await card.getByLabel("Tag", { exact: true }).fill("hipaa");
  await expect(card.getByLabel("Audit retention days (blank = none)")).toHaveValue("2190");
  await expect(card.getByRole("status")).toContainText("keep their current values");
  await card.getByLabel("Patch cadence days (infra ceiling)").fill("7");
  await card.getByRole("button", { name: "Update profile" }).click();
  await expect.poll(() => api.posts.length).toBe(1);
  expect(api.posts[0]).toEqual({
    tag: "hipaa",
    mcpDefaultMode: "read_only",
    piiMode: "block",
    auditRetentionDays: 2190,
    backupRetentionDays: 30,
    patchCadenceDays: 7,
    maxProjectBudgetUsd: 500,
    budgetEnforcement: "block",
    guardrailModes: { prompt_injection: "block" },
    redteamGatingClasses: ["prompt_injection"],
    redteamMinTrials: 3,
    redteamFailOnSeverity: "high",
    minIsolationClass: "microvm",
  });
});
