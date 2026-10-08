/**
 * Batch 4 (ADR-0186 decision 28) — PR #198 review round 8, findings 44–45:
 * migration 0171's `approvals.approver_role_id` backfill. Seeded on a database
 * migrated to 0170, then migrated to the head.
 *
 *  F44  a live approval takes its rule's role AS SERVED: the active version's
 *       `approverRoleId` (an explicit null included), else the base row; a
 *       canary version is shadow-only for approval rules and never names it.
 *  F45  approved-but-unconsumed rows are backfilled too (a live consent keeps
 *       its pool); decided and consumed rows are history and stay null.
 *
 * Runs on its OWN scratch database (prefix `b4c8m_`), dropped in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4c8m_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

let admin: Db;
let db: Db;
let tmp: string;
const ids = {} as Record<string, string>;

const roleOf = async (approvalId: string) =>
  ((await db.execute<{ r: string | null }>(sql`SELECT approver_role_id AS r FROM approvals WHERE id = ${approvalId}`)).rows[0]!).r;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  // migrate to 0170 only (0171 and later cut from a copy of the journal)
  tmp = mkdtempSync(path.join(tmpdir(), "b4c8-0171-"));
  cpSync(migrationsFolder, tmp, { recursive: true });
  const journalPath = path.join(tmp, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const cut = journal.entries.find((e) => e.tag === "0171_approval_role_snapshot")!.idx;
  journal.entries = journal.entries.filter((e) => e.idx < cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations(db, tmp);

  // people and roles
  const user = async (label: string) =>
    ((await db.execute<{ id: string }>(sql`INSERT INTO users (email, display_name) VALUES (${`b4c8m-${label}-${randomUUID()}@example.com`}, ${label}) RETURNING id`)).rows[0]!).id;
  const role = async (label: string) =>
    ((await db.execute<{ id: string }>(sql`INSERT INTO roles (name) VALUES (${`b4c8m ${label} ${randomUUID()}`}) RETURNING id`)).rows[0]!).id;
  ids.caller = await user("caller");
  ids.approver = await user("approver");
  ids.roleA = await role("A");
  ids.roleB = await role("B");
  ids.roleC = await role("C");

  const rule = async (approverRoleId: string) =>
    ((await db.execute<{ id: string }>(
      sql`INSERT INTO approval_rules (user_id, server_scope, approver_user_id, approver_role_id) VALUES (${ids.caller}, 'all', ${ids.approver}, ${approverRoleId}) RETURNING id`,
    )).rows[0]!).id;
  const version = (ruleId: string, n: number, body: Record<string, unknown>, status: "active" | "canary", canaryPct: number | null = null) =>
    db.execute(
      sql`INSERT INTO config_versions (artifact_type, artifact_id, version, body, status, canary_pct) VALUES ('approval_rule', ${ruleId}, ${n}, ${JSON.stringify(body)}::jsonb, ${status}, ${canaryPct})`,
    );
  const approval = async (ruleId: string, status: string) =>
    ((await db.execute<{ id: string }>(
      sql`INSERT INTO approvals (user_id, object_type, approver_user_id, status, rule_id) VALUES (${ids.caller}, 'mcp_tool', ${ids.approver}, ${status}, ${ruleId}) RETURNING id`,
    )).rows[0]!).id;

  // base row only: role A
  const base = await rule(ids.roleA);
  // an ACTIVE version moved the pool from A to B
  const active = await rule(ids.roleA);
  await version(active, 1, { approverRoleId: ids.roleB }, "active");
  // the active version keeps A; a CANARY version (shadow-only for approval rules) names C
  const canary = await rule(ids.roleA);
  await version(canary, 1, { approverRoleId: ids.roleA }, "active");
  await version(canary, 2, { approverRoleId: ids.roleC }, "canary", 50);
  // the active version takes the role away (explicit null)
  const cleared = await rule(ids.roleA);
  await version(cleared, 1, { approverRoleId: null }, "active");

  for (const [name, ruleId] of [["base", base], ["active", active], ["canary", canary], ["cleared", cleared]] as const) {
    ids[`${name}Pending`] = await approval(ruleId, "pending");
    ids[`${name}Approved`] = await approval(ruleId, "approved");
    ids[`${name}Consumed`] = await approval(ruleId, "consumed");
  }

  await runMigrations(db, migrationsFolder);
}, 240_000);

afterAll(async () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await db?.$client.end();
  await dropScratchDatabase(admin, SCRATCH_DB);
  await admin?.$client.end();
});

describe("F44–45: 0171 backfills the role as served, for every live approval", () => {
  it("base row only: pending and approved-unconsumed take the base role; consumed stays null", async () => {
    expect(await roleOf(ids.basePending!)).toBe(ids.roleA);
    expect(await roleOf(ids.baseApproved!)).toBe(ids.roleA);
    expect(await roleOf(ids.baseConsumed!)).toBeNull();
  });
  it("an active version naming another role: its role, not the base row's", async () => {
    expect(await roleOf(ids.activePending!)).toBe(ids.roleB);
    expect(await roleOf(ids.activeApproved!)).toBe(ids.roleB);
    expect(await roleOf(ids.activeConsumed!)).toBeNull();
  });
  it("a canary version never names the pool (approval-rule canaries are shadow-only): the active version's role", async () => {
    expect(await roleOf(ids.canaryPending!)).toBe(ids.roleA);
    expect(await roleOf(ids.canaryApproved!)).toBe(ids.roleA);
  });
  it("an active version that clears the role: no role, never the base row's", async () => {
    expect(await roleOf(ids.clearedPending!)).toBeNull();
    expect(await roleOf(ids.clearedApproved!)).toBeNull();
  });
});
