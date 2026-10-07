/**
 * ADR-0186 B (and A) — what an approver SIGNS, and what a step-up is BOUND TO.
 * Pure half, next to ADR-0104's `approval-binding.ts`.
 *
 * A passkey-signed approval (B) is a WebAuthn assertion whose challenge is not
 * a random nonce but the digest of the exact call being approved:
 *
 *   challenge = base64url( sha256( canonicalJson({
 *     v: "regulait.approval-sign.v1", approvalId, decision,
 *     argumentsDigest, contextDigest, serverId | connectorId, toolName, nonce }) ) )
 *
 * `argumentsDigest` is ADR-0104's consent fingerprint over the RAW arguments
 * and `contextDigest` ADR-0105's policy fingerprint, so the signature covers
 * the same two facts the queue row is bound by. The gateway stores the payload
 * and the assertion with the decision, and at execution recomputes both
 * digests from the call actually run and re-verifies every approving
 * signature against them (`consumeBoundApproval`). The nonce is the server's,
 * single use, so a captured assertion cannot be replayed onto a second
 * decision of the same call.
 *
 * A step-up grant (A) is bound to `actionDigest = sha256(canonicalJson({v:
 * "regulait.step-up.v1", kind, facts}))`, where `facts` are the request facts
 * the SERVER derives from the request being authorised (never echoed from the
 * client), so a grant made for one action cannot authorise another.
 *
 * ONE CANONICALISER: ADR-0060's `canonicalJson`, as for every other digest in
 * this product.
 */
import { createHash } from "node:crypto";
import { canonicalJson, sha256Hex } from "./audit-chain.js";
import type { ApprovalDecisionValue, StepUpActionKind } from "./batch4.js";

export const APPROVAL_SIGN_VERSION = "regulait.approval-sign.v1";
export const STEP_UP_DIGEST_VERSION = "regulait.step-up.v1";

const HEX64 = /^[0-9a-f]{64}$/;

/** the facts an approver's signature covers */
export interface ApprovalSigningFacts {
  approvalId: string;
  decision: ApprovalDecisionValue;
  /** ADR-0104 consent fingerprint (sha256 hex) */
  argumentsDigest: string;
  /** ADR-0105 policy fingerprint (sha256 hex) */
  contextDigest: string;
  /** exactly one of serverId (an MCP tool call) and connectorId (a connector call) */
  serverId?: string | null;
  connectorId?: string | null;
  toolName: string;
  /** the server's single-use nonce (base64url, at least 16 bytes of entropy) */
  nonce: string;
}

export interface ApprovalSigningPayload {
  v: typeof APPROVAL_SIGN_VERSION;
  approvalId: string;
  decision: ApprovalDecisionValue;
  argumentsDigest: string;
  contextDigest: string;
  serverId?: string;
  connectorId?: string;
  toolName: string;
  nonce: string;
}

/**
 * The payload an approver signs. Throws on a fact that cannot be bound (a
 * missing digest, both or neither of server and connector, an empty nonce):
 * a signature over an incomplete payload would prove less than it claims.
 */
export function approvalSigningPayload(f: ApprovalSigningFacts): ApprovalSigningPayload {
  if (!HEX64.test(f.argumentsDigest)) throw new TypeError("approvalSigningPayload: argumentsDigest must be sha256 hex");
  if (!HEX64.test(f.contextDigest)) throw new TypeError("approvalSigningPayload: contextDigest must be sha256 hex");
  const hasServer = typeof f.serverId === "string" && f.serverId.length > 0;
  const hasConnector = typeof f.connectorId === "string" && f.connectorId.length > 0;
  if (hasServer === hasConnector) {
    throw new TypeError("approvalSigningPayload: exactly one of serverId and connectorId");
  }
  if (!f.toolName) throw new TypeError("approvalSigningPayload: toolName is required");
  if (!/^[A-Za-z0-9_-]{22,}$/.test(f.nonce)) {
    throw new TypeError("approvalSigningPayload: nonce must be base64url with at least 16 bytes");
  }
  return {
    v: APPROVAL_SIGN_VERSION,
    approvalId: f.approvalId,
    decision: f.decision,
    argumentsDigest: f.argumentsDigest,
    contextDigest: f.contextDigest,
    ...(hasServer ? { serverId: f.serverId! } : { connectorId: f.connectorId! }),
    toolName: f.toolName,
    nonce: f.nonce,
  };
}

/** sha256 of the canonical payload, as raw bytes */
function payloadSha256(payload: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest();
}

/** the signed digest, hex (stored as `approval_decisions.signed_digest`) */
export function approvalSigningDigest(payload: ApprovalSigningPayload): string {
  return payloadSha256(payload).toString("hex");
}

/** the WebAuthn challenge: base64url(sha256(canonical payload)) */
export function approvalSigningChallenge(payload: ApprovalSigningPayload): string {
  return payloadSha256(payload).toString("base64url");
}

/**
 * The digest a step-up grant is bound to. `facts` are the request facts the
 * server derived for the action (e.g. the approval id and decision, or the
 * settings keys being relaxed and their new values) — the same function runs
 * when the grant is issued and when it is spent.
 */
export function stepUpActionDigest(kind: StepUpActionKind, facts: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ v: STEP_UP_DIGEST_VERSION, kind, facts }));
}
