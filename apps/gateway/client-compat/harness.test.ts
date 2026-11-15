import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { and, auditLog, createDb, eq, mcpServers, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "../src/app.js";
import { relaxStepUpAround } from "../src/testing/step-up-posture.js";
import { relaxGovernanceGatesForTest } from "../src/testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "../src/testing/strict-admission.js";
import { removeEgressAllowEntry } from "../src/testing/egress-allow-cleanup.js";
import { relaxDataPostureForTest } from "../src/testing/strict-data-posture.js";

/**
 * ADR-0257 (backlog P33) — THIRD-PARTY CLIENT COMPATIBILITY, end to end.
 *
 * Off-the-shelf clients, unmodified, each in its own digest-pinned container with
 * its dependencies vendored at image build, are pointed at a real gateway:
 *
 *   node-sdks   the official `openai` and `@anthropic-ai/sdk` packages
 *               -> /v1/chat/completions, /v1/responses (ADR-0287) and /v1/messages
 *   laravel-ai  laravel/ai through its `openai-compatible`, `openai` and `anthropic`
 *               drivers -> /v1/chat/completions, /v1/responses and /v1/messages
 *   dart-mcp    dart_mcp as an MCP client -> /mcp/:serverId
 *
 * Every client checks, from its own side of the wire: auth (a bad key is a clean
 * 401), a governed allow, a governed deny (a clean, client-readable 403 or MCP
 * error), streaming and tool calls. This file then checks the other side: the
 * allowed calls were COST-ATTRIBUTED to the project in the usage ledger, and both
 * the allows and the denies were written to the audit trail.
 *
 * Isolation: the clients run on an `--internal` docker network. Their only
 * reachable host is this gateway, bound to that network's gateway address, so a
 * client that tried to fetch anything at test time would fail the run. There is no
 * real provider: the served agent is the `mock` provider.
 *
 * The gateway runs at its STRICT defaults (ADR-0180/0181), with the named
 * exceptions below. Project attribution is NOT relaxed: every client sends
 * `x-regulait-project-id`, as a real deployment requires.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for the client compatibility harness");

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");

/** The image tags the CI job (and a local run, see README.md) builds. */
export const CLIENT_IMAGES = {
  "node-sdks": "regulait-client-compat/node-sdks:local",
  "laravel-ai": "regulait-client-compat/laravel-ai:local",
  "dart-mcp": "regulait-client-compat/dart-mcp:local",
} as const;

const RUN = randomBytes(4).toString("hex");
const BOOT = `p33-bootstrap-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const MODEL = `p33-mock-${RUN}`;
const TOOL = "p33_lookup";
const MCP_ALLOWED = "get_time";
const MCP_DENIED = "write_note";
const NETWORK = `regulait-p33-${RUN}`;

type Lane = { allowId: string; allowKey: string; denyId: string; denyKey: string };
const LANES = [
  "openai-sdk",
  "openai-responses",
  "anthropic-sdk",
  "laravel-openai",
  "laravel-responses",
  "laravel-anthropic",
  "dart-mcp",
] as const;
type LaneName = (typeof LANES)[number];

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: { url: string; close: () => Promise<void> };
let gatewayUrl: string;
let projectId: string;
let agentId: string;
let serverId: string;
const lanes = {} as Record<LaneName, Lane>;
let restoreGates: () => Promise<void> = async () => {};
let restoreAdmission: (() => Promise<void>) | undefined;
let restorePosture: (() => Promise<void>) | undefined;
let loopbackAllowId: string | undefined;

/** Progress on stderr, so a stalled CI run shows which stage it stalled in. */
const step = (msg: string) => {
  const line = `[client-compat] ${new Date().toISOString()} ${msg}\n`;
  process.stderr.write(line);
  if (process.env.CLIENT_COMPAT_LOG) appendFileSync(process.env.CLIENT_COMPAT_LOG, line);
};

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The upstream MCP server the gateway proxies: one read tool, one write tool. */
async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "p33-upstream", version: "0.0.1" });
        server.registerTool(
          MCP_ALLOWED,
          { description: "Returns a fixed time", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "12:00" }] }),
        );
        server.registerTool(
          MCP_DENIED,
          { description: "Writes a note", inputSchema: { text: z.string() } },
          async ({ text }) => ({ content: [{ type: "text", text: `wrote: ${text}` }] }),
        );
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
  if (typeof address !== "object" || !address) throw new Error("no upstream address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

async function admin(method: "POST" | "PUT", url: string, payload: unknown, status = 201) {
  const r = await app.inject({ method, url, headers: AUTH, payload: payload as Record<string, unknown> });
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(status);
  return r.json();
}

async function userWithKey(tag: string): Promise<{ id: string; key: string }> {
  const u = await admin("POST", "/v1/users", { email: `p33-${tag}-${RUN}@example.com`, displayName: `p33 ${tag}` });
  const k = await admin("POST", `/v1/users/${u.id}/keys`, { name: `p33-${tag}` });
  await admin("POST", `/v1/projects/${projectId}/members`, { userId: u.id, role: "contributor" });
  return { id: u.id as string, key: k.token as string };
}

type ClientReport = { client: string; results: Array<{ name: string; ok: boolean; detail: unknown }> };

/**
 * Run one client image on the internal network and parse its one-line JSON report.
 * ASYNC on purpose: the gateway serves from this same process, so a synchronous
 * spawn would block the event loop the client's requests need.
 */
async function runClient(image: string, env: Record<string, string>): Promise<ClientReport> {
  const args = ["run", "--rm", "--network", NETWORK, "--read-only", "--tmpfs", "/tmp"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(image);
  step(`running ${image}`);
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve({ code: c, stdout: out, stderr: err });
    });
  });
  step(`${image} exited ${code}`);
  const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (code !== 0 || !line) {
    throw new Error(`${image} exited ${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`);
  }
  return JSON.parse(line) as ClientReport;
}

function expectAllPassed(report: ClientReport, expected: string[]) {
  const failed = report.results.filter((r) => !r.ok);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  expect(report.results.map((r) => r.name).sort()).toEqual([...expected].sort());
}

const CHECKS = ["auth", "allow", "deny", "stream", "tools"];

/** The allowed calls are on the ledger, priced and attributed to the project. */
async function expectAttributedSpend(userId: string, objectType: "agent" | "mcp_tool") {
  const rows = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.objectType, objectType)));
  expect(rows.length, `no ${objectType} usage rows for ${userId}`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.projectId).toBe(projectId);
    expect(row.costUsd ?? 0).toBeGreaterThan(0);
  }
  return rows;
}

async function auditRows(userId: string) {
  return db.select().from(auditLog).where(eq(auditLog.userId, userId));
}

/** ADR-0287: a Responses lane's allowed dispatches went through `/v1/responses`, not another shim. */
async function expectResponsesSurface(userId: string) {
  const allowed = (await auditRows(userId)).filter((r) => r.effect === "allow" && r.objectType === "agent");
  expect(allowed.length).toBeGreaterThan(0);
  for (const r of allowed) expect((r.detail as { surface?: string }).surface).toBe("compat_openai_responses");
}

beforeAll(async () => {
  for (const image of Object.values(CLIENT_IMAGES)) {
    // fail early and clearly when the images were not built (README.md says how)
    docker(["image", "inspect", "--format", "{{.Id}}", image]);
  }
  docker(["network", "create", "--internal", NETWORK]);
  const gatewayIp = docker(["network", "inspect", NETWORK, "--format", "{{(index .IPAM.Config 0).Gateway}}"]);

  step(`network ${NETWORK} up, gateway will bind ${gatewayIp}`);
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // The two named relaxations, both about model-risk paperwork for the mock agent
  // and not about the client surfaces under test (every compat suite relaxes them):
  // an unregistered model is refused when MRM is enforced, and a dispatch without
  // an approved use case is refused when dispatch attribution is required.
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  // ADR-0181 strict admission scans a new upstream before it is served; the
  // in-process upstream here is a fixture, not the subject.
  restoreAdmission = await relaxStrictAdmissionForTest(db);
  // The org's strict default PII mode is `block`, and on a block-mode project the
  // gateway refuses `stream: true` outright (ADR-0019/0021: output PII can only be
  // checked on the full text). That refusal is correct, and it is not the stream
  // this harness has to prove clients can read, so the org default is `warn` here.
  restorePosture = await relaxDataPostureForTest(db, {
    org: { defaultPiiMode: "warn" },
    interception: false,
    guardrails: false,
  });

  step("migrated");
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: randomBytes(32).toString("hex") });
  upstream = await startUpstream();
  gatewayUrl = await app.listen({ port: 0, host: gatewayIp });

  step(`gateway listening at ${gatewayUrl}`);
  // the gateway may reach its loopback upstream (default-deny egress, ADR-0034)
  const egress = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "client-compat harness upstream" },
    }),
  );
  expect(egress.statusCode, egress.body).toBe(201);
  loopbackAllowId = egress.json().id;

  step("egress allowed");
  projectId = (await admin("POST", "/v1/projects", { name: `p33-project-${RUN}` })).id;
  agentId = (
    await admin("POST", "/v1/agents", {
      name: MODEL,
      provider: "mock",
      tier: 1,
      model: MODEL,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
    })
  ).id;
  for (const lane of LANES) {
    const allow = await userWithKey(`${lane}-allow`);
    const deny = await userWithKey(`${lane}-deny`);
    lanes[lane] = { allowId: allow.id, allowKey: allow.key, denyId: deny.id, denyKey: deny.key };
    if (lane !== "dart-mcp") await admin("POST", "/v1/grants/agents", { userId: allow.id, agentId });
  }
  await admin("PUT", "/v1/interception/settings", { anthropicCompatEnabled: true, openaiCompatEnabled: true }, 200);

  step("lanes seeded");
  serverId = (await admin("POST", "/v1/servers", { name: `p33-upstream-${RUN}`, url: upstream.url })).id;
  await db.update(mcpServers).set({ pricePerCallUsd: 0.002 }).where(eq(mcpServers.id, serverId));
  await admin("POST", "/v1/grants/tools", { userId: lanes["dart-mcp"].allowId, serverId, toolName: MCP_ALLOWED });
});

afterAll(async () => {
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackAllowId });
  try {
    await app?.inject({
      method: "PUT",
      url: "/v1/interception/settings",
      headers: AUTH,
      payload: { anthropicCompatEnabled: false, openaiCompatEnabled: false },
    });
    app?.server.closeAllConnections();
    await app?.close();
    await upstream?.close();
    await restoreAdmission?.();
    await restorePosture?.();
    await restoreGates();
  } finally {
    spawnSync("docker", ["network", "rm", NETWORK]);
    loopback.assertRemoved();
  }
});

describe("official OpenAI and Anthropic SDKs (node-sdks image)", () => {
  it("auth, allow, deny, streaming and tool calls pass from the client side", async () => {
    const report = await runClient(CLIENT_IMAGES["node-sdks"], {
      GATEWAY_URL: gatewayUrl,
      MODEL,
      PROJECT_ID: projectId,
      TOOL_NAME: TOOL,
      OPENAI_ALLOW_KEY: lanes["openai-sdk"].allowKey,
      OPENAI_DENY_KEY: lanes["openai-sdk"].denyKey,
      RESPONSES_ALLOW_KEY: lanes["openai-responses"].allowKey,
      RESPONSES_DENY_KEY: lanes["openai-responses"].denyKey,
      ANTHROPIC_ALLOW_KEY: lanes["anthropic-sdk"].allowKey,
      ANTHROPIC_DENY_KEY: lanes["anthropic-sdk"].denyKey,
    });
    expectAllPassed(report, CHECKS.flatMap((c) => [`openai.${c}`, `responses.${c}`, `anthropic.${c}`]));
  });

  it("openai-responses: the allowed calls went through /v1/responses", async () => {
    await expectResponsesSurface(lanes["openai-responses"].allowId);
  });

  for (const lane of ["openai-sdk", "openai-responses", "anthropic-sdk"] as const) {
    it(`${lane}: the allowed calls are cost-attributed and both outcomes are audited`, async () => {
      // allow + stream + tools = three priced, attributed dispatches
      expect((await expectAttributedSpend(lanes[lane].allowId, "agent")).length).toBeGreaterThanOrEqual(3);
      const allowed = await auditRows(lanes[lane].allowId);
      expect(allowed.some((r) => r.effect === "allow" && r.objectType === "agent")).toBe(true);
      const denied = await auditRows(lanes[lane].denyId);
      expect(denied.some((r) => r.effect === "deny" && r.objectType === "agent" && r.objectId === agentId)).toBe(true);
    });
  }
});

describe("Laravel AI SDK (laravel-ai image)", () => {
  it("auth, allow, deny, streaming and tool calls pass from the client side", async () => {
    const report = await runClient(CLIENT_IMAGES["laravel-ai"], {
      GATEWAY_URL: gatewayUrl,
      MODEL,
      PROJECT_ID: projectId,
      TOOL_NAME: TOOL,
      OPENAI_ALLOW_KEY: lanes["laravel-openai"].allowKey,
      OPENAI_DENY_KEY: lanes["laravel-openai"].denyKey,
      RESPONSES_ALLOW_KEY: lanes["laravel-responses"].allowKey,
      RESPONSES_DENY_KEY: lanes["laravel-responses"].denyKey,
      ANTHROPIC_ALLOW_KEY: lanes["laravel-anthropic"].allowKey,
      ANTHROPIC_DENY_KEY: lanes["laravel-anthropic"].denyKey,
    });
    expectAllPassed(
      report,
      CHECKS.flatMap((c) => [`laravel.openai.${c}`, `laravel.responses.${c}`, `laravel.anthropic.${c}`]),
    );
  });

  it("laravel-responses: the allowed calls went through /v1/responses", async () => {
    await expectResponsesSurface(lanes["laravel-responses"].allowId);
  });

  for (const lane of ["laravel-openai", "laravel-responses", "laravel-anthropic"] as const) {
    it(`${lane}: the allowed calls are cost-attributed and both outcomes are audited`, async () => {
      // allow + stream + the tool loop's two turns
      expect((await expectAttributedSpend(lanes[lane].allowId, "agent")).length).toBeGreaterThanOrEqual(3);
      const allowed = await auditRows(lanes[lane].allowId);
      expect(allowed.some((r) => r.effect === "allow" && r.objectType === "agent")).toBe(true);
      const denied = await auditRows(lanes[lane].denyId);
      expect(denied.some((r) => r.effect === "deny" && r.objectType === "agent" && r.objectId === agentId)).toBe(true);
    });
  }
});

describe("dart_mcp against the governed MCP endpoint (dart-mcp image)", () => {
  it("auth, allow, deny, streaming and tool calls pass from the client side", async () => {
    const report = await runClient(CLIENT_IMAGES["dart-mcp"], {
      GATEWAY_URL: gatewayUrl,
      MCP_SERVER_ID: serverId,
      PROJECT_ID: projectId,
      MCP_ALLOW_KEY: lanes["dart-mcp"].allowKey,
      MCP_ALLOWED_TOOL: MCP_ALLOWED,
      MCP_DENIED_TOOL: MCP_DENIED,
    });
    expectAllPassed(report, CHECKS.map((c) => `mcp.${c}`));
  });

  it("the allowed tool calls are cost-attributed; the allow and the deny are audited", async () => {
    const id = lanes["dart-mcp"].allowId;
    const rows = await expectAttributedSpend(id, "mcp_tool");
    expect(rows.every((r) => r.operation === MCP_ALLOWED)).toBe(true);
    const audit = await auditRows(id);
    expect(audit.some((r) => r.effect === "allow" && r.toolName === MCP_ALLOWED)).toBe(true);
    expect(audit.some((r) => r.effect === "deny" && r.toolName === MCP_DENIED)).toBe(true);
  });
});
