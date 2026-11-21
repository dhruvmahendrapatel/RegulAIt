/**
 * ADR-0359 (lane E40) — the behaviour baseline sweep against a real Postgres: the audit chain is rolled up per day,
 * the last complete day is compared with the 28 before it, a departure becomes a shadow finding that shows its
 * baseline (plus one chained audit row), a cold start makes no claim, a re-run adds nothing, its own rows are never
 * counted, and the admin API (settings with step-up on `off`, findings, the declared status lifecycle, baselines).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  auditLog,
  behaviourAnomalyFindings,
  behaviourBaselineSettings,
  createDb,
  eq,
  runAuditV2Cutover,
  runMigrations,
  sql,
  withPrincipal,
  withSystemContext,
  type Db,
} from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";
import { buildApp } from "./app.js";
import { backdated } from "./testing/backdated-audit.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { BEHAVIOUR_RULE_IDS, addDays, runBehaviourSweep } from "./behaviour/sweep.js";
import { BEHAVIOUR_FINDING_MACHINE } from "@regulait/shared";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0359-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let yesterday: string;
const restores: Array<() => Promise<void>> = [];

type Row = typeof auditLog.$inferInsert;
const row = (userId: string, at: string, over: Partial<Row> = {}): Row => ({
  userId,
  at: new Date(at),
  objectType: "agent",
  objectId: MODEL,
  effect: "allow",
  ruleId: "allow-list",
  ruleChain: [],
  reason: "adr0359 fixture",
  ...over,
});
const MODEL = randomUUID();
async function insert(rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) await backdated(db).insert(auditLog).values(rows.slice(i, i + 500));
}
/** move the cursor to the chain head and mark everything before yesterday evaluated, so a test reads only its rows */
async function toHead(): Promise<void> {
  await db.execute(sql`INSERT INTO behaviour_engine_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`UPDATE behaviour_engine_state SET cursor_seq = (SELECT coalesce(max(seq), 0) FROM audit_log),
                       evaluated_through = ${addDays(yesterday, -1)}::date, lease_until = NULL, lease_token = NULL`);
}
const findingsFor = (subjectId: string) => db.select().from(behaviourAnomalyFindings).where(eq(behaviourAnomalyFindings.subjectId, subjectId));
const asSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));
const asSteppedUp = async (facts: Record<string, unknown>) =>
  stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));

/** 27 baseline days of ~30 model calls and 5 read_file calls at 10:00, then the given rows yesterday */
function history(user: string, perDay = (i: number) => 28 + (i % 5)): Row[] {
  const out: Row[] = [];
  for (let back = 27; back >= 1; back--) {
    const day = addDays(yesterday, -back);
    for (let n = 0; n < perDay(back); n++) out.push(row(user, `${day}T10:00:00Z`));
    for (let n = 0; n < 5; n++) out.push(row(user, `${day}T10:30:00Z`, { objectType: "mcp_tool", objectId: null, toolName: "read_file" }));
  }
  return out;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0359-admin-${RUN}@example.com`, displayName: "behaviour admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0359" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
  const clock = (await db.execute(sql`SELECT to_char((now() AT TIME ZONE 'UTC')::date - 1, 'YYYY-MM-DD') AS y`)) as unknown as { rows: { y: string }[] };
  yesterday = clock.rows[0]!.y;
  await db.delete(behaviourBaselineSettings);
});

afterAll(async () => {
  await db.delete(behaviourBaselineSettings);
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

describe("ADR-0359 sweep: baselines from the install's own audit chain, shadow findings", () => {
  const user = randomUUID();
  const coldUser = randomUUID();

  it("records volume, first-seen tool and unusual-hour findings with their baselines, once", async () => {
    await toHead();
    await insert([
      ...history(user),
      // yesterday: 300 model calls at the usual hour, a first-seen tool, and one call at 03:00
      ...Array.from({ length: 300 }, () => row(user, `${yesterday}T10:00:00Z`)),
      row(user, `${yesterday}T10:15:00Z`, { objectType: "mcp_tool", objectId: null, toolName: "vault_get_secret" }),
      row(user, `${yesterday}T03:00:00Z`, { objectType: "mcp_tool", objectId: null, toolName: "read_file" }),
      // a subject with only three baseline days: a cold start, whatever yesterday looks like
      ...[3, 2, 1].flatMap((back) => Array.from({ length: 30 }, () => row(coldUser, `${addDays(yesterday, -back)}T10:00:00Z`))),
      ...Array.from({ length: 400 }, () => row(coldUser, `${yesterday}T10:00:00Z`)),
    ]);
    const out = await runBehaviourSweep(db, adminId);
    expect(out.outcome, JSON.stringify(out)).toBe("evaluated");
    expect(out.daysEvaluated).toEqual([yesterday]);

    const found = await findingsFor(user);
    const bySignal = Object.fromEntries(found.map((f) => [`${f.signal}:${f.key}`, f]));
    expect(Object.keys(bySignal).sort()).toEqual(["hour_of_day:03", "tool:vault_get_secret"].concat("model_calls:").sort());
    expect(bySignal["model_calls:"]).toMatchObject({ day: yesterday, subjectKind: "user", method: "mad_z", observed: 300, baselineDays: 27, baselineMedian: 30, status: "open" });
    expect(bySignal["model_calls:"]!.score!).toBeGreaterThan(3.5);
    expect(bySignal["model_calls:"]!.explanation).toContain("median 30");
    expect(bySignal["tool:vault_get_secret"]).toMatchObject({ method: "share_of_history", baselineKeyCount: 0, baselineTotal: 135, score: 0 });
    expect(bySignal["hour_of_day:03"]).toMatchObject({ method: "share_of_history", baselineKeyCount: 0 });

    expect(await findingsFor(coldUser)).toEqual([]);

    // one chained audit row per finding, carrying the finding id (the SIEM export path)
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, BEHAVIOUR_RULE_IDS.observed), eq(auditLog.objectId, bySignal["model_calls:"]!.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ objectType: "behaviour_baseline", effect: "allow", userId: adminId, detail: expect.objectContaining({ subjectKind: "user", subjectId: user }) });
    expect(audit[0]!.seq).not.toBeNull();
  });

  it("a second pass evaluates nothing new, a forced re-run adds no duplicate, and its own rows are never counted", async () => {
    const again = await runBehaviourSweep(db, adminId);
    expect(again.daysEvaluated).toEqual([]);
    await db.execute(sql`UPDATE behaviour_engine_state SET evaluated_through = ${addDays(yesterday, -1)}::date`);
    const rerun = await runBehaviourSweep(db, adminId);
    expect(rerun).toMatchObject({ daysEvaluated: [yesterday], findings: 0 });
    expect(await findingsFor(user)).toHaveLength(3);
    // the finding audit rows are the sweep's own act (userId = the sweep's actor, never the monitored user; review of
    // #966 R8 [3]), with the subject in `detail`, and are behaviour_baseline rows: never in anyone's counts
    const observed = await db.select().from(auditLog).where(eq(auditLog.ruleId, BEHAVIOUR_RULE_IDS.observed));
    const mine = observed.filter((a) => (a.detail as { subjectId?: string }).subjectId === user);
    expect(mine).toHaveLength(3);
    expect(mine.every((a) => a.userId === adminId)).toBe(true);
    const today = await db.execute(sql`SELECT coalesce(sum(count), 0)::int AS n FROM behaviour_daily_counts
                                       WHERE subject_id = ${user}::uuid AND day > ${yesterday}::date`);
    expect((today as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
  });

  it("a held lease is not claimed", async () => {
    await db.execute(sql`UPDATE behaviour_engine_state SET lease_until = now() + interval '1 minute', lease_token = ${randomUUID()}::uuid`);
    expect((await runBehaviourSweep(db, adminId)).outcome).toBe("not_claimed");
    await db.execute(sql`UPDATE behaviour_engine_state SET lease_until = NULL, lease_token = NULL`);
  });

  it("the finding API: list, one finding, the declared status lifecycle, audited", async () => {
    const list = await app.inject({ method: "GET", url: `/v1/behaviour/findings?subjectId=${user}&signal=model_calls`, headers: KEY });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ mode: "shadow", next: null });
    const [f] = list.json().findings;
    expect(f).toMatchObject({ signal: "model_calls", observed: 300, baselineMedian: 30 });

    const one = await app.inject({ method: "GET", url: `/v1/behaviour/findings/${f.id}`, headers: KEY });
    expect(one.json()).toMatchObject({ finding: { id: f.id }, lifecycle: { status: BEHAVIOUR_FINDING_MACHINE.describe("open") } });

    const url = `/v1/behaviour/findings/${f.id}/status`;
    expect((await app.inject({ method: "PUT", url, headers: KEY, payload: { status: "open" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url, headers: KEY, payload: { status: "acknowledged" } })).json()).toEqual({ id: f.id, status: "acknowledged" });
    const again = await app.inject({ method: "PUT", url, headers: KEY, payload: { status: "acknowledged" } });
    expect(again.statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url, headers: KEY, payload: { status: "dismissed" } })).statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/v1/behaviour/findings/${f.id}`, headers: KEY });
    expect(after.json().lifecycle.status).toMatchObject({ state: "dismissed", terminal: true });
    expect((await app.inject({ method: "PUT", url, headers: KEY, payload: { status: "acknowledged" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/v1/behaviour/findings/${randomUUID()}/status`, headers: KEY, payload: { status: "dismissed" } })).statusCode).toBe(404);
    const audited = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, BEHAVIOUR_RULE_IDS.findingStatus), eq(auditLog.objectId, f.id)));
    expect(audited.map((a) => (a.detail as { status: string }).status).sort()).toEqual(["acknowledged", "dismissed"]);
  });

  it("the baseline view shows median and MAD per volume signal and the usual keys per category", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/behaviour/baselines/user/${user}`, headers: KEY });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json().signals;
    // the window ends the day before today, so yesterday's spike is part of this view
    expect(s.model_calls).toMatchObject({ kind: "volume", coldStart: false, median: 30 });
    expect(s.tool.top[0]).toMatchObject({ key: "read_file" });
    expect((await app.inject({ method: "GET", url: `/v1/behaviour/baselines/robot/${user}`, headers: KEY })).statusCode).toBe(400);
  });
});

describe("ADR-0359 agents: a workload identity is its own subject (scratch database, audit v2)", () => {
  it("baselines an agent from its delegated rows and records an agent finding", async () => {
    // Actor columns can be written only after the audit v2 cutover, which must not run on the shared database.
    const admin = createDb(DATABASE_URL!);
    const name = `adr0359_v2_${process.pid}_${RUN}`;
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${name}`));
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${name}`;
    const sdb = createDb(u.toString());
    try {
      await runMigrations(sdb, migrationsFolder);
      await runAuditV2Cutover(sdb, { setBy: null });
      const sponsor = randomUUID();
      const agent = randomUUID();
      const stamp = { actorIdentityId: agent, delegationGrantId: randomUUID(), actorChain: [agent] };
      const rows = [...history(sponsor), ...Array.from({ length: 300 }, () => row(sponsor, `${yesterday}T10:00:00Z`))].map((r) => ({ ...r, ...stamp }));
      for (let i = 0; i < rows.length; i += 500) await backdated(sdb).insert(auditLog).values(rows.slice(i, i + 500));
      await sdb.execute(sql`INSERT INTO behaviour_engine_state (id, evaluated_through) VALUES (1, ${addDays(yesterday, -1)}::date)`);
      const out = await runBehaviourSweep(sdb, null);
      expect(out.daysEvaluated, JSON.stringify(out)).toEqual([yesterday]);
      const found = await sdb.select().from(behaviourAnomalyFindings).where(eq(behaviourAnomalyFindings.signal, "model_calls"));
      expect(found.map((f) => `${f.subjectKind}:${f.subjectId}`).sort()).toEqual([`agent:${agent}`, `user:${sponsor}`].sort());
      expect(found.find((f) => f.subjectKind === "agent")).toMatchObject({ observed: 300, baselineMedian: 30, method: "mad_z" });
    } finally {
      await dropScratchDatabase(admin, name);
    }
  });
});

describe("ADR-0359 settings: shadow by default, off is a step-up relaxation", () => {
  it("reads shadow with no settings row and no enforcement", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/behaviour/settings", headers: KEY });
    expect(res.json()).toMatchObject({ mode: "shadow", enforcement: "none" });
  });

  it("refuses off without a step-up, takes it with one, skips the sweep, and turns back on without one", async () => {
    const refused = await app.inject({ method: "PUT", url: "/v1/behaviour/settings", ...(await asSession()), payload: { mode: "off" } });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    const ok = await app.inject({ method: "PUT", url: "/v1/behaviour/settings", ...(await asSteppedUp({ behaviourBaseline: "mode", from: "shadow", to: "off" })), payload: { mode: "off" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ mode: "off", changed: true });
    expect((await runBehaviourSweep(db, adminId)).outcome).toBe("off");
    const on = await app.inject({ method: "PUT", url: "/v1/behaviour/settings", headers: KEY, payload: { mode: "shadow" } });
    expect(on.json()).toEqual({ mode: "shadow", changed: true });
    const audited = await db.select().from(auditLog).where(eq(auditLog.ruleId, BEHAVIOUR_RULE_IDS.modeChanged)).orderBy(asc(auditLog.seq));
    expect(audited.slice(-2).map((a) => (a.detail as { to: string }).to)).toEqual(["off", "shadow"]);
    expect((await app.inject({ method: "PUT", url: "/v1/behaviour/settings", headers: KEY, payload: { mode: "enforce" } })).statusCode).toBe(400);
  });
});

describe("ADR-0359 row-level security and the admin gate (ADR-0234; review of #966)", () => {
  const TABLES = ["behaviour_anomaly_findings", "behaviour_baseline_settings", "behaviour_daily_counts", "behaviour_engine_state"];

  it("all four tables have row-level security ENABLED and FORCED", async () => {
    const r = await db.execute(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relname in (${sql.join(TABLES.map((t) => sql`${t}`), sql`, `)}) order by relname`);
    expect((r as unknown as { rows: unknown[] }).rows).toEqual(TABLES.map((relname) => ({ relname, on: true, forced: true })));
  });

  it("NEGATIVE: a member principal and a request reason see no finding or count and cannot write one; an admin and system_task can", async () => {
    const member = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0359-member-${RUN}@example.com`, displayName: "behaviour member", isAdmin: false } });
    expect(member.statusCode, member.body).toBe(201);
    const memberId: string = member.json().id;
    const findings = (tx: unknown) => (tx as Db).select({ id: behaviourAnomalyFindings.id }).from(behaviourAnomalyFindings).limit(1);
    const counts = (tx: unknown) => (tx as Db).execute(sql`SELECT 1 FROM behaviour_daily_counts LIMIT 1`).then((r) => (r as unknown as { rows: unknown[] }).rows);
    expect(await withPrincipal(db, { userId: adminId }, findings)).toHaveLength(1);
    expect(await withSystemContext(db, "system_task", "test.e40", findings)).toHaveLength(1);
    expect(await withPrincipal(db, { userId: memberId }, findings)).toEqual([]);
    expect(await withPrincipal(db, { userId: memberId }, counts)).toEqual([]);
    expect(await withSystemContext(db, "credential_request", "test.e40", findings)).toEqual([]);
    await expect(
      withPrincipal(db, { userId: memberId }, (tx) =>
        (tx as unknown as Db).execute(sql`INSERT INTO behaviour_baseline_settings (id, mode) VALUES (1, 'off') ON CONFLICT (id) DO UPDATE SET mode = 'off'`),
      ),
    ).rejects.toThrow();

    // and the API is admin-only (the default gate): a member's key is refused on every behaviour route (S10 [1])
    const key = await app.inject({ method: "POST", url: `/v1/users/${memberId}/keys`, headers: AUTH, payload: { name: "adr0359-member" } });
    const MEMBER = { authorization: `Bearer ${key.json().token}` };
    for (const [method, url] of [
      ["GET", "/v1/behaviour/settings"],
      ["PUT", "/v1/behaviour/settings"],
      ["GET", "/v1/behaviour/findings"],
      ["GET", `/v1/behaviour/findings/${randomUUID()}`],
      ["PUT", `/v1/behaviour/findings/${randomUUID()}/status`],
      ["GET", `/v1/behaviour/baselines/user/${memberId}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: MEMBER, ...(method === "PUT" ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
