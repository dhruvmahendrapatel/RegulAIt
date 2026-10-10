/** Independent OpenSSL RFC 3161 authority: no network or production keys. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, createPrivateKey, webcrypto } from "node:crypto";
import path from "node:path";
import * as asn1 from "asn1js";
import { Certificate, IssuerAndSerialNumber, SignedData, TSTInfo, TimeStampResp } from "pkijs";
import { anchorCanonicalBytes, timestampRequest } from "./audit-timestamp.js";
import { derSchema, parseTimestampTrustBundle, timestampReplyBytes, verifyTimestampResponse, type TimestampRequestFacts } from "./audit-timestamp-verify.js";
import type { AnchorRecord } from "./audit-chain.js";

const dir = mkdtempSync(path.join(tmpdir(), "regulait-tsa-"));
const file = (name: string) => path.join(dir, name);
function openssl(...args: string[]) { execFileSync("openssl", args, { cwd: dir, stdio: "pipe" }); }
let trust: TimestampRequestFacts["trust"], response: Buffer, facts: TimestampRequestFacts;
const record: AnchorRecord = { seq: 1, rowHash: "a".repeat(64), headAt: new Date().toISOString(), algorithm: "sha256", payloadVersion: "regulait.audit.v1", capturedAt: new Date().toISOString() };
function issue(request: ReturnType<typeof timestampRequest>, extraConfig = "") {
  writeFileSync(file("query.der"), Buffer.from(request.request.toSchema().toBER(false)));
  writeFileSync(file("tsa.cnf"), `[tsa]\ndefault_tsa = tsa_config\n[tsa_config]\nserial = ${file("serial")}\ncrypto_device = builtin\nsigner_cert = ${file("tsa.pem")}\ncerts = ${file("ca.pem")}\nsigner_key = ${file("tsa.key")}\nsigner_digest = sha256\ndefault_policy = 1.2.3.4.5.6\nother_policies = 1.2.3.4.5.7\ndigests = sha256\naccuracy = secs:1\nordering = yes\ntsa_name = yes\ness_cert_id_chain = yes\ness_cert_id_alg = sha256\n${extraConfig}`);
  openssl("ts", "-reply", "-config", file("tsa.cnf"), "-queryfile", file("query.der"), "-out", file("response.der"));
  return readFileSync(file("response.der"));
}
async function changedToken(change: (cms: SignedData) => void, generationTime = new Date()) {
  const parsed = new TimeStampResp({ schema: derSchema(response) });
  const cms = new SignedData({ schema: parsed.timeStampToken!.content });
  change(cms);
  // Reissued test certificates can cross a one-second notBefore boundary.
  // Re-sign fresh TSTInfo and its CMS digest so chain tests isolate EKU.
  const info = new TSTInfo({ schema: derSchema(new Uint8Array(cms.encapContentInfo.eContent!.getValue())) });
  info.genTime = generationTime;
  const content = new Uint8Array(info.toSchema().toBER(false));
  cms.encapContentInfo.eContent = new asn1.OctetString({ valueHex: content.buffer });
  const digest = cms.signerInfos[0]!.signedAttrs!.attributes.find((attr) => attr.type === "1.2.840.113549.1.9.4")!;
  digest.values = [new asn1.OctetString({ valueHex: new Uint8Array(createHash("sha256").update(content).digest()).buffer })];
  cms.signerInfos[0]!.signedAttrs!.encodedValue = new ArrayBuffer(0);
  const keyBytes = createPrivateKey(readFileSync(file("tsa.key"))).export({ type: "pkcs8", format: "der" });
  const key = await webcrypto.subtle.importKey("pkcs8", new Uint8Array(keyBytes), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  await cms.sign(key, 0, "SHA-256");
  parsed.timeStampToken!.content = cms.toSchema(true);
  return Buffer.from(parsed.toSchema().toBER(false));
}
beforeAll(() => {
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-subj", "/CN=RegulAIt Synthetic TSA Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", file("ca.key"), "-out", file("ca.pem"));
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=RegulAIt Synthetic TSA", "-keyout", file("tsa.key"), "-out", file("tsa.csr"));
  writeFileSync(file("tsa-ext.cnf"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n");
  openssl("x509", "-req", "-in", file("tsa.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial", "-days", "2", "-sha256", "-extfile", file("tsa-ext.cnf"), "-out", file("tsa.pem"));
  writeFileSync(file("serial"), "01\n");
  trust = parseTimestampTrustBundle(readFileSync(file("ca.pem"), "utf8"));
  const request = timestampRequest(record);
  request.request.reqPolicy = "1.2.3.4.5.6";
  response = issue(request);
  facts = { bytes: request.bytes, nonceHex: request.nonceHex, trust, policyOid: "1.2.3.4.5.6", now: new Date(), sentAt: new Date() };
}, 30_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("RFC 3161 independent issuer verification", () => {
  it("validates OpenSSL signature, imprint, nonce, ESS certificate, chain and critical exclusive EKU", async () => {
    const result = await verifyTimestampResponse(response, facts);
    expect(result.imprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.policyOid).toBe("1.2.3.4.5.6");
    const rebuilt = timestampReplyBytes(result.tokenBase64);
    expect(new TimeStampResp({ schema: derSchema(rebuilt) }).status.status).toBe(0);
    expect((await verifyTimestampResponse(rebuilt, facts)).imprint).toBe(result.imprint);
  });
  it("requires the request time at runtime too",async()=>{
    await expect(verifyTimestampResponse(response,{...facts,sentAt:undefined} as unknown as TimestampRequestFacts)).rejects.toThrow("timestamp_generation_time_invalid");
  });
  it("R22-03: refuses a signed response older than the request window",async()=>{
    const sentAt=new Date(facts.now.getTime()+301000);
    await expect(verifyTimestampResponse(response,{...facts,now:sentAt,sentAt} as TimestampRequestFacts)).rejects.toThrow("timestamp_generation_time_invalid");
  });
  it("R22-06: preserves the original granted-with-modifications reply bytes",async()=>{
    const parsed=new TimeStampResp({schema:derSchema(response)});parsed.status.status=1;
    const original=Buffer.from(parsed.toSchema().toBER(false));
    const checked=await verifyTimestampResponse(original,facts);
    expect(timestampReplyBytes(checked.tokenBase64)).toEqual(original);
  });
  it("refuses anchor substitution, nonce replay and a different requested policy", async () => {
    await expect(verifyTimestampResponse(response, { ...facts, bytes: anchorCanonicalBytes({ ...record, rowHash: "b".repeat(64) }) })).rejects.toThrow("imprint_mismatch");
    await expect(verifyTimestampResponse(response, { ...facts, nonceHex: "010203" })).rejects.toThrow("nonce_mismatch");
    await expect(verifyTimestampResponse(response, { ...facts, policyOid: "1.2.3.4.5.7" })).rejects.toThrow("policy_mismatch");
  });
  it("refuses missing trust and tampered CMS signatures", async () => {
    await expect(verifyTimestampResponse(response, { ...facts, trust: [] })).rejects.toThrow();
    const parsed = new TimeStampResp({ schema: derSchema(response) });
    const cms = new SignedData({ schema: parsed.timeStampToken!.content });
    const bytes = new Uint8Array(cms.signerInfos[0]!.signature.valueBlock.valueHexView); bytes[0] = bytes[0]! ^ 1;
    cms.signerInfos[0]!.signature = new asn1.OctetString({ valueHex: bytes.buffer });
    parsed.timeStampToken!.content = cms.toSchema(true);
    await expect(verifyTimestampResponse(Buffer.from(parsed.toSchema().toBER(false)), facts)).rejects.toThrow();
  });
  it("refuses missing or wrong ESS binding on cryptographically valid signed tokens", async () => {
    const missing = await changedToken((cms) => {
      cms.signerInfos[0]!.signedAttrs!.attributes = cms.signerInfos[0]!.signedAttrs!.attributes.filter((attr) => !["1.2.840.113549.1.9.16.2.12", "1.2.840.113549.1.9.16.2.47"].includes(attr.type));
    });
    await expect(verifyTimestampResponse(missing, facts)).rejects.toThrow("ess_missing_or_duplicate");
    const wrong = await changedToken((cms) => {
      const attr = cms.signerInfos[0]!.signedAttrs!.attributes.find((attr) => attr.type === "1.2.840.113549.1.9.16.2.47")!;
      const root = attr.values[0] as asn1.Sequence;
      const certs = root.valueBlock.value[0] as asn1.Sequence;
      const first = certs.valueBlock.value[0] as asn1.Sequence;
      const hash = first.valueBlock.value.find((value) => value instanceof asn1.OctetString) as asn1.OctetString;
      hash.valueBlock.valueHexView[0] = hash.valueBlock.valueHexView[0]! ^ 1;
    });
    await expect(verifyTimestampResponse(wrong, facts)).rejects.toThrow("ess_certificate_mismatch");
  });
  it("refuses a chain-valid signing certificate without the critical exclusive timestamp EKU", async () => {
    for (const purpose of ["serverAuth", "timeStamping", "critical,timeStamping,serverAuth"]) {
      writeFileSync(file("bad-ext.cnf"), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${purpose}\n`);
      openssl("x509", "-req", "-in", file("tsa.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial", "-days", "2", "-sha256", "-extfile", file("bad-ext.cnf"), "-out", file("bad.pem"));
      const signer = parseTimestampTrustBundle(readFileSync(file("bad.pem"), "utf8"))[0]!;
      const wrong = await changedToken((cms) => {
        cms.certificates = [signer, ...cms.certificates!.filter((certificate) => certificate instanceof Certificate && certificate.subject.isEqual(trust[0]!.subject))];
        cms.signerInfos[0]!.sid = new IssuerAndSerialNumber({ issuer: signer.issuer, serialNumber: signer.serialNumber });
      });
      const diagnostic = new SignedData({ schema: new TimeStampResp({ schema: derSchema(wrong) }).timeStampToken!.content });
      await diagnostic.verify({ signer: 0, trustedCerts: facts.trust, data: new Uint8Array(facts.bytes).buffer, checkChain: true, passedWhenNotRevValues: true, extendedMode: true }).catch((e) => { throw new Error(`Synthetic ${purpose}: ${e.message}`); });
      await expect(verifyTimestampResponse(wrong, facts)).rejects.toThrow("eku_invalid");
    }
  });
  it("bounds DER and trust inputs and rejects trailing bytes or private PEM material", async () => {
    await expect(verifyTimestampResponse(Buffer.concat([response, Buffer.from([0])]), facts)).rejects.toThrow("der_malformed");
    await expect(verifyTimestampResponse(Buffer.alloc(1024 * 1024 + 1), facts)).rejects.toThrow("der_size");
    expect(() => parseTimestampTrustBundle("-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----")).toThrow("trust_bundle_invalid");
  });
});
