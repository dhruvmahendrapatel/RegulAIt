/**
 * ADR-0188 S9 follow-up — VERIFYING A SPIFFE JWT-SVID presented as an OAuth
 * client assertion (`draft-ietf-oauth-spiffe-client-auth-02` §3.1, assertion
 * type `urn:ietf:params:oauth:client-assertion-type:jwt-spiffe`).
 *
 * The rules, each a refusal with its own code:
 *  - compact JWS only, at most 16 KiB; the JOSE header names `alg` and
 *    optionally `kid` and `typ` (`JWT` or `JOSE`) and nothing else (JWT-SVID §2:
 *    "any header not described here … MUST NOT be included", so `jwk`, `jku`,
 *    `x5u`, `x5c` and `crit` are refused before any key is chosen);
 *  - `alg` is one of JWT-SVID §2.1's nine (RS, PS and ES at 256/384/512); `none`,
 *    HMAC and every other value are refused, and the key must be of the type
 *    that `alg` names (an EC key for its own curve's ES alg, an RSA key for RS
 *    or PS; a key that names its own `alg` only for that alg), so a token can
 *    never choose how a key is used (alg confusion);
 *  - `sub` is a SPIFFE ID; its trust domain must have a usable bundle with JWT
 *    authorities (an uploaded bundle, or a fetched one inside its trust window);
 *  - the key is the bundle's JWT authority whose `kid` matches; a token with no
 *    `kid` is tried against the domain's keys of the right type. A `kid` the
 *    bundle does not hold is refused, never looked up anywhere else (no `iss`
 *    discovery, draft §8.1);
 *  - `aud` is present and holds exactly one value, this gateway's issuer
 *    identifier (draft §3.1 step 3; JWT-SVID §7.2: a token with two audiences
 *    can be replayed by either);
 *  - `exp` is present and in the future (5 s leeway), and at most
 *    `CLIENT_ASSERTION_MAX_AGE_SECONDS` away (decision 5: an assertion lives at
 *    most 5 minutes; SPIRE's default JWT-SVID lifetime is 5 minutes); `nbf` and
 *    `iat`, when present, are not in the future;
 *  - the signature, with `jose` (decision 21: `jose` does the JWT cryptography).
 *
 * What is NOT here: replay. The token endpoint claims the returned `replayKey`
 * (the `jti`, else a digest of the token) in `replay_claims` once the whole
 * request has been checked (decision 14), and binds the issued token to a DPoP
 * key, because a JWT-SVID is a bearer credential.
 *
 * Open source first (ADR-0176), recorded: npm was searched for a relying-party
 * JWT-SVID validator. `spiffe`, `@jeengbe/spiffe` and `@defakto/spiffe` are
 * Workload API clients (validation is delegated to a SPIRE agent over gRPC, which
 * a relying party outside the trust domain does not have); `@atlasauth/pca-spiffe`
 * 0.4.1 and `spiffile` 0.1.0 were first published weeks ago with no maintenance
 * record. None is validated, so the JWT-SVID profile above is ours and the JOSE
 * work is `jose` (pinned, already a dependency).
 */
import { createHash } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, errors as joseErrors, importJWK, jwtVerify, type JWK } from "jose";
import { CLIENT_ASSERTION_MAX_AGE_SECONDS } from "@regulait/shared";
import { spiffeIdParts } from "./x509.js";

/** JWT-SVID §2.1 */
export const JWT_SVID_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"] as const;
const ALGS: ReadonlySet<string> = new Set(JWT_SVID_ALGS);
const EC_ALG_CURVE: ReadonlyMap<string, string> = new Map([
  ["ES256", "P-256"],
  ["ES384", "P-384"],
  ["ES512", "P-521"],
]);
const HEADER_MEMBERS: ReadonlySet<string> = new Set(["alg", "kid", "typ"]);
const MAX_TOKEN_LENGTH = 16_384;
const LEEWAY_SECONDS = 5;

export type JwtSvidFailure =
  | "jwt_svid_malformed"
  | "jwt_svid_header"
  | "jwt_svid_alg"
  | "jwt_svid_sub"
  | "spiffe_trust_domain_unknown"
  | "jwt_svid_kid_unknown"
  | "jwt_svid_alg_key_mismatch"
  | "jwt_svid_aud_missing"
  | "jwt_svid_aud_mismatch"
  | "jwt_svid_exp_missing"
  | "jwt_svid_expired"
  | "jwt_svid_lifetime"
  | "jwt_svid_not_yet_valid"
  | "jwt_svid_signature";

export type JwtSvidCheck =
  | {
      ok: true;
      spiffeId: string;
      trustDomain: string;
      /** the bundle whose JWT authority verified it (the token endpoint locks it while it issues) */
      bundleId: string;
      /** what the token endpoint claims in `replay_claims` */
      replayKey: string;
      exp: number;
    }
  | { ok: false; code: JwtSvidFailure };

/** a trust domain's usable JWT authorities (`loadSpiffeJwtAuthorities`), injected so the rules are tested offline */
export type JwtAuthoritySource = (trustDomain: string) => Promise<{ bundleId: string; keys: ReadonlyArray<Record<string, string>> } | null>;

/** may this key verify a signature labelled `alg`? */
function keyServes(key: Record<string, string>, alg: string): boolean {
  if (key.alg !== undefined && key.alg !== alg) return false;
  if (key.kty === "RSA") return alg.startsWith("RS") || alg.startsWith("PS");
  if (key.kty === "EC") return EC_ALG_CURVE.get(alg) === key.crv;
  return false;
}

const fail = (code: JwtSvidFailure): JwtSvidCheck => ({ ok: false, code });

export async function verifyJwtSvid(token: string, opts: { audience: string; now: Date; authorities: JwtAuthoritySource }): Promise<JwtSvidCheck> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH || token.split(".").length !== 3) return fail("jwt_svid_malformed");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(token) as Record<string, unknown>;
    claims = decodeJwt(token) as Record<string, unknown>;
  } catch {
    return fail("jwt_svid_malformed");
  }
  if (Object.keys(header).some((m) => !HEADER_MEMBERS.has(m))) return fail("jwt_svid_header");
  if (header.typ !== undefined && header.typ !== "JWT" && header.typ !== "JOSE") return fail("jwt_svid_header");
  if (header.kid !== undefined && (typeof header.kid !== "string" || header.kid.length === 0)) return fail("jwt_svid_header");
  const alg = header.alg;
  if (typeof alg !== "string" || !ALGS.has(alg)) return fail("jwt_svid_alg");

  const sub = claims.sub;
  const parts = typeof sub === "string" ? spiffeIdParts(sub) : null;
  if (!parts || typeof sub !== "string") return fail("jwt_svid_sub");

  // the audience and the lifetime are judged before any key is touched
  const aud = claims.aud;
  if (aud === undefined || (Array.isArray(aud) && aud.length === 0)) return fail("jwt_svid_aud_missing");
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (audiences.length !== 1 || audiences[0] !== opts.audience) return fail("jwt_svid_aud_mismatch");
  const nowS = Math.floor(opts.now.getTime() / 1000);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return fail("jwt_svid_exp_missing");
  if (claims.exp <= nowS - LEEWAY_SECONDS) return fail("jwt_svid_expired");
  if (claims.exp > nowS + CLIENT_ASSERTION_MAX_AGE_SECONDS + LEEWAY_SECONDS) return fail("jwt_svid_lifetime");
  for (const t of [claims.nbf, claims.iat]) {
    if (t !== undefined && (typeof t !== "number" || t > nowS + LEEWAY_SECONDS)) return fail("jwt_svid_not_yet_valid");
  }

  const bundle = await opts.authorities(parts.trustDomain);
  if (!bundle || bundle.keys.length === 0) return fail("spiffe_trust_domain_unknown");
  let candidates: ReadonlyArray<Record<string, string>>;
  if (typeof header.kid === "string") {
    candidates = bundle.keys.filter((k) => k.kid === header.kid);
    if (candidates.length === 0) return fail("jwt_svid_kid_unknown");
    if (!candidates.every((k) => keyServes(k, alg))) return fail("jwt_svid_alg_key_mismatch");
  } else {
    candidates = bundle.keys.filter((k) => keyServes(k, alg));
    if (candidates.length === 0) return fail("jwt_svid_alg_key_mismatch");
  }

  for (const k of candidates) {
    try {
      const key = await importJWK({ ...k } as JWK, alg);
      await jwtVerify(token, key, {
        algorithms: [alg],
        audience: opts.audience,
        subject: sub,
        currentDate: opts.now,
        clockTolerance: LEEWAY_SECONDS,
        requiredClaims: ["sub", "aud", "exp"],
      });
    } catch (e) {
      // the claims were judged above, so only the signature (or a key that will not import) can fail here
      if (e instanceof joseErrors.JWTExpired) return fail("jwt_svid_expired");
      continue;
    }
    const jti = typeof claims.jti === "string" && claims.jti.length > 0 && claims.jti.length <= 256 ? claims.jti : null;
    return {
      ok: true,
      spiffeId: sub,
      trustDomain: parts.trustDomain,
      bundleId: bundle.bundleId,
      // keyed by the SPIFFE ID, so one workload's jti never collides with another's
      replayKey: jti ? `jwt-svid ${sub} jti ${jti}` : `jwt-svid ${sub} sha256 ${createHash("sha256").update(token).digest("base64url")}`,
      exp: claims.exp,
    };
  }
  return fail("jwt_svid_signature");
}
