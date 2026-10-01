import type { Approval } from "../../api/types";

const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export interface ActionReview {
  kind: "arguments" | "redacted" | "legacy" | "invalid";
  payload?: Record<string, unknown>;
  blockedReason: string | null;
  transformation?: {
    textVersion: string;
    payloadVersion: string;
    internationalCategories: string[];
    originalDigest: string;
    effectiveDigest: string;
    schemaDigest: string;
  };
}

/** Provenance comes from queue metadata, never from shapes inside a payload. */
export function inspectApprovalAction(approval: Approval, now = Date.now()): ActionReview {
  const preview = approval.argumentsPreview;
  let view: ActionReview;
  if (approval.argumentsPreviewKind === "arguments_v1") {
    view = record(preview)
      ? { kind: "arguments", payload: preview, blockedReason: null }
      : { kind: "invalid", blockedReason: "Recorded arguments are unavailable." };
  } else if (approval.argumentsPreviewKind === "mcp_redacted_v1") {
    const prepared = record(preview) && record(preview.prepared) ? preview.prepared : null;
    const transformation = prepared && record(prepared.transformation) ? prepared.transformation : null;
    if (!record(preview) || !prepared || !transformation || transformation.mode !== "redact" ||
      typeof transformation.textVersion !== "string" || !transformation.textVersion ||
      typeof transformation.payloadVersion !== "string" || !transformation.payloadVersion ||
      !Array.isArray(transformation.internationalCategories) || !transformation.internationalCategories.every((value) => typeof value === "string") ||
      !record(prepared.effectiveArguments) || !digest(prepared.originalArgumentsDigest) ||
      !digest(prepared.effectiveArgumentsDigest) || !digest(preview.schemaDigest) || approval.approvalScope !== "action") {
      view = { kind: "invalid", blockedReason: "The effective action or its binding metadata is unavailable." };
    } else {
      view = {
        kind: "redacted", payload: prepared.effectiveArguments, blockedReason: null,
        transformation: {
          textVersion: transformation.textVersion,
          payloadVersion: transformation.payloadVersion,
          internationalCategories: transformation.internationalCategories,
          originalDigest: prepared.originalArgumentsDigest,
          effectiveDigest: prepared.effectiveArgumentsDigest,
          schemaDigest: preview.schemaDigest,
        },
      };
    }
  } else {
    view = { kind: "legacy", ...(record(preview) ? { payload: preview } : {}), blockedReason: "Approval preview provenance was not recorded. A fresh request is required." };
  }
  if (!view.blockedReason && (!digest(approval.argumentsDigest) || !digest(approval.contextDigest) ||
    !["action", "tool"].includes(approval.approvalScope ?? ""))) {
    view.blockedReason = "Approval binding metadata is incomplete. A fresh request is required.";
  }
  if (!view.blockedReason && approval.expiresAt != null) {
    const expires = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expires)) view.blockedReason = "The recorded approval expiry is invalid.";
    else if (expires <= now) view.blockedReason = "This approval has expired. A fresh request is required.";
  }
  return view;
}

/** A review is not transferable to a different issued action or policy. */
export function approvalReviewKey(approval: Approval): string {
  return JSON.stringify([approval.id, approval.argumentsDigest, approval.contextDigest,
    approval.argumentsPreviewKind, approval.approvalScope, approval.expiresAt]);
}
