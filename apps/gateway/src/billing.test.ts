import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  billingPeriods,
  billingStatements,
  createDb,
  eq,
  gte,
  inArray,
  lt,
  rateCards,
  runMigrations,
  usageEvents,
  users,
  type Db,
} from "@regulait/db";
import { parseStatementCsv } from "@regulait/shared";

/**
 * ADR-0051 — METERING & BILLING, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A NUMBER THAT IS A SNAPSHOT OF ITSELF. The reconciliation cases do NOT
 *     assert "the statement says 12.5 and it said 12.5 last time". They
 *     re-query `usage_events` for the exact window, apply the rate card in JS
 *     inside the test, and assert the statement's total EQUALS that. If billing
 *     ever grew a counter that drifted from the ledger, this fails.
 *
 *  2. AN ISSUED INVOICE THAT MOVES. After issuing, a NEW rate-card version at
 *     ten times the price is created and the issued row is re-read: its money
 *     must be byte-identical, and its own re-derivation must still reconcile.
 *     This is the money bug ADR-0051 exists to prevent.
 *
 *  3. A LEAK THROUGH AN INVOICE. A non-admin team lead cuts their own team's
 *     view; the other team's project id must be absent from the served payload
 *     AND from the persisted `effective_project_ids`, the org period must 403
 *     outright, and an admin's org statement must be unreadable and
 *     unexportable by that lead.
 *
 *  4. A CLOSE THAT RUNS TWICE. Close is asserted idempotent: the second call
 *     reports `alreadyClosed`, returns the SAME statement id, moves no
 *     timestamp, and creates no second version.
 *
 * SHARED-STATE DISCIPLINE: this suite writes `usage_events` rows (the ONE spend
 * ledger every other suite reads). Every object is `bil-` prefixed and
 * `afterAll` deletes every usage row, period (statements and exports cascade)
 * and rate card it created, so no other suite's totals move.
 */

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "bil-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

// a fixed window in the past, so no other suite's rows can wander into it and
// the expectation computed in JS is the only thing that decides the number
const WINDOW_START = new Date("2026-03-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-04-01T00:00:00.000Z");
const AT = new Date("2026-03-15T12:00:00.000Z");

let db: Db;
let app: ReturnType<typeof buildApp>;
let alphaId: string;
let betaId: string;
let teamAId: string;
let teamBId: string;
let leadAId: string;
let leadAAuth: { authorization: string };
let leadBId: string;
let leadBAuth: { authorization: string };
let cardId: string;
let cardV2Id: string;
let orgPeriodId: string;
let teamPeriodId: string;
const createdUsageIds: string[] = [];
const createdPeriodIds: string[] = [];
const createdCardIds: string[] = [];

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]! },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "bil" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

/**
 * The INDEPENDENT expectation. Reads the ledger itself and applies the rate
 * card by hand — deliberately NOT by calling the shared rating function, so a
 * bug in that function cannot make both sides wrong in the same direction.
 */
async function expectedFromLedger(projectIds: string[], through: Date) {
  const rows = await db
    .select()
    .from(usageEvents)
    .where(
      and(
        inArray(usageEvents.projectId, projectIds),
        gte(usageEvents.at, WINDOW_START),
        lt(usageEvents.at, WINDOW_END),
        lt(usageEvents.at, through),
      ),
    );
  let usd = 0;
  let inTok = 0;
  let outTok = 0;
  let ledger = 0;
  for (const r of rows) {
    if (r.objectType === "agent") {
      // the card below prices bil-model at $2/1k in and $6/1k out
      inTok += r.inputTokens ?? 0;
      outTok += r.outputTokens ?? 0;
      usd += ((r.inputTokens ?? 0) * 2) / 1000 + ((r.outputTokens ?? 0) * 6) / 1000;
    } else {
      usd += 0.5; // connector, $0.50/call
    }
    ledger += r.costUsd ?? 0;
  }
  return {
    usageUsd: Number(usd.toFixed(6)),
    events: rows.length,
    inputTokens: inTok,
    outputTokens: outTok,
    ledgerEstimatedUsd: Number(ledger.toFixed(6)),
  };
}

async function activeSeatCount() {
  const rows = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users);
  return rows.filter((r) => r.disabledAt === null).length;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const a = await makeUser("bil-lead-a@example.com");
  leadAId = a.id;
  leadAAuth = a.auth;
  const b = await makeUser("bil-lead-b@example.com");
  leadBId = b.id;
  leadBAuth = b.auth;

  for (const name of ["bil-team-a", "bil-team-b"]) {
    const t = await app.inject({ method: "POST", url: "/v1/teams", headers: AUTH, payload: { name } });
    expect(t.statusCode).toBe(201);
    if (name === "bil-team-a") teamAId = t.json().id;
    else teamBId = t.json().id;
  }
  await app.inject({ method: "POST", url: `/v1/teams/${teamAId}/members`, headers: AUTH, payload: { userId: leadAId } });
  await app.inject({ method: "POST", url: `/v1/teams/${teamBId}/members`, headers: AUTH, payload: { userId: leadBId } });

  for (const name of ["bil-alpha", "bil-beta"]) {
    const p = await app.inject({ method: "POST", url: "/v1/projects", headers: AUTH, payload: { name } });
    expect(p.statusCode).toBe(201);
    if (name === "bil-alpha") alphaId = p.json().id;
    else betaId = p.json().id;
  }
  await app.inject({
    method: "POST",
    url: `/v1/projects/${alphaId}/members`,
    headers: AUTH,
    payload: { userId: leadAId, teamId: teamAId, role: "owner" },
  });
  await app.inject({
    method: "POST",
    url: `/v1/projects/${betaId}/members`,
    headers: AUTH,
    payload: { userId: leadBId, teamId: teamBId, role: "owner" },
  });

  // REAL ledger rows inside the fixed window.
  const rows = await db
    .insert(usageEvents)
    .values([
      { userId: leadAId, objectType: "agent", projectId: alphaId, provider: "mock", model: "bil-model", inputTokens: 1000, outputTokens: 500, costUsd: 0.11, at: AT },
      { userId: leadAId, objectType: "agent", projectId: alphaId, provider: "mock", model: "bil-model", inputTokens: 2000, outputTokens: 250, costUsd: 0.22, at: AT },
      { userId: leadAId, objectType: "connector", projectId: alphaId, operation: "read", costUsd: 0.01, at: AT },
      { userId: leadBId, objectType: "agent", projectId: betaId, provider: "mock", model: "bil-model", inputTokens: 4000, outputTokens: 1000, costUsd: 0.44, at: AT },
      // an ADR-0034 self-hosted row: MEASURED usage, NO list price. It must be
      // billable on our own card but contribute nothing to the ledger estimate.
      { userId: leadBId, objectType: "agent", projectId: betaId, provider: "selfhosted", model: "bil-model", inputTokens: 500, outputTokens: 100, costUsd: null, at: AT },
    ])
    .returning({ id: usageEvents.id });
  createdUsageIds.push(...rows.map((r) => r.id));

  const card = await app.inject({
    method: "POST",
    url: "/v1/billing/rate-cards",
    headers: AUTH,
    payload: {
      name: "bil-standard",
      entries: [
        { dimension: "model", matchKey: "bil-model", unit: "per_1k_input_tokens", unitPriceUsd: 2 },
        { dimension: "model", matchKey: "bil-model", unit: "per_1k_output_tokens", unitPriceUsd: 6 },
        { dimension: "connector", matchKey: "*", unit: "per_call", unitPriceUsd: 0.5 },
        { dimension: "seat", matchKey: "*", unit: "per_seat_month", unitPriceUsd: 10 },
      ],
    },
  });
  expect(card.statusCode).toBe(201);
  cardId = card.json().rateCard.id;
  createdCardIds.push(cardId);

  const org = await app.inject({
    method: "POST",
    url: "/v1/billing/periods",
    headers: AUTH,
    payload: {
      scopeKind: "org",
      periodStart: WINDOW_START.toISOString(),
      periodEnd: WINDOW_END.toISOString(),
      rateCardId: cardId,
    },
  });
  expect(org.statusCode).toBe(201);
  orgPeriodId = org.json().period.id;
  createdPeriodIds.push(orgPeriodId);

  const team = await app.inject({
    method: "POST",
    url: "/v1/billing/periods",
    headers: AUTH,
    payload: {
      scopeKind: "team",
      scopeId: teamAId,
      periodStart: WINDOW_START.toISOString(),
      periodEnd: WINDOW_END.toISOString(),
      rateCardId: cardId,
    },
  });
  expect(team.statusCode).toBe(201);
  teamPeriodId = team.json().period.id;
  createdPeriodIds.push(teamPeriodId);
});

afterAll(async () => {
  // periods cascade to statements and exports; the usage rows are this suite's
  // own additions to the ONE shared ledger and must go, or every other suite's
  // org-wide totals move under it
  if (createdPeriodIds.length) {
    await db.delete(billingPeriods).where(inArray(billingPeriods.id, createdPeriodIds));
  }
  if (createdCardIds.length) {
    await db.delete(rateCards).where(inArray(rateCards.id, createdCardIds));
  }
  if (createdUsageIds.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.id, createdUsageIds));
  }
});

describe("ADR-0051 — a statement reconciles to the ledger", () => {
  it("a TEAM statement's usage total EQUALS an independent sum of the underlying usage_events rows", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${teamPeriodId}/statements`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(201);
    const report = res.json().report;
    const expected = await expectedFromLedger([alphaId], new Date(report.derivedThroughAt));
    expect(report.usage.eventCount).toBe(expected.events);
    expect(report.usage.measuredInputTokens).toBe(expected.inputTokens);
    expect(report.usage.measuredOutputTokens).toBe(expected.outputTokens);
    expect(report.usageSubtotalUsd).toBe(expected.usageUsd);
    // the ledger's list-price estimate is carried SEPARATELY and is a
    // different number — §5's split survives into the money
    expect(report.usage.ledgerEstimatedCostUsd).toBe(expected.ledgerEstimatedUsd);
    expect(report.usageSubtotalUsd).not.toBe(report.usage.ledgerEstimatedCostUsd);
  });

  it("bills seats from the ACTIVE user count and totals usage + seats", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${teamPeriodId}/statements`,
      headers: AUTH,
    });
    const report = res.json().report;
    const seats = await activeSeatCount();
    expect(report.seats.seatCount).toBe(seats);
    expect(report.seatSubtotalUsd).toBe(Number((seats * 10).toFixed(6)));
    expect(report.totalUsd).toBe(Number((report.usageSubtotalUsd + report.seatSubtotalUsd).toFixed(6)));
  });

  it("carries a self-hosted (null cost_usd) row as measured usage billable on our own card", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${orgPeriodId}/statements`,
      headers: AUTH,
    });
    const report = res.json().report;
    // 500 in + 100 out of the unpriced row are in the measured totals
    const expected = await expectedFromLedger([alphaId, betaId], new Date(report.derivedThroughAt));
    expect(report.usage.measuredInputTokens).toBeGreaterThanOrEqual(expected.inputTokens);
    expect(report.disclaimer).toMatch(/ESTIMATE/);
    expect(report.ratingMode).toBe("estimated");
  });

  it("re-derives EXACTLY from the ledger under its own frozen snapshot", async () => {
    const cut = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${teamPeriodId}/statements`,
      headers: AUTH,
    });
    const id = cut.json().statement.id as string;
    const rec = await app.inject({ method: "POST", url: `/v1/billing/statements/${id}/reconcile`, headers: AUTH });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().matches).toBe(true);
    expect(rec.json().diffs).toEqual([]);
    expect((await audits("billing-statement-reconciled")).length).toBeGreaterThan(0);
  });
});

describe("ADR-0051 — an issued statement is immutable", () => {
  it("does NOT change when the rate card changes afterwards, and still reconciles", async () => {
    const cut = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${orgPeriodId}/statements`,
      headers: AUTH,
    });
    const id = cut.json().statement.id as string;
    const issued = await app.inject({
      method: "POST",
      url: `/v1/billing/statements/${id}/issue`,
      headers: AUTH,
      payload: { reason: "bil march invoice" },
    });
    expect(issued.statusCode).toBe(200);
    const frozenTotal = issued.json().statement.totalUsd as number;
    const frozenUsage = issued.json().statement.usageSubtotalUsd as number;
    expect(frozenTotal).toBeGreaterThan(0);

    // TEN TIMES the price, as a new immutable version of the same card
    const newer = await app.inject({
      method: "POST",
      url: "/v1/billing/rate-cards",
      headers: AUTH,
      payload: {
        name: "bil-standard",
        entries: [
          { dimension: "model", matchKey: "bil-model", unit: "per_1k_input_tokens", unitPriceUsd: 20 },
          { dimension: "model", matchKey: "bil-model", unit: "per_1k_output_tokens", unitPriceUsd: 60 },
          { dimension: "connector", matchKey: "*", unit: "per_call", unitPriceUsd: 5 },
          { dimension: "seat", matchKey: "*", unit: "per_seat_month", unitPriceUsd: 100 },
        ],
      },
    });
    expect(newer.statusCode).toBe(201);
    expect(newer.json().rateCard.version).toBe(2);
    cardV2Id = newer.json().rateCard.id;
    createdCardIds.push(cardV2Id);

    // the ISSUED row is byte-identical, from the DB not from a cached response
    const [row] = await db.select().from(billingStatements).where(eq(billingStatements.id, id));
    expect(row!.status).toBe("issued");
    expect(row!.totalUsd).toBe(frozenTotal);
    expect(row!.usageSubtotalUsd).toBe(frozenUsage);
    expect(row!.rateCardVersion).toBe(1);

    // and it STILL reconciles — the re-derivation replays the frozen snapshot,
    // not the live card
    const rec = await app.inject({ method: "POST", url: `/v1/billing/statements/${id}/reconcile`, headers: AUTH });
    expect(rec.json().matches).toBe(true);
    expect(rec.json().issued.totalUsd).toBe(frozenTotal);
  });

  it("refuses to issue the same statement twice", async () => {
    const [issuedRow] = await db
      .select()
      .from(billingStatements)
      .where(and(eq(billingStatements.periodId, orgPeriodId), eq(billingStatements.status, "issued")))
      .limit(1);
    const again = await app.inject({
      method: "POST",
      url: `/v1/billing/statements/${issuedRow!.id}/issue`,
      headers: AUTH,
      payload: { reason: "again" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("statement_not_draft");
    expect(again.json().detail).toMatch(/immutable/);
  });

  it("re-cutting the period APPENDS a version and leaves the issued one untouched", async () => {
    const [before] = await db
      .select()
      .from(billingStatements)
      .where(and(eq(billingStatements.periodId, orgPeriodId), eq(billingStatements.status, "issued")))
      .limit(1);
    const recut = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${orgPeriodId}/statements`,
      headers: AUTH,
      payload: { rateCardId: cardV2Id },
    });
    expect(recut.statusCode).toBe(201);
    expect(recut.json().statement.version).toBeGreaterThan(before!.version);
    // the NEW version is rated at the NEW card and is therefore bigger …
    expect(recut.json().statement.rateCardVersion).toBe(2);
    expect(recut.json().report.usageSubtotalUsd).toBeGreaterThan(before!.usageSubtotalUsd);
    // … and the OLD one has not moved
    const [after] = await db.select().from(billingStatements).where(eq(billingStatements.id, before!.id));
    expect(after!.status).toBe("issued");
    expect(after!.totalUsd).toBe(before!.totalUsd);
    expect(after!.issuedAt?.getTime()).toBe(before!.issuedAt?.getTime());
  });
});

describe("ADR-0051 — billing cannot exceed the caller's own visibility", () => {
  it("refuses an ORG period to a non-admin, and audits the refusal", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${orgPeriodId}/statements`,
      headers: leadAAuth,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("billing_scope_not_entitled");
    const rows = await audits("billing-scope-denied");
    expect(rows.some((r) => r.userId === leadAId && r.effect === "deny")).toBe(true);
  });

  it("scopes a team lead's own view to their project — the other team's spend is ABSENT, not hidden", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${teamPeriodId}/statements`,
      headers: leadAAuth,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.scope.effectiveProjectIds).toEqual([alphaId]);
    expect(JSON.stringify(body.report)).not.toContain(betaId);
    const alphaOnly = await expectedFromLedger([alphaId], new Date(body.report.derivedThroughAt));
    const both = await expectedFromLedger([alphaId, betaId], new Date(body.report.derivedThroughAt));
    expect(body.report.usageSubtotalUsd).toBe(alphaOnly.usageUsd);
    // proof the scoping is arithmetic, not cosmetic
    expect(body.report.usageSubtotalUsd).toBeLessThan(both.usageUsd);
    // and the PERSISTED record of what it was allowed to total agrees
    const [row] = await db.select().from(billingStatements).where(eq(billingStatements.id, body.statement.id));
    expect(row!.effectiveProjectIds).toEqual([alphaId]);
  });

  it("refuses another team's period outright", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${teamPeriodId}/statements`,
      headers: leadBAuth,
    });
    expect(res.statusCode).toBe(403);
    expect((await audits("billing-scope-denied")).some((r) => r.userId === leadBId)).toBe(true);
  });

  it("refuses a non-admin the READ, the EXPORT and the RECONCILE of an org statement, and omits it from their list", async () => {
    const cut = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${orgPeriodId}/statements`,
      headers: AUTH,
    });
    const id = cut.json().statement.id as string;
    for (const [method, url] of [
      ["GET", `/v1/billing/statements/${id}`],
      ["GET", `/v1/billing/statements/${id}/export?format=csv`],
      ["POST", `/v1/billing/statements/${id}/reconcile`],
    ] as const) {
      const res = await app.inject({ method, url, headers: leadAAuth });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe("billing_scope_not_entitled");
    }
    const list = await app.inject({ method: "GET", url: "/v1/billing/statements", headers: leadAAuth });
    expect(list.statusCode).toBe(200);
    expect(list.json().statements.some((s: { id: string }) => s.id === id)).toBe(false);
    // and nothing in the list leaks the other team's numbers
    expect(JSON.stringify(list.json())).not.toContain(betaId);
    expect((await audits("billing-statement-read-denied")).length).toBeGreaterThan(0);
    expect((await audits("billing-statement-export-denied")).length).toBeGreaterThan(0);
  });

  it("refuses to ISSUE a partial-scope view as an invoice", async () => {
    const cut = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${teamPeriodId}/statements`,
      headers: leadAAuth,
    });
    const id = cut.json().statement.id as string;
    expect(cut.json().scope.coversFullScope).toBe(true);
    // an admin CAN issue a full-scope team statement; the partial case is the
    // one that must be refused, so force it: cut a team-B-visible view of the
    // team-A period is impossible (403 above), so assert the guard directly on
    // a statement whose coversFullScope was persisted false.
    await db.update(billingStatements).set({ coversFullScope: false }).where(eq(billingStatements.id, id));
    const res = await app.inject({
      method: "POST",
      url: `/v1/billing/statements/${id}/issue`,
      headers: AUTH,
      payload: { reason: "should not be possible" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("statement_partial_scope");
    expect((await audits("billing-statement-issue-refused-partial")).length).toBeGreaterThan(0);
    const [row] = await db.select().from(billingStatements).where(eq(billingStatements.id, id));
    expect(row!.status).toBe("draft");
    expect(row!.issuedAt).toBeNull();
  });
});

describe("ADR-0051 — period close is operator-driven and idempotent", () => {
  it("closes once, cuts one statement, and recognises a re-drive", async () => {
    const p = await app.inject({
      method: "POST",
      url: "/v1/billing/periods",
      headers: AUTH,
      payload: {
        scopeKind: "project",
        scopeId: betaId,
        periodStart: WINDOW_START.toISOString(),
        periodEnd: WINDOW_END.toISOString(),
        rateCardId: cardId,
      },
    });
    expect(p.statusCode).toBe(201);
    const periodId = p.json().period.id as string;
    createdPeriodIds.push(periodId);
    expect(p.json().note).toMatch(/Nothing drives period close/);

    const first = await app.inject({ method: "POST", url: `/v1/billing/periods/${periodId}/close`, headers: AUTH });
    expect(first.statusCode).toBe(200);
    expect(first.json().alreadyClosed).toBe(false);
    const statementId = first.json().statement.id as string;
    const closedAt = first.json().period.closedAt as string;

    const second = await app.inject({ method: "POST", url: `/v1/billing/periods/${periodId}/close`, headers: AUTH });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyClosed).toBe(true);
    expect(second.json().statement.id).toBe(statementId);
    expect(second.json().period.closedAt).toBe(closedAt);

    const versions = await db.select().from(billingStatements).where(eq(billingStatements.periodId, periodId));
    expect(versions).toHaveLength(1);
    expect((await audits("billing-period-closed")).length).toBeGreaterThan(0);
  });

  it("opening the same period twice returns the existing one rather than failing", async () => {
    const again = await app.inject({
      method: "POST",
      url: "/v1/billing/periods",
      headers: AUTH,
      payload: {
        scopeKind: "org",
        periodStart: WINDOW_START.toISOString(),
        periodEnd: WINDOW_END.toISOString(),
      },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(again.json().period.id).toBe(orgPeriodId);
  });

  it("discloses that no scheduled job closes a period", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/billing/periods", headers: AUTH });
    // ADR-0064 added a scheduler and six jobs; cutting a billing period is
    // deliberately not one of them, and the disclosure says WHY rather than
    // claiming a scheduler does not exist.
    expect(res.json().schedulerPresent).toBe(false);
    expect(res.json().note).toMatch(/no scheduled job closes a billing period/i);
    expect(res.json().note).toMatch(/commercial act a timer must not perform/i);
  });
});

describe("ADR-0051 — export, and the double-bill guard", () => {
  it("emits the documented CSV, and a second export of the same period does not create a second shipment", async () => {
    const cut = await app.inject({
      method: "POST",
      url: `/v1/billing/periods/${teamPeriodId}/statements`,
      headers: AUTH,
    });
    const id = cut.json().statement.id as string;
    const total = cut.json().report.totalUsd as number;

    const csv = await app.inject({
      method: "GET",
      url: `/v1/billing/statements/${id}/export?format=csv`,
      headers: AUTH,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.headers["x-regulait-billing-basis"]).toBe("rate-card-over-measured-ledger");
    const rows = parseStatementCsv(csv.body);
    const cell = (s: string, k: string, m: string) =>
      rows.find((r) => r.section === s && r.key === k && r.metric === m)?.value;
    expect(Number(cell("total", "statement", "total_usd"))).toBe(total);
    expect(cell("meta", "statement", "rating_mode")).toBe("estimated");

    const again = await app.inject({
      method: "GET",
      url: `/v1/billing/statements/${id}/export?format=json`,
      headers: AUTH,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().exported).toBe(false);
    expect((await audits("billing-statement-export-deduped")).length).toBeGreaterThan(0);
  });
});

describe("ADR-0051 — admin gating and audit", () => {
  it("refuses a non-admin the authoring and close surface", async () => {
    for (const [method, url, payload] of [
      ["POST", "/v1/billing/rate-cards", { name: "bil-nope", entries: [{ dimension: "seat", matchKey: "*", unit: "per_seat_month", unitPriceUsd: 1 }] }],
      ["GET", "/v1/billing/rate-cards", undefined],
      ["POST", "/v1/billing/periods", { scopeKind: "org", periodStart: WINDOW_START.toISOString(), periodEnd: WINDOW_END.toISOString() }],
      ["GET", "/v1/billing/periods", undefined],
      ["POST", `/v1/billing/periods/${orgPeriodId}/close`, {}],
      ["GET", "/v1/billing/overview", undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: leadAAuth, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const leaked = await db.select().from(rateCards).where(eq(rateCards.name, "bil-nope"));
    expect(leaked).toHaveLength(0);
  });

  it("audits every governed billing act with a stable ruleId", async () => {
    for (const ruleId of [
      "billing-rate-card-created",
      "billing-period-opened",
      "billing-period-closed",
      "billing-statement-cut",
      "billing-statement-issued",
      "billing-statement-exported",
      "billing-scope-denied",
    ]) {
      expect((await audits(ruleId)).length, ruleId).toBeGreaterThan(0);
    }
    const cuts = await audits("billing-statement-cut");
    expect(cuts.every((c) => c.objectType === "billing_statement")).toBe(true);
    // the honest record of what each cut was PERMITTED to total
    expect(
      cuts.some((c) => Array.isArray((c.detail as { effectiveProjectIds?: string[] }).effectiveProjectIds)),
    ).toBe(true);
  });

  it("the overview discloses that no payment processor is integrated and nothing is reconciled", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/billing/overview", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().paymentProcessorIntegrated).toBe(false);
    expect(res.json().reconciledRatingAvailable).toBe(false);
    expect(res.json().schedulerPresent).toBe(false);
    expect(res.json().backend.name).toBe("noop");
    expect(res.json().backend.capabilities.requiresNetwork).toBe(false);
    expect(res.json().note).toMatch(/READ-SIDE consumer of usage_events/);
    expect(res.json().note).toMatch(/no SCHEDULED JOB closes a period/i);
  });
});
