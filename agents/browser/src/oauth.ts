/**
 * ADR-0334: the extension as an OAuth client of the gateway, the same S7 flow the endpoint agent uses
 * (ADR-0195 SD4b): `client_credentials` with a `private_key_jwt` client assertion by the device key, a DPoP-bound
 * self token for the `/v1/browser-extension` resource, and a fresh DPoP proof (RFC 9449) on every request, with the
 * gateway's nonce when it asks for one. Standard formats through `jose`; nothing here is a RegulAIt-only scheme.
 *
 * The access token lives in this worker's memory only (never `chrome.storage`), and is re-minted when it is refused.
 */
import { base64url, SignJWT, type JWK } from "jose";
import type { BrowserPublicJwk } from "@regulait/shared/browser-governance";

export const TOKEN_PATH = "/oauth/token";
export const SELF_RESOURCE_PATH = "/v1/browser-extension";
const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export interface DeviceCredential {
  privateKey: CryptoKey;
  publicJwk: BrowserPublicJwk;
  /** the RFC 9278 thumbprint URI the gateway answered at registration */
  clientId: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** the `private_key_jwt` assertion (RFC 7523): one minute, one use */
export async function clientAssertion(c: DeviceCredential, tokenUrl: string, nowSeconds: number): Promise<string> {
  const kid = c.clientId.slice(c.clientId.lastIndexOf(":") + 1);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
    .setIssuer(c.clientId)
    .setSubject(c.clientId)
    .setAudience(tokenUrl)
    .setJti(crypto.randomUUID())
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 60)
    .sign(c.privateKey);
}

/** a DPoP proof for one request; `ath` binds it to the access token (RFC 9449 §4.2) */
export async function dpopProof(c: DeviceCredential, method: string, url: string, nowSeconds: number, opts: { nonce?: string; accessToken?: string } = {}): Promise<string> {
  const claims: Record<string, unknown> = { htm: method, htu: url, iat: nowSeconds, jti: crypto.randomUUID() };
  if (opts.nonce) claims.nonce = opts.nonce;
  if (opts.accessToken) claims.ath = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opts.accessToken))));
  return new SignJWT(claims).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: c.publicJwk as JWK }).sign(c.privateKey);
}

export class GatewayClient {
  private access: string | null = null;
  private nonce: string | undefined;

  constructor(
    private readonly origin: string,
    private readonly cred: DeviceCredential,
    private readonly doFetch: Fetch = (u, i) => fetch(u, i),
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** remember a nonce the gateway handed back; true when it is new (worth one retry) */
  private learn(res: Response): boolean {
    const n = res.headers.get("dpop-nonce");
    if (!n || n === this.nonce) return false;
    this.nonce = n;
    return true;
  }

  private async mint(): Promise<string | null> {
    const tokenUrl = `${this.origin}${TOKEN_PATH}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cred.clientId,
        client_assertion_type: JWT_BEARER,
        client_assertion: await clientAssertion(this.cred, tokenUrl, this.clock()),
        resource: `${this.origin}${SELF_RESOURCE_PATH}`,
      }).toString();
      const res = await this.doFetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: await dpopProof(this.cred, "POST", tokenUrl, this.clock(), this.nonce ? { nonce: this.nonce } : {}) },
        body,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      if (res.status === 200) {
        const j = (await res.json()) as { access_token?: unknown };
        return typeof j.access_token === "string" ? j.access_token : null;
      }
      if (!this.learn(res)) return null;
    }
    return null;
  }

  /**
   * POST JSON to one of the extension's routes. Re-mints the token once when it is refused, and retries once with a
   * new nonce. Returns the last response, or null when no token could be minted (the caller fails closed).
   */
  async post(path: string, payload: unknown): Promise<Response | null> {
    const url = `${this.origin}${path}`;
    const body = JSON.stringify(payload);
    let last: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.access ??= await this.mint();
      if (!this.access) return last;
      const res = await this.doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${this.access}`,
          dpop: await dpopProof(this.cred, "POST", url, this.clock(), { ...(this.nonce ? { nonce: this.nonce } : {}), accessToken: this.access }),
        },
        body,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      last = res;
      if (res.status !== 401) return res;
      if (this.learn(res)) continue;
      const err = ((await res.clone().json().catch(() => ({}))) as { error?: string }).error;
      // a revoked device is final: never retried
      if (err === "device_revoked") return res;
      this.access = null;
    }
    return last;
  }
}
