/**
 * X19-S01 — the shared scrub for upstream error material (known credential
 * values in every encoding they can take). Distinct from audit-scrub.ts
 * (ADR-0099), which recognises credential SHAPES in audit rows without knowing
 * the value; this one removes the exact values an adapter sent.
 */

// ---------------------------------------------------------------------------
// X19-S01 — THE ONE SCRUB FOR UPSTREAM ERROR MATERIAL.
//
// Every provider adapter (connector-provider, git-provider, pm-provider) that
// turns an upstream error into an error message (which the gateway returns as
// a detail) or a log line passes the credentials it put on the wire through
// `scrubSecrets`. A reflecting upstream
// or proxy does not echo a secret only verbatim: the token request body is
// form-encoded, and a JSON body escapes `"` and `\` (and some serializers
// every non-ASCII or HTML-significant character as \uXXXX). So a known secret
// is removed in each representation it can take —
//   raw · JSON-escaped (once and twice) · encodeURIComponent ·
//   application/x-www-form-urlencoded ('+' for a space), percent-escapes in
//   either hex case —
// and a body that IS JSON is also scrubbed at the decoded-string level and
// re-serialized, so no escaping choice can hide a secret from the match and
// `JSON.parse` of what we emit cannot reconstruct it.
// Open-source check (ADR-0176): log redactors (pino's `redact`, fast-redact)
// remove values by object PATH, not a known value inside arbitrary upstream
// text in its encoded forms; none fits, so this stays ours.
// ---------------------------------------------------------------------------

/** a secret shorter than this is not matched (it would shred ordinary text) */
const SCRUB_MIN_SECRET_LENGTH = 4;
/** deeper JSON than this is not walked; the subtree is withheld instead */
const SCRUB_MAX_JSON_DEPTH = 64;
const REDACTED = "[redacted]";

/** every representation `secret` can take in upstream error material */
export function secretRepresentations(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const forms = new Set<string>([
    secret,
    json,
    // a JSON string embedded in a JSON string (a logged body inside a JSON log line)
    JSON.stringify(json).slice(1, -1),
    encodeURIComponent(secret),
    // application/x-www-form-urlencoded: what the token request body carries
    new URLSearchParams([["k", secret]]).toString().slice(2),
  ]);
  return [...forms].filter((f) => f.length >= SCRUB_MIN_SECRET_LENGTH);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** one alternation over every representation of every secret, longest first;
 * a percent-escape matches in either hex case (%2B and %2b are one octet) */
function secretMatcher(secrets: readonly string[]): RegExp | null {
  const forms = new Set<string>();
  for (const sec of secrets) {
    if (typeof sec === "string" && sec.length >= SCRUB_MIN_SECRET_LENGTH) {
      for (const f of secretRepresentations(sec)) forms.add(f);
    }
  }
  if (forms.size === 0) return null;
  const patterns = [...forms]
    .sort((a, b) => b.length - a.length)
    .map((f) =>
      escapeRegExp(f).replace(/%([0-9A-Fa-f])([0-9A-Fa-f])/g, (_m, a: string, b: string) => {
        const either = (c: string) => (/[A-Fa-f]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c);
        return `%${either(a)}${either(b)}`;
      }),
    );
  return new RegExp(patterns.join("|"), "g");
}

/** the flat pass: known secrets in every representation, then bearer tokens,
 * JWT-shaped strings and `client_secret=`-style pairs */
function scrubFlat(text: string, matcher: RegExp | null): string {
  const out = matcher ? text.replace(matcher, REDACTED) : text;
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .replace(/((?:client_secret|access_token|password)["'=:\s]+)[^"'&\s,}]+/gi, "$1[redacted]");
}

/** a JSON body scrubbed at the DECODED level (keys and string values), or
 * null when the text is not JSON or nothing in it needed scrubbing */
function scrubJsonDecoded(text: string, matcher: RegExp | null): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let changed = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      const s = scrubFlat(v, matcher);
      if (s !== v) changed = true;
      return s;
    }
    if (v === null || typeof v !== "object") return v;
    if (depth >= SCRUB_MAX_JSON_DEPTH) {
      changed = true;
      return "[withheld: nested too deep to scrub]";
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [walk(k, depth + 1) as string, walk(x, depth + 1)]),
    );
  };
  const out = walk(parsed, 0);
  return changed ? JSON.stringify(out) : null;
}

/**
 * Remove every known credential (in each representation above), bearer
 * tokens, JWT-shaped strings and `client_secret=`-style pairs from upstream
 * error material BEFORE it is returned, logged or audited. Callers pass every
 * credential the request put on the wire: the client secret, the minted access
 * token, the bearer token, the Basic-auth string.
 */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  const matcher = secretMatcher(secrets);
  return scrubFlat(scrubJsonDecoded(text, matcher) ?? text, matcher);
}
