import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvalAssignmentRules,
  approvalAssignments,
  approvalSavedViews,
  approvalSlaPolicies,
  approvals,
  auditLog,
  createDb,
  eq,
  inArray,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";
// ADR-0186 A2+B: this suite pins pre-0186 single-approver tool-call approvals (decided
// through API keys, unsigned); signing and the sensitive quorum are relaxed for its run
// and restored after (M-068). Dual control and signing are proved in zz-b4ab-*.
let restoreApprovalSigning: (() => Promise<void>) | undefined;

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

/**
 * ADR-0046 — THE REVIEW WORKBENCH, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A SECOND DECISION PATH. Bulk is asserted to go through the SAME
 *     `decideOneApproval` every single decision uses — proved not by reading
 *     the code but by putting an item in the batch that the caller is NOT the
 *     named approver for, and asserting it is refused with the queue's own
 *     `not_the_named_approver` while its siblings succeed. A batch-level
 *     authorization shortcut cannot produce that result.
 *
 *  2. AN SLA THAT IS ONLY STORED. The breach case backdates an approval's
 *     `requested_at` so the deadline has genuinely passed, then asserts that a
 *     plain READ of the queue detects it, flips the state, writes an
 *     `approval-sla-breached` audit row, AND performs the configured
 *     escalation. `reassign` is asserted by reading `approvals.approver_user_id`
 *     — the escalation moved a real column, not a badge.
 *
 *  3. AN ESCALATION THAT DECIDES. Every SLA case asserts the approval is STILL
 *     `pending` after the breach. A queue that clears itself on a timeout is a
 *     bypass, and this is the assertion that would catch one appearing.
 *
 *  4. BULK THAT LOSES ITS AUDIT TRAIL. The audit assertions count rows PER ITEM
 *     (successes and refusals separately), not per batch.
 *
 * SHARED-STATE DISCIPLINE: routing rules are global and every OTHER suite's
 * approvals read through the same queue. `afterAll` deletes every rule, policy,
 * assignment and saved view this file created, and restores the `org_settings`
 * bulk columns — a leaked rule would re-route another suite's approvals.
 * Every object is `wb-` prefixed.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "wb-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let ownerId: string;
let alexId: string;
let alexAuth: { authorization: string };
let bettyId: string;
let bettyAuth: { authorization: string };
let chrisId: string;
let chrisAuth: { authorization: string };
let teamId: string;
let serverId: string;
const createdRuleIds: string[] = [];
const createdPolicyIds: string[] = [];
const createdApprovalIds: string[] = [];

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!.replace("-", " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "wb" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

/** an approval created directly, the way every one of the dozen producers in
 * this codebase creates one — no routing hook at the insert site, which is
 * exactly the condition the lazy materialization has to survive */
async function makeApproval(over: Partial<typeof approvals.$inferInsert> = {}) {
  const [row] = await db
    .insert(approvals)
    .values({
      userId: ownerId,
      objectType: "mcp_tool",
      approverUserId: over.approverUserId ?? alexId,
      serverId,
      toolName: "wb.write",
      status: "pending",
      // ADR-0186 B: a fixture row written directly, as an unsigned (pre-0186
      // shape) tool-call approval; bulk refuses a signed one by name (zz-b4ab-*)
      signatureMode: "off",
      ...over,
    })
    .returning();
  createdApprovalIds.push(row!.id);
  return row!;
}

async function inbox(auth: { authorization: string }) {
  const res = await app.inject({ method: "GET", url: "/v1/approvals", headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json().approvals as Array<Record<string, unknown> & { id: string }>;
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

async function makeRule(payload: Record<string, unknown>, expectStatus = 201) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/approvals/assignment-rules",
    headers: AUTH,
    payload,
  });
  expect(res.statusCode).toBe(expectStatus);
  if (res.statusCode === 201) createdRuleIds.push(res.json().rule.id);
  return res;
}

async function makePolicy(payload: Record<string, unknown>, expectStatus = 201) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/approvals/sla-policies",
    headers: AUTH,
    payload,
  });
  expect(res.statusCode).toBe(expectStatus);
  if (res.statusCode === 201) createdPolicyIds.push(res.json().policy.id);
  return res;
}

/** backdate an approval so its SLA deadline has genuinely passed. The clock is
 * derived from `requested_at`, so moving that IS moving time for this row. */
async function backdate(approvalId: string, minutes: number) {
  await db
    .update(approvals)
    .set({ requestedAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(approvals.id, approvalId));
  await db.delete(approvalAssignments).where(eq(approvalAssignments.approvalId, approvalId));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreApprovalSigning = await relaxApprovalSigningForTest(db);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const owner = await makeUser("wb-owner@example.com");
  ownerId = owner.id;
  const alex = await makeUser("wb-alex@example.com");
  alexId = alex.id;
  alexAuth = alex.auth;
  const betty = await makeUser("wb-betty@example.com");
  bettyId = betty.id;
  bettyAuth = betty.auth;
  const chris = await makeUser("wb-chris@example.com");
  chrisId = chris.id;
  chrisAuth = chris.auth;

  const t = await app.inject({
    method: "POST",
    url: "/v1/teams",
    headers: AUTH,
    payload: { name: "wb-reviewers" },
  });
  expect(t.statusCode).toBe(201);
  teamId = t.json().id;
  for (const u of [bettyId, chrisId]) {
    const m = await app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/members`,
      headers: AUTH,
      payload: { userId: u },
    });
    expect(m.statusCode).toBeLessThan(300);
  }

  const s = await app.inject({
    method: "POST",
    url: "/v1/servers",
    headers: AUTH,
    payload: { name: "wb-server", url: "http://127.0.0.1:9/mcp" },
  });
  expect(s.statusCode).toBe(201);
  serverId = s.json().id;
});

afterAll(async () => {
  await restoreApprovalSigning?.();
  await restoreStrictAdmission?.();
  // a leaked routing rule would re-route another suite's approvals, and a
  // leaked assignment would change another suite's inbox shape
  if (createdApprovalIds.length) {
    await db.delete(approvalAssignments).where(inArray(approvalAssignments.approvalId, createdApprovalIds));
    await db.delete(approvals).where(inArray(approvals.id, createdApprovalIds));
  }
  await db.delete(approvalAssignmentRules);
  await db.delete(approvalSlaPolicies);
  await db.delete(approvalSavedViews);
  await db.delete(approvalAssignments);
});

// ---------------------------------------------------------------------------

describe("the layer is INERT until an admin turns it on", () => {
  it("with no rule enabled, the queue behaves exactly as before and writes no assignment", async () => {
    const a = await makeApproval();
    const rows = await inbox(alexAuth);
    const mine = rows.find((r) => r.id === a.id);
    expect(mine).toBeDefined();
    expect(mine!.assignment).toBeUndefined();
    const assignments = await db
      .select()
      .from(approvalAssignments)
      .where(eq(approvalAssignments.approvalId, a.id));
    expect(assignments.length).toBe(0);
  });

  it("authoring routing rules and SLA policies is admin-only", async () => {
    for (const [method, url] of [
      ["POST", "/v1/approvals/assignment-rules"],
      ["GET", "/v1/approvals/assignment-rules"],
      ["POST", "/v1/approvals/sla-policies"],
      ["POST", "/v1/approvals/sla/sweep"],
    ] as const) {
      const res = await app.inject({ method, url, headers: alexAuth, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe("admin_only");
    }
  });

  it("a rule with no conditions is refused — it would capture every approval in the deployment", async () => {
    await makeRule({ name: "wb-everything", assigneeKind: "team", assigneeId: teamId }, 400);
  });

  it("an SLA policy that escalates nowhere is refused", async () => {
    await makePolicy(
      { name: "wb-nowhere", warnAfterMinutes: 1, breachAfterMinutes: 2, escalateAction: "add_assignee" },
      400,
    );
  });
});

describe("routing — the rule decides WHOSE QUEUE, not who may decide", () => {
  let teamApprovalId: string;

  it("a team rule routes a matching approval into the team's members' inboxes", async () => {
    await makeRule({
      name: "wb-team-route",
      objectType: "mcp_tool",
      assigneeKind: "team",
      assigneeId: teamId,
      priority: 50,
    });
    // created with alex as the named approver; the rule routes it to the team
    const a = await makeApproval({ approverUserId: alexId });
    teamApprovalId = a.id;

    // betty is in the team but is NOT the named approver — pre-0058 she saw nothing
    const bettyRows = await inbox(bettyAuth);
    const seen = bettyRows.find((r) => r.id === a.id);
    expect(seen).toBeDefined();
    const seenAssignment = seen!.assignment as { assigneeKind: string; claimable: boolean };
    expect(seenAssignment.assigneeKind).toBe("team");
    expect(seenAssignment.claimable).toBe(true);

    const [assignment] = await db
      .select()
      .from(approvalAssignments)
      .where(eq(approvalAssignments.approvalId, a.id));
    expect(assignment!.assigneeKind).toBe("team");
    expect(assignment!.assigneeId).toBe(teamId);
    const routed = await audits("approval-routed");
    expect(routed.some((r) => (r.detail as { approvalId?: string }).approvalId === a.id)).toBe(true);
  });

  it("SEEING it is not DECIDING it — an unclaimed team member is still refused by the decide path", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/approvals/${teamApprovalId}/decide`,
      headers: bettyAuth,
      payload: { decision: "approved" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_the_named_approver");
  });

  it("a NON-member cannot claim it", async () => {
    // alex is the named approver but not a member of wb-reviewers; the claim
    // path is about the ASSIGNMENT, and he is not part of it
    const res = await app.inject({
      method: "POST",
      url: `/v1/approvals/${teamApprovalId}/claim`,
      headers: alexAuth,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_eligible_to_claim");
  });

  it("an eligible member claims it, which resolves the named approver and is audited", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/approvals/${teamApprovalId}/claim`,
      headers: bettyAuth,
    });
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, teamApprovalId));
    expect(row!.approverUserId).toBe(bettyId);
    expect(row!.status).toBe("pending"); // claiming is not deciding
    expect((await audits("approval-claimed")).length).toBeGreaterThanOrEqual(1);
  });

  it("a second claimer is refused — one item, one owner", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/approvals/${teamApprovalId}/claim`,
      headers: chrisAuth,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_claimed");
  });

  it("the claimer can now decide it through the ordinary endpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/approvals/${teamApprovalId}/decide`,
      headers: bettyAuth,
      payload: { decision: "approved", reason: "reviewed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
  });

  it("a more specific rule wins by priority", async () => {
    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: AUTH,
      payload: { name: "wb-project", key: "WBPROJ" },
    });
    expect(proj.statusCode).toBe(201);
    const projectId = proj.json().id as string;
    await makeRule({
      name: "wb-project-route",
      projectId,
      assigneeKind: "user",
      assigneeId: chrisId,
      priority: 10,
    });
    const a = await makeApproval({ objectType: "project", projectId, approverUserId: alexId });
    await inbox(AUTH);
    const [assignment] = await db
      .select()
      .from(approvalAssignments)
      .where(eq(approvalAssignments.approvalId, a.id));
    expect(assignment!.assigneeKind).toBe("user");
    expect(assignment!.assigneeId).toBe(chrisId);
    // a `user` rule resolves the named approver immediately, so ADR-0022's
    // visibility and ADR-0027's quorum keep reading a meaningful column
    const [row] = await db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(row!.approverUserId).toBe(chrisId);
  });
});

describe("SLA timers are EVALUATED, and escalation never decides", () => {
  it("a breach is detected on a plain READ of the queue, and audited", async () => {
    const policy = await makePolicy({
      name: "wb-fast",
      warnAfterMinutes: 5,
      breachAfterMinutes: 10,
      escalateAction: "add_assignee",
      escalateToKind: "team",
      escalateToId: teamId,
    });
    await makeRule({
      name: "wb-sla-route",
      objectType: "run",
      assigneeKind: "user",
      assigneeId: alexId,
      slaPolicyId: policy.json().policy.id,
      priority: 20,
    });
    const a = await makeApproval({ objectType: "run", approverUserId: alexId });
    await backdate(a.id, 60); // an hour old against a 10-minute breach window

    await inbox(alexAuth); // a READ is the only thing that happens here

    const [assignment] = await db
      .select()
      .from(approvalAssignments)
      .where(eq(approvalAssignments.approvalId, a.id));
    expect(assignment!.slaState).toBe("breached");
    expect(assignment!.breachedAt).toBeTruthy();
    expect(assignment!.escalationAssigneeKind).toBe("team");
    expect(assignment!.escalationAssigneeId).toBe(teamId);

    const breaches = await audits("approval-sla-breached");
    const mine = breaches.find((r) => (r.detail as { approvalId?: string }).approvalId === a.id);
    expect(mine).toBeDefined();
    expect((mine!.detail as { minutesLate: number }).minutesLate).toBeGreaterThanOrEqual(45);
    expect(mine!.reason).toContain("NEVER approves or denies");

    // THE POINT: escalation moved the work, it did not decide it
    const [row] = await db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(row!.status).toBe("pending");
  });

  it("the escalation target sees the item even though they are not the approver", async () => {
    const rows = await inbox(chrisAuth);
    expect(
      rows.some((r) => (r.assignment as { slaState?: string } | undefined)?.slaState === "breached"),
    ).toBe(true);
  });

  it("re-reading does not re-escalate — breach fires exactly once", async () => {
    const before = (await audits("approval-sla-breached")).length;
    await inbox(alexAuth);
    await inbox(alexAuth);
    expect((await audits("approval-sla-breached")).length).toBe(before);
  });

  it("`reassign` moves the named approver — a real column, not a badge — and still does not decide", async () => {
    const policy = await makePolicy({
      name: "wb-reassign",
      warnAfterMinutes: 1,
      breachAfterMinutes: 2,
      escalateAction: "reassign",
      escalateToKind: "user",
      escalateToId: chrisId,
    });
    await makeRule({
      name: "wb-reassign-route",
      objectType: "infra_operation",
      assigneeKind: "user",
      assigneeId: alexId,
      slaPolicyId: policy.json().policy.id,
      priority: 15,
    });
    const a = await makeApproval({ objectType: "infra_operation", approverUserId: alexId });
    await backdate(a.id, 30);

    await inbox(AUTH);

    const [row] = await db.select().from(approvals).where(eq(approvals.id, a.id));
    expect(row!.approverUserId).toBe(chrisId);
    expect(row!.status).toBe("pending");
    expect(row!.decidedBy).toBeNull();
  });

  it("the sweep endpoint stays a PULL, and says the sweep is timeliness not correctness", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/approvals/sla/sweep", headers: AUTH });
    expect(res.statusCode).toBe(200);
    // ADR-0064 gave this a scheduler job. The invariant asserted here is the one
    // that must never regress: breach is ALSO caught lazily, so the sweep only
    // decides when somebody finds out.
    expect(res.json().note).toContain("evaluated lazily too");
    expect(res.json().note).toContain("never whether");
    expect(typeof res.json().evaluated).toBe("number");
  });

  it("a breach that comes due with nobody looking is recorded when the approval is DECIDED", async () => {
    const policy = await makePolicy({
      name: "wb-ondecide",
      warnAfterMinutes: 1,
      breachAfterMinutes: 2,
      escalateAction: "notify_only",
    });
    await makeRule({
      name: "wb-ondecide-route",
      objectType: "workflow",
      assigneeKind: "user",
      assigneeId: alexId,
      slaPolicyId: policy.json().policy.id,
      priority: 25,
    });
    const a = await makeApproval({ objectType: "workflow", approverUserId: alexId });
    await backdate(a.id, 45);

    // straight to the decision — no read in between
    const res = await app.inject({
      method: "POST",
      url: `/v1/approvals/${a.id}/decide`,
      headers: alexAuth,
      payload: { decision: "approved", reason: "late but decided" },
    });
    expect(res.statusCode).toBe(200);

    const [assignment] = await db
      .select()
      .from(approvalAssignments)
      .where(eq(approvalAssignments.approvalId, a.id));
    expect(assignment!.slaState).toBe("breached");
    const breaches = await audits("approval-sla-breached");
    expect(breaches.some((r) => (r.detail as { approvalId?: string }).approvalId === a.id)).toBe(true);
  });

  it("workload reports the live breached count", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/approvals/workload", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const rows = res.json().workload as Array<{ open: number; breached: number }>;
    expect(rows.reduce((n, r) => n + r.breached, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("BULK — same per-item authorization, same per-item audit", () => {
  let mineA: string;
  let mineB: string;
  let notMine: string;

  beforeAll(async () => {
    // three ordinary approvals; two name alex, one names betty. No rule matches
    // 'decision' object types, so routing does not interfere here.
    mineA = (await makeApproval({ toolName: "wb.bulk1", approverUserId: alexId })).id;
    mineB = (await makeApproval({ toolName: "wb.bulk2", approverUserId: alexId })).id;
    notMine = (await makeApproval({ toolName: "wb.bulk3", approverUserId: bettyId })).id;
  });

  it("a bulk over the cap is refused WHOLE rather than truncated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/approvals/bulk",
      headers: alexAuth,
      payload: {
        approvalIds: Array.from({ length: 30 }, (_, i) => `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`),
        decision: "approved",
        reason: "too many",
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("bulk_cap_exceeded");
    // nothing was decided
    const [still] = await db.select().from(approvals).where(eq(approvals.id, mineA));
    expect(still!.status).toBe("pending");
  });

  it("a bulk requires a reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/approvals/bulk",
      headers: alexAuth,
      payload: { approvalIds: [mineA], decision: "approved" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("AN UNAUTHORIZED ITEM IS REFUSED WHILE ITS SIBLINGS SUCCEED, and the refusal is audited", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/approvals/bulk",
      headers: alexAuth,
      payload: {
        approvalIds: [mineA, notMine, mineB],
        decision: "approved",
        reason: "batch of identical low-risk reads",
      },
    });
    expect(res.statusCode).toBe(207);
    const body = res.json() as {
      batchId: string;
      decided: number;
      refused: number;
      results: Array<{ approvalId: string; ok: boolean; status: number; error?: string }>;
    };
    expect(body.decided).toBe(2);
    expect(body.refused).toBe(1);

    const refusal = body.results.find((r) => r.approvalId === notMine)!;
    expect(refusal.ok).toBe(false);
    expect(refusal.status).toBe(403);
    // the queue's OWN error — proof the item went through the one decide path
    expect(refusal.error).toBe("not_the_named_approver");

    // THE DECISIVE ASSERTION: the unauthorized item is UNTOUCHED
    const [untouched] = await db.select().from(approvals).where(eq(approvals.id, notMine));
    expect(untouched!.status).toBe("pending");
    expect(untouched!.decidedBy).toBeNull();

    // ...and the two authorized ones really were decided, by the real decider
    for (const id of [mineA, mineB]) {
      const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
      expect(row!.status).toBe("approved");
      expect(row!.decidedBy).toBe(alexId);
      expect(row!.decisionReason).toBe("batch of identical low-risk reads");
    }

    // PER-ITEM audit, not one row per batch
    const decisions = (await audits("approval-bulk-decision")).filter(
      (r) => (r.detail as { batchId?: string }).batchId === body.batchId,
    );
    expect(decisions.length).toBe(2);
    expect(new Set(decisions.map((r) => (r.detail as { approvalId: string }).approvalId))).toEqual(
      new Set([mineA, mineB]),
    );
    const refusals = (await audits("approval-bulk-item-refused")).filter(
      (r) => (r.detail as { batchId?: string }).batchId === body.batchId,
    );
    expect(refusals.length).toBe(1);
    expect((refusals[0]!.detail as { approvalId: string }).approvalId).toBe(notMine);
    expect(refusals[0]!.effect).toBe("deny");
  });

  it("an admin bulk still needs the override reason the single path demands", async () => {
    // the bulk schema forces a reason, so an admin override inside a bulk is
    // ALWAYS reason-carrying — assert the override was recorded per item
    const target = await makeApproval({ toolName: "wb.bulk4", approverUserId: bettyId });
    const res = await app.inject({
      method: "POST",
      url: "/v1/approvals/bulk",
      headers: AUTH,
      payload: { approvalIds: [target.id], decision: "denied", reason: "admin clearing a stuck queue" },
    });
    // the BOOTSTRAP token has no identity and cannot decide — the same refusal
    // the single path gives, reached through bulk
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("bootstrap_cannot_decide");
    const [still] = await db.select().from(approvals).where(eq(approvals.id, target.id));
    expect(still!.status).toBe("pending");
  });

  it("an already-decided item is refused by the one path, not silently skipped", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/approvals/bulk",
      headers: alexAuth,
      payload: { approvalIds: [mineA], decision: "approved", reason: "again" },
    });
    expect(res.statusCode).toBe(207);
    const result = res.json().results[0] as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("already_decided");
  });

  it("an unknown id is refused and audited rather than ignored", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/approvals/bulk",
      headers: alexAuth,
      payload: {
        approvalIds: ["00000000-0000-0000-0000-0000000000ff"],
        decision: "approved",
        reason: "ghost",
      },
    });
    expect(res.statusCode).toBe(207);
    expect(res.json().results[0].error).toBe("unknown_approval");
  });

  it("bulk is FORBIDDEN on an approval attributed to a PII-blocking project — per item, not per batch", async () => {
    const profile = await app.inject({
      method: "POST",
      url: "/v1/compliance/profiles",
      headers: AUTH,
      payload: { tag: "wb-secret", name: "wb secret", piiMode: "block" },
    });
    expect(profile.statusCode).toBe(201);
    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: AUTH,
      payload: { name: "wb-sensitive", key: "WBSENS", classifications: ["wb-secret"] },
    });
    expect(proj.statusCode).toBe(201);
    const sensitiveProjectId = proj.json().id as string;

    const sensitive = await makeApproval({
      toolName: "wb.sensitive",
      approverUserId: alexId,
      projectId: sensitiveProjectId,
    });
    const ordinary = await makeApproval({ toolName: "wb.ordinary", approverUserId: alexId });

    const res = await app.inject({
      method: "POST",
      url: "/v1/approvals/bulk",
      headers: alexAuth,
      payload: {
        approvalIds: [sensitive.id, ordinary.id],
        decision: "approved",
        reason: "mixed batch",
      },
    });
    expect(res.statusCode).toBe(207);
    const results = res.json().results as Array<{ approvalId: string; ok: boolean; error?: string }>;
    expect(results.find((r) => r.approvalId === sensitive.id)!.error).toBe("bulk_forbidden_sensitive");
    expect(results.find((r) => r.approvalId === ordinary.id)!.ok).toBe(true);

    const [untouched] = await db.select().from(approvals).where(eq(approvals.id, sensitive.id));
    expect(untouched!.status).toBe("pending");

    // ...and it is still decidable ONE AT A TIME. The fence is friction, not a lock.
    const single = await app.inject({
      method: "POST",
      url: `/v1/approvals/${sensitive.id}/decide`,
      headers: alexAuth,
      payload: { decision: "approved", reason: "reviewed individually" },
    });
    expect(single.statusCode).toBe(200);
  });
});

describe("saved views", () => {
  it("a reviewer owns their own views; publishing one is an admin act", async () => {
    const mine = await app.inject({
      method: "POST",
      url: "/v1/approvals/views",
      headers: alexAuth,
      payload: { name: "wb-my-queue", filters: { status: "pending" } },
    });
    expect(mine.statusCode).toBe(201);
    expect(mine.json().view.shared).toBe(false);

    const publishAttempt = await app.inject({
      method: "POST",
      url: "/v1/approvals/views",
      headers: alexAuth,
      payload: { name: "wb-everyone", shared: true },
    });
    expect(publishAttempt.statusCode).toBe(403);
    expect(publishAttempt.json().error).toBe("shared_view_admin_only");

    const published = await app.inject({
      method: "POST",
      url: "/v1/approvals/views",
      headers: AUTH,
      payload: { name: "wb-everyone", shared: true, filters: { status: "pending" } },
    });
    expect(published.statusCode).toBe(201);

    const betty = await app.inject({ method: "GET", url: "/v1/approvals/views", headers: bettyAuth });
    const names = (betty.json().views as Array<{ name: string }>).map((v) => v.name);
    expect(names).toContain("wb-everyone");
    expect(names).not.toContain("wb-my-queue");
  });

  it("someone else's private view cannot be deleted", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/approvals/views", headers: alexAuth });
    const mine = (list.json().views as Array<{ id: string; name: string }>).find(
      (v) => v.name === "wb-my-queue",
    )!;
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/approvals/views/${mine.id}`,
      headers: bettyAuth,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("REL-09: the lazy pass on a queue read is bounded to what a read could change", () => {
  it("selects unassigned rows and rows past a warn/due mark their state does not reflect — nothing else — oldest first, capped", async () => {
    const { pendingApprovalsNeedingAttention } = await import("./workbench.js");
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60 * 60_000);
    const mk = async (ageMinutes: number, over: Partial<typeof approvals.$inferInsert> = {}) =>
      makeApproval({ objectType: "run", requestedAt: new Date(now.getTime() - ageMinutes * 60_000), ...over });
    const assign = (approvalId: string, a: { warnAt: Date | null; dueAt: Date | null; slaState: "ok" | "warning" | "breached" }) =>
      db.insert(approvalAssignments).values({ approvalId, assigneeKind: "user", assigneeId: alexId, ...a });

    const unassigned = await mk(50);
    const insideWindow = await mk(49);
    await assign(insideWindow.id, { warnAt: future, dueAt: future, slaState: "ok" });
    const overdueUnnoticed = await mk(48);
    await assign(overdueUnnoticed.id, { warnAt: past, dueAt: past, slaState: "ok" });
    const overdueAlreadyBreached = await mk(47);
    await assign(overdueAlreadyBreached.id, { warnAt: past, dueAt: past, slaState: "breached" });
    const warnUnnoticed = await mk(46);
    await assign(warnUnnoticed.id, { warnAt: past, dueAt: future, slaState: "ok" });
    const warnAlreadyNoticed = await mk(45);
    await assign(warnAlreadyNoticed.id, { warnAt: past, dueAt: future, slaState: "warning" });
    const decided = await mk(44, { status: "approved" });

    const picked = (await pendingApprovalsNeedingAttention(db, now)).map((r) => r.id);
    const mine = new Set([unassigned.id, insideWindow.id, overdueUnnoticed.id, overdueAlreadyBreached.id, warnUnnoticed.id, warnAlreadyNoticed.id, decided.id]);
    const pickedMine = picked.filter((id) => mine.has(id));
    expect(pickedMine).toEqual([unassigned.id, overdueUnnoticed.id, warnUnnoticed.id]); // and in age order
    expect(picked).not.toContain(insideWindow.id);
    expect(picked).not.toContain(overdueAlreadyBreached.id);
    expect(picked).not.toContain(warnAlreadyNoticed.id);
    expect(picked).not.toContain(decided.id);

    // the cap: a deployment with thousands pending pays for at most `limit` per read
    const capped = await pendingApprovalsNeedingAttention(db, now, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]!.id).toBe(unassigned.id); // the oldest in the pile — this test's rows are backdated past every other suite's
  });

  it("a read of the queue leaves an assignment inside its window untouched (no re-materialization)", async () => {
    const row = await makeApproval({ objectType: "run" });
    const future = new Date(Date.now() + 60 * 60_000);
    const [assignment] = await db
      .insert(approvalAssignments)
      .values({ approvalId: row.id, assigneeKind: "user", assigneeId: alexId, warnAt: future, dueAt: future, slaState: "ok" })
      .returning();
    await inbox(alexAuth);
    const [after] = await db.select().from(approvalAssignments).where(eq(approvalAssignments.approvalId, row.id));
    expect(after).toEqual(assignment);
  });
});
