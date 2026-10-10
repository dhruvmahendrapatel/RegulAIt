/**
 * ADR-0188 (batch 6 item 1) S1 — the identity FOUNDATION, on a real database
 * through the real app:
 *  - MIGRATION 0180 on a freshly migrated database: every table exists, the
 *    journal entry is past every other `when`, the existing org row requires
 *    the new `identity_manage` step-up kind, and no new table has a column that
 *    could hold a secret.
 *  - SECURE BY DEFAULT: the six identity settings read strict (column defaults
 *    and stored row); relaxing one needs a `settings_relax` step-up (an API key
 *    cannot give one) and is audited as a relaxation; tightening needs nothing;
 *    the bounds hold in zod and in the database.
 *  - THE INVARIANTS as CHECKs, uniques and guard triggers, each shown refusing
 *    its bad row (public-key-only credentials, one identity per subject,
 *    terminal revocation, path/depth/root consistency with the parent row,
 *    immutable chain context, subset lifetime and cap, non-negative balances,
 *    once-only edge release, once-only settlement, sender-bound tokens only,
 *    atomic replay claims, an append-only v2 boundary, the audit actor fields).
 *  - THE AUDIT WRITER: actor fields are refused before a v2 boundary exists,
 *    and a row at/after the boundary is written as v2 with its version hashed.
 *  - THE STUBS: every ADR-0188 route answers 501 under its auth class (401
 *    with no credential, 403 for a non-admin on an admin route), and the route
 *    classes, stability and tag registries agree with `IDENTITY_ROUTES`.
 *
 * Global state (M-068): the settings relaxed here are restored to strict in a
 * `finally`; every row written to an identity table is inside a transaction
 * that is always rolled back (most of them cannot be deleted, by design).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, auditLog, createDb, desc, eq, orgSettings, ORG_SETTINGS_ID, runMigrations, sql, type Db } from "@regulait/db";
import {
  auditContentHashFor,
  IDENTITY_ROUTES,
  IDENTITY_SETTING_COLUMNS,
  IDENTITY_STRICT_DEFAULTS,
  type IdentitySettingKey,
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
const BOOT = `a188-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const BOOT_USER = "00000000-0000-0000-0000-000000000000";
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

const NEW_TABLES = [
  "workload_identities",
  "identity_tool_grants",
  "identity_server_grants",
  "identity_agent_grants",
  "identity_connector_grants",
  "identity_role_assignments",
  "workload_credentials",
  "identity_signing_keys",
  "delegation_grants",
  "delegation_allocations",
  "delegation_charges",
  "issued_tokens",
  "replay_claims",
  "audit_chain_versions",
] as const;

const STRICT_SQL = sql`UPDATE org_settings SET agent_entitlement_mode = 'own_grants', delegated_token_ttl_seconds = 300,
  delegation_max_depth = 3,
  workload_client_auth_methods = '["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid"]'::jsonb,
  dpop_nonce_required = true, workload_key_max_age_days = 90`;

/** one relaxed value per setting that has a looser value than its default */
const RELAXED: Partial<Record<IdentitySettingKey, unknown>> = {
  agentEntitlementMode: "sponsor_only",
  delegatedTokenTtlSeconds: 3600,
  delegationMaxDepth: 8,
  dpopNonceRequired: false,
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

const X = (c: string) => c.repeat(43);
const JWK = (x: string) => JSON.stringify({ kty: "OKP", crv: "Ed25519", x });
const SPIFFE = (s: string) => `spiffe://example.org/regulait/test/${s}-${RUN}`;

let restoreMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, {
      email: `a188-${k}-${RUN}@example.com`,
      displayName: `a188 ${k} ${RUN}`,
      isAdmin,
    });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a188" })).json().token as string;
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
describe("ADR-0188 migration 0180 on a freshly migrated database", () => {
  it("creates every table the slice names", async () => {
    const res = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    const have = new Set(rows<{ table_name: string }>(res).map((r) => r.table_name));
    for (const t of NEW_TABLES) expect(have.has(t), t).toBe(true);
  });

  it("is journalled past every earlier migration, every later one is past it, and past 0175 + 4,000,000", async () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const mine = journal.entries.find((e) => e.tag === "0180_agent_workload_identity")!;
    expect(mine).toMatchObject({ idx: 180, when: 1785115000000 });
    // journal order and `when` must agree, or drizzle silently skips later migrations
    const at = journal.entries.indexOf(mine);
    for (const e of journal.entries.slice(0, at)) expect(mine.when).toBeGreaterThan(e.when);
    for (const e of journal.entries.slice(at + 1)) expect(e.when).toBeGreaterThan(mine.when);
    expect(mine.when).toBeGreaterThan(journal.entries.find((e) => e.tag.startsWith("0175_"))!.when + 4_000_000);
    const applied = await db.execute(sql`select max(created_at)::bigint as w from drizzle.__drizzle_migrations`);
    expect(Number(rows<{ w: string }>(applied)[0]!.w)).toBeGreaterThanOrEqual(1785115000000);
  });

  it("the existing org row requires the identity_manage step-up (first load, no grandfathering)", async () => {
    const [org] = await db.select({ a: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(org!.a).toContain("identity_manage");
    for (const c of ["step_up_grants_action_kind_check", "webauthn_challenges_action_kind_check", "org_settings_step_up_actions_check"]) {
      const def = await db.execute(sql`select pg_get_constraintdef(oid) as d from pg_constraint where conname = ${c}`);
      expect(rows<{ d: string }>(def)[0]!.d, c).toContain("identity_manage");
    }
  });

  it("no new table has a column that could hold a secret (public halves only)", async () => {
    const res = await db.execute(sql`
      select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name = any(${`{${NEW_TABLES.join(",")}}`}::text[])
         and column_name ~ '(secret|private|password|ciphertext|token_hash|api_key)'`);
    expect(rows(res)).toEqual([]);
  });

  it("mcp_servers start with no identity sent upstream (OWNER DECISION 6)", async () => {
    const res = await db.execute(sql`
      select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'mcp_servers' and column_name = 'identity_propagation'`);
    expect(rows<{ column_default: string }>(res)[0]!.column_default).toBe("'none'::text");
    await inRolledBackTx(async (tx) => {
      const srv = await one<{ id: string; identity_propagation: string }>(
        tx,
        sql`insert into mcp_servers (name, url) values (${`a188-ip-${RUN}`}, 'http://127.0.0.1:9/mcp') returning id, identity_propagation`,
      );
      expect(srv.identity_propagation).toBe("none");
      await expectRefused(
        inSavepoint(tx, sql`UPDATE mcp_servers SET identity_propagation = 'full_profile' WHERE id = ${srv.id}`),
        /mcp_servers_identity_propagation_check/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 secure by default: the identity org settings", () => {
  it("a freshly migrated org reads every identity setting strict — the column defaults and the stored row", async () => {
    const res = await db.execute(sql`
      select column_name, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'org_settings'`);
    const defaults = new Map(
      rows<{ column_name: string; column_default: string | null }>(res).map((r) => [r.column_name, r.column_default ?? ""]),
    );
    const g = await inject("GET", "/v1/org/settings", users.admin.auth);
    expect(g.statusCode, g.body).toBe(200);
    const settings = g.json().settings as Record<string, unknown>;
    for (const [key, strict] of Object.entries(IDENTITY_STRICT_DEFAULTS)) {
      expect(settings[key], key).toEqual(strict);
      const def = defaults.get(IDENTITY_SETTING_COLUMNS[key as IdentitySettingKey]);
      expect(def, key).toBeDefined();
      if (typeof strict === "number" || typeof strict === "boolean") expect(def, key).toBe(String(strict));
      else if (typeof strict === "string") expect(def, key).toBe(`'${strict}'::text`);
      else expect(JSON.parse(def!.replace(/^'/, "").replace(/'::jsonb$/, "")), key).toEqual(strict);
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
        expect(detail.transitions[key], key).toEqual({ from: IDENTITY_STRICT_DEFAULTS[key as IdentitySettingKey], to: value });
        expect(detail.relaxed, key).toEqual([key]);
      }
    } finally {
      const back = await inject("PUT", "/v1/org/settings", AUTH, { ...IDENTITY_STRICT_DEFAULTS });
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
      // tightening: fewer methods, a shorter key age, a shorter token, a shallower chain
      const tighter = await inject("PUT", "/v1/org/settings", users.admin.auth, {
        workloadClientAuthMethods: ["private_key_jwt"],
        workloadKeyMaxAgeDays: 30,
        delegatedTokenTtlSeconds: 120,
        delegationMaxDepth: 1,
      });
      expect(tighter.statusCode, tighter.body).toBe(200);
      // back towards the defaults is now looser than what is stored: each needs the step-up
      for (const body of [
        { workloadClientAuthMethods: ["private_key_jwt", "spiffe_svid"] },
        { workloadKeyMaxAgeDays: 90 },
        { delegatedTokenTtlSeconds: 300 },
        { delegationMaxDepth: 3 },
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
      { agentEntitlementMode: "union" },
      { delegatedTokenTtlSeconds: 59 },
      { delegatedTokenTtlSeconds: 3601 },
      { delegationMaxDepth: -1 },
      { delegationMaxDepth: 9 },
      { workloadClientAuthMethods: ["client_secret_basic"] },
      { workloadKeyMaxAgeDays: 0 },
      { workloadKeyMaxAgeDays: 91 },
    ]) {
      const r = await inject("PUT", "/v1/org/settings", AUTH, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    for (const [stmt, constraint] of [
      [sql`UPDATE org_settings SET agent_entitlement_mode = 'union'`, "org_settings_agent_entitlement_mode_check"],
      [sql`UPDATE org_settings SET delegated_token_ttl_seconds = 3601`, "org_settings_delegated_token_ttl_seconds_check"],
      [sql`UPDATE org_settings SET delegation_max_depth = 9`, "org_settings_delegation_max_depth_check"],
      [
        sql`UPDATE org_settings SET workload_client_auth_methods = '["client_secret_post"]'::jsonb`,
        "org_settings_workload_client_auth_methods_check",
      ],
      [sql`UPDATE org_settings SET workload_key_max_age_days = 91`, "org_settings_workload_key_max_age_days_check"],
      [sql`UPDATE org_settings SET step_up_actions = '["sudo"]'::jsonb`, "org_settings_step_up_actions_check"],
    ] as const) {
      await expectRefused(db.execute(stmt), new RegExp(constraint));
    }
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 migration 0180's invariants refuse their bad rows", () => {
  /** the subjects an identity can name, made inside the rolled-back transaction */
  async function fixtures(tx: Tx) {
    const agent = await one<{ id: string }>(
      tx,
      sql`insert into agents (name, provider, tier) values (${`a188-agent-${RUN}`}, 'mock', 1) returning id`,
    );
    const agent2 = await one<{ id: string }>(
      tx,
      sql`insert into agents (name, provider, tier) values (${`a188-agent2-${RUN}`}, 'mock', 1) returning id`,
    );
    const project = await one<{ id: string }>(tx, sql`insert into projects (name) values (${`a188-proj-${RUN}`}) returning id`);
    const project2 = await one<{ id: string }>(tx, sql`insert into projects (name) values (${`a188-proj2-${RUN}`}) returning id`);
    const server = await one<{ id: string }>(
      tx,
      sql`insert into mcp_servers (name, url) values (${`a188-srv-${RUN}`}, 'http://127.0.0.1:9/mcp') returning id`,
    );
    const connector = await one<{ id: string }>(
      tx,
      sql`insert into connectors (name, kind) values (${`a188-conn-${RUN}`}, 'crm') returning id`,
    );
    const role = await one<{ id: string }>(tx, sql`insert into roles (name) values (${`a188-role-${RUN}`}) returning id`);
    const identity = await one<{ id: string }>(
      tx,
      sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
          values ('agent', ${agent.id}, ${SPIFFE("a")}, ARRAY[${users.admin.id}]::uuid[], ARRAY['dev']) returning id`,
    );
    const identity2 = await one<{ id: string }>(
      tx,
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids)
          values ('worker_runtime', ${SPIFFE("w")}, ARRAY[${users.admin.id}]::uuid[]) returning id`,
    );
    const cred = await one<{ id: string }>(
      tx,
      sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, not_after)
          values (${identity2.id}, 'jwk', ${JWK(X("B"))}::jsonb, ${X("c")}, now() + interval '30 days') returning id`,
    );
    return { agent, agent2, project, project2, server, connector, role, identity, identity2, cred };
  }
  type F = Awaited<ReturnType<typeof fixtures>>;

  /** a root grant (in-process) */
  const rootGrant = (f: F, id: string, extra: { cap?: number | null; expires?: string } = {}) =>
    sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, project_id, scope,
          cap_micros, environment, binding_kind, expires_at)
        values (${id}, ${id}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity.id}, ${f.project.id}, '[]'::jsonb,
          ${extra.cap === undefined ? 100_000_000 : extra.cap}, 'dev', 'in_process', now() + ${extra.expires ?? "1 hour"}::interval)`;
  const childGrant = (
    f: F,
    id: string,
    parent: string,
    o: { path?: string; depth?: number; root?: string; sponsor?: string; project?: string; env?: string; expires?: string; cap?: number | null } = {},
  ) =>
    sql`insert into delegation_grants (id, root_grant_id, parent_grant_id, path, depth, sponsor_user_id, actor_identity_id,
          project_id, scope, cap_micros, environment, binding_kind, expires_at)
        values (${id}, ${o.root ?? parent}, ${parent}, ${o.path ?? `{${parent}}`}::uuid[], ${o.depth ?? 1},
          ${o.sponsor ?? users.admin.id}, ${f.identity2.id}, ${o.project ?? f.project.id}, '[]'::jsonb,
          ${o.cap === undefined ? 10_000_000 : o.cap}, ${o.env ?? "dev"}, 'in_process', now() + ${o.expires ?? "30 minutes"}::interval)`;

  it("workload_identities: exactly its subject, a SPIFFE identifier, stewards, one per subject, terminal revocation", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      const bad: Array<[ReturnType<typeof sql>, RegExp]> = [
        [
          sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('agent', ${SPIFFE("x1")}, ARRAY[${users.admin.id}]::uuid[])`,
          /workload_identities_subject_check/,
        ],
        [
          sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids) values ('pdp', ${f.agent2.id}, ${SPIFFE("x2")}, ARRAY[${users.admin.id}]::uuid[])`,
          /workload_identities_subject_check/,
        ],
        [
          sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('pdp', 'https://example.org/agent', ARRAY[${users.admin.id}]::uuid[])`,
          /workload_identities_identifier_check/,
        ],
        [
          sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('pdp', 'spiffe://example.org/a/../b', ARRAY[${users.admin.id}]::uuid[])`,
          /workload_identities_identifier_check/,
        ],
        [
          sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('pdp', ${SPIFFE("x3")}, '{}'::uuid[])`,
          /workload_identities_sponsors_check/,
        ],
        [
          sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments) values ('pdp', ${SPIFFE("x4")}, ARRAY[${users.admin.id}]::uuid[], ARRAY['Prod!'])`,
          /workload_identities_environments_check/,
        ],
        [
          sql`insert into workload_identities (kind, identifier, sponsor_user_ids, status) values ('pdp', ${SPIFFE("x5")}, ARRAY[${users.admin.id}]::uuid[], 'paused')`,
          /workload_identities_status_check/,
        ],
        [
          sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('robot', ${SPIFFE("x6")}, ARRAY[${users.admin.id}]::uuid[])`,
          /workload_identities_kind_check/,
        ],
        [
          sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids) values ('agent', ${f.agent.id}, ${SPIFFE("x7")}, ARRAY[${users.admin.id}]::uuid[])`,
          /workload_identities_agent_uq/,
        ],
        [
          sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('pdp', ${SPIFFE("a")}, ARRAY[${users.admin.id}]::uuid[])`,
          /workload_identities_identifier_uq/,
        ],
        [sql`update workload_identities set identifier = ${SPIFFE("moved")} where id = ${f.identity.id}`, /immutable/],
        [sql`update workload_identities set agent_id = ${f.agent2.id} where id = ${f.identity.id}`, /immutable/],
        [sql`delete from workload_identities where id = ${f.identity.id}`, /never deleted/],
      ];
      for (const [stmt, pattern] of bad) await expectRefused(inSavepoint(tx, stmt), pattern);
      // suspend and reinstate are fine; revocation is terminal
      await tx.execute(sql`update workload_identities set status = 'suspended' where id = ${f.identity.id}`);
      await tx.execute(sql`update workload_identities set status = 'active' where id = ${f.identity.id}`);
      await tx.execute(sql`update workload_identities set status = 'revoked' where id = ${f.identity.id}`);
      await expectRefused(
        inSavepoint(tx, sql`update workload_identities set status = 'active' where id = ${f.identity.id}`),
        /never reinstated/,
      );
    });
  });

  it("an agent's own grants: default-deny tables keyed by identity, modes and objects required, one row per object", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      // an identity starts with nothing
      for (const t of ["identity_tool_grants", "identity_server_grants", "identity_agent_grants", "identity_connector_grants", "identity_role_assignments"]) {
        const n = await one<{ n: number }>(tx, sql`select count(*)::int as n from ${sql.identifier(t)} where identity_id = ${f.identity.id}`);
        expect(n.n, t).toBe(0);
      }
      await tx.execute(sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${f.identity.id}, ${f.server.id}, 'read_file')`);
      await tx.execute(sql`insert into identity_server_grants (identity_id, server_id) values (${f.identity.id}, ${f.server.id})`);
      await tx.execute(sql`insert into identity_agent_grants (identity_id, agent_id, allowed_modes) values (${f.identity.id}, ${f.agent2.id}, '["chat"]'::jsonb)`);
      await tx.execute(
        sql`insert into identity_connector_grants (identity_id, connector_id, mode, allowed_objects) values (${f.identity.id}, ${f.connector.id}, 'read', '[]'::jsonb)`,
      );
      await tx.execute(sql`insert into identity_role_assignments (identity_id, role_id) values (${f.identity.id}, ${f.role.id})`);
      const bad: Array<[ReturnType<typeof sql>, RegExp]> = [
        [
          sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${f.identity.id}, ${f.server.id}, 'read_file')`,
          /identity_tool_grants_identity_server_tool_uq/,
        ],
        [sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${f.identity.id}, ${f.server.id}, '')`, /identity_tool_grants_tool_name_check/],
        [sql`insert into identity_server_grants (identity_id, server_id) values (${f.identity.id}, ${f.server.id})`, /identity_server_grants_identity_server_uq/],
        [
          sql`insert into identity_agent_grants (identity_id, agent_id, allowed_modes) values (${f.identity2.id}, ${f.agent2.id}, NULL)`,
          /allowed_modes.*not-null|null value in column "allowed_modes"/,
        ],
        [
          sql`insert into identity_agent_grants (identity_id, agent_id, allowed_modes) values (${f.identity2.id}, ${f.agent2.id}, '"chat"'::jsonb)`,
          /identity_agent_grants_allowed_modes_check/,
        ],
        [
          sql`insert into identity_connector_grants (identity_id, connector_id, mode, allowed_objects) values (${f.identity2.id}, ${f.connector.id}, 'admin', '[]'::jsonb)`,
          /identity_connector_grants_mode_check/,
        ],
        [
          sql`insert into identity_connector_grants (identity_id, connector_id, mode, allowed_objects) values (${f.identity2.id}, ${f.connector.id}, 'read', NULL)`,
          /null value in column "allowed_objects"/,
        ],
        [sql`insert into identity_role_assignments (identity_id, role_id) values (${f.identity.id}, ${f.role.id})`, /identity_role_assignments_identity_role_uq/],
        [
          sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${randomUUID()}, ${f.server.id}, 'x')`,
          /foreign key/,
        ],
      ];
      for (const [stmt, pattern] of bad) await expectRefused(inSavepoint(tx, stmt), pattern);
    });
  });

  it("workload_credentials: public halves only, one shape per kind, at most 90 days, revocation never undone", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      const ins = (cols: ReturnType<typeof sql>) =>
        sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, x5t_s256, spiffe_id, not_after) values ${cols}`;
      const bad: Array<[ReturnType<typeof sql>, RegExp]> = [
        // a private member, an RSA key, a symmetric key
        [
          ins(sql`(${f.identity.id}, 'jwk', ${JSON.stringify({ kty: "OKP", crv: "Ed25519", x: X("D"), d: X("E") })}::jsonb, ${X("d")}, NULL, NULL, now() + interval '1 day')`),
          /workload_credentials_public_only_check/,
        ],
        [
          ins(sql`(${f.identity.id}, 'jwk', ${JSON.stringify({ kty: "RSA", n: X("N"), e: "AQAB" })}::jsonb, ${X("e")}, NULL, NULL, now() + interval '1 day')`),
          /workload_credentials_public_only_check/,
        ],
        [
          ins(sql`(${f.identity.id}, 'jwk', ${JSON.stringify({ kty: "oct", k: X("K") })}::jsonb, ${X("f")}, NULL, NULL, now() + interval '1 day')`),
          /workload_credentials_public_only_check/,
        ],
        // a jwk row carrying a SPIFFE id; a spiffe row with no id
        [
          ins(sql`(${f.identity.id}, 'jwk', ${JWK(X("G"))}::jsonb, ${X("g")}, NULL, ${SPIFFE("s")}, now() + interval '1 day')`),
          /workload_credentials_shape_check/,
        ],
        [ins(sql`(${f.identity.id}, 'spiffe_id', NULL, NULL, NULL, NULL, now() + interval '1 day')`), /workload_credentials_shape_check/],
        [ins(sql`(${f.identity.id}, 'x509', NULL, NULL, 'not-a-thumbprint', NULL, now() + interval '1 day')`), /workload_credentials_x5t_check/],
        // longer than 90 days
        [
          ins(sql`(${f.identity.id}, 'jwk', ${JWK(X("H"))}::jsonb, ${X("h")}, NULL, NULL, now() + interval '91 days')`),
          /workload_credentials_window_check/,
        ],
        // the same key registered twice
        [
          ins(sql`(${f.identity.id}, 'jwk', ${JWK(X("B"))}::jsonb, ${X("c")}, NULL, NULL, now() + interval '1 day')`),
          /workload_credentials_jwk_thumbprint_uq/,
        ],
        [sql`update workload_credentials set jwk_thumbprint = ${X("z")} where id = ${f.cred.id}`, /only revoked_at/],
        [sql`update workload_credentials set not_after = not_after + interval '1 day' where id = ${f.cred.id}`, /only move earlier/],
        [sql`delete from workload_credentials where id = ${f.cred.id}`, /never deleted/],
      ];
      for (const [stmt, pattern] of bad) await expectRefused(inSavepoint(tx, stmt), pattern);
      // rotation (an earlier not_after) and revocation are allowed, revocation once
      await tx.execute(sql`update workload_credentials set not_after = not_after - interval '1 day' where id = ${f.cred.id}`);
      await tx.execute(sql`update workload_credentials set revoked_at = now() where id = ${f.cred.id}`);
      await expectRefused(inSavepoint(tx, sql`update workload_credentials set revoked_at = NULL where id = ${f.cred.id}`), /never revived/);
    });
  });

  it("identity_signing_keys: public Ed25519 only, one active signer, stamps written once, never deleted", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(
        sql`insert into identity_signing_keys (kid, public_jwk, activated_at) values (${`k1-${RUN}`}, ${JWK(X("P"))}::jsonb, now())`,
      );
      const bad: Array<[ReturnType<typeof sql>, RegExp]> = [
        [
          sql`insert into identity_signing_keys (kid, public_jwk) values (${`k2-${RUN}`}, ${JSON.stringify({ kty: "OKP", crv: "Ed25519", x: X("Q"), d: X("R") })}::jsonb)`,
          /identity_signing_keys_public_only_check/,
        ],
        [
          sql`insert into identity_signing_keys (kid, public_jwk) values (${`k3-${RUN}`}, ${JSON.stringify({ kty: "EC", crv: "P-256", x: X("S"), y: X("T") })}::jsonb)`,
          /identity_signing_keys_public_only_check/,
        ],
        [
          sql`insert into identity_signing_keys (kid, public_jwk, activated_at) values (${`k4-${RUN}`}, ${JWK(X("U"))}::jsonb, now())`,
          /identity_signing_keys_one_active_uq/,
        ],
        [sql`update identity_signing_keys set public_jwk = ${JWK(X("V"))}::jsonb where kid = ${`k1-${RUN}`}`, /written once/],
        [sql`delete from identity_signing_keys where kid = ${`k1-${RUN}`}`, /never deleted/],
      ];
      for (const [stmt, pattern] of bad) await expectRefused(inSavepoint(tx, stmt), pattern);
      await tx.execute(sql`update identity_signing_keys set revoked_at = now() where kid = ${`k1-${RUN}`}`);
      await expectRefused(inSavepoint(tx, sql`update identity_signing_keys set revoked_at = NULL where kid = ${`k1-${RUN}`}`), /written once/);
    });
  });

  it("delegation_grants: a child follows its parent row, never outlives or out-caps it; balances non-negative; changes only by revocation or spend", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      const root = randomUUID();
      await tx.execute(rootGrant(f, root));
      const child = randomUUID();
      await tx.execute(childGrant(f, child, root));
      const g = randomUUID();
      const bad: Array<[ReturnType<typeof sql>, RegExp]> = [
        // stored chain inconsistent with itself: the CHECKs (a parentless row reaches them directly) …
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
              values (${g}, ${g}, '{}'::uuid[], 1, ${users.admin.id}, ${f.identity.id}, '[]'::jsonb, 'dev', 'in_process', now() + interval '1 hour')`,
          /delegation_grants_depth_check/,
        ],
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
              values (${g}, ${g}, ARRAY[${root}]::uuid[], 1, ${users.admin.id}, ${f.identity.id}, '[]'::jsonb, 'dev', 'in_process', now() + interval '1 hour')`,
          /delegation_grants_parent_check/,
        ],
        // … and the guard trigger, which runs first for a row with a parent
        [childGrant(f, g, root, { depth: 2 }), /must follow the parent row/],
        [childGrant(f, g, root, { root: child }), /must follow the parent row/],
        [childGrant(f, g, root, { path: `{${child}}` }), /must follow the parent row/],
        // …or with the parent row (decision 17)
        [childGrant(f, g, child, { path: `{${child}}`, root: child }), /path, depth and root must follow the parent/],
        [childGrant(f, g, root, { sponsor: users.member.id }), /immutable down the chain/],
        [childGrant(f, g, root, { project: f.project2.id }), /immutable down the chain/],
        [childGrant(f, g, root, { env: "staging" }), /immutable down the chain/],
        [childGrant(f, g, root, { expires: "2 hours" }), /never outlives its parent/],
        [childGrant(f, g, root, { cap: 200_000_000 }), /no larger than its parent/],
        [childGrant(f, g, root, { cap: null }), /no larger than its parent/],
        [childGrant(f, g, randomUUID(), { path: `{${randomUUID()}}` }), /delegation_grants_parent_check|does not exist|foreign key/],
        // a root that names another root, a cycle, a negative cap, too deep
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
              values (${g}, ${root}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity.id}, '[]'::jsonb, 'dev', 'in_process', now() + interval '1 hour')`,
          /delegation_grants_parent_check/,
        ],
        [rootGrant(f, g, { cap: -1 }), /delegation_grants_balances_check/],
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at, run_id, schedule_id)
              values (${g}, ${g}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity.id}, '[]'::jsonb, 'dev', 'in_process', now() + interval '1 hour', ${randomUUID()}, ${randomUUID()})`,
          /delegation_grants_context_check/,
        ],
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
              values (${g}, ${g}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity.id}, '{}'::jsonb, 'dev', 'in_process', now() + interval '1 hour')`,
          /delegation_grants_scope_check/,
        ],
        // bindings: an external grant needs its credential, thumbprint and audience; in-process has none
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
              values (${g}, ${g}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity.id}, '[]'::jsonb, 'dev', 'dpop', now() + interval '1 hour')`,
          /delegation_grants_binding_check/,
        ],
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, binding_thumbprint, expires_at)
              values (${g}, ${g}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity.id}, '[]'::jsonb, 'dev', 'in_process', ${X("t")}, now() + interval '1 hour')`,
          /delegation_grants_binding_check/,
        ],
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
              values (${g}, ${g}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity.id}, '[]'::jsonb, 'dev', 'bearer', now() + interval '1 hour')`,
          /delegation_grants_binding_check/,
        ],
        [
          sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
              values (${g}, ${g}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity.id}, '[]'::jsonb, 'Prod!', 'in_process', now() + interval '1 hour')`,
          /delegation_grants_environment_check/,
        ],
        // balances and updates
        [sql`update delegation_grants set settled_micros = -1 where id = ${root}`, /delegation_grants_balances_check/],
        [sql`update delegation_grants set reserved_micros = 100000001 where id = ${root}`, /delegation_grants_balances_check/],
        [sql`update delegation_grants set scope = '[{"type":"agent"}]'::jsonb where id = ${child}`, /only by revocation or spend/],
        [sql`update delegation_grants set expires_at = expires_at + interval '1 day' where id = ${child}`, /only by revocation or spend/],
        [sql`update delegation_grants set revoked_at = now(), revoked_reason = 'because I said so' where id = ${child}`, /delegation_grants_revoked_check/],
        [sql`update delegation_grants set revoked_at = now() where id = ${child}`, /delegation_grants_revoked_check/],
        [sql`delete from delegation_grants where id = ${child}`, /never deleted/],
      ];
      for (const [stmt, pattern] of bad) await expectRefused(inSavepoint(tx, stmt), pattern);
      // spend and revocation are the allowed changes; a revocation is never undone
      await tx.execute(sql`update delegation_grants set reserved_micros = 10000000, settled_micros = 5 where id = ${root}`);
      await tx.execute(sql`update delegation_grants set revoked_at = now(), revoked_reason = 'cascade' where id = ${child}`);
      await expectRefused(
        inSavepoint(tx, sql`update delegation_grants set revoked_at = NULL, revoked_reason = NULL where id = ${child}`),
        /never undone/,
      );
      // the cascade query the GIN index serves
      const below = await one<{ n: number }>(tx, sql`select count(*)::int as n from delegation_grants where path @> ARRAY[${root}]::uuid[]`);
      expect(below.n).toBe(1);
    });
  });

  it("delegation_allocations and delegation_charges: one edge per child, release exactly the unspent part once, settle a usage row once", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      const root = randomUUID();
      const child = randomUUID();
      const child2 = randomUUID();
      await tx.execute(rootGrant(f, root));
      await tx.execute(childGrant(f, child, root));
      await tx.execute(childGrant(f, child2, root));
      const edge = await one<{ id: string }>(
        tx,
        sql`insert into delegation_allocations (parent_grant_id, child_grant_id, amount_micros, idempotency_key)
            values (${root}, ${child}, 10000000, 'k1') returning id`,
      );
      const bad: Array<[ReturnType<typeof sql>, RegExp]> = [
        [
          sql`insert into delegation_allocations (parent_grant_id, child_grant_id, amount_micros, idempotency_key) values (${root}, ${child}, 1, 'k2')`,
          /delegation_allocations_child_uq/,
        ],
        [
          sql`insert into delegation_allocations (parent_grant_id, child_grant_id, amount_micros, idempotency_key) values (${root}, ${child2}, 1, 'k1')`,
          /delegation_allocations_idempotency_uq/,
        ],
        [
          sql`insert into delegation_allocations (parent_grant_id, child_grant_id, amount_micros, idempotency_key) values (${root}, ${child2}, -1, 'k3')`,
          /delegation_allocations_amounts_check/,
        ],
        [
          sql`insert into delegation_allocations (parent_grant_id, child_grant_id, amount_micros, idempotency_key) values (${root}, ${root}, 1, 'k4')`,
          /delegation_allocations_edge_check/,
        ],
        [
          sql`insert into delegation_allocations (parent_grant_id, child_grant_id, amount_micros, idempotency_key, status, released_micros) values (${root}, ${child2}, 5, 'k5', 'open', 1)`,
          /delegation_allocations_close_check/,
        ],
        // closing must release exactly max(0, amount − drawn)
        [sql`update delegation_allocations set status = 'closed', closed_at = now(), released_micros = 1 where id = ${edge.id}`, /delegation_allocations_close_check/],
        [sql`update delegation_allocations set amount_micros = 1 where id = ${edge.id}`, /immutable and drawn only grows/],
        [sql`delete from delegation_allocations where id = ${edge.id}`, /never deleted/],
      ];
      for (const [stmt, pattern] of bad) await expectRefused(inSavepoint(tx, stmt), pattern);
      await tx.execute(sql`update delegation_allocations set drawn_micros = 4000000 where id = ${edge.id}`);
      await expectRefused(
        inSavepoint(tx, sql`update delegation_allocations set drawn_micros = 1 where id = ${edge.id}`),
        /drawn only grows/,
      );
      await tx.execute(sql`update delegation_allocations set status = 'closed', closed_at = now(), released_micros = 6000000 where id = ${edge.id}`);
      await expectRefused(
        inSavepoint(tx, sql`update delegation_allocations set status = 'open', closed_at = NULL, released_micros = 0 where id = ${edge.id}`),
        /never reopened/,
      );
      // a first-crossing overrun (drawn > amount) releases nothing
      const edge2 = await one<{ id: string }>(
        tx,
        sql`insert into delegation_allocations (parent_grant_id, child_grant_id, amount_micros, drawn_micros, idempotency_key)
            values (${root}, ${child2}, 5, 9, 'k6') returning id`,
      );
      await tx.execute(sql`update delegation_allocations set status = 'closed', closed_at = now(), released_micros = 0 where id = ${edge2.id}`);

      const usage = randomUUID();
      await tx.execute(sql`insert into delegation_charges (usage_event_id, leaf_grant_id, amount_micros) values (${usage}, ${child}, 7)`);
      // the retried settlement's own claim: the conflict says "already settled"
      const again = await tx.execute(
        sql`insert into delegation_charges (usage_event_id, leaf_grant_id, amount_micros) values (${usage}, ${child}, 7) on conflict do nothing returning 1`,
      );
      expect(rows(again)).toHaveLength(0);
      for (const [stmt, pattern] of [
        [sql`insert into delegation_charges (usage_event_id, leaf_grant_id, amount_micros) values (${randomUUID()}, ${child}, -1)`, /delegation_charges_amount_check/],
        [sql`update delegation_charges set amount_micros = 8 where usage_event_id = ${usage}`, /append-only/],
        [sql`delete from delegation_charges where usage_event_id = ${usage}`, /append-only/],
      ] as const) {
        await expectRefused(inSavepoint(tx, stmt), pattern);
      }
    });
  });

  it("issued_tokens: always sender-bound, at most an hour, only revocation changes a row; replay claims are atomic and immutable", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixtures(tx);
      const root = randomUUID();
      await tx.execute(
        sql`insert into delegation_grants (id, root_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, audience,
              auth_credential_id, binding_kind, binding_thumbprint, expires_at)
            values (${root}, ${root}, '{}'::uuid[], 0, ${users.admin.id}, ${f.identity2.id}, '[]'::jsonb, 'dev', 'https://gw.example/mcp/1',
              ${f.cred.id}, 'dpop', ${X("j")}, now() + interval '1 hour')`,
      );
      const kid = `k-${RUN}`;
      await tx.execute(sql`insert into identity_signing_keys (kid, public_jwk, activated_at) values (${kid}, ${JWK(X("W"))}::jsonb, now())`);
      const tok = (jti: string, binding: string, lifetime: string) =>
        sql`insert into issued_tokens (jti, grant_id, auth_credential_id, signing_kid, binding_kind, binding_thumbprint, audience, env, issued_at, expires_at)
            values (${jti}, ${root}, ${f.cred.id}, ${kid}, ${binding}, ${X("j")}, 'https://gw.example/mcp/1', 'dev', now(), now() + ${lifetime}::interval)`;
      const jti = `jti${RUN}${"x".repeat(16)}`;
      await tx.execute(tok(jti, "dpop", "300 seconds"));
      for (const [stmt, pattern] of [
        [tok(`b${jti}`, "bearer", "300 seconds"), /issued_tokens_binding_check/],
        [tok(`c${jti}`, "in_process", "300 seconds"), /issued_tokens_binding_check/],
        [tok(`d${jti}`, "dpop", "3601 seconds"), /issued_tokens_lifetime_check/],
        [tok("short", "dpop", "300 seconds"), /issued_tokens_jti_check/],
        [sql`update issued_tokens set binding_thumbprint = ${X("k")} where jti = ${jti}`, /only by revocation/],
        [sql`delete from issued_tokens where jti = ${jti}`, /unexpired token row is never deleted/],
      ] as const) {
        await expectRefused(inSavepoint(tx, stmt), pattern);
      }
      await tx.execute(sql`update issued_tokens set revoked_at = now() where jti = ${jti}`);

      // replay claims: the first insert wins, the second returns nothing
      const claim = (ns: string, key: string) =>
        sql`insert into replay_claims (namespace, key, expires_at) values (${ns}, ${key}, now() + interval '6 minutes') on conflict do nothing returning 1`;
      expect(rows(await tx.execute(claim("rs_dpop", `j-${RUN}`)))).toHaveLength(1);
      expect(rows(await tx.execute(claim("rs_dpop", `j-${RUN}`)))).toHaveLength(0);
      // namespaces are separate
      expect(rows(await tx.execute(claim("as_dpop", `j-${RUN}`)))).toHaveLength(1);
      for (const [stmt, pattern] of [
        [claim("cookie", `j2-${RUN}`), /replay_claims_namespace_check/],
        [sql`insert into replay_claims (namespace, key, expires_at) values ('rs_dpop', '', now() + interval '1 minute')`, /replay_claims_key_check/],
        [sql`insert into replay_claims (namespace, key, expires_at, claimed_at) values ('rs_dpop', ${`j3-${RUN}`}, now(), now())`, /replay_claims_expiry_check/],
        [sql`update replay_claims set expires_at = now() + interval '1 day' where key = ${`j-${RUN}`}`, /never updated or overwritten/],
        [sql`delete from replay_claims where key = ${`j-${RUN}`}`, /live claim is never removed/],
      ] as const) {
        await expectRefused(inSavepoint(tx, stmt), pattern);
      }
    });
  });

  it("audit_chain_versions is append-only and v2-only; the audit actor fields go together", async () => {
    await inRolledBackTx(async (tx) => {
      for (const [stmt, pattern] of [
        [sql`insert into audit_chain_versions (version, from_seq) values (3, 100)`, /audit_chain_versions_version_check/],
        [sql`insert into audit_chain_versions (version, from_seq) values (2, 1)`, /audit_chain_versions_from_seq_check/],
        [
          sql`insert into audit_log (user_id, effect, rule_id, rule_chain, reason, actor_identity_id) values (${users.admin.id}, 'allow', 'r', '[]'::jsonb, 'x', ${randomUUID()})`,
          /audit_log_actor_fields_check/,
        ],
        [
          sql`insert into audit_log (user_id, effect, rule_id, rule_chain, reason, chain_version) values (${users.admin.id}, 'allow', 'r', '[]'::jsonb, 'x', 3)`,
          /audit_log_chain_version_check/,
        ],
        [
          sql`insert into audit_log (user_id, effect, rule_id, rule_chain, reason, actor_identity_id, delegation_grant_id, actor_chain) values (${users.admin.id}, 'allow', 'r', '[]'::jsonb, 'x', ${randomUUID()}, ${randomUUID()}, '[]'::jsonb)`,
          /audit_log_actor_chain_check/,
        ],
      ] as const) {
        await expectRefused(inSavepoint(tx, stmt), pattern);
      }
      await tx.execute(sql`insert into audit_chain_versions (version, from_seq) values (2, 999999999)`);
      await expectRefused(inSavepoint(tx, sql`update audit_chain_versions set from_seq = 5`), /append-only/);
      await expectRefused(inSavepoint(tx, sql`delete from audit_chain_versions`), /append-only/);
    });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 decision 19: the audit writer reads the boundary under the append lock", () => {
  const actor = () => ({ actorIdentityId: randomUUID(), delegationGrantId: randomUUID(), actorChain: [randomUUID()] });
  const base = () => ({
    userId: users.admin.id,
    objectType: "agent" as const,
    effect: "allow" as const,
    ruleId: "a188-test",
    ruleChain: ["a188-test"],
    reason: "s1 foundation",
  });

  it("before any boundary: rows are v1 (no version), and actor fields are refused rather than written unhashed", async () => {
    await inRolledBackTx(async (tx) => {
      const [row] = await tx.insert(auditLog).values(base()).returning();
      expect(row!.chainVersion).toBeNull();
      expect(row!.contentHash).toBe(auditContentHashFor(row as never, 1));
      await expectRefused(
        tx.transaction((sp) => sp.insert(auditLog).values({ ...base(), ...actor() }).then(() => undefined)),
        /only from the v2 boundary on/,
      );
    });
  });

  it("from the boundary on: rows carry version 2, the actor fields are inside the hash, and a v1 hash is not what is stored", async () => {
    await inRolledBackTx(async (tx) => {
      const tip = rows<{ s: string }>(await tx.execute(sql`select max(seq)::bigint as s from audit_log`))[0]!;
      await tx.execute(sql`insert into audit_chain_versions (version, from_seq) values (2, ${Number(tip.s) + 1})`);
      const [row] = await tx.insert(auditLog).values({ ...base(), ...actor() }).returning();
      expect(row!.chainVersion).toBe(2);
      expect(row!.contentHash).toBe(auditContentHashFor(row as never, 2));
      expect(row!.contentHash).not.toBe(auditContentHashFor(row as never, 1));
      // editing the chain changes the v2 hash
      expect(auditContentHashFor({ ...row!, actorChain: [randomUUID()] } as never, 2)).not.toBe(row!.contentHash);
      // a human's own row past the boundary is v2 too
      const [plain] = await tx.insert(auditLog).values(base()).returning();
      expect(plain!.chainVersion).toBe(2);
    });
  });

  it("a boundary for a version this build cannot write refuses the append", async () => {
    await inRolledBackTx(async (tx) => {
      // the CHECK holds version = 2, so simulate a newer build's boundary by lifting it inside this rolled-back transaction
      await tx.execute(sql`alter table audit_chain_versions drop constraint audit_chain_versions_version_check`);
      await tx.execute(sql`insert into audit_chain_versions (version, from_seq) values (3, 2)`);
      await expectRefused(
        tx.transaction((sp) => sp.insert(auditLog).values(base()).then(() => undefined)),
        /serialisation version 3/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 the stubs: every route answers 501 under its auth class", () => {
  const url = (p: string) => p.replace(/:[A-Za-z]+/g, () => randomUUID());

  it("the route classes, stability and tags agree with IDENTITY_ROUTES", () => {
    for (const r of IDENTITY_ROUTES) {
      const key = `${r.method} ${r.path}`;
      expect(routeAuthClass(r.method, r.path), key).toBe(r.cls);
      expect(ROUTE_STABILITY[key], key).toBe("internal");
      expect(ROUTE_TAGS[key], key).toBe("identity");
    }
    // nothing else in the registries claims the identity tag
    const tagged = Object.entries(ROUTE_TAGS)
      .filter(([, t]) => t === "identity")
      .map(([k]) => k)
      .sort();
    expect(tagged).toEqual(IDENTITY_ROUTES.map((r) => `${r.method} ${r.path}`).sort());
  });

  it("each route not yet built answers 501 not_built to an authorised caller", async () => {
    // S3 built its routes (the JWKS and the signing keys); zz-adr0188-s3-issuer-grants.test.ts covers them
    // S4 built the identity reads and the own-grant set; zz-adr0188-s4-in-process.test.ts covers them
    for (const r of IDENTITY_ROUTES.filter((x) => x.slice !== "S3" && x.slice !== "S4")) {
      const headers = r.cls === "public" ? {} : r.cls === "user" ? users.member.auth : users.admin.auth;
      const res = await inject(r.method, url(r.path), headers, r.method === "GET" || r.method === "DELETE" ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.path}: ${res.body}`).toBe(501);
      expect(res.json(), `${r.method} ${r.path}`).toEqual({ error: "not_built" });
    }
  });

  it("401 with no credential and 403 for a non-admin, wherever the class demands one", async () => {
    for (const r of IDENTITY_ROUTES.filter((x) => x.cls !== "public")) {
      const body = r.method === "GET" || r.method === "DELETE" ? undefined : {};
      const anon = await inject(r.method, url(r.path), {}, body);
      expect(anon.statusCode, `${r.method} ${r.path} (anonymous)`).toBe(401);
      if (r.cls === "admin") {
        const member = await inject(r.method, url(r.path), users.member.auth, body);
        expect(member.statusCode, `${r.method} ${r.path} (member)`).toBe(403);
      }
    }
  });
});
