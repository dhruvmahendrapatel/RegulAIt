/**
 * Codex review S-08 (ADR-0025 addendum, 2026-11-22): password hashing uses an
 * OWASP-equivalent scrypt cost, runs off the event loop, keeps verifying
 * hashes written with the old parameters, and flags those for rehash.
 */
import { scryptSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, passwordHashConcurrency, passwordHashingLoad, passwordNeedsRehash, verifyPassword, PASSWORD_HASH_CONCURRENCY_ENV } from "./auth.js";

/** a hash exactly as the pre-addendum code wrote it (N=2^14, r=8, p=1) */
function legacyHash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

describe("S-08: password hashing cost and rehash", () => {
  it("writes N=2^17, r=8, p=1 (OWASP's first recommendation), never the old N=2^14/p=1", async () => {
    const stored = await hashPassword("Rg1-correct horse");
    const [scheme, n, r, p] = stored.split("$");
    expect(scheme).toBe("scrypt");
    expect([Number(n), Number(r), Number(p)]).toEqual([131072, 8, 1]);
    // control: at least OWASP's cheapest equivalent (N=2^14, p=5: N*p >= 81920)
    expect(Number(n) * Number(p)).toBeGreaterThanOrEqual(81920);
  });

  it("verifies the right password and refuses a wrong one", async () => {
    const stored = await hashPassword("Rg1-correct horse");
    expect(await verifyPassword("Rg1-correct horse", stored)).toBe(true);
    expect(await verifyPassword("Rg1-wrong horse", stored)).toBe(false);
  });

  it("keeps verifying a legacy hash, and flags it (not a current one) for rehash", async () => {
    const old = legacyHash("Rg1-legacy");
    expect(await verifyPassword("Rg1-legacy", old)).toBe(true);
    expect(await verifyPassword("Rg1-nope", old)).toBe(false);
    expect(passwordNeedsRehash(old)).toBe(true);
    expect(passwordNeedsRehash(await hashPassword("x"))).toBe(false);
    expect(passwordNeedsRehash(null)).toBe(false);
    expect(passwordNeedsRehash("not-a-hash")).toBe(false);
  });

  it("refuses null, malformed and absurd-parameter hashes", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc")).toBe(false);
    const good = await hashPassword("x");
    const parts = good.split("$");
    for (const bad of [
      ["scrypt", String(1 << 24), parts[2], parts[3], parts[4], parts[5]], // N far too large
      ["scrypt", "30000", parts[2], parts[3], parts[4], parts[5]], // N not a power of two
      ["scrypt", parts[1], "0", parts[3], parts[4], parts[5]], // r < 1
      ["scrypt", parts[1], parts[2], "1000", parts[4], parts[5]], // p too large
    ]) {
      expect(await verifyPassword("x", bad.join("$"))).toBe(false);
    }
  });

  it("a burst of eight sign-ins runs at most the configured number of 128 MiB derivations at once and all complete", async () => {
    const stored = await hashPassword("Rg1-burst");
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, passwordHashingLoad().active)), 1);
    const started = Date.now();
    let results: boolean[];
    try {
      results = await Promise.all(Array.from({ length: 8 }, (_, i) => verifyPassword(i % 2 ? "Rg1-burst" : "wrong", stored)));
    } finally {
      clearInterval(timer);
    }
    expect(results).toEqual([false, true, false, true, false, true, false, true]);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(passwordHashingLoad().limit);
    expect(passwordHashingLoad()).toMatchObject({ active: 0, pending: 0 });
    // recorded for the PR body, not asserted (machine-dependent)
    console.log(`[s08] 8 concurrent verifies at N=2^17: ${Date.now() - started} ms, peak ${peak} in flight`);
  }, 60_000);

  it("the concurrency cap defaults to 4 (owner, 2026-11-22), accepts 1..8 and ignores anything else", () => {
    expect(passwordHashConcurrency({})).toBe(4);
    expect(passwordHashConcurrency({ [PASSWORD_HASH_CONCURRENCY_ENV]: "2" })).toBe(2);
    expect(passwordHashConcurrency({ [PASSWORD_HASH_CONCURRENCY_ENV]: "8" })).toBe(8);
    for (const bad of ["0", "9", "-1", "4.5", "lots", ""]) {
      expect(passwordHashConcurrency({ [PASSWORD_HASH_CONCURRENCY_ENV]: bad })).toBe(4);
    }
    expect(passwordHashingLoad().limit).toBe(passwordHashConcurrency());
  });

  it("does not block the event loop while deriving", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await Promise.all([hashPassword("a"), verifyPassword("b", null), verifyPassword("c", null)]);
    } finally {
      clearInterval(timer);
    }
    // a synchronous scryptSync at this cost would starve the interval entirely
    expect(ticks).toBeGreaterThan(0);
  });
});
