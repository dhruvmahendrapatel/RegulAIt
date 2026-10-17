/**
 * ADR-0195 SD0 — the scanner contract, without a database: the production
 * registry is empty, the observation checks hold a scanner to its source
 * kind (evidence and subject kinds, bounds, an 8-character key fragment), and
 * the rate-limit and back-off helpers behave.
 */
import { describe, expect, it } from "vitest";
import { DISCOVERY_SCANNERS, noopTestScanner, scannerRegistry } from "./discovery-scanners.js";
import { checkObservations, checkReadOutcomes, ObservationRefused, retryAfterMs, scrubRunText, spacingRateLimiter } from "./discovery-worker.js";

const NOW = "2026-10-17T00:00:00.000Z";

describe("ADR-0195 SD0 scanner contract", () => {
  it("registers exactly the SD1 repo scanners, and a registry refuses two scanners for one kind", () => {
    expect([...DISCOVERY_SCANNERS.keys()].sort()).toEqual(["repo_azure_devops", "repo_bitbucket", "repo_github", "repo_gitlab"]);
    expect(() => scannerRegistry([noopTestScanner("repo_github"), noopTestScanner("repo_github")])).toThrow(/duplicate/);
  });

  it("refuses an evidence or subject kind the source kind does not report", () => {
    expect(() => checkObservations("repo_github", [{ evidenceKind: "cloud_inventory", subjectKind: "repo", subject: "r" }], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("repo_github", [{ evidenceKind: "repo_scan", subjectKind: "device", subject: "r" }], NOW)).toThrow(ObservationRefused);
    const psn = `psn:${"0a".repeat(12)}`;
    expect(() => checkObservations("cloud_aws", [{ evidenceKind: "cloud_audit_log", subjectKind: "cloud_principal", subject: psn }], NOW)).not.toThrow();
    // decision 20: a principal or a device is named only by its pseudonym
    expect(() => checkObservations("cloud_aws", [{ evidenceKind: "cloud_audit_log", subjectKind: "cloud_principal", subject: "arn:aws:iam::000000000000:user/jane" }], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("endpoint_agent", [{ evidenceKind: "endpoint_agent", subjectKind: "device", subject: "janes-laptop" }], NOW)).toThrow(ObservationRefused);
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
      checkObservations("endpoint_agent", [{ evidenceKind: "endpoint_agent", subjectKind: "device", subject: `psn:${"0b".repeat(12)}`, artifact: { kind: "nope" as never, value: "x" } }], NOW),
    ).toThrow(ObservationRefused);
  });

  it("sighting location, names and actor: normalised, bounded, names never values, actor a pseudonym", () => {
    const base = { evidenceKind: "repo_scan" as const, subjectKind: "repo" as const, subject: "r" };
    const [o] = checkObservations("repo_github", [{ ...base, location: { path: ".\\src\\a.ts", line: 4, commit: "0123abc" }, names: ["OPENAI_API_KEY"] }], NOW);
    expect(o!.location).toEqual({ path: "src/a.ts", line: 4, commit: "0123abc" });
    expect(o!.names).toEqual(["OPENAI_API_KEY"]);
    expect(() => checkObservations("repo_github", [{ ...base, location: { path: "a/../../etc/passwd" } }], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("repo_github", [{ ...base, location: { path: "a", commit: "zz" } }], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("repo_github", [{ ...base, names: ["OPENAI_API_KEY=abc123"] }], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("repo_github", [{ ...base, actorPseudonym: "jane@example.com" }], NOW)).toThrow(ObservationRefused);
    expect(checkObservations("repo_github", [{ ...base, actorPseudonym: `psn:${"cd".repeat(12)}` }], NOW)[0]!.actorPseudonym).toBe(`psn:${"cd".repeat(12)}`);
  });

  it("scrubs the run's secret, URL query strings and credential shapes from stored text, and caps it", () => {
    const secret = "sd0-unit-" + "q7".repeat(16);
    const out = scrubRunText(`denied for ${secret} at https://h.example.test/a/b?token=${secret}&x=1 then ${JSON.stringify(secret)}`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("token=");
    expect(out).toContain("https://h.example.test/a/b?[redacted]");
    expect(scrubRunText("x".repeat(5000), []).length).toBe(1000);
    const reads = checkReadOutcomes([{ read: "trail", status: "not_enabled", detail: `see https://x.example.test/?sig=${secret}` }], [secret]);
    expect(JSON.stringify(reads)).not.toContain(secret);
    expect(() => checkReadOutcomes([{ read: "x", status: "bogus" as never }], [])).toThrow(ObservationRefused);
    expect(checkReadOutcomes(undefined, [])).toEqual([]);
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
