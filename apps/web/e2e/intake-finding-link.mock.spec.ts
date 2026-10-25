/**
 * Issue #522 finding #30: a use case registered from a shadow-AI finding keeps the link, and both records show it.
 * Every /v1 and /auth call is answered by an in-test mock, so no database or session is needed.
 *
 *  - the finding's "Register as use case" link carries its id, and the intake sends it as `discoveryFindingId`;
 *  - the record (G1) shows "Found by discovery", linked back to the shadow-AI inventory for an admin;
 *  - a finding already registered shows its use case instead of the register link.
 *
 * Break proofs: drop `discoveryFindingId` from the wizard's submission inputs and the first test fails on the sent
 * body; drop the chip from the record's header and the second fails; drop the "Registered as" branch and the third
 * fails.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const FINDING = "44444444-4444-4444-8444-444444444444";
const LINKED_FINDING = "55555555-5555-4555-8555-555555555555";
const ID = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const finding = (id: string, subject: string, linkedUseCase: unknown) => ({
  id, subjectKind: "repo", subject, provider: "Unregistered AI", signalSources: ["sdk_dependency"], severity: "high", confidence: "medium",
  disposition: "confirmed", observationCount: 3, firstSeenAt: "2026-10-01", lastSeenAt: "2026-10-02", replacementAgent: null,
  replacementNote: null, dispositionStale: false, linkedUseCase,
});

const overview = {
  useCase: { id: ID, name: "Govern acme/credit-memo-assistant", description: "Drafts credit memos.", businessContext: "Faster memos.", status: "under_review", euAiActTier: "high", ownerName: "Ada Admin", complianceTags: ["eu-ai-act"], workflowInstanceId: "instance" },
  screening: { tier: "high", reasons: [], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: "2026-10-02T12:00:00Z" },
  stack: { agents: [], vendors: [] },
  risks: [],
  summary: { risks: 0, liveRisks: 0, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: 1 },
  approvals: [],
  audit: [],
  auditTotal: 0,
};

async function mock(page: Page, opts: { discovery?: unknown } = {}) {
  const isAdmin = true;
  const sent: Array<Record<string, unknown>> = [];
  await page.route("**/*", async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const user = { id: "u", email: "ada@example.test", displayName: "Ada Admin" };
    if (p === "/auth/me") return json({ userId: "u", isAdmin, via: "session", user, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json({ userId: "u", isAdmin, user });
    if (p === "/v1/agents") return json({ agents: [{ id: AGENT, name: "Credit assistant", provider: "mock", model: "mock-balanced", enabled: true, modes: ["chat"] }] });
    if (p === "/v1/vendors") return json({ vendors: [{ id: "v", name: "Acme Model Services", category: "model_provider", status: "approved" }] });
    if (p === "/v1/shadow-ai/findings") {
      return json({
        findings: [
          finding(FINDING, "acme/credit-memo-assistant", null),
          finding(LINKED_FINDING, "acme/claims-triage", { id: ID, name: "Govern acme/claims-triage", status: "under_review" }),
        ],
        coverage: { sources: [], sourcesOn: 1, sourcesPossible: 4, statement: "Coverage reflects only supplied evidence." },
        posture: "Detection is signal, not proof.",
      });
    }
    if (p === "/v1/shadow-ai/catalogue") return json({ signatures: [], total: 0, enabled: 0, oldestEntryAt: null, posture: "Data." });
    if (p === "/v1/shadow-ai/imports") return json({ imports: [] });
    if (p === "/v1/shadow-ai/adapters") return json({ adapters: [], posture: "Operator supplied evidence only.", pipeline: "No raw content retained." });
    if (p === "/v1/shadow-ai/discovery/catalog") return json({ catalogVersion: 1, total: 0, endpoints: 0, sdks: 0, entries: [], governedHosts: [], posture: "Catalogue classification only.", limits: "No scan is performed." });
    if (p === "/v1/users/directory") return json({ users: [] });
    if (p === "/v1/approvals") return json({ approvals: [] });
    if (p === "/v1/use-cases/intake/assist" && method === "POST") {
      return json({
        tier: { value: "high", reasons: [], rulesetVersion: 1, source: "rules", disclaimer: "Screening, not legal advice." },
        frameworks: [{ framework: "eu-ai-act", title: "EU AI Act", why: "EU nexus", source: "rules" }],
        risks: [],
        euAiActBlock: "```eu-ai-act-answers\n{}\n```",
        questionnaire: [{ id: "q1", heading: "1. Purpose and business context", text: "Draft answer", source: "rules" }],
        blocking: null,
        narrative: { status: "drafted", source: "mock" },
        disclaimer: "Suggestions only.",
      });
    }
    if (p === "/v1/use-cases" && method === "POST") {
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      return json({ id: ID, instance: { id: "instance" } }, 201);
    }
    if (p === `/v1/use-cases/${ID}/overview`) return json(overview);
    if (p === `/v1/use-cases/${ID}`) return json({ useCase: { id: ID, status: "under_review" }, conditions: [], reviews: [], risks: [], discovery: opts.discovery ?? null });
    return json({});
  });
  return sent;
}

test("the finding's id travels from its register link through the intake to the create request", async ({ page }) => {
  const sent = await mock(page);
  await page.goto("/ui/admin/shadow-ai");
  await page.getByRole("link", { name: "Register as use case" }).click();
  await expect(page).toHaveURL(new RegExp(`findingId=${FINDING}`));
  await expect(page.getByLabel("Use-case name")).toHaveValue("Govern acme/credit-memo-assistant");
  await page.getByRole("button", { name: "Continue" }).click();
  for (const [label, value] of [
    ["Primary purpose domain", "essential-services"],
    ["People affected", "customers"],
    ["Decision autonomy", "human-reviews"],
    ["Biometric use", "none"],
    ["Deployment audience", "internal"],
  ] as const) await page.getByLabel(label).selectOption(value);
  await page.getByLabel("Sectors: Financial services", { exact: true }).check();
  await page.getByLabel("Data categories: Financial", { exact: true }).check();
  for (const [label, value] of [
    ["Emotion recognition", "no"],
    ["Social scoring", "no"],
    ["Manipulative techniques", "no"],
    ["Profiles natural persons", "yes"],
    ["Safety component", "no"],
    ["Interacts directly with people", "no"],
    ["Generates synthetic content", "yes"],
    ["Has an EU nexus", "yes"],
    ["Can take autonomous actions", "no"],
    ["Uses an external AI vendor", "yes"],
  ] as const) await page.getByLabel(label).selectOption(value);
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await page.getByRole("button", { name: /Accept all remaining/ }).click();
  for (const next of ["Questionnaire", "Link stack", "Review"] as const) {
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator(`[aria-current="step"]`)).toContainText(next);
  }
  await expect(page.getByText("the use case keeps a link to the finding")).toBeVisible();
  await page.getByRole("button", { name: "Submit for human review" }).click();
  await expect(page.getByRole("link", { name: "Open the use-case workspace" })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.discoveryFindingId).toBe(FINDING);
});

test("an intake not opened from a finding sends no finding", async ({ page }) => {
  await mock(page);
  await page.goto(`/ui/admin/governance/intake?findingId=${FINDING}&title=Plain`);
  await expect(page.getByRole("button", { name: "Fill in an example" })).toBeVisible();
  await expect(page.getByText("Prefilled from a shadow-AI finding")).toHaveCount(0);
});

test("G1: the record says it was found by discovery, and an admin can follow the link back", async ({ page }) => {
  await mock(page, { discovery: { findingId: FINDING, finding: { id: FINDING, subject: "acme/credit-memo-assistant", subjectKind: "repo", provider: "Unregistered AI", firstSeenAt: "2026-10-01" } } });
  await page.goto(`/ui/admin/governance/use-cases/${ID}`);
  const chip = page.getByTestId("use-case-found-by");
  await expect(chip).toHaveText(/Found by\s*discovery/);
  await chip.getByRole("link", { name: /open the Shadow-AI discovery findings \(this use case came from acme\/credit-memo-assistant\)/ }).click();
  await expect(page).toHaveURL(/\/ui\/admin\/shadow-ai\?tab=findings/);
});

test("G1: without the finding's details (a deleted finding) the line has no link; a record not found by discovery has none", async ({ page }) => {
  await mock(page, { discovery: { findingId: FINDING, finding: null } });
  await page.goto(`/ui/admin/governance/use-cases/${ID}`);
  await expect(page.getByTestId("use-case-found-by")).toHaveText(/Found by\s*discovery/);
  await expect(page.getByTestId("use-case-found-by").getByRole("link")).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, { discovery: null });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Govern acme/credit-memo-assistant" })).toBeVisible();
  await expect(page.getByTestId("use-case-found-by")).toHaveCount(0);
});

test("a finding already registered shows its use case instead of the register link", async ({ page }) => {
  await mock(page);
  await page.goto("/ui/admin/shadow-ai");
  await expect(page.getByRole("link", { name: "Register as use case" })).toHaveCount(1);
  await page.getByRole("link", { name: "Govern acme/claims-triage" }).click();
  await expect(page).toHaveURL(new RegExp(`/ui/admin/governance/use-cases/${ID}`));
});
