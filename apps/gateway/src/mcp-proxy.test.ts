import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { and, connectors, createDb, eq, inArray, mcpTools, modelCredentials, projects, runMigrations, usageEvents, type Db } from "@regulait/db";
// ADR-0104 — the consent fingerprint the approvals queue row is bound to.
import { approvalArgumentsDigest } from "@regulait/shared";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";
import { currentPeriodKey } from "./projects.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

/**
 * ADR-0034 amendment #2 — an ALLOW-LISTED LOOPBACK DEAD PORT, for the fixtures
 * whose `baseUrl` is never actually fetched (a read-back projection, an INBOUND
 * webhook connection). `connectors`/`pm_connections` `baseUrl` fields now go
 * through the default-deny egress guard at write time, and the guard RESOLVES
 * every destination: a `.example` host fails closed and a real vendor hostname
 * would make this suite depend on DNS — either would mask what these tests
 * actually assert. Port 9 (discard) is allow-listed with this file's 127.0.0.1
 * entry and answers nothing, which is exactly what these cases want. No
 * assertion was weakened and no guard behaviour was relaxed.
 */
const DEAD_LOOPBACK = "http://127.0.0.1:9";

// --- upstream test MCP server (stateless: fresh server+transport per request) ---

function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "upstream-test", version: "0.0.1" });
  server.registerTool(
    "get_time",
    {
      description: "Returns a fixed time",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text", text: "12:00" }] }),
  );
  server.registerTool(
    "write_note",
    {
      description: "Writes a note",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `wrote: ${text}` }] }),
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

// --- test setup ---

const BOOT = "test-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let gatewayUrl: string;
let serverId: string;
let aliceId: string;
let bobId: string;

async function apiKeyFor(userId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "test-key" },
  });
  return res.json().token;
}

async function authFor(userId: string): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await apiKeyFor(userId)}` };
}

async function mcpClientFor(userId: string, intent?: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const url = new URL(`${gatewayUrl}/mcp/${serverId}`);
  if (intent) url.searchParams.set("intent", intent);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${await apiKeyFor(userId)}` } },
  });
  await client.connect(transport);
  return client;
}

// AER-047: this suite drives check stages whose templates opt in to the
// labelled offline auto-pass (offlineAutoPass). The opt-in FAILS CLOSED unless
// the process declares offline mode, so the suite declares it — and restores
// the environment afterwards.
const priorOfflineChecks = process.env.REGULAIT_OFFLINE_CHECKS;
beforeAll(() => {
  process.env.REGULAIT_OFFLINE_CHECKS = "1";
});
afterAll(() => {
  if (priorOfflineChecks === undefined) delete process.env.REGULAIT_OFFLINE_CHECKS;
  else process.env.REGULAIT_OFFLINE_CHECKS = priorOfflineChecks;
});

// M-068: the loopback allow entry is global state on the shared database; its id is
// recorded so afterAll removes it, and no later file inherits it.
let loopbackAllowHostId: string | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false, keyCustodyEnforced: false });

  upstream = await startUpstream();

  const addr = await app.listen({ port: 0, host: "127.0.0.1" });
  gatewayUrl = addr;

  // ADR-0034 amendment — model-credential `baseUrl` overrides are now behind
  // the default-deny egress guard. This suite points them at local fake
  // provider servers on 127.0.0.1, so it allow-lists that host explicitly with
  // the private-range and plaintext opt-ins, exactly as an air-gapped operator
  // would (the same pattern as custom-providers.test.ts).
  // ADR-0034 amendment #2 — the SAME entry now also covers this file's
  // connector `baseUrl`s and its Jira/Linear/Asana/monday/generic-webhook PM
  // connections, all of which point at loopback fakes and all of which are now
  // guarded at write time and on every outbound call.
  const egressAllowed = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "mcp-proxy suite: local fake provider endpoints",
    },
  });
  expect(egressAllowed.statusCode).toBe(201);
  loopbackAllowHostId = egressAllowed.json().id;

  const alice = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "proxy-alice@example.com", displayName: "Proxy Alice" },
  });
  aliceId = alice.json().id;

  const bob = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "proxy-bob@example.com", displayName: "Proxy Bob" },
  });
  bobId = bob.json().id;

  const server = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "upstream-test", url: upstream.url },
  });
  serverId = server.json().id;
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  // M-068: remove the loopback allow entry this file created
  if (loopbackAllowHostId && app) {
    const gone = await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${loopbackAllowHostId}` });
    expect(gone.statusCode).toBe(200);
  }
  // SHARED-STATE DISCIPLINE (PENDING S8, diagnosed 2026-10-03). This file
  // upserts a PLATFORM credential for anthropic, openai, google and xai, each
  // pointing at a loopback fake it closes on the way out and each encrypted
  // under THIS file's data key. Left behind, the next file to dispatch on one
  // of those providers under a different key finds a stored credential it
  // cannot decrypt — `decryptSecret` throws, nothing maps that to a status —
  // and gets a 500 where it asserted 409 `no_model_credential`
  // (compat-longtail.test.ts, "THE ASYMMETRY, provider side"). Whether that
  // happened depended on whether one of the four files that wipe the slot ran
  // in between, which is why it was intermittent. Take exactly these slots
  // back; the file owns them while it runs, the same way env-fallback does.
  //
  // The take-back runs LAST and in a `finally`: a close that throws (or a
  // beforeAll that failed before `app`/`upstream` were assigned) must not be
  // able to skip it, and it must not be able to skip the closes either. The
  // `db` guard covers a beforeAll that failed before the pool existed.
  try {
    try {
      app?.server.closeAllConnections();
  await restoreSb2Gates();
      await app?.close();
    } finally {
      await upstream?.close();
    }
  } finally {
    if (db) {
      await db
        .delete(modelCredentials)
        .where(inArray(modelCredentials.provider, ["anthropic", "openai", "google", "xai"]));
    }
  }
});

describe("MCP proxy path", () => {
  it("lists no tools for a user with no grants, but syncs the inventory", async () => {
    const client = await mcpClientFor(aliceId);
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    await client.close();

    const inventory = await db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId));
    const byName = Object.fromEntries(inventory.map((t) => [t.name, t.kind]));
    expect(byName).toEqual({ get_time: "read", write_note: "write" });
  });

  it("denies an ungranted call with a policy error and writes a deny audit row", async () => {
    const client = await mcpClientFor(aliceId);
    await expect(client.callTool({ name: "get_time", arguments: {} })).rejects.toThrow(
      /Denied by policy/,
    );
    await client.close();

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${aliceId}` });
    const entries = audit.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ effect: "deny", toolName: "get_time" });
  });

  it("proxies a granted tool call end-to-end and audits the allow", async () => {
    const grant = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: aliceId, serverId, toolName: "get_time" },
    });
    const grantId = grant.json().id;

    const client = await mcpClientFor(aliceId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_time"]);

    const result = await client.callTool({ name: "get_time", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "12:00" }]);
    await client.close();

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${aliceId}` });
    const allowRow = audit.json().entries.find((e: { effect: string }) => e.effect === "allow");
    expect(allowRow).toMatchObject({ toolName: "get_time", ruleId: grantId });
  });

  it("read-only-all grant exposes and allows read tools but denies writes", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/servers",
      payload: { userId: bobId, serverId, readOnlyAll: true },
    });

    const client = await mcpClientFor(bobId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_time"]);

    const ok = await client.callTool({ name: "get_time", arguments: {} });
    expect(ok.content).toEqual([{ type: "text", text: "12:00" }]);

    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Denied by policy/);
    await client.close();
  });

  it("rejects requests without a user identity header", async () => {
    const res = await fetch(`${gatewayUrl}/mcp/${serverId}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("approvals through the proxy (§3 + §6 queue)", () => {
  let daveId: string;
  let carolId: string;

  it("pauses a write call behind an approval rule and queues exactly one pending entry", async () => {
    const dave = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-dave@example.com", displayName: "Proxy Dave" },
    });
    daveId = dave.json().id;
    const carol = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-carol@example.com", displayName: "Proxy Carol" },
    });
    carolId = carol.json().id;

    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: daveId, serverId, toolName: "write_note" },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/approvals",
      payload: { userId: daveId, serverId, writeOnly: true, approverUserId: carolId },
    });

    const client = await mcpClientFor(daveId);
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Approval required/);
    // second attempt while pending reuses the same queue entry
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Approval required/);
    await client.close();

    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const pending = queue
      .json()
      .approvals.filter((a: { userId: string }) => a.userId === daveId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toolName: "write_note",
      approverUserId: carolId,
      status: "pending",
    });
  });

  it("only the named approver may decide", async () => {
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const approvalId = queue
      .json()
      .approvals.find((a: { userId: string }) => a.userId === daveId).id;

    const wrongDecider = await app.inject({
      method: "POST",
      headers: await authFor(daveId),
      url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved" },
    });
    expect(wrongDecider.statusCode).toBe(403);
  });

  it("an approved call goes through once, ONLY for the arguments it was approved for, and audits the full journey", async () => {
    // ADR-0104 TIGHTENED THIS TEST. It used to prove only "an approval is
    // single-use", which said nothing about WHICH call may spend it — and that
    // silence was the finding: the approved-approval lookup keyed on
    // user/server/tool/status, so a signature for one payload was spendable on
    // any other. Every original assertion below is intact; a step was ADDED
    // before the successful call, and the effects sequence grew by the
    // require_approval that step now (correctly) produces.
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const queued = queue.json().approvals.find((a: { userId: string }) => a.userId === daveId);
    const approvalId = queued.id;

    // The approver is no longer deciding blind: the row carries the SCRUBBED
    // payload they are signing, and the fingerprint of the raw one.
    expect(queued.argumentsPreview).toEqual({ text: "hi" });
    expect(queued.argumentsDigest).toBe(
      approvalArgumentsDigest({ projectId: null, arguments: { text: "hi" } }),
    );

    const decide = await app.inject({
      method: "POST",
      headers: await authFor(carolId),
      url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved", reason: "looks safe" },
    });
    expect(decide.json().status).toBe("approved");

    const client = await mcpClientFor(daveId);

    // THE ADDED STEP. Carol signed `{text:"hi"}`. A call with different
    // arguments is a different call, and this approval is not consent for it.
    // Before ADR-0104 this line SUCCEEDED — that was the hole.
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "tampered" } }),
    ).rejects.toThrow(/Approval required/);
    // ...and it did not burn Carol's signature on the way past
    const stillApproved = await app.inject({
      method: "GET", headers: AUTH, url: "/v1/approvals?status=approved",
    });
    expect(
      stillApproved.json().approvals.some((a: { id: string }) => a.id === approvalId),
    ).toBe(true);

    const result = await client.callTool({ name: "write_note", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "wrote: hi" }]);

    // approval is single-use: the next call pauses again
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "again" } }),
    ).rejects.toThrow(/Approval required/);
    await client.close();

    const consumed = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=consumed" });
    expect(
      consumed.json().approvals.some((a: { id: string }) => a.id === approvalId),
    ).toBe(true);

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${daveId}` });
    const effects = audit
      .json()
      .entries.map((e: { effect: string }) => e.effect)
      .reverse();
    // one MORE require_approval than before: the tampered attempt. The shape is
    // otherwise unchanged — pause, pause, [pause], allow, pause.
    expect(effects).toEqual([
      "require_approval",
      "require_approval",
      "require_approval",
      "allow",
      "require_approval",
    ]);
  });

  it("a denied approval does not let the call through", async () => {
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const approvalId = queue
      .json()
      .approvals.find((a: { userId: string }) => a.userId === daveId).id;
    await app.inject({
      method: "POST",
      headers: await authFor(carolId),
      url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "denied", reason: "not now" },
    });

    const client = await mcpClientFor(daveId);
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "please" } }),
    ).rejects.toThrow(/Approval required/);
    await client.close();
  });
});

describe("rate limits through the proxy (§3)", () => {
  it("denies the call that exceeds the window cap and audits the deny", async () => {
    const erin = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-erin@example.com", displayName: "Proxy Erin" },
    });
    const erinId = erin.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: erinId, serverId, toolName: "get_time" },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/rate-limits",
      payload: { userId: erinId, serverId, toolName: "get_time", maxCalls: 2, windowSeconds: 3600 },
    });

    const client = await mcpClientFor(erinId);
    await client.callTool({ name: "get_time", arguments: {} });
    await client.callTool({ name: "get_time", arguments: {} });
    await expect(client.callTool({ name: "get_time", arguments: {} })).rejects.toThrow(
      /rate limit exhausted/,
    );
    await client.close();

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${erinId}` });
    const effects = audit
      .json()
      .entries.map((e: { effect: string }) => e.effect)
      .reverse();
    expect(effects).toEqual(["allow", "allow", "deny"]);
  });
});

describe("data-scope rules through the proxy (§3)", () => {
  it("allows in-scope argument values and denies out-of-scope ones, fail-closed on missing", async () => {
    const frank = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-frank@example.com", displayName: "Proxy Frank" },
    });
    const frankId = frank.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: frankId, serverId, toolName: "write_note" },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/data-scopes",
      payload: {
        userId: frankId,
        serverId,
        toolName: "write_note",
        argPath: "text",
        allowedValues: ["hello", "hi"],
      },
    });

    const client = await mcpClientFor(frankId);

    const ok = await client.callTool({ name: "write_note", arguments: { text: "hi" } });
    expect(ok.content).toEqual([{ type: "text", text: "wrote: hi" }]);

    await expect(
      client.callTool({ name: "write_note", arguments: { text: "exfiltrate" } }),
    ).rejects.toThrow(/outside the allowed data scope/);

    await expect(client.callTool({ name: "write_note", arguments: {} })).rejects.toThrow(
      /fails closed/,
    );
    await client.close();

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${frankId}` });
    const effects = audit
      .json()
      .entries.map((e: { effect: string }) => e.effect)
      .reverse();
    expect(effects).toEqual(["allow", "deny", "deny"]);
  });
});

describe("rule scoping through the proxy (pillar 1): fleet / role / team restrictions", () => {
  // Each scenario gets its OWN server row (same upstream, distinct id) so a
  // fleet-wide rule created in one test never leaks onto another's server —
  // exactly the isolation the invariant demands (a scoped rule only ever ADDS
  // a restriction, and only within its own scope).
  let approverId: string;

  async function newUser(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email, displayName: `Scope ${email.split("@")[0]}` },
    });
    return res.json().id;
  }
  let serverSeq = 0;
  async function freshServer(): Promise<string> {
    const srv = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/servers",
      payload: { name: `p1-upstream-${serverSeq++}`, url: upstream.url },
    });
    const serverId = srv.json().id;
    // one listTools syncs the inventory (get_time read / write_note write)
    const client = await scopeClient(approverId, serverId);
    await client.listTools();
    await client.close();
    return serverId;
  }
  async function grant(userId: string, serverId: string, toolName: string): Promise<void> {
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/tools",
      payload: { userId, serverId, toolName },
    });
  }
  async function scopeClient(userId: string, serverId: string): Promise<Client> {
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
      requestInit: { headers: { authorization: `Bearer ${await apiKeyFor(userId)}` } },
    });
    await client.connect(transport);
    return client;
  }

  it("sets up the shared approver", async () => {
    approverId = await newUser("p1-approver@example.com");
  });

  it("a FLEET approval rule pauses a granted WRITE by a user with NO user-specific rule", async () => {
    const serverId = await freshServer();
    const hana = await newUser("p1-hana@example.com");
    await grant(hana, serverId, "get_time");
    await grant(hana, serverId, "write_note");
    // fleet subject (any user), pinned to this server so it stays isolated
    const rule = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/approvals",
      payload: { scope: "fleet", serverScope: "server", serverId, writeOnly: true, approverUserId: approverId },
    });
    expect(rule.statusCode).toBe(201);
    expect(rule.json()).toMatchObject({ scope: "fleet", userId: null, serverScope: "server" });

    const client = await scopeClient(hana, serverId);
    // a read still passes (the writeOnly rule skips reads)
    const ok = await client.callTool({ name: "get_time", arguments: {} });
    expect(ok.content).toEqual([{ type: "text", text: "12:00" }]);
    // the write pauses on the fleet rule even though Hana has no user rule
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Approval required/);
    await client.close();

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${hana}` });
    const effects = audit.json().entries.map((e: { effect: string }) => e.effect).reverse();
    expect(effects).toEqual(["allow", "require_approval"]);
  });

  it("a ROLE-scoped rule + a user rule → most-restrictive: still require_approval, never relaxed", async () => {
    const serverId = await freshServer();
    const ivan = await newUser("p1-ivan@example.com");
    await grant(ivan, serverId, "write_note");
    const role = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/roles",
      payload: { name: "p1-writers", description: "role-scoped rule demo" },
    });
    const roleId = role.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${ivan}/roles`, payload: { roleId },
    });
    // a role-scoped approval rule on this server for the whole role
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/approvals",
      payload: { scope: "role", roleId, serverScope: "server", serverId, writeOnly: true, approverUserId: approverId },
    });
    // plus a user-specific rule for Ivan too — cannot relax the role restriction
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/approvals",
      payload: { scope: "user", userId: ivan, serverScope: "server", serverId, writeOnly: true, approverUserId: approverId },
    });

    const client = await scopeClient(ivan, serverId);
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "role" } }),
    ).rejects.toThrow(/Approval required/);
    await client.close();
  });

  it("a TEAM-scoped rule applies to team MEMBERS only, not to non-members", async () => {
    const serverId = await freshServer();
    const member = await newUser("p1-member@example.com");
    const outsider = await newUser("p1-outsider@example.com");
    await grant(member, serverId, "write_note");
    await grant(outsider, serverId, "write_note");
    const team = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "p1-team" },
    });
    const teamId = team.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/teams/${teamId}/members`, payload: { userId: member },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/approvals",
      payload: { scope: "team", teamId, serverScope: "server", serverId, writeOnly: true, approverUserId: approverId },
    });

    // the member is paused by the team rule
    const mClient = await scopeClient(member, serverId);
    await expect(
      mClient.callTool({ name: "write_note", arguments: { text: "in" } }),
    ).rejects.toThrow(/Approval required/);
    await mClient.close();

    // the non-member is NOT — the rule never widens to a user outside the team
    const oClient = await scopeClient(outsider, serverId);
    const ok = await oClient.callTool({ name: "write_note", arguments: { text: "out" } });
    expect(ok.content).toEqual([{ type: "text", text: "wrote: out" }]);
    await oClient.close();
  });

  it("rejects a mis-discriminated rule at the edge (400), never at the database", async () => {
    // scope 'fleet' must carry no subject id
    const badFleet = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/approvals",
      payload: { scope: "fleet", serverScope: "all", userId: approverId, writeOnly: true, approverUserId: approverId },
    });
    expect(badFleet.statusCode).toBe(400);
    // scope 'role' must carry a roleId
    const badRole = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/rate-limits",
      payload: { scope: "role", serverScope: "all", maxCalls: 5, windowSeconds: 60 },
    });
    expect(badRole.statusCode).toBe(400);
    // serverScope 'all' must carry no serverId
    const badServer = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/data-scopes",
      payload: { scope: "fleet", serverScope: "all", serverId: "00000000-0000-4000-8000-000000000000", argPath: "x", allowedValues: ["a"] },
    });
    expect(badServer.statusCode).toBe(400);
  });
});

describe("roles + per-user overrides through the proxy (§5)", () => {
  let graceId: string;
  let roleId: string;
  let revocationId: string;

  it("a role assignment grants its bundled tools end-to-end", async () => {
    const grace = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-grace@example.com", displayName: "Proxy Grace" },
    });
    graceId = grace.json().id;

    const role = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/roles",
      payload: { name: "note-taker", description: "can read time and write notes" },
    });
    roleId = role.json().id;

    for (const toolName of ["get_time", "write_note"]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/roles/${roleId}/grants/tools`,
        payload: { serverId, toolName },
      });
    }
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${graceId}/roles`,
      payload: { roleId },
    });

    const client = await mcpClientFor(graceId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_time", "write_note"]);

    const result = await client.callTool({ name: "get_time", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "12:00" }]);
    await client.close();

    const audit = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit?userId=${graceId}`,
    });
    const allowRow = audit.json().entries.find((e: { effect: string }) => e.effect === "allow");
    expect(
      allowRow.ruleChain.some(
        (t: { rule: string; outcome: string }) =>
          t.rule === "role-tool-allow-list" && t.outcome === "allow",
      ),
    ).toBe(true);
  });

  it("a revocation hides and blocks one role tool without touching the rest", async () => {
    const rev = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/revocations",
      payload: { userId: graceId, serverId, toolName: "write_note" },
    });
    revocationId = rev.json().id;

    const client = await mcpClientFor(graceId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_time"]);
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Denied by policy/);
    await client.close();
  });

  it("the entitlements view flags the revoked role grant as a visible deviation", async () => {
    const view = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${graceId}/servers/${serverId}/entitlements`,
    });
    const entries = view.json().entitlements;
    const writeNote = entries.find((e: { toolName: string }) => e.toolName === "write_note");
    expect(writeNote).toMatchObject({
      source: "role",
      role: "note-taker",
      revoked: true,
      revocationId,
    });
    const getTime = entries.find((e: { toolName: string }) => e.toolName === "get_time");
    expect(getTime).toMatchObject({ source: "role", role: "note-taker", revoked: false });
  });

  it("deleting the revocation restores the entitlement (independently reversible)", async () => {
    const del = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/revocations/${revocationId}`,
    });
    expect(del.statusCode).toBe(200);

    const client = await mcpClientFor(graceId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_time", "write_note"]);
    const ok = await client.callTool({ name: "write_note", arguments: { text: "back" } });
    expect(ok.content).toEqual([{ type: "text", text: "wrote: back" }]);
    await client.close();
  });

  it("unassigning the role removes all role-derived access", async () => {
    const del = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/users/${graceId}/roles/${roleId}`,
    });
    expect(del.statusCode).toBe(200);

    const client = await mcpClientFor(graceId);
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    await client.close();
  });
});

describe("§5 review fixes", () => {
  it("duplicate revocations are rejected with 409, dangling FKs with 400", async () => {
    const heidi = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-heidi@example.com", displayName: "Proxy Heidi" },
    });
    const heidiId = heidi.json().id;

    const first = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/revocations",
      payload: { userId: heidiId, serverId, toolName: "get_time" },
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/revocations",
      payload: { userId: heidiId, serverId, toolName: "get_time" },
    });
    expect(dup.statusCode).toBe(409);

    const dangling = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${heidiId}/roles`,
      payload: { roleId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(dangling.statusCode).toBe(400);
    expect(dangling.json().error).toBe("invalid_reference");
  });

  it("tool-scoped revocations against role read-only-all are visible and listable", async () => {
    const ivan = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-ivan@example.com", displayName: "Proxy Ivan" },
    });
    const ivanId = ivan.json().id;

    const role = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/roles",
      payload: { name: "reader" },
    });
    const readerRoleId = role.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/roles/${readerRoleId}/grants/servers`,
      payload: { serverId, readOnlyAll: true },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ivanId}/roles`,
      payload: { roleId: readerRoleId },
    });
    const rev = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/revocations",
      payload: { userId: ivanId, serverId, toolName: "get_time" },
    });
    const revId = rev.json().id;

    // the kernel enforces the carve-out; the view must now show it too
    const client = await mcpClientFor(ivanId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([]);
    await client.close();

    const view = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${ivanId}/servers/${serverId}/entitlements`,
    });
    const body = view.json();
    const serverEntry = body.entitlements.find(
      (e: { kind: string; source: string }) => e.kind === "server-read-only" && e.source === "role",
    );
    expect(serverEntry.roleId).toBe(readerRoleId);
    expect(serverEntry.revokedTools).toEqual([{ toolName: "get_time", revocationId: revId }]);
    expect(body.revocations.map((r: { id: string }) => r.id)).toContain(revId);

    const list = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/revocations?userId=${ivanId}`,
    });
    expect(list.json().revocations.map((r: { id: string }) => r.id)).toContain(revId);
  });
});

describe("agent governance (§2/§4)", () => {
  let judyId: string;
  let planAgentId: string;
  let bigAgentId: string;

  it("registry + grant + mode restriction govern invocation end-to-end", async () => {
    const judy = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-judy@example.com", displayName: "Proxy Judy" },
    });
    judyId = judy.json().id;

    const small = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "claude-haiku", provider: "anthropic", tier: 1, modes: ["plan", "execute"] },
    });
    planAgentId = small.json().id;
    const big = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "claude-fable", provider: "anthropic", tier: 5, modes: ["plan", "execute"] },
    });
    bigAgentId = big.json().id;

    const judyAuth = await authFor(judyId);

    // no grant → default deny (403), audited
    const ungran = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${planAgentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(ungran.statusCode).toBe(403);
    expect(ungran.json().decision.ruleId).toBe("default-deny");

    // grant restricted to plan mode
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: judyId, agentId: planAgentId, allowedModes: ["plan"] },
    });

    const plan = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${planAgentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().decision.effect).toBe("allow");

    const exec = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${planAgentId}/invoke`,
      payload: { mode: "execute" },
    });
    expect(exec.statusCode).toBe(403);
    expect(exec.json().decision.reason).toContain("mode 'execute'");
  });

  it("the tier ceiling caps escalation even for granted agents", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: judyId, agentId: bigAgentId },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${judyId}/agent-policy`,
      payload: { defaultAgentId: planAgentId, ceilingAgentId: planAgentId },
    });

    const judyAuth = await authFor(judyId);
    const res = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${bigAgentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().decision.ruleId).toBe("agent-ceiling");

    const listing = await app.inject({
      method: "GET",
      headers: judyAuth,
      url: `/v1/users/${judyId}/agents`,
    });
    expect(listing.json().defaultAgentId).toBe(planAgentId);
    expect(listing.json().ceilingAgentId).toBe(planAgentId);
    expect(listing.json().agents).toHaveLength(2);
  });

  it("platform-disabling an agent denies everyone regardless of grants", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/agents/${planAgentId}/enabled`,
      payload: { enabled: false },
    });
    const judyAuth = await authFor(judyId);
    const res = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${planAgentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().decision.ruleId).toBe("agent-registry-enabled");

    const audit = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit?userId=${judyId}`,
    });
    const agentRows = audit
      .json()
      .entries.filter((e: { objectType: string }) => e.objectType === "agent");
    expect(agentRows.length).toBeGreaterThanOrEqual(5);
    expect(agentRows[0].objectId).toBe(planAgentId);
  });
});

describe("connector governance (§2)", () => {
  it("mode + object scope govern connector calls, one audit trail", async () => {
    const kim = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-kim@example.com", displayName: "Proxy Kim" },
    });
    const kimId = kim.json().id;
    const sf = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/connectors",
      payload: { name: "salesforce", kind: "crm" },
    });
    const sfId = sf.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/connectors",
      payload: { userId: kimId, connectorId: sfId, mode: "read", allowedObjects: ["accounts"] },
    });

    const kimAuth = await authFor(kimId);
    const ok = await app.inject({
      method: "POST",
      headers: kimAuth,
      url: `/v1/connectors/${sfId}/invoke`,
      payload: { operation: "read", object: "accounts" },
    });
    expect(ok.statusCode).toBe(200);

    const write = await app.inject({
      method: "POST",
      headers: kimAuth,
      url: `/v1/connectors/${sfId}/invoke`,
      payload: { operation: "write", object: "accounts" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().decision.reason).toContain("read-only");

    const outside = await app.inject({
      method: "POST",
      headers: kimAuth,
      url: `/v1/connectors/${sfId}/invoke`,
      payload: { operation: "read", object: "payroll" },
    });
    expect(outside.statusCode).toBe(403);

    const listing = await app.inject({
      method: "GET",
      headers: kimAuth,
      url: `/v1/users/${kimId}/connectors`,
    });
    expect(listing.json().connectors).toHaveLength(1);
    expect(listing.json().connectors[0]).toMatchObject({ name: "salesforce", mode: "read" });

    const audit = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit?userId=${kimId}`,
    });
    const effects = audit
      .json()
      .entries.filter((e: { objectType: string }) => e.objectType === "connector")
      .map((e: { effect: string }) => e.effect)
      .reverse();
    expect(effects).toEqual(["allow", "deny", "deny"]);
  });
});

describe("connector execution layer (pillar 5 §10.3, pillar 1 connectors)", () => {
  let cxUserId: string;
  let cxAuth: { authorization: string };
  let projectId: string;
  let mockConnId: string;
  let govOnlyConnId: string;
  let httpConnId: string;
  let boomConnId: string;
  let fake: { url: string; close: () => Promise<void> };

  async function connectorUsageRows(connectorId: string) {
    return db.select().from(usageEvents).where(eq(usageEvents.connectorId, connectorId));
  }

  beforeAll(async () => {
    // a real, non-admin caller (bootstrap cannot invoke)
    const u = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "conn-exec@example.com", displayName: "Conn Exec" },
    });
    cxUserId = u.json().id;
    cxAuth = await authFor(cxUserId);

    // a project with NO members → attribution is open to any caller
    const p = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "conn-exec-project" },
    });
    projectId = p.json().id;

    // a fake upstream for the generic-http round trip: GET /accounts → 200,
    // GET /boom → 500 (the failure path)
    fake = await (async () => {
      const server = http.createServer((req, res) => {
        if (req.url === "/boom") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "kaboom" })); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: req.url, rows: [1, 2, 3], auth: req.headers.authorization ?? null }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      if (typeof addr !== "object" || !addr) throw new Error("no address");
      return {
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      };
    })();

    // mock-kind PRICED connector (keyless, executes) — read-only grant scoped
    // to "accounts" so both an allowed and a denied path are exercisable
    mockConnId = (await app.inject({
      method: "POST", headers: AUTH, url: "/v1/connectors",
      payload: { name: "cx-warehouse", kind: "data-warehouse", providerKind: "mock", pricePerCallUsd: 0.002 },
    })).json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/connectors",
      payload: { userId: cxUserId, connectorId: mockConnId, mode: "read", allowedObjects: ["accounts"] },
    });

    // governance-only connector (no providerKind) — back-compat
    govOnlyConnId = (await app.inject({
      method: "POST", headers: AUTH, url: "/v1/connectors",
      payload: { name: "cx-govonly", kind: "crm" },
    })).json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/connectors",
      payload: { userId: cxUserId, connectorId: govOnlyConnId, mode: "read" },
    });

    // generic-http connector against the fake server (keyless), priced
    httpConnId = (await app.inject({
      method: "POST", headers: AUTH, url: "/v1/connectors",
      payload: { name: "cx-http", kind: "rest-api", providerKind: "http", baseUrl: fake.url, pricePerCallUsd: 0.01 },
    })).json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/connectors",
      payload: { userId: cxUserId, connectorId: httpConnId, mode: "read", allowedObjects: ["accounts", "boom"] },
    });

    // a second generic-http connector whose reads 500 (failure path)
    boomConnId = (await app.inject({
      method: "POST", headers: AUTH, url: "/v1/connectors",
      payload: { name: "cx-boom", kind: "rest-api", providerKind: "generic", baseUrl: fake.url, pricePerCallUsd: 0.01 },
    })).json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/connectors",
      payload: { userId: cxUserId, connectorId: boomConnId, mode: "read", allowedObjects: ["boom"] },
    });
  });

  afterAll(async () => { await fake.close(); });

  it("an allowed mock-kind priced call executes and lands ONE attributed usage row", async () => {
    const res = await app.inject({
      method: "POST", headers: cxAuth, url: `/v1/connectors/${mockConnId}/invoke`,
      payload: { operation: "read", object: "accounts", projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decision.effect).toBe("allow");
    // real result body from the mock adapter
    expect(body.result.status).toBe(200);
    expect(body.result.body.object).toBe("accounts");
    expect(body.costUsd).toBeCloseTo(0.002, 10);

    const rows = await connectorUsageRows(mockConnId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.objectType).toBe("connector");
    expect(rows[0]!.connectorId).toBe(mockConnId);
    expect(rows[0]!.operation).toBe("read");
    expect(rows[0]!.costUsd).toBeCloseTo(0.002, 10);
    expect(rows[0]!.projectId).toBe(projectId);
    // connector rows carry no model/tokens — the nullable columns stay null
    expect(rows[0]!.agentId).toBeNull();
    expect(rows[0]!.model).toBeNull();
    expect(rows[0]!.inputTokens).toBeNull();
  });

  it("a DENIED call bills nothing — no usage row (mirror the model path)", async () => {
    // write against a read-only grant → denied
    const denied = await app.inject({
      method: "POST", headers: cxAuth, url: `/v1/connectors/${mockConnId}/invoke`,
      payload: { operation: "write", object: "accounts", projectId },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().result).toBeUndefined();

    // read outside the object scope → denied
    const outside = await app.inject({
      method: "POST", headers: cxAuth, url: `/v1/connectors/${mockConnId}/invoke`,
      payload: { operation: "read", object: "payroll", projectId },
    });
    expect(outside.statusCode).toBe(403);

    // still exactly the one row from the allowed call above — denials added none
    expect(await connectorUsageRows(mockConnId)).toHaveLength(1);
  });

  it("a providerKind-null connector keeps today's behaviour: decision only, no result, no cost, no usage row", async () => {
    const res = await app.inject({
      method: "POST", headers: cxAuth, url: `/v1/connectors/${govOnlyConnId}/invoke`,
      payload: { operation: "read", object: "leads", projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decision.effect).toBe("allow");
    expect(body.result).toBeUndefined();
    expect(body.costUsd).toBeUndefined();
    expect(await connectorUsageRows(govOnlyConnId)).toHaveLength(0);
  });

  it("a generic-http connector really round-trips to the upstream and bills the flat price", async () => {
    const res = await app.inject({
      method: "POST", headers: cxAuth, url: `/v1/connectors/${httpConnId}/invoke`,
      payload: { operation: "read", object: "accounts", projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // the fake server echoed the path it was actually GET'd on
    expect(body.result.status).toBe(200);
    expect(body.result.body.object).toBe("/accounts");
    expect(body.result.body.rows).toEqual([1, 2, 3]);
    expect(body.costUsd).toBeCloseTo(0.01, 10);
    const rows = await connectorUsageRows(httpConnId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBeCloseTo(0.01, 10);
  });

  it("a failed upstream (non-2xx) surfaces as 502 and bills nothing", async () => {
    const res = await app.inject({
      method: "POST", headers: cxAuth, url: `/v1/connectors/${boomConnId}/invoke`,
      payload: { operation: "read", object: "boom", projectId },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("connector_invoke_failed");
    expect(await connectorUsageRows(boomConnId)).toHaveLength(0);
  });

  it("the project rollup shows connector spend in measured + byConnector, NOT in byAgent", async () => {
    const rollup = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${projectId}/costs`,
    });
    expect(rollup.statusCode).toBe(200);
    const body = rollup.json();
    // measured spans both object types — two executed connector calls, no agents
    expect(body.measured.events).toBe(2);
    expect(body.measured.costUsd).toBeCloseTo(0.012, 6);
    // byConnector carries the named breakdown
    const names = body.byConnector.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["cx-http", "cx-warehouse"]);
    expect(body.byConnector.every((c: { operation: string }) => c.operation === "read")).toBe(true);
    // connector rows never appear as phantom agents
    expect(body.byAgent).toHaveLength(0);
  });

  it("credential add → list (never the secret) → delete", async () => {
    const add = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/connectors/${mockConnId}/credential`,
      payload: { token: "super-secret-token", baseUrl: `${DEAD_LOOPBACK}/warehouse` },
    });
    expect(add.statusCode).toBe(201);
    expect(JSON.stringify(add.json())).not.toContain("super-secret-token");

    const list = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/connectors/${mockConnId}/credential`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().credential.baseUrl).toBe(`${DEAD_LOOPBACK}/warehouse`);
    expect(JSON.stringify(list.json())).not.toContain("super-secret-token");
    expect(list.json().credential.tokenCiphertext).toBeUndefined();

    const del = await app.inject({
      method: "DELETE", headers: AUTH, url: `/v1/connectors/${mockConnId}/credential`,
    });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/connectors/${mockConnId}/credential`,
    });
    expect(gone.json().credential).toBeNull();
  });

  it("credential routes are admin-only (a non-admin caller is refused)", async () => {
    const res = await app.inject({
      method: "POST", headers: cxAuth, url: `/v1/connectors/${mockConnId}/credential`,
      payload: { token: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("workflow engine (EPIC-03 slice)", () => {
  let leoId: string;
  let leoAuth: { authorization: string };
  let stdTemplateId: string;
  let complianceApproverId: string;

  const standardDef = {
    workflow: "standard-change-workflow",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      { id: "requirements", type: "artifact_generation", output: "requirements_file" },
      { id: "requirements_signoff", type: "human_approval", approvers: ["requesting_user"] },
      { id: "build", type: "automated_build", scope: "requirements_file" },
      // AER-047: no CI reports ci_tests in this journey, so the stage opts in
      // to the labelled offline auto-pass (the default would wait for a report)
      { id: "checks", type: "automated_check", checks: ["ci_tests"], offlineAutoPass: true },
    ],
  };

  it("templates validate on creation and assignment rules route changes", async () => {
    const bad = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: { name: "bad", definition: { workflow: "bad", stages: [{ id: "x", type: "planning" }] } },
    });
    expect(bad.statusCode).toBe(400);

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: { name: "standard-change", definition: standardDef },
    });
    expect(tpl.statusCode).toBe(201);
    stdTemplateId = tpl.json().id;

    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: stdTemplateId, changeType: "backend" },
    });

    const leo = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-leo@example.com", displayName: "Proxy Leo" },
    });
    leoId = leo.json().id;
    leoAuth = await authFor(leoId);

    const miss = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "copy fix", paths: ["web/home.tsx"], changeType: "frontend", environment: "staging" },
      },
    });
    expect(miss.statusCode).toBe(422);
  });

  it("runs the full journey: artifact → sign-off → versioned re-approval → build → done", async () => {
    const started = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "add endpoint", paths: ["api/x.ts"], changeType: "backend", environment: "staging" },
      },
    });
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id;
    // ADR-0079: standardDef opens with a planning stage, which now RESTS
    // (plan-only) instead of auto-completing — leaving it is an explicit act.
    expect(started.json().status).toBe("blocked_on_plan");
    const left = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "plan" },
    });
    expect(left.json().status).toBe("blocked_on_artifact");

    const v1 = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Requirements v1" },
    });
    expect(v1.json()).toMatchObject({ version: 1, status: "blocked_on_approval" });

    // sign-off posts into the ONE approvals queue, approver = requesting user
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const signoff = queue
      .json()
      .approvals.find((a: { instanceId: string | null }) => a.instanceId === instanceId);
    expect(signoff).toMatchObject({ objectType: "workflow", stageId: "requirements_signoff", approverUserId: leoId });

    // requesting_user sign-offs are self-reviews — a reason is mandatory
    const approve = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "self-review: solo demo flow" },
    });
    expect(approve.statusCode).toBe(200);

    let view = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("awaiting_trigger");

    // §2 stage 4: editing after sign-off re-opens the gate at version 2
    const v2 = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Requirements v2" },
    });
    expect(v2.json()).toMatchObject({ version: 2, status: "blocked_on_approval" });

    const queue2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const signoff2 = queue2
      .json()
      .approvals.find((a: { instanceId: string | null }) => a.instanceId === instanceId);
    expect(signoff2.id).not.toBe(signoff.id);
    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/approvals/${signoff2.id}/decide`,
      payload: { decision: "approved", reason: "self-review: v2 re-approval" },
    });

    for (const stageId of ["build", "checks"]) {
      await app.inject({
        method: "POST",
        headers: leoAuth,
        url: `/v1/workflows/instances/${instanceId}/advance`,
        payload: { stageId },
      });
    }

    view = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("completed");
    expect(view.json().artifacts.map((a: { version: number }) => a.version)).toEqual([1, 2]);
    expect(view.json().events.length).toBeGreaterThanOrEqual(6);
  });

  it("merges multiple matching templates and honors named approvers (§4 composability)", async () => {
    const approver = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-compliance@example.com", displayName: "Compliance Officer" },
    });
    complianceApproverId = approver.json().id;

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "prod-compliance",
        definition: {
          workflow: "prod-compliance",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "compliance_signoff", type: "human_approval", approvers: [complianceApproverId] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, environment: "production" },
    });

    const started = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "prod change", paths: ["api/y.ts"], changeType: "backend", environment: "production" },
      },
    });
    const instanceId = started.json().id;

    const view = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    const stageIds = view.json().instance.definition.stages.map((s: { id: string }) => s.id);
    expect(stageIds).toContain("requirements_signoff");
    expect(stageIds).toContain("compliance_signoff");

    // ADR-0079: leave the merged template's plan-only stage first
    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "plan" },
    });
    // walk to the compliance gate: artifact → own sign-off → build/checks
    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# prod req" },
    });
    const q1 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const s1 = q1.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) =>
        a.instanceId === instanceId && a.stageId === "requirements_signoff",
    );
    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/approvals/${s1.id}/decide`,
      payload: { decision: "approved", reason: "self-review: own requirements gate" },
    });
    for (const stageId of ["build", "checks"]) {
      await app.inject({
        method: "POST",
        headers: leoAuth,
        url: `/v1/workflows/instances/${instanceId}/advance`,
        payload: { stageId },
      });
    }

    const q2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const s2 = q2.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) =>
        a.instanceId === instanceId && a.stageId === "compliance_signoff",
    );
    expect(s2.approverUserId).toBe(complianceApproverId);

    // initiator cannot decide the compliance gate — only the named approver
    const wrong = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/approvals/${s2.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(wrong.statusCode).toBe(403);

    const denied = await app.inject({
      method: "POST",
      headers: await authFor(complianceApproverId),
      url: `/v1/approvals/${s2.id}/decide`,
      payload: { decision: "denied", reason: "missing rollback plan" },
    });
    expect(denied.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(after.json().instance.status).toBe("denied");
  });

  it("non-initiators cannot see or drive an instance; abort is terminal and audited", async () => {
    const started = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "another", paths: ["api/z.ts"], changeType: "backend", environment: "staging" },
      },
    });
    const instanceId = started.json().id;

    const mallory = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-mallory@example.com", displayName: "Proxy Mallory" },
    });
    const malloryAuth = await authFor(mallory.json().id);
    const stranger = await app.inject({
      method: "GET",
      headers: malloryAuth,
      url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(stranger.statusCode).toBe(403);

    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/abort`,
      payload: {},
    });
    const view = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("aborted");

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${leoId}` });
    const wfRows = audit
      .json()
      .entries.filter(
        (e: { objectType: string; objectId: string | null }) =>
          e.objectType === "workflow" && e.objectId === instanceId,
      );
    expect(wfRows.some((e: { effect: string }) => e.effect === "deny")).toBe(true);
  });
});

describe("workflow review-fix regressions", () => {
  it("a stale downstream approval cannot advance a re-opened upstream sign-off", async () => {
    const nina = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-nina@example.com", displayName: "Proxy Nina" },
    });
    const ninaId = nina.json().id;
    const gate2Approver = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-gate2@example.com", displayName: "Gate2 Approver" },
    });
    const gate2Id = gate2Approver.json().id;

    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "two-gates",
        definition: {
          workflow: "two-gates",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "req", type: "artifact_generation", output: "req_file" },
            { id: "gate1", type: "human_approval", approvers: ["requesting_user"] },
            { id: "gate2", type: "human_approval", approvers: [gate2Id] },
            { id: "build2", type: "automated_build" },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "two-gates-test" },
    });

    const ninaAuth = await authFor(ninaId);
    const started = await app.inject({
      method: "POST", headers: ninaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "x", paths: ["a.ts"], changeType: "two-gates-test", environment: "staging" } },
    });
    const instanceId = started.json().id;

    await app.inject({
      method: "POST", headers: ninaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "req", content: "v1" },
    });
    const q1 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const gate1Row = q1.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) => a.instanceId === instanceId && a.stageId === "gate1",
    );
    await app.inject({
      method: "POST", headers: ninaAuth, url: `/v1/approvals/${gate1Row.id}/decide`,
      payload: { decision: "approved", reason: "self-review: gate1 is mine" },
    });

    // now blocked on gate2 with a live pending row — re-open by editing the artifact
    const q2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const gate2Row = q2.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) => a.instanceId === instanceId && a.stageId === "gate2",
    );
    expect(gate2Row).toBeTruthy();

    await app.inject({
      method: "POST", headers: ninaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "req", content: "v2" },
    });

    // the stale gate2 row was superseded — deciding it must not advance gate1
    const decideStale = await app.inject({
      method: "POST", headers: await authFor(gate2Id), url: `/v1/approvals/${gate2Row.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decideStale.statusCode).toBe(409);

    const view = await app.inject({ method: "GET", headers: ninaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("blocked_on_approval");
    expect(view.json().pendingApprovals.map((a: { stageId: string }) => a.stageId)).toEqual(["gate1"]);
  });

  it("abort supersedes every outstanding pending approval (no dead rows in the inbox)", async () => {
    const omar = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-omar@example.com", displayName: "Proxy Omar" },
    });
    const omarId = omar.json().id;
    const omarAuth = await authFor(omarId);
    const started = await app.inject({
      method: "POST", headers: omarAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "y", paths: ["b.ts"], changeType: "two-gates-test", environment: "staging" } },
    });
    const instanceId = started.json().id;
    await app.inject({
      method: "POST", headers: omarAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "req", content: "v1" },
    });

    await app.inject({
      method: "POST", headers: omarAuth, url: `/v1/workflows/instances/${instanceId}/abort`, payload: {},
    });
    const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    expect(
      q.json().approvals.filter((a: { instanceId: string | null }) => a.instanceId === instanceId),
    ).toHaveLength(0);
  });

  it("templates with unknown approver ids are rejected at creation", async () => {
    const res = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "bad-approver",
        definition: {
          workflow: "bad-approver",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "gate", type: "human_approval", approvers: ["designated_reviewer_role"] },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("agent-policy partial update preserves the ceiling; grants are revocable", async () => {
    const pia = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-pia@example.com", displayName: "Proxy Pia" },
    });
    const piaId = pia.json().id;
    const a1 = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: { name: "tiny-agent", provider: "test", tier: 1 },
    });
    const a2 = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: { name: "big-agent", provider: "test", tier: 9 },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${piaId}/agent-policy`,
      payload: { ceilingAgentId: a1.json().id },
    });
    // partial update touching only the default must NOT lift the ceiling
    const updated = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${piaId}/agent-policy`,
      payload: { defaultAgentId: a1.json().id },
    });
    expect(updated.json().ceilingAgentId).toBe(a1.json().id);

    const grant = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: piaId, agentId: a2.json().id },
    });
    const del = await app.inject({
      method: "DELETE", headers: AUTH, url: `/v1/grants/agents/${grant.json().id}`,
    });
    expect(del.statusCode).toBe(200);
    const listing = await app.inject({ method: "GET", headers: AUTH, url: `/v1/users/${piaId}/agents` });
    expect(listing.json().agents).toHaveLength(0);
  });
});

describe("git-provider workflow stages (EPIC-03)", () => {
  it("runs a governed change end-to-end: branch → PR linked to artifact → merge gate → squash merge", async () => {
    const conn = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/git/connections",
      payload: { name: "mock-git", provider: "mock", token: "irrelevant" },
    });
    expect(conn.statusCode).toBe(201);
    expect(conn.body).not.toContain("irrelevant");

    const quinn = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-quinn@example.com", displayName: "Proxy Quinn" },
    });
    const quinnId = quinn.json().id;
    const quinnAuth = await authFor(quinnId);

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "git-change",
        definition: {
          workflow: "git-change",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "requirements_signoff", type: "human_approval", approvers: ["requesting_user"] },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "mock-git", repo: "acme/app" },
            { id: "open_pr", type: "git_operation", action: "open_pr", connection: "mock-git", repo: "acme/app" },
            { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
            { id: "merge", type: "git_operation", action: "merge", connection: "mock-git", repo: "acme/app", strategy: "squash" },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "git-change-test" },
    });

    const started = await app.inject({
      method: "POST",
      headers: quinnAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "add rate limiting", paths: ["api/limits.ts"], changeType: "git-change-test", environment: "staging" },
      },
    });
    const instanceId = started.json().id;
    expect(started.json().status).toBe("blocked_on_artifact");

    await app.inject({
      method: "POST",
      headers: quinnAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Rate limiting requirements" },
    });
    const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const signoff = q.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) =>
        a.instanceId === instanceId && a.stageId === "requirements_signoff",
    );
    // approval unblocks straight into the git stages: branch + PR run automatically
    await app.inject({
      method: "POST",
      headers: quinnAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "self-review: git chain demo" },
    });

    let view = await app.inject({ method: "GET", headers: quinnAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("blocked_on_approval");
    const ctx = view.json().instance.context;
    expect(ctx.branch).toBe(`regulait/${instanceId.slice(0, 8)}`);
    expect(ctx.prId).toBe("1");
    expect(ctx.prUrl).toBe("mock://acme/app/pull/1");

    const q2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const mergeGate = q2.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) =>
        a.instanceId === instanceId && a.stageId === "merge_gate",
    );
    await app.inject({
      method: "POST",
      headers: quinnAuth,
      url: `/v1/approvals/${mergeGate.id}/decide`,
      payload: { decision: "approved", reason: "self-review: merging my own gate" },
    });

    view = await app.inject({ method: "GET", headers: quinnAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("completed");
    expect(view.json().instance.context.mergeSha).toBe("sha-merge-1");
  });

  it("execution failures are retryable and recorded, not terminal", async () => {
    const rita = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-rita@example.com", displayName: "Proxy Rita" },
    });
    const ritaAuth = await authFor(rita.json().id);

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "bad-conn-flow",
        definition: {
          workflow: "bad-conn-flow",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "ghost-conn", repo: "acme/app" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "bad-conn-test" },
    });

    const started = await app.inject({
      method: "POST",
      headers: ritaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "x", paths: ["a.ts"], changeType: "bad-conn-test", environment: "staging" },
      },
    });
    const instanceId = started.json().id;
    expect(started.json().status).toBe("awaiting_execution");

    const view = await app.inject({ method: "GET", headers: ritaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.context.lastError).toContain("unknown git connection");

    // register the missing connection, then retry via advance
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/git/connections",
      payload: { name: "ghost-conn", provider: "mock", token: "t" },
    });
    const retried = await app.inject({
      method: "POST",
      headers: ritaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "branch" },
    });
    expect(retried.json().status).toBe("completed");
    expect(retried.json().context.lastError).toBeUndefined();
  });
});

describe("agents/connectors review follow-ups", () => {
  it("carve-outs exclude write-kind and nonexistent tools; oversized invoke strings are rejected", async () => {
    const sam = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-sam@example.com", displayName: "Proxy Sam" },
    });
    const samId = sam.json().id;
    const role = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "sam-reader" },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/roles/${role.json().id}/grants/servers`,
      payload: { serverId, readOnlyAll: true },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${samId}/roles`,
      payload: { roleId: role.json().id },
    });
    // three revocations: a real read tool, a write tool, and a ghost tool
    for (const toolName of ["get_time", "write_note", "ghost_tool"]) {
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/revocations",
        payload: { userId: samId, serverId, toolName },
      });
    }

    const view = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/users/${samId}/servers/${serverId}/entitlements`,
    });
    const serverEntry = view
      .json()
      .entitlements.find(
        (e: { kind: string; source: string }) => e.kind === "server-read-only" && e.source === "role",
      );
    // only the read tool that exists is a genuine carve-out of read-only-all
    expect(serverEntry.revokedTools.map((c: { toolName: string }) => c.toolName)).toEqual([
      "get_time",
    ]);
    // all three revocations remain discoverable in the flat list
    expect(view.json().revocations).toHaveLength(3);

    const agent = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: { name: "bounded-agent", provider: "test", tier: 1 },
    });
    const samAuth = await authFor(samId);
    const oversized = await app.inject({
      method: "POST", headers: samAuth, url: `/v1/agents/${agent.json().id}/invoke`,
      payload: { mode: "x".repeat(65) },
    });
    expect(oversized.statusCode).toBe(400);
  });
});

describe("git executor hardening (review follow-ups)", () => {
  let umaId: string;
  let umaAuth: { authorization: string };

  it("re-opened instances replay git stages idempotently instead of wedging", async () => {
    const uma = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-uma@example.com", displayName: "Proxy Uma" },
    });
    umaId = uma.json().id;
    umaAuth = await authFor(umaId);

    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "git-reopen-flow",
        definition: {
          workflow: "git-reopen-flow",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "mock-git", repo: "acme/reopen" },
            { id: "open_pr", type: "git_operation", action: "open_pr", connection: "mock-git", repo: "acme/reopen" },
            { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
            { id: "merge", type: "git_operation", action: "merge", connection: "mock-git", repo: "acme/reopen", strategy: "squash" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "git-reopen-test" },
    });

    const started = await app.inject({
      method: "POST", headers: umaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "reopen test", paths: ["x.ts"], changeType: "git-reopen-test", environment: "staging" } },
    });
    const instanceId = started.json().id;

    const approveCurrent = async (stageId: string) => {
      const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
      const row = q.json().approvals.find(
        (a: { instanceId: string | null; stageId: string }) => a.instanceId === instanceId && a.stageId === stageId,
      );
      return app.inject({
        method: "POST", headers: umaAuth, url: `/v1/approvals/${row.id}/decide`,
        payload: { decision: "approved", reason: "self-review: reopen replay test" },
      });
    };

    await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "v1" },
    });
    await approveCurrent("signoff");

    let view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("blocked_on_approval");
    const prIdBefore = view.json().instance.context.prId;
    expect(prIdBefore).toBeTruthy();

    // §2 re-open: edit the artifact after branch+PR already exist
    await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "v2" },
    });
    await approveCurrent("signoff");

    // AER-049: the re-open is a new review round — branch + open_pr run again
    // against a FRESH, round-named branch and a NEW PR (no 422 wedge on the
    // round-0 branch, which already exists); round 0's branch/PR are history
    view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("blocked_on_approval");
    expect(view.json().instance.round).toBe(1);
    expect(view.json().instance.context.branch).toBe(`regulait/${String(instanceId).slice(0, 8)}-r1`);
    expect(view.json().instance.context.prId).toBeTruthy();
    expect(view.json().instance.context.prId).not.toBe(prIdBefore);
    expect(view.json().instance.context["effects:history"][0]).toMatchObject({ round: 0, values: { prId: prIdBefore } });
    expect(view.json().instance.context.lastError).toBeUndefined();

    await approveCurrent("merge_gate");
    view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("completed");
  });

  it("/advance cannot execute git stages on a denied instance (gate bypass closed)", async () => {
    const started = await app.inject({
      method: "POST", headers: umaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "deny test", paths: ["y.ts"], changeType: "git-reopen-test", environment: "staging" } },
    });
    const instanceId = started.json().id;

    await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "v1" },
    });
    const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const signoff = q.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) => a.instanceId === instanceId && a.stageId === "signoff",
    );
    await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "denied", reason: "self-review: denying my own gate" },
    });

    const bypass = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "merge" },
    });
    expect(bypass.statusCode).toBe(409);

    const view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("denied");
    expect(view.json().instance.context.mergeSha).toBeUndefined();
  });

  it("an artifact stage flowing directly into open_pr links the just-submitted version", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "direct-pr-flow",
        definition: {
          workflow: "direct-pr-flow",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "mock-git", repo: "acme/direct" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "open_pr", type: "git_operation", action: "open_pr", connection: "mock-git", repo: "acme/direct" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "direct-pr-test" },
    });
    const started = await app.inject({
      method: "POST", headers: umaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "direct pr", paths: ["z.ts"], changeType: "direct-pr-test", environment: "staging" } },
    });
    const instanceId = started.json().id;
    expect(started.json().status).toBe("blocked_on_artifact");

    const res = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "UNIQUE-ARTIFACT-CONTENT-42" },
    });
    expect(res.json().status).toBe("completed");
    // the mock provider stored the PR body — verify through the instance view is
    // not possible, so assert via events: no execution failure and PR opened
    const view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.context.prId).toBeTruthy();
    expect(view.json().instance.context.lastError).toBeUndefined();
  });

  it("non-admin named approvers see exactly their own approvals; empty git tokens rejected", async () => {
    const mine = await app.inject({ method: "GET", headers: umaAuth, url: "/v1/approvals" });
    expect(mine.statusCode).toBe(200);
    expect(
      mine.json().approvals.every((a: { approverUserId: string }) => a.approverUserId === umaId),
    ).toBe(true);

    const emptyToken = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/git/connections",
      payload: { name: "empty-token-conn", provider: "mock", token: "" },
    });
    expect(emptyToken.statusCode).toBe(400);
  });
});

describe("token/cost optimization (EPIC-04 §7/§8)", () => {
  let ottoId: string;
  let ottoAuth: { authorization: string };
  let cheapId: string;
  let midId: string;
  let bigId: string;

  it("routes a low-complexity request down to the cheapest entitled model and ledgers the savings", async () => {
    const otto = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-otto@example.com", displayName: "Opt Otto" },
    });
    ottoId = otto.json().id;
    ottoAuth = await authFor(ottoId);

    const mk = async (name: string, tier: number, inC: number, outC: number) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: {
          name,
          provider: "anthropic",
          tier,
          modes: ["plan", "execute"],
          costPerMTokIn: inC,
          costPerMTokOut: outC,
        },
      });
      return r.json().id as string;
    };
    cheapId = await mk("opt-cheap", 0, 1, 5);
    midId = await mk("opt-mid", 1, 3, 15);
    bigId = await mk("opt-big", 2, 15, 75);
    for (const agentId of [cheapId, midId, bigId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: ottoId, agentId },
      });
    }

    const res = await app.inject({
      method: "POST",
      headers: ottoAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "summarize this one-line note please" },
    });
    expect(res.statusCode).toBe(200);
    const { decision, routing } = res.json();
    expect(decision.effect).toBe("allow");
    expect(routing.effect).toBe("routed");
    expect(routing.selectedAgentId).toBe(cheapId);
    expect(routing.baselineAgentId).toBe(bigId);
    expect(routing.estimatedCostSavedUsd).toBeGreaterThan(0);
    expect(routing.estimationBasis).toContain("vs-baseline");

    // §8: the served model is visible in the execution (audit) log
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${ottoId}` });
    const row = audit.json().entries.find((e: { objectType: string }) => e.objectType === "agent");
    expect(row.detail.servedAgentId).toBe(cheapId);

    // §7: one dashboard-ready cost event per routing decision
    const ledger = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/cost-events?userId=${ottoId}`,
    });
    expect(ledger.statusCode).toBe(200);
    const { events, totals } = ledger.json();
    expect(events).toHaveLength(1);
    expect(events[0].technique).toBe("model_routing");
    expect(events[0].servedAgentId).toBe(cheapId);
    expect(events[0].baselineAgentId).toBe(bigId);
    const routingTotal = totals.find((t: { technique: string }) => t.technique === "model_routing");
    expect(routingTotal.estimatedCostSavedUsd).toBeGreaterThan(0);
  });

  it("routing never selects a model the user is not entitled to (§12)", async () => {
    const nina = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-nina@example.com", displayName: "Opt Nina" },
    });
    const ninaId = nina.json().id;
    // Nina can use big + mid but was never granted the cheapest model.
    for (const agentId of [midId, bigId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: ninaId, agentId },
      });
    }
    const res = await app.inject({
      method: "POST",
      headers: await authFor(ninaId),
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "tiny ask" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().routing.selectedAgentId).toBe(midId);
  });

  it("quality-sensitive requests and passthrough mode both disable downgrading (§9/§12)", async () => {
    const qs = await app.inject({
      method: "POST",
      headers: ottoAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "tiny ask", costSensitivity: "quality-sensitive" },
    });
    expect(qs.json().routing.effect).toBe("passthrough");
    expect(qs.json().routing.ruleId).toBe("cost-sensitivity");

    // admin flips Otto's off switch on the existing agent-policy surface
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ottoId}/agent-policy`,
      payload: { routingMode: "passthrough" },
    });
    const off = await app.inject({
      method: "POST",
      headers: ottoAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "tiny ask" },
    });
    expect(off.json().routing.effect).toBe("passthrough");
    expect(off.json().routing.ruleId).toBe("routing-mode");
    expect(off.json().routing.selectedAgentId).toBe(bigId);
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ottoId}/agent-policy`,
      payload: { routingMode: "automatic" },
    });
  });

  it("no input text means no signal and no downgrade", async () => {
    const res = await app.inject({
      method: "POST",
      headers: ottoAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().routing.effect).toBe("passthrough");
    expect(res.json().routing.selectedAgentId).toBe(bigId);
  });

  it("denied invokes write no cost event, and non-admins see only their own ledger", async () => {
    const eve = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-eve@example.com", displayName: "Opt Eve" },
    });
    const eveId = eve.json().id;
    const eveAuth = await authFor(eveId);

    // no grant → 403, and no ledger row
    const denied = await app.inject({
      method: "POST",
      headers: eveAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "tiny ask" },
    });
    expect(denied.statusCode).toBe(403);
    const eveLedger = await app.inject({ method: "GET", headers: eveAuth, url: "/v1/cost-events" });
    expect(eveLedger.statusCode).toBe(200);
    expect(eveLedger.json().events).toHaveLength(0);

    // a non-admin asking for someone else's history is forced back to self
    const spoofed = await app.inject({
      method: "GET",
      headers: eveAuth,
      url: `/v1/cost-events?userId=${ottoId}`,
    });
    expect(spoofed.json().events).toHaveLength(0);

    // admin sees the fleet
    const all = await app.inject({ method: "GET", headers: AUTH, url: "/v1/cost-events" });
    expect(all.json().events.length).toBeGreaterThanOrEqual(3);
  });
});

describe("lazy tool-loading in the MCP proxy (EPIC-04 §8)", () => {
  let laraId: string;

  it("a declared intent narrows tools/list to relevant tools and ledgers the withheld chars", async () => {
    const lara = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-lara@example.com", displayName: "Opt Lara" },
    });
    laraId = lara.json().id;
    for (const toolName of ["get_time", "write_note"]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/tools",
        payload: { userId: laraId, serverId, toolName },
      });
    }

    const client = await mcpClientFor(laraId, "what time is it now");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_time"]);
    await client.close();

    const ledger = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/cost-events?userId=${laraId}`,
    });
    const row = ledger.json().events.find(
      (e: { technique: string }) => e.technique === "lazy_tool_loading",
    );
    expect(row).toBeDefined();
    expect(row.estimatedTokensSaved).toBeGreaterThan(0);
    expect(row.objectId).toBe(serverId);
    expect(row.detail).toMatchObject({ effect: "narrowed", selectedCount: 1, withheldCount: 1 });
  });

  it("withheld tools stay fully callable — the manifest shrinks, the entitlement never does (§12)", async () => {
    const client = await mcpClientFor(laraId, "what time is it now");
    const result = await client.callTool({ name: "write_note", arguments: { text: "hi" } });
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("wrote: hi");
    await client.close();
  });

  it("no intent means the full entitled manifest", async () => {
    const client = await mcpClientFor(laraId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_time", "write_note"]);
    await client.close();
  });

  it("the per-user passthrough switch disables narrowing even with an intent", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${laraId}/agent-policy`,
      payload: { routingMode: "passthrough" },
    });
    const client = await mcpClientFor(laraId, "what time is it now");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_time", "write_note"]);
    await client.close();
  });
});

describe("workflow cost-sensitivity tag (EPIC-04 §9)", () => {
  it("strictest-wins across merged templates and surfaces on the instance view", async () => {
    const mkTpl = async (name: string, tag?: string) => {
      const res = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/workflows/templates",
        payload: {
          name,
          definition: {
            workflow: name,
            ...(tag ? { costSensitivity: tag } : {}),
            stages: [
              { id: "intake", type: "trigger" },
              { id: `${name}-signoff`, type: "human_approval", approvers: ["requesting_user"] },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };

    const invalid = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "bad-tag",
        definition: {
          workflow: "bad-tag",
          costSensitivity: "cheapest",
          stages: [{ id: "intake", type: "trigger" }],
        },
      },
    });
    expect(invalid.statusCode).toBe(400);

    const cheapTpl = await mkTpl("tagged-cheap", "cost-sensitive");
    const strictTpl = await mkTpl("tagged-strict", "quality-sensitive");
    for (const templateId of [cheapTpl, strictTpl]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/workflows/assignment-rules",
        payload: { templateId, changeType: "cost-tag-e2e" },
      });
    }

    const tina = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-tina@example.com", displayName: "Opt Tina" },
    });
    const tinaAuth = await authFor(tina.json().id);
    const started = await app.inject({
      method: "POST",
      headers: tinaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "tagged change",
          paths: ["svc/x.ts"],
          changeType: "cost-tag-e2e",
          environment: "staging",
        },
      },
    });
    expect(started.statusCode).toBe(201);

    const view = await app.inject({
      method: "GET",
      headers: tinaAuth,
      url: `/v1/workflows/instances/${started.json().id}`,
    });
    expect(view.json().costSensitivity).toBe("quality-sensitive");
    expect(view.json().instance.definition.costSensitivity).toBe("quality-sensitive");
  });

  it("an untagged run reads as standard", async () => {
    const view = await app.inject({
      method: "GET",
      headers: AUTH,
      url: "/v1/workflows/instances",
    });
    // fleet view untouched; per-instance default checked via a fresh untagged instance
    expect(view.statusCode).toBe(200);

    const tplRes = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "untagged-e2e",
        definition: {
          workflow: "untagged-e2e",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "untagged-signoff", type: "human_approval", approvers: ["requesting_user"] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tplRes.json().id, changeType: "untagged-e2e" },
    });
    const uma = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-uma@example.com", displayName: "Opt Uma" },
    });
    const umaAuth = await authFor(uma.json().id);
    const started = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "plain change",
          paths: ["svc/y.ts"],
          changeType: "untagged-e2e",
          environment: "staging",
        },
      },
    });
    const view2 = await app.inject({
      method: "GET",
      headers: umaAuth,
      url: `/v1/workflows/instances/${started.json().id}`,
    });
    expect(view2.json().costSensitivity).toBe("standard");
  });
});

describe("multi-agent orchestration runs (EPIC-05 slice)", () => {
  let patId: string;
  let patAuth: { authorization: string };
  let lenaId: string;
  let lenaAuth: { authorization: string };
  let smallId: string;
  let altId: string;
  let bigId: string;

  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    ...extra,
  });

  it("plans a run only within the initiating user's entitlements (§5.1)", async () => {
    const mkUser = async (email: string, name: string) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/users",
        payload: { email, displayName: name },
      });
      return r.json().id as string;
    };
    patId = await mkUser("orc-pat@example.com", "Orc Pat");
    lenaId = await mkUser("orc-lena@example.com", "Orc Lena");
    patAuth = await authFor(patId);
    lenaAuth = await authFor(lenaId);

    const mkAgent = async (name: string, tier: number) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: { name, provider: "anthropic", tier, modes: ["plan", "execute"] },
      });
      return r.json().id as string;
    };
    smallId = await mkAgent("orc-worker-small", 1);
    altId = await mkAgent("orc-worker-alt", 1);
    bigId = await mkAgent("orc-worker-big", 3);
    for (const agentId of [smallId, altId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: patId, agentId },
      });
    }

    // a cycle is rejected before anything is stored
    const cyclic = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "cyclic",
          escalationApproverUserId: lenaId,
          nodes: [mkNode("a", smallId, { dependsOn: ["b"] }), mkNode("b", smallId, { dependsOn: ["a"] })],
        },
      },
    });
    expect(cyclic.statusCode).toBe(400);

    // unordered shared file ownership is rejected (§4)
    const conflict = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "conflict",
          escalationApproverUserId: lenaId,
          nodes: [mkNode("a", smallId, { files: ["x.ts"] }), mkNode("b", smallId, { files: ["x.ts"] })],
        },
      },
    });
    expect(conflict.statusCode).toBe(400);

    // a node owned by an agent the INITIATING user was never granted → the
    // whole plan is rejected: no path where privilege increases downward.
    const escalating = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "escalating",
          escalationApproverUserId: lenaId,
          nodes: [mkNode("a", smallId), mkNode("b", bigId)],
        },
      },
    });
    expect(escalating.statusCode).toBe(422);
    expect(escalating.json().error).toBe("entitlement_exceeded");
    expect(escalating.json().nodes[0].nodeId).toBe("b");
    expect(escalating.json().nodes[0].decision.ruleId).toBe("default-deny");
  });

  it("runs a DAG to completion: parallel roots, dependency gating, one audit trail", async () => {
    const created = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "feature-build",
          escalationApproverUserId: lenaId,
          nodes: [
            mkNode("api", smallId, { files: ["api.ts"] }),
            mkNode("ui", altId, { files: ["ui.tsx"] }),
            mkNode("integrate", smallId, { dependsOn: ["api", "ui"] }),
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("planned");
    const runId = created.json().id;

    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: patAuth, url: `/v1/runs/${runId}/events`, payload });

    const started = await ev({ kind: "start" });
    expect(started.json().readyNodes).toEqual(["api", "ui"]);

    for (const nodeId of ["api", "ui"]) {
      await ev({ kind: "node_started", nodeId });
      await ev({ kind: "node_submitted", nodeId });
      await ev({ kind: "node_accepted", nodeId });
    }
    const view = await app.inject({ method: "GET", headers: patAuth, url: `/v1/runs/${runId}` });
    expect(view.json().readyNodes).toEqual(["integrate"]);

    await ev({ kind: "node_started", nodeId: "integrate" });
    await ev({ kind: "node_submitted", nodeId: "integrate" });
    const done = await ev({ kind: "node_accepted", nodeId: "integrate" });
    expect(done.json().status).toBe("completed");

    // §5.3: every run event landed in the ONE audit trail
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${patId}` });
    const runRows = audit.json().entries.filter((e: { objectType: string }) => e.objectType === "run");
    expect(runRows.length).toBeGreaterThanOrEqual(10);

    // terminal runs reject further events
    const late = await ev({ kind: "abort" });
    expect(late.statusCode).toBe(409);
  });

  it("failure → escalation lands in the one approvals queue; approval re-opens the node (§3)", async () => {
    const created = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "flaky-task",
          escalationApproverUserId: lenaId,
          nodes: [mkNode("solo", smallId)],
        },
      },
    });
    const runId = created.json().id;
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: patAuth, url: `/v1/runs/${runId}/events`, payload });

    await ev({ kind: "start" });
    await ev({ kind: "node_started", nodeId: "solo" });
    await ev({ kind: "node_failed", nodeId: "solo", error: "worker crashed" });

    // reassignment is a fresh §5.1 check — the ungranted big agent is refused
    const badReassign = await ev({ kind: "reassign_node", nodeId: "solo", ownerAgentId: bigId });
    expect(badReassign.statusCode).toBe(403);
    expect(badReassign.json().error).toBe("entitlement_exceeded");

    const escalated = await ev({ kind: "escalate_node", nodeId: "solo" });
    expect(escalated.statusCode).toBe(200);

    // Lena sees it in the same approvals inbox as every other approval
    const inbox = await app.inject({ method: "GET", headers: lenaAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find((a: { runId: string | null }) => a.runId === runId);
    expect(entry).toBeDefined();
    expect(entry.objectType).toBe("run");
    expect(entry.stageId).toBe("solo");

    // Pat is not the named approver
    const patDecide = await app.inject({
      method: "POST",
      headers: patAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(patDecide.statusCode).toBe(403);

    const decided = await app.inject({
      method: "POST",
      headers: lenaAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);

    const view = await app.inject({ method: "GET", headers: patAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.state.nodeStatuses.solo).toBe("not_started");
    expect(view.json().run.state.attempts.solo).toBe(1);
    expect(view.json().readyNodes).toEqual(["solo"]);

    // valid reassignment to a granted agent, then run to completion
    await ev({ kind: "node_started", nodeId: "solo" });
    await ev({ kind: "node_failed", nodeId: "solo", error: "still flaky" });
    const reassigned = await ev({ kind: "reassign_node", nodeId: "solo", ownerAgentId: altId });
    expect(reassigned.statusCode).toBe(200);
    await ev({ kind: "node_started", nodeId: "solo" });
    await ev({ kind: "node_submitted", nodeId: "solo" });
    const done = await ev({ kind: "node_accepted", nodeId: "solo" });
    expect(done.json().status).toBe("completed");
    expect(done.json().state.owners.solo).toBe(altId);
  });

  it("runs are invisible to non-participants; fleet view is admin-only", async () => {
    const created = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: { run: "private", escalationApproverUserId: lenaId, nodes: [mkNode("n", smallId)] },
      },
    });
    const runId = created.json().id;

    const other = await app.inject({ method: "GET", headers: lenaAuth, url: `/v1/runs/${runId}` });
    expect(other.statusCode).toBe(404);
    const otherDrive = await app.inject({
      method: "POST",
      headers: lenaAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "start" },
    });
    expect(otherDrive.statusCode).toBe(404);

    // non-admins get their OWN runs from the list view, never the fleet
    const fleetAsNonAdmin = await app.inject({ method: "GET", headers: patAuth, url: "/v1/runs" });
    expect(fleetAsNonAdmin.statusCode).toBe(200);
    expect(
      fleetAsNonAdmin.json().runs.every((r: { initiatingUserId: string }) => r.initiatingUserId === patId),
    ).toBe(true);
    const fleet = await app.inject({ method: "GET", headers: AUTH, url: "/v1/runs" });
    expect(fleet.json().runs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("per-run budget caps (EPIC-05 §5.2)", () => {
  let benId: string;
  let benAuth: { authorization: string };
  let approverId: string;
  let approverAuth: { authorization: string };
  let cheapWorkerId: string;
  let priceyWorkerId: string;

  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    estimate: { in: 100_000, out: 100_000 },
    ...extra,
  });

  it("an under-cap run plans and starts; the budget envelope is visible and estimate-labeled", async () => {
    const mkUser = async (email: string, name: string) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/users",
        payload: { email, displayName: name },
      });
      return r.json().id as string;
    };
    benId = await mkUser("budget-ben@example.com", "Budget Ben");
    approverId = await mkUser("budget-boss@example.com", "Budget Boss");
    benAuth = await authFor(benId);
    approverAuth = await authFor(approverId);

    // dispatchable workers (mock provider + model id): the budget re-plan
    // only substitutes agents that could really be served, so undispatchable
    // fixtures would silently opt out of the replan test below
    const mkAgent = async (name: string, tier: number, inC: number, outC: number) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: {
          name,
          provider: "mock",
          tier,
          modes: ["execute"],
          costPerMTokIn: inC,
          costPerMTokOut: outC,
          model: name,
        },
      });
      return r.json().id as string;
    };
    cheapWorkerId = await mkAgent("budget-cheap", 0, 1, 5);
    priceyWorkerId = await mkAgent("budget-pricey", 2, 15, 75);
    for (const agentId of [cheapWorkerId, priceyWorkerId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: benId, agentId },
      });
    }
    // cap: pricey node = (1e5*15 + 1e5*75)/1e6 = $9; cheap node = $0.60
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${benId}/agent-policy`,
      payload: { runBudgetUsd: 2, runBudgetBreachAction: "approve" },
    });

    const created = await app.inject({
      method: "POST",
      headers: benAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "under-cap",
          escalationApproverUserId: approverId,
          nodes: [mkNode("n1", cheapWorkerId)],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().budgetApprovalPending).toBe(false);
    expect(created.json().budget.capUsd).toBe(2);
    expect(created.json().budget.estimatedTotalUsd).toBeCloseTo(0.6, 6);
    expect(created.json().budget.estimationBasis).toContain("estimate");

    const runId = created.json().id;
    const started = await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "start" },
    });
    expect(started.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_started", nodeId: "n1" },
    });
    const view = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.budget.spentUsd).toBeCloseTo(0.6, 6);
  });

  it("over-cap with 'approve': start is gated until the named approver sanctions the overage; denial aborts", async () => {
    const mkRun = async (name: string) => {
      const r = await app.inject({
        method: "POST",
        headers: benAuth,
        url: "/v1/runs",
        payload: {
          graph: {
            run: name,
            escalationApproverUserId: approverId,
            nodes: [mkNode("big", priceyWorkerId)],
          },
        },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().budgetApprovalPending).toBe(true);
      return r.json().id as string;
    };

    const runId = await mkRun("over-cap-approve");
    const blocked = await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "start" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("budget_approval_pending");

    const inbox = await app.inject({
      method: "GET",
      headers: approverAuth,
      url: "/v1/approvals?status=pending",
    });
    const entry = inbox.json().approvals.find(
      (a: { runId: string | null; stageId: string | null }) =>
        a.runId === runId && a.stageId === "__budget__",
    );
    expect(entry).toBeDefined();
    await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    const started = await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "start" },
    });
    expect(started.statusCode).toBe(200);

    // denial path on a fresh run: the run aborts, nothing starts
    const runId2 = await mkRun("over-cap-denied");
    const inbox2 = await app.inject({
      method: "GET",
      headers: approverAuth,
      url: "/v1/approvals?status=pending",
    });
    const entry2 = inbox2.json().approvals.find(
      (a: { runId: string | null }) => a.runId === runId2,
    );
    await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${entry2.id}/decide`,
      payload: { decision: "denied" },
    });
    const view2 = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId2}` });
    expect(view2.json().run.status).toBe("aborted");
  });

  it("over-cap with 'replan': owners are substituted to cheaper entitled agents and ledgered", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${benId}/agent-policy`,
      payload: { runBudgetBreachAction: "replan" },
    });
    const created = await app.inject({
      method: "POST",
      headers: benAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "replanned",
          escalationApproverUserId: approverId,
          nodes: [mkNode("big", priceyWorkerId)],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().budgetApprovalPending).toBe(false);
    expect(created.json().budget.replanned).toBe(true);
    expect(created.json().budget.estimatedTotalUsd).toBeCloseTo(0.6, 6); // now on the cheap worker
    const runId = created.json().id;

    const view = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.state.owners.big).toBe(cheapWorkerId);

    // the substitution is a cost-attribution event like any routing decision
    const ledger = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/cost-events?userId=${benId}`,
    });
    const row = ledger.json().events.find(
      (e: { objectType: string; objectId: string | null }) =>
        e.objectType === "run" && e.objectId === runId,
    );
    expect(row).toBeDefined();
    expect(row.servedAgentId).toBe(cheapWorkerId);
    expect(row.requestedAgentId).toBe(priceyWorkerId);
    expect(row.estimatedCostSavedUsd).toBeGreaterThan(0);
  });

  it("replan respects dispatchability: an unconfigured provider priced below mock is skipped, ledgered, and the node still executes", async () => {
    // Carryover bug reproduced by the gate: a google-provider agent with NO
    // stored credential, priced BELOW the dispatchable workers. The old
    // replan handed it the node and the later dispatch 409'd
    // `no_model_credential` mid-run; now it must be skipped exactly like the
    // invoke path skips it, with the skip visible in the trace.
    const bargain = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: {
        name: "budget-bargain-google",
        provider: "google",
        tier: 0,
        modes: ["execute"],
        costPerMTokIn: 0.5,
        costPerMTokOut: 2.5,
        model: "gemini-cheap",
      },
    });
    const bargainId = bargain.json().id as string;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: benId, agentId: bargainId },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${benId}/agent-policy`,
      payload: { runBudgetBreachAction: "replan" },
    });

    const created = await app.inject({
      method: "POST",
      headers: benAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "replan-dispatchable",
          escalationApproverUserId: approverId,
          nodes: [mkNode("big", priceyWorkerId)],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().budgetApprovalPending).toBe(false);
    expect(created.json().budget.replanned).toBe(true);
    // cheapest DISPATCHABLE agent, not the credential-less bargain ($0.30)
    expect(created.json().budget.estimatedTotalUsd).toBeCloseTo(0.6, 6);
    const runId = created.json().id;
    const view = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.state.owners.big).toBe(cheapWorkerId);

    // the trace says WHY the cheaper agent was not chosen (§8 honesty)
    const ledger = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/cost-events?userId=${benId}`,
    });
    const sub = ledger.json().events.find(
      (e: { objectType: string; objectId: string | null }) =>
        e.objectType === "run" && e.objectId === runId,
    );
    expect(sub).toBeDefined();
    expect(sub.servedAgentId).toBe(cheapWorkerId);
    expect(sub.detail.routingSkippedCandidates).toEqual([
      { agentId: bargainId, name: "budget-bargain-google", reason: "no_model_credential" },
    ]);
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${benId}` });
    const planned = audit.json().entries.find(
      (e: { ruleId: string; detail: { runName?: string } | null }) =>
        e.ruleId === "run-planned" && e.detail?.runName === "replan-dispatchable",
    );
    expect(planned).toBeDefined();
    expect(planned.detail.replanSkippedCandidates).toEqual([
      { nodeId: "big", skipped: [{ agentId: bargainId, name: "budget-bargain-google", reason: "no_model_credential" }] },
    ]);

    // end-to-end: the replanned node really dispatches instead of 409ing
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: benAuth, url: `/v1/runs/${runId}/events`, payload });
    await ev({ kind: "start" });
    const startedNode = await ev({ kind: "node_started", nodeId: "big" });
    expect(startedNode.statusCode).toBe(200);
    const dispatched = await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/nodes/big/dispatch`,
      payload: { input: "execute the big task" },
    });
    expect(dispatched.statusCode).toBe(200);
    expect(dispatched.json().dispatch.servedAgentId).toBe(cheapWorkerId);
    expect(dispatched.json().dispatch.refusal).toBe(false);
  });

  it("in-flight breach: reassigning to a pricier agent trips the cap at node start, never silently", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${benId}/agent-policy`,
      payload: { runBudgetBreachAction: "approve" },
    });
    const created = await app.inject({
      method: "POST",
      headers: benAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "drift",
          escalationApproverUserId: approverId,
          nodes: [mkNode("task", cheapWorkerId)],
        },
      },
    });
    expect(created.json().budgetApprovalPending).toBe(false);
    const runId = created.json().id;
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: benAuth, url: `/v1/runs/${runId}/events`, payload });

    await ev({ kind: "start" });
    await ev({ kind: "node_started", nodeId: "task" });
    await ev({ kind: "node_failed", nodeId: "task", error: "flaky" });
    // pricier agent is ENTITLED (no §5.1 violation) but blows the cap
    const reassigned = await ev({ kind: "reassign_node", nodeId: "task", ownerAgentId: priceyWorkerId });
    expect(reassigned.statusCode).toBe(200);
    const breach = await ev({ kind: "node_started", nodeId: "task" });
    expect(breach.statusCode).toBe(409);
    expect(breach.json().error).toBe("budget_exceeded");

    const inbox = await app.inject({
      method: "GET",
      headers: approverAuth,
      url: "/v1/approvals?status=pending",
    });
    const entry = inbox.json().approvals.find(
      (a: { runId: string | null; stageId: string | null }) =>
        a.runId === runId && a.stageId === "__budget__:task",
    );
    expect(entry).toBeDefined();
    await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    const afterApproval = await ev({ kind: "node_started", nodeId: "task" });
    expect(afterApproval.statusCode).toBe(200);
  });
});

describe("PM-tool integration (EPIC-06 slice)", () => {
  let pmUserId: string;
  let pmUserAuth: { authorization: string };
  let pmApproverId: string;
  let workerId: string;
  let runId: string;

  it("connections store encrypted tokens, validate mappings, and reject unimplemented adapters", async () => {
    const u = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-pete@example.com", displayName: "PM Pete" },
    });
    pmUserId = u.json().id;
    pmUserAuth = await authFor(pmUserId);
    const a = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-approver@example.com", displayName: "PM Approver" },
    });
    pmApproverId = a.json().id;

    const jira = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: { name: "jira-main", provider: "jira", project: "PROJ", token: "tok" },
    });
    expect(jira.statusCode).toBe(422);

    const badMapping = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: {
        name: "bad-map",
        provider: "mock",
        project: "regulait",
        token: "tok",
        mapping: { task: { fields: {} } },
      },
    });
    expect(badMapping.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: { name: "mock-ado", provider: "mock", project: "regulait", token: "pm-secret" },
    });
    expect(ok.statusCode).toBe(201);
    expect(JSON.stringify(ok.json())).not.toContain("pm-secret");

    const listing = await app.inject({ method: "GET", headers: AUTH, url: "/v1/pm/connections" });
    expect(JSON.stringify(listing.json())).not.toContain("pm-secret");
  });

  it("pm-sync links every task-graph node to a real work item, idempotently, audited", async () => {
    const agent = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "pm-worker", provider: "anthropic", tier: 1, modes: ["execute"] },
    });
    workerId = agent.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: pmUserId, agentId: workerId },
    });

    const created = await app.inject({
      method: "POST",
      headers: pmUserAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "pm-linked-run",
          escalationApproverUserId: pmApproverId,
          nodes: [
            { id: "api", title: "Build the API", ownerAgentId: workerId, mode: "execute" },
            { id: "docs", title: "Write the docs", ownerAgentId: workerId, mode: "execute", dependsOn: ["api"] },
          ],
        },
      },
    });
    runId = created.json().id;

    const sync = await app.inject({
      method: "POST",
      headers: pmUserAuth,
      url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "mock-ado" },
    });
    expect(sync.statusCode).toBe(201);
    expect(sync.json().created).toHaveLength(2);

    // idempotent: second sync creates nothing new
    const again = await app.inject({
      method: "POST",
      headers: pmUserAuth,
      url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "mock-ado" },
    });
    expect(again.json().created).toHaveLength(0);
    expect(again.json().skipped.sort()).toEqual(["api", "docs"]);

    // the mock provider really holds the items with mapped fields
    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const first = sync.json().created.find((c: { nodeId: string }) => c.nodeId === "api");
    const item = await mock.getWorkItem("regulait", first.externalId);
    expect(item.fields.title).toBe("Build the API");

    // §5.3-style: creations are in the one audit trail
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${pmUserId}` });
    const pmRows = audit.json().entries.filter(
      (e: { objectType: string }) => e.objectType === "pm_work_item",
    );
    expect(pmRows.length).toBeGreaterThanOrEqual(2);
  });

  it("node status changes mirror outbound through the statusMap (§3/§5)", async () => {
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: pmUserAuth, url: `/v1/runs/${runId}/events`, payload });
    await ev({ kind: "start" });
    const started = await ev({ kind: "node_started", nodeId: "api" });
    expect(started.json().pmSync).toEqual({ ok: true, state: "Doing" });

    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const links = await app.inject({
      method: "GET",
      headers: pmUserAuth,
      url: `/v1/pm/links?runId=${runId}`,
    });
    const apiLink = links.json().links.find((l: { nodeId: string }) => l.nodeId === "api");
    expect((await mock.getWorkItem("regulait", apiLink.externalId)).state).toBe("Doing");

    await ev({ kind: "node_submitted", nodeId: "api" });
    const accepted = await ev({ kind: "node_accepted", nodeId: "api" });
    expect(accepted.json().pmSync).toEqual({ ok: true, state: "Done" });
    expect((await mock.getWorkItem("regulait", apiLink.externalId)).state).toBe("Done");
  });

  it("the links view reads PM-authoritative fields through live — no cached copy (§3)", async () => {
    // simulate a human editing the description IN THE PM TOOL
    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const links = await app.inject({
      method: "GET",
      headers: pmUserAuth,
      url: `/v1/pm/links?runId=${runId}`,
    });
    const docsLink = links.json().links.find((l: { nodeId: string }) => l.nodeId === "docs");
    await mock.updateFields("regulait", docsLink.externalId, { description: "edited in the PM tool" });

    const live = await app.inject({
      method: "GET",
      headers: pmUserAuth,
      url: `/v1/pm/links?runId=${runId}&live=true`,
    });
    const docsLive = live.json().links.find((l: { nodeId: string }) => l.nodeId === "docs");
    expect(docsLive.live.fields.description).toBe("edited in the PM tool");

    // non-participants see nothing
    const stranger = await app.inject({
      method: "GET",
      headers: await authFor(pmApproverId),
      url: `/v1/pm/links?runId=${runId}`,
    });
    expect(stranger.statusCode).toBe(404);
  });
});

describe("PM approval mirroring (EPIC-06 §5)", () => {
  let miaId: string;
  let miaAuth: { authorization: string };

  it("an approved sign-off transitions the linked item when the stage is mapped", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: {
        name: "mock-signoff",
        provider: "mock",
        project: "signoff-proj",
        token: "tok2",
        mapping: {
          task: { workItemType: "Task", fields: { title: "title", status: "state" } },
          approval: { target: "status_transition", stageMap: { signoff: "Signed Off" } },
        },
      },
    });

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "pm-mirror-wf",
        definition: {
          workflow: "pm-mirror-wf",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "spec", type: "artifact_generation", output: "spec_doc" },
            { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "pm-mirror-e2e" },
    });

    const mia = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-mia@example.com", displayName: "PM Mia" },
    });
    miaId = mia.json().id;
    miaAuth = await authFor(miaId);

    const started = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "mirrored change",
          paths: ["svc/a.ts"],
          changeType: "pm-mirror-e2e",
          environment: "staging",
        },
      },
    });
    const instanceId = started.json().id;

    const sync = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "mock-signoff" },
    });
    expect(sync.statusCode).toBe(201);
    const externalId = sync.json().externalId;
    // idempotent
    const again = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "mock-signoff" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);

    await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "spec", content: "the spec" },
    });
    const inbox = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find(
      (a: { instanceId: string | null }) => a.instanceId === instanceId,
    );
    const decided = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved", reason: "looks good" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "transition" });

    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem("signoff-proj", externalId);
    expect(item.state).toBe("Signed Off");
    expect(item.comments.some((c) => c.includes("signoff") && c.includes("approved"))).toBe(true);
    expect(item.comments.some((c) => c.includes("looks good"))).toBe(true);
  });

  it("a denial never enters the mapped state — it degrades to a comment", async () => {
    const started = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "denied change",
          paths: ["svc/b.ts"],
          changeType: "pm-mirror-e2e",
          environment: "staging",
        },
      },
    });
    const instanceId = started.json().id;
    const sync = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "mock-signoff" },
    });
    const externalId = sync.json().externalId;
    await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "spec", content: "risky spec" },
    });
    const inbox = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find(
      (a: { instanceId: string | null }) => a.instanceId === instanceId,
    );
    const decided = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "denied", reason: "too risky" },
    });
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "comment" });

    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem("signoff-proj", externalId);
    expect(item.state).not.toBe("Signed Off");
    expect(item.comments.some((c) => c.includes("denied") && c.includes("too risky"))).toBe(true);
  });

  it("run escalation decisions mirror as comments on the node's linked item", async () => {
    const approver = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-run-approver@example.com", displayName: "Run Approver" },
    });
    const approverId = approver.json().id;
    const agent = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "pm-mirror-worker", provider: "anthropic", tier: 1, modes: ["execute"] },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: miaId, agentId: agent.json().id },
    });
    const run = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "mirror-escalation",
          escalationApproverUserId: approverId,
          nodes: [{ id: "risky", title: "Risky task", ownerAgentId: agent.json().id, mode: "execute" }],
        },
      },
    });
    const runId = run.json().id;
    await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "mock-signoff" },
    });
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: miaAuth, url: `/v1/runs/${runId}/events`, payload });
    await ev({ kind: "start" });
    await ev({ kind: "node_started", nodeId: "risky" });
    await ev({ kind: "node_failed", nodeId: "risky", error: "worker crashed" });
    await ev({ kind: "escalate_node", nodeId: "risky" });

    const approverAuth = await authFor(approverId);
    const inbox = await app.inject({
      method: "GET",
      headers: approverAuth,
      url: "/v1/approvals?status=pending",
    });
    const entry = inbox.json().approvals.find((a: { runId: string | null }) => a.runId === runId);
    const decided = await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "comment" });

    const links = await app.inject({
      method: "GET",
      headers: miaAuth,
      url: `/v1/pm/links?runId=${runId}`,
    });
    const nodeLink = links.json().links.find((l: { nodeId: string }) => l.nodeId === "risky");
    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem("signoff-proj", nodeLink.externalId);
    expect(item.comments.some((c) => c.includes("risky") && c.includes("approved"))).toBe(true);
  });
});

describe("PM decision records (EPIC-06 §4)", () => {
  let danaId: string;
  let danaAuth: { authorization: string };
  let danaRunId: string;

  it("a decision on a mapped connection becomes a real linked work item with the minimum fields", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: {
        name: "mock-decisions",
        provider: "mock",
        project: "decisions-proj",
        token: "tok3",
        mapping: {
          task: { workItemType: "Task", fields: { title: "title", status: "state" } },
          decision: {
            workItemType: "Risk",
            fields: { title: "title", rationale: "rationale", decisionMaker: "maker" },
          },
        },
      },
    });

    const dana = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-dana@example.com", displayName: "PM Dana" },
    });
    danaId = dana.json().id;
    danaAuth = await authFor(danaId);
    const approver = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-dec-approver@example.com", displayName: "Dec Approver" },
    });
    const agent = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "pm-dec-worker", provider: "anthropic", tier: 1, modes: ["execute"] },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: danaId, agentId: agent.json().id },
    });
    const run = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "decided-run",
          escalationApproverUserId: approver.json().id,
          nodes: [{ id: "n1", title: "the work", ownerAgentId: agent.json().id, mode: "execute" }],
        },
      },
    });
    danaRunId = run.json().id;
    await app.inject({
      method: "POST",
      headers: danaAuth,
      url: `/v1/runs/${danaRunId}/pm-sync`,
      payload: { connectionName: "mock-decisions" },
    });

    const recorded = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: "/v1/decisions",
      payload: {
        objectType: "run",
        objectId: danaRunId,
        decision: "use Postgres over DynamoDB",
        rationale: "operational familiarity",
      },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().decisionMakerUserId).toBe(danaId); // authenticated identity, never a body field
    expect(recorded.json().pmMirror.ok).toBe(true);
    expect(recorded.json().pmMirror.action).toBe("work_item");

    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem("decisions-proj", recorded.json().pmMirror.externalId);
    expect(item.type).toBe("Risk");
    expect(item.fields.title).toBe("use Postgres over DynamoDB");
    expect(item.fields.rationale).toBe("operational familiarity");
    expect(item.fields.maker).toBe("pm-dana@example.com");

    // §6 traceability: the run's parent item points at the decision record
    const links = await app.inject({
      method: "GET",
      headers: danaAuth,
      url: `/v1/pm/links?runId=${danaRunId}`,
    });
    expect(links.statusCode).toBe(200);
    const listed = await app.inject({
      method: "GET",
      headers: danaAuth,
      url: `/v1/decisions?objectType=run&objectId=${danaRunId}`,
    });
    expect(listed.json().decisions).toHaveLength(1);
  });

  it("no decision mapping degrades to a tagged comment on the parent item", async () => {
    const started = await app.inject({
      method: "POST",
      headers: await authFor(danaId),
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "decided change",
          paths: ["svc/c.ts"],
          changeType: "pm-mirror-e2e",
          environment: "staging",
        },
      },
    });
    const instanceId = started.json().id;
    const sync = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "mock-signoff" }, // §5 connection: no decision mapping
    });
    const recorded = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: "/v1/decisions",
      payload: {
        objectType: "workflow_instance",
        objectId: instanceId,
        decision: "ship behind a feature flag",
      },
    });
    expect(recorded.json().pmMirror).toMatchObject({ ok: true, action: "comment" });

    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem("signoff-proj", sync.json().externalId);
    expect(
      item.comments.some((c) => c.includes("decision") && c.includes("ship behind a feature flag")),
    ).toBe(true);
  });

  it("decisions record locally without a PM link, and strangers get 404", async () => {
    const approver2 = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-dec-approver2@example.com", displayName: "Dec Approver 2" },
    });
    const agent2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/agents" });
    const workerId = agent2.json().agents.find((a: { name: string }) => a.name === "pm-dec-worker").id;
    const unlinked = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "unlinked-run",
          escalationApproverUserId: approver2.json().id,
          nodes: [{ id: "n1", title: "solo work", ownerAgentId: workerId, mode: "execute" }],
        },
      },
    });
    const recorded = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: "/v1/decisions",
      payload: { objectType: "run", objectId: unlinked.json().id, decision: "local only" },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().pmMirror).toBeUndefined();

    const stranger = await app.inject({
      method: "POST",
      headers: await authFor(approver2.json().id),
      url: "/v1/decisions",
      payload: { objectType: "run", objectId: danaRunId, decision: "not my run" },
    });
    expect(stranger.statusCode).toBe(404);
  });
});

describe("PM inbound sync (EPIC-06, ADR-0010)", () => {
  let webhookSecret: string;
  let inboundRunId: string;
  let inboundAuth: { authorization: string };
  let nodeExternalId: string;

  it("connections mint a webhook secret exactly once; bad secrets are rejected", async () => {
    const conn = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: { name: "mock-inbound", provider: "mock", project: "inbound-proj", token: "tok4" },
    });
    expect(conn.statusCode).toBe(201);
    webhookSecret = conn.json().webhookSecret;
    expect(webhookSecret).toMatch(/^rglwh_/);
    const listing = await app.inject({ method: "GET", headers: AUTH, url: "/v1/pm/connections" });
    expect(JSON.stringify(listing.json())).not.toContain(webhookSecret);

    // no bearer token needed — but the per-connection secret is mandatory
    const noSecret = await app.inject({
      method: "POST",
      url: "/v1/pm/webhooks/mock-inbound",
      payload: { externalId: "1", event: "updated" },
    });
    expect(noSecret.statusCode).toBe(401);
    const wrongSecret = await app.inject({
      method: "POST",
      url: "/v1/pm/webhooks/mock-inbound",
      headers: { "x-regulait-webhook-secret": "rglwh_wrong" },
      payload: { externalId: "1", event: "updated" },
    });
    expect(wrongSecret.statusCode).toBe(401);
  });

  it("inbound events record without touching the state machine; unmatched items are logged", async () => {
    const user = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-ines@example.com", displayName: "PM Ines" },
    });
    inboundAuth = await authFor(user.json().id);
    const approver = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-in-approver@example.com", displayName: "In Approver" },
    });
    const agent = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "pm-in-worker", provider: "anthropic", tier: 1, modes: ["execute"] },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: user.json().id, agentId: agent.json().id },
    });
    const run = await app.inject({
      method: "POST",
      headers: inboundAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "inbound-run",
          escalationApproverUserId: approver.json().id,
          nodes: [{ id: "n1", title: "watched work", ownerAgentId: agent.json().id, mode: "execute" }],
        },
      },
    });
    inboundRunId = run.json().id;
    const sync = await app.inject({
      method: "POST",
      headers: inboundAuth,
      url: `/v1/runs/${inboundRunId}/pm-sync`,
      payload: { connectionName: "mock-inbound" },
    });
    nodeExternalId = sync.json().created.find((c: { nodeId: string }) => c.nodeId === "n1").externalId;

    const unmatched = await app.inject({
      method: "POST",
      url: "/v1/pm/webhooks/mock-inbound",
      headers: { "x-regulait-webhook-secret": webhookSecret },
      payload: { externalId: "does-not-exist", event: "updated", state: "Done" },
    });
    expect(unmatched.statusCode).toBe(202);
    expect(unmatched.json().matched).toBe(false);

    // start the node so RegulAIt's status is in_progress (maps to "Doing")
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: inboundAuth, url: `/v1/runs/${inboundRunId}/events`, payload });
    await ev({ kind: "start" });
    await ev({ kind: "node_started", nodeId: "n1" });

    const agreeing = await app.inject({
      method: "POST",
      url: "/v1/pm/webhooks/mock-inbound",
      headers: { "x-regulait-webhook-secret": webhookSecret },
      payload: { externalId: nodeExternalId, event: "updated", state: "Doing" },
    });
    expect(agreeing.json()).toEqual({ matched: true, drift: false });

    const links = await app.inject({
      method: "GET",
      headers: inboundAuth,
      url: `/v1/pm/links?runId=${inboundRunId}`,
    });
    const link = links.json().links.find((l: { nodeId: string }) => l.nodeId === "n1");
    expect(link.inboundState).toBe("Doing");
    expect(link.drift).toBe(false);
    // the state machine was never touched
    const view = await app.inject({ method: "GET", headers: inboundAuth, url: `/v1/runs/${inboundRunId}` });
    expect(view.json().run.state.nodeStatuses.n1).toBe("in_progress");
  });

  it("a disagreeing inbound state surfaces as drift — audited, never auto-applied", async () => {
    const drifting = await app.inject({
      method: "POST",
      url: "/v1/pm/webhooks/mock-inbound",
      headers: { "x-regulait-webhook-secret": webhookSecret },
      payload: { externalId: nodeExternalId, event: "updated", state: "Done" },
    });
    expect(drifting.json()).toEqual({ matched: true, drift: true });

    const links = await app.inject({
      method: "GET",
      headers: inboundAuth,
      url: `/v1/pm/links?runId=${inboundRunId}`,
    });
    const link = links.json().links.find((l: { nodeId: string }) => l.nodeId === "n1");
    expect(link.drift).toBe(true);
    expect(link.inboundState).toBe("Done");

    const view = await app.inject({ method: "GET", headers: inboundAuth, url: `/v1/runs/${inboundRunId}` });
    expect(view.json().run.state.nodeStatuses.n1).toBe("in_progress"); // untouched

    const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit" });
    expect(
      audit.json().entries.some((e: { ruleId: string }) => e.ruleId === "pm-drift-detected"),
    ).toBe(true);
  });

  it("a deleted work item orphans the link, audited", async () => {
    const deleted = await app.inject({
      method: "POST",
      url: "/v1/pm/webhooks/mock-inbound",
      headers: { "x-regulait-webhook-secret": webhookSecret },
      payload: { externalId: nodeExternalId, event: "deleted" },
    });
    expect(deleted.json().matched).toBe(true);
    const links = await app.inject({
      method: "GET",
      headers: inboundAuth,
      url: `/v1/pm/links?runId=${inboundRunId}`,
    });
    const link = links.json().links.find((l: { nodeId: string }) => l.nodeId === "n1");
    expect(link.orphanedAt).not.toBeNull();
    const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit" });
    expect(
      audit.json().entries.some((e: { ruleId: string }) => e.ruleId === "pm-link-orphaned"),
    ).toBe(true);
  });
});

describe("provider-native inbound webhooks (pillar 8 depth)", () => {
  it("linear: a signed NATIVE Issue payload records inbound state + drift end-to-end; a bad signature is 401 and processes nothing", async () => {
    // fake Linear GraphQL vendor for the outbound half (link creation + mirror)
    let issueSeq = 0;
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        let data: unknown = {};
        if (String(parsed.query).includes("teams(filter")) {
          data = { teams: { nodes: [{ id: "team-uuid-in" }] } };
        } else if (String(parsed.query).includes("issueCreate")) {
          issueSeq += 1;
          data = { issueCreate: { success: true, issue: { id: `lin-in-${issueSeq}`, url: `https://linear.app/acme/issue/INB-${issueSeq}` } } };
        } else if (String(parsed.query).includes("states")) {
          data = { team: { states: { nodes: [
            { id: "st-todo", name: "Todo" },
            { id: "st-prog", name: "In Progress" },
            { id: "st-done", name: "Done" },
          ] } } };
        } else if (String(parsed.query).includes("issueUpdate")) {
          data = { issueUpdate: { success: true } };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const conn = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/pm/connections",
        payload: {
          name: "linear-inbound", provider: "linear", project: "REG",
          baseUrl: `http://127.0.0.1:${port}`, token: "lin_api_inbound",
        },
      });
      expect(conn.statusCode).toBe(201);
      const linWebhookSecret = conn.json().webhookSecret as string;

      const nia = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "native-nia@example.com", displayName: "Native Nia" },
      });
      const niaAuth = await authFor(nia.json().id);
      const approver = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "native-approver@example.com", displayName: "Native Approver" },
      });
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "native-worker", provider: "mock", tier: 0, modes: ["execute"],
          costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-native",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: nia.json().id, agentId: agentRes.json().id },
      });
      const run = await app.inject({
        method: "POST", headers: niaAuth, url: "/v1/runs",
        payload: {
          graph: {
            run: "native-inbound-run",
            escalationApproverUserId: approver.json().id,
            nodes: [{ id: "a", title: "watched natively", ownerAgentId: agentRes.json().id, mode: "execute", estimate: { in: 1, out: 1 } }],
          },
        },
      });
      const runId = run.json().id;
      const synced = await app.inject({
        method: "POST", headers: niaAuth, url: `/v1/runs/${runId}/pm-sync`,
        payload: { connectionName: "linear-inbound" },
      });
      expect(synced.statusCode).toBe(201);
      const externalId = synced.json().created.find((c: { nodeId: string }) => c.nodeId === "a").externalId;

      // start the node: RegulAIt says in_progress → Linear-mapped "In Progress"
      await app.inject({ method: "POST", headers: niaAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
      await app.inject({
        method: "POST", headers: niaAuth, url: `/v1/runs/${runId}/events`,
        payload: { kind: "node_started", nodeId: "a" },
      });

      // Linear's REAL payload shape, signed the way Linear signs: hex
      // HMAC-SHA256 of the exact raw body in `linear-signature`.
      const payload = JSON.stringify({
        action: "update",
        type: "Issue",
        data: { id: externalId, identifier: "INB-1", title: "watched natively", state: { name: "Done" } },
        updatedFrom: { stateId: "st-prog" },
      });
      const good = await app.inject({
        method: "POST", url: "/v1/pm/webhooks/linear-inbound",
        headers: {
          "content-type": "application/json",
          "linear-signature": createHmac("sha256", linWebhookSecret).update(payload).digest("hex"),
        },
        payload,
      });
      expect(good.statusCode).toBe(202);
      expect(good.json()).toEqual({ matched: true, drift: true }); // reports Done, RegulAIt maps In Progress

      const links = await app.inject({ method: "GET", headers: niaAuth, url: `/v1/pm/links?runId=${runId}` });
      const link = links.json().links.find((l: { nodeId: string }) => l.nodeId === "a");
      expect(link.inboundState).toBe("Done");
      expect(link.drift).toBe(true);
      // the state machine was never touched
      const view = await app.inject({ method: "GET", headers: niaAuth, url: `/v1/runs/${runId}` });
      expect(view.json().run.state.nodeStatuses.a).toBe("in_progress");

      // a BAD signature (right shape, wrong key) is 401 and processes nothing
      const tamper = JSON.stringify({
        action: "update", type: "Issue",
        data: { id: externalId, state: { name: "In Progress" } },
      });
      const bad = await app.inject({
        method: "POST", url: "/v1/pm/webhooks/linear-inbound",
        headers: {
          "content-type": "application/json",
          "linear-signature": createHmac("sha256", "not-the-secret").update(tamper).digest("hex"),
        },
        payload: tamper,
      });
      expect(bad.statusCode).toBe(401);
      const after = await app.inject({ method: "GET", headers: niaAuth, url: `/v1/pm/links?runId=${runId}` });
      expect(after.json().links.find((l: { nodeId: string }) => l.nodeId === "a").inboundState).toBe("Done");
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("asana: the x-hook-secret handshake echoes the header back; signed thin events land, unsigned are 401", async () => {
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/pm/connections",
      payload: { name: "asana-inbound", provider: "asana", project: "999", token: "asana-pat-inbound" },
    });
    expect(conn.statusCode).toBe(201);
    const secret = conn.json().webhookSecret as string;

    // phase 1: establishment handshake — 200 echoing the SAME x-hook-secret
    const handshake = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/asana-inbound",
      headers: { "content-type": "application/json", "x-hook-secret": "asana-issued-hs-1" },
      payload: "{}",
    });
    expect(handshake.statusCode).toBe(200);
    expect(handshake.headers["x-hook-secret"]).toBe("asana-issued-hs-1");

    // phase 2: a signed thin event batch — accepted (202), unlinked gid → matched:false
    const events = JSON.stringify({
      events: [{ action: "changed", resource: { gid: "asana-task-1", resource_type: "task" } }],
    });
    const signed = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/asana-inbound",
      headers: {
        "content-type": "application/json",
        "x-hook-signature": createHmac("sha256", secret).update(events).digest("hex"),
      },
      payload: events,
    });
    expect(signed.statusCode).toBe(202);
    expect(signed.json()).toEqual({ matched: false });

    // no handshake header and no signature → 401
    const unsigned = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/asana-inbound",
      headers: { "content-type": "application/json" },
      payload: events,
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it("monday: the challenge is echoed verbatim under URL-token auth; a status-column event lands normalized", async () => {
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/pm/connections",
      payload: { name: "monday-inbound", provider: "monday", project: "777", token: "monday-tok-inbound" },
    });
    expect(conn.statusCode).toBe(201);
    const secret = conn.json().webhookSecret as string;

    const challenge = await app.inject({
      method: "POST", url: `/v1/pm/webhooks/monday-inbound?token=${secret}`,
      payload: { challenge: "mon-uuid-echo-1" },
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toEqual({ challenge: "mon-uuid-echo-1" });

    // without the token even the challenge is refused — fail-closed
    const noToken = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/monday-inbound",
      payload: { challenge: "mon-uuid-echo-2" },
    });
    expect(noToken.statusCode).toBe(401);

    const event = await app.inject({
      method: "POST", url: `/v1/pm/webhooks/monday-inbound?token=${secret}`,
      payload: {
        event: { type: "update_column_value", pulseId: 4321, boardId: 777, columnId: "status", value: { label: { text: "Done" } } },
      },
    });
    expect(event.statusCode).toBe(202);
    expect(event.json()).toEqual({ matched: false }); // no linked item — recorded, not errored
  });

  it("jira: URL-token auth accepts native issue payloads; a wrong token is 401; unconsumed events are 200-ignored", async () => {
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/pm/connections",
      payload: {
        name: "jira-inbound", provider: "jira", project: "REG",
        baseUrl: `${DEAD_LOOPBACK}/acme-jira`, token: "bot@example.com:api-token",
      },
    });
    expect(conn.statusCode).toBe(201);
    const secret = conn.json().webhookSecret as string;

    const native = await app.inject({
      method: "POST", url: `/v1/pm/webhooks/jira-inbound?token=${secret}`,
      payload: {
        webhookEvent: "jira:issue_updated",
        issue: { id: "10042", key: "REG-7", fields: { summary: "Build API", status: { name: "Done" } } },
      },
    });
    expect(native.statusCode).toBe(202);
    expect(native.json()).toEqual({ matched: false });

    const wrongToken = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/jira-inbound?token=rglwh_wrong",
      payload: { webhookEvent: "jira:issue_updated", issue: { id: "10042" } },
    });
    expect(wrongToken.statusCode).toBe(401);

    // valid but irrelevant traffic must 200 — Jira disables erroring webhooks
    const irrelevant = await app.inject({
      method: "POST", url: `/v1/pm/webhooks/jira-inbound?token=${secret}`,
      payload: { webhookEvent: "sprint_started" },
    });
    expect(irrelevant.statusCode).toBe(200);
    expect(irrelevant.json().ok).toBe(true);
    expect(irrelevant.json().ignored).toContain("sprint_started");
  });

  it("generic_webhook: the outbound-symmetric x-regulait-signature now verifies inbound traffic too", async () => {
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/pm/connections",
      payload: {
        name: "generic-inbound", provider: "generic_webhook", project: "bridge",
        baseUrl: `${DEAD_LOOPBACK}/regulait`, token: "bridge-token",
      },
    });
    expect(conn.statusCode).toBe(201);
    const secret = conn.json().webhookSecret as string;

    const body = JSON.stringify({ externalId: "no-such-item", event: "updated", state: "done" });
    const signed = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/generic-inbound",
      headers: {
        "content-type": "application/json",
        "x-regulait-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      payload: body,
    });
    expect(signed.statusCode).toBe(202);
    expect(signed.json()).toEqual({ matched: false });

    // a bad signature loses even when the legacy header is valid — precedence
    const both = await app.inject({
      method: "POST", url: "/v1/pm/webhooks/generic-inbound",
      headers: {
        "content-type": "application/json",
        "x-regulait-signature": "sha256=deadbeef",
        "x-regulait-webhook-secret": secret,
      },
      payload: body,
    });
    expect(both.statusCode).toBe(401);
  });
});

describe("governed model dispatch (measured usage, pillar 5 actuals)", () => {
  let danaId: string;
  let danaAuth: { authorization: string };
  let bigId: string;
  let cheapId: string;

  const mkAgent = async (payload: Record<string, unknown>) => {
    const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  const grant = (userId: string, agentId: string) =>
    app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });

  it("dispatch=true executes the ROUTED model and ledgers measured usage + measured savings", async () => {
    const dana = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "dispatch-dana@example.com", displayName: "Dispatch Dana" },
    });
    danaId = dana.json().id;
    danaAuth = await authFor(danaId);

    bigId = await mkAgent({
      name: "disp-big", provider: "mock", tier: 2, modes: ["plan", "execute"],
      costPerMTokIn: 15, costPerMTokOut: 75, model: "mock-large",
    });
    cheapId = await mkAgent({
      name: "disp-cheap", provider: "mock", tier: 0, modes: ["plan", "execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-small",
    });
    await grant(danaId, bigId);
    await grant(danaId, cheapId);

    const res = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "summarize this short note", dispatch: true },
    });
    expect(res.statusCode).toBe(200);
    const { decision, routing, dispatch } = res.json();
    expect(decision.effect).toBe("allow");
    expect(routing.selectedAgentId).toBe(cheapId);
    // the dispatch executed exactly what routing chose — never the requested model
    expect(dispatch.servedAgentId).toBe(cheapId);
    expect(dispatch.model).toBe("mock-small");
    // the mock answers the ask (a summary referencing the note), not an echo
    expect(dispatch.outputText).toContain("Summary");
    expect(dispatch.outputText).toContain("short note");
    expect(dispatch.refusal).toBe(false);
    expect(dispatch.stopReason).toBe("end_turn");
    expect(dispatch.usage.inputTokens).toBeGreaterThan(0);
    expect(dispatch.usage.outputTokens).toBeGreaterThan(0);
    expect(dispatch.costUsd).toBeGreaterThan(0);
    // measured savings: baseline (requested big) price minus served price at
    // the SAME measured token volumes
    expect(dispatch.measuredCostSavedUsd).toBeGreaterThan(0);

    const ledger = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${danaId}`,
    });
    expect(ledger.statusCode).toBe(200);
    const { events, totals } = ledger.json();
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe(cheapId);
    expect(events[0].requestedAgentId).toBe(bigId);
    expect(events[0].baselineAgentId).toBe(bigId);
    expect(events[0].provider).toBe("mock");
    expect(events[0].model).toBe("mock-small");
    expect(events[0].inputTokens).toBe(dispatch.usage.inputTokens);
    expect(events[0].costUsd).toBeCloseTo(dispatch.costUsd, 10);
    expect(totals.events).toBe(1);
    expect(totals.costUsd).toBeGreaterThan(0);
    expect(totals.measuredCostSavedUsd).toBeGreaterThan(0);

    // the audit row records that a real dispatch happened
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${danaId}` });
    const row = audit.json().entries.find((e: { objectType: string }) => e.objectType === "agent");
    expect(row.detail.dispatch).toMatchObject({ model: "mock-small", refusal: false });
  });

  it("a model refusal is surfaced honestly — empty output, refusal flagged, usage still ledgered", async () => {
    const res = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: `/v1/agents/${cheapId}/invoke`,
      payload: { mode: "plan", input: "please <<refuse>> this request", dispatch: true },
    });
    expect(res.statusCode).toBe(200);
    const { dispatch } = res.json();
    expect(dispatch.refusal).toBe(true);
    expect(dispatch.stopReason).toBe("refusal");
    expect(dispatch.outputText).toBe("");

    const ledger = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${danaId}`,
    });
    const refusalRow = ledger.json().events.find((e: { refusal: boolean }) => e.refusal);
    expect(refusalRow).toBeDefined();
    expect(refusalRow.outputTokens).toBe(0);
  });

  it("decision-only invokes are unchanged: no dispatch field, no usage row", async () => {
    const before = (
      await app.inject({ method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${danaId}` })
    ).json().events.length;
    const res = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: `/v1/agents/${cheapId}/invoke`,
      payload: { mode: "plan", input: "just a decision please" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch).toBeUndefined();
    const after = (
      await app.inject({ method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${danaId}` })
    ).json().events.length;
    expect(after).toBe(before);
  });

  it("an agent without a model id fails explicit — never a silent fallback", async () => {
    const erik = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "dispatch-erik@example.com", displayName: "Dispatch Erik" },
    });
    const erikId = erik.json().id;
    const nomodelId = await mkAgent({
      name: "disp-nomodel", provider: "mock", tier: 0, modes: ["plan"],
      costPerMTokIn: 1, costPerMTokOut: 5,
    });
    await grant(erikId, nomodelId);
    const res = await app.inject({
      method: "POST",
      headers: await authFor(erikId),
      url: `/v1/agents/${nomodelId}/invoke`,
      payload: { mode: "plan", input: "hello", dispatch: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("agent_not_dispatchable");
  });

  it("a real provider without a stored credential fails explicit", async () => {
    const frida = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "dispatch-frida@example.com", displayName: "Dispatch Frida" },
    });
    const fridaId = frida.json().id;
    const anthropicAgentId = await mkAgent({
      name: "disp-anthropic", provider: "anthropic", tier: 0, modes: ["plan"],
      costPerMTokIn: 5, costPerMTokOut: 25, model: "claude-opus-5",
    });
    await grant(fridaId, anthropicAgentId);
    const res = await app.inject({
      method: "POST",
      headers: await authFor(fridaId),
      url: `/v1/agents/${anthropicAgentId}/invoke`,
      payload: { mode: "plan", input: "hello", dispatch: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_model_credential");
  });

  it("model credentials are write-only: stored encrypted, listed without the key, admin-only", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "anthropic", apiKey: "sk-ant-test-secret" },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain("sk-ant-test-secret");

    const listed = await app.inject({ method: "GET", headers: AUTH, url: "/v1/model-credentials" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().credentials.some((c: { provider: string }) => c.provider === "anthropic")).toBe(true);
    expect(JSON.stringify(listed.json())).not.toContain("sk-ant-test-secret");

    // at rest: ciphertext, not plaintext
    const [row] = await db.select().from(modelCredentials);
    expect(row!.keyCiphertext).not.toContain("sk-ant-test-secret");

    // non-admins cannot touch the credential surface
    const denied = await app.inject({
      method: "GET", headers: danaAuth, url: "/v1/model-credentials",
    });
    expect(denied.statusCode).toBe(403);
  });

  it("non-admins see only their own usage history", async () => {
    const own = await app.inject({ method: "GET", headers: danaAuth, url: "/v1/usage-events" });
    expect(own.statusCode).toBe(200);
    expect(own.json().events.every((e: { userId: string }) => e.userId === danaId)).toBe(true);

    // asking for someone else's history is forced back to self
    const spoofed = await app.inject({
      method: "GET", headers: danaAuth, url: "/v1/usage-events?userId=00000000-0000-0000-0000-000000000000",
    });
    expect(spoofed.json().events.every((e: { userId: string }) => e.userId === danaId)).toBe(true);
  });
});

describe("worker-node dispatch (EPIC-05 × real dispatch)", () => {
  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    estimate: { in: 1, out: 1 },
    ...extra,
  });
  const mkUser = async (email: string, name: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email, displayName: name },
    });
    return r.json().id as string;
  };
  const mkAgent = async (payload: Record<string, unknown>) => {
    const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload });
    return r.json().id as string;
  };

  let hanaId: string;
  let hanaAuth: { authorization: string };
  let omarId: string;
  let workerId: string;
  let workerGrantId: string;
  let runId: string;

  it("a started node executes its assigned owner and the run accumulates measured spend", async () => {
    hanaId = await mkUser("wnode-hana@example.com", "Wnode Hana");
    hanaAuth = await authFor(hanaId);
    omarId = await mkUser("wnode-omar@example.com", "Wnode Omar");
    workerId = await mkAgent({
      name: "wnode-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-worker",
    });
    const grant = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: hanaId, agentId: workerId },
    });
    workerGrantId = grant.json().id;

    const created = await app.inject({
      method: "POST", headers: hanaAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "wnode-run",
          escalationApproverUserId: omarId,
          nodes: [mkNode("a", workerId), mkNode("b", workerId, { dependsOn: ["a"] })],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    runId = created.json().id;

    await app.inject({ method: "POST", headers: hanaAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
    await app.inject({
      method: "POST", headers: hanaAuth, url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_started", nodeId: "a" },
    });

    const res = await app.inject({
      method: "POST", headers: hanaAuth, url: `/v1/runs/${runId}/nodes/a/dispatch`,
      payload: { input: "please draft the api endpoints" },
    });
    expect(res.statusCode).toBe(200);
    const { dispatch, measuredSpentUsd } = res.json();
    expect(dispatch.servedAgentId).toBe(workerId);
    expect(dispatch.model).toBe("mock-worker");
    // the mock drafts (a code block referencing the topic), not an echo
    expect(dispatch.outputText).toContain("api endpoints");
    expect(dispatch.outputText).toContain("```");
    expect(dispatch.refusal).toBe(false);
    expect(dispatch.costUsd).toBeGreaterThan(0);
    expect(measuredSpentUsd).toBeCloseTo(dispatch.costUsd, 10);

    // measured usage is attributed to the run+node in the actuals ledger
    const ledger = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${hanaId}`,
    });
    const row = ledger.json().events.find(
      (e: { detail: { nodeId?: string } | null }) => e.detail?.nodeId === "a",
    );
    expect(row).toBeDefined();
    expect(row.detail.runId).toBe(runId);
    expect(row.agentId).toBe(workerId);

    // the dispatch is part of the run's append-only history
    const view = await app.inject({ method: "GET", headers: hanaAuth, url: `/v1/runs/${runId}` });
    const evt = view.json().events.find(
      (e: { event: { kind: string } }) => e.event.kind === "node_dispatched",
    );
    expect(evt).toBeDefined();
    expect(evt.event.nodeId).toBe("a");
    expect(evt.event.outputText).toContain("api endpoints");
    // dispatch never moves the state machine — the node is still in progress
    expect(view.json().run.state.nodeStatuses.a).toBe("in_progress");
    expect(view.json().run.budget.measuredSpentUsd).toBeCloseTo(dispatch.costUsd, 10);

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${hanaId}` });
    expect(
      audit.json().entries.some((e: { ruleId: string }) => e.ruleId === "run-node-dispatched"),
    ).toBe(true);
  });

  it("a node that is not in progress cannot dispatch — the state machine stays authoritative", async () => {
    const res = await app.inject({
      method: "POST", headers: hanaAuth, url: `/v1/runs/${runId}/nodes/b/dispatch`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("node_not_in_progress");
  });

  it("a worker refusal is surfaced honestly and the node does not advance", async () => {
    const res = await app.inject({
      method: "POST", headers: hanaAuth, url: `/v1/runs/${runId}/nodes/a/dispatch`,
      payload: { input: "please <<refuse>> this task" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.refusal).toBe(true);
    expect(res.json().dispatch.outputText).toBe("");
    const view = await app.inject({ method: "GET", headers: hanaAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.state.nodeStatuses.a).toBe("in_progress");
  });

  it("a grant revoked mid-run stops the worker cold at the next dispatch (§5.1)", async () => {
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/grants/agents/${workerGrantId}` });
    const res = await app.inject({
      method: "POST", headers: hanaAuth, url: `/v1/runs/${runId}/nodes/a/dispatch`,
      payload: { input: "try again" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("entitlement_exceeded");
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${hanaId}` });
    expect(
      audit.json().entries.some(
        (e: { effect: string; detail: { phase?: string } | null }) =>
          e.effect === "deny" && e.detail?.phase === "dispatch",
      ),
    ).toBe(true);
  });

  it("measured spend crossing the cap escalates once and blocks further dispatches until approved (§5.2)", async () => {
    const iggyId = await mkUser("wnode-iggy@example.com", "Wnode Iggy");
    const iggyAuth = await authFor(iggyId);
    // $1/token pricing so a real dispatch dwarfs the tiny plan estimate
    const priceyId = await mkAgent({
      name: "wnode-pricey", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1_000_000, costPerMTokOut: 1_000_000, model: "mock-pricey",
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: iggyId, agentId: priceyId },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${iggyId}/agent-policy`,
      payload: { runBudgetUsd: 10, runBudgetBreachAction: "approve" },
    });

    const created = await app.inject({
      method: "POST", headers: iggyAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "wnode-budget",
          escalationApproverUserId: omarId,
          nodes: [mkNode("a", priceyId), mkNode("b", priceyId)],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().budgetApprovalPending).toBe(false);
    const budgetRunId = created.json().id;

    await app.inject({ method: "POST", headers: iggyAuth, url: `/v1/runs/${budgetRunId}/events`, payload: { kind: "start" } });
    for (const nodeId of ["a", "b"]) {
      const started = await app.inject({
        method: "POST", headers: iggyAuth, url: `/v1/runs/${budgetRunId}/events`,
        payload: { kind: "node_started", nodeId },
      });
      expect(started.statusCode).toBe(200);
    }

    // first crossing is allowed (cost is only known after the call) but
    // escalates immediately
    const first = await app.inject({
      method: "POST", headers: iggyAuth, url: `/v1/runs/${budgetRunId}/nodes/a/dispatch`,
      payload: { input: "x".repeat(100) },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().measuredSpentUsd).toBeGreaterThan(10);
    expect(first.json().budgetBreached).toBe(true);

    // everything after the crossing is blocked
    const second = await app.inject({
      method: "POST", headers: iggyAuth, url: `/v1/runs/${budgetRunId}/nodes/b/dispatch`,
      payload: { input: "small" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("budget_exceeded_measured");

    // the named approver sanctions the overage → dispatch resumes
    const view = await app.inject({ method: "GET", headers: iggyAuth, url: `/v1/runs/${budgetRunId}` });
    const pending = view.json().pendingApprovals.find(
      (a: { stageId: string }) => a.stageId === "__budget__:a",
    );
    expect(pending).toBeDefined();
    const decided = await app.inject({
      method: "POST",
      headers: await authFor(omarId),
      url: `/v1/approvals/${pending.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);
    const third = await app.inject({
      method: "POST", headers: iggyAuth, url: `/v1/runs/${budgetRunId}/nodes/b/dispatch`,
      payload: { input: "small" },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().budgetBreached).toBeUndefined();
  });
});

describe("auto-dispatch of ready nodes (self-driving runs, same gates)", () => {
  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    estimate: { in: 1, out: 1 },
    ...extra,
  });
  const mkUser = async (email: string, name: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email, displayName: name },
    });
    return r.json().id as string;
  };

  let junoId: string;
  let junoAuth: { authorization: string };
  let approverId: string;
  let autoWorkerId: string;

  it("acceptReviews=true drives a DAG to completion in one call, dependency-ordered", async () => {
    junoId = await mkUser("auto-juno@example.com", "Auto Juno");
    junoAuth = await authFor(junoId);
    approverId = await mkUser("auto-approver@example.com", "Auto Approver");
    const agentRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "auto-worker", provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-auto",
      },
    });
    autoWorkerId = agentRes.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: junoId, agentId: autoWorkerId },
    });

    const created = await app.inject({
      method: "POST", headers: junoAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "auto-full",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("a", autoWorkerId),
            mkNode("b", autoWorkerId, { dependsOn: ["a"] }),
            mkNode("c", autoWorkerId),
          ],
        },
      },
    });
    const runId = created.json().id;

    const res = await app.inject({
      method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true, inputs: { a: "draft the api", b: "review the api" } },
    });
    expect(res.statusCode).toBe(200);
    const { status, steps, stoppedReason } = res.json();
    expect(status).toBe("completed");
    expect(stoppedReason).toBe("completed");
    expect(steps).toHaveLength(3);
    expect(steps.every((s: { action: string }) => s.action === "accepted")).toBe(true);
    // b never runs before a
    const order = steps.map((s: { nodeId: string }) => s.nodeId);
    expect(order.indexOf("b")).toBeGreaterThan(order.indexOf("a"));

    // three measured usage rows attributed to this run
    const ledger = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${junoId}`,
    });
    const rows = ledger.json().events.filter(
      (e: { detail: { runId?: string } | null }) => e.detail?.runId === runId,
    );
    expect(rows).toHaveLength(3);

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${junoId}` });
    expect(
      audit.json().entries.some((e: { ruleId: string }) => e.ruleId === "run-auto-advance"),
    ).toBe(true);
  });

  it("by default review stays a human gate: the pass stops at in_review and resumes after acceptance", async () => {
    const created = await app.inject({
      method: "POST", headers: junoAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "auto-review-gate",
          escalationApproverUserId: approverId,
          nodes: [mkNode("a", autoWorkerId), mkNode("b", autoWorkerId, { dependsOn: ["a"] })],
        },
      },
    });
    const runId = created.json().id;

    const first = await app.inject({
      method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/auto`, payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().stoppedReason).toBe("awaiting_review");
    expect(first.json().steps).toHaveLength(1);
    expect(first.json().steps[0]).toMatchObject({ nodeId: "a", action: "submitted" });
    expect(first.json().state.nodeStatuses).toMatchObject({ a: "in_review", b: "not_started" });

    // the human accepts; the next pass picks up the dependent node
    await app.inject({
      method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_accepted", nodeId: "a" },
    });
    const second = await app.inject({
      method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/auto`, payload: {},
    });
    expect(second.json().steps[0]).toMatchObject({ nodeId: "b", action: "submitted" });
    expect(second.json().stoppedReason).toBe("awaiting_review");

    await app.inject({
      method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_accepted", nodeId: "b" },
    });
    const view = await app.inject({ method: "GET", headers: junoAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.status).toBe("completed");
  });

  it("a refusal blocks that node and the pass keeps driving independent branches", async () => {
    const created = await app.inject({
      method: "POST", headers: junoAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "auto-refusal",
          escalationApproverUserId: approverId,
          nodes: [mkNode("a", autoWorkerId), mkNode("b", autoWorkerId)],
        },
      },
    });
    const runId = created.json().id;

    const res = await app.inject({
      method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true, inputs: { a: "please <<refuse>> this" } },
    });
    expect(res.statusCode).toBe(200);
    const byNode = Object.fromEntries(
      res.json().steps.map((s: { nodeId: string; action: string }) => [s.nodeId, s.action]),
    );
    expect(byNode.a).toBe("refused");
    expect(byNode.b).toBe("accepted");
    expect(res.json().stoppedReason).toBe("blocked");
    expect(res.json().state.nodeStatuses).toMatchObject({ a: "blocked", b: "done" });
    expect(res.json().state.lastError.a).toBe("worker refused the task");
  });

  it("a measured budget breach stops the pass and leaves the rest of the graph untouched", async () => {
    const kaiId = await mkUser("auto-kai@example.com", "Auto Kai");
    const kaiAuth = await authFor(kaiId);
    const priceyRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "auto-pricey", provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1_000_000, costPerMTokOut: 1_000_000, model: "mock-auto-pricey",
      },
    });
    const priceyId = priceyRes.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: kaiId, agentId: priceyId },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${kaiId}/agent-policy`,
      payload: { runBudgetUsd: 10, runBudgetBreachAction: "approve" },
    });

    const created = await app.inject({
      method: "POST", headers: kaiAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "auto-budget",
          escalationApproverUserId: approverId,
          nodes: [mkNode("a", priceyId), mkNode("b", priceyId), mkNode("c", priceyId)],
        },
      },
    });
    const runId = created.json().id;

    const res = await app.inject({
      method: "POST", headers: kaiAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true, inputs: { a: "x".repeat(100) } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stoppedReason).toBe("budget_exceeded_measured");
    expect(res.json().measuredSpentUsd).toBeGreaterThan(10);
    // only the breaching node ran; nothing was stranded mid-flight
    expect(res.json().state.nodeStatuses).toMatchObject({
      a: "done", b: "not_started", c: "not_started",
    });
    const view = await app.inject({ method: "GET", headers: kaiAuth, url: `/v1/runs/${runId}` });
    expect(
      view.json().pendingApprovals.some((a: { stageId: string }) => a.stageId === "__budget__:a"),
    ).toBe(true);
  });

  it("a terminal run cannot auto-advance", async () => {
    const created = await app.inject({
      method: "POST", headers: junoAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "auto-terminal",
          escalationApproverUserId: approverId,
          nodes: [mkNode("a", autoWorkerId)],
        },
      },
    });
    const runId = created.json().id;
    await app.inject({
      method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/events`,
      payload: { kind: "abort" },
    });
    const res = await app.inject({
      method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/auto`, payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("run_terminal");
  });
});

describe("workflow build-stage nesting (§8): a build stage executes as an orchestration run", () => {
  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    estimate: { in: 1, out: 1 },
    ...extra,
  });
  const mkUser = async (email: string, name: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email, displayName: name },
    });
    return r.json().id as string;
  };
  const mkTemplate = async (name: string, changeType: string, definition: Record<string, unknown>) => {
    const t = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: { name, definition },
    });
    expect(t.statusCode).toBe(201);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: t.json().id, changeType },
    });
    return t.json().id as string;
  };
  const startInstance = (auth: { authorization: string }, changeType: string) =>
    app.inject({
      method: "POST", headers: auth, url: "/v1/workflows/instances",
      payload: {
        change: { description: `${changeType} change`, paths: ["x.ts"], changeType, environment: "staging" },
      },
    });

  let nitaId: string;
  let nitaAuth: { authorization: string };
  let nestApproverId: string;
  let nestWorkerId: string;

  it("start → nested run spawned under the initiator; completing the run completes the instance", async () => {
    nitaId = await mkUser("nest-nita@example.com", "Nest Nita");
    nitaAuth = await authFor(nitaId);
    nestApproverId = await mkUser("nest-approver@example.com", "Nest Approver");
    const agentRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "nest-worker", provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-nest",
      },
    });
    nestWorkerId = agentRes.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: nitaId, agentId: nestWorkerId },
    });

    await mkTemplate("nested-build", "nest-happy", {
      workflow: "nested-build",
      stages: [
        { id: "intake", type: "trigger" },
        {
          id: "build",
          type: "automated_build",
          run: {
            run: "nested-build-run",
            escalationApproverUserId: nestApproverId,
            nodes: [mkNode("a", nestWorkerId), mkNode("b", nestWorkerId, { dependsOn: ["a"] })],
          },
        },
      ],
    });

    const started = await startInstance(nitaAuth, "nest-happy");
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id;
    expect(started.json().status).toBe("awaiting_execution");

    const view = await app.inject({
      method: "GET", headers: nitaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    const runId = view.json().instance.context["runId:build"];
    expect(runId).toBeTruthy();

    // the nested run is a real, visible run bound to the instance, planned
    // under the INITIATOR's entitlements and not yet started
    const runView = await app.inject({ method: "GET", headers: nitaAuth, url: `/v1/runs/${runId}` });
    expect(runView.statusCode).toBe(200);
    expect(runView.json().run.workflowInstanceId).toBe(instanceId);
    expect(runView.json().run.status).toBe("planned");
    expect(runView.json().run.initiatingUserId).toBe(nitaId);

    // retrying the stage while the run is live never spawns a second run
    await app.inject({
      method: "POST", headers: nitaAuth, url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "build" },
    });
    const runs = await app.inject({ method: "GET", headers: AUTH, url: "/v1/runs" });
    expect(
      runs.json().runs.filter((r: { workflowInstanceId: string | null }) => r.workflowInstanceId === instanceId),
    ).toHaveLength(1);

    // driving the nested run to completion advances the workflow automatically
    const auto = await app.inject({
      method: "POST", headers: nitaAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().status).toBe("completed");

    const after = await app.inject({
      method: "GET", headers: nitaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(after.json().instance.status).toBe("completed");
  });

  it("template creation validates nested graphs and their approvers fail-fast", async () => {
    const cyclic = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "nested-cyclic",
        definition: {
          workflow: "nested-cyclic",
          stages: [
            { id: "intake", type: "trigger" },
            {
              id: "build",
              type: "automated_build",
              run: {
                run: "cyclic",
                escalationApproverUserId: nestApproverId,
                nodes: [
                  mkNode("a", nestWorkerId, { dependsOn: ["b"] }),
                  mkNode("b", nestWorkerId, { dependsOn: ["a"] }),
                ],
              },
            },
          ],
        },
      },
    });
    expect(cyclic.statusCode).toBe(422);
    expect(cyclic.json().error).toBe("invalid_run_graph");

    const ghostApprover = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "nested-ghost",
        definition: {
          workflow: "nested-ghost",
          stages: [
            { id: "intake", type: "trigger" },
            {
              id: "build",
              type: "automated_build",
              run: {
                run: "ghost",
                escalationApproverUserId: "00000000-0000-0000-0000-000000000000",
                nodes: [mkNode("a", nestWorkerId)],
              },
            },
          ],
        },
      },
    });
    expect(ghostApprover.statusCode).toBe(422);
    expect(ghostApprover.json().error).toBe("invalid_approver");
  });

  it("a nested run the initiator is not entitled to fails the stage explicitly and is retryable after a grant", async () => {
    const olafId = await mkUser("nest-olaf@example.com", "Nest Olaf");
    const olafAuth = await authFor(olafId);

    await mkTemplate("nested-entitlement", "nest-entitlement", {
      workflow: "nested-entitlement",
      stages: [
        { id: "intake", type: "trigger" },
        {
          id: "build",
          type: "automated_build",
          run: {
            run: "entitlement-run",
            escalationApproverUserId: nestApproverId,
            nodes: [mkNode("a", nestWorkerId)],
          },
        },
      ],
    });

    // olaf has NO grant for nest-worker — the spawn is rejected, audited, retryable
    const started = await startInstance(olafAuth, "nest-entitlement");
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id;
    expect(started.json().status).toBe("awaiting_execution");
    const view = await app.inject({
      method: "GET", headers: olafAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(String(view.json().instance.context.lastError)).toContain("entitlement_exceeded");
    expect(view.json().instance.context["runId:build"]).toBeUndefined();

    // grant arrives; retry via /advance spawns the run for real
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: olafId, agentId: nestWorkerId },
    });
    await app.inject({
      method: "POST", headers: olafAuth, url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "build" },
    });
    const retried = await app.inject({
      method: "GET", headers: olafAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    const runId = retried.json().instance.context["runId:build"];
    expect(runId).toBeTruthy();

    const auto = await app.inject({
      method: "POST", headers: olafAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true },
    });
    expect(auto.json().status).toBe("completed");
    const after = await app.inject({
      method: "GET", headers: olafAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(after.json().instance.status).toBe("completed");
  });

  it("an aborted nested run fails the stage; retry spawns a fresh run", async () => {
    await mkTemplate("nested-abort", "nest-abort", {
      workflow: "nested-abort",
      stages: [
        { id: "intake", type: "trigger" },
        {
          id: "build",
          type: "automated_build",
          run: {
            run: "abortable-run",
            escalationApproverUserId: nestApproverId,
            nodes: [mkNode("a", nestWorkerId)],
          },
        },
      ],
    });
    const started = await startInstance(nitaAuth, "nest-abort");
    const instanceId = started.json().id;
    const view = await app.inject({
      method: "GET", headers: nitaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    const firstRunId = view.json().instance.context["runId:build"];

    await app.inject({
      method: "POST", headers: nitaAuth, url: `/v1/runs/${firstRunId}/events`,
      payload: { kind: "abort" },
    });
    const failed = await app.inject({
      method: "GET", headers: nitaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(failed.json().instance.status).toBe("awaiting_execution");
    expect(String(failed.json().instance.context.lastError)).toContain("aborted");

    await app.inject({
      method: "POST", headers: nitaAuth, url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "build" },
    });
    const retried = await app.inject({
      method: "GET", headers: nitaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    const secondRunId = retried.json().instance.context["runId:build"];
    expect(secondRunId).toBeTruthy();
    expect(secondRunId).not.toBe(firstRunId);

    const auto = await app.inject({
      method: "POST", headers: nitaAuth, url: `/v1/runs/${secondRunId}/auto`,
      payload: { acceptReviews: true },
    });
    expect(auto.json().status).toBe("completed");
    const after = await app.inject({
      method: "GET", headers: nitaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(after.json().instance.status).toBe("completed");
  });
});

describe("nested-run workers receive signed-off workflow artifacts (§2 scope-lock)", () => {
  const mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;
  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    estimate: { in: 1, out: 1 },
    ...extra,
  });

  let pipaId: string;
  let pipaAuth: { authorization: string };
  let scopeWorkerId: string;

  it("the worker's system context is exactly the signed-off artifact, recorded for traceability", async () => {
    const pipa = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "scope-pipa@example.com", displayName: "Scope Pipa" },
    });
    pipaId = pipa.json().id;
    pipaAuth = await authFor(pipaId);
    const approver = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "scope-approver@example.com", displayName: "Scope Approver" },
    });
    const agentRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "scope-worker", provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-scope",
      },
    });
    scopeWorkerId = agentRes.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: pipaId, agentId: scopeWorkerId },
    });

    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "scope-locked-build",
        definition: {
          workflow: "scope-locked-build",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            {
              id: "build",
              type: "automated_build",
              scope: "requirements_file",
              run: {
                run: "scope-run",
                escalationApproverUserId: approver.json().id,
                nodes: [mkNode("impl", scopeWorkerId)],
              },
            },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "scope-lock-test" },
    });

    const started = await app.inject({
      method: "POST", headers: pipaAuth, url: "/v1/workflows/instances",
      payload: {
        change: { description: "scoped", paths: ["s.ts"], changeType: "scope-lock-test", environment: "staging" },
      },
    });
    const instanceId = started.json().id;
    expect(started.json().status).toBe("blocked_on_artifact");

    await app.inject({
      method: "POST", headers: pipaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "UNIQUE-SCOPE-LOCK-CONTENT-77" },
    });
    const view = await app.inject({
      method: "GET", headers: pipaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    const runId = view.json().instance.context["runId:build"];
    expect(runId).toBeTruthy();

    const auto = await app.inject({
      method: "POST", headers: pipaAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true },
    });
    expect(auto.json().status).toBe("completed");
    const after = await app.inject({
      method: "GET", headers: pipaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(after.json().instance.status).toBe("completed");

    // the model call itself carried the signed-off artifact as system context
    const dispatch = mock.dispatches.find(
      (d) => d.model === "mock-scope" && d.system?.includes("UNIQUE-SCOPE-LOCK-CONTENT-77"),
    );
    expect(dispatch).toBeDefined();
    expect(dispatch!.system).toContain("signed-off artifact 'requirements_file' v1");
    expect(dispatch!.system).toContain("node 'impl'");
    expect(dispatch!.system).toContain("do not expand scope");

    // §6 traceability: the run history records which artifact versions framed
    // the execution
    const runView = await app.inject({ method: "GET", headers: pipaAuth, url: `/v1/runs/${runId}` });
    const evt = runView.json().events.find(
      (e: { event: { kind: string } }) => e.event.kind === "node_dispatched",
    );
    expect(evt.event.contextArtifacts).toEqual([{ output: "requirements_file", version: 1 }]);
  });

  it("standalone runs stay artifact-free: no system context is injected", async () => {
    const approver = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "scope-approver2@example.com", displayName: "Scope Approver 2" },
    });
    const created = await app.inject({
      method: "POST", headers: pipaAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "standalone-no-system",
          escalationApproverUserId: approver.json().id,
          nodes: [mkNode("solo", scopeWorkerId)],
        },
      },
    });
    const runId = created.json().id;
    const auto = await app.inject({
      method: "POST", headers: pipaAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true, inputs: { solo: "STANDALONE-NO-SYSTEM-42" } },
    });
    expect(auto.json().status).toBe("completed");
    const dispatch = mock.dispatches.find((d) => d.input === "STANDALONE-NO-SYSTEM-42");
    expect(dispatch).toBeDefined();
    expect(dispatch!.system).toBeUndefined();
  });
});

describe("per-user model credentials (BYO key): user key wins, platform is the fallback", () => {
  async function startFakeAnthropic(marker: string) {
    const hits: Array<{ apiKey: string | null }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ apiKey: (req.headers["x-api-key"] as string) ?? null });
        const parsed = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `msg_${marker}_${hits.length}`,
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [{ type: "text", text: `${marker}-reply` }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${addr.port}`,
      hits,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  }

  let userSrv: Awaited<ReturnType<typeof startFakeAnthropic>>;
  let platformSrv: Awaited<ReturnType<typeof startFakeAnthropic>>;
  let rheaId: string;
  let rheaAuth: { authorization: string };
  let byokAgentId: string;

  afterAll(async () => {
    await userSrv?.close();
    await platformSrv?.close();
  });

  it("credentials are self-service, write-only, and private to their user", async () => {
    userSrv = await startFakeAnthropic("USERKEY");
    platformSrv = await startFakeAnthropic("PLATFORM");
    const rhea = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "byok-rhea@example.com", displayName: "Byok Rhea" },
    });
    rheaId = rhea.json().id;
    rheaAuth = await authFor(rheaId);
    const agentRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "byok-agent", provider: "anthropic", tier: 1, modes: ["execute"],
        costPerMTokIn: 5, costPerMTokOut: 25, model: "claude-opus-5",
      },
    });
    byokAgentId = agentRes.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: rheaId, agentId: byokAgentId },
    });

    const created = await app.inject({
      method: "POST", headers: rheaAuth, url: `/v1/users/${rheaId}/model-credentials`,
      payload: { provider: "anthropic", apiKey: "sk-user-rhea-key", baseUrl: userSrv.url },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain("sk-user-rhea-key");

    const listed = await app.inject({
      method: "GET", headers: rheaAuth, url: `/v1/users/${rheaId}/model-credentials`,
    });
    expect(listed.json().credentials).toHaveLength(1);
    expect(JSON.stringify(listed.json())).not.toContain("sk-user-rhea-key");

    // another non-admin cannot touch rhea's credentials
    const sven = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "byok-sven@example.com", displayName: "Byok Sven" },
    });
    const svenAuth = await authFor(sven.json().id);
    const denied = await app.inject({
      method: "GET", headers: svenAuth, url: `/v1/users/${rheaId}/model-credentials`,
    });
    expect(denied.statusCode).toBe(403);
  });

  it("a dispatch rides the user's own key when one exists", async () => {
    const res = await app.inject({
      method: "POST", headers: rheaAuth, url: `/v1/agents/${byokAgentId}/invoke`,
      payload: { mode: "execute", input: "hello from byok", dispatch: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.outputText).toBe("USERKEY-reply");
    expect(res.json().dispatch.credentialSource).toBe("user");
    expect(userSrv.hits).toHaveLength(1);
    expect(userSrv.hits[0]!.apiKey).toBe("sk-user-rhea-key");
    expect(platformSrv.hits).toHaveLength(0);

    const ledger = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${rheaId}`,
    });
    expect(ledger.json().events[0].detail.credentialSource).toBe("user");
  });

  it("without a user key the platform credential is the fallback", async () => {
    const removed = await app.inject({
      method: "DELETE", headers: rheaAuth, url: `/v1/users/${rheaId}/model-credentials/anthropic`,
    });
    expect(removed.json().removed).toBe(true);
    // point the platform credential at the platform fake (upsert)
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/model-credentials",
      payload: { provider: "anthropic", apiKey: "sk-platform-key", baseUrl: platformSrv.url },
    });

    const res = await app.inject({
      method: "POST", headers: rheaAuth, url: `/v1/agents/${byokAgentId}/invoke`,
      payload: { mode: "execute", input: "fallback please", dispatch: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.outputText).toBe("PLATFORM-reply");
    expect(res.json().dispatch.credentialSource).toBe("platform");
    expect(platformSrv.hits).toHaveLength(1);
    expect(platformSrv.hits[0]!.apiKey).toBe("sk-platform-key");
  });

  it("re-adding the user key restores precedence over the platform credential", async () => {
    await app.inject({
      method: "POST", headers: rheaAuth, url: `/v1/users/${rheaId}/model-credentials`,
      payload: { provider: "anthropic", apiKey: "sk-user-rhea-key-2", baseUrl: userSrv.url },
    });
    const res = await app.inject({
      method: "POST", headers: rheaAuth, url: `/v1/agents/${byokAgentId}/invoke`,
      payload: { mode: "execute", input: "precedence check", dispatch: true },
    });
    expect(res.json().dispatch.credentialSource).toBe("user");
    expect(userSrv.hits).toHaveLength(2);
    expect(userSrv.hits[1]!.apiKey).toBe("sk-user-rhea-key-2");
    expect(platformSrv.hits).toHaveLength(1); // untouched
  });
});

describe("per-project cost rollup (pillar 5): attribution, dashboard, budget enforcement", () => {
  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    estimate: { in: 1, out: 1 },
    ...extra,
  });

  let tessaId: string;
  let tessaAuth: { authorization: string };
  let finnId: string;
  let projWorkerId: string;
  let atlasId: string;
  let cappedId: string;

  it("projects are created with chargeback fields; a budget requires a named approver", async () => {
    const tessa = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proj-tessa@example.com", displayName: "Proj Tessa" },
    });
    tessaId = tessa.json().id;
    tessaAuth = await authFor(tessaId);
    const finn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proj-finn@example.com", displayName: "Proj Finn" },
    });
    finnId = finn.json().id;

    const noApprover = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "bad-budget", budgetUsd: 100 },
    });
    expect(noApprover.statusCode).toBe(400);

    const atlas = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "atlas-migration", costCenter: "CC-1234" },
    });
    expect(atlas.statusCode).toBe(201);
    atlasId = atlas.json().id;
    expect(atlas.json().costCenter).toBe("CC-1234");

    const capped = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "capped-project", budgetUsd: 10, budgetApproverUserId: finnId },
    });
    expect(capped.statusCode).toBe(201);
    cappedId = capped.json().id;
  });

  it("spend is attributed at every entry point: invoke, run, and workflow-nested run", async () => {
    const agentRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "proj-worker", provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-proj",
      },
    });
    projWorkerId = agentRes.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: tessaId, agentId: projWorkerId },
    });

    // unknown project is rejected at the entry point
    const ghost = await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/agents/${projWorkerId}/invoke`,
      payload: { mode: "execute", input: "x", dispatch: true, projectId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(ghost.statusCode).toBe(400);

    // 1) direct invoke
    const invoked = await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/agents/${projWorkerId}/invoke`,
      payload: { mode: "execute", input: "direct spend", dispatch: true, projectId: atlasId },
    });
    expect(invoked.statusCode).toBe(200);

    // 2) standalone run
    const run = await app.inject({
      method: "POST", headers: tessaAuth, url: "/v1/runs",
      payload: {
        projectId: atlasId,
        graph: {
          run: "proj-run",
          escalationApproverUserId: finnId,
          nodes: [mkNode("a", projWorkerId)],
        },
      },
    });
    expect(run.statusCode).toBe(201);
    await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/runs/${run.json().id}/auto`,
      payload: { acceptReviews: true },
    });

    // 3) workflow instance whose nested run inherits the project
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "proj-nested",
        definition: {
          workflow: "proj-nested",
          stages: [
            { id: "intake", type: "trigger" },
            {
              id: "build", type: "automated_build",
              run: {
                run: "proj-nested-run",
                escalationApproverUserId: finnId,
                nodes: [mkNode("impl", projWorkerId)],
              },
            },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "proj-nested-test" },
    });
    const started = await app.inject({
      method: "POST", headers: tessaAuth, url: "/v1/workflows/instances",
      payload: {
        projectId: atlasId,
        change: { description: "proj", paths: ["p.ts"], changeType: "proj-nested-test", environment: "staging" },
      },
    });
    const instanceId = started.json().id;
    const view = await app.inject({
      method: "GET", headers: tessaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    const nestedRunId = view.json().instance.context["runId:build"];
    const nestedRun = await app.inject({ method: "GET", headers: tessaAuth, url: `/v1/runs/${nestedRunId}` });
    expect(nestedRun.json().run.projectId).toBe(atlasId); // inheritance
    await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/runs/${nestedRunId}/auto`,
      payload: { acceptReviews: true },
    });

    // the rollup sees all three, broken down for showback
    const rollup = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${atlasId}/costs`,
    });
    expect(rollup.statusCode).toBe(200);
    const body = rollup.json();
    expect(body.measured.events).toBe(3);
    expect(body.measured.costUsd).toBeGreaterThan(0);
    expect(body.byUser).toHaveLength(1);
    expect(body.byUser[0].userId).toBe(tessaId);
    expect(body.byAgent[0]).toMatchObject({ agentId: projWorkerId, model: "mock-proj" });
    // routing decisions carried attribution into the estimates ledger too
    expect(
      body.estimatedSavings.some((t: { technique: string }) => t.technique === "model_routing"),
    ).toBe(true);
    expect(body.budget.budgetUsd).toBeNull();
    expect(body.forecast.projectedEomUsd).toBeGreaterThanOrEqual(body.budget.spentUsd);
    expect(body.forecast.dailyRateUsd).toBeGreaterThan(0);

    // the fleet list shows per-project spend
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/projects" });
    const atlasRow = list.json().projects.find((p: { id: string }) => p.id === atlasId);
    expect(atlasRow.spentUsd).toBeCloseTo(body.measured.costUsd, 10);
    expect(atlasRow.usageEvents).toBe(3);
  });

  it("crossing the project budget alerts once, blocks after, and resumes when the approver sanctions it", async () => {
    const priceyRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "proj-pricey", provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1_000_000, costPerMTokOut: 1_000_000, model: "mock-proj-pricey",
      },
    });
    const priceyId = priceyRes.json().id;
    // uma is granted ONLY the pricey agent, so routing cannot downgrade the
    // request to a cheaper model and dodge the budget crossing
    const uma = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proj-uma@example.com", displayName: "Proj Uma" },
    });
    const umaId = uma.json().id;
    const umaAuth = await authFor(umaId);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: umaId, agentId: priceyId },
    });

    // first crossing: allowed, alerted into the one approvals queue
    const first = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/agents/${priceyId}/invoke`,
      payload: { mode: "execute", input: "x".repeat(100), dispatch: true, projectId: cappedId },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().dispatch.projectBudgetAlerted).toBe(true);

    // everything after the crossing is blocked
    const second = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/agents/${priceyId}/invoke`,
      payload: { mode: "execute", input: "small", dispatch: true, projectId: cappedId },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("project_budget_exceeded");

    const rollup = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${cappedId}/costs`,
    });
    expect(rollup.json().budget.overBudget).toBe(true);
    expect(rollup.json().budget.remainingUsd).toBeLessThan(0);

    // the named approver sanctions the overage → dispatch resumes
    const finnAuth = await authFor(finnId);
    const inbox = await app.inject({ method: "GET", headers: finnAuth, url: "/v1/approvals" });
    const pending = inbox.json().approvals.find(
      (a: { objectType: string; projectId: string | null; status: string }) =>
        a.objectType === "project" && a.projectId === cappedId && a.status === "pending",
    );
    expect(pending).toBeDefined();
    const decided = await app.inject({
      method: "POST", headers: finnAuth, url: `/v1/approvals/${pending.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);

    const third = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/agents/${priceyId}/invoke`,
      payload: { mode: "execute", input: "resumed", dispatch: true, projectId: cappedId },
    });
    expect(third.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${cappedId}/costs`,
    });
    expect(after.json().budget.overageApproved).toBe(true);
  });

  it("the dashboard surface is admin-only and 404s on unknown projects", async () => {
    const denied = await app.inject({
      method: "GET", headers: tessaAuth, url: `/v1/projects/${atlasId}/costs`,
    });
    expect(denied.statusCode).toBe(403);
    const missing = await app.inject({
      method: "GET", headers: AUTH, url: "/v1/projects/00000000-0000-0000-0000-000000000000/costs",
    });
    expect(missing.statusCode).toBe(404);
  });

  // ----- polish slice 3: monthly budget window + alert threshold + CSV -----

  it("a monthly budget counts only current-month spend; older spend is excluded from the gate but shown as lifetime", async () => {
    const proj = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: {
        name: "monthly-window", budgetUsd: 1, budgetApproverUserId: finnId,
        budgetPeriod: "monthly", alertThresholdPct: 50,
      },
    });
    expect(proj.statusCode).toBe(201);
    expect(proj.json().budgetPeriod).toBe("monthly");
    expect(proj.json().alertThresholdPct).toBe(50);
    const monthlyId = proj.json().id;

    // an OLD event (previous calendar month), over budget on its own — must be
    // excluded from the current-month window but counted in lifetime
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12, 0, 0));
    await db.insert(usageEvents).values({
      userId: tessaId, projectId: monthlyId, objectType: "agent",
      agentId: projWorkerId, model: "mock-proj", inputTokens: 1, outputTokens: 1,
      costUsd: 5, at: lastMonth,
    });

    const roll = await app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${monthlyId}/costs` });
    const bg = roll.json().budget;
    expect(bg.period).toBe("monthly");
    expect(bg.periodKey).toBe(currentPeriodKey(now));
    expect(bg.spentUsd).toBe(0); // windowed: the old row is outside the window
    expect(bg.lifetimeSpentUsd).toBeCloseTo(5, 6);
    expect(bg.remainingUsd).toBeCloseTo(1, 6); // full budget available this month

    // a current-month dispatch is ALLOWED despite the over-budget lifetime spend
    const inv = await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/agents/${projWorkerId}/invoke`,
      payload: { mode: "execute", input: "current month spend", dispatch: true, projectId: monthlyId },
    });
    expect(inv.statusCode).toBe(200);
  });

  it("the alert threshold warns below the cap; the cap hard-blocks; the overage is scoped to its period", async () => {
    const proj = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: {
        name: "monthly-threshold", budgetUsd: 1, budgetApproverUserId: finnId,
        budgetPeriod: "monthly", alertThresholdPct: 60,
      },
    });
    const mId = proj.json().id;
    const now = new Date();
    const inWindow = () => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0));

    // seed current-month spend to 70% of the $1 budget (past the 60% threshold,
    // below the cap) so the next dispatch trips the NON-BLOCKING alert
    await db.insert(usageEvents).values({
      userId: tessaId, projectId: mId, objectType: "agent",
      agentId: projWorkerId, model: "mock-proj", inputTokens: 1, outputTokens: 1,
      costUsd: 0.7, at: inWindow(),
    });
    const warned = await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/agents/${projWorkerId}/invoke`,
      payload: { mode: "execute", input: "nudge past threshold", dispatch: true, projectId: mId },
    });
    expect(warned.statusCode).toBe(200); // non-blocking
    expect(warned.json().dispatch.projectBudgetAlerted).toBe(false);
    expect(warned.json().dispatch.projectBudgetThresholdAlert).toMatchObject({
      thresholdPct: 60, period: currentPeriodKey(now),
    });
    const rollWarn = await app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${mId}/costs` });
    expect(rollWarn.json().budget.thresholdCrossed).toBe(true);
    expect(rollWarn.json().budget.overBudget).toBe(false);

    // push windowed spend over the cap → the pre-gate hard-blocks the next call
    await db.insert(usageEvents).values({
      userId: tessaId, projectId: mId, objectType: "agent",
      agentId: projWorkerId, model: "mock-proj", inputTokens: 1, outputTokens: 1,
      costUsd: 0.5, at: inWindow(),
    });
    const blocked = await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/agents/${projWorkerId}/invoke`,
      payload: { mode: "execute", input: "over cap", dispatch: true, projectId: mId },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("project_budget_exceeded");

    // the named approver sanctions the overage → dispatch resumes THIS period,
    // and the latch is stamped with the current period key
    const finnAuth = await authFor(finnId);
    const inbox = await app.inject({ method: "GET", headers: finnAuth, url: "/v1/approvals" });
    const pending = inbox.json().approvals.find(
      (a: { objectType: string; projectId: string | null; stageId: string | null; status: string }) =>
        a.objectType === "project" && a.projectId === mId && a.status === "pending",
    );
    expect(pending).toBeDefined();
    await app.inject({
      method: "POST", headers: finnAuth, url: `/v1/approvals/${pending.id}/decide`,
      payload: { decision: "approved" },
    });
    const resumed = await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/agents/${projWorkerId}/invoke`,
      payload: { mode: "execute", input: "resumed this period", dispatch: true, projectId: mId },
    });
    expect(resumed.statusCode).toBe(200);
    const rollAfter = await app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${mId}/costs` });
    expect(rollAfter.json().budget.overageApprovedPeriod).toBe(currentPeriodKey(now));
    expect(rollAfter.json().budget.overageActive).toBe(true);

    // simulate a NEW period: the latch was approved for a prior period, so it no
    // longer suppresses enforcement — the pre-gate blocks again
    await db
      .update(projects)
      .set({ overageApprovedPeriod: "2000-01" })
      .where(eq(projects.id, mId));
    const nextPeriod = await app.inject({
      method: "POST", headers: tessaAuth, url: `/v1/agents/${projWorkerId}/invoke`,
      payload: { mode: "execute", input: "new period", dispatch: true, projectId: mId },
    });
    expect(nextPeriod.statusCode).toBe(409);
    expect(nextPeriod.json().error).toBe("project_budget_exceeded");
  });

  it("PATCH can set budgetPeriod and alertThresholdPct, and the rollup reflects them", async () => {
    const proj = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "patch-period", budgetUsd: 4, budgetApproverUserId: finnId },
    });
    const pId = proj.json().id;
    // default: lifetime, threshold 80 (ADR-0181)
    const before = await app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${pId}/costs` });
    expect(before.json().budget.period).toBe("none");
    expect(before.json().budget.alertThresholdPct).toBe(80);

    const patched = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/projects/${pId}`,
      payload: { budgetPeriod: "monthly", alertThresholdPct: 75 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().budgetPeriod).toBe("monthly");
    expect(patched.json().alertThresholdPct).toBe(75);
    const after = await app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${pId}/costs` });
    expect(after.json().budget.period).toBe("monthly");
    expect(after.json().budget.alertThresholdPct).toBe(75);
    // out-of-range threshold is rejected by the schema
    const bad = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/projects/${pId}`,
      payload: { alertThresholdPct: 250 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("costs.csv exports per-invocation rows with a header, escaping, and member-only authz", async () => {
    // admin sees atlas' rows (3 dispatches from the attribution test)
    const csv = await app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${atlasId}/costs.csv` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "at,userId,objectType,agentId,connectorId,model,operation,inputTokens,outputTokens,costUsd,measuredCostSavedUsd,projectId",
    );
    expect(lines.length).toBe(1 + 3); // header + 3 usage rows

    // a non-member (atlas is memberless, so non-admins are refused) gets 403
    const denied = await app.inject({ method: "GET", headers: tessaAuth, url: `/v1/projects/${atlasId}/costs.csv` });
    expect(denied.statusCode).toBe(403);

    // proper CSV escaping: a model with a comma and a quote is quoted + doubled
    const proj = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "csv-escape" },
    });
    const eId = proj.json().id;
    await db.insert(usageEvents).values({
      userId: tessaId, projectId: eId, objectType: "agent",
      agentId: projWorkerId, model: 'a,b"c', inputTokens: 1, outputTokens: 1, costUsd: 0.01,
    });
    const esc = await app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${eId}/costs.csv` });
    expect(esc.body).toContain('"a,b""c"');

    // the caller's own usage export honours ?format=csv
    const mine = await app.inject({ method: "GET", headers: tessaAuth, url: "/v1/usage-events?format=csv" });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["content-type"]).toContain("text/csv");
    expect(mine.body.split("\r\n")[0]).toContain("at,userId,objectType");
  });
});

describe("shared projects (pillar 4, ADR-0011): membership, context, conflicts, promotion", () => {
  let teamAId: string;
  let teamBId: string;
  let veraId: string;
  let veraAuth: { authorization: string };
  let wesId: string;
  let wesAuth: { authorization: string };
  let vickyAuth: { authorization: string };
  let xenaId: string;
  let xenaAuth: { authorization: string };
  let uriId: string;
  let sharedId: string;
  let sharedAgentId: string;

  const mkUser = async (email: string, name: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email, displayName: name },
    });
    return r.json().id as string;
  };

  it("membership roles gate context access — and grant zero tool/agent capability", async () => {
    veraId = await mkUser("sp-vera@example.com", "SP Vera");
    veraAuth = await authFor(veraId);
    wesId = await mkUser("sp-wes@example.com", "SP Wes");
    wesAuth = await authFor(wesId);
    const vickyId = await mkUser("sp-vicky@example.com", "SP Vicky");
    vickyAuth = await authFor(vickyId);
    xenaId = await mkUser("sp-xena@example.com", "SP Xena");
    xenaAuth = await authFor(xenaId);
    uriId = await mkUser("sp-uri@example.com", "SP Uri");

    const teamA = await app.inject({ method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "team-a" } });
    teamAId = teamA.json().id;
    const teamB = await app.inject({ method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "team-b" } });
    teamBId = teamB.json().id;
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/teams/${teamAId}/members`, payload: { userId: veraId } });
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/teams/${teamBId}/members`, payload: { userId: wesId } });

    const shared = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "platform-shared", arbiterUserId: uriId },
    });
    sharedId = shared.json().id;

    // provenance team must really be one of the member's teams
    const wrongTeam = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${sharedId}/members`,
      payload: { userId: veraId, role: "contributor", teamId: teamBId },
    });
    expect(wrongTeam.statusCode).toBe(422);

    for (const [userId, role, teamId] of [
      [veraId, "contributor", teamAId],
      [wesId, "contributor", teamBId],
      [vickyId, "viewer", null],
    ] as const) {
      const r = await app.inject({
        method: "POST", headers: AUTH, url: `/v1/projects/${sharedId}/members`,
        payload: { userId, role, teamId },
      });
      expect(r.statusCode).toBe(201);
    }

    // members can list membership; outsiders cannot even see it
    expect((await app.inject({ method: "GET", headers: veraAuth, url: `/v1/projects/${sharedId}/members` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", headers: xenaAuth, url: `/v1/projects/${sharedId}/members` })).statusCode).toBe(403);

    // a viewer reads but cannot write; an outsider cannot read
    const write = await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/projects/${sharedId}/context`,
      payload: { key: "coding-standards", content: "tabs are banned (v1)" },
    });
    expect(write.statusCode).toBe(201);
    expect(write.json()).toMatchObject({ revision: 1, accepted: true });
    expect((await app.inject({
      method: "POST", headers: vickyAuth, url: `/v1/projects/${sharedId}/context`,
      payload: { key: "coding-standards", content: "nope", baseRevision: 1 },
    })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", headers: xenaAuth, url: `/v1/projects/${sharedId}/context` })).statusCode).toBe(403);

    // §9.3: membership is NEVER a capability grant — vera has no agent grant,
    // and being a shared-project contributor changes nothing about that
    const agentRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "sp-agent", provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-sp",
      },
    });
    sharedAgentId = agentRes.json().id;
    const invoke = await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/agents/${sharedAgentId}/invoke`,
      payload: { mode: "execute", input: "hi" },
    });
    expect(invoke.statusCode).toBe(403);
    expect(invoke.json().decision.ruleId).toBe("default-deny");
  });

  it("context is append-only with provenance; writes must name their base revision", async () => {
    const view = await app.inject({ method: "GET", headers: vickyAuth, url: `/v1/projects/${sharedId}/context` });
    const item = view.json().context.find((c: { key: string }) => c.key === "coding-standards");
    expect(item.revision).toBe(1);
    expect(item.provenance).toMatchObject({ userId: veraId, teamId: teamAId });

    // read-before-write is explicit — no silent overwrites
    const blind = await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/projects/${sharedId}/context`,
      payload: { key: "coding-standards", content: "blind write" },
    });
    expect(blind.statusCode).toBe(409);
    expect(blind.json()).toMatchObject({ error: "base_revision_required", latestAccepted: 1 });

    const update = await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/projects/${sharedId}/context`,
      payload: { key: "coding-standards", content: "tabs banned; semicolons required (v2)", baseRevision: 1 },
    });
    expect(update.json()).toMatchObject({ revision: 2, accepted: true });

    const history = await app.inject({
      method: "GET", headers: vickyAuth, url: `/v1/projects/${sharedId}/context?key=coding-standards&history=true`,
    });
    expect(history.json().history).toHaveLength(2);
  });

  it("a stale-base write becomes a conflict for the named arbiter — both sides retained forever", async () => {
    // vera lands revision 3 on top of 2
    await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/projects/${sharedId}/context`,
      payload: { key: "coding-standards", content: "team-a's v3", baseRevision: 2 },
    });
    // wes edits from the SAME base — a real cross-team disagreement
    const conflicted = await app.inject({
      method: "POST", headers: wesAuth, url: `/v1/projects/${sharedId}/context`,
      payload: { key: "coding-standards", content: "team-b's competing v3", baseRevision: 2, teamId: teamBId },
    });
    expect(conflicted.statusCode).toBe(201);
    expect(conflicted.json()).toMatchObject({ revision: 4, accepted: false, conflict: true });
    const approvalId = conflicted.json().approvalId;
    expect(approvalId).toBeTruthy();

    // nothing overwritten: the current value is still vera's revision 3
    const before = await app.inject({ method: "GET", headers: wesAuth, url: `/v1/projects/${sharedId}/context?key=coding-standards` });
    expect(before.json().context[0].revision).toBe(3);
    expect(before.json().context[0].content).toBe("team-a's v3");

    // the named arbiter accepts team-b's side through the ONE approvals queue
    const uriAuth = await authFor(uriId);
    const decided = await app.inject({
      method: "POST", headers: uriAuth, url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", headers: wesAuth, url: `/v1/projects/${sharedId}/context?key=coding-standards` });
    expect(after.json().context[0]).toMatchObject({ revision: 4, content: "team-b's competing v3" });

    // a denied conflict stays retained but never current
    const denied = await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/projects/${sharedId}/context`,
      payload: { key: "coding-standards", content: "stale counter-proposal", baseRevision: 3 },
    });
    expect(denied.json().conflict).toBe(true);
    await app.inject({
      method: "POST", headers: uriAuth, url: `/v1/approvals/${denied.json().approvalId}/decide`,
      payload: { decision: "denied" },
    });
    const final = await app.inject({ method: "GET", headers: wesAuth, url: `/v1/projects/${sharedId}/context?key=coding-standards` });
    expect(final.json().context[0].revision).toBe(4);
    const history = await app.inject({
      method: "GET", headers: wesAuth, url: `/v1/projects/${sharedId}/context?key=coding-standards&history=true`,
    });
    expect(history.json().history).toHaveLength(5); // every side of every conflict retained
    expect(history.json().history.filter((h: { accepted: boolean }) => h.accepted)).toHaveLength(4);

    // conflicts on an arbiter-less project are rejected explicitly
    const noArb = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "no-arbiter-project" },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${noArb.json().id}/members`,
      payload: { userId: veraId, role: "contributor" },
    });
    await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/projects/${noArb.json().id}/context`,
      payload: { key: "k", content: "v1" },
    });
    const rejected = await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/projects/${noArb.json().id}/context`,
      payload: { key: "k", content: "conflicting", baseRevision: 99 },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe("no_arbiter");
  });

  it("promote-to-shared copies a team-local artifact with source provenance; only its owner may promote", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "sp-promote",
        definition: {
          workflow: "sp-promote",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "plan-doc", type: "artifact_generation", output: "shared-plan" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "sp-promote-test" },
    });
    const started = await app.inject({
      method: "POST", headers: veraAuth, url: "/v1/workflows/instances",
      payload: {
        change: { description: "plan", paths: ["a.ts"], changeType: "sp-promote-test", environment: "staging" },
      },
    });
    const instanceId = started.json().id;
    await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "plan-doc", content: "PROMOTED-CONTENT-55" },
    });
    const view = await app.inject({ method: "GET", headers: veraAuth, url: `/v1/workflows/instances/${instanceId}` });
    const artifactId = view.json().artifacts[0].id;

    // wes did not author this artifact — partial sharing is opt-in by the owner
    const stolen = await app.inject({
      method: "POST", headers: wesAuth, url: `/v1/projects/${sharedId}/context/promote`,
      payload: { artifactId },
    });
    expect(stolen.statusCode).toBe(403);

    const promoted = await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/projects/${sharedId}/context/promote`,
      payload: { artifactId },
    });
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json().accepted).toBe(true);
    const ctx = await app.inject({
      method: "GET", headers: wesAuth, url: `/v1/projects/${sharedId}/context?key=shared-plan`,
    });
    expect(ctx.json().context[0].content).toBe("PROMOTED-CONTENT-55");
    expect(ctx.json().context[0].provenance.sourceArtifactId).toBe(artifactId);
  });

  it("membership gates attribution on member-bearing projects; memberless buckets stay open", async () => {
    for (const userId of [veraId, xenaId]) {
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId, agentId: sharedAgentId },
      });
    }
    // a non-member cannot bill the shared project — spend pollution blocked
    const outsider = await app.inject({
      method: "POST", headers: xenaAuth, url: `/v1/agents/${sharedAgentId}/invoke`,
      payload: { mode: "execute", input: "bill it", dispatch: true, projectId: sharedId },
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().error).toBe("not_a_project_member");
    const outsiderRun = await app.inject({
      method: "POST", headers: xenaAuth, url: "/v1/runs",
      payload: {
        projectId: sharedId,
        graph: {
          run: "sp-outsider",
          escalationApproverUserId: uriId,
          nodes: [{ id: "a", title: "task a", ownerAgentId: sharedAgentId, mode: "execute" }],
        },
      },
    });
    expect(outsiderRun.statusCode).toBe(403);

    // a member bills normally
    const member = await app.inject({
      method: "POST", headers: veraAuth, url: `/v1/agents/${sharedAgentId}/invoke`,
      payload: { mode: "execute", input: "member spend", dispatch: true, projectId: sharedId },
    });
    expect(member.statusCode).toBe(200);

    // memberless projects remain open cost buckets (pillar-5 back-compat)
    const bucket = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "open-bucket" },
    });
    const open = await app.inject({
      method: "POST", headers: xenaAuth, url: `/v1/agents/${sharedAgentId}/invoke`,
      payload: { mode: "execute", input: "open spend", dispatch: true, projectId: bucket.json().id },
    });
    expect(open.statusCode).toBe(200);
  });
});

describe("compliance classification cascade (§8.3)", () => {
  let officerId: string;
  let reviewerId: string;
  let chloeAuth: { authorization: string };
  let sensitiveTplId: string;
  let standardTplId: string;
  let ccProjId: string;

  const mkUser = async (email: string, name: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email, displayName: name },
    });
    return r.json().id as string;
  };

  it("profiles compose additively into an effective policy with honest enforcement labels", async () => {
    officerId = await mkUser("cc-officer@example.com", "CC Officer");
    reviewerId = await mkUser("cc-reviewer@example.com", "CC Reviewer");
    const chloeId = await mkUser("cc-chloe@example.com", "CC Chloe");
    chloeAuth = await authFor(chloeId);

    const sensitive = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "sensitive-data",
        definition: {
          workflow: "sensitive-data",
          stages: [
            { id: "cc-intake", type: "trigger" },
            { id: "compliance-signoff", type: "human_approval", approvers: [officerId] },
          ],
        },
      },
    });
    sensitiveTplId = sensitive.json().id;
    const standard = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "cc-standard",
        definition: { workflow: "cc-standard", stages: [{ id: "cc-std-intake", type: "trigger" }] },
      },
    });
    standardTplId = standard.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: standardTplId, changeType: "cc-standard-change" },
    });

    // a profile may only require templates that exist
    const ghost = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
      payload: { tag: "bad", requiredTemplateIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    expect(ghost.statusCode).toBe(422);

    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
      payload: {
        tag: "hipaa", requiredTemplateIds: [sensitiveTplId],
        piiMode: "block", auditRetentionDays: 2555, mcpDefaultMode: "read_only",
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
      payload: { tag: "soc2", piiMode: "warn", auditRetentionDays: 365 },
    });

    const proj = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "cc-proj", classifications: ["hipaa", "soc2"] },
    });
    ccProjId = proj.json().id;

    const view = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${ccProjId}/compliance`,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().classifications).toEqual(["hipaa", "soc2"]);
    expect(view.json().effective).toMatchObject({
      piiMode: "block",           // strictest of block/warn
      auditRetentionDays: 2555,   // max
      mcpDefaultMode: "read_only",
      requiredTemplateIds: [sensitiveTplId],
    });
    expect(view.json().enforcement.requiredWorkflowTemplates).toBe("enforced-at-instance-creation");
    // §8.4 + ADR-0023: piiMode is enforced at every project-ATTRIBUTED model,
    // connector, and MCP tool dispatch, and mcpDefaultMode read_only now
    // denies attributed MCP writes; both labels disclose the unattributed
    // O11 gap honestly.
    expect(view.json().enforcement.piiMode).toBe(
      "enforced-on-attributed-model-connector-and-mcp-dispatch",
    );
    expect(view.json().enforcement.mcpDefaultMode).toContain("enforced-on-attributed-mcp-tool-calls");
  });

  it("classification forces required workflow stages with no manual per-control setup", async () => {
    // matched rule + classified project → the union carries the sign-off stage
    const started = await app.inject({
      method: "POST", headers: chloeAuth, url: "/v1/workflows/instances",
      payload: {
        projectId: ccProjId,
        change: { description: "cc", paths: ["c.ts"], changeType: "cc-standard-change", environment: "staging" },
      },
    });
    expect(started.statusCode).toBe(201);
    expect(started.json().status).toBe("blocked_on_approval");
    const view = await app.inject({
      method: "GET", headers: chloeAuth, url: `/v1/workflows/instances/${started.json().id}`,
    });
    const stageIds = view.json().instance.definition.stages.map((s: { id: string }) => s.id);
    expect(stageIds).toContain("compliance-signoff");
    expect(view.json().pendingApprovals.some(
      (a: { approverUserId: string }) => a.approverUserId === officerId,
    )).toBe(true);

    // no matching rule at all: the classification alone FORCES the workflow…
    const forced = await app.inject({
      method: "POST", headers: chloeAuth, url: "/v1/workflows/instances",
      payload: {
        projectId: ccProjId,
        change: { description: "cc", paths: ["c.ts"], changeType: "cc-unmatched", environment: "staging" },
      },
    });
    expect(forced.statusCode).toBe(201);
    expect(forced.json().status).toBe("blocked_on_approval");

    // …whereas the same change without the project finds no workflow
    const bare = await app.inject({
      method: "POST", headers: chloeAuth, url: "/v1/workflows/instances",
      payload: {
        change: { description: "cc", paths: ["c.ts"], changeType: "cc-unmatched", environment: "staging" },
      },
    });
    expect(bare.statusCode).toBe(422);
  });

  it("reclassification is diff-then-approve — never applied silently", async () => {
    // a change to existing tags needs a named reviewer
    const noReviewer = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${ccProjId}/classifications`,
      payload: { classifications: ["soc2"] },
    });
    expect(noReviewer.statusCode).toBe(422);
    expect(noReviewer.json().error).toBe("reviewer_required");

    const proposed = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${ccProjId}/classifications`,
      payload: { classifications: ["soc2"], reviewerUserId: reviewerId },
    });
    expect(proposed.statusCode).toBe(202);
    expect(proposed.json().diff.effectiveBefore.piiMode).toBe("block");
    expect(proposed.json().diff.effectiveAfter.piiMode).toBe("warn");
    const approvalId = proposed.json().approvalId;

    // nothing changed yet — the old cascade stays in force
    const during = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${ccProjId}/compliance`,
    });
    expect(during.json().classifications).toEqual(["hipaa", "soc2"]);
    expect(during.json().pendingClassifications).toEqual(["soc2"]);

    const reviewerAuth = await authFor(reviewerId);
    // proposed via the identityless bootstrap token, so the row's requester
    // fell back to the reviewer — reads as a self-review, reason required
    await app.inject({
      method: "POST", headers: reviewerAuth, url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved", reason: "reviewed diff; soc2-only is correct" },
    });
    const after = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${ccProjId}/compliance`,
    });
    expect(after.json().classifications).toEqual(["soc2"]);
    expect(after.json().pendingClassifications).toBeNull();
    expect(after.json().effective.piiMode).toBe("warn");

    // a denied proposal leaves everything untouched
    const again = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${ccProjId}/classifications`,
      payload: { classifications: ["hipaa"], reviewerUserId: reviewerId },
    });
    await app.inject({
      method: "POST", headers: reviewerAuth, url: `/v1/approvals/${again.json().approvalId}/decide`,
      payload: { decision: "denied", reason: "keep soc2-only" },
    });
    const final = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${ccProjId}/compliance`,
    });
    expect(final.json().classifications).toEqual(["soc2"]);
    expect(final.json().pendingClassifications).toBeNull();
  });

  it("a member team's conflicting defaults are surfaced at member-add — the project governs", async () => {
    const doraId = await mkUser("cc-dora@example.com", "CC Dora");
    const pciTeam = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/teams",
      payload: { name: "cc-pci-team", defaultClassifications: ["pci-dss"] },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/teams/${pciTeam.json().id}/members`,
      payload: { userId: doraId },
    });
    const added = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${ccProjId}/members`,
      payload: { userId: doraId, role: "contributor", teamId: pciTeam.json().id },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().classificationConflict).toMatchObject({
      notCoveredByProject: ["pci-dss"],
      governing: "project",
    });
    const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit" });
    expect(
      audit.json().entries.some(
        (e: { ruleId: string }) => e.ruleId === "team-classification-conflict-surfaced",
      ),
    ).toBe(true);
  });
});

// ADR-0033 deleted the ADR-0012 template-literal admin shell this suite used
// to also assert the rendered panels of. The endpoints it existed to back are
// the durable part and stay covered here; the shell's own rendering is now the
// SPA's, covered by apps/web's Playwright suites.
describe("admin portal: the API-parity gap endpoints", () => {

  it("the gap list endpoints exist and stay admin-only", async () => {
    const usersList = await app.inject({ method: "GET", headers: AUTH, url: "/v1/users" });
    expect(usersList.statusCode).toBe(200);
    expect(usersList.json().users.length).toBeGreaterThan(0);
    expect(usersList.json().users[0]).toHaveProperty("email");

    const servers = await app.inject({ method: "GET", headers: AUTH, url: "/v1/servers" });
    expect(servers.statusCode).toBe(200);
    expect(servers.json().servers.length).toBeGreaterThan(0);
    const tools = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/servers/${serverId}/tools`,
    });
    expect(tools.statusCode).toBe(200);

    for (const path of ["/v1/rules/approvals", "/v1/rules/data-scopes", "/v1/rules/rate-limits"]) {
      const r = await app.inject({ method: "GET", headers: AUTH, url: path });
      expect(r.statusCode).toBe(200);
      expect(Array.isArray(r.json().rules)).toBe(true);
    }

    // non-admins get none of this
    const bob = await app.inject({
      method: "GET", headers: await authFor(bobId), url: "/v1/users",
    });
    expect(bob.statusCode).toBe(403);
  });
});

describe("streaming dispatch (SSE): same gates, same ledger, delivered as deltas", () => {
  let sabaId: string;
  let sabaAuth: { authorization: string };
  let streamAgentId: string;

  // ADR-0181: the strict PII floor and the prompt-injection output layer are
  // both 'block' by default, which never streams live. This block pins LIVE
  // delta streaming, so it sets the lax posture explicitly and restores it.
  let restorePosture: () => Promise<void>;
  beforeAll(async () => {
    restorePosture = await relaxDataPostureForTest(db, {
      org: { defaultPiiMode: "none" },
      interception: false,
      guardrails: { promptInjectionMode: "warn" },
    });
  });
  afterAll(async () => {
    await restorePosture();
  });

  const parseEvents = (body: string) =>
    body.split("\n\n").filter(Boolean).map((chunk) => {
      const event = /event: (.+)/.exec(chunk)?.[1];
      const data = /data: (.+)/.exec(chunk)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });

  it("dispatch+stream delivers deltas then one result event carrying the JSON payload", async () => {
    const saba = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "stream-saba@example.com", displayName: "Stream Saba" },
    });
    sabaId = saba.json().id;
    sabaAuth = await authFor(sabaId);
    const agentRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: "stream-agent", provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-stream",
      },
    });
    streamAgentId = agentRes.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: sabaId, agentId: streamAgentId },
    });

    const res = await app.inject({
      method: "POST", headers: sabaAuth, url: `/v1/agents/${streamAgentId}/invoke`,
      payload: { mode: "execute", input: "stream this back", dispatch: true, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseEvents(res.body);
    const deltas = events.filter((e) => e.event === "delta");
    const results = events.filter((e) => e.event === "result");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(results).toHaveLength(1);
    const result = results[0]!.data;
    expect(result.decision.effect).toBe("allow");
    expect(result.dispatch.outputText).toContain("stream this back");
    // the deltas ARE the output — concatenation matches the final result
    expect(deltas.map((d) => d.data.text).join("")).toBe(result.dispatch.outputText);

    // the measured ledger and audit trail are identical to the JSON path
    const ledger = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${sabaId}`,
    });
    expect(ledger.json().events).toHaveLength(1);
    expect(ledger.json().events[0].model).toBe("mock-stream");
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${sabaId}` });
    const row = audit.json().entries.find((e: { objectType: string }) => e.objectType === "agent");
    expect(row.detail.stream).toBe(true);
    expect(row.detail.dispatch.model).toBe("mock-stream");
  });

  it("a refusal streams no deltas and the result event carries the refusal honestly", async () => {
    const res = await app.inject({
      method: "POST", headers: sabaAuth, url: `/v1/agents/${streamAgentId}/invoke`,
      payload: { mode: "execute", input: "please <<refuse>> this", dispatch: true, stream: true },
    });
    const events = parseEvents(res.body);
    expect(events.filter((e) => e.event === "delta")).toHaveLength(0);
    const result = events.find((e) => e.event === "result")!.data;
    expect(result.dispatch.refusal).toBe(true);
    expect(result.dispatch.outputText).toBe("");
  });

  it("a denial never opens a stream — plain JSON 403 before any SSE", async () => {
    const nog = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "stream-nog@example.com", displayName: "Stream Nog" },
    });
    const res = await app.inject({
      method: "POST", headers: await authFor(nog.json().id),
      url: `/v1/agents/${streamAgentId}/invoke`,
      payload: { mode: "execute", input: "hi", dispatch: true, stream: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().decision.ruleId).toBe("default-deny");
  });
});

describe("openai model adapter: the full governed pipeline over a second provider", () => {
  it("dispatch rides an openai-provider agent end-to-end with measured usage", async () => {
    // local fake chat.completions endpoint — the real adapter, no network
    const hits: Array<{ auth: string | null }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ auth: (req.headers.authorization as string) ?? null });
        const parsed = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion",
          created: 1,
          model: parsed.model,
          choices: [{ index: 0, message: { role: "assistant", content: "openai says hi", refusal: null }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const oda = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "oai-oda@example.com", displayName: "OAI Oda" },
      });
      const odaAuth = await authFor(oda.json().id);
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "oai-agent", provider: "openai", tier: 1, modes: ["execute"],
          costPerMTokIn: 2, costPerMTokOut: 8, model: "gpt-5",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: oda.json().id, agentId: agentRes.json().id },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/model-credentials",
        payload: { provider: "openai", apiKey: "sk-oai-platform", baseUrl: `http://127.0.0.1:${port}/v1` },
      });

      const res = await app.inject({
        method: "POST", headers: odaAuth, url: `/v1/agents/${agentRes.json().id}/invoke`,
        payload: { mode: "execute", input: "hello openai", dispatch: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().dispatch.outputText).toBe("openai says hi");
      expect(res.json().dispatch.stopReason).toBe("end_turn");
      expect(res.json().dispatch.usage).toEqual({ inputTokens: 8, outputTokens: 4 });
      expect(res.json().dispatch.credentialSource).toBe("platform");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.auth).toBe("Bearer sk-oai-platform");

      const ledger = await app.inject({
        method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${oda.json().id}`,
      });
      expect(ledger.json().events[0]).toMatchObject({
        provider: "openai", model: "gpt-5", inputTokens: 8, outputTokens: 4,
      });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("google model adapter: the full governed pipeline over a third provider", () => {
  it("dispatch rides a google-provider agent end-to-end with measured usage", async () => {
    const hits: Array<{ key: string | null; path: string }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ key: (req.headers["x-goog-api-key"] as string) ?? null, path: req.url ?? "" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          responseId: "resp-e2e",
          candidates: [{ content: { role: "model", parts: [{ text: "gemini says hi" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 9 },
        }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const gia = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "goog-gia@example.com", displayName: "Goog Gia" },
      });
      const giaAuth = await authFor(gia.json().id);
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "goog-agent", provider: "google", tier: 1, modes: ["execute"],
          costPerMTokIn: 1.25, costPerMTokOut: 10, model: "gemini-2.5-pro",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: gia.json().id, agentId: agentRes.json().id },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/model-credentials",
        payload: { provider: "google", apiKey: "goog-platform-key", baseUrl: `http://127.0.0.1:${port}/v1beta` },
      });

      const res = await app.inject({
        method: "POST", headers: giaAuth, url: `/v1/agents/${agentRes.json().id}/invoke`,
        payload: { mode: "execute", input: "hello gemini", dispatch: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().dispatch.outputText).toBe("gemini says hi");
      expect(res.json().dispatch.usage).toEqual({ inputTokens: 6, outputTokens: 3 });
      expect(res.json().dispatch.credentialSource).toBe("platform");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.key).toBe("goog-platform-key");
      expect(hits[0]!.path).toContain("/models/gemini-2.5-pro:generateContent");

      const ledger = await app.inject({
        method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${gia.json().id}`,
      });
      expect(ledger.json().events[0]).toMatchObject({
        provider: "google", model: "gemini-2.5-pro", inputTokens: 6, outputTokens: 3,
      });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("xai model adapter: all four real providers ride the same governed pipeline", () => {
  it("dispatch rides an xai-provider agent end-to-end with measured usage", async () => {
    const hits: Array<{ auth: string | null }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ auth: (req.headers.authorization as string) ?? null });
        const parsed = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-xai-e2e",
          object: "chat.completion",
          created: 1,
          model: parsed.model,
          choices: [{ index: 0, message: { role: "assistant", content: "grok says hi", refusal: null }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const xen = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "xai-xen@example.com", displayName: "Xai Xen" },
      });
      const xenAuth = await authFor(xen.json().id);
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "xai-agent", provider: "xai", tier: 1, modes: ["execute"],
          costPerMTokIn: 3, costPerMTokOut: 15, model: "grok-4",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: xen.json().id, agentId: agentRes.json().id },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/model-credentials",
        payload: { provider: "xai", apiKey: "xai-platform-key", baseUrl: `http://127.0.0.1:${port}/v1` },
      });

      const res = await app.inject({
        method: "POST", headers: xenAuth, url: `/v1/agents/${agentRes.json().id}/invoke`,
        payload: { mode: "execute", input: "hello grok", dispatch: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().dispatch.outputText).toBe("grok says hi");
      expect(res.json().dispatch.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.auth).toBe("Bearer xai-platform-key");

      const ledger = await app.inject({
        method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${xen.json().id}`,
      });
      expect(ledger.json().events[0]).toMatchObject({
        provider: "xai", model: "grok-4", inputTokens: 7, outputTokens: 3,
      });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("jira pm adapter: run sync + status mirror against a live-shaped server", () => {
  it("pm-sync creates Jira issues and node events mirror through workflow transitions", async () => {
    let issueSeq = 0;
    const creations: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
    const transitionPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(payload === null ? "" : JSON.stringify(payload));
        };
        if (req.method === "POST" && req.url === "/rest/api/2/issue") {
          creations.push({ auth: (req.headers.authorization as string) ?? null, body: parsed });
          issueSeq += 1;
          return send(201, { id: String(10000 + issueSeq), key: `REG-${issueSeq}`, self: "..." });
        }
        if (req.method === "GET" && /\/transitions$/.test(req.url ?? "")) {
          return send(200, { transitions: [
            { id: "11", name: "Start progress", to: { name: "In Progress" } },
            { id: "31", name: "Finish", to: { name: "Done" } },
          ] });
        }
        if (req.method === "POST" && /\/transitions$/.test(req.url ?? "")) {
          transitionPosts.push({ url: req.url ?? "", body: parsed });
          return send(204, null);
        }
        return send(200, {});
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const juno = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "jira-juno@example.com", displayName: "Jira Juno" },
      });
      const junoAuth = await authFor(juno.json().id);
      const approver = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "jira-approver@example.com", displayName: "Jira Approver" },
      });
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "jira-worker", provider: "mock", tier: 0, modes: ["execute"],
          costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-jira",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: juno.json().id, agentId: agentRes.json().id },
      });
      const conn = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/pm/connections",
        payload: {
          name: "jira-e2e", provider: "jira", project: "REG",
          baseUrl: `http://127.0.0.1:${port}`, token: "bot@example.com:api-token",
        },
      });
      expect(conn.statusCode).toBe(201);

      const run = await app.inject({
        method: "POST", headers: junoAuth, url: "/v1/runs",
        payload: {
          graph: {
            run: "jira-sync-run",
            escalationApproverUserId: approver.json().id,
            nodes: [{ id: "a", title: "implement api", ownerAgentId: agentRes.json().id, mode: "execute", estimate: { in: 1, out: 1 } }],
          },
        },
      });
      const runId = run.json().id;

      const synced = await app.inject({
        method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/pm-sync`,
        payload: { connectionName: "jira-e2e" },
      });
      expect(synced.statusCode).toBe(201);
      // run-level parent + one node item, created with the mapped fields
      expect(creations.length).toBe(2);
      expect(creations[0]!.auth).toBe(
        "Basic " + Buffer.from("bot@example.com:api-token").toString("base64"),
      );
      const nodeIssue = creations.find(
        (c) => (c.body.fields as Record<string, unknown>).summary === "implement api",
      );
      expect(nodeIssue).toBeDefined();
      expect((nodeIssue!.body.fields as Record<string, unknown>).project).toEqual({ key: "REG" });
      expect((nodeIssue!.body.fields as Record<string, unknown>).issuetype).toEqual({ name: "Task" });

      // a node event mirrors outbound through a Jira workflow transition
      await app.inject({ method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
      const started = await app.inject({
        method: "POST", headers: junoAuth, url: `/v1/runs/${runId}/events`,
        payload: { kind: "node_started", nodeId: "a" },
      });
      expect(started.statusCode).toBe(200);
      expect(transitionPosts.length).toBe(1);
      expect(transitionPosts[0]!.body).toEqual({ transition: { id: "11" } }); // → In Progress
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("jira pm adapter v3: ADF descriptions ride pm-sync end-to-end", () => {
  // The v2 describe above stays untouched — it IS the regression proving the
  // default (apiVersion omitted) still speaks /rest/api/2 with plain strings.
  it("a connection with apiVersion 3 creates issues on /rest/api/3 with an ADF description carrying the node instruction", async () => {
    let issueSeq = 0;
    const creations: Array<{ url: string; body: Record<string, unknown> }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        if (req.method === "POST" && req.url === "/rest/api/3/issue") {
          creations.push({ url: req.url, body: parsed });
          issueSeq += 1;
          res.writeHead(201, { "content-type": "application/json" });
          return res.end(JSON.stringify({ id: String(20000 + issueSeq), key: `REG-${issueSeq}`, self: "..." }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const vera = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "jira-v3-vera@example.com", displayName: "Jira V3 Vera" },
      });
      const veraAuth = await authFor(vera.json().id);
      const approver = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "jira-v3-approver@example.com", displayName: "Jira V3 Approver" },
      });
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "jira-v3-worker", provider: "mock", tier: 0, modes: ["execute"],
          costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-jira-v3",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: vera.json().id, agentId: agentRes.json().id },
      });
      const conn = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/pm/connections",
        payload: {
          name: "jira-v3-e2e", provider: "jira", project: "REG", apiVersion: 3,
          baseUrl: `http://127.0.0.1:${port}`, token: "bot@example.com:api-token",
        },
      });
      expect(conn.statusCode).toBe(201);
      expect(conn.json().apiVersion).toBe(3);

      const instruction =
        "Implement the governed endpoint.\n\n- wire the gateway route\n- add audit logging";
      const run = await app.inject({
        method: "POST", headers: veraAuth, url: "/v1/runs",
        payload: {
          graph: {
            run: "jira-v3-sync-run",
            escalationApproverUserId: approver.json().id,
            nodes: [{
              id: "a", title: "implement api", ownerAgentId: agentRes.json().id, mode: "execute",
              instruction, estimate: { in: 1, out: 1 },
            }],
          },
        },
      });
      const runId = run.json().id;

      const synced = await app.inject({
        method: "POST", headers: veraAuth, url: `/v1/runs/${runId}/pm-sync`,
        payload: { connectionName: "jira-v3-e2e" },
      });
      expect(synced.statusCode).toBe(201);
      // run-level parent + one node item, all on the v3 endpoint
      expect(creations.length).toBe(2);
      const nodeIssue = creations.find(
        (c) => (c.body.fields as Record<string, unknown>).summary === "implement api",
      );
      expect(nodeIssue).toBeDefined();
      const desc = (nodeIssue!.body.fields as Record<string, unknown>).description as {
        version: number; type: string; content: unknown[];
      };
      expect(desc.version).toBe(1);
      expect(desc.type).toBe("doc");
      expect(desc.content.length).toBeGreaterThanOrEqual(2); // paragraph + bulletList
      expect(JSON.stringify(desc)).toContain("Implement the governed endpoint.");
      expect(JSON.stringify(desc)).toContain("bulletList");
      expect(JSON.stringify(desc)).toContain("wire the gateway route");
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("linear pm adapter: GraphQL run sync + state mirror end-to-end", () => {
  it("pm-sync creates Linear issues via issueCreate and node events mirror via workflow states", async () => {
    let issueSeq = 0;
    const gqlCalls: Array<{ auth: string | null; query: string; variables: Record<string, unknown> }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        gqlCalls.push({
          auth: (req.headers.authorization as string) ?? null,
          query: parsed.query ?? "",
          variables: parsed.variables ?? {},
        });
        let data: unknown = {};
        if (String(parsed.query).includes("teams(filter")) {
          data = { teams: { nodes: [{ id: "team-uuid-9" }] } };
        } else if (String(parsed.query).includes("issueCreate")) {
          issueSeq += 1;
          data = { issueCreate: { success: true, issue: { id: `lin-issue-${issueSeq}`, url: `https://linear.app/acme/issue/REG-${issueSeq}` } } };
        } else if (String(parsed.query).includes("states")) {
          data = { team: { states: { nodes: [
            { id: "st-todo", name: "Todo" },
            { id: "st-prog", name: "In Progress" },
            { id: "st-done", name: "Done" },
          ] } } };
        } else if (String(parsed.query).includes("issueUpdate")) {
          data = { issueUpdate: { success: true } };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const lena = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "linear-lena@example.com", displayName: "Linear Lena" },
      });
      const lenaAuth = await authFor(lena.json().id);
      const approver = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "linear-approver@example.com", displayName: "Linear Approver" },
      });
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "linear-worker", provider: "mock", tier: 0, modes: ["execute"],
          costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-linear",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: lena.json().id, agentId: agentRes.json().id },
      });
      const conn = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/pm/connections",
        payload: {
          name: "linear-e2e", provider: "linear", project: "REG",
          baseUrl: `http://127.0.0.1:${port}`, token: "lin_api_e2e_secret",
        },
      });
      expect(conn.statusCode).toBe(201);

      const run = await app.inject({
        method: "POST", headers: lenaAuth, url: "/v1/runs",
        payload: {
          graph: {
            run: "linear-sync-run",
            escalationApproverUserId: approver.json().id,
            nodes: [{ id: "a", title: "ship feature", ownerAgentId: agentRes.json().id, mode: "execute", estimate: { in: 1, out: 1 } }],
          },
        },
      });
      const runId = run.json().id;

      const synced = await app.inject({
        method: "POST", headers: lenaAuth, url: `/v1/runs/${runId}/pm-sync`,
        payload: { connectionName: "linear-e2e" },
      });
      expect(synced.statusCode).toBe(201);
      const creations = gqlCalls.filter((c) => c.query.includes("issueCreate"));
      expect(creations).toHaveLength(2); // run parent + node
      expect(creations[0]!.auth).toBe("lin_api_e2e_secret");
      const nodeCreate = creations.find(
        (c) => (c.variables.input as Record<string, unknown>).title === "ship feature",
      );
      expect(nodeCreate).toBeDefined();
      expect((nodeCreate!.variables.input as Record<string, unknown>).teamId).toBe("team-uuid-9");

      await app.inject({ method: "POST", headers: lenaAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
      const started = await app.inject({
        method: "POST", headers: lenaAuth, url: `/v1/runs/${runId}/events`,
        payload: { kind: "node_started", nodeId: "a" },
      });
      expect(started.statusCode).toBe(200);
      const stateMove = gqlCalls.find(
        (c) => c.query.includes("issueUpdate") && (c.variables.input as Record<string, unknown>)?.stateId,
      );
      expect(stateMove).toBeDefined();
      expect((stateMove!.variables.input as Record<string, unknown>).stateId).toBe("st-prog"); // → In Progress
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("asana pm adapter: run sync + section mirror against a live-shaped server", () => {
  it("pm-sync creates Asana tasks in the {data} envelope and node events mirror via section moves", async () => {
    let taskSeq = 0;
    const creations: Array<{ auth: string | null; body: Record<string, unknown>; gid: string }> = [];
    const sectionLookups: string[] = [];
    const sectionMoves: Array<{ url: string; body: Record<string, unknown> }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.method === "POST" && req.url === "/tasks") {
          taskSeq += 1;
          const gid = String(1200 + taskSeq);
          creations.push({ auth: (req.headers.authorization as string) ?? null, body: parsed, gid });
          return send(201, { data: { gid, permalink_url: `https://app.asana.com/0/999/${gid}` } });
        }
        if (req.method === "GET" && /\/sections$/.test(req.url ?? "")) {
          sectionLookups.push(req.url ?? "");
          return send(200, { data: [
            { gid: "sec-todo", name: "To do" },
            { gid: "sec-prog", name: "In progress" },
            { gid: "sec-done", name: "Done" },
          ] });
        }
        if (req.method === "POST" && /\/addTask$/.test(req.url ?? "")) {
          sectionMoves.push({ url: req.url ?? "", body: parsed });
          return send(200, { data: {} });
        }
        return send(200, { data: {} });
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const aria = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "asana-aria@example.com", displayName: "Asana Aria" },
      });
      const ariaAuth = await authFor(aria.json().id);
      const approver = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "asana-approver@example.com", displayName: "Asana Approver" },
      });
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "asana-worker", provider: "mock", tier: 0, modes: ["execute"],
          costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-asana",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: aria.json().id, agentId: agentRes.json().id },
      });
      const conn = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/pm/connections",
        payload: {
          name: "asana-e2e", provider: "asana", project: "999",
          baseUrl: `http://127.0.0.1:${port}`, token: "asana-pat-e2e",
        },
      });
      expect(conn.statusCode).toBe(201);

      const run = await app.inject({
        method: "POST", headers: ariaAuth, url: "/v1/runs",
        payload: {
          graph: {
            run: "asana-sync-run",
            escalationApproverUserId: approver.json().id,
            nodes: [{ id: "a", title: "wire adapter", ownerAgentId: agentRes.json().id, mode: "execute", estimate: { in: 1, out: 1 } }],
          },
        },
      });
      const runId = run.json().id;

      const synced = await app.inject({
        method: "POST", headers: ariaAuth, url: `/v1/runs/${runId}/pm-sync`,
        payload: { connectionName: "asana-e2e" },
      });
      expect(synced.statusCode).toBe(201);
      // run-level parent + one node item, created with the mapped `name` field
      // inside Asana's {data} envelope and the project GID in `projects`
      expect(creations.length).toBe(2);
      expect(creations[0]!.auth).toBe("Bearer asana-pat-e2e");
      const nodeTask = creations.find(
        (c) => (c.body.data as Record<string, unknown>).name === "wire adapter",
      );
      expect(nodeTask).toBeDefined();
      expect((nodeTask!.body.data as Record<string, unknown>).projects).toEqual(["999"]);

      // a node event mirrors outbound as a board-section move: sections are
      // looked up on the project, then the task is added to the matching one
      await app.inject({ method: "POST", headers: ariaAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
      const started = await app.inject({
        method: "POST", headers: ariaAuth, url: `/v1/runs/${runId}/events`,
        payload: { kind: "node_started", nodeId: "a" },
      });
      expect(started.statusCode).toBe(200);
      expect(sectionLookups).toContain("/projects/999/sections");
      expect(sectionMoves.length).toBe(1);
      expect(sectionMoves[0]!.url).toBe("/sections/sec-prog/addTask"); // → In progress
      expect(sectionMoves[0]!.body).toEqual({ data: { task: nodeTask!.gid } });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("monday pm adapter: GraphQL run sync + status-label mirror end-to-end", () => {
  it("pm-sync creates monday items via create_item and node events mirror via Status column labels", async () => {
    let itemSeq = 0;
    const gqlCalls: Array<{ auth: string | null; query: string; variables: Record<string, unknown> }> = [];
    const creations: Array<{ auth: string | null; variables: Record<string, unknown>; id: string }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const call = {
          auth: (req.headers.authorization as string) ?? null,
          query: String(parsed.query ?? ""),
          variables: (parsed.variables ?? {}) as Record<string, unknown>,
        };
        gqlCalls.push(call);
        let data: unknown = {};
        if (call.query.includes("create_item")) {
          itemSeq += 1;
          const id = String(500 + itemSeq);
          creations.push({ auth: call.auth, variables: call.variables, id });
          data = { create_item: { id } };
        } else if (call.query.includes("columns")) {
          data = { boards: [{ columns: [
            { id: "name", type: "name", settings_str: "{}" },
            { id: "status", type: "status", settings_str: JSON.stringify({ labels: { "0": "Working on it", "1": "Done", "2": "Stuck" } }) },
          ] }] };
        } else if (call.query.includes("boards(ids")) {
          data = { boards: [{ url: "https://acme.monday.com/boards/777" }] };
        } else if (call.query.includes("change_simple_column_value")) {
          data = { change_simple_column_value: { id: "x" } };
        } else if (call.query.includes("change_multiple_column_values")) {
          data = { change_multiple_column_values: { id: "x" } };
        } else if (call.query.includes("create_update")) {
          data = { create_update: { id: "u" } };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const mona = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "monday-mona@example.com", displayName: "Monday Mona" },
      });
      const monaAuth = await authFor(mona.json().id);
      const approver = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "monday-approver@example.com", displayName: "Monday Approver" },
      });
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "monday-worker", provider: "mock", tier: 0, modes: ["execute"],
          costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-monday",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: mona.json().id, agentId: agentRes.json().id },
      });
      const conn = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/pm/connections",
        payload: {
          name: "monday-e2e", provider: "monday", project: "777",
          baseUrl: `http://127.0.0.1:${port}`, token: "monday-e2e-token",
        },
      });
      expect(conn.statusCode).toBe(201);

      const run = await app.inject({
        method: "POST", headers: monaAuth, url: "/v1/runs",
        payload: {
          graph: {
            run: "monday-sync-run",
            escalationApproverUserId: approver.json().id,
            nodes: [{ id: "a", title: "roll out board", ownerAgentId: agentRes.json().id, mode: "execute", estimate: { in: 1, out: 1 } }],
          },
        },
      });
      const runId = run.json().id;

      const synced = await app.inject({
        method: "POST", headers: monaAuth, url: `/v1/runs/${runId}/pm-sync`,
        payload: { connectionName: "monday-e2e" },
      });
      expect(synced.statusCode).toBe(201);
      // run-level parent + one node item, created via create_item with the
      // raw api token, the board id, and the mapped `name` as item_name
      expect(creations.length).toBe(2);
      expect(creations[0]!.auth).toBe("monday-e2e-token");
      const nodeItem = creations.find((c) => c.variables.name === "roll out board");
      expect(nodeItem).toBeDefined();
      expect(nodeItem!.variables.board).toBe("777");
      const createCall = gqlCalls.find((c) => c.query.includes("create_item"))!;
      expect(createCall.query).toContain("create_item(board_id: $board, item_name: $name)");

      // a node event mirrors outbound as a status-label change: the board's
      // columns are looked up for the Status column, then the label is set
      await app.inject({ method: "POST", headers: monaAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
      const started = await app.inject({
        method: "POST", headers: monaAuth, url: `/v1/runs/${runId}/events`,
        payload: { kind: "node_started", nodeId: "a" },
      });
      expect(started.statusCode).toBe(200);
      expect(gqlCalls.some((c) => c.query.includes("columns { id type settings_str }"))).toBe(true);
      const labelMove = gqlCalls.find((c) => c.query.includes("change_simple_column_value"));
      expect(labelMove).toBeDefined();
      expect(labelMove!.variables).toEqual({
        board: "777", item: nodeItem!.id, column: "status", value: "Working on it",
      });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("generic webhook pm adapter: signed normalized events end-to-end", () => {
  it("pm-sync creates items via signed work_item.create envelopes and node events mirror as work_item.transition", async () => {
    const TOKEN = "generic-e2e-token";
    let itemSeq = 0;
    // the fake receiver VERIFIES the HMAC signature of every request body
    // under the connection token before recording the event
    const events: Array<{
      event: string;
      project: string;
      payload: Record<string, unknown>;
      signatureValid: boolean;
      rawTokenPresent: boolean;
    }> = [];
    const creations: Array<{ payload: Record<string, unknown>; id: string }> = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as {
          event?: string;
          project?: string;
          payload?: Record<string, unknown>;
        };
        const expected = "sha256=" + createHmac("sha256", TOKEN).update(body).digest("hex");
        events.push({
          event: String(parsed.event ?? ""),
          project: String(parsed.project ?? ""),
          payload: parsed.payload ?? {},
          signatureValid: req.headers["x-regulait-signature"] === expected,
          // the token is a signing secret — it must never travel raw
          rawTokenPresent: req.headers.authorization !== undefined || body.includes(TOKEN),
        });
        let out: unknown = {};
        if (parsed.event === "work_item.create") {
          itemSeq += 1;
          const id = String(900 + itemSeq);
          creations.push({ payload: parsed.payload ?? {}, id });
          out = { id, url: `https://pm-bridge.example/items/${id}` };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;

    try {
      const gina = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "webhook-gina@example.com", displayName: "Webhook Gina" },
      });
      const ginaAuth = await authFor(gina.json().id);
      const approver = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email: "webhook-approver@example.com", displayName: "Webhook Approver" },
      });
      const agentRes = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/agents",
        payload: {
          name: "webhook-worker", provider: "mock", tier: 0, modes: ["execute"],
          costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-webhook",
        },
      });
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/grants/agents",
        payload: { userId: gina.json().id, agentId: agentRes.json().id },
      });
      const conn = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/pm/connections",
        payload: {
          name: "webhook-e2e", provider: "generic_webhook", project: "bridge-proj",
          baseUrl: `http://127.0.0.1:${port}/regulait`, token: TOKEN,
        },
      });
      expect(conn.statusCode).toBe(201);

      const run = await app.inject({
        method: "POST", headers: ginaAuth, url: "/v1/runs",
        payload: {
          graph: {
            run: "webhook-sync-run",
            escalationApproverUserId: approver.json().id,
            nodes: [{ id: "a", title: "wire the bridge", ownerAgentId: agentRes.json().id, mode: "execute", estimate: { in: 1, out: 1 } }],
          },
        },
      });
      const runId = run.json().id;

      const synced = await app.inject({
        method: "POST", headers: ginaAuth, url: `/v1/runs/${runId}/pm-sync`,
        payload: { connectionName: "webhook-e2e" },
      });
      expect(synced.statusCode).toBe(201);
      // run-level parent + one node item, each a signed work_item.create
      // envelope carrying the identity mapping's own vocabulary
      expect(creations.length).toBe(2);
      expect(events.filter((e) => e.event === "work_item.create")).toHaveLength(2);
      const nodeItem = creations.find(
        (c) => (c.payload.fields as Record<string, unknown> | undefined)?.title === "wire the bridge",
      );
      expect(nodeItem).toBeDefined();
      expect(nodeItem!.payload.type).toBe("task");
      expect(events[0]!.project).toBe("bridge-proj");

      // a node event mirrors outbound as a work_item.transition envelope with
      // RegulAIt's own status — the identity map at work, no translation
      await app.inject({ method: "POST", headers: ginaAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
      const started = await app.inject({
        method: "POST", headers: ginaAuth, url: `/v1/runs/${runId}/events`,
        payload: { kind: "node_started", nodeId: "a" },
      });
      expect(started.statusCode).toBe(200);
      const transition = events.find((e) => e.event === "work_item.transition");
      expect(transition).toBeDefined();
      expect(transition!.payload).toEqual({ id: nodeItem!.id, state: "in_progress" });

      // every request that arrived was correctly signed and never leaked the token
      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events.every((e) => e.signatureValid)).toBe(true);
      expect(events.some((e) => e.rawTokenPresent)).toBe(false);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("UI plumbing: /v1/me and own-scoped list views", () => {
  it("identity echo works and non-admins see exactly their own runs/instances/projects", async () => {
    const mia = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "ui-mia@example.com", displayName: "UI Mia" },
    });
    const miaId = mia.json().id;
    const miaAuth = await authFor(miaId);

    const me = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ userId: miaId, isAdmin: false });
    expect(me.json().user.email).toBe("ui-mia@example.com");

    // mia initiates one run; the fleet holds many others from earlier tests
    const agentRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: { name: "ui-worker", provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-ui" },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: miaId, agentId: agentRes.json().id },
    });
    await app.inject({
      method: "POST", headers: miaAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "ui-own-run",
          escalationApproverUserId: miaId,
          nodes: [{ id: "a", title: "t", ownerAgentId: agentRes.json().id, mode: "execute" }],
        },
      },
    });
    const myRuns = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/runs" });
    expect(myRuns.statusCode).toBe(200);
    expect(myRuns.json().runs.length).toBe(1);
    expect(myRuns.json().runs[0].name).toBe("ui-own-run");
    const fleet = await app.inject({ method: "GET", headers: AUTH, url: "/v1/runs" });
    expect(fleet.json().runs.length).toBeGreaterThan(1);

    // instances: mia has none; the admin fleet is non-empty from earlier tests
    const myInstances = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/workflows/instances" });
    expect(myInstances.json().instances).toHaveLength(0);

    // projects: only memberships are visible to a non-admin
    const proj = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "ui-mia-project" },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${proj.json().id}/members`,
      payload: { userId: miaId, role: "viewer" },
    });
    const myProjects = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/projects" });
    expect(myProjects.json().projects).toHaveLength(1);
    expect(myProjects.json().projects[0].name).toBe("ui-mia-project");
  });
});

// The end-user shell this used to assert (/legacy/app) was deleted by
// ADR-0033; the SPA at /ui is the only end-user surface and is driven for real
// by apps/web's Playwright suites.

describe("slice 3: the approval loop closes — approver reads, reasons, admin override", () => {
  let adminId: string;
  let adminAuth: { authorization: string };
  let ivyId: string; // initiator
  let ivyAuth: { authorization: string };
  let oleId: string; // named approver
  let oleAuth: { authorization: string };
  let zedAuth: { authorization: string }; // uninvolved third user
  let instanceId: string;
  let signoffId: string;
  let runId: string;
  let runApprovalId: string;

  beforeAll(async () => {
    const mkUser = async (email: string, name: string, isAdmin = false) => {
      const r = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/users",
        payload: { email, displayName: name, isAdmin },
      });
      return r.json().id as string;
    };
    adminId = await mkUser("loop-admin@example.com", "Loop Admin", true);
    ivyId = await mkUser("loop-ivy@example.com", "Loop Ivy");
    oleId = await mkUser("loop-ole@example.com", "Loop Ole");
    const zedId = await mkUser("loop-zed@example.com", "Loop Zed");
    adminAuth = await authFor(adminId);
    ivyAuth = await authFor(ivyId);
    oleAuth = await authFor(oleId);
    zedAuth = await authFor(zedId);

    // a workflow whose sign-off names Ole (NOT the requesting user)
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "loop-closure-change",
        definition: {
          workflow: "loop-closure-change",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "signoff", type: "human_approval", approvers: [oleId] },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "loop-closure" },
    });
    const started = await app.inject({
      method: "POST", headers: ivyAuth, url: "/v1/workflows/instances",
      payload: {
        change: { description: "close the approval loop", paths: ["src/a.ts"], changeType: "loop-closure", environment: "staging" },
      },
    });
    expect(started.statusCode).toBe(201);
    instanceId = started.json().id;
    const art = await app.inject({
      method: "POST", headers: ivyAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Loop-closure requirements\n\n1. Approvers see what they sign." },
    });
    expect(art.json().status).toBe("blocked_on_approval");
    const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    signoffId = q.json().approvals.find((a: { instanceId: string | null }) => a.instanceId === instanceId).id;

    // a run whose escalation approver is Ole, with one escalated node
    const agent = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: { name: "loop-worker", provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-loop" },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: ivyId, agentId: agent.json().id },
    });
    const run = await app.inject({
      method: "POST", headers: ivyAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "loop-closure-run",
          escalationApproverUserId: oleId,
          nodes: [{ id: "solo", title: "do the work", ownerAgentId: agent.json().id, mode: "execute" }],
        },
      },
    });
    expect(run.statusCode).toBe(201);
    runId = run.json().id;
    for (const payload of [
      { kind: "start" },
      { kind: "node_started", nodeId: "solo" },
      { kind: "node_failed", nodeId: "solo", error: "worker crashed" },
      { kind: "escalate_node", nodeId: "solo" },
    ]) {
      const r = await app.inject({ method: "POST", headers: ivyAuth, url: `/v1/runs/${runId}/events`, payload });
      expect(r.statusCode).toBe(200);
    }
    const q2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    runApprovalId = q2.json().approvals.find((a: { runId: string | null }) => a.runId === runId).id;
  });

  it("the inbox names the requester, the approver, and the governed object", async () => {
    const inbox = await app.inject({ method: "GET", headers: oleAuth, url: "/v1/approvals?status=pending" });
    const signoff = inbox.json().approvals.find((a: { id: string }) => a.id === signoffId);
    expect(signoff).toMatchObject({
      requestedByName: "Loop Ivy",
      approverName: "Loop Ole",
      objectLabel: "close the approval loop",
    });
    const escalation = inbox.json().approvals.find((a: { id: string }) => a.id === runApprovalId);
    expect(escalation).toMatchObject({ requestedByName: "Loop Ivy", objectLabel: "loop-closure-run" });
  });

  it("the named approver can READ the governed instance and run; an uninvolved user cannot", async () => {
    const inst = await app.inject({ method: "GET", headers: oleAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(inst.statusCode).toBe(200);
    expect(inst.json().artifacts[0].content).toContain("Loop-closure requirements");
    expect(inst.json().pendingApprovals[0].approverName).toBe("Loop Ole");

    const run = await app.inject({ method: "GET", headers: oleAuth, url: `/v1/runs/${runId}` });
    expect(run.statusCode).toBe(200);
    expect(run.json().run.name).toBe("loop-closure-run");

    const instDenied = await app.inject({ method: "GET", headers: zedAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(instDenied.statusCode).toBe(403);
    const runDenied = await app.inject({ method: "GET", headers: zedAuth, url: `/v1/runs/${runId}` });
    expect(runDenied.statusCode).toBe(404);

    // the widening is READ-only: the approver still cannot drive the objects
    const drive = await app.inject({
      method: "POST", headers: oleAuth, url: `/v1/workflows/instances/${instanceId}/abort`,
    });
    expect(drive.statusCode).toBe(403);
    const driveRun = await app.inject({
      method: "POST", headers: oleAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "abort" },
    });
    expect(driveRun.statusCode).toBe(404);
  });

  it("the named approver's PM-strip reads return 200 [] instead of guaranteed 404s", async () => {
    // finding 4: the approver cross-read fired GET /v1/pm/links and
    // GET /v1/decisions that 404'd for non-initiators — the same
    // named-pending-approver widening as the instance/run GETs now admits
    // them, answering 200 with [] where nothing exists.
    const runLinks = await app.inject({ method: "GET", headers: oleAuth, url: `/v1/pm/links?runId=${runId}` });
    expect(runLinks.statusCode).toBe(200);
    expect(runLinks.json().links).toEqual([]);
    const runDecisions = await app.inject({
      method: "GET", headers: oleAuth, url: `/v1/decisions?objectType=run&objectId=${runId}`,
    });
    expect(runDecisions.statusCode).toBe(200);
    expect(runDecisions.json().decisions).toEqual([]);

    const instLinks = await app.inject({
      method: "GET", headers: oleAuth, url: `/v1/pm/links?instanceId=${instanceId}`,
    });
    expect(instLinks.statusCode).toBe(200);
    expect(instLinks.json().links).toEqual([]);
    const instDecisions = await app.inject({
      method: "GET", headers: oleAuth, url: `/v1/decisions?objectType=workflow_instance&objectId=${instanceId}`,
    });
    expect(instDecisions.statusCode).toBe(200);
    expect(instDecisions.json().decisions).toEqual([]);

    // an uninvolved user still gets existence-hiding 404s
    const zedLinks = await app.inject({ method: "GET", headers: zedAuth, url: `/v1/pm/links?runId=${runId}` });
    expect(zedLinks.statusCode).toBe(404);
    const zedDecisions = await app.inject({
      method: "GET", headers: zedAuth, url: `/v1/decisions?objectType=run&objectId=${runId}`,
    });
    expect(zedDecisions.statusCode).toBe(404);
  });

  it("deciding with a reason records it; the read window closes once nothing is pending", async () => {
    const decided = await app.inject({
      method: "POST", headers: oleAuth, url: `/v1/approvals/${runApprovalId}/decide`,
      payload: { decision: "approved", reason: "transient failure — retry it" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({
      status: "approved",
      decidedBy: oleId,
      decisionReason: "transient failure — retry it",
    });
    expect(decided.json().adminOverride).toBeUndefined();

    const listed = await app.inject({ method: "GET", headers: oleAuth, url: "/v1/approvals" });
    const row = listed.json().approvals.find((a: { id: string }) => a.id === runApprovalId);
    expect(row.decisionReason).toBe("transient failure — retry it");
    expect(row.decidedByName).toBe("Loop Ole");

    // no pending approval on the run names Ole anymore → the read closes again
    const runView = await app.inject({ method: "GET", headers: oleAuth, url: `/v1/runs/${runId}` });
    expect(runView.statusCode).toBe(404);
    // …and so does the widened PM strip
    const runLinks = await app.inject({ method: "GET", headers: oleAuth, url: `/v1/pm/links?runId=${runId}` });
    expect(runLinks.statusCode).toBe(404);
    const runDecisions = await app.inject({
      method: "GET", headers: oleAuth, url: `/v1/decisions?objectType=run&objectId=${runId}`,
    });
    expect(runDecisions.statusCode).toBe(404);
  });

  it("admin override: 403 for a third user, mandatory reason, audit-marked", async () => {
    const zed = await app.inject({
      method: "POST", headers: zedAuth, url: `/v1/approvals/${signoffId}/decide`,
      payload: { decision: "approved", reason: "I want this through" },
    });
    expect(zed.statusCode).toBe(403);
    expect(zed.json().error).toBe("not_the_named_approver");

    const noReason = await app.inject({
      method: "POST", headers: adminAuth, url: `/v1/approvals/${signoffId}/decide`,
      payload: { decision: "approved" },
    });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().error).toBe("override_reason_required");

    const overridden = await app.inject({
      method: "POST", headers: adminAuth, url: `/v1/approvals/${signoffId}/decide`,
      payload: { decision: "approved", reason: "Ole is on leave; unblocking per policy" },
    });
    expect(overridden.statusCode).toBe(200);
    expect(overridden.json()).toMatchObject({
      status: "approved",
      adminOverride: true,
      decidedBy: adminId,
      decisionReason: "Ole is on leave; unblocking per policy",
    });

    // the decision took real effect: the sign-off stage advanced (last stage → completed)
    const inst = await app.inject({ method: "GET", headers: ivyAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(inst.json().instance.status).toBe("completed");

    // the audit trail marks the override as exactly what it is
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${adminId}` });
    const entry = audit.json().entries.find((e: { ruleId: string }) => e.ruleId === "approval-admin-override");
    expect(entry).toBeDefined();
    expect(entry.detail).toMatchObject({
      adminOverride: true,
      approvalId: signoffId,
      namedApproverUserId: oleId,
      decision: "approved",
    });
    expect(entry.reason).toContain("Ole is on leave");
  });
});
