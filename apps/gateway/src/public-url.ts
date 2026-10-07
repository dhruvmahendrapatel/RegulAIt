/**
 * ADR-0121 amendment (ADR-0183 batch 2.6 review) — `REGULAIT_PUBLIC_URL`, the
 * ONE origin a link in mail sent from the organisation's mailbox may name.
 *
 * WHY A DEPLOYMENT FACT, NOT A REQUEST FACT. The first Outlook courier built
 * the portal link from the posting request's Host header (`baseUrlFor`). Any
 * caller able to post a card could then choose the domain in a mail the org's
 * own mailbox sends — a phishing-grade link carrying our name. The link is now
 * built ONLY from this variable; the request's Host is never read for it.
 *
 * WHY AN ENV VAR. Where this deployment is reachable is a fact about the
 * deployment, like REGULAIT_DEPLOY_MODE (ADR-0062) and the proxy trust of
 * ADR-0029 — not an admin toggle a compromised admin session could repoint.
 * Read from the environment on every consultation (as the deploy mode is), and
 * validated at boot: a value that is set but invalid REFUSES the boot. Unset
 * is fine; it only means mail couriers that need a link cannot run.
 *
 * WHAT IS VALID. An absolute `https` URL; `http` only for localhost or a
 * loopback address (a laptop demo). No credentials, no query, no fragment. An
 * optional base path (`https://acme.example/regulait`) is kept, without a
 * trailing slash; any other path character set is refused.
 */

export const PUBLIC_URL_ENV = "REGULAIT_PUBLIC_URL";

export class PublicUrlBootError extends Error {
  constructor(detail: string) {
    super(
      `${PUBLIC_URL_ENV} is set but not usable: ${detail}. Set it to the absolute https origin this deployment is ` +
        `reached at (optionally with a base path, e.g. https://regulait.acme.example), or unset it. It is the only ` +
        `origin links in outbound mail may use (ADR-0121 amendment).`,
    );
    this.name = "PublicUrlBootError";
  }
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * The normalized public URL (origin plus optional base path, no trailing
 * slash), or null when unset or blank.
 *
 * @throws {PublicUrlBootError} when set to something that is not a valid public URL
 */
export function parsePublicUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicUrlBootError(`${JSON.stringify(value)} is not an absolute URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new PublicUrlBootError(`the scheme must be https (http only for localhost or loopback), got ${url.protocol.replace(/:$/, "")}`);
  }
  // the AUTHORITY as written: `https://:@host` parses to empty credentials the
  // URL parser silently drops, so the raw text is checked, not the parse
  const rawAfterScheme = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:[/\\]*/, "");
  const rawAuthority = rawAfterScheme.split(/[/\\?#]/, 1)[0] ?? "";
  const rawPath = rawAfterScheme.slice(rawAuthority.length).split(/[?#]/, 1)[0] ?? "";
  if (url.username || url.password || rawAuthority.includes("@")) throw new PublicUrlBootError("it must not carry credentials");
  // a trailing-dot FQDN names the same host under a different origin string
  // (certificates, cookies and allow-lists compare the dotless form): refused
  if (url.hostname.endsWith(".")) throw new PublicUrlBootError("the host must not end with a dot");
  // dot segments are refused as written, never normalised away
  if (/(^|[/\\])(\.|%2e){1,2}([/\\]|$)/i.test(rawPath)) {
    throw new PublicUrlBootError(`the base path ${JSON.stringify(rawPath)} must not contain '.' or '..' segments`);
  }
  if (url.search || value.includes("?")) throw new PublicUrlBootError("it must not carry a query");
  if (url.hash || value.includes("#")) throw new PublicUrlBootError("it must not carry a fragment");
  const basePath = url.pathname.replace(/\/+$/, "");
  if (basePath !== "" && (!/^(\/[A-Za-z0-9._~-]+)+$/.test(basePath) || /\/\.{1,2}(\/|$)/.test(basePath))) {
    throw new PublicUrlBootError(`the base path ${JSON.stringify(url.pathname)} must be plain path segments`);
  }
  return `${url.origin}${basePath}`;
}

/** the deployment's public URL right now (see the header), or null */
export function resolvePublicUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return parsePublicUrl(env[PUBLIC_URL_ENV]);
}

/** the boot-log line */
export function describePublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = resolvePublicUrl(env);
  return url
    ? `${url} — the only origin links in outbound mail use`
    : `unset — outbound mail (the Outlook courier) is refused until ${PUBLIC_URL_ENV} names this deployment's https origin`;
}

/** the posture fact: whether it is set, and its value (it is not a secret) */
export function publicUrlPosture(env: NodeJS.ProcessEnv = process.env): { set: boolean; value: string | null; env: string } {
  let value: string | null = null;
  try {
    value = resolvePublicUrl(env);
  } catch {
    value = null;
  }
  return { set: value !== null, value, env: PUBLIC_URL_ENV };
}

/**
 * Join the public URL and an absolute in-app path. A base path that already
 * ends in `/ui` (an operator who pasted the SPA's address) is not doubled:
 * `https://h/ui` + `/ui/admin` → `https://h/ui/admin`.
 */
export function joinPublicUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (/\/ui$/.test(b) && (p === "/ui" || p.startsWith("/ui/") || p.startsWith("/ui?"))) return `${b}${p.slice(3)}`;
  return `${b}${p}`;
}

/**
 * ADR-0183 batch 2 review — the base URL a sign-in flow or a discovery
 * document names (SAML ACS and default SP entity id, the OIDC redirect_uri,
 * RFC 9728 resource metadata). When REGULAIT_PUBLIC_URL is set it is the
 * answer, whatever Host the request carried: a forged Host can then no longer
 * move a SAML Destination/Audience check or a redirect_uri. Unset → today's
 * behaviour, the request's scheme (`req.protocol`, which is exactly what
 * `requestIsSecure` reads: the trusted-proxy-aware value) and Host.
 * A set-but-invalid value throws (fail closed; boot already refuses it).
 */
export function deploymentBaseUrl(req: { protocol: string; headers: { host?: string } }, env: NodeJS.ProcessEnv = process.env): string {
  const pub = resolvePublicUrl(env);
  if (pub) return pub;
  const proto = req.protocol === "https" ? "https" : "http";
  return `${proto}://${req.headers.host ?? "localhost"}`;
}
