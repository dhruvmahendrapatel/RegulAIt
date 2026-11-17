/**
 * ADR-0349 slice 3 (lane E30): the executor renews its stage claim under a short lease, every renewal is a guarded
 * UPDATE on the database clock, and a schedule-to-close limit fails an execution that runs too long, under the same
 * claim guard as any completion (the executor's late result is then discarded).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { and, auditLog, createDb, desc, eq, runMigrations, sql, workflowInstances, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { stageClaimState, workflowTestHooks } from "./workflows.js";
import {
  claimLeaseMs,
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_EXECUTION_MAX_MS,
  executionMaxMs,
  renewStageClaim,
  startClaimHeartbeat,
} from "./workflow-claim-heartbeat.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "e30-hb-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now().toString(36);
const CHANGE_TYPE = `e30-heartbeat-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
let pia: { id: string; auth: { authorization: string } };

const until = async (what: string, check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** a bare instance resting at a claimed check stage (no executor), for the renewal primitives */
async function claimedRow(opts: { sinceSql?: ReturnType<typeof sql> } = {}) {
  const claimId = randomUUID();
  const [row] = await db
    .insert(workflowInstances)
    .values({
      templateIds: [],
      definition: { workflow: "hb", stages: [{ id: "t", type: "trigger" }, { id: "checks", type: "automated_check", checks: ["unit"] }] },
      initiatorUserId: pia.id,
      change: { description: "hb", paths: [] },
      state: { status: "awaiting_execution", currentStageIndex: 1, stageStatuses: ["completed", "active"], artifactVersions: {} },
      status: "awaiting_execution",
      stageEntry: 1,
      context: {},
    })
    .returning();
  await db
    .update(workflowInstances)
    .set({
      context: sql`jsonb_build_object('executing', 'checks', 'executingEntry', 1, 'executingClaim', ${claimId}::text, 'executingSince', to_jsonb(${opts.sinceSql ?? sql`now()`}))`,
    })
    .where(eq(workflowInstances.id, row!.id));
  return { instanceId: row!.id, stageId: "checks", entry: 1, claimId };
}

const contextOf = async (id: string) =>
  (await db.select({ c: workflowInstances.context }).from(workflowInstances).where(eq(workflowInstances.id, id)))[0]!.c as Record<string, unknown>;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  const user = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `e30-hb-${RUN}@example.com`, displayName: "pia" } });
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${user.json().id}/keys`, payload: { name: "t" } });
  pia = { id: user.json().id, auth: { authorization: `Bearer ${key.json().token}` } };
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: { name: CHANGE_TYPE, definition: { workflow: CHANGE_TYPE, stages: [{ id: "intake", type: "trigger" }, { id: "checks", type: "automated_check", checks: ["unit"] }] } },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType: CHANGE_TYPE } });
  expect(rule.statusCode).toBe(201);
});

afterEach(() => {
  delete workflowTestHooks.afterStageClaim;
  delete workflowTestHooks.claimHeartbeat;
});

afterAll(async () => {
  await restoreIdentity?.();
  await app.close();
});

describe("ADR-0349 slice 3: lease and limit settings", () => {
  it("are bounded and fall back to their defaults", () => {
    expect(claimLeaseMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_CLAIM_LEASE_MS);
    expect(claimLeaseMs({ REGULAIT_WORKFLOW_CLAIM_LEASE_MS: "30000" } as NodeJS.ProcessEnv)).toBe(30_000);
    expect(claimLeaseMs({ REGULAIT_WORKFLOW_CLAIM_LEASE_MS: "1000" } as NodeJS.ProcessEnv)).toBe(DEFAULT_CLAIM_LEASE_MS);
    // the older variable is still read when the new one is unset
    expect(claimLeaseMs({ REGULAIT_WORKFLOW_CLAIM_TTL_MS: "120000" } as NodeJS.ProcessEnv)).toBe(120_000);
    expect(executionMaxMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_EXECUTION_MAX_MS);
    expect(executionMaxMs({ REGULAIT_WORKFLOW_EXECUTION_MAX_MS: "soon" } as NodeJS.ProcessEnv)).toBe(DEFAULT_EXECUTION_MAX_MS);
  });

  it("the lease runs from the last renewal", () => {
    const T0 = Date.parse("2026-11-17T12:00:00Z");
    const old = new Date(T0 - DEFAULT_CLAIM_LEASE_MS - 1).toISOString();
    expect(stageClaimState({ executing: "s", executingSince: old }, "s", T0).heldLive).toBe(false);
    expect(stageClaimState({ executing: "s", executingSince: old, executingRenewedAt: new Date(T0 - 1_000).toISOString() }, "s", T0).heldLive).toBe(true);
  });
});

describe("ADR-0349 slice 3: renewStageClaim, the guarded UPDATE", () => {
  it("renews on the database clock while the claim is this executor's", async () => {
    const g = await claimedRow();
    expect(await renewStageClaim(db, g, 60_000)).toBe("renewed");
    const ctx = await contextOf(g.instanceId);
    expect(typeof ctx.executingRenewedAt).toBe("string");
    const [clock] = (await db.execute(sql`select abs(extract(epoch from (now() - ${ctx.executingRenewedAt as string}::timestamptz))) as drift`)).rows as Array<{ drift: number }>;
    expect(Number(clock!.drift)).toBeLessThan(5);
  });

  it("is lost when the claim was re-taken, the entry moved or the instance left awaiting_execution", async () => {
    const a = await claimedRow();
    expect(await renewStageClaim(db, { ...a, claimId: randomUUID() }, 60_000)).toBe("lost");
    expect(await renewStageClaim(db, { ...a, entry: 2 }, 60_000)).toBe("lost");
    await db.update(workflowInstances).set({ status: "aborted" }).where(eq(workflowInstances.id, a.instanceId));
    expect(await renewStageClaim(db, a, 60_000)).toBe("lost");
    expect((await contextOf(a.instanceId)).executingRenewedAt).toBeUndefined();
  });

  it("reports the limit, writing nothing, once the execution is past schedule-to-close", async () => {
    const g = await claimedRow({ sinceSql: sql`now() - interval '3 hours'` });
    expect(await renewStageClaim(db, g, DEFAULT_EXECUTION_MAX_MS)).toBe("limit");
    expect((await contextOf(g.instanceId)).executingRenewedAt).toBeUndefined();
  });
});

describe("ADR-0349 slice 3: startClaimHeartbeat", () => {
  it("renews every third of the lease and stops when the claim is lost", async () => {
    const g = await claimedRow();
    const hb = startClaimHeartbeat(db, g, async () => {}, { leaseMs: 3_000, maxMs: 60_000 });
    try {
      await until("a renewal", async () => typeof (await contextOf(g.instanceId)).executingRenewedAt === "string");
      await db
        .update(workflowInstances)
        .set({ context: sql`jsonb_set(${workflowInstances.context}, '{executingClaim}', '"someone-else"')` })
        .where(eq(workflowInstances.id, g.instanceId));
      await until("the loss", async () => hb.state === "lost");
    } finally {
      await hb.stop();
    }
  });

  it("calls the limit handler once, and stops renewing", async () => {
    const g = await claimedRow({ sinceSql: sql`now() - interval '10 minutes'` });
    let calls = 0;
    const hb = startClaimHeartbeat(db, g, async () => void calls++, { leaseMs: 3_000, maxMs: 60_000 });
    try {
      await until("the limit", async () => calls > 0);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(calls).toBe(1);
      expect(hb.state).toBe("limit");
    } finally {
      await hb.stop();
    }
  });
});

describe("ADR-0349 slice 3: the executor end to end", () => {
  const start = () =>
    app.inject({
      method: "POST",
      headers: pia.auth,
      url: "/v1/workflows/instances",
      payload: { change: { description: `e30 hb ${randomUUID()}`, paths: [], changeType: CHANGE_TYPE, environment: "dev" } },
    });

  it("a slow but live executor keeps its claim past the lease: renewals keep it live", async () => {
    workflowTestHooks.claimHeartbeat = { leaseMs: 3_000, maxMs: 60_000 };
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    let at: { instanceId: string; claimId: string } | undefined;
    workflowTestHooks.afterStageClaim = async (a) => {
      at = a;
      await parked;
    };
    const started = start();
    await until("the claim", async () => at !== undefined);
    // longer than the lease: the claim is still live only because it was renewed
    await new Promise((r) => setTimeout(r, 4_000));
    const ctx = await contextOf(at!.instanceId);
    expect(ctx.executingClaim).toBe(at!.claimId);
    const renewed = Date.parse(ctx.executingRenewedAt as string);
    expect(stageClaimState(ctx, "checks", renewed + 1_000, 3_000).heldLive).toBe(true);
    release();
    expect((await started).statusCode).toBe(201);
  });

  it("past schedule-to-close the stage fails as execution_failed, audited, and the late result is discarded", async () => {
    workflowTestHooks.claimHeartbeat = { leaseMs: 3_000, maxMs: 1_500 };
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    let at: { instanceId: string; claimId: string } | undefined;
    workflowTestHooks.afterStageClaim = async (a) => {
      at = a;
      await parked;
    };
    const started = start();
    await until("the claim", async () => at !== undefined);
    await until("the limit failure", async () =>
      (await db.select().from(auditLog).where(and(eq(auditLog.objectId, at!.instanceId), eq(auditLog.ruleId, "workflow:execution-limit-reached")))).length > 0,
    );
    release();
    expect((await started).statusCode).toBe(201);
    const [row] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, at!.instanceId));
    expect(row!.status).toBe("awaiting_execution");
    const ctx = row!.context as Record<string, unknown>;
    expect(ctx.lastError).toMatch(/execution limit reached/);
    expect(ctx.executing).toBeUndefined();
    const rules = (await db.select({ r: auditLog.ruleId }).from(auditLog).where(eq(auditLog.objectId, at!.instanceId)).orderBy(desc(auditLog.at))).map((x) => x.r);
    expect(rules).toContain("workflow:execution_failed");
    expect(rules).toContain("workflow:executor-result-discarded");
  });
});
