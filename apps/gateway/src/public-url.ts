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
  if (url.username || url.password) throw new PublicUrlBootError("it must not carry credentials");
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
