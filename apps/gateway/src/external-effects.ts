import { auditLog, type Db } from "@regulait/db";
import { loadExecutionMode } from "./execution-posture.js";
import { errMessage } from "./err-serializer.js";

/** Every external provider mutation outside the AI/MCP dispatch kernel. */
export const EXTERNAL_WRITE_OPERATIONS = [
  "deploy.deploy",
  "deploy.rollback",
  "git.create_branch",
  "git.open_pull_request",
  "git.merge_pull_request",
  // ADR-0340: the compensating git writes a saga runs on cancel or denial
  "git.delete_branch",
  "git.close_pull_request",
  "infra.remediate",
  "pm.create_work_item",
  "pm.update_fields",
  "pm.transition_state",
  "pm.add_comment",
  // ADR-0331: a device-policy signature (an endpoint directive acts on a developer's device only under one)
  "device_policy.sign_payload",
  // ADR-0338: a vendor agent control call. `apply` (disable, quarantine) takes an agent out of service; `reverse`
  // (restore) puts it back
  "vendor_agent_control.apply",
  "vendor_agent_control.reverse",
  // ADR-0361 slice 3: deleting a monitored conversation in a sanctioned AI SaaS tenant (ai-saas-remediation.ts)
  "vendor.delete_conversation",
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

/**
 * ADR-0338 §7 (owner decision 2, 2026-11-17): the one declared exemption from the dial. An operation listed here only
 * takes something out of service (it narrows), so it still runs while the dial is `read_only`, `require_approval` or
 * `halted`; every other operation is refused outside `normal`. The external-effects barrier test pins this list.
 */
export const NARROWING_WRITE_OPERATIONS: readonly ExternalWriteOperation[] = ["vendor_agent_control.apply"];

/** Re-read the dial after preparation, immediately before the provider call. */
export async function runExternalWrite<T>(
  db: Db,
  operation: ExternalWriteOperation,
  call: () => Promise<T>,
  audit?: ExternalWriteAudit<T>,
): Promise<T> {
  const mode = await loadExecutionMode(db);
  if (mode !== "normal" && !NARROWING_WRITE_OPERATIONS.includes(operation)) throw new ExternalEffectBlockedError(operation, mode);
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
    await record("failed", { error: errMessage(err) });
    throw err;
  }
  await record("performed", audit.summarize ? audit.summarize(result) : {});
  return result;
}
