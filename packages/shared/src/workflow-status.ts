/**
 * The workflow instance statuses an instance ends in (the kernel's `InstanceStatus`, packages/workflow-kernel).
 * Declared once (rule 12): the gateway's open-instance reads, the partial indexes in packages/db (schema.ts and
 * migrate.ts's CONCURRENT_INDEXES) and the ADR-0349 start-conflict lookup all build from this list, so a lookup and
 * the index it relies on cannot disagree about which instances are open. ADR-0348's state-machine declarations are
 * the place to fold it into once the workflow instance machine is declared there.
 */
export const WORKFLOW_TERMINAL_STATUSES = ["completed", "aborted", "denied", "rolled_back"] as const;
export type WorkflowTerminalStatus = (typeof WORKFLOW_TERMINAL_STATUSES)[number];

export function isWorkflowTerminalStatus(status: string): status is WorkflowTerminalStatus {
  return (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** `'completed', 'aborted', 'denied', 'rolled_back'`, for a static index predicate (`status NOT IN (...)`) */
export const WORKFLOW_TERMINAL_STATUSES_SQL_LIST = WORKFLOW_TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");
