/**
 * ADR-0022 identity-lifecycle e2e:
 *  - deactivation: a disabled user's keys 401 with the distinct user_disabled
 *    reason, key issuance is refused, reactivation restores the SAME key;
 *  - lockout guards: no self-deactivation, and the last ACTIVE admin can be
 *    neither deactivated nor demoted (tested hermetically by parking every
 *    other active admin and restoring them afterwards);
 *  - rename (display only) + promote/demote, audited;
 *  - role assignments: holders listable, unassignable; deleting a HELD role
 *    is refused naming the holders, force requires a recorded reason, and
 *    the forced deletion is audited;
 *  - teams: member removal; deleting a team that owns shared context is
 *    refused with what blocks, force-with-reason goes through (audited);
 *  - audit CSV export: admin-only, csv-shaped, carries the filtered trail.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  isNull,
  projectContextItems,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { isCsvNoticeRow } from "./csv-export.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "test-bootstrap-token-il";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let admin1Id: string;
let admin1Auth: { authorization: string };
let memId: string;
let memAuth: { authorization: string };

const mkUser = async (email: string, name: string, isAdmin = false): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: name, isAdmin },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id;
};
const authFor = async (userId: string): Promise<{ authorization: string }> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`,
    payload: { name: "il-key" },
  });
  expect(r.statusCode).toBe(201);
  return { authorization: `Bearer ${r.json().token}` };
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  admin1Id = await mkUser("il-admin1@example.com", "IL Admin One", true);
  admin1Auth = await authFor(admin1Id);
  memId = await mkUser("il-mem@example.com", "IL Member");
  memAuth = await authFor(memId);
});

afterAll(async () => {
  await app.close();
});

describe("user deactivation (deactivate ≠ delete)", () => {
  it("a disabled user's key 401s with user_disabled; issuance refused; reactivation restores the same key", async () => {
    const uid = await mkUser("il-dis@example.com", "IL Disable Me");
    const auth = await authFor(uid);
    // key works while active
    let me = await app.inject({ method: "GET", headers: auth, url: "/v1/me" });
    expect(me.statusCode).toBe(200);
    // deactivate (with a recorded reason)
    const d = await app.inject({
      method: "POST", headers: admin1Auth, url: `/v1/users/${uid}/deactivate`,
      payload: { reason: "offboarded" },
    });
    expect(d.statusCode).toBe(200);
    expect(d.json().disabledAt).toBeTruthy();
    // the SAME key now 401s with the distinct reason (not "unauthenticated")
    me = await app.inject({ method: "GET", headers: auth, url: "/v1/me" });
    expect(me.statusCode).toBe(401);
    expect(me.json().error).toBe("user_disabled");
    // issuing a fresh key for a disabled user is refused loudly
    const issue = await app.inject({
      method: "POST", headers: admin1Auth, url: `/v1/users/${uid}/keys`,
      payload: { name: "dead-key" },
    });
    expect(issue.statusCode).toBe(409);
    expect(issue.json().error).toBe("user_disabled");
    // the row survives (greyed in lists, not gone) and the act was audited
    const list = await app.inject({ method: "GET", headers: admin1Auth, url: "/v1/users" });
    const row = list.json().users.find((u: { id: string }) => u.id === uid);
    expect(row).toBeTruthy();
    expect(row.disabledAt).toBeTruthy();
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, uid), eq(auditLog.ruleId, "user-deactivated")));
    expect(audit.length).toBe(1);
    expect(audit[0]!.reason).toContain("offboarded");
    // reactivate: the ORIGINAL key authenticates again — nothing was revoked
    const rr = await app.inject({ method: "POST", headers: admin1Auth, url: `/v1/users/${uid}/reactivate`, payload: {} });
    expect(rr.statusCode).toBe(200);
    me = await app.inject({ method: "GET", headers: auth, url: "/v1/me" });
    expect(me.statusCode).toBe(200);
  });

  it("an admin cannot deactivate themselves", async () => {
    const r = await app.inject({
      method: "POST", headers: admin1Auth, url: `/v1/users/${admin1Id}/deactivate`, payload: {},
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("cannot_deactivate_self");
  });

  it("the LAST active admin can be neither deactivated nor demoted (hermetic)", async () => {
    // park every OTHER active admin so admin1 is provably the last one, then
    // restore them — files run sequentially, so nothing outside this test
    // ever sees the parked state.
    const others = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isAdmin, true), isNull(users.disabledAt)));
    const toPark = others.map((u) => u.id).filter((id) => id !== admin1Id);
    try {
      for (const id of toPark) {
        await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, id));
      }
      const de = await app.inject({
        method: "POST", headers: AUTH, url: `/v1/users/${admin1Id}/deactivate`, payload: {},
      });
      expect(de.statusCode).toBe(409);
      expect(de.json().error).toBe("last_active_admin");
      const dem = await app.inject({
        method: "POST", headers: AUTH, url: `/v1/users/${admin1Id}/admin`,
        payload: { isAdmin: false },
      });
      expect(dem.statusCode).toBe(409);
      expect(dem.json().error).toBe("last_active_admin");
    } finally {
      for (const id of toPark) {
        await db.update(users).set({ disabledAt: null }).where(eq(users.id, id));
      }
    }
  });
});

describe("promote / demote / rename", () => {
  it("promotes a member to admin, demotes back (audited), and renames display only", async () => {
    const uid = await mkUser("il-flag@example.com", "IL Flag");
    const up = await app.inject({
      method: "POST", headers: admin1Auth, url: `/v1/users/${uid}/admin`,
      payload: { isAdmin: true, reason: "coverage" },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().isAdmin).toBe(true);
    const down = await app.inject({
      method: "POST", headers: admin1Auth, url: `/v1/users/${uid}/admin`, payload: { isAdmin: false },
    });
    expect(down.statusCode).toBe(200);
    expect(down.json().isAdmin).toBe(false);
    const ren = await app.inject({
      method: "PATCH", headers: admin1Auth, url: `/v1/users/${uid}`,
      payload: { displayName: "IL Flag Renamed" },
    });
    expect(ren.statusCode).toBe(200);
    expect(ren.json().displayName).toBe("IL Flag Renamed");
    // email is NOT renameable here (display fields only) — strict schema 400s
    const bad = await app.inject({
      method: "PATCH", headers: admin1Auth, url: `/v1/users/${uid}`,
      payload: { email: "sneaky@example.com" },
    });
    expect(bad.statusCode).toBe(400);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, uid), eq(auditLog.ruleId, "user-promoted-admin")));
    expect(audit.length).toBe(1);
  });
});

describe("role assignments become manageable", () => {
  it("lists holders, refuses deleting a held role, force needs a reason, unassign then delete works", async () => {
    const roleR = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "il-role" } });
    const roleId = roleR.json().id as string;
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${memId}/roles`, payload: { roleId } });

    const asg = await app.inject({ method: "GET", headers: admin1Auth, url: `/v1/roles/${roleId}/assignments` });
    expect(asg.statusCode).toBe(200);
    expect(asg.json().assignments.map((a: { email: string }) => a.email)).toContain("il-mem@example.com");

    // held → refused, naming the holders
    const refuse = await app.inject({ method: "DELETE", headers: admin1Auth, url: `/v1/roles/${roleId}` });
    expect(refuse.statusCode).toBe(409);
    expect(refuse.json().error).toBe("role_held");
    expect(refuse.json().holders).toContain("il-mem@example.com");

    // force without a reason → refused
    const noReason = await app.inject({
      method: "DELETE", headers: admin1Auth, url: `/v1/roles/${roleId}`, payload: { force: true },
    });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().error).toBe("force_reason_required");

    // unassign, then the plain delete goes through
    const un = await app.inject({ method: "DELETE", headers: admin1Auth, url: `/v1/users/${memId}/roles/${roleId}` });
    expect(un.statusCode).toBe(200);
    const ok = await app.inject({ method: "DELETE", headers: admin1Auth, url: `/v1/roles/${roleId}` });
    expect(ok.statusCode).toBe(200);
  });

  it("force-deletes a held role WITH a reason, audited with the holders", async () => {
    const roleR = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "il-role-force" } });
    const roleId = roleR.json().id as string;
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${memId}/roles`, payload: { roleId } });
    const r = await app.inject({
      method: "DELETE", headers: admin1Auth, url: `/v1/roles/${roleId}`,
      payload: { force: true, reason: "reorg — bundle superseded" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().unassigned).toBe(1);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, roleId), eq(auditLog.ruleId, "role-deleted")));
    expect(audit.length).toBe(1);
    expect(audit[0]!.reason).toContain("reorg");
    expect((audit[0]!.detail as { holders: string[] }).holders).toContain("il-mem@example.com");
  });
});

describe("teams: member removal + guarded deletion", () => {
  it("removes a member; deletes an unblocked team", async () => {
    const t = await app.inject({ method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "il-team-a" } });
    const teamId = t.json().id as string;
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/teams/${teamId}/members`, payload: { userId: memId } });
    const rm = await app.inject({ method: "DELETE", headers: admin1Auth, url: `/v1/teams/${teamId}/members/${memId}` });
    expect(rm.statusCode).toBe(200);
    const rm2 = await app.inject({ method: "DELETE", headers: admin1Auth, url: `/v1/teams/${teamId}/members/${memId}` });
    expect(rm2.statusCode).toBe(404); // already gone
    const del = await app.inject({ method: "DELETE", headers: admin1Auth, url: `/v1/teams/${teamId}` });
    expect(del.statusCode).toBe(200);
  });

  it("refuses deleting a team that owns shared context, surfacing what blocks; force+reason goes through", async () => {
    const t = await app.inject({ method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "il-team-ctx" } });
    const teamId = t.json().id as string;
    const p = await app.inject({ method: "POST", headers: admin1Auth, url: "/v1/projects", payload: { name: "il-proj-ctx" } });
    const projectId = p.json().id as string;
    // the blocker: a shared-context revision naming this team as contributor
    await db.insert(projectContextItems).values({
      projectId,
      key: "il-standards",
      revision: 1,
      content: "team-contributed context",
      contributedByUserId: memId,
      contributedByTeamId: teamId,
    });
    const refuse = await app.inject({ method: "DELETE", headers: admin1Auth, url: `/v1/teams/${teamId}` });
    expect(refuse.statusCode).toBe(409);
    expect(refuse.json().error).toBe("team_owns_shared_context");
    expect(refuse.json().contextItems).toBe(1);
    expect(refuse.json().projects).toContain("il-proj-ctx");
    const noReason = await app.inject({
      method: "DELETE", headers: admin1Auth, url: `/v1/teams/${teamId}`, payload: { force: true },
    });
    expect(noReason.statusCode).toBe(422);
    const forced = await app.inject({
      method: "DELETE", headers: admin1Auth, url: `/v1/teams/${teamId}`,
      payload: { force: true, reason: "team dissolved; provenance retained" },
    });
    expect(forced.statusCode).toBe(200);
    // provenance survives the deletion (FK-free by design)
    const items = await db
      .select()
      .from(projectContextItems)
      .where(eq(projectContextItems.projectId, projectId));
    expect(items.length).toBe(1);
    expect(items[0]!.contributedByTeamId).toBe(teamId);
  });
});

describe("audit CSV export", () => {
  it("is admin-only, csv-shaped, and carries the user filter", async () => {
    const deny = await app.inject({ method: "GET", headers: memAuth, url: "/v1/audit.csv" });
    expect(deny.statusCode).toBe(403);
    const all = await app.inject({ method: "GET", headers: admin1Auth, url: "/v1/audit.csv" });
    expect(all.statusCode).toBe(200);
    expect(all.headers["content-type"]).toContain("text/csv");
    expect(all.headers["content-disposition"]).toContain("audit-log.csv");
    const lines = all.body.trim().split("\n");
    // deployMode joined the export when A4's dimension gained a query surface
    // (ADR-0027 §2a) — the column is always present, and a row with no mode
    // says the word `unknown` rather than leaving a cell an auditor could read
    // as "hosted".
    expect(lines[0]).toBe(
      "at,userId,userName,objectType,objectId,serverId,toolName,effect,ruleId,deployMode,reason,detail",
    );
    expect(lines.length).toBeGreaterThan(1);
    // filtered: only the named user's rows
    const filtered = await app.inject({
      method: "GET", headers: admin1Auth, url: `/v1/audit.csv?userId=${admin1Id}`,
    });
    expect(filtered.statusCode).toBe(200);
    // ADR-0031: the export streams under a defaulted window + row ceiling and
    // appends a single-field disclosure row when either clipped the file. It is
    // not a data row, so it is excluded here rather than asserted against.
    const frows = filtered.body
      .trim()
      .split("\n")
      .slice(1)
      .filter((l) => !isCsvNoticeRow(l));
    expect(frows.length).toBeGreaterThan(0);
    for (const row of frows) expect(row).toContain(admin1Id);
  });
});
