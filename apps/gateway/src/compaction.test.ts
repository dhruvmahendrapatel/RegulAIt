import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  conversations,
  costEvents,
  createDb,
  eq,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import {
  CONVERSATION_COMPACTION_SENTINEL,
  resolveModelProvider,
  type MockModelProvider,
} from "@regulait/model-provider";
import { buildApp } from "./app.js";

/**
 * PILLAR 6 §5 — automatic context compaction, end to end: drive a thread past
 * the 1600-token threshold → exactly one governed compaction dispatch fires
 * (audit purpose "compact", summary persisted, billed to the project) → the
 * next dispatch's wire messages are [summary context] + the 4-message recent
 * window only → a context_compaction savings row lands per summary-riding
 * dispatch → re-compaction is cumulative (prior summary + turns since, never
 * re-reading compacted-away turns) → a failing summarizer fails OPEN (the
 * user's turn succeeds on the full history, noted in the trace) → stored
 * messages are never deleted or altered.
 *
 * Shares one database with the other gateway suites (fileParallelism is off);
 * everything here is prefixed compact- and ledger asserts filter by user id.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "compact-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

const SUMMARY_CONTEXT_PREFIX = "Context — summary of the conversation so far: ";

// ~1100 chars per prompt (medium complexity, no code) so each exchange is
// heavy enough that the 1600-token threshold is crossed within a few turns
const FILLER = " The migration must keep invoice numbering strictly monotonic across regions.".repeat(13);
const TOPICS = [
  "plan the orbital-billing ledger migration with zero downtime",
  "review the dual-write cutover strategy for the ledger",
  "explain the reconciliation checkpoints between old and new ledgers",
  "plan the rollback path if reconciliation drifts past 0.1 percent",
  "review the final go-live checklist for orbital-billing",
  "explain how audit retention applies during the migration window",
  "plan the decommission of the legacy ledger after cutover",
  "review the postmortem template for the migration",
  "explain the paging policy for the first week after go-live",
  "plan the cost review of the new ledger infrastructure",
];
const turnInput = (i: number) => `${TOPICS[i % TOPICS.length]}.${FILLER}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;
let noraId: string;
let noraAuth: { authorization: string };
let mainAgentId: string;
let cheapAgentId: string;
let projectId: string;
let convoId: string;

async function makeUser(email: string, displayName: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "test" },
  });
  expect(key.statusCode).toBe(201);
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function makeAgent(name: string, tier: number, costIn: number, costOut: number) {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier, costPerMTokIn: costIn, costPerMTokOut: costOut, model: "mock-balanced" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const grant = (userId: string, agentId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });

async function sendTurn(auth: { authorization: string }, agentId: string, conversationId: string, input: string) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "chat", input, dispatch: true, conversationId },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    dispatch: { outputText: string; refusal: boolean };
    compaction?: {
      active: boolean;
      summaryTokens: number;
      omittedMessages: number;
      savedTokensEst: number;
      compacted?: boolean;
      failOpen?: { error: string };
    };
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

  const nora = await makeUser("compact-nora@example.com", "Compact Nora");
  noraId = nora.id;
  noraAuth = nora.auth;

  // two priced mock agents: the summarizer must pick the CHEAPEST one
  mainAgentId = await makeAgent("compact-main", 1, 3, 15);
  cheapAgentId = await makeAgent("compact-cheap", 0, 1, 5);
  await grant(noraId, mainAgentId);
  await grant(noraId, cheapAgentId);

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "compact-project" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;

  const convo = await app.inject({
    method: "POST",
    headers: noraAuth,
    url: "/v1/conversations",
    payload: { agentId: mainAgentId, projectId },
  });
  expect(convo.statusCode).toBe(201);
  convoId = convo.json().id;
});

describe("threshold crossing → one governed compaction dispatch", () => {
  let compactedAtTurn = -1;
  const results: Awaited<ReturnType<typeof sendTurn>>[] = [];

  it("fires exactly once while the thread grows past the threshold", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await sendTurn(noraAuth, mainAgentId, convoId, turnInput(i));
      results.push(r);
      if (r.compaction?.compacted) {
        expect(compactedAtTurn).toBe(-1); // never twice within this phase
        compactedAtTurn = i;
      }
    }
    expect(compactedAtTurn).toBeGreaterThan(1);
    // turns before the trigger carried no compaction detail at all
    for (let i = 0; i < compactedAtTurn; i++) expect(results[i]!.compaction).toBeUndefined();
    // every turn from the trigger on rode the summary
    for (let i = compactedAtTurn; i < results.length; i++) {
      expect(results[i]!.compaction?.active).toBe(true);
      expect(results[i]!.compaction!.savedTokensEst).toBeGreaterThan(0);
    }
  });

  it("the compaction dispatch went to the CHEAPEST entitled agent, billed to the project, audit purpose 'compact'", async () => {
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.userId, noraId));
    const compactRows = usage.filter(
      (u) => (u.detail as { purpose?: string }).purpose === "compact",
    );
    expect(compactRows).toHaveLength(1);
    expect(compactRows[0]!.agentId).toBe(cheapAgentId);
    expect(compactRows[0]!.projectId).toBe(projectId);
    // its cost is a normal, visible cost row — the price paid for the savings
    expect(compactRows[0]!.costUsd).toBeGreaterThan(0);

    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, noraId));
    const compactAudits = audits.filter((a) => a.ruleId === "context-compaction");
    expect(compactAudits).toHaveLength(1);
    expect((compactAudits[0]!.detail as { purpose?: string }).purpose).toBe("compact");
    expect((compactAudits[0]!.detail as { conversationId?: string }).conversationId).toBe(convoId);
  });

  it("the summary is persisted on the conversation and stored messages are untouched", async () => {
    const [row] = await db.select().from(conversations).where(eq(conversations.id, convoId));
    expect(row!.summary).toMatch(/^Summary of the conversation \(\d+ earlier turns/);
    expect(row!.summaryThroughMessageId).not.toBeNull();
    expect(row!.summaryTokens).toBeGreaterThan(0);
    expect(row!.compactedAt).not.toBeNull();
    // summary derived from the compacted turns' topics, not boilerplate
    expect(row!.summary).toContain("orbital-billing ledger migration");

    // GET returns every original turn — nothing deleted, nothing altered
    const detail = await app.inject({
      method: "GET",
      headers: noraAuth,
      url: `/v1/conversations/${convoId}`,
    });
    const msgs = detail.json().messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(12); // 6 exchanges, all originals
    for (let i = 0; i < 6; i++) {
      expect(msgs[2 * i]!.role).toBe("user");
      expect(msgs[2 * i]!.content).toBe(turnInput(i));
    }
    expect(detail.json().summary).toBe(row!.summary);
  });

  it("post-compaction wire messages = [summary context] + recent verbatim window + newest turn only", async () => {
    // the LAST main dispatch of the loop above rode the summary
    const wire = mock.dispatches.at(-1)!;
    expect(wire.messages![0]!.role).toBe("user");
    expect((wire.messages![0]!.content as string).startsWith(SUMMARY_CONTEXT_PREFIX)).toBe(true);
    expect(wire.messages![0]!.content).toContain("Summary of the conversation (");
    // compacted-away turn content must NOT ride the wire
    expect(wire.messages!.slice(1).some((m) => m.content === turnInput(0))).toBe(false);
    // everything after the context message is verbatim stored turns + the new one
    const boundCount = wire.messages!.length - 2; // minus context msg and newest turn
    expect(boundCount).toBeLessThanOrEqual(6); // recent window (4) + at most one later exchange
    // and the compaction dispatch itself (immediately before the main one on
    // the compacting turn) carried the sentinel system prompt + a transcript
    const compactionWire = mock.dispatches.find((d) =>
      d.system?.includes(CONVERSATION_COMPACTION_SENTINEL) && d.input.includes("orbital-billing"),
    )!;
    expect(compactionWire).toBeDefined();
    expect(compactionWire.input).toContain(`user: ${turnInput(0)}`);
  });

  it("each summary-riding dispatch landed a context_compaction savings row of plausible magnitude", async () => {
    const rows = (await db.select().from(costEvents).where(eq(costEvents.userId, noraId))).filter(
      (r) => r.technique === "context_compaction",
    );
    const activeTurns = results.filter((r) => r.compaction?.active).length;
    expect(rows).toHaveLength(activeTurns);
    for (const r of rows) {
      expect(r.projectId).toBe(projectId);
      expect(r.ruleId).toBe("context-compaction");
      // plausible: at least 2 omitted exchanges (~500+ est tokens) minus a
      // ~100-token summary
      expect(r.estimatedTokensSaved).toBeGreaterThan(300);
      expect(r.estimatedTokensSaved).toBeLessThan(20_000);
      expect(r.estimatedCostSavedUsd).toBeGreaterThan(0);
      expect((r.detail as { conversationId?: string }).conversationId).toBe(convoId);
    }
  });

  it("a streaming turn surfaces the same compaction detail in the SSE result event", async () => {
    const res = await app.inject({
      method: "POST",
      headers: noraAuth,
      url: `/v1/agents/${mainAgentId}/invoke`,
      payload: { mode: "chat", input: "now recap in two lines", dispatch: true, stream: true, conversationId: convoId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const result = res.body
      .split("\n\n")
      .filter((b) => b.includes("event: result"))
      .map((b) => JSON.parse(/^data: (.*)$/m.exec(b)![1]!))[0];
    expect(result.compaction.active).toBe(true);
    expect(result.compaction.savedTokensEst).toBeGreaterThan(0);
  });
});

describe("re-compaction is cumulative", () => {
  it("the second compaction summarizes [prior summary + turns since], never re-reading compacted-away turns", async () => {
    const [before] = await db.select().from(conversations).where(eq(conversations.id, convoId));
    const firstBoundary = before!.summaryThroughMessageId;
    const firstSummary = before!.summary!;

    let second: NonNullable<Awaited<ReturnType<typeof sendTurn>>["compaction"]> | null = null;
    for (let i = 6; i < 14 && !second; i++) {
      const r = await sendTurn(noraAuth, mainAgentId, convoId, turnInput(i));
      if (r.compaction?.compacted) second = r.compaction;
    }
    expect(second).not.toBeNull();

    // the second summarization input = existing summary + post-summary turns
    const wire = mock.dispatches
      .filter((d) => d.system?.includes(CONVERSATION_COMPACTION_SENTINEL))
      .at(-1)!;
    expect(wire.input.startsWith("Prior summary:\n")).toBe(true);
    expect(wire.input).toContain(firstSummary);
    // compacted-away turn 0 is never re-read into a summarization input
    expect(wire.input).not.toContain(`user: ${turnInput(0)}`);

    const [after] = await db.select().from(conversations).where(eq(conversations.id, convoId));
    expect(after!.summaryThroughMessageId).not.toBe(firstBoundary);
    expect(after!.summary).toContain("cumulative with the prior summary");

    // at least two compaction dispatches by now (any turn that crossed the
    // re-grown threshold may have compacted again) — each one metered
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.userId, noraId));
    expect(
      usage.filter((u) => (u.detail as { purpose?: string }).purpose === "compact").length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("fail-open — a failing summarizer never fails the user's turn", () => {
  let failConvoId: string;

  it("a thread whose old turns make the summarizer refuse still dispatches on the full history", async () => {
    const convo = await app.inject({
      method: "POST",
      headers: noraAuth,
      url: "/v1/conversations",
      payload: { agentId: mainAgentId, projectId },
    });
    failConvoId = convo.json().id;

    // turn 1 carries the mock refusal trigger: ITS dispatch is a refusal
    // (persisted honestly), and once it ages out of the recent window every
    // compaction transcript containing it makes the summarizer refuse too
    const poison = `please <<refuse>> this request about the orbital-billing ledger.${FILLER}`;
    const first = await sendTurn(noraAuth, mainAgentId, failConvoId, poison);
    expect(first.dispatch.refusal).toBe(true);

    let sawFailOpen: { error: string } | null = null;
    let last: Awaited<ReturnType<typeof sendTurn>> | null = null;
    for (let i = 1; i < 7 && !sawFailOpen; i++) {
      last = await sendTurn(noraAuth, mainAgentId, failConvoId, turnInput(i));
      if (last.compaction?.failOpen) sawFailOpen = last.compaction.failOpen;
    }
    expect(sawFailOpen).toEqual({ error: "summarizer_refused" });
    // the user's turn SUCCEEDED (a real answer, not a refusal, not an error)
    expect(last!.dispatch.refusal).toBe(false);
    expect(last!.dispatch.outputText.length).toBeGreaterThan(0);
    // and the trace says the summary was NOT in play
    expect(last!.compaction!.active).toBe(false);
    expect(last!.compaction!.savedTokensEst).toBe(0);

    // full history rode the wire — no summary context message
    const wire = mock.dispatches.at(-1)!;
    expect((wire.messages![0]!.content as string).startsWith(SUMMARY_CONTEXT_PREFIX)).toBe(false);
    expect(wire.messages!.length).toBeGreaterThan(6);

    // nothing persisted on the conversation; the fail-open is audited
    const [row] = await db.select().from(conversations).where(eq(conversations.id, failConvoId));
    expect(row!.summary).toBeNull();
    expect(row!.summaryThroughMessageId).toBeNull();
    expect(row!.compactedAt).toBeNull();
    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, noraId));
    const failAudits = audits.filter((a) => a.ruleId === "context-compaction-failed-open");
    expect(failAudits.length).toBeGreaterThan(0);
    expect(
      failAudits.some((a) => (a.detail as { conversationId?: string }).conversationId === failConvoId),
    ).toBe(true);

    // stored messages: all originals, untouched
    const detail = await app.inject({
      method: "GET",
      headers: noraAuth,
      url: `/v1/conversations/${failConvoId}`,
    });
    const msgs = detail.json().messages as Array<{ role: string; content: string }>;
    expect(msgs.filter((m) => m.role === "user").map((m) => m.content)[0]).toBe(poison);
    expect(msgs.length % 2).toBe(0); // strict user/assistant pairs, nothing dropped
  });
});
