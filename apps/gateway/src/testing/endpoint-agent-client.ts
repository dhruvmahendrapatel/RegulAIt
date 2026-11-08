/**
 * A test endpoint agent (ADR-0195 SD4b): a runtime-generated P-256 device key that mints its DPoP-bound self token
 * with `private_key_jwt` and signs reports, as the Go agent does. Shared by the SD4b and ADR-0259 suites.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import type { buildApp } from "../app.js";
import { deriveIdentitySecrets, issueDpopNonce } from "../delegated-token.js";
import { contentDigestOf } from "../endpoint-agent.js";

export type Method = "GET" | "POST";

/** the AgentKey class bound to one app, data key and public origin */
export function endpointAgentKeys(getApp: () => ReturnType<typeof buildApp>, dataKey: string, ORIGIN: string) {
  const nonce = () => issueDpopNonce(deriveIdentitySecrets(dataKey).nonceKey);
  const b64sha = (v: string) => createHash("sha256").update(v).digest("base64url");
  /** a device key the test holds: P-256, made at run time, as the agent's TPM/DPAPI key is */
  class AgentKey {
    /** the cached self token (public only because an exported class expression cannot hold a private member) */
    access: string | null = null;
    constructor(
      readonly privateKey: CryptoKey,
      readonly jwk: { kty: "EC"; crv: "P-256"; x: string; y: string },
      readonly jkt: string,
    ) {}
    static async make(): Promise<AgentKey> {
      const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
      const j = (await exportJWK(publicKey)) as { x: string; y: string };
      const jwk = { kty: "EC" as const, crv: "P-256" as const, x: j.x, y: j.y };
      return new AgentKey(privateKey, jwk, await calculateJwkThumbprint(jwk as JWK, "sha256"));
    }
    get clientId() {
      return `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${this.jkt}`;
    }
    async proof(method: string, url: string, ath?: string) {
      const p: Record<string, unknown> = { htm: method, htu: url, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), nonce: nonce() };
      if (ath) p.ath = ath;
      return new SignJWT(p).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: this.jwk as JWK }).sign(this.privateKey);
    }
    async tokenRequest() {
      const iat = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: this.jkt })
        .setIssuer(this.clientId)
        .setSubject(this.clientId)
        .setAudience(`${ORIGIN}/oauth/token`)
        .setJti(randomUUID())
        .setIssuedAt(iat)
        .setExpirationTime(iat + 60)
        .sign(this.privateKey);
      const form = {
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        resource: `${ORIGIN}/v1/endpoint-agent`,
      };
      return getApp().inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: await this.proof("POST", `${ORIGIN}/oauth/token`) },
        payload: new URLSearchParams(form).toString(),
      });
    }
    async token() {
      if (this.access) return this.access;
      const r = await this.tokenRequest();
      expect(r.statusCode, r.body).toBe(200);
      this.access = (r.json() as { access_token: string }).access_token;
      return this.access;
    }
    reset() {
      this.access = null;
    }
    async headers(method: Method, p: string) {
      const t = await this.token();
      return { authorization: `DPoP ${t}`, dpop: await this.proof(method, `${ORIGIN}${p}`, b64sha(t)) };
    }
    async reportSignature(body: string, o: { snapshotId: string; jti?: string; iat?: number; key?: AgentKey }) {
      const k = o.key ?? this;
      return new SignJWT({ snapshotId: o.snapshotId, contentDigest: contentDigestOf(Buffer.from(body)) })
        .setProtectedHeader({ alg: "ES256", typ: "regulait-endpoint-report+jwt", kid: k.jkt })
        .setIssuer(k.clientId)
        .setAudience(`${ORIGIN}/v1/endpoint-agent/reports`)
        .setIssuedAt(o.iat ?? Math.floor(Date.now() / 1000))
        .setJti(o.jti ?? randomUUID())
        .sign(k.privateKey);
    }
    /** POST a report; `signature` overrides the signature header (null: none) */
    async report(body: string, snapshotId: string, o: { signature?: string | null } = {}) {
      const sig = o.signature === undefined ? await this.reportSignature(body, { snapshotId }) : o.signature;
      return getApp().inject({
        method: "POST",
        url: "/v1/endpoint-agent/reports",
        headers: {
          ...(await this.headers("POST", "/v1/endpoint-agent/reports")),
          "content-type": "application/json",
          "content-digest": contentDigestOf(Buffer.from(body)),
          ...(sig ? { "regulait-report-signature": sig } : {}),
        },
        payload: body,
      });
    }
  }
  return AgentKey;
}
