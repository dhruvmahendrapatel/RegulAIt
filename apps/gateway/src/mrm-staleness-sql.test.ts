/**
 * ADR-0183 batch 2.2 — the staleness run comparison moved into ONE query
 * (`runComparisonsSinceCertification` in mrm-autofill.ts).
 *
 * One seeded fixture covers every staleness reason, for an agent card and for
 * an endpoint card (the two `evalScope` shapes):
 *  - eval regressions: worse than the LATEST certification-era run (an older,
 *    lower reference would say "improved"), a JSON-null judge panel matching a
 *    NULL one, a run with three judge repetitions against its own reference, a
 *    server-started run that failed its gate; and the non-regressions: within
 *    tolerance, a manual run that failed only its caller's floor, an
 *    incomparable instrument (another judge panel), a running row, a row with
 *    no score, red-team-backed eval rows on both sides, and a candidate whose
 *    only same-key run is newer than the sign-off;
 *  - red-team: worse than the latest certification-era run (an older, worse
 *    one would say "better"), equal, no reference, unfinished;
 *  - risk changes triaged by an admin (drift), written only by a non-admin
 *    (awaiting triage) and changed before the sign-off (neither);
 *  - guardrail relaxation, tightening, and a removal without transitions;
 *  - configuration: a serving activation, a non-serving one, one before the
 *    sign-off, an unversioned agent-config edit, a versioned one, a custom
 *    provider edit (endpoint card);
 *  - card edits after and before the sign-off.
 *
 * The expected numbers below were first proved IDENTICAL to the previous
 * two-query-plus-JavaScript implementation on this same fixture (whole
 * `CardStaleness` objects deep-equal, recorded in the batch 2.2 commit), and
 * the old path was then removed. Pure ledger fixture: rows are inserted the
 * way the runners and routes write them, and removed in afterAll (audit rows
 * are append-only and stay, scoped to this file's random ids).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  agents,
  aiRisks,
  auditLog,
  configActivationEvents,
  configVersions,
  createDb,
  customModelProviders,
  evalDatasets,
  evalRuns,
  inArray,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { computeCardStaleness } from "./mrm-autofill.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const SINCE = ago(2); // the sign-off
const OLD_REF = ago(4);
const REF = ago(3);
const AFTER = ago(1);
const tag = randomUUID().slice(0, 8);

let db: Db;
const ids = {
  agentX: "", agentY: "", provider: "", admin: "", member: "", dsA: "", dsB: "", dsRt: "", libA: "", libB: "",
  cardA: randomUUID(), cardE: randomUUID(),
};
const evalIds: string[] = [];
const rtIds: string[] = [];
const riskIds: string[] = [];
const versionIds: string[] = [];

async function evalRun(v: Partial<typeof evalRuns.$inferInsert> & { startedAt: Date }) {
  const [row] = await db
    .insert(evalRuns)
    .values({
      datasetId: ids.dsA, datasetVersion: 1, agentId: ids.agentX, agentName: "sql2-x", trigger: "manual",
      status: "completed", mode: "execute", cases: 10, passedCases: 9, meanScore: 0.9, passRate: 0.9,
      tolerance: 0.05, gatePassed: true, regression: false, finishedAt: v.startedAt, ...v,
    })
    .returning({ id: evalRuns.id });
  evalIds.push(row!.id);
  return row!.id;
}

async function redteamRun(agentId: string, libraryId: string, asr: number, startedAt: Date, finished = true) {
  const backing = await evalRun({ agentId, datasetId: ids.dsRt, startedAt, meanScore: 0.01, passRate: 0.01, tolerance: 1 });
  const [rt] = await db
    .insert(redteamRuns)
    .values({
      libraryId, libraryName: "sql2-lib", libraryVersion: 1, evalRunId: backing, agentId, agentName: "sql2",
      probes: 10, resisted: 10 - Math.round(asr * 10), defeated: Math.round(asr * 10), trials: 4, asr,
      asrTrials: 40, measurementQuality: "measured", gatePassed: true, startedAt,
      finishedAt: finished ? startedAt : null,
    })
    .returning({ id: redteamRuns.id });
  rtIds.push(rt!.id);
}

const audit = (ruleId: string, at: Date, objectType: NonNullable<(typeof auditLog.$inferInsert)["objectType"]>, objectId: string, detail: unknown, userId = ids.admin) =>
  db.insert(auditLog).values({
    userId, at, effect: "allow", ruleId, ruleChain: [], reason: `sql2 fixture ${tag}`, objectType, objectId,
    detail: detail as Record<string, unknown>,
  });

async function activation(agentId: string, action: (typeof configActivationEvents.$inferInsert)["action"], at: Date) {
  const [v] = await db
    .insert(configVersions)
    .values({ artifactType: "agent_config", artifactId: agentId, version: versionIds.length + 1, body: {} })
    .returning({ id: configVersions.id });
  versionIds.push(v!.id);
  await db.insert(configActivationEvents).values({
    artifactType: "agent_config", artifactId: agentId, versionId: v!.id, version: versionIds.length, action, at,
  });
}

async function risk(agentId: string, updatedAt: Date, writers: string[]) {
  const [r] = await db
    .insert(aiRisks)
    .values({
      title: `sql2 risk ${tag}`, description: "fixture", category: "scope_drift", ownerUserId: ids.admin,
      agentId, likelihood: "low", impact: "low", updatedAt,
    })
    .returning({ id: aiRisks.id });
  riskIds.push(r!.id);
  for (const w of writers) await audit("ai-risk-updated", updatedAt, "ai_risk", r!.id, {}, w);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [admin] = await db.insert(users).values({ email: `sql2-admin-${tag}@example.test`, displayName: "sql2 admin", isAdmin: true }).returning();
  const [member] = await db.insert(users).values({ email: `sql2-member-${tag}@example.test`, displayName: "sql2 member" }).returning();
  ids.admin = admin!.id;
  ids.member = member!.id;
  const [p] = await db
    .insert(customModelProviders)
    .values({ name: `sql2-endpoint-${tag}`, wireProtocol: "openai_chat", baseUrl: "https://sql2.example.test/v1" })
    .returning();
  ids.provider = p!.id;
  const [x] = await db.insert(agents).values({ name: `sql2-x-${tag}`, provider: "mock", tier: 1 }).returning();
  const [y] = await db
    .insert(agents)
    .values({ name: `sql2-y-${tag}`, provider: "custom", tier: 1, customProviderId: ids.provider })
    .returning();
  ids.agentX = x!.id;
  ids.agentY = y!.id;
  for (const k of ["dsA", "dsB", "dsRt"] as const) {
    const [d] = await db.insert(evalDatasets).values({ name: `sql2-${k}-${tag}`, version: 1, scorerKind: "contains" }).returning();
    ids[k] = d!.id;
  }
  for (const k of ["libA", "libB"] as const) {
    const [l] = await db.insert(redteamLibraries).values({ name: `sql2-${k}-${tag}`, version: 1 }).returning();
    ids[k] = l!.id;
  }

  // ---- agent card: eval -----------------------------------------------------
  await evalRun({ startedAt: OLD_REF, meanScore: 0.6, passRate: 0.6 }); // older reference, not the cert-era one
  await evalRun({ startedAt: REF, meanScore: 0.9, passRate: 0.9 }); // the certification-era run
  await evalRun({ startedAt: AFTER, meanScore: 0.88, passRate: 0.88 }); // within tolerance: no
  await evalRun({ startedAt: AFTER, meanScore: 0.8, passRate: 0.8 }); // worse than 0.9 (better than 0.6): YES
  await evalRun({ startedAt: AFTER, meanScore: 0.5, passRate: 0.5, judgePanel: sql`'null'::jsonb` as never }); // JSON null = NULL: YES
  await evalRun({ startedAt: AFTER, meanScore: 0.1, passRate: 0.1, judgePanel: [{ agentId: null, agentName: "j", weight: 1 }] }); // no comparable ref: no
  await evalRun({ startedAt: AFTER, trigger: "manual", minScore: 1, gatePassed: false }); // caller's floor: no
  await evalRun({ startedAt: AFTER, trigger: "scheduled", gatePassed: false, regression: true }); // server gate: YES
  await evalRun({ startedAt: AFTER, trigger: "workflow", gatePassed: null, regression: null, meanScore: 0.89, passRate: 0.89 }); // no
  await evalRun({ startedAt: AFTER, status: "running", meanScore: 0.1, passRate: 0.1 }); // not completed: no
  await evalRun({ startedAt: AFTER, meanScore: null, passRate: null }); // no score: no
  await evalRun({ startedAt: REF, repetitions: 3, meanScore: 0.7, passRate: 0.7 });
  await evalRun({ startedAt: AFTER, repetitions: 3, meanScore: 0.6, passRate: 0.6 }); // 3 repetitions vs its own ref: YES
  await evalRun({ startedAt: AFTER, datasetId: ids.dsB, meanScore: 0.2, passRate: 0.2 }); // dataset B has no ref: no
  await evalRun({ startedAt: new Date(NOW.getTime() - 1000), datasetId: ids.dsB, meanScore: 0.1, passRate: 0.1 }); // ref only after: no
  // ---- agent card: red-team (backing eval rows score 0.01 and must not count) --
  await redteamRun(ids.agentX, ids.libA, 0.5, OLD_REF);
  await redteamRun(ids.agentX, ids.libA, 0.1, REF);
  await redteamRun(ids.agentX, ids.libA, 0.1, AFTER); // equal: no
  await redteamRun(ids.agentX, ids.libA, 0.3, AFTER); // worse than 0.1 (better than 0.5): YES
  await redteamRun(ids.agentX, ids.libB, 0.9, AFTER); // no reference: no
  await redteamRun(ids.agentX, ids.libA, 0.9, AFTER, false); // unfinished: no
  // ---- agent card: risks ------------------------------------------------------
  await risk(ids.agentX, AFTER, [ids.member, ids.admin]); // triaged by an admin: drift
  await risk(ids.agentX, AFTER, [ids.member]); // only a non-admin: awaiting triage
  await risk(ids.agentX, ago(5), [ids.admin]); // before the sign-off: neither
  // ---- agent card: guardrails ---------------------------------------------------
  const gr = (ruleId: string, transitions?: unknown) =>
    audit(ruleId, AFTER, "org_settings", randomUUID(), { scope: "agent", scopeId: ids.agentX, ...(transitions ? { transitions } : {}) });
  await gr("guardrail-config-updated", { pii: { from: "block", to: "warn" } }); // relaxation
  await gr("guardrail-config-updated", { pii: { from: "warn", to: "block" } }); // tightening
  await gr("guardrail-config-deleted"); // removal, direction unknown: counts
  // ---- agent card: configuration ---------------------------------------------------
  await activation(ids.agentX, "activated", AFTER); // counts
  await activation(ids.agentX, "created", AFTER); // not a serving move
  await activation(ids.agentX, "promoted", ago(5)); // before the sign-off
  await audit("agent-config-edited", AFTER, "agent", ids.agentX, { decision: "row", changed: ["model"] }); // counts
  await audit("agent-config-edited", AFTER, "agent", ids.agentX, { decision: "version", changed: ["model"] }); // its activation counts
  // ---- agent card: card edits ------------------------------------------------------
  await audit("mrm-card-updated", AFTER, "model_card", ids.cardA, {});
  await audit("mrm-card-updated", ago(5), "model_card", ids.cardA, {});

  // ---- endpoint card ---------------------------------------------------------------
  const onP = { agentId: null, customProviderId: ids.provider };
  await evalRun({ ...onP, startedAt: REF, meanScore: 0.9, passRate: 0.9 });
  await evalRun({ ...onP, startedAt: AFTER, meanScore: 0.5, passRate: 0.5 }); // YES
  await evalRun({ agentId: ids.agentY, startedAt: REF, meanScore: 0.9, passRate: 0.9 });
  await evalRun({ agentId: ids.agentY, startedAt: AFTER, meanScore: 0.86, passRate: 0.86 }); // no
  await evalRun({ agentId: ids.agentY, startedAt: AFTER, trigger: "config_change", gatePassed: true, regression: true }); // YES
  await redteamRun(ids.agentY, ids.libA, 0.2, REF);
  await redteamRun(ids.agentY, ids.libA, 0.4, AFTER); // YES
  await audit("custom-provider-updated", AFTER, "custom_model_provider", ids.provider, {}); // counts
});

afterAll(async () => {
  if (rtIds.length) await db.delete(redteamRuns).where(inArray(redteamRuns.id, rtIds));
  if (evalIds.length) await db.delete(evalRuns).where(inArray(evalRuns.id, evalIds));
  if (riskIds.length) await db.delete(aiRisks).where(inArray(aiRisks.id, riskIds));
  if (versionIds.length) await db.delete(configVersions).where(inArray(configVersions.id, versionIds));
  await db.delete(redteamLibraries).where(inArray(redteamLibraries.id, [ids.libA, ids.libB].filter(Boolean)));
  await db.delete(evalDatasets).where(inArray(evalDatasets.id, [ids.dsA, ids.dsB, ids.dsRt].filter(Boolean)));
  await db.$client.end();
});

const chain = [
  { status: "denied" as const, decidedAt: ago(1.5) }, // a refusal certifies nothing
  { status: "approved" as const, decidedAt: SINCE },
  { status: "superseded" as const, decidedAt: ago(10) },
];

describe("staleness run comparison in one query (ADR-0183 2.2)", () => {
  it("agent card: every drift kind is counted exactly as before", async () => {
    const card = { id: ids.cardA, agentId: ids.agentX, customProviderId: null };
    const s = await computeCardStaleness(db, card, chain as never, NOW);
    expect(s.lastCertifiedAt).toBe(SINCE.toISOString());
    expect(s.driftSinceCertification).toEqual({
      evalRegressions: 4,
      redteamRegressions: 1,
      riskChanges: 1,
      guardrailRelaxations: 2,
      configChanges: 2,
      cardEdits: 1,
    });
    expect(s.driftEvents).toBe(11);
    expect(s.changesSinceCertification).toMatchObject({ redteamRuns: 4, riskChanges: 2, risksAwaitingTriage: 1, scheduledRegressions: 1 });
    expect(s.summary).toBe(
      "4 eval regressions, 1 red-team regression, 1 risk-register change, 2 agent guardrail relaxations, " +
        "2 model or configuration changes and 1 card edit since certification — the evidence this sign-off rested on has moved",
    );
  });

  it("endpoint card: runs on the provider and on its backing agent, plus the endpoint edit", async () => {
    const card = { id: ids.cardE, agentId: null, customProviderId: ids.provider };
    const s = await computeCardStaleness(db, card, chain as never, NOW);
    expect(s.driftSinceCertification).toEqual({
      evalRegressions: 2,
      redteamRegressions: 1,
      riskChanges: 0,
      guardrailRelaxations: 0,
      configChanges: 1,
      cardEdits: 0,
    });
  });

  it("the same reads inside a transaction (sequential reads on one client) agree", async () => {
    const card = { id: ids.cardA, agentId: ids.agentX, customProviderId: null };
    const pooled = await computeCardStaleness(db, card, chain as never, NOW);
    const inTx = await db.transaction((tx) => computeCardStaleness(tx as unknown as Db, card, chain as never, NOW, { inTransaction: true }));
    expect(inTx).toEqual(pooled);
  });
});
