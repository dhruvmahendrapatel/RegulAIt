/**
 * ADR-0336 decision 5: a Salesforce access token through the OAuth 2.0 JWT bearer flow, for a read adapter. Kept on
 * its own so the ADR-0337 Salesforce entitlement reader can reuse it.
 *
 * The assertion (RS256, `jose`) is bound to one connected app (`iss` = consumer key) and one integration user
 * (`sub`), and its `aud` is Salesforce's authorization server for the org's environment (`https://login.salesforce.com`
 * for production, `https://test.salesforce.com` for a sandbox, as Salesforce documents). It lives for 2 minutes
 * (Salesforce allows 3 for clock skew) and carries a fresh `jti`. It is POSTed only to the token endpoint of the
 * source's validated My Domain origin, which the caller derives from configuration it validated itself, never from a
 * vendor response; the `instance_url` Salesforce returns is ignored. The private key is the stored secret: encrypted at
 * rest, decrypted only for the run, never logged, rotatable by replacing the credential.
 */
import { randomUUID } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { readBodyCapped } from "@regulait/cloud-discovery";
import { WiderSourceConfigError } from "./discovery-wider-scanners.js";

/** a token response is small; anything larger is refused unread */
const TOKEN_BODY_MAX = 65_536;

export type SalesforceEnvironment = "production" | "sandbox";
export const SALESFORCE_JWT_AUDIENCE: Readonly<Record<SalesforceEnvironment, string>> = Object.freeze({
  production: "https://login.salesforce.com",
  sandbox: "https://test.salesforce.com",
});
/** the assertion's lifetime in seconds: as short as practical, inside Salesforce's 3-minute allowance */
export const SALESFORCE_JWT_LIFETIME_S = 120;

export interface SalesforceJwtInput {
  /** a fetch already restricted to the My Domain origin and its token path (allowListedFetch) */
  fetch: typeof fetch;
  /** the validated My Domain origin, e.g. https://acme.my.salesforce.com */
  origin: string;
  environment: SalesforceEnvironment;
  consumerKey: string;
  username: string;
  /** the connected app's private key, PKCS#8 PEM */
  privateKeyPem: string;
  signal: AbortSignal;
  /** called with every secret value produced, so the worker scrubs it */
  onSecret: (value: string) => void;
}

/** an access token; any failure is a WiderSourceConfigError carrying only Salesforce's error code, never a body */
export async function salesforceJwtToken(kind: string, i: SalesforceJwtInput): Promise<string> {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(i.privateKeyPem.trim(), "RS256");
  } catch {
    throw new WiderSourceConfigError(`${kind}: the stored secret is not an RSA private key in PKCS#8 PEM form`);
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(i.consumerKey)
    .setSubject(i.username)
    .setAudience(SALESFORCE_JWT_AUDIENCE[i.environment])
    .setIssuedAt(now)
    .setExpirationTime(now + SALESFORCE_JWT_LIFETIME_S)
    .setJti(randomUUID())
    .sign(key);
  i.onSecret(assertion);
  let res: Response;
  try {
    res = await i.fetch(`${i.origin}/services/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      redirect: "manual",
      signal: i.signal,
    });
  } catch (err) {
    if (i.signal.aborted) throw err;
    throw new WiderSourceConfigError(`${kind}: the Salesforce token request did not reach the org (is its host on the egress allow list?)`);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBodyCapped(res.body, TOKEN_BODY_MAX)));
  } catch {
    // too large, cut off or not JSON: reported below without echoing it
  }
  const field = (k: string): string | null => {
    const v = body && typeof body === "object" ? (body as Record<string, unknown>)[k] : undefined;
    return typeof v === "string" && v.length > 0 && v.length <= 4096 ? v : null;
  };
  const token = field("access_token");
  if (!res.ok || !token) {
    const code = /^[a-z_]{1,64}$/.test(field("error") ?? "") ? field("error") : null;
    throw new WiderSourceConfigError(`${kind}: the Salesforce token request failed (HTTP ${res.status}${code ? `, ${code}` : ""})`);
  }
  i.onSecret(token);
  return token;
}
