/**
 * ADR-0234 batch 2 (PENDING S7): request-scoped row-level security.
 *
 * Slice 1 shipped explicit wrappers. Batch 2 makes the scope implicit: a request (or a sweep) declares it once with
 * `runWithRlsPrincipal` / `runWithRlsSystem`, and the pool every `createDb` handle is built on applies it to every
 * statement and transaction issued inside that async context. These tests run against a scratch database migrated to
 * the head (0272 slice 1 + 0313 column guard) and prove, with the application's own filters skipped:
 *   - a plain handle, a raw pool query and a drizzle transaction inside a principal scope see only that principal's
 *     rows (positive control: outside a scope the superuser login sees everything);
 *   - concurrent scopes on one shared pool do not bleed into each other;
 *   - a failing statement and a failing transaction roll back, and the ONE pooled connection comes back clean;
 *   - the 0313 column guard: `authenticate` and a self-edit may change sign-in state, never identity columns;
 *   - the gateway hooks: an authenticated request runs as its principal, a bootstrap-token request runs unscoped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  approvals,
  createDb,
  currentRlsScope,
  eq,
  runMigrations,
  runWithRlsPrincipal,
  runWithRlsSystem,
  runWithoutRlsScope,
  RlsContextError,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { NON_ADMIN_ROUTES } from "./route-classes.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `rls0234b2_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
const BOOT = "rls0234b2-bootstrap-token";

let admin: Db;
let db: Db; // the scratch database, default pool
let one: Db; // a ONE-connection pool: "the next borrower" is provably the same physical connection

const ids = {
  alice: randomUUID(),
  bob: randomUUID(),
  aliceApproval: randomUUID(),
  bobApproval: randomUUID(),
};

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  return "(no error)";
}
const approvalIds = async (h: Db | { select: Db["select"] }) =>
  (await h.select({ id: approvals.id }).from(approvals)).map((r) => r.id).sort();

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  one = createDb(urlFor(SCRATCH_DB), { max: 1 });
  await db.insert(users).values([
    { id: ids.alice, email: `alice-${ids.alice}@rls.test`, displayName: "Alice", costCenter: "cc-a" },
    { id: ids.bob, email: `bob-${ids.bob}@rls.test`, displayName: "Bob" },
  ]);
  await db.insert(approvals).values([
    { id: ids.aliceApproval, userId: ids.alice, approverUserId: ids.bob },
    { id: ids.bobApproval, userId: ids.bob, approverUserId: ids.bob },
  ]);
}, 180_000);

afterAll(async () => {
  await one?.$client.end().catch(() => undefined);
  await db?.$client.end().catch(() => undefined);
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await admin.$client.end().catch(() => undefined);
  }
});

describe("a principal scope applies to every statement on a plain handle", () => {
  it("positive control: outside any scope the superuser login sees every approval", async () => {
    expect(currentRlsScope()).toBeUndefined();
    expect(await approvalIds(db)).toEqual([ids.aliceApproval, ids.bobApproval].sort());
  });

  it("inside alice's scope an UNFILTERED select, a raw pool query and a drizzle transaction see her row only", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(await approvalIds(db)).toEqual([ids.aliceApproval]);
      const raw = (await db.$client.query("select id from approvals")) as { rows: Array<{ id: string }> };
      expect(raw.rows.map((r) => r.id)).toEqual([ids.aliceApproval]);
      const inTx = await db.transaction(async (tx) => {
        const first = await approvalIds(tx);
        // a nested transaction is a savepoint inside the same scoped transaction
        const nested = await tx.transaction(async (t2) => approvalIds(t2));
        return { first, nested };
      });
      expect(inTx).toEqual({ first: [ids.aliceApproval], nested: [ids.aliceApproval] });
      // and an unfiltered UPDATE cannot reach bob's row
      const touched = await db.update(approvals).set({ decisionReason: "rls0234b2" }).returning({ id: approvals.id });
      expect(touched.map((r) => r.id)).toEqual([ids.aliceApproval]);
    });
    const [bobRow] = await db.select({ r: approvals.decisionReason }).from(approvals).where(eq(approvals.id, ids.bobApproval));
    expect(bobRow!.r).toBeNull();
  });

  it("a LAZY builder returned from the scope callback still runs inside the scope", async () => {
    // `() => db.select()...` returns a drizzle builder that runs only when awaited; the helper starts it in scope
    const rows = await runWithRlsPrincipal({ userId: ids.alice }, () => db.select({ id: approvals.id }).from(approvals));
    expect(rows.map((r) => r.id)).toEqual([ids.aliceApproval]);
  });

  it("concurrent scopes on ONE shared pool do not bleed into each other", async () => {
    const run = (userId: string) =>
      runWithRlsPrincipal({ userId }, async () => {
        const seen: string[][] = [];
        for (let i = 0; i < 10; i++) seen.push(await approvalIds(db));
        return seen;
      });
    const [a, b] = await Promise.all([run(ids.alice), run(ids.bob)]);
    expect(new Set(a.map((x) => x.join()))).toEqual(new Set([ids.aliceApproval]));
    // bob is requester of one and approver of both
    expect(new Set(b.map((x) => x.join()))).toEqual(new Set([[ids.aliceApproval, ids.bobApproval].sort().join()]));
  });

  it("runWithoutRlsScope leaves a scope (the gateway's path for a request with no user)", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(await runWithoutRlsScope(async () => approvalIds(db))).toEqual([ids.aliceApproval, ids.bobApproval].sort());
    });
  });

  it("a malformed principal or an unregistered reason is refused before any SQL; a cursor is refused inside a scope", async () => {
    expect(() => runWithRlsPrincipal({ userId: "not-a-uuid" }, () => 1)).toThrow(RlsContextError);
    expect(() => runWithRlsSystem("rls_membership" as never, "test.x", () => 1)).toThrow(RlsContextError);
    expect(() => runWithRlsSystem("authenticate", "Not A Label", () => 1)).toThrow(RlsContextError);
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(() => db.$client.query({ text: "select 1", submit: () => undefined } as never)).toThrow(RlsContextError);
    });
  });
});

describe("the pooled connection is clean after every scoped statement and transaction", () => {
  const clean = async () =>
    (
      await one.execute<{ uid: string | null; sys: string | null; who: string }>(
        sql`select current_setting('regulait.user_id', true) as uid, current_setting('regulait.system_context', true) as sys, current_user as who`,
      )
    ).rows[0]!;
  let loginRole = "";
  beforeAll(async () => {
    loginRole = (await clean()).who;
  });

  it("after a scoped statement, a failing statement, a scoped transaction and a failing transaction", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(await approvalIds(one)).toEqual([ids.aliceApproval]);
      expect(await pgError(one.execute(sql`select 1/0`))).toMatch(/division by zero/);
      expect(await approvalIds(one)).toEqual([ids.aliceApproval]); // the pool still works after the failure
      await one.transaction(async (tx) => approvalIds(tx));
      expect(
        await pgError(
          one.transaction(async (tx) => {
            await tx.execute(sql`select 1`);
            throw new Error("rls0234b2 boom");
          }),
        ),
      ).toMatch(/boom/);
    });
    const after = await clean();
    expect(after.who).toBe(loginRole);
    expect(after.uid ?? "").toBe("");
    expect(after.sys ?? "").toBe("");
    expect(await approvalIds(one)).toEqual([ids.aliceApproval, ids.bobApproval].sort());
  });
});

describe("#700 review: a failed scope setup never returns an aborted connection to the pool", () => {
  // a login that is NOT a member of regulait_app: `set_config('role', 'regulait_app', true)` fails after BEGIN
  const role = `rls0234b2_nogrant_${process.pid}`;
  const password = randomUUID();
  let noGrant: Db;
  const aborted = /current transaction is aborted/i;
  beforeAll(async () => {
    await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
    await admin.execute(sql.raw(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`));
    const u = new URL(urlFor(SCRATCH_DB));
    u.username = role;
    u.password = password;
    noGrant = createDb(u.toString(), { max: 1 }); // ONE connection: the next statement reuses the failed one
  });
  afterAll(async () => {
    await noGrant?.$client.end().catch(() => undefined);
    await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`)).catch(() => undefined);
  });
  const settled = async () =>
    (await noGrant.execute<{ ok: number; uid: string | null }>(sql`select 1 as ok, current_setting('regulait.user_id', true) as uid`))
      .rows[0]!;

  it("a plain scoped statement whose setup fails is rolled back; the next pooled statement works", async () => {
    const err = await runWithRlsPrincipal({ userId: ids.alice }, () => pgError(noGrant.execute(sql`select 1`)));
    expect(err).toMatch(/permission denied|must be (a )?member/i);
    expect(err).not.toMatch(aborted);
    const next = await settled();
    expect(next.ok).toBe(1);
    expect(next.uid ?? "").toBe("");
  });

  it("a scoped transaction whose setup fails after BEGIN is rolled back; the next pooled statement works", async () => {
    const err = await runWithRlsPrincipal({ userId: ids.alice }, () =>
      pgError(noGrant.transaction(async (tx) => tx.execute(sql`select 1`))),
    );
    expect(err).toMatch(/permission denied|must be (a )?member/i);
    const next = await settled();
    expect(next.ok).toBe(1);
    expect(next.uid ?? "").toBe("");
  });
});

describe("#700 review: COMMIT/ROLLBACK AND CHAIN is refused inside a scope", () => {
  it("in a plain statement and inside a scoped transaction, before anything is sent", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      expect(await pgError(one.execute(sql.raw("commit and chain")))).toMatch(/AND CHAIN/);
      expect(await pgError(one.execute(sql.raw("ROLLBACK WORK AND CHAIN")))).toMatch(/AND CHAIN/);
      expect(
        await pgError(one.transaction(async (tx) => tx.execute(sql.raw("select 1; commit and chain")))),
      ).toMatch(/AND CHAIN/);
      // AND NO CHAIN is the default and harmless; the pool still answers in scope afterwards
      expect(await approvalIds(one)).toEqual([ids.aliceApproval]);
    });
  });
});

describe("0313: the column guard on users updates (the #682 hard gate)", () => {
  it("`authenticate` may change sign-in state but never an identity column", async () => {
    const bumped = await runWithRlsSystem("authenticate", "test.sign-in", async () =>
      db.update(users).set({ failedLoginCount: 3 }).where(eq(users.id, ids.alice)).returning({ id: users.id }),
    );
    expect(bumped).toEqual([{ id: ids.alice }]);
    for (const set of [{ isAdmin: true }, { email: "x@rls.test" }, { username: "x" }, { costCenter: "cc-z" }, { disabledAt: new Date() }] as const) {
      const msg = await pgError(runWithRlsSystem("authenticate", "test.sign-in", async () => db.update(users).set(set).where(eq(users.id, ids.alice))));
      expect(msg).toMatch(/new row violates row-level security policy for table "users"/);
    }
    const [a] = await db.select({ n: users.failedLoginCount, cc: users.costCenter, adm: users.isAdmin }).from(users).where(eq(users.id, ids.alice));
    expect(a).toEqual({ n: 3, cc: "cc-a", adm: false });
  });

  it("a user may edit its own display name but not its email, cost centre or admin flag, and never another user", async () => {
    await runWithRlsPrincipal({ userId: ids.alice }, async () => {
      const own = await db.update(users).set({ displayName: "Alice A." }).where(eq(users.id, ids.alice)).returning({ id: users.id });
      expect(own).toEqual([{ id: ids.alice }]);
      for (const set of [{ email: "a2@rls.test" }, { costCenter: "cc-b" }, { isAdmin: true }] as const) {
        expect(await pgError(db.update(users).set(set).where(eq(users.id, ids.alice)))).toMatch(/row-level security policy for table "users"/);
      }
      const other = await db.update(users).set({ displayName: "pwned" }).where(eq(users.id, ids.bob)).returning({ id: users.id });
      expect(other).toEqual([]);
    });
  });
});

describe("the gateway hooks scope every authenticated request", () => {
  let app: ReturnType<typeof buildApp>;
  let restore: () => Promise<void>;
  let aliceAuth: { authorization: string };
  const PROBE_ROUTE = "GET /v1/__rls0234b2_probe";

  beforeAll(async () => {
    restore = await relaxStrictAdmissionForTest(db);
    // the probe is a test-only route a non-admin may reach (removed again in afterAll)
    NON_ADMIN_ROUTES.add(PROBE_ROUTE);
    app = buildApp(db, { bootstrapToken: BOOT });
    // a probe route with NO application filter at all: what it returns is exactly what RLS lets through
    app.get("/v1/__rls0234b2_probe", async () => ({ scope: currentRlsScope() ?? null, ids: await approvalIds(db) }));
    const k = await app.inject({ method: "POST", headers: { authorization: `Bearer ${BOOT}` }, url: `/v1/users/${ids.alice}/keys`, payload: { name: "rls0234b2" } });
    expect(k.statusCode).toBe(201);
    aliceAuth = { authorization: `Bearer ${k.json().token}` };
  }, 120_000);
  afterAll(async () => {
    NON_ADMIN_ROUTES.delete(PROBE_ROUTE);
    await app?.close();
    await restore?.();
  });

  it("alice's API key: the unfiltered probe returns her approval only, under her principal scope", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/__rls0234b2_probe", headers: { ...aliceAuth } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ scope: { kind: "principal", userId: ids.alice }, ids: [ids.aliceApproval] });
  });

  it("the bootstrap token resolves no user: the request runs unscoped, exactly as before batch 2", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/__rls0234b2_probe", headers: { authorization: `Bearer ${BOOT}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ scope: null, ids: [ids.aliceApproval, ids.bobApproval].sort() });
  });
});
