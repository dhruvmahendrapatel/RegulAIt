/**
 * ADR-0234 batch 7b (PENDING S7): the runtime login cut-over.
 *
 * Requests are served on a login that is a member of regulait_app and is not a superuser, BYPASSRLS or the table
 * owner; the owner login keeps the migrations and the audit prune. Against a scratch database, these tests prove:
 *   - the facts and the refusal: the suite's superuser login is refused without the dev opt-in, and taken loudly with it;
 *   - the install-generated login: the first resolution creates `regulait_runtime` and its 0600 connection-string file,
 *     the next one reads it, and the login is fit;
 *   - RLS binds the runtime login: unscoped it sees zero rows of an RLS table, as a principal its own, as a job all;
 *   - the real boot on the install-generated login, with no opt-in, says so in its posture line and serves a request;
 *   - the owner-only `audit_retention` reason: a non-owner role with DELETE on the ledger deletes only under it, and
 *     the runtime login cannot delete even under it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  approvals,
  auditLog,
  createDb,
  inspectRuntimeLogin,
  runMigrations,
  runWithRlsPrincipal,
  runWithRlsSystem,
  RUNTIME_LOGIN_ROLE,
  runtimeLoginProblems,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { startGateway } from "./boot.js";
import {
  checkRuntimeLogin,
  DEV_PRIVILEGED_DB_LOGIN_ENV,
  resolveRuntimeDatabase,
  RUNTIME_URL_FILE,
  RuntimeLoginBootError,
} from "./runtime-login.js";
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
const PRUNER = `rls0234b7b_pruner_${process.pid}`;
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
    await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${RUNTIME_LOGIN_ROLE}`)).catch(() => undefined);
    await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${PRUNER}`)).catch(() => undefined);
    await admin.$client.end().catch(() => undefined);
  }
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
});

describe("the install-generated runtime login", () => {
  it("the first resolution creates the login and a 0600 file; the next reads it; the login is fit", async () => {
    const env = { REGULAIT_INSTALL_SECRETS_DIR: secretsDir } as NodeJS.ProcessEnv;
    const first = await resolveRuntimeDatabase(env, owner, urlFor(SCRATCH_DB));
    expect(first.source).toBe("install_generated");
    expect(first.created).toBe(true);
    const file = path.join(secretsDir, RUNTIME_URL_FILE);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await first.db.$client.end();

    const second = await resolveRuntimeDatabase(env, owner, urlFor(SCRATCH_DB));
    expect(second.created).toBe(false);
    runtime = second.db;
    const f = await inspectRuntimeLogin(runtime);
    expect(f.login).toBe(RUNTIME_LOGIN_ROLE);
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
      expect(posture).toContain(`'${RUNTIME_LOGIN_ROLE}'`);
      expect(posture).toContain("row-level security enforced");
      expect(lines.join("\n")).not.toContain(DEV_PRIVILEGED_DB_LOGIN_ENV);
      const r = await started.app.inject({ method: "GET", url: "/v1/users", headers: { authorization: `Bearer ${BOOT}` } });
      expect(r.statusCode).toBe(200);
      expect(JSON.stringify(r.json())).toContain(ids.alice);
    } finally {
      await started.app.close();
    }
  }, 120_000);
});

describe("the owner-only audit_retention reason", () => {
  it("a non-owner role with DELETE on the ledger deletes only under audit_retention; the runtime login never", async () => {
    await owner.insert(auditLog).values({
      userId: ids.alice, objectType: "project", objectId: null, detail: { t: "b7b" }, effect: "allow",
      ruleId: "rls0234b7b-prunable", ruleChain: [], reason: "batch 7b prune test row",
    });
    await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${PRUNER}`));
    await owner.execute(sql.raw(`CREATE ROLE ${PRUNER} NOLOGIN NOBYPASSRLS`));
    await owner.execute(sql.raw(`GRANT SELECT, DELETE ON audit_log TO ${PRUNER}`));
    // what the ledger policies' helpers read (the real owner owns all of it): this stand-in inherits regulait_app's
    // grants, which include no DELETE on audit_log, plus the direct DELETE above
    await owner.execute(sql.raw(`GRANT regulait_app TO ${PRUNER}`));
    const del = async (reason: string | null) =>
      owner.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${PRUNER}`));
        if (reason) await tx.execute(sql`select pg_catalog.set_config('regulait.system_context', ${reason}, true)`);
        const r = await tx.execute<{ n: number }>(sql`with d as (delete from audit_log where rule_id = 'rls0234b7b-prunable' returning 1) select count(*)::int as n from d`);
        throw Object.assign(new Error("rollback"), { n: r.rows[0]?.n });
      }).catch((e: { n?: number; message?: string; cause?: { message?: string } }) => e.n ?? `${e.cause?.message ?? e.message}`);
    expect(await del(null)).toBe(0);
    expect(await del("system_task")).toBe(0);
    expect(await del("audit_retention")).toBe(1);

    const rt = runtime!;
    const msg = await pgError(
      rt.transaction(async (tx) => {
        await tx.execute(sql`select pg_catalog.set_config('regulait.system_context', 'audit_retention', true)`);
        await tx.execute(sql`delete from audit_log where rule_id = 'rls0234b7b-prunable'`);
      }),
    );
    expect(msg).toMatch(/permission denied/);
  });
});
