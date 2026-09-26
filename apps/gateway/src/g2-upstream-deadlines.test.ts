/**
 * ROADMAP G2 — deadlines, and the refusal that replaced a bare 500.
 *
 * WHY THESE TESTS EXIST IN THIS SHAPE. The defect they cover is the one error
 * this product tries hardest never to emit: `500 {"error":"internal"}`, with
 * nothing in the ledger, on the route whose entire proposition is that every
 * refusal is named. It was also the most common failure a new deployment hits
 * — the upstream simply is not running — and the demo runbook carried a
 * troubleshooting row for it (`DEMO_RUNBOOK.md` §5).
 *
 * Two upstreams are needed and they are NOT the same test:
 *
 *   - a CLOSED port refuses the connection immediately  -> 502, unreachable
 *   - a listener that ACCEPTS and never answers hangs forever -> 504, timeout
 *
 * The second is the one that could not be written before this change, because
 * there was no deadline to hit: the request would simply never return, and the
 * test would hang rather than fail. That is the whole point of G2.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { TIMEOUT_DEFAULTS, resolveTimeoutConfig } from "./timeouts.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "g2-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userAuth: { authorization: string };
/** a socket that accepts and then says nothing, ever */
let blackHole: net.Server;
/**
 * Every socket the black hole accepted. It has to hold them open to be a black
 * hole at all, which means `close()` alone waits for them forever — the first
 * run of this file passed all seven tests and then timed out in afterAll. They
 * are destroyed explicitly at teardown.
 */
const blackHoleSockets = new Set<net.Socket>();
let blackHoleUrl: string;
/** a port nobody is listening on */
let closedUrl: string;

async function listenOnEphemeral(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const a = server.address();
  if (typeof a !== "object" || !a) throw new Error("no address");
  return a.port;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);

  // A deliberately tiny connect deadline. The default is 10s and a test that
  // waited that long twice would be the slowest file in the suite; the
  // behaviour under test is identical at 400ms.
  app = buildApp(db, {
    bootstrapToken: BOOT,
    timeouts: { mcpConnectMs: 400 },
  });

  // accepts the TCP connection, then never writes a byte — the failure mode a
  // connect-refused test does NOT cover, and the one that used to hang forever
  blackHole = net.createServer((sock) => {
    // hold the socket open and say nothing — but remember it, so teardown can
    // let go of what this test deliberately never lets go of
    blackHoleSockets.add(sock);
    sock.on("close", () => blackHoleSockets.delete(sock));
  });
  blackHoleUrl = `http://127.0.0.1:${await listenOnEphemeral(blackHole)}/`;

  // bind, learn the port, then close it — so nothing is listening there
  const scratch = net.createServer();
  const deadPort = await listenOnEphemeral(scratch);
  await new Promise<void>((resolve) => scratch.close(() => resolve()));
  closedUrl = `http://127.0.0.1:${deadPort}/`;

  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `g2-${Date.now()}@deadlines.example`, displayName: "G2" },
  });
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "g2-key" },
  });
  userAuth = { authorization: `Bearer ${key.json().token}` };
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  for (const sock of blackHoleSockets) sock.destroy();
  blackHoleSockets.clear();
  await new Promise<void>((resolve) => blackHole.close(() => resolve()));
});

async function registerServer(name: string, url: string): Promise<string> {
  const reg = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name, url },
  });
  expect(reg.statusCode).toBe(201);
  return reg.json().id as string;
}

const callProxy = (serverId: string) =>
  app.inject({
    method: "POST",
    url: `/mcp/${serverId}`,
    headers: { ...userAuth, "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });

const latestAudit = async (ruleId: string) => {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row ?? null;
};

describe("an upstream that is not there", () => {
  it("is a NAMED 502, not the bare 500 it used to be", async () => {
    const id = await registerServer(`g2-closed-${Date.now()}`, closedUrl);
    const res = await callProxy(id);

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("mcp_upstream_unreachable");
    // the regression this guards: an unnamed internal error on a route whose
    // whole proposition is that every refusal is named
    expect(body.error).not.toBe("internal");
    expect(res.statusCode).not.toBe(500);
    // and it says WHICH server and WHERE, because "internal" said neither
    expect(body.detail).toContain(closedUrl);
  });

  it("files it in the ledger under its OWN rule id, not the egress one", async () => {
    const id = await registerServer(`g2-closed-audit-${Date.now()}`, closedUrl);
    await callProxy(id);

    const row = await latestAudit("mcp-upstream-unreachable");
    expect(row).not.toBeNull();
    expect(row!.effect).toBe("deny");
    expect(row!.serverId).toBe(id);
    // "we refused to reach it" and "we could not reach it" send an operator to
    // a policy screen and a network respectively — one shared id would answer
    // neither question
    expect(row!.ruleId).not.toBe("mcp-server-egress-blocked");
    expect((row!.detail as { outcome?: string }).outcome).toBe("connect_failed");
  });
});

describe("an upstream that accepts and never answers", () => {
  it("THE G2 CLAIM: it is bounded at all — 504, and the request returns", async () => {
    const id = await registerServer(`g2-hang-${Date.now()}`, blackHoleUrl);

    // Before G2 there was no deadline anywhere on this path, so this request
    // never returned and this assertion could not be written: the test would
    // hang until vitest killed the file.
    const started = Date.now();
    const res = await callProxy(id);
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(504);
    expect(res.json().error).toBe("mcp_upstream_timeout");
    expect(res.json().deadlineMs).toBe(400);

    // it actually honoured the configured deadline rather than some other
    // bound further down the stack
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it("distinguishes a deadline from a refusal in the ledger", async () => {
    const id = await registerServer(`g2-hang-audit-${Date.now()}`, blackHoleUrl);
    await callProxy(id);
    const row = await latestAudit("mcp-upstream-unreachable");
    expect((row!.detail as { outcome?: string }).outcome).toBe("deadline_exceeded");
    expect((row!.detail as { deadlineMs?: number }).deadlineMs).toBe(400);
  }, 20_000);
});

describe("requestTimeout does not sever a slow RESPONSE", () => {
  /**
   * THE ASSUMPTION THE INBOUND HALF RESTS ON. Node's `server.requestTimeout`
   * bounds RECEIVING a request, not handling one or replying to one. If that
   * were wrong, setting it would quietly break every streaming path in this
   * product — the hijacked MCP transport, both compat SSE edges, the
   * orchestration channel, `/v1/audit.csv` — and the failure would look like a
   * flaky client rather than a deadline we chose.
   *
   * Rather than trust the documentation, this drives OUR stack over a REAL
   * socket (inject bypasses the HTTP server entirely, so it could not see this
   * at all) with a requestTimeout FOUR TIMES SHORTER than the handler's own
   * wait. If requestTimeout policed the handler, this would come back 408 at
   * ~250ms; it must come back our 504 at ~1s instead.
   */
  it("a handler that takes far longer than requestTimeout still returns ITS answer", async () => {
    const slowApp = buildApp(db, {
      bootstrapToken: BOOT,
      timeouts: { requestTimeoutMs: 250, mcpConnectMs: 1000 },
    });
    const url = await slowApp.listen({ port: 0, host: "127.0.0.1" });
    try {
      const reg = await slowApp.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/servers",
        payload: { name: `g2-slow-${Date.now()}`, url: blackHoleUrl },
      });
      const serverId = reg.json().id as string;

      const started = Date.now();
      const res = await fetch(`${url}/mcp/${serverId}`, {
        method: "POST",
        headers: {
          ...userAuth,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const elapsed = Date.now() - started;

      // our deadline won, not the inbound one
      expect(res.status).toBe(504);
      expect((await res.json()).error).toBe("mcp_upstream_timeout");
      // and it genuinely outlived requestTimeout rather than racing it
      expect(elapsed).toBeGreaterThan(600);
    } finally {
      slowApp.server.closeAllConnections();
      await slowApp.close();
    }
  }, 20_000);
});

describe("the config", () => {
  it("restates the body limit that ALREADY existed rather than inventing one", () => {
    // Fastify's own default is 1 MiB and nothing overrode it, so G2's
    // body-limit half is about findability, not a new restriction. If this
    // number ever changes, it is a behaviour change and should be argued for.
    expect(TIMEOUT_DEFAULTS.bodyLimitBytes).toBe(1_048_576);
  });

  it("refuses a malformed deadline instead of silently using the default", () => {
    // the hsts.ts posture: a bad value is a deployment mistake, and falling
    // back quietly would hide it at exactly the moment an operator believed
    // they had set a bound
    expect(() => resolveTimeoutConfig({ REGULAIT_MCP_CONNECT_TIMEOUT_MS: "soon" })).toThrow(
      /positive number of milliseconds/,
    );
    expect(() => resolveTimeoutConfig({ REGULAIT_REQUEST_TIMEOUT_MS: "0" })).toThrow();
    expect(() => resolveTimeoutConfig({ REGULAIT_REQUEST_TIMEOUT_MS: "-5" })).toThrow();
  });

  it("an override beats the environment, so a test never has to mutate process.env", () => {
    const cfg = resolveTimeoutConfig({ REGULAIT_MCP_CONNECT_TIMEOUT_MS: "9999" }, { mcpConnectMs: 42 });
    expect(cfg.mcpConnectMs).toBe(42);
  });
});
