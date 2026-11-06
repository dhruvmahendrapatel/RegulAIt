/**
 * ADR-0234 (PENDING S7) — row-level security, slice 1: users, auth_mfa_pending, approvals, audit_log.
 *
 * Every query below that is meant to be blocked deliberately SKIPS the application's object-level check:
 * no WHERE on the owner, no scope condition. The only thing standing between the principal and another
 * user's row is the policy. Each block has its positive control (the same unfiltered query as the
 * superuser login does return the row), so a pass cannot come from an empty table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  RLS_SYSTEM_REASONS,
  RlsContextError,
  approvals,
  auditLog,
  authMfaPending,
  createDb,
  eq,
  rlsSystemContextCounts,
  runMigrations,
  setRlsSystemContextSink,
  sql,
  users,
  withPrincipal,
  withSystemContext,
  type Db,
  type RlsSystemContextEntry,
} from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `rls0234_${process.pid}_${Date.now()}`;
const RLS_TABLES = ["users", "auth_mfa_pending", "approvals", "audit_log"] as const;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

let admin: Db; // the cluster login, used only to create and drop the scratch database
let su: Db; // the scratch database as the (superuser) login: fixtures and positive controls
let one: Db; // a ONE-connection pool, so "the next borrower" is provably the same physical connection

const ids = {
  alice: randomUUID(),
  bob: randomUUID(),
  carol: randomUUID(), // member of the role an approval is routed to
  dave: randomUUID(), // active delegate of bob
  erin: randomUUID(), // expired delegate of bob
  root: randomUUID(), // an admin
  role: randomUUID(),
  aliceApproval: randomUUID(),
  bobApproval: randomUUID(),
  routedApproval: randomUUID(),
  reviewApproval: randomUUID(), // a review-role row bob is not a participant in
};
const bobMfaToken = `rls0234-${randomUUID()}`;

/** the Postgres error text under drizzle's "Failed query" wrapper */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  return "(no error)";
}

async function count(db: Db | { execute: Db["execute"] }, table: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`));
  return r.rows[0]!.n;
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  su = createDb(urlFor(SCRATCH_DB));
  await runMigrations(su, migrationsFolder);
  one = createDb(urlFor(SCRATCH_DB), { max: 1 });

  await su.insert(users).values([
    { id: ids.alice, email: `alice-${ids.alice}@rls.test`, displayName: "Alice" },
    { id: ids.bob, email: `bob-${ids.bob}@rls.test`, displayName: "Bob" },
    { id: ids.carol, email: `carol-${ids.carol}@rls.test`, displayName: "Carol" },
    { id: ids.dave, email: `dave-${ids.dave}@rls.test`, displayName: "Dave" },
    { id: ids.erin, email: `erin-${ids.erin}@rls.test`, displayName: "Erin" },
    { id: ids.root, email: `root-${ids.root}@rls.test`, displayName: "Root", isAdmin: true },
  ]);
  await su.execute(sql`insert into roles (id, name) values (${ids.role}, ${`rls0234-role-${ids.role}`})`);
  await su.execute(sql`insert into role_assignments (user_id, role_id) values (${ids.carol}, ${ids.role})`);
  await su.insert(approvals).values([
    { id: ids.aliceApproval, userId: ids.alice, approverUserId: ids.root },
    { id: ids.bobApproval, userId: ids.bob, approverUserId: ids.bob },
    { id: ids.routedApproval, userId: ids.bob, approverUserId: ids.bob },
  ]);
  await su.execute(
    sql`insert into approval_assignments (approval_id, assignee_kind, assignee_id) values (${ids.routedApproval}, 'role', ${ids.role})`,
  );
  await su.execute(sql`insert into approval_delegations (from_user_id, to_user_id, starts_at, ends_at) values
    (${ids.bob}, ${ids.dave}, now() - interval '1 hour', now() + interval '1 hour'),
    (${ids.bob}, ${ids.erin}, now() - interval '2 hours', now() - interval '1 hour')`);
  await su.insert(authMfaPending).values({ userId: ids.bob, tokenHash: bobMfaToken, expiresAt: new Date(Date.now() + 60_000) });
  // audit rows: bob's first, then alice's LAST, so the global chain tip is a row bob cannot see
  for (const userId of [ids.bob, ids.bob, ids.alice]) {
    await su.insert(auditLog).values({ userId, effect: "allow", ruleId: "rls0234", ruleChain: [], reason: "rls0234 fixture" });
  }
}, 180_000);

afterAll(async () => {
  setRlsSystemContextSink(null);
  await one?.$client.end().catch(() => undefined);
  await su?.$client.end().catch(() => undefined);
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await admin.$client.end().catch(() => undefined);
  }
});

describe("0265: the roles and the inventory", () => {
  it("every slice-1 table has row-level security ENABLED and FORCED", async () => {
    const r = await su.execute<{ relname: string; on: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relname in ('users', 'auth_mfa_pending', 'approvals', 'audit_log')
       order by relname`);
    expect(r.rows.map((x) => x.relname).sort()).toEqual([...RLS_TABLES].sort());
    for (const row of r.rows) expect([row.relname, row.on, row.forced]).toEqual([row.relname, true, true]);
  });

  it("the app role owns nothing, cannot bypass RLS, and cannot rewrite the evidence tables", async () => {
    const owned = await su.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner
       where c.relnamespace = 'public'::regnamespace and r.rolname = 'regulait_app'`);
    expect(owned.rows[0]!.n).toBe(0);
    const role = await su.execute<{ bypass: boolean; superuser: boolean; login: boolean }>(
      sql`select rolbypassrls as bypass, rolsuper as superuser, rolcanlogin as login from pg_roles where rolname = 'regulait_app'`,
    );
    expect(role.rows[0]).toEqual({ bypass: false, superuser: false, login: false });
    const priv = await su.execute<{ ins: boolean; upd: boolean; del: boolean; trunc: boolean }>(sql`
      select has_table_privilege('regulait_app', 'audit_log', 'INSERT') as ins,
             has_table_privilege('regulait_app', 'audit_log', 'UPDATE') as upd,
             has_table_privilege('regulait_app', 'audit_log', 'DELETE') as del,
             has_table_privilege('regulait_app', 'audit_log', 'TRUNCATE') as trunc`);
    expect(priv.rows[0]).toEqual({ ins: true, upd: false, del: false, trunc: false });
  });

  it("the closed system-reason registry is the same in TypeScript and in the database", async () => {
    const r = await su.execute<{ def: string }>(sql`select pg_get_functiondef('regulait_rls_system_reason'::regproc) as def`);
    const arr = /ARRAY\[([^\]]+)\]/.exec(r.rows[0]!.def)![1]!;
    const inDb = [...arr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(inDb).toEqual([...RLS_SYSTEM_REASONS]);
  });
});

describe("cross-user rows are blocked with the application check skipped", () => {
  it("positive control: the superuser login sees every fixture row through the same unfiltered queries", async () => {
    const all = await su.select({ id: approvals.id }).from(approvals);
    expect(all.map((a) => a.id)).toEqual(expect.arrayContaining([ids.aliceApproval, ids.bobApproval, ids.routedApproval]));
    expect(await count(su, "auth_mfa_pending")).toBeGreaterThanOrEqual(1);
    expect(await count(su, "audit_log")).toBeGreaterThanOrEqual(3);
  });

  it("approvals: alice's unfiltered list holds her row only; bob's row is invisible and cannot be updated", async () => {
    await withPrincipal(su, { userId: ids.alice }, async (tx) => {
      const listed = await tx.select({ id: approvals.id }).from(approvals); // no scope condition at all
      expect(listed.map((a) => a.id)).toEqual([ids.aliceApproval]);
      expect(await tx.select().from(approvals).where(eq(approvals.id, ids.bobApproval))).toEqual([]);
      const updated = await tx
        .update(approvals)
        .set({ status: "approved", decidedBy: ids.alice })
        .where(eq(approvals.id, ids.bobApproval))
        .returning({ id: approvals.id });
      expect(updated).toEqual([]);
    });
    const [still] = await su.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, ids.bobApproval));
    expect(still!.status).toBe("pending");
  });

  it("approvals: a principal cannot queue an approval in someone else's name", async () => {
    const msg = await pgError(
      withPrincipal(su, { userId: ids.alice }, (tx) => tx.insert(approvals).values({ userId: ids.bob, approverUserId: ids.alice })),
    );
    expect(msg).toMatch(/new row violates row-level security policy for table "approvals"/);
  });

  it("approvals: the participant branches (routed role member, active delegate) see the row; an expired delegate does not", async () => {
    const seen = async (userId: string) =>
      withPrincipal(su, { userId }, async (tx) => (await tx.select({ id: approvals.id }).from(approvals)).map((a) => a.id).sort());
    expect(await seen(ids.carol)).toEqual([ids.routedApproval]);
    expect(await seen(ids.dave)).toEqual([ids.bobApproval, ids.routedApproval].sort());
    expect(await seen(ids.erin)).toEqual([]);
  });

  it("an active admin sees every approval and every audit row", async () => {
    await withPrincipal(su, { userId: ids.root }, async (tx) => {
      expect(await count(tx, "approvals")).toBe(await count(su, "approvals"));
      expect(await count(tx, "audit_log")).toBe(await count(su, "audit_log"));
    });
  });

  it("users: the directory is readable, but alice can update only her own row", async () => {
    await withPrincipal(su, { userId: ids.alice }, async (tx) => {
      expect(await count(tx, "users")).toBe(await count(su, "users"));
      const other = await tx.update(users).set({ displayName: "pwned" }).where(eq(users.id, ids.bob)).returning({ id: users.id });
      expect(other).toEqual([]);
      const own = await tx.update(users).set({ displayName: "Alice A." }).where(eq(users.id, ids.alice)).returning({ id: users.id });
      expect(own).toEqual([{ id: ids.alice }]);
    });
    const [bob] = await su.select({ name: users.displayName }).from(users).where(eq(users.id, ids.bob));
    expect(bob!.name).toBe("Bob");
  });

  it("auth_mfa_pending: bob's challenge is invisible to alice even by its exact token hash", async () => {
    await withPrincipal(su, { userId: ids.alice }, async (tx) => {
      expect(await tx.select().from(authMfaPending).where(eq(authMfaPending.tokenHash, bobMfaToken))).toEqual([]);
    });
  });

  it("audit_log: a non-admin reads only the rows about itself", async () => {
    await withPrincipal(su, { userId: ids.bob }, async (tx) => {
      const rows = await tx.select({ userId: auditLog.userId }).from(auditLog);
      expect(rows.length).toBe(2);
      expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([ids.bob]));
    });
  });
});

describe("the write side: WITH CHECK and column privileges (#682 review)", () => {
  // created here, not in the shared fixtures: every principal can SEE a review-role row, which would change the
  // exact-list assertions above
  beforeAll(async () => {
    await su.insert(approvals).values({
      id: ids.reviewApproval,
      userId: ids.root,
      approverUserId: ids.root,
      reviewRoleId: "rls0234-review",
      reviewRoleName: "RLS review",
      reviewRound: 1,
    });
  });
  afterAll(async () => {
    await su.delete(approvals).where(eq(approvals.id, ids.reviewApproval));
  });

  const status = async (id: string) =>
    (await su.select({ status: approvals.status, approver: approvals.approverUserId, named: approvals.namedApproverUserId })
      .from(approvals).where(eq(approvals.id, id)))[0]!;

  it("finding 1: non-participant bob can SEE a review-role row but can neither decide it nor re-point it to himself", async () => {
    const before = await status(ids.reviewApproval);
    await withPrincipal(su, { userId: ids.bob }, async (tx) => {
      expect((await tx.select({ id: approvals.id }).from(approvals).where(eq(approvals.id, ids.reviewApproval))).length).toBe(1);
      const decided = await tx
        .update(approvals)
        .set({ status: "approved", decidedBy: ids.bob })
        .where(eq(approvals.id, ids.reviewApproval))
        .returning({ id: approvals.id });
      expect(decided).toEqual([]);
    });
    const repoint = await pgError(
      withPrincipal(su, { userId: ids.bob }, (tx) =>
        tx.update(approvals).set({ namedApproverUserId: ids.bob }).where(eq(approvals.id, ids.reviewApproval)),
      ),
    );
    expect(repoint).toMatch(/permission denied for table approvals/);
    expect(await status(ids.reviewApproval)).toEqual(before);
  });

  it("finding 1: even a participant cannot rewrite the routing identity (requester, named approver, roles)", async () => {
    for (const set of [{ userId: ids.bob }, { namedApproverUserId: ids.alice }, { approverRoleId: ids.role }, { reviewRoleId: null }] as const) {
      const msg = await pgError(
        withPrincipal(su, { userId: ids.alice }, (tx) => tx.update(approvals).set(set).where(eq(approvals.id, ids.aliceApproval))),
      );
      expect(msg).toMatch(/permission denied for table approvals/);
    }
  });

  it("finding 1: the requester cannot route its own approval to itself or record itself as the decider", async () => {
    for (const set of [{ approverUserId: ids.alice }, { status: "approved", decidedBy: ids.alice }] as const) {
      const msg = await pgError(
        withPrincipal(su, { userId: ids.alice }, (tx) => tx.update(approvals).set(set).where(eq(approvals.id, ids.aliceApproval))),
      );
      expect(msg).toMatch(/new row violates row-level security policy for table "approvals"/);
    }
    expect((await status(ids.aliceApproval)).approver).toBe(ids.root);
  });

  it("positive controls: a routed role member may claim, approval_maintenance may route, an admin may decide", async () => {
    const claimed = await withPrincipal(su, { userId: ids.carol }, (tx) =>
      tx.update(approvals).set({ approverUserId: ids.carol }).where(eq(approvals.id, ids.routedApproval)).returning({ id: approvals.id }),
    );
    expect(claimed).toEqual([{ id: ids.routedApproval }]);
    const routed = await withSystemContext(su, "approval_maintenance", "test.route", (tx) =>
      tx.update(approvals).set({ approverUserId: ids.bob }).where(eq(approvals.id, ids.routedApproval)).returning({ id: approvals.id }),
    );
    expect(routed).toEqual([{ id: ids.routedApproval }]);
    const decided = await withPrincipal(su, { userId: ids.root }, (tx) =>
      tx.update(approvals).set({ decisionReason: "rls0234 admin" }).where(eq(approvals.id, ids.reviewApproval)).returning({ id: approvals.id }),
    );
    expect(decided).toEqual([{ id: ids.reviewApproval }]);
  });

  it("finding 2: alice cannot append an audit row attributed to bob", async () => {
    const forged = await pgError(
      withPrincipal(su, { userId: ids.alice }, (tx) =>
        tx.insert(auditLog).values({ userId: ids.bob, effect: "allow", ruleId: "rls0234", ruleChain: [], reason: "rls0234 forged" }),
      ),
    );
    expect(forged).toMatch(/new row violates row-level security policy for table "audit_log"/);
    expect(
      await su.execute(sql`select 1 from audit_log where reason = 'rls0234 forged'`).then((r) => r.rows.length),
    ).toBe(0);
  });

  it("finding 3: a principal cannot promote or re-enable itself, and `authenticate` has no write path on users", async () => {
    const promote = await pgError(
      withPrincipal(su, { userId: ids.alice }, (tx) => tx.update(users).set({ isAdmin: true }).where(eq(users.id, ids.alice))),
    );
    expect(promote).toMatch(/new row violates row-level security policy for table "users"/);
    const viaAuth = await withSystemContext(su, "authenticate", "test.sign-in", (tx) =>
      tx.update(users).set({ isAdmin: true }).where(eq(users.id, ids.alice)).returning({ id: users.id }),
    );
    expect(viaAuth).toEqual([]);
    const [alice] = await su.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, ids.alice));
    expect(alice!.isAdmin).toBe(false);
  });
});

describe("secure by default: a missing setting means zero rows", () => {
  it("as the app role with neither a principal nor a system context, every slice-1 table is empty", async () => {
    await su.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
      for (const t of RLS_TABLES) expect([t, await count(tx, t)]).toEqual([t, 0]);
    });
  });

  it("still zero on a connection that carried a principal before (a reset setting reads back as '')", async () => {
    await withPrincipal(one, { userId: ids.root }, async (tx) => expect(await count(tx, "approvals")).toBeGreaterThan(0));
    await one.transaction(async (tx) => {
      const r = await tx.execute<{ v: string | null }>(sql`select current_setting('regulait.user_id', true) as v`);
      expect(r.rows[0]!.v ?? "").toBe(""); // the same physical connection, the setting gone
      await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
      for (const t of RLS_TABLES) expect([t, await count(tx, t)]).toEqual([t, 0]);
    });
  });

  it("a malformed principal is refused before any SQL runs", async () => {
    await expect(withPrincipal(su, { userId: "1 or 1=1" }, async () => "ran")).rejects.toBeInstanceOf(RlsContextError);
  });
});

describe("the pooled connection is clean after every wrapper", () => {
  const settings = async () => {
    const r = await one.execute<{ who: string; principal: string | null; system: string | null }>(sql`
      select current_user as who, current_setting('regulait.user_id', true) as principal,
             current_setting('regulait.system_context', true) as system`);
    return r.rows[0]!;
  };

  it("after withPrincipal commits: the login role again, no principal, no system context", async () => {
    const login = (await settings()).who;
    expect(login).not.toBe("regulait_app");
    await withPrincipal(one, { userId: ids.alice }, async (tx) => {
      const r = await tx.execute<{ who: string; principal: string }>(
        sql`select current_user as who, current_setting('regulait.user_id') as principal`,
      );
      expect(r.rows[0]).toEqual({ who: "regulait_app", principal: ids.alice });
    });
    const after = await settings();
    expect([after.who, after.principal ?? "", after.system ?? ""]).toEqual([login, "", ""]);
  });

  it("after withPrincipal throws (rolled back) and after withSystemContext: still clean", async () => {
    const login = (await settings()).who;
    await expect(
      withPrincipal(one, { userId: ids.alice }, async () => {
        throw new Error("boom inside the scoped transaction");
      }),
    ).rejects.toThrow("boom");
    let after = await settings();
    expect([after.who, after.principal ?? "", after.system ?? ""]).toEqual([login, "", ""]);
    await withSystemContext(one, "authenticate", "test.clean", async (tx) => count(tx, "users"));
    after = await settings();
    expect([after.who, after.principal ?? "", after.system ?? ""]).toEqual([login, "", ""]);
  });
});

describe("system contexts are explicit, audited and narrow — never a blanket bypass", () => {
  it("`authenticate` opens users and MFA challenges, and nothing in approvals or audit_log", async () => {
    const seen: RlsSystemContextEntry[] = [];
    setRlsSystemContextSink((e) => seen.push(e));
    const before = rlsSystemContextCounts().authenticate ?? 0;
    await withSystemContext(su, "authenticate", "test.sign-in", async (tx) => {
      expect(await count(tx, "users")).toBe(await count(su, "users"));
      expect(await tx.select().from(authMfaPending).where(eq(authMfaPending.tokenHash, bobMfaToken))).toHaveLength(1);
      expect(await count(tx, "approvals")).toBe(0);
      expect(await count(tx, "audit_log")).toBe(0);
    });
    expect(seen.map((e) => [e.reason, e.path])).toEqual([["authenticate", "test.sign-in"]]);
    expect(rlsSystemContextCounts().authenticate).toBe(before + 1);
  });

  it("an unregistered reason is refused in TypeScript before any SQL, and by the database if set by hand", async () => {
    await expect(
      withSystemContext(su, "everything" as never, "test.bad", async () => "ran"),
    ).rejects.toBeInstanceOf(RlsContextError);
    const msg = await pgError(
      su.transaction(async (tx) => {
        await tx.execute(sql`select set_config('role', 'regulait_app', true), set_config('regulait.system_context', 'everything', true)`);
        return count(tx, "users");
      }),
    );
    expect(msg).toMatch(/unknown row-level security system context 'everything'/);
  });
});

describe("the audit chain stays one chain under a principal", () => {
  it("negative control: through bob's RLS view the tip is NOT the global tip (a naive tip read would fork)", async () => {
    const [global] = (await su.execute<{ seq: number }>(sql`select max(seq)::int as seq from audit_log`)).rows;
    const bobView = await withPrincipal(su, { userId: ids.bob }, async (tx) =>
      (await tx.execute<{ seq: number }>(sql`select max(seq)::int as seq from audit_log`)).rows[0]!.seq,
    );
    expect(bobView).toBeLessThan(global!.seq);
  });

  it("a row appended by non-admin bob chains onto the GLOBAL tip (alice's row), not bob's last row", async () => {
    const tip = (
      await su.execute<{ seq: number; row_hash: string }>(sql`select seq::int as seq, row_hash from audit_log where seq is not null order by seq desc limit 1`)
    ).rows[0]!;
    await withPrincipal(su, { userId: ids.bob }, (tx) =>
      tx.insert(auditLog).values({ userId: ids.bob, effect: "allow", ruleId: "rls0234", ruleChain: [], reason: "rls0234 bob append" }),
    );
    const appended = (
      await su.execute<{ seq: number; prev_hash: string; user_id: string }>(
        sql`select seq::int as seq, prev_hash, user_id from audit_log where seq is not null order by seq desc limit 1`,
      )
    ).rows[0]!;
    expect(appended).toEqual({ seq: tip.seq + 1, prev_hash: tip.row_hash, user_id: ids.bob });
  });
});

describe("later migrations that touch rows of an RLS table enter the migration context", () => {
  it("every migration after 0265 with DML on a slice-1 table sets regulait.system_context = 'migration'", () => {
    const dml = new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?"?(${RLS_TABLES.join("|")})"?\\b`, "i");
    const offenders = readdirSync(migrationsFolder)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > 265)
      .filter((f) => {
        const body = readFileSync(path.join(migrationsFolder, f), "utf8");
        return dml.test(body) && !/set_config\(\s*'regulait\.system_context'\s*,\s*'migration'\s*,\s*true\s*\)/i.test(body);
      });
    expect(offenders).toEqual([]);
  });
});
