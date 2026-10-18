/**
 * ADR-0197 decision 7 — the fallback Shadow-AI discovery dataset, end to end on its own scratch database through the
 * real app: the first-admin-setup phase (sources created disabled and enabled through the step-up route, recorded
 * runs through the real worker, the MDM import, an endpoint device enrolled and reporting), then the story phase
 * (personas, the remediation workflow waiting on Morgan — the second admin — and provenance reads). Between them the
 * test creates Ada and Morgan and enrols both, as `seed` does in the same first-admin-setup window. Then both phases again: nothing new is
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
import { auditLog, createDb, discoveryRuns, discoverySources, endpointDevices, eq, runMigrations, shadowAiFindings, sql, workflowInstances, type Db } from "@regulait/db";
import { DEMO_SHADOW_DISCOVERY as D } from "@regulait/shared";
import { buildApp } from "./app.js";
import { checkShadowDiscovery, demoShadowNeverStored, leakedShadowNames, SHADOW_DISCOVERY_BEATS } from "./demo-check-lib.js";
import { DEMO_SECURITY_LEAD, enrolAdminsTotp } from "./demo-identity.js";
import { RECORDED_RUN_OUTCOME, seedShadowSetup, seedShadowStory } from "./demo-shadow-seed-lib.js";
import { SHADOW_AI_REMEDIATION_TEMPLATE_NAME } from "./shadow-ai-remediation.js";
import { APPROVER_ADMIN_NOT_INITIATOR } from "./workflow-approvers.js";
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
  let setupReport: unknown;

  it("first-admin setup: sources enabled through the step-up route, recorded runs, the import and an enrolled device", async () => {
    const r = await seedShadowSetup(app, db, D, OPTS);
    setupReport = r;
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
    // every network source's recorded run matched something: no family is empty
    for (const kind of ["cloud_aws", "cloud_azure", "repo_gitlab"]) {
      expect(Number(recorded.find((x) => x.kind === kind)?.matched), kind).toBeGreaterThan(0);
    }
    // what `seed` does next, in the same first-admin-setup window: Ada and the security lead, both admins, MFA enrolled
    const ids: string[] = [];
    for (const [email, displayName] of [["admin@regulait.local", "Ada Admin"], [DEMO_SECURITY_LEAD.email, DEMO_SECURITY_LEAD.displayName]]) {
      const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName, isAdmin: true } });
      expect(u.statusCode, u.body).toBe(201);
      ids.push(u.json().id);
    }
    const mfa = await enrolAdminsTotp(app, BOOT, ids);
    expect(mfa.map((m) => m.status)).toEqual(["enrolled", "enrolled"]);
  }, 180_000);

  it("story: the remediation workflow is linked and waits on Morgan; the trusted library's reads are provenance-recorded", async () => {
    const r = await seedShadowStory(app, db, D, OPTS);
    expect(r.failed, r.failed.join("\n")).toEqual([]);
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, `gitlab:${D.remediation.repo}`));
    expect(finding?.remediationInstanceId).toBeTruthy();
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, finding!.remediationInstanceId!));
    const stages = (instance!.definition as { stages: Array<{ id: string; type: string; approvers?: string[] }> }).stages;
    const state = instance!.state as { currentStageIndex: number };
    expect(stages[state.currentStageIndex]?.type).toBe("human_approval");
    const morgan = (await get("/v1/users")).body.users.find((u: { email: string }) => u.email === DEMO_SECURITY_LEAD.email);
    expect(morgan).toMatchObject({ isAdmin: true, totpEnabled: true });
    expect(instance!.status).toBe("blocked_on_approval");
    // the SHIPPED default's sign-off (ADR-0197 addendum decision 1), resolved at the stage to Morgan alone: the only
    // active admin other than the initiator; the seeder authored no template and no assignment rule of its own
    expect(stages[state.currentStageIndex]?.approvers).toEqual([APPROVER_ADMIN_NOT_INITIATOR]);
    const templates = (await get("/v1/workflows/templates")).body.templates as Array<{ id: string; name: string }>;
    const shipped = templates.find((t) => t.name === SHADOW_AI_REMEDIATION_TEMPLATE_NAME);
    expect(instance!.templateIds).toEqual([shipped!.id]);
    const pending = (await get(`/v1/workflows/instances/${instance!.id}`)).body.pendingApprovals as Array<{ approverUserId: string }>;
    expect(pending.map((p) => p.approverUserId)).toEqual([morgan.id]);
    expect(instance!.initiatorUserId).not.toBe(morgan.id);

    const findings = (await get("/v1/shadow-ai/findings")).body.findings;
    const checks = await checkShadowDiscovery(get, findings, D);
    const bad = checks.filter((c) => c.level === "FAIL");
    expect(bad, JSON.stringify(bad)).toEqual([]);
    // all PASS but content trust, which needs a second (untrusted) tier this lone database has no other source for:
    // its FAIL conditions (a trusted record per library read) are pinned by `bad` above; demo:check PASSes it in CI
    for (const beat of SHADOW_DISCOVERY_BEATS.filter((b) => b !== "3 Content trust")) {
      expect(checks.find((c) => c.beat === beat)?.level, `${beat}: ${checks.find((c) => c.beat === beat)?.detail}`).toBe("PASS");
    }
    // ADR-0195 lane A6: the repo's env names are presence signature hits, never stored names
    for (const id of D.presenceSignatures) expect(JSON.stringify(findings), id).toContain(id);
    // ...and no env-variable name or value, device name or device user is in any stored evidence of the seeded device or
    // its runs, in the audit log, or in what either seeder phase printed (its report)
    const never = demoShadowNeverStored(D);
    for (const table of ["endpoint_devices", "endpoint_agent_reports", "endpoint_agent_identities", "discovery_runs", "shadow_ai_findings", "audit_log"]) {
      const res = (await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM ${table} t`))) as unknown as { rows: Array<{ row: unknown }> };
      expect(leakedShadowNames(res.rows.map((x) => x.row), never), table).toEqual([]);
    }
    expect(leakedShadowNames(setupReport, never), "the setup phase's report").toEqual([]);
    expect(leakedShadowNames(r, never), "the story phase's report").toEqual([]);
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

describe("ADR-0197 decision 7 (review L5): the seeder runs no discovery pass beside a source outside the dataset", () => {
  // its own scratch database: the guard is reached only while the dataset's recorded runs have not succeeded yet
  const GUARD_DB = `${SCRATCH_DB}_guard`;
  const NIL = "00000000-0000-0000-0000-000000000000";
  let gdb: Db;
  let gapp: ReturnType<typeof buildApp>;
  let restoreGuardIssuer: () => Promise<void> = async () => {};
  let foreignSourceId: string;
  let foreignRunId: string;

  beforeAll(async () => {
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${GUARD_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${GUARD_DB}`));
    gdb = createDb(urlFor(GUARD_DB));
    await runMigrations(gdb, migrationsFolder);
    restoreGuardIssuer = await useTestIssuerKey(gdb);
    gapp = buildApp(gdb, { bootstrapToken: BOOT, dataKey: DATA_KEY });
    await gapp.ready();
    // a source the dataset does not own, enabled, with a scan waiting for the gateway's worker
    const [src] = await gdb
      .insert(discoverySources)
      .values({ name: "Someone else's GCP project", kind: "cloud_gcp", target: { projectId: "not-the-demo" }, scope: { orgLevel: false, include: [] }, enabled: true, enabledAt: new Date(), enabledBy: NIL, createdBy: NIL })
      .returning({ id: discoverySources.id });
    foreignSourceId = src!.id;
    const [run] = await gdb.insert(discoveryRuns).values({ sourceId: foreignSourceId, trigger: "manual", sourceVersion: 1, kind: "cloud_gcp" }).returning({ id: discoveryRuns.id });
    foreignRunId = run!.id;
  }, 180_000);

  afterAll(async () => {
    await closeAll([
      () => restoreGuardIssuer(),
      () => gapp.close(),
      () => (gdb.$client as { end: () => Promise<void> }).end(),
      () => dropScratchDatabase(admin, GUARD_DB),
    ]);
  });

  const recordedNames = [D.gitlab.name, D.aws.name, D.azure.name];
  async function expectUntouched() {
    const [foreign] = await gdb.select().from(discoveryRuns).where(eq(discoveryRuns.id, foreignRunId));
    expect(foreign).toMatchObject({ status: "queued", attempt: 0, startedAt: null, leaseOwner: null, errorCode: null });
    // ...and none of the dataset's own runs was scanned either: no pass ran
    const ours = (await gdb.select().from(discoveryRuns)).filter((r) => r.sourceId !== foreignSourceId);
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((r) => r.status === "queued"), JSON.stringify(ours.map((r) => r.status))).toBe(true);
  }

  it("one extra enabled source: other_sources_enabled for each recorded source, and that source's run is untouched", async () => {
    const r = await seedShadowSetup(gapp, gdb, D, OPTS);
    for (const name of recordedNames) {
      expect(r.failed.some((f) => f.startsWith(`recorded run of '${name}'`) && f.includes("other_sources_enabled")), `${name}: ${r.failed.join("\n")}`).toBe(true);
    }
    await expectUntouched();
  }, 180_000);

  it("the extra source disabled but its run still queued: other_source_run_pending, and the run is still untouched", async () => {
    await gdb.update(discoverySources).set({ enabled: false, disabledAt: new Date(), disabledBy: NIL }).where(eq(discoverySources.id, foreignSourceId));
    const r = await seedShadowSetup(gapp, gdb, D, OPTS);
    for (const name of recordedNames) {
      expect(r.failed.some((f) => f.startsWith(`recorded run of '${name}'`) && f.includes("other_source_run_pending")), `${name}: ${r.failed.join("\n")}`).toBe(true);
    }
    await expectUntouched();
  }, 180_000);
});
