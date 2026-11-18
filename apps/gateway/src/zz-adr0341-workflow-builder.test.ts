/**
 * ADR-0341 — the visual pipeline builder's server side, on a real database through the real app:
 *
 *  - admin only (a non-admin session is refused on every builder route);
 *  - opening a draft records the live definition as version 1 (baseline) under the template lock, once;
 *  - round trip: the draft holds the template's definition byte for byte (canonical JSON) and a save stores exactly
 *    what was sent;
 *  - validation on every save: schema, unknown fields, the forced plan gate, the governed deploy tail;
 *  - optimistic concurrency on save and publish; a stale draft is refused;
 *  - publish: refused while invalid, refused for an unaccepted relaxation, refused without the exact step-up (a grant
 *    for other facts is not spent), then version 2, the live definition replaced, the draft gone, one audit row;
 *  - history and diff; restore from an older version; retired and intake templates refused;
 *  - the versions table is append-only (UPDATE, DELETE and TRUNCATE refused).
 *
 * Global state (M-068): the step-up posture and MFA relaxation are put back in afterAll. Fixtures are `wb-<run>`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  users,
  workflowTemplateDrafts,
  workflowTemplates,
  workflowTemplateVersions,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, canonicalJson, sha256Hex } from "@regulait/shared";
import { buildApp } from "./app.js";
import { BUILDER_RULE_IDS, PUBLISH_STEP_UP_OP } from "./workflow-builder.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `wb-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}`, "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let memberId: string;
let templateId: string;
const restores: Array<() => Promise<void>> = [];

type Stage = { id: string; type: string } & Record<string, unknown>;
const standard = (): { workflow: string; stages: Stage[] } => ({
  workflow: `wb-${RUN}`,
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "req", type: "artifact_generation", output: "requirements" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
    { id: "build", type: "automated_build", scope: "requirements" },
    { id: "checks", type: "automated_check", checks: ["unit", "lint"] },
  ],
});
const hashOf = (v: unknown) => sha256Hex(canonicalJson(v));
const base = (id = templateId) => `/v1/workflows/builder/templates/${id}`;
const inject = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: AUTH, ...(payload ? { payload } : {}) });

async function newTemplate(name: string, definition: object = standard()): Promise<string> {
  const r = await inject("POST", "/v1/workflows/templates", { name, definition });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

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
  const a = await inject("POST", "/v1/users", { email: `wb-admin-${RUN}@example.com`, displayName: "wb admin" });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const m = await inject("POST", "/v1/users", { email: `wb-member-${RUN}@example.com`, displayName: "wb member" });
  memberId = m.json().id as string;
  templateId = await newTemplate(`wb-${RUN}-standard`);
}, 120_000);

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0341 the workflow template builder API", () => {
  it("is admin only: a member's session is refused on every builder route", async () => {
    const g = await grantStepUpForTest(db, memberId, { kind: "settings_relax", facts: {} });
    const asMember = sessionRequest(g);
    for (const [method, url] of [
      ["GET", "/v1/workflows/builder/templates"],
      ["POST", `${base()}/draft`],
      ["GET", `${base()}/draft`],
      ["POST", "/v1/workflows/builder/validate"],
      ["POST", `${base()}/publish`],
      ["GET", `${base()}/versions`],
    ] as const) {
      const r = await app.inject({ method, url, ...asMember, payload: {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("opens a draft: the live definition becomes version 1 once, and the draft is that definition exactly", async () => {
    const r = await inject("POST", `${base()}/draft`, {});
    expect(r.statusCode, r.body).toBe(201);
    const view = r.json();
    const [live] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
    expect(canonicalJson(view.draft.definition)).toBe(canonicalJson(live!.definition));
    expect(view).toMatchObject({ liveVersion: 1, stale: false, draft: { revision: 1, baseVersion: 1 }, validation: { valid: true, issues: [] } });
    expect(view.validation.contentHash).toBe(hashOf(live!.definition));
    expect(view.diff).toMatchObject({ patch: [], relaxations: [], stages: { added: [], removed: [], changed: [], moved: [] } });
    const versions = await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.templateId, templateId));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, origin: "baseline", contentHash: hashOf(live!.definition) });
    const again = await inject("POST", `${base()}/draft`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "draft_exists", revision: 1 });
    expect(await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.templateId, templateId))).toHaveLength(1);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.objectId, templateId), eq(auditLog.objectType, "workflow_template")));
    expect(audits.map((x) => x.ruleId).sort()).toEqual([BUILDER_RULE_IDS.draftOpened, BUILDER_RULE_IDS.baseline].sort());
  });

  it("saves exactly what was sent, validates every save, and refuses a stale revision", async () => {
    const noPlan = { ...standard(), stages: standard().stages.filter((s) => s.type !== "planning") };
    const saved = await inject("PUT", `${base()}/draft`, { revision: 1, definition: noPlan });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().draft.revision).toBe(2);
    expect(canonicalJson(saved.json().draft.definition)).toBe(canonicalJson(noPlan));
    expect(saved.json().validation.valid).toBe(false);
    expect(saved.json().validation.issues).toEqual([expect.objectContaining({ code: "plan_gate_missing", stageId: "build" })]);
    expect(saved.json().diff.stages.removed).toEqual(["plan"]);

    const stale = await inject("PUT", `${base()}/draft`, { revision: 1, definition: standard() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "draft_revision_conflict", revision: 2 });

    const unknown = await inject("PUT", `${base()}/draft`, {
      revision: 2,
      definition: { ...standard(), stages: standard().stages.map((s) => (s.id === "checks" ? { ...s, colour: "red" } : s)) },
    });
    expect(unknown.json().validation.issues).toEqual([expect.objectContaining({ code: "unknown_field", stageId: "checks", path: ["stages", 5, "colour"] })]);

    const huge = await inject("PUT", `${base()}/draft`, { revision: 3, definition: { ...standard(), pad: "x".repeat(300_000) } });
    expect(huge.statusCode).toBe(413);
  });

  it("validates without storing: schema, the governed deploy tail, and the content hash of the parsed definition", async () => {
    const deploy = {
      workflow: "d",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "plan", type: "planning" },
        { id: "ship", type: "deployment", connection: "t" },
      ],
    };
    const r = await inject("POST", "/v1/workflows/builder/validate", { definition: deploy });
    expect(r.json().issues.map((i: { code: string }) => i.code)).toEqual(["deploy_without_signoff", "deploy_without_checks"]);
    const bad = await inject("POST", "/v1/workflows/builder/validate", { definition: { workflow: "x", stages: [{ id: "a", type: "nope" }] } });
    expect(bad.json()).toMatchObject({ valid: false, issues: [expect.objectContaining({ code: "schema", stageId: "a" })] });
    const ok = await inject("POST", "/v1/workflows/builder/validate", { definition: standard() });
    expect(ok.json()).toMatchObject({ valid: true, contentHash: hashOf(standard()) });
  });

  it("publishes only a valid, accepted, stepped-up draft, then records version 2 and replaces the live definition", async () => {
    // invalid: refused before any step-up
    let r = await inject("PUT", `${base()}/draft`, { revision: 3, definition: { ...standard(), stages: standard().stages.filter((s) => s.type !== "planning") } });
    expect(r.json().draft.revision).toBe(4);
    r = await inject("POST", `${base()}/publish`, { revision: 4 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("draft_invalid");

    // a relaxation (quorum all -> any) must be accepted with a reason
    const relaxed = standard();
    relaxed.stages[3] = { ...relaxed.stages[3]!, quorum: "any" };
    relaxed.stages.push({ id: "e2e", type: "automated_check", checks: ["e2e"] });
    r = await inject("PUT", `${base()}/draft`, { revision: 4, definition: relaxed });
    expect(r.json().validation.valid, r.body).toBe(true);
    const hash = r.json().validation.contentHash as string;
    r = await inject("POST", `${base()}/publish`, { revision: 5 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "relaxation_not_accepted", relaxations: [expect.objectContaining({ code: "quorum_relaxed", stageId: "signoff" })] });

    const accepted = { revision: 5, acceptRelaxations: true, reason: "one approver is enough for this low-risk flow" };
    // the admin's session with no grant: a step-up is asked for, nothing published
    const wrong = await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { op: PUBLISH_STEP_UP_OP, templateId, fromVersion: 1, contentHash: "0".repeat(64) } });
    r = await app.inject({ method: "POST", url: `${base()}/publish`, ...sessionRequest(wrong), payload: accepted });
    expect([403, 422], r.body).toContain(r.statusCode);
    // a grant for other facts is refused and not spent
    r = await app.inject({ method: "POST", url: `${base()}/publish`, ...stepUpRequest(wrong), payload: accepted });
    expect([403, 422], r.body).toContain(r.statusCode);
    expect(await grantSpent(db, wrong.grantId)).toBe(false);
    expect((await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.templateId, templateId))).length).toBe(1);

    const right = await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { op: PUBLISH_STEP_UP_OP, templateId, fromVersion: 1, contentHash: hash } });
    r = await app.inject({ method: "POST", url: `${base()}/publish`, ...stepUpRequest(right), payload: accepted });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().version).toMatchObject({ version: 2, contentHash: hash, origin: "builder" });
    expect(await grantSpent(db, right.grantId)).toBe(true);

    const [live] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
    expect(canonicalJson(live!.definition)).toBe(canonicalJson(relaxed));
    expect(await db.select().from(workflowTemplateDrafts).where(eq(workflowTemplateDrafts.templateId, templateId))).toHaveLength(0);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, BUILDER_RULE_IDS.published)).orderBy(desc(auditLog.seq)).limit(1);
    expect(row).toMatchObject({ userId: adminId, objectId: templateId, effect: "allow" });
    expect(row!.detail).toMatchObject({
      version: 2,
      fromVersion: 1,
      contentHash: hash,
      stepUp: "totp",
      stepUpKind: "settings_relax",
      relaxationReason: accepted.reason,
      stages: { added: ["e2e"], changed: ["signoff"] },
    });
    // the same grant never publishes twice (and there is no draft any more)
    r = await app.inject({ method: "POST", url: `${base()}/publish`, ...stepUpRequest(right), payload: accepted });
    expect(r.statusCode).toBe(404);
  });

  it("lists history newest first, diffs an old version against live, and restores it as a new draft", async () => {
    const h = await inject("GET", `${base()}/versions`);
    expect(h.statusCode).toBe(200);
    expect(h.json()).toMatchObject({ liveVersion: 2, nextBefore: null });
    expect(h.json().items.map((v: { version: number; origin: string; live: boolean }) => [v.version, v.origin, v.live])).toEqual([
      [2, "builder", true],
      [1, "baseline", false],
    ]);
    const v1 = await inject("GET", `${base()}/versions/1`);
    expect(v1.json().diff.stages).toMatchObject({ removed: ["e2e"], changed: ["signoff"] });
    expect(v1.json().diff.patch.length).toBeGreaterThan(0);
    expect((await inject("GET", `${base()}/versions/9`)).statusCode).toBe(404);

    const restore = await inject("POST", `${base()}/draft`, { fromVersion: 1 });
    expect(restore.statusCode, restore.body).toBe(201);
    expect(canonicalJson(restore.json().draft.definition)).toBe(canonicalJson(standard()));
    expect(restore.json().draft).toMatchObject({ baseVersion: 2, revision: 1 });

    const list = await inject("GET", "/v1/workflows/builder/templates?limit=100");
    const mine = list.json().items.find((t: { id: string }) => t.id === templateId);
    expect(mine).toMatchObject({ liveVersion: 2, editable: true, draft: { revision: 1 }, stageCount: 7 });
  });

  it("refuses a publish when the template moved on since the draft was opened", async () => {
    // only reachable if a version is written beside the builder; the check must still hold
    const [t] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
    await db.insert(workflowTemplateVersions).values({ templateId, version: 3, definition: t!.definition, contentHash: hashOf(t!.definition), origin: "builder" });
    const r = await inject("POST", `${base()}/publish`, { revision: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "draft_stale", liveVersion: 3 });
    expect((await inject("GET", `${base()}/draft`)).json().stale).toBe(true);
    const gone = await inject("DELETE", `${base()}/draft`);
    expect(gone.statusCode).toBe(204);
    expect((await inject("DELETE", `${base()}/draft`)).statusCode).toBe(404);
  });

  it("refuses a retired template and an intake template", async () => {
    const retired = await newTemplate(`wb-${RUN}-retired`);
    const rr = await inject("POST", `/v1/workflows/templates/${retired}/retire`, { reason: "replaced" });
    expect(rr.statusCode, rr.body).toBe(200);
    expect((await inject("POST", `${base(retired)}/draft`, {})).json()).toMatchObject({ error: "template_retired" });
    const [intake] = await db
      .insert(workflowTemplates)
      .values({ name: `ai-use-case-intake/wb-${RUN}`, definition: standard() })
      .returning({ id: workflowTemplates.id });
    const r = await inject("POST", `${base(intake!.id)}/draft`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("intake_template_not_editable");
    await db.delete(workflowTemplates).where(eq(workflowTemplates.id, intake!.id));
  });

  it("keeps versions append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    await expect(db.execute(sql`update workflow_template_versions set version = version where template_id = ${templateId}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from workflow_template_versions where template_id = ${templateId}`)).rejects.toThrow();
    await expect(db.execute(sql`truncate workflow_template_versions`)).rejects.toThrow();
    // deleting the template itself cascades (the parent is gone)
    const doomed = await newTemplate(`wb-${RUN}-doomed`);
    expect((await inject("POST", `${base(doomed)}/draft`, {})).statusCode).toBe(201);
    await db.delete(workflowTemplates).where(eq(workflowTemplates.id, doomed));
    expect(await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.templateId, doomed))).toHaveLength(0);
  });
});
