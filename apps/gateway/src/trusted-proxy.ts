/**
 * Which peers may speak for the client (ADR-0031 item 3; corrects ADR-0029).
 *
 * Fastify's `trustProxy: true` trusts `X-Forwarded-For` / `X-Forwarded-Proto`
 * from ANY peer. That is not an abstract risk for this product: `req.ip` is
 * what lands in `auth_sessions.ip` and in the attribution record pillar 1
 * sells, so anything that can reach the gateway port directly — the host
 * loopback, a sibling container on the compose network, a future sidecar —
 * could forge both the client IP on the audit trail and an `https` origin on a
 * plaintext hop.
 *
 * The posture here is narrow-by-default:
 *
 *   REGULAIT_TRUSTED_PROXIES unset  ->  trust NOTHING. `req.ip` is the socket
 *                                       peer and every X-Forwarded-* header is
 *                                       ignored. This is the safe default and
 *                                       it is also what the gateway did before
 *                                       any trustProxy setting existed, so no
 *                                       deployment regresses.
 *   REGULAIT_TRUSTED_PROXIES=<list> ->  trust exactly those hops. Comma-
 *                                       separated IPs, CIDRs, or the
 *                                       proxy-addr keywords `loopback`,
 *                                       `linklocal`, `uniquelocal`.
 *
 * A deployment that puts a reverse proxy in front (Caddy/nginx/an ALB) MUST
 * name that proxy's address or CIDR here, or the audit trail will attribute
 * every request to the proxy rather than to the caller. That is the honest
 * trade: an obviously-wrong IP that an operator notices, rather than a
 * plausible IP anyone on the network can choose.
 *
 * We deliberately do NOT default to the docker-bridge range. On the compose
 * topology there is no proxy in front of the gateway today, so trusting the
 * bridge would buy nothing and would hand every sibling container the exact
 * forgery this change exists to remove.
 *
 * `all`/`true` is accepted so an operator who genuinely wants the old
 * behaviour can ask for it explicitly — it is never reached by default.
 */

export type TrustProxySetting = boolean | string[];

const OFF = new Set(["", "none", "false", "off", "0", "no"]);
const ALL = new Set(["all", "true", "*"]);

export const TRUSTED_PROXIES_ENV = "REGULAIT_TRUSTED_PROXIES";

export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): TrustProxySetting {
  const raw = env[TRUSTED_PROXIES_ENV];
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (OFF.has(trimmed.toLowerCase())) return false;
  if (ALL.has(trimmed.toLowerCase())) return true;
  const list = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : false;
}

/** one line an operator can read in the boot log to know what is trusted */
export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) {
    return `X-Forwarded-* headers are IGNORED (no trusted proxies). Set ${TRUSTED_PROXIES_ENV} to your reverse proxy's IP/CIDR if one is in front of this gateway.`;
  }
  if (setting === true) {
    return `X-Forwarded-* headers are trusted from ANY peer (${TRUSTED_PROXIES_ENV}=all). Client IPs in the audit trail are forgeable — narrow this to your proxy's address.`;
  }
  return `X-Forwarded-* headers are trusted only from: ${setting.join(", ")}`;
}
