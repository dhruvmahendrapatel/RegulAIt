/**
 * The workflow instance statuses an instance ends in, for the packages that cannot import the kernel
 * (`packages/db`'s partial index predicates, and the gateway reads that must agree with those indexes).
 * The kernel's `TERMINAL_STATUSES` (packages/workflow-kernel, ADR-0342) is the source of truth;
 * `zz-adr0349-start-conflict.test.ts` fails if the two lists ever differ. ADR-0348's state-machine declarations
 * are the place to fold both into once the workflow instance machine is declared there.
 */
export const WORKFLOW_TERMINAL_STATUSES = ["completed", "aborted", "denied", "rolled_back"] as const;
export type WorkflowTerminalStatus = (typeof WORKFLOW_TERMINAL_STATUSES)[number];

export function isWorkflowTerminalStatus(status: string): status is WorkflowTerminalStatus {
  return (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** `'completed', 'aborted', 'denied', 'rolled_back'`, for a static index predicate (`status NOT IN (...)`) */
export const WORKFLOW_TERMINAL_STATUSES_SQL_LIST = WORKFLOW_TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");
