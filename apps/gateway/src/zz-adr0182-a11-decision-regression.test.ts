/**
 * ADR-0182 (ADR-0175 batch D4) A11 — decision regression, and decisions that
 * cite their versions. One red proof per rule:
 *
 *  - a decision without its record rolls back (the record write fails ⇒ the
 *    approval stays pending and the use case stays under review);
 *  - a review-policy PUT without a fresh matching preview → 409
 *    `decision_regression_not_previewed` (missing, a different body, stale,
 *    another subject, a moved baseline), audited, nothing stored;
 *  - changed outcomes without acceptance → 409
 *    `decision_regression_changes_unaccepted`;
 *  - the required-tests PUT and an `ai-use-case-intake/*` variant are gated
 *    the same way; a non-intake template is not;
 *  - every policy write bumps the version and appends a version row whose
 *    digest is the shared one;
 *  - `warn` records and allows; `off` skips and the response says so;
 *  - a reviewer override becomes a case snapshotting the use case's answers;
 *  - decision records are readable by the use case's owner and admins only;
 *  - DFX3 (D4G-04): retiring the DECIDING intake template is gated (candidate
 *    `{retireTemplateId}`, resolved to what decides afterwards); retiring one
 *    that does not decide is not;
 *  - DFX3 (D4G-07): gate, create and activation record are one transaction (a
 *    record that cannot be written leaves no template), and two creates
 *    admitted against one baseline serialise (the second sees it moved);
 *  - DFX3 (D4G-12): an intake candidate's digest is over the resolved, stored
 *    definition, so every form that resolves to it shares one digest.
 *
 * Global state (M-068): the review policy row and the gate setting are put
 * back as found; every case and template this file creates is retired.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  and,
  approvals,
  auditLog,
  createDb,
  decisionRegressionCases,
  decisionRegressionRuns,
  desc,
  eq,
  governanceReviewPolicy,
  governanceReviewPolicyVersions,
  gte,
  isNull,
  orgSettings,
  runMigrations,
  sql,
  useCaseDecisionRecords,
  workflowTemplates,
  type Db,
  type GovernanceReviewPolicyRow,
} from "@regulait/db";
import {
  accountabilityDigest,
  intakeTemplateDigest,
  DEFAULT_INTAKE_SIGNOFF_APPROVERS,
  EU_AI_ACT_RULESET_VERSION,
  INTAKE_ASSIST_RULES_VERSION,
  renderEuAiActAnswersBlock,
  SHIPPED_GOLDEN_CASES,
  type EuAiActAnswers,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { routeAuthClass } from "./route-classes.js";
import { aiUseCaseIntakeDefinition } from "./template-gallery.js";
import { activeIntakeTemplate } from "./decision-regression.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { previewedRetire, regressionAcceptance, setDecisionRegressionGateForTest } from "./testing/decision-regression.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a11-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const POLICY = "/v1/governance/review-policy";
const TESTS = "/v1/governance/review-policy/required-tests";
const PREVIEW = "/v1/governance/decision-regression/preview";
type Who = "admin" | "owner" | "priv" | "stranger";
const users = {} as Record<Who, { id: string; name: string; auth: { authorization: string } }>;
let db: Db;
let app: ReturnType<typeof buildApp>;
let originalPolicy: GovernanceReviewPolicyRow | null = null;
let restoreMfa: (() => Promise<void>) | undefined;
const started = new Date(Date.now() - 1000);
const createdTemplateIds: string[] = [];
const createdCaseIds: string[] = [];

type Method = "GET" | "PUT" | "POST" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

const answersOf = (id: string) => SHIPPED_GOLDEN_CASES.find((c) => c.id === id)!.answers;
const EU_KEYS = [
  "purposeDomain", "affectedPersons", "decisionAutonomy", "biometricUse", "emotionRecognition", "socialScoring",
  "manipulativeTechniques", "profilesNaturalPersons", "safetyComponent", "interactsWithHumans", "generatesSyntheticContent",
] as const;
const euOf = (a: Record<string, unknown>) => Object.fromEntries(EU_KEYS.map((k) => [k, a[k]])) as EuAiActAnswers;

/** the policy the gate tests submit: the high tier routed to one role */
const routedPolicy = () => ({
  roles: [{ id: "a11-privacy", name: "Privacy", memberUserIds: [users.priv.id] }],
  tiers: { high: { roleIds: ["a11-privacy"] } },
  riskAcceptorUserIds: [],
});
const emptyPolicy = { roles: [], tiers: {}, riskAcceptorUserIds: [] };

const preview = async (subject: string, candidate: unknown, who: Who = "admin") => {
  const r = await inject("POST", PREVIEW, users[who].auth, { subject, candidate });
  return r;
};
const livePolicy = async () => (await db.select().from(governanceReviewPolicy).where(eq(governanceReviewPolicy.id, "default")))[0] ?? null;
const refusals = (code: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, "decision-regression-gate-refused"), gte(auditLog.at, started), sql`${auditLog.detail}->>'code' = ${code}`));

/** put the policy to `body` through the gate (preview, accept) */
async function setPolicy(body: unknown) {
  const acc = await regressionAcceptance(app, users.admin.auth, "review_policy", body);
  const r = await inject("PUT", POLICY, users.admin.auth, { ...(body as object), ...acc });
  expect(r.statusCode, r.body).toBe(200);
  return r;
}

async function proposeToReview(label: string, answers: Record<string, unknown>, who: Who = "owner") {
  const p = await inject("POST", "/v1/use-cases", users[who].auth, {
    name: `a11 ${label} ${RUN}`,
    description: "synthetic decision-regression fixture",
    businessContext: "decision records",
    dataSensitivity: "internal",
    screeningAnswers: answers,
  });
  expect(p.statusCode, p.body).toBe(201);
  const id = p.json().id as string;
  const instanceId = p.json().instance.id as string;
  expect((await inject("POST", `/v1/workflows/instances/${instanceId}/advance`, users[who].auth, { stageId: "plan" })).statusCode).toBe(200);
  const content = `# AI use-case intake questionnaire\n\n## 1. Purpose\nSynthetic.\n\n## 9. EU AI Act risk screening\n\n${renderEuAiActAnswersBlock(euOf(answers))}`;
  const art = await inject("POST", `/v1/workflows/instances/${instanceId}/artifacts`, users[who].auth, { stageId: "questionnaire", content });
  expect(art.statusCode, art.body).toBe(201);
  return { id, instanceId };
}
const pendingSignoff = async (instanceId: string) =>
  (await db.select().from(approvals).where(and(eq(approvals.instanceId, instanceId), eq(approvals.stageId, "signoff"), eq(approvals.status, "pending"))))[0]!;
const recordsOf = (useCaseId: string) => db.select().from(useCaseDecisionRecords).where(eq(useCaseDecisionRecords.useCaseId, useCaseId));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  originalPolicy = await livePolicy();
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["priv", false], ["stranger", false]] as const) {
    const name = `a11 ${k} ${RUN}`;
    const u = await inject("POST", "/v1/users", AUTH, { email: `a11-${k}-${RUN}@example.com`, displayName: name, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a11" })).json().token as string;
    users[k] = { id, name, auth: { authorization: `Bearer ${token}` } };
  }
  // start from no routing (the single approver), through the gate
  await setPolicy(emptyPolicy);
}, 120_000);

afterAll(async () => {
  await db.update(orgSettings).set({ decisionRegressionGate: "enforce", decisionRegressionMaxAgeMinutes: 60 });
  await db.delete(governanceReviewPolicy);
  if (originalPolicy) await db.insert(governanceReviewPolicy).values(originalPolicy);
  if (createdTemplateIds.length) {
    for (const id of createdTemplateIds) {
      await db.update(workflowTemplates).set({ retiredAt: new Date(), retiredReason: "a11 cleanup" }).where(and(eq(workflowTemplates.id, id), isNull(workflowTemplates.retiredAt)));
    }
  }
  for (const id of createdCaseIds) {
    await db.update(decisionRegressionCases).set({ retiredAt: new Date() }).where(and(eq(decisionRegressionCases.id, id), isNull(decisionRegressionCases.retiredAt)));
  }
  await restoreMfa?.();
  app.server.closeAllConnections();
  await app.close();
});

describe("A11 routes: deliberate auth classes", () => {
  const ROUTES: Array<{ method: Method; pattern: string; url: string; cls: "admin" | "user" }> = [
    { method: "POST", pattern: PREVIEW, url: PREVIEW, cls: "admin" },
    { method: "GET", pattern: "/v1/governance/decision-regression/runs", url: "/v1/governance/decision-regression/runs", cls: "admin" },
    { method: "GET", pattern: "/v1/governance/decision-regression/runs/:runId", url: "/v1/governance/decision-regression/runs/00000000-0000-4000-8000-000000000002", cls: "admin" },
    { method: "GET", pattern: "/v1/governance/decision-regression/cases", url: "/v1/governance/decision-regression/cases", cls: "admin" },
    { method: "POST", pattern: "/v1/governance/decision-regression/cases", url: "/v1/governance/decision-regression/cases", cls: "admin" },
    { method: "DELETE", pattern: "/v1/governance/decision-regression/cases/:caseId", url: "/v1/governance/decision-regression/cases/00000000-0000-4000-8000-000000000002", cls: "admin" },
    { method: "GET", pattern: "/v1/use-cases/:useCaseId/decision-records", url: "/v1/use-cases/00000000-0000-4000-8000-000000000001/decision-records", cls: "user" },
  ];
  it.each(ROUTES)("$method $pattern is classed $cls; a member is refused, anonymous is 401", async (r) => {
    expect(routeAuthClass(r.method, r.pattern)).toBe(r.cls);
    const body = r.method === "GET" || r.method === "DELETE" ? undefined : {};
    const asMember = await inject(r.method, r.url, users.stranger.auth, body);
    expect(asMember.statusCode, asMember.body).toBe(r.cls === "admin" ? 403 : 404);
    expect((await inject(r.method, r.url, {}, body)).statusCode).toBe(401);
  });

  it("the shared default sign-off approver is the built-in intake shape's", () => {
    const signoff = aiUseCaseIntakeDefinition().stages.find((s) => s.type === "human_approval")!;
    expect(signoff.approvers).toEqual([...DEFAULT_INTAKE_SIGNOFF_APPROVERS]);
  });
});

describe("the preview", () => {
  it("runs the golden set under the live and the candidate policy and stores the run with both digests", async () => {
    const r = await preview("review_policy", routedPolicy());
    expect(r.statusCode, r.body).toBe(201);
    const run = r.json();
    const high = SHIPPED_GOLDEN_CASES.filter((c) => c.id.startsWith("high-") || c.id === "not-sure-profiling-counted-as-yes").map((c) => c.id).sort();
    expect(run).toMatchObject({ trigger: "preview", subject: "review_policy", changed: high.length });
    expect(run.cases).toBeGreaterThanOrEqual(SHIPPED_GOLDEN_CASES.length);
    expect(run.entries.map((e: { caseId: string }) => e.caseId).sort()).toEqual(high);
    const e = run.entries[0];
    expect(e.changed).toEqual(["requiredRoles", "approverRouting"]);
    expect(e.after.approverRouting).toBe("review roles: a11-privacy");
    expect(e.source).toBe("shipped");
    expect(Array.isArray(e.reasonsDiff)).toBe(true);
    expect(run.expiresAt).toEqual(expect.any(String));
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, run.id), eq(auditLog.ruleId, "decision-regression-previewed")));
    expect(audit!.detail).toMatchObject({ subject: "review_policy", changed: high.length });
    // listed and readable
    const list = (await inject("GET", "/v1/governance/decision-regression/runs?subject=review_policy", users.admin.auth)).json();
    expect(list.runs.some((x: { id: string }) => x.id === run.id)).toBe(true);
    const one = await inject("GET", `/v1/governance/decision-regression/runs/${run.id}`, users.admin.auth);
    expect(one.json().entries).toHaveLength(high.length);
  });

  it("refuses an invalid candidate with the schema's issues", async () => {
    const r = await preview("review_policy", { roles: "nope" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("invalid_candidate");
    const t = await preview("intake_template", { galleryId: "standard-change", name: "standard-a11" });
    expect(t.statusCode).toBe(422);
    expect(t.json().error).toBe("not_an_intake_template");
  });
});

describe("the activation gate (enforce, the strict default)", () => {
  it("a policy PUT with no preview is refused 409 decision_regression_not_previewed, audited, nothing stored", async () => {
    const before = await livePolicy();
    const r = await inject("PUT", POLICY, users.admin.auth, routedPolicy());
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "decision_regression_not_previewed", reason: "missing", subject: "review_policy" });
    expect((await refusals("decision_regression_not_previewed")).length).toBeGreaterThan(0);
    const after = await livePolicy();
    expect(after!.version).toBe(before!.version);
    expect(after!.tiers).toEqual(before!.tiers);
  });

  it("a run of a DIFFERENT body is refused (digest mismatch)", async () => {
    const other = (await preview("review_policy", { ...routedPolicy(), riskAcceptorUserIds: [users.priv.id] })).json();
    const r = await inject("PUT", POLICY, users.admin.auth, { ...routedPolicy(), regressionRunId: other.id, acceptChangedOutcomes: true, acceptReason: "routing high to privacy" });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "decision_regression_not_previewed", reason: "digest_mismatch", runId: other.id });
  });

  it("a run of another subject is refused", async () => {
    const tests = (await preview("required_tests", {})).json();
    const r = await inject("PUT", POLICY, users.admin.auth, { ...emptyPolicy, regressionRunId: tests.id });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().reason).toBe("subject_mismatch");
  });

  it("a stale run is refused (older than decision_regression_max_age_minutes)", async () => {
    const run = (await preview("review_policy", routedPolicy())).json();
    await db.update(decisionRegressionRuns).set({ createdAt: new Date(Date.now() - 61 * 60_000) }).where(eq(decisionRegressionRuns.id, run.id));
    const r = await inject("PUT", POLICY, users.admin.auth, { ...routedPolicy(), regressionRunId: run.id, acceptChangedOutcomes: true, acceptReason: "routing high to privacy" });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().reason).toBe("stale");
  });

  it("changed outcomes without acceptance are refused 409 decision_regression_changes_unaccepted", async () => {
    const run = (await preview("review_policy", routedPolicy())).json();
    expect(run.changed).toBeGreaterThan(0);
    const r = await inject("PUT", POLICY, users.admin.auth, { ...routedPolicy(), regressionRunId: run.id });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "decision_regression_changes_unaccepted", runId: run.id, changed: run.changed });
    expect((await refusals("decision_regression_changes_unaccepted")).length).toBeGreaterThan(0);
  });

  it("a fresh matching run with accepted changes saves: version bumped, version row appended, activation recorded", async () => {
    const before = await livePolicy();
    const run = (await preview("review_policy", routedPolicy())).json();
    const r = await inject("PUT", POLICY, users.admin.auth, {
      ...routedPolicy(),
      updatedAt: "echoed and ignored",
      regressionRunId: run.id,
      acceptChangedOutcomes: true,
      acceptReason: "routing the high tier to the privacy role",
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.version).toBe(before!.version + 1);
    expect(body.decisionRegression).toMatchObject({ mode: "enforce", outcome: "previewed", runId: run.id, changed: run.changed });
    const [v] = await db.select().from(governanceReviewPolicyVersions).where(eq(governanceReviewPolicyVersions.version, body.version));
    const stored = await livePolicy();
    expect(v!.digest).toBe(
      accountabilityDigest({ roles: stored!.roles, tiers: stored!.tiers, riskAcceptorUserIds: stored!.riskAcceptorUserIds, requiredTests: stored!.requiredTests }),
    );
    const [act] = await db.select().from(decisionRegressionRuns).where(eq(decisionRegressionRuns.id, body.decisionRegression.activationRunId));
    expect(act).toMatchObject({ trigger: "activation", subject: "review_policy", candidateDigest: run.candidateDigest, changed: run.changed });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, act!.id), eq(auditLog.ruleId, "decision-regression-activated")));
    expect(audit!.detail).toMatchObject({ previewRunId: run.id, acceptReason: "routing the high tier to the privacy role" });
  });

  it("a preview taken before another change landed is refused (the baseline moved)", async () => {
    const a = (await preview("review_policy", emptyPolicy)).json();
    // someone else changes the policy in between
    await setPolicy({ ...routedPolicy(), riskAcceptorUserIds: [users.priv.id] });
    const r = await inject("PUT", POLICY, users.admin.auth, { ...emptyPolicy, regressionRunId: a.id, acceptChangedOutcomes: true, acceptReason: "back to the single approver" });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().reason).toBe("baseline_moved");
  });

  it("a body that changes no outcome needs no acceptance", async () => {
    const live = await livePolicy();
    const same = { roles: live!.roles, tiers: live!.tiers, riskAcceptorUserIds: [] };
    const run = (await preview("review_policy", same)).json();
    expect(run.changed).toBe(0);
    const r = await inject("PUT", POLICY, users.admin.auth, { ...same, regressionRunId: run.id });
    expect(r.statusCode, r.body).toBe(200);
  });

  it("the required-tests PUT is gated the same way, and bumps the same version", async () => {
    const refused = await inject("PUT", TESTS, users.admin.auth, { minimal: { classes: [], freshnessDays: 30 } });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "decision_regression_not_previewed", subject: "required_tests" });
    const before = await livePolicy();
    const body = { minimal: { classes: [], freshnessDays: 30 } };
    const acc = await regressionAcceptance(app, users.admin.auth, "required_tests", body);
    const ok = await inject("PUT", TESTS, users.admin.auth, { ...body, ...acc });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().decisionRegression.outcome).toBe("previewed");
    expect((await livePolicy())!.version).toBe(before!.version + 1);
    // restore the strict defaults, through the gate
    const back = await regressionAcceptance(app, users.admin.auth, "required_tests", {});
    expect((await inject("PUT", TESTS, users.admin.auth, back)).statusCode).toBe(200);
  });

  it("an ai-use-case-intake variant is gated; a template of any other name is not", async () => {
    const name = `ai-use-case-intake/a11-${RUN}`;
    const refused = await inject("POST", "/v1/workflows/template-gallery/ai-use-case-intake/create", users.admin.auth, { name, approverUserId: users.priv.id });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "decision_regression_not_previewed", subject: "intake_template" });
    const acc = await regressionAcceptance(app, users.admin.auth, "intake_template", { galleryId: "ai-use-case-intake", name, approverUserId: users.priv.id });
    const ok = await inject("POST", "/v1/workflows/template-gallery/ai-use-case-intake/create", users.admin.auth, { name, approverUserId: users.priv.id, ...acc });
    expect(ok.statusCode, ok.body).toBe(201);
    createdTemplateIds.push(ok.json().id);
    expect(ok.json().decisionRegression.outcome).toBe("previewed");
    // retire it at once: the shared database's intake routing is not this file's
    // (D4G-04: it is the deciding template now, so its retirement is previewed too)
    expect((await previewedRetire(app, users.admin.auth, ok.json().id, "a11 variant gate check")).statusCode).toBe(200);
    const plain = await inject("POST", "/v1/workflows/template-gallery/standard-change/create", users.admin.auth, { name: `a11-standard-${RUN}` });
    expect(plain.statusCode, plain.body).toBe(201);
    createdTemplateIds.push(plain.json().id);
    expect(plain.json().decisionRegression).toBeUndefined();
  });
});

describe("relaxed modes (audited through PUT /v1/org/settings)", () => {
  it("warn records the missing preview, computes the regression now and saves", async () => {
    const restore = await setDecisionRegressionGateForTest(app, users.admin.auth, "warn");
    try {
      const r = await inject("PUT", POLICY, users.admin.auth, emptyPolicy);
      expect(r.statusCode, r.body).toBe(200);
      const g = r.json().decisionRegression;
      expect(g).toMatchObject({ mode: "warn", outcome: "warned", runId: null });
      expect(g.detail).toContain("warn mode");
      const [act] = await db.select().from(decisionRegressionRuns).where(eq(decisionRegressionRuns.id, g.activationRunId));
      expect(act!.trigger).toBe("activation");
      expect(act!.changed).toBe(g.changed);
      const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, act!.id), eq(auditLog.ruleId, "decision-regression-gate-warned")));
      expect(audit!.detail).toMatchObject({ code: "decision_regression_not_previewed", problemReason: "missing" });
    } finally {
      await restore();
    }
  });

  it("off skips the check, and the response says the change was not checked", async () => {
    const restore = await setDecisionRegressionGateForTest(app, users.admin.auth, "off");
    try {
      const r = await inject("PUT", POLICY, users.admin.auth, emptyPolicy);
      expect(r.statusCode, r.body).toBe(200);
      const g = r.json().decisionRegression;
      expect(g).toMatchObject({ mode: "off", outcome: "skipped", activationRunId: null });
      expect(g.detail).toContain("was not checked against the golden set");
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "decision-regression-gate-skipped"), eq(auditLog.userId, users.admin.id)))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(audit!.reason).toContain("gate is off");
      // the relaxation itself was audited with its transition
      const [setting] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, users.admin.id), sql`${auditLog.detail}->'transitions' ? 'decisionRegressionGate'`))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(setting!.detail).toMatchObject({ transitions: { decisionRegressionGate: { from: "enforce", to: "off" } } });
    } finally {
      await restore();
    }
    expect((await inject("PUT", POLICY, users.admin.auth, emptyPolicy)).statusCode).toBe(409);
  });
});

describe("decision records", () => {
  it("an approval writes one record citing every version, in the decision's transaction", async () => {
    const uc = await proposeToReview("approve", answersOf("limited-customer-chatbot"));
    const row = await pendingSignoff(uc.instanceId);
    const d = await inject("POST", `/v1/approvals/${row.id}/decide`, users.admin.auth, { decision: "approved", reason: "approved (a11 decision record)" });
    expect(d.statusCode, d.body).toBe(200);
    const recs = await recordsOf(uc.id);
    expect(recs).toHaveLength(1);
    const live = await livePolicy();
    const [ucRow] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, uc.id));
    expect(recs[0]).toMatchObject({
      outcome: "approved",
      approvalId: row.id,
      decidedBy: users.admin.id,
      workflowInstanceId: uc.instanceId,
      reviewPolicyVersion: live!.version,
      requiredTestsDigest: accountabilityDigest(live!.requiredTests ?? {}),
      euAiActRulesetVersion: EU_AI_ACT_RULESET_VERSION,
      intakeAssistVersion: INTAKE_ASSIST_RULES_VERSION,
      answersDigest: accountabilityDigest(ucRow!.intakeAnswers),
    });
    expect(recs[0]!.intakeTemplateName).toMatch(/^ai-use-case-intake/);
    expect(recs[0]!.intakeDefinitionDigest).toMatch(/^[0-9a-f]{64}$/);
    // readable by the owner and an admin, nobody else
    const mine = await inject("GET", `/v1/use-cases/${uc.id}/decision-records`, users.owner.auth);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().records[0]).toMatchObject({ outcome: "approved", decidedByName: users.admin.name, reviewPolicyVersion: live!.version });
    expect((await inject("GET", `/v1/use-cases/${uc.id}/decision-records`, users.admin.auth)).statusCode).toBe(200);
    expect((await inject("GET", `/v1/use-cases/${uc.id}/decision-records`, users.stranger.auth)).statusCode).toBe(403);
  });

  it("a return for information and a rejection are records too", async () => {
    const uc = await proposeToReview("return", answersOf("minimal-internal-search"));
    const row = await pendingSignoff(uc.instanceId);
    const ret = await inject("POST", `/v1/approvals/${row.id}/decide`, users.admin.auth, { decision: "returned", reason: "returned (a11): add the owner's data map" });
    expect(ret.statusCode, ret.body).toBe(200);
    expect((await recordsOf(uc.id)).map((r) => r.outcome)).toEqual(["needs_info"]);
    const uc2 = await proposeToReview("reject", answersOf("minimal-internal-search"));
    const row2 = await pendingSignoff(uc2.instanceId);
    const den = await inject("POST", `/v1/approvals/${row2.id}/decide`, users.admin.auth, { decision: "denied", reason: "denied (a11 decision record)" });
    expect(den.statusCode, den.body).toBe(200);
    expect((await recordsOf(uc2.id)).map((r) => [r.outcome, r.approvalId])).toEqual([["rejected", row2.id]]);
  });

  it("RED PROOF: a decision whose record cannot be written rolls back with it", async () => {
    const uc = await proposeToReview("rollback", answersOf("minimal-internal-search"));
    const row = await pendingSignoff(uc.instanceId);
    const fn = `a11_refuse_record_${RUN}`;
    await db.execute(sql.raw(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'a11 test: decision record refused'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER "${fn}" BEFORE INSERT ON "use_case_decision_records" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`));
    try {
      const d = await inject("POST", `/v1/approvals/${row.id}/decide`, users.admin.auth, { decision: "approved", reason: "approved (a11 rollback)" });
      expect(d.statusCode, d.body).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS "${fn}" ON "use_case_decision_records"`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS "${fn}"()`));
    }
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after!.status).toBe("pending");
    const [ucRow] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, uc.id));
    expect(ucRow!.status).toBe("under_review");
    expect(await recordsOf(uc.id)).toEqual([]);
    // the same decision, with the record writable, goes through
    const again = await inject("POST", `/v1/approvals/${row.id}/decide`, users.admin.auth, { decision: "approved", reason: "approved (a11 rollback retry)" });
    expect(again.statusCode, again.body).toBe(200);
    expect((await recordsOf(uc.id)).map((r) => r.outcome)).toEqual(["approved"]);
  });
});

describe("reviewer overrides become cases", () => {
  it("snapshots the use case's answers, joins every later preview, and retires", async () => {
    const uc = await proposeToReview("override", answersOf("high-credit-scoring"));
    const c = await inject("POST", "/v1/governance/decision-regression/cases", users.admin.auth, {
      fromUseCaseId: uc.id,
      label: `a11 reviewer override ${RUN}`,
      expected: { tier: "high", requiredRoles: ["a11-privacy"] },
    });
    expect(c.statusCode, c.body).toBe(201);
    const created = c.json();
    createdCaseIds.push(created.id);
    const [ucRow] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, uc.id));
    expect(created).toMatchObject({ source: "override", fromUseCaseId: uc.id, answers: ucRow!.intakeAnswers });
    expect(created.outcome.tier).toBe("high");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, created.id), eq(auditLog.ruleId, "decision-regression-case-created")));
    expect(audit!.detail).toMatchObject({ fromUseCaseId: uc.id, expectedFields: ["tier", "requiredRoles"] });
    // listed with the live outcome; the next preview runs it
    const list = (await inject("GET", "/v1/governance/decision-regression/cases", users.admin.auth)).json();
    const listed = list.cases.find((x: { id: string }) => x.id === created.id);
    expect(listed.source).toBe("override");
    expect(list.cases.filter((x: { source: string }) => x.source === "shipped")).toHaveLength(SHIPPED_GOLDEN_CASES.length);
    const run = (await preview("review_policy", routedPolicy())).json();
    expect(run.entries.some((e: { caseId: string; source: string }) => e.caseId === created.id && e.source === "override")).toBe(true);
    // retire: once, then 409; a shipped case is never retired here
    expect((await inject("DELETE", `/v1/governance/decision-regression/cases/${created.id}`, users.admin.auth)).statusCode).toBe(200);
    expect((await inject("DELETE", `/v1/governance/decision-regression/cases/${created.id}`, users.admin.auth)).json().error).toBe("already_retired");
    const shipped = await inject("DELETE", `/v1/governance/decision-regression/cases/${SHIPPED_GOLDEN_CASES[0]!.id}`, users.admin.auth);
    expect(shipped.statusCode).toBe(409);
    expect(shipped.json().error).toBe("shipped_case");
  });

  it("refuses a use case with no stored answers, and an expectation of unknown fields", async () => {
    const p = await inject("POST", "/v1/use-cases", users.owner.auth, {
      name: `a11 no answers ${RUN}`,
      description: "synthetic",
      businessContext: "none",
      dataSensitivity: "internal",
    });
    expect(p.statusCode, p.body).toBe(201);
    const r = await inject("POST", "/v1/governance/decision-regression/cases", users.admin.auth, { fromUseCaseId: p.json().id, label: "x", expected: { tier: "high" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("use_case_has_no_answers");
    const bad = await inject("POST", "/v1/governance/decision-regression/cases", users.admin.auth, { answers: {}, label: "x", expected: { verdict: "yes" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("invalid_expected_outcome");
    expect((await inject("POST", "/v1/governance/decision-regression/cases", users.stranger.auth, { answers: {}, label: "x", expected: { tier: "high" } })).statusCode).toBe(403);
  });
});

describe("A11 integrator: POST /v1/workflows/templates", () => {
  it("an ai-use-case-intake template by definition is gated; with a preview of {name, definition} it is created", async () => {
    const name = `ai-use-case-intake/a11-direct-${RUN}`;
    const definition = { ...aiUseCaseIntakeDefinition(), workflow: name };
    const refused = await inject("POST", "/v1/workflows/templates", users.admin.auth, { name, definition });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "decision_regression_not_previewed", subject: "intake_template" });
    const acc = await regressionAcceptance(app, users.admin.auth, "intake_template", { name, definition });
    const ok = await inject("POST", "/v1/workflows/templates", users.admin.auth, { name, definition, ...acc });
    expect(ok.statusCode, ok.body).toBe(201);
    createdTemplateIds.push(ok.json().id);
    expect(ok.json().decisionRegression.outcome).toBe("previewed");
    const plain = await inject("POST", "/v1/workflows/templates", users.admin.auth, { name: `a11-plain-${RUN}`, definition: { ...definition, workflow: "x" } });
    expect(plain.statusCode, plain.body).toBe(201);
    createdTemplateIds.push(plain.json().id);
  });
});

describe("DFX3: every write that changes the deciding intake template (D4G-04, D4G-07, D4G-12)", () => {
  const variant = async (label: string, approverUserId: string) => {
    const name = `ai-use-case-intake/a11-${label}-${RUN}`;
    const acc = await regressionAcceptance(app, users.admin.auth, "intake_template", { galleryId: "ai-use-case-intake", name, approverUserId });
    const r = await inject("POST", "/v1/workflows/template-gallery/ai-use-case-intake/create", users.admin.auth, { name, approverUserId, ...acc });
    expect(r.statusCode, r.body).toBe(201);
    createdTemplateIds.push(r.json().id);
    const [row] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, r.json().id));
    return { id: row!.id, name, runId: acc.regressionRunId, row: row! };
  };
  const retiredAt = async (id: string) => (await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, id)))[0]!.retiredAt;

  it("D4G-12: the preview's digest is the digest of the definition the create stores, whatever form names it", async () => {
    const v = await variant("digest", users.priv.id);
    const [run] = await db.select().from(decisionRegressionRuns).where(eq(decisionRegressionRuns.id, v.runId));
    expect(run!.candidateDigest).toBe(intakeTemplateDigest({ name: v.row.name, definition: v.row.definition as never }));
    const [activation] = await db
      .select()
      .from(decisionRegressionRuns)
      .where(and(eq(decisionRegressionRuns.trigger, "activation"), eq(decisionRegressionRuns.candidateDigest, run!.candidateDigest)));
    expect(activation, "the activation cites the same digest").toBeDefined();
    // the {name, definition} form of the stored definition resolves to the same template: one digest
    const same = await preview("intake_template", { name: v.row.name, definition: v.row.definition });
    expect(same.statusCode, same.body).toBe(201);
    expect(same.json().candidateDigest).toBe(run!.candidateDigest);
    expect((await previewedRetire(app, users.admin.auth, v.id, "a11 dfx3 digest cleanup")).statusCode).toBe(200);
  });

  it("D4G-04: retiring the deciding variant is refused without a preview; previewed and accepted, the next variant decides", async () => {
    const lite = await variant("lite", users.owner.id);
    const strict = await variant("strict", users.priv.id);
    expect((await activeIntakeTemplate(db))!.id).toBe(strict.id);
    const refused = await inject("POST", `/v1/workflows/templates/${strict.id}/retire`, users.admin.auth, { reason: "a11 dfx3 retire gate" });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "decision_regression_not_previewed", reason: "missing", subject: "intake_template" });
    expect(await retiredAt(strict.id), "a refused retire changes nothing").toBeNull();
    expect((await activeIntakeTemplate(db))!.id).toBe(strict.id);
    // the preview of the retirement resolves to what decides afterwards: /lite
    const p = await preview("intake_template", { retireTemplateId: strict.id });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json().candidateDigest).toBe(intakeTemplateDigest({ name: lite.row.name, definition: lite.row.definition as never }));
    expect(p.json().changed, "the sign-off moves from one approver to another").toBeGreaterThan(0);
    const unaccepted = await inject("POST", `/v1/workflows/templates/${strict.id}/retire`, users.admin.auth, { reason: "a11 dfx3 retire gate", regressionRunId: p.json().id });
    expect(unaccepted.statusCode, unaccepted.body).toBe(409);
    expect(unaccepted.json().error).toBe("decision_regression_changes_unaccepted");
    const ok = await inject("POST", `/v1/workflows/templates/${strict.id}/retire`, users.admin.auth, {
      reason: "a11 dfx3 retire gate",
      regressionRunId: p.json().id,
      acceptChangedOutcomes: true,
      acceptReason: "the lighter variant decides again, on purpose",
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().decisionRegression).toMatchObject({ outcome: "previewed", runId: p.json().id });
    expect(await retiredAt(strict.id)).not.toBeNull();
    expect((await activeIntakeTemplate(db))!.id).toBe(lite.id);
    // a variant that does NOT decide is retired without a preview (nothing changes who signs off)
    const newer = await variant("newer", users.priv.id);
    const quiet = await inject("POST", `/v1/workflows/templates/${lite.id}/retire`, users.admin.auth, { reason: "a11 dfx3 not deciding" });
    expect(quiet.statusCode, quiet.body).toBe(200);
    expect(quiet.json().decisionRegression).toBeUndefined();
    expect((await previewedRetire(app, users.admin.auth, newer.id, "a11 dfx3 cleanup")).statusCode).toBe(200);
  });

  it("D4G-07: a create whose activation record cannot be written leaves no template behind", async () => {
    const name = `ai-use-case-intake/a11-atomic-${RUN}`;
    const acc = await regressionAcceptance(app, users.admin.auth, "intake_template", { galleryId: "ai-use-case-intake", name, approverUserId: users.priv.id });
    const fn = `a11_refuse_activation_${RUN}`;
    await db.execute(
      sql.raw(
        `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
          `IF NEW.trigger = 'activation' AND NEW.created_by = '${users.admin.id}' THEN RAISE EXCEPTION 'a11 test: activation refused'; END IF; ` +
          `RETURN NEW; END $$`,
      ),
    );
    await db.execute(sql.raw(`CREATE TRIGGER "${fn}" BEFORE INSERT ON "decision_regression_runs" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`));
    try {
      const r = await inject("POST", "/v1/workflows/template-gallery/ai-use-case-intake/create", users.admin.auth, { name, approverUserId: users.priv.id, ...acc });
      expect(r.statusCode, r.body).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS "${fn}" ON "decision_regression_runs"`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS "${fn}"()`));
    }
    const rows = await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, name));
    expect(rows, "the template rolled back with its record").toEqual([]);
  });

  it("D4G-07: two creates admitted against one baseline serialise; the second sees the baseline moved", async () => {
    const names = [`ai-use-case-intake/a11-race-a-${RUN}`, `ai-use-case-intake/a11-race-b-${RUN}`];
    const accs: Array<Awaited<ReturnType<typeof regressionAcceptance>>> = [];
    for (const name of names) {
      accs.push(await regressionAcceptance(app, users.admin.auth, "intake_template", { galleryId: "ai-use-case-intake", name, approverUserId: users.priv.id }));
    }
    const out = await Promise.all(
      names.map((name, i) =>
        inject("POST", "/v1/workflows/template-gallery/ai-use-case-intake/create", users.admin.auth, { name, approverUserId: users.priv.id, ...accs[i] }),
      ),
    );
    for (const r of out) if (r.statusCode === 201) createdTemplateIds.push(r.json().id);
    expect(out.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(out.find((r) => r.statusCode === 409)!.json().reason).toBe("baseline_moved");
    const winner = out.find((r) => r.statusCode === 201)!.json().id as string;
    expect((await previewedRetire(app, users.admin.auth, winner, "a11 dfx3 race cleanup")).statusCode).toBe(200);
  });
});
