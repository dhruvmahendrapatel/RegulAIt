/**
 * ADR-0181 security review — FX3's findings, each pinned by a test that fails
 * without its fix:
 *
 *   2.  a DATABASE_URL can no longer silently turn database TLS off: the URL's
 *       `sslmode` / `ssl` count toward the posture, and a URL weaker than
 *       REGULAIT_DATABASE_SSL refuses to boot (`createDb` throws);
 *   6.  the guardrail window has a SERVER-SIDE limit (migration 0161): a window
 *       override carries `created_by = 'assurance-window'` and an expiry, the
 *       resolver ignores it once expired, the scheduler sweep deletes it with an
 *       audit row, the window copies the org's other modes, and a re-run
 *       reclaims its own leftovers;
 *   7.  the demo seed refuses without an explicit demo signal, and refuses a
 *       database that has a real admin — writing nothing either way;
 *   11b. the guardrail override DELETE records `detail.transitions`.
 *
 * Runs on its own scratch database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DatabaseTlsRefusedError,
  auditLog,
  connectionStringTls,
  count,
  createDb,
  databaseTlsBootWarning,
  databaseTlsPosture,
  databaseTlsRefusal,
  desc,
  eq,
  guardrailConfigs,
  resolveDbPoolConfig,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { ASSURANCE_WINDOW_MAX_MINUTES, runGuardrailWindowExpirySweep } from "./guardrails.js";
import { GUARDRAIL_WINDOW_EXPIRY_JOB_NAME, schedulerJobRegistry } from "./scheduler-jobs.js";
import { demoSeedRefusal, demoSeedSignal, realAdminEmails } from "./seed-demo-guard.js";
import { ASSURANCE_WINDOW_TTL_MINUTES, openAssuranceGuardrailWindow } from "./seed-strict-data.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const seedScript = path.resolve(here, "../dist/seed.js");

const stamp = `${process.pid}_${Date.now()}`;
const SCRATCH_DB = `regulait_fx3_${stamp}`;
const EMPTY_DB = `regulait_fx3_empty_${stamp}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const BOOT = "fx3-strict-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  for (const name of [SCRATCH_DB, EMPTY_DB]) {
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${name}`));
  }
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
}, 120_000);

afterAll(async () => {
  await closeAll([
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => dropScratchDatabase(admin, EMPTY_DB),
    async () => admin?.$client.end(),
  ]);
});

async function inject(method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as "GET", url, headers: AUTH, ...(payload ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
}
const call = async (method: string, url: string, payload?: unknown) => inject(method, url, payload);

async function mkAgent(name: string): Promise<string> {
  const r = await inject("POST", "/v1/agents", {
    name,
    provider: "mock",
    tier: 0,
    costPerMTokIn: 1,
    costPerMTokOut: 1,
    model: "mock-fast",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const effective = async (agentId: string) => (await inject("GET", `/v1/guardrails/effective?agentId=${agentId}`)).body.modes;
const overrideRow = async (agentId: string) =>
  (await db.select().from(guardrailConfigs).where(eq(guardrailConfigs.scopeId, agentId)))[0];
async function latestAudit(ruleId: string) {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Finding 2 — the connection string cannot weaken TLS silently
// ---------------------------------------------------------------------------

describe("FX3 finding 2: DATABASE_URL and database TLS", () => {
  const base = "postgres://u:p@db.example.internal:5432/regulait";
  const plaintextForms = [
    ["?sslmode=disable", "sslmode=disable"],
    ["?sslmode=allow", "sslmode=allow"],
    ["?sslmode=prefer", "sslmode=prefer"],
    ["?ssl=0", "ssl=0"],
    ["?ssl=false", "ssl=false"],
    ["?application_name=x&SSLMODE=x&sslmode=DISABLE", "sslmode=disable"],
  ] as const;

  it.each(plaintextForms)("%s counts as RELAXED: posture relaxed and the loud boot warning prints", (q, param) => {
    const cfg = resolveDbPoolConfig({ DATABASE_URL: base + q } as NodeJS.ProcessEnv);
    expect(cfg.urlSsl).toEqual({ effect: "off", param });
    expect(databaseTlsPosture(cfg)).toBe("relaxed");
    const warning = databaseTlsBootWarning(cfg).join("\n");
    expect(warning).toMatch(/DATABASE TLS IS OFF/);
    expect(warning).toContain(param);
  });

  it.each(plaintextForms)("%s without REGULAIT_DATABASE_SSL=disable refuses to boot", (q, param) => {
    const refusal = databaseTlsRefusal(resolveDbPoolConfig({ DATABASE_URL: base + q } as NodeJS.ProcessEnv));
    expect(refusal).toContain(param);
    expect(refusal).toContain("REGULAIT_DATABASE_SSL=disable");
    // the real boot path: createDb throws before a pool exists
    expect(() => createDb(base + q, { ssl: "require" })).toThrow(DatabaseTlsRefusedError);
    expect(() => createDb(base + q, { ssl: "no-verify" })).toThrow(DatabaseTlsRefusedError);
  });

  it("with REGULAIT_DATABASE_SSL=disable as well, it boots, relaxed and said loudly", async () => {
    const cfg = resolveDbPoolConfig({ DATABASE_URL: `${base}?sslmode=disable`, REGULAIT_DATABASE_SSL: "disable" } as NodeJS.ProcessEnv);
    expect(databaseTlsRefusal(cfg)).toBeNull();
    expect(databaseTlsPosture(cfg)).toBe("relaxed");
    const d = createDb(`${base}?sslmode=disable`, { ssl: "off" }); // no connection is made
    await d.$client.end();
  });

  it("an unverified URL (sslmode=no-verify, libpq require) needs REGULAIT_DATABASE_SSL=no-verify", () => {
    for (const q of ["?sslmode=no-verify", "?uselibpqcompat=true&sslmode=require", "?uselibpqcompat=true&sslmode=verify-ca"]) {
      const strict = resolveDbPoolConfig({ DATABASE_URL: base + q } as NodeJS.ProcessEnv);
      expect(strict.urlSsl?.effect, q).toBe("no-verify");
      expect(databaseTlsPosture(strict), q).toBe("unverified");
      expect(databaseTlsRefusal(strict), q).toMatch(/certificate verification/);
      const allowed = resolveDbPoolConfig({ DATABASE_URL: base + q, REGULAIT_DATABASE_SSL: "no-verify" } as NodeJS.ProcessEnv);
      expect(databaseTlsRefusal(allowed), q).toBeNull();
    }
  });

  it("a URL that says nothing weaker leaves the posture to the environment", () => {
    for (const q of ["", "?sslmode=require", "?sslmode=verify-full", "?application_name=gw"]) {
      const cfg = resolveDbPoolConfig({ DATABASE_URL: base + q } as NodeJS.ProcessEnv);
      expect(connectionStringTls(base + q), q).toBeUndefined();
      expect(databaseTlsPosture(cfg), q).toBe("required");
      expect(databaseTlsRefusal(cfg), q).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 6 — the guardrail window's server-side limit (migration 0161)
// ---------------------------------------------------------------------------

describe("FX3 finding 6: the guardrail window expires on the server", () => {
  it("migration 0161: a window row cannot exist without an expiry, an admin row cannot carry one, the org row is never a window", async () => {
    const agentId = await mkAgent("fx3-check-agent");
    const bad = [
      sql`insert into guardrail_configs (scope, scope_id, created_by) values ('agent', ${agentId}, 'assurance-window')`,
      sql`insert into guardrail_configs (scope, scope_id, created_by, expires_at) values ('agent', ${agentId}, 'admin', now())`,
      sql`insert into guardrail_configs (scope, scope_id, created_by, expires_at) values ('org', null, 'assurance-window', now())`,
      sql`insert into guardrail_configs (scope, scope_id, created_by) values ('agent', ${agentId}, 'someone')`,
    ];
    for (const stmt of bad) await expect(db.execute(stmt)).rejects.toThrow();
  });

  it("a window override is tagged and time-boxed; the server caps its lifetime", async () => {
    const agentId = await mkAgent("fx3-window-cap");
    const tooLong = await inject("PUT", `/v1/guardrails/config/agent/${agentId}`, {
      modes: { prompt_injection: "warn" },
      assuranceWindow: { ttlMinutes: ASSURANCE_WINDOW_MAX_MINUTES + 1 },
    });
    expect(tooLong.status).toBe(400);
    const before = Date.now();
    const ok = await inject("PUT", `/v1/guardrails/config/agent/${agentId}`, {
      modes: { prompt_injection: "warn" },
      assuranceWindow: { ttlMinutes: 30 },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const row = await overrideRow(agentId);
    expect(row!.createdBy).toBe("assurance-window");
    const ms = row!.expiresAt!.getTime() - before;
    expect(ms).toBeGreaterThan(29 * 60_000);
    expect(ms).toBeLessThanOrEqual(31 * 60_000);
    const audit = await latestAudit("guardrail-config-updated");
    expect((audit!.detail as Record<string, unknown>).createdBy).toBe("assurance-window");
    expect((audit!.detail as Record<string, unknown>).expiresAt).toBe(row!.expiresAt!.toISOString());
    await inject("DELETE", `/v1/guardrails/config/agent/${agentId}`);
  });

  it("a window never replaces an admin's override (409), and an admin write over a window is durable and inherits nothing from it", async () => {
    const tuned = await mkAgent("fx3-admin-tuned");
    await inject("PUT", `/v1/guardrails/config/agent/${tuned}`, { modes: { toxicity: "block" } });
    const refused = await inject("PUT", `/v1/guardrails/config/agent/${tuned}`, {
      modes: { prompt_injection: "warn" },
      assuranceWindow: { ttlMinutes: 30 },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("admin_override_exists");
    expect((await overrideRow(tuned))!.createdBy).toBe("admin");

    const windowed = await mkAgent("fx3-window-then-admin");
    await inject("PUT", `/v1/guardrails/config/agent/${windowed}`, {
      modes: { prompt_injection: "warn", jailbreak: "warn" },
      assuranceWindow: { ttlMinutes: 30 },
    });
    await inject("PUT", `/v1/guardrails/config/agent/${windowed}`, { modes: { toxicity: "block" } });
    const row = await overrideRow(windowed);
    expect(row!.createdBy).toBe("admin");
    expect(row!.expiresAt).toBeNull();
    // the window's relaxation did not leak into the admin's durable override
    expect(row!.promptInjectionMode).toBe("block");
    expect(row!.jailbreakMode).toBe("block");
    for (const id of [tuned, windowed]) await inject("DELETE", `/v1/guardrails/config/agent/${id}`);
  });

  it("an EXPIRED window override is ignored by the resolver: the org default applies again at once", async () => {
    const agentId = await mkAgent("fx3-expired");
    await inject("PUT", `/v1/guardrails/config/agent/${agentId}`, {
      modes: { prompt_injection: "warn", jailbreak: "warn" },
      assuranceWindow: { ttlMinutes: 30 },
    });
    expect((await effective(agentId)).prompt_injection).toBe("warn");
    await db
      .update(guardrailConfigs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(guardrailConfigs.scopeId, agentId));
    const modes = await effective(agentId);
    expect(modes.prompt_injection).toBe("block");
    expect(modes.jailbreak).toBe("block");
    const listed = (await inject("GET", "/v1/guardrails/config")).body.overrides as Array<{ scopeId: string; expired: boolean }>;
    expect(listed.find((o) => o.scopeId === agentId)?.expired).toBe(true);
    await inject("DELETE", `/v1/guardrails/config/agent/${agentId}`);
  });

  it("the scheduler sweep deletes expired window overrides and audits each (old -> new); a live window and an admin override stay", async () => {
    expect(schedulerJobRegistry({}).has(GUARDRAIL_WINDOW_EXPIRY_JOB_NAME)).toBe(true);
    const stale = await mkAgent("fx3-sweep-stale");
    const live = await mkAgent("fx3-sweep-live");
    const tuned = await mkAgent("fx3-sweep-admin");
    for (const id of [stale, live]) {
      await inject("PUT", `/v1/guardrails/config/agent/${id}`, {
        modes: { prompt_injection: "warn", jailbreak: "warn" },
        assuranceWindow: { ttlMinutes: 30 },
      });
    }
    await inject("PUT", `/v1/guardrails/config/agent/${tuned}`, { modes: { prompt_injection: "log" } });
    await db.update(guardrailConfigs).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(guardrailConfigs.scopeId, stale));

    // the registered job's own body, as the scheduler runs it
    const job = schedulerJobRegistry({}).get(GUARDRAIL_WINDOW_EXPIRY_JOB_NAME)!;
    const out = await job.run({ db, now: new Date(), actorUserId: null } as Parameters<typeof job.run>[0]);
    expect(out.itemsProcessed).toBe(1);
    expect(await overrideRow(stale)).toBeUndefined();
    expect(await overrideRow(live)).toBeDefined();
    expect(await overrideRow(tuned)).toBeDefined();

    const audit = await latestAudit("guardrail-window-expired");
    expect(audit).toBeDefined();
    const detail = audit!.detail as Record<string, any>;
    expect(detail.scopeId).toBe(stale);
    expect(detail.createdBy).toBe("assurance-window");
    expect(detail.transitions).toEqual({
      prompt_injection: { from: "warn", to: "block" },
      jailbreak: { from: "warn", to: "block" },
    });
    // nothing left to do on the next pass
    expect((await runGuardrailWindowExpirySweep(db)).expired).toBe(0);
    for (const id of [live, tuned]) await inject("DELETE", `/v1/guardrails/config/agent/${id}`);
  });

  it("the window copies the org's OTHER modes: it relaxes only prompt injection and jailbreak", async () => {
    const put = await inject("PUT", "/v1/guardrails/config", {
      modes: { prompt_injection: "block", jailbreak: "block", toxicity: "block", semantic_dlp: "block" },
    });
    expect(put.status).toBe(200);
    try {
      const agentId = await mkAgent("fx3-window-copies");
      const w = await openAssuranceGuardrailWindow(call, AUTH, [agentId]);
      expect(w.opened).toEqual([agentId]);
      expect(await effective(agentId)).toMatchObject({
        prompt_injection: "warn",
        jailbreak: "warn",
        toxicity: "block",
        semantic_dlp: "block",
      });
      const row = await overrideRow(agentId);
      expect(row!.createdBy).toBe("assurance-window");
      expect(row!.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(ASSURANCE_WINDOW_TTL_MINUTES * 60_000);
      expect(await w.restore()).toEqual([]);
      expect(await overrideRow(agentId)).toBeUndefined();
    } finally {
      // M-068: back to the shipped posture (no org row)
      await db.delete(guardrailConfigs).where(eq(guardrailConfigs.scope, "org"));
    }
  });

  it("a re-run RECLAIMS its own leftover window rows (a crashed run) and still leaves an admin's override alone", async () => {
    const crashed = await mkAgent("fx3-leftover");
    const tuned = await mkAgent("fx3-leftover-admin");
    // what a run that died between open and restore leaves behind
    await inject("PUT", `/v1/guardrails/config/agent/${crashed}`, {
      modes: { prompt_injection: "warn", jailbreak: "warn" },
      assuranceWindow: { ttlMinutes: 30 },
    });
    await inject("PUT", `/v1/guardrails/config/agent/${tuned}`, { modes: { prompt_injection: "block" } });
    const w = await openAssuranceGuardrailWindow(call, AUTH, [crashed, tuned]);
    expect(w.opened, w.notes.join("\n")).toEqual([crashed]);
    expect(w.notes.some((n) => /reclaimed 1 leftover window override/.test(n))).toBe(true);
    expect(w.notes.some((n) => n.includes(`agent ${tuned} has an admin guardrail override`))).toBe(true);
    expect(await w.restore()).toEqual([]);
    expect(await overrideRow(crashed)).toBeUndefined();
    expect((await overrideRow(tuned))!.createdBy).toBe("admin");
    await inject("DELETE", `/v1/guardrails/config/agent/${tuned}`);
  });
});

// ---------------------------------------------------------------------------
// Finding 11b — the override DELETE records transitions
// ---------------------------------------------------------------------------

describe("FX3 finding 11b: deleting a guardrail override is audited old -> new", () => {
  it("records detail.transitions from the override's modes to the org default in force", async () => {
    const agentId = await mkAgent("fx3-delete-transitions");
    await inject("PUT", `/v1/guardrails/config/agent/${agentId}`, { modes: { prompt_injection: "log", toxicity: "off" } });
    const del = await inject("DELETE", `/v1/guardrails/config/agent/${agentId}`);
    expect(del.status).toBe(200);
    const audit = await latestAudit("guardrail-config-deleted");
    expect((audit!.detail as Record<string, any>).transitions).toEqual({
      prompt_injection: { from: "log", to: "block" },
      toxicity: { from: "off", to: "warn" },
    });
  });
});

// ---------------------------------------------------------------------------
// Finding 7 — the demo seed never reaches a real install
// ---------------------------------------------------------------------------

describe("FX3 finding 7: the demo seed needs an explicit signal and no real admin", () => {
  it("the signal is --seed-demo or REGULAIT_DEMO_LICENSE=1 (one Windows CR tolerated), nothing else", () => {
    expect(demoSeedSignal([], {} as NodeJS.ProcessEnv)).toBeNull();
    expect(demoSeedSignal(["--seed-demo"], {} as NodeJS.ProcessEnv)).toBe("--seed-demo");
    expect(demoSeedSignal([], { REGULAIT_DEMO_LICENSE: "1" } as NodeJS.ProcessEnv)).toBe("REGULAIT_DEMO_LICENSE=1");
    expect(demoSeedSignal([], { REGULAIT_DEMO_LICENSE: "1\r" } as NodeJS.ProcessEnv)).toBe("REGULAIT_DEMO_LICENSE=1");
    for (const v of ["0", "true", " 1", "", "1\r\r"]) {
      expect(demoSeedSignal([], { REGULAIT_DEMO_LICENSE: v, SEED_DEMO: "1" } as NodeJS.ProcessEnv), v).toBeNull();
    }
    expect(demoSeedRefusal(null, [])).toMatch(/--seed-demo/);
    expect(demoSeedRefusal("--seed-demo", [])).toBeNull();
    expect(demoSeedRefusal("--seed-demo", ["owner@corp.example"])).toMatch(/owner@corp\.example/);
  });

  it("an admin who is not a demo persona is a real admin", async () => {
    expect(await realAdminEmails(db)).toEqual([]);
    const ada = await inject("POST", "/v1/users", { email: "admin@regulait.local", displayName: "Ada Admin", isAdmin: true });
    expect(ada.status).toBe(201);
    expect(await realAdminEmails(db)).toEqual([]);
    const owner = await inject("POST", "/v1/users", { email: "owner@corp.example", displayName: "Owner", isAdmin: true });
    expect(owner.status).toBe(201);
    expect(await realAdminEmails(db)).toEqual(["owner@corp.example"]);
  });

  const runSeed = (dbName: string, args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [seedScript, ...args], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: urlFor(dbName), REGULAIT_BOOTSTRAP_TOKEN: "fx3-seed-boot", REGULAIT_DEMO_LICENSE: "", ...extraEnv },
      timeout: 120_000,
    });

  it("the BUILT seed refuses without a demo signal and writes nothing (not even migrations)", async () => {
    const r = runSeed(EMPTY_DB, []);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/Refusing to seed/);
    expect(r.stderr).toMatch(/--seed-demo/);
    const empty = createDb(urlFor(EMPTY_DB));
    try {
      const res = (await empty.execute(sql`select to_regclass('public.users') is not null as present`)) as unknown as {
        rows: Array<{ present: boolean }>;
      };
      expect(res.rows[0]!.present).toBe(false);
    } finally {
      await empty.$client.end();
    }
  }, 120_000);

  it("the BUILT seed, WITH the signal, refuses a database that has a real admin, and writes nothing", async () => {
    // the scratch database holds owner@corp.example (an admin) from the test above
    const auditBefore = (await db.select({ n: count() }).from(auditLog))[0]!.n;
    const usersBefore = (await db.select({ n: count() }).from(users))[0]!.n;
    const r = runSeed(SCRATCH_DB, ["--seed-demo"]);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/admin who is not a demo persona \(owner@corp\.example\)/);
    expect((await db.select({ n: count() }).from(auditLog))[0]!.n).toBe(auditBefore);
    expect((await db.select({ n: count() }).from(users))[0]!.n).toBe(usersBefore);
    const dana = await db.select().from(users).where(eq(users.email, "dana@regulait.local"));
    expect(dana).toEqual([]);
  }, 120_000);
});
