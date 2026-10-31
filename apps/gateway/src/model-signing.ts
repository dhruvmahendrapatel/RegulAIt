/**
 * ADR-0216 (P14) — VERIFYING A MODEL FILE'S SIGNATURE.
 *
 * The format is the OpenSSF model-signing format (`model_signing`, predicate v1.0): a Sigstore bundle whose DSSE
 * envelope carries an in-toto statement. Its predicate lists each signed file with its sha256, and its one subject's
 * digest is the sha256 over those digests in order. An uploaded artifact is one file, so a signature covers it when
 * one listed resource's digest is the artifact's sha256 (the signer may have signed the whole model directory).
 *
 * AIR-GAPPED BY CONSTRUCTION: only the key-based mode is accepted. The bundle names its key by a hint (the sha256 of
 * the key's PEM, as the signing tool writes it); the key must be a trust root an admin configured here and has not
 * revoked. No transparency log, certificate authority or timestamp authority is consulted, so nothing is fetched.
 * Keyless (certificate) bundles are refused as `unsupported_bundle`.
 *
 * Open-source check (ADR-0176): the envelope, the PAE encoding and the signature check are `@sigstore/verify` and
 * `@sigstore/bundle` (Apache-2.0, pinned). Measured: their key path verifies ECDSA P-256 with SHA-256 and does not
 * verify P-384 signed with SHA-384, so only P-256 keys are accepted as trust roots. The statement checks below (the
 * predicate type, the subject digest, the file digest) are the format's own rules, which no JavaScript library
 * implements; they follow `model_signing/_signing/signing.py`.
 */
import { createHash, createPublicKey } from "node:crypto";
import { bundleFromJSON } from "@sigstore/bundle";
import { Verifier, toSignedEntity, toTrustMaterial } from "@sigstore/verify";
import type { ModelSignatureFailure } from "@regulait/shared";

export const OMS_PREDICATE_TYPE = "https://model_signing/signature/v1.0";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
/** a bundle larger than this is refused before it is parsed */
export const MAX_SIGNATURE_BUNDLE_BYTES = 64 * 1024;

/** the trusted roots the verifier may use: keys not revoked */
export interface TrustedSigningKey {
  id: string;
  keyHint: string;
  publicKeyPem: string;
}

export type SignatureVerdict =
  | { ok: true; keyId: string; keyHint: string; signedName: string; resourceName: string }
  | { ok: false; failure: ModelSignatureFailure; keyHint: string | null };

/**
 * Parse an admin's public key. Only an ECDSA P-256 key is accepted. Returns the canonical PEM and its hint (the
 * sha256 of that PEM, as the signing tool computes it), or null when the key is unusable.
 */
export function parseSigningKey(pem: string): { publicKeyPem: string; keyHint: string } | null {
  let key;
  try {
    key = createPublicKey({ key: pem, format: "pem" });
  } catch {
    return null;
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
  const publicKeyPem = key.export({ type: "spki", format: "pem" }) as string;
  return { publicKeyPem, keyHint: createHash("sha256").update(publicKeyPem).digest("hex") };
}

const EMPTY_TRUSTED_ROOT = {
  mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
  tlogs: [],
  certificateAuthorities: [],
  ctlogs: [],
  timestampAuthorities: [],
};
/** PublicKeyDetails.PKIX_ECDSA_P256_SHA_256 in the Sigstore protobuf specs */
const PKIX_ECDSA_P256_SHA_256 = 5;

/**
 * Verify `bundleJson` for the artifact whose sha256 is `artifactSha256`, against `keys` only. Pure apart from the
 * crypto: no store, no clock, no network.
 */
export function verifyModelSignature(bundleJson: unknown, artifactSha256: string, keys: readonly TrustedSigningKey[], revokedHints: ReadonlySet<string> = new Set()): SignatureVerdict {
  let bundle;
  try {
    if (Buffer.byteLength(JSON.stringify(bundleJson) ?? "") > MAX_SIGNATURE_BUNDLE_BYTES) return { ok: false, failure: "bundle_malformed", keyHint: null };
    bundle = bundleFromJSON(bundleJson);
  } catch {
    return { ok: false, failure: "bundle_malformed", keyHint: null };
  }
  const content = bundle.content;
  const material = bundle.verificationMaterial.content;
  if (content.$case !== "dsseEnvelope" || material.$case !== "publicKey" || content.dsseEnvelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    return { ok: false, failure: "unsupported_bundle", keyHint: null };
  }
  const keyHint = material.publicKey.hint;
  const hint = /^[0-9a-f]{64}$/.test(keyHint) ? keyHint : null;
  const key = keys.find((k) => k.keyHint === keyHint);
  if (!key) return { ok: false, failure: hint && revokedHints.has(hint) ? "key_revoked" : "unknown_key", keyHint: hint };
  try {
    const trust = toTrustMaterial(EMPTY_TRUSTED_ROOT as never, {
      [key.keyHint]: { rawBytes: createPublicKey(key.publicKeyPem).export({ type: "spki", format: "der" }), keyDetails: PKIX_ECDSA_P256_SHA_256 } as never,
    });
    // key mode: no log entry, certificate or timestamp is expected (nothing online is consulted)
    new Verifier(trust, { tlogThreshold: 0, ctlogThreshold: 0, timestampThreshold: 0 }).verify(toSignedEntity(bundle));
  } catch {
    return { ok: false, failure: "signature_invalid", keyHint: key.keyHint };
  }
  // the signature holds: now what it says
  let statement: {
    _type?: unknown;
    predicateType?: unknown;
    subject?: Array<{ name?: unknown; digest?: { sha256?: unknown } }>;
    predicate?: { resources?: Array<{ name?: unknown; algorithm?: unknown; digest?: unknown }> };
  };
  try {
    statement = JSON.parse(content.dsseEnvelope.payload.toString("utf8"));
  } catch {
    return { ok: false, failure: "unsupported_predicate", keyHint: key.keyHint };
  }
  if (statement._type !== IN_TOTO_STATEMENT_TYPE || statement.predicateType !== OMS_PREDICATE_TYPE) {
    return { ok: false, failure: "unsupported_predicate", keyHint: key.keyHint };
  }
  const subject = Array.isArray(statement.subject) && statement.subject.length === 1 ? statement.subject[0]! : null;
  const resources = Array.isArray(statement.predicate?.resources) ? statement.predicate!.resources! : [];
  if (!subject || typeof subject.name !== "string" || typeof subject.digest?.sha256 !== "string" || resources.length === 0) {
    return { ok: false, failure: "unsupported_predicate", keyHint: key.keyHint };
  }
  const root = createHash("sha256");
  for (const r of resources) {
    if (r.algorithm !== "sha256" || typeof r.digest !== "string" || !/^[0-9a-f]{64}$/.test(r.digest) || typeof r.name !== "string") {
      return { ok: false, failure: "manifest_inconsistent", keyHint: key.keyHint };
    }
    root.update(Buffer.from(r.digest, "hex"));
  }
  if (root.digest("hex") !== subject.digest.sha256) return { ok: false, failure: "manifest_inconsistent", keyHint: key.keyHint };
  const covering = resources.find((r) => r.digest === artifactSha256);
  if (!covering) return { ok: false, failure: "digest_mismatch", keyHint: key.keyHint };
  return { ok: true, keyId: key.id, keyHint: key.keyHint, signedName: subject.name.slice(0, 255), resourceName: String(covering.name).slice(0, 255) };
}
