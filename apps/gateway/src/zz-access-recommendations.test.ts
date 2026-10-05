/**
 * ADR-0092 — access recommendations, the deterministic half (gap L24,
 * docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
 *
 * What this file makes impossible to fake:
 *
 *  1. UNUSED IS A MEASUREMENT, NOT A GUESS. The unused-grant cases pin the
 *     rule against the REAL usage ledger: a grant with a metered call in the
 *     window is NOT flagged, a grant whose last use predates the window IS
 *     (with the last-use date in the evidence), a grant younger than the
 *     window is not judged at all, and widening the window parameter makes a
 *     finding disappear — the window is a parameter, not a truth.
 *  2. UNOBSERVABLE IS SAID, NEVER COUNTED AS UNUSED. A role-bundled grant
 *     whose role has no current assignee lands in `notAssessable` with its
 *     reason — never in the findings.
 *  3. RECOMMENDATIONS RE-SURFACE, NEVER RE-JUDGE. The orphaned/retired/
 *     overreach/sod cases assert the SAME flags ADR-0089/0091 compute,
 *     re-served with evidence and a rendered rationale.
 *  4. THE FEED IS EXACT. A from_recommendations campaign snapshots EXACTLY
 *     the grant refs the named rules flag at open — asserted set-equal
 *     against the endpoint's own findings, then driven to a real revoke
 *     through the one decide path (recommend → review → revoke-is-real).
 *  5. NOTHING EXECUTES. Computing recommendations writes no audit row, no
 *     approval, and deletes nothing — asserted as deltas around the GET.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed rec-. The recommendations endpoint is
 * org-wide, so assertions FILTER to this file's own grant ids and never
 * assert absolute org-wide counts (M-008). FILE NAME SORTS LAST on purpose
 * (M-018): this file creates a certification campaign and an SoD rule, and
 * grant-certification.test.ts / sod.test.ts each assert the "none has ever
 * existed" posture statement — which only survives if nothing before them
 * writes those tables.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
  approvals,
  auditLog,
  connectorGrants,
  count,
  createDb,
  eq,
  roleAgentGrants,
  runMigrations,
  toolGrants,
  usageEvents,
  type Db,
} from "@regulait/db";
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

const BOOT = "rec-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const dayMs = 24 * 60 * 60 * 1000;

let db: Db;
let app: ReturnType<typeof buildApp>;

type Auth = { authorization: string };
let openerId: string; // admin — opens the from_recommendations campaign
let openerAuth: Auth;
let holderAId: string; // uses agentUsed (in window), holds agentUnused
let holderBId: string; // last use of agentStale predates the window
let ghostId: string; // never authenticates, never dispatches — the L24 ghost
let goneId: string; // deactivated holder
let conflictId: string; // holds both sides of the SoD rule

let agentUnused: string; // backdated grant, zero usage → unused-grant
let agentUsed: string; // backdated grant, usage IN window → control
let agentStale: string; // backdated grant, usage BEFORE window → flagged with lastUse
let agentYoung: string; // fresh grant → not judged
let agentRetired: string; // retired lifecycle → retired-agent-grants
let agentOwnedOrphan: string; // owner deactivated → orphaned-agent-grants
let connectorC: string; // side B of the SoD rule
let serverId: string; // MCP tool usage coverage
let roleAssignedId: string; // role with an assignee (assessable)
let roleEmptyId: string; // role with NO assignee (not assessable)

let grantUnused: string;
let grantUsed: string;
let grantStale: string;
let grantYoung: string;
let grantRetired: string;
let grantOrphan: string;
let grantGhost: string;
let grantGone: string;
let grantConflictAgent: string;
let grantConflictConnector: string;
let toolGrantUsed: string;
let toolGrantUnused: string;
let roleGrantAssessable: string;
let roleGrantNoAssignee: string;

async function makeUser(email: string, opts: { admin?: boolean } = {}) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  if (opts.admin) {
    const up = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${id}/admin`,
      payload: { isAdmin: true, reason: "rec coverage" },
    });
    expect(up.statusCode).toBe(200);
  }
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${id}/keys`, payload: { name: "rec-key" } });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function grantAgent(userId: string, agentId: string): Promise<string> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** backdate a grant row so the unused rule may judge it (the ledger's
 * created_at is the rule's age input; nothing else about the row changes) */
async function backdateAgentGrant(grantId: string, days: number) {
  await db.update(agentGrants).set({ createdAt: new Date(Date.now() - days * dayMs) }).where(eq(agentGrants.id, grantId));
}

const recommendations = async (query = "") => {
  const res = await app.inject({ method: "GET", headers: AUTH, url: `/v1/recommendations/access${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    rulesVersion: number;
    window: { days: number; start: string; end: string };
    notes: Record<string, string>;
    rules: Array<{
      id: string;
      version: number;
      severity: string;
      title: string;
      limits: string;
      findings: Array<{
        grantKind: string | null;
        grantId: string | null;
        holder: { userId: string | null; roleId: string | null; label: string };
        object: { id: string; label: string; toolName: string | null } | null;
        rationale: string;
        evidence: Record<string, unknown>;
        grants?: Array<{ grantKind: string; grantId: string; side: string }>;
        action: {
          campaignScope: { kind: string; value: string };
          revoke: { method: string; path: string } | null;
        };
      }>;
      notAssessable: Array<{ grantKind: string; grantId: string; reason: string }>;
      counts: { findings: number; notAssessable: number };
    }>;
    action: { openCampaign: { endpoint: string; note: string } };
  };
};
const ruleOf = (report: Awaited<ReturnType<typeof recommendations>>, id: string) =>
  report.rules.find((r) => r.id === id)!;
const findingByGrant = (report: Awaited<ReturnType<typeof recommendations>>, ruleId: string, grantId: string) =>
  ruleOf(report, ruleId).findings.find((f) => f.grantId === grantId);

async function auditRows(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog);
  return row?.n ?? 0;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });

  const opener = await makeUser("rec-opener@example.com", { admin: true });
  openerId = opener.id;
  openerAuth = opener.auth;
  holderAId = (await makeUser("rec-holder-a@example.com")).id;
  holderBId = (await makeUser("rec-holder-b@example.com")).id;
  ghostId = (await makeUser("rec-ghost@example.com")).id;
  goneId = (await makeUser("rec-gone@example.com")).id;
  conflictId = (await makeUser("rec-conflict@example.com")).id;

  agentUnused = await mkAgent("rec-agent-unused");
  agentUsed = await mkAgent("rec-agent-used");
  agentStale = await mkAgent("rec-agent-stale");
  agentYoung = await mkAgent("rec-agent-young");
  agentRetired = await mkAgent("rec-agent-retired");
  agentOwnedOrphan = await mkAgent("rec-agent-orphan");

  grantUnused = await grantAgent(holderAId, agentUnused);
  grantUsed = await grantAgent(holderAId, agentUsed);
  grantStale = await grantAgent(holderBId, agentStale);
  grantYoung = await grantAgent(holderAId, agentYoung);
  grantRetired = await grantAgent(holderAId, agentRetired);
  grantGhost = await grantAgent(ghostId, agentUsed);
  grantGone = await grantAgent(goneId, agentUsed);
  await backdateAgentGrant(grantUnused, 100);
  await backdateAgentGrant(grantUsed, 100);
  await backdateAgentGrant(grantStale, 400);

  // the usage ledger rows the rule reads: holderA used agentUsed IN the
  // window; holderB used agentStale 200 days ago (before the 90-day window)
  await db.insert(usageEvents).values([
    { userId: holderAId, objectType: "agent", agentId: agentUsed, at: new Date(Date.now() - 5 * dayMs) },
    { userId: holderBId, objectType: "agent", agentId: agentStale, at: new Date(Date.now() - 200 * dayMs) },
  ]);

  // retired lifecycle (grant already exists; retirement never touches it)
  const retire = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/agents/${agentRetired}/lifecycle`,
    payload: { status: "retired", reason: "rec: decommissioned line" },
  });
  expect(retire.statusCode).toBe(200);

  // orphaned ownership: owner recorded, then deactivated (the ADR-0022 state)
  const orphanOwner = await makeUser("rec-orphan-owner@example.com");
  const setOwner = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/agents/${agentOwnedOrphan}/owner`,
    payload: { ownerUserId: orphanOwner.id },
  });
  expect(setOwner.statusCode).toBe(200);
  grantOrphan = await grantAgent(holderAId, agentOwnedOrphan);
  const deact = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${orphanOwner.id}/deactivate`, payload: {} });
  expect(deact.statusCode).toBe(200);

  // deactivated holder
  const deactGone = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${goneId}/deactivate`, payload: {} });
  expect(deactGone.statusCode).toBe(200);

  // MCP server + tool: one tool grant USED (an mcp_tool usage row with the
  // serverId in the detail jsonb — the real metering shape), one unused
  const server = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: "rec-server", url: "http://127.0.0.1:9" } });
  expect(server.statusCode).toBe(201);
  serverId = server.json().id;
  for (const name of ["rec_tool_used", "rec_tool_unused"]) {
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: { name, kind: "write" } });
  }
  const tgUsed = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/tools",
    payload: { userId: holderBId, serverId, toolName: "rec_tool_used" },
  });
  expect(tgUsed.statusCode).toBe(201);
  toolGrantUsed = tgUsed.json().id;
  const tgUnused = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/tools",
    payload: { userId: holderBId, serverId, toolName: "rec_tool_unused" },
  });
  expect(tgUnused.statusCode).toBe(201);
  toolGrantUnused = tgUnused.json().id;
  await db.update(toolGrants).set({ createdAt: new Date(Date.now() - 120 * dayMs) }).where(eq(toolGrants.userId, holderBId));
  await db.insert(usageEvents).values({
    userId: holderBId,
    objectType: "mcp_tool",
    operation: "rec_tool_used",
    at: new Date(Date.now() - 3 * dayMs),
    detail: { serverId, toolName: "rec_tool_used" },
  });

  // role-bundled grants: one role WITH an assignee (assessable — and unused),
  // one role with NO assignee (not assessable)
  const mkRole = async (name: string) => {
    const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  roleAssignedId = await mkRole("rec-role-assigned");
  roleEmptyId = await mkRole("rec-role-empty");
  const rg1 = await app.inject({ method: "POST", headers: AUTH, url: `/v1/roles/${roleAssignedId}/grants/agents`, payload: { agentId: agentUnused } });
  expect(rg1.statusCode).toBe(201);
  roleGrantAssessable = rg1.json().id;
  const rg2 = await app.inject({ method: "POST", headers: AUTH, url: `/v1/roles/${roleEmptyId}/grants/agents`, payload: { agentId: agentUnused } });
  expect(rg2.statusCode).toBe(201);
  roleGrantNoAssignee = rg2.json().id;
  const assign = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${holderAId}/roles`, payload: { roleId: roleAssignedId } });
  expect(assign.statusCode).toBe(201);
  await db.update(roleAgentGrants).set({ createdAt: new Date(Date.now() - 100 * dayMs) }).where(eq(roleAgentGrants.agentId, agentUnused));

  // the SoD violator: BOTH sides granted before the rule exists (mint-time
  // enforcement is ADR-0091's; the recommendation re-surfaces the sweep)
  grantConflictAgent = await grantAgent(conflictId, agentUsed);
  const connector = await app.inject({ method: "POST", headers: AUTH, url: "/v1/connectors", payload: { name: "rec-connector", kind: "data" } });
  expect(connector.statusCode).toBe(201);
  connectorC = connector.json().id;
  const cg = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/connectors",
    payload: { userId: conflictId, connectorId: connectorC, mode: "readwrite" },
  });
  expect(cg.statusCode).toBe(201);
  grantConflictConnector = cg.json().id;
  const sodRule = await app.inject({
    method: "POST",
    headers: openerAuth,
    url: "/v1/sod/rules",
    payload: {
      name: "rec-toxic-pair",
      reason: "rec: dispatching this agent and writing this connector must not combine",
      a: { kind: "agent", objectId: agentUsed },
      b: { kind: "connector", objectId: connectorC, mode: "readwrite" },
    },
  });
  expect(sodRule.statusCode, sodRule.body).toBe(201);
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  await app.close();
  await db.$client.end();
});

describe("the report shape: versioned rules, notes, read-only", () => {
  it("serves the frozen v1 rule list in order, each result carrying id + version + severity class + limits", async () => {
    const report = await recommendations();
    expect(report.rulesVersion).toBe(1);
    expect(report.window.days).toBe(90);
    expect(report.rules.map((r) => r.id)).toEqual([
      "unused-grant",
      "orphaned-agent-grants",
      "retired-agent-grants",
      "overreach",
      "sod-violation",
      "never-signed-in-holder",
    ]);
    for (const r of report.rules) {
      expect(r.version).toBe(1);
      expect(["informational", "review-suggested"]).toContain(r.severity);
      expect(r.limits.length).toBeGreaterThan(20);
      expect(r.counts).toEqual({ findings: r.findings.length, notAssessable: r.notAssessable.length });
    }
    expect(report.notes.action).toMatch(/read-only/);
    expect(report.action.openCampaign.endpoint).toBe("POST /v1/certification-campaigns");
  });

  it("computing recommendations executes nothing: no audit row, no approval, no grant touched (deltas)", async () => {
    const [auditBefore, approvalsBefore] = [await auditRows(), await db.select({ n: count() }).from(approvals)];
    const [grantsBefore] = await db.select({ n: count() }).from(agentGrants);
    await recommendations();
    expect(await auditRows()).toBe(auditBefore);
    const [approvalsAfter] = await db.select({ n: count() }).from(approvals);
    expect(approvalsAfter?.n).toBe(approvalsBefore[0]?.n);
    const [grantsAfter] = await db.select({ n: count() }).from(agentGrants);
    expect(grantsAfter?.n).toBe(grantsBefore?.n);
  });
});

describe("unused-grant: a measurement over the metered ledger, honestly bounded", () => {
  it("flags the backdated never-used grant with hand-checkable evidence and a rendered rationale", async () => {
    const report = await recommendations();
    const f = findingByGrant(report, "unused-grant", grantUnused);
    expect(f, "the 100-day-old never-used grant must be flagged").toBeTruthy();
    expect(f!.evidence).toMatchObject({
      ageDays: 100,
      windowDays: 90,
      governedCallsInWindow: 0,
      lastGovernedUseAt: null,
    });
    expect(f!.rationale).toContain("granted 100 days ago");
    expect(f!.rationale).toContain("rec-agent-unused");
    expect(f!.rationale).toContain("never");
    expect(f!.action.revoke).toEqual({ method: "DELETE", path: `/v1/grants/agents/${grantUnused}` });
    expect(f!.action.campaignScope).toEqual({ kind: "from_recommendations", value: "unused-grant" });
  });

  it("does NOT flag the grant with a metered call in the window (same age, same holder)", async () => {
    const report = await recommendations();
    expect(findingByGrant(report, "unused-grant", grantUsed)).toBeUndefined();
  });

  it("flags the grant whose last use predates the window — and says when that was", async () => {
    const report = await recommendations();
    const f = findingByGrant(report, "unused-grant", grantStale);
    expect(f).toBeTruthy();
    expect(f!.evidence.lastGovernedUseAt).not.toBeNull();
    expect(f!.rationale).toContain("before the window");
  });

  it("does not judge a grant younger than the window — neither flagged nor not-assessable", async () => {
    const report = await recommendations();
    expect(findingByGrant(report, "unused-grant", grantYoung)).toBeUndefined();
    expect(ruleOf(report, "unused-grant").notAssessable.some((n) => n.grantId === grantYoung)).toBe(false);
  });

  it("the window is a parameter: at ?windowDays=365 the 100-day-old grant is no longer old enough to judge", async () => {
    const report = await recommendations("?windowDays=365");
    expect(report.window.days).toBe(365);
    expect(findingByGrant(report, "unused-grant", grantUnused)).toBeUndefined();
    // the 400-day-old grant STAYS judgeable — and its 200-day-old last use
    // is now INSIDE the wider window, so it is no longer unused either
    expect(findingByGrant(report, "unused-grant", grantStale)).toBeUndefined();
  });

  it("covers MCP tool grants through the metering ledger's jsonb serverId — used not flagged, unused flagged", async () => {
    const report = await recommendations();
    expect(findingByGrant(report, "unused-grant", toolGrantUsed)).toBeUndefined();
    const f = findingByGrant(report, "unused-grant", toolGrantUnused);
    expect(f).toBeTruthy();
    expect(f!.object!.toolName).toBe("rec_tool_unused");
    expect(f!.action.revoke!.path).toBe(`/v1/grants/tools/${toolGrantUnused}`);
  });

  it("a role-bundled grant is judged across its assignees; a role with NO assignee is NOT ASSESSABLE, never unused", async () => {
    const report = await recommendations();
    const rule = ruleOf(report, "unused-grant");
    // assigned role: holderA never dispatched agentUnused → flagged
    const assessed = rule.findings.find((f) => f.grantId === roleGrantAssessable);
    expect(assessed).toBeTruthy();
    expect(assessed!.evidence.assessedAssignees).toBe(1);
    expect(assessed!.action.revoke!.path).toBe(`/v1/roles/${roleAssignedId}/grants/agents/${roleGrantAssessable}`);
    // empty role: no holder to attribute use to — the disclosure discipline
    const na = rule.notAssessable.find((n) => n.grantId === roleGrantNoAssignee);
    expect(na, "the empty-role grant must surface as not assessable").toBeTruthy();
    expect(na!.reason).toMatch(/no current assignee/);
    expect(rule.findings.some((f) => f.grantId === roleGrantNoAssignee)).toBe(false);
  });

  it("states its observed-source honesty on the payload: metered executed calls, tracing-independent", async () => {
    const report = await recommendations();
    expect(report.notes.observed).toMatch(/regardless of the tracing switch/);
    expect(report.notes.observed).toMatch(/not assessable, never unused/i);
  });
});

describe("the ADR-0089/0091 flags re-surfaced with evidence, never re-judged", () => {
  it("orphaned-agent-grants: the deactivated-owner agent's grant is flagged with the orphan evidence", async () => {
    const report = await recommendations();
    const f = findingByGrant(report, "orphaned-agent-grants", grantOrphan);
    expect(f).toBeTruthy();
    expect(f!.evidence.ownership).toBe("orphaned");
    expect((f!.evidence.owner as { deactivatedAt: string | null }).deactivatedAt).not.toBeNull();
    expect(f!.rationale).toContain("deactivated");
    // an unowned agent's grant is flagged too (accountability gap), stated as such
    const unownedF = findingByGrant(report, "orphaned-agent-grants", grantUnused);
    expect(unownedF).toBeTruthy();
    expect(unownedF!.evidence.ownership).toBe("unowned");
    expect(unownedF!.rationale).toContain("no recorded owner");
  });

  it("retired-agent-grants: informational, quoting the lifecycle reason and the already-standing dispatch refusal", async () => {
    const report = await recommendations();
    const rule = ruleOf(report, "retired-agent-grants");
    expect(rule.severity).toBe("informational");
    const f = rule.findings.find((x) => x.grantId === grantRetired);
    expect(f).toBeTruthy();
    expect(f!.evidence.lifecycleReason).toBe("rec: decommissioned line");
    expect(f!.evidence.dispatchAlreadyRefuses).toMatch(/agent_retired/);
    expect(f!.rationale).toContain("dead weight");
    // a non-retired agent's grants are not here
    expect(rule.findings.some((x) => x.grantId === grantUsed)).toBe(false);
  });

  it("overreach: granted-but-intended-by-no-approved-use-case agents surface per grant row; grantless agents cannot overreach", async () => {
    const report = await recommendations();
    const rule = ruleOf(report, "overreach");
    // every rec- agent with grants is unnamed by any approved use case in
    // this file → its grant rows appear (evidence carries the holder count)
    const f = rule.findings.find((x) => x.grantId === grantUnused);
    expect(f).toBeTruthy();
    expect(f!.evidence.approvedUseCasesNamingAgent).toBe(0);
    expect(f!.evidence.effectiveHolders as number).toBeGreaterThan(0);
    // an agent with NO grant rows has no finding to hang overreach on: no
    // finding in this rule may reference an object with zero holders
    for (const x of rule.findings) expect(x.evidence.effectiveHolders as number).toBeGreaterThan(0);
  });

  it("sod-violation: the violator, the rule's own recorded reason, and the CONCRETE conferring grant rows", async () => {
    const report = await recommendations();
    const rule = ruleOf(report, "sod-violation");
    const f = rule.findings.find((x) => (x.evidence.sodRule as { name: string }).name === "rec-toxic-pair");
    expect(f, "the pre-existing co-holding must surface").toBeTruthy();
    expect(f!.holder.userId).toBe(conflictId);
    expect(f!.rationale).toContain("rec: dispatching this agent and writing this connector must not combine");
    const refs = (f!.grants ?? []).map((g) => `${g.grantKind}:${g.grantId}`).sort();
    expect(refs).toEqual([`agent:${grantConflictAgent}`, `connector:${grantConflictConnector}`].sort());
  });

  it("never-signed-in-holder: the ghost (no session, no key use, no usage) and the deactivated holder — with the signal named", async () => {
    const report = await recommendations();
    const rule = ruleOf(report, "never-signed-in-holder");
    const ghost = rule.findings.find((x) => x.grantId === grantGhost);
    expect(ghost).toBeTruthy();
    expect(ghost!.evidence.facets).toContain("never_authenticated");
    expect(ghost!.rationale).toContain("never authenticated");
    const gone = rule.findings.find((x) => x.grantId === grantGone);
    expect(gone).toBeTruthy();
    expect(gone!.evidence.facets).toContain("deactivated");
    // holderA has usage rows — an active human is behind the grant: not flagged
    expect(rule.findings.some((x) => x.grantId === grantUsed)).toBe(false);
  });
});

describe("the campaign feed: from_recommendations snapshots EXACTLY the flagged grants", () => {
  it("refuses unknown rule ids and an empty rule list by name", async () => {
    const bad = await app.inject({
      method: "POST",
      headers: openerAuth,
      url: "/v1/certification-campaigns/preview",
      payload: { scope: { kind: "from_recommendations", value: "unused-grant,peer-analytics" } },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("invalid_recommendation_rules");
    expect(bad.json().invalid).toEqual(["peer-analytics"]);

    const empty = await app.inject({
      method: "POST",
      headers: openerAuth,
      url: "/v1/certification-campaigns/preview",
      payload: { scope: { kind: "from_recommendations", value: " , " } },
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error).toBe("invalid_recommendation_rules");
  });

  it("preview counts exactly the grants the named rule flags right now", async () => {
    const report = await recommendations();
    const expected = ruleOf(report, "retired-agent-grants").findings.map((f) => `${f.grantKind}:${f.grantId}`);
    const preview = await app.inject({
      method: "POST",
      headers: openerAuth,
      url: "/v1/certification-campaigns/preview",
      payload: { scope: { kind: "from_recommendations", value: "retired-agent-grants" } },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().count).toBe(expected.length);
  });

  it("opens the campaign over the flagged set, set-equal to the endpoint's findings — then a revoke is REAL", async () => {
    const report = await recommendations();
    const expected = new Set(
      ruleOf(report, "retired-agent-grants").findings.map((f) => `${f.grantKind}:${f.grantId}`),
    );
    expect(expected.size).toBeGreaterThan(0);
    const open = await app.inject({
      method: "POST",
      headers: openerAuth,
      url: "/v1/certification-campaigns",
      payload: {
        name: "rec-c1",
        scope: { kind: "from_recommendations", value: "retired-agent-grants" },
        dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    expect(open.statusCode, open.body).toBe(201);
    const detail = await app.inject({
      method: "GET",
      headers: openerAuth,
      url: `/v1/certification-campaigns/${open.json().id}`,
    });
    expect(detail.statusCode).toBe(200);
    const items = detail.json().items as Array<{ grantKind: string; grantId: string; approvalId: string }>;
    expect(new Set(items.map((i) => `${i.grantKind}:${i.grantId}`))).toEqual(expected);

    // recommend → review → human decision → revoke-is-real: the flagged
    // retired-agent grant is removed through the ONE decide path
    const myItem = items.find((i) => i.grantId === grantRetired)!;
    const decided = await app.inject({
      method: "POST",
      headers: openerAuth,
      url: `/v1/approvals/${myItem.approvalId}/decide`,
      payload: { decision: "denied", reason: "recommended: dead weight on a retired agent" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    const gone = await db.select().from(agentGrants).where(eq(agentGrants.id, grantRetired));
    expect(gone).toHaveLength(0);

    // and the NEXT report no longer flags the removed row (computed, not stored)
    const after = await recommendations();
    expect(findingByGrant(after, "retired-agent-grants", grantRetired)).toBeUndefined();
  });
});

describe("the posture line", () => {
  it("carries findings by rule with severities, and states the not-assessable count outright", async () => {
    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/reports/posture" });
    expect(res.statusCode).toBe(200);
    const section = res.json().accessRecommendations as {
      rulesVersion: number;
      windowDays: number;
      byRule: Array<{ id: string; severity: string; findings: number; notAssessable: number }>;
      totalFindings: number;
      totalNotAssessable: number;
      note: string;
    };
    expect(section.rulesVersion).toBe(1);
    expect(section.byRule.map((r) => r.id)).toEqual([
      "unused-grant",
      "orphaned-agent-grants",
      "retired-agent-grants",
      "overreach",
      "sod-violation",
      "never-signed-in-holder",
    ]);
    // this file created at least one finding and one not-assessable grant
    expect(section.totalFindings).toBeGreaterThan(0);
    expect(section.totalNotAssessable).toBeGreaterThan(0);
    expect(section.note).toMatch(/not assessable/);
    expect(section.note).toMatch(/nothing executes automatically/);
  });
});
