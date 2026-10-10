import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpsRequest } from 'node:https';
import { webcrypto } from 'node:crypto';
import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Provider from 'oidc-provider';
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint, decodeJwt, jwtVerify, importJWK } from 'jose';
import * as oauth from 'oauth4webapi';
import { createDb, runMigrations, orgSettings, ORG_SETTINGS_ID, eq, users, authSessions } from '../../packages/db/dist/index.js';
import { hash, now, nonce, canonical, verifyResource, verifyParentAuthorization } from './verify.mjs';
import { replica, exchange, accessType, rootType, actorType, delegationParams } from './server.mjs';
import { schema, adapterFor, requestState } from './store.mjs';
import { certificate, validateSvid, forwardedCertificate } from './certificates.mjs';

const base = process.env.S0_DATABASE_URL;
if (!base) throw new Error('Set S0_DATABASE_URL to a local Postgres URL with CREATE DATABASE permission. The base database is never reset.');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('S0 scratch database must use a loopback Postgres server');
const dbName = `regulait_s0_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: base });
const conn = new URL(base); conn.pathname = `/${dbName}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const audience = 'https://resource.example.test', nonceSecret = 'synthetic-s0-shared-nonce-secret';
const bootHeaders = { authorization: 'Bearer synthetic-s0-bootstrap' };
let db, pools = [], replicas = [], issuer, issuerKey, issuerJwk, childKeys = {}, clients, rootCA, leaf;
let created = false;
const state = () => ({ pool: pools[0], issuer, audience, keys: [issuerJwk], nonceSecret });
const delegation = () => ({ authorization_details: [{ type: 'regulait', actions: ['read'] }], resource: audience,
  project_id: 'fixture-project', env: 'fixture', cap_micros: '100', max_depth: '2', expires_at: String(now() + 300), idempotency_key: randomUUID() });
const clientJkt = id => calculateJwkThumbprint(childKeys[id].publicJwk);
async function signProof(id, fields, typ = 'dpop+jwt') {
  return new SignJWT({ iat: now(), nonce: nonce(nonceSecret), jti: randomUUID(), ...fields })
    .setProtectedHeader({ alg: childKeys[id].publicJwk.alg, typ, jwk: childKeys[id].publicJwk }).sign(childKeys[id].privateKey);
}
async function assertion(id = 'child-b', extra = {}) {
  return new SignJWT({ iss: id, sub: id, aud: `${issuer}/token`, jti: randomUUID(), iat: now(), exp: now() + 60, ...extra })
    .setProtectedHeader({ alg: childKeys[id].publicJwk.alg, kid: `${id}-key` }).sign(childKeys[id].privateKey);
}
async function rootProof(id, d) {
  return new SignJWT({ child: id, child_cnf: await clientJkt(id), delegation: canonical(d) })
    .setProtectedHeader({ alg: 'ES256', typ: 'regulait-delegation-proof+jwt', kid: issuerJwk.kid })
    .setIssuer(issuer).setAudience(issuer).setJti(randomUUID()).setIssuedAt().setExpirationTime('120s').sign(issuerKey.privateKey);
}
async function requestBody(id = 'child-b', overrides = {}) {
  const d = overrides.delegation ?? delegation();
  const p = { ...d, authorization_details: JSON.stringify(d.authorization_details), grant_type: exchange,
    requested_token_type: accessType, client_id: id, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await assertion(id), subject_token: await rootProof(id, d), subject_token_type: rootType, ...overrides };
  delete p.delegation;
  return { p, body: new URLSearchParams(p), proof: await signProof(id, { htm: 'POST', htu: `${issuer}/token` }) };
}
async function exchangeAt(replicaIndex = 0, request, extraHeaders = {}) {
  request ??= await requestBody();
  const r = await fetch(`${replicas[replicaIndex].address}/oauth/token`, {
    method: 'POST', headers: { ...bootHeaders, DPoP: request.proof, ...extraHeaders }, body: request.body,
  });
  const result = await r.json();
  return { status: r.status, result, nonce: r.headers.get('dpop-nonce') };
}
async function mint() {
  const r = await exchangeAt();
  assert.equal(r.status, 200, JSON.stringify(r.result));
  return r.result.access_token;
}
async function resourceProof(token, fields = {}, id = 'child-b') {
  return signProof(id, { htm: 'POST', htu: `${audience}/call`, ath: hash(token), ...fields });
}
async function resourceAt(index, token, proof, fields = {}) {
  const r = await fetch(`${replicas[index].address}/s0/resource`, { method: 'POST', headers: {
    ...bootHeaders, 'content-type': 'application/json', 'x-s0-authorization': `DPoP ${token}`, DPoP: proof, ...fields,
  }, body: '{}' });
  return r.status;
}

before(async () => {
  await adminPool.query(`CREATE DATABASE ${dbName}`); created = true;
  db = createDb(conn.href);
  await runMigrations(db, path.join(root, 'packages/db/migrations'));
  await db.$client.query(schema);
  for (let i = 0; i < 2; i++) pools.push(new pg.Pool({ connectionString: conn.href }));
  issuerKey = await generateKeyPair('ES256', { extractable: true });
  issuerJwk = { ...await exportJWK(issuerKey.privateKey), alg: 'ES256', kid: 's0-issuer' };
  clients = [];
  for (const id of ['child-b', 'child-c', 'child-d']) {
    const alg = id === 'child-d' ? 'EdDSA' : 'ES256';
    const pair = await generateKeyPair(alg, { extractable: true });
    const publicJwk = { ...await exportJWK(pair.publicKey), kid: `${id}-key`, alg };
    childKeys[id] = { ...pair, publicJwk };
    clients.push({ client_id: id, id_token_signed_response_alg: 'ES256', token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: alg,
      jwks: { keys: [publicJwk] }, grant_types: [exchange], response_types: [], redirect_uris: [] });
  }
  await pools[0].query(`INSERT INTO s0_sponsors(id) VALUES('fixture-human');
    INSERT INTO s0_identities(id) VALUES('child-b'),('child-c'),('child-d');
    INSERT INTO s0_credentials(id) VALUES('child-b-credential'),('child-c-credential'),('child-d-credential')`);
  for (let i = 0; i < 2; i++) {
    const r = await replica({ db, pool: pools[i], clients, signingKey: issuerKey.privateKey, issuerJwk, issuer, nonceSecret, audience });
    issuer ??= r.issuer; replicas.push(r);
    r.app.s0Verify = req => {
      // An explicit test-only bridge: transport is bootstrap-authenticated by real gateway hooks;
      // the external delegated credential is then verified by the proposed RS wrapper.
      const headers = new Headers({ authorization: req.headers['x-s0-authorization'] ?? '', dpop: req.headers.dpop ?? '' });
      return verifyResource(new Request(`${audience}/call`, { method: 'POST', headers }), { ...state(), pool: pools[i], keys: [publicIssuerKey()] });
    };
  }
  rootCA = await certificate({ isCA: true });
  leaf = await certificate({ issuer: rootCA });
});
const publicIssuerKey = () => { const { d, ...jwk } = issuerJwk; return jwk; };
after(async () => {
  for (const r of replicas) { await r.app.close(); await Promise.all(r.auditWrites); }
  for (const p of pools) await p.end();
  await db?.$client.end();
  if (created) await adminPool.query(`DROP DATABASE ${dbName}`);
  await adminPool.end();
});

test('exact-pinned provider/helper contract and workspace isolation', async () => {
  const manifest = JSON.parse(await readFile(new URL('node_modules/oidc-provider/package.json', import.meta.url)));
  assert.equal(manifest.version, '9.12.2');
  const source = await readFile(new URL('node_modules/oidc-provider/lib/models/replay_detection.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await this.find(id)') < source.indexOf('await inst.save('));
  const helpers = await import('oidc-provider/lib/helpers/grants.js');
  assert.equal(typeof helpers.checkDpopReplay, 'function'); assert.equal(typeof helpers.buildTokenResponse, 'function');
  assert.throws(() => helpers.buildTokenResponse(replicas[0].provider, { accessToken: 'synthetic', tokenType: 'DPoP', parameters: { access_token: 'shadow' } }));
  assert.equal((await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).includes('spikes/'), false);
});
test('red control: ordinary Postgres upsert accepts the same jti on two providers', async () => {
  let n = 0, release; const gate = new Promise(r => release = r);
  const barrier = async () => { if (++n === 2) release(); await gate; };
  const cfg = i => ({ clients: [], adapter: adapterFor(pools[i], { atomic: false, barrier }), jwks: { keys: [issuerJwk] }, features: { devInteractions: { enabled: false } } });
  const a = new Provider(issuer, cfg(0)), b = new Provider(issuer, cfg(1));
  assert.deepEqual(await Promise.all([a.ReplayDetection.unique('fixture-red', 'one-jti', now() + 60),
    b.ReplayDetection.unique('fixture-red', 'one-jti', now() + 60)]), [true, true]);
});
test('provider grant state persists across independent Postgres adapters and replicas', async () => {
  const grant = new replicas[0].provider.Grant({ accountId: 'fixture-human', clientId: 'child-b' });
  const id = await grant.save();
  const found = await replicas[1].provider.Grant.find(id);
  assert.equal(found.accountId, 'fixture-human'); assert.equal(found.clientId, 'child-b');
  await found.destroy(); assert.equal(await replicas[0].provider.Grant.find(id), undefined);
});
test('provider assertion replay race: exactly one 200 and one invalid_client across replicas', async () => {
  const a = await requestBody(), b = await requestBody();
  b.p.client_assertion = a.p.client_assertion; b.body = new URLSearchParams(b.p);
  const r = await Promise.all([exchangeAt(0, a), exchangeAt(1, b)]);
  assert.deepEqual(r.map(x => x.status).sort(), [200, 401], JSON.stringify(r));
  assert.equal(r.find(x => x.status === 401).result.error, 'invalid_client');
});
test('provider AS DPoP replay race: exactly one success and one invalid_dpop_proof', async () => {
  const a = await requestBody(), b = await requestBody(); b.proof = a.proof;
  const r = await Promise.all([exchangeAt(0, a), exchangeAt(1, b)]);
  assert.deepEqual(r.map(x => x.status).sort(), [200, 400], JSON.stringify(r));
  assert.equal(r.find(x => x.status === 400).result.error, 'invalid_dpop_proof');
});
test('root proof race is one-use independently of client assertions and DPoP', async () => {
  const a = await requestBody(), b = await requestBody('child-b', { ...a.p, client_assertion: await assertion() });
  const r = await Promise.all([exchangeAt(0, a), exchangeAt(1, b)]);
  assert.deepEqual(r.map(x => x.status).sort(), [200, 400], JSON.stringify(r));
  assert.equal(r.find(x => x.status === 400).result.error, 'invalid_grant');
});
test('later grant failure cannot roll back the winning replay claim', async () => {
  const failing = await replica({ db, pool: pools[0], clients, signingKey: issuerKey.privateKey, issuerJwk, issuer, nonceSecret, audience, mode: 'failure' });
  replicas.push(failing);
  const req = await requestBody();
  assert.equal((await exchangeAt(replicas.length - 1, req)).result.error, 'invalid_grant');
  assert.equal((await exchangeAt(1, req)).result.error, 'invalid_client');
});
test('bounded callback timeout closes the request and prevents late token creation', async () => {
  const timed = await replica({ db, pool: pools[0], clients, signingKey: issuerKey.privateKey, issuerJwk, issuer, nonceSecret, audience, mode: 'timeout' });
  replicas.push(timed);
  const before = (await pools[0].query('SELECT count(*)::int n FROM s0_tokens')).rows[0].n;
  const req = await requestBody();
  await assert.rejects(exchangeAt(replicas.length - 1, req));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await pools[0].query('SELECT count(*)::int n FROM s0_tokens')).rows[0].n, before);
  assert.equal((await exchangeAt(0, req)).result.error, 'invalid_client');
});
test('root exchange binds output to the child key and rebuilds actor chain', async () => {
  const token = await mint(), payload = decodeJwt(token);
  assert.equal(payload.client_id, 'child-b'); assert.equal(payload.cnf.jkt, await clientJkt('child-b'));
  assert.equal(payload.sub, 'fixture-human'); assert.deepEqual(payload.act, { sub: 'child-b' });
});
test('EdDSA client assertion and output DPoP binding work through the provider and RS HTTP wrapper', async () => {
  const r = await exchangeAt(1, await requestBody('child-d'));
  assert.equal(r.status, 200, r.result.error);
  assert.equal(decodeJwt(r.result.access_token).cnf.jkt, await clientJkt('child-d'));
  assert.equal(await resourceAt(0, r.result.access_token, await resourceProof(r.result.access_token, {}, 'child-d')), 200);
});
for (const [label, fields] of [ ['missing nonce', { nonce: undefined }], ['stale nonce', { nonce: nonce(nonceSecret, now() - 600) }],
  ['61-second-old proof', { iat: now() - 61 }], ['future proof', { iat: now() + 10 }], ['wrong method', { htm: 'GET' }],
  ['wrong endpoint', { htu: `${audience}/wrong` }] ]) {
  test(`AS refuses ${label}`, async () => {
    const req = await requestBody(); req.proof = await signProof('child-b', { htm: 'POST', htu: `${issuer}/token`, ...fields,
      ...(label === 'future proof' ? { iat: now() + 10 } : {}) });
    assert.equal((await exchangeAt(0, req)).result.error, label.includes('nonce') ? 'use_dpop_nonce' : 'invalid_dpop_proof');
  });
}
test('nonce challenge from replica A retries successfully at replica B without consuming the assertion', async () => {
  const req = await requestBody(); req.proof = await signProof('child-b', { htm: 'POST', htu: `${issuer}/token`, nonce: undefined });
  const challenge = await exchangeAt(0, req);
  assert.equal(challenge.result.error, 'use_dpop_nonce'); assert.equal(typeof challenge.nonce, 'string');
  req.proof = await signProof('child-b', { htm: 'POST', htu: `${issuer}/token`, nonce: challenge.nonce });
  assert.equal((await exchangeAt(1, req)).status, 200);
});
test('duplicate OAuth parameter is refused before custom grant', async () => {
  const req = await requestBody(); req.body.append('subject_token', req.p.subject_token);
  assert.equal((await exchangeAt(0, req)).result.error, 'invalid_request');
});
test('5-minute assertion bound is enforced by provider callback', async () => {
  const req = await requestBody(); req.p.client_assertion = await assertion('child-b', { exp: now() + 600 }); req.body = new URLSearchParams(req.p);
  assert.equal((await exchangeAt(0, req)).result.error, 'invalid_client');
});
test('real gateway auth and body-size hooks precede the Koa callback', async () => {
  const req = await requestBody();
  assert.equal((await exchangeAt(0, req, { authorization: '' })).status, 401);
  const r = await fetch(`${replicas[0].address}/oauth/token`, { method: 'POST', headers: { ...bootHeaders,
    'content-type': 'application/x-www-form-urlencoded' }, body: 'x='.padEnd(17000, 'a') });
  assert.equal(r.status, 413);
  assert.ok(replicas[0].hookVisits.preHandler > 0);
});
test('real gateway route class and session CSRF hooks remain in force', async () => {
  await db.update(orgSettings).set({ mfaRequired: 'off' }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const uid = randomUUID(), sid = `synthetic-session-${randomUUID()}`;
  await db.insert(users).values({ id: uid, email: `s0-${uid}@example.test`, displayName: 'Synthetic fixture', isAdmin: false });
  await db.insert(authSessions).values({ tokenHash: hashHex(sid), userId: uid, origin: 'password', idleMinutes: 10,
    expiresAt: new Date(Date.now() + 600000), idleExpiresAt: new Date(Date.now() + 600000) });
  const req = await requestBody();
  const send = headers => fetch(`${replicas[0].address}/oauth/token`, { method: 'POST', body: req.body,
    headers: { cookie: `regulait_session=${sid}`, ...headers } });
  const noCsrf = await send({}); assert.equal(noCsrf.status, 403); assert.equal((await noCsrf.json()).error, 'csrf_header_required');
  const noAdmin = await send({ 'x-regulait-csrf': '1' }); assert.equal(noAdmin.status, 403); assert.equal((await noAdmin.json()).error, 'admin_only');
});
function hashHex(s) { return Buffer.from(hash(s), 'base64url').toString('hex'); }
test('real Postgres-backed gateway IP limiter rejects before provider', async () => {
  const limited = await replica({ db, pool: pools[0], clients, signingKey: issuerKey.privateKey, issuerJwk, issuer, nonceSecret, audience });
  replicas.push(limited);
  // Existing global bucket is intentionally filled via its actual gateway API to its configured ceiling.
  const limit = 1000;
  let refused = false;
  for (let i = 0; i < limit + 1; i++) {
    const r = await limited.app.inject({ method: 'GET', url: '/v1/me', headers: bootHeaders });
    if (r.statusCode === 429) { refused = true; break; }
  }
  assert.ok(refused);
  const r = await limited.app.inject({ method: 'POST', url: '/oauth/token',
    payload: 'grant_type=invalid', headers: { ...bootHeaders, 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.statusCode, 429);
  // Reset only this scratch database's limiter counters, so other independent cases can proceed.
  await pools[0].query('TRUNCATE rate_limit_counters');
});
test('local issuer keys and stricter RS wrapper reject the old permissive proof control', async () => {
  const token = await mint(), proof = await resourceProof(token, { iat: now() - 120, nonce: undefined });
  const request = new Request(`${audience}/call`, { method: 'POST', headers: { authorization: `DPoP ${token}`, dpop: proof } });
  await oauth.validateJwtAccessToken({ issuer, jwks_uri: 'https://local-keys.example.test/jwks' }, request, audience, {
    requireDPoP: true, [oauth.customFetch]: async () => new Response(JSON.stringify({ keys: [publicIssuerKey()] }),
      { headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(await resourceAt(0, token, proof), 401);
});
test('same RS proof across HTTP replicas has one winner; no nonce secret divergence', async () => {
  const token = await mint(), proof = await resourceProof(token);
  assert.deepEqual((await Promise.all([resourceAt(0, token, proof), resourceAt(1, token, proof)])).sort(), [200, 401]);
});
async function processReplica() {
  const worker = fork(fileURLToPath(new URL('./replica-worker.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
  });
  let stderr = ''; worker.stderr.on('data', b => stderr += b);
  const ready = new Promise((resolve, reject) => {
    worker.on('message', msg => { if (msg.type === 'ready') resolve(msg); else if (msg.type === 'error') reject(new Error(msg.message)); });
    worker.once('error', reject); worker.once('exit', code => { if (code !== 0) reject(new Error(`worker failed ${code}: ${stderr}`)); });
  });
  worker.send({ type: 'init', connection: conn.href, issuerJwk, issuer, audience, nonceSecret, clients });
  const result = await ready;
  const r = { address: result.address, pid: result.pid, auditWrites: [], app: { close: async () => {
    await new Promise((resolve, reject) => { worker.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); worker.send({ type: 'shutdown' }); });
  } } };
  replicas.push(r); return replicas.length - 1;
}
test('independent OS processes share assertion/AS/RS replay claims and child authorization via Postgres', async () => {
  const a = await processReplica(), b = await processReplica();
  assert.notEqual(replicas[a].pid, replicas[b].pid); assert.notEqual(replicas[a].pid, process.pid);
  const first = await requestBody(), second = await requestBody();
  second.p.client_assertion = first.p.client_assertion; second.body = new URLSearchParams(second.p);
  const assertionRace = await Promise.all([exchangeAt(a, first), exchangeAt(b, second)]);
  assert.deepEqual(assertionRace.map(r => r.status).sort(), [200, 401]);
  assert.equal(assertionRace.find(r => r.status === 401).result.error, 'invalid_client');
  const d1 = await requestBody(), d2 = await requestBody(); d2.proof = d1.proof;
  const dpopRace = await Promise.all([exchangeAt(a, d1), exchangeAt(b, d2)]);
  assert.deepEqual(dpopRace.map(r => r.status).sort(), [200, 400]);
  assert.equal(dpopRace.find(r => r.status === 400).result.error, 'invalid_dpop_proof');
  const parent = (await exchangeAt(a)).result.access_token, proof = await resourceProof(parent);
  assert.deepEqual((await Promise.all([resourceAt(a, parent, proof), resourceAt(b, parent, proof)])).sort(), [200, 401]);
  const child = await childRequest(parent);
  const changed = { ...child, p: { ...child.p, cap_micros: '101' } }; changed.body = new URLSearchParams(changed.p);
  assert.equal((await exchangeAt(a, changed)).result.error, 'invalid_grant');
  const issued = await exchangeAt(b, child); assert.equal(issued.status, 200);
  assert.equal(decodeJwt(issued.result.access_token).cnf.jkt, await clientJkt('child-c'));
  await pools[0].query('UPDATE s0_grants SET active=false WHERE id=$1', [decodeJwt(parent).grant_id]);
  assert.equal(await resourceAt(a, issued.result.access_token, await resourceProof(issued.result.access_token, {}, 'child-c')), 401);
});
for (const [label, fields] of [['missing nonce', { nonce: undefined }], ['61 seconds old', { iat: now() - 61 }],
  ['wrong ath', { ath: 'wrong' }], ['wrong method', { htm: 'GET' }], ['wrong endpoint', { htu: `${audience}/elsewhere` }]]) {
  test(`RS refuses ${label} over HTTP`, async () => {
    const token = await mint(); assert.equal(await resourceAt(1, token, await resourceProof(token, fields)), 401);
  });
}
test('RS refuses a proof signed by another child', async () => {
  const token = await mint(); assert.equal(await resourceAt(0, token, await resourceProof(token, {}, 'child-c')), 401);
});
test('RS rereads credential, identity, sponsor and issued binding at the next use', async () => {
  const token = await mint(); assert.equal(await resourceAt(0, token, await resourceProof(token)), 200);
  for (const [table, id] of [['s0_credentials', 'child-b-credential'], ['s0_identities', 'child-b'], ['s0_sponsors', 'fixture-human']]) {
    await pools[0].query(`UPDATE ${table} SET active=false WHERE id=$1`, [id]);
    assert.equal(await resourceAt(1, token, await resourceProof(token)), 401);
    await pools[0].query(`UPDATE ${table} SET active=true WHERE id=$1`, [id]);
  }
  await pools[0].query('UPDATE s0_tokens SET thumbprint=$1 WHERE jti=$2', ['synthetic-wrong-key', decodeJwt(token).jti]);
  assert.equal(await resourceAt(0, token, await resourceProof(token)), 401);
});
async function childRequest(parent, id = 'child-c') {
  const d = delegation();
  const authorization = await signProof('child-b', { htm: 'POST', htu: `${issuer}/token`, ath: hash(parent),
    iss: 'child-b', aud: issuer, parent_grant_id: decodeJwt(parent).grant_id, child: id,
    child_cnf: await clientJkt(id), delegation: canonical(d), idempotency_key: d.idempotency_key }, 'regulait-delegation-authz+jwt');
  return requestBody(id, { delegation: d, subject_token: parent, subject_token_type: accessType,
    actor_token: authorization, actor_token_type: actorType });
}
test('child exchange checks parent authorization, binds child output and rebuilds nested actor chain', async () => {
  const parent = await mint(), req = await childRequest(parent);
  const r = await exchangeAt(1, req); assert.equal(r.status, 200, JSON.stringify(r.result));
  const child = decodeJwt(r.result.access_token);
  assert.equal(child.cnf.jkt, await clientJkt('child-c'));
  assert.deepEqual(child.act, { sub: 'child-c', act: { sub: 'child-b' } });
  await pools[0].query('UPDATE s0_grants SET active=false WHERE id=$1', [decodeJwt(parent).grant_id]);
  const proof = await resourceProof(r.result.access_token, {}, 'child-c');
  assert.equal(await resourceAt(0, r.result.access_token, proof), 401);
});
for (const field of ['authorization_details', 'resource', 'project_id', 'env', 'cap_micros', 'max_depth', 'expires_at', 'idempotency_key']) {
  test(`unused genuine parent authorization rejects changed ${field} before authorization claim`, async () => {
    const parent = await mint(), req = await childRequest(parent);
    const original = { ...req.p };
    req.p[field] = field === 'authorization_details' ? JSON.stringify([{ type: 'regulait', actions: ['write'] }]) : `${req.p[field]}-changed`;
    req.body = new URLSearchParams(req.p);
    const rejected = await exchangeAt(0, req); assert.ok(rejected.status >= 400, JSON.stringify(rejected.result));
    const check = await pools[0].query(`SELECT count(*)::int n FROM s0_replay WHERE namespace='delegation_authz' AND key=$1`, [decodeJwt(req.p.actor_token).jti]);
    assert.equal(check.rows[0].n, 0);
    const clientClaim = await pools[0].query(`SELECT count(*)::int n FROM s0_replay WHERE namespace='client_assertion' AND key=$1`, [hash('child-c' + decodeJwt(req.p.client_assertion).jti)]);
    assert.equal(clientClaim.rows[0].n, 0);
    const good = await requestBody('child-c', { ...original, client_assertion: await assertion('child-c') });
    assert.equal((await exchangeAt(1, good)).status, 200);
  });
}
test('genuine unused parent authorization rejects a different authenticated child', async () => {
  const parent = await mint(), req = await childRequest(parent);
  const changed = await requestBody('child-b', { ...req.p, client_id: 'child-b', client_assertion: await assertion('child-b') });
  assert.equal((await exchangeAt(0, changed)).result.error, 'invalid_grant');
  assert.equal((await exchangeAt(1, req)).status, 200);
});
test('genuine unused parent authorization refuses a substituted output DPoP key before any claim', async () => {
  const parent = await mint(), req = await childRequest(parent);
  const bad = { ...req, proof: await signProof('child-b', { htm: 'POST', htu: `${issuer}/token` }) };
  assert.equal((await exchangeAt(0, bad)).result.error, 'invalid_grant');
  const claims = await pools[0].query(`SELECT count(*)::int n FROM s0_replay WHERE namespace='client_assertion' AND key=$1`,
    [hash('child-c' + decodeJwt(req.p.client_assertion).jti)]);
  assert.equal(claims.rows[0].n, 0);
  assert.equal((await exchangeAt(1, req)).status, 200);
});
test('parent authorization is one-use across replicas even with fresh client assertion and DPoP', async () => {
  const parent = await mint(), req = await childRequest(parent);
  assert.equal((await exchangeAt(0, req)).status, 200);
  const retry = await requestBody('child-c', { ...req.p, client_assertion: await assertion('child-c') });
  assert.equal((await exchangeAt(1, retry)).result.error, 'invalid_grant');
});
test('caller-supplied actor chain cannot replace the stored root actor', async () => {
  const req = await requestBody(); req.body.set('act', JSON.stringify({ sub: 'fabricated-actor' }));
  const r = await exchangeAt(0, req); assert.equal(r.status, 200);
  assert.deepEqual(decodeJwt(r.result.access_token).act, { sub: 'child-b' });
});
test('offline uploaded CA validates actual ECDSA certificate and SPIFFE profile', async () => {
  assert.deepEqual(await validateSvid(leaf.der, [rootCA.der], 'spiffe://fixture.test/agent/child-b'), leaf.der);
});
test('offline path validator follows a supplied intermediate without fetching a bundle', async () => {
  const intermediate = await certificate({ issuer: rootCA, isCA: true });
  const nested = await certificate({ issuer: intermediate });
  await validateSvid(nested.der, [rootCA.der], 'spiffe://fixture.test/agent/child-b', new Date(), [intermediate.der]);
  await assert.rejects(validateSvid(nested.der, [rootCA.der], 'spiffe://fixture.test/agent/child-b'));
});
for (const [label, opts] of [['wrong SAN', { sans: ['spiffe://fixture.test/agent/other'] }],
  ['wrong trust domain', { sans: ['spiffe://other.test/agent/child-b'] }], ['two URI SANs', { sans: ['spiffe://fixture.test/agent/child-b', 'spiffe://fixture.test/agent/other'] }],
  ['expired', { notBefore: new Date(Date.now() - 120000), notAfter: new Date(Date.now() - 60000) }],
  ['not yet valid', { notBefore: new Date(Date.now() + 60000) }], ['leaf CA', { isCA: true }],
  ['no digitalSignature', { digitalSignature: false }]]) {
  test(`offline certificate validation refuses ${label}`, async () => {
    const invalid = await certificate({ issuer: rootCA, ...opts });
    await assert.rejects(validateSvid(invalid.der, [rootCA.der], 'spiffe://fixture.test/agent/child-b'));
  });
}
test('offline certificate validation refuses unknown trust anchor', async () => {
  const other = await certificate({ isCA: true });
  await assert.rejects(validateSvid(leaf.der, [other.der], 'spiffe://fixture.test/agent/child-b'));
});
test('JWT-SVID signature and audience verified using locally uploaded public key only', async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const uploaded = await exportJWK(pair.publicKey);
  const token = await new SignJWT({ sub: 'spiffe://fixture.test/agent/child-b' })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' }).setAudience(audience).setIssuedAt().setExpirationTime('60s').sign(pair.privateKey);
  const key = await importJWK(uploaded, 'ES256');
  assert.equal((await jwtVerify(token, key, { algorithms: ['ES256'], audience })).payload.sub, 'spiffe://fixture.test/agent/child-b');
  await assert.rejects(jwtVerify(token, key, { algorithms: ['ES256'], audience: 'https://other.example.test' }));
});
function pem(label, der) { return `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`; }
test('actual TLS client certificate reaches the same offline SPIFFE path validator', async () => {
  const serverCert = await certificate({ issuer: rootCA, sans: [], dns: ['localhost'] });
  const serverKey = await webcrypto.subtle.exportKey('pkcs8', serverCert.key.privateKey);
  const clientKey = await webcrypto.subtle.exportKey('pkcs8', leaf.key.privateKey);
  const server = createServer({ key: pem('PRIVATE KEY', serverKey), cert: pem('CERTIFICATE', serverCert.der),
    ca: pem('CERTIFICATE', rootCA.der), requestCert: true, rejectUnauthorized: true }, async (req, res) => {
    try {
      assert.equal(req.socket.authorized, true);
      await validateSvid(req.socket.getPeerCertificate(true).raw, [rootCA.der], 'spiffe://fixture.test/agent/child-b');
      res.end('validated');
    } catch { res.statusCode = 401; res.end('refused'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = opts => new Promise((resolve, reject) => {
    const request = httpsRequest({ host: '127.0.0.1', port: server.address().port, servername: 'localhost',
      ca: pem('CERTIFICATE', rootCA.der), ...opts }, response => {
      let text = ''; response.on('data', b => text += b); response.on('end', () => resolve({ status: response.statusCode, text }));
    }); request.on('error', reject); request.end();
  });
  try {
    assert.deepEqual(await send({ cert: pem('CERTIFICATE', leaf.der), key: pem('PRIVATE KEY', clientKey) }), { status: 200, text: 'validated' });
    await assert.rejects(send({}));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('forwarded certificate fixture refuses default-off, untrusted peer and unauthenticated proxy', async () => {
  const headers = new Headers({ 'x-s0-client-cert': leaf.der.toString('base64'), 'x-s0-proxy-secret': 'synthetic-proxy' });
  const good = { configuredHeader: 'x-s0-client-cert', trustedPeer: true, authenticatedProxy: false, expectedSecret: 'synthetic-proxy' };
  for (const bad of [{ configuredHeader: undefined }, { trustedPeer: false }, { expectedSecret: 'wrong' }]) assert.equal(forwardedCertificate(headers, { ...good, ...bad }), undefined);
  assert.deepEqual(forwardedCertificate(headers, good), leaf.der);
});
test('mTLS branch signature and certificate binding, no bearer or DPoP fallback', async () => {
  const old = decodeJwt(await mint());
  const payload = { ...old, jti: randomUUID(), cnf: { 'x5t#S256': hash(leaf.der) } };
  const token = await new SignJWT(payload).setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: issuerJwk.kid }).sign(issuerKey.privateKey);
  await pools[0].query(`INSERT INTO s0_tokens(jti,grant_id,binding_kind,thumbprint,audience,env) VALUES($1,$2,'mtls',$3,$4,'fixture')`,
    [payload.jti, payload.grant_id, hash(leaf.der), audience]);
  const req = () => new Request(`${audience}/call`, { headers: { authorization: `Bearer ${token}` } });
  const opts = { ...state(), keys: [publicIssuerKey()] };
  await verifyResource(req(), opts, () => validateSvid(leaf.der, [rootCA.der], 'spiffe://fixture.test/agent/child-b'));
  await assert.rejects(verifyResource(req(), opts));
  const wrong = await certificate({ issuer: rootCA });
  await assert.rejects(verifyResource(req(), opts, () => wrong.der));
  await assert.rejects(verifyParentAuthorization(token, 'irrelevant', {}, 'child-c', 'irrelevant', opts), /mtls_parent_handoff_unsupported/);
  for (const cnf of [undefined, { jkt: await clientJkt('child-b'), 'x5t#S256': hash(leaf.der) }]) {
    const unbound = await new SignJWT({ ...old, cnf }).setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: issuerJwk.kid }).sign(issuerKey.privateKey);
    await assert.rejects(verifyResource(new Request(`${audience}/call`, { headers: { authorization: `Bearer ${unbound}` } }), opts));
  }
});
test('token responses and refusals reach the real chained audit without token bytes', async () => {
  await Promise.all(replicas.flatMap(r => r.auditWrites));
  const rows = await pools[0].query(`SELECT detail,row_hash FROM audit_log WHERE detail->>'action'='s0_token_request'`);
  assert.ok(rows.rowCount > 20);
  assert.ok(rows.rows.every(r => r.row_hash && !JSON.stringify(r.detail).includes('eyJ')));
  assert.ok(rows.rows.some(r => r.detail.status === 200)); assert.ok(rows.rows.some(r => r.detail.status === 401));
  assert.ok(rows.rows.some(r => r.detail.status === 499));
});
