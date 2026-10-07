/**
 * ADR-0186 A — a SOFTWARE WebAuthn authenticator (ES256, P-256), for tests and
 * for the synthetic demo personas only. It produces exactly what a browser
 * hands to the gateway (`navigator.credentials.create/get` serialised by
 * `@simplewebauthn/browser`), so the gateway verifies it with the same
 * `@simplewebauthn/server` code as a real passkey: nothing on the server
 * knows or trusts that it is soft.
 *
 * Never imported by the gateway itself. Keys are generated in memory per
 * instance and never written anywhere.
 *
 * Built on node:crypto and the CBOR encoder `@simplewebauthn/server` already
 * ships (`isoCBOR`); no dependency of its own.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/** authenticator-data flags */
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface SoftAuthenticatorOptions {
  /** the origin the "browser" reports (the deployment's public origin) */
  origin: string;
  /** set user verification (default true); false proves the server requires it */
  userVerified?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId: Buffer = randomBytes(32);
  counter = 0;
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };

  constructor(private readonly opts: SoftAuthenticatorOptions) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicJwk = { x: jwk.x, y: jwk.y };
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private cosePublicKey(): Uint8Array {
    const m = new Map<number, number | Uint8Array>();
    m.set(1, 2); // kty: EC2
    m.set(3, -7); // alg: ES256
    m.set(-1, 1); // crv: P-256
    m.set(-2, isoBase64URL.toBuffer(this.publicJwk.x));
    m.set(-3, isoBase64URL.toBuffer(this.publicJwk.y));
    return isoCBOR.encode(m);
  }

  private flags(extra: number): number {
    return UP | (this.opts.userVerified === false ? 0 : UV) | extra;
  }

  private sign(data: Buffer): Buffer {
    return createSign("SHA256").update(data).sign(this.privateKey); // DER, as WebAuthn wants
  }

  /**
   * A registration response to `options` (the server's creation options).
   * `format` other than "none" builds a packed SELF attestation (a valid one:
   * the library would accept it), so a test can prove the server refuses it
   * before verification.
   */
  register(options: { challenge: string; rp: { id?: string } }, format: "none" | "packed" = "none"): Record<string, unknown> {
    const rpId = options.rp.id!;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.opts.origin, crossOrigin: false }),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(AT)]),
      counter,
      Buffer.alloc(16), // AAGUID: all zero
      idLen,
      this.credentialId,
      Buffer.from(this.cosePublicKey()),
    ]);
    const attStmt = new Map<string, number | Uint8Array>();
    if (format === "packed") {
      attStmt.set("alg", -7);
      attStmt.set("sig", this.sign(Buffer.concat([authData, sha256(clientDataJSON)])));
    }
    const att = new Map<string, string | Uint8Array | Map<string, number | Uint8Array>>();
    att.set("fmt", format);
    att.set("attStmt", attStmt);
    att.set("authData", authData);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(isoCBOR.encode(att)),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** an authentication (assertion) response to `options` (the server's request options) */
  authenticate(options: { challenge: string; rpId?: string }, rpIdFallback?: string): Record<string, unknown> {
    const rpId = options.rpId ?? rpIdFallback!;
    this.counter += 1;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.opts.origin, crossOrigin: false }),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(0)]), counter]);
    const signature = this.sign(Buffer.concat([authData, sha256(clientDataJSON)]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
