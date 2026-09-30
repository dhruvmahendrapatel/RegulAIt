import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalArgumentsDigest, preparePiiApproval, PII_APPROVAL_DIGEST_VERSION } from "./approval-binding.js";
import { AUDIT_SCRUB_MAX_DEPTH, scrubAuditDetail } from "./audit-scrub.js";
import { PiiPayloadError } from "./pii-payload.js";

describe("redacted exact-action consent", () => {
  afterEach(() => {
    vi.doUnmock("./pii.js");
    vi.doUnmock("./pii-payload.js");
    vi.resetModules();
  });

  it("binds distinct originals even when they produce the same effective payload", () => {
    const first = preparePiiApproval({ projectId: "project-a", arguments: { email: "a@b.invalid" } }, []);
    const second = preparePiiApproval({ projectId: "project-a", arguments: { email: "c@d.invalid" } }, []);
    expect(first.effectiveArguments).toEqual(second.effectiveArguments);
    expect(first.effectiveArgumentsDigest).toBe(second.effectiveArgumentsDigest);
    expect(first.originalArgumentsDigest).not.toBe(second.originalArgumentsDigest);
    expect(first.argumentsDigest).not.toBe(second.argumentsDigest);
    expect(first.approvalScope).toBe("action");
  });

  it("does not reuse a legacy raw-only approval even when no PII was found", () => {
    const ref = { arguments: { message: "clean" } };
    expect(preparePiiApproval(ref, []).argumentsDigest).not.toBe(approvalArgumentsDigest(ref));
    expect(PII_APPROVAL_DIGEST_VERSION).toBe("regulait.pii-approval-binding.v1");
  });

  it("binds project attribution and effective non-PII arguments", () => {
    const ref = { projectId: "project-a", arguments: { email: "a@b.invalid", operation: "create" } };
    const prepared = preparePiiApproval(ref, []);
    expect(preparePiiApproval({ ...ref, projectId: "project-b" }, []).argumentsDigest).not.toBe(prepared.argumentsDigest);
    expect(preparePiiApproval({ ...ref, arguments: { ...ref.arguments, operation: "delete" } }, []).argumentsDigest).not.toBe(prepared.argumentsDigest);
    expect(prepared.effectiveArgumentsDigest).toBe(approvalArgumentsDigest({ projectId: ref.projectId, arguments: prepared.effectiveArguments }));
  });

  it("binds enabled categories even when they did not change the content", () => {
    const ref = { arguments: { email: "a@b.invalid" } };
    expect(preparePiiApproval(ref, ["aadhaar"]).argumentsDigest).not.toBe(preparePiiApproval(ref, []).argumentsDigest);
    expect(preparePiiApproval(ref, ["cpf", "aadhaar", "cpf"])).toEqual(preparePiiApproval(ref, ["aadhaar", "cpf"]));
  });

  it("retains canonical object order, array order and absent-argument rules", () => {
    expect(preparePiiApproval({ arguments: { b: 2, a: [1, 2] } }, []).argumentsDigest)
      .toBe(preparePiiApproval({ arguments: { a: [1, 2], b: 2 } }, []).argumentsDigest);
    expect(preparePiiApproval({ arguments: { a: [2, 1], b: 2 } }, []).argumentsDigest)
      .not.toBe(preparePiiApproval({ arguments: { a: [1, 2], b: 2 } }, []).argumentsDigest);
    expect(preparePiiApproval({}, [])).toEqual(preparePiiApproval({ arguments: {} }, []));
    expect(preparePiiApproval({ arguments: null }, [])).toEqual(preparePiiApproval({ arguments: undefined }, []));
  });

  it("makes the effective provider payload immutable and independent of caller mutation", () => {
    const input = { nested: { text: "a@b.invalid", action: "create" } };
    const prepared = preparePiiApproval({ arguments: input }, []);
    input.nested.text = "changed@x.invalid";
    input.nested.action = "delete";
    expect(prepared.effectiveArguments).toEqual({ nested: { text: "[EMAIL]", action: "create" } });
    expect(() => { (prepared.effectiveArguments.nested as { action: string }).action = "delete"; }).toThrow();
    expect(() => { (prepared as { argumentsDigest: string }).argumentsDigest = "other"; }).toThrow();
    expect(() => { (prepared.transformation.internationalCategories as string[]).push("aadhaar"); }).toThrow();
  });

  it("previews the transformed action, never the original PII or provider credential", () => {
    const input = { email: "a@b.invalid", apiKey: "SYNTHETIC-NOT-A-REAL-KEY", operation: "create" };
    const prepared = preparePiiApproval({ arguments: input }, []);
    const preview = prepared.argumentsPreview as Record<string, unknown>;
    expect(preview.effectiveArguments).toEqual(scrubAuditDetail(prepared.effectiveArguments));
    expect(JSON.stringify(preview)).not.toContain("a@b.invalid");
    expect(JSON.stringify(preview)).not.toContain(input.apiKey);
    expect(prepared.effectiveArguments.apiKey).toBe(input.apiKey);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.effectiveArguments)).toBe(true);
    expect(() => { (preview.effectiveArguments as { operation: string }).operation = "delete"; }).toThrow();
  });

  it("preserves __proto__ data in a credential-scrubbed preview", () => {
    const input = JSON.parse('{"__proto__":{"email":"a@b.invalid","apiKey":"SYNTHETIC"},"safe":true}');
    const prepared = preparePiiApproval({ arguments: input }, []);
    const preview = (prepared.argumentsPreview as { effectiveArguments: Record<string, unknown> }).effectiveArguments;
    expect(Object.hasOwn(preview, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(preview)).toBe(Object.prototype);
    expect(JSON.stringify(preview)).toContain("[EMAIL]");
    expect(JSON.stringify(preview)).not.toContain("SYNTHETIC");
    expect(JSON.stringify(prepared.effectiveArguments)).toContain("SYNTHETIC");
  });

  it("refuses unsafe numeric arguments or sensitive keys before preparing consent", () => {
    expect(() => preparePiiApproval({ arguments: { card: 4111111111111111 } }, [])).toThrowError(new PiiPayloadError("unsafe_number"));
    expect(() => preparePiiApproval({ arguments: { "a@b.invalid": "value" } }, [])).toThrowError(new PiiPayloadError("sensitive_key"));
  });

  it("does not allow the preview to exceed the credential scrubber's depth", () => {
    let input: Record<string, unknown> = { apiKey: "SYNTHETIC-DEEP-SECRET" };
    for (let depth = 1; depth < AUDIT_SCRUB_MAX_DEPTH; depth++) input = { nested: input };
    const prepared = preparePiiApproval({ arguments: input }, []);
    expect(JSON.stringify(prepared.argumentsPreview)).not.toContain("SYNTHETIC-DEEP-SECRET");
    expect(() => preparePiiApproval({ arguments: { nested: input } }, [])).toThrowError(new PiiPayloadError("limit_exceeded"));
  });

  it("invalidates approval after a text algorithm version change even without hits", async () => {
    const ref = { arguments: { message: "clean" } };
    const before = preparePiiApproval(ref, []);
    vi.doMock("./pii.js", async (original) => ({ ...await original<typeof import("./pii.js")>(), PII_REDACTION_VERSION: "test-next-text-version" }));
    vi.resetModules();
    const changed = await import("./approval-binding.js");
    const after = changed.preparePiiApproval(ref, []);
    expect(after.effectiveArgumentsDigest).toBe(before.effectiveArgumentsDigest);
    expect(after.argumentsDigest).not.toBe(before.argumentsDigest);
  });

  it("invalidates approval after a structured algorithm version change", async () => {
    const ref = { arguments: { message: "clean" } };
    const before = preparePiiApproval(ref, []);
    vi.doMock("./pii-payload.js", async (original) => ({ ...await original<typeof import("./pii-payload.js")>(), PII_PAYLOAD_VERSION: "test-next-payload-version" }));
    vi.resetModules();
    const changed = await import("./approval-binding.js");
    expect(changed.preparePiiApproval(ref, []).argumentsDigest).not.toBe(before.argumentsDigest);
  });
});
