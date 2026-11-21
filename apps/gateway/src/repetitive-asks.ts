/**
 * ADR-0328 slice 2 — repetitive asks at the gateway: settings, scan, suggestions. Admin-only (default gate), read-only:
 * nothing here changes routing (the eval gate, shadow and switch are slices 3 and 4).
 *
 *  - OFF by default (ADR-0180): no settings row = off. Turning it on or relaxing a threshold needs a `settings_relax`
 *    step-up, and every change writes an audit row in the same transaction. Thresholds are bounded by the kernel's
 *    `REPETITIVE_ASK_FLOORS` here and by CHECKs in the database.
 *  - The scan reads captured previews (`trace_spans.input_preview`, ADR-0042 posture, never a withheld one) for at most
 *    `SCAN_MAX_AGENTS` agents (the costliest first) and `REPETITIVE_ASK_LIMITS.maxAsks` asks each, over the rule-step
 *    scan window. `findRepetitiveAsks` runs on a worker thread. Text never leaves the process and is never stored:
 *    each cluster keeps its fingerprint, counts, measured cost and up to `CLUSTER_SAMPLE` member span ids.
 *  - The suggestion is the cheaper agent the existing right-sized routing (`routeModel`) would pick for the cluster's
 *    representative ask, among enabled, priced agents no higher than the agent that answered. It is advisory: serving
 *    (slice 4) narrows each request's own entitlement-filtered candidates, so nothing here grants or widens access.
 *  - Nothing here is an authorisation decision, and nothing here calls a model.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  desc,
  eq,
  getTableColumns,
  isNull,
  repetitiveAskClusterSpans,
  repetitiveAskClusters,
  repetitiveAskSettings,
  REPETITIVE_ASK_CLUSTER_STATUSES,
  sql,
  traceSpans,
  type Db,
  type RepetitiveAskClusterRow,
  type RepetitiveAskSettingsRow,
} from "@regulait/db";
import {
  DEFAULT_REPETITIVE_ASK_OPTIONS,
  REPETITIVE_ASK_FLOORS,
  REPETITIVE_ASK_LIMITS,
  classifyComplexity,
  estimateTokens,
  routeModel,
  type AskCluster,
  type CandidateAgent,
} from "@regulait/optimizer-kernel";
import { findRepetitiveAsksOffThread } from "@regulait/optimizer-kernel/offload";
import { REPETITIVE_ASK_CLUSTER_MACHINE } from "@regulait/shared";
import type { ListSpec } from "./list-contract.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";
import { NOT_RULE_SERVED_SPAN } from "./rule-step-serve.js";
import { SCAN_WINDOW_DAYS } from "./rule-step-retention.js";
import { whereFrom } from "./state-transition.js";
import { requireStepUp } from "./step-up.js";

const SETTINGS_ID = "singleton";
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
export const SCAN_MAX_AGENTS = 10;
export const SCAN_SPACING_MINUTES = 10;
/** member span ids kept per cluster: the sample slice 3's eval dataset is built from */
export const CLUSTER_SAMPLE = 50;
const MONTH_DAYS = 30;

export const REPETITIVE_ASK_AUDIT_RULE_IDS = {
  settings: "repetitive_ask_settings_changed",
  scan: "repetitive_ask_scan",
  dismiss: "repetitive_ask_cluster_dismissed",
} as const;

type Thresholds = { maxHamming: number; minSimilarity: number; minClusterSize: number };
export type RepetitiveAskSettings = Thresholds & { enabled: boolean; lastScanAt: Date | null };
export const STRICT_REPETITIVE_ASK_SETTINGS: Readonly<Thresholds> = DEFAULT_REPETITIVE_ASK_OPTIONS;

const settingsBody = z
  .object({
    enabled: z.boolean().optional(),
    maxHamming: z.number().int().min(0).max(REPETITIVE_ASK_FLOORS.maxHamming).optional(),
    minSimilarity: z.number().min(REPETITIVE_ASK_FLOORS.minSimilarity).max(1).optional(),
    minClusterSize: z.number().int().min(REPETITIVE_ASK_FLOORS.minClusterSize).max(100_000).optional(),
  })
  .strict();
const listFilters = z.object({ status: z.enum(REPETITIVE_ASK_CLUSTER_STATUSES).optional(), agentId: z.string().uuid().optional() }).strict();
const idParam = z.object({ id: z.string().uuid() }).strict();

function pick(row: RepetitiveAskSettingsRow): RepetitiveAskSettings {
  return { enabled: row.enabled, maxHamming: row.maxHamming, minSimilarity: row.minSimilarity, minClusterSize: row.minClusterSize, lastScanAt: row.lastScanAt };
}

export async function loadRepetitiveAskSettings(db: Db): Promise<RepetitiveAskSettings> {
  const [row] = await db.select().from(repetitiveAskSettings).where(eq(repetitiveAskSettings.id, SETTINGS_ID));
  return row ? pick(row) : { enabled: false, ...STRICT_REPETITIVE_ASK_SETTINGS, lastScanAt: null };
}

/** what a change loosens: switching on, a wider Hamming bound, or a lower similarity or size floor */
export function relaxedRepetitiveAskSettings(body: z.infer<typeof settingsBody>, current: RepetitiveAskSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.enabled === true && !current.enabled) out.enabled = true;
  if (body.maxHamming !== undefined && body.maxHamming > current.maxHamming) out.maxHamming = body.maxHamming;
  if (body.minSimilarity !== undefined && body.minSimilarity < current.minSimilarity) out.minSimilarity = body.minSimilarity;
  if (body.minClusterSize !== undefined && body.minClusterSize < current.minClusterSize) out.minClusterSize = body.minClusterSize;
  return out;
}

type PricedAgent = CandidateAgent & { name: string };
const priceOf = (a: CandidateAgent, est: { in: number; out: number }) =>
  ((a.costPerMTokIn ?? 0) * est.in + (a.costPerMTokOut ?? 0) * est.out) / 1_000_000;

/**
 * The cheaper agent right-sized routing would pick for a cluster's representative ask, and the share of the cost it
 * would save; none when routing keeps the agent that answered. Pure over the agent list it is given.
 */
export function suggestCandidate(served: PricedAgent, pool: readonly PricedAgent[], representativeText: string): { agentId: string; savedShare: number } | null {
  const complexity = classifyComplexity(representativeText);
  const estimate = estimateTokens(representativeText, complexity);
  // routeModel itself never selects above the baseline's tier or an unpriced agent; the pool only drops the agent itself
  const candidates = [served, ...pool.filter((a) => a.id !== served.id)];
  const decision = routeModel({ requestedAgentId: served.id, candidates, routingMode: "automatic", complexity, estimate });
  if (decision.selectedAgentId === served.id) return null;
  const chosen = candidates.find((a) => a.id === decision.selectedAgentId);
  const before = priceOf(served, estimate);
  if (!chosen || before <= 0) return null;
  const savedShare = Math.max(0, Math.min(1, 1 - priceOf(chosen, estimate) / before));
  return savedShare > 0 ? { agentId: chosen.id, savedShare } : null;
}

type ClusterScan = { cluster: AskCluster; candidateAgentId: string | null; projectedMonthlySavingsUsd: number | null };
type AgentScan = { agentId: string; outcome: "scanned"; asks: number; clusters: ClusterScan[] } | { agentId: string; outcome: "failed"; reason: string };

async function scan(db: Db, settings: RepetitiveAskSettings): Promise<AgentScan[]> {
  const since = sql`now() - make_interval(days => ${SCAN_WINDOW_DAYS})`;
  const usable = and(
    eq(traceSpans.kind, "llm"),
    eq(traceSpans.status, "ok"),
    eq(traceSpans.contentWithheld, false),
    sql`${traceSpans.inputPreview} IS NOT NULL`,
    NOT_RULE_SERVED_SPAN,
    sql`${traceSpans.startedAt} >= ${since}`,
  );
  const busiest = await db
    .select({ agentId: traceSpans.agentId, asks: sql<number>`count(*)::int` })
    .from(traceSpans)
    .where(and(usable, sql`${traceSpans.agentId} IS NOT NULL`))
    .groupBy(traceSpans.agentId)
    .having(sql`count(*) >= ${settings.minClusterSize}`)
    .orderBy(sql`coalesce(sum(${traceSpans.costUsd}), 0) DESC`, traceSpans.agentId)
    .limit(SCAN_MAX_AGENTS);
  if (busiest.length === 0) return [];
  const pool: PricedAgent[] = (
    await db
      .select({ id: agents.id, name: agents.name, tier: agents.tier, costPerMTokIn: agents.costPerMTokIn, costPerMTokOut: agents.costPerMTokOut })
      .from(agents)
      .where(and(eq(agents.enabled, true), isNull(agents.haltedAt)))
  ).map((a) => ({ ...a }));

  const out: AgentScan[] = [];
  for (const { agentId } of busiest) {
    const rows = await db
      .select({ id: traceSpans.id, text: traceSpans.inputPreview, costUsd: traceSpans.costUsd })
      .from(traceSpans)
      .where(and(usable, eq(traceSpans.agentId, agentId!)))
      .orderBy(desc(traceSpans.startedAt), desc(traceSpans.id))
      .limit(REPETITIVE_ASK_LIMITS.maxAsks);
    const asks = rows.map((r) => ({ id: r.id, text: r.text ?? "", costUsd: r.costUsd }));
    let result: Awaited<ReturnType<typeof findRepetitiveAsksOffThread>>;
    try {
      result = await findRepetitiveAsksOffThread(asks, {
        maxHamming: settings.maxHamming,
        minSimilarity: settings.minSimilarity,
        minClusterSize: settings.minClusterSize,
      });
    } catch {
      // a failed or timed-out worker yields no clusters: reported in the scan's audit, never guessed
      out.push({ agentId: agentId!, outcome: "failed", reason: "detection_failed" });
      continue;
    }
    const served = pool.find((a) => a.id === agentId);
    const textOf = new Map(asks.map((a) => [a.id, a.text]));
    const clusters = result.clusters.map((cluster): ClusterScan => {
      const suggestion = served ? suggestCandidate(served, pool, textOf.get(cluster.representativeId) ?? "") : null;
      const projected =
        suggestion && cluster.totalCostUsd !== null
          ? Math.round(((cluster.totalCostUsd * MONTH_DAYS) / SCAN_WINDOW_DAYS) * suggestion.savedShare * 1e6) / 1e6
          : null;
      return { cluster, candidateAgentId: suggestion?.agentId ?? null, projectedMonthlySavingsUsd: projected };
    });
    out.push({ agentId: agentId!, outcome: "scanned", asks: result.considered, clusters });
  }
  return out;
}

function clusterView(r: RepetitiveAskClusterRow & { agentName: string | null; candidateName: string | null }) {
  return {
    id: r.id,
    agentId: r.agentId,
    agentName: r.agentName,
    fingerprint: r.fingerprint,
    status: r.status,
    /** read-only (ADR-0348): the cluster's own lifecycle */
    lifecycle: REPETITIVE_ASK_CLUSTER_MACHINE.describe(r.status),
    evidence: { asks: r.asks, cohesion: r.cohesion, windowCostUsd: r.windowCostUsd, windowDays: SCAN_WINDOW_DAYS },
    suggestion: r.candidateAgentId
      ? { candidateAgentId: r.candidateAgentId, candidateName: r.candidateName, projectedMonthlySavingsUsd: r.projectedMonthlySavingsUsd }
      : null,
    detectedAt: r.detectedAt,
    dismissedBy: r.dismissedBy,
    dismissedAt: r.dismissedAt,
  };
}
export type RepetitiveAskClusterView = ReturnType<typeof clusterView>;

const candidate = sql<string | null>`(select c.name from ${agents} c where c.id = ${repetitiveAskClusters.candidateAgentId})`;

/** ADR-0226: the cluster list under the shared list contract */
export const REPETITIVE_ASK_CLUSTERS_LIST: ListSpec<RepetitiveAskClusterView> = {
  id: "repetitive-ask-clusters",
  sorts: {
    savings: { expr: repetitiveAskClusters.projectedMonthlySavingsUsd },
    asks: { expr: repetitiveAskClusters.asks },
    agent: { expr: sql`lower(${agents.name})` },
    detected: { expr: repetitiveAskClusters.detectedAt, keysetAt: repetitiveAskClusters.detectedAt },
  },
  columns: {
    agent: { label: "Agent", value: (r) => r.agentName ?? r.agentId },
    asks: { label: "Asks", value: (r) => r.evidence.asks },
    cohesion: { label: "Cohesion", value: (r) => r.evidence.cohesion },
    candidate: { label: "Suggested agent", value: (r) => r.suggestion?.candidateName ?? null },
    savings: { label: "Projected monthly saving (USD, estimate)", value: (r) => r.suggestion?.projectedMonthlySavingsUsd ?? null },
    status: { label: "Status", value: (r) => r.status },
    detected: { label: "Detected", value: (r) => r.detectedAt },
  },
  filters: ["status", "agentId"],
  defaultSort: { col: "savings", dir: "desc" },
  idCol: repetitiveAskClusters.id,
};

async function settingsAudit(db: Db, userId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({
    userId: userId ?? NO_IDENTITY,
    objectType: "org_settings",
    objectId: null,
    detail: { scope: "repetitive_asks", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

export function registerRepetitiveAskRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/repetitive-asks/settings", async () => ({
    settings: await loadRepetitiveAskSettings(db),
    strict: STRICT_REPETITIVE_ASK_SETTINGS,
    floors: REPETITIVE_ASK_FLOORS,
  }));

  app.put("/v1/repetitive-asks/settings", async (req, reply) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues.slice(0, 20) });
    const body = parsed.data;
    const current = await loadRepetitiveAskSettings(db);
    const relaxed = relaxedRepetitiveAskSettings(body, current);
    if (
      Object.keys(relaxed).length > 0 &&
      !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { repetitiveAsks: "settings", values: relaxed } })).ok
    ) {
      return reply;
    }
    const next = {
      enabled: body.enabled ?? current.enabled,
      maxHamming: body.maxHamming ?? current.maxHamming,
      minSimilarity: body.minSimilarity ?? current.minSimilarity,
      minClusterSize: body.minClusterSize ?? current.minClusterSize,
    };
    const userId = req.authCtx.userId ?? null;
    const saved = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(repetitiveAskSettings)
        .values({ id: SETTINGS_ID, ...next, updatedBy: userId })
        .onConflictDoUpdate({ target: repetitiveAskSettings.id, set: { ...next, updatedBy: userId, updatedAt: sql`now()` } })
        .returning();
      const { lastScanAt: _ignored, ...from } = current;
      const loosened = Object.keys(relaxed);
      await settingsAudit(
        tx as unknown as Db,
        userId,
        REPETITIVE_ASK_AUDIT_RULE_IDS.settings,
        loosened.length > 0 ? "deny" : "allow",
        `repetitive-ask detection settings changed${loosened.length > 0 ? ` (relaxed: ${loosened.join(", ")})` : ""}`,
        { from, to: next, relaxed: loosened },
      );
      return row!;
    });
    return { settings: pick(saved) };
  });

  app.post("/v1/repetitive-asks/scan", async (req, reply) => {
    const userId = req.authCtx.userId ?? null;
    // claim the scan slot atomically by the database clock, so two concurrent scans cannot both run
    const [claimed] = await db
      .update(repetitiveAskSettings)
      .set({ lastScanAt: sql`now()` })
      .where(
        and(
          eq(repetitiveAskSettings.id, SETTINGS_ID),
          eq(repetitiveAskSettings.enabled, true),
          sql`(${repetitiveAskSettings.lastScanAt} IS NULL OR ${repetitiveAskSettings.lastScanAt} <= now() - make_interval(mins => ${SCAN_SPACING_MINUTES}))`,
        ),
      )
      .returning();
    if (!claimed) {
      const current = await loadRepetitiveAskSettings(db);
      if (!current.enabled) return reply.status(409).send({ error: "repetitive_asks_disabled", detail: "repetitive-ask detection is off" });
      return reply.status(429).send({ error: "repetitive_asks_scan_too_soon", detail: `scans are at least ${SCAN_SPACING_MINUTES} minutes apart` });
    }
    // reads and detection first (no transaction held open), then every write and the audit row together
    const results = await scan(db, pick(claimed));
    const summary = results.map((r) =>
      r.outcome === "scanned"
        ? { agentId: r.agentId, outcome: r.outcome, asks: r.asks, clusters: r.clusters.length, projectedMonthlySavingsUsd: r.clusters.reduce((s, c) => s + (c.projectedMonthlySavingsUsd ?? 0), 0) }
        : r,
    );
    await db.transaction(async (tx) => {
      for (const r of results) {
        if (r.outcome !== "scanned") continue;
        for (const c of r.clusters) {
          const values = {
            asks: c.cluster.size,
            cohesion: c.cluster.cohesion,
            windowCostUsd: c.cluster.totalCostUsd,
            candidateAgentId: c.candidateAgentId,
            projectedMonthlySavingsUsd: c.projectedMonthlySavingsUsd,
          };
          // a dismissed cluster stays dismissed: its evidence refreshes, its status does not
          const [row] = await tx
            .insert(repetitiveAskClusters)
            .values({ agentId: r.agentId, fingerprint: c.cluster.fingerprint, ...values })
            .onConflictDoUpdate({ target: [repetitiveAskClusters.agentId, repetitiveAskClusters.fingerprint], set: { ...values, detectedAt: sql`now()` } })
            .returning({ id: repetitiveAskClusters.id });
          // the sample is replaced, never merged, so it is always this scan's members
          await tx.delete(repetitiveAskClusterSpans).where(eq(repetitiveAskClusterSpans.clusterId, row!.id));
          const sample = c.cluster.memberIds.slice(0, CLUSTER_SAMPLE);
          if (sample.length > 0) await tx.insert(repetitiveAskClusterSpans).values(sample.map((spanId) => ({ clusterId: row!.id, spanId })));
        }
      }
      const found = summary.reduce((n, r) => n + ("clusters" in r ? r.clusters : 0), 0);
      await settingsAudit(tx as unknown as Db, userId, REPETITIVE_ASK_AUDIT_RULE_IDS.scan, "allow", `repetitive-ask scan: ${results.length} agents scanned, ${found} clusters`, {
        agentsScanned: results.length,
        clusters: found,
        agents: summary,
      });
    });
    return { agentsScanned: results.length, agents: summary };
  });

  const list: ContractList<RepetitiveAskClusterView, z.infer<typeof listFilters>> = {
    spec: REPETITIVE_ASK_CLUSTERS_LIST,
    filters: listFilters,
    reader: {
      fetch: async (q) => {
        const rows = await db
          .select({ ...getTableColumns(repetitiveAskClusters), agentName: agents.name, candidateName: candidate, _cursorAt: q.cursorAt })
          .from(repetitiveAskClusters)
          .leftJoin(agents, eq(agents.id, repetitiveAskClusters.agentId))
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset);
        return rows.map(({ _cursorAt, ...r }) => ({ ...clusterView(r), _cursorAt }));
      },
      countable: (where) => db.select({ one: sql`1` }).from(repetitiveAskClusters).leftJoin(agents, eq(agents.id, repetitiveAskClusters.agentId)).where(where),
      idOf: (r) => r.id,
    },
    where: (_req, f) =>
      and(eq(repetitiveAskClusters.status, f.status ?? "suggested"), f.agentId ? eq(repetitiveAskClusters.agentId, f.agentId) : undefined),
  };
  app.get("/v1/repetitive-asks/clusters", async (req, reply) => answerListPage(db, req, reply, list));

  app.post("/v1/repetitive-asks/clusters/:id/dismiss", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.authCtx.userId ?? null;
    const out = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(repetitiveAskClusters)
        .set({ status: REPETITIVE_ASK_CLUSTER_MACHINE.def.transitions.dismiss.to, dismissedBy: userId, dismissedAt: sql`now()` })
        .where(and(eq(repetitiveAskClusters.id, id), whereFrom(repetitiveAskClusters.status, REPETITIVE_ASK_CLUSTER_MACHINE, "dismiss")))
        .returning();
      if (!row) return null;
      await settingsAudit(tx as unknown as Db, userId, REPETITIVE_ASK_AUDIT_RULE_IDS.dismiss, "allow", "repetitive-ask cluster dismissed", {
        clusterId: id,
        agentId: row.agentId,
        fingerprint: row.fingerprint,
      });
      return row;
    });
    if (!out) {
      const [exists] = await db.select({ status: repetitiveAskClusters.status }).from(repetitiveAskClusters).where(eq(repetitiveAskClusters.id, id));
      return exists
        ? reply.status(409).send({ error: "not_suggested", detail: "only a suggested cluster can be dismissed", lifecycle: REPETITIVE_ASK_CLUSTER_MACHINE.describe(exists.status) })
        : reply.status(404).send({ error: "unknown_cluster" });
    }
    return { id: out.id, status: out.status };
  });
}
