import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { decodeProtectedHeader, decodeJwt, importJWK, jwtVerify, calculateJwkThumbprint } from 'jose';
import * as oauth from 'oauth4webapi';
import { claim } from './store.mjs';

export const now = () => Math.floor(Date.now() / 1000);
export const hash = value => createHash('sha256').update(value).digest('base64url');
export function nonce(secret, at = now()) {
  const slot = Math.floor(at / 300);
  return `${slot}.${createHmac('sha256', secret).update(String(slot)).digest('base64url')}`;
}
export function validNonce(value, secret) {
  const expected = nonce(secret);
  return typeof value === 'string' && value.length === expected.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
export function fresh(payload, secret) {
  if (!Number.isInteger(payload.iat) || payload.iat < now() - 60 || payload.iat > now() + 5 ||
      typeof payload.jti !== 'string' || !payload.jti || !validNonce(payload.nonce, secret)) {
    throw new Error('freshness_nonce');
  }
}
// This spike uses canonical JSON for fixture objects, not the product's RFC8785 implementation.
// Fixtures contain strings, arrays and integers only; product S3 must use its pinned canonicalizer.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function signedToken(token, { issuer, audience, keys }) {
  const header = decodeProtectedHeader(token);
  const jwk = keys.find(k => k.kid === header.kid && ['ES256', 'EdDSA'].includes(k.alg));
  if (!jwk) throw new Error('unknown_kid');
  return (await jwtVerify(token, await importJWK(jwk), {
    issuer, audience, algorithms: ['ES256', 'EdDSA'], typ: 'at+jwt',
  })).payload;
}
export async function liveToken(pool, payload, kind, thumbprint, audience) {
  if (payload.env !== 'fixture') throw new Error('environment');
  const { rows } = await pool.query(`SELECT * FROM s0_tokens WHERE jti=$1 AND NOT revoked`, [payload.jti]);
  const row = rows[0];
  if (!row || row.grant_id !== payload.grant_id || row.binding_kind !== kind || row.thumbprint !== thumbprint ||
      row.audience !== audience || row.env !== payload.env) throw new Error('issued_binding');
  const r = await pool.query(`WITH RECURSIVE path AS (
    SELECT * FROM s0_grants WHERE id=$1 UNION ALL SELECT p.* FROM s0_grants p JOIN path c ON c.parent_id=p.id
  ) SELECT count(*)::int AS n, bool_and(g.active AND i.active AND c.active AND s.active) AS live
  FROM path g JOIN s0_identities i ON i.id=g.identity_id JOIN s0_credentials c ON c.id=g.credential_id
  JOIN s0_sponsors s ON s.id=g.sponsor_id`, [row.grant_id]);
  if (!r.rows[0]?.n || !r.rows[0].live) throw new Error('live_chain');
  return payload;
}
export function binding(payload) {
  const cnf = payload.cnf;
  if (!cnf || typeof cnf !== 'object' || Object.keys(cnf).length !== 1) throw new Error('binding');
  if (typeof cnf.jkt === 'string' && cnf.jkt) return ['dpop', cnf.jkt];
  if (typeof cnf['x5t#S256'] === 'string' && cnf['x5t#S256']) return ['mtls', cnf['x5t#S256']];
  throw new Error('binding');
}
export async function verifyResource(request, options, certificateValidator) {
  const { pool, issuer, audience, keys, nonceSecret } = options;
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.split(' ')[1];
  const payload = await signedToken(token, options);
  const [kind, thumbprint] = binding(payload);
  if (kind === 'dpop') {
    // customFetch returns locally uploaded keys. No outbound HTTP is made.
    await oauth.validateJwtAccessToken({ issuer, jwks_uri: 'https://local-keys.example.test/jwks' }, request, audience, {
      requireDPoP: true,
      [oauth.customFetch]: async () => new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } }),
    });
    const proof = decodeJwt(request.headers.get('dpop'));
    fresh(proof, nonceSecret);
    await liveToken(pool, payload, kind, thumbprint, audience);
    if (!await claim(pool, 'rs_dpop', `${thumbprint}:${proof.jti}`, now() + 360)) throw new Error('replay');
  } else {
    if (!auth.startsWith('Bearer ') || request.headers.has('dpop') || !certificateValidator) throw new Error('mtls');
    const cert = await certificateValidator();
    if (hash(cert) !== thumbprint) throw new Error('certificate_binding');
    await liveToken(pool, payload, kind, thumbprint, audience);
  }
  return payload;
}
export async function verifyParentAuthorization(parentToken, authorization, params, child, childJkt, options) {
  const parent = await signedToken(parentToken, options);
  const [kind, jkt] = binding(parent);
  if (kind !== 'dpop') throw new Error('mtls_parent_handoff_unsupported');
  const header = decodeProtectedHeader(authorization);
  if (header.jwk?.d || !['ES256', 'EdDSA'].includes(header.alg) || await calculateJwkThumbprint(header.jwk) !== jkt) throw new Error('parent_key');
  const { payload } = await jwtVerify(authorization, await importJWK(header.jwk), {
    algorithms: ['ES256', 'EdDSA'], typ: 'regulait-delegation-authz+jwt', issuer: parent.client_id, audience: options.issuer,
  });
  fresh(payload, options.nonceSecret);
  if (payload.htm !== 'POST' || payload.htu !== `${options.issuer}/token` || payload.ath !== hash(parentToken) ||
      payload.parent_grant_id !== parent.grant_id || payload.child !== child || payload.child_cnf !== childJkt ||
      payload.delegation !== canonical(params) || payload.idempotency_key !== params.idempotency_key) throw new Error('child_binding');
  await liveToken(options.pool, parent, kind, jkt, options.audience);
  return payload;
}
