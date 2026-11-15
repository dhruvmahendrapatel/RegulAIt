/**
 * ADR-0313 (lane E2, G9) — PAID-TOOL AND AGENT-PAYMENT BUDGETS.
 *
 * Some MCP tools and APIs charge per call (x402's "402 Payment Required", Cloudflare's per-crawl and per-tool
 * monetization). A metered list price is only known to the budget after the call, so the pillar-5 gate (measured
 * spend, `preDispatchProjectGate`) lets every call in flight through before the cap is seen, and an agent loop can
 * spend real money past its budget. This adds a RESERVATION in front of the call:
 *
 *   price       `paid_call_prices`: an MCP tool, every tool of a server, or a connector becomes a paid call
 *   authorise   `reservePaidCall` reserves the price's `max_settle_usd` against the attributed project's effective
 *               budget and the orchestration run's cap, under each envelope's advisory lock, in one transaction:
 *               measured spend + open holds + this hold must fit. Over budget is a refusal (409), escalated into the
 *               ONE approvals queue (`__project_budget__` / `__budget__:paid_call`). No envelope at all is a refusal
 *               too (default-deny, ADR-0180): money does not leave without a budget it is counted against.
 *   settle      `settlePaidCall` with the call's usage row: the upstream-reported charge (an MCP result's
 *               `_meta["io.regulait/charge"].amountUsd`), never above the hold, else the quoted price
 *   release     `releasePaidCall` when the call failed; the `paid-call-hold-sweeper` job releases a hold left open
 *               past its TTL, which until then is still counted (the safe direction)
 *
 * Search first (ADR-0176): the x402 reference implementation (coinbase/x402) is Apache-2.0, but it is a payment rail:
 * it settles through a facilitator service on a blockchain, which an air-gapped deployment cannot reach, and RegulAIt
 * budgets and authorises calls rather than moving money. So the minimal pricing and reservation model is built in our
 * own ledger, and the settlement contract is the small `_meta` field above. No new dependency.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  and,
  approvals,
  auditLog,
  connectors,
  desc,
  eq,
  gt,
  mcpServers,
  mcpTools,
  orchestrationRuns,
  paidCallHolds,
  paidCallPrices,
  projects,
  sql,
  type Db,
  type PaidCallHoldRow,
  type PaidCallPriceRow,
} from "@regulait/db";
import {
  currentPeriodKey,
  effectiveProjectBudget,
  escalateProjectBudget,
  isMonthly,
  overageActive,
  periodStart,
  projectSpendUsd,
} from "./projects.js";
import { loadOrgSettings } from "./org-settings.js";
import { requireStepUp } from "./step-up.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { type ListSpec } from "./list-contract.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** the result `_meta` key an upstream reports its actual charge under */
export const PAID_CALL_CHARGE_META_KEY = "io.regulait/charge";

export const PAID_CALL_RULE_IDS = {
  reserved: "paid-call-reserved",
  noBudget: "paid-call-no-budget",
  overProjectBudget: "paid-call-over-project-budget",
  overRunBudget: "paid-call-over-run-budget",
  settled: "paid-call-settled",
  chargeCapped: "paid-call-charge-capped",
  released: "paid-call-released",
  priceCreated: "paid-call-price-created",
  priceDeleted: "paid-call-price-deleted",
} as const;

export const PAID_CALL_SWEEP_JOB_NAME = "paid-call-hold-sweeper";
export const PAID_CALL_RUN_APPROVAL_STAGE = "__budget__:paid_call";

const lockKey = (kind: "project" | "run", id: string) => `regulait:paid-call:${kind}:${id}`;

// ---------------------------------------------------------------------------
// price resolution
// ---------------------------------------------------------------------------

/** an MCP tool's price: the tool's own row first, then its server's (the O10 tool-first rule) */
export async function paidPriceForMcpTool(db: Db, serverId: string, toolId: string | null): Promise<PaidCallPriceRow | null> {
  if (toolId) {
    const [t] = await db.select().from(paidCallPrices).where(eq(paidCallPrices.mcpToolId, toolId));
    if (t) return t;
  }
  const [s] = await db.select().from(paidCallPrices).where(eq(paidCallPrices.mcpServerId, serverId));
  return s ?? null;
}

export async function paidPriceForConnector(db: Db, connectorId: string): Promise<PaidCallPriceRow | null> {
  const [c] = await db.select().from(paidCallPrices).where(eq(paidCallPrices.connectorId, connectorId));
  return c ?? null;
}

/** the run a call belongs to, from its causal context (`run:<id>`) or its detail (`runId`) */
export function runIdOfCall(args: { contextId?: string | null | undefined; detail?: Record<string, unknown> | undefined }): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fromContext = args.contextId?.startsWith("run:") ? args.contextId.slice(4) : null;
  if (fromContext && uuid.test(fromContext)) return fromContext;
  const d = args.detail?.["runId"];
  return typeof d === "string" && uuid.test(d) ? d : null;
}

// ---------------------------------------------------------------------------
// reserve / settle / release
// ---------------------------------------------------------------------------

export type PaidCallReservation =
  | { ok: true; holdId: string; heldUsd: number; price: PaidCallPriceRow }
  | { ok: false; status: number; error: string; detail: string };

export interface ReserveArgs {
  price: PaidCallPriceRow;
  userId: string;
  projectId: string | null;
  runId: string | null;
  subject: { kind: "mcp_tool"; serverId: string; toolName: string } | { kind: "connector"; connectorId: string };
}

async function openHoldsUsd(tx: Db, where: ReturnType<typeof eq>, since: Date | null): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`coalesce(sum(${paidCallHolds.heldUsd}), 0)::float8` })
    .from(paidCallHolds)
    .where(and(where, eq(paidCallHolds.state, "held"), gt(paidCallHolds.expiresAt, sql`now()`), since ? sql`${paidCallHolds.createdAt} >= ${since.toISOString()}::timestamptz` : undefined));
  return Number(r?.n ?? 0);
}

async function auditPaid(
  db: Db,
  userId: string | null,
  ruleId: string,
  effect: "allow" | "deny" | "require_approval",
  reason: string,
  detail: Record<string, unknown>,
  objectId: string | null = null,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: userId ?? NIL_UUID,
    objectType: "paid_call",
    objectId,
    detail: { subsystem: "paid-calls", adr: "0313", receiptClass: "decision", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/**
 * Reserve one paid call. Every envelope the call falls under must have room for `max_settle_usd`: the attributed
 * project's effective budget (at the org's hard-block percentage, the monthly window when the budget is monthly) and the
 * run's cap. A sanctioned overage (the approvals queue's decision) lifts its envelope, as it does for measured spend.
 * No envelope at all refuses. The checks and the insert are one transaction under the envelopes' advisory locks, taken
 * project first, then run, so concurrent reservations serialise and can never overshoot together.
 */
export async function reservePaidCall(db: Db, a: ReserveArgs): Promise<PaidCallReservation> {
  const hold = a.price.maxSettleUsd;
  const subjectDetail =
    a.subject.kind === "mcp_tool" ? { serverId: a.subject.serverId, toolName: a.subject.toolName } : { connectorId: a.subject.connectorId };
  return db.transaction(async (txRaw): Promise<PaidCallReservation> => {
    const tx = txRaw as unknown as Db;
    if (a.projectId) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey("project", a.projectId)}))`);
    if (a.runId) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey("run", a.runId)}))`);
    let envelopes = 0;

    if (a.projectId) {
      const [project] = await tx.select().from(projects).where(eq(projects.id, a.projectId));
      if (project) {
        const { effectiveBudgetUsd } = await effectiveProjectBudget(tx, project);
        const now = new Date();
        if (effectiveBudgetUsd != null) {
          envelopes++;
          if (!overageActive(project, currentPeriodKey(now))) {
            const monthly = isMonthly(project);
            const org = await loadOrgSettings(tx);
            const blockAtUsd = (effectiveBudgetUsd * org.budgetHardBlockPct) / 100;
            const spent = await projectSpendUsd(tx, project.id, { monthly, now });
            const held = await openHoldsUsd(tx, eq(paidCallHolds.projectId, project.id), monthly ? periodStart(now) : null);
            if (spent + held + hold > blockAtUsd) {
              await escalateProjectBudget(tx, project, a.userId, spent + held);
              const detail =
                `paid call needs $${hold.toFixed(6)}; measured $${spent.toFixed(6)} + held $${held.toFixed(6)} leaves ` +
                `$${Math.max(0, blockAtUsd - spent - held).toFixed(6)} of the $${blockAtUsd.toFixed(6)} limit; the overage is queued for the project's budget approver`;
              await auditPaid(tx, a.userId, PAID_CALL_RULE_IDS.overProjectBudget, "deny", `paid call refused: ${detail}`,
                { ...subjectDetail, projectId: project.id, heldUsd: hold, spentUsd: spent, openHoldsUsd: held, blockAtUsd });
              return { ok: false, status: 409, error: "paid_call_over_budget", detail };
            }
          }
        }
      }
    }

    if (a.runId) {
      const [run] = await tx.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, a.runId));
      const budget = (run?.budget ?? null) as { capUsd?: number | null; overageApproved?: boolean } | null;
      if (run && budget && typeof budget.capUsd === "number") {
        envelopes++;
        if (!budget.overageApproved) {
          const [m] = await tx.execute<{ n: number }>(
            sql`select coalesce(sum(cost_usd), 0)::float8 as n from usage_events where (detail->>'runId') = ${run.id}`,
          ).then((r) => r.rows);
          const spent = Number(m?.n ?? 0);
          const held = await openHoldsUsd(tx, eq(paidCallHolds.orchestrationRunId, run.id), null);
          if (spent + held + hold > budget.capUsd) {
            const approver = (run.graph as { escalationApproverUserId?: string } | null)?.escalationApproverUserId ?? null;
            const [pending] = await tx
              .select({ id: approvals.id })
              .from(approvals)
              .where(and(eq(approvals.runId, run.id), eq(approvals.stageId, PAID_CALL_RUN_APPROVAL_STAGE), eq(approvals.status, "pending")))
              .limit(1);
            if (!pending && approver) {
              await tx.insert(approvals).values({
                userId: run.initiatingUserId,
                objectType: "run",
                runId: run.id,
                stageId: PAID_CALL_RUN_APPROVAL_STAGE,
                approverUserId: approver,
              });
            }
            const detail =
              `paid call needs $${hold.toFixed(6)}; run measured $${spent.toFixed(6)} + held $${held.toFixed(6)} leaves ` +
              `$${Math.max(0, budget.capUsd - spent - held).toFixed(6)} of its $${budget.capUsd} cap` +
              (approver ? "; the overage is queued for the run's escalation approver" : "; the run names no escalation approver");
            await auditPaid(tx, a.userId, PAID_CALL_RULE_IDS.overRunBudget, approver ? "require_approval" : "deny",
              `paid call refused: ${detail}`, { ...subjectDetail, runId: run.id, heldUsd: hold, spentUsd: spent, openHoldsUsd: held, capUsd: budget.capUsd });
            return { ok: false, status: 409, error: "paid_call_over_run_budget", detail };
          }
        }
      }
    }

    if (envelopes === 0) {
      const detail =
        "a paid call must be attributed to a project with a budget or run inside an orchestration run with a cap; " +
        "attribute the call (X-RegulAIt-Project) to a budgeted project";
      await auditPaid(tx, a.userId, PAID_CALL_RULE_IDS.noBudget, "deny", `paid call refused: ${detail}`,
        { ...subjectDetail, projectId: a.projectId, runId: a.runId, heldUsd: hold });
      return { ok: false, status: 409, error: "paid_call_no_budget", detail };
    }

    const [row] = await tx
      .insert(paidCallHolds)
      .values({
        priceId: a.price.id,
        userId: a.userId,
        projectId: a.projectId,
        orchestrationRunId: a.runId,
        subjectKind: a.subject.kind,
        mcpServerId: a.subject.kind === "mcp_tool" ? a.subject.serverId : null,
        toolName: a.subject.kind === "mcp_tool" ? a.subject.toolName.slice(0, 256) : null,
        connectorId: a.subject.kind === "connector" ? a.subject.connectorId : null,
        heldUsd: hold,
        expiresAt: sql`now() + make_interval(secs => ${a.price.holdTtlSeconds})`,
      })
      .returning({ id: paidCallHolds.id });
    await auditPaid(tx, a.userId, PAID_CALL_RULE_IDS.reserved, "allow", `paid call reserved $${hold.toFixed(6)}`,
      { ...subjectDetail, projectId: a.projectId, runId: a.runId, heldUsd: hold, holdId: row!.id }, row!.id);
    return { ok: true, holdId: row!.id, heldUsd: hold, price: a.price };
  });
}

/** what a call settles at: the upstream-reported charge, never above the hold; else the quoted price */
export function settlementAmount(
  price: Pick<PaidCallPriceRow, "priceUsd">,
  heldUsd: number,
  reportedUsd: unknown,
  opts: { toolError?: boolean } = {},
): { amountUsd: number; reported: boolean; capped: boolean } {
  if (typeof reportedUsd === "number" && Number.isFinite(reportedUsd) && reportedUsd >= 0) {
    return reportedUsd > heldUsd ? { amountUsd: heldUsd, reported: true, capped: true } : { amountUsd: reportedUsd, reported: true, capped: false };
  }
  // a tool that answered with an error result and reported no charge did not do the paid work: it settles at zero
  if (opts.toolError) return { amountUsd: 0, reported: false, capped: false };
  return { amountUsd: Math.min(price.priceUsd, heldUsd), reported: false, capped: false };
}

/** the charge an MCP tool result reports under `_meta["io.regulait/charge"].amountUsd` (undefined when absent) */
export function reportedChargeOf(result: unknown): unknown {
  const meta = (result as { _meta?: Record<string, unknown> } | null)?._meta;
  const charge = meta?.[PAID_CALL_CHARGE_META_KEY] as { amountUsd?: unknown } | undefined;
  return charge?.amountUsd;
}

/** Settle a hold with the usage row that carries its spend. A hold already released (it expired mid-call) settles too. */
export async function settlePaidCall(
  db: Db,
  r: { holdId: string; userId: string; amountUsd: number; usageEventId: string | null; capped: boolean; reported: boolean },
): Promise<void> {
  await db
    .update(paidCallHolds)
    .set({ state: "settled", settledUsd: r.amountUsd, usageEventId: r.usageEventId, releaseReason: null, settledAt: sql`now()` })
    .where(and(eq(paidCallHolds.id, r.holdId), sql`${paidCallHolds.state} <> 'settled'`, sql`${paidCallHolds.heldUsd} >= ${r.amountUsd}`));
  await auditPaid(db, r.userId, r.capped ? PAID_CALL_RULE_IDS.chargeCapped : PAID_CALL_RULE_IDS.settled, "allow",
    r.capped ? `paid call settled at its hold $${r.amountUsd.toFixed(6)}: the upstream reported more than was authorised`
      : `paid call settled at $${r.amountUsd.toFixed(6)}${r.reported ? " (upstream-reported charge)" : " (quoted price)"}`,
    { holdId: r.holdId, settledUsd: r.amountUsd, usageEventId: r.usageEventId, reported: r.reported, capped: r.capped }, r.holdId);
}

export async function releasePaidCall(db: Db, holdId: string, userId: string | null, reason: "call_failed" | "not_executed"): Promise<void> {
  const res = await db
    .update(paidCallHolds)
    .set({ state: "released", releaseReason: reason })
    .where(and(eq(paidCallHolds.id, holdId), eq(paidCallHolds.state, "held")))
    .returning({ id: paidCallHolds.id });
  if (res.length) {
    await auditPaid(db, userId, PAID_CALL_RULE_IDS.released, "allow", `paid call hold released (${reason}); nothing billed`, { holdId, reason }, holdId);
  }
}

/** release every hold left open past its TTL (bounded per pass) */
export async function sweepExpiredPaidCallHolds(db: Db, limit = 1_000): Promise<number> {
  const res = await db.execute(sql`
    UPDATE paid_call_holds SET state = 'released', release_reason = 'expired'
     WHERE id IN (SELECT id FROM paid_call_holds WHERE state = 'held' AND expires_at <= now() ORDER BY expires_at LIMIT ${limit})
       AND state = 'held'`);
  const n = res.rowCount ?? 0;
  if (n > 0) await auditPaid(db, null, PAID_CALL_RULE_IDS.released, "allow", `${n} expired paid-call hold(s) released`, { reason: "expired", count: n });
  return n;
}

export function paidCallJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: PAID_CALL_SWEEP_JOB_NAME,
      description:
        "Release paid-call holds left open past their TTL (a call that never settled or released). Until released, an " +
        "open hold still counts against its budget. Never in a decision path; with no open holds it changes nothing.",
      adr: "ADR-0313",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const n = await sweepExpiredPaidCallHolds(ctx.db);
        return { itemsProcessed: n, detail: { released: n } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// admin routes
// ---------------------------------------------------------------------------

const createBody = z
  .object({
    mcpServerId: z.string().uuid().optional(),
    mcpToolId: z.string().uuid().optional(),
    connectorId: z.string().uuid().optional(),
    priceUsd: z.number().positive().max(10_000),
    maxSettleUsd: z.number().positive().max(10_000).optional(),
    holdTtlSeconds: z.number().int().min(60).max(86_400).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const PAID_CALL_HOLDS_LIST: ListSpec<PaidCallHoldRow> = {
  id: "paid-call-holds",
  sorts: {
    when: { expr: paidCallHolds.createdAt, keysetAt: paidCallHolds.createdAt },
    state: { expr: paidCallHolds.state },
    held: { expr: paidCallHolds.heldUsd },
  },
  columns: {
    when: { label: "Reserved", value: (r) => r.createdAt },
    state: { label: "State", value: (r) => r.state },
    held: { label: "Held (USD)", value: (r) => r.heldUsd },
    settled: { label: "Settled (USD)", value: (r) => r.settledUsd },
    tool: { label: "Tool", value: (r) => r.toolName },
    reason: { label: "Released because", value: (r) => r.releaseReason },
  },
  filters: ["state", "projectId"],
  defaultSort: { col: "when", dir: "desc" },
  idCol: paidCallHolds.id,
};
const holdFilters = z
  .object({ state: z.enum(["held", "settled", "released"]).optional(), projectId: z.string().uuid().optional() })
  .strict();

function refuse(reply: FastifyReply, status: number, error: string, detail: string) {
  return reply.status(status).send({ error, detail });
}

export function registerPaidCallRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/paid-call-prices", async () => {
    const rows = await db.select().from(paidCallPrices).orderBy(desc(paidCallPrices.createdAt)).limit(1_000);
    return {
      prices: rows,
      chargeMetaKey: PAID_CALL_CHARGE_META_KEY,
      note:
        "A paid call reserves maxSettleUsd against its project budget and run cap before the upstream is contacted, " +
        "and is refused (default-deny) when no budget covers it or the budget has no room.",
    };
  });

  // Adding a price makes calls STRICTER (they must then reserve), so it is not a step-up; it is audited.
  app.post("/v1/paid-call-prices", async (req, reply) => {
    const b = createBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_request", "send exactly one of {mcpServerId, mcpToolId, connectorId}, priceUsd > 0, maxSettleUsd >= priceUsd?, holdTtlSeconds 60-86400?, note?");
    const subjects = [b.data.mcpServerId, b.data.mcpToolId, b.data.connectorId].filter(Boolean);
    if (subjects.length !== 1) return refuse(reply, 400, "invalid_request", "name exactly one subject: mcpServerId, mcpToolId or connectorId");
    const maxSettleUsd = b.data.maxSettleUsd ?? b.data.priceUsd;
    if (maxSettleUsd < b.data.priceUsd) return refuse(reply, 400, "invalid_request", "maxSettleUsd must be at least priceUsd");
    const exists = b.data.mcpServerId
      ? (await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, b.data.mcpServerId))).length
      : b.data.mcpToolId
        ? (await db.select({ id: mcpTools.id }).from(mcpTools).where(eq(mcpTools.id, b.data.mcpToolId))).length
        : (await db.select({ id: connectors.id }).from(connectors).where(eq(connectors.id, b.data.connectorId!))).length;
    if (!exists) return refuse(reply, 404, "unknown_subject", "no such MCP server, MCP tool or connector");
    const [row] = await db
      .insert(paidCallPrices)
      .values({
        mcpServerId: b.data.mcpServerId ?? null,
        mcpToolId: b.data.mcpToolId ?? null,
        connectorId: b.data.connectorId ?? null,
        priceUsd: b.data.priceUsd,
        maxSettleUsd,
        holdTtlSeconds: b.data.holdTtlSeconds ?? 900,
        note: b.data.note ?? null,
        createdBy: req.authCtx.userId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return refuse(reply, 409, "price_exists", "this subject already has a paid-call price; delete it first");
    await auditPaid(db, req.authCtx.userId ?? null, PAID_CALL_RULE_IDS.priceCreated, "allow",
      `paid-call price set: $${row.priceUsd} per call, reserving $${row.maxSettleUsd}`,
      { priceId: row.id, mcpServerId: row.mcpServerId, mcpToolId: row.mcpToolId, connectorId: row.connectorId, priceUsd: row.priceUsd, maxSettleUsd: row.maxSettleUsd }, row.id);
    return reply.status(201).send({ price: row });
  });

  // Deleting a price RELAXES governance (the calls stop reserving), so it is a step-up, audited as a relaxation.
  app.delete("/v1/paid-call-prices/:priceId", async (req, reply) => {
    const p = z.object({ priceId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "priceId must be a uuid");
    const [row] = await db.select().from(paidCallPrices).where(eq(paidCallPrices.id, p.data.priceId));
    if (!row) return refuse(reply, 404, "unknown_price", "no such paid-call price");
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { paidCallPrice: "delete", priceId: row.id } });
    if (!su.ok) return reply;
    await db.delete(paidCallPrices).where(eq(paidCallPrices.id, row.id));
    await auditPaid(db, req.authCtx.userId ?? null, PAID_CALL_RULE_IDS.priceDeleted, "allow",
      "paid-call price deleted: calls to this subject no longer reserve against a budget (a relaxation)",
      { priceId: row.id, relaxation: true, stepUp: su.method }, row.id);
    return reply.status(204).send();
  });

  const holdsList: ContractList<PaidCallHoldRow, z.infer<typeof holdFilters>> = {
    spec: PAID_CALL_HOLDS_LIST,
    filters: holdFilters,
    reader: {
      fetch: (q) =>
        db
          .select({ ...paidCallHoldColumns, _cursorAt: q.cursorAt })
          .from(paidCallHolds)
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset),
      countable: (where) => db.select({ one: sql`1` }).from(paidCallHolds).where(where),
      idOf: (r) => r.id,
    },
    where: (_req, f) =>
      and(f.state ? eq(paidCallHolds.state, f.state) : undefined, f.projectId ? eq(paidCallHolds.projectId, f.projectId) : undefined),
  };
  app.get("/v1/paid-call-holds", async (req, reply) => answerListPage(db, req, reply, holdsList));
}

const paidCallHoldColumns = {
  id: paidCallHolds.id,
  priceId: paidCallHolds.priceId,
  userId: paidCallHolds.userId,
  projectId: paidCallHolds.projectId,
  orchestrationRunId: paidCallHolds.orchestrationRunId,
  subjectKind: paidCallHolds.subjectKind,
  mcpServerId: paidCallHolds.mcpServerId,
  toolName: paidCallHolds.toolName,
  connectorId: paidCallHolds.connectorId,
  heldUsd: paidCallHolds.heldUsd,
  state: paidCallHolds.state,
  settledUsd: paidCallHolds.settledUsd,
  usageEventId: paidCallHolds.usageEventId,
  releaseReason: paidCallHolds.releaseReason,
  createdAt: paidCallHolds.createdAt,
  expiresAt: paidCallHolds.expiresAt,
  settledAt: paidCallHolds.settledAt,
};

