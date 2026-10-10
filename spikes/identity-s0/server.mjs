import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import Provider from 'oidc-provider';
import { SignJWT, calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, jwtVerify, importJWK } from 'jose';
import { checkDpopReplay, buildTokenResponse } from 'oidc-provider/lib/helpers/grants.js';
import { InvalidGrant, InvalidDpopProof, InvalidRequest, InvalidClientAuth, UseDpopNonce } from 'oidc-provider/lib/helpers/errors.js';
import { buildApp } from '../../apps/gateway/dist/app.js';
import { auditLog } from '../../packages/db/dist/index.js';
import { adapterFor, claim, requestState } from './store.mjs';
import { fresh, now, nonce, validNonce, canonical, verifyParentAuthorization } from './verify.mjs';

export const exchange = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const accessType = 'urn:ietf:params:oauth:token-type:access_token';
export const rootType = 'urn:regulait:params:oauth:token-type:delegation-proof';
export const actorType = 'urn:regulait:params:oauth:token-type:delegation-authz';
export const parameters = ['subject_token', 'subject_token_type', 'actor_token', 'actor_token_type',
  'resource', 'authorization_details', 'project_id', 'env', 'cap_micros', 'max_depth', 'expires_at', 'idempotency_key', 'requested_token_type'];
export function delegationParams(p) {
  return { authorization_details: JSON.parse(p.authorization_details), resource: p.resource,
    project_id: p.project_id, env: p.env, cap_micros: p.cap_micros, max_depth: p.max_depth,
    expires_at: p.expires_at, idempotency_key: p.idempotency_key };
}

export async function replica({ db, pool, clients, signingKey, issuerJwk, issuer, nonceSecret, audience, mode = 'normal' }) {
  const app = buildApp(db, { bootstrapToken: 'synthetic-s0-bootstrap', dataKey: 'e'.repeat(64),
    timeouts: { bodyLimitBytes: 16384, requestTimeoutMs: 1000 },
    rateLimit: { globalMax: 1000, apiKeyMax: 1000, authMax: 1000 },
  });
  let provider;
  const auditWrites = [];
  const audited = new WeakSet();
  const hookVisits = { onRequest: 0, preHandler: 0, onResponse: 0 };
  // Added to the REAL app, not a second synthetic Fastify instance. OAuth route-class entries
  // are NOT modified: this round proves existing auth/CSRF/admin gates before the Koa callback.
  // The fixture sends bootstrap auth for transport admission; provider client auth remains separate.
  app.addHook('onRequest', async () => { hookVisits.onRequest++; });
  app.addHook('preHandler', async () => { hookVisits.preHandler++; });
  const audit = async (req, status) => {
    if (!req.url.startsWith('/oauth/') || audited.has(req)) return;
    audited.add(req);
    const writing = Promise.resolve(db.insert(auditLog).values({
      userId: '00000000-0000-0000-0000-000000000000', objectType: 'engine', objectId: null,
      detail: { action: 's0_token_request', route: 'POST /oauth/token', status },
      effect: status < 400 ? 'allow' : 'deny', ruleId: 's0_token_request', ruleChain: [], reason: 'Synthetic S0 token endpoint proof',
    }));
    auditWrites.push(writing);
    await writing;
  };
  app.addHook('onResponse', async (req, reply) => {
    hookVisits.onResponse++;
    await audit(req, reply.statusCode);
  });
  app.register(async mount => {
  mount.removeContentTypeParser('application/x-www-form-urlencoded');
  mount.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  mount.post('/oauth/token', { bodyLimit: 16384 }, async (req, reply) => {
    // Every actual gateway preHandler already ran; reconstruct a bounded body for Koa.
    const incoming = Readable.from([req.body]);
    const { authorization: consumedTransportAuth, ...providerHeaders } = req.raw.headers;
    Object.assign(incoming, { method: req.method, url: '/token', originalUrl: '/oauth/token', baseUrl: '/oauth',
      headers: { ...providerHeaders, host: new URL(issuer).host }, socket: req.raw.socket, connection: req.raw.socket, httpVersion: '1.1' });
    reply.hijack();
    const state = { phase: 'client_assertion', aborted: false, mode };
    const timer = setTimeout(() => {
      state.aborted = true;
      audit(req, 499).catch(() => {});
      incoming.destroy(); reply.raw.destroy();
    }, 1000);
    try { await requestState.run(state, () => new Promise(resolve => {
      reply.raw.once('finish', resolve); reply.raw.once('close', resolve);
      provider.callback()(incoming, reply.raw);
    })); }
    finally { clearTimeout(timer); }
  });
  });
  app.post('/s0/resource', async (req, reply) => {
    // Resource verification is independently tested through actual HTTP in spike.test.mjs.
    // The injected implementation has only locally uploaded keys and the fixture live-chain rows.
    try { await app.s0Verify(req); return { allowed: true }; }
    catch (error) {
      if (error.message === 'freshness_nonce') reply.header('DPoP-Nonce', nonce(nonceSecret)).header('WWW-Authenticate', 'DPoP error="use_dpop_nonce"');
      return reply.code(401).send({ error: 'invalid_token' });
    }
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  issuer ??= `${address}/oauth`;
  const preflight = async ctx => {
    const p = ctx.oidc.params;
    if (parameters.some(name => Array.isArray(p[name]))) throw new InvalidRequest('duplicate parameter');
    // Custom grant owns its DPoP profile: the provider's built-in nonce is HKDF,
    // whereas decision20 specifies the gateway HMAC nonce. No provider patch/fork.
    let dpop;
    try {
      const proof = ctx.get('DPoP'), header = decodeProtectedHeader(proof);
      if (header.jwk?.d || !['ES256', 'EdDSA'].includes(header.alg)) throw new Error('proof key');
      const { payload } = await jwtVerify(proof, await importJWK(header.jwk), { algorithms: ['ES256', 'EdDSA'], typ: 'dpop+jwt' });
      if (!validNonce(payload.nonce, nonceSecret)) {
        ctx.set('DPoP-Nonce', nonce(nonceSecret));
        throw new UseDpopNonce('current gateway nonce required');
      }
      fresh(payload, nonceSecret);
      if (payload.htm !== 'POST' || payload.htu !== `${issuer}/token`) throw new Error('proof endpoint');
      dpop = { thumbprint: await calculateJwkThumbprint(header.jwk), jti: payload.jti, iat: payload.iat };
    } catch (error) {
      if (error instanceof UseDpopNonce) throw error;
      throw new InvalidDpopProof('signature, freshness, endpoint or nonce');
    }
    const jkt = dpop.thumbprint;
    if (!jkt) throw new InvalidDpopProof('missing binding');
    if (p.requested_token_type !== accessType || p.resource !== audience || p.env !== 'fixture') throw new InvalidGrant('target');
    let delegated;
    try { delegated = delegationParams(p); } catch { throw new InvalidRequest('delegation shape'); }
    let sponsor = 'fixture-human', parentId = null, proofJti, proofNamespace;
    if (p.subject_token_type === rootType) {
      if (p.actor_token || p.actor_token_type) throw new InvalidGrant('root actor forbidden');
      const { jwtVerify, importJWK } = await import('jose');
      try {
        const { d: privatePart, ...publicJwk } = issuerJwk;
        const proof = (await jwtVerify(p.subject_token, await importJWK(publicJwk), {
          algorithms: ['ES256'], typ: 'regulait-delegation-proof+jwt', issuer, audience: issuer,
        })).payload;
        if (proof.child !== ctx.oidc.client.clientId || proof.child_cnf !== jkt || proof.delegation !== canonical(delegated)) throw new Error('root binding');
        proofJti = proof.jti; proofNamespace = 'human_delegation_proof';
      } catch { throw new InvalidGrant('root proof'); }
    } else if (p.subject_token_type === accessType && p.actor_token_type === actorType) {
      try {
        const proof = await verifyParentAuthorization(p.subject_token, p.actor_token, delegated,
          ctx.oidc.client.clientId, jkt, { issuer, audience, pool, keys: [publicKey(issuerJwk)], nonceSecret });
        const parent = decodeJwt(p.subject_token);
        parentId = parent.grant_id; sponsor = parent.sub;
        proofJti = proof.jti; proofNamespace = 'delegation_authz';
      } catch { throw new InvalidGrant('parent authorization'); }
    } else throw new InvalidRequest('subject/actor token type');
    return { p, dpop, jkt, sponsor, parentId, proofJti, proofNamespace };
  };
  provider = new Provider(issuer, {
    clients, adapter: adapterFor(pool), jwks: { keys: [issuerJwk] },
    features: { devInteractions: { enabled: false }, dPoP: { enabled: true, requireNonce: false } },
    assertJwtClientAuthClaimsAndHeader: async (ctx, payload) => {
      if (!Number.isInteger(payload.iat) || payload.iat < now() - 300 || payload.iat > now() + 5 ||
          !Number.isInteger(payload.exp) || payload.exp > payload.iat + 300) throw new InvalidClientAuth('assertion freshness');
      // This public hook runs after assertion signature verification, before provider ReplayDetection.unique.
      // Parent/child/body binding must be checked here, before even the client assertion claim.
      requestState.getStore().preflight = await preflight(ctx);
    },
  });
  if (process.env.S0_DEBUG) provider.on('grant.error', (_ctx, e) => process.stderr.write(`provider refusal=${e.error} detail=${e.error_detail ?? e.message}\n`));
  provider.registerGrantType(exchange, async ctx => {
    const state = requestState.getStore();
    state.phase = 'as_dpop';
    const { p, dpop, jkt, sponsor, parentId, proofJti, proofNamespace } = state.preflight;
    await checkDpopReplay(provider, ctx, dpop, ctx.oidc.client.clientId, InvalidDpopProof);
    if (!proofJti || !await claim(pool, proofNamespace, proofJti, now() + 360)) throw new InvalidGrant('one-use proof');
    if (state.mode === 'failure') throw new InvalidGrant('synthetic later failure');
    if (state.mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 1100));
    if (state.aborted) throw new InvalidGrant('request timeout');
    const grantId = randomUUID(), tokenJti = randomUUID(), child = ctx.oidc.client.clientId;
    await pool.query(`INSERT INTO s0_grants(id,parent_id,identity_id,credential_id,sponsor_id) VALUES($1,$2,$3,$4,$5)`,
      [grantId, parentId, child, `${child}-credential`, sponsor]);
    await pool.query(`INSERT INTO s0_tokens(jti,grant_id,binding_kind,thumbprint,audience,env) VALUES($1,$2,'dpop',$3,$4,'fixture')`,
      [tokenJti, grantId, jkt, audience]);
    const path = parentId ? [{ sub: child }, { sub: decodeJwt(p.subject_token).client_id }] : [{ sub: child }];
    const act = path.reduceRight((act, row) => ({ ...row, ...(act ? { act } : {}) }), undefined);
    const value = await new SignJWT({ sub: sponsor, client_id: child, grant_id: grantId, cnf: { jkt }, env: 'fixture', act })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: issuerJwk.kid }).setIssuer(issuer)
      .setAudience(audience).setJti(tokenJti).setIssuedAt().setExpirationTime('300s').sign(signingKey);
    ctx.body = buildTokenResponse(provider, { accessToken: value, tokenType: 'DPoP', issuedTokenType: accessType, expiresIn: 300 });
  }, parameters);
  return { app, provider, address, issuer, pool, hookVisits, auditWrites };
}
function publicKey({ d, ...key }) { return key; }
