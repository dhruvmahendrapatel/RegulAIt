/**
 * ADR-0186 A2+B — the browser half of a tool-call decision: passkey mode signs
 * the exact call (signing options → passkey prompt → decide with the
 * assertion), step_up mode goes through `withStepUp`, off and every other
 * approval kind is a plain decide; quorum progress; refusals as sentences.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { approvalRuleBody } from "../admin/governance/approvalRuleForm";
import { decideApproval, isToolCallApproval, quorumProgress, signedDecisionErrorText, type SignedDecideDeps } from "./signedDecision";

function deps(over: Partial<SignedDecideDeps> = {}) {
  const calls: Array<{ path: string; body: unknown; headers?: Record<string, string> }> = [];
  const d: SignedDecideDeps = {
    post: vi.fn(async (path: string, body: unknown, headers?: Record<string, string>) => {
      calls.push({ path, body, ...(headers ? { headers } : {}) });
      if (path.endsWith("/signing-options")) {
        return { challengeId: "c-1", options: { challenge: "q83v", rpId: "localhost" }, signedPayload: {} } as never;
      }
      return { status: "approved" } as never;
    }) as SignedDecideDeps["post"],
    authenticate: vi.fn(async () => ({ id: "cred", type: "public-key" })),
    stepUp: vi.fn(async (call) => call({ "x-regulait-step-up": "rgsu_x" })) as SignedDecideDeps["stepUp"],
    ...over,
  };
  return { d, calls };
}

describe("decideApproval", () => {
  it("passkey mode: signing options for THIS decision, the prompt over the gateway's options, then the decide with the assertion", async () => {
    const { d, calls } = deps();
    await decideApproval({ id: "a1", objectType: "mcp_tool", signatureMode: "passkey" }, "approved", "looks right", d);
    expect(calls).toEqual([
      { path: "/v1/approvals/a1/signing-options", body: { decision: "approved" } },
      {
        path: "/v1/approvals/a1/decide",
        body: { decision: "approved", reason: "looks right", passkey: { challengeId: "c-1", response: { id: "cred", type: "public-key" } } },
      },
    ]);
    expect(d.authenticate).toHaveBeenCalledWith({ challenge: "q83v", rpId: "localhost" });
  });

  it("an approval with no recorded mode is treated as the strict default (passkey)", async () => {
    const { d, calls } = deps();
    await decideApproval({ id: "a2", objectType: "connector_call" }, "denied", undefined, d);
    expect(calls.map((c) => c.path)).toEqual(["/v1/approvals/a2/signing-options", "/v1/approvals/a2/decide"]);
  });

  it("a cancelled passkey prompt decides nothing", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    const { d, calls } = deps({ authenticate: vi.fn(async () => Promise.reject(cancelled)) });
    await expect(decideApproval({ id: "a3", objectType: "mcp_tool" }, "approved", undefined, d)).rejects.toBe(cancelled);
    expect(calls.map((c) => c.path)).toEqual(["/v1/approvals/a3/signing-options"]);
    expect(signedDecisionErrorText(cancelled)).toMatch(/cancelled or timed out, so nothing was decided/);
  });

  it("step_up mode runs the decide through the step-up helper; off and other kinds are a plain decide", async () => {
    const step = deps();
    await decideApproval({ id: "a4", objectType: "mcp_tool", signatureMode: "step_up" }, "approved", undefined, step.d);
    expect(step.d.stepUp).toHaveBeenCalledTimes(1);
    expect(step.calls).toEqual([{ path: "/v1/approvals/a4/decide", body: { decision: "approved" }, headers: { "x-regulait-step-up": "rgsu_x" } }]);
    for (const row of [
      { id: "a5", objectType: "mcp_tool", signatureMode: "off" as const },
      { id: "a6", objectType: "workflow", signatureMode: "passkey" as const },
    ]) {
      const plain = deps();
      await decideApproval(row, "approved", undefined, plain.d);
      expect(plain.calls).toEqual([{ path: `/v1/approvals/${row.id}/decide`, body: { decision: "approved" } }]);
      expect(plain.d.authenticate).not.toHaveBeenCalled();
    }
  });
});

describe("quorum progress and refusals", () => {
  it("says where a tool-call approval stands; nothing for other kinds", () => {
    expect(quorumProgress({ objectType: "mcp_tool", quorum: 2, approvalsCount: 1 })).toEqual({ count: 1, quorum: 2, label: "1 of 2 approvals" });
    expect(quorumProgress({ objectType: "connector_call", quorum: 1, approvalsCount: 0 })?.label).toBe("0 of 1 approval");
    expect(quorumProgress({ objectType: "workflow", quorum: 2, approvalsCount: 1 })).toBeNull();
    expect(isToolCallApproval({ objectType: "model_card" })).toBe(false);
  });

  it("every gateway refusal of a signed decision reads as a sentence", () => {
    for (const code of [
      "passkey_signature_required",
      "passkey_signature_invalid",
      "passkey_challenge_expired",
      "passkey_challenge_used",
      "approval_action_changed",
      "passkey_rp_unconfigured",
      "duplicate_approver",
      "caller_cannot_approve",
      "approval_requires_individual_signature",
    ]) {
      const text = signedDecisionErrorText(new ApiError(409, { error: code }));
      expect(text, code).not.toContain(code);
      expect(text.length, code).toBeGreaterThan(20);
    }
    expect(signedDecisionErrorText(new ApiError(403, { error: "passkey_signature_required", enrolled: false }))).toMatch(/Account page/);
  });
});

describe("approval rule form", () => {
  it("posts quorum only above 1 and the approver role only when chosen", () => {
    const subject = { scope: "user", userId: "u1", serverScope: "server", serverId: "s1" };
    expect(approvalRuleBody(subject, { approverUserId: "u2" })).toEqual({ ...subject, approverUserId: "u2" });
    expect(approvalRuleBody(subject, { approverUserId: "u2", quorum: "3", approverRoleId: "r1" })).toEqual({
      ...subject,
      approverUserId: "u2",
      quorum: 3,
      approverRoleId: "r1",
    });
  });
});
