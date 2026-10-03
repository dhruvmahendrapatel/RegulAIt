/**
 * ADR-0167 (CFG-02) — the serving process logs refusals, and never a credential.
 *
 * `buildApp` ran with `logger: false`: Fastify installed abstract-logging and
 * every `app.log.*` call in the error handler and the boot timers was a
 * no-op, so a 500's reason was discarded and a 401/403/404/429 flood left no
 * trace. The logger is now resolved on the boot path and handed in; this
 * file drives an app with the SAME pino configuration `startGateway` resolves,
 * pointed at an in-memory destination, and reads the lines back.
 */
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { credentialKind, describeGatewayLogger, resolveGatewayLogger } from "./gateway-logger.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FastifyRequest } from "fastify";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "logger-bootstrap-token";
const SECRET_BEARER = "rgl_this-must-never-be-logged-0123456789abcdef";

let db: Db;
let app: ReturnType<typeof buildApp>;
const lines: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const sink = new Writable({
    write(chunk, _enc, cb) {
      for (const raw of String(chunk).split("\n")) {
        if (raw.trim()) lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
      cb();
    },
  });
  const resolved = resolveGatewayLogger({ LOG_LEVEL: "warn" } as NodeJS.ProcessEnv);
  expect(resolved).not.toBe(false);
  app = buildApp(db, {
    bootstrapToken: BOOT,
    logger: { ...(resolved as object), stream: sink } as never,
  });
});

afterAll(async () => {
  await app.close();
});

describe("resolution", () => {
  it("defaults to info, honours LOG_LEVEL, falls back on a typo, and REGULAIT_LOG=off silences", () => {
    expect((resolveGatewayLogger({} as NodeJS.ProcessEnv) as { level: string }).level).toBe("info");
    expect((resolveGatewayLogger({ LOG_LEVEL: "debug" } as NodeJS.ProcessEnv) as { level: string }).level).toBe("debug");
    expect((resolveGatewayLogger({ LOG_LEVEL: "loud" } as NodeJS.ProcessEnv) as { level: string }).level).toBe("info");
    expect(resolveGatewayLogger({ REGULAIT_LOG: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(describeGatewayLogger(false)).toContain("off");
    expect(describeGatewayLogger(resolveGatewayLogger({} as NodeJS.ProcessEnv))).toContain("level info");
  });

  it("names the credential KIND, never the value", () => {
    const fake = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;
    expect(credentialKind(fake({}))).toBe("none");
    expect(credentialKind(fake({ authorization: `Bearer ${SECRET_BEARER}` }))).toBe("bearer-unverified");
    expect(credentialKind(fake({ cookie: "regulait_session=abc" }))).toBe("cookie-unverified");
  });
});

describe("what a refusal leaves behind", () => {
  it("a 401 with a bad bearer is one warn line naming route, ip and credential kind — and not the bearer", async () => {
    lines.length = 0;
    const res = await app.inject({
      method: "GET",
      url: "/v1/audit?x=1",
      remoteAddress: "203.0.113.7",
      headers: { authorization: `Bearer ${SECRET_BEARER}`, cookie: "regulait_session=should-not-appear" },
    });
    expect(res.statusCode).toBe(401);
    const refused = lines.filter((l) => l.msg === "request refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      status: 401,
      method: "GET",
      route: "/v1/audit",
      path: "/v1/audit",
      ip: "203.0.113.7",
      credential: "bearer-unverified",
    });
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain(SECRET_BEARER);
    expect(everything).not.toContain("should-not-appear");
  });

  it("at info, no request line carries the URL — the OIDC callback's code and state never reach the log", async () => {
    // Fastify's own per-request lines ("incoming request" / "request completed")
    // print req.url with its query string unredacted; the gateway disables them
    // and writes only its own refusal/error lines (ADR-0167 §9).
    const infoLines: Array<Record<string, unknown>> = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        for (const raw of String(chunk).split("\n")) if (raw.trim()) infoLines.push(JSON.parse(raw) as Record<string, unknown>);
        cb();
      },
    });
    const resolved = resolveGatewayLogger({ LOG_LEVEL: "info" } as NodeJS.ProcessEnv);
    const verbose = buildApp(db, { bootstrapToken: BOOT, logger: { ...(resolved as object), stream: sink } as never });
    try {
      const res = await verbose.inject({ method: "GET", url: "/auth/me?probe_secret=QSECRET123&code=QCODE456&state=QSTATE789" });
      expect([200, 401]).toContain(res.statusCode);
      const everything = JSON.stringify(infoLines);
      expect(everything).not.toContain("QSECRET123");
      expect(everything).not.toContain("QCODE456");
      expect(infoLines.map((l) => l.msg)).not.toContain("incoming request");
      expect(infoLines.map((l) => l.msg)).not.toContain("request completed");
    } finally {
      await verbose.close();
    }
  });

  it("a successful request below the threshold leaves no line at all at warn", async () => {
    lines.length = 0;
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(lines).toHaveLength(0);
  });
});
