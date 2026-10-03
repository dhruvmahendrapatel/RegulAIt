/**
 * The use-case lifecycle tracker, derived — never re-typed (ADR-0168 §3).
 * Every activity's state comes from a record the platform already keeps: the
 * questionnaire artifact, the EU AI Act screening on the use case, the linked
 * stack, the risk register and the sign-off approval.
 */
import type { Tone } from "../../../ui/kit";
import type { UseCaseCondition, UseCaseStatus } from "../../../api/types";

export const STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed",
  under_review: "Under review",
  needs_info: "Needs information",
  approved: "Approved",
  rejected: "Rejected",
  retired: "Retired",
};
export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status.replace(/_/g, " ");

export const STATUS_TONE: Record<string, Tone> = {
  proposed: "neutral",
  under_review: "info",
  needs_info: "warn",
  approved: "ok",
  rejected: "danger",
  retired: "neutral",
};

export const PHASES = ["Proposed", "Under review", "Approved", "Monitoring"] as const;

export interface PhaseState {
  /** the phase the use case is in now */
  current: number;
  /** a flag on the current phase, when it is not simply "in progress" */
  flag: { text: string; tone: Tone } | null;
}

/**
 * Where the use case sits on Proposed → Under review → Approved → Monitoring.
 * Approved stays the current phase while a before-go-live condition is open;
 * once none is, the use case is live and in monitoring. An expired approval
 * puts it back under review.
 */
export function phaseFor(status: UseCaseStatus | string, opts: { approvalExpired?: boolean; openBlocking?: number; recertification?: { dueAt: string | null } | null }): PhaseState {
  // the recertification sweep moved an expired approval back into review
  if (opts.recertification && status === "under_review")
    return { current: 1, flag: { text: reReviewText(opts.recertification.dueAt), tone: "warn" } };
  if (opts.approvalExpired && (status === "approved" || status === "under_review"))
    return { current: 1, flag: { text: "Approval expired — re-review required", tone: "danger" } };
  switch (status) {
    case "proposed":
      return { current: 0, flag: null };
    case "under_review":
      return { current: 1, flag: null };
    case "needs_info":
      return { current: 1, flag: { text: "Needs information", tone: "warn" } };
    case "rejected":
      return { current: 1, flag: { text: "Rejected", tone: "danger" } };
    case "approved":
      return (opts.openBlocking ?? 0) > 0
        ? { current: 2, flag: { text: `${opts.openBlocking} before-go-live condition${opts.openBlocking === 1 ? "" : "s"} open`, tone: "warn" } }
        : { current: 3, flag: null };
    case "retired":
      return { current: 3, flag: { text: "Retired", tone: "neutral" } };
    default:
      return { current: 0, flag: null };
  }
}

/** "Re-review: approval expired 3 Oct 2026" — the band and the tracker say the same words */
export const reReviewText = (dueAt: string | null | undefined) => `Re-review: approval expired${dueAt ? ` ${shortDate(dueAt)}` : ""}`;

export type ActivityStatus = "complete" | "in_progress" | "not_started" | "pending" | "needs_update" | "returned" | "rejected";
export const ACTIVITY_STATUS: Record<ActivityStatus, { label: string; tone: Tone }> = {
  complete: { label: "Complete", tone: "ok" },
  in_progress: { label: "In progress", tone: "info" },
  not_started: { label: "Not started", tone: "neutral" },
  pending: { label: "Awaiting decision", tone: "info" },
  needs_update: { label: "Needs update", tone: "warn" },
  returned: { label: "Sent back", tone: "warn" },
  rejected: { label: "Rejected", tone: "danger" },
};

export interface ActivityInput {
  status: string;
  ownerName: string | null;
  questionnaire: { submitted: boolean; version: number | null; submittedAt: string | null };
  screening: { screened: boolean; tier: string | null; reasons: Array<{ ref?: string; reason?: string }> };
  screenedAt: string | null;
  stack: { agents: Array<{ name: string; modelCardApproved: boolean }>; vendors: Array<{ name: string }> };
  risks: Array<{ residual: unknown | null; controls: unknown[]; status: string }>;
  approvals: Array<{ status: string; approverUserId: string | null; requestedAt: string; decidedAt: string | null; dueAt?: string | null }>;
  approverName: (userId: string | null) => string | null;
  /** the current round's required reviews under a review policy; empty/absent = one named approver */
  reviews?: ReadonlyArray<{ roleId: string; roleName: string; status: string; deciderName: string | null; decidedAt: string | null }>;
}

export type ActivityTab = "questionnaire" | "screening" | "stack" | "risks" | "approvals";
export interface Activity {
  key: string;
  name: string;
  status: ActivityStatus;
  detail: string;
  owner: string | null;
  lastUpdate: string | null;
  action: { label: string; tab: ActivityTab };
}

const SIGNOFF_VERB: Record<string, string> = { approved: "Approved", returned: "Sent back", denied: "Rejected" };
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function deriveActivities(input: ActivityInput): Activity[] {
  const { questionnaire: q, screening, stack, risks } = input;
  const returned = input.status === "needs_info";
  const activities: Activity[] = [];

  activities.push({
    key: "context",
    name: "Business context",
    status: returned ? "needs_update" : q.submitted ? "complete" : "not_started",
    detail: q.submitted ? `Questionnaire version ${q.version} submitted` : "Questionnaire not submitted",
    owner: input.ownerName,
    lastUpdate: q.submittedAt,
    action: { label: returned ? "Update questionnaire" : "View questionnaire", tab: "questionnaire" },
  });

  const firstReason = screening.reasons[0];
  activities.push({
    key: "screening",
    name: "EU AI Act screening",
    status: screening.screened ? "complete" : q.submitted ? "in_progress" : "not_started",
    detail: screening.screened
      ? `${cap(screening.tier ?? "")} tier${firstReason ? ` — ${firstReason.reason ?? firstReason.ref}` : ""}`
      : "Screened from the questionnaire's answers",
    owner: input.ownerName,
    lastUpdate: input.screenedAt,
    action: { label: "View screening", tab: "screening" },
  });

  const agents = stack.agents.length;
  const unapproved = stack.agents.filter((a) => !a.modelCardApproved).length;
  activities.push({
    key: "stack",
    name: "Data and AI models",
    status: agents === 0 ? "not_started" : unapproved > 0 ? "in_progress" : "complete",
    detail: agents === 0
      ? "No agent or model linked"
      : [plural(agents, "agent"), stack.vendors.length ? plural(stack.vendors.length, "vendor") : null, unapproved ? `${unapproved} without an approved model card` : null]
          .filter(Boolean)
          .join(" · "),
    owner: input.ownerName,
    lastUpdate: null,
    action: { label: "Open stack", tab: "stack" },
  });

  const assessed = risks.filter((r) => r.residual !== null).length;
  const uncontrolled = risks.filter((r) => (r.status === "open" || r.status === "mitigating") && r.controls.length === 0).length;
  activities.push({
    key: "risks",
    name: "Risks and safeguards",
    status: risks.length === 0 ? "not_started" : assessed === risks.length && uncontrolled === 0 ? "complete" : "in_progress",
    detail: risks.length === 0
      ? "No risks recorded"
      : [plural(risks.length, "risk"), `residual rated for ${assessed} of ${risks.length}`, uncontrolled ? `${uncontrolled} without controls` : null]
          .filter(Boolean)
          .join(" · "),
    owner: input.ownerName,
    lastUpdate: null,
    action: { label: "Open risks", tab: "risks" },
  });

  if (input.reviews && input.reviews.length > 0) {
    const total = input.reviews.length;
    input.reviews.forEach((review, i) => {
      const status = signoffStatusOf(review.status);
      const of = `review ${i + 1} of ${total}`;
      activities.push({
        key: `signoff:${review.roleId}`,
        name: `Sign-off: ${review.roleName}`,
        status,
        detail: review.status === "pending"
          ? `Awaiting a member of ${review.roleName} · ${of}`
          : `${SIGNOFF_VERB[review.status] ?? ACTIVITY_STATUS[status].label}${review.deciderName ? ` by ${review.deciderName}` : ""} · ${of}`,
        owner: review.deciderName ?? `${review.roleName} reviewers`,
        lastUpdate: review.decidedAt,
        action: { label: "Open approvals", tab: "approvals" },
      });
    });
    return activities;
  }

  const latest = input.approvals[0];
  const signoffStatus: ActivityStatus = !latest
    ? "not_started"
    : latest.status === "pending"
      ? "pending"
      : latest.status === "approved"
        ? "complete"
        : latest.status === "returned"
          ? "returned"
          : latest.status === "denied"
            ? "rejected"
            : "in_progress";
  const approver = latest ? input.approverName(latest.approverUserId) : null;
  activities.push({
    key: "signoff",
    name: "Sign-off",
    status: signoffStatus,
    detail: !latest
      ? "Requested when the questionnaire is submitted"
      : latest.status === "pending"
        ? `Awaiting ${approver ?? "the named reviewer"}${latest.dueAt ? ` · due ${shortDate(latest.dueAt)}` : ""}`
        : `${SIGNOFF_VERB[latest.status] ?? ACTIVITY_STATUS[signoffStatus].label}${approver ? ` by ${approver}` : ""}`,
    owner: approver,
    lastUpdate: latest ? latest.decidedAt ?? latest.requestedAt : null,
    action: { label: "Open approvals", tab: "approvals" },
  });
  return activities;
}

const signoffStatusOf = (status: string): ActivityStatus =>
  status === "pending" ? "pending" : status === "approved" ? "complete" : status === "returned" ? "returned" : status === "denied" ? "rejected" : "in_progress";

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** a calendar date the way a record shows it: `3 Oct 2026` (local time; a bare YYYY-MM-DD is that day) */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** who may mark a condition met: its owner, the use case's owner, or an admin (the server checks the same) */
export function canMarkMet(
  condition: Pick<UseCaseCondition, "status" | "ownerUserId">,
  viewer: { userId: string | null; isAdmin: boolean },
  useCaseOwnerId: string | null | undefined,
): boolean {
  if (condition.status !== "open") return false;
  if (viewer.isAdmin) return true;
  return Boolean(viewer.userId) && (viewer.userId === condition.ownerUserId || viewer.userId === useCaseOwnerId);
}

export const conditionState = (c: UseCaseCondition): { label: string; tone: Tone } =>
  c.status === "met"
    ? { label: "Met", tone: "ok" }
    : c.status === "waived"
      ? { label: "Waived", tone: "neutral" }
      : c.overdue
        ? { label: "Overdue", tone: "danger" }
        : { label: "Open", tone: c.blocking ? "warn" : "info" };

// ---- the use-case 360 read (GET /v1/use-cases/:id/overview) ----------------

export interface RiskControl { controlRef: string; title: string; linkedAt: string }
export interface OverviewRisk {
  id: string;
  title: string;
  category: string;
  dimension: string;
  status: string;
  inherent: { likelihood: string; impact: string };
  residual: { likelihood: string; impact: string } | null;
  controls: RiskControl[];
}
export interface OverviewResponse {
  useCase: {
    id: string;
    name: string;
    description?: string | null;
    businessContext?: string | null;
    status: string;
    euAiActTier?: string | null;
    ownerName?: string | null;
    ownerUserId?: string;
    projectId?: string | null;
    complianceTags?: string[];
    workflowInstanceId?: string | null;
    approvedAt?: string | null;
    approvedUntil?: string | null;
    [key: string]: unknown;
  };
  screening: { tier: string | null; reasons: Array<{ ref?: string; reason?: string }>; rulesetVersion: number | null; screened: boolean };
  questionnaire: { submitted: boolean; artifactId: string | null; version: number | null; submittedAt: string | null };
  stack: {
    agents: Array<{ id: string; name: string; provider: string; model: string | null; lifecycleStatus: string; halted: boolean; modelCards: Array<{ id: string; intendedUse: string; signOff: string }>; modelCardApproved: boolean }>;
    vendors: Array<{ id: string; name: string; category: string; status: string; linkedVia: string[] }>;
  };
  risks: OverviewRisk[];
  summary: { risks: number; liveRisks: number; liveWithoutControls: number; agentsWithoutApprovedModelCard: number; pendingApprovals: number };
  approvals: Array<{ id: string; status: string; stageId: string; approverUserId: string | null; requestedAt: string; decidedAt: string | null; decisionReason: string | null; dueAt?: string | null }>;
  audit: Array<{ id: string | number; at: string; userId: string | null; ruleId: string; effect: string; reason: string }>;
}
