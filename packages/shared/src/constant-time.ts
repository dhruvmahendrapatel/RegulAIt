/**
 * ADR-0176 — THE constant-time comparison. One helper on the standard
 * library's `crypto.timingSafeEqual`, replacing five hand-rolled copies
 * (gateway auth, data-key fingerprints, the PM webhook secret check, the
 * ChatOps signature check and the PM-provider inbound verifiers).
 *
 * Length-safe: `timingSafeEqual` throws on inputs of different lengths, and
 * the copies handled that with an early `length !==` return, which tells a
 * caller the length of the secret it is probing. Both inputs are first derived
 * to 32 bytes (below), so the compare always runs over 32 bytes, never throws,
 * and leaks neither content nor length through its timing. Strings are compared
 * as their UTF-8 bytes.
 *
 * Nothing else in the repository may call `timingSafeEqual` directly; an
 * inventory test (`constant-time.test.ts`) fails on a new copy.
 */
import { hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Both inputs are derived to 32 bytes under a key drawn fresh for THIS call
 * (HKDF-SHA256, i.e. HMAC keyed by a random salt: the "double HMAC" compare),
 * so the compare runs over equal lengths and leaks neither content nor length.
 * Owner decision 2026-11-15 (ADR-0167 amendment S-02): a bare SHA-256 here was
 * flagged by CodeQL js/insufficient-password-hash, because callers compare
 * secrets; a random-keyed derivation is the standard construction and nothing
 * about it is stored, so no password KDF cost is paid.
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const key = randomBytes(32);
  const da = Buffer.from(hkdfSync("sha256", a, key, "regulait:constant-time-equal", 32));
  const db = Buffer.from(hkdfSync("sha256", b, key, "regulait:constant-time-equal", 32));
  return timingSafeEqual(da, db);
}
