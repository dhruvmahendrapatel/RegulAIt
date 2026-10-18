/**
 * Secure-by-default server gaps (ADR-0180, ADR-0186 A) — the pure halves, no database:
 *  - which MCP registry writes are relaxations (and so need a `settings_relax` step-up);
 *  - the presentation-scrub marker refusal on model-card writes (ADR-0115);
 *  - the shadow-AI remediation plan's workflow body, parsed with the real start schema (ADR-0055 §4);
 *  - a step-up prompt is not a deny (the use-case re-sync audit).
 * The routes themselves are driven in zz-secure-default-stepups.test.ts.
 */
import { describe, expect, it } from "vitest";
import { changeDescriptorSchema, createModelCardSchema, scrubAuditText, startInstanceSchema, updateModelCardSchema } from "@regulait/shared";
import { privateRangesRelaxation, registryCreateRelaxations, registryUpdateRelaxations } from "./mcp-registry.js";
import { cardFieldsWithScrubMarker } from "./mrm.js";
import { remediationStartBody, repoRelativePath, SHADOW_AI_REMEDIATION_CHANGE_TYPE } from "./shadow-ai.js";
import { shadowAiRemediationDefinition } from "./shadow-ai-remediation.js";
import { APPROVER_ADMIN_NOT_INITIATOR, secondApproverMissing, stageExcludesInitiator } from "./workflow-approvers.js";
import type { Db } from "@regulait/db";
import { isStepUpPrompt } from "./step-up.js";

describe("MCP registry relaxations", () => {
  it("create: only enabling or explicitly allowing private ranges relaxes", () => {
    expect(registryCreateRelaxations({})).toBeNull();
    expect(registryCreateRelaxations({ enabled: false, allowPrivateRanges: false })).toBeNull();
    expect(registryCreateRelaxations({ allowPrivateRanges: null })).toBeNull();
    expect(registryCreateRelaxations({ enabled: true })).toEqual({ enabled: true });
    expect(registryCreateRelaxations({ allowPrivateRanges: true })).toEqual({ allowPrivateRanges: true });
    expect(registryCreateRelaxations({ enabled: true, allowPrivateRanges: true })).toEqual({ enabled: true, allowPrivateRanges: true });
  });

  it("update: enabling and opening relax; disabling, denying and unchanged values do not", () => {
    const off = { enabled: false, allowPrivateRanges: null };
    const on = { enabled: true, allowPrivateRanges: true };
    expect(registryUpdateRelaxations(off, { enabled: true }, false)).toEqual({ enabled: true });
    expect(registryUpdateRelaxations(off, { allowPrivateRanges: true }, false)).toEqual({ allowPrivateRanges: true });
    // tightening
    expect(registryUpdateRelaxations(on, { enabled: false }, false)).toBeNull();
    expect(registryUpdateRelaxations(on, { allowPrivateRanges: false }, true)).toBeNull();
    expect(registryUpdateRelaxations(on, { allowPrivateRanges: null }, false)).toBeNull();
    // re-sending what is stored changes nothing
    expect(registryUpdateRelaxations(on, { enabled: true, allowPrivateRanges: true }, false)).toBeNull();
    expect(registryUpdateRelaxations(off, { url: "https://x.example" } as never, true)).toBeNull();
    // an explicit deny moved back to "inherit" opens the registry only when the org default is open
    const denied = { enabled: false, allowPrivateRanges: false };
    expect(registryUpdateRelaxations(denied, { allowPrivateRanges: null }, false)).toBeNull();
    expect(registryUpdateRelaxations(denied, { allowPrivateRanges: null }, true)).toEqual({ allowPrivateRanges: null });
  });
});

describe("private-range relaxation (MCP servers and registries share it)", () => {
  it("opening relaxes; denying, inheriting a closed default and unchanged values do not", () => {
    expect(privateRangesRelaxation(null, undefined, true)).toBeNull();
    expect(privateRangesRelaxation(null, true, false)).toEqual({ allowPrivateRanges: true });
    expect(privateRangesRelaxation(false, true, false)).toEqual({ allowPrivateRanges: true });
    expect(privateRangesRelaxation(true, true, false)).toBeNull();
    expect(privateRangesRelaxation(true, false, true)).toBeNull();
    expect(privateRangesRelaxation(true, null, false)).toBeNull();
    // deny -> inherit opens the posture only when the org default is open
    expect(privateRangesRelaxation(false, null, false)).toBeNull();
    expect(privateRangesRelaxation(false, null, true)).toEqual({ allowPrivateRanges: null });
    // inherit -> inherit changes nothing
    expect(privateRangesRelaxation(null, null, true)).toBeNull();
  });
});

describe("model-card writes refuse the presentation-scrub marker", () => {
  // a REAL marker, made by the scrub itself (never a hand-typed lookalike)
  const masked = scrubAuditText("aws key AKIAIOSFODNN7EXAMPLE in use");

  it("the fixture is a scrubbed string", () => {
    expect(masked).toMatch(/\[redacted:/);
    expect(masked).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("names every field that carries a marker, nested values and keys included", () => {
    const body = updateModelCardSchema.parse({
      intendedUse: `triage ${masked}`,
      limitations: "English only",
      standardRefs: ["nist-ai-rmf:MAP-1.1", masked.slice(0, 200)],
      dataClaims: { retention: { note: masked }, [masked]: "x" },
      note: null,
    });
    expect(cardFieldsWithScrubMarker(body)).toEqual(["dataClaims", "intendedUse", "standardRefs"]);
  });

  it("a clean create or edit passes (no false positive on text that merely mentions redaction)", () => {
    const create = createModelCardSchema.parse({
      agentId: "00000000-0000-4000-8000-000000000001",
      intendedUse: "summarize tickets; [redacted] notes are kept out",
      limitations: "the word redacted alone is fine",
      biasFairness: [{ dimension: "language", method: "spot check", status: "not_assessed", note: "ok" }],
    });
    expect(cardFieldsWithScrubMarker(create)).toEqual([]);
    expect(cardFieldsWithScrubMarker(updateModelCardSchema.parse({ limitations: null }))).toEqual([]);
  });

  it("checks the bias entries on create too", () => {
    const create = createModelCardSchema.parse({
      agentId: "00000000-0000-4000-8000-000000000001",
      intendedUse: "summarize tickets",
      biasFairness: [{ dimension: "language", method: "spot check", status: "not_assessed", note: masked }],
    });
    expect(cardFieldsWithScrubMarker(create)).toEqual(["biasFairness"]);
  });
});

describe("shadow-AI remediation plan body", () => {
  const finding = { id: "00000000-0000-4000-8000-0000000000aa", subject: "acme/billing", subjectKind: "repo", provider: "example-provider" };

  it("validates against the real workflow start schema, with no field it does not accept", () => {
    const body = remediationStartBody(finding);
    expect(startInstanceSchema.safeParse(body).success).toBe(true);
    // strict: an unknown key (the old `repoPath`) would be refused here, not silently dropped
    expect(changeDescriptorSchema.strict().safeParse(body.change).success).toBe(true);
    expect(body.change).not.toHaveProperty("repoPath");
    expect(body.change.changeType).toBe(SHADOW_AI_REMEDIATION_CHANGE_TYPE);
    expect(body.change.paths).toEqual(["acme/billing"]);
    expect(body.change.targetSystem).toBe("acme/billing");
    expect(body.change.description).toContain(finding.id);
  });

  it("a host finding has no paths and still validates", () => {
    const body = remediationStartBody({ ...finding, subjectKind: "host", subject: "build-01.internal" });
    expect(body.change.paths).toEqual([]);
    expect(changeDescriptorSchema.strict().safeParse(body.change).success).toBe(true);
  });

  it("paths come from the repo's evidence locations; nothing pseudonymised or credential-shaped rides along", () => {
    const evidence = [
      { location: { path: "src/llm.ts", line: 3 }, actor: "psn:0123456789abcdef01234567" },
      { location: { path: "src/llm.ts" } },
      { location: { path: "../outside.ts" } },
      { location: { path: "psn:0123456789abcdef01234567/x.ts" } },
      { location: { path: `config/${"sk-" + "a".repeat(40)}` } },
    ];
    const body = remediationStartBody({ ...finding, evidence }, "staging");
    expect(body.change.paths).toEqual(["acme/billing", "src/llm.ts"]);
    expect(body.change.environment).toBe("staging");
    expect(JSON.stringify(body)).not.toContain("psn:");
    expect(changeDescriptorSchema.strict().safeParse(body.change).success).toBe(true);
  });

  it("a pseudonymised subject is named only by its kind", () => {
    for (const row of [
      { ...finding, subjectKind: "device", subject: "psn:0123456789abcdef01234567" },
      { ...finding, subjectKind: "cloud_principal", subject: "psn:0123456789abcdef01234567" },
      { ...finding, subjectKind: "host", subject: "psn:0123456789abcdef01234567" },
    ]) {
      const body = remediationStartBody({ ...row, evidence: [{ location: { path: "~/.config/app.json" } }] });
      expect(JSON.stringify(body)).not.toContain("psn:");
      expect(body.change.paths).toEqual([]);
      expect(body.change).not.toHaveProperty("targetSystem");
      expect(body.change.description).toContain("(pseudonymised)");
      expect(body.change.description).toContain(finding.id);
      expect(startInstanceSchema.safeParse(body).success).toBe(true);
    }
  });

  it("absolute, home and drive paths never ride along (they name a person)", () => {
    for (const p of ["/home/alice/.config/x.json", "\\server\\share\\a.ts", "~/notes.txt", "C:\\Users\\bob\\a.ts", "c:/Users/bob/a.ts", "a/../../b.ts"]) {
      expect(repoRelativePath(p)).toBe(false);
    }
    for (const p of ["src/llm.ts", "packages/x/index.ts", "a~b/c.ts"]) expect(repoRelativePath(p)).toBe(true);
    const evidence = ["/home/alice/.config/x.json", "~/notes.txt", "C:\\Users\\bob\\a.ts", "\\srv\\a.ts", "src/ok.ts"].map((path) => ({ location: { path } }));
    const body = remediationStartBody({ ...finding, evidence });
    expect(body.change.paths).toEqual(["acme/billing", "src/ok.ts"]);
    expect(JSON.stringify(body)).not.toMatch(/alice|bob/);
  });

  it("a device subject that is not pseudonym-shaped is still never named (the kind decides)", () => {
    const body = remediationStartBody({ ...finding, subjectKind: "device", subject: "alice-macbook" });
    expect(JSON.stringify(body)).not.toContain("alice");
    expect(body.change).not.toHaveProperty("targetSystem");
    expect(body.change.description).toContain("a device (pseudonymised)");
  });

  it("a credential-shaped subject is never copied into the body", () => {
    const secret = "sk-" + "b".repeat(40);
    const body = remediationStartBody({ ...finding, subject: `acme/${secret}` });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.change.paths).toEqual([]);
    expect(body.change).not.toHaveProperty("targetSystem");
  });

  it("the default's sign-off is owed to an admin other than the initiator, and one is enough", () => {
    const def = shadowAiRemediationDefinition();
    const signoff = def.stages.find((s) => s.type === "human_approval")!;
    expect(signoff.approvers).toEqual([APPROVER_ADMIN_NOT_INITIATOR]);
    expect(signoff.quorum).toBe("any");
    expect(stageExcludesInitiator(def, signoff.id)).toBe(true);
    expect(stageExcludesInitiator(def, "plan")).toBe(false);
  });

  it("the negative control: the old body shape does not validate", () => {
    const old = { change: { targetSystem: "acme/billing", changeType: SHADOW_AI_REMEDIATION_CHANGE_TYPE, repoPath: "acme/billing" } };
    expect(startInstanceSchema.safeParse(old).success).toBe(false);
  });
});

describe("a step-up prompt is not a deny", () => {
  it("only a step_up_required naming a usable method is a prompt", () => {
    expect(isStepUpPrompt({ error: "step_up_required", methods: ["passkey"] })).toBe(true);
    expect(isStepUpPrompt({ error: "step_up_required", methods: [], credential: "api_key" })).toBe(false);
    expect(isStepUpPrompt({ error: "step_up_required", methods: [], credential: "bootstrap" })).toBe(false);
    expect(isStepUpPrompt({ error: "step_up_unavailable", methods: [] })).toBe(false);
    expect(isStepUpPrompt({ error: "chatops_step_up_required", methods: [] })).toBe(false);
  });
});

describe("ADR-0195 A4: a sign-off nobody but the initiator could decide is refused at start", () => {
  /** a database whose admin query answers `rows`; `calls` counts the queries */
  function adminsDb(rows: Array<{ id: string }>) {
    const state = { calls: 0 };
    const db = { select: () => ({ from: () => ({ where: async () => (state.calls++, rows) }) }) } as unknown as Db;
    return { db, state };
  }

  it("refuses the default when no other active admin exists, and allows it when one does", async () => {
    const none = adminsDb([]);
    expect(await secondApproverMissing(none.db, shadowAiRemediationDefinition(), "initiator")).toBe(true);
    expect(none.state.calls).toBe(1);
    const one = adminsDb([{ id: "other-admin" }]);
    expect(await secondApproverMissing(one.db, shadowAiRemediationDefinition(), "initiator")).toBe(false);
  });

  it("never asks for a second admin when no stage needs one", async () => {
    const definition = shadowAiRemediationDefinition();
    const relaxed = {
      ...definition,
      stages: definition.stages.map((s) => (s.type === "human_approval" ? { ...s, approvers: ["requesting_user"] } : s)),
    };
    const none = adminsDb([]);
    expect(await secondApproverMissing(none.db, relaxed, "initiator")).toBe(false);
    expect(none.state.calls).toBe(0);
  });
});
