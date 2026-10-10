/**
 * ADR-0190 I3 — THE ONE ADAPTER between the executor and ADR-0188's wire
 * contract. Everything the executor sends to the gateway is authorised
 * through `ChannelCredential`; nothing else in this package knows how a
 * request is authenticated. When ADR-0188 S5/S7 settle a token path for
 * service workloads, this file (and `executor-channel-auth.ts` in the
 * gateway) is what changes.
 *
 * I3's credential: `ProofChannelCredential`, a ONE-USE REQUEST PROOF per
 * call — a compact JWS (`typ` `regulait-executor-proof+jwt`) under the
 * executor's registered key, binding the method, the route URL, the moment
 * (60 s window), a fresh `jti` and the SHA-256 of the exact body
 * (`@regulait/shared` `channel.ts` has the contract). It is RFC 7523's
 * `private_key_jwt` client assertion carrying RFC 9449's request binding:
 * nothing bearer, nothing reusable, nothing that outlives one request, no
 * secret in the executor's environment (the key is a file, decision 5's
 * "none" for the executor's own process).
 *
 * Reports are signed with the same key as a DETACHED JWS (RFC 7797) over the
 * report's canonical text, so the gateway stores the body as JSON and can
 * re-verify it later against the identity's registered public key.
 */
import { createHash, randomUUID } from "node:crypto";
import { FlattenedSign, SignJWT } from "jose";
import {
  canonicalExecutorReport,
  EXECUTOR_PROOF_HEADER,
  EXECUTOR_PROOF_TYP,
  type ExecutorReport,
  type ExecutorReportSignature,
  type SignedExecutorReport,
} from "@regulait/shared";
import type { ExecutorKey } from "./keys.js";

export interface ChannelCredential {
  /** the ADR-0188 identity identifier this credential speaks for (the OAuth client_id) */
  readonly identifier: string;
  /** the headers that authorise exactly this request (method, absolute URL, raw body or none) */
  authorizeRequest(method: string, url: string, body: string | undefined): Promise<Record<string, string>>;
  /** sign a report for the gateway (decision 6: "the executor signs the report with its workload key") */
  signReport(report: ExecutorReport): Promise<SignedExecutorReport>;
}

/** base64url(SHA-256(body)); the empty string for a request without a body */
export function bodyHash(body: string | undefined): string {
  return createHash("sha256")
    .update(body ?? "", "utf8")
    .digest("base64url");
}

export interface ProofChannelCredentialOptions {
  identifier: string;
  key: ExecutorKey;
  /** the gateway issuer (`REGULAIT_PUBLIC_URL`): the proof's audience */
  issuer: string;
  /** clock seam (seconds since the epoch) */
  nowSeconds?: () => number;
}

export class ProofChannelCredential implements ChannelCredential {
  readonly identifier: string;
  private readonly key: ExecutorKey;
  private readonly issuer: string;
  private readonly nowSeconds: () => number;

  constructor(opts: ProofChannelCredentialOptions) {
    this.identifier = opts.identifier;
    this.key = opts.key;
    this.issuer = opts.issuer;
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /** the route URL the proof names: no query, no fragment */
  static htuOf(url: string): string {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  }

  async authorizeRequest(method: string, url: string, body: string | undefined): Promise<Record<string, string>> {
    const iat = this.nowSeconds();
    const proof = await new SignJWT({ htm: method.toUpperCase(), htu: ProofChannelCredential.htuOf(url), bh: bodyHash(body) })
      .setProtectedHeader({ alg: "EdDSA", typ: EXECUTOR_PROOF_TYP, kid: this.key.thumbprint })
      .setIssuer(this.identifier)
      .setSubject(this.identifier)
      .setAudience(this.issuer)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .sign(this.key.privateKey);
    return { [EXECUTOR_PROOF_HEADER]: proof };
  }

  async signReport(report: ExecutorReport): Promise<SignedExecutorReport> {
    const canonical = canonicalExecutorReport(report);
    const jws = await new FlattenedSign(new TextEncoder().encode(canonical))
      .setProtectedHeader({ alg: "EdDSA", kid: this.key.thumbprint, b64: false, crit: ["b64"] })
      .sign(this.key.privateKey);
    const signature: ExecutorReportSignature = { protected: jws.protected!, signature: jws.signature };
    return { report, signature };
  }
}
