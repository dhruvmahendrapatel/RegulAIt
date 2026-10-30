/**
 * ADR-0206 — G1 project archive and G10 rename roles and teams.
 *
 * G1: admin-only; refused while approvals, runs or delegations are open; the archive and its audit row are one
 * write; an archived project is left out of the default list, refuses member/context/settings writes (gateway 409
 * and migration 0218's insert guard) and every attributed call (the pre-dispatch gate), so a pinned engine key stops
 * working; unarchive needs a `settings_relax` step-up bound to that project.
 *
 * G10: admin-only; a plain rename saves and is audited; a taken name is refused; a rename whose old name an access
 * policy or a routing rule matches is refused with the references listed, then needs a reason and a step-up bound to
 * that exact rename.
 *
 * Shares one database with the other gateway suites: every fixture is named by this run's id and resolved by id, and
 * assertions on the audit log are deltas filtered to this run's objects (M-008, M-040).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import {
  abacPolicies,
  abacPolicyVersions,
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  inArray,
  orchestrationRuns,
  projectMembers,
  projects,
  roles,
  runMigrations,
  teams,
  virtualKeys,
  workflowAssignmentRules,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { preDispatchProjectGate } from "./projects.js";
import { PROJECT_ARCHIVED_RULE_ID, PROJECT_UNARCHIVED_RULE_ID, unarchiveStepUp } from "./project-archive.js";
import { ROLE_RENAMED_RULE_ID, TEAM_RENAMED_RULE_ID, renameStepUp } from "./role-team-rename.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantSpent, grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0206-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = randomUUID().slice(0, 8);
const REASON = "Pilot ended; spend moves to the support project from November.";

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
let memberId: string;
let memberAuth: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const policyIds: string[] = [];
const templateIds: string[] = [];

const auditsFor = async (ruleId: string, objectId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)));

async function createProject(label: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/projects", headers: AUTH, payload: { name: `adr0206 ${label} ${RUN}` } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** an engine key pinned to the project, as the engine lease mints one (no FK on the run id) */
async function pinEngineKey(projectId: string): Promise<string> {
  const [row] = await db
    .insert(virtualKeys)
    .values({
      name: `adr0206 engine ${RUN}`,
      userId: adminId,
      tokenHash: hashToken("rgvk_" + randomBytes(24).toString("hex")),
      purpose: "engine",
      projectId,
      engineRunId: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
      budgetUsd: 1,
      allowedModels: ["adr0206-model"],
    })
    .returning({ id: virtualKeys.id });
  return row!.id;
}

/** a live access policy whose Cedar source matches `name` as a principal role or team */
async function policyNaming(attr: "roles" | "teams", name: string, active = true): Promise<string> {
  const [policy] = await db
    .insert(abacPolicies)
    .values({ name: `adr0206 ${attr} ${name} ${randomUUID().slice(0, 6)}`, enabled: false })
    .returning({ id: abacPolicies.id });
  const [version] = await db
    .insert(abacPolicyVersions)
    .values({
      policyId: policy!.id,
      version: 1,
      source: `forbid (principal, action, resource) when { principal.${attr}.contains(${JSON.stringify(name)}) };`,
      schemaVersion: "1",
      mode: "forbid",
    })
    .returning({ id: abacPolicyVersions.id });
  if (active) await db.update(abacPolicies).set({ activeVersionId: version!.id }).where(eq(abacPolicies.id, policy!.id));
  policyIds.push(policy!.id);
  return policy!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  const admin = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `adr0206-admin-${RUN}@example.com`, displayName: `Archive Admin ${RUN}`, isAdmin: true },
  });
  expect(admin.statusCode, admin.body).toBe(201);
  adminId = admin.json().id;
  adminAuth = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
  const member = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `adr0206-member-${RUN}@example.com`, displayName: `Member ${RUN}` },
  });
  memberId = member.json().id;
  memberAuth = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${memberId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
}, 120_000);

afterAll(async () => {
  if (policyIds.length) await db.delete(abacPolicies).where(inArray(abacPolicies.id, policyIds));
  if (templateIds.length) await db.delete(workflowTemplates).where(inArray(workflowTemplates.id, templateIds));
  for (const r of restores.reverse()) await r();
  await app.close();
  await (db.$client as { end: () => Promise<void> }).end();
});

// ------------------------------------------------------------------ G1

describe("G1 project archive (ADR-0206)", () => {
  it("is admin-only: a member can neither read the impact nor archive", async () => {
    const id = await createProject("admin-only");
    const impact = await app.inject({ method: "GET", url: `/v1/projects/${id}/archive-impact`, headers: memberAuth });
    expect(impact.statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: `/v1/projects/${id}/archive`, headers: memberAuth, payload: { reason: REASON } });
    expect(res.statusCode).toBe(403);
    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    expect(row!.archivedAt).toBeNull();
    expect(await auditsFor(PROJECT_ARCHIVED_RULE_ID, id)).toHaveLength(0);
  });

  it("needs a reason of at least 10 characters, and 404s an unknown project", async () => {
    const id = await createProject("reason");
    for (const payload of [{}, { reason: "too short" }]) {
      const res = await app.inject({ method: "POST", url: `/v1/projects/${id}/archive`, headers: adminAuth, payload });
      expect(res.statusCode).toBe(400);
    }
    const unknown = await app.inject({ method: "POST", url: `/v1/projects/${randomUUID()}/archive`, headers: adminAuth, payload: { reason: REASON } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("unknown_project");
  });

  it("is refused while an approval is open, naming it, and nothing is written", async () => {
    const id = await createProject("approvals");
    const [apr] = await db
      .insert(approvals)
      .values({ userId: adminId, approverUserId: adminId, projectId: id, objectType: "project", status: "pending" })
      .returning({ id: approvals.id });
    const res = await app.inject({ method: "POST", url: `/v1/projects/${id}/archive`, headers: adminAuth, payload: { reason: REASON } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "project_has_open_approvals", count: 1, approvals: [{ id: apr!.id }] });
    expect((await db.select().from(projects).where(eq(projects.id, id)))[0]!.archivedAt).toBeNull();
    expect(await auditsFor(PROJECT_ARCHIVED_RULE_ID, id)).toHaveLength(0);
    // control: once decided, the same archive goes through
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, apr!.id));
    const ok = await app.inject({ method: "POST", url: `/v1/projects/${id}/archive`, headers: adminAuth, payload: { reason: REASON } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("is refused while a run is in progress, naming it", async () => {
    const id = await createProject("running");
    const [run] = await db
      .insert(orchestrationRuns)
      .values({ name: `adr0206 ${RUN}`, initiatingUserId: adminId, graph: {}, state: {}, projectId: id, status: "running" })
      .returning({ id: orchestrationRuns.id });
    const res = await app.inject({ method: "POST", url: `/v1/projects/${id}/archive`, headers: adminAuth, payload: { reason: REASON } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "project_has_running_work", count: 1, runs: [{ id: run!.id, kind: "orchestration" }] });
    await db.update(orchestrationRuns).set({ status: "completed" }).where(eq(orchestrationRuns.id, run!.id));
    const ok = await app.inject({ method: "POST", url: `/v1/projects/${id}/archive`, headers: adminAuth, payload: { reason: REASON } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("a credential pasted into the reason is stored redacted (ADR-0102 prose scrub)", async () => {
    const id = await createProject("scrub");
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${id}/archive`,
      headers: adminAuth,
      payload: { reason: "Retired; old key was AKIAIOSFODNN7EXAMPLE, rotated" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    expect(row!.archivedReason).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(row!.archivedReason).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
  });

  describe("an archived project", () => {
    let id: string;
    let keyId: string;

    beforeAll(async () => {
      id = await createProject("lifecycle");
      keyId = await pinEngineKey(id);
      await app.inject({ method: "POST", url: `/v1/projects/${id}/members`, headers: AUTH, payload: { userId: memberId, role: "viewer" } });
    });

    it("the impact lists the engine keys the archive will stop", async () => {
      const res = await app.inject({ method: "GET", url: `/v1/projects/${id}/archive-impact`, headers: adminAuth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ archived: false, pinnedEngineKeyCount: 1, openApprovalCount: 0, runningWorkCount: 0 });
      expect(res.json().pinnedEngineKeys.map((k: { id: string }) => k.id)).toEqual([keyId]);
    });

    it("archives with one audit row naming the reason and the pinned keys", async () => {
      expect((await preDispatchProjectGate(db, id, adminId)).ok).toBe(true);
      const res = await app.inject({ method: "POST", url: `/v1/projects/${id}/archive`, headers: adminAuth, payload: { reason: REASON } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ archived: true, pinnedEngineKeyCount: 1 });
      const [row] = await db.select().from(projects).where(eq(projects.id, id));
      expect(row!.archivedAt).not.toBeNull();
      expect(row!.archivedReason).toBe(REASON);
      expect(row!.archivedByUserId).toBe(adminId);
      const audits = await auditsFor(PROJECT_ARCHIVED_RULE_ID, id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.userId).toBe(adminId);
      expect(audits[0]!.detail).toMatchObject({ reason: REASON, pinnedEngineKeys: [keyId] });
      const again = await app.inject({ method: "POST", url: `/v1/projects/${id}/archive`, headers: adminAuth, payload: { reason: REASON } });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("project_already_archived");
    });

    it("is hidden from the default list and shown on request, with who archived it", async () => {
      const ids = async (q: string) =>
        ((await app.inject({ method: "GET", url: `/v1/projects${q}`, headers: adminAuth })).json().projects as Array<{ id: string }>).map((p) => p.id);
      expect(await ids("")).not.toContain(id);
      expect(await ids("?archived=include")).toContain(id);
      expect(await ids("?archived=only")).toContain(id);
      const only = (await app.inject({ method: "GET", url: "/v1/projects?archived=only", headers: adminAuth })).json().projects as Array<Record<string, unknown>>;
      expect(only.find((p) => p.id === id)).toMatchObject({ archivedReason: REASON, archivedByName: `Archive Admin ${RUN}` });
      // a member sees it the same way
      expect((await app.inject({ method: "GET", url: "/v1/projects", headers: memberAuth })).json().projects.map((p: { id: string }) => p.id)).not.toContain(id);
      expect((await app.inject({ method: "GET", url: "/v1/projects?archived=include", headers: memberAuth })).json().projects.map((p: { id: string }) => p.id)).toContain(id);
    });

    it("refuses member, context and settings writes, and every attributed call", async () => {
      const add = await app.inject({ method: "POST", url: `/v1/projects/${id}/members`, headers: AUTH, payload: { userId: adminId, role: "viewer" } });
      expect(add.statusCode).toBe(409);
      expect(add.json().error).toBe("project_archived");
      const role = await app.inject({ method: "PATCH", url: `/v1/projects/${id}/members/${memberId}`, headers: AUTH, payload: { role: "owner" } });
      expect(role.json().error).toBe("project_archived");
      const ctx = await app.inject({ method: "POST", url: `/v1/projects/${id}/context`, headers: AUTH, payload: { key: "k", content: "c" } });
      expect(ctx.json().error).toBe("project_archived");
      const patch = await app.inject({ method: "PATCH", url: `/v1/projects/${id}`, headers: AUTH, payload: { costCenter: "cc-1" } });
      expect(patch.statusCode).toBe(409);
      expect(patch.json().error).toBe("project_archived");
      const gate = await preDispatchProjectGate(db, id, adminId);
      expect(gate).toMatchObject({ ok: false, status: 409, error: "project_archived" });
    });

    it("the database refuses a new member even past the gateway (migration 0218)", async () => {
      const err = await db
        .insert(projectMembers)
        .values({ projectId: id, userId: adminId, role: "viewer" })
        .then(() => null, (e: unknown) => e as { cause?: { message?: string } });
      expect(err?.cause?.message).toMatch(/project_members: project .* is archived/);
    });

    it("unarchive is refused without a step-up, and with one made for another project, spending nothing", async () => {
      const key = await app.inject({ method: "POST", url: `/v1/projects/${id}/unarchive`, headers: adminAuth, payload: {} });
      expect(key.statusCode).toBe(403);
      expect(key.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
      const other = await grantStepUpForTest(db, adminId, unarchiveStepUp(randomUUID()));
      const wrong = await app.inject({ method: "POST", url: `/v1/projects/${id}/unarchive`, ...stepUpRequest(other), payload: {} });
      // this admin has no enrolled method, so the refusal is step_up_unavailable (422) rather than a prompt
      expect(wrong.statusCode).toBeGreaterThanOrEqual(403);
      expect(wrong.json().error).toMatch(/^step_up_/);
      expect(await grantSpent(db, other.grantId)).toBe(false);
      expect((await db.select().from(projects).where(eq(projects.id, id)))[0]!.archivedAt).not.toBeNull();
      expect(await auditsFor(PROJECT_UNARCHIVED_RULE_ID, id)).toHaveLength(0);
    });

    it("unarchive with its step-up restores the project, audited, and calls are attributed again", async () => {
      const g = await grantStepUpForTest(db, adminId, unarchiveStepUp(id));
      const res = await app.inject({ method: "POST", url: `/v1/projects/${id}/unarchive`, ...stepUpRequest(g), payload: {} });
      expect(res.statusCode, res.body).toBe(200);
      expect(await grantSpent(db, g.grantId)).toBe(true);
      const [row] = await db.select().from(projects).where(eq(projects.id, id));
      expect([row!.archivedAt, row!.archivedReason, row!.archivedByUserId]).toEqual([null, null, null]);
      const audits = await auditsFor(PROJECT_UNARCHIVED_RULE_ID, id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.detail).toMatchObject({ archivedReason: REASON, stepUp: "totp" });
      expect((await preDispatchProjectGate(db, id, adminId)).ok).toBe(true);
      const again = await app.inject({ method: "POST", url: `/v1/projects/${id}/unarchive`, headers: adminAuth, payload: {} });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("project_not_archived");
    });
  });
});

// ------------------------------------------------------------------ G10

describe("G10 rename roles and teams (ADR-0206)", () => {
  const createRole = async (name: string) => {
    const res = await app.inject({ method: "POST", url: "/v1/roles", headers: AUTH, payload: { name } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const createTeam = async (name: string) => {
    const res = await app.inject({ method: "POST", url: "/v1/teams", headers: AUTH, payload: { name } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  it("is admin-only", async () => {
    const id = await createRole(`adr0206-member-${RUN}`);
    const res = await app.inject({ method: "PATCH", url: `/v1/roles/${id}`, headers: memberAuth, payload: { name: `x-${RUN}` } });
    expect(res.statusCode).toBe(403);
    expect((await db.select().from(roles).where(eq(roles.id, id)))[0]!.name).toBe(`adr0206-member-${RUN}`);
  });

  it("a plain rename saves with no reason, audited from -> to; a taken name is refused", async () => {
    const id = await createRole(`adr0206-plain-${RUN}`);
    await createRole(`adr0206-taken-${RUN}`);
    const taken = await app.inject({ method: "PATCH", url: `/v1/roles/${id}`, headers: adminAuth, payload: { name: `adr0206-taken-${RUN}` } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("name_taken");
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/roles/${id}`,
      headers: adminAuth,
      payload: { name: `adr0206-renamed-${RUN}`, description: "reads context" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: `adr0206-renamed-${RUN}`, description: "reads context" });
    const audits = await auditsFor(ROLE_RENAMED_RULE_ID, id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ from: `adr0206-plain-${RUN}`, to: `adr0206-renamed-${RUN}` });
  });

  it("a role an access policy and a routing rule match by name is refused, then needs a reason and a step-up", async () => {
    const from = `adr0206-analyst-${RUN}`;
    const to = `adr0206-reviewer-${RUN}`;
    const id = await createRole(from);
    const policyId = await policyNaming("roles", from);
    await policyNaming("roles", `adr0206-unrelated-${RUN}`); // control: a policy naming another role is not listed
    const [tpl] = await db.insert(workflowTemplates).values({ name: `adr0206 tpl ${RUN}`, definition: {} }).returning({ id: workflowTemplates.id });
    templateIds.push(tpl!.id);
    const [rule] = await db
      .insert(workflowAssignmentRules)
      .values({ templateId: tpl!.id, initiatorRole: from })
      .returning({ id: workflowAssignmentRules.id });

    const refused = await app.inject({ method: "PATCH", url: `/v1/roles/${id}`, headers: adminAuth, payload: { name: to } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "role_name_referenced", policyCount: 1, ruleCount: 1 });
    expect(refused.json().policies.map((p: { id: string }) => p.id)).toEqual([policyId]);
    expect(refused.json().rules.map((r: { id: string }) => r.id)).toEqual([rule!.id]);

    const noReason = await app.inject({ method: "PATCH", url: `/v1/roles/${id}`, headers: adminAuth, payload: { name: to, acknowledgeReferences: true } });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().error).toBe("rename_reason_required");

    const body = { name: to, acknowledgeReferences: true, reason: "Aligning names with the new review process." };
    const apiKey = await app.inject({ method: "PATCH", url: `/v1/roles/${id}`, headers: adminAuth, payload: body });
    expect(apiKey.statusCode).toBe(403);
    expect(apiKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });

    // a grant for a different target name is not good for this one, and is not spent
    const wrongGrant = await grantStepUpForTest(db, adminId, renameStepUp("role", id, from, `${to}-other`));
    const wrong = await app.inject({ method: "PATCH", url: `/v1/roles/${id}`, ...stepUpRequest(wrongGrant), payload: body });
    expect(wrong.statusCode).toBeGreaterThanOrEqual(403);
    expect(wrong.json().error).toMatch(/^step_up_/);
    expect(await grantSpent(db, wrongGrant.grantId)).toBe(false);
    expect((await db.select().from(roles).where(eq(roles.id, id)))[0]!.name).toBe(from);
    expect(await auditsFor(ROLE_RENAMED_RULE_ID, id)).toHaveLength(0);

    const g = await grantStepUpForTest(db, adminId, renameStepUp("role", id, from, to));
    const ok = await app.inject({ method: "PATCH", url: `/v1/roles/${id}`, ...stepUpRequest(g), payload: body });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await grantSpent(db, g.grantId)).toBe(true);
    expect((await db.select().from(roles).where(eq(roles.id, id)))[0]!.name).toBe(to);
    const audits = await auditsFor(ROLE_RENAMED_RULE_ID, id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({
      from,
      to,
      referencedPolicies: [policyId],
      referencedRules: [rule!.id],
      reason: body.reason,
      stepUp: "totp",
    });
  });

  it("a policy with no live version still counts on its latest version", async () => {
    const from = `adr0206-draft-${RUN}`;
    const id = await createRole(from);
    const policyId = await policyNaming("roles", from, false);
    const res = await app.inject({ method: "PATCH", url: `/v1/roles/${id}`, headers: adminAuth, payload: { name: `${from}-x` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().policies.map((p: { id: string }) => p.id)).toEqual([policyId]);
  });

  it("teams: a plain rename saves; a referenced one is refused as team_name_referenced and needs the step-up", async () => {
    const plain = await createTeam(`adr0206 team ${RUN}`);
    const ok = await app.inject({ method: "PATCH", url: `/v1/teams/${plain}`, headers: adminAuth, payload: { name: `adr0206 team ${RUN} desk` } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await auditsFor(TEAM_RENAMED_RULE_ID, plain))[0]!.detail).toMatchObject({ to: `adr0206 team ${RUN} desk` });

    const from = `adr0206 credit ${RUN}`;
    const to = `adr0206 credit ops ${RUN}`;
    const id = await createTeam(from);
    const policyId = await policyNaming("teams", from);
    const refused = await app.inject({ method: "PATCH", url: `/v1/teams/${id}`, headers: adminAuth, payload: { name: to } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "team_name_referenced", policyCount: 1, ruleCount: 0 });
    const body = { name: to, acknowledgeReferences: true, reason: "The team took over the service desk queue." };
    const g = await grantStepUpForTest(db, adminId, renameStepUp("team", id, from, to));
    const res = await app.inject({ method: "PATCH", url: `/v1/teams/${id}`, ...stepUpRequest(g), payload: body });
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.select().from(teams).where(eq(teams.id, id)))[0]!.name).toBe(to);
    expect((await auditsFor(TEAM_RENAMED_RULE_ID, id))[0]!.detail).toMatchObject({ referencedPolicies: [policyId], reason: body.reason });
  });

  it("unknown ids are 404", async () => {
    const r = await app.inject({ method: "PATCH", url: `/v1/roles/${randomUUID()}`, headers: adminAuth, payload: { name: "x" } });
    expect(r.json().error).toBe("unknown_role");
    const t = await app.inject({ method: "PATCH", url: `/v1/teams/${randomUUID()}`, headers: adminAuth, payload: { name: "x" } });
    expect(t.json().error).toBe("unknown_team");
  });
});
