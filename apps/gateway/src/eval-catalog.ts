/**
 * ADR-0173 batch 2c (item 7) — the evaluator catalog, gateway half.
 *
 *   `packages/shared/src/evaluator-catalog.ts`  the catalog and its control
 *                                               references (pure, tested)
 *   THIS FILE                                   which evaluators were TESTED in
 *                                               a period, from the run ledgers,
 *                                               and the catalog / "tested by"
 *                                               routes
 *
 * "TESTED" HAS ONE MEANING. An evaluator is tested in a period only by a
 * COMPLETED run that PASSED in that period:
 *   - a scorer: a completed eval run whose gate passed and that scored at least
 *     one case with that scorer;
 *   - an external scorer: the same, on rows stamped `external:<name>`;
 *   - a red-team class: a finished red-team run that measured the class and in
 *     which no probe of the class was defeated;
 *   - a detector: a passed red-team class aimed at it (DETECTOR_TESTED_BY).
 * Completed-but-failed is `failed`; nothing at all is `not_run`, which never
 * counts as passed. The compliance-pack collector `evaluator_tested` and the
 * "tested by" chip both read `evaluatorTestEvidence`, so the two can never
 * disagree.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  compliancePackControls,
  compliancePacks,
  eq,
  evalResults,
  evalRuns,
  externalScorers,
  gte,
  inArray,
  isNotNull,
  lt,
  redteamRuns,
  sql,
  type Db,
} from "@regulait/db";
import {
  DETECTOR_TESTED_BY,
  EVALUATOR_CATALOG_NOTE,
  OWASP_REFERENCE_SOURCE,
  evaluatorCatalog,
  evaluatorTestStatus,
  evaluatorsForControl,
  externalScorerCatalogEntry,
  owaspReferences,
  type CatalogEvaluator,
  type EvaluatorTestEvidence,
} from "@regulait/shared";

export interface TestEvidenceScope {
  periodStart: Date;
  periodEnd: Date;
  /** null = org-wide; otherwise only runs attributed to these projects count */
  projectIds: string[] | null;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const safeIds = (ids: string[]) => (ids.length ? ids : [ZERO_UUID]);

/** the static catalog plus every registered external scorer */
export async function loadEvaluatorCatalog(db: Db): Promise<CatalogEvaluator[]> {
  const ext = await db
    .select({ name: externalScorers.name, scorerKinds: externalScorers.scorerKinds })
    .from(externalScorers);
  return [...evaluatorCatalog(), ...ext.map((e) => externalScorerCatalogEntry({ name: e.name, scorerKinds: e.scorerKinds ?? [] }))];
}

interface Tally {
  runs: number;
  passedRuns: number;
  lastRunId: string | null;
  lastAt: number;
}

function bump(m: Map<string, Tally>, id: string, passed: boolean, runId: string, at: Date | null) {
  const t = m.get(id) ?? { runs: 0, passedRuns: 0, lastRunId: null, lastAt: -Infinity };
  t.runs += 1;
  if (passed) t.passedRuns += 1;
  const ms = at ? at.getTime() : -Infinity;
  if (ms >= t.lastAt) {
    t.lastAt = ms;
    t.lastRunId = runId;
  }
  m.set(id, t);
}

/**
 * The test evidence for every evaluator in the catalog, for one period and
 * scope. Every evaluator appears; one with no run is `not_run`.
 */
export async function evaluatorTestEvidence(
  db: Db,
  scope: TestEvidenceScope,
  catalog?: CatalogEvaluator[],
): Promise<Map<string, EvaluatorTestEvidence>> {
  const entries = catalog ?? (await loadEvaluatorCatalog(db));
  const tallies = new Map<string, Tally>();

  // scorers and external scorers: one row per (completed run, instrument)
  const projectFilter =
    scope.projectIds === null ? undefined : inArray(evalRuns.projectId, safeIds(scope.projectIds));
  const scorerRows = await db
    .selectDistinct({
      runId: evalRuns.id,
      gatePassed: evalRuns.gatePassed,
      finishedAt: evalRuns.finishedAt,
      kind: evalResults.scorerKind,
      method: sql<string | null>`${evalResults.detail} ->> 'method'`,
    })
    .from(evalRuns)
    .innerJoin(evalResults, eq(evalResults.runId, evalRuns.id))
    .where(
      and(
        eq(evalRuns.status, "completed"),
        isNotNull(evalRuns.finishedAt),
        gte(evalRuns.finishedAt, scope.periodStart),
        lt(evalRuns.finishedAt, scope.periodEnd),
        projectFilter,
      ),
    );
  const seen = new Set<string>();
  for (const r of scorerRows) {
    const ids = [`scorer:${r.kind}`];
    if (r.method && r.method.startsWith("external:")) ids.push(r.method);
    for (const id of ids) {
      const key = `${id}|${r.runId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bump(tallies, id, r.gatePassed === true, r.runId, r.finishedAt);
    }
  }

  // red-team classes: per class, a finished run that measured it, passed when
  // no probe of the class was defeated
  const rtRows = await db
    .select({ id: redteamRuns.id, classSummary: redteamRuns.classSummary, finishedAt: redteamRuns.finishedAt })
    .from(redteamRuns)
    .where(
      and(
        isNotNull(redteamRuns.finishedAt),
        gte(redteamRuns.finishedAt, scope.periodStart),
        lt(redteamRuns.finishedAt, scope.periodEnd),
        scope.projectIds === null ? undefined : inArray(redteamRuns.projectId, safeIds(scope.projectIds)),
      ),
    );
  const classPassed = new Map<string, Array<{ runId: string; passed: boolean; at: Date | null }>>();
  for (const r of rtRows) {
    for (const raw of (r.classSummary ?? []) as Array<Record<string, unknown>>) {
      const cls = typeof raw.attackClass === "string" ? raw.attackClass : null;
      const probes = typeof raw.probes === "number" ? raw.probes : 0;
      if (!cls || probes <= 0) continue; // a class with no measured probe was not run
      const passed = raw.defeated === 0;
      bump(tallies, `redteam:${cls}`, passed, r.id, r.finishedAt);
      const list = classPassed.get(cls) ?? [];
      list.push({ runId: r.id, passed, at: r.finishedAt });
      classPassed.set(cls, list);
    }
  }
  // detectors: tested through the red-team classes aimed at them
  for (const [detector, classes] of Object.entries(DETECTOR_TESTED_BY)) {
    for (const cls of classes) {
      for (const run of classPassed.get(cls) ?? []) bump(tallies, `detector:${detector}`, run.passed, run.runId, run.at);
    }
  }

  const out = new Map<string, EvaluatorTestEvidence>();
  for (const e of entries) {
    const t = tallies.get(e.id);
    out.set(e.id, {
      status: evaluatorTestStatus(t?.runs ?? 0, t?.passedRuns ?? 0),
      runs: t?.runs ?? 0,
      passedRuns: t?.passedRuns ?? 0,
      lastRunId: t?.lastRunId ?? null,
    });
  }
  return out;
}

export interface TestedByEntry {
  evaluatorId: string;
  kind: CatalogEvaluator["kind"];
  name: string;
  status: EvaluatorTestEvidence["status"];
  runs: number;
  passedRuns: number;
  lastRunId: string | null;
}

/** per control ref, the evaluators that cite it and their test status */
export async function testedByForControls(
  db: Db,
  controlRefs: readonly string[],
  scope: TestEvidenceScope,
): Promise<Record<string, TestedByEntry[]>> {
  const catalog = await loadEvaluatorCatalog(db);
  const evidence = await evaluatorTestEvidence(db, scope, catalog);
  const out: Record<string, TestedByEntry[]> = {};
  for (const ref of controlRefs) {
    out[ref] = evaluatorsForControl(ref, catalog).map((e) => {
      const ev = evidence.get(e.id)!;
      return { evaluatorId: e.id, kind: e.kind, name: e.name, ...ev };
    });
  }
  return out;
}

/**
 * The `evaluator_tested` pack collector: how many evaluators that cite this
 * control PASSED a completed run in the period. Only `passed` counts.
 */
export async function countTestedEvaluators(db: Db, controlRef: string, scope: TestEvidenceScope): Promise<number> {
  const map = await testedByForControls(db, [controlRef], scope);
  return (map[controlRef] ?? []).filter((e) => e.status === "passed").length;
}

// ---------------------------------------------------------------------------
// Routes (registered from registerEvalRoutes; admin-only by default)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const testedByQuery = z
  .object({
    packId: z.string().uuid(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

export function registerEvalCatalogRoutes(app: FastifyInstance, db: Db) {
  /** the catalog: every evaluator with its control references and the OWASP vocabulary */
  app.get("/v1/evals/catalog", async () => {
    const catalog = await loadEvaluatorCatalog(db);
    return {
      evaluators: catalog,
      counts: {
        scorers: catalog.filter((e) => e.kind === "scorer").length,
        detectors: catalog.filter((e) => e.kind === "detector").length,
        redteamClasses: catalog.filter((e) => e.kind === "redteam_class").length,
        externalScorers: catalog.filter((e) => e.kind === "external_scorer").length,
      },
      owasp: { references: owaspReferences(), source: OWASP_REFERENCE_SOURCE },
      note: EVALUATOR_CATALOG_NOTE,
    };
  });

  /**
   * "Tested by", per control of a pack: which evaluators cite the control and
   * whether a completed run of each PASSED in the period. Org-wide, so
   * admin-only (the default gate).
   */
  app.get("/v1/evals/catalog/tested-by", async (req, reply) => {
    const q = testedByQuery.parse(req.query);
    const [pack] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, q.packId));
    if (!pack) return reply.status(404).send({ error: "unknown_pack" });
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 90 * DAY_MS);
    if (!(from < to)) return reply.status(400).send({ error: "invalid_period" });
    const controls = await db
      .select({ controlRef: compliancePackControls.controlRef })
      .from(compliancePackControls)
      .where(eq(compliancePackControls.packId, pack.id));
    const testedBy = await testedByForControls(
      db,
      controls.map((c) => c.controlRef),
      { periodStart: from, periodEnd: to, projectIds: null },
    );
    return {
      packId: pack.id,
      framework: pack.framework,
      period: { start: from.toISOString(), end: to.toISOString() },
      controls: testedBy,
      note:
        "A control is TESTED only by a completed run that passed in the period. 'failed' means runs completed " +
        "and none passed; 'not run' means nothing measured it, and never counts as passed.",
    };
  });
}
