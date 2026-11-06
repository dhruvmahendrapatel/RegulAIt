import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, complianceProfiles, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";

/**
 * ADR-0208 (G7, #453 c6509969403): compliance profiles are edited through reviewed versions — a diff, a named
 * reviewer, nothing applied until the reviewer approves — and retired with a step-up, refused while any project,
 * pending project, team or infrastructure resource carries the tag. Shares one DB (fileParallelism off); prefix g7-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g7-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const tag = (s: string) => `g7-${RUN}-${s}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
type Person = { id: string; auth: { authorization: string } };
let author: Person;
let reviewer: Person;
let member: Person;
const restores: Array<() => Promise<void>> = [];

async function makeUser(name: string, isAdmin: boolean): Promise<Person> {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "g7" } });
  expect(k.statusCode).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function createProfile(t: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/compliance/profiles", payload: { tag: t, ...extra } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function listed(t: string) {
  const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/compliance/profiles" });
  expect(r.statusCode).toBe(200);
  return (r.json().profiles as Array<Record<string, any>>).find((p) => p.tag === t)!;
}

const propose = (who: Person, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: who.auth, url: `/v1/compliance/profiles/${id}/versions`, payload });

const decide = (who: Person, approvalId: string, decision: "approved" | "denied", reason?: string) =>
  relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      headers: who.auth,
      url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision, ...(reason ? { reason } : {}) },
    }),
  );

async function lastAudit(objectId: string, ruleId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row;
}

const REASON = "tighten the floor after the quarterly review";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  // admins hold API keys in this suite (mfaRequired off for its run, restored in afterAll); every step-up below is
  // still made in a browser session, which an API key can never stand in for
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  author = await makeUser("g7-author", true);
  reviewer = await makeUser("g7-reviewer", true);
  member = await makeUser("g7-member", false);
});

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("G7 reviewed versions", () => {
  it("lists each profile with its version, status, carriers and pending review", async () => {
    const t = tag("list");
    await createProfile(t, { piiMode: "warn" });
    const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: `${t}-proj` } });
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/projects/${p.json().id}/classifications`, payload: { classifications: [t] } });
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: `${t}-team`, defaultClassifications: [t] } });
    const row = await listed(t);
    expect(row).toMatchObject({ status: "active", version: 1, pendingReview: null, retiredAt: null });
    expect(row.usage).toEqual({ projects: [`${t}-proj`], pendingProjects: [], teams: [`${t}-team`], resources: [] });
  });

  it("a tightening change waits for the named reviewer, then applies; nothing changes before", async () => {
    const t = tag("tighten");
    const id = await createProfile(t, { piiMode: "warn", auditRetentionDays: 30 });
    const r = await propose(author, id, { piiMode: "block", auditRetentionDays: 90, reviewerUserId: reviewer.id, reason: REASON });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ pending: true, version: 2, loosens: [] });
    expect(r.json().changes.map((c: { field: string }) => c.field).sort()).toEqual(["auditRetentionDays", "piiMode"]);
    const approvalId = r.json().approvalId as string;

    // nothing applied yet
    const before = await listed(t);
    expect(before).toMatchObject({ piiMode: "warn", auditRetentionDays: 30, version: 1 });
    expect(before.pendingReview).toMatchObject({ approvalId, version: 2, reviewerUserId: reviewer.id });
    expect(await lastAudit(id, "compliance-profile-version-proposed")).toMatchObject({ effect: "require_approval", reason: REASON });

    // one review at a time
    const again = await propose(author, id, { piiMode: "block", reviewerUserId: reviewer.id, reason: REASON });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "compliance_profile_version_pending", approvalId });

    // the author never approves their own change, even as an admin
    const own = await decide(author, approvalId, "approved", "approving my own change");
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_compliance_profile_change");
    expect((await listed(t)).piiMode).toBe("warn");

    const ok = await decide(reviewer, approvalId, "approved");
    expect(ok.statusCode).toBe(200);
    const after = await listed(t);
    expect(after).toMatchObject({ piiMode: "block", auditRetentionDays: 90, version: 2, pendingReview: null });
    expect(await lastAudit(id, "compliance-profile-version-approved")).toMatchObject({ effect: "allow" });
  });

  it("a denied change leaves the profile as it was", async () => {
    const t = tag("deny");
    const id = await createProfile(t, { piiMode: "warn" });
    const r = await propose(author, id, { piiMode: "block", reviewerUserId: reviewer.id, reason: REASON });
    expect(r.statusCode).toBe(202);
    const d = await decide(reviewer, r.json().approvalId, "denied", "not this quarter");
    expect(d.statusCode).toBe(200);
    expect(await listed(t)).toMatchObject({ piiMode: "warn", version: 1, pendingReview: null });
    expect(await lastAudit(id, "compliance-profile-version-rejected")).toMatchObject({ effect: "deny" });
  });

  it("an approval whose base version moved is recorded stale and applies nothing", async () => {
    const t = tag("stale");
    const id = await createProfile(t, { piiMode: "warn", auditRetentionDays: 10 });
    const r = await propose(author, id, { auditRetentionDays: 60, reviewerUserId: reviewer.id, reason: REASON });
    expect(r.statusCode).toBe(202);
    // an edit through the policy-as-code path moves the active version underneath the review
    const direct = await app.inject({ method: "POST", headers: AUTH, url: "/v1/compliance/profiles", payload: { tag: t, piiMode: "block" } });
    expect(direct.statusCode).toBe(201);
    const ok = await decide(reviewer, r.json().approvalId, "approved");
    expect(ok.statusCode).toBe(200);
    const row = await listed(t);
    expect(row).toMatchObject({ piiMode: "block", auditRetentionDays: 10 });
    expect(await lastAudit(id, "compliance-profile-version-stale")).toMatchObject({ effect: "deny" });
  });

  it("a loosening change needs the author's step-up, bound to the loosened values", async () => {
    const t = tag("loosen");
    const id = await createProfile(t, { piiMode: "block", auditRetentionDays: 90 });
    const payload = { piiMode: "warn", reviewerUserId: reviewer.id, reason: "relax PII handling for the pilot" };
    const viaKey = await propose(author, id, payload);
    expect(viaKey.statusCode).toBeGreaterThanOrEqual(400);
    expect(String(viaKey.json().error)).toMatch(/^step_up/);
    expect((await listed(t)).pendingReview).toBeNull();

    // a grant for other values is refused and not spent
    const wrong = await grantStepUpForTest(db, author.id, { kind: "settings_relax", facts: { ruleId: id, values: { piiMode: "log" } } });
    const refused = await app.inject({ method: "POST", url: `/v1/compliance/profiles/${id}/versions`, payload, ...stepUpRequest(wrong) });
    expect(String(refused.json().error)).toMatch(/^step_up/);
    expect(await grantSpent(db, wrong.grantId)).toBe(false);

    const g = await grantStepUpForTest(db, author.id, { kind: "settings_relax", facts: { ruleId: id, values: { piiMode: "warn" } } });
    const ok = await app.inject({ method: "POST", url: `/v1/compliance/profiles/${id}/versions`, payload, ...stepUpRequest(g) });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().loosens).toEqual(["piiMode"]);
    expect(await grantSpent(db, g.grantId)).toBe(true);
    const applied = await decide(reviewer, ok.json().approvalId, "approved");
    expect(applied.statusCode).toBe(200);
    expect(await listed(t)).toMatchObject({ piiMode: "warn", auditRetentionDays: 90 });
  });

  it("an omitted field keeps its value on both edit paths; an explicit null removes it", async () => {
    const t = tag("keep");
    const id = await createProfile(t, { maxProjectBudgetUsd: 500, redteamMinTrials: 3, piiMode: "warn" });
    // #602's server half: the upsert-by-tag path never clears a floor the body does not name
    const up = await app.inject({ method: "POST", headers: AUTH, url: "/v1/compliance/profiles", payload: { tag: t, piiMode: "block" } });
    expect(up.statusCode).toBe(201);
    expect(await listed(t)).toMatchObject({ piiMode: "block", maxProjectBudgetUsd: 500, redteamMinTrials: 3 });
    const r = await propose(author, id, { redteamMinTrials: 5, reviewerUserId: reviewer.id, reason: REASON });
    expect(r.json().changes).toEqual([{ field: "redteamMinTrials", from: 3, to: 5 }]);
    await decide(reviewer, r.json().approvalId, "approved");
    expect(await listed(t)).toMatchObject({ maxProjectBudgetUsd: 500, redteamMinTrials: 5 });
  });

  it("refuses a self-review, an ineligible reviewer, no change, an unknown template, a bad reason and a non-admin", async () => {
    const t = tag("refuse");
    const id = await createProfile(t, { piiMode: "warn" });
    const self = await propose(author, id, { piiMode: "block", reviewerUserId: author.id, reason: REASON });
    expect(self.statusCode).toBe(422);
    expect(self.json().error).toBe("reviewer_is_author");
    const notAdmin = await propose(author, id, { piiMode: "block", reviewerUserId: member.id, reason: REASON });
    expect(notAdmin.json().error).toBe("reviewer_not_eligible");
    const same = await propose(author, id, { piiMode: "warn", reviewerUserId: reviewer.id, reason: REASON });
    expect(same.json().error).toBe("no_change");
    const tpl = await propose(author, id, {
      requiredTemplateIds: ["00000000-0000-4000-8000-000000000001"],
      reviewerUserId: reviewer.id,
      reason: REASON,
    });
    expect(tpl.json().error).toBe("unknown_template");
    const short = await propose(author, id, { piiMode: "block", reviewerUserId: reviewer.id, reason: "short" });
    expect(short.statusCode).toBe(400);
    const missing = await propose(author, "00000000-0000-4000-8000-0000000000aa", { piiMode: "block", reviewerUserId: reviewer.id, reason: REASON });
    expect(missing.statusCode).toBe(404);
    const nonAdmin = await propose(member, id, { piiMode: "block", reviewerUserId: reviewer.id, reason: REASON });
    expect(nonAdmin.statusCode).toBe(403);
    const nonAdminRetire = await app.inject({
      method: "POST",
      headers: member.auth,
      url: `/v1/compliance/profiles/${id}/retire`,
      payload: { reason: "member tries to retire" },
    });
    expect(nonAdminRetire.statusCode).toBe(403);
  });
});

describe("G7 running work gets the additive changes only", () => {
  it("an approved version that requires a new template appends its stages to an in-flight instance", async () => {
    const mkTpl = async (name: string, stages: unknown[], changeType?: string) => {
      const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/templates", payload: { name, definition: { workflow: name, stages } } });
      expect(r.statusCode).toBe(201);
      if (changeType) {
        await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: r.json().id, changeType } });
      }
      return r.json().id as string;
    };
    const change = `g7-${RUN}-change`;
    await mkTpl(`g7-${RUN}-base`, [{ id: "intake", type: "trigger" }, { id: "gate", type: "human_approval", approvers: [reviewer.id] }], change);
    const secure = await mkTpl(`g7-${RUN}-secure`, [{ id: "intake", type: "trigger" }, { id: "sec-review", type: "human_approval", approvers: [reviewer.id] }]);
    const t = tag("inflight");
    const id = await createProfile(t);
    const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: `${t}-proj` } });
    const projectId = p.json().id as string;
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/classifications`, payload: { classifications: [t] } });
    const started = await app.inject({
      method: "POST",
      headers: member.auth,
      url: "/v1/workflows/instances",
      payload: { projectId, change: { description: "g7", paths: ["x"], changeType: change, environment: "dev" } },
    });
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id as string;
    const stages = async () =>
      ((await app.inject({ method: "GET", headers: AUTH, url: `/v1/workflows/instances/${instanceId}` })).json().instance.definition.stages as Array<{ id: string }>).map((x) => x.id);
    expect(await stages()).toEqual(["intake", "gate"]);

    const r = await propose(author, id, { requiredTemplateIds: [secure], reviewerUserId: reviewer.id, reason: REASON });
    expect(r.statusCode).toBe(202);
    expect(await stages()).toEqual(["intake", "gate"]);
    const ok = await decide(reviewer, r.json().approvalId, "approved");
    expect(ok.statusCode).toBe(200);
    expect(await stages()).toContain("sec-review");
  });
});

describe("G7 retire", () => {
  it("is refused while any project, pending project, team or resource carries the tag", async () => {
    const t = tag("carried");
    const id = await createProfile(t);
    const other = tag("other");
    await createProfile(other);
    // a pending project: already classified, and a reviewed reclassification would add the tag
    const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: `${t}-pending` } });
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/projects/${p.json().id}/classifications`, payload: { classifications: [other] } });
    const re = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/projects/${p.json().id}/classifications`,
      payload: { classifications: [other, t], reviewerUserId: reviewer.id },
    });
    expect(re.statusCode).toBe(202);
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/infra/resources",
      payload: { kind: "control_plane", name: `${t}-res`, classifications: [t] },
    });
    expect(res.statusCode).toBe(201);
    const r = await app.inject({ method: "POST", headers: AUTH, url: `/v1/compliance/profiles/${id}/retire`, payload: { reason: "framework replaced" } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      error: "compliance_profile_in_use",
      projects: [],
      pendingProjects: [`${t}-pending`],
      teams: [],
      resources: [`${t}-res`],
    });
    expect((await listed(t)).status).toBe("active");
  });

  it("needs a step-up, is audited, keeps the audit-retention floor, and makes the profile read-only", async () => {
    const t = tag("retire");
    const id = await createProfile(t, { auditRetentionDays: 4000 });
    const payload = { reason: "framework withdrawn by the regulator" };
    const viaKey = await app.inject({ method: "POST", headers: author.auth, url: `/v1/compliance/profiles/${id}/retire`, payload });
    expect(String(viaKey.json().error)).toMatch(/^step_up/);
    const noGrant = await grantStepUpForTest(db, author.id, { kind: "settings_relax", facts: { ruleId: id, values: { status: "active" } } });
    const refused = await app.inject({ method: "POST", url: `/v1/compliance/profiles/${id}/retire`, payload, ...sessionRequest(noGrant) });
    expect(String(refused.json().error)).toMatch(/^step_up/);

    const g = await grantStepUpForTest(db, author.id, { kind: "settings_relax", facts: { ruleId: id, values: { status: "retired" } } });
    const ok = await app.inject({ method: "POST", url: `/v1/compliance/profiles/${id}/retire`, payload, ...stepUpRequest(g) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "retired", retiredReason: payload.reason, retiredByUserId: author.id });
    expect(await lastAudit(id, "compliance-profile-retired")).toMatchObject({ reason: payload.reason, userId: author.id });
    const [row] = await db.select().from(complianceProfiles).where(eq(complianceProfiles.id, id));
    expect(row!.retiredAt).not.toBeNull();

    // the audit-retention floor it set still counts
    const floor = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit/retention" });
    expect(floor.json().retainedDays).toBeGreaterThanOrEqual(4000);

    // read-only, and no new carrier
    const twice = await app.inject({ method: "POST", url: `/v1/compliance/profiles/${id}/retire`, payload, ...stepUpRequest(g) });
    expect(twice.json().error).toBe("compliance_profile_already_retired");
    const upsert = await app.inject({ method: "POST", headers: AUTH, url: "/v1/compliance/profiles", payload: { tag: t, piiMode: "block" } });
    expect(upsert.statusCode).toBe(409);
    expect(upsert.json().error).toBe("compliance_profile_retired");
    const version = await propose(author, id, { piiMode: "warn", reviewerUserId: reviewer.id, reason: REASON });
    expect(version.json().error).toBe("compliance_profile_retired");
    const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: `${t}-late` } });
    const classify = await app.inject({ method: "POST", headers: AUTH, url: `/v1/projects/${p.json().id}/classifications`, payload: { classifications: [t] } });
    expect(classify.statusCode).toBe(409);
    expect(classify.json()).toMatchObject({ error: "compliance_profile_retired", tags: [t] });
    const team = await app.inject({ method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: `${t}-team`, defaultClassifications: [t] } });
    expect(team.json().error).toBe("compliance_profile_retired");
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/infra/resources",
      payload: { kind: "control_plane", name: `${t}-res`, classifications: [t] },
    });
    expect(res.json().error).toBe("compliance_profile_retired");
    const listedRow = await listed(t);
    expect(listedRow).toMatchObject({ status: "retired", retiredReason: payload.reason });
  });

  it("is refused while a version waits for review", async () => {
    const t = tag("pending-retire");
    const id = await createProfile(t, { piiMode: "warn" });
    const r = await propose(author, id, { piiMode: "block", reviewerUserId: reviewer.id, reason: REASON });
    const retire = await app.inject({ method: "POST", headers: AUTH, url: `/v1/compliance/profiles/${id}/retire`, payload: { reason: "retire it anyway now" } });
    expect(retire.statusCode).toBe(409);
    expect(retire.json()).toMatchObject({ error: "compliance_profile_version_pending", approvalId: r.json().approvalId });
  });
});
