/**
 * ADR-0167 (SEC-03) — Fastify's own client-side refusals are reported as what
 * they are.
 *
 * Before this, a body over the limit, a malformed JSON body or an unknown
 * content type raised a FastifyError (`FST_ERR_CTP_*`, statusCode 413/400/415)
 * that the global error handler did not recognise, so every one of them
 * became `500 {"error":"internal"}` plus an error-level log line — a client
 * fault reported as a server fault, reachable UNAUTHENTICATED because body
 * parsing runs before the auth preHandler. And the two import routes
 * advertised bounds (2 MB / 4 MB) ABOVE the 1 MiB global body limit, so their
 * honest "payloads are bounded at N bytes; split the export" refusals could
 * never fire: everything between 1 MiB and the bound was a 500.
 *
 * Every case here was a 500 before the fix (the error-handler branch and the
 * per-route bodyLimits); reverting either reddens the matching test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { COST_IMPORT_MAX_BYTES, EVIDENCE_MAX_BYTES } from "@regulait/shared";
import { buildApp } from "./app.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "parser-errors-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
});

afterAll(async () => {
  await app.close();
});

/** an egress-log evidence document of roughly `bytes` bytes of JSON */
function evidenceOfSize(bytes: number): string {
  const row = '{"destinationHost":"api.openai.com"}';
  const n = Math.ceil(bytes / (row.length + 1));
  return `{"kind":"egress_log","mode":"dry_run","rows":[${Array.from({ length: n }, () => row).join(",")}]}`;
}

/** a cost export of roughly `bytes` bytes */
function costExportOfSize(bytes: number): string {
  const row = '{"provider":"openai","amountUsd":0.01,"occurredAt":"2026-10-01T00:00:00Z"}';
  const n = Math.ceil(bytes / (row.length + 1));
  return `{"provider":"openai","mode":"dry_run","rows":[${Array.from({ length: n }, () => row).join(",")}]}`;
}

describe("Fastify's parser refusals reach the caller as 4xx, never as 500", () => {
  it("a malformed JSON body is a 400 naming the fault — authenticated or not", async () => {
    for (const headers of [AUTH, {}]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/shadow-ai/imports",
        headers: { ...headers, "content-type": "application/json" },
        payload: "{not json",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_json_body");
      expect(typeof res.json().detail).toBe("string");
    }
  });

  it("an unknown content type is a 415, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/shadow-ai/imports",
      headers: { ...AUTH, "content-type": "text/weird" },
      payload: "whatever",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("invalid_media_type");
  });

  it("a body over the GLOBAL limit on an ordinary route is a 413 that says so", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: `{"email":"x@example.com","displayName":"${"x".repeat(1_100_000)}"}`,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("body_too_large");
  });
});

describe("the import routes admit the bound they advertise", () => {
  it("evidence between 1 MiB and EVIDENCE_MAX_BYTES is parsed and answered by the route itself", async () => {
    const payload = evidenceOfSize(1_300_000);
    expect(payload.length).toBeGreaterThan(1_048_576);
    expect(payload.length).toBeLessThan(EVIDENCE_MAX_BYTES);
    const res = await app.inject({
      method: "POST",
      url: "/v1/shadow-ai/imports",
      headers: { ...AUTH, "content-type": "application/json" },
      payload,
    });
    // the route's own verdict on a document this size (the row bound, or a
    // refused document) — anything but the parser's 413 or an opaque 500
    expect(res.statusCode).not.toBe(500);
    expect([400, 413, 422]).toContain(res.statusCode);
    expect(res.json().error).not.toBe("internal");
    expect(res.json().error).not.toBe("body_too_large");
  });

  it("evidence over EVIDENCE_MAX_BYTES gets the route's honest 413 and the chunking advice", async () => {
    const payload = evidenceOfSize(EVIDENCE_MAX_BYTES + 20_000);
    const res = await app.inject({
      method: "POST",
      url: "/v1/shadow-ai/imports",
      headers: { ...AUTH, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("evidence_too_large");
    expect(String(res.json().detail)).toContain("split the export into chunks");
  });

  it("a cost export between 1 MiB and COST_IMPORT_MAX_BYTES is parsed rather than 500'd", async () => {
    const payload = costExportOfSize(1_400_000);
    expect(payload.length).toBeLessThan(COST_IMPORT_MAX_BYTES);
    const res = await app.inject({
      method: "POST",
      url: "/v1/cost-imports",
      headers: { ...AUTH, "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).not.toBe(500);
    expect(res.json().error).not.toBe("internal");
    expect(res.json().error).not.toBe("body_too_large");
  });
});
