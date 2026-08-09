/**
 * ADR-0073 — WIRING THE RULES ENGINE THROUGH `config_versions`.
 *
 * ADR-0048 built the version substrate and wired ONE artifact type through it
 * (`agent_system_prompt`, at the dispatch core). For the four restriction /
 * compliance types it shipped storage only: versions could be created,
 * activated and rolled back while `governed-evaluate.ts` and
 * `projects.ts:profilesForTags` went on reading `approval_rules`,
 * `rate_limits`, `data_scope_rules` and `compliance_profiles` directly. §2's
 * shadow canary for rules consequently evaluated nothing at all.
 *
 * THIS FILE IS THE MISSING HALF, and it is deliberately the SAME SHAPE as the
 * prompt path rather than a second mechanism:
 *
 *   prompt path                        rule path (here)
 *   -----------                        ----------------
 *   resolveAgentPromptVersion          resolveRuleVersions
 *   falls back to agents.system_prompt  falls back to the rule's own table row
 *     when no version rows exist          when no version rows exist
 *   agents.system_prompt is a           the rule table row is a read-model,
 *     read-model kept in sync by          kept in sync by the same
 *     activateVersion                     activateVersion
 *   the canary SERVES                   the canary is EVALUATED IN PARALLEL
 *                                         and never serves
 *
 * THREE INVARIANTS THIS FILE EXISTS TO HOLD
 *
 *  1. THE SHADOW NEVER TOUCHES THE SERVED DECISION. The served decision is
 *     computed to completion first, from the ACTIVE bodies alone. The candidate
 *     pass runs afterwards, inside a try/catch whose catch writes a `failed`
 *     observation and returns. There is no code path on which the candidate's
 *     result is read by anything that produces the answer — not the effect, not
 *     the ruleId, not the approval queue, not spend.
 *
 *  2. AN UNRESOLVABLE ACTIVE VERSION FAILS CLOSED. If an artifact has version
 *     rows but NONE of them is active, there is no authoritative statement of
 *     what that rule says. A restriction that is silently skipped is a
 *     WIDENING, so the call is DENIED with the reason named. "No version found,
 *     therefore allow" does not exist here.
 *
 *  3. RESOLUTION IS NOT AN N+1. Every artifact of every type needed by one
 *     evaluation is resolved in ONE indexed query against
 *     `config_versions_artifact_status_idx`, keyed on the ids already in hand
 *     from the rule pre-filter. An install with no rule versions at all pays
 *     ZERO extra queries, because the id list is only queried when there are
 *     rule rows and the query returns nothing when nobody has versioned them.
 */
import {
  and,
  configCanaryObservations,
  configVersions,
  eq,
  inArray,
  type ConfigArtifactType,
  type ConfigVersionRow,
  type Db,
} from "@regulait/db";
import {
  applyRuleBody,
  canaryIsShadowEvaluated,
  resolveForShadow,
  type ShadowResolution,
} from "@regulait/shared";

/** key for the per-artifact version map */
const key = (t: ConfigArtifactType, id: string) => `${t}:${id}`;

/**
 * Version rows exist for an artifact but none of them is ACTIVE. Thrown by the
 * resolution paths that have no decision object to fail into (the §8.3
 * compliance cascade). `app.ts`'s error handler maps it to a real 409 with the
 * reason stated — an honest refusal, never a call that proceeds with a
 * compliance profile silently missing.
 */
export class ConfigVersionUnresolvableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigVersionUnresolvableError";
  }
}

/**
 * ONE query for every artifact this evaluation touches, across every type.
 * Returns an empty map — and issues NO query — when there is nothing to resolve.
 */
export async function loadVersionsForArtifacts(
  db: Db,
  artifactTypes: readonly ConfigArtifactType[],
  artifactIds: readonly string[],
): Promise<Map<string, ConfigVersionRow[]>> {
  const out = new Map<string, ConfigVersionRow[]>();
  if (artifactTypes.length === 0 || artifactIds.length === 0) return out;
  const rows = await db
    .select()
    .from(configVersions)
    .where(
      and(
        inArray(configVersions.artifactType, [...artifactTypes]),
        inArray(configVersions.artifactId, [...artifactIds]),
      ),
    );
  for (const r of rows) {
    const k = key(r.artifactType, r.artifactId);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export interface CandidateNote {
  artifactType: ConfigArtifactType;
  artifactId: string;
  candidateVersionId: string;
  candidateVersion: number;
  activeVersionId: string | null;
  activeVersion: number | null;
  canaryPct: number | null;
  bucket: number | null;
}

export interface RuleResolution<T> {
  /** the rows that ENFORCE — the active version overlaid onto each row */
  served: T[];
  /**
   * the rows a shadow pass should use — identical to `served` except for the
   * artifacts with a sampled candidate, which carry the CANDIDATE body. Null
   * when no artifact of this type has a sampled candidate, which is the signal
   * to skip the shadow pass entirely.
   */
  candidate: T[] | null;
  /** one per artifact whose candidate was sampled in — the provenance a stored
   * observation needs */
  notes: CandidateNote[];
  /** artifacts with version rows but no active version — the fail-closed set */
  unresolvable: Array<{ artifactId: string; reason: string }>;
}

/**
 * Overlay the resolved versions onto a set of already-loaded rule rows.
 *
 * `stableKey` is the same deterministic bucketing key ADR-0048 §2 defines. For
 * a tool-call evaluation there is no run or conversation, so it is the calling
 * user — which is also what makes shadow sampling STICKY per user rather than a
 * scatter of unrelated single decisions.
 */
export function applyRuleVersions<T extends { id: string }>(
  artifactType: ConfigArtifactType,
  rows: T[],
  versions: Map<string, ConfigVersionRow[]>,
  stableKey: string,
): RuleResolution<T> {
  const served: T[] = [];
  const candidate: T[] = [];
  const notes: CandidateNote[] = [];
  const unresolvable: Array<{ artifactId: string; reason: string }> = [];
  let anyCandidate = false;

  for (const row of rows) {
    const stored = versions.get(key(artifactType, row.id)) ?? [];
    const res: ShadowResolution = resolveForShadow({
      artifactType,
      artifactId: row.id,
      versions: stored.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        canaryPct: v.canaryPct,
        body: v.body,
      })),
      stableKey,
    });

    if (res.unresolvable) {
      unresolvable.push({ artifactId: row.id, reason: res.unresolvable });
      // still enforce the table row in the meantime: the caller turns
      // `unresolvable` into a DENY, and a row that also silently vanished from
      // the served set would make the deny depend on the deny path being
      // reached rather than on the rule.
      served.push(row);
      candidate.push(row);
      continue;
    }

    const servedRow = res.served ? applyRuleBody(artifactType, row, res.served.body) : row;
    served.push(servedRow);

    if (res.candidate) {
      anyCandidate = true;
      candidate.push(applyRuleBody(artifactType, row, res.candidate.body));
      notes.push({
        artifactType,
        artifactId: row.id,
        candidateVersionId: res.candidate.id,
        candidateVersion: res.candidate.version,
        activeVersionId: res.served?.id ?? null,
        activeVersion: res.served?.version ?? null,
        canaryPct: res.candidate.canaryPct,
        bucket: res.bucket,
      });
    } else {
      candidate.push(servedRow);
    }
  }

  return { served, candidate: anyCandidate ? candidate : null, notes, unresolvable };
}

/**
 * Load + overlay in one step, for callers that hold a single artifact type.
 * `governedEvaluate` does NOT use this — it batches all three rule types into
 * one query — but `profilesForTags` does.
 */
export async function resolveRuleVersions<T extends { id: string }>(
  db: Db,
  artifactType: ConfigArtifactType,
  rows: T[],
  stableKey: string,
): Promise<RuleResolution<T>> {
  if (rows.length === 0) {
    return { served: [], candidate: null, notes: [], unresolvable: [] };
  }
  const versions = await loadVersionsForArtifacts(
    db,
    [artifactType],
    rows.map((r) => r.id),
  );
  return applyRuleVersions(artifactType, rows, versions, stableKey);
}

// ---------------------------------------------------------------------------
// Recording what the candidate WOULD have decided
// ---------------------------------------------------------------------------

export interface ObservationOutcome {
  servedEffect: string;
  servedRuleId: string;
  servedReason: string;
  candidateEffect: string;
  candidateRuleId: string;
  candidateReason: string;
}

export interface ObservationContext {
  userId?: string | null;
  serverId?: string | null;
  toolName?: string | null;
  projectId?: string | null;
  detail?: Record<string, unknown> | null;
}

/**
 * Write one observation per candidate artifact that took part in this
 * evaluation. Divergence is judged on the DECISION, not on the bodies: two
 * different rule texts that produce the same allow are not a divergence an
 * operator needs to look at, and the same text producing a different effect
 * (because a limit's window moved, say) is.
 *
 * NEVER THROWS. It is called after the served decision has already been
 * returned to the caller's local variable; an exception escaping here would
 * turn a measurement into an outage, which is the exact failure mode the ADR
 * forbids. A write failure is swallowed after being logged by the caller's
 * catch — there is nothing safe left to do with it at this point.
 */
export async function recordCanaryObservations(
  db: Db,
  notes: CandidateNote[],
  outcome: ObservationOutcome,
  ctx: ObservationContext,
): Promise<void> {
  if (notes.length === 0) return;
  const diverged =
    outcome.servedEffect !== outcome.candidateEffect ||
    outcome.servedRuleId !== outcome.candidateRuleId;
  await db.insert(configCanaryObservations).values(
    notes.map((n) => ({
      artifactType: n.artifactType,
      artifactId: n.artifactId,
      candidateVersionId: n.candidateVersionId,
      candidateVersion: n.candidateVersion,
      activeVersionId: n.activeVersionId,
      activeVersion: n.activeVersion,
      canaryPct: n.canaryPct,
      bucket: n.bucket,
      userId: ctx.userId ?? null,
      serverId: ctx.serverId ?? null,
      toolName: ctx.toolName ?? null,
      projectId: ctx.projectId ?? null,
      servedEffect: outcome.servedEffect,
      servedRuleId: outcome.servedRuleId,
      servedReason: outcome.servedReason,
      candidateEffect: outcome.candidateEffect,
      candidateRuleId: outcome.candidateRuleId,
      candidateReason: outcome.candidateReason,
      diverged,
      failed: false,
      failureReason: null,
      detail: ctx.detail ?? null,
    })),
  );
}

/**
 * The candidate evaluation THREW. Record it — a canary whose failures are
 * swallowed reports "no divergences" while measuring nothing, which is strictly
 * worse than having no canary. The served decision is untouched by
 * construction: it was computed before the shadow pass began.
 */
export async function recordCanaryFailure(
  db: Db,
  notes: CandidateNote[],
  failureReason: string,
  ctx: ObservationContext,
  served?: { effect: string; ruleId: string; reason: string } | null,
): Promise<void> {
  if (notes.length === 0) return;
  await db.insert(configCanaryObservations).values(
    notes.map((n) => ({
      artifactType: n.artifactType,
      artifactId: n.artifactId,
      candidateVersionId: n.candidateVersionId,
      candidateVersion: n.candidateVersion,
      activeVersionId: n.activeVersionId,
      activeVersion: n.activeVersion,
      canaryPct: n.canaryPct,
      bucket: n.bucket,
      userId: ctx.userId ?? null,
      serverId: ctx.serverId ?? null,
      toolName: ctx.toolName ?? null,
      projectId: ctx.projectId ?? null,
      servedEffect: served?.effect ?? null,
      servedRuleId: served?.ruleId ?? null,
      servedReason: served?.reason ?? null,
      candidateEffect: null,
      candidateRuleId: null,
      candidateReason: null,
      diverged: false,
      failed: true,
      failureReason,
      detail: ctx.detail ?? null,
    })),
  );
}

export { canaryIsShadowEvaluated };
