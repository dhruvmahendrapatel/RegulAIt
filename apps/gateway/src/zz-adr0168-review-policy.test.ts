/**
 * ADR-0168 amendment (2026-10-03, afternoon) — the review policy, multi-role
 * review rounds, risk acceptance on a sign-off, resubmission, and the
 * recertification sweep. Pinned through the real decide path on a real
 * database:
 *  - POLICY: GET for any signed-in user, PUT admin-only and audited; 422s by
 *    name for an unknown role in a tier, a member-less role a tier uses,
 *    duplicate role ids, unknown users and malformed shapes.
 *  - ROUTING: each role a tier lists is ONE required review decidable by any
 *    member; the stage holds until every role approved (even under an "any"
 *    org quorum); the proposer can never decide one; a tier with no roles —
 *    or no policy — keeps the single named approver.
 *  - RISK ACCEPTANCE: only a named acceptor, only this use case's risks.
 *  - RESUBMISSION: needs_info → PATCH screening answers (tier recomputed) →
 *    new questionnaire version → under_review with a NEW review round.
 *  - RECERTIFICATION: an expired approval goes back to review (idempotent,
 *    audited); the deploy gate refuses until it is re-approved.
 *
 * Shared-database discipline: the review policy and the approval-quorum dial
 * are ORG SINGLETONS. This file snapshots both before it writes them and
 * restores them in afterAll (and the quorum in a finally). Every other
 * fixture is created here under a run-unique name and resolved by id; the
 * sweep is always narrowed to this file's own use cases.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiRisks,
  aiUseCases,
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  governanceReviewPolicy,
  gte,
  runMigrations,
  workflowInstances,
  type Db,
  type GovernanceReviewPolicyRow,
} from "@regulait/db";
import { renderEuAiActAnswersBlock, type EuAiActAnswers } from "@regulait/shared";
import { buildApp } from "./app.js";
import { schedulerJobRegistry, SCHEDULER_JOB_NAMES } from "./scheduler-jobs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g2rp-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
type Who = "admin" | "owner" | "sec1" | "sec2" | "priv" | "mr" | "stranger";
const users = {} as Record<Who, { id: string; name: string; auth: { authorization: string } }>;
let db: Db;
let app: ReturnType<typeof buildApp>;
let originalPolicy: GovernanceReviewPolicyRow | null = null;
const started = new Date(Date.now() - 1000);

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
const limitedAnswers: EuAiActAnswers = { ...minimalAnswers, interactsWithHumans: true };
const highAnswers: EuAiActAnswers = { ...minimalAnswers, purposeDomain: "employment-hr", decisionAutonomy: "fully-automated" };
const questionnaire = (a: EuAiActAnswers, note = "") =>
  `# AI use-case intake questionnaire\n\n## 1. Purpose\nFilled by the proposer.${note}\n\n## 9. EU AI Act risk screening\n\n${renderEuAiActAnswersBlock(a)}`;

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const put = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "PUT", url, headers, payload: payload as object });
const patch = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "PATCH", url, headers, payload: payload as object });
const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

/** the policy this file runs under (members resolved after the users exist) */
const policy = () => ({
  roles: [
    { id: "privacy", name: "Privacy", memberUserIds: [users.priv.id] },
    // the proposer is a Security member — they must never decide their own
    { id: "security", name: "Security", memberUserIds: [users.owner.id, users.sec1.id, users.sec2.id] },
    { id: "model-risk", name: "Model risk", memberUserIds: [users.mr.id] },
  ],
  tiers: {
    high: { roleIds: ["privacy", "security", "model-risk"], validityMonths: 6 },
    limited: { roleIds: ["security"], validityMonths: 3 },
    // a tier with only a lifetime: the single named approver still decides
    minimal: { roleIds: [], validityMonths: 9 },
  },
  riskAcceptorUserIds: [users.priv.id],
});
const setPolicy = async (body: unknown = policy()) => {
  const r = await put("/v1/governance/review-policy", users.admin.auth, body);
  expect(r.statusCode, r.body).toBe(200);
  return r;
};

async function propose(label: string, who: Who = "owner") {
  const p = await post("/v1/use-cases", users[who].auth, {
    name: `g2rp ${label} ${RUN}`,
    description: "synthetic review-policy fixture",
    businessContext: "multi-role review",
    dataSensitivity: "internal",
  });
  expect(p.statusCode, p.body).toBe(201);
  const id = p.json().id as string;
  const instanceId = p.json().instance.id as string;
  const adv = await post(`/v1/workflows/instances/${instanceId}/advance`, users[who].auth, { stageId: "plan" });
  expect(adv.statusCode, adv.body).toBe(200);
  return { id, instanceId };
}
async function proposeToReview(label: string, answers: EuAiActAnswers, who: Who = "owner") {
  const uc = await propose(label, who);
  const art = await post(`/v1/workflows/instances/${uc.instanceId}/artifacts`, users[who].auth, {
    stageId: "questionnaire",
    content: questionnaire(answers),
  });
  expect(art.statusCode, art.body).toBe(201);
  expect(art.json()).toMatchObject({ version: 1, status: "blocked_on_approval" });
  return uc;
}

const signoffRows = (instanceId: string) =>
  db.select().from(approvals).where(and(eq(approvals.instanceId, instanceId), eq(approvals.stageId, "signoff")));
const pendingRows = async (instanceId: string) => (await signoffRows(instanceId)).filter((r) => r.status === "pending");
async function rowFor(instanceId: string, roleId: string): Promise<string> {
  const rows = (await pendingRows(instanceId)).filter((r) => r.reviewRoleId === roleId);
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}
const decide = (approvalId: string, body: Record<string, unknown>, who: Who) =>
  post(`/v1/approvals/${approvalId}/decide`, users[who].auth, body);
const detail = (useCaseId: string, who: Who = "owner") => get(`/v1/use-cases/${useCaseId}`, users[who].auth);
const useCaseRow = async (id: string) => (await db.select().from(aiUseCases).where(eq(aiUseCases.id, id)))[0]!;
const instanceRow = async (id: string) => (await db.select().from(workflowInstances).where(eq(workflowInstances.id, id)))[0]!;
const auditFor = (objectId: string, ruleId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));
const gate = (useCaseId: string) => post("/v1/gates/deploy", users.owner.auth, { useCaseId, ref: `g2rp-${RUN}` });
const sweep = (useCaseIds: string[], who: Who = "admin") =>
  post("/v1/governance/recertification/sweep", users[who].auth, { useCaseIds });

function plusMonths(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  [originalPolicy = null] = await db.select().from(governanceReviewPolicy);
  const who: Array<[Who, boolean]> = [
    ["admin", true], ["owner", false], ["sec1", false], ["sec2", false], ["priv", false], ["mr", false], ["stranger", false],
  ];
  for (const [k, isAdmin] of who) {
    const name = `g2rp ${k} ${RUN}`;
    const u = await post("/v1/users", AUTH, { email: `g2rp-${k}-${RUN}@example.com`, displayName: name, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await post(`/v1/users/${id}/keys`, AUTH, { name: "g2rp" })).json().token as string;
    users[k] = { id, name, auth: { authorization: `Bearer ${token}` } };
  }
  await setPolicy();
}, 120_000);

afterAll(async () => {
  // the review policy is an org singleton: put back exactly what was there
  await db.delete(governanceReviewPolicy);
  if (originalPolicy) await db.insert(governanceReviewPolicy).values(originalPolicy);
  app.server.closeAllConnections();
  await app.close();
});

describe("review policy: read, write, validation", () => {
  it("any signed-in user reads it; only an admin writes it, audited, and the view names who", async () => {
    const r = await get("/v1/governance/review-policy", users.stranger.auth);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      roles: [
        { id: "privacy", name: "Privacy", memberUserIds: [users.priv.id] },
        { id: "security", name: "Security", memberUserIds: [users.owner.id, users.sec1.id, users.sec2.id] },
        { id: "model-risk", name: "Model risk", memberUserIds: [users.mr.id] },
      ],
      tiers: {
        high: { roleIds: ["privacy", "security", "model-risk"], validityMonths: 6 },
        limited: { roleIds: ["security"], validityMonths: 3 },
        minimal: { roleIds: [], validityMonths: 9 },
      },
      riskAcceptorUserIds: [users.priv.id],
      updatedByName: users.admin.name,
    });
    expect(r.json().updatedAt).toEqual(expect.any(String));

    const refused = await put("/v1/governance/review-policy", users.sec1.auth, policy());
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("admin_only");

    // a write is audited with the before and after
    await setPolicy({ ...policy(), updatedAt: "ignored", updatedByName: "ignored" });
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "review-policy-updated"), eq(auditLog.userId, users.admin.id), gte(auditLog.at, started)));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect((audits.at(-1)!.detail as any).after.tiers.limited).toEqual({ roleIds: ["security"], validityMonths: 3 });
  });

  it("refuses an inconsistent policy BY NAME, and stores nothing", async () => {
    const base = policy();
    const cases: Array<[unknown, number, string]> = [
      [{ ...base, tiers: { high: { roleIds: ["legal"] } } }, 422, "unknown_role"],
      [
        { ...base, roles: [...base.roles, { id: "legal", name: "Legal", memberUserIds: [] }], tiers: { high: { roleIds: ["legal"] } } },
        422,
        "role_without_members",
      ],
      [{ ...base, roles: [...base.roles, { id: "privacy", name: "Privacy 2", memberUserIds: [users.sec1.id] }] }, 422, "duplicate_role_id"],
      [{ ...base, tiers: { high: { roleIds: ["privacy", "privacy"] } } }, 422, "duplicate_role_in_tier"],
      [{ ...base, riskAcceptorUserIds: ["00000000-0000-4000-8000-000000000001"] }, 422, "unknown_user"],
      [{ ...base, roles: [{ id: "Privacy Team", name: "x", memberUserIds: [] }] }, 422, "invalid_review_policy"],
      [{ ...base, tiers: { high: { roleIds: ["privacy"], validityMonths: 37 } } }, 422, "invalid_review_policy"],
      [{ ...base, tiers: { severe: { roleIds: [] } } }, 422, "invalid_review_policy"],
    ];
    for (const [body, status, error] of cases) {
      const r = await put("/v1/governance/review-policy", users.admin.auth, body);
      expect(r.statusCode, `${error}: ${r.body}`).toBe(status);
      expect(r.json().error).toBe(error);
    }
    // nothing above was stored
    expect((await get("/v1/governance/review-policy", users.admin.auth)).json().tiers).toEqual(policy().tiers);
    // control: a member-less role is fine while NO tier routes to it
    const ok = await put("/v1/governance/review-policy", users.admin.auth, {
      ...base,
      roles: [...base.roles, { id: "legal", name: "Legal", memberUserIds: [] }],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await setPolicy();
  });
});

describe("multi-role review routing", () => {
  it("one role: any member decides; the stage completes; the tier's lifetime comes from the policy", async () => {
    const uc = await proposeToReview("one-role", limitedAnswers);
    const rows = await signoffRows(uc.instanceId);
    const pending = rows.filter((r) => r.status === "pending");
    expect(pending.map((r) => [r.reviewRoleId, r.reviewRoleName, r.reviewRound])).toEqual([["security", "Security", 1]]);
    // the template's single-approver row was replaced, not left decidable
    const replaced = rows.filter((r) => r.reviewRoleId === null);
    expect(replaced.length).toBeGreaterThan(0);
    expect(replaced.every((r) => r.status === "superseded")).toBe(true);
    // the row names a member who is not the proposer
    expect(pending[0]!.approverUserId).toBe(users.sec1.id);
    expect(await auditFor(uc.id, "use-case-review-round-opened")).toHaveLength(1);

    // sec2 — not the member the row names — sees it in their queue, with the role
    const queue = await get("/v1/approvals?status=pending", users.sec2.auth);
    const listed = (queue.json().approvals as any[]).find((a) => a.id === pending[0]!.id);
    expect(listed).toMatchObject({ useCaseId: uc.id, reviewRole: { id: "security", name: "Security" } });
    // a role member may read the use case they review
    expect((await detail(uc.id, "sec2")).statusCode).toBe(200);
    expect((await detail(uc.id, "stranger")).statusCode).toBe(403);
    // the detail lists the required review
    expect((await detail(uc.id)).json().reviews).toEqual([
      { roleId: "security", roleName: "Security", status: "pending", deciderName: null, decidedAt: null, approvalId: pending[0]!.id },
    ]);

    const r = await decide(pending[0]!.id, { decision: "approved" }, "sec2");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().adminOverride).toBeUndefined();
    const d = (await detail(uc.id)).json();
    expect(d.useCase).toMatchObject({ status: "approved", euAiActTier: "limited", recertification: false });
    expect(d.useCase.approvedUntil).toBe(plusMonths(d.useCase.approvedAt, 3));
    expect(d.reviews).toMatchObject([{ roleId: "security", status: "approved", deciderName: users.sec2.name }]);
    // the decided row stays visible to whoever decided it
    const decidedQueue = await get("/v1/approvals?status=approved", users.sec2.auth);
    expect((decidedQueue.json().approvals as any[]).some((a) => a.id === pending[0]!.id)).toBe(true);
  });

  it("three roles: each is one required review; the stage holds until all approve, even under an 'any' org quorum", async () => {
    const before = (await get("/v1/org/settings", AUTH)).json().settings.approvalQuorum as string;
    const q = await put("/v1/org/settings", AUTH, { approvalQuorum: "any" });
    expect(q.statusCode, q.body).toBe(200);
    try {
      const uc = await proposeToReview("three-roles", highAnswers);
      const pending = await pendingRows(uc.instanceId);
      expect(pending.map((r) => r.reviewRoleId).sort()).toEqual(["model-risk", "privacy", "security"]);
      expect(new Set(pending.map((r) => r.reviewRound))).toEqual(new Set([1]));

      expect((await decide(await rowFor(uc.instanceId, "privacy"), { decision: "approved" }, "priv")).statusCode).toBe(200);
      expect((await instanceRow(uc.instanceId)).status).toBe("blocked_on_approval");
      expect((await useCaseRow(uc.id)).status).toBe("under_review");
      expect((await decide(await rowFor(uc.instanceId, "security"), { decision: "approved" }, "sec1")).statusCode).toBe(200);
      expect((await instanceRow(uc.instanceId)).status).toBe("blocked_on_approval");
      // the last pending review is still decidable (not superseded by "any")
      expect((await pendingRows(uc.instanceId)).map((r) => r.reviewRoleId)).toEqual(["model-risk"]);

      const d1 = (await detail(uc.id)).json();
      expect(d1.reviews.map((x: any) => [x.roleName, x.status])).toEqual([
        ["Privacy", "approved"],
        ["Security", "approved"],
        ["Model risk", "pending"],
      ]);
      expect((await decide(await rowFor(uc.instanceId, "model-risk"), { decision: "approved" }, "mr")).statusCode).toBe(200);
      expect((await instanceRow(uc.instanceId)).status).toBe("completed");
      const d = (await detail(uc.id)).json();
      expect(d.useCase).toMatchObject({ status: "approved", euAiActTier: "high" });
      expect(d.useCase.approvedUntil).toBe(plusMonths(d.useCase.approvedAt, 6));
      expect(d.reviews.every((x: any) => x.status === "approved")).toBe(true);
    } finally {
      await put("/v1/org/settings", AUTH, { approvalQuorum: before });
    }
  });

  it("a denial by one role rejects the use case; the other reviews close", async () => {
    const uc = await proposeToReview("denied", highAnswers);
    const r = await decide(await rowFor(uc.instanceId, "security"), { decision: "denied", reason: "no threat model" }, "sec2");
    expect(r.statusCode, r.body).toBe(200);
    expect((await useCaseRow(uc.id)).status).toBe("rejected");
    expect(await pendingRows(uc.instanceId)).toHaveLength(0);
    const statuses = (await detail(uc.id)).json().reviews.map((x: any) => [x.roleId, x.status]);
    expect(statuses).toEqual([
      ["privacy", "superseded"],
      ["security", "denied"],
      ["model-risk", "superseded"],
    ]);
  });

  it("the proposer can never decide their own review — not as a role member, not as an admin", async () => {
    const uc = await proposeToReview("proposer", limitedAnswers);
    const id = await rowFor(uc.instanceId, "security");
    // the proposer is a Security member, yet the row is not in their queue
    const queue = await get("/v1/approvals?status=pending", users.owner.auth);
    expect((queue.json().approvals as any[]).some((a) => a.id === id)).toBe(false);
    const refused = await decide(id, { decision: "approved", reason: "my own" }, "owner");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("proposer_cannot_review");
    expect((await pendingRows(uc.instanceId)).map((r) => r.id)).toEqual([id]);

    // an admin who proposed is refused the same way, override reason or not
    const adminProposed = await proposeToReview("admin-proposer", limitedAnswers, "admin");
    const adminRow = await rowFor(adminProposed.instanceId, "security");
    const adminRefused = await decide(adminRow, { decision: "approved", reason: "admin override" }, "admin");
    expect(adminRefused.statusCode).toBe(403);
    expect(adminRefused.json().error).toBe("proposer_cannot_review");

    // a non-member who is not an admin is not a reviewer
    const stranger = await decide(id, { decision: "approved" }, "priv");
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error).toBe("not_the_named_approver");
    // control: another member decides it
    expect((await decide(id, { decision: "approved" }, "sec1")).statusCode).toBe(200);
    expect((await useCaseRow(uc.id)).status).toBe("approved");
  });

  it("a tier with no roles keeps the single named approver (with the policy's lifetime)", async () => {
    const uc = await proposeToReview("no-roles", minimalAnswers);
    const pending = await pendingRows(uc.instanceId);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((r) => r.reviewRoleId === null && r.reviewRound === null)).toBe(true);
    expect((await detail(uc.id)).json().reviews).toEqual([]);
    expect(await auditFor(uc.id, "use-case-review-round-opened")).toHaveLength(0);
    // decided as this file's admin with a reason, whichever template variant is active
    const r = await decide(pending[0]!.id, { decision: "approved", reason: "approved (g2rp single approver)" }, "admin");
    expect(r.statusCode, r.body).toBe(200);
    const d = (await detail(uc.id)).json();
    expect(d.useCase.status).toBe("approved");
    expect(d.useCase.approvedUntil).toBe(plusMonths(d.useCase.approvedAt, 9));
  });

  it("a single-approver row written before the policy routed the tier is replaced before anyone can decide it", async () => {
    await db.delete(governanceReviewPolicy);
    let legacy: string;
    let uc: { id: string; instanceId: string };
    try {
      uc = await proposeToReview("late-policy", limitedAnswers);
      const rows = await pendingRows(uc.instanceId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.reviewRoleId === null)).toBe(true);
      legacy = rows[0]!.id;
    } finally {
      await setPolicy();
    }
    // the policy now routes `limited` to Security: the old row is dead, and
    // deciding it (even as an admin with a reason) changes nothing
    const r = await decide(legacy, { decision: "approved", reason: "approved (g2rp late policy)" }, "admin");
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("approval_superseded");
    expect((await useCaseRow(uc.id)).status).toBe("under_review");
    expect((await pendingRows(uc.instanceId)).map((x) => x.reviewRoleId)).toEqual(["security"]);
  });

  it("no policy at all: today's single named approver, unchanged", async () => {
    await db.delete(governanceReviewPolicy);
    try {
      expect((await get("/v1/governance/review-policy", users.stranger.auth)).json()).toEqual({
        roles: [], tiers: {}, riskAcceptorUserIds: [], updatedAt: null, updatedByName: null,
      });
      const uc = await proposeToReview("no-policy", highAnswers);
      const rows = await signoffRows(uc.instanceId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === "pending" && r.reviewRoleId === null)).toBe(true);
      expect((await detail(uc.id)).json().reviews).toEqual([]);
      const r = await decide(rows[0]!.id, { decision: "approved", reason: "approved (g2rp no policy)" }, "admin");
      expect(r.statusCode, r.body).toBe(200);
      const d = (await detail(uc.id)).json();
      // ADR-0168's default lifetime for a high tier
      expect(d.useCase.approvedUntil).toBe(plusMonths(d.useCase.approvedAt, 6));
    } finally {
      await setPolicy();
    }
  });
});

describe("risk acceptance on a sign-off", () => {
  it("a named acceptor accepts this use case's risks with a rationale; anyone else, or another case's risk, is refused", async () => {
    const uc = await proposeToReview("risks", highAnswers);
    const other = await proposeToReview("risks-other", minimalAnswers);
    const mkRisk = async (useCaseId: string, title: string) => {
      const r = await post("/v1/risks", users.owner.auth, {
        title: `${title} ${RUN}`, description: "fixture", category: "hallucination", likelihood: "medium", impact: "high", useCaseId,
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().id as string;
    };
    const mine = await mkRisk(uc.id, "g2rp wrong answer");
    const theirs = await mkRisk(other.id, "g2rp other risk");
    const rationale = "Residual risk is tolerable with human review of every output.";
    const privRow = await rowFor(uc.instanceId, "privacy");
    const secRow = await rowFor(uc.instanceId, "security");

    // a reviewer who is not a risk acceptor
    const notAcceptor = await decide(secRow, { decision: "approved", acceptRisks: { riskIds: [mine], rationale } }, "sec1");
    expect(notAcceptor.statusCode).toBe(403);
    expect(notAcceptor.json().error).toBe("not_a_risk_acceptor");
    // a risk that is not this use case's
    const foreign = await decide(privRow, { decision: "approved", acceptRisks: { riskIds: [mine, theirs], rationale } }, "priv");
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json()).toMatchObject({ error: "risk_not_on_use_case", riskIds: [theirs] });
    // only with an approval
    const withReturn = await decide(
      privRow,
      { decision: "returned", reason: "more detail", acceptRisks: { riskIds: [mine], rationale } },
      "priv",
    );
    expect(withReturn.statusCode).toBe(422);
    expect(withReturn.json().error).toBe("risk_acceptance_only_on_intake_approval");
    const shortWhy = await decide(privRow, { decision: "approved", acceptRisks: { riskIds: [mine], rationale: "ok" } }, "priv");
    expect(shortWhy.statusCode).toBe(422);
    expect(shortWhy.json().error).toBe("invalid_risk_acceptance");
    // nothing above wrote anything
    expect((await db.select().from(aiRisks).where(eq(aiRisks.id, mine)))[0]!.status).toBe("open");
    expect((await pendingRows(uc.instanceId)).map((r) => r.reviewRoleId).sort()).toEqual(["model-risk", "privacy", "security"]);

    const ok = await decide(privRow, { decision: "approved", acceptRisks: { riskIds: [mine], rationale } }, "priv");
    expect(ok.statusCode, ok.body).toBe(200);
    const [risk] = await db.select().from(aiRisks).where(eq(aiRisks.id, mine));
    expect(risk).toMatchObject({ status: "accepted", acceptedByUserId: users.priv.id, acceptanceNote: rationale });
    const audits = await auditFor(uc.id, "use-case-risk-accepted");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ riskId: mine, approvalId: privRow });
    const d = (await detail(uc.id)).json();
    expect(d.risks.find((x: any) => x.id === mine)).toMatchObject({
      status: "accepted", acceptedByName: users.priv.name, acceptanceRationale: rationale,
    });
    expect(d.risks.find((x: any) => x.id === mine).acceptedAt).toEqual(expect.any(String));
    const ov = (await get(`/v1/use-cases/${uc.id}/overview`, users.owner.auth)).json();
    expect(ov.risks.find((x: any) => x.id === mine)).toMatchObject({ acceptedByName: users.priv.name, acceptanceRationale: rationale });
    // accepting is part of THIS decision only — the other reviews still stand
    expect((await useCaseRow(uc.id)).status).toBe("under_review");
  });
});

describe("resubmission after send-back", () => {
  it("needs_info → PATCH screening answers recomputes the tier → new questionnaire version → a NEW review round", async () => {
    const uc = await proposeToReview("resubmit", limitedAnswers);
    const secRow = await rowFor(uc.instanceId, "security");
    const back = await decide(secRow, { decision: "returned", reason: "say who the users are" }, "sec1");
    expect(back.statusCode, back.body).toBe(200);
    let d = (await detail(uc.id)).json();
    expect(d.useCase.status).toBe("needs_info");
    expect(d.resubmission).toEqual({
      allowed: true,
      screeningAnswers: limitedAnswers,
      questionnaire: { version: 1, content: questionnaire(limitedAnswers) },
      returnReason: "say who the users are",
      returnedByName: users.sec1.name,
    });
    expect(d.reviews).toMatchObject([{ roleId: "security", status: "returned", deciderName: users.sec1.name }]);
    // a reviewer reads it but may not resubmit it
    expect((await detail(uc.id, "sec1")).json().resubmission.allowed).toBe(false);

    // control: screening answers are refused while a use case is NOT sent back
    const live = await proposeToReview("resubmit-control", limitedAnswers);
    const notReturned = await patch(`/v1/use-cases/${live.id}`, users.owner.auth, { screeningAnswers: highAnswers });
    expect(notReturned.statusCode).toBe(409);
    expect(notReturned.json().error).toBe("screening_answers_only_when_returned");
    expect((await useCaseRow(live.id)).euAiActTier).toBe("limited");
    // a smuggled tier is still refused by name
    const tier = await patch(`/v1/use-cases/${uc.id}`, users.owner.auth, { euAiActTier: "minimal" });
    expect(tier.statusCode).toBe(422);

    const p = await patch(`/v1/use-cases/${uc.id}`, users.owner.auth, {
      description: "now says who the users are",
      screeningAnswers: highAnswers,
    });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ euAiActTier: "high", description: "now says who the users are", status: "needs_info" });
    const screened = await auditFor(uc.id, "use-case-eu-tier");
    expect(screened.some((a) => (a.detail as any).source === "resubmission" && (a.detail as any).tier === "high")).toBe(true);

    const art = await post(`/v1/workflows/instances/${uc.instanceId}/artifacts`, users.owner.auth, {
      stageId: "questionnaire",
      content: questionnaire(highAnswers, " Users: HR staff."),
    });
    expect(art.statusCode, art.body).toBe(201);
    expect(art.json()).toMatchObject({ version: 2, status: "blocked_on_approval" });
    d = (await detail(uc.id)).json();
    expect(d.useCase).toMatchObject({ status: "under_review", euAiActTier: "high" });
    expect(d.resubmission.allowed).toBe(false);
    // the new round follows the NEW tier: three reviews, all pending, round 2
    expect(d.reviews.map((x: any) => [x.roleId, x.status])).toEqual([
      ["privacy", "pending"],
      ["security", "pending"],
      ["model-risk", "pending"],
    ]);
    const roleRows = (await signoffRows(uc.instanceId)).filter((r) => r.reviewRoleId !== null);
    expect(roleRows.filter((r) => r.reviewRound === 2)).toHaveLength(3);
    // round 1 is kept as history
    expect(roleRows.filter((r) => r.reviewRound === 1).map((r) => r.status)).toEqual(["returned"]);
  });
});

describe("recertification sweep", () => {
  it("moves an expired approval back into review once (audited); the gate refuses until it is re-approved", async () => {
    const uc = await proposeToReview("recert", limitedAnswers);
    expect((await decide(await rowFor(uc.instanceId, "security"), { decision: "approved" }, "sec1")).statusCode).toBe(200);
    const fresh = await proposeToReview("recert-fresh", limitedAnswers);
    expect((await decide(await rowFor(fresh.instanceId, "security"), { decision: "approved" }, "sec1")).statusCode).toBe(200);
    expect((await gate(uc.id)).json().decision).toBe("allow");

    const lapsed = new Date("2026-02-01T00:00:00Z");
    await db.update(aiUseCases).set({ approvedUntil: lapsed }).where(eq(aiUseCases.id, uc.id));
    const roundBefore = (await instanceRow(uc.instanceId)).round;

    expect((await sweep([uc.id, fresh.id], "sec1")).statusCode).toBe(403);
    const s1 = await sweep([uc.id, fresh.id]);
    expect(s1.statusCode, s1.body).toBe(200);
    expect(s1.json()).toMatchObject({ evaluated: 2, movedToReview: 1, movedIds: [uc.id] });

    const row = await useCaseRow(uc.id);
    expect(row).toMatchObject({ status: "under_review", recertification: true });
    expect(row.approvedUntil!.toISOString()).toBe(lapsed.toISOString());
    // the unexpired one is untouched
    expect(await useCaseRow(fresh.id)).toMatchObject({ status: "approved", recertification: false });
    const inst = await instanceRow(uc.instanceId);
    expect(inst.status).toBe("blocked_on_approval");
    expect(inst.round).toBe(roundBefore + 1);
    const d = (await detail(uc.id)).json();
    expect(d.useCase).toMatchObject({ recertification: true, recertificationDueAt: lapsed.toISOString() });
    expect(d.instance.currentStageId).toBe("signoff");
    expect(d.reviews).toMatchObject([{ roleId: "security", status: "pending" }]);
    const listed = (await get("/v1/use-cases", users.owner.auth)).json().useCases.find((u: any) => u.id === uc.id);
    expect(listed).toMatchObject({ recertification: true, recertificationDueAt: lapsed.toISOString() });
    expect(await auditFor(uc.id, "use-case-recertification-started")).toHaveLength(1);
    expect(await auditFor(uc.instanceId, "workflow:recertification_reopened")).toHaveLength(1);
    const held = await gate(uc.id);
    expect(held.json().decision).toBe("deny");
    expect(held.json().reasons.map((x: any) => x.code)).toContain("use_case_not_approved");

    // idempotent: a second pass moves nothing and writes nothing
    const s2 = await sweep([uc.id, fresh.id]);
    expect(s2.json()).toMatchObject({ evaluated: 1, movedToReview: 0 });
    expect(await auditFor(uc.id, "use-case-recertification-started")).toHaveLength(1);
    expect((await pendingRows(uc.instanceId)).filter((r) => r.reviewRoleId !== null)).toHaveLength(1);
    expect((await gate(uc.id)).json().decision).toBe("deny");

    // re-approved by the round → approved again, a fresh lifetime, recertification cleared
    const r = await decide(await rowFor(uc.instanceId, "security"), { decision: "approved" }, "sec2");
    expect(r.statusCode, r.body).toBe(200);
    const after = (await detail(uc.id)).json();
    expect(after.useCase).toMatchObject({ status: "approved", recertification: false });
    expect(after.useCase.approvedUntil).toBe(plusMonths(after.useCase.approvedAt, 3));
    expect(Date.parse(after.useCase.approvedUntil)).toBeGreaterThan(Date.now());
    expect((await gate(uc.id)).json().decision).toBe("allow");
  });

  it("with no roles for the tier, recertification re-opens to the single named approver", async () => {
    const uc = await proposeToReview("recert-single", minimalAnswers);
    const first = (await pendingRows(uc.instanceId))[0]!;
    expect((await decide(first.id, { decision: "approved", reason: "approved (g2rp)" }, "admin")).statusCode).toBe(200);
    await db.update(aiUseCases).set({ approvedUntil: new Date("2026-02-01T00:00:00Z") }).where(eq(aiUseCases.id, uc.id));
    expect((await sweep([uc.id])).json()).toMatchObject({ movedToReview: 1 });
    const again = await pendingRows(uc.instanceId);
    expect(again.map((r) => [r.approverUserId, r.reviewRoleId])).toEqual([[first.approverUserId, null]]);
    expect((await detail(uc.id)).json().reviews).toEqual([]);
  });

  it("is registered as the scheduler job use-case-recertification", () => {
    const job = schedulerJobRegistry().get(SCHEDULER_JOB_NAMES.useCaseRecertification);
    expect(job?.name).toBe("use-case-recertification");
    expect(job?.adr).toBe("ADR-0168");
  });
});
