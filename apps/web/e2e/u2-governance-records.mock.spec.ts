/**
 * UI gaps U2 — governance, quality and audit records that had an API and no
 * screen, against a mocked gateway:
 *
 *  - Governance alerts: every remediation proposal across alerts (ADR-0159);
 *  - Evaluations: the drift summary the page opens on, and the confirmed
 *    pinned-baseline sweep (ADR-0044);
 *  - Compliance packs: a pack's controls and attestations, recording an
 *    attestation (only on an organisational control), stored reports and one
 *    report's scorecard (ADR-0058);
 *  - Shadow-AI: a finding's remediation plan, starting the workflow through the
 *    one instantiation route and linking it, confirmed (ADR-0055 §4);
 *  - Red-teaming: minting the next version of a published library (ADR-0057);
 *  - Audit: anchor the chain now and write out pending anchors;
 *  - Lineage, Scheduled jobs, Infrastructure: one run's inputs and outputs, a
 *    job's full history, a certificate's rotation history;
 *  - axe (WCAG 2.x A/AA) in light and dark on the new surfaces.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ISO = "2026-10-07T10:00:00.000Z";
const USER = "22222222-2222-4222-8222-222222222222";
const PACK = "88888888-8888-4888-8888-888888888881";
const REPORT = "88888888-8888-4888-8888-888888888882";
const FINDING = "99999999-9999-4999-8999-999999999991";
const INSTANCE = "99999999-9999-4999-8999-999999999992";
const LIB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LIB2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const CERT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

async function mockApi(page: Page, opts: { noWorkflowMatch?: boolean; failLinkOnce?: boolean } = {}): Promise<Call[]> {
  const calls: Call[] = [];
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  let libFrozen = true;
  let linkFailures = opts.failLinkOnce ? 1 : 0;
  // ADR-0195 A4: the server, not the browser, remembers a workflow started for the finding but never linked
  let startedNotLinked: string | null = null;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    calls.push({ method, path: p, body });
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users") return json(route, { users: [{ id: USER, email: "ada@example.test", displayName: "Ada Analyst", isAdmin: false }] });
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (p === "/v1/servers" || p === "/v1/roles" || p === "/v1/teams") return json(route, { servers: [], roles: [], teams: [] });
    if (p === "/v1/org/settings") return json(route, { settings: {} });
    // --- governance alerts
    if (p === "/v1/governance/alerts") return json(route, { alerts: [], counts: { open: 0, acknowledged: 0, resolved: 0 }, lastEvaluatedAt: ISO, rules: [] });
    if (p === "/v1/kris") return json(route, { kris: [], metrics: [], measuredAt: ISO, note: "n" });
    if (p === "/v1/pm/connections") return json(route, { connections: [] });
    if (p === "/v1/governance/remediations") {
      const status = url.searchParams.get("status");
      const all = [
        { id: "r1", alertId: "a1", kind: "halt_agent", params: {}, title: "Halt Claims bot", rationale: "KRI breached", status: "pending_approval", approvalId: "ap1", proposedByUserId: USER, decidedByUserId: null, decidedAt: null, result: null, createdAt: ISO },
        { id: "r2", alertId: "a2", kind: "halt_agent", params: {}, title: "Halt Intake bot", rationale: "KRI breached", status: "applied", approvalId: "ap2", proposedByUserId: USER, decidedByUserId: "u-admin", decidedAt: ISO, result: {}, createdAt: ISO },
      ];
      return json(route, { proposals: status ? all.filter((r) => r.status === status) : all });
    }
    // --- evals
    if (p === "/v1/evals/scorers") return json(route, { scorers: [], note: "Scorers." });
    if (p === "/v1/evals/scoring-semantics") return json(route, { current: 2, versions: [], evalRuns: [], stalePinnedBaselines: [], note: "Semantics." });
    if (p === "/v1/evals/datasets") return json(route, { datasets: [], note: "Datasets freeze." });
    if (p === "/v1/evals/runs") return json(route, { runs: [] });
    if (p === "/v1/evals/summary") {
      return json(route, {
        runs: 12,
        regressions: 1,
        failed: 2,
        totalCostUsd: 1.25,
        recent: [
          { id: "e1", agentName: "Claims bot", model: "m", trigger: "scheduled", meanScore: 0.71, passRate: 0.8, scoreDelta: -0.12, gatePassed: false, regression: true, isBaseline: false, startedAt: ISO, by: null },
          { id: "e2", agentName: "Claims bot", model: "m", trigger: "manual", meanScore: 0.83, passRate: 0.9, scoreDelta: null, gatePassed: true, regression: false, isBaseline: true, startedAt: ISO, by: "ada@example.test" },
        ],
      });
    }
    if (p === "/v1/evals/drift-sweep" && method === "POST") {
      return json(route, { ran: [{ datasetId: "d", agentId: "a", runId: "e3", regression: false, scoreDelta: 0, trigger: "scheduled" }], skipped: [], note: "Runs as the pinner." });
    }
    // --- compliance packs
    if (p === "/v1/compliance/packs") {
      return json(route, {
        packs: [{ id: PACK, framework: "acme-internal", version: 1, title: "ACME standard", description: null, provenance: {}, cascadeTag: null, status: "active", controlCount: 2, activatedAt: ISO, retiredAt: null }],
        updatePolicy: "A pack is rows.",
        disclaimer: "Not a certification.",
      });
    }
    if (p === `/v1/compliance/packs/${PACK}`) {
      return json(route, {
        pack: { id: PACK, framework: "acme-internal", version: 1, title: "ACME standard", status: "active", description: null },
        controls: [
          { id: "c1", controlRef: "acme:1.1", title: "Decisions recorded", description: null, coverage: "enforced", collector: "audit_decisions", collectorParams: {}, minEvidenceCount: 1, attestationRequired: false, ownerNote: null },
          { id: "c2", controlRef: "acme:9.9", title: "Staff trained", description: null, coverage: "unaddressed", collector: "none", collectorParams: {}, minEvidenceCount: 1, attestationRequired: true, ownerNote: "Training lives in the LMS." },
        ],
        attestations: [{ id: "at1", controlRef: "acme:9.9", statement: "Q2 training complete.", evidenceRef: "LMS Q2", validUntil: "2026-01-01T00:00:00.000Z", attestedByUserId: USER, attestedAt: ISO }],
        disclaimer: "Not a certification.",
      });
    }
    if (p === `/v1/compliance/packs/${PACK}/attestations` && method === "POST") return json(route, { attestation: { id: "at2" }, note: "attested" }, 201);
    if (p === "/v1/compliance/pack-reports") {
      return json(route, {
        reports: [{ id: REPORT, packId: PACK, framework: "acme-internal", packVersion: 1, requestedByUserId: USER, scopeKind: "org", entitlementScope: "org", effectiveProjectIds: null, periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-09-30T23:59:59.000Z", generatedAt: ISO }],
        disclaimer: "Not a certification.",
      });
    }
    if (p === `/v1/compliance/pack-reports/${REPORT}`) {
      return json(route, {
        report: {
          id: REPORT, packId: PACK, framework: "acme-internal", packVersion: 1, requestedByUserId: USER, scopeKind: "org", scopeId: null, entitlementScope: "org", effectiveProjectIds: null,
          periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-09-30T23:59:59.000Z", generatedAt: ISO,
          payload: {
            statement: "Counted from this deployment's ledgers.",
            period: { label: "Q3 2026" },
            totals: { satisfied: 1, unsatisfied: 0, attested: 0, attestationRequired: 1 },
            controls: [{ controlRef: "acme:1.1", title: "Decisions recorded", status: "satisfied", evidenceCount: 42, minEvidenceCount: 1, note: "" }],
            disclaimer: "Not a certification.",
          },
        },
      });
    }
    // --- shadow-AI
    if (p === "/v1/shadow-ai/catalogue") return json(route, { signatures: [], total: 0, enabled: 0, oldestEntryAt: null, posture: "No collector ships." });
    if (p === "/v1/shadow-ai/findings") {
      return json(route, {
        findings: [{ id: FINDING, subjectKind: "repo", subject: "acme/billing", provider: "example-provider", signalSources: ["code_scan"], severity: "high", confidence: "high", disposition: "open", observationCount: 3, firstSeenAt: ISO, lastSeenAt: ISO, replacementAgent: null, replacementNote: null, dispositionStale: false }],
        coverage: { sources: [], sourcesOn: 1, sourcesPossible: 4, statement: "Coverage reflects only supplied evidence." },
        posture: "Detection is signal, not proof.",
      });
    }
    if (p === "/v1/shadow-ai/imports") return json(route, { imports: [] });
    if (p === "/v1/shadow-ai/adapters") return json(route, { adapters: [], posture: "Operator supplied evidence only.", pipeline: "No raw content retained." });
    if (p === "/v1/shadow-ai/discovery/catalog") return json(route, { catalogVersion: 1, total: 0, endpoints: 0, sdks: 0, entries: [], governedHosts: [], posture: "Catalogue only.", limits: "No scan." });
    if (p === `/v1/shadow-ai/findings/${FINDING}/remediation-plan`) {
      return json(route, {
        findingId: FINDING, subject: "acme/billing", provider: "example-provider", severity: "high", replacementAgent: null,
        steps: [
          { step: "register the endpoint in the model catalogue", why: "a governed provider entry makes the traffic routable" },
          { step: "route acme/billing through the compat surface (ADR-0020)", why: "a base URL change", blocked: "no governed replacement is registered for this provider" },
        ],
        workflowRequest: {
          route: "POST /v1/workflows/instances",
          body: {
            change: {
              description: `Pull acme/billing (example-provider) into governance — shadow-AI finding ${FINDING}`,
              paths: ["acme/billing"],
              changeType: "shadow-ai-remediation",
              environment: "unstated",
              targetSystem: "acme/billing",
            },
          },
          needsInput: ["change.environment"],
        },
        assignment: opts.noWorkflowMatch
          ? {
              changeType: "shadow-ai-remediation",
              ruleConfigured: false,
              defaultTemplate: { name: "shadow-ai-remediation", state: "retired" },
              detail: "an admin must assign a workflow template to it",
            }
          : { changeType: "shadow-ai-remediation", ruleConfigured: true, defaultTemplate: { name: "shadow-ai-remediation", state: "active" } },
        pendingLink: startedNotLinked ? { instanceId: startedNotLinked, startedAt: ISO } : null,
        note: "This module does not start workflows.",
      });
    }
    if (p === "/v1/workflows/instances" && method === "POST") {
      if (opts.noWorkflowMatch) return json(route, { error: "no_workflow_matches_change" }, 422);
      startedNotLinked = INSTANCE;
      return json(route, { id: INSTANCE, status: "running" }, 201);
    }
    if (p === "/v1/workflows/instances") return json(route, {
      // the link list offers only live remediation workflows started from this finding's plan
      instances: [
        { id: INSTANCE, status: "running", createdAt: ISO, change: { changeType: "shadow-ai-remediation", description: `Existing remediation — shadow-AI finding ${FINDING}` } },
        { id: "99999999-9999-4999-8999-9999999999f1", status: "running", createdAt: ISO, change: { changeType: "feature", description: `Unrelated — shadow-AI finding ${FINDING}` } },
        { id: "99999999-9999-4999-8999-9999999999f2", status: "aborted", createdAt: ISO, change: { changeType: "shadow-ai-remediation", description: `Abandoned — shadow-AI finding ${FINDING}` } },
      ],
    });
    if (p === `/v1/shadow-ai/findings/${FINDING}/remediate` && method === "POST") {
      if (linkFailures > 0) {
        linkFailures -= 1;
        return json(route, { error: "internal" }, 500);
      }
      startedNotLinked = null;
      return json(route, { id: FINDING, disposition: "confirmed" });
    }
    // --- red team
    if (p === "/v1/redteam/attack-classes") return json(route, { attackClasses: [{ id: "prompt_injection", summary: "s" }], disclosure: "d", scheduling: { schedulerEnabled: false, posture: "p", note: "n" } });
    if (p === "/v1/redteam/libraries" && method === "GET") {
      return json(route, {
        libraries: [
          { id: LIB, name: "core", version: 1, note: null, status: "published", evalDatasetId: "ds", probeCount: 4, frozen: true, createdAt: ISO },
          ...(libFrozen ? [] : [{ id: LIB2, name: "core", version: 2, note: "add jailbreaks", status: "draft", evalDatasetId: null, probeCount: 4, frozen: false, createdAt: ISO }]),
        ],
        note: "Libraries freeze.",
      });
    }
    if (p === `/v1/redteam/libraries/${LIB}`) {
      return json(route, { library: { id: LIB, name: "core", version: 1, note: null, status: "published", evalDatasetId: "ds", probeCount: 4, frozen: true, createdAt: ISO }, probes: [], versions: [], frozen: true, disclosure: "d" });
    }
    if (p === `/v1/redteam/libraries/${LIB2}`) {
      return json(route, { library: { id: LIB2, name: "core", version: 2, note: "add jailbreaks", status: "draft", evalDatasetId: null, probeCount: 4, frozen: false, createdAt: ISO }, probes: [], versions: [], frozen: false, disclosure: "d" });
    }
    if (p === `/v1/redteam/libraries/${LIB}/versions` && method === "POST") {
      libFrozen = false;
      return json(route, { library: { id: LIB2, name: "core", version: 2, status: "draft" }, copiedProbes: 4, note: "Re-scoring under a newer version can surface a regression." }, 201);
    }
    if (p === "/v1/redteam/runs") return json(route, { runs: [] });
    // --- audit
    if (p === "/v1/audit/anchors") return json(route, { anchors: [{ id: "an1", seq: 4, status: "pending", timestamp: { status: "not_configured", genTime: null, tsaUrl: null, serial: null, policyOid: null, verified: false } }], sink: null, disclosure: "No anchor sink is configured: anchors exist only in this database." });
    if (p === "/v1/audit/anchor" && method === "POST") {
      return json(route, { anchorId: "an2", seq: 57, rowHash: "0".repeat(64), destination: "none", status: "pending", externalRef: null, tamperResistant: false, error: null }, 201);
    }
    if (p === "/v1/audit/anchors/flush" && method === "POST") return json(route, { attempted: 1, flushed: 1, failed: 0 });
    if (p === "/v1/audit") return json(route, { entries: [], pageSize: 100, hasMore: false, nextCursor: null });
    // --- lineage
    if (p === "/v1/lineage/overview") return json(route, { nodesByKind: [], edgesByKind: [], byProject: [], contentLevelLineageEnabled: false, note: "n", captureNote: "Metadata only." });
    if (p === "/v1/lineage/nodes") return json(route, { nodes: [], note: "n" });
    if (p === `/v1/lineage/runs/${RUN}`) {
      return json(route, {
        runId: RUN,
        dispatches: [
          {
            node: { id: "n-run", kind: "run", subtype: "agent_run", label: "Claims triage run", version: null, contentRecorded: false, refKey: "node-1" },
            suppliedInputs: [{ id: "n-src", kind: "source", subtype: "context_entry", label: "Policy handbook", version: 3, contentRecorded: false }],
            producedOutputs: [{ id: "n-out", kind: "output", subtype: "artifact", label: "Triage summary", version: 1, contentRecorded: false }],
            withheldEdges: 2,
          },
        ],
        note: "Lineage shows what the gateway mediated.",
      });
    }
    // --- scheduler
    if (p === "/v1/scheduler") {
      return json(route, {
        enabled: true, posture: "on", tickMs: 30000, leaseSeconds: 300, instanceId: "gw-1", stuckRuns: [], note: "n",
        jobs: [{ name: "approval-sla", description: "SLA sweep", adr: "ADR-0064", enabled: true, intervalSeconds: 900, nextDueAt: ISO, effectiveNextDueAt: ISO, lastRunAt: ISO, lastFinishedAt: ISO, lastOutcome: "ok", lastError: null, lastItemsProcessed: 2, lastDurationMs: 12, running: false, runs: 60, failures: 1, consecutiveFailures: 0, registered: true, recentRuns: [] }],
      });
    }
    if (p === "/v1/scheduler/jobs/approval-sla/runs") {
      return json(route, {
        job: { name: "approval-sla" },
        registered: true,
        runs: [
          { id: "sr1", jobName: "approval-sla", trigger: "schedule", instanceId: "gw-1", startedAt: ISO, finishedAt: ISO, durationMs: 12, outcome: "ok", itemsProcessed: 2, error: null },
          { id: "sr2", jobName: "approval-sla", trigger: "manual", instanceId: "gw-2", startedAt: "2026-09-01T10:00:00.000Z", finishedAt: null, durationMs: null, outcome: "failed", itemsProcessed: 0, error: "database unreachable" },
        ],
      });
    }
    // --- infrastructure
    if (p === "/v1/infra/certs") return json(route, { certs: [{ id: CERT, resourceName: "gateway", commonName: "gw.example.test", notAfter: "2026-12-01T00:00:00.000Z", status: "rotated", serial: "02" }] });
    if (p === `/v1/infra/certs/${CERT}/rotations`) {
      return json(route, {
        rotations: [{ id: "rot1", certId: CERT, findingId: null, approvalId: "ap9", oldSerial: "01", newSerial: "02", newNotAfter: "2026-12-01T00:00:00.000Z", status: "rotated", reason: "expiring in 14 days", rotatedAt: ISO, createdAt: ISO }],
      });
    }
    if (p.startsWith("/v1/infra/")) return json(route, { resources: [], policies: [], findings: [], patches: [], backups: [] });
    return json(route, {});
  });
  return calls;
}

const posted = (calls: Call[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string, include?: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const results = await builder.analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const card = (page: Page, title: string) => page.locator("section[data-rg-card]").filter({ hasText: title }).first();

test.describe("U2: governance records", () => {
  test("governance alerts list every remediation proposal, filterable by status", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/ui/admin/governance/alerts");
    const c = card(page, "Remediation proposals — all alerts");
    await expect(c).toContainText("Halt Claims bot");
    await expect(c).toContainText("Halt Intake bot");
    await c.getByLabel("Status").selectOption("applied");
    await expect(c).not.toContainText("Halt Claims bot");
    expect(calls.some((x) => x.path === "/v1/governance/remediations")).toBe(true);
    await expectAxeClean(page, "remediations card");
  });

  test("evaluations open on the drift summary; the baseline sweep is confirmed first", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/ui/admin/evals");
    const summary = page.getByTestId("evals-summary");
    await expect(summary).toContainText("regression");
    await expect(summary).toContainText("-0.120");
    await expect(summary).toContainText("baseline");
    await page.getByRole("button", { name: "Re-run pinned baselines…" }).click();
    const dialog = page.getByRole("dialog", { name: "Re-run every pinned baseline now?" });
    await expect(dialog).toContainText("spends model budget");
    await dialog.getByRole("button", { name: "Re-run baselines" }).click();
    await expect(page.getByTestId("drift-sweep")).toContainText("1 pinned baseline re-run, 0 regressed.");
    expect(posted(calls, "POST", "/v1/evals/drift-sweep")).toHaveLength(1);
    await expectAxeClean(page, "evals drift summary");
  });

  test("compliance pack detail records an attestation and opens a stored report", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/ui/admin/compliance-packs");
    await page.getByRole("button", { name: "Details of acme-internal v1" }).click();
    const detail = page.getByTestId("pack-detail");
    await expect(detail).toContainText("Training lives in the LMS.");
    await expect(detail).toContainText("lapsed");
    const form = page.getByRole("form", { name: "Record an attestation" });
    await expect(form.getByLabel("Control").locator("option")).toHaveText(["— choose a control —", "acme:9.9 — Staff trained"]);
    await form.getByLabel("Control").selectOption("acme:9.9");
    await form.getByLabel("Statement").fill("Q3 training complete for every operator.");
    await form.getByLabel("Evidence reference (optional)").fill("LMS Q3");
    await form.getByLabel("Valid until (optional)").fill("2027-03-31");
    await form.getByRole("button", { name: "Record attestation" }).click();
    await expect.poll(() => posted(calls, "POST", `/v1/compliance/packs/${PACK}/attestations`)).toEqual([
      { controlRef: "acme:9.9", statement: "Q3 training complete for every operator.", evidenceRef: "LMS Q3", validUntil: "2027-03-31T23:59:59.000Z" },
    ]);
    const reports = card(page, "Stored reports — acme-internal v1");
    await expect(reports).toContainText("organisation-wide");
    await reports.getByRole("button", { name: /Open the acme-internal v1 report/ }).click();
    await expect(page.getByTestId("pack-report")).toContainText("Q3 2026");
    await expect(page.getByTestId("pack-report")).toContainText("42 / 1");
    await expectAxeClean(page, "compliance pack detail and reports");
  });

  test("a shadow-AI plan starts a workflow through the one route and links it, after confirming", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for acme/billing" }).click();
    const plan = page.getByTestId("shadow-remediation");
    await expect(plan).toContainText("no governed replacement is registered for this provider");
    await expect(plan.getByLabel("Environment", { exact: true })).toHaveValue("");
    // an assigned workflow: no "admin must assign" note
    await expect(plan.getByTestId("shadow-no-assignment-rule")).toHaveCount(0);
    await plan.getByRole("button", { name: "Start remediation workflow…" }).click();
    await expect(page.getByRole("dialog", { name: "Start a remediation workflow?" })).toHaveCount(0);
    await plan.getByLabel("Environment", { exact: true }).fill("production");
    await plan.getByRole("button", { name: "Start remediation workflow…" }).click();
    const dialog = page.getByRole("dialog", { name: "Start a remediation workflow?" });
    await expect(dialog).toContainText("its disposition becomes confirmed");
    await dialog.getByRole("button", { name: "Start and link" }).click();
    await expect.poll(() => posted(calls, "POST", `/v1/shadow-ai/findings/${FINDING}/remediate`)).toEqual([{ instanceId: INSTANCE }]);
    expect(posted(calls, "POST", "/v1/workflows/instances")).toEqual([
      {
        change: {
          description: `Pull acme/billing (example-provider) into governance — shadow-AI finding ${FINDING}`,
          paths: ["acme/billing"],
          changeType: "shadow-ai-remediation",
          environment: "production",
          targetSystem: "acme/billing",
        },
      },
    ]);
    await expect(plan.getByRole("status")).toContainText(INSTANCE);
    await expectAxeClean(page, "shadow-AI remediation plan", "[data-testid='shadow-remediation']");
  });

  test("with no assignment rule, the shadow-AI start says so and links nothing; an existing workflow can be linked", async ({ page }) => {
    const calls = await mockApi(page, { noWorkflowMatch: true });
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for acme/billing" }).click();
    const plan = page.getByTestId("shadow-remediation");
    await plan.getByLabel("Environment", { exact: true }).fill("staging");
    await plan.getByRole("button", { name: "Start remediation workflow…" }).click();
    await page.getByRole("dialog", { name: "Start a remediation workflow?" }).getByRole("button", { name: "Start and link" }).click();
    await expect(plan.getByRole("alert")).toContainText("No workflow assignment rule covers the change type 'shadow-ai-remediation'");
    // the plan said so before anyone tried: no workflow is assigned to the change type by default
    await expect(plan.getByTestId("shadow-no-assignment-rule")).toContainText("An admin must add an assignment rule");
    expect(posted(calls, "POST", `/v1/shadow-ai/findings/${FINDING}/remediate`)).toHaveLength(0);

    // a workflow of another change type, or an aborted one, is never offered
    await expect(plan.getByLabel("Or link an existing workflow").locator("option")).toHaveCount(2);
    await plan.getByLabel("Or link an existing workflow").selectOption(INSTANCE);
    await plan.getByRole("button", { name: "Link workflow…" }).click();
    await page.getByRole("dialog", { name: "Link this workflow?" }).getByRole("button", { name: "Link" }).click();
    await expect.poll(() => posted(calls, "POST", `/v1/shadow-ai/findings/${FINDING}/remediate`)).toEqual([{ instanceId: INSTANCE }]);
  });

  test("a workflow that started but failed to link is retried as a link only, never a second start", async ({ page }) => {
    const calls = await mockApi(page, { failLinkOnce: true });
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for acme/billing" }).click();
    const plan = page.getByTestId("shadow-remediation");
    await plan.getByLabel("Environment", { exact: true }).fill("production");
    await plan.getByRole("button", { name: "Start remediation workflow…" }).click();
    await page.getByRole("dialog", { name: "Start a remediation workflow?" }).getByRole("button", { name: "Start and link" }).click();
    const unlinked = plan.getByTestId("shadow-started-unlinked");
    await expect(unlinked).toContainText(`Workflow ${INSTANCE} was started but is not linked`);
    await expect(plan.getByRole("button", { name: "Start remediation workflow…" })).toBeDisabled();
    await unlinked.getByRole("button", { name: "Retry linking this workflow" }).click();
    await expect(unlinked).toHaveCount(0);
    await expect(plan.getByRole("status")).toContainText(INSTANCE);
    expect(posted(calls, "POST", "/v1/workflows/instances")).toHaveLength(1);
    expect(posted(calls, "POST", `/v1/shadow-ai/findings/${FINDING}/remediate`)).toEqual([{ instanceId: INSTANCE }, { instanceId: INSTANCE }]);
  });

  test("a started-but-unlinked workflow survives a reload: only its link can be retried", async ({ page }) => {
    const calls = await mockApi(page, { failLinkOnce: true });
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for acme/billing" }).click();
    let plan = page.getByTestId("shadow-remediation");
    await plan.getByLabel("Environment", { exact: true }).fill("production");
    await plan.getByRole("button", { name: "Start remediation workflow…" }).click();
    await page.getByRole("dialog", { name: "Start a remediation workflow?" }).getByRole("button", { name: "Start and link" }).click();
    await expect(plan.getByTestId("shadow-started-unlinked")).toBeVisible();
    // while it is unlinked, linking a DIFFERENT workflow is not offered either
    await expect(plan.getByRole("button", { name: "Link workflow…" })).toBeDisabled();
    await expect(plan.getByLabel("Or link an existing workflow")).toBeDisabled();

    await page.reload();
    await page.getByRole("button", { name: "Plan remediation for acme/billing" }).click();
    plan = page.getByTestId("shadow-remediation");
    const unlinked = plan.getByTestId("shadow-started-unlinked");
    await expect(unlinked).toContainText(`Workflow ${INSTANCE} was started but is not linked`);
    await expect(plan.getByRole("button", { name: "Start remediation workflow…" })).toBeDisabled();
    await expect(plan.getByRole("button", { name: "Link workflow…" })).toBeDisabled();
    await expect(plan.getByLabel("Or link an existing workflow")).toBeDisabled();
    await expectAxeClean(page, "shadow-AI unlinked workflow after reload", "[data-testid='shadow-remediation']");
    await unlinked.getByRole("button", { name: "Retry linking this workflow" }).click();
    await expect(unlinked).toHaveCount(0);
    await expect(plan.getByRole("button", { name: "Link workflow…" })).toBeEnabled();
    expect(posted(calls, "POST", "/v1/workflows/instances")).toHaveLength(1);
    expect(posted(calls, "POST", `/v1/shadow-ai/findings/${FINDING}/remediate`)).toEqual([{ instanceId: INSTANCE }, { instanceId: INSTANCE }]);
  });

  test("a published red-team library mints its next version as a draft", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/ui/admin/redteam");
    await page.getByRole("cell", { name: "core" }).first().click();
    const mint = page.getByRole("form", { name: "Mint the next library version" });
    await mint.getByLabel("Note for the new version (optional)").fill("add jailbreaks");
    await expectAxeClean(page, "red-team mint form", "form[aria-label='Mint the next library version']");
    await mint.getByRole("button", { name: "Mint next version" }).click();
    await expect.poll(() => posted(calls, "POST", `/v1/redteam/libraries/${LIB}/versions`)).toEqual([{ note: "add jailbreaks" }]);
    await expect(page.getByRole("button", { name: "Add probe" })).toBeVisible();
    const draft = page.locator("section[data-rg-card]").filter({ has: page.getByRole("button", { name: "Add probe" }) }).first();
    await expect(draft).toContainText("core v2");
    await expect(draft.getByRole("status")).toContainText("Re-scoring under a newer version can surface a regression.");
  });

  test("audit anchoring: anchor now and write out pending anchors, each saying what happened", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/ui/admin/audit");
    await page.locator("summary", { hasText: "Anchor timestamps" }).click();
    const c = page.locator("details", { hasText: "Anchor timestamps" });
    await expect(c).toContainText("No anchor sink is configured");
    await c.getByRole("button", { name: "Anchor the chain now" }).click();
    await expect(c.getByTestId("anchor-said")).toContainText("Anchored the chain at row 57: waiting to be written out, to this database only");
    await expect(c.getByTestId("anchor-said")).toContainText("not evidence");
    await c.getByRole("button", { name: /Write out pending anchors/ }).click();
    await expect(c.getByTestId("anchor-said")).toContainText("1 of 1 waiting anchor written out.");
    expect(posted(calls, "POST", "/v1/audit/anchor")).toHaveLength(1);
    expect(posted(calls, "POST", "/v1/audit/anchors/flush")).toHaveLength(1);
    await expectAxeClean(page, "anchor panel");
  });

  test("minor reads: a run's lineage, a job's full history, a certificate's rotations", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/lineage");
    const lookup = page.getByRole("form", { name: "Look up a run's lineage" });
    await lookup.getByLabel("Run id").fill("nope");
    await lookup.getByRole("button", { name: "Show lineage" }).click();
    await expect(page.getByText("That is not a run id.")).toBeVisible();
    await lookup.getByLabel("Run id").fill(RUN);
    await lookup.getByRole("button", { name: "Show lineage" }).click();
    const lineage = page.getByTestId("run-lineage");
    await expect(lineage).toContainText("Policy handbook");
    await expect(lineage).toContainText("Triage summary");
    await expect(lineage).toContainText("2 edge(s) withheld.");
    await expectAxeClean(page, "run lineage");

    await page.goto("/ui/admin/scheduler");
    await page.getByRole("button", { name: "Show the full run history of approval-sla" }).click();
    const history = page.getByTestId("scheduler-history-approval-sla");
    await expect(history).toContainText("database unreachable");
    await expect(history).toContainText("gw-2");
    await expectAxeClean(page, "scheduler history", "[data-testid='scheduler-history-approval-sla']");

    await page.goto("/ui/admin/infrastructure");
    await page.getByRole("button", { name: "Rotation history of gw.example.test" }).click();
    const rotations = card(page, "Rotation history — gw.example.test");
    await expect(rotations).toContainText("01 → 02");
    await expect(rotations).toContainText("expiring in 14 days");
    await expectAxeClean(page, "cert rotations");
  });
});
