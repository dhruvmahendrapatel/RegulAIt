/**
 * Codex review S-08 (ADR-0025 addendum, 2026-11-22): password hashing uses an
 * OWASP-equivalent scrypt cost, runs off the event loop, keeps verifying
 * hashes written with the old parameters, and flags those for rehash.
 */
import { scryptSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, passwordNeedsRehash, verifyPassword } from "./auth.js";

/** a hash exactly as the pre-addendum code wrote it (N=2^14, r=8, p=1) */
function legacyHash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

describe("S-08: password hashing cost and rehash", () => {
  it("writes N=2^15, r=8, p=3 (an OWASP equivalent minimum), never the old N=2^14/p=1", async () => {
    const stored = await hashPassword("Rg1-correct horse");
    const [scheme, n, r, p] = stored.split("$");
    expect(scheme).toBe("scrypt");
    expect([Number(n), Number(r), Number(p)]).toEqual([32768, 8, 3]);
    // control: the cost is at least OWASP's N=2^14/p=5 equivalent (N*p >= 81920)
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
