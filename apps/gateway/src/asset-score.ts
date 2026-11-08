/**
 * ADR-0214 amendment (PENDING P3 follow-up) — ONE EXPLAINABLE SCORE PER ASSET.
 *
 * The org-wide estimate (posture-score.ts) answers "how are we doing"; this answers "how is THIS agent, THIS use
 * case doing, and what should its owner fix first". Same principles, same constants, same combiner:
 *
 *  1. AN ESTIMATE, NEVER A VERDICT. `estimate: true`, the ADR-0214 disclaimer, and no "compliant" anywhere.
 *  2. IT EXPLAINS ITSELF. Every objective carries the published ADR-0214 weight, its inputs and its formula in
 *     words; the asset's score is the weighted mean over the objectives that APPLY to its kind.
 *  3. DETERMINISTIC, NO AI. `scoreAsset` is a pure function of the asset's ledger slice.
 *  4. UNMEASURED SCORES ZERO. An objective that applies but has no data scores 0. An objective that cannot be
 *     measured per asset at all (pack coverage, audit anchoring, project spend) is NOT APPLICABLE: it is listed, with
 *     the reason, and is not in the divisor — so an asset is never punished, or flattered, by an org-wide fact.
 *  5. RANKED ACTIONS, EACH WITH A LINK, by the same counterfactual as the org list.
 *
 * Which assets: agents and use cases, the two kinds the ledgers attach outcomes to (risks name an agent or a use
 * case; red-team runs and evaluations name an agent; both carry an owner). Model cards, MCP servers and connectors
 * are not scored: no risk, red-team or evaluation row names them, so every objective would be unmeasured and the
 * figure would always be 0 (see the ADR-0214 amendment).
 *
 * Object-level authorisation (ADR-0200 checklist): a caller sees a score only for an asset they can already read —
 * an agent they steward (agent-stewardship.ts `mayActAsSteward`), a use case they own (the `GET /v1/use-cases` list
 * scope) or may read (`canReadUseCase`, detail only), or anything as an admin. The check runs on every request;
 * nothing is cached on the server, and the response is `private, no-store`, so no cache crosses a user or an
 * authorisation decision.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agents,
  aiRisks,
  aiUseCases,
  and,
  asc,
  count,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  gt,
  gte,
  inArray,
  or,
  redteamRuns,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  POSTURE_SCORE_DISCLAIMER,
  POSTURE_WEIGHTS,
  STALE_REDTEAM_FACTOR,
  combineObjectives,
  type ObjectiveDraft,
  type ObjectiveId,
  type PostureAction,
  type PostureObjective,
} from "./posture-score.js";
import { POSTURE_WINDOW_DAYS } from "./posture.js";
import { GROUNDEDNESS_SCORER_KINDS } from "./risks.js";
import { canReadUseCase } from "./use-cases.js";
import { databaseNow } from "./db-clock.js";
import { ownershipFlagFor, type OwnershipFlag } from "./inventory.js";

export const ASSET_KINDS = ["agent", "use_case"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** the ADR-0214 objectives each asset kind is scored on, in the published order */
export const ASSET_OBJECTIVES: Readonly<Record<AssetKind, readonly ObjectiveId[]>> = Object.freeze({
  agent: ["risk", "adversarial", "access", "evaluation"],
  use_case: ["risk", "access"],
});

const ALL_OBJECTIVES: Array<{ id: ObjectiveId; title: string }> = [
  { id: "coverage", title: "Control coverage" },
  { id: "risk", title: "Risk treatment" },
  { id: "adversarial", title: "Adversarial resilience" },
  { id: "access", title: "Access hygiene" },
  { id: "evaluation", title: "Answer quality" },
  { id: "audit", title: "Audit integrity" },
  { id: "spend", title: "Spend control" },
];

/** why an ADR-0214 objective is not part of an asset's score, stated on the payload */
const NOT_APPLICABLE_WHY: Readonly<Record<AssetKind, Partial<Record<ObjectiveId, string>>>> = {
  agent: {
    coverage: "compliance packs are evaluated for the organisation or a project, not for one agent",
    audit: "the audit trail is anchored once for the whole deployment",
    spend: "budgets are set on projects, not on agents",
  },
  use_case: {
    coverage: "compliance packs are evaluated for the organisation or a project, not for one use case",
    adversarial: "red-team runs probe agents; see the scores of the agents this use case names",
    evaluation: "evaluations run against agents; see the scores of the agents this use case names",
    audit: "the audit trail is anchored once for the whole deployment",
    spend: "budgets are set on projects, not on use cases",
  },
};

/** an asset list page holds at most this many rows */
export const ASSET_SCORE_MAX_LIMIT = 100;
export const ASSET_SCORE_DEFAULT_LIMIT = 25;

export interface AssetRiskCounts {
  open: number;
  total: number;
}

export interface AgentAssetInput {
  kind: "agent";
  id: string;
  name: string;
  risks: AssetRiskCounts;
  /** this agent's latest red-team run, and how many of its runs fall in the report window */
  redteam: { runsInWindow: number; latestAsrUpper: number | null; hasRun: boolean };
  /** this agent's groundedness evaluations in the report window, and the latest one's pass rate */
  groundedness: { runsInWindow: number; latestPassRate: number | null };
  ownership: OwnershipFlag;
}

export interface UseCaseAssetInput {
  kind: "use_case";
  id: string;
  name: string;
  risks: AssetRiskCounts;
  /** a use case always records its owner; "orphaned" when that account is deactivated */
  ownership: Exclude<OwnershipFlag, "unowned">;
}

export type AssetScoreInput = AgentAssetInput | UseCaseAssetInput;

export interface AssetScore {
  estimate: true;
  asset: { kind: AssetKind; id: string; name: string };
  score: number;
  scale: { min: 0; max: 100 };
  method: string;
  disclaimer: string;
  /** the published ADR-0214 weights of the objectives that apply, and each one's share of this asset's score */
  weights: Array<{ objective: ObjectiveId; title: string; weight: number; sharePct: number }>;
  notApplicable: Array<{ objective: ObjectiveId; title: string; why: string }>;
  objectives: PostureObjective[];
  actions: PostureAction[];
}

const pctText = (x: number) => `${Math.round(x)}%`;
const n = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
const round1 = (x: number) => Math.round(x * 10) / 10;
const KIND_NOUN: Record<AssetKind, string> = { agent: "agent", use_case: "use case" };

/** where each fix is made, per asset — the operator pages ADR-0214 links to, or the use case's own page */
function links(a: AssetScoreInput) {
  if (a.kind === "use_case") {
    const page = { to: `/admin/governance/use-cases/${a.id}`, label: "Open the use case" };
    return { risk: page, access: page };
  }
  return {
    risk: { to: "/admin/risks", label: "Open the risk register" },
    adversarial: { to: "/admin/redteam", label: "Open red-team runs" },
    access: { to: "/admin/inventory", label: "Open the agent inventory" },
    evaluation: { to: "/admin/evals", label: "Open evaluations" },
  };
}

function riskDraft(a: AssetScoreInput): ObjectiveDraft {
  const r = a.risks;
  const noun = KIND_NOUN[a.kind];
  const measured = r.total > 0;
  const raw = measured ? ((r.total - r.open) / r.total) * 100 : 0;
  return {
    objective: {
      id: "risk",
      title: "Risk treatment",
      outcome: `Every AI risk registered against this ${noun} has a treatment.`,
      metric: { label: "Registered risks with a treatment", value: measured ? pctText(raw) : "unmeasured" },
      measured,
      raw,
      inputs: [
        { label: `Risks naming this ${noun}`, value: String(r.total) },
        { label: "Open (untreated)", value: String(r.open) },
      ],
      formula: `Risks naming this ${noun} that are not open ÷ all risks naming it. None registered scores 0.`,
      link: links(a).risk,
    },
    fixes: !measured
      ? [{ key: "risk:register", title: `Register the AI risks this ${noun} carries`, fixedRaw: 100, why: `no risk names this ${noun}, so treatment is unmeasured` }]
      : r.open > 0
        ? [{ key: "risk:treat", title: `Decide a treatment for ${n(r.open, "open risk", "open risks")}`, fixedRaw: 100, why: `${n(r.open, "risk is", "risks are")} open without a treatment` }]
        : [],
  };
}

function adversarialDraft(a: AgentAssetInput): ObjectiveDraft {
  const rt = a.redteam;
  const upper = rt.latestAsrUpper;
  const measured = rt.hasRun && upper !== null;
  const fresh = rt.runsInWindow > 0;
  const base = measured ? (1 - upper) * 100 : 0;
  const raw = fresh ? base : base * STALE_REDTEAM_FACTOR;
  const fixes: ObjectiveDraft["fixes"] = [];
  if (!measured) {
    fixes.push({ key: "adversarial:probe", title: `Run a red-team probe against ${a.name}`, fixedRaw: 100, why: "no measured attack-success rate exists for this agent" });
  } else {
    if (!fresh) fixes.push({ key: "adversarial:rerun", title: "Re-run the red-team probe; the latest result is older than the report window", fixedRaw: base, why: "a stale result counts at half its value" });
    if (upper > 0)
      fixes.push({
        key: "adversarial:harden",
        title: `Lower the attack-success rate for ${a.name}`,
        fixedRaw: fresh ? 100 : 100 * STALE_REDTEAM_FACTOR,
        why: `attacks may succeed up to ${pctText(upper * 100)} of the time (upper bound of the 95% interval)`,
      });
  }
  return {
    objective: {
      id: "adversarial",
      title: "Adversarial resilience",
      outcome: "Probes show attacks on this agent rarely succeed, measured recently.",
      metric: { label: "Attacks resisted, worst case", value: measured ? pctText(base) : "unmeasured" },
      measured,
      raw,
      inputs: [
        { label: "Attack-success rate, upper bound of the 95% interval (latest run)", value: upper === null ? "unmeasured" : pctText(upper * 100) },
        { label: "Runs in the report window", value: String(rt.runsInWindow) },
      ],
      formula: "(1 − upper bound of this agent's latest attack-success rate) × 100, halved when none of its runs falls in the report window. Unmeasured scores 0.",
      link: { to: "/admin/redteam", label: "Open red-team runs" },
    },
    fixes,
  };
}

function evaluationDraft(a: AgentAssetInput): ObjectiveDraft {
  const g = a.groundedness;
  const rate = g.latestPassRate;
  const measured = g.runsInWindow > 0 && rate !== null;
  const raw = measured ? rate * 100 : 0;
  return {
    objective: {
      id: "evaluation",
      title: "Answer quality",
      outcome: "This agent's answers are grounded, measured by an evaluation run in the report window.",
      metric: { label: "Latest groundedness pass rate", value: measured ? pctText(raw) : "unmeasured" },
      measured,
      raw,
      inputs: [
        { label: "Groundedness runs in the window", value: String(g.runsInWindow) },
        { label: "Latest pass rate", value: rate === null ? "none" : pctText(rate * 100) },
      ],
      formula: "This agent's latest groundedness evaluation pass rate × 100. No run in the window scores 0.",
      link: { to: "/admin/evals", label: "Open evaluations" },
    },
    fixes: !measured
      ? [{ key: "evaluation:run", title: `Run a groundedness evaluation against ${a.name}`, fixedRaw: 100, why: "answer quality is unmeasured in the window" }]
      : raw < 100
        ? [{ key: "evaluation:improve", title: "Raise the groundedness pass rate", fixedRaw: 100, why: `the latest run passed ${pctText(raw)}` }]
        : [],
  };
}

function accessDraft(a: AssetScoreInput): ObjectiveDraft {
  const noun = KIND_NOUN[a.kind];
  const owned = a.ownership === "owned";
  const state = a.ownership === "owned" ? "active owner" : a.ownership === "orphaned" ? "owner deactivated" : "no owner";
  return {
    objective: {
      id: "access",
      title: "Access hygiene",
      outcome: `This ${noun} has an accountable owner whose account is active.`,
      metric: { label: "Owner", value: state },
      measured: true,
      raw: owned ? 100 : 0,
      inputs: [{ label: "Ownership", value: state }],
      formula: `100 when this ${noun}'s recorded owner is an active account; 0 when it has no owner or the owner is deactivated.`,
      link: links(a).access,
    },
    fixes: owned
      ? []
      : [{ key: "access:owner", title: `Assign an active owner to this ${noun}`, fixedRaw: 100, why: a.ownership === "orphaned" ? "its owner's account is deactivated" : "it has no owner" }],
  };
}

/** Score one asset from its ledger slice. Pure and deterministic: no clock, no randomness, no I/O. */
export function scoreAsset(a: AssetScoreInput): AssetScore {
  const ids = ASSET_OBJECTIVES[a.kind];
  const drafts = ids.map((id): ObjectiveDraft => {
    if (id === "risk") return riskDraft(a);
    if (id === "access") return accessDraft(a);
    if (a.kind !== "agent") throw new Error(`objective ${id} does not apply to a ${a.kind}`);
    return id === "adversarial" ? adversarialDraft(a) : evaluationDraft(a);
  });
  const { score, weightTotal, objectives, actions } = combineObjectives(drafts);
  const why = NOT_APPLICABLE_WHY[a.kind];
  return {
    estimate: true,
    asset: { kind: a.kind, id: a.id, name: a.name },
    score,
    scale: { min: 0, max: 100 },
    method:
      `The weighted mean of the ${ids.length} ADR-0214 objectives that apply to a ${KIND_NOUN[a.kind]}, using the published ` +
      `weights (they sum to ${weightTotal} here, so each objective's share is its weight ÷ ${weightTotal}). ` +
      "An objective with no data scores 0; one that cannot be measured per asset is listed as not applicable and is " +
      "left out of the divisor. Actions are ranked by how many points fixing each one would add.",
    disclaimer: POSTURE_SCORE_DISCLAIMER,
    weights: objectives.map((o) => ({ objective: o.id, title: o.title, weight: o.weight, sharePct: round1((o.weight * 100) / weightTotal) })),
    notApplicable: ALL_OBJECTIVES.filter((o) => !ids.includes(o.id)).map((o) => ({ objective: o.id, title: o.title, why: why[o.id]! })),
    objectives,
    actions,
  };
}

// The weights an asset kind uses are a subset of the published ADR-0214 constants; this pins that at load time.
for (const kind of ASSET_KINDS) for (const id of ASSET_OBJECTIVES[kind]) if (!(id in POSTURE_WEIGHTS)) throw new Error(`unknown objective ${id}`);

// ---------------------------------------------------------------------------
// The ledger slices, read in one batch per page (no N+1)
// ---------------------------------------------------------------------------

interface AssetRow {
  id: string;
  name: string;
  ownerUserId: string | null;
}

async function ownerDisabled(db: Db, rows: AssetRow[]): Promise<Set<string>> {
  const ids = [...new Set(rows.map((r) => r.ownerUserId).filter((x): x is string => !!x))];
  if (!ids.length) return new Set();
  const found = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(inArray(users.id, ids));
  const live = new Set(found.filter((u) => !u.disabledAt).map((u) => u.id));
  // an owner id with no user row is as unaccountable as a deactivated one
  return new Set(ids.filter((id) => !live.has(id)));
}

async function riskCounts(db: Db, column: typeof aiRisks.agentId | typeof aiRisks.useCaseId, ids: string[]) {
  const rows = ids.length
    ? await db
        .select({ assetId: column, open: sql<number>`count(*) filter (where ${aiRisks.status} = 'open')::int`, total: count() })
        .from(aiRisks)
        .where(inArray(column, ids))
        .groupBy(column)
    : [];
  return new Map(rows.map((r) => [r.assetId!, { open: r.open, total: r.total }]));
}

export async function agentInputs(db: Db, rows: AssetRow[], now: Date): Promise<AgentAssetInput[]> {
  const ids = rows.map((r) => r.id);
  const windowStart = new Date(now.getTime() - POSTURE_WINDOW_DAYS * 86_400_000);
  const [disabled, risks, latestRt, rtWindow, grounded] = await Promise.all([
    ownerDisabled(db, rows),
    riskCounts(db, aiRisks.agentId, ids),
    ids.length
      ? db
          .selectDistinctOn([redteamRuns.agentId], { agentId: redteamRuns.agentId, asrUpper: redteamRuns.asrUpper })
          .from(redteamRuns)
          .where(inArray(redteamRuns.agentId, ids))
          .orderBy(redteamRuns.agentId, desc(redteamRuns.startedAt), desc(redteamRuns.id))
      : Promise.resolve([]),
    ids.length
      ? db
          .select({ agentId: redteamRuns.agentId, n: count() })
          .from(redteamRuns)
          .where(and(inArray(redteamRuns.agentId, ids), gte(redteamRuns.startedAt, windowStart)))
          .groupBy(redteamRuns.agentId)
      : Promise.resolve([]),
    ids.length
      ? db
          .select({
            agentId: evalRuns.agentId,
            n: count(),
            latestPassRate: sql<number | null>`(array_agg(${evalRuns.passRate} order by ${evalRuns.startedAt} desc, ${evalRuns.id} desc))[1]`,
          })
          .from(evalRuns)
          .innerJoin(evalDatasets, and(eq(evalRuns.datasetId, evalDatasets.id), eq(evalRuns.datasetVersion, evalDatasets.version)))
          .where(
            and(
              inArray(evalRuns.agentId, ids),
              gte(evalRuns.startedAt, windowStart),
              inArray(evalDatasets.scorerKind, [...GROUNDEDNESS_SCORER_KINDS]),
            ),
          )
          .groupBy(evalRuns.agentId)
      : Promise.resolve([]),
  ]);
  const rt = new Map(latestRt.map((r) => [r.agentId!, r.asrUpper]));
  const rtN = new Map(rtWindow.map((r) => [r.agentId!, r.n]));
  const gr = new Map(grounded.map((r) => [r.agentId!, r]));
  return rows.map((r) => ({
    kind: "agent",
    id: r.id,
    name: r.name,
    risks: risks.get(r.id) ?? { open: 0, total: 0 },
    redteam: { hasRun: rt.has(r.id), latestAsrUpper: rt.get(r.id) ?? null, runsInWindow: rtN.get(r.id) ?? 0 },
    groundedness: { runsInWindow: gr.get(r.id)?.n ?? 0, latestPassRate: gr.get(r.id)?.latestPassRate ?? null },
    ownership: ownershipFlagFor(r.ownerUserId, !!r.ownerUserId && disabled.has(r.ownerUserId)),
  }));
}

export async function useCaseInputs(db: Db, rows: AssetRow[]): Promise<UseCaseAssetInput[]> {
  const [disabled, risks] = await Promise.all([ownerDisabled(db, rows), riskCounts(db, aiRisks.useCaseId, rows.map((r) => r.id))]);
  return rows.map((r) => ({
    kind: "use_case",
    id: r.id,
    name: r.name,
    risks: risks.get(r.id) ?? { open: 0, total: 0 },
    ownership: r.ownerUserId && !disabled.has(r.ownerUserId) ? "owned" : "orphaned",
  }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listQuery = z
  .object({
    kind: z.enum(ASSET_KINDS),
    limit: z.coerce.number().int().min(1).max(ASSET_SCORE_MAX_LIMIT).default(ASSET_SCORE_DEFAULT_LIMIT),
    cursor: z.string().max(512).optional(),
  })
  .strict();
const detailParams = z.object({ kind: z.enum(ASSET_KINDS), assetId: z.string().uuid() });
const cursorShape = z.object({ n: z.string().max(1024), i: z.string().uuid() }).strict();

export function encodeAssetCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ n: name, i: id }), "utf8").toString("base64url");
}

function decodeCursor(raw: string): { n: string; i: string } | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function privateNoStore(reply: FastifyReply) {
  // computed per caller from an authorisation check made on this request: never shared, never reused
  reply.header("cache-control", "private, no-store");
}

/** the caller's identity, or null for a credential that names no user and is not an admin (nothing to scope to) */
function caller(req: FastifyRequest): { isAdmin: boolean; userId: string | null } | null {
  const isAdmin = !!req.authCtx.isAdmin;
  const userId = req.authCtx.userId ?? null;
  if (!isAdmin && !userId) return null;
  return { isAdmin, userId };
}

export function registerAssetScoreRoutes(app: FastifyInstance, db: Db): void {
  /**
   * One page of per-asset scores of one kind, in name order (keyset on name, id). Bounded: at most
   * ASSET_SCORE_MAX_LIMIT rows, read with one query per ledger for the whole page. Only the assets the caller can
   * already read are listed — all for an admin, otherwise the agents they steward or the use cases they own.
   */
  app.get("/v1/reports/posture/assets", async (req, reply) => {
    privateNoStore(reply);
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues.map((i) => ({ path: i.path, message: i.message })) });
    const who = caller(req);
    if (!who) return reply.status(403).send({ error: "no_user_identity" });
    const { kind, limit } = q.data;
    const after = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor);
    if (q.data.cursor !== undefined && !after) return reply.status(400).send({ error: "invalid_cursor" });

    const t = kind === "agent" ? { id: agents.id, name: agents.name, owner: agents.ownerUserId, table: agents } : { id: aiUseCases.id, name: aiUseCases.name, owner: aiUseCases.ownerUserId, table: aiUseCases };
    const conds = [];
    if (!who.isAdmin) conds.push(eq(t.owner, who.userId!));
    if (after) conds.push(or(gt(t.name, after.n), and(eq(t.name, after.n), gt(t.id, after.i))));
    const rows = await db
      .select({ id: t.id, name: t.name, ownerUserId: t.owner })
      .from(t.table)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(t.name), asc(t.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const inputs: AssetScoreInput[] = kind === "agent" ? await agentInputs(db, page, await databaseNow(db)) : await useCaseInputs(db, page);
    const last = page[page.length - 1];
    return {
      kind,
      objectives: ASSET_OBJECTIVES[kind],
      items: inputs.map(scoreAsset),
      nextCursor: rows.length > limit && last ? encodeAssetCursor(last.name, last.id) : null,
      limit,
      disclaimer: POSTURE_SCORE_DISCLAIMER,
    };
  });

  /** One asset's score. A caller who cannot already read the asset gets the same 404 as for one that does not exist. */
  app.get("/v1/reports/posture/assets/:kind/:assetId", async (req, reply) => {
    privateNoStore(reply);
    const p = detailParams.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "not_found" });
    const who = caller(req);
    if (!who) return reply.status(403).send({ error: "no_user_identity" });
    const { kind, assetId } = p.data;
    if (kind === "agent") {
      const [row] = await db.select({ id: agents.id, name: agents.name, ownerUserId: agents.ownerUserId }).from(agents).where(eq(agents.id, assetId));
      if (!row || !(who.isAdmin || (who.userId && row.ownerUserId === who.userId))) return reply.status(404).send({ error: "not_found" });
      const [input] = await agentInputs(db, [row], await databaseNow(db));
      return scoreAsset(input!);
    }
    const [row] = await db
      .select({ id: aiUseCases.id, name: aiUseCases.name, ownerUserId: aiUseCases.ownerUserId, workflowInstanceId: aiUseCases.workflowInstanceId })
      .from(aiUseCases)
      .where(eq(aiUseCases.id, assetId));
    if (!row || !(await canReadUseCase(db, row, who))) return reply.status(404).send({ error: "not_found" });
    const [input] = await useCaseInputs(db, [row]);
    return scoreAsset(input!);
  });
}
