/**
 * ADR-0357 slice 1a: governance configuration as code — the JSON Schema, export, and the dry-run plan.
 *
 *  - export names every seeded object by name (never an id but approvers), and holds no secret;
 *  - an exported document, YAML or JSON, plans to no change against the live state it came from (round trip);
 *  - a plan classifies each change (widens / narrows / neutral), reports names that do not resolve, binds to a
 *    planHash that moves with the live state, and writes nothing;
 *  - refusals: anchors, unknown keys, an unknown apiVersion, a duplicate object, an oversize document;
 *  - export and plan each leave an audit row.
 * Cleanup is scoped to the rows this file created (M-008/M-009).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, CORE_SCHEMA } from "js-yaml";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  inArray,
  mcpServers,
  mcpTools,
  projects,
  rateLimits,
  roleToolGrants,
  roles,
  runMigrations,
  users,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { GOVERNANCE_CONFIG_API_VERSION } from "@regulait/shared";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `gc-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const n = (s: string) => `gc-${s}-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
let roleId: string;
let projectId: string;
let approverId: string;

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();
  const [u] = await db.insert(users).values({ email: `${n("approver")}@example.test`, displayName: "approver" }).returning({ id: users.id });
  approverId = u!.id;
  const [s] = await db.insert(mcpServers).values({ name: n("server"), url: "https://mcp.example.test/" }).returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.insert(mcpTools).values([
    { serverId, name: "read_issue", kind: "read" },
    { serverId, name: "close_issue", kind: "write" },
  ]);
  const [r] = await db.insert(roles).values({ name: n("eng"), description: "engineers" }).returning({ id: roles.id });
  roleId = r!.id;
  await db.insert(roleToolGrants).values({ roleId, serverId, toolName: "read_issue" });
  await db.insert(rateLimits).values({ scope: "role", roleId, serverScope: "server", serverId, maxCalls: 100, windowSeconds: 3600 });
  const [p] = await db
    .insert(projects)
    .values({ name: n("project"), budgetUsd: 500, budgetApproverUserId: approverId, budgetPeriod: "monthly" })
    .returning({ id: projects.id });
  projectId = p!.id;
});

afterAll(async () => {
  await db.delete(rateLimits).where(eq(rateLimits.roleId, roleId));
  await db.delete(roles).where(eq(roles.id, roleId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await db.delete(workflowTemplates).where(inArray(workflowTemplates.name, [n("wf")]));
  await db.delete(users).where(eq(users.id, approverId));
  await app.close();
});

const exportJson = async () => {
  const r = await app.inject({ method: "GET", url: "/v1/governance-config/export?format=json", headers: AUTH });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { apiVersion: string; metadata: { revision: string }; spec: Record<string, Array<Record<string, unknown>>> };
};
const plan = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/governance-config/plan", headers: AUTH, payload });
const lastAudit = async (ruleId: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.objectType, "governance_config"), eq(auditLog.ruleId, ruleId))).orderBy(desc(auditLog.at)).limit(1))[0];

describe("GET /v1/governance-config/schema", () => {
  it("serves the JSON Schema, pinned to the format version", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/governance-config/schema", headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(GOVERNANCE_CONFIG_API_VERSION);
  });
});

describe("GET /v1/governance-config/export", () => {
  it("names the seeded objects by name, with no ids but the approver, and no secret", async () => {
    const doc = await exportJson();
    expect(doc.apiVersion).toBe(GOVERNANCE_CONFIG_API_VERSION);
    const role = doc.spec.roles!.find((r) => r.name === n("eng"));
    expect(role).toEqual({ name: n("eng"), description: "engineers", toolGrants: [{ server: n("server"), tool: "read_issue" }] });
    expect(doc.spec.rateLimits).toContainEqual({ scope: "role", subject: n("eng"), server: n("server"), maxCalls: 100, windowSeconds: 3600 });
    expect(doc.spec.budgets).toContainEqual({ project: n("project"), budgetUsd: 500, period: "monthly", alertThresholdPct: 80, approverUserId: approverId });
    const text = JSON.stringify(doc);
    expect(text).not.toContain(serverId);
    expect(text).not.toContain(roleId);
    expect(text).not.toMatch(/ciphertext|secret|password|token/i);
    const row = await lastAudit("governance_config.export");
    expect(row?.detail).toMatchObject({ revision: doc.metadata.revision, format: "json" });
  });

  it("YAML by default, and the YAML is the same document", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/governance-config/export", headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/yaml/);
    const fromYaml = load(r.body, { schema: CORE_SCHEMA }) as { metadata: { revision: string } };
    expect(fromYaml.metadata.revision).toBe((await exportJson()).metadata.revision);
  });
});

describe("POST /v1/governance-config/plan", () => {
  it("an exported document (YAML text) plans to no change: the round trip", async () => {
    const yaml = (await app.inject({ method: "GET", url: "/v1/governance-config/export", headers: AUTH })).body;
    const r = await plan({ content: yaml });
    expect(r.statusCode, r.body).toBe(200);
    const out = r.json();
    expect(out.plan.changes).toEqual([]);
    expect(out.plan.liveRevision).toBe(out.plan.desiredRevision);
    expect(out.applicable).toBe(true);
  });

  it("classifies a widening and a narrowing, binds a planHash, and writes nothing", async () => {
    const doc = await exportJson();
    const roles = doc.spec.roles!.map((r) =>
      r.name === n("eng") ? { ...r, toolGrants: [{ server: n("server"), tool: "close_issue" }] } : r,
    );
    const r = await plan({ document: { ...doc, spec: { roles } } });
    expect(r.statusCode, r.body).toBe(200);
    const out = r.json();
    expect(out.plan.sections).toEqual(["roles"]);
    const change = out.plan.changes.find((c: { key: string }) => c.key === n("eng"));
    expect(change.effect).toBe("widens");
    expect(change.findings.map((f: { code: string }) => f.code).sort()).toEqual(["tool_grant_added", "tool_grant_removed"]);
    expect(out.widenings).toContainEqual({ section: "roles", key: n("eng"), codes: ["tool_grant_added"] });
    expect(out.plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.applicable).toBe(true);
    // a dry run: the live grant is untouched
    const live = await db.select().from(roleToolGrants).where(eq(roleToolGrants.roleId, roleId));
    expect(live.map((g) => g.toolName)).toEqual(["read_issue"]);
    expect((await lastAudit("governance_config.plan"))?.detail).toMatchObject({ planHash: out.plan.planHash, sections: ["roles"] });
  });

  it("the planHash moves when the live configuration moves", async () => {
    const doc = await exportJson();
    const body = { document: { ...doc, spec: { budgets: [{ project: n("project"), budgetUsd: 400, period: "monthly", approverUserId: approverId }] } } };
    const first = (await plan(body)).json();
    expect(first.plan.changes[0]).toMatchObject({ section: "budgets", op: "update", effect: "narrows" });
    await db.update(projects).set({ budgetUsd: 450 }).where(eq(projects.id, projectId));
    try {
      expect((await plan(body)).json().plan.planHash).not.toBe(first.plan.planHash);
    } finally {
      await db.update(projects).set({ budgetUsd: 500 }).where(eq(projects.id, projectId));
    }
  });

  it("reports names that do not resolve and invalid workflow definitions, and marks the plan not applicable", async () => {
    const r = await plan({
      document: {
        apiVersion: GOVERNANCE_CONFIG_API_VERSION,
        kind: "GovernanceConfig",
        spec: {
          rateLimits: [{ scope: "role", subject: n("nobody"), server: n("nowhere"), maxCalls: 1, windowSeconds: 60 }],
          budgets: [{ project: n("project"), budgetUsd: 500, period: "monthly", approverUserId: "00000000-0000-4000-8000-00000000dead" }],
          workflowTemplates: [{ name: n("wf"), definition: { stages: "not a list" } }],
        },
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    const out = r.json();
    const codes = out.issues.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["unknown_role", "unknown_server", "unknown_user", "invalid_workflow_definition"]));
    expect(out.applicable).toBe(false);
    expect(await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, n("wf")))).toEqual([]);
  });

  it("a role created by the same file is a valid subject for its rate limit", async () => {
    const doc = await exportJson();
    const r = await plan({
      document: {
        ...doc,
        spec: {
          roles: [...doc.spec.roles!, { name: n("new-role") }],
          rateLimits: [...doc.spec.rateLimits!, { scope: "role", subject: n("new-role"), maxCalls: 5, windowSeconds: 60 }],
        },
      },
    });
    const out = r.json();
    expect(out.issues).toEqual([]);
    expect(out.plan.summary.create).toBe(2);
  });

  it.each([
    ["anchors", { content: `apiVersion: ${GOVERNANCE_CONFIG_API_VERSION}\nkind: GovernanceConfig\nspec:\n  roles:\n    - &a { name: x }\n    - *a\n` }, 400, "anchors_refused"],
    ["unknown key", { document: { apiVersion: GOVERNANCE_CONFIG_API_VERSION, kind: "GovernanceConfig", spec: { secrets: [] } } }, 400, "invalid_document"],
    ["unknown version", { document: { apiVersion: "regulait.io/governance/v9", kind: "GovernanceConfig", spec: {} } }, 400, "invalid_document"],
    ["duplicate role", { document: { apiVersion: GOVERNANCE_CONFIG_API_VERSION, kind: "GovernanceConfig", spec: { roles: [{ name: "a" }, { name: "a" }] } } }, 400, "duplicate_keys"],
    ["duplicate YAML key", { content: `apiVersion: ${GOVERNANCE_CONFIG_API_VERSION}\nkind: GovernanceConfig\nkind: GovernanceConfig\nspec: {}\n` }, 400, "unparseable"],
    ["custom tag", { content: `apiVersion: ${GOVERNANCE_CONFIG_API_VERSION}\nkind: GovernanceConfig\nspec: !!js/function "x"\n` }, 400, "unparseable"],
    ["oversize", { content: "#".repeat(4 * 1024 * 1024 + 1) }, 413, "too_large"],
    ["both bodies", { content: "{}", document: {} }, 400, "invalid_body"],
  ])("refuses %s", async (_label, payload, status, error) => {
    const r = await plan(payload);
    expect(r.statusCode, r.body).toBe(status);
    expect(r.json().error).toBe(error);
  });

  it("a refused document leaves a deny audit row", async () => {
    await plan({ content: "spec: [unclosed" });
    const row = await lastAudit("governance_config.plan");
    expect(row).toMatchObject({ effect: "deny", detail: { error: "unparseable" } });
  });
});
