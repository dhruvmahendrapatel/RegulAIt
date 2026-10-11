/**
 * ADR-0189 slice B4 — the RFC 3161 half of the BOM verifier (R33, B4.9 G5).
 *
 * The pure verifier (`@regulait/shared` `bom/verify.ts`) takes a
 * `BomTimestampVerifier`; this adapts ADR-0186 S's pkijs validator
 * (`audit-timestamp-verify.ts`: imprint, nonce, policy, the five-minute window
 * against the recorded send time, the chain to a configured TSA trust bundle,
 * EKU and ESS binding) to it. No HTTP, AIA, OCSP or CRL retrieval: air-gapped.
 * The offline script (`scripts/verify-bom.mjs --tsa-trust <pem>`) uses it too.
 */
import { readFileSync, statSync } from "node:fs";
import { SignedData, TimeStampResp, TSTInfo } from "pkijs";
import type { BomTimestampVerifier } from "@regulait/shared";
import { derSchema, parseTimestampTrustBundle, TSA_DER_LIMIT, timestampReplyBytes, verifyTimestampResponse } from "./audit-timestamp-verify.js";

/** the SHA-256 message imprint inside a stored token (the reply DER, or a legacy bare token), hex */
export function timestampTokenImprint(tokenBase64: string): string {
  const response = new TimeStampResp({ schema: derSchema(timestampReplyBytes(tokenBase64)) });
  if (!response.timeStampToken) throw new Error("no token in the timestamp reply");
  const cms = new SignedData({ schema: response.timeStampToken.content });
  const content = cms.encapContentInfo.eContent;
  if (!content) throw new Error("no TSTInfo in the token");
  const info = new TSTInfo({ schema: derSchema(new Uint8Array(content.getValue())) });
  return Buffer.from(info.messageImprint.hashedMessage.valueBlock.valueHexView).toString("hex");
}

/** a verifier with the given TSA trust bundle (PEM text), or with none: then every token is `no_tsa_trust_bundle` */
export function bomTimestampVerifier(trustBundlePem: string | null): BomTimestampVerifier {
  const trust = trustBundlePem === null ? null : parseTimestampTrustBundle(trustBundlePem);
  return {
    messageImprint: timestampTokenImprint,
    verify:
      trust === null
        ? null
        : async (tokenBase64, facts) => {
            const out = await verifyTimestampResponse(new Uint8Array(timestampReplyBytes(tokenBase64)), {
              bytes: facts.recordBytes,
              nonceHex: facts.nonceHex,
              trust,
              ...(facts.policyOid ? { policyOid: facts.policyOid } : {}),
              now: facts.now,
              sentAt: facts.sentAt,
            });
            return { genTime: out.genTime };
          },
  };
}

/** the deployment's TSA trust bundle (`REGULAIT_TSA_TRUST_BUNDLE`), or null when none is configured */
export function deploymentTimestampVerifier(): BomTimestampVerifier {
  const file = process.env.REGULAIT_TSA_TRUST_BUNDLE?.trim();
  if (!file) return bomTimestampVerifier(null);
  if (!statSync(file).isFile() || statSync(file).size > TSA_DER_LIMIT) throw new Error("REGULAIT_TSA_TRUST_BUNDLE is not a readable trust bundle");
  return bomTimestampVerifier(readFileSync(file, "utf8"));
}
