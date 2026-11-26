/**
 * ADR-0357 slice 1c: apply writes MCP bundles and workflow templates through their own versioned stores.
 *
 *  - bundles: off by default, so a widening bundle change is a plan issue until the org setting is on (archiving
 *    stays allowed); a create writes the bundle, version 1 and its items; a change of tools is a NEW version; a
 *    grant's tier moves in place; a grant removed is deleted; a bundle missing from the file is archived;
 *  - templates: a create goes through the create path's own validation; a definition change records the baseline
 *    and a new version with origin `governance_apply`; a template missing from the file is retired (ADR-0022);
 *  - refusals the file cannot decide: un-archive, un-retire, an intake template, a dangerous tier with no approver.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asc,
  createDb,
  eq,
  mcpBundleGrants,
  mcpBundles,
  mcpBundleVersions,
  mcpServers,
  mcpTools,
  ORG_SETTINGS_ID,
  orgSettings,
  roles,
  runMigrations,
  users,
  workflowTemplates,
  workflowTemplateVersions,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, GOVERNANCE_CONFIG_API_VERSION } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `gb-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const n = (s: string) => `gb-${s}-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let approverId: string;
let serverId: string;
const restores: Array<() => Promise<void>> = [];

const definition = (extra: Record<string, unknown> = {}) => ({
  workflow: n("wf"),
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "req", type: "artifact_generation", output: "requirements" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
    { id: "build", type: "automated_build", scope: "requirements" },
    { id: "checks", type: "automated_check", checks: ["unit", "lint"] },
  ],
  ...extra,
});

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db
    .select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions, bundles: orgSettings.mcpBundlesEnabled })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db
    .update(orgSettings)
    .set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions], mcpBundlesEnabled: false })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db
      .update(orgSettings)
      .set({ stepUpMode: before!.mode, stepUpActions: before!.actions, mcpBundlesEnabled: before!.bundles })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();
  const [a] = await db.insert(users).values({ email: `${n("admin")}@example.test`, displayName: "admin", isAdmin: true }).returning({ id: users.id });
  adminId = a!.id;
  const [u] = await db.insert(users).values({ email: `${n("approver")}@example.test`, displayName: "approver" }).returning({ id: users.id });
  approverId = u!.id;
  const [s] = await db.insert(mcpServers).values({ name: n("server"), url: "https://mcp.example.test/" }).returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.insert(mcpTools).values([
    { serverId, name: "read_issue", kind: "read" },
    { serverId, name: "close_issue", kind: "write" },
  ]);
  await db.insert(roles).values({ name: n("eng") });
}, 120_000);

afterAll(async () => {
  for (const restore of restores.reverse()) await restore();
  await db.delete(mcpBundles).where(eq(mcpBundles.name, n("bundle")));
  await db.delete(workflowTemplates).where(eq(workflowTemplates.name, n("tpl")));
  await db.delete(roles).where(eq(roles.name, n("eng")));
  await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await app.close();
});

const doc = (spec: Record<string, unknown>) => ({ apiVersion: GOVERNANCE_CONFIG_API_VERSION, kind: "GovernanceConfig", spec });
async function live() {
  const r = await app.inject({ method: "GET", url: "/v1/governance-config/export?format=json", headers: AUTH });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().spec as { mcpBundles: Array<Record<string, unknown>>; workflowTemplates: Array<Record<string, unknown>> };
}
async function planOf(document: unknown) {
  const r = await app.inject({ method: "POST", url: "/v1/governance-config/plan", headers: AUTH, payload: { document } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
/** plan, then apply with exactly the plan's step-up */
async function planAndApply(document: unknown) {
  const plan = await planOf(document);
  expect(plan.issues, JSON.stringify(plan.issues)).toEqual([]);
  const g = await grantStepUpForTest(db, adminId, {
    kind: "settings_relax",
    facts: { op: "governance_config_apply", planHash: plan.plan.planHash, widenings: plan.widenings },
  });
  const r = await app.inject({ method: "POST", url: "/v1/governance-config/apply", ...stepUpRequest(g), payload: { document, planHash: plan.plan.planHash } });
  return { plan, r };
}
const others = async () => {
  const l = await live();
  return { bundles: l.mcpBundles.filter((b) => b.name !== n("bundle")), templates: l.workflowTemplates.filter((t) => t.name !== n("tpl")) };
};
const bundleDoc = async (bundle: Record<string, unknown> | null) => {
  const o = await others();
  return doc({ mcpBundles: [...o.bundles, ...(bundle ? [{ name: n("bundle"), ...bundle }] : [])] });
};
const bundleRow = async () => (await db.select().from(mcpBundles).where(eq(mcpBundles.name, n("bundle"))))[0];

describe("MCP bundles", () => {
  it("while bundles are off, creating one is a plan issue", async () => {
    const plan = await planOf(await bundleDoc({ items: [{ server: n("server"), tool: "read_issue" }] }));
    expect(plan.issues).toContainEqual(expect.objectContaining({ section: "mcpBundles", code: "mcp_bundles_disabled" }));
    await db.update(orgSettings).set({ mcpBundlesEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  it("a dangerous tier with no approver, and a bad name, are plan issues", async () => {
    const plan = await planOf(await bundleDoc({ grants: [{ role: n("eng"), maxTier: "dangerous" }] }));
    expect(plan.issues.map((i: { code: string }) => i.code)).toContain("approver_required");
    const o = await others();
    const bad = await planOf(doc({ mcpBundles: [...o.bundles, { name: "Not A Name" }] }));
    expect(bad.issues.map((i: { code: string }) => i.code)).toContain("invalid_bundle_name");
  });

  it("create: the bundle, version 1 with its items, and the grant", async () => {
    const { r } = await planAndApply(await bundleDoc({ items: [{ server: n("server"), tool: "read_issue" }], grants: [{ role: n("eng") }] }));
    expect(r.statusCode, r.body).toBe(200);
    const b = await bundleRow();
    expect(b).toMatchObject({ currentVersion: 1, archivedAt: null });
    expect(await db.select().from(mcpBundleVersions).where(eq(mcpBundleVersions.bundleId, b!.id))).toHaveLength(1);
    const grants = await db.select().from(mcpBundleGrants).where(eq(mcpBundleGrants.bundleId, b!.id));
    expect(grants.map((g) => g.maxTier)).toEqual(["read"]);
    expect((await live()).mcpBundles.find((x) => x.name === n("bundle"))).toMatchObject({ items: [{ server: n("server"), tool: "read_issue" }] });
  });

  it("a change of tools is a new version, and a tier moves in place", async () => {
    const { r } = await planAndApply(
      await bundleDoc({
        approverUserId: approverId,
        items: [
          { server: n("server"), tool: "read_issue" },
          { server: n("server"), tool: "close_issue" },
        ],
        grants: [{ role: n("eng"), maxTier: "write" }],
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    const b = await bundleRow();
    expect(b!.currentVersion).toBe(2);
    expect(b!.approverUserId).toBe(approverId);
    const versions = await db.select().from(mcpBundleVersions).where(eq(mcpBundleVersions.bundleId, b!.id)).orderBy(asc(mcpBundleVersions.version));
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    const [g] = await db.select().from(mcpBundleGrants).where(eq(mcpBundleGrants.bundleId, b!.id));
    expect(g!.maxTier).toBe("write");
    expect((await planOf(await bundleDoc({ approverUserId: approverId, items: [{ server: n("server"), tool: "read_issue" }, { server: n("server"), tool: "close_issue" }], grants: [{ role: n("eng"), maxTier: "write" }] }))).plan.changes).toEqual([]);
  });

  it("a grant removed is deleted, and a bundle missing from the file is archived; un-archiving is a plan issue", async () => {
    const { r } = await planAndApply(await bundleDoc({ approverUserId: approverId, items: [{ server: n("server"), tool: "read_issue" }] }));
    expect(r.statusCode, r.body).toBe(200);
    const b = await bundleRow();
    expect(await db.select().from(mcpBundleGrants).where(eq(mcpBundleGrants.bundleId, b!.id))).toEqual([]);
    expect(b!.currentVersion).toBe(3);

    const archived = await planAndApply(await bundleDoc(null));
    expect(archived.r.statusCode, archived.r.body).toBe(200);
    expect((await bundleRow())!.archivedAt).not.toBeNull();

    const revive = await planOf(await bundleDoc({ archived: false }));
    expect(revive.issues.map((i: { code: string }) => i.code)).toContain("bundle_unarchive_unsupported");
  });
});

describe("workflow templates", () => {
  const tplDoc = async (tpl: Record<string, unknown> | null) => {
    const o = await others();
    return doc({ workflowTemplates: [...o.templates, ...(tpl ? [{ name: n("tpl"), ...tpl }] : [])] });
  };
  const tplRow = async () => (await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, n("tpl"))))[0];

  it("create goes through the create path; a definition change records the baseline and a governance_apply version", async () => {
    const created = await planAndApply(await tplDoc({ definition: definition() }));
    expect(created.r.statusCode, created.r.body).toBe(200);
    const t = await tplRow();
    expect(t).toBeDefined();

    const changed = await planAndApply(await tplDoc({ definition: definition({ workflow: n("wf2") }) }));
    expect(changed.r.statusCode, changed.r.body).toBe(200);
    const versions = await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.templateId, t!.id)).orderBy(asc(workflowTemplateVersions.version));
    expect(versions.map((v) => [v.version, v.origin])).toEqual([
      [1, "baseline"],
      [2, "governance_apply"],
    ]);
    expect(((await tplRow())!.definition as { workflow: string }).workflow).toBe(n("wf2"));
  });

  it("a definition the kernel refuses is a plan issue, and nothing is written", async () => {
    const plan = await planOf(await tplDoc({ definition: { workflow: "x", stages: [{ id: "a", type: "nope" }] } }));
    expect(plan.issues.map((i: { code: string }) => i.code)).toContain("invalid_workflow_definition");
  });

  it("missing from the file retires it; un-retiring is a plan issue", async () => {
    const { r } = await planAndApply(await tplDoc(null));
    expect(r.statusCode, r.body).toBe(200);
    expect((await tplRow())!.retiredAt).not.toBeNull();
    const revive = await planOf(await tplDoc({ definition: definition({ workflow: n("wf2") }) }));
    expect(revive.issues.map((i: { code: string }) => i.code)).toContain("template_unretire_unsupported");
  });

  it("an intake template is not a file decision", async () => {
    const o = await others();
    const name = `ai-use-case-intake/${n("variant")}`;
    const plan = await planOf(doc({ workflowTemplates: [...o.templates, { name, definition: definition() }] }));
    expect(plan.issues).toContainEqual(expect.objectContaining({ section: "workflowTemplates", key: name, code: "intake_template_not_editable" }));
    expect(plan.applicable).toBe(false);
  });
});
