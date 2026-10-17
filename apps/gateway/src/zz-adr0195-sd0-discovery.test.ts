/**
 * ADR-0195 SD0 — SHADOW-AI ACTIVE DISCOVERY, THE FOUNDATION, on a real database
 * through the real app (`buildApp`) and its hooks:
 *
 *  - HONEST REGISTRY: with the production registry (empty in SD0) every kind is
 *    "not built" and no source can be created.
 *  - ADMIN ONLY: a non-admin key reads nothing.
 *  - STEP-UPS, with negative controls: enabling needs a `settings_relax`
 *    step-up bound to the source's kind, target and scope (refused without one,
 *    refused for a grant made for another scope, which is not spent); widening
 *    an enabled source is the same step-up, narrowing is free; a static
 *    credential needs one, a federated one does not; lengthening the warning
 *    age needs one, shortening does not; revealing a pseudonym needs one.
 *  - THE SECRET NEVER LEAVES: no route returns the static secret or its
 *    ciphertext, and the stored column is an envelope, not the plaintext.
 *  - CAS: a stale `version` is refused and writes nothing.
 *  - THE WORKER: leased runs, findings through the import path (one
 *    `shadow_ai_imports` row per evidence kind, `discovery_run_id` set), merge
 *    by usage on a second run, catalogue gaps for unmatched observations, a
 *    lapsed lease re-taken (audited) and a lease lapsing on its last attempt
 *    failed, a credential reporting write scope refused, endpoint retention.
 *  - POSTURE: `/v1/org/posture` and the shadow-AI coverage statement name the
 *    enabled source; with it disabled they say nothing is scanned.
 *
 * Global state (M-068): every source this file creates is deleted, and the
 * catalogue row removed, in afterAll, so other suites keep seeing "nothing is
 * scanned".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  aiEndpointSignatures,
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  discoveryCredentials,
  discoveryPseudonyms,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  runMigrations,
  shadowAiFindings,
  shadowAiImports,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { DISCOVERY_STEP_UP_KEYS, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { enableStepUpArgs, staticCredentialStepUpArgs } from "./discovery-routes.js";
import { noopTestScanner, scannerRegistry, type ScanObservation } from "./discovery-scanners.js";
import { claimDiscoveryRun, pseudonymise, runDiscoveryPass, runEndpointRetention } from "./discovery-worker.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `sd0-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
// synthetic, derived at runtime (gitleaks): never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`sd0-data-key-${RUN}`).digest("hex");
const SECRET = `sd0-static-${randomBytes(12).toString("hex")}`;
const PKG = `sd0pkg-${RUN}`;
const PROVIDER = `sd0prov-${RUN}`;
const UNMATCHED_PKG = `sd0-unmatched-${RUN}`;
const REPO = `acme/sd0-${RUN}`;

const OBSERVATIONS: ScanObservation[] = [
  { evidenceKind: "repo_scan", subjectKind: "repo", subject: REPO, packageName: PKG },
  { evidenceKind: "repo_scan", subjectKind: "repo", subject: REPO, packageName: UNMATCHED_PKG },
];
const REGISTRY = scannerRegistry([noopTestScanner("repo_github", OBSERVATIONS, { requiresCredential: true }), noopTestScanner("endpoint_agent")]);

let db: Db;
let app: ReturnType<typeof buildApp>;
let bare: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown, a = app) =>
  a.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function mkUser(label: string, isAdmin: boolean) {
  const u = await inject("POST", "/v1/users", AUTH, { email: `sd0-${label}-${RUN}@example.com`, displayName: `sd0 ${label}` });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  if (isAdmin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" });
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}

/** a browser session for the admin; with `args`, a step-up grant made for exactly that action (the real tables) */
async function session(args?: StepUpCheckArgs) {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
      userId: adminId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  let stepUpToken: string | null = null;
  let grantId: string | null = null;
  if (args) {
    stepUpToken = "rgsu_" + randomBytes(24).toString("hex");
    const [g] = await db
      .insert(stepUpGrants)
      .values({
        tokenHash: hashToken(stepUpToken),
        userId: adminId,
        sessionId: s!.id,
        method: "totp",
        actionKind: args.kind,
        actionDigest: stepUpActionDigest(args.kind, args.facts),
        expiresAt: new Date(Date.now() + 120_000),
      })
      .returning({ id: stepUpGrants.id });
    grantId = g!.id;
  }
  const send = (method: Method, url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...CSRF, ...(stepUpToken ? { "x-regulait-step-up": stepUpToken } : {}) },
      cookies: { regulait_session: sessionToken },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const grantUsed = async () =>
    grantId ? (await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, grantId)))[0]!.usedAt !== null : false;
  return { send, grantUsed };
}

const sourceRow = async (id: string) => (await db.select().from(discoverySources).where(eq(discoverySources.id, id)))[0]!;
const createdIds: string[] = [];

async function createSource(name: string, kind = "repo_github", scope: { orgLevel: boolean; include: string[] } = { orgLevel: false, include: ["a", "b"] }) {
  const r = await inject("POST", "/v1/discovery/sources", AUTH, { name: `${name}-${RUN}`, kind, target: { org: `acme-${RUN}` }, scope });
  expect(r.statusCode, r.body).toBe(201);
  createdIds.push(r.json().id);
  return r.json() as { id: string; version: number; kind: string; target: Record<string, string>; scope: { orgLevel: boolean; include: string[] } };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, discoveryScanners: REGISTRY });
  bare = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const admin = await mkUser("admin", true);
  adminId = admin.id;
  adminKey = admin.key;
  memberKey = (await mkUser("member", false)).key;
  await db.insert(aiEndpointSignatures).values({ provider: PROVIDER, kind: "sdk_package", value: PKG, matchType: "package", provenance: "admin" });
}, 120_000);

afterAll(async () => {
  if (createdIds.length) {
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, createdIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, createdIds));
  }
  await db.delete(aiEndpointSignatures).where(eq(aiEndpointSignatures.value, PKG));
  for (const r of restores.reverse()) await r();
  await app?.close();
  await bare?.close();
});

describe("ADR-0195 SD0 discovery foundation", () => {
  it("the production registry holds only the built scanners (SD2: the three clouds); any other kind cannot be created", async () => {
    const k = await inject("GET", "/v1/discovery/scanners", AUTH, undefined, bare);
    expect(k.statusCode).toBe(200);
    const kinds = k.json().kinds as Array<{ kind: string; built: boolean }>;
    expect(kinds.filter((x) => x.built).map((x) => x.kind).sort()).toEqual(["cloud_aws", "cloud_azure", "cloud_gcp"]);
    const c = await inject("POST", "/v1/discovery/sources", AUTH, { name: `none-${RUN}`, kind: "repo_github", target: { org: "x" }, scope: { orgLevel: true, include: [] } }, bare);
    expect(c.statusCode).toBe(409);
    expect(c.json().error).toBe("scanner_not_built");
  });

  it("is admin-only", async () => {
    expect((await inject("GET", "/v1/discovery/sources", memberKey)).statusCode).toBe(403);
    expect((await inject("POST", "/v1/discovery/sources", memberKey, { name: "x", kind: "repo_github", target: { org: "x" }, scope: { orgLevel: true, include: [] } })).statusCode).toBe(403);
  });

  it("a new source is disabled; enabling needs the step-up bound to kind, target and scope", async () => {
    const s = await createSource("enable");
    expect((await sourceRow(s.id)).enabled).toBe(false);
    // credential first (federated: free)
    const c = await inject("PUT", `/v1/discovery/sources/${s.id}/credential`, AUTH, { mode: "federated", publicConfig: { appId: "123" }, replacesCredentialId: null });
    expect(c.statusCode, c.body).toBe(200);

    // NEGATIVE CONTROL 1: a session with no step-up
    const none = await session();
    const r1 = await none.send("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version });
    expect([403, 422]).toContain(r1.statusCode);
    expect((await sourceRow(s.id)).enabled).toBe(false);
    // NEGATIVE CONTROL 2: an API key can never step up
    const r2 = await inject("POST", `/v1/discovery/sources/${s.id}/enable`, adminKey, { version: s.version });
    expect(r2.statusCode).toBe(403);
    expect(r2.json().error).toBe("step_up_required");
    // NEGATIVE CONTROL 3: a grant made for ANOTHER scope is refused and not spent
    const wrong = await session(enableStepUpArgs(s.id, s.kind, s.target, { orgLevel: true, include: [] }));
    const r3 = await wrong.send("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version });
    expect(r3.statusCode).toBe(403);
    expect(await wrong.grantUsed()).toBe(false);
    expect((await sourceRow(s.id)).enabled).toBe(false);

    // the right grant
    const ok = await session(enableStepUpArgs(s.id, s.kind, s.target, s.scope));
    const r4 = await ok.send("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version });
    expect(r4.statusCode, r4.body).toBe(200);
    expect(await ok.grantUsed()).toBe(true);
    const row = await sourceRow(s.id);
    expect(row.enabled).toBe(true);
    expect(row.version).toBe(s.version + 1);
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, s.id), eq(auditLog.ruleId, "discovery-source-enabled")));
    expect(a).toBeDefined();

    // CAS: a stale version writes nothing
    const stale = await inject("PATCH", `/v1/discovery/sources/${s.id}`, AUTH, { version: s.version, name: `stale-${RUN}` });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("version_conflict");

    // narrowing an enabled source is free (an API key, no step-up)
    const narrow = await inject("PATCH", `/v1/discovery/sources/${s.id}`, adminKey, { version: row.version, scope: { orgLevel: false, include: ["a"] } });
    expect(narrow.statusCode, narrow.body).toBe(200);
    // widening it is the enable step-up: refused for the key, and nothing changes
    const wide = await inject("PATCH", `/v1/discovery/sources/${s.id}`, adminKey, { version: row.version + 1, scope: { orgLevel: true, include: [] } });
    expect(wide.statusCode).toBe(403);
    expect((await sourceRow(s.id)).scope).toEqual({ orgLevel: false, include: ["a"] });

    // disabling is free
    const d = await inject("POST", `/v1/discovery/sources/${s.id}/disable`, adminKey, {});
    expect(d.statusCode, d.body).toBe(200);
    expect((await sourceRow(s.id)).enabled).toBe(false);
  });

  it("a static credential needs the step-up, and no route ever returns its secret", async () => {
    const s = await createSource("static");
    // NEGATIVE CONTROL: the key cannot store a static secret
    const r1 = await inject("PUT", `/v1/discovery/sources/${s.id}/credential`, adminKey, { mode: "static", secret: SECRET, replacesCredentialId: null });
    expect(r1.statusCode).toBe(403);
    expect((await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.sourceId, s.id))).length).toBe(0);
    // a secret-shaped public config key is refused
    const r0 = await inject("PUT", `/v1/discovery/sources/${s.id}/credential`, AUTH, { mode: "federated", publicConfig: { clientSecret: "x" }, replacesCredentialId: null });
    expect(r0.statusCode).toBe(400);

    const ok = await session(staticCredentialStepUpArgs(s.id, s.kind, null));
    const r2 = await ok.send("PUT", `/v1/discovery/sources/${s.id}/credential`, { mode: "static", secret: SECRET, replacesCredentialId: null });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.body).not.toContain(SECRET);
    expect(r2.json()).not.toHaveProperty("secretCiphertext");
    expect(r2.json().hasSecret).toBe(true);
    const [stored] = await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.sourceId, s.id));
    expect(stored!.secretCiphertext).toBeTruthy();
    expect(stored!.secretCiphertext).not.toContain(SECRET);

    for (const url of ["/v1/discovery/sources", "/v1/org/posture", "/v1/discovery/runs"]) {
      const g = await inject("GET", url, AUTH);
      expect(g.statusCode, url).toBe(200);
      expect(g.body, url).not.toContain(SECRET);
      expect(g.body, url).not.toContain(stored!.secretCiphertext!);
    }
    const posture = (await inject("GET", "/v1/org/posture", AUTH)).json().discovery;
    expect(posture.staticCredentials.map((x: { sourceId: string }) => x.sourceId)).toContain(s.id);
    expect(posture.writeScopeUnverified.map((x: { sourceId: string }) => x.sourceId)).toContain(s.id);

    // revoking is free and destroys the secret
    const rv = await inject("DELETE", `/v1/discovery/sources/${s.id}/credential`, adminKey);
    expect(rv.statusCode, rv.body).toBe(200);
    const [after] = await db.select().from(discoveryCredentials).where(eq(discoveryCredentials.id, stored!.id));
    expect(after!.revokedAt).not.toBeNull();
    expect(after!.secretCiphertext).toBeNull();
  });

  it("an AWS federated credential gets a generated external id the admin cannot choose", async () => {
    const reg = scannerRegistry([noopTestScanner("cloud_aws")]);
    const a2 = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, discoveryScanners: reg });
    try {
      const c = await inject("POST", "/v1/discovery/sources", AUTH, { name: `aws-${RUN}`, kind: "cloud_aws", target: { accountId: "000000000000" }, scope: { orgLevel: true, include: [] } }, a2);
      expect(c.statusCode, c.body).toBe(201);
      createdIds.push(c.json().id);
      const chosen = await inject("PUT", `/v1/discovery/sources/${c.json().id}/credential`, AUTH, { mode: "federated", publicConfig: { externalId: "mine" }, replacesCredentialId: null }, a2);
      expect(chosen.statusCode).toBe(400);
      const put = await inject("PUT", `/v1/discovery/sources/${c.json().id}/credential`, AUTH, { mode: "federated", publicConfig: { roleArn: "arn:aws:iam::000000000000:role/reader" }, replacesCredentialId: null }, a2);
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json().publicConfig.externalId).toMatch(/^regulait-/);
    } finally {
      await a2.close();
    }
  });

  it("the worker: findings through the import path, merge on a second run, catalogue gaps, posture names the source", async () => {
    const s = await createSource("worker");
    expect((await inject("PUT", `/v1/discovery/sources/${s.id}/credential`, AUTH, { mode: "federated", publicConfig: { appId: "1" }, replacesCredentialId: null })).statusCode).toBe(200);
    const ok = await session(enableStepUpArgs(s.id, s.kind, s.target, s.scope));
    expect((await ok.send("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version })).statusCode).toBe(200);
    // enabling queues nothing by itself; the pass enqueues the due source (next_run_at = now)
    const pass1 = await runDiscoveryPass(db, { registry: REGISTRY, dataKey: DATA_KEY, owner: `sd0-a-${RUN}`, limit: 20 });
    expect(pass1.succeeded).toBeGreaterThanOrEqual(1);
    const [run1] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, s.id)).orderBy(desc(discoveryRuns.createdAt));
    expect(run1!.status).toBe("succeeded");
    expect(run1!.observed).toBe(2);
    expect(run1!.matched).toBe(1);
    expect(run1!.catalogueGaps).toEqual([{ kind: "sdk_package", value: UNMATCHED_PKG }]);
    expect(run1!.rawOutputSha256).toMatch(/^[0-9a-f]{64}$/);
    const [imp] = await db.select().from(shadowAiImports).where(eq(shadowAiImports.discoveryRunId, run1!.id));
    expect(imp!.kind).toBe("repo_scan");
    const [finding] = await db.select().from(shadowAiFindings).where(and(eq(shadowAiFindings.subject, REPO), eq(shadowAiFindings.provider, PROVIDER)));
    expect(finding!.subjectKind).toBe("repo");
    expect(finding!.signalSources).toContain("repo_scan");
    expect(finding!.lastImportId).toBe(imp!.id);
    // nothing became a finding without a catalogue row
    expect((await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, REPO))).length).toBe(1);

    // run now, then a second pass merges (one row, the count grows)
    const rn = await inject("POST", `/v1/discovery/sources/${s.id}/runs`, adminKey, {});
    expect(rn.statusCode, rn.body).toBe(202);
    expect((await inject("POST", `/v1/discovery/sources/${s.id}/runs`, adminKey, {})).json().error).toBe("run_already_queued");
    await runDiscoveryPass(db, { registry: REGISTRY, dataKey: DATA_KEY, owner: `sd0-b-${RUN}`, limit: 20 });
    const merged = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, REPO));
    expect(merged.length).toBe(1);
    expect(merged[0]!.observationCount).toBe(2);

    // the posture sentences name the enabled source
    const findings = (await inject("GET", "/v1/shadow-ai/findings", AUTH)).json();
    expect(findings.coverage.statement).toContain(`worker-${RUN}`);
    const posture = (await inject("GET", "/v1/org/posture", AUTH)).json().discovery;
    expect(posture.statement).toContain(`worker-${RUN}`);

    // disabled: it is no longer named
    expect((await inject("POST", `/v1/discovery/sources/${s.id}/disable`, adminKey, {})).statusCode).toBe(200);
    expect((await inject("GET", "/v1/org/posture", AUTH)).json().discovery.statement).not.toContain(`worker-${RUN}`);
    // deleting needs it disabled (it is) and no live run
    expect((await inject("DELETE", `/v1/discovery/sources/${s.id}`, adminKey)).statusCode).toBe(200);
  });

  it("a lapsed lease is re-taken (audited); a lease lapsing on the last attempt fails the run", async () => {
    const s = await createSource("lease", "endpoint_agent");
    await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId, nextRunAt: null }).where(eq(discoverySources.id, s.id));
    const [q] = await db.insert(discoveryRuns).values({ sourceId: s.id, trigger: "manual", sourceVersion: 1, kind: "endpoint_agent" }).returning();
    // worker A claims it and "crashes"; its lease lapses
    const claimed = await claimDiscoveryRun(db, `sd0-crashed-${RUN}`, 60);
    expect(claimed?.id).toBe(q!.id);
    await db.execute(sql`update discovery_runs set lease_expires_at = now() - interval '1 second' where id = ${q!.id}`);
    await runDiscoveryPass(db, { registry: REGISTRY, dataKey: DATA_KEY, owner: `sd0-c-${RUN}`, limit: 20 });
    const [after] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, q!.id));
    expect(after!.status).toBe("succeeded");
    expect(after!.attempt).toBeGreaterThanOrEqual(2);
    expect((await db.select().from(auditLog).where(and(eq(auditLog.objectId, q!.id), eq(auditLog.ruleId, "discovery-run-lease-retaken")))).length).toBe(1);

    // the last attempt's lease lapses: failed, never re-taken a fourth time
    const [q2] = await db.insert(discoveryRuns).values({ sourceId: s.id, trigger: "manual", sourceVersion: 1, kind: "endpoint_agent" }).returning();
    await db.execute(sql`update discovery_runs set status = 'running', attempt = 3, lease_owner = 'gone', lease_expires_at = now() - interval '1 second' where id = ${q2!.id}`);
    await runDiscoveryPass(db, { registry: REGISTRY, dataKey: DATA_KEY, owner: `sd0-d-${RUN}`, limit: 20 });
    const [failed] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, q2!.id));
    expect(failed!.status).toBe("failed");
    expect(failed!.errorCode).toBe("lease_expired");
  });

  it("a credential reporting write scope fails the run", async () => {
    const s = await createSource("write");
    await db.insert(discoveryCredentials).values({ sourceId: s.id, credentialMode: "federated", publicConfig: {}, createdBy: adminId });
    await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId, nextRunAt: null }).where(eq(discoverySources.id, s.id));
    const [q] = await db.insert(discoveryRuns).values({ sourceId: s.id, trigger: "manual", sourceVersion: 1, kind: "repo_github" }).returning();
    const writeReg = scannerRegistry([noopTestScanner("repo_github", OBSERVATIONS, { requiresCredential: true, credentialWriteScope: "write" })]);
    await runDiscoveryPass(db, { registry: writeReg, dataKey: DATA_KEY, owner: `sd0-e-${RUN}`, limit: 20 });
    const [r] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, q!.id));
    expect(r!.status).toBe("failed");
    expect(r!.errorCode).toBe("credential_has_write_scope");
  });

  it("pseudonyms: the name is enveloped, revealing it needs the step-up and the audit never holds the name", async () => {
    const name = `Jane Example ${RUN}`;
    const psn = await pseudonymise(db, DATA_KEY, "device_user", name);
    expect(psn).toMatch(/^psn:[0-9a-f]{24}$/);
    expect(await pseudonymise(db, DATA_KEY, "device_user", name)).toBe(psn);
    const [row] = await db.select().from(discoveryPseudonyms).where(eq(discoveryPseudonyms.pseudonym, psn));
    expect(row!.displayNameCiphertext).not.toContain(name);
    // NEGATIVE CONTROL
    const r1 = await inject("POST", `/v1/discovery/pseudonyms/${psn}/reveal`, adminKey, {});
    expect(r1.statusCode).toBe(403);
    expect(r1.body).not.toContain(name);
    const ok = await session({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.reveal]: { pseudonym: psn } } } });
    const r2 = await ok.send("POST", `/v1/discovery/pseudonyms/${psn}/reveal`, {});
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().displayName).toBe(name);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.objectId, row!.id), eq(auditLog.ruleId, "discovery-pseudonym-revealed")));
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits[0])).not.toContain(name);
  });

  it("settings: lengthening the warning age needs the step-up, shortening is free; endpoint retention deletes old device findings", async () => {
    const [s0] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
    // NEGATIVE CONTROL: longer, with a key
    const r1 = await inject("PUT", "/v1/discovery/settings", adminKey, { version: s0!.version, credentialWarningAgeDays: s0!.credentialWarningAgeDays + 1 });
    expect(r1.statusCode).toBe(403);
    // shorter: free
    const r2 = await inject("PUT", "/v1/discovery/settings", adminKey, { version: s0!.version, credentialWarningAgeDays: Math.max(1, s0!.credentialWarningAgeDays - 1) });
    expect(r2.statusCode, r2.body).toBe(200);
    // put it back (longer again: with the step-up)
    const back = s0!.credentialWarningAgeDays;
    const ok = await session({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.warningAge]: back } } });
    const r3 = await ok.send("PUT", "/v1/discovery/settings", { version: s0!.version + 1, credentialWarningAgeDays: back });
    expect(r3.statusCode, r3.body).toBe(200);

    const subject = `psn:${"a".repeat(24)}`.slice(0, 28);
    await db.insert(shadowAiFindings).values({
      subjectKind: "device",
      subject: `${subject}-${RUN}`,
      provider: PROVIDER,
      signalSources: ["endpoint_agent"],
      signatureKinds: ["desktop_app"],
      firstSeenAt: new Date(Date.now() - 400 * 86_400_000),
      lastSeenAt: new Date(Date.now() - 400 * 86_400_000),
      observationCount: 1,
      severity: "medium",
      confidence: "low",
      evidence: [],
    });
    const out = await runEndpointRetention(db);
    expect(out.findingsDeleted).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, `${subject}-${RUN}`))).length).toBe(0);
  });
});
