import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, costEvents, createDb, eq, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * The most recent row by `at`.
 *
 * NEVER index a bare SELECT's result by position. Postgres does not promise
 * insertion order without an ORDER BY, and two CI failures in this repo came
 * from exactly that: a test read `rows[rows.length - 1]` as "the row just
 * written", passed locally for months, and failed the first time the physical
 * row order came back the other way round. Sorting by the column that actually
 * carries the ordering makes the assertion mean what it says.
 */
function latestRow<T extends { at: Date }>(rows: readonly T[]): T {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = sorted[sorted.length - 1];
  if (!last) throw new Error("latestRow: no rows");
  return last;
}


/**
 * §8.4 PII ENFORCEMENT (pillar 3) — the compliance cascade's piiMode turned
 * into a real enforcement point at every PROJECT-ATTRIBUTED model + connector
 * dispatch, plus audit-log retention pruning to the global floor.
 *
 * Proves:
 *   · block INPUT: a classified 'block' project denies a PII-bearing prompt
 *     BEFORE the provider runs — 403 pii_blocked, a 'pii-blocked' deny audit,
 *     and NO usage row (no cost incurred);
 *   · block OUTPUT: PII in the MODEL OUTPUT (the <<emit-ssn>> mock affordance)
 *     is BILL-AND-WITHHELD — a usage row IS written (honest spend) but the text
 *     is replaced by the withheld marker, and the audit deny names phase output;
 *   · warn: proceeds, attaches a pii warning + a 'pii-warned' allow audit;
 *   · log: proceeds silently, recording category COUNTS in the usage detail;
 *   · a non-classified project is unaffected (regression — no pii field);
 *   · connector INPUT block mirrors the model path;
 *   · retention: rows older than the GLOBAL floor prune, newer rows survive.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed pii-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "pii-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);

const SSN = "123-45-6789"; // well-known INVALID test SSN — never real PII

let db: Db;
let app: ReturnType<typeof buildApp>;
let danaId: string;
let danaAuth: { authorization: string };
let agentId: string;
let connectorId: string;
let blockProj: string;
let warnProj: string;
let logProj: string;
let plainProj: string;

async function makeUser(email: string, displayName: string, isAdmin: boolean) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName, isAdmin } });
  const id = u.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "pii" } });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function makeProject(name: string, classifications?: string[]) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: AUTH,
    payload: { name, ...(classifications ? { classifications } : {}) },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
async function invoke(input: string, projectId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: danaAuth,
    payload: { mode: "execute", input, dispatch: true, projectId },
  });
}
async function usageCount(projectId: string): Promise<number> {
  const rows = await db.select().from(usageEvents).where(eq(usageEvents.projectId, projectId));
  return rows.length;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const dana = await makeUser("pii-dana@example.com", "PII Dana", false);
  danaId = dana.id;
  danaAuth = dana.auth;

  const agent = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: "pii-mock", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  agentId = agent.json().id;
  await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: danaId, agentId } });

  const connector = await app.inject({
    method: "POST",
    url: "/v1/connectors",
    headers: AUTH,
    payload: { name: "pii-mock-conn", kind: "data", providerKind: "mock", pricePerCallUsd: 0.001 },
  });
  connectorId = connector.json().id;
  await app.inject({
    method: "POST",
    url: "/v1/grants/connectors",
    headers: AUTH,
    payload: { userId: danaId, connectorId, mode: "readwrite" },
  });

  // §8.3 compliance profiles the three modes cascade from
  for (const [tag, piiMode, auditRetentionDays] of [
    ["pii-block", "block", 90],
    ["pii-warn", "warn", null],
    ["pii-log", "log", null],
  ] as const) {
    await app.inject({
      method: "POST",
      url: "/v1/compliance/profiles",
      headers: AUTH,
      payload: { tag, piiMode, ...(auditRetentionDays ? { auditRetentionDays } : {}) },
    });
  }

  blockProj = await makeProject("pii-block-proj", ["pii-block"]);
  warnProj = await makeProject("pii-warn-proj", ["pii-warn"]);
  logProj = await makeProject("pii-log-proj", ["pii-log"]);
  plainProj = await makeProject("pii-plain-proj");
});

describe("§8.4 model dispatch PII enforcement", () => {
  it("block INPUT: denies a PII prompt BEFORE the provider — 403, deny audit, NO usage row", async () => {
    const before = await usageCount(blockProj);
    const res = await invoke(`Please export the record for SSN ${SSN}.`, blockProj);
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("pii_blocked");
    expect(body.pii.action).toBe("block");
    expect(body.pii.inputHits.some((h: { category: string }) => h.category === "ssn")).toBe(true);
    // no cost: the input block ran before any provider work
    expect(await usageCount(blockProj)).toBe(before);
    // a 'pii-blocked' deny is on the ledger for dana
    const denies = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, danaId), eq(auditLog.ruleId, "pii-blocked")));
    expect(denies.length).toBeGreaterThan(0);
    expect(denies.every((d) => d.effect === "deny")).toBe(true);
  });

  it("block OUTPUT: bills-and-withholds — usage row written, output withheld, deny names phase output", async () => {
    const before = await usageCount(blockProj);
    // <<emit-ssn>> is CLEAN input (no PII pattern) but the mock replies with a
    // fake SSN, so the OUTPUT check fires, not the input one
    const res = await invoke("Summarize the case notes. <<emit-ssn>>", blockProj);
    expect(res.statusCode).toBe(200);
    const d = res.json().dispatch;
    expect(d.pii.action).toBe("block");
    expect(d.pii.withheld).toBe(true);
    expect(d.pii.outputHits.some((h: { category: string }) => h.category === "ssn")).toBe(true);
    expect(d.outputText).toContain("output withheld");
    expect(d.outputText).toContain("ssn");
    expect(d.outputText).not.toContain(SSN); // the real value never rides the response
    // the spend is honest: exactly one new usage row
    expect(await usageCount(blockProj)).toBe(before + 1);
    // and the withheld usage row records COUNTS only, never the substring
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.projectId, blockProj));
    const latest = latestRow(rows);
    const detail = latest.detail as { pii?: { action: string; outputHits: unknown[] } };
    expect(detail.pii?.action).toBe("block");
    expect(JSON.stringify(detail)).not.toContain(SSN);
    // an OUTPUT-phase deny is recorded
    const denies = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, danaId), eq(auditLog.ruleId, "pii-blocked")));
    const outputPhase = denies.filter(
      (x) => (x.detail as { pii?: { phase?: string } }).pii?.phase === "output",
    );
    expect(outputPhase.length).toBeGreaterThan(0);
  });

  it("warn: proceeds, attaches a pii warning + a 'pii-warned' allow audit", async () => {
    const before = await usageCount(warnProj);
    const res = await invoke(`Draft a note referencing SSN ${SSN}.`, warnProj);
    expect(res.statusCode).toBe(200);
    const d = res.json().dispatch;
    expect(d.pii.action).toBe("warn");
    expect(d.pii.withheld).toBe(false);
    expect(d.pii.inputHits.some((h: { category: string }) => h.category === "ssn")).toBe(true);
    expect(await usageCount(warnProj)).toBe(before + 1); // proceeded, billed
    const warns = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, danaId), eq(auditLog.ruleId, "pii-warned")));
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.every((w) => w.effect === "allow")).toBe(true);
  });

  it("log: proceeds silently, recording category COUNTS in the usage detail", async () => {
    const before = await usageCount(logProj);
    const res = await invoke(`Note the SSN ${SSN} for the record.`, logProj);
    expect(res.statusCode).toBe(200);
    const d = res.json().dispatch;
    expect(d.pii.action).toBe("log");
    expect(d.pii.withheld).toBe(false);
    expect(d.outputText).not.toContain("output withheld"); // no user-visible change
    expect(await usageCount(logProj)).toBe(before + 1);
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.projectId, logProj));
    const detail = latestRow(rows).detail as { pii?: { action: string; inputHits: unknown[] } };
    expect(detail.pii?.action).toBe("log");
    expect(JSON.stringify(detail)).not.toContain(SSN); // counts only
  });

  it("regression: a non-classified project is unaffected — no pii field", async () => {
    const res = await invoke(`Handle SSN ${SSN} here.`, plainProj);
    expect(res.statusCode).toBe(200);
    const d = res.json().dispatch;
    expect(d.pii).toBeUndefined();
    expect(d.outputText).not.toContain("output withheld");
  });
});

describe("§8.4 connector PII enforcement", () => {
  it("connector INPUT block: a PII payload denies before the adapter runs — no usage row", async () => {
    const before = await usageCount(blockProj);
    const res = await app.inject({
      method: "POST",
      url: `/v1/connectors/${connectorId}/invoke`,
      headers: danaAuth,
      payload: { operation: "write", object: "records", payload: { note: `patient SSN ${SSN}` }, projectId: blockProj },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("pii_blocked");
    expect(body.pii.action).toBe("block");
    // decision was allow (governance), the PII deny is a SEPARATE row
    expect(body.decision.effect).toBe("allow");
    expect(await usageCount(blockProj)).toBe(before); // nothing billed
    const connDenies = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, danaId), eq(auditLog.ruleId, "pii-blocked")));
    expect(connDenies.some((x) => x.objectType === "connector")).toBe(true);
  });
});

describe("§8.4 audit-log retention pruning", () => {
  // three ancient rows (older than any realistic global floor) + one recent
  // marker; the prune deletes the ancient, keeps the marker
  const ancient = new Date(Date.now() - 30_000 * 24 * 3600 * 1000);
  let ancientIds: string[];
  let markerId: string;

  beforeAll(async () => {
    const ins = await db
      .insert(auditLog)
      .values(
        [0, 1, 2].map((i) => ({
          at: ancient,
          userId: danaId,
          objectType: "project" as const,
          detail: { phase: "pii-retention-fixture", i },
          effect: "allow" as const,
          ruleId: "pii-test-ancient",
          ruleChain: [],
          reason: "ancient fixture row for retention pruning",
        })),
      )
      .returning({ id: auditLog.id });
    ancientIds = ins.map((r) => r.id);
    const [marker] = await db
      .insert(auditLog)
      .values({
        userId: danaId,
        objectType: "project",
        detail: { phase: "pii-retention-marker" },
        effect: "allow",
        ruleId: "pii-test-recent",
        ruleChain: [],
        reason: "recent marker row that must survive the prune",
      })
      .returning({ id: auditLog.id });
    markerId = marker!.id;
  });

  it("GET /v1/audit/retention exposes the global floor and a prunable count", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/audit/retention", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(typeof b.retainedDays).toBe("number"); // a profile sets one
    expect(b.floorSource.length).toBeGreaterThan(0);
    expect(b.prunable).toBeGreaterThanOrEqual(3); // our three ancient rows
  });

  it("POST /v1/audit/prune deletes rows older than the floor and keeps newer ones", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/audit/prune", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.deleted).toBeGreaterThanOrEqual(3);
    expect(typeof b.retainedDays).toBe("number");
    // the ancient rows are gone
    for (const id of ancientIds) {
      const rows = await db.select().from(auditLog).where(eq(auditLog.id, id));
      expect(rows.length).toBe(0);
    }
    // the recent marker survives
    const marker = await db.select().from(auditLog).where(eq(auditLog.id, markerId));
    expect(marker.length).toBe(1);
    // the prune itself is audited (a keep-forever meta row)
    const meta = await db.select().from(auditLog).where(eq(auditLog.ruleId, "audit-log-pruned"));
    expect(meta.length).toBeGreaterThan(0);
  });
});

describe("§8.4 the semantic cache must not become a PII bypass", () => {
  // Found driving pillar 3 end-to-end: a cache HIT returned the cached output
  // and the request never reached dispatchAttempt, where the only PII gate
  // lived. So a PII prompt cached under an ungated (no-project) call was served
  // verbatim on a block-classified replay. These two tests pin that shut, and
  // are written to FAIL if the gates are removed (verified by reverting).

  it("a PII prompt cached with NO project is refused when replayed on a block project", async () => {
    const shared = `please summarise: my SSN is ${SSN}`;
    // 1. fill the cache under NO project — legitimately ungated
    const fill = await invokeCache(shared, undefined);
    expect(fill.statusCode).toBe(200);

    // 2. replay the identical prompt attributed to the block project
    const replay = await invokeCache(shared, blockProj);
    expect(replay.statusCode, "the cached PII prompt must NOT be served on a block project").toBe(403);
    expect(replay.json().error).toBe("pii_blocked");

    // NON-VACUOUS: the SAME prompt on a plain project still serves from cache,
    // so 403 is the gate biting, not the cache being broken.
    const plainReplay = await invokeCache(shared, plainProj);
    expect(plainReplay.statusCode).toBe(200);
  });

  it("a blocked cache replay writes NO estimate cost_events row for the project", async () => {
    const shared = `cache me: contact SSN ${SSN}`;
    await invokeCache(shared, undefined); // fill, ungated
    // DELTAS around the blocked replay, not absolute counts: earlier tests in
    // this file legitimately bill blockProj (the block-OUTPUT case writes a
    // usage row), so what this asserts is that the REFUSAL itself adds nothing.
    const costBefore = (
      await db.select().from(costEvents).where(eq(costEvents.projectId, blockProj))
    ).length;
    const usageBefore = await usageCount(blockProj);

    const replay = await invokeCache(shared, blockProj);
    expect(replay.statusCode).toBe(403);

    const costAfter = (
      await db.select().from(costEvents).where(eq(costEvents.projectId, blockProj))
    ).length;
    // the estimate ledger must not gain a phantom row for a call that was refused
    expect(costAfter, "a blocked call must not leave a semantic_caching estimate row").toBe(costBefore);
    // and no NEW measured spend either
    expect(await usageCount(blockProj), "a blocked call must not bill the project").toBe(usageBefore);
  });
});

async function invokeCache(input: string, projectId: string | undefined) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: danaAuth,
    payload: {
      mode: "execute",
      input,
      dispatch: true,
      semanticCache: true,
      ...(projectId ? { projectId } : {}),
    },
  });
}

describe("§8.4 the deployment-wide floor: omitting the project is no longer an exit", () => {
  // ADR-0021 amendment (owner decision, 2026-08-13). Before it,
  // `projectPiiMode(db, null)` returned null by design — so the SAME prompt
  // that a block project refused sailed through when the caller simply left
  // `projectId` off the body. One keystroke of omission undid the whole §8.4
  // gate. Now an unattributed dispatch resolves to the org defaultPiiMode:
  // 'none' (the shipped default) keeps old behaviour byte-identical, and an
  // org that sets 'block' gets a floor with no attribution dodge under it.

  const setFloor = async (mode: "none" | "log" | "warn" | "block") => {
    const r = await app.inject({
      method: "PUT", url: "/v1/org/settings", headers: AUTH,
      payload: { defaultPiiMode: mode },
    });
    expect(r.statusCode).toBe(200);
  };
  const invokeUnattributed = (input: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: danaAuth,
      payload: { mode: "execute", input, dispatch: true, ...extra },
    });

  afterAll(async () => {
    // org_settings is shared by every file after this one — leave it as found
    await setFloor("none");
  });

  it("floor unset (the default): an unattributed PII prompt still runs — old behaviour byte-identical", async () => {
    const r = await invokeUnattributed(`my SSN is ${SSN}, summarise this`);
    expect(r.statusCode).toBe(200);
  });

  it("floor 'block': the identical unattributed prompt is refused BEFORE the provider, audited without a projectId", async () => {
    await setFloor("block");
    const before = (await db.select().from(usageEvents).where(eq(usageEvents.userId, danaId))).length;

    const r = await invokeUnattributed(`my SSN is ${SSN}, summarise this floor-test`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("pii_blocked");

    // no model call, no bill
    const after = (await db.select().from(usageEvents).where(eq(usageEvents.userId, danaId))).length;
    expect(after, "a floor block must not bill the user").toBe(before);

    // the deny is in the one audit trail, and carries NO projectId — the
    // absence is the point: this row exists precisely because nothing else
    // governed the call
    const denies = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, danaId), eq(auditLog.ruleId, "pii-blocked"), eq(auditLog.effect, "deny")));
    const floorDeny = latestRow(denies);
    expect((floorDeny.detail as { projectId?: string }).projectId).toBeUndefined();

    // clean input still runs — the floor enforces a MODE, not a lockout
    const clean = await invokeUnattributed("nothing personal in here at all");
    expect(clean.statusCode).toBe(200);
  });

  it("floor 'block' closes the cache's remaining leg: fill ungated, replay STILL unattributed, refused", async () => {
    // The earlier cache fix stopped an ungated fill from serving an ATTRIBUTED
    // block-project replay. The leg it left open: fill ungated, replay ungated
    // — no project ever enters the picture, so only a floor can bite.
    await setFloor("none");
    const shared = `cache-under-no-floor: SSN ${SSN}`;
    expect((await invokeCache(shared, undefined)).statusCode).toBe(200); // fill, legitimately ungated

    await setFloor("block");
    const replay = await invokeCache(shared, undefined);
    expect(replay.statusCode, "the cached PII must not be served under the floor").toBe(403);
    expect(replay.json().error).toBe("pii_blocked");
  });

  it("floor 'warn': proceeds with the pii warning attached, never refused", async () => {
    await setFloor("warn");
    const r = await invokeUnattributed(`ssn ${SSN} in a warn-floor dispatch`);
    expect(r.statusCode).toBe(200);
    expect(r.json().dispatch.pii).toMatchObject({ mode: "warn", action: "warn" });
  });

  it("the connector path is under the same floor — the old ternary bypass is gone", async () => {
    await setFloor("block");
    const r = await app.inject({
      method: "POST",
      url: `/v1/connectors/${connectorId}/invoke`,
      headers: danaAuth,
      payload: { operation: "write", object: "records", payload: { note: `ssn ${SSN}` } }, // no projectId
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("pii_blocked");
  });

  it("a matched compliance framework still WINS over the floor — floor 'block' does not harden a warn project", async () => {
    await setFloor("block");
    // warnProj's cascade says warn; the floor never overrides a framework
    const r = await invoke(`ssn ${SSN} on the warn project under a block floor`, warnProj);
    expect(r.statusCode).toBe(200);
    expect(r.json().dispatch.pii).toMatchObject({ mode: "warn" });
  });

  it("floor 'block' suppresses an UNATTRIBUTED delta stream — buffered JSON, disclosed", async () => {
    // ADR-0019's rule, now under the floor: an output-phase block cannot decide
    // until it has the whole text, and SSE deltas would put raw model bytes on
    // the wire first. A block PROJECT already suppressed the stream; a block
    // FLOOR must do the same for the stream that names no project at all.
    await setFloor("block");
    const r = await invokeUnattributed("stream me something ordinary", { stream: true });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json"); // not SSE
    expect(r.json().streamingSuppressed).toBe(true);

    // floor off → the same request streams again (SSE), proving the
    // suppression above came from the floor and not from a broken stream path
    await setFloor("none");
    const streams = await invokeUnattributed("stream me something ordinary", { stream: true });
    expect(streams.statusCode).toBe(200);
    expect(streams.headers["content-type"]).toContain("text/event-stream");
  });

  it("a DANGLING projectId is refused at the attribution boundary — a made-up project is never an exit", async () => {
    await setFloor("block");
    const r = await invokeUnattributed(`ssn ${SSN} on a bogus project`, {
      projectId: "00000000-0000-4000-8000-000000000000",
    });
    // assertProjectAttribution 400s an unknown project before the PII
    // resolver runs, so this path can never reach a dispatch at all. The
    // resolver's own dangling→floor fallback is defense-in-depth behind this
    // gate, for any future call site that forgets the attribution check.
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_reference");
  });
});
