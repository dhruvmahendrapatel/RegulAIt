/**
 * ADR-0195 SD0 — the scanner contract, without a database: the production
 * registry is empty, the observation checks hold a scanner to its source
 * kind (evidence and subject kinds, bounds, an 8-character key fragment), and
 * the rate-limit and back-off helpers behave.
 */
import { describe, expect, it } from "vitest";
import { DISCOVERY_SCANNERS, noopTestScanner, scannerRegistry } from "./discovery-scanners.js";
import { checkObservations, ObservationRefused, retryAfterMs, spacingRateLimiter } from "./discovery-worker.js";

const NOW = "2026-10-17T00:00:00.000Z";

describe("ADR-0195 SD0 scanner contract", () => {
  it("ships no scanner in SD0, and a registry refuses two scanners for one kind", () => {
    expect(DISCOVERY_SCANNERS.size).toBe(0);
    expect(() => scannerRegistry([noopTestScanner("repo_github"), noopTestScanner("repo_github")])).toThrow(/duplicate/);
  });

  it("refuses an evidence or subject kind the source kind does not report", () => {
    expect(() => checkObservations("repo_github", [{ evidenceKind: "cloud_inventory", subjectKind: "repo", subject: "r" }], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("repo_github", [{ evidenceKind: "repo_scan", subjectKind: "device", subject: "r" }], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("cloud_aws", [{ evidenceKind: "cloud_audit_log", subjectKind: "cloud_principal", subject: "psn:x" }], NOW)).not.toThrow();
  });

  it("bounds subjects and values, and keeps only 8 characters of a key", () => {
    expect(() => checkObservations("repo_github", [{ evidenceKind: "repo_scan", subjectKind: "repo", subject: "" }], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("repo_github", [{ evidenceKind: "repo_scan", subjectKind: "repo", subject: "r", packageName: "x".repeat(600) }], NOW)).toThrow(ObservationRefused);
    const key = "sk-" + "z".repeat(45);
    const [o] = checkObservations("repo_github", [{ evidenceKind: "repo_scan", subjectKind: "repo", subject: "r", keyFragment: key, keyLength: key.length }], NOW);
    expect(o!.keyFragment).toBe(key.slice(0, 8));
    expect(o!.keyLength).toBe(key.length);
    expect(o!.observedAt).toBe(NOW);
    expect(() =>
      checkObservations("endpoint_agent", [{ evidenceKind: "endpoint_agent", subjectKind: "device", subject: "d", artifact: { kind: "nope" as never, value: "x" } }], NOW),
    ).toThrow(ObservationRefused);
  });

  it("reads Retry-After in seconds or as a date, bounded to 60 s", () => {
    const res = (v: string) => new Response(null, { status: 429, headers: { "retry-after": v } });
    expect(retryAfterMs(res("2"))).toBe(2000);
    expect(retryAfterMs(res("99999"))).toBe(60_000);
    expect(retryAfterMs(new Response(null, { status: 429 }))).toBeNull();
    const now = Date.parse("2026-10-17T00:00:00Z");
    expect(retryAfterMs(res("Sat, 17 Oct 2026 00:00:05 GMT"), now)).toBe(5000);
  });

  it("spaces one source's requests and leaves another source alone", async () => {
    const limiter = spacingRateLimiter(40);
    const signal = new AbortController().signal;
    const t0 = Date.now();
    await limiter.acquire("a", signal);
    await limiter.acquire("b", signal);
    expect(Date.now() - t0).toBeLessThan(35);
    await limiter.acquire("a", signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });
});
