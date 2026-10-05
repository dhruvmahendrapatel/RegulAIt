import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, eq, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { loadOrgSettings } from "./org-settings.js";

/**
 * AER-013 — THE HARDENED PRESET IS ONE DURABLE FACT (the ADR-0132 pattern).
 *
 * The harden mutation used to be read / plain update / separate audit inserts
 * with no transaction and no lock. Two concurrent applications could each read
 * the shipped defaults and each mint an "applied" row for the one change; an
 * audit insert that failed left the settings hardened with nothing recording
 * it. Now the singleton row is locked FOR UPDATE, idempotency is decided
 * against the locked committed state, and the update and its audit rows
 * commit together or not at all.
 *
 * Same instrument as the AER-019/023 atomicity suites: a BEFORE INSERT trigger
 * on audit_log that rejects this preset's own row, so the failure is injected
 * at exactly the statement the finding names.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `aer013-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

const harden = (payload: unknown = {}) =>
  app.inject({ method: "POST", url: "/v1/org/posture/harden", headers: AUTH, payload: payload as Record<string, unknown> });

const count = async (ruleId: string) =>
  (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, ruleId))).length;

async function restoreShippedDefaults() {
  const r = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: {
    defaultPiiMode: "none", mcpAdmissionMode: "enforce", useCaseGateMode: "off",
    dispatchAttributionRequired: false, semanticCachePolicy: "opt_in",
  } });
  expect(r.statusCode).toBe(200);
  const m = await app.inject({ method: "POST", url: "/v1/mrm/enforcement", headers: AUTH, payload: { enforced: false } });
  expect(m.statusCode).toBe(200);
}

async function withAuditFailure(run: () => Promise<void>): Promise<void> {
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION aer013_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.rule_id = 'org-posture-hardened' THEN
        RAISE EXCEPTION 'aer013 injected audit failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER aer013_test_reject_audit BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION aer013_test_reject_audit();
  `));
  try {
    await run();
  } finally {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS aer013_test_reject_audit ON audit_log"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS aer013_test_reject_audit()"));
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64), auditAnchorSink: null });
  await restoreShippedDefaults();
});

afterAll(async () => {
  await db.execute(sql.raw("DROP TRIGGER IF EXISTS aer013_test_reject_audit ON audit_log"));
  await db.execute(sql.raw("DROP FUNCTION IF EXISTS aer013_test_reject_audit()"));
  await restoreShippedDefaults();
  await app.close();
});

describe("concurrency — the preset applies ONCE however many callers race", () => {
  it("twelve simultaneous applications: one applied, eleven already-satisfied, one audit row per fact", async () => {
    await restoreShippedDefaults();
    const presetBefore = await count("org-posture-hardened");
    const mrmBefore = await count("mrm-enforcement-enabled");

    const results = await Promise.all(Array.from({ length: 12 }, () => harden({})));
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    const winners = results.filter((r) => Object.keys(r.json().applied).length > 0);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.json().applied.defaultPiiMode).toEqual(["none", "block"]);
    expect(winners[0]!.json().applied.mrmEnforced).toEqual([false, true]);
    for (const r of results.filter((x) => x !== winners[0])) {
      expect(r.json().alreadySatisfied).toContain("defaultPiiMode");
      expect(r.json().alreadySatisfied).toContain("mrmEnforced");
    }
    // exactly one fact per kind for one application, not one per caller
    expect(await count("org-posture-hardened")).toBe(presetBefore + 1);
    expect(await count("mrm-enforcement-enabled")).toBe(mrmBefore + 1);
    const settings = await loadOrgSettings(db);
    expect(settings.defaultPiiMode).toBe("block");
    expect(settings.mrmEnforced).toBe(true);
    await restoreShippedDefaults();
  });
});

describe("atomicity — a failed audit insert rolls the settings change back", () => {
  it("settings stay at the shipped defaults, no row is minted, and the error is a real 5xx", async () => {
    await restoreShippedDefaults();
    const presetBefore = await count("org-posture-hardened");
    const mrmBefore = await count("mrm-enforcement-enabled");
    const before = await loadOrgSettings(db);

    await withAuditFailure(async () => {
      const res = await harden({});
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      const after = await loadOrgSettings(db);
      expect(after.defaultPiiMode).toBe("none");
      expect(after.mrmEnforced).toBe(false);
      expect(after.mcpAdmissionMode).toBe("enforce");
      expect(after.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
      expect(await count("org-posture-hardened")).toBe(presetBefore);
      expect(await count("mrm-enforcement-enabled")).toBe(mrmBefore);
    });

    // positive control: with the injection removed the same request applies,
    // so the rollback above was the transaction and not a broken route
    const retried = await harden({});
    expect(retried.statusCode).toBe(200);
    expect(retried.json().applied.defaultPiiMode).toEqual(["none", "block"]);
    expect(await count("org-posture-hardened")).toBe(presetBefore + 1);
    expect(await count("mrm-enforcement-enabled")).toBe(mrmBefore + 1);
    await restoreShippedDefaults();
  });
});

describe("retry — a second application is a no-op in every observable way", () => {
  it("applies nothing, mints nothing, and leaves updatedAt alone", async () => {
    await restoreShippedDefaults();
    const first = await harden({});
    expect(Object.keys(first.json().applied).length).toBeGreaterThan(0);
    const presetAfterFirst = await count("org-posture-hardened");
    const mrmAfterFirst = await count("mrm-enforcement-enabled");
    const settingsAfterFirst = await loadOrgSettings(db);

    const second = await harden({});
    expect(second.statusCode).toBe(200);
    expect(second.json().applied).toEqual({});
    expect(second.json().alreadySatisfied).toContain("defaultPiiMode");
    expect(second.json().notSettable.length).toBeGreaterThan(0);
    expect(await count("org-posture-hardened")).toBe(presetAfterFirst);
    expect(await count("mrm-enforcement-enabled")).toBe(mrmAfterFirst);
    const settingsAfterSecond = await loadOrgSettings(db);
    expect(settingsAfterSecond.updatedAt?.getTime()).toBe(settingsAfterFirst.updatedAt?.getTime());
    await restoreShippedDefaults();
  });
});

describe("group inputs", () => {
  it("an EMPTY groups array means the default — enforcement only, optimisation untouched", async () => {
    await restoreShippedDefaults();
    const res = await harden({ groups: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied.defaultPiiMode).toBeDefined();
    expect(res.json().applied.semanticCachePolicy).toBeUndefined();
    expect((await loadOrgSettings(db)).semanticCachePolicy).toBe("opt_in");
    await restoreShippedDefaults();
  });

  it("DUPLICATE groups are one group: applied once, audited once, recorded de-duplicated", async () => {
    await restoreShippedDefaults();
    const presetBefore = await count("org-posture-hardened");
    const res = await harden({ groups: ["enforcement", "enforcement"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied.defaultPiiMode).toEqual(["none", "block"]);
    expect(await count("org-posture-hardened")).toBe(presetBefore + 1);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "org-posture-hardened"))
      .orderBy(sql`${auditLog.at} desc`).limit(1);
    expect((row!.detail as { groups: string[] }).groups).toEqual(["enforcement"]);
    expect(row!.reason).toContain("applied to enforcement:");
    expect(row!.reason).not.toContain("enforcement + enforcement");
    await restoreShippedDefaults();
  });

  it("an UNKNOWN group — alone or beside a valid one — is refused and changes nothing", async () => {
    await restoreShippedDefaults();
    const presetBefore = await count("org-posture-hardened");
    const before = await loadOrgSettings(db);
    for (const groups of [["bogus"], ["enforcement", "bogus"]]) {
      const res = await harden({ groups });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("unknown_posture_group");
      expect(res.json().detail).toContain("Nothing was changed");
    }
    const after = await loadOrgSettings(db);
    expect(after.defaultPiiMode).toBe("none");
    expect(after.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
    expect(await count("org-posture-hardened")).toBe(presetBefore);
  });

  it("a NON-ARRAY groups value is refused and changes nothing", async () => {
    await restoreShippedDefaults();
    const presetBefore = await count("org-posture-hardened");
    for (const groups of ["enforcement", 1, { enforcement: true }]) {
      const res = await harden({ groups });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_posture_groups");
    }
    expect((await loadOrgSettings(db)).defaultPiiMode).toBe("none");
    expect(await count("org-posture-hardened")).toBe(presetBefore);
  });
});
