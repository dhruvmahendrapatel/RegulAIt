/**
 * ADR-0121 amendment, ADR-0188 S7 — `REGULAIT_PUBLIC_URL`, parsed ONE way.
 *
 * The gateway uses it as the only origin outbound links may name and as the identity issuer; an engine runner
 * uses the same value as the issuer it names in every token request and DPoP proof. A self token is refused
 * unless both sides produce the SAME string, so both call this parser (moved here from the gateway's
 * `public-url.ts` in the review of #380): the host is lowercased and a default port dropped (WHATWG URL
 * parsing), `http` is allowed only for localhost or a loopback address, and no credentials, query, fragment,
 * dot segment or trailing-dot host is accepted. An optional base path is kept, without trailing slashes.
 *
 * No regular expression here repeats over an unbounded run of one character (CodeQL js/polynomial-redos): the
 * trailing slashes are trimmed by a bounded loop and the base path is checked segment by segment.
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

export function isLoopbackHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  const parts = h.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => p.length >= 1 && p.length <= 3 && [...p].every((c) => c >= "0" && c <= "9"));
}

/** `s` without its trailing `/` characters (a bounded loop, never a repeating regex) */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return s.slice(0, end);
}

const SEGMENT_CHARS = /^[A-Za-z0-9._~-]+$/;

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
  const rawSegments = rawPath.split(/[/\\]/);
  if (rawSegments.some((seg) => seg === "." || seg === ".." || /^(%2e){1,2}$/i.test(seg) || /^\.%2e$|^%2e\.$/i.test(seg))) {
    throw new PublicUrlBootError(`the base path ${JSON.stringify(rawPath)} must not contain '.' or '..' segments`);
  }
  if (url.search || value.includes("?")) throw new PublicUrlBootError("it must not carry a query");
  if (url.hash || value.includes("#")) throw new PublicUrlBootError("it must not carry a fragment");
  const basePath = trimTrailingSlashes(url.pathname);
  if (basePath !== "") {
    const segments = basePath.split("/").slice(1);
    if (!basePath.startsWith("/") || segments.some((seg) => !SEGMENT_CHARS.test(seg) || seg === "." || seg === "..")) {
      throw new PublicUrlBootError(`the base path ${JSON.stringify(url.pathname)} must be plain path segments`);
    }
  }
  return `${url.origin}${basePath}`;
}
