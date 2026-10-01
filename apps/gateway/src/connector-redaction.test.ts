import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, connectorGrants, connectors, createDb, egressAllowHosts, eq, guardrailConfigs, runMigrations, sql, traceSpans, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import * as connectionEgress from "./connection-egress.js";
import { createGuardedFetch } from "./egress-guard.js";
import { prepareConnectorPiiAction } from "./connector-pii.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL required");
const AUTH = { authorization: "Bearer connector-redaction-test" };
const RUN = Math.random().toString(36).slice(2, 8);
const RAW = "alice@example.test";
let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: http.Server;
let baseUrl: string;
let userId: string;
let caller: { authorization: string };
let sequence = 0;
let calls: Array<{ url: string; payload: unknown }> = [];
let response: unknown = { text: RAW };
let upstreamStatus = 200;
let location: string | undefined;
let onCall: (() => Promise<void>) | undefined;
let previousAllow: typeof egressAllowHosts.$inferSelect | undefined;

async function post(url: string, payload: unknown) {
  const result = await app.inject({ method: "POST", url, headers: AUTH, payload: payload as Record<string, unknown> });
  expect(result.statusCode, `${url}: ${result.body}`).toBe(201);
  return result.json();
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  app = buildApp(db, { bootstrapToken: "connector-redaction-test", dataKey: "a".repeat(64) });
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => void (async () => {
      calls.push({ url: req.url!, payload: body ? JSON.parse(body) : null });
      if (onCall) await onCall();
      res.writeHead(upstreamStatus, { "content-type": "application/json", ...(location ? { location } : {}) }).end(JSON.stringify(response));
    })().catch(() => res.writeHead(500).end()));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  [previousAllow] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  await db.insert(egressAllowHosts).values({ host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true })
    .onConflictDoUpdate({ target: egressAllowHosts.host, set: { allowPrivateRanges: true, allowPlaintextHttp: true } });
  userId = (await post("/v1/users", { email: `connector-${RUN}@example.test`, displayName: "Connector tester", isAdmin: true })).id;
  caller = { authorization: `Bearer ${(await post(`/v1/users/${userId}/keys`, { name: "connector tests" })).token}` };
});

beforeEach(() => { calls = []; response = { text: RAW }; upstreamStatus = 200; onCall = undefined; location = undefined; });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (previousAllow) await db.update(egressAllowHosts).set(previousAllow).where(eq(egressAllowHosts.id, previousAllow.id));
  else await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  await app?.close();
  upstream?.closeAllConnections();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await db.$client.end();
});

async function fixture(mode = "redact", kind = "http") {
  const name = `connector_${RUN}_${++sequence}`;
  const connectorId = (await post("/v1/connectors", { name, kind: "data", providerKind: kind, baseUrl, pricePerCallUsd: 0.01 })).id as string;
  await post("/v1/grants/connectors", { userId, connectorId, mode: "readwrite", allowedObjects: ["records"] });
  await post("/v1/compliance/profiles", { tag: name, piiMode: "warn" });
  // Internal test policy only; the public mode is deliberately unavailable.
  const setMode = (value: string) => db.execute(sql`update compliance_profiles set pii_mode = ${value} where tag = ${name}`);
  await setMode(mode);
  const projectId = (await post("/v1/projects", { name, classifications: [name] })).id as string;
  const invoke = (payload: Record<string, unknown> = { text: RAW }, object = "records") => app.inject({
    method: "POST", url: `/v1/connectors/${connectorId}/invoke`, headers: caller,
    payload: { operation: "write", object, payload, projectId },
  });
  const evidence = async () => ({
    usage: await db.select().from(usageEvents).where(eq(usageEvents.connectorId, connectorId)),
    spans: await db.select().from(traceSpans).where(eq(traceSpans.connectorId, connectorId)),
    audit: await db.select().from(auditLog).where(eq(auditLog.objectId, connectorId)),
  });
  return { connectorId, projectId, invoke, evidence, setMode };
}

describe("connector redaction through the real route and HTTP adapter", () => {
  it.each(["http", "webhook"])("%s sends the effective payload, redacts the result and persists only safe content", async (kind) => {
    const f = await fixture("redact", kind);
    const result = await f.invoke({ text: RAW, nested: { value: RAW } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().result.body).toEqual({ text: "[EMAIL]" });
    expect(result.json().pii).toMatchObject({ mode: "redact", action: "redact", withheld: false });
    expect(calls).toHaveLength(1);
    const payload = kind === "webhook" ? (calls[0]!.payload as { payload: unknown }).payload : calls[0]!.payload;
    expect(payload).toEqual({ text: "[EMAIL]", nested: { value: "[EMAIL]" } });
    expect(calls[0]!.url).toBe(kind === "webhook" ? "/" : "/records");
    const evidence = await f.evidence();
    expect(evidence.usage).toHaveLength(1);
    expect(evidence.usage[0]!.costUsd).toBe(0.01);
    expect(evidence.spans).toHaveLength(1);
    expect(evidence.spans[0]!.inputPreview).toContain("[EMAIL]");
    expect(evidence.spans[0]!.outputPreview).toContain("[EMAIL]");
    expect(JSON.stringify(evidence)).not.toContain(RAW);
  });

  it("does not redirect sensitive routing identities or leak refused content", async () => {
    const f = await fixture();
    const result = await f.invoke({ text: RAW }, RAW);
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toBe("pii_transform_refused");
    expect(calls).toHaveLength(0);
    const evidence = await f.evidence();
    expect(evidence.usage).toHaveLength(0);
    expect(JSON.stringify([evidence, result.json()])).not.toContain(RAW);
  });

  it.each([{ [RAW]: "sensitive key" }, { value: 4111111111111111 }])("refuses unsafe JSON shapes before sending: %j", async (payload) => {
    const f = await fixture();
    const result = await f.invoke(payload);
    expect(result.json().error).toBe("pii_transform_refused");
    expect(calls).toHaveLength(0);
    expect((await f.evidence()).usage).toHaveLength(0);
  });

  it("keeps block mode's zero-call contract", async () => {
    const f = await fixture("block");
    expect((await f.invoke()).json().error).toBe("pii_blocked");
    expect(calls).toHaveLength(0);
    expect((await f.evidence()).usage).toHaveLength(0);
  });

  it.each(["alice", "EMAIL"])("guardrails inspect both original and effective input: %s", async (term) => {
    const f = await fixture();
    await db.insert(guardrailConfigs).values({ scope: "connector", scopeId: f.connectorId,
      semanticDlpMode: "block", customTerms: { semantic_dlp: [term] } });
    const result = await f.invoke();
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toBe("guardrail_blocked");
    expect(calls).toHaveLength(0);
    expect((await f.evidence()).usage).toHaveLength(0);
    expect(JSON.stringify(await f.evidence())).not.toContain(RAW);
  });

  it("a clean redacted payload still requires the caller's object grant", async () => {
    const f = await fixture();
    const result = await f.invoke({ text: RAW }, "other-records");
    expect(result.statusCode).toBe(403);
    expect(result.json().decision.effect).toBe("deny");
    expect(calls).toHaveLength(0);
    expect((await f.evidence()).usage).toHaveLength(0);
  });

  it("guardrails also inspect the effective output, not only the provider's original", async () => {
    const f = await fixture();
    await db.insert(guardrailConfigs).values({ scope: "connector", scopeId: f.connectorId,
      semanticDlpMode: "block", customTerms: { semantic_dlp: ["EMAIL"] } });
    const result = await f.invoke({ text: "clean" });
    expect(result.statusCode).toBe(200);
    expect(result.json().guardrails).toMatchObject({ action: "block", phase: "output", withheld: true });
    expect(result.json().result.body).not.toEqual({ text: "[EMAIL]" });
    expect(result.body).not.toContain(RAW);
    expect((await f.evidence()).usage).toHaveLength(1);
  });

  it.each(["block", "warn", "redact"])("a %s call withholds output when policy changes during the call", async (mode) => {
    const f = await fixture(mode);
    onCall = () => f.setMode(mode === "redact" ? "block" : "redact").then(() => {});
    const result = await f.invoke({ text: "clean input" });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ error: "connector_policy_changed", withheld: true, mayHaveExecuted: true, retrySafe: false, costUsd: 0.01 });
    expect(result.body).not.toContain(RAW);
    expect(calls).toHaveLength(1);
    const evidence = await f.evidence();
    expect(evidence.usage).toHaveLength(1);
    expect(evidence.spans[0]!.contentWithheld).toBe(true);
    expect(evidence.spans[0]!.inputPreview).toBeNull();
    expect(JSON.stringify(evidence)).not.toContain(RAW);
  });

  it("withholds untransformable completed output and still bills it", async () => {
    const f = await fixture();
    response = { [RAW]: "sensitive output key" };
    const result = await f.invoke();
    expect(result.statusCode).toBe(200);
    expect(result.json().pii.withheld).toBe(true);
    expect(result.body).not.toContain(RAW);
    expect((await f.evidence()).usage).toHaveLength(1);
    expect(JSON.stringify(await f.evidence())).not.toContain(RAW);
  });

  it("sanitizes upstream exception bodies under redaction", async () => {
    const f = await fixture();
    upstreamStatus = 500;
    const result = await f.invoke();
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain(RAW);
    expect(JSON.stringify(await f.evidence())).not.toContain(RAW);
    expect((await f.evidence()).usage).toHaveLength(0);
  });

  it("redirect refusal stays a governance decision without echoing its sensitive location", async () => {
    const f = await fixture();
    upstreamStatus = 302;
    location = `https://example.test/${RAW}`;
    const result = await f.invoke();
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toBe("egress_blocked");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify([result.json(), await f.evidence()])).not.toContain(RAW);
    expect((await f.evidence()).usage).toHaveLength(0);
  });

  it.each(["grant", "destination", "mode"])("rechecks %s immediately before the guarded transport sends", async (change) => {
    const f = await fixture();
    const original = connectionEgress.guardConnectionCall;
    vi.spyOn(connectionEgress, "guardConnectionCall").mockImplementation(async (...args) => {
      const guarded = await original(...args);
      const fetchImpl: typeof fetch = async (input, init) => {
        if (change === "grant") await db.delete(connectorGrants).where(eq(connectorGrants.connectorId, f.connectorId));
        else if (change === "destination") await db.update(connectors).set({ baseUrl: `${baseUrl}/changed` }).where(eq(connectors.id, f.connectorId));
        else await f.setMode("block");
        return guarded.fetchImpl(input, init);
      };
      return { ...guarded, fetchImpl };
    });
    const result = await f.invoke();
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ error: "connector_policy_changed", externalRequests: 0, mayHaveExecuted: false, retrySafe: true });
    expect(calls).toHaveLength(0);
    expect((await f.evidence()).usage).toHaveLength(0);
  });

  it("concurrent independent calls both use their own prepared payload", async () => {
    const f = await fixture();
    const results = await Promise.all([f.invoke({ text: RAW, label: "first" }), f.invoke({ text: "bob@example.test", label: "second" })]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(calls.map((c) => c.payload)).toEqual(expect.arrayContaining([
      { text: "[EMAIL]", label: "first" }, { text: "[EMAIL]", label: "second" },
    ]));
    expect((await f.evidence()).usage).toHaveLength(2);
  });

  it("withholds a response if activation lands after its content trace commits", async () => {
    const f = await fixture();
    // The repository wraps Db with proxies; spying and calling its original
    // transaction recursively re-enters the spy. Use the same wrapped factory
    // on a second pool against the SAME database for the actual transactions.
    const transactionDb = createDb(DATABASE_URL);
    const original = transactionDb.transaction.bind(transactionDb);
    let sawOutput = false;
    let changed = false;
    const wrapped: typeof db.transaction = (async (fn, config) => {
      const value = await original(fn, config);
      if (value && typeof value === "object" && "body" in value) sawOutput = true;
      else if (sawOutput && value === undefined && !changed) {
        changed = true;
        await f.setMode("block");
      }
      return value;
    }) as typeof db.transaction;
    try {
      vi.spyOn(db, "transaction").mockImplementation(wrapped);
      const result = await f.invoke();
      expect(changed).toBe(true);
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({ error: "connector_policy_changed", mayHaveExecuted: true, retrySafe: false, costUsd: 0.01 });
      const evidence = await f.evidence();
      expect(evidence.usage).toHaveLength(1);
      expect(evidence.spans.some((span) => span.status === "denied" && span.contentWithheld)).toBe(true);
      expect(JSON.stringify([result.json(), evidence])).not.toContain(RAW);
    } finally {
      vi.restoreAllMocks();
      await transactionDb.$client.end();
    }
  });
});

it("prepared invocation is frozen, with distinct binding for originals that redact equally", () => {
  const raw = { operation: "write" as const, object: "records", payload: { text: RAW } };
  const first = prepareConnectorPiiAction(null, raw, []);
  raw.payload.text = "changed";
  expect(first.invocation.payload).toEqual({ text: "[EMAIL]" });
  expect(Object.isFrozen(first.invocation.payload)).toBe(true);
  const second = prepareConnectorPiiAction(null, { ...raw, payload: { text: "bob@example.test" } }, []);
  expect(first.prepared.effectiveArgumentsDigest).toBe(second.prepared.effectiveArgumentsDigest);
  expect(first.prepared.argumentsDigest).not.toBe(second.prepared.argumentsDigest);
});

it("guarded-fetch admission runs after DNS validation and before transport", async () => {
  const steps: string[] = [];
  const transport = vi.fn(async () => new Response("safe"));
  const guarded = createGuardedFetch({ allowList: [{ host: "example.test", allowPrivateRanges: false, allowPlaintextHttp: false }],
    resolve: async () => { steps.push("dns"); return [{ address: "8.8.8.8", family: 4 }]; },
    beforeSend: async () => { steps.push("admission"); throw new Error("changed policy"); }, fetchImpl: transport });
  await expect(guarded("https://example.test/path")).rejects.toThrow("changed policy");
  expect(steps).toEqual(["dns", "admission"]);
  expect(transport).not.toHaveBeenCalled();
});
