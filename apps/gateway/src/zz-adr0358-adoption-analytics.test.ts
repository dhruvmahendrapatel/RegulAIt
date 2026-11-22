/**
 * ADR-0358 (lane E39) — AI adoption analytics, end to end (real database, real app).
 *
 *  - metered active users per tool and bucket, grouped by team or project, from usage_events only; gateway-internal
 *    rows (guardrail scorers) and the nil identity are not adoption;
 *  - small cohorts are suppressed (count, calls and utilisation), at the strict default of 5;
 *  - top tools: metered ranking and, separately, imported vendors; no field adds the two;
 *  - seats: licensed, active, idle, active without a seat, from applied, unsuperseded imported lines; a vendor with no
 *    usage lines reads activityKnown false and utilisation null (never 0); a revoked batch and a superseded line count
 *    for nothing;
 *  - the per-person view is refused by default; turning it on is a relaxation (refused through an API key under the
 *    strict step-up posture, then audited with the reason); each read of it is audited;
 *  - pagination (limit + nextOffset), the window bounds, and every route admin-only.
 *
 * All seeded data sits in 2001 so other suites' rows never enter the window. Everything is removed in afterAll and the
 * policy row is put back to the strict defaults.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  adoptionAnalyticsPolicy,
  agents,
  and,
  auditLog,
  connectors,
  costImportBatches,
  createDb,
  desc,
  eq,
  importedCostLines,
  inArray,
  projects,
  runMigrations,
  teamMembers,
  teams,
  usageEvents,
  withPrincipal,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e39-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const WINDOW = "from=2001-03-01T00:00:00Z&to=2001-04-01T00:00:00Z";
const VENDOR = `e39-copilot-${RUN}`;
const VENDOR_SEATS_ONLY = `e39-seatsonly-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
let memberId: string;
let adminId: string;
const people: string[] = [];
let teamBig: string;
let teamSmall: string;
let projectId: string;
let agentId: string;
let connectorId: string;
const batchIds: string[] = [];
let restoreIdentity: (() => Promise<void>) | undefined;

const get = (url: string, headers = adminKey) => app.inject({ method: "GET", url, headers });
const put = (url: string, payload: unknown, headers = adminKey) => app.inject({ method: "PUT", url, headers, payload: payload as object });

async function batch(status: "applied" | "revoked") {
  const [b] = await db
    .insert(costImportBatches)
    .values({
      adapter: "seat_roster",
      vendor: VENDOR,
      format: "csv",
      mode: "apply",
      status,
      payloadSha256: randomBytes(32).toString("hex"),
      refusals: [],
      summary: {},
      ruleId: "test",
      reason: "e39 fixture",
    })
    .returning({ id: costImportBatches.id });
  batchIds.push(b!.id);
  return b!.id;
}

function line(batchId: string, vendor: string, account: string, kind: "seat" | "usage", amount: number, quantity: number | null = null) {
  return {
    batchId,
    vendor,
    adapter: "seat_roster",
    sourceRow: 1,
    accountRef: account,
    accountKey: account,
    resolutionMethod: "unresolved" as const,
    resolutionDetail: "fixture",
    periodStart: new Date("2001-03-01T00:00:00Z"),
    periodEnd: new Date("2001-04-01T00:00:00Z"),
    amount,
    billingKind: kind,
    quantity,
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.delete(adoptionAnalyticsPolicy);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  await app.ready();
  const mk = async (k: string, isAdmin = false) => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e39-${k}-${RUN}@example.com`, displayName: `e39 ${k}`, isAdmin } });
    expect(u.statusCode, u.body).toBe(201);
    return u.json().id as string;
  };
  adminId = await mk("admin", true);
  adminKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
  memberId = await mk("member");
  memberKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${memberId}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
  for (let i = 0; i < 7; i++) people.push(await mk(`p${i}`));

  teamBig = (await db.insert(teams).values({ name: `e39-big-${RUN}` }).returning())[0]!.id;
  teamSmall = (await db.insert(teams).values({ name: `e39-small-${RUN}` }).returning())[0]!.id;
  await db.insert(teamMembers).values([
    ...people.slice(0, 6).map((userId) => ({ teamId: teamBig, userId })),
    { teamId: teamSmall, userId: people[6]! },
  ]);
  projectId = (await db.insert(projects).values({ name: `e39-proj-${RUN}` }).returning())[0]!.id;
  agentId = (await db.insert(agents).values({ name: `e39-agent-${RUN}`, provider: "mock", tier: 1 }).returning())[0]!.id;
  connectorId = randomUUID(); // a deleted (or never stored) connector: its name reads null

  const at = (d: number) => new Date(Date.UTC(2001, 2, d, 12));
  const rows: Array<typeof usageEvents.$inferInsert> = [];
  // the agent: all seven people in week of March 5, two calls each; six of them again on March 20
  for (const userId of people) rows.push({ userId, at: at(6), objectType: "agent", agentId, projectId }, { userId, at: at(7), objectType: "agent", agentId, projectId });
  for (const userId of people.slice(0, 6)) rows.push({ userId, at: at(20), objectType: "agent", agentId });
  // the connector: two people only (a small cohort)
  for (const userId of people.slice(0, 2)) rows.push({ userId, at: at(6), objectType: "connector", connectorId });
  // not adoption: a guardrail scorer row, and the nil identity
  rows.push({ userId: people[0]!, at: at(6), objectType: "guardrail_scorer", operation: "x" });
  rows.push({ userId: "00000000-0000-0000-0000-000000000000", at: at(6), objectType: "agent", agentId });
  await db.insert(usageEvents).values(rows);

  // imported: 6 seats; 4 of them used; 1 usage with no seat; a zero-quantity usage line is not activity
  const applied = await batch("applied");
  const seats = Array.from({ length: 6 }, (_, i) => line(applied, VENDOR, `acct${i}@e39.test`, "seat", 19));
  const usage = [0, 1, 2, 3].map((i) => line(applied, VENDOR, `acct${i}@e39.test`, "usage", 0, 10));
  usage.push(line(applied, VENDOR, `acct4@e39.test`, "usage", 0, 0));
  usage.push(line(applied, VENDOR, `extra@e39.test`, "usage", 1.5));
  const seatsOnly = Array.from({ length: 5 }, (_, i) => line(applied, VENDOR_SEATS_ONLY, `s${i}@e39.test`, "seat", 10));
  await db.insert(importedCostLines).values([...seats, ...usage, ...seatsOnly]);
  // a superseded usage line for acct5 and a revoked batch's usage for acct5: neither makes acct5 active
  const [sup] = await db.insert(importedCostLines).values(line(applied, VENDOR, "acct5@e39.test", "usage", 5)).returning({ id: importedCostLines.id });
  await db.update(importedCostLines).set({ supersededAt: new Date(), supersededReason: "fixture" }).where(eq(importedCostLines.id, sup!.id));
  const revoked = await batch("revoked");
  await db.insert(importedCostLines).values(line(revoked, VENDOR, "acct5@e39.test", "usage", 5));
}, 120_000);

afterAll(async () => {
  await db.delete(usageEvents).where(inArray(usageEvents.userId, people));
  await db.delete(usageEvents).where(eq(usageEvents.agentId, agentId));
  if (batchIds.length) await db.delete(costImportBatches).where(inArray(costImportBatches.id, batchIds));
  await db.delete(teams).where(inArray(teams.id, [teamBig, teamSmall]));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(adoptionAnalyticsPolicy);
  await restoreIdentity?.();
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0358 adoption analytics", () => {
  it("is admin-only on every route", async () => {
    for (const url of ["/v1/adoption/active-users", "/v1/adoption/top-tools", "/v1/adoption/seats", "/v1/adoption/people", "/v1/adoption/policy"]) {
      expect((await get(url, memberKey)).statusCode, url).toBe(403);
    }
    expect((await put("/v1/adoption/policy", { perPersonRanking: true, reason: "x" }, memberKey)).statusCode).toBe(403);
  });

  it("reads the strict defaults with no policy row", async () => {
    const r = await get("/v1/adoption/policy");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ perPersonRanking: false, minCohortSize: 5, strictDefault: true, updatedAt: null });
  });

  it("counts metered active users per tool and week, suppressing a small cohort", async () => {
    const r = await get(`/v1/adoption/active-users?${WINDOW}&bucket=week`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.source).toBe("metered");
    const items = body.items as Array<{ bucketStart: string; tool: { kind: string; id: string; name: string | null }; activeUsers: number | null; calls: number | null; suppressed: boolean }>;
    const agentWeeks = items.filter((i) => i.tool.id === agentId);
    expect(agentWeeks.map((w) => [w.bucketStart, w.activeUsers, w.calls])).toEqual([
      ["2001-03-19", 6, 6],
      ["2001-03-05", 7, 14],
    ]);
    expect(agentWeeks[0]!.tool).toMatchObject({ kind: "agent", name: `e39-agent-${RUN}` });
    const conn = items.find((i) => i.tool.id === connectorId)!;
    expect(conn).toMatchObject({ activeUsers: null, calls: null, suppressed: true, tool: { kind: "connector", name: null } });
    // the nil identity and the scorer row are not adoption; no user id is returned anywhere
    expect(items.every((i) => i.tool.kind !== "guardrail_scorer")).toBe(true);
    for (const p of people) expect(r.body).not.toContain(p);
  });

  it("groups by team (small team suppressed) and by project", async () => {
    const byTeam = (await get(`/v1/adoption/active-users?${WINDOW}&bucket=month&groupBy=team&toolKind=agent`)).json().items as Array<{ group: { id: string; name: string }; activeUsers: number | null; suppressed: boolean }>;
    expect(byTeam.find((g) => g.group.id === teamBig)).toMatchObject({ activeUsers: 6, group: { name: `e39-big-${RUN}` } });
    expect(byTeam.find((g) => g.group.id === teamSmall)).toMatchObject({ activeUsers: null, suppressed: true });
    const byProject = (await get(`/v1/adoption/active-users?${WINDOW}&bucket=month&groupBy=project&toolId=${agentId}`)).json().items as Array<{ group: { id: string | null; name: string | null }; activeUsers: number | null }>;
    expect(byProject.find((g) => g.group.id === projectId)).toMatchObject({ activeUsers: 7, group: { name: `e39-proj-${RUN}` } });
    expect(byProject.find((g) => g.group.id === null)).toMatchObject({ activeUsers: 6 });
  });

  it("paginates with limit and nextOffset", async () => {
    const p1 = (await get(`/v1/adoption/active-users?${WINDOW}&bucket=week&limit=10`)).json();
    expect(p1.items.length).toBeLessThanOrEqual(10);
    const all = (await get(`/v1/adoption/active-users?${WINDOW}&bucket=day&limit=10`)).json();
    expect(all.nextOffset).toBeNull();
    expect((await get(`/v1/adoption/active-users?${WINDOW}&limit=7`)).statusCode).toBe(400);
  });

  it("bounds the window", async () => {
    expect((await get("/v1/adoption/active-users?from=2001-01-01T00:00:00Z&to=2002-06-01T00:00:00Z")).json().error).toBe("bad_window");
    expect((await get("/v1/adoption/active-users?from=2001-01-01T00:00:00Z&to=2001-12-01T00:00:00Z&bucket=day")).statusCode).toBe(400);
    expect((await get("/v1/adoption/active-users?from=2001-04-01T00:00:00Z&to=2001-03-01T00:00:00Z")).statusCode).toBe(400);
    expect((await get(`/v1/adoption/active-users?${WINDOW}&nope=1`)).json().error).toBe("invalid_query");
  });

  it("ranks top tools (metered) and imported vendors in separate blocks", async () => {
    const body = (await get(`/v1/adoption/top-tools?${WINDOW}`)).json();
    expect(body.metered.items[0]).toMatchObject({ rank: 1, tool: { id: agentId }, activeUsers: 7, calls: 20 });
    const vendor = (body.imported.items as Array<{ vendor: string; activeAccounts: number | null }>).find((v) => v.vendor === VENDOR);
    expect(vendor).toMatchObject({ activeAccounts: 5 });
    expect(Object.keys(body)).not.toContain("total");
  });

  it("computes seat utilisation from live imported lines only", async () => {
    const items = (await get(`/v1/adoption/seats?${WINDOW}`)).json().items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.vendor === VENDOR)).toMatchObject({
      licensed: 6,
      activeLicensed: null, // 4 would be fine, but idle (2) is below the cohort, and either gives the other back
      idleLicensed: null,
      utilisation: null,
      activityKnown: true,
      suppressed: true,
    });
    expect(items.find((i) => i.vendor === VENDOR_SEATS_ONLY)).toMatchObject({ licensed: 5, activityKnown: false, utilisation: null });
  });

  it("refuses the per-person view by default, and relaxing needs a step-up then is audited", async () => {
    expect((await get(`/v1/adoption/people?${WINDOW}`)).json().error).toBe("per_person_ranking_disabled");
    // strict step-up posture: an API key cannot relax
    const refused = await put("/v1/adoption/policy", { perPersonRanking: true, minCohortSize: 1, reason: "pilot review" });
    expect(refused.statusCode).not.toBe(200);
    expect((await get("/v1/adoption/policy")).json().perPersonRanking).toBe(false);
    // tightening is not a relaxation and needs no step-up
    const tighter = await put("/v1/adoption/policy", { minCohortSize: 8, reason: "tighter" });
    expect(tighter.statusCode, tighter.body).toBe(200);
    expect(tighter.json()).toMatchObject({ minCohortSize: 8, strictDefault: true });

    const restoreStepUp = await relaxStepUpForTest(db);
    try {
      const ok = await put("/v1/adoption/policy", { perPersonRanking: true, minCohortSize: 1, reason: "pilot review" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ perPersonRanking: true, minCohortSize: 1, strictDefault: false });
      const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "adoption-policy-set"), eq(auditLog.userId, adminId))).orderBy(desc(auditLog.at)).limit(1);
      expect(audit!.reason).toContain("RELAXED");
      expect(audit!.reason).toContain("pilot review");
      expect(audit!.detail).toMatchObject({ from: { perPersonRanking: false, minCohortSize: 8 }, to: { perPersonRanking: true, minCohortSize: 1 }, relaxed: true });
    } finally {
      await restoreStepUp();
    }

    const people1 = await get(`/v1/adoption/people?${WINDOW}&toolId=${agentId}&limit=10`);
    expect(people1.statusCode, people1.body).toBe(200);
    const items = people1.json().items as Array<{ rank: number; user: { id: string }; calls: number; activeDays: number }>;
    expect(items).toHaveLength(7);
    expect(items[0]).toMatchObject({ rank: 1, calls: 3, activeDays: 3 });
    expect(people.includes(items[6]!.user.id)).toBe(true);
    const [read] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "adoption-people-read"), eq(auditLog.userId, adminId))).orderBy(desc(auditLog.at)).limit(1);
    expect(read!.detail).toMatchObject({ rows: 7, people: 7 });

    // with the cohort at 1, nothing is suppressed
    const seats = (await get(`/v1/adoption/seats?${WINDOW}&vendor=${VENDOR}`)).json().items[0];
    expect(seats).toMatchObject({ licensed: 6, activeLicensed: 4, idleLicensed: 2, activeWithoutSeat: 1, utilisation: 0.6667, suppressed: false });
  });

  it("row-level security admits an admin principal only on the policy table", async () => {
    await db.insert(adoptionAnalyticsPolicy).values({ id: "singleton" }).onConflictDoNothing();
    const asMember = await withPrincipal(db, { userId: memberId }, (tx) => tx.select().from(adoptionAnalyticsPolicy));
    expect(asMember).toHaveLength(0);
    await expect(
      withPrincipal(db, { userId: memberId }, (tx) => tx.update(adoptionAnalyticsPolicy).set({ perPersonRanking: true }).returning()),
    ).resolves.toHaveLength(0);
    const asAdmin = await withPrincipal(db, { userId: adminId }, (tx) => tx.select().from(adoptionAnalyticsPolicy));
    expect(asAdmin).toHaveLength(1);
  });

  it("validates the policy body", async () => {
    expect((await put("/v1/adoption/policy", { reason: "nothing" })).statusCode).toBe(400);
    expect((await put("/v1/adoption/policy", { minCohortSize: 0, reason: "x" })).statusCode).toBe(400);
    expect((await put("/v1/adoption/policy", { perPersonRanking: false })).statusCode).toBe(400);
  });
});
