/**
 * ADR-0173 batch 2b — AUTHENTICATING A TEAMS BOT FRAMEWORK ACTIVITY.
 *
 * The Bot Framework service calls a registered bot with `Authorization: Bearer
 * <JWT>`. The token is verified with `jose` (createRemoteJWKSet + jwtVerify);
 * nothing cryptographic is written here. What this file adds is the
 * deployment glue:
 *
 *  - WHERE THE KEYS COME FROM. The connection's OpenID metadata URL (default:
 *    the Bot Framework's published document) names the issuer and the JWKS
 *    URI. Both documents are fetched through the egress guard, adjudicated on
 *    every real request — an air-gapped deployment with no allow entry simply
 *    has no bot endpoint.
 *  - CACHING. The metadata is cached for a TTL; jose caches the key set and
 *    re-fetches it when a token names a key id it does not hold (bounded by a
 *    cooldown, so a flood of made-up key ids costs one fetch per cooldown, not
 *    one per request). If the refreshed key set still lacks the key, the
 *    metadata itself is re-read once (its JWKS URI may have moved).
 *  - THE CHECKS jose cannot know: audience = the connection's bot app id, the
 *    issuer the metadata names, RS256 only, an expiry (5 minutes of clock
 *    tolerance, the platform's own figure); the token's `serviceUrl` claim
 *    equals the activity's; a key that lists `endorsements` endorses the
 *    activity's channel.
 *
 * A failed check is a bare refusal code: no audit row and no database write
 * (the cheapness rule of every inbound ChatOps route), except the egress
 * guard's own row when a document is actually fetched.
 */
import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { Db } from "@regulait/db";
import { ConnectionEgressBlockedError, guardConnectionCall } from "./connection-egress.js";

/** the Bot Framework's published OpenID metadata (used when a connection names none) */
export const TEAMS_BOT_DEFAULT_OPENID_METADATA_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";

/** cache tuning, read from the environment when a key set is first built */
function tuning() {
  const seconds = (name: string, fallback: number) => {
    const raw = process.env[name];
    const n = raw !== undefined && /^\d{1,7}$/.test(raw) ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    /** how long the metadata document is trusted before it is re-read */
    metadataTtlMs: seconds("REGULAIT_TEAMS_BOT_METADATA_TTL_SECONDS", 24 * 3600) * 1000,
    /** how long the key set is used before it is re-fetched anyway */
    jwksMaxAgeMs: seconds("REGULAIT_TEAMS_BOT_JWKS_MAX_AGE_SECONDS", 3600) * 1000,
    /** the least time between two key-set fetches caused by an unknown key id */
    unknownKidCooldownMs: seconds("REGULAIT_TEAMS_BOT_JWKS_COOLDOWN_SECONDS", 30) * 1000,
  };
}

/** what a refusal is called; every one is answered 401 by the route */
export type BotAuthFailure =
  | "missing_token"
  | "openid_metadata_unavailable"
  | "bad_token"
  | "expired_token"
  | "wrong_audience"
  | "wrong_issuer"
  | "unknown_signing_key"
  | "service_url_mismatch"
  | "key_not_endorsed";

export type BotAuthResult = { ok: true; claims: JWTPayload } | { ok: false; code: BotAuthFailure };

interface KeySource {
  issuer: string;
  jwks: JWTVerifyGetKey & { jwks: () => { keys: Array<Record<string, unknown>> } | undefined };
  fetchedAt: number;
}

/** per database handle (one per app), per metadata URL */
const sources = new WeakMap<object, Map<string, KeySource | { failedAt: number }>>();

function guardedFetcher(db: Db, ctx: { connectorId: string; connectionName: string }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const guarded = await guardConnectionCall(db, {
      surface: "connector",
      baseUrl: url,
      userId: null,
      objectId: ctx.connectorId,
      label: `teams bot sign-in keys for '${ctx.connectionName}'`,
      detail: { chatopsConnection: ctx.connectionName, purpose: "teams-bot-openid" },
    });
    return guarded.fetchImpl(url, init);
  };
}

async function keySource(
  db: Db,
  metadataUrl: string,
  ctx: { connectorId: string; connectionName: string },
  opts: { reload?: boolean } = {},
): Promise<KeySource | null> {
  let perDb = sources.get(db as object);
  if (!perDb) sources.set(db as object, (perDb = new Map()));
  const t = tuning();
  const cached = perDb.get(metadataUrl);
  if (cached && !opts.reload) {
    if ("failedAt" in cached) {
      // a failed fetch is remembered for the cooldown: an unauthenticated
      // caller cannot make us re-fetch on every request
      if (Date.now() - cached.failedAt < t.unknownKidCooldownMs) return null;
    } else if (Date.now() - cached.fetchedAt < t.metadataTtlMs) {
      return cached;
    }
  }
  const fetcher = guardedFetcher(db, ctx);
  try {
    const res = await fetcher(metadataUrl, { method: "GET", headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(5_000) });
    if (res.status !== 200) throw new Error(`metadata answered ${res.status}`);
    const doc = (await res.json()) as Record<string, unknown>;
    const issuer = typeof doc.issuer === "string" && doc.issuer ? doc.issuer : null;
    const jwksUri = typeof doc.jwks_uri === "string" && doc.jwks_uri ? doc.jwks_uri : null;
    if (!issuer || !jwksUri) throw new Error("metadata names no issuer or jwks_uri");
    const jwks = createRemoteJWKSet(new URL(jwksUri), {
      cacheMaxAge: t.jwksMaxAgeMs,
      cooldownDuration: t.unknownKidCooldownMs,
      timeoutDuration: 5_000,
      [customFetch]: (url, init) => fetcher(url, init),
    }) as KeySource["jwks"];
    const source: KeySource = { issuer, jwks, fetchedAt: Date.now() };
    perDb.set(metadataUrl, source);
    return source;
  } catch (err) {
    // refused by the egress guard (audited there), unreachable, or not a
    // metadata document: the endpoint is unavailable until the next attempt
    if (!(err instanceof ConnectionEgressBlockedError) && !(err instanceof Error)) throw err;
    perDb.set(metadataUrl, { failedAt: Date.now() });
    return null;
  }
}

/**
 * Verify one inbound Bot Framework request. `activity` is the parsed body: the
 * token is bound to it through the `serviceUrl` claim and the key's
 * endorsements.
 */
export async function verifyTeamsBotToken(
  db: Db,
  input: {
    authorization: string | undefined;
    appId: string;
    metadataUrl: string | null;
    connectorId: string;
    connectionName: string;
    activity: { serviceUrl: string | null; channelId: string | null };
  },
): Promise<BotAuthResult> {
  const m = input.authorization ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(input.authorization) : null;
  if (!m) return { ok: false, code: "missing_token" };
  const token = m[1]!;
  const metadataUrl = input.metadataUrl ?? TEAMS_BOT_DEFAULT_OPENID_METADATA_URL;
  const ctx = { connectorId: input.connectorId, connectionName: input.connectionName };

  let source = await keySource(db, metadataUrl, ctx);
  if (!source) return { ok: false, code: "openid_metadata_unavailable" };
  const verify = (s: KeySource) =>
    jwtVerify(token, s.jwks, {
      issuer: s.issuer,
      audience: input.appId,
      algorithms: ["RS256"],
      clockTolerance: 300,
      requiredClaims: ["exp"],
    });
  let verified: Awaited<ReturnType<typeof verify>>;
  try {
    try {
      verified = await verify(source);
    } catch (err) {
      // jose already re-fetched the key set (cooldown permitting); a key that
      // is still unknown may mean the metadata moved its JWKS URI — re-read it
      // once, no more often than the cooldown allows
      if (!(err instanceof joseErrors.JWKSNoMatchingKey) || Date.now() - source.fetchedAt < tuning().unknownKidCooldownMs) throw err;
      const fresh = await keySource(db, metadataUrl, ctx, { reload: true });
      if (!fresh) return { ok: false, code: "openid_metadata_unavailable" };
      source = fresh;
      verified = await verify(source);
    }
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return { ok: false, code: "expired_token" };
    if (err instanceof joseErrors.JWKSNoMatchingKey) return { ok: false, code: "unknown_signing_key" };
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      if (err.claim === "aud") return { ok: false, code: "wrong_audience" };
      if (err.claim === "iss") return { ok: false, code: "wrong_issuer" };
      return { ok: false, code: "bad_token" };
    }
    if (err instanceof joseErrors.JOSEError) return { ok: false, code: "bad_token" };
    if (err instanceof Error) return { ok: false, code: "openid_metadata_unavailable" };
    throw err;
  }
  const claims = verified.payload;
  // the token names the service that sent the activity; a token minted for
  // one service is not accepted on an activity claiming another
  if (typeof claims.serviceUrl !== "string" || !input.activity.serviceUrl || claims.serviceUrl !== input.activity.serviceUrl) {
    return { ok: false, code: "service_url_mismatch" };
  }
  // a published key may be endorsed for named channels only
  const kid = verified.protectedHeader.kid;
  const key = source.jwks.jwks()?.keys.find((k) => k.kid === kid);
  const endorsements = key?.endorsements;
  if (Array.isArray(endorsements) && !(input.activity.channelId && endorsements.includes(input.activity.channelId))) {
    return { ok: false, code: "key_not_endorsed" };
  }
  return { ok: true, claims };
}
