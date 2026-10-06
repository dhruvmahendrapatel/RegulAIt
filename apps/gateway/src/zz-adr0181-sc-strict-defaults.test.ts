/**
 * ADR-0181 (agent SC) — admission, infrastructure and monitors ship STRICT.
 *
 * Each flip is proved on a FRESH org: a scratch database migrated from empty,
 * whose org_settings singleton nobody has touched. Two paths are pinned for
 * each org_settings default, because both are how a deployment gets its row:
 *
 *   1. the row migration 0038 inserted, as migration 0159 left it;
 *   2. a row created by `loadOrgSettings` from the COLUMN DEFAULTS (the
 *      belt-and-braces singleton creation).
 *
 * A third path pins 0159's "as for a first load" UPDATE: a database migrated
 * up to 0158 with the OLD lax values written, then migrated to head, reads
 * strict.
 *
 * Then: every strict value stays relaxable by an admin through its existing
 * write route, and the audit row records old -> new; the spend monitor's
 * no-row fallback agrees with its column default; the env knobs (database TLS,
 * scheduler) resolve strict from an empty environment and the posture read
 * says "relaxed" when TLS is off; and the strict MCP posture really refuses a
 * private address and really quarantines a server registered now.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  databaseTlsBootWarning,
  databaseTlsPosture,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  resolveDbPoolConfig,
  runMigrations,
  spendMonitorPolicies,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { loadOrgSettings } from "./org-settings.js";
import { effectivePolicy } from "./spend-monitor.js";
import { buildPostureReport } from "./posture-preset.js";
import { describeEgressPosture, resolveEgressPosture } from "./deploy-posture.js";
import { resolveSchedulerConfig } from "./scheduler.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { SC_LAX_POSTURE, SC_STRICT_DEFAULTS } from "./testing/strict-admission.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = `${process.pid}_${Date.now()}`;
const FRESH_DB = `sdsc_fresh_${RUN}`;
const UPGRADE_DB = `sdsc_upgrade_${RUN}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const BOOT = "adr0181-sc-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
const NIL = "00000000-0000-0000-0000-000000000000";

let admin: Db;
let fresh: Db;
let upgrade: Db;
let tmpMigrations: string | null = null;

const pick = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(SC_STRICT_DEFAULTS).map((k) => [k, row[k]]));

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  for (const name of [FRESH_DB, UPGRADE_DB]) {
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${name}`));
  }
  fresh = createDb(urlFor(FRESH_DB));
  await runMigrations(fresh, migrationsFolder);
}, 120_000);

afterAll(async () => {
  await closeAll([
    async () => fresh?.$client.end(),
    async () => upgrade?.$client.end(),
    async () => dropScratchDatabase(admin, FRESH_DB),
    async () => dropScratchDatabase(admin, UPGRADE_DB),
    async () => admin.$client.end(),
    async () => {
      if (tmpMigrations) rmSync(tmpMigrations, { recursive: true, force: true });
    },
  ]);
});

describe("ADR-0181 SC — a fresh org reads every admission/monitor default STRICT", () => {
  it("the migrated singleton (0038's row, as 0159 left it)", async () => {
    const row = await loadOrgSettings(fresh);
    expect(pick(row)).toEqual(SC_STRICT_DEFAULTS);
  });

  it("a singleton created from the COLUMN DEFAULTS (no row present)", async () => {
    await fresh.delete(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const row = await loadOrgSettings(fresh);
    expect(pick(row)).toEqual(SC_STRICT_DEFAULTS);
  });

  it("spend monitor: a new policy row and the no-row fallback are both ENABLED", async () => {
    const [row] = await fresh.insert(spendMonitorPolicies).values({ projectId: null }).returning();
    expect(row!.enabled).toBe(true);
    await fresh.delete(spendMonitorPolicies);
    // no project row and no org-default row: the built-in fallback
    const fallback = await effectivePolicy(fresh, NIL);
    expect(fallback.enabled).toBe(true);
  });

  it("0159 updates EXISTING rows as for a first load (a database at 0158 with the old lax values)", async () => {
    // a migrations folder whose journal stops before 0159
    tmpMigrations = mkdtempSync(path.join(tmpdir(), "sdsc-mig-"));
    cpSync(migrationsFolder, tmpMigrations, { recursive: true });
    const journalPath = path.join(tmpMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    // cut every entry FROM 0159 on, so 0159 is the newest migration the second
    // run applies over 0158: the migrator skips any entry older than the newest
    // one applied, so leaving a later one (0160, 0161, …) in at this step would
    // make the second run never apply 0159 at all
    const cut = journal.entries.find((e) => e.tag === "0159_strict_admission_infra")!.idx;
    journal.entries = journal.entries.filter((e) => e.idx < cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    upgrade = createDb(urlFor(UPGRADE_DB));
    await runMigrations(upgrade, tmpMigrations);
    await loadOrgSettings(upgrade);
    await upgrade.update(orgSettings).set({ ...SC_LAX_POSTURE }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await upgrade.insert(spendMonitorPolicies).values({ projectId: null, enabled: false });
    expect(pick(await loadOrgSettings(upgrade))).toEqual(SC_LAX_POSTURE);

    await runMigrations(upgrade, migrationsFolder);
    expect(pick(await loadOrgSettings(upgrade))).toEqual(SC_STRICT_DEFAULTS);
    const [policy] = await upgrade.select().from(spendMonitorPolicies);
    expect(policy!.enabled).toBe(true);
  }, 120_000);
});

describe("ADR-0181 SC — every strict value stays relaxable by an admin, audited old -> new", () => {
  it("PUT /v1/org/settings relaxes all six and the audit row names each previous value", async () => {
    const app = buildApp(fresh, { bootstrapToken: BOOT, dataKey: DATA_KEY });
    try {
      const before = pick(await loadOrgSettings(fresh));
      expect(before).toEqual(SC_STRICT_DEFAULTS);
      const res = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: SC_LAX_POSTURE });
      expect(res.statusCode, res.body).toBe(200);
      expect(pick(res.json().settings)).toEqual(SC_LAX_POSTURE);
      const [row] = await fresh
        .select()
        .from(auditLog)
        .where(eq(auditLog.ruleId, "org-settings-updated"))
        .orderBy(desc(auditLog.at))
        .limit(1);
      const detail = row!.detail as { changed: Record<string, unknown>; transitions: Record<string, unknown> };
      expect(detail.changed).toEqual(SC_LAX_POSTURE);
      expect(detail.transitions).toEqual(
        Object.fromEntries(
          Object.entries(SC_LAX_POSTURE).map(([k, to]) => [k, { from: (SC_STRICT_DEFAULTS as Record<string, unknown>)[k], to }]),
        ),
      );
      // and back to strict, audited the other way round
      const back = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: SC_STRICT_DEFAULTS });
      expect(back.statusCode, back.body).toBe(200);
      expect(pick(await loadOrgSettings(fresh))).toEqual(SC_STRICT_DEFAULTS);
    } finally {
      await app.close();
    }
  });

  it("PUT /v1/spend/monitor-policies switches the org default off, and the audit row carries enabled true -> false", async () => {
    const app = buildApp(fresh, { bootstrapToken: BOOT, dataKey: DATA_KEY });
    try {
      await fresh.delete(spendMonitorPolicies);
      const res = await app.inject({
        method: "PUT",
        url: "/v1/spend/monitor-policies",
        headers: AUTH,
        payload: { enabled: false },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().policy.enabled).toBe(false);
      const [row] = await fresh
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "spend-monitor-policy-updated")))
        .orderBy(desc(auditLog.at))
        .limit(1);
      const detail = row!.detail as { enabled: boolean; transitions: Record<string, { from: unknown; to: unknown }> };
      expect(detail.enabled).toBe(false);
      expect(detail.transitions.enabled).toEqual({ from: true, to: false });
    } finally {
      await fresh.delete(spendMonitorPolicies);
      await app.close();
    }
  });
});

describe("ADR-0181 SC — the strict MCP posture really refuses on a fresh org", () => {
  it("a private-range MCP URL is refused at registration (mcpPrivateRangesDefault=false), and an allow entry opens it", async () => {
    const app = buildApp(fresh, { bootstrapToken: BOOT, dataKey: DATA_KEY });
    try {
      const refused = await app.inject({
        method: "POST",
        url: "/v1/servers",
        headers: AUTH,
        payload: { name: `sdsc-private-${RUN}`, url: "http://127.0.0.1:9/mcp" },
      });
      expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
      expect(refused.body).toMatch(/private|allow/i);

      const allow = await app.inject({
        method: "POST",
        url: "/v1/egress-allow-hosts",
        headers: AUTH,
        payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "adr0181 test" },
      });
      expect(allow.statusCode, allow.body).toBe(201);
      const ok = await app.inject({
        method: "POST",
        url: "/v1/servers",
        headers: AUTH,
        payload: { name: `sdsc-private-${RUN}`, url: "http://127.0.0.1:9/mcp" },
      });
      expect(ok.statusCode, ok.body).toBe(201);

      // ...and a server registered NOW is in release-age quarantine (7 days)
      const q = await app.inject({ method: "GET", url: "/v1/release-quarantine", headers: AUTH });
      expect(q.statusCode).toBe(200);
      expect(q.json().minReleaseAgeDays).toBe(7);
      expect((q.json().servers as Array<{ id: string }>).map((s) => s.id)).toContain(ok.json().id);
    } finally {
      await app.close();
    }
  });
});

describe("ADR-0181 SC — the env knobs resolve strict from an empty environment", () => {
  it("compiled vendor endpoints: the fresh org posture is strict on a hosted box, and the boot line says so", async () => {
    const org = await loadOrgSettings(fresh);
    expect(resolveEgressPosture({ mode: "hosted", orgPolicy: org.egressCompiledDefaultPolicy })).toBe("strict");
    expect(describeEgressPosture("hosted", org.egressCompiledDefaultPolicy)).toMatch(/STRICT egress/);
    expect(describeEgressPosture("hosted", "inherit")).toMatch(/RELAXED/);
  });

  it("database TLS is required by default; disable is RELAXED, warned loudly at boot, and on the posture read", async () => {
    expect(databaseTlsPosture(resolveDbPoolConfig({} as NodeJS.ProcessEnv))).toBe("required");
    expect(databaseTlsBootWarning(resolveDbPoolConfig({} as NodeJS.ProcessEnv))).toEqual([]);
    const off = resolveDbPoolConfig({ REGULAIT_DATABASE_SSL: "disable" } as NodeJS.ProcessEnv);
    expect(databaseTlsPosture(off)).toBe("relaxed");
    expect(databaseTlsBootWarning(off).join("\n")).toMatch(/DATABASE TLS IS OFF/);

    const settings = await loadOrgSettings(fresh);
    const relaxed = await buildPostureReport(settings, { sink: null, env: { REGULAIT_DATABASE_SSL: "disable" } });
    const tls = relaxed.controls.find((c) => c.key === "databaseTls")!;
    expect(tls.current).toBe("relaxed");
    expect(tls.satisfied).toBe(false);
    expect(relaxed.summary.blockedByEnvironment).toContain("databaseTls");
    const strict = await buildPostureReport(settings, { sink: null, env: {} });
    expect(strict.controls.find((c) => c.key === "databaseTls")!.current).toBe("required");
  });

  it("the scheduler is ON from an empty environment, and the posture read reports it satisfied", async () => {
    expect(resolveSchedulerConfig({} as NodeJS.ProcessEnv).enabled).toBe(true);
    const settings = await loadOrgSettings(fresh);
    const report = await buildPostureReport(settings, { sink: null, env: {} });
    expect(report.controls.find((c) => c.key === "schedulerEnabled")!.satisfied).toBe(true);
  });
});
