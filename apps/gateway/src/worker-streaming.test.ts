/**
 * Worker-node / auto-dispatch STREAMING e2e (pillar 7 + ADR-0019 §8.4).
 *
 * The dispatch and auto-advance routes accept `stream: true` and deliver the
 * worker's tokens as SSE, reusing the invoke path's exported building blocks
 * (executeGovernedDispatch's onText, projectPiiMode, loadInterceptionSettings).
 * Proven here, end to end at the gateway edge:
 *
 *  - node dispatch stream is WELL-FORMED SSE: invoke framing (`delta` events
 *    whose texts concatenate to the final output, then ONE `result` event
 *    carrying exactly the JSON payload);
 *  - auto-advance streams a MULTIPLEXED per-node envelope — node_start
 *    {nodeId, agent} / node_delta {nodeId, text} / node_complete {nodeId,
 *    status[, usage, costUsd]} / run_complete {status, stoppedReason,
 *    dispatched, measuredSpentUsd} — for a ≥2-node run, run_complete last;
 *  - a block-mode PII project NEVER streams: the same governed dispatch runs
 *    fully buffered and returns JSON with streamingSuppressed (disclosed in
 *    the response AND the audit trail), for both routes;
 *  - an entitlement failure is a REAL HTTP error (403 JSON), never a 200
 *    stream — every gate resolves before the stream opens;
 *  - the non-stream path is byte-shape unchanged;
 *  - LEDGER PARITY: a streamed dispatch lands the same usage_events row shape,
 *    token counts and cost as an identical non-streamed one, and the run's
 *    measured budget accumulates identically.
 *
 * Runs against its OWN scratch database (regulait_wt_stream, drop+recreate),
 * so it can never pollute the database the other gateway suites share.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  orchestrationRuns,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const DB_NAME = "regulait_wt_stream";
const streamUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + DB_NAME;
  return u.toString();
})();

const BOOT = "ws-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let workerId: string;
let umaId: string;
let umaAuth: { authorization: string };
let approverId: string;

const mkUser = async (email: string, name: string): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: name },
  });
  return r.json().id;
};
const authFor = async (userId: string): Promise<{ authorization: string }> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`,
    payload: { name: "ws-key" },
  });
  return { authorization: `Bearer ${r.json().token}` };
};
const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  ownerAgentId: agentId,
  mode: "execute",
  estimate: { in: 10, out: 20 },
  ...extra,
});

/** plan a run as uma; returns the run id */
async function planRunFor(
  nodes: Array<Record<string, unknown>>,
  name: string,
  projectId?: string,
): Promise<string> {
  const r = await app.inject({
    method: "POST", headers: umaAuth, url: "/v1/runs",
    payload: {
      graph: { run: name, escalationApproverUserId: approverId, nodes },
      ...(projectId ? { projectId } : {}),
    },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id;
}

/** start the run and put ONE node in_progress, ready to dispatch */
async function startNode(runId: string, nodeId: string): Promise<void> {
  const s = await app.inject({
    method: "POST", headers: umaAuth, url: `/v1/runs/${runId}/events`,
    payload: { kind: "start" },
  });
  expect(s.statusCode).toBe(200);
  const n = await app.inject({
    method: "POST", headers: umaAuth, url: `/v1/runs/${runId}/events`,
    payload: { kind: "node_started", nodeId },
  });
  expect(n.statusCode).toBe(200);
}

/** parse an SSE body into ordered {event, data} records; asserts framing */
function parseSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  const chunks = body.split("\n\n").filter((c) => c.trim().length > 0);
  return chunks.map((chunk) => {
    const event = /event: (.+)/.exec(chunk)?.[1];
    const data = /data: (.+)/.exec(chunk)?.[1];
    expect(event, `malformed SSE chunk: ${chunk}`).toBeTruthy();
    expect(data, `malformed SSE chunk: ${chunk}`).toBeTruthy();
    return { event: event!, data: JSON.parse(data!) as Record<string, unknown> };
  });
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${DB_NAME}`));
  db = createDb(streamUrl);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });

  const agent = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/agents",
    payload: {
      name: "ws-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-ws",
    },
  });
  workerId = agent.json().id;

  umaId = await mkUser("ws-uma@example.com", "Uma Stream");
  umaAuth = await authFor(umaId);
  approverId = await mkUser("ws-approver@example.com", "WS Approver");
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/agents",
    payload: { userId: umaId, agentId: workerId },
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.$client.end();
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`));
  await admin.$client.end();
});

describe("node dispatch streaming (stream: true)", () => {
  it("returns a well-formed SSE stream: deltas that concatenate to the result payload's output", async () => {
    const runId = await planRunFor([mkNode("n1", workerId)], "ws-node-stream");
    await startNode(runId, "n1");

    const res = await app.inject({
      method: "POST", headers: umaAuth,
      url: `/v1/runs/${runId}/nodes/n1/dispatch`,
      payload: { stream: true, input: "stream me a governed worker answer" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.body);
    const deltas = events.filter((e) => e.event === "delta");
    const results = events.filter((e) => e.event === "result");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(results).toHaveLength(1);
    expect(events[events.length - 1]!.event).toBe("result");
    expect(events.some((e) => e.event === "error")).toBe(false);

    // the result event carries EXACTLY the JSON payload the non-stream path returns
    const payload = results[0]!.data as {
      dispatch: { outputText: string; usage: { inputTokens: number; outputTokens: number } };
      measuredSpentUsd: number;
    };
    expect(deltas.map((d) => d.data.text).join("")).toBe(payload.dispatch.outputText);
    expect(payload.dispatch.usage.inputTokens).toBeGreaterThan(0);
    expect(payload.dispatch.usage.outputTokens).toBeGreaterThan(0);
    expect(typeof payload.measuredSpentUsd).toBe("number");
  });

  it("the non-stream path is unchanged — plain JSON, same shape as before, no suppression flag", async () => {
    const runId = await planRunFor([mkNode("n1", workerId)], "ws-node-plain");
    await startNode(runId, "n1");

    const res = await app.inject({
      method: "POST", headers: umaAuth,
      url: `/v1/runs/${runId}/nodes/n1/dispatch`,
      payload: { input: "plain buffered dispatch" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["dispatch", "measuredSpentUsd"]);
    expect(body.streamingSuppressed).toBeUndefined();
    expect(body.dispatch.servedAgentId).toBe(workerId);
    expect(body.dispatch.model).toBe("mock-ws");
    expect(body.dispatch.outputText.length).toBeGreaterThan(0);
    expect(body.dispatch.turns).toBe(1);
    expect(body.dispatch.toolCalls).toBe(0);
  });

  it("an entitlement failure is a REAL HTTP error, never a 200 stream", async () => {
    const runId = await planRunFor([mkNode("n1", workerId)], "ws-node-revoked");
    await startNode(runId, "n1");
    // revoke AFTER plan/start: §5.1 is re-checked at execution time
    const rev = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${umaId}/revocations/agents`,
      payload: { agentId: workerId, reason: "ws stream test" },
    });
    expect(rev.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST", headers: umaAuth,
      url: `/v1/runs/${runId}/nodes/n1/dispatch`,
      payload: { stream: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-type"]).not.toContain("event-stream");
    expect(res.body).not.toContain("event:");
    expect(res.json().error).toBe("entitlement_exceeded");

    // lift the revocation so later tests dispatch again
    const list = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/users/${umaId}/revocations/agents`,
    });
    for (const row of list.json().revocations) {
      await app.inject({
        method: "DELETE", headers: AUTH,
        url: `/v1/users/${umaId}/revocations/agents/${row.id}`,
      });
    }
    const retry = await app.inject({
      method: "POST", headers: umaAuth,
      url: `/v1/runs/${runId}/nodes/n1/dispatch`,
      payload: { stream: true },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["content-type"]).toContain("text/event-stream");
  });
});

describe("auto-advance streaming — the multiplexed per-node envelope", () => {
  it("a 2-node run emits node_start/node_delta/node_complete per node, then run_complete last", async () => {
    const runId = await planRunFor(
      [mkNode("x", workerId), mkNode("y", workerId)],
      "ws-auto-envelope",
    );
    const res = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/runs/${runId}/auto`,
      payload: { stream: true, acceptReviews: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.body);
    const kinds = events.map((e) => `${e.event}:${e.data.nodeId ?? ""}`);

    // envelope per node: start before its complete, deltas keyed in between
    for (const nodeId of ["x", "y"]) {
      const startIdx = kinds.indexOf(`node_start:${nodeId}`);
      const completeIdx = kinds.indexOf(`node_complete:${nodeId}`);
      expect(startIdx, `node_start for ${nodeId}`).toBeGreaterThan(-1);
      expect(completeIdx, `node_complete for ${nodeId}`).toBeGreaterThan(startIdx);
      const deltas = events.filter((e) => e.event === "node_delta" && e.data.nodeId === nodeId);
      expect(deltas.length).toBeGreaterThanOrEqual(1);
      for (const d of deltas) expect(typeof d.data.text).toBe("string");
      const complete = events[completeIdx]!.data as {
        status: string;
        usage: { inputTokens: number; outputTokens: number };
      };
      expect(complete.status).toBe("accepted");
      expect(complete.usage.outputTokens).toBeGreaterThan(0);
    }
    // node_start names the executing agent — the envelope's routing disclosure
    const start = events.find((e) => e.event === "node_start")!;
    expect(start.data.agent).toBe(workerId);
    // every delta is keyed to a node the envelope introduced
    for (const d of events.filter((e) => e.event === "node_delta")) {
      expect(["x", "y"]).toContain(d.data.nodeId);
    }
    // run_complete is ALWAYS the last event and reports the honest outcome
    const last = events[events.length - 1]!;
    expect(last.event).toBe("run_complete");
    expect(last.data.status).toBe("completed");
    expect(last.data.stoppedReason).toBe("completed");
    expect(last.data.dispatched).toBe(2);
    expect(last.data.measuredSpentUsd as number).toBeGreaterThan(0);
  });
});

describe("block-mode PII projects never stream (ADR-0019 §8.4, disclosed)", () => {
  let blockProject: string;

  beforeAll(async () => {
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
      payload: { tag: "ws-block", piiMode: "block" },
    });
    const p = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "ws-block-proj", classifications: ["ws-block"] },
    });
    blockProject = p.json().id;
    const m = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${blockProject}/members`,
      payload: { userId: umaId, role: "contributor" },
    });
    expect(m.statusCode).toBe(201);
  });

  it("node dispatch with stream:true returns buffered JSON with streamingSuppressed — and audits it", async () => {
    const runId = await planRunFor([mkNode("n1", workerId)], "ws-block-node", blockProject);
    await startNode(runId, "n1");

    const res = await app.inject({
      method: "POST", headers: umaAuth,
      url: `/v1/runs/${runId}/nodes/n1/dispatch`,
      payload: { stream: true, input: "buffered because block-mode" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-type"]).not.toContain("event-stream");
    expect(res.body).not.toContain("event:");
    const body = res.json();
    expect(body.streamingSuppressed).toBe(true);
    expect(body.dispatch.outputText.length).toBeGreaterThan(0);

    // disclosed in the audit trail too, never silent
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, runId), eq(auditLog.ruleId, "stream-suppressed-block-project")));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.detail as { streamingSuppressed?: boolean }).streamingSuppressed).toBe(true);
  });

  it("auto-advance with stream:true runs the whole pass buffered with streamingSuppressed", async () => {
    const runId = await planRunFor([mkNode("a", workerId)], "ws-block-auto", blockProject);
    const res = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/runs/${runId}/auto`,
      payload: { stream: true, acceptReviews: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).not.toContain("event:");
    const body = res.json();
    expect(body.streamingSuppressed).toBe(true);
    expect(body.status).toBe("completed");
    expect(body.stoppedReason).toBe("completed");
  });
});

describe("ledger parity — streamed usage lands in the SAME accounting as non-streamed", () => {
  it("identical dispatches (one streamed, one not) write equal-shape usage rows and equal measured spend", async () => {
    const INPUT = "summarize the ws ledger parity fixture";
    const runA = await planRunFor([mkNode("n1", workerId)], "ws-ledger-plain");
    await startNode(runA, "n1");
    const runB = await planRunFor([mkNode("n1", workerId)], "ws-ledger-stream");
    await startNode(runB, "n1");

    const plain = await app.inject({
      method: "POST", headers: umaAuth,
      url: `/v1/runs/${runA}/nodes/n1/dispatch`,
      payload: { input: INPUT },
    });
    expect(plain.statusCode).toBe(200);
    const streamed = await app.inject({
      method: "POST", headers: umaAuth,
      url: `/v1/runs/${runB}/nodes/n1/dispatch`,
      payload: { input: INPUT, stream: true },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");

    const all = await db.select().from(usageEvents);
    const rowFor = (runId: string) =>
      all.filter((r) => (r.detail as { runId?: string } | null)?.runId === runId);
    const [rowA] = rowFor(runA);
    const [rowB] = rowFor(runB);
    expect(rowFor(runA)).toHaveLength(1);
    expect(rowFor(runB)).toHaveLength(1);

    // equal SHAPE: the same set of populated columns — a streamed dispatch may
    // not record less (or more) than a buffered one
    const shape = (r: Record<string, unknown>) =>
      Object.keys(r).filter((k) => r[k] !== null && k !== "id" && k !== "createdAt").sort();
    expect(shape(rowB as Record<string, unknown>)).toEqual(shape(rowA as Record<string, unknown>));

    // equal MEASUREMENTS: same tokens, same cost, same served identity
    expect(rowB!.inputTokens).toBe(rowA!.inputTokens);
    expect(rowB!.outputTokens).toBe(rowA!.outputTokens);
    expect(rowB!.costUsd).toBe(rowA!.costUsd);
    expect(rowA!.costUsd).toBeGreaterThan(0);
    expect(rowB!.agentId).toBe(rowA!.agentId);
    expect(rowB!.provider).toBe(rowA!.provider);
    expect(rowB!.model).toBe(rowA!.model);
    expect(rowB!.stopReason).toBe(rowA!.stopReason);
    expect(rowB!.refusal).toBe(rowA!.refusal);
    expect((rowB!.detail as { nodeId?: string }).nodeId).toBe("n1");
    expect((rowB!.detail as { credentialSource?: string }).credentialSource).toBe(
      (rowA!.detail as { credentialSource?: string }).credentialSource,
    );

    // and the run-level measured budget accumulated identically
    const [ra] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runA));
    const [rb] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runB));
    const spent = (r: typeof ra) =>
      ((r!.budget ?? null) as { measuredSpentUsd?: number } | null)?.measuredSpentUsd ?? 0;
    expect(spent(rb)).toBe(spent(ra));
    expect(spent(ra)).toBeGreaterThan(0);
  });
});
