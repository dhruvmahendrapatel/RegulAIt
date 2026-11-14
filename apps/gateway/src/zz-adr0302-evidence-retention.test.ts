/**
 * ADR-0302 — third-party ingest evidence retention.
 *
 * The floor is the composed audit-retention floor (shared state: other files' compliance profiles may raise it), so
 * every fixture is placed relative to the floor `retentionFloor` reports AFTER this file sets the org default, never
 * relative to a number this file assumes. The org default is put back after.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  auditLog,
  createDb,
  desc,
  eq,
  inArray,
  orgSettings,
  runMigrations,
  sql,
  thirdPartyIngestRecords,
  thirdPartyIngestSources,
  type Db,
} from "@regulait/db";
import { databaseNow } from "./db-clock.js";
import { loadOrgSettings, retentionFloor } from "./org-settings.js";
import {
  runThirdPartyEvidenceRetentionSweep,
  THIRD_PARTY_EVIDENCE_RETENTION_RULE_ID,
} from "./third-party-ingest-retention.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Date.now();
const DAY = 24 * 3600 * 1000;

let db: Db;
let sourceId: string;
let savedDefault: number | null;
let savedModes: unknown;
let floorDays: number;
let dbNow: Date;

async function insertRecord(tag: string, receivedAt: Date): Promise<string> {
  const [row] = await db
    .insert(thirdPartyIngestRecords)
    .values({
      sourceId,
      recordId: `adr0302-${RUN}-${tag}`,
      bucket: "diagnostic",
      attributes: {},
      observedAt: receivedAt,
      receivedAt,
      recordSha256: "a".repeat(64),
      batchSha256: "b".repeat(64),
      auditLogId: randomUUID(),
    })
    .returning({ id: thirdPartyIngestRecords.id });
  return row!.id;
}

const present = async (ids: string[]) =>
  (await db.select({ id: thirdPartyIngestRecords.id }).from(thirdPartyIngestRecords).where(inArray(thirdPartyIngestRecords.id, ids))).map((r) => r.id);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const org = await loadOrgSettings(db);
  savedDefault = org.defaultAuditRetentionDays;
  savedModes = org.modeAuditRetention;
  const [src] = await db
    .insert(thirdPartyIngestSources)
    .values({ kind: "defenseclaw", name: `adr0302-${RUN}` })
    .returning({ id: thirdPartyIngestSources.id });
  sourceId = src!.id;
  dbNow = await databaseNow(db);
});

afterAll(async () => {
  await db
    .update(orgSettings)
    .set({ defaultAuditRetentionDays: savedDefault, modeAuditRetention: savedModes as never })
    .where(eq(orgSettings.id, (await loadOrgSettings(db)).id));
});

describe("ADR-0302 the sweep follows the compliance-cascade floor", () => {
  it("with no floor configured it deletes nothing (fail-safe: keep all)", async () => {
    const f = await retentionFloor(db);
    if (f.retainedDays != null) return; // another file's profile set a floor: the keep-all arm is not reachable here
    const old = await insertRecord("nofloor", new Date(dbNow.getTime() - 5000 * DAY));
    const out = await runThirdPartyEvidenceRetentionSweep(db);
    expect(out).toMatchObject({ deleted: 0, retainedDays: null });
    expect(await present([old])).toEqual([old]);
  });

  it("deletes rows received before the floor, keeps newer ones, and audits the pass once", async () => {
    await db.update(orgSettings).set({ defaultAuditRetentionDays: 30, modeAuditRetention: {} as never }).where(eq(orgSettings.id, (await loadOrgSettings(db)).id));
    const f = await retentionFloor(db);
    floorDays = f.retainedDays!;
    expect(floorDays).toBeGreaterThanOrEqual(30);
    const old = await insertRecord("old", new Date(dbNow.getTime() - (floorDays + 2) * DAY));
    const recent = await insertRecord("recent", new Date(dbNow.getTime() - (floorDays - 2) * DAY));
    const out = await runThirdPartyEvidenceRetentionSweep(db);
    expect(out.retainedDays).toBe(floorDays);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(await present([old, recent])).toEqual([recent]);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, THIRD_PARTY_EVIDENCE_RETENTION_RULE_ID))
      .orderBy(desc(auditLog.at))
      .limit(1);
    const detail = row!.detail as Record<string, unknown>;
    expect(detail).toMatchObject({ adr: "0302", retainedDays: floorDays, attribution: "third_party" });
    expect((detail.bySource as Record<string, number>)[sourceId]).toBeGreaterThanOrEqual(1);

    // a second pass finds nothing and writes no audit row
    const before = (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, THIRD_PARTY_EVIDENCE_RETENTION_RULE_ID))).length;
    expect((await runThirdPartyEvidenceRetentionSweep(db)).deleted).toBe(0);
    const after = (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, THIRD_PARTY_EVIDENCE_RETENTION_RULE_ID))).length;
    expect(after).toBe(before);
  });

  it("a longer per-mode override extends the evidence floor (keep longer)", async () => {
    await db
      .update(orgSettings)
      .set({ modeAuditRetention: { air_gapped: floorDays + 20 } as never })
      .where(eq(orgSettings.id, (await loadOrgSettings(db)).id));
    const between = await insertRecord("between", new Date(dbNow.getTime() - (floorDays + 10) * DAY));
    const out = await runThirdPartyEvidenceRetentionSweep(db);
    expect(out.retainedDays).toBe(floorDays + 20);
    expect(out.floorSource).toContain("mode:air_gapped");
    expect(await present([between])).toEqual([between]);
  });
});

describe("ADR-0302 the guard trigger still refuses everything else", () => {
  it("a DELETE without the sweep's setting is refused", async () => {
    const id = await insertRecord("plain", new Date(dbNow.getTime() - 9000 * DAY));
    await expect(db.delete(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.id, id))).rejects.toThrow();
    expect(await present([id])).toEqual([id]);
  });

  it("with the setting, a row newer than the cutoff, a future cutoff and an UPDATE are refused", async () => {
    const fresh = await insertRecord("fresh", new Date(dbNow.getTime() - 1 * DAY));
    const cutoff = new Date(dbNow.getTime() - 10 * DAY).toISOString();
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('regulait.tpi_retention_cutoff', ${cutoff}, true)`);
        await tx.delete(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.id, fresh));
      }),
    ).rejects.toThrow();
    const future = new Date(dbNow.getTime() + 10 * DAY).toISOString();
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('regulait.tpi_retention_cutoff', ${future}, true)`);
        await tx.delete(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.id, fresh));
      }),
    ).rejects.toThrow();
    const old = await insertRecord("upd", new Date(dbNow.getTime() - 9000 * DAY));
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('regulait.tpi_retention_cutoff', ${cutoff}, true)`);
        await tx.update(thirdPartyIngestRecords).set({ bucket: "security.finding" }).where(eq(thirdPartyIngestRecords.id, old));
      }),
    ).rejects.toThrow();
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('regulait.tpi_retention_cutoff', 'not a time', true)`);
        await tx.delete(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.id, old));
      }),
    ).rejects.toThrow();
    expect((await present([fresh, old])).sort()).toEqual([fresh, old].sort());
  });

  it("non-vacuity: the same transaction shape deletes an old row when the cutoff is honest", async () => {
    const old = await insertRecord("honest", new Date(dbNow.getTime() - 9000 * DAY));
    const cutoff = new Date(dbNow.getTime() - 10 * DAY).toISOString();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('regulait.tpi_retention_cutoff', ${cutoff}, true)`);
      await tx.delete(thirdPartyIngestRecords).where(eq(thirdPartyIngestRecords.id, old));
    });
    expect(await present([old])).toEqual([]);
  });
});
