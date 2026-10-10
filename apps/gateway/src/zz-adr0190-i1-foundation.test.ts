/**
 * ADR-0190 (batch 6 item 3) I1 — the isolation FOUNDATION, on a real database
 * through the real app:
 *  - MIGRATION 0183 on a freshly migrated database: every table exists, the
 *    journal agrees with `when` order, the three shipped profiles are seeded as
 *    version 1 byte for byte with the shared bodies, and no new table has a
 *    column that could hold a secret.
 *  - THE INVARIANTS as CHECKs and guard triggers, each shown refusing its bad
 *    row: a digest that is not the body's SHA-256, immutable versions, one-step
 *    versioning, terminal retirement; an executor bound to a worker_runtime
 *    identity, backend-to-class limits (OpenShell never L2), the customer
 *    mapping, terminal revocation; append-only attestations and placements, the
 *    placement shapes and the no-fallback CHECK.
 *  - SECURE BY DEFAULT: the isolation settings read strict (column defaults and
 *    the stored row); relaxing one needs a `settings_relax` step-up (an API key
 *    cannot give one) and is audited as a relaxation; tightening needs nothing;
 *    lowering a raised floor back needs the step-up; the bounds hold in zod and
 *    in the database.
 *  - THE STUBS: every ADR-0190 route answers 501 under its auth class.
 *
 * Global state (M-068): settings changed here are restored to strict in a
 * `finally`; every row written to an isolation table is inside a transaction
 * that is always rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { and, auditLog, createDb, desc, eq, runMigrations, sql, type Db } from "@regulait/db";
import {
  canonicalExecutionProfile,
  executionProfileDigest,
  ISOLATION_ROUTES,
  ISOLATION_SETTING_COLUMNS,
  ISOLATION_STRICT_DEFAULTS,
  SHIPPED_EXECUTION_PROFILES,
  type IsolationSettingKey,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { routeAuthClass } from "./route-classes.js";
import { ROUTE_STABILITY, ROUTE_TAGS } from "./openapi-registry.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a190-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const BOOT_USER = "00000000-0000-0000-0000-000000000000";
const MIGRATION_WHEN = 1785118000000;
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

const NEW_TABLES = ["execution_profiles", "executors", "executor_attestations", "execution_placements"] as const;

const STRICT_SQL = sql`UPDATE org_settings SET isolation_enforcement = 'enforce',
  isolation_floor_public = 'user_space_kernel', isolation_floor_internal = 'user_space_kernel',
  isolation_floor_confidential = 'user_space_kernel', isolation_floor_regulated = 'microvm',
  isolation_floor_mcp_stdio = 'user_space_kernel', isolation_floor_engine_worker = 'user_space_kernel',
  executor_attestation_max_age_minutes = 120`;

/** one relaxed value per setting */
const RELAXED: Record<IsolationSettingKey, unknown> = {
  isolationEnforcement: "warn",
  isolationFloorPublic: "hardened_container",
  isolationFloorInternal: "hardened_container",
  isolationFloorConfidential: "hardened_container",
  isolationFloorRegulated: "user_space_kernel",
  isolationFloorMcpStdio: "hardened_container",
  isolationFloorEngineWorker: "hardened_container",
  executorAttestationMaxAgeMinutes: 1440,
};

function refusalText(e: unknown): string {
  return `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
}
async function expectRefused(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const e = await Promise.resolve(p).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, `the statement was refused (${pattern})`).not.toBeNull();
  expect(refusalText(e)).toMatch(pattern);
}
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

class RolledBack extends Error {}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      throw new RolledBack();
    })
    .catch((e: unknown) => {
      if (!(e instanceof RolledBack)) throw e;
    });
}
/** each refused statement runs in its own savepoint, so the transaction lives on */
const inSavepoint = (tx: Tx, stmt: ReturnType<typeof sql>) => tx.transaction((sp) => sp.execute(stmt));
const one = async <T>(tx: Tx, stmt: ReturnType<typeof sql>) => rows<T>(await tx.execute(stmt))[0]!;
const SPIFFE = (s: string) => `spiffe://example.org/regulait/test/${s}-${RUN}`;
const HEX = (c: string) => c.repeat(64);

let restoreMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, {
      email: `a190-${k}-${RUN}@example.com`,
      displayName: `a190 ${k} ${RUN}`,
      isAdmin,
    });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a190" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await db.execute(STRICT_SQL);
  await restoreMfa?.();
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------
describe("ADR-0190 migration 0183 on a freshly migrated database", () => {
  it("creates every table the slice names", async () => {
    const res = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    const have = new Set(rows<{ table_name: string }>(res).map((r) => r.table_name));
    for (const t of NEW_TABLES) expect(have.has(t), t).toBe(true);
  });

  it("is journalled in when-order with every other migration, and was applied", async () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const mine = journal.entries.find((e) => e.tag === "0183_isolation_execution_profiles")!;
    expect(mine).toMatchObject({ idx: 183, when: MIGRATION_WHEN });
    // journal order and `when` must agree, or drizzle silently skips later migrations
    const at = journal.entries.indexOf(mine);
    for (const e of journal.entries.slice(0, at)) expect(mine.when, e.tag).toBeGreaterThan(e.when);
    for (const e of journal.entries.slice(at + 1)) expect(e.when, e.tag).toBeGreaterThan(mine.when);
    const applied = await db.execute(sql`select max(created_at)::bigint as w from drizzle.__drizzle_migrations`);
    expect(Number(rows<{ w: string }>(applied)[0]!.w)).toBeGreaterThanOrEqual(MIGRATION_WHEN);
  });

  it("seeds the three shipped profiles as version 1, byte for byte with the shared bodies", async () => {
    const res = await db.execute(
      sql`select name, version, body, digest, min_class, shipped, retired_at from execution_profiles where shipped order by name`,
    );
    const seeded = rows<{ name: string; version: number; body: string; digest: string; min_class: string; shipped: boolean; retired_at: unknown }>(res);
    expect(seeded.map((r) => r.name)).toEqual(["engine-worker", "restricted", "restricted-microvm"]);
    for (const r of seeded) {
      const body = SHIPPED_EXECUTION_PROFILES[r.name as keyof typeof SHIPPED_EXECUTION_PROFILES];
      expect(r.body, r.name).toBe(canonicalExecutionProfile(body));
      expect(r.digest, r.name).toBe(executionProfileDigest(body));
      expect(r).toMatchObject({ version: 1, min_class: body.minClass, shipped: true, retired_at: null });
    }
  });

  it("every function it creates pins its search_path, and every guarded table refuses TRUNCATE", async () => {
    const fns = await db.execute(sql`
      select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('regulait_execution_profile_guard', 'regulait_executor_guard', 'regulait_refuse_truncate')`);
    const got = rows<{ proname: string; proconfig: string[] | null }>(fns);
    expect(got.map((f) => f.proname).sort()).toEqual(["regulait_execution_profile_guard", "regulait_executor_guard", "regulait_refuse_truncate"]);
    for (const f of got) expect(f.proconfig, f.proname).toContain("search_path=pg_catalog, public, pg_temp");
    for (const t of NEW_TABLES) {
      await inRolledBackTx(async (tx) => {
        await expectRefused(inSavepoint(tx, sql.raw(`TRUNCATE "${t}" CASCADE`)), new RegExp(`TRUNCATE refused`));
      });
    }
  });

  it("no new table has a column that could hold a secret", async () => {
    const res = await db.execute(sql`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name = any(${`{${NEW_TABLES.join(",")}}`}::text[])
         and column_name ~ '(secret|private|password|ciphertext|token|api_key|credential)'`);
    expect(rows(res)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 migration 0183's invariants refuse their bad rows", () => {
  const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
  /** a v1 body for a new profile name, with its canonical text and digest */
  const custom = (name: string, minClass: "hardened_container" | "user_space_kernel" | "microvm" = "user_space_kernel") => {
    const body = { ...structuredClone(restricted), name, minClass } as typeof restricted;
    return { text: canonicalExecutionProfile(body), digest: executionProfileDigest(body) };
  };

  it("execution_profiles: the digest is the body's SHA-256, versions are immutable and one step apart, retirement is terminal", async () => {
    await inRolledBackTx(async (tx) => {
      const name = `a190-p-${RUN}`;
      const v1 = custom(name);
      const v2 = custom(name, "microvm");
      const v3 = custom(name, "hardened_container");
      const l0Text = canonicalExecutionProfile({ ...structuredClone(restricted), name, minClass: "in_gateway" } as never);
      const l0 = { text: l0Text, digest: createHash("sha256").update(l0Text, "utf8").digest("hex") };
      const bad: Array<[ReturnType<typeof sql>, RegExp]> = [
        // a digest naming another body
        [
          sql`insert into execution_profiles (name, version, body, digest, min_class) values (${name}, 1, ${v1.text}, ${v2.digest}, 'user_space_kernel')`,
          /execution_profiles_digest_check/,
        ],
        // the columns must restate the body
        [
          sql`insert into execution_profiles (name, version, body, digest, min_class) values (${name}, 1, ${v1.text}, ${v1.digest}, 'microvm')`,
          /execution_profiles_body_check/,
        ],
        [
          sql`insert into execution_profiles (name, version, body, digest, min_class) values (${`${name}-x`}, 1, ${v1.text}, ${v1.digest}, 'user_space_kernel')`,
          /execution_profiles_body_check/,
        ],
        // never L0, even with a body that says so
        [
          sql`insert into execution_profiles (name, version, body, digest, min_class) values (${name}, 1, ${l0.text}, ${l0.digest}, 'in_gateway')`,
          /execution_profiles_min_class_check/,
        ],
        // versions start at 1 and move one step
        [
          sql`insert into execution_profiles (name, version, body, digest, min_class) values (${name}, 2, ${v1.text}, ${v1.digest}, 'user_space_kernel')`,
          /must be version 1/,
        ],
        // a shipped profile is not re-seeded at version 1
        [
          sql`insert into execution_profiles (name, version, body, digest, min_class) values ('restricted', 1, ${canonicalExecutionProfile(restricted)}, ${executionProfileDigest(restricted)}, 'user_space_kernel')`,
          /must be version 2/,
        ],
        // created live
        [
          sql`insert into execution_profiles (name, version, body, digest, min_class, retired_at) values (${name}, 1, ${v1.text}, ${v1.digest}, 'user_space_kernel', now())`,
          /created live/,
        ],
      ];
      for (const [stmt, pattern] of bad) await expectRefused(inSavepoint(tx, stmt), pattern);

      const p1 = await one<{ id: string }>(
        tx,
        sql`insert into execution_profiles (name, version, body, digest, min_class, created_by) values (${name}, 1, ${v1.text}, ${v1.digest}, 'user_space_kernel', ${users.admin.id}) returning id`,
      );
      // an identical body is not a new version (the digest is unique)
      await expectRefused(
        inSavepoint(
          tx,
          sql`insert into execution_profiles (name, version, body, digest, min_class) values (${name}, 2, ${v1.text}, ${v1.digest}, 'user_space_kernel')`,
        ),
        /execution_profiles_digest_uq/,
      );
      await tx.execute(
        sql`insert into execution_profiles (name, version, body, digest, min_class) values (${name}, 2, ${v2.text}, ${v2.digest}, 'microvm')`,
      );
      for (const [stmt, pattern] of [
        [sql`update execution_profiles set body = ${v3.text}, digest = ${v3.digest}, min_class = 'hardened_container' where id = ${p1.id}`, /immutable/],
        [sql`update execution_profiles set min_class = 'microvm' where id = ${p1.id}`, /execution_profiles_body_check|immutable/],
        [sql`update execution_profiles set shipped = true where id = ${p1.id}`, /immutable/],
        [sql`update execution_profiles set created_by = ${users.member.id} where id = ${p1.id}`, /immutable/],
        [sql`delete from execution_profiles where id = ${p1.id}`, /never deleted/],
        [sql`update execution_profiles set retired_by = ${users.admin.id} where id = ${p1.id}`, /execution_profiles_retired_by_check|written with the retirement/],
      ] as const) {
        await expectRefused(inSavepoint(tx, stmt), pattern);
      }
      // retire the latest; then no new version of the name; retirement never moves
      await tx.execute(sql`update execution_profiles set retired_at = now(), retired_by = ${users.admin.id} where name = ${name} and version = 2`);
      await expectRefused(
        inSavepoint(
          tx,
          sql`insert into execution_profiles (name, version, body, digest, min_class) values (${name}, 3, ${v3.text}, ${v3.digest}, 'hardened_container')`,
        ),
        /is retired/,
      );
      await expectRefused(
        inSavepoint(tx, sql`update execution_profiles set retired_at = null where name = ${name} and version = 2`),
        /terminal/,
      );
      // the shipped rows are immutable too
      await expectRefused(inSavepoint(tx, sql`delete from execution_profiles where name = 'restricted'`), /never deleted/);
    });
  });

  /** a worker_runtime identity and the restricted digest, inside the rolled-back transaction */
  async function fixtures(tx: Tx) {
    const identity = await one<{ id: string }>(
      tx,
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('worker_runtime', ${SPIFFE("exec")}, ARRAY[${users.admin.id}]::uuid[]) returning id`,
    );
    const identity2 = await one<{ id: string }>(
      tx,
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('worker_runtime', ${SPIFFE("exec2")}, ARRAY[${users.admin.id}]::uuid[]) returning id`,
    );
    const pdp = await one<{ id: string }>(
      tx,
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('pdp', ${SPIFFE("pdp")}, ARRAY[${users.admin.id}]::uuid[]) returning id`,
    );
    const executor = await one<{ id: string }>(
      tx,
      sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
          values (${identity.id}, ${`a190-gv-${RUN}`}, 'gvisor', 'release-20261005.0', '["hardened_container", "user_space_kernel"]'::jsonb) returning id`,
    );
    return { identity, identity2, pdp, executor, digest: executionProfileDigest(restricted) };
  }

  it("executors: a worker_runtime identity, the classes its backend may attest, the customer mapping, terminal revocation", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      const ins = (identity: string, backend: string, classes: string, extra = sql``) =>
        sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared${extra})
            values (${identity}, ${`a190-x-${randomUUID().slice(0, 8)}`}, ${backend}, '1.0.0', ${classes}::jsonb)`;
      const bad: Array<[ReturnType<typeof sql>, RegExp]> = [
        [ins(f.pdp.id, "gvisor", '["user_space_kernel"]'), /worker_runtime identity/],
        [ins(f.identity.id, "gvisor", '["user_space_kernel"]'), /executors_workload_identity_uq/],
        // amendment F: OpenShell never attests L2; runc only L1; a customer plane only customer_declared
        [ins(f.identity2.id, "openshell", '["user_space_kernel"]'), /executors_classes_declared_check/],
        [ins(f.identity2.id, "runc", '["microvm"]'), /executors_classes_declared_check/],
        [ins(f.identity2.id, "customer", '["microvm"]'), /executors_classes_declared_check/],
        [ins(f.identity2.id, "gvisor", "[]"), /executors_classes_declared_check/],
        [ins(f.identity2.id, "firecracker", '["microvm"]'), /executors_backend_check/],
        [
          sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared, declared_class)
              values (${f.identity2.id}, 'a190-gvd', 'gvisor', '1', '["user_space_kernel"]'::jsonb, 'microvm')`,
          /executors_declared_class_check/,
        ],
        [
          sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared, status, quarantine_code, quarantined_at)
              values (${f.identity2.id}, 'a190-gvq', 'gvisor', '1', '["user_space_kernel"]'::jsonb, 'quarantined', 'admin', now())`,
          /registered active/,
        ],
        [sql`update executors set status = 'quarantined' where id = ${f.executor.id}`, /executors_quarantine_check/],
        [sql`update executors set backend = 'kata', classes_declared = '["microvm"]'::jsonb where id = ${f.executor.id}`, /immutable/],
        [sql`update executors set workload_identity_id = ${f.identity2.id} where id = ${f.executor.id}`, /immutable/],
        [sql`delete from executors where id = ${f.executor.id}`, /never deleted/],
      ];
      for (const [stmt, pattern] of bad) await expectRefused(inSavepoint(tx, stmt), pattern);
      // a customer plane starts mapped to nothing; an admin may map it
      const customer = await one<{ id: string; declared_class: string | null }>(
        tx,
        sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
            values (${f.identity2.id}, ${`a190-byoc-${RUN}`}, 'customer', 'plane-1', '["customer_declared"]'::jsonb) returning id, declared_class`,
      );
      expect(customer.declared_class).toBeNull();
      await tx.execute(sql`update executors set declared_class = 'user_space_kernel' where id = ${customer.id}`);
      // quarantine and re-enable; revocation is terminal
      await tx.execute(sql`update executors set status = 'quarantined', quarantine_code = 'execution_profile_mismatch', quarantined_at = now() where id = ${f.executor.id}`);
      await tx.execute(sql`update executors set status = 'active', quarantine_code = null, quarantined_at = null where id = ${f.executor.id}`);
      await tx.execute(sql`update executors set status = 'revoked' where id = ${f.executor.id}`);
      await expectRefused(inSavepoint(tx, sql`update executors set status = 'active' where id = ${f.executor.id}`), /never changed or reinstated/);
    });
  });

  it("executor_attestations: append-only, at most 24 h fresh, a known profile digest, no free-form verdict", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      const ins = (over: { digest?: string; cls?: string; verdict?: string; ttl?: string; sha?: string }) =>
        sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
            values (${f.executor.id}, ${over.digest ?? f.digest}, ${over.cls ?? "user_space_kernel"}, ${over.sha ?? HEX("a")}, '{"probes": {}}'::jsonb,
                    ${over.verdict ?? "pass"}, now(), now() + ${over.ttl ?? "2 hours"}::interval)`;
      for (const [stmt, pattern] of [
        [ins({ digest: HEX("0") }), /executor_attestations_profile_digest|foreign key/],
        [ins({ cls: "in_gateway" }), /executor_attestations_class_check/],
        [ins({ verdict: "maybe" }), /executor_attestations_verdict_check/],
        [ins({ ttl: "25 hours" }), /executor_attestations_expiry_check/],
        [ins({ ttl: "-1 minute" }), /executor_attestations_expiry_check/],
        [ins({ sha: "not-a-hash" }), /executor_attestations_report_sha256_check/],
      ] as const) {
        await expectRefused(inSavepoint(tx, stmt), pattern);
      }
      const a = await one<{ id: string }>(tx, sql`${ins({})} returning id`);
      await expectRefused(inSavepoint(tx, sql`update executor_attestations set verdict = 'fail' where id = ${a.id}`), /executor_attestations is append-only/);
      await expectRefused(inSavepoint(tx, sql`delete from executor_attestations where id = ${a.id}`), /executor_attestations is append-only/);
    });
  });

  it("execution_placements: append-only; a refusal starts nothing; a placement is never below its requirement under enforce", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      const ins = (v: {
        outcome: string;
        required?: string;
        applied?: string | null;
        executor?: string | null;
        sha?: string | null;
        code?: string | null;
        enforcement?: string;
        kind?: string;
      }) =>
        sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, executor_id, applied_class, report_sha256, outcome, refusal_code)
            values (${randomUUID()}, ${v.kind ?? "mcp_stdio"}, ${v.required ?? "user_space_kernel"}, 'data_sensitivity', ${v.enforcement ?? "enforce"}, ${f.digest},
                    ${v.executor === undefined ? f.executor.id : v.executor}, ${v.applied === undefined ? "user_space_kernel" : v.applied},
                    ${v.sha === undefined ? HEX("b") : v.sha}, ${v.outcome}, ${v.code ?? null})`;
      const refusedOk = { outcome: "refused", executor: null, applied: null, sha: null, code: "class_below_required" };
      for (const [stmt, pattern] of [
        // the no-fallback invariant: an L3 requirement is never placed on L2 under enforce
        [ins({ outcome: "placed", required: "microvm", applied: "user_space_kernel" }), /execution_placements_no_fallback_check/],
        // a refusal names no executor, class or report
        [ins({ ...refusedOk, executor: f.executor.id }), /execution_placements_shape_check/],
        [ins({ ...refusedOk, code: null }), /execution_placements_shape_check/],
        [ins({ outcome: "placed", sha: null }), /execution_placements_shape_check/],
        [ins({ outcome: "mismatch", code: "no_executor" }), /execution_placements_shape_check/],
        // L0 kinds are never placed; L0 is never required
        [ins({ outcome: "placed", kind: "model_call" }), /execution_placements_workload_kind_check/],
        [ins({ outcome: "placed", required: "in_gateway" }), /execution_placements_required_class_check/],
        [ins({ ...refusedOk, code: "fallback" }), /execution_placements_refusal_code_check/],
      ] as const) {
        await expectRefused(inSavepoint(tx, stmt), pattern);
      }
      await tx.execute(ins(refusedOk));
      await tx.execute(ins({ outcome: "placed", required: "user_space_kernel", applied: "microvm" }));
      await tx.execute(ins({ outcome: "mismatch", applied: null, code: "execution_profile_mismatch" }));
      // warn mode records the shortfall instead of refusing (decision 11's relaxation)
      const warned = await one<{ id: string }>(
        tx,
        sql`${ins({ outcome: "placed", required: "microvm", applied: "user_space_kernel", enforcement: "warn" })} returning id`,
      );
      await expectRefused(inSavepoint(tx, sql`update execution_placements set enforcement = 'enforce' where id = ${warned.id}`), /execution_placements is append-only/);
      await expectRefused(inSavepoint(tx, sql`delete from execution_placements where id = ${warned.id}`), /execution_placements is append-only/);
    });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 secure by default: the isolation org settings", () => {
  it("a freshly migrated org reads every isolation setting strict — the column defaults and the stored row", async () => {
    const res = await db.execute(sql`
      select column_name, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'org_settings'`);
    const defaults = new Map(
      rows<{ column_name: string; column_default: string | null }>(res).map((r) => [r.column_name, r.column_default ?? ""]),
    );
    const g = await inject("GET", "/v1/org/settings", users.admin.auth);
    expect(g.statusCode, g.body).toBe(200);
    const settings = g.json().settings as Record<string, unknown>;
    for (const [key, strict] of Object.entries(ISOLATION_STRICT_DEFAULTS)) {
      expect(settings[key], key).toEqual(strict);
      const def = defaults.get(ISOLATION_SETTING_COLUMNS[key as IsolationSettingKey]);
      expect(def, key).toBe(typeof strict === "number" ? String(strict) : `'${strict}'::text`);
    }
  });

  it("each relaxation round-trips and is audited as a relaxation; strict comes back", async () => {
    try {
      for (const [key, value] of Object.entries(RELAXED)) {
        const put = await inject("PUT", "/v1/org/settings", AUTH, { [key]: value });
        expect(put.statusCode, `${key}: ${put.body}`).toBe(200);
        expect(put.json().settings[key], key).toEqual(value);
        const [row] = await db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.ruleId, "org-settings-updated"), eq(auditLog.userId, BOOT_USER)))
          .orderBy(desc(auditLog.seq))
          .limit(1);
        const detail = row!.detail as { transitions: Record<string, unknown>; relaxed?: string[] };
        expect(detail.transitions[key], key).toEqual({ from: ISOLATION_STRICT_DEFAULTS[key as IsolationSettingKey], to: value });
        expect(detail.relaxed, key).toEqual([key]);
      }
    } finally {
      const back = await inject("PUT", "/v1/org/settings", AUTH, { ...ISOLATION_STRICT_DEFAULTS });
      expect(back.statusCode, back.body).toBe(200);
    }
  });

  it("relaxing needs a settings_relax step-up an API key cannot give; tightening needs nothing; the stored value counts", async () => {
    try {
      for (const [key, value] of Object.entries(RELAXED)) {
        const r = await inject("PUT", "/v1/org/settings", users.admin.auth, { [key]: value });
        expect(r.statusCode, `${key}: ${r.body}`).toBe(403);
        expect(r.json(), key).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
      }
      // tightening: every floor to L3, a shorter attestation lifetime
      const tighter = await inject("PUT", "/v1/org/settings", users.admin.auth, {
        isolationFloorPublic: "microvm",
        isolationFloorMcpStdio: "microvm",
        executorAttestationMaxAgeMinutes: 60,
      });
      expect(tighter.statusCode, tighter.body).toBe(200);
      // back to the defaults is now looser than what is stored: each needs the step-up
      for (const body of [
        { isolationFloorPublic: "user_space_kernel" },
        { isolationFloorMcpStdio: "user_space_kernel" },
        { executorAttestationMaxAgeMinutes: 120 },
      ]) {
        const r = await inject("PUT", "/v1/org/settings", users.admin.auth, body);
        expect(r.statusCode, `${JSON.stringify(body)}: ${r.body}`).toBe(403);
      }
    } finally {
      await db.execute(STRICT_SQL);
    }
  });

  it("refuses a value outside its bounds (400); the database holds the same bounds", async () => {
    for (const body of [
      { isolationEnforcement: "off" },
      { isolationFloorPublic: "in_gateway" },
      { isolationFloorRegulated: "customer_declared" },
      { executorAttestationMaxAgeMinutes: 59 },
      { executorAttestationMaxAgeMinutes: 1441 },
    ]) {
      const r = await inject("PUT", "/v1/org/settings", AUTH, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    for (const [stmt, constraint] of [
      [sql`UPDATE org_settings SET isolation_enforcement = 'off'`, "org_settings_isolation_enforcement_check"],
      [sql`UPDATE org_settings SET isolation_floor_regulated = 'in_gateway'`, "org_settings_isolation_floors_check"],
      [sql`UPDATE org_settings SET isolation_floor_mcp_stdio = 'in_gateway'`, "org_settings_isolation_floors_check"],
      [sql`UPDATE org_settings SET executor_attestation_max_age_minutes = 1441`, "org_settings_executor_attestation_max_age_minutes_check"],
    ] as const) {
      await expectRefused(db.execute(stmt), new RegExp(constraint));
    }
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 the stubs: every route answers 501 under its auth class", () => {
  const url = (p: string) => p.replace(/:[A-Za-z]+/g, () => randomUUID());

  it("the route classes, stability and tags agree with ISOLATION_ROUTES", () => {
    for (const r of ISOLATION_ROUTES) {
      const key = `${r.method} ${r.path}`;
      expect(routeAuthClass(r.method, r.path), key).toBe(r.cls);
      expect(ROUTE_STABILITY[key], key).toBe("internal");
      expect(ROUTE_TAGS[key], key).toBe("isolation");
    }
    const tagged = Object.entries(ROUTE_TAGS)
      .filter(([, t]) => t === "isolation")
      .map(([k]) => k)
      .sort();
    expect(tagged).toEqual(ISOLATION_ROUTES.map((r) => `${r.method} ${r.path}`).sort());
  });

  it("each route not yet built is registered and answers 501 not_built to an admin, touching nothing", async () => {
    const before = await db.execute(sql`select (select count(*) from execution_profiles) as p, (select count(*) from executors) as e`);
    // I3 built the executor routes (zz-adr0190-i3-executor-core.test.ts covers them); the rest are still stubs
    for (const r of ISOLATION_ROUTES.filter((r) => !r.built)) {
      const res = await inject(r.method, url(r.path), users.admin.auth, r.method === "GET" ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.path}: ${res.body}`).toBe(501);
      expect(res.json(), `${r.method} ${r.path}`).toEqual({ error: "not_built" });
    }
    const after = await db.execute(sql`select (select count(*) from execution_profiles) as p, (select count(*) from executors) as e`);
    expect(rows(after)).toEqual(rows(before));
  });

  it("401 with no credential and 403 for a non-admin", async () => {
    for (const r of ISOLATION_ROUTES) {
      const body = r.method === "GET" ? undefined : {};
      const anon = await inject(r.method, url(r.path), {}, body);
      expect(anon.statusCode, `${r.method} ${r.path} (anonymous)`).toBe(401);
      const member = await inject(r.method, url(r.path), users.member.auth, body);
      expect(member.statusCode, `${r.method} ${r.path} (member)`).toBe(403);
    }
  });
});
