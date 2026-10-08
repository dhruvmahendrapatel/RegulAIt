/**
 * ADR-0186 T — THE EXPORT ON THE WIRE. A real governed call (a mock agent,
 * granted, invoked through the dispatch path) is exported through the real
 * `POST /v1/tracing/export` route, egress guard and guarded fetch included, to
 * a loopback collector that only CAPTURES the request. Nothing leaves the host.
 *
 * On the captured bytes:
 *  1. every ResourceSpans and every ScopeSpans carries `schemaUrl`, naming the
 *     pinned semconv version;
 *  2. the request's content type is one Langfuse documents accepting and one
 *     Phoenix documents refusing (so the Phoenix fixture's "needs a Collector"
 *     is a statement about these bytes, not about a fixture);
 *  3. the body satisfies both hand-written ingest-shape fixtures
 *     (packages/shared/src/__fixtures__/otlp-ingest), in both profiles, through
 *     the same checker the pure fixture test uses;
 *  4. the dry-run body is byte-for-byte the body that was sent, so the pure
 *     fixture test in packages/shared is testing the bytes we actually send.
 *
 * Global state: the org's OTLP endpoint and content-capture setting, and one
 * egress allow row for 127.0.0.86 — all restored/removed in afterAll (M-068),
 * as are the trace, agent and user this file creates.
 */
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  createDb,
  egressAllowHosts,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  traces,
  users,
  type Db,
} from "@regulait/db";
import { TRACE_STANDARDS_PINS } from "@regulait/shared";
import { checkIngestShape, loadIngestFixture } from "../../../packages/shared/src/__fixtures__/otlp-ingest/check-ingest-shape.mjs";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const RUN = crypto.randomBytes(3).toString("hex");
const BOOT = "b4t-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const HOST = "127.0.0.86";
const SCHEMA_URL = `https://opentelemetry.io/schemas/${TRACE_STANDARDS_PINS.otelSemanticConventions}`;
const NONCE = `b4t-nonce-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let admin: { id: string; auth: { authorization: string } };
let agentId: string | null = null;
let traceId: string;
let priorEndpoint: string | null = null;
let createdEgressRow: string | null = null;
let restoreIdentity: (() => Promise<void>) | undefined;
let restorePosture: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;

type Captured = { method: string; url: string; contentType: string; body: string };
const captured: Captured[] = [];
let collector: http.Server;
let endpoint: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  await app.ready();
  // ADR-0181: content capture ships OFF; this file checks the content keys too
  restorePosture = await relaxDataPostureForTest(db, { org: { tracingCaptureContent: true }, interception: false, guardrails: false });

  // the loopback collector: captures, answers 200, forwards nothing
  collector = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", contentType: String(req.headers["content-type"] ?? ""), body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, HOST, resolve));
  const addr = collector.address();
  if (typeof addr !== "object" || !addr) throw new Error("no collector address");
  endpoint = `http://${HOST}:${addr.port}/v1/traces`;

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `b4t-admin-${RUN}@example.com`, displayName: "b4t admin", isAdmin: true },
  });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "b4t" } });
  expect(k.statusCode, k.body).toBe(201);
  admin = { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };

  // a real governed call: the agent is granted, invoked, dispatched and traced
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `b4t-agent-${RUN}`, provider: "mock", model: "b4t-asked", tier: 1, costPerMTokIn: 3, costPerMTokOut: 7 },
  });
  expect(a.statusCode, a.body).toBe(201);
  agentId = a.json().id as string;
  const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: admin.id, agentId } });
  expect(g.statusCode, g.body).toBe(201);
  const inv = await app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: admin.auth,
    payload: { mode: "execute", input: `${NONCE} <<serve-as:b4t-served>>`, dispatch: true },
  });
  expect(inv.statusCode, inv.body).toBe(200);
  traceId = inv.json().dispatch.trace.traceId as string;

  const [prior] = await db.select({ e: orgSettings.tracingOtlpEndpoint }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorEndpoint = prior?.e ?? null;
  const [eg] = await db
    .insert(egressAllowHosts)
    .values({ host: HOST, allowPrivateRanges: true, allowPlaintextHttp: true, note: "b4t wire test" })
    .onConflictDoNothing()
    .returning({ id: egressAllowHosts.id });
  createdEgressRow = eg?.id ?? null;
  await db.update(orgSettings).set({ tracingOtlpEndpoint: endpoint }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
}, 120_000);

afterAll(async () => {
  await db.update(orgSettings).set({ tracingOtlpEndpoint: priorEndpoint }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (createdEgressRow) await db.delete(egressAllowHosts).where(eq(egressAllowHosts.id, createdEgressRow));
  await restorePosture?.();
  await restoreIdentity?.();
  if (admin) await db.delete(traces).where(inArray(traces.userId, [admin.id]));
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  if (admin) await db.delete(users).where(eq(users.id, admin.id));
  await new Promise<void>((resolve) => {
    collector.closeAllConnections();
    collector.close(() => resolve());
  });
  app.server.closeAllConnections();
  await restoreGates?.();
  await app.close();
});

type WireBody = {
  resourceSpans: Array<{ schemaUrl?: string; scopeSpans: Array<{ schemaUrl?: string; spans: unknown[] }> }>;
};

async function exportOnce(profile: "otel_genai" | "openinference"): Promise<{ sent: Captured; dry: unknown }> {
  const before = captured.length;
  const r = await app.inject({
    method: "POST",
    url: "/v1/tracing/export",
    headers: admin.auth,
    payload: { traceIds: [traceId], profile },
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toMatchObject({ exported: true, profile, traceCount: 1 });
  expect(captured.length, "exactly one request reached the collector").toBe(before + 1);
  const d = await app.inject({
    method: "POST",
    url: "/v1/tracing/export",
    headers: admin.auth,
    payload: { traceIds: [traceId], profile, dryRun: true },
  });
  expect(d.statusCode, d.body).toBe(200);
  return { sent: captured[captured.length - 1]!, dry: d.json().body };
}

for (const profile of ["otel_genai", "openinference"] as const) {
  describe(`ADR-0186 T — the ${profile} export, as captured on the wire`, () => {
    let sent: Captured;
    let body: WireBody & Record<string, unknown>;
    let dry: unknown;

    beforeAll(async () => {
      ({ sent, dry } = await exportOnce(profile));
      body = JSON.parse(sent.body) as WireBody & Record<string, unknown>;
    });

    it("is one POST of OTLP/HTTP JSON to the configured path", () => {
      expect(sent.method).toBe("POST");
      expect(sent.url).toBe("/v1/traces");
      expect(sent.contentType).toBe("application/json");
    });

    it("stamps schemaUrl on every ResourceSpans and every ScopeSpans", () => {
      expect(body.resourceSpans.length).toBeGreaterThan(0);
      for (const rs of body.resourceSpans) {
        expect(rs.schemaUrl, "ResourceSpans.schemaUrl").toBe(SCHEMA_URL);
        expect(rs.scopeSpans.length).toBeGreaterThan(0);
        for (const ss of rs.scopeSpans) {
          expect(ss.schemaUrl, "ScopeSpans.schemaUrl").toBe(SCHEMA_URL);
          expect(ss.spans.length).toBeGreaterThan(0);
        }
      }
    });

    it("the dry-run body is the body that was sent", () => {
      expect(JSON.parse(JSON.stringify(dry))).toEqual(body);
    });

    for (const tool of ["langfuse", "phoenix"] as const) {
      it(`satisfies the ${tool} ingest-shape fixture (transport and attributes)`, () => {
        const fx = loadIngestFixture(tool);
        expect(fx.transport.acceptsContentTypes.includes(sent.contentType), `${tool} transport`).toBe(fx.transport.directFromRegulait);
        if (!fx.profiles[profile]) return;
        const v = checkIngestShape(body, fx, profile, { includeContent: true, sessionTrace: false, requireKinds: ["llm"] });
        expect(v).toEqual([]);
      });
    }
  });
}
