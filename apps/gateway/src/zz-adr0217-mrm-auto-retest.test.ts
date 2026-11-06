/**
 * ADR-0217 (P16) — AUTOMATIC RE-TEST AFTER A MODEL CHANGE.
 *
 *  - off by default (the column default and the strictness registry), and turning it on is a stepped-up,
 *    audited relaxation: an API key is refused with `step_up_required`;
 *  - while off, a model change queues nothing;
 *  - on, a configuration change on a certified card queues its pinned eval baseline and its probed red-team
 *    library once, run as the person who ran each before, and a second pass queues nothing more;
 *  - the re-test does not replace the sign-off: dispatch stays refused until a person decides a new request;
 *  - the results attach to the re-certification request, and a request decided afterwards restores dispatch;
 *  - a project over its budget refuses the re-test before any call is made.
 *
 * SHARED STATE (M-068): the MRM org fields, `mrmAutoRetestEnabled` and the step-up policy are restored exactly in
 * afterAll; the attribution mandate is relaxed by name and restored; every row this file creates is prefixed p16-
 * and removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvals,
  auditLog,
  createDb,
  desc,
  eq,
  evalRuns,
  inArray,
  modelCardApprovals,
  modelCards,
  mrmRetestRuns,
  orgSettings,
  projects,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import { SCORING_SEMANTICS_VERSION } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxedOrgSettingKeys } from "./org-setting-strictness.js";
import { loadOrgSettings } from "./org-settings.js";
import { MRM_AUTO_RETEST_MAX_SUITES, runMrmAutoRetestSweep } from "./mrm-auto-retest.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "p16-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
const DAY = 86_400_000;
const RUN = `${process.pid}-${Date.now()}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let anaAuth: { authorization: string };
let rikaId: string;
let rikaAuth: { authorization: string };
let subjectId: string;
let budgetAgentId: string;
let subjectCardId: string;
let budgetCardId: string;
let datasetId: string;
let libraryId: string;
let projectId: string;
let restoreGates: () => Promise<void> = async () => {};
let restoreIdentity: () => Promise<void> = async () => {};
let priorOrg: Partial<typeof orgSettings.$inferSelect> | null = null;
const created = { users: [] as string[], agents: [] as string[], datasets: [] as string[], usage: [] as string[] };

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName: email.split("@")[0] } });
  expect(u.statusCode, u.body).toBe(201);
  created.users.push(u.json().id as string);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "p16" } });
  expect(k.statusCode).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, grantToAna = true): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(a.statusCode, a.body).toBe(201);
  created.agents.push(a.json().id as string);
  if (!grantToAna) return a.json().id as string;
  const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: anaId, agentId: a.json().id } });
  expect(g.statusCode).toBe(201);
  return a.json().id as string;
}

async function makeCard(agentId: string, intendedUse: string): Promise<string> {
  const card = await app.inject({ method: "POST", url: "/v1/mrm/cards", headers: AUTH, payload: { agentId, intendedUse } });
  expect(card.statusCode, card.body).toBe(201);
  return card.json().card.id as string;
}

async function requestSignOff(cardId: string, reason: string): Promise<string> {
  const req = await app.inject({
    method: "POST",
    url: `/v1/mrm/cards/${cardId}/sign-off`,
    headers: AUTH,
    payload: { approverUserId: rikaId, validUntil: new Date(Date.now() + 180 * DAY).toISOString(), reason },
  });
  expect(req.statusCode, req.body).toBe(201);
  return req.json().approvalId as string;
}

async function decide(approvalId: string, reason: string) {
  const dec = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: rikaAuth, payload: { decision: "approved", reason } });
  expect(dec.statusCode, dec.body).toBe(200);
}

async function certify(cardId: string, reason: string) {
  await decide(await requestSignOff(cardId, reason), reason);
}

async function changeSystemPrompt(agentId: string, text: string) {
  const res = await app.inject({ method: "POST", url: `/v1/agents/${agentId}/system-prompt`, headers: AUTH, payload: { systemPrompt: text } });
  expect(res.statusCode, res.body).toBeLessThan(300);
}

async function invoke(agentId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: anaAuth,
    payload: { mode: "execute", input: "p16 summarize the ticket", dispatch: true },
  });
}

async function cardDetail(cardId: string) {
  const res = await app.inject({ method: "GET", url: `/v1/mrm/cards/${cardId}`, headers: AUTH });
  expect(res.statusCode).toBe(200);
  return res.json().card as {
    staleness: { drifted: boolean; driftSinceCertification: Record<string, number> | null };
    approvals: Array<{ id: string; status: string; retests: Array<{ kind: string; status: string; sourceName: string }> }>;
    retestsAwaitingRequest: Array<{ kind: string; status: string }>;
  };
}

async function setAutoRetest(enabled: boolean) {
  await db.update(orgSettings).set({ mrmAutoRetestEnabled: enabled }).where(eq(orgSettings.id, "singleton"));
}

const retestRows = (cardId: string) => db.select().from(mrmRetestRuns).where(eq(mrmRetestRuns.cardId, cardId));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreGates = await relaxGovernanceGatesForTest(db, { dispatchAttributionRequired: false });
  // the admin below is given an API key; MFA enrolment is not what this file tests
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  const org = await loadOrgSettings(db);
  priorOrg = {
    mrmEnforced: org.mrmEnforced,
    mrmStalenessRecertEnabled: org.mrmStalenessRecertEnabled,
    mrmStalenessRecertThreshold: org.mrmStalenessRecertThreshold,
    mrmAutoRetestEnabled: org.mrmAutoRetestEnabled,
    stepUpMode: org.stepUpMode,
    stepUpActions: org.stepUpActions,
  };
  const armed = await app.inject({
    method: "POST",
    url: "/v1/mrm/enforcement",
    headers: AUTH,
    payload: { enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 },
  });
  expect(armed.statusCode, armed.body).toBe(200);
  await setAutoRetest(false);

  const ana = await makeUser(`p16-ana-${RUN}@example.com`);
  anaId = ana.id;
  anaAuth = ana.auth;
  const rika = await makeUser(`p16-rika-${RUN}@example.com`);
  rikaId = rika.id;
  rikaAuth = rika.auth;
  subjectId = await makeAgent(`p16-subject-${RUN}`);
  // not granted to Ana: her re-test is refused on the budget before any call, and routing never picks it
  budgetAgentId = await makeAgent(`p16-budget-${RUN}`, false);

  const ds = await app.inject({
    method: "POST",
    url: "/v1/evals/datasets",
    headers: AUTH,
    payload: { name: `p16-golden-${RUN}`, scorerKind: "contains", scorerConfig: { needles: ["ok"] } },
  });
  expect(ds.statusCode, ds.body).toBe(201);
  datasetId = ds.json().id as string;
  created.datasets.push(datasetId);
  const c = await app.inject({ method: "POST", url: `/v1/evals/datasets/${datasetId}/cases`, headers: AUTH, payload: { input: "say ok", expected: "ok" } });
  expect(c.statusCode).toBe(201);

  // the subject's chosen suites: a baseline Ana ran and pinned, and a library she probed it with
  const base = await app.inject({ method: "POST", url: "/v1/evals/runs", headers: anaAuth, payload: { datasetId, agentId: subjectId } });
  expect(base.statusCode, base.body).toBe(201);
  await db.update(evalRuns).set({ isBaseline: true }).where(eq(evalRuns.id, base.json().run.id as string));
  const [lib] = await db.insert(redteamLibraries).values({ name: `p16-lib-${RUN}`, version: 1, status: "published", evalDatasetId: datasetId, evalDatasetVersion: 1, publishedAt: new Date() }).returning();
  libraryId = lib!.id;
  const [backing] = await db
    .insert(evalRuns)
    .values({ datasetId, datasetVersion: 1, agentId: subjectId, agentName: "p16-subject", trigger: "manual", status: "completed", mode: "execute", cases: 1, passedCases: 1, meanScore: 1, passRate: 1, gatePassed: true, initiatedByUserId: anaId, finishedAt: new Date() })
    .returning();
  await db.insert(redteamRuns).values({
    libraryId,
    libraryName: `p16-lib-${RUN}`,
    libraryVersion: 1,
    evalRunId: backing!.id,
    agentId: subjectId,
    agentName: "p16-subject",
    initiatedByUserId: anaId,
    probes: 1,
    resisted: 1,
    defeated: 0,
    asr: 0,
    gatePassed: true,
    finishedAt: new Date(),
  });

  // the budget agent's baseline bills to a project whose measured spend is already over its budget
  const [p] = await db.insert(projects).values({ name: `p16-project-${RUN}`, budgetUsd: 1, budgetApproverUserId: rikaId }).returning();
  projectId = p!.id;
  const [u] = await db.insert(usageEvents).values({ userId: anaId, agentId: budgetAgentId, projectId, costUsd: 5 }).returning();
  created.usage.push(u!.id);
  await db.insert(evalRuns).values({
    datasetId,
    datasetVersion: 1,
    agentId: budgetAgentId,
    agentName: "p16-budget",
    trigger: "manual",
    status: "completed",
    mode: "execute",
    cases: 1,
    passedCases: 1,
    meanScore: 1,
    passRate: 1,
    gatePassed: true,
    isBaseline: true,
    scoringSemantics: SCORING_SEMANTICS_VERSION,
    initiatedByUserId: anaId,
    projectId,
    finishedAt: new Date(),
  });

  subjectCardId = await makeCard(subjectId, "p16: summarize internal tickets");
  budgetCardId = await makeCard(budgetAgentId, "p16: budgeted summaries");
  await certify(subjectCardId, "p16: initial certification");
  await certify(budgetCardId, "p16: initial certification");
}, 120_000);

afterAll(async () => {
  if (priorOrg) await db.update(orgSettings).set(priorOrg).where(eq(orgSettings.id, "singleton"));
  await restoreGates();
  await restoreIdentity();
  const cards = created.agents.length
    ? await db.select({ id: modelCards.id }).from(modelCards).where(inArray(modelCards.agentId, created.agents))
    : [];
  if (cards.length) {
    const ids = cards.map((c) => c.id);
    await db.delete(mrmRetestRuns).where(inArray(mrmRetestRuns.cardId, ids));
    await db.delete(modelCardApprovals).where(inArray(modelCardApprovals.cardId, ids));
    await db.delete(modelCards).where(inArray(modelCards.id, ids));
  }
  if (created.agents.length) {
    await db.delete(redteamRuns).where(inArray(redteamRuns.agentId, created.agents));
  }
  if (libraryId) await db.delete(redteamLibraries).where(eq(redteamLibraries.id, libraryId));
  if (created.usage.length) await db.delete(usageEvents).where(inArray(usageEvents.id, created.usage));
  if (projectId) {
    await db.update(evalRuns).set({ projectId: null }).where(eq(evalRuns.projectId, projectId));
    await db.delete(approvals).where(eq(approvals.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined);
  }
  await app.close();
  await db.$client.end();
});

// ---------------------------------------------------------------------------

describe("off by default, and turning it on is a stepped-up, audited relaxation", () => {
  it("the column defaults to off, and ON is the relaxation in the strictness registry", async () => {
    const res = await db.execute<{ d: string | null }>(sql`
      SELECT column_default AS d FROM information_schema.columns
       WHERE table_name = 'org_settings' AND column_name = 'mrm_auto_retest_enabled'`);
    expect(res.rows[0]?.d).toBe("false");
    const stored = { ...(await loadOrgSettings(db)), mrmAutoRetestEnabled: false } as Record<string, unknown>;
    expect(relaxedOrgSettingKeys({ mrmAutoRetestEnabled: true }, stored)).toContain("mrmAutoRetestEnabled");
    expect(relaxedOrgSettingKeys({ mrmAutoRetestEnabled: false }, { ...stored, mrmAutoRetestEnabled: true })).not.toContain("mrmAutoRetestEnabled");
  });

  it("while off, a model change queues nothing", async () => {
    await changeSystemPrompt(subjectId, "p16: answer only from the ticket");
    const out = await runMrmAutoRetestSweep(db, DATA_KEY);
    expect(out).toEqual({ enabled: false, cards: [] });
    expect(await retestRows(subjectCardId)).toHaveLength(0);
  });

  it("an API key cannot turn it on under the strict step-up policy; the bootstrap path through a step-up is audited as a relaxation", async () => {
    const admin = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `p16-admin-${RUN}@example.com`, displayName: "p16 admin", isAdmin: true } });
    expect(admin.statusCode, admin.body).toBe(201);
    created.users.push(admin.json().id as string);
    const key = await app.inject({ method: "POST", url: `/v1/users/${admin.json().id}/keys`, headers: AUTH, payload: { name: "p16" } });
    expect(key.statusCode, key.body).toBe(201);
    await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
      step_up_actions = '["approval_decide", "settings_relax"]'::jsonb WHERE id = 'singleton'`);
    const byKey = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: { authorization: `Bearer ${key.json().token}` }, payload: { mrmAutoRetestEnabled: true } });
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(byKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await loadOrgSettings(db)).mrmAutoRetestEnabled).toBe(false);

    const on = await relaxStepUpAround(db, () => app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { mrmAutoRetestEnabled: true } }));
    expect(on.statusCode, on.body).toBe(200);
    expect((await loadOrgSettings(db)).mrmAutoRetestEnabled).toBe(true);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "org-settings-updated"))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect((row!.detail as { relaxed?: string[] }).relaxed).toContain("mrmAutoRetestEnabled");
    const status = await app.inject({ method: "GET", url: "/v1/mrm/status", headers: AUTH });
    expect(status.json().autoRetestEnabled).toBe(true);
  });
});

describe("a model change on a certified card queues its chosen suites", () => {
  it("queues the pinned baseline and the probed library once each, as the person who ran them", async () => {
    const out = await runMrmAutoRetestSweep(db, DATA_KEY);
    expect(out.enabled).toBe(true);
    const mine = out.cards.find((c) => c.cardId === subjectCardId);
    expect(mine, JSON.stringify(out)).toBeDefined();
    const rows = await retestRows(subjectCardId);
    expect(rows.map((r) => r.kind).sort()).toEqual(["eval", "redteam"]);
    for (const r of rows) {
      expect(r.status, `${r.kind}: ${r.reason}`).not.toBe("running");
      expect(r.runAsUserId).toBe(anaId);
      expect(r.cardApprovalId).toBeNull();
    }
    const evalRow = rows.find((r) => r.kind === "eval")!;
    expect(evalRow.status, evalRow.reason ?? "").toBe("passed");
    // the library has no gating probe, so its runner gives no verdict: reported, never a pass
    expect(rows.find((r) => r.kind === "redteam")!.status).toBe("reported");
    const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, evalRow.evalRunId!));
    expect(run!.trigger).toBe("scheduled");
    expect(run!.initiatedByUserId).toBe(anaId);
    expect(run!.agentId).toBe(subjectId);
    const audits = await db
      .select({ ruleId: auditLog.ruleId })
      .from(auditLog)
      .where(and(eq(auditLog.objectId, subjectCardId), inArray(auditLog.ruleId, ["mrm-auto-retest-queued", "mrm-auto-retest-finished"])));
    expect(audits.length).toBe(4);
  });

  it("a second pass for the same change queues nothing more", async () => {
    const before = await retestRows(subjectCardId);
    const out = await runMrmAutoRetestSweep(db, DATA_KEY);
    expect(out.cards.find((c) => c.cardId === subjectCardId)?.runs ?? []).toHaveLength(0);
    expect(await retestRows(subjectCardId)).toHaveLength(before.length);
    expect(MRM_AUTO_RETEST_MAX_SUITES).toBeGreaterThanOrEqual(2);
  });

  it("a project over its budget refuses the re-test before any call is made", async () => {
    await changeSystemPrompt(budgetAgentId, "p16: budgeted prompt v2");
    const spendBefore = await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.projectId, projectId));
    await runMrmAutoRetestSweep(db, DATA_KEY);
    const rows = await retestRows(budgetCardId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("refused");
    expect(rows[0]!.reason).toMatch(/project_budget_exceeded/);
    expect(rows[0]!.evalRunId).toBeNull();
    const spendAfter = await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.projectId, projectId));
    expect(spendAfter).toHaveLength(spendBefore.length);
  });
});

describe("the re-test never replaces the sign-off", () => {
  it("after a passing re-test the card is still stale and dispatch is still refused", async () => {
    const card = await cardDetail(subjectCardId);
    expect(card.staleness.drifted).toBe(true);
    expect(card.staleness.driftSinceCertification!.configChanges).toBeGreaterThan(0);
    expect(card.retestsAwaitingRequest.length).toBe(2);
    const res = await invoke(subjectId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("mrm_approval_required");
  });

  it("the results attach to the re-certification request, and only its decision restores dispatch", async () => {
    const approvalId = await requestSignOff(subjectCardId, "p16: recertify after the prompt change");
    const card = await cardDetail(subjectCardId);
    const pending = card.approvals.find((a) => a.status === "pending")!;
    expect(pending.retests.map((r) => r.kind).sort()).toEqual(["eval", "redteam"]);
    expect(card.retestsAwaitingRequest).toHaveLength(0);
    const [req] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mrm-sign-off-requested"), eq(auditLog.objectId, subjectCardId)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect((req!.detail as { retestsAttached: number }).retestsAttached).toBe(2);
    // still refused while the request is pending
    expect((await invoke(subjectId)).statusCode).toBe(409);
    await decide(approvalId, "p16: fresh evidence reviewed");
    const res = await invoke(subjectId);
    expect(res.statusCode, res.body).toBe(200);
    const [queued] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(queued!.status).toBe("approved");
  });
});
