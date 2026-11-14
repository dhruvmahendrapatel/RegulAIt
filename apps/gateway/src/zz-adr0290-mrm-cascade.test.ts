/**
 * ADR-0290 — PER-PROJECT MODEL RISK MANAGEMENT THROUGH THE §8.3 COMPLIANCE CASCADE, and the compliance-pack red-team
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
 *  6. the pack hook: a pack whose `cascadePreset` carries `mrmRequired` and red-team gating presets seeds a profile
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
  auditLog,
  compliancePacks,
  complianceProfiles,
  createDb,
  desc,
  eq,
  inArray,
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

describe("ADR-0290 — the cascade enforces the MRM gate per project", () => {
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

describe("ADR-0290 — the compliance-pack red-team preset hook", () => {
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
