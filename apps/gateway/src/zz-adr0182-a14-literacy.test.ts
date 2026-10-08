/**
 * ADR-0182 (ADR-0175 batch D4) A14 — AI literacy and acceptable-use acknowledgements, on a real database through
 * the real app and the real enforcement path (`governedEvaluate`, `executeGovernedToolCall`).
 *
 * Red proofs (each fails with its rule reverted):
 *  - no published document → no effect (a fresh install decides as before);
 *  - enforce + an applicable published document + no acknowledgement → the governed call is DENIED
 *    `ai-literacy-not-current`, audited, and the reason names the document; a person outside the audience is
 *    unaffected; acknowledging → allowed; an expired acknowledgement → denied; a recorded completion → allowed;
 *  - a new MATERIAL version → denied until re-acknowledged (no grace period); an EDITORIAL version keeps the
 *    acknowledgements and records the transition (audited as a relaxation, with its reason);
 *  - warn records the gap and allows; off skips;
 *  - evaluation dispatches and break-glass admins are exempt;
 *  - acknowledging for another user → 403 (audited); a stale version or digest → 409;
 *  - D4A-03: an acknowledgement (and an admin's own completion record) only from an interactive session: an API
 *    key or a virtual key → 403 `acknowledgement_requires_session`, audited with the method; the session's
 *    acknowledgement records `via` and the session origin;
 *  - D4G-09: a person who is not current cannot START an evaluation or red-team run (403
 *    `ai-literacy-not-current`, audited); warn records and allows; the dispatches inside stay exempt;
 *  - D4G-11: retiring a version needs a reason (at least 10 characters), audited as a relaxation when published;
 *  - Cedar v3: a policy requiring `principal.aiTrainingCurrent` denies a person who is not current and allows one
 *    who is; the simulation surface builds the attribute exactly as enforcement does; a v2 policy is unaffected;
 *  - coverage (admin, audited read), the `literacy_coverage_gap` monitor input, the 14-day expiry notice
 *    (idempotent).
 *
 * Global state (M-068): every document is scoped to a TEAM this file creates (never "everyone"), every org setting
 * it changes is restored in a `finally`, and every row it creates is removed in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  abacPolicies,
  aiPolicyAcknowledgements,
  aiPolicyDocuments,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { governedEvaluate } from "./governed-evaluate.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import {
  aiLiteracyCurrent,
  literacyMonitorInput,
  literacyPostureFor,
  runLiteracyExpirySweep,
} from "./ai-literacy.js";
import { routeAuthClass } from "./route-classes.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a14-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const KEY = `a14-aup-${RUN}`;
const TOOL = `a14_read_${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
let teamId: string;
const people = {} as Record<
  "admin" | "inTeam" | "outside" | "glass",
  { id: string; auth: { authorization: string }; session: Record<string, string> }
>;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreAdmission: (() => Promise<void>) | undefined;
let breakGlassBefore: string[] | null = null;
let localSignInBefore: "enabled" | "break_glass_only" = "enabled";
let restoreGates: (() => Promise<void>) | undefined;
let agentId: string;
let connectorId: string;
const abacPolicyIds: string[] = [];

type Method = "GET" | "POST" | "PUT";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** the enforcement path, exactly as the MCP proxy calls it (decision only) */
const decide = (
  userId: string,
  opts?: { origin?: "human" | "evaluation" | "platform" },
  principal?: { sessionOrigin: string; mfaCompleted: boolean },
) =>
  governedEvaluate(
    db,
    userId,
    serverId,
    { serverId, name: TOOL, kind: "read" },
    undefined,
    null,
    null,
    principal,
    undefined,
    undefined,
    undefined,
    opts,
  ).then((r) => r.decision);

async function createDoc(over: Record<string, unknown> = {}) {
  const r = await inject("POST", "/v1/ai-policies", people.admin.auth, {
    key: KEY,
    kind: "acceptable_use",
    title: `Acceptable use of AI ${RUN}`,
    url: "https://policies.example.com/aup",
    audience: { all: false, teamIds: [teamId], roleIds: [] },
    validityDays: 365,
    ...over,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().document as { id: string; version: number; contentDigest: string; key: string };
}
const publish = (id: string, body: Record<string, unknown> = {}) =>
  inject("POST", `/v1/ai-policies/${id}/publish`, people.admin.auth, body);
/** D4A-03: a person acknowledges from an interactive (browser) session, so the helper uses one */
const acknowledge = (who: keyof typeof people, doc: { id: string; version: number; contentDigest: string }) =>
  inject("POST", `/v1/ai-policies/${doc.id}/acknowledge`, people[who].session, {
    version: doc.version,
    digest: doc.contentDigest,
  });
async function setGate(mode: "off" | "warn" | "enforce") {
  const r = await inject("PUT", "/v1/org/settings", people.admin.auth, { literacyGateMode: mode });
  expect(r.statusCode, r.body).toBe(200);
}

// ADR-0186 A: this suite drives step-up actions through API keys, which can never step up (restored below, M-068)
let restoreStepUp: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  restoreAdmission = await relaxStrictAdmissionForTest(db);
  const [org] = await db
    .select({ ids: orgSettings.breakGlassUserIds, localSignIn: orgSettings.localSignIn })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  localSignInBefore = (org?.localSignIn ?? "enabled") as typeof localSignInBefore;
  breakGlassBefore = org?.ids ?? null;
  // the model-dispatch and connector paths are exercised for their literacy refusal, not MRM or attribution
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["inTeam", false], ["outside", false], ["glass", true]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `a14-${k}-${RUN}@example.com`, displayName: `a14 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a14" })).json().token as string;
    // a browser session for the same person (the login page's "sign in with an API key")
    const login = await app.inject({ method: "POST", url: "/auth/login-with-key", headers: { "x-regulait-csrf": "1" }, payload: { apiKey: token } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "regulait_session")?.value;
    expect(cookie, "the exchange sets a session cookie").toBeTruthy();
    people[k] = { id, auth: { authorization: `Bearer ${token}` }, session: { cookie: `regulait_session=${cookie}`, "x-regulait-csrf": "1" } };
  }
  const s = await inject("POST", "/v1/servers", AUTH, { name: `a14-server-${RUN}`, url: "http://127.0.0.1:9" });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  const t = await inject("POST", `/v1/servers/${serverId}/tools`, AUTH, { name: TOOL, kind: "read" });
  expect(t.statusCode, t.body).toBeLessThan(300);
  for (const who of ["inTeam", "outside", "glass"] as const) {
    const g = await inject("POST", "/v1/grants/tools", AUTH, { userId: people[who].id, serverId, toolName: TOOL });
    expect(g.statusCode, g.body).toBe(201);
  }
  const team = await inject("POST", "/v1/teams", AUTH, { name: `a14-team-${RUN}` });
  expect(team.statusCode, team.body).toBe(201);
  teamId = team.json().id;
  for (const who of ["inTeam", "glass"] as const) {
    const m = await inject("POST", `/v1/teams/${teamId}/members`, AUTH, { userId: people[who].id });
    expect(m.statusCode, m.body).toBe(201);
  }
  const a = await inject("POST", "/v1/agents", AUTH, { name: `a14-agent-${RUN}`, provider: "mock", model: "mock-fast", tier: 1 });
  expect(a.statusCode, a.body).toBe(201);
  agentId = a.json().id;
  const c = await inject("POST", "/v1/connectors", AUTH, { name: `a14-connector-${RUN}`, kind: "issue-tracker", providerKind: "mock" });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id;
  for (const who of ["inTeam", "glass"] as const) {
    expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: people[who].id, agentId })).statusCode).toBe(201);
    expect((await inject("POST", "/v1/grants/connectors", AUTH, { userId: people[who].id, connectorId, mode: "readwrite" })).statusCode).toBe(201);
  }
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  // M-068: documents (acknowledgements cascade), ABAC policies, settings — whatever happened above
  await db.delete(aiPolicyDocuments).where(sql`${aiPolicyDocuments.key} like ${`a14-%-${RUN}`}`);
  for (const id of abacPolicyIds) await db.delete(abacPolicies).where(eq(abacPolicies.id, id));
  await db.update(orgSettings).set({ literacyGateMode: "enforce", breakGlassUserIds: breakGlassBefore }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ localSignIn: localSignInBefore }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await restoreGates?.();
  await restoreAdmission?.();
  await restoreIdentity?.();
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("ADR-0182 A14: nothing published, nothing changes", () => {
  it("with no published document the call is decided as before and the posture is not required", async () => {
    // The zero state is CREATED inside a transaction that is rolled back (mistakes.md: a shared-DB test asserts
    // global emptiness only inside a rolled-back transaction that creates it), so no sibling file can make this
    // false and nothing durable is touched.
    const ROLLBACK = new Error("rollback");
    const seen: { required?: boolean; effect?: string } = {};
    await db
      .transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await tx.delete(aiPolicyDocuments).where(eq(aiPolicyDocuments.status, "published"));
        seen.required = (await literacyPostureFor(tx, people.inTeam.id)).required;
        seen.effect = (
          await governedEvaluate(tx, people.inTeam.id, serverId, { serverId, name: TOOL, kind: "read" }, undefined, null, null)
        ).decision.effect;
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen).toEqual({ required: false, effect: "allow" });
    // and the self-service read says so for a person nothing applies to
    const me = await inject("GET", "/v1/me/ai-literacy", people.inTeam.auth);
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().documents.filter((d: { key: string }) => d.key === KEY)).toEqual([]);
    expect(me.json().gateMode).toBe("enforce");
  });

  it("a draft is not enforced; creating is admin-only and audited", async () => {
    expect((await inject("POST", "/v1/ai-policies", people.inTeam.auth, { key: KEY, kind: "acceptable_use", title: "x", url: "https://x.example.com" })).statusCode).toBe(403);
    const draft = await createDoc();
    expect(draft.version).toBe(1);
    expect((await decide(people.inTeam.id)).effect).toBe("allow");
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "ai-policy-created"), eq(auditLog.objectId, draft.id)));
    expect(row?.userId).toBe(people.admin.id);
    // the draft is published by the next describe block
    const p = await publish(draft.id);
    expect(p.statusCode, p.body).toBe(200);
  });
});

describe("ADR-0182 A14: the gate on governed calls (enforce, the strict default)", () => {
  let v1: { id: string; version: number; contentDigest: string; key: string };
  beforeAll(async () => {
    const [row] = await db.select().from(aiPolicyDocuments).where(and(eq(aiPolicyDocuments.key, KEY), eq(aiPolicyDocuments.version, 1)));
    v1 = { id: row!.id, version: 1, contentDigest: row!.contentDigest, key: KEY };
  });

  it("an applicable published document without an acknowledgement DENIES the call, naming the document", async () => {
    const d = await decide(people.inTeam.id);
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("ai-literacy-not-current");
    expect(d.reason).toContain(`Acceptable use of AI ${RUN}`);
    expect(d.reason).toContain(`${KEY} v1, missing`);
    expect(await aiLiteracyCurrent(db, people.inTeam.id)).toBe(false);
  });

  it("the refusal is audited on the governed tool-call path, and nothing reaches the upstream", async () => {
    const before = new Date(Date.now() - 1000);
    const out = await executeGovernedToolCall(db, "a".repeat(64), { userId: people.inTeam.id, serverId, toolName: TOOL, arguments: {} });
    expect(out.kind).toBe("denied");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, people.inTeam.id), eq(auditLog.toolName, TOOL), eq(auditLog.ruleId, "ai-literacy-not-current")))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(row, "the denial has its audit row").toBeDefined();
    expect(row!.at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row!.effect).toBe("deny");
    expect(row!.reason).toContain(KEY);
  });

  it("a person outside the audience is unaffected (nothing published applies to them)", async () => {
    expect((await decide(people.outside.id)).effect).toBe("allow");
    const list = await inject("GET", "/v1/ai-policies", people.outside.auth);
    expect(list.json().documents.filter((d: { key: string }) => d.key === KEY)).toEqual([]);
    const mine = await inject("GET", "/v1/ai-policies", people.inTeam.auth);
    expect(mine.json().documents.map((d: { key: string; version: number }) => `${d.key}@${d.version}`)).toContain(`${KEY}@1`);
  });

  it("acknowledging for another user is refused 403 and audited; a stale digest is refused 409", async () => {
    const other = await inject("POST", `/v1/ai-policies/${v1.id}/acknowledge`, people.outside.session, {
      userId: people.inTeam.id,
      version: v1.version,
      digest: v1.contentDigest,
    });
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json().error).toBe("acknowledge_self_only");
    const [refused] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-policy-acknowledge-refused"), eq(auditLog.userId, people.outside.id)));
    expect(refused?.effect).toBe("deny");
    expect(await aiLiteracyCurrent(db, people.inTeam.id)).toBe(false);
    const stale = await inject("POST", `/v1/ai-policies/${v1.id}/acknowledge`, people.inTeam.session, { version: 1, digest: "0".repeat(64) });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toBe("ai_policy_version_mismatch");
  });

  it("D4A-03: the person's own API key cannot acknowledge (403 acknowledgement_requires_session, audited); nor can a virtual key", async () => {
    const before = new Date(Date.now() - 1000);
    const viaKey = await inject("POST", `/v1/ai-policies/${v1.id}/acknowledge`, people.inTeam.auth, { version: v1.version, digest: v1.contentDigest });
    expect(viaKey.statusCode, viaKey.body).toBe(403);
    expect(viaKey.json().error).toBe("acknowledgement_requires_session");
    const rows = await db
      .select()
      .from(aiPolicyAcknowledgements)
      .where(and(eq(aiPolicyAcknowledgements.userId, people.inTeam.id), eq(aiPolicyAcknowledgements.documentId, v1.id)));
    expect(rows, "no acknowledgement was stored").toEqual([]);
    expect(await aiLiteracyCurrent(db, people.inTeam.id)).toBe(false);
    const [refused] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-policy-acknowledge-refused"), eq(auditLog.userId, people.inTeam.id)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(refused!.at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(refused!.effect).toBe("deny");
    expect(refused!.detail).toMatchObject({ code: "acknowledgement_requires_session", via: "api-key", sessionOrigin: "api_key" });
    // a virtual key (a narrowed dispatch credential of the same person) is refused too
    const vk = await inject("POST", "/v1/virtual-keys", AUTH, { name: `a14-vk-${RUN}`, userId: people.inTeam.id, purpose: "dispatch" });
    expect(vk.statusCode, vk.body).toBe(201);
    const vkToken = (vk.json().token ?? vk.json().key) as string;
    const viaVk = await inject("POST", `/v1/ai-policies/${v1.id}/acknowledge`, { authorization: `Bearer ${vkToken}` }, { version: v1.version, digest: v1.contentDigest });
    expect(viaVk.statusCode, viaVk.body).toBe(403);
    expect(await aiLiteracyCurrent(db, people.inTeam.id)).toBe(false);
  });

  it("D4A-03: an admin's OWN completion record needs a session too; a record for someone else does not", async () => {
    const own = await inject("POST", `/v1/ai-policies/${v1.id}/records`, people.glass.auth, {
      userId: people.glass.id,
      method: "admin_recorded",
      evidenceRef: "self-recorded with a key",
    });
    expect(own.statusCode, own.body).toBe(403);
    expect(own.json().error).toBe("acknowledgement_requires_session");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-policy-completion-record-refused"), eq(auditLog.userId, people.glass.id)))
      .limit(1);
    expect(row?.detail).toMatchObject({ code: "acknowledgement_requires_session", via: "api-key", forUserId: people.glass.id });
    expect(await aiLiteracyCurrent(db, people.glass.id)).toBe(false);
  });

  it("D4G-09: a person who is not current cannot START an evaluation or red-team run (403, audited); a current one passes the check", async () => {
    const before = new Date(Date.now() - 1000);
    const missing = "00000000-0000-4000-8000-0000000000aa";
    const evalRun = await inject("POST", "/v1/evals/runs", people.glass.auth, { datasetId: missing, agentId });
    expect(evalRun.statusCode, evalRun.body).toBe(403);
    expect(evalRun.json()).toMatchObject({ error: "ai-literacy-not-current" });
    expect(evalRun.json().detail).toContain(KEY);
    const redRun = await inject("POST", "/v1/redteam/runs", people.glass.auth, { libraryId: missing, agentId });
    expect(redRun.statusCode, redRun.body).toBe(403);
    expect(redRun.json()).toMatchObject({ error: "ai-literacy-not-current" });
    // even a run the caller labels "scheduled": it is still a person's request
    const labelled = await inject("POST", "/v1/redteam/runs", people.glass.auth, { libraryId: missing, agentId, trigger: "scheduled" });
    expect(labelled.statusCode, labelled.body).toBe(403);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, people.glass.id), eq(auditLog.ruleId, "ai-literacy-not-current"), sql`${auditLog.detail}->>'phase' = 'run-start'`));
    const fresh = rows.filter((r) => r.at.getTime() >= before.getTime());
    expect(fresh.map((r) => (r.detail as { runKind: string }).runKind).sort()).toEqual(["evaluation", "red-team", "red-team"]);
    expect(fresh.every((r) => r.effect === "deny")).toBe(true);
    // the outside person (nothing applies to them) passes the literacy check and meets the next one (the dataset)
    const outside = await inject("POST", "/v1/evals/runs", people.outside.auth, { datasetId: missing, agentId });
    expect(outside.body).not.toContain("ai-literacy-not-current");
    // warn: allowed past the check, and the gap is recorded
    try {
      await setGate("warn");
      const warned = await inject("POST", "/v1/evals/runs", people.glass.auth, { datasetId: missing, agentId });
      expect(warned.body).not.toContain("ai-literacy-not-current");
      const [w] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, people.glass.id), eq(auditLog.ruleId, "ai-literacy-not-current"), sql`${auditLog.detail}->>'mode' = 'warn'`))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      expect(w?.effect).toBe("allow");
    } finally {
      await setGate("enforce");
    }
  });

  it("acknowledging (self) makes the person current and the call ALLOWED; audited", async () => {
    const ack = await acknowledge("inTeam", v1);
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json().status).toMatchObject({ required: true, current: true });
    expect((await decide(people.inTeam.id)).effect).toBe("allow");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-policy-acknowledged"), eq(auditLog.userId, people.inTeam.id)));
    expect(row?.detail).toMatchObject({ key: KEY, version: 1, method: "acknowledged", via: "session", sessionOrigin: "api_key" });
  });

  it("an EXPIRED acknowledgement denies again; an admin-recorded completion with evidence restores it", async () => {
    await db
      .update(aiPolicyAcknowledgements)
      .set({ acknowledgedAt: new Date(Date.now() - 400 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) })
      .where(and(eq(aiPolicyAcknowledgements.userId, people.inTeam.id), eq(aiPolicyAcknowledgements.documentId, v1.id)));
    const d = await decide(people.inTeam.id);
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("expired");
    expect((await inject("POST", `/v1/ai-policies/${v1.id}/records`, people.inTeam.auth, {})).statusCode).toBe(403);
    const rec = await inject("POST", `/v1/ai-policies/${v1.id}/records`, people.admin.auth, {
      userId: people.inTeam.id,
      method: "training_completed",
      evidenceRef: "LMS-COMPLETION-4711",
    });
    expect(rec.statusCode, rec.body).toBe(201);
    expect((await decide(people.inTeam.id)).effect).toBe("allow");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-policy-completion-recorded"), eq(auditLog.userId, people.admin.id)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(row?.detail).toMatchObject({ forUserId: people.inTeam.id, method: "training_completed", evidenceRef: "LMS-COMPLETION-4711" });
    expect((row?.detail as { transitions: Record<string, unknown> }).transitions.method).toEqual({ from: "acknowledged", to: "training_completed" });
  });

  it("evaluation dispatches are exempt", async () => {
    // the outside person is not exempt by audience here: use the in-team person after making them not current
    const v2 = await createDoc({ title: `Acceptable use of AI ${RUN} (rev 2)` });
    expect((await publish(v2.id)).statusCode).toBe(200);
    expect((await decide(people.inTeam.id)).effect).toBe("deny");
    expect((await decide(people.inTeam.id, { origin: "evaluation" })).effect).toBe("allow");
    expect((await decide(people.inTeam.id, { origin: "platform" })).effect).toBe("allow");
  });

  it("a new MATERIAL version needs re-acknowledgement (no grace): v1's acknowledgement is superseded", async () => {
    const me = await inject("GET", "/v1/me/ai-literacy", people.inTeam.auth);
    const doc = me.json().documents.find((d: { key: string }) => d.key === KEY);
    expect(doc).toMatchObject({ version: 2, state: "superseded" });
    const d = await decide(people.inTeam.id);
    expect(d.ruleId).toBe("ai-literacy-not-current");
    expect(d.reason).toContain(`${KEY} v2, superseded`);
    const [v1Row] = await db.select().from(aiPolicyDocuments).where(eq(aiPolicyDocuments.id, v1.id));
    expect(v1Row!.status).toBe("retired");
    const ack = await acknowledge("inTeam", { id: doc.documentId, version: 2, contentDigest: doc.contentDigest });
    expect(ack.statusCode, ack.body).toBe(200);
    expect((await decide(people.inTeam.id)).effect).toBe("allow");
  });

  it("an EDITORIAL version keeps the acknowledgements, needs a reason, and records the transition", async () => {
    const v3 = await createDoc({ title: `Acceptable use of AI ${RUN} (typo fixed)` });
    const noReason = await publish(v3.id, { editorial: true });
    expect(noReason.statusCode, noReason.body).toBe(400);
    const p = await publish(v3.id, { editorial: true, editorialReason: "fixed a typo in section 2; no rule changed" });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().document).toMatchObject({ version: 3, status: "published", editorial: true });
    expect((await decide(people.inTeam.id)).effect).toBe("allow");
    const me = await inject("GET", "/v1/me/ai-literacy", people.inTeam.auth);
    expect(me.json().documents.find((d: { key: string }) => d.key === KEY)).toMatchObject({ version: 3, state: "current", acknowledgedVersion: 2 });
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "ai-policy-published"), eq(auditLog.objectId, v3.id)));
    expect(row!.detail).toMatchObject({
      editorial: true,
      relaxed: true,
      replaces: 2,
      editorialReason: "fixed a typo in section 2; no rule changed",
      transitions: {
        status: { from: "draft", to: "published" },
        editorial: { from: false, to: true },
        acknowledgements: { from: "required", to: "kept" },
      },
    });
    expect(row!.reason).toContain("RELAXED");
  });

  it("warn records the gap and allows; off skips; enforce is restored", async () => {
    const [glassBefore] = await db.select().from(aiPolicyAcknowledgements).where(eq(aiPolicyAcknowledgements.userId, people.glass.id));
    expect(glassBefore, "the second team member has acknowledged nothing").toBeUndefined();
    try {
      await setGate("warn");
      // the break-glass list is empty here, so `glass` is an ordinary admin who is not current
      const warned = await decide(people.glass.id);
      expect(warned.effect).toBe("allow");
      expect(warned.ruleChain[0]).toEqual({ rule: "ai-literacy-not-current", outcome: "no-match" });
      await setGate("off");
      const off = await decide(people.glass.id);
      expect(off.effect).toBe("allow");
      expect(off.ruleChain.some((c) => c.rule === "ai-literacy-not-current")).toBe(false);
    } finally {
      await setGate("enforce");
    }
    expect((await decide(people.glass.id)).ruleId).toBe("ai-literacy-not-current");
  });

  it("break-glass: being LISTED exempts nothing; only a break-glass SESSION is exempt, and the exemption is audited", async () => {
    const API_KEY = { sessionOrigin: "api_key", mfaCompleted: false };
    const PASSWORD = { sessionOrigin: "password", mfaCompleted: true };
    try {
      await db
        .update(orgSettings)
        .set({ breakGlassUserIds: [...(breakGlassBefore ?? []), people.glass.id], localSignIn: "break_glass_only" })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID));
      // listed, SSO enforced, but an API key (or no request at all, e.g. a worker): a standing status, not exempt
      expect((await decide(people.glass.id, undefined, API_KEY)).ruleId).toBe("ai-literacy-not-current");
      expect((await decide(people.glass.id)).ruleId).toBe("ai-literacy-not-current");
      // the same listed admin, in a break-glass session (password sign-in admitted under break_glass_only): allowed
      const exempt = await decide(people.glass.id, undefined, PASSWORD);
      expect(exempt.effect).toBe("allow");
      expect(exempt.ruleChain[0]).toEqual({ rule: "ai-literacy-break-glass-exempt", outcome: "allow" });
      // and AUDITED: the governed tool call's decision row carries the exemption on its trace
      try {
        await executeGovernedToolCall(db, "a".repeat(64), { userId: people.glass.id, serverId, toolName: TOOL, arguments: {}, principal: PASSWORD });
      } catch {
        /* the upstream is a dead port: the decision row is written before any connection is made */
      }
      const [row] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, people.glass.id), eq(auditLog.toolName, TOOL)))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      expect(row!.effect).toBe("allow");
      expect((row!.ruleChain as unknown[])[0]).toEqual({ rule: "ai-literacy-break-glass-exempt", outcome: "allow" });
    } finally {
      await db
        .update(orgSettings)
        .set({ breakGlassUserIds: breakGlassBefore, localSignIn: localSignInBefore })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    // a password session is NOT break-glass while SSO is not enforced
    expect((await decide(people.glass.id, undefined, PASSWORD)).ruleId).toBe("ai-literacy-not-current");
    expect((await inject("GET", "/v1/me/ai-literacy", people.glass.auth)).json().exempt).toBeNull();
  });

  it("MODEL DISPATCH: a person who is not current is refused at invoke (audited); a current one is not", async () => {
    const denied = await inject("POST", `/v1/agents/${agentId}/invoke`, people.glass.auth, { mode: "chat", input: "hello", dispatch: false });
    expect(denied.statusCode, denied.body).not.toBe(200);
    expect(denied.body).toContain("ai-literacy-not-current");
    expect(denied.body).toContain(KEY);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, people.glass.id), eq(auditLog.ruleId, "ai-literacy-not-current"), eq(auditLog.objectId, agentId)))
      .limit(1);
    expect(row, "the refused dispatch has its audit row").toBeDefined();
    const allowed = await inject("POST", `/v1/agents/${agentId}/invoke`, people.inTeam.auth, { mode: "chat", input: "hello", dispatch: false });
    expect(allowed.body).not.toContain("ai-literacy-not-current");
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it("CONNECTOR CALL: a person who is not current is refused (audited); a current one is not", async () => {
    const denied = await inject("POST", `/v1/connectors/${connectorId}/invoke`, people.glass.auth, { operation: "read", object: "ISSUE-1" });
    expect(denied.statusCode, denied.body).not.toBe(200);
    expect(denied.body).toContain("ai-literacy-not-current");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, people.glass.id), eq(auditLog.ruleId, "ai-literacy-not-current"), eq(auditLog.objectId, connectorId)))
      .limit(1);
    expect(row, "the refused connector call has its audit row").toBeDefined();
    const allowed = await inject("POST", `/v1/connectors/${connectorId}/invoke`, people.inTeam.auth, { operation: "read", object: "ISSUE-1" });
    expect(allowed.body).not.toContain("ai-literacy-not-current");
  });
});

describe("ADR-0182 A14: Cedar schema v3 — principal.aiTrainingCurrent", () => {
  it("a v3 policy requiring current training denies a person who is not current and allows one who is; simulation agrees", async () => {
    const created = await inject("POST", "/v1/abac/policies", AUTH, {
      name: `a14-need-training-${RUN}`,
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
               when { resource.toolName == "${TOOL}" } unless { principal.aiTrainingCurrent };`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const policyId = created.json().policy.id as string;
    abacPolicyIds.push(policyId);
    expect(created.json().version.schemaVersion).toBe("v3");
    const v2 = await inject("POST", "/v1/abac/policies", AUTH, {
      name: `a14-v2-${RUN}`,
      schemaVersion: "v2",
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
               when { resource.toolName == "${TOOL}" && principal.mfaCompleted && resource.kind == "write" };`,
    });
    expect(v2.statusCode, v2.body).toBe(201);
    abacPolicyIds.push(v2.json().policy.id);
    // activation without the blast-radius ceremony this suite is not about: set the pointer directly
    for (const p of [created.json(), v2.json()]) {
      await db.update(abacPolicies).set({ activeVersionId: p.version.id, enabled: true }).where(eq(abacPolicies.id, p.policy.id));
    }
    try {
      // `outside`: nothing applies to them, so aiTrainingCurrent is false (never vacuously true) — the v3 policy forbids
      const denied = await decide(people.outside.id);
      expect(denied.effect).toBe("deny");
      expect(denied.ruleId).toBe(policyId);
      // `inTeam` is current: the v3 policy permits; the v2 policy (writes only) is unaffected
      expect((await decide(people.inTeam.id)).effect).toBe("allow");
      for (const who of ["outside", "inTeam"] as const) {
        const sim = await inject("POST", "/v1/abac/simulate", AUTH, { userId: people[who].id, serverId, toolName: TOOL });
        expect(sim.statusCode, sim.body).toBe(200);
        expect(sim.json().attributes.principal.aiTrainingCurrent, who).toBe(who === "inTeam");
        expect(sim.json().abacDecision.effect, who).toBe(who === "inTeam" ? "permit" : "forbid");
      }
    } finally {
      for (const id of abacPolicyIds) await db.update(abacPolicies).set({ enabled: false }).where(eq(abacPolicies.id, id));
    }
    expect((await decide(people.outside.id)).effect).toBe("allow");
  });
});

describe("ADR-0182 A14: coverage, the monitor, the expiry notice, retire", () => {
  it("coverage is admin-only, audited, and counts the audience", async () => {
    expect((await inject("GET", "/v1/ai-policies/coverage", people.inTeam.auth)).statusCode).toBe(403);
    const r = await inject("GET", "/v1/ai-policies/coverage", people.admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    const doc = r.json().documents.find((d: { key: string }) => d.key === KEY);
    expect(doc).toMatchObject({ version: 3, audience: 2, current: 1, coveragePct: 50 });
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "ai-policy-coverage-read"), eq(auditLog.userId, people.admin.id)));
    expect(row).toBeDefined();
  });

  it("literacy_coverage_gap reports the document below 100%, with no personal data in the title", async () => {
    const input = await literacyMonitorInput(db, new Date());
    const b = input.literacy_coverage_gap!.breaches.find((x) => x.subjectKey === `ai_policy:${KEY}`);
    expect(b).toBeDefined();
    expect(b!.title).toBe(`AI policy ${KEY} v3: 1 of 2 people current (50%)`);
    expect(b!.title).not.toContain("@");
  });

  it("the expiry sweep notifies once inside the 14-day window and is idempotent", async () => {
    await db
      .update(aiPolicyAcknowledgements)
      .set({ expiresAt: new Date(Date.now() + 10 * 86_400_000) })
      .where(eq(aiPolicyAcknowledgements.userId, people.inTeam.id));
    const first = await runLiteracyExpirySweep(db);
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-literacy-expiry-notice"), sql`${auditLog.detail}->>'userId' = ${people.inTeam.id}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).not.toContain("@");
    const second = await runLiteracyExpirySweep(db);
    const again = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-literacy-expiry-notice"), sql`${auditLog.detail}->>'userId' = ${people.inTeam.id}`));
    expect(again).toHaveLength(1);
    expect(second.inWindow).toBeGreaterThanOrEqual(1);
    const me = await inject("GET", "/v1/me/ai-literacy", people.inTeam.auth);
    expect(me.json().documents.find((d: { key: string }) => d.key === KEY).expiresSoon).toBe(true);
  });

  it("retiring the published version removes the requirement; audited with the transition", async () => {
    const [pub] = await db.select().from(aiPolicyDocuments).where(and(eq(aiPolicyDocuments.key, KEY), eq(aiPolicyDocuments.status, "published")));
    expect((await decide(people.glass.id)).effect).toBe("deny");
    // D4G-11: a reason is required, at least 10 characters
    expect((await inject("POST", `/v1/ai-policies/${pub!.id}/retire`, people.admin.auth, {})).statusCode).toBe(400);
    expect((await inject("POST", `/v1/ai-policies/${pub!.id}/retire`, people.admin.auth, { reason: "old" })).statusCode).toBe(400);
    expect((await decide(people.glass.id)).effect, "a refused retire changed nothing").toBe("deny");
    const r = await inject("POST", `/v1/ai-policies/${pub!.id}/retire`, people.admin.auth, { reason: "replaced by the group-wide policy" });
    expect(r.statusCode, r.body).toBe(200);
    expect((await decide(people.glass.id)).effect).toBe("allow");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "ai-policy-retired"), eq(auditLog.objectId, pub!.id)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(row!.detail).toMatchObject({
      reason: "replaced by the group-wide policy",
      relaxed: true,
      transitions: { status: { from: "published", to: "retired" } },
    });
    expect(row!.reason).toContain("RELAXED");
  });
});

describe("ADR-0182 A14: route auth classes (carried over from P0's stub table)", () => {
  const ROUTES: Array<{ method: "GET" | "POST"; pattern: string; cls: "admin" | "user" }> = [
    { method: "GET", pattern: "/v1/ai-policies", cls: "user" },
    { method: "POST", pattern: "/v1/ai-policies", cls: "admin" },
    { method: "GET", pattern: "/v1/ai-policies/coverage", cls: "admin" },
    { method: "POST", pattern: "/v1/ai-policies/:policyId/publish", cls: "admin" },
    { method: "POST", pattern: "/v1/ai-policies/:policyId/retire", cls: "admin" },
    { method: "POST", pattern: "/v1/ai-policies/:policyId/acknowledge", cls: "user" },
    { method: "POST", pattern: "/v1/ai-policies/:policyId/records", cls: "admin" },
    { method: "GET", pattern: "/v1/me/ai-literacy", cls: "user" },
  ];
  it.each(ROUTES)("$method $pattern is $cls; anonymous is 401; a member on an admin route is 403", async (r) => {
    expect(routeAuthClass(r.method, r.pattern)).toBe(r.cls);
    const url = r.pattern.replace(":policyId", "00000000-0000-4000-8000-000000000002");
    const body = r.method === "GET" ? undefined : {};
    expect((await inject(r.method, url, {}, body)).statusCode).toBe(401);
    if (r.cls === "admin") expect((await inject(r.method, url, people.outside.auth, body)).statusCode).toBe(403);
  });
});
