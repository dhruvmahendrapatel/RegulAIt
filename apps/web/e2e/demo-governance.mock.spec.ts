import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "artifacts", "demo");
mkdirSync(SHOTS, { recursive: true });
const ID = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const RISK = "33333333-3333-4333-8333-333333333333";

const trust = {
  generatedAt: "2026-10-02T12:00:00.000Z", window: { start: "2026-09-02", end: "2026-10-02", days: 30 }, scope: { projectId: null, label: "Organization" }, packsEvaluated: [{ framework: "eu-ai-act", version: 2, controls: 12 }],
  dimensions: [
    ["bias", "Bias", true, 64], ["security", "Security", true, 82], ["privacy", "Privacy", true, 71], ["reliability", "Reliability", true, 58], ["safety", "Safety", false, null], ["compliance", "Compliance", true, 76],
  ].map(([key, label, measured, pct]) => ({ key, label, measured, evidenceCoveragePct: pct, controlsEvidenced: measured ? 7 : 0, controlsApplicable: measured ? 10 : 0, risks: { open: 2, mitigating: 1, accepted: 0, closed: 3 } })),
  totals: { risksFound: 31, risksMitigated: 22, risksAccepted: 2, risksOpen: 7, evidenceCoveragePct: 71, controlsEvidenced: 30, controlsApplicable: 42, useCases: { approved: 4 } },
  heatmap: ["low", "medium", "high"].flatMap((likelihood, li) => ["low", "medium", "high"].map((impact, ii) => ({ likelihood, impact, count: li + ii }))),
  residualHeatmap: ["low", "medium", "high"].flatMap((likelihood, li) => ["low", "medium", "high"].map((impact, ii) => ({ likelihood, impact, count: Math.max(0, 3 - li - ii) }))),
  definitions: { evidenceCoveragePct: "Applicable controls with current evidence.", risksMitigated: "Risks with linked controls or residual position.", heatmap: "Open, mitigating, and accepted risks.", measured: "Whether applicable controls are available." },
};

const overview = {
  useCase: { id: ID, name: "Credit-limit-increase assistant", description: "Recommends credit-limit increases with human review.", businessContext: "Improve customer service while preserving accountable lending decisions.", status: "under_review", euAiActTier: "high", ownerName: "Avery Admin", complianceTags: ["eu-ai-act", "nist-ai-rmf", "iso-42001"] },
  screening: { tier: "high", reasons: [{ reason: "Access to essential financial services and profiling of natural persons." }], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: "2026-10-02T12:00:00Z" },
  stack: { agents: [{ id: AGENT, name: "Credit assistant", provider: "mock", model: "mock-balanced", lifecycleStatus: "active", halted: false, modelCards: [{ id: "c", intendedUse: "Credit support", signOff: "approved" }], modelCardApproved: true }], vendors: [{ id: "v", name: "Acme Model Services", category: "model_provider", status: "approved", linkedVia: ["agent provider"] }] },
  risks: [{ id: RISK, title: "Disparate credit recommendation outcomes", category: "bias_fairness", dimension: "bias", status: "mitigating", inherent: { likelihood: "medium", impact: "high" }, residual: { likelihood: "low", impact: "medium" }, controls: [{ controlRef: "eu-ai-act:art-14-human-oversight", title: "Human oversight", linkedAt: "2026-10-02" }] }],
  summary: { risks: 1, liveRisks: 1, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: 1 },
  approvals: [{ id: "ap", status: "pending", stageId: "signoff", approverUserId: null, requestedAt: "2026-10-02T12:00:00Z", decidedAt: null, decisionReason: null }],
  audit: [{ id: 1, at: "2026-10-02T12:00:00Z", userId: "u", ruleId: "use-case-questionnaire-submitted", effect: "allow", reason: "Questionnaire submitted for review" }],
};

const graph = {
  generatedAt: "2026-10-02", scope: { useCaseId: ID, includeObserved: true }, window: { days: 90, applies: "observed edges only" }, summary: { nodes: 4, edges: 3, byType: { use_case: 1, agent: 1, model: 1, vendor: 1 }, propagatedHigh: 3, inheritedExposure: 2, unattachedRisks: 0 },
  nodes: [
    { key: `use_case:${ID}`, type: "use_case", id: ID, label: "Credit-limit assistant", attributes: {}, ownRisk: { score: 4, band: "medium", riskId: RISK, openRisks: 1 }, propagatedRisk: { score: 9, band: "high", sourceNodeKey: "vendor:v", sourceRiskId: RISK, path: [`use_case:${ID}`, `agent:${AGENT}`, "model:mock:balanced", "vendor:v"] } },
    { key: `agent:${AGENT}`, type: "agent", id: AGENT, label: "Credit assistant", attributes: {}, ownRisk: { score: 0, band: "none", riskId: null, openRisks: 0 }, propagatedRisk: { score: 9, band: "high", sourceNodeKey: "vendor:v", sourceRiskId: RISK, path: [`agent:${AGENT}`, "model:mock:balanced", "vendor:v"] } },
    { key: "model:mock:balanced", type: "model", id: null, label: "mock-balanced", attributes: {}, ownRisk: { score: 0, band: "none", riskId: null, openRisks: 0 }, propagatedRisk: { score: 9, band: "high", sourceNodeKey: "vendor:v", sourceRiskId: RISK, path: ["model:mock:balanced", "vendor:v"] } },
    { key: "vendor:v", type: "vendor", id: "v", label: "Acme Model Services", attributes: {}, ownRisk: { score: 9, band: "high", riskId: RISK, openRisks: 1 }, propagatedRisk: { score: 9, band: "high", sourceNodeKey: "vendor:v", sourceRiskId: RISK, path: ["vendor:v"] } },
  ],
  edges: [{ from: `use_case:${ID}`, to: `agent:${AGENT}`, kind: "uses_agent", basis: "declared" }, { from: `agent:${AGENT}`, to: "model:mock:balanced", kind: "runs_on", basis: "declared" }, { from: "model:mock:balanced", to: "vendor:v", kind: "supplied_by", basis: "observed", observedCount: 42 }], notes: { propagation: "Highest reachable live risk.", ratings: "Declared likelihood × impact.", observed: "Observed calls are evidence, not intent.", unattached: "Unattached risks are reported separately." },
};

const alerts = { alerts: [{ id: "al", ruleId: "use_case_inherited_high_risk", ruleLabel: "Approved use case carries a high rating", severity: "high", status: "open", subject: { key: `use_case:${ID}`, type: "use_case", id: ID, label: "Credit-limit assistant", context: null }, title: "Credit-limit assistant inherits a HIGH rating from Acme Model Services", detail: { sourceNodeKey: "vendor:v", sourceRiskId: RISK, pathLabels: ["Credit-limit assistant", "Credit assistant", "mock-balanced", "Acme Model Services"] }, firstDetectedAt: "2026-10-02T10:00:00Z", lastDetectedAt: "2026-10-02T12:00:00Z", acknowledgedAt: null, acknowledgedBy: null, ackNote: null, resolvedAt: null }], counts: { open: 1, acknowledged: 0, resolved: 2 }, lastEvaluatedAt: "2026-10-02T12:00:00Z", rules: [] };
const remediation = { alert: { id: "al", ruleId: "use_case_inherited_high_risk", status: "open", title: alerts.alerts[0]!.title }, candidates: [{ kind: "link_control", executable: true, title: "Link human-oversight control to the source risk", rationale: "The source risk has no current mitigating control.", params: { riskId: RISK, controlRef: "eu-ai-act:art-14-human-oversight" }, steps: [] }, { kind: "assess_vendor", executable: false, title: "Reassess Acme Model Services", rationale: "Vendor assurance is an operator-led workflow.", params: { vendorId: "v" }, steps: ["Open the vendor assessment.", "Request current assurance evidence."] }], proposals: [], note: "Executable changes are proposed into the one approvals queue and do not apply until independently approved." };
let remediationProposed = false;

const regulatory = {
  generatedAt: "2026-10-02T12:00:00.000Z", window: { days: 30 },
  summary: { total: 2, inForce: 1, upcoming: 1, proposed: 0, withControlGaps: 1, nextEffective: "eu-ai-act-high-risk" },
  updates: [
    { key: "nist-ai-rmf-genai-profile", jurisdiction: "US", instrument: "NIST AI RMF", title: "Generative AI Profile available", summary: "The GenAI profile adds risk-management considerations for generative systems.", effectiveDate: "2024-07-26", status: "in_force", daysUntilEffective: -798, sourceUrl: "https://www.nist.gov/itl/ai-risk-management-framework", verifiedOn: "2026-10-02", frameworks: [{ framework: "nist-ai-rmf", packActive: true, activeVersion: 1 }], controls: [{ controlRef: "nist-ai-rmf:map-1.1", title: "Context is established", framework: "nist-ai-rmf", status: "satisfied" }], impact: { scopeBasis: "framework_mapping", useCases: [{ id: ID, name: "Credit-limit-increase assistant", status: "under_review", euAiActTier: "high" }], controlsMapped: 1, controlsEvidenced: 1, controlGaps: 0, frameworkGaps: 0 } },
    { key: "eu-ai-act-high-risk", jurisdiction: "EU", instrument: "EU AI Act (Regulation (EU) 2024/1689)", title: "High-risk AI obligations apply", summary: "Requirements for in-scope high-risk systems enter their application phase.", effectiveDate: "2026-08-02", status: "upcoming", daysUntilEffective: 304, sourceUrl: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj", verifiedOn: "2026-10-02", frameworks: [{ framework: "eu-ai-act", packActive: true, activeVersion: 2 }, { framework: "iso-42001", packActive: false, activeVersion: null }], controls: [{ controlRef: "eu-ai-act:art-14-human-oversight", title: "Human oversight", framework: "eu-ai-act", status: "attestation_required" }, { controlRef: "iso-42001:6.1.2", title: null, framework: null, status: "not_in_active_pack" }], impact: { scopeBasis: "eu_ai_act_tier", useCases: [{ id: ID, name: "Credit-limit-increase assistant", status: "under_review", euAiActTier: "high" }], controlsMapped: 2, controlsEvidenced: 0, controlGaps: 2, frameworkGaps: 1 } },
  ],
  filter: { status: null, framework: null },
  notes: { source: "Curated from linked primary and official sources.", evidence: "Control status is computed from active packs and evidence.", scope: "Use-case impact follows explicit applicability fields.", feed: "2 curated entries; absence is not assurance." },
};

async function mock(route: Route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const method = route.request().method();
  let body: unknown = {};
  if (p === "/auth/me") body = { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "admin@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: "u", isAdmin: true, user: { id: "u", email: "admin@example.test", displayName: "Avery Admin" } };
  else if (p === "/v1/users") body = { users: [{ id: "u", email: "admin@example.test", displayName: "Avery Admin" }, { id: "reviewer", email: "reviewer@example.test", displayName: "Riley Reviewer" }] };
  else if (p === "/v1/agents") body = { agents: [{ id: AGENT, name: "Credit assistant", provider: "mock", model: "mock-balanced" }] };
  else if (p === "/v1/vendors") body = { vendors: [{ id: "v", name: "Acme Model Services", category: "model_provider", status: "approved" }] };
  else if (p === "/v1/use-cases/intake/assist") body = { tier: { value: "high", reasons: [{ ruleId: "annex-iii", tier: "high", ref: "Annex III", reason: "Essential service" }], rulesetVersion: 1, source: "rules", disclaimer: "Screening, not legal advice." }, frameworks: [{ framework: "eu-ai-act", title: "EU AI Act", why: "EU nexus and high-risk purpose", source: "rules" }, { framework: "nist-ai-rmf", title: "NIST AI RMF", why: "Agentic financial workflow", source: "rules" }], risks: [{ scenarioKey: "credit-bias", title: "Disparate credit recommendation outcomes", description: "Profiling data may produce materially different recommendations across protected groups.", category: "bias_fairness", dimension: "bias", likelihood: "medium", impact: "high", suggestedControls: ["eu-ai-act:art-14-human-oversight"], why: "Profiles natural persons", source: "rules" }], euAiActBlock: "```eu-ai-act-answers\n{\"purposeDomain\":\"essential-services\",\"profilesNaturalPersons\":true}\n```", questionnaire: Array.from({ length: 8 }, (_, i) => ({ id: `q${i + 1}`, heading: `${i + 1}. ${["Purpose and business context", "Affected people", "Data", "Human oversight", "Operations", "Monitoring", "Security", "Accountability"][i]}`, text: `Draft answer ${i + 1}`, source: "rules" })), blocking: null, narrative: { status: "drafted", source: "mock" }, disclaimer: "Suggestions only." };
  else if (p === "/v1/use-cases" && method === "POST") body = { id: ID, instance: { id: "instance" } };
  else if (p === "/v1/risks" && method === "POST") body = { id: RISK };
  else if (p === "/v1/reports/trust") body = trust;
  else if (p === `/v1/use-cases/${ID}/overview`) body = overview;
  else if (p === `/v1/use-cases/${ID}/frameworks`) body = { evidenceScope: { kind: "project", projectId: "p", period: "last_30_days", periodLabel: "Last 30 days", note: "Evidence covers the whole project, not this use case alone." }, frameworks: [{ id: "f", framework: "eu-ai-act", version: 2, title: "EU AI Act", cascadeTag: "eu-ai-act", profileExists: true, carriedByUseCase: true, controls: [{ controlRef: "eu-ai-act:art-14-human-oversight", title: "Human oversight", coverage: "measured", attestationRequired: false }] }], disclaimer: "Evidence is a point-in-time view." };
  else if (p === `/v1/agents/${AGENT}/card`) body = { agent: { id: AGENT, name: "Credit assistant", provider: "mock", model: "mock-balanced", tier: "standard", modes: ["chat"], enabled: true, lifecycleStatus: "active", halted: false, haltedReason: null, hasSystemPrompt: true }, owner: { id: "u", name: "Avery Admin", state: "owned" }, purpose: { intendedUses: ["Draft credit-limit recommendations"], limitations: ["Human decision required"], source: "declared model card" }, dataSources: { declared: [], note: "Declared by approved model card." }, guardrails: { modes: {}, blocksInput: true, blocksOutput: true, provenance: [] }, oversight: { modelCards: 1, modelCardApproved: true, note: "Approved model card available." } };
  else if (p === "/v1/inventory/graph") body = graph;
  else if (p === "/v1/governance/alerts") body = alerts;
  else if (p === "/v1/governance/alerts/al/remediation") {
    if (method === "POST") {
      remediationProposed = true;
      body = { id: "proposal", status: "pending_approval", approvalId: "approval" };
    } else {
      body = { ...remediation, proposals: remediationProposed ? [{ id: "proposal", kind: "link_control", title: "Link human-oversight control to the source risk", rationale: "The source risk has no current mitigating control.", status: "pending_approval", approvalId: "approval", proposedByUserId: "u", decidedByUserId: null, decidedAt: null, result: null, createdAt: "2026-10-02T12:05:00Z" }] : [] };
    }
  }
  else if (p === "/v1/governance/monitor/evaluate") body = { evaluatedAt: "2026-10-02T12:01:00Z", raised: 0, refreshed: 1, resolved: 0, active: 1 };
  else if (p === "/v1/regulatory/updates") {
    const selectedStatus = url.searchParams.get("status");
    const selectedFramework = url.searchParams.get("framework");
    body = {
      ...regulatory,
      updates: regulatory.updates.filter((update) =>
        (!selectedStatus || update.status === selectedStatus) &&
        (!selectedFramework || update.frameworks.some((item) => item.framework === selectedFramework))),
      filter: { status: selectedStatus, framework: selectedFramework },
    };
  }
  else if (p === "/v1/risks/library") body = { library: [{ key: "credit-bias", title: "Disparate credit recommendation outcomes", description: "Protected groups may receive materially different outcomes.", category: "bias_fairness", dimension: "bias", domains: ["financial-services"], suggestedControls: ["eu-ai-act:art-14-human-oversight"] }], disclaimer: "Scenario seeds are starting points, not findings." };
  else if (p === "/v1/shadow-ai/catalogue") body = { signatures: [], total: 0, enabled: 0, oldestEntryAt: null, posture: "No collector ships." };
  else if (p === "/v1/shadow-ai/findings") body = { findings: [{ id: "finding", subjectKind: "user", subject: "team-17", provider: "Unregistered AI", signalSources: ["egress_log"], severity: "high", confidence: "high", disposition: "open", observationCount: 12, firstSeenAt: "2026-10-01", lastSeenAt: "2026-10-02", replacementAgent: null, replacementNote: null, dispositionStale: false }], coverage: { sources: [], sourcesOn: 1, sourcesPossible: 4, statement: "Coverage reflects only supplied evidence." }, posture: "Detection is signal, not proof." };
  else if (p === "/v1/shadow-ai/imports") body = { imports: [] };
  else if (p === "/v1/shadow-ai/adapters") body = { adapters: [], posture: "Operator supplied evidence only.", pipeline: "No raw content retained." };
  else if (p === "/v1/shadow-ai/discovery/catalog") body = { catalogVersion: 1, total: 0, endpoints: 0, sdks: 0, entries: [], governedHosts: [], posture: "Catalogue classification only.", limits: "No scan is performed." };
  else if (p === "/v1/shadow-ai/mcp-discovery") body = { posture: "Evidence triage only; no scan, connection, or crawl was performed.", observed: 1, unregistered: 1, registryCount: 2, results: [{ host: "tools.unknown.example", path: "/mcp", indicators: ["protocol-version-header", "transport-path:/mcp"], confidence: "high", occurrences: 1, samples: [], registered: false, registeredAs: null, verdict: "UNREGISTERED — this host appears in supplied evidence and matches no MCP server in this deployment's registry." }] };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function shotBoth(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((next) => { document.documentElement.dataset.theme = next; localStorage.setItem("regulait.theme", next); window.scrollTo(0, 0); }, theme);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), fullPage: true });
  }
}

test.beforeEach(async ({ page }) => { await page.route("**/*", async (route) => route.request().resourceType() === "document" || !new URL(route.request().url()).pathname.startsWith("/v1") && !new URL(route.request().url()).pathname.startsWith("/auth") ? route.continue() : mock(route)); });

test("enterprise governance demo surfaces render and complete their core actions", async ({ page }) => {
  await page.goto("/ui/admin/governance/intake");
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await expect(page.getByText("Review assistant suggestions", { exact: true })).toBeVisible();
  await shotBoth(page, "01-intake-suggestions");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Submit for human review" }).click();
  await expect(page.getByText("Submitted for human review.")).toBeVisible();
  await shotBoth(page, "02-intake-submitted");

  await page.goto("/ui/admin/governance/trust");
  await expect(page.getByRole("heading", { name: "Trust & evidence" })).toBeVisible();
  await shotBoth(page, "03-trust-dashboard");

  await page.goto(`/ui/admin/governance/use-cases/${ID}`);
  await expect(page.getByRole("heading", { name: "Credit-limit-increase assistant" })).toBeVisible();
  await shotBoth(page, "04-use-case-overview");
  await page.getByRole("tab", { name: "Frameworks" }).click();
  await expect(page.getByText("EU AI Act v2")).toBeVisible();
  await page.getByRole("tab", { name: "Risks" }).click();
  await expect(page.getByText("Inherent")).toBeVisible();
  await page.getByLabel("Search scenarios").fill("destructive tool");
  await page.getByRole("button", { name: "Assess and add" }).click();
  const addAssessedRisk = page.getByRole("button", { name: "Add assessed risk" });
  await expect(addAssessedRisk).toBeDisabled();
  await page.getByLabel("Likelihood", { exact: true }).selectOption("high");
  await page.getByLabel("Impact", { exact: true }).selectOption("low");
  const riskRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/v1/risks" && request.method() === "POST");
  await addAssessedRisk.click();
  const postedRisk = await riskRequest;
  expect(postedRisk.postDataJSON()).toMatchObject({ likelihood: "high", impact: "low" });
  await expect(page.getByText(/Risk added from/)).toBeVisible();
  await shotBoth(page, "05-use-case-risks");
  await page.getByRole("tab", { name: "Stack" }).click();
  await expect(page.getByText("Declared purpose")).toBeVisible();
  await page.getByRole("tab", { name: "Dependencies" }).click();
  await expect(page.getByRole("img", { name: /AI dependency/ })).toBeVisible();
  await page.getByRole("tab", { name: "Approvals" }).click();
  await expect(page.getByText("Approval history")).toBeVisible();
  await page.getByRole("tab", { name: "Audit" }).click();
  await expect(page.getByText("Recent use-case audit evidence")).toBeVisible();

  await page.goto("/ui/admin/governance/alerts");
  await page.getByRole("button", { name: /inherits a HIGH rating/ }).click();
  await page.getByRole("button", { name: "Evaluate now" }).click();
  await expect(page.getByText(/Evaluation raised 0, refreshed 1/)).toBeVisible();
  const acknowledgement = page.getByLabel("Acknowledgement note — required and audited");
  await acknowledgement.fill("x".repeat(501));
  await expect(acknowledgement).toHaveValue("x".repeat(500));
  await acknowledgement.fill("Owner assigned; vendor evidence review scheduled.");
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByText("Alert acknowledged")).toBeVisible();
  await expect(page.getByText("Reassess Acme Model Services")).toBeVisible();
  await page.getByLabel("Independent approver").selectOption("reviewer");
  await page.getByRole("button", { name: "Propose…" }).click();
  await expect(page.getByText("pending approval")).toBeVisible();
  await page.waitForTimeout(4_000);
  await shotBoth(page, "06-governance-alerts");

  await page.goto("/ui/admin/governance/graph");
  await expect(page.getByRole("img", { name: /AI dependency/ })).toBeVisible();
  await shotBoth(page, "07-dependency-graph");

  await page.goto("/ui/admin/governance/regulatory");
  await expect(page.getByRole("heading", { name: "Regulatory & policy intelligence" })).toBeVisible();
  await expect(page.getByText("inactive pack gap", { exact: false })).toBeVisible();
  await page.getByText("Mapped controls and impacted use cases").last().click();
  await expect(page.getByRole("link", { name: "Credit-limit-increase assistant" }).last()).toBeVisible();
  await shotBoth(page, "09-regulatory-intelligence");
  await page.getByLabel("Status").selectOption("proposed");
  await expect(page.getByText("No entries match these filters")).toBeVisible();
  await expect(page.getByText("2 curated entries; absence is not assurance.", { exact: true }).first()).toBeVisible();

  await page.goto("/ui/admin/shadow-ai");
  await page.getByLabel("MCP log evidence").fill('POST https://tools.unknown.example/mcp MCP-Protocol-Version: 2025-06-18 {"method":"tools/list"}');
  await page.getByRole("button", { name: "Compare with registry (writes nothing)" }).click();
  await expect(page.getByText("tools.unknown.example", { exact: true })).toBeVisible();
  await shotBoth(page, "08-mcp-discovery");
});

test("alerts distinguish a monitor that has never run and use a valid agent inventory link", async ({ page }) => {
  await page.route("**/v1/governance/alerts?status=active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ alerts: [], counts: { open: 0, acknowledged: 0, resolved: 0 }, lastEvaluatedAt: null, rules: [] }),
    });
  });
  await page.goto("/ui/admin/governance/alerts");
  await expect(page.getByText("The governance monitor has not run yet. Select Evaluate now before treating this as an all-clear state.")).toBeVisible();

  await page.unroute("**/v1/governance/alerts?status=active");
  await page.route("**/v1/governance/alerts?status=active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        alerts: [{ ...alerts.alerts[0], subject: { key: `agent:${AGENT}`, type: "agent", id: AGENT, label: "Credit assistant", context: null } }],
        counts: { open: 1, acknowledged: 0, resolved: 0 },
        lastEvaluatedAt: "2026-10-02T12:00:00Z",
        rules: [],
      }),
    });
  });
  await page.reload();
  await page.getByRole("button", { name: /inherits a HIGH rating/ }).click();
  await expect(page.getByRole("link", { name: "Open agent" })).toHaveAttribute("href", "/ui/admin/agents");
});
