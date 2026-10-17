/**
 * ADR-0190 owner decisions C and D, on a real database through the real app (migration 0201):
 *  - MIGRATION 0201: the journal order; `projects.isolation_sensitivity` with its CHECK; the
 *    `execution_person_stdio_relaxations` guard (never deleted, only cleared once, nothing else changes, TRUNCATE
 *    refused) and its one-active-row-per-scope index.
 *  - C, ENFORCED IN THE RESOLUTION: an interactive person's own stdio call (no agent) is L3 by default; with a
 *    relaxation on its server or its project it is L2 and placed under the configured profile, and the relaxation is
 *    recorded on the placement's audit row. An API-key call (not interactive), another server or project, a
 *    regulated project, or a cleared relaxation stays L3. `stdioPlacementContext` maps the request's session facts.
 *  - C, THE ROUTES: setting needs a `settings_relax` step-up and is audited; clearing needs none and is audited; a
 *    remote server, an unknown scope kind (there is no org scope) and a missing scope are refused.
 *  - D: a project with neither use cases nor the field does not resolve; the field resolves it; it never lowers what
 *    the use cases give; every change needs the step-up and is audited.
 *
 * Global state (M-068): step-up is relaxed only inside the tests that say so and put back in `finally`; the rows this
 * file writes are scoped by this run's servers and projects (relaxation rows cannot be deleted by design, and are
 * cleared before the end).
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
  createDb,
  eq,
  executionOffers,
  executionPersonStdioRelaxations,
  executionPlacements,
  inArray,
  isNull,
  mcpServers,
  projects,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { executionProfileDigest, SHIPPED_EXECUTION_PROFILES } from "@regulait/shared";
import { buildApp } from "./app.js";
import { decidePlacement, resolveRequirement } from "./execution-placement.js";
import { stdioPlacementContext } from "./executor-stdio.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const MIGRATION = "0201_isolation_person_stdio_and_project_sensitivity";

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `ocd-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ENV = `ocd-${RUN}`;
const IMAGE = `sha256:${"c".repeat(64)}`;
const RESTRICTED_DIGEST = executionProfileDigest(SHIPPED_EXECUTION_PROFILES.restricted);

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
const serverIds: string[] = [];
const projectIds: string[] = [];
const restores: Array<() => Promise<void>> = [];
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
type Method = "GET" | "PUT";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const errorOf = async (p: Promise<unknown>) =>
  p.then(
    () => "",
    (e: unknown) => String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""),
  );

async function newStdioServer(tag: string): Promise<string> {
  const name = `ocd-${tag}-${RUN}`;
  const id = (await db.insert(mcpServers).values({ name, url: `stdio:${name}`, transport: "stdio", stdioCommand: "/opt/mcp/bin/ocd", stdioArgs: [], stdioCommandDigest: "0".repeat(64) }).returning())[0]!.id;
  serverIds.push(id);
  return id;
}

async function newProject(sensitivity: "public" | "internal" | "confidential" | "regulated" | null): Promise<string> {
  const id = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`ocd-p-${RUN}-${randomUUID().slice(0, 8)}`}) returning id`))[0]!.id;
  projectIds.push(id);
  if (sensitivity) await db.insert(aiUseCases).values({ name: `ocd-uc-${RUN}`, description: "d", ownerUserId: adminId, businessContext: "b", dataSensitivity: sensitivity, projectId: id });
  return id;
}

/** an executor attesting the shipped `restricted` profile at L2 (gVisor), or with no attestation at all */
async function newL2Executor(name: string, attest = true): Promise<string> {
  const identityId = rows<{ id: string }>(
    await db.execute(
      sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments)
          values ('worker_runtime', ${`spiffe://ocd.example.org/regulait/worker_runtime/${name}-${RUN}`}, ARRAY[${adminId}]::uuid[], ARRAY[${ENV}]) returning id`,
    ),
  )[0]!.id;
  const executorId = rows<{ id: string }>(
    await db.execute(
      sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
          values (${identityId}, ${`ocd-${name}-${RUN}`}, 'gvisor', 'fake-0.0.0', '["hardened_container","user_space_kernel"]'::jsonb) returning id`,
    ),
  )[0]!.id;
  if (!attest) return executorId;
  await db.execute(
    sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
        values (${executorId}, ${RESTRICTED_DIGEST}, 'user_space_kernel', ${"e".repeat(64)}, '{}'::jsonb, 'pass', now(), now() + interval '1 hour')`,
  );
  return executorId;
}

/** an interactive person's own stdio call (no agent), or the same call made with an API key */
const personCall = (mcpServerId: string, projectId: string, interactivePerson: boolean) =>
  resolveRequirement(db, { workloadKind: "mcp_stdio", mcpServerId, projectId, agent: null, interactivePerson });

async function relaxWithStepUpOff(scopeKind: "mcp_server" | "project", scopeId: string) {
  const restore = await relaxStepUpForTest(db);
  try {
    const r = await inject("PUT", `/v1/execution-person-stdio-relaxations/${scopeKind}/${scopeId}`, adminAuth, { relaxed: true });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { relaxation: { id: string; scopeKind: string; scopeId: string; from: string; to: string }; changed: boolean };
  } finally {
    await restore();
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "ocd".padEnd(64, "k") });
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `ocd-admin-${RUN}@example.com`, displayName: `ocd admin ${RUN}`, isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "ocd" } });
  adminAuth = { authorization: `Bearer ${key.json().token}` };
}, 120_000);

afterAll(async () => {
  // relaxation rows are never deleted (the guard); clear this run's, so no scope stays relaxed
  if (serverIds.length + projectIds.length > 0) {
    await db
      .update(executionPersonStdioRelaxations)
      .set({ clearedAt: sql`now()`, clearedByUserId: adminId })
      .where(and(inArray(executionPersonStdioRelaxations.scopeId, [...serverIds, ...projectIds]), isNull(executionPersonStdioRelaxations.clearedAt)));
  }
  for (const r of restores.reverse()) await r();
  await db.delete(mcpServers).where(inArray(mcpServers.id, serverIds)).catch(() => undefined);
  await app.close();
});

// ---------------------------------------------------------------------------
describe("ADR-0190 owner decisions C and D: migration 0201", () => {
  it("the journal places 0201 after every earlier migration with a strictly later `when` (never drizzle-kit generate)", () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const mine = journal.entries.find((e) => e.tag === MIGRATION)!;
    expect(mine).toBeDefined();
    expect(mine.idx).toBe(201);
    for (const e of journal.entries.filter((x) => x.idx < mine.idx)) expect(mine.when, e.tag).toBeGreaterThan(e.when);
    for (const e of journal.entries.filter((x) => x.idx > mine.idx)) expect(e.when, e.tag).toBeGreaterThan(mine.when);
  });

  it("projects.isolation_sensitivity exists, is NULL on a new project, and refuses a value outside the vocabulary", async () => {
    const id = await newProject(null);
    const [p] = await db.select({ s: projects.isolationSensitivity }).from(projects).where(eq(projects.id, id));
    expect(p!.s).toBeNull();
    expect(await errorOf(db.execute(sql`update projects set isolation_sensitivity = 'secret' where id = ${id}`))).toMatch(/projects_isolation_sensitivity_check/);
  });

  it("a relaxation row is never deleted, only cleared once, changes nothing else, and TRUNCATE is refused", async () => {
    const scopeId = randomUUID();
    const [row] = await db.insert(executionPersonStdioRelaxations).values({ scopeKind: "mcp_server", scopeId, createdByUserId: adminId }).returning();
    expect(await errorOf(db.delete(executionPersonStdioRelaxations).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/never deleted/);
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ scopeId: randomUUID() }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/only gains its clearing/);
    // one active row per scope
    expect(await errorOf(db.insert(executionPersonStdioRelaxations).values({ scopeKind: "mcp_server", scopeId, createdByUserId: adminId }))).toMatch(/execution_person_stdio_relaxations_active_uq|duplicate key/);
    // a clearing without its actor is refused by the CHECK
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ clearedAt: sql`now()` }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/cleared_check/);
    await db.update(executionPersonStdioRelaxations).set({ clearedAt: sql`now()`, clearedByUserId: adminId }).where(eq(executionPersonStdioRelaxations.id, row!.id));
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ clearedByUserId: randomUUID() }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/only gains its clearing/);
    // the scope may be relaxed again (a new row, a new id)
    const [again] = await db.insert(executionPersonStdioRelaxations).values({ scopeKind: "mcp_server", scopeId, createdByUserId: adminId }).returning();
    expect(again!.id).not.toBe(row!.id);
    await db.update(executionPersonStdioRelaxations).set({ clearedAt: sql`now()`, clearedByUserId: adminId }).where(eq(executionPersonStdioRelaxations.id, again!.id));
    // inside a transaction that always rolls back, so a broken guard could never empty the shared table
    const truncate = await errorOf(
      db.transaction(async (tx) => {
        await tx.execute(sql`truncate table execution_person_stdio_relaxations`);
        throw new Error("ocd-rollback: the truncate went through");
      }),
    );
    expect(truncate).toMatch(/TRUNCATE refused \(append-only\)/);
    expect((await db.select().from(executionPersonStdioRelaxations).where(eq(executionPersonStdioRelaxations.scopeId, scopeId))).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 owner decision C: a person's own stdio call, enforced in the resolution", () => {
  it("the default: an interactive person's own call is L3 (the unknown agent), placed under the most restrictive profile", async () => {
    const server = await newStdioServer("default");
    const project = await newProject("public");
    const r = await personCall(server, project, true);
    expect(r).toMatchObject({ kind: "required", requiredClass: "microvm", requiredBy: "unknown_agent", agentAssurance: "unknown", relaxation: null });
    if (r.kind === "required") expect(r.profile).toMatchObject({ name: "restricted-microvm", source: "most_restrictive" });
  });

  it("a server-scoped relaxation: the interactive call is L2 under the configured profile; the API-key call stays L3", async () => {
    const server = await newStdioServer("srv");
    const project = await newProject("public");
    const set = await relaxWithStepUpOff("mcp_server", server);
    expect(set).toMatchObject({ changed: true, relaxation: { scopeKind: "mcp_server", scopeId: server, from: "microvm", to: "user_space_kernel" } });
    const relaxed = await personCall(server, project, true);
    expect(relaxed).toMatchObject({ kind: "required", requiredClass: "user_space_kernel", agentAssurance: "unknown" });
    if (relaxed.kind !== "required") return;
    expect(relaxed.relaxation).toEqual({ kind: "person_stdio_l2", subjectKind: "interactive_person", relaxationId: set.relaxation.id, scopeKind: "mcp_server", scopeId: server });
    expect(relaxed.profile).toMatchObject({ name: "restricted", source: "shipped_default" });
    expect(relaxed.floors).toContainEqual({ source: "unknown_agent", class: "user_space_kernel" });
    // the negative control: the same call with an API key (not an interactive person) is still the unknown agent at L3
    expect(await personCall(server, project, false)).toMatchObject({ kind: "required", requiredClass: "microvm", requiredBy: "unknown_agent", relaxation: null });
    // another server is not relaxed
    expect(await personCall(await newStdioServer("other"), project, true)).toMatchObject({ requiredClass: "microvm", relaxation: null });
    // a regulated project still wins (the relaxation never overrides another floor)
    expect(await personCall(server, await newProject("regulated"), true)).toMatchObject({ requiredClass: "microvm", requiredBy: "data_sensitivity" });
    // the audit row of the set
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-person-stdio-relaxed"), eq(auditLog.objectId, server)));
    expect(audit).toMatchObject({ objectType: "mcp_server", userId: adminId });
    expect(audit!.detail).toMatchObject({ relaxationId: set.relaxation.id, kind: "person_stdio_l2", subjectKind: "interactive_person", from: "microvm", to: "user_space_kernel" });
  });

  it("a low-assurance agent stays L3 whatever is relaxed (only a call with no agent qualifies)", async () => {
    const server = await newStdioServer("agent");
    const project = await newProject("public");
    await relaxWithStepUpOff("mcp_server", server);
    const agentId = rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`ocd-agent-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
    const r = await resolveRequirement(db, { workloadKind: "mcp_stdio", mcpServerId: server, projectId: project, agent: { kind: "agent", id: agentId }, interactivePerson: true });
    expect(r).toMatchObject({ kind: "required", requiredClass: "microvm", requiredBy: "unknown_agent", agentAssurance: "no_identity", relaxation: null });
  });

  it("a project-scoped relaxation applies to every stdio server in that project, and to no other project", async () => {
    const server = await newStdioServer("proj");
    const project = await newProject("internal");
    const set = await relaxWithStepUpOff("project", project);
    expect(await personCall(server, project, true)).toMatchObject({ requiredClass: "user_space_kernel", relaxation: { relaxationId: set.relaxation.id, scopeKind: "project", scopeId: project } });
    expect(await personCall(server, await newProject("internal"), true)).toMatchObject({ requiredClass: "microvm", relaxation: null });
    const listed = await inject("GET", "/v1/execution-person-stdio-relaxations", adminAuth);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().relaxations).toEqual(expect.arrayContaining([expect.objectContaining({ id: set.relaxation.id, scopeKind: "project", scopeId: project })]));
  });

  it("offered at L2 on an L2 executor; a relaxed refusal's audit row records the relaxation (subject kind and id)", async () => {
    const server = await newStdioServer("place");
    const project = await newProject("public");
    const ex = await newL2Executor("place");
    const unattested = await newL2Executor("place-none", false);
    const unrelaxed = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: server, projectId: project, agent: null, interactivePerson: true, imageDigest: IMAGE, onlyExecutorIds: [ex], actorUserId: adminId });
    // unrelaxed it requires L3 under the most restrictive profile, which this L2 executor does not serve: refused
    expect(unrelaxed.kind).toBe("refused");
    if (unrelaxed.kind === "refused") expect(unrelaxed.requirement).toMatchObject({ kind: "required", requiredClass: "microvm" });
    const set = await relaxWithStepUpOff("mcp_server", server);
    const d = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: server, projectId: project, agent: null, interactivePerson: true, imageDigest: IMAGE, onlyExecutorIds: [ex], actorUserId: adminId, ttlSeconds: 1 });
    expect(d.kind).toBe("offered");
    if (d.kind !== "offered") return;
    const relaxation = { kind: "person_stdio_l2", subjectKind: "interactive_person", relaxationId: set.relaxation.id, scopeKind: "mcp_server", scopeId: server };
    expect(d.requirement).toMatchObject({ requiredClass: "user_space_kernel", relaxation });
    expect(d.requirement.profile).toMatchObject({ digest: RESTRICTED_DIGEST });
    const [offer] = await db.select().from(executionOffers).where(eq(executionOffers.id, d.offerId));
    expect(offer).toMatchObject({ requiredClass: "user_space_kernel", profileDigest: RESTRICTED_DIGEST });
    // the same relaxed call with no executor able to serve it: refused, and the refusal's audit row names the relaxation
    const r = await decidePlacement(db, { workloadKind: "mcp_stdio", mcpServerId: server, projectId: project, agent: null, interactivePerson: true, imageDigest: IMAGE, onlyExecutorIds: [unattested], actorUserId: adminId });
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused" || !r.placementId) throw new Error("expected a refused placement row");
    const [p] = await db.select().from(executionPlacements).where(eq(executionPlacements.id, r.placementId));
    expect(p).toMatchObject({ outcome: "refused", requiredClass: "user_space_kernel" });
    const [a] = await db.select().from(auditLog).where(eq(auditLog.id, p!.auditId));
    expect((a!.detail as { relaxation: unknown }).relaxation).toEqual(relaxation);
  });

  it("stdioPlacementContext: only a person's session with no grant is interactive (an API key, a session from one, none)", async () => {
    const base = { userId: adminId, projectId: null };
    expect((await stdioPlacementContext(db, { ...base, principal: { sessionOrigin: "password" } })).interactivePerson).toBe(true);
    expect((await stdioPlacementContext(db, { ...base, principal: { sessionOrigin: "oidc" } })).interactivePerson).toBe(true);
    expect((await stdioPlacementContext(db, { ...base, principal: { sessionOrigin: "api_key" } })).interactivePerson).toBe(false);
    expect((await stdioPlacementContext(db, { ...base, principal: { sessionOrigin: "unknown" } })).interactivePerson).toBe(false);
    expect((await stdioPlacementContext(db, base)).interactivePerson).toBe(false);
    expect((await stdioPlacementContext(db, { ...base, delegationGrantId: randomUUID(), principal: { sessionOrigin: "password" } })).interactivePerson).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 owner decision C: the routes", () => {
  it("setting needs a settings_relax step-up (nothing written without it); clearing needs none and is audited", async () => {
    const server = await newStdioServer("route");
    const project = await newProject("public");
    const refused = await inject("PUT", `/v1/execution-person-stdio-relaxations/mcp_server/${server}`, adminAuth, { relaxed: true });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await db.select().from(executionPersonStdioRelaxations).where(eq(executionPersonStdioRelaxations.scopeId, server))).length).toBe(0);

    const set = await relaxWithStepUpOff("mcp_server", server);
    // setting again is a no-op (no second row, no step-up asked)
    const again = await inject("PUT", `/v1/execution-person-stdio-relaxations/mcp_server/${server}`, adminAuth, { relaxed: true });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ changed: false, relaxation: { id: set.relaxation.id } });

    // clearing under the strict step-up defaults: allowed, audited, and the call is back at L3
    const cleared = await inject("PUT", `/v1/execution-person-stdio-relaxations/mcp_server/${server}`, adminAuth, { relaxed: false });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toEqual({ relaxation: null, changed: true });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-person-stdio-relaxation-cleared"), eq(auditLog.objectId, server)));
    expect(audit!.detail).toMatchObject({ relaxationId: set.relaxation.id, from: "user_space_kernel", to: "microvm" });
    const [row] = await db.select().from(executionPersonStdioRelaxations).where(eq(executionPersonStdioRelaxations.id, set.relaxation.id));
    expect(row!.clearedAt).not.toBeNull();
    expect(row!.clearedByUserId).toBe(adminId);
    expect(await personCall(server, project, true)).toMatchObject({ requiredClass: "microvm", relaxation: null });
    const twice = await inject("PUT", `/v1/execution-person-stdio-relaxations/mcp_server/${server}`, adminAuth, { relaxed: false });
    expect(twice.json()).toEqual({ relaxation: null, changed: false });
  });

  it("refuses a remote server, an org-wide or unknown scope, a missing scope and a malformed body", async () => {
    const remote = (await db.insert(mcpServers).values({ name: `ocd-remote-${RUN}`, url: "https://mcp.example.com/ocd" }).returning())[0]!.id;
    serverIds.push(remote);
    const r1 = await inject("PUT", `/v1/execution-person-stdio-relaxations/mcp_server/${remote}`, adminAuth, { relaxed: true });
    expect(r1.statusCode, r1.body).toBe(409);
    expect(r1.json().error).toBe("not_a_stdio_server");
    expect((await inject("PUT", `/v1/execution-person-stdio-relaxations/org/${randomUUID()}`, adminAuth, { relaxed: true })).statusCode).toBe(400);
    expect((await inject("PUT", `/v1/execution-person-stdio-relaxations/project/${randomUUID()}`, adminAuth, { relaxed: true })).statusCode).toBe(404);
    const server = await newStdioServer("body");
    expect((await inject("PUT", `/v1/execution-person-stdio-relaxations/mcp_server/${server}`, adminAuth, { relaxed: true, class: "hardened_container" })).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 owner decision D: the admin-set project sensitivity", () => {
  it("a project with neither use cases nor the field does not resolve; setting the field (step-up) resolves it", async () => {
    const server = await newStdioServer("d-none");
    const project = await newProject(null);
    expect(await personCall(server, project, true)).toEqual({ kind: "unresolved", workloadKind: "mcp_stdio", fact: "sensitivity" });

    const refused = await inject("PUT", `/v1/execution-project-sensitivities/${project}`, adminAuth, { sensitivity: "internal" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await db.select({ s: projects.isolationSensitivity }).from(projects).where(eq(projects.id, project)))[0]!.s).toBeNull();

    const restore = await relaxStepUpForTest(db);
    try {
      const set = await inject("PUT", `/v1/execution-project-sensitivities/${project}`, adminAuth, { sensitivity: "internal" });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toMatchObject({ changed: true, project: { projectId: project, useCaseCount: 0, useCaseSensitivity: null, adminSensitivity: "internal", effectiveSensitivity: "internal" } });
    } finally {
      await restore();
    }
    expect(await personCall(server, project, true)).toMatchObject({ kind: "required", sensitivity: "internal" });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-project-sensitivity-set"), eq(auditLog.objectId, project)));
    expect(audit).toMatchObject({ objectType: "project", userId: adminId });
    expect(audit!.detail).toMatchObject({ previous: null, sensitivity: "internal", effectiveBefore: null, effectiveAfter: "internal" });
  });

  it("the field can only raise: below the use cases it has no effect; above them it wins", async () => {
    const server = await newStdioServer("d-raise");
    const project = await newProject("confidential");
    const restore = await relaxStepUpForTest(db);
    try {
      const low = await inject("PUT", `/v1/execution-project-sensitivities/${project}`, adminAuth, { sensitivity: "public" });
      expect(low.statusCode, low.body).toBe(200);
      expect(low.json().project).toMatchObject({ useCaseSensitivity: "confidential", adminSensitivity: "public", effectiveSensitivity: "confidential" });
      expect(await personCall(server, project, true)).toMatchObject({ sensitivity: "confidential" });
      const high = await inject("PUT", `/v1/execution-project-sensitivities/${project}`, adminAuth, { sensitivity: "regulated" });
      expect(high.statusCode, high.body).toBe(200);
      expect(high.json().project).toMatchObject({ effectiveSensitivity: "regulated" });
    } finally {
      await restore();
    }
    expect(await personCall(server, project, true)).toMatchObject({ requiredClass: "microvm", sensitivity: "regulated", requiredBy: "data_sensitivity" });
    // the list shows it
    const listed = await inject("GET", "/v1/execution-project-sensitivities", adminAuth);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().projects).toEqual(expect.arrayContaining([expect.objectContaining({ projectId: project, adminSensitivity: "regulated", effectiveSensitivity: "regulated" })]));
  });

  it("clearing the field also needs the step-up; an unchanged value is a no-op; bad input is refused", async () => {
    const project = await newProject(null);
    const restore = await relaxStepUpForTest(db);
    try {
      expect((await inject("PUT", `/v1/execution-project-sensitivities/${project}`, adminAuth, { sensitivity: "public" })).statusCode).toBe(200);
    } finally {
      await restore();
    }
    const clear = await inject("PUT", `/v1/execution-project-sensitivities/${project}`, adminAuth, { sensitivity: null });
    expect(clear.statusCode, clear.body).toBe(403);
    expect(clear.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const same = await inject("PUT", `/v1/execution-project-sensitivities/${project}`, adminAuth, { sensitivity: "public" });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().changed).toBe(false);
    expect((await inject("PUT", `/v1/execution-project-sensitivities/${project}`, adminAuth, { sensitivity: "secret" })).statusCode).toBe(400);
    expect((await inject("PUT", `/v1/execution-project-sensitivities/${randomUUID()}`, adminAuth, { sensitivity: "public" })).statusCode).toBe(404);
    expect((await inject("PUT", `/v1/execution-project-sensitivities/not-a-uuid`, adminAuth, { sensitivity: "public" })).statusCode).toBe(400);
  });
});
