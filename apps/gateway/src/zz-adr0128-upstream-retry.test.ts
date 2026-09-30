/**
 * ADR-0128 — the retry/backoff policy, and the one place it must NOT apply.
 *
 * ── WHAT IS WORTH TESTING HERE, AND WHAT IS NOT ────────────────────────────
 * "It retried" is the easy half and the uninteresting one. The claims that
 * could plausibly be false, and that would each be a real defect, are:
 *
 *  1. a `tools/call` on a WRITE tool is attempted exactly ONCE — a retry there
 *     can open two pull requests or charge two cards, and it would do so only
 *     under packet loss, i.e. never in a demo and always in production;
 *  2. a tool of UNKNOWN kind is treated as a write, not as "probably fine";
 *  3. OUR OWN refusals (egress blocked, admission held) are never retried, so
 *     an air-gapped or manifest-held server is refused once rather than three
 *     times with backoff between;
 *  4. a DEADLINE is never retried, because the bound an operator configured has
 *     already been waited out in full;
 *  5. the retries never exceed that bound — a 3-attempt policy on a 10s connect
 *     deadline must not become a 30s wait;
 *  6. one exhausted sequence is ONE failure to the breaker, not three, because
 *     the breaker's threshold was chosen against the unit "one failed
 *     operation" and per-attempt counting would silently triple its sensitivity.
 *
 * ── NON-VACUITY IS BUILT IN RATHER THAN MEASURED ONCE ──────────────────────
 * The end-to-end recovery test has a TWIN that is identical except that the
 * policy is switched to one attempt, and asserts the same flaky upstream fails.
 * So the proof that the retry is doing the work is a permanent test rather than
 * a temporary edit somebody has to remember to repeat — if the wiring is ever
 * removed, the pair disagrees and one of them goes red.
 *
 * ── THE POLICY IS PROCESS-WIDE, AND THIS FILE FOUND THAT OUT THE HARD WAY ──
 * The first version of Part 2 built TWO apps, one with retries on and one with
 * them off, and asserted against each. It went green in the wrong direction:
 * `setRetryConfig` is a module singleton (deliberately, exactly like
 * `timeouts.ts` — a gateway process has one policy), so the SECOND `buildApp`
 * silently set the policy for BOTH apps and every "retries on" test was really
 * running with them off. The twin is therefore one app with the policy switched
 * around each test, and the switch is visible at the call site rather than
 * buried in a builder option.
 *
 * Writes (servers, breaker state), so `zz-` (M-018) and ids scoped to this file
 * (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDb, eq, mcpServers, runMigrations, and, auditLog, desc, type Db } from "@regulait/db";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildApp } from "./app.js";
import { McpEgressBlockedError } from "./mcp-egress.js";
import { McpAdmissionHeldError } from "./mcp-admission.js";
import {
  RETRY_DEFAULTS,
  attemptsForToolKind,
  backoffDelayMs,
  classifyUpstreamError,
  newRetryReport,
  resolveRetryConfig,
  setRetryConfig,
  withUpstreamRetry,
} from "./upstream-retry.js";

/** The policy Part 2 runs under. Tiny backoffs because the SCHEDULE is asserted
 *  in Part 1 and here only the attempt count matters. */
const RETRY_ON = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 } as const;

// ===========================================================================
// PART 1 — the policy itself. Pure, no database, no sockets.
// ===========================================================================

/** the shape undici hands up for a refused/reset connection */
const netErr = (code: string) => Object.assign(new Error(`fetch failed`), { cause: { code } });

describe("what may be retried", () => {
  it("NEVER our own refusals — an adjudication is not different when asked twice", () => {
    const egress = new McpEgressBlockedError({
      ok: false,
      code: "host_not_allowlisted",
      reason: "not on the allow-list",
    });
    const held = new McpAdmissionHeldError("s1", "held", [], "manifest refused");

    for (const err of [egress, held]) {
      const v = classifyUpstreamError(err);
      expect(v.retryable).toBe(false);
      // the RULE that fired, not merely the boolean: an air-gapped install
      // refusing every host must not read as a flaky network
      expect(v.why).toBe("our_own_refusal");
    }
  });

  it("NEVER a deadline — the bound the operator set has already been waited in full", () => {
    // all three shapes the three layers produce; missing one would silently
    // turn a timeout into a retried timeout, i.e. double the configured bound
    const abort = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const undiciTimeout = netErr("UND_ERR_CONNECT_TIMEOUT");
    const etimedout = netErr("ETIMEDOUT");

    for (const err of [abort, undiciTimeout, etimedout]) {
      expect(classifyUpstreamError(err)).toEqual({
        retryable: false,
        why: "deadline_spent_the_budget",
      });
    }
  });

  it("YES a transient network failure, which is the case a retry actually fixes", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
      expect(classifyUpstreamError(netErr(code))).toEqual({
        retryable: true,
        why: "transient_network",
      });
    }
    // the oldest and least structured of them: no code at all, only a message.
    // Recognised because it is the most common transient MCP failure behind a
    // proxy that reaps idle connections.
    expect(classifyUpstreamError(new Error("socket hang up")).retryable).toBe(true);
  });

  it("YES a 503 and NO a 404 — the status decides, and it is read from the SDK's own error", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyUpstreamError(new StreamableHTTPError(status, "x"))).toEqual({
        retryable: true,
        why: "transient_status",
      });
    }
    for (const status of [400, 401, 403, 404, 422, 501]) {
      expect(classifyUpstreamError(new StreamableHTTPError(status, "x"))).toEqual({
        retryable: false,
        why: "permanent_status",
      });
    }
  });

  it("DEFAULTS TO NO for an error it cannot name", () => {
    // Repeating an error we cannot classify is a guess made at an upstream's
    // expense; it might be a protocol violation or a bad argument.
    expect(classifyUpstreamError(new Error("something went wrong"))).toEqual({
      retryable: false,
      why: "unrecognised",
    });
    expect(classifyUpstreamError(null).retryable).toBe(false);
    expect(classifyUpstreamError("a string").retryable).toBe(false);
  });
});

describe("a tools/call is an idempotence claim", () => {
  it("gives a WRITE tool exactly one attempt — THE defect this file exists to prevent", () => {
    expect(attemptsForToolKind("write")).toBe(1);
  });

  it("treats an UNKNOWN kind as a write, matching toolKind's own conservative default", () => {
    // A tool with no stored classification is not "probably safe". `toolKind`
    // already treats an un-annotated tool as a write everywhere else in §3, and
    // disagreeing here would make the retry policy more permissive than the
    // authorization policy it rides on.
    expect(attemptsForToolKind(null)).toBe(1);
    expect(attemptsForToolKind(undefined)).toBe(1);
  });

  it("never lets a READ hint authorize replay, even with retries enabled", () => {
    // EXPLICIT config, not the ambient one. The policy is a process-wide
    // singleton (see the note on `setRetryConfig` below), so a unit test that
    // read it would be asserting whichever app Part 2 built last — which is
    // exactly the false green this file caught on its first run.
    expect(attemptsForToolKind("read", { maxAttempts: 7, baseDelayMs: 1, maxDelayMs: 2 })).toBe(1);
  });

  it("and the SHIPPED default really does allow more than one, or none of this is on", () => {
    expect(RETRY_DEFAULTS.maxAttempts).toBeGreaterThan(1);
  });
});

describe("the backoff", () => {
  const cfg = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 800 };

  it("is FULL jitter — the whole range is reachable, not a fixed delay", () => {
    // rng() === 0 and rng() === 1 are the two ends. A fixed (or equal-jitter)
    // backoff leaves N callers that failed together still synchronised, which
    // is the one property that matters when the thing being protected is an
    // upstream that just fell over.
    expect(backoffDelayMs(0, cfg, () => 0)).toBe(0);
    expect(backoffDelayMs(0, cfg, () => 0.999999)).toBe(99);
  });

  it("doubles per attempt and then stops at the ceiling", () => {
    const top = (i: number) => backoffDelayMs(i, cfg, () => 0.999999) + 1;
    expect(top(0)).toBe(100);
    expect(top(1)).toBe(200);
    expect(top(2)).toBe(400);
    expect(top(3)).toBe(800);
    // capped, not 1600
    expect(top(4)).toBe(800);
  });
});

describe("the config", () => {
  it("refuses a malformed value instead of silently using the default", () => {
    // timeouts.ts / hsts.ts posture: a bad value is a deployment mistake and a
    // quiet fallback hides it exactly when an operator believed they had
    // configured something.
    expect(() => resolveRetryConfig({ REGULAIT_UPSTREAM_RETRY_ATTEMPTS: "lots" })).toThrow(/>= 1/);
    expect(() => resolveRetryConfig({ REGULAIT_UPSTREAM_RETRY_ATTEMPTS: "0" })).toThrow();
  });

  it("can be switched OFF entirely, which is what restores pre-ADR-0128 behaviour", () => {
    expect(resolveRetryConfig({ REGULAIT_UPSTREAM_RETRY_ATTEMPTS: "1" }).maxAttempts).toBe(1);
  });
});

describe("the sequence", () => {
  const cfg = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 };
  /** no real waiting, and every delay recorded so the SCHEDULE is asserted */
  const fakeClock = () => {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      advance: (ms: number) => {
        t += ms;
      },
      slept,
    };
  };

  it("does not retry what succeeded", async () => {
    const report = newRetryReport();
    let calls = 0;
    const out = await withUpstreamRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      { budgetMs: 1000, cfg, report },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(1);
    expect(report.attempts).toBe(1);
    expect(report.delaysMs).toEqual([]);
  });

  it("recovers on the second attempt and reports what it took", async () => {
    const clock = fakeClock();
    const report = newRetryReport();
    let calls = 0;
    const out = await withUpstreamRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw netErr("ECONNRESET");
        return "recovered";
      },
      { budgetMs: 1000, cfg, report, rng: () => 0.5, sleep: clock.sleep, now: clock.now },
    );
    expect(out).toBe("recovered");
    expect(calls).toBe(2);
    expect(report.attempts).toBe(2);
    expect(report.delaysMs).toEqual([5]);
    expect(clock.slept).toEqual([5]);
  });

  it("re-throws the ORIGINAL error unwrapped, because every call site branches on its type", async () => {
    // A wrapper error would have broken the egress/admission/deadline branches
    // at four call sites at once, for the benefit of a stack trace nobody reads.
    const original = new McpEgressBlockedError({
      ok: false,
      code: "blocked_address_range",
      reason: "link-local",
    });
    const report = newRetryReport();
    let calls = 0;
    await expect(
      withUpstreamRetry(
        async () => {
          calls += 1;
          throw original;
        },
        { budgetMs: 1000, cfg, report },
      ),
    ).rejects.toBe(original);
    // ONE attempt: our own refusal, so the gates ran exactly once
    expect(calls).toBe(1);
    expect(report.attempts).toBe(1);
    expect(report.lastWhy).toBe("our_own_refusal");
  });

  it("stops at maxAttempts and throws the LAST error", async () => {
    const clock = fakeClock();
    const report = newRetryReport();
    let calls = 0;
    await expect(
      withUpstreamRetry(
        async () => {
          calls += 1;
          throw netErr(`ECONNRESET`);
        },
        { budgetMs: 10_000, cfg, report, rng: () => 0.5, sleep: clock.sleep, now: clock.now },
      ),
    ).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3);
    expect(report.attempts).toBe(3);
    // two backoffs for three attempts — and NOT a third, which would be a sleep
    // nobody is waiting through
    expect(clock.slept).toEqual([5, 10]);
  });

  it("gives ONE attempt when told to, so the mechanism is genuinely switchable off", async () => {
    let calls = 0;
    await expect(
      withUpstreamRetry(
        async () => {
          calls += 1;
          throw netErr("ECONNRESET");
        },
        { budgetMs: 1000, cfg, maxAttempts: 1 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("THE BUDGET CLAIM: retries never extend the bound the operator set", async () => {
    const clock = fakeClock();
    const deadlines: number[] = [];
    let calls = 0;
    // each attempt burns 300ms of a 1000ms budget and fails transiently
    await expect(
      withUpstreamRetry(
        async ({ deadlineMs }) => {
          calls += 1;
          deadlines.push(deadlineMs);
          // HONOURS the deadline it was handed, which is what a real attempt
          // does — the SDK is given this number as its timeout. A fake that
          // overran it would be modelling a different bug (one in the SDK) and
          // would make this test assert something the policy cannot control.
          clock.advance(Math.min(300, deadlineMs));
          throw netErr("ECONNRESET");
        },
        {
          budgetMs: 1000,
          cfg: { maxAttempts: 10, baseDelayMs: 10, maxDelayMs: 10 },
          rng: () => 0.5,
          sleep: clock.sleep,
          now: clock.now,
        },
      ),
    ).rejects.toThrow();

    // the first attempt gets the WHOLE budget — an operation must never fail for
    // want of time it was never given
    expect(deadlines[0]).toBe(1000);
    // and every later attempt gets strictly less, monotonically
    for (let i = 1; i < deadlines.length; i += 1) {
      expect(deadlines[i]!).toBeLessThan(deadlines[i - 1]!);
    }
    // THE PROPERTY: the whole sequence fits inside the one configured bound,
    // even though the policy allowed ten attempts
    expect(clock.now()).toBeLessThanOrEqual(1000);
    expect(calls).toBeLessThan(10);
  });

  it("a backoff never eats more than half of what is left", async () => {
    // Sleeping out the remainder of the budget and then giving up for want of
    // time is strictly worse than trying again immediately, so when the budget
    // is nearly spent the WAIT shrinks rather than the attempt disappearing.
    const clock = fakeClock();
    const report = newRetryReport();
    let calls = 0;
    await expect(
      withUpstreamRetry(
        async () => {
          calls += 1;
          clock.advance(90);
          throw netErr("ECONNRESET");
        },
        {
          budgetMs: 100,
          // a backoff far larger than the remaining 10ms
          cfg: { maxAttempts: 3, baseDelayMs: 5000, maxDelayMs: 5000 },
          report,
          rng: () => 0.999999,
          sleep: clock.sleep,
          now: clock.now,
        },
      ),
    ).rejects.toThrow();
    expect(report.delaysMs).toEqual([5]);
    expect(calls).toBe(2);
  });
});

// ===========================================================================
// PART 2 — the wiring. A real proxy route, a real flaky upstream, a real DB.
// ===========================================================================

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "adr0128-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let auth: { authorization: string };
/** a listener that accepts and never answers — for the deadline half */
let blackHole: net.Server;
const blackHoleSockets = new Set<net.Socket>();
let blackHoleUrl: string;

/**
 * An upstream that fails the FIRST n HTTP requests with 503 and then serves MCP
 * properly. 503 is the honest shape for this: it is what a load balancer in
 * front of a starting pod actually returns, and the MCP SDK surfaces it as
 * `StreamableHTTPError` with the status — which is what the classifier reads.
 */
function flakyUpstream(failFirst: number): { server: http.Server; requests: () => number } {
  let seen = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen += 1;
      if (seen <= failFirst) {
        res.writeHead(503, { "content-type": "text/plain" }).end("warming up");
        return;
      }
      void (async () => {
        const mcp = new McpServer({ name: "adr0128-flaky", version: "0.0.1" });
        mcp.registerTool(
          "ping",
          { description: "ping", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "pong" }] }),
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  return { server, requests: () => seen };
}

async function listenOnEphemeral(server: net.Server | http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const a = server.address();
  if (typeof a !== "object" || !a) throw new Error("no address");
  return `http://127.0.0.1:${a.port}/`;
}

async function userKeyFor(target: ReturnType<typeof buildApp>, label: string) {
  const user = await target.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `adr0128-${label}-${Date.now()}@retry.example`, displayName: "R" },
  });
  const key = await target.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: `adr0128-${label}-key` },
  });
  return { authorization: `Bearer ${key.json().token}` };
}

let gatewayUrl: string;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);

  // A tiny connect deadline for the same reason g2 uses one: the behaviour is
  // identical at 600ms and the file is not the slowest in the suite. The
  // breaker threshold is high so these tests never trip it by accident — the
  // breaker's own behaviour is covered in g2-upstream-deadlines.
  app = buildApp(db, {
    bootstrapToken: BOOT,
    timeouts: { mcpConnectMs: 600 },
    breaker: { failureThreshold: 50 },
    retry: RETRY_ON,
  });
  auth = await userKeyFor(app, "on");
  gatewayUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  blackHole = net.createServer((sock) => {
    blackHoleSockets.add(sock);
    sock.on("close", () => blackHoleSockets.delete(sock));
  });
  blackHoleUrl = await listenOnEphemeral(blackHole);
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  for (const sock of blackHoleSockets) sock.destroy();
  blackHoleSockets.clear();
  await new Promise<void>((resolve) => blackHole.close(() => resolve()));
});

async function register(url: string): Promise<string> {
  const reg = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: `adr0128-${Math.random().toString(36).slice(2)}`, url },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return reg.json().id as string;
}

// MCP's adapter requires real socket drain/close semantics, not inject's mock.
async function postMcp(id: string, payload: unknown, headers = auth) {
  const response = await fetch(`${gatewayUrl}/mcp/${id}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  return { statusCode: response.status, body, json: () => JSON.parse(body) };
}

const listTools = (id: string) => postMcp(id, { jsonrpc: "2.0", id: 1, method: "tools/list" });

describe("an upstream that is briefly not ready", () => {
  it("is RECOVERED by the retry — the request succeeds where it used to 502", async () => {
    const { server, requests } = flakyUpstream(1);
    const url = await listenOnEphemeral(server);
    try {
      const id = await register(url);
      const res = await listTools(id);

      expect(res.statusCode, res.body).toBe(200);
      // the first HTTP request really was refused — the upstream was flaky, the
      // test is not asserting a lucky pass against a healthy server
      expect(requests()).toBeGreaterThan(1);

      // and the breaker sees a HEALTHY server, because the operation succeeded.
      // A retry that recovered must not leave a failure behind.
      const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
      expect(row!.breakerConsecutiveFailures).toBe(0);
      expect(row!.breakerOpenedAt).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("NON-VACUITY: the same upstream fails when the policy is one attempt", async () => {
    // Identical in every other respect. If the wiring in `connectUpstream` is
    // ever removed, this pair disagrees and one of the two goes red — which is
    // the whole point of paying for it as a permanent test.
    setRetryConfig({ ...RETRY_ON, maxAttempts: 1 });
    const { server } = flakyUpstream(1);
    const url = await listenOnEphemeral(server);
    try {
      const id = await register(url);
      const res = await listTools(id);
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("mcp_upstream_unreachable");
    } finally {
      setRetryConfig(RETRY_ON);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("gives up after the configured attempts rather than retrying forever", async () => {
    // fails more times than the policy allows, so the sequence must exhaust
    const { server, requests } = flakyUpstream(99);
    const url = await listenOnEphemeral(server);
    try {
      const id = await register(url);
      const res = await listTools(id);
      expect(res.statusCode).toBe(502);
      // exactly the configured attempts reached the upstream — not two, not four
      expect(requests()).toBe(3);

      // ONE failure for the whole sequence, not one per attempt. Counting
      // attempts would silently make the breaker three times more
      // trigger-happy without anybody changing its configuration.
      const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
      expect(row!.breakerConsecutiveFailures).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("says in the ledger how hard it tried, on the ONE row that already existed", async () => {
    const { server } = flakyUpstream(99);
    const url = await listenOnEphemeral(server);
    try {
      const id = await register(url);
      await listTools(id);

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "mcp-upstream-unreachable"), eq(auditLog.serverId, id)))
        .orderBy(desc(auditLog.at));
      // one row for the sequence, NOT one per attempt — verbatim the breaker's
      // reasoning about not turning an outage into a log flood
      expect(rows).toHaveLength(1);
      const detail = rows[0]!.detail as { attempts?: number; retryDelaysMs?: number[] };
      expect(detail.attempts).toBe(3);
      expect(detail.retryDelaysMs).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

describe("an upstream that hangs", () => {
  it("is attempted ONCE — the deadline already spent the whole budget", async () => {
    const id = await register(blackHoleUrl);
    const started = Date.now();
    const res = await listTools(id);
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(504);
    // THE BUDGET CLAIM end to end: three attempts allowed, one 600ms deadline,
    // and the caller waits ~600ms rather than ~1800ms. A retried timeout would
    // have tripled a bound an operator read and approved.
    expect(elapsed).toBeLessThan(1_800);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mcp-upstream-unreachable"), eq(auditLog.serverId, id)))
      .orderBy(desc(auditLog.at));
    const detail = rows[0]!.detail as { attempts?: number; retryVerdict?: string; outcome?: string };
    expect(detail.outcome).toBe("deadline_exceeded");
    expect(detail.attempts).toBe(1);
    // and the ledger says WHY we declined to retry, because a spent deadline and
    // an unrecognised error send an operator to different places
    expect(detail.retryVerdict).toBe("deadline_spent_the_budget");
  }, 30_000);
});

// ===========================================================================
// PART 3 — the claim that matters most: a WRITE tool is never asked twice.
// ===========================================================================
//
// AER-038: verify the one-attempt policy at the actual HTTP boundary for both
// tool classifications, including a committed effect followed by a lost reply.

/** Serves MCP, but 503s the FIRST `tools/call` for each tool name and counts
 *  every `tools/call` it is sent, per tool. */
function toolCallFlakyUpstream(effectFile: string): {
  server: http.Server;
  callsFor: (tool: string) => number;
} {
  const seen = new Map<string, number>();
  const failed = new Set<string>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg: { method?: string; params?: { name?: string } } | undefined;
      try {
        msg = body ? JSON.parse(body) : undefined;
      } catch {
        msg = undefined;
      }
      const tool = msg?.method === "tools/call" ? msg.params?.name : undefined;
      if (tool) {
        seen.set(tool, (seen.get(tool) ?? 0) + 1);
        // Simulate a committed external effect BEFORE losing its response.
        appendFileSync(effectFile, `${tool}\n`);
        if (!failed.has(tool)) {
          failed.add(tool);
          res.writeHead(503, { "content-type": "text/plain" }).end("flaky");
          return;
        }
      }
      void (async () => {
        const mcp = new McpServer({ name: "adr0128-tools", version: "0.0.1" });
        mcp.registerTool(
          "r128_read",
          { description: "read", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "read-ok" }] }),
        );
        // NO readOnlyHint — so §3 classifies it `write`, which is the whole
        // point: an un-annotated tool is a write everywhere in this product.
        mcp.registerTool("r128_write", { description: "write", inputSchema: {} }, async () => ({
          content: [{ type: "text", text: "write-ok" }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  return { server, callsFor: (t) => seen.get(t) ?? 0 };
}

describe("a tools/call that fails once", () => {
  it("never replays a committed effect after a 503, including readOnlyHint tools", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "regulait-aer038-"));
    const effectFile = path.join(scratch, "effects.txt");
    const { server, callsFor } = toolCallFlakyUpstream(effectFile);
    const url = await listenOnEphemeral(server);
    try {
      const id = await register(url);

      // a user of this file's own, granted both tools explicitly (M-008: never
      // lean on anything another suite may have granted)
      const user = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/users",
        payload: { email: `adr0128-tc-${Date.now()}@retry.example`, displayName: "TC" },
      });
      const userId = user.json().id as string;
      const key = await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/users/${userId}/keys`,
        payload: { name: "adr0128-tc-key" },
      });
      const tcAuth = { authorization: `Bearer ${key.json().token}` };
      for (const toolName of ["r128_read", "r128_write"]) {
        const grant = await app.inject({
          method: "POST",
          headers: AUTH,
          url: "/v1/grants/tools",
          payload: { userId, serverId: id, toolName },
        });
        expect(grant.statusCode, grant.body).toBe(201);
      }

      const call = (toolName: string) =>
        postMcp(id, {
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: { name: toolName, arguments: {} },
        }, tcAuth);

      // The response is ambiguous even when the upstream advertises read-only.
      const read = await call("r128_read");
      expect(read.statusCode, read.body).toBe(200);
      expect(read.body).not.toContain("read-ok");
      expect(read.body).toContain('"error"');
      expect(callsFor("r128_read")).toBe(1);

      // THE WRITE TOOL: the SAME failure, and it is NOT asked again. A second
      // attempt here is how a retry policy opens two pull requests or charges
      // two cards — and it would only ever do so under packet loss, i.e. never
      // in a demo and always in production.
      const write = await call("r128_write");
      expect(write.body).not.toContain("write-ok");
      expect(callsFor("r128_write")).toBe(1);
      expect(readFileSync(effectFile, "utf8").trim().split("\n"))
        .toEqual(["r128_read", "r128_write"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
