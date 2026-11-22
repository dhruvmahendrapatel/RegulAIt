/**
 * Codex review S-08 (ADR-0025 addendum, 2026-11-22): a password hash written
 * with the pre-addendum scrypt parameters (N=2^14, r=8, p=1) still signs in,
 * and the successful sign-in replaces it with a hash at the current cost. A
 * failed sign-in leaves the stored hash exactly as it was.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *  1. wrong password on a legacy hash: 401, stored hash byte-identical.
 *  2. right password on a legacy hash: 200, stored hash now `scrypt$32768$8$3$`,
 *     and the new hash verifies the same password.
 *  3. a second sign-in does not rewrite a current hash.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync } from "node:crypto";
import { createDb, eq, runMigrations, users, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { verifyPassword } from "./auth.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "s08-rehash-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const PASSWORD = "Rg1-legacy-" + randomBytes(6).toString("hex");

function legacyHash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let email: string;

const storedHash = async () => (await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, userId)))[0]!.h;
const login = (password: string) =>
  app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { identifier: email, password } });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  email = `s08-rehash-${Date.now()}@example.com`;
  const u = await app.inject({ method: "POST", headers: ADMIN, url: "/v1/users", payload: { email, displayName: "S08 Rehash" } });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id as string;
  await db
    .update(users)
    .set({ passwordHash: legacyHash(PASSWORD), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, userId));
});

afterAll(async () => {
  await app.close();
});

describe("S-08: rehash on successful password sign-in", () => {
  it("a wrong password leaves the legacy hash untouched", async () => {
    const before = await storedHash();
    const res = await login("Rg1-not-the-password");
    expect(res.statusCode, res.body).toBe(401);
    expect(await storedHash()).toBe(before);
  });

  it("the right password signs in and upgrades the hash to the current cost", async () => {
    const before = await storedHash();
    expect(before!.startsWith("scrypt$16384$8$1$")).toBe(true);
    const res = await login(PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    const after = await storedHash();
    expect(after).not.toBe(before);
    expect(after!.startsWith("scrypt$32768$8$3$")).toBe(true);
    expect(await verifyPassword(PASSWORD, after)).toBe(true);
  });

  it("a current hash is not rewritten on the next sign-in", async () => {
    const before = await storedHash();
    const res = await login(PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    expect(await storedHash()).toBe(before);
  });
});
