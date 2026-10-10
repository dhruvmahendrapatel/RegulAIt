/**
 * ADR-0189 B4 contract round 2 (review item 4): `POST /v1/boms/verify` admits
 * the largest request the contract allows (an 8 MiB decoded bundle as base64
 * in JSON), above Fastify's 1 MiB default, and answers anything over its
 * per-route `bodyLimit` with the contract's 413 `bom_bundle_too_large`. The
 * route itself is still the B1 501 stub, so "reached the handler" is 501
 * `not_built`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { BOM_VERIFY_MAX_BASE64, BOM_VERIFY_MAX_REQUEST_BYTES, bomErrorEnvelopeSchema } from "@regulait/shared";
import { buildApp } from "./app.js";
import { closeAll } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const BOOT = `a189-b4-limit-${Math.random().toString(36).slice(2, 8)}`;
const AUTH = { authorization: `Bearer ${BOOT}`, "content-type": "application/json" };

let db: Db;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();
});
afterAll(async () => {
  await closeAll([async () => app.close(), async () => db.$client.end()]);
});

/** a raw JSON body of exactly `bytes` bytes: the contract's bundle shape, padded inside the base64 */
const bodyOf = (bytes: number): string => {
  const head = '{"source":"bundle","bundleBase64":"';
  const tail = '"}';
  return head + "A".repeat(bytes - head.length - tail.length) + tail;
};

describe("ADR-0189 B4: the verify route's body limit", () => {
  it("is above the largest admitted request", () => {
    expect(bodyOf(BOM_VERIFY_MAX_BASE64 + 37).length).toBeLessThanOrEqual(BOM_VERIFY_MAX_REQUEST_BYTES);
    expect(BOM_VERIFY_MAX_REQUEST_BYTES).toBeGreaterThan(1024 * 1024);
  });
  it("a request at the limit reaches the handler (still the 501 stub)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/boms/verify", headers: AUTH, payload: bodyOf(BOM_VERIFY_MAX_REQUEST_BYTES) });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(501);
    expect(res.json().error).toBe("not_built");
  });
  it("a request one byte over gets 413 bom_bundle_too_large, in the contract's envelope", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/boms/verify", headers: AUTH, payload: bodyOf(BOM_VERIFY_MAX_REQUEST_BYTES + 1) });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(413);
    expect(bomErrorEnvelopeSchema.parse(res.json()).error).toBe("bom_bundle_too_large");
  });
  it("other errors on the route still reach the global handler (malformed JSON is 400, not 413)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/boms/verify", headers: AUTH, payload: "{not json" });
    expect(res.statusCode).toBe(400);
  });
});
