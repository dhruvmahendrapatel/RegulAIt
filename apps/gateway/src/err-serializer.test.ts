/**
 * Q10 (ADR-0197), ADR-0167 N8 as built: pino's standard error serializer behind
 * the N8 whitelist. Each representative error is serialized directly and also
 * written through a real Fastify logger with the configuration the serving
 * process resolves, so the line a collector receives is what is asserted.
 */
import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errFields, errLine, errMessage, errSerializer, WITHHELD } from "./err-serializer.js";
import { resolveGatewayLogger } from "./gateway-logger.js";

// built at runtime so no secret-shaped literal sits in the source
const MARKER = ["Q10", "LEAK", "MARKER", String(Date.now())].join("_");
const TOKEN = ["tok", "synthetic", String(Date.now())].join("_");

/** a DrizzleQueryError-shaped failure whose driver cause quotes a row */
function dbError(): Error {
  const cause = Object.assign(new Error(`duplicate key value violates unique constraint "users_email_key"`), {
    code: "23505",
    severity: "ERROR",
    detail: `Key (email)=(${MARKER}@example.test) already exists`,
    constraint: "users_email_key",
    table: "users",
    where: `row ${MARKER}`,
  });
  const err = Object.assign(new Error(`Failed query: insert into users values ($1)\nparams: ${MARKER}`), {
    query: "insert into users values ($1)",
    params: [`${MARKER}@example.test`],
    cause,
  });
  err.name = "DrizzleQueryError";
  return err;
}

/** an outbound fetch failure: the URL carries a token, the client nests the request it sent */
function fetchError(): Error {
  const inner = Object.assign(new Error(`connect ECONNREFUSED for https://svc.example.test/hook?access_token=${TOKEN}`), {
    code: "ECONNREFUSED",
  });
  return Object.assign(new TypeError(`GET https://svc.example.test/hook?access_token=${TOKEN} failed`, { cause: inner }), {
    config: { headers: { authorization: `Bearer ${TOKEN}` }, data: { secret: MARKER } },
    response: { body: MARKER },
  });
}

async function logged(obj: Record<string, unknown>): Promise<Record<string, unknown>> {
  let out = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  const resolved = resolveGatewayLogger({ LOG_LEVEL: "info" } as NodeJS.ProcessEnv);
  const app = Fastify({ logger: { ...(resolved as object), stream: sink } as never });
  await app.ready();
  app.log.error(obj, "failed");
  await app.close();
  const line = out.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "failed");
  expect(line).toBeDefined();
  return line!;
}

describe("the error serializer (Q10)", () => {
  it("a DB error with row data in its message: only names, SQLSTATE, an id and frames", async () => {
    const s = errSerializer(dbError());
    expect(JSON.stringify(s)).not.toContain(MARKER);
    expect(s).toMatchObject({
      type: "DrizzleQueryError",
      message: WITHHELD,
      sqlState: "23505",
      constraint: "users_email_key",
      table: "users",
    });
    expect(s.errorId).toMatch(/^[0-9a-f]{12}$/);
    expect(s.stack).toMatch(/^\s+at /);
    expect(s.cause).toMatchObject({ code: "23505", sqlState: "23505", message: WITHHELD });
    for (const k of ["params", "query", "detail", "where"]) {
      expect(Object.keys(s)).not.toContain(k);
      expect(Object.keys(s.cause!)).not.toContain(k);
    }
    const line = await logged({ err: dbError() });
    expect(JSON.stringify(line)).not.toContain(MARKER);
    expect(line.err).toMatchObject({ type: "DrizzleQueryError", sqlState: "23505", constraint: "users_email_key" });
  });

  it("a fetch error whose URL carries a token: the value is redacted, the client's request dropped", async () => {
    const s = errSerializer(fetchError());
    const text = JSON.stringify(s);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(MARKER);
    expect(s).toMatchObject({ type: "TypeError", message: "GET https://svc.example.test/hook?access_token=[redacted] failed" });
    expect(s.cause).toMatchObject({ code: "ECONNREFUSED" });
    expect(Object.keys(s)).not.toContain("config");
    expect(Object.keys(s)).not.toContain("response");
    const line = await logged({ error: fetchError() });
    expect(JSON.stringify(line)).not.toContain(TOKEN);
    expect(JSON.stringify(line)).not.toContain(MARKER);
  });

  it("a nested cause: a withheld link withholds every message above it, not pino's folded text", async () => {
    const err = new Error(`could not finish: ${MARKER}`, {
      cause: new Error("step two", { cause: new SyntaxError(`Unexpected token in JSON at "${MARKER}"`) }),
    });
    const s = errSerializer(err);
    expect(JSON.stringify(s)).not.toContain(MARKER);
    expect(s.message).toBe(WITHHELD);
    expect(s.cause?.message).toBe(WITHHELD);
    expect(s.cause?.cause?.type).toBe("SyntaxError");
    expect(errLine(err)).toBe(`Error (cause SyntaxError): ${WITHHELD}`);
    const line = await logged({ err });
    expect(JSON.stringify(line)).not.toContain(MARKER);
    // an ordinary chain keeps each link's own message only
    const plain = errSerializer(new Error("outer", { cause: new Error("inner") }));
    expect(plain.message).toBe("outer");
    expect(plain.cause?.message).toBe("inner");
  });

  it("a trigger RAISE (SQLSTATE P0001) is withheld (Q9)", () => {
    const raise = Object.assign(new Error(`row ${MARKER} is immutable`), { code: "P0001", severity: "ERROR" });
    raise.name = "DatabaseError";
    expect(errLine(raise)).toBe(`DatabaseError [SQLSTATE P0001]: ${WITHHELD}`);
    expect(errMessage(raise)).toBe(`DatabaseError [SQLSTATE P0001]: ${WITHHELD}`);
  });

  it("an error logged as pino's first argument goes through the same serializer", async () => {
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    const app = Fastify({ logger: { ...(resolveGatewayLogger({} as NodeJS.ProcessEnv) as object), stream: sink } as never });
    await app.ready();
    app.log.error(dbError());
    await app.close();
    expect(out).not.toContain(MARKER);
    expect(out).toContain('"sqlState":"23505"');
  });

  it("the error id is stable for one failure site and differs across types", () => {
    const make = () => new RangeError("x");
    const a = errSerializer(make());
    const b = errSerializer(make());
    expect(a.errorId).toBe(b.errorId);
    expect(errSerializer(Object.assign(make(), { code: "E1" })).errorId).not.toBe(a.errorId);
  });

  it("is idempotent, bounded on a cycle, and handles non-errors", () => {
    const s = errSerializer(dbError());
    expect(errSerializer(s)).toBe(s);
    const a = new Error("a") as Error & { cause?: unknown };
    a.cause = a;
    expect(errSerializer(a).message).toBe("a");
    expect(errMessage(42)).toBe("42");
    expect(errLine("plain")).toBe("plain");
    expect(errSerializer({ password: MARKER }).message).not.toContain(MARKER);
    expect(errMessage(new Error("GET /cb?code=abc failed"))).toBe("GET /cb?code=[redacted] failed");
  });

  it("errFields: a console-bound field bag carries the serialized error and redacted strings", () => {
    const o = errFields({ err: dbError(), subject: "s1", url: "/cb?state=xyz" }) as Record<string, unknown>;
    expect(JSON.stringify(o)).not.toContain(MARKER);
    expect(o).toMatchObject({ subject: "s1", url: "/cb?state=[redacted]", err: { sqlState: "23505" } });
  });
});
