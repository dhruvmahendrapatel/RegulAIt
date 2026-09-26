/**
 * ADR-0124 — resolving the kill switch and safe modes.
 *
 * THE KERNEL DECIDES; THIS FILE LOOKS THINGS UP. The gate itself is a pure
 * function in the policy kernel, consulted before every other rule at all
 * three governed entry points. What it needs is a resolved posture, and this
 * is the ONE place that builds one.
 *
 * WHY ONE PLACE. `execution` is a required field on every kernel input, so the
 * compiler guarantees each of the ~14 call sites supplies something. It cannot
 * guarantee they supply the RIGHT thing. A second copy of "read org_settings,
 * then check whether this subject is halted" would eventually disagree with
 * this one about, say, whether a halted agent outranks a read-only deployment
 * — and the disagreement would show up during an incident. So there is one
 * resolver, and call sites pass its result through.
 *
 * WHAT IS DELIBERATELY NOT GATED. Reading the audit trail, the approvals
 * queue, the posture page and the admin surfaces is never subject to the dial.
 * A kill switch that locked the door behind you would be a worse outage than
 * the one it was thrown for: an operator must be able to see what is happening
 * and lift the halt. This is enforced by construction rather than by an
 * exemption list — the dial lives in the three EXECUTION entry points, and
 * read routes do not pass through them.
 *
 * WHAT ELSE KEEPS RUNNING, ON PURPOSE. The scheduler's own governance sweeps
 * (model-card expiry, admission re-scan, red-team, SLA timers) are the product
 * governing ITSELF, not user work. They keep running while the deployment is
 * halted, because going blind during an incident is the opposite of what a
 * halt is for. They perform no user dispatch, so they execute nothing a halt
 * is meant to stop.
 */

import {
  agents,
  eq,
  and,
  mcpTools,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import type { ExecutionMode, ExecutionPosture, SubjectHalt } from "@regulait/policy-kernel";
import { loadOrgSettings } from "./org-settings.js";

/**
 * The subject an evaluation is about, so its own halt can be found.
 *
 * Absent ids mean "this path has no such subject" — a model dispatch has no
 * tool, a tool call has no agent — not "do not check".
 */
export interface ExecutionSubject {
  agentId?: string | null;
  serverId?: string | null;
  toolName?: string | null;
}

/** the shipped posture: the dial adds nothing to any decision */
const NORMAL: ExecutionPosture = { mode: "normal" };

/**
 * Resolve the posture for one evaluation.
 *
 * TWO QUERIES AT MOST, and usually one: org settings are read on nearly every
 * governed call already, and the subject lookup only happens when the caller
 * names a subject. The halt columns carry partial indexes covering exactly the
 * halted rows, because the answer is almost always "no".
 */
export async function resolveExecutionPosture(
  db: Db,
  subject: ExecutionSubject = {},
  /** pass the already-loaded row to avoid a second read on hot paths */
  settings?: OrgSettingsRow,
): Promise<ExecutionPosture> {
  const org = settings ?? (await loadOrgSettings(db));
  const mode = org.executionMode as ExecutionMode;
  const approverUserId = org.executionModeApproverUserId ?? null;
  const subjectHalt = await resolveSubjectHalt(db, subject);
  // `mode` and `subjectHalt` are independent: a halted tool is refused even
  // while the deployment as a whole is `normal`, which is the entire point of
  // a per-capability stop.
  return subjectHalt ? { mode, approverUserId, subjectHalt } : { mode, approverUserId };
}

async function resolveSubjectHalt(
  db: Db,
  subject: ExecutionSubject,
): Promise<SubjectHalt | null> {
  if (subject.agentId) {
    const [row] = await db
      .select({ name: agents.name, haltedAt: agents.haltedAt, reason: agents.haltedReason })
      .from(agents)
      .where(eq(agents.id, subject.agentId));
    if (row?.haltedAt) {
      return {
        scope: "agent",
        label: `'${row.name}'`,
        reason: row.reason ?? "(no reason recorded)",
        haltedAt: row.haltedAt.toISOString(),
      };
    }
  }
  if (subject.serverId && subject.toolName) {
    const [row] = await db
      .select({ haltedAt: mcpTools.haltedAt, reason: mcpTools.haltedReason })
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, subject.serverId), eq(mcpTools.name, subject.toolName)));
    if (row?.haltedAt) {
      return {
        scope: "tool",
        label: `'${subject.toolName}'`,
        reason: row.reason ?? "(no reason recorded)",
        haltedAt: row.haltedAt.toISOString(),
      };
    }
  }
  return null;
}

/**
 * Read the ORG DIAL alone, for callers that resolve subject halts themselves.
 *
 * Most dispatch paths evaluate a CLOSURE over many candidate agents, and each
 * candidate's row is already in hand. Querying per candidate would be N round
 * trips for an answer that is almost always "not halted", so those paths read
 * the dial once with this and build each subject's halt from its own row with
 * `agentHaltOf` / `toolHaltOf`.
 */
export async function loadExecutionMode(
  db: Db,
  settings?: OrgSettingsRow,
): Promise<ExecutionMode> {
  const org = settings ?? (await loadOrgSettings(db));
  return org.executionMode as ExecutionMode;
}

/**
 * The dial PLUS its approver, for paths that can queue.
 *
 * Only the MCP tool path needs this: it is the one path that turns
 * `require_approval` into a real queued approval, and `approvals`
 * .approver_user_id is NOT NULL.
 */
export async function loadExecutionDial(
  db: Db,
  settings?: OrgSettingsRow,
): Promise<{ mode: ExecutionMode; approverUserId: string | null }> {
  const org = settings ?? (await loadOrgSettings(db));
  return {
    mode: org.executionMode as ExecutionMode,
    approverUserId: org.executionModeApproverUserId ?? null,
  };
}

/** A row that carries the three halt columns — agents and mcp_tools both do. */
interface HaltableRow {
  haltedAt?: Date | null;
  haltedReason?: string | null;
}

/** PURE: turn an already-loaded agent row into its halt, or null. */
export function agentHaltOf(
  row: (HaltableRow & { name?: string | null }) | null | undefined,
): SubjectHalt | null {
  if (!row?.haltedAt) return null;
  return {
    scope: "agent",
    label: row.name ? `'${row.name}'` : "(unnamed)",
    reason: row.haltedReason ?? "(no reason recorded)",
    haltedAt: row.haltedAt.toISOString(),
  };
}

/** PURE: turn an already-loaded tool row into its halt, or null. */
export function toolHaltOf(
  row: (HaltableRow & { name?: string | null }) | null | undefined,
): SubjectHalt | null {
  if (!row?.haltedAt) return null;
  return {
    scope: "tool",
    label: row.name ? `'${row.name}'` : "(unnamed)",
    reason: row.haltedReason ?? "(no reason recorded)",
    haltedAt: row.haltedAt.toISOString(),
  };
}

/** Compose a dial reading and a resolved subject halt into one posture. */
export function postureOf(mode: ExecutionMode, halt: SubjectHalt | null): ExecutionPosture {
  return halt ? { mode, subjectHalt: halt } : { mode };
}

/**
 * For the handful of paths that evaluate WITHOUT executing — a dry run, a
 * policy simulation, an access preview, a discovery filter.
 *
 * NAMED SO IT READS AS A CLAIM. A caller reaching for this is asserting "this
 * evaluation executes nothing", and that claim is checkable in review. It
 * exists because a preview that reported "denied — the deployment is halted"
 * would tell an operator nothing about the policy they were previewing, which
 * is the question they actually asked.
 */
export const EVALUATION_ONLY_EXECUTION: ExecutionPosture = NORMAL;

/** What the dial means, in one sentence each — used by the API and the UI so
 * the explanation cannot drift from the enum. */
export const EXECUTION_MODE_NOTES: Record<ExecutionMode, string> = {
  normal:
    "Nothing is added to any decision. This is what every deployment ships as, and what an " +
    "upgrade leaves you in.",
  read_only:
    "Reads are served; anything that writes is refused — a write MCP tool, a connector write, " +
    "or a dispatch in a mutating mode (plan, review, chat, ask and read still run).",
  require_approval:
    "Nothing runs unattended. An MCP tool call is QUEUED for human sign-off; model dispatch and " +
    "connector calls are REFUSED instead, because those paths have no per-call approval queue — " +
    "use read-only if reads should keep flowing.",
  halted:
    "The kill switch: every governed call is refused. Reading the audit trail, the approvals " +
    "queue and this page is unaffected, so the halt can be investigated and lifted.",
};
