import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  and,
  auditLog,
  createDb,
  eq,
  INTERCEPTION_SETTINGS_ID,
  interceptionSettings,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";
import { PROJECT_HEADER } from "./mcp-proxy.js";

/**
 * ADR-0023 — the wave-3 SCHEMA-OWNING slice, end to end at the gateway edge.
 *
 * S1 `agents.systemPrompt` (migration 0040): the admin-authored BASE system
 *    prompt is a GOVERNANCE ARTIFACT — when set, it is the dispatch's system
 *    base and a caller-supplied system is APPENDED after it, never replacing
 *    it. Enforced in the ONE dispatch core, so the compat shims inherit it
 *    without reimplementation (proved, not assumed).
 * S2 `mcpDefaultMode` ENFORCEMENT: a project whose compliance cascade
 *    tightens to read_only denies WRITE-classified MCP tools on attributed
 *    calls — before any upstream dispatch, audited (ruleId mcp-default-mode),
 *    naming the governing project + profile. Unattributed calls keep today's
 *    behaviour byte-identical (the disclosed O11 gap, not this slice's).
 * S3 Snowflake connector (closes Batch B): the structured-JSON credential
 *    convention inside the one token ciphertext is validated at
 *    connection-create with actionable 400s, and the governed invoke path
 *    executes real key-pair-JWT SQL API calls whose database/schema come from
 *    the pillar-1 governed object.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed sd-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "sd-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

// one RSA key pair for the snowflake credential (2048-bit keeps the suite fast)
const SNOWFLAKE_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

// --- upstream test MCP server (S2) ----------------------------------------

function buildMcpUpstream(): McpServer {
  const server = new McpServer({ name: "sd-upstream", version: "0.0.1" });
  server.registerTool(
    "sd_read",
    { description: "Reads a note", inputSchema: { key: z.string() }, annotations: { readOnlyHint: true } },
    async ({ key }) => ({ content: [{ type: "text", text: `note: ${key}` }] }),
  );
  // no readOnlyHint → classified WRITE (the conservative default)
  server.registerTool(
    "sd_write",
    { description: "Writes a note", inputSchema: { key: z.string() } },
    async ({ key }) => ({ content: [{ type: "text", text: `wrote: ${key}` }] }),
  );
  return server;
}

async function startMcpUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = buildMcpUpstream();
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

// --- fake Snowflake SQL API upstream (S3) ----------------------------------

interface SnowflakeCall {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function startSnowflakeUpstream(): Promise<{
  url: string;
  calls: SnowflakeCall[];
  close: () => Promise<void>;
}> {
  const calls: SnowflakeCall[] = [];
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", headers: req.headers, body: body ? JSON.parse(body) : {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [["1"]], resultSetMetaData: { numRows: 1 } }));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;
let mcpUpstream: Awaited<ReturnType<typeof startMcpUpstream>>;
let snowUpstream: Awaited<ReturnType<typeof startSnowflakeUpstream>>;
let gatewayUrl: string;

let devId: string;
let devAuth: { authorization: string };
let devToken: string;
let basedAgentId: string; // carries an admin systemPrompt
let bareAgentId: string; // no systemPrompt
let mcpServerId: string;
let snowConnectorId: string;
let roProject: string; // compliance cascade → mcpDefaultMode read_only
let openProject: string; // compliance cascade → read_write

const ADMIN_BASE = "You are the sd governed billing agent.\nNever quote raw account numbers.";

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "sd" },
  });
  return {
    id: u.json().id as string,
    token: k.json().token as string,
    auth: { authorization: `Bearer ${k.json().token}` },
  };
}

async function mcpClient(projectId?: string): Promise<Client> {
  const client = new Client({ name: "sd-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${mcpServerId}`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${devToken}`,
        ...(projectId ? { [PROJECT_HEADER]: projectId } : {}),
      },
    },
  });
  await client.connect(transport);
  return client;
}

/** the mock provider's wire-level record for the dispatch whose input contains
 * the marker — the direct observation of what system string was really sent */
function wireFor(marker: string) {
  return mock.dispatches
    .filter((d) => {
      if (d.input?.includes(marker)) return true;
      return (d.messages ?? []).some((m) =>
        typeof m.content === "string"
          ? m.content.includes(marker)
          : m.content.some((b) => b.type === "text" && b.text.includes(marker)),
      );
    })
    .at(-1);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;
  mcpUpstream = await startMcpUpstream();
  snowUpstream = await startSnowflakeUpstream();

  const dev = await makeUser("sd-dev@example.com");
  devId = dev.id;
  devAuth = dev.auth;
  devToken = dev.token;

  // S1 agents: one with an admin base prompt, one without
  const mkAgent = async (name: string, model: string, systemPrompt?: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name, provider: "mock", tier: 1, model,
        costPerMTokIn: 1, costPerMTokOut: 2,
        ...(systemPrompt ? { systemPrompt } : {}),
      },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  basedAgentId = await mkAgent("sd-based-agent", "sd-based-model", ADMIN_BASE);
  bareAgentId = await mkAgent("sd-bare-agent", "sd-bare-model");
  for (const agentId of [basedAgentId, bareAgentId]) {
    const g = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: devId, agentId },
    });
    expect(g.statusCode).toBe(201);
  }
  // §12's per-user off switch: with two same-tier agents entitled, routing
  // could serve either — passthrough pins served = requested so the wire
  // assertions below are deterministic (the invariant composes on the SERVED
  // agent's base prompt, which is exactly what we want pinned).
  const policy = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${devId}/agent-policy`,
    payload: { routingMode: "passthrough" },
  });
  expect(policy.statusCode).toBe(200);

  // S2: MCP server + tool grants + compliance profiles/projects
  const server = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/servers",
    payload: { name: "sd-upstream", url: mcpUpstream.url },
  });
  mcpServerId = server.json().id;
  for (const toolName of ["sd_read", "sd_write"]) {
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/tools",
      payload: { userId: devId, serverId: mcpServerId, toolName },
    });
  }
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: "sd-ro", mcpDefaultMode: "read_only" },
  });
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: "sd-open", mcpDefaultMode: "read_write" },
  });
  const mkProject = async (name: string, classifications?: string[]) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name, ...(classifications ? { classifications } : {}) },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  roProject = await mkProject("sd-ro-proj", ["sd-ro"]);
  openProject = await mkProject("sd-open-proj", ["sd-open"]);
  for (const p of [roProject, openProject]) {
    const m = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${p}/members`,
      payload: { userId: devId, role: "contributor" },
    });
    expect(m.statusCode).toBe(201);
  }

  // S3: a snowflake connector (credential is added inside the tests — the
  // validation path is itself under test)
  const conn = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/connectors",
    payload: { name: "sd-snowflake", kind: "warehouse", providerKind: "snowflake", pricePerCallUsd: 0.003 },
  });
  expect(conn.statusCode).toBe(201);
  snowConnectorId = conn.json().id;
  const grant = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/connectors",
    payload: {
      userId: devId, connectorId: snowConnectorId, mode: "readwrite",
      allowedObjects: ["ANALYTICS.PUBLIC"],
    },
  });
  expect(grant.statusCode).toBe(201);
});

afterAll(async () => {
  // restore the shipped interception defaults for later suites on this DB
  await db
    .update(interceptionSettings)
    .set({ anthropicCompatEnabled: false })
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  app.server.closeAllConnections();
  await app.close();
  await mcpUpstream.close();
  await snowUpstream.close();
});

// =========================================================================
// S1 — agents.systemPrompt: the admin base wins, callers only append
// =========================================================================

describe("S1 agents.systemPrompt is the dispatch system BASE (governance artifact)", () => {
  it("caller-supplied system is APPENDED after the admin base, never replacing it", async () => {
    const marker = "sd-sys-append-probe";
    const r = await app.inject({
      method: "POST", headers: devAuth, url: `/v1/agents/${basedAgentId}/invoke`,
      payload: { mode: "execute", dispatch: true, input: marker, system: "Caller extra context." },
    });
    expect(r.statusCode).toBe(200);
    const wire = wireFor(marker);
    expect(wire).toBeDefined();
    // THE INVARIANT: base first, caller appended — asserted on the wire
    expect(wire!.system).toBe(`${ADMIN_BASE}\n\nCaller extra context.`);
    expect(wire!.system!.startsWith(ADMIN_BASE)).toBe(true);
  });

  it("with no caller system the base is sent alone; with no base the caller system is unchanged", async () => {
    const m1 = "sd-sys-base-only-probe";
    expect(
      (
        await app.inject({
          method: "POST", headers: devAuth, url: `/v1/agents/${basedAgentId}/invoke`,
          payload: { mode: "execute", dispatch: true, input: m1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(wireFor(m1)!.system).toBe(ADMIN_BASE);

    const m2 = "sd-sys-bare-probe";
    expect(
      (
        await app.inject({
          method: "POST", headers: devAuth, url: `/v1/agents/${bareAgentId}/invoke`,
          payload: { mode: "execute", dispatch: true, input: m2, system: "Caller only." },
        })
      ).statusCode,
    ).toBe(200);
    // pre-ADR-0023 behaviour is byte-identical when no base prompt is set
    expect(wireFor(m2)!.system).toBe("Caller only.");
  });

  it("POST /v1/agents/:agentId/system-prompt sets, replaces and clears (null); unknown agent 404s", async () => {
    const set = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/agents/${bareAgentId}/system-prompt`,
      payload: { systemPrompt: "Temporary sd base." },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().systemPrompt).toBe("Temporary sd base.");

    const m = "sd-sys-set-probe";
    await app.inject({
      method: "POST", headers: devAuth, url: `/v1/agents/${bareAgentId}/invoke`,
      payload: { mode: "execute", dispatch: true, input: m, system: "Caller." },
    });
    expect(wireFor(m)!.system).toBe("Temporary sd base.\n\nCaller.");

    const clear = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/agents/${bareAgentId}/system-prompt`,
      payload: { systemPrompt: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().systemPrompt).toBeNull();

    const gone = await app.inject({
      method: "POST", headers: AUTH,
      url: "/v1/agents/00000000-0000-0000-0000-000000000000/system-prompt",
      payload: { systemPrompt: "x" },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("compat shims INHERIT the invariant via the shared core (Anthropic-shaped /v1/messages)", async () => {
    // the shim resolves by model id and runs executeGovernedDispatch — no
    // reimplementation, so the base-wins composition must simply be there
    const enable = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/interception/settings",
      payload: { anthropicCompatEnabled: true },
    });
    expect(enable.statusCode).toBe(200);

    const marker = "sd-sys-compat-probe";
    const r = await app.inject({
      method: "POST", headers: devAuth, url: "/v1/messages",
      payload: {
        model: "sd-based-model",
        max_tokens: 64,
        system: "IDE caller system.",
        messages: [{ role: "user", content: marker }],
      },
    });
    expect(r.statusCode).toBe(200);
    const wire = wireFor(marker);
    expect(wire).toBeDefined();
    expect(wire!.system).toBe(`${ADMIN_BASE}\n\nIDE caller system.`);

    const disable = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/interception/settings",
      payload: { anthropicCompatEnabled: false },
    });
    expect(disable.statusCode).toBe(200);
  });
});

// =========================================================================
// S2 — mcpDefaultMode: read_only denies attributed MCP writes, audited
// =========================================================================

describe("S2 mcpDefaultMode is ENFORCED on attributed MCP tool calls", () => {
  it("read-classified tools stay allowed on a read_only project (and bill onto the ledger)", async () => {
    const client = await mcpClient(roProject);
    try {
      const res = (await client.callTool({ name: "sd_read", arguments: { key: "alpha" } })) as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(res.content[0]?.text).toBe("note: alpha");
      const rows = await db
        .select()
        .from(usageEvents)
        .where(and(eq(usageEvents.projectId, roProject), eq(usageEvents.operation, "sd_read")));
      expect(rows.length).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("write-classified tools are DENIED before upstream dispatch, naming the project + governing profile, and the denial is audited", async () => {
    const client = await mcpClient(roProject);
    try {
      const err = (await client
        .callTool({ name: "sd_write", arguments: { key: "beta" } })
        .catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("read_only");
      expect(err.message).toContain("sd-ro-proj"); // the governing project, by name
      expect(err.message).toContain("'sd-ro'"); // the governing profile tag
      expect(err.message).toContain("mcpDefaultMode");
    } finally {
      await client.close();
    }
    // audited as a governed deny with its own rule id
    const denials = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mcp-default-mode"), eq(auditLog.toolName, "sd_write")));
    expect(denials.length).toBe(1);
    expect(denials[0]!.effect).toBe("deny");
    expect(denials[0]!.detail).toMatchObject({
      mcpDefaultMode: "read_only",
      projectId: roProject,
      governingTags: ["sd-ro"],
    });
    // denied pre-upstream, so nothing was billed for the write
    const writeRows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.projectId, roProject), eq(usageEvents.operation, "sd_write")));
    expect(writeRows.length).toBe(0);
  });

  it("writes stay allowed under a read_write (open) cascade", async () => {
    const client = await mcpClient(openProject);
    try {
      const res = (await client.callTool({ name: "sd_write", arguments: { key: "gamma" } })) as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(res.content[0]?.text).toBe("wrote: gamma");
      const rows = await db
        .select()
        .from(usageEvents)
        .where(and(eq(usageEvents.projectId, openProject), eq(usageEvents.operation, "sd_write")));
      expect(rows.length).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("unattributed calls keep today's behaviour byte-identical (the disclosed O11 gap, not this slice's)", async () => {
    const before = (await db.select().from(usageEvents)).length;
    const client = await mcpClient(); // no project header
    try {
      const res = (await client.callTool({ name: "sd_write", arguments: { key: "delta" } })) as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(res.content[0]?.text).toBe("wrote: delta");
    } finally {
      await client.close();
    }
    // no attribution → no usage row, and no mode denial either
    expect((await db.select().from(usageEvents)).length).toBe(before);
  });
});

// =========================================================================
// S3 — Snowflake connector through the governed gateway path
// =========================================================================

describe("S3 snowflake credential validation + governed execution", () => {
  const CRED = { account: "sd-acct", user: "svc_sd", privateKey: SNOWFLAKE_PRIVATE_KEY };

  it("a malformed credential 400s at CONNECTION-CREATE time with an actionable message", async () => {
    for (const [token, fragment] of [
      ["just-a-string", "{account, user, privateKey, passphrase?}"],
      [JSON.stringify({ account: "a", user: "u" }), "privateKey"],
    ] as const) {
      const r = await app.inject({
        method: "POST", headers: AUTH, url: `/v1/connectors/${snowConnectorId}/credential`,
        payload: { token },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_connector_credential");
      expect(r.json().detail).toContain(fragment);
    }
  });

  it("a valid JSON credential stores (encrypted; never returned), with the test upstream as baseUrl", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/connectors/${snowConnectorId}/credential`,
      payload: { token: JSON.stringify(CRED), baseUrl: snowUpstream.url },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().tokenCiphertext).toBeUndefined();
    expect(r.json().baseUrl).toBe(snowUpstream.url);
  });

  it("a governed read executes real SQL API v2 traffic: key-pair JWT headers, database/schema from the governed object, billed", async () => {
    const r = await app.inject({
      method: "POST", headers: devAuth, url: `/v1/connectors/${snowConnectorId}/invoke`,
      payload: {
        operation: "read",
        object: "ANALYTICS.PUBLIC",
        payload: { statement: "SELECT count(*) FROM orders" },
        projectId: openProject,
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().decision.effect).toBe("allow");
    expect(r.json().result.body).toMatchObject({ data: [["1"]] });
    expect(r.json().costUsd).toBe(0.003);

    const call = snowUpstream.calls.at(-1)!;
    expect(call.url).toBe("/api/v2/statements");
    expect(call.headers["x-snowflake-authorization-token-type"]).toBe("KEYPAIR_JWT");
    expect(String(call.headers.authorization).startsWith("Bearer ")).toBe(true);
    // the JWT's sub claim follows the UPPER(account).UPPER(user) convention
    const jwt = String(call.headers.authorization).slice("Bearer ".length);
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    expect(claims.sub).toBe("SD-ACCT.SVC_SD");
    expect(call.body).toMatchObject({
      statement: "SELECT count(*) FROM orders",
      database: "ANALYTICS",
      schema: "PUBLIC",
    });
  });

  it("a governed write executes a mutating statement under the same scope", async () => {
    const r = await app.inject({
      method: "POST", headers: devAuth, url: `/v1/connectors/${snowConnectorId}/invoke`,
      payload: {
        operation: "write",
        object: "ANALYTICS.PUBLIC",
        payload: { statement: "INSERT INTO audit_notes (note) VALUES ('sd')", warehouse: "WH_SD" },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(snowUpstream.calls.at(-1)!.body).toMatchObject({
      statement: "INSERT INTO audit_notes (note) VALUES ('sd')",
      database: "ANALYTICS",
      schema: "PUBLIC",
      warehouse: "WH_SD",
    });
  });

  it("the statement guard is visible through the gateway: a mutating statement on operation:'read' fails, nothing reaches upstream", async () => {
    const before = snowUpstream.calls.length;
    const r = await app.inject({
      method: "POST", headers: devAuth, url: `/v1/connectors/${snowConnectorId}/invoke`,
      payload: {
        operation: "read",
        object: "ANALYTICS.PUBLIC",
        payload: { statement: "DELETE FROM orders" },
      },
    });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe("connector_invoke_failed");
    expect(r.json().detail).toContain("SELECT/WITH/SHOW/DESCRIBE");
    expect(snowUpstream.calls.length).toBe(before);
  });

  it("pillar-1 object scope still governs: a database.schema outside allowedObjects is denied before the adapter runs", async () => {
    const before = snowUpstream.calls.length;
    const r = await app.inject({
      method: "POST", headers: devAuth, url: `/v1/connectors/${snowConnectorId}/invoke`,
      payload: {
        operation: "read",
        object: "PAYROLL.SECRETS",
        payload: { statement: "SELECT * FROM salaries" },
      },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().decision.effect).toBe("deny");
    expect(snowUpstream.calls.length).toBe(before);
  });
});
