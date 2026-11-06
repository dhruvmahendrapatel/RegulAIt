/**
 * ADR-0200 addendum (2026-11-06, normalized schema), batch N1: the foreign keys migration 0280 adds exist,
 * are VALIDATED (not left NOT VALID), carry the intended delete rule, and actually refuse a dangling write.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `n1fk_${process.pid}_${Date.now()}`;

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
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await admin.$client.end().catch(() => undefined);
  }
});

describe("0280: the N1 foreign keys", () => {
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
