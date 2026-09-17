/**
 * ADR-0111 e2e — THE EXPORTED OBSERVABILITY COPY, proved by the stored row and
 * by the exported bytes.
 *
 * WHAT THIS IS ABOUT. ADR-0104 scrubs a governed tool call's ARGUMENTS into
 * `approvals.arguments_preview` with `scrubAuditDetail`, so the human signing a
 * consent never sees a raw credential and the queue never stores one. The
 * IDENTICAL payload was written, in the same request, into
 * `trace_spans.input_preview` by `toolPayloadPreview`, which only truncates.
 * The tool's RESULT went into `output_preview` the same way. That is S5's shape
 * exactly — one event, two stores, disagreeing about whether the secret was
 * contained — and it is worse than S5 in one respect: ADR-0070 EXPORTS spans
 * over OTLP to a third-party backend, so it is egress and not only persistence.
 *
 * WHAT IS PROVEN, IN ORDER:
 *  1. The leak, INVERTED: a synthetic AWS-shaped key in tool arguments and in
 *     the tool result reaches `trace_spans` as a marker, not as plaintext.
 *     Read back with raw SQL after commit — never the ORM's return value,
 *     because a scrubber that is correct and unwired protects nothing.
 *  2. CROSS-STORE MARKER AGREEMENT: the marker in `trace_spans.input_preview`
 *     is BYTE-IDENTICAL to the one `audit_log.reason` (ADR-0099) and
 *     `mcp_servers.admission_clear_reason` (ADR-0102) produce for the same
 *     secret. That identity is the whole point — two records of one secret that
 *     redact differently cannot be correlated, which was S5's real damage.
 *  3. THE EXPORTED BYTES: `buildOtlpPayload` over the stored spans, serialised,
 *     carries the marker and never the key. The row and the wire agree.
 *  4. THE OVER-SCRUB GUARD: ordinary tool arguments and an ordinary tool result
 *     are byte-identical in the stored preview afterwards.
 *  5. The registry inventory names the two new columns, so the ADR's
 *     enumeration is a test and cannot go stale.
 *
 * NEGATIVE ASSERTIONS ARE PAIRED (M-033). Every `not.toContain(SECRET)` sits
 * beside a positive assertion that the MARKER is present, so the test cannot
 * pass on an empty column, a null, or a span that was never written.
 *
 * SHARED-STATE DISCIPLINE. Every fixture is `f04-`/`F04` prefixed and carries a
 * per-run nonce; nothing mutates the `org_settings` singleton; every read is
 * filtered to rows this file created.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  createDb,
  eq,
  mcpServers,
  proseScrubInventory,
  runMigrations,
  sql,
  traceSpans,
  traces,
  type Db,
  type TraceSpanRow,
} from "@regulait/db";
import { buildOtlpPayload, scrubAuditText } from "@regulait/shared";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "f04-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = randomUUID().slice(0, 8);

/**
 * SHAPES, NOT LIVE SECRETS. The AWS id is AWS's own published documentation
 * example (`AKIAIOSFODNN7EXAMPLE`); no real credential appears in this file,
 * in any fixture it writes, or in any log it produces.
 */
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

/** The over-scrub fixture: deliberately full of what a naive detector eats. */
const ORDINARY =
  "rotate the staging cert before 2026-10-01; ticket SEC-4412, owner ana@example.com, " +
  "agent 7f1a5b2c-9d4e-4a10-b3c8-2e5f6a7b8c90, model claude-opus-4, tokensIn 1200";

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let gatewayUrl: string;
let serverId: string;
let userId: string;

// --- upstream MCP server: `echo_note` puts the ARGUMENT into the RESULT, so a
// single call exercises both `input_preview` and `output_preview`. ------------

function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "f04-upstream", version: "0.0.1" });
  server.registerTool(
    "echo_note",
    { description: "Echoes its input", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echoed: ${text}` }] }),
  );
  return server;
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstreamMcpServer();
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

async function apiKeyFor(id: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${id}/keys`,
    payload: { name: "f04-key" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().token;
}

async function mcpClientFor(id: string): Promise<Client> {
  const client = new Client({ name: "f04-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
    requestInit: { headers: { authorization: `Bearer ${await apiKeyFor(id)}` } },
  });
  await client.connect(transport);
  return client;
}

/** Call `echo_note` once and return the `tool` span row Postgres actually
 * holds — read with raw SQL, after commit, keyed on the per-call nonce that is
 * inside the payload, so no other test's span can satisfy the assertion. */
async function callAndReadSpan(text: string): Promise<Record<string, any>> {
  const client = await mcpClientFor(userId);
  const out = await client.callTool({ name: "echo_note", arguments: { text } });
  expect((out.content as Array<{ text: string }>)[0]!.text).toContain("echoed: ");
  await client.close();

  // The tool span is the most recent `tool` span for this server. Raw SQL: the
  // ORM must not be why an assertion passes.
  const res = await db.execute(sql`
    select input_preview, output_preview, status, name, trace_id
      from trace_spans
     where kind = 'tool' and mcp_server_id = ${serverId}
     order by started_at desc, seq desc
     limit 1
  `);
  const row = (res as unknown as { rows: Array<Record<string, any>> }).rows[0];
  if (!row) throw new Error("the governed tool call wrote no trace span");
  return row;
}

/** The first `[redacted:…]` marker in a string, or null. */
function markerIn(s: string | null | undefined): string | null {
  return (s ?? "").match(/\[redacted:[^\]]+\]/)?.[0] ?? null;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  upstream = await startUpstream();
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "f04 suite: local upstream MCP server",
    },
  });

  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `f04-caller-${RUN}@example.com`, displayName: "F04 Caller" },
  });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;

  const s = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: `f04-upstream-${RUN}`, url: upstream.url },
  });
  expect(s.statusCode).toBe(201);
  serverId = s.json().id;

  const grant = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/tools",
    payload: { userId, serverId, toolName: "echo_note" },
  });
  expect(grant.statusCode, JSON.stringify(grant.json())).toBe(201);
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  await upstream.close();
});

// ---------------------------------------------------------------------------

describe("1. the trace-preview leak, inverted", () => {
  it("stores a MARKER — never the key — in input_preview and output_preview", async () => {
    const nonce = `f04-args-${RUN}`;
    const row = await callAndReadSpan(`${nonce} deploy using ${AWS_KEY} then rotate it`);

    // POSITIVE FIRST (M-033): the row exists, is the right one, and carries the
    // marker. Without these the negatives below would pass on an empty column.
    expect(row.name).toBe("echo_note");
    expect(row.input_preview, "no input preview was stored at all").toBeTruthy();
    expect(row.input_preview).toContain(nonce);
    expect(row.input_preview).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
    // THE DEFECT: this column held the key verbatim.
    expect(row.input_preview).not.toContain(AWS_KEY);
    // the sentence around it survives byte for byte
    expect(row.input_preview).toContain(" deploy using ");
    expect(row.input_preview).toContain(" then rotate it");

    // the RESULT is the same story: the upstream echoed the key straight back.
    expect(row.output_preview, "no output preview was stored at all").toBeTruthy();
    expect(row.output_preview).toContain("echoed: ");
    expect(row.output_preview).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
    expect(row.output_preview).not.toContain(AWS_KEY);
  });
});

// ---------------------------------------------------------------------------

describe("2. cross-store marker agreement — ADR-0102's whole point", () => {
  it("produces the byte-identical marker in trace_spans, audit_log and the prose column", async () => {
    const nonce = `f04-agree-${RUN}`;
    const span = await callAndReadSpan(`${nonce} ${AWS_KEY}`);
    const inTrace = markerIn(span.input_preview);
    expect(inTrace, "the span carries no marker to compare").toBeTruthy();

    // The SAME secret, through a completely different route, into ADR-0099's
    // audit path and ADR-0102's prose column.
    const s = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: { name: `f04-agree-server-${RUN}`, url: upstream.url },
    });
    expect(s.statusCode).toBe(201);
    const otherServerId = s.json().id as string;
    // Clearing is only ever an override of a HELD verdict, so the fixture is
    // put into the state the route requires.
    await db
      .update(mcpServers)
      .set({
        admissionState: "held",
        admissionSeverity: "high",
        admissionFindings: [{ ruleId: "mcp.admission.injection", severity: "high", toolName: "t" }],
        admissionManifestDigest: "sha256:f04",
        admissionScannedAt: new Date(),
      })
      .where(eq(mcpServers.id, otherServerId));
    const cleared = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/servers/${otherServerId}/admission/clear`,
      payload: { reason: `${nonce} cleared while rotating ${AWS_KEY}` },
    });
    expect(cleared.statusCode, JSON.stringify(cleared.json())).toBe(200);

    const col = (
      await db.execute(
        sql`select admission_clear_reason from mcp_servers where id = ${otherServerId}`,
      )
    ) as unknown as { rows: Array<{ admission_clear_reason: string | null }> };
    const inColumn = markerIn(col.rows[0]?.admission_clear_reason);

    const aud = (await db.execute(sql`
      select reason from audit_log
       where object_id = ${otherServerId} and rule_id = 'mcp-admission-cleared'
       order by at desc limit 1
    `)) as unknown as { rows: Array<{ reason: string | null }> };
    const inAudit = markerIn(aud.rows[0]?.reason);

    expect(inColumn, "ADR-0102's column carries no marker").toBeTruthy();
    expect(inAudit, "ADR-0099's audit row carries no marker").toBeTruthy();
    // ONE secret, ONE marker, in all three stores.
    expect(inTrace).toBe(inAudit);
    expect(inTrace).toBe(inColumn);
    // and it is the shared detector's own output, not a lookalike
    expect(inTrace).toBe(scrubAuditText(AWS_KEY));
  });
});

// ---------------------------------------------------------------------------

describe("3. the EXPORTED bytes, not only the stored row", () => {
  it("never puts the key on the OTLP wire, and does put the marker there", async () => {
    const nonce = `f04-otlp-${RUN}`;
    const span = await callAndReadSpan(`${nonce} key ${AWS_KEY}`);
    const traceId = span.trace_id as string;

    const [t] = await db.select().from(traces).where(eq(traces.id, traceId));
    expect(t, "the tool span names a trace that does not exist").toBeTruthy();
    const rows: TraceSpanRow[] = await db
      .select()
      .from(traceSpans)
      .where(eq(traceSpans.traceId, traceId))
      .orderBy(traceSpans.seq);

    const payload = buildOtlpPayload({
      serviceName: "f04-service",
      // the WORST case for this surface: content export explicitly ON.
      includeContent: true,
      traces: [
        {
          trace: {
            ...t!,
            startedAt: t!.startedAt.toISOString(),
            endedAt: t!.endedAt?.toISOString() ?? null,
          },
          spans: rows.map((s) => ({
            ...s,
            startedAt: s.startedAt.toISOString(),
            endedAt: s.endedAt ? s.endedAt.toISOString() : null,
            attributes: (s.attributes ?? null) as Record<string, unknown> | null,
          })),
        },
      ],
    });

    const wire = JSON.stringify(payload.body);
    // POSITIVE FIRST: the content really is on the wire, so the negative below
    // is discriminating and not a statement about an empty export.
    expect(wire).toContain(nonce);
    expect(wire).toContain("gen_ai.input.messages");
    expect(wire).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
    expect(wire).not.toContain(AWS_KEY);
  });
});

// ---------------------------------------------------------------------------

describe("4. the OVER-SCRUB guard — ordinary payloads are byte-identical", () => {
  it("leaves realistic tool arguments and a realistic tool result exactly as they were", async () => {
    const nonce = `f04-plain-${RUN}`;
    const text = `${nonce} ${ORDINARY}`;
    const row = await callAndReadSpan(text);

    // Not "contains": EQUAL. The preview is the JSON encoding of the arguments
    // object and of the MCP result envelope, and neither may be rewritten — not
    // re-encoded, not normalised, not a character different.
    expect(row.input_preview).toBe(JSON.stringify({ text }));
    expect(row.output_preview).toBe(
      JSON.stringify({ content: [{ type: "text", text: `echoed: ${text}` }] }),
    );
    expect(row.input_preview).not.toContain("[redacted:");
    expect(row.output_preview).not.toContain("[redacted:");
  });
});

// ---------------------------------------------------------------------------

describe("5. the inventory names the new columns", () => {
  it("registers trace_spans.input_preview and trace_spans.output_preview", () => {
    const inv = proseScrubInventory();
    expect(inv).toContain("trace_spans.input_preview");
    expect(inv).toContain("trace_spans.output_preview");
    // the column ADR-0102 already owned is still there
    expect(inv).toContain("trace_spans.status_reason");
  });
});
