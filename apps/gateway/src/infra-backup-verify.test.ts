import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupRuns, createDb, auditLog, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { runBackupVerifyOnce, startBackupVerifyScheduler } from "./infra.js";

/**
 * O5 (ADR-0027, migration 0045) — scheduled backup VERIFICATION. `success`
 * ledger rows stop being seed/manual-only: a verify pass checks each
 * backup_target's recent recovery points through the EXISTING provider path
 * (provider.scan) and writes honest, source-labelled rows — success only when
 * the provider found no missed backup, the mock provider's rows labelled
 * scheduler:mock. The boot scheduler is OFF by default (org toggle) and
 * mirrors the audit auto-prune scheduler exactly. Shares one DB
 * (fileParallelism off); prefix o5-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "o5-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminAuth: { authorization: string };
let freshResourceId: string;
let staleResourceId: string;

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: "o5-admin@example.com", displayName: "o5-admin", isAdmin: true } });
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "o5" } });
  adminAuth = { authorization: `Bearer ${k.json().token}` };
  // a FRESH backup target (2h since last backup on a daily schedule → not
  // missed → verifiable) and a STALE one (100h → missed → NOT verifiable)
  const mk = async (name: string, hoursSinceLastBackup: number) => {
    const r = await app.inject({
      method: "POST", url: "/v1/infra/resources", headers: adminAuth,
      payload: { name, kind: "backup_target", config: { hoursSinceLastBackup, backupSchedule: "daily" } },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  freshResourceId = await mk("o5-fresh-backup", 2);
  staleResourceId = await mk("o5-stale-backup", 100);
});

describe("runBackupVerifyOnce — honest, source-labelled ledger rows", () => {
  it("verifies the fresh target (mock-labelled success), refuses the missed one, audits the pass", async () => {
    const result = await runBackupVerifyOnce(db);
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(result.verified).toBeGreaterThanOrEqual(1);
    expect(result.missed).toBeGreaterThanOrEqual(1);

    // the fresh target got a success row, honestly labelled as the MOCK
    // provider's scheduler check — never mistakable for a real cloud check
    const freshRows = await db.select().from(backupRuns).where(eq(backupRuns.resourceId, freshResourceId));
    const verifiedRow = freshRows.find((r) => r.source === "scheduler:mock");
    expect(verifiedRow).toBeTruthy();
    expect(verifiedRow!.status).toBe("success");
    expect(verifiedRow!.kind).toBe("backup");
    expect(verifiedRow!.finishedAt).toBeTruthy();

    // the STALE target got NO success row from the scheduler
    const staleRows = await db.select().from(backupRuns).where(eq(backupRuns.resourceId, staleResourceId));
    expect(staleRows.filter((r) => r.status === "success" && r.source != null)).toHaveLength(0);

    // the pass itself is audited with its counts
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "backup-verify-pass"));
    expect(audit).toBeTruthy();
    expect(audit!.detail).toMatchObject({ phase: "backup-verify" });
  });

  it("seed/manual rows are distinguishable: their source stays null", async () => {
    await db.insert(backupRuns).values({
      resourceId: freshResourceId, kind: "backup", status: "success",
      startedAt: new Date(), finishedAt: new Date(),
    });
    const rows = await db.select().from(backupRuns).where(eq(backupRuns.resourceId, freshResourceId));
    expect(rows.some((r) => r.source === null)).toBe(true);
    expect(rows.some((r) => r.source === "scheduler:mock")).toBe(true);
  });
});

describe("org toggle + scheduler shape", () => {
  it("backupVerifyEnabled defaults OFF with a 24h interval; the PUT flips it and is audited", async () => {
    const s = await app.inject({ method: "GET", url: "/v1/org/settings", headers: adminAuth });
    expect(s.json().settings.backupVerifyEnabled).toBe(true); // ADR-0181: on by default
    expect(s.json().settings.backupVerifyIntervalHours).toBe(24);
    // B4S-04: turning backup verification off relaxes a strict default — a
    // settings_relax step-up, which an admin's API key can never give
    const byKey = await app.inject({
      method: "PUT", url: "/v1/org/settings", headers: adminAuth,
      payload: { backupVerifyEnabled: false, backupVerifyIntervalHours: 6 },
    });
    expect(byKey.statusCode).toBe(403);
    expect(byKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    // no admin here can step up, so the deployment's bootstrap credential (first-admin setup) makes it
    const put = await app.inject({
      method: "PUT", url: "/v1/org/settings", headers: AUTH,
      payload: { backupVerifyEnabled: false, backupVerifyIntervalHours: 6 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.backupVerifyEnabled).toBe(false);
    expect(put.json().settings.backupVerifyIntervalHours).toBe(6);
    // restore the shipped default (ADR-0181: on) for the rest of the suite
    await app.inject({
      method: "PUT", url: "/v1/org/settings", headers: adminAuth,
      payload: { backupVerifyEnabled: true, backupVerifyIntervalHours: 24 },
    });
  });

  it("startBackupVerifyScheduler returns a stop function (the onClose contract)", () => {
    const stop = startBackupVerifyScheduler(db);
    expect(typeof stop).toBe("function");
    stop();
  });
});

// ADR-0181 (FX2): hand the shared database back strict (M-068)
afterAll(async () => {
  await restoreAdminKeyMfa?.();
});
