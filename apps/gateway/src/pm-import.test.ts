import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, desc, eq, onboardingImports, pmImportedWorkItems, runMigrations, type Db } from "@regulait/db";
import { resolvePmProvider, type MockPmProvider } from "@regulait/pm-provider";
import { buildApp } from "./app.js";
import { itemProblem, planPmImport } from "./pm-import.js";

/**
 * ADR-0289 — the PM project / work-item importer (ADR-0054 §3).
 *
 * Claims:
 *  1. A dry run (the default) previews the diff and writes nothing but the
 *     onboarding_imports record and an audit row.
 *  2. Apply must carry the dry run's planSha256; a stale one is a 409
 *     `plan_changed` carrying the new plan, and nothing is written.
 *  3. Apply records linkage (id, url, type) and the connection→Initiative
 *     mapping; re-running is idempotent; an item gone from the tool is marked
 *     missing (never deleted) and re-appearing clears it.
 *  4. Refused whole, recorded and audited: an over-large project, a malformed
 *     or unsafe item, and an adapter that cannot list.
 *  5. Admin only.
 *
 * Shares one database with the other gateway suites; objects are prefixed pmi-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "pmi-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const PROJECT = `pmi-project-${Date.now()}`;
const CONN = `pmi-mock-${Date.now()}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockPmProvider;

const importPm = (payload: Record<string, unknown>, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url: "/v1/onboarding/imports/pm", headers, payload });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  mock = resolvePmProvider({ provider: "mock", token: "" }) as MockPmProvider;
  for (let i = 0; i < 3; i++) await mock.createWorkItem(PROJECT, i === 2 ? "Bug" : "Task", { title: `pmi item ${i}` });
  const c = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/pm/connections",
    payload: { name: CONN, provider: "mock", project: PROJECT, token: "pmi-secret" },
  });
  expect(c.statusCode, c.body).toBe(201);
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("the planner (pure)", () => {
  const connection = { id: "c", name: "c", provider: "mock", project: "p" };
  it("classifies add, update, reappeared, unchanged, missing and the initiative action; the fingerprint covers the whole plan", () => {
    const plan = planPmImport({
      connection,
      initiative: { id: "i1", name: "x" },
      currentInitiativeId: "i0",
      listed: [
        { id: "1", url: "https://t/1", type: "Task" },
        { id: "2", url: "https://t/2b", type: "Task" },
        { id: "3", url: "https://t/3", type: "Task" },
        { id: "5", url: "https://t/5", type: "Task" },
      ],
      existing: [
        { id: "r2", externalId: "2", externalUrl: "https://t/2", itemType: "Task", missingSince: null },
        { id: "r3", externalId: "3", externalUrl: "https://t/3", itemType: "Task", missingSince: new Date() },
        { id: "r4", externalId: "4", externalUrl: "https://t/4", itemType: "Task", missingSince: null },
        { id: "r5", externalId: "5", externalUrl: "https://t/5", itemType: "Task", missingSince: null },
        { id: "r6", externalId: "6", externalUrl: "https://t/6", itemType: "Task", missingSince: new Date() },
      ],
    });
    expect(plan.counts).toEqual({ listed: 4, add: 1, update: 1, reappeared: 1, unchanged: 1, missing: 1, stillMissing: 1 });
    expect(plan.initiative.action).toBe("remap");
    const again = planPmImport({ connection, initiative: { id: "i1", name: "x" }, currentInitiativeId: "i0", listed: [], existing: [] });
    expect(again.planSha256).not.toBe(plan.planSha256);
  });

  it("refuses unsafe items", () => {
    expect(itemProblem({ id: "1", url: "javascript:alert(1)", type: "Task" }, "jira")).toMatch(/scheme/);
    expect(itemProblem({ id: "1", url: "mock-pm://p/items/1", type: "Task" }, "jira")).toMatch(/scheme/);
    expect(itemProblem({ id: "1", url: "mock-pm://p/items/1", type: "Task" }, "mock")).toBeNull();
    expect(itemProblem({ id: "a\nb", url: "https://x", type: "Task" }, "jira")).toMatch(/id/);
    expect(itemProblem({ id: "1", url: "https://x", type: "t".repeat(129) }, "jira")).toMatch(/type/);
  });
});

describe("dry run, then apply what was previewed", () => {
  let planSha: string;

  it("a dry run is the default and writes no linkage", async () => {
    const r = await importPm({ connectionName: CONN, initiative: { name: `${CONN}-initiative` } });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.mode).toBe("dry_run");
    expect(b.plan.counts).toMatchObject({ listed: 3, add: 3, missing: 0 });
    expect(b.plan.initiative.action).toBe("create");
    planSha = b.plan.planSha256;
    const [row] = await db.select().from(onboardingImports).where(eq(onboardingImports.id, b.importId));
    expect(row).toMatchObject({ kind: "pm_work_items", mode: "dry_run", status: "planned" });
    const linkage = await db.select().from(pmImportedWorkItems).where(eq(pmImportedWorkItems.externalUrl, `mock-pm://${PROJECT}/items/1`));
    expect(linkage).toEqual([]);
  });

  it("apply without a plan is refused", async () => {
    const r = await importPm({ connectionName: CONN, initiative: { name: `${CONN}-initiative` }, mode: "apply" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("plan_required");
  });

  it("apply with a stale plan is a 409 carrying the new plan, and writes nothing", async () => {
    await mock.createWorkItem(PROJECT, "Task", { title: "pmi item 3" });
    const r = await importPm({ connectionName: CONN, initiative: { name: `${CONN}-initiative` }, mode: "apply", planSha256: planSha });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("plan_changed");
    expect(r.json().plan.counts.add).toBe(4);
    planSha = r.json().plan.planSha256;
    const written = await db.select().from(pmImportedWorkItems).where(eq(pmImportedWorkItems.externalUrl, `mock-pm://${PROJECT}/items/1`));
    expect(written).toEqual([]);
  });

  it("apply with the previewed plan records linkage and the Initiative mapping", async () => {
    const r = await importPm({ connectionName: CONN, initiative: { name: `${CONN}-initiative` }, mode: "apply", planSha256: planSha });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().plan.counts.add).toBe(4);
    const items = await app.inject({ method: "GET", headers: AUTH, url: `/v1/onboarding/imports/pm/items?connectionName=${CONN}&limit=3` });
    expect(items.statusCode).toBe(200);
    const page = items.json();
    expect(page.initiative.name).toBe(`${CONN}-initiative`);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items[0]).not.toHaveProperty("title");
    const next = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/onboarding/imports/pm/items?connectionName=${CONN}&limit=3&cursor=${page.nextCursor}`,
    });
    expect(next.json().items).toHaveLength(1);
    expect(next.json().nextCursor).toBeNull();
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "onboarding-import-applied"), eq(auditLog.objectId, r.json().importId)))
      .orderBy(desc(auditLog.at));
    expect(a?.effect).toBe("allow");
  });

  it("re-running is idempotent; a deleted item is marked missing, never removed", async () => {
    await mock.deleteWorkItem(PROJECT, "1");
    const dry = await importPm({ connectionName: CONN, initiative: { name: `${CONN}-initiative` } });
    expect(dry.json().plan.counts).toMatchObject({ add: 0, missing: 1, unchanged: 3 });
    expect(dry.json().plan.initiative.action).toBe("unchanged");
    const apply = await importPm({
      connectionName: CONN,
      initiative: { name: `${CONN}-initiative` },
      mode: "apply",
      planSha256: dry.json().plan.planSha256,
    });
    expect(apply.statusCode, apply.body).toBe(200);
    const rows = await db.select().from(pmImportedWorkItems).where(eq(pmImportedWorkItems.externalUrl, `mock-pm://${PROJECT}/items/1`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.missingSince).not.toBeNull();
    const third = await importPm({ connectionName: CONN, initiative: { name: `${CONN}-initiative` } });
    expect(third.json().plan.counts).toMatchObject({ add: 0, update: 0, missing: 0, stillMissing: 1, unchanged: 3 });
  });
});

describe("refused whole, recorded and audited", () => {
  it("a project larger than maxItems", async () => {
    const r = await importPm({ connectionName: CONN, initiative: { name: `${CONN}-initiative` }, maxItems: 2 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("pm_import_too_large");
    const [row] = await db.select().from(onboardingImports).where(eq(onboardingImports.id, r.json().importId));
    expect(row?.status).toBe("refused");
  });

  it("an unknown initiative id and an unknown connection", async () => {
    const a = await importPm({ connectionName: CONN, initiative: { id: "00000000-0000-4000-8000-000000000000" } });
    expect(a.statusCode).toBe(404);
    const b = await importPm({ connectionName: "pmi-nope", initiative: { name: "x" } });
    expect(b.statusCode).toBe(404);
  });

  it("extra body fields are rejected (strict schema)", async () => {
    const r = await importPm({ connectionName: CONN, initiative: { name: "x" }, isAdmin: true });
    expect(r.statusCode).toBe(422);
  });

  it("a non-admin cannot import", async () => {
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `pmi-${Date.now()}@example.com`, displayName: "pmi" } });
    const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "pmi" } });
    const r = await importPm({ connectionName: CONN, initiative: { name: "x" } }, { authorization: `Bearer ${k.json().token}` });
    expect(r.statusCode).toBe(403);
    const g = await app.inject({ method: "GET", headers: { authorization: `Bearer ${k.json().token}` }, url: `/v1/onboarding/imports/pm/items?connectionName=${CONN}` });
    expect(g.statusCode).toBe(403);
  });
});
