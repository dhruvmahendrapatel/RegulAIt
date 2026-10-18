/**
 * ADR-0167 N8 / D4 DFX2 — credential values in log text. A leaf module (no
 * gateway imports) so both the logger configuration (gateway-logger.ts) and
 * the error serializer (err-serializer.ts) use it without an import cycle.
 */
/** URL segments that ARE credentials, and what replaces them in a log line */
const URL_CREDENTIALS: ReadonlyArray<readonly [RegExp, string]> = [
  // the public feedback link: whatever follows /feedback/l/ (a real token, or a near-miss of one)
  [/(\/feedback\/l\/)[^/?#\s"'\\]+/g, "$1[redacted]"],
  // the token itself, wherever it appears (a message, a query string, an error)
  [/\brglf_[0-9A-Za-z]+/g, "rglf_[redacted]"],
];

/**
 * N8 (2026-10-17) — a credential-shaped query parameter. A token in a query
 * string (an OAuth `code`/`state`, a signed link's `sig`, an `access_token`)
 * reaches a log line through any `url` field; the value is replaced, the name
 * stays so the line still says what was sent. R3: a fragment (`#access_token=`,
 * an implicit-flow redirect) is matched as well as a query.
 */
const QUERY_CREDENTIAL = /([?&#](?:access_token|id_token|refresh_token|token|code|state|key|api_key|apikey|secret|password|sig|signature|client_assertion|assertion|session|client_secret|code_verifier|X-Amz-Signature|X-Amz-Credential|X-Goog-Signature)=)[^&#\s"'\\]*/gi;

/** a log line (or field) with every URL credential replaced */
export function redactLogText(s: string): string {
  let out = s;
  for (const [re, by] of URL_CREDENTIALS) out = out.replace(re, by);
  return out.replace(QUERY_CREDENTIAL, "$1[redacted]");
}
