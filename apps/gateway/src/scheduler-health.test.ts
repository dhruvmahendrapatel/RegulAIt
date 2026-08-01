/**
 * ADR-0031 item 6 — the two boot schedulers no longer fail silently.
 *
 * Both used to swallow every failure in a bare `catch { }`: no log, no audit
 * row, no health surface, so a permanently failing backup verification looked
 * exactly like one that was switched off. These tests drive one real tick of
 * each scheduler (the tick is exported for exactly this reason) in both the
 * success and the failure direction, and check all three observability
 * channels — including the worst case where the DATABASE is what broke, so the
 * audit write fails too and only the log and the in-memory record survive.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { auditPruneTick, type SchedulerTickState } from "./org-settings.js";
import { backupVerifyTick } from "./infra.js";
import { resetSchedulerHealth, schedulerHealth } from "./scheduler-health.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "sched-health-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

/** a Db whose reads always fail — the shape of "org settings could not be
 * loaded", which is how a real tick most often dies. Writes still work, so the
 * failure audit row can land. */
function readBrokenDb(real: Db): Db {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "select") {
        return () => {
          throw new Error("connection terminated unexpectedly");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

/** a Db where NOTHING works — the audit row cannot be written either */
function totallyBrokenDb(real: Db): Db {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "select" || prop === "insert") {
        return () => {
          throw new Error("the database is gone");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

const fresh = (): SchedulerTickState => ({ lastRunAt: 0 });

async function latestAudit(ruleId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row ?? null;
}

async function setOrg(payload: Record<string, unknown>) {
  const res = await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  resetSchedulerHealth();
});

describe("ADR-0031: the scheduler health surface", () => {
  it("is admin-only and starts empty (neither scheduler has ticked)", async () => {
    resetSchedulerHealth();
    const anon = await app.inject({ method: "GET", url: "/v1/health/schedulers" });
    expect(anon.statusCode).toBe(401);

    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/health/schedulers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedulers).toEqual([]);
    // an empty list is absence of failures, not proof of success — the payload
    // says so rather than letting a dashboard render a green tick
    expect(res.json().note).toContain("OFF by default");
  });

  it("is NOT folded into /health — a failing backup pass must not read as a dead gateway", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).not.toHaveProperty("schedulers");
  });
});

describe("ADR-0031: audit auto-prune failures are observable", () => {
  it("a successful tick marks the scheduler healthy", async () => {
    resetSchedulerHealth();
    await setOrg({ autoPruneEnabled: true });
    await auditPruneTick(db, fresh());

    const [row] = schedulerHealth().filter((s) => s.name === "audit-prune");
    expect(row).toBeTruthy();
    expect(row!.healthy).toBe(true);
    expect(row!.failures).toBe(0);
    expect(row!.lastSuccessAt).toBeTruthy();
  });

  it("a failing tick logs, writes a deny-effect audit row, and flips the health surface", async () => {
    resetSchedulerHealth();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // never throws out of the tick — the gateway must survive
    await expect(auditPruneTick(readBrokenDb(db), fresh())).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]![0])).toContain("audit-prune");

    const audited = await latestAudit("audit-prune-failed");
    expect(audited).toBeTruthy();
    expect(audited!.effect).toBe("deny");
    expect(audited!.objectType).toBe("project");
    expect(audited!.reason).toContain("connection terminated");
    expect(audited!.detail).toMatchObject({ outcome: "failed", auto: true, consecutiveFailures: 1 });

    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/health/schedulers" });
    const row = res.json().schedulers.find((s: { name: string }) => s.name === "audit-prune");
    expect(row.healthy).toBe(false);
    expect(row.failures).toBe(1);
    expect(row.lastError).toContain("connection terminated");
    expect(res.json().healthy).toBe(false);
  });

  it("counts consecutive failures and clears them on the next success", async () => {
    resetSchedulerHealth();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = readBrokenDb(db);
    await auditPruneTick(broken, fresh());
    await auditPruneTick(broken, fresh());
    await auditPruneTick(broken, fresh());

    let row = schedulerHealth().find((s) => s.name === "audit-prune")!;
    expect(row.consecutiveFailures).toBe(3);
    expect(row.failures).toBe(3);
    expect(row.healthy).toBe(false);

    await auditPruneTick(db, fresh());
    row = schedulerHealth().find((s) => s.name === "audit-prune")!;
    expect(row.consecutiveFailures).toBe(0);
    expect(row.healthy).toBe(true);
    expect(row.failures).toBe(3); // the history is not rewritten
  });

  it("survives the worst case: the database is what broke, so even the audit row cannot be written", async () => {
    resetSchedulerHealth();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(auditPruneTick(totallyBrokenDb(db), fresh())).resolves.toBeUndefined();

    // two logs: the failure itself, and the admission that it could not be audited
    expect(logged.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(logged.mock.calls.map((c) => String(c[0])).join("\n")).toContain("could not audit");

    // the in-memory record still answers — it does not depend on the database
    const row = schedulerHealth().find((s) => s.name === "audit-prune")!;
    expect(row.healthy).toBe(false);
    expect(row.lastError).toContain("the database is gone");
  });
});

describe("ADR-0031: backup-verification failures are observable", () => {
  it("a successful tick marks it healthy; a failing one audits under its own rule id", async () => {
    resetSchedulerHealth();
    await setOrg({ backupVerifyEnabled: true });
    await backupVerifyTick(db, fresh());
    expect(schedulerHealth().find((s) => s.name === "backup-verify")!.healthy).toBe(true);

    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(backupVerifyTick(readBrokenDb(db), fresh())).resolves.toBeUndefined();

    const audited = await latestAudit("backup-verify-failed");
    expect(audited).toBeTruthy();
    expect(audited!.effect).toBe("deny");
    // beside the successful backup-verify-pass rows, so one filter finds both
    expect(audited!.objectType).toBe("infra_operation");

    const row = schedulerHealth().find((s) => s.name === "backup-verify")!;
    expect(row.healthy).toBe(false);
    expect(row.failures).toBe(1);
  });

  it("a disabled scheduler is a no-op, not a failure", async () => {
    resetSchedulerHealth();
    await setOrg({ backupVerifyEnabled: false, autoPruneEnabled: false });
    await backupVerifyTick(db, fresh());
    await auditPruneTick(db, fresh());
    expect(schedulerHealth()).toEqual([]);
  });
});
