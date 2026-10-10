/**
 * ADR-0188 (batch 6 item 1) S3 — ISSUER AND GRANTS, on a real database,
 * through the real kernel (`governedEvaluate`) and the real routes:
 *
 *  - A SUB-AGENT NEVER EXCEEDS ITS PARENT: over-scope, over-lifetime,
 *    over-depth and over-budget creation is REFUSED (never narrowed); the
 *    child's own grants, the sponsor's grants and the lead ceiling each bind.
 *  - DECISION 22 BUDGETS: every row of the three worked-example scenarios with
 *    balances asserted after each step; idempotent admission (same key, same
 *    child, one allocation; same key, different request, refused); one
 *    settlement per usage row; first crossing; unpriced calls refused.
 *  - DECISION 17 LIVE CHAIN: suspend, halt, de-grant the MIDDLE actor, revoke
 *    its credential, disable the sponsor or revoke the sponsor's grant → the
 *    leaf's next call is refused by the kernel; cascade revoke kills the leaf
 *    and leaves the root usable; a chain read before a revocation is refused
 *    at the next read.
 *  - SIGNING KEYS: JWKS public halves only; rotate and revoke need the
 *    `identity_manage` step-up (refused for an API key) and are audited;
 *    overlap; revocation refuses every token of the kid.
 *  - DECISION 13 VERIFIER: a stolen token is useless off its binding (no or
 *    wrong proof, wrong htm/htu, replay, stale proof, no nonce, wrong aud/env,
 *    expired, alg none, unknown kid, workload-signed, zero or two cnf, an mTLS
 *    token on the DPoP branch, wrong/no client certificate); decision 12
 *    provenance (revoke client key A → refused; revoke binding key B → its
 *    tokens refused, grant survives).
 *  - DECISION 23 HAND-OFF: the intended child succeeds; every substitution is
 *    refused WITHOUT consuming A's authorization; replay refused; an mTLS
 *    parent refused; a first-use race on two pools admits only the intended.
 *  - DECISION 14: concurrent replay claims on two pools give one winner.
 *
 * Global state (M-068): every org setting, step-up mode, halt, suspension and
 * sponsor change made here is put back in a `finally`. Rows in identity tables
 * cannot be deleted by design; every fixture is scoped by this run's ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint, SignJWT, type JWK } from "jose";
import {
  and,
  auditLog,
  createDb,
  delegationAllocations,
  delegationGrants,
  desc,
  eq,
  identitySigningKeys,
  issuedTokens,
  orgSettings,
  ORG_SETTINGS_ID,
  replayClaims,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import type { DelegationScope, GovernedActor } from "@regulait/policy-kernel";
import { canonicalDelegationBody, IDENTITY_SIGNING_KEY_ENV, type DelegationBody } from "@regulait/shared";
import { buildApp } from "./app.js";
import { governedEvaluate } from "./governed-evaluate.js";
import {
  admitChildGrant,
  createRootGrant,
  DelegationRefusedError,
  governedActorFor,
  loadLiveChain,
  remainingMicros,
  revokeDelegationGrant,
  settleDelegationCharge,
  sweepDelegationAllocations,
  type GrantBinding,
} from "./delegation.js";
import {
  checkDelegationAuthorization,
  claimReplay,
  sweepReplayClaims,
  deriveIdentitySecrets,
  issueDpopNonce,
  mintDelegatedToken,
  pairwiseSubject,
  verifyDelegatedToken,
} from "./delegated-token.js";
import {
  configuredIdentitySigningKeys,
  currentIssuerSigner,
  revokeIdentitySigningKey,
  publishedSigningKeys,
  rotateIdentitySigningKey,
  SIGNING_KEY_OVERLAP_SECONDS,
} from "./identity-signing-keys.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s3-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ISSUER = "https://gateway.example.test";
const ENV = "staging";
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const SECRETS = deriveIdentitySecrets("s3-synthetic-data-key-".padEnd(64, "x"));
const T = { read: `s3_read_${RUN}`, write: `s3_write_${RUN}`, other: `s3_other_${RUN}` };
const SPIFFE = (s: string) => `spiffe://example.org/regulait/s3/${s}-${RUN}`;
const M = (usd: number) => usd * 1_000_000;

let db: Db;
let db2: Db; // a second pool: a second "replica"
let app: ReturnType<typeof buildApp>;
let userId: string;
let adminAuth: { authorization: string };
let serverId: string;
let audience: string;
const ids: string[] = []; // identities I0..I7
const agentRows: string[] = [];
let restoreGates: () => Promise<void> = async () => {};
let restoreAdmission: (() => Promise<void>) | undefined;
let restoreMfa: (() => Promise<void>) | undefined;
let keyDir: string;
const issuerKeys: KeyObject[] = [];

const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
const inject = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

function writeIssuerKeys(keys: KeyObject[]) {
  const pem = keys.map((k) => k.export({ format: "pem", type: "pkcs8" }).toString()).join("\n");
  const file = path.join(keyDir, "issuer.pem");
  writeFileSync(file, pem, { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = file;
}

/** a workload key pair (synthetic) */
function workloadKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as JWK;
  return { privateKey, jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x! } as JWK };
}
type WKey = ReturnType<typeof workloadKey>;
const jkt = (k: WKey) => calculateJwkThumbprint(k.jwk, "sha256");
const b64sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("base64url");

async function registerJwk(identityId: string, k: WKey): Promise<string> {
  return rows<{ id: string }>(
    await db.execute(sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, not_after)
      values (${identityId}, 'jwk', ${JSON.stringify(k.jwk)}::jsonb, ${await jkt(k)}, now() + interval '30 days') returning id`),
  )[0]!.id;
}

const toolScope = (names: string[], kind: "read" | "write" = "write"): DelegationScope => [{ type: "mcp_tool", serverId, toolNames: names, kind }];
const hour = () => new Date(Date.now() + 3600_000);
const inProc: GrantBinding = { kind: "in_process" };

async function refusal(p: Promise<unknown>): Promise<DelegationRefusedError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, "the delegation was refused").toBeInstanceOf(DelegationRefusedError);
  return e as DelegationRefusedError;
}

async function grant(id: string) {
  return (await db.select().from(delegationGrants).where(eq(delegationGrants.id, id)))[0]!;
}
async function balances(id: string) {
  const g = await grant(id);
  return { S: g.settledMicros / 1e6, R: g.reservedMicros / 1e6, rem: (remainingMicros(g) ?? NaN) / 1e6 };
}

/** the kernel's decision for a call by the leaf of `leafGrantId` (a fresh decision 17 read) */
async function decide(leafGrantId: string, toolName: string, kind: "read" | "write" = "write", costKnown = true) {
  const built = await governedActorFor(db, leafGrantId, { costKnown });
  expect(built, "the grant exists").not.toBeNull();
  const actor: GovernedActor = built!.actor;
  return (await governedEvaluate(db, userId, serverId, { serverId, name: toolName, kind }, undefined, null, null, undefined, undefined, undefined, undefined, { actor })).decision;
}

async function dpopProof(k: WKey, opts: { htm?: string; htu?: string; token?: string; iat?: number; jti?: string; nonce?: string | null } = {}) {
  const payload: Record<string, unknown> = {
    htm: opts.htm ?? "GET",
    htu: opts.htu ?? audience,
    iat: opts.iat ?? Math.floor(Date.now() / 1000),
    jti: opts.jti ?? randomUUID(),
  };
  if (opts.token) payload.ath = b64sha(opts.token);
  if (opts.nonce !== null) payload.nonce = opts.nonce ?? issueDpopNonce(SECRETS.nonceKey);
  return new SignJWT(payload).setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk: k.jwk }).sign(k.privateKey);
}
const resourceRequest = (token: string, proof: string | null, opts: { scheme?: string; url?: string; method?: string } = {}) =>
  new Request(opts.url ?? audience, {
    method: opts.method ?? "GET",
    headers: { authorization: `${opts.scheme ?? "DPoP"} ${token}`, ...(proof ? { dpop: proof } : {}) },
  });
const verify = (request: Request, extra: { audience?: string; env?: string; cert?: Uint8Array | null; now?: Date } = {}) =>
  verifyDelegatedToken(db, {
    request,
    audience: extra.audience ?? audience,
    env: extra.env ?? ENV,
    issuer: ISSUER,
    secrets: SECRETS,
    clientCertificateDer: extra.cert ?? null,
    ...(extra.now ? { now: extra.now } : {}),
  });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  db2 = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdmission = await relaxStrictAdmissionForTest(db);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false });

  keyDir = mkdtempSync(path.join(os.tmpdir(), "s3-issuer-"));
  for (let i = 0; i < 4; i++) issuerKeys.push(generateKeyPairSync("ed25519").privateKey);
  writeIssuerKeys([issuerKeys[0]!]);
  const k0 = (await configuredIdentitySigningKeys())[0]!;
  // a shared database may already hold an active key from another run: make ours the signer
  const [active] = await db.select().from(identitySigningKeys).where(sql`activated_at is not null and retired_at is null and revoked_at is null`);
  // a shared database may already hold keys from another run (ours are retired in afterAll): only an EMPTY
  // table auto-activates on first use, so otherwise make our key the signer explicitly, as an admin would
  const recordedKeys = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys);
  if (recordedKeys.length > 0 && active?.kid !== k0.kid) {
    await rotateIdentitySigningKey(db, { kid: k0.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });
  }

  const u = await inject("POST", "/v1/users", AUTH, { email: `s3-sponsor-${RUN}@example.com`, displayName: `s3 sponsor ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  const adm = await inject("POST", "/v1/users", AUTH, { email: `s3-admin-${RUN}@example.com`, displayName: `s3 admin ${RUN}`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  const key = await inject("POST", `/v1/users/${adm.json().id}/keys`, AUTH, { name: "s3" });
  adminAuth = { authorization: `Bearer ${key.json().token}` };
  const s = await inject("POST", "/v1/servers", AUTH, { name: `s3-server-${RUN}`, url: "http://127.0.0.1:9" });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  audience = `${ISSUER}/mcp/${serverId}`;
  for (const [name, kind] of [
    [T.read, "read"],
    [T.write, "write"],
    [T.other, "write"],
  ] as const) {
    expect((await inject("POST", `/v1/servers/${serverId}/tools`, AUTH, { name, kind })).statusCode).toBe(201);
  }
  // the sponsor holds read and write, NOT other
  for (const name of [T.read, T.write]) {
    expect((await inject("POST", "/v1/grants/tools", AUTH, { userId, serverId, toolName: name })).statusCode).toBe(201);
  }
  for (let i = 0; i < 8; i++) {
    const a = rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`s3-agent-${i}-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
    agentRows.push(a);
    const id = rows<{ id: string }>(
      await db.execute(sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
        values ('agent', ${a}, ${SPIFFE(`i${i}`)}, ARRAY[${userId}]::uuid[], ARRAY[${ENV}]) returning id`),
    )[0]!.id;
    ids.push(id);
    // every identity holds read and write of its own; I7 also holds `other` (which the sponsor lacks)
    for (const name of i === 7 ? [T.read, T.write, T.other] : [T.read, T.write]) {
      await db.execute(sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${id}, ${serverId}, ${name})`);
    }
  }
}, 120_000);

afterAll(async () => {
  // M-060/M-068: an active issuer key is global state (one signer per database). Retire ours, so a suite that
  // runs after this one on the same database (the S1 foundation test inserts its own active key) starts clean.
  await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
  await restoreGates();
  await restoreAdmission?.();
  await restoreMfa?.();
  await app?.close();
  rmSync(keyDir, { recursive: true, force: true });
  delete process.env[IDENTITY_SIGNING_KEY_ENV];
});

// ---------------------------------------------------------------------------
describe("ADR-0188 S3 — creation refuses over-scope, never narrows (decisions 4, 16)", () => {
  it("a root inside the sponsor's and the actor's own grants is created exactly as asked", async () => {
    const r = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), capMicros: M(10), environment: ENV, expiresAt: hour(), projectId: null, binding: inProc });
    expect(r.depth).toBe(0);
    expect(r.scope).toEqual(toolScope([T.write]));
    expect((await decide(r.id, T.write)).effect).toBe("allow");
  });

  it("the sponsor lacks a tool the agent has → refused (an agent cannot lend its rights to a person)", async () => {
    const e = await refusal(createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[7]!, scope: toolScope([T.other]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: inProc }));
    expect([e.ruleId, e.code]).toEqual(["delegation-scope", "sponsor_not_entitled"]);
  });

  it("the agent's own grants lack a tool the sponsor has → refused actor-allow-list (I7: not the union)", async () => {
    await db.execute(sql`delete from identity_tool_grants where identity_id = ${ids[6]!} and tool_name = ${T.write}`);
    try {
      const e = await refusal(createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[6]!, scope: toolScope([T.write]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: inProc }));
      expect(e.ruleId).toBe("actor-allow-list");
    } finally {
      await db.execute(sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${ids[6]!}, ${serverId}, ${T.write})`);
    }
  });

  it("outside the lead ceiling → lead-ceiling; an environment the identity is not allowed → actor-chain-invalid", async () => {
    const e1 = await refusal(
      createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), ceiling: toolScope([T.read]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: inProc }),
    );
    expect(e1.ruleId).toBe("lead-ceiling");
    const e2 = await refusal(createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), capMicros: null, environment: "production", expiresAt: hour(), projectId: null, binding: inProc }));
    expect([e2.ruleId, e2.code]).toEqual(["actor-chain-invalid", "environment_not_allowed"]);
  });

  it("a child outside the parent's scope, outliving it, or naming an identity already in the chain → refused, nothing written", async () => {
    const root = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.read], "read"), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: inProc });
    const base = { parentGrantId: root.id, capMicros: null, binding: inProc, expiresAt: new Date(root.expiresAt.getTime() - 1000) };
    const e1 = await refusal(admitChildGrant(db, { environment: ENV, projectId: null, ...base, actorIdentityId: ids[1]!, scope: toolScope([T.write]), idempotencyKey: "a" }));
    expect([e1.ruleId, e1.code]).toEqual(["delegation-scope", "outside_parent_scope"]);
    // a write entry never covers a read and vice versa (decision 27)
    const e1b = await refusal(admitChildGrant(db, { environment: ENV, projectId: null, ...base, actorIdentityId: ids[1]!, scope: toolScope([T.read], "write"), idempotencyKey: "a2" }));
    expect(e1b.ruleId).toBe("delegation-scope");
    const e2 = await refusal(admitChildGrant(db, { environment: ENV, projectId: null, ...base, actorIdentityId: ids[1]!, scope: toolScope([T.read], "read"), expiresAt: new Date(root.expiresAt.getTime() + 60_000), idempotencyKey: "b" }));
    expect([e2.ruleId, e2.code]).toEqual(["delegation-scope", "outlives_parent"]);
    const e3 = await refusal(admitChildGrant(db, { environment: ENV, projectId: null, ...base, actorIdentityId: ids[0]!, scope: toolScope([T.read], "read"), idempotencyKey: "c" }));
    expect([e3.ruleId, e3.code]).toEqual(["actor-chain-invalid", "identity_in_chain"]);
    const n = await db.select().from(delegationGrants).where(eq(delegationGrants.parentGrantId, root.id));
    expect(n).toHaveLength(0);
  });

  it("depth max + 1 → delegation-depth (strict default 3: four agents, a fifth refused); max_depth beyond the limit refused", async () => {
    let parent = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: inProc });
    const e0 = await refusal(admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: parent.id, actorIdentityId: ids[1]!, scope: toolScope([T.write]), capMicros: null, expiresAt: parent.expiresAt, binding: inProc, idempotencyKey: "md", maxFurtherDepth: 3 }));
    expect(e0.ruleId).toBe("delegation-depth");
    for (let i = 1; i <= 3; i++) {
      parent = (await admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: parent.id, actorIdentityId: ids[i]!, scope: toolScope([T.write]), capMicros: null, expiresAt: parent.expiresAt, binding: inProc, idempotencyKey: `d${i}` })).grant;
    }
    expect(parent.depth).toBe(3);
    expect((await decide(parent.id, T.write)).effect).toBe("allow");
    const e = await refusal(admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: parent.id, actorIdentityId: ids[4]!, scope: toolScope([T.write]), capMicros: null, expiresAt: parent.expiresAt, binding: inProc, idempotencyKey: "d4" }));
    expect(e.ruleId).toBe("delegation-depth");
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 S3 — decision 22 budgets on edges (worked examples)", () => {
  const root = (cap: number) =>
    createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), capMicros: M(cap), environment: ENV, expiresAt: hour(), projectId: null, binding: inProc });
  // one expiry for every child in this block: inside every root (an hour) and equal to its siblings, so a
  // retried request is byte-identical and a grandchild never outlives its parent
  const CHILD_EXP = new Date(Date.now() + 1800_000);
  const child = (parentId: string, identity: number, cap: number, key: string) =>
    admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: parentId, actorIdentityId: ids[identity]!, scope: toolScope([T.write]), capMicros: M(cap), expiresAt: CHILD_EXP, binding: inProc, idempotencyKey: key });

  it("scenario 1: root 100 → B 100 → C 1 is admitted (decision 16 refused this)", async () => {
    const r = await root(100);
    const b = await child(r.id, 1, 100, "s1b");
    expect(await balances(r.id)).toEqual({ S: 0, R: 100, rem: 0 });
    const c = await child(b.grant.id, 2, 1, "s1c");
    expect(c.replayed).toBe(false);
    expect(await balances(r.id)).toEqual({ S: 0, R: 100, rem: 0 });
    expect(await balances(b.grant.id)).toEqual({ S: 0, R: 1, rem: 99 });
    expect(await balances(c.grant.id)).toEqual({ S: 0, R: 0, rem: 1 });
  });

  it("scenario 2: nesting, a root sibling, spend, release C, close B — every balance after every step", async () => {
    const r = await root(100);
    const b = (await child(r.id, 1, 60, "s2b")).grant;
    expect(await balances(r.id)).toEqual({ S: 0, R: 60, rem: 40 });
    expect(await balances(b.id)).toEqual({ S: 0, R: 0, rem: 60 });
    const c = (await child(b.id, 2, 40, "s2c")).grant;
    expect(await balances(r.id)).toEqual({ S: 0, R: 60, rem: 40 }); // the root's reservation for B stays 60
    expect(await balances(b.id)).toEqual({ S: 0, R: 40, rem: 20 });
    expect(await balances(c.id)).toEqual({ S: 0, R: 0, rem: 40 });
    const d = (await child(r.id, 3, 40, "s2d")).grant;
    expect(await balances(r.id)).toEqual({ S: 0, R: 100, rem: 0 });
    // step 4: C spends 10
    const usage = randomUUID();
    await db.transaction((tx) => settleDelegationCharge(tx, { usageEventId: usage, leafGrantId: c.id, amountMicros: M(10) }));
    expect(await balances(r.id)).toEqual({ S: 10, R: 90, rem: 0 });
    expect(await balances(b.id)).toEqual({ S: 10, R: 30, rem: 20 });
    expect(await balances(c.id)).toEqual({ S: 10, R: 0, rem: 30 });
    const edges = await db.select().from(delegationAllocations).where(sql`${delegationAllocations.childGrantId} in (${b.id}, ${c.id})`);
    expect(edges.map((e) => e.drawnMicros)).toEqual([M(10), M(10)]);
    // the same usage row settled twice changes nothing
    const again = await db.transaction((tx) => settleDelegationCharge(tx, { usageEventId: usage, leafGrantId: c.id, amountMicros: M(10) }));
    expect(again.applied).toBe(false);
    expect(await balances(r.id)).toEqual({ S: 10, R: 90, rem: 0 });
    // step 5: release C (B still active): the 30 returns to B, not to the root
    await revokeDelegationGrant(db, { grantId: c.id, reason: "run_ended" });
    expect(await balances(r.id)).toEqual({ S: 10, R: 90, rem: 0 });
    expect(await balances(b.id)).toEqual({ S: 10, R: 0, rem: 50 });
    const [edgeC] = await db.select().from(delegationAllocations).where(eq(delegationAllocations.childGrantId, c.id));
    expect([edgeC!.status, edgeC!.releasedMicros]).toEqual(["closed", M(30)]);
    // step 6: close B: the root gets back B's unspent 60 − 10
    await revokeDelegationGrant(db, { grantId: b.id, reason: "run_ended" });
    expect(await balances(r.id)).toEqual({ S: 10, R: 40, rem: 50 });
    // closing again is idempotent
    await revokeDelegationGrant(db, { grantId: b.id, reason: "run_ended" });
    expect(await balances(r.id)).toEqual({ S: 10, R: 40, rem: 50 });
    expect((await grant(d.id)).revokedAt).toBeNull();
  });

  it("creation and admission each write a delegation_grant audit row in the same transaction (chain ids, no secrets); a replay writes none", async () => {
    const r = await root(10);
    const c = await child(r.id, 1, 4, "audit-c");
    const rowsFor = (id: string) => db.select().from(auditLog).where(and(eq(auditLog.objectType, "delegation_grant"), eq(auditLog.objectId, id)));
    const [ra] = await rowsFor(r.id);
    expect(ra).toMatchObject({ userId, ruleId: "delegation-create" });
    expect(ra!.detail).toMatchObject({ phase: "create", grantId: r.id, rootGrantId: r.id, parentGrantId: null, depth: 0, actorIdentityId: ids[0] });
    const [ca] = await rowsFor(c.grant.id);
    expect(ca!.detail).toMatchObject({ phase: "admit", rootGrantId: r.id, parentGrantId: r.id, path: [r.id], depth: 1, actorIdentityId: ids[1], capMicros: M(4) });
    expect(JSON.stringify([ra!.detail, ca!.detail])).not.toMatch(/thumbprint|credential|jkt|token/i);
    await child(r.id, 1, 4, "audit-c"); // idempotent replay
    expect(await rowsFor(c.grant.id)).toHaveLength(1);
  });

  it("scenario 3: two concurrent children of 60 under a fresh root of 100 → exactly one admitted", async () => {
    const r = await root(100);
    const out = await Promise.allSettled([child(r.id, 1, 60, "s3a"), child(r.id, 2, 60, "s3b")]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rej = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect((rej.reason as DelegationRefusedError).ruleId).toBe("delegation-budget");
    expect(await balances(r.id)).toEqual({ S: 0, R: 60, rem: 40 });
  });

  it("idempotency: a retried request (lost reply) returns the same child and reserves once; a different body under the key is refused", async () => {
    const r = await root(100);
    const first = await child(r.id, 1, 30, "idem");
    const again = await admitChildGrant(db, { environment: ENV, projectId: null,
      parentGrantId: r.id,
      actorIdentityId: ids[1]!,
      scope: toolScope([T.write]),
      capMicros: M(30),
      expiresAt: first.grant.expiresAt,
      binding: inProc,
      idempotencyKey: "idem",
    });
    expect(again.replayed).toBe(true);
    expect(again.grant.id).toBe(first.grant.id);
    expect(await balances(r.id)).toEqual({ S: 0, R: 30, rem: 70 });
    const e = await refusal(child(r.id, 1, 31, "idem"));
    expect(e.ruleId).toBe("delegation-idempotency-conflict");
    expect(await balances(r.id)).toEqual({ S: 0, R: 30, rem: 70 });
  });

  it("over-budget creation refused; a first crossing lands as settled once per ancestor and the next call under that ancestor is refused", async () => {
    const r = await root(10);
    const b = (await child(r.id, 1, 5, "fcb")).grant;
    const e = await refusal(child(r.id, 2, 6, "fc-over"));
    expect([e.ruleId, e.code]).toEqual(["delegation-budget", "delegation_budget"]);
    // B spends 8 against its 5: d = 5 reserved turns settled, the excess 3 lands as settled with nothing behind it
    await db.transaction((tx) => settleDelegationCharge(tx, { usageEventId: randomUUID(), leafGrantId: b.id, amountMicros: M(8) }));
    expect(await balances(b.id)).toEqual({ S: 8, R: 0, rem: -3 });
    expect(await balances(r.id)).toEqual({ S: 8, R: 0, rem: 2 });
    // the spent leaf's next call is refused by the kernel
    const d = await decide(b.id, T.write);
    expect([d.effect, d.ruleId]).toEqual(["deny", "delegation-budget"]);
    // and the root can allocate only what is really left
    const e2 = await refusal(child(r.id, 2, 3, "fc-after"));
    expect(e2.ruleId).toBe("delegation-budget");
    expect((await child(r.id, 2, 2, "fc-ok")).replayed).toBe(false);
  });

  it("an unpriced call under a capped grant is refused (an unknown cost never buys free authority)", async () => {
    const r = await root(10);
    expect((await decide(r.id, T.write, "write", true)).effect).toBe("allow");
    const d = await decide(r.id, T.write, "write", false);
    expect([d.effect, d.ruleId]).toEqual(["deny", "delegation-budget"]);
  });

  it("the sweep closes edges of expired children and returns only the unspent part, idempotently", async () => {
    const r = await root(100);
    const c = (await child(r.id, 1, 20, "sweep")).grant;
    await db.transaction((tx) => settleDelegationCharge(tx, { usageEventId: randomUUID(), leafGrantId: c.id, amountMicros: M(5) }));
    expect(await balances(r.id)).toEqual({ S: 5, R: 15, rem: 80 });
    const later = new Date(c.expiresAt.getTime() + 1000);
    const swept = await sweepDelegationAllocations(db, { now: later });
    expect(swept.closed).toBeGreaterThanOrEqual(1);
    expect(await balances(r.id)).toEqual({ S: 5, R: 0, rem: 95 });
    await sweepDelegationAllocations(db, { now: later });
    expect(await balances(r.id)).toEqual({ S: 5, R: 0, rem: 95 });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 S3 — decision 17: the live chain, read fresh at every use", () => {
  /** root I0 → middle I1 → leaf I2, each holding read+write, plus a sibling I3 under the root holding read only */
  async function chain3() {
    const both = [...toolScope([T.write]), ...toolScope([T.read], "read")];
    const root = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: both, capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: inProc });
    const exp = new Date(root.expiresAt.getTime() - 1000);
    const mid = (await admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: root.id, actorIdentityId: ids[1]!, scope: both, capMicros: null, expiresAt: exp, binding: inProc, idempotencyKey: "m" })).grant;
    const leaf = (await admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: mid.id, actorIdentityId: ids[2]!, scope: toolScope([T.write]), capMicros: null, expiresAt: exp, binding: inProc, idempotencyKey: "l" })).grant;
    const sib = (await admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: root.id, actorIdentityId: ids[3]!, scope: toolScope([T.read], "read"), capMicros: null, expiresAt: exp, binding: inProc, idempotencyKey: "s" })).grant;
    return { root, mid, leaf, sib };
  }

  it("the chain is the STORED path, root first, with depth = hop count", async () => {
    const { root, mid, leaf } = await chain3();
    const live = await loadLiveChain(db, leaf.id);
    expect(live!.failure).toBeNull();
    expect(live!.chain.actors.map((a) => a.identityId)).toEqual([ids[0], ids[1], ids[2]]);
    expect(live!.links.map((l) => l.grant.id)).toEqual([root.id, mid.id, leaf.id]);
    expect(live!.chain.depth).toBe(3);
    expect((await decide(leaf.id, T.write)).effect).toBe("allow");
  });

  it("suspending the MIDDLE identity (its grant untouched) refuses the leaf's next call; the sibling keeps exactly its own scope", async () => {
    const { leaf, sib } = await chain3();
    await db.execute(sql`update workload_identities set status = 'suspended' where id = ${ids[1]!}`);
    try {
      const d = await decide(leaf.id, T.write);
      expect([d.effect, d.ruleId]).toEqual(["deny", "actor-chain-invalid"]);
      expect((await decide(sib.id, T.read, "read")).effect).toBe("allow");
      expect((await decide(sib.id, T.write)).ruleId).toBe("delegation-scope");
    } finally {
      await db.execute(sql`update workload_identities set status = 'active' where id = ${ids[1]!}`);
    }
    expect((await decide(leaf.id, T.write)).effect).toBe("allow");
  });

  it("halting the MIDDLE agent (ADR-0124) refuses the leaf", async () => {
    const { leaf } = await chain3();
    await db.execute(sql`update agents set halted_at = now(), halted_reason = 's3 test halt' where id = ${agentRows[1]!}`);
    try {
      const live = await loadLiveChain(db, leaf.id);
      expect(live!.failure).toEqual({ index: 1, code: "agent_halted" });
      expect((await decide(leaf.id, T.write)).ruleId).toBe("actor-chain-invalid");
    } finally {
      await db.execute(sql`update agents set halted_at = null, halted_reason = null where id = ${agentRows[1]!}`);
    }
  });

  it("removing a tool from the MIDDLE actor's own grants refuses the leaf (actor-allow-list), immediately", async () => {
    const { leaf } = await chain3();
    await db.execute(sql`delete from identity_tool_grants where identity_id = ${ids[1]!} and tool_name = ${T.write}`);
    try {
      const d = await decide(leaf.id, T.write);
      expect([d.effect, d.ruleId]).toEqual(["deny", "actor-allow-list"]);
    } finally {
      await db.execute(sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${ids[1]!}, ${serverId}, ${T.write})`);
    }
  });

  it("revoking the sponsor's grant after the child was created refuses the child's next call; disabling the sponsor too", async () => {
    const { leaf } = await chain3();
    await db.execute(sql`delete from tool_grants where user_id = ${userId} and tool_name = ${T.write}`);
    try {
      expect((await decide(leaf.id, T.write)).effect).toBe("deny");
    } finally {
      expect((await inject("POST", "/v1/grants/tools", AUTH, { userId, serverId, toolName: T.write })).statusCode).toBe(201);
    }
    await db.execute(sql`update users set disabled_at = now() where id = ${userId}`);
    try {
      expect((await loadLiveChain(db, leaf.id))!.failure!.code).toBe("sponsor_disabled");
    } finally {
      await db.execute(sql`update users set disabled_at = null where id = ${userId}`);
    }
    expect((await decide(leaf.id, T.write)).effect).toBe("allow");
  });

  it("a turn held open across a revocation is refused at its next effect (a fresh read, no cache); cascade kills the leaf, the root stays usable", async () => {
    const { root, mid, leaf } = await chain3();
    const before = await governedActorFor(db, leaf.id, { costKnown: true });
    expect(before!.live.failure).toBeNull();
    const out = await revokeDelegationGrant(db, { grantId: mid.id, reason: "admin" });
    expect(new Set(out.revokedGrantIds)).toEqual(new Set([mid.id, leaf.id]));
    // the very next read, same second, no wait
    const d = await decide(leaf.id, T.write);
    expect([d.effect, d.ruleId]).toEqual(["deny", "actor-chain-invalid"]);
    expect((await grant(leaf.id)).revokedReason).toBe("cascade");
    expect((await grant(mid.id)).revokedReason).toBe("admin");
    expect((await decide(root.id, T.write)).effect).toBe("allow");
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "delegation_grant"), eq(auditLog.objectId, mid.id))).orderBy(desc(auditLog.at));
    expect(a?.ruleId).toBe("delegation-revoke");
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 S3 — signing keys, JWKS and the decision 13 verifier", () => {
  const A = workloadKey(); // I0's client-authentication key (registered)
  const B = workloadKey(); // I0's DPoP binding key
  let credA: string;
  let rootExt: string;

  async function externalRoot(identity: number, cred: string, binding: { kind: "dpop" | "mtls"; thumbprint: string }) {
    return createRootGrant(db, {
      sponsorUserId: userId,
      actorIdentityId: ids[identity]!,
      scope: toolScope([T.write]),
      capMicros: null,
      environment: ENV,
      expiresAt: hour(),
      projectId: null,
      binding: { ...binding, authCredentialId: cred, audience },
    });
  }
  const mint = (grantId: string, now?: Date) => mintDelegatedToken(db, { grantId, issuer: ISSUER, secrets: SECRETS, ...(now ? { now } : {}) });

  beforeAll(async () => {
    credA = await registerJwk(ids[0]!, A);
    rootExt = (await externalRoot(0, credA, { kind: "dpop", thumbprint: await jkt(B) })).id;
  });

  it("the JWKS is public and carries public halves only; the first mint activated the configured key (audited)", async () => {
    const t = await mint(rootExt);
    const res = await inject("GET", "/.well-known/jwks.json", {});
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body) as { keys: Array<Record<string, unknown>> };
    expect(doc.keys.some((k) => k.kid === t.kid)).toBe(true);
    for (const k of doc.keys) {
      expect(Object.keys(k).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
    }
    const list = await inject("GET", "/v1/identity/signing-keys", adminAuth);
    expect(list.statusCode, list.body).toBe(200);
    expect(JSON.stringify(list.json())).not.toMatch(/"d"/);
  });

  it("a minted token: RFC 9068 header, pairwise sub, act from the stored path, cnf always, and an issued_tokens row", async () => {
    const t = await mint(rootExt);
    const [h, p] = t.accessToken.split(".").slice(0, 2).map((s) => JSON.parse(Buffer.from(s, "base64url").toString()));
    expect(h).toMatchObject({ alg: "EdDSA", typ: "at+jwt", kid: t.kid });
    expect(p.sub).toBe(pairwiseSubject(SECRETS.pairwiseKey, audience, userId));
    expect(p.sub).not.toContain("@");
    expect(p.act).toEqual({ sub: SPIFFE("i0") });
    expect(p.client_id).toBe(SPIFFE("i0"));
    expect(p.cnf).toEqual({ jkt: await jkt(B) });
    expect(p.exp - p.iat).toBe(300);
    const [row] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, t.jti));
    expect(row).toMatchObject({ grantId: rootExt, bindingKind: "dpop", authCredentialId: credA, signingKid: t.kid });
    // an in-process grant mints nothing (decision 6)
    const inproc = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[0]!, scope: toolScope([T.write]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: inProc });
    await expect(mint(inproc.id)).rejects.toMatchObject({ code: "grant_not_external" });
  });

  it("the genuine request verifies; every stolen-token variant is 401 (decision 13)", async () => {
    const t = await mint(rootExt);
    const ok = await verify(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken })));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    if (ok.ok) expect(ok.live.leaf.id).toBe(rootExt);

    const bad = async (req: Request, extra: Parameters<typeof verify>[1] = {}) => {
      const r = await verify(req, extra);
      expect(r.ok, JSON.stringify(r)).toBe(false);
      if (!r.ok) expect(r.status).toBe(401);
      return r.ok ? null : r;
    };
    const other = workloadKey();
    await bad(resourceRequest(t.accessToken, null)); // no proof
    await bad(resourceRequest(t.accessToken, await dpopProof(other, { token: t.accessToken }))); // another key
    await bad(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken, htm: "POST" }))); // wrong htm
    await bad(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken, htu: `${ISSUER}/elsewhere` }))); // wrong htu
    const used = await dpopProof(B, { token: t.accessToken });
    expect((await verify(resourceRequest(t.accessToken, used))).ok).toBe(true);
    expect((await bad(resourceRequest(t.accessToken, used)))!.code).toBe("dpop_proof_replayed"); // reused jti
    const stale = await bad(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken, iat: Math.floor(Date.now() / 1000) - 61 })));
    expect(stale!.code).toBe("dpop_proof_stale"); // 61 s: the library's 300 s window is not ours
    const noNonce = await bad(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken, nonce: null })));
    expect(noNonce!.error).toBe("use_dpop_nonce");
    expect(noNonce!.dpopNonce).toBe(issueDpopNonce(SECRETS.nonceKey));
    await bad(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken, nonce: "1.stale" })));
    await bad(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken })), { audience: `${ISSUER}/mcp/${randomUUID()}` }); // wrong aud
    expect((await bad(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken })), { env: "production" }))!.code).toBe("env_mismatch");
    await bad(resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken }), { scheme: "Bearer" })); // DPoP token as bearer
  });

  it("expired, alg none, unknown kid, workload-signed, zero or two cnf, and an x5t token on the DPoP branch → 401", async () => {
    const signer = await currentIssuerSigner(db);
    const base = (claims: Record<string, unknown>) => ({
      iss: ISSUER,
      sub: "s",
      aud: audience,
      client_id: SPIFFE("i0"),
      grant_id: rootExt,
      env: ENV,
      jti: randomUUID().replace(/-/g, ""),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    });
    const issuerSigned = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) =>
      new SignJWT(base(claims)).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: signer.kid, ...header }).sign(signer.privateKey);
    const tryIt = async (token: string, scheme = "DPoP") => verify(resourceRequest(token, await dpopProof(B, { token }), { scheme }));

    const expired = await mint(rootExt, new Date(Date.now() - 400_000)).catch(() => null);
    if (expired) expect((await tryIt(expired.accessToken)).ok).toBe(false);
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt", kid: signer.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(base({ cnf: { jkt: await jkt(B) } }))).toString("base64url")}.`;
    expect((await tryIt(none)).ok).toBe(false);
    expect((await tryIt(await issuerSigned({ cnf: { jkt: await jkt(B) } }, { kid: "unknown-kid" }))).ok).toBe(false);
    const workloadSigned = await new SignJWT(base({ cnf: { jkt: await jkt(B) } })).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: signer.kid }).sign(A.privateKey);
    expect((await tryIt(workloadSigned)).ok).toBe(false);
    const r0 = await tryIt(await issuerSigned({}));
    expect(r0.ok ? "" : r0.code).toBe("cnf_invalid");
    const r2 = await tryIt(await issuerSigned({ cnf: { jkt: await jkt(B), "x5t#S256": b64sha("x") } }));
    expect(r2.ok ? "" : r2.code).toBe("cnf_invalid");
    const rx = await tryIt(await issuerSigned({ cnf: { "x5t#S256": b64sha("x") } }));
    expect(rx.ok ? "" : rx.code).toBe("mtls_scheme_required");
    // a correctly signed token that we never ISSUED (no issued_tokens row) is refused at step 4
    const forged = await issuerSigned({ cnf: { jkt: await jkt(B) } });
    const rf = await tryIt(forged);
    expect(rf.ok ? "" : rf.code).toBe("issued_token_mismatch");
  });

  it("the mTLS branch: the right certificate verifies; another, none, or a DPoP header → 401", async () => {
    const cert = new Uint8Array(Buffer.from(`synthetic-validated-leaf-der-${RUN}`));
    const credM = await registerJwk(ids[1]!, workloadKey());
    const g = await externalRoot(1, credM, { kind: "mtls", thumbprint: b64sha(cert) });
    const t = await mint(g.id);
    expect(t.tokenType).toBe("Bearer");
    const req = () => resourceRequest(t.accessToken, null, { scheme: "Bearer" });
    expect((await verify(req(), { cert })).ok).toBe(true);
    expect((await verify(req(), { cert: new Uint8Array(Buffer.from("other-cert")) })).ok).toBe(false);
    expect((await verify(req(), { cert: null })).ok).toBe(false);
    const withProof = resourceRequest(t.accessToken, await dpopProof(B, { token: t.accessToken }), { scheme: "Bearer" });
    expect((await verify(withProof, { cert })).ok).toBe(false);
  });

  it("decision 12: revoking client key A refuses its tokens and grants (and descendants); revoking only binding key B refuses B-bound tokens, the grant survives", async () => {
    // client key A2 authenticates, binding key B2 holds the token
    const A2 = workloadKey();
    const B2 = workloadKey();
    const credA2 = await registerJwk(ids[2]!, A2);
    const credB2 = await registerJwk(ids[2]!, B2);
    const g = await externalRoot(2, credA2, { kind: "dpop", thumbprint: await jkt(B2) });
    const child = (await admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: g.id, actorIdentityId: ids[3]!, scope: toolScope([T.write]), capMicros: null, expiresAt: g.expiresAt, binding: inProc, idempotencyKey: "prov" })).grant;
    const t = await mint(g.id);
    const call = async () => verify(resourceRequest(t.accessToken, await dpopProof(B2, { token: t.accessToken })));
    expect((await call()).ok).toBe(true);
    // revoke the binding-only key B2: its tokens are refused, the grant itself stays live
    await db.execute(sql`update workload_credentials set revoked_at = now() where id = ${credB2}`);
    const rb = await call();
    expect(rb.ok ? "" : rb.code).toBe("binding_key_revoked");
    expect((await loadLiveChain(db, g.id))!.failure).toBeNull();
    // revoke the client-authentication key A2: the grant and its descendant are refused before any call
    await db.execute(sql`update workload_credentials set revoked_at = now() where id = ${credA2}`);
    expect((await loadLiveChain(db, g.id))!.failure!.code).toBe("credential_revoked");
    expect((await decide(child.id, T.write)).ruleId).toBe("actor-chain-invalid");
  });

  it("revoking the ROOT refuses a child's still-unexpired token in the same second", async () => {
    const Bc = workloadKey();
    const credC = await registerJwk(ids[4]!, workloadKey());
    const r = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[3]!, scope: toolScope([T.write]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: inProc });
    const c = (await admitChildGrant(db, { environment: ENV, projectId: null, parentGrantId: r.id, actorIdentityId: ids[4]!, scope: toolScope([T.write]), capMicros: null, expiresAt: r.expiresAt, binding: { kind: "dpop", thumbprint: await jkt(Bc), authCredentialId: credC, audience }, idempotencyKey: "rt" })).grant;
    const t = await mint(c.id);
    expect((await verify(resourceRequest(t.accessToken, await dpopProof(Bc, { token: t.accessToken })))).ok).toBe(true);
    await revokeDelegationGrant(db, { grantId: r.id, reason: "admin" });
    const after = await verify(resourceRequest(t.accessToken, await dpopProof(Bc, { token: t.accessToken })));
    expect(after.ok ? "" : after.code).toBe("chain_grant_revoked");
  });

  it("rotate and revoke need the identity_manage step-up (an API key is refused), are audited, and rotation keeps old tokens until the overlap ends", async () => {
    const before = await mint(rootExt);
    const k1 = before.kid;
    writeIssuerKeys([issuerKeys[0]!, issuerKeys[1]!]);
    const strict = await inject("POST", "/v1/identity/signing-keys/rotate", adminAuth, {});
    expect(strict.statusCode, strict.body).toBe(403);
    expect(strict.json().error).toBe("step_up_required");
    const restore = await relaxStepUpForTest(db);
    try {
      const rot = await inject("POST", "/v1/identity/signing-keys/rotate", adminAuth, {});
      expect(rot.statusCode, rot.body).toBe(200);
      expect(rot.json().previousKid).toBe(k1);
      const k2 = rot.json().kid as string;
      const [audit] = await db.select().from(auditLog).where(eq(auditLog.objectType, "identity_signing_key")).orderBy(desc(auditLog.at)).limit(1);
      expect(audit).toMatchObject({ ruleId: "identity-signing-key-rotate" });
      // a rotated-to key is never re-activated; a recorded key cannot be rotated to again
      const again = await inject("POST", "/v1/identity/signing-keys/rotate", adminAuth, { kid: k1 });
      expect(again.statusCode).toBe(409);
      // the old token still verifies (overlap); new tokens are signed by k2
      expect((await verify(resourceRequest(before.accessToken, await dpopProof(B, { token: before.accessToken })))).ok).toBe(true);
      const after = await mint(rootExt);
      expect(after.kid).toBe(k2);
      const jwks = JSON.parse((await inject("GET", "/.well-known/jwks.json", {})).body).keys.map((k: { kid: string }) => k.kid);
      expect(jwks).toEqual(expect.arrayContaining([k1, k2]));
      // past the overlap the retired key is no longer published, so its tokens cannot verify
      const future = new Date(Date.now() + (SIGNING_KEY_OVERLAP_SECONDS + 1) * 1000);
      expect((await publishedSigningKeys(db, future)).map((k) => k.kid)).not.toContain(k1);
      // revoke k1 (compromise): its unexpired tokens are revoked and refused at once
      const rev = await inject("POST", `/v1/identity/signing-keys/${k1}/revoke`, adminAuth, {});
      expect(rev.statusCode, rev.body).toBe(200);
      expect(rev.json().tokensRevoked).toBeGreaterThanOrEqual(1);
      expect((await verify(resourceRequest(before.accessToken, await dpopProof(B, { token: before.accessToken })))).ok).toBe(false);
      expect((await inject("POST", `/v1/identity/signing-keys/${k1}/revoke`, adminAuth, {})).statusCode).toBe(409);
      const jwks2 = JSON.parse((await inject("GET", "/.well-known/jwks.json", {})).body).keys.map((k: { kid: string }) => k.kid);
      expect(jwks2).not.toContain(k1);
      expect((await verify(resourceRequest(after.accessToken, await dpopProof(B, { token: after.accessToken })))).ok).toBe(true);
    } finally {
      await restore();
    }
  });

  it("after a key has been revoked, a mint never silently activates a configured key: no signer until an admin rotates", async () => {
    // configure a fresh third key, then revoke the CURRENT signer (compromise)
    writeIssuerKeys([issuerKeys[0]!, issuerKeys[1]!, issuerKeys[2]!]);
    const current = await currentIssuerSigner(db);
    await revokeIdentitySigningKey(db, { kid: current.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });
    const before = (await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys)).length;
    const auditsBefore = (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, "identity-signing-key-activate"))).length;
    await expect(mint(rootExt)).rejects.toMatchObject({ code: "signing_key_unavailable" });
    // nothing was recorded or activated, and no SYSTEM activation row was written
    expect((await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys)).length).toBe(before);
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, "identity-signing-key-activate"))).length).toBe(auditsBefore);
    // an admin rotation (the step-up route; here the function it calls) restores a signer
    const recorded = new Set((await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys)).map((r) => r.kid));
    const next = (await configuredIdentitySigningKeys()).find((k) => !recorded.has(k.kid))!;
    await rotateIdentitySigningKey(db, { kid: next.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });
    expect((await mint(rootExt)).kid).toBe(next.kid);
  });

  it("revocation uses the database clock: a token minted by a replica whose clock runs ahead is still revoked, never rolled back", async () => {
    writeIssuerKeys([issuerKeys[0]!, issuerKeys[1]!, issuerKeys[2]!, issuerKeys[3]!]);
    const signer = await currentIssuerSigner(db);
    // issued_at two minutes ahead of the database: the old gateway-clock revoked_at
    // fell before it and the lifecycle check rolled the whole revocation back
    const ahead = await mint(rootExt, new Date(Date.now() + 120_000));
    const out = await revokeIdentitySigningKey(db, { kid: signer.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });
    expect(out.tokensRevoked).toBeGreaterThanOrEqual(1);
    const [key] = await db.select().from(identitySigningKeys).where(eq(identitySigningKeys.kid, signer.kid));
    expect(key!.revokedAt).not.toBeNull();
    const [tok] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, ahead.jti));
    expect(tok!.revokedAt!.getTime()).toBeGreaterThanOrEqual(tok!.issuedAt.getTime());
    // restore a signer for the suites below
    const recorded = new Set((await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys)).map((r) => r.kid));
    const fresh = (await configuredIdentitySigningKeys()).find((k) => !recorded.has(k.kid))!;
    await rotateIdentitySigningKey(db, { kid: fresh.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });
    expect((await mint(rootExt)).kid).toBe(fresh.kid);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 S3 — decision 23: a parent authorises one specific child and body", () => {
  const Akey = workloadKey(); // A's (I5) DPoP binding key
  const Bkey = workloadKey(); // B's (I6) output binding key
  let parentGrant: string;
  let parentToken: string;
  const projectId = null;

  beforeAll(async () => {
    const credA = await registerJwk(ids[5]!, workloadKey());
    parentGrant = (
      await createRootGrant(db, {
        sponsorUserId: userId,
        actorIdentityId: ids[5]!,
        scope: toolScope([T.read, T.write]),
        capMicros: M(50),
        environment: ENV,
        expiresAt: hour(),
        projectId,
        binding: { kind: "dpop", thumbprint: await jkt(Akey), authCredentialId: credA, audience },
      })
    ).id;
    parentToken = (await mintDelegatedToken(db, { grantId: parentGrant, issuer: ISSUER, secrets: SECRETS })).accessToken;
  });

  const body = (over: Partial<DelegationBody> = {}): DelegationBody => ({
    authorization_details: toolScope([T.write]) as DelegationBody["authorization_details"],
    resource: audience,
    project_id: projectId,
    env: ENV,
    cap_micros: M(10),
    max_depth: 1,
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    ...over,
  });
  async function authz(b: DelegationBody, idem: string, over: Record<string, unknown> = {}) {
    return new SignJWT({
      htm: "POST",
      htu: TOKEN_ENDPOINT,
      ath: b64sha(parentToken),
      nonce: issueDpopNonce(SECRETS.nonceKey),
      parent_grant_id: parentGrant,
      child: ids[6]!,
      child_cnf: await jkt(Bkey),
      delegation: canonicalDelegationBody(b),
      idempotency_key: idem,
      ...over,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "regulait-delegation-authz+jwt", jwk: Akey.jwk })
      .setIssuer(SPIFFE("i5"))
      .setAudience(ISSUER)
      .setIssuedAt(typeof over.iat === "number" ? over.iat : undefined)
      .setJti(randomUUID())
      .sign(Akey.privateKey);
  }
  const check = async (authorization: string, b: DelegationBody, idem: string, over: { child?: string; jkt?: string; parentToken?: string; dbx?: Db } = {}) =>
    checkDelegationAuthorization(over.dbx ?? db, {
      parentToken: over.parentToken ?? parentToken,
      authorization,
      body: b,
      idempotencyKey: idem,
      authenticatedChildIdentityId: over.child ?? ids[6]!,
      requestDpopJkt: over.jkt ?? (await jkt(Bkey)),
      tokenEndpointUrl: TOKEN_ENDPOINT,
      issuer: ISSUER,
      env: ENV,
      secrets: SECRETS,
    });

  it("every substitution is refused WITHOUT consuming A's authorization; then the intended child succeeds once, bound to B with act rebuilt", async () => {
    const b = body();
    const a = await authz(b, "h1");
    const subs: Array<[string, () => ReturnType<typeof check>]> = [
      ["other child", () => check(a, b, "h1", { child: ids[7]! })],
      ["other DPoP key", async () => check(a, b, "h1", { jkt: await jkt(workloadKey()) })],
      ["scope", () => check(a, body({ authorization_details: toolScope([T.read], "read") as DelegationBody["authorization_details"] }), "h1")],
      ["resource", () => check(a, body({ resource: `${ISSUER}/mcp/${randomUUID()}` }), "h1")],
      ["project", () => check(a, body({ project_id: randomUUID() }), "h1")],
      ["env", () => check(a, body({ env: "production" }), "h1")],
      ["cap", () => check(a, body({ cap_micros: M(11) }), "h1")],
      ["depth", () => check(a, body({ max_depth: 2 }), "h1")],
      ["lifetime", () => check(a, body({ expires_at: b.expires_at + 60 }), "h1")],
      ["idempotency key", () => check(a, b, "h2")],
    ];
    for (const [label, run] of subs) {
      const r = await run();
      expect(r.ok, label).toBe(false);
    }
    const ok = await check(a, b, "h1");
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const replay = await check(a, b, "h1");
    expect(replay.ok ? "" : replay.code).toBe("authz_replayed");

    // the caller then admits exactly the signed body, bound to B's key
    const credB = await registerJwk(ids[6]!, workloadKey());
    const child = await admitChildGrant(db, { environment: b.env, projectId: b.project_id,
      parentGrantId: parentGrant,
      actorIdentityId: ids[6]!,
      scope: b.authorization_details,
      capMicros: b.cap_micros,
      expiresAt: new Date(b.expires_at * 1000),
      maxFurtherDepth: b.max_depth,
      idempotencyKey: "h1",
      binding: { kind: "dpop", thumbprint: await jkt(Bkey), authCredentialId: credB, audience: b.resource },
    });
    const t = await mintDelegatedToken(db, { grantId: child.grant.id, issuer: ISSUER, secrets: SECRETS });
    const p = JSON.parse(Buffer.from(t.accessToken.split(".")[1]!, "base64url").toString());
    expect(p.cnf).toEqual({ jkt: await jkt(Bkey) });
    expect(p.client_id).toBe(SPIFFE("i6"));
    expect(p.act).toEqual({ sub: SPIFFE("i6"), act: { sub: SPIFFE("i5") } });
  });

  it("a stolen parent token without A's key is useless; a forged signer is refused", async () => {
    const b = body();
    const forged = await new SignJWT({ htm: "POST", htu: TOKEN_ENDPOINT, ath: b64sha(parentToken), nonce: issueDpopNonce(SECRETS.nonceKey), parent_grant_id: parentGrant, child: ids[6]!, child_cnf: await jkt(Bkey), delegation: canonicalDelegationBody(b), idempotency_key: "f1" })
      .setProtectedHeader({ alg: "EdDSA", typ: "regulait-delegation-authz+jwt", jwk: Bkey.jwk })
      .setIssuer(SPIFFE("i5"))
      .setAudience(ISSUER)
      .setIssuedAt()
      .setJti(randomUUID())
      .sign(Bkey.privateKey);
    const r = await check(forged, b, "f1");
    expect(r.ok ? "" : r.code).toBe("authz_not_parent_key");
    const stale = await authz(b, "f2", { iat: Math.floor(Date.now() / 1000) - 61 });
    expect((await check(stale, b, "f2")).ok).toBe(false);
  });

  it("a body A genuinely SIGNED with an env or project other than the parent's is refused delegation_body_mismatch, before any claim; admission refuses the same", async () => {
    for (const [label, over] of [
      ["env", { env: "production" }],
      ["project", { project_id: randomUUID() }],
    ] as const) {
      const b = body(over);
      const a = await authz(b, `bm-${label}`);
      const r = await check(a, b, `bm-${label}`);
      expect(r.ok ? "" : r.code, label).toBe("delegation_body_mismatch");
    }
    const credB = await registerJwk(ids[6]!, workloadKey());
    for (const over of [{ environment: "production", projectId: null }, { environment: ENV, projectId: randomUUID() }]) {
      const e = await refusal(
        admitChildGrant(db, {
          ...over,
          parentGrantId: parentGrant,
          actorIdentityId: ids[6]!,
          scope: toolScope([T.write]),
          capMicros: M(1),
          expiresAt: new Date(Date.now() + 600_000),
          idempotencyKey: `bm-${over.environment}-${over.projectId ?? "none"}`,
          binding: { kind: "dpop", thumbprint: await jkt(Bkey), authCredentialId: credB, audience },
        }),
      );
      expect(e.code).toBe("delegation_body_mismatch");
    }
  });

  it("a certificate-bound (mTLS) parent cannot hand off across processes in v1", async () => {
    const cert = new Uint8Array(Buffer.from(`mtls-parent-${RUN}`));
    const cred = await registerJwk(ids[7]!, workloadKey());
    const g = await createRootGrant(db, { sponsorUserId: userId, actorIdentityId: ids[7]!, scope: toolScope([T.write]), capMicros: null, environment: ENV, expiresAt: hour(), projectId: null, binding: { kind: "mtls", thumbprint: b64sha(cert), authCredentialId: cred, audience } });
    const t = await mintDelegatedToken(db, { grantId: g.id, issuer: ISSUER, secrets: SECRETS });
    const r = await check(await authz(body(), "m1"), body(), "m1", { parentToken: t.accessToken });
    expect(r.ok ? "" : r.code).toBe("mtls_parent_handoff_unsupported");
  });

  it("a first-use race on two pools between the intended request and a substituted one admits only the intended", async () => {
    const b = body();
    const a = await authz(b, "race");
    const [x, y] = await Promise.all([check(a, b, "race", { dbx: db }), check(a, body({ cap_micros: M(12) }), "race", { dbx: db2 })]);
    expect([x.ok, y.ok]).toEqual([true, false]);
    // two identical intended requests on two pools: exactly one wins
    const a2 = await authz(b, "race2");
    const both = await Promise.all([check(a2, b, "race2", { dbx: db }), check(a2, b, "race2", { dbx: db2 })]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0188 S3 — decision 14: replay claims are one atomic insert", () => {
  it("concurrent claims of one key on two pools give exactly one winner; a repeat is refused", async () => {
    const key = `s3-${RUN}-${randomUUID()}`;
    const until = new Date(Date.now() + 60_000);
    const out = await Promise.all([claimReplay(db, "client_assertion", key, until), claimReplay(db2, "client_assertion", key, until), claimReplay(db, "client_assertion", key, until)]);
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(await claimReplay(db2, "client_assertion", key, until)).toBe(false);
    // the same key in another namespace is a different claim
    expect(await claimReplay(db, "as_dpop", key, until)).toBe(true);
  });

  it("the sweep selects by the database clock: expired claims go, live ones stay, and the guard never aborts it", async () => {
    const dead = `s3-${RUN}-dead-${randomUUID()}`;
    const live = `s3-${RUN}-live-${randomUUID()}`;
    await db.insert(replayClaims).values({ namespace: "client_assertion", key: dead, claimedAt: sql`now() - interval '2 minutes'`, expiresAt: sql`now() - interval '1 minute'` });
    expect(await claimReplay(db, "client_assertion", live, new Date(Date.now() + 60_000))).toBe(true);
    expect(await sweepReplayClaims(db)).toBeGreaterThanOrEqual(1);
    const left = (await db.select({ key: replayClaims.key }).from(replayClaims).where(sql`${replayClaims.key} in (${dead}, ${live})`)).map((r) => r.key);
    expect(left).toEqual([live]);
  });
});

// keep the strict org settings this file depends on visible (nothing here relaxes them)
it("the identity settings this file ran under are the strict defaults", async () => {
  const [s] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  expect([s!.agentEntitlementMode, s!.delegatedTokenTtlSeconds, s!.delegationMaxDepth, s!.dpopNonceRequired]).toEqual(["own_grants", 300, 3, true]);
});
