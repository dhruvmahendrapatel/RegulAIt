/**
 * N8 (2026-10-17) — a request body never reaches a log line, through the real app.
 *
 * One route per body type the gateway parses: JSON (the default parser),
 * SCIM's `application/scim+json` (a custom parser that used to pass Node's
 * `SyntaxError`, which quotes the body, to the error handler), form-encoded
 * (the SAML ACS's parser), plain text (Fastify's default), an over-limit body
 * and an unknown media type. Each body carries a synthetic marker; neither the
 * captured log output nor the response may contain it. `log-leak.test.ts`
 * covers the line builders offline.
 */
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { resolveGatewayLogger } from "./gateway-logger.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "n8-log-leak-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
// built at runtime so no secret-shaped literal sits in the source
const MARKER = ["N8", "BODY", "MARKER", String(Date.now())].join("_");

let db: Db;
let app: ReturnType<typeof buildApp>;
let out = "";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  const resolved = resolveGatewayLogger({ LOG_LEVEL: "trace" } as NodeJS.ProcessEnv);
  app = buildApp(db, { bootstrapToken: BOOT, logger: { ...(resolved as object), stream: sink } as never });
});

afterAll(async () => {
  await app.close();
});

function lines(): Array<Record<string, unknown>> {
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("no body type leaves the body in a log line or the response", () => {
  it.each([
    ["malformed JSON", "/v1/users", "application/json", `{"email":"${MARKER}@example.com"`, AUTH, 400, "invalid_json_body"],
    ["malformed SCIM JSON", "/scim/v2/Users", "application/scim+json", `{"userName":"${MARKER}"`, {}, 400, "invalid_json_body"],
    ["empty JSON", "/v1/users", "application/json", "", AUTH, 400, "empty_json_body"],
    ["an unknown media type", "/v1/users", "text/weird", MARKER, AUTH, 415, "invalid_media_type"],
    ["a body over the limit", "/v1/users", "application/json", `{"email":"${MARKER}","x":"${"x".repeat(1_100_000)}"}`, AUTH, 413, "body_too_large"],
  ] as const)("%s: refused with a code, and the line carries code, route, status and reqId", async (_name, url, type, payload, headers, status, error) => {
    out = "";
    const res = await app.inject({ method: "POST", url, headers: { ...headers, "content-type": type }, payload });
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toBe(error);
    expect(res.body).not.toContain(MARKER);
    expect(out).not.toContain(MARKER);
    const refused = lines().filter((l) => l.msg === "request body refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ status, route: url });
    expect(String(refused[0]!.code)).toMatch(/^FST_ERR_/);
    expect(typeof refused[0]!.reqId).toBe("string");
  });

  it.each([
    ["schema-invalid JSON", "/v1/users", "application/json", JSON.stringify({ email: MARKER, displayName: 7 }), AUTH],
    ["plain text", "/v1/users", "text/plain", MARKER, AUTH],
    ["a form-encoded SAML ACS post", "/auth/saml/00000000-0000-0000-0000-000000000000/acs", "application/x-www-form-urlencoded", `SAMLResponse=${MARKER}&RelayState=${MARKER}`, {}],
  ] as const)("%s: a 4xx whose response and lines never carry the body", async (_name, url, type, payload, headers) => {
    out = "";
    const res = await app.inject({ method: "POST", url, headers: { ...headers, "content-type": type }, payload });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).not.toContain(MARKER);
    expect(out).not.toContain(MARKER);
    expect(lines().length).toBeGreaterThan(0);
  });
});
