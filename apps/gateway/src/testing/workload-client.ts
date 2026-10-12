/**
 * ADR-0188 S7 test fixtures — a WORKLOAD SELF-TOKEN CLIENT driven through the
 * real app (`app.inject`), and the issuer signing key a suite needs to mint.
 *
 * `useTestIssuerKey` configures a fresh Ed25519 issuer key for this process
 * and makes it the active signer: the issuer-key table is ORG-GLOBAL (M-040,
 * M-042), so the suite that needs a signer rotates to its own key (retiring
 * whatever another suite left active) and its restore retires it again. The
 * pattern is S5's (`zz-adr0188-s5-token-endpoint.test.ts`), in one place.
 *
 * `TestWorkloadClient` is a key the test holds (a runner's `rgek_` secret, or
 * a fresh one): it gets a self token from `POST /oauth/token` with the
 * `client_credentials` grant, `private_key_jwt` (named by its RFC 9278
 * thumbprint) and DPoP, and signs a fresh DPoP proof for every request. The
 * gateway nonce is computed from the suite's data key (the same HMAC the
 * gateway issues), so no request has to fail first to learn it. Synthetic keys
 * only; nothing here is a real credential.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { calculateJwkThumbprint, SignJWT, type JWK } from "jose";
import { identitySigningKeys, sql, type Db } from "@regulait/db";
import { IDENTITY_SIGNING_KEY_ENV, JWK_THUMBPRINT_URI_PREFIX, WORKLOAD_SELF_RESOURCE_PATHS, type WorkloadSelfKind } from "@regulait/shared";
import { deriveIdentitySecrets, issueDpopNonce } from "../delegated-token.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "../identity-signing-keys.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";

/** a fresh issuer key file for this process, made the active signer; the returned function retires it and cleans up */
export async function useTestIssuerKey(db: Db): Promise<() => Promise<void>> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "s7-issuer-"));
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(path.join(dir, "issuer.pem"), pem, { mode: 0o600 });
  const prior = process.env[IDENTITY_SIGNING_KEY_ENV];
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(dir, "issuer.pem");
  const k0 = (await configuredIdentitySigningKeys())[0]!;
  const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys);
  const [active] = await db.select().from(identitySigningKeys).where(sql`activated_at is not null and retired_at is null and revoked_at is null`);
  if (recorded.length > 0 && active?.kid !== k0.kid) await rotateIdentitySigningKey(db, { kid: k0.kid, actorUserId: SYSTEM });
  return async () => {
    await db.execute(sql`update identity_signing_keys set retired_at = now() where kid = ${k0.kid} and activated_at is not null and retired_at is null and revoked_at is null`);
    if (prior === undefined) delete process.env[IDENTITY_SIGNING_KEY_ENV];
    else process.env[IDENTITY_SIGNING_KEY_ENV] = prior;
    rmSync(dir, { recursive: true, force: true });
  };
}

interface InjectLike {
  inject(opts: { method: string; url: string; headers?: Record<string, string>; payload?: string | object }): PromiseLike<{ statusCode: number; body: string; json(): unknown; headers: Record<string, unknown> }>;
}

const b64sha = (v: string) => createHash("sha256").update(v).digest("base64url");

/** a workload key held by a test, and the self tokens it gets */
export class TestWorkloadClient {
  readonly privateKey: KeyObject;
  readonly publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  private access: { token: string; exp: number } | null = null;
  private jktMemo: string | null = null;

  constructor(
    private readonly app: InjectLike,
    private readonly opts: { issuer: string; dataKey: string; kind: WorkloadSelfKind; privateKey?: KeyObject; runnerSecret?: string },
  ) {
    this.privateKey =
      opts.privateKey ??
      (opts.runnerSecret
        ? createPrivateKey({ key: Buffer.from(opts.runnerSecret.slice("rgek_".length), "base64url"), format: "der", type: "pkcs8" })
        : generateKeyPairSync("ed25519").privateKey);
    const j = this.privateKey.export({ format: "jwk" }) as { x: string };
    this.publicJwk = { kty: "OKP", crv: "Ed25519", x: j.x };
  }

  async jkt(): Promise<string> {
    this.jktMemo ??= await calculateJwkThumbprint(this.publicJwk as JWK, "sha256");
    return this.jktMemo;
  }

  async clientId(): Promise<string> {
    return `${JWK_THUMBPRINT_URI_PREFIX}${await this.jkt()}`;
  }

  get resource(): string {
    return `${this.opts.issuer}${WORKLOAD_SELF_RESOURCE_PATHS[this.opts.kind]}`;
  }

  nonce(): string {
    return issueDpopNonce(deriveIdentitySecrets(this.opts.dataKey).nonceKey);
  }

  /** a DPoP proof by this key for `method` `url` (an absolute URL under the issuer) */
  async proof(method: string, url: string, o: { ath?: string; nonce?: string | null; iat?: number; jti?: string; key?: KeyObject; jwk?: object } = {}): Promise<string> {
    const p: Record<string, unknown> = { htm: method, htu: url, iat: o.iat ?? Math.floor(Date.now() / 1000), jti: o.jti ?? randomUUID() };
    if (o.nonce !== null) p.nonce = o.nonce ?? this.nonce();
    if (o.ath) p.ath = o.ath;
    return new SignJWT(p).setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk: (o.jwk ?? this.publicJwk) as JWK }).sign(o.key ?? this.privateKey);
  }

  /** a `private_key_jwt` client assertion (RFC 7523) naming this key by its RFC 9278 thumbprint URI */
  async assertion(o: { aud?: string; sub?: string; iat?: number; exp?: number; jti?: string } = {}): Promise<string> {
    const sub = o.sub ?? (await this.clientId());
    const iat = o.iat ?? Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: await this.jkt() })
      .setIssuer(sub)
      .setSubject(sub)
      .setAudience(o.aud ?? `${this.opts.issuer}/oauth/token`)
      .setJti(o.jti ?? randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(o.exp ?? iat + 60)
      .sign(this.privateKey);
  }

  /** the raw token request (for refusal tests); `form` overrides any field, `dpop: null` sends no proof */
  async tokenRequest(o: { form?: Record<string, string>; dpop?: string | null } = {}) {
    const form = {
      grant_type: "client_credentials",
      resource: this.resource,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await this.assertion(),
      ...o.form,
    };
    const dpop = o.dpop === undefined ? await this.proof("POST", `${this.opts.issuer}/oauth/token`) : o.dpop;
    return this.app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(dpop ? { dpop } : {}) },
      payload: new URLSearchParams(form).toString(),
    });
  }

  /** a self token (cached until 30 s before it expires); throws with the gateway's answer on a refusal */
  async token(): Promise<string> {
    if (this.access && this.access.exp - Date.now() > 30_000) return this.access.token;
    const r = await this.tokenRequest();
    if (r.statusCode !== 200) throw new Error(`self token refused: ${r.statusCode} ${r.body}`);
    const j = r.json() as { access_token: string; expires_in: number };
    this.access = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  /** forget the cached token (the next request gets a new one) */
  reset(): void {
    this.access = null;
  }

  /** the headers of one request to `path` (Authorization: DPoP + a fresh proof) */
  async headers(method: string, pathAndQuery: string): Promise<Record<string, string>> {
    const token = await this.token();
    const url = `${this.opts.issuer}${pathAndQuery.split("?")[0]}`;
    return { authorization: `DPoP ${token}`, dpop: await this.proof(method, url, { ath: b64sha(token) }) };
  }
}
