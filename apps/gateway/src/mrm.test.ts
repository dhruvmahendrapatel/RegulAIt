import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  approvals,
  modelCardApprovals,
  modelCardEvidence,
  modelCards,
  orgSettings,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";

/**
 * ADR-0045 — THE MODEL RISK MANAGEMENT REGISTRY, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A SECOND APPROVALS QUEUE. The sign-off case asserts a real row lands in
 *     the ONE `approvals` table, that the named approver sees it in their
 *     ordinary inbox, and that the decision is made through
 *     `POST /v1/approvals/:id/decide` — the same endpoint every other approval
 *     in the product uses. If MRM ever grew its own decide path, this breaks.
 *
 *  2. AN EXPIRY THAT IS DECORATIVE. The expiry case asserts THE DISPATCH
 *     OUTCOME — a 409 from `POST /v1/agents/:id/invoke` with ZERO recorded
 *     provider calls — not a status flag on a row. And it does so with the
 *     stored status left at 'approved' (the sweep deliberately not run), which
 *     is the only way to prove the gate recomputes from `validUntil` instead of
 *     trusting a cache that a deployment may never refresh.
 *
 *  3. A GATE THAT IS REALLY A WARNING. The provider is wrapped by a recording
 *     spy. Every refusal asserts zero calls reached it.
 *
 *  4. AN IRREVERSIBLE TOGGLE. Turning `mrmEnforced` back off restores dispatch
 *     with the card data untouched — ADR-0024's reversibility property, which
 *     this ADR deliberately copied.
 *
 *  5. EVIDENCE THAT IS A STRING. The evidence case attaches a REAL ADR-0044
 *     `eval_runs` row and then proves the database refuses to delete that run
 *     while it is cited (ON DELETE RESTRICT).
 *
 * SHARED-STATE DISCIPLINE: `org_settings` is a singleton every other suite
 * reads. This file flips `mrmEnforced`, so `afterAll` restores the exact
 * pre-existing values AND deletes every card it created — a leaked enforced
 * toggle would fail every other dispatch test in the run. Every object is
 * `mrm-` prefixed.
 */

declare global {
  // eslint-disable-next-line no-var
  var __mrmProviderCalls: Array<{ model: string; input: string }>;
}
globalThis.__mrmProviderCalls = [];

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
        globalThis.__mrmProviderCalls.push({ model: req.model, input: req.input ?? "" });
        return inner.dispatch(req);
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "mrm-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let maraId: string;
let maraAuth: { authorization: string };
let rikaId: string;
let rikaAuth: { authorization: string };
let agentId: string;
let otherAgentId: string;
let cardId: string;
let evalRunId: string;
let priorOrg: { mrmEnforced: boolean; mrmExpiryWarnDays: number } | null = null;

function providerCalls() {
  return globalThis.__mrmProviderCalls;
}
function resetProviderCalls() {
  globalThis.__mrmProviderCalls = [];
}

async function setEnforced(enforced: boolean, warnDays?: number) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/mrm/enforcement",
    headers: AUTH,
    payload: { enforced, ...(warnDays !== undefined ? { warnDays } : {}) },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function invoke(auth: { authorization: string }, id = agentId) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${id}/invoke`,
    headers: auth,
    payload: { mode: "execute", input: "mrm probe", dispatch: true },
  });
}

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    // no "@" in the display name — another suite asserts across the whole users
    // table that nothing email-shaped leaks through the names-only directory
    payload: { email, displayName: email.split("@")[0]!.replace("-", " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "mrm" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

async function signOff(
  card: string,
  approverUserId: string,
  body: Record<string, unknown>,
  expectStatus = 201,
) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/mrm/cards/${card}/sign-off`,
    headers: AUTH,
    payload: { approverUserId, ...body },
  });
  expect(res.statusCode).toBe(expectStatus);
  return res;
}

async function decide(approvalId: string, auth: { authorization: string }, decision: "approved" | "denied", reason?: string) {
  return app.inject({
    method: "POST",
    url: `/v1/approvals/${approvalId}/decide`,
    headers: auth,
    payload: { decision, ...(reason ? { reason } : {}) },
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const [org] = await db.select().from(orgSettings);
  priorOrg = org
    ? { mrmEnforced: org.mrmEnforced, mrmExpiryWarnDays: org.mrmExpiryWarnDays }
    : null;

  const mara = await makeUser("mrm-mara@example.com");
  maraId = mara.id;
  maraAuth = mara.auth;
  const rika = await makeUser("mrm-rika@example.com");
  rikaId = rika.id;
  rikaAuth = rika.auth;

  for (const name of ["mrm-subject", "mrm-other"]) {
    const a = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    });
    expect(a.statusCode).toBe(201);
    if (name === "mrm-subject") agentId = a.json().id;
    else otherAgentId = a.json().id;
    // ONE agent per user, deliberately. The MRM gate governs the agent that is
    // actually SERVED — pillar-6 routing may serve a different registry entry
    // than the one named in the URL, and gating the requested-but-not-served
    // agent would be a hole. Restricting each user's entitlement to a single
    // agent makes "which agent was served" deterministic, so these assertions
    // are about the gate rather than about routing's choice.
    const grantee = name === "mrm-subject" ? maraId : rikaId;
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: grantee, agentId: a.json().id },
    });
  }

  // a REAL ADR-0044 eval run, so the evidence case links measured evidence
  // rather than a decorative id
  const ds = await app.inject({
    method: "POST",
    url: "/v1/evals/datasets",
    headers: AUTH,
    payload: { name: "mrm-golden", scorerKind: "contains", scorerConfig: { needles: ["ok"] } },
  });
  expect(ds.statusCode).toBe(201);
  const dsId = ds.json().id as string;
  const c = await app.inject({
    method: "POST",
    url: `/v1/evals/datasets/${dsId}/cases`,
    headers: AUTH,
    payload: { input: "say ok", expected: "ok" },
  });
  expect(c.statusCode).toBe(201);
  const run = await app.inject({
    method: "POST",
    url: "/v1/evals/runs",
    headers: maraAuth,
    payload: { datasetId: dsId, agentId, trigger: "manual" },
  });
  expect(run.statusCode).toBe(201);
  evalRunId = run.json().run.id;
  resetProviderCalls();
});

afterAll(async () => {
  // restore the singleton EXACTLY, then remove the cards — a leaked enforced
  // toggle would fail every other dispatch suite in the run
  if (priorOrg) {
    await db
      .update(orgSettings)
      .set({ mrmEnforced: priorOrg.mrmEnforced, mrmExpiryWarnDays: priorOrg.mrmExpiryWarnDays })
      .where(eq(orgSettings.id, "singleton"));
  } else {
    await db.update(orgSettings).set({ mrmEnforced: false, mrmExpiryWarnDays: 30 });
  }
  await db.delete(modelCardEvidence);
  await db.delete(modelCardApprovals);
  await db.delete(modelCards);
});

// ---------------------------------------------------------------------------

describe("model cards — authoring and admin gating", () => {
  it("every registry route is admin-only", async () => {
    for (const [method, url] of [
      ["GET", "/v1/mrm/cards"],
      ["GET", "/v1/mrm/status"],
      ["POST", "/v1/mrm/cards"],
      ["POST", "/v1/mrm/expiry-sweep"],
      ["POST", "/v1/mrm/enforcement"],
    ] as const) {
      const res = await app.inject({ method, url, headers: maraAuth, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe("admin_only");
    }
  });

  it("a card names exactly one subject and one intended use", async () => {
    const both = await app.inject({
      method: "POST",
      url: "/v1/mrm/cards",
      headers: AUTH,
      payload: { agentId, customProviderId: agentId, intendedUse: "x" },
    });
    expect(both.statusCode).toBe(400);
    const neither = await app.inject({
      method: "POST",
      url: "/v1/mrm/cards",
      headers: AUTH,
      payload: { intendedUse: "x" },
    });
    expect(neither.statusCode).toBe(400);
  });

  it("creates a card, audits it, and says plainly that it enforces nothing yet", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/mrm/cards",
      headers: AUTH,
      payload: {
        agentId,
        intendedUse: "summarize customer tickets",
        limitations: "not for legal or medical advice",
        dataClaims: { training: "vendor-stated; no customer data", retention: "30 days" },
        standardRefs: ["nist-ai-rmf:MEASURE-2.11", "iso-42001:8.3"],
      },
    });
    expect(res.statusCode).toBe(201);
    cardId = res.json().card.id;
    expect(res.json().card.state).toBe("unsigned");
    const rows = await audits("mrm-card-created");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.reason?.includes("enforces NOTHING"))).toBe(true);
  });

  it("a second card for the same (model, intended use) is refused — an ambiguous gate is not a gate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/mrm/cards",
      headers: AUTH,
      payload: { agentId, intendedUse: "summarize customer tickets" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("model_card_exists");
  });

  it("reports bias/fairness as an INCOMPLETE declaration, never as a measurement", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/mrm/cards/${cardId}`, headers: AUTH });
    const card = res.json().card;
    expect(card.completeness.complete).toBe(false);
    expect(card.completeness.missing).toContain("bias_fairness");
    expect(card.completeness.bias.declared).toBe(0);
    expect(card.completeness.bias.disclaimer).toContain("does not measure bias");
  });

  it("declared fairness slots are recorded and assessed for completeness (not for fairness)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/mrm/cards/${cardId}`,
      headers: AUTH,
      payload: {
        biasFairness: [
          {
            dimension: "dialect",
            method: "counterfactual prompt set, 200 pairs",
            status: "assessed",
            resultRef: evalRunId,
            assessedBy: "risk team",
          },
          { dimension: "age-bracket", method: "not applicable for this use", status: "waived" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.completeness.bias.complete).toBe(true);
    // ...and completeness overall is STILL false until evidence is attached
    expect(res.json().card.completeness.missing).toContain("evidence");
  });
});

describe("evidence — a real ADR-0044 eval run, and it cannot be deleted out from under the decision", () => {
  it("attaches a real eval run and audits it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/evidence`,
      headers: AUTH,
      payload: { kind: "eval_run", evalRunId, label: "pre-sign-off regression run" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().evidence.evalRunId).toBe(evalRunId);
    const [row] = await db
      .select()
      .from(modelCardEvidence)
      .where(eq(modelCardEvidence.id, res.json().evidence.id));
    expect(row!.kind).toBe("eval_run");
    expect((await audits("mrm-evidence-attached")).length).toBeGreaterThanOrEqual(1);
  });

  it("a nonexistent eval run is refused rather than stored as a dangling id", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/evidence`,
      headers: AUTH,
      payload: { kind: "eval_run", evalRunId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("the same run twice is a duplicate, not two pieces of evidence", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/evidence`,
      headers: AUTH,
      payload: { kind: "eval_run", evalRunId },
    });
    expect(res.statusCode).toBe(409);
  });

  it("the database REFUSES to delete an eval run that is cited as evidence", async () => {
    await expect(
      db.execute(sql`delete from eval_runs where id = ${evalRunId}`),
    ).rejects.toThrow();
    // and the run is still there
    const [still] = await db.execute(sql`select id from eval_runs where id = ${evalRunId}`).then((r) =>
      (r as unknown as { rows: Array<{ id: string }> }).rows,
    );
    expect(still?.id).toBe(evalRunId);
  });

  it("the card is complete once every section is authored and evidenced", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/mrm/cards/${cardId}`, headers: AUTH });
    expect(res.json().card.completeness.complete).toBe(true);
  });
});

describe("sign-off rides the ONE Approvals Queue — there is no second inbox", () => {
  let approvalId: string;

  it("a sign-off must carry a recertification date, or explicitly accept having none", async () => {
    await signOff(cardId, rikaId, {}, 400);
  });

  it("a recertification date in the past is refused — it would create an already-lapsed acceptance", async () => {
    await signOff(cardId, rikaId, { validUntil: new Date(Date.now() - 60_000).toISOString() }, 422);
  });

  it("creates a REAL row in the existing approvals table with objectType model_card", async () => {
    const res = await signOff(cardId, rikaId, {
      // comfortably beyond the 30-day warn window, so `state` reads 'approved'
      // rather than 'expiring' — the warn window is exercised separately
      validUntil: new Date(Date.now() + 180 * 86_400_000).toISOString(),
      reason: "initial risk review",
    });
    approvalId = res.json().approvalId;
    const [queued] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(queued).toBeDefined();
    expect(queued!.objectType).toBe("model_card");
    expect(queued!.status).toBe("pending");
    expect(queued!.approverUserId).toBe(rikaId);
    expect(queued!.stageId).toBe(`__model_card__:${cardId}`);
  });

  it("the named approver sees it in their ORDINARY inbox, labelled", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/approvals", headers: rikaAuth });
    expect(res.statusCode).toBe(200);
    const row = res.json().approvals.find((a: { id: string }) => a.id === approvalId);
    expect(row).toBeDefined();
    expect(row.objectLabel).toContain("model risk sign-off");
    expect(row.objectLabel).toContain("summarize customer tickets");
  });

  it("a second concurrent request is refused — two live risk positions on one purpose is nonsense", async () => {
    await signOff(cardId, rikaId, { validUntil: new Date(Date.now() + 60 * 86_400_000).toISOString() }, 409);
  });

  it("someone who is not the named approver cannot decide it", async () => {
    const res = await decide(approvalId, maraAuth, "approved");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_the_named_approver");
  });

  it("the ONE decide endpoint records the risk acceptance on the card chain", async () => {
    const res = await decide(approvalId, rikaAuth, "approved", "reviewed against the attached eval run");
    expect(res.statusCode).toBe(200);
    const [record] = await db
      .select()
      .from(modelCardApprovals)
      .where(eq(modelCardApprovals.approvalId, approvalId));
    expect(record!.status).toBe("approved");
    expect(record!.decidedBy).toBe(rikaId);
    expect(record!.validUntil).toBeTruthy();
    const rows = await audits("mrm-sign-off-approved");
    expect(rows.length).toBe(1);
    expect(rows[0]!.objectType).toBe("model_card");
    expect(rows[0]!.objectId).toBe(cardId);
  });

  it("the card now reads approved", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/mrm/cards/${cardId}`, headers: AUTH });
    expect(res.json().card.state).toBe("approved");
  });
});

describe("the dispatch gate — default off, then ENFORCED, then reversible", () => {
  it("with the toggle off, an UNCARDED agent dispatches exactly as before", async () => {
    resetProviderCalls();
    const res = await invoke(rikaAuth, otherAgentId);
    expect(res.statusCode).toBe(200);
    expect(providerCalls().length).toBe(1);
  });

  it("the posture label says DECLARED but NOT enforced while the toggle is off", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mrm/status", headers: AUTH });
    expect(res.json().enforced).toBe(false);
    expect(res.json().posture).toBe("declared");
    expect(res.json().label).toContain("NOT enforced");
  });

  it("turning enforcement ON refuses the UNCARDED agent at dispatch with ZERO provider calls", async () => {
    await setEnforced(true);
    resetProviderCalls();
    const res = await invoke(rikaAuth, otherAgentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("mrm_approval_required");
    expect(providerCalls().length).toBe(0);
    const rows = await audits("mrm-no-card");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.effect).toBe("deny");
    expect(rows[0]!.objectType).toBe("model_card");
  });

  it("the CARDED, signed-off agent dispatches while enforcement is on", async () => {
    resetProviderCalls();
    const res = await invoke(maraAuth, agentId);
    expect(res.statusCode).toBe(200);
    expect(providerCalls().length).toBe(1);
  });

  it("the posture label says ENFORCED once the toggle is on", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mrm/status", headers: AUTH });
    expect(res.json().posture).toBe("enforced");
    expect(res.json().label).toContain("ENFORCED");
  });

  it("a card with NO sign-off refuses with mrm-approval-required, distinct from never-carded", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/v1/mrm/cards",
      headers: AUTH,
      payload: { agentId: otherAgentId, intendedUse: "draft release notes" },
    });
    expect(made.statusCode).toBe(201);
    resetProviderCalls();
    const res = await invoke(rikaAuth, otherAgentId);
    expect(res.statusCode).toBe(409);
    expect(providerCalls().length).toBe(0);
    const rows = await audits("mrm-approval-required");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect((rows[0]!.detail as { modelCardId?: string }).modelCardId).toBe(made.json().card.id);
  });

  it("turning enforcement back OFF restores dispatch with the card data untouched (reversible)", async () => {
    await setEnforced(false);
    resetProviderCalls();
    const res = await invoke(rikaAuth, otherAgentId);
    expect(res.statusCode).toBe(200);
    expect(providerCalls().length).toBe(1);
    const remaining = await db.select().from(modelCards).where(eq(modelCards.agentId, otherAgentId));
    expect(remaining.length).toBe(1);
    await setEnforced(true);
  });
});

describe("EXPIRY IS ENFORCED, not decorative", () => {
  it("a lapsed sign-off BLOCKS DISPATCH even though the stored status still says approved", async () => {
    // reach past the API on purpose: this is the state a real deployment is in
    // between the moment an acceptance lapses and the moment a sweep (which
    // nothing here runs on a timer) notices.
    await db
      .update(modelCardApprovals)
      .set({ validUntil: new Date(Date.now() - 60_000) })
      .where(and(eq(modelCardApprovals.cardId, cardId), eq(modelCardApprovals.status, "approved")));
    const [stale] = await db
      .select()
      .from(modelCardApprovals)
      .where(and(eq(modelCardApprovals.cardId, cardId), eq(modelCardApprovals.status, "approved")));
    expect(stale!.status).toBe("approved"); // the cache is deliberately stale

    resetProviderCalls();
    const res = await invoke(maraAuth, agentId);
    // THE DISPATCH OUTCOME, not a flag
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("mrm_approval_required");
    expect(res.json().detail).toContain("LAPSED");
    expect(providerCalls().length).toBe(0);
    const rows = await audits("mrm-approval-expired");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.effect).toBe("deny");
  });

  it("the expiring worklist surfaces the lapse as WORK", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mrm/expiring", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: { cardId: string }) => i.cardId === cardId);
    expect(item).toBeDefined();
    expect(item.effectiveStatus).toBe("expired");
    expect(item.daysUntilExpiry).toBeLessThanOrEqual(0);
  });

  it("the sweep flips the STORED status and audits each flip — but it is a display job, not the control", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/mrm/expiry-sweep", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().expired).toBeGreaterThanOrEqual(1);
    expect(res.json().note).toContain("no in-process scheduler");
    const [row] = await db
      .select()
      .from(modelCardApprovals)
      .where(eq(modelCardApprovals.cardId, cardId));
    expect(row!.status).toBe("expired");
    expect((await audits("mrm-approval-expired-swept")).length).toBeGreaterThanOrEqual(1);
  });

  it("dispatch is still refused after the sweep (same outcome, now from a fresh status)", async () => {
    resetProviderCalls();
    const res = await invoke(maraAuth, agentId);
    expect(res.statusCode).toBe(409);
    expect(providerCalls().length).toBe(0);
  });

  it("RECERTIFICATION restores dispatch and supersedes the lapsed acceptance rather than editing it", async () => {
    const req = await signOff(cardId, rikaId, {
      validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      reason: "annual recertification",
    });
    const dec = await decide(req.json().approvalId, rikaAuth, "approved", "recertified");
    expect(dec.statusCode).toBe(200);

    resetProviderCalls();
    const res = await invoke(maraAuth, agentId);
    expect(res.statusCode).toBe(200);
    expect(providerCalls().length).toBe(1);

    // the chain, not an edit: the lapsed record is still there
    const chain = await db.select().from(modelCardApprovals).where(eq(modelCardApprovals.cardId, cardId));
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain.filter((c) => c.status === "approved").length).toBe(1);
    expect(chain.some((c) => c.status === "expired")).toBe(true);
  });

  it("a DENIED sign-off does not become an acceptance, and dispatch stays refused", async () => {
    // revoke the live one first so the card has no live acceptance
    const rev = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/revoke`,
      headers: AUTH,
      payload: { reason: "provider changed the model behind the id" },
    });
    expect(rev.statusCode).toBe(200);

    const req = await signOff(cardId, rikaId, {
      validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const dec = await decide(req.json().approvalId, rikaAuth, "denied", "not acceptable for this data class");
    expect(dec.statusCode).toBe(200);
    const [record] = await db
      .select()
      .from(modelCardApprovals)
      .where(eq(modelCardApprovals.approvalId, req.json().approvalId));
    expect(record!.status).toBe("denied");

    resetProviderCalls();
    const res = await invoke(maraAuth, agentId);
    expect(res.statusCode).toBe(409);
    expect(providerCalls().length).toBe(0);
    expect((await audits("mrm-sign-off-denied")).length).toBeGreaterThanOrEqual(1);
  });

  it("a REVOKED acceptance audits and is distinguishable from an expiry", async () => {
    expect((await audits("mrm-sign-off-revoked")).length).toBeGreaterThanOrEqual(1);
  });

  it("leaves enforcement OFF for every suite that follows", async () => {
    await setEnforced(false);
    resetProviderCalls();
    const res = await invoke(maraAuth, agentId);
    expect(res.statusCode).toBe(200);
  });
});
