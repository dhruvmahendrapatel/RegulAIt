/**
 * Issue #668 (ADR-0229 follow-up) — a CASCADE DELETE or a MEMBERSHIP CHANGE that moves who signs for some calls to a
 * wider approver pool needs the `settings_relax` step-up, bound to the takeover facts, and is audited.
 *
 * The fixture: a fleet rule F (every write tool, every server) whose pool is A alone, and a rule M scoped to a role or
 * a team (more specific than F, so M names the signer for its members' calls) whose pool is E alone. Deleting the role
 * or team (the FK cascades M away), or a member leaving it, hands those calls to F: `{ruleId: M,
 * outrankedByApprovalRules: [F]}`. A member joining puts their calls under M: `{ruleId: M, outranksApprovalRules: [F]}`.
 * Users and MCP servers have no hard-delete route today; their cascade is pinned at the helper.
 *
 * Runs on its OWN scratch database (prefix `p668_`), dropped in afterAll (M-068).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { approvalRules, approvals, auditLog, authSessions, createDb, eq, mcpServers, ORG_SETTINGS_ID, roleAssignments, roles, runMigrations, sodOverrideRequests, sodRules, sql, teamMembers, teams, type Db } from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { approverPoolShiftFacts, grantJitDefaultRole, sameApproverPoolShift } from "./approval-pool.js";
import { buildApp } from "./app.js";
import { reconcileGroupRoles } from "./group-roles.js";
import { applySodOverrideDecision, SodRoleMintNeedsStepUpError } from "./sod.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `p668_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `p668-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let adminDb: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
const U = {} as Record<"caller" | "a" | "e" | "member", string>;
let admin: { id: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const asAdmin = (method: Method, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const viaKey = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: admin.key, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: admin.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** refused from an API key (which can never step up) and from a session without a grant, bound to `body`; admitted with a grant for exactly it */
async function provesStepUp(method: Method, url: string, payload: unknown, body: Record<string, unknown>, okStatus = 200) {
  const key = await viaKey(method, url, payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", methods: [] });
  const refused = await asAdmin(method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  expect(refused.json().action).toEqual({ kind: "settings_relax", body });
  const token = await grantFor(refused.json().action);
  const ok = await asAdmin(method, url, payload, { [STEP_UP_HEADER]: token });
  expect(ok.statusCode, ok.body).toBe(okStatus);
  return ok;
}

/** a fleet rule over every write tool on every server whose pool is A alone (written directly: the guard is under test) */
async function fleetRule(): Promise<string> {
  const [r] = await db
    .insert(approvalRules)
    .values({ scope: "fleet", serverScope: "all", userId: null, serverId: null, toolName: null, writeOnly: true, approverUserId: U.a, approverRoleId: null, quorum: 1 })
    .returning({ id: approvalRules.id });
  return r!.id;
}

/** a rule scoped to a role or team, every write tool on every server, whose pool is `approver` alone */
async function groupRule(scope: "role" | "team", groupId: string, approver: string = U.e): Promise<string> {
  const [r] = await db
    .insert(approvalRules)
    .values({
      scope,
      serverScope: "all",
      ...(scope === "role" ? { roleId: groupId } : { teamId: groupId }),
      toolName: null,
      writeOnly: true,
      approverUserId: approver,
      approverRoleId: null,
      quorum: 1,
    })
    .returning({ id: approvalRules.id });
  return r!.id;
}

const mkRole = async (label: string) =>
  (await db.insert(roles).values({ name: `p668 ${label} ${RUN}-${randomBytes(2).toString("hex")}` }).returning({ id: roles.id }))[0]!.id;
const mkTeam = async (label: string) =>
  (await db.insert(teams).values({ name: `p668 ${label} ${RUN}-${randomBytes(2).toString("hex")}` }).returning({ id: teams.id }))[0]!.id;

/** run `body` with a fresh fleet rule F, removed afterwards so the next test's facts name only its own */
async function withFleet(body: (fleetId: string) => Promise<void>) {
  const fleetId = await fleetRule();
  try {
    await body(fleetId);
  } finally {
    await db.delete(approvalRules).where(eq(approvalRules.id, fleetId));
  }
}

const shiftAudit = async (objectId: string, ruleId: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.objectId, objectId))).filter((r) => r.ruleId === ruleId);

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  adminDb = createDb(DATABASE_URL);
  await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await adminDb.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const mkUser = async (label: string, isAdmin = false) => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `p668-${label}-${RUN}@example.com`, displayName: `p668 ${label}`, isAdmin } });
    expect(u.statusCode, u.body).toBe(201);
    return u.json().id as string;
  };
  const adminId = await mkUser("admin", true);
  for (const k of ["caller", "a", "e", "member"] as const) U[k] = await mkUser(k);
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "p668" } });
  expect(key.statusCode, key.body).toBe(201);
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: adminId,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  admin = { id: adminId, key: { authorization: `Bearer ${key.json().token}` }, token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "p668" });
  expect(reg.statusCode, reg.body).toBe(201);
  const [srv] = await db.insert(mcpServers).values({ name: `p668-srv-${RUN}`, url: `https://p668-${RUN}.example.com/mcp` }).returning({ id: mcpServers.id });
  serverId = srv!.id;
}, 120_000);

// every test starts from no approval rules: a rule another test left behind is a real overlapping rule and would
// (correctly) join the takeover facts
afterEach(async () => {
  await db.delete(approvalRules);
});

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(adminDb, SCRATCH_DB),
    async () => adminDb?.$client.end(),
  ]);
});

describe("issue #668: cascade deletes that move who signs need settings_relax", () => {
  it("DELETE of a role an approval rule is scoped to: refused, bound to the rule and the fleet rule that takes over; audited", async () => {
    await withFleet(async (fleetId) => {
      const roleId = await mkRole("del");
      const ruleId = await groupRule("role", roleId);
      await provesStepUp("DELETE", `/v1/roles/${roleId}`, undefined, {
        change: "delete",
        objectType: "role",
        objectId: roleId,
        values: { approverPoolTakeovers: [{ ruleId, outrankedByApprovalRules: [fleetId] }] },
      });
      expect(await db.select().from(roles).where(eq(roles.id, roleId))).toHaveLength(0);
      expect(await db.select().from(approvalRules).where(eq(approvalRules.id, ruleId))).toHaveLength(0);
      const [row] = await shiftAudit(roleId, "role-deleted");
      expect((row!.detail as Record<string, unknown>).approverPoolShift).toMatchObject({ change: "delete", objectId: roleId });
    });
  });

  it("DELETE of a team an approval rule is scoped to: refused, bound to the takeover facts; audited", async () => {
    await withFleet(async (fleetId) => {
      const teamId = await mkTeam("del");
      const ruleId = await groupRule("team", teamId);
      await provesStepUp("DELETE", `/v1/teams/${teamId}`, undefined, {
        change: "delete",
        objectType: "team",
        objectId: teamId,
        values: { approverPoolTakeovers: [{ ruleId, outrankedByApprovalRules: [fleetId] }] },
      });
      expect(await db.select().from(teams).where(eq(teams.id, teamId))).toHaveLength(0);
      const [row] = await shiftAudit(teamId, "team-deleted");
      expect((row!.detail as Record<string, unknown>).approverPoolShift).toMatchObject({ change: "delete", objectId: teamId });
    });
  });

  it("a USER cascade (subject or named approver) and an MCP SERVER cascade report the takeover at the helper", async () => {
    await withFleet(async (fleetId) => {
      // the caller's rule whose named approver is E: deleting E cascades it, deleting the caller cascades it too
      const [byUser] = await db
        .insert(approvalRules)
        .values({ scope: "user", userId: U.caller, serverScope: "all", toolName: null, writeOnly: true, approverUserId: U.e, quorum: 1 })
        .returning({ id: approvalRules.id });
      const [byServer] = await db
        .insert(approvalRules)
        .values({ scope: "fleet", serverScope: "server", serverId, toolName: null, writeOnly: true, approverUserId: U.e, quorum: 1 })
        .returning({ id: approvalRules.id });
      try {
        const asApprover = await approverPoolShiftFacts(db, { change: "delete", objectType: "user", objectId: U.e });
        expect(asApprover).toEqual({
          change: "delete",
          objectType: "user",
          objectId: U.e,
          values: {
            approverPoolTakeovers: [
              { ruleId: byUser!.id, outrankedByApprovalRules: [fleetId] },
              { ruleId: byServer!.id, outrankedByApprovalRules: [fleetId] },
            ].sort((x, y) => (x.ruleId < y.ruleId ? -1 : 1)),
          },
        });
        expect(await approverPoolShiftFacts(db, { change: "delete", objectType: "user", objectId: U.caller })).toMatchObject({
          values: { approverPoolTakeovers: [{ ruleId: byUser!.id, outrankedByApprovalRules: [fleetId] }] },
        });
        expect(await approverPoolShiftFacts(db, { change: "delete", objectType: "mcp_server", objectId: serverId })).toMatchObject({
          values: { approverPoolTakeovers: [{ ruleId: byServer!.id, outrankedByApprovalRules: [fleetId] }] },
        });
      } finally {
        await db.delete(approvalRules).where(eq(approvalRules.id, byUser!.id));
        await db.delete(approvalRules).where(eq(approvalRules.id, byServer!.id));
      }
    });
  });

  it("no takeover means no step-up: a role whose rule keeps the fleet pool is deleted from an API key", async () => {
    await withFleet(async () => {
      const roleId = await mkRole("same-pool");
      await groupRule("role", roleId, U.a); // the same pool as the fleet rule: nothing moves
      const r = await viaKey("DELETE", `/v1/roles/${roleId}`);
      expect(r.statusCode, r.body).toBe(200);
    });
    // and with no overlapping survivor at all
    const roleId = await mkRole("alone");
    await groupRule("role", roleId);
    const r = await viaKey("DELETE", `/v1/roles/${roleId}`);
    expect(r.statusCode, r.body).toBe(200);
  });
});

describe("issue #668: membership changes that move who signs need settings_relax", () => {
  it("role assign and unassign: each refused, bound to its own takeover facts; audited", async () => {
    await withFleet(async (fleetId) => {
      const roleId = await mkRole("member");
      const ruleId = await groupRule("role", roleId);
      await provesStepUp("POST", `/v1/users/${U.member}/roles`, { roleId }, {
        change: "member-add",
        objectType: "role",
        objectId: roleId,
        userId: U.member,
        values: { approverPoolTakeovers: [{ ruleId, outranksApprovalRules: [fleetId] }] },
      }, 201);
      await provesStepUp("DELETE", `/v1/users/${U.member}/roles/${roleId}`, undefined, {
        change: "member-remove",
        objectType: "role",
        objectId: roleId,
        userId: U.member,
        values: { approverPoolTakeovers: [{ ruleId, outrankedByApprovalRules: [fleetId] }] },
      });
      expect(await db.select().from(roleAssignments).where(eq(roleAssignments.roleId, roleId))).toHaveLength(0);
      const audits = await shiftAudit(roleId, "approver-pool-shift");
      expect(audits.map((a) => (a.detail as Record<string, unknown>).change).sort()).toEqual(["member-add", "member-remove"]);
    });
  });

  it("team member add and remove: each refused, bound to its own takeover facts; audited", async () => {
    await withFleet(async (fleetId) => {
      const teamId = await mkTeam("member");
      const ruleId = await groupRule("team", teamId);
      await provesStepUp("POST", `/v1/teams/${teamId}/members`, { userId: U.member }, {
        change: "member-add",
        objectType: "team",
        objectId: teamId,
        userId: U.member,
        values: { approverPoolTakeovers: [{ ruleId, outranksApprovalRules: [fleetId] }] },
      }, 201);
      await provesStepUp("DELETE", `/v1/teams/${teamId}/members/${U.member}`, undefined, {
        change: "member-remove",
        objectType: "team",
        objectId: teamId,
        userId: U.member,
        values: { approverPoolTakeovers: [{ ruleId, outrankedByApprovalRules: [fleetId] }] },
      });
      expect(await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId))).toHaveLength(0);
      const audits = await shiftAudit(teamId, "approver-pool-shift");
      expect(audits.map((a) => (a.detail as Record<string, unknown>).change).sort()).toEqual(["member-add", "member-remove"]);
    });
  });

  it("no takeover means no step-up: joining and leaving a role or team whose rule keeps the pool needs none", async () => {
    await withFleet(async () => {
      const roleId = await mkRole("keeps");
      await groupRule("role", roleId, U.a);
      const teamId = await mkTeam("keeps");
      await groupRule("team", teamId, U.a);
      expect((await viaKey("POST", `/v1/users/${U.member}/roles`, { roleId })).statusCode).toBe(201);
      expect((await viaKey("DELETE", `/v1/users/${U.member}/roles/${roleId}`)).statusCode).toBe(200);
      expect((await viaKey("POST", `/v1/teams/${teamId}/members`, { userId: U.member })).statusCode).toBe(201);
      expect((await viaKey("DELETE", `/v1/teams/${teamId}/members/${U.member}`)).statusCode).toBe(200);
    });
  });

  it("a group→role mapping (any member) create and delete: each refused, bound to the takeover facts and the group", async () => {
    await withFleet(async (fleetId) => {
      const roleId = await mkRole("mapped");
      const ruleId = await groupRule("role", roleId);
      const group = { source: "oidc", externalGroup: `p668-group-${RUN}` };
      const created = await provesStepUp("POST", "/v1/group-role-mappings", { ...group, roleId }, {
        change: "member-add",
        objectType: "role",
        objectId: roleId,
        userId: null,
        values: { approverPoolTakeovers: [{ ruleId, outranksApprovalRules: [fleetId] }] },
        group,
      }, 201);
      await provesStepUp("DELETE", `/v1/group-role-mappings/${created.json().id}`, undefined, {
        change: "member-remove",
        objectType: "role",
        objectId: roleId,
        userId: null,
        values: { approverPoolTakeovers: [{ ruleId, outrankedByApprovalRules: [fleetId] }] },
        group,
      });
    });
  });

  it("a user rule for the member is never outranked by a role rule: joining moves nothing for them", async () => {
    const roleId = await mkRole("user-rule");
    await groupRule("role", roleId);
    const [own] = await db
      .insert(approvalRules)
      .values({ scope: "user", userId: U.member, serverScope: "all", toolName: null, writeOnly: true, approverUserId: U.a, quorum: 1 })
      .returning({ id: approvalRules.id });
    try {
      expect(await approverPoolShiftFacts(db, { change: "member-add", objectType: "role", objectId: roleId, userId: U.member })).toBeNull();
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, own!.id));
    }
  });
});

describe("issue #668: fail closed", () => {
  it("a grant for the old facts does not admit the delete once another rule changes them", async () => {
    await withFleet(async (fleetId) => {
      const roleId = await mkRole("stale");
      const ruleId = await groupRule("role", roleId);
      const refused = await asAdmin("DELETE", `/v1/roles/${roleId}`, undefined);
      expect(refused.statusCode, refused.body).toBe(403);
      const token = await grantFor(refused.json().action);
      // a second wide rule now takes over too: the facts the grant attested no longer describe the delete
      const second = await fleetRule();
      try {
        const stale = await asAdmin("DELETE", `/v1/roles/${roleId}`, undefined, { [STEP_UP_HEADER]: token });
        expect(stale.statusCode, stale.body).toBe(403);
        expect(stale.json().action.body.values).toEqual({ approverPoolTakeovers: [{ ruleId, outrankedByApprovalRules: [fleetId, second].sort() }] });
        expect(await db.select().from(roles).where(eq(roles.id, roleId))).toHaveLength(1);
      } finally {
        await db.delete(approvalRules).where(eq(approvalRules.id, second));
      }
    });
  });

  it("the JIT default role is withheld (no request to step up) while it would move the pool, granted once it would not", async () => {
    const roleId = await mkRole("jit");
    await groupRule("role", roleId);
    await withFleet(async () => {
      expect(await grantJitDefaultRole(db, U.caller, roleId)).toBe("withheld");
    });
    expect(await grantJitDefaultRole(db, U.caller, roleId)).toBe("granted");
  });

  it("sameApproverPoolShift compares the facts exactly (the under-lock recheck)", () => {
    const f = { change: "delete", objectType: "role", objectId: "r", values: { approverPoolTakeovers: [{ ruleId: "m", outrankedByApprovalRules: ["f"] }] } };
    expect(sameApproverPoolShift(null, null)).toBe(true);
    expect(sameApproverPoolShift(f, structuredClone(f))).toBe(true);
    expect(sameApproverPoolShift(f, null)).toBe(false);
    expect(sameApproverPoolShift(f, { ...f, values: { approverPoolTakeovers: [] } })).toBe(false);
  });

  it("an SoD override cannot assign a role that moves the pool: the decision refuses and mints nothing", async () => {
    await withFleet(async (fleetId) => {
      const roleId = await mkRole("sod");
      const ruleId = await groupRule("role", roleId);
      const [rule] = await db
        .insert(sodRules)
        .values({ name: `p668 sod ${RUN}`, reason: "p668 fixture", aKind: "agent", aObjectId: randomUUID(), bKind: "agent", bObjectId: randomUUID() })
        .returning({ id: sodRules.id });
      const [approval] = await db
        .insert(approvals)
        .values({ userId: U.caller, objectType: "sod_override", approverUserId: admin.id, stageId: `p668-sod-${RUN}` })
        .returning({ id: approvals.id });
      await db.insert(sodOverrideRequests).values({
        ruleId: rule!.id,
        mintKind: "role_assignment",
        mintPayload: { userId: U.member, roleId },
        conflictDetail: {},
        label: "p668 role assignment",
        requestedByUserId: U.caller,
        approvalId: approval!.id,
      });
      const refused = await db
        .transaction((tx) => applySodOverrideDecision(tx as unknown as Db, approval!, "approved", admin.id))
        .then(() => null, (err: unknown) => err);
      expect(refused).toBeInstanceOf(SodRoleMintNeedsStepUpError);
      expect((refused as SodRoleMintNeedsStepUpError).facts).toMatchObject({
        values: { approverPoolTakeovers: [{ ruleId, outranksApprovalRules: [fleetId] }] },
      });
      expect(await db.select().from(roleAssignments).where(eq(roleAssignments.roleId, roleId))).toHaveLength(0);
      const [req] = await db.select().from(sodOverrideRequests).where(eq(sodOverrideRequests.approvalId, approval!.id));
      expect(req!.status).toBe("pending");
    });
  });

  it("an IdP removal is never withheld, and the reconciliation records the pool shift it caused", async () => {
    await withFleet(async (fleetId) => {
      const roleId = await mkRole("idp");
      const ruleId = await groupRule("role", roleId);
      await db.insert(roleAssignments).values({ userId: U.member, roleId, origin: "group" });
      const out = await reconcileGroupRoles(db, U.member, "oidc", [], { kind: "oidc-login", actor: "p668" });
      expect(out.removed).toEqual([
        expect.objectContaining({
          roleId,
          approverPoolShift: expect.objectContaining({ change: "member-remove", values: { approverPoolTakeovers: [{ ruleId, outrankedByApprovalRules: [fleetId] }] } }),
        }),
      ]);
      expect(await db.select().from(roleAssignments).where(eq(roleAssignments.roleId, roleId))).toHaveLength(0);
    });
  });
});
