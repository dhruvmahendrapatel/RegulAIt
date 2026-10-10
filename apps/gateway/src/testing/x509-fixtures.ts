/**
 * TEST ONLY (ADR-0188 S5) — synthetic X.509 certificates for the decision 21
 * validator and the mTLS / SPIFFE token-endpoint tests. Every key pair is
 * generated in memory per run (WebCrypto ECDSA P-256); nothing is written to
 * disk and no private key ever appears as text in the repository.
 */
import { webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import { AttributeTypeAndValue, BasicConstraints, Certificate, Extension, GeneralName, GeneralNames, RelativeDistinguishedNames } from "pkijs";

type CryptoKeyPair = webcrypto.CryptoKeyPair;

export interface TestCert {
  cert: Certificate;
  key: CryptoKeyPair;
  der: Buffer;
  pem: string;
}

let serial = 1;
const cn = (name: string) =>
  new RelativeDistinguishedNames({ typesAndValues: [new AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: name }) })] });

/** one certificate. `issuer` absent = self-signed. */
export async function makeCert(
  opts: {
    issuer?: TestCert;
    name?: string;
    isCA?: boolean;
    /** basicConstraints pathLenConstraint (a CA only) */
    pathLen?: number;
    uris?: string[];
    keyUsage?: number;
    notBefore?: Date;
    notAfter?: Date;
  } = {},
): Promise<TestCert> {
  const key = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = new Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: serial++ });
  cert.subject = cn(opts.name ?? (opts.isCA ? `test-ca-${serial}` : `test-leaf-${serial}`));
  cert.issuer = opts.issuer?.cert.subject ?? cert.subject;
  cert.notBefore.value = opts.notBefore ?? new Date(Date.now() - 3600_000);
  cert.notAfter.value = opts.notAfter ?? new Date(Date.now() + 24 * 3600_000);
  await cert.subjectPublicKeyInfo.importKey(key.publicKey);
  const basic = new BasicConstraints({ cA: !!opts.isCA, ...(opts.pathLen !== undefined ? { pathLenConstraint: opts.pathLen } : {}) });
  cert.extensions = [new Extension({ extnID: "2.5.29.19", critical: true, extnValue: basic.toSchema().toBER(false), parsedValue: basic })];
  // key usage: CA = keyCertSign|cRLSign (0x06); leaf default digitalSignature (0x80)
  const ku = opts.keyUsage ?? (opts.isCA ? 0x06 : 0x80);
  const bits = new asn1js.BitString({ valueHex: new Uint8Array([ku]).buffer });
  cert.extensions.push(new Extension({ extnID: "2.5.29.15", critical: true, extnValue: bits.toBER(false), parsedValue: bits }));
  if (opts.uris && opts.uris.length > 0) {
    const alt = new GeneralNames({ names: opts.uris.map((value) => new GeneralName({ type: 6, value })) });
    cert.extensions.push(new Extension({ extnID: "2.5.29.17", extnValue: alt.toSchema().toBER(false), parsedValue: alt }));
  }
  await cert.sign((opts.issuer?.key ?? key).privateKey, "SHA-256");
  const der = Buffer.from(cert.toSchema().toBER(false));
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return { cert, key, der, pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n` };
}
