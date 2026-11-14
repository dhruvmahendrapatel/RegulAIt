/**
 * ADR-0045 amendment 2026-11-14 — PER-PROJECT MODEL RISK MANAGEMENT THROUGH THE §8.3 COMPLIANCE CASCADE, and the compliance-pack red-team
 * preset hook.
 *
 * ADR-0045 §4's last sentence: "where a compliance classification requires MRM, the cascade sets this toggle and it
 * cannot be relaxed below what the classification demands". It did not ship (ADR-0045 deviation 6). Pinned here:
 *
 *  1. negative control — with the org toggle RELAXED and no requiring profile, a card-less model dispatches;
 *  2. a project classified with a profile whose `mrmRequired` is true REFUSES the same dispatch (409
 *     `mrm_approval_required`), the audit row naming `enforcedBy: compliance_cascade` and the requiring tag;
 *  3. the same user, same agent, attributed to an UNCLASSIFIED project still dispatches (per-project, not org-wide);
 *  4. a profile with `mrmRequired: false` requires nothing (false cannot relax and does not enforce);
 *  5. clearing `mrmRequired` on a profile is a LOOSENING (step-up path in rule-loosening.ts);
 *  6. the WHOLE gate runs under the cascade, not only the base sign-off: with an approved card the same dispatch
 *     passes, then a fairness hold and a staleness recertification each refuse it with `enforcedBy` recorded;
 *  7. the pack hook: a pack whose `cascadePreset` carries `mrmRequired` and red-team gating presets seeds a profile
 *     that drives BOTH the dispatch gate and `resolveRedTeamPreset`; a preset naming an attack class outside the
 *     closed vocabulary is refused at pack creation.
 *
 * SHARED STATE (M-068): the org MRM toggle is relaxed through `relaxGovernanceGatesForTest` and restored; profiles,
 * projects, packs, agent and user are this file's own (prefix `l7m-`), removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  agents,
  auditLog,
  compliancePacks,
  complianceProfiles,
  createDb,
  desc,
  eq,
  fairnessDatasets,
  fairnessRuns,
  inArray,
  modelCardApprovals,
  modelCards,
  orgSettings,
  projects,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { resolveRedTeamPreset } from "./redteam.js";
import { ruleEditLoosening } from "./rule-loosening.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "l7m-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = randomUUID().slice(0, 8);
const TAG_REQ = `l7m-req-${RUN}`;
const TAG_FALSE = `l7m-false-${RUN}`;
const TAG_PACK = `l7m-pack-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let userAuth: { authorization: string };
let agentId: string;
const projectIds: string[] = [];
const packIds: string[] = [];
let restoreGates: () => Promise<void> = async () => {};

async function project(name: string, classifications: string[]): Promise<string> {
  const p = await app.inject({ method: "POST", url: "/v1/projects", headers: AUTH, payload: { name, classifications } });
  expect(p.statusCode).toBe(201);
  projectIds.push(p.json().id);
  return p.json().id as string;
}

async function invoke(projectId: string | null) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: userAuth,
    payload: { mode: "execute", input: "l7 mrm cascade probe", dispatch: true, ...(projectId ? { projectId } : {}) },
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  restoreGates = await relaxGovernanceGatesForTest(db, {
    mrmEnforced: false,
    mrmStalenessRecertEnabled: false,
    dispatchAttributionRequired: false,
    requireProjectAttribution: false,
    useCaseGateMode: "off",
  });
  await installLicenseFixture(app, { features: ["compliance_packs"], auth: AUTH });

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `l7m-${RUN}@example.com`, displayName: "L7 Mrm User" },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "l7m" } });
  userAuth = { authorization: `Bearer ${k.json().token}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `l7m-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: u.json().id, agentId } });
  expect(g.statusCode).toBeLessThan(300);

  for (const [tag, mrmRequired] of [
    [TAG_REQ, true],
    [TAG_FALSE, false],
  ] as const) {
    const p = await app.inject({ method: "POST", url: "/v1/compliance/profiles", headers: AUTH, payload: { tag, mrmRequired } });
    expect(p.statusCode).toBe(201);
  }
});

afterAll(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
  await db.delete(complianceProfiles).where(inArray(complianceProfiles.tag, [TAG_REQ, TAG_FALSE, TAG_PACK]));
  if (packIds.length) {
    await db.delete(auditLog).where(inArray(auditLog.objectId, packIds));
    await db.delete(compliancePacks).where(inArray(compliancePacks.id, packIds));
  }
  await removeLicenseFixture(db);
  await restoreGates();
  await app.close();
});

describe("ADR-0045 amendment 2026-11-14 — the cascade enforces the MRM gate per project", () => {
  it("negative control: org relaxed, no requiring profile -> a card-less model dispatches", async () => {
    const res = await invoke(null);
    expect(res.statusCode).toBe(200);
  });

  it("a project whose classification REQUIRES MRM refuses the same dispatch, audited with the cascade as cause", async () => {
    const projectId = await project(`l7m-req-proj-${RUN}`, [TAG_REQ]);
    const res = await invoke(projectId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("mrm_approval_required");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "mrm-no-card"))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const detail = row!.detail as Record<string, unknown>;
    expect(detail.agentId).toBe(agentId);
    expect(detail.projectId).toBe(projectId);
    expect(detail.enforcedBy).toBe("compliance_cascade");
    expect(detail.mrmRequiredBy).toEqual([TAG_REQ]);
    expect(row!.effect).toBe("deny");
  });

  it("per project, not org-wide: an unclassified project still dispatches", async () => {
    const projectId = await project(`l7m-plain-proj-${RUN}`, []);
    expect((await invoke(projectId)).statusCode).toBe(200);
  });

  it("mrmRequired:false requires nothing", async () => {
    const projectId = await project(`l7m-false-proj-${RUN}`, [TAG_FALSE]);
    expect((await invoke(projectId)).statusCode).toBe(200);
  });

  it("clearing mrmRequired is a loosening; setting it is not", async () => {
    const loosened = (b: unknown, a: unknown) =>
      ruleEditLoosening(db as never, "compliance_profile", { mrmRequired: b }, { mrmRequired: a });
    expect(await loosened(true, null)).toEqual({ mrmRequired: null });
    expect(await loosened(true, false)).toEqual({ mrmRequired: false });
    expect(await loosened(null, true)).toBeNull();
  });
});

describe("ADR-0045 amendment 2026-11-14 — the compliance-pack red-team preset hook", () => {
  const pack = (framework: string, cascadeTag: string, cascadePreset: Record<string, unknown>) => ({
    framework,
    version: 1,
    title: "L7 pack hook",
    provenance: { source: "l7 suite", reviewedBy: null },
    cascadeTag,
    cascadePreset,
    controls: [
      {
        controlRef: "l7:one",
        title: "governed decisions are audited",
        coverage: "evidenced",
        collector: "audit_decisions",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
      },
    ],
  });

  it("refuses a preset naming an attack class outside the closed vocabulary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/compliance/packs",
      headers: AUTH,
      payload: pack(`l7m-bad-${RUN}`, `l7m-bad-${RUN}`, { redteamGatingClasses: ["not_a_class"] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("a pack preset seeds a profile that drives the dispatch gate AND the red-team preset", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/compliance/packs",
      headers: AUTH,
      payload: pack(`l7m-fw-${RUN}`, TAG_PACK, {
        mrmRequired: true,
        redteamGatingClasses: ["prompt_injection"],
        redteamMinTrials: 3,
        redteamFailOnSeverity: "high",
      }),
    });
    expect(created.statusCode).toBe(201);
    packIds.push(created.json().pack.id);
    const act = await app.inject({ method: "POST", url: `/v1/compliance/packs/${created.json().pack.id}/activate`, headers: AUTH });
    expect(act.statusCode).toBe(200);
    expect(act.json().cascadeProfile.action).toBe("created");

    const projectId = await project(`l7m-pack-proj-${RUN}`, [TAG_PACK]);
    expect((await invoke(projectId)).statusCode).toBe(409);
    const preset = await resolveRedTeamPreset(db, projectId);
    expect(preset).not.toBeNull();
    expect(preset!.gatingClasses).toContain("prompt_injection");
    expect(preset!.minTrials).toBe(3);
    expect(preset!.failOnSeverity).toBe("high");
  });
});

describe("ADR-0045 amendment 2026-11-14 — the whole gate runs under the cascade (fairness hold, staleness)", () => {
  const DAY = 86_400_000;
  let agent2: string;
  let cardId: string;
  let datasetId: string;
  let projectId: string;
  let priorOrg: Record<string, unknown> | null = null;
  let user2Auth: { authorization: string };

  const invoke2 = () =>
    app.inject({
      method: "POST",
      url: `/v1/agents/${agent2}/invoke`,
      headers: user2Auth,
      payload: { mode: "execute", input: "l7 mrm cascade full gate", dispatch: true, projectId },
    });
  const lastDeny = async (ruleId: string) => {
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, ruleId))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    return row;
  };

  beforeAll(async () => {
    const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, "singleton"));
    priorOrg = {
      mrmStalenessRecertEnabled: org!.mrmStalenessRecertEnabled,
      mrmStalenessRecertThreshold: org!.mrmStalenessRecertThreshold,
      fairnessTestingEnabled: org!.fairnessTestingEnabled,
      fairnessBlockOnFail: org!.fairnessBlockOnFail,
    };
    const a = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: `l7m-agent2-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    });
    expect(a.statusCode).toBe(201);
    agent2 = a.json().id;
    // its OWN user, granted ONLY this agent: pillar-6 routing serves among a user's entitled agents, so a user who
    // also holds the card-less agent could be served that one (the mrm.test.ts discipline)
    const u2 = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: AUTH,
      payload: { email: `l7m-u2-${RUN}@example.com`, displayName: "L7 Mrm User Two" },
    });
    expect(u2.statusCode).toBe(201);
    const userId = u2.json().id as string;
    const k2 = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "l7m2" } });
    user2Auth = { authorization: `Bearer ${k2.json().token}` };
    await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId, agentId: agent2 } });
    // an APPROVED, unexpired sign-off, certified a day ago, so the base gate passes
    const [card] = await db.insert(modelCards).values({ agentId: agent2, intendedUse: `l7m full gate ${RUN}` }).returning();
    cardId = card!.id;
    await db.insert(modelCardApprovals).values({
      cardId,
      status: "approved",
      approverUserId: userId,
      decidedBy: userId,
      decidedAt: new Date(Date.now() - DAY),
      validUntil: new Date(Date.now() + 90 * DAY),
    });
    projectId = await project(`l7m-full-proj-${RUN}`, [TAG_REQ]);
  });

  afterAll(async () => {
    if (priorOrg) await db.update(orgSettings).set(priorOrg).where(eq(orgSettings.id, "singleton"));
    if (cardId) await db.delete(modelCards).where(eq(modelCards.id, cardId));
    if (datasetId) await db.delete(fairnessDatasets).where(eq(fairnessDatasets.id, datasetId));
    if (agent2) await db.delete(agents).where(eq(agents.id, agent2));
  });

  it("positive control: with an approved card the requiring project dispatches", async () => {
    expect((await invoke2()).statusCode).toBe(200);
  });

  it("a failing fairness run holds the dispatch, with the cascade named as the cause", async () => {
    await db
      .update(orgSettings)
      .set({ fairnessTestingEnabled: true, fairnessBlockOnFail: true })
      .where(eq(orgSettings.id, "singleton"));
    const [ds] = await db
      .insert(fairnessDatasets)
      .values({
        name: `l7m-ds-${RUN}`,
        labelColumn: "y",
        predictionColumn: "p",
        favourableLabel: "1",
        protectedAttributes: ["g"],
        rowCount: 60,
        csvBytes: 600,
        csvSha256: "a".repeat(64),
        rowsCiphertext: "x",
        expiresAt: new Date(Date.now() + DAY),
      })
      .returning();
    datasetId = ds!.id;
    await db.insert(fairnessRuns).values({
      cardId,
      datasetId,
      datasetSha256: "a".repeat(64),
      metricsVersion: "l7-test",
      thresholds: {},
      minGroupSize: 30,
      result: {},
      outcome: "fail",
    });
    const res = await invoke2();
    expect(res.statusCode).toBe(409);
    const row = await lastDeny("fairness-dispatch-held");
    const d = row!.detail as Record<string, unknown>;
    expect(d.agentId).toBe(agent2);
    expect(d.enforcedBy).toBe("compliance_cascade");
    expect(d.mrmRequiredBy).toEqual([TAG_REQ]);
    await db.update(orgSettings).set({ fairnessTestingEnabled: false }).where(eq(orgSettings.id, "singleton"));
    expect((await invoke2()).statusCode).toBe(200);
  });

  it("a card edit since certification forces recertification, with the cascade named as the cause", async () => {
    await db
      .update(orgSettings)
      .set({ mrmStalenessRecertEnabled: true, mrmStalenessRecertThreshold: 1 })
      .where(eq(orgSettings.id, "singleton"));
    const edit = await app.inject({
      method: "PATCH",
      url: `/v1/mrm/cards/${cardId}`,
      headers: AUTH,
      payload: { limitations: "l7m: an edit after certification" },
    });
    expect(edit.statusCode, edit.body).toBeLessThan(300);
    const res = await invoke2();
    expect(res.statusCode).toBe(409);
    const row = await lastDeny("mrm-staleness-recert-required");
    const d = row!.detail as Record<string, unknown>;
    expect(d.agentId).toBe(agent2);
    expect(d.enforcedBy).toBe("compliance_cascade");
    expect(d.mrmRequiredBy).toEqual([TAG_REQ]);
  });
});
