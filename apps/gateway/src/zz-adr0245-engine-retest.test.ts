/**
 * ADR-0245 — ADR-0217's automatic re-test picks up red-team ENGINE runs (spikee, PyRIT, garak, promptfoo).
 *
 *  - a completed engine run a person made against a certified agent is a re-test suite (kind `engine`), one per
 *    engine and configuration; a run a re-test started is never itself a source;
 *  - the re-test is created through `createEngineRun` as that person, so every gate applies: with the engine off
 *    (the secure default, and spikee/PyRIT have no published image) the re-test is `refused` with `engine_disabled`,
 *    and no engine run is created;
 *  - an engine run a re-test waits on settles it in the same transaction that ends the run (here: a cancel through
 *    the real route), never as a pass; a refused approval settles it `refused`; the mapping is pure and total;
 *  - the database refuses an engine link on a non-engine re-test.
 *
 * SHARED STATE (M-068): the MRM org fields and `mrmAutoRetestEnabled` are restored exactly in afterAll; every row
 * this file creates is prefixed p26- and removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, desc, engineRuns, eq, inArray, modelCardApprovals, modelCards, mrmRetestRuns, orgSettings, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { loadOrgSettings } from "./org-settings.js";
import { runMrmAutoRetestSweep } from "./mrm-auto-retest.js";
import { engineRetestStatus, settleEngineRetestTx } from "./mrm-retest-engine.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "p26-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
const DAY = 86_400_000;
const RUN = `${process.pid}-${Date.now()}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let anaAuth: { authorization: string };
let rikaId: string;
let rikaAuth: { authorization: string };
let subjectId: string;
let judgeId: string;
let cardId: string;
let restoreGates: () => Promise<void> = async () => {};
let restoreIdentity: () => Promise<void> = async () => {};
let priorOrg: Partial<typeof orgSettings.$inferSelect> | null = null;
const created = { agents: [] as string[], engineRuns: [] as string[] };

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName: email.split("@")[0] } });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "p26" } });
  expect(k.statusCode).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(a.statusCode, a.body).toBe(201);
  created.agents.push(a.json().id as string);
  const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: anaId, agentId: a.json().id } });
  expect(g.statusCode).toBe(201);
  return a.json().id as string;
}

async function certify(id: string, reason: string) {
  const req = await app.inject({
    method: "POST",
    url: `/v1/mrm/cards/${id}/sign-off`,
    headers: AUTH,
    payload: { approverUserId: rikaId, validUntil: new Date(Date.now() + 180 * DAY).toISOString(), reason },
  });
  expect(req.statusCode, req.body).toBe(201);
  const dec = await app.inject({ method: "POST", url: `/v1/approvals/${req.json().approvalId}/decide`, headers: rikaAuth, payload: { decision: "approved", reason } });
  expect(dec.statusCode, dec.body).toBe(200);
}

/** an engine run row as the gateway writes one (status and links chosen by the case) */
async function engineRun(engineId: "spikee" | "pyrit" | "garak", status: "completed" | "queued", sets: string[], extra: Partial<typeof engineRuns.$inferInsert> = {}) {
  const [r] = await db
    .insert(engineRuns)
    .values({
      engineId,
      engineVersion: "test",
      status,
      trigger: "manual",
      runAsUserId: anaId,
      targetKind: "agent",
      targetAgentId: subjectId,
      judgeAgentId: engineId === "pyrit" ? judgeId : null,
      config: { sets, params: {} },
      configHash: `p26-${engineId}-${sets.join(",")}`,
      trials: 2,
      budgetUsd: 1,
      timeoutSeconds: 600,
      queueExpiresAt: new Date(Date.now() + DAY),
      ...(status === "completed" ? { finishedAt: new Date(), summary: { verdict: "pass", counts: { pass: 3, fail: 0 } } } : {}),
      ...extra,
    })
    .returning();
  created.engineRuns.push(r!.id);
  return r!;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreGates = await relaxGovernanceGatesForTest(db, { dispatchAttributionRequired: false });
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  const org = await loadOrgSettings(db);
  priorOrg = {
    mrmEnforced: org.mrmEnforced,
    mrmStalenessRecertEnabled: org.mrmStalenessRecertEnabled,
    mrmStalenessRecertThreshold: org.mrmStalenessRecertThreshold,
    mrmAutoRetestEnabled: org.mrmAutoRetestEnabled,
  };
  const armed = await app.inject({ method: "POST", url: "/v1/mrm/enforcement", headers: AUTH, payload: { enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 } });
  expect(armed.statusCode, armed.body).toBe(200);
  await db.update(orgSettings).set({ mrmAutoRetestEnabled: false }).where(eq(orgSettings.id, "singleton"));
  const ana = await makeUser(`p26-ana-${RUN}@example.com`);
  anaId = ana.id;
  anaAuth = ana.auth;
  const rika = await makeUser(`p26-rika-${RUN}@example.com`);
  rikaId = rika.id;
  rikaAuth = rika.auth;
  subjectId = await makeAgent(`p26-subject-${RUN}`);
  judgeId = await makeAgent(`p26-judge-${RUN}`);
  // the person's own engine runs against the subject: two configurations of spikee (the newer of the same
  // configuration wins), and a PyRIT run with its judge
  await engineRun("spikee", "completed", ["dataset:llm-mailbox"], { createdAt: new Date(Date.now() - 2 * DAY) });
  await engineRun("spikee", "completed", ["dataset:llm-mailbox"], { createdAt: new Date(Date.now() - DAY) });
  await engineRun("pyrit", "completed", ["attack:crescendo"]);
  // a run that did not complete is never a source
  await engineRun("garak", "queued", ["encoding.injectbase64"]);
  const card = await app.inject({ method: "POST", url: "/v1/mrm/cards", headers: AUTH, payload: { agentId: subjectId, intendedUse: "p26: answer tickets" } });
  expect(card.statusCode, card.body).toBe(201);
  cardId = card.json().card.id as string;
  await certify(cardId, "p26: initial certification");
}, 120_000);

afterAll(async () => {
  if (priorOrg) await db.update(orgSettings).set(priorOrg).where(eq(orgSettings.id, "singleton"));
  await restoreGates();
  await restoreIdentity();
  if (cardId) {
    await db.delete(mrmRetestRuns).where(eq(mrmRetestRuns.cardId, cardId));
    await db.delete(modelCardApprovals).where(eq(modelCardApprovals.cardId, cardId));
    await db.delete(modelCards).where(eq(modelCards.id, cardId));
  }
  if (created.engineRuns.length) await db.delete(engineRuns).where(inArray(engineRuns.id, created.engineRuns));
  if (created.agents.length) await db.delete(engineRuns).where(inArray(engineRuns.targetAgentId, created.agents));
  await app.close();
  await db.$client.end();
});

describe("the mapping from an engine run's end to a re-test status (pure)", () => {
  it("only a completed run with a measured pass is a pass; a failure, nothing measured or any other end never is", () => {
    expect(engineRetestStatus({ status: "completed", errorCode: null, verdict: "pass", measured: 2 }).status).toBe("passed");
    expect(engineRetestStatus({ status: "completed", errorCode: null, verdict: "fail", measured: 2 }).status).toBe("failed_gate");
    expect(engineRetestStatus({ status: "completed", errorCode: null, verdict: "pass", measured: 0 }).status).toBe("reported");
    expect(engineRetestStatus({ status: "completed", errorCode: null, verdict: "unknown", measured: 4 }).status).toBe("reported");
    expect(engineRetestStatus({ status: "not_run", errorCode: "approval_denied", verdict: null, measured: 0 }).status).toBe("refused");
    for (const status of ["timeout", "cancelled", "failed", "not_run"]) {
      expect(engineRetestStatus({ status, errorCode: "x", verdict: "pass", measured: 9 }).status).toBe("reported");
    }
  });
});

describe("a model change re-tests the person's engine runs, through every gate", () => {
  it("each engine and configuration is one suite, run as its person; with the engine off the re-test is refused and no run is made", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/agents/${subjectId}/system-prompt`, headers: AUTH, payload: { systemPrompt: "p26 changed" } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    await db.update(orgSettings).set({ mrmAutoRetestEnabled: true }).where(eq(orgSettings.id, "singleton"));
    const before = await db.select({ id: engineRuns.id }).from(engineRuns).where(eq(engineRuns.targetAgentId, subjectId));
    const out = await runMrmAutoRetestSweep(db, DATA_KEY);
    const mine = out.cards.find((c) => c.cardId === cardId)!;
    const engine = mine.runs.filter((r) => r.kind === "engine");
    expect(engine).toHaveLength(2);
    const rows = await db.select().from(mrmRetestRuns).where(and(eq(mrmRetestRuns.cardId, cardId), eq(mrmRetestRuns.kind, "engine")));
    expect(rows.map((r) => r.sourceName).sort()).toEqual(["PyRIT: attack:crescendo", "Spikee: dataset:llm-mailbox"]);
    for (const r of rows) {
      expect(r.status).toBe("refused");
      expect(r.reason).toMatch(/^engine_disabled/);
      expect(r.engineRunId).toBeNull();
      expect(r.runAsUserId).toBe(anaId);
    }
    // the newer of the two same-configuration spikee runs is the source
    const spikeeSources = await db.select().from(engineRuns).where(and(eq(engineRuns.targetAgentId, subjectId), eq(engineRuns.engineId, "spikee")));
    const newest = spikeeSources.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(rows.find((r) => r.sourceName.startsWith("Spikee"))!.sourceId).toBe(newest.id);
    const after = await db.select({ id: engineRuns.id }).from(engineRuns).where(eq(engineRuns.targetAgentId, subjectId));
    expect(after).toHaveLength(before.length);
    // a second pass for the same drift claims nothing more
    const again = await runMrmAutoRetestSweep(db, DATA_KEY);
    expect(again.cards.find((c) => c.cardId === cardId)!.runs).toHaveLength(0);
  });
});

describe("an engine run a re-test waits on settles it when it ends", () => {
  it("a cancel through the real route settles it `reported` (never a pass), once, with its audit row", async () => {
    const run = await engineRun("spikee", "queued", ["dataset:cybersec-2026-01"]);
    const [row] = await db
      .insert(mrmRetestRuns)
      .values({ cardId, driftKey: `p26-${RUN}-cancel`, kind: "engine", sourceId: run.id, sourceName: "Spikee: dataset:cybersec-2026-01", runAsUserId: anaId, status: "running", engineRunId: run.id })
      .returning();
    const res = await app.inject({ method: "POST", url: `/v1/engine-runs/${run.id}/cancel`, headers: anaAuth, payload: { reason: "p26 cancel" } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const [settled] = await db.select().from(mrmRetestRuns).where(eq(mrmRetestRuns.id, row!.id));
    expect(settled!.status).toBe("reported");
    expect(settled!.reason).toMatch(/ended cancelled/);
    expect(settled!.finishedAt).not.toBeNull();
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mrm-auto-retest-finished"), eq(auditLog.objectId, cardId)))
      .orderBy(desc(auditLog.seq));
    expect(audits.filter((a) => (a.detail as { retestId?: string }).retestId === row!.id)).toHaveLength(1);
    // settling again (a second end) moves nothing
    const second = await db.transaction((tx) =>
      settleEngineRetestTx(tx, { engineRunId: run.id, engineId: "spikee", status: "completed", errorCode: null, verdict: "pass", measured: 5, asr: 0, redteamRunId: null, evalRunId: null }),
    );
    expect(second).toBeNull();
    const [still] = await db.select().from(mrmRetestRuns).where(eq(mrmRetestRuns.id, row!.id));
    expect(still!.status).toBe("reported");
  });

  it("the database refuses an engine link on a re-test that is not of kind engine", async () => {
    const run = await engineRun("pyrit", "queued", ["attack:tap"]);
    await expect(
      db.insert(mrmRetestRuns).values({ cardId, driftKey: `p26-${RUN}-bad`, kind: "redteam", sourceId: run.id, sourceName: "bad", status: "running", engineRunId: run.id }),
    ).rejects.toThrow();
  });
});
