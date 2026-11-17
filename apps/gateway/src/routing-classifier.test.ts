/**
 * ADR-0353 part 2 — the pluggable routing classifier, end to end.
 *
 * The external-scorers.test.ts pattern: a REAL local HTTP scorer speaking the ADR-0088 contract, the REAL register →
 * test → enable lifecycle and the REAL egress guard (127.0.0.1 allow-listed with private ranges and plaintext, removed
 * in afterAll through the cleanup module, M-068).
 *
 * What it proves:
 *  1. OFF BY DEFAULT: with no scorer configured the heuristic decides and the scorer is never called.
 *  2. THE SETTING IS VALIDATED: an unknown scorer, one that does not claim `routing_complexity`, and a disabled one
 *     are each refused with 422 and nothing saved; naming a valid one is a stepped-up relaxation.
 *  3. THE SCORE DECIDES THE COMPLEXITY, over the exact ADR-0088 wire shape.
 *  4. FAIL SAFE: an HTTP 500, a non-conforming reply, a hang past the bound and a scorer disabled after it was
 *     configured each fall back to the heuristic with a reason, and a non-2xx body never reaches the reason.
 *  5. THE AUDIT ROW: a classified dispatch writes one `routing-classified` row with the scorer, score and decision.
 *
 * SHARED-STATE DISCIPLINE: every object is `rc-` prefixed; the org setting is restored in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, desc, eq, externalScorers, orgSettings, runMigrations, type Db } from "@regulait/db";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";

const { buildApp } = await import("./app.js");
const { auditRoutingClassification, classifyForRouting, ROUTING_CLASSIFIED_RULE_ID } = await import("./routing-classifier.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "rc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
const NIL_USER = "00000000-0000-0000-0000-000000000000";

let db: Db;
let app: ReturnType<typeof buildApp>;
let srv: http.Server;
let port: number;
let loopbackId: string | undefined;
let classifierId: string;
let judgeOnlyId: string;
let storedBefore: string | null = null;

const hits: Array<Record<string, unknown>> = [];
let mode: "ok" | "http500" | "nonconforming" | "hang" = "ok";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const [org] = await db.select({ id: orgSettings.routingClassifierScorerId }).from(orgSettings);
  storedBefore = org?.id ?? null;
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (mode === "hang") return;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      hits.push(body);
      if (mode === "http500") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`echo of the prompt: ${String(body.input)}`);
        return;
      }
      const input = String(body.input ?? "");
      const score = mode === "nonconforming" ? "high" : input.includes("<<rc-hard>>") ? 0.9 : input.includes("<<rc-mid>>") ? 0.5 : 0.1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ score }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  port = (srv.address() as { port: number }).port;

  // egress-allow-cleanup: afterAll — the loopback entry this file shares; afterAll removes it by its id
  const allow = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      url: "/v1/egress-allow-hosts",
      headers: AUTH,
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "rc local routing classifier" },
    }),
  );
  expect([200, 201]).toContain(allow.statusCode);
  loopbackId = (allow.json() as { id: string }).id;

  const register = async (name: string, scorerKinds: string[]) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/external-scorers",
      headers: AUTH,
      payload: { name, baseUrl: `http://127.0.0.1:${port}/score`, scorerKinds, allowPlaintextHttp: true },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  };
  classifierId = await register("rc-classifier", ["routing_complexity"]);
  judgeOnlyId = await register("rc-judge-only", ["llm_as_judge"]);
});

afterAll(async () => {
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackId });
  try {
    await db.update(orgSettings).set({ routingClassifierScorerId: storedBefore });
    for (const id of [classifierId, judgeOnlyId]) {
      if (id) await app.inject({ method: "DELETE", url: `/v1/external-scorers/${id}`, headers: AUTH });
    }
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    await app.close();
  } finally {
    loopback.assertRemoved();
  }
});

const putClassifier = (id: string | null) =>
  relaxStepUpAround(db, () =>
    app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { routingClassifierScorerId: id } }),
  );

describe("ADR-0353 part 2: the pluggable routing classifier", () => {
  it("is off by default: the heuristic decides and the scorer is never called", async () => {
    const before = hits.length;
    const c = await classifyForRouting(db, DATA_KEY, { routingClassifierScorerId: null }, "<<rc-hard>> hi");
    expect(c).toMatchObject({ source: "heuristic", complexity: "low", scorerId: null });
    expect(hits.length).toBe(before);
  });

  it("refuses an unknown, a kind-mismatched and a disabled scorer, and saves nothing", async () => {
    const unknown = await putClassifier("11111111-1111-4111-8111-111111111111");
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: "routing_classifier_invalid" });
    const mismatched = await putClassifier(judgeOnlyId);
    expect(mismatched.statusCode).toBe(422);
    expect(String(mismatched.json().detail)).toContain("routing_complexity");
    const disabled = await putClassifier(classifierId);
    expect(disabled.statusCode).toBe(422);
    expect(String(disabled.json().detail)).toContain("not enabled");
    const [org] = await db.select({ id: orgSettings.routingClassifierScorerId }).from(orgSettings);
    expect(org?.id ?? null).toBe(storedBefore);
  });

  it("accepts an enabled routing_complexity scorer, after its connection test", async () => {
    const tested = await app.inject({ method: "POST", url: `/v1/external-scorers/${classifierId}/test`, headers: AUTH });
    expect(tested.statusCode).toBe(200);
    const enabled = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", url: `/v1/external-scorers/${classifierId}/enabled`, headers: AUTH, payload: { enabled: true } }),
    );
    expect(enabled.statusCode).toBe(200);
    const saved = await putClassifier(classifierId);
    expect(saved.statusCode).toBe(200);
    const [org] = await db.select({ id: orgSettings.routingClassifierScorerId }).from(orgSettings);
    expect(org?.id).toBe(classifierId);
  });

  it("lets the score decide the complexity, over the ADR-0088 wire shape", async () => {
    mode = "ok";
    const org = { routingClassifierScorerId: classifierId };
    // a short prompt the heuristic calls low, which the classifier says is hard
    const hard = await classifyForRouting(db, DATA_KEY, org, "<<rc-hard>> hi");
    expect(hard).toMatchObject({ source: "external", complexity: "high", score: 0.9, scorerName: "rc-classifier" });
    expect(hits.at(-1)).toEqual({ input: "<<rc-hard>> hi", output: "", context: [], scorerKind: "routing_complexity" });
    expect((await classifyForRouting(db, DATA_KEY, org, "<<rc-mid>>")).complexity).toBe("medium");
    expect((await classifyForRouting(db, DATA_KEY, org, "x".repeat(5000))).complexity).toBe("low");
  });

  it("falls back to the heuristic on an HTTP 500, without the reply body in the reason", async () => {
    mode = "http500";
    try {
      const c = await classifyForRouting(db, DATA_KEY, { routingClassifierScorerId: classifierId }, "<<rc-hard>> secret-prompt");
      expect(c).toMatchObject({ source: "heuristic-fallback", complexity: "low", score: null });
      expect(c.fallbackReason).toContain("HTTP 500");
      expect(c.fallbackReason).not.toContain("secret-prompt");
    } finally {
      mode = "ok";
    }
  });

  it("falls back on a non-conforming reply and on a hang past the bound", async () => {
    mode = "nonconforming";
    try {
      const c = await classifyForRouting(db, DATA_KEY, { routingClassifierScorerId: classifierId }, "<<rc-hard>>");
      expect(c.source).toBe("heuristic-fallback");
      expect(c.fallbackReason).toContain("non-conforming");
      mode = "hang";
      const started = Date.now();
      const h = await classifyForRouting(db, DATA_KEY, { routingClassifierScorerId: classifierId }, "<<rc-hard>>", { timeoutMs: 200 });
      expect(h.source).toBe("heuristic-fallback");
      expect(h.fallbackReason).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      mode = "ok";
      srv.closeAllConnections();
    }
  });

  it("does not use a scorer disabled after it was configured", async () => {
    await db.update(externalScorers).set({ enabled: false }).where(eq(externalScorers.id, classifierId));
    try {
      const before = hits.length;
      const c = await classifyForRouting(db, DATA_KEY, { routingClassifierScorerId: classifierId }, "<<rc-hard>>");
      expect(c.source).toBe("heuristic-fallback");
      expect(c.fallbackReason).toContain("not enabled");
      expect(hits.length).toBe(before);
    } finally {
      await db.update(externalScorers).set({ enabled: true }).where(eq(externalScorers.id, classifierId));
    }
  });

  it("records a classified routing decision in the audit, and nothing when no classifier is configured", async () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    const routing = { effect: "routed" as const, selectedAgentId: "cheap", baselineAgentId: agentId, ruleId: "cheapest-eligible" as const };
    const classification = await classifyForRouting(db, DATA_KEY, { routingClassifierScorerId: classifierId }, "<<rc-mid>>");
    await auditRoutingClassification(db, { userId: NIL_USER, requestedAgentId: agentId, projectId: null, classification, routing, surface: "invoke" });
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, agentId), eq(auditLog.ruleId, ROUTING_CLASSIFIED_RULE_ID)))
      .orderBy(desc(auditLog.at));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({
      phase: "routing",
      complexity: "medium",
      classifier: { source: "external", scorerId: classifierId, scorerName: "rc-classifier", score: 0.5 },
      routing: { effect: "routed", requestedAgentId: agentId, selectedAgentId: "cheap", ruleId: "cheapest-eligible" },
    });
    const heuristic = await classifyForRouting(db, DATA_KEY, { routingClassifierScorerId: null }, "hi");
    await auditRoutingClassification(db, { userId: NIL_USER, requestedAgentId: agentId, projectId: null, classification: heuristic, routing, surface: "invoke" });
    const after = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.objectId, agentId), eq(auditLog.ruleId, ROUTING_CLASSIFIED_RULE_ID)));
    expect(after).toHaveLength(1);
  });
});
