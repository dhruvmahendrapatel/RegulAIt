/**
 * ADR-0296 part 2 (P18 B2) — privacy-law presets and packs.
 *
 *  1. PRESETS only tighten: the request period is never lengthened, identifier categories are only added, the
 *     processing limit is only turned on; several laws combine to the strictest; a strict org gets an empty patch.
 *  2. PACKS parse, are seeded once, claim no review or compliance, cite by article or section, and every
 *     `audit_decisions` filter names a rule id the gateway writes (read from its source).
 *  3. Every privacy control is filed under the privacy trust dimension.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_PACK_FRAMEWORKS, DEFAULT_COMPLIANCE_PACKS, createCompliancePackSchema } from "./compliance-packs.js";
import { INTERNATIONAL_PII_CATEGORIES } from "./pii-international.js";
import { DSR_DEFAULT_SLA_DAYS } from "./privacy-ops.js";
import { PRIVACY_LAWS, PRIVACY_LAW_PRESETS, PRIVACY_PACKS, privacyPresetPatch } from "./privacy-packs.js";
import { dimensionForControl } from "./trust-dimensions.js";

const loose = { dsrSlaDays: 90, piiInternationalCategories: [] as string[], privacyOpsEnabled: false };

describe("presets only tighten", () => {
  it("each preset's period is the statute's or the strict default, whichever is shorter; categories are real detectors", () => {
    expect(Object.fromEntries(PRIVACY_LAWS.map((l) => [l, PRIVACY_LAW_PRESETS[l].dsrSlaDays]))).toEqual({ gdpr: 30, ccpa: 30, dpdp: 30, lgpd: 15 });
    for (const l of PRIVACY_LAWS) {
      expect(PRIVACY_LAW_PRESETS[l].dsrSlaDays).toBeLessThanOrEqual(DSR_DEFAULT_SLA_DAYS);
      for (const c of PRIVACY_LAW_PRESETS[l].piiInternationalCategories) expect(INTERNATIONAL_PII_CATEGORIES).toContain(c);
    }
  });

  it("a loose org gets the period, the identifiers and the processing limit", () => {
    expect(privacyPresetPatch(["lgpd"], loose)).toEqual({ dsrSlaDays: 15, piiInternationalCategories: ["cpf"], privacyOpsEnabled: true });
  });

  it("several laws combine to the strictest: the shortest period and every identifier", () => {
    expect(privacyPresetPatch(["gdpr", "dpdp", "lgpd"], loose)).toEqual({
      dsrSlaDays: 15,
      piiInternationalCategories: ["aadhaar", "bsn", "codice_fiscale", "cpf", "dni_nie", "nir", "steuer_id"],
      privacyOpsEnabled: true,
    });
  });

  it("never loosens: a shorter period, existing categories and the limit already on are left alone", () => {
    const strict = { dsrSlaDays: 7, piiInternationalCategories: ["cpf", "sin"], privacyOpsEnabled: true };
    expect(privacyPresetPatch(["lgpd", "ccpa"], strict)).toEqual({});
    expect(privacyPresetPatch(["gdpr"], strict)).toEqual({
      piiInternationalCategories: ["cpf", "sin", "bsn", "codice_fiscale", "dni_nie", "nir", "steuer_id"],
    });
    expect(privacyPresetPatch([], loose)).toEqual({});
  });
});

describe("packs", () => {
  it("parse, are seeded once, are in the picker vocabulary, and are pinned", () => {
    for (const p of PRIVACY_PACKS) {
      createCompliancePackSchema.parse(p);
      expect(DEFAULT_COMPLIANCE_PACKS.filter((x) => x.framework === p.framework)).toHaveLength(1);
      expect(COMPLIANCE_PACK_FRAMEWORKS as readonly string[]).toContain(p.framework);
    }
    const digest = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
    expect(Object.fromEntries(PRIVACY_PACKS.map((p) => [p.framework, digest(p)]))).toEqual(PINNED);
  });

  it("claim no review or compliance; every title cites an article or section", () => {
    for (const p of PRIVACY_PACKS) {
      expect(p.provenance.reviewedBy).toBeNull();
      expect(JSON.stringify(p.controls)).not.toMatch(/\b(compliant|certified)\b/i);
      for (const c of p.controls) expect(c.title, c.controlRef).toMatch(/^(Art\. |§ |s\. )\S.* — \S/);
    }
  });

  it("attested controls use `none` and say what to attest; every control is a privacy control on the radar", () => {
    for (const c of PRIVACY_PACKS.flatMap((p) => p.controls)) {
      if (c.attestationRequired) {
        expect(c.collector, c.controlRef).toBe("none");
        expect(c.ownerNote ?? "", c.controlRef).toMatch(/Attest/);
      } else expect(c.collector, c.controlRef).not.toBe("none");
      expect(dimensionForControl(c), c.controlRef).toBe("privacy");
    }
  });

  it("GUARD: every audit_decisions filter starts a rule id the gateway's privacy operations write", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const gateway = readFileSync(path.resolve(here, "../../../apps/gateway/src/privacy-ops.ts"), "utf8");
    const checked = new Set<string>();
    for (const c of PRIVACY_PACKS.flatMap((p) => p.controls).filter((x) => x.collector === "audit_decisions")) {
      const prefix = c.collectorParams?.ruleIdPrefix;
      expect(prefix, c.controlRef).toBeTruthy();
      expect(gateway.includes(`"${prefix}`), `${c.controlRef}: nothing writes a rule id starting '${prefix}'`).toBe(true);
      checked.add(prefix!);
    }
    expect([...checked].sort()).toEqual([
      "data-subject-request-",
      "data-subject-request-closed",
      "data-subject-request-erased",
      "processing-not-permitted",
      "processing-record-",
    ]);
  });
});

/** content hashes of the published versions: a change is a new version (ADR-0058) */
const PINNED: Record<string, string> = {
  gdpr: "cfa4c4f9430df90fb710729da81c9b572910ed393f0a5ecaabbc959ce47db36b",
  ccpa: "16f2afb73784ae221fc36b14ed9acb16085e7b31605856288b5081ed729c3ab8",
  dpdp: "43bdb45c13a64adff3ea135cfc60c538f8313215f5d931b40dffe005a2585786",
  lgpd: "c4ea8d6235311e572b8303a2095007117dee289a9a2269cfb9ae86d2a72f5b71",
};
