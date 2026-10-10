/**
 * ADR-0190 (batch 6 item 3) I3 — THE EXECUTOR CORE, on a real database
 * through the real app, driven by the REAL executor package
 * (`@regulait/sandbox-executor` with its fake backend):
 *  - ADMIN REGISTRATION: an executor binds one worker_runtime identity
 *    (401 anonymous, 403 member, 400 an agent identity, 409 twice), audited.
 *  - CHANNEL AUTHENTICATION (the one-use proof): every refusal, each with
 *    its negative control: no header, an unregistered key, another route,
 *    another method, a tampered body, a stale and a future proof, a REPLAY,
 *    a revoked credential, a suspended identity, an identity of another kind,
 *    an unregistered identity. Each refusal is audited; none reaches a handler.
 *  - THE LOOP end to end: announce (audited), one self-test per profile the
 *    executor can serve (verdict rows on the database clock, failed ones
 *    withdraw the class), the stream, an offer from the broker, the signed
 *    per-placement report verified BEFORE input, the placement row under its
 *    audit row, `awaitPlacement`.
 *  - REFUSED BEFORE ANY SANDBOX (decision 7, no fallback): a class above the
 *    attestation, a profile without an attestation, a stale attestation, a
 *    retired profile, a quarantined executor, no executor at all; a declined
 *    offer; an expired offer. The fake backend's sandbox count stays at zero.
 *  - MISMATCH (decision 6): a backend lying in one probe for the workload's
 *    sandbox only → report refused, sandbox killed, input never released,
 *    placement `mismatch`, executor quarantined (row, audit, governance
 *    alert), its open offers withdrawn; a new placement refuses
 *    `executor_quarantined`; an admin re-enable (step-up) → the executor
 *    re-attests and works again.
 *  - ADMIN: quarantine, re-enable, revoke (terminal: the loop stops with the
 *    admin's instruction), the customer_declared mapping (maps to nothing
 *    until an admin maps it; then it satisfies the class).
 *
 * Global state (M-068): org settings are restored in afterAll; governance
 * alerts raised here are deleted; identity and executor rows cannot be
 * deleted by design and are scoped by this run's ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { and, auditLog, createDb, desc, eq, executionOffers, executionPlacements, executorAttestations, executors, governanceAlerts, inArray, runMigrations, sql, type Db } from "@regulait/db";
import {
  EXECUTOR_CHANNEL_ROUTES,
  EXECUTOR_PROOF_HEADER,
  EXECUTOR_PROOF_TYP,
  executionProfileDigest,
  SHIPPED_EXECUTION_PROFILES,
  type ExecutionOffer,
} from "@regulait/shared";
import {
  ExecutorClient,
  ExecutorFatalError,
  generateExecutorKey,
  ProofChannelCredential,
  runExecutorLoop,
  type ExecutorHttp,
  type ExecutorKey,
  type OfferOutcome,
} from "@regulait/sandbox-executor";
import { FakeSandboxBackend } from "@regulait/sandbox-executor/testing";
import { buildApp } from "./app.js";
import { awaitPlacement, expireOffers, offerPlacement } from "./executor-channel.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { routeAuthClass } from "./route-classes.js";
import { ROUTE_STABILITY, ROUTE_TAGS } from "./openapi-registry.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `i3-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ISSUER = "http://127.0.0.1:4419";
process.env.REGULAIT_PUBLIC_URL = ISSUER;
const ENV = deploymentEnvironment();
const SPIFFE = (s: string) => `spiffe://i3.example.org/regulait/worker_runtime/${s}-${RUN}`;
const RESTRICTED = SHIPPED_EXECUTION_PROFILES.restricted;
const RESTRICTED_DIGEST = executionProfileDigest(RESTRICTED);
const MICROVM_DIGEST = executionProfileDigest(SHIPPED_EXECUTION_PROFILES["restricted-microvm"]);
const ENGINE_WORKER_DIGEST = executionProfileDigest(SHIPPED_EXECUTION_PROFILES["engine-worker"]);
const IMAGE = `sha256:${"c".repeat(64)}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminAuth: { authorization: string };
let adminId: string;
let memberAuth: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

// --- identities and executors ----------------------------------------------

interface Ident {
  id: string;
  identifier: string;
  key: ExecutorKey;
  credentialId: string;
}
async function newIdentity(name: string, kind: "worker_runtime" | "agent" = "worker_runtime"): Promise<Ident> {
  const identifier = SPIFFE(name);
  const agentId = kind === "agent" ? rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`i3-${name}-${RUN}`}, 'mock', 1) returning id`))[0]!.id : null;
  const id = rows<{ id: string }>(
    await db.execute(
      sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments) values (${kind}, ${agentId}, ${identifier}, ARRAY[${adminId}]::uuid[], ARRAY[${ENV}]) returning id`,
    ),
  )[0]!.id;
  const key = await generateExecutorKey();
  const credentialId = rows<{ id: string }>(
    await db.execute(sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, not_after)
      values (${id}, 'jwk', ${JSON.stringify(key.publicJwk)}::jsonb, ${key.thumbprint}, now() + interval '30 days') returning id`),
  )[0]!.id;
  return { id, identifier, key, credentialId };
}

/** the executor package over `app.inject` */
function injectHttp(): ExecutorHttp {
  return async (url, init) => {
    const u = new URL(url);
    const res = await app.inject({ method: init.method as Method, url: `${u.pathname}${u.search}`, headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
    return { status: res.statusCode, text: async () => res.body };
  };
}

interface Rig {
  ident: Ident;
  executorId: string;
  backend: FakeSandboxBackend;
  credential: ProofChannelCredential;
  client: ExecutorClient;
  outcomes: Array<{ offer: ExecutionOffer; outcome: OfferOutcome }>;
  logs: string[];
  run: (maxWindows: number, extra?: Partial<Parameters<typeof runExecutorLoop>[0]>) => Promise<void>;
}
async function registerExecutor(ident: Ident, body: Record<string, unknown>) {
  return inject("POST", "/v1/executors", adminAuth, { workloadIdentityId: ident.id, name: `i3-${RUN}-${Math.random().toString(36).slice(2, 6)}`, backend: "gvisor", runtimeVersion: "fake-0.0.0", classesDeclared: ["hardened_container", "user_space_kernel"], ...body });
}
async function rig(name: string, opts: { backend?: FakeSandboxBackend; register?: Record<string, unknown> } = {}): Promise<Rig> {
  const ident = await newIdentity(name);
  const backend = opts.backend ?? new FakeSandboxBackend();
  const reg = await registerExecutor(ident, { backend: backend.describe().backend, classesDeclared: [...backend.describe().classes], ...opts.register });
  expect(reg.statusCode, reg.body).toBe(201);
  const credential = new ProofChannelCredential({ identifier: ident.identifier, key: ident.key, issuer: ISSUER });
  const client = new ExecutorClient({ gatewayUrl: ISSUER, credential, http: injectHttp() });
  const outcomes: Rig["outcomes"] = [];
  const logs: string[] = [];
  const run: Rig["run"] = (maxWindows, extra = {}) =>
    runExecutorLoop({
      client,
      backend,
      credential,
      maxWindows,
      streamWindowSeconds: 1,
      backoffMs: 5,
      maxBackoffMs: 10,
      log: (m) => logs.push(m),
      onOffer: (offer, outcome) => outcomes.push({ offer, outcome }),
      ...extra,
    });
  return { ident, executorId: reg.json().executorId, backend, credential, client, outcomes, logs, run };
}

const audits = async (ruleId: string, objectId: string | null) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, ruleId), ...(objectId ? [eq(auditLog.objectId, objectId)] : [])))
    .orderBy(desc(auditLog.at));
const executorRow = async (id: string) => (await db.select().from(executors).where(eq(executors.id, id)))[0]!;
const offerRow = async (id: string) => (await db.select().from(executionOffers).where(eq(executionOffers.id, id)))[0]!;
const placementRow = async (id: string) => (await db.select().from(executionPlacements).where(eq(executionPlacements.id, id)))[0]!;
const placementSandboxes = (b: FakeSandboxBackend) => b.sandboxes.filter((s) => s.kind === "placement");
/** the broker, restricted to this test's executor (every test file shares one database: other executors exist) */
const offerTo = (r: { executorId: string }, over: Partial<Parameters<typeof offerPlacement>[1]> = {}): ReturnType<typeof offerPlacement> =>
  offerPlacement(db, { workloadKind: "mcp_stdio", requiredClass: "user_space_kernel", requiredBy: "workload_kind", enforcement: "enforce", profileDigest: RESTRICTED_DIGEST, imageDigest: IMAGE, onlyExecutorIds: [r.executorId], ...over });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxStepUpForTest(db));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "i3".padEnd(64, "k"), executorChannel: { streamPollMs: 25 } });
  const adm = await inject("POST", "/v1/users", AUTH, { email: `i3-admin-${RUN}@example.com`, displayName: `i3 admin ${RUN}`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  adminId = adm.json().id;
  adminAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "i3" })).json().token}` };
  const mem = await inject("POST", "/v1/users", AUTH, { email: `i3-member-${RUN}@example.com`, displayName: `i3 member ${RUN}` });
  memberAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${mem.json().id}/keys`, AUTH, { name: "i3" })).json().token}` };
}, 120_000);

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await db.delete(governanceAlerts).where(sql`${governanceAlerts.subjectKey} LIKE 'executor:%' AND ${governanceAlerts.detail}->>'backend' IS NOT NULL AND ${governanceAlerts.title} LIKE ${`Executor i3-${RUN}-%`}`);
  await app.close();
});

// ---------------------------------------------------------------------------
describe("the route posture", () => {
  it("the channel routes are auth-exempt, non-admin (in-route proof), internal, tagged executor-channel", () => {
    for (const r of EXECUTOR_CHANNEL_ROUTES) {
      const [m, p] = r.split(" ") as [string, string];
      expect(routeAuthClass(m, p), r).toBe("public");
      expect(ROUTE_STABILITY[r], r).toBe("internal");
      expect(ROUTE_TAGS[r], r).toBe("executor-channel");
    }
    expect(app.routeInventory.filter((r) => r.url.startsWith("/v1/executor-channel")).map((r) => `${r.method} ${r.url}`).sort()).toEqual([...EXECUTOR_CHANNEL_ROUTES].sort());
  });
});

// ---------------------------------------------------------------------------
describe("admin registration", () => {
  it("binds one worker_runtime identity: 401 anonymous, 403 member, 400 an agent identity, 201 admin, 409 twice; audited", async () => {
    const ident = await newIdentity("reg");
    const body = { workloadIdentityId: ident.id, name: `i3-${RUN}-reg`, backend: "gvisor", runtimeVersion: "runsc-20261005.0", classesDeclared: ["hardened_container", "user_space_kernel"] };
    expect((await inject("POST", "/v1/executors", {}, body)).statusCode).toBe(401);
    expect((await inject("POST", "/v1/executors", memberAuth, body)).statusCode).toBe(403);
    const agent = await newIdentity("agent", "agent");
    const notWorker = await inject("POST", "/v1/executors", adminAuth, { ...body, workloadIdentityId: agent.id });
    expect(notWorker.statusCode, notWorker.body).toBe(400);
    expect(notWorker.json().error).toBe("identity_not_worker_runtime");
    expect((await inject("POST", "/v1/executors", adminAuth, { ...body, backend: "runc", classesDeclared: ["user_space_kernel"] })).statusCode).toBe(400);
    const ok = await inject("POST", "/v1/executors", adminAuth, body);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ name: body.name, backend: "gvisor", status: "active", attestations: [], attestationStrength: "software_attested" });
    expect((await inject("POST", "/v1/executors", adminAuth, { ...body, name: `${body.name}-2` })).statusCode).toBe(409);
    expect((await audits("executor-registered", ok.json().executorId)).length).toBe(1);
    const listed = await inject("GET", "/v1/executors", adminAuth);
    expect(listed.json().executors.some((e: { executorId: string }) => e.executorId === ok.json().executorId)).toBe(true);
    expect((await inject("GET", `/v1/executors/${randomUUID()}`, adminAuth)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe("channel authentication: the one-use proof", () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  async function proof(ident: Ident, o: { htm?: string; htu?: string; bh?: string; iat?: number; jti?: string; aud?: string; typ?: string; iss?: string; key?: ExecutorKey } = {}) {
    const key = o.key ?? ident.key;
    return new SignJWT({ htm: o.htm ?? "GET", htu: o.htu ?? `${ISSUER}/v1/executor-channel/stream`, bh: o.bh ?? "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU" })
      .setProtectedHeader({ alg: "EdDSA", typ: o.typ ?? EXECUTOR_PROOF_TYP, kid: key.thumbprint })
      .setIssuer(o.iss ?? ident.identifier)
      .setSubject(o.iss ?? ident.identifier)
      .setAudience(o.aud ?? ISSUER)
      .setJti(o.jti ?? randomUUID())
      .setIssuedAt(o.iat ?? nowS())
      .sign(key.privateKey);
  }
  const stream = (p?: string) => inject("GET", "/v1/executor-channel/stream?window=1", p ? { [EXECUTOR_PROOF_HEADER]: p } : {});

  it("refuses, with its code and an audit row, every broken proof; the exact proof is accepted once", async () => {
    const r = await rig("auth");
    const other = await generateExecutorKey();
    const before = (await audits("executor-channel-refused", null)).length;
    const cases: Array<[string, Promise<string | undefined>, string]> = [
      ["no header", Promise.resolve(undefined), "proof_missing"],
      ["an unregistered key", proof(r.ident, { key: other }), "credential_unknown"],
      ["another typ", proof(r.ident, { typ: "dpop+jwt" }), "proof_header"],
      ["another audience", proof(r.ident, { aud: "http://elsewhere" }), "proof_invalid"],
      ["another route", proof(r.ident, { htu: `${ISSUER}/v1/executor-channel/announce` }), "proof_htu"],
      ["another method", proof(r.ident, { htm: "POST" }), "proof_htm"],
      ["another body", proof(r.ident, { bh: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), "proof_body"],
      ["a stale proof (120 s old)", proof(r.ident, { iat: nowS() - 120 }), "proof_invalid"],
      ["a future proof (+30 s)", proof(r.ident, { iat: nowS() + 30 }), "proof_invalid"],
      ["an unknown issuer", proof(r.ident, { iss: SPIFFE("nobody") }), "identity_unknown"],
    ];
    for (const [label, p, code] of cases) {
      const res = await stream(await p);
      expect(res.statusCode, label).toBe(401);
      expect(res.json().error, label).toBe(code);
    }
    // the negative control: the same shape, intact, is accepted (and streams a hello)
    const good = await proof(r.ident);
    const ok = await stream(good);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body.split("\n")[0]).toContain('"type":"hello"');
    // REPLAY: the very same proof again is refused
    const again = await stream(good);
    expect(again.statusCode).toBe(401);
    expect(again.json().error).toBe("proof_replayed");
    expect((await audits("executor-channel-refused", null)).length).toBe(before + cases.length + 1);
  });

  it("a revoked credential, a suspended identity, an agent identity and an unregistered identity are refused", async () => {
    const r = await rig("auth2");
    await db.execute(sql`update workload_credentials set revoked_at = now() where id = ${r.ident.credentialId}`);
    const revoked = await stream(await proof(r.ident));
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error).toBe("credential_unknown");
    const s = await rig("auth3");
    await db.execute(sql`update workload_identities set status = 'suspended' where id = ${s.ident.id}`);
    const suspended = await stream(await proof(s.ident));
    expect(suspended.json().error).toBe("identity_suspended");
    const agent = await newIdentity("auth-agent", "agent");
    const wrongKind = await stream(await proof(agent));
    expect(wrongKind.json().error).toBe("identity_not_worker_runtime");
    // a worker_runtime identity with a key but no executor registration: the proof verifies, the executor does not exist
    const unregistered = await newIdentity("auth-unreg");
    const u = await stream(await proof(unregistered));
    expect(u.statusCode).toBe(401);
    expect(u.json().error).toBe("executor_not_registered");
    const credential = new ProofChannelCredential({ identifier: unregistered.identifier, key: unregistered.key, issuer: ISSUER });
    const client = new ExecutorClient({ gatewayUrl: ISSUER, credential, http: injectHttp() });
    await expect(runExecutorLoop({ client, backend: new FakeSandboxBackend(), credential, maxWindows: 1, sleep: async () => undefined })).rejects.toThrow(/not registered/);
  });
});

// ---------------------------------------------------------------------------
describe("the loop against the real gateway", () => {
  it("announces, self-tests, streams, takes a broker offer, reports before input, is placed; everything audited on the database clock", async () => {
    const r = await rig("happy");
    await r.run(1);
    expect(r.logs.filter((l) => l.includes("->")).map((l) => l.split(" ")[3])).toEqual(["attesting", "streaming"]);
    expect((await audits("executor-announced", r.executorId)).length).toBe(1);
    const att = await db.select().from(executorAttestations).where(eq(executorAttestations.executorId, r.executorId));
    expect(att.map((a) => [a.profileDigest, a.class, a.verdict]).sort()).toEqual(
      [
        [RESTRICTED_DIGEST, "user_space_kernel", "pass"],
        [ENGINE_WORKER_DIGEST, "user_space_kernel", "pass"],
      ].sort(),
    );
    expect(att.every((a) => a.expiresAt.getTime() - a.observedAt.getTime() === 120 * 60_000)).toBe(true);
    expect((await audits("executor-attestation-passed", r.executorId)).length).toBe(2);
    const view = await inject("GET", `/v1/executors/${r.executorId}`, adminAuth);
    expect(view.json().attestations).toEqual(expect.arrayContaining([expect.objectContaining({ profileDigest: RESTRICTED_DIGEST, fresh: true, class: "user_space_kernel" })]));
    expect(view.json().runtimeVersion).toBe("fake-0.0.0");
    const listed = await inject("GET", `/v1/executors/${r.executorId}/attestations`, adminAuth);
    expect(listed.json().attestations).toHaveLength(2);
    expect(listed.json().attestations[0].report.signature).toBeDefined();

    // the broker offers; the executor takes it on its next window
    const offered = await offerTo(r);
    expect(offered).toMatchObject({ kind: "offered", executorId: r.executorId, attestedClass: "user_space_kernel" });
    const offerId = (offered as { offerId: string }).offerId;
    const [result] = await Promise.all([awaitPlacement(db, offerId, { pollMs: 50 }), r.run(2)]);
    expect(result).toMatchObject({ kind: "placed", appliedClass: "user_space_kernel", executorId: r.executorId });
    const placed = result as Extract<typeof result, { kind: "placed" }>;
    const o = await offerRow(offerId);
    expect(o.status).toBe("ended");
    expect(o.endOutcome).toBe("completed");
    expect(o.placementId).toBe(placed.placementId);
    const p = await placementRow(placed.placementId);
    expect(p).toMatchObject({ outcome: "placed", requiredClass: "user_space_kernel", appliedClass: "user_space_kernel", reportSha256: placed.reportSha256, executorId: r.executorId, refusalCode: null });
    const [a] = await db.select().from(auditLog).where(eq(auditLog.id, p.auditId));
    expect(a!.ruleId).toBe("execution-placed");
    expect((a!.detail as { reportSha256: string }).reportSha256).toBe(placed.reportSha256);
    const sb = placementSandboxes(r.backend);
    expect(sb).toHaveLength(1);
    expect(sb[0]).toMatchObject({ probed: true, released: true, killed: false });
    expect(r.outcomes[0]!.outcome).toMatchObject({ kind: "placed", placementId: placed.placementId });
  });

  it("a self-test that fails withdraws the class (the latest verdict decides) and the broker refuses attestation_stale", async () => {
    const backend = new FakeSandboxBackend().lie("root_read_only", (o) => ({ ...o, readOnly: false }), "canary");
    const r = await rig("failtest", { backend });
    await r.run(1);
    expect((await audits("executor-attestation-failed", r.executorId)).length).toBe(2);
    const refused = await offerTo(r);
    expect(refused).toMatchObject({ kind: "refused", code: "attestation_stale" });
    const p = await placementRow((refused as { placementId: string }).placementId);
    expect(p).toMatchObject({ outcome: "refused", refusalCode: "attestation_stale", executorId: null });
    expect((await audits("execution-refused", null)).some((a) => (a.detail as { code: string }).code === "attestation_stale")).toBe(true);
    expect(placementSandboxes(backend)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("refused before any sandbox starts (decision 7, no fallback)", () => {
  it("class above the attestation, a profile with no attestation, a retired profile, no executor, an expired attestation", async () => {
    const r = await rig("refuse");
    await r.run(1);
    const place = (over: Partial<Parameters<typeof offerPlacement>[1]>) => offerTo(r, over);
    expect(await place({ requiredClass: "microvm", requiredBy: "data_sensitivity" })).toMatchObject({ kind: "refused", code: "class_below_required" });
    // the microvm profile: the gvisor executor never attested it (the broker also raises the requirement to the profile's floor)
    const noAtt = await place({ profileDigest: MICROVM_DIGEST });
    expect(noAtt.kind).toBe("refused");
    expect(["no_executor", "attestation_stale"]).toContain((noAtt as { code: string }).code);
    // a retired profile version
    const retiredBody = { ...RESTRICTED, name: `i3-retire-${RUN}` };
    const canon = (await import("@regulait/shared")).canonicalExecutionProfile(retiredBody);
    const retiredDigest = executionProfileDigest(retiredBody);
    await db.execute(sql`insert into execution_profiles (name, version, body, digest, min_class) values (${retiredBody.name}, 1, ${canon}, ${retiredDigest}, 'user_space_kernel')`);
    await db.execute(sql`update execution_profiles set retired_at = now() where digest = ${retiredDigest}`);
    expect(await place({ profileDigest: retiredDigest })).toMatchObject({ kind: "refused", code: "profile_retired" });
    expect(await place({ profileDigest: "0".repeat(64) })).toEqual({ kind: "refused", code: "profile_retired", placementId: null });
    expect(await place({ onlyExecutorIds: [] })).toMatchObject({ kind: "refused", code: "no_executor" });
    // an attestation that has expired on the database clock: a later pass stamped in the past is the latest verdict
    const [latest] = await db.select().from(executorAttestations).where(and(eq(executorAttestations.executorId, r.executorId), eq(executorAttestations.profileDigest, RESTRICTED_DIGEST))).orderBy(desc(executorAttestations.observedAt)).limit(1);
    await db.execute(
      sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
        values (${r.executorId}, ${RESTRICTED_DIGEST}, 'user_space_kernel', ${latest!.reportSha256}, ${JSON.stringify(latest!.report)}::jsonb, 'pass', now() + interval '1 second', now() + interval '2 seconds')`,
    );
    await new Promise((res) => setTimeout(res, 2_500));
    expect(await place({})).toMatchObject({ kind: "refused", code: "attestation_stale" });
    expect(placementSandboxes(r.backend)).toHaveLength(0);
  });

  it("an executor with no capacity declines (the placement is refused no_executor); an offer nobody takes expires", async () => {
    const r = await rig("decline");
    await r.run(1);
    const offered = await offerTo(r);
    expect(offered.kind).toBe("offered");
    const offerId = (offered as { offerId: string }).offerId;
    const [result] = await Promise.all([awaitPlacement(db, offerId, { pollMs: 50 }), r.run(1, { capacity: 0 })]);
    expect(result).toMatchObject({ kind: "failed", status: "declined", code: "no_executor" });
    expect(r.outcomes[0]!.outcome).toEqual({ kind: "declined", reason: "capacity" });
    expect((await offerRow(offerId)).declineReason).toBe("capacity");
    // an offer with a 1 s life, no executor streaming
    const short = await offerTo(r, { ttlSeconds: 1 });
    expect(short.kind).toBe("offered");
    await new Promise((res) => setTimeout(res, 1_200));
    expect(await expireOffers(db)).toBeGreaterThanOrEqual(1);
    const o = await offerRow((short as { offerId: string }).offerId);
    expect(o.status).toBe("expired");
    expect((await placementRow(o.placementId!)).refusalCode).toBe("no_executor");
    expect(placementSandboxes(r.backend)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("mismatch and quarantine (decision 6)", () => {
  it("a lying placement sandbox: report refused, sandbox killed, input never released, executor quarantined (row, audit, alert), re-enable re-attests", async () => {
    const backend = new FakeSandboxBackend().lie("no_executor_credentials", (o) => ({ ...o, found: 2 }), "placement");
    const r = await rig("mismatch", { backend });
    await r.run(1);
    const offered = await offerTo(r);
    expect(offered.kind).toBe("offered");
    const offerId = (offered as { offerId: string }).offerId;
    // a second open offer, withdrawn by the quarantine
    const second = await offerTo(r, { workloadKind: "engine_worker", profileDigest: ENGINE_WORKER_DIGEST, ttlSeconds: 300 });
    expect(second.kind).toBe("offered");
    const [result] = await Promise.all([awaitPlacement(db, offerId, { pollMs: 50 }), r.run(2)]);
    expect(result).toMatchObject({ kind: "failed", status: "mismatch", code: "execution_profile_mismatch" });
    const sb = backend.sandboxes.find((s) => s.offerId === offerId)!;
    expect(sb).toMatchObject({ probed: true, released: false, killed: true });
    expect(r.outcomes.find((o) => o.offer.id === offerId)!.outcome).toEqual({ kind: "mismatch" });
    const ex = await executorRow(r.executorId);
    expect(ex).toMatchObject({ status: "quarantined", quarantineCode: "execution_profile_mismatch" });
    expect(ex.quarantinedAt).not.toBeNull();
    const p = await placementRow((result as { placementId: string }).placementId);
    expect(p).toMatchObject({ outcome: "mismatch", refusalCode: "execution_profile_mismatch", executorId: r.executorId });
    const [mm] = await audits("execution-profile-mismatch", offerId);
    expect((mm!.detail as { failures: Array<{ code: string }> }).failures).toContainEqual({ probe: "no_executor_credentials", code: "credentials_reachable" });
    expect((await audits("executor-quarantined", r.executorId)).length).toBe(1);
    const alerts = await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, `executor:${r.executorId}`));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ ruleId: "execution-profile-mismatch", severity: "high", status: "open" });
    // the executor's loop saw it
    expect(r.logs.some((l) => l.includes("-> quarantined"))).toBe(true);
    // the second offer: withdrawn by the quarantine, or (taken in the same window, by the same lying backend) judged a
    // mismatch itself; either way it ended without input (withdrawal on its own is proved by the admin quarantine below)
    const o2 = await offerRow((second as { offerId: string }).offerId);
    expect(["withdrawn", "mismatch"]).toContain(o2.status);
    expect(["executor_quarantined", "execution_profile_mismatch"]).toContain((await placementRow(o2.placementId!)).refusalCode);
    expect(backend.sandboxes.filter((s) => s.offerId === o2.id && s.released)).toHaveLength(0);
    // nothing new is placed on it
    expect(await offerTo(r)).toMatchObject({ kind: "refused", code: "executor_quarantined" });
    // the stream tells a quarantined executor so, and its accept is refused
    expect((await inject("POST", `/v1/executors/${r.executorId}/reenable`, memberAuth, {})).statusCode).toBe(403);
    const re = await inject("POST", `/v1/executors/${r.executorId}/reenable`, adminAuth, {});
    expect(re.statusCode, re.body).toBe(200);
    expect(re.json()).toMatchObject({ status: "active", quarantineCode: null });
    expect((await audits("executor-reenabled", r.executorId)).length).toBe(1);
    expect((await inject("POST", `/v1/executors/${r.executorId}/reenable`, adminAuth, {})).statusCode).toBe(409);
    // honest again: a fresh self-test, then work
    backend.truthful();
    const canariesBefore = backend.sandboxes.filter((s) => s.kind === "canary").length;
    const again = await offerTo(r, { ttlSeconds: 60 });
    expect(again.kind).toBe("offered");
    const [res2] = await Promise.all([awaitPlacement(db, (again as { offerId: string }).offerId, { pollMs: 50 }), r.run(2)]);
    expect(res2).toMatchObject({ kind: "placed" });
    expect(backend.sandboxes.filter((s) => s.kind === "canary").length).toBeGreaterThan(canariesBefore);
  });

  it("the gateway side of a mismatch holds without the executor's cooperation: a report naming another image is a mismatch", async () => {
    const r = await rig("image");
    await r.run(1);
    r.backend.imageDigestOverride = `sha256:${"d".repeat(64)}`;
    const offered = await offerTo(r);
    const [result] = await Promise.all([awaitPlacement(db, (offered as { offerId: string }).offerId, { pollMs: 50 }), r.run(2)]);
    expect(result).toMatchObject({ kind: "failed", status: "mismatch" });
    expect((await executorRow(r.executorId)).status).toBe("quarantined");
    const [mm] = await audits("execution-profile-mismatch", (offered as { offerId: string }).offerId);
    expect((mm!.detail as { failures: Array<{ code: string }> }).failures).toContainEqual({ probe: "report", code: "image_digest_mismatch" });
  });
});

// ---------------------------------------------------------------------------
describe("admin quarantine, revoke, the customer mapping", () => {
  it("an admin quarantine withdraws open offers; revoke is terminal and stops the loop", async () => {
    const r = await rig("admin");
    await r.run(1);
    const offered = await offerTo(r, { ttlSeconds: 300 });
    expect(offered.kind).toBe("offered");
    expect((await inject("POST", `/v1/executors/${r.executorId}/quarantine`, adminAuth, { code: "execution_profile_mismatch" })).statusCode).toBe(400);
    const q = await inject("POST", `/v1/executors/${r.executorId}/quarantine`, adminAuth, { code: "admin" });
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()).toMatchObject({ status: "quarantined", quarantineCode: "admin" });
    expect((await offerRow((offered as { offerId: string }).offerId)).status).toBe("withdrawn");
    expect((await inject("POST", `/v1/executors/${r.executorId}/quarantine`, adminAuth, { code: "admin" })).statusCode).toBe(409);
    // the executor's own stream hears it
    await r.run(1, { selfTestIntervalMs: 24 * 3600_000 });
    expect(r.logs.some((l) => l.includes("-> quarantined"))).toBe(true);
    const rv = await inject("POST", `/v1/executors/${r.executorId}/revoke`, adminAuth, {});
    expect(rv.statusCode, rv.body).toBe(200);
    expect(rv.json().status).toBe("revoked");
    expect((await audits("executor-revoked", r.executorId)).length).toBe(1);
    await expect(r.run(3)).rejects.toThrow(ExecutorFatalError);
    expect((await inject("POST", `/v1/executors/${r.executorId}/reenable`, adminAuth, {})).statusCode).toBe(409);
    expect((await inject("POST", `/v1/executors/${r.executorId}/revoke`, adminAuth, {})).statusCode).toBe(409);
    // a revoked executor's identity still speaks, but every channel request is 403 executor_revoked
    const res = await r.client.announce({ backend: "gvisor", runtimeVersion: "fake-0.0.0", classesDeclared: ["user_space_kernel"] }).catch((e: unknown) => e);
    expect(res).toMatchObject({ status: 403, code: "executor_revoked", next: "revoked" });
  });

  it("a customer plane maps to no class until an admin maps it (step-up, audited); then it satisfies the class", async () => {
    const backend = new FakeSandboxBackend({ backend: "customer" });
    const r = await rig("customer", { backend });
    expect((await inject("PUT", `/v1/executors/${r.executorId}/declared-class`, adminAuth, { class: "in_gateway" })).statusCode).toBe(400);
    await r.run(1);
    const att = await db.select().from(executorAttestations).where(eq(executorAttestations.executorId, r.executorId));
    expect(att.length).toBeGreaterThan(0);
    expect(att.every((a) => a.class === "customer_declared" && a.verdict === "pass")).toBe(true);
    const place = () => offerTo(r, { workloadKind: "byoc_worker", ttlSeconds: 60 });
    expect(await place()).toMatchObject({ kind: "refused", code: "class_below_required" });
    expect((await inject("PUT", `/v1/executors/${r.executorId}/declared-class`, memberAuth, { class: "microvm" })).statusCode).toBe(403);
    const mapped = await inject("PUT", `/v1/executors/${r.executorId}/declared-class`, adminAuth, { class: "microvm" });
    expect(mapped.statusCode, mapped.body).toBe(200);
    expect(mapped.json().declaredClass).toBe("microvm");
    expect((await audits("executor-declared-class-set", r.executorId)).length).toBe(1);
    const offered = await place();
    expect(offered).toMatchObject({ kind: "offered", attestedClass: "customer_declared" });
    const [result] = await Promise.all([awaitPlacement(db, (offered as { offerId: string }).offerId, { pollMs: 50 }), r.run(2)]);
    expect(result).toMatchObject({ kind: "placed", appliedClass: "customer_declared" });
    // unmapping needs no step-up and is audited as the strict default
    const unmapped = await inject("PUT", `/v1/executors/${r.executorId}/declared-class`, adminAuth, { class: null });
    expect(unmapped.json().declaredClass).toBeNull();
    expect(await place()).toMatchObject({ kind: "refused", code: "class_below_required" });
    // a gvisor executor cannot be mapped at all
    const g = await rig("customer-g");
    expect((await inject("PUT", `/v1/executors/${g.executorId}/declared-class`, adminAuth, { class: "microvm" })).statusCode).toBe(409);
  });
});
