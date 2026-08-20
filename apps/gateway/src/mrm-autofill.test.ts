import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  evalDatasets,
  evalRuns,
  guardrailConfigs,
  inArray,
  modelCardApprovals,
  modelCardEvidence,
  modelCards,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { GROUNDEDNESS_SCORER_KINDS } from "./risks.js";
import {
  MRM_AUTOFILL_NOTE,
  MRM_AUTOFILL_UNMEASURED_REDTEAM,
} from "./mrm-autofill.js";

/**
 * ADR-0086 — MODEL-CARD AUTOFILL FROM THE LEDGERS, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. AUTOFILL THAT IS A STORED FIELD. Every assertion is a DELTA around a
 *     ledger write: an eval run / red-team row / guardrail change appears in
 *     the card's `autofill` WITHOUT any card edit, and a write scoped to a
 *     DIFFERENT agent does not (the control). If the block were copied onto
 *     the card at authoring time, both directions break.
 *  2. A READ THAT WRITES. The detail read is taken twice and the audit trail
 *     and the card row are asserted unmoved — a "computed" block that caches
 *     itself anywhere would show up here.
 *  3. COMPUTED AND MANUAL BLENDED. Manually attached evidence stays in
 *     `evidence`, the computed block stays in `autofill`, and attaching
 *     evidence moves only the former.
 *  4. A SNAPSHOT THAT KEEPS RECOMPUTING. The decide-path freeze is asserted
 *     to hold its figures verbatim AFTER the ledgers move on — a snapshot
 *     that re-derives would track the new numbers and stop being a record of
 *     what the approver saw.
 *  5. STALENESS THAT NEVER FIRES (or always). A freshly certified card must
 *     read clean; the SAME card must read drifted after exactly the writes
 *     the summary names; an uncertified card must say staleness is undefined
 *     rather than showing a reassuring zero.
 *  6. A SYNTHESIZED FAIRNESS NUMBER. ADR-0045 §2's line holds: no autofill
 *     section computes bias/fairness, and the note says so.
 *
 * SHARED-STATE DISCIPLINE: no org_settings mutation anywhere (enforcement is
 * never toggled — sign-off works regardless). The one singleton this file
 * touches is a guardrail AGENT override on its own agent, deleted in the test
 * that made it AND again in afterAll (M-012). All objects are `mrmaf-`
 * prefixed; cards/chains/evidence and the inserted red-team rows are removed
 * in afterAll, audit assertions are scoped to this file's objects (M-008).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "mrmaf-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let maraId: string;
let maraAuth: { authorization: string };
let rikaId: string;
let rikaAuth: { authorization: string };
let agentId: string; // the card's subject — mara's ONE agent
let otherAgentId: string; // the control — rika's ONE agent
let cardId: string;
let datasetId: string;
let otherDatasetId: string;
const myCardIds: string[] = [];
const myRedteamRunIds: string[] = [];

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "mrmaf" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function detail(id = cardId) {
  const res = await app.inject({ method: "GET", url: `/v1/mrm/cards/${id}`, headers: AUTH });
  expect(res.statusCode).toBe(200);
  return res.json().card as {
    evidence: Array<{ id: string; evalRunId: string | null }>;
    updatedAt: string;
    autofill: {
      computedAt: string;
      note: string;
      scope: { agentId: string | null; customProviderId: string | null };
      sections: {
        evals: {
          runsEver: number;
          runsInWindow: number;
          latestRun: { id: string; passRate: number | null } | null;
          groundedness: { runsInWindow: number; latestRun: { scorerKind: string } | null; note?: string };
          note?: string;
        };
        redteam: {
          measured: boolean;
          runsEver: number;
          latestRun: Record<string, unknown> | null;
          note: string;
        };
        guardrails: {
          orgDefault: unknown;
          agentOverrides: Array<{ agentId: string; modes: Record<string, string> }>;
        };
        usage: { dispatchesInWindow: number; costUsdInWindow: number };
        grants: { effectiveHolders: number; directUsers: number };
        drift: { baselinesPinned: number; note?: string };
        links: { useCases: unknown[]; risks: unknown[]; vendors: unknown[] };
      };
    };
    staleness: {
      certified: boolean;
      lastCertifiedAt: string | null;
      changesSinceCertification: Record<string, number> | null;
      drifted: boolean;
      summary: string | null;
      note: string;
    };
  };
}

/** run a real eval (the ledger write the card must notice) as the ONE user
 * entitled to that agent, so which agent was served is deterministic */
async function runEval(agent: string, auth: { authorization: string }, ds = datasetId) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/evals/runs",
    headers: auth,
    payload: { datasetId: ds, agentId: agent, trigger: "manual" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().run as { id: string };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const mara = await makeUser("mrmaf-mara@example.com");
  maraId = mara.id;
  maraAuth = mara.auth;
  const rika = await makeUser("mrmaf-rika@example.com");
  rikaId = rika.id;
  rikaAuth = rika.auth;

  // ONE agent per user (the mrm.test.ts discipline): pillar-6 routing then has
  // exactly one servable agent per initiator, so every ledger row lands on the
  // agent the assertion is about.
  for (const [name, grantee] of [
    ["mrmaf-subject", () => maraId],
    ["mrmaf-other", () => rikaId],
  ] as const) {
    const a = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    });
    expect(a.statusCode).toBe(201);
    if (name === "mrmaf-subject") agentId = a.json().id;
    else otherAgentId = a.json().id;
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: grantee(), agentId: a.json().id },
    });
  }

  for (const [name, setter] of [
    ["mrmaf-golden", (id: string) => (datasetId = id)],
    ["mrmaf-golden-other", (id: string) => (otherDatasetId = id)],
  ] as const) {
    const ds = await app.inject({
      method: "POST",
      url: "/v1/evals/datasets",
      headers: AUTH,
      payload: { name, scorerKind: "contains", scorerConfig: { needles: ["ok"] } },
    });
    expect(ds.statusCode).toBe(201);
    setter(ds.json().id as string);
    const c = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.json().id}/cases`,
      headers: AUTH,
      payload: { input: "say ok", expected: "ok" },
    });
    expect(c.statusCode).toBe(201);
  }

  const card = await app.inject({
    method: "POST",
    url: "/v1/mrm/cards",
    headers: AUTH,
    payload: {
      agentId,
      intendedUse: "mrmaf: summarize governed tickets",
      limitations: "not for legal advice",
      dataClaims: { training: "vendor-stated" },
    },
  });
  expect(card.statusCode).toBe(201);
  cardId = card.json().card.id;
  myCardIds.push(cardId);
});

afterAll(async () => {
  // M-012: the one singleton-ish row this file may leave behind — the agent
  // guardrail override — is removed even if the test that owns it failed
  // midway; deleting scoped rows for agents this file created harms no other
  // suite (they name their own agents).
  await db
    .delete(guardrailConfigs)
    .where(and(eq(guardrailConfigs.scope, "agent"), inArray(guardrailConfigs.scopeId, [agentId, otherAgentId])));
  if (myRedteamRunIds.length) {
    await db.delete(redteamRuns).where(inArray(redteamRuns.id, myRedteamRunIds));
  }
  if (myCardIds.length) {
    await db.delete(modelCardEvidence).where(inArray(modelCardEvidence.cardId, myCardIds));
    await db.delete(modelCardApprovals).where(inArray(modelCardApprovals.cardId, myCardIds));
    await db.delete(modelCards).where(inArray(modelCards.id, myCardIds));
  }
});

// ---------------------------------------------------------------------------

describe("read-time autofill — the card is a window, not a form", () => {
  it("the detail read carries the computed block, labelled, and scoped to the card's subject", async () => {
    const before = await detail();
    expect(before.autofill.note).toBe(MRM_AUTOFILL_NOTE);
    expect(before.autofill.note).toContain("computed from ledgers at read time");
    expect(before.autofill.scope.agentId).toBe(agentId);
    const evalsBefore = before.autofill.sections.evals.runsEver;

    // THE POINT OF L12: a ledger write appears on the card with NO card edit
    await runEval(agentId, maraAuth);
    const after = await detail();
    expect(after.autofill.sections.evals.runsEver).toBe(evalsBefore + 1);
    expect(after.autofill.sections.evals.latestRun).not.toBeNull();
    // ...and the metered dispatch behind that run is visible in the usage
    // section from the same ledgers
    expect(after.autofill.sections.usage.dispatchesInWindow).toBeGreaterThanOrEqual(1);

    // CONTROL: the same write against a DIFFERENT agent moves nothing here
    await runEval(otherAgentId, rikaAuth, otherDatasetId);
    const control = await detail();
    expect(control.autofill.sections.evals.runsEver).toBe(evalsBefore + 1);
  });

  it("groundedness counts only ADR-0067 scorer kinds — the imported constant, not a restated list", async () => {
    const before = await detail();
    expect(before.autofill.sections.evals.groundedness.runsInWindow).toBe(0);
    expect(before.autofill.sections.evals.groundedness.note).toContain("unmeasured");

    const kind = GROUNDEDNESS_SCORER_KINDS[0];
    const ds = await app.inject({
      method: "POST",
      url: "/v1/evals/datasets",
      headers: AUTH,
      payload: { name: "mrmaf-grounded", scorerKind: kind, scorerConfig: {} },
    });
    expect(ds.statusCode).toBe(201);
    const c = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.json().id}/cases`,
      headers: AUTH,
      payload: { input: "what colour is the sky", context: ["the sky is blue"] },
    });
    expect(c.statusCode).toBe(201);
    await runEval(agentId, maraAuth, ds.json().id as string);

    const after = await detail();
    expect(after.autofill.sections.evals.groundedness.runsInWindow).toBe(1);
    expect(after.autofill.sections.evals.groundedness.latestRun?.scorerKind).toBe(kind);
  });

  it("red-team: unmeasured says 'unmeasured, not resisted'; a run surfaces ASR verbatim with interval, denominator and quality label", async () => {
    const before = await detail();
    expect(before.autofill.sections.redteam.measured).toBe(false);
    expect(before.autofill.sections.redteam.note).toBe(MRM_AUTOFILL_UNMEASURED_REDTEAM);

    // a REAL red-team row with the full FK chain (the risks.test.ts idiom)
    const [ds] = await db
      .insert(evalDatasets)
      .values({ name: "mrmaf-rt-ds", version: 1, scorerKind: "contains" })
      .returning();
    const [er] = await db
      .insert(evalRuns)
      .values({ datasetId: ds!.id, datasetVersion: 1, agentName: "mrmaf-subject", trigger: "manual", status: "completed" })
      .returning();
    const [lib] = await db.insert(redteamLibraries).values({ name: "mrmaf-lib", version: 1 }).returning();
    const [rt] = await db
      .insert(redteamRuns)
      .values({
        libraryId: lib!.id,
        libraryName: "mrmaf-lib",
        libraryVersion: 1,
        evalRunId: er!.id,
        agentId,
        agentName: "mrmaf-subject",
        probes: 10,
        resisted: 7,
        defeated: 3,
        trials: 4,
        asr: 0.25,
        asrLower: 0.12,
        asrUpper: 0.45,
        asrTrials: 40,
        measurementQuality: "measured",
        platformHeld: 2,
      })
      .returning();
    myRedteamRunIds.push(rt!.id);

    const after = await detail();
    expect(after.autofill.sections.redteam.measured).toBe(true);
    expect(after.autofill.sections.redteam.runsEver).toBe(before.autofill.sections.redteam.runsEver + 1);
    expect(after.autofill.sections.redteam.latestRun).toMatchObject({
      asr: 0.25,
      asrLower: 0.12,
      asrUpper: 0.45,
      asrTrials: 40,
      measurementQuality: "measured",
    });
  });

  it("computed and manual never blend, and the read writes NOTHING", async () => {
    const run = await runEval(agentId, maraAuth);
    const attach = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/evidence`,
      headers: AUTH,
      payload: { kind: "eval_run", evalRunId: run.id, label: "manually attached" },
    });
    expect(attach.statusCode).toBe(201);

    const view = await detail();
    // the manual attachment lives in `evidence`; the autofill block has no
    // `evidence` key and the attachment changed none of its figures' HOME —
    // the run was already counted there as a ledger row, not as an attachment
    expect(view.evidence.some((e) => e.evalRunId === run.id)).toBe(true);
    expect("evidence" in view.autofill.sections).toBe(false);

    // reading twice writes nothing: no audit row, no card-row touch
    const auditBefore = await db.select({ id: auditLog.id }).from(auditLog);
    const again = await detail();
    const auditAfter = await db.select({ id: auditLog.id }).from(auditLog);
    expect(auditAfter.length).toBe(auditBefore.length);
    expect(again.updatedAt).toBe(view.updatedAt);
    const [row] = await db.select().from(modelCards).where(eq(modelCards.id, cardId));
    expect(row!.updatedAt.toISOString()).toBe(new Date(view.updatedAt).toISOString());
  });

  it("no autofill section is, or contains, a fairness number — the L9/ADR-0045 line holds", async () => {
    const view = await detail();
    expect(Object.keys(view.autofill.sections).some((k) => /bias|fairness/i.test(k))).toBe(false);
    for (const section of Object.values(view.autofill.sections)) {
      expect(Object.keys(section as Record<string, unknown>).some((k) => /bias|fairness/i.test(k))).toBe(false);
    }
    // and the block's own label states the refusal rather than leaving it implicit
    expect(view.autofill.note).toContain("no fairness number is synthesized");
  });
});

// ---------------------------------------------------------------------------

describe("snapshot-on-sign-off — the record shows what the decider saw", () => {
  let approvalId: string;

  it("before any certification, staleness says undefined — not a reassuring zero", async () => {
    const view = await detail();
    expect(view.staleness.certified).toBe(false);
    expect(view.staleness.changesSinceCertification).toBeNull();
    expect(view.staleness.drifted).toBe(false);
    expect(view.staleness.note).toContain("never certified");
  });

  it("the decide path freezes the on-screen autofill into the decision's audit detail", async () => {
    const liveBefore = await detail();
    const res = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/sign-off`,
      headers: AUTH,
      payload: {
        approverUserId: rikaId,
        validUntil: new Date(Date.now() + 180 * 86_400_000).toISOString(),
        reason: "mrmaf initial review",
      },
    });
    expect(res.statusCode).toBe(201);
    approvalId = res.json().approvalId;

    const decided = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/decide`,
      headers: rikaAuth,
      payload: { decision: "approved", reason: "reviewed against the computed window" },
    });
    expect(decided.statusCode).toBe(200);

    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mrm-sign-off-approved"), eq(auditLog.objectId, cardId)));
    expect(auditRow).toBeDefined();
    const snap = (auditRow!.detail as { autofillSnapshot?: Record<string, any> }).autofillSnapshot;
    expect(snap).toBeDefined();
    expect(snap!.evals.runsEver).toBe(liveBefore.autofill.sections.evals.runsEver);
    expect(snap!.redteam.latestAsr).toBe(0.25);
    expect(snap!.redteam.asrTrials).toBe(40);
    expect(snap!.grants.effectiveHolders).toBe(liveBefore.autofill.sections.grants.effectiveHolders);
    expect(snap!.note).toContain("frozen at the moment of decision");
  });

  it("the snapshot HOLDS while the live autofill moves on", async () => {
    const frozenEvals = async () => {
      const [row] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "mrm-sign-off-approved"), eq(auditLog.objectId, cardId)));
      return (row!.detail as { autofillSnapshot: { evals: { runsEver: number } } }).autofillSnapshot.evals.runsEver;
    };
    const before = await frozenEvals();
    await runEval(agentId, maraAuth);
    const live = await detail();
    expect(live.autofill.sections.evals.runsEver).toBe(before + 1);
    expect(await frozenEvals()).toBe(before); // the record did not re-derive
  });
});

// ---------------------------------------------------------------------------

describe("staleness — a certified card whose world moved says so", () => {
  it("names exactly what changed since the certification, and gates nothing", async () => {
    // one eval run already landed after the sign-off (previous test); add a
    // guardrail change so the summary has two distinctly-sourced movements
    const view = await detail();
    expect(view.staleness.certified).toBe(true);
    expect(view.staleness.lastCertifiedAt).toBeTruthy();
    expect(view.staleness.changesSinceCertification!.evalRuns).toBe(1);
    expect(view.staleness.drifted).toBe(true);
    expect(view.staleness.summary).toContain("1 eval run");
    expect(view.staleness.summary).toContain("since certification");

    const put = await app.inject({
      method: "PUT",
      url: `/v1/guardrails/config/agent/${agentId}`,
      headers: AUTH,
      payload: { modes: { prompt_injection: "block" } },
    });
    expect(put.statusCode).toBe(200);

    const after = await detail();
    expect(after.staleness.changesSinceCertification!.guardrailChanges).toBe(1);
    expect(after.staleness.summary).toContain("1 guardrail change");
    // ...and the override is simultaneously visible in the autofill block
    expect(
      after.autofill.sections.guardrails.agentOverrides.some(
        (o) => o.agentId === agentId && o.modes.promptInjection === "block",
      ),
    ).toBe(true);
    // staleness INFORMS; the sign-off chain itself is untouched by drift
    const [record] = await db.select().from(modelCardApprovals).where(eq(modelCardApprovals.cardId, cardId));
    expect(record!.status).toBe("approved");

    // M-012: restore the singleton-ish override in the test that made it
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/guardrails/config/agent/${agentId}`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(200);
  });

  it("a fresh certification resets the clock", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/sign-off`,
      headers: AUTH,
      payload: {
        approverUserId: rikaId,
        validUntil: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        reason: "mrmaf recertification",
      },
    });
    expect(res.statusCode).toBe(201);
    const decided = await app.inject({
      method: "POST",
      url: `/v1/approvals/${res.json().approvalId}/decide`,
      headers: rikaAuth,
      // the bootstrap-token request records the approver as the subject, so
      // this decision is a self-review and must carry a reason (ADR-0046)
      payload: { decision: "approved", reason: "mrmaf recertification review" },
    });
    expect(decided.statusCode).toBe(200);

    const view = await detail();
    expect(view.staleness.certified).toBe(true);
    expect(view.staleness.drifted).toBe(false);
    expect(view.staleness.summary).toBeNull();
    expect(view.staleness.changesSinceCertification!.evalRuns).toBe(0);
    expect(view.staleness.changesSinceCertification!.guardrailChanges).toBe(0);
  });
});
