/**
 * ADR-0168 amendment (2026-10-03, afternoon) from the browser's side, every
 * /v1 and /auth call answered by an in-test mock of the phase-2 contract:
 *
 *  - the review policy settings page: roles + members, required reviews per
 *    tier with the approval lifetime, risk acceptors — exact PUT body;
 *  - the review panel: which review this is ("1 of 3 reviews"), the other
 *    reviews' status, a role member deciding, and a risk acceptor accepting
 *    residual risk (exact decide body; refusals inline);
 *  - the use-case record: one sign-off row per required review, accepted
 *    risks, "Re-review: approval expired <date>", "Update and resubmit";
 *  - resubmit mode of the registration screen: prefilled, return reason on
 *    top, exact PATCH + new questionnaire version, lands on the record, and a
 *    retry never PATCHes twice;
 *  - the registry's Re-review chip and the preview's resubmit action;
 *  - axe (WCAG 2.x A/AA) in BOTH themes, and keyboard paths.
 *
 * Set G2_SHOTS_DIR to also save light + dark screenshots of each screen.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SHOTS = process.env.G2_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const UC = "11111111-1111-4111-8111-111111111111";
const INST = "44444444-4444-4444-8444-444444444444";
const AP = "55555555-5555-4555-8555-555555555555";
const AP_SEC = "56555555-5555-4555-8555-555555555555";
const AP_MR = "57555555-5555-4555-8555-555555555555";
const RISK = "33333333-3333-4333-8333-333333333333";
const RISK2 = "34333333-3333-4333-8333-333333333333";
const RECERT = "66666666-1111-4111-8111-111111111111";

type Persona = { id: string; isAdmin: boolean; displayName: string };
const RILEY: Persona = { id: "riley", isAdmin: true, displayName: "Riley Reviewer" };
const PAT: Persona = { id: "pat", isAdmin: false, displayName: "Pat Privacy" };

const PEOPLE = [
  { id: "ada", name: "Ada Owner" }, { id: "avery", name: "Avery Approver" }, { id: "riley", name: "Riley Reviewer" },
  { id: "pat", name: "Pat Privacy" }, { id: "sam", name: "Sam Security" }, { id: "mo", name: "Mo Risk" }, { id: "lee", name: "Lee Legal" },
];

const savedPolicy = () => ({
  roles: [
    { id: "privacy", name: "Privacy", memberUserIds: ["riley", "pat"] },
    { id: "security", name: "Security", memberUserIds: ["sam"] },
    { id: "model-risk", name: "Model risk", memberUserIds: ["mo"] },
  ],
  tiers: { high: { roleIds: ["privacy", "security", "model-risk"], validityMonths: 6 }, limited: { roleIds: ["security"], validityMonths: 12 } },
  riskAcceptorUserIds: ["riley"],
  updatedAt: "2026-10-02T10:00:00Z",
  updatedByName: "Ada Owner",
});

const ANSWERS = {
  purposeDomain: "essential-services",
  affectedPersons: ["customers"],
  decisionAutonomy: "human-reviews",
  biometricUse: "none",
  emotionRecognition: false,
  socialScoring: false,
  manipulativeTechniques: false,
  profilesNaturalPersons: true,
  safetyComponent: false,
  interactsWithHumans: true,
  generatesSyntheticContent: true,
};
/** every Classify answer, as the gateway stores them at registration */
const FULL = {
  ...ANSWERS,
  sectors: ["financial-services"],
  dataCategories: ["personal", "financial"],
  deployment: "customer-facing",
  euNexus: true,
  usesExternalVendor: false,
  generative: true,
  autonomousActions: false,
  toolsUsed: [],
};
const block = (answers: typeof ANSWERS) => "```eu-ai-act-answers\n" + JSON.stringify(answers, null, 2) + "\n```";
const QUESTIONNAIRE = [
  "## 1. Purpose and business context", "", "Recommends credit-limit increases with human review.", "",
  "## 6. Risks and mitigations", "", "Disparate outcomes across groups; human review of every recommendation.", "",
  "## 9. EU AI Act risk screening", "", block(ANSWERS),
].join("\n");

const NAME = "Credit-limit-increase assistant";
const PURPOSE = "Recommends credit-limit increases with human review.";
const CONTEXT = "Improve customer service while keeping lending decisions accountable.";
const REASON = "Attach the DPIA reference and say who reviews each recommendation.";

const reviews = () => [
  { roleId: "privacy", roleName: "Privacy", status: "pending", deciderName: null, decidedAt: null, approvalId: AP },
  { roleId: "security", roleName: "Security", status: "approved", deciderName: "Sam Security", decidedAt: "2026-10-02T12:00:00Z", approvalId: AP_SEC },
  { roleId: "model-risk", roleName: "Model risk", status: "pending", deciderName: null, decidedAt: null, approvalId: AP_MR },
];

const roleApproval = () => ({
  id: AP, status: "pending", objectType: "workflow", stageId: "signoff", requestedAt: "2026-10-02T09:00:05Z", userId: "ada", approverUserId: "avery", instanceId: INST,
  requestedByName: "Ada Owner", approverName: "Avery Approver", objectLabel: `AI use-case intake: ${NAME}`, selfReview: false,
  useCaseId: UC, reviewRole: { id: "privacy", name: "Privacy" }, assignment: { assigneeKind: "role", slaState: "ok", dueAt: "2026-10-06T17:00:00Z" },
});

const overview = (status: string) => ({
  useCase: { id: UC, name: NAME, description: PURPOSE, businessContext: CONTEXT, status, euAiActTier: "high", ownerName: "Ada Owner", ownerUserId: "ada", workflowInstanceId: INST, complianceTags: ["eu-ai-act"] },
  screening: { tier: "high", reasons: [{ reason: "Access to essential financial services and profiling of natural persons." }], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "art", version: 2, submittedAt: "2026-10-02T09:00:00Z" },
  stack: { agents: [], vendors: [] },
  risks: [
    { id: RISK, title: "Disparate credit recommendation outcomes", category: "bias_fairness", dimension: "bias", status: "mitigating", inherent: { likelihood: "medium", impact: "high" }, residual: { likelihood: "low", impact: "medium" }, controls: [{ controlRef: "eu-ai-act:art-14-human-oversight", title: "Human oversight", linkedAt: "2026-10-02" }] },
    { id: RISK2, title: "Stale income data", category: "data_quality", dimension: "data", status: "open", inherent: { likelihood: "medium", impact: "medium" }, residual: null, controls: [] },
  ],
  summary: { risks: 2, liveRisks: 2, liveWithoutControls: 1, agentsWithoutApprovedModelCard: 0, pendingApprovals: 2 },
  approvals: [{ id: AP, status: "pending", stageId: "signoff", approverUserId: "avery", requestedAt: "2026-10-02T09:00:05Z", decidedAt: null, decisionReason: null }],
  audit: [],
});

interface State {
  persona: Persona;
  status: string;
  reviews: unknown[];
  acceptedRisk: boolean;
  recertification: boolean;
  resubmission: boolean;
  policy: ReturnType<typeof savedPolicy>;
  approvals: unknown[];
  calls: string[];
  puts: unknown[];
  putReply: { status: number; body: unknown } | null;
  decides: Array<{ id: string; body: unknown }>;
  decideReply: { status: number; body: unknown } | null;
  patches: unknown[];
  artifacts: unknown[];
  artifactFailures: number;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const listRow = (over: Record<string, unknown>) => ({
  description: "", businessContext: "", ownerUserId: "ada", ownerName: "Ada Owner", intendedAgentIds: [], dataSensitivity: "internal", complianceTags: [], projectId: null,
  workflowInstanceId: INST, euAiActTier: "high", decidedAt: null, retiredReason: null, approvedUntil: null, openConditions: 0, createdAt: "2026-10-01T09:00:00Z", recertification: false, recertificationDueAt: null, ...over,
});

function detail(state: State) {
  const useCase = {
    ...listRow({ id: UC, name: NAME, description: PURPOSE, businessContext: CONTEXT, status: state.status, dataSensitivity: "regulated", complianceTags: ["eu-ai-act"] }),
    approvedAt: state.recertification ? "2026-03-01T00:00:00Z" : null,
    approvedUntil: state.recertification ? "2026-09-01T00:00:00Z" : null,
    approvalExpired: state.recertification,
    recertification: state.recertification,
    recertificationDueAt: state.recertification ? "2026-09-01T00:00:00Z" : null,
  };
  return {
    useCase,
    instance: { id: INST, status: state.status === "needs_info" ? "blocked_on_artifact" : "blocked_on_approval", currentStageId: "signoff", stages: [{ id: "questionnaire", type: "artifact_generation" }, { id: "signoff", type: "human_approval" }] },
    questionnaire: { version: 2, content: QUESTIONNAIRE, createdAt: "2026-10-02T09:00:00Z" },
    questionnaireTemplate: null,
    cascadeConsequences: { profiles: [], unrecognizedTags: [], combined: null, project: null, note: "" },
    euAiActScreening: { tier: "high", reasons: [], rulesetVersion: 1, disclaimer: "Screening, not legal advice.", answersStatus: "ok", answersError: null, refusal: null },
    intendedVsGranted: { status: "no_intent_recorded", note: "" },
    conditions: [],
    reviews: state.reviews,
    risks: [
      { id: RISK, title: "Disparate credit recommendation outcomes", status: state.acceptedRisk ? "accepted" : "mitigating", acceptedByName: state.acceptedRisk ? "Riley Reviewer" : null, acceptedAt: state.acceptedRisk ? "2026-10-03T09:30:00Z" : null, acceptanceRationale: state.acceptedRisk ? "Residual bias is tolerable with human review of every recommendation." : null },
      { id: RISK2, title: "Stale income data", status: "open", acceptedByName: null, acceptedAt: null, acceptanceRationale: null },
    ],
    resubmission: state.resubmission
      ? { allowed: true, screeningAnswers: FULL, questionnaire: { version: 2, content: QUESTIONNAIRE }, returnReason: REASON, returnedByName: "Avery Approver" }
      : { allowed: false, screeningAnswers: null, questionnaire: null, returnReason: null, returnedByName: null },
  };
}

async function mockGateway(page: Page, patch: Partial<State> = {}): Promise<State> {
  const state: State = {
    persona: RILEY, status: "under_review", reviews: reviews(), acceptedRisk: false, recertification: false, resubmission: false, policy: savedPolicy(),
    approvals: [roleApproval()], calls: [], puts: [], putReply: null, decides: [], decideReply: null, patches: [], artifacts: [], artifactFailures: 0, ...patch,
  };
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    const me = state.persona;
    if (method !== "GET") state.calls.push(`${method} ${p}`);
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, via: "session", user: { id: me.id, email: `${me.id}@example.test`, displayName: me.displayName }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, user: { id: me.id, email: `${me.id}@example.test`, displayName: me.displayName } });
    if (p === "/v1/governance/review-policy" && method === "GET") return json(route, state.policy);
    if (p === "/v1/governance/review-policy" && method === "PUT") {
      const body = route.request().postDataJSON();
      state.puts.push(body);
      if (state.putReply) return json(route, state.putReply.body, state.putReply.status);
      state.policy = { ...body, updatedAt: "2026-10-03T15:00:00Z", updatedByName: me.displayName };
      return json(route, state.policy);
    }
    if (p === "/v1/users/directory") return json(route, { users: PEOPLE.map((u) => ({ ...u, teams: [] })) });
    if (p === "/v1/approvals") return json(route, { approvals: state.approvals });
    if (p.startsWith("/v1/approvals/") && p.endsWith("/decide") && method === "POST") {
      state.decides.push({ id: p.split("/")[3]!, body: route.request().postDataJSON() });
      if (state.decideReply) return json(route, state.decideReply.body, state.decideReply.status);
      return json(route, { ok: true });
    }
    if (p === `/v1/workflows/instances/${INST}/artifacts` && method === "POST") {
      state.artifacts.push(route.request().postDataJSON());
      if (state.artifactFailures > 0) {
        state.artifactFailures -= 1;
        return json(route, { error: "unavailable", detail: "the workflow store is briefly unavailable" }, 503);
      }
      state.status = "under_review";
      return json(route, { id: "art3", version: 3 }, 201);
    }
    if (p === `/v1/workflows/instances/${INST}`) return json(route, { instance: { id: INST, status: "blocked_on_approval", createdAt: "2026-10-02T09:00:00Z", initiatorUserId: "ada", change: { description: `AI use-case intake: ${NAME}`, changeType: "ai-use-case-intake" }, definition: { stages: [{ id: "questionnaire", type: "artifact_generation", output: "use_case_questionnaire" }, { id: "signoff", type: "human_approval" }] }, state: { currentStageIndex: 1, stageStatuses: {} }, context: {} }, artifacts: [{ id: "art", output: "use_case_questionnaire", version: 2, content: QUESTIONNAIRE }] });
    if (p.startsWith("/v1/workflows/instances/")) return json(route, { error: "not_found" }, 404);
    if (p === "/v1/use-cases" && method === "GET") {
      return json(route, { useCases: [
        listRow({ id: UC, name: NAME, description: PURPOSE, status: state.status }),
        listRow({ id: RECERT, name: "Fraud scoring model", description: "Scores card transactions.", status: "under_review", approvedUntil: "2026-09-01T00:00:00Z", recertification: true, recertificationDueAt: "2026-09-01T00:00:00Z" }),
        listRow({ id: "77777777-1111-4111-8111-111111111111", name: "Ticket summarizer", status: "approved", euAiActTier: "minimal", approvedUntil: "2027-08-20T09:00:00Z" }),
      ] });
    }
    if (p === `/v1/use-cases/${UC}/overview`) return me.isAdmin ? json(route, overview(state.status)) : json(route, { error: "forbidden" }, 403);
    if (p === `/v1/use-cases/${UC}` && method === "PATCH") {
      state.patches.push(route.request().postDataJSON());
      return json(route, { useCase: detail(state).useCase });
    }
    if (p === `/v1/use-cases/${UC}`) return json(route, detail(state));
    if (p === `/v1/use-cases/${RECERT}`) return json(route, { ...detail({ ...state, recertification: true }), useCase: { ...detail({ ...state, recertification: true }).useCase, id: RECERT, name: "Fraud scoring model" } });
    return json(route, {});
  });
  return state;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** axe in both themes over the page (or one region), and (with G2_SHOTS_DIR) a shot of each */
async function checkScreen(page: Page, label: string, shot?: string, include?: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const results = await builder.analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on "${label}" (${theme})`).toEqual([]);
    if (SHOTS && shot) {
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, `${shot}-${theme}.png`), fullPage: !include });
    }
  }
  await setTheme(page, "light");
}

const focusedName = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return "";
  const labelled = el.getAttribute("aria-label") ?? (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ?? el.closest("label")?.textContent ?? el.textContent ?? "";
  return labelled.trim();
});

async function tabTo(page: Page, name: string | RegExp, max = 60) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press("Tab");
    const now = await focusedName(page);
    if (typeof name === "string" ? now === name : name.test(now)) return;
  }
  throw new Error(`Tab never reached ${String(name)}`);
}

// ---------------------------------------------------------------------------

test.describe("review policy settings", () => {
  test("loads the saved policy, edits roles, tiers and acceptors, and PUTs exactly the contract", async ({ page }) => {
    const state = await mockGateway(page);
    await page.goto("/ui/admin/governance/review-policy");
    await expect(page.getByRole("heading", { level: 1, name: "Review policy" })).toBeVisible();
    // the nav entry sits with the other AI Governance items
    await expect(page.getByRole("link", { name: "Review policy" }).first()).toHaveAttribute("href", "/ui/admin/governance/review-policy");
    await expect(page.getByText("Each role listed is one required review.", { exact: false })).toBeVisible();
    await expect(page.getByText("Last changed 2 Oct 2026 by Ada Owner.")).toBeVisible();
    const privacy = page.getByRole("listitem", { name: "Privacy" });
    await expect(privacy.getByRole("button", { name: "Remove Pat Privacy from Privacy" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Required reviews for the high tier" }).getByRole("checkbox", { name: "Model risk" })).toBeChecked();
    await expect(page.getByRole("group", { name: "Required reviews for the high tier" })).toContainText("3 required reviews");
    await expect(page.getByRole("group", { name: "Required reviews for the minimal tier" })).toContainText("One named approver");
    await checkScreen(page, "review policy", "review-policy");

    // a new role, required by the high tier
    await page.getByRole("button", { name: "+ Add role" }).click();
    await expect(page.getByLabel("Role name").last()).toBeFocused();
    await page.getByLabel("Role name").last().fill("Legal");
    await page.getByRole("combobox", { name: "Add a person to Legal" }).selectOption({ label: "Lee Legal" });
    await page.getByRole("group", { name: "Required reviews for the high tier" }).getByRole("checkbox", { name: "Legal" }).check();
    // Pat leaves Privacy; Security no longer required for limited, which keeps its own lifetime
    await privacy.getByRole("button", { name: "Remove Pat Privacy from Privacy" }).click();
    await page.getByRole("group", { name: "Required reviews for the limited tier" }).getByRole("checkbox", { name: "Security" }).uncheck();
    await page.getByLabel("Limited tier: approval valid for (months)").fill("9");
    await page.getByLabel("Minimal tier: approval valid for (months)").fill("24");
    await page.getByRole("combobox", { name: "Add a person to risk acceptors" }).selectOption({ label: "Mo Risk" });
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect.poll(() => state.puts.length).toBe(1);
    expect(state.puts[0]).toEqual({
      roles: [
        { id: "privacy", name: "Privacy", memberUserIds: ["riley"] },
        { id: "security", name: "Security", memberUserIds: ["sam"] },
        { id: "model-risk", name: "Model risk", memberUserIds: ["mo"] },
        { id: "legal", name: "Legal", memberUserIds: ["lee"] },
      ],
      tiers: {
        minimal: { roleIds: [], validityMonths: 24 },
        limited: { roleIds: [], validityMonths: 9 },
        high: { roleIds: ["privacy", "security", "model-risk", "legal"], validityMonths: 6 },
      },
      riskAcceptorUserIds: ["riley", "mo"],
    });
    await expect(page.getByText("Last changed 3 Oct 2026 by Riley Reviewer.")).toBeVisible();
  });

  test("validation refuses before anything is sent; a gateway refusal is shown on the page", async ({ page }) => {
    const state = await mockGateway(page);
    await page.goto("/ui/admin/governance/review-policy");
    await page.getByRole("button", { name: "+ Add role" }).click();
    await page.getByRole("button", { name: "+ Add role" }).click();
    await page.getByLabel("Role name").nth(4).fill("Privacy!");
    await page.getByRole("group", { name: "Required reviews for the high tier" }).getByRole("checkbox", { name: "Privacy!" }).check();
    await page.getByLabel("High tier: approval valid for (months)").fill("40");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Fix the highlighted fields, then save.")).toBeVisible();
    await expect(page.getByText("Name the role.")).toBeVisible();
    await expect(page.getByText("Another role already has this name.")).toBeVisible();
    await expect(page.getByText("Add at least one member: the high tier requires this review.")).toBeVisible();
    await expect(page.getByText("Enter whole months from 1 to 36.")).toBeVisible();
    await expect(page.getByLabel("Role name").nth(3)).toBeFocused();
    expect(state.puts).toEqual([]);
    await checkScreen(page, "review policy with errors", "review-policy-errors");

    // fixed, then refused by the gateway: the reason stays on the page
    await page.getByRole("button", { name: "Remove role Role 4" }).click();
    await page.getByRole("button", { name: "Remove role Privacy!" }).click();
    await page.getByLabel("High tier: approval valid for (months)").fill("6");
    state.putReply = { status: 422, body: { error: "role_without_members", detail: "role security has no members" } };
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The policy was not saved" })).toContainText("role security has no members");
    expect(state.puts).toHaveLength(1);
  });

  test("keyboard: add a role and land on its name; remove a member and land on the picker", async ({ page }) => {
    await mockGateway(page);
    await page.goto("/ui/admin/governance/review-policy");
    await page.getByRole("button", { name: "+ Add role" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Role name").last()).toBeFocused();
    await page.keyboard.type("Legal");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: "Add a person to Legal" })).toBeFocused();
    await page.getByRole("button", { name: "Remove Pat Privacy from Privacy" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Remove Pat Privacy from Privacy" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Add a person to Privacy" })).toBeFocused();
  });
});

// ---------------------------------------------------------------------------

async function openReview(page: Page): Promise<Locator> {
  await page.goto("/ui/inbox");
  await page.getByRole("button", { name: `Review sign-off for ${NAME}` }).click();
  const drawer = page.getByRole("dialog", { name: "Review use case sign-off" });
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("the review panel in a review round", () => {
  test("names the review and the round, and a risk acceptor accepts residual risk on approval", async ({ page }) => {
    const state = await mockGateway(page);
    const drawer = await openReview(page);
    await expect(drawer.getByText("Privacy review", { exact: true })).toBeVisible();
    await expect(drawer.getByText("· 1 of 3 reviews")).toBeVisible();
    await expect(drawer.getByText("Any member of Privacy (you are one)")).toBeVisible();
    const others = drawer.getByRole("list", { name: "Other reviews" });
    await expect(others.getByRole("listitem").filter({ hasText: "Security" })).toContainText("Approved");
    await expect(others.getByRole("listitem").filter({ hasText: "Security" })).toContainText("Sam Security, 2 Oct 2026");
    await expect(others.getByRole("listitem").filter({ hasText: "Model risk" })).toContainText("Awaiting decision");
    // not offered until the decision approves
    await expect(drawer.getByRole("checkbox", { name: "Accept residual risk" })).toHaveCount(0);
    await drawer.getByRole("radio", { name: "Approve", exact: true }).check();
    // a role member decides in their own right: no recorded reason demanded
    await expect(drawer.getByLabel("Reason (optional)")).toBeVisible();
    await drawer.getByRole("checkbox", { name: "Accept residual risk" }).check();
    await drawer.getByRole("checkbox", { name: /Disparate credit recommendation outcomes/ }).check();
    await drawer.getByLabel("Why the residual risk is acceptable (required)").fill("Residual bias is tolerable with human review of every recommendation.");
    await checkScreen(page, "review panel with risk acceptance", "review-panel-acceptance", '[role="dialog"]');
    await drawer.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => state.decides.length).toBe(1);
    expect(state.decides[0]).toEqual({
      id: AP,
      body: { decision: "approved", acceptRisks: { riskIds: [RISK], rationale: "Residual bias is tolerable with human review of every recommendation." } },
    });
    await expect(drawer).toBeHidden();
  });

  test("another review the round closed reads Closed in the other-reviews list", async ({ page }) => {
    await mockGateway(page, {
      reviews: [
        { roleId: "privacy", roleName: "Privacy", status: "pending", deciderName: null, decidedAt: null, approvalId: AP },
        { roleId: "security", roleName: "Security", status: "superseded", deciderName: null, decidedAt: null, approvalId: AP_SEC },
        { roleId: "model-risk", roleName: "Model risk", status: "denied", deciderName: "Mo Risk", decidedAt: "2026-10-02T12:00:00Z", approvalId: AP_MR },
      ],
    });
    const drawer = await openReview(page);
    const others = drawer.getByRole("list", { name: "Other reviews" });
    await expect(others.getByRole("listitem").filter({ hasText: "Security" })).toContainText("Closed — another review ended the round");
    await expect(others.getByRole("listitem").filter({ hasText: "Model risk" })).toContainText("Rejected");
    await checkScreen(page, "review panel with a closed review", undefined, '[role="dialog"]');
  });

  test("a role member who is not a risk acceptor decides without the acceptance (control)", async ({ page }) => {
    const state = await mockGateway(page, { persona: PAT });
    const drawer = await openReview(page);
    await expect(drawer.getByText("Any member of Privacy (you are one)")).toBeVisible();
    await drawer.getByRole("radio", { name: "Approve", exact: true }).check();
    await expect(drawer.getByRole("checkbox", { name: "Accept residual risk" })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => state.decides.length).toBe(1);
    expect(state.decides[0]).toEqual({ id: AP, body: { decision: "approved" } });
  });

  test("an acceptance needs a risk and a rationale before anything is sent; a refusal is shown inline", async ({ page }) => {
    const state = await mockGateway(page, { decideReply: { status: 403, body: { error: "not_a_risk_acceptor" } } });
    const drawer = await openReview(page);
    await drawer.getByRole("radio", { name: "Approve with conditions", exact: true }).check();
    const one = drawer.getByRole("group", { name: "Condition 1" });
    await one.getByLabel("Condition", { exact: true }).fill("Attach the DPIA reference");
    await one.getByLabel("Due date").fill("2026-11-01");
    await drawer.getByRole("checkbox", { name: "Accept residual risk" }).check();
    await drawer.getByLabel("Why the residual risk is acceptable (required)").fill("Fine");
    await drawer.getByRole("button", { name: "Approve with conditions", exact: true }).click();
    await expect(drawer.getByText("Choose at least one risk to accept.")).toBeVisible();
    await expect(drawer.getByText("Say why the residual risk is acceptable — at least 10 characters.")).toBeVisible();
    // focus lands on the first problem
    await expect(drawer.getByText("Choose at least one risk to accept.")).toBeFocused();
    expect(state.decides).toEqual([]);
    await checkScreen(page, "review panel acceptance errors", undefined, '[role="dialog"]');

    await drawer.getByRole("checkbox", { name: /Stale income data/ }).check();
    await drawer.getByLabel("Why the residual risk is acceptable (required)").fill("Income data refreshes monthly; the gap is tolerable.");
    await drawer.getByRole("button", { name: "Approve with conditions", exact: true }).click();
    await expect.poll(() => state.decides.length).toBe(1);
    expect(state.decides[0]).toEqual({
      id: AP,
      body: {
        decision: "approved",
        conditions: [{ text: "Attach the DPIA reference", dueAt: "2026-11-01", blocking: true }],
        acceptRisks: { riskIds: [RISK2], rationale: "Income data refreshes monthly; the gap is tolerable." },
      },
    });
    await expect(drawer.getByRole("alert").filter({ hasText: "not named as a risk acceptor" })).toBeVisible();
    await expect(drawer).toBeVisible();
  });

  test("keyboard: the acceptance is reachable and operable from the keyboard inside the drawer", async ({ page }) => {
    await mockGateway(page);
    await page.goto("/ui/inbox");
    const trigger = page.getByRole("button", { name: `Review sign-off for ${NAME}` });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Review use case sign-off" });
    await expect(drawer.getByRole("heading", { name: "Review use case sign-off" })).toBeFocused();
    await drawer.getByRole("radio", { name: "Approve", exact: true }).focus();
    await page.keyboard.press("Space");
    await tabTo(page, "Accept residual risk");
    await page.keyboard.press("Space");
    await expect(drawer.getByRole("checkbox", { name: "Accept residual risk" })).toBeChecked();
    await tabTo(page, /Disparate credit recommendation outcomes/);
    await page.keyboard.press("Space");
    await expect(drawer.getByRole("checkbox", { name: /Disparate credit recommendation outcomes/ })).toBeChecked();
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

// ---------------------------------------------------------------------------

test.describe("the use-case record in a review round", () => {
  test("one sign-off row per required review, and accepted risks read who accepted them and why", async ({ page }) => {
    await mockGateway(page, { acceptedRisk: true });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
    const tracker = page.locator("section", { has: page.getByText("Lifecycle tracker", { exact: true }) });
    await expect(tracker.getByRole("row").filter({ hasText: "Sign-off:" })).toHaveCount(3);
    await expect(tracker.getByRole("row").filter({ hasText: "Sign-off: Privacy" })).toContainText("Awaiting decision");
    await expect(tracker.getByRole("row").filter({ hasText: "Sign-off: Privacy" })).toContainText("Awaiting a member of Privacy · review 1 of 3");
    const security = tracker.getByRole("row").filter({ hasText: "Sign-off: Security" });
    await expect(security).toContainText("Complete");
    await expect(security).toContainText("Approved by Sam Security · review 2 of 3");
    await expect(tracker.getByRole("row").filter({ hasText: "Sign-off: Model risk" })).toContainText("Model risk reviewers");
    const accepted = page.locator("section", { has: page.getByText("Accepted risks", { exact: true }) });
    await expect(accepted).toContainText("Disparate credit recommendation outcomes");
    await expect(accepted).toContainText("Accepted by Riley Reviewer on 3 Oct 2026 · Residual bias is tolerable with human review of every recommendation.");
    await expect(accepted).not.toContainText("Stale income data");
    await checkScreen(page, "record with a review round", "record-review-round");
    await page.getByRole("tab", { name: "Risks" }).click();
    await expect(page.getByText("Accepted by Riley Reviewer on 3 Oct 2026 · Residual bias is tolerable", { exact: false })).toBeVisible();
  });

  test("a review closed by another role's send-back reads Closed, not awaiting", async ({ page }) => {
    await mockGateway(page, {
      status: "needs_info",
      resubmission: true,
      reviews: [
        { roleId: "privacy", roleName: "Privacy", status: "returned", deciderName: "Riley Reviewer", decidedAt: "2026-10-02T13:00:00Z", approvalId: AP },
        { roleId: "security", roleName: "Security", status: "approved", deciderName: "Sam Security", decidedAt: "2026-10-02T12:00:00Z", approvalId: AP_SEC },
        { roleId: "model-risk", roleName: "Model risk", status: "superseded", deciderName: null, decidedAt: null, approvalId: AP_MR },
      ],
    });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    const tracker = page.locator("section", { has: page.getByText("Lifecycle tracker", { exact: true }) });
    const closed = tracker.getByRole("row").filter({ hasText: "Sign-off: Model risk" });
    await expect(closed).toContainText("Closed — another review ended the round · review 3 of 3");
    await expect(closed).not.toContainText("Awaiting");
    await expect(tracker.getByRole("row").filter({ hasText: "Sign-off: Privacy" })).toContainText("Sent back by Riley Reviewer");
    await checkScreen(page, "record with a closed review", "record-review-closed");
  });

  test("a recertification reads Re-review with the expiry date on the band and the tracker", async ({ page }) => {
    await mockGateway(page, { recertification: true });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    await expect(page.getByRole("list", { name: "Record status" })).toContainText("Re-review: approval expired 1 Sep 2026");
    await expect(page.getByRole("list", { name: "Record status" })).not.toContainText("Approval valid until");
    await expect(page.locator("section", { has: page.getByText("Lifecycle tracker", { exact: true }) }).getByText("Re-review: approval expired 1 Sep 2026")).toBeVisible();
    await expect(page.getByRole("list", { name: "Lifecycle" }).locator('[aria-current="step"]')).toContainText("Under review");
    await expect(page.getByText(/so the use case is back in review/)).toBeVisible();
    await checkScreen(page, "record in re-review", "record-re-review");
  });

  test("a use case sent back shows the reason and one primary action: Update and resubmit", async ({ page }) => {
    await mockGateway(page, { status: "needs_info", resubmission: true, reviews: [] });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    const resubmit = page.getByRole("link", { name: "Update and resubmit" });
    await expect(resubmit).toHaveAttribute("href", `/ui/admin/governance/intake?resubmit=${UC}`);
    await expect(page.getByRole("note").filter({ hasText: "Sent back for information by Avery Approver." })).toContainText(REASON);
    const tracker = page.locator("section", { has: page.getByText("Lifecycle tracker", { exact: true }) });
    await expect(tracker.getByRole("link", { name: "Update questionnaire" })).toHaveAttribute("href", `/ui/admin/governance/intake?resubmit=${UC}`);
    await checkScreen(page, "record sent back", "record-needs-info");
  });
});

// ---------------------------------------------------------------------------

test.describe("update and resubmit", () => {
  test("prefilled from the record, reason on top; PATCHes what changed, posts a new version, lands on the record", async ({ page }) => {
    const state = await mockGateway(page, { status: "needs_info", resubmission: true, reviews: [] });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    await page.getByRole("link", { name: "Update and resubmit" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/admin/governance/intake\\?resubmit=${UC}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Update and resubmit" })).toBeVisible();
    await expect(page.getByRole("note", { name: "Why it was sent back" })).toContainText(`Sent back for information by Avery Approver. ${REASON}`);
    await expect(page.getByLabel("Use-case name")).toHaveValue(NAME);
    await expect(page.getByLabel("Use-case name")).not.toBeEditable(); // a registered use case keeps its name
    await expect(page.getByLabel("What will the system do?")).toHaveValue(PURPOSE);
    await expect(page.getByLabel("Business context")).toHaveValue(CONTEXT);
    await checkScreen(page, "resubmit: describe", "resubmit-describe");
    const purpose = "Recommends credit-limit increases; a credit officer reviews every recommendation.";
    await page.getByLabel("What will the system do?").fill(purpose);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Check the screening answers" })).toBeFocused();
    await expect(page.getByLabel("Primary purpose domain")).toHaveValue("essential-services");
    await expect(page.getByLabel("People affected")).toHaveValue("customers");
    await expect(page.getByLabel("Profiles natural persons")).toHaveValue("yes");
    await expect(page.getByLabel("Social scoring")).toHaveValue("no");
    // the context answers are prefilled too
    await expect(page.getByLabel("Deployment audience")).toHaveValue("customer-facing");
    await expect(page.getByLabel("Has an EU nexus")).toHaveValue("yes");
    await expect(page.getByLabel("Can take autonomous actions")).toHaveValue("no");
    await expect(page.getByRole("checkbox", { name: "Data categories: Financial" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Sectors: Financial services" })).toBeChecked();
    await page.getByLabel("Decision autonomy").selectOption("informs-human");
    await page.getByRole("checkbox", { name: "Data categories: Financial" }).uncheck();
    await checkScreen(page, "resubmit: classify");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Update the questionnaire" })).toBeFocused();
    const risks = page.getByLabel("6. Risks and mitigations");
    await expect(risks).toHaveValue("Disparate outcomes across groups; human review of every recommendation.");
    await risks.fill("Disparate outcomes across groups; DPIA DP-2026-114 covers them; a credit officer reviews every recommendation.");
    await expect(page.getByLabel("9. EU AI Act risk screening")).toHaveValue(/"decisionAutonomy": "informs-human"/);
    await checkScreen(page, "resubmit: questionnaire", "resubmit-questionnaire");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Review and resubmit" })).toBeFocused();
    await expect(page.getByText("Changed — the tier is screened again")).toBeVisible();
    // personal only → confidential (was regulated with financial)
    await expect(page.getByRole("main")).toContainText("was Regulated; from the data categories");
    await expect(page.getByText("Version 3, 1 section changed")).toBeVisible();
    await checkScreen(page, "resubmit: review", "resubmit-review");
    await page.getByRole("button", { name: "Resubmit for review" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/admin/governance/use-cases/${UC}$`));

    const changed = { ...ANSWERS, decisionAutonomy: "informs-human" };
    expect(state.calls).toEqual([`PATCH /v1/use-cases/${UC}`, `POST /v1/workflows/instances/${INST}/artifacts`]);
    // every Classify answer goes on the PATCH; the questionnaire block carries the EU ones only
    expect(state.patches).toEqual([{ description: purpose, screeningAnswers: { ...FULL, decisionAutonomy: "informs-human", dataCategories: ["personal"] } }]);
    expect(state.artifacts).toEqual([{
      stageId: "questionnaire",
      content: [
        "## 1. Purpose and business context", "", "Recommends credit-limit increases with human review.", "",
        "## 6. Risks and mitigations", "", "Disparate outcomes across groups; DPIA DP-2026-114 covers them; a credit officer reviews every recommendation.", "",
        "## 9. EU AI Act risk screening", "", block(changed),
      ].join("\n"),
    }]);
  });

  test("a failed questionnaire post is retried without a second PATCH; unchanged answers resubmit as they were", async ({ page }) => {
    const state = await mockGateway(page, { status: "needs_info", resubmission: true, reviews: [], artifactFailures: 1 });
    await page.goto(`/ui/admin/governance/intake?resubmit=${UC}`);
    for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Unchanged", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resubmit for review" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The use case was not resubmitted" })).toContainText("Retry continues where it stopped.");
    await expect(page).toHaveURL(/resubmit=/);
    await page.getByRole("button", { name: "Resubmit for review" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/admin/governance/use-cases/${UC}$`));
    expect(state.patches).toEqual([{ screeningAnswers: FULL }]);
    expect(state.artifacts).toHaveLength(2);
    // nothing edited: the new version is the old document, byte for byte
    expect(state.artifacts[1]).toEqual({ stageId: "questionnaire", content: QUESTIONNAIRE });
  });

  test("keyboard: Continue from the keyboard lands focus on each stage's heading", async ({ page }) => {
    await mockGateway(page, { status: "needs_info", resubmission: true, reviews: [] });
    await page.goto(`/ui/admin/governance/intake?resubmit=${UC}`);
    await page.getByRole("button", { name: "Continue" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Check the screening answers" })).toBeFocused();
    await page.keyboard.press("Tab");
    // from the stage heading, Tab continues into the stage's first question
    await expect(page.getByLabel("Primary purpose domain")).toBeFocused();
  });

  test("a use case that is not waiting for an update cannot be resubmitted", async ({ page }) => {
    const state = await mockGateway(page, { status: "under_review" });
    await page.goto(`/ui/admin/governance/intake?resubmit=${UC}`);
    await expect(page.getByText(`${NAME} is not waiting for an update, so there is nothing to resubmit.`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the use case" })).toHaveAttribute("href", `/ui/admin/governance/use-cases/${UC}`);
    await expect(page.getByRole("button", { name: "Resubmit for review" })).toHaveCount(0);
    expect(state.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

test.describe("the registry", () => {
  test("a Re-review chip filters recertifications, which read Re-review", async ({ page }) => {
    await mockGateway(page);
    await page.goto("/ui/admin/use-cases");
    await expect(page.getByRole("heading", { level: 1, name: "AI registry" })).toBeVisible();
    const chip = page.getByRole("group", { name: "Status" }).getByRole("button", { name: /^Re-review/ });
    await expect(chip).toContainText("1");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    // clickable rows are links named "<name>, <status> — open preview"
    const rows = page.getByRole("link", { name: /— open preview$/ });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAccessibleName("Fraud scoring model, Re-review — open preview");
    await expect(rows.first().getByRole("cell").nth(1)).toHaveText("Re-review");
    await checkScreen(page, "registry re-review filter", "registry-re-review");
    // control: All shows every row, the recertification still reading Re-review
    await page.getByRole("group", { name: "Status" }).getByRole("button", { name: /^All/ }).click();
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole("link", { name: `${NAME}, Under review — open preview` })).toBeVisible();
    await page.getByRole("group", { name: "Status" }).getByRole("button", { name: /^Re-review/ }).click();
    await rows.first().click();
    await expect(page.getByRole("dialog", { name: "Fraud scoring model" })).toContainText("Re-review");
  });

  test("the preview of a use case sent back offers Update and resubmit with the reason", async ({ page }) => {
    await mockGateway(page, { status: "needs_info", resubmission: true, reviews: [] });
    await page.goto("/ui/admin/use-cases");
    await page.getByRole("link", { name: `${NAME}, Needs information — open preview` }).click();
    const preview = page.getByRole("dialog", { name: NAME });
    await expect(preview.getByRole("link", { name: "Update and resubmit" })).toHaveAttribute("href", `/ui/admin/governance/intake?resubmit=${UC}`);
    await expect(preview.getByRole("note")).toContainText(`Sent back by Avery Approver: ${REASON}`);
    await checkScreen(page, "registry preview sent back", "registry-preview-resubmit");
  });
});
