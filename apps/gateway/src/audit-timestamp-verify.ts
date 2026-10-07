/** RFC 3161 validation. No HTTP, AIA, OCSP or CRL retrieval occurs here. */
import { createHash } from "node:crypto";
import * as asn1 from "asn1js";
import { Certificate, ContentInfo, PKIStatusInfo, RelativeDistinguishedNames, SignedData, TSTInfo, TimeStampResp } from "pkijs";

export const TSA_SHA256_OID = "2.16.840.1.101.3.4.2.1";
const TST_INFO_OID = "1.2.840.113549.1.9.16.1.4";
const ESS_V1 = "1.2.840.113549.1.9.16.2.12", ESS_V2 = "1.2.840.113549.1.9.16.2.47";
export const TSA_DER_LIMIT = 1024 * 1024;
export class TimestampValidationError extends Error {
  constructor(code: string) { super(code); this.name = "TimestampValidationError"; }
}
function refuse(code: string): never { throw new TimestampValidationError(code); }
export function derSchema(bytes: Uint8Array): asn1.BaseBlock {
  if (!bytes.length || bytes.length > TSA_DER_LIMIT) refuse("timestamp_der_size");
  const parsed = asn1.fromBER(bytes);
  if (parsed.offset !== bytes.length) refuse("timestamp_der_malformed");
  return parsed.result;
}
export function parseTimestampTrustBundle(pem: string): Certificate[] {
  if (Buffer.byteLength(pem) > TSA_DER_LIMIT) refuse("timestamp_trust_bundle_size");
  const matches = [...pem.matchAll(/-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g)];
  if (!matches.length || matches.length > 64 || pem.replace(/-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g, "").trim()) refuse("timestamp_trust_bundle_invalid");
  try { return matches.map((match) => new Certificate({ schema: derSchema(Buffer.from(match[1]!.replace(/\s/g, ""), "base64")) })); }
  catch { return refuse("timestamp_trust_bundle_invalid"); }
}
function children(block: asn1.BaseBlock): asn1.BaseBlock[] {
  if (!(block instanceof asn1.Sequence)) refuse("timestamp_ess_invalid");
  return block.valueBlock.value;
}
function essBinding(cms: SignedData, signer: Certificate) {
  const attrs = cms.signerInfos[0]?.signedAttrs?.attributes ?? [];
  const bindings = attrs.filter((attr) => attr.type === ESS_V1 || attr.type === ESS_V2);
  if (bindings.length !== 1 || bindings[0]!.values.length !== 1) refuse("timestamp_ess_missing_or_duplicate");
  const attr = bindings[0]!;
  const root = children(attr.values[0]!);
  const certs = root[0] && children(root[0]);
  if (!certs?.length) refuse("timestamp_ess_invalid");
  const first = children(certs[0]!);
  let algorithm = attr.type === ESS_V1 ? "sha1" : "sha256", index = 0;
  if (attr.type === ESS_V2 && first[0] instanceof asn1.Sequence) {
    const id = children(first[0])[0];
    if (!(id instanceof asn1.ObjectIdentifier)) refuse("timestamp_ess_invalid");
    const algorithms: Record<string, string> = { [TSA_SHA256_OID]: "sha256", "2.16.840.1.101.3.4.2.2": "sha384", "2.16.840.1.101.3.4.2.3": "sha512" };
    algorithm = algorithms[id.valueBlock.toString()] ?? refuse("timestamp_ess_hash_unsupported"); index++;
  }
  const hash = first[index++];
  if (!(hash instanceof asn1.OctetString) || !Buffer.from(hash.valueBlock.valueHexView).equals(createHash(algorithm).update(Buffer.from(signer.toSchema(true).toBER(false))).digest())) refuse("timestamp_ess_certificate_mismatch");
  if (first[index]) {
    const issuerSerial = children(first[index++]!);
    if (issuerSerial.length !== 2 || !(issuerSerial[1] instanceof asn1.Integer) || !issuerSerial[1].isEqual(signer.serialNumber)) refuse("timestamp_ess_issuer_mismatch");
    const names = children(issuerSerial[0]!);
    const match = names.some((name) => {
      if (!(name instanceof asn1.Constructed) || name.idBlock.tagClass !== 3 || name.idBlock.tagNumber !== 4 || name.valueBlock.value.length !== 1) return false;
      return new RelativeDistinguishedNames({ schema: name.valueBlock.value[0]! }).isEqual(signer.issuer);
    });
    if (!match) refuse("timestamp_ess_issuer_mismatch");
  }
  if (index !== first.length) refuse("timestamp_ess_invalid");
}

export interface TimestampRequestFacts { bytes: Uint8Array; nonceHex: string; trust: Certificate[]; policyOid?: string; now: Date }
export async function verifyTimestampResponse(der: Uint8Array, facts: TimestampRequestFacts) {
  try {
    const response = new TimeStampResp({ schema: derSchema(der) });
    if (![0, 1].includes(response.status.status) || !response.timeStampToken || response.timeStampToken.contentType !== "1.2.840.113549.1.7.2") refuse("timestamp_not_granted");
    const cms = new SignedData({ schema: response.timeStampToken.content });
    if (cms.signerInfos.length !== 1 || !cms.certificates?.length || cms.certificates.length > 32 || (cms.signerInfos[0]?.signedAttrs?.attributes.length ?? 0) > 32 || cms.encapContentInfo.eContentType !== TST_INFO_OID || !cms.encapContentInfo.eContent) refuse("timestamp_token_structure");
    const info = new TSTInfo({ schema: derSchema(new Uint8Array(cms.encapContentInfo.eContent.getValue())) });
    if (![TSA_SHA256_OID, "2.16.840.1.101.3.4.2.2", "2.16.840.1.101.3.4.2.3"].includes(cms.signerInfos[0]!.digestAlgorithm.algorithmId)) refuse("timestamp_signature_hash_unsupported");
    const imprint = createHash("sha256").update(facts.bytes).digest("hex");
    if (info.version !== 1 || info.messageImprint.hashAlgorithm.algorithmId !== TSA_SHA256_OID || Buffer.from(info.messageImprint.hashedMessage.valueBlock.valueHexView).toString("hex") !== imprint) refuse("timestamp_imprint_mismatch");
    if (!info.nonce || Buffer.from(info.nonce.valueBlock.valueHexView).toString("hex") !== facts.nonceHex) refuse("timestamp_nonce_mismatch");
    if (facts.policyOid && info.policy !== facts.policyOid) refuse("timestamp_policy_mismatch");
    if (!Number.isFinite(info.genTime.getTime()) || info.genTime.getTime() > facts.now.getTime() + 300_000) refuse("timestamp_generation_time_invalid");
    // Chain at the signed generation time. All issuers must be in the token or
    // explicitly configured trust bundle. Revocation is not claimed: this
    // air-gapped validator never contacts certificate-controlled URLs.
    const checked = await cms.verify({ signer: 0, trustedCerts: facts.trust, data: new Uint8Array(facts.bytes).buffer, checkChain: true, passedWhenNotRevValues: true, extendedMode: true });
    if (typeof checked === "boolean" || checked.signatureVerified !== true || checked.signerCertificateVerified !== true || !checked.signerCertificate) refuse("timestamp_signature_or_chain_invalid");
    const signer = checked.signerCertificate;
    const eku = signer.extensions?.filter((extension) => extension.extnID === "2.5.29.37") ?? [];
    if (eku.length !== 1 || !eku[0]!.critical) refuse("timestamp_eku_invalid");
    const decoded = derSchema(eku[0]!.extnValue.valueBlock.valueHexView);
    const purposes = children(decoded);
    if (purposes.length !== 1 || !(purposes[0] instanceof asn1.ObjectIdentifier) || purposes[0].valueBlock.toString() !== "1.3.6.1.5.5.7.3.8") refuse("timestamp_eku_invalid");
    essBinding(cms, signer);
    return { tokenBase64: Buffer.from(response.timeStampToken.toSchema().toBER(false)).toString("base64"), imprint, genTime: info.genTime, serial: Buffer.from(info.serialNumber.valueBlock.valueHexView).toString("hex"), policyOid: info.policy };
  } catch (error) {
    if (error instanceof TimestampValidationError) throw error;
    return refuse("timestamp_signature_or_encoding_invalid");
  }
}
export function timestampReplyBytes(tokenBase64: string): Buffer {
  const token = new ContentInfo({ schema: derSchema(Buffer.from(tokenBase64, "base64")) });
  // A stored token was granted and verified; this reconstructed RFC 3161 reply
  // carries that token, not a new signature or a fresh timestamp.
  return Buffer.from(new TimeStampResp({ status: new PKIStatusInfo({ status: 0 }), timeStampToken: token }).toSchema().toBER(false));
}
