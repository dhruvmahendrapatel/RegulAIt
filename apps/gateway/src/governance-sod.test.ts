/**
 * ADR-0170 — separation of duties on the DECIDE path, pinned through the real
 * decide route on a real database:
 *  §1  each required review in a round is decided by a different person —
 *      one person in two roles, or an admin overriding twice, is refused
 *      (`reviewer_already_decided_round`); a NEW round starts clean.
 *  §2  a review-role row is decided by a LIVE role member (or an admin
 *      override with a reason): being the stored approver is not enough
 *      (removed member, claim); delegation is honoured only from a live
 *      member who is not the proposer; routing, claim and SLA reassignment
 *      never re-point a review-role row.
 *  §8  the proposer cannot accept risks on their own use case; a deactivated
 *      user cannot be named a condition owner; the review-round sync a decide
 *      performs BEFORE authorization is attributed to the system, not to the
 *      (possibly refused) caller.
 *
 * Shared-database discipline: the review policy and the delegation switch are
 * ORG SINGLETONS — both are snapshotted before this file writes them and put
 * back in afterAll. Every other fixture is created here under a run-unique
 * name and resolved by id; the routing rule lives only inside a rolled-back
 * transaction, so no other file ever sees it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvalAssignmentRules,
  approvalAssignments,
  approvals,
  auditLog,
  createDb,
  eq,
  governanceReviewPolicy,
  inArray,
  runMigrations,
  users as usersTable,
  type Db,
  type GovernanceReviewPolicyRow,
} from "@regulait/db";
import { renderEuAiActAnswersBlock, type EuAiActAnswers } from "@regulait/shared";
import { buildApp } from "./app.js";
import { ensureAssignment, reassignApprovalApprover } from "./workbench.js";

type ApprovalRow = typeof approvals.$inferSelect;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `sod170-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
type Who = "admin" | "owner" | "dual" | "priv" | "sec1" | "stranger" | "gone";
const users = {} as Record<Who, { id: string; name: string; auth: { authorization: string } }>;
let db: Db;
let app: ReturnType<typeof buildApp>;
let originalPolicy: GovernanceReviewPolicyRow | null = null;
let originalDelegation: boolean | null = null;

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

/** `dual` sits in BOTH roles a high-tier round requires */
const policy = () => ({
  roles: [
    { id: "privacy", name: "Privacy", memberUserIds: [users.dual.id, users.priv.id] },
    { id: "security", name: "Security", memberUserIds: [users.dual.id, users.sec1.id] },
  ],
  tiers: {
    high: { roleIds: ["privacy", "security"] },
    limited: { roleIds: ["security"] },
    minimal: { roleIds: [] },
  },
  riskAcceptorUserIds: [users.admin.id, users.priv.id],
});
const setPolicy = async (body: unknown = policy()) => {
  const r = await put("/v1/governance/review-policy", users.admin.auth, body);
  expect(r.statusCode, r.body).toBe(200);
};

async function proposeToReview(label: string, answers: EuAiActAnswers, who: Who = "owner") {
  const p = await post("/v1/use-cases", users[who].auth, {
    name: `sod170 ${label} ${RUN}`,
    description: "synthetic separation-of-duties fixture",
    businessContext: "ADR-0170",
    dataSensitivity: "internal",
  });
  expect(p.statusCode, p.body).toBe(201);
  const id = p.json().id as string;
  const instanceId = p.json().instance.id as string;
  const adv = await post(`/v1/workflows/instances/${instanceId}/advance`, users[who].auth, { stageId: "plan" });
  expect(adv.statusCode, adv.body).toBe(200);
  const art = await post(`/v1/workflows/instances/${instanceId}/artifacts`, users[who].auth, {
    stageId: "questionnaire",
    content: questionnaire(answers),
  });
  expect(art.statusCode, art.body).toBe(201);
  expect(art.json()).toMatchObject({ status: "blocked_on_approval" });
  return { id, instanceId };
}

const signoffRows = (instanceId: string) =>
  db.select().from(approvals).where(and(eq(approvals.instanceId, instanceId), eq(approvals.stageId, "signoff")));
const pendingRows = async (instanceId: string) => (await signoffRows(instanceId)).filter((r) => r.status === "pending");
async function rowFor(instanceId: string, roleId: string): Promise<ApprovalRow> {
  const rows = (await pendingRows(instanceId)).filter((r) => r.reviewRoleId === roleId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
const approvalRow = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
const decide = (approvalId: string, body: Record<string, unknown>, who: Who) =>
  post(`/v1/approvals/${approvalId}/decide`, users[who].auth, body);
const useCaseStatus = async (id: string) =>
  (await app.inject({ method: "GET", url: `/v1/use-cases/${id}`, headers: users.owner.auth })).json().useCase.status as string;

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  [originalPolicy = null] = await db.select().from(governanceReviewPolicy);
  originalDelegation = (await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH })).json().settings
    .approvalDelegationEnabled as boolean;
  const who: Array<[Who, boolean]> = [
    ["admin", true], ["owner", false], ["dual", false], ["priv", false], ["sec1", false], ["stranger", false], ["gone", false],
  ];
  for (const [k, isAdmin] of who) {
    const name = `sod170 ${k} ${RUN}`;
    const u = await post("/v1/users", AUTH, { email: `sod170-${k}-${RUN}@example.com`, displayName: name, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await post(`/v1/users/${id}/keys`, AUTH, { name: "sod170" })).json().token as string;
    users[k] = { id, name, auth: { authorization: `Bearer ${token}` } };
  }
  // a deactivated user (this file's own fixture)
  await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, users.gone.id));
  await setPolicy();
}, 120_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  // org singletons: put back exactly what was there
  await db.delete(governanceReviewPolicy);
  if (originalPolicy) await db.insert(governanceReviewPolicy).values(originalPolicy);
  if (originalDelegation !== null) {
    await put("/v1/org/settings", AUTH, { approvalDelegationEnabled: originalDelegation });
  }
  app.server.closeAllConnections();
  await app.close();
});

describe("§1 each required review in a round is decided by a different person", () => {
  it("one person in two roles decides one of them, never both; another member completes the round", async () => {
    const uc = await proposeToReview("dual-role", highAnswers);
    const privacy = await rowFor(uc.instanceId, "privacy");
    const security = await rowFor(uc.instanceId, "security");
    expect((await decide(privacy.id, { decision: "approved" }, "dual")).statusCode).toBe(200);

    const refused = await decide(security.id, { decision: "approved" }, "dual");
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("reviewer_already_decided_round");
    expect(await approvalRow(security.id)).toMatchObject({ status: "pending", decidedBy: null });
    expect(await useCaseStatus(uc.id)).toBe("under_review");

    expect((await decide(security.id, { decision: "approved" }, "sec1")).statusCode).toBe(200);
    expect(await useCaseStatus(uc.id)).toBe("approved");
  });

  it("an admin override counts too: one admin cannot override every review of a round", async () => {
    const uc = await proposeToReview("admin-twice", highAnswers);
    const privacy = await rowFor(uc.instanceId, "privacy");
    const security = await rowFor(uc.instanceId, "security");
    const first = await decide(privacy.id, { decision: "approved", reason: "stuck queue (sod170)" }, "admin");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().adminOverride).toBe(true);
    const second = await decide(security.id, { decision: "approved", reason: "stuck queue (sod170)" }, "admin");
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error).toBe("reviewer_already_decided_round");
    expect((await approvalRow(security.id)).status).toBe("pending");
  });

  it("a send-back opens a new round in which the same person may decide again — but still only one review", async () => {
    const uc = await proposeToReview("new-round", highAnswers);
    const r1 = await rowFor(uc.instanceId, "privacy");
    const back = await decide(r1.id, { decision: "returned", reason: "say who the users are" }, "dual");
    expect(back.statusCode, back.body).toBe(200);
    const art = await post(`/v1/workflows/instances/${uc.instanceId}/artifacts`, users.owner.auth, {
      stageId: "questionnaire",
      content: questionnaire(highAnswers, " Users: HR staff."),
    });
    expect(art.statusCode, art.body).toBe(201);
    const privacy2 = await rowFor(uc.instanceId, "privacy");
    const security2 = await rowFor(uc.instanceId, "security");
    expect(privacy2.reviewRound).toBe(2);
    // round 1's decision does not bind round 2
    expect((await decide(privacy2.id, { decision: "approved" }, "dual")).statusCode).toBe(200);
    const again = await decide(security2.id, { decision: "approved" }, "dual");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("reviewer_already_decided_round");
  });
});

describe("§2 role rows are decided by live role members only", () => {
  it("a member removed from the role can no longer decide the row that still names them", async () => {
    const uc = await proposeToReview("removed-member", limitedAnswers);
    const row = await rowFor(uc.instanceId, "security");
    // the round named the first member who is not the proposer
    expect(row.approverUserId).toBe(users.dual.id);
    const p = policy();
    await setPolicy({ ...p, roles: [p.roles[0], { ...p.roles[1], memberUserIds: [users.sec1.id] }] });
    try {
      const refused = await decide(row.id, { decision: "approved" }, "dual");
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("not_the_named_approver");
      expect((await approvalRow(row.id)).status).toBe("pending");
      // control: a live member decides it
      expect((await decide(row.id, { decision: "approved" }, "sec1")).statusCode).toBe(200);
    } finally {
      await setPolicy();
    }
  });

  it("a claim does not move a review-role row's approver, and the claimer cannot decide it", async () => {
    const uc = await proposeToReview("claim", limitedAnswers);
    const row = await rowFor(uc.instanceId, "security");
    // a routed assignment to a non-member (this approval's own row)
    await db.insert(approvalAssignments).values({ approvalId: row.id, assigneeKind: "user", assigneeId: users.stranger.id });
    const claim = await post(`/v1/approvals/${row.id}/claim`, users.stranger.auth);
    expect(claim.statusCode, claim.body).toBe(200);
    expect((await approvalRow(row.id)).approverUserId).toBe(row.approverUserId);
    const refused = await decide(row.id, { decision: "approved" }, "stranger");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("not_the_named_approver");
  });

  it("routing rules and SLA reassignment never re-point a review-role row", async () => {
    const uc = await proposeToReview("routing", limitedAnswers);
    const row = await rowFor(uc.instanceId, "security");
    // SLA reassignment's one writer refuses the row
    expect(await reassignApprovalApprover(db, row.id, users.stranger.id)).toBe(false);
    expect((await approvalRow(row.id)).approverUserId).toBe(row.approverUserId);
    // a user-kind routing rule — inside a rolled-back transaction, so no other
    // file ever sees an enabled rule
    const ROLLBACK = new Error("rollback");
    let seen: string | null = null;
    await db
      .transaction(async (tx) => {
        await tx.insert(approvalAssignmentRules).values({
          name: `sod170 route ${RUN}`,
          objectType: "workflow",
          assigneeKind: "user",
          assigneeId: users.stranger.id,
          priority: -1_000_000,
        });
        const assignment = await ensureAssignment(tx as unknown as Db, row);
        expect(assignment?.assigneeId).toBe(users.stranger.id); // the rule matched
        seen = (await tx.select().from(approvals).where(eq(approvals.id, row.id)))[0]!.approverUserId;
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen).toBe(row.approverUserId);
  });

  it("delegation from the proposer is not honoured; delegation from a live member is", async () => {
    const enable = await put("/v1/org/settings", AUTH, { approvalDelegationEnabled: true });
    expect(enable.statusCode, enable.body).toBe(200);
    const window = { startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() };
    const delegate = async (from: Who, to: Who) => {
      const r = await post("/v1/delegations", AUTH, { fromUserId: users[from].id, toUserId: users[to].id, ...window });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().id as string;
    };
    // the proposer is the only member of a role, so the row names them
    const p = policy();
    await setPolicy({
      ...p,
      roles: [...p.roles, { id: "solo", name: "Solo", memberUserIds: [users.owner.id] }],
      tiers: { ...p.tiers, limited: { roleIds: ["solo"] } },
    });
    const delegations: string[] = [];
    try {
      const uc = await proposeToReview("delegated-proposer", limitedAnswers);
      const row = await rowFor(uc.instanceId, "solo");
      expect(row.approverUserId).toBe(users.owner.id);
      delegations.push(await delegate("owner", "stranger"));
      // a reason is given so the self-review guard (the proposer is also the
      // stored approver) is satisfied — the refusal must come from §2 itself
      const refused = await decide(row.id, { decision: "approved", reason: "on behalf of (sod170)" }, "stranger");
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("not_the_named_approver");
      expect((await approvalRow(row.id)).status).toBe("pending");
    } finally {
      await setPolicy();
    }
    // control: a live member's delegation still works on a role row
    const uc2 = await proposeToReview("delegated-member", limitedAnswers);
    const row2 = await rowFor(uc2.instanceId, "security");
    expect(row2.approverUserId).toBe(users.dual.id);
    delegations.push(await delegate("dual", "stranger"));
    try {
      const ok = await decide(row2.id, { decision: "approved" }, "stranger");
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ onBehalfOf: users.dual.id, decidedBy: users.stranger.id });
    } finally {
      for (const id of delegations) await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/delegations/${id}` });
    }
  });
});

describe("§8 smaller hardening on the decide path", () => {
  it("the proposer cannot accept risks on their own use case, even as a risk acceptor deciding as admin", async () => {
    const uc = await proposeToReview("own-risk", minimalAnswers, "admin");
    const risk = await post("/v1/risks", users.admin.auth, {
      title: `sod170 own risk ${RUN}`, description: "fixture", category: "hallucination", likelihood: "medium", impact: "high", useCaseId: uc.id,
    });
    expect(risk.statusCode, risk.body).toBe(201);
    const row = (await pendingRows(uc.instanceId))[0]!;
    expect(row.reviewRoleId).toBeNull();
    const refused = await decide(
      row.id,
      {
        decision: "approved",
        reason: "approving my own (sod170)",
        acceptRisks: { riskIds: [risk.json().id], rationale: "Residual risk is tolerable with human review." },
      },
      "admin",
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error).toBe("proposer_cannot_accept_risk");
    expect((await approvalRow(row.id)).status).toBe("pending");
  });

  it("a deactivated user cannot be named a condition owner", async () => {
    const uc = await proposeToReview("gone-owner", minimalAnswers);
    const row = (await pendingRows(uc.instanceId))[0]!;
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const refused = await decide(
      row.id,
      {
        decision: "approved",
        reason: "approved with a condition (sod170)",
        conditions: [{ text: "DPIA signed", ownerUserId: users.gone.id, dueAt: future, blocking: true }],
      },
      "admin",
    );
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ error: "user_deactivated", userIds: [users.gone.id] });
    expect((await approvalRow(row.id)).status).toBe("pending");
    // control: an active owner is accepted
    const ok = await decide(
      row.id,
      {
        decision: "approved",
        reason: "approved with a condition (sod170)",
        conditions: [{ text: "DPIA signed", ownerUserId: users.priv.id, dueAt: future, blocking: true }],
      },
      "admin",
    );
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("the review-round sync a refused caller triggers is attributed to the system, not to the caller", async () => {
    await db.delete(governanceReviewPolicy);
    let uc: { id: string; instanceId: string };
    let legacy: string;
    try {
      uc = await proposeToReview("pre-authz-sync", limitedAnswers);
      const rows = await pendingRows(uc.instanceId);
      expect(rows.every((r) => r.reviewRoleId === null)).toBe(true);
      legacy = rows[0]!.id;
    } finally {
      await setPolicy();
    }
    // a caller with no right to this approval at all triggers the sync
    const r = await decide(legacy, { decision: "approved" }, "stranger");
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("approval_superseded");
    const opened = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, uc.id), eq(auditLog.ruleId, "use-case-review-round-opened")));
    expect(opened).toHaveLength(1);
    expect(opened[0]!.userId).not.toBe(users.stranger.id);
    const byStranger = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, users.stranger.id), inArray(auditLog.objectId, [uc.id, uc.instanceId])));
    expect(byStranger).toEqual([]);
  });
});
