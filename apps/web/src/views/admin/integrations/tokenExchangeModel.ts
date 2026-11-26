/**
 * Upstream token exchange — the pure half of the card on an MCP server and a connector: the read view, the form, the
 * inline checks run before the gateway is asked, and the words for the gateway's refusals.
 *
 * The gateway is the authority (`setUpstreamTokenExchangeSchema` in the shared package). The SPA does not import the
 * shared package at runtime, so the bounds and patterns are mirrored here and pinned against it by the unit test.
 */

/** `GET /v1/{servers|connectors}/:id/token-exchange` → `{ tokenExchange }`: never the secret, only its last four */
export interface TokenExchangeView {
  configured: boolean;
  enabled: boolean;
  tokenEndpoint: string | null;
  subjectTokenAudience: string | null;
  audience: string | null;
  resource: string | null;
  clientId: string | null;
  clientSecretLast4: string | null;
  maxTokenTtlSeconds: number | null;
  scopes: Record<string, string[]>;
  setBy: string | null;
  secretSetAt: string | null;
}

export const TTL_FLOOR = 30;
export const TTL_CEILING = 900;
export const TTL_DEFAULT = 300;
/** the gateway also caps the map at 256 actions; past that its fixed sentence is shown */
export const MAX_SCOPES = 32;
export const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
export const ACTION_KEY = /^[A-Za-z0-9_.:/-]{1,128}$/;
const PRINTABLE = /^[\x21-\x7E]+$/;

export interface ScopeRow {
  action: string;
  /** space-separated scope tokens, as typed */
  scopes: string;
}

export interface TokenExchangeForm {
  /** never prefilled on: a save leaves exchange off unless the admin ticks it (secure by default) */
  enabled: boolean;
  tokenEndpoint: string;
  subjectTokenAudience: string;
  audience: string;
  resource: string;
  clientId: string;
  /** write-only: never prefilled, cleared after every save */
  clientSecret: string;
  ttl: string;
  rows: ScopeRow[];
}

/** the form for a view: the stored values prefilled, the secret empty and the switch off */
export function formOf(v: TokenExchangeView | undefined): TokenExchangeForm {
  const rows = Object.entries(v?.scopes ?? {}).map(([action, s]) => ({ action, scopes: s.join(" ") }));
  return {
    enabled: false,
    tokenEndpoint: v?.tokenEndpoint ?? "",
    subjectTokenAudience: v?.subjectTokenAudience ?? "",
    audience: v?.audience ?? "",
    resource: v?.resource ?? "",
    clientId: v?.clientId ?? "",
    clientSecret: "",
    ttl: String(v?.maxTokenTtlSeconds ?? TTL_DEFAULT),
    rows: rows.length ? rows : [{ action: "", scopes: "" }],
  };
}

/** whether `s` is an absolute https URL with no credentials or fragment (the gateway's own test) */
export function isHttps(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

const HTTPS = "Enter a full https address, with no credentials or # part.";
export const scopeTokens = (s: string) => s.split(/\s+/).filter(Boolean);

/** the checks next to each field; an empty object means the form can be sent */
export function formProblems(f: TokenExchangeForm, configured: boolean): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  if (!isHttps(f.tokenEndpoint)) out.tokenEndpoint = HTTPS;
  if (f.resource.trim() && !isHttps(f.resource)) out.resource = HTTPS;
  if (!f.subjectTokenAudience.trim()) out.subjectTokenAudience = "Enter a value.";
  if (!f.audience.trim()) out.audience = "Enter a value.";
  if (!PRINTABLE.test(f.clientId.trim()) || f.clientId.trim().length > 256) out.clientId = "Enter the client id, with no spaces.";
  if ((f.clientSecret || !configured) && !(PRINTABLE.test(f.clientSecret) && f.clientSecret.length >= 16 && f.clientSecret.length <= 512)) {
    out.clientSecret = "Enter the secret: 16 to 512 characters, no spaces.";
  }
  const ttl = Number(f.ttl);
  if (!Number.isInteger(ttl) || ttl < TTL_FLOOR || ttl > TTL_CEILING) out.ttl = `Enter whole seconds from ${TTL_FLOOR} to ${TTL_CEILING}.`;
  const seen = new Set<string>();
  f.rows.forEach((r, i) => {
    const a = r.action.trim();
    const s = scopeTokens(r.scopes);
    if (!a && !s.length) return;
    const why = !ACTION_KEY.test(a)
      ? "Use letters, numbers and _ . : / - only."
      : seen.has(a)
        ? "This action is listed twice."
        : s.length < 1 || s.length > MAX_SCOPES || !s.every((t) => SCOPE_TOKEN.test(t))
          ? `Give 1 to ${MAX_SCOPES} scopes, with no quotes or backslashes.`
          : null;
    seen.add(a);
    if (why) out[`row${i}`] = why;
  });
  return out;
}

/** the PUT body: the secret only when one was typed (absent keeps the stored one), blank rows dropped */
export function bodyOf(f: TokenExchangeForm): Record<string, unknown> {
  const scopes: Record<string, string[]> = {};
  for (const r of f.rows) if (r.action.trim()) scopes[r.action.trim()] = scopeTokens(r.scopes);
  return {
    enabled: f.enabled,
    tokenEndpoint: f.tokenEndpoint.trim(),
    subjectTokenAudience: f.subjectTokenAudience.trim(),
    audience: f.audience.trim(),
    ...(f.resource.trim() ? { resource: f.resource.trim() } : {}),
    clientId: f.clientId.trim(),
    ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}),
    maxTokenTtlSeconds: Number(f.ttl),
    scopes,
  };
}

const REFUSALS: Record<string, string> = {
  stdio: "A stdio server has no HTTP request to carry a token.",
  profile_conflict: "This server already sends its identity assertion in Authorization. Return it to the default header form first.",
  bearer_credential_conflict: "This server already sends a static bearer credential. Clear it under Upstream credential first.",
  secret_required: "A new configuration needs its client secret.",
};

/** the words for a refused write, or null to keep the client's own message (a step-up refusal, a network error) */
export function refusalWords(e: unknown): string | null {
  const p = (e as { payload?: { error?: string; code?: string; detail?: string } } | null)?.payload;
  // anything else, a 400 invalid_request included, keeps the client's message: the code in words and the gateway's fixed sentence
  return p?.error === "upstream_token_exchange_refused" ? (REFUSALS[p.code ?? ""] ?? p.detail ?? null) : null;
}
