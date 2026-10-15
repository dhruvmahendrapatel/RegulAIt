/**
 * ADR-0190 (batch 6 item 3) I2 — THE PLACEMENT DECISION, on a real database
 * through the real app:
 *  - MIGRATION 0194: its journal entry sorts last with a later `when`; the
 *    columns exist; the delegation guard inherits a parent's class into a
 *    child that names none and refuses a lower one (the backstop).
 *  - THE CASCADE from the database (`decidePlacement`): the project's
 *    sensitivity (its AI use cases), a compliance tag's `min_isolation_class`,
 *    the configured profile, an unknown agent, the parent grant. Each refusal
 *    is the 409 `execution_profile_unavailable` envelope, writes its audit row
 *    (`execution-refused`, naming every floor) and makes NO offer; an
 *    unresolved fact refuses `policy_unresolved` with no placement row.
 *  - DELEGATION (decision 8): a child below its parent's class is refused
 *    `delegation-isolation`, audited, nothing created; one that names none
 *    inherits; the live chain fails `actor-chain-invalid` when the executor
 *    holding a placement is quarantined, revoked or no longer fresh.
 *  - THE ROUTES: execution profiles (list, create, version, retire; every
 *    relaxation a `settings_relax` step-up, audited), assignments, placements.
 *
 * Global state (M-068): org settings are restored; rows this file writes are
 * scoped by this run's ids (identities, executors, placements and grants
 * cannot be deleted by design); the compliance profile is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  aiUseCases,
  and,
  auditLog,
  complianceProfiles,
  createDb,
  delegationGrants,
  desc,
  eq,
  executionOffers,
  executionPlacements,
  inArray,
  mcpServers,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { checkActorChain } from "@regulait/policy-kernel";
import { EXECUTION_PROFILE_SCHEMA, executionProfileDigest, SHIPPED_EXECUTION_PROFILES, type ExecutionProfileBody } from "@regulait/shared";
import { buildApp } from "./app.js";
import { admitChildGrant, createRootGrant, DelegationRefusedError, governedActorFor, loadLiveChain } from "./delegation.js";
import { decidePlacement } from "./execution-placement.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const MIGRATION = "0194_isolation_placement_decision";

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `i2-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ENV = `i2-${RUN}`;
const IMAGE = `sha256:${"d".repeat(64)}`;
const RESTRICTED_DIGEST = executionProfileDigest(SHIPPED_EXECUTION_PROFILES.restricted);
const MICROVM_DIGEST = executionProfileDigest(SHIPPED_EXECUTION_PROFILES["restricted-microvm"]);
const TAG = `i2-tag-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
let memberAuth: { authorization: string };
/** a stdio MCP server every mcp_stdio call here names (its own profile is a floor of the call) */
let stdioId: string;
let remoteId: string;
const restores: Array<() => Promise<void>> = [];
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
type Method = "GET" | "PUT" | "POST";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

// --- fixtures ----------------------------------------------------------------

/** a registry agent with (or without) an active ADR-0188 identity */
async function newAgent(name: string, withIdentity = true): Promise<{ agentId: string; identityId: string | null }> {
  const agentId = rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`i2-${name}-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
  if (!withIdentity) return { agentId, identityId: null };
  const identityId = rows<{ id: string }>(
    await db.execute(
      sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
          values ('agent', ${agentId}, ${`spiffe://i2.example.org/regulait/agent/${name}-${RUN}`}, ARRAY[${adminId}]::uuid[], ARRAY[${ENV}]) returning id`,
    ),
  )[0]!.id;
  return { agentId, identityId };
}

/** an executor row and one fresh passing attestation per (profile digest, class) given */
async function newExecutor(name: string, backend: "gvisor" | "kata", attest: Array<{ digest: string; cls: string; expired?: boolean }>): Promise<string> {
  const identityId = rows<{ id: string }>(
    await db.execute(
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments)
          values ('worker_runtime', ${`spiffe://i2.example.org/regulait/worker_runtime/${name}-${RUN}`}, ARRAY[${adminId}]::uuid[], ARRAY[${ENV}]) returning id`,
    ),
  )[0]!.id;
  const classes = backend === "gvisor" ? ["hardened_container", "user_space_kernel"] : ["hardened_container", "microvm"];
  const executorId = rows<{ id: string }>(
    await db.execute(
      sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
          values (${identityId}, ${`i2-${name}-${RUN}`}, ${backend}, 'fake-0.0.0', ${JSON.stringify(classes)}::jsonb) returning id`,
    ),
  )[0]!.id;
  for (const a of attest) {
    // an expired pass: observed two hours ago, expired one hour ago (the expiry CHECK keeps it within 24 h)
    await db.execute(
      a.expired
        ? sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
              values (${executorId}, ${a.digest}, ${a.cls}, ${"e".repeat(64)}, '{}'::jsonb, 'pass', now() - interval '2 hours', now() - interval '1 hour')`
        : sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
              values (${executorId}, ${a.digest}, ${a.cls}, ${"e".repeat(64)}, '{}'::jsonb, 'pass', now(), now() + interval '1 hour')`,
    );
  }
  return executorId;
}

/** a project, optionally with an AI use case of the given sensitivity and compliance tags */
async function newProject(sensitivity: "public" | "internal" | "confidential" | "regulated" | null, tags: string[] = []): Promise<string> {
  const projectId = rows<{ id: string }>(
    await db.execute(sql`insert into projects (name, classifications) values (${`i2-p-${RUN}-${randomUUID().slice(0, 8)}`}, ${JSON.stringify(tags)}::jsonb) returning id`),
  )[0]!.id;
  if (sensitivity) {
    await db.insert(aiUseCases).values({ name: `i2-uc-${RUN}`, description: "d", ownerUserId: adminId, businessContext: "b", dataSensitivity: sensitivity, projectId });
  }
  return projectId;
}

const offersFor = async (executorId: string) => (await db.select().from(executionOffers).where(eq(executionOffers.executorId, executorId))).length;
const placementOf = async (id: string) => (await db.select().from(executionPlacements).where(eq(executionPlacements.id, id)))[0]!;
const auditRow = async (id: string) => (await db.select().from(auditLog).where(eq(auditLog.id, id)))[0]!;

/** a strict custom profile body (the shipped `restricted` renamed, at a chosen class) */
const customBody = (name: string, over: Partial<ExecutionProfileBody> = {}): ExecutionProfileBody => ({
  ...structuredClone(SHIPPED_EXECUTION_PROFILES.restricted),
  schema: EXECUTION_PROFILE_SCHEMA,
  name,
  ...over,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "i2".padEnd(64, "k") });
  const adm = await inject("POST", "/v1/users", AUTH, { email: `i2-admin-${RUN}@example.com`, displayName: `i2 admin ${RUN}`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  adminId = adm.json().id;
  adminAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "i2" })).json().token}` };
  const mem = await inject("POST", "/v1/users", AUTH, { email: `i2-member-${RUN}@example.com`, displayName: `i2 member ${RUN}` });
  memberAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${mem.json().id}/keys`, AUTH, { name: "i2" })).json().token}` };
  const sName = `i2-stdio-${RUN}`;
  stdioId = (await db.insert(mcpServers).values({ name: sName, url: `stdio:${sName}`, transport: "stdio", stdioCommand: "/opt/mcp/bin/i2", stdioArgs: [], stdioCommandDigest: "0".repeat(64) }).returning())[0]!.id;
  remoteId = (await db.insert(mcpServers).values({ name: `i2-remote-${RUN}`, url: "https://mcp.example.com/i2" }).returning())[0]!.id;
}, 120_000);

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, TAG));
  // a server a workload identity's profile assignment never names; best effort (a later suite may hold a reference)
  await db.delete(mcpServers).where(inArray(mcpServers.id, [stdioId, remoteId])).catch(() => undefined);
  await app.close();
});

// ---------------------------------------------------------------------------
describe("ADR-0190 I2 migration 0194", () => {
  it("the journal places 0194 after every earlier migration with a strictly later `when` (never drizzle-kit generate)", () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const mine = journal.entries.find((e) => e.tag === MIGRATION)!;
    expect(mine).toBeDefined();
    const byIdx = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < byIdx.length; i++) expect(byIdx[i]!.when, byIdx[i]!.tag).toBeGreaterThan(byIdx[i - 1]!.when);
    // 0194 is found by its TAG: later than everything before it and earlier than everything after it, so a later
    // migration (0195 on) never breaks this check, as "0194 is the newest" did
    for (const e of journal.entries.filter((x) => x.idx < mine.idx)) expect(mine.when, e.tag).toBeGreaterThan(e.when);
    for (const e of journal.entries.filter((x) => x.idx > mine.idx)) expect(e.when, e.tag).toBeGreaterThan(mine.when);
  });

  it("adds the decision 14 columns I1 deferred", async () => {
    const cols = rows<{ t: string; c: string }>(
      await db.execute(sql`select table_name as t, column_name as c from information_schema.columns where (table_name, column_name) in
        (('compliance_profiles','min_isolation_class'), ('workload_identities','execution_profile_id'), ('mcp_servers','execution_profile_id'),
         ('delegation_grants','required_isolation_class'), ('delegation_grants','execution_profile_digest'), ('delegation_grants','execution_placement_id'))`),
    );
    expect(cols.length).toBe(6);
  });

  it("the guard: a child that names no class inherits the parent's; a lower one is refused", async () => {
    const { identityId: parentActor } = await newAgent("g-parent");
    const { identityId: childActor } = await newAgent("g-child");
    const rootId = randomUUID();
    await db.execute(sql`insert into delegation_grants (id, root_grant_id, depth, depth_limit, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at, required_isolation_class, execution_profile_digest)
      values (${rootId}, ${rootId}, 0, 3, ${adminId}, ${parentActor}, '[]'::jsonb, ${ENV}, 'in_process', now() + interval '1 hour', 'microvm', ${MICROVM_DIGEST})`);
    const childId = randomUUID();
    await db.execute(sql`insert into delegation_grants (id, root_grant_id, parent_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
      values (${childId}, ${rootId}, ${rootId}, ARRAY[${rootId}]::uuid[], 1, ${adminId}, ${childActor}, '[]'::jsonb, ${ENV}, 'in_process', now() + interval '30 minutes')`);
    const [child] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, childId));
    expect(child!.requiredIsolationClass).toBe("microvm");
    expect(child!.executionProfileDigest).toBe(MICROVM_DIGEST);
    const lower = await db
      .execute(sql`insert into delegation_grants (id, root_grant_id, parent_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at, required_isolation_class)
        values (${randomUUID()}, ${rootId}, ${rootId}, ARRAY[${rootId}]::uuid[], 1, ${adminId}, ${childActor}, '[]'::jsonb, ${ENV}, 'in_process', now() + interval '30 minutes', 'user_space_kernel')`)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String((lower as Error)?.message ?? "") + String((lower as { cause?: Error })?.cause?.message ?? "")).toMatch(/below its parent's isolation class/);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 decision 7: the placement decision from the database", () => {
  it("a regulated project with only an L2 executor: 409 class_below_required, audited with every floor, no offer, no fallback", async () => {
    const ex = await newExecutor("l2-reg", "gvisor", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel" }]);
    const { agentId } = await newAgent("reg");
    const projectId = await newProject("regulated");
    const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [ex], actorUserId: adminId });
    expect(d.kind).toBe("refused");
    if (d.kind !== "refused") return;
    expect(d.code).toBe("class_below_required");
    expect(d.envelope).toEqual({ statusCode: 409, error: "execution_profile_unavailable", ruleId: "execution-profile", reason: "class_below_required" });
    expect(await offersFor(ex)).toBe(0);
    const p = await placementOf(d.placementId!);
    expect(p).toMatchObject({ outcome: "refused", refusalCode: "class_below_required", requiredClass: "microvm", requiredBy: "data_sensitivity", workloadKind: "mcp_stdio", executorId: null });
    const a = await auditRow(p.auditId);
    expect(a.ruleId).toBe("execution-refused");
    expect(a.userId).toBe(adminId);
    const detail = a.detail as { floors: Array<{ source: string; class: string }>; refusalRuleId: string; sensitivity: string };
    expect(detail.refusalRuleId).toBe("execution-profile");
    expect(detail.sensitivity).toBe("regulated");
    expect(detail.floors).toEqual(expect.arrayContaining([{ source: "data_sensitivity", class: "microvm" }, { source: "workload_kind", class: "user_space_kernel" }]));
  });

  it("a public project with an L2 executor: offered at L2 (the control)", async () => {
    const ex = await newExecutor("l2-pub", "gvisor", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel" }]);
    const { agentId } = await newAgent("pub");
    const projectId = await newProject("public");
    const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [ex], ttlSeconds: 1 });
    expect(d.kind).toBe("offered");
    if (d.kind !== "offered") return;
    expect(d.executorId).toBe(ex);
    expect(d.requirement).toMatchObject({ requiredClass: "user_space_kernel", requiredBy: "workload_kind", sensitivity: "public", agentAssurance: "known" });
    expect(d.requirement.profile).toMatchObject({ name: "restricted", digest: RESTRICTED_DIGEST, source: "shipped_default" });
    expect(await offersFor(ex)).toBe(1);
  });

  it("a compliance tag with min_isolation_class L3 raises a public project; the tag is a versioned field", async () => {
    const created = await inject("POST", "/v1/compliance/profiles", adminAuth, { tag: TAG, minIsolationClass: "microvm" });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().minIsolationClass).toBe("microvm");
    const ex = await newExecutor("l2-tag", "gvisor", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel" }]);
    const { agentId } = await newAgent("tag");
    const projectId = await newProject("public", [TAG]);
    const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [ex] });
    expect(d).toMatchObject({ kind: "refused", code: "class_below_required" });
    if (d.kind === "refused" && d.requirement.kind === "required") expect(d.requirement).toMatchObject({ requiredClass: "microvm", requiredBy: "compliance_tag" });
    // lowering the tag's floor is a loosening: the settings_relax step-up an API key cannot give
    const lowered = await inject("POST", "/v1/compliance/profiles", adminAuth, { tag: TAG, minIsolationClass: null });
    expect(lowered.statusCode, lowered.body).toBe(403);
  });

  it("an unresolved fact (a project with no use case) refuses policy_unresolved before any offer, with no placement row", async () => {
    const ex = await newExecutor("l2-unres", "gvisor", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel" }]);
    const { agentId } = await newAgent("unres");
    const projectId = await newProject(null);
    const before = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from execution_placements`))[0]!.n;
    const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [ex] });
    expect(d).toMatchObject({ kind: "refused", code: "policy_unresolved", placementId: null, envelope: { statusCode: 409, error: "execution_profile_unavailable", ruleId: "execution-profile", reason: "policy_unresolved" } });
    expect(await offersFor(ex)).toBe(0);
    expect(rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from execution_placements`))[0]!.n).toBe(before);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "execution-refused"), sql`${auditLog.detail} ->> 'projectId' = ${projectId}`))
      .orderBy(desc(auditLog.at));
    expect(a?.detail).toMatchObject({ code: "policy_unresolved", unresolvedFact: "sensitivity" });
    // and it is listed among the refusals that have no placement row
    const listed = await inject("GET", "/v1/execution-placements?reason=policy_unresolved&limit=200", adminAuth);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().refusalsWithoutPlacement.some((r: { auditId: string }) => r.auditId === a!.id)).toBe(true);
  });

  it("an agent with no identity runs only under the most restrictive profile: refused on L2, offered on an L3 executor", async () => {
    const l2 = await newExecutor("l2-unk", "gvisor", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel" }, { digest: MICROVM_DIGEST, cls: "user_space_kernel" }]);
    const { agentId } = await newAgent("noid", false);
    const projectId = await newProject("public");
    const refused = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [l2] });
    expect(refused).toMatchObject({ kind: "refused", code: "class_below_required" });
    if (refused.kind === "refused" && refused.requirement.kind === "required") {
      expect(refused.requirement).toMatchObject({ requiredClass: "microvm", requiredBy: "unknown_agent", agentAssurance: "no_identity" });
      expect(refused.requirement.profile).toMatchObject({ name: "restricted-microvm", source: "most_restrictive" });
    }
    const l3 = await newExecutor("l3-unk", "kata", [{ digest: MICROVM_DIGEST, cls: "microvm" }]);
    const offered = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [l3], ttlSeconds: 1 });
    expect(offered).toMatchObject({ kind: "offered", executorId: l3, attestedClass: "microvm" });
  });

  it("a stale attestation and no executor at all each keep their fixed reason", async () => {
    const stale = await newExecutor("stale", "gvisor", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel", expired: true }]);
    const { agentId } = await newAgent("stale");
    const projectId = await newProject("internal");
    expect(await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [stale] })).toMatchObject({ kind: "refused", code: "attestation_stale" });
    expect(await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [randomUUID()] })).toMatchObject({ kind: "refused", code: "no_executor" });
  });

  it("an mcp_stdio call with no server, or with a server that is not stdio, does not resolve (never the agent's floor)", async () => {
    const { agentId } = await newAgent("no-server");
    const projectId = await newProject("public");
    for (const mcpServerId of [undefined, remoteId, randomUUID()]) {
      const d = await decidePlacement(db, { workloadKind: "mcp_stdio", ...(mcpServerId ? { mcpServerId } : {}), projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [randomUUID()] });
      expect(d, String(mcpServerId)).toMatchObject({ kind: "refused", code: "policy_unresolved", placementId: null });
      if (d.kind === "refused") expect(d.requirement).toMatchObject({ kind: "unresolved", fact: "configuredProfileFloor" });
    }
  });

  it("malformed project classifications do not resolve (never read as no tags)", async () => {
    const { agentId } = await newAgent("bad-tags");
    const projectId = await newProject("public");
    // M-068: every suite shares this database, and other readers walk ALL projects' classifications as a list
    // (rule-versioning's divergence report answered 500 on an object here), so the malformed value is
    // array-shaped (a non-string tag) and is restored before the test ends
    await db.execute(sql`update projects set classifications = '[1]'::jsonb where id = ${projectId}`);
    try {
      const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [randomUUID()] });
      expect(d).toMatchObject({ kind: "refused", code: "policy_unresolved" });
      if (d.kind === "refused") expect(d.requirement).toMatchObject({ kind: "unresolved", fact: "complianceFloors" });
    } finally {
      await db.execute(sql`update projects set classifications = '[]'::jsonb where id = ${projectId}`);
    }
  });

  it("a non-isolable kind is never placed: in_gateway or external", async () => {
    expect(await decidePlacement(db, { workloadKind: "model_call", projectId: null, agent: null, imageDigest: IMAGE })).toEqual({ kind: "not_isolable", execution: "in_gateway" });
    expect(await decidePlacement(db, { workloadKind: "remote_mcp", projectId: null, agent: null, imageDigest: IMAGE })).toEqual({ kind: "not_isolable", execution: "external" });
  });

  it("the parent grant's class raises a delegated call (decision 7 item 6)", async () => {
    const ex = await newExecutor("l2-parent", "gvisor", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel" }]);
    const { agentId, identityId } = await newAgent("parent-call");
    const projectId = await newProject("public");
    const rootId = randomUUID();
    await db.execute(sql`insert into delegation_grants (id, root_grant_id, depth, depth_limit, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at, required_isolation_class)
      values (${rootId}, ${rootId}, 0, 3, ${adminId}, ${identityId}, '[]'::jsonb, ${ENV}, 'in_process', now() + interval '1 hour', 'microvm')`);
    const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, parentGrantId: rootId, imageDigest: IMAGE, onlyExecutorIds: [ex] });
    expect(d).toMatchObject({ kind: "refused", code: "class_below_required" });
    if (d.kind === "refused" && d.requirement.kind === "required") expect(d.requirement.requiredBy).toBe("parent_grant");
    // a parent grant that does not exist is a fact that does not resolve
    const missing = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, parentGrantId: randomUUID(), imageDigest: IMAGE, onlyExecutorIds: [ex] });
    expect(missing).toMatchObject({ kind: "refused", code: "policy_unresolved" });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 decision 8: delegation-isolation and the live chain", () => {
  /** a scope with no atoms: the grant checks that read grants have nothing to check, so isolation is what is tested */
  const scopeOf = (agentId: string) => [{ type: "agent" as const, agentId, modes: [], kind: "read" as const }];

  it("a child below its parent's class is refused delegation-isolation, audited, nothing created; none inherits; equal is admitted", async () => {
    const parent = await newAgent("d-parent");
    const child = await newAgent("d-child");
    const scope = scopeOf(parent.agentId);
    const root = await createRootGrant(db, {
      sponsorUserId: adminId,
      actorIdentityId: parent.identityId!,
      scope,
      capMicros: null,
      ttlMs: 3_600_000,
      environment: ENV,
      projectId: null,
      binding: { kind: "in_process" },
      isolation: { requiredClass: "microvm", profileDigest: MICROVM_DIGEST },
    });
    expect(root.requiredIsolationClass).toBe("microvm");
    const count = async () => (await db.select().from(delegationGrants).where(eq(delegationGrants.rootGrantId, root.id))).length;
    const before = await count();
    const refused = await admitChildGrant(db, {
      parentGrantId: root.id,
      idempotencyKey: `i2-${RUN}-low`,
      actorIdentityId: child.identityId!,
      scope,
      capMicros: null,
      ttlMs: 600_000,
      environment: ENV,
      projectId: null,
      binding: { kind: "in_process" },
      isolation: { requiredClass: "user_space_kernel" },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(DelegationRefusedError);
    expect((refused as DelegationRefusedError).ruleId).toBe("delegation-isolation");
    expect((refused as DelegationRefusedError).code).toBe("delegation_isolation");
    expect(await count()).toBe(before);
    const [audited] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "delegation-isolation"), eq(auditLog.objectId, root.id)));
    expect(audited).toMatchObject({ effect: "deny", objectType: "delegation_grant" });
    expect(audited!.detail).toMatchObject({ parentRequiredIsolationClass: "microvm", requestedIsolationClass: "user_space_kernel" });

    const inherited = await admitChildGrant(db, {
      parentGrantId: root.id,
      idempotencyKey: `i2-${RUN}-inherit`,
      actorIdentityId: child.identityId!,
      scope,
      capMicros: null,
      ttlMs: 600_000,
      environment: ENV,
      projectId: null,
      binding: { kind: "in_process" },
    });
    expect(inherited.grant).toMatchObject({ requiredIsolationClass: "microvm", executionProfileDigest: MICROVM_DIGEST });
  });

  it("amendment item 12: an actor whose placement's executor is quarantined, revoked or stale is not live (actor-chain-invalid)", async () => {
    const run = async (name: string, spoil: (executorId: string) => Promise<void>, expected: string) => {
      const ex = await newExecutor(`lc-${name}`, "gvisor", [{ digest: RESTRICTED_DIGEST, cls: "user_space_kernel" }]);
      const actor = await newAgent(`lc-${name}`);
      const placementId = rows<{ id: string }>(
        await db.execute(sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, executor_id, applied_class, report_sha256, outcome)
          values (${randomUUID()}, 'mcp_stdio', 'user_space_kernel', 'workload_kind', 'enforce', ${RESTRICTED_DIGEST}, ${ex}, 'user_space_kernel', ${"f".repeat(64)}, 'placed') returning id`),
      )[0]!.id;
      const root = await createRootGrant(db, {
        sponsorUserId: adminId,
        actorIdentityId: actor.identityId!,
        scope: scopeOf(actor.agentId),
        capMicros: null,
        ttlMs: 3_600_000,
        environment: ENV,
        projectId: null,
        binding: { kind: "in_process" },
        isolation: { requiredClass: "user_space_kernel", placementId },
      });
      // the control: the placement holds while the executor is active and freshly attested
      const ok = await loadLiveChain(db, root.id);
      expect(ok!.failure, name).toBeNull();
      await spoil(ex);
      const live = await loadLiveChain(db, root.id);
      expect(live!.failure, name).toEqual({ index: 0, code: expected });
      const governed = await governedActorFor(db, root.id, { costKnown: true });
      const checked = checkActorChain(governed!.actor, adminId);
      expect(checked.ok, name).toBe(false);
    };
    await run("quarantined", (id) => db.execute(sql`update executors set status = 'quarantined', quarantine_code = 'admin', quarantined_at = now() where id = ${id}`).then(() => {}), "executor_quarantined");
    await run("revoked", (id) => db.execute(sql`update executors set status = 'revoked' where id = ${id}`).then(() => {}), "executor_not_active");
    await run(
      "stale",
      (id) =>
        db
          .execute(sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
            values (${id}, ${RESTRICTED_DIGEST}, 'user_space_kernel', ${"0".repeat(64)}, '{}'::jsonb, 'fail', now() + interval '1 second', now() + interval '1 hour')`)
          .then(() => {}),
      "executor_attestation_stale",
    );
  });

  /** a placed placement on a kata executor attesting microvm for the restricted-microvm profile */
  async function l3Placement(name: string) {
    const ex = await newExecutor(`m1-${name}`, "kata", [{ digest: MICROVM_DIGEST, cls: "microvm" }]);
    const placementId = rows<{ id: string }>(
      await db.execute(sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, executor_id, applied_class, report_sha256, outcome)
        values (${randomUUID()}, 'mcp_stdio', 'microvm', 'data_sensitivity', 'enforce', ${MICROVM_DIGEST}, ${ex}, 'microvm', ${"f".repeat(64)}, 'placed') returning id`),
    )[0]!.id;
    return { ex, placementId };
  }
  const rootOn = (actor: { agentId: string; identityId: string | null }, placementId: string, cls: "user_space_kernel" | "microvm") =>
    createRootGrant(db, {
      sponsorUserId: adminId,
      actorIdentityId: actor.identityId!,
      scope: scopeOf(actor.agentId),
      capMicros: null,
      ttlMs: 3_600_000,
      environment: ENV,
      projectId: null,
      binding: { kind: "in_process" },
      isolation: { requiredClass: cls, placementId },
    });

  it("review M1: a grant naming less than its placement's class is refused delegation-isolation and audited; nothing created", async () => {
    const { placementId } = await l3Placement("low-grant");
    const actor = await newAgent("m1-low");
    const refused = await rootOn(actor, placementId, "user_space_kernel").then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(DelegationRefusedError);
    expect((refused as DelegationRefusedError).ruleId).toBe("delegation-isolation");
    expect((await db.select().from(delegationGrants).where(eq(delegationGrants.executionPlacementId, placementId))).length).toBe(0);
    const [audited] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "delegation-isolation"), sql`${auditLog.detail} ->> 'executionPlacementId' = ${placementId}`));
    expect(audited?.detail).toMatchObject({ phase: "create", requestedIsolationClass: "user_space_kernel" });
    // the database refuses it too (the guard trigger)
    const rootId = randomUUID();
    const direct = await db
      .execute(sql`insert into delegation_grants (id, root_grant_id, depth, depth_limit, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at, required_isolation_class, execution_placement_id)
        values (${rootId}, ${rootId}, 0, 3, ${adminId}, ${actor.identityId}, '[]'::jsonb, ${ENV}, 'in_process', now() + interval '1 hour', 'user_space_kernel', ${placementId})`)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String((direct as Error)?.message ?? "") + String((direct as { cause?: Error })?.cause?.message ?? "")).toMatch(/at least its placement's requirement/);
  });

  it("review M1: an L3 placement is no longer live once its executor attests only below L3", async () => {
    const { ex, placementId } = await l3Placement("drop");
    const actor = await newAgent("m1-drop");
    const root = await rootOn(actor, placementId, "microvm");
    expect((await loadLiveChain(db, root.id))!.failure).toBeNull();
    // a newer passing self-test, but only at L1: the placement required L3
    await db.execute(sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
      values (${ex}, ${MICROVM_DIGEST}, 'hardened_container', ${"1".repeat(64)}, '{}'::jsonb, 'pass', now() + interval '1 second', now() + interval '1 hour')`);
    expect((await loadLiveChain(db, root.id))!.failure).toEqual({ index: 0, code: "executor_attestation_stale" });
  });

  it("a placement belongs to one actor in one chain: another actor's grant naming it is refused (code and trigger), audited", async () => {
    const { placementId } = await l3Placement("owned");
    const owner = await newAgent("own-a");
    await rootOn(owner, placementId, "microvm");
    const intruder = await newAgent("own-b");
    const refused = await rootOn(intruder, placementId, "microvm").then(
      () => null,
      (e: unknown) => e,
    );
    expect((refused as DelegationRefusedError).code).toBe("placement_bound_elsewhere");
    const [audited] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "delegation_grant"), sql`${auditLog.detail} ->> 'code' = 'placement_bound_elsewhere'`, sql`${auditLog.detail} ->> 'executionPlacementId' = ${placementId}`));
    expect(audited).toMatchObject({ effect: "deny" });
    const rootId = randomUUID();
    const direct = await db
      .execute(sql`insert into delegation_grants (id, root_grant_id, depth, depth_limit, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at, required_isolation_class, execution_placement_id)
        values (${rootId}, ${rootId}, 0, 3, ${adminId}, ${intruder.identityId}, '[]'::jsonb, ${ENV}, 'in_process', now() + interval '1 hour', 'microvm', ${placementId})`)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String((direct as Error)?.message ?? "") + String((direct as { cause?: Error })?.cause?.message ?? "")).toMatch(/another actor's or another chain's/);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 I2 routes: profiles, assignments, placements", () => {
  it("lists the shipped profiles with no relaxation against restricted; 401 anonymous, 403 member", async () => {
    expect((await inject("GET", "/v1/execution-profiles", {})).statusCode).toBe(401);
    expect((await inject("GET", "/v1/execution-profiles", memberAuth)).statusCode).toBe(403);
    const r = await inject("GET", "/v1/execution-profiles", adminAuth);
    expect(r.statusCode, r.body).toBe(200);
    const restricted = r.json().profiles.find((p: { name: string; version: number }) => p.name === "restricted" && p.version === 1);
    expect(restricted).toMatchObject({ digest: RESTRICTED_DIGEST, minClass: "user_space_kernel", shipped: true, relaxations: [] });
    const engine = r.json().profiles.find((p: { name: string }) => p.name === "engine-worker");
    expect(engine.relaxations.length).toBeGreaterThan(0);
  });

  it("creates a strict profile with no step-up (audited); a relaxing one needs settings_relax (an API key cannot give it)", async () => {
    const name = `i2-strict-${RUN}`;
    const body = customBody(name, { minClass: "microvm" });
    const created = await inject("POST", "/v1/execution-profiles", adminAuth, { body });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ name, version: 1, minClass: "microvm", digest: executionProfileDigest(body), relaxations: [] });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-profile-created"), eq(auditLog.objectId, created.json().id)));
    expect(audit).toBeDefined();
    expect((await inject("POST", "/v1/execution-profiles", adminAuth, { body })).statusCode).toBe(409);

    const loose = customBody(`i2-loose-${RUN}`, { minClass: "hardened_container" });
    const refused = await inject("POST", "/v1/execution-profiles", adminAuth, { body: loose });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await inject("GET", `/v1/execution-profiles/${loose.name}`, adminAuth)).statusCode).toBe(404);

    // a version that tightens needs nothing; one that loosens against the previous version needs the step-up
    const v2 = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: customBody(name, { minClass: "microvm", resources: { ...body.resources, cpuMillis: 500 } }) });
    expect(v2.statusCode, v2.body).toBe(201);
    expect(v2.json().version).toBe(2);
    const v3 = await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: customBody(name, { minClass: "user_space_kernel" }) });
    expect(v3.statusCode, v3.body).toBe(403);
    expect((await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: customBody("other-name") })).statusCode).toBe(400);
  });

  it("with step-up off for this test: a relaxing profile is created and audited execution-profile-relaxed", async () => {
    const restore = await relaxStepUpForTest(db);
    try {
      const loose = customBody(`i2-relaxed-${RUN}`, { minClass: "hardened_container" });
      const r = await inject("POST", "/v1/execution-profiles", adminAuth, { body: loose });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().relaxations).toContain("minClass");
      const [relaxed] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-profile-relaxed"), eq(auditLog.objectId, r.json().id)));
      expect(relaxed!.detail).toMatchObject({ relaxedAgainstRestricted: expect.arrayContaining(["minClass"]) });
    } finally {
      await restore();
    }
  });

  it("the shipped profiles are never versioned or retired; a custom one retires (audited) and then refuses profile_retired", async () => {
    expect((await inject("POST", "/v1/execution-profiles/restricted/retire", adminAuth, {})).statusCode).toBe(409);
    expect((await inject("POST", "/v1/execution-profiles/restricted/versions", adminAuth, { body: customBody("restricted") })).statusCode).toBe(409);
    const name = `i2-retire-${RUN}`;
    const created = await inject("POST", "/v1/execution-profiles", adminAuth, { body: customBody(name, { minClass: "microvm" }) });
    expect(created.statusCode, created.body).toBe(201);
    // assigned to an agent, then retired: that agent's calls refuse profile_retired, never a fallback
    const { agentId } = await newAgent("retire");
    const assign = await inject("PUT", `/v1/execution-profile-assignments/agent/${agentId}`, adminAuth, { profileId: created.json().id });
    expect(assign.statusCode, assign.body).toBe(200);
    expect(assign.json()).toMatchObject({ source: "assigned", assigned: { id: created.json().id } });
    const retired = await inject("POST", `/v1/execution-profiles/${name}/retire`, adminAuth, {});
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json().assignmentsNowRefused).toBe(1);
    expect((await inject("POST", `/v1/execution-profiles/${name}/retire`, adminAuth, {})).statusCode).toBe(409);
    expect((await inject("POST", `/v1/execution-profiles/${name}/versions`, adminAuth, { body: customBody(name, { minClass: "microvm", resources: { ...SHIPPED_EXECUTION_PROFILES.restricted.resources, cpuMillis: 500 } }) })).statusCode).toBe(409);
    const projectId = await newProject("public");
    const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [randomUUID()] });
    expect(d).toMatchObject({ kind: "refused", code: "profile_retired" });
  });

  it("assignments: a stricter profile needs nothing; going back to the default from it is a relaxation (step-up); audited", async () => {
    const { agentId } = await newAgent("assign");
    const name = `i2-assign-${RUN}`;
    const created = await inject("POST", "/v1/execution-profiles", adminAuth, { body: customBody(name, { minClass: "microvm" }) });
    expect(created.statusCode, created.body).toBe(201);
    const get0 = await inject("GET", `/v1/execution-profile-assignments/agent/${agentId}`, adminAuth);
    expect(get0.json()).toMatchObject({ assigned: null, source: "shipped_default", effective: { name: "restricted" } });
    const up = await inject("PUT", `/v1/execution-profile-assignments/agent/${agentId}`, adminAuth, { profileId: created.json().id });
    expect(up.statusCode, up.body).toBe(200);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "execution-profile-assigned"), sql`${auditLog.detail} ->> 'targetId' = ${agentId}`));
    expect(audit!.detail).toMatchObject({ targetKind: "agent", profileId: created.json().id, relaxations: [] });
    // the configured profile is now a floor of every call the agent makes
    const ex = await newExecutor("l2-assign", "gvisor", [{ digest: created.json().digest, cls: "user_space_kernel" }]);
    const projectId = await newProject("public");
    const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: stdioId, projectId, agent: { kind: "agent", id: agentId }, imageDigest: IMAGE, onlyExecutorIds: [ex] });
    expect(d).toMatchObject({ kind: "refused", code: "class_below_required" });
    if (d.kind === "refused" && d.requirement.kind === "required") expect(d.requirement).toMatchObject({ requiredBy: "configured_profile", requiredClass: "microvm" });
    const down = await inject("PUT", `/v1/execution-profile-assignments/agent/${agentId}`, adminAuth, { profileId: null });
    expect(down.statusCode, down.body).toBe(403);
    expect(down.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    // an agent with no identity, a remote MCP server and an unknown target are refused
    const { agentId: noId } = await newAgent("assign-noid", false);
    expect((await inject("PUT", `/v1/execution-profile-assignments/agent/${noId}`, adminAuth, { profileId: null })).statusCode).toBe(409);
    expect((await inject("GET", `/v1/execution-profile-assignments/mcp_server/${randomUUID()}`, adminAuth)).statusCode).toBe(404);
    expect((await inject("GET", `/v1/execution-profile-assignments/nothing/${randomUUID()}`, adminAuth)).statusCode).toBe(400);
  });

  it("placements: listed newest first with filters; one placement with its audit row; 404 and 400", async () => {
    const r = await inject("GET", "/v1/execution-placements?outcome=refused&limit=5", adminAuth);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().placements.length).toBeGreaterThan(0);
    for (const p of r.json().placements) expect(p.outcome).toBe("refused");
    const first = r.json().placements[0];
    const one = await inject("GET", `/v1/execution-placements/${first.id}`, adminAuth);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toMatchObject({ id: first.id, audit: { id: first.auditId, ruleId: "execution-refused" }, attestationStrength: "software_attested" });
    expect((await inject("GET", `/v1/execution-placements/${randomUUID()}`, adminAuth)).statusCode).toBe(404);
    expect((await inject("GET", "/v1/execution-placements/not-a-uuid", adminAuth)).statusCode).toBe(400);
    expect((await inject("GET", "/v1/execution-placements?outcome=maybe", adminAuth)).statusCode).toBe(400);
  });
});
