import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  costEvents,
  createDb,
  desc,
  eq,
  inArray,
  modelCredentials,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";

/**
 * B6a (ADR-0095 amendment) — MOCK SHADOWING FOR THE OTHER TWO ROSTERS.
 *
 * ADR-0095 narrowed ROUTING selection so a mock-provider agent cannot be
 * chosen while a credentialed live agent in the caller's entitled roster can
 * serve (`routing-mock-honesty.test.ts` pins that half). It named its own
 * residual out loud: the COMPACTION-SUMMARIZER roster and the DECOMPOSE-WORKER
 * roster were not narrowed, so a mock could still be picked to
 *
 *   - SUMMARIZE a conversation — canned prose written over the thread's
 *     retained context, so every later turn silently degrades; and
 *   - PLAN a task graph — a canned decomposition is a nonsense DAG, and the
 *     implicit lead used to be "the cheapest granted mock" by construction.
 *
 * Same disease as the routing defect the owner hit directly, quieter symptoms.
 * This file pins all four halves of the fix:
 *
 *  1. With a credentialed live agent present, NEITHER roster selects a mock —
 *     asserted on the SERVED dispatch (the compaction audit row's
 *     `servedAgentId`, the decompose response's `dispatch.servedAgentId` and
 *     the planning prompt's own roster listing), never merely on a reported
 *     roster.
 *  2. The KEYLESS DEMO is byte-identical: with no credential anywhere, both
 *     rosters still select mocks and nothing is disclosed as skipped.
 *  3. The skip is disclosed with the SAME reason string routing uses,
 *     `mock_shadowed_by_live`.
 *  4. An EXPLICIT choice is still honoured: ADR-0021's
 *     `summarizerSelection: 'fixed_agent'` naming a mock still summarizes with
 *     that mock even while live agents can serve — the compaction analogue of
 *     routing's requested-agent exemption.
 *
 * MECHANISM. The "credentialed live provider" is anthropic with a stored
 * PLATFORM credential, its adapter stubbed at `resolveModelProvider` exactly as
 * `routing-mock-honesty.test.ts` stubs it, so a live-shaped dispatch succeeds
 * offline. The stub DELEGATES to the real mock provider for the reply body:
 * everything under test (roster narrowing, summarizer pick, lead pick, served
 * dispatch) sits upstream of the adapter, and delegating keeps the planning
 * reply a parseable plan and the compaction reply a usable summary.
 *
 * SHARED-DB DISCIPLINE: `cdm-` prefixed users/agents/projects owned by this
 * file; every ledger assertion is a DELTA or is filtered to this file's own
 * user ids (M-008); provider env vars are cleared per-file and restored
 * verbatim (an ambient key would make the keyless case silently credentialed);
 * the org-settings singleton is mutated by exactly one test and restored in the
 * same test AND in afterAll (M-012); the stored anthropic credential and this
 * file's usage/cost rows are removed in afterAll.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cdmLiveCalls: Array<{ model: string; system: string; input: string }>;
}
globalThis.__cdmLiveCalls = [];

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const [config] = args;
      if (config.provider === "anthropic") {
        const inner = actual.resolveModelProvider({ provider: "mock" });
        return {
          kind: "anthropic",
          dispatch: async (req: { model: string; system?: string; input: string }) => {
            globalThis.__cdmLiveCalls.push({
              model: req.model,
              system: req.system ?? "",
              input: req.input,
            });
            // an offline stand-in for a WORKING live provider: the credential
            // gate, the roster narrowing and the summarizer/lead pick all ran
            // for real before this point
            return (inner as unknown as { dispatch: (r: unknown) => Promise<unknown> }).dispatch(
              req,
            );
          },
        } as unknown as ReturnType<typeof actual.resolveModelProvider>;
      }
      return actual.resolveModelProvider(...args);
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

const BOOT = "cdm-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);

const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
] as const;
const ORIG_ENV: Record<string, string | undefined> = {};
for (const name of PROVIDER_ENV_VARS) ORIG_ENV[name] = process.env[name];

// ~1100 chars a turn (compaction.test.ts's own filler discipline) so the
// 1600-token threshold is crossed within a few exchanges
const FILLER = " The migration must keep invoice numbering strictly monotonic across regions.".repeat(13);
const TOPICS = [
  "plan the orbital-billing ledger migration with zero downtime",
  "review the dual-write cutover strategy for the ledger",
  "explain the reconciliation checkpoints between old and new ledgers",
  "plan the rollback path if reconciliation drifts past 0.1 percent",
  "review the final go-live checklist for orbital-billing",
  "explain how audit retention applies during the migration window",
];
const turnInput = (i: number) => `${TOPICS[i % TOPICS.length]}.${FILLER}`;

const GOAL = "Add rate-limit headers to the public API and document them";

let db: Db;
let app: ReturnType<typeof buildApp>;
/** the CREDENTIALED caller: two live agents + one (cheapest) mock */
let livId: string;
let livAuth: { authorization: string };
let liveMainId: string;
let liveCheapId: string;
let mockLivId: string;
/** the KEYLESS caller: an uncredentialed live agent + a mock */
let keyId: string;
let keyAuth: { authorization: string };
let liveKeylessId: string;
let mockKeyId: string;
let projectId: string;
/** the org-settings values this file must put back (M-012) */
let priorSummarizerSelection: string | null = null;
let priorSummarizerAgentId: string | null = null;

async function makeUser(email: string) {
  const displayName = email.split("@")[0]!.replace(/-/g, " ");
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "cdm" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(payload: Record<string, unknown>, grantees: string[]) {
  const a = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload });
  expect(a.statusCode).toBe(201);
  const id = a.json().id as string;
  for (const g of grantees) {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: g, agentId: id },
    });
  }
  return id;
}

async function newConversation(auth: { authorization: string }, agentId: string) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: "/v1/conversations",
    payload: { agentId, projectId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** drive a thread until compaction fires; returns the turn index it fired on */
async function compactOnce(auth: { authorization: string }, agentId: string, convoId: string) {
  for (let i = 0; i < 8; i++) {
    const res = await app.inject({
      method: "POST",
      headers: auth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: turnInput(i), dispatch: true, conversationId: convoId },
    });
    expect(res.statusCode).toBe(200);
    if (res.json().compaction?.compacted) return i;
  }
  throw new Error("compaction never fired");
}

/** the `context-compaction` audit rows this file's callers produced */
async function compactionAudits(userId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.ruleId, "context-compaction")))
    .orderBy(desc(auditLog.at), desc(auditLog.id));
}

const putOrgSettings = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload });

beforeAll(async () => {
  for (const name of PROVIDER_ENV_VARS) delete process.env[name];
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const liv = await makeUser("cdm-liv@example.com");
  livId = liv.id;
  livAuth = liv.auth;
  const key = await makeUser("cdm-key@example.com");
  keyId = key.id;
  keyAuth = key.auth;

  // liv: an expensive live agent, a CHEAPER live agent, and a mock cheaper
  // than both — so "cheapest dispatchable" would pick the mock if the rosters
  // were not narrowed, which is exactly the defect
  liveMainId = await makeAgent(
    { name: "cdm-live-main", provider: "anthropic", tier: 2, model: "cdm-live-main-model", costPerMTokIn: 15, costPerMTokOut: 75 },
    [livId],
  );
  liveCheapId = await makeAgent(
    { name: "cdm-live-cheap", provider: "anthropic", tier: 1, model: "cdm-live-cheap-model", costPerMTokIn: 3, costPerMTokOut: 15 },
    [livId],
  );
  mockLivId = await makeAgent(
    { name: "cdm-mock", provider: "mock", tier: 0, model: "mock-fast", costPerMTokIn: 1, costPerMTokOut: 5 },
    [livId],
  );

  // key: the keyless demo — a live agent with NO credential for its provider
  liveKeylessId = await makeAgent(
    { name: "cdm-google-live", provider: "google", tier: 2, model: "cdm-gem-model", costPerMTokIn: 15, costPerMTokOut: 75 },
    [keyId],
  );
  mockKeyId = await makeAgent(
    { name: "cdm-mock-keyless", provider: "mock", tier: 0, model: "mock-fast", costPerMTokIn: 1, costPerMTokOut: 5 },
    [keyId],
  );
  // own the keyless story for the google slot while this file runs: no stored
  // platform credential may make the "keyless" roster silently credentialed
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "google"));

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "cdm-project" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;

  const settings = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
  priorSummarizerSelection = settings.json().settings.summarizerSelection ?? null;
  priorSummarizerAgentId = settings.json().settings.summarizerAgentId ?? null;

  // the CREDENTIAL that makes liv's anthropic agents genuinely servable
  const cred = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/model-credentials",
    payload: { provider: "anthropic", apiKey: "sk-ant-cdm-not-a-real-key" },
  });
  expect(cred.statusCode).toBe(201);
});

afterAll(async () => {
  await putOrgSettings({
    summarizerSelection: priorSummarizerSelection ?? "cheapest",
    summarizerAgentId: priorSummarizerAgentId,
  });
  const agentIds = [liveMainId, liveCheapId, mockLivId, liveKeylessId, mockKeyId].filter(Boolean);
  if (agentIds.length > 0) await db.delete(usageEvents).where(inArray(usageEvents.agentId, agentIds));
  await db.delete(costEvents).where(inArray(costEvents.userId, [livId, keyId].filter(Boolean)));
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "anthropic"));
  for (const name of PROVIDER_ENV_VARS) {
    if (ORIG_ENV[name] !== undefined) process.env[name] = ORIG_ENV[name];
    else delete process.env[name];
  }
});

describe("B6a — the compaction SUMMARIZER roster is mock-narrowed", () => {
  it("summarizes with the cheapest LIVE agent, never the cheaper mock — and discloses the skip", async () => {
    const before = (await compactionAudits(livId)).length;
    const convoId = await newConversation(livAuth, liveMainId);
    await compactOnce(livAuth, liveMainId, convoId);

    const audits = await compactionAudits(livId);
    expect(audits.length).toBe(before + 1);
    const detail = audits[0]!.detail as {
      conversationId?: string;
      servedAgentId?: string;
      skippedCandidates?: Array<{ agentId: string; name: string; reason: string }>;
    };
    expect(detail.conversationId).toBe(convoId);

    // SERVED dispatch, not merely the roster: the summarization dispatch that
    // actually ran was served by the cheapest LIVE agent
    expect(detail.servedAgentId).toBe(liveCheapId);
    expect(detail.servedAgentId).not.toBe(mockLivId);
    expect(audits[0]!.objectId).toBe(liveCheapId);

    // and the withheld mock is disclosed with routing's own reason string
    expect(detail.skippedCandidates).toEqual([
      { agentId: mockLivId, name: "cdm-mock", reason: "mock_shadowed_by_live" },
    ]);

    // the usage ledger agrees — one new compaction row, on the live agent
    const usage = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, livId), eq(usageEvents.agentId, liveCheapId)));
    const compactRows = usage.filter(
      (u) => (u.detail as { purpose?: string } | null)?.purpose === "compact",
    );
    expect(compactRows).toHaveLength(1);
    expect(compactRows[0]!.provider).toBe("anthropic");
  });

  it("an org-FIXED mock summarizer is still honoured — an explicit choice is not routing", async () => {
    const set = await putOrgSettings({
      summarizerSelection: "fixed_agent",
      summarizerAgentId: mockLivId,
    });
    expect(set.statusCode).toBe(200);
    try {
      const before = (await compactionAudits(livId)).length;
      const convoId = await newConversation(livAuth, liveMainId);
      await compactOnce(livAuth, liveMainId, convoId);
      const audits = await compactionAudits(livId);
      expect(audits.length).toBe(before + 1);
      const detail = audits[0]!.detail as {
        servedAgentId?: string;
        skippedCandidates?: unknown[];
      };
      // the admin named this mock on purpose: it summarizes, and it is NOT
      // reported as shadowed
      expect(detail.servedAgentId).toBe(mockLivId);
      expect(detail.skippedCandidates).toBeUndefined();
    } finally {
      // M-012: the singleton goes back inside the test that moved it
      await putOrgSettings({
        summarizerSelection: priorSummarizerSelection ?? "cheapest",
        summarizerAgentId: priorSummarizerAgentId,
      });
    }
  });

  it("THE KEYLESS DEMO — with no credential anywhere the mock still summarizes, nothing skipped", async () => {
    const before = (await compactionAudits(keyId)).length;
    // the keyless demo's own thread runs on the mock: the uncredentialed
    // google agent is not dispatchable, so it is neither a summarizer
    // candidate nor able to shadow one — which is precisely the keyless state
    const convoId = await newConversation(keyAuth, mockKeyId);
    await compactOnce(keyAuth, mockKeyId, convoId);

    const audits = await compactionAudits(keyId);
    expect(audits.length).toBe(before + 1);
    const detail = audits[0]!.detail as {
      servedAgentId?: string;
      skippedCandidates?: unknown[];
    };
    expect(detail.servedAgentId).toBe(mockKeyId);
    // byte-identical to the pre-B6a keyless path: no skip is disclosed at all
    expect(detail.skippedCandidates).toBeUndefined();
  });
});

describe("B6a — the decompose WORKER roster is mock-narrowed", () => {
  it("plans with live agents only: live lead, live worker owners, mock absent from the prompt roster", async () => {
    const mark = globalThis.__cdmLiveCalls.length;
    const res = await app.inject({
      method: "POST",
      headers: livAuth,
      url: "/v1/runs/decompose",
      payload: { goal: GOAL, projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // SERVED dispatch: with no explicit lead and no default agent, the implicit
    // lead used to be "the cheapest granted mock" — it is now the cheapest
    // surviving (live) roster agent, and it really served the planning turn
    expect(body.dispatch.servedAgentId).toBe(liveCheapId);
    expect(body.dispatch.servedAgentId).not.toBe(mockLivId);
    expect(globalThis.__cdmLiveCalls.length).toBeGreaterThan(mark);
    expect(globalThis.__cdmLiveCalls.at(-1)!.model).toBe("cdm-live-cheap-model");

    // the ROSTER the lead was offered: the planning prompt lists both live
    // agents and never the mock, so no worker node can be assigned to one
    const planningSystem = globalThis.__cdmLiveCalls.at(-1)!.system;
    expect(planningSystem).toContain("cdm-live-cheap");
    expect(planningSystem).toContain("cdm-live-main");
    expect(planningSystem).not.toContain("cdm-mock");

    // and the proposal itself: every node owned by a live agent
    expect(body.proposal.nodes.length).toBeGreaterThan(0);
    for (const n of body.proposal.nodes) {
      expect([liveMainId, liveCheapId]).toContain(n.ownerAgentId);
      expect(n.ownerAgentId).not.toBe(mockLivId);
    }

    // disclosed with routing's own reason string, on the response and the audit
    expect(body.skippedCandidates).toEqual([
      { agentId: mockLivId, name: "cdm-mock", reason: "mock_shadowed_by_live" },
    ]);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, livId), eq(auditLog.ruleId, "run-decomposed")))
      .orderBy(desc(auditLog.at), desc(auditLog.id));
    expect(
      (audit!.detail as { skippedCandidates?: Array<{ agentId: string }> }).skippedCandidates,
    ).toEqual([{ agentId: mockLivId, name: "cdm-mock", reason: "mock_shadowed_by_live" }]);
  });

  it("an explicitly named mock lead is still honoured — an explicit choice is not routing", async () => {
    const res = await app.inject({
      method: "POST",
      headers: livAuth,
      url: "/v1/runs/decompose",
      payload: { goal: GOAL, projectId, leadAgentId: mockLivId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.servedAgentId).toBe(mockLivId);
    // the WORKER roster stays narrowed even under an explicit mock lead — the
    // exemption is for the agent the caller named, not for the plan's workers
    for (const n of res.json().proposal.nodes) {
      expect([liveMainId, liveCheapId]).toContain(n.ownerAgentId);
    }
  });

  it("THE KEYLESS DEMO — with no credential anywhere the mock still leads and owns every node", async () => {
    const res = await app.inject({
      method: "POST",
      headers: keyAuth,
      url: "/v1/runs/decompose",
      payload: { goal: GOAL, projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // byte-identical to the pre-B6a keyless path: the cheapest granted mock is
    // the implicit lead, it owns the nodes, and nothing is disclosed as skipped
    expect(body.dispatch.servedAgentId).toBe(mockKeyId);
    for (const n of body.proposal.nodes) expect(n.ownerAgentId).toBe(mockKeyId);
    expect(body.skippedCandidates).toBeUndefined();
  });
});
