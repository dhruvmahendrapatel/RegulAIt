/**
 * ADR-0326 (pilot, Entra ID): when does an OIDC login's email count as verified?
 *
 * The callback refuses a login whose email is not verified (ADR-0174). The OIDC standard claim is
 * `email_verified: true`. Microsoft Entra ID never sends `email_verified`; it sends the optional claim
 * `xms_edov: true` ("email domain owner verified": the email's domain belongs to the user's tenant and the tenant
 * admin has verified it). Without this, a direct Entra provider refuses every login.
 *
 * `xms_edov` is accepted ONLY on a token whose validated issuer is an Entra v2.0 tenant issuer
 * (`https://login.microsoftonline.com/<tenant-guid>/v2.0`) and whose `tid` names that same tenant. Any other issuer
 * must send `email_verified: true`. Nothing here is relaxable: it is the same strictness, spelled the way Entra
 * spells it. The app registration must add the `email` and `xms_edov` optional claims to the ID token
 * (docs/deployment/ENTRA_ID.md).
 */
const ENTRA_V2_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/;

export type EmailVerifiedVia = "email_verified" | "entra_xms_edov" | null;

export function oidcEmailVerifiedVia(claims: Record<string, unknown>): EmailVerifiedVia {
  if (claims.email_verified === true) return "email_verified";
  const iss = typeof claims.iss === "string" ? claims.iss : "";
  const m = ENTRA_V2_ISSUER.exec(iss);
  if (m && claims.tid === m[1] && claims.xms_edov === true) return "entra_xms_edov";
  return null;
}
