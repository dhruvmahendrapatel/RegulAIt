/**
 * ADR-0051 — the GATEWAY half of METERING & BILLING.
 *
 *   `packages/shared/src/billing.ts`   the rate lookup, the deterministic
 *                                      ledger→money rating, the statement
 *                                      assembly, the re-derivation comparison,
 *                                      the CSV, and the `BillingProvider` port.
 *                                      Pure — no db, no clock, no Fastify.
 *   THIS FILE                          the `usage_events` queries, the
 *                                      entitlement scoping, the append-only
 *                                      statement versions, the admin API and
 *                                      the audit rows.
 *
 * FIVE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. EVERY BILLED NUMBER COMES FROM THE MEASURED LEDGER. `deriveStatement`
 *     SELECTs `usage_events` for the period window and hands the rows to
 *     `buildStatement`. There is no billing counter, no rollup table and
 *     nothing incremented at dispatch time. `billing_statements.payload` is the
 *     ARTIFACT of a derivation — it is never read back as an input to another
 *     computation, and `POST .../reconcile` re-derives from the ledger and
 *     compares. A parallel counter would be faster and would drift, and the
 *     drift would be found by a customer reading an invoice.
 *
 *  2. AN ISSUED STATEMENT IS IMMUTABLE. There is no UPDATE path that touches an
 *     issued row's money. Re-cutting a period appends version N+1 and marks N
 *     `superseded`; issuing twice is a 409. The price it was rated at is COPIED
 *     into `pricing_snapshot` at cut time, so changing a rate card afterwards
 *     cannot restate history — and rate cards are themselves immutable
 *     versions, so belt and braces.
 *
 *  3. BILLING NEVER EXCEEDS THE CALLER'S OWN VISIBILITY. Scope is resolved by
 *     ADR-0047's `evaluateReportAccess` — the same function, via ADR-0049's
 *     `resolveSpendAccess` adapter, not a third copy — and every ledger query is
 *     built with `inArray(usage_events.project_id, thoseIds)`. The narrowing
 *     happens at QUERY CONSTRUCTION: a post-hoc filter over an aggregate cannot
 *     un-aggregate it, and an invoice is exactly the shape in which another
 *     team's spend leaks. A caller who can see only part of a period's scope
 *     gets a `coversFullScope: false` view that can never be ISSUED.
 *
 *  4. PERIOD CLOSE IS OPERATOR-DRIVEN AND IDEMPOTENT. There is no in-process
 *     scheduler in this codebase (ADRs 0044–0049 all landed the same way).
 *     `POST /v1/billing/periods/:id/close` is what an operator or an external
 *     cron drives, and driving it ten times closes the period once and cuts one
 *     statement. `closedAt` staying null is how a deployment that never wires
 *     the cron SEES that, rather than assuming it works.
 *
 *  5. AN UNPRICED EVENT IS UNPRICED, NOT ZERO. Carried up from the pure half
 *     and surfaced on the statement, the CSV and the overview.
 *
 * WHAT THIS FILE DOES NOT DO — stated here rather than only in the ADR:
 *   - It does not integrate a payment processor. No Stripe, no Metronome, no
 *     Orb, no network call. `NoopBilling` — export-only, §6's BYOC/air-gapped
 *     default — is the only backend that exists, and `capabilities()` says so.
 *   - It does not RECONCILE against a provider invoice. `rating_mode` is a real
 *     column and nothing ever writes `reconciled`, because no importer exists.
 *     §5's honesty rung is modelled, not exercised.
 *   - It does not do tax, currency conversion, dunning or multi-entity billing.
 *     Those are explicitly out of ADR-0051's scope and are absent rather than
 *     half-present.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  billingExports,
  billingPeriods,
  billingStatements,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  rateCardEntries,
  rateCards,
  sql,
  usageEvents,
  users,
  type BillingPeriodRow,
  type BillingStatementRow,
  type Db,
} from "@regulait/db";
import {
  BILLING_DISCLAIMER,
  EMPTY_PRICING_SNAPSHOT,
  NoopBilling,
  billingScopeKey,
  buildStatement,
  createBillingPeriodSchema,
  createRateCardSchema,
  generateStatementSchema,
  issueStatementSchema,
  reconcileStatement,
  renderStatementCsv,
  statementCsvRows,
  type PricingSnapshot,
  type RatableEvent,
  type ReportAccessDecision,
  type StatementPayload,
} from "@regulait/shared";
import { callerProjectIds } from "./reporting.js";
import { resolveSpendAccess, type SpendScopeRequest } from "./spend-monitor.js";
import { resolveScopeProjectIds } from "./reporting.js";
import { callerTeamIds } from "./reporting.js";
import { securityHeaders } from "./security-headers.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** a uuid that cannot exist, so an empty allow-list yields an empty result set
 * rather than an unconstrained query — fail CLOSED, never open */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const idParam = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------------------
// THE ONE DEFINITION OF "AN ACTIVE SEAT"
// ---------------------------------------------------------------------------

/**
 * ADR-0052 §3 owns this definition and ADR-0051 §3 consumes it: "Seat count is
 * computed from the same user table the admin console manages, so there is
 * exactly one definition of 'an active user' and ADR-0051's billing consumes
 * that same number."
 *
 * It lives here because billing was built first; `licensing.ts` imports THIS
 * function rather than counting again. Two copies that agree today are how a
 * seat cap and a seat invoice end up disagreeing, and the disagreement is
 * always discovered by the customer who paid for the difference.
 *
 * ADR-0022 is the load-bearing clause: deactivate ≠ delete. A disabled user
 * keeps every FK, audit row and history — and consumes NO seat, because they
 * cannot authenticate and cannot dispatch. Billing a suspended employee would
 * be a real overcharge.
 */
export async function countActiveSeats(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(isNull(users.disabledAt));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Pricing snapshots — reading a card, and freezing it
// ---------------------------------------------------------------------------

export async function loadPricingSnapshot(db: Db, rateCardId: string | null): Promise<PricingSnapshot> {
  if (!rateCardId) return EMPTY_PRICING_SNAPSHOT;
  const [card] = await db.select().from(rateCards).where(eq(rateCards.id, rateCardId));
  if (!card) return EMPTY_PRICING_SNAPSHOT;
  const entries = await db.select().from(rateCardEntries).where(eq(rateCardEntries.rateCardId, card.id));
  return {
    rateCardId: card.id,
    name: card.name,
    version: card.version,
    currency: card.currency,
    // sorted so two snapshots of the same card are byte-identical, which is
    // what lets a re-derivation be compared rather than merely recomputed
    entries: entries
      .map((e) => ({
        dimension: e.dimension,
        matchKey: e.matchKey,
        unit: e.unit,
        unitPriceUsd: e.unitPriceUsd,
      }))
      .sort((a, b) =>
        `${a.dimension} ${a.matchKey} ${a.unit}`.localeCompare(`${b.dimension} ${b.matchKey} ${b.unit}`),
      ),
  };
}

/** the ACTIVE card, when a period names none */
export async function defaultRateCardId(db: Db): Promise<string | null> {
  const [card] = await db
    .select({ id: rateCards.id })
    .from(rateCards)
    .where(eq(rateCards.status, "active"))
    .orderBy(desc(rateCards.createdAt))
    .limit(1);
  return card?.id ?? null;
}

// ---------------------------------------------------------------------------
// THE DERIVATION — every figure from the measured ledger
// ---------------------------------------------------------------------------

export interface DeriveInput {
  period: Pick<BillingPeriodRow, "scopeKind" | "scopeId" | "periodStart" | "periodEnd">;
  projectIds: string[] | null;
  snapshot: PricingSnapshot;
  seatCount: number;
  /** re-derivation replays the ledger AS OF this instant; a re-run passes the
   * ORIGINAL cut time, which is what makes the comparison meaningful */
  derivedThroughAt: Date;
}

export async function deriveStatement(db: Db, input: DeriveInput): Promise<StatementPayload> {
  const { period, projectIds } = input;
  // THE SCOPE PREDICATE, built once, applied at QUERY CONSTRUCTION. `null` (an
  // admin org period) means no project constraint — the only way spend
  // attributed to no project enters a bill, which is correct for an org invoice
  // and wrong for anything narrower.
  const scoped =
    projectIds === null ? undefined : inArray(usageEvents.projectId, projectIds.length ? projectIds : [ZERO_UUID]);
  const rows = await db
    .select({
      objectType: usageEvents.objectType,
      model: usageEvents.model,
      connectorId: usageEvents.connectorId,
      operation: usageEvents.operation,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      costUsd: usageEvents.costUsd,
    })
    .from(usageEvents)
    .where(
      and(
        gte(usageEvents.at, period.periodStart),
        lt(usageEvents.at, period.periodEnd),
        // the window is also closed at the CUT INSTANT: a row that arrives after
        // a statement was cut must not silently appear in its re-derivation.
        lt(usageEvents.at, input.derivedThroughAt),
        ...(scoped ? [scoped] : []),
      ),
    );

  return buildStatement({
    periodLabel: `${period.periodStart.toISOString().slice(0, 10)}..${period.periodEnd.toISOString().slice(0, 10)}`,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    scopeKind: period.scopeKind,
    scopeId: period.scopeId,
    projectIds,
    snapshot: input.snapshot,
    events: rows as RatableEvent[],
    seatCount: input.seatCount,
    derivedThroughAt: input.derivedThroughAt,
  });
}

// ---------------------------------------------------------------------------
// Access — ADR-0047's decision function, reached through ADR-0049's adapter
// ---------------------------------------------------------------------------

async function decideForPeriod(
  db: Db,
  actor: { userId: string | null; isAdmin: boolean },
  period: Pick<BillingPeriodRow, "scopeKind" | "scopeId">,
): Promise<{ decision: ReportAccessDecision; scopeProjectIds: string[] }> {
  const request: SpendScopeRequest = {
    scopeKind: period.scopeKind as SpendScopeRequest["scopeKind"],
    scopeId: period.scopeId,
  };
  const scopeProjectIds = await resolveScopeProjectIds(db, request);
  const decision = resolveSpendAccess({
    isAdmin: actor.isAdmin,
    userId: actor.userId,
    request,
    scopeProjectIds,
    callerProjectIds: await callerProjectIds(db, actor.userId),
    callerTeamIds: await callerTeamIds(db, actor.userId),
  });
  return { decision, scopeProjectIds };
}

/** does this caller's decision cover the period's ENTIRE scope? Only a full
 * view may be issued as an invoice; a partial one is a personal read. */
function coversFullScope(decision: ReportAccessDecision, scopeProjectIds: string[]): boolean {
  if (decision.projectIds === null) return true; // admin, org period
  const mine = new Set(decision.projectIds);
  return scopeProjectIds.every((p) => mine.has(p));
}

/**
 * Can this caller READ an already-cut statement? Same discipline as ADR-0047's
 * `canReadRun`: the artifact carries the entitlement scope it was cut under,
 * COPIED at generation, so editing memberships afterwards cannot retroactively
 * widen the audience of a document that already exists.
 */
export async function canReadStatement(
  db: Db,
  st: Pick<BillingStatementRow, "entitlementScope" | "effectiveProjectIds">,
  actor: { userId: string | null; isAdmin: boolean },
): Promise<boolean> {
  if (actor.isAdmin) return true;
  if (!actor.userId) return false;
  if (st.entitlementScope === "org" || st.effectiveProjectIds === null) return false;
  const mine = new Set(await callerProjectIds(db, actor.userId));
  return (st.effectiveProjectIds as string[]).every((p) => mine.has(p));
}

// ---------------------------------------------------------------------------
// Cutting a version
// ---------------------------------------------------------------------------

export interface CutResult {
  ok: true;
  statement: BillingStatementRow;
  payload: StatementPayload;
  decision: ReportAccessDecision;
}
export interface CutRefusal {
  ok: false;
  status: number;
  error: string;
  detail: string;
}

export async function cutStatement(
  db: Db,
  args: {
    period: BillingPeriodRow;
    actor: { userId: string | null; isAdmin: boolean };
    rateCardId?: string | null;
    now?: Date;
  },
): Promise<CutResult | CutRefusal> {
  const now = args.now ?? new Date();
  const { decision, scopeProjectIds } = await decideForPeriod(db, args.actor, args.period);
  if (!decision.allowed) {
    // THE REFUSAL IS THE RECORD. An invoice aggregates across a scope, so "who
    // was told no, and for which period" belongs in the trail as much as what
    // was produced.
    await db.insert(auditLog).values({
      userId: args.actor.userId ?? NO_IDENTITY,
      objectType: "billing_period",
      objectId: args.period.id,
      detail: {
        phase: "cut-statement",
        scopeKind: args.period.scopeKind,
        scopeId: args.period.scopeId,
        scopeProjectCount: scopeProjectIds.length,
        ruleId: decision.ruleId,
      },
      effect: "deny",
      ruleId: "billing-scope-denied",
      ruleChain: [],
      reason: decision.reason,
    });
    return { ok: false, status: 403, error: "billing_scope_not_entitled", detail: decision.reason };
  }

  const rateCardId = args.rateCardId ?? args.period.rateCardId ?? (await defaultRateCardId(db));
  const snapshot = await loadPricingSnapshot(db, rateCardId);
  const seatCount = await countActiveSeats(db);
  const payload = await deriveStatement(db, {
    period: args.period,
    projectIds: decision.projectIds,
    snapshot,
    seatCount,
    derivedThroughAt: now,
  });

  // APPEND-ONLY: the previous version is superseded, never overwritten. An
  // ISSUED version is superseded too — it stays in the table, immutable, with
  // its own money and its own snapshot; superseding records that a newer
  // derivation exists, it does not edit the old one.
  const [latest] = await db
    .select({ version: billingStatements.version })
    .from(billingStatements)
    .where(eq(billingStatements.periodId, args.period.id))
    .orderBy(desc(billingStatements.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  if (latest) {
    await db
      .update(billingStatements)
      .set({ status: "superseded" })
      .where(and(eq(billingStatements.periodId, args.period.id), eq(billingStatements.status, "draft")));
  }

  const entitlementScope =
    args.period.scopeKind === "org" ? "org" : args.period.scopeKind === "team" ? "team" : "project";

  const [row] = await db
    .insert(billingStatements)
    .values({
      periodId: args.period.id,
      version,
      status: "draft",
      ratingMode: "estimated",
      rateCardId: snapshot.rateCardId,
      rateCardName: snapshot.name,
      rateCardVersion: snapshot.version,
      pricingSnapshot: snapshot as unknown as Record<string, unknown>,
      entitlementScope,
      effectiveProjectIds: decision.projectIds,
      coversFullScope: coversFullScope(decision, scopeProjectIds),
      derivedThroughAt: now,
      sourceUsageEventCount: payload.usage.eventCount,
      measuredInputTokens: payload.usage.measuredInputTokens,
      measuredOutputTokens: payload.usage.measuredOutputTokens,
      unpricedEventCount: payload.usage.unpricedEventCount,
      ledgerEstimatedCostUsd: payload.usage.ledgerEstimatedCostUsd,
      seatCount,
      usageSubtotalUsd: payload.usageSubtotalUsd,
      seatSubtotalUsd: payload.seatSubtotalUsd,
      totalUsd: payload.totalUsd,
      payload: payload as unknown as Record<string, unknown>,
      generatedByUserId: args.actor.userId ?? null,
    })
    .returning();

  await db.insert(auditLog).values({
    userId: args.actor.userId ?? NO_IDENTITY,
    objectType: "billing_statement",
    objectId: row!.id,
    detail: {
      phase: "cut-statement",
      periodId: args.period.id,
      version,
      rateCard: `${snapshot.name} v${snapshot.version}`,
      totalUsd: payload.totalUsd,
      usageSubtotalUsd: payload.usageSubtotalUsd,
      seatSubtotalUsd: payload.seatSubtotalUsd,
      seatCount,
      sourceUsageEventCount: payload.usage.eventCount,
      unpricedEventCount: payload.usage.unpricedEventCount,
      ledgerEstimatedCostUsd: payload.usage.ledgerEstimatedCostUsd,
      effectiveProjectIds: decision.projectIds,
      coversFullScope: row!.coversFullScope,
    },
    effect: "allow",
    ruleId: "billing-statement-cut",
    ruleChain: [],
    reason:
      `statement v${version} derived from usage_events for ` +
      (decision.projectIds === null
        ? "the whole organization (admin, org-scoped period)"
        : `${decision.projectIds.length} entitled project(s)`) +
      ` at rate card '${snapshot.name}' v${snapshot.version} — $${payload.totalUsd} total, ` +
      `${payload.usage.unpricedEventCount} unpriced event(s) reported as UNPRICED rather than zero. ` +
      "This is a DRAFT: nothing is charged, and no payment processor is integrated.",
  });

  return { ok: true, statement: row!, payload, decision };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerBillingRoutes(app: FastifyInstance, db: Db): void {
  async function audit(
    actor: string | null,
    objectType: "rate_card" | "billing_period" | "billing_statement",
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId: actor ?? NO_IDENTITY,
      objectType,
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  // --- rate cards (ADMIN) — immutable versions, never edited ---------------

  app.post("/v1/billing/rate-cards", async (req, reply) => {
    const body = createRateCardSchema.parse(req.body);
    const [prev] = await db
      .select({ id: rateCards.id, version: rateCards.version })
      .from(rateCards)
      .where(eq(rateCards.name, body.name))
      .orderBy(desc(rateCards.version))
      .limit(1);
    const version = (prev?.version ?? 0) + 1;
    const [card] = await db
      .insert(rateCards)
      .values({
        name: body.name,
        version,
        currency: body.currency,
        description: body.description ?? null,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await db.insert(rateCardEntries).values(
      body.entries.map((e) => ({
        rateCardId: card!.id,
        dimension: e.dimension,
        matchKey: e.matchKey,
        unit: e.unit,
        unitPriceUsd: e.unitPriceUsd,
      })),
    );
    if (prev) {
      await db.update(rateCards).set({ status: "superseded" }).where(eq(rateCards.id, prev.id));
    }
    await audit(
      req.authCtx.userId ?? null,
      "rate_card",
      card!.id,
      "billing-rate-card-created",
      `admin created rate card '${body.name}' v${version} with ${body.entries.length} entry/entries` +
        (prev ? `, superseding v${prev.version}` : "") +
        ". Rate cards are IMMUTABLE VERSIONS: this does not restate any statement already cut, " +
        "because every statement carries the pricing snapshot it was rated against.",
      { name: body.name, version, entries: body.entries.length, supersedes: prev?.version ?? null },
    );
    return reply.status(201).send({
      rateCard: { ...card, entries: body.entries },
      note:
        "Immutable. A price change creates the NEXT version and supersedes this one; already-issued " +
        "statements are unaffected because each froze its own pricing snapshot.",
    });
  });

  app.get("/v1/billing/rate-cards", async () => {
    const cards = await db.select().from(rateCards).orderBy(desc(rateCards.createdAt));
    const entries = await db.select().from(rateCardEntries);
    return {
      rateCards: cards.map((c) => ({ ...c, entries: entries.filter((e) => e.rateCardId === c.id) })),
      note:
        "A rate card is a COMMERCIAL price, deliberately separate from the provider list price in " +
        "cost_events. A rating error can therefore never corrupt the measured ledger (ADR-0051 §3).",
    };
  });

  app.get("/v1/billing/rate-cards/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [card] = await db.select().from(rateCards).where(eq(rateCards.id, id));
    if (!card) return reply.status(404).send({ error: "unknown_rate_card" });
    const entries = await db.select().from(rateCardEntries).where(eq(rateCardEntries.rateCardId, id));
    return { rateCard: { ...card, entries } };
  });

  // --- periods (ADMIN) -----------------------------------------------------

  app.post("/v1/billing/periods", async (req, reply) => {
    const body = createBillingPeriodSchema.parse(req.body);
    const start = new Date(body.periodStart);
    const end = new Date(body.periodEnd);
    const scopeId = body.scopeId ?? null;
    const [existing] = await db
      .select()
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.scopeKind, body.scopeKind),
          eq(billingPeriods.scopeKey, billingScopeKey(scopeId)),
          eq(billingPeriods.periodStart, start),
          eq(billingPeriods.periodEnd, end),
        ),
      );
    // OPENING IS IDEMPOTENT TOO: the unique index would refuse a duplicate, and
    // a 500 on a re-run is a worse answer than "you already have this one".
    if (existing) return reply.status(200).send({ period: existing, created: false });

    const [row] = await db
      .insert(billingPeriods)
      .values({
        scopeKind: body.scopeKind,
        scopeId,
        scopeKey: billingScopeKey(scopeId),
        periodStart: start,
        periodEnd: end,
        rateCardId: body.rateCardId ?? (await defaultRateCardId(db)),
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      "billing_period",
      row!.id,
      "billing-period-opened",
      `admin opened a ${body.scopeKind}-scoped billing period ${body.periodStart} → ${body.periodEnd}. ` +
        "Opening a period computes nothing: no in-process scheduler exists in this deployment, so an " +
        "operator or an external cron must call POST /v1/billing/periods/:id/close.",
      { scopeKind: body.scopeKind, scopeId, periodStart: body.periodStart, periodEnd: body.periodEnd },
    );
    return reply.status(201).send({
      period: row,
      created: true,
      note: "Nothing drives period close. POST /v1/billing/periods/:id/close is the driver.",
    });
  });

  app.get("/v1/billing/periods", async () => {
    const rows = await db.select().from(billingPeriods).orderBy(desc(billingPeriods.periodStart));
    return {
      periods: rows,
      schedulerPresent: false,
      note:
        "There is no in-process scheduler in this deployment. A period stays open until an operator " +
        "or an external cron calls POST /v1/billing/periods/:id/close; `closedAt` staying null is how " +
        "that is visible rather than silent.",
    };
  });

  /**
   * THE CLOSE, as an ENDPOINT — the same shape ADR-0045's expiry sweep,
   * ADR-0046's SLA evaluation, ADR-0047's schedule sweep and ADR-0049's anomaly
   * evaluator take, and for the same reason: there is no scheduler here to hang
   * it on. Admin-only, because it cuts at the period's full scope.
   *
   * IDEMPOTENT. A cron that fires ten times closes once and cuts one statement.
   */
  app.post("/v1/billing/periods/:id/close", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [period] = await db.select().from(billingPeriods).where(eq(billingPeriods.id, id));
    if (!period) return reply.status(404).send({ error: "unknown_billing_period" });

    if (period.status === "closed") {
      const [existing] = await db
        .select()
        .from(billingStatements)
        .where(eq(billingStatements.periodId, id))
        .orderBy(desc(billingStatements.version))
        .limit(1);
      return reply.status(200).send({
        period,
        statement: existing ?? null,
        alreadyClosed: true,
        note:
          "This period was already closed; nothing was recomputed and no new statement version was " +
          "cut. Close is idempotent so an external cron can drive it without producing duplicates.",
      });
    }

    const res = await cutStatement(db, {
      period,
      actor: { userId: req.authCtx.userId ?? null, isAdmin: req.authCtx.isAdmin },
    });
    if (!res.ok) return reply.status(res.status).send({ error: res.error, detail: res.detail });

    const now = new Date();
    const [closed] = await db
      .update(billingPeriods)
      .set({ status: "closed", closedAt: now, closedByUserId: req.authCtx.userId ?? null })
      .where(eq(billingPeriods.id, id))
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      "billing_period",
      id,
      "billing-period-closed",
      `operator-driven close of a ${period.scopeKind}-scoped billing period: statement v${res.statement.version} ` +
        `cut at $${res.payload.totalUsd}. The statement is a DRAFT until explicitly issued; nothing is charged.`,
      { version: res.statement.version, totalUsd: res.payload.totalUsd, statementId: res.statement.id },
    );
    return {
      period: closed,
      statement: res.statement,
      report: res.payload,
      alreadyClosed: false,
      note:
        "Nothing calls this on a timer — there is no in-process scheduler in this codebase. Re-driving " +
        "it is safe: a closed period is recognised and returns its existing statement unchanged.",
    };
  });

  // --- statements ----------------------------------------------------------

  /** Cut a NEW version for a period. Non-admin reachable: a team lead may cut a
   * view of their own team's period, which is recorded with
   * `coversFullScope: false` and can never be issued as an invoice. */
  app.post("/v1/billing/periods/:id/statements", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = generateStatementSchema.parse(req.body ?? {});
    const [period] = await db.select().from(billingPeriods).where(eq(billingPeriods.id, id));
    if (!period) return reply.status(404).send({ error: "unknown_billing_period" });
    const res = await cutStatement(db, {
      period,
      actor: { userId: req.authCtx.userId ?? null, isAdmin: req.authCtx.isAdmin },
      rateCardId: body.rateCardId ?? undefined,
    });
    if (!res.ok) return reply.status(res.status).send({ error: res.error, detail: res.detail });
    return reply.status(201).send({
      statement: { ...res.statement, payload: undefined },
      report: res.payload,
      scope: {
        entitlementScope: res.statement.entitlementScope,
        effectiveProjectIds: res.decision.projectIds,
        coversFullScope: res.statement.coversFullScope,
        reason: res.decision.reason,
      },
      note: res.statement.coversFullScope
        ? "Draft. Issue it explicitly to freeze it as an invoice."
        : "Draft, PARTIAL SCOPE: this version covers only the projects you can see, so it is a personal " +
          "view and may not be issued as the period's invoice.",
    });
  });

  app.get("/v1/billing/statements", async (req) => {
    const q = z
      .object({
        periodId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});
    const rows = await db
      .select({
        id: billingStatements.id,
        periodId: billingStatements.periodId,
        version: billingStatements.version,
        status: billingStatements.status,
        ratingMode: billingStatements.ratingMode,
        rateCardName: billingStatements.rateCardName,
        rateCardVersion: billingStatements.rateCardVersion,
        entitlementScope: billingStatements.entitlementScope,
        effectiveProjectIds: billingStatements.effectiveProjectIds,
        coversFullScope: billingStatements.coversFullScope,
        derivedThroughAt: billingStatements.derivedThroughAt,
        sourceUsageEventCount: billingStatements.sourceUsageEventCount,
        unpricedEventCount: billingStatements.unpricedEventCount,
        seatCount: billingStatements.seatCount,
        usageSubtotalUsd: billingStatements.usageSubtotalUsd,
        seatSubtotalUsd: billingStatements.seatSubtotalUsd,
        totalUsd: billingStatements.totalUsd,
        generatedAt: billingStatements.generatedAt,
        issuedAt: billingStatements.issuedAt,
      })
      .from(billingStatements)
      .where(q.periodId ? eq(billingStatements.periodId, q.periodId) : undefined)
      .orderBy(desc(billingStatements.generatedAt))
      .limit(q.limit);
    if (req.authCtx.isAdmin) return { statements: rows, disclaimer: BILLING_DISCLAIMER };
    // a non-admin sees only artifacts they could have cut themselves — the same
    // narrowing ADR-0047 applies to report runs.
    const mine = new Set(await callerProjectIds(db, req.authCtx.userId ?? null));
    return {
      statements: rows.filter(
        (r) =>
          r.entitlementScope !== "org" &&
          r.effectiveProjectIds !== null &&
          (r.effectiveProjectIds as string[]).every((p) => mine.has(p)),
      ),
      disclaimer: BILLING_DISCLAIMER,
    };
  });

  app.get("/v1/billing/statements/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [st] = await db.select().from(billingStatements).where(eq(billingStatements.id, id));
    if (!st) return reply.status(404).send({ error: "unknown_billing_statement" });
    if (!(await canReadStatement(db, st, req.authCtx))) {
      await audit(
        req.authCtx.userId ?? null,
        "billing_statement",
        id,
        "billing-statement-read-denied",
        "a caller without the artifact's entitlement scope tried to read a billing statement",
        { entitlementScope: st.entitlementScope },
        "deny",
      );
      return reply.status(403).send({ error: "billing_scope_not_entitled" });
    }
    return { statement: st, disclaimer: BILLING_DISCLAIMER };
  });

  /** ISSUE — the one-way door. Admin-only, full-scope-only, and refused on a
   * statement that has already been issued or superseded. */
  app.post("/v1/billing/statements/:id/issue", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = issueStatementSchema.parse(req.body);
    const [st] = await db.select().from(billingStatements).where(eq(billingStatements.id, id));
    if (!st) return reply.status(404).send({ error: "unknown_billing_statement" });
    if (st.status !== "draft") {
      return reply.status(409).send({
        error: "statement_not_draft",
        status: st.status,
        detail:
          st.status === "issued"
            ? "an issued statement is immutable — re-cut the period to produce a NEW version instead"
            : "this version has been superseded by a newer derivation; issue that one",
      });
    }
    if (!st.coversFullScope) {
      await audit(
        req.authCtx.userId ?? null,
        "billing_statement",
        id,
        "billing-statement-issue-refused-partial",
        "refused to issue a PARTIAL-SCOPE statement as an invoice: it covers only the projects its " +
          "generator could see, so issuing it would understate the period while claiming to be it",
        { entitlementScope: st.entitlementScope, effectiveProjectIds: st.effectiveProjectIds },
        "deny",
      );
      return reply.status(409).send({ error: "statement_partial_scope" });
    }
    const now = new Date();
    const [issued] = await db
      .update(billingStatements)
      .set({
        status: "issued",
        issuedAt: now,
        issuedByUserId: req.authCtx.userId ?? null,
        issueReason: body.reason,
      })
      .where(and(eq(billingStatements.id, id), eq(billingStatements.status, "draft")))
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      "billing_statement",
      id,
      "billing-statement-issued",
      `admin issued billing statement v${st.version} at $${st.totalUsd} (rate card '${st.rateCardName}' ` +
        `v${st.rateCardVersion}): ${body.reason}. From this moment the money on this row is FROZEN — ` +
        "a later rate-card version cannot restate it, because the pricing snapshot it was rated " +
        "against is stored on the row itself. No payment processor is integrated: issuing charges nobody.",
      { version: st.version, totalUsd: st.totalUsd, rateCard: `${st.rateCardName} v${st.rateCardVersion}` },
    );
    return { statement: issued };
  });

  /**
   * RE-DERIVE AND COMPARE. This is the check that materializing a period stayed
   * defensible: the statement's OWN frozen snapshot is replayed over the ledger
   * for its OWN window as of its OWN cut instant, and the numbers are compared.
   */
  app.post("/v1/billing/statements/:id/reconcile", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [st] = await db.select().from(billingStatements).where(eq(billingStatements.id, id));
    if (!st) return reply.status(404).send({ error: "unknown_billing_statement" });
    if (!(await canReadStatement(db, st, req.authCtx))) {
      await audit(
        req.authCtx.userId ?? null,
        "billing_statement",
        id,
        "billing-statement-read-denied",
        "a caller without the artifact's entitlement scope tried to reconcile a billing statement",
        { entitlementScope: st.entitlementScope },
        "deny",
      );
      return reply.status(403).send({ error: "billing_scope_not_entitled" });
    }
    const [period] = await db.select().from(billingPeriods).where(eq(billingPeriods.id, st.periodId));
    if (!period) return reply.status(404).send({ error: "unknown_billing_period" });

    const rederived = await deriveStatement(db, {
      period,
      projectIds: st.effectiveProjectIds as string[] | null,
      snapshot: st.pricingSnapshot as unknown as PricingSnapshot,
      seatCount: st.seatCount,
      derivedThroughAt: st.derivedThroughAt,
    });
    const stored = st.payload as unknown as StatementPayload;
    const result = reconcileStatement(stored, rederived);
    await audit(
      req.authCtx.userId ?? null,
      "billing_statement",
      id,
      result.matches ? "billing-statement-reconciled" : "billing-statement-reconcile-drift",
      result.matches
        ? `statement v${st.version} RE-DERIVES exactly from usage_events under its own frozen pricing ` +
          "snapshot — the materialization has not drifted from the ledger it came from"
        : `statement v${st.version} does NOT re-derive from usage_events: ` +
          result.diffs.map((d) => `${d.field} issued=${d.issued} rederived=${d.rederived}`).join("; ") +
          ". The issued figures are NOT altered.",
      { version: st.version, matches: result.matches, diffs: result.diffs },
      result.matches ? "allow" : "deny",
    );
    return {
      statementId: id,
      matches: result.matches,
      diffs: result.diffs,
      issued: { usageSubtotalUsd: stored.usageSubtotalUsd, seatSubtotalUsd: stored.seatSubtotalUsd, totalUsd: stored.totalUsd },
      rederived: {
        usageSubtotalUsd: rederived.usageSubtotalUsd,
        seatSubtotalUsd: rederived.seatSubtotalUsd,
        totalUsd: rederived.totalUsd,
      },
      note: result.note,
    };
  });

  /** EXPORT — chargeback/showback (§4). Needs no billing backend at all, which
   * is the point: the common enterprise ask must not require standing up one. */
  app.get("/v1/billing/statements/:id/export", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ format: z.enum(["csv", "json"]).default("csv") }).parse(req.query ?? {});
    const [st] = await db.select().from(billingStatements).where(eq(billingStatements.id, id));
    if (!st) return reply.status(404).send({ error: "unknown_billing_statement" });
    if (!(await canReadStatement(db, st, req.authCtx))) {
      await audit(
        req.authCtx.userId ?? null,
        "billing_statement",
        id,
        "billing-statement-export-denied",
        "a caller without the artifact's entitlement scope tried to export a billing statement",
        { entitlementScope: st.entitlementScope, format: q.format },
        "deny",
      );
      return reply.status(403).send({ error: "billing_scope_not_entitled" });
    }
    const payload = st.payload as unknown as StatementPayload;
    const rows = statementCsvRows(payload);

    // THE EXPORT LEDGER. Unique on (period, backend), so a double-bill is
    // structurally impossible: a second export of the same period to the same
    // backend recognises the first rather than creating a second shipment.
    const backend = new NoopBilling();
    await backend.pushUsage(
      payload.usage.lines.map((l) => ({
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
        dimension: l.dimension,
        matchKey: l.matchKey,
        events: l.events,
        inputTokens: l.inputTokens,
        outputTokens: l.outputTokens,
        billedUsd: l.billedUsd,
      })),
    );
    const [exportRow] = await db
      .insert(billingExports)
      .values({
        statementId: st.id,
        periodId: st.periodId,
        backend: backend.backend,
        format: q.format,
        rowCount: rows.length,
        usageEventCount: st.sourceUsageEventCount,
        totalUsd: st.totalUsd,
        exportedByUserId: req.authCtx.userId ?? null,
        detail: { capabilities: backend.capabilities(), statementVersion: st.version },
      })
      .onConflictDoNothing()
      .returning({ id: billingExports.id });

    await audit(
      req.authCtx.userId ?? null,
      "billing_statement",
      id,
      exportRow ? "billing-statement-exported" : "billing-statement-export-deduped",
      exportRow
        ? `billing statement v${st.version} exported as ${q.format} to the '${backend.backend}' backend — ` +
          "no external billing system is contacted and no network call is made; the export is the " +
          "artifact a customer transmits on their own schedule (ADR-0051 §6)"
        : `billing statement v${st.version} re-exported as ${q.format}: this period has ALREADY been ` +
          "shipped to this backend, so no second export row was created. A double-bill is structurally " +
          "impossible, not merely unlikely.",
      { format: q.format, statementVersion: st.version, deduped: !exportRow },
    );

    if (q.format === "json") {
      return reply.send({ statement: { ...st, payload: undefined }, report: payload, exported: Boolean(exportRow) });
    }
    const csv = renderStatementCsv(payload);
    for (const [k, v] of Object.entries(securityHeaders("text/csv"))) reply.header(k, v);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="statement-${st.id}.csv"`);
    reply.header("x-regulait-billing-basis", "rate-card-over-measured-ledger");
    return reply.send(csv);
  });

  /** the read-side rollup the admin SPA's Billing page renders */
  app.get("/v1/billing/overview", async () => {
    const cards = await db.select().from(rateCards).orderBy(desc(rateCards.createdAt)).limit(25);
    const periods = await db.select().from(billingPeriods).orderBy(desc(billingPeriods.periodStart)).limit(25);
    const statements = await db
      .select({
        id: billingStatements.id,
        periodId: billingStatements.periodId,
        version: billingStatements.version,
        status: billingStatements.status,
        ratingMode: billingStatements.ratingMode,
        totalUsd: billingStatements.totalUsd,
        seatCount: billingStatements.seatCount,
        unpricedEventCount: billingStatements.unpricedEventCount,
        generatedAt: billingStatements.generatedAt,
        issuedAt: billingStatements.issuedAt,
      })
      .from(billingStatements)
      .orderBy(desc(billingStatements.generatedAt))
      .limit(25);
    const exportRows = await db.select().from(billingExports).orderBy(desc(billingExports.exportedAt)).limit(25);
    const backend = new NoopBilling();
    const [ledger] = await db
      .select({
        events: count(),
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
      })
      .from(usageEvents);
    return {
      rateCards: cards,
      periods,
      statements,
      exports: exportRows,
      activeSeats: await countActiveSeats(db),
      backend: { name: backend.backend, capabilities: backend.capabilities() },
      ledger: { totalEvents: ledger?.events ?? 0, totalListPriceUsd: ledger?.costUsd ?? 0 },
      schedulerPresent: false,
      paymentProcessorIntegrated: false,
      reconciledRatingAvailable: false,
      disclaimer: BILLING_DISCLAIMER,
      note:
        "Billing is a READ-SIDE consumer of usage_events — no counter is incremented at dispatch time, " +
        "so nothing here can drift from the cost dashboard. No payment processor is integrated and the " +
        "only backend is 'noop' (export-only, no network), which is ADR-0051 §6's air-gapped default. " +
        "No in-process scheduler exists: drive POST /v1/billing/periods/:id/close from cron. " +
        "`rating_mode` is never 'reconciled' because no provider-invoice importer exists yet.",
    };
  });
}
