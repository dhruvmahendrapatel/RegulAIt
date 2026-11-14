/**
 * ADR-0056 §5 amendment (lane L7) — the copilot is enrolled in red-teaming, with a promotion gate.
 *
 * Pinned end to end through `POST /v1/copilot/ask` with a real narrator agent (the deterministic mock provider):
 *  1. strict default: a narrator with no copilot red-team run is refused 409 `copilot_narrator_redteam_required`,
 *     audited, and no narration dispatch is metered;
 *  2. a finished run that gated on every copilot class, passed, against the model the agent serves now, lets it
 *     narrate;
 *  3. a LATER run that failed its gate blocks it again (the promotion block: a regression wins over an older pass);
 *  4. a passing run against a different model does not count;
 *  5. the pure verdict: a pass older than the window lapses; a run missing a copilot class does not count;
 *  6. the settings route: tightening is audited; relaxing without a step-up is refused.
 *
 * SHARED STATE (M-068): gates relaxed by name through `relaxGovernanceGatesForTest` (the copilot gate itself is set
 * STRICT here and restored to strict); rows are this file's own (prefix `l7c-`), removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  agents,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  inArray,
  orgSettings,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { COPILOT_REDTEAM_CLASSES, COPILOT_REDTEAM_RULE_IDS, copilotRedteamVerdict } from "./copilot-redteam-gate.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "l7c-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = randomUUID().slice(0, 8);
const DAY = 86_400_000;

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let narratorId: string;
let narratorModel: string;
let libraryId: string;
let datasetId: string;
const runIds: string[] = [];
const evalRunIds: string[] = [];
let restoreGates: () => Promise<void> = async () => {};
let restoreIdentity: () => Promise<void> = async () => {};
let adminKey: { authorization: string };

async function insertRun(opts: { gatePassed: boolean; finishedAt: Date; model?: string; classes?: readonly string[] }) {
  const [er] = await db
    .insert(evalRuns)
    .values({
      datasetId,
      datasetVersion: 1,
      agentId: narratorId,
      agentName: `l7c-narrator-${RUN}`,
      trigger: "manual",
      status: "completed",
      mode: "execute",
      cases: 4,
      passedCases: opts.gatePassed ? 4 : 1,
      meanScore: opts.gatePassed ? 1 : 0.25,
      passRate: opts.gatePassed ? 1 : 0.25,
      tolerance: 0.05,
      gatePassed: opts.gatePassed,
      regression: !opts.gatePassed,
      startedAt: opts.finishedAt,
      finishedAt: opts.finishedAt,
    })
    .returning();
  evalRunIds.push(er!.id);
  const [rt] = await db
    .insert(redteamRuns)
    .values({
      libraryId,
      libraryName: "l7c-lib",
      libraryVersion: 1,
      evalRunId: er!.id,
      agentId: narratorId,
      agentName: `l7c-narrator-${RUN}`,
      model: opts.model ?? narratorModel,
      probes: 4,
      resisted: opts.gatePassed ? 4 : 1,
      defeated: opts.gatePassed ? 0 : 3,
      gatingClasses: [...(opts.classes ?? COPILOT_REDTEAM_CLASSES)],
      gatePassed: opts.gatePassed,
      regression: !opts.gatePassed,
      startedAt: opts.finishedAt,
      finishedAt: opts.finishedAt,
    })
    .returning();
  runIds.push(rt!.id);
  return rt!.id;
}

async function ask() {
  return app.inject({
    method: "POST",
    url: "/v1/copilot/ask",
    headers: userAuth,
    payload: { question: "spend this month?", narratorAgentId: narratorId },
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, {
    mrmEnforced: false,
    mrmStalenessRecertEnabled: false,
    dispatchAttributionRequired: false,
    requireProjectAttribution: false,
    useCaseGateMode: "off",
    // the subject of this file, set STRICT explicitly (restore writes strict back)
    copilotRedteamGateEnabled: true,
  });
  await db.update(orgSettings).set({ copilotRedteamMaxAgeDays: 30 }).where(eq(orgSettings.id, "singleton"));
  // an admin API key needs MFA off to authenticate at all; it still can never give a step-up
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  const adm = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `l7c-admin-${RUN}@example.com`, displayName: "L7 Copilot Admin", isAdmin: true },
  });
  expect(adm.statusCode).toBe(201);
  const ak = await app.inject({ method: "POST", url: `/v1/users/${adm.json().id}/keys`, headers: AUTH, payload: { name: "l7c" } });
  adminKey = { authorization: `Bearer ${ak.json().token}` };

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `l7c-${RUN}@example.com`, displayName: "L7 Copilot User" },
  });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "l7c" } });
  userAuth = { authorization: `Bearer ${k.json().token}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `l7c-narrator-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
  narratorId = a.json().id;
  const [row] = await db.select({ model: agents.model }).from(agents).where(eq(agents.id, narratorId));
  narratorModel = row!.model!;
  await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId, agentId: narratorId } });

  const [lib] = await db.insert(redteamLibraries).values({ name: `l7c-lib-${RUN}`, version: 1 }).returning();
  libraryId = lib!.id;
  const [ds] = await db.insert(evalDatasets).values({ name: `l7c-ds-${RUN}`, version: 1, scorerKind: "contains" }).returning();
  datasetId = ds!.id;
});

afterAll(async () => {
  if (runIds.length) await db.delete(redteamRuns).where(inArray(redteamRuns.id, runIds));
  if (evalRunIds.length) await db.delete(evalRuns).where(inArray(evalRuns.id, evalRunIds));
  if (libraryId) await db.delete(redteamLibraries).where(eq(redteamLibraries.id, libraryId));
  if (datasetId) await db.delete(evalDatasets).where(eq(evalDatasets.id, datasetId));
  await db.update(orgSettings).set({ copilotRedteamMaxAgeDays: 30 }).where(eq(orgSettings.id, "singleton"));
  await restoreGates();
  await restoreIdentity();
  await app.close();
});

const meteredNarrations = async () =>
  (await db.select().from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.agentId, narratorId)))).length;

describe("ADR-0056 §5 — the copilot narrator red-team promotion gate", () => {
  it("strict default: a narrator never red-teamed for the copilot is refused, audited, and nothing is metered", async () => {
    const before = await meteredNarrations();
    const res = await ask();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("copilot_narrator_redteam_required");
    expect(res.json().detail).toMatch(/not enrolled/);
    expect(await meteredNarrations()).toBe(before);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, COPILOT_REDTEAM_RULE_IDS.refused), eq(auditLog.userId, userId)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(row?.effect).toBe("deny");
    expect((row!.detail as Record<string, unknown>).narratorAgentId).toBe(narratorId);
  });

  it("a passing run on every copilot class, against the served model, lets it narrate", async () => {
    await insertRun({ gatePassed: true, finishedAt: new Date(Date.now() - 2 * DAY) });
    const refusals = async () =>
      (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, COPILOT_REDTEAM_RULE_IDS.refused), eq(auditLog.userId, userId))))
        .length;
    const before = await refusals();
    const res = await ask();
    // the SAME request the previous case refused 409 is now answered, and the gate wrote no refusal
    expect(res.statusCode).toBe(201);
    expect(await refusals()).toBe(before);
  });

  it("a later failing run blocks it again: a regression wins over an older pass", async () => {
    const failed = await insertRun({ gatePassed: false, finishedAt: new Date(Date.now() - DAY) });
    const res = await ask();
    expect(res.statusCode).toBe(409);
    expect(res.json().redteamRunId).toBe(failed);
    expect(res.json().detail).toMatch(/blocks its promotion/);
  });

  it("a newer pass against a DIFFERENT model does not count", async () => {
    const other = await insertRun({ gatePassed: true, finishedAt: new Date(), model: "some-other-model" });
    const res = await ask();
    expect(res.statusCode).toBe(409);
    expect(res.json().redteamRunId).toBe(other);
    expect(res.json().detail).toMatch(/now serves/);
  });

  it("the GET route reports the same verdict for an agent", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/copilot/redteam-gate?agentId=${narratorId}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.enabled).toBe(true);
    expect(res.json().settings.requiredClasses).toEqual([...COPILOT_REDTEAM_CLASSES]);
    expect(res.json().verdict.allowed).toBe(false);
  });
});

describe("ADR-0056 §5 — the pure verdict", () => {
  const now = new Date("2026-11-14T00:00:00Z");
  const agent = { name: "n", model: "m" };
  const run = (over: Partial<{ gatingClasses: string[]; gatePassed: boolean | null; finishedAt: Date; model: string }>) => ({
    id: randomUUID(),
    model: "m",
    gatingClasses: [...COPILOT_REDTEAM_CLASSES],
    gatePassed: true as boolean | null,
    finishedAt: new Date(now.getTime() - DAY),
    ...over,
  });
  const opts = { enabled: true, maxAgeDays: 30, now };

  it("a pass older than the window lapses", () => {
    expect(copilotRedteamVerdict(agent, [run({ finishedAt: new Date(now.getTime() - 31 * DAY) })], opts).allowed).toBe(false);
    expect(copilotRedteamVerdict(agent, [run({})], opts).allowed).toBe(true);
  });

  it("a run that did not gate on every copilot class does not count", () => {
    expect(copilotRedteamVerdict(agent, [run({ gatingClasses: ["prompt_injection"] })], opts).allowed).toBe(false);
  });

  it("off means allowed, and says it was turned off", () => {
    const v = copilotRedteamVerdict(agent, [], { ...opts, enabled: false });
    expect(v.allowed).toBe(true);
    expect(v.reason).toMatch(/turned off/);
  });
});

describe("ADR-0056 §5 — the settings route", () => {
  it("tightening the window is audited", async () => {
    // tightening needs no step-up, so an admin API key may do it
    const res = await app.inject({ method: "PUT", url: "/v1/copilot/redteam-gate", headers: adminKey, payload: { maxAgeDays: 14 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxAgeDays).toBe(14);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, COPILOT_REDTEAM_RULE_IDS.settings))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(row?.effect).toBe("allow");
  });

  it("turning the gate off without a step-up is refused, and nothing changes", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/copilot/redteam-gate", headers: adminKey, payload: { enabled: false } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("step_up_required");
    const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, "singleton"));
    expect(org!.copilotRedteamGateEnabled).toBe(true);
  });

  it("a non-admin cannot read or change it", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/copilot/redteam-gate", headers: userAuth })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "PUT", url: "/v1/copilot/redteam-gate", headers: userAuth, payload: { maxAgeDays: 7 } }))
        .statusCode,
    ).toBe(403);
  });
});
