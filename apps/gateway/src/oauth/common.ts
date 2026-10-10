/**
 * ADR-0188 slice S5 — what every external-identity surface shares: the issuer,
 * the deployment's environment, the resources a delegated token may name, and
 * the HMAC secrets.
 *
 *  - ISSUER = `REGULAIT_PUBLIC_URL` (ADR-0121), never the request's Host: a
 *    deployment fact, read at the point of use. Unset = the token endpoint and
 *    delegated-token authentication are unavailable (503), the strict default.
 *  - ENVIRONMENT = the deploy mode (`hosted | byoc | air_gapped`), the same
 *    value S4 gives in-process grants, so one identity's `environments` list
 *    governs both paths.
 *  - RESOURCES (RFC 8707): the absolute URL of a protected route — one MCP
 *    server (`<issuer>/mcp/<serverId>`) or one compat endpoint. Anything else
 *    is `invalid_target`. Parsed with `URL`, never a regular expression.
 */
import { resolveDeployMode } from "../deploy-posture.js";
import { resolvePublicUrl } from "../public-url.js";
import { deriveIdentitySecrets, type IdentitySecrets } from "../delegated-token.js";

export const OAUTH_TOKEN_ROUTE_PATH = "/oauth/token";

/** the gateway issuer, or null when REGULAIT_PUBLIC_URL is unset (or invalid: fail closed) */
export function identityIssuer(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return resolvePublicUrl(env);
  } catch {
    return null;
  }
}

export const tokenEndpointUrl = (issuer: string) => `${issuer}${OAUTH_TOKEN_ROUTE_PATH}`;

/** the environment external tokens are minted for and accepted in */
export function deploymentEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDeployMode(env);
}

const secretsCache = new Map<string, IdentitySecrets>();
/** the nonce and pairwise keys, derived from the data key (S3); null without one */
export function identitySecretsFor(dataKey: string | undefined): IdentitySecrets | null {
  if (!dataKey || dataKey.length < 32) return null;
  let s = secretsCache.get(dataKey);
  if (!s) {
    s = deriveIdentitySecrets(dataKey);
    secretsCache.set(dataKey, s);
  }
  return s;
}

/** the compat model endpoints a delegated token may name (exact paths) */
export const COMPAT_RESOURCE_PATHS: ReadonlySet<string> = new Set(["/v1/messages", "/v1/chat/completions", "/v1/models"]);

const UUID = (v: string) =>
  v.length === 36 &&
  [8, 13, 18, 23].every((i) => v[i] === "-") &&
  [...v].every((c, i) => [8, 13, 18, 23].includes(i) || (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"));

/**
 * Is `resource` one of this gateway's protected resources? Same origin and
 * base path as the issuer, no query, fragment or credentials, and the path is
 * `/mcp/<uuid>` or a compat endpoint. Returns the canonical form, or null.
 */
export function gatewayResource(issuer: string, resource: string): string | null {
  let u: URL;
  let base: URL;
  try {
    u = new URL(resource);
    base = new URL(issuer);
  } catch {
    return null;
  }
  if (u.origin !== base.origin || u.username || u.password || u.search || u.hash || resource.includes("?") || resource.includes("#")) return null;
  const basePath = base.pathname === "/" ? "" : base.pathname;
  if (!u.pathname.startsWith(`${basePath}/`)) return null;
  const rest = u.pathname.slice(basePath.length);
  if (COMPAT_RESOURCE_PATHS.has(rest)) return `${issuer}${rest}`;
  if (rest.startsWith("/mcp/") && UUID(rest.slice(5))) return `${issuer}/mcp/${rest.slice(5).toLowerCase()}`;
  return null;
}
