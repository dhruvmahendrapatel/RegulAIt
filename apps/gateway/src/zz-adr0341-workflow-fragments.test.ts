/**
 * ADR-0341 follow-up (Camunda gap row 10) — the sub-process catalogue, on a real database through the real app:
 *
 *  - admin only; a proposal needs a named administrator and an eligible reviewer who is not its author;
 *  - a proposed version is pending: not listed in the catalogue or the gallery, and not callable from a draft;
 *  - its proposer cannot approve it (even by admin override); the named reviewer can, and then it is listed;
 *  - a draft that calls the approved version expands into its stages (the plan gate is met by the sub-process),
 *    publishes with the pin recorded, and reopens with the call stage as written;
 *  - a new version needs its own approval and does not move a template's pin; one pending version at a time;
 *  - versions and pins are append-only.
 *
 * Global state (M-068): the step-up posture and MFA relaxation are put back in afterAll. Fixtures are `wf-<run>`.
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
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  workflowFragmentVersions,
  workflowTemplates,
  workflowTemplateVersionFragments,
  workflowTemplateVersions,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { PUBLISH_STEP_UP_OP } from "./workflow-builder.js";
import { FRAGMENT_RULE_IDS } from "./workflow-fragments.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `wf-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}`, "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
type Person = { id: string; auth: { authorization: string } };
let author: Person;
let reviewer: Person;
let member: Person;
let fragmentId: string;
let templateId: string;
const restores: Array<() => Promise<void>> = [];

const review = [
  { id: "plan", type: "planning" },
  { id: "req", type: "artifact_generation", output: "requirements" },
  { id: "sign-off", type: "human_approval", approvers: ["requesting_user"] },
];
const draftCalling = (version: number) => ({
  workflow: `wf-${RUN}`,
  stages: [
    { id: "intake", type: "trigger" },
    { id: "review", type: "call", fragment: fragmentId, version },
    { id: "build", type: "automated_build", scope: "requirements" },
    { id: "checks", type: "automated_check", checks: ["unit"] },
  ],
});

async function makeUser(name: string, isAdmin: boolean): Promise<Person> {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin } });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "wf" } });
  expect(k.statusCode, k.body).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}
const as = (who: Person | null, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  app.inject({ method, url, headers: who ? { ...who.auth, "x-regulait-csrf": "1" } : AUTH, ...(payload ? { payload } : {}) });
const decide = (who: Person, approvalId: string, decision: "approved" | "denied", reason?: string) =>
  relaxStepUpAround(db, () =>
    app.inject({ method: "POST", headers: who.auth, url: `/v1/approvals/${approvalId}/decide`, payload: { decision, ...(reason ? { reason } : {}) } }),
  );
const catalogueNames = async () => ((await as(author, "GET", "/v1/workflows/fragments")).json().items as Array<{ name: string }>).map((i) => i.name);
const galleryNames = async () => ((await as(null, "GET", "/v1/workflows/template-gallery")).json().fragments as Array<{ name: string }>).map((i) => i.name);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT });
  author = await makeUser("wf-author", true);
  reviewer = await makeUser("wf-reviewer", true);
  member = await makeUser("wf-member", false);
}, 120_000);

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0341 follow-up: the sub-process catalogue", () => {
  it("is admin only, and a proposal needs a named author and an eligible reviewer who is not the author", async () => {
    for (const [method, url] of [
      ["GET", "/v1/workflows/fragments"],
      ["POST", "/v1/workflows/fragments"],
    ] as const) {
      const r = await as(member, method, url, {});
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    const body = { name: `wf-${RUN}-review`, stages: review, reviewerUserId: reviewer.id };
    expect((await as(null, "POST", "/v1/workflows/fragments", body)).json()).toMatchObject({ error: "identity_required" });
    expect((await as(author, "POST", "/v1/workflows/fragments", { ...body, reviewerUserId: author.id })).json()).toMatchObject({ error: "reviewer_is_author" });
    expect((await as(author, "POST", "/v1/workflows/fragments", { ...body, reviewerUserId: member.id })).json()).toMatchObject({ error: "reviewer_not_eligible" });
    const bad = await as(author, "POST", "/v1/workflows/fragments", { ...body, stages: [{ id: "t", type: "trigger" }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues).toEqual([expect.objectContaining({ code: "fragment_trigger" })]);
  });

  it("files a proposal as pending: not listed, not in the gallery, not callable", async () => {
    const r = await as(author, "POST", "/v1/workflows/fragments", { name: `wf-${RUN}-review`, description: "plan, requirements, sign-off", stages: review, reviewerUserId: reviewer.id });
    expect(r.statusCode, r.body).toBe(201);
    fragmentId = r.json().fragment.id;
    expect(r.json().version).toMatchObject({ version: 1, state: "pending_approval" });
    const [a] = await db.select().from(approvals).where(eq(approvals.id, r.json().version.approvalId));
    expect(a).toMatchObject({ objectType: "workflow_fragment", status: "pending", approverUserId: reviewer.id, userId: author.id });
    expect(await catalogueNames()).not.toContain(`wf-${RUN}-review`);
    expect(await galleryNames()).not.toContain(`wf-${RUN}-review`);
    const all = (await as(author, "GET", "/v1/workflows/fragments?include=all&limit=100")).json().items as Array<Record<string, unknown>>;
    expect(all.find((i) => i.id === fragmentId)).toMatchObject({ version: null, latest: { version: 1, state: "pending_approval" } });
    expect((await as(author, "POST", "/v1/workflows/fragments", { name: `WF-${RUN}-REVIEW`, stages: review, reviewerUserId: reviewer.id })).json()).toMatchObject({ error: "fragment_name_taken" });

    const t = await as(null, "POST", "/v1/workflows/templates", { name: `wf-${RUN}-caller`, definition: { workflow: `wf-${RUN}`, stages: [{ id: "intake", type: "trigger" }, { id: "plan", type: "planning" }] } });
    expect(t.statusCode, t.body).toBe(201);
    templateId = t.json().id;
    const v = await as(null, "POST", "/v1/workflows/builder/validate", { definition: draftCalling(1) });
    expect(v.json()).toMatchObject({ valid: false, issues: [expect.objectContaining({ code: "call_unresolved", stageId: "review" })] });
  });

  it("refuses the proposer's own approval, then lists the version once the reviewer approves it", async () => {
    const [v1] = await db.select().from(workflowFragmentVersions).where(eq(workflowFragmentVersions.fragmentId, fragmentId));
    const own = await decide(author, v1!.approvalId!, "approved", "admin override of my own change");
    expect(own.statusCode, own.body).toBe(403);
    expect(own.json()).toMatchObject({ error: "cannot_approve_own_fragment_version" });
    const ok = await decide(reviewer, v1!.approvalId!, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await catalogueNames()).toContain(`wf-${RUN}-review`);
    expect(await galleryNames()).toContain(`wf-${RUN}-review`);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, fragmentId), eq(auditLog.ruleId, FRAGMENT_RULE_IDS.approved)));
    expect(audit).toMatchObject({ userId: reviewer.id, objectType: "workflow_fragment", effect: "allow" });
    const detail = await as(author, "GET", `/v1/workflows/fragments/${fragmentId}`);
    expect(detail.json().versions).toEqual([expect.objectContaining({ version: 1, state: "approved", stageCount: 3 })]);
    const one = await as(author, "GET", `/v1/workflows/fragments/${fragmentId}/versions/1`);
    expect(one.json().version).toMatchObject({ state: "approved", stages: review });
  });

  it("expands a call to the approved version, publishes with the pin recorded, and reopens with the call as written", async () => {
    // the template's own planning stage is gone: the sub-process's planning stage meets the plan gate
    const v = await as(null, "POST", "/v1/workflows/builder/validate", { definition: draftCalling(1) });
    expect(v.json(), v.body).toMatchObject({ valid: true, issues: [] });
    const extra = { ...draftCalling(1), stages: draftCalling(1).stages.map((s) => (s.id === "review" ? { ...s, approvers: ["x"] } : s)) };
    expect((await as(null, "POST", "/v1/workflows/builder/validate", { definition: extra })).json().issues).toEqual([
      expect.objectContaining({ code: "call_schema", stageId: "review" }),
    ]);

    let r = await as(null, "POST", `/v1/workflows/builder/templates/${templateId}/draft`, {});
    expect(r.statusCode, r.body).toBe(201);
    r = await as(null, "PUT", `/v1/workflows/builder/templates/${templateId}/draft`, { revision: 1, definition: draftCalling(1) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().draft.definition).toEqual(draftCalling(1));
    const hash = r.json().validation.contentHash as string;
    expect(r.json().diff.stages.added).toEqual(expect.arrayContaining(["review.plan", "review.req", "review.sign-off", "build", "checks"]));

    const g = await grantStepUpForTest(db, author.id, { kind: "settings_relax", facts: { op: PUBLISH_STEP_UP_OP, templateId, fromVersion: 1, contentHash: hash } });
    r = await app.inject({ method: "POST", url: `/v1/workflows/builder/templates/${templateId}/publish`, ...stepUpRequest(g), payload: { revision: 2 } });
    // the template's own `plan` stage is gone (its gate now comes from the sub-process): reported as a relaxation, so
    // the publish needs it accepted with a reason, like any other
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().relaxations).toEqual([expect.objectContaining({ code: "gate_stage_removed", stageId: "plan" })]);
    r = await app.inject({
      method: "POST",
      url: `/v1/workflows/builder/templates/${templateId}/publish`,
      ...stepUpRequest(g),
      payload: { revision: 2, acceptRelaxations: true, reason: "the plan gate moves into the review sub-process" },
    });
    expect(r.statusCode, r.body).toBe(201);

    const [live] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
    expect((live!.definition as { stages: Array<{ id: string }> }).stages.map((s) => s.id)).toEqual(["intake", "review.plan", "review.req", "review.sign-off", "build", "checks"]);
    const [v2] = await db.select().from(workflowTemplateVersions).where(and(eq(workflowTemplateVersions.templateId, templateId), eq(workflowTemplateVersions.version, 2)));
    const pins = await db.select().from(workflowTemplateVersionFragments).where(eq(workflowTemplateVersionFragments.templateVersionId, v2!.id));
    const [fv1] = await db.select().from(workflowFragmentVersions).where(and(eq(workflowFragmentVersions.fragmentId, fragmentId), eq(workflowFragmentVersions.version, 1)));
    expect(pins).toEqual([{ templateVersionId: v2!.id, callStageId: "review", fragmentVersionId: fv1!.id }]);

    r = await as(null, "POST", `/v1/workflows/builder/templates/${templateId}/draft`, {});
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().draft.definition).toEqual(draftCalling(1));
    expect(r.json().validation.valid).toBe(true);
    expect(r.json().diff.patch).toEqual([]);
  });

  it("needs a new approval for a new version, keeps the template's pin, and allows one pending version at a time", async () => {
    const same = await as(author, "POST", `/v1/workflows/fragments/${fragmentId}/versions`, { stages: review, reviewerUserId: reviewer.id });
    expect(same.json()).toMatchObject({ error: "no_change" });
    const changed = [...review, { id: "checks", type: "automated_check", checks: ["policy"] }];
    const r = await as(author, "POST", `/v1/workflows/fragments/${fragmentId}/versions`, { stages: changed, reviewerUserId: reviewer.id });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().version).toMatchObject({ version: 2, state: "pending_approval" });
    const again = await as(author, "POST", `/v1/workflows/fragments/${fragmentId}/versions`, { stages: [...changed, { id: "x", type: "planning" }], reviewerUserId: reviewer.id });
    expect(again.json()).toMatchObject({ error: "fragment_version_pending" });
    // v2 is not callable yet; the catalogue still offers v1; the live template is unchanged
    expect((await as(null, "POST", "/v1/workflows/builder/validate", { definition: draftCalling(2) })).json().issues[0]).toMatchObject({ code: "call_unresolved" });
    const items = (await as(author, "GET", "/v1/workflows/fragments")).json().items as Array<{ id: string; version: number }>;
    expect(items.find((i) => i.id === fragmentId)?.version).toBe(1);
    const denied = await decide(reviewer, r.json().version.approvalId, "denied", "the policy check is not ready");
    expect(denied.statusCode, denied.body).toBe(200);
    const detail = (await as(author, "GET", `/v1/workflows/fragments/${fragmentId}`)).json().versions as Array<{ version: number; state: string }>;
    expect(detail.map((d) => [d.version, d.state])).toEqual([
      [2, "rejected"],
      [1, "approved"],
    ]);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, fragmentId), eq(auditLog.ruleId, FRAGMENT_RULE_IDS.rejected))).orderBy(desc(auditLog.seq));
    expect(audit).toMatchObject({ effect: "deny" });
  });

  it("keeps versions and pins append-only", async () => {
    await expect(db.execute(sql`update workflow_fragment_versions set content_hash = ${"0".repeat(64)} where fragment_id = ${fragmentId}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from workflow_fragment_versions where fragment_id = ${fragmentId}`)).rejects.toThrow();
    await expect(db.execute(sql`truncate workflow_template_version_fragments`)).rejects.toThrow();
    await expect(db.execute(sql`delete from workflow_template_version_fragments where call_stage_id = 'review'`)).rejects.toThrow();
  });
});
