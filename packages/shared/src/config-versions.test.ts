import { describe, expect, it } from "vitest";
import {
  applyRuleBody,
  canaryBucket,
  canaryIsEvaluated,
  canaryIsLive,
  canaryIsShadowEvaluated,
  canaryModeNote,
  canaryModeOf,
  evaluatePromotion,
  isRuleArtifact,
  resolveForShadow,
  ruleBodyFrom,
  validateRuleVersionBody,
  fnv1a32,
  promptFromBody,
  resolveVersion,
  stableKeyFor,
  type VersionLike,
} from "./config-versions.js";

/**
 * ADR-0048 — the PURE half, proved by attack.
 *
 * The two things that must not be fakeable here:
 *
 *  1. THE CANARY SPLIT IS DETERMINISTIC. Not "roughly N%" — the SAME key must
 *     land on the SAME side every time, forever, or a multi-turn conversation
 *     flips its base prompt mid-run and a ledger row can no longer be
 *     reproduced. The tests assert exact repeatability and exact bucket values,
 *     so any future "improvement" to the hash breaks loudly instead of silently
 *     re-bucketing every in-flight canary.
 *
 *  2. THE PROMOTION GATE IS A GATE. An eval run that PREDATES the canary never
 *     measured it, and accepting one would make the gate a checkbox.
 */

const A = "11111111-1111-1111-1111-111111111111";

const v = (version: number, status: VersionLike["status"], pct: number | null = null, text = `p${version}`): VersionLike => ({
  id: `v-${version}`,
  version,
  status,
  canaryPct: pct,
  body: { systemPrompt: text },
});

describe("ADR-0048 deterministic bucketing", () => {
  it("is a pure function — the same key always lands in the same bucket", () => {
    const first = canaryBucket(A, "user-7");
    for (let i = 0; i < 50; i++) expect(canaryBucket(A, "user-7")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it("mixes the artifact id, so one unlucky user is not unlucky everywhere", () => {
    const B = "22222222-2222-2222-2222-222222222222";
    const differing = ["u1", "u2", "u3", "u4", "u5", "u6"].filter(
      (k) => canaryBucket(A, k) !== canaryBucket(B, k),
    );
    expect(differing.length).toBeGreaterThan(0);
  });

  it("spreads keys across the range rather than clustering", () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 400; i++) buckets.add(canaryBucket(A, `user-${i}`));
    expect(buckets.size).toBeGreaterThan(50);
  });

  it("pins the hash — a future swap to a different algorithm must break here, loudly", () => {
    // FNV-1a 32-bit of the literal string, so nobody silently re-buckets every
    // in-flight canary by "upgrading" to sha256.
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("prefers the run id, then the conversation, then the user", () => {
    expect(stableKeyFor({ runId: "r", conversationId: "c", userId: "u" })).toBe("r");
    expect(stableKeyFor({ runId: null, conversationId: "c", userId: "u" })).toBe("c");
    expect(stableKeyFor({ userId: "u" })).toBe("u");
  });
});

describe("ADR-0048 resolution", () => {
  it("returns null when nothing is versioned — the behaviour-preserving default", () => {
    expect(
      resolveVersion({ artifactType: "agent_system_prompt", artifactId: A, versions: [], stableKey: "u" }),
    ).toBeNull();
  });

  it("serves the active version when there is no canary", () => {
    const r = resolveVersion({
      artifactType: "agent_system_prompt",
      artifactId: A,
      versions: [v(1, "superseded"), v(2, "active")],
      stableKey: "u",
    })!;
    expect(r.version).toBe(2);
    expect(r.canary).toBe(false);
    expect(r.bucket).toBeNull();
  });

  it("routes a key INSIDE the percentage to the canary and one outside to the active", () => {
    const versions = [v(1, "active"), v(2, "canary", 50)];
    const keys = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"];
    const inside = keys.filter((k) => canaryBucket(A, k) < 50);
    const outside = keys.filter((k) => canaryBucket(A, k) >= 50);
    expect(inside.length).toBeGreaterThan(0);
    expect(outside.length).toBeGreaterThan(0);
    for (const k of inside) {
      const r = resolveVersion({ artifactType: "agent_system_prompt", artifactId: A, versions, stableKey: k })!;
      expect(r.version).toBe(2);
      expect(r.canary).toBe(true);
      expect(r.bucket).toBe(canaryBucket(A, k));
    }
    for (const k of outside) {
      const r = resolveVersion({ artifactType: "agent_system_prompt", artifactId: A, versions, stableKey: k })!;
      expect(r.version).toBe(1);
      expect(r.canary).toBe(false);
    }
  });

  it("at 1% almost everything stays on active; at 99% almost everything moves", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `u${i}`);
    const share = (pct: number) =>
      keys.filter(
        (k) =>
          resolveVersion({
            artifactType: "agent_system_prompt",
            artifactId: A,
            versions: [v(1, "active"), v(2, "canary", pct)],
            stableKey: k,
          })!.canary,
      ).length / keys.length;
    expect(share(1)).toBeLessThan(0.1);
    expect(share(99)).toBeGreaterThan(0.9);
  });

  it("a RESTRICTION rule canary is SHADOW — the active version still serves", () => {
    expect(canaryIsLive("approval_rule")).toBe(false);
    expect(canaryIsLive("agent_system_prompt")).toBe(true);
    const r = resolveVersion({
      artifactType: "approval_rule",
      artifactId: A,
      // a 99% canary — under live routing virtually everything would move
      versions: [v(1, "active"), v(2, "canary", 99)],
      stableKey: "u",
    })!;
    expect(r.version).toBe(1);
    expect(r.canary).toBe(false);
    expect(r.reason).toMatch(/SHADOW/);
  });

  it("reads a cleared prompt as null rather than an empty string", () => {
    expect(promptFromBody({ systemPrompt: "hi" })).toBe("hi");
    expect(promptFromBody({ systemPrompt: null })).toBeNull();
    expect(promptFromBody({})).toBeNull();
  });
});

describe("ADR-0048 eval-gated promotion", () => {
  const canaryCreatedAt = new Date("2026-05-10T00:00:00.000Z");
  const passing = {
    id: "run-1",
    status: "completed",
    gatePassed: true,
    regression: false,
    startedAt: new Date("2026-05-11T00:00:00.000Z"),
  };

  it("allows promotion behind a PASSING run that post-dates the canary", () => {
    const d = evaluatePromotion({ canaryCreatedAt, evidence: passing, override: false, reason: null });
    expect(d.allowed).toBe(true);
    expect(d.ruleId).toBe("canary-promoted-eval-gated");
    expect(d.evalRunId).toBe("run-1");
    expect(d.override).toBe(false);
  });

  it("REFUSES a run that predates the canary — it never measured this change", () => {
    const d = evaluatePromotion({
      canaryCreatedAt,
      evidence: { ...passing, startedAt: new Date("2026-05-09T00:00:00.000Z") },
      override: false,
      reason: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/predates the canary/);
  });

  it("refuses a failing or unfinished run", () => {
    expect(
      evaluatePromotion({ canaryCreatedAt, evidence: { ...passing, gatePassed: false }, override: false, reason: null })
        .allowed,
    ).toBe(false);
    expect(
      evaluatePromotion({ canaryCreatedAt, evidence: { ...passing, status: "running" }, override: false, reason: null })
        .allowed,
    ).toBe(false);
  });

  it("blocks an ungated promotion, and allows the override ONLY with a reason", () => {
    const blocked = evaluatePromotion({ canaryCreatedAt, evidence: null, override: false, reason: null });
    expect(blocked.allowed).toBe(false);
    expect(blocked.ruleId).toBe("canary-promote-blocked");

    const noReason = evaluatePromotion({ canaryCreatedAt, evidence: null, override: true, reason: "  " });
    expect(noReason.allowed).toBe(false);
    expect(noReason.ruleId).toBe("canary-promote-override-no-reason");

    const ok = evaluatePromotion({
      canaryCreatedAt,
      evidence: null,
      override: true,
      reason: "no golden set exists for this agent yet",
    });
    expect(ok.allowed).toBe(true);
    expect(ok.ruleId).toBe("canary-promote-override");
    expect(ok.override).toBe(true);
    expect(ok.reason).toMatch(/no golden set exists/);
  });
});

// ---------------------------------------------------------------------------
// ADR-0073 — the rules engine wired through `config_versions`, PURE half.
// ---------------------------------------------------------------------------

describe("ADR-0073 canary mode vocabulary", () => {
  it("keeps canaryIsLive meaning 'the canary SERVES' — false for every rule type, for ever", () => {
    // This is the assertion that stops a future slice from "closing the gap" by
    // flipping the flag: a live rule canary would ENFORCE a candidate deny on a
    // percentage of real work, which is the outage ADR-0048 §2 forbids.
    for (const t of ["approval_rule", "rate_limit", "data_scope_rule", "compliance_profile"] as const) {
      expect(canaryIsLive(t)).toBe(false);
      expect(canaryIsShadowEvaluated(t)).toBe(true);
      expect(canaryIsEvaluated(t)).toBe(true);
      expect(canaryModeOf(t)).toBe("shadow");
    }
    expect(canaryIsLive("agent_system_prompt")).toBe(true);
    expect(canaryModeOf("agent_system_prompt")).toBe("live");
  });

  it("still says OUT LOUD that agent_config is INERT — the part ADR-0073 does NOT close", () => {
    // ADR-0048 DECLARED agent_config a live-canary type and never wired a
    // resolver, so `canaryIsLive` answered 'yes' about something nothing reads.
    // Intent and fact are now separate, and the fact is what the API reports.
    expect(canaryIsLive("agent_config")).toBe(true); // declared intent, unchanged
    expect(canaryIsEvaluated("agent_config")).toBe(false); // the fact
    expect(canaryModeOf("agent_config")).toBe("inert");
    expect(canaryModeNote("agent_config")).toMatch(/VOCABULARY ONLY/);
    expect(canaryModeNote("agent_config")).toMatch(/changes nothing and measures nothing/);
  });

  it("the shadow note stops claiming rules are unwired and states the sampling meaning", () => {
    const note = canaryModeNote("approval_rule");
    expect(note).toMatch(/genuinely evaluated in parallel/);
    expect(note).toMatch(/config_canary_observations/);
    expect(note).toMatch(/SHADOW SAMPLING RATE/);
    expect(note).not.toMatch(/NOT yet wired/);
  });
});

describe("ADR-0073 what a rule version body may contain", () => {
  it("refuses a SELECTION field with a reason naming what to do instead", () => {
    const r = validateRuleVersionBody("approval_rule", { userId: "someone-else" });
    expect(r?.error).toBe("selection_field_not_versionable");
    expect(r?.reason).toMatch(/never loads it for/);
    expect(r?.reason).toMatch(/separate rule/);
  });

  it("refuses an identity field and an unknown field rather than ignoring either", () => {
    expect(validateRuleVersionBody("rate_limit", { id: "x" })?.error).toBe("identity_field_not_versionable");
    const unknown = validateRuleVersionBody("rate_limit", { maxCals: 5 });
    expect(unknown?.error).toBe("unknown_versioned_field");
    // a silently-dropped typo would store a version that looks like a change
    // and is not one — the worst possible outcome for a governance artifact
    expect(unknown?.reason).toMatch(/silently-dropped/);
  });

  it("accepts exactly the enforcing fields of each type", () => {
    expect(validateRuleVersionBody("approval_rule", { toolName: "t", writeOnly: true })).toBeNull();
    expect(validateRuleVersionBody("rate_limit", { maxCalls: 1, windowSeconds: 60 })).toBeNull();
    expect(validateRuleVersionBody("data_scope_rule", { argPath: "a", allowedValues: ["x"] })).toBeNull();
    expect(validateRuleVersionBody("compliance_profile", { piiMode: "block" })).toBeNull();
    // ...and TYPE-CHECKS them. A stored `windowSeconds: "sixty"` would activate
    // cleanly and then throw inside the window arithmetic on the SERVED path.
    const badType = validateRuleVersionBody("rate_limit", { windowSeconds: "sixty" });
    expect(badType?.error).toBe("invalid_versioned_field");
    expect(badType?.reason).toMatch(/outage instead of a refusal/);
    expect(validateRuleVersionBody("approval_rule", { approverUserId: "not-a-uuid" })?.error).toBe(
      "invalid_versioned_field",
    );
    // an artifact type with no rule table is not a rule artifact at all
    expect(isRuleArtifact("agent_system_prompt")).toBe(false);
    expect(validateRuleVersionBody("agent_system_prompt", { anything: 1 })).toBeNull();
  });

  it("overlays field-wise: an omitted field keeps the row's value, it is not nulled", () => {
    const row = { id: "r", maxCalls: 10, windowSeconds: 60, toolName: "t", deployMode: null };
    const out = applyRuleBody("rate_limit", row, { maxCalls: 2 });
    expect(out.maxCalls).toBe(2);
    expect(out.windowSeconds).toBe(60);
    expect(out.toolName).toBe("t");
    // the input row is untouched
    expect(row.maxCalls).toBe(10);
  });

  it("extracts the baseline body from a live row rather than a hand-typed list", () => {
    const body = ruleBodyFrom("rate_limit", {
      id: "r",
      maxCalls: 10,
      windowSeconds: 60,
      toolName: null,
      deployMode: null,
      scope: "user",
      userId: "u",
    });
    expect(Object.keys(body).sort()).toEqual(["deployMode", "maxCalls", "toolName", "windowSeconds"]);
    // the selection columns are not carried into the version
    expect(body).not.toHaveProperty("userId");
  });
});

describe("ADR-0073 shadow resolution", () => {
  const R = "22222222-2222-2222-2222-222222222222";
  const v = (n: number, status: VersionLike["status"], pct?: number): VersionLike => ({
    id: `v${n}`,
    version: n,
    status,
    canaryPct: pct ?? null,
    body: { maxCalls: n },
  });

  it("no version rows at all = pre-versioning fallback, and it is NOT an error", () => {
    const r = resolveForShadow({ artifactType: "rate_limit", artifactId: R, versions: [], stableKey: "u" });
    expect(r.served).toBeNull();
    expect(r.candidate).toBeNull();
    expect(r.unresolvable).toBeNull();
  });

  it("FAILS CLOSED when versions exist but none is active", () => {
    const r = resolveForShadow({
      artifactType: "rate_limit",
      artifactId: R,
      versions: [v(1, "rolled_back"), v(2, "draft")],
      stableKey: "u",
    });
    expect(r.served).toBeNull();
    expect(r.unresolvable).toMatch(/NONE is active/);
    // the phrase that must survive any future edit: skipping a restriction is
    // a widening, so this may never resolve to "no rule, therefore allow"
    expect(r.unresolvable).toMatch(/silent widening/);
  });

  it("the ACTIVE version serves even at a 99% canary — the shadow never enforces", () => {
    for (const key of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const r = resolveForShadow({
        artifactType: "approval_rule",
        artifactId: R,
        versions: [v(1, "active"), v(2, "canary", 99)],
        stableKey: key,
      });
      expect(r.served!.version).toBe(1);
    }
  });

  it("canary_pct is the SAMPLING rate, and sampling is sticky per key", () => {
    const sampled = (key: string, pct: number) =>
      resolveForShadow({
        artifactType: "approval_rule",
        artifactId: R,
        versions: [v(1, "active"), v(2, "canary", pct)],
        stableKey: key,
      });
    const keys = Array.from({ length: 200 }, (_, i) => `u${i}`);
    const share = (pct: number) => keys.filter((k) => sampled(k, pct).candidate != null).length / keys.length;
    expect(share(1)).toBeLessThan(0.1);
    expect(share(99)).toBeGreaterThan(0.9);
    // sticky: the same key, six times, same answer
    const first = sampled("stable-key", 50);
    for (let i = 0; i < 6; i++) {
      const again = sampled("stable-key", 50);
      expect(again.candidate?.id ?? null).toBe(first.candidate?.id ?? null);
      expect(again.bucket).toBe(first.bucket);
    }
    // and a key that was NOT sampled says so, so a zero observation count is
    // distinguishable from "there is no canary"
    const out = keys.map((k) => sampled(k, 1)).find((r) => r.candidate == null)!;
    expect(out.candidateSampledOut).toBe(true);
    expect(out.served!.version).toBe(1);
  });

  it("never produces a candidate for an artifact type nothing shadows", () => {
    const r = resolveForShadow({
      artifactType: "agent_system_prompt",
      artifactId: R,
      versions: [v(1, "active"), v(2, "canary", 99)],
      stableKey: "u",
    });
    // prompts canary LIVE via resolveVersion; this function is the rule path
    // and must not double-serve them
    expect(r.candidate).toBeNull();
    expect(r.served!.version).toBe(1);
  });
});
