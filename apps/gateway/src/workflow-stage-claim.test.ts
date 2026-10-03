/**
 * REL-06 — a workflow stage's execution claim EXPIRES.
 *
 * `runGitExecutions` claims a stage by writing `context.executing = stageId`
 * in its own transaction before the provider call, and released it only on
 * the success/failure branches. A process killed mid-stage (a deploy, an
 * OOM, Ctrl-C) left the claim set forever: every later `/advance` hit
 * "not currently executable" (409), and the only exit was `/abort` — losing
 * the instance's artifacts, sign-offs and audit linkage.
 *
 * Now the claim carries `executingSince`, a claim older than the TTL is
 * re-takeable (and the re-take is audited as `workflow-stage-claim-expired`),
 * and an unexpected throw between claim and release clears it.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_STAGE_CLAIM_TTL_MS, stageClaimState, stageClaimTtlMs } from "./workflows.js";

const T0 = Date.parse("2026-10-02T12:00:00Z");

describe("stageClaimState — the decision the FOR UPDATE block makes", () => {
  it("no claim at all: not held, nothing expired", () => {
    expect(stageClaimState({}, "build", T0)).toEqual({ heldLive: false, expiredSince: null });
    expect(stageClaimState({ executing: "checks" }, "build", T0)).toEqual({ heldLive: false, expiredSince: null });
  });

  it("a claim taken just now is LIVE — a concurrent executor is refused", () => {
    const ctx = { executing: "build", executingSince: new Date(T0 - 1_000).toISOString() };
    expect(stageClaimState(ctx, "build", T0)).toEqual({ heldLive: true, expiredSince: null });
  });

  it("a claim older than the TTL is EXPIRED and re-takeable, carrying when it was taken", () => {
    const since = new Date(T0 - DEFAULT_STAGE_CLAIM_TTL_MS - 1).toISOString();
    expect(stageClaimState({ executing: "build", executingSince: since }, "build", T0)).toEqual({
      heldLive: false,
      expiredSince: since,
    });
    // exactly at the TTL counts as expired too (`<` is live, not `<=`)
    const edge = new Date(T0 - DEFAULT_STAGE_CLAIM_TTL_MS).toISOString();
    expect(stageClaimState({ executing: "build", executingSince: edge }, "build", T0).heldLive).toBe(false);
  });

  it("a pre-REL-06 claim with no timestamp is treated as expired, never as held forever", () => {
    expect(stageClaimState({ executing: "build" }, "build", T0)).toEqual({ heldLive: false, expiredSince: "unknown" });
    expect(stageClaimState({ executing: "build", executingSince: "garbage" }, "build", T0).heldLive).toBe(false);
  });

  it("the TTL is env-tunable and falls back on a malformed value", () => {
    expect(stageClaimTtlMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_STAGE_CLAIM_TTL_MS);
    expect(stageClaimTtlMs({ REGULAIT_WORKFLOW_CLAIM_TTL_MS: "60000" } as NodeJS.ProcessEnv)).toBe(60_000);
    expect(stageClaimTtlMs({ REGULAIT_WORKFLOW_CLAIM_TTL_MS: "soon" } as NodeJS.ProcessEnv)).toBe(DEFAULT_STAGE_CLAIM_TTL_MS);
    const ctx = { executing: "build", executingSince: new Date(T0 - 90_000).toISOString() };
    expect(stageClaimState(ctx, "build", T0, 60_000).heldLive).toBe(false);
    expect(stageClaimState(ctx, "build", T0, 120_000).heldLive).toBe(true);
  });
});
