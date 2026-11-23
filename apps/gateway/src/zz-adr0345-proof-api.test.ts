/**
 * ADR-0345 (lane E26) slice 3 — the agent-risk register's read and settings APIs, through the real app.
 *
 *  - GET /v1/agent-risks: the whole catalogue, every proof on its secure default, each latest result labelled;
 *  - GET /v1/agent-risks/proofs/:proofKey/results: newest first, keyset-paged, each result labelled as evidence;
 *  - PUT /v1/agent-risks/proofs/:proofKey/settings: tightening needs no step-up; turning a proof off or lengthening
 *    it past its default needs a `settings_relax` step-up bound to the exact values; every change is audited;
 *  - NEGATIVE: a non-admin is refused all three; an API key cannot relax; a grant for other values does not apply;
 *    an unknown proof is 404 and an out-of-range interval is 400; a refused relaxation writes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentRiskProofSettings,
  auditLog,
  createDb,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  runWithRlsSystem,
  users,
  type Db,
} from "@regulait/db";
import { AGENT_RISK_CATALOG_VERSION, AGENT_RISKS, BATCH4_STRICT_DEFAULTS, agentRiskProofs } from "@regulait/shared";
import { buildApp } from "./app.js";
import { AGENT_RISK_PROOF_SETTINGS_RULE_ID } from "./agent-risk-proof-routes.js";
import { runAgentRiskProof } from "./agent-risk-proof-runner.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `e26-api-boot-${RUN}`;
const boot = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];

/** a ledger-check proof: it runs without any engine dependency, so its results are real and quick */
const hygiene = () => agentRiskProofs().find((p) => p.proof.engine === "ledger_check" && p.proof.check !== "audit_chain_verifies")!;
const settingsUrl = (key: string) => `/v1/agent-risks/proofs/${key}/settings`;
const relaxFacts = (values: Record<string, unknown>) => ({ kind: "settings_relax" as const, facts: { values } });
const auditsFor = async (proofKey: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, AGENT_RISK_PROOF_SETTINGS_RULE_ID)).orderBy(desc(auditLog.seq))).filter(
    (a) => (a.detail as { proofKey?: string }).proofKey === proofKey,
  );

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db
    .select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db
    .update(orgSettings)
    .set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT, retry: { maxAttempts: 1 } });
  await app.ready();
  const a = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `e26-api-admin-${RUN}@example.test`, displayName: "E26 API admin" } });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: boot, payload: { name: "e26" } })).json().token}` };
  const m = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `e26-api-member-${RUN}@example.test`, displayName: "E26 API member" } });
  const memberId = m.json().id as string;
  memberKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${memberId}/keys`, headers: boot, payload: { name: "e26m" } })).json().token}` };
}, 120_000);

afterAll(async () => {
  await db.delete(agentRiskProofSettings);
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

describe("ADR-0345 slice 3: the register read", () => {
  it("lists every risk and proof, each proof on its secure default", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/agent-risks", headers: adminKey });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.catalogVersion).toBe(AGENT_RISK_CATALOG_VERSION);
    expect(body.risks.map((x: { key: string }) => x.key)).toEqual(AGENT_RISKS.map((x) => x.key));
    const proofs = body.risks.flatMap((x: { proofs: unknown[] }) => x.proofs);
    expect(proofs.length).toBe(agentRiskProofs().length);
    expect(body.summary.proofs).toBe(proofs.length);
    for (const p of proofs) expect(p.setting).toMatchObject({ enabled: true, intervalHours: null, secureDefault: true });
  });

  it("a recorded result shows as the proof's latest, labelled as evidence", async () => {
    await runWithRlsSystem("system_task", "test.adr0345.api", () => runAgentRiskProof(db, hygiene(), { trigger: "manual" }));
    const body = (await app.inject({ method: "GET", url: "/v1/agent-risks", headers: adminKey })).json();
    const p = body.risks.flatMap((x: { proofs: Array<{ key: string }> }) => x.proofs).find((x: { key: string }) => x.key === hygiene().proof.key);
    expect(p.latest).not.toBeNull();
    expect(["verified", "unsigned", "unverifiable"]).toContain(p.latest.evidence.label);
  });

  it("results are newest first, keyset-paged, each labelled", async () => {
    await runWithRlsSystem("system_task", "test.adr0345.api", () => runAgentRiskProof(db, hygiene(), { trigger: "manual" }));
    const url = `/v1/agent-risks/proofs/${hygiene().proof.key}/results?limit=1`;
    const first = (await app.inject({ method: "GET", url, headers: adminKey })).json();
    expect(first.results).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (await app.inject({ method: "GET", url: `${url}&cursor=${encodeURIComponent(first.nextCursor)}`, headers: adminKey })).json();
    expect(second.results).toHaveLength(1);
    expect(new Date(second.results[0].finishedAt).getTime()).toBeLessThanOrEqual(new Date(first.results[0].finishedAt).getTime());
    expect(second.results[0].id).not.toBe(first.results[0].id);
    expect(first.results[0].evidence.label).toMatch(/^(verified|unsigned|unverifiable)$/);
  });

  it("NEGATIVE: a non-admin is refused every route; an unknown proof is 404", async () => {
    for (const [method, url] of [
      ["GET", "/v1/agent-risks"],
      ["GET", `/v1/agent-risks/proofs/${hygiene().proof.key}/results`],
      ["PUT", settingsUrl(hygiene().proof.key)],
    ] as const) {
      const r = await app.inject({ method, url, headers: memberKey, payload: method === "PUT" ? { enabled: true, intervalHours: null, reason: "x" } : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: "/v1/agent-risks/proofs/no_such.proof/results", headers: adminKey })).statusCode).toBe(404);
  });
});

describe("ADR-0345 slice 3: the settings write", () => {
  it("tightening (on, at or under the default interval) needs no step-up and is audited", async () => {
    const key = hygiene().proof.key;
    const r = await app.inject({ method: "PUT", url: settingsUrl(key), headers: adminKey, payload: { enabled: true, intervalHours: 12, reason: "run it more often" } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ setting: { enabled: true, intervalHours: 12, effectiveIntervalHours: 12, secureDefault: true }, relaxed: [] });
    const [audit] = await auditsFor(key);
    expect(audit!.detail).toMatchObject({ after: { enabled: true, intervalHours: 12 }, relaxed: [], reason: "run it more often" });
  });

  it("NEGATIVE: turning a proof off with an API key is refused and writes nothing", async () => {
    const key = hygiene().proof.key;
    const auditsBefore = (await auditsFor(key)).length;
    const r = await app.inject({ method: "PUT", url: settingsUrl(key), headers: adminKey, payload: { enabled: false, intervalHours: null, reason: "noisy" } });
    expect(r.statusCode).toBe(403);
    const [row] = await db.select().from(agentRiskProofSettings).where(eq(agentRiskProofSettings.proofKey, key));
    expect(row!.enabled).toBe(true);
    expect((await auditsFor(key)).length).toBe(auditsBefore);
  });

  it("turning a proof off needs a step-up bound to that value, and is audited as a relaxation", async () => {
    const key = hygiene().proof.key;
    // NEGATIVE: a grant for a different value does not apply
    const wrong = await grantStepUpForTest(db, adminId, relaxFacts({ [`agentRiskProof.${key}.intervalHours`]: 72 }));
    const refused = await app.inject({ method: "PUT", url: settingsUrl(key), ...stepUpRequest(wrong), payload: { enabled: false, intervalHours: null, reason: "noisy" } });
    // the presented grant is not valid for these values (audited as refused); this admin has no other method
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ error: "step_up_unavailable", actionKind: "settings_relax" });
    expect((await db.select().from(agentRiskProofSettings).where(eq(agentRiskProofSettings.proofKey, key)))[0]!.enabled).toBe(true);
    const g = await grantStepUpForTest(db, adminId, relaxFacts({ [`agentRiskProof.${key}.enabled`]: false }));
    const r = await app.inject({ method: "PUT", url: settingsUrl(key), ...stepUpRequest(g), payload: { enabled: false, intervalHours: null, reason: "noisy" } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ setting: { enabled: false, secureDefault: false }, relaxed: [`agentRiskProof.${key}.enabled`] });
    const [audit] = await auditsFor(key);
    expect(audit!.detail).toMatchObject({ before: { enabled: true }, after: { enabled: false }, relaxed: [`agentRiskProof.${key}.enabled`] });
    expect(audit!.userId).toBe(adminId);
  });

  it("lengthening past the default interval is a relaxation too; re-enabling is not", async () => {
    const key = hygiene().proof.key;
    const def = hygiene().proof.defaultIntervalHours;
    const noStepUp = await app.inject({ method: "PUT", url: settingsUrl(key), headers: adminKey, payload: { enabled: true, intervalHours: def * 2, reason: "weekly enough" } });
    expect(noStepUp.statusCode).toBe(403);
    const g = await grantStepUpForTest(db, adminId, relaxFacts({ [`agentRiskProof.${key}.intervalHours`]: def * 2 }));
    const r = await app.inject({ method: "PUT", url: settingsUrl(key), ...stepUpRequest(g), payload: { enabled: true, intervalHours: def * 2, reason: "weekly enough" } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().relaxed).toEqual([`agentRiskProof.${key}.intervalHours`]);
    const back = await app.inject({ method: "PUT", url: settingsUrl(key), headers: adminKey, payload: { enabled: true, intervalHours: null, reason: "back to default" } });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().setting).toMatchObject({ enabled: true, intervalHours: null, secureDefault: true });
  });

  it("NEGATIVE: an unknown proof is 404; an out-of-range interval or a blank reason is 400", async () => {
    expect((await app.inject({ method: "PUT", url: settingsUrl("no_such.proof"), headers: adminKey, payload: { enabled: true, intervalHours: null, reason: "x" } })).statusCode).toBe(404);
    for (const payload of [
      { enabled: true, intervalHours: 0, reason: "x" },
      { enabled: true, intervalHours: 169, reason: "x" },
      { enabled: true, intervalHours: null, reason: " " },
      { enabled: true, intervalHours: null, reason: "x", extra: 1 },
    ]) {
      expect((await app.inject({ method: "PUT", url: settingsUrl(hygiene().proof.key), headers: adminKey, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});
