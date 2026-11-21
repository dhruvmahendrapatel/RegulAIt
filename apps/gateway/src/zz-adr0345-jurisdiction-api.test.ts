/**
 * ADR-0345 §9 (lane E26) slice 3b — the jurisdiction admin APIs, through the real app.
 *
 *  - jurisdictions: add (no step-up, audited); rename (no step-up); `code` cannot change (#1036); a parent cycle is
 *    refused; dropping a parent or the global flag narrows, so it needs a `settings_relax` step-up; removal needs
 *    one too, and is refused while a use case or a child names it;
 *  - obligations: the feed key must exist, be live and name the jurisdiction (#1037); raising a floor needs no
 *    step-up, lowering one or removing the obligation does;
 *  - a use case's declared jurisdictions: the first declaration narrows "every jurisdiction" (step-up), adding one
 *    widens (none), removing one narrows (step-up); an unknown code is 400;
 *  - NEGATIVE: a non-admin is refused; an API key cannot narrow anything, and a refused narrowing writes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCaseJurisdictions,
  aiUseCases,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  jurisdictionObligations,
  jurisdictions,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { AGENT_RISK_KEYS, BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { JURISDICTION_AUDIT_RULES, obligationFeedProblem } from "./jurisdiction-routes.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const LETTERS = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const BOOT = `e26-jur-boot-${LETTERS}`;
const boot = { authorization: `Bearer ${BOOT}` };
const TEST = `Zt${LETTERS}`;
const CHILD = `Zc${LETTERS}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
let useCaseId: string;
const restores: Array<() => Promise<void>> = [];
const createdObligations: string[] = [];

const relax = (values: Record<string, unknown>) => ({ kind: "settings_relax" as const, facts: { values } });
const asAdminStepped = async (values: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, relax(values)));
const lastAudit = async (ruleId: string) => (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1))[0]!;

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT, retry: { maxAttempts: 1 } });
  await app.ready();
  const a = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `e26-jur-admin-${LETTERS}@example.test`, displayName: "E26 jurisdiction admin" } });
  adminId = a.json().id;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: boot, payload: { name: "e26j" } })).json().token}` };
  const m = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `e26-jur-member-${LETTERS}@example.test`, displayName: "E26 jurisdiction member" } });
  memberKey = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${m.json().id}/keys`, headers: boot, payload: { name: "e26jm" } })).json().token}` };
  const [uc] = await db
    .insert(aiUseCases)
    .values({ name: `e26 geography ${LETTERS}`, description: "e26", ownerUserId: adminId, businessContext: "e26", dataSensitivity: "internal", intendedAgentIds: [] })
    .returning({ id: aiUseCases.id });
  useCaseId = uc!.id;
}, 120_000);

afterAll(async () => {
  // only this suite's own fixtures
  await db.delete(aiUseCaseJurisdictions).where(eq(aiUseCaseJurisdictions.useCaseId, useCaseId));
  await db.delete(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  for (const id of createdObligations) await db.delete(jurisdictionObligations).where(eq(jurisdictionObligations.id, id));
  await db.delete(jurisdictions).where(eq(jurisdictions.code, CHILD));
  await db.delete(jurisdictions).where(eq(jurisdictions.code, TEST));
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

describe("ADR-0345 §9 slice 3b: jurisdictions", () => {
  it("lists the seeded jurisdictions with their obligations", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/jurisdictions?limit=200", headers: adminKey });
    expect(r.statusCode, r.body).toBe(200);
    const eu = r.json().jurisdictions.find((j: { code: string }) => j.code === "EU");
    expect(eu.obligations.length).toBeGreaterThan(0);
  });

  it("adds a jurisdiction without a step-up, audited; a duplicate is 409 and an unknown parent 400", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/jurisdictions", headers: adminKey, payload: { code: TEST, name: "Test land", parentCode: "US", reason: "testing" } });
    expect(r.statusCode, r.body).toBe(201);
    expect((await lastAudit(JURISDICTION_AUDIT_RULES.created)).detail).toMatchObject({ code: TEST, reason: "testing" });
    expect((await app.inject({ method: "POST", url: "/v1/jurisdictions", headers: adminKey, payload: { code: TEST, name: "again", reason: "x" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/v1/jurisdictions", headers: adminKey, payload: { code: `Zq${LETTERS}`, name: "x", parentCode: "Nowhere", reason: "x" } })).statusCode).toBe(400);
  });

  it("a rename needs no step-up; the code cannot be changed (#1036); a parent cycle is refused", async () => {
    expect((await app.inject({ method: "PATCH", url: `/v1/jurisdictions/${TEST}`, headers: adminKey, payload: { name: "Test land renamed", reason: "typo" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/v1/jurisdictions/${TEST}`, headers: adminKey, payload: { code: "Other", reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/jurisdictions", headers: adminKey, payload: { code: CHILD, name: "Child", parentCode: TEST, reason: "testing" } })).statusCode).toBe(201);
    const cycle = await app.inject({ method: "PATCH", url: `/v1/jurisdictions/${TEST}`, headers: adminKey, payload: { parentCode: CHILD, reason: "x" } });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error).toBe("parent_cycle");
  });

  it("dropping a parent narrows: refused with an API key (nothing written), done with a step-up bound to it", async () => {
    const refused = await app.inject({ method: "PATCH", url: `/v1/jurisdictions/${TEST}`, headers: adminKey, payload: { parentCode: null, reason: "standalone" } });
    expect(refused.statusCode).toBe(403);
    expect((await db.select().from(jurisdictions).where(eq(jurisdictions.code, TEST)))[0]!.parentCode).toBe("US");
    const ok = await app.inject({
      method: "PATCH",
      url: `/v1/jurisdictions/${TEST}`,
      ...(await asAdminStepped({ [`jurisdictions.${TEST}.parentCode`]: null })),
      payload: { parentCode: null, reason: "standalone" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().relaxed).toEqual([`jurisdictions.${TEST}.parentCode`]);
    // re-attaching it widens again: no step-up
    expect((await app.inject({ method: "PATCH", url: `/v1/jurisdictions/${TEST}`, headers: adminKey, payload: { parentCode: "US", reason: "back" } })).statusCode).toBe(200);
  });

  it("removal needs a step-up and is refused while a child names it", async () => {
    expect((await app.inject({ method: "DELETE", url: `/v1/jurisdictions/${TEST}`, headers: adminKey, payload: { reason: "x" } })).json().error).toBe("jurisdiction_has_children");
    expect((await app.inject({ method: "DELETE", url: `/v1/jurisdictions/${CHILD}`, headers: adminKey, payload: { reason: "gone" } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "DELETE", url: `/v1/jurisdictions/${CHILD}`, ...(await asAdminStepped({ [`jurisdictions.${CHILD}.deleted`]: true })), payload: { reason: "gone" } });
    expect(ok.statusCode, ok.body).toBe(204);
    expect((await lastAudit(JURISDICTION_AUDIT_RULES.deleted)).detail).toMatchObject({ code: CHILD, reason: "gone" });
  });
});

describe("ADR-0345 §9 slice 3b: obligations", () => {
  it("NEGATIVE: an unknown, withdrawn or other-jurisdiction feed key is refused (#1037)", async () => {
    expect(obligationFeedProblem("no-such-key", "EU")).toBe("unknown_feed_key");
    expect(obligationFeedProblem("cfpb-adverse-action-ai", "US")).toBe("withdrawn_feed_key");
    expect(obligationFeedProblem("nyc-local-law-144", "EU")).toBe("feed_key_other_jurisdiction");
    for (const [code, key, error] of [
      ["US", "no-such-key", "unknown_feed_key"],
      ["US", "cfpb-adverse-action-ai", "withdrawn_feed_key"],
      [TEST, "nyc-local-law-144", "feed_key_other_jurisdiction"],
    ] as const) {
      const r = await app.inject({ method: "POST", url: `/v1/jurisdictions/${code}/obligations`, headers: adminKey, payload: { regulatoryUpdateKey: key, agentRiskKey: "governance_gap", reason: "x" } });
      expect(r.statusCode, `${code} ${key}`).toBe(400);
      expect(r.json().error).toBe(error);
    }
  });

  it("add (no step-up), raise the floor (no step-up), lower it (step-up), remove it (step-up)", async () => {
    const seeded = await db
      .select({ risk: jurisdictionObligations.agentRiskKey })
      .from(jurisdictionObligations)
      .where(and(eq(jurisdictionObligations.jurisdictionCode, "US-NYC"), eq(jurisdictionObligations.regulatoryUpdateKey, "nyc-local-law-144")));
    const risk = AGENT_RISK_KEYS.find((k) => !seeded.some((s) => s.risk === k))!;
    const add = await app.inject({ method: "POST", url: "/v1/jurisdictions/US-NYC/obligations", headers: adminKey, payload: { regulatoryUpdateKey: "nyc-local-law-144", agentRiskKey: risk, reason: "bias audits" } });
    expect(add.statusCode, add.body).toBe(201);
    const id = add.json().id as string;
    createdObligations.push(id);
    const url = `/v1/jurisdictions/obligations/${id}`;
    expect((await app.inject({ method: "PATCH", url, headers: adminKey, payload: { tierFloor: "high", reason: "raise" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url, headers: adminKey, payload: { tierFloor: "limited", reason: "lower" } })).statusCode).toBe(403);
    expect((await db.select().from(jurisdictionObligations).where(eq(jurisdictionObligations.id, id)))[0]!.tierFloor).toBe("high");
    const lowered = await app.inject({ method: "PATCH", url, ...(await asAdminStepped({ [`jurisdictions.obligations.${id}.tierFloor`]: "limited" })), payload: { tierFloor: "limited", reason: "lower" } });
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect((await app.inject({ method: "DELETE", url, headers: adminKey, payload: { reason: "drop" } })).statusCode).toBe(403);
    const del = await app.inject({ method: "DELETE", url, ...(await asAdminStepped({ [`jurisdictions.obligations.${id}.deleted`]: true })), payload: { reason: "drop" } });
    expect(del.statusCode, del.body).toBe(204);
    expect((await lastAudit(JURISDICTION_AUDIT_RULES.obligationDeleted)).detail).toMatchObject({ obligationId: id, before: { tierFloor: "limited" } });
  });
});

describe("ADR-0345 §9 slice 3b: a use case's declared jurisdictions", () => {
  const url = () => `/v1/use-cases/${useCaseId}/jurisdictions`;

  it("with none declared, every jurisdiction is in scope", async () => {
    const r = await app.inject({ method: "GET", url: url(), headers: adminKey });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ declared: [], resolution: { undeclared: true } });
    expect(r.json().resolution.inScope).toContain("EU");
  });

  it("the first declaration narrows (step-up); adding one widens (none); removing one narrows (step-up)", async () => {
    expect((await app.inject({ method: "PUT", url: url(), headers: adminKey, payload: { codes: ["US-CO"], reason: "Colorado only" } })).statusCode).toBe(403);
    expect(await db.select().from(aiUseCaseJurisdictions).where(eq(aiUseCaseJurisdictions.useCaseId, useCaseId))).toEqual([]);
    const first = await app.inject({ method: "PUT", url: url(), ...(await asAdminStepped({ [`jurisdictions.useCases.${useCaseId}.declared`]: ["US-CO"] })), payload: { codes: ["US-CO"], reason: "Colorado only" } });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().narrowed).toContain("jurisdiction:EU");
    expect(first.json().resolution.inScope).toEqual(expect.arrayContaining(["US-CO", "US"]));

    const widen = await app.inject({ method: "PUT", url: url(), headers: adminKey, payload: { codes: ["US-CO", "EU"], reason: "EU launch" } });
    expect(widen.statusCode, widen.body).toBe(200);
    expect(widen.json().narrowed).toEqual([]);

    expect((await app.inject({ method: "PUT", url: url(), headers: adminKey, payload: { codes: ["EU"], reason: "left Colorado" } })).statusCode).toBe(403);
    const narrow = await app.inject({ method: "PUT", url: url(), ...(await asAdminStepped({ [`jurisdictions.useCases.${useCaseId}.declared`]: ["EU"] })), payload: { codes: ["EU"], reason: "left Colorado" } });
    expect(narrow.statusCode, narrow.body).toBe(200);
    expect((await lastAudit(JURISDICTION_AUDIT_RULES.declarationsChanged)).detail).toMatchObject({ before: ["EU", "US-CO"], after: ["EU"], reason: "left Colorado" });
  });

  it("NEGATIVE: an unknown code is 400; a declared jurisdiction cannot be removed; an unknown use case is 404", async () => {
    const r = await app.inject({ method: "PUT", url: url(), headers: adminKey, payload: { codes: ["EU", "Nowhere"], reason: "x" } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "unknown_jurisdiction", codes: ["Nowhere"] });
    expect((await app.inject({ method: "DELETE", url: "/v1/jurisdictions/EU", headers: adminKey, payload: { reason: "x" } })).json().error).toBe("jurisdiction_declared");
    expect((await app.inject({ method: "GET", url: "/v1/use-cases/00000000-0000-4000-8000-000000000000/jurisdictions", headers: adminKey })).statusCode).toBe(404);
  });

  it("NEGATIVE: a non-admin is refused reads and writes", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/jurisdictions", headers: memberKey })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: url(), headers: memberKey })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/jurisdictions", headers: memberKey, payload: { code: `Zm${LETTERS}`, name: "x", reason: "x" } })).statusCode).toBe(403);
  });
});
