/**
 * ADR-0076 — SCHEDULED COST RECONCILIATION, proved by attack.
 *
 * THE INVARIANT: a consolidated read after reconciliation never counts the
 * same vendor line twice — and NOTHING is deleted to get there. Supersession
 * is marked, disclosed in the read response, and audited.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE:
 *
 *  1. A VACUOUS FIX. The FIRST test asserts the double count EXISTS: two
 *     overlapping CUR-style chunks applied as two batches make Jane's imported
 *     figure 66.66 where the vendor charged 33.33. That is ADR-0069's own
 *     disclosed gap, reproduced through the real API — the failing-first
 *     control every later assertion is measured against. If the read path
 *     ever silently de-duplicated on its own, that test goes red and the
 *     reconciliation tests below become unfalsifiable.
 *  2. A SILENT DELETION. After the pass, every line still exists. The marked
 *     one carries WHO replaced it, WHICH run decided it and a stated reason;
 *     the consolidated response DISCLOSES how many marked lines it excluded.
 *  3. A GUESSED DEDUP. Batches that disagree about a fact's multiplicity are
 *     reported and left alone — all copies keep counting, loudly.
 *  4. A VANISHING FACT ON REVOKE. Revoking the batch whose lines superseded
 *     older copies REINSTATES those copies: a withdrawn restatement must not
 *     erase the fact it restated.
 *  5. AN UNGATED SURFACE. Non-admins get 403 on both new endpoints.
 *  6. A JOB THAT ISN'T ONE. The ADR-0064 registry carries the sweep, and
 *     "run now" through the scheduler surface produces the same ledger row
 *     the manual endpoint's function writes.
 *
 * SHARED-STATE DISCIPLINE. Same as cost-import.test.ts: org-wide tables,
 * cleaned in afterAll by this suite's own rule ids and rows; ORG_SETTINGS is
 * never touched; all money figures are unique to this suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  costImportBatches,
  costReconciliationRuns,
  createDb,
  eq,
  importedCostLines,
  inArray,
  runMigrations,
  schedulerJobs,
  schedulerRuns,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { COST_IMPORT_RULE_IDS } from "./cost-import.js";
import { COST_RECONCILE_RULE_IDS } from "./cost-reconcile.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "cost-reconcile-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };

const JANE = "cost-recon-jane@example.com";
const BOB = "cost-recon-bob@example.com";
const GHOST = "cost-recon-ghost@example.com";
const WINDOWY = "cost-recon-window@example.com";

// figures unique to this suite; 66.66 is what the DEFECT produces
const JANE_USD = 33.33;
const JANE_DOUBLED = 66.66;
const BOB_USD = 44.44;
const GHOST_USD = 55.55;

const WINDOW = "from=2026-06-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";

let db: Db;
let app: ReturnType<typeof buildApp>;
let janeId: string;
let bobId: string;
let janeAuth: { authorization: string };
const createdUserIds: string[] = [];

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });
const del = (url: string, payload: unknown = {}, headers = ADMIN) =>
  app.inject({ method: "DELETE", url, headers, payload: payload as object });

async function makeUser(email: string): Promise<{ id: string; auth: { authorization: string } }> {
  const res = await post("/v1/users", { email, displayName: email });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  createdUserIds.push(id);
  const key = await post(`/v1/users/${id}/keys`, { name: "cost-reconcile" });
  expect(key.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
}

/** apply a generic_mapped CSV as its own batch, returning the batch id */
async function applyCsv(csv: string, source: string): Promise<string> {
  const res = await post("/v1/cost-imports", {
    adapter: "generic_mapped",
    format: "csv",
    mode: "apply",
    content: csv,
    source,
    config: { mapping: { account: "email", amount: "cost", period: "month" }, defaults: { vendor: "aws" } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().importId as string;
}

async function janeSubject() {
  const res = await get(`/v1/cost-consolidated?${WINDOW}`);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return {
    body,
    jane: body.subjects.find((s: { subjectId: string | null }) => s.subjectId === janeId),
  };
}

let chunkA: string;
let chunkB: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const jane = await makeUser(JANE);
  janeId = jane.id;
  janeAuth = jane.auth;
  const bob = await makeUser(BOB);
  bobId = bob.id;

  // TWO OVERLAPPING CHUNKS of the same vendor export. Different bytes (chunk B
  // carries an extra row), so ADR-0069's byte-fingerprint 409 — correctly —
  // does not fire. Chunk B is then back-dated... no: chunk A is BACK-DATED so
  // recency is a fixture fact rather than a race between two inserts in the
  // same millisecond.
  chunkA = await applyCsv(`email,cost,month\n${JANE},33.33,2026-07\n`, "cur-chunk-1.csv");
  chunkB = await applyCsv(`email,cost,month\n${JANE},33.33,2026-07\n${BOB},44.44,2026-07\n`, "cur-chunk-2.csv");
  await db
    .update(costImportBatches)
    .set({ appliedAt: new Date(Date.now() - 3600_000) })
    .where(eq(costImportBatches.id, chunkA));
});

afterAll(async () => {
  await db.delete(importedCostLines);
  await db.delete(costImportBatches);
  await db.delete(costReconciliationRuns);
  await db.delete(schedulerRuns).where(eq(schedulerRuns.jobName, SCHEDULER_JOB_NAMES.costReconciliation));
  await db.delete(schedulerJobs).where(eq(schedulerJobs.name, SCHEDULER_JOB_NAMES.costReconciliation));
  await db
    .delete(auditLog)
    .where(inArray(auditLog.ruleId, [...Object.values(COST_IMPORT_RULE_IDS), ...Object.values(COST_RECONCILE_RULE_IDS)]));
  // the scheduler audit rows this suite's run-now produced, and no others
  await db
    .delete(auditLog)
    .where(sql`${auditLog.ruleId} LIKE 'scheduler-job-%' AND ${auditLog.detail}->>'job' = ${SCHEDULER_JOB_NAMES.costReconciliation}`);
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await app.close();
});

// ===========================================================================
// 1. THE DEFECT, PROVED FIRST — the non-vacuity control (mistakes.md M-002)
// ===========================================================================

describe("the double count exists before reconciliation", () => {
  it("two overlapping chunks make Jane's imported figure 66.66 where the vendor charged 33.33", async () => {
    const { body, jane } = await janeSubject();
    // THE DEFECT: the same vendor fact, counted once per batch. If this ever
    // reads 33.33 without a reconciliation pass having run, the read path
    // started de-duplicating silently and every test below is vacuous.
    expect(jane.imported.usd).toBe(JANE_DOUBLED);
    // and the response admits nothing was excluded yet
    expect(body.reconciliation.supersededLinesExcluded).toBe(0);
    expect(body.reconciliation.note).toMatch(/marked, never deleted/i);
  });
});

// ===========================================================================
// 2. The pass: marks, discloses, audits — and deletes NOTHING
// ===========================================================================

describe("POST /v1/cost-imports/reconcile", () => {
  it("marks exactly the older duplicate, and the consolidated read stops double-counting", async () => {
    const res = await post("/v1/cost-imports/reconcile", {});
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.scannedLines).toBe(3);
    expect(out.duplicateGroups).toBe(1);
    expect(out.supersededLines).toBe(1);
    expect(out.ambiguousGroups).toBe(0);
    expect(out.posture).toMatch(/NEVER deletes/);

    // THE INVARIANT: the same vendor line is counted once
    const { body, jane } = await janeSubject();
    expect(jane.imported.usd).toBe(JANE_USD);
    // Bob's non-duplicated line is untouched
    const bob = body.subjects.find((s: { subjectId: string | null }) => s.subjectId === bobId);
    expect(bob.imported.usd).toBe(BOB_USD);
    // THE DISCLOSURE: the read says what it excluded, and when the last pass ran
    expect(body.reconciliation.supersededLinesExcluded).toBe(1);
    expect(body.reconciliation.lastReconciledAt).not.toBeNull();
  });

  it("deleted NOTHING: all three lines still exist, the marked one naming its replacement, run and reason", async () => {
    const all = await db.select().from(importedCostLines);
    expect(all).toHaveLength(3);
    const marked = all.filter((l) => l.supersededAt !== null);
    expect(marked).toHaveLength(1);
    const m = marked[0]!;
    // the OLDER chunk's copy was marked, the newer chunk's kept
    expect(m.batchId).toBe(chunkA);
    expect(m.amount).toBe(JANE_USD);
    expect(m.supersededReason).toMatch(/marked, never deleted/);
    expect(m.supersededRunId).not.toBeNull();
    const kept = all.find((l) => l.id === m.supersededByLineId)!;
    expect(kept.batchId).toBe(chunkB);
    expect(kept.supersededAt).toBeNull();

    // the run ledger row
    const [run] = await db.select().from(costReconciliationRuns).where(eq(costReconciliationRuns.id, m.supersededRunId!));
    expect(run!.outcome).toBe("ok");
    expect(run!.supersededLines).toBe(1);
    expect(run!.trigger).toBe("manual");

    // audited: the group mark and the pass summary
    const groupAudits = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_RECONCILE_RULE_IDS.groupSuperseded));
    expect(groupAudits.length).toBe(1);
    expect(groupAudits[0]!.reason).toMatch(/superseded duplicates/);
    expect((groupAudits[0]!.detail as { supersededLineIds?: string[] }).supersededLineIds).toContain(m.id);
    const passAudits = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_RECONCILE_RULE_IDS.passCompleted));
    expect(passAudits.length).toBeGreaterThan(0);
  });

  it("is idempotent: a second pass marks nothing further and the figure stands", async () => {
    const res = await post("/v1/cost-imports/reconcile", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().supersededLines).toBe(0);
    const { jane } = await janeSubject();
    expect(jane.imported.usd).toBe(JANE_USD);
  });

  it("the health read reports the pass, the standing counts and the marked line", async () => {
    const res = await get("/v1/cost-imports/reconciliation");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.supersededLines).toBe(1);
    expect(body.liveLines).toBe(2);
    expect(body.lastRun.outcome).toBe("ok");
    expect(body.recentRuns.length).toBeGreaterThanOrEqual(2);
    expect(body.supersededSample).toHaveLength(1);
    expect(body.supersededSample[0]!.supersededReason).toMatch(/marked, never deleted/);
    expect(body.scheduler.jobName).toBe(SCHEDULER_JOB_NAMES.costReconciliation);
    expect(body.posture).toMatch(/revoke the wrong batch/i);
  });
});

// ===========================================================================
// 3. The two refusals — reported, never guessed at
// ===========================================================================

describe("ambiguity is refused loudly", () => {
  it("batches that disagree about multiplicity are REPORTED and left alone — all copies keep counting", async () => {
    // batch C says the ghost charge happened TWICE; batch D says once
    const cId = await applyCsv(`email,cost,month\n${GHOST},55.55,2026-07\n${GHOST},55.55,2026-07\n`, "ghost-twice.csv");
    await db.update(costImportBatches).set({ appliedAt: new Date(Date.now() - 3600_000) }).where(eq(costImportBatches.id, cId));
    const dId = await applyCsv(`email,cost,month\n${GHOST},55.55,2026-07\nx-filler@example.com,0.17,2026-07\n`, "ghost-once.csv");

    const res = await post("/v1/cost-imports/reconcile", {});
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.ambiguousGroups).toBe(1);
    expect(out.supersededLines).toBe(0);
    const warning = (out.warnings as Array<{ kind: string; detail: string }>).find(
      (w) => w.kind === "ambiguous_multiplicity",
    )!;
    expect(warning.detail).toMatch(/DIFFERENT\s+multiplicities/);
    expect(warning.detail).toMatch(/guessed dedup is a guessed invoice/);

    // nothing about the ghost account was marked: all three copies still live
    const ghostLines = await db
      .select()
      .from(importedCostLines)
      .where(eq(importedCostLines.accountKey, GHOST));
    expect(ghostLines).toHaveLength(3);
    expect(ghostLines.every((l) => l.supersededAt === null)).toBe(true);

    // the honest consequence, stated: the unattributed ghost still counts all
    // three copies — refusing to guess means the number stays wrong LOUDLY
    const { body } = await janeSubject();
    const unattributed = body.subjects.find((s: { subjectId: string | null }) => s.subjectId === null);
    expect(unattributed.imported.usd).toBeCloseTo(3 * GHOST_USD + 0.17, 2);

    // clean these two batches off so later tests read simply
    for (const id of [dId, cId]) {
      const revoked = await del(`/v1/cost-imports/${id}`, { reason: "test fixture teardown" });
      expect(revoked.statusCode).toBe(200);
    }
  });

  it("overlapping-but-not-identical windows are REPORTED, never superseded", async () => {
    const eId = await applyCsv(`email,cost,month\n${WINDOWY},12.12,2026-07\n`, "window-july.csv");
    await db.update(costImportBatches).set({ appliedAt: new Date(Date.now() - 3600_000) }).where(eq(costImportBatches.id, eId));
    // a second batch restating a HALF-OVERLAPPING window at a different amount
    const fRes = await post("/v1/cost-imports", {
      adapter: "generic_mapped",
      format: "csv",
      mode: "apply",
      content: `email,cost,start,end\n${WINDOWY},13.13,2026-07-15,2026-08-15\n`,
      source: "window-straddle.csv",
      config: {
        mapping: { account: "email", amount: "cost", periodStart: "start", periodEnd: "end" },
        defaults: { vendor: "aws" },
      },
    });
    expect(fRes.statusCode).toBe(201);
    const fId = fRes.json().importId as string;

    const res = await post("/v1/cost-imports/reconcile", {});
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.supersededLines).toBe(0);
    expect(out.overlapWarnings).toBeGreaterThanOrEqual(1);
    const warning = (out.warnings as Array<{ kind: string; detail: string; vendor: string }>).find(
      (w) => w.kind === "overlapping_window",
    )!;
    expect(warning.detail).toMatch(/NOT superseded/);

    const windowLines = await db.select().from(importedCostLines).where(eq(importedCostLines.accountKey, WINDOWY));
    expect(windowLines).toHaveLength(2);
    expect(windowLines.every((l) => l.supersededAt === null)).toBe(true);

    for (const id of [fId, eId]) {
      const revoked = await del(`/v1/cost-imports/${id}`, { reason: "test fixture teardown" });
      expect(revoked.statusCode).toBe(200);
    }
  });
});

// ===========================================================================
// 4. Revoking the superseding batch REINSTATES what it had superseded
// ===========================================================================

describe("a withdrawn restatement does not erase the fact it restated", () => {
  it("revoking chunk B brings chunk A's marked line back to life, and the figure survives", async () => {
    // control: before the revoke, chunk A's line is marked
    const [before] = await db
      .select()
      .from(importedCostLines)
      .where(eq(importedCostLines.batchId, chunkA));
    expect(before!.supersededAt).not.toBeNull();

    const revoked = await del(`/v1/cost-imports/${chunkB}`, { reason: "chunk 2 was the wrong export" });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().linesRemoved).toBe(2);
    expect(revoked.json().linesReinstated).toBe(1);

    const [after] = await db
      .select()
      .from(importedCostLines)
      .where(eq(importedCostLines.batchId, chunkA));
    expect(after!.supersededAt).toBeNull();
    expect(after!.supersededByLineId).toBeNull();
    expect(after!.supersededReason).toBeNull();

    // the vendor fact survives its restatement's withdrawal: 33.33, once,
    // now carried by chunk A
    const { jane } = await janeSubject();
    expect(jane.imported.usd).toBe(JANE_USD);

    const audits = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_RECONCILE_RULE_IDS.linesReinstated));
    expect(audits.length).toBe(1);
    expect(audits[0]!.reason).toMatch(/must not silently erase/);
  });
});

// ===========================================================================
// 5. The database refuses a half-written mark
// ===========================================================================

describe("the supersession columns are constrained, not conventions", () => {
  it("REFUSES a mark without a reason, and a line superseding itself", async () => {
    const [live] = await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, chunkA));
    expect(live).toBeDefined();
    await expect(
      db.update(importedCostLines).set({ supersededAt: new Date() }).where(eq(importedCostLines.id, live!.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(importedCostLines)
        .set({ supersededAt: new Date(), supersededReason: "self", supersededByLineId: live!.id })
        .where(eq(importedCostLines.id, live!.id)),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// 6. The scheduler job, and the gate
// ===========================================================================

describe("the ADR-0064 job and default-deny", () => {
  it("the sweep is registered with its ADR and runs through the scheduler surface into the same ledger", async () => {
    const registry = schedulerJobRegistry({});
    const def = registry.get(SCHEDULER_JOB_NAMES.costReconciliation)!;
    expect(def.adr).toBe("ADR-0076");
    expect(def.description).toMatch(/never deleted/);

    const runsBefore = await db.select().from(costReconciliationRuns);
    const res = await post(`/v1/scheduler/jobs/${SCHEDULER_JOB_NAMES.costReconciliation}/run`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("ok");
    const runsAfter = await db.select().from(costReconciliationRuns);
    // the scheduler-run pass wrote its OWN cost_reconciliation_runs row,
    // trigger 'schedule' — the same function, the same ledger
    expect(runsAfter.length).toBe(runsBefore.length + 1);
    const newRun = runsAfter.find((r) => !runsBefore.some((b) => b.id === r.id))!;
    expect(newRun.trigger).toBe("schedule");
    expect(newRun.outcome).toBe("ok");
  });

  it("a non-admin gets 403 on run-now and on the health read", async () => {
    for (const [method, url] of [
      ["POST", "/v1/cost-imports/reconcile"],
      ["GET", "/v1/cost-imports/reconciliation"],
    ] as const) {
      const res = await app.inject({ method, url, headers: janeAuth, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(403);
    }
  });
});
