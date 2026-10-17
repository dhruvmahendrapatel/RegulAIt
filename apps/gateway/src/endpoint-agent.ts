/**
 * ADR-0195 SD4b — THE ENDPOINT AGENT'S GATEWAY CONTRACT: the route set, the
 * bounds, the request schemas, the report-signature check and the mapping of a
 * report's facts onto SD3's catalogue matcher. No route is registered here
 * (`endpoint-agent-routes.ts`); the auth plumbing imports the route set and the
 * device check from this module, so it imports nothing of the auth hooks.
 *
 * The wire contract is SD4a's (`agents/endpoint/internal/contract`, ADR-0195
 * "As built: SD4a", "Gateway ingest contract"): this module accepts what
 * `internal/gatewaytest` accepts and refuses what it refuses.
 *
 * DATA MINIMISATION (master decision, 2026-10-17). An `env_name` fact names an
 * environment variable. Environment-variable names and values are never
 * stored, logged or echoed: PR #419's presence matcher (which maps a name to a
 * presence signature id) is not on main, so an `env_name` fact is REFUSED here
 * and only counted (`facts_env_refused`), and a key name inside any other fact
 * is dropped (only the matched catalogue value of a sighting is kept). Every
 * refusal is a fixed code; no refusal echoes what the device sent.
 *
 * Open source first (ADR-0176): `jose` verifies the report JWS (ES256 only)
 * and computes RFC 7638 thumbprints; `zod` validates the bodies. The RFC 9530
 * `Content-Digest` value is one SHA-256 (node:crypto) in the structured-field
 * byte-sequence form; no maintained module covers just that member.
 */
import { createHash } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { z } from "zod";
import { and, discoverySources, endpointAgentIdentities, endpointDevices, eq, type Db, type EndpointAgentSighting } from "@regulait/db";
import {
  JWK_THUMBPRINT_URI_PREFIX,
  reduceEndpointObservations,
  type AiSignature,
  type EndpointExtensionEcosystem,
  type EndpointMatchType,
  type EndpointObservation,
  type EndpointObservationKey,
} from "@regulait/shared";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const ENDPOINT_AGENT_PATHS = {
  tickets: "/v1/endpoint-agent/enrolment-tickets",
  register: "/v1/endpoint-agent/register",
  credentials: "/v1/endpoint-agent/credentials",
  config: "/v1/endpoint-agent/config",
  reports: "/v1/endpoint-agent/reports",
} as const;

/** the routes an endpoint agent's self token reaches, and nothing else (`via: "endpoint-agent"`) */
export const ENDPOINT_AGENT_TOKEN_ROUTES: ReadonlySet<string> = new Set([
  `GET ${ENDPOINT_AGENT_PATHS.config}`,
  `POST ${ENDPOINT_AGENT_PATHS.reports}`,
  `POST ${ENDPOINT_AGENT_PATHS.credentials}`,
]);

/** the two routes that take no access token: a bulk enrolment token, then a device ticket, checked in-route */
export const ENDPOINT_AGENT_ENROLMENT_PATHS = [ENDPOINT_AGENT_PATHS.tickets, ENDPOINT_AGENT_PATHS.register] as const;

// ---------------------------------------------------------------------------
// Bounds and defaults (secure by default, ADR-0180: every one is the strict value; none is a setting)
// ---------------------------------------------------------------------------

/** the bulk enrolment token's prefix; the device ticket's */
export const ENDPOINT_BULK_TOKEN_PREFIX = "rgea_";
export const ENDPOINT_TICKET_PREFIX = "rgat_";
/** owner decision: expiry defaults to 30 days; it is also the maximum (lengthening is not offered) */
export const ENDPOINT_TOKEN_MAX_DAYS = 30;
/** the admin must set the device cap: there is no unlimited default */
export const ENDPOINT_TOKEN_MAX_DEVICES = 100_000;
/** R15 §3.2: a device ticket lives 7 days and admits 8 identities (users) of its device */
export const ENDPOINT_TICKET_TTL_DAYS = 7;
export const ENDPOINT_TICKET_IDENTITY_CAP = 8;
/** R15 cap alerting: the admin is alerted at these shares of a token's device cap */
export const ENDPOINT_CAP_ALERT_FRACTIONS = [0.8, 1] as const;

/** one report's body, facts, gaps and per-fact keys */
export const ENDPOINT_REPORT_MAX_BYTES = 1_048_576;
export const ENDPOINT_REPORT_MAX_FACTS = 2_000;
export const ENDPOINT_REPORT_MAX_GAPS = 200;
export const ENDPOINT_FACT_MAX_KEYS = 50;
/** the report signature is fresh for 5 minutes (at most 5 s ahead), like a client assertion */
export const ENDPOINT_REPORT_SIGNATURE_MAX_AGE_SECONDS = 300;
export const ENDPOINT_REPORT_SIGNATURE_MAX_FUTURE_SECONDS = 5;
/** a snapshot collected more than a day ago is stale (SD4a keeps no buffer: an undelivered one is dropped and counted) */
export const ENDPOINT_REPORT_MAX_AGE_SECONDS = 24 * 3600;
export const ENDPOINT_REPORT_MAX_FUTURE_SECONDS = 300;
/** at most this many pending reports are committed by one discovery run */
export const ENDPOINT_REPORTS_PER_RUN = 200;

export const ENDPOINT_REPORT_SCHEMA = "regulait.endpoint-report/1";
export const ENDPOINT_ENROL_FILE_SCHEMA = "regulait.endpoint-enrol/1";
export const ENDPOINT_REPORT_SIGNATURE_TYP = "regulait-endpoint-report+jwt";
export const ENDPOINT_REPORT_SIGNATURE_HEADER = "regulait-report-signature";
export const CONTENT_DIGEST_HEADER = "content-digest";

// ---------------------------------------------------------------------------
// Bodies (strict: an unknown member is refused, as the SD4a fake refuses it)
// ---------------------------------------------------------------------------

const OSES = ["linux", "darwin", "windows"] as const;
const ARCHES = ["amd64", "arm64"] as const;
const version = z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** printable, no control character; a name sent only to be keyed-hashed (never echoed) */
const displayName = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => [...s].every((c) => c >= " " && c !== "\u007f"), { message: "printable" });

export const ticketRequestSchema = z
  .object({ hostname: displayName(253), os: z.enum(OSES), arch: z.enum(ARCHES), agentVersion: version })
  .strict();

export const KEY_PROVIDERS = ["tpm", "tpm_ncrypt", "secure_enclave", "file", "dpapi"] as const;
const HARDWARE_PROVIDERS: ReadonlySet<string> = new Set(["tpm", "tpm_ncrypt", "secure_enclave"]);
const b64url = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const registerRequestSchema = z
  .object({
    publicJwk: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: b64url, y: b64url }).strict(),
    keyProtection: z.enum(["hardware", "software"]),
    keyProvider: z.enum(KEY_PROVIDERS),
    // why no hardware key was used: required with a software key, never stored (it can name a device path)
    keyFallbackReason: z.string().min(1).max(500).optional(),
    agentVersion: version,
    os: z.enum(OSES),
    arch: z.enum(ARCHES),
    deviceUser: displayName(256),
  })
  .strict()
  .refine((r) => (r.keyProtection === "hardware") === HARDWARE_PROVIDERS.has(r.keyProvider), { message: "protection and provider disagree" })
  .refine((r) => r.keyProtection === "hardware" || r.keyFallbackReason !== undefined, { message: "a software key states why" });
export type EndpointRegisterRequest = z.infer<typeof registerRequestSchema>;

export const rotateRequestSchema = z
  .object({
    publicJwk: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: b64url, y: b64url }).strict(),
    proof: z.string().min(1).max(16_384),
  })
  .strict();

export const FACT_KINDS = ["desktop_app", "ide_extension", "browser_extension", "local_runtime", "assistant_config", "cli", "env_name"] as const;
const ROOTS = ["home", "system_applications", "appdata", "localappdata", "path", "registry", "process_table"] as const;
const MATCHED_ON = ["bundleId", "desktopId", "uninstallName", "extensionId", "processName", "port", "processName+port", "file", "executable", "envName"] as const;
type MatchedOn = (typeof MATCHED_ON)[number];

const factSchema = z
  .object({
    kind: z.enum(FACT_KINDS),
    signatureId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    provider: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
    matchedOn: z.enum(MATCHED_ON),
    identifier: z.string().min(1).max(512),
    location: z.object({ root: z.enum(ROOTS), path: z.string().max(1024) }).strict(),
    version: z.string().max(64).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    portOnly: z.boolean().optional(),
    keys: z
      .array(z.object({ keyName: z.string().min(1).max(128), ruleId: z.string().max(64).optional(), present: z.boolean() }).strict())
      .max(ENDPOINT_FACT_MAX_KEYS)
      .optional(),
  })
  .strict();
export type EndpointFact = z.infer<typeof factSchema>;

export const reportSchema = z
  .object({
    schema: z.literal(ENDPOINT_REPORT_SCHEMA),
    snapshotId: z.string().uuid(),
    collectedAt: z.string().datetime({ offset: false }),
    agentVersion: version,
    os: z.enum(OSES),
    arch: z.enum(ARCHES),
    manifestVersion: version,
    manifestDigest: hex64,
    keyProtection: z.enum(["hardware", "software"]),
    droppedSnapshots: z.number().int().min(0).max(1_000_000),
    facts: z.array(factSchema).max(ENDPOINT_REPORT_MAX_FACTS),
    gaps: z
      .array(z.object({ kind: z.enum(FACT_KINDS), reason: z.string().regex(/^[a-z0-9_]{1,64}$/) }).strict())
      .max(ENDPOINT_REPORT_MAX_GAPS),
    factsDigest: hex64,
  })
  .strict();
export type EndpointReport = z.infer<typeof reportSchema>;

/** SD4a's snapshot id is a UUID v4 */
export const isUuidV4 = (s: string) => s.length === 36 && s[14] === "4" && "89ab".includes(s[19]!.toLowerCase());

// ---------------------------------------------------------------------------
// The report signature (SD4a: DPoP covers the method, URL and token, not the body)
// ---------------------------------------------------------------------------

/** the RFC 9530 `Content-Digest` value of `body`: `sha-256=:<base64>:` */
export function contentDigestOf(body: Uint8Array): string {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

export type ReportSignatureCheck = { ok: true; jti: string; iat: number } | { ok: false; code: "invalid_report_signature" | "report_signature_stale" | "content_digest_mismatch" };

/**
 * Verify `Regulait-Report-Signature`: a compact JWS by the identity's bound
 * device key (ES256 only, `typ` regulait-endpoint-report+jwt, `kid` its RFC
 * 7638 thumbprint), claims `iss` = the key's RFC 9278 client id, `aud` the
 * reports URL, a fresh `iat`, a `jti`, `snapshotId` = the body's and
 * `contentDigest` = the digest this gateway recomputed over the raw body (which
 * must also equal the `Content-Digest` header). The caller claims the `jti`.
 */
export async function verifyReportSignature(input: {
  signature: string | undefined;
  contentDigestHeader: string | undefined;
  rawBody: Uint8Array;
  publicJwk: Record<string, string>;
  thumbprint: string;
  audience: string;
  snapshotId: string;
  now: Date;
}): Promise<ReportSignatureCheck> {
  const digest = contentDigestOf(input.rawBody);
  if (input.contentDigestHeader !== digest) return { ok: false, code: "content_digest_mismatch" };
  const jws = input.signature;
  if (typeof jws !== "string" || jws.length === 0 || jws.length > 16_384) return { ok: false, code: "invalid_report_signature" };
  try {
    const h = decodeProtectedHeader(jws);
    if (h.alg !== "ES256" || h.kid !== input.thumbprint || h.jwk !== undefined) return { ok: false, code: "invalid_report_signature" };
    const key = await importJWK({ kty: "EC", crv: "P-256", x: input.publicJwk.x!, y: input.publicJwk.y! } as JWK, "ES256");
    const { payload } = await jwtVerify(jws, key, {
      algorithms: ["ES256"],
      typ: ENDPOINT_REPORT_SIGNATURE_TYP,
      audience: input.audience,
      issuer: `${JWK_THUMBPRINT_URI_PREFIX}${input.thumbprint}`,
      currentDate: input.now,
      requiredClaims: ["iat", "jti"],
    });
    const nowS = Math.floor(input.now.getTime() / 1000);
    if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 200) return { ok: false, code: "invalid_report_signature" };
    if (payload.snapshotId !== input.snapshotId || payload.contentDigest !== digest) return { ok: false, code: "invalid_report_signature" };
    const iat = payload.iat!;
    if (iat < nowS - ENDPOINT_REPORT_SIGNATURE_MAX_AGE_SECONDS || iat > nowS + ENDPOINT_REPORT_SIGNATURE_MAX_FUTURE_SECONDS) {
      return { ok: false, code: "report_signature_stale" };
    }
    return { ok: true, jti: payload.jti, iat };
  } catch {
    return { ok: false, code: "invalid_report_signature" };
  }
}

/** is `collectedAt` inside the freshness window? */
export function reportFresh(collectedAt: string, now: Date): boolean {
  const t = Date.parse(collectedAt);
  if (!Number.isFinite(t)) return false;
  return t >= now.getTime() - ENDPOINT_REPORT_MAX_AGE_SECONDS * 1000 && t <= now.getTime() + ENDPOINT_REPORT_MAX_FUTURE_SECONDS * 1000;
}

// ---------------------------------------------------------------------------
// Facts -> SD3's catalogue matcher
// ---------------------------------------------------------------------------

/** which SD3 match type a fact's `matchedOn` is (`envName` has none: it is refused, see the module comment) */
const MATCH_TYPE_OF: Readonly<Record<Exclude<MatchedOn, "envName">, EndpointMatchType>> = {
  bundleId: "bundle_id",
  desktopId: "app_name",
  uninstallName: "app_name",
  extensionId: "ide_extension_id",
  processName: "process_name",
  port: "listening_port",
  "processName+port": "process_name",
  file: "config_path",
  executable: "cli_binary",
};

/**
 * The extension ecosystem of a fact, read from its root-relative location only
 * (the path itself is never kept). SD0's catalogue scopes extension rows to an
 * ecosystem; without one, only ecosystem-neutral rows can match.
 */
export function extensionEcosystemOf(fact: Pick<EndpointFact, "kind" | "location">): EndpointExtensionEcosystem | undefined {
  const p = fact.location.path.toLowerCase();
  if (fact.kind === "browser_extension") {
    if (p.endsWith("/extensions.json") || p === "extensions.json") return "firefox";
    if (p.includes("/extensions/")) return p.includes("edge") ? "edge" : "chrome";
    return undefined;
  }
  if (fact.kind === "ide_extension") {
    if (p.includes("jetbrains")) return "jetbrains";
    if (p.includes("/extensions/")) return "vscode";
  }
  return undefined;
}

export interface FactReduction {
  /** one sighting per catalogue value the enabled catalogue matched (catalogue values only) */
  sightings: EndpointAgentSighting[];
  /** `env_name` facts: refused, counted, never kept */
  envRefused: number;
  /** facts no enabled catalogue row matched (dropped: a manifest is built from the catalogue) */
  unmatched: number;
}

const NO_DEVICE = "device";

/**
 * Reduce a report's facts to catalogue sightings with SD3's own matcher
 * (`reduceEndpointObservations`, detection is data). Only the matched
 * catalogue value, its provider, the OS, the ecosystem and a count survive.
 */
export function reduceReportFacts(report: Pick<EndpointReport, "facts" | "os" | "collectedAt">, catalogue: readonly AiSignature[]): FactReduction {
  let envRefused = 0;
  const observations: EndpointObservation[] = [];
  for (const [i, f] of report.facts.entries()) {
    if (f.kind === "env_name" || f.matchedOn === "envName") {
      envRefused += 1;
      continue;
    }
    const keys: EndpointObservationKey[] = [];
    const ecosystem = f.matchedOn === "extensionId" ? extensionEcosystemOf(f) : undefined;
    const matchType = f.matchedOn === "extensionId" && f.kind === "browser_extension" ? "browser_extension_id" : MATCH_TYPE_OF[f.matchedOn];
    if (matchType === "listening_port") {
      if (f.port === undefined || String(f.port) !== f.identifier) continue;
      keys.push({ matchType, value: String(f.port) });
    } else {
      keys.push({ matchType: matchType as EndpointObservationKey["matchType"], value: f.identifier, ...(ecosystem ? { ecosystem } : {}) });
      if (f.matchedOn === "processName+port" && f.port !== undefined) keys.push({ matchType: "listening_port", value: String(f.port) });
    }
    // SD3's observation shape; `source`, `line` and `query` are not read by the matcher
    observations.push({
      source: "endpoint_inventory",
      line: i + 1,
      query: null,
      kindHint: null,
      device: NO_DEVICE,
      user: null,
      os: report.os,
      observedAt: report.collectedAt,
      keys,
      traits: [],
      location: null,
      version: null,
      info: {},
    });
  }
  const reduction = reduceEndpointObservations({ observations }, catalogue, { unmatchedSample: 0 });
  const sightings = reduction.matched.map((m) => ({ kind: m.kind, value: m.value, provider: m.provider, os: m.os, ecosystem: m.ecosystem, count: m.count }));
  return { sightings, envRefused, unmatched: reduction.unmatchedCount };
}

// ---------------------------------------------------------------------------
// The device behind an identity
// ---------------------------------------------------------------------------

export interface EndpointAgentContext {
  identityId: string;
  deviceId: string;
  sourceId: string;
  devicePseudonym: string;
  deviceUserPseudonym: string;
  os: string;
  arch: string;
  sourceEnabled: boolean;
}

/**
 * The live device of an endpoint agent identity, or `device_revoked` when the
 * identity has no device row, its device was revoked, or the device's source
 * was deleted. Read on every use (token mint, every token route).
 */
export async function endpointAgentContext(db: Db, identityId: string): Promise<{ ok: true; ctx: EndpointAgentContext } | { ok: false; code: "device_revoked" }> {
  const [row] = await db
    .select({
      deviceId: endpointDevices.id,
      sourceId: endpointDevices.sourceId,
      devicePseudonym: endpointDevices.devicePseudonym,
      deviceUserPseudonym: endpointAgentIdentities.deviceUserPseudonym,
      os: endpointDevices.os,
      arch: endpointDevices.arch,
      revokedAt: endpointDevices.revokedAt,
      sourceEnabled: discoverySources.enabled,
      sourceKind: discoverySources.kind,
    })
    .from(endpointAgentIdentities)
    .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
    .innerJoin(discoverySources, and(eq(discoverySources.id, endpointDevices.sourceId))!)
    .where(eq(endpointAgentIdentities.identityId, identityId));
  if (!row || row.revokedAt !== null || row.sourceKind !== "endpoint_agent") return { ok: false, code: "device_revoked" };
  return {
    ok: true,
    ctx: {
      identityId,
      deviceId: row.deviceId,
      sourceId: row.sourceId,
      devicePseudonym: row.devicePseudonym,
      deviceUserPseudonym: row.deviceUserPseudonym,
      os: row.os,
      arch: row.arch,
      sourceEnabled: row.sourceEnabled,
    },
  };
}
