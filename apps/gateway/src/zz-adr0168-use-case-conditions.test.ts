/**
 * ADR-0168 — the intake decision as a task with real outcomes.
 *
 * Pinned, through the real decide path on a real database:
 *  - APPROVE WITH CONDITIONS: conditions persist with the decision, show on the
 *    use-case detail (owner / met-by names, overdue) and list (openConditions);
 *    an open BEFORE-go-live condition makes the deploy gate refuse
 *    (`open_blocking_condition`); once met, the gate allows.
 *  - MARK MET: the condition's owner, the use case's owner or an admin (a
 *    before-go-live one: not the proposer, with a note — ADR-0170 §3); a
 *    stranger is refused 403; audited `use-case-condition-met`.
 *  - LIFETIME: approval stamps approved_at/approved_until — +6 months for a high
 *    tier, +12 for minimal; an approval past its valid-until is refused at the
 *    gate (`approval_expired`).
 *  - SEND BACK: `returned` needs a reason; the instance goes back to the
 *    questionnaire stage, the use case becomes needs_info, and a new
 *    questionnaire version re-requests sign-off.
 *  - VALIDATION: conditions / returned off an intake approval, conditions with
 *    denied/returned, malformed conditions and unknown owners are 422s by name,
 *    and nothing is written.
 *  - OLD BODIES: approved/denied (+reason) behave as before.
 *
 * Shared-database discipline: every fixture is created here under a run-unique
 * name, resolved by id, and no org-singleton state is written. Sign-offs are
 * decided by this file's own admin with a reason (an admin override, or a
 * self-review when the built-in template routes to the requester), so the test
 * does not depend on which intake template variant is active.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  runMigrations,
  useCaseConditions,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { renderEuAiActAnswersBlock, type EuAiActAnswers } from "@regulait/shared";
import { buildApp } from "./app.js";
import { setAssuranceGateModeForTest } from "./testing/assurance-mode.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";
// ADR-0186 A2+B: this suite pins pre-0186 single-approver tool-call approvals (decided
// through API keys, unsigned); signing and the sensitive quorum are relaxed for its run
// and restored after (M-068). Dual control and signing are proved in zz-b4ab-*.
let restoreApprovalSigning: (() => Promise<void>) | undefined;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g168-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
type Who = "admin" | "owner" | "condOwner" | "stranger";
const users = {} as Record<Who, { id: string; name: string; auth: { authorization: string } }>;
let db: Db;
let app: ReturnType<typeof buildApp>;

const minimalAnswers: EuAiActAnswers = {
  purposeDomain: "general-business",
  affectedPersons: [],
  decisionAutonomy: "informs-human",
  biometricUse: "none",
  emotionRecognition: false,
  socialScoring: false,
  manipulativeTechniques: false,
  profilesNaturalPersons: false,
  safetyComponent: false,
  interactsWithHumans: false,
  generatesSyntheticContent: false,
};
const highAnswers: EuAiActAnswers = { ...minimalAnswers, purposeDomain: "employment-hr", decisionAutonomy: "fully-automated" };
const questionnaire = (a: EuAiActAnswers, note = "") =>
  `# AI use-case intake questionnaire\n\n## 1. Purpose\nFilled by the proposer.${note}\n\n## 9. EU AI Act risk screening\n\n${renderEuAiActAnswersBlock(a)}`;

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

async function proposeToReview(label: string, answers: EuAiActAnswers) {
  const p = await post("/v1/use-cases", users.owner.auth, {
    name: `g168 ${label} ${RUN}`,
    description: "synthetic ADR-0168 fixture",
    businessContext: "conditions, lifetime and send-back",
    dataSensitivity: "internal",
  });
  expect(p.statusCode, p.body).toBe(201);
  const id = p.json().id as string;
  const instanceId = p.json().instance.id as string;
  const adv = await post(`/v1/workflows/instances/${instanceId}/advance`, users.owner.auth, { stageId: "plan" });
  expect(adv.statusCode, adv.body).toBe(200);
  const art = await post(`/v1/workflows/instances/${instanceId}/artifacts`, users.owner.auth, {
    stageId: "questionnaire",
    content: questionnaire(answers),
  });
  expect(art.statusCode, art.body).toBe(201);
  expect(art.json()).toMatchObject({ version: 1, status: "blocked_on_approval" });
  return { id, instanceId };
}

/** the instance's pending sign-off rows (resolved by instance id, never by name) */
const pendingSignoffs = (instanceId: string) =>
  db
    .select()
    .from(approvals)
    .where(and(eq(approvals.instanceId, instanceId), eq(approvals.stageId, "signoff"), eq(approvals.status, "pending")));

async function signoffId(instanceId: string): Promise<string> {
  const rows = await pendingSignoffs(instanceId);
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!.id;
}

const decide = (approvalId: string, body: Record<string, unknown>, who: Who = "admin") =>
  post(`/v1/approvals/${approvalId}/decide`, users[who].auth, body);

const gate = (useCaseId: string) => post("/v1/gates/deploy", users.owner.auth, { useCaseId, ref: `g168-${RUN}` });
const detail = (useCaseId: string) => get(`/v1/use-cases/${useCaseId}`, users.owner.auth);
const auditFor = (objectId: string, ruleId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));

function plusMonths(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const past = new Date(Date.now() - 2 * 86_400_000).toISOString();

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreApprovalSigning = await relaxApprovalSigningForTest(db);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["condOwner", false], ["stranger", false]] as const) {
    const name = `g168 ${k} ${RUN}`;
    const u = await post("/v1/users", AUTH, { email: `g168-${k.toLowerCase()}-${RUN}@example.com`, displayName: name, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await post(`/v1/users/${id}/keys`, AUTH, { name: "g168" })).json().token as string;
    users[k] = { id, name, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await restoreApprovalSigning?.();
  await restoreAdminKeyMfa?.();
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0168 approve with conditions", () => {
  it("persists the conditions with the decision, shows them, and a blocking one holds the deploy gate until met", async () => {
    const uc = await proposeToReview("conditions", highAnswers);
    const approvalId = await signoffId(uc.instanceId);
    const r = await decide(approvalId, {
      decision: "approved",
      reason: "approved subject to conditions (g168)",
      conditions: [
        { text: "DPIA signed by the DPO", ownerUserId: users.condOwner.id, dueAt: future, blocking: true },
        { text: "Quarterly bias review scheduled", dueAt: past, blocking: false },
      ],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe("approved");

    const rows = await db.select().from(useCaseConditions).where(eq(useCaseConditions.useCaseId, uc.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((c) => c.approvalId === approvalId && c.status === "open")).toBe(true);
    expect(await auditFor(uc.id, "use-case-conditions-imposed")).toHaveLength(1);

    const d = await detail(uc.id);
    expect(d.statusCode, d.body).toBe(200);
    const body = d.json();
    expect(body.useCase).toMatchObject({ status: "approved", euAiActTier: "high", approvalExpired: false });
    // high tier: valid for 6 months from the approval
    expect(body.useCase.approvedUntil).toBe(plusMonths(body.useCase.approvedAt, 6));
    const byText = new Map((body.conditions as any[]).map((c) => [c.text, c]));
    expect(byText.get("DPIA signed by the DPO")).toMatchObject({
      approvalId,
      ownerUserId: users.condOwner.id,
      ownerName: users.condOwner.name,
      dueAt: `${future}T23:59:59.999Z`,
      blocking: true,
      status: "open",
      metAt: null,
      metByName: null,
      overdue: false,
    });
    expect(byText.get("Quarterly bias review scheduled")).toMatchObject({
      ownerUserId: null,
      ownerName: null,
      blocking: false,
      overdue: true,
    });

    const list = await get("/v1/use-cases", users.owner.auth);
    const row = (list.json().useCases as any[]).find((u) => u.id === uc.id);
    expect(row).toMatchObject({ openConditions: 2, approvedUntil: body.useCase.approvedUntil });

    // the before-go-live condition holds the gate; the after-go-live one never does
    const held = await gate(uc.id);
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json().decision).toBe("deny");
    const blocks = (held.json().reasons as any[]).filter((x) => x.severity === "block");
    expect(blocks).toEqual([
      {
        code: "open_blocking_condition",
        severity: "block",
        message: `"g168 conditions ${RUN}" has 1 open before-go-live condition(s): DPIA signed by the DPO`,
        explanation: expect.any(String), // ADR-0180: every reason carries its plain-language meaning
        ref: { type: "use_case", id: uc.id },
      },
    ]);
    const denied = await auditFor(uc.id, "deploy-gate-denied");
    expect(denied.some((a) => (a.detail as any).reasons.some((x: any) => x.code === "open_blocking_condition"))).toBe(true);

    // the condition's owner marks it met → the gate allows
    const blocking = rows.find((c) => c.blocking)!;
    const met = await post(`/v1/use-cases/${uc.id}/conditions/${blocking.id}/met`, users.condOwner.auth, { note: "DPIA filed" });
    expect(met.statusCode, met.body).toBe(200);
    expect(met.json()).toMatchObject({ id: blocking.id, status: "met", metByName: users.condOwner.name, note: "DPIA filed", overdue: false });
    expect(met.json().metAt).toEqual(expect.any(String));
    expect(await auditFor(uc.id, "use-case-condition-met")).toHaveLength(1);
    const again = await post(`/v1/use-cases/${uc.id}/conditions/${blocking.id}/met`, users.condOwner.auth, {});
    expect(again.statusCode).toBe(409);

    const cleared = await gate(uc.id);
    expect(cleared.json().decision).toBe("allow");
    expect((await get("/v1/use-cases", users.owner.auth)).json().useCases.find((u: any) => u.id === uc.id).openConditions).toBe(1);
  });

  it("marking met: the condition owner, the use-case owner or an admin — a stranger is refused 403", async () => {
    const uc = await proposeToReview("authz", minimalAnswers);
    // ADR-0170 §3: "b" is an AFTER-go-live condition, which the use-case owner
    // may still close; the before-go-live ones ("a", "c") need someone other
    // than the proposer, with a note
    const r = await decide(await signoffId(uc.instanceId), {
      decision: "approved",
      reason: "approved (g168 authz)",
      conditions: ["a", "b", "c"].map((t) => ({ text: `condition ${t}`, ownerUserId: users.condOwner.id, dueAt: future, blocking: t !== "b" })),
    });
    expect(r.statusCode, r.body).toBe(200);
    const rows = await db.select().from(useCaseConditions).where(eq(useCaseConditions.useCaseId, uc.id));
    const id = (t: string) => rows.find((c) => c.text === `condition ${t}`)!.id;

    const stranger = await post(`/v1/use-cases/${uc.id}/conditions/${id("a")}/met`, users.stranger.auth, {});
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error).toBe("forbidden");
    const [still] = await db.select().from(useCaseConditions).where(eq(useCaseConditions.id, id("a")));
    expect(still!.status).toBe("open");

    expect((await post(`/v1/use-cases/${uc.id}/conditions/${id("a")}/met`, users.condOwner.auth, { note: "done" })).statusCode).toBe(200);
    expect((await post(`/v1/use-cases/${uc.id}/conditions/${id("b")}/met`, users.owner.auth, {})).statusCode).toBe(200);
    const proposer = await post(`/v1/use-cases/${uc.id}/conditions/${id("c")}/met`, users.owner.auth, { note: "done" });
    expect(proposer.statusCode).toBe(403);
    expect(proposer.json().error).toBe("proposer_cannot_close_blocking_condition");
    expect((await post(`/v1/use-cases/${uc.id}/conditions/${id("c")}/met`, users.admin.auth, { note: "checked" })).statusCode).toBe(200);
    // a condition id under the wrong use case is not found
    const other = await proposeToReview("authz-other", minimalAnswers);
    expect((await post(`/v1/use-cases/${other.id}/conditions/${id("a")}/met`, users.admin.auth, {})).statusCode).toBe(404);
    expect(await auditFor(uc.id, "use-case-condition-met")).toHaveLength(3);
  });
});

describe("ADR-0168 approval lifetime", () => {
  it("minimal tier is valid 12 months; past valid-until the gate refuses approval_expired", async () => {
    const uc = await proposeToReview("lifetime", minimalAnswers);
    const r = await decide(await signoffId(uc.instanceId), { decision: "approved", reason: "approved (g168 lifetime)" });
    expect(r.statusCode, r.body).toBe(200);
    let d = (await detail(uc.id)).json();
    expect(d.useCase).toMatchObject({ status: "approved", euAiActTier: "minimal", approvalExpired: false });
    expect(d.useCase.approvedUntil).toBe(plusMonths(d.useCase.approvedAt, 12));
    expect(d.conditions).toEqual([]);
    const approvedAudit = await auditFor(uc.id, "use-case-approved");
    expect((approvedAudit[0]!.detail as any)).toMatchObject({ lifetimeMonths: 12, lifetimeTier: "minimal" });
    expect((await gate(uc.id)).json().decision).toBe("allow");

    // the approval runs out
    await db
      .update(aiUseCases)
      .set({ approvedUntil: new Date("2026-01-15T00:00:00Z") })
      .where(eq(aiUseCases.id, uc.id));
    const expired = await gate(uc.id);
    expect(expired.json().decision).toBe("deny");
    expect(expired.json().reasons.filter((x: any) => x.severity === "block")).toEqual([
      {
        code: "approval_expired",
        severity: "block",
        message: `"g168 lifetime ${RUN}" approval expired on 2026-01-15; re-review required`,
        explanation: expect.any(String), // ADR-0180: every reason carries its plain-language meaning
        ref: { type: "use_case", id: uc.id },
      },
    ]);
    d = (await detail(uc.id)).json();
    expect(d.useCase.approvalExpired).toBe(true);
    const denied = await auditFor(uc.id, "deploy-gate-denied");
    expect(denied.some((a) => (a.detail as any).reasons.some((x: any) => x.code === "approval_expired"))).toBe(true);
  });
});

describe("ADR-0168 send back for information", () => {
  it("requires a reason; returns the instance to the questionnaire; resubmission re-requests sign-off", async () => {
    const uc = await proposeToReview("returned", minimalAnswers);
    const approvalId = await signoffId(uc.instanceId);
    // route THIS gate to an arm's-length reviewer (as an intake variant would),
    // so the reason rule is reached without the override / self-review rules
    // (which demand a reason of their own) answering first
    await db.update(approvals).set({ approverUserId: users.condOwner.id }).where(eq(approvals.id, approvalId));

    const noReason = await decide(approvalId, { decision: "returned" }, "condOwner");
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().error).toBe("return_reason_required");
    const blank = await decide(approvalId, { decision: "returned", reason: "   " }, "condOwner");
    expect(blank.statusCode).toBe(422);
    expect(blank.json().error).toBe("return_reason_required");

    const [beforeReturn] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, uc.instanceId));
    const r = await decide(approvalId, { decision: "returned", reason: "say which data sources feed the model" }, "condOwner");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: approvalId, status: "returned" });

    const [inst] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, uc.instanceId));
    expect(inst!.status).toBe("blocked_on_artifact");
    // AER-048: a return RE-OPENS the instance — a new round (check reports for
    // the old one are refused) and a new stage entry (an executor still
    // running from before the return cannot commit)
    expect(inst!.round).toBe(beforeReturn!.round + 1);
    expect(inst!.stageEntry).toBe(beforeReturn!.stageEntry + 1);
    const d = (await detail(uc.id)).json();
    expect(d.useCase.status).toBe("needs_info");
    expect(d.instance).toMatchObject({ status: "blocked_on_artifact", currentStageId: "questionnaire" });
    expect(await pendingSignoffs(uc.instanceId)).toHaveLength(0);
    expect(await auditFor(uc.id, "use-case-returned-for-info")).toHaveLength(1);
    expect(await auditFor(uc.instanceId, "workflow:approval_returned")).toHaveLength(1);
    // the returned gate is not decidable again
    expect((await decide(approvalId, { decision: "approved", reason: "late" })).statusCode).toBe(409);
    // the list filter knows the status
    const listed = await get("/v1/use-cases?status=needs_info", users.owner.auth);
    expect((listed.json().useCases as any[]).map((u) => u.id)).toContain(uc.id);

    // the proposer may edit what the reviewer asked about
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/use-cases/${uc.id}`,
      headers: users.owner.auth,
      payload: { businessContext: "now naming the data sources" },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    // a new questionnaire version re-requests the sign-off
    const art = await post(`/v1/workflows/instances/${uc.instanceId}/artifacts`, users.owner.auth, {
      stageId: "questionnaire",
      content: questionnaire(minimalAnswers, "\nData sources: CRM, ticketing."),
    });
    expect(art.statusCode, art.body).toBe(201);
    expect(art.json()).toMatchObject({ version: 2, status: "blocked_on_approval" });
    // the resubmission itself is forward progress from the stage the return
    // parked it at — not a second re-open
    const [afterResubmit] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, uc.instanceId));
    expect(afterResubmit!.round).toBe(inst!.round);
    const fresh = await pendingSignoffs(uc.instanceId);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).not.toBe(approvalId);
    expect((await detail(uc.id)).json().useCase.status).toBe("under_review");

    const ok = await decide(fresh[0]!.id, { decision: "approved", reason: "answered (g168)" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await detail(uc.id)).json().useCase.status).toBe("approved");
  });
});

describe("ADR-0168 validation", () => {
  it("refuses conditions and returned off their one valid shape by name, writing nothing", async () => {
    const uc = await proposeToReview("validation", minimalAnswers);
    const approvalId = await signoffId(uc.instanceId);
    const cond = { text: "a condition", dueAt: future, blocking: true };

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ decision: "denied", reason: "no", conditions: [cond] }, "conditions_only_on_intake_approval"],
      [{ decision: "returned", reason: "more", conditions: [cond] }, "conditions_only_on_intake_approval"],
      [{ decision: "approved", reason: "x", conditions: [{ ...cond, text: "y".repeat(501) }] }, "invalid_conditions"],
      [{ decision: "approved", reason: "x", conditions: [{ ...cond, text: "   " }] }, "invalid_conditions"],
      [{ decision: "approved", reason: "x", conditions: [{ ...cond, dueAt: "next week" }] }, "invalid_conditions"],
      [{ decision: "approved", reason: "x", conditions: [{ ...cond, dueAt: "2026-02-30" }] }, "invalid_conditions"],
      [{ decision: "approved", reason: "x", conditions: [{ text: "no tag", dueAt: future }] }, "invalid_conditions"],
      [{ decision: "approved", reason: "x", conditions: [{ ...cond, ownerUserId: "00000000-0000-4000-8000-000000000000" }] }, "unknown_condition_owner"],
    ];
    for (const [body, error] of cases) {
      const r = await decide(approvalId, body);
      expect(r.statusCode, `${JSON.stringify(body).slice(0, 80)} → ${r.body}`).toBe(422);
      expect(r.json().error).toBe(error);
    }
    // nothing was written: the gate is still pending, no condition exists
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("pending");
    expect(await db.select().from(useCaseConditions).where(eq(useCaseConditions.useCaseId, uc.id))).toEqual([]);

    // a NON-intake approval: neither outcome applies
    const [other] = await db
      .insert(approvals)
      // ADR-0186: a plain (unsigned, pre-0186 shape) tool-call approval
      .values({ userId: users.owner.id, objectType: "mcp_tool", approverUserId: users.admin.id, namedApproverUserId: users.admin.id, signatureMode: "off" })
      .returning({ id: approvals.id });
    const ret = await decide(other!.id, { decision: "returned", reason: "more" });
    expect(ret.statusCode).toBe(422);
    expect(ret.json().error).toBe("returned_only_on_intake_approval");
    const withCond = await decide(other!.id, { decision: "approved", reason: "x", conditions: [cond] });
    expect(withCond.statusCode).toBe(422);
    expect(withCond.json().error).toBe("conditions_only_on_intake_approval");
    // and an old body still decides it exactly as before
    const plain = await decide(other!.id, { decision: "approved" }, "admin");
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json()).toMatchObject({ id: other!.id, status: "approved", decidedBy: users.admin.id, decisionReason: null });
  });

  it("old approved/denied bodies are unchanged: no conditions, a lifetime only on approval, a generic 400 on a bad decision", async () => {
    const yes = await proposeToReview("old-approve", minimalAnswers);
    const yesId = await signoffId(yes.instanceId);
    const bad = await decide(yesId, { decision: "maybe" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("validation");
    const a = await decide(yesId, { decision: "approved", reason: "old client" });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({ status: "approved", decisionReason: "old client" });
    const ya = (await detail(yes.id)).json();
    expect(ya.useCase.status).toBe("approved");
    expect(ya.conditions).toEqual([]);
    expect(await auditFor(yes.id, "use-case-conditions-imposed")).toHaveLength(0);

    const no = await proposeToReview("old-deny", minimalAnswers);
    const d = await decide(await signoffId(no.instanceId), { decision: "denied", reason: "old client" });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().status).toBe("denied");
    const na = (await detail(no.id)).json();
    expect(na.useCase).toMatchObject({ status: "rejected", approvedAt: null, approvedUntil: null, approvalExpired: false });
    // an empty conditions list is the same as none
    const e = await proposeToReview("empty-conditions", minimalAnswers);
    const ed = await decide(await signoffId(e.instanceId), { decision: "denied", reason: "x", conditions: [] });
    expect(ed.statusCode, ed.body).toBe(200);
  });
});

describe("ADR-0168 reviewer access and the queue's use-case link", () => {
  it("an intake sign-off row carries its useCaseId; other kinds carry null", async () => {
    const uc = await proposeToReview("queue-link", minimalAnswers);
    const approvalId = await signoffId(uc.instanceId);
    const [other] = await db
      .insert(approvals)
      .values({ userId: users.owner.id, objectType: "mcp_tool", approverUserId: users.admin.id })
      .returning({ id: approvals.id });
    const q = await get("/v1/approvals?status=pending", users.admin.auth);
    expect(q.statusCode, q.body).toBe(200);
    const rows = q.json().approvals as any[];
    expect(rows.find((a) => a.id === approvalId)?.useCaseId).toBe(uc.id);
    expect(rows.find((a) => a.id === other!.id)).toHaveProperty("useCaseId", null);
  });

  it("the named reviewer reads the use case and its overview, read-only; an unrelated user cannot", async () => {
    const uc = await proposeToReview("reviewer-read", minimalAnswers);
    const approvalId = await signoffId(uc.instanceId);
    const asReviewer = users.condOwner.auth;
    // before the gate is theirs, the reviewer is a stranger like any other
    expect((await get(`/v1/use-cases/${uc.id}`, asReviewer)).statusCode).toBe(403);
    await db.update(approvals).set({ approverUserId: users.condOwner.id }).where(eq(approvals.id, approvalId));

    const d = await get(`/v1/use-cases/${uc.id}`, asReviewer);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().useCase.id).toBe(uc.id);
    const o = await get(`/v1/use-cases/${uc.id}/overview`, asReviewer);
    expect(o.statusCode, o.body).toBe(200);
    // read-only: no edit, and the list is not widened
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/use-cases/${uc.id}`,
      headers: asReviewer,
      payload: { businessContext: "reviewer edit" },
    });
    expect(patch.statusCode).toBe(403);
    const list = await get("/v1/use-cases", asReviewer);
    expect((list.json().useCases as any[]).some((u) => u.id === uc.id)).toBe(false);
    // an unrelated non-admin keeps the 403 on both reads
    expect((await get(`/v1/use-cases/${uc.id}`, users.stranger.auth)).statusCode).toBe(403);
    expect((await get(`/v1/use-cases/${uc.id}/overview`, users.stranger.auth)).statusCode).toBe(403);

    // having decided it, the reviewer can still read it back
    const r = await decide(approvalId, { decision: "approved", reason: "fine" }, "condOwner");
    expect(r.statusCode, r.body).toBe(200);
    expect((await get(`/v1/use-cases/${uc.id}`, asReviewer)).statusCode).toBe(200);
  });
});

// ADR-0180: this file pins the gate rules above; the continuous-assurance checks
// (strict `enforce` by default) are pinned in zz-adr0180-a3-required-tests.test.ts.
// M-068: the strict default is restored before the file ends.
let restoreAssuranceMode = async (): Promise<void> => {};
beforeAll(async () => {
  restoreAssuranceMode = await setAssuranceGateModeForTest(db, "off");
});
afterAll(async () => {
  await restoreAssuranceMode();
});
