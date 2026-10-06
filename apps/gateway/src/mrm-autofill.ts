/**
 * ADR-0086 — MODEL-CARD AUTOFILL FROM THE LEDGERS (gap L12,
 * docs/product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md).
 *
 * watsonx factsheets auto-collect lifecycle metadata into the card. Our
 * version is the ADR-0082 idiom instead: the card's evidence-shaped sections
 * are COMPUTED BY SELECT AT READ TIME over ledgers this deployment already
 * writes — eval runs, red-team runs, guardrail configs, usage, grants, drift
 * baselines, and the linked governance objects. The card stops being a form
 * someone keeps current and becomes a WINDOW over the ledgers that a human
 * signs.
 *
 * THE RULES THIS FILE EXISTS TO KEEP, all inherited and none new:
 *
 *  1. COMPUTED AND MANUALLY-ATTACHED EVIDENCE NEVER BLEND (ADR-0081/0082's
 *     two-block discipline). This module produces the `autofill` block ONLY;
 *     the `evidence` array on the card remains what a human attached, listed
 *     apart, and nothing here is summed into it.
 *  2. NOTHING HERE WRITES. No card row, no audit row, no cache — a read is a
 *     read. The one honest write is the SNAPSHOT at sign-off decision time
 *     (see `summarizeAutofillForSnapshot` + mrm.ts), which freezes what the
 *     decider saw into the decision's own audit detail — the ADR-0081
 *     acceptance-freeze pattern, living in `audit_log.detail`, not in a
 *     queryable card column. No migration.
 *  3. AN EMPTY LEDGER IS "UNMEASURED", NEVER ZERO-IMPLIES-GOOD. No red-team
 *     history reads "unmeasured, not resisted" (ADR-0081's phrasing), never
 *     ASR 0. Same for evals, drift, and usage.
 *  4. NO FAIRNESS NUMBER IS SYNTHESIZED. ADR-0045 §2's position stands:
 *     bias/fairness on a card is a DECLARED slot, and no query below computes
 *     or approximates one — the four-vendor doc's L9 stays open, on purpose.
 */
import {
  agentGrants,
  agentRevocations,
  agents,
  aiRisks,
  aiUseCases,
  aiVendors,
  and,
  auditLog,
  configActivationEvents,
  count,
  governanceReviewPolicy,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  gt,
  gte,
  guardrailConfigs,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  redteamRuns,
  roleAgentGrants,
  roleAssignments,
  roles,
  sql,
  usageEvents,
  users,
  type Db,
  type ModelCardApprovalRow,
  type ModelCardRow,
  type SQL,
} from "@regulait/db";
import {
  GUARDRAIL_MODES,
  evaluateEvalGate,
  modeAtLeast,
  type EvalAggregate,
  type GuardrailMode,
} from "@regulait/shared";
import { GROUNDEDNESS_SCORER_KINDS } from "./risks.js";
import { INVENTORY_WINDOW_DAYS } from "./inventory.js";

/** the ADR-0081/0082 evidence window, reused so "recent" means the same thing
 * on a model card as it does on the inventory and the risk register */
export const MRM_AUTOFILL_WINDOW_DAYS = INVENTORY_WINDOW_DAYS;

export const MRM_AUTOFILL_NOTE =
  "computed from ledgers at read time — nothing in this block is stored on the card, nothing an " +
  "author typed can change these numbers, and reading them writes nothing. Manually attached " +
  "evidence is listed separately and never blended in. A quiet ledger is absence of " +
  "measurement, not evidence of quality. Bias/fairness is deliberately NOT here: it remains a " +
  "declared slot (ADR-0045) and no fairness number is synthesized from any ledger.";

export const MRM_AUTOFILL_UNMEASURED_REDTEAM =
  "unmeasured, not resisted — no red-team run has ever probed this card's subject";

type CardSubject = Pick<ModelCardRow, "id" | "agentId" | "customProviderId">;

/** the agents whose ledgers this card's subject answers for: the card's own
 * agent, or — for an endpoint-level card — every registered agent backed by
 * that custom provider (the same "one risk position reached two ways" reading
 * mrmDispatchGate applies in reverse) */
async function resolveSubjectAgents(
  db: Db,
  card: CardSubject,
): Promise<Array<{ id: string; provider: string; customProviderId: string | null }>> {
  if (card.agentId) {
    return db
      .select({ id: agents.id, provider: agents.provider, customProviderId: agents.customProviderId })
      .from(agents)
      .where(eq(agents.id, card.agentId));
  }
  if (card.customProviderId) {
    return db
      .select({ id: agents.id, provider: agents.provider, customProviderId: agents.customProviderId })
      .from(agents)
      .where(eq(agents.customProviderId, card.customProviderId));
  }
  return [];
}

/** eval-run scoping: an agent card matches runs against that agent; an
 * endpoint card matches runs recorded against the provider OR any backing
 * agent (eval_runs carries both columns) */
function evalScope(card: CardSubject, agentIds: string[]): SQL | undefined {
  if (card.agentId) return eq(evalRuns.agentId, card.agentId);
  const parts: SQL[] = [eq(evalRuns.customProviderId, card.customProviderId!)];
  if (agentIds.length > 0) parts.push(inArray(evalRuns.agentId, agentIds) as SQL);
  return or(...parts);
}

/**
 * Runs one section's independent reads. Every entry is a LAZY drizzle query (it
 * executes only when awaited) or an already-settled `Promise.resolve`, so
 * nothing starts before this helper drives it. On the pooled `Db` the reads run
 * concurrently — each checks out its own client. On a transaction handle they
 * run one at a time: a transaction is ONE pg client, and calling
 * `client.query()` while that client is already executing a query is
 * deprecated in pg 8 (it prints a DeprecationWarning and queues) and removed in
 * pg 9.
 */
async function readAll<T extends readonly unknown[] | []>(
  reads: T,
  sequential: boolean,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  if (!sequential) return Promise.all(reads);
  const out: unknown[] = [];
  for (const read of reads) out.push(await read);
  return out as { -readonly [K in keyof T]: Awaited<T[K]> };
}

/** pass `inTransaction: true` when `db` is a transaction handle, so the reads
 * run sequentially on its single client (see `readAll`) */
export interface LedgerReadOptions {
  inTransaction?: boolean;
}

export interface CardAutofill {
  computedAt: string;
  window: { start: string; end: string; days: number };
  scope: {
    agentId: string | null;
    customProviderId: string | null;
    /** for an endpoint card: the registered agents whose ledgers are in scope */
    backingAgentIds: string[];
  };
  note: string;
  sections: {
    evals: Record<string, unknown>;
    redteam: Record<string, unknown>;
    guardrails: Record<string, unknown>;
    usage: Record<string, unknown>;
    grants: Record<string, unknown>;
    drift: Record<string, unknown>;
    links: Record<string, unknown>;
  };
}

/**
 * The whole autofill block, every number a SELECT at request time, scoped to
 * the card's subject. Exported (and taking `now`) so the suite can pin the
 * arithmetic, and so the sign-off decide path can freeze the same computation
 * it shows.
 */
export async function computeCardAutofill(
  db: Db,
  card: CardSubject,
  now: Date = new Date(),
  opts: LedgerReadOptions = {},
): Promise<CardAutofill> {
  const sequential = opts.inTransaction === true;
  const windowStart = new Date(now.getTime() - MRM_AUTOFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const subjects = await resolveSubjectAgents(db, card);
  const agentIds = subjects.map((a) => a.id);
  const evalWhere = evalScope(card, agentIds);

  // --- evals + groundedness (ADR-0044 / ADR-0067) --------------------------
  const groundedJoin = and(
    eq(evalRuns.datasetId, evalDatasets.id),
    eq(evalRuns.datasetVersion, evalDatasets.version),
  );
  const [evalsEver, evalsInWindow, latestEval, groundedInWindow, latestGrounded] = await readAll([
    db.select({ n: count() }).from(evalRuns).where(evalWhere),
    db.select({ n: count() }).from(evalRuns).where(and(evalWhere, gte(evalRuns.startedAt, windowStart))),
    db
      .select({
        id: evalRuns.id,
        status: evalRuns.status,
        passRate: evalRuns.passRate,
        meanScore: evalRuns.meanScore,
        cases: evalRuns.cases,
        trigger: evalRuns.trigger,
        startedAt: evalRuns.startedAt,
      })
      .from(evalRuns)
      .where(evalWhere)
      .orderBy(desc(evalRuns.startedAt))
      .limit(1),
    db
      .select({ n: count() })
      .from(evalRuns)
      .innerJoin(evalDatasets, groundedJoin)
      .where(
        and(
          evalWhere,
          gte(evalRuns.startedAt, windowStart),
          inArray(evalDatasets.scorerKind, [...GROUNDEDNESS_SCORER_KINDS]),
        ),
      ),
    db
      .select({
        id: evalRuns.id,
        scorerKind: evalDatasets.scorerKind,
        passRate: evalRuns.passRate,
        meanScore: evalRuns.meanScore,
        cases: evalRuns.cases,
        startedAt: evalRuns.startedAt,
      })
      .from(evalRuns)
      .innerJoin(evalDatasets, groundedJoin)
      .where(and(evalWhere, inArray(evalDatasets.scorerKind, [...GROUNDEDNESS_SCORER_KINDS])))
      .orderBy(desc(evalRuns.startedAt))
      .limit(1),
  ], sequential);
  const evals = {
    runsEver: evalsEver[0]?.n ?? 0,
    runsInWindow: evalsInWindow[0]?.n ?? 0,
    latestRun: latestEval[0] ?? null,
    groundedness: {
      runsInWindow: groundedInWindow[0]?.n ?? 0,
      latestRun: latestGrounded[0] ?? null,
      note:
        latestGrounded[0] == null
          ? "unmeasured — no ADR-0067 groundedness eval has scored this card's subject; hallucination risk is unmeasured here, not absent"
          : undefined,
    },
    note:
      (evalsEver[0]?.n ?? 0) === 0
        ? "unmeasured — no eval run has ever scored this card's subject"
        : undefined,
  };

  // --- red-team posture (ADR-0068), verbatim or unmeasured outright --------
  // red-team runs attach to AGENTS; an endpoint card is covered through its
  // backing agents, and an endpoint no agent uses has nothing to scope here.
  const redteamWhere = agentIds.length > 0 ? inArray(redteamRuns.agentId, agentIds) : null;
  const [rtEver, rtInWindow, latestRt] = redteamWhere
    ? await readAll([
        db.select({ n: count() }).from(redteamRuns).where(redteamWhere),
        db
          .select({ n: count() })
          .from(redteamRuns)
          .where(and(redteamWhere, gte(redteamRuns.startedAt, windowStart))),
        db
          .select({
            id: redteamRuns.id,
            asr: redteamRuns.asr,
            asrLower: redteamRuns.asrLower,
            asrUpper: redteamRuns.asrUpper,
            asrTrials: redteamRuns.asrTrials,
            measurementQuality: redteamRuns.measurementQuality,
            platformHeld: redteamRuns.platformHeld,
            startedAt: redteamRuns.startedAt,
          })
          .from(redteamRuns)
          .where(redteamWhere)
          .orderBy(desc(redteamRuns.startedAt))
          .limit(1),
      ], sequential)
    : [[{ n: 0 }], [{ n: 0 }], []];
  const redteam = latestRt[0]
    ? {
        measured: true as const,
        runsEver: rtEver[0]?.n ?? 0,
        runsInWindow: rtInWindow[0]?.n ?? 0,
        latestRun: latestRt[0],
        note:
          "attack-success rate verbatim from the latest run (ADR-0068): the rate never travels " +
          "without its Wilson interval, trial denominator and measurement-quality label",
      }
    : {
        measured: false as const,
        runsEver: 0,
        runsInWindow: 0,
        latestRun: null,
        note: MRM_AUTOFILL_UNMEASURED_REDTEAM,
      };

  // --- guardrail configs in force (ADR-0042) — configuration, not proof ----
  const [orgConfig, agentOverrides] = await readAll([
    // ADR-0107 (F01): the ORG-DEFAULT row is the one with a NULL `scope_id`,
    // and `guardrail_configs_org_uq` is UNIQUE on (scope) only WHERE
    // `scope_id IS NULL`. Asking for scope='org' alone was outside that index,
    // so an org-scoped row that carried a `scope_id` could be returned as the
    // org default. The predicate is tightened to match `loadOrgGuardrailConfig`
    // — the canonical loader in guardrails.ts — which makes this provably a
    // single-row read rather than an ordered guess at one.
    db
      .select()
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.scope, "org"), isNull(guardrailConfigs.scopeId)))
      .limit(1),
    agentIds.length
      ? db
          .select()
          .from(guardrailConfigs)
          .where(and(eq(guardrailConfigs.scope, "agent"), inArray(guardrailConfigs.scopeId, agentIds)))
      : Promise.resolve([]),
  ], sequential);
  const modes = (row: (typeof orgConfig)[number]) => ({
    promptInjection: row.promptInjectionMode,
    jailbreak: row.jailbreakMode,
    toxicity: row.toxicityMode,
    semanticDlp: row.semanticDlpMode,
  });
  const guardrails = {
    orgDefault: orgConfig[0] ? { modes: modes(orgConfig[0]), updatedAt: orgConfig[0].updatedAt } : null,
    agentOverrides: agentOverrides.map((row) => ({
      agentId: row.scopeId,
      modes: modes(row),
      updatedAt: row.updatedAt,
    })),
    note:
      "configuration evidence (ADR-0042): the modes currently in force for this card's subject — " +
      "a quiet period is not proof a runtime control fired",
  };

  // --- usage / spend (the ONE pillar-5 ledger) -----------------------------
  const usageWhere = agentIds.length > 0 ? inArray(usageEvents.agentId, agentIds) : null;
  const [usageAgg, usageLast] = usageWhere
    ? await readAll([
        db
          .select({ n: count(), costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
          .from(usageEvents)
          .where(and(usageWhere, gte(usageEvents.at, windowStart))),
        db
          .select({ lastAt: sql<string>`max(${usageEvents.at})` })
          .from(usageEvents)
          .where(usageWhere),
      ], sequential)
    : [[{ n: 0, costUsd: 0 }], [{ lastAt: null }]];
  const usage = {
    dispatchesInWindow: usageAgg[0]?.n ?? 0,
    costUsdInWindow: usageAgg[0]?.costUsd ?? 0,
    lastDispatchAt: usageLast[0]?.lastAt ?? null,
    note:
      (usageAgg[0]?.n ?? 0) === 0
        ? "none recorded — no metered dispatch of this card's subject in the window"
        : undefined,
  };

  // --- active grants: direct ∪ role-derived, minus revocations -------------
  const [direct, roleGrants, assignments, revoked, roleRows] = agentIds.length
    ? await readAll([
        db
          .select({ userId: agentGrants.userId, agentId: agentGrants.agentId })
          .from(agentGrants)
          .where(inArray(agentGrants.agentId, agentIds)),
        db
          .select({ roleId: roleAgentGrants.roleId, agentId: roleAgentGrants.agentId })
          .from(roleAgentGrants)
          .where(inArray(roleAgentGrants.agentId, agentIds)),
        db.select({ roleId: roleAssignments.roleId, userId: roleAssignments.userId }).from(roleAssignments),
        db
          .select({ userId: agentRevocations.userId, agentId: agentRevocations.agentId })
          .from(agentRevocations)
          .where(inArray(agentRevocations.agentId, agentIds)),
        db.select({ id: roles.id, name: roles.name }).from(roles),
      ], sequential)
    : [[], [], [], [], []];
  const roleUserIds = new Map<string, string[]>();
  for (const a of assignments) {
    roleUserIds.set(a.roleId, [...(roleUserIds.get(a.roleId) ?? []), a.userId]);
  }
  const holderSet = new Set(direct.map((g) => g.userId));
  const grantingRoleIds = new Set(roleGrants.map((g) => g.roleId));
  for (const rid of grantingRoleIds) for (const u of roleUserIds.get(rid) ?? []) holderSet.add(u);
  for (const r of revoked) holderSet.delete(r.userId);
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  const grants = {
    effectiveHolders: holderSet.size,
    directUsers: new Set(direct.map((g) => g.userId)).size,
    grantingRoles: [...grantingRoleIds].map((rid) => roleName.get(rid) ?? rid).sort(),
    revokedUsers: new Set(revoked.map((r) => r.userId)).size,
    note:
      "an inventory of grant rows (who MAY invoke this card's subject) — not a policy " +
      "simulation; the per-call kernel stays the only authority on any individual call",
  };

  // --- drift standing (ADR-0044 §5, driven by ADR-0064) --------------------
  // the drift "ledger" is eval_runs itself: pinned baselines plus the
  // scheduled re-measurements the sweep hands to the one runner.
  const [baselines, latestScheduled, regressionsInWindow] = await readAll([
    db
      .select({ n: count() })
      .from(evalRuns)
      .where(and(evalWhere, eq(evalRuns.isBaseline, true), eq(evalRuns.status, "completed"))),
    db
      .select({
        id: evalRuns.id,
        regression: evalRuns.regression,
        scoreDelta: evalRuns.scoreDelta,
        gatePassed: evalRuns.gatePassed,
        startedAt: evalRuns.startedAt,
      })
      .from(evalRuns)
      .where(and(evalWhere, eq(evalRuns.trigger, "scheduled")))
      .orderBy(desc(evalRuns.startedAt))
      .limit(1),
    db
      .select({ n: count() })
      .from(evalRuns)
      .where(
        and(
          evalWhere,
          eq(evalRuns.trigger, "scheduled"),
          eq(evalRuns.regression, true),
          gte(evalRuns.startedAt, windowStart),
        ),
      ),
  ], sequential);
  const drift = {
    baselinesPinned: baselines[0]?.n ?? 0,
    latestScheduledRun: latestScheduled[0] ?? null,
    regressionsInWindow: regressionsInWindow[0]?.n ?? 0,
    note:
      (baselines[0]?.n ?? 0) === 0
        ? "no baseline pinned — the ADR-0044 drift sweep has nothing to compare for this card's subject; drift is unmeasured here, not stable"
        : undefined,
  };

  // --- linked governance objects, where the references allow ---------------
  const providerNames = new Set(subjects.map((a) => a.provider));
  const linkedProviderIds = new Set(
    [card.customProviderId, ...subjects.map((a) => a.customProviderId)].filter(
      (x): x is string => !!x,
    ),
  );
  const [useCaseRows, riskRows, vendorRows] = await readAll([
    agentIds.length
      ? db
          .select({ id: aiUseCases.id, name: aiUseCases.name, status: aiUseCases.status, intendedAgentIds: aiUseCases.intendedAgentIds })
          .from(aiUseCases)
      : Promise.resolve([]),
    agentIds.length
      ? db
          .select({ id: aiRisks.id, title: aiRisks.title, status: aiRisks.status, category: aiRisks.category })
          .from(aiRisks)
          .where(inArray(aiRisks.agentId, agentIds))
      : Promise.resolve([]),
    db
      .select({
        id: aiVendors.id,
        name: aiVendors.name,
        status: aiVendors.status,
        category: aiVendors.category,
        linkedAgentProviders: aiVendors.linkedAgentProviders,
        linkedCustomProviderIds: aiVendors.linkedCustomProviderIds,
      })
      .from(aiVendors),
  ], sequential);
  const links = {
    useCases: useCaseRows
      .filter((u) => (u.intendedAgentIds ?? []).some((id) => agentIds.includes(id)))
      .map((u) => ({ id: u.id, name: u.name, status: u.status })),
    risks: riskRows,
    vendors: vendorRows
      .filter(
        (v) =>
          (v.linkedAgentProviders ?? []).some((p) => providerNames.has(p)) ||
          (v.linkedCustomProviderIds ?? []).some((id) => linkedProviderIds.has(id)),
      )
      .map((v) => ({ id: v.id, name: v.name, status: v.status, category: v.category })),
    note:
      "governance objects whose own references name this card's subject (ADR-0080/0081/0084) — " +
      "links, never copies",
  };

  return {
    computedAt: now.toISOString(),
    window: { start: windowStart.toISOString(), end: now.toISOString(), days: MRM_AUTOFILL_WINDOW_DAYS },
    scope: {
      agentId: card.agentId ?? null,
      customProviderId: card.customProviderId ?? null,
      backingAgentIds: card.agentId ? [] : agentIds,
    },
    note: MRM_AUTOFILL_NOTE,
    sections: { evals, redteam, guardrails, usage, grants, drift, links },
  };
}

// ---------------------------------------------------------------------------
// The sign-off snapshot — the ONE honest write, into the decision's audit row
// ---------------------------------------------------------------------------

export const MRM_SNAPSHOT_NOTE =
  "frozen at the moment of decision (the ADR-0081 acceptance-freeze pattern): what the ledgers " +
  "showed the decider. Later ledger movement never rewrites this row — compare it against the " +
  "live autofill to see what has changed since.";

/** the compact form of the autofill block a decision freezes into its audit
 * detail — key figures per section, small enough to live in `detail` jsonb */
export function summarizeAutofillForSnapshot(a: CardAutofill): Record<string, unknown> {
  const s = a.sections;
  const latestRt = s.redteam.latestRun as Record<string, unknown> | null;
  return {
    computedAt: a.computedAt,
    window: a.window,
    scope: a.scope,
    evals: {
      runsEver: s.evals.runsEver,
      runsInWindow: s.evals.runsInWindow,
      latestRunId: (s.evals.latestRun as { id?: string } | null)?.id ?? null,
      latestPassRate: (s.evals.latestRun as { passRate?: number | null } | null)?.passRate ?? null,
      groundednessRunsInWindow: (s.evals.groundedness as { runsInWindow: number }).runsInWindow,
    },
    redteam: {
      measured: s.redteam.measured,
      runsEver: s.redteam.runsEver,
      latestAsr: latestRt?.asr ?? null,
      asrLower: latestRt?.asrLower ?? null,
      asrUpper: latestRt?.asrUpper ?? null,
      asrTrials: latestRt?.asrTrials ?? null,
      measurementQuality: latestRt?.measurementQuality ?? null,
    },
    guardrails: {
      orgConfigured: s.guardrails.orgDefault != null,
      agentOverrides: (s.guardrails.agentOverrides as unknown[]).length,
    },
    usage: {
      dispatchesInWindow: s.usage.dispatchesInWindow,
      costUsdInWindow: s.usage.costUsdInWindow,
    },
    grants: { effectiveHolders: s.grants.effectiveHolders },
    drift: {
      baselinesPinned: s.drift.baselinesPinned,
      regressionsInWindow: s.drift.regressionsInWindow,
    },
    links: {
      useCases: (s.links.useCases as unknown[]).length,
      risks: (s.links.risks as unknown[]).length,
      vendors: (s.links.vendors as unknown[]).length,
    },
    note: MRM_SNAPSHOT_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Staleness — has the evidence behind the last certification moved?
// ---------------------------------------------------------------------------

/**
 * ADR-0181 amendment (review finding 1) — WHAT COUNTS AS DRIFT.
 *
 * With staleness-forces-recertification on (the default), drift at the
 * threshold refuses every non-evaluation dispatch of the model for EVERYONE.
 * So drift must be something only a measured regression or a deliberate,
 * governance-level change can produce — never routine evidence that any
 * entitled user creates by doing their job. Since the last granting sign-off:
 *
 *  - `evalRegressions`: an eval run (not one backing a red-team run) that
 *    completed and either
 *      (a) scored WORSE than the certification-era run — the latest completed
 *          run at or before the sign-off with the same agent, dataset version,
 *          scoring semantics, mode, judge (or panel), repetitions and project —
 *          by `evaluateEvalGate` with the CERTIFICATION-ERA run's tolerance
 *          (the caller's own tolerance, floors and pinned baseline are ignored:
 *          whoever starts a manual run chooses those), or
 *      (b) was started by the server (`scheduled`, `workflow`,
 *          `config_change`: thresholds an admin configured) and failed its
 *          gate or regressed against its baseline.
 *  - `redteamRegressions`: a finished red-team run whose attack-success rate
 *    is WORSE (higher) than the certification-era run of the same library
 *    version against the same agent under the same scoring semantics. A
 *    red-team run's own gate verdict is not used: `POST /v1/redteam/runs`
 *    lets the caller choose its trigger and thresholds.
 *  - `riskChanges`: a risk-register row scoped to the subject created or
 *    edited since certification that an ADMIN or a named RISK ACCEPTOR
 *    (`governance_review_policy.risk_acceptor_user_ids`) has authored or
 *    touched (its audited `ai_risk` rows, at any time). Registering a risk is
 *    open to everyone, so a risk only a non-admin has written does not count:
 *    it is shown as `risksAwaitingTriage` until an admin or acceptor triages,
 *    accepts or edits it, and from then on its changes count. Privilege is
 *    read as it stands now (the bootstrap identity counts as admin).
 *  - `guardrailRelaxations`: an agent-scope guardrail override written or
 *    removed so that some detector ends LESS strict (its audited
 *    `transitions`; a removal recorded without transitions counts, as its
 *    direction cannot be shown). Tightenings do not count; org-wide guardrail
 *    defaults are not per-card drift.
 *  - `configChanges`: the subject's dispatch configuration moved — an
 *    agent_config or system-prompt version activated, promoted, rolled back
 *    or canaried, an unversioned agent-config edit, or a custom-provider
 *    endpoint edit.
 *  - `cardEdits`: the card itself edited after it was signed.
 *
 * NOT drift: passing or merely completed eval and red-team runs, errored or
 * denied runs, grant additions, and revocations. A revocation row only ever
 * withdraws access (a tightening); lifting one is the same as granting.
 */
export interface StalenessDrift {
  evalRegressions: number;
  redteamRegressions: number;
  riskChanges: number;
  guardrailRelaxations: number;
  configChanges: number;
  cardEdits: number;
}

export interface CardStaleness {
  certified: boolean;
  lastCertifiedAt: string | null;
  /** ledger ACTIVITY since the last certification, by section. Informational:
   * most of it is routine evidence, and none of it alone is drift. */
  changesSinceCertification: {
    evalRuns: number;
    redteamRuns: number;
    guardrailChanges: number;
    grantChanges: number;
    riskChanges: number;
    /** risks changed since certification that only non-admins have written:
     * registered, awaiting triage by an admin or a risk acceptor — not drift */
    risksAwaitingTriage: number;
    scheduledRegressions: number;
  } | null;
  /** ADR-0181: the drift events since certification, by kind (see
   * `StalenessDrift`) — what the staleness gate counts */
  driftSinceCertification: StalenessDrift | null;
  /** the sum of `driftSinceCertification`; the gate compares it with the
   * org's threshold */
  driftEvents: number;
  drifted: boolean;
  /** the human sentence the UI leads with — null when nothing drifted */
  summary: string | null;
  /** ADR-0181: "N risks registered, awaiting triage" — null when none */
  pendingTriage: string | null;
  note: string;
}

export const MRM_STALENESS_NOTE =
  "drift is counted from the ledgers since the last granting sign-off: an eval run that scored worse " +
  "than the certification-era run of the same suite (or a server-started run that failed its gate), a " +
  "red-team run with a worse attack-success rate than the certification-era run of the same library, a " +
  "risk-register change an admin or risk acceptor made or triaged, an agent guardrail relaxation, a model, prompt or endpoint configuration change, " +
  "or an edit of this card. Passing runs, grants and revocations are routine evidence, not drift. With " +
  "staleness-forces-recertification on, drift at the org's threshold refuses dispatch until a new " +
  "sign-off; expiry stays ADR-0045's validUntil recomputation at dispatch.";

/** the config-version moves that change what a subject agent serves */
const SERVING_ACTIVATION_ACTIONS = [
  "activated",
  "canary_started",
  "canary_adjusted",
  "promoted",
  "rolled_back",
] as const;

/** the eval-run columns a drift comparison reads */
const evalDriftColumns = {
  id: evalRuns.id,
  agentId: evalRuns.agentId,
  datasetId: evalRuns.datasetId,
  datasetVersion: evalRuns.datasetVersion,
  scoringSemantics: evalRuns.scoringSemantics,
  mode: evalRuns.mode,
  judgeAgentId: evalRuns.judgeAgentId,
  judgePanel: evalRuns.judgePanel,
  repetitions: evalRuns.repetitions,
  projectId: evalRuns.projectId,
  trigger: evalRuns.trigger,
  gatePassed: evalRuns.gatePassed,
  regression: evalRuns.regression,
  cases: evalRuns.cases,
  passedCases: evalRuns.passedCases,
  meanScore: evalRuns.meanScore,
  passRate: evalRuns.passRate,
  tolerance: evalRuns.tolerance,
};

type EvalDriftRow = {
  agentId: string | null;
  datasetId: string;
  datasetVersion: number;
  scoringSemantics: number;
  mode: string;
  judgeAgentId: string | null;
  judgePanel: unknown;
  repetitions: number;
  projectId: string | null;
  trigger: string;
  gatePassed: boolean | null;
  regression: boolean | null;
  cases: number;
  passedCases: number;
  meanScore: number | null;
  passRate: number | null;
  tolerance: number;
};

/** two runs are comparable only when they measured the same thing the same
 * way: same subject, suite version, semantics, mode, measuring instrument
 * (judge or panel, and its repetitions) and project (whose compliance cascade
 * shapes the input) */
function evalComparisonKey(r: EvalDriftRow): string {
  return JSON.stringify([
    r.agentId,
    r.datasetId,
    r.datasetVersion,
    r.scoringSemantics,
    r.mode,
    r.judgeAgentId,
    r.judgePanel ?? null,
    r.repetitions,
    r.projectId,
  ]);
}

function evalAggregateOf(r: EvalDriftRow): EvalAggregate | null {
  if (r.meanScore == null || r.passRate == null) return null;
  return {
    cases: r.cases,
    passedCases: r.passedCases,
    failedCases: r.cases - r.passedCases,
    meanScore: r.meanScore,
    passRate: r.passRate,
  };
}

/** eval runs whose trigger the SERVER sets, with thresholds an admin configured */
const SERVER_EVAL_TRIGGERS = new Set(["scheduled", "workflow", "config_change"]);

/** true when an audited agent-scope guardrail write left some detector less strict */
function isGuardrailRelaxation(ruleId: string, detail: unknown): boolean {
  const transitions = (detail as { transitions?: Record<string, { from?: unknown; to?: unknown }> } | null)
    ?.transitions;
  if (!transitions || typeof transitions !== "object") {
    // a removal recorded without its old -> new: the direction cannot be
    // shown, so it counts (strict by default)
    return ruleId === "guardrail-config-deleted";
  }
  const isMode = (m: unknown): m is GuardrailMode =>
    typeof m === "string" && (GUARDRAIL_MODES as readonly string[]).includes(m);
  return Object.values(transitions).some(
    (t) => isMode(t?.from) && isMode(t?.to) && !modeAtLeast(t.to, t.from),
  );
}

/** the audit identity the bootstrap token writes under — admin by definition */
const BOOTSTRAP_IDENTITY = "00000000-0000-0000-0000-000000000000";

/**
 * ADR-0181 (coordinator decision on the review's residual): split the subject's
 * risk-register changes since certification into those an admin or a named
 * risk acceptor has authored or touched (drift) and those only non-admins have
 * written (awaiting triage, not drift). No single non-admin can stale a model
 * for everyone by registering a risk on it.
 */
async function classifyRiskChanges(
  db: Db,
  agentIds: string[],
  since: Date,
  sequential: boolean,
): Promise<{ counted: number; awaitingTriage: number }> {
  if (agentIds.length === 0) return { counted: 0, awaitingTriage: 0 };
  const changed = await db
    .select({ id: aiRisks.id })
    .from(aiRisks)
    .where(and(inArray(aiRisks.agentId, agentIds), gt(aiRisks.updatedAt, since)));
  if (changed.length === 0) return { counted: 0, awaitingTriage: 0 };
  const riskIds = changed.map((r) => r.id);
  const [writes, policy] = await readAll([
    db
      .selectDistinct({ riskId: auditLog.objectId, userId: auditLog.userId })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "ai_risk"), inArray(auditLog.objectId, riskIds))),
    db.select({ acceptors: governanceReviewPolicy.riskAcceptorUserIds }).from(governanceReviewPolicy),
  ], sequential);
  const actorIds = [...new Set(writes.map((w) => w.userId).filter((u) => u !== BOOTSTRAP_IDENTITY))];
  const admins = actorIds.length
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, actorIds), eq(users.isAdmin, true)))
    : [];
  const privileged = new Set<string>([
    BOOTSTRAP_IDENTITY,
    ...admins.map((a) => a.id),
    ...policy.flatMap((p) => p.acceptors ?? []),
  ]);
  const triaged = new Set(writes.filter((w) => privileged.has(w.userId)).map((w) => w.riskId));
  const counted = riskIds.filter((id) => triaged.has(id)).length;
  return { counted, awaitingTriage: riskIds.length - counted };
}

/**
 * What changed since the last sign-off decision. "Certified" here means the
 * most recent decision that GRANTED an acceptance — a record now `approved`,
 * or one that was approved and has since expired / been superseded / been
 * revoked. A denied request certified nothing and starts no clock.
 */
export async function computeCardStaleness(
  db: Db,
  card: CardSubject,
  chain: Array<Pick<ModelCardApprovalRow, "status" | "decidedAt">>,
  now: Date = new Date(),
  opts: LedgerReadOptions = {},
): Promise<CardStaleness> {
  const sequential = opts.inTransaction === true;
  const certifications = chain
    .filter((a) => a.decidedAt && a.status !== "pending" && a.status !== "denied")
    .sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime());
  const last = certifications[0] ?? null;
  if (!last) {
    return {
      certified: false,
      lastCertifiedAt: null,
      changesSinceCertification: null,
      driftSinceCertification: null,
      driftEvents: 0,
      drifted: false,
      summary: null,
      pendingTriage: null,
      note:
        "never certified — staleness measures drift since a sign-off, and no " +
        "sign-off has been granted on this card",
    };
  }
  const since = last.decidedAt!;
  const subjects = await resolveSubjectAgents(db, card);
  const agentIds = subjects.map((a) => a.id);
  const evalWhere = evalScope(card, agentIds);
  const providerIds = [
    ...new Set(
      [card.customProviderId, ...subjects.map((s) => s.customProviderId)].filter(
        (p): p is string => typeof p === "string",
      ),
    ),
  ];
  // a red-team run's eval rows are counted once, as the red-team run
  const notRedteamBacked = sql`NOT EXISTS (SELECT 1 FROM ${redteamRuns} WHERE ${redteamRuns.evalRunId} = ${evalRuns.id})`;
  const none = Promise.resolve([{ n: 0 }]);

  const [
    evalsSince,
    rtSince,
    guardrailsSince,
    grantsSince,
    revocationsSince,
    risksSince,
    regressionsSince,
    evalCandidates,
    rtCandidates,
    guardrailWrites,
    activationsSince,
    agentConfigEditsSince,
    providerEditsSince,
    cardEditsSince,
  ] = await readAll([
    // --- activity (informational) ---------------------------------------
    db.select({ n: count() }).from(evalRuns).where(and(evalWhere, gt(evalRuns.startedAt, since))),
    agentIds.length
      ? db
          .select({ n: count() })
          .from(redteamRuns)
          .where(and(inArray(redteamRuns.agentId, agentIds), gt(redteamRuns.startedAt, since)))
      : none,
    db
      .select({ n: count() })
      .from(guardrailConfigs)
      .where(
        and(
          gt(guardrailConfigs.updatedAt, since),
          agentIds.length
            ? or(
                eq(guardrailConfigs.scope, "org"),
                and(eq(guardrailConfigs.scope, "agent"), inArray(guardrailConfigs.scopeId, agentIds)),
              )
            : eq(guardrailConfigs.scope, "org"),
        ),
      ),
    agentIds.length
      ? db
          .select({ n: count() })
          .from(agentGrants)
          .where(and(inArray(agentGrants.agentId, agentIds), gt(agentGrants.createdAt, since)))
      : none,
    agentIds.length
      ? db
          .select({ n: count() })
          .from(agentRevocations)
          .where(and(inArray(agentRevocations.agentId, agentIds), gt(agentRevocations.createdAt, since)))
      : none,
    agentIds.length
      ? db
          .select({ n: count() })
          .from(aiRisks)
          .where(and(inArray(aiRisks.agentId, agentIds), gt(aiRisks.updatedAt, since)))
      : none,
    db
      .select({ n: count() })
      .from(evalRuns)
      .where(
        and(
          evalWhere,
          eq(evalRuns.trigger, "scheduled"),
          eq(evalRuns.regression, true),
          gt(evalRuns.startedAt, since),
        ),
      ),
    // --- drift inputs ----------------------------------------------------
    db
      .select(evalDriftColumns)
      .from(evalRuns)
      .where(and(evalWhere, eq(evalRuns.status, "completed"), notRedteamBacked, gt(evalRuns.startedAt, since))),
    agentIds.length
      ? db
          .select({ agentId: redteamRuns.agentId, libraryId: redteamRuns.libraryId, scoringSemantics: redteamRuns.scoringSemantics, asr: redteamRuns.asr })
          .from(redteamRuns)
          .where(
            and(
              inArray(redteamRuns.agentId, agentIds),
              gt(redteamRuns.startedAt, since),
              isNotNull(redteamRuns.finishedAt),
              isNotNull(redteamRuns.asr),
            ),
          )
      : Promise.resolve([] as Array<{ agentId: string | null; libraryId: string; scoringSemantics: number; asr: number | null }>),
    agentIds.length
      ? db
          .select({ ruleId: auditLog.ruleId, detail: auditLog.detail })
          .from(auditLog)
          .where(
            and(
              inArray(auditLog.ruleId, ["guardrail-config-updated", "guardrail-config-deleted"]),
              gt(auditLog.at, since),
              sql`${auditLog.detail}->>'scope' = 'agent'`,
              inArray(sql`${auditLog.detail}->>'scopeId'`, agentIds),
            ),
          )
      : Promise.resolve([] as Array<{ ruleId: string | null; detail: unknown }>),
    agentIds.length
      ? db
          .select({ n: count() })
          .from(configActivationEvents)
          .where(
            and(
              inArray(configActivationEvents.artifactType, ["agent_config", "agent_system_prompt"]),
              inArray(configActivationEvents.artifactId, agentIds),
              inArray(configActivationEvents.action, [...SERVING_ACTIVATION_ACTIONS]),
              gt(configActivationEvents.at, since),
            ),
          )
      : none,
    agentIds.length
      ? db
          .select({ n: count() })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.ruleId, "agent-config-edited"),
              inArray(auditLog.objectId, agentIds),
              gt(auditLog.at, since),
              // a VERSIONED edit is counted once, as its activation event;
              // an unversioned one is a plain row write with no version row
              sql`${auditLog.detail}->>'decision' = 'row'`,
              sql`jsonb_typeof(${auditLog.detail}->'changed') = 'array' AND jsonb_array_length(${auditLog.detail}->'changed') > 0`,
            ),
          )
      : none,
    providerIds.length
      ? db
          .select({ n: count() })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.ruleId, "custom-provider-updated"),
              inArray(auditLog.objectId, providerIds),
              gt(auditLog.at, since),
            ),
          )
      : none,
    db
      .select({ n: count() })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mrm-card-updated"), eq(auditLog.objectId, card.id), gt(auditLog.at, since))),
  ], sequential);

  // --- the certification-era references the runs are compared with --------
  const evalDatasetIds = [...new Set(evalCandidates.map((r) => r.datasetId))];
  const rtLibraryIds = [...new Set(rtCandidates.map((r) => r.libraryId))];
  const [evalRefs, rtRefs] = await readAll([
    evalDatasetIds.length
      ? db
          .select(evalDriftColumns)
          .from(evalRuns)
          .where(
            and(
              evalWhere,
              eq(evalRuns.status, "completed"),
              notRedteamBacked,
              inArray(evalRuns.datasetId, evalDatasetIds),
              lte(evalRuns.startedAt, since),
            ),
          )
          .orderBy(desc(evalRuns.startedAt))
      : Promise.resolve([] as EvalDriftRow[]),
    rtLibraryIds.length && agentIds.length
      ? db
          .select({ agentId: redteamRuns.agentId, libraryId: redteamRuns.libraryId, scoringSemantics: redteamRuns.scoringSemantics, asr: redteamRuns.asr })
          .from(redteamRuns)
          .where(
            and(
              inArray(redteamRuns.agentId, agentIds),
              inArray(redteamRuns.libraryId, rtLibraryIds),
              lte(redteamRuns.startedAt, since),
              isNotNull(redteamRuns.finishedAt),
              isNotNull(redteamRuns.asr),
            ),
          )
          .orderBy(desc(redteamRuns.startedAt))
      : Promise.resolve([] as Array<{ agentId: string | null; libraryId: string; scoringSemantics: number; asr: number | null }>),
  ], sequential);

  // newest first, so the first row per key IS the certification-era run
  const evalRefByKey = new Map<string, EvalDriftRow>();
  for (const r of evalRefs) if (!evalRefByKey.has(evalComparisonKey(r))) evalRefByKey.set(evalComparisonKey(r), r);
  let evalRegressions = 0;
  for (const run of evalCandidates) {
    const serverGateFailed =
      SERVER_EVAL_TRIGGERS.has(run.trigger) && (run.gatePassed === false || run.regression === true);
    const ref = evalRefByKey.get(evalComparisonKey(run));
    const current = evalAggregateOf(run);
    const reference = ref ? evalAggregateOf(ref) : null;
    const worseThanCertified =
      current !== null &&
      reference !== null &&
      evaluateEvalGate({
        current,
        baseline: reference,
        tolerance: ref!.tolerance,
        currentSemantics: run.scoringSemantics,
        baselineSemantics: ref!.scoringSemantics,
      }).regression;
    if (serverGateFailed || worseThanCertified) evalRegressions += 1;
  }

  const rtKey = (r: { agentId: string | null; libraryId: string; scoringSemantics: number }) =>
    JSON.stringify([r.agentId, r.libraryId, r.scoringSemantics]);
  const rtRefByKey = new Map<string, number>();
  for (const r of rtRefs) if (r.asr != null && !rtRefByKey.has(rtKey(r))) rtRefByKey.set(rtKey(r), r.asr);
  let redteamRegressions = 0;
  for (const run of rtCandidates) {
    const refAsr = rtRefByKey.get(rtKey(run));
    if (run.asr != null && refAsr !== undefined && run.asr > refAsr) redteamRegressions += 1;
  }

  const risks = await classifyRiskChanges(db, agentIds, since, sequential);
  const changes = {
    evalRuns: evalsSince[0]?.n ?? 0,
    redteamRuns: rtSince[0]?.n ?? 0,
    guardrailChanges: guardrailsSince[0]?.n ?? 0,
    grantChanges: (grantsSince[0]?.n ?? 0) + (revocationsSince[0]?.n ?? 0),
    riskChanges: risksSince[0]?.n ?? 0,
    risksAwaitingTriage: risks.awaitingTriage,
    scheduledRegressions: regressionsSince[0]?.n ?? 0,
  };
  const drift: StalenessDrift = {
    evalRegressions,
    redteamRegressions,
    riskChanges: risks.counted,
    guardrailRelaxations: guardrailWrites.filter((w) => isGuardrailRelaxation(w.ruleId ?? "", w.detail)).length,
    configChanges:
      (activationsSince[0]?.n ?? 0) + (agentConfigEditsSince[0]?.n ?? 0) + (providerEditsSince[0]?.n ?? 0),
    cardEdits: cardEditsSince[0]?.n ?? 0,
  };
  const driftEvents = Object.values(drift).reduce((a, b) => a + b, 0);
  const parts: string[] = [];
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (drift.evalRegressions > 0) parts.push(plural(drift.evalRegressions, "eval regression"));
  if (drift.redteamRegressions > 0) parts.push(plural(drift.redteamRegressions, "red-team regression"));
  if (drift.riskChanges > 0) parts.push(plural(drift.riskChanges, "risk-register change"));
  if (drift.guardrailRelaxations > 0) parts.push(plural(drift.guardrailRelaxations, "agent guardrail relaxation"));
  if (drift.configChanges > 0) parts.push(plural(drift.configChanges, "model or configuration change"));
  if (drift.cardEdits > 0) parts.push(plural(drift.cardEdits, "card edit"));
  const drifted = driftEvents > 0;
  return {
    certified: true,
    lastCertifiedAt: since.toISOString(),
    changesSinceCertification: changes,
    driftSinceCertification: drift,
    driftEvents,
    drifted,
    summary: drifted
      ? `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}` : parts[0]!} since certification — the evidence this sign-off rested on has moved`
      : null,
    pendingTriage:
      risks.awaitingTriage > 0
        ? `${plural(risks.awaitingTriage, "risk")} registered, awaiting triage by an admin or a risk acceptor ` +
          "(not drift until one of them triages, accepts or edits it)"
        : null,
    note: MRM_STALENESS_NOTE,
  };
}
