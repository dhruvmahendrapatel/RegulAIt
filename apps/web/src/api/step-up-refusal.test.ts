/**
 * ADR-0186 A — the client side of step-up (foundation): a 403
 * `step_up_required` from any call is announced to the step-up prompt and
 * still throws its ApiError; nothing else is announced; batch-4 refusal codes
 * read as sentences.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, codeSentence, onStepUpRequired, STEP_UP_HEADER, type StepUpRequest } from "./client";
import { BATCH4_REFUSAL_SENTENCES, REFUSAL_GUIDANCE, refusalGuidance } from "./refusals";

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onStepUpRequired (ADR-0186 A)", () => {
  it("a 403 step_up_required is announced with the action kind and methods, and the call still throws", async () => {
    const body = { error: "step_up_required", actionKind: "approval_decide", methods: ["passkey", "totp", 7] };
    vi.stubGlobal("fetch", respond(403, body));
    const seen: StepUpRequest[] = [];
    const off = onStepUpRequired((r) => seen.push(r));
    try {
      const err = await api.post("/v1/approvals/x/decide", { decision: "approved" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
      expect((err as ApiError).payload.error).toBe("step_up_required");
      expect(seen).toEqual([
        { actionKind: "approval_decide", methods: ["passkey", "totp"], method: "POST", path: "/v1/approvals/x/decide", payload: body },
      ]);
    } finally {
      off();
    }
    // unsubscribed: no further announcements
    vi.stubGlobal("fetch", respond(403, body));
    await api.get("/v1/x").catch(() => undefined);
    expect(seen).toHaveLength(1);
  });

  it("other refusals are not announced; a listener that throws does not change the refusal", async () => {
    const seen: StepUpRequest[] = [];
    const off1 = onStepUpRequired((r) => seen.push(r));
    const off2 = onStepUpRequired(() => {
      throw new Error("listener bug");
    });
    try {
      for (const [status, body] of [
        [403, { error: "forbidden" }],
        [422, { error: "step_up_unavailable" }],
        [409, { error: "step_up_required" }],
      ] as const) {
        vi.stubGlobal("fetch", respond(status, body));
        await expect(api.post("/v1/y", {})).rejects.toBeInstanceOf(ApiError);
      }
      expect(seen).toEqual([]);
      vi.stubGlobal("fetch", respond(403, { error: "step_up_required" }));
      await expect(api.post("/v1/y", {})).rejects.toMatchObject({ status: 403 });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.actionKind).toBeNull();
      expect(seen[0]!.methods).toEqual([]);
    } finally {
      off1();
      off2();
    }
  });

  it("the header name is the gateway's", () => {
    expect(STEP_UP_HEADER).toBe("x-regulait-step-up");
  });
});

describe("batch-4 refusal copy (ADR-0186)", () => {
  it("every batch-4 code reads as a sentence, never as the code", () => {
    for (const [code, sentence] of Object.entries(BATCH4_REFUSAL_SENTENCES)) {
      expect(codeSentence(code), code).toBe(sentence);
      expect(sentence, code).not.toContain("_");
    }
    expect(Object.keys(BATCH4_REFUSAL_SENTENCES)).toEqual(
      expect.arrayContaining([
        "step_up_required",
        "step_up_unavailable",
        "duplicate_approver",
        "quorum_unsatisfiable",
        "approval_requires_individual_signature",
        "chatops_step_up_required",
        "sso_reauth_stale",
        "sso_reauth_identity_mismatch",
        "passkey_signature_required",
        "passkey_signature_invalid",
        "passkey_challenge_expired",
        "passkey_challenge_used",
        "approval_action_changed",
        "passkey_rp_unconfigured",
        "caller_cannot_approve",
        "approval_not_signable",
        "unknown_role",
        "approval_quorum_unsatisfiable",
        "approval_signature_recheck_failed",
        "not_built",
      ]),
    );
  });

  it("422 step_up_unavailable carries guidance to the Account page", () => {
    expect(refusalGuidance(422, { error: "step_up_unavailable" })).toBe(REFUSAL_GUIDANCE.stepUpUnavailable);
    expect(new ApiError(422, { error: "step_up_unavailable" }).message).toBe(REFUSAL_GUIDANCE.stepUpUnavailable.message);
    expect(new ApiError(403, { error: "duplicate_approver", detail: "d" }).message).toContain(
      BATCH4_REFUSAL_SENTENCES.duplicate_approver,
    );
  });
});
