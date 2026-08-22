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
 *     the LINKED APPROVAL in the one existing queue: pending, denied, missing,
 *     already-applied and not-an-applicable-kind each refuse by their OWN
 *     name, audited, with the target asserted UNCHANGED. Only the approved one
 *     applies — and its mutation is asserted to have really happened (the
 *     grant row is gone; the rule's enforcing body moved) through the same
 *     public choke points an admin would use.
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
  expect(p.statusCode).toBe(201);
  return { proposalId: p.json().proposal.id as string, approvalId: p.json().approvalId as string };
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
      // attacker-influenceable `reason` string
      expect(o.label).toMatch(/^(allow|deny|approval_required|error)\s·\s/);
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
    const res = await post(
      "/v1/copilot/ask",
      { question: "what does the Sarbanes-Oxley Act require of a nonexistent widget?" },
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
        payload: { question: "what does SOX require?", narratorAgentId: agentA },
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

  it("refuses a kind with no public endpoint, NAMING the endpoint that must exist first", async () => {
    const { proposalId, approvalId } = await proposeThrough("budget_adjustment", "l6 budget", {
      projectId: "00000000-0000-0000-0000-000000000000",
      budgetUsd: 1,
    });
    await decide(approvalId, "approved");
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("proposal_kind_not_applicable");
    expect(res.json().detail).toMatch(/no single public choke point for a budget write/);
    // even APPROVED, it stays unapplied — an approval is consent, not a door
    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).toBeNull();
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

  it("surfaces a malformed diff as a named refusal rather than half-applying it", async () => {
    const { proposalId, approvalId } = await proposeThrough("policy_tightening", "l6 malformed", {
      ruleKind: "approvals",
      // no ruleId, no patch
    });
    await decide(approvalId, "approved");
    const res = await applyProposal(proposalId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("proposal_diff_invalid");
    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).toBeNull();
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
