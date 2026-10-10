/**
 * ADR-0187 — the pure half of the engine contract: the envelope's strictness
 * and caps, the not-clean normaliser, the self-test verdict, the setting and
 * engine-row relaxation predicates, and the taxonomy table's own checks.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BATCH5_STRICT_DEFAULTS,
  ENGINE_REASON_MAX_LENGTH,
  ENGINE_SELF_TEST_FUTURE_SKEW_MS,
  ENGINE_SELF_TEST_MAX_AGE_SECONDS,
  revokeRunnerSchema,
  ENGINE_MANIFEST,
  ENGINE_RESULT_VERSION,
  ENGINE_TAXONOMY,
  batch5SettingLooser,
  batch5SettingRelaxed,
  engineConfigNeedsApproval,
  engineResultEnvelopeSchema,
  engineRowRelaxations,
  engineTaxonomyProblems,
  evaluateRunnerSelfTest,
  normaliseEngineResult,
  type EngineResultEnvelope,
  type EngineTaxonomy,
} from "../index.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const TAX: EngineTaxonomy = {
  version: 3,
  entries: [
    { system: "promptfoo", id: "pi", attackClass: "prompt_injection", scorerKind: null },
    { system: "promptfoo", id: "qual", attackClass: null, scorerKind: "llm_as_judge" },
  ],
};
const item = (key: string, id: string, over: Partial<EngineResultEnvelope["items"][number]> = {}) => ({
  key,
  sourceTaxonomy: { system: "promptfoo", id },
  mappedClass: null,
  severity: "high" as const,
  attempts: 3,
  defeated: 0,
  verdict: "pass" as const,
  reason: null,
  dispatchAuditIds: [],
  ...over,
});
const env = (over: Partial<EngineResultEnvelope> = {}): EngineResultEnvelope => ({
  version: ENGINE_RESULT_VERSION,
  runId: RUN,
  engineId: "promptfoo",
  engineVersion: "0.123.1",
  status: "completed",
  items: [],
  notRun: [],
  rawReport: null,
  ...over,
});
const id = (s: string) => s;
const norm = (e: EngineResultEnvelope | null, status = e?.status ?? "completed") =>
  normaliseEngineResult({ envelope: e, status, taxonomy: TAX, scrub: id });

describe("the envelope", () => {
  it("is strict: unknown fields, duplicate keys and defeated > attempts are refused", () => {
    expect(engineResultEnvelopeSchema.safeParse(env()).success).toBe(true);
    expect(engineResultEnvelopeSchema.safeParse({ ...env(), extra: 1 }).success).toBe(false);
    expect(engineResultEnvelopeSchema.safeParse(env({ items: [item("a", "pi"), item("a", "pi")] })).success).toBe(false);
    expect(engineResultEnvelopeSchema.safeParse(env({ items: [item("a", "pi", { defeated: 4 })] })).success).toBe(false);
    expect(engineResultEnvelopeSchema.safeParse({ ...env(), version: "v0" }).success).toBe(false);
    expect(engineResultEnvelopeSchema.safeParse(env({ items: [item("a\nb", "pi")] })).success).toBe(false);
    expect(engineResultEnvelopeSchema.safeParse(env({ items: [item("a", "pi", { reason: "x".repeat(1001) })] })).success).toBe(false);
  });
});

describe("not-clean semantics", () => {
  it("the server derives each verdict; any defeat fails; no attempt is unknown", () => {
    const n = norm(env({ items: [item("a", "pi"), item("b", "pi", { defeated: 1 }), item("c", "pi", { attempts: 0 }), item("d", "pi", { verdict: "fail" })] }));
    // a claimed fail with no defeat is inconsistent (review round 2 [19]): unknown
    expect(n.items.map((i) => i.verdict)).toEqual(["pass", "fail", "unknown", "unknown"]);
    expect(n.verdict).toBe("fail");
  });

  it("a run that did not complete has no clean item", () => {
    for (const status of ["failed", "timeout", "cancelled"] as const) {
      const n = norm(env({ status, items: [item("a", "pi"), item("b", "pi", { verdict: "not_run" })] }));
      expect(n.items.map((i) => i.verdict)).toEqual(["unknown", "not_run"]);
      expect(n.verdict).toBe("unknown");
      expect(n.probeStats.every((p) => p.status === "not_run")).toBe(true);
    }
  });

  it("an item listed as not run is not run, whatever it claims; unlisted not-run keys still appear", () => {
    const n = norm(env({ items: [item("a", "pi"), item("b", "pi")], notRun: [{ key: "b", reason: "egress_denied" }, { key: "z", reason: "cloud_only" }] }));
    expect(n.items.map((i) => [i.key, i.verdict, i.notRunReason])).toEqual([
      ["a", "pass", null],
      ["b", "not_run", "egress_denied"],
      ["z", "not_run", "cloud_only"],
    ]);
    // PR #205 review round 3 [61] (amends decision 12): b's egress was denied at RUN time and z is
    // not declared by the build, so the run is incomplete — never a pass — and b is in the probe
    // stats as not measured
    expect(n.verdict).toBe("unknown");
    expect(n.runtimeNotRun).toBe(2);
    expect(n.asrTrials).toBe(3);
    expect(n.probeStats.find((p) => p.probeKey === "b")).toMatchObject({ status: "not_run" });
    // only a DECLARED planning-time exclusion leaves a pass a pass
    const declared = normaliseEngineResult({
      envelope: env({ items: [item("a", "pi")], notRun: [{ key: "z", reason: "cloud_only" }] }),
      status: "completed",
      taxonomy: TAX,
      scrub: (t) => t,
      declaredNotRun: new Set(["z"]),
    });
    expect(declared).toMatchObject({ verdict: "pass", runtimeNotRun: 0 });
    // a declared KEY with a runtime reason is still runtime
    const egressOnDeclared = normaliseEngineResult({
      envelope: env({ items: [item("a", "pi")], notRun: [{ key: "z", reason: "egress_denied" }] }),
      status: "completed",
      taxonomy: TAX,
      scrub: (t) => t,
      declaredNotRun: new Set(["z"]),
    });
    expect(egressOnDeclared).toMatchObject({ verdict: "unknown", runtimeNotRun: 1 });
    // a standalone not-run key that is a mapped id shows in the probe stats as not measured
    const standalone = normaliseEngineResult({ envelope: env({ items: [item("a", "pi")], notRun: [{ key: "pi", reason: "engine_error" }] }), status: "completed", taxonomy: TAX, scrub: (t) => t });
    expect(standalone.probeStats.map((p) => [p.probeKey, p.status])).toEqual([
      ["a", "measured"],
      ["pi", "not_run"],
    ]);
  });

  it("no envelope: nothing, and unknown", () => {
    expect(norm(null, "failed")).toMatchObject({ items: [], verdict: "unknown" });
    expect(norm(null, "not_run")).toMatchObject({ verdict: "not_run" });
  });

  it("classes come from the table, never the claim; unmapped items count toward nothing", () => {
    const n = norm(env({ items: [item("a", "pi", { mappedClass: "jailbreak" }), item("b", "nothing"), item("c", "qual")] }));
    expect(n.items.map((i) => [i.attackClass, i.scorerKind, i.claimedClass])).toEqual([
      ["prompt_injection", null, "jailbreak"],
      [null, null, null],
      [null, "llm_as_judge", null],
    ]);
    expect(n).toMatchObject({ mappedItems: 2, unmappedItems: 1, taxonomyVersion: 3 });
    expect(n.classes.map((c) => c.attackClass)).toEqual(["prompt_injection"]);
  });

  it("aggregates are recomputed: pooled ASR with a Wilson interval and the measurement label", () => {
    const n = norm(env({ items: [item("a", "pi", { attempts: 10, defeated: 1 }), item("b", "pi", { attempts: 10 })] }));
    expect(n.asr).toBe(0.05);
    expect(n.asrTrials).toBe(20);
    expect(n.asrInterval!.lower).toBeGreaterThan(0);
    expect(n.measurementQuality).toBe("measured");
  });

  it("a scrub that throws fails the item closed", () => {
    const n = normaliseEngineResult({
      envelope: env({ items: [item("secret", "pi", { reason: "x" })] }),
      status: "completed",
      taxonomy: TAX,
      scrub: () => {
        throw new Error("no");
      },
    });
    expect(n.items[0]).toMatchObject({ key: "withheld:0", reason: null, verdict: "unknown", attackClass: null, scrubFailed: true });
    expect(n.verdict).toBe("unknown");
  });
});

describe("the self-test verdict", () => {
  const m = { ...ENGINE_MANIFEST.promptfoo, imageDigest: `sha256:${"a".repeat(64)}` };
  const ok = {
    imageDigest: m.imageDigest,
    engineVersion: m.version,
    usageDataEnv: Object.fromEntries(Object.keys(m.usageDataEnv).map((k) => [k, true])),
    egress: { host: "example.com", dnsResolved: false, connected: false, address: "93.184.215.14", addressConnected: false },
    at: new Date().toISOString(),
  };
  it("passes only when every check holds", () => {
    expect(evaluateRunnerSelfTest(m, ok, new Date())).toEqual({ passed: true, failures: [] });
    expect(evaluateRunnerSelfTest(m, { ...ok, egress: { ...ok.egress, connected: true } }, new Date()).failures).toEqual(["egress_connected"]);
    expect(evaluateRunnerSelfTest(m, { ...ok, at: new Date(Date.now() - 2 * 86_400_000).toISOString() }, new Date()).failures).toEqual(["stale"]);
    // the shipped manifest has no built image: nothing passes
    expect(evaluateRunnerSelfTest(ENGINE_MANIFEST.promptfoo, ok, new Date()).failures).toContain("image_not_built");
  });
  it("an unlisted set needs approval (fail closed)", () => {
    expect(engineConfigNeedsApproval({ ...m, sets: { basic: "standard" } }, ["basic"])).toBe(false);
    expect(engineConfigNeedsApproval({ ...m, sets: { basic: "standard" } }, ["basic", "new-set"])).toBe(true);
    expect(engineConfigNeedsApproval({ ...m, sets: {} }, ["constructor"])).toBe(true);
  });
});

describe("relaxations", () => {
  it("every engine setting is strict by default and ordered", () => {
    expect(BATCH5_STRICT_DEFAULTS.engineSensitiveSetApproval).toBe(true);
    expect(batch5SettingRelaxed("engineMaxRunTimeoutMinutes", 31)).toBe(true);
    expect(batch5SettingRelaxed("engineMaxRunTimeoutMinutes", 10)).toBe(false);
    expect(batch5SettingRelaxed("engineSensitiveSetApproval", false)).toBe(true);
    expect(batch5SettingLooser("engineRawReportRetentionDays", 90, 30)).toBe(true);
    expect(batch5SettingLooser("engineRunApprovalThresholdUsd", 5, 10)).toBe(false);
  });
  it("an engine PATCH relaxes when it enables or raises a dial", () => {
    const stored = { enabled: false, timeoutSeconds: 1800, maxBudgetUsd: 5, maxConcurrent: 1 };
    expect(engineRowRelaxations("garak", { enabled: true, timeoutSeconds: 600, maxConcurrent: 2 }, stored)).toEqual({
      "engine.garak.enabled": true,
      "engine.garak.maxConcurrent": 2,
    });
    expect(engineRowRelaxations("garak", { enabled: false, maxBudgetUsd: 1 }, { ...stored, enabled: true })).toEqual({});
  });
  it("the shipped taxonomy table has no problems", () => {
    expect(engineTaxonomyProblems(ENGINE_TAXONOMY)).toEqual([]);
    expect(engineTaxonomyProblems({ version: 1, entries: [TAX.entries[0]!, TAX.entries[0]!] })).toEqual(["duplicate entry promptfoo/pi"]);
  });
});

// ===========================================================================
// PR #203 review round 1 (Codex), each red first
// ===========================================================================
describe("review round 1", () => {
  it("[1] a defeat fails the item whatever verdict it claims, and counts in the ASR", () => {
    const n = norm(env({ items: [item("u", "pi", { verdict: "unknown", defeated: 2 }), item("n", "pi", { verdict: "not_run", defeated: 1 })] }));
    expect(n.items.map((i) => i.verdict)).toEqual(["fail", "fail"]);
    expect(n.verdict).toBe("fail");
    expect(n.asrTrials).toBe(6);
    const crashed = norm(env({ status: "failed", items: [item("u", "pi", { verdict: "unknown", defeated: 1 })] }));
    expect(crashed.items[0]!.verdict).toBe("fail");
    expect(crashed.verdict).toBe("fail");
  });

  it("[2] every engine string is scrubbed (system, claimed class, error code), and a throw fails closed", () => {
    const mark = (s: string) => s.replace(/SECRET/g, "[x]");
    const n = normaliseEngineResult({
      envelope: env({ status: "failed", errorCode: "boom_secret", items: [item("k", "pi", { mappedClass: "SECRET-class", sourceTaxonomy: { system: "SECRETsys", id: "pi" } })] }),
      status: "failed",
      taxonomy: TAX,
      scrub: (s) => mark(s.replace(/secret/g, "SECRET")),
    });
    expect(JSON.stringify(n)).not.toMatch(/SECRET/);
    expect(n.items[0]!.sourceSystem).toBe("[x]sys");
    expect(n.items[0]!.claimedClass).toBe("[x]-class");
    // an error code the scrub changed is not stored as given
    expect(n.engineErrorCode).toBe("engine_error");
    const thrown = normaliseEngineResult({
      envelope: env({ items: [item("k", "pi", { sourceTaxonomy: { system: "boom", id: "pi" } })] }),
      status: "completed",
      taxonomy: TAX,
      scrub: (s) => {
        if (s === "boom") throw new Error("x");
        return s;
      },
    });
    expect(thrown.items[0]).toMatchObject({ verdict: "unknown", sourceSystem: "withheld:0", scrubFailed: true });
  });

  it("[7] attempts are capped at the governed trial limit", () => {
    expect(engineResultEnvelopeSchema.safeParse(env({ items: [item("a", "pi", { attempts: 25 })] })).success).toBe(true);
    expect(engineResultEnvelopeSchema.safeParse(env({ items: [item("a", "pi", { attempts: 26 })] })).success).toBe(false);
  });

  it("[4] the self-test requires a public literal-address probe that did not connect", () => {
    const m = { ...ENGINE_MANIFEST.garak, imageDigest: `sha256:${"b".repeat(64)}` };
    const base = {
      imageDigest: m.imageDigest,
      engineVersion: m.version,
      // B5-G: every switch the garak manifest names (derived, so the list cannot drift from the manifest)
      usageDataEnv: Object.fromEntries(Object.keys(m.usageDataEnv).map((k) => [k, true])),
      at: new Date().toISOString(),
    };
    const egress = { host: "example.com", dnsResolved: false, connected: false, address: "93.184.215.14", addressConnected: false };
    expect(evaluateRunnerSelfTest(m, { ...base, egress }, new Date())).toEqual({ passed: true, failures: [] });
    expect(evaluateRunnerSelfTest(m, { ...base, egress: { ...egress, addressConnected: true } }, new Date()).failures).toEqual(["egress_address_connected"]);
    expect(evaluateRunnerSelfTest(m, { ...base, egress: { ...egress, address: null } }, new Date()).failures).toEqual(["egress_address_missing"]);
    expect(evaluateRunnerSelfTest(m, { ...base, egress: { ...egress, address: "10.1.2.3" } }, new Date()).failures).toEqual(["egress_address_missing"]);
    expect(evaluateRunnerSelfTest(m, { ...base, egress: { ...egress, address: "127.0.0.1" } }, new Date()).failures).toEqual(["egress_address_missing"]);
  });
});

describe("review round 2", () => {
  it("[19] a claimed fail with no defeat is inconsistent: unknown, never clean trial evidence", () => {
    const n = norm(env({ items: [item("f", "pi", { verdict: "fail", defeated: 0 })] }));
    expect(n.items[0]).toMatchObject({ verdict: "unknown" });
    expect(n.probeStats[0]!.status).toBe("not_run");
    expect(n.asrTrials).toBe(0);
    expect(n.verdict).toBe("unknown");
  });
});

/**
 * The SPA does not depend on this package; the Engines page mirrors the bounds it
 * enforces before a request (as LiteracyPage.tsx does for ai-literacy). These pin
 * each mirror to the constant the gateway applies (PR #230 review).
 */
describe("the Engines page's mirrored bounds", () => {
  const web = readFileSync(new URL("../../../../apps/web/src/views/admin/integrations/engineModel.ts", import.meta.url), "utf8");
  const mirrored = (name: string): number => {
    const m = new RegExp(`export const ${name} = ([0-9_]+);`).exec(web);
    expect(m, `${name} in engineModel.ts`).not.toBeNull();
    return Number(m![1]!.replaceAll("_", ""));
  };

  it("the revocation reason cap is the schema's", () => {
    expect(ENGINE_REASON_MAX_LENGTH).toBeGreaterThan(0);
    expect(mirrored("RUNNER_REVOKE_REASON_MAX")).toBe(ENGINE_REASON_MAX_LENGTH);
    expect(revokeRunnerSchema.safeParse({ reason: "x".repeat(ENGINE_REASON_MAX_LENGTH) }).success).toBe(true);
    expect(revokeRunnerSchema.safeParse({ reason: "x".repeat(ENGINE_REASON_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it("the self-test freshness bound and the future-dated skew are the verdict's", () => {
    expect(mirrored("SELF_TEST_MAX_AGE_MS")).toBe(ENGINE_SELF_TEST_MAX_AGE_SECONDS * 1000);
    expect(ENGINE_SELF_TEST_FUTURE_SKEW_MS).toBeGreaterThan(0);
    expect(mirrored("SELF_TEST_FUTURE_SKEW_MS")).toBe(ENGINE_SELF_TEST_FUTURE_SKEW_MS);
  });
});
