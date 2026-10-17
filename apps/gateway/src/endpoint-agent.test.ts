/**
 * ADR-0195 SD4b — the endpoint agent contract without a database: SD4a's
 * golden bodies parse, the bounds refuse, the report signature verifies only
 * under the bound key with the recomputed digest (runtime-generated keys), a
 * stale signature or snapshot is refused, and an environment-variable name never
 * survives the reduction (data minimisation, master decision).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type { AiSignature } from "@regulait/shared";
import {
  contentDigestOf,
  ENDPOINT_AGENT_TOKEN_ROUTES,
  ENDPOINT_REPORT_MAX_FACTS,
  ENDPOINT_REPORT_SIGNATURE_TYP,
  extensionEcosystemOf,
  isUuidV4,
  reduceReportFacts,
  registerRequestSchema,
  reportFresh,
  reportSchema,
  ticketRequestSchema,
  verifyReportSignature,
  type EndpointFact,
  type EndpointReport,
} from "./endpoint-agent.js";

const golden = (name: string) =>
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../agents/endpoint/internal/contract/testdata", name), "utf8");

const ISSUER = "https://gateway.example.test";
const AUD = `${ISSUER}/v1/endpoint-agent/reports`;
const NOW = new Date("2026-10-17T12:00:00Z");
const SNAPSHOT = "6f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b";

async function deviceKey() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = (await exportJWK(publicKey)) as Record<string, string>;
  const thumbprint = await calculateJwkThumbprint(jwk as JWK, "sha256");
  return { privateKey, jwk, thumbprint };
}

type Key = Awaited<ReturnType<typeof deviceKey>>;

async function sign(key: Key, body: Uint8Array, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const iat = Math.floor(NOW.getTime() / 1000);
  return new SignJWT({ snapshotId: SNAPSHOT, contentDigest: contentDigestOf(body), ...over })
    .setProtectedHeader({ alg: "ES256", typ: ENDPOINT_REPORT_SIGNATURE_TYP, kid: key.thumbprint, ...header })
    .setIssuer(`urn:ietf:params:oauth:jwk-thumbprint:sha-256:${key.thumbprint}`)
    .setAudience(AUD)
    .setIssuedAt(typeof over.iat === "number" ? over.iat : iat)
    .setJti(typeof over.jti === "string" ? over.jti : `jti-${Math.random()}`)
    .sign(key.privateKey);
}

const check = (key: Key, body: Uint8Array, signature: string | undefined, digestHeader: string | undefined = contentDigestOf(body)) =>
  verifyReportSignature({ signature, contentDigestHeader: digestHeader, rawBody: body, publicJwk: key.jwk, thumbprint: key.thumbprint, audience: AUD, snapshotId: SNAPSHOT, now: NOW });

const sig = (kind: AiSignature["kind"], value: string, provider = "example", extra: Partial<AiSignature> = {}): AiSignature =>
  ({ provider, kind, value, matchType: "identifier", minLength: null, replacementAgentId: null, replacementNote: null, provenance: "regulait-seed", enabled: true, os: null, ecosystem: null, toolId: null, note: null, confidence: "high", ...extra }) as AiSignature;

const fact = (f: Partial<EndpointFact>): EndpointFact => ({
  kind: "desktop_app",
  signatureId: "sig.example",
  provider: "example",
  matchedOn: "bundleId",
  identifier: "com.example.app",
  location: { root: "system_applications", path: "Example.app" },
  ...f,
});

describe("ADR-0195 SD4b: the SD4a wire contract", () => {
  it("parses SD4a's golden ticket, registration and report bodies", () => {
    expect(ticketRequestSchema.safeParse(JSON.parse(golden("ticket-request.json"))).success).toBe(true);
    expect(registerRequestSchema.safeParse(JSON.parse(golden("register-request.json"))).success).toBe(true);
    const report = reportSchema.safeParse(JSON.parse(golden("report.json")));
    expect(report.success).toBe(true);
    expect(isUuidV4(report.data!.snapshotId)).toBe(true);
  });

  it("refuses unknown members, a private key member and inconsistent key protection", () => {
    const reg = JSON.parse(golden("register-request.json"));
    expect(registerRequestSchema.safeParse({ ...reg, extra: 1 }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...reg, publicJwk: { ...reg.publicJwk, d: "AAAA" } }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...reg, keyProtection: "hardware" }).success).toBe(false);
    const { keyFallbackReason: _, ...noReason } = reg;
    expect(registerRequestSchema.safeParse(noReason).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...reg, keyProtection: "hardware", keyProvider: "tpm", keyFallbackReason: undefined }).success).toBe(true);
    expect(ticketRequestSchema.safeParse({ ...JSON.parse(golden("ticket-request.json")), hostname: "ws\u0000x" }).success).toBe(false);
  });

  it("bounds a report: facts, gaps, keys, identifier length and schema", () => {
    const base = JSON.parse(golden("report.json")) as EndpointReport;
    const many = Array.from({ length: ENDPOINT_REPORT_MAX_FACTS + 1 }, () => base.facts[0]!);
    expect(reportSchema.safeParse({ ...base, facts: many }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, gaps: Array.from({ length: 201 }, () => base.gaps[0]) }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, facts: [{ ...base.facts[0], identifier: "x".repeat(513) }] }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, facts: [{ ...base.facts[0], keys: Array.from({ length: 51 }, () => base.facts[0]!.keys![0]) }] }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, schema: "regulait.endpoint-report/2" }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, facts: [{ ...base.facts[0], kind: "keystrokes" }] }).success).toBe(false);
  });

  it("confines the agent's token to its three routes", () => {
    expect([...ENDPOINT_AGENT_TOKEN_ROUTES].sort()).toEqual(["GET /v1/endpoint-agent/config", "POST /v1/endpoint-agent/credentials", "POST /v1/endpoint-agent/reports"]);
  });
});

describe("ADR-0195 SD4b: the report signature (runtime-generated keys)", () => {
  const body = new TextEncoder().encode(golden("report.json"));

  it("accepts a signature by the bound key over the recomputed digest", async () => {
    const key = await deviceKey();
    const out = await check(key, body, await sign(key, body));
    expect(out.ok).toBe(true);
  });

  it("refuses another device's key, a missing signature and a wrong kid", async () => {
    const key = await deviceKey();
    const other = await deviceKey();
    expect(await check(key, body, await sign(other, body))).toEqual({ ok: false, code: "invalid_report_signature" });
    expect(await check(key, body, undefined)).toEqual({ ok: false, code: "invalid_report_signature" });
    expect(await check(key, body, await sign(key, body, {}, { kid: other.thumbprint }))).toEqual({ ok: false, code: "invalid_report_signature" });
  });

  it("refuses a body that differs from the digest, in the header or in the signature", async () => {
    const key = await deviceKey();
    const tampered = new TextEncoder().encode(golden("report.json").replace("hardware", "software"));
    // the header names the original body's digest: refused before any signature check
    expect(await check(key, tampered, await sign(key, body), contentDigestOf(body))).toEqual({ ok: false, code: "content_digest_mismatch" });
    // the header was recomputed for the tampered body, the signature still covers the original
    expect(await check(key, tampered, await sign(key, body))).toEqual({ ok: false, code: "invalid_report_signature" });
  });

  it("refuses another snapshot id, a stale and a future signature", async () => {
    const key = await deviceKey();
    const nowS = Math.floor(NOW.getTime() / 1000);
    expect(await check(key, body, await sign(key, body, { snapshotId: "00000000-0000-4000-8000-000000000001" }))).toEqual({ ok: false, code: "invalid_report_signature" });
    expect(await check(key, body, await sign(key, body, { iat: nowS - 301 }))).toEqual({ ok: false, code: "report_signature_stale" });
    expect(await check(key, body, await sign(key, body, { iat: nowS + 60 }))).toEqual({ ok: false, code: "report_signature_stale" });
  });

  it("refuses a signature that embeds its own key or uses another typ", async () => {
    const key = await deviceKey();
    expect(await check(key, body, await sign(key, body, {}, { jwk: key.jwk }))).toEqual({ ok: false, code: "invalid_report_signature" });
    expect(await check(key, body, await sign(key, body, {}, { typ: "dpop+jwt" }))).toEqual({ ok: false, code: "invalid_report_signature" });
  });

  it("refuses a snapshot collected more than a day ago or in the future", () => {
    expect(reportFresh("2026-10-17T11:00:00Z", NOW)).toBe(true);
    expect(reportFresh("2026-10-16T11:59:00Z", NOW)).toBe(false);
    expect(reportFresh("2026-10-17T12:10:00Z", NOW)).toBe(false);
  });
});

describe("ADR-0195 SD4b: facts become catalogue sightings only", () => {
  const catalogue = [
    sig("desktop_app", "com.example.app"),
    sig("local_runtime", "port:11434", "runtime"),
    sig("assistant_config", ".config/example/*.json"),
    sig("assistant_config", "EXAMPLE_API_KEY", "envprovider"),
    sig("ide_extension", "example.assistant", "example", { ecosystem: "vscode" }),
  ];

  it("matches the golden report's config and port facts against the enabled catalogue", () => {
    const report = reportSchema.parse(JSON.parse(golden("report.json")));
    const out = reduceReportFacts(report, catalogue);
    expect(out.sightings.map((s) => `${s.kind}:${s.value}`).sort()).toEqual(["assistant_config:.config/example/*.json", "local_runtime:port:11434"]);
    // the config fact carried a key name: it is never part of a sighting
    expect(JSON.stringify(out)).not.toContain("EXAMPLE_API_KEY");
  });

  it("refuses env_name facts, so an environment-variable name is never kept, even when the catalogue knows it", () => {
    const report = { os: "linux" as const, collectedAt: NOW.toISOString(), facts: [fact({ kind: "env_name", matchedOn: "envName", identifier: "EXAMPLE_API_KEY", location: { root: "home", path: ".profile" } })] };
    const out = reduceReportFacts(report, catalogue);
    expect(out).toEqual({ sightings: [], envRefused: 1, unmatched: 0 });
    expect(JSON.stringify(out)).not.toContain("EXAMPLE_API_KEY");
  });

  it("drops a fact no enabled row matches and keeps no path", () => {
    const report = { os: "linux" as const, collectedAt: NOW.toISOString(), facts: [fact({ identifier: "com.unknown.thing", location: { root: "home", path: ".local/share/applications/secret-name" } })] };
    const out = reduceReportFacts(report, catalogue);
    expect(out.sightings).toEqual([]);
    expect(out.unmatched).toBe(1);
    expect(JSON.stringify(out)).not.toContain("secret-name");
  });

  it("refuses a port fact whose identifier is not its port", () => {
    const report = { os: "linux" as const, collectedAt: NOW.toISOString(), facts: [fact({ kind: "local_runtime", matchedOn: "port", identifier: "11434", port: 8080, location: { root: "process_table", path: "" } })] };
    expect(reduceReportFacts(report, catalogue).sightings).toEqual([]);
  });

  it("reads the extension ecosystem from the location so ecosystem-scoped rows match", () => {
    const ext = fact({ kind: "ide_extension", matchedOn: "extensionId", identifier: "example.assistant", location: { root: "home", path: ".vscode/extensions/example.assistant-1.0.0" } });
    expect(extensionEcosystemOf(ext)).toBe("vscode");
    expect(reduceReportFacts({ os: "linux", collectedAt: NOW.toISOString(), facts: [ext] }, catalogue).sightings).toEqual([
      { kind: "ide_extension", value: "example.assistant", provider: "example", os: "linux", ecosystem: "vscode", count: 1 },
    ]);
    expect(extensionEcosystemOf(fact({ kind: "browser_extension", location: { root: "home", path: ".mozilla/firefox/x.default/extensions.json" } }))).toBe("firefox");
    expect(extensionEcosystemOf(fact({ kind: "browser_extension", location: { root: "home", path: ".config/google-chrome/Default/Extensions/abc" } }))).toBe("chrome");
  });
});
