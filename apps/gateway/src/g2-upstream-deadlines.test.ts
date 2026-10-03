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
import { and, auditLog, createDb, desc, eq, mcpServers, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { TIMEOUT_DEFAULTS, resolveTimeoutConfig } from "./timeouts.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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
      expect(((await res.json()) as { error: string }).error).toBe("mcp_upstream_timeout");
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

// ===========================================================================
// ADR-0126 — the circuit breaker
// ===========================================================================
//
// The deadline bounds ONE call; the breaker bounds the tenth caller paying that
// same bound to learn what the first one learned. These tests use a threshold
// of 2 and a 600ms cooldown so the state machine is exercised in under a
// second — the shipped numbers are 5 and 30s and the behaviour is identical.

describe("the circuit breaker", () => {
  let brApp: ReturnType<typeof buildApp>;
  let brAuth: { authorization: string };

  beforeAll(async () => {
    brApp = buildApp(db, {
      bootstrapToken: BOOT,
      timeouts: { mcpConnectMs: 300 },
      breaker: { failureThreshold: 2, cooldownMs: 600 },
    });
    const user = await brApp.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: `g2-br-${Date.now()}@deadlines.example`, displayName: "G2BR" },
    });
    const key = await brApp.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${user.json().id}/keys`,
      payload: { name: "g2-br-key" },
    });
    brAuth = { authorization: `Bearer ${key.json().token}` };
  }, 60_000);

  afterAll(async () => {
    brApp.server.closeAllConnections();
    await brApp.close();
  });

  const brRegister = async (url: string) => {
    const reg = await brApp.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: { name: `g2-br-${Math.random().toString(36).slice(2)}`, url },
    });
    expect(reg.statusCode).toBe(201);
    return reg.json().id as string;
  };
  const brCall = (id: string) =>
    brApp.inject({
      method: "POST",
      url: `/mcp/${id}`,
      headers: { ...brAuth, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

  it("opens after the threshold, and then refuses WITHOUT contacting the upstream", async () => {
    // THE INSTRUMENT, AND WHY IT IS NOT A STOPWATCH. This test used to
    // assert "contacts nobody" through a wall-clock proxy — ten refusals in
    // under one 300ms connect deadline. On the shared CI runner the ten full
    // governed requests (auth, server row, attribution, breaker read) took
    // 593ms with the breaker contacting nobody, and the identical code had
    // passed on the previous commit. A timing bound measures the runner, not
    // the breaker. So the upstream is now a listener that COUNTS connections
    // and slams each one shut — a genuine upstream failure as far as the client
    // is concerned — and the claim is that the count stops moving the moment
    // the circuit opens. That is the property, measured directly, on any
    // machine at any speed.
    let connections = 0;
    const slammer = net.createServer((sock) => {
      connections += 1;
      sock.destroy();
    });
    const port = await listenOnEphemeral(slammer);
    try {
      const id = await brRegister(`http://127.0.0.1:${port}/`);

      // below the threshold: each attempt really goes out and really fails
      expect((await brCall(id)).statusCode).toBe(502);
      expect((await brCall(id)).statusCode).toBe(502);
      // POSITIVE CONTROL for the instrument (M-033): those failures were real
      // connections, so the counter is measuring what it claims to measure.
      const contactedWhileClosed = connections;
      expect(contactedWhileClosed).toBeGreaterThanOrEqual(2);

      // threshold crossed — now it is refused by us, not by the network
      const third = await brCall(id);
      expect(third.statusCode).toBe(503);
      expect(third.json().error).toBe("mcp_upstream_circuit_open");
      // and it tells the caller when to come back, which 502 cannot
      expect(third.headers["retry-after"]).toBeDefined();

      // THE PROPERTY THAT MATTERS: an open circuit contacts nobody. Ten more
      // refusals, and the listener must not have seen one new connection.
      for (let i = 0; i < 10; i += 1) expect((await brCall(id)).statusCode).toBe(503);
      expect(connections, "an open circuit must not touch the upstream").toBe(
        contactedWhileClosed,
      );
    } finally {
      // every accepted socket was destroyed on arrival, so close() returns
      await new Promise<void>((resolve) => slammer.close(() => resolve()));
    }
  }, 30_000);

  it("files the OPENING in the ledger, but not each refusal — an outage is not a log flood", async () => {
    const id = await brRegister(closedUrl);
    await brCall(id);
    await brCall(id);
    for (let i = 0; i < 8; i += 1) await brCall(id);

    const opened = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mcp-upstream-breaker-opened"), eq(auditLog.serverId, id)));
    // exactly one transition, not one row per refused call
    expect(opened).toHaveLength(1);
    expect(opened[0]!.effect).toBe("deny");
  }, 30_000);

  it("after the cooldown it probes, and a recovered upstream closes it", async () => {
    // One address that is dead first and alive later — the point being that the
    // breaker must stop contacting it while open, and find it again afterwards.
    // Reserve a real port and release it, so nothing is listening there yet.
    const reserve = net.createServer();
    const port = await listenOnEphemeral(reserve);
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const id = await brRegister(`http://127.0.0.1:${port}/`);

    await brCall(id);
    await brCall(id);
    expect((await brCall(id)).statusCode).toBe(503);

    // bring a real MCP server up at that address
    const live = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          const server = new McpServer({ name: "g2-recovered", version: "0.0.1" });
          server.registerTool(
            "ping",
            { description: "ping", inputSchema: {}, annotations: { readOnlyHint: true } },
            async () => ({ content: [{ type: "text", text: "pong" }] }),
          );
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await server.connect(transport);
          await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
        })().catch(() => {
          if (!res.headersSent) res.writeHead(500).end();
        });
      });
    });
    await new Promise<void>((resolve) => live.listen(port, "127.0.0.1", resolve));

    try {
      // still inside the cooldown: refused without even trying the now-live server
      expect((await brCall(id)).statusCode).toBe(503);

      await new Promise((r) => setTimeout(r, 700));

      // cooldown elapsed: this request is elected to probe, and it succeeds
      const probe = await brCall(id);
      expect(probe.statusCode).toBe(200);

      const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
      expect(row!.breakerOpenedAt).toBeNull();
      expect(row!.breakerConsecutiveFailures).toBe(0);

      const closedRows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "mcp-upstream-breaker-closed"), eq(auditLog.serverId, id)));
      expect(closedRows).toHaveLength(1);
    } finally {
      live.closeAllConnections();
      await new Promise<void>((resolve) => live.close(() => resolve()));
    }
  }, 30_000);

  it("elects exactly ONE prober, so a backlog does not become a thundering herd", async () => {
    const id = await brRegister(blackHoleUrl);
    // two hangs to open it (each costs the 300ms connect deadline)
    await brCall(id);
    await brCall(id);
    expect((await brCall(id)).statusCode).toBe(503);

    await new Promise((r) => setTimeout(r, 700));

    // twelve at once, the instant the cooldown expires. Exactly one may pay the
    // connect deadline against the black hole; the rest must fast-fail.
    const results = await Promise.all(Array.from({ length: 12 }, () => brCall(id)));
    const probed = results.filter((r) => r.statusCode === 504).length;
    const fastFailed = results.filter((r) => r.statusCode === 503).length;
    expect(probed).toBe(1);
    expect(fastFailed).toBe(11);
  }, 30_000);

  it("a POLICY refusal does not count towards the breaker, however many times it happens", async () => {
    // An egress refusal is OUR decision, not the upstream's fault. If it
    // counted, tightening the allow-list would trip breakers across the estate
    // and a governance change would present as an outage — with the ledger
    // asserting the upstreams failed, which would be false.
    //
    // RUN-LOCAL ON PURPOSE (M-040, and M-042 for making the same mistake
    // twice). The first version of this test flipped `mcpPrivateRangesDefault`,
    // an ORG-GLOBAL singleton, and the second read the shared
    // `egress_allow_hosts` table. Both pass alone and both break behind
    // whichever sibling suite touched that state — which is exactly what
    // happened: 502 instead of 403 in the full run.
    //
    // A literal TEST-NET-3 address (RFC 5737, randomised per run) needs none of
    // it: it is PUBLIC, so the private-range posture is irrelevant whatever the
    // org default says, and no other suite allow-lists it. The default-deny
    // allow-list refuses it without resolving or contacting anything.
    const unroutable = `http://203.0.113.${1 + Math.floor(Math.random() * 250)}:8931/`;

    // Registered against a permitted URL, then pointed at the refused one
    // directly, because the WRITE-TIME guard would refuse the registration.
    // That is a real situation, not a contrivance: it is what a server looks
    // like after the allow-list is tightened underneath it.
    const id = await brRegister(closedUrl);
    await db.update(mcpServers).set({ url: unroutable }).where(eq(mcpServers.id, id));

    // well past the threshold of 2
    for (let i = 0; i < 6; i += 1) {
      const res = await brCall(id);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
    }

    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
    expect(row!.breakerConsecutiveFailures).toBe(0);
    expect(row!.breakerOpenedAt).toBeNull();
  }, 30_000);
});
