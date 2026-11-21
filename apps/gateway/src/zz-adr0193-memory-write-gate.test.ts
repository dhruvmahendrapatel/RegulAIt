/**
 * ADR-0193 addendum (lane E50, OWASP Agentic ASI06 memory poisoning), on top of the ADR-0347 write path, on a real
 * database through the real app:
 *  - the shared-context write route (`POST /v1/projects/:id/context`) refuses a write whose producing run (the
 *    caller's own, as ADR-0347 checks) holds untrusted content: 403 `content_trust_refused`, audited under
 *    `content-trust-floor`, nothing stored;
 *  - the agent-memory route (`POST /v1/builder/agents/:id/memory`) does the same for a declared `run:` or
 *    `builder_thread:` context, and refuses a context that is not the caller's own (someone else's run or thread,
 *    a run in another project, an unknown context) before the floor runs, so a clean foreign context cannot be
 *    borrowed to dodge it (review R7 finding 1);
 *  - a clean write from a clean context, and a person's note with no context, are stored as before;
 *  - the floor runs before the ADR-0347 scan: a poisoned context with a hidden instruction is refused by the floor;
 *  - the `memory.untrusted_context_write` probe passes on the defaults and fails when the memory scan is relaxed.
 *
 * Shared database (M-068): settings are put back in `finally`; every assertion is scoped by this run's ids.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  auditLog,
  builderAgentMemory,
  builderThreads,
  eq,
  orchestrationRuns,
  orgSettings,
  projectContextItems,
  runWithRlsSystem,
} from "@regulait/db";
import { builderThreadContextId, runContextId } from "@regulait/shared";
import { HIDDEN_INSTRUCTION_DOCUMENT, runGatewayProbe } from "./agent-risk-proof-probes.js";
import { recordContentProvenance } from "./content-provenance.js";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";

let k: BuilderKit;
let owner: Person;
let other: Person;
let agentId: string;

const sys = <T>(fn: () => Promise<T>) => runWithRlsSystem("system_task", "test.adr0193.memory", fn);

/** an orchestration run of `who` in `projectId` */
async function runOf(who: Person, projectId: string | null): Promise<string> {
  const [run] = await k.db
    .insert(orchestrationRuns)
    .values({ name: `e50-${k.RUN}-${randomUUID().slice(0, 8)}`, initiatingUserId: who.id, projectId, graph: { nodes: [] }, state: { nodes: {} }, status: "running" })
    .returning({ id: orchestrationRuns.id });
  return run!.id;
}

/** record content from a source nobody classified (so `untrusted`) into a context, via the real P0 writer */
async function poison(contextId: string, who: Person): Promise<void> {
  await recordContentProvenance(k.db, undefined, {
    userId: who.id,
    source: { kind: "connector", connectorId: randomUUID(), operation: "read", object: null },
    upstream: "a page from the open web",
    delivered: "a page from the open web",
    classification: "clean",
    decisionAuditId: randomUUID(),
    contextId,
    projectId: who.projectId,
  });
}

async function threadOf(who: Person, agent: string): Promise<string> {
  const [th] = await k.db.insert(builderThreads).values({ agentId: agent, userId: who.id, title: "e50", source: "chat", updatedAt: new Date() }).returning();
  return th!.id;
}

const contextRows = (key: string) =>
  k.db.select().from(projectContextItems).where(and(eq(projectContextItems.projectId, owner.projectId), eq(projectContextItems.key, key)));
const memoryRows = () => k.db.select().from(builderAgentMemory).where(eq(builderAgentMemory.agentId, agentId));
const audits = (objectId: string, ruleId: string) =>
  k.db.select().from(auditLog).where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));
const memory = (who: Person, payload: Record<string, unknown>) => k.req("POST", `/v1/builder/agents/${agentId}/memory`, who.auth, payload);

beforeAll(async () => {
  k = await builderKit("e50-mem");
  owner = await k.person("owner");
  other = await k.person("other");
  const r = await k.req("POST", "/v1/builder/agents", owner.auth, {
    name: `E50 agent ${k.RUN}`,
    connectionFormat: "shared",
    computerUse: false,
    projectId: owner.projectId,
  });
  expect(r.statusCode, r.body).toBe(201);
  agentId = r.json().agent.id;
}, 120_000);

afterAll(async () => {
  await k?.close();
});

describe("E50: the shared-context write route", () => {
  it("refuses a write whose producing run holds untrusted content, audited, and stores nothing", async () => {
    const key = `e50-floor-${k.RUN}`;
    const runId = await runOf(owner, owner.projectId);
    await poison(runContextId(runId), owner);
    const r = await k.req("POST", `/v1/projects/${owner.projectId}/context`, owner.auth, { key, content: "a clean summary", producedByRunId: runId });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "content_trust_refused", lowestTier: "untrusted", writeFloor: "trusted" });
    expect(await contextRows(key)).toHaveLength(0);
    const rows = (await audits(owner.projectId, "content-trust-floor")).filter((a) => (a.detail as { key?: string }).key === key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect: "deny", objectType: "project" });
    expect(rows[0]!.detail).toMatchObject({ surface: "shared_context", contextId: runContextId(runId), lowestTier: "untrusted" });
  });

  it("the floor runs before the ADR-0347 scan: a poisoned run with a hidden instruction is refused by the floor", async () => {
    const key = `e50-order-${k.RUN}`;
    const runId = await runOf(owner, owner.projectId);
    await poison(runContextId(runId), owner);
    const r = await k.req("POST", `/v1/projects/${owner.projectId}/context`, owner.auth, { key, content: HIDDEN_INSTRUCTION_DOCUMENT, producedByRunId: runId });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("content_trust_refused");
  });

  it("stores a clean write from a clean run, as before", async () => {
    const key = `e50-clean-${k.RUN}`;
    const runId = await runOf(owner, owner.projectId);
    const r = await k.req("POST", `/v1/projects/${owner.projectId}/context`, owner.auth, { key, content: "release on Thursdays", producedByRunId: runId });
    expect(r.statusCode, r.body).toBe(201);
    expect(await contextRows(key)).toHaveLength(1);
  });
});

describe("E50: the agent-memory write route", () => {
  it("refuses memory drawn from the caller's own run that holds untrusted content, audited, and stores nothing", async () => {
    const before = (await memoryRows()).length;
    const runId = await runOf(owner, owner.projectId);
    await poison(runContextId(runId), owner);
    const r = await memory(owner, { content: "the customer prefers euros", contextId: runContextId(runId) });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("content_trust_refused");
    expect(await memoryRows()).toHaveLength(before);
    const rows = (await audits(agentId, "content-trust-floor")).filter((a) => (a.detail as { contextId?: string }).contextId === runContextId(runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect: "deny", objectType: "builder_agent" });
  });

  it("refuses memory drawn from the caller's own builder thread that holds untrusted content", async () => {
    const threadId = await threadOf(owner, agentId);
    await poison(builderThreadContextId(threadId), owner);
    const r = await memory(owner, { content: "answer briefly", contextId: builderThreadContextId(threadId) });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("content_trust_refused");
  });

  it("R7 finding 1: refuses a context that is not the caller's own, before the floor runs", async () => {
    const before = (await memoryRows()).length;
    // someone else's clean run: borrowing it would otherwise skip the floor
    const foreignRun = await runOf(other, owner.projectId);
    expect((await memory(owner, { content: "x", contextId: runContextId(foreignRun) })).json()).toMatchObject({ error: "not_your_context" });
    // a run of the caller's in another project
    const elsewhere = await runOf(owner, other.projectId);
    expect((await memory(owner, { content: "x", contextId: runContextId(elsewhere) })).json()).toMatchObject({ error: "context_not_in_project" });
    // someone else's thread on this agent
    const foreignThread = await threadOf(other, agentId);
    const t = await memory(owner, { content: "x", contextId: builderThreadContextId(foreignThread) });
    expect(t.statusCode).toBe(403);
    expect(t.json().error).toBe("not_your_context");
    // a context that does not exist
    expect((await memory(owner, { content: "x", contextId: runContextId(randomUUID()) })).json()).toMatchObject({ error: "unknown_context" });
    expect(await memoryRows()).toHaveLength(before);
  });

  it("stores a person's clean note with no context, and memory from a clean own context; refuses a malformed id", async () => {
    expect((await memory(owner, { content: "answer in British English" })).statusCode).toBe(201);
    const runId = await runOf(owner, owner.projectId);
    expect((await memory(owner, { content: "invoices in euros", contextId: runContextId(runId) })).statusCode).toBe(201);
    expect((await memory(owner, { content: "x", contextId: "not-a-context" })).statusCode).toBe(400);
  });
});

describe("E50: the memory.untrusted_context_write probe covers the memory writes", () => {
  it("passes on the defaults, with all three writes refused", async () => {
    const r = await sys(() => runGatewayProbe(k.db, "untrusted_context_write"));
    expect(r).toMatchObject({ outcome: "pass", detail: { refused: true, memoryFloorRefused: true, memoryScanRefused: true } });
  });

  it("NEGATIVE: fails when the ADR-0347 memory scan is relaxed to log", async () => {
    const [prior] = await k.db.select({ mode: orgSettings.agentMemoryScanMode }).from(orgSettings);
    await k.db.update(orgSettings).set({ agentMemoryScanMode: "log" });
    try {
      const r = await sys(() => runGatewayProbe(k.db, "untrusted_context_write"));
      expect(r).toMatchObject({ outcome: "fail", detail: { memoryFloorRefused: true, memoryScanRefused: false, memoryScanMode: "log" } });
    } finally {
      await k.db.update(orgSettings).set({ agentMemoryScanMode: prior?.mode ?? "block" });
    }
  });
});
