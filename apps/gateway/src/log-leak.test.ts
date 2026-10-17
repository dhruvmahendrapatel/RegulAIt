/**
 * N8 (2026-10-17) — a request body never reaches a log line, offline.
 *
 * The global error handler used to log a parser refusal's message and send it
 * back as `detail`, and the 500 branch logged the whole error with the URL's
 * query string. A content-type parser that passes Node's `SyntaxError` through
 * (the SCIM parser did) puts a snippet of the body in that message, and a
 * failed database query puts every bound parameter in drizzle's. This file
 * drives a bare Fastify instance with the SAME pino configuration the serving
 * process resolves, and the gateway's own refusal and line builders, into an
 * in-memory sink; `zz-n8-log-leak.test.ts` repeats the body cases through the
 * real app against Postgres.
 */
import { Writable } from "node:stream";
import Fastify, { errorCodes, LogController, type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parserRefusal,
  parserRefusalLogFields,
  redactLogText,
  resolveGatewayLogger,
  unhandledErrorLogFields,
} from "./gateway-logger.js";

// built at runtime so no secret-shaped literal sits in the source
const MARKER = ["N8", "LEAK", "MARKER", String(Date.now())].join("_");

let app: FastifyInstance;
let out = "";

/** the one line with this message */
function lineWith(msg: string): Record<string, unknown> {
  const lines = out.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const hit = lines.filter((l) => l.msg === msg);
  expect(hit).toHaveLength(1);
  return hit[0]!;
}

beforeAll(async () => {
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  const resolved = resolveGatewayLogger({ LOG_LEVEL: "info" } as NodeJS.ProcessEnv);
  // as app.ts builds it: the per-request lines (url and query unredacted) stay off
  app = Fastify({
    logger: { ...(resolved as object), stream: sink } as never,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.setErrorHandler((err, req, reply) => {
    const refusal = parserRefusal(err);
    if (refusal) {
      req.log.warn(parserRefusalLogFields(req, refusal), "request body refused");
      return reply.status(refusal.status).send(refusal.body);
    }
    req.log.error(unhandledErrorLogFields(req, err), "unhandled error");
    return reply.status(500).send({ error: "internal" });
  });
  app.post("/json", async () => ({ ok: true }));
  app.post("/handler-parse", async (req) => {
    // parsed and discarded: the route answers nothing of what it read
    JSON.parse(String((req.body as { raw?: string }).raw));
    return { ok: true };
  });
  app.post("/db-fail", async () => {
    // the shape drizzle-orm's DrizzleQueryError has (message, query, params, cause)
    const cause = Object.assign(new Error(`invalid input syntax for type uuid: "${MARKER}"`), {
      code: "22P02",
      detail: `Key (email)=(${MARKER}) already exists`,
    });
    const err = Object.assign(new Error(`Failed query: select 1 where id = $1\nparams: ${MARKER}`), {
      query: "select 1 where id = $1",
      params: [MARKER],
      cause,
    });
    err.name = "DrizzleQueryError";
    throw err;
  });
  app.register(async (scope) => {
    scope.addContentTypeParser("application/scim+json", { parseAs: "string" }, (_req, body: string, done) => {
      try {
        done(null, JSON.parse(body));
      } catch {
        done(new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY());
      }
    });
    scope.post("/scim", async () => ({ ok: true }));
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("parser refusals carry a code, never the body", () => {
  it.each([
    ["application/json", "/json", `{"note":"${MARKER}"`],
    ["application/scim+json", "/scim", `{"userName":"${MARKER}"`],
  ])("a malformed %s body: 400, fixed detail, a line with code, route and reqId", async (type, url, payload) => {
    out = "";
    const res = await app.inject({ method: "POST", url, headers: { "content-type": type }, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_json_body", detail: "The request body is not valid JSON." });
    expect(res.body).not.toContain(MARKER);
    expect(out).not.toContain(MARKER);
    const line = lineWith("request body refused");
    expect(line).toMatchObject({ code: "FST_ERR_CTP_INVALID_JSON_BODY", status: 400, route: url, msg: "request body refused" });
    expect(typeof line.reqId).toBe("string");
  });

  it("a body over the limit and an unknown media type: mapped codes kept, no marker", async () => {
    out = "";
    const big = await app.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: `{"note":"${MARKER}${"x".repeat(1_100_000)}"}`,
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe("body_too_large");
    const weird = await app.inject({ method: "POST", url: "/json", headers: { "content-type": "text/weird" }, payload: MARKER });
    expect(weird.statusCode).toBe(415);
    expect(weird.json().error).toBe("invalid_media_type");
    expect(big.body + weird.body + out).not.toContain(MARKER);
  });

  it("a third-party error with a 4xx statusCode is not mistaken for a parser refusal (SEC-03 scope)", () => {
    expect(parserRefusal(Object.assign(new Error(MARKER), { statusCode: 400 }))).toBeNull();
    expect(parserRefusal(Object.assign(new Error(MARKER), { code: "UND_ERR", statusCode: 400 }))).toBeNull();
    expect(parserRefusal(Object.assign(new Error(MARKER), { code: "FST_ERR_X", statusCode: 500 }))).toBeNull();
    const r = parserRefusal(Object.assign(new Error(MARKER), { code: "FST_ERR_SOMETHING_NEW", statusCode: 400 }));
    expect(r?.body).toEqual({ error: "something_new", detail: "The request could not be read." });
  });
});

describe("the 500 line withholds what can quote request input", () => {
  it("a SyntaxError from a handler's JSON.parse keeps its frames, not its message", async () => {
    out = "";
    const res = await app.inject({ method: "POST", url: "/handler-parse", payload: { raw: `{"a":"${MARKER}` } });
    expect(res.statusCode).toBe(500);
    expect(out).not.toContain(MARKER);
    expect(out).toContain('"errType":"SyntaxError"');
    expect(out).toContain(" at ");
  });

  it("a failed query keeps its SQL and SQLSTATE, not its params or Postgres's quoted values", async () => {
    out = "";
    const res = await app.inject({ method: "POST", url: "/db-fail?token=QTOKEN_VALUE&page=2", payload: {} });
    expect(res.statusCode).toBe(500);
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain("QTOKEN_VALUE");
    const line = lineWith("unhandled error");
    expect(line).toMatchObject({ sql: "select 1 where id = $1", params: "[1 withheld]", pgCode: "22P02", path: "/db-fail" });
  });

  it("negative control: an ordinary error still logs its message for the operator", async () => {
    const fields = unhandledErrorLogFields(
      { method: "GET", url: "/x?state=abc", routeOptions: { url: "/x" } } as never,
      new Error("pool exhausted"),
    );
    expect((fields.err as Error).message).toBe("pool exhausted");
    expect(fields.path).toBe("/x");
  });
});

describe("pino's own redaction and the line scrubber", () => {
  it("masks a body, a query object and credential headers wherever a call site logs them", () => {
    out = "";
    app.log.warn(
      {
        body: { note: MARKER },
        query: { q: MARKER },
        req: { body: MARKER, query: MARKER, headers: { authorization: MARKER, "proxy-authorization": MARKER } },
        headers: { "x-api-key": MARKER, "proxy-authorization": MARKER },
        err: { body: MARKER },
      },
      "probe",
    );
    expect(out).toContain("probe");
    expect(out).not.toContain(MARKER);
  });

  it("replaces credential-shaped query values in any line, keeping the names", () => {
    expect(redactLogText("/cb?code=abc&state=def&page=2")).toBe("/cb?code=[redacted]&state=[redacted]&page=2");
    expect(redactLogText("/x?access_token=a1#f")).toBe("/x?access_token=[redacted]#f");
    expect(redactLogText("/x?page=2&sort=asc")).toBe("/x?page=2&sort=asc");
  });
});
