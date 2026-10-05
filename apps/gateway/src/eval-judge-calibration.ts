/**
 * ADR-0173 batch 2c / ADR-0177 clean-room item 8 — JUDGE CALIBRATION against
 * human annotation labels.
 *
 * For a completed run, each judge's pass/fail on each judge-scored case is
 * paired with the human label for that case's eval result, and agreement is
 * reported as Cohen's kappa (`kappaReport` in @regulait/shared): only from
 * KAPPA_MIN_PAIRED_LABELS completed pairs, otherwise "insufficient", with a
 * seeded bootstrap interval.
 *
 * WHERE THE LABELS COME FROM. Annotation queues (Q) own the labels. This module
 * does not import them: it takes an injected `AnnotationLabelsFor`, which the
 * integrator wires to Q's `annotationLabelsFor`, and tests pass a fake. With
 * nothing wired, the route answers 503 rather than inventing agreement.
 *
 * OBSERVE-ONLY. Calibration reads; it never writes a run, a result or a gate.
 * The response carries the run's gate verdict unchanged so a reader can see it
 * did not move, and the only write is the audit row of the read.
 */
import {
  and,
  asc,
  auditLog,
  eq,
  evalJudgeVerdicts,
  evalResults,
  evalRuns,
  inArray,
  type Db,
} from "@regulait/db";
import {
  humanVerdict,
  isJudgeBackedScorer,
  kappaReport,
  type JudgeCalibrationInput,
  type KappaReport,
} from "@regulait/shared";

/** the subjects an annotation can be about (Q's item kinds) */
export type AnnotationSubjectKind = "trace" | "span" | "eval_result";

/** one human label on one subject */
export interface AnnotationLabel {
  subjectId: string;
  /** the rubric label, when the rubric has labels */
  label: string | null;
  /** the rubric score, when the rubric has scores (0..1) */
  value: number | null;
  /** only a COMPLETED annotation item counts as a paired label */
  completed: boolean;
}

/** injected; the integrator wires it to Q's `annotationLabelsFor` */
export type AnnotationLabelsFor = (kind: AnnotationSubjectKind, ids: string[]) => Promise<AnnotationLabel[]>;

export interface JudgeCalibration {
  judge: string;
  judgeAgentId: string | null;
  weight: number | null;
  report: KappaReport;
}

export type CalibrationOutcome =
  | {
      ok: true;
      runId: string;
      judgedResults: number;
      labelledResults: number;
      judges: JudgeCalibration[];
      /** the combined (panel) verdict as stored on each eval result */
      combined: KappaReport;
      gate: { gatePassed: boolean | null; regression: boolean | null };
      observeOnly: true;
      note: string;
    }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * One human verdict per subject: the majority of its completed labels. A tie
 * is a disagreement between reviewers, so the subject has no single human
 * verdict and is not paired.
 */
function consolidate(labels: AnnotationLabel[], opts: JudgeCalibrationInput): Map<string, "pass" | "fail"> {
  const votes = new Map<string, { pass: number; fail: number }>();
  for (const l of labels) {
    if (!l.completed) continue;
    const v = humanVerdict(l, opts);
    if (!v) continue;
    const t = votes.get(l.subjectId) ?? { pass: 0, fail: 0 };
    t[v] += 1;
    votes.set(l.subjectId, t);
  }
  const out = new Map<string, "pass" | "fail">();
  for (const [id, t] of votes) {
    if (t.pass !== t.fail) out.set(id, t.pass > t.fail ? "pass" : "fail");
  }
  return out;
}

export async function calibrateRunJudges(
  db: Db,
  args: { runId: string; labelsFor: AnnotationLabelsFor; input: JudgeCalibrationInput; actorUserId: string | null },
): Promise<CalibrationOutcome> {
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, args.runId));
  if (!run) return { ok: false, status: 404, error: "unknown_run" };
  if (run.status !== "completed") return { ok: false, status: 409, error: "run_not_completed" };
  const results = (
    await db
      .select({
        id: evalResults.id,
        caseId: evalResults.caseId,
        scorerKind: evalResults.scorerKind,
        passed: evalResults.passed,
        error: evalResults.error,
        detail: evalResults.detail,
      })
      .from(evalResults)
      .where(eq(evalResults.runId, run.id))
      .orderBy(asc(evalResults.createdAt), asc(evalResults.id))
  ).filter(
    (r) =>
      isJudgeBackedScorer(r.scorerKind) &&
      r.error === null &&
      // an external instrument is not a judge; it is calibrated elsewhere, if at all
      !(typeof r.detail?.method === "string" && (r.detail.method as string).startsWith("external:")),
  );
  if (results.length === 0) {
    return {
      ok: false,
      status: 422,
      error: "no_judged_cases",
      detail: "this run has no case scored by a judge, so there is nothing to calibrate",
    };
  }

  const labels = await args.labelsFor(
    "eval_result",
    results.map((r) => r.id),
  );
  const human = consolidate(
    labels.filter((l) => results.some((r) => r.id === l.subjectId)),
    args.input,
  );

  // per judge: its pass/fail per case — the majority over repetitions (a tie,
  // or every repetition failing to produce a verdict, is no verdict)
  const caseIds = results.map((r) => r.caseId).filter((id): id is string => id !== null);
  const verdicts = caseIds.length
    ? await db
        .select()
        .from(evalJudgeVerdicts)
        .where(and(eq(evalJudgeVerdicts.runId, run.id), inArray(evalJudgeVerdicts.caseId, caseIds)))
    : [];
  const resultByCase = new Map(results.filter((r) => r.caseId).map((r) => [r.caseId!, r]));
  const judges: JudgeCalibration[] = [];
  if (verdicts.length > 0) {
    const names = [...new Set(verdicts.map((v) => v.judgeName))].sort();
    for (const name of names) {
      const mine = verdicts.filter((v) => v.judgeName === name);
      const perCase = new Map<string, { pass: number; fail: number }>();
      for (const v of mine) {
        if (!v.caseId || v.passed === null) continue;
        const t = perCase.get(v.caseId) ?? { pass: 0, fail: 0 };
        t[v.passed ? "pass" : "fail"] += 1;
        perCase.set(v.caseId, t);
      }
      const pairs: Array<readonly [string, string]> = [];
      for (const [caseId, t] of perCase) {
        const res = resultByCase.get(caseId);
        const h = res ? human.get(res.id) : undefined;
        if (!h || t.pass === t.fail) continue;
        pairs.push([t.pass > t.fail ? "pass" : "fail", h] as const);
      }
      judges.push({
        judge: name,
        judgeAgentId: mine[0]?.judgeAgentId ?? null,
        weight: mine[0]?.weight ?? null,
        report: kappaReport(pairs, `${run.id}:${name}`),
      });
    }
  } else {
    // a single-judge run keeps its verdict on the result row itself
    const pairs: Array<readonly [string, string]> = [];
    for (const r of results) {
      const h = human.get(r.id);
      if (h) pairs.push([r.passed ? "pass" : "fail", h] as const);
    }
    judges.push({
      judge: run.judgeImpl ?? "judge",
      judgeAgentId: run.judgeAgentId,
      weight: null,
      report: kappaReport(pairs, `${run.id}:${run.judgeImpl ?? "judge"}`),
    });
  }
  const combinedPairs: Array<readonly [string, string]> = [];
  for (const r of results) {
    const h = human.get(r.id);
    if (h) combinedPairs.push([r.passed ? "pass" : "fail", h] as const);
  }
  const combined = kappaReport(combinedPairs, `${run.id}:combined`);

  await db.insert(auditLog).values({
    userId: args.actorUserId ?? "00000000-0000-0000-0000-000000000000",
    objectType: "eval_run",
    objectId: run.id,
    detail: {
      phase: "judge-calibration",
      judgedResults: results.length,
      labelledResults: human.size,
      judges: judges.map((j) => ({ judge: j.judge, status: j.report.status, pairs: j.report.pairs, kappa: j.report.kappa })),
      combined: { status: combined.status, pairs: combined.pairs, kappa: combined.kappa },
      observeOnly: true,
    },
    effect: "allow",
    ruleId: "eval-judge-calibration",
    ruleChain: [],
    reason: `judge calibration read for run ${run.id}: ${human.size} labelled of ${results.length} judged case(s); observe-only`,
  });

  return {
    ok: true,
    runId: run.id,
    judgedResults: results.length,
    labelledResults: human.size,
    judges,
    combined,
    gate: { gatePassed: run.gatePassed, regression: run.regression },
    observeOnly: true,
    note:
      "Agreement between each judge's pass/fail and human annotation labels (Cohen's kappa). Reported from " +
      `${combined.required} completed paired labels; below that it says "insufficient". Observe-only: calibration ` +
      "never changes a gate, a score or a stored verdict.",
  };
}
