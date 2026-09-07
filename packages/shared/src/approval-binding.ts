/**
 * ADR-0104 — APPROVAL PAYLOAD BINDING, pure half.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An approved Approvals-Queue entry used to say only "user X may call tool T on
 * server S". It said nothing about the ARGUMENTS the approver was looking at
 * when they signed. The queue row carried no arguments, the approved-approval
 * lookup keyed only on user/server/tool/status, and the tool-call audit row
 * recorded no payload either. So an approver signed off on a call they could
 * not see, and the caller could then spend that consent on an entirely
 * different payload — with no forensic record of which payload actually ran.
 *
 * The fix is a FINGERPRINT of the call the consent was granted for, stored on
 * the queue row and re-derived at match time. Two properties make it a
 * fingerprint rather than a hint:
 *
 *  1. It is computed over the CANONICAL form of the payload, so key order —
 *    which neither JSON nor `jsonb` preserves — is not an input. `{a:1,b:2}`
 *    and `{b:2,a:1}` are the same call and must produce the same digest.
 *  2. It is computed on the RAW arguments, BEFORE the ADR-0099 scrub that
 *    produces the approver-facing preview. Redaction changes what a human
 *    reads; it must never be able to change what the consent is FOR. A digest
 *    taken after scrubbing would make two different secrets look like the same
 *    call, and would make a change in the redactor a silent change in consent
 *    identity.
 *
 * ONE CANONICALIZER, DELIBERATELY REUSED
 * --------------------------------------
 * The serialization is ADR-0060's `canonicalJson` (`audit-chain.ts`), not a
 * second implementation. That function already pins recursive key sorting,
 * array order as data, the `undefined`-is-absent rule and the number rule,
 * against the same `jsonb` round trip this digest has to survive. A second
 * canonicalizer that could drift from it is the bug, not the fix — and the
 * writer (the queueing path) and the matcher (the evaluation path) call the one
 * function below rather than either re-deriving anything.
 *
 * WHAT IS IN THE FINGERPRINT
 * --------------------------
 * `projectId` and `arguments`. The project is part of the identity because
 * pillar 5 attributes spend and pillar 4 scopes context per project: consent
 * granted for a call inside project A must not be spendable inside project B,
 * where the same tool with the same arguments reaches different data, bills a
 * different ledger and may sit under a different compliance cascade.
 *
 * The user, server and tool are NOT in the fingerprint because they are already
 * the lookup key — putting them in twice would only make the digest opaque
 * about which dimension failed to match.
 */
import { canonicalJson, sha256Hex } from "./audit-chain.js";
import { scrubAuditDetail } from "./audit-scrub.js";

/** The scope of an approval rule's consent (`approval_rules.approval_scope`). */
export const APPROVAL_SCOPES = ["action", "tool"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/**
 * ADR-0104: consent is ACTION-scoped unless an operator says otherwise. Pillar
 * 1 is default-deny and this codebase's rule idiom is strictest-wins, so the
 * default is the narrow reading of what an approver signed. This constant is
 * the single place that default is written down in TypeScript; the DDL default
 * on the column mirrors it.
 */
export const DEFAULT_APPROVAL_SCOPE: ApprovalScope = "action";

/**
 * Version tag prefixed onto the canonical payload before hashing, exactly as
 * ADR-0060 does for the audit chain. If the field set or the canonicalization
 * ever changes, this string changes with it — so digests computed under the old
 * rules can never silently be compared against digests computed under the new
 * ones. A version bump makes every pre-existing approved row stop matching,
 * which is a re-queue (fail-closed), not an accidental match.
 */
export const APPROVAL_DIGEST_VERSION = "regulait.approval-binding.v1";

/** The identity of a governed tool call's payload, for consent purposes. */
export interface ApprovalPayloadRef {
  /** pillar-5 attribution; `undefined` and `null` are the same "unattributed" */
  projectId?: string | null;
  /**
   * the call arguments as the caller supplied them, PRE-SCRUB. `undefined`,
   * `null` and `{}` all normalize to the empty bag: the MCP surface treats a
   * missing arguments object and an empty one as the same call, so consent
   * must not be able to distinguish them either.
   */
  arguments?: Record<string, unknown> | null | undefined;
}

/** Normalize the arguments bag. Absent, null and `{}` are ONE value — see the
 * field doc above. Exported so the pinning test asserts the rule directly. */
export function normalizeApprovalArguments(
  args: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return args ?? {};
}

/**
 * The consent fingerprint: sha256 hex over the versioned canonical JSON of
 * `{ projectId, arguments }`.
 *
 * Deterministic and pure — no clock, no database, no I/O — so the writer and
 * the matcher cannot disagree, and a test can assert the exact string.
 */
export function approvalArgumentsDigest(ref: ApprovalPayloadRef): string {
  return sha256Hex(
    `${APPROVAL_DIGEST_VERSION}\n${canonicalJson({
      projectId: ref.projectId ?? null,
      arguments: normalizeApprovalArguments(ref.arguments),
    })}`,
  );
}

/**
 * The approver-facing preview stored on the queue row.
 *
 * This is the ADR-0099/0102 scrubber, called — NOT a second redactor. There is
 * exactly one credential-redaction implementation in this repo and this is a
 * new consumer of it, so a rule added there covers this surface for free.
 *
 * The preview is what a human reads; the digest above is what the machine
 * matches. They are deliberately derived from the same raw value in that order,
 * so a secret can be hidden from the approver without the consent it represents
 * moving an inch.
 */
export function approvalArgumentsPreview(
  args: Record<string, unknown> | null | undefined,
): unknown {
  return scrubAuditDetail(normalizeApprovalArguments(args));
}

/**
 * STRICTEST-WINS across every approval rule that matched this call: if ANY of
 * them is action-scoped, the call's consent is action-scoped. A rule body that
 * carries no scope at all (an older `config_versions` version body, say) reads
 * as the default, which is `action` — an absent scope must never be the loose
 * one.
 */
export function effectiveApprovalScope(
  rules: ReadonlyArray<{ approvalScope?: ApprovalScope | null }>,
): ApprovalScope {
  if (rules.length === 0) return DEFAULT_APPROVAL_SCOPE;
  return rules.some((r) => (r.approvalScope ?? DEFAULT_APPROVAL_SCOPE) === "action")
    ? "action"
    : "tool";
}
