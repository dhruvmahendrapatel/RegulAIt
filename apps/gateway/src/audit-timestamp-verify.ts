/** RFC 3161 validation. No HTTP, AIA, OCSP or CRL retrieval occurs here. */
import { createHash } from "node:crypto";
import * as asn1 from "asn1js";
import { ESSCertIDv2, SigningCertificate, SigningCertificateV2 } from "@peculiar/asn1-ess";
import { AlgorithmIdentifier as EssAlgorithmIdentifier } from "@peculiar/asn1-x509";
import { AsnProp, AsnConvert } from "@peculiar/asn1-schema";
import { AlgorithmIdentifier as PkiAlgorithmIdentifier, Certificate, ContentInfo, ExtKeyUsage, PKIStatusInfo, RelativeDistinguishedNames, RSASSAPSSParams, SignedData, TSTInfo, TimeStampResp, type SignerInfo } from "pkijs";

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
// asn1-ess 2.10.0 represents the default algorithm as optional ANY. With
// OpenSSL's omitted SHA-256 it consumes certHash instead. Preserve the library
// schema, making this one optional field a typed SEQUENCE before decoding.
class TimestampEssCertIdV2 extends ESSCertIDv2 {}
AsnProp({type:EssAlgorithmIdentifier,optional:true})(TimestampEssCertIdV2.prototype,"hashAlgorithm");
class TimestampSigningCertificateV2 extends SigningCertificateV2 {}
AsnProp({type:TimestampEssCertIdV2,repeated:"sequence"})(TimestampSigningCertificateV2.prototype,"certs");
function essBinding(cms: SignedData, signer: Certificate) {
 const bindings=(cms.signerInfos[0]?.signedAttrs?.attributes??[]).filter(attr=>attr.type===ESS_V1||attr.type===ESS_V2);
 if(bindings.length!==1||bindings[0]!.values.length!==1)refuse("timestamp_ess_missing_or_duplicate");
 const attr=bindings[0]!;
 const der=attr.values[0]!.toBER(false);
 const certs=attr.type===ESS_V1?AsnConvert.parse(der,SigningCertificate).certs:AsnConvert.parse(der,TimestampSigningCertificateV2).certs;
 const first=certs[0];if(!first)refuse("timestamp_ess_invalid");
 const oid=first instanceof ESSCertIDv2?first.hashAlgorithm?.algorithm??TSA_SHA256_OID:null;
 const hashes:Record<string,string>={[TSA_SHA256_OID]:"sha256","2.16.840.1.101.3.4.2.2":"sha384","2.16.840.1.101.3.4.2.3":"sha512"};
 const algorithm=attr.type===ESS_V1?"sha1":hashes[oid!]??refuse("timestamp_ess_hash_unsupported");
 if(!Buffer.from(first.certHash.buffer).equals(createHash(algorithm).update(Buffer.from(signer.toSchema(true).toBER(false))).digest()))refuse("timestamp_ess_certificate_mismatch");
 if(first.issuerSerial){
  const issuer=first.issuerSerial;
  if(!new asn1.Integer({valueHex:issuer.serialNumber}).isEqual(signer.serialNumber))refuse("timestamp_ess_issuer_mismatch");
  if(!issuer.issuer.some(name=>name.directoryName&&new RelativeDistinguishedNames({schema:derSchema(new Uint8Array(AsnConvert.serialize(name.directoryName)))}).isEqual(signer.issuer)))refuse("timestamp_ess_issuer_mismatch");
 }
}

// ADR-0186 decision 30 item 5: the hash a CMS signature is computed with comes from the signer's EFFECTIVE
// signatureAlgorithm; digestAlgorithm only governs the messageDigest attribute. Only SHA-2 forms are accepted,
// and the signature's hash must be the digest algorithm's hash.
const SHA2_OIDS: Readonly<Record<string, string>> = { [TSA_SHA256_OID]: "sha256", "2.16.840.1.101.3.4.2.2": "sha384", "2.16.840.1.101.3.4.2.3": "sha512" };
const RSA_ENCRYPTION = "1.2.840.113549.1.1.1", RSASSA_PSS = "1.2.840.113549.1.1.10", MGF1 = "1.2.840.113549.1.1.8";
const SIGNATURE_HASHES: Readonly<Record<string, string>> = {
  "1.2.840.113549.1.1.11": "sha256", "1.2.840.113549.1.1.12": "sha384", "1.2.840.113549.1.1.13": "sha512", // shaNNNWithRSAEncryption
  "1.2.840.10045.4.3.2": "sha256", "1.2.840.10045.4.3.3": "sha384", "1.2.840.10045.4.3.4": "sha512", // ecdsa-with-SHANNN
};
export function timestampSignatureHash(signer: SignerInfo): string {
  const digest = SHA2_OIDS[signer.digestAlgorithm.algorithmId] ?? refuse("timestamp_signature_hash_unsupported");
  const { algorithmId, algorithmParams } = signer.signatureAlgorithm;
  let effective: string | undefined;
  if (algorithmId === RSA_ENCRYPTION) effective = digest; // RFC 5754 section 3.2: the hash is the digestAlgorithm's
  else if (algorithmId === RSASSA_PSS) {
    // Absent PSS parameters mean RFC 4055's SHA-1 defaults; the library materialises them, so they refuse below.
    let params: RSASSAPSSParams;
    try { params = new RSASSAPSSParams(algorithmParams ? { schema: algorithmParams } : {}); } catch { return refuse("timestamp_signature_algorithm_unsupported"); }
    const hash = SHA2_OIDS[params.hashAlgorithm.algorithmId];
    let mgfHash: string | undefined;
    try {
      mgfHash = params.maskGenAlgorithm.algorithmId === MGF1 && params.maskGenAlgorithm.algorithmParams
        ? SHA2_OIDS[new PkiAlgorithmIdentifier({ schema: params.maskGenAlgorithm.algorithmParams }).algorithmId]
        : undefined;
    } catch { mgfHash = undefined; }
    if (!hash || mgfHash !== hash || params.trailerField !== 1) refuse("timestamp_signature_algorithm_unsupported");
    effective = hash;
  } else effective = SIGNATURE_HASHES[algorithmId];
  if (!effective) refuse("timestamp_signature_algorithm_unsupported");
  if (effective !== digest) refuse("timestamp_signature_hash_mismatch");
  return effective;
}

export interface TimestampRequestFacts { bytes: Uint8Array; nonceHex: string; trust: Certificate[]; policyOid?: string; now: Date; sentAt: Date }
export async function verifyTimestampResponse(der: Uint8Array, facts: TimestampRequestFacts) {
  try {
    const response = new TimeStampResp({ schema: derSchema(der) });
    if (![0, 1].includes(response.status.status) || !response.timeStampToken || response.timeStampToken.contentType !== "1.2.840.113549.1.7.2") refuse("timestamp_not_granted");
    const cms = new SignedData({ schema: response.timeStampToken.content });
    if (cms.signerInfos.length !== 1 || !cms.certificates?.length || cms.certificates.length > 32 || (cms.signerInfos[0]?.signedAttrs?.attributes.length ?? 0) > 32 || cms.encapContentInfo.eContentType !== TST_INFO_OID || !cms.encapContentInfo.eContent) refuse("timestamp_token_structure");
    const info = new TSTInfo({ schema: derSchema(new Uint8Array(cms.encapContentInfo.eContent.getValue())) });
    timestampSignatureHash(cms.signerInfos[0]!);
    const imprint = createHash("sha256").update(facts.bytes).digest("hex");
    if (info.version !== 1 || info.messageImprint.hashAlgorithm.algorithmId !== TSA_SHA256_OID || Buffer.from(info.messageImprint.hashedMessage.valueBlock.valueHexView).toString("hex") !== imprint) refuse("timestamp_imprint_mismatch");
    if (!info.nonce || Buffer.from(info.nonce.valueBlock.valueHexView).toString("hex") !== facts.nonceHex) refuse("timestamp_nonce_mismatch");
    if (facts.policyOid && info.policy !== facts.policyOid) refuse("timestamp_policy_mismatch");
    if (!Number.isFinite(info.genTime.getTime()) || info.genTime.getTime() > facts.now.getTime() + 300_000 || (!facts.sentAt || !Number.isFinite(facts.sentAt.getTime()) || info.genTime.getTime() < facts.sentAt.getTime() - 300_000)) refuse("timestamp_generation_time_invalid");
    // Chain at the signed generation time. All issuers must be in the token or
    // explicitly configured trust bundle. Revocation is not claimed: this
    // air-gapped validator never contacts certificate-controlled URLs.
    const checked = await cms.verify({ signer: 0, trustedCerts: facts.trust, data: new Uint8Array(facts.bytes).buffer, checkChain: true, passedWhenNotRevValues: true, extendedMode: true });
    if (typeof checked === "boolean" || checked.signatureVerified !== true || checked.signerCertificateVerified !== true || !checked.signerCertificate) refuse("timestamp_signature_or_chain_invalid");
    const signer = checked.signerCertificate;
    const eku = signer.extensions?.filter((extension) => extension.extnID === "2.5.29.37") ?? [];
    if (eku.length !== 1 || !eku[0]!.critical) refuse("timestamp_eku_invalid");
    const purposes = eku[0]!.parsedValue;
    if (!(purposes instanceof ExtKeyUsage) || purposes.keyPurposes.length !== 1 || purposes.keyPurposes[0] !== "1.3.6.1.5.5.7.3.8") refuse("timestamp_eku_invalid");
    essBinding(cms, signer);
    return { tokenBase64: Buffer.from(der).toString("base64"), imprint, genTime: info.genTime, serial: Buffer.from(info.serialNumber.valueBlock.valueHexView).toString("hex"), policyOid: info.policy };
  } catch (error) {
    if (error instanceof TimestampValidationError) throw error;
    return refuse("timestamp_signature_or_encoding_invalid");
  }
}
export function timestampReplyBytes(tokenBase64: string): Buffer {
  const bytes=Buffer.from(tokenBase64,"base64");
  const schema=derSchema(bytes);
  // New records retain the original complete reply, including granted status 1.
  try{const original=new TimeStampResp({schema});if([0,1].includes(original.status.status)&&original.timeStampToken)return bytes;}catch{/* Legacy stored CMS token. */}
  const token = new ContentInfo({ schema });
  // A stored token was granted and verified; this reconstructed RFC 3161 reply
  // carries that token, not a new signature or a fresh timestamp.
  return Buffer.from(new TimeStampResp({ status: new PKIStatusInfo({ status: 0 }), timeStampToken: token }).toSchema().toBER(false));
}
