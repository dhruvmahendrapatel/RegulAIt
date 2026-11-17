/** ADR-0352: priority metadata and the first-party task-widget projection. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, approvals, auditLog, eq, inArray, type Db } from "@regulait/db";
import { APPROVAL_PRIORITIES, APPROVAL_PRIORITY_MACHINE, approvalPriorityLifecycle, type ApprovalPriority } from "@regulait/shared";
import type { ApprovalListRow } from "./approvals-list.js";

const change = z.object({
  priority: z.enum(APPROVAL_PRIORITIES),
  expectedPriority: z.enum(APPROVAL_PRIORITIES),
}).strict();

export function registerApprovalPriorityRoutes(app: FastifyInstance, db: Db) {
  app.patch("/v1/approvals/:approvalId/priority", async (req, reply) => {
    // Defense in depth: the route classifier also defaults this write to admin.
    if (!req.authCtx.isAdmin) return reply.status(403).send({ error: "admin_required" });
    const { approvalId } = z.object({ approvalId: z.string().uuid() }).parse(req.params);
    const body = change.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
      if (!row) return { status: 404, body: { error: "unknown_approval" } };
      if (row.status !== "pending") return { status: 409, body: { error: "approval_not_pending" } };
      if (row.priority !== body.expectedPriority) return { status: 409, body: { error: "stale_priority" } };
      const event = `set_${body.priority}` as const;
      // A no-op is an idempotent read, not a transition or an audit event.
      if (row.priority === body.priority) return { status: 200, body: { id: row.id, priority: row.priority, changed: false } };
      const priority = APPROVAL_PRIORITY_MACHINE.next(row.priority, event);
      const [updated] = await tx.update(approvals).set({ priority }).where(and(
        eq(approvals.id, row.id), eq(approvals.status, "pending"), eq(approvals.priority, body.expectedPriority),
        inArray(approvals.priority, [...APPROVAL_PRIORITY_MACHINE.sourcesOf(event)]),
      )).returning({ id: approvals.id, priority: approvals.priority });
      if (!updated) return { status: 409, body: { error: "stale_priority" } };
      // The write and audit share the transaction: neither survives an audit failure.
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "approval",
        objectId: row.id,
        effect: "allow",
        ruleChain: [],
        ruleId: "approval-priority-changed",
        reason: "An administrator changed a pending approval's queue priority.",
        detail: { approvalId: row.id, from: row.priority, to: priority },
      });
      return { status: 200, body: { ...updated, changed: true } };
    });
    return reply.status(result.status).send(result.body);
  });
}

type WidgetRow = ApprovalListRow & {
  assignment?: {
    assigneeKind: string; assigneeId: string; claimedByUserId: string | null;
    slaState: string; warnAt: Date | string | null; dueAt: Date | string | null;
    breachedAt: Date | string | null; escalatedAt: Date | string | null;
  };
};

/** An allowlist, not a spread: no names, previews, arguments, labels, context or decision reasons. */
export function taskWidgetItem(row: WidgetRow, isAdmin: boolean) {
  const priority = row.priority as ApprovalPriority;
  return {
    id: row.id,
    kind: row.objectType,
    status: row.status,
    priority,
    requestedAt: row.requestedAt,
    assignment: row.assignment ? {
      kind: row.assignment.assigneeKind,
      id: row.assignment.assigneeId,
      claimedByUserId: row.assignment.claimedByUserId,
    } : null,
    deadlines: {
      assignment: row.assignment ? {
        source: "approval_assignment",
        state: row.assignment.slaState,
        warnAt: row.assignment.warnAt,
        dueAt: row.assignment.dueAt,
        breachedAt: row.assignment.breachedAt,
        escalatedAt: row.assignment.escalatedAt,
      } : null,
      workflowStage: { available: false, reason: "Current stage-entry deadline projection awaits the workflow SLA contract." },
    },
    priorityLifecycle: approvalPriorityLifecycle(priority, row.status, isAdmin),
    links: {
      // The host opens the existing decision UI; the widget grants no decision authority.
      review: "/inbox",
      priority: isAdmin && row.status === "pending" ? {
        method: "PATCH", href: `/v1/approvals/${row.id}/priority`,
        precondition: { expectedPriority: priority },
      } : null,
    },
  };
}
