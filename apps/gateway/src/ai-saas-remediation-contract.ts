/**
 * ADR-0361 slice 3: the contract a sanctioned AI SaaS connector's `remediation` member implements. Gateway-local so the
 * external-effects barrier (external-effects.test.ts CONTRACTS) classifies its write: `deleteConversation` is the
 * operation `vendor.delete_conversation`, run only inside `runExternalWrite` by the approved remediation flow
 * (ai-saas-remediation.ts). `conversationGone` is a read. No vendor is named here.
 */
import type { ConnectorContext } from "./ai-saas-connectors.js";

/** what a remediation acts on: a copy of the interaction's conversation and actor */
export interface RemediationTarget {
  conversationRef: string;
  actorRef: string | null;
}

export interface ConnectorRemediation {
  readonly kind: "vendor";
  /** delete the conversation; `absent` when the vendor says it is already gone (a 404) */
  deleteConversation(ctx: ConnectorContext, target: RemediationTarget): Promise<{ outcome: "deleted" | "absent"; vendorStatus: number }>;
  /**
   * read-only: is the conversation gone? Used to settle an action whose delete call's outcome is unknown. Absent when
   * the vendor documents no read; the settle then repeats the same idempotent delete (a 404 means it is gone).
   */
  conversationGone?(ctx: ConnectorContext, target: RemediationTarget): Promise<boolean>;
}
