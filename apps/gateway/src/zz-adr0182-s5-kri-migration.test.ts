/**
 * ADR-0182 S5 (PF-03) — migration 0162 sets `on_breach = 'propose_halt'` on an
 * EXISTING agent-scoped high-severity KRI, as for a first load (ADR-0180 §1:
 * no grandfathering), and records each change in the audit trail
 * (`kri-on-breach-defaulted`, through migration_audit_outbox, ADR-0181 FX2).
 * Main-session decision 4 (D4 brief).
 *
 * A scratch database is migrated to 0161 (the journal cut before 0162), seeded
 * with four KRIs — agent/high, agent/medium, fleet/high, project/high — and
 * then migrated to head. Only the agent/high KRI changes, and only it gets an
 * audit row with `detail.transitions.onBreach: {from: alert, to: propose_halt}`.
 * A suggestion only: the migration files nothing and halts nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, kris, runMigrations, sql, type Db } from "@regulait/db";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = `${process.pid}_${Date.now()}`;
const DB_NAME = `d4s5_kri0162_${RUN}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

let admin: Db;
let scratch: Db;
let tmp: string | null = null;
const ids = {} as Record<"agentHigh" | "agentMedium" | "fleetHigh" | "projectHigh" | "agent" | "project", string>;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${DB_NAME}`));
  // a migrations folder whose journal stops before 0162
  tmp = mkdtempSync(path.join(tmpdir(), "s5-kri-mig-"));
  cpSync(migrationsFolder, tmp, { recursive: true });
  const journalPath = path.join(tmp, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const cut = journal.entries.find((e) => e.tag === "0162_accountability_records")!.idx;
  journal.entries = journal.entries.filter((e) => e.idx < cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  scratch = createDb(urlFor(DB_NAME));
  await runMigrations(scratch, tmp);

  // at 0161 `kris` has no on_breach column: raw SQL with 0161's columns only
  const one = async (q: ReturnType<typeof sql>) => ((await scratch.execute(q)) as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
  ids.agent = await one(sql`INSERT INTO agents (name, provider, tier) VALUES (${`s5k-agent-${RUN}`}, 'mock', 1) RETURNING id`);
  ids.project = await one(sql`INSERT INTO projects (name) VALUES (${`s5k-project-${RUN}`}) RETURNING id`);
  const kri = (name: string, scope: string, scopeId: string | null, severity: string) =>
    one(sql`INSERT INTO kris (name, metric, scope, scope_id, threshold, severity) VALUES (${name}, 'error_rate', ${scope}, ${scopeId}, 5, ${severity}) RETURNING id`);
  ids.agentHigh = await kri("agent high", "agent", ids.agent, "high");
  ids.agentMedium = await kri("agent medium", "agent", ids.agent, "medium");
  ids.fleetHigh = await kri("fleet high", "fleet", null, "high");
  ids.projectHigh = await kri("project high", "project", ids.project, "high");

  await runMigrations(scratch, migrationsFolder);
}, 180_000);

afterAll(async () => {
  await closeAll([
    async () => scratch?.$client.end(),
    async () => dropScratchDatabase(admin, DB_NAME),
    async () => admin.$client.end(),
    async () => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    },
  ]);
});

describe("migration 0162 — an existing agent-scoped high-severity KRI suggests a halt (first load)", () => {
  it("only the agent-scoped HIGH KRI takes propose_halt; the others stay alert", async () => {
    const rows = await scratch.select({ id: kris.id, onBreach: kris.onBreach }).from(kris);
    const by = new Map(rows.map((r) => [r.id, r.onBreach]));
    expect(by.get(ids.agentHigh)).toBe("propose_halt");
    expect(by.get(ids.agentMedium)).toBe("alert");
    expect(by.get(ids.fleetHigh)).toBe("alert");
    expect(by.get(ids.projectHigh)).toBe("alert");
  });

  it("the change is audited once, with its transition, and only for that KRI", async () => {
    const audits = await scratch.select().from(auditLog).where(eq(auditLog.ruleId, "kri-on-breach-defaulted"));
    expect(audits.map((a) => a.objectId)).toEqual([ids.agentHigh]);
    const [a] = audits;
    expect(a!.objectType).toBe("kri");
    expect(a!.userId).toBe("00000000-0000-0000-0000-000000000000"); // the migration itself
    expect(a!.detail).toMatchObject({
      migration: "0162_accountability_records",
      agentId: ids.agent,
      transitions: { onBreach: { from: "alert", to: "propose_halt" } },
    });
    expect(a!.reason).toMatch(/SUGGESTS a halt/);
    // the outbox drained into the chained trail
    const left = (await scratch.execute(sql`SELECT count(*)::int AS n FROM migration_audit_outbox`)) as unknown as { rows: Array<{ n: number }> };
    expect(left.rows[0]!.n).toBe(0);
  });

  it("a suggestion only: no proposal filed, no approval, the agent not halted", async () => {
    const n = async (q: ReturnType<typeof sql>) => ((await scratch.execute(q)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    expect(await n(sql`SELECT count(*)::int AS n FROM remediation_proposals`)).toBe(0);
    expect(await n(sql`SELECT count(*)::int AS n FROM approvals`)).toBe(0);
    expect(await n(sql`SELECT count(*)::int AS n FROM agents WHERE id = ${ids.agent} AND halted_at IS NOT NULL`)).toBe(0);
    const again = await scratch.select().from(kris).where(and(eq(kris.id, ids.agentHigh), eq(kris.scope, "agent")));
    expect(again).toHaveLength(1);
  });
});
