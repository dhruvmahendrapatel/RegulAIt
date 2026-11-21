/**
 * ADR-0336 slice 4 — plaintext credentials in a staged agent's configuration, reported by location only:
 *
 *  - the worker's contract: an `agent_config` observation carries only its subject (`system`), a field path (no line,
 *    no commit) and a vendored credential rule id; anything else, a personal-data rule, an unknown rule or another
 *    kind of source is refused, and the refusal never echoes what was sent;
 *  - classification: no catalogue row is involved; the provider is the platform vendor, severity critical, and the
 *    matched value is the rule id;
 *  - on a real database through the real worker: the run raises a shadow-AI finding whose evidence names the field
 *    path and the rule, and nothing of the credential is stored anywhere; a finding naming an agent the run did not
 *    stage refuses the run.
 *
 * Global state (M-068): the family switch is restored, and every source, finding and user this file creates is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { auditLog, authSessions, createDb, desc, discoveryRuns, discoverySettings, discoverySources, eq, inArray, runMigrations, shadowAiFindings, stepUpGrants, users, type Db } from "@regulait/db";
import { AGENT_CONFIG_SECRET_RULES_EXCLUDED, DISCOVERY_STEP_UP_KEYS, classifyObservation, stepUpActionDigest, type AgentRegistry } from "@regulait/shared";
import { buildApp } from "./app.js";
import { enableStepUpArgs, staticCredentialStepUpArgs } from "./discovery-routes.js";
import { scannerRegistry, type RegistryAgentRecord, type ScanObservation, type Scanner } from "./discovery-scanners.js";
import { ObservationRefused, checkObservations, runDiscoveryPass } from "./discovery-worker.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const NOW = "2026-11-21T00:00:00.000Z";
const RULE = "pipelock.secrets.github_token";
const OK: ScanObservation = { evidenceKind: "agent_config", subjectKind: "system", subject: "acme.app.n8n.cloud/wf1", location: { path: "workflows/wf1/nodes/n2/parameters/options/systemMessage" }, secretRule: RULE };

describe("ADR-0336 slice 4: the worker's contract for agent_config", () => {
  it("accepts subject, field path and rule id, and sets the vendor from the source kind", () => {
    const [o] = checkObservations("agent_registry_n8n", [OK], NOW);
    expect(o).toEqual({ subjectKind: "system", subject: OK.subject, signalSource: "agent_config", observedAt: NOW, count: 1, location: { path: OK.location!.path }, configSecret: { rule: RULE, vendor: "n8n" } });
  });

  it("refuses anything more, another rule, another subject kind or another kind of source, without echoing it", () => {
    const leak = ["gh", "p_", "Z9y8X7w6".repeat(4), "V5u4"].join("");
    const cases: Array<[string, ScanObservation]> = [
      ["a key fragment", { ...OK, keyFragment: leak.slice(0, 8), keyLength: 40 }],
      ["a host", { ...OK, host: "api.example.com" }],
      ["names", { ...OK, names: ["x"] }],
      ["a line", { ...OK, location: { path: OK.location!.path, line: 3 } }],
      ["a commit", { ...OK, location: { path: OK.location!.path, commit: "abcdef0" } }],
      ["no location", { ...OK, location: undefined }],
      ["an unknown rule", { ...OK, secretRule: "my.rule" }],
      ["a personal-data rule", { ...OK, secretRule: AGENT_CONFIG_SECRET_RULES_EXCLUDED[0]! }],
      ["a repo subject", { ...OK, subjectKind: "repo" }],
      ["a credential in the path", { ...OK, location: { path: `nodes/${leak}` } }],
      ["a credential in the subject", { ...OK, subject: `x/${leak}` }],
      ["secretRule on other evidence", { ...OK, evidenceKind: "repo_scan" }],
    ];
    for (const [what, o] of cases) {
      let err: unknown;
      try {
        checkObservations("agent_registry_n8n", [o], NOW);
      } catch (e) {
        err = e;
      }
      expect(err, what).toBeInstanceOf(ObservationRefused);
      expect(String((err as Error).message), what).not.toContain(leak.slice(4, 12));
    }
    // a non-E17 source may not report it at all
    expect(() => checkObservations("agent_registry_entra", [OK], NOW)).toThrow(ObservationRefused);
    expect(() => checkObservations("repo_github", [OK], NOW)).toThrow(ObservationRefused);
  });

  it("classifies without the catalogue: platform vendor, critical, the rule id as the matched value", () => {
    const [o] = checkObservations("agent_registry_openai", [{ ...OK, subject: "ws/g-1", location: { path: "gpts/g-1/configs/c/instructions" } }], NOW);
    const c = classifyObservation(o!, []);
    expect(c).toMatchObject({ matched: true, provider: "openai", signatureKind: null, matchedValue: RULE, severity: "critical" });
    expect(c.reason).toContain("gpts/g-1/configs/c/instructions");
    // an observation without its rule never matches
    expect(classifyObservation({ ...o!, configSecret: null }, []).matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// on a real database
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `r336s-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = createHash("sha256").update(`r336s-data-key-${RUN}`).digest("hex");
const KEY = ["n8n", "api", "synthetic", RUN].join("_");
const TOKEN = ["gh", "p_", "Q1w2E3r4".repeat(4), "T5y6"].join("");
const EXT = `acme-${RUN}.app.n8n.cloud/wfLeak${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let sourceId: string;
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];

let next: { records: RegistryAgentRecord[]; complete: AgentRegistry[]; observations: ScanObservation[] } = { records: [], complete: [], observations: [] };
const stub: Scanner = {
  kind: "agent_registry_n8n",
  requiresCredential: true,
  run: async () => ({ observations: next.observations, registryAgents: next.records, registriesComplete: next.complete, credentialWriteScope: "read_only" }),
};
const registry = scannerRegistry([stub]);

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function session(args: StepUpCheckArgs) {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({ tokenHash: hashToken(sessionToken), userId: adminId, origin: "password", expiresAt: new Date(Date.now() + 3_600_000), idleExpiresAt: new Date(Date.now() + 3_600_000), idleMinutes: 60 })
    .returning({ id: authSessions.id });
  const stepUpToken = "rgsu_" + randomBytes(24).toString("hex");
  await db.insert(stepUpGrants).values({ tokenHash: hashToken(stepUpToken), userId: adminId, sessionId: s!.id, method: "totp", actionKind: args.kind, actionDigest: stepUpActionDigest(args.kind, args.facts), expiresAt: new Date(Date.now() + 120_000) });
  return (method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { ...CSRF, "x-regulait-step-up": stepUpToken }, cookies: { regulait_session: sessionToken }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function runNow(n: typeof next) {
  next = n;
  const r = await inject("POST", `/v1/discovery/sources/${sourceId}/runs`, adminKey, {});
  expect(r.statusCode, r.body).toBe(202);
  await runDiscoveryPass(db, { registry, dataKey: DATA_KEY, owner: `r336s-${RUN}-${randomBytes(3).toString("hex")}`, limit: 20 });
  return (await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, sourceId)).orderBy(desc(discoveryRuns.createdAt)))[0]!;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [s0] = await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1));
  restores.push(async () => {
    await db.update(discoverySettings).set({ agentRegistrySourcesEnabled: s0!.agentRegistrySourcesEnabled }).where(eq(discoverySettings.id, 1));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, discoveryScanners: registry });
  const u = await inject("POST", "/v1/users", AUTH, { email: `r336s-admin-${RUN}@example.com`, displayName: "r336s admin" });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, adminId));
  const v0 = (await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)))[0]!.version;
  const on = await session({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.families]: ["agent_registry"] } } });
  const f = await on("PUT", "/v1/discovery/settings", { version: v0, families: { agent_registry: true } });
  expect([200, 409], f.body).toContain(f.statusCode);
  const c = await inject("POST", "/v1/discovery/sources", adminKey, { name: `n8n-s4-${RUN}`, kind: "agent_registry_n8n", target: { baseUrl: `https://acme-${RUN}.app.n8n.cloud` }, scope: { orgLevel: true, include: [] } });
  expect(c.statusCode, c.body).toBe(201);
  const s = c.json() as { id: string; version: number; kind: string; target: Record<string, string>; scope: unknown };
  sourceId = s.id;
  sourceIds.push(s.id);
  const cr = await (await session(staticCredentialStepUpArgs(s.id, s.kind, null)))("PUT", `/v1/discovery/sources/${s.id}/credential`, { mode: "static", publicConfig: {}, secret: KEY, replacesCredentialId: null });
  expect(cr.statusCode, cr.body).toBe(200);
  const en = await (await session(enableStepUpArgs(s.id, s.kind, s.target, s.scope, cr.json().id as string)))("POST", `/v1/discovery/sources/${s.id}/enable`, { version: s.version });
  expect(en.statusCode, en.body).toBe(200);
}, 120_000);

afterAll(async () => {
  await db.delete(shadowAiFindings).where(eq(shadowAiFindings.subject, EXT));
  if (sourceIds.length) {
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0336 slice 4: a plaintext credential in a staged agent raises a location-only finding", () => {
  const record: RegistryAgentRecord = { registry: "n8n", externalId: EXT, displayName: `Leaky agent ${RUN}` };
  const obs: ScanObservation = { evidenceKind: "agent_config", subjectKind: "system", subject: EXT, location: { path: `workflows/wfLeak${RUN}/nodes/n6/parameters/headerValue` }, secretRule: RULE };

  it("stores a critical finding naming the field and the rule; nothing of the credential anywhere", async () => {
    const run = await runNow({ records: [record], complete: [], observations: [obs] });
    expect(run.status, run.errorDetail ?? "").toBe("succeeded");
    expect(run.matched).toBe(1);
    const [f] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, EXT));
    expect(f).toMatchObject({ subjectKind: "system", provider: "n8n", severity: "critical", signalSources: ["agent_config"], signatureKinds: [] });
    expect(f!.evidence[0]).toMatchObject({ matchedValue: RULE, location: { path: obs.location!.path } });
    const stored = JSON.stringify([f, run, await db.select().from(auditLog).where(eq(auditLog.objectId, run.id))]);
    for (let i = 0; i + 8 <= TOKEN.length; i++) expect(stored).not.toContain(TOKEN.slice(i, i + 8));
  });

  it("a finding naming an agent the run did not stage refuses the run", async () => {
    const run = await runNow({ records: [record], complete: [], observations: [{ ...obs, subject: `${EXT}-other` }] });
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("observation_refused");
  });
});
