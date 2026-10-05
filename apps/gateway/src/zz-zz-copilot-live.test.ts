/**
 * L6 — THE GOVERNANCE COPILOT GOES LIVE, plus L24's model-judged half.
 * (ADR-0056 amendment 2026-08-22, ADR-0092 amendment 2026-08-22.)
 *
 * ADR-0056's amendment named two structural gaps in plain words:
 *   "No model provider is connected in this build, so the copilot's GENERATION
 *    quality is unverified" and
 *   "An approved proposal is not applied by anything… the worked example loop
 *    stops at 'approved', not at 'revoked'."
 * ADR-0092 named a third: "the model-judged half remains L6-blocked and
 * unapproximated".
 *
 * WHAT THIS FILE MAKES IMPOSSIBLE TO FAKE
 * ---------------------------------------
 *  1. AN ANSWER WITH NOTHING UNDER IT. The grounding unit is a RETRIEVED
 *     OBJECT ID. A question whose retrieval returns nothing gets a REFUSAL in
 *     a named shape — and a narrator that answers it anyway is DISCARDED, with
 *     the refusal standing. The control is the same code path over a
 *     retrieval that DID return rows: it must cite their real ids and must NOT
 *     refuse, so the refusal is a refusal and not a broken endpoint.
 *  2. A MODEL THAT INVENTS A RECORD. A narration citing an object id the
 *     retrieval never returned is discarded exactly like an invented figure,
 *     and the discard is audited.
 *  3. AN APPLIER THAT DOES NOT NEED CONSENT. Applying a proposal is gated on
 *     the LINKED APPROVAL in the one existing queue: pending, denied, missing
 *     and already-applied each refuse by their OWN name, audited, with the
 *     target asserted UNCHANGED. Only the approved one applies — and its
 *     mutation is asserted to have really happened (the grant row is gone; the
 *     rule's enforcing body moved; B8c: the approval rule exists, the project
 *     budget moved) through the same public choke points an admin would use.
 *  4. A JUDGED LAYER THAT QUIETLY BECOMES THE ANSWER. With the org knob OFF
 *     (the default) the report carries no annotation at all. With it ON and a
 *     judge injected, annotations appear — labelled `model-judged` — and the
 *     deterministic finding beside each one is asserted BYTE-IDENTICAL to the
 *     knob-off run. A judge that throws leaves the report unchanged with
 *     `judged: unavailable` rather than an unannotated "all clear".
 *
 * SHARED-STATE DISCIPLINE (M-012). This file flips `org_settings`
 * (`recommendationJudgeEnabled` / `recommendationJudgeAgentId`). Every test
 * that flips it restores it, and `afterAll` restores the exact prior values
 * unconditionally. Assertions are DELTAS or filtered to this file's own ids
 * (M-008) — never absolute org-wide counts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
  approvalRules,
  approvals,
  auditLog,
  copilotProposals,
  createDb,
  desc,
  eq,
  orgSettings,
  projects,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import {
  COPILOT_GROUNDED_REFUSAL,
  RECOMMENDATION_JUDGE_METHOD,
  type CopilotNarration,
  type CopilotNarrator,
  type RecommendationJudge,
  type RecommendationJudgeReply,
  type RecommendationJudgeRequest,
} from "@regulait/shared";
import { COPILOT_RULE_IDS } from "./copilot.js";
import { buildApp } from "./app.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "l6-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const dayMs = 24 * 60 * 60 * 1000;

let db: Db;
/** the default app: real narrator path, no injected judge */
let app: ReturnType<typeof buildApp>;

type Auth = { authorization: string };
let adminId: string;
let adminAuth: Auth;
let approverId: string;
let approverAuth: Auth;
let holderId: string;
let agentA: string;
let serverId: string;
/** the grant a `grant_revocation` proposal will really remove */
let doomedGrantId: string;
/** grants the refused applies must leave alone */
let survivorPending: string;
let survivorDenied: string;
let survivorNoApproval: string;
/** the rule a `policy_tightening` proposal will really edit */
let tightenRuleId: string;

let priorJudgeEnabled: boolean;
let priorJudgeAgentId: string | null;

const post = (url: string, payload: unknown, headers: Auth = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers: Auth = AUTH) => app.inject({ method: "GET", url, headers });

async function makeUser(email: string, opts: { admin?: boolean } = {}) {
  const u = await post("/v1/users", { email, displayName: email.split("@")[0] });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  if (opts.admin) {
    const a = await post(`/v1/users/${id}/admin`, { isAdmin: true, reason: "l6 coverage" });
    expect(a.statusCode).toBe(200);
  }
  const k = await post(`/v1/users/${id}/keys`, { name: "l6-key" });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } satisfies Auth };
}

async function grantAgent(userId: string, agentId: string): Promise<string> {
  const r = await post("/v1/grants/agents", { userId, agentId });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/**
 * Ask a question, then open a proposal on its query. Returns both ids plus the
 * approval id — the REAL queue row, opened by the REAL proposal endpoint.
 */
async function proposeThrough(
  kind: string,
  title: string,
  diff: Record<string, unknown>,
): Promise<{ proposalId: string; approvalId: string }> {
  const ask = await post("/v1/copilot/ask", { question: "which denied decisions happened this week?" }, adminAuth);
  expect(ask.statusCode).toBe(201);
  const queryId = ask.json().query.id as string;
  const p = await post(
    "/v1/copilot/proposals",
    { queryId, kind, title, rationale: "l6 coverage", diff, approverUserId: approverId },
    adminAuth,
  );
  expect(p.statusCode, p.body).toBe(201);
  return { proposalId: p.json().proposal.id as string, approvalId: p.json().approvalId as string };
}

/**
 * B9a — the same call, expecting the PROPOSE-TIME DIFF GATE to refuse.
 *
 * The four assertions that used to live at apply time moved here, and the move
 * is the point: a diff that cannot be applied is now refused before any human
 * is asked to consent to it, so there is never a real approval on the record
 * against a change that could not happen. Each of these also asserts that NO
 * APPROVAL ROW WAS OPENED, which is the half a status-code check would miss.
 */
async function proposeExpectingRefusal(
  kind: string,
  title: string,
  diff: Record<string, unknown>,
): Promise<{ statusCode: number; error: string; detail: string }> {
  const ask = await post("/v1/copilot/ask", { question: "which denied decisions happened this week?" }, adminAuth);
  expect(ask.statusCode).toBe(201);
  const approvalsBefore = (await db.select({ id: approvals.id }).from(approvals)).length;
  const p = await post(
    "/v1/copilot/proposals",
    { queryId: ask.json().query.id, kind, title, rationale: "l6 coverage", diff, approverUserId: approverId },
    adminAuth,
  );
  const approvalsAfter = (await db.select({ id: approvals.id }).from(approvals)).length;
  expect(approvalsAfter, "a refused proposal must not open an Approvals-Queue item").toBe(approvalsBefore);
  const rows = await db.select({ id: copilotProposals.id }).from(copilotProposals).where(eq(copilotProposals.title, title));
  expect(rows.length, "a refused proposal must not be recorded").toBe(0);
  return { statusCode: p.statusCode, error: p.json().error as string, detail: (p.json().detail ?? "") as string };
}

/**
 * B9a — A ROW THE PROPOSE GATE NEVER SAW, approved and ready to apply.
 *
 * The applier still validates the diff, and this is the only path that can now
 * reach that check: a proposal recorded before the propose-time gate existed,
 * or one whose nested payload schema tightened afterwards. Inserted directly
 * for exactly that reason — going through the endpoint would be refused, which
 * is the behaviour the tests above assert.
 */
async function legacyApprovedProposal(kind: string, title: string, diff: Record<string, unknown>): Promise<string> {
  const ask = await post("/v1/copilot/ask", { question: "which denied decisions happened this week?" }, adminAuth);
  const [approval] = await db
    .insert(approvals)
    .values({ userId: adminId, objectType: "copilot_proposal", approverUserId: approverId, status: "approved" })
    .returning();
  const [row] = await db
    .insert(copilotProposals)
    .values({
      queryId: ask.json().query.id as string,
      kind,
      title,
      rationale: "a row from before the propose-time diff gate existed",
      diff,
      evidence: {},
      approvalId: approval!.id,
      proposedByUserId: adminId,
    })
    .returning();
  return row!.id;
}

const decide = async (approvalId: string, decision: "approved" | "denied") => {
  const r = await post(
    `/v1/approvals/${approvalId}/decide`,
    { decision, reason: "l6 coverage" },
    approverAuth,
  );
  expect(r.statusCode).toBe(200);
};

const applyProposal = (proposalId: string, headers: Auth = adminAuth) =>
  post(`/v1/copilot/proposals/${proposalId}/apply`, {}, headers);

const grantExists = async (grantId: string) =>
  (await db.select({ id: agentGrants.id }).from(agentGrants).where(eq(agentGrants.id, grantId))).length > 0;

const latestAuditFor = async (ruleId: string) => {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row;
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });

  const [before] = await db.select().from(orgSettings);
  priorJudgeEnabled = before?.recommendationJudgeEnabled ?? false;
  priorJudgeAgentId = before?.recommendationJudgeAgentId ?? null;

  const admin = await makeUser("l6-admin@example.com", { admin: true });
  adminId = admin.id;
  adminAuth = admin.auth;
  const approver = await makeUser("l6-approver@example.com", { admin: true });
  approverId = approver.id;
  approverAuth = approver.auth;
  holderId = (await makeUser("l6-holder@example.com")).id;

  const a = await post("/v1/agents", {
    name: "l6-agent",
    provider: "mock",
    tier: 1,
    model: "mock-balanced",
    costPerMTokIn: 1,
    costPerMTokOut: 2,
  });
  expect(a.statusCode).toBe(201);
  agentA = a.json().id as string;

  doomedGrantId = await grantAgent(holderId, agentA);
  survivorPending = await grantAgent(adminId, agentA);
  survivorDenied = await grantAgent(approverId, agentA);
  const spare = await makeUser("l6-spare@example.com");
  survivorNoApproval = await grantAgent(spare.id, agentA);

  const s = await post("/v1/servers", { name: "l6-server", url: "http://127.0.0.1:9" });
  expect(s.statusCode).toBe(201);
  serverId = s.json().id as string;

  // the restriction rule a policy_tightening proposal will edit, through the
  // ordinary CREATE endpoint — the applier must not need a private setup path
  const rule = await post("/v1/rules/approvals", {
    userId: holderId,
    serverId,
    toolName: "l6_write",
    writeOnly: false,
    approverUserId: approverId,
  });
  expect(rule.statusCode).toBe(201);
  tightenRuleId = rule.json().id as string;

  // audit rows the copilot's retrieval can find, attributed to no project so
  // the admin (org-wide) scope sees them
  await db.insert(auditLog).values([
    {
      userId: adminId,
      objectType: "mcp_tool",
      objectId: null,
      detail: { projectId: null },
      effect: "deny",
      ruleId: "l6-seeded-deny",
      ruleChain: [],
      reason: "l6: seeded denial for the copilot to retrieve",
    },
    {
      userId: adminId,
      objectType: "mcp_tool",
      objectId: null,
      detail: { projectId: null },
      effect: "allow",
      ruleId: "l6-seeded-allow",
      ruleChain: [],
      reason: "l6: seeded allow for the copilot to retrieve",
    },
  ]);
  // one metered call, so summarizeUsage has a citable usage_event too
  await db.insert(usageEvents).values({
    userId: adminId,
    objectType: "agent",
    agentId: agentA,
    at: new Date(Date.now() - 1 * dayMs),
    provider: "mock",
    model: "mock-balanced",
  });
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  // M-012: this file flips an org singleton; restore the EXACT prior values
  await db
    .update(orgSettings)
    .set({
      recommendationJudgeEnabled: priorJudgeEnabled,
      recommendationJudgeAgentId: priorJudgeAgentId,
    });
  await app?.close();
});

// ---------------------------------------------------------------------------
// L6a — grounding is by RETRIEVED OBJECT ID, and an empty retrieval REFUSES
// ---------------------------------------------------------------------------

describe("L6a — the copilot answers from retrieved governance objects, or refuses", () => {
  it("cites the REAL ids of the rows its own scoped retrieval returned", async () => {
    const res = await post("/v1/copilot/ask", { question: "who accessed tool calls recently?" }, adminAuth);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // THE CONTROL for the refusal test below: a retrieval that found rows must
    // NOT refuse, and must name concrete ids.
    expect(body.answer.groundedRefusal).toBe(false);
    expect(body.evidence.citableObjects.length).toBeGreaterThan(0);
    for (const o of body.evidence.citableObjects) {
      expect(o.kind).toBe("audit_log");
      expect(o.id).toMatch(/^[0-9a-f]{8}-/);
      // the label is gateway-written fact (effect · ruleId), never the
      // attacker-influenceable `reason` string.
      //
      // These are the THREE values `audit_log.effect` can hold (schema.ts) and
      // nothing else: copilot.ts builds this label as `${effect} · ${ruleId}`
      // straight off the row. The list previously read
      // `approval_required|error` — a transposition of `require_approval`, plus
      // a value the enum does not have — so a cited require_approval row could
      // never satisfy it, and the assertion passed only while this file's
      // scoped retrieval happened to sample none. It began failing once a
      // batch that writes many require_approval rows landed earlier in the
      // shared database, which is luck expiring, not a regression.
      expect(o.label).toMatch(/^(allow|deny|require_approval)\s·\s/);
      expect(body.answer.text).toContain(o.id);
    }
    // and every cited id is a row that really exists, with the label it claims
    const [first] = body.evidence.citableObjects as Array<{ id: string; label: string }>;
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, first!.id));
    expect(row).toBeTruthy();
    expect(first!.label).toBe(`${row!.effect} · ${row!.ruleId}`);
  });

  it("REFUSES, in a named shape, a question whose retrieval returns nothing", async () => {
    // a scope with no rows at all: a brand-new non-admin user is a member of no
    // project, so the fail-closed scope selects NOTHING (not everything)
    const stranger = await makeUser("l6-stranger@example.com");
    // ADR-0096 NOTE. This question is deliberately all-lowercase so it names no
    // extractable subject and reaches the EMPTY-RETRIEVAL gate, which is what
    // this test is about. The question it replaced ("what does the
    // Sarbanes-Oxley Act require of a nonexistent widget?") now refuses one
    // gate EARLIER, as an unresolved subject — also correct, also a refusal,
    // and pinned below so the interaction between the two gates is a recorded
    // fact rather than something a future reader has to rediscover.
    const res = await post(
      "/v1/copilot/ask",
      { question: "which denied decisions happened this week?" },
      stranger.auth,
    );
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.evidence.citableObjects).toEqual([]);
    expect(body.evidence.rowsExamined).toBe(0);
    expect(body.answer.groundedRefusal).toBe(true);
    expect(body.answer.text).toContain(COPILOT_GROUNDED_REFUSAL);
    expect(body.answer.citedObjectIds).toEqual([]);
    // the refusal is a refusal, not a claim about the world
    expect(body.answer.text).toMatch(/never 'no such thing exists'/);

    // ADR-0096 — THE TWO GATES, PINNED SIDE BY SIDE. The same stranger asking
    // the ORIGINAL phrasing refuses at the SUBJECT gate instead, before any
    // retrieval runs, with its own status and its own reason. Both are
    // refusals; a caller can tell them apart, which is the whole point of
    // giving the subject failure a name of its own.
    const named = await post(
      "/v1/copilot/ask",
      { question: "what does the Sarbanes-Oxley Act require of a nonexistent widget?" },
      stranger.auth,
    );
    expect(named.statusCode).toBe(422);
    expect(named.json().error).toBe("copilot_entity_unresolved");
    expect(named.json().detail).toMatch(/^UNRESOLVED SUBJECT/);
    expect(named.json().detail).not.toContain("NOTHING RETRIEVED");
  });

  it("DISCARDS a narration that answered over an empty retrieval, and audits it", async () => {
    const freeAssociator: CopilotNarrator = {
      id: "test:free-associator",
      narrate: async (): Promise<CopilotNarration> => ({
        text: "Sarbanes-Oxley requires internal controls over financial reporting.",
        citedKeys: [],
        citedObjectIds: [],
        refused: false, // answered anyway — the failure this exists to catch
      }),
    };
    const seam = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64), copilotNarrator: freeAssociator });
    try {
      const stranger = await makeUser("l6-stranger-2@example.com");
      await seam.inject({
        method: "POST",
        url: "/v1/grants/agents",
        headers: AUTH,
        payload: { userId: stranger.id, agentId: agentA },
      });
      const res = await seam.inject({
        method: "POST",
        url: "/v1/copilot/ask",
        headers: stranger.auth,
        // ADR-0096: all-lowercase and subject-free on purpose, so this reaches
        // the empty retrieval this test is about rather than the subject gate
        payload: { question: "which denied decisions happened this week?", narratorAgentId: agentA },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.narrationDiscarded).toMatch(/answered anyway instead of refusing/);
      expect(body.answer.generation).toBe("grounded");
      expect(body.answer.modelNarrationVerified).toBe(false);
      expect(body.answer.text).not.toContain("Sarbanes-Oxley requires internal controls");
      const discard = await latestAuditFor(COPILOT_RULE_IDS.narrationFailed);
      expect(discard?.effect).toBe("deny");
    } finally {
      await seam.close();
    }
  });

  it("DISCARDS a narration citing an object id the retrieval never returned", async () => {
    const phantom: CopilotNarrator = {
      id: "test:phantom",
      narrate: async (): Promise<CopilotNarration> => ({
        text: "See audit row 11111111-1111-1111-1111-111111111111.",
        citedKeys: [],
        citedObjectIds: ["11111111-1111-1111-1111-111111111111"],
        refused: false,
      }),
    };
    const seam = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64), copilotNarrator: phantom });
    try {
      await seam.inject({
        method: "POST",
        url: "/v1/grants/agents",
        headers: AUTH,
        payload: { userId: adminId, agentId: agentA },
      });
      const res = await seam.inject({
        method: "POST",
        url: "/v1/copilot/ask",
        headers: adminAuth,
        payload: { question: "which denied decisions happened this week?", narratorAgentId: agentA },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().narrationDiscarded).toMatch(/never returned/);
      expect(res.json().answer.modelNarrationVerified).toBe(false);
    } finally {
      await seam.close();
    }
  });

  it("ACCEPTS a grounded narration, marks it verified, and meters the dispatch", async () => {
    let seen: { citable: string[] } = { citable: [] };
    const honest: CopilotNarrator = {
      id: "test:honest",
      narrate: async (req): Promise<CopilotNarration> => {
        seen = { citable: req.evidence.citableObjects.map((o) => o.id) };
        return {
          text: "Denials in your scope, summarised.",
          citedKeys: req.evidence.counts.slice(0, 1).map((c) => c.key),
          citedObjectIds: req.evidence.citableObjects.slice(0, 1).map((o) => o.id),
          refused: false,
        };
      },
    };
    const seam = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64), copilotNarrator: honest });
    try {
      const res = await seam.inject({
        method: "POST",
        url: "/v1/copilot/ask",
        headers: adminAuth,
        payload: { question: "which denied decisions happened this week?", narratorAgentId: agentA },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.narrationDiscarded).toBeUndefined();
      expect(body.answer.generation).toBe("model");
      // HONEST, PER-ANSWER: true means THIS narration passed the cross-check
      expect(body.answer.modelNarrationVerified).toBe(true);
      expect(body.note).toMatch(/CROSS-CHECKED against this retrieval/);
      expect(body.answer.text).toContain("Denials in your scope, summarised.");
      // the narrator really was handed the citable ids
      expect(seen.citable.length).toBeGreaterThan(0);
    } finally {
      await seam.close();
    }
  });
});

// ---------------------------------------------------------------------------
// L6b — the consent-gated applier
// ---------------------------------------------------------------------------

describe("L6b — an approved proposal can be APPLIED, and an unapproved one cannot", () => {
  it("refuses a PENDING proposal by name, audits it, and leaves the grant in place", async () => {
    const { proposalId } = await proposeThrough("grant_revocation", "l6 pending", {
      grantKind: "agent",
      grantId: survivorPending,
    });
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("proposal_not_approved");
    expect(res.json().detail).toMatch(/is 'pending', not 'approved'/);
    expect(await grantExists(survivorPending)).toBe(true);
    const denyRow = await latestAuditFor(COPILOT_RULE_IDS.proposalApplyRefused);
    expect(denyRow?.effect).toBe("deny");
    expect((denyRow?.detail as Record<string, unknown>).error).toBe("proposal_not_approved");
  });

  it("refuses a DENIED proposal by name and leaves the grant in place", async () => {
    const { proposalId, approvalId } = await proposeThrough("grant_revocation", "l6 denied", {
      grantKind: "agent",
      grantId: survivorDenied,
    });
    await decide(approvalId, "denied");
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("proposal_not_approved");
    expect(res.json().detail).toMatch(/is 'denied'/);
    expect(await grantExists(survivorDenied)).toBe(true);
  });

  it("refuses a proposal whose approval row is GONE, and leaves the grant in place", async () => {
    const { proposalId, approvalId } = await proposeThrough("grant_revocation", "l6 no approval", {
      grantKind: "agent",
      grantId: survivorNoApproval,
    });
    // the FK is ON DELETE SET NULL: removing the queue item leaves a proposal
    // with no recorded consent, which must refuse rather than default to yes
    await db.delete(approvals).where(eq(approvals.id, approvalId));
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("proposal_has_no_approval");
    expect(await grantExists(survivorNoApproval)).toBe(true);
  });

  it("APPLIES an approved grant_revocation through the one removal path, and audits it", async () => {
    expect(await grantExists(doomedGrantId)).toBe(true);
    const { proposalId, approvalId } = await proposeThrough("grant_revocation", "l6 revoke the unused grant", {
      grantKind: "agent",
      grantId: doomedGrantId,
    });
    await decide(approvalId, "approved");

    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toMatchObject({ via: "grant-revocation", grantKind: "agent", removed: true });
    // THE MUTATION REALLY HAPPENED
    expect(await grantExists(doomedGrantId)).toBe(false);

    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).not.toBeNull();
    expect(row!.appliedByUserId).toBe(adminId);

    // audited under the APPLYING HUMAN's identity, with the proposal as context
    const applied = await latestAuditFor(COPILOT_RULE_IDS.proposalApplied);
    expect(applied?.userId).toBe(adminId);
    expect(applied?.effect).toBe("allow");
    const detail = applied?.detail as Record<string, unknown>;
    expect(detail.copilotProposalId).toBe(proposalId);
    expect(detail.approvalId).toBe(approvalId);
    expect(detail.diff).toMatchObject({ grantKind: "agent", grantId: doomedGrantId });
    expect(applied?.reason).toMatch(/attributed to the applying admin, not to the copilot/);
  });

  it("refuses a SECOND apply of the same proposal rather than re-executing it", async () => {
    // self-contained (order-independent): its own grant, its own approval
    const twice = await makeUser("l6-twice@example.com");
    const grantId = await grantAgent(twice.id, agentA);
    const { proposalId, approvalId } = await proposeThrough("grant_revocation", "l6 idempotency", {
      grantKind: "agent",
      grantId,
    });
    await decide(approvalId, "approved");
    expect((await applyProposal(proposalId)).statusCode).toBe(200);
    expect(await grantExists(grantId)).toBe(false);

    // re-grant the SAME user the same access, so a re-executed apply would be
    // visible as a second removal rather than as a no-op on an absent row
    const reGranted = await grantAgent(twice.id, agentA);
    const second = await applyProposal(proposalId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("proposal_already_applied");
    expect(await grantExists(reGranted)).toBe(true);
  });

  it("APPLIES an approved policy_tightening through applyRuleEdit — never a raw table write", async () => {
    const [before] = await db.select().from(approvalRules).where(eq(approvalRules.id, tightenRuleId));
    expect(before!.writeOnly).toBe(false);

    const { proposalId, approvalId } = await proposeThrough("policy_tightening", "l6 make the rule write-only", {
      ruleKind: "approvals",
      ruleId: tightenRuleId,
      patch: { writeOnly: true },
    });
    await decide(approvalId, "approved");
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toMatchObject({ via: "applyRuleEdit", ruleKind: "approvals", ruleId: tightenRuleId });

    // THE MUTATION REALLY HAPPENED, through the choke point
    const [after] = await db.select().from(approvalRules).where(eq(approvalRules.id, tightenRuleId));
    expect(after!.writeOnly).toBe(true);

    // and the choke point wrote ITS own audit row too — the edit is visible as
    // a rule edit, not only as a copilot event
    const chokeRow = await latestAuditFor("copilot-proposal-rule-edit");
    expect(chokeRow).toBeTruthy();
    expect((chokeRow!.detail as Record<string, unknown>).copilotProposalId).toBe(proposalId);
  });

  it("surfaces a malformed diff as a named refusal — at PROPOSE time, before consent is asked", async () => {
    // B9a moved this refusal earlier. It used to be asserted at apply time,
    // which meant the product had already opened a queue item and a named human
    // had already approved a diff that could never be read.
    const res = await proposeExpectingRefusal("policy_tightening", "l6 malformed", {
      ruleKind: "approvals",
      // no ruleId, no patch
    });
    expect(res.statusCode).toBe(422);
    expect(res.error).toBe("proposal_diff_invalid");
    expect(res.detail).toMatch(/ruleKind, ruleId, patch/);
  });

  it("STILL refuses at apply time for a row the propose gate never saw — defence in depth", async () => {
    // the only path that can now reach the applier's own diff check: a row
    // recorded before that gate existed. It must not half-apply.
    const proposalId = await legacyApprovedProposal("policy_tightening", "l6 legacy malformed", {
      ruleKind: "approvals",
    });
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("proposal_diff_invalid");
    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B8c (ADR-0056 amendment 2026-08-22) — the two kinds L6b left honestly
// unapplied now apply, through the SAME public routes an admin uses by hand:
//   rule_to_approval  → the create POST /v1/rules/approvals performs
//                       (`createApprovalRuleRow`), behind the route's OWN
//                       createApprovalRuleSchema;
//   budget_adjustment → the merged write PATCH /v1/projects/:projectId performs
//                       (`applyProjectPatch`), behind the route's OWN
//                       updateProjectSchema and budget-requires-approver
//                       invariant.
// Every assertion is a DELTA or filtered to this block's own ids (M-008).
// ---------------------------------------------------------------------------

describe("B8c — rule_to_approval applies through POST /v1/rules/approvals' own create", () => {
  /** a fresh source rate-limit rule per test — the deny-heavy artifact an
   * approval requirement is derived from */
  const makeSourceRateLimit = async (toolName: string): Promise<string> => {
    const r = await post("/v1/rules/rate-limits", {
      userId: holderId,
      serverId,
      toolName,
      maxCalls: 1,
      windowSeconds: 60,
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  /** the create payload the diff carries — exactly what an admin would POST */
  const createPayload = (toolName: string) => ({
    userId: holderId,
    serverId,
    toolName,
    writeOnly: false,
    approverUserId: approverId,
  });

  const approvalRuleCountFor = async (toolName: string) =>
    (await db.select({ id: approvalRules.id }).from(approvalRules).where(eq(approvalRules.toolName, toolName)))
      .length;

  it("refuses a PENDING proposal by name and creates NOTHING", async () => {
    const sourceId = await makeSourceRateLimit("b8c_pending_src");
    const { proposalId } = await proposeThrough("rule_to_approval", "b8c pending", {
      sourceRuleKind: "rate-limits",
      sourceRuleId: sourceId,
      create: createPayload("b8c_pending_tool"),
    });
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("proposal_not_approved");
    expect(await approvalRuleCountFor("b8c_pending_tool")).toBe(0);
    const denyRow = await latestAuditFor(COPILOT_RULE_IDS.proposalApplyRefused);
    expect(denyRow?.effect).toBe("deny");
  });

  it("APPLIES an approved rule_to_approval: the approval rule EXISTS, via the route's create, audited", async () => {
    const sourceId = await makeSourceRateLimit("b8c_apply_src");
    const { proposalId, approvalId } = await proposeThrough("rule_to_approval", "b8c convert the noisy rule", {
      sourceRuleKind: "rate-limits",
      sourceRuleId: sourceId,
      create: createPayload("b8c_apply_tool"),
    });
    await decide(approvalId, "approved");

    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toMatchObject({
      via: "POST /v1/rules/approvals (createApprovalRuleRow)",
      derivedFromRuleKind: "rate-limits",
      derivedFromRuleId: sourceId,
    });

    // THE EFFECT IS VISIBLE IN THE TARGET OBJECT: the approval rule exists,
    // with exactly the fields the route would have written
    const [rule] = await db
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.toolName, "b8c_apply_tool"));
    expect(rule).toBeTruthy();
    expect(rule!.id).toBe(res.json().applied.approvalRuleId);
    expect(rule!.userId).toBe(holderId);
    expect(rule!.serverId).toBe(serverId);
    expect(rule!.approverUserId).toBe(approverId);
    expect(rule!.writeOnly).toBe(false);

    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).not.toBeNull();
    expect(row!.appliedByUserId).toBe(adminId);

    // audited under the APPLYING HUMAN's identity, with the proposal as context
    const applied = await latestAuditFor(COPILOT_RULE_IDS.proposalApplied);
    expect(applied?.userId).toBe(adminId);
    expect(applied?.effect).toBe("allow");
    expect((applied?.detail as Record<string, unknown>).copilotProposalId).toBe(proposalId);
    expect(applied?.reason).toMatch(/same create POST \/v1\/rules\/approvals performs/);
    expect(applied?.reason).toMatch(/attributed to the applying admin, not to the copilot/);
  });

  it("refuses a SECOND apply rather than creating a second rule", async () => {
    const sourceId = await makeSourceRateLimit("b8c_twice_src");
    const { proposalId, approvalId } = await proposeThrough("rule_to_approval", "b8c idempotency", {
      sourceRuleKind: "rate-limits",
      sourceRuleId: sourceId,
      create: createPayload("b8c_twice_tool"),
    });
    await decide(approvalId, "approved");
    expect((await applyProposal(proposalId)).statusCode).toBe(200);
    expect(await approvalRuleCountFor("b8c_twice_tool")).toBe(1);

    const second = await applyProposal(proposalId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("proposal_already_applied");
    // the mutation did NOT re-execute: still exactly one rule
    expect(await approvalRuleCountFor("b8c_twice_tool")).toBe(1);
  });

  it("refuses, by name, a proposal whose SOURCE rule vanished — a conversion of nothing is not applied", async () => {
    const sourceId = await makeSourceRateLimit("b8c_gone_src");
    const { proposalId, approvalId } = await proposeThrough("rule_to_approval", "b8c source gone", {
      sourceRuleKind: "rate-limits",
      sourceRuleId: sourceId,
      create: createPayload("b8c_gone_tool"),
    });
    await decide(approvalId, "approved");
    // the source rule is deleted through the ordinary admin DELETE
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/rules/rate-limits/${sourceId}`,
      headers: adminAuth,
    });
    expect(del.statusCode).toBe(200);

    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("proposal_target_gone");
    expect(res.json().detail).toMatch(/no longer exists/);
    expect(await approvalRuleCountFor("b8c_gone_tool")).toBe(0);
    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).toBeNull();
  });

  it("NEVER bypasses the route's own zod: a create the route would refuse is refused with its error", async () => {
    const sourceId = await makeSourceRateLimit("b8c_zod_src");
    const res = await proposeExpectingRefusal("rule_to_approval", "b8c zod bypass attempt", {
      sourceRuleKind: "rate-limits",
      sourceRuleId: sourceId,
      // scope 'user' with NO userId — exactly what POST /v1/rules/approvals'
      // superRefine refuses; a raw insert would have slipped it to the DB CHECK
      create: {
        scope: "user",
        serverScope: "server",
        serverId,
        toolName: "b8c_zod_tool",
        approverUserId: approverId,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.error).toBe("proposal_diff_invalid");
    // the ROUTE'S schema, by name, and ITS message verbatim
    expect(res.detail).toMatch(/createApprovalRuleSchema/);
    expect(res.detail).toMatch(/scope 'user' requires a userId/);
    expect(await approvalRuleCountFor("b8c_zod_tool")).toBe(0);
  });
});

describe("B8c — budget_adjustment applies through PATCH /v1/projects/:projectId's own write", () => {
  const makeProject = async (
    name: string,
    opts: { budgetUsd?: number; withApprover?: boolean } = {},
  ): Promise<string> => {
    const withApprover = opts.withApprover ?? true;
    const r = await post("/v1/projects", {
      name,
      ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
      ...(withApprover ? { budgetApproverUserId: approverId } : {}),
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  const readProject = async (projectId: string) => {
    const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(row).toBeTruthy();
    return row!;
  };

  it("APPLIES an approved budget_adjustment: the budget MOVED, via the route's write, audited with its rule id", async () => {
    const projectId = await makeProject("b8c-budget-apply", { budgetUsd: 100 });
    const { proposalId, approvalId } = await proposeThrough("budget_adjustment", "b8c raise the budget", {
      projectId,
      patch: { budgetUsd: 250 },
    });
    await decide(approvalId, "approved");

    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toMatchObject({
      via: "PATCH /v1/projects/:projectId (applyProjectPatch)",
      projectId,
      changed: { budgetUsd: 250 },
    });

    // THE EFFECT IS VISIBLE IN THE TARGET OBJECT
    expect((await readProject(projectId)).budgetUsd).toBe(250);

    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).not.toBeNull();
    expect(row!.appliedByUserId).toBe(adminId);

    // the ROUTE'S OWN audit rule id (`project-updated`) recorded the change,
    // stamped with the proposal as context — the same row an admin edit writes
    const routeRow = await latestAuditFor("project-updated");
    expect(routeRow?.objectId).toBe(projectId);
    expect((routeRow?.detail as Record<string, unknown>).copilotProposalId).toBe(proposalId);
    expect((routeRow?.detail as Record<string, unknown>).changed).toMatchObject({ budgetUsd: 250 });

    // and the applier's own row, under the applying human's identity
    const applied = await latestAuditFor(COPILOT_RULE_IDS.proposalApplied);
    expect(applied?.userId).toBe(adminId);
    expect(applied?.reason).toMatch(/same merged write PATCH \/v1\/projects\/:projectId performs/);
  });

  it("refuses a DENIED proposal by name and leaves the budget alone", async () => {
    const projectId = await makeProject("b8c-budget-denied", { budgetUsd: 100 });
    const { proposalId, approvalId } = await proposeThrough("budget_adjustment", "b8c denied", {
      projectId,
      patch: { budgetUsd: 999 },
    });
    await decide(approvalId, "denied");
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("proposal_not_approved");
    expect((await readProject(projectId)).budgetUsd).toBe(100);
  });

  it("refuses a SECOND apply rather than re-executing the write", async () => {
    const projectId = await makeProject("b8c-budget-twice", { budgetUsd: 100 });
    const { proposalId, approvalId } = await proposeThrough("budget_adjustment", "b8c idempotency", {
      projectId,
      patch: { budgetUsd: 150 },
    });
    await decide(approvalId, "approved");
    expect((await applyProposal(proposalId)).statusCode).toBe(200);
    expect((await readProject(projectId)).budgetUsd).toBe(150);

    // an admin then moves the budget by hand; a re-executed apply would be
    // visible as the value snapping back to 150
    const manual = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: adminAuth,
      payload: { budgetUsd: 175 },
    });
    expect(manual.statusCode).toBe(200);

    const second = await applyProposal(proposalId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("proposal_already_applied");
    expect((await readProject(projectId)).budgetUsd).toBe(175);
  });

  it("surfaces the route's own refusal for a project that does not exist — named, not a 500", async () => {
    const { proposalId, approvalId } = await proposeThrough("budget_adjustment", "b8c project gone", {
      projectId: "3d1f8a58-0000-4000-8000-b8c000000001",
      patch: { budgetUsd: 10 },
    });
    await decide(approvalId, "approved");
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(404);
    // the route's OWN error, surfaced verbatim
    expect(res.json().error).toBe("unknown_project");
    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).toBeNull();
  });

  it("NEVER bypasses the route's own zod: a patch the route would refuse is refused with its error", async () => {
    const projectId = await makeProject("b8c-budget-zod", { budgetUsd: 100 });
    const res = await proposeExpectingRefusal("budget_adjustment", "b8c zod bypass attempt", {
      projectId,
      // a NEGATIVE budget — updateProjectSchema requires positive; a raw
      // db.update would have written it without complaint
      patch: { budgetUsd: -50 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.error).toBe("proposal_diff_invalid");
    expect(res.detail).toMatch(/updateProjectSchema/);
    expect((await readProject(projectId)).budgetUsd).toBe(100);
  });

  it("surfaces the route's budget-requires-approver invariant verbatim rather than working around it", async () => {
    // a project with NO budget and NO approver: setting a budget alone must
    // hit the SAME merged-row invariant an admin's own PATCH hits
    const projectId = await makeProject("b8c-budget-invariant", { withApprover: false });
    const { proposalId, approvalId } = await proposeThrough("budget_adjustment", "b8c invariant", {
      projectId,
      patch: { budgetUsd: 40 },
    });
    await decide(approvalId, "approved");
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("budget_requires_approver");
    expect((await readProject(projectId)).budgetUsd).toBeNull();
    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).toBeNull();
  });

  it("refuses a patch that reaches past the budget — a budget_adjustment may not rename a project", async () => {
    const projectId = await makeProject("b8c-budget-scope", { budgetUsd: 100 });
    const res = await proposeExpectingRefusal("budget_adjustment", "b8c scope smuggle", {
      projectId,
      patch: { budgetUsd: 120, name: "smuggled-rename" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.error).toBe("proposal_diff_invalid");
    expect(res.detail).toMatch(/'name' is not a budget field/);
    const after = await readProject(projectId);
    expect(after.name).toBe("b8c-budget-scope");
    expect(after.budgetUsd).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// L6c — the model-judged half of L24, as an ANNOTATION and nothing else
// ---------------------------------------------------------------------------

const setJudgeKnob = async (enabled: boolean, agentId: string | null) => {
  await db.update(orgSettings).set({
    recommendationJudgeEnabled: enabled,
    recommendationJudgeAgentId: agentId,
  });
};

/** the deterministic shape of one rule's findings, judged fields stripped —
 * what must be byte-identical across a knob-off and a knob-on run */
const deterministicShape = (report: { rules: Array<Record<string, unknown>> }) =>
  JSON.stringify(
    report.rules.map((r) => ({
      ...r,
      findings: (r.findings as Array<Record<string, unknown>>).map(({ judged, ...rest }) => rest),
    })),
  );

describe("L6c — a judged annotation, opt-in, that can never become the finding", () => {
  it("is OFF by default: the report carries no annotation and says so", async () => {
    await setJudgeKnob(false, null);
    const res = await get("/v1/recommendations/access", adminAuth);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.judged).toMatchObject({ enabled: false });
    expect(body.judged.note).toMatch(/OFF for this organization/);
    for (const rule of body.rules) for (const f of rule.findings) expect(f.judged).toBeUndefined();
  });

  it("ENABLED with no judge agent named reports `unavailable` and changes NOTHING", async () => {
    await setJudgeKnob(false, null);
    const off = (await get("/v1/recommendations/access", adminAuth)).json();
    await setJudgeKnob(true, null);
    const on = (await get("/v1/recommendations/access", adminAuth)).json();
    expect(on.judged.enabled).toBe(true);
    expect(on.judged.status).toBe("unavailable");
    expect(on.judged.error).toBe("judge_required");
    expect(on.judged.note).toMatch(/NOTHING was judged/);
    // the deterministic half is untouched — not "quietly all clear"
    expect(deterministicShape(on)).toBe(deterministicShape(off));
    for (const rule of on.rules) for (const f of rule.findings) expect(f.judged).toBeUndefined();
    await setJudgeKnob(false, null);
  });

  it("ANNOTATES findings when enabled and a judge is reachable — labelled, and only those", async () => {
    await setJudgeKnob(false, null);
    const off = (await get("/v1/recommendations/access", adminAuth)).json();
    const offKeys = off.rules.flatMap((r: { findings: Array<{ key: string }> }) => r.findings.map((f) => f.key));
    expect(offKeys.length).toBeGreaterThan(0);

    let asked: RecommendationJudgeRequest[] = [];
    const judge: RecommendationJudge = {
      id: "test:judge",
      judge: async (reqs): Promise<RecommendationJudgeReply[]> => {
        asked = reqs;
        return [
          // a real key: annotated
          { key: reqs[0]!.key, verdict: "agree", note: "the evidence supports this" },
          // a key the deterministic rules NEVER produced: must be dropped, and
          // must NOT appear as a new finding anywhere
          { key: "peer-analytics:user:invented", verdict: "disagree", note: "invented finding" },
        ];
      },
    };
    const seam = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64), recommendationJudge: judge });
    try {
      await setJudgeKnob(true, null); // enabled; the injected judge IS the judge
      const res = await seam.inject({ method: "GET", url: "/v1/recommendations/access", headers: adminAuth });
      expect(res.statusCode).toBe(200);
      const on = res.json();

      expect(on.judged).toMatchObject({ enabled: true, status: "judged", judge: "test:judge", annotated: 1 });
      // the judge was handed the DETERMINISTIC keys, and nothing else
      expect(asked.length).toBeGreaterThan(0);
      for (const r of asked) expect(offKeys).toContain(r.key);

      const annotated = on.rules
        .flatMap((r: { findings: Array<{ key: string; judged?: { method: string } }> }) => r.findings)
        .filter((f: { judged?: unknown }) => f.judged);
      expect(annotated.length).toBe(1);
      expect(annotated[0].judged.method).toBe(RECOMMENDATION_JUDGE_METHOD);
      expect(annotated[0].judged.method).toBe("model-judged");
      expect(annotated[0].judged.verdict).toBe("agree");
      expect(annotated[0].judged.limits).toMatch(/not evidence/i);
      expect(annotated[0].key).toBe(asked[0]!.key);

      // THE INVENTED FINDING NEVER LANDED. Same key set as the knob-off run.
      const onKeys = on.rules.flatMap((r: { findings: Array<{ key: string }> }) => r.findings.map((f) => f.key));
      expect(new Set(onKeys)).toEqual(new Set(offKeys));

      // AND THE DETERMINISTIC HALF IS BYTE-IDENTICAL to the knob-off run
      expect(deterministicShape(on)).toBe(deterministicShape(off));
    } finally {
      await seam.close();
      await setJudgeKnob(false, null);
    }
  });

  it("a judge that THROWS leaves the report unchanged and states `unavailable`", async () => {
    await setJudgeKnob(false, null);
    const off = (await get("/v1/recommendations/access", adminAuth)).json();
    const broken: RecommendationJudge = {
      id: "test:broken",
      judge: async () => {
        throw new Error("no model credential (user or platform) is configured for provider 'google'");
      },
    };
    const seam = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64), recommendationJudge: broken });
    try {
      await setJudgeKnob(true, null);
      const on = (
        await seam.inject({ method: "GET", url: "/v1/recommendations/access", headers: adminAuth })
      ).json();
      expect(on.judged.status).toBe("unavailable");
      expect(on.judged.error).toBe("judge_not_dispatchable");
      expect(on.judged.reason).toMatch(/no model credential/);
      expect(deterministicShape(on)).toBe(deterministicShape(off));
    } finally {
      await seam.close();
      await setJudgeKnob(false, null);
    }
  });

  it("the CAMPAIGN FEED never consults the judge — an action path stays deterministic", async () => {
    // the judged layer annotates a REPORT; the grant refs a campaign snapshots
    // come from `computeRecommendedGrantRefs`, which never takes a judge. A
    // disagreeing judge must therefore change nothing about what a campaign
    // would review.
    const disagreeWithEverything: RecommendationJudge = {
      id: "test:contrarian",
      judge: async (reqs) => reqs.map((r) => ({ key: r.key, verdict: "disagree" as const, note: "no" })),
    };
    const seam = buildApp(db, {
      bootstrapToken: BOOT,
      dataKey: "e".repeat(64),
      recommendationJudge: disagreeWithEverything,
    });
    try {
      await setJudgeKnob(true, null);
      const on = (
        await seam.inject({ method: "GET", url: "/v1/recommendations/access", headers: adminAuth })
      ).json();
      const flagged = on.rules
        .flatMap((r: { findings: Array<{ grantId: string | null }> }) => r.findings)
        .filter((f: { grantId: string | null }) => f.grantId)
        .map((f: { grantId: string }) => f.grantId);
      const { computeRecommendedGrantRefs } = await import("./access-recommendations.js");
      const refs = await computeRecommendedGrantRefs(db, [
        "unused-grant",
        "orphaned-agent-grants",
        "retired-agent-grants",
        "overreach",
        "never-signed-in-holder",
      ]);
      // every grant the (disagreed-with) findings name is still in the feed
      for (const g of flagged) {
        if (refs.some((r) => r.grantId === g)) continue;
        // sod findings carry their refs on `grants`, not `grantId` — those are
        // excluded from this list by the rule-id filter above, so a miss here
        // would be a real regression
        expect(refs.map((r) => r.grantId)).toContain(g);
      }
      expect(refs.length).toBeGreaterThan(0);
    } finally {
      await seam.close();
      await setJudgeKnob(false, null);
    }
  });
});
