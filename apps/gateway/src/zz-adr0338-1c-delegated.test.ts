/**
 * ADR-0338 slice 1c — connecting a DELEGATED vendor control credential (one named admin account) through Entra's
 * authorization-code flow with PKCE, stored only once a SECOND administrator approves it, and used with a refresh
 * token that rotates on use. A real database and the real `@azure/msal-node`, with a fake Entra token endpoint behind
 * the guarded fetch (fixtures only, no live tenant).
 *
 *  - THE MACHINE (`VENDOR_CONTROL_DELEGATED_MACHINE`): awaiting_sign_in → awaiting_approval → connected, or failed,
 *    denied, cancelled, expired. The table refuses any other move, an identity change, a change to a final row, the
 *    requester as approver, a verifier outside awaiting_sign_in and a held token outside awaiting_approval; TRUNCATE
 *    is refused.
 *  - STARTING: off until the delegated opt-in is on; a `settings_relax` step-up bound to source, account, tenant, app,
 *    expiry, the row replaced and the approver; a second eligible admin; one open request per source.
 *  - THE CALLBACK: only the admin who started it; the code is redeemed with the stored verifier and a federated
 *    assertion; the account, tenant and nonce must match; the refresh token is HELD encrypted and an approval queued.
 *  - THE DECISION: never the requester, only the named approver, with an `approval_decide` step-up bound to the digest;
 *    approve stores the credential (revoking a replaced row), deny destroys the held token.
 *  - EXPIRY AND CANCEL: a passed sign-in window or approval expires the request and destroys what it held.
 *  - USE: the refresh token is redeemed for exactly the delegated scope, the rotated one replaces it in the same row,
 *    and a token for another account is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  approvals,
  auditLog,
  createDb,
  discoveryCredentials,
  discoverySettings,
  discoverySources,
  egressAllowHosts,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  users,
  vendorControlDelegatedRequests,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { COPILOT_STUDIO_CONTROL, POWER_PLATFORM_DELEGATED_SCOPE } from "./agent-platform-copilot-studio-control.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { controlCredentialResolver } from "./vendor-agent-control-credentials.js";
import {
  DELEGATED_CALLBACK_PATH,
  delegatedDecideStepUp,
  delegatedStartSchema,
  delegatedStepUp,
  vendorControlDelegatedApprovalLabels,
} from "./vendor-agent-control-delegated.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `a338c-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
// synthetic, derived at runtime: never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`a338c-data-key-${RUN}`).digest("hex");
const ASSERTION = `a338c-assertion-${randomBytes(8).toString("hex")}`;
const TENANT = "00000000-0000-4000-8000-000000000c38";
const READ_APP = "00000000-0000-4000-8000-0000000000c1";
const WRITE_APP = "00000000-0000-4000-8000-0000000000c2";
const ACCOUNT_OID = "0a000000-0000-4000-8000-000000000c38";
const UPN = `quarantine-admin-${RUN}@contoso.example`;
const startUrl = (sourceId: string) => `/v1/discovery/sources/${sourceId}/control-credential/delegated`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

// ---- the fake Entra token endpoint: codes (bound to a PKCE challenge and a nonce) and rotating refresh tokens ----
const entra = {
  codes: new Map<string, { challenge: string; nonce: string; upn: string; oid: string }>(),
  /** refresh token → the account it belongs to */
  refreshTokens: new Map<string, { upn: string; oid: string }>(),
  bodies: [] as URLSearchParams[],
  otherHosts: [] as string[],
  /** the account a refresh answers for (to show a token for another account is refused) */
  refreshAs: null as null | { upn: string; oid: string },
  /** omit the refresh token from the code redemption */
  noRefreshToken: false,
  /** answer the code redemption with an ID token for another nonce (a replayed sign-in) */
  otherNonce: false,
};
const idToken = (claims: Record<string, unknown>) => `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(claims)}.c2ln`;
function tokenResponse(acct: { upn: string; oid: string }, nonce: string | undefined, withRefresh: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const rt = `a338c-rt-${randomBytes(12).toString("hex")}`;
  if (withRefresh) entra.refreshTokens.set(rt, acct);
  return json({
    token_type: "Bearer",
    scope: `${POWER_PLATFORM_DELEGATED_SCOPE} openid profile offline_access`,
    expires_in: 3600,
    ext_expires_in: 3600,
    access_token: `a338c-at-${randomBytes(12).toString("hex")}`,
    ...(withRefresh ? { refresh_token: rt } : {}),
    id_token: idToken({ aud: WRITE_APP, iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, iat: now, nbf: now, exp: now + 3600, tid: TENANT, oid: acct.oid, sub: `sub-${acct.oid}`, preferred_username: acct.upn, name: "Quarantine Admin", ...(nonce ? { nonce } : {}) }),
    client_info: b64u({ uid: acct.oid, utid: TENANT }),
  });
}
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = urlOf(input);
  if (url.hostname !== "login.microsoftonline.com" || url.pathname !== `/${TENANT}/oauth2/v2.0/token`) {
    entra.otherHosts.push(url.href);
    return json({}, 404);
  }
  const body = new URLSearchParams(String(init?.body ?? ""));
  entra.bodies.push(body);
  if (body.get("client_assertion") !== ASSERTION || body.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
    return json({ error: "invalid_client", error_description: "AADSTS700027: Client assertion failed signature validation." }, 401);
  }
  if (body.get("grant_type") === "authorization_code") {
    const c = entra.codes.get(body.get("code") ?? "");
    entra.codes.delete(body.get("code") ?? "");
    if (!c || s256(body.get("code_verifier") ?? "") !== c.challenge) return json({ error: "invalid_grant", error_description: "AADSTS501481: The Code_Verifier does not match the code_challenge." }, 400);
    return tokenResponse({ upn: c.upn, oid: c.oid }, entra.otherNonce ? randomBytes(32).toString("base64url") : c.nonce, !entra.noRefreshToken);
  }
  if (body.get("grant_type") === "refresh_token") {
    const acct = entra.refreshTokens.get(body.get("refresh_token") ?? "");
    if (!acct) return json({ error: "invalid_grant", error_description: "AADSTS70008: The refresh token has expired." }, 400);
    return tokenResponse(entra.refreshAs ?? acct, undefined, true);
  }
  return json({ error: "unsupported_grant_type" }, 400);
}) as typeof fetch;
const resolve = async () => [{ address: "20.190.0.1", family: 4 }];

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let approverId: string;
let otherAdminId: string;
const restores: Array<() => Promise<unknown>> = [];
const sourceIds: string[] = [];
const egressAllowIds: string[] = [];

type Method = "GET" | "POST" | "PUT" | "DELETE";
async function as(who: string, args: StepUpCheckArgs | null, method: Method, url: string, payload?: unknown) {
  const g = await grantStepUpForTest(db, who, args ?? { kind: "settings_relax", facts: { unused: RUN } });
  const r = args ? stepUpRequest(g) : sessionRequest(g);
  return app.inject({ method, url, headers: r.headers, cookies: r.cookies, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function seedSource(kind: "agent_registry_copilot_studio" | "agent_registry_entra" = "agent_registry_copilot_studio") {
  const [src] = await db
    .insert(discoverySources)
    .values({ name: `a338c-${RUN}-${randomUUID().slice(0, 8)}`, kind, target: { tenantId: TENANT, orgUrls: "https://contoso.crm4.dynamics.com" }, scope: { orgLevel: true, include: [] }, createdBy: adminId, enabled: false })
    .returning({ id: discoverySources.id });
  sourceIds.push(src!.id);
  await db.insert(discoveryCredentials).values({ sourceId: src!.id, credentialMode: "federated", publicConfig: { tenantId: TENANT, clientId: READ_APP }, createdBy: adminId });
  return src!.id;
}
const startBody = (b: Record<string, unknown> = {}) => ({ tenantId: TENANT, clientId: WRITE_APP, account: UPN, expiresInDays: 14, replacesCredentialId: null, approverUserId: approverId, ...b });
async function start(sourceId: string, b: Record<string, unknown> = {}, who = adminId) {
  const payload = startBody(b);
  return as(who, delegatedStepUp(sourceId, delegatedStartSchema.parse(payload)), "POST", startUrl(sourceId), payload);
}
/** the browser leg: Entra signs the account in and issues a code bound to the URL's challenge and nonce */
function signIn(authorizationUrl: string, acct = { upn: UPN, oid: ACCOUNT_OID }) {
  const u = new URL(authorizationUrl);
  const code = `a338c-code-${randomBytes(8).toString("hex")}`;
  entra.codes.set(code, { challenge: u.searchParams.get("code_challenge")!, nonce: u.searchParams.get("nonce")!, ...acct });
  return { code, state: u.searchParams.get("state")! };
}
const callback = (q: Record<string, string>, who = adminId) => as(who, null, "GET", `${DELEGATED_CALLBACK_PATH}?${new URLSearchParams(q)}`);
const setOptIn = (on: boolean) => db.update(discoverySettings).set({ vendorAgentControlDelegatedEnabled: on }).where(eq(discoverySettings.id, 1));
const liveControl = async (sourceId: string) =>
  (await db.select().from(discoveryCredentials).where(sql`${discoveryCredentials.sourceId} = ${sourceId} AND ${discoveryCredentials.purpose} = 'platform_write' AND ${discoveryCredentials.revokedAt} IS NULL`))[0];
const requestRow = async (id: string) => (await db.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.id, id)))[0]!;
const approvalOf = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
async function decide(approvalId: string, decision: "approved" | "denied" = "approved", who = approverId, grant: "right" | "none" | "wrong" = "right", reason?: string) {
  const ap = await approvalOf(approvalId);
  const g = await grantStepUpForTest(db, who, delegatedDecideStepUp(ap.id, decision, grant === "wrong" ? "0".repeat(64) : ap.argumentsDigest!));
  const r = grant === "none" ? sessionRequest(g) : stepUpRequest(g);
  return app.inject({ method: "POST", url: `/v1/approvals/${ap.id}/decide`, headers: r.headers, cookies: r.cookies, payload: { decision, ...(reason ? { reason } : {}) } });
}
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const c = (e as { cause?: { constraint?: string; message?: string } }).cause;
    return c?.constraint ?? c?.message ?? String(e);
  }
  return "no error";
}
/** start, sign in: the request awaiting the second administrator */
async function signedIn(sourceId: string, b: Record<string, unknown> = {}) {
  const s = await start(sourceId, b);
  expect(s.statusCode, s.body).toBe(201);
  const cb = await callback(signIn(s.json().authorizationUrl));
  expect(cb.statusCode, cb.body).toBe(202);
  return cb.json().request as { id: string; approvalId: string; status: string };
}
async function connect(sourceId: string, b: Record<string, unknown> = {}) {
  const r = await signedIn(sourceId, b);
  const d = await decide(r.approvalId);
  expect(d.statusCode, d.body).toBe(200);
  const row = await requestRow(r.id);
  expect(row.status).toBe("connected");
  return (await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.id, row.credentialId!)))[0]!;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [s0] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restores.push(() => db.update(discoverySettings).set({ vendorAgentControlDelegatedEnabled: s0!.vendorAgentControlDelegatedEnabled }).where(eq(discoverySettings.id, 1)));
  const [o0] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(() => db.update(orgSettings).set({ stepUpMode: o0!.stepUpMode, stepUpActions: o0!.stepUpActions }).where(eq(orgSettings.id, ORG_SETTINGS_ID)));
  // the production routes and resolver; the guarded fetch's transport, DNS and the federation issuer are test seams
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, vendorAgentControl: { fetchImpl: fakeFetch, resolve, federationToken: () => async () => ASSERTION } });
  await app.ready();
  const [existing] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "login.microsoftonline.com"));
  if (!existing) {
    const allow = await relaxStepUpAround(db, () => app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: "login.microsoftonline.com", note: "ADR-0338 slice 1c suite: the fake Entra" } }));
    expect([200, 201], allow.body).toContain(allow.statusCode);
    egressAllowIds.push(allow.json().id);
  }
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const ids: string[] = [];
  for (const who of ["admin", "approver", "other"]) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `a338c-${who}-${RUN}@example.com`, displayName: `a338c ${who}` } });
    expect(u.statusCode, u.body).toBe(201);
    await db.update(users).set({ isAdmin: true, totpEnabled: true }).where(eq(users.id, u.json().id));
    ids.push(u.json().id);
  }
  [adminId, approverId, otherAdminId] = ids as [string, string, string];
  await setOptIn(true);
}, 120_000);

afterAll(async () => {
  const removals = [];
  for (const id of egressAllowIds) removals.push(await removeEgressAllowEntry(app, AUTH, { id }));
  try {
    if (db) {
      if (sourceIds.length) await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
      for (const id of [adminId, approverId, otherAdminId]) if (id) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, id));
      for (const r of restores.reverse()) await r();
    }
    await app?.close();
  } finally {
    for (const r of removals) r.assertRemoved();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
describe("ADR-0338 slice 1c: the request table holds the machine", () => {
  it("shapes, two people, a 10-minute window, only the machine's moves, final rows fixed, and no TRUNCATE", async () => {
    const sourceId = await seedSource();
    const base = { sourceId, requestedBy: adminId, approverUserId: approverId, nonce: randomBytes(32).toString("base64url"), codeVerifierCiphertext: encryptSecret(DATA_KEY, "v"), tenantId: TENANT, clientId: WRITE_APP, accountUpn: UPN, expiresInDays: 30, redirectUri: "https://gw.example/cb" };
    type Insert = typeof vendorControlDelegatedRequests.$inferInsert;
    const ins = (v: { [K in keyof Insert]?: Insert[K] | ReturnType<typeof sql> }) =>
      db.insert(vendorControlDelegatedRequests).values({ ...base, state: randomBytes(32).toString("base64url"), signInExpiresAt: sql`now() + interval '5 minutes'`, ...v } as Insert).returning();
    expect(await pgError(ins({ state: "short" }))).toBe("vendor_control_delegated_requests_state_check");
    expect(await pgError(ins({ signInExpiresAt: sql`now() + interval '11 minutes'` }))).toBe("vendor_control_delegated_requests_window_check");
    expect(await pgError(ins({ expiresInDays: 91 }))).toBe("vendor_control_delegated_requests_days_check");
    expect(await pgError(ins({ accountUpn: "Mixed@Case.example" }))).toBe("vendor_control_delegated_requests_account_check");
    expect(await pgError(ins({ codeVerifierCiphertext: null }))).toBe("vendor_control_delegated_requests_verifier_check");
    expect(await pgError(ins({ approverUserId: adminId }))).toBe("vendor_control_delegated_requests_two_people_check");
    const [row] = await ins({});
    // one open request per source
    expect(await pgError(ins({}))).toBe("vendor_control_delegated_requests_open_uq");
    const upd = (v: Partial<typeof vendorControlDelegatedRequests.$inferInsert>) => pgError(db.update(vendorControlDelegatedRequests).set(v).where(eq(vendorControlDelegatedRequests.id, row!.id)));
    expect(await upd({ accountUpn: "someone-else@contoso.example" })).toMatch(/along its machine/);
    expect(await upd({ approverUserId: otherAdminId })).toMatch(/along its machine/);
    // awaiting_sign_in cannot jump to connected or denied
    expect(await upd({ status: "denied", codeVerifierCiphertext: null })).toMatch(/along its machine/);
    // a move must destroy what the state held
    expect(await upd({ status: "expired" })).toBe("vendor_control_delegated_requests_verifier_check");
    expect(await upd({ status: "expired", codeVerifierCiphertext: null, outcomeCode: "sign_in_window_passed" })).toBe("no error");
    // a final row never changes
    expect(await upd({ outcomeCode: "other" })).toMatch(/along its machine/);
    expect(await pgError(db.execute(sql`TRUNCATE vendor_control_delegated_requests`))).toMatch(/TRUNCATE/i);
  });
});

describe("ADR-0338 slice 1c: starting a delegated sign-in", () => {
  it("refused while the opt-in is off, without the bound step-up, without a second eligible admin, and for the wrong tenant, app, vendor or replaced row", async () => {
    const sourceId = await seedSource();
    await setOptIn(false);
    try {
      expect((await start(sourceId)).json().error).toBe("credential_mode_disabled");
    } finally {
      await setOptIn(true);
    }
    // a step-up bound to other facts (a different account, a different approver) is not this one
    const payload = startBody();
    const wrong = await as(adminId, delegatedStepUp(sourceId, delegatedStartSchema.parse({ ...payload, account: `other-${UPN}` })), "POST", startUrl(sourceId), payload);
    expect(wrong.statusCode).toBe(403);
    const wrongApprover = await as(adminId, delegatedStepUp(sourceId, delegatedStartSchema.parse({ ...payload, approverUserId: otherAdminId })), "POST", startUrl(sourceId), payload);
    expect(wrongApprover.statusCode).toBe(403);
    const refused = async (b: Record<string, unknown>, status: number, error: string, sid = sourceId) => {
      const r = await start(sid, b);
      expect(r.statusCode, r.body).toBe(status);
      expect(r.json().error).toBe(error);
    };
    await refused({ tenantId: "00000000-0000-4000-8000-00000000ffff" }, 400, "credential_target_mismatch");
    await refused({ clientId: READ_APP }, 400, "write_app_is_read_app");
    await refused({ replacesCredentialId: randomUUID() }, 409, "credential_conflict");
    await refused({ approverUserId: adminId }, 422, "approver_is_requester");
    await refused({ approverUserId: randomUUID() }, 422, "approver_not_eligible");
    await refused({}, 409, "control_not_offered", await seedSource("agent_registry_entra"));
    expect((await as(adminId, null, "POST", startUrl(sourceId), { ...payload, expiresInDays: 91 })).statusCode).toBe(400);
    expect((await as(adminId, null, "POST", startUrl(sourceId), { ...payload, approverUserId: undefined })).statusCode).toBe(400);
    expect(await db.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.sourceId, sourceId))).toHaveLength(0);
    // one open request per source
    expect((await start(sourceId)).statusCode).toBe(201);
    await refused({}, 409, "delegated_request_open");
  });

  it("answers an authorization URL with the S256 challenge, state, nonce and login hint, keeping the verifier encrypted server side", async () => {
    const sourceId = await seedSource();
    const r = await start(sourceId);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().request).toMatchObject({ status: "awaiting_sign_in", approverUserId: approverId, lifecycle: { state: "awaiting_sign_in" } });
    const u = new URL(r.json().authorizationUrl);
    expect(u.origin + u.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    const q = u.searchParams;
    expect(q.get("client_id")).toBe(WRITE_APP);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("login_hint")).toBe(UPN);
    expect(q.get("prompt")).toBe("login");
    expect(q.get("redirect_uri")).toMatch(/\/v1\/discovery\/control-credential\/delegated\/callback$/);
    expect(q.get("scope")!.split(" ")).toEqual(expect.arrayContaining([POWER_PLATFORM_DELEGATED_SCOPE, "offline_access"]));
    const [row] = await db.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.state, q.get("state")!));
    expect(row).toMatchObject({ sourceId, requestedBy: adminId, approverUserId: approverId, status: "awaiting_sign_in", nonce: q.get("nonce"), accountUpn: UPN, expiresInDays: 14, refreshTokenCiphertext: null });
    const verifier = decryptSecret(DATA_KEY, row!.codeVerifierCiphertext!);
    expect(s256(verifier)).toBe(q.get("code_challenge"));
    expect(u.href).not.toContain(verifier);
    expect(r.body).not.toContain(row!.codeVerifierCiphertext!);
    expect(row!.signInExpiresAt.getTime() - row!.requestedAt.getTime()).toBeLessThanOrEqual(10 * 60_000);
    // building the URL made no network call
    expect(entra.otherHosts).toEqual([]);
    const [a] = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'vendor-control-delegated-requested' AND ${auditLog.detail}->>'requestId' = ${row!.id}`);
    expect(a?.detail).toMatchObject({ accountUpn: UPN, tenantId: TENANT, clientId: WRITE_APP, expiresInDays: 14, approverUserId: approverId });
  });
});

describe("ADR-0338 slice 1c: the callback and the second administrator", () => {
  it("holds the refresh token encrypted and queues the approval; only the approver's approval stores the credential", async () => {
    const sourceId = await seedSource();
    const s = await start(sourceId);
    const before = entra.bodies.length;
    const { code, state } = signIn(s.json().authorizationUrl);
    const cb = await callback({ code, state });
    expect(cb.statusCode, cb.body).toBe(202);
    expect(cb.json().request).toMatchObject({ status: "awaiting_approval", accountObjectId: ACCOUNT_OID, lifecycle: { state: "awaiting_approval" } });
    const body = entra.bodies.slice(before);
    expect(body).toHaveLength(1);
    expect(body[0]!.get("grant_type")).toBe("authorization_code");
    expect(body[0]!.get("client_secret")).toBeNull();
    expect(body[0]!.get("client_assertion")).toBe(ASSERTION);
    // nothing is stored yet: the token is held on the request
    expect(await liveControl(sourceId)).toBeUndefined();
    const req = await requestRow(cb.json().request.id);
    expect(req.codeVerifierCiphertext).toBeNull();
    const held = decryptSecret(DATA_KEY, req.refreshTokenCiphertext!);
    expect(entra.refreshTokens.has(held)).toBe(true);
    expect(cb.body).not.toContain(held);
    const ap = await approvalOf(req.approvalId!);
    expect(ap).toMatchObject({ status: "pending", objectType: "vendor_control_delegated", userId: adminId, approverUserId: approverId, stageId: `__vendor_control_delegated__:${req.id}` });
    expect(ap.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
    const labels = await vendorControlDelegatedApprovalLabels(db, [ap.stageId]);
    expect(labels.get(ap.stageId!)).toContain(UPN);
    // spent: the same redirect again is refused
    expect((await callback({ code, state })).json().error).toBe("delegated_request_used");
    // the approver approves with the bound step-up
    const d = await decide(req.approvalId!);
    expect(d.statusCode, d.body).toBe(200);
    const done = await requestRow(req.id);
    expect(done).toMatchObject({ status: "connected", refreshTokenCiphertext: null, outcomeCode: "connected" });
    const cred = await liveControl(sourceId);
    expect(cred!.id).toBe(done.credentialId);
    expect(cred).toMatchObject({ credentialMode: "delegated", purpose: "platform_write", createdBy: adminId, publicConfig: { tenantId: TENANT, clientId: WRITE_APP, accountObjectId: ACCOUNT_OID, accountUpn: UPN } });
    expect(decryptSecret(DATA_KEY, cred!.secretCiphertext!)).toBe(held);
    expect(cred!.expiresAt!.getTime() - cred!.createdAt.getTime()).toBe(14 * 86_400_000);
    const [a] = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'vendor-control-credential-stored' AND ${auditLog.objectId} = ${cred!.id}`);
    expect(a?.detail).toMatchObject({ mode: "delegated", accountObjectId: ACCOUNT_OID, accountUpn: UPN, requestedBy: adminId, approvedBy: approverId });
    // the request's lifecycle is readable
    const g = await as(otherAdminId, null, "GET", `/v1/discovery/control-credential/delegated/${req.id}`);
    expect(g.json().request).toMatchObject({ status: "connected", lifecycle: { state: "connected" } });
  });

  it("the decision refuses the requester, an admin who is not the approver, no step-up and a step-up for another digest; deny destroys the held token", async () => {
    const sourceId = await seedSource();
    const r = await signedIn(sourceId);
    const own = await decide(r.approvalId, "approved", adminId, "right", "override");
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_delegated_credential");
    const outside = await decide(r.approvalId, "approved", otherAdminId, "right", "override");
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error).toBe("not_an_eligible_approver");
    expect((await decide(r.approvalId, "approved", approverId, "none")).statusCode).toBe(403);
    expect((await decide(r.approvalId, "approved", approverId, "wrong")).statusCode).toBe(403);
    expect((await requestRow(r.id)).status).toBe("awaiting_approval");
    expect(await liveControl(sourceId)).toBeUndefined();
    const denied = await decide(r.approvalId, "denied");
    expect(denied.statusCode, denied.body).toBe(200);
    expect(await requestRow(r.id)).toMatchObject({ status: "denied", refreshTokenCiphertext: null, outcomeCode: "denied_by_approver", credentialId: null });
    expect(await liveControl(sourceId)).toBeUndefined();
  });

  it("only the admin who started it can complete it, and a declined, expired or wrong-account sign-in stores nothing", async () => {
    const sourceId = await seedSource();
    const s = await start(sourceId);
    const leg = signIn(s.json().authorizationUrl);
    const other = await callback(leg, otherAdminId);
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe("delegated_request_not_yours");
    // the wrong admin did not spend it
    expect((await requestRow(s.json().request.id)).status).toBe("awaiting_sign_in");
    const failed = async (go: (sid: string) => Promise<{ statusCode: number; json: () => { error: string } }>, status: number, error: string, outcome: string) => {
      const sid = await seedSource();
      const r = await go(sid);
      expect(r.statusCode).toBe(status);
      expect(r.json().error).toBe(error);
      const [row] = await db.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.sourceId, sid));
      expect(row).toMatchObject({ status: "failed", outcomeCode: outcome, codeVerifierCiphertext: null, refreshTokenCiphertext: null, approvalId: null });
      expect(await liveControl(sid)).toBeUndefined();
    };
    await failed(async (sid) => callback(signIn((await start(sid)).json().authorizationUrl, { upn: `intruder-${RUN}@contoso.example`, oid: randomUUID() })), 403, "delegated_account_mismatch", "delegated_account_mismatch");
    await failed(async (sid) => callback({ state: new URL((await start(sid)).json().authorizationUrl).searchParams.get("state")!, error: "access_denied" }), 400, "delegated_sign_in_failed", "sign_in_declined");
    entra.noRefreshToken = true;
    try {
      await failed(async (sid) => callback(signIn((await start(sid)).json().authorizationUrl)), 502, "delegated_no_refresh_token", "delegated_no_refresh_token");
    } finally {
      entra.noRefreshToken = false;
    }
    // an ID token minted for another sign-in's nonce: msal refuses the redemption (our own check is a second guard)
    entra.otherNonce = true;
    try {
      await failed(async (sid) => callback(signIn((await start(sid)).json().authorizationUrl)), 502, "control_token_failed", "control_token_failed");
    } finally {
      entra.otherNonce = false;
    }
    // the first request is still completable by the admin who started it
    expect((await callback(leg)).statusCode).toBe(202);
  });
});

describe("ADR-0338 slice 1c: expiry and cancel", () => {
  it("a passed sign-in window and a passed approval expire the request and destroy what it held", async () => {
    const sourceId = await seedSource();
    const state = randomBytes(32).toString("base64url");
    const [old] = await db
      .insert(vendorControlDelegatedRequests)
      .values({
        sourceId,
        requestedBy: adminId,
        approverUserId: approverId,
        state,
        nonce: randomBytes(32).toString("base64url"),
        codeVerifierCiphertext: encryptSecret(DATA_KEY, "v"),
        tenantId: TENANT,
        clientId: WRITE_APP,
        accountUpn: UPN,
        expiresInDays: 30,
        redirectUri: "https://gw.example/cb",
        requestedAt: sql`now() - interval '20 minutes'`,
        signInExpiresAt: sql`now() - interval '11 minutes'`,
      })
      .returning();
    expect((await callback({ state, code: "x" })).json().error).toBe("delegated_request_expired");
    expect(await requestRow(old!.id)).toMatchObject({ status: "expired", outcomeCode: "sign_in_window_passed", codeVerifierCiphertext: null });
    // the approval window: the approval's own expiry
    const r = await signedIn(sourceId);
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(approvals.id, r.approvalId));
    const g = await as(adminId, null, "GET", `/v1/discovery/control-credential/delegated/${r.id}`);
    expect(g.json().request).toMatchObject({ status: "expired", outcomeCode: "approval_expired", lifecycle: { state: "expired" } });
    expect((await requestRow(r.id)).refreshTokenCiphertext).toBeNull();
    expect((await approvalOf(r.approvalId)).status).toBe("superseded");
    expect(await liveControl(sourceId)).toBeUndefined();
  });

  it("cancel withdraws an open request (before or after the sign-in) and supersedes its approval; a final one cannot be cancelled", async () => {
    const sourceId = await seedSource();
    const s = await start(sourceId);
    const c1 = await as(adminId, null, "POST", `/v1/discovery/control-credential/delegated/${s.json().request.id}/cancel`, {});
    expect(c1.statusCode, c1.body).toBe(200);
    expect(c1.json().request).toMatchObject({ status: "cancelled" });
    const r = await signedIn(sourceId);
    const c2 = await as(adminId, null, "POST", `/v1/discovery/control-credential/delegated/${r.id}/cancel`, {});
    expect(c2.statusCode, c2.body).toBe(200);
    expect(await requestRow(r.id)).toMatchObject({ status: "cancelled", refreshTokenCiphertext: null });
    expect((await approvalOf(r.approvalId)).status).toBe("superseded");
    const again = await as(adminId, null, "POST", `/v1/discovery/control-credential/delegated/${r.id}/cancel`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("delegated_request_not_open");
    expect(await liveControl(sourceId)).toBeUndefined();
  });
});

describe("ADR-0338 slice 1c: replacing", () => {
  it("approval revokes the old row and destroys its secret; a credential that moved while the approval was open is refused", async () => {
    const sourceId = await seedSource();
    const first = await connect(sourceId);
    const second = await connect(sourceId, { replacesCredentialId: first.id });
    const [old] = await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.id, first.id));
    expect(old!.revokedAt).not.toBeNull();
    expect(old!.secretCiphertext).toBeNull();
    // the request names the current row, then the row is revoked before the approver decides
    const r = await signedIn(sourceId, { replacesCredentialId: second.id });
    await db.update(discoveryCredentials).set({ revokedAt: new Date(), revokedBy: adminId, secretCiphertext: null }).where(eq(discoveryCredentials.id, second.id));
    const moved = await decide(r.approvalId);
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error).toBe("credential_changed");
    expect((await requestRow(r.id)).status).toBe("awaiting_approval");
    expect(await liveControl(sourceId)).toBeUndefined();
    expect((await decide(r.approvalId, "denied")).statusCode).toBe(200);
  });

  it("the read credential can never be re-pointed at the control credential's app (review of #1120)", async () => {
    const sourceId = await seedSource();
    await connect(sourceId);
    const [read] = await db.select().from(discoveryCredentials).where(sql`${discoveryCredentials.sourceId} = ${sourceId} AND ${discoveryCredentials.purpose} = 'discovery_read'`);
    const r = await as(adminId, null, "PUT", `/v1/discovery/sources/${sourceId}/credential`, { mode: "federated", publicConfig: { tenantId: TENANT, clientId: WRITE_APP }, replacesCredentialId: read!.id });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toBe("read_app_is_write_app");
  });
});

describe("ADR-0338 slice 1c: using a delegated credential", () => {
  it("redeems the refresh token for exactly the delegated scope, stores the rotated one, and refuses a token for another account", async () => {
    const sourceId = await seedSource();
    await connect(sourceId);
    const resolver = controlCredentialResolver({ dataKey: DATA_KEY, fetch: async () => fakeFetch, federationToken: () => async () => ASSERTION });
    const rt0 = decryptSecret(DATA_KEY, (await liveControl(sourceId))!.secretCiphertext!);
    const before = entra.bodies.length;
    const l = await resolver(db, sourceId, COPILOT_STUDIO_CONTROL);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const token = await l.credential.acquire(AbortSignal.timeout(10_000));
    expect(token).toMatch(/^a338c-at-/);
    const sent = entra.bodies.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("grant_type")).toBe("refresh_token");
    expect(sent[0]!.get("refresh_token")).toBe(rt0);
    expect(sent[0]!.get("scope")!.split(" ")).toContain(POWER_PLATFORM_DELEGATED_SCOPE);
    const rt1 = decryptSecret(DATA_KEY, (await liveControl(sourceId))!.secretCiphertext!);
    expect(rt1).not.toBe(rt0);
    expect(entra.refreshTokens.has(rt1)).toBe(true);
    // the next use redeems the rotated token
    const l2 = await resolver(db, sourceId, COPILOT_STUDIO_CONTROL);
    if (l2.ok) await l2.credential.acquire(AbortSignal.timeout(10_000));
    expect(entra.bodies.at(-1)!.get("refresh_token")).toBe(rt1);
    // a refreshed token for another account is refused, and the stored token is not replaced by it
    const held = (await liveControl(sourceId))!.secretCiphertext;
    entra.refreshAs = { upn: `intruder-${RUN}@contoso.example`, oid: randomUUID() };
    try {
      const l3 = await resolver(db, sourceId, COPILOT_STUDIO_CONTROL);
      if (l3.ok) await expect(l3.credential.acquire(AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: "delegated_account_mismatch" });
    } finally {
      entra.refreshAs = null;
    }
    expect((await liveControl(sourceId))!.secretCiphertext).toBe(held);
    // only the token endpoint was ever called
    expect(entra.otherHosts).toEqual([]);
  });
});
