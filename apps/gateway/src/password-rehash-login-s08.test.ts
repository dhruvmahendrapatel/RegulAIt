/**
 * Codex review S-08 (ADR-0025 addendum, 2026-11-22): a password hash written
 * with the pre-addendum scrypt parameters (N=2^14, r=8, p=1) still signs in,
 * and the successful sign-in replaces it with a hash at the current cost. A
 * failed sign-in leaves the stored hash exactly as it was.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *  1. wrong password on a legacy hash: 401, stored hash byte-identical.
 *  2. right password on a legacy hash: 200, stored hash now `scrypt$131072$8$1$`,
 *     and the new hash verifies the same password.
 *  3. a second sign-in does not rewrite a current hash.
 *  4. (R3 #1194) a password change that lands between verify and the rehash
 *     write survives: the sign-in still succeeds, the stored hash is the newer
 *     one, and the old password no longer verifies against it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync } from "node:crypto";
import { createDb, eq, runMigrations, users, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { hashPassword, verifyPassword } from "./auth.js";

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
    expect(after!.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(await verifyPassword(PASSWORD, after)).toBe(true);
  });

  it("a current hash is not rewritten on the next sign-in", async () => {
    const before = await storedHash();
    const res = await login(PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    expect(await storedHash()).toBe(before);
  });

  it("a password change landing between verify and the rehash write is not overwritten (compare-and-set)", async () => {
    // a second, legacy-hashed account, signed in through an app whose db runs a
    // password change at the first users update of the login (the lockout reset,
    // which sits after verify and before the rehash write)
    const raceEmail = `s08-race-${Date.now()}@example.com`;
    const created = await app.inject({ method: "POST", headers: ADMIN, url: "/v1/users", payload: { email: raceEmail, displayName: "S08 Race" } });
    expect(created.statusCode, created.body).toBe(201);
    const raceId = created.json().id as string;
    const OLD = "Rg1-old-" + randomBytes(6).toString("hex");
    const NEW = "Rg1-new-" + randomBytes(6).toString("hex");
    await db
      .update(users)
      .set({ passwordHash: legacyHash(OLD), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, raceId));
    const newerHash = await hashPassword(NEW);
    let armed = true;
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "update") {
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        }
        return (table: unknown) => {
          const real = target.update(table as typeof users);
          if (!armed || table !== users) return real;
          armed = false;
          return {
            set: (values: Parameters<typeof real.set>[0]) => ({
              where: async (cond: Parameters<ReturnType<typeof real.set>["where"]>[0]) => {
                await target.update(users).set({ passwordHash: newerHash }).where(eq(users.id, raceId));
                return real.set(values).where(cond);
              },
            }),
          };
        };
      },
    }) as Db;
    const racingApp = buildApp(racingDb, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
    try {
      const res = await racingApp.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { identifier: raceEmail, password: OLD } });
      expect(res.statusCode, res.body).toBe(200);
      expect(armed).toBe(false); // the change really ran inside the window
      const stored = (await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, raceId)))[0]!.h;
      expect(stored).toBe(newerHash);
      expect(await verifyPassword(NEW, stored)).toBe(true);
      expect(await verifyPassword(OLD, stored)).toBe(false);
    } finally {
      await racingApp.close();
    }
  }, 60_000);
});
