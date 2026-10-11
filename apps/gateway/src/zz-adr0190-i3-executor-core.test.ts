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
  EXECUTION_OFFER_REPORT_TTL_SECONDS,
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
  indexProfiles,
  ProofChannelCredential,
  runExecutorLoop,
  runSelfTests,
  type ExecutorHttp,
  type ExecutorKey,
  type OfferOutcome,
} from "@regulait/sandbox-executor";
import { FakeSandboxBackend } from "@regulait/sandbox-executor/testing";
import { buildApp } from "./app.js";
import { createHash } from "node:crypto";
import { awaitPlacement, expireOffers, liveProfileRefs, offerPlacement } from "./executor-channel.js";
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

  it("an unproven request is refused before its body is read (review L6); a proven one still meets the body limit", async () => {
    const r = await rig("prebody");
    const big = JSON.stringify({ reports: [], pad: "z".repeat(5 * 1024 * 1024) });
    const before = (await audits("executor-channel-refused", null)).length;
    const unproven = await inject("POST", "/v1/executor-channel/self-test", { "content-type": "application/json" }, big);
    // 401 from the header phase, not 413: the 5 MiB body was never buffered
    expect(unproven.statusCode, unproven.body).toBe(401);
    expect(unproven.json().error).toBe("proof_missing");
    expect((await audits("executor-channel-refused", null)).length).toBe(before + 1);
    // the negative control: with a valid proof for those exact bytes, the body IS read, and its limit refuses it
    const bh = createHash("sha256").update(big, "utf8").digest("base64url");
    const proven = await inject("POST", "/v1/executor-channel/self-test", { "content-type": "application/json", [EXECUTOR_PROOF_HEADER]: await proof(r.ident, { htm: "POST", htu: `${ISSUER}/v1/executor-channel/self-test`, bh }) }, big);
    expect(proven.statusCode, proven.body).toBe(413);
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
    // review L5: the end is audited once, with its outcome; a second end is refused and writes nothing
    const ended = await audits("execution-ended", offerId);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.detail).toMatchObject({ outcome: "completed", placementId: placed.placementId, executorId: r.executorId });
    expect(await r.client.end(offerId, "completed").catch((e: unknown) => e)).toMatchObject({ status: 409, code: "offer_unavailable" });
    expect(await audits("execution-ended", offerId)).toHaveLength(1);
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
    const secondId = (second as { offerId: string }).offerId;
    const [result] = await Promise.all([awaitPlacement(db, offerId, { pollMs: 50 }), r.run(2)]);
    // the loop handles offers concurrently (sandbox-executor loop.ts), so EITHER offer's lying report may be judged
    // first; its quarantine withdraws the other. The first offer is therefore a mismatch itself, or withdrawn
    // `executor_quarantined` by the second's; at least one of the two is the mismatch, and no input is ever released
    const o1 = await offerRow(offerId);
    const o2 = await offerRow(secondId);
    if (o1.status === "mismatch") expect(result).toMatchObject({ kind: "failed", status: "mismatch", code: "execution_profile_mismatch" });
    else expect(result).toMatchObject({ kind: "failed", status: "withdrawn", code: "executor_quarantined" });
    const lying = [o1, o2].find((o) => o.status === "mismatch");
    expect(lying, `offer statuses ${o1.status} / ${o2.status}`).toBeDefined();
    expect(backend.sandboxes.filter((s) => (s.offerId === offerId || s.offerId === secondId) && s.released)).toHaveLength(0);
    const sb = backend.sandboxes.find((s) => s.offerId === lying!.id)!;
    expect(sb).toMatchObject({ probed: true, released: false, killed: true });
    expect(r.outcomes.find((o) => o.offer.id === lying!.id)!.outcome).toEqual({ kind: "mismatch" });
    const ex = await executorRow(r.executorId);
    expect(ex).toMatchObject({ status: "quarantined", quarantineCode: "execution_profile_mismatch" });
    expect(ex.quarantinedAt).not.toBeNull();
    const p = await placementRow(lying!.placementId!);
    expect(p).toMatchObject({ outcome: "mismatch", refusalCode: "execution_profile_mismatch", executorId: r.executorId });
    const [mm] = await audits("execution-profile-mismatch", lying!.id);
    expect((mm!.detail as { failures: Array<{ code: string }> }).failures).toContainEqual({ probe: "no_executor_credentials", code: "credentials_reachable" });
    expect((await audits("executor-quarantined", r.executorId)).length).toBe(1);
    const alerts = await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, `executor:${r.executorId}`));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ ruleId: "execution-profile-mismatch", severity: "high", status: "open" });
    // the executor's loop saw it
    expect(r.logs.some((l) => l.includes("-> quarantined"))).toBe(true);
    // each offer: withdrawn by the quarantine, or (taken in the same window, by the same lying backend) judged a
    // mismatch itself; either way it ended without input (withdrawal on its own is proved by the admin quarantine below)
    for (const o of [o1, o2]) {
      expect(["withdrawn", "mismatch"]).toContain(o.status);
      expect(["executor_quarantined", "execution_profile_mismatch"]).toContain((await placementRow(o.placementId!)).refusalCode);
    }
    // nothing new is placed on it
    expect(await offerTo(r)).toMatchObject({ kind: "refused", code: "executor_quarantined" });
    // the stream tells a quarantined executor so, and its accept is refused
    expect((await inject("POST", `/v1/executors/${r.executorId}/reenable`, memberAuth, {})).statusCode).toBe(403);
    // review L4: two concurrent re-enables: one moves the row and is audited; the other is 409 and writes nothing
    const both = await Promise.all([inject("POST", `/v1/executors/${r.executorId}/reenable`, adminAuth, {}), inject("POST", `/v1/executors/${r.executorId}/reenable`, adminAuth, {})]);
    expect(both.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    const re = both.find((x) => x.statusCode === 200)!;
    expect(re.json()).toMatchObject({ status: "active", quarantineCode: null });
    expect(re.json().reenabledAt).not.toBeNull();
    expect((await audits("executor-reenabled", r.executorId)).length).toBe(1);
    expect((await inject("POST", `/v1/executors/${r.executorId}/reenable`, adminAuth, {})).statusCode).toBe(409);
    // review M1 / amendment T: the passes from before the quarantine have NOT expired (the negative control: only
    // reenabled_at voids them) ...
    const [counts] = rows<{ unexpired: number; after: number }>(
      await db.execute(sql`select count(*) filter (where a.expires_at > now())::int as unexpired, count(*) filter (where a.observed_at > e.reenabled_at)::int as after
        from executor_attestations a join executors e on e.id = a.executor_id where a.executor_id = ${r.executorId} and a.verdict = 'pass'`),
    );
    expect(counts!.unexpired).toBeGreaterThan(0);
    expect(counts!.after).toBe(0);
    // ... yet nothing is offered before a new pass, and the admin view shows no fresh attestation
    const sandboxesBefore = placementSandboxes(backend).length;
    expect(await offerTo(r, { ttlSeconds: 60 })).toMatchObject({ kind: "refused", code: "no_executor" });
    expect((await inject("GET", `/v1/executors/${r.executorId}`, adminAuth)).json().attestations.every((a: { fresh: boolean }) => !a.fresh)).toBe(true);
    expect(placementSandboxes(backend)).toHaveLength(sandboxesBefore);
    // honest again: a fresh self-test (a new pass after the re-enable), then work
    backend.truthful();
    const canariesBefore = backend.sandboxes.filter((s) => s.kind === "canary").length;
    await r.run(1);
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

  // ADR-0190 amendment item 14 (vector `warn-shortfall`): a report whose applied class is below the requirement is an
  // execution_profile_mismatch in EVERY enforcement mode. The class falls between acceptance and the report: a
  // customer plane mapped to microvm takes a microvm offer, then its mapping is lowered before it reports.
  it.each(["enforce", "warn"] as const)("under %s, a report whose class fell below the requirement after acceptance is never placed", async (enforcement) => {
    const lowered: string[] = [];
    class LoweredOnStart extends FakeSandboxBackend {
      override async start(...args: Parameters<FakeSandboxBackend["start"]>) {
        const [offer] = args;
        const res = await inject("PUT", `/v1/executors/${r.executorId}/declared-class`, adminAuth, { class: "user_space_kernel" });
        expect(res.statusCode, res.body).toBe(200);
        lowered.push(offer.id);
        return super.start(...args);
      }
    }
    const backend = new LoweredOnStart({ backend: "customer" });
    const r = await rig(`below-${enforcement}`, { backend });
    expect((await inject("PUT", `/v1/executors/${r.executorId}/declared-class`, adminAuth, { class: "microvm" })).statusCode).toBe(200);
    await r.run(1);
    const offered = await offerTo(r, { workloadKind: "byoc_worker", requiredClass: "microvm", enforcement, ttlSeconds: 60 });
    expect(offered).toMatchObject({ kind: "offered", attestedClass: "customer_declared" });
    const offerId = (offered as { offerId: string }).offerId;
    const [result] = await Promise.all([awaitPlacement(db, offerId, { pollMs: 50 }), r.run(2)]);
    expect(lowered).toEqual([offerId]);
    expect(result).toMatchObject({ kind: "failed", status: "mismatch" });
    const o = await offerRow(offerId);
    expect(o.status).toBe("mismatch");
    const pl = await placementRow(o.placementId!);
    expect(pl).toMatchObject({ outcome: "mismatch", refusalCode: "execution_profile_mismatch", enforcement, requiredClass: "microvm" });
    expect(await audits("execution-placed", offerId)).toHaveLength(0);
    const [mm] = await audits("execution-profile-mismatch", offerId);
    expect((mm!.detail as { failures: Array<{ code: string }> }).failures).toContainEqual({ probe: "report", code: "class_below_required" });
    expect((await executorRow(r.executorId)).status).toBe("quarantined");
    // the sandbox started for the placement never received input
    const sb = placementSandboxes(backend).filter((s) => s.offerId === offerId);
    expect(sb).toHaveLength(1);
    expect(sb[0]).toMatchObject({ released: false, killed: true });
  });
});

// ---------------------------------------------------------------------------
// PR #340 review (medium): accept and report judge class and status on the executor row RE-READ under a share lock in
// their own transaction, never on the row loaded at authentication. Each case commits a change AFTER authentication has
// read the row: the test holds the change uncommitted, so the authentication's `last_seen_at` write parks behind that
// row lock with the OLD row already in hand; only then does the change commit. A neutral change (the same interleaving,
// nothing that matters) is the control that the interleaving alone refuses nothing.
describe("a change committed between authentication and the decision (accept, report)", () => {
  type Change = "quarantined" | "lowered" | "neutral";
  const changeSql: Record<Change, string> = {
    quarantined: "UPDATE executors SET status = 'quarantined', quarantine_code = 'admin', quarantined_at = now(), updated_at = now() WHERE id = $1 AND status = 'active'",
    lowered: "UPDATE executors SET declared_class = 'user_space_kernel', updated_at = now() WHERE id = $1",
    neutral: "UPDATE executors SET updated_at = now() WHERE id = $1",
  };

  /** a transport that, for the first request to `route`, commits `change` only once that request has authenticated */
  function interleaved(executorId: string, route: "accept" | "report", change: Change) {
    const inner = injectHttp();
    const seen: Array<{ status: number; body: string }> = [];
    let armed = true;
    const http: ExecutorHttp = async (url, init) => {
      if (!armed || !new URL(url).pathname.endsWith(`/${route}`)) return inner(url, init);
      armed = false;
      const conn = await db.$client.connect();
      try {
        await conn.query("BEGIN");
        expect((await conn.query(changeSql[change], [executorId])).rowCount).toBe(1);
        const pending = inner(url, init);
        const deadline = Date.now() + 10_000;
        for (;;) {
          const { rows: waiting } = await db.$client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'update "executors" set "last_seen_at"%'`,
          );
          if (waiting[0]!.n > 0) break;
          if (Date.now() > deadline) throw new Error("the request never parked behind the executor row lock");
          await new Promise((res) => setTimeout(res, 10));
        }
        await conn.query("COMMIT");
        const res = await pending;
        const body = await res.text();
        seen.push({ status: res.status, body });
        return { status: res.status, text: async () => body };
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        conn.release();
      }
    };
    return { http, seen };
  }

  it.each([
    ["accept", "quarantined"],
    ["accept", "lowered"],
    ["accept", "neutral"],
    ["report", "quarantined"],
    ["report", "lowered"],
    ["report", "neutral"],
  ] as const)("%s, with the executor %s after authentication", async (route, change) => {
    // a customer plane mapped to microvm, taking a microvm offer: lowering the mapping puts the call below its class
    const r = await rig(`stale-${route}-${change}`, { backend: new FakeSandboxBackend({ backend: "customer" }) });
    expect((await inject("PUT", `/v1/executors/${r.executorId}/declared-class`, adminAuth, { class: "microvm" })).statusCode).toBe(200);
    await r.run(1);
    const offered = await offerTo(r, { workloadKind: "byoc_worker", requiredClass: "microvm", ttlSeconds: 60 });
    expect(offered).toMatchObject({ kind: "offered", attestedClass: "customer_declared" });
    const offerId = (offered as { offerId: string }).offerId;
    const { http, seen } = interleaved(r.executorId, route, change);
    const client = new ExecutorClient({ gatewayUrl: ISSUER, credential: r.credential, http });
    await runExecutorLoop({ client, backend: r.backend, credential: r.credential, maxWindows: 2, streamWindowSeconds: 1, backoffMs: 5, maxBackoffMs: 10 });
    expect(seen, "the interleaved request was made").toHaveLength(1);
    const res = { status: seen[0]!.status, json: JSON.parse(seen[0]!.body) as { error?: string; failures?: Array<{ code: string }> } };
    const o = await offerRow(offerId);
    const released = placementSandboxes(r.backend).filter((s) => s.offerId === offerId && s.released);
    if (change === "neutral") {
      // the control: the same interleaving with nothing that matters committed places the call
      expect(res.status, seen[0]!.body).toBe(200);
      expect(["placed", "ended"]).toContain(o.status);
      expect(await audits("execution-placed", offerId)).toHaveLength(1);
      expect(await audits("executor-channel-refused", offerId), "nothing refused, nothing audited as refused").toHaveLength(0);
      return;
    }
    // never placed, never released, whatever the route
    if (route === "accept") expect(["accepted", "placed", "ended", "mismatch"]).not.toContain(o.status);
    expect(["placed", "ended"]).not.toContain(o.status);
    expect(await audits("execution-placed", offerId)).toHaveLength(0);
    expect(released).toHaveLength(0);
    expect(res.status, seen[0]!.body).toBe(409);
    if (change === "quarantined") {
      // fail-closed with the existing refusal; the row the transaction re-read says so
      expect(res.json.error).toBe("executor_quarantined");
      expect((await executorRow(r.executorId)).status).toBe("quarantined");
      if (route === "report") expect(o.status).toBe("accepted");
      // review follow-up (2026-10-10): the refusal leaves its own deny row, committed after the deciding transaction
      const refusedRows = await audits("executor-channel-refused", offerId);
      expect(refusedRows, "the in-transaction executor_quarantined refusal is audited once").toHaveLength(1);
      expect(refusedRows[0]).toMatchObject({ effect: "deny", objectType: "execution_placement" });
      expect(refusedRows[0]!.detail).toMatchObject({ phase: `offer-${route}`, code: "executor_quarantined", offerId, executorId: r.executorId, status: "quarantined", quarantineCode: "admin" });
    } else if (route === "accept") {
      expect(res.json.error).toBe("class_below_required");
    } else {
      // the report's class falls below the requirement through the fresh mapping: a mismatch, audited, quarantined
      expect(res.json.error).toBe("execution_profile_mismatch");
      expect(res.json.failures).toContainEqual({ probe: "report", code: "class_below_required" });
      expect(o.status).toBe("mismatch");
      const [mm] = await audits("execution-profile-mismatch", offerId);
      expect((mm!.detail as { failures: Array<{ code: string }> }).failures).toContainEqual({ probe: "report", code: "class_below_required" });
      expect((await executorRow(r.executorId)).status).toBe("quarantined");
    }
  });
});

// ---------------------------------------------------------------------------
describe("offer expiry and the report deadline (review M2)", () => {
  /** the placement rows written for one offer (each sits under an audit row naming the offer) */
  const placementsFor = async (offerId: string) =>
    rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from execution_placements p join audit_log a on a.id = p.audit_id where a.object_id = ${offerId}`))[0]!.n;

  it("concurrent sweeps expire an overdue offer exactly once (one placement, one audit row); an offer not yet due is untouched", async () => {
    const r = await rig("sweep");
    await r.run(1);
    const due = await offerTo(r, { ttlSeconds: 1 });
    const notDue = await offerTo(r, { ttlSeconds: 300 });
    expect([due.kind, notDue.kind]).toEqual(["offered", "offered"]);
    const dueId = (due as { offerId: string }).offerId;
    const notDueId = (notDue as { offerId: string }).offerId;
    await new Promise((res) => setTimeout(res, 1_200));
    await Promise.all([expireOffers(db), expireOffers(db), expireOffers(db), expireOffers(db), expireOffers(db)]);
    expect((await offerRow(dueId)).status).toBe("expired");
    expect(await audits("execution-refused", dueId)).toHaveLength(1);
    expect(await placementsFor(dueId)).toBe(1);
    expect((await placementRow((await offerRow(dueId)).placementId!)).refusalCode).toBe("no_executor");
    // the negative control: the offer that is not due is still offered, with nothing written for it
    expect((await offerRow(notDueId)).status).toBe("offered");
    expect(await audits("execution-refused", notDueId)).toHaveLength(0);
  });

  it("a report after accepted_at + the report TTL is refused offer_expired and the offer expires in the same transaction; an on-time report places", async () => {
    const r = await rig("late");
    await r.run(1);
    // the executor's transport: before the FIRST report reaches the gateway, the offer's acceptance is moved past the
    // deadline on the database clock (as if the probes had taken longer than the report TTL)
    let shift = true;
    const inner = injectHttp();
    const lateHttp: ExecutorHttp = async (url, init) => {
      if (shift && url.endsWith("/report")) {
        shift = false;
        const id = url.split("/offers/")[1]!.split("/")[0]!;
        await db.execute(sql`update execution_offers set accepted_at = now() - make_interval(secs => ${EXECUTION_OFFER_REPORT_TTL_SECONDS + 5}) where id = ${id}`);
      }
      return inner(url, init);
    };
    const client = new ExecutorClient({ gatewayUrl: ISSUER, credential: r.credential, http: lateHttp });
    const outcomes: Array<{ offer: ExecutionOffer; outcome: OfferOutcome }> = [];
    const loop = (maxWindows: number) =>
      runExecutorLoop({ client, backend: r.backend, credential: r.credential, maxWindows, streamWindowSeconds: 1, backoffMs: 5, maxBackoffMs: 10, onOffer: (offer, outcome) => outcomes.push({ offer, outcome }) });
    const offered = await offerTo(r, { ttlSeconds: 60 });
    const offerId = (offered as { offerId: string }).offerId;
    await loop(1);
    expect(outcomes.find((o) => o.offer.id === offerId)!.outcome).toEqual({ kind: "unconfirmed", why: "offer_expired" });
    const o = await offerRow(offerId);
    expect(o.status).toBe("expired");
    expect((await placementRow(o.placementId!)).refusalCode).toBe("no_executor");
    expect(await audits("execution-refused", offerId)).toHaveLength(1);
    expect(await audits("execution-placed", offerId)).toHaveLength(0);
    expect(await placementsFor(offerId)).toBe(1);
    expect(r.backend.sandboxes.find((s) => s.offerId === offerId)).toMatchObject({ released: false, killed: true });
    // the negative control: the same transport, on time, places
    const second = await offerTo(r, { ttlSeconds: 60 });
    const [res] = await Promise.all([awaitPlacement(db, (second as { offerId: string }).offerId, { pollMs: 50 }), loop(2)]);
    expect(res).toMatchObject({ kind: "placed" });
  });
});

// ---------------------------------------------------------------------------
describe("admin quarantine, revoke, the customer mapping", () => {
  it("an admin quarantine withdraws open offers; revoke is terminal and stops the loop", async () => {
    const r = await rig("admin");
    await r.run(1);
    const offered = await offerTo(r, { ttlSeconds: 300 });
    expect(offered.kind).toBe("offered");
    // review M1: a self-test while active is judged (the negative control) ...
    const selfTest = async () => runSelfTests({ backend: r.backend, credential: r.credential, client: r.client, profiles: indexProfiles(await liveProfileRefs(db)), classesDeclared: [...r.backend.describe().classes] });
    expect((await selfTest()).next).toBe("ok");
    expect((await inject("POST", `/v1/executors/${r.executorId}/quarantine`, adminAuth, { code: "execution_profile_mismatch" })).statusCode).toBe(400);
    const q = await inject("POST", `/v1/executors/${r.executorId}/quarantine`, adminAuth, { code: "admin" });
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()).toMatchObject({ status: "quarantined", quarantineCode: "admin" });
    expect((await offerRow((offered as { offerId: string }).offerId)).status).toBe("withdrawn");
    expect((await inject("POST", `/v1/executors/${r.executorId}/quarantine`, adminAuth, { code: "admin" })).statusCode).toBe(409);
    // ... and while quarantined it is refused 409 executor_quarantined, writing no attestation row
    const attBefore = (await db.select().from(executorAttestations).where(eq(executorAttestations.executorId, r.executorId))).length;
    expect(await selfTest().catch((e: unknown) => e)).toMatchObject({ status: 409, code: "executor_quarantined", next: "quarantined" });
    expect((await db.select().from(executorAttestations).where(eq(executorAttestations.executorId, r.executorId))).length).toBe(attBefore);
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
