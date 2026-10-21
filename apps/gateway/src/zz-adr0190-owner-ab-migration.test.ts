/**
 * ADR-0190 OWNER DECISIONS A and B (2026-10-11) — migration 0191 on a scratch
 * database, from the state before it:
 *  - A: a stored `warn` reads as `enforce` with no grandfathering. The org
 *    setting and every offer are rewritten; the CHECKs then admit only
 *    `enforce`. An append-only placement keeps the mode it was recorded under,
 *    and no new placement may say `warn` or use it to fall below its class.
 *  - B: a refused placement may carry `policy_unresolved`.
 *  - The migration is re-runnable, and its journal entry sorts after 0190.
 *
 * The "before" state is rebuilt on a fully migrated scratch database by
 * putting back the CHECKs migration 0183/0187 created (the only thing 0191
 * changes), so the real 0191 file runs against real pre-0191 rows. The scratch
 * database is dropped in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { executionProfileDigest, SHIPPED_EXECUTION_PROFILES } from "@regulait/shared";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const MIGRATION = "0191_isolation_enforce_only";
const SCRATCH_DB = `regulait_iab_0191_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const RESTRICTED = SHIPPED_EXECUTION_PROFILES.restricted;

let admin: Db;
let db: Db;
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;
const one = async <T>(stmt: ReturnType<typeof sql>) => rows<T>(await db.execute(stmt))[0]!;
async function refusedWith(stmt: ReturnType<typeof sql>, pattern: RegExp): Promise<void> {
  const e = await db.execute(stmt).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, `refused (${pattern})`).not.toBeNull();
  expect(`${String((e as Error).message)} ${String((e as { cause?: Error }).cause?.message ?? "")}`).toMatch(pattern);
}
/** run the real migration file, statement by statement, as the migrator does */
async function run0191(): Promise<void> {
  const text = readFileSync(path.join(migrationsFolder, `${MIGRATION}.sql`), "utf8");
  for (const stmt of text.split("--> statement-breakpoint")) {
    if (stmt.replace(/--[^\n]*/g, "").trim()) await db.execute(sql.raw(stmt));
  }
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
}, 180_000);

afterAll(async () => {
  await closeAll([
    async () => {
      await db?.$client.end();
    },
    async () => {
      await dropScratchDatabase(admin, SCRATCH_DB);
    },
    async () => {
      await admin.$client.end();
    },
  ]);
});

describe("migration 0191: warn retired (OWNER DECISION A), policy_unresolved (OWNER DECISION B)", () => {
  it("the journal places 0191 after 0190 with a later `when`", () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const mine = journal.entries.find((e) => e.tag === MIGRATION)!;
    const prev = journal.entries.find((e) => e.tag === "0190_delegation_depth_limit_signed")!;
    expect(mine.idx).toBe(prev.idx + 1);
    expect(mine.when).toBeGreaterThan(prev.when);
    // the hazard this guards: an entry whose `when` is not later than every entry before it is
    // silently never applied (M-052 family). Checked over the WHOLE journal, so it keeps holding
    // as later migrations land after 0191 (pinning 0191 as the newest broke at 0192).
    const byIdx = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < byIdx.length; i++) {
      expect(byIdx[i]!.when, `${byIdx[i]!.tag} must be later than ${byIdx[i - 1]!.tag}`).toBeGreaterThan(byIdx[i - 1]!.when);
    }
    expect(byIdx.filter((e) => e.idx > mine.idx).every((e) => e.when > mine.when)).toBe(true);
  });

  it("rewrites a stored warn to enforce (setting and offers), keeps placement evidence, and admits only enforce afterwards", async () => {
    // ---- the state before 0191: the CHECKs of 0183 and 0187 -------------------------------------------
    for (const stmt of [
      `ALTER TABLE org_settings DROP CONSTRAINT org_settings_isolation_enforcement_check`,
      `ALTER TABLE org_settings ADD CONSTRAINT org_settings_isolation_enforcement_check CHECK (isolation_enforcement IN ('enforce', 'warn'))`,
      `ALTER TABLE execution_offers DROP CONSTRAINT execution_offers_enforcement_check`,
      `ALTER TABLE execution_offers ADD CONSTRAINT execution_offers_enforcement_check CHECK (enforcement IN ('enforce', 'warn'))`,
      `ALTER TABLE execution_placements DROP CONSTRAINT execution_placements_enforcement_check`,
      `ALTER TABLE execution_placements ADD CONSTRAINT execution_placements_enforcement_check CHECK (enforcement IN ('enforce', 'warn'))`,
      `ALTER TABLE execution_placements DROP CONSTRAINT execution_placements_no_fallback_check`,
      `ALTER TABLE execution_placements ADD CONSTRAINT execution_placements_no_fallback_check CHECK (outcome <> 'placed' OR enforcement = 'warn' OR applied_class = 'customer_declared' OR array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], applied_class) >= array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], required_class))`,
      `ALTER TABLE execution_placements DROP CONSTRAINT execution_placements_refusal_code_check`,
      `ALTER TABLE execution_placements ADD CONSTRAINT execution_placements_refusal_code_check CHECK (refusal_code IS NULL OR refusal_code IN ('no_executor', 'attestation_stale', 'class_below_required', 'executor_quarantined', 'profile_retired', 'execution_profile_mismatch'))`,
    ]) {
      await db.execute(sql.raw(stmt));
    }
    const digest = executionProfileDigest(RESTRICTED);
    // positive control: before 0191 a warn setting, a warn offer and a warn placement below its class are all writable
    await db.execute(sql`UPDATE org_settings SET isolation_enforcement = 'warn'`);
    const identity = await one<{ id: string }>(
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids)
          values ('worker_runtime', ${`spiffe://example.org/regulait/test/iab-${randomUUID()}`}, ARRAY[${randomUUID()}]::uuid[]) returning id`,
    );
    const executor = await one<{ id: string }>(
      sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
          values (${identity.id}, ${`iab-${randomUUID().slice(0, 8)}`}, 'gvisor', 'release-20261012.0', '["hardened_container", "user_space_kernel"]'::jsonb) returning id`,
    );
    const offer = await one<{ id: string }>(
      sql`insert into execution_offers (executor_id, workload_kind, required_class, required_by, enforcement, profile_digest, image_digest, expires_at)
          values (${executor.id}, 'mcp_stdio', 'user_space_kernel', 'workload_kind', 'warn', ${digest}, ${`sha256:${"c".repeat(64)}`}, now() + interval '1 hour') returning id`,
    );
    const legacy = await one<{ id: string }>(
      sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, executor_id, applied_class, report_sha256, outcome)
          values (${randomUUID()}, 'mcp_stdio', 'microvm', 'data_sensitivity', 'warn', ${digest}, ${executor.id}, 'user_space_kernel', ${"b".repeat(64)}, 'placed') returning id`,
    );
    const refused = (code: string, enforcement = "enforce") =>
      sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, outcome, refusal_code)
          values (${randomUUID()}, 'mcp_stdio', 'user_space_kernel', 'workload_kind', ${enforcement}, ${digest}, 'refused', ${code})`;
    await refusedWith(refused("policy_unresolved"), /execution_placements_refusal_code_check/);

    // ---- 0191, twice (re-runnable) ------------------------------------------------------------------
    const trailCount = async () =>
      (await one<{ n: number }>(sql`select count(*)::int as n from migration_audit_outbox where migration = ${MIGRATION}`)).n;
    expect(await trailCount()).toBe(0);
    await run0191();
    expect(await trailCount()).toBe(2);
    await run0191();
    expect(await trailCount()).toBe(2);

    // ADR-0181 FX2: each rewrite left one outbox row with old and new values; the second run added none
    const trail = rows<{ object_type: string; object_id: string | null; rule_id: string; reason: string; detail: Record<string, unknown> }>(
      await db.execute(sql`select object_type, object_id, rule_id, reason, detail from migration_audit_outbox where migration = ${MIGRATION} order by object_type`),
    );
    expect(trail).toHaveLength(2);
    const [offerTrail, settingsTrail] = trail;
    expect(settingsTrail).toMatchObject({ object_type: "org_settings", rule_id: "org-settings-updated" });
    expect(settingsTrail!.reason).toContain("ADR-0190 owner decision A");
    expect(settingsTrail!.detail).toMatchObject({ decision: "ADR-0190 owner decision A", transitions: { isolationEnforcement: { from: "warn", to: "enforce" } } });
    expect(offerTrail).toMatchObject({ object_type: "execution_placement", object_id: offer.id, rule_id: "execution-offer-enforcement-rewritten" });
    expect(offerTrail!.reason).toContain("ADR-0190 owner decision A");
    expect(offerTrail!.detail).toMatchObject({ offerId: offer.id, transitions: { enforcement: { from: "warn", to: "enforce" } } });

    // A: the stored warn reads as enforce
    expect((await one<{ m: string }>(sql`select isolation_enforcement as m from org_settings limit 1`)).m).toBe("enforce");
    expect(rows<{ m: string }>(await db.execute(sql`select distinct isolation_enforcement as m from org_settings`)).map((r) => r.m)).toEqual(["enforce"]);
    expect((await one<{ m: string }>(sql`select enforcement as m from execution_offers where id = ${offer.id}`)).m).toBe("enforce");
    // the offer's guard trigger is back on: its identity is immutable again
    await refusedWith(sql`update execution_offers set required_class = 'microvm' where id = ${offer.id}`, /identity is immutable/);
    // the append-only evidence is untouched
    expect((await one<{ m: string }>(sql`select enforcement as m from execution_placements where id = ${legacy.id}`)).m).toBe("warn");
    // ... and nothing new may say warn, or use it to fall below its class
    await refusedWith(sql`UPDATE org_settings SET isolation_enforcement = 'warn'`, /org_settings_isolation_enforcement_check/);
    await refusedWith(
      sql`insert into execution_offers (executor_id, workload_kind, required_class, required_by, enforcement, profile_digest, image_digest, expires_at)
          values (${executor.id}, 'mcp_stdio', 'user_space_kernel', 'workload_kind', 'warn', ${digest}, ${`sha256:${"c".repeat(64)}`}, now() + interval '1 hour')`,
      /execution_offers_enforcement_check/,
    );
    await refusedWith(refused("no_executor", "warn"), /execution_placements_enforcement_check/);
    await refusedWith(
      sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, executor_id, applied_class, report_sha256, outcome)
          values (${randomUUID()}, 'mcp_stdio', 'microvm', 'data_sensitivity', 'enforce', ${digest}, ${executor.id}, 'user_space_kernel', ${"b".repeat(64)}, 'placed')`,
      /execution_placements_no_fallback_check/,
    );
    // B: the sixth reason is admitted
    await db.execute(refused("policy_unresolved"));
    const defs = rows<{ conname: string; convalidated: boolean }>(
      await db.execute(sql`select conname, convalidated from pg_constraint where conname in
        ('org_settings_isolation_enforcement_check', 'execution_offers_enforcement_check', 'execution_placements_enforcement_check',
         'execution_placements_no_fallback_check', 'execution_placements_refusal_code_check') order by conname`),
    );
    expect(Object.fromEntries(defs.map((d) => [d.conname, d.convalidated]))).toEqual({
      execution_offers_enforcement_check: true,
      execution_placements_enforcement_check: false,
      execution_placements_no_fallback_check: false,
      execution_placements_refusal_code_check: true,
      org_settings_isolation_enforcement_check: true,
    });
  });
});
