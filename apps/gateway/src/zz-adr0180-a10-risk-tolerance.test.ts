/**
 * ADR-0180 §6 (A10) — risk tolerance and time-boxed acceptance, on a real
 * database through the real app. Each rule below has a test that fails
 * without it:
 *
 *  - the expiry cap per residual band (6 calendar months for high/critical, 12
 *    otherwise), refused beyond it, and the cap as the default;
 *  - a new acceptance supersedes the live one atomically (a failed write leaves
 *    the old one live);
 *  - the expiry sweep stamps the acceptance expired, reopens the risk (audited
 *    as the deployment) and raises `risk_acceptance_expired`;
 *  - the strict default tolerance (medium) applies with no rows;
 *  - residual risk above tolerance without a valid acceptance is reported (the
 *    gate fact and the monitor breach);
 *  - each compensating-control description is credential-scrubbed;
 *  - only an admin or a named risk acceptor may accept, never the use case's
 *    owner;
 *  - the legacy `POST /v1/risks/:riskId/accept` writes the same acceptance row;
 *  - (FA10) an unconfigured scope counts at the strict default, so relaxing a
 *    category alone never relaxes a tier nobody relaxed;
 *  - (FA10) the sweep locks the risk before the acceptance, so it never
 *    deadlocks with a new acceptance; a failing item does not end the pass;
 *    it audits as the deployment, an admin's manual run only as `requestedBy`;
 *  - (FA10) a compensating control ref must name a pack control.
 *
 * Global state (M-068): risk tolerances, the review policy's acceptor list and
 * the alert episodes this file raises are restored/removed before it ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiRisks,
  aiUseCases,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  governanceAlerts,
  governanceReviewPolicy,
  riskAcceptances,
  riskTolerances,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { addCalendarMonthsUtc, maxAcceptanceExpiry, resolveRiskTolerance } from "@regulait/shared";
import { buildApp } from "./app.js";
import { routeAuthClass } from "./route-classes.js";
import {
  RISK_ACCEPTANCE_RULE_IDS,
  RISK_ACCEPTANCE_SWEEP_ACTOR,
  recordRiskAcceptance,
  residualPosition,
  residualRiskMonitorInput,
  runRiskAcceptanceExpirySweep,
} from "./risk-tolerance.js";
import { RISK_ACCEPTANCE_EXPIRY_JOB_NAME, riskAcceptanceExpiryJobDefinition } from "./scheduler-jobs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a10-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
let db: Db;
let app: ReturnType<typeof buildApp>;
type Who = "admin" | "member" | "acceptor" | "owner";
const users = {} as Record<Who, { id: string; auth: { authorization: string } }>;
let policyBefore: typeof governanceReviewPolicy.$inferSelect | undefined;
const riskIds: string[] = [];
const useCaseIds: string[] = [];

const inject = (method: "GET" | "PUT" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkUseCase(tier: "minimal" | "limited" | "high" | null = null): Promise<string> {
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: `a10 use case ${RUN} ${useCaseIds.length}`,
      description: "synthetic ADR-0180 A10 fixture",
      ownerUserId: users.owner.id,
      businessContext: "synthetic",
      dataSensitivity: "internal",
      euAiActTier: tier,
      ...(tier ? { euAiActReasons: [], euAiActRulesetVersion: 1 } : {}),
    })
    .returning({ id: aiUseCases.id });
  useCaseIds.push(uc!.id);
  return uc!.id;
}

/** high/high = high residual; medium/medium = medium; low/low = low (the 3x3 matrix) */
async function mkRisk(
  level: "low" | "medium" | "high",
  opts: { useCaseId?: string; category?: "tool_misuse" | "prompt_injection" } = {},
): Promise<string> {
  const [r] = await db
    .insert(aiRisks)
    .values({
      title: `a10 ${level} risk ${RUN} ${riskIds.length}`,
      description: "synthetic ADR-0180 A10 fixture",
      category: opts.category ?? "tool_misuse",
      ownerUserId: users.owner.id,
      likelihood: level,
      impact: level,
      useCaseId: opts.useCaseId ?? null,
    })
    .returning({ id: aiRisks.id });
  riskIds.push(r!.id);
  return r!.id;
}

const acceptances = (riskId: string) =>
  db.select().from(riskAcceptances).where(eq(riskAcceptances.riskId, riskId)).orderBy(riskAcceptances.acceptedAt);
const riskRow = async (riskId: string) => (await db.select().from(aiRisks).where(eq(aiRisks.id, riskId)))[0]!;
const accept = (riskId: string, body: Record<string, unknown>, who: Who = "admin") =>
  inject("POST", `/v1/risks/${riskId}/acceptances`, users[who].auth, {
    responseType: "accept",
    rationale: "synthetic rationale for an A10 acceptance",
    ...body,
  });

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  // idempotent (the ADR-0147 precedent): the pack catalogue a compensating control ref must name
  expect((await inject("POST", "/v1/compliance/packs/seed", AUTH, {})).statusCode).toBe(201);
  for (const [k, isAdmin] of [["admin", true], ["member", false], ["acceptor", false], ["owner", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, {
      email: `a10-${k}-${RUN}@example.com`,
      displayName: `a10 ${k} ${RUN}`,
      isAdmin,
    });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a10" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  // the strict state: no configured tolerance
  await db.delete(riskTolerances);
  // name the acceptor (and the use-case owner, to prove the owner is refused anyway)
  [policyBefore] = await db.select().from(governanceReviewPolicy).where(eq(governanceReviewPolicy.id, "default"));
  const acceptors = [...(policyBefore?.riskAcceptorUserIds ?? []), users.acceptor.id, users.owner.id];
  await db
    .insert(governanceReviewPolicy)
    .values({ id: "default", riskAcceptorUserIds: acceptors })
    .onConflictDoUpdate({ target: governanceReviewPolicy.id, set: { riskAcceptorUserIds: acceptors } });
}, 120_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  // M-068: leave the org as it was
  await db.delete(riskTolerances);
  if (policyBefore) {
    await db
      .update(governanceReviewPolicy)
      .set({ riskAcceptorUserIds: policyBefore.riskAcceptorUserIds })
      .where(eq(governanceReviewPolicy.id, "default"));
  } else {
    await db.delete(governanceReviewPolicy).where(eq(governanceReviewPolicy.id, "default"));
  }
  const alerts = await db.select({ id: governanceAlerts.id, subjectKey: governanceAlerts.subjectKey }).from(governanceAlerts);
  for (const a of alerts) {
    if (riskIds.some((r) => a.subjectKey.includes(r))) await db.delete(governanceAlerts).where(eq(governanceAlerts.id, a.id));
  }
  for (const id of riskIds) await db.delete(aiRisks).where(eq(aiRisks.id, id));
  for (const id of useCaseIds) await db.delete(aiUseCases).where(eq(aiUseCases.id, id));
  app.server.closeAllConnections();
  await app.close();
});

describe("A10: the calendar expiry cap", () => {
  it("adds calendar months clamped to the month's end", () => {
    expect(addCalendarMonthsUtc(new Date("2026-08-31T10:00:00Z"), 6).toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(addCalendarMonthsUtc(new Date("2027-08-31T10:00:00Z"), 6).toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(addCalendarMonthsUtc(new Date("2026-01-15T00:00:00Z"), 12).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  it("refuses beyond 6 months for high residual risk (422), and defaults to the 6-month maximum", async () => {
    const id = await mkRisk("high");
    const tooLong = addCalendarMonthsUtc(new Date(), 6);
    tooLong.setUTCDate(tooLong.getUTCDate() + 2);
    const refused = await accept(id, { expiresAt: tooLong.toISOString() });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ error: "acceptance_expiry_beyond_maximum", band: "high", maxMonths: 6 });
    expect(await acceptances(id)).toHaveLength(0);

    const res = await accept(id, {});
    expect(res.statusCode, res.body).toBe(201);
    const [row] = await acceptances(id);
    expect(row!.residualBand).toBe("high");
    expect(row!.expiresAt.toISOString()).toBe(maxAcceptanceExpiry("high", row!.acceptedAt).toISOString());
    expect(row!.expiresAt.toISOString()).toBe(addCalendarMonthsUtc(row!.acceptedAt, 6).toISOString());
  });

  it("allows up to 12 months for medium and low residual risk, refuses beyond, defaults to 12", async () => {
    for (const level of ["medium", "low"] as const) {
      const id = await mkRisk(level);
      const thirteen = addCalendarMonthsUtc(new Date(), 13).toISOString();
      const refused = await accept(id, { expiresAt: thirteen });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json()).toMatchObject({ error: "acceptance_expiry_beyond_maximum", band: level, maxMonths: 12 });

      const nine = addCalendarMonthsUtc(new Date(), 9);
      const ok = await accept(id, { expiresAt: nine.toISOString() });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(new Date(ok.json().acceptance.expiresAt).getTime()).toBe(nine.getTime());

      const dflt = await accept(id, {});
      expect(dflt.statusCode, dflt.body).toBe(201);
      const live = (await acceptances(id)).find((r) => r.supersededAt === null)!;
      expect(live.expiresAt.toISOString()).toBe(addCalendarMonthsUtc(live.acceptedAt, 12).toISOString());
    }
  });

  it("refuses an expiry that is not in the future", async () => {
    const id = await mkRisk("medium");
    const res = await accept(id, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("acceptance_expiry_not_in_future");
  });
});

describe("A10: a new acceptance supersedes the live one atomically", () => {
  it("links the superseded row to its successor, and a failed write leaves the old one live", async () => {
    const id = await mkRisk("high");
    const first = await accept(id, { rationale: "first acceptance of this residual risk" });
    expect(first.statusCode, first.body).toBe(201);
    const firstId = first.json().acceptance.id as string;

    // the credential scrub lengthens this rationale past the 4000-character
    // store limit, so the INSERT fails AFTER the supersede ran in the same
    // transaction: the supersede must roll back with it
    const long = `${"x".repeat(3970)} ${AWS_KEY} tail`;
    const failed = await accept(id, { rationale: long });
    expect(failed.statusCode, failed.body).toBe(422);
    expect(failed.json().error).toBe("rationale_too_long");
    const afterFail = await acceptances(id);
    expect(afterFail).toHaveLength(1);
    expect(afterFail[0]!.id).toBe(firstId);
    expect(afterFail[0]!.supersededAt).toBeNull();
    expect((await riskRow(id)).acceptanceNote).toBe("first acceptance of this residual risk");

    const second = await accept(id, { responseType: "transfer", rationale: "second acceptance, insurance now in place" });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().supersededId).toBe(firstId);
    const rows = await acceptances(id);
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.id === firstId)!;
    expect(old.supersededAt).not.toBeNull();
    expect(old.supersededById).toBe(second.json().acceptance.id);
    // ai_risks stays in step with the live acceptance
    const risk = await riskRow(id);
    expect(risk).toMatchObject({ status: "accepted", acceptedByUserId: users.admin.id, acceptanceNote: "second acceptance, insurance now in place" });

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, RISK_ACCEPTANCE_RULE_IDS.recorded)))
      .orderBy(desc(auditLog.at));
    expect(audit).toHaveLength(2);
    expect(audit[0]!.detail).toMatchObject({ supersededId: firstId, responseType: "transfer", residualBand: "high" });
  });
});

describe("A10: the expiry sweep reopens the risk", () => {
  it("stamps the acceptance expired, reopens the risk as the deployment, and raises risk_acceptance_expired", async () => {
    const ucId = await mkUseCase();
    const id = await mkRisk("high", { useCaseId: ucId });
    const res = await accept(id, {}, "acceptor");
    expect(res.statusCode, res.body).toBe(201);
    const accId = res.json().acceptance.id as string;
    // move the acceptance into the past (the DB keeps expires_at after accepted_at)
    await db
      .update(riskAcceptances)
      .set({ acceptedAt: new Date(Date.now() - 40 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(riskAcceptances.id, accId));

    // the gate does not wait for the sweep: a lapsed acceptance is not valid
    const before = (await residualPosition(db, ucId, new Date())).find((p) => p.riskId === id)!;
    expect(before).toMatchObject({ acceptance: null, aboveTolerance: true });

    const job = riskAcceptanceExpiryJobDefinition();
    expect(job.name).toBe(RISK_ACCEPTANCE_EXPIRY_JOB_NAME);
    const out = await job.run({ db, actorUserId: null, now: new Date(), runId: `a10-${RUN}` });
    expect(out.itemsProcessed).toBeGreaterThanOrEqual(1);

    const [acc] = await db.select().from(riskAcceptances).where(eq(riskAcceptances.id, accId));
    expect(acc!.expiredAt).not.toBeNull();
    const risk = await riskRow(id);
    expect(risk).toMatchObject({ status: "open", acceptedAt: null, acceptedByUserId: null, acceptanceNote: null });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, RISK_ACCEPTANCE_RULE_IDS.expired)));
    expect(audit!.userId).toBe(NO_IDENTITY);
    expect(audit!.detail).toMatchObject({ acceptanceId: accId, from: "accepted", to: "open", reopened: true });
    const subjectKey = `risk:${id}>acceptance:${accId}`;
    const [alert] = await db
      .select()
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.ruleId, "risk_acceptance_expired"), eq(governanceAlerts.subjectKey, subjectKey)));
    expect(alert).toMatchObject({ status: "open", severity: "medium" });

    // a second pass is a no-op for this acceptance
    expect((await runRiskAcceptanceExpirySweep(db)).expired).toBe(0);

    // the monitor keeps reporting it until a new acceptance covers the risk
    const m1 = await residualRiskMonitorInput(db, new Date());
    expect(m1.risk_acceptance_expired!.breaches.map((b) => b.subjectKey)).toContain(subjectKey);
    expect((await accept(id, {}, "acceptor")).statusCode).toBe(201);
    const m2 = await residualRiskMonitorInput(db, new Date());
    expect(m2.risk_acceptance_expired!.breaches.map((b) => b.subjectKey)).not.toContain(subjectKey);
  });
});

describe("A10: tolerance", () => {
  it("applies the strict default (medium) with no rows, and says so", async () => {
    await db.delete(riskTolerances);
    const view = await inject("GET", "/v1/risk-tolerances", users.admin.auth);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ source: "default", strictDefault: { maxBand: "medium" }, tolerances: [] });
    expect(view.json().effective.categories.tool_misuse).toEqual({ maxBand: "medium", source: "default" });
    expect(view.json().effective.tiers.high).toEqual({ maxBand: "medium", source: "default" });
    expect(resolveRiskTolerance([], { category: "tool_misuse", tier: "high" })).toEqual({ band: "medium", source: "default" });

    const ucId = await mkUseCase("high");
    const high = await mkRisk("high", { useCaseId: ucId });
    const medium = await mkRisk("medium", { useCaseId: ucId });
    const pos = await residualPosition(db, ucId, new Date());
    expect(pos.find((p) => p.riskId === high)).toEqual({
      riskId: high,
      band: "high",
      tolerance: { band: "medium", source: "default" },
      acceptance: null,
      aboveTolerance: true,
    });
    expect(pos.find((p) => p.riskId === medium)).toMatchObject({ band: "medium", aboveTolerance: false });
  });

  it("is admin-only to read and set; a change is audited with the old and new set; the stricter scope wins", async () => {
    expect(routeAuthClass("GET", "/v1/risk-tolerances")).toBe("admin");
    expect(routeAuthClass("PUT", "/v1/risk-tolerances")).toBe("admin");
    expect((await inject("GET", "/v1/risk-tolerances", users.member.auth)).statusCode).toBe(403);
    expect((await inject("PUT", "/v1/risk-tolerances", users.member.auth, { tolerances: [] })).statusCode).toBe(403);
    // an unknown scope key or a duplicate is refused
    const bad = await inject("PUT", "/v1/risk-tolerances", users.admin.auth, {
      tolerances: [{ scopeKind: "category", scopeKey: "made_up", maxBand: "high" }],
    });
    expect(bad.statusCode).toBe(400);

    const ucId = await mkUseCase("limited");
    const id = await mkRisk("high", { useCaseId: ucId, category: "prompt_injection" });
    try {
      const put = await inject("PUT", "/v1/risk-tolerances", users.admin.auth, {
        tolerances: [{ scopeKind: "category", scopeKey: "prompt_injection", maxBand: "high" }],
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json()).toMatchObject({ source: "configured" });
      expect(put.json().effective.categories.prompt_injection).toEqual({ maxBand: "high", source: "configured" });
      const [row] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, RISK_ACCEPTANCE_RULE_IDS.tolerancesSet), eq(auditLog.userId, users.admin.id)))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(row!.detail).toMatchObject({
        from: [],
        to: [{ scopeKind: "category", scopeKey: "prompt_injection", maxBand: "high" }],
        changed: true,
      });
      expect(row!.reason).toContain("RELAXED");
      // FA10 finding 3: the limited tier has no row, so it sits at the strict
      // default and the relaxed category alone does not relax this risk
      let p = (await residualPosition(db, ucId, new Date())).find((x) => x.riskId === id)!;
      expect(p).toMatchObject({ tolerance: { band: "medium", source: "default" }, aboveTolerance: true });

      // relaxing the tier as well relaxes the risk (the category is named on a tie)
      await inject("PUT", "/v1/risk-tolerances", users.admin.auth, {
        tolerances: [
          { scopeKind: "category", scopeKey: "prompt_injection", maxBand: "high" },
          { scopeKind: "tier", scopeKey: "limited", maxBand: "high" },
        ],
      });
      p = (await residualPosition(db, ucId, new Date())).find((x) => x.riskId === id)!;
      expect(p).toMatchObject({ tolerance: { band: "high", source: "category" }, aboveTolerance: false });

      // a stricter tier row wins over the relaxed category
      await inject("PUT", "/v1/risk-tolerances", users.admin.auth, {
        tolerances: [
          { scopeKind: "category", scopeKey: "prompt_injection", maxBand: "high" },
          { scopeKind: "tier", scopeKey: "limited", maxBand: "low" },
        ],
      });
      p = (await residualPosition(db, ucId, new Date())).find((x) => x.riskId === id)!;
      expect(p).toMatchObject({ tolerance: { band: "low", source: "tier" }, aboveTolerance: true });
    } finally {
      const reset = await inject("PUT", "/v1/risk-tolerances", users.admin.auth, { tolerances: [] });
      expect(reset.json().source).toBe("default");
    }
  });

  it("FA10 finding 3: relaxing only a category does not relax a high-tier use case's risk in it", async () => {
    const ucId = await mkUseCase("high");
    const id = await mkRisk("high", { useCaseId: ucId, category: "tool_misuse" });
    const subjectKey = `use_case:${ucId}>risk:${id}`;
    try {
      const put = await inject("PUT", "/v1/risk-tolerances", users.admin.auth, {
        tolerances: [{ scopeKind: "category", scopeKey: "tool_misuse", maxBand: "high" }],
      });
      expect(put.statusCode, put.body).toBe(200);
      // the view says the high tier is at the default; the resolution agrees
      expect(put.json().effective.tiers.high).toEqual({ maxBand: "medium", source: "default" });
      const p = (await residualPosition(db, ucId, new Date())).find((x) => x.riskId === id)!;
      expect(p).toMatchObject({ band: "high", tolerance: { band: "medium", source: "default" }, aboveTolerance: true });
      const m = await residualRiskMonitorInput(db, new Date());
      expect(m.residual_above_tolerance!.breaches.map((b) => b.subjectKey)).toContain(subjectKey);
    } finally {
      await inject("PUT", "/v1/risk-tolerances", users.admin.auth, { tolerances: [] });
    }
  });

  it("reports residual risk above tolerance without a valid acceptance, at the gate and to the monitor", async () => {
    const ucId = await mkUseCase();
    const id = await mkRisk("high", { useCaseId: ucId });
    const subjectKey = `use_case:${ucId}>risk:${id}`;
    let p = (await residualPosition(db, ucId, new Date())).find((x) => x.riskId === id)!;
    expect(p).toMatchObject({ band: "high", acceptance: null, aboveTolerance: true });
    let m = await residualRiskMonitorInput(db, new Date());
    expect(m.residual_above_tolerance!.breaches.map((b) => b.subjectKey)).toContain(subjectKey);

    const res = await accept(id, {}, "acceptor");
    expect(res.statusCode, res.body).toBe(201);
    p = (await residualPosition(db, ucId, new Date())).find((x) => x.riskId === id)!;
    expect(p.aboveTolerance).toBe(false);
    expect(p.acceptance).toMatchObject({ id: res.json().acceptance.id, residualBand: "high", acceptedByUserId: users.acceptor.id });
    m = await residualRiskMonitorInput(db, new Date());
    expect(m.residual_above_tolerance!.breaches.map((b) => b.subjectKey)).not.toContain(subjectKey);

    // a closed risk carries no residual position
    await db.update(aiRisks).set({ status: "closed", acceptedAt: null, acceptanceNote: null, acceptedByUserId: null }).where(eq(aiRisks.id, id));
    expect((await residualPosition(db, ucId, new Date())).find((x) => x.riskId === id)).toBeUndefined();
  });
});

describe("A10: compensating controls", () => {
  it("scrubs a credential typed into a control description before it is stored", async () => {
    const id = await mkRisk("medium");
    const res = await accept(id, {
      compensatingControls: [
        { controlRef: "eu-ai-act:art-14-human-oversight", description: `manual review; vault key ${AWS_KEY} rotated` },
        { description: "insurance policy covers the residual exposure" },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const [row] = await acceptances(id);
    const text = JSON.stringify(row!.compensatingControls);
    expect(text).not.toContain(AWS_KEY);
    expect(row!.compensatingControls[0]!.description).toContain("[redacted:aws_key");
    expect(row!.compensatingControls[0]!.controlRef).toBe("eu-ai-act:art-14-human-oversight");
    expect(row!.compensatingControls[1]).toEqual({ controlRef: null, description: "insurance policy covers the residual exposure" });
  });

  it("FA10 finding 8: refuses a control ref no compliance pack defines (free text, a pasted credential) before writing", async () => {
    const id = await mkRisk("medium");
    for (const controlRef of [`vault ${AWS_KEY}`, "made-up:control"]) {
      const res = await accept(id, {
        compensatingControls: [
          { controlRef: "eu-ai-act:art-14-human-oversight", description: "manual review of each output" },
          { controlRef, description: "a second control" },
        ],
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ error: "unknown_control_ref", unknown: 1 });
      expect(res.body).not.toContain(AWS_KEY);
    }
    expect(await acceptances(id)).toHaveLength(0);
    expect((await riskRow(id)).status).not.toBe("accepted");
  });
});

/** make a recorded acceptance lapse (the DB keeps expires_at after accepted_at) */
async function lapse(acceptanceId: string, daysAgo: number): Promise<void> {
  await db
    .update(riskAcceptances)
    .set({ acceptedAt: new Date(Date.now() - 40 * 86_400_000), expiresAt: new Date(Date.now() - daysAgo * 86_400_000) })
    .where(eq(riskAcceptances.id, acceptanceId));
}

async function lapsedAcceptance(daysAgo: number): Promise<{ riskId: string; acceptanceId: string }> {
  const riskId = await mkRisk("high");
  const res = await accept(riskId, {});
  expect(res.statusCode, res.body).toBe(201);
  const acceptanceId = res.json().acceptance.id as string;
  await lapse(acceptanceId, daysAgo);
  return { riskId, acceptanceId };
}

describe("FA10: the expiry sweep under contention and failure", () => {
  it("finding 4: a sweep racing a new acceptance of the same risk deadlocks neither, and completes the other items", async () => {
    // r1's acceptance lapsed first, so the sweep reaches it first; r2 only the sweep touches
    const r1 = await lapsedAcceptance(3);
    const r2 = await lapsedAcceptance(2);
    let sweep: ReturnType<typeof runRiskAcceptanceExpirySweep> | undefined;
    const accepting = db.transaction(async (tx) => {
      // the new acceptance's first lock is the risk row (recordRiskAcceptance takes it again below)
      await tx.select().from(aiRisks).where(eq(aiRisks.id, r1.riskId)).for("update");
      const pid = Number(((await tx.execute(sql`select pg_backend_pid()::int as pid`)) as { rows: Array<{ pid: number }> }).rows[0]!.pid);
      sweep = runRiskAcceptanceExpirySweep(db);
      // wait until the sweep is queued behind this transaction (on whichever lock it takes first)
      const deadline = Date.now() + 10_000;
      for (;;) {
        const r = (await db.execute(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and ${pid}::int = any(pg_blocking_pids(pid))`,
        )) as { rows: Array<{ n: number }> };
        if (Number(r.rows[0]!.n) > 0) break;
        if (Date.now() > deadline) throw new Error("the sweep never queued behind the acceptance");
        await new Promise((res) => setTimeout(res, 25));
      }
      // now the acceptance touches the live acceptance row (the supersede)
      return recordRiskAcceptance(tx, {
        riskId: r1.riskId,
        rationale: "renewed while the sweep was running",
        actorUserId: users.admin.id,
      });
    });
    const [rec, swept] = await Promise.allSettled([accepting, accepting.then(() => sweep!, () => sweep!)]);
    expect(rec.status, rec.status === "rejected" ? String(rec.reason) : "").toBe("fulfilled");
    expect(swept.status, swept.status === "rejected" ? String(swept.reason) : "").toBe("fulfilled");
    const out = (swept as PromiseFulfilledResult<Awaited<ReturnType<typeof runRiskAcceptanceExpirySweep>>>).value;
    expect(out.failed).toBe(0);

    // the new acceptance won r1: the old row is superseded (not expired) and the risk stays accepted
    const rows1 = await acceptances(r1.riskId);
    const old1 = rows1.find((r) => r.id === r1.acceptanceId)!;
    expect(old1.supersededAt).not.toBeNull();
    expect(old1.expiredAt).toBeNull();
    expect(rows1.find((r) => r.id !== r1.acceptanceId)).toMatchObject({ supersededAt: null, expiredAt: null });
    expect((await riskRow(r1.riskId)).status).toBe("accepted");
    // the pass went on and expired r2
    const [a2] = await db.select().from(riskAcceptances).where(eq(riskAcceptances.id, r2.acceptanceId));
    expect(a2!.expiredAt).not.toBeNull();
    expect((await riskRow(r2.riskId)).status).toBe("open");
  });

  it("one failing item is audited and the pass completes the others", async () => {
    const bad = await lapsedAcceptance(3);
    const good = await lapsedAcceptance(2);
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION fa10_test_reject_expiry_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.rule_id = '${RISK_ACCEPTANCE_RULE_IDS.expired}' AND NEW.detail->>'acceptanceId' = '${bad.acceptanceId}' THEN
          RAISE EXCEPTION 'fa10 injected audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fa10_test_reject_expiry_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fa10_test_reject_expiry_audit();
    `));
    let out: Awaited<ReturnType<typeof runRiskAcceptanceExpirySweep>>;
    try {
      out = await runRiskAcceptanceExpirySweep(db);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS fa10_test_reject_expiry_audit ON audit_log"));
      await db.execute(sql.raw("DROP FUNCTION IF EXISTS fa10_test_reject_expiry_audit()"));
    }
    expect(out).toMatchObject({ failed: 1 });
    expect(out.expired).toBeGreaterThanOrEqual(1);
    // the failed item rolled back whole: still live, the risk still accepted
    const [b] = await db.select().from(riskAcceptances).where(eq(riskAcceptances.id, bad.acceptanceId));
    expect(b!.expiredAt).toBeNull();
    expect((await riskRow(bad.riskId)).status).toBe("accepted");
    const [failure] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, bad.riskId), eq(auditLog.ruleId, RISK_ACCEPTANCE_RULE_IDS.expiryFailed)));
    expect(failure).toMatchObject({ userId: NO_IDENTITY, effect: "deny" });
    expect(failure!.detail).toMatchObject({ acceptanceId: bad.acceptanceId, actor: RISK_ACCEPTANCE_SWEEP_ACTOR });
    // the good item was expired in the same pass
    const [g] = await db.select().from(riskAcceptances).where(eq(riskAcceptances.id, good.acceptanceId));
    expect(g!.expiredAt).not.toBeNull();
    // the next pass picks the failed item up
    expect((await runRiskAcceptanceExpirySweep(db)).expired).toBeGreaterThanOrEqual(1);
    expect((await riskRow(bad.riskId)).status).toBe("open");
  });

  it("INFO: a manual run is audited as the deployment, naming the requesting admin only as requestedBy", async () => {
    const { riskId, acceptanceId } = await lapsedAcceptance(1);
    const job = riskAcceptanceExpiryJobDefinition();
    await job.run({ db, actorUserId: users.admin.id, now: new Date(), runId: `a10-manual-${RUN}` });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, riskId), eq(auditLog.ruleId, RISK_ACCEPTANCE_RULE_IDS.expired)));
    expect(audit!.userId).toBe(NO_IDENTITY);
    expect(audit!.detail).toMatchObject({ acceptanceId, actor: RISK_ACCEPTANCE_SWEEP_ACTOR, requestedBy: users.admin.id });
  });
});

describe("A10: who may accept", () => {
  it("admits an admin or a named risk acceptor, refuses anyone else (audited) and the use case's owner", async () => {
    expect(routeAuthClass("POST", "/v1/risks/:riskId/acceptances")).toBe("user");
    expect(routeAuthClass("GET", "/v1/risks/:riskId/acceptances")).toBe("user");
    const ucId = await mkUseCase();
    const id = await mkRisk("medium", { useCaseId: ucId });

    const member = await accept(id, {}, "member");
    expect(member.statusCode).toBe(403);
    expect(member.json().error).toBe("not_a_risk_acceptor");
    const [denied] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, RISK_ACCEPTANCE_RULE_IDS.refused)));
    expect(denied).toMatchObject({ userId: users.member.id, effect: "deny" });

    // the owner of the use case is a named acceptor here, and is refused anyway
    const owner = await accept(id, {}, "owner");
    expect(owner.statusCode).toBe(403);
    expect(owner.json().error).toBe("proposer_cannot_accept_risk");
    expect(await acceptances(id)).toHaveLength(0);

    const ok = await accept(id, {}, "acceptor");
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await acceptances(id))[0]!.acceptedByUserId).toBe(users.acceptor.id);

    // the history reads like the risk: its owner and admins, nobody else
    expect((await inject("GET", `/v1/risks/${id}/acceptances`, users.member.auth)).statusCode).toBe(403);
    const hist = await inject("GET", `/v1/risks/${id}/acceptances`, users.owner.auth);
    expect(hist.statusCode, hist.body).toBe(200);
    expect(hist.json()).toMatchObject({
      canAccept: false,
      acceptRefusal: "proposer_cannot_accept_risk",
      position: { band: "medium", tolerance: { band: "medium", source: "default" }, maxAcceptanceMonths: 12 },
    });
    expect(hist.json().acceptances).toHaveLength(1);
    expect(hist.json().acceptances[0]).toMatchObject({ state: "live", acceptedByName: `a10 acceptor ${RUN}` });
    const adminHist = await inject("GET", `/v1/risks/${id}/acceptances`, users.admin.auth);
    expect(adminHist.json().canAccept).toBe(true);
  });
});

describe("A10: the legacy accept is a wrapper", () => {
  it("writes the same time-boxed acceptance row, at the band's maximum, and keeps its own contract", async () => {
    const id = await mkRisk("high");
    const res = await inject("POST", `/v1/risks/${id}/accept`, users.admin.auth, { note: "legacy acceptance note" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "accepted", acceptanceNote: "legacy acceptance note" });
    const rows = await acceptances(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      responseType: "accept",
      rationale: "legacy acceptance note",
      residualBand: "high",
      acceptedByUserId: users.admin.id,
    });
    expect(rows[0]!.expiresAt.toISOString()).toBe(addCalendarMonthsUtc(rows[0]!.acceptedAt, 6).toISOString());
    expect(res.json().acceptanceRecord).toMatchObject({ id: rows[0]!.id, residualBand: "high" });
    const legacyAudit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "risk-accepted")));
    expect(legacyAudit).toHaveLength(1);
    expect((await inject("POST", `/v1/risks/${id}/accept`, users.admin.auth, { note: "again" })).json().error).toBe(
      "already_accepted",
    );
  });
});
