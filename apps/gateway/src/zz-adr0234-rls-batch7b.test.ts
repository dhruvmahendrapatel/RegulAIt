/**
 * ADR-0234 batch 7b (PENDING S7): the runtime login cut-over.
 *
 * Requests are served on a login that is a member of regulait_app and is not a superuser, BYPASSRLS or the table
 * owner; the owner login keeps the migrations and the audit prune. Against a scratch database, these tests prove:
 *   - the pure fitness rules, one row per problem (table-driven), and the per-database role name;
 *   - the SCRAM-SHA-256 verifier: Postgres stores it as sent and a real login with the password succeeds;
 *   - the facts and the refusal: the suite's superuser login is refused without the dev opt-in, taken loudly with it,
 *     and refused even with it when a deploy signal is present;
 *   - real probe roles (in rolled-back transactions, unique names): a member of the table owner, of a BYPASSRLS role,
 *     of a superuser role, a CREATEROLE login, and regulait_app granted a privileged role, each refused by name;
 *   - the install-generated login: the first resolution creates `regulait_runtime_<db>` and then its 0600
 *     connection-string file (no temporary file left), the next one reads it, and the login is fit; re-provisioning
 *     strips a membership and CREATEROLE an operator added;
 *   - RLS binds the runtime login: unscoped it sees zero rows of an RLS table, as a principal its own, as a job all;
 *   - the real boot on the install-generated login, with no opt-in, says so in its posture line and serves a request;
 *   - the audit_log DELETE policy is scoped TO the table owner: a stand-in for the owner deletes only under
 *     `audit_retention`, a non-owner with DELETE never, and the runtime login cannot delete even naming the reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import {
  approvals,
  auditLog,
  createDb,
  inspectRuntimeLogin,
  runMigrations,
  runWithRlsPrincipal,
  provisionRuntimeLogin,
  runWithRlsSystem,
  RUNTIME_LOGIN_ROLE_PREFIX,
  runtimeLoginProblems,
  runtimeLoginRoleFor,
  scramSha256Verifier,
  sql,
  users,
  withRuntimeLoginLock,
  type Db,
  type RuntimeLoginFacts,
} from "@regulait/db";
import { startGateway } from "./boot.js";
import {
  checkRuntimeLogin,
  DEV_PRIVILEGED_DB_LOGIN_ENV,
  resolveRuntimeDatabase,
  RUNTIME_URL_FILE,
  RuntimeLoginBootError,
} from "./runtime-login.js";
import { backdated } from "./testing/backdated-audit.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `rls0234b7b_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
const RUNTIME_ROLE = runtimeLoginRoleFor(SCRATCH_DB);
/** a cluster-unique role name per use: roles are cluster-wide and suites run concurrently on CI */
const probeName = (what: string) => `rls7b_${what}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const BOOT = "rls0234b7b-bootstrap-token";

let admin: Db;
let owner: Db; // the scratch database on the suite's (superuser, owner) login
let runtime: Db | null = null;
let secretsDir = "";
const ids = { alice: randomUUID(), bob: randomUUID(), aliceApproval: randomUUID(), bobApproval: randomUUID() };

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  return "(no error)";
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  owner = createDb(urlFor(SCRATCH_DB));
  await runMigrations(owner, migrationsFolder);
  await owner.insert(users).values([
    { id: ids.alice, email: `alice-${ids.alice}@rls.test`, displayName: "Alice" },
    { id: ids.bob, email: `bob-${ids.bob}@rls.test`, displayName: "Bob" },
  ]);
  await owner.insert(approvals).values([
    { id: ids.aliceApproval, userId: ids.alice, approverUserId: ids.alice },
    { id: ids.bobApproval, userId: ids.bob, approverUserId: ids.bob },
  ]);
  secretsDir = mkdtempSync(path.join(os.tmpdir(), "rls0234b7b-"));
}, 180_000);

afterAll(async () => {
  await runtime?.$client.end().catch(() => undefined);
  await owner?.$client.end().catch(() => undefined);
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`)).catch(() => undefined);
    await admin.$client.end().catch(() => undefined);
  }
});


// ---------------------------------------------------------------------------------------------------------------------
// the pure rules
// ---------------------------------------------------------------------------------------------------------------------

const cleanApp = {
  superuser: false, bypassRls: false, createRole: false, ownsRlsTable: false,
  memberOfSuperuser: [], memberOfBypassRls: [], memberOfRlsOwner: [], memberOfCreateRole: [],
};
const FIT: RuntimeLoginFacts = { login: "probe", ...cleanApp, appMember: true, appInherited: true, appRole: cleanApp };

describe("runtimeLoginProblems, one named problem per row", () => {
  const rows: Array<[string, Partial<RuntimeLoginFacts>, RegExp]> = [
    ["superuser", { superuser: true }, /^is a superuser /],
    ["BYPASSRLS", { bypassRls: true }, /^has BYPASSRLS /],
    ["CREATEROLE", { createRole: true }, /^has CREATEROLE /],
    ["owns an RLS table", { ownsRlsTable: true }, /^owns a row-level-security table /],
    ["member of the owner role", { memberOfRlsOwner: ["tbl_owner"] }, /^is a member of 'tbl_owner', which owns a row-level-security table/],
    ["member of a BYPASSRLS role", { memberOfBypassRls: ["bypasser"] }, /^is a member of BYPASSRLS role 'bypasser'/],
    ["member of a superuser role", { memberOfSuperuser: ["root_ish"] }, /^is a member of superuser role 'root_ish'/],
    ["member of a CREATEROLE role", { memberOfCreateRole: ["maker"] }, /^is a member of CREATEROLE role 'maker'/],
    ["not a member of regulait_app", { appMember: false, appInherited: false }, /^is not a member of regulait_app/],
    ["NOINHERIT", { appInherited: false }, /^does not inherit regulait_app's privileges/],
    ["regulait_app is BYPASSRLS", { appRole: { ...cleanApp, bypassRls: true } }, /^its regulait_app role has BYPASSRLS/],
    ["regulait_app is a superuser", { appRole: { ...cleanApp, superuser: true } }, /^its regulait_app role is a superuser/],
    ["regulait_app owns an RLS table", { appRole: { ...cleanApp, ownsRlsTable: true } }, /^its regulait_app role owns a row-level-security table/],
    ["regulait_app is a member of a privileged role", { appRole: { ...cleanApp, memberOfBypassRls: ["bypasser"] } }, /^its regulait_app role is a member of BYPASSRLS role 'bypasser'/],
  ];
  it.each(rows)("%s", (_name, patch, re) => {
    const problems = runtimeLoginProblems({ ...FIT, ...patch });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(re);
  });
  it("all clear: a fit login has no problem", () => {
    expect(runtimeLoginProblems(FIT)).toEqual([]);
  });
});

describe("the runtime login's name is per database", () => {
  it("regulait_runtime_<db>, digest-suffixed when the name had to change, never past 63 bytes", () => {
    expect(runtimeLoginRoleFor("regulait")).toBe(`${RUNTIME_LOGIN_ROLE_PREFIX}regulait`);
    const odd = runtimeLoginRoleFor("My-DB");
    expect(odd).toMatch(/^regulait_runtime_my_db_[0-9a-f]{8}$/);
    expect(odd).not.toBe(runtimeLoginRoleFor("my_db"));
    const a = runtimeLoginRoleFor("x".repeat(80) + "a");
    const b = runtimeLoginRoleFor("x".repeat(80) + "b");
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b);
    expect(runtimeLoginRoleFor("é")).toMatch(/^regulait_runtime_[a-z0-9_]+$/);
  });
});

describe("the SCRAM-SHA-256 verifier", () => {
  it("has the pg_authid form, and Postgres stores it as sent and logs the password in with it", async () => {
    const pw = randomBytes(32).toString("base64url");
    const v = scramSha256Verifier(pw);
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(v).not.toContain(pw);
    const role = probeName("scram");
    await admin.execute(sql.raw(`CREATE ROLE ${role} LOGIN PASSWORD '${v}'`));
    const handles: Db[] = [];
    try {
      const stored = await admin.execute<{ p: string }>(sql`select rolpassword as p from pg_catalog.pg_authid where rolname = ${role}`);
      expect(stored.rows[0]?.p).toBe(v);
      const u = new URL(urlFor(SCRATCH_DB));
      u.username = role;
      u.password = pw;
      const good = createDb(u.toString());
      handles.push(good);
      const who = await good.execute<{ u: string }>(sql`select current_user::text as u`);
      expect(who.rows[0]?.u).toBe(role);
      u.password = randomBytes(32).toString("base64url");
      const bad = createDb(u.toString());
      handles.push(bad);
      expect(await pgError(bad.execute(sql`select 1`))).toMatch(/password authentication failed/);
    } finally {
      for (const h of handles) await h.$client.end().catch(() => undefined);
      await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
    }
  });
});

describe("the facts and the refusal", () => {
  it("the suite's superuser owner login is not fit, and is refused without the dev opt-in", async () => {
    const f = await inspectRuntimeLogin(owner);
    expect(f.superuser).toBe(true);
    expect(runtimeLoginProblems(f).join("; ")).toMatch(/superuser/);
    await expect(checkRuntimeLogin(owner, {})).rejects.toBeInstanceOf(RuntimeLoginBootError);
  });

  it("with the dev opt-in it is taken, flagged privileged", async () => {
    const c = await checkRuntimeLogin(owner, { [DEV_PRIVILEGED_DB_LOGIN_ENV]: "1" });
    expect(c.privileged).toBe(true);
    expect(c.problems.length).toBeGreaterThan(0);
  });

  it("the dev opt-in is itself refused when a deploy signal is present", async () => {
    for (const deployed of [{ REGULAIT_DEPLOY_MODE: "hosted" }, { REGULAIT_HSTS: "max-age=31536000" }]) {
      const err = (await checkRuntimeLogin(owner, { [DEV_PRIVILEGED_DB_LOGIN_ENV]: "1", ...deployed }).catch((e: unknown) => e)) as RuntimeLoginBootError;
      expect(err).toBeInstanceOf(RuntimeLoginBootError);
      expect(err.deploySignal).toMatch(/^REGULAIT_(DEPLOY_MODE|HSTS)/);
      expect(err.message).toContain(`${DEV_PRIVILEGED_DB_LOGIN_ENV}=1 is refused here`);
    }
  });
});

class Rollback extends Error {
  constructor(readonly problems: string[]) {
    super("rollback");
  }
}

/**
 * The real check against a real probe role: created, granted and switched to in ONE transaction that is rolled back,
 * so nothing outlives the test on the (cluster-wide) role catalogue, and the name is unique per call.
 */
async function probeProblems(setup: (login: string) => string[]): Promise<string[]> {
  const login = probeName("login");
  return owner
    .transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.execute(sql.raw(`CREATE ROLE ${login} NOLOGIN INHERIT`));
      for (const stmt of setup(login)) await tx.execute(sql.raw(stmt));
      await tx.execute(sql.raw(`SET LOCAL ROLE ${login}`));
      const problems = await checkRuntimeLogin(tx, {}).then(
        () => [] as string[],
        (e: unknown) => {
          if (e instanceof RuntimeLoginBootError) return e.problems;
          throw e;
        },
      );
      throw new Rollback(problems);
    })
    .catch((e: unknown) => {
      if (e instanceof Rollback) return e.problems;
      throw e;
    });
}

describe("real probe roles, refused by name", () => {
  it("a member of regulait_app and nothing else is fit", async () => {
    expect(await probeProblems((l) => [`GRANT regulait_app TO ${l}`])).toEqual([]);
  });

  it("a member of a role that owns a row-level-security table", async () => {
    const own = probeName("owner");
    const t = probeName("tbl");
    const problems = await probeProblems((l) => [
      `CREATE ROLE ${own} NOLOGIN`,
      `CREATE TABLE public.${t} (id int)`,
      `ALTER TABLE public.${t} OWNER TO ${own}`,
      `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`,
      `GRANT regulait_app TO ${l}`,
      `GRANT ${own} TO ${l}`,
    ]);
    expect(problems).toEqual([expect.stringMatching(new RegExp(`^is a member of '${own}', which owns a row-level-security table`))]);
  });

  it("a member (indirectly) of a BYPASSRLS role", async () => {
    const b = probeName("bypass");
    const mid = probeName("mid");
    const problems = await probeProblems((l) => [
      `CREATE ROLE ${b} NOLOGIN BYPASSRLS`,
      `CREATE ROLE ${mid} NOLOGIN`,
      `GRANT ${b} TO ${mid}`,
      `GRANT regulait_app TO ${l}`,
      `GRANT ${mid} TO ${l}`,
    ]);
    expect(problems).toEqual([expect.stringMatching(new RegExp(`^is a member of BYPASSRLS role '${b}'`))]);
  });

  it("a member of a superuser role", async () => {
    const su = probeName("super");
    const problems = await probeProblems((l) => [`CREATE ROLE ${su} NOLOGIN SUPERUSER`, `GRANT regulait_app TO ${l}`, `GRANT ${su} TO ${l}`]);
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^is a member of superuser role '${su}'`))]));
  });

  it("a CREATEROLE login, a NOINHERIT login and a login outside regulait_app", async () => {
    expect(await probeProblems((l) => [`ALTER ROLE ${l} CREATEROLE`, `GRANT regulait_app TO ${l}`])).toEqual([
      expect.stringMatching(/^has CREATEROLE/),
    ]);
    expect(await probeProblems((l) => [`ALTER ROLE ${l} NOINHERIT`, `GRANT regulait_app TO ${l}`])).toEqual([
      expect.stringMatching(/^does not inherit regulait_app/),
    ]);
    expect(await probeProblems(() => [])).toEqual([expect.stringMatching(/^is not a member of regulait_app/)]);
  });

  it("regulait_app itself granted a privileged role", async () => {
    const b = probeName("bypass");
    const problems = await probeProblems((l) => [`CREATE ROLE ${b} NOLOGIN BYPASSRLS`, `GRANT ${b} TO regulait_app`, `GRANT regulait_app TO ${l}`]);
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^its regulait_app role is a member of BYPASSRLS role '${b}'`))]));
  });
});

describe("the install-generated runtime login", () => {
  it("the first resolution creates the login, then a 0600 file; the next reads it; the login is fit", async () => {
    const env = { REGULAIT_INSTALL_SECRETS_DIR: secretsDir } as NodeJS.ProcessEnv;
    const first = await resolveRuntimeDatabase(env, owner, urlFor(SCRATCH_DB));
    expect(first.source).toBe("install_generated");
    expect(first.created).toBe(true);
    const file = path.join(secretsDir, RUNTIME_URL_FILE);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(secretsDir)).toEqual([RUNTIME_URL_FILE]); // no temporary file left behind
    expect(new URL(readFileSync(file, "utf8").trim()).username).toBe(RUNTIME_ROLE);
    // the password reached the server as a SCRAM verifier, and CONNECT is on this database
    const stored = await admin.execute<{ p: string; c: boolean }>(
      sql`select rolpassword as p, has_database_privilege(rolname, ${SCRATCH_DB}, 'CONNECT') as c from pg_catalog.pg_authid where rolname = ${RUNTIME_ROLE}`,
    );
    expect(stored.rows[0]?.p).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(stored.rows[0]?.c).toBe(true);
    await first.db.$client.end();

    const second = await resolveRuntimeDatabase(env, owner, urlFor(SCRATCH_DB));
    expect(second.created).toBe(false);
    runtime = second.db;
    const f = await inspectRuntimeLogin(runtime);
    expect(f.login).toBe(RUNTIME_ROLE);
    expect(runtimeLoginProblems(f)).toEqual([]);
    expect((await checkRuntimeLogin(runtime, {})).privileged).toBe(false);
  });

  it("row-level security binds it: unscoped nothing, a principal its own, a job everything", async () => {
    const rt = runtime!;
    expect(await rt.select({ id: approvals.id }).from(approvals)).toEqual([]);
    const mine = await runWithRlsPrincipal({ userId: ids.alice }, async () => (await rt.select({ id: approvals.id }).from(approvals)).map((r) => r.id));
    expect(mine).toEqual([ids.aliceApproval]);
    const all = await runWithRlsSystem("system_task", "test.job", async () => (await rt.select({ id: approvals.id }).from(approvals)).map((r) => r.id).sort());
    expect(all).toEqual([ids.aliceApproval, ids.bobApproval].sort());
    // and it cannot turn the policies off: it does not own the table
    expect(await pgError(rt.execute(sql`alter table approvals no force row level security`))).toMatch(/must be owner/);
  });
});

describe("the real boot on the install-generated login", () => {
  it("boots with no opt-in, says RLS is enforced, and serves a bootstrap-token request through the policies", async () => {
    const lines: string[] = [];
    const port = await freePort();
    const started = await startGateway({
      db: owner,
      connectionString: urlFor(SCRATCH_DB),
      migrationsFolder,
      port,
      host: "127.0.0.1",
      bootstrapToken: BOOT,
      dataKey: "b".repeat(64),
      log: (l) => lines.push(l),
      env: { PATH: process.env.PATH, VITEST: "1", REGULAIT_SCHEDULER: "off", REGULAIT_INSTALL_SECRETS_DIR: secretsDir } as NodeJS.ProcessEnv,
    });
    try {
      const posture = lines.find((l) => l.includes("db login:")) ?? "";
      expect(posture).toContain(`'${RUNTIME_ROLE}'`);
      expect(posture).toContain("row-level security enforced");
      expect(lines.join("\n")).not.toContain(DEV_PRIVILEGED_DB_LOGIN_ENV);
      const r = await started.app.inject({ method: "GET", url: "/v1/users", headers: { authorization: `Bearer ${BOOT}` } });
      expect(r.statusCode).toBe(200);
      expect(JSON.stringify(r.json())).toContain(ids.alice);

      // the admin's prune runs on the OWNER pool (the runtime login has no DELETE on the ledger): a row past the
      // floor is removed through the real route, while every request is served on the runtime login
      const auth = { authorization: `Bearer ${BOOT}` };
      const put = await started.app.inject({ method: "PUT", url: "/v1/org/settings", headers: auth, payload: { defaultAuditRetentionDays: 100 } });
      expect(put.statusCode, put.body).toBe(200);
      const floor = (await started.app.inject({ method: "GET", url: "/v1/audit/retention", headers: auth })).json().retainedDays as number;
      await backdated(owner).insert(auditLog).values({
        userId: ids.alice, objectType: "project", objectId: null, at: new Date(Date.now() - (floor + 100) * 86_400_000),
        detail: { t: "b7b-old" }, effect: "allow", ruleId: "rls0234b7b-past-floor", ruleChain: [], reason: "batch 7b owner-pool prune test row",
      });
      const pruned = await started.app.inject({ method: "POST", url: "/v1/audit/prune", headers: auth });
      expect(pruned.statusCode, pruned.body).toBe(200);
      expect(pruned.json().deleted).toBeGreaterThanOrEqual(1);
      expect(await owner.select({ id: auditLog.id }).from(auditLog).where(sql`rule_id = 'rls0234b7b-past-floor'`)).toEqual([]);
    } finally {
      await started.app.close();
    }
  }, 120_000);
});

describe("the audit_log DELETE policy is scoped TO the table owner", () => {
  it("names the owner; an owner stand-in deletes only under audit_retention; a non-owner never; the runtime login never", async () => {
    await owner.insert(auditLog).values({
      userId: ids.alice, objectType: "project", objectId: null, detail: { t: "b7b" }, effect: "allow",
      ruleId: "rls0234b7b-prunable", ruleChain: [], reason: "batch 7b prune test row",
    });
    const tableOwner = (
      await owner.execute<{ o: string }>(sql`select pg_catalog.pg_get_userbyid(relowner)::text as o from pg_catalog.pg_class where oid = 'public.audit_log'::regclass`)
    ).rows[0]!.o;
    const pol = await owner.execute<{ roles: string[] }>(
      sql`select roles::text[] as roles from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'audit_log' and policyname = 'audit_log_delete'`,
    );
    expect(pol.rows[0]?.roles).toEqual([tableOwner]);

    // each attempt in its own rolled-back transaction, its stand-in role created inside it (nothing outlives it)
    const del = async (setup: (role: string) => string[], reason: string | null) => {
      const role = probeName("pruner");
      return owner
        .transaction(async (rawTx) => {
          const tx = rawTx as unknown as Db;
          await tx.execute(sql.raw(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS INHERIT`));
          for (const stmt of setup(role)) await tx.execute(sql.raw(stmt));
          await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
          if (reason) await tx.execute(sql`select pg_catalog.set_config('regulait.system_context', ${reason}, true)`);
          const r = await tx.execute<{ n: number }>(sql`with d as (delete from audit_log where rule_id = 'rls0234b7b-prunable' returning 1) select count(*)::int as n from d`);
          throw Object.assign(new Error("rollback"), { n: r.rows[0]?.n });
        })
        .catch((e: { n?: number; message?: string; cause?: { message?: string } }) => e.n ?? `${e.cause?.message ?? e.message}`);
    };
    // the owner's stand-in: a member of the owner (a member is not a superuser, and FORCE binds the owner's privileges)
    const asOwner = (r: string) => [`GRANT "${tableOwner}" TO ${r}`];
    expect(await del(asOwner, null)).toBe(0);
    expect(await del(asOwner, "system_task")).toBe(0);
    expect(await del(asOwner, "audit_retention")).toBe(1);
    // a non-owner with DELETE on the ledger (the policy is not for it): nothing, whatever reason it names
    const nonOwner = (r: string) => [`GRANT SELECT, DELETE ON audit_log TO ${r}`, `GRANT regulait_app TO ${r}`];
    expect(await del(nonOwner, "audit_retention")).toBe(0);
    expect(await del(nonOwner, "migration")).toBe(0);

    const rt = runtime!;
    const msg = await pgError(
      rt.transaction(async (tx) => {
        await tx.execute(sql`select pg_catalog.set_config('regulait.system_context', 'audit_retention', true)`);
        await tx.execute(sql`delete from audit_log where rule_id = 'rls0234b7b-prunable'`);
      }),
    );
    expect(msg).toMatch(/permission denied/);
    expect((await owner.select({ id: auditLog.id }).from(auditLog).where(sql`rule_id = 'rls0234b7b-prunable'`)).length).toBe(1);
  });
});

describe("re-provisioning repairs an existing login", () => {
  it("revokes every membership but regulait_app and takes CREATEROLE away; the new password logs in", async () => {
    const extra = probeName("extra");
    await admin.execute(sql.raw(`CREATE ROLE ${extra} NOLOGIN BYPASSRLS`));
    let again: Db | null = null;
    try {
      await admin.execute(sql.raw(`GRANT ${extra} TO ${RUNTIME_ROLE}`));
      await admin.execute(sql.raw(`ALTER ROLE ${RUNTIME_ROLE} CREATEROLE`));
      const before = runtimeLoginProblems(await inspectRuntimeLogin(runtime!));
      expect(before).toEqual(expect.arrayContaining([expect.stringMatching(/^has CREATEROLE/), expect.stringMatching(new RegExp(`BYPASSRLS role '${extra}'`))]));
      const pw = randomBytes(32).toString("base64url");
      expect(await withRuntimeLoginLock(owner, (c) => provisionRuntimeLogin(c, pw))).toEqual({ created: false, role: RUNTIME_ROLE });
      const u = new URL(urlFor(SCRATCH_DB));
      u.username = RUNTIME_ROLE;
      u.password = pw;
      again = createDb(u.toString());
      expect(runtimeLoginProblems(await inspectRuntimeLogin(again))).toEqual([]);
    } finally {
      await again?.$client.end().catch(() => undefined);
      await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${extra}`));
    }
  });
});
