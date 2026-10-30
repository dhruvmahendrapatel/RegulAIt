/**
 * ADR-0204 — a server's static upstream credential, the pure half of the card: the scheme options, the read view,
 * and the inline checks the form runs before it asks the gateway.
 *
 * The gateway is the authority (`packages/shared/src/mcp-upstream-credential.ts`, repeated as a CHECK in migration
 * 0214). These checks catch the common mistakes next to the field; the gateway's full reserved-header list is not
 * restated here (the bundle ceiling, ADR-0196), so a reserved name is refused by the gateway and shown inline.
 */

export type UpstreamCredentialScheme = "bearer" | "header";

export const UPSTREAM_CREDENTIAL_SCHEME_OPTIONS: ReadonlyArray<{ value: UpstreamCredentialScheme; label: string }> = [
  { value: "bearer", label: "Bearer token in Authorization" },
  { value: "header", label: "Key in a named header" },
];

/** `GET /v1/servers/:id/upstream-credential` — never the secret */
export interface UpstreamCredentialView {
  set: boolean;
  scheme: UpstreamCredentialScheme | null;
  headerName: string | null;
  last4: string | null;
  setBy: string | null;
  setAt: string | null;
}

export const SECRET_MIN = 16;
export const SECRET_MAX = 4096;

const SHAPE = /^[a-z0-9][a-z0-9-]*$/;
const PRINTABLE = /^[\x21-\x7e]*$/;

/** why `name` cannot carry a key, in words, or null */
export function headerNameProblem(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (n.length === 0) return "Enter a header name.";
  if (n.length > 64) return "Use at most 64 characters.";
  if (!SHAPE.test(n)) return "Use only letters, digits and hyphens, starting with a letter or digit.";
  if (n === "authorization") return "To send the key in Authorization, choose the Bearer token option.";
  return null;
}

/** why `secret` cannot be saved, in words, or null */
export function secretProblem(secret: string): string | null {
  if (secret.length === 0) return "Enter the key.";
  if (secret.length < SECRET_MIN) return `The key must be at least ${SECRET_MIN} characters.`;
  if (secret.length > SECRET_MAX) return `The key must be at most ${SECRET_MAX} characters.`;
  if (!PRINTABLE.test(secret)) return "Use only printable characters, with no spaces or line breaks.";
  return null;
}

/** how a stored credential is sent, in words */
export function sentAs(view: UpstreamCredentialView): string {
  if (!view.set) return "Nothing is sent.";
  const tail = view.last4 ? ` ending ${view.last4}` : "";
  return view.scheme === "bearer" ? `Sent as a bearer token in Authorization${tail}.` : `Sent in the ${view.headerName ?? "named"} header${tail}.`;
}
