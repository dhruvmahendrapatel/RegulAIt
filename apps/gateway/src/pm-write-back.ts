/**
 * ADR-0356 PR 2 — WRITING A PM-TRIGGERED WORKFLOW'S PROGRESS BACK TO ITS WORK ITEM.
 *
 * ONE RECONCILE, DERIVED FROM STORED STATE. `syncPmWriteBacks(instanceId)` reads the instance a PM trigger started and
 * writes back what its stored state says has happened and the item has not yet been told:
 *
 *   started          once, when the workflow is running
 *   signoff_request  once per sign-off stage and round with a pending approval (the plan sign-off first)
 *   approval         once per decided approval (approved, denied, returned), with the connection's own
 *                    `PmMapping.approval` stage map for an approved transition (the ADR-0010 sign-off mirror, which
 *                    skips PM-triggered instances so the item is told once)
 *   pr_link          once per pull-request url the instance recorded
 *   outcome          once, at a terminal status; then the trigger moves running → written_back
 *
 * IDEMPOTENT. Each write-back is recorded in `pm_write_backs` (trigger, kind, source) BEFORE the PM call and the record
 * is released when the call fails, so a successful write-back is made once however often the reconcile runs and a
 * failed one is retried. Every write-back, made or failed, writes an audit row.
 *
 * CALLED FROM the trigger path right after the start, the workflow driving routes' transition hook, the approval
 * decide paths, and a scheduler sweep (the backstop for a transition no route reports, such as an executor's).
 *
 * CONFIGURABLE. What is written where is the trigger settings' `writeBack` section: comments on by default, no item
 * state moved unless an admin names one.
 */
import {
  and,
  approvals,
  asc,
  auditLog,
  eq,
  inArray,
  isNotNull,
  pmConnections,
  pmTriggerSettings,
  pmWorkTriggers,
  pmWriteBacks,
  runAsPrincipalStepIfScoped,
  sql,
  users,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { mappingFor, pmTriggerSourcesOf, resolveApprovalAction, type PmWriteBackKind } from "@regulait/pm-provider";
import { settingsOf } from "./pm-trigger-settings.js";
import { providerFor } from "./pm.js";
import { errMessage } from "./err-serializer.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

const SYSTEM_IDENTITY = "00000000-0000-0000-0000-000000000000";
export const PM_TERMINAL_STATUSES = ["completed", "aborted", "denied", "rolled_back"] as const;
type Terminal = (typeof PM_TERMINAL_STATUSES)[number];
/** the sweep handles at most this many running triggers per pass, oldest first */
export const PM_WRITE_BACK_SWEEP_MAX = 200;
const MAX_URL = 2048;

export const PM_WRITE_BACK_RULE_IDS = {
  written: "pm-write-back-written",
  failed: "pm-write-back-failed",
} as const;

export interface PmWriteBackSummary {
  triggerId: string;
  written: Array<{ kind: PmWriteBackKind; sourceKey: string }>;
  failed: Array<{ kind: PmWriteBackKind; sourceKey: string; error: string }>;
  writtenBack: boolean;
}

const OUTCOME_WORDS: Record<Terminal, string> = {
  completed: "completed",
  aborted: "was aborted",
  denied: "was denied",
  rolled_back: "was rolled back",
};

/** a pull-request url the instance recorded, if it is a bounded http(s) url (untrusted: an executor wrote it) */
function prUrlOf(context: unknown): string | null {
  const v = context !== null && typeof context === "object" ? (context as { prUrl?: unknown }).prUrl : undefined;
  if (typeof v !== "string" || v.length > MAX_URL) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Write back what has happened on `instanceId` since the item was last told. A no-op (null) unless a PM trigger started
 * the instance and is still running. Never throws for a PM-side failure (each is released, audited and retried later).
 */
export function syncPmWriteBacks(db: Db, dataKey: string | undefined, instanceId: string): Promise<PmWriteBackSummary | null> {
  // a request runs it as its principal plus approval_maintenance (it reads the instance's approvals); the webhook route
  // and the scheduler are already in their system scope and run it unchanged
  return runAsPrincipalStepIfScoped("approval_maintenance", "pm.write-back", () => syncInScope(db, dataKey, instanceId));
}

async function syncInScope(db: Db, dataKey: string | undefined, instanceId: string): Promise<PmWriteBackSummary | null> {
  if (!dataKey) return null;
  const [trigger] = await db
    .select()
    .from(pmWorkTriggers)
    .where(and(eq(pmWorkTriggers.instanceId, instanceId), eq(pmWorkTriggers.state, "running")))
    .limit(1);
  if (!trigger) return null;
  const [[conn], [settingsRow], [instance]] = await Promise.all([
    db.select().from(pmConnections).where(eq(pmConnections.id, trigger.connectionId)),
    db.select().from(pmTriggerSettings).where(eq(pmTriggerSettings.connectionId, trigger.connectionId)),
    db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)),
  ]);
  if (!conn || !instance) return null;
  // settings removed or no longer valid: the strict defaults (comments, no state moves) still tell the item
  const wb = (settingsRow ? settingsOf(settingsRow) : null)?.writeBack ?? defaultWriteBack();
  const summary: PmWriteBackSummary = { triggerId: trigger.id, written: [], failed: [], writtenBack: false };
  const actor = trigger.userId ?? SYSTEM_IDENTITY;
  let provider: Awaited<ReturnType<typeof providerFor>> | null = null;
  const pm = async () => (provider ??= await providerFor(db, conn, dataKey, { userId: trigger.userId, detail: { phase: "pm-write-back" } }));

  const once = async (kind: PmWriteBackKind, sourceKey: string, act: () => Promise<Record<string, unknown>>): Promise<boolean> => {
    const [claim] = await db
      .insert(pmWriteBacks)
      .values({ triggerId: trigger.id, kind, sourceKey })
      .onConflictDoNothing()
      .returning({ id: pmWriteBacks.id });
    if (!claim) return true; // already written (or being written by a concurrent pass)
    const detail = { phase: "pm-write-back", connection: conn.name, externalId: trigger.externalId, instanceId, kind, sourceKey };
    try {
      const done = await act();
      await db.insert(auditLog).values({
        userId: actor, objectType: "pm_write_back", objectId: trigger.id, detail: { ...detail, ...done },
        effect: "allow", ruleId: PM_WRITE_BACK_RULE_IDS.written, ruleChain: [],
        reason: `PM connection '${conn.name}': ${kind.replace("_", " ")} written back to item ${trigger.externalId}`,
      });
      summary.written.push({ kind, sourceKey });
      return true;
    } catch (err) {
      const error = errMessage(err).slice(0, 300);
      await db.delete(pmWriteBacks).where(eq(pmWriteBacks.id, claim.id));
      await db.insert(auditLog).values({
        userId: actor, objectType: "pm_write_back", objectId: trigger.id, detail: { ...detail, error },
        effect: "deny", ruleId: PM_WRITE_BACK_RULE_IDS.failed, ruleChain: [],
        reason: `PM connection '${conn.name}': ${kind.replace("_", " ")} could not be written back to item ${trigger.externalId}; it is retried`,
      });
      summary.failed.push({ kind, sourceKey, error });
      return false;
    }
  };
  const comment = async (text: string) => (await pm()).addComment(conn.project, trigger.externalId, text);
  const transition = async (state: string) => (await pm()).transitionState(conn.project, trigger.externalId, state);

  // started
  await once("started", "instance", async () => {
    if (wb.started.state) await transition(wb.started.state);
    if (wb.started.comment) await comment("[RegulAIt] A governed workflow started for this item. Nothing is built until its plan is signed off in RegulAIt.");
    return { state: wb.started.state ?? null };
  });

  const rows = await db
    .select({ id: approvals.id, stageId: approvals.stageId, status: approvals.status, decidedBy: approvals.decidedBy, decisionReason: approvals.decisionReason })
    .from(approvals)
    .where(and(eq(approvals.instanceId, instanceId), eq(approvals.objectType, "workflow"), isNotNull(approvals.stageId)))
    .orderBy(asc(approvals.requestedAt), asc(approvals.id));

  // sign-off requests: one per stage and round with a pending approval
  for (const stageId of [...new Set(rows.filter((r) => r.status === "pending").map((r) => r.stageId!))]) {
    await once("signoff_request", `${stageId}:${instance.round}`, async () => {
      if (wb.signoffRequest.state) await transition(wb.signoffRequest.state);
      if (wb.signoffRequest.comment) await comment(`[RegulAIt] Sign-off requested: stage '${stageId}' is waiting for approval in RegulAIt.`);
      return { stageId, round: instance.round };
    });
  }

  // approvals decided (the ADR-0010 sign-off mirror's behaviour, made once)
  const decided = rows.filter((r) => r.status === "approved" || r.status === "denied" || r.status === "returned");
  const deciders = decided.length
    ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, [...new Set(decided.map((r) => r.decidedBy).filter((v): v is string => !!v))]))
    : [];
  const mapping = mappingFor(conn.provider, conn.mapping ?? undefined);
  for (const a of decided) {
    await once("approval", `${a.id}:${a.status}`, async () => {
      const action = a.status === "approved" ? resolveApprovalAction(mapping, a.stageId!) : ({ kind: "comment" } as const);
      if (action.kind === "transition") await transition(action.state);
      const who = deciders.find((d) => d.id === a.decidedBy)?.email ?? "an approver";
      if (wb.approval.comment || action.kind === "comment") {
        await comment(`[RegulAIt] sign-off '${a.stageId}' ${a.status} by ${who}` + (a.decisionReason ? `: ${a.decisionReason}` : ""));
      }
      return { stageId: a.stageId, decision: a.status, action: action.kind, ...(action.kind === "transition" ? { state: action.state } : {}) };
    });
  }

  // the pull request
  const prUrl = prUrlOf(instance.context);
  if (prUrl) {
    await once("pr_link", prUrl, async () => {
      if (wb.prLink.field) await (await pm()).updateFields(conn.project, trigger.externalId, { [wb.prLink.field]: prUrl });
      if (wb.prLink.comment) await comment(`[RegulAIt] Pull request: ${prUrl}`);
      return { field: wb.prLink.field ?? null };
    });
  }

  // the final outcome, then the trigger is done
  if ((PM_TERMINAL_STATUSES as readonly string[]).includes(instance.status)) {
    const status = instance.status as Terminal;
    const ok = await once("outcome", status, async () => {
      const state = wb.outcome.states[status];
      if (state) await transition(state);
      if (wb.outcome.comment) await comment(`[RegulAIt] The workflow for this item ${OUTCOME_WORDS[status]}.`);
      return { status, state: state ?? null };
    });
    if (ok && summary.failed.length === 0) {
      const moved = await db
        .update(pmWorkTriggers)
        .set({ state: "written_back", updatedAt: sql`now()` })
        .where(and(eq(pmWorkTriggers.id, trigger.id), inArray(pmWorkTriggers.state, pmTriggerSourcesOf("written_back"))))
        .returning({ id: pmWorkTriggers.id });
      if (moved.length === 1) {
        summary.writtenBack = true;
        await db.insert(auditLog).values({
          userId: actor, objectType: "pm_work_trigger", objectId: trigger.id,
          detail: { phase: "pm-write-back", connection: conn.name, externalId: trigger.externalId, instanceId, status },
          effect: "allow", ruleId: "pm-trigger-written-back", ruleChain: [],
          reason: `PM connection '${conn.name}': the outcome of item ${trigger.externalId} (${status}) was written back`,
        });
      }
    }
  }
  return summary;
}

function defaultWriteBack() {
  return {
    started: { comment: true, state: undefined },
    signoffRequest: { comment: true, state: undefined },
    approval: { comment: true },
    prLink: { comment: true, field: undefined },
    outcome: { comment: true, states: {} as Partial<Record<Terminal, string>> },
  };
}

/** The scheduler's backstop: reconcile every running PM trigger (oldest first, bounded). */
export async function runPmWriteBackSweep(db: Db, opts: { dataKey?: string | undefined }): Promise<{ examined: number; written: number; failed: number; writtenBack: number }> {
  const running = await db
    .select({ instanceId: pmWorkTriggers.instanceId })
    .from(pmWorkTriggers)
    .where(and(eq(pmWorkTriggers.state, "running"), isNotNull(pmWorkTriggers.instanceId)))
    .orderBy(asc(pmWorkTriggers.updatedAt))
    .limit(PM_WRITE_BACK_SWEEP_MAX);
  const out = { examined: 0, written: 0, failed: 0, writtenBack: 0 };
  for (const r of running) {
    const s = await syncPmWriteBacks(db, opts.dataKey, r.instanceId!);
    out.examined++;
    if (!s) continue;
    out.written += s.written.length;
    out.failed += s.failed.length;
    if (s.writtenBack) out.writtenBack++;
  }
  return out;
}

/** ADR-0356 PR 2: the backstop sweep, defined here and spread into the registry (scheduler-jobs.ts). */
export function pmWriteBackJobDefinitions(opts: { dataKey?: string | undefined }): SchedulerJobDefinition[] {
  return [
    {
      name: "pm-write-back-sweep",
      description:
        "Write the progress of workflows started from a PM tool back to their work items: the start, sign-off requests, " +
        "sign-off outcomes, the pull request and the final outcome, each once (pm_write_backs) and audited. Catches " +
        "transitions no route reports and retries write-backs that failed.",
      adr: "ADR-0356",
      defaultIntervalSeconds: 5 * 60,
      run: async (ctx) => {
        const out = await runPmWriteBackSweep(ctx.db, opts);
        return { itemsProcessed: out.examined, detail: { ...out } };
      },
    },
  ];
}
