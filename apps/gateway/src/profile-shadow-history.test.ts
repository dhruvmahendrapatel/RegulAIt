import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
// ADR-0181: this file registers a LOCAL MCP double (127.0.0.1 / localhost, registered seconds ago) to pin
// unrelated behaviour, not the strict admission defaults — relaxed explicitly here, restored in afterAll.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  abacPolicies,
  and,
  complianceProfiles,
  configActivationEvents,
  configCanaryObservations,
  configVersions,
  createDb,
  eq,
  inArray,
  mcpServers,
  policySimulationFlips,
  policySimulations,
  projects,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { runCanaryObservationPrune } from "./config-versions.js";

/**
 * ADR-0073, batch B8b — THE COMPLIANCE-PROFILE SHADOW IS STORED HISTORY, AND
 * THE STORED ROWS FEED ADR-0059's BLAST-RADIUS PREVIEW. Proved by attack.
 *
 * What this file tries to make impossible to fake:
 *
 *  1. "THE HISTORY IS STORED." The divergence GET must PERSIST one observation
 *     row per examined project — diverged and non-diverged alike, because the
 *     rows are the record of WHICH projects the 50-cap admitted — with the cap
 *     metadata readable off the row, not only off a prose note.
 *  2. "A REFRESH IS FREE OF SPAM." The same GET twice writes the second time
 *     NOTHING: dedup on (candidate, project, fingerprint). But a MOVED BASELINE
 *     is a different comparison — activating a new version mid-canary must mint
 *     NEW rows under a new fingerprint while KEEPING the old ones. Asserted as
 *     row DELTAS, never absolutes.
 *  3. "THE PREVIEW READS STORAGE, NOT THE WORLD." The ADR-0059 preview response
 *     carries the divergence field ONLY when stored diverged observations
 *     exist. A live canary whose divergence is real but UNRECORDED leaves the
 *     preview byte-identical — the assertion that catches a "helpful"
 *     recompute-in-the-preview-path implementation. And running the preview
 *     writes zero observation rows.
 *  4. "BYTE-IDENTICAL MEANS BYTE-IDENTICAL." With no candidate or no recorded
 *     divergence, the preview response's key set is EXACTLY the pre-B8b key
 *     set — the field is absent, not null. A non-admin's response never gains
 *     the field at all, however much divergence is stored.
 *  5. "PRUNING TREATS PROFILE OBSERVATIONS EXACTLY LIKE RULE OBSERVATIONS."
 *     The B7c sweep's live-canary protection keys on the candidate version's
 *     own status, which is artifact-type-agnostic — proved: an over-age profile
 *     observation of a LIVE profile canary survives the sweep, and prunes only
 *     once the canary is abandoned. `config_versions` rows survive every pass.
 *
 * SHARED-STATE DISCIPLINE: everything is `psh-` prefixed; afterAll deletes the
 * observations, versions, activation events, profiles, projects, ABAC policy
 * and simulations this file created, and the non-admin's audit rows. No
 * org-settings singleton is touched (the prune runs on the column default).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "psh-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const TAG = "psh-framework";
const STRICT_TAG = "psh-strict";

/** the exact pre-B8b response key sets — the byte-identical pin. AER-016
 * (ADR-0179) added `status` ("complete" here) to every POST answer. */
const POST_KEYS = ["abacCannotGrant", "dryRun", "fidelity", "samples", "scope", "simulation", "status"];
/** AER-016: a run that reached its deadline answers this, and only this */
const INCOMPLETE_KEYS = [
  "capped",
  "deadlineMs",
  "detail",
  "dryRun",
  "evaluated",
  "fidelity",
  "scope",
  "status",
  "total",
  "windowEnd",
  "windowStart",
];
const GET_KEYS = ["abacCannotGrant", "fidelity", "samples", "simulation", "unreplayableAttributes"];

let db: Db;
let app: ReturnType<typeof buildApp>;
let profileId: string;
let strictProfileId: string;
let projectAId: string;
let projectBId: string;
let projectCId: string;
let abacPolicyId: string;
let abacVersionId: string;
let nonAdminId: string;
let nonAdminAuth: { authorization: string };
let controlSimulationId: string;
let recordedServerId: string | undefined;

const profileObservations = () =>
  db
    .select()
    .from(configCanaryObservations)
    .where(eq(configCanaryObservations.artifactId, profileId));

const divergenceGet = () =>
  app.inject({
    method: "GET",
    headers: AUTH,
    url: `/v1/config-versions/compliance_profile/${profileId}/divergence`,
  });

const simulate = (auth = AUTH) =>
  app.inject({
    method: "POST",
    headers: auth,
    url: "/v1/policy-simulations",
    payload: { policyVersionId: abacVersionId },
  });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });

  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "psh-user@example.com", displayName: "psh user" },
  });
  expect(u.statusCode, u.body).toBe(201);
  nonAdminId = u.json().id;
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${nonAdminId}/keys`,
    payload: { name: "psh" },
  });
  nonAdminAuth = { authorization: `Bearer ${k.json().token}` };

  const p = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/compliance/profiles",
    payload: { tag: TAG, piiMode: "log", mcpDefaultMode: "read_write" },
  });
  expect(p.statusCode, p.body).toBe(201);
  profileId = p.json().id;
  const strict = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/compliance/profiles",
    payload: { tag: STRICT_TAG, piiMode: "block", mcpDefaultMode: "read_write" },
  });
  expect(strict.statusCode, strict.body).toBe(201);
  strictProfileId = strict.json().id;

  const mkProject = async (name: string, classifications: string[]) => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name, classifications },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  // A and B diverge under a piiMode log→block candidate; C carries the strict
  // tag too, whose `block` already wins the cascade, so C is examined but does
  // NOT diverge — the non-diverged-but-recorded case
  projectAId = await mkProject("psh-project-a", [TAG]);
  projectBId = await mkProject("psh-project-b", [TAG]);
  projectCId = await mkProject("psh-project-c", [TAG, STRICT_TAG]);

  // the ABAC candidate the ADR-0059 preview targets — authored, never activated
  const created = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/abac/policies",
    payload: {
      name: "psh-preview-candidate",
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource);`,
      mode: "forbid",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  abacPolicyId = created.json().policy.id;
  abacVersionId = created.json().version.id;
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  const artifacts = [profileId, strictProfileId].filter(Boolean);
  if (artifacts.length) {
    await db
      .delete(configCanaryObservations)
      .where(inArray(configCanaryObservations.artifactId, artifacts));
    await db
      .delete(configActivationEvents)
      .where(inArray(configActivationEvents.artifactId, artifacts));
    await db.delete(configVersions).where(inArray(configVersions.artifactId, artifacts));
    await db.delete(complianceProfiles).where(inArray(complianceProfiles.id, artifacts));
  }
  const projectIds = [projectAId, projectBId, projectCId].filter(Boolean);
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
  if (abacVersionId) {
    const sims = await db
      .select({ id: policySimulations.id })
      .from(policySimulations)
      .where(eq(policySimulations.policyVersionId, abacVersionId));
    if (sims.length) {
      await db.delete(policySimulationFlips).where(
        inArray(
          policySimulationFlips.simulationId,
          sims.map((s) => s.id),
        ),
      );
      await db.delete(policySimulations).where(
        inArray(
          policySimulations.id,
          sims.map((s) => s.id),
        ),
      );
    }
  }
  if (abacPolicyId) await db.delete(abacPolicies).where(eq(abacPolicies.id, abacPolicyId));
  if (nonAdminId) await db.delete(auditLog).where(eq(auditLog.userId, nonAdminId));
  if (recordedServerId) await db.delete(mcpServers).where(eq(mcpServers.id, recordedServerId));
  await app?.close();
});

describe("B8b (4) — the byte-identical control, pinned BEFORE any candidate exists", () => {
  it("with NO profile candidate the preview responses carry exactly their pre-B8b keys", async () => {
    const res = await simulate();
    expect(res.statusCode, res.body).toBe(201);
    expect(Object.keys(res.json()).sort()).toEqual(POST_KEYS);
    controlSimulationId = res.json().simulation.id;

    const read = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/policy-simulations/${controlSimulationId}`,
    });
    expect(read.statusCode).toBe(200);
    expect(Object.keys(read.json()).sort()).toEqual(GET_KEYS);
  });
});

describe("B8b (3) — the preview reads STORAGE, never the world", () => {
  it("a live candidate with REAL but UNRECORDED divergence leaves the preview byte-identical", async () => {
    // v2 candidate: piiMode log → block. The divergence is real — but nothing
    // has computed and stored it yet, so the preview must not know.
    const v2 = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}`,
      payload: { body: { piiMode: "block" }, label: "v2 — tighten piiMode" },
    });
    expect(v2.statusCode, v2.body).toBe(201);
    const c = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}/canary`,
      payload: { version: 2, pct: 25 },
    });
    expect(c.statusCode, c.body).toBe(200);

    expect((await profileObservations()).length).toBe(0);
    const res = await simulate();
    expect(res.statusCode).toBe(201);
    // a recompute-in-the-preview-path implementation would surface the
    // divergence here; the stored-history contract says the field is absent
    expect(Object.keys(res.json()).sort()).toEqual(POST_KEYS);
    // and the preview itself recorded nothing — it is a reader, not a writer
    expect((await profileObservations()).length).toBe(0);
  });
});

describe("B8b (1) — the divergence read persists one observation per EXAMINED project", () => {
  it("records diverged AND non-diverged comparisons, with the 50-cap visible in data", async () => {
    const res = await divergenceGet();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.projectImpact).toHaveLength(3);
    expect(body.projectImpactNote).toMatch(/STORED/);
    expect(body.projectImpactNote).toMatch(/3 recorded by this read/);

    const rows = await profileObservations();
    expect(rows).toHaveLength(3);
    const byProject = new Map(rows.map((r) => [r.projectId, r]));
    const a = byProject.get(projectAId)!;
    const cRow = byProject.get(projectCId)!;

    // both sides' effects, readable off the row
    expect(a.diverged).toBe(true);
    expect(a.servedEffect).toContain('piiMode="log"');
    expect(a.candidateEffect).toContain('piiMode="block"');
    expect(a.servedEffect).not.toBe(a.candidateEffect);
    expect((a.detail!.changed as string[])).toContain("piiMode");
    expect((a.detail!.before as Record<string, unknown>).piiMode).toBe("log");
    expect((a.detail!.after as Record<string, unknown>).piiMode).toBe("block");
    expect(a.candidateVersion).toBe(2);
    expect(a.activeVersion).toBe(1);
    expect(a.detail!.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // the strict-tagged project was EXAMINED and did not diverge — recorded,
    // because the rows are the record of what the cap admitted
    expect(cRow.diverged).toBe(false);
    expect(cRow.servedEffect).toBe("cascade-unchanged");
    expect(cRow.candidateEffect).toBe("cascade-unchanged");

    // the disclosed bound, now visible in data on every row
    for (const r of rows) {
      expect(r.detail!.projectCap).toBe(50);
      expect(r.detail!.taggedProjects).toBe(3);
      expect(r.detail!.examinedProjects).toBe(3);
      expect(r.detail!.capApplied).toBe(false);
      expect(r.detail!.source).toBe("profile-shadow-read-through");
    }
  });

  it("(2) a refresh deduplicates — zero new rows for an identical comparison", async () => {
    const before = (await profileObservations()).length;
    const res = await divergenceGet();
    expect(res.statusCode).toBe(200);
    expect(res.json().projectImpactNote).toMatch(/0 recorded by this read, 3 identical/);
    expect((await profileObservations()).length).toBe(before);
  });
});

describe("B8b (3) — the preview surfaces the STORED divergence, admin-only", () => {
  it("an admin's preview names the diverged projects with both sides' effects", async () => {
    const obsBefore = (await profileObservations()).length;
    const res = await simulate();
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      [...POST_KEYS, "complianceProfileCanaryDivergence"].sort(),
    );
    const feed = body.complianceProfileCanaryDivergence;
    expect(feed.note).toMatch(/never recomputed in this path/);
    const mine = feed.canaries.find((c: { artifactId: string }) => c.artifactId === profileId);
    expect(mine).toBeTruthy();
    expect(mine.tag).toBe(TAG);
    expect(mine.candidateVersion).toBe(2);
    expect(mine.activeVersion).toBe(1);
    expect(mine.observedProjects).toBe(3);
    expect(mine.divergedCount).toBe(2);
    const projA = mine.divergedProjects.find(
      (p: { projectId: string }) => p.projectId === projectAId,
    );
    expect(projA).toBeTruthy();
    expect(projA.projectName).toBe("psh-project-a");
    expect(projA.servedEffect).toContain('piiMode="log"');
    expect(projA.candidateEffect).toContain('piiMode="block"');
    expect(projA.before.piiMode).toBe("log");
    expect(projA.after.piiMode).toBe("block");
    // the non-diverged project is counted as observed, never listed as diverged
    expect(
      mine.divergedProjects.some((p: { projectId: string }) => p.projectId === projectCId),
    ).toBe(false);

    // read-only reporting: the preview run wrote no observation rows, and the
    // STORED simulation row is bucket-for-bucket what the control run stored
    expect((await profileObservations()).length).toBe(obsBefore);
    const [control] = await db
      .select()
      .from(policySimulations)
      .where(eq(policySimulations.id, controlSimulationId));
    expect(body.simulation.considered).toBe(control!.considered);
    expect(body.simulation.newlyDenied).toBe(control!.newlyDenied);
    expect(body.simulation.newlyApprovalRequired).toBe(control!.newlyApprovalRequired);

    // and the stored-preview read-out carries the same field
    const read = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/policy-simulations/${body.simulation.id}`,
    });
    expect(read.statusCode).toBe(200);
    expect(Object.keys(read.json()).sort()).toEqual(
      [...GET_KEYS, "complianceProfileCanaryDivergence"].sort(),
    );
  });

  it("(4) a NON-ADMIN's preview never gains the field, however much divergence is stored", async () => {
    const res = await simulate(nonAdminAuth);
    expect(res.statusCode, res.body).toBe(201);
    expect(Object.keys(res.json()).sort()).toEqual(POST_KEYS);
  });

  it("(5) an INCOMPLETE run (deadline reached) never carries the field either, even for an admin", async () => {
    // divergence is stored (test 3) and the caller is an admin, so only the
    // incomplete shape itself can keep the field off this response
    // A run over zero recorded calls completes: there is nothing for the
    // deadline to stop. Record one call of our own so the run has a row to
    // reach its deadline on. Without it, the outcome depends on what other
    // test files left in a shared database.
    const s = await app.inject({
      method: "POST",
      url: "/v1/servers",
      headers: AUTH,
      payload: { name: "psh-recorded-server", url: "http://127.0.0.1:9/" },
    });
    expect(s.statusCode, s.body).toBe(201);
    recordedServerId = s.json().id as string;
    await db.insert(auditLog).values({
      userId: nonAdminId,
      objectType: "mcp_tool",
      objectId: recordedServerId,
      serverId: recordedServerId,
      toolName: "psh_tool",
      effect: "allow",
      ruleId: "psh-recorded-allow",
      ruleChain: [],
      reason: "a recorded governed call for the incomplete-run case",
      at: new Date(Date.now() - 60_000),
    });
    const saved = process.env.REGULAIT_POLICY_SIMULATION_DEADLINE_MS;
    process.env.REGULAIT_POLICY_SIMULATION_DEADLINE_MS = "1";
    try {
      const res = await simulate();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe("incomplete");
      expect(Object.keys(res.json()).sort()).toEqual(INCOMPLETE_KEYS);
    } finally {
      if (saved === undefined) delete process.env.REGULAIT_POLICY_SIMULATION_DEADLINE_MS;
      else process.env.REGULAIT_POLICY_SIMULATION_DEADLINE_MS = saved;
    }
  });
});

describe("B8b (2) — a moved baseline is a NEW comparison; the old rows are history", () => {
  it("activating v3 mid-canary mints new-fingerprint rows and keeps the old ones", async () => {
    const act = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}`,
      payload: { body: { piiMode: "warn" }, label: "v3 — baseline moves", activate: true },
    });
    expect(act.statusCode, act.body).toBe(201);
    expect(act.json().activated).toBe(true);

    const before = await profileObservations();
    const res = await divergenceGet();
    expect(res.statusCode).toBe(200);
    expect(res.json().projectImpactNote).toMatch(/3 recorded by this read/);
    const after = await profileObservations();
    // DELTA: 3 new rows under the v3 baseline; the 3 v1-baseline rows survive
    expect(after.length).toBe(before.length + 3);
    expect(after.filter((r) => r.activeVersion === 1)).toHaveLength(3);
    const v3rows = after.filter((r) => r.activeVersion === 3);
    expect(v3rows).toHaveLength(3);
    const a = v3rows.find((r) => r.projectId === projectAId)!;
    expect(a.diverged).toBe(true);
    expect(a.servedEffect).toContain('piiMode="warn"');
    expect(a.candidateEffect).toContain('piiMode="block"');

    // the preview reports the LATEST comparison per project — counts unchanged,
    // baseline now named as v3
    const sim = await simulate();
    expect(sim.statusCode).toBe(201);
    const mine = sim
      .json()
      .complianceProfileCanaryDivergence.canaries.find(
        (c: { artifactId: string }) => c.artifactId === profileId,
      );
    expect(mine.observedProjects).toBe(3);
    expect(mine.divergedCount).toBe(2);
    expect(mine.activeVersion).toBe(3);
  });
});

describe("B8b (5) — the B7c prune treats profile observations exactly like rule observations", () => {
  it("live-canary protection needs no artifact-type special case, and versions never prune", async () => {
    // age one superseded-baseline row far past the 90-day default window
    const [aged] = await db
      .select()
      .from(configCanaryObservations)
      .where(
        and(
          eq(configCanaryObservations.artifactId, profileId),
          eq(configCanaryObservations.activeVersion, 1),
          eq(configCanaryObservations.projectId, projectAId),
        ),
      );
    await db
      .update(configCanaryObservations)
      .set({ at: new Date(Date.now() - 100 * 24 * 3600 * 1000) })
      .where(eq(configCanaryObservations.id, aged!.id));

    // pass 1: the candidate (v2) is a LIVE canary → the over-age row is kept.
    // The guard keys on the candidate version's own status — artifact-type
    // agnostic by construction, which is exactly what this proves.
    const first = await runCanaryObservationPrune(db, { actorUserId: null });
    expect(first.keptLiveCanary).toBeGreaterThanOrEqual(1);
    expect(
      (await db
        .select()
        .from(configCanaryObservations)
        .where(eq(configCanaryObservations.id, aged!.id))).length,
    ).toBe(1);

    // abandon the canary → the same row is now ordinary history and prunes
    const abandon = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}/canary`,
    });
    expect(abandon.statusCode).toBe(200);
    const versionCountBefore = (
      await db.select().from(configVersions).where(eq(configVersions.artifactId, profileId))
    ).length;
    await runCanaryObservationPrune(db, { actorUserId: null });
    expect(
      (await db
        .select()
        .from(configCanaryObservations)
        .where(eq(configCanaryObservations.id, aged!.id))).length,
    ).toBe(0);
    // config_versions are NEVER pruned — the boundary, re-proved for profiles
    expect(
      (await db.select().from(configVersions).where(eq(configVersions.artifactId, profileId)))
        .length,
    ).toBe(versionCountBefore);

    // with the canary gone, the preview is byte-identical again — the field
    // rides the CANARY pointer, not the leftover history
    const res = await simulate();
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json()).sort()).toEqual(POST_KEYS);
  });
});
