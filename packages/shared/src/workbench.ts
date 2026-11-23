/**
 * ADR-0046 — the REVIEW WORKBENCH's PURE half: rule matching, the SLA clock,
 * and the bulk-fence decision. No db, no clock of its own (every function that
 * needs "now" takes it), no HTTP.
 *
 * TWO IDEAS WORTH STATING IN THE CODE RATHER THAN ONLY IN THE ADR
 *
 *  1. THE SLA CLOCK IS DERIVED, NEVER STARTED. `slaDeadlines` computes
 *     `warnAt`/`dueAt` from `approvals.requested_at` plus the policy. It is a
 *     pure function of stored state, which is what makes lazy evaluation
 *     HONEST rather than approximate: an assignment materialized an hour late
 *     gets exactly the deadlines an eagerly materialized one would have had.
 *     Nothing in this codebase runs a timer; the state a timer would have
 *     produced is reconstructible on read instead. See `evaluateSla`.
 *
 *  2. ESCALATION NEVER DECIDES. `ApprovalEscalateAction` admits
 *     `add_assignee | reassign | notify_only` and nothing else. A queue that
 *     clears itself on timeout is a bypass, and the compliance-beats-approval
 *     principle forbids it. The type is the enforcement, alongside the DB CHECK.
 */
import { z } from "zod";
import { defineMachine } from "./state-machine.js";

export const APPROVAL_ASSIGNEE_KINDS = ["user", "role", "team"] as const;
export type ApprovalAssigneeKind = (typeof APPROVAL_ASSIGNEE_KINDS)[number];

export const APPROVAL_ESCALATE_ACTIONS = ["add_assignee", "reassign", "notify_only"] as const;
export type ApprovalEscalateAction = (typeof APPROVAL_ESCALATE_ACTIONS)[number];

export const APPROVAL_SLA_STATES = ["ok", "warning", "breached"] as const;
export type ApprovalSlaState = (typeof APPROVAL_SLA_STATES)[number];

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

/** the SERVER-RESOLVED facts about an approval that rules match on. Every field
 * comes from the approval row or from the attributed project — never from a
 * client-supplied value (the ADR-0018/0019 discipline). */
export interface ApprovalRoutingContext {
  objectType: string;
  projectId: string | null;
  /** derived from the attributed project's compliance classifications */
  dataSensitivity: string | null;
  stageId: string | null;
  templateIds: string[];
}

export interface AssignmentRuleLike {
  id: string;
  objectType: string | null;
  projectId: string | null;
  dataSensitivity: string | null;
  stagePattern: string | null;
  templateId: string | null;
  assigneeKind: ApprovalAssigneeKind | string;
  assigneeId: string;
  quorum: number;
  priority: number;
  slaPolicyId: string | null;
  enabled: boolean;
  createdAt: Date | string;
}

/** `*` is the only wildcard; everything else is literal. Deliberately not a
 * regex: an admin-typed regex in a routing rule is an availability risk (a
 * catastrophic backtrack in the read path of every reviewer's inbox) for no
 * expressive gain over prefix/suffix/contains globs. */
export function stagePatternMatches(pattern: string, stageId: string | null): boolean {
  if (!pattern) return false;
  if (stageId === null) return false;
  if (!pattern.includes("*")) return pattern === stageId;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(stageId);
}

/** Conditions AND together. A rule with NO conditions matches NOTHING — the
 * `workflow_assignment_rules` discipline, because an unconditioned rule would
 * silently capture every approval in the deployment. */
export function ruleMatches(rule: AssignmentRuleLike, ctx: ApprovalRoutingContext): boolean {
  if (!rule.enabled) return false;
  const hasCondition =
    rule.objectType !== null ||
    rule.projectId !== null ||
    rule.dataSensitivity !== null ||
    rule.stagePattern !== null ||
    rule.templateId !== null;
  if (!hasCondition) return false;
  if (rule.objectType !== null && rule.objectType !== ctx.objectType) return false;
  if (rule.projectId !== null && rule.projectId !== ctx.projectId) return false;
  if (rule.dataSensitivity !== null && rule.dataSensitivity !== ctx.dataSensitivity) return false;
  if (rule.stagePattern !== null && !stagePatternMatches(rule.stagePattern, ctx.stageId)) return false;
  if (rule.templateId !== null && !ctx.templateIds.includes(rule.templateId)) return false;
  return true;
}

/** Lowest `priority` wins; ties break on `createdAt` (oldest first), so the
 * selection is TOTAL — two equally-specific rules never produce a
 * non-deterministic queue. */
export function selectAssignmentRule<T extends AssignmentRuleLike>(
  rules: T[],
  ctx: ApprovalRoutingContext,
): T | null {
  const matching = rules.filter((r) => ruleMatches(r, ctx));
  if (matching.length === 0) return null;
  return matching.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const at = a.createdAt instanceof Date ? a.createdAt.getTime() : Date.parse(String(a.createdAt));
    const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : Date.parse(String(b.createdAt));
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : 1;
  })[0]!;
}

// ---------------------------------------------------------------------------
// The SLA clock
// ---------------------------------------------------------------------------

export interface SlaPolicyLike {
  id: string;
  warnAfterMinutes: number;
  breachAfterMinutes: number;
  escalateAction: ApprovalEscalateAction | string;
  escalateToKind: ApprovalAssigneeKind | string | null;
  escalateToId: string | null;
  enabled: boolean;
}

/** DERIVED from the approval's own `requestedAt`. Pure — this is what makes a
 * lazily materialized assignment indistinguishable from an eagerly materialized
 * one. */
export function slaDeadlines(
  requestedAt: Date | string,
  policy: Pick<SlaPolicyLike, "warnAfterMinutes" | "breachAfterMinutes">,
): { warnAt: Date; dueAt: Date } {
  const base = requestedAt instanceof Date ? requestedAt.getTime() : Date.parse(String(requestedAt));
  return {
    warnAt: new Date(base + policy.warnAfterMinutes * 60_000),
    dueAt: new Date(base + policy.breachAfterMinutes * 60_000),
  };
}

export interface SlaEvaluation {
  state: ApprovalSlaState;
  /** true when this evaluation moved the state (i.e. something must be written) */
  changed: boolean;
  /** true when this evaluation is the transition INTO breached — the moment
   * escalation fires, and exactly once */
  breachedNow: boolean;
  minutesLate: number | null;
}

/**
 * Evaluate an assignment's SLA at `now`.
 *
 * Monotonic on purpose: `ok → warning → breached` and never back. A queue whose
 * badge flickers because a clock moved is a queue nobody trusts, and a breach
 * that un-breaches would let escalation fire twice.
 *
 * A DECIDED approval is never evaluated (the caller filters); a decision stops
 * the clock, it does not reset it.
 */
export function evaluateSla(
  assignment: { warnAt: Date | string | null; dueAt: Date | string | null; slaState: string },
  now: Date,
): SlaEvaluation {
  const stored = (APPROVAL_SLA_STATES as readonly string[]).includes(assignment.slaState)
    ? (assignment.slaState as ApprovalSlaState)
    : "ok";
  const due = assignment.dueAt
    ? assignment.dueAt instanceof Date
      ? assignment.dueAt.getTime()
      : Date.parse(String(assignment.dueAt))
    : null;
  const warn = assignment.warnAt
    ? assignment.warnAt instanceof Date
      ? assignment.warnAt.getTime()
      : Date.parse(String(assignment.warnAt))
    : null;
  if (due === null) {
    // no SLA policy on this assignment — nothing to evaluate, ever
    return { state: stored, changed: false, breachedNow: false, minutesLate: null };
  }
  const t = now.getTime();
  if (t >= due) {
    return {
      state: "breached",
      changed: stored !== "breached",
      breachedNow: stored !== "breached",
      minutesLate: Math.floor((t - due) / 60_000),
    };
  }
  if (warn !== null && t >= warn) {
    return {
      state: stored === "breached" ? "breached" : "warning",
      changed: stored === "ok",
      breachedNow: false,
      minutesLate: null,
    };
  }
  return { state: stored, changed: false, breachedNow: false, minutesLate: null };
}

// ---------------------------------------------------------------------------
// Bulk fences
// ---------------------------------------------------------------------------

export type BulkRefusalReason =
  | "over_cap"
  | "sensitive_class"
  | "not_pending"
  | "not_authorized"
  | "unknown_approval";

/**
 * The CAP check. Separate from the per-item authorization on purpose: the cap
 * is a property of the REQUEST and is refused whole, while authorization is a
 * property of each ITEM and is refused item-by-item. Conflating them would let
 * one unauthorized item silently drop the rest, or one oversized request
 * silently truncate.
 */
export function bulkCapRefusal(count: number, max: number): { refused: boolean; detail: string } {
  if (count <= max) return { refused: false, detail: "" };
  return {
    refused: true,
    detail:
      `a bulk action may cover at most ${max} approvals (this one named ${count}). ` +
      "The cap is deliberate: a bulk of thousands is indistinguishable from 'approve everything'.",
  };
}

/** ADR-0046 §4's sensitivity fence. `piiMode === 'block'` is the compliance
 * cascade's strongest posture, and it is the concrete reading of "anything the
 * cascade flags production/PII". */
export function bulkSensitivityFenced(input: {
  enabled: boolean;
  projectPiiMode: string | null;
}): boolean {
  return input.enabled && input.projectPiiMode === "block";
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export const createApprovalSlaPolicySchema = z
  .object({
    name: z.string().min(1).max(200),
    warnAfterMinutes: z.number().int().min(0).max(525_600),
    breachAfterMinutes: z.number().int().min(1).max(525_600),
    escalateAction: z.enum(APPROVAL_ESCALATE_ACTIONS).default("add_assignee"),
    escalateToKind: z.enum(APPROVAL_ASSIGNEE_KINDS).optional(),
    escalateToId: z.string().uuid().optional(),
    enabled: z.boolean().default(true),
  })
  .refine((b) => b.breachAfterMinutes > b.warnAfterMinutes, {
    message: "breachAfterMinutes must be strictly greater than warnAfterMinutes",
  })
  .refine(
    (b) => b.escalateAction === "notify_only" || (Boolean(b.escalateToKind) && Boolean(b.escalateToId)),
    { message: "an escalation that names nowhere to escalate to is a breach counter, not an escalation" },
  )
  .refine((b) => b.escalateAction !== "reassign" || b.escalateToKind === "user", {
    message: "reassign must name a single user — a role or team cannot become the one named approver",
  });

export const createApprovalAssignmentRuleSchema = z
  .object({
    name: z.string().min(1).max(200),
    objectType: z.string().min(1).max(64).optional(),
    projectId: z.string().uuid().optional(),
    dataSensitivity: z.string().min(1).max(200).optional(),
    stagePattern: z.string().min(1).max(400).optional(),
    templateId: z.string().uuid().optional(),
    assigneeKind: z.enum(APPROVAL_ASSIGNEE_KINDS),
    assigneeId: z.string().uuid(),
    quorum: z.number().int().min(1).max(20).default(1),
    priority: z.number().int().min(0).max(10_000).default(100),
    slaPolicyId: z.string().uuid().optional(),
    enabled: z.boolean().default(true),
  })
  .refine(
    (b) =>
      Boolean(b.objectType) ||
      Boolean(b.projectId) ||
      Boolean(b.dataSensitivity) ||
      Boolean(b.stagePattern) ||
      Boolean(b.templateId),
    {
      message:
        "a rule needs at least one match condition — an unconditioned rule would silently capture every approval in the deployment",
    },
  );

export const bulkDecideApprovalsSchema = z.object({
  approvalIds: z.array(z.string().uuid()).min(1).max(500),
  decision: z.enum(["approved", "denied"]),
  /** the shared decision reason; every item's own audit row carries it */
  reason: z.string().min(1).max(4000),
});

export const createApprovalSavedViewSchema = z.object({
  name: z.string().min(1).max(200),
  filters: z.record(z.string(), z.unknown()).default({}),
  sort: z.string().min(1).max(64).default("requested_at_desc"),
  /** admin-only: publish for everyone instead of owning it privately */
  shared: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// ADR-0342 slice 2 — a human task's priority and explicit due date
// ---------------------------------------------------------------------------

export const APPROVAL_TASK_PRIORITY_ORDER = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof APPROVAL_TASK_PRIORITY_ORDER)[number];

export interface TaskSchedule {
  priority: TaskPriority;
  warnAt: Date | null;
  dueAt: Date | null;
  slaPolicyId: string | null;
}

/**
 * Does moving a task from `current` to `next` LOOSEN it (ADR-0180)? A later or removed due or warn time, a lower
 * priority, or a different escalation policy (it changes who the task escalates to) is a relaxation and needs an
 * admin's `settings_relax` step-up; a stage timer may never make one. An earlier due time or a higher priority is a
 * tightening, and so is a policy set where there was none, UNLESS that policy changes who decides the task (its breach
 * reassigns or adds an assignee): changing who an approval goes to is a `settings_relax` (B4S-02), so attaching such a
 * policy is the relaxation `escalation_policy_attached`. The caller says which with `nextPolicyChangesApprover`.
 */
export function taskScheduleRelaxations(
  current: TaskSchedule,
  next: TaskSchedule,
  opts: { nextPolicyChangesApprover?: boolean } = {},
): string[] {
  const out: string[] = [];
  const later = (a: Date | null, b: Date | null) => (a !== null && b === null) || (a !== null && b !== null && b.getTime() > a.getTime());
  if (later(current.dueAt, next.dueAt)) out.push(next.dueAt ? "due_later" : "due_removed");
  if (later(current.warnAt, next.warnAt)) out.push(next.warnAt ? "warn_later" : "warn_removed");
  const rank = (p: TaskPriority) => APPROVAL_TASK_PRIORITY_ORDER.indexOf(p);
  if (rank(next.priority) < rank(current.priority)) out.push("priority_lowered");
  if (current.slaPolicyId !== null && next.slaPolicyId !== current.slaPolicyId) out.push("escalation_policy_changed");
  if (current.slaPolicyId === null && next.slaPolicyId !== null && opts.nextPolicyChangesApprover) out.push("escalation_policy_attached");
  return out;
}

/** the SLA state a schedule implies at `now`, from scratch (a moved due time re-arms the clock) */
export function slaStateAt(schedule: { warnAt: Date | null; dueAt: Date | null }, now: Date): "ok" | "warning" | "breached" {
  if (schedule.dueAt && now.getTime() >= schedule.dueAt.getTime()) return "breached";
  if (schedule.warnAt && now.getTime() >= schedule.warnAt.getTime()) return "warning";
  return "ok";
}

/**
 * ADR-0342 slice 2 (rule 12, ADR-0348): the declared lifecycle of `approval_assignments.sla_state`, through the one
 * shared `defineMachine` table, registered in `STATE_MACHINES` (so its states are held equal to the column's CHECK).
 *  - the clock (`warn`, `breach`): the ADR-0046 evaluation (`evaluateSla`) only ever moves a task forward;
 *  - a reschedule (`rearm_ok`, `rearm_warning`): a due or warn time moved later (`scheduleApprovalTask`) may re-arm it
 *    backward. Moving a time EARLIER is left to the clock, so a warning or breach is audited and escalated once, the
 *    usual way. A stage timer can never move a time later (it cannot relax), so a re-arm is an admin's.
 * Staying in the same state is always allowed and is not an event.
 */
export const APPROVAL_SLA_MACHINE = defineMachine({
  id: "approval_sla",
  stored: "approval_assignments.sla_state",
  states: APPROVAL_SLA_STATES,
  initial: ["ok"],
  terminal: [],
  transitions: {
    warn: { from: ["ok"], to: "warning", by: ["system"], summary: "The warn time passed; the SLA sweep warns the assignees." },
    breach: {
      from: ["ok", "warning"],
      to: "breached",
      by: ["system"],
      summary: "The due time passed; the SLA sweep escalates the task by its policy (notify, reassign or add an assignee).",
    },
    rearm_ok: {
      from: ["warning", "breached"],
      to: "ok",
      by: ["admin"],
      summary: "An admin moved the due and warn times later (a settings_relax step-up); the clock re-arms.",
    },
    rearm_warning: {
      from: ["breached"],
      to: "warning",
      by: ["admin"],
      summary: "An admin moved the due time later but the warn time has passed; the task is back to a warning.",
    },
  },
});

/** which events each cause may take: the clock moves forward, a reschedule only re-arms */
const SLA_EVENTS_BY_CAUSE = {
  clock: ["warn", "breach"],
  reschedule: ["rearm_ok", "rearm_warning"],
} as const satisfies Record<string, readonly (typeof APPROVAL_SLA_MACHINE.events)[number][]>;

/** may `cause` move a task's SLA state from `from` to `to` (a change of state; staying put is always allowed)? */
export function slaTransitionAllowed(cause: keyof typeof SLA_EVENTS_BY_CAUSE, from: string, to: string): boolean {
  const m = APPROVAL_SLA_MACHINE;
  if (!m.isState(from) || !m.isState(to)) return false;
  return SLA_EVENTS_BY_CAUSE[cause].some((e) => m.can(from, e) && m.def.transitions[e].to === to);
}
