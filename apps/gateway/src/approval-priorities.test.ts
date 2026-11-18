import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approvals, approvalAssignments, approvalDelegations, approvalAssignmentRules, teams, teamMembers, roles, roleAssignments, governanceReviewPolicy, orgSettings, ORG_SETTINGS_ID, auditLog, createDb, eq, inArray, runMigrations, sql, type Db } from "@regulait/db";
import { strFromU8, unzipSync } from "fflate";
import { buildApp } from "./app.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const fixtureSuffix = Date.now();
const headers = { authorization: "Bearer c3-bootstrap-test" };
let db: Db;
let app: ReturnType<typeof buildApp>;
let requester: string;
let reviewer: string;
let outsider: string;
let reviewerAuth: { authorization: string };
let outsiderAuth: { authorization: string };
const ids: string[] = [];
let fixtureTeamId: string | undefined;
let fixtureRoleId: string | undefined;
let fixtureRuleId: string | undefined;
let fixtureDelegationId: string | undefined;
let originalDelegationEnabled: boolean | undefined;
let originalReviewPolicy: typeof governanceReviewPolicy.$inferSelect | null | undefined;
async function user(label: string) {
  const response = await app.inject({ method: "POST", url: "/v1/users", headers, payload: { email: `c3-${label}-${fixtureSuffix}@example.invalid`, displayName: `Fixture ${label}` } });
  expect(response.statusCode).toBe(201);
  const id = response.json().id as string;
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers, payload: { name: "test" } });
  expect(key.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
}
async function approval(overrides: Partial<typeof approvals.$inferInsert> = {}) {
  const [row] = await db.insert(approvals).values({ userId: requester, approverUserId: reviewer, objectType: "workflow", status: "pending", ...overrides }).returning();
  ids.push(row!.id);
  return row!;
}
function patch(id: string, priority: string, expectedPriority = "normal", auth = headers) {
  return app.inject({ method: "PATCH", url: `/v1/approvals/${id}/priority`, headers: auth, payload: { priority, expectedPriority } });
}
beforeAll(async () => {
  db = createDb(url!);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  app = buildApp(db, { bootstrapToken: "c3-bootstrap-test", dataKey: "c".repeat(64) });
  requester = (await user("requester")).id;
  const r = await user("reviewer"); reviewer = r.id; reviewerAuth = r.auth;
  const o = await user("outsider"); outsider = o.id; outsiderAuth = o.auth;
}, 120000);
afterAll(async () => {
  if (db) {
    if (originalReviewPolicy !== undefined) {
      if (originalReviewPolicy) await db.insert(governanceReviewPolicy).values(originalReviewPolicy).onConflictDoUpdate({ target: governanceReviewPolicy.id, set: originalReviewPolicy });
      else await db.delete(governanceReviewPolicy).where(eq(governanceReviewPolicy.id, "default"));
    }
    if (originalDelegationEnabled !== undefined) await db.update(orgSettings).set({ approvalDelegationEnabled: originalDelegationEnabled }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    if (fixtureRuleId) await db.delete(approvalAssignmentRules).where(eq(approvalAssignmentRules.id, fixtureRuleId));
    if (fixtureDelegationId) await db.delete(approvalDelegations).where(eq(approvalDelegations.id, fixtureDelegationId));
    if (ids.length) await db.delete(approvals).where(inArray(approvals.id, ids));
    if (fixtureTeamId) await db.delete(teams).where(eq(teams.id, fixtureTeamId));
    if (fixtureRoleId) await db.delete(roles).where(eq(roles.id, fixtureRoleId));
  }
  if (app) await app.close();
});

describe("ADR-0352 approval priority", () => {
  it("defaults to normal; mutation preserves every consent and decision field", async () => {
    const row = await approval({ quorum: 2, signatureMode: "passkey", argumentsDigest: "a".repeat(64), namedApproverUserId: reviewer });
    expect(row.priority).toBe("normal");
    const response = await patch(row.id, "urgent");
    expect(response.statusCode, response.body).toBe(200);
    const [updated] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(updated).toEqual({ ...row, priority: "urgent" });
    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, row.id));
    expect(audits.filter(a => a.ruleId === "approval-priority-changed")).toHaveLength(1);
    expect(audits.find(a => a.ruleId === "approval-priority-changed")!.detail).toEqual({ receiptClass: "excluded", approvalId: row.id, from: "normal", to: "urgent" });
    expect((await patch(row.id, "urgent", "urgent")).json().changed).toBe(false);
  });
  it("refuses non-admins, unknown levels, stale writes and every decided status", async () => {
    const row = await approval();
    expect((await patch(row.id, "high", "normal", reviewerAuth)).statusCode).toBe(403);
    expect((await patch(row.id, "high", "normal", outsiderAuth)).statusCode).toBe(403);
    expect((await patch(row.id, "critical")).statusCode).toBe(400);
    expect((await patch(row.id, "high", "low")).statusCode).toBe(409);
    for (const status of ["approved", "denied", "returned", "consumed", "superseded"] as const) {
      const decided = await approval({ status });
      expect((await patch(decided.id, "high")).json().error).toBe("approval_not_pending");
    }
  });
  it("serializes concurrent writes at one expected priority", async () => {
    const row = await approval();
    const results = await Promise.all([patch(row.id, "high"), patch(row.id, "low")]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const audit = await db.select().from(auditLog).where(eq(auditLog.objectId, row.id));
    expect(audit.filter(a => a.ruleId === "approval-priority-changed")).toHaveLength(1);
  });
  it("refuses a priority edit after a concurrent terminal transition wins the row lock", async () => {
    const row = await approval();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const terminal = db.transaction(async tx => {
      await tx.select().from(approvals).where(eq(approvals.id, row.id)).for("update");
      acquired();
      await gate;
      await tx.update(approvals).set({ status: "superseded" }).where(eq(approvals.id, row.id));
    });
    await locked;
    const pendingEdit = patch(row.id, "urgent");
    release();
    await terminal;
    expect((await pendingEdit).statusCode).toBe(409);
    const [fresh] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(fresh).toMatchObject({ status: "superseded", priority: "normal" });
  });
  it("rolls back the metadata update if the audit insertion fails", async () => {
    const row = await approval();
    // Transaction-local test trigger rejects this one audit only; removed in finally.
    await db.execute(sql`CREATE FUNCTION c3_refuse_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN IF NEW.rule_id = 'approval-priority-changed' THEN RAISE EXCEPTION 'test audit refusal'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER c3_refuse_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION c3_refuse_audit()`);
    try {
      expect((await patch(row.id, "high")).statusCode).toBe(500);
      const [fresh] = await db.select().from(approvals).where(eq(approvals.id, row.id));
      expect(fresh!.priority).toBe("normal");
    } finally {
      await db.execute(sql`DROP TRIGGER c3_refuse_audit ON audit_log`);
      await db.execute(sql`DROP FUNCTION c3_refuse_audit()`);
    }
  });
  it("filters and sorts server-side while preserving the legacy default", async () => {
    const earlier = await approval({ priority: "low", requestedAt: new Date("2025-01-01T00:00:00Z") });
    const later = await approval({ priority: "urgent", requestedAt: new Date("2025-01-02T00:00:00Z") });
    const legacy = await app.inject({ url: "/v1/approvals?order=asc", headers: reviewerAuth });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().approvals.slice(0, 2).map((r: { id: string }) => r.id)).toEqual([earlier.id, later.id]);
    const filtered = await app.inject({ url: "/v1/approvals?priority=urgent&sort=priority&dir=desc&count=exact", headers: reviewerAuth });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items.every((r: { priority: string }) => r.priority === "urgent")).toBe(true);
    const legacyFilter = await app.inject({ url: "/v1/approvals?priority=low", headers: reviewerAuth });
    expect(legacyFilter.json().approvals.every((r: { priority: string }) => r.priority === "low")).toBe(true);
    const widget = await app.inject({ url: "/v1/approvals/task-widget?sort=priority&dir=desc&limit=100", headers: reviewerAuth });
    const rank: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
    const ranks = widget.json().items.map((r: { priority: string }) => rank[r.priority]);
    expect(ranks).toEqual([...ranks].sort((a: number, b: number) => b - a));
    const exported = await app.inject({ url: "/v1/approvals/export.xlsx?priority=urgent&columns=priority&sort=priority&dir=desc", headers: reviewerAuth });
    expect(exported.statusCode, exported.body).toBe(200);
    const files = unzipSync(new Uint8Array(exported.rawPayload));
    const xml = Object.values(files).map((data) => strFromU8(data)).join(" ");
    expect(xml).toContain("urgent");
    expect(xml).not.toContain(">low<");
    expect(xml).not.toContain(">normal<");
  });
  it("widget uses canonical visibility, bounds paging and never returns raw content", async () => {
    const visible = await approval({ toolName: "sensitive-content-sentinel", decisionReason: "sensitive-reason-sentinel" });
    const hidden = await approval({ approverUserId: outsider });
    for (let n = 0; n < 11; n++) await approval();
    const widget = await app.inject({ url: "/v1/approvals/task-widget?limit=10&count=exact", headers: reviewerAuth });
    expect(widget.statusCode).toBe(200);
    expect(widget.json().items.length).toBeLessThanOrEqual(10);
    expect(widget.json().nextCursor).toBeTruthy();
    expect(JSON.stringify(widget.json())).not.toContain("sensitive-");
    const all = await app.inject({ url: "/v1/approvals/task-widget?limit=100&count=exact", headers: reviewerAuth });
    expect(all.json().items.some((r: { id: string }) => r.id === visible.id)).toBe(true);
    expect(all.json().items.some((r: { id: string }) => r.id === hidden.id)).toBe(false);
    for (const item of all.json().items) {
      expect(item.priorityLifecycle.transitions.every((t: { allowed: boolean }) => !t.allowed)).toBe(true);
      expect(item.links.priority).toBeNull();
      expect(item.deadlines.workflowStage.available).toBe(false);
    }
    expect((await app.inject({ url: "/v1/approvals/task-widget?limit=100000", headers: reviewerAuth })).statusCode).toBe(400);
  });

  it("delegation, team/role membership and claimed load use canonical queue visibility", async () => {
    const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    originalDelegationEnabled = settings!.approvalDelegationEnabled;
    await db.update(orgSettings).set({ approvalDelegationEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const delegated = await user("delegated");
    const member = await user("member");
    const nonmember = await user("nonmember");
    const [team] = await db.insert(teams).values({ name: `c3-team-${fixtureSuffix}` }).returning();
    const [role] = await db.insert(roles).values({ name: `c3-role-${fixtureSuffix}` }).returning();
    fixtureTeamId = team!.id; fixtureRoleId = role!.id;
    await db.insert(teamMembers).values({ teamId: team!.id, userId: member.id });
    await db.insert(roleAssignments).values({ roleId: role!.id, userId: member.id });
    const [delegation] = await db.insert(approvalDelegations).values({ fromUserId: reviewer, toUserId: delegated.id, startsAt: new Date(Date.now() - 60000), endsAt: new Date(Date.now() + 3600000) }).returning();
    fixtureDelegationId = delegation!.id;
    const rule = await app.inject({ method: "POST", url: "/v1/approvals/assignment-rules", headers, payload: { name: `c3-route-${fixtureSuffix}`, objectType: "connector", assigneeKind: "user", assigneeId: reviewer } });
    expect(rule.statusCode, rule.body).toBe(201);
    fixtureRuleId = rule.json().rule.id;
    [originalReviewPolicy = null] = await db.select().from(governanceReviewPolicy).where(eq(governanceReviewPolicy.id, "default"));
    const reviewRoles = [...(originalReviewPolicy?.roles ?? []), { id: `c3-review-${fixtureSuffix}`, name: "Fixture review", memberUserIds: [member.id] }];
    await db.insert(governanceReviewPolicy).values({ id: "default", roles: reviewRoles }).onConflictDoUpdate({ target: governanceReviewPolicy.id, set: { roles: reviewRoles } });
    const poolTask = await approval({ objectType: "mcp_tool", userId: requester, approverUserId: outsider, namedApproverUserId: outsider, approverRoleId: role!.id });
    const reviewTask = await approval({ userId: requester, approverUserId: outsider, reviewRoleId: `c3-review-${fixtureSuffix}`, reviewRoleName: "Fixture review", reviewRound: 1 });
    const direct = await approval();
    const teamTask = await approval({ approverUserId: requester, priority: "high" });
    const roleTask = await approval({ approverUserId: requester, priority: "urgent" });
    const dueAt = new Date(Date.now() + 3600000);
    await db.insert(approvalAssignments).values([
      { approvalId: teamTask.id, assigneeKind: "team", assigneeId: team!.id, claimedByUserId: member.id, claimedAt: new Date(), dueAt, slaState: "ok" },
      { approvalId: roleTask.id, assigneeKind: "role", assigneeId: role!.id },
    ]);
    for (const actor of [member, delegated, nonmember]) {
      const list = await app.inject({ url: "/v1/approvals?status=pending&count=exact&limit=100", headers: actor.auth });
      const widget = await app.inject({ url: "/v1/approvals/task-widget?status=pending&count=exact&limit=100", headers: actor.auth });
      const load = await app.inject({ url: "/v1/approvals/workload", headers: actor.auth });
      expect(list.statusCode, list.body).toBe(200);
      expect(widget.statusCode, widget.body).toBe(200);
      expect(load.statusCode, load.body).toBe(200);
      expect(widget.json().items.map((r: { id: string }) => r.id).sort()).toEqual(list.json().items.map((r: { id: string }) => r.id).sort());
      expect(load.json().workload.reduce((n: number, b: { open: number }) => n + b.open, 0)).toBe(list.json().total);
      if (actor === member) {
        expect(widget.json().items.some((r: { id: string }) => r.id === poolTask.id)).toBe(true);
        expect(widget.json().items.some((r: { id: string }) => r.id === reviewTask.id)).toBe(true);
        expect(widget.json().items.some((r: { id: string }) => r.id === teamTask.id)).toBe(true);
        expect(widget.json().items.some((r: { id: string }) => r.id === roleTask.id)).toBe(true);
        expect(load.json().assigneeLoad.find((b: { userId: string }) => b.userId === member.id)).toMatchObject({ open: 1, claimed: 1, priorities: { high: 1 } });
        expect(widget.json().items.find((r: { id: string }) => r.id === teamTask.id).deadlines.assignment.dueAt).toBe(dueAt.toISOString());
      } else if (actor === delegated) {
        expect(widget.json().items.some((r: { id: string }) => r.id === direct.id)).toBe(true);
      } else {
        expect(widget.json().items).toHaveLength(0);
        expect(load.json().assigneeLoad).toHaveLength(0);
      }
    }
  });
  it("workload is scoped to the same queue and counts beyond one widget page", async () => {
    const queue = await app.inject({ url: "/v1/approvals?status=pending&count=exact&limit=100", headers: reviewerAuth });
    const workload = await app.inject({ url: "/v1/approvals/workload", headers: reviewerAuth });
    expect(workload.statusCode).toBe(200);
    expect(workload.json().workload.reduce((n: number, b: { open: number }) => n + b.open, 0)).toBe(queue.json().total);
    expect(workload.json().assigneeLoad.find((b: { userId: string }) => b.userId === outsider)).toBeUndefined();
    const load = workload.json().assigneeLoad.find((b: { userId: string }) => b.userId === reviewer);
    expect(Object.values(load.priorities).reduce((a: number, b) => a + Number(b), 0)).toBe(load.open);
  });
});
