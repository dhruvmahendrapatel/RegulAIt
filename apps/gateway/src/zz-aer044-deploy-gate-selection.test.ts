/**
 * AER-044 — `POST /v1/gates/deploy` with an `agentIds` selection.
 *
 * Policy pinned here (packages/shared/src/deploy-gate.ts): a selection never
 * narrows what the gate checks. The use case's whole approved stack is always
 * evaluated, so an OMITTED list, an EMPTY `[]` and a SUBSET that leaves out an
 * intended agent all check every intended agent — a halted or MRM-refused
 * intended agent blocks however the request is phrased, and the audit row
 * records both what was asked (`requestedAgents`) and what was checked
 * (`agents`). The positive case: a clean stack is allowed for all three
 * phrasings, with every intended agent still checked.
 *
 * MRM enforcement is switched on for this suite (the refused agent has no
 * model card; the others carry a live sign-off) and the org singleton is
 * restored exactly in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  createDb,
  eq,
  inArray,
  modelCardApprovals,
  modelCards,
  orgSettings,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { setAssuranceGateModeForTest } from "./testing/assurance-mode.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `aer044-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
let ownerId = "";
let ownerAuth: { authorization: string };
let priorMrmEnforced: boolean | null = null;
const ag = { clean: "", clean2: "", halted: "", refused: "" };
const uc = { halt: "", mrm: "", ok: "" };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `aer044-owner-${RUN}@example.com`, displayName: "owner" } });
  ownerId = u.json().id as string;
  const token = (await app.inject({ method: "POST", url: `/v1/users/${ownerId}/keys`, headers: AUTH, payload: { name: "ci" } })).json().token;
  ownerAuth = { authorization: `Bearer ${token}` };

  const mk = async (name: string, over: Partial<typeof agents.$inferInsert> = {}) => {
    const [a] = await db
      .insert(agents)
      .values({ name: `aer044-${name}-${RUN}`, provider: "mock", tier: 1, model: "m", ownerUserId: ownerId, ...over })
      .returning({ id: agents.id });
    return a!.id;
  };
  ag.clean = await mk("clean");
  ag.clean2 = await mk("clean2");
  ag.halted = await mk("halted", { haltedAt: new Date(), haltedReason: "aer044 drill", haltedByUserId: ownerId });
  ag.refused = await mk("refused"); // active, but no model card → refused while MRM is enforced
  // a live sign-off for every agent except `refused`, so the only block on a
  // stack is the one the test plants
  for (const id of [ag.clean, ag.clean2, ag.halted]) {
    const [card] = await db.insert(modelCards).values({ agentId: id, intendedUse: `aer044 ${RUN}` }).returning({ id: modelCards.id });
    await db.insert(modelCardApprovals).values({
      cardId: card!.id,
      status: "approved",
      approverUserId: ownerId,
      decidedAt: new Date(),
      validUntil: new Date(Date.now() + 30 * 86_400_000),
    });
  }

  const base = { description: "synthetic", businessContext: "aer044", dataSensitivity: "internal" as const, ownerUserId: ownerId, status: "approved" as const };
  const mkUc = async (name: string, intendedAgentIds: string[]) => {
    const [row] = await db.insert(aiUseCases).values({ ...base, name: `aer044 ${name} ${RUN}`, intendedAgentIds }).returning({ id: aiUseCases.id });
    return row!.id;
  };
  uc.halt = await mkUc("halt", [ag.clean, ag.halted]);
  uc.mrm = await mkUc("mrm", [ag.clean, ag.refused]);
  uc.ok = await mkUc("ok", [ag.clean, ag.clean2]);

  const [org] = await db.select({ mrmEnforced: orgSettings.mrmEnforced }).from(orgSettings);
  priorMrmEnforced = org ? org.mrmEnforced : null;
  const on = await app.inject({ method: "POST", url: "/v1/mrm/enforcement", headers: AUTH, payload: { enforced: true } });
  expect(on.statusCode, on.body).toBe(200);
}, 120_000);

afterAll(async () => {
  // restore the org singleton exactly — a leaked enforced knob would fail
  // every later dispatch suite on this database
  await db.update(orgSettings).set({ mrmEnforced: priorMrmEnforced ?? false });
  const ids = Object.values(ag).filter(Boolean);
  if (ids.length) await db.delete(modelCards).where(inArray(modelCards.agentId, ids));
  app.server.closeAllConnections();
  await app.close();
});

/** one gate call with a unique ref, plus the single audit row it wrote */
async function gate(useCaseId: string, agentIds: string[] | undefined, label: string) {
  const ref = `aer044-${label}-${RUN}`;
  const r = await app.inject({
    method: "POST",
    url: "/v1/gates/deploy",
    headers: ownerAuth,
    payload: { useCaseId, environment: "production", ref, ...(agentIds !== undefined ? { agentIds } : {}) },
  });
  expect(r.statusCode, r.body).toBe(200);
  const rows = (
    await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "deploy_gate"), eq(auditLog.objectId, useCaseId)))
  ).filter((row) => (row.detail as { ref?: string }).ref === ref);
  expect(rows).toHaveLength(1);
  return { body: r.json(), audit: rows[0]! };
}

/** omitted, explicit empty, and a subset naming only the clean agent — so it
 * leaves out the stack's other intended agent */
const selections: Array<[string, () => string[] | undefined]> = [
  ["omitted", () => undefined],
  ["empty", () => []],
  ["subset", () => [ag.clean]],
];

describe("AER-044 — the deploy gate's agent selection cannot skip an intended agent", () => {
  for (const [label, sel] of selections) {
    it(`${label} selection: a HALTED intended agent blocks, and the audit row says so`, async () => {
      const requested = sel();
      const { body, audit } = await gate(uc.halt, requested, `halt-${label}`);
      expect(body.decision).toBe("deny");
      expect(body.agentsChecked).toEqual([ag.clean, ag.halted]);
      expect(body.agentsRequested).toEqual(requested ?? null);
      expect(body.reasons.filter((x: any) => x.severity === "block")).toEqual([
        expect.objectContaining({ code: "agent_unavailable", ref: { type: "agent", id: ag.halted } }),
      ]);
      expect(audit).toMatchObject({ ruleId: "deploy-gate-denied", effect: "deny", userId: ownerId });
      expect(audit.detail).toMatchObject({
        decision: "deny",
        environment: "production",
        agents: [ag.clean, ag.halted],
        requestedAgents: requested ?? null,
        reasons: [{ code: "agent_unavailable", severity: "block", ref: { type: "agent", id: ag.halted } }],
      });
    });
  }

  for (const [label, sel] of selections) {
    it(`${label} selection: an MRM-REFUSED intended agent blocks, and the audit row says so`, async () => {
      const requested = sel();
      const { body, audit } = await gate(uc.mrm, requested, `mrm-${label}`);
      expect(body.decision).toBe("deny");
      expect(body.agentsChecked).toEqual([ag.clean, ag.refused]);
      expect(body.reasons).toEqual([expect.objectContaining({ code: "mrm_refused", severity: "block", ref: { type: "agent", id: ag.refused } })]);
      expect(audit).toMatchObject({ ruleId: "deploy-gate-denied", effect: "deny" });
      expect(audit.detail).toMatchObject({
        decision: "deny",
        agents: [ag.clean, ag.refused],
        requestedAgents: requested ?? null,
        reasons: [{ code: "mrm_refused", severity: "block", ref: { type: "agent", id: ag.refused } }],
      });
    });
  }

  for (const [label, sel] of selections) {
    it(`${label} selection on a clean stack: allowed, every intended agent checked`, async () => {
      const requested = sel();
      const { body, audit } = await gate(uc.ok, requested, `ok-${label}`);
      expect(body.decision).toBe("allow");
      expect(body.reasons).toEqual([]);
      expect(body.agentsChecked).toEqual([ag.clean, ag.clean2]);
      expect(audit).toMatchObject({ ruleId: "deploy-gate-allowed", effect: "allow" });
      expect(audit.detail).toMatchObject({ decision: "allow", agents: [ag.clean, ag.clean2], requestedAgents: requested ?? null, reasons: [] });
    });
  }

  it("a selection naming an agent outside the stack still blocks on it (the stack is checked too)", async () => {
    const { body, audit } = await gate(uc.ok, [ag.clean, ag.refused], "offstack");
    expect(body.decision).toBe("deny");
    expect(body.agentsChecked).toEqual([ag.clean, ag.clean2, ag.refused]);
    expect(body.reasons.map((x: any) => [x.code, x.ref.id])).toEqual([["agent_not_in_approved_stack", ag.refused]]);
    expect(audit).toMatchObject({ ruleId: "deploy-gate-denied" });
  });
});

// ADR-0180: this file pins the gate rules above; the continuous-assurance checks
// (strict `enforce` by default) are pinned in zz-adr0180-a3-required-tests.test.ts.
// M-068: the strict default is restored before the file ends.
let restoreAssuranceMode = async (): Promise<void> => {};
beforeAll(async () => {
  restoreAssuranceMode = await setAssuranceGateModeForTest(db, "off");
});
afterAll(async () => {
  await restoreAssuranceMode();
});
