/**
 * ADR-0197 Q3 (migration 0208), on a real database through the real app: a "person's own stdio call" relaxation
 * (ADR-0190 owner decision C) expires.
 *  - MIGRATION 0208: `expires_at` is set by default 30 days from the set and is never more than 30 days past the set
 *    or the latest renewal (CHECK); the guard admits a clearing (nothing else changes) or a renewal (who and when, a
 *    later expiry), and nothing on a cleared row.
 *  - FAIL CLOSED: an expired, uncleared relaxation lowers nothing: the interactive person's own call is back at L3,
 *    the project view names no relaxation, the list flags it `expired`, and setting it again is refused 409
 *    `relaxation_expired` (renew it instead).
 *  - RENEWAL: a `settings_relax` step-up bound to the row (op `person_stdio_renew`); refused with no grant (an API
 *    key) or a grant for another act, which is not spent; with the exact grant the row gets 30 more days, the renewal
 *    is audited, and the call is L2 again under the same relaxation id.
 *  - THE DECISION BOM RECORD shows the expiry and the renewal, and passes the shared contract.
 *
 * Global state (M-068): relaxation rows cannot be deleted (the guard); this run's are on its own servers and projects
 * and are cleared in afterAll. Step-up stays strict throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  aiUseCases,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  executionPersonStdioRelaxations,
  inArray,
  isNull,
  mcpServers,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { decisionExecutionRelaxationRecordSchema, PERSON_STDIO_RELAXATION_DAYS, setPersonStdioRelaxationSchema } from "@regulait/shared";
import { buildApp } from "./app.js";
import { decisionExecutionRelaxationRecord } from "./bom-routes.js";
import { resolveRequirement } from "./execution-placement.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantSpent, grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `q3-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DAY = 86_400_000;
const PROGRAM = "0".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
const scopeIds: string[] = [];
const serverIds: string[] = [];
const restores: Array<() => Promise<void>> = [];
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
const errorOf = async (p: Promise<unknown>) =>
  p.then(
    () => "",
    (e: unknown) => String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""),
  );

async function newStdioServer(tag: string): Promise<string> {
  const name = `q3-${tag}-${RUN}`;
  const id = (await db.insert(mcpServers).values({ name, url: `stdio:${name}`, transport: "stdio", stdioCommand: "/opt/mcp/bin/q3", stdioArgs: [], stdioCommandDigest: PROGRAM }).returning())[0]!.id;
  serverIds.push(id);
  scopeIds.push(id);
  return id;
}

async function newProject(): Promise<string> {
  const id = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`q3-p-${RUN}-${randomUUID().slice(0, 8)}`}) returning id`))[0]!.id;
  scopeIds.push(id);
  await db.insert(aiUseCases).values({ name: `q3-uc-${RUN}`, description: "d", ownerUserId: adminId, businessContext: "b", dataSensitivity: "public", projectId: id });
  return id;
}

const personCall = (mcpServerId: string, projectId: string) => resolveRequirement(db, { workloadKind: "mcp_stdio", mcpServerId, projectId, agent: null, interactivePerson: true });
const url = (kind: "mcp_server" | "project", id: string) => `/v1/execution-person-stdio-relaxations/${kind}/${id}`;
const put = (u: string, args: StepUpCheckArgs, payload: object) =>
  grantStepUpForTest(db, adminId, args).then(async (g) => ({ g, res: await app.inject({ method: "PUT", url: u, ...stepUpRequest(g), payload }) }));
const relaxFacts = (scopeKind: "mcp_server" | "project", scopeId: string): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { op: "person_stdio_relax", scopeKind, scopeId, ...(scopeKind === "mcp_server" ? { stdioCommandDigest: PROGRAM } : {}) },
});
const renewFacts = (relaxationId: string, scopeKind: "mcp_server" | "project", scopeId: string): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { op: "person_stdio_renew", relaxationId, scopeKind, scopeId, ...(scopeKind === "mcp_server" ? { stdioCommandDigest: PROGRAM } : {}) },
});
const rowOf = async (id: string) => (await db.select().from(executionPersonStdioRelaxations).where(eq(executionPersonStdioRelaxations.id, id)))[0]!;
/** an uncleared relaxation set 31 days ago, so it expired a day ago (written directly: the set route only sets now) */
async function expiredRelaxation(scopeKind: "mcp_server" | "project", scopeId: string) {
  const [row] = await db
    .insert(executionPersonStdioRelaxations)
    .values({ scopeKind, scopeId, createdByUserId: adminId, createdAt: sql`now() - interval '31 days'`, expiresAt: sql`now() - interval '1 day'` })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "q3".padEnd(64, "k") });
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `q3-admin-${RUN}@example.com`, displayName: `q3 admin ${RUN}`, isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "q3" } });
  adminAuth = { authorization: `Bearer ${key.json().token}` };
}, 120_000);

afterAll(async () => {
  if (scopeIds.length > 0) {
    await db
      .update(executionPersonStdioRelaxations)
      .set({ clearedAt: sql`now()`, clearedByUserId: adminId })
      .where(and(inArray(executionPersonStdioRelaxations.scopeId, scopeIds), isNull(executionPersonStdioRelaxations.clearedAt)));
  }
  for (const r of restores.reverse()) await r();
  await db.delete(mcpServers).where(inArray(mcpServers.id, serverIds)).catch(() => undefined);
  await app.close();
});

describe("ADR-0197 Q3: migration 0208", () => {
  it("expires_at defaults to 30 days from the set and is never more than 30 days past the set or the latest renewal", async () => {
    const scopeId = randomUUID();
    scopeIds.push(scopeId);
    const [row] = await db.insert(executionPersonStdioRelaxations).values({ scopeKind: "project", scopeId, createdByUserId: adminId }).returning();
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(PERSON_STDIO_RELAXATION_DAYS * DAY);
    expect(row).toMatchObject({ renewedAt: null, renewedByUserId: null });
    const other = randomUUID();
    scopeIds.push(other);
    expect(await errorOf(db.insert(executionPersonStdioRelaxations).values({ scopeKind: "project", scopeId: other, createdByUserId: adminId, expiresAt: sql`now() + interval '31 days'` }))).toMatch(/expiry_check/);
    expect(await errorOf(db.insert(executionPersonStdioRelaxations).values({ scopeKind: "project", scopeId: other, createdByUserId: adminId, expiresAt: sql`now() - interval '1 second'` }))).toMatch(/expiry_check/);
    // the guard: an expiry moved without a renewal, a renewal without its actor or that shortens, a renewal past 30 days
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ expiresAt: sql`now() + interval '29 days'` }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/renewal records who renewed it/);
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ renewedAt: sql`now()`, expiresAt: sql`expires_at + interval '1 second'` }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/renewal records who renewed it|renewed_check/);
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ renewedAt: sql`now()`, renewedByUserId: adminId, expiresAt: sql`now() + interval '1 day'` }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/moves the expiry later/);
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ renewedAt: sql`now()`, renewedByUserId: adminId, expiresAt: sql`now() + interval '31 days'` }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/expiry_check/);
    // a valid renewal
    await db.update(executionPersonStdioRelaxations).set({ renewedAt: sql`now()`, renewedByUserId: adminId, expiresAt: sql`now() + interval '30 days'` }).where(eq(executionPersonStdioRelaxations.id, row!.id));
    // a clearing that also moves the expiry is refused; a plain clearing is accepted; a cleared row is never renewed
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ clearedAt: sql`now()`, clearedByUserId: adminId, expiresAt: sql`now() + interval '1 day'` }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/changes nothing else/);
    await db.update(executionPersonStdioRelaxations).set({ clearedAt: sql`now()`, clearedByUserId: adminId }).where(eq(executionPersonStdioRelaxations.id, row!.id));
    expect(await errorOf(db.update(executionPersonStdioRelaxations).set({ renewedAt: sql`now()`, renewedByUserId: adminId, expiresAt: sql`now() + interval '30 days'` }).where(eq(executionPersonStdioRelaxations.id, row!.id)))).toMatch(/only gains its clearing/);
    // the guard keeps 0185's invariants (it is still pinned and the table still refuses TRUNCATE)
    const cfg = rows<{ c: string[] | null }>(await db.execute(sql`select proconfig as c from pg_proc where proname = 'execution_person_stdio_relaxations_guard'`))[0]!.c;
    expect(cfg).toContain("search_path=pg_catalog, public, pg_temp");
    const enabled = rows<{ e: string }>(await db.execute(sql`select tgenabled as e from pg_trigger where tgname = 'execution_person_stdio_relaxations_guard'`))[0]!.e;
    expect(enabled).toBe("O");
  });
});

describe("ADR-0197 Q3: an expired relaxation stops applying (fail closed)", () => {
  it("the call is back at L3; the project view names none; the list flags it; setting it again is refused", async () => {
    const server = await newStdioServer("exp");
    const project = await newProject();
    const expired = await expiredRelaxation("project", project);
    expect(await personCall(server, project)).toMatchObject({ kind: "required", requiredClass: "microvm", requiredBy: "unknown_agent", relaxation: null });
    const view = await app.inject({ method: "GET", url: "/v1/execution-project-sensitivities", headers: adminAuth });
    expect(view.statusCode, view.body).toBe(200);
    expect((view.json().projects as Array<{ projectId: string; personStdioRelaxationId: string | null }>).find((p) => p.projectId === project)).toMatchObject({ personStdioRelaxationId: null });
    const listed = await app.inject({ method: "GET", url: "/v1/execution-person-stdio-relaxations", headers: adminAuth });
    expect(listed.json().expiresAfterDays).toBe(30);
    expect(listed.json().relaxations).toEqual(expect.arrayContaining([expect.objectContaining({ id: expired.id, expired: true, expiresAt: expired.expiresAt.toISOString() })]));
    // setting it again: the expired row is still uncleared, so a set is refused (the admin renews instead), before any step-up
    const again = await app.inject({ method: "PUT", url: url("project", project), headers: adminAuth, payload: { relaxed: true } });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ error: "relaxation_expired", relaxation: { id: expired.id, expired: true } });
    // an unexpired relaxation on the same kind of call is L2 (the control: the expiry is what made it L3)
    const live = await newProject();
    const { res } = await put(url("project", live), relaxFacts("project", live), { relaxed: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().relaxation).toMatchObject({ expired: false });
    expect(Date.parse(res.json().relaxation.expiresAt) - Date.parse(res.json().relaxation.createdAt)).toBe(30 * DAY);
    expect(await personCall(server, live)).toMatchObject({ requiredClass: "user_space_kernel", relaxation: { relaxationId: res.json().relaxation.id } });
  });
});

describe("ADR-0197 Q3: renewal is a step-up, audited", () => {
  it("refused with no grant or another act's grant (not spent); the exact grant renews it for 30 days and the call is L2 again", async () => {
    const server = await newStdioServer("renew");
    const project = await newProject();
    const expired = await expiredRelaxation("mcp_server", server);
    const renewUrl = url("mcp_server", server);
    // an API key can never step up
    const key = await app.inject({ method: "PUT", url: renewUrl, headers: adminAuth, payload: { relaxed: true, renew: true } });
    expect(key.statusCode, key.body).toBe(403);
    expect(key.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", action: { body: renewFacts(expired.id, "mcp_server", server).facts } });
    // the set's grant, a renewal grant for another row or another program, a grant of another kind: refused, unspent
    for (const args of [
      relaxFacts("mcp_server", server),
      renewFacts(randomUUID(), "mcp_server", server),
      { kind: "settings_relax" as const, facts: { ...renewFacts(expired.id, "mcp_server", server).facts, stdioCommandDigest: "1".repeat(64) } },
      { kind: "key_management" as const, facts: renewFacts(expired.id, "mcp_server", server).facts },
    ]) {
      const { g, res } = await put(renewUrl, args, { relaxed: true, renew: true });
      expect(res.statusCode, `${args.kind} ${JSON.stringify(args.facts)}: ${res.body}`).toBe(422);
      expect(await grantSpent(db, g.grantId)).toBe(false);
    }
    expect(await rowOf(expired.id)).toMatchObject({ renewedAt: null, expiresAt: expired.expiresAt });
    expect(await personCall(server, project)).toMatchObject({ requiredClass: "microvm", relaxation: null });

    const { g, res } = await put(renewUrl, renewFacts(expired.id, "mcp_server", server), { relaxed: true, renew: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ changed: true, renewed: true, relaxation: { id: expired.id, expired: false, renewedByUserId: adminId } });
    expect(await grantSpent(db, g.grantId)).toBe(true);
    const row = await rowOf(expired.id);
    expect(row.renewedByUserId).toBe(adminId);
    expect(row.expiresAt.getTime() - row.renewedAt!.getTime()).toBe(30 * DAY);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-person-stdio-relaxation-renewed"), eq(auditLog.objectId, server))).orderBy(desc(auditLog.seq)).limit(1);
    expect(audit).toMatchObject({ userId: adminId, objectType: "mcp_server", effect: "allow" });
    expect(audit!.detail).toMatchObject({ relaxationId: expired.id, previousExpiresAt: expired.expiresAt.toISOString(), expiresAt: row.expiresAt.toISOString(), stepUp: "totp", stdioCommandDigest: PROGRAM });
    // the same relaxation id applies again
    expect(await personCall(server, project)).toMatchObject({ requiredClass: "user_space_kernel", relaxation: { relaxationId: expired.id, scopeKind: "mcp_server" } });
  });

  it("renewing where there is nothing to renew is refused; renew is only for a relaxation", async () => {
    const project = await newProject();
    const none = await app.inject({ method: "PUT", url: url("project", project), headers: adminAuth, payload: { relaxed: true, renew: true } });
    expect(none.statusCode, none.body).toBe(404);
    expect(none.json().error).toBe("no_relaxation");
    expect(setPersonStdioRelaxationSchema.safeParse({ relaxed: false, renew: true }).success).toBe(false);
    expect(setPersonStdioRelaxationSchema.safeParse({ relaxed: true, renew: false }).success).toBe(false);
    expect(setPersonStdioRelaxationSchema.safeParse({ relaxed: true, renew: true }).success).toBe(true);
  });
});

describe("ADR-0197 Q3: the Decision BOM record shows the expiry", () => {
  it("an expired relaxation's record carries its past expiry; a renewed one its new expiry and who renewed it", async () => {
    const project = await newProject();
    const expired = await expiredRelaxation("project", project);
    const doc = { execution: { relaxation: { kind: "person_stdio_l2", subjectKind: "interactive_person", relaxationId: expired.id, scopeKind: "project", scopeId: project } } };
    const before = await decisionExecutionRelaxationRecord(db, doc);
    expect(decisionExecutionRelaxationRecordSchema.parse(before)).toEqual(before);
    expect(before).toMatchObject({ id: expired.id, expiresAt: expired.expiresAt.toISOString(), renewedBy: null, renewedAt: null, clearedAt: null });
    expect(Date.parse(before!.expiresAt!)).toBeLessThan(Date.now());

    const { res } = await put(url("project", project), renewFacts(expired.id, "project", project), { relaxed: true, renew: true });
    expect(res.statusCode, res.body).toBe(200);
    const after = await decisionExecutionRelaxationRecord(db, doc);
    expect(decisionExecutionRelaxationRecordSchema.parse(after)).toEqual(after);
    expect(after).toMatchObject({ id: expired.id, renewedBy: adminId });
    expect(Date.parse(after!.expiresAt!)).toBeGreaterThan(Date.now() + 29 * DAY);
    // NEGATIVE CONTROLS on the contract: a renewal without its actor, an expiry before the set
    expect(decisionExecutionRelaxationRecordSchema.safeParse({ ...after, renewedBy: null }).success).toBe(false);
    expect(decisionExecutionRelaxationRecordSchema.safeParse({ ...after, expiresAt: after!.setAt }).success).toBe(false);
  });
});
