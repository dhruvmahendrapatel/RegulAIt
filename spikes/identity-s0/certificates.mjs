import { webcrypto, timingSafeEqual } from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
pkijs.setEngine('s0', webcrypto, new pkijs.CryptoEngine({ name: 's0', crypto: webcrypto, subtle: webcrypto.subtle }));

const cn = name => new pkijs.RelativeDistinguishedNames({ typesAndValues: [new pkijs.AttributeTypeAndValue({
  type: '2.5.4.3', value: new asn1js.Utf8String({ value: name }),
})] });
let serial = 1;
export async function certificate({ issuer, sans = ['spiffe://fixture.test/agent/child-b'], dns = [],
  isCA = false, digitalSignature = true, notBefore = new Date(Date.now() - 60000),
  notAfter = new Date(Date.now() + 3600000) } = {}) {
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const cert = new pkijs.Certificate();
  cert.version = 2; cert.serialNumber = new asn1js.Integer({ value: serial++ });
  cert.subject = cn(isCA ? `fixture-ca-${serial}` : `fixture-leaf-${serial}`);
  cert.issuer = issuer?.cert.subject ?? cert.subject;
  cert.notBefore.value = notBefore; cert.notAfter.value = notAfter;
  await cert.subjectPublicKeyInfo.importKey(key.publicKey);
  const basic = new pkijs.BasicConstraints({ cA: isCA });
  cert.extensions = [new pkijs.Extension({ extnID: '2.5.29.19', critical: true,
    extnValue: basic.toSchema().toBER(false), parsedValue: basic })];
  const bits = new asn1js.BitString({ valueHex: new Uint8Array([isCA ? 0x06 : digitalSignature ? 0x80 : 0x10]).buffer });
  cert.extensions.push(new pkijs.Extension({ extnID: '2.5.29.15', critical: true, extnValue: bits.toBER(false), parsedValue: bits }));
  if (!isCA) {
    const alt = new pkijs.GeneralNames({ names: [...sans.map(value => new pkijs.GeneralName({ type: 6, value })),
      ...dns.map(value => new pkijs.GeneralName({ type: 2, value }))] });
    cert.extensions.push(new pkijs.Extension({ extnID: '2.5.29.17', extnValue: alt.toSchema().toBER(false), parsedValue: alt }));
  }
  await cert.sign(issuer?.key.privateKey ?? key.privateKey, 'SHA-256');
  return { cert, key, der: Buffer.from(cert.toSchema().toBER(false)) };
}
export function parse(der) { return new pkijs.Certificate({ schema: asn1js.fromBER(der).result }); }
export async function validateSvid(leafDer, trustedDer, expectedId, at = new Date(), intermediates = []) {
  const leaf = parse(leafDer), trusted = trustedDer.map(parse);
  const result = await new pkijs.CertificateChainValidationEngine({ trustedCerts: trusted, certs: [leaf, ...intermediates.map(parse)], checkDate: at }).verify();
  if (!result.result) throw new Error('certificate_path');
  if (leaf.notBefore.value > at || leaf.notAfter.value < at) throw new Error('certificate_time');
  const basic = leaf.extensions?.find(e => e.extnID === '2.5.29.19')?.parsedValue;
  if (basic?.cA) throw new Error('leaf_ca');
  const usage = leaf.extensions?.find(e => e.extnID === '2.5.29.15');
  const bits = usage && asn1js.fromBER(usage.extnValue.valueBlock.valueHexView).result;
  if (!bits?.valueBlock.valueHexView?.length || !(bits.valueBlock.valueHexView[0] & 0x80)) throw new Error('digital_signature');
  const names = leaf.extensions?.find(e => e.extnID === '2.5.29.17')?.parsedValue?.altNames ?? [];
  const uri = names.filter(n => n.type === 6);
  if (uri.length !== 1 || uri[0].value !== expectedId) throw new Error('spiffe_san');
  const id = new URL(uri[0].value);
  if (id.protocol !== 'spiffe:' || id.hostname !== 'fixture.test' || id.username || id.password || id.port || id.search || id.hash) throw new Error('spiffe_profile');
  return leafDer;
}
export function forwardedCertificate(headers, { configuredHeader, trustedPeer, authenticatedProxy, expectedSecret }) {
  // Explicit fixture booleans are injected transport facts, never read from caller headers.
  // Product S5 must establish peer membership and proxy mTLS itself.
  if (!configuredHeader || !trustedPeer) return undefined;
  const secret = headers.get('x-s0-proxy-secret');
  const secretMatches = typeof secret === 'string' && typeof expectedSecret === 'string' && secret.length === expectedSecret.length &&
    timingSafeEqual(Buffer.from(secret), Buffer.from(expectedSecret));
  if (!authenticatedProxy && !secretMatches) return undefined;
  const encoded = headers.get(configuredHeader);
  return encoded ? Buffer.from(encoded, 'base64') : undefined;
}
