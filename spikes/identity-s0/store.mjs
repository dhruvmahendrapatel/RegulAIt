import { AsyncLocalStorage } from 'node:async_hooks';
import { InvalidClientAuth, InvalidDpopProof } from 'oidc-provider/lib/helpers/errors.js';

export const requestState = new AsyncLocalStorage();

// An autocommit insert on a separate connection survives a later grant failure.
export async function claim(pool, namespace, key, expiresAt) {
  const r = await pool.query(`INSERT INTO s0_replay(namespace,key,expires_at)
    VALUES($1,$2,to_timestamp($3)) ON CONFLICT DO NOTHING RETURNING key`,
  [namespace, key, expiresAt]);
  return r.rowCount === 1;
}

export function adapterFor(pool, { atomic = true, barrier } = {}) {
  return class PostgresAdapter {
    constructor(model) { this.model = model; }
    async find(id) {
      if (this.model === 'ReplayDetection' && atomic) return undefined;
      const r = await pool.query(`SELECT payload FROM s0_adapter WHERE model=$1 AND id=$2
        AND expires_at > now()`, [this.model, id]);
      if (this.model === 'ReplayDetection') await barrier?.();
      return r.rows[0]?.payload;
    }
    async upsert(id, payload, expiresIn) {
      if (this.model === 'ReplayDetection' && atomic) {
        const state = requestState.getStore();
        const phase = state?.phase ?? 'client_assertion';
        if (phase === 'client_assertion' && !state?.preflight) throw new InvalidClientAuth('provider pre-claim hook order changed');
        if (process.env.S0_DEBUG) process.stderr.write(`replay insert phase=${phase}\n`);
        if (!await claim(pool, phase, id, Math.floor(Date.now() / 1000) + expiresIn)) {
          throw phase === 'as_dpop' ? new InvalidDpopProof('replay') : new InvalidClientAuth('replay');
        }
        return;
      }
      await pool.query(`INSERT INTO s0_adapter(model,id,payload,expires_at)
        VALUES($1,$2,$3,now()+$4*interval '1 second')
        ON CONFLICT(model,id) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at`,
      [this.model, id, payload, expiresIn]);
    }
    async destroy(id) { await pool.query('DELETE FROM s0_adapter WHERE model=$1 AND id=$2', [this.model, id]); }
    async consume(id) {
      await pool.query(`UPDATE s0_adapter SET payload=jsonb_set(payload,'{consumed}',to_jsonb($3::bigint))
        WHERE model=$1 AND id=$2`, [this.model, id, Math.floor(Date.now() / 1000)]);
    }
    async findByUid(uid) { return this.findBy('uid', uid); }
    async findByUserCode(code) { return this.findBy('userCode', code); }
    async findBy(field, value) {
      const r = await pool.query(`SELECT payload FROM s0_adapter WHERE model=$1 AND payload->>$2=$3
        AND expires_at>now()`, [this.model, field, value]);
      return r.rows[0]?.payload;
    }
    async revokeByGrantId(id) {
      await pool.query(`DELETE FROM s0_adapter WHERE model=$1 AND payload->>'grantId'=$2`, [this.model, id]);
    }
  };
}

export const schema = `
CREATE TABLE s0_replay(namespace text,key text,expires_at timestamptz,claimed_at timestamptz DEFAULT now(),PRIMARY KEY(namespace,key));
CREATE TABLE s0_adapter(model text,id text,payload jsonb,expires_at timestamptz,PRIMARY KEY(model,id));
CREATE TABLE s0_tokens(jti text PRIMARY KEY,grant_id text,binding_kind text,thumbprint text,audience text,env text,revoked boolean DEFAULT false);
CREATE TABLE s0_grants(id text PRIMARY KEY,parent_id text,identity_id text,credential_id text,sponsor_id text,active boolean DEFAULT true);
CREATE TABLE s0_identities(id text PRIMARY KEY,active boolean DEFAULT true);
CREATE TABLE s0_credentials(id text PRIMARY KEY,active boolean DEFAULT true);
CREATE TABLE s0_sponsors(id text PRIMARY KEY,active boolean DEFAULT true);
`;
