/**
 * ADR-0173 batch 2c (T) — traces as the evidence spine, through the real routes
 * against a real Postgres:
 *
 *  1. THE LIST USES THE SHARED FILTER, AND A NON-ADMIN IS SCOPED UNDER EVERY
 *     NEW FILTER. For each new filter a fixture trace of another user matches
 *     it; the non-admin's page and `total` never include it, and the admin's
 *     do (the control that makes the scoped result the rule, not the fixture).
 *  2. TAGS ARE WRITTEN ONLY BY THE OWNER OR AN ADMIN (403 + deny audit row),
 *     with the key pattern, the 256-char value, the 20-per-trace cap (also
 *     under concurrent writers) and the reserved `regulait.` prefix enforced.
 *  3. THE EXPORT PROFILE IS AN ENUM; the default profile carries the served
 *     model, agent and evaluation keys, the OpenInference profile adds the cost
 *     key, and with content capture off neither carries content.
 *
 * Global state: the org's OTLP endpoint/capture settings and one egress allow
 * row are set for section 3 and restored/removed in afterAll (M-068). Every
 * trace, user and agent this file creates is deleted there too.
 */
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  and,
  auditLog,
  createDb,
  desc,
  egressAllowHosts,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  traceEvaluations,
  traceSpans,
  traceTags,
  traces,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { recordTraceScore } from "./trace-scores.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const RUN = crypto.randomBytes(3).toString("hex");
const BOOT = "t2c-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
type Auth = { authorization: string };

let db: Db;
let app: ReturnType<typeof buildApp>;
let ana: { id: string; auth: Auth };
let boris: { id: string; auth: Auth };
let admin: { id: string; auth: Auth };
let agentId: string;
const createdUserIds: string[] = [];
const createdTraceIds: string[] = [];
let priorOrg: Record<string, unknown> | null = null;
let createdEgressRow: string | null = null;

const MODEL = `t2c-model-${RUN}`;
const SCORE = `t2c-score-${RUN}`;
const TAG = `t2c.team-${RUN}`;
const FILTER_AGENT = crypto.randomUUID();
const started = new Date("2026-09-15T10:00:00.000Z");

async function makeUser(name: string, isAdmin = false) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin },
  });
  expect(u.statusCode, JSON.stringify(u.json())).toBe(201);
  const id = u.json().id as string;
  createdUserIds.push(id);
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "t2c" } });
  expect(k.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

/** a trace that matches EVERY new filter: agent, model, cost, latency, score, flagged, tag */
async function richTrace(userId: string, label: string): Promise<string> {
  const [t] = await db
    .insert(traces)
    .values({
      kind: "dispatch",
      name: `t2c ${label} ${RUN}`,
      userId,
      status: "ok",
      startedAt: started,
      durationMs: 8_000,
      costUsd: 3,
      spanCount: 1,
    })
    .returning({ id: traces.id });
  const traceId = t!.id;
  createdTraceIds.push(traceId);
  const [s] = await db
    .insert(traceSpans)
    .values({ traceId, seq: 1, kind: "llm", name: "call", status: "ok", startedAt: started, agentId: FILTER_AGENT, model: MODEL })
    .returning({ id: traceSpans.id });
  await db.insert(traceEvaluations).values({
    spanId: s!.id,
    traceId,
    agentId: FILTER_AGENT,
    spanStartedAt: started,
    outcome: "evaluated",
    flagged: true,
  });
  await db.insert(traceTags).values({ traceId, key: TAG, value: "payments" });
  await recordTraceScore(db, { traceId, source: "annotation", name: SCORE, value: 0.9, sourceRefId: `t2c-${traceId}` });
  return traceId;
}

async function plainTrace(userId: string): Promise<string> {
  const [t] = await db
    .insert(traces)
    .values({ kind: "dispatch", name: `t2c plain ${RUN}`, userId, status: "ok", startedAt: started })
    .returning({ id: traces.id });
  createdTraceIds.push(t!.id);
  return t!.id;
}

let anaRich: string;
let borisRich: string;
let anaPlain: string;

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  await app.ready();
  const [prior] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorOrg = prior ? { ...prior } : null;
  // ADR-0181: trace content capture ships OFF. This file pins exported content
  // attributes, so it opts in before any trace is written; restored in afterAll.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { tracingCaptureContent: true }, interception: false, guardrails: false });
  ana = await makeUser("t2c-ana");
  boris = await makeUser("t2c-boris");
  admin = await makeUser("t2c-admin", true);
  anaRich = await richTrace(ana.id, "ana");
  borisRich = await richTrace(boris.id, "boris");
  anaPlain = await plainTrace(ana.id);
}, 120_000);

afterAll(async () => {
  await restoreSb1Posture?.();
  if (priorOrg) {
    await db
      .update(orgSettings)
      .set({
        tracingEnabled: priorOrg["tracingEnabled"] as boolean,
        tracingCaptureContent: priorOrg["tracingCaptureContent"] as boolean,
        tracingOtlpEndpoint: (priorOrg["tracingOtlpEndpoint"] ?? null) as string | null,
      })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  }
  if (createdEgressRow) await db.delete(egressAllowHosts).where(eq(egressAllowHosts.id, createdEgressRow));
  if (createdUserIds.length) await db.delete(traces).where(inArray(traces.userId, createdUserIds));
  if (createdTraceIds.length) {
    await db.delete(traceEvaluations).where(inArray(traceEvaluations.traceId, createdTraceIds));
    await db.delete(traces).where(inArray(traces.id, createdTraceIds));
  }
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  app.server.closeAllConnections();
  await app.close();
});

const list = (auth: Auth, qs: string) => app.inject({ method: "GET", url: `/v1/traces?limit=200&${qs}`, headers: auth });
const ids = (r: { json: () => { traces: Array<{ id: string }> } }) => r.json().traces.map((t) => t.id);

// ---------------------------------------------------------------------------

describe("1. the list takes the shared filter, and a non-admin is scoped under every one of them", () => {
  const FILTERS: Record<string, string> = {
    agentId: `agentId=${FILTER_AGENT}`,
    model: `model=${encodeURIComponent(MODEL)}`,
    "minCostUsd + minLatencyMs": `minCostUsd=2.5&minLatencyMs=7000&model=${encodeURIComponent(MODEL)}`,
    "scoreName + range": `scoreName=${SCORE}&scoreMin=0.5&scoreMax=1`,
    "flagged + tag": `flagged=true&tagKey=${TAG}&tagValue=payments`,
  };
  for (const [name, qs] of Object.entries(FILTERS)) {
    it(`${name}: ana sees only her own match and a total of 1; the admin sees both`, async () => {
      const mine = await list(ana.auth, qs);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(ids(mine)).toEqual([anaRich]);
      expect(mine.json().total, "the count must not see what the page cannot").toBe(1);
      expect(mine.json().scope).toBe("self");
      const fleet = await list(admin.auth, qs);
      expect(new Set(ids(fleet))).toEqual(new Set([anaRich, borisRich]));
      expect(fleet.json().total).toBe(2);
    });
  }

  it("a non-admin naming another user is refused, never silently narrowed", async () => {
    const r = await list(ana.auth, `userId=${boris.id}&model=${encodeURIComponent(MODEL)}`);
    expect(r.statusCode).toBe(403);
  });

  it("each row carries its tags; deniedOnly=false really means no constraint", async () => {
    const r = await list(ana.auth, "deniedOnly=false");
    expect(ids(r)).toEqual(expect.arrayContaining([anaRich, anaPlain]));
    const row = r.json().traces.find((t: { id: string }) => t.id === anaRich);
    expect(row.tags).toEqual([{ key: TAG, value: "payments" }]);
  });

  it("an invalid filter is a 400, not an ignored parameter", async () => {
    expect((await list(ana.auth, "scoreMin=1")).statusCode).toBe(400); // a range needs scoreName
    expect((await list(ana.auth, "tagKey=Not-Valid")).statusCode).toBe(400);
  });

  it("the tree carries the trace's tags and score name/value/label only", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/traces/${anaRich}`, headers: ana.auth });
    expect(r.statusCode).toBe(200);
    expect(r.json().tags).toEqual([{ key: TAG, value: "payments" }]);
    expect(r.json().scores).toEqual([{ spanId: null, source: "annotation", name: SCORE, value: 0.9, label: null }]);
  });
});

// ---------------------------------------------------------------------------

const putTag = (auth: Auth, traceId: string, key: string, value: string) =>
  app.inject({ method: "PUT", url: `/v1/traces/${traceId}/tags/${encodeURIComponent(key)}`, headers: auth, payload: { value } });

async function auditRows(userId: string, ruleId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.ruleId, ruleId)))
    .orderBy(desc(auditLog.at));
}

describe("2. tags — owner or admin only, and the shape rules", () => {
  it("the owner tags her trace (audited); another user is refused with a deny audit row; an admin may", async () => {
    const own = await putTag(ana.auth, anaPlain, "release", "2026.10");
    expect(own.statusCode, own.body).toBe(200);
    expect((await auditRows(ana.id, "trace-tag-set"))[0]?.objectId).toBe(anaPlain);

    const other = await putTag(boris.auth, anaPlain, "release", "hijacked");
    expect(other.statusCode).toBe(403);
    const denied = await auditRows(boris.id, "trace-tag-refused");
    expect(denied[0]?.effect).toBe("deny");
    expect(denied[0]?.objectId).toBe(anaPlain);

    const byAdmin = await putTag(admin.auth, anaPlain, "reviewed", "yes");
    expect(byAdmin.statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/v1/traces/${anaPlain}/tags/release`, headers: boris.auth });
    expect(del.statusCode).toBe(403);
    const tags = await db.select().from(traceTags).where(eq(traceTags.traceId, anaPlain));
    expect(Object.fromEntries(tags.map((t) => [t.key, t.value]))).toEqual({ release: "2026.10", reviewed: "yes" });

    const ownDel = await app.inject({ method: "DELETE", url: `/v1/traces/${anaPlain}/tags/reviewed`, headers: ana.auth });
    expect(ownDel.statusCode).toBe(200);
    expect((await auditRows(ana.id, "trace-tag-removed"))[0]?.objectId).toBe(anaPlain);
  });

  it("refuses a bad key, a reserved key and an over-long value", async () => {
    expect((await putTag(ana.auth, anaPlain, "Has-Upper", "x")).statusCode).toBe(400);
    expect((await putTag(ana.auth, anaPlain, "a".repeat(65), "x")).statusCode).toBe(400);
    expect((await putTag(ana.auth, anaPlain, "regulait.system", "x")).statusCode).toBe(400);
    expect((await putTag(ana.auth, anaPlain, "ok-key", "v".repeat(257))).statusCode).toBe(400);
    expect((await putTag(ana.auth, anaPlain, "ok-key", "v".repeat(256))).statusCode).toBe(200);
    const del = await app.inject({ method: "DELETE", url: `/v1/traces/${anaPlain}/tags/regulait.system`, headers: ana.auth });
    expect(del.statusCode).toBe(400);
  });

  it("caps a trace at 20 tags — including under concurrent writers", async () => {
    const t = await plainTrace(ana.id);
    for (let i = 0; i < 19; i++) expect((await putTag(ana.auth, t, `k${i}`, "v")).statusCode).toBe(200);
    // five writers race for the one remaining slot
    const racers = await Promise.all([0, 1, 2, 3, 4].map((i) => putTag(ana.auth, t, `race${i}`, "v")));
    expect(racers.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(racers.filter((r) => r.statusCode === 409).every((r) => r.json().error === "tag_limit")).toBe(true);
    expect(await db.$count(traceTags, eq(traceTags.traceId, t))).toBe(20);
    // updating an existing key at the cap is fine
    expect((await putTag(ana.auth, t, "k0", "changed")).statusCode).toBe(200);
  });

  it("the cap check waits for a concurrent writer's lock (deterministic interleaving)", async () => {
    const t = await plainTrace(ana.id);
    for (let i = 0; i < 19; i++) expect((await putTag(ana.auth, t, `k${i}`, "v")).statusCode).toBe(200);
    // writer A holds the trace row and adds the 20th tag, uncommitted
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const writerA = db.transaction(async (tx) => {
      await tx.select({ id: traces.id }).from(traces).where(eq(traces.id, t)).for("update");
      await tx.insert(traceTags).values({ traceId: t, key: "held", value: "v" });
      locked();
      await held;
    });
    await isLocked;
    // writer B: without the row lock it would count 19 committed tags and insert a 21st
    const writerB = putTag(ana.auth, t, "late", "v");
    await new Promise((r) => setTimeout(r, 400));
    release();
    await writerA;
    const r = await writerB;
    expect(r.statusCode, r.body).toBe(409);
    expect(await db.$count(traceTags, eq(traceTags.traceId, t))).toBe(20);
  });

  it("bulk: tags own traces, skips another's (audited) without saying it exists", async () => {
    const missing = crypto.randomUUID();
    const r = await app.inject({
      method: "POST",
      url: "/v1/traces/tags",
      headers: ana.auth,
      payload: { traceIds: [anaRich, borisRich, missing], key: "bulk", value: "one" },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().added).toBe(1);
    expect(r.json().skipped).toEqual([
      { id: borisRich, reason: "not_found_or_forbidden" },
      { id: missing, reason: "not_found_or_forbidden" },
    ]);
    const borisTags = await db.select().from(traceTags).where(and(eq(traceTags.traceId, borisRich), eq(traceTags.key, "bulk")));
    expect(borisTags).toEqual([]);
    const denied = await auditRows(ana.id, "trace-tag-refused");
    expect(denied[0]?.detail).toMatchObject({ traceIds: [borisRich] });
    // the admin may bulk-tag anyone's, and is told what does not exist
    const a = await app.inject({
      method: "POST",
      url: "/v1/traces/tags",
      headers: admin.auth,
      payload: { traceIds: [borisRich, missing], key: "bulk", value: "two" },
    });
    expect(a.json()).toMatchObject({ added: 1, skipped: [{ id: missing, reason: "not_found" }] });
  });
});

// ---------------------------------------------------------------------------

describe("3. export profiles", () => {
  let traceId: string;
  const NONCE = `t2c-nonce-${RUN}`;

  beforeAll(async () => {
    // a real governed dispatch: a mock agent that reports serving a different model
    const a = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: `t2c-agent-${RUN}`, provider: "mock", model: "t2c-asked", tier: 1, costPerMTokIn: 3, costPerMTokOut: 7 },
    });
    expect(a.statusCode, a.body).toBe(201);
    agentId = a.json().id as string;
    const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: ana.id, agentId } });
    expect(g.statusCode, g.body).toBe(201);
    const inv = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: ana.auth,
      payload: { mode: "execute", input: `${NONCE} <<serve-as:t2c-served>>`, dispatch: true },
    });
    expect(inv.statusCode, inv.body).toBe(200);
    traceId = inv.json().dispatch.trace.traceId as string;
    const [span] = await db.select().from(traceSpans).where(and(eq(traceSpans.traceId, traceId), eq(traceSpans.kind, "llm")));
    await recordTraceScore(db, { traceId, spanId: span!.id, source: "evaluator", name: "t2c-eval", value: 1, label: "pass", sourceRefId: `t2c-eval-${RUN}` });

    // an endpoint the guard allows (loopback, explicitly opted in); dry runs only
    const [eg] = await db
      .insert(egressAllowHosts)
      .values({ host: "127.0.0.42", allowPrivateRanges: true, allowPlaintextHttp: true, note: "t2c test" })
      .onConflictDoNothing()
      .returning({ id: egressAllowHosts.id });
    createdEgressRow = eg?.id ?? null;
    await db
      .update(orgSettings)
      .set({ tracingOtlpEndpoint: "http://127.0.0.42:4318/v1/traces", tracingCaptureContent: true })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  const dryRun = (profile?: string) =>
    app.inject({
      method: "POST",
      url: "/v1/tracing/export",
      headers: admin.auth,
      payload: { dryRun: true, traceIds: [traceId], ...(profile ? { profile } : {}) },
    });
  type Attr = { key: string; value: Record<string, unknown> };
  const llmAttrs = (body: Record<string, unknown>) => {
    const spans = (((body["resourceSpans"] as Array<Record<string, unknown>>)[0]!["scopeSpans"] as Array<Record<string, unknown>>)[0]!["spans"]) as Array<{ attributes: Attr[]; events?: Array<{ name: string; attributes: Attr[] }> }>;
    const llm = spans.find((s) => s.attributes.some((a) => a.key === "regulait.span.kind" && a.value["stringValue"] === "llm"))!;
    return { attrs: Object.fromEntries(llm.attributes.map((a) => [a.key, Object.values(a.value)[0]])), events: llm.events ?? [] };
  };

  it("profile is an enum: anything else is a 400", async () => {
    const r = await dryRun("zipkin");
    expect(r.statusCode).toBe(400);
  });

  it("otel_genai (default): served model, provider name, agent, finish reasons, evaluation event; no OpenInference cost key", async () => {
    const r = await dryRun();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().profile).toBe("otel_genai");
    const { attrs, events } = llmAttrs(r.json().body);
    expect(attrs["gen_ai.request.model"]).toBe("t2c-asked");
    expect(attrs["gen_ai.response.model"], "the SERVED model, from usage_events").toBe("t2c-served");
    expect(attrs["gen_ai.provider.name"]).toBe("mock");
    expect(attrs["gen_ai.system"]).toBe("mock");
    expect(attrs["gen_ai.agent.id"]).toBe(agentId);
    expect(attrs["gen_ai.agent.name"]).toBe(`t2c-agent-${RUN}`);
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual({ values: [{ stringValue: "end_turn" }] });
    expect(JSON.parse(attrs["gen_ai.input.messages"] as string)[0].parts[0].content).toContain(NONCE);
    expect(attrs["llm.cost.total"]).toBeUndefined();
    expect(events.map((e) => e.name)).toEqual(["gen_ai.evaluation.result"]);
  });

  it("openinference: adds the OpenInference keys and llm.cost.total", async () => {
    const r = await dryRun("openinference");
    expect(r.statusCode, r.body).toBe(200);
    const { attrs } = llmAttrs(r.json().body);
    expect(attrs["openinference.span.kind"]).toBe("LLM");
    expect(attrs["llm.model_name"]).toBe("t2c-served");
    expect(typeof attrs["llm.cost.total"]).toBe("number");
  });

  it("with content capture off, neither profile carries any content", async () => {
    await db.update(orgSettings).set({ tracingCaptureContent: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    for (const p of ["otel_genai", "openinference"]) {
      const r = await dryRun(p);
      expect(r.statusCode).toBe(200);
      const wire = JSON.stringify(r.json().body);
      expect(wire, p).not.toContain(NONCE);
      expect(wire, p).not.toMatch(/gen_ai\.(input|output)\.messages|"(input|output)\.value"|llm\.(input|output)_messages/);
    }
    await db.update(orgSettings).set({ tracingCaptureContent: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  it("the config states the profiles and the pinned versions", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tracing/config", headers: admin.auth });
    expect(r.json().profiles).toEqual(["otel_genai", "openinference"]);
    expect(r.json().standards.otelSemanticConventions).toBe("1.43.0");
  });
});
