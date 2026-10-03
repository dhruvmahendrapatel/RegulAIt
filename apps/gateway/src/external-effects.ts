import type { Db } from "@regulait/db";
import { loadExecutionMode } from "./execution-posture.js";

/** Every external provider mutation outside the AI/MCP dispatch kernel. */
export const EXTERNAL_WRITE_OPERATIONS = [
  "deploy.deploy",
  "deploy.rollback",
  "git.create_branch",
  "git.open_pull_request",
  "git.merge_pull_request",
  "infra.remediate",
  "pm.create_work_item",
  "pm.update_fields",
  "pm.transition_state",
  "pm.add_comment",
] as const;

export type ExternalWriteOperation = (typeof EXTERNAL_WRITE_OPERATIONS)[number];

export class ExternalEffectBlockedError extends Error {
  readonly statusCode = 409;
  readonly code: string;

  constructor(readonly operation: ExternalWriteOperation, readonly mode: string) {
    super(`external write '${operation}' refused while execution mode is '${mode}'`);
    this.name = "ExternalEffectBlockedError";
    this.code = mode === "halted" ? "execution_halted" :
      mode === "read_only" ? "execution_read_only" : "execution_requires_approval";
  }
}

/** Re-read the dial after preparation, immediately before the provider call. */
export async function runExternalWrite<T>(
  db: Db,
  operation: ExternalWriteOperation,
  call: () => Promise<T>,
): Promise<T> {
  const mode = await loadExecutionMode(db);
  if (mode !== "normal") throw new ExternalEffectBlockedError(operation, mode);
  return call();
}
