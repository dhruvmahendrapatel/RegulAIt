/**
 * Lane E23 (P-01a of ADR-0251's pending list): `GET /v1/approvals/kinds`, the queue kinds the approvals filter offers.
 * The list is the shared enum `GET /v1/approvals` parses `objectType` with, so a kind added server side reaches the
 * filter without an SPA edit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { APPROVAL_OBJECT_TYPES, APPROVAL_OBJECT_TYPE_LABELS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { NON_ADMIN_ROUTES } from "./route-classes.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = randomBytes(3).toString("hex");
const BOOT = `e23k-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e23k-data-key-${RUN}`).digest("hex");

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberKey: Record<string, string>;
let restoreMfa: (() => Promise<void>) | undefined;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e23k-${RUN}@example.com`, displayName: "e23k member" } });
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "k" } });
  memberKey = { authorization: `Bearer ${k.json().token}` };
});

afterAll(async () => {
  await restoreMfa?.(); // the deployment-wide MFA posture must not leak into later suites
  await app?.close();
});

describe("GET /v1/approvals/kinds", () => {
  it("lists every queue kind in the shared enum's order, each with its label, model_call included", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/approvals/kinds", headers: memberKey });
    expect(r.statusCode).toBe(200);
    const kinds = r.json().kinds as Array<{ kind: string; label: string }>;
    expect(kinds.map((k) => k.kind)).toEqual([...APPROVAL_OBJECT_TYPES]);
    for (const k of kinds) expect(k.label).toBe(APPROVAL_OBJECT_TYPE_LABELS[k.kind as keyof typeof APPROVAL_OBJECT_TYPE_LABELS]);
    expect(kinds.map((k) => k.kind)).toContain("model_call");
    expect(r.headers["cache-control"]).toBe("private, max-age=3600");
  });

  it("is a reviewer read like the queue itself, and refuses an anonymous caller", async () => {
    expect(NON_ADMIN_ROUTES.has("GET /v1/approvals/kinds")).toBe(true);
    const anon = await app.inject({ method: "GET", url: "/v1/approvals/kinds" });
    expect(anon.statusCode).toBe(401);
  });

  it("every listed kind is one the queue's objectType filter accepts", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/approvals/kinds", headers: AUTH });
    for (const { kind } of r.json().kinds as Array<{ kind: string }>) {
      const q = await app.inject({ method: "GET", url: `/v1/approvals?objectType=${kind}&status=pending`, headers: AUTH });
      expect([kind, q.statusCode]).toEqual([kind, 200]);
    }
  });
});
