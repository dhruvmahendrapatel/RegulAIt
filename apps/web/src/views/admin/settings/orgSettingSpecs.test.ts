import { describe, expect, it } from "vitest";
import {
  ALL_SPECS,
  BATCH4_SPECS,
  BATCH5_SPECS,
  CORE_SPECS,
  IDENTITY_SPECS,
  describeValue,
  draftOf,
  needsStepUp,
  parseDraft,
  sameValue,
  specsFor,
  storedValue,
  type Draft,
} from "./orgSettingSpecs";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sharedFile = (rel: string) => new URL(`../../../../../../packages/shared/src/${rel}`, import.meta.url).pathname;
const batch4 = async (): Promise<any> => import(/* @vite-ignore */ sharedFile("batch4.ts"));
const batch5 = async (): Promise<any> => import(/* @vite-ignore */ sharedFile("engines/settings.ts"));
const identity = async (): Promise<any> => import(/* @vite-ignore */ sharedFile("identity/settings.ts"));
const identityContract = async (): Promise<any> => import(/* @vite-ignore */ sharedFile("identity/contract.ts"));
const pii = async (): Promise<any> => import(/* @vite-ignore */ sharedFile("pii-international.ts"));
const admission = async (): Promise<any> => import(/* @vite-ignore */ sharedFile("mcp-admission.ts"));

const draft = (patch: Partial<Draft>): Draft => ({ text: "", none: false, set: [], map: {}, ...patch });

/** sample values for a spec: every option, or the bounds, the default and its neighbours */
function samples(key: string): unknown[] {
  const s = ALL_SPECS[key]!;
  const c = s.control;
  switch (c.kind) {
    case "enum":
      return c.options.map((o) => o.value);
    case "boolean":
      return [true, false];
    case "int":
    case "decimal": {
      const d = s.strictDefault as number;
      return [...new Set([c.min, c.max, d, Math.min(c.max, d + 1), Math.max(c.min, d - 1)])];
    }
    case "set": {
      const all = c.options.map((o) => o.value);
      return [all, all.slice(1), [], all.slice(0, 1)];
    }
    case "modeMap":
      return [{}, { hosted: 30 }, { hosted: 60, byoc: 10 }];
  }
}

describe("the batch-4, batch-5 and identity rows mirror @regulait/shared", () => {
  const cases: Array<[string, Record<string, any>, () => Promise<any>, string, string, string, string]> = [
    ["batch 4", BATCH4_SPECS, batch4, "BATCH4_SETTING_COPY", "BATCH4_STRICT_DEFAULTS", "batch4SettingRelaxed", "batch4OrgSettingsFields"],
    ["batch 5", BATCH5_SPECS, batch5, "BATCH5_SETTING_COPY", "BATCH5_STRICT_DEFAULTS", "batch5SettingRelaxed", "batch5OrgSettingsFields"],
    ["identity", IDENTITY_SPECS, identity, "IDENTITY_SETTING_COPY", "IDENTITY_STRICT_DEFAULTS", "identitySettingRelaxed", "identityOrgSettingsFields"],
  ];
  for (const [name, specs, load, copy, defaults, relaxed, fields] of cases) {
    it(`${name}: label, copy, strict default, accepted values and the relaxation predicate`, async () => {
      const s = await load();
      for (const spec of Object.values(specs)) {
        expect({ label: spec.label, strict: spec.strict, relaxed: spec.relaxed }, spec.key).toEqual(s[copy][spec.key]);
        expect(spec.strictDefault, spec.key).toEqual(s[defaults][spec.key]);
        for (const value of samples(spec.key)) {
          expect(spec.isRelaxed(value), `${spec.key}=${JSON.stringify(value)}`).toBe(s[relaxed](spec.key, value));
          // the gateway's PUT schema accepts every value the form can send
          expect(s[fields][spec.key].safeParse(value).success, `${spec.key}=${JSON.stringify(value)}`).toBe(true);
        }
        const c = spec.control;
        if (c.kind === "int" || c.kind === "decimal") {
          expect(s[fields][spec.key].safeParse(c.min - (c.kind === "int" ? 1 : 0.01)).success, `${spec.key} below min`).toBe(false);
          expect(s[fields][spec.key].safeParse(c.max + 1).success, `${spec.key} above max`).toBe(false);
        }
      }
    });
  }

  it("batch 5 and identity: the stored-value comparator agrees on every pair of samples", async () => {
    const [b5, id] = [await batch5(), await identity()];
    for (const [specs, looser] of [
      [BATCH5_SPECS, b5.batch5SettingLooser],
      [IDENTITY_SPECS, id.identitySettingLooser],
    ] as const) {
      for (const spec of Object.values(specs)) {
        for (const a of samples(spec.key)) {
          for (const b of samples(spec.key)) {
            expect(spec.looser?.(a, b) ?? false, `${spec.key}: ${JSON.stringify(a)} over ${JSON.stringify(b)}`).toBe(looser(spec.key, a, b));
          }
        }
      }
    }
  });

  it("the vocabularies are the shared ones, in the same order", async () => {
    const [b4, ic, p, adm] = [await batch4(), await identityContract(), await pii(), await admission()];
    const opts = (key: string) => {
      const c = ALL_SPECS[key]!.control;
      return c.kind === "enum" || c.kind === "set" ? c.options.map((o) => o.value) : [];
    };
    expect(opts("approvalSignatureMode")).toEqual([...b4.APPROVAL_SIGNATURE_MODES]);
    expect(opts("stepUpMode")).toEqual([...b4.STEP_UP_MODES]);
    expect(opts("stepUpActions")).toEqual([...b4.STEP_UP_ACTION_KINDS]);
    expect(opts("decisionReceiptsMode")).toEqual([...b4.DECISION_RECEIPTS_MODES]);
    expect(opts("auditAnchorTimestampMode")).toEqual([...b4.AUDIT_ANCHOR_TIMESTAMP_MODES]);
    expect(opts("vendoredDetectionPacks")).toEqual([...b4.VENDORED_DETECTION_PACKS]);
    expect(opts("outboundCredentialAudience")).toEqual([...b4.OUTBOUND_CREDENTIAL_AUDIENCE_MODES]);
    expect(opts("agentEntitlementMode")).toEqual([...ic.AGENT_ENTITLEMENT_MODES]);
    expect(opts("workloadClientAuthMethods")).toEqual([...ic.WORKLOAD_CLIENT_AUTH_METHODS]);
    expect(opts("piiInternationalCategories")).toEqual([...p.INTERNATIONAL_PII_CATEGORIES]);
    expect([...opts("mcpAdmissionMode")].sort()).toEqual([...adm.MCP_ADMISSION_MODES].sort());
  });
});

describe("the remaining rows follow the gateway's strictness registry", () => {
  it("strict defaults are the migrations' (ADR-0181)", () => {
    expect(CORE_SPECS.approvalTtlHours!.strictDefault).toBe(72);
    expect(CORE_SPECS.apiKeyDefaultTtlDays!.strictDefault).toBe(90);
    expect(CORE_SPECS.apiKeyMaxTtlDays!.strictDefault).toBe(365);
    expect(CORE_SPECS.mcpAdmissionMode!.strictDefault).toBe("enforce");
    expect(CORE_SPECS.backupVerifyEnabled!.strictDefault).toBe(true);
    expect(CORE_SPECS.backupVerifyIntervalHours!.strictDefault).toBe(24);
    expect(CORE_SPECS.canaryObservationRetentionDays!.strictDefault).toBe(90);
    expect(CORE_SPECS.approvalBulkMaxItems!.strictDefault).toBe(25);
    expect(CORE_SPECS.approvalBulkSensitiveBlocked!.strictDefault).toBe(true);
  });
  it("null (never expires / no ceiling) is a relaxation; a shorter lifetime is not", () => {
    for (const key of ["approvalTtlHours", "apiKeyDefaultTtlDays", "apiKeyMaxTtlDays"]) {
      const spec = CORE_SPECS[key]!;
      expect(spec.isRelaxed(null), key).toBe(true);
      expect(needsStepUp(spec, null, 10), key).toBe(true);
      expect(needsStepUp(spec, 5, 10), key).toBe(false);
      // a value tightened past the default, loosened back toward it, asks for the step-up (decision 26)
      expect(needsStepUp(spec, 20, 10), key).toBe(true);
    }
  });
  it("the canary retention is looser when shorter; backups when the interval is longer", () => {
    expect(needsStepUp(CORE_SPECS.canaryObservationRetentionDays!, 30, 90)).toBe(true);
    expect(needsStepUp(CORE_SPECS.canaryObservationRetentionDays!, 365, 90)).toBe(false);
    expect(needsStepUp(CORE_SPECS.backupVerifyIntervalHours!, 48, 24)).toBe(true);
    expect(needsStepUp(CORE_SPECS.backupVerifyIntervalHours!, 12, 24)).toBe(false);
    expect(needsStepUp(CORE_SPECS.backupVerifyEnabled!, false, true)).toBe(true);
  });
  it("PII categories and mode retention only loosen against what is stored", () => {
    const pii = CORE_SPECS.piiInternationalCategories!;
    expect(needsStepUp(pii, ["cpf"], [])).toBe(false);
    expect(needsStepUp(pii, [], ["cpf"])).toBe(true);
    const mode = CORE_SPECS.modeAuditRetention!;
    expect(needsStepUp(mode, { hosted: 400 }, {})).toBe(false);
    expect(needsStepUp(mode, { hosted: 100 }, { hosted: 400 })).toBe(true);
    expect(needsStepUp(mode, {}, { hosted: 400 })).toBe(true);
  });
  it("the warn window never asks for a step-up (exempt in the registry)", () => {
    expect(needsStepUp(CORE_SPECS.mrmExpiryWarnDays!, 0, 30)).toBe(false);
  });
  it("an unchanged value never asks for anything", () => {
    expect(needsStepUp(BATCH4_SPECS.stepUpActions!, ["approval_decide"], ["approval_decide"])).toBe(false);
  });
});

describe("values: read, parse, describe", () => {
  it("a missing or mistyped stored value is unknown, never the strict default", () => {
    expect(storedValue(BATCH4_SPECS.stepUpMaxAgeSeconds!, "120")).toBeUndefined();
    expect(storedValue(BATCH4_SPECS.stepUpMode!, "future")).toBeUndefined();
    expect(storedValue(BATCH4_SPECS.stepUpActions!, "approval_decide")).toBeUndefined();
    expect(storedValue(BATCH5_SPECS.engineSensitiveSetApproval!, "true")).toBeUndefined();
    expect(storedValue(CORE_SPECS.approvalBulkMaxItems!, null)).toBeUndefined();
    expect(storedValue(CORE_SPECS.approvalTtlHours!, null)).toBeNull();
    expect(storedValue(CORE_SPECS.modeAuditRetention!, { hosted: "30" })).toBeUndefined();
    expect(draftOf(BATCH4_SPECS.stepUpMaxAgeSeconds!, undefined).text).toBe("");
  });
  it("an entry this build does not know survives a save of the list", () => {
    const stored = storedValue(BATCH4_SPECS.vendoredDetectionPacks!, ["future-pack", "pipelock-secrets"]) as string[];
    expect(stored).toEqual(["pipelock-secrets", "future-pack"]);
    const parsed = parseDraft(BATCH4_SPECS.vendoredDetectionPacks!, draftOf(BATCH4_SPECS.vendoredDetectionPacks!, stored));
    expect(parsed).toEqual({ ok: true, value: ["pipelock-secrets", "future-pack"] });
  });
  it("numbers: whole numbers inside the bounds; amounts with at most two decimals", () => {
    const quorum = BATCH4_SPECS.toolApprovalSensitiveQuorum!;
    expect(parseDraft(quorum, draft({ text: "3" }))).toEqual({ ok: true, value: 3 });
    for (const bad of ["", "0", "6", "1.5", "1e1", "0x2", " "]) expect(parseDraft(quorum, draft({ text: bad })).ok, bad).toBe(false);
    const budget = BATCH5_SPECS.engineDefaultRunBudgetUsd!;
    expect(parseDraft(budget, draft({ text: "2.50" }))).toEqual({ ok: true, value: 2.5 });
    for (const bad of ["0", "1000.01", "1.234", "-1"]) expect(parseDraft(budget, draft({ text: bad })).ok, bad).toBe(false);
  });
  it("a nullable lifetime sends null only when the box is ticked", () => {
    const ttl = CORE_SPECS.approvalTtlHours!;
    expect(parseDraft(ttl, draft({ none: true }))).toEqual({ ok: true, value: null });
    expect(parseDraft(ttl, draft({ text: "48" }))).toEqual({ ok: true, value: 48 });
    expect(parseDraft(BATCH4_SPECS.stepUpMaxAgeSeconds!, draft({ none: true, text: "" })).ok).toBe(false);
  });
  it("mode retention: empty entries are left out; a bad entry names its mode", () => {
    const mode = CORE_SPECS.modeAuditRetention!;
    expect(parseDraft(mode, draft({ map: { hosted: "400", byoc: "" } }))).toEqual({ ok: true, value: { hosted: 400 } });
    const bad = parseDraft(mode, draft({ map: { air_gapped: "0" } }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problem).toContain("Air-gapped");
    expect(sameValue({ hosted: 1, byoc: 2 }, { byoc: 2, hosted: 1 })).toBe(true);
  });
  it("describes values in words", () => {
    expect(describeValue(CORE_SPECS.approvalTtlHours!, null)).toBe("Never expires");
    expect(describeValue(BATCH5_SPECS.engineDefaultRunBudgetUsd!, 2)).toBe("$2");
    expect(describeValue(BATCH4_SPECS.stepUpActions!, [])).toBe("none");
    expect(describeValue(CORE_SPECS.modeAuditRetention!, {})).toBe("no overrides");
    expect(describeValue(BATCH4_SPECS.stepUpMode!, undefined)).toBe("not reported");
  });
  it("specsFor refuses a key with no spec", () => {
    expect(() => specsFor(["notASetting"])).toThrow();
  });
});
