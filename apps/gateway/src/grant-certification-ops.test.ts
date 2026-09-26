/**
 * ADR-0090 amendment (batch B2) — access-review OPERATIONS follow-ups:
 *
 *  B2a — THE EXPIRY SWEEP DECIDES NOTHING. A real ADR-0064 scheduler job
 *  (`certification-expiry-sweep`) whose whole product is ONE audited
 *  `campaign-expired-incomplete` row per campaign the FIRST time it is
 *  observed past due. What this file makes impossible to fake:
 *   - the sweep marks exactly once and a re-run adds NOTHING (idempotent by
 *     data — the audit row is the marker);
 *   - an open campaign within its due date is untouched;
 *   - the read-time computed status and the swept event AGREE (same shared
 *     predicate), and the sweep writes NO status — storedStatus stays open,
 *     items stay undecided;
 *   - the scheduler job and the manual endpoint run the same function.
 *
 *  B2b — REVIEW REASSIGNMENT, WITH THE HOLDER BAR. Admin-only, audited,
 *  reason-required move of an ITEM's reviewer, riding ADR-0046's ONE
 *  approver-moving write (`reassignApprovalApprover` — the SLA `reassign`
 *  escalation's mechanism, never a parallel UPDATE). What this file makes
 *  impossible to fake:
 *   - the reassigned reviewer can decide and the ORIGINAL no longer can
 *     (`not_the_named_approver` through the one decide path);
 *   - reassigning to the grant HOLDER is refused by name for BOTH holder
 *     shapes (direct and role-bundled), and an admin override reason does
 *     NOT help — the ADR-0022 idiom: the bar is about who would sign;
 *   - a decided item and an expired campaign refuse by name.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed gco-. Campaign rows created by this file are
 * addressed by their own ids; anything org-wide (audit counts) is a delta
 * (M-008), and the sweep assertions key on THIS file's campaign ids because
 * other files legitimately leave past-due campaigns behind. No singleton is
 * touched (M-012).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  count,
  createDb,
  eq,
  grantCertificationCampaigns,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { Scheduler, syncSchedulerJobs } from "./scheduler.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "gco-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;

type Auth = { authorization: string };
let openerId: string; // admin — opens campaigns, performs reassignments
let openerAuth: Auth;
let origReviewerId: string; // non-admin owner of agentOwned — the routed reviewer
let origReviewerAuth: Auth;
let newReviewerId: string; // non-admin, holds nothing — the reassignment target
let newReviewerAuth: Auth;
let holderId: string; // holds the grants under review
let roleHolderId: string; // assigned to gco-role — the role-bundled bar half

let agentOwned: string; // owner = origReviewer
let agentUnowned: string;
let roleId: string;

async function makeUser(email: string, opts: { admin?: boolean } = {}) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    // no "@" in the display name — another suite asserts nothing
    // email-shaped leaks through the directory
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  if (opts.admin) {
    const up = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${id}/admin`,
      payload: { isAdmin: true, reason: "gco coverage" },
    });
    expect(up.statusCode).toBe(200);
  }
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${id}/keys`,
    payload: { name: "gco-key" },
  });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

const openCampaign = async (name: string, dueAt: string) => {
  const res = await app.inject({
    method: "POST",
    headers: openerAuth,
    url: "/v1/certification-campaigns",
    payload: { name, scope: { kind: "user", value: holderId }, dueAt },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const campaignDetail = async (campaignId: string) => {
  const res = await app.inject({ method: "GET", headers: openerAuth, url: `/v1/certification-campaigns/${campaignId}` });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    status: string;
    storedStatus: string;
    items: Array<{
      id: string;
      grantKind: string;
      holder: { userId: string | null; roleId: string | null };
      object: { id: string | null };
      reviewer: { userId: string };
      approvalId: string;
      decision: string | null;
      decidedBy: { userId: string } | null;
    }>;
  };
};
const decide = (auth: Auth, approvalId: string, decision: "approved" | "denied", reason?: string) =>
  app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/approvals/${approvalId}/decide`,
    payload: { decision, ...(reason ? { reason } : {}) },
  });
const reassign = (auth: Auth, campaignId: string, itemId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/certification-campaigns/${campaignId}/items/${itemId}/reassign`,
    payload,
  });
const runSweep = async () => {
  const res = await app.inject({ method: "POST", headers: openerAuth, url: "/v1/certification-campaigns/expiry-sweep" });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { observed: number; campaignIds: string[]; note: string };
};
/** swept-event rows for ONE campaign id — absolute is safe here because the
 * id is this file's own row; org-wide counts stay deltas (M-008) */
async function sweptEventCount(campaignId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, "campaign-expired-incomplete"), eq(auditLog.objectId, campaignId)));
  return row?.n ?? 0;
}
const backdate = (campaignId: string) =>
  db
    .update(grantCertificationCampaigns)
    .set({ dueAt: new Date(Date.now() - 60 * 1000) })
    .where(eq(grantCertificationCampaigns.id, campaignId));
const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const opener = await makeUser("gco-opener@example.com", { admin: true });
  openerId = opener.id;
  openerAuth = opener.auth;
  const orig = await makeUser("gco-orig-reviewer@example.com");
  origReviewerId = orig.id;
  origReviewerAuth = orig.auth;
  const next = await makeUser("gco-new-reviewer@example.com");
  newReviewerId = next.id;
  newReviewerAuth = next.auth;
  holderId = (await makeUser("gco-holder@example.com")).id;
  roleHolderId = (await makeUser("gco-role-holder@example.com")).id;

  agentOwned = await mkAgent("gco-agent-owned");
  agentUnowned = await mkAgent("gco-agent-unowned");
  const setOwner = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/agents/${agentOwned}/owner`,
    payload: { ownerUserId: origReviewerId },
  });
  expect(setOwner.statusCode).toBe(200);

  for (const agentId of [agentOwned, agentUnowned]) {
    const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: holderId, agentId } });
    expect(g.statusCode).toBe(201);
  }

  // role bundling agentOwned, held by roleHolder — the role-bundled bar half
  const role = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "gco-role" } });
  expect(role.statusCode).toBe(201);
  roleId = role.json().id;
  const rg = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/roles/${roleId}/grants/agents`,
    payload: { agentId: agentOwned },
  });
  expect(rg.statusCode).toBe(201);
  const assign = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${roleHolderId}/roles`,
    payload: { roleId },
  });
  expect(assign.statusCode).toBe(201);
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

// ===========================================================================
// B2b — reassignment
// ===========================================================================

describe("item reassignment — audited, reason-required, riding ADR-0046's one approver-moving write", () => {
  let c1: string;
  let ownedItem: { id: string; approvalId: string };
  let unownedItem: { id: string; approvalId: string };

  it("reassigns an item; the NEW reviewer can decide and the ORIGINAL gets the queue's own named refusal", async () => {
    c1 = await openCampaign("gco-reassign", inOneHour());
    const detail = await campaignDetail(c1);
    const owned = detail.items.find((i) => i.object.id === agentOwned && i.grantKind === "agent")!;
    const unowned = detail.items.find((i) => i.object.id === agentUnowned)!;
    expect(owned.reviewer.userId).toBe(origReviewerId); // ADR-0089 routing, unchanged
    ownedItem = { id: owned.id, approvalId: owned.approvalId };
    unownedItem = { id: unowned.id, approvalId: unowned.approvalId };

    // reason is REQUIRED — a reviewer move without a recorded why is a 400
    const reasonless = await reassign(openerAuth, c1, owned.id, { reviewerUserId: newReviewerId });
    expect(reasonless.statusCode).toBe(400);
    // the bootstrap token has no identity and cannot author the move
    const boot = await reassign({ authorization: `Bearer ${BOOT}` }, c1, owned.id, {
      reviewerUserId: newReviewerId,
      reason: "x",
    });
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("bootstrap_cannot_reassign");
    // admin-only via the default gate: a non-admin cannot move reviews
    const nonAdmin = await reassign(newReviewerAuth, c1, owned.id, { reviewerUserId: newReviewerId, reason: "x" });
    expect(nonAdmin.statusCode).toBe(403);

    const reassignedBefore = await auditCount("grant-cert-item-reassigned");
    const res = await reassign(openerAuth, c1, owned.id, {
      reviewerUserId: newReviewerId,
      reason: "original reviewer is on leave this quarter",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().previousReviewerUserId).toBe(origReviewerId);
    expect(await auditCount("grant-cert-item-reassigned")).toBe(reassignedBefore + 1);

    // the item AND the queue row moved together (one mechanism, no drift)
    const after = await campaignDetail(c1);
    expect(after.items.find((i) => i.id === owned.id)!.reviewer.userId).toBe(newReviewerId);

    // the ORIGINAL reviewer is no longer the named approver — the one decide
    // path refuses with its own name, per item
    const orig = await decide(origReviewerAuth, owned.approvalId, "approved");
    expect(orig.statusCode).toBe(403);
    expect(orig.json().error).toBe("not_the_named_approver");

    // the reassigned reviewer decides normally
    const mine = await decide(newReviewerAuth, owned.approvalId, "approved");
    expect(mine.statusCode, mine.body).toBe(200);
    const decided = await campaignDetail(c1);
    expect(decided.items.find((i) => i.id === owned.id)!.decidedBy!.userId).toBe(newReviewerId);
  });

  it("refuses reassigning a DECIDED item by name", async () => {
    const res = await reassign(openerAuth, c1, ownedItem.id, {
      reviewerUserId: newReviewerId,
      reason: "moving a decided item",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("item_already_decided");
  });

  it("NEVER to the holder — a direct holder, even with an admin override reason (the ADR-0022 idiom)", async () => {
    // the caller is an ADMIN and the reason is the exact credential that
    // unlocks the generic decide-path override — the bar refuses anyway,
    // because it is about who would SIGN, not how well the move is documented
    const res = await reassign(openerAuth, c1, unownedItem.id, {
      reviewerUserId: holderId,
      reason: "override: routing it to the holder to unblock the queue",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("cannot_reassign_to_holder");
    // nothing moved
    const detail = await campaignDetail(c1);
    expect(detail.items.find((i) => i.id === unownedItem.id)!.reviewer.userId).toBe(openerId);
  });

  it("NEVER to the holder — the role-bundled half: an assignee of the bundling role is barred too", async () => {
    const c2 = await app.inject({
      method: "POST",
      headers: openerAuth,
      url: "/v1/certification-campaigns",
      payload: { name: "gco-role-bar", scope: { kind: "agent_owner", value: origReviewerId }, dueAt: inOneHour() },
    });
    expect(c2.statusCode, c2.body).toBe(201);
    const detail = await campaignDetail(c2.json().id);
    const roleItem = detail.items.find((i) => i.grantKind === "role_agent")!;
    expect(roleItem.holder.roleId).toBe(roleId);
    const res = await reassign(openerAuth, c2.json().id, roleItem.id, {
      reviewerUserId: roleHolderId,
      reason: "override: they know the role best",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("cannot_reassign_to_holder");
    // a user holding NEITHER shape proceeds (control — the bar refuses
    // holders, not reassignment)
    const ok = await reassign(openerAuth, c2.json().id, roleItem.id, {
      reviewerUserId: newReviewerId,
      reason: "original reviewer unavailable",
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("refuses reassignment on a past-due campaign — the SAME shared predicate as the decide refusal", async () => {
    const c3 = await openCampaign("gco-reassign-expired", inOneHour());
    const detail = await campaignDetail(c3);
    const item = detail.items[0]!;
    await backdate(c3);
    const res = await reassign(openerAuth, c3, item.id, { reviewerUserId: newReviewerId, reason: "too late" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("campaign_expired");
  });
});

async function auditCount(ruleId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return row?.n ?? 0;
}

// ===========================================================================
// B2a — the expiry sweep
// ===========================================================================

describe("the expiry sweep records visibility facts — once — and decides nothing", () => {
  let expiring: string; // will be backdated past due
  let openOne: string; // stays within its due date — the untouched control

  it("marks a past-due campaign exactly once; a re-run adds nothing; a within-due campaign is untouched", async () => {
    expiring = await openCampaign("gco-sweep-expiring", inOneHour());
    openOne = await openCampaign("gco-sweep-open", inOneHour());

    // within due date: a sweep records nothing for either campaign
    const dryRun = await runSweep();
    expect(dryRun.campaignIds).not.toContain(expiring);
    expect(dryRun.campaignIds).not.toContain(openOne);
    expect(await sweptEventCount(expiring)).toBe(0);

    // nothing but time passes (the ADR-0046 breach-on-read idiom)
    await backdate(expiring);

    const first = await runSweep();
    expect(first.campaignIds).toContain(expiring);
    expect(first.campaignIds).not.toContain(openOne);
    expect(await sweptEventCount(expiring)).toBe(1);
    expect(first.note).toMatch(/decides nothing|no status written/);

    // idempotent: the second pass observes the SAME campaign and writes no
    // second row — the audit log carries the fact once, ever
    const second = await runSweep();
    expect(second.campaignIds).not.toContain(expiring);
    expect(await sweptEventCount(expiring)).toBe(1);

    // the open campaign within its due date stays untouched
    expect(await sweptEventCount(openOne)).toBe(0);
    expect((await campaignDetail(openOne)).status).toBe("open");
  });

  it("the swept event and the read-time computed status AGREE — and the sweep wrote no status, decided no item", async () => {
    const detail = await campaignDetail(expiring);
    // the same shared predicate produced both: the event exists ⇔ the
    // campaign reads expired-incomplete
    expect(detail.status).toBe("expired-incomplete");
    expect(detail.storedStatus).toBe("open"); // NO status was written
    for (const item of detail.items) expect(item.decision).toBeNull(); // NOTHING was decided
    // and the event row says what it recorded
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "campaign-expired-incomplete"), eq(auditLog.objectId, expiring)));
    expect(row).toBeTruthy();
    expect(row!.effect).toBe("deny");
    expect((row!.detail as { undecidedItems: number }).undecidedItems).toBe(detail.items.length);
    expect(row!.reason).toMatch(/stay undecided forever/);
  });

  it("the SCHEDULER job runs the same function through the real claim/lease machinery", async () => {
    const third = await openCampaign("gco-sweep-scheduled", inOneHour());
    await backdate(third);
    const registry = schedulerJobRegistry({ dataKey: DATA_KEY });
    await syncSchedulerJobs(db, registry);
    const sched = new Scheduler(db, { registry, instanceId: "gco-wire" });
    const out = await sched.runNow(SCHEDULER_JOB_NAMES.certificationExpiry, null);
    expect(out.outcome).toBe("ok");
    expect((out.detail as { campaignIds: string[] }).campaignIds).toContain(third);
    expect(await sweptEventCount(third)).toBe(1);
    // still only ever one row for the earlier campaign — the job path and
    // the endpoint path share one idempotent implementation
    expect(await sweptEventCount(expiring)).toBe(1);
    // and the job decided nothing there either
    expect((await campaignDetail(third)).storedStatus).toBe("open");
  });
});
