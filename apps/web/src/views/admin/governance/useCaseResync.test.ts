/** ADR-0189 R25 item 13 follow-up — the posture page's re-sync action. */
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { resyncOutcomeText, resyncRefusalText, resyncUseCase } from "./useCaseResync";

const calls = vi.hoisted(() => ({ post: [] as unknown[][], withStepUp: 0 }));
vi.mock("../../../stepup/stepUp", () => ({
  api: {
    post: async (...args: unknown[]) => {
      calls.post.push(args);
      return { useCaseId: "u1", status: "approved", resynced: true };
    },
  },
  withStepUp: async <T,>(call: (h: Record<string, string>) => Promise<T>) => {
    calls.withStepUp += 1;
    return call({ "x-regulait-step-up": "rgsu_t" });
  },
}));

describe("resyncUseCase", () => {
  it("posts to the re-sync route through the step-up helper, with the grant header it is handed", async () => {
    const out = await resyncUseCase("u1");
    expect(calls.withStepUp).toBe(1);
    expect(calls.post).toEqual([["/v1/use-cases/u1/resync", {}, { "x-regulait-step-up": "rgsu_t" }]]);
    expect(out.status).toBe("approved");
  });
});

describe("resyncRefusalText", () => {
  it("names each refusal the route gives in words an admin can act on", () => {
    expect(resyncRefusalText(new ApiError(409, { error: "bom_signing_unavailable" }))).toMatch(/signing key/);
    expect(resyncRefusalText(new ApiError(409, { error: "use_case_edited_after_completion" }))).toMatch(/edited after/);
    expect(resyncRefusalText(new ApiError(403, { error: "bootstrap_cannot_drive" }))).toMatch(/Sign in as an administrator/);
    expect(resyncRefusalText(new ApiError(409, { error: "no_completion_record" }))).toMatch(/no record of its intake workflow completing/);
    expect(resyncRefusalText(new ApiError(409, { error: "eu_tier_changed_since_completion" }))).toMatch(/tier would change/);
  });
  it("falls back to the error's own message", () => {
    expect(resyncRefusalText(new Error("boom"))).toBe("boom");
  });
});

describe("resyncOutcomeText", () => {
  it("says what changed, and says so when nothing did", () => {
    expect(resyncOutcomeText({ useCaseId: "u1", status: "approved", resynced: true })).toBe("Use case u1 re-synced: now approved.");
    expect(resyncOutcomeText({ useCaseId: "u1", status: "under_review", resynced: false })).toMatch(/already in step \(under review\)/);
    expect(resyncOutcomeText({ useCaseId: "u1", status: "approved", resynced: true, approvalExpired: true })).toMatch(/already expired/);
  });
});
