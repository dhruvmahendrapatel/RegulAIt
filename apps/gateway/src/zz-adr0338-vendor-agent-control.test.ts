/**
 * ADR-0338 slice 1 — governed vendor agent control, end to end (real database, an in-memory vendor: fixtures only).
 *
 *  - the org switch is off by default; turning it on is a `settings_relax` step-up bound to its key; the approval
 *    window may be shortened freely, lengthening it past 24 hours is a step-up;
 *  - with no control member or no control credential a registry offers nothing;
 *  - a request needs a `settings_relax` step-up bound to it; an identical repeat is idempotent, a different open action
 *    for the same agent is refused; the approver is a second active admin;
 *  - the decide path refuses the requester, an admin outside the pool, no step-up and a step-up for another digest;
 *  - execute: only the requester, with a fresh step-up, once; prior and observed state are recorded;
 *  - the kill switch (owner decision 2): under every non-normal dial disable and quarantine run, restore is refused
 *    with nothing sent; restore runs once the dial is back to normal;
 *  - a replaced credential is `approval_payload_mismatch`; an expired approval is cancelled on the next touch;
 *  - a crash (lease past) moves `executing → unknown` and is settled by a read; a live lease is never taken over;
 *  - a vendor timeout leaves `unknown`; a settle that reads the prior state ends `failed / not_applied`;
 *  - cancel needs no step-up and supersedes the approval.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agentRegistryRecords,
  approvals,
  auditLog,
  createDb,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  users,
  vendorAgentActions,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, DISCOVERY_STEP_UP_KEYS } from "@regulait/shared";
import { buildApp } from "./app.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { fakeCredentials, fakeVendorControl, seedRegistryAgent } from "./testing/vendor-agent-control-fixture.js";
import {
  requestActionSchema,
  vendorControlDecideStepUp,
  vendorControlExecuteStepUp,
  vendorControlRequestStepUp,
  vendorControlSettleStepUp,
} from "./vendor-agent-control.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `a338-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
// synthetic, derived at runtime: never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`a338-data-key-${RUN}`).digest("hex");
const URL_ = "/v1/vendor-agent-control/actions";

const vendor = fakeVendorControl();
const credentials = fakeCredentials();

let db: Db;
let app: ReturnType<typeof buildApp>;
let bare: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let approverId: string;
let otherAdminId: string;
const restores: Array<() => Promise<unknown>> = [];
const sourceIds: string[] = [];

type Method = "GET" | "POST" | "PUT";
type Action = { id: string; status: string; approvalId: string; outcomeCode: string | null; priorState: string | null; observedState: string | null; lifecycle: { transitions: Array<{ event: string; allowed: boolean; reason?: string }> } };

/** a browser request as `who`: with `args`, carrying a grant made for exactly that; otherwise the session alone */
async function as(who: string, args: StepUpCheckArgs | null, method: Method, url: string, payload?: unknown, via = app) {
  const g = await grantStepUpForTest(db, who, args ?? { kind: "settings_relax", facts: { unused: RUN } });
  const r = args ? stepUpRequest(g) : sessionRequest(g);
  const res = await via.inject({ method, url, headers: r.headers, cookies: r.cookies, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { res, grantId: g.grantId };
}
const body = (recordId: string, action: string, extra: Record<string, unknown> = {}) => ({ recordId, action, approverUserId: approverId, reason: `a338 ${RUN}`, ...extra });
const stepFor = (b: Record<string, unknown>) => vendorControlRequestStepUp(requestActionSchema.parse(b));
async function request(b: Record<string, unknown>, expected = 201) {
  const { res } = await as(adminId, stepFor(b), "POST", URL_, b);
  expect(res.statusCode, res.body).toBe(expected);
  return res.json().action as Action;
}
const rowOf = async (id: string) => (await db.select().from(vendorAgentActions).where(eq(vendorAgentActions.id, id)))[0]!;
const approvalOf = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
async function decide(a: Action, decision: "approved" | "denied" = "approved", who = approverId, grant: "right" | "none" | "wrong" = "right", reason?: string) {
  const ap = await approvalOf(a.approvalId);
  const args = vendorControlDecideStepUp(ap.id, decision, grant === "wrong" ? "0".repeat(64) : ap.argumentsDigest!);
  const g = await grantStepUpForTest(db, who, args);
  const r = grant === "none" ? sessionRequest(g) : stepUpRequest(g);
  return app.inject({ method: "POST", url: `/v1/approvals/${ap.id}/decide`, headers: r.headers, cookies: r.cookies, payload: { decision, ...(reason ? { reason } : {}) } });
}
async function execute(a: Action, who = adminId, withStep = true) {
  const row = await rowOf(a.id);
  return as(who, withStep ? vendorControlExecuteStepUp(row) : null, "POST", `${URL_}/${a.id}/execute`, {});
}
const settle = (id: string) => as(adminId, vendorControlSettleStepUp(id), "POST", `${URL_}/${id}/settle`, {});
const setMode = (mode: "normal" | "halted" | "read_only" | "require_approval") =>
  db.update(orgSettings).set({ executionMode: mode, executionModeReason: mode === "normal" ? null : `a338 ${mode}`, ...(mode === "require_approval" ? { executionModeApproverUserId: approverId } : {}) }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
const setSwitch = (on: boolean) => db.update(discoverySettings).set({ vendorAgentControlEnabled: on }).where(eq(discoverySettings.id, 1));
/** a fresh agent with a live control credential */
async function agent() {
  const a = await seedRegistryAgent(db, { run: RUN, createdBy: adminId, sourceIds });
  credentials.issue(a.sourceId);
  return a;
}
/** requested and approved (expects both to succeed) */
async function approved(recordId: string, action = "quarantine", extra: Record<string, unknown> = {}) {
  const a = await request(body(recordId, action, extra));
  const d = await decide(a);
  expect(d.statusCode, d.body).toBe(200);
  expect((await rowOf(a.id)).status).toBe("approved");
  return a;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [s0] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restores.push(() => db.update(discoverySettings).set({ vendorAgentControlEnabled: s0!.vendorAgentControlEnabled, vendorAgentControlApprovalTtlHours: s0!.vendorAgentControlApprovalTtlHours }).where(eq(discoverySettings.id, 1)));
  const [o0] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(() => db.update(orgSettings).set({ stepUpMode: o0!.stepUpMode, stepUpActions: o0!.stepUpActions, executionMode: o0!.executionMode, executionModeReason: o0!.executionModeReason }).where(eq(orgSettings.id, ORG_SETTINGS_ID)));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, vendorAgentControl: { controls: { entra_agent_id: vendor.control }, credentialFor: credentials.resolver } });
  bare = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await Promise.all([app.ready(), bare.ready()]);
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const ids: string[] = [];
  for (const who of ["admin", "approver", "other"]) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `a338-${who}-${RUN}@example.com`, displayName: `a338 ${who}` } });
    expect(u.statusCode, u.body).toBe(201);
    await db.update(users).set({ isAdmin: true, totpEnabled: true }).where(eq(users.id, u.json().id));
    ids.push(u.json().id);
  }
  [adminId, approverId, otherAdminId] = ids as [string, string, string];
  adminKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
  await setMode("normal");
}, 120_000);

afterAll(async () => {
  if (db) {
    await setMode("normal");
    if (sourceIds.length) {
      const recs = await db.select({ id: agentRegistryRecords.id }).from(agentRegistryRecords).where(inArray(agentRegistryRecords.sourceId, sourceIds));
      if (recs.length) {
        const rows = await db.select({ id: vendorAgentActions.id, approvalId: vendorAgentActions.approvalId }).from(vendorAgentActions).where(inArray(vendorAgentActions.recordId, recs.map((r) => r.id)));
        // restores first (they reference the actions they reverse)
        await db.delete(vendorAgentActions).where(and2(rows.map((r) => r.id), true));
        await db.delete(vendorAgentActions).where(and2(rows.map((r) => r.id), false));
        if (rows.length) await db.delete(approvals).where(inArray(approvals.id, rows.map((r) => r.approvalId)));
      }
      await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
    }
    for (const id of [adminId, approverId, otherAdminId]) if (id) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, id));
    for (const r of restores.reverse()) await r();
  }
  await app?.close();
  await bare?.close();
});
const and2 = (ids: string[], reverses: boolean) =>
  ids.length ? sql`${vendorAgentActions.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND ${reverses ? sql`${vendorAgentActions.reversesActionId} IS NOT NULL` : sql`TRUE`}` : sql`FALSE`;

describe("ADR-0338: the org switch and the approval window", () => {
  it("is off by default; on needs the settings_relax step-up bound to it; off is free", async () => {
    await setSwitch(false);
    const s = await app.inject({ method: "GET", url: "/v1/discovery/settings", headers: adminKey });
    expect(s.json()).toMatchObject({ vendorAgentControl: false, vendorAgentControlApprovalTtlHours: expect.any(Number) });
    const a = await agent();
    const off = await as(adminId, stepFor(body(a.recordId, "quarantine")), "POST", URL_, body(a.recordId, "quarantine"));
    expect(off.res.statusCode, off.res.body).toBe(403);
    expect(off.res.json().error).toBe("vendor_agent_control_disabled");
    expect(await grantSpent(db, off.grantId)).toBe(false);
    const version = s.json().version as number;
    const noGrant = await as(adminId, null, "PUT", "/v1/discovery/settings", { version, vendorAgentControl: true });
    expect(noGrant.res.statusCode).toBe(403);
    const step: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.vendorAgentControl]: true } } };
    const on = await as(adminId, step, "PUT", "/v1/discovery/settings", { version, vendorAgentControl: true });
    expect(on.res.statusCode, on.res.body).toBe(200);
    expect(on.res.json().vendorAgentControl).toBe(true);
    const offAgain = await as(adminId, null, "PUT", "/v1/discovery/settings", { version: on.res.json().version, vendorAgentControl: false });
    expect(offAgain.res.statusCode, offAgain.res.body).toBe(200);
    await setSwitch(true);
  });

  it("shortening the window is free; lengthening it past 24 hours is a step-up", async () => {
    await db.update(discoverySettings).set({ vendorAgentControlApprovalTtlHours: 24 }).where(eq(discoverySettings.id, 1));
    const v = () => app.inject({ method: "GET", url: "/v1/discovery/settings", headers: adminKey }).then((r) => r.json().version as number);
    const shorter = await as(adminId, null, "PUT", "/v1/discovery/settings", { version: await v(), vendorAgentControlApprovalTtlHours: 12 });
    expect(shorter.res.statusCode, shorter.res.body).toBe(200);
    const longer = await as(adminId, null, "PUT", "/v1/discovery/settings", { version: await v(), vendorAgentControlApprovalTtlHours: 48 });
    expect(longer.res.statusCode).toBe(403);
    const step: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.vendorAgentControlTtl]: 48 } } };
    const ok = await as(adminId, step, "PUT", "/v1/discovery/settings", { version: await v(), vendorAgentControlApprovalTtlHours: 48 });
    expect(ok.res.statusCode, ok.res.body).toBe(200);
    expect((await as(adminId, null, "PUT", "/v1/discovery/settings", { version: await v(), vendorAgentControlApprovalTtlHours: 73 })).res.statusCode).toBe(400);
    await db.update(discoverySettings).set({ vendorAgentControlApprovalTtlHours: 24 }).where(eq(discoverySettings.id, 1));
  });
});

describe("ADR-0338: request", () => {
  it("offers nothing without a control member (production) or without a control credential", async () => {
    await setSwitch(true);
    const a = await seedRegistryAgent(db, { run: RUN, createdBy: adminId, sourceIds });
    const noControl = await as(adminId, stepFor(body(a.recordId, "quarantine")), "POST", URL_, body(a.recordId, "quarantine"), bare);
    expect(noControl.res.json().error).toBe("control_not_offered");
    const noCred = await as(adminId, stepFor(body(a.recordId, "quarantine")), "POST", URL_, body(a.recordId, "quarantine"));
    expect(noCred.res.statusCode).toBe(409);
    expect(noCred.res.json().error).toBe("no_control_credential");
    expect(await grantSpent(db, noCred.grantId)).toBe(false);
  });

  it("needs a step-up bound to it; is idempotent; refuses a second open action and an ineligible approver", async () => {
    const a = await agent();
    const b = body(a.recordId, "quarantine");
    const none = await as(adminId, null, "POST", URL_, b);
    expect(none.res.statusCode).toBe(403);
    const wrong = await as(adminId, stepFor(body(a.recordId, "disable")), "POST", URL_, b);
    expect(wrong.res.statusCode).toBe(403);
    expect(await grantSpent(db, wrong.grantId)).toBe(false);
    expect((await db.select().from(vendorAgentActions).where(eq(vendorAgentActions.recordId, a.recordId))).length).toBe(0);
    const self = await as(adminId, vendorControlRequestStepUp(requestActionSchema.parse({ ...b, approverUserId: adminId })), "POST", URL_, { ...b, approverUserId: adminId });
    expect(self.res.json().error).toBe("approver_is_requester");

    const first = await request(b);
    expect(first.status).toBe("requested");
    const ap = await approvalOf(first.approvalId);
    expect(ap).toMatchObject({ objectType: "vendor_agent_control", status: "pending", approverUserId: approverId });
    expect(ap.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(ap.expiresAt!.getTime() - ap.requestedAt.getTime()).toBeGreaterThan(23 * 3600_000);
    const audits = await db.select().from(auditLog).where(sql`${auditLog.objectId} = ${first.id} AND ${auditLog.ruleId} = 'vendor-agent-control-requested'`);
    expect(audits).toHaveLength(1);
    const again = await as(adminId, stepFor(b), "POST", URL_, b);
    expect(again.res.statusCode, again.res.body).toBe(200);
    expect(again.res.json()).toMatchObject({ idempotent: true, action: { id: first.id } });
    const other = await as(adminId, stepFor(body(a.recordId, "disable")), "POST", URL_, body(a.recordId, "disable"));
    expect(other.res.statusCode).toBe(409);
    expect(other.res.json().error).toBe("action_already_open");
    // a restore of nothing is refused
    const restore = body(a.recordId, "restore", { reverses: first.id });
    expect((await as(adminId, stepFor(restore), "POST", URL_, restore)).res.json().error).toBe("nothing_to_restore");
  });
});

describe("ADR-0338: decide", () => {
  it("refuses the requester, an admin outside the pool, no step-up and a step-up for another digest; nothing moves", async () => {
    const a = await agent();
    const act = await request(body(a.recordId, "disable"));
    // through the admin override (which needs a reason): still refused by name
    const own = await decide(act, "approved", adminId, "right", "override");
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_vendor_action");
    const outside = await decide(act, "approved", otherAdminId, "right", "override");
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error).toBe("not_an_eligible_approver");
    expect((await decide(act, "approved", approverId, "none")).statusCode).toBe(403);
    expect((await decide(act, "approved", approverId, "wrong")).statusCode).toBe(403);
    expect((await rowOf(act.id)).status).toBe("requested");
    const denied = await decide(act, "denied");
    expect(denied.statusCode, denied.body).toBe(200);
    expect(await rowOf(act.id)).toMatchObject({ status: "denied", outcomeCode: "denied_by_approver" });
  });
});

describe("ADR-0338: execute", () => {
  it("only the requester, with a fresh step-up, once; records prior and observed state", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "quarantine");
    const calls = vendor.calls.length;
    expect((await execute(act, otherAdminId)).res.json().error).toBe("not_the_requester");
    // review of #1120: without the step-up no vendor token is minted
    const minted = credentials.acquired;
    expect((await execute(act, adminId, false)).res.statusCode).toBe(403);
    expect(credentials.acquired).toBe(minted);
    expect(vendor.calls.length).toBe(calls);
    const ran = await execute(act);
    expect(ran.res.statusCode, ran.res.body).toBe(200);
    expect(ran.res.json().action).toMatchObject({ status: "succeeded", priorState: "active", observedState: "quarantined", outcomeCode: "applied" });
    expect((await approvalOf(act.approvalId)).status).toBe("consumed");
    expect(vendor.calls.length).toBe(calls + 1);
    const twice = await execute(act);
    expect(twice.res.statusCode).toBe(409);
    expect(vendor.calls.length).toBe(calls + 1);
    const rules = (await db.select({ r: auditLog.ruleId }).from(auditLog).where(eq(auditLog.objectId, act.id))).map((x) => x.r);
    expect(rules).toEqual(expect.arrayContaining(["vendor-agent-control-requested", "vendor-agent-control-approved", "vendor-agent-control-executing", "vendor-agent-control-succeeded"]));
  });

  it("a replaced credential is approval_payload_mismatch and nothing is sent", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "disable");
    credentials.issue(a.sourceId);
    const calls = vendor.calls.length;
    const res = await execute(act);
    expect(res.res.statusCode).toBe(409);
    expect(res.res.json()).toMatchObject({ error: "approval_payload_mismatch", why: "approval_payload_mismatch" });
    expect(vendor.calls.length).toBe(calls);
    expect((await rowOf(act.id)).status).toBe("approved");
  });
});

describe("ADR-0338 §7: the kill switch allows narrowing only", () => {
  for (const mode of ["halted", "read_only", "require_approval"] as const) {
    it(`under '${mode}': quarantine and disable execute, restore is refused with nothing sent`, async () => {
      const q = await agent();
      const d = await agent();
      const qa = await approved(q.recordId, "quarantine");
      const da = await approved(d.recordId, "disable");
      // a restore approved under normal, to be refused under the dial
      const rs = await agent();
      const first = await approved(rs.recordId, "disable");
      expect((await execute(first)).res.json().action.status).toBe("succeeded");
      const restore = await approved(rs.recordId, "restore", { reverses: first.id });
      await setMode(mode);
      try {
        expect((await execute(qa)).res.json().action.status).toBe("succeeded");
        expect((await execute(da)).res.json().action.status).toBe("succeeded");
        const calls = vendor.calls.length;
        const refused = await execute(restore);
        expect(refused.res.statusCode).toBe(409);
        expect(refused.res.json().error).toBe(mode === "halted" ? "execution_halted" : mode === "read_only" ? "execution_read_only" : "execution_requires_approval");
        expect(vendor.calls.length).toBe(calls);
        expect((await rowOf(restore.id)).status).toBe("approved");
        const view = await app.inject({ method: "GET", url: `${URL_}/${restore.id}`, headers: adminKey });
        expect(view.json().action.lifecycle.transitions.find((t: { event: string }) => t.event === "execute")).toMatchObject({ allowed: false, reason: expect.stringContaining(mode) });
      } finally {
        await setMode("normal");
      }
      const back = await execute(restore);
      expect(back.res.json().action).toMatchObject({ status: "succeeded", observedState: "active" });
      // restored once: a second restore is refused
      const again = body(rs.recordId, "restore", { reverses: first.id });
      expect((await as(adminId, stepFor(again), "POST", URL_, again)).res.json().error).toBe("already_restored");
    });
  }
});

describe("ADR-0338: expiry, crash recovery, settle and cancel", () => {
  it("an expired approval is cancelled on the next touch and never blocks a new request", async () => {
    const a = await agent();
    const act = await request(body(a.recordId, "quarantine"));
    await db.update(approvals).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(approvals.id, act.approvalId));
    const next = await request(body(a.recordId, "disable"));
    expect(await rowOf(act.id)).toMatchObject({ status: "cancelled", outcomeCode: "approval_expired" });
    expect((await approvalOf(act.approvalId)).status).toBe("superseded");
    expect(next.status).toBe("requested");
  });

  it("a crash past the lease moves to unknown and is settled by a read; a live lease is not taken over", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "quarantine");
    await db.update(vendorAgentActions).set({ status: "executing", leaseExpiresAt: sql`now() + interval '5 minutes'` }).where(eq(vendorAgentActions.id, act.id));
    await app.inject({ method: "GET", url: `${URL_}/${act.id}`, headers: adminKey });
    expect((await rowOf(act.id)).status).toBe("executing");
    expect((await as(adminId, stepFor(body(a.recordId, "disable")), "POST", URL_, body(a.recordId, "disable"))).res.json().error).toBe("action_already_open");
    await db.update(vendorAgentActions).set({ leaseExpiresAt: sql`now() - interval '1 second'`, priorState: "active" }).where(eq(vendorAgentActions.id, act.id));
    const read = await app.inject({ method: "GET", url: `${URL_}/${act.id}`, headers: adminKey });
    expect(read.json().action).toMatchObject({ status: "unknown", outcomeCode: "lease_expired" });
    // the vendor did act before the crash: the read settles it, with no second apply
    vendor.states.set(a.externalId, "quarantined");
    const calls = vendor.calls.length;
    const s = await settle(act.id);
    expect(s.res.statusCode, s.res.body).toBe(200);
    expect(s.res.json()).toMatchObject({ settled: true, action: { status: "succeeded", observedState: "quarantined" } });
    expect(vendor.calls.length).toBe(calls);
  });

  it("a vendor timeout leaves unknown; a settle that reads the prior state ends failed / not_applied", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "disable");
    vendor.behave("timeout");
    try {
      const res = await execute(act);
      expect(res.res.json().action).toMatchObject({ status: "unknown", outcomeCode: "vendor_timeout", priorState: "active" });
    } finally {
      vendor.behave("ok");
    }
    vendor.unreadable(true);
    try {
      expect((await settle(act.id)).res.json()).toMatchObject({ settled: false, action: { status: "unknown" } });
    } finally {
      vendor.unreadable(false);
    }
    expect((await settle(act.id)).res.json().action).toMatchObject({ status: "failed", outcomeCode: "not_applied" });
  });

  it("#1096 review 1: a crash where the vendor did not act settles failed / not_applied and frees the agent", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "quarantine");
    // the process died before anything was recorded: no prior state, the lease in the past
    await db.update(vendorAgentActions).set({ status: "executing", leaseExpiresAt: sql`now() - interval '1 second'`, priorState: null }).where(eq(vendorAgentActions.id, act.id));
    expect((await app.inject({ method: "GET", url: `${URL_}/${act.id}`, headers: adminKey })).json().action).toMatchObject({ status: "unknown", priorState: null });
    const calls = vendor.calls.length;
    expect((await settle(act.id)).res.json().action).toMatchObject({ status: "failed", outcomeCode: "not_applied", observedState: "active" });
    expect(vendor.calls.length).toBe(calls);
    // the agent is not left unactionable: a new request is accepted
    expect((await request(body(a.recordId, "quarantine"))).status).toBe("requested");
  });

  it("#1096 review 1: an unreadable prior and a timeout still settle failed / not_applied once the state reads", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "disable");
    vendor.unreadable(true);
    vendor.behave("timeout");
    try {
      expect((await execute(act)).res.json().action).toMatchObject({ status: "unknown", priorState: "unknown", outcomeCode: "vendor_timeout" });
    } finally {
      vendor.unreadable(false);
      vendor.behave("ok");
    }
    expect((await settle(act.id)).res.json().action).toMatchObject({ status: "failed", outcomeCode: "not_applied" });
  });

  it("#1096 review 1: the prior state is recorded before the vendor call", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "quarantine");
    const original = vendor.control.apply;
    let seen: string | null | undefined;
    vendor.control.apply = async (ctx, ref, action) => {
      seen = (await rowOf(act.id)).priorState;
      return original(ctx, ref, action);
    };
    try {
      expect((await execute(act)).res.json().action.status).toBe("succeeded");
    } finally {
      vendor.control.apply = original;
    }
    expect(seen).toBe("active");
  });

  it("a vendor refusal ends failed with its fixed code and status", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "quarantine");
    vendor.behave("refuse");
    try {
      expect((await execute(act)).res.json().action).toMatchObject({ status: "failed", outcomeCode: "vendor_refused_credential", httpStatus: 403 });
    } finally {
      vendor.behave("ok");
    }
  });

  it("cancel needs no step-up, supersedes the approval and is idempotent; an executed action cannot be cancelled", async () => {
    const a = await agent();
    const act = await approved(a.recordId, "quarantine");
    const c = await app.inject({ method: "POST", url: `${URL_}/${act.id}/cancel`, headers: adminKey, payload: {} });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().action.status).toBe("cancelled");
    expect((await approvalOf(act.approvalId)).status).toBe("superseded");
    expect((await app.inject({ method: "POST", url: `${URL_}/${act.id}/cancel`, headers: adminKey, payload: {} })).json().alreadyCancelled).toBe(true);
    expect((await execute(act)).res.statusCode).toBe(409);
    const b = await agent();
    const done = await approved(b.recordId, "quarantine");
    await execute(done);
    expect((await app.inject({ method: "POST", url: `${URL_}/${done.id}/cancel`, headers: adminKey, payload: {} })).statusCode).toBe(409);
  });

  it("lists actions under the list contract", async () => {
    const res = await app.inject({ method: "GET", url: `${URL_}?limit=10`, headers: adminKey });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, controlledRegistries: ["entra_agent_id"] });
    expect(Array.isArray(res.json().items ?? res.json().rows)).toBe(true);
  });
});
