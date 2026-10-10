import { auditLog, type Db } from "@regulait/db";
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

/** AER-048 (review item 1): who/what an external effect is recorded against.
 * When given, every provider call that is actually MADE writes one audit row
 * (`external-effect:<operation>`) — performed or failed — so an effect whose
 * result is later discarded is still on the one trail. `summarize` picks the
 * identifying, non-sensitive fields of the result (ids, never credentials or
 * provider detail strings). */
export interface ExternalWriteAudit<T> {
  userId: string;
  objectType: (typeof auditLog.$inferInsert)["objectType"];
  objectId: string;
  detail?: Record<string, unknown>;
  summarize?: (result: T) => Record<string, unknown>;
}

/** Re-read the dial after preparation, immediately before the provider call. */
export async function runExternalWrite<T>(
  db: Db,
  operation: ExternalWriteOperation,
  call: () => Promise<T>,
  audit?: ExternalWriteAudit<T>,
): Promise<T> {
  const mode = await loadExecutionMode(db);
  if (mode !== "normal") throw new ExternalEffectBlockedError(operation, mode);
  if (!audit) return call();
  const record = (outcome: "performed" | "failed", extra: Record<string, unknown>) =>
    db.insert(auditLog).values({
      userId: audit.userId,
      objectType: audit.objectType,
      objectId: audit.objectId,
      detail: { operation, outcome, ...(audit.detail ?? {}), ...extra, receiptClass: "excluded" },
      effect: "allow",
      ruleId: `external-effect:${operation}`,
      ruleChain: [],
      reason: `external write '${operation}' ${outcome === "performed" ? "performed" : "attempted and failed"}`,
    });
  let result: T;
  try {
    result = await call();
  } catch (err) {
    await record("failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  await record("performed", audit.summarize ? audit.summarize(result) : {});
  return result;
}
