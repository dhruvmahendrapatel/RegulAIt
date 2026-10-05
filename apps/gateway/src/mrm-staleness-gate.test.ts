/**
 * ADR-0086 §3's named follow-up (batch B3) — STALENESS FORCES
 * RECERTIFICATION, proved through the DISPATCH OUTCOME the mrm.test.ts way:
 *
 *  0. ADR-0181: the knob SHIPS ARMED (mrmEnforced and staleness recert both
 *     default on); turned OFF (an audited admin relaxation), it is
 *     byte-identical even with mrmEnforced ON and the card DRIFTED: the exact
 *     dispatch that refuses once the knob is armed succeeds, with the provider
 *     spy recording the call.
 *  2. ARMED + DRIFTED REFUSES, pre-provider, on the SAME 409
 *     `mrm_approval_required` path expiry uses (extended, never forked) —
 *     with the staleness evidence NAMED in the response and audited under
 *     its own ruleId (`mrm-staleness-recert-required`).
 *  3. THE THRESHOLD IS A DIAL: drift below it dispatches.
 *  4. RECERTIFYING CLEARS IT: a new superseding sign-off through the ONE
 *     decide path resets the drift clock and restores dispatch.
 *  5. THE KNOB DEEPENS THE ONE GATE, IT CREATES NONE: staleness-recert armed
 *     with mrmEnforced OFF gates nothing.
 *  6. ADR-0181: AN EVALUATION IS NOT REFUSED FOR STALENESS. A dispatch naming
 *     the server-side `evals` feature (eval case, judge, red-team probe) on a
 *     drifted card proceeds and is audited `mrm-staleness-evaluation-allowed`;
 *     the same dispatch without the feature still refuses.
 *
 * Drift is manufactured as a GRANT CHANGE on the card's subject agent — one
 * of the exact `computeCardStaleness` ledger counts (never re-derived here).
 *
 * SHARED-STATE DISCIPLINE (M-012): this file flips four `org_settings`
 * fields; `afterAll` restores the exact pre-existing values and deletes the
 * cards it created. It relaxes only the attribution mandate (its dispatches
 * name no project) through `relaxGovernanceGatesForTest`, restored after.
 * Everything here is prefixed msg-.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  count,
  createDb,
  eq,
  inArray,
  modelCardApprovals,
  modelCards,
  orgSettings,
  runMigrations,
  agents,
  type Db,
} from "@regulait/db";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

declare global {
  // eslint-disable-next-line no-var
  var __msgProviderCalls: Array<{ model: string; input: string }>;
}
globalThis.__msgProviderCalls = [];

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        globalThis.__msgProviderCalls.push({ model: req.model, input: req.input ?? "" });
        return inner.dispatch(req);
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { executeGovernedDispatch } = await import("./agents-connectors.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "msg-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let maraId: string;
let maraAuth: { authorization: string };
let rikaId: string;
let rikaAuth: { authorization: string };
let agentId: string;
let cardId: string;
let priorOrg: {
  mrmEnforced: boolean;
  mrmExpiryWarnDays: number;
  mrmStalenessRecertEnabled: boolean;
  mrmStalenessRecertThreshold: number;
} | null = null;
/** users granted the subject agent purely to move the grant ledger */
let driftGrantSeq = 0;
let restoreGates: () => Promise<void> = async () => {};

function providerCalls() {
  return globalThis.__msgProviderCalls;
}
function resetProviderCalls() {
  globalThis.__msgProviderCalls = [];
}

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    // no "@" in the display name — another suite asserts nothing email-shaped
    // leaks through the names-only directory
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "msg" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function setEnforcement(payload: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/mrm/enforcement", headers: AUTH, payload });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function invoke() {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: maraAuth,
    payload: { mode: "execute", input: "msg probe", dispatch: true },
  });
}

/** move the staleness ledger: one NEW grant on the subject agent is exactly
 * one `grantChanges` count in computeCardStaleness */
async function createDrift() {
  const extra = await makeUser(`msg-drift-${++driftGrantSeq}@example.com`);
  const g = await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId: extra.id, agentId },
  });
  expect(g.statusCode).toBe(201);
}

async function certify(validDays: number, reason: string) {
  const req = await app.inject({
    method: "POST",
    url: `/v1/mrm/cards/${cardId}/sign-off`,
    headers: AUTH,
    payload: {
      approverUserId: rikaId,
      validUntil: new Date(Date.now() + validDays * 86_400_000).toISOString(),
      reason,
    },
  });
  expect(req.statusCode).toBe(201);
  const dec = await app.inject({
    method: "POST",
    url: `/v1/approvals/${req.json().approvalId}/decide`,
    headers: rikaAuth,
    payload: { decision: "approved", reason },
  });
  expect(dec.statusCode).toBe(200);
}

async function auditCount(ruleId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return row?.n ?? 0;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // the dispatches here name no project: relax only the attribution mandate
  restoreGates = await relaxGovernanceGatesForTest(db, { dispatchAttributionRequired: false });

  const [org] = await db.select().from(orgSettings);
  priorOrg = org
    ? {
        mrmEnforced: org.mrmEnforced,
        mrmExpiryWarnDays: org.mrmExpiryWarnDays,
        mrmStalenessRecertEnabled: org.mrmStalenessRecertEnabled,
        mrmStalenessRecertThreshold: org.mrmStalenessRecertThreshold,
      }
    : null;

  const mara = await makeUser("msg-mara@example.com");
  maraId = mara.id;
  maraAuth = mara.auth;
  const rika = await makeUser("msg-rika@example.com");
  rikaId = rika.id;
  rikaAuth = rika.auth;

  // ONE agent for the ONE invoking user (the mrm.test.ts lesson) — the gate
  // governs the SERVED agent, and a single-agent entitlement keeps that
  // deterministic.
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: "msg-subject", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  const g = await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId: maraId, agentId },
  });
  expect(g.statusCode).toBe(201);

  const card = await app.inject({
    method: "POST",
    url: "/v1/mrm/cards",
    headers: AUTH,
    payload: { agentId, intendedUse: "msg: summarize internal notes" },
  });
  expect(card.statusCode).toBe(201);
  cardId = card.json().card.id;
  await certify(180, "msg: initial certification");
  resetProviderCalls();
});

afterAll(async () => {
  // M-012: restore the singleton EXACTLY, then remove this suite's cards — a
  // leaked enforced/armed knob would fail every later dispatch suite
  if (priorOrg) {
    await db.update(orgSettings).set(priorOrg).where(eq(orgSettings.id, "singleton"));
  } else {
    await db
      .update(orgSettings)
      .set({
        mrmEnforced: true,
        mrmExpiryWarnDays: 30,
        mrmStalenessRecertEnabled: true,
        mrmStalenessRecertThreshold: 1,
      });
  }
  await restoreGates();
  const mine = await db.select({ id: modelCards.id }).from(modelCards).where(eq(modelCards.agentId, agentId));
  if (mine.length > 0) {
    await db.delete(modelCardApprovals).where(
      inArray(
        modelCardApprovals.cardId,
        mine.map((c) => c.id),
      ),
    );
    await db.delete(modelCards).where(eq(modelCards.agentId, agentId));
  }
  await app.close();
  await db.$client.end();
});

describe("ships armed (ADR-0181); relaxed off it is byte-identical — even enforced, even drifted", () => {
  it("ships armed: /v1/mrm/status reports enforcement and the knob on, threshold 1", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mrm/status", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().enforced).toBe(true);
    expect(res.json().stalenessRecertEnabled).toBe(true);
    expect(res.json().stalenessRecertThreshold).toBe(1);
  });

  it("with mrmEnforced ON, a DRIFTED certified card still dispatches while the knob is off", async () => {
    await setEnforcement({ enforced: true, stalenessRecertEnabled: false });
    await createDrift(); // 1 grant change since certification
    resetProviderCalls();
    const res = await invoke();
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1);
  });
});

describe("armed — drift at the threshold refuses on the expiry gate's own 409 path", () => {
  it("refuses pre-provider with the staleness evidence named, audited under its own ruleId", async () => {
    const armed = await setEnforcement({ enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 });
    expect(armed.stalenessRecertEnabled).toBe(true);
    const before = await auditCount("mrm-staleness-recert-required");
    resetProviderCalls();
    const res = await invoke();
    expect(res.statusCode).toBe(409);
    // the SAME stable caller-facing code every MRM refusal carries
    expect(res.json().error).toBe("mrm_approval_required");
    expect(res.json().detail).toContain("STALE");
    expect(res.json().detail).toContain("grant change"); // the evidence, named
    expect(res.json().detail).toContain("recertify");
    expect(providerCalls().length).toBe(0);
    expect(await auditCount("mrm-staleness-recert-required")).toBe(before + 1);
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "mrm-staleness-recert-required"));
    const mine = rows.filter((r) => r.objectId === cardId);
    expect(mine.length).toBe(1);
    expect(mine[0]!.effect).toBe("deny");
    const detail = mine[0]!.detail as {
      staleness: { changesSinceCertification: { grantChanges: number }; totalChanges: number };
      stalenessThreshold: number;
    };
    expect(detail.staleness.changesSinceCertification.grantChanges).toBe(1);
    expect(detail.staleness.totalChanges).toBe(1);
    expect(detail.stalenessThreshold).toBe(1);
  });

  it("drift BELOW the threshold dispatches — the threshold is a dial, not a decoration", async () => {
    await setEnforcement({ enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 5 });
    resetProviderCalls();
    const res = await invoke();
    expect(res.statusCode, res.body).toBe(200); // 1 change < 5
    expect(providerCalls().length).toBe(1);
    await setEnforcement({ enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 });
  });

  it("RECERTIFYING clears it: a new superseding sign-off resets the drift clock and restores dispatch", async () => {
    // still refused just before (threshold back at 1)
    resetProviderCalls();
    expect((await invoke()).statusCode).toBe(409);
    expect(providerCalls().length).toBe(0);

    await certify(90, "msg: recertified after reviewing the drift");
    resetProviderCalls();
    const res = await invoke();
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1);

    // the chain grew — the drifted acceptance was superseded, never edited
    const chain = await db.select().from(modelCardApprovals).where(eq(modelCardApprovals.cardId, cardId));
    expect(chain.filter((c) => c.status === "approved").length).toBe(1);
    expect(chain.some((c) => c.status === "superseded")).toBe(true);
  });

  it("fresh drift after the recertification refuses again — the clock really is the granting decision", async () => {
    await createDrift();
    resetProviderCalls();
    const res = await invoke();
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain("grant change");
    expect(providerCalls().length).toBe(0);
  });
});

describe("the knob deepens the ONE gate — it creates none of its own", () => {
  it("staleness-recert armed with mrmEnforced OFF gates nothing", async () => {
    await setEnforcement({ enforced: false, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 });
    resetProviderCalls();
    const res = await invoke(); // the card is still drifted from the last test
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1);
  });

});

describe("ADR-0181 — an evaluation is not refused for staleness", () => {
  async function evalDispatch(feature?: "evals") {
    const [served] = await db.select().from(agents).where(eq(agents.id, agentId));
    return executeGovernedDispatch(db, DATA_KEY, {
      userId: maraId,
      served: served!,
      requestedAgentId: agentId,
      baseline: null,
      input: "msg evaluation probe",
      maxTokens: 64,
      projectId: null,
      ...(feature ? { modelFeature: { feature } } : {}),
      detail: { purpose: "msg-evaluation" },
    });
  }

  it("armed and drifted: an `evals` dispatch proceeds, audited; the same dispatch without it refuses", async () => {
    await setEnforcement({ enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 });
    await createDrift();
    const allowedBefore = await auditCount("mrm-staleness-evaluation-allowed");
    const refusedBefore = await auditCount("mrm-staleness-recert-required");
    resetProviderCalls();

    const evaluation = await evalDispatch("evals");
    expect(evaluation.ok, JSON.stringify(evaluation).slice(0, 300)).toBe(true);
    expect(providerCalls().length).toBe(1);
    expect(await auditCount("mrm-staleness-evaluation-allowed")).toBe(allowedBefore + 1);

    const production = await evalDispatch();
    expect(production.ok).toBe(false);
    expect(providerCalls().length).toBe(1);
    expect(await auditCount("mrm-staleness-recert-required")).toBe(refusedBefore + 1);
  });

  it("leaves the strict defaults for the suites that follow", async () => {
    await setEnforcement({ enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 });
    const res = await app.inject({ method: "GET", url: "/v1/mrm/status", headers: AUTH });
    expect(res.json().enforced).toBe(true);
    expect(res.json().stalenessRecertEnabled).toBe(true);
  });
});
