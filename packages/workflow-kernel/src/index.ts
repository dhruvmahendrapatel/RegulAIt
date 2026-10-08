import { z } from "zod";

/** invalid event for the instance's current state — a client error, not a crash */
export class WorkflowStateError extends Error {}
/** templates cannot be merged (same stage id, conflicting config) */
export class MergeConflictError extends Error {}

// ---------------------------------------------------------------------------
// Template definition (§3): declarative, version-controllable, validated here.
// Executable stage types in this slice: trigger, planning, artifact_generation,
// human_approval, automated_build, automated_check, git_operation. deployment/
// rollback are declared for forward-compat but rejected until integrations
// exist — a template must never promise a stage the engine can't run.
// ---------------------------------------------------------------------------

export const EXECUTABLE_STAGE_TYPES = [
  "trigger",
  "planning",
  "artifact_generation",
  "human_approval",
  "automated_build",
  "automated_check",
  "git_operation",
  // §2 the pipeline tail: a governed deploy (gated on a configured deploy target
  // and an optional condition, else a manual handoff) and a rollback that
  // reverses it. A post-deploy verify is an automated_check with
  // onFailure:"rollback" that routes straight to the rollback stage on failure.
  "deployment",
  "rollback",
] as const;

export const GIT_ACTIONS = ["create_branch", "open_pr", "merge"] as const;
export type GitAction = (typeof GIT_ACTIONS)[number];

export type StageType = (typeof EXECUTABLE_STAGE_TYPES)[number];

const stageSchema = z.object({
  id: z.string().min(1),
  type: z.enum(EXECUTABLE_STAGE_TYPES),
  /** human_approval: named approver user ids, or "requesting_user" */
  approvers: z.array(z.string().min(1)).min(1).optional(),
  /** human_approval (ADR-0027, deferred from ADR-0021): per-STAGE quorum
   * override — 'all' = every named approver must approve; 'any' = the first
   * approval advances (remaining pending rows are superseded). Absent = the
   * org-wide approvalQuorum default ('all' unless the admin changed it). Any
   * other value is rejected LOUDLY at template validation (pre-ADR-0027 the
   * object schema silently stripped an unknown quorum key). */
  quorum: z.enum(["all", "any"]).optional(),
  /** artifact_generation: logical name of the produced artifact */
  output: z.string().min(1).optional(),
  /** automated_build: artifact (by output name) the build is scope-locked to */
  scope: z.string().min(1).optional(),
  /** automated_build §8 nesting: an orchestration task graph executed as this
   * stage. Opaque here — the GATEWAY validates it against the orchestration
   * kernel at template creation (a template must never promise a graph the
   * engine can't run). Present = the stage completes via its nested run, never
   * via a human trigger. */
  run: z.unknown().optional(),
  /** automated_check: named checks. Present (non-empty) = the stage completes
   * via the gateway's check executor, never via a human trigger; absent = the
   * stage awaits an explicit human trigger (nothing to run). */
  checks: z.array(z.string().min(1)).optional(),
  /** automated_check (AER-047 / PENDING L1): what a named check with NO
   * reported result means. Absent/false — the default — it is PENDING: the
   * instance waits at awaiting_execution until a result is reported (a real
   * CI posts to POST .../checks), and never advances on silence. `true` is the
   * explicit, per-template opt-in to the old offline behaviour: an unreported
   * check passes, but the result is labelled `autoPassed: true` ("auto-passed —
   * no report (offline mode)") in the instance context, the audit trail, the
   * stage rail and the approval view. The gateway honours the opt-in only in a
   * process that positively declares offline mode (REGULAIT_OFFLINE_CHECKS=1)
   * and never on a box that shows a sign of being deployed (REGULAIT_DEPLOY_MODE
   * / REGULAIT_HSTS) — it FAILS CLOSED, so a production configuration cannot
   * pass a check nobody ran. Only valid on an automated_check stage with named
   * checks — refused loudly elsewhere. */
  offlineAutoPass: z.boolean().optional(),
  /** git_operation: which operation this stage performs */
  action: z.enum(GIT_ACTIONS).optional(),
  /** git_operation: name of the registered git connection to use */
  connection: z.string().min(1).optional(),
  /** git_operation: owner/repo the operation targets */
  repo: z.string().min(1).optional(),
  /** git_operation open_pr/create_branch: base branch (default main) */
  base: z.string().min(1).optional(),
  /** git_operation create_branch: branch name prefix (default regulait) */
  branchPrefix: z.string().min(1).optional(),
  /** git_operation merge: merge strategy (default merge) */
  strategy: z.enum(["merge", "squash", "rebase"]).optional(),
  /** deployment/rollback: the registered deploy target to act on (reuses the
   * `connection` field name; validated to exist at the gateway). */
  // (connection is declared above and shared with git_operation)
  /** deployment: the target environment being deployed to (audit + condition). */
  environment: z.string().min(1).optional(),
  /** deployment: an optional gate — the deploy runs only if the change's field
   * matches; otherwise the stage parks at a manual handoff. Absent = always
   * deploy (subject only to the deploy target existing). */
  condition: z
    .object({ field: z.enum(["environment", "changeType"]), equals: z.string().min(1) })
    .optional(),
  /** automated_check: what a FAILED required check does — "block" (default:
   * park at blocked_on_check pending remediation) or "rollback" (route straight
   * to `rollbackStageId`, the post-deploy self-heal path). */
  onFailure: z.enum(["block", "rollback"]).optional(),
  /** automated_check with onFailure:"rollback": the id of the rollback stage to
   * jump to when this check fails. */
  rollbackStageId: z.string().min(1).optional(),
  /** automated_check (ADR-0044): bind a NAMED CHECK to an evaluation dataset.
   * The gateway runs the pinned dataset against the named agent through the
   * governed dispatch core and resolves the check from the result — a score
   * that regresses past `tolerance` against the stored baseline makes the check
   * FAIL, which routes through this stage's existing onFailure path (block or
   * rollback) like any other failed check. Deliberately NOT a new stage type:
   * a quality gate is an automated check, and inventing a second failure
   * mechanism beside `check_failed` would give the pipeline two ways to say no.
   *
   * Every entry's `check` must also appear in `checks` — a binding for a check
   * the stage does not declare would silently never run. */
  evals: z
    .array(
      z.object({
        /** the declared check this eval decides */
        check: z.string().min(1),
        /** dataset NAME (versions are pinned by `version`, else latest) */
        dataset: z.string().min(1),
        version: z.number().int().positive().optional(),
        /** the agent under test, by registry NAME */
        agent: z.string().min(1),
        /** judge agent NAME, for llm_as_judge cases */
        judgeAgent: z.string().min(1).optional(),
        /** how far the mean score may fall below the baseline before the check
         * fails. 0 = any drop is a regression. Default 0.05. */
        tolerance: z.number().min(0).max(1).optional(),
        /** absolute floors, independent of any baseline */
        minScore: z.number().min(0).max(1).optional(),
        minPassRate: z.number().min(0).max(1).optional(),
        /** true = a missing baseline FAILS rather than standing as the first
         * reference. For a gate that must never pass un-compared. */
        requireBaseline: z.boolean().optional(),
      }),
    )
    .optional(),
  /** automated_check (ADR-0187, batch 5): bind a NAMED CHECK to a sidecar
   * engine run. On stage entry the gateway starts the run as the instance
   * initiator on the instance's project (the same identity rule as an eval
   * binding); the check stays PENDING until the run ends, passes only when the
   * run completed with no failed or unknown item and at least one pass, and
   * FAILS when the run fails, times out, is cancelled or did not run. Never
   * reported (POST .../checks refuses it) and never auto-passed. */
  engines: z
    .array(
      z.object({
        check: z.string().min(1),
        /** the engine id (ADR-0187 manifest); an artifact-only engine (modelscan) cannot bind an agent check (PR #203 review [14]) */
        engine: z.enum(["promptfoo", "garak"]),
        /** the agent under test, by registry NAME */
        agent: z.string().min(1),
        /** judge agent NAME, behind the gateway */
        judgeAgent: z.string().min(1).optional(),
        /** the engine's named plugin/probe sets */
        sets: z.array(z.string().min(1).max(100)).min(1).max(50),
        params: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
        trials: z.number().int().min(1).max(25).optional(),
        budgetUsd: z.number().positive().max(10_000).optional(),
      }),
    )
    .optional(),
});
export type Stage = z.infer<typeof stageSchema>;

/** OPTIMIZATION §9: workflow-level bias for pillar 6's optimizer. Strictness
 * order (strictest last): cost-sensitive < standard < quality-sensitive. */
export const COST_SENSITIVITIES = ["cost-sensitive", "standard", "quality-sensitive"] as const;
export type CostSensitivityTag = (typeof COST_SENSITIVITIES)[number];
const STRICTNESS: Record<CostSensitivityTag, number> = {
  "cost-sensitive": 0,
  standard: 1,
  "quality-sensitive": 2,
};

export const workflowDefinitionSchema = z
  .object({
    workflow: z.string().min(1),
    /** §9 cost-sensitivity tag; absent = "standard" */
    costSensitivity: z.enum(COST_SENSITIVITIES).optional(),
    stages: z.array(stageSchema).min(1),
  })
  .superRefine((def, ctx) => {
    const ids = new Set<string>();
    for (const s of def.stages) {
      if (ids.has(s.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate stage id '${s.id}'` });
      }
      ids.add(s.id);
      if (s.type === "human_approval" && !s.approvers?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `human_approval stage '${s.id}' needs at least one approver`,
        });
      }
      // ADR-0027: quorum is a human_approval concern only — on any other
      // stage type it is a template bug, refused loudly (never stripped).
      if (s.quorum !== undefined && s.type !== "human_approval") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `stage '${s.id}' (${s.type}) cannot carry a quorum — only a human_approval stage can`,
        });
      }
      // AER-047: the auto-pass opt-in is a check-executor concern only. On any
      // other stage — or a check stage with nothing for the executor to run —
      // it would read as a promise the engine never keeps, so it is refused
      // loudly rather than silently ignored.
      if (
        s.offlineAutoPass !== undefined &&
        (s.type !== "automated_check" || (s.checks?.length ?? 0) === 0)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `stage '${s.id}' (${s.type}) cannot carry offlineAutoPass — only an automated_check stage with named checks can`,
        });
      }
      if (s.type === "artifact_generation" && !s.output) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `artifact_generation stage '${s.id}' needs an output name`,
        });
      }
      if (s.type === "automated_build" && s.scope) {
        const producers = def.stages.filter(
          (o) => o.type === "artifact_generation" && o.output === s.scope,
        );
        if (producers.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `build stage '${s.id}' is scoped to artifact '${s.scope}' no stage produces`,
          });
        }
      }
    }
    for (const s of def.stages) {
      if (s.type !== "git_operation") continue;
      if (!s.action || !s.connection || !s.repo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `git_operation stage '${s.id}' needs action, connection, and repo`,
        });
        continue;
      }
      const index = def.stages.indexOf(s);
      const earlier = def.stages.slice(0, index);
      if (
        s.action === "open_pr" &&
        !earlier.some((o) => o.type === "git_operation" && o.action === "create_branch")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `open_pr stage '${s.id}' needs an earlier create_branch stage`,
        });
      }
      if (
        s.action === "merge" &&
        !earlier.some((o) => o.type === "git_operation" && o.action === "open_pr")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `merge stage '${s.id}' needs an earlier open_pr stage`,
        });
      }
    }
    // §2 deploy / rollback / post-deploy-verify structural checks
    for (const s of def.stages) {
      if ((s.type === "deployment" || s.type === "rollback") && !s.connection) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${s.type} stage '${s.id}' needs a deploy target (connection)`,
        });
      }
      // ADR-0044: an eval binding is only meaningful on a check stage, and only
      // for a check that stage actually declares. Both mistakes are refused
      // LOUDLY at template validation rather than silently ignored at runtime —
      // a quality gate that quietly never runs is worse than no gate.
      if (s.evals?.length) {
        if (s.type !== "automated_check") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `stage '${s.id}' (${s.type}) cannot carry eval bindings — only an automated_check stage can`,
          });
        } else {
          const declared = new Set(s.checks ?? []);
          const seen = new Set<string>();
          for (const e of s.evals) {
            if (!declared.has(e.check)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `check stage '${s.id}' binds an eval to check '${e.check}', which the stage does not declare`,
              });
            }
            if (seen.has(e.check)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `check stage '${s.id}' binds check '${e.check}' to more than one eval dataset`,
              });
            }
            seen.add(e.check);
          }
        }
      }
      // ADR-0187: engine bindings follow the eval-binding rules, and one check is
      // decided by one thing (an eval OR an engine run, never both).
      if (s.engines?.length) {
        if (s.type !== "automated_check") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `stage '${s.id}' (${s.type}) cannot carry engine bindings — only an automated_check stage can`,
          });
        } else {
          const declared = new Set(s.checks ?? []);
          const evalBound = new Set((s.evals ?? []).map((e) => e.check));
          const seen = new Set<string>();
          for (const e of s.engines) {
            if (!declared.has(e.check)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `check stage '${s.id}' binds an engine to check '${e.check}', which the stage does not declare`,
              });
            }
            if (seen.has(e.check) || evalBound.has(e.check)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `check stage '${s.id}' binds check '${e.check}' more than once (an eval or engine binding each)`,
              });
            }
            seen.add(e.check);
          }
        }
      }
      if (s.type === "automated_check" && s.onFailure === "rollback") {
        if (!s.rollbackStageId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `check stage '${s.id}' has onFailure:rollback but no rollbackStageId`,
          });
        } else {
          const target = def.stages.find((o) => o.id === s.rollbackStageId);
          if (!target || target.type !== "rollback") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `check stage '${s.id}' rollbackStageId '${s.rollbackStageId}' is not a rollback stage`,
            });
          }
        }
      }
    }
    if (def.stages[0]!.type !== "trigger") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "first stage must be a trigger" });
    }
  });

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export function validateDefinition(raw: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Assignment rules (§4): which template(s) apply to a change, automatically.
// ---------------------------------------------------------------------------

export interface ChangeDescriptor {
  description: string;
  paths: string[];
  changeType: string;
  environment: string;
  /** ADR-0018 §4 dim: the target system the change lands on (e.g. a service or
   * repo). Absent = unconstrained by a rule's targetSystem condition. */
  targetSystem?: string;
  /** ADR-0018 §4 dim: the role NAMES the INITIATING user holds — resolved
   * SERVER-SIDE by the gateway (never client-supplied) and passed in so the
   * kernel stays subject-free. A rule's initiatorRole matches when it is one of
   * these. Absent/empty = the user holds no roles. */
  initiatorRoles?: string[];
  /** ADR-0018 addendum (ADR-0019) — the 6th and final dim: the data-sensitivity
   * markers of the change, resolved SERVER-SIDE by the gateway from the
   * attributed project's compliance classification tags (the same source the
   * §8.3 cascade reads) and passed in so the kernel stays subject-free. A
   * rule's dataSensitivity matches when it is one of these. Absent/empty = the
   * change carries no server-known sensitivity — a sensitivity-scoped rule
   * simply does not fire (no invented sensitivity). */
  dataSensitivities?: string[];
}

export interface AssignmentRule {
  id: string;
  templateId: string;
  /** glob-ish path pattern: '*' matches within a segment, '**' across segments */
  pathPattern: string | null;
  changeType: string | null;
  environment: string | null;
  /** ADR-0018 §4 dim: the change's target system this rule requires */
  targetSystem: string | null;
  /** ADR-0018 §4 dim: the role the initiating user must hold for this rule */
  initiatorRole: string | null;
  /** ADR-0018 addendum §4 dim: the data-sensitivity tag the change's project
   * must carry for this rule. Optional on the interface so a caller built
   * before the 6th dim (an older fixture) still type-checks and behaves as
   * unconstrained. */
  dataSensitivity?: string | null;
}

function pathMatches(pattern: string, path: string): boolean {
  const rx = new RegExp(
    "^" +
      pattern
        .split(/(\*\*|\*)/)
        .map((part) =>
          part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("") +
      "$",
  );
  return rx.test(path);
}

/**
 * A rule matches when every condition it sets is satisfied (conditions are
 * ANDed; unset conditions don't constrain). Returns the DISTINCT template ids
 * of all matching rules — §4 composability: several templates can apply at
 * once and are merged by mergeDefinitions().
 */
export function matchTemplates(
  change: ChangeDescriptor,
  rules: readonly AssignmentRule[],
): string[] {
  const matched: string[] = [];
  for (const rule of rules) {
    if (rule.pathPattern !== null && !change.paths.some((p) => pathMatches(rule.pathPattern!, p)))
      continue;
    if (rule.changeType !== null && rule.changeType !== change.changeType) continue;
    if (rule.environment !== null && rule.environment !== change.environment) continue;
    // ADR-0018 §4 dims: target system + initiator role, ANDed like the rest.
    if (rule.targetSystem !== null && rule.targetSystem !== change.targetSystem) continue;
    if (
      rule.initiatorRole !== null &&
      !(change.initiatorRoles ?? []).includes(rule.initiatorRole)
    )
      continue;
    // ADR-0018 addendum: the 6th dim. Server-resolved on both sides — the rule
    // names one sensitivity tag, the change carries the tags its project is
    // classified with. No project / no classifications = no match (absent).
    const dataSensitivity = rule.dataSensitivity ?? null;
    if (
      dataSensitivity !== null &&
      !(change.dataSensitivities ?? []).includes(dataSensitivity)
    )
      continue;
    if (
      rule.pathPattern === null &&
      rule.changeType === null &&
      rule.environment === null &&
      rule.targetSystem === null &&
      rule.initiatorRole === null &&
      dataSensitivity === null
    )
      continue; // a rule with no conditions matches nothing rather than everything
    if (!matched.includes(rule.templateId)) matched.push(rule.templateId);
  }
  return matched;
}

/**
 * §4 union/merge: stages of all applicable templates in order, deduped by
 * stage id — the strictest set survives because every template's
 * human-approval stages are retained. Later templates' unseen stages append
 * after the trigger of the merged flow.
 */
export function mergeDefinitions(defs: readonly WorkflowDefinition[]): WorkflowDefinition {
  if (defs.length === 0) throw new Error("mergeDefinitions requires at least one definition");
  if (defs.length === 1) return defs[0]!;
  const byId = new Map<string, Stage>();
  const stages: Stage[] = [];
  for (const def of defs) {
    for (const stage of def.stages) {
      const existing = byId.get(stage.id);
      if (existing) {
        // identical duplicates dedupe; conflicting configs must not silently
        // drop a (possibly stricter) template's stage
        if (JSON.stringify(existing) !== JSON.stringify(stage)) {
          throw new MergeConflictError(
            `stage id '${stage.id}' appears in multiple templates with conflicting configs`,
          );
        }
        continue;
      }
      if (stage.type === "trigger" && stages.some((s) => s.type === "trigger")) continue;
      byId.set(stage.id, stage);
      stages.push(stage);
    }
  }
  // §9 strictest-wins: an unset template counts as "standard", so a merge
  // with any untagged template can never inherit cost-sensitive downgrading.
  const costSensitivity = defs
    .map((d) => d.costSensitivity ?? "standard")
    .reduce((a, b) => (STRICTNESS[a] >= STRICTNESS[b] ? a : b));
  return { workflow: defs.map((d) => d.workflow).join("+"), stages, costSensitivity };
}

// ---------------------------------------------------------------------------
// Instance state machine — pure transitions, effects returned to the caller.
// ---------------------------------------------------------------------------

export type StageStatus = "pending" | "active" | "completed" | "reopened";

export type InstanceStatus =
  | "running"
  | "blocked_on_approval"
  | "blocked_on_artifact"
  // §2 stage 2 (ADR-0079): the instance is RESTING at a `planning` stage. This
  // is what makes "forced planning-only reasoning first — no code/state
  // mutation possible in this stage" enforceable: before ADR-0079 a planning
  // stage auto-completed, so an instance never sat here and no consumer could
  // ever observe the marker. Leaving it is an explicit act (human_trigger /
  // stage_completed on the planning stage), exactly like the other human gates.
  | "blocked_on_plan"
  | "awaiting_trigger"
  | "awaiting_execution"
  // §2 automated checks that actually FAIL: a required check reported a failing
  // result, so the pipeline is parked here (NOT advanced) pending remediation
  // and a re-check — the failure path the deploy/rollback stages build on.
  | "blocked_on_check"
  // §2 a deploy stage could not proceed (no configured target, or its condition
  // was not met) — parked for a manual handoff decision (override or abort).
  | "blocked_on_deploy"
  | "completed"
  | "aborted"
  | "denied"
  // §2 terminal: a post-deploy verify failed and the deploy was reversed.
  | "rolled_back";

export interface InstanceState {
  status: InstanceStatus;
  currentStageIndex: number;
  stageStatuses: StageStatus[];
  /** version of the most recently submitted artifact per artifact name */
  artifactVersions: Record<string, number>;
}

export type WorkflowEvent =
  | { kind: "start" }
  | { kind: "artifact_submitted"; stageId: string }
  | { kind: "approval_granted"; stageId: string }
  | { kind: "approval_denied"; stageId: string }
  // ADR-0168 — "send back for information": the approver neither approves nor
  // denies; the instance returns to the NEAREST PRECEDING artifact_generation
  // stage and rests there until a NEW version of that artifact is submitted.
  // Not terminal (the denial is) — the resubmission re-requests the sign-off.
  | { kind: "approval_returned"; stageId: string }
  | { kind: "human_trigger"; stageId: string }
  | { kind: "stage_completed"; stageId: string }
  | { kind: "execution_succeeded"; stageId: string }
  | { kind: "execution_failed"; stageId: string; error: string }
  // §2 a required automated check reported a FAILING result — distinct from a
  // transient execution_failed (which stays retryable): this parks the instance
  // at blocked_on_check pending remediation. `failures` names the failing checks.
  | { kind: "check_failed"; stageId: string; failures: string[] }
  // §2 remediation done — re-run the parked check stage against fresh results.
  | { kind: "recheck"; stageId: string }
  // §2 a deploy stage cannot proceed (no target / condition unmet) → manual handoff.
  | { kind: "deploy_blocked"; stageId: string; reason: string }
  // §2 operator resolves a manual-handoff deploy (deployed out-of-band / condition
  // accepted) → advance past the deploy stage.
  | { kind: "deploy_override"; stageId: string }
  // §2 a rollback stage finished reversing the deployment → terminal rolled_back.
  | { kind: "rolled_back"; stageId: string }
  // AER-049 — a GENERIC re-open: the instance goes back to `stageId` (a
  // human_approval or artifact_generation stage before the current one and at
  // or before the first git / deploy stage, so review always runs again
  // before anything ships) and runs forward from there, every stage
  // from it on marked reopened. Unlike every other event it is accepted on a
  // COMPLETED instance (a recertification re-opens an approved intake to its
  // sign-off); aborted / denied / rolled_back stay terminal. `reason` says why
  // (it is stored with the event).
  | { kind: "reopen"; stageId: string; reason: string }
  | { kind: "abort" };

/** side effects the caller (gateway) must perform after a transition */
export type Effect =
  | { kind: "request_approval"; stageId: string; approvers: string[] }
  | { kind: "await_artifact"; stageId: string; output: string }
  // §2 stage 2 (ADR-0079): the instance is parked in plan-only mode. The
  // gateway surfaces this the way it surfaces the other blocking effects, and
  // — the point of the stage — REFUSES mutating work attributed to the
  // instance while it holds.
  | { kind: "await_plan"; stageId: string }
  | { kind: "await_human_trigger"; stageId: string }
  | { kind: "execute_stage"; stageId: string }
  // §2 a required check failed — the gateway surfaces this (audit + PM mirror +
  // dashboard) exactly like the other blocking effects; `failures` names them.
  | { kind: "check_failed"; stageId: string; failures: string[] }
  // §2 a deploy stage is parked for a manual handoff; `reason` says why.
  | { kind: "await_manual_deploy"; stageId: string; reason: string }
  // §2 the deployment was reversed — the instance ended in rolled_back.
  | { kind: "instance_rolled_back"; stageId: string }
  | { kind: "instance_completed" }
  | { kind: "instance_denied" }
  | { kind: "instance_aborted" };

export interface TransitionResult {
  state: InstanceState;
  effects: Effect[];
}

export function initialState(def: WorkflowDefinition): InstanceState {
  return {
    status: "running",
    currentStageIndex: 0,
    stageStatuses: def.stages.map(() => "pending"),
    artifactVersions: {},
  };
}

function stageAt(def: WorkflowDefinition, index: number): Stage | undefined {
  return def.stages[index];
}

/**
 * §2 stage 2 (ADR-0079) — THE PLAN-ONLY PREDICATE, owned by the kernel.
 *
 * Returns the `planning` stage an instance is currently RESTING at, or null.
 * The gateway's enforcement point calls this rather than re-deriving "is it
 * planning?" from a status string, so there is exactly one definition of the
 * plan-only condition and it lives with the state machine that produces it.
 *
 * Deliberately keyed on the stage TYPE at `currentStageIndex` and not on
 * `status === "blocked_on_plan"` alone: an instance persisted before ADR-0079
 * (or driven by a future path that parks differently) is still honestly "at a
 * planning stage", and a terminal instance is never at one.
 */
export function currentPlanningStage(
  def: WorkflowDefinition,
  state: InstanceState,
): Stage | null {
  if (
    state.status === "completed" ||
    state.status === "aborted" ||
    state.status === "denied" ||
    state.status === "rolled_back"
  ) {
    return null;
  }
  const stage = stageAt(def, state.currentStageIndex);
  return stage?.type === "planning" ? stage : null;
}

/**
 * Advance from the current stage through every auto-completing stage until a
 * blocking stage (approval / artifact / human trigger) or the end.
 *
 * Blocking semantics per §2: artifact_generation waits for a submitted
 * artifact; human_approval waits for the named approver; git_operation, an
 * automated_build with a nested run, and an automated_check with named checks
 * are executed by the gateway; a build without a run or a check without named
 * checks waits for an explicit human trigger — "decide" and "execute" stay
 * separate user actions.
 */
function runForward(def: WorkflowDefinition, state: InstanceState): TransitionResult {
  const effects: Effect[] = [];
  const s: InstanceState = {
    ...state,
    stageStatuses: [...state.stageStatuses],
    artifactVersions: { ...state.artifactVersions },
  };

  for (;;) {
    const stage = stageAt(def, s.currentStageIndex);
    if (!stage) {
      s.status = "completed";
      effects.push({ kind: "instance_completed" });
      return { state: s, effects };
    }
    // §2 a rollback stage is a FAILURE-ONLY target: it runs only when a
    // post-deploy verify jumps to it (that jump bypasses runForward). In the
    // normal forward flow it is skipped, so a passing deploy never reverses
    // itself. It stays "pending" — it was never entered.
    if (stage.type === "rollback") {
      s.currentStageIndex += 1;
      continue;
    }
    s.stageStatuses[s.currentStageIndex] = "active";

    if (stage.type === "trigger") {
      // the trigger already fired — that is what started the instance
      s.stageStatuses[s.currentStageIndex] = "completed";
      s.currentStageIndex += 1;
      continue;
    }
    // §2 stage 2 (ADR-0079): a planning stage BLOCKS. It used to auto-complete
    // ("planning is a mode marker, not a blocker here"), which made the spec's
    // "no code/state mutation possible in this stage" unenforceable — an
    // instance never rested at the marker, so nothing could consume it. Now it
    // rests, and leaving it is an explicit human act like every other gate.
    if (stage.type === "planning") {
      s.status = "blocked_on_plan";
      effects.push({ kind: "await_plan", stageId: stage.id });
      return { state: s, effects };
    }
    if (stage.type === "artifact_generation") {
      const submitted = s.artifactVersions[stage.output!] !== undefined;
      if (!submitted) {
        s.status = "blocked_on_artifact";
        effects.push({ kind: "await_artifact", stageId: stage.id, output: stage.output! });
        return { state: s, effects };
      }
      s.stageStatuses[s.currentStageIndex] = "completed";
      s.currentStageIndex += 1;
      continue;
    }
    if (stage.type === "human_approval") {
      s.status = "blocked_on_approval";
      effects.push({
        kind: "request_approval",
        stageId: stage.id,
        approvers: stage.approvers ?? [],
      });
      return { state: s, effects };
    }
    if (
      stage.type === "git_operation" ||
      stage.type === "deployment" ||
      (stage.type === "automated_build" && stage.run !== undefined) ||
      (stage.type === "automated_check" && (stage.checks?.length ?? 0) > 0)
    ) {
      // executed by the gateway (git executor / deploy executor / nested
      // orchestration run / check executor); retryable on failure. (A rollback
      // stage is reached only via the post-deploy-verify jump, which sets
      // awaiting_execution directly and never passes through here.)
      s.status = "awaiting_execution";
      effects.push({ kind: "execute_stage", stageId: stage.id });
      return { state: s, effects };
    }
    // automated_build without a run / automated_check without named checks:
    // await explicit trigger
    s.status = "awaiting_trigger";
    effects.push({ kind: "await_human_trigger", stageId: stage.id });
    return { state: s, effects };
  }
}

export function transition(
  def: WorkflowDefinition,
  state: InstanceState,
  event: WorkflowEvent,
): TransitionResult {
  // AER-049: the one event a COMPLETED instance accepts — checked before the
  // terminal refusal below. Aborted / denied / rolled_back stay terminal.
  if (event.kind === "reopen") {
    if (state.status === "aborted" || state.status === "denied" || state.status === "rolled_back") {
      throw new WorkflowStateError(`instance is terminal (${state.status}) and cannot be re-opened`);
    }
    const targetIndex = def.stages.findIndex((st) => st.id === event.stageId);
    if (targetIndex < 0) throw new WorkflowStateError(`no stage '${event.stageId}'`);
    // AER-049 review: a re-open always runs REVIEW again before anything
    // ships. The target must be a human sign-off or an artifact stage, and it
    // must sit at or before the first git (PR / merge) or deploy stage — re-opening between
    // a PR and its merge (or past a deploy) would re-run the merge or deploy
    // with no new review, on the PR an earlier round already merged.
    const target = def.stages[targetIndex]!;
    if (target.type !== "human_approval" && target.type !== "artifact_generation") {
      throw new WorkflowStateError(
        `stage '${event.stageId}' is a ${target.type} stage — a re-open targets a sign-off or an artifact stage, so review runs again`,
      );
    }
    // `create_branch` does not ship anything (and the round's `open_pr` cuts a
    // fresh round branch itself), so a review AFTER it is still a valid target
    const firstShipping = def.stages.findIndex(
      (st) =>
        (st.type === "git_operation" && st.action !== "create_branch") ||
        st.type === "deployment" ||
        st.type === "rollback",
    );
    if (firstShipping >= 0 && targetIndex > firstShipping) {
      throw new WorkflowStateError(
        `stage '${event.stageId}' comes after '${def.stages[firstShipping]!.id}' (${def.stages[firstShipping]!.type}) — ` +
          "a re-open must go back to a review at or before the first git / deploy stage",
      );
    }
    if (targetIndex >= state.currentStageIndex) {
      throw new WorkflowStateError(
        `stage '${event.stageId}' is not before the current stage — only a stage already passed can be re-opened`,
      );
    }
    const s: InstanceState = {
      ...state,
      status: "running",
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions },
    };
    for (let i = targetIndex; i < s.stageStatuses.length; i++) {
      if (s.stageStatuses[i] !== "pending") s.stageStatuses[i] = "reopened";
    }
    s.currentStageIndex = targetIndex;
    return runForward(def, s);
  }

  if (
    state.status === "completed" ||
    state.status === "aborted" ||
    state.status === "denied" ||
    state.status === "rolled_back"
  ) {
    throw new WorkflowStateError(`instance is terminal (${state.status}) and accepts no events`);
  }

  if (event.kind === "abort") {
    const s = { ...state, status: "aborted" as const };
    return { state: s, effects: [{ kind: "instance_aborted" }] };
  }

  if (event.kind === "start") {
    return runForward(def, state);
  }

  const current = stageAt(def, state.currentStageIndex);

  if (event.kind === "artifact_submitted") {
    const producer = def.stages.find(
      (st) => st.id === event.stageId && st.type === "artifact_generation",
    );
    if (!producer) throw new WorkflowStateError(`no artifact_generation stage '${event.stageId}'`);
    const producerIndex = def.stages.findIndex((st) => st.id === event.stageId);
    const version = (state.artifactVersions[producer.output!] ?? 0) + 1;
    const s: InstanceState = {
      ...state,
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions, [producer.output!]: version },
    };

    // §2 stage 4: an edit AFTER the artifact stage completed re-opens the
    // workflow at that stage — downstream sign-offs are stale and re-run.
    if (producerIndex < state.currentStageIndex) {
      for (let i = producerIndex; i < s.stageStatuses.length; i++) {
        if (s.stageStatuses[i] !== "pending") s.stageStatuses[i] = "reopened";
      }
      s.currentStageIndex = producerIndex;
      s.status = "running";
      return runForward(def, s);
    }
    if (current?.id !== event.stageId) {
      throw new WorkflowStateError(`instance is not waiting on artifact stage '${event.stageId}'`);
    }
    s.status = "running";
    return runForward(def, s);
  }

  if (event.kind === "approval_granted") {
    if (current?.type !== "human_approval" || current.id !== event.stageId) {
      throw new WorkflowStateError(
        `instance is not blocked on approval stage '${event.stageId}'`,
      );
    }
    const s: InstanceState = {
      ...state,
      status: "running",
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions },
    };
    s.stageStatuses[s.currentStageIndex] = "completed";
    s.currentStageIndex += 1;
    return runForward(def, s);
  }

  if (event.kind === "approval_denied") {
    if (current?.type !== "human_approval" || current.id !== event.stageId) {
      throw new WorkflowStateError(
        `instance is not blocked on approval stage '${event.stageId}'`,
      );
    }
    const s = { ...state, status: "denied" as const };
    return { state: s, effects: [{ kind: "instance_denied" }] };
  }

  if (event.kind === "approval_returned") {
    if (current?.type !== "human_approval" || current.id !== event.stageId) {
      throw new WorkflowStateError(
        `instance is not blocked on approval stage '${event.stageId}'`,
      );
    }
    // ADR-0168: back to the nearest artifact stage BEFORE this gate. It is
    // NOT re-run forward (the artifact already has a version, so runForward
    // would auto-complete it straight back into this gate): the instance RESTS
    // at blocked_on_artifact, and only a new `artifact_submitted` on that
    // stage moves it on — which runs forward into the sign-off again.
    let producerIndex = -1;
    for (let i = state.currentStageIndex - 1; i >= 0; i--) {
      if (def.stages[i]!.type === "artifact_generation") {
        producerIndex = i;
        break;
      }
    }
    if (producerIndex < 0) {
      throw new WorkflowStateError(
        `approval stage '${event.stageId}' has no preceding artifact stage to return to`,
      );
    }
    const producer = def.stages[producerIndex]!;
    const s: InstanceState = {
      ...state,
      status: "blocked_on_artifact",
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions },
    };
    for (let i = producerIndex; i < s.stageStatuses.length; i++) {
      if (s.stageStatuses[i] !== "pending") s.stageStatuses[i] = "reopened";
    }
    s.stageStatuses[producerIndex] = "active";
    s.currentStageIndex = producerIndex;
    return {
      state: s,
      effects: [{ kind: "await_artifact", stageId: producer.id, output: producer.output! }],
    };
  }

  if (event.kind === "execution_succeeded" || event.kind === "execution_failed") {
    const executable =
      current?.type === "git_operation" ||
      current?.type === "deployment" ||
      (current?.type === "automated_build" && current.run !== undefined) ||
      (current?.type === "automated_check" && (current.checks?.length ?? 0) > 0);
    if (!current || current.id !== event.stageId || !executable) {
      throw new WorkflowStateError(`instance is not executing stage '${event.stageId}'`);
    }
    if (event.kind === "execution_failed") {
      // stays awaiting_execution — the event log records the error; retry re-executes
      return { state: { ...state }, effects: [] };
    }
    const s: InstanceState = {
      ...state,
      status: "running",
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions },
    };
    s.stageStatuses[s.currentStageIndex] = "completed";
    s.currentStageIndex += 1;
    return runForward(def, s);
  }

  if (event.kind === "check_failed") {
    // only the currently-executing named-check stage can fail this way
    const executable =
      current?.type === "automated_check" && (current.checks?.length ?? 0) > 0;
    if (!current || current.id !== event.stageId || !executable) {
      throw new WorkflowStateError(`instance is not running checks for stage '${event.stageId}'`);
    }
    // §2 self-heal: a post-deploy verify with onFailure:"rollback" routes STRAIGHT
    // to its rollback stage (jump the index, run the rollback executor) instead
    // of parking — a failed deploy reverses itself. Any other check blocks.
    if (current.onFailure === "rollback" && current.rollbackStageId) {
      const rbIndex = def.stages.findIndex((o) => o.id === current.rollbackStageId);
      // the schema guarantees this points at a real rollback stage; be defensive
      if (rbIndex >= 0) {
        const s: InstanceState = {
          ...state,
          status: "awaiting_execution",
          stageStatuses: [...state.stageStatuses],
          artifactVersions: { ...state.artifactVersions },
        };
        s.stageStatuses[s.currentStageIndex] = "completed";
        s.currentStageIndex = rbIndex;
        s.stageStatuses[rbIndex] = "active";
        return {
          state: s,
          effects: [
            { kind: "check_failed", stageId: current.id, failures: event.failures },
            { kind: "execute_stage", stageId: current.rollbackStageId },
          ],
        };
      }
    }
    // park at blocked_on_check WITHOUT advancing — the stage stays active so a
    // recheck re-runs THIS stage. Surfaced via the check_failed effect.
    return {
      state: { ...state, status: "blocked_on_check" },
      effects: [{ kind: "check_failed", stageId: current.id, failures: event.failures }],
    };
  }

  if (event.kind === "recheck") {
    if (state.status !== "blocked_on_check") {
      throw new WorkflowStateError("instance is not blocked on a failed check");
    }
    if (!current || current.id !== event.stageId) {
      throw new WorkflowStateError(`instance is not parked on check stage '${event.stageId}'`);
    }
    // re-run the same check stage against freshly-reported results
    return {
      state: { ...state, status: "awaiting_execution" },
      effects: [{ kind: "execute_stage", stageId: current.id }],
    };
  }

  if (event.kind === "deploy_blocked") {
    if (!current || current.id !== event.stageId || current.type !== "deployment") {
      throw new WorkflowStateError(`instance is not deploying stage '${event.stageId}'`);
    }
    // manual handoff: no configured target or the condition was not met — park.
    return {
      state: { ...state, status: "blocked_on_deploy" },
      effects: [{ kind: "await_manual_deploy", stageId: current.id, reason: event.reason }],
    };
  }

  if (event.kind === "deploy_override") {
    if (state.status !== "blocked_on_deploy") {
      throw new WorkflowStateError("instance is not blocked on a manual deploy handoff");
    }
    if (!current || current.id !== event.stageId) {
      throw new WorkflowStateError(`instance is not parked on deploy stage '${event.stageId}'`);
    }
    // operator resolved the handoff — advance past the deploy stage
    const s: InstanceState = {
      ...state,
      status: "running",
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions },
    };
    s.stageStatuses[s.currentStageIndex] = "completed";
    s.currentStageIndex += 1;
    return runForward(def, s);
  }

  if (event.kind === "rolled_back") {
    if (!current || current.id !== event.stageId || current.type !== "rollback") {
      throw new WorkflowStateError(`instance is not rolling back stage '${event.stageId}'`);
    }
    // terminal: the deployment was reversed. The stage is done and the run ends.
    const s: InstanceState = {
      ...state,
      status: "rolled_back",
      stageStatuses: [...state.stageStatuses],
    };
    s.stageStatuses[s.currentStageIndex] = "completed";
    return { state: s, effects: [{ kind: "instance_rolled_back", stageId: current.id }] };
  }

  if (event.kind === "human_trigger" || event.kind === "stage_completed") {
    if (!current || current.id !== event.stageId) {
      throw new WorkflowStateError(`instance is not waiting on stage '${event.stageId}'`);
    }
    if (
      current.type !== "automated_build" &&
      current.type !== "automated_check" &&
      // §2 stage 2 (ADR-0079): a planning stage is left by the same explicit
      // act — "planning is finished" is a decision, and the decision is the
      // only thing that lifts the plan-only refusal.
      current.type !== "planning"
    ) {
      throw new WorkflowStateError(`stage '${event.stageId}' is not triggerable`);
    }
    if (current.type === "automated_build" && current.run !== undefined) {
      // §8: a build stage with a nested run completes via that run's outcome
      // — a human trigger must never bypass the governed execution.
      throw new WorkflowStateError(
        `stage '${event.stageId}' executes a nested run and cannot be human-triggered`,
      );
    }
    if (current.type === "automated_check" && (current.checks?.length ?? 0) > 0) {
      // same rule for checks: named checks complete via the executor's
      // recorded results — a human trigger must never skip them.
      throw new WorkflowStateError(
        `stage '${event.stageId}' runs named checks and cannot be human-triggered`,
      );
    }
    const s: InstanceState = {
      ...state,
      status: "running",
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions },
    };
    s.stageStatuses[s.currentStageIndex] = "completed";
    s.currentStageIndex += 1;
    return runForward(def, s);
  }

  throw new WorkflowStateError(`unhandled event`);
}
