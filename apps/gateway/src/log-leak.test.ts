/**
 * N8 (2026-10-17) — a request body never reaches a log line, offline.
 *
 * The global error handler used to log a parser refusal's message and send it
 * back as `detail`, and the 500 branch logged the whole error with the URL's
 * query string. A content-type parser that passes Node's `SyntaxError` through
 * (the SCIM parser did) puts a snippet of the body in that message, and a
 * failed database query puts every bound parameter in drizzle's. This file
 * drives a bare Fastify instance with the SAME pino configuration the serving
 * process resolves, the gateway's REAL error handler (`handleGatewayError`)
 * and the REAL SCIM body parser (`parseScimJsonBody`), into an in-memory sink;
 * `zz-n8-log-leak.test.ts` repeats the body cases through the whole app
 * against Postgres.
 */
import { Writable } from "node:stream";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleGatewayError } from "./app.js";
import {
  parserRefusal,
  redactLogText,
  requestLogFields,
  resolveGatewayLogger,
  UNMATCHED_PATH_MAX,
  unhandledErrorLogFields,
} from "./gateway-logger.js";
import { errFields, errLine, errMessage } from "./err-serializer.js";
import { parseScimJsonBody } from "./scim.js";
import { recordSchedulerFailure, resetSchedulerHealth, schedulerHealth } from "./scheduler-health.js";

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
  app.setErrorHandler(handleGatewayError);
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
  app.post("/wrapped-fail", async () => {
    // F2: a wrapper whose cause is a failed query (pino folds every cause's message into `message`)
    const inner = Object.assign(new Error(`Failed query: select 2\nparams: ${MARKER}`), { query: "select 2", params: [MARKER, 1] });
    throw new Error(`could not finish: ${inner.message}`, { cause: inner });
  });
  app.register(async (scope) => {
    scope.addContentTypeParser("application/scim+json", { parseAs: "string" }, parseScimJsonBody);
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
    expect(lineWith("unhandled error").err).toMatchObject({ type: "SyntaxError", message: "[withheld: may quote request input]" });
    expect(out).toContain(" at ");
  });

  it("a failed query keeps its SQLSTATE, not its SQL, params or Postgres's quoted values (Q10)", async () => {
    out = "";
    // a non-credential name: only the path strip keeps it out (the scrubber would not)
    const res = await app.inject({ method: "POST", url: "/db-fail?q=QSEARCH_VALUE&page=2", payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain("QSEARCH_VALUE");
    const line = lineWith("unhandled error");
    expect(line).toMatchObject({ path: "/db-fail", err: { type: "DrizzleQueryError", sqlState: "22P02" } });
    expect(JSON.stringify(line)).not.toContain('"params"');
  });

  it("a wrapper whose cause is a failed query is withheld the same way (F2)", async () => {
    out = "";
    const res = await app.inject({ method: "POST", url: "/wrapped-fail", payload: {} });
    expect(res.statusCode).toBe(500);
    expect(out).not.toContain(MARKER);
    expect(lineWith("unhandled error").err).toMatchObject({
      type: "Error",
      message: "[withheld: may quote request input]",
      cause: { message: "[withheld: may quote request input]" },
    });
  });

  it("the 500 line's fields carry the error itself, for the serializer", () => {
    const err = new Error("pool exhausted");
    const fields = unhandledErrorLogFields(
      { method: "GET", url: "/x?state=abc", routeOptions: { url: "/x" } } as never,
      err,
    );
    expect(fields.err).toBe(err);
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
        req: { headers: { authorization: MARKER, "proxy-authorization": MARKER } },
        headers: { "x-api-key": MARKER, "proxy-authorization": MARKER },
        err: { body: MARKER },
      },
      "probe",
    );
    expect(out).toContain("probe");
    expect(out).not.toContain(MARKER);
  });

  it("masks req.body and req.query where no serializer drops them first", async () => {
    // Fastify's `req` serializer already omits the body; this logger keeps the
    // raw `req` value, so only the redact paths stand between it and the line
    let raw = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        raw += String(chunk);
        cb();
      },
    });
    const resolved = resolveGatewayLogger({ LOG_LEVEL: "info" } as NodeJS.ProcessEnv) as object;
    const bare = Fastify({ logger: { ...resolved, stream: sink, serializers: { req: (r: unknown) => r } } as never });
    await bare.ready();
    bare.log.warn({ req: { body: { note: MARKER }, query: { q: MARKER }, method: "POST" } }, "bare probe");
    await bare.close();
    expect(raw).toContain("bare probe");
    expect(raw).toContain('"method":"POST"');
    expect(raw).not.toContain(MARKER);
  });

  it("masks credential headers one level down: an outbound client's config/request/response (F4)", () => {
    out = "";
    app.log.error(
      {
        config: { headers: { authorization: MARKER, cookie: MARKER, "x-api-key": MARKER, "proxy-authorization": MARKER } },
        request: { headers: { authorization: MARKER } },
        err: { response: { headers: { authorization: MARKER } } },
      },
      "nested probe",
    );
    expect(out).toContain("nested probe");
    expect(out).not.toContain(MARKER);
  });

  it("masks every credential header under err.<client>.headers (R2)", () => {
    out = "";
    app.log.error(
      {
        err: {
          config: { headers: { cookie: MARKER, "x-api-key": MARKER, "proxy-authorization": MARKER, authorization: MARKER } },
          request: { headers: { cookie: MARKER } },
        },
      },
      "err nested probe",
    );
    expect(out).toContain("err nested probe");
    expect(out).not.toContain(MARKER);
  });

  it("replaces credential-shaped query values in any line, keeping the names", () => {
    expect(redactLogText("/cb?code=abc&state=def&page=2")).toBe("/cb?code=[redacted]&state=[redacted]&page=2");
    expect(redactLogText("/x?access_token=a1#f")).toBe("/x?access_token=[redacted]#f");
    expect(redactLogText("/x?page=2&sort=asc")).toBe("/x?page=2&sort=asc");
  });

  it("replaces credential values in a fragment too (R3)", () => {
    expect(redactLogText("/cb#access_token=SECRET&state=z")).toBe("/cb#access_token=[redacted]&state=[redacted]");
    expect(redactLogText("/cb#section=2")).toBe("/cb#section=2");
  });

  it.each(["client_secret", "code_verifier", "X-Amz-Signature", "X-Amz-Credential", "X-Goog-Signature"])(
    "replaces the %s query value (F3)",
    (name) => {
      expect(redactLogText(`/x?a=1&${name}=v1v2v3&b=2`)).toBe(`/x?a=1&${name}=[redacted]&b=2`);
    },
  );
});

describe("the refusal line's path (unmatched routes only)", () => {
  const req = (url: string, route?: string) =>
    ({ method: "GET", url, routeOptions: route ? { url: route } : {}, ip: "203.0.113.5", headers: {} }) as never;

  it("a matched route logs its template, not the raw path", () => {
    const f = requestLogFields(req(`/v1/users/${MARKER}?x=1`, "/v1/users/:id"), 404);
    expect(f).toMatchObject({ route: "/v1/users/:id", status: 404 });
    expect(f).not.toHaveProperty("path");
    expect(JSON.stringify(f)).not.toContain(MARKER);
  });

  it("an unmatched path is logged without its query, redacted and bounded", () => {
    const f = requestLogFields(req(`/scim/v2/Users/alice@corp.example/${"z".repeat(300)}?token=abc`), 404);
    expect(f.route).toBeNull();
    expect(String(f.path).startsWith("/scim/v2/Users/alice@corp.example/")).toBe(true);
    expect(String(f.path)).toHaveLength(UNMATCHED_PATH_MAX + "[truncated]".length);
    expect(String(f.path)).not.toContain("token");
    const feedback = requestLogFields(req(`/v1/feedback/l/rglf_${"a1".repeat(32)}`), 404);
    expect(feedback.path).toBe("/v1/feedback/l/[redacted]");
  });
});

describe("console-bound error text (F1)", () => {
  it("withholds a failed query's message and params, keeping its name and SQLSTATE", () => {
    const err = Object.assign(new Error(`Failed query: select 1\nparams: ${MARKER}`), {
      query: "select 1",
      params: [MARKER],
      cause: Object.assign(new Error(`Key (email)=(${MARKER}) already exists`), { code: "23505" }),
    });
    err.name = "DrizzleQueryError";
    const text = errLine(err);
    expect(text).not.toContain(MARKER);
    expect(text).toContain("DrizzleQueryError");
    expect(text).toContain("23505");
  });

  it("withholds a SyntaxError anywhere in the cause chain", () => {
    expect(errLine(new SyntaxError(MARKER))).not.toContain(MARKER);
    expect(errLine(new Error("outer", { cause: new SyntaxError(MARKER) }))).toMatch(/^Error \(cause SyntaxError\)/);
  });

  it("withholds a bare driver error: SQLSTATE plus severity/detail (R5)", () => {
    const pg = Object.assign(new Error(`invalid input syntax for type uuid: "${MARKER}"`), {
      code: "22P02",
      severity: "ERROR",
    });
    pg.name = "DatabaseError";
    expect(errLine(pg)).toBe("DatabaseError [SQLSTATE 22P02]: [withheld: may quote request input]");
    expect(errMessage(pg)).not.toContain(MARKER);
    expect(errLine(new Error("outer", { cause: pg }))).not.toContain(MARKER);
    // a Node system error's code is not a SQLSTATE: still an ordinary message
    expect(errLine(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }))).toBe("Error: connect refused");
  });

  it("errMessage: the message without the name, withheld where the line withholds (R1)", () => {
    expect(errMessage(new Error("pool exhausted"))).toBe("pool exhausted");
    expect(errMessage(new Error("GET /cb?code=abc failed"))).toBe("GET /cb?code=[redacted] failed");
    expect(errMessage(new SyntaxError(MARKER))).not.toContain(MARKER);
    expect(errMessage(42)).toBe("42");
  });

  it("keeps an ordinary message, with credential query values scrubbed", () => {
    expect(errLine(new Error("pool exhausted"))).toBe("Error: pool exhausted");
    expect(errLine(new Error("GET /cb?code=abc failed"))).toBe("Error: GET /cb?code=[redacted] failed");
    expect(errLine("plain")).toBe("plain");
  });

  it("errFields: the {obj} a console logger receives carries no withheld text", () => {
    const dbErr = Object.assign(new Error(`params: ${MARKER}`), { query: "q", params: [MARKER] });
    const o = errFields({ err: dbErr, subject: "s1", url: "/cb?state=xyz" }) as Record<string, unknown>;
    expect(JSON.stringify(o)).not.toContain(MARKER);
    expect(o).toMatchObject({ subject: "s1", url: "/cb?state=[redacted]" });
  });
});

describe("the real SCIM parser", () => {
  it("accepts an empty body (no refusal)", async () => {
    const empty = await app.inject({ method: "POST", url: "/scim", headers: { "content-type": "application/scim+json" }, payload: "" });
    expect(empty.statusCode).toBe(200);
  });
});

describe("a scheduler failure records the withheld form (N8 S2)", () => {
  it("the console line, lastError and the audit row carry no failed-query text", async () => {
    resetSchedulerHealth();
    const inserted: unknown[] = [];
    const fakeDb = {
      // the actor lookup fails over to the system id
      select: () => {
        throw new Error("no admin lookup in this test");
      },
      insert: () => ({
        values: async (v: unknown) => {
          inserted.push(v);
        },
      }),
    } as unknown as Parameters<typeof recordSchedulerFailure>[0];
    const failed = Object.assign(new Error(`Failed query: delete from audit_log\nparams: ${MARKER}`), {
      query: "delete from audit_log",
      params: [MARKER],
      cause: Object.assign(new Error(`detail ${MARKER}`), { code: "57014" }),
    });
    failed.name = "DrizzleQueryError";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await recordSchedulerFailure(fakeDb, "audit-prune", failed);
    } finally {
      spy.mockRestore();
    }
    const health = schedulerHealth().find((h) => h.name === "audit-prune");
    expect(lines).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    const all = JSON.stringify({ lines, health, inserted });
    expect(all).not.toContain(MARKER);
    expect(health?.lastError).toContain("SQLSTATE 57014");
    expect(JSON.stringify(inserted[0])).toContain("SQLSTATE 57014");
    resetSchedulerHealth();
  });
});
