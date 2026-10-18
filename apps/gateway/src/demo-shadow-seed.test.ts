/**
 * ADR-0197 decision 7 — the fallback Shadow-AI discovery dataset, end to end on its own scratch database through the
 * real app: the first-admin-setup phase (sources created disabled and enabled through the step-up route, recorded
 * runs through the real worker, the MDM import, an endpoint device enrolled and reporting), then the story phase
 * (personas, the remediation workflow waiting on Avery, provenance reads). Then both phases again: nothing new is
 * created, and every count is unchanged. `checkShadowDiscovery` (demo:check) finds every new screen populated and
 * no name of the dataset stored in clear.
 *
 * A scratch database because the first phase needs first-admin setup (no admin able to step up), which the shared
 * test database never is, and because it enables discovery sources other suites expect to be absent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, discoverySources, endpointDevices, eq, runMigrations, shadowAiFindings, sql, workflowInstances, type Db } from "@regulait/db";
import { DEMO_SHADOW_DISCOVERY as D } from "@regulait/shared";
import { buildApp } from "./app.js";
import { checkShadowDiscovery } from "./demo-check-lib.js";
import { RECORDED_RUN_OUTCOME, seedShadowSetup, seedShadowStory } from "./demo-shadow-seed-lib.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `regulait_demo_shadow_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
const BOOT = "demo-shadow-seed-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
// synthetic, derived at runtime (gitleaks): never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`demo-shadow-data-key-${process.pid}`).digest("hex");
const OPTS = { bootstrapToken: BOOT, dataKey: DATA_KEY };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIssuer: () => Promise<void> = async () => {};

const get = async (url: string) => {
  const r = await app.inject({ method: "GET", url, headers: AUTH });
  let body: Record<string, any> = {};
  try {
    body = r.json() as Record<string, any>;
  } catch {
    /* empty */
  }
  return { status: r.statusCode, body };
};

const TABLES = {
  sources: sql`SELECT count(*)::int AS n FROM discovery_sources`,
  credentials: sql`SELECT count(*)::int AS n FROM discovery_credentials WHERE revoked_at IS NULL`,
  runs: sql`SELECT count(*)::int AS n FROM discovery_runs`,
  findings: sql`SELECT count(*)::int AS n FROM shadow_ai_findings`,
  devices: sql`SELECT count(*)::int AS n FROM endpoint_devices`,
  reports: sql`SELECT count(*)::int AS n FROM endpoint_agent_reports`,
  provenance: sql`SELECT count(*)::int AS n FROM content_provenance_records`,
  instances: sql`SELECT count(*)::int AS n FROM workflow_instances`,
  connectors: sql`SELECT count(*)::int AS n FROM connectors`,
  federationKeys: sql`SELECT count(*)::int AS n FROM federation_signing_keys`,
};
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [k, q] of Object.entries(TABLES)) {
    const r = (await db.execute(q)) as unknown as { rows: Array<{ n: number }> };
    out[k] = Number(r.rows[0]!.n);
  }
  return out;
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  // the endpoint agent needs the deployment's public URL and an identity signing key, as a real install has
  process.env.REGULAIT_PUBLIC_URL = "http://localhost";
  restoreIssuer = await useTestIssuerKey(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    () => restoreIssuer(),
    () => app.close(),
    () => (db.$client as { end: () => Promise<void> }).end(),
    () => dropScratchDatabase(admin, SCRATCH_DB),
    () => (admin.$client as { end: () => Promise<void> }).end(),
  ]);
});

describe("ADR-0197 decision 7: the fallback Shadow-AI discovery dataset", () => {
  let first: Record<string, number>;

  it("first-admin setup: sources enabled through the step-up route, recorded runs, the import and an enrolled device", async () => {
    const r = await seedShadowSetup(app, db, D, OPTS);
    expect(r.failed, r.failed.join("\n")).toEqual([]);
    const rows = await db.select().from(discoverySources);
    expect(rows.map((s) => s.name).sort()).toEqual([D.gitlab.name, D.aws.name, D.azure.name, D.inventory.name, D.agent.name].sort());
    expect(rows.every((s) => s.enabled)).toBe(true);
    // enabled by the enable route, whose step-up the bootstrap credential passed during first-admin setup
    const enables = await db.select().from(auditLog).where(eq(auditLog.ruleId, "discovery-source-enabled"));
    expect(enables).toHaveLength(5);
    // every recorded run says it is one
    const runs = (await get("/v1/discovery/runs?limit=50")).body.runs as Array<Record<string, any>>;
    const recorded = runs.filter((x) => (x.readOutcomes ?? []).some((o: { read: string }) => o.read === RECORDED_RUN_OUTCOME.read));
    expect(recorded.map((x) => x.kind).sort()).toEqual(["cloud_aws", "cloud_azure", "repo_gitlab"]);
    expect(recorded.every((x) => x.status === "succeeded")).toBe(true);
    // the device registered with a software key (the truth about a simulated device) and reported
    const [device] = await db.select().from(endpointDevices);
    expect(device?.lastReportAt).not.toBeNull();
  }, 180_000);

  it("story: the remediation workflow is linked and waits on Avery; the trusted library's reads are provenance-recorded", async () => {
    const r = await seedShadowStory(app, db, D, OPTS);
    expect(r.failed, r.failed.join("\n")).toEqual([]);
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, `gitlab:${D.remediation.repo}`));
    expect(finding?.remediationInstanceId).toBeTruthy();
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, finding!.remediationInstanceId!));
    const stages = (instance!.definition as { stages: Array<{ id: string; type: string; approvers?: string[] }> }).stages;
    const state = instance!.state as { currentStageIndex: number };
    expect(stages[state.currentStageIndex]?.type).toBe("human_approval");
    const avery = (await get("/v1/users")).body.users.find((u: { email: string }) => u.email === "avery@regulait.local");
    expect(stages[state.currentStageIndex]?.approvers).toEqual([avery.id]);
    expect(instance!.initiatorUserId).not.toBe(avery.id);

    const findings = (await get("/v1/shadow-ai/findings")).body.findings;
    const checks = await checkShadowDiscovery(get, findings, D);
    const bad = checks.filter((c) => c.level === "FAIL");
    expect(bad, JSON.stringify(bad)).toEqual([]);
    for (const beat of ["1 Discovery sources", "1 Sightings", "1 Data minimisation", "1 Federation", "1 Endpoint agent", "1 Remediation plan"]) {
      expect(checks.find((c) => c.beat === beat)?.level, beat).toBe("PASS");
    }
    // ADR-0195 lane A6: the repo's env names and the agent's CLI name are presence signature hits, never stored names
    expect(JSON.stringify(findings)).toMatch(/env\.anthropic\.api-key|cli\.anthropic\.claude/);
    first = await counts();
    expect(first.provenance).toBeGreaterThanOrEqual(D.contentTrust.objects.length);
  }, 180_000);

  it("is idempotent: both phases again create nothing and leave every count as it was", async () => {
    const s = await seedShadowSetup(app, db, D, OPTS);
    const t = await seedShadowStory(app, db, D, OPTS);
    expect([...s.failed, ...t.failed]).toEqual([]);
    expect([...s.created, ...t.created]).toEqual([]);
    expect(await counts()).toEqual(first);
  }, 180_000);
});
