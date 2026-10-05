/**
 * ADR-0180 A3 — REQUIRED AI TEST CLASSES PER RISK TIER. OWNER: A3 (D3).
 *
 * The pure policy, the strict defaults and the evaluator live in
 * `packages/shared/src/required-tests.ts`; this module stores the policy,
 * serves its routes, loads the red-team and eval ledgers for the evaluator,
 * and feeds the monitor and the deploy gate.
 *
 * STORAGE DECISION (P0, ADR-0180): the per-tier required classes and their
 * freshness live in `governance_review_policy.required_tests` (migration
 * 0155), a column of their own rather than a key inside `tiers`. The existing
 * `PUT /v1/governance/review-policy` rebuilds `tiers` from its own schema and
 * would silently drop an unknown key; a separate column and a separate route
 * keep that PUT (and gateway review-policy.ts) untouched. An absent tier key =
 * the strict default in code (`REQUIRED_TEST_DEFAULTS`): nothing is
 * grandfathered, so an empty column is the strictest policy, not "no policy".
 *
 * EVIDENCE. A red-team run is evidence for an OWASP id when its per-class
 * summary measured at least one probe of a red-team class the evaluator
 * catalog maps to that id; its configuration hash is that of the eval run it
 * reads (`runConfigHash`), so "which configuration was probed" has the same
 * answer as everywhere else. An eval run (not one of a red-team run's trials)
 * is evidence when it has scored results of a scorer the catalog maps to the
 * id. Only COMPLETED runs count.
 */
import type { FastifyInstance } from "fastify";
import {
  aiUseCases,
  and,
  auditLog,
  agents,
  desc,
  eq,
  evalResults,
  evalRuns,
  governanceReviewPolicy,
  inArray,
  isNotNull,
  redteamRuns,
  redteamTrials,
  sql,
  users,
  type Db,
  type EvalRunRow,
} from "@regulait/db";
import {
  ASSURANCE_DEFAULTS,
  REQUIRED_TEST_DEFAULTS,
  REQUIRED_TEST_DEFAULTS_NOTE,
  REVIEW_POLICY_TIER_KEYS,
  UNMEASURABLE_EXPLANATION,
  effectiveRequiredTests,
  evaluateRequiredTests,
  owaspMeasurability,
  requiredTestConditionsFor as sharedRequiredTestConditionsFor,
  requiredTestPolicyProblems,
  requiredTestPolicySchema,
  requiredTestThresholds,
  type AssuranceMonitorRuleId,
  type MonitorAssuranceInput,
  type RequiredTestConditionsForFn,
  type RequiredTestPolicy,
  type RequiredTestRunEvidence,
  type RequiredTestStatusRow,
  type ReviewPolicyTierKey,
} from "@regulait/shared";
import { agentConfigHash, runConfigHash } from "./evals.js";
import { tierKeyFor } from "./review-policy.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const POLICY_ID = "default";
export const REQUIRED_TESTS_PATH = "/v1/governance/review-policy/required-tests";
export const REQUIRED_TESTS_RULE_ID = "review-policy-required-tests-set";

/** The conditions a tier's policy requires; called when conditions are
 * imposed and by the gate. Pure; the implementation is in shared. */
export const requiredTestConditionsFor: RequiredTestConditionsForFn = sharedRequiredTestConditionsFor;

/** the stored policy (`{}` when the row or the column is empty = all strict defaults) */
export async function loadRequiredTestPolicy(db: Db): Promise<RequiredTestPolicy> {
  const [row] = await db
    .select({ requiredTests: governanceReviewPolicy.requiredTests })
    .from(governanceReviewPolicy)
    .where(eq(governanceReviewPolicy.id, POLICY_ID));
  return (row?.requiredTests ?? {}) as RequiredTestPolicy;
}

// ---------------------------------------------------------------------------
// Evidence loading
// ---------------------------------------------------------------------------

/** how far back evidence is read: past the longest freshness an admin may
 * set, so a run that aged out still reads as `stale` rather than `missing` */
const EVIDENCE_LOOKBACK_DAYS = 2 * ASSURANCE_DEFAULTS.requiredTestFreshnessMaxDays;

async function loadRunEvidence(db: Db, agentIds: string[], now: Date): Promise<RequiredTestRunEvidence[]> {
  if (agentIds.length === 0) return [];
  const since = new Date(now.getTime() - EVIDENCE_LOOKBACK_DAYS * 86_400_000);
  const out: RequiredTestRunEvidence[] = [];

  // red-team runs: the per-class summary, and the configuration of the eval run it reads
  const rt = await db
    .select({ run: redteamRuns, evalRun: evalRuns })
    .from(redteamRuns)
    .innerJoin(evalRuns, eq(evalRuns.id, redteamRuns.evalRunId))
    .where(
      and(
        inArray(redteamRuns.agentId, agentIds),
        isNotNull(redteamRuns.finishedAt),
        sql`${redteamRuns.finishedAt} >= ${since.toISOString()}`,
      ),
    )
    .orderBy(desc(redteamRuns.finishedAt))
    .limit(500);
  for (const { run, evalRun } of rt) {
    const classes = (Array.isArray(run.classSummary) ? run.classSummary : []) as Array<{
      attackClass?: unknown;
      probes?: unknown;
      defeated?: unknown;
    }>;
    out.push({
      kind: "redteam",
      runId: run.id,
      agentId: run.agentId!,
      configHash: runConfigHash(evalRun as EvalRunRow),
      completedAt: run.finishedAt!,
      redteamClasses: classes
        .filter((c) => typeof c.attackClass === "string")
        .map((c) => ({ attackClass: String(c.attackClass), probes: Number(c.probes ?? 0), defeated: Number(c.defeated ?? 0) })),
    });
  }

  // eval runs that are NOT a red-team run's trials, with their per-scorer means
  const ev = await db
    .select()
    .from(evalRuns)
    .where(
      and(
        inArray(evalRuns.agentId, agentIds),
        eq(evalRuns.status, "completed"),
        isNotNull(evalRuns.finishedAt),
        sql`${evalRuns.finishedAt} >= ${since.toISOString()}`,
        sql`NOT EXISTS (SELECT 1 FROM ${redteamRuns} WHERE ${redteamRuns.evalRunId} = ${evalRuns.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${redteamTrials} WHERE ${redteamTrials.evalRunId} = ${evalRuns.id})`,
      ),
    )
    .orderBy(desc(evalRuns.finishedAt))
    .limit(500);
  if (ev.length > 0) {
    const scored = await db
      .select({
        runId: evalResults.runId,
        scorerKind: evalResults.scorerKind,
        results: sql<number>`count(*)::int`,
        meanScore: sql<number>`avg(${evalResults.score})::float8`,
      })
      .from(evalResults)
      .where(inArray(evalResults.runId, ev.map((r) => r.id)))
      .groupBy(evalResults.runId, evalResults.scorerKind);
    for (const r of ev) {
      out.push({
        kind: "eval",
        runId: r.id,
        agentId: r.agentId!,
        configHash: runConfigHash(r),
        completedAt: r.finishedAt!,
        scorers: scored
          .filter((s) => s.runId === r.id)
          .map((s) => ({ scorerKind: s.scorerKind, results: Number(s.results), meanScore: Number(s.meanScore) })),
      });
    }
  }
  return out;
}

/**
 * THE EVALUATOR, on the ledgers: the status of every (required class, agent)
 * pair of a use case, live. Satisfied only when a completed run of EVERY agent
 * of the intended stack measured the class, on the agent's configuration hash
 * now, within the tier's freshness, and met the threshold. `policy` defaults
 * to the stored one.
 */
export async function requiredTestStatus(
  db: Db,
  useCase: { id: string; euAiActTier: string | null; intendedAgentIds: readonly string[] },
  now: Date,
  policy?: RequiredTestPolicy,
): Promise<RequiredTestStatusRow[]> {
  const pol = policy ?? (await loadRequiredTestPolicy(db));
  const tier = tierKeyFor(useCase.euAiActTier);
  const eff = effectiveRequiredTests(tier, pol);
  const ids = [...new Set(useCase.intendedAgentIds)];
  const rows = ids.length ? await db.select().from(agents).where(inArray(agents.id, ids)) : [];
  const byId = new Map(rows.map((a) => [a.id, a]));
  const stack = [];
  for (const id of ids) {
    const a = byId.get(id);
    // a deleted agent cannot have been tested on its configuration: it reads
    // `missing` under its id (the gate also refuses it as unavailable)
    stack.push(a ? { id, name: a.name, configHash: await agentConfigHash(db, a) } : { id, name: id, configHash: `deleted:${id}` });
  }
  return evaluateRequiredTests({
    tierPolicy: { classes: eff.classes, freshnessDays: eff.freshnessDays },
    agents: stack,
    runs: await loadRunEvidence(db, ids, now),
    now,
  });
}

// ---------------------------------------------------------------------------
// The monitor's loader
// ---------------------------------------------------------------------------

/**
 * `required_test_stale`: for every APPROVED use case, a required class whose
 * passing evidence AGED OUT — the newest run on the agent's current
 * configuration is past the freshness limit, and no fresher one exists. A
 * class never run is the gate's business (it refuses it live), not an alert;
 * neither is a configuration change, which the gate also reads live.
 */
export async function requiredTestsMonitorInput(
  db: Db,
  now: Date,
): Promise<Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>> {
  const approved = await db
    .select({
      id: aiUseCases.id,
      name: aiUseCases.name,
      euAiActTier: aiUseCases.euAiActTier,
      intendedAgentIds: aiUseCases.intendedAgentIds,
    })
    .from(aiUseCases)
    .where(eq(aiUseCases.status, "approved"));
  const policy = await loadRequiredTestPolicy(db);
  const breaches: MonitorAssuranceInput["breaches"] = [];
  for (const uc of approved) {
    const rows = await requiredTestStatus(db, { ...uc, intendedAgentIds: (uc.intendedAgentIds ?? []) as string[] }, now, policy);
    for (const r of rows) {
      if (r.state !== "stale" || r.staleBecause !== "age" || !r.agentId) continue;
      breaches.push({
        subjectKey: `use_case:${uc.id}>required_test:${r.testClass}>agent:${r.agentId}`,
        title: `Required test ${r.testName} (${r.testClass}) is stale for "${uc.name}" on agent ${r.agentName ?? r.agentId}`,
        detail: {
          useCaseId: uc.id,
          testClass: r.testClass,
          agentId: r.agentId,
          runId: r.runId,
          completedAt: r.completedAt,
          freshnessDays: r.freshnessDays,
          tier: tierKeyFor(uc.euAiActTier),
        },
      });
    }
  }
  return { required_test_stale: { breaches } };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function view(db: Db) {
  const policy = await loadRequiredTestPolicy(db);
  const [last] = await db
    .select({ at: auditLog.at, userId: auditLog.userId })
    .from(auditLog)
    .where(eq(auditLog.ruleId, REQUIRED_TESTS_RULE_ID))
    .orderBy(desc(auditLog.at))
    .limit(1);
  let updatedByName: string | null = null;
  if (last && last.userId !== NO_IDENTITY) {
    const [u] = await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, last.userId));
    updatedByName = u ? u.displayName || u.email : null;
  }
  const catalog = owaspMeasurability();
  const name = new Map(catalog.map((m) => [m.id, m.name]));
  const describe = (t: ReviewPolicyTierKey) => {
    const eff = effectiveRequiredTests(t, policy);
    return {
      source: eff.source,
      freshnessDays: eff.freshnessDays,
      classes: eff.classes.map((c) => ({ ...c, name: name.get(c.testClass) ?? c.testClass, ...requiredTestThresholds(c) })),
    };
  };
  return {
    policy,
    effective: Object.fromEntries(REVIEW_POLICY_TIER_KEYS.map((t) => [t, describe(t)])),
    defaults: REQUIRED_TEST_DEFAULTS,
    defaultsNote: REQUIRED_TEST_DEFAULTS_NOTE,
    freshness: { defaultDays: ASSURANCE_DEFAULTS.requiredTestFreshnessDays, maxDays: ASSURANCE_DEFAULTS.requiredTestFreshnessMaxDays },
    testClasses: catalog,
    unmeasurableExplanation: UNMEASURABLE_EXPLANATION,
    updatedAt: last ? last.at.toISOString() : null,
    updatedByName,
  };
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A3 block):
 *   GET /v1/governance/review-policy/required-tests  any signed-in user (like GET review-policy)
 *   PUT /v1/governance/review-policy/required-tests  admin, audited with the old and new value
 * The PUT body is the whole `RequiredTestPolicy`: a tier left out reverts to
 * its strict default; `classes: []` relaxes a tier to nothing (audited).
 */
export function registerRequiredTestRoutes(app: FastifyInstance, db: Db): void {
  app.get(REQUIRED_TESTS_PATH, async () => view(db));

  app.put(REQUIRED_TESTS_PATH, async (req, reply) => {
    const parsed = requiredTestPolicySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send({ error: "invalid_required_tests", issues: parsed.error.issues });
    }
    const next = parsed.data as RequiredTestPolicy;
    const problems = requiredTestPolicyProblems(next);
    if (problems.length > 0) {
      const first = problems[0]!;
      return reply.status(422).send({
        error: first.code,
        testClass: first.testClass,
        tier: first.tier,
        detail: first.detail,
        problems,
      });
    }
    const before = await loadRequiredTestPolicy(db);
    await db
      .insert(governanceReviewPolicy)
      .values({ id: POLICY_ID, requiredTests: next })
      .onConflictDoUpdate({ target: governanceReviewPolicy.id, set: { requiredTests: next } });
    // a tier is RELAXED when a class it required is gone, a threshold loosened,
    // or its freshness lengthened — named in the audit row
    const relaxed = REVIEW_POLICY_TIER_KEYS.filter((t) => {
      const was = effectiveRequiredTests(t, before);
      const now = effectiveRequiredTests(t, next);
      if (now.freshnessDays > was.freshnessDays) return true;
      return was.classes.some((w) => {
        const n = now.classes.find((c) => c.testClass === w.testClass);
        if (!n) return true;
        const a = requiredTestThresholds(w);
        const b = requiredTestThresholds(n);
        return (a.maxAsr !== null && b.maxAsr !== null && b.maxAsr > a.maxAsr) || (a.minScore !== null && b.minScore !== null && b.minScore < a.minScore);
      });
    });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "org_settings",
      objectId: null,
      detail: { setting: "requiredTests", from: before, to: next, relaxedTiers: relaxed },
      effect: "allow",
      ruleId: REQUIRED_TESTS_RULE_ID,
      ruleChain: [],
      reason:
        `required AI tests per tier set: ${REVIEW_POLICY_TIER_KEYS.map((t) => `${t} ${effectiveRequiredTests(t, next).classes.length}`).join(", ")}` +
        (relaxed.length ? `; RELAXED for ${relaxed.join(", ")}` : ""),
    });
    return view(db);
  });
}
