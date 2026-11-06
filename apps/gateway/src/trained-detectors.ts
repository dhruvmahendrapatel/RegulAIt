/**
 * ADR-0220 — TRAINED RUNTIME DETECTORS: the gateway half.
 *
 * ADR-0088 attached registered external scorers to the eval path only and
 * named the inline guardrail path as the follow-up the owner had not decided.
 * The P7 backlog item decides it: an org MAY turn on three trained detectors
 * (a PII recogniser, a prompt-injection classifier, a harm classifier), each
 * served by a registered external scorer that claims the matching
 * `guardrail_*` kind. The reference service is `agents/trained-detectors/`
 * (permissively licensed models, weights baked into the image, no runtime
 * downloads); any service that speaks the ADR-0088 contract will do.
 *
 * What this module owns:
 *   - loading the org's settings (`guardrail_trained_detectors`), once per
 *     policy resolution, and the scorers they name, lazily and once per policy;
 *   - running the calls for one phase in parallel through the egress-guarded
 *     fetch, each bounded by its own timeout;
 *   - the admin routes (GET, PUT per kind), with a settings_relax step-up for
 *     every relaxation and the audit row written in the same transaction.
 *
 * The decision logic (planning, verdict to counts, fail-closed merge) is pure
 * and lives in `@regulait/shared` `trained-detectors.ts`.
 *
 * NO PROMPT CONTENT LEAVES THIS MODULE except in the body of the guarded call
 * itself. A failure is reduced to a `trained_unavailable` hit; the error text
 * (which can echo a scorer's response body) is never logged or audited.
 */

import type { FastifyInstance } from "fastify";
import {
  auditLog,
  eq,
  externalScorers,
  guardrailTrainedDetectors,
  sql,
  type Db,
  type GuardrailTrainedDetectorRow,
} from "@regulait/db";
import {
  isGuardrailScorerKind,
  putTrainedDetectorSchema,
  trainedDetectorKindSchema,
  trainedDetectorRelaxations,
  trainedScorerRequest,
  TRAINED_DETECTOR_COPY,
  TRAINED_DETECTOR_DEFAULTS,
  TRAINED_DETECTOR_KINDS,
  TRAINED_DETECTOR_PHASES,
  TRAINED_DETECTOR_SCORER_KIND,
  TRAINED_DETECTOR_TARGET,
  TRAINED_MAX_TEXT_CHARS,
  type GuardrailPhase,
  type TrainedCallOutcome,
  type TrainedCallPlan,
  type TrainedDetectorKind,
  type TrainedDetectorSetting,
} from "@regulait/shared";
// type-only: the runtime import is lazy (below), because external-scorers.js
// reaches guardrails.js through custom-providers.js, which imports this module
import type { ResolvedExternalScorer } from "./external-scorers.js";
import type { EgressResolver } from "./egress-guard.js";
import { CHANGED_CONCURRENTLY, requireRelaxStepUp } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// runtime configuration (set once by buildApp)
// ---------------------------------------------------------------------------

interface RuntimeDeps {
  dataKey: string | undefined;
  resolve?: EgressResolver | undefined;
  fetchImpl?: typeof fetch | undefined;
}

let runtimeDeps: RuntimeDeps = { dataKey: undefined };

/** buildApp passes the data key (to decrypt a scorer's secret) and, in tests,
 * the egress resolver and fetch. The enforcement sites then need nothing new. */
export function configureTrainedDetectorRuntime(deps: RuntimeDeps): void {
  runtimeDeps = deps;
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/** what a resolved policy carries: the enabled settings, and the scorers they
 * name, resolved on first use and shared by both phases of one dispatch */
export interface TrainedDetectorRuntime {
  settings: TrainedDetectorSetting[];
  scorers: () => Promise<Map<string, ResolvedExternalScorer>>;
}

function settingFromRow(row: GuardrailTrainedDetectorRow, scorerName: string | null): TrainedDetectorSetting {
  return {
    kind: row.kind,
    enabled: row.enabled,
    scorerName,
    mode: row.mode,
    threshold: row.threshold,
    onFailure: row.onFailure,
    timeoutMs: row.timeoutMs,
  };
}

/** The enabled detectors (one indexed read), or undefined when none is on —
 * the overwhelmingly common case, which then costs nothing more. */
export async function loadTrainedDetectorRuntime(db: Db): Promise<TrainedDetectorRuntime | undefined> {
  const rows = await db
    .select({ row: guardrailTrainedDetectors, scorerName: externalScorers.name })
    .from(guardrailTrainedDetectors)
    .leftJoin(externalScorers, eq(externalScorers.id, guardrailTrainedDetectors.scorerId))
    .where(eq(guardrailTrainedDetectors.enabled, true));
  if (rows.length === 0) return undefined;
  const settings = rows.map((r) => settingFromRow(r.row, r.scorerName ?? null));
  let pending: Promise<Map<string, ResolvedExternalScorer>> | null = null;
  return {
    settings,
    scorers: () => {
      pending ??= (async () => {
        const names = [...new Set(settings.map((s) => s.scorerName).filter((n): n is string => !!n))];
        const { resolveExternalScorersByName } = await import("./external-scorers.js");
        const { facts, resolved } = await resolveExternalScorersByName(db, runtimeDeps.dataKey, names, {
          ...(runtimeDeps.resolve ? { resolve: runtimeDeps.resolve } : {}),
          ...(runtimeDeps.fetchImpl ? { fetchImpl: runtimeDeps.fetchImpl } : {}),
        });
        // only an ENABLED (connection-tested), reachable scorer may be called
        const usable = new Map<string, ResolvedExternalScorer>();
        for (const f of facts) {
          const r = resolved.get(f.name);
          if (f.enabled && f.reachable && r) usable.set(f.name, r);
        }
        return usable;
      })().catch(() => new Map());
      return pending;
    },
  };
}

// ---------------------------------------------------------------------------
// the calls
// ---------------------------------------------------------------------------

/** Run the planned calls for one phase, in parallel. Never throws: every
 * failure is an `ok: false` outcome, which the pure merge turns into a
 * fail-closed `trained_unavailable` hit. */
export async function runTrainedCalls(
  runtime: TrainedDetectorRuntime,
  plans: readonly TrainedCallPlan[],
  phase: GuardrailPhase,
  text: string,
): Promise<TrainedCallOutcome[]> {
  if (plans.length === 0) return [];
  const scorers = await runtime.scorers();
  const { callExternalScorer } = await import("./external-scorers.js");
  return Promise.all(
    plans.map(async (plan): Promise<TrainedCallOutcome> => {
      const name = plan.setting.scorerName;
      const scorer = name ? scorers.get(name) : undefined;
      const kind = TRAINED_DETECTOR_SCORER_KIND[plan.kind];
      if (!scorer || !(scorer.row.scorerKinds as string[]).includes(kind) || text.length > TRAINED_MAX_TEXT_CHARS) {
        return { plan, ok: false };
      }
      try {
        const verdict = await callExternalScorer(scorer, trainedScorerRequest(plan.kind, phase, text), {
          timeoutMs: plan.setting.timeoutMs,
        });
        return { plan, ok: true, verdict };
      } catch {
        // deliberately unlogged: the message can carry the scorer's reply body
        return { plan, ok: false };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// admin routes — admin-only by the global gate (none in NON_ADMIN_ROUTES)
// ---------------------------------------------------------------------------

/** advisory lock for the per-kind PUT, whose step-up rests on the stored row */
const TRAINED_DETECTOR_LOCK_KEY = 6_000_000_220;

function publicSetting(kind: TrainedDetectorKind, row: GuardrailTrainedDetectorRow | undefined, scorerName: string | null) {
  return {
    kind,
    label: TRAINED_DETECTOR_COPY[kind].label,
    summary: TRAINED_DETECTOR_COPY[kind].summary,
    reportsAs: TRAINED_DETECTOR_TARGET[kind],
    phases: TRAINED_DETECTOR_PHASES[kind],
    scorerKind: TRAINED_DETECTOR_SCORER_KIND[kind],
    enabled: row?.enabled ?? false,
    scorerId: row?.scorerId ?? null,
    scorerName,
    mode: row?.mode ?? TRAINED_DETECTOR_DEFAULTS.mode,
    threshold: row?.threshold ?? TRAINED_DETECTOR_DEFAULTS.threshold,
    onFailure: row?.onFailure ?? TRAINED_DETECTOR_DEFAULTS.onFailure,
    timeoutMs: row?.timeoutMs ?? TRAINED_DETECTOR_DEFAULTS.timeoutMs,
    updatedAt: row?.updatedAt ?? null,
  };
}

export function registerTrainedDetectorRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/guardrails/trained-detectors", async () => {
    const [rows, scorers] = await Promise.all([
      db.select().from(guardrailTrainedDetectors),
      db
        .select({
          id: externalScorers.id,
          name: externalScorers.name,
          enabled: externalScorers.enabled,
          scorerKinds: externalScorers.scorerKinds,
        })
        .from(externalScorers),
    ]);
    const nameOf = new Map(scorers.map((s) => [s.id, s.name]));
    return {
      detectors: TRAINED_DETECTOR_KINDS.map((kind) => {
        const row = rows.find((r) => r.kind === kind);
        return publicSetting(kind, row, row?.scorerId ? (nameOf.get(row.scorerId) ?? null) : null);
      }),
      // the scorers that claim at least one guardrail kind: the choices offered
      scorers: scorers
        .map((s) => ({ ...s, scorerKinds: ((s.scorerKinds as string[]) ?? []).filter(isGuardrailScorerKind) }))
        .filter((s) => s.scorerKinds.length > 0),
    };
  });

  app.put("/v1/guardrails/trained-detectors/:kind", async (req, reply) => {
    const kind = trainedDetectorKindSchema.parse((req.params as { kind?: unknown }).kind);
    const body = putTrainedDetectorSchema.parse(req.body);
    const actor = req.authCtx.userId ?? null;

    const [before] = await db.select().from(guardrailTrainedDetectors).where(eq(guardrailTrainedDetectors.kind, kind));
    const next = {
      enabled: body.enabled,
      scorerId: body.scorerId !== undefined ? body.scorerId : (before?.scorerId ?? null),
      mode: body.mode ?? before?.mode ?? TRAINED_DETECTOR_DEFAULTS.mode,
      threshold: body.threshold ?? before?.threshold ?? TRAINED_DETECTOR_DEFAULTS.threshold,
      onFailure: body.onFailure ?? before?.onFailure ?? TRAINED_DETECTOR_DEFAULTS.onFailure,
      timeoutMs: body.timeoutMs ?? before?.timeoutMs ?? TRAINED_DETECTOR_DEFAULTS.timeoutMs,
    };

    // turning one on needs an enabled (connection-tested) scorer claiming the kind
    let scorerName: string | null = null;
    if (next.scorerId) {
      const [scorer] = await db.select().from(externalScorers).where(eq(externalScorers.id, next.scorerId));
      if (!scorer) return reply.status(404).send({ error: "unknown_external_scorer" });
      scorerName = scorer.name;
      if (next.enabled) {
        const claim = TRAINED_DETECTOR_SCORER_KIND[kind];
        if (!(scorer.scorerKinds as string[]).includes(claim)) {
          return reply.status(422).send({
            error: "external_scorer_kind_mismatch",
            detail: `scorer '${scorer.name}' does not claim '${claim}' — add the kind on the External scorers page first`,
          });
        }
        if (!scorer.enabled) {
          return reply.status(409).send({
            error: "external_scorer_disabled",
            detail: `scorer '${scorer.name}' must pass its connection test and be enabled first`,
          });
        }
      }
    } else if (next.enabled) {
      return reply.status(422).send({ error: "scorer_required", detail: "choose a scoring service before turning this detector on" });
    }

    // ADR-0180: every loosening is a settings_relax step-up, bound to its values
    const relaxedFields = trainedDetectorRelaxations(before ?? null, next);
    const relaxed: Record<string, unknown> = {};
    for (const f of relaxedFields) relaxed[`trainedDetectors.${kind}.${f}`] = next[f as keyof typeof next];
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;

    const saved = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(${TRAINED_DETECTOR_LOCK_KEY}::bigint)`);
      const [now] = await tx.select().from(guardrailTrainedDetectors).where(eq(guardrailTrainedDetectors.kind, kind));
      // the step-up was decided on `before`; a row that moved since is refused, never overwritten
      if (JSON.stringify(now ?? null) !== JSON.stringify(before ?? null)) return null;
      const values = { ...next, updatedByUserId: actor, updatedAt: new Date() };
      const [row] = await tx
        .insert(guardrailTrainedDetectors)
        .values({ kind, ...values })
        .onConflictDoUpdate({ target: guardrailTrainedDetectors.kind, set: values })
        .returning();
      await tx.insert(auditLog).values({
        userId: actor ?? NIL_UUID,
        objectType: "org_settings",
        objectId: null,
        detail: {
          phase: "guardrail-config",
          trainedDetector: {
            kind,
            before: before
              ? { enabled: before.enabled, scorerId: before.scorerId, mode: before.mode, threshold: before.threshold, onFailure: before.onFailure, timeoutMs: before.timeoutMs }
              : null,
            after: next,
            relaxed: relaxedFields,
          },
        },
        effect: "allow",
        ruleId: "guardrail-trained-detector-updated",
        ruleChain: [],
        reason:
          `trained detector '${kind}' ${next.enabled ? `on (scorer '${scorerName}', mode ${next.mode}, threshold ${next.threshold}, ` +
          `${next.onFailure === "block" ? "fails closed" : "falls back to the heuristic on failure"})` : "off"}` +
          (relaxedFields.length ? ` — relaxed: ${relaxedFields.join(", ")} (step-up verified)` : ""),
      });
      return row!;
    });
    if (!saved) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return publicSetting(kind, saved, scorerName);
  });
}
