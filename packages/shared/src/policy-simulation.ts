/**
 * ADR-0059 — POLICY SIMULATION / BLAST-RADIUS PREVIEW's pure half: the replay
 * classifier, the fidelity analysis, the entitlement-scope decision, and the
 * blast-radius summary. No I/O, no clock, no db, no Cedar.
 *
 * THE THING THIS MODULE EXISTS TO MAKE UNFAKEABLE
 *
 *   A blast-radius preview is only useful if it is NAMED. "12% of traffic"
 *   without saying whose is not a preview — it is a statistic. So the summary
 *   below is built from the concrete flipped decisions and carries the user
 *   ids, the project ids, the tool names and a sample of the specific calls.
 *   A caller cannot get a number out of this module without also getting the
 *   rows it was computed from.
 *
 * ABAC CANNOT GRANT, SO ONE BUCKET IS STRUCTURALLY ALWAYS EMPTY
 *
 *   ADR-0040 is explicit that a Cedar `permit` is not an allow — the policy set
 *   can only ever SUBTRACT from what RBAC already permitted. A simulation of a
 *   proposed ABAC policy version therefore cannot produce a `newly_allowed`
 *   row, ever. The bucket is reported anyway, always zero, with that reason
 *   stated: silently omitting it would make the output look like it had
 *   searched for newly-allowed calls and found none.
 *
 * REPLAY FIDELITY IS BOUNDED AND SAID OUT LOUD
 *
 *   `audit_log` records the decision, not the whole decision INPUT: it carries
 *   no call arguments, no decision-time rate counters and no project
 *   attribution. So a candidate policy that keys on any of those cannot be
 *   replayed exactly, and every such row is counted as INDETERMINATE rather
 *   than quietly guessed at. `analyzeReplayFidelity` reads the candidate's own
 *   source to decide which of those it depends on — the caller never asserts
 *   its own fidelity.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export const POLICY_SIMULATION_BUCKETS = [
  "newly_denied",
  "newly_approval_required",
  "newly_allowed",
  "unchanged",
  "indeterminate",
] as const;
export type PolicySimulationBucket = (typeof POLICY_SIMULATION_BUCKETS)[number];

/** what the gateway recorded at the time */
export type RecordedEffect = "allow" | "deny" | "require_approval";
/** what the CANDIDATE policy alone says. `null` = could not be evaluated. */
export type CandidateEffect = "permit" | "forbid" | "require_approval" | null;

/**
 * THE CLASSIFIER. Pure, total, and exhaustively testable — this is the whole
 * "what would have been decided differently" question reduced to one function.
 *
 * The asymmetry is deliberate and is ADR-0040's, not this ADR's: a candidate
 * `permit` never flips anything, because ABAC is subtractive. Only a
 * `forbid`/`require_approval` landing on a call that was ALLOWED changes the
 * world.
 */
export function classifyReplay(input: {
  recorded: RecordedEffect;
  candidate: CandidateEffect;
}): PolicySimulationBucket {
  if (input.candidate === null) return "indeterminate";
  if (input.candidate === "permit") return "unchanged";
  if (input.recorded !== "allow") return "unchanged";
  return input.candidate === "forbid" ? "newly_denied" : "newly_approval_required";
}

// ---------------------------------------------------------------------------
// Fidelity
// ---------------------------------------------------------------------------

/**
 * Attributes a candidate policy can reference that the recorded history cannot
 * faithfully reproduce, each with the honest reason. Keyed by the attribute
 * path as it appears in Cedar source.
 */
export const UNREPLAYABLE_ATTRIBUTES: ReadonlyArray<{ needle: string; why: string }> = [
  {
    needle: "rateLimitUsagePct",
    why: "audit_log does not store the decision-time rate-limit counters, so a policy keyed on rate consumption cannot be re-decided exactly",
  },
  {
    needle: "dataSensitivity",
    why: "the project attribution of a historical tool call is reconstructed from the usage ledger, not recorded on the audit row, so a policy keyed on the project's compliance classification is best-effort",
  },
  {
    needle: "classifications",
    why: "same as dataSensitivity: the classification set follows the project, and the project is reconstructed rather than recorded",
  },
  {
    needle: "deployModes",
    why: "the deploy context is derived from the project's IN-FLIGHT workflow instances, which is a property of NOW rather than of the moment the call was made",
  },
  {
    needle: "environments",
    why: "same as deployModes: derived from in-flight work, so it reflects today's state, not the state at decision time",
  },
  {
    needle: "sessionOrigin",
    why: "the session facts behind a historical call are not recorded on the audit row; replay evaluates the honest 'unknown' default",
  },
  {
    needle: "mfaCompleted",
    why: "the authentication strength of a historical session is not recorded on the audit row; replay evaluates the honest 'false' default",
  },
];

export interface ReplayFidelity {
  /** true when nothing the candidate reads is un-replayable */
  exact: boolean;
  /** the attribute paths that make it inexact, with the reason for each */
  caveats: Array<{ attribute: string; why: string }>;
}

/**
 * Decide the fidelity of a replay FROM THE CANDIDATE'S OWN SOURCE. The caller
 * never gets to assert "this one is exact" — if the policy text mentions an
 * attribute the audit trail cannot reproduce, the run is flagged, and the flag
 * rides on the stored result rather than living in a doc.
 */
export function analyzeReplayFidelity(source: string): ReplayFidelity {
  const caveats = UNREPLAYABLE_ATTRIBUTES.filter((a) => source.includes(a.needle)).map((a) => ({
    attribute: a.needle,
    why: a.why,
  }));
  return { exact: caveats.length === 0, caveats };
}

export const REPLAY_FIDELITY_DISCLOSURE =
  "A dry run re-decides RECORDED decisions under a proposed policy version. It executes nothing: no " +
  "dispatch, no upstream call, no approvals row, no rate counter, no change to the active policy. " +
  "Replay is EXACT for entitlement and approval flips, because audit_log records the user, the server, " +
  "the tool and the decision. It is NOT exact for anything keyed on call arguments, decision-time rate " +
  "counters, or session facts — none of which the audit trail stores — and every such run says so " +
  "instead of smoothing it over. A simulation is a preview of the recorded past, never a promise about " +
  "future traffic.";

export const ABAC_CANNOT_GRANT_NOTE =
  "`newly_allowed` is structurally always zero for an ABAC candidate: a Cedar 'permit' means 'nothing " +
  "forbade this', never a grant (ADR-0040). The bucket is reported rather than hidden so the zero reads " +
  "as a property of the model instead of an absence of evidence.";

// ---------------------------------------------------------------------------
// Entitlement scope (the ADR-0047 discipline)
// ---------------------------------------------------------------------------

export interface PolicySimulationScopeInput {
  isAdmin: boolean;
  callerUserId: string | null;
  /** every user id the caller can see: their teammates plus themselves */
  visibleUserIds: readonly string[];
  /** an explicit narrowing the caller asked for */
  requestedUserIds?: readonly string[] | null | undefined;
}

export interface PolicySimulationScopeDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
  /**
   * The EXACT user ids whose recorded history may be replayed. `null` means
   * org-wide and is only ever produced for an admin. `[]` with `allowed:false`
   * means the caller may replay nothing.
   */
  userIds: string[] | null;
}

/**
 * NEVER EXCEEDS THE CALLER'S OWN VISIBILITY. A blast-radius preview reads other
 * people's traffic by construction — who called which tool, when — so without
 * this it would be a very convenient way to read another team's activity under
 * the cover of a policy question. Two refusals and one narrowing, exactly the
 * shape ADR-0047 gave report generation:
 *
 *  - an admin gets org-wide, or precisely the ids they asked for;
 *  - a non-admin asking for ids outside their teams is REFUSED (not silently
 *    narrowed — a silent narrowing would let someone probe membership by
 *    watching the counts move);
 *  - a non-admin who asks for nothing in particular gets their own teams.
 */
export function resolvePolicySimulationScope(
  input: PolicySimulationScopeInput,
): PolicySimulationScopeDecision {
  const requested = input.requestedUserIds ?? null;
  if (input.isAdmin) {
    return {
      allowed: true,
      ruleId: "policy-simulation-scope-org",
      reason:
        requested && requested.length > 0
          ? `admin simulation narrowed to ${requested.length} named user(s)`
          : "admin simulation over the whole recorded history — an org-wide blast radius",
      userIds: requested && requested.length > 0 ? [...new Set(requested)] : null,
    };
  }
  if (!input.callerUserId) {
    return {
      allowed: false,
      ruleId: "policy-simulation-denied-no-identity",
      reason:
        "the bootstrap token has no identity, so there is no visibility to scope a blast radius to",
      userIds: [],
    };
  }
  const visible = new Set([...input.visibleUserIds, input.callerUserId]);
  if (requested && requested.length > 0) {
    const outside = requested.filter((u) => !visible.has(u));
    if (outside.length > 0) {
      return {
        allowed: false,
        ruleId: "policy-simulation-denied-outside-scope",
        reason:
          `simulation refused: ${outside.length} of the ${requested.length} requested subject(s) are outside ` +
          "the caller's team visibility, and a blast radius must never become a way to read another team's traffic",
        userIds: [],
      };
    }
    return {
      allowed: true,
      ruleId: "policy-simulation-scope-requested",
      reason: `simulation narrowed to ${requested.length} named user(s), all within the caller's visibility`,
      userIds: [...new Set(requested)],
    };
  }
  return {
    allowed: true,
    ruleId: "policy-simulation-scope-team",
    reason: `simulation scoped to the caller's own team visibility (${visible.size} subject(s))`,
    userIds: [...visible],
  };
}

// ---------------------------------------------------------------------------
// The blast radius
// ---------------------------------------------------------------------------

export interface ReplayedDecision {
  auditLogId: string;
  userId: string;
  userLabel?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  serverId: string;
  toolName: string;
  recorded: RecordedEffect;
  candidate: CandidateEffect;
  bucket: PolicySimulationBucket;
  /** the candidate policy that fired, when one did */
  policyId?: string | null;
  occurredAt: string;
}

export interface BlastRadius {
  considered: number;
  buckets: Record<PolicySimulationBucket, number>;
  /** every distinct user whose recorded calls would FLIP — named, not counted */
  affectedUsers: Array<{ userId: string; label: string | null; calls: number }>;
  affectedProjects: Array<{ projectId: string | null; name: string | null; calls: number }>;
  affectedTools: Array<{ serverId: string; toolName: string; calls: number }>;
  /** a bounded sample of the specific calls that would flip */
  samples: ReplayedDecision[];
  headline: string;
}

const FLIPPED: ReadonlySet<PolicySimulationBucket> = new Set([
  "newly_denied",
  "newly_approval_required",
  "newly_allowed",
]);

export function isFlip(bucket: PolicySimulationBucket): boolean {
  return FLIPPED.has(bucket);
}

/**
 * Fold the replayed decisions into a blast radius. The output is deliberately
 * NAMED at every level — users, projects, tools, and specific calls — because a
 * percentage without a name is not something an admin can act on before
 * committing a rule.
 */
export function summarizeBlastRadius(
  rows: readonly ReplayedDecision[],
  opts: { sampleLimit?: number; windowDays: number } = { windowDays: 30 },
): BlastRadius {
  const sampleLimit = opts.sampleLimit ?? 25;
  const buckets = Object.fromEntries(
    POLICY_SIMULATION_BUCKETS.map((b) => [b, 0]),
  ) as Record<PolicySimulationBucket, number>;
  for (const r of rows) buckets[r.bucket] += 1;

  const flips = rows.filter((r) => isFlip(r.bucket));
  const byUser = new Map<string, { label: string | null; calls: number }>();
  const byProject = new Map<string, { projectId: string | null; name: string | null; calls: number }>();
  const byTool = new Map<string, { serverId: string; toolName: string; calls: number }>();
  for (const f of flips) {
    const u = byUser.get(f.userId) ?? { label: f.userLabel ?? null, calls: 0 };
    u.calls += 1;
    if (!u.label && f.userLabel) u.label = f.userLabel;
    byUser.set(f.userId, u);

    const pk = f.projectId ?? "__unattributed__";
    const p = byProject.get(pk) ?? {
      projectId: f.projectId ?? null,
      name: f.projectName ?? null,
      calls: 0,
    };
    p.calls += 1;
    if (!p.name && f.projectName) p.name = f.projectName;
    byProject.set(pk, p);

    const tk = `${f.serverId}/${f.toolName}`;
    const t = byTool.get(tk) ?? { serverId: f.serverId, toolName: f.toolName, calls: 0 };
    t.calls += 1;
    byTool.set(tk, t);
  }

  const affectedUsers = [...byUser]
    .map(([userId, v]) => ({ userId, label: v.label, calls: v.calls }))
    .sort((a, b) => b.calls - a.calls || a.userId.localeCompare(b.userId));
  const affectedProjects = [...byProject.values()].sort(
    (a, b) => b.calls - a.calls || (a.projectId ?? "").localeCompare(b.projectId ?? ""),
  );
  const affectedTools = [...byTool.values()].sort(
    (a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName),
  );

  // sample across the flip buckets, newest first, bounded
  const samples = [...flips]
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
    .slice(0, sampleLimit);

  const headline = buildHeadline({
    buckets,
    users: affectedUsers.length,
    tools: affectedTools.length,
    projects: affectedProjects.length,
    considered: rows.length,
    windowDays: opts.windowDays,
  });

  return {
    considered: rows.length,
    buckets,
    affectedUsers,
    affectedProjects,
    affectedTools,
    samples,
    headline,
  };
}

/** the one sentence an admin can act on, or the honest "nothing would change" */
export function buildHeadline(input: {
  buckets: Record<PolicySimulationBucket, number>;
  users: number;
  tools: number;
  projects: number;
  considered: number;
  windowDays: number;
}): string {
  const { buckets } = input;
  const window = `the last ${input.windowDays} day(s)`;
  if (input.considered === 0) {
    return `no recorded calls in ${window} fell inside the simulated scope — this preview has nothing to say, which is not the same as "this change is safe"`;
  }
  const flips = buckets.newly_denied + buckets.newly_approval_required + buckets.newly_allowed;
  if (flips === 0) {
    const tail =
      buckets.indeterminate > 0
        ? `, though ${buckets.indeterminate} could not be replayed exactly (see the fidelity caveats)`
        : "";
    return `none of the ${input.considered} recorded call(s) in ${window} would have been decided differently${tail}`;
  }
  const parts: string[] = [];
  if (buckets.newly_denied > 0) parts.push(`BLOCKS ${buckets.newly_denied} call(s) that succeeded`);
  if (buckets.newly_approval_required > 0) {
    parts.push(`newly requires approval on ${buckets.newly_approval_required} call(s)`);
  }
  if (buckets.newly_allowed > 0) parts.push(`newly allows ${buckets.newly_allowed} call(s)`);
  const indeterminate =
    buckets.indeterminate > 0
      ? ` ${buckets.indeterminate} further call(s) could not be replayed exactly and are NOT counted above.`
      : "";
  return (
    `this change ${parts.join(", ")} across ${input.users} user(s), ${input.tools} tool(s) and ` +
    `${input.projects} project(s) over ${window} (${input.considered} recorded call(s) examined).${indeterminate}`
  );
}

// ---------------------------------------------------------------------------
// Write shapes
// ---------------------------------------------------------------------------

/** hard caps, so a preview can never become an unbounded table scan */
export const POLICY_SIMULATION_MAX_WINDOW_DAYS = 180;
export const POLICY_SIMULATION_MAX_ROWS = 20_000;
export const POLICY_SIMULATION_DEFAULT_WINDOW_DAYS = 30;
export const POLICY_SIMULATION_DEFAULT_ROW_CAP = 5_000;

export const startPolicySimulationSchema = z
  .object({
  /** the PROPOSED policy version — a simulation always targets a specific
   * immutable version (ADR-0048), never "the policy". ADR-0120 made it
   * optional: a simulation may instead name a `config_versions` row via
   * `ruleVersionId`. Exactly one, enforced below. */
  policyVersionId: z.string().uuid().optional(),
  /** ADR-0120 — the proposed APPROVAL RULE or RATE LIMIT version to preview */
  ruleVersionId: z.string().uuid().optional(),
  windowDays: z
    .number()
    .int()
    .min(1)
    .max(POLICY_SIMULATION_MAX_WINDOW_DAYS)
    .default(POLICY_SIMULATION_DEFAULT_WINDOW_DAYS),
  rowCap: z
    .number()
    .int()
    .min(1)
    .max(POLICY_SIMULATION_MAX_ROWS)
    .default(POLICY_SIMULATION_DEFAULT_ROW_CAP),
  /** narrow the replay to specific subjects; never widens the caller's scope */
  userIds: z.array(z.string().uuid()).max(500).optional(),
  note: z.string().max(2000).optional(),
  })
  // Exactly one candidate. Accepting both would leave it to the handler to pick
  // one silently, and a preview whose subject is ambiguous is worthless.
  .refine((b) => (b.policyVersionId ? 1 : 0) + (b.ruleVersionId ? 1 : 0) === 1, {
    message:
      "name exactly one candidate: policyVersionId (an ABAC policy version) or ruleVersionId (an approval-rule or rate-limit version)",
  });

export const policySimulationSettingsSchema = z.object({
  /**
   * ADR-0059 / ADR-0040's honest-risks note: activating a policy without ever
   * previewing its blast radius should be FRICTION. Off by default so an
   * existing deployment is unchanged; on, activation of a version with no
   * completed simulation is refused.
   */
  requirePreviewBeforeActivate: z.boolean().optional(),
  defaultWindowDays: z.number().int().min(1).max(POLICY_SIMULATION_MAX_WINDOW_DAYS).optional(),
  defaultRowCap: z.number().int().min(1).max(POLICY_SIMULATION_MAX_ROWS).optional(),
});
