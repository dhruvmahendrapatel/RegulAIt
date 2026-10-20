/**
 * ADR-0193 (I4) P0 and P1 on a real database through the real app (migration 0206):
 *  - MIGRATION 0206: the provenance records are append-only (UPDATE, DELETE and TRUNCATE refused) and the digest CHECK
 *    refuses a plain digest of content that was not scanned clean; the write floor row is seeded `trusted`.
 *  - P0: a governed MCP tool result is recorded before delivery: a provenance audit row whose detail carries the label
 *    (covered by the chain) and a record naming it and the decision. Unscanned content gets a keyed digest under the
 *    per-tenant key that round-trips with the key and never shows the plaintext; content scanned clean gets a plain
 *    SHA-256 that round-trips.
 *  - P1: every source is `untrusted` by default; a write in a causal context holding untrusted (or, under the default
 *    floor, standard) content is refused before the upstream is contacted, audited under `content-trust-floor`; a read
 *    never is; a fresh context is not; a source raised to `trusted` lets a new context write; demoting a source takes
 *    effect for content already in a context, promoting one does not.
 *  - THE CONNECTOR PATH (review F1): a connector result is recorded inside the call's evidence transaction (a failure
 *    to record rolls the usage row back and delivers nothing); a connector write after a connector read in one builder
 *    thread is refused before the provider, audited. (The builder loop's own thread context is in builder-tools.test.ts.)
 *  - THE PROTOCOL METHODS (review F2): a `resources/read` result is recorded under the method's name.
 *  - THE ROUTES: changing a tier, either way, and the write floor needs a `settings_relax` step-up and is audited.
 *
 * Shared database (M-068): step-up is relaxed only inside the helper that says so and put back in `finally`; every
 * assertion is scoped by this run's server, contexts and ids. The write floor is put back to `trusted` in `finally`.
 */
import http from "node:http";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  auditLog,
  contentDigestKeys,
  contentProvenanceRecords,
  contentTrustSettings,
  contentTrustTiers,
  createDb,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import { builderThreadContextId, contentMatchesDigest, runContextId, type ContentProvenanceLabel } from "@regulait/shared";
import { buildApp } from "./app.js";
import { runGovernedTool, type ToolEntry, type ToolRunContext } from "./builder-tools.js";
import { executeGovernedConnectorCall } from "./connector-call.js";
import { contentDigestKey } from "./content-provenance.js";
import { executeGovernedProtocolCall } from "./mcp-protocol.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { dataKeyFingerprint, FINGERPRINT_PREFIX } from "./secrets.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpAround, relaxStepUpForTest } from "./testing/step-up-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `cp-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
const READ = `cp_read_${RUN}`;
const CLEAN = `cp_clean_${RUN}`;
const WRITE = `cp_write_${RUN}`;
const EMAIL = `jane.${RUN}@example.com`;
const PROFILE_TAG = `cp-log-${RUN}`;
const RESOURCE_URI = `file:///cp/${RUN}.md`;

const hits = { write: 0 };
/** every request the connector's provider received */
const providerHits: string[] = [];
let connectorId: string;
let connectorClose: () => Promise<void>;
let loopbackAllowHostId: string | undefined;
let priorMethods: string[] = [];
let db: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let userId: string;
let adminAuth: { authorization: string };
const restores: Array<() => Promise<void>> = [];

const errorOf = async (p: Promise<unknown>) =>
  p.then(
    () => "",
    (e: unknown) => String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""),
  );

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "cp-upstream", version: "0.0.1" });
        server.registerTool(READ, { description: "a read", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: `contact ${EMAIL}` }],
        }));
        server.registerTool(CLEAN, { description: "a read", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: "status ok" }],
        }));
        server.registerTool(WRITE, { description: "a write", inputSchema: {} }, async () => {
          hits.write++;
          return { content: [{ type: "text", text: "written" }] };
        });
        server.registerResource("cp-note", RESOURCE_URI, { mimeType: "text/markdown" }, async (uri) => ({
          contents: [{ uri: uri.href, text: "# a note" }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

/** a plain HTTP provider for the connector: counts every request it is sent */
async function startProvider(): Promise<{ url: string; close: () => Promise<void> }> {
  const s = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      providerHits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ records: [{ id: 1, status: "ok" }] }));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const a = s.address();
  if (typeof a !== "object" || !a) throw new Error("no address");
  return { url: `http://127.0.0.1:${a.port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

const call = (toolName: string, contextId: string | null, projectId: string | null = null) =>
  executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName, arguments: {}, contextId, projectId });

/** the connector as a builder agent's toolbox carries it */
const connectorEntry = (): ToolEntry => ({
  name: `connector__cp-${RUN}`,
  displayName: `cp-${RUN}`,
  kind: "connector",
  refId: connectorId,
  requiresApproval: false,
  provider: "http",
  def: { name: `connector__cp-${RUN}`, inputSchema: {} },
  operations: ["read", "write"],
});
const toolCtx = (contextId: string): ToolRunContext => ({
  userId,
  isAdmin: false,
  projectId: null,
  trace: null,
  toolCallId: randomUUID(),
  detail: {},
  contextId,
});
const connectorRecords = () =>
  db.select().from(contentProvenanceRecords).where(and(eq(contentProvenanceRecords.sourceKind, "connector"), eq(contentProvenanceRecords.sourceId, connectorId)));

const recordsOf = (contextId: string) => db.select().from(contentProvenanceRecords).where(eq(contentProvenanceRecords.contextId, contextId));

async function setTier(tier: "untrusted" | "standard" | "trusted") {
  const restore = await relaxStepUpForTest(db);
  try {
    const r = await app.inject({ method: "PUT", url: `/v1/content-trust/sources/mcp_server/${serverId}`, headers: adminAuth, payload: { tier } });
    expect(r.statusCode, r.body).toBe(200);
  } finally {
    await restore();
  }
}
async function setFloor(writeFloor: "standard" | "trusted") {
  const restore = await relaxStepUpForTest(db);
  try {
    const r = await app.inject({ method: "PUT", url: "/v1/content-trust/settings", headers: adminAuth, payload: { writeFloor } });
    expect(r.statusCode, r.body).toBe(200);
  } finally {
    await restore();
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false, requireProjectAttribution: false }));
  // an unattributed call is then unscanned (no org PII floor), the case the keyed digest exists for
  restores.push(await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: `cp-server-${RUN}`, url: up.url } });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  for (const [name, kind] of [[READ, "read"], [CLEAN, "read"], [WRITE, "write"]] as const) {
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: { name, kind } });
  }
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `cp-user-${RUN}@example.com`, displayName: `cp user ${RUN}` } });
  userId = u.json().id;
  for (const name of [READ, CLEAN, WRITE]) {
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName: name } });
  }
  const a = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `cp-admin-${RUN}@example.com`, displayName: `cp admin ${RUN}`, isAdmin: true } });
  expect(a.statusCode, a.body).toBe(201);
  const key = await app.inject({ method: "POST", url: `/v1/users/${a.json().id}/keys`, headers: AUTH, payload: { name: "cp" } });
  adminAuth = { authorization: `Bearer ${key.json().token}` };
  const profile = await app.inject({ method: "POST", headers: AUTH, url: "/v1/compliance/profiles", payload: { tag: PROFILE_TAG, piiMode: "log" } });
  expect(profile.statusCode, profile.body).toBe(201);
  // the connector: a plain HTTP provider on loopback (its own egress allow entry, removed in afterAll, M-068)
  const provider = await startProvider();
  connectorClose = provider.close;
  const allow = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts", payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: `cp suite ${RUN}: local doubles` } }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  loopbackAllowHostId = allow.json().id;
  const c = await app.inject({ method: "POST", headers: AUTH, url: "/v1/connectors", payload: { name: `cp-${RUN}`, kind: "data", providerKind: "http", baseUrl: provider.url } });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id;
  const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/connectors", payload: { userId, connectorId, mode: "readwrite" } });
  expect(g.statusCode, g.body).toBe(201);
  const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorMethods = (org?.mcpProtocolMethods ?? []) as string[];
}, 120_000);

afterAll(async () => {
  // M-068: the loopback allow entry goes first, while the app is open; its outcome is asserted after the rest
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackAllowHostId });
  try {
    await db.update(orgSettings).set({ mcpProtocolMethods: priorMethods as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await db.update(contentTrustSettings).set({ writeFloor: "trusted" }).where(eq(contentTrustSettings.id, 1));
    await db.delete(contentTrustTiers).where(eq(contentTrustTiers.sourceId, serverId));
    for (const r of restores.reverse()) await r();
    app.server.closeAllConnections();
    await app.close();
  } finally {
    await upstreamClose();
    await connectorClose?.();
    loopback.assertRemoved();
  }
});

// ---------------------------------------------------------------------------
describe("ADR-0193 migration 0206", () => {
  it("the write floor is seeded `trusted`", async () => {
    const [row] = await db.select().from(contentTrustSettings).where(eq(contentTrustSettings.id, 1));
    expect(row?.writeFloor).toBe("trusted");
  });

  it("a provenance record is append-only, and the CHECK refuses a plain digest of content not scanned clean", async () => {
    const ctx = runContextId(randomUUID());
    const out = await call(READ, ctx);
    expect(out.kind).toBe("allowed");
    const [rec] = await recordsOf(ctx);
    expect(rec).toBeDefined();
    expect(await errorOf(db.update(contentProvenanceRecords).set({ trustTier: "trusted" }).where(eq(contentProvenanceRecords.id, rec!.id)))).toMatch(/append-only/);
    expect(await errorOf(db.delete(contentProvenanceRecords).where(eq(contentProvenanceRecords.id, rec!.id)))).toMatch(/append-only/);
    const truncate = await errorOf(
      db.transaction(async (tx) => {
        await tx.execute(sql`truncate table content_provenance_records`);
        throw new Error("cp-rollback: the truncate went through");
      }),
    );
    expect(truncate).toMatch(/TRUNCATE refused \(append-only\)/);
    const plain = await errorOf(
      db.insert(contentProvenanceRecords).values({
        auditId: randomUUID(),
        decisionAuditId: randomUUID(),
        sourceKind: "mcp_server",
        sourceId: serverId,
        trustTier: "untrusted",
        classification: "pii",
        digestAlg: "sha256",
        upstreamDigest: "a".repeat(64),
        deliveredDigest: "a".repeat(64),
        label: { v: "regulait.content-provenance-label.v1" },
      }),
    );
    expect(plain).toMatch(/content_provenance_records_digest_check/);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0193 the content digest key (review R1 on PR #428)", () => {
  it("concurrent first uses of a data key create exactly one key row, inside a caller's transaction or not", async () => {
    // a data key no other test uses, so this test's marker has no row yet and every call below is a first use
    const dataKey = randomBytes(32).toString("hex");
    const marker = dataKeyFingerprint(dataKey).slice(FINGERPRINT_PREFIX.length);
    const ofMarker = sql`split_part(${contentDigestKeys.keyCiphertext}, '.', 4) = ${marker}`;
    expect(await db.select().from(contentDigestKeys).where(ofMarker)).toHaveLength(0);
    try {
      // half run inside a transaction of their own, as the connector path's evidence write does
      const keys = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0 ? contentDigestKey(db, dataKey) : db.transaction((tx) => contentDigestKey(tx as unknown as Db, dataKey)),
        ),
      );
      const rows = await db.select().from(contentDigestKeys).where(ofMarker);
      expect(rows).toHaveLength(1);
      expect(new Set(keys.map((k) => k!.id))).toEqual(new Set([rows[0]!.id]));
      expect(new Set(keys.map((k) => k!.bytes.toString("hex"))).size).toBe(1);
    } finally {
      const ids = (await db.select({ id: contentDigestKeys.id }).from(contentDigestKeys).where(ofMarker)).map((r) => r.id);
      if (ids.length) await db.delete(contentDigestKeys).where(inArray(contentDigestKeys.id, ids));
    }
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0193 P0: the label and digests of a governed tool result", () => {
  it("unscanned content: a keyed digest that round-trips with the tenant key and never shows the plaintext", async () => {
    const ctx = runContextId(randomUUID());
    const out = await call(READ, ctx);
    expect(out.kind).toBe("allowed");
    if (out.kind !== "allowed") return;
    const [rec] = await recordsOf(ctx);
    expect(rec).toMatchObject({ sourceKind: "mcp_server", sourceId: serverId, sourceDetail: READ, trustTier: "untrusted", classification: "unscanned", digestAlg: "hmac-sha256" });
    const key = await contentDigestKey(db, DATA_KEY);
    expect(rec!.digestKeyId).toBe(key!.id);
    expect(contentMatchesDigest(out.content, rec!.deliveredDigest!, "hmac-sha256", key!.bytes)).toBe(true);
    expect(contentMatchesDigest(out.content, rec!.upstreamDigest!, "hmac-sha256", key!.bytes)).toBe(true);
    // the evidence carries no content: neither the record nor its audit row names the address
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, rec!.auditId));
    expect(row).toMatchObject({ objectType: "content_provenance", objectId: rec!.id, ruleId: "content-provenance", effect: "allow" });
    expect(JSON.stringify(rec)).not.toContain(EMAIL);
    expect(JSON.stringify(row)).not.toContain(EMAIL);
    // the label rides the audit row (its content hash covers it) and names the decision that allowed the call
    const label = (row!.detail as { contentProvenance: ContentProvenanceLabel }).contentProvenance;
    expect(label).toEqual(rec!.label);
    expect(row!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const [decision] = await db.select().from(auditLog).where(eq(auditLog.id, rec!.decisionAuditId));
    expect(decision).toMatchObject({ toolName: READ, serverId, effect: "allow" });
  });

  it("content scanned clean (an attributed project under a log-mode profile): a plain SHA-256 that round-trips", async () => {
    const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: `cp-project-${RUN}` } });
    expect(p.statusCode, p.body).toBe(201);
    const projectId = p.json().id as string;
    await db.execute(sql`update projects set classifications = ${JSON.stringify([PROFILE_TAG])}::jsonb where id = ${projectId}`);
    const ctx = runContextId(randomUUID());
    const out = await call(CLEAN, ctx, projectId);
    expect(out.kind).toBe("allowed");
    if (out.kind !== "allowed") return;
    const [rec] = await recordsOf(ctx);
    expect(rec).toMatchObject({ classification: "clean", digestAlg: "sha256", digestKeyId: null });
    expect(contentMatchesDigest(out.content, rec!.deliveredDigest!, "sha256")).toBe(true);
    expect((rec!.label as ContentProvenanceLabel).transformed).toBe(false);
  });

  it("PII-bearing content (an attributed project under a log-mode profile): classified pii, a keyed digest", async () => {
    const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: `cp-pii-project-${RUN}` } });
    expect(p.statusCode, p.body).toBe(201);
    const projectId = p.json().id as string;
    await db.execute(sql`update projects set classifications = ${JSON.stringify([PROFILE_TAG])}::jsonb where id = ${projectId}`);
    const ctx = runContextId(randomUUID());
    const out = await call(READ, ctx, projectId);
    expect(out.kind).toBe("allowed");
    if (out.kind !== "allowed") return;
    const [rec] = await recordsOf(ctx);
    expect(rec).toMatchObject({ classification: "pii", digestAlg: "hmac-sha256" });
    const key = await contentDigestKey(db, DATA_KEY);
    expect(rec!.digestKeyId).toBe(key!.id);
    expect(contentMatchesDigest(out.content, rec!.deliveredDigest!, "hmac-sha256", key!.bytes)).toBe(true);
    expect(JSON.stringify(rec)).not.toContain(EMAIL);
  });

  it("with no data key there is no keyed digest: the record says `unavailable` and stores no digest", async () => {
    const ctx = runContextId(randomUUID());
    const out = await executeGovernedToolCall(db, undefined, { userId, serverId, toolName: READ, arguments: {}, contextId: ctx, projectId: null });
    expect(out.kind).toBe("allowed");
    const [rec] = await recordsOf(ctx);
    expect(rec).toMatchObject({ classification: "unscanned", digestAlg: "unavailable", digestKeyId: null, upstreamDigest: null, deliveredDigest: null });
  });

  it("the evidence view lists the record with its covering anchor (null until one covers it)", async () => {
    const ctx = runContextId(randomUUID());
    await call(READ, ctx);
    const r = await app.inject({ method: "GET", url: `/v1/content-provenance/records?contextId=${encodeURIComponent(ctx)}`, headers: adminAuth });
    expect(r.statusCode, r.body).toBe(200);
    const records = r.json().records as Array<{ contextId: string; anchor: unknown; digestAlg: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ contextId: ctx, digestAlg: "hmac-sha256" });
    expect(records[0]).toHaveProperty("anchor");
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0193 P1: the trust-tier policy in the decision path", () => {
  it("every source is untrusted by default", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/content-trust", headers: adminAuth });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ defaultTier: "untrusted", writeFloor: "trusted" });
    const mine = (r.json().sources as Array<{ sourceId: string; tier: string; explicit: boolean }>).find((s) => s.sourceId === serverId);
    expect(mine).toMatchObject({ tier: "untrusted", explicit: false });
  });

  it("a write after untrusted content in the same context is refused before the upstream is contacted, and audited", async () => {
    const ctx = runContextId(randomUUID());
    expect((await call(READ, ctx)).kind).toBe("allowed");
    const before = hits.write;
    const out = await call(WRITE, ctx);
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.decision).toMatchObject({ effect: "deny", ruleId: "content-trust-floor" });
    expect(hits.write).toBe(before);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "content-trust-floor"), eq(auditLog.toolName, WRITE)));
    const mine = rows.filter((r) => (r.detail as { contextId?: string }).contextId === ctx);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.detail).toMatchObject({ code: "content_trust_refused", lowestTier: "untrusted", writeFloor: "trusted", receiptClass: "decision" });
  });

  it("the negative controls: a read in that context, a write in a fresh context and a write with no context are not refused", async () => {
    const ctx = runContextId(randomUUID());
    await call(READ, ctx);
    expect((await call(READ, ctx)).kind).toBe("allowed");
    for (const c of [runContextId(randomUUID()), null]) {
      const before = hits.write;
      const out = await call(WRITE, c);
      expect(out.kind, JSON.stringify(out)).toBe("allowed");
      expect(hits.write).toBe(before + 1);
    }
  });

  it("raising the source to trusted lets a new context write; content observed while untrusted stays untrusted", async () => {
    const old = runContextId(randomUUID());
    await call(READ, old);
    await setTier("trusted");
    try {
      const fresh = runContextId(randomUUID());
      await call(READ, fresh);
      const [rec] = await recordsOf(fresh);
      expect(rec!.trustTier).toBe("trusted");
      const before = hits.write;
      const ok = await call(WRITE, fresh);
      expect(ok.kind, JSON.stringify(ok)).toBe("allowed");
      expect(hits.write).toBe(before + 1);
      const stale = await call(WRITE, old);
      expect(stale.kind === "denied" && stale.decision.ruleId).toBe("content-trust-floor");
      // demoting takes effect for content already in a context
      await setTier("untrusted");
      const demoted = await call(WRITE, fresh);
      expect(demoted.kind === "denied" && demoted.decision.ruleId).toBe("content-trust-floor");
    } finally {
      await setTier("untrusted");
    }
  });

  it("standard content may drive a write only once the floor is relaxed to standard", async () => {
    await setTier("standard");
    try {
      const ctx = runContextId(randomUUID());
      await call(READ, ctx);
      const refused = await call(WRITE, ctx);
      expect(refused.kind === "denied" && refused.decision.ruleId).toBe("content-trust-floor");
      await setFloor("standard");
      const before = hits.write;
      const ok = await call(WRITE, ctx);
      expect(ok.kind, JSON.stringify(ok)).toBe("allowed");
      expect(hits.write).toBe(before + 1);
    } finally {
      await setFloor("trusted");
      await setTier("untrusted");
    }
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0193 the connector path (review F1)", () => {
  it("P0: a connector result writes one provenance record and its audit row, naming the decision", async () => {
    const ctx = builderThreadContextId(randomUUID());
    const out = await executeGovernedConnectorCall(db, DATA_KEY, { userId, isAdmin: false, connectorId, operation: "read", object: "records", contextId: ctx });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const recs = await recordsOf(ctx);
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec).toMatchObject({ sourceKind: "connector", sourceId: connectorId, sourceDetail: "read:records", trustTier: "untrusted", classification: "unscanned", digestAlg: "hmac-sha256" });
    const key = await contentDigestKey(db, DATA_KEY);
    const delivered = (out.body as { result: { body: unknown } }).result.body;
    expect(contentMatchesDigest(delivered, rec.deliveredDigest!, "hmac-sha256", key!.bytes)).toBe(true);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "content_provenance"), eq(auditLog.objectId, rec.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: rec.auditId, ruleId: "content-provenance", effect: "allow" });
    expect((rows[0]!.detail as { contentProvenance: ContentProvenanceLabel }).contentProvenance).toEqual(rec.label);
    const [decision] = await db.select().from(auditLog).where(eq(auditLog.id, rec.decisionAuditId));
    expect(decision).toMatchObject({ objectType: "connector", objectId: connectorId, effect: "allow" });
    expect(JSON.stringify(rec)).not.toContain('"status":"ok"');
  });

  it("P0: the record is written in the evidence transaction: when it cannot be written, the usage row rolls back and nothing is delivered", async () => {
    const usageOf = async () => (await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.connectorId, connectorId))).length;
    const before = { usage: await usageOf(), records: (await connectorRecords()).length, hits: providerHits.length };
    // an unusable data key cannot key the (unscanned) result's digest, so recording throws after the provider ran
    const out = executeGovernedConnectorCall(db, "z".repeat(64), { userId, isAdmin: false, connectorId, operation: "read", object: "records" });
    await expect(out).rejects.toThrow();
    expect(providerHits.length).toBe(before.hits + 1);
    expect(await usageOf()).toBe(before.usage);
    expect((await connectorRecords()).length).toBe(before.records);
  });

  it("P1: a connector write after a connector read in one builder thread is refused before the provider, and audited", async () => {
    const ctx = builderThreadContextId(randomUUID());
    const read = await runGovernedTool(db, DATA_KEY, connectorEntry(), { operation: "read", object: "records" }, toolCtx(ctx));
    expect(read.status, read.detail ?? "").toBe("done");
    const before = providerHits.length;
    const write = await runGovernedTool(db, DATA_KEY, connectorEntry(), { operation: "write", object: "records", payload: { x: 1 } }, toolCtx(ctx));
    expect(write).toMatchObject({ status: "denied", code: "content_trust_refused" });
    expect(providerHits.length).toBe(before);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "content-trust-floor"), eq(auditLog.objectType, "connector"), eq(auditLog.objectId, connectorId)));
    const mine = rows.filter((r) => (r.detail as { contextId?: string }).contextId === ctx);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.detail).toMatchObject({ code: "content_trust_refused", lowestTier: "untrusted", writeFloor: "trusted", operation: "write", receiptClass: "decision" });
    // the control: the same write in a fresh thread reaches the provider
    const fresh = await runGovernedTool(db, DATA_KEY, connectorEntry(), { operation: "write", object: "records", payload: { x: 1 } }, toolCtx(builderThreadContextId(randomUUID())));
    expect(fresh.status, fresh.detail ?? "").toBe("done");
    expect(providerHits.length).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0193 P0: the MCP protocol methods (review F2)", () => {
  it("a resources/read result is recorded under the method's name, keyed, before it is delivered", async () => {
    await db.update(orgSettings).set({ mcpProtocolMethods: ["resources/read"] as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName: "mcp:resources" } });
    expect(g.statusCode, g.body).toBeLessThan(300);
    const out = await executeGovernedProtocolCall(db, { userId, serverId, method: "resources/read", params: { uri: RESOURCE_URI }, dataKey: DATA_KEY });
    expect(out.kind, JSON.stringify(out)).toBe("allowed");
    if (out.kind !== "allowed") return;
    const recs = await db
      .select()
      .from(contentProvenanceRecords)
      .where(and(eq(contentProvenanceRecords.sourceId, serverId), eq(contentProvenanceRecords.sourceDetail, "resources/read")));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ sourceKind: "mcp_server", contextId: null, classification: "unscanned", digestAlg: "hmac-sha256" });
    const key = await contentDigestKey(db, DATA_KEY);
    expect(contentMatchesDigest(out.result, recs[0]!.deliveredDigest!, "hmac-sha256", key!.bytes)).toBe(true);
    const [decision] = await db.select().from(auditLog).where(eq(auditLog.id, recs[0]!.decisionAuditId));
    expect(decision).toMatchObject({ toolName: "mcp:resources", serverId, effect: "allow" });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0193 P1: the routes need a step-up and are audited", () => {
  it("a tier change, either way, is refused without a step-up (nothing written) and audited with one", async () => {
    const refused = await app.inject({ method: "PUT", url: `/v1/content-trust/sources/mcp_server/${serverId}`, headers: adminAuth, payload: { tier: "trusted" } });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await db.select().from(contentTrustTiers).where(eq(contentTrustTiers.sourceId, serverId))).filter((t) => t.tier === "trusted")).toHaveLength(0);
    await setTier("standard");
    // lowering is a step-up too
    const lowered = await app.inject({ method: "PUT", url: `/v1/content-trust/sources/mcp_server/${serverId}`, headers: adminAuth, payload: { tier: "untrusted" } });
    expect(lowered.statusCode, lowered.body).toBe(403);
    await setTier("untrusted");
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "content-trust-tier-set"), eq(auditLog.objectId, serverId)));
    expect(audits.map((a) => (a.detail as { to: string }).to)).toEqual(expect.arrayContaining(["standard", "untrusted"]));
    const up = audits.find((a) => (a.detail as { to: string }).to === "standard");
    expect(up!.detail).toMatchObject({ from: "untrusted", relaxation: true, sourceKind: "mcp_server" });
  });

  it("the write floor change needs a step-up and is audited; an unknown floor or tier is refused", async () => {
    const refused = await app.inject({ method: "PUT", url: "/v1/content-trust/settings", headers: adminAuth, payload: { writeFloor: "standard" } });
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/v1/content-trust/settings", headers: adminAuth, payload: { writeFloor: "untrusted" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/v1/content-trust/sources/mcp_server/${serverId}`, headers: adminAuth, payload: { tier: "secret" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/v1/content-trust/sources/mcp_server/${randomUUID()}`, headers: adminAuth, payload: { tier: "trusted" } })).statusCode).toBe(404);
    await setFloor("standard");
    await setFloor("trusted");
    const audits = await db.select().from(auditLog).where(eq(auditLog.ruleId, "content-trust-floor-set"));
    expect(audits.some((a) => (a.detail as { to: string; relaxation: boolean }).to === "standard" && (a.detail as { relaxation: boolean }).relaxation)).toBe(true);
  });
});
