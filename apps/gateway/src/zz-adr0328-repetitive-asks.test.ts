import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  inArray,
  notInArray,
  repetitiveAskClusterSpans,
  repetitiveAskClusters,
  repetitiveAskSettings,
  runMigrations,
  traceSpans,
  traces,
  REPETITIVE_ASK_CLUSTER_STATUSES,
  type Db,
} from "@regulait/db";
import { REPETITIVE_ASK_CLUSTER_MACHINE, STATE_MACHINES } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { CLUSTER_SAMPLE, REPETITIVE_ASK_AUDIT_RULE_IDS, suggestCandidate } from "./repetitive-asks.js";

/**
 * ADR-0328 slice 2 — repetitive-ask detection at the gateway: off by default, step-up to relax, a scan that finds
 * clusters of near-duplicate prompts in captured previews and suggests the cheaper agent right-sized routing would
 * pick, storing no prompt text. Read-only: nothing here changes routing.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0328-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Math.random().toString(36).slice(2, 8);
const TEMPLATE = (n: number) => `Summarise support ticket ${1000 + n} for the weekly report: customer cannot reset password, include priority and owner`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let USER_KEY: { authorization: string };
let bigId: string;
let smallId: string;
let traceId: string;
const restores: Array<() => Promise<void>> = [];
const asSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));
const asSteppedUp = async (facts: Record<string, unknown>) =>
  stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
const lastAudit = async (ruleId: string) => (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1))[0];
const clustersOf = (agentId: string) => db.select().from(repetitiveAskClusters).where(eq(repetitiveAskClusters.agentId, agentId));
const scanNow = async () => {
  // the scan is spaced 10 minutes apart; a test moves the clock back instead of waiting
  await db.update(repetitiveAskSettings).set({ lastScanAt: null });
  return app.inject({ method: "POST", url: "/v1/repetitive-asks/scan", headers: KEY });
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  await db.delete(repetitiveAskSettings);
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0328-admin-${RUN}@example.com`, displayName: "ask admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  KEY = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0328" } })).json().token}` };
  const user = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0328-user-${RUN}@example.com`, displayName: "ask user" } });
  USER_KEY = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${user.json().id}/keys`, headers: AUTH, payload: { name: "u" } })).json().token}` };
  const [big] = await db
    .insert(agents)
    .values({ name: `adr0328-big-${RUN}`, provider: "mock", tier: 3, costPerMTokIn: 15, costPerMTokOut: 75, model: "mock-large" })
    .returning({ id: agents.id });
  const [small] = await db
    .insert(agents)
    .values({ name: `adr0328-small-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 0.25, costPerMTokOut: 1.25, model: "mock-small" })
    .returning({ id: agents.id });
  bigId = big!.id;
  smallId = small!.id;
  // the scan's pool is every enabled agent, and files sharing this database leave their own (some cheaper than the
  // small one) behind: only this file's two are enabled while it runs, the others are re-enabled afterwards
  const others = await db
    .update(agents)
    .set({ enabled: false })
    .where(and(eq(agents.enabled, true), notInArray(agents.id, [bigId, smallId])))
    .returning({ id: agents.id });
  if (others.length > 0) restores.push(async () => void (await db.update(agents).set({ enabled: true }).where(inArray(agents.id, others.map((o) => o.id)))));
  const [t] = await db.insert(traces).values({ kind: "dispatch", name: "adr0328", userId: adminId, status: "ok" }).returning();
  traceId = t!.id;
  const base = { traceId, kind: "llm" as const, status: "ok" as const, startedAt: new Date(), agentId: bigId, name: "adr0328", costUsd: 0.02 };
  const spans: (typeof traceSpans.$inferInsert)[] = Array.from({ length: 30 }, (_, i) => ({ ...base, seq: i, inputPreview: TEMPLATE(i) }));
  // asks the scan must not read: withheld content, a failed call, and unrelated one-offs
  spans.push({ ...base, seq: 100, inputPreview: TEMPLATE(99), contentWithheld: true });
  spans.push({ ...base, seq: 101, inputPreview: TEMPLATE(98), status: "error" });
  ["write a haiku about autumn", "compare postgres and mysql replication", "draft a cover letter for a nurse"].forEach((text, i) =>
    spans.push({ ...base, seq: 200 + i, inputPreview: text }),
  );
  await db.insert(traceSpans).values(spans);
});

afterAll(async () => {
  for (const id of [bigId, smallId]) if (id) await db.delete(agents).where(eq(agents.id, id));
  if (traceId) await db.delete(traces).where(eq(traces.id, traceId));
  await db.delete(repetitiveAskSettings);
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("ADR-0328 slice 2: repetitive-ask detection", () => {
  it("the cluster lifecycle is a declared ADR-0348 machine over its column's states", () => {
    const m = REPETITIVE_ASK_CLUSTER_MACHINE;
    expect([...m.def.states].sort()).toEqual([...REPETITIVE_ASK_CLUSTER_STATUSES].sort());
    expect(STATE_MACHINES[m.def.id]).toBe(m);
  });

  it("is off by default and admin-only", async () => {
    const s = await app.inject({ method: "GET", url: "/v1/repetitive-asks/settings", headers: KEY });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ settings: { enabled: false, maxHamming: 3, minSimilarity: 0.9, minClusterSize: 20 }, floors: { maxHamming: 5 } });
    const scan = await app.inject({ method: "POST", url: "/v1/repetitive-asks/scan", headers: KEY });
    expect(scan.statusCode).toBe(409);
    expect(scan.json().error).toBe("repetitive_asks_disabled");
    expect((await app.inject({ method: "GET", url: "/v1/repetitive-asks/settings", headers: USER_KEY })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/repetitive-asks/scan", headers: USER_KEY })).statusCode).toBe(403);
  });

  it("turning it on or relaxing a threshold needs a step-up; tightening does not; the floors hold", async () => {
    const refused = await app.inject({ method: "PUT", url: "/v1/repetitive-asks/settings", ...(await asSession()), payload: { enabled: true } });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    expect(refused.json().error).toMatch(/^step_up_/);
    expect((await app.inject({ method: "PUT", url: "/v1/repetitive-asks/settings", headers: KEY, payload: { maxHamming: 6 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/v1/repetitive-asks/settings", headers: KEY, payload: { minSimilarity: 0.7 } })).statusCode).toBe(400);
    const tighten = await app.inject({ method: "PUT", url: "/v1/repetitive-asks/settings", ...(await asSession()), payload: { minSimilarity: 0.95 } });
    expect(tighten.statusCode, tighten.body).toBe(200);
    const on = await app.inject({
      method: "PUT",
      url: "/v1/repetitive-asks/settings",
      ...(await asSteppedUp({ repetitiveAsks: "settings", values: { enabled: true, minSimilarity: 0.9 } })),
      payload: { enabled: true, minSimilarity: 0.9 },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().settings).toMatchObject({ enabled: true, minSimilarity: 0.9 });
    expect((await lastAudit(REPETITIVE_ASK_AUDIT_RULE_IDS.settings))!.detail).toMatchObject({ relaxed: ["enabled", "minSimilarity"] });
  });

  it("a scan finds the repeated template, suggests the cheaper agent routing would pick, and stores no prompt text", async () => {
    const r = await scanNow();
    expect(r.statusCode, r.body).toBe(200);
    const [c, ...rest] = await clustersOf(bigId);
    expect(rest).toEqual([]);
    // the withheld and failed spans are not members; the one-offs are not a cluster
    expect(c!.asks).toBe(30);
    expect(c!.candidateAgentId).toBe(smallId);
    // 30 × $0.02 over the 30-day window, most of it saved at the small agent's price
    expect(c!.windowCostUsd).toBeCloseTo(0.6, 6);
    expect(c!.projectedMonthlySavingsUsd!).toBeGreaterThan(0.55);
    expect(c!.projectedMonthlySavingsUsd!).toBeLessThan(0.6);
    const sample = await db.select().from(repetitiveAskClusterSpans).where(eq(repetitiveAskClusterSpans.clusterId, c!.id));
    expect(sample).toHaveLength(Math.min(30, CLUSTER_SAMPLE));
    for (const word of ["Summarise", "password", "ticket", "weekly"]) {
      expect(JSON.stringify(c)).not.toContain(word);
      expect(JSON.stringify((await lastAudit(REPETITIVE_ASK_AUDIT_RULE_IDS.scan))!.detail)).not.toContain(word);
    }
    const list = await app.inject({ method: "GET", url: `/v1/repetitive-asks/clusters?agentId=${bigId}`, headers: KEY });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toMatchObject([{ id: c!.id, evidence: { asks: 30 }, suggestion: { candidateAgentId: smallId }, lifecycle: { state: "suggested" } }]);
  });

  it("a second scan within ten minutes is refused", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/repetitive-asks/scan", headers: KEY });
    expect(r.statusCode).toBe(429);
  });

  it("dismissal is final: a rescan refreshes the evidence but not the status", async () => {
    const [c] = await clustersOf(bigId);
    const d = await app.inject({ method: "POST", url: `/v1/repetitive-asks/clusters/${c!.id}/dismiss`, headers: KEY });
    expect(d.statusCode, d.body).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/repetitive-asks/clusters/${c!.id}/dismiss`, headers: KEY })).statusCode).toBe(409);
    expect((await scanNow()).statusCode).toBe(200);
    const [again] = await clustersOf(bigId);
    expect(again!.status).toBe("dismissed");
    expect(again!.detectedAt.getTime()).toBeGreaterThan(c!.detectedAt.getTime());
    expect((await app.inject({ method: "GET", url: `/v1/repetitive-asks/clusters?agentId=${bigId}`, headers: KEY })).json().items).toEqual([]);
  });

  it("suggests nothing when routing keeps the agent: no cheaper priced agent at or below its tier", () => {
    const served = { id: "a", name: "a", tier: 1, costPerMTokIn: 1, costPerMTokOut: 1 };
    expect(suggestCandidate(served, [served, { id: "b", name: "b", tier: 2, costPerMTokIn: 0.1, costPerMTokOut: 0.1 }], TEMPLATE(1))).toBeNull();
    expect(suggestCandidate(served, [served, { id: "c", name: "c", tier: 1, costPerMTokIn: null, costPerMTokOut: null }], TEMPLATE(1))).toBeNull();
    expect(suggestCandidate(served, [served, { id: "d", name: "d", tier: 1, costPerMTokIn: 0.5, costPerMTokOut: 0.5 }], TEMPLATE(1))).toMatchObject({ agentId: "d" });
  });
});
