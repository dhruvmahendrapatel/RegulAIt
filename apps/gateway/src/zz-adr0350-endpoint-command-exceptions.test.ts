/**
 * ADR-0350 §5 (lane E31) — endpoint device groups and time-limited per-device command-rule exceptions, end to end
 * (real database).
 *
 *  - the lifecycle is the shared table: request → approve → (derived) expired, request → reject, request → cancel,
 *    approved → revoke; every other transition is a 409, and a decided exception cannot be decided again;
 *  - nobody approves their own exception: refused at request (naming yourself), at decide (route), and by the database
 *    CHECK even when the route is bypassed; only the named approver may approve, by the exact terms digest;
 *  - the expiry is set on the database clock at approval, never more than `hours` later, and `expired` is derived;
 *  - group rules only narrow (an allow rule is refused) and a pattern the device would refuse is refused here;
 *  - every write is audited; every route is admin-only.
 *
 * Everything this suite creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  discoverySources,
  endpointCommandExceptions,
  endpointDeviceGroups,
  endpointDevices,
  endpointEnrolmentTokens,
  eq,
  inArray,
  runMigrations,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e31-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e31-data-key-${RUN}`).digest("hex");
const hex = (s: string, n: number) => createHash("sha256").update(`${s}-${RUN}`).digest("hex").slice(0, n);

let db: Db;
let app: ReturnType<typeof buildApp>;
const ids: Record<"a" | "b" | "member", string> = { a: "", b: "", member: "" };
const keys: Record<"a" | "b" | "member", { authorization: string }> = { a: { authorization: "" }, b: { authorization: "" }, member: { authorization: "" } };
let sourceId: string;
let deviceId: string;
const groupIds: string[] = [];

const post = (url: string, payload: unknown, who: "a" | "b" | "member" = "a") => app.inject({ method: "POST", url, headers: keys[who], payload: payload as object });

async function user(name: "a" | "b" | "member", admin: boolean) {
  const r = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e31-${name}-${RUN}@example.com`, displayName: `e31 ${name}` } });
  ids[name] = r.json().id;
  if (admin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, ids[name]));
  keys[name] = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${ids[name]}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
}

/** a call as `who`'s browser session carrying a step-up grant for exactly `args` */
async function stepped(method: "POST" | "DELETE", url: string, payload: unknown, who: "a" | "b", args: StepUpCheckArgs) {
  const g = stepUpRequest(await grantStepUpForTest(db, ids[who], args));
  return app.inject({ method, url, headers: g.headers, cookies: g.cookies, payload: payload as object });
}
const approveStep = (ex: { id: string; termsDigest: string }): StepUpCheckArgs => ({ kind: "approval_decide", facts: { endpointCommandException: ex.id, termsDigest: ex.termsDigest } });
const approve = (ex: { id: string; termsDigest: string }) => stepped("POST", `/v1/endpoint-command-exceptions/${ex.id}/approve`, { termsDigest: ex.termsDigest }, "b", approveStep(ex));

const request = (over: Record<string, unknown> = {}, who: "a" | "b" = "a") =>
  post("/v1/endpoint-command-exceptions", { deviceId, ruleId: "rm-rf", verdict: "ask", hours: 4, reason: "clean a build tree", approverUserId: who === "a" ? ids.b : ids.a, ...over }, who);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  await user("a", true);
  await user("b", true);
  await user("member", false);
  const [src] = await db
    .insert(discoverySources)
    .values({ name: `e31-${RUN}`, kind: "endpoint_agent", target: {}, scope: { orgLevel: true, include: [] }, createdBy: ids.a })
    .returning({ id: discoverySources.id });
  sourceId = src!.id;
  const [tok] = await db
    .insert(endpointEnrolmentTokens)
    .values({ sourceId, label: "e31", tokenHash: hex("tok", 64), deviceCap: 5, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: endpointEnrolmentTokens.id });
  const [dev] = await db
    .insert(endpointDevices)
    .values({ sourceId, tokenId: tok!.id, devicePseudonym: `psn:${hex("d", 24)}`, os: "linux", arch: "amd64", agentVersion: "1.0.0", ticketHash: hex("t", 64), ticketExpiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: endpointDevices.id });
  deviceId = dev!.id;
});

afterAll(async () => {
  if (!db) return;
  await db.delete(endpointCommandExceptions).where(eq(endpointCommandExceptions.deviceId, deviceId));
  if (groupIds.length) await db.delete(endpointDeviceGroups).where(inArray(endpointDeviceGroups.id, groupIds));
  await db.delete(endpointDevices).where(eq(endpointDevices.sourceId, sourceId));
  await db.delete(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.sourceId, sourceId));
  await db.delete(discoverySources).where(eq(discoverySources.id, sourceId));
  await app?.close();
});

describe("ADR-0350 exceptions", () => {
  it("request → approve by the named approver, by digest; expiry on the database clock; then revoke", async () => {
    const r = await request();
    expect(r.statusCode).toBe(201);
    const ex = r.json();
    expect(ex.state).toBe("requested");
    expect(ex.notAfter).toBeNull();

    // the requester cannot approve, and the approver must name the exact terms
    expect((await post(`/v1/endpoint-command-exceptions/${ex.id}/approve`, { termsDigest: ex.termsDigest }, "a")).statusCode).toBe(403);
    expect((await post(`/v1/endpoint-command-exceptions/${ex.id}/approve`, { termsDigest: hex("other", 64) }, "b")).json().error).toBe("terms_changed");

    // without a step-up the approval is refused (and nothing changes)
    expect((await post(`/v1/endpoint-command-exceptions/${ex.id}/approve`, { termsDigest: ex.termsDigest }, "b")).statusCode).toBe(403);
    // a grant for other terms does not count
    expect((await stepped("POST", `/v1/endpoint-command-exceptions/${ex.id}/approve`, { termsDigest: ex.termsDigest }, "b", approveStep({ id: ex.id, termsDigest: hex("x", 64) }))).statusCode).toBeGreaterThanOrEqual(400);
    const ok = await approve(ex);
    expect(ok.statusCode).toBe(200);
    const approved = ok.json();
    expect(approved.state).toBe("approved");
    const span = new Date(approved.notAfter).getTime() - new Date(approved.decidedAt).getTime();
    expect(span).toBe(4 * 3_600_000);

    // decided once only
    expect((await approve(ex)).statusCode).toBe(409);
    expect((await post(`/v1/endpoint-command-exceptions/${ex.id}/cancel`, {}, "a")).statusCode).toBe(409);

    const rv = await post(`/v1/endpoint-command-exceptions/${ex.id}/revoke`, { reason: "done early" }, "a");
    expect(rv.statusCode).toBe(200);
    expect(rv.json().state).toBe("revoked");
    expect((await post(`/v1/endpoint-command-exceptions/${ex.id}/revoke`, { reason: "again" }, "a")).statusCode).toBe(409);

    const trail = await db.select({ ruleId: auditLog.ruleId }).from(auditLog).where(eq(auditLog.objectId, ex.id));
    expect(trail.map((t) => t.ruleId).sort()).toEqual(["endpoint-command-exception.approve", "endpoint-command-exception.request", "endpoint-command-exception.revoke"]);
  });

  it("expired is derived from not_after and closes the lifecycle", async () => {
    const ex = (await request({ hours: 1 })).json();
    expect((await approve(ex)).statusCode).toBe(200);
    // move the decision into the past, keeping not_after = decided_at + hours
    await db.execute(sql`UPDATE endpoint_command_exceptions SET decided_at = now() - interval '2 hours', not_after = now() - interval '1 hour' WHERE id = ${ex.id}`);
    const list = (await app.inject({ method: "GET", url: `/v1/endpoint-command-exceptions?deviceId=${deviceId}`, headers: keys.a })).json();
    expect(list.items.find((i: { id: string }) => i.id === ex.id).state).toBe("expired");
    expect(list.transitions.approve).toEqual({ from: "requested", to: "approved" });
    expect((await post(`/v1/endpoint-command-exceptions/${ex.id}/revoke`, { reason: "late" }, "a")).statusCode).toBe(409);
  });

  it("longer than 24 hours also needs a settings_relax step-up", async () => {
    const ex = (await request({ hours: 48 })).json();
    expect((await approve(ex)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await endpointExceptionState(ex.id))).toBe("requested");
    // with both grants on one session it is approved
    const g1 = await grantStepUpForTest(db, ids.b, approveStep(ex));
    const g2 = await grantStepUpForTest(db, ids.b, { kind: "settings_relax", facts: { values: { endpointCommandExceptionHours: { exception: ex.id, hours: 48 } } } });
    const [first] = await db.select({ sessionId: stepUpGrants.sessionId }).from(stepUpGrants).where(eq(stepUpGrants.id, g1.grantId));
    await db.update(stepUpGrants).set({ sessionId: first!.sessionId }).where(eq(stepUpGrants.id, g2.grantId));
    const both = await app.inject({
      method: "POST",
      url: `/v1/endpoint-command-exceptions/${ex.id}/approve`,
      headers: { "x-regulait-csrf": "1", "x-regulait-step-up": `${g1.stepUpToken},${g2.stepUpToken}` },
      cookies: { regulait_session: g1.sessionToken },
      payload: { termsDigest: ex.termsDigest },
    });
    expect(both.statusCode).toBe(200);
    expect(new Date(both.json().notAfter).getTime() - new Date(both.json().decidedAt).getTime()).toBe(48 * 3_600_000);
  });

  it("reject and cancel follow the table; the requester cannot reject their own request", async () => {
    const one = (await request()).json();
    expect((await post(`/v1/endpoint-command-exceptions/${one.id}/reject`, { reason: "no" }, "a")).statusCode).toBe(403);
    expect((await post(`/v1/endpoint-command-exceptions/${one.id}/reject`, { reason: "no" }, "b")).json().state).toBe("rejected");
    const two = (await request()).json();
    expect((await post(`/v1/endpoint-command-exceptions/${two.id}/cancel`, {}, "b")).statusCode).toBe(403);
    expect((await post(`/v1/endpoint-command-exceptions/${two.id}/cancel`, {}, "a")).json().state).toBe("cancelled");
  });

  it("refuses self-approval at request time and in the database", async () => {
    expect((await request({ approverUserId: ids.a })).json().error).toBe("caller_cannot_approve");
    expect((await request({ approverUserId: ids.member })).json().error).toBe("approver_not_admin");
    await expect(
      db.insert(endpointCommandExceptions).values({ deviceId, ruleId: "rm-rf", verdict: "ask", hours: 1, reason: "x", termsDigest: hex("x", 64), requestedBy: ids.a, approverUserId: ids.a }),
    ).rejects.toThrow();
    // an approval with an expiry beyond `hours` is refused by the database
    const ex = (await request({ hours: 2 })).json();
    await expect(
      db.execute(sql`UPDATE endpoint_command_exceptions SET status = 'approved', decided_by = ${ids.b}, decided_at = now(), not_after = now() + interval '3 hours' WHERE id = ${ex.id}`),
    ).rejects.toThrow();
  });

  it("a credential typed into the reason is stored scrubbed, and the request is still approvable", async () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const ex = (await request({ reason: `cleanup, the token is ${key}` })).json();
    expect(ex.reason).not.toContain(key);
    expect(JSON.stringify(await db.select().from(endpointCommandExceptions).where(eq(endpointCommandExceptions.id, ex.id)))).not.toContain(key);
    expect((await approve(ex)).statusCode).toBe(200);
  });

  it("refuses terms the device would refuse", async () => {
    for (const bad of [{ hours: 169 }, { hours: 0 }, { verdict: "deny" }, { ruleId: "Bad Id" }, { reason: "" }]) {
      expect((await request(bad)).statusCode).toBe(400);
    }
  });
});

describe("ADR-0350 device groups", () => {
  it("groups narrow only, removing a rule or member is audited, and members are admin-only", async () => {
    const g = await post("/v1/endpoint-device-groups", { name: `e31-group-${RUN}` });
    expect(g.statusCode).toBe(201);
    groupIds.push(g.json().id);
    const gid = g.json().id;
    expect((await post(`/v1/endpoint-device-groups/${gid}/members`, { deviceId })).statusCode).toBe(201);
    expect((await post(`/v1/endpoint-device-groups/${gid}/rules`, { kind: "exec", ruleId: "no-curl", verdict: "deny", rule: { argv: ["curl", "**"] } })).statusCode).toBe(201);
    // an allow rule would widen a person's policy
    expect((await post(`/v1/endpoint-device-groups/${gid}/rules`, { kind: "exec", ruleId: "yes-curl", verdict: "allow", rule: { argv: ["curl", "**"] } })).statusCode).toBe(400);
    // a pattern the device's glob library could reject
    expect((await post(`/v1/endpoint-device-groups/${gid}/rules`, { kind: "exec", ruleId: "bad", verdict: "deny", rule: { argv: ["git", "[x"] } })).statusCode).toBe(400);
    expect((await post(`/v1/endpoint-device-groups/${gid}/rules`, { kind: "file", ruleId: "rel", verdict: "deny", rule: { access: "read", path: "src/**" } })).statusCode).toBe(400);

    const list = (await app.inject({ method: "GET", url: "/v1/endpoint-device-groups", headers: keys.a })).json();
    const mine = list.items.find((i: { id: string }) => i.id === gid);
    expect(mine.deviceIds).toEqual([deviceId]);
    expect(mine.rules.map((r: { ruleId: string }) => r.ruleId)).toEqual(["no-curl"]);

    // removing narrows nothing back without a step-up
    expect((await app.inject({ method: "DELETE", url: `/v1/endpoint-device-groups/${gid}/rules/no-curl`, headers: keys.a })).statusCode).toBe(403);
    const ruleArgs: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { endpointDeviceGroupRuleRemove: { groupId: gid, ruleId: "no-curl" } } } };
    expect((await stepped("DELETE", `/v1/endpoint-device-groups/${gid}/rules/no-curl`, undefined, "a", ruleArgs)).statusCode).toBe(200);
    const memberArgs: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { endpointDeviceGroupMemberRemove: { groupId: gid, deviceId } } } };
    expect((await stepped("DELETE", `/v1/endpoint-device-groups/${gid}/members/${deviceId}`, undefined, "a", memberArgs)).statusCode).toBe(200);
    const trail = await db.select({ ruleId: auditLog.ruleId }).from(auditLog).where(eq(auditLog.objectId, gid));
    expect(trail.map((t) => t.ruleId)).toEqual(expect.arrayContaining(["endpoint-device-group.rule-remove", "endpoint-device-group.member-remove"]));

    // deleting the group is a relaxation too, and takes its memberships and rules with it
    expect((await app.inject({ method: "DELETE", url: `/v1/endpoint-device-groups/${gid}`, headers: keys.a })).statusCode).toBe(403);
    const delArgs: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { endpointDeviceGroupDelete: { groupId: gid } } } };
    expect((await stepped("DELETE", `/v1/endpoint-device-groups/${gid}`, undefined, "a", delArgs)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/endpoint-device-groups", headers: keys.a })).json().items.some((i: { id: string }) => i.id === gid)).toBe(false);
    expect((await app.inject({ method: "GET", url: "/v1/endpoint-device-groups", headers: keys.member })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/endpoint-command-exceptions", headers: keys.member })).statusCode).toBe(403);
  });
});

async function endpointExceptionState(id: string): Promise<string> {
  const [row] = await db.select({ status: endpointCommandExceptions.status }).from(endpointCommandExceptions).where(eq(endpointCommandExceptions.id, id));
  return row!.status;
}
