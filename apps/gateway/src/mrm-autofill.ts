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
  count,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  gt,
  gte,
  guardrailConfigs,
  inArray,
  isNull,
  or,
  redteamRuns,
  roleAgentGrants,
  roleAssignments,
  roles,
  sql,
  usageEvents,
  type Db,
  type ModelCardApprovalRow,
  type ModelCardRow,
  type SQL,
} from "@regulait/db";
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
): Promise<CardAutofill> {
  const windowStart = new Date(now.getTime() - MRM_AUTOFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const subjects = await resolveSubjectAgents(db, card);
  const agentIds = subjects.map((a) => a.id);
  const evalWhere = evalScope(card, agentIds);

  // --- evals + groundedness (ADR-0044 / ADR-0067) --------------------------
  const groundedJoin = and(
    eq(evalRuns.datasetId, evalDatasets.id),
    eq(evalRuns.datasetVersion, evalDatasets.version),
  );
  const [evalsEver, evalsInWindow, latestEval, groundedInWindow, latestGrounded] = await Promise.all([
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
  ]);
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
    ? await Promise.all([
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
      ])
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
  const [orgConfig, agentOverrides] = await Promise.all([
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
  ]);
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
    ? await Promise.all([
        db
          .select({ n: count(), costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
          .from(usageEvents)
          .where(and(usageWhere, gte(usageEvents.at, windowStart))),
        db
          .select({ lastAt: sql<string>`max(${usageEvents.at})` })
          .from(usageEvents)
          .where(usageWhere),
      ])
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
    ? await Promise.all([
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
      ])
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
  const [baselines, latestScheduled, regressionsInWindow] = await Promise.all([
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
  ]);
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
  const [useCaseRows, riskRows, vendorRows] = await Promise.all([
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
  ]);
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
// Staleness — has the world moved since the last certification?
// ---------------------------------------------------------------------------

export interface CardStaleness {
  certified: boolean;
  lastCertifiedAt: string | null;
  /** ledger movement since the last certification decision, by section */
  changesSinceCertification: {
    evalRuns: number;
    redteamRuns: number;
    guardrailChanges: number;
    grantChanges: number;
    riskChanges: number;
    scheduledRegressions: number;
  } | null;
  drifted: boolean;
  /** the human sentence the UI leads with — null when nothing moved */
  summary: string | null;
  note: string;
}

export const MRM_STALENESS_NOTE =
  "computed by comparing ledger timestamps against the last sign-off decision — it INFORMS the " +
  "recertification conversation and gates nothing; expiry enforcement stays exactly ADR-0045's " +
  "validUntil recomputation at dispatch.";

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
): Promise<CardStaleness> {
  const certifications = chain
    .filter((a) => a.decidedAt && a.status !== "pending" && a.status !== "denied")
    .sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime());
  const last = certifications[0] ?? null;
  if (!last) {
    return {
      certified: false,
      lastCertifiedAt: null,
      changesSinceCertification: null,
      drifted: false,
      summary: null,
      note:
        "never certified — staleness measures ledger movement since a sign-off, and no " +
        "sign-off has been granted on this card",
    };
  }
  const since = last.decidedAt!;
  const subjects = await resolveSubjectAgents(db, card);
  const agentIds = subjects.map((a) => a.id);
  const evalWhere = evalScope(card, agentIds);

  const [evalsSince, rtSince, guardrailsSince, grantsSince, revocationsSince, risksSince, regressionsSince] =
    await Promise.all([
      db.select({ n: count() }).from(evalRuns).where(and(evalWhere, gt(evalRuns.startedAt, since))),
      agentIds.length
        ? db
            .select({ n: count() })
            .from(redteamRuns)
            .where(and(inArray(redteamRuns.agentId, agentIds), gt(redteamRuns.startedAt, since)))
        : Promise.resolve([{ n: 0 }]),
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
        : Promise.resolve([{ n: 0 }]),
      agentIds.length
        ? db
            .select({ n: count() })
            .from(agentRevocations)
            .where(and(inArray(agentRevocations.agentId, agentIds), gt(agentRevocations.createdAt, since)))
        : Promise.resolve([{ n: 0 }]),
      agentIds.length
        ? db
            .select({ n: count() })
            .from(aiRisks)
            .where(and(inArray(aiRisks.agentId, agentIds), gt(aiRisks.updatedAt, since)))
        : Promise.resolve([{ n: 0 }]),
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
    ]);

  const changes = {
    evalRuns: evalsSince[0]?.n ?? 0,
    redteamRuns: rtSince[0]?.n ?? 0,
    guardrailChanges: guardrailsSince[0]?.n ?? 0,
    grantChanges: (grantsSince[0]?.n ?? 0) + (revocationsSince[0]?.n ?? 0),
    riskChanges: risksSince[0]?.n ?? 0,
    scheduledRegressions: regressionsSince[0]?.n ?? 0,
  };
  const parts: string[] = [];
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (changes.evalRuns > 0) parts.push(plural(changes.evalRuns, "eval run"));
  if (changes.redteamRuns > 0) parts.push(plural(changes.redteamRuns, "red-team run"));
  if (changes.guardrailChanges > 0) parts.push(plural(changes.guardrailChanges, "guardrail change"));
  if (changes.grantChanges > 0) parts.push(plural(changes.grantChanges, "grant change"));
  if (changes.riskChanges > 0) parts.push(plural(changes.riskChanges, "risk-register change"));
  if (changes.scheduledRegressions > 0)
    parts.push(plural(changes.scheduledRegressions, "drift regression"));
  const drifted = parts.length > 0;
  return {
    certified: true,
    lastCertifiedAt: since.toISOString(),
    changesSinceCertification: changes,
    drifted,
    summary: drifted
      ? `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}` : parts[0]!} since certification — the evidence this sign-off rested on has moved`
      : null,
    note: MRM_STALENESS_NOTE,
  };
}
