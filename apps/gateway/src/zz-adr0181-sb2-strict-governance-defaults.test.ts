/**
 * ADR-0181 (strict defaults), agent SB2 — THE GOVERNANCE GATES ON A FRESH ORG.
 *
 * Runs against its OWN scratch database, migrated from empty, so "fresh org"
 * is literal: nothing another suite left behind can make a default look right.
 *
 *  1. A fresh org READS the strict value of every SB2 setting through the real
 *     admin read routes. The singletons are inserted by earlier migrations
 *     with the old values, so this half proves migration 0158's UPDATE.
 *  2. With the singleton rows deleted, the loaders' create-on-first-read path
 *     yields the same strict values, so this half proves the column DEFAULTS
 *     (the no-row fallback). The column defaults are also read straight from
 *     the catalog.
 *  3. Code defaults: a project created without a threshold warns at 80%, and
 *     a builder bundle tool that does not say otherwise asks first.
 *  4. Each setting stays relaxable on its existing admin route, and the audit
 *     row records old -> new.
 *  5. The fresh-org gates actually bite: an unattributed native dispatch and
 *     a dispatch to an agent with no model card are both refused, before any
 *     provider work.
 *
 * Red proof: revert any one default (schema + migration 0158) and the matching
 * assertion here fails.
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
  interceptionSettings,
  orgSettings,
  policySimulationSettings,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { builderImportAgentSchema } from "@regulait/shared";
import { buildApp } from "./app.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const SCRATCH_DB = `regulait_sb2_strict_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();

const BOOT = "sb2-strict-boot";
const AUTH = { authorization: `Bearer ${BOOT}` };

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp> | undefined;

async function req(method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown, headers = AUTH) {
  const res = await app!.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

async function latestAudit(ruleId: string) {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1);
  return row;
}

async function readAll() {
  const org = (await req("GET", "/v1/org/settings")).body.settings;
  const icp = (await req("GET", "/v1/interception/settings")).body.settings;
  const sim = (await req("GET", "/v1/policy-simulations/settings")).body.settings;
  const mrm = (await req("GET", "/v1/mrm/status")).body;
  return { org, icp, sim, mrm };
}

function expectStrict(s: Awaited<ReturnType<typeof readAll>>) {
  expect(s.org.useCaseGateMode).toBe("enforce");
  expect(s.org.dispatchAttributionRequired).toBe(true);
  expect(s.org.mrmEnforced).toBe(true);
  expect(s.org.mrmStalenessRecertEnabled).toBe(true);
  expect(s.mrm.enforced).toBe(true);
  expect(s.mrm.stalenessRecertEnabled).toBe(true);
  expect(s.icp.requireProjectAttribution).toBe(true);
  expect(s.icp.requireMcpAttribution).toBe(true);
  expect(s.icp.keyCustodyEnforced).toBe(true);
  expect(s.icp.enforcementPosture).toBe("managed");
  expect(s.sim.requirePreviewBeforeActivate).toBe(true);
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
}, 120_000);

afterAll(async () => {
  await closeAll([
    () => app?.close() ?? Promise.resolve(),
    () => db?.$client.end() ?? Promise.resolve(),
    () => dropScratchDatabase(admin, SCRATCH_DB),
    () => admin.$client.end(),
  ]);
});

describe("ADR-0181 SB2: a fresh org reads every governance gate strict", () => {
  it("the migrated singletons are strict (migration 0158's UPDATE)", async () => {
    expectStrict(await readAll());
  });

  it("with the singleton rows gone, create-on-first-read is strict too (the column defaults)", async () => {
    await db.delete(orgSettings);
    await db.delete(interceptionSettings);
    await db.delete(policySimulationSettings);
    expectStrict(await readAll());

    const res = await db.execute(sql`
      select table_name, column_name, column_default from information_schema.columns
      where (table_name, column_name) in (
        ('org_settings', 'use_case_gate_mode'), ('org_settings', 'dispatch_attribution_required'),
        ('org_settings', 'mrm_enforced'), ('org_settings', 'mrm_staleness_recert_enabled'),
        ('interception_settings', 'require_project_attribution'), ('interception_settings', 'require_mcp_attribution'),
        ('interception_settings', 'key_custody_enforced'), ('interception_settings', 'enforcement_posture'),
        ('policy_simulation_settings', 'require_preview_before_activate'),
        ('builder_agent_tools', 'requires_approval'), ('projects', 'alert_threshold_pct'))`);
    const defaults = Object.fromEntries(
      (res as unknown as { rows: Array<{ table_name: string; column_name: string; column_default: string }> }).rows.map(
        (r) => [`${r.table_name}.${r.column_name}`, r.column_default],
      ),
    );
    expect(defaults).toEqual({
      "org_settings.use_case_gate_mode": "'enforce'::text",
      "org_settings.dispatch_attribution_required": "true",
      "org_settings.mrm_enforced": "true",
      "org_settings.mrm_staleness_recert_enabled": "true",
      "interception_settings.require_project_attribution": "true",
      "interception_settings.require_mcp_attribution": "true",
      "interception_settings.key_custody_enforced": "true",
      "interception_settings.enforcement_posture": "'managed'::text",
      "policy_simulation_settings.require_preview_before_activate": "true",
      "builder_agent_tools.requires_approval": "true",
      "projects.alert_threshold_pct": "80",
    });
  });

  it("a project created without a threshold warns at 80%", async () => {
    const created = await req("POST", "/v1/projects", { name: "sb2-strict-project" });
    expect(created.status).toBe(201);
    expect(created.body.alertThresholdPct).toBe(80);
  });

  it("a builder bundle tool that does not say otherwise asks first", () => {
    const parsed = builderImportAgentSchema.parse({
      bundle: { version: 1, agent: { name: "sb2-bundle", tools: [{ kind: "connector", name: "crm" }] } },
    });
    expect(parsed.bundle.agent.tools[0]!.requiresApproval).toBe(true);
  });
});

describe("ADR-0181 SB2: the gates bite on a fresh org", () => {
  let danaAuth: { authorization: string };
  let agentId: string;

  beforeAll(async () => {
    const u = await req("POST", "/v1/users", { email: "sb2-dana@example.test", displayName: "SB2 Dana" });
    expect(u.status).toBe(201);
    const k = await req("POST", `/v1/users/${u.body.id}/keys`, { name: "sb2" });
    danaAuth = { authorization: `Bearer ${k.body.token}` };
    const a = await req("POST", "/v1/agents", { name: "sb2-mock", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" });
    expect(a.status).toBe(201);
    agentId = a.body.id;
    expect((await req("POST", "/v1/grants/agents", { userId: u.body.id, agentId })).status).toBeLessThan(300);
  });

  it("refuses a dispatch to an agent with no approved model card (mrmEnforced)", async () => {
    const r = await req("POST", `/v1/agents/${agentId}/invoke`, { mode: "execute", input: "hi", dispatch: true }, danaAuth);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("mrm_approval_required");
  });

  it("refuses an unattributed dispatch once MRM is relaxed (dispatchAttributionRequired)", async () => {
    expect((await req("POST", "/v1/mrm/enforcement", { enforced: false })).status).toBe(200);
    const r = await req("POST", `/v1/agents/${agentId}/invoke`, { mode: "execute", input: "hi", dispatch: true }, danaAuth);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("attribution_required");
    expect((await req("POST", "/v1/mrm/enforcement", { enforced: true })).status).toBe(200);
  });
});

describe("ADR-0181 SB2: every gate stays relaxable, audited old -> new", () => {
  it("org settings: useCaseGateMode and dispatchAttributionRequired", async () => {
    const r = await req("PUT", "/v1/org/settings", { useCaseGateMode: "off", dispatchAttributionRequired: false });
    expect(r.status).toBe(200);
    expect(r.body.settings.useCaseGateMode).toBe("off");
    const row = await latestAudit("org-settings-updated");
    expect((row!.detail as any).changed).toMatchObject({ useCaseGateMode: "off", dispatchAttributionRequired: false });
    expect((row!.detail as any).previous).toEqual({ useCaseGateMode: "enforce", dispatchAttributionRequired: true });
  });

  it("MRM: enforcement and staleness recertification", async () => {
    const r = await req("POST", "/v1/mrm/enforcement", { enforced: false, stalenessRecertEnabled: false });
    expect(r.status).toBe(200);
    const row = await latestAudit("mrm-enforcement-disabled");
    expect((row!.detail as any).from).toBe(true);
    expect((row!.detail as any).to).toBe(false);
    expect((row!.detail as any).stalenessRecert.from.enabled).toBe(true);
    expect((row!.detail as any).stalenessRecert.to.enabled).toBe(false);
  });

  it("interception: both attribution switches, key custody and the declared rung", async () => {
    const r = await req("PUT", "/v1/interception/settings", {
      requireProjectAttribution: false,
      requireMcpAttribution: false,
      keyCustodyEnforced: false,
      enforcementPosture: "voluntary",
    });
    expect(r.status).toBe(200);
    const row = await latestAudit("interception-settings-updated");
    expect((row!.detail as any).previous).toEqual({
      requireProjectAttribution: true,
      requireMcpAttribution: true,
      keyCustodyEnforced: true,
      enforcementPosture: "managed",
    });
    expect((row!.detail as any).changed).toEqual({
      requireProjectAttribution: false,
      requireMcpAttribution: false,
      keyCustodyEnforced: false,
      enforcementPosture: "voluntary",
    });
  });

  it("policy simulation: the preview-before-activate dial", async () => {
    const r = await req("PUT", "/v1/policy-simulations/settings", { requirePreviewBeforeActivate: false });
    expect(r.status).toBe(200);
    const row = await latestAudit("policy-simulation-settings-changed");
    expect((row!.detail as any).requirePreviewBeforeActivateFrom).toBe(true);
    expect((row!.detail as any).requirePreviewBeforeActivateTo).toBe(false);
  });

  it("project: the alert threshold", async () => {
    const created = await req("POST", "/v1/projects", { name: "sb2-relax-project" });
    const r = await req("PATCH", `/v1/projects/${created.body.id}`, { alertThresholdPct: 100 });
    expect(r.status).toBe(200);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "project-updated"), eq(auditLog.objectId, created.body.id)));
    expect((row!.detail as any).changed).toEqual({ alertThresholdPct: 100 });
    expect((row!.detail as any).previous).toEqual({ alertThresholdPct: 80 });
  });
});
