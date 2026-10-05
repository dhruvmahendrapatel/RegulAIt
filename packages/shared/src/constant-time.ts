/**
 * ADR-0176 — THE constant-time comparison. One helper on the standard
 * library's `crypto.timingSafeEqual`, replacing five hand-rolled copies
 * (gateway auth, data-key fingerprints, the PM webhook secret check, the
 * ChatOps signature check and the PM-provider inbound verifiers).
 *
 * Length-safe: `timingSafeEqual` throws on inputs of different lengths, and
 * the copies handled that with an early `length !==` return, which tells a
 * caller the length of the secret it is probing. Both inputs are first hashed
 * with SHA-256, so the compare always runs over 32 bytes, never throws, and
 * leaks neither content nor length through its timing. Strings are compared
 * as their UTF-8 bytes.
 *
 * Nothing else in the repository may call `timingSafeEqual` directly; an
 * inventory test (`constant-time.test.ts`) fails on a new copy.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}
