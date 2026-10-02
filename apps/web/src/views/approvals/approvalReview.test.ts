import { describe, expect, it } from "vitest";
import type { Approval } from "../../api/types";
import { approvalReviewKey, describeBoundTarget, inspectApprovalAction } from "./approvalReview";

const hash = "a".repeat(64);
const raw = (overrides: Partial<Approval> = {}): Approval => ({
  id: "approval", status: "pending", objectType: "mcp_tool", stageId: null,
  requestedAt: "2026-09-30T12:00:00Z", userId: "caller", approverUserId: "approver",
  argumentsPreviewKind: "arguments_v1", approvalScope: "action", argumentsDigest: hash,
  contextDigest: hash, argumentsPreview: { text: "ordinary" }, expiresAt: null, ...overrides,
});
const transformed = (overrides: Partial<Approval> = {}): Approval => raw({
  argumentsPreviewKind: "mcp_redacted_v1",
  argumentsPreview: { schemaDigest: hash, prepared: {
    transformation: { mode: "redact", textVersion: "validated-spans-v1", payloadVersion: "decoded-json-v1", internationalCategories: [] },
    effectiveArguments: { text: "[EMAIL]", password: "[masked]" },
    originalArgumentsDigest: hash, effectiveArgumentsDigest: hash,
  } }, ...overrides,
});

describe("approval action review", () => {
  it("shows the effective action, not the transport envelope", () => {
    const view = inspectApprovalAction(transformed());
    expect(view.kind).toBe("redacted");
    expect(view.blockedReason).toBeNull();
    expect(view.payload).toEqual({ text: "[EMAIL]", password: "[masked]" });
    expect(view.transformation?.schemaDigest).toBe(hash);
  });

  it("never infers redaction from caller-controlled keys", () => {
    const fake = transformed().argumentsPreview;
    const view = inspectApprovalAction(raw({ argumentsPreview: fake, approvalScope: "tool" }));
    expect(view.kind).toBe("arguments");
    expect(view.payload).toBe(fake);
    expect(view.transformation).toBeUndefined();
    expect(view.blockedReason).toBeNull();
  });

  it("an empty argument bag is a real preview", () => {
    expect(inspectApprovalAction(raw({ argumentsPreview: {} })).blockedReason).toBeNull();
  });

  it.each([null, undefined, "", [], "<script>bad()</script>"])("refuses invalid argument bags: %j", (argumentsPreview) => {
    expect(inspectApprovalAction(raw({ argumentsPreview })).blockedReason).not.toBeNull();
  });

  it("shows a legacy preview without manufacturing its provenance", () => {
    const view = inspectApprovalAction(raw({ argumentsPreviewKind: null, approvalScope: null }));
    expect(view.kind).toBe("legacy");
    expect(view.payload).toEqual({ text: "ordinary" });
    expect(view.blockedReason).toContain("fresh request");
  });

  it.each([
    { argumentsDigest: null }, { contextDigest: null }, { argumentsDigest: "not-a-hash" },
    { approvalScope: null }, { expiresAt: "not-a-date" },
  ] as Partial<Approval>[])("incomplete bindings cannot be approved: %j", (fields) => {
    expect(inspectApprovalAction(raw(fields)).blockedReason).not.toBeNull();
  });

  it("expires at the exact boundary without mutating the row", () => {
    const value = raw({ expiresAt: "2026-09-30T12:00:00Z" });
    const at = Date.parse(value.expiresAt!);
    expect(inspectApprovalAction(value, at - 1).blockedReason).toBeNull();
    expect(inspectApprovalAction(value, at).blockedReason).toContain("expired");
    expect(value.status).toBe("pending");
  });

  it.each([
    { argumentsPreview: {} }, { argumentsPreview: null }, { approvalScope: "tool" },
    { argumentsPreview: { schemaDigest: hash, prepared: { effectiveArguments: {} } } },
  ] as Partial<Approval>[])("refuses malformed redaction metadata: %j", (fields) => {
    const view = inspectApprovalAction(transformed(fields));
    expect(view.kind).toBe("invalid");
    expect(view.payload).toBeUndefined();
    expect(view.blockedReason).not.toBeNull();
  });

  it.each([
    { id: "new-id" }, { argumentsDigest: "b".repeat(64) }, { contextDigest: "b".repeat(64) },
    { approvalScope: "tool" }, { argumentsPreviewKind: "mcp_redacted_v1" }, { expiresAt: "2030-01-01T00:00:00Z" },
    { boundTarget: { host: "mcp-b.internal:9000", allowPrivateRanges: null, admissionManifestDigest: null } },
  ] as Partial<Approval>[])("review cannot transfer across a changed binding: %j", (fields) => {
    expect(approvalReviewKey(raw(fields))).not.toBe(approvalReviewKey(raw()));
  });
});

describe("AER-039 — the review names the bound MCP target", () => {
  it("shows the recorded host, private-range posture and a short manifest digest", () => {
    const view = describeBoundTarget(raw({
      boundTarget: { host: "mcp-b.internal:9000", allowPrivateRanges: false, admissionManifestDigest: "1a2b3c4d5e6f7a8b" },
    }));
    expect(view).toBe("mcp-b.internal:9000 · private ranges blocked · manifest 1a2b3c4d");
  });

  it("says what the posture and manifest were, including inherited and unscanned", () => {
    expect(describeBoundTarget(raw({ boundTarget: { host: "127.0.0.1:4100", allowPrivateRanges: true, admissionManifestDigest: null } })))
      .toBe("127.0.0.1:4100 · private ranges allowed · manifest not scanned");
    expect(describeBoundTarget(raw({ boundTarget: { host: "[::1]:4100", allowPrivateRanges: null, admissionManifestDigest: "zz" } })))
      .toBe("[::1]:4100 · private ranges per org default · manifest not recorded");
  });

  it.each([undefined, null, "mcp-b.internal", []] as unknown[])("an unrecorded target is never invented: %j", (boundTarget) => {
    expect(describeBoundTarget(raw({ boundTarget } as Partial<Approval>))).toBe("Not recorded");
  });

  it("never renders anything but a host (a URL can carry credentials)", () => {
    const view = describeBoundTarget(raw({
      boundTarget: { host: "user:secret@mcp-b.internal/path", allowPrivateRanges: null, admissionManifestDigest: null },
    }));
    expect(view).not.toContain("secret");
    expect(view.startsWith("host not recorded")).toBe(true);
  });
});

describe("approval stage labels never show a raw platform sentinel", () => {
  it("names every stage sentinel the gateway emits, and humanizes unknown ones", async () => {
    const { approvalStageLabel } = await import("../../api/format");
    const cases: Array<[string, string]> = [
      ["__remediation__:x", "Governance remediation"],
      ["__model_card__:x", "Model card"],
      ["__grant_cert__:x", "Access certification"],
      ["__sod_override__:x", "Separation-of-duties override"],
      ["__infra_action__:x", "Infra action"],
      ["__infra_remediation__:x", "Infra remediation"],
      ["__nodebudget__:x", "Worker budget"],
      ["__nodebudget_measured__:x", "Worker budget"],
      ["__spend_anomaly__", "Spend anomaly"],
      ["__project_budget__", "Budget overage"],
      ["__budget__:x", "Run budget"],
      ["__reclassification__", "Reclassification"],
      ["__future_kind__:abc", "Future kind"],
    ];
    for (const [stageId, label] of cases) expect(approvalStageLabel({ stageId })).toBe(label);
    expect(approvalStageLabel({ stageId: "signoff" })).toBeNull();
  });
});
