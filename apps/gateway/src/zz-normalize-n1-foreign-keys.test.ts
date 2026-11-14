/**
 * ADR-0200 addendum (2026-11-06, normalized schema), batch N1: the foreign keys migration `normalize_n1_foreign_keys` adds exist,
 * are VALIDATED (not left NOT VALID), carry the intended delete rule, and actually refuse a dangling write.
 *
 * Review of #683: on a populated database the cleanup clears ORPHANS only. Valid pointers survive, also when the
 * parents it reads (`users`, `approvals`) are under FORCE ROW LEVEL SECURITY and the migration runs as a non-superuser
 * owner (ADR-0234), because the file enters the `migration` system context first. A RESTRICT orphan fails it loudly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";
import { readMigration, removeMigration } from "./testing/migration-by-slug.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `n1fk_${process.pid}_${Date.now()}`;
/** a second scratch database, migrated to just BELOW `normalize_n1_foreign_keys` and populated before `normalize_n1_foreign_keys` is applied by hand */
const PRE_DB = `n1fk_pre_${process.pid}_${Date.now()}`;
/** a cluster-wide, non-superuser role standing in for ADR-0234's non-superuser migration owner */
const RLS_ROLE = `n1fk_owner_${process.pid}_${Date.now()}`;
const N1_FILE = "normalize_n1_foreign_keys";

/** table, column, referenced table, confdeltype ('n' = SET NULL, 'r' = RESTRICT) */
const EXPECTED: ReadonlyArray<readonly [string, string, string, "n" | "r"]> = [
  ["org_settings", "summarizer_agent_id", "agents", "n"],
  ["org_settings", "infra_approver_user_id", "users", "n"],
  ["org_settings", "recommendation_judge_agent_id", "agents", "n"],
  ["report_definitions", "pack_id", "compliance_packs", "n"],
  ["engine_schedules", "last_run_id", "engine_runs", "n"],
  ["engine_enrollment_tokens", "runner_id", "engine_runners", "n"],
  ["cert_rotations", "finding_id", "infra_findings", "n"],
  ["cert_rotations", "approval_id", "approvals", "n"],
  ["patch_records", "finding_id", "infra_findings", "n"],
  ["backup_runs", "finding_id", "infra_findings", "n"],
  ["prompt_promotions", "approver_user_id", "users", "r"],
  ["prompt_promotions", "decided_by_user_id", "users", "r"],
];

let admin: Db;
let db: Db;
let pre: Db | undefined;
let preFolder: string | undefined;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  db = createDb(u.toString());
  await runMigrations(db, migrationsFolder);
}, 180_000);

afterAll(async () => {
  await db?.$client.end().catch(() => undefined);
  await pre?.$client.end().catch(() => undefined);
  if (preFolder) rmSync(preFolder, { recursive: true, force: true });
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await dropScratchDatabase(admin, PRE_DB);
    // the role owns objects only in PRE_DB, which is gone now
    await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${RLS_ROLE}`)).catch(() => undefined);
    await admin.$client.end().catch(() => undefined);
  }
});

describe("`normalize_n1_foreign_keys`: the N1 foreign keys", () => {
  it("each exists, is validated, points at the right table and has the intended delete rule", async () => {
    const r = await db.execute<{ t: string; c: string; ref: string; del: string; valid: boolean }>(sql`
      select k.conrelid::regclass::text as t, a.attname as c, k.confrelid::regclass::text as ref,
             k.confdeltype as del, k.convalidated as valid
        from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
       where k.contype = 'f' and k.conname like '%\_fk' and array_length(k.conkey, 1) = 1`);
    const found = new Map(r.rows.map((x) => [`${x.t}.${x.c}`, x]));
    for (const [t, c, ref, del] of EXPECTED) {
      const row = found.get(`${t}.${c}`);
      expect(row, `${t}.${c}`).toBeDefined();
      expect([t, c, row!.ref, row!.del, row!.valid]).toEqual([t, c, ref, del, true]);
    }
  });

  it("a dangling write is refused (negative control: the same column accepts a real target)", async () => {
    const bad = randomUUID();
    await expect(db.execute(sql`update org_settings set infra_approver_user_id = ${bad}`)).rejects.toThrow();
    const real = randomUUID();
    await db.execute(sql`insert into users (id, email, display_name) values (${real}, ${`n1-${real}@fk.test`}, 'N1')`);
    await db.execute(sql`update org_settings set infra_approver_user_id = ${real}`);
    await db.execute(sql`update org_settings set infra_approver_user_id = null`);
  });
});

// --------------------------------------------------------------------------------------------- review of #683

/** the `normalize_n1_foreign_keys` statements, as the migrator splits them; `withoutContext` drops the set_config lines (the defect) */
function n1Statements(withoutContext = false): string[] {
  const text = readMigration(migrationsFolder, N1_FILE);
  return text
    .split("--> statement-breakpoint")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .filter((x) => !(withoutContext && x.includes("set_config('regulait.system_context'")));
}

describe("`normalize_n1_foreign_keys` on a populated database (review of #683)", () => {
  const ids = {
    approver: randomUUID(),
    approval: randomUUID(),
    rotation: randomUUID(),
    orphanAgent: randomUUID(),
    orphanFinding: randomUUID(),
    promotion: randomUUID(),
  };
  const childTables = [
    "org_settings",
    "report_definitions",
    "engine_schedules",
    "engine_enrollment_tokens",
    "cert_rotations",
    "patch_records",
    "backup_runs",
    "prompt_promotions",
  ];

  beforeAll(async () => {
    // a copy of the migrations folder without this migration: its pending file, or (once assign-at-merge numbered it,
    // ADR-0252) its numbered file and journal entry
    preFolder = mkdtempSync(path.join(os.tmpdir(), "n1fk-pre-"));
    cpSync(migrationsFolder, preFolder, { recursive: true });
    removeMigration(preFolder, N1_FILE);

    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${PRE_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${PRE_DB}`));
    const u = new URL(DATABASE_URL!);
    u.pathname = "/" + PRE_DB;
    pre = createDb(u.toString());
    await runMigrations(pre, preFolder);

    // the data: a VALID infra approver and a VALID cert-rotation approval (the two pointers the review named), plus a
    // nullable orphan of each kind the cleanup must clear
    await pre.execute(sql`insert into users (id, email, display_name) values (${ids.approver}, ${`n1-approver-${ids.approver}@fk.test`}, 'Avery Approver')`);
    await pre.execute(sql`insert into approvals (id, user_id, approver_user_id) values (${ids.approval}, ${ids.approver}, ${ids.approver})`);
    const n = ((await pre.execute<{ n: number }>(sql`select count(*)::int as n from org_settings`)).rows[0]?.n ?? 0) as number;
    if (n === 0) await pre.execute(sql`insert into org_settings default values`);
    await pre.execute(sql`update org_settings set infra_approver_user_id = ${ids.approver}, summarizer_agent_id = ${ids.orphanAgent}`);
    // a real certificate for the rotation to belong to (cert_id has its own, older foreign key)
    const resource = randomUUID();
    const cert = randomUUID();
    await pre.execute(sql`insert into infra_resources (id, kind, name) values (${resource}, 'host', 'n1-host')`);
    await pre.execute(sql`insert into cert_inventory (id, resource_id, common_name, not_after) values (${cert}, ${resource}, 'n1.example.test', now() + interval '30 days')`);
    await pre.execute(
      sql`insert into cert_rotations (id, cert_id, approval_id, finding_id) values (${ids.rotation}, ${cert}, ${ids.approval}, ${ids.orphanFinding})`,
    );

    // ADR-0234's posture, simulated: a non-superuser owner of the child tables, and FORCE ROW LEVEL SECURITY on the
    // two parents whose policy admits a row only in the `migration` system context
    await pre.execute(sql.raw(`CREATE ROLE ${RLS_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`));
    await pre.execute(sql.raw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`));
    await pre.execute(sql.raw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`));
    for (const t of childTables) await pre.execute(sql.raw(`ALTER TABLE "${t}" OWNER TO ${RLS_ROLE}`));
    for (const t of ["users", "approvals"]) {
      await pre.execute(sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
      await pre.execute(sql.raw(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`));
      await pre.execute(
        sql.raw(`CREATE POLICY n1fk_migration_only ON "${t}" USING (current_setting('regulait.system_context', true) = 'migration')`),
      );
    }
  }, 240_000);

  /** runs `normalize_n1_foreign_keys` as the non-superuser owner in one transaction; returns the pointers as they then stand */
  async function apply(opts: { withoutContext?: boolean; commit: boolean; before?: string[] }) {
    const client = await pre!.$client.connect();
    try {
      await client.query("BEGIN");
      for (const q of opts.before ?? []) await client.query(q);
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
      for (const q of n1Statements(opts.withoutContext)) await client.query(q);
      const settings = (await client.query("select infra_approver_user_id as a, summarizer_agent_id as s from org_settings")).rows[0];
      const rotation = (await client.query("select approval_id as a, finding_id as f from cert_rotations where id = $1", [ids.rotation])).rows[0];
      const context = (await client.query("select current_setting('regulait.system_context', true) as c")).rows[0].c as string | null;
      await client.query(opts.commit ? "COMMIT" : "ROLLBACK");
      return { settings, rotation, context };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  it("control: without the migration context, the RLS-filtered cleanup would wipe VALID pointers (the defect)", async () => {
    const out = await apply({ withoutContext: true, commit: false });
    expect(out.settings.a).toBeNull();
    expect(out.rotation.a).toBeNull();
  });

  it("a RESTRICT orphan (who approved a prompt promotion) fails the migration loudly instead of being rewritten", async () => {
    const orphanPromotion = `insert into prompt_promotions (id, prompt_id, tag, commit_id, commit_hash, binding_digest, requested_by_user_id, approver_user_id)
      values ('${ids.promotion}', '${randomUUID()}', 'prod', '${randomUUID()}', 'h', 'd', '${ids.approver}', '${randomUUID()}')`;
    await expect(
      apply({ commit: false, before: ["SET LOCAL session_replication_role = replica", orphanPromotion, "SET LOCAL session_replication_role = origin"] }),
    ).rejects.toThrow(/prompt_promotions_approver_user_id_fk/);
  });

  it("SECURITY: with the context, valid pointers survive, orphans are cleared, and the context does not leak", async () => {
    const out = await apply({ commit: true });
    // evidence link and accountability kept
    expect(out.settings.a).toBe(ids.approver);
    expect(out.rotation.a).toBe(ids.approval);
    // orphans cleared, as ON DELETE SET NULL would have
    expect(out.settings.s).toBeNull();
    expect(out.rotation.f).toBeNull();
    // the file leaves the transaction-local context empty, so it never carries into a later file of the run
    expect(out.context ?? "").toBe("");
    const fk = await pre!.execute<{ valid: boolean }>(
      sql`select convalidated as valid from pg_constraint where conname in ('org_settings_infra_approver_user_id_fk', 'cert_rotations_approval_id_fk')`,
    );
    expect(fk.rows.map((r) => r.valid)).toEqual([true, true]);
  });
});
