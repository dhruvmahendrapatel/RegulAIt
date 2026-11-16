/**
 * ADR-0296 part 2 (P18 B2) — privacy-law presets and packs.
 *
 *  1. PRESETS only tighten: the request period is never lengthened, identifier categories are only added, the
 *     processing limit is only turned on; several laws combine to the strictest; a strict org gets an empty patch.
 *  2. PACKS parse, are seeded once, claim no review or compliance, cite by article or section, and every
 *     `audit_decisions` filter names a rule id the gateway writes (read from its source).
 *  3. Every privacy control is filed under the privacy trust dimension.
 *  4. GDPR (owner decision 2026-11-15, P18 A5): every cited article has a one-line plain-language summary in our own
 *     words, each control's description carries its articles' summaries and the official EUR-Lex link.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_PACK_FRAMEWORKS, DEFAULT_COMPLIANCE_PACKS, createCompliancePackSchema } from "./compliance-packs.js";
import { INTERNATIONAL_PII_CATEGORIES } from "./pii-international.js";
import { DSR_DEFAULT_SLA_DAYS } from "./privacy-ops.js";
import {
  GDPR_ARTICLE_SUMMARIES,
  GDPR_CONTROL_ARTICLES,
  GDPR_EUR_LEX_URL,
  GDPR_PACK,
  PRIVACY_LAWS,
  PRIVACY_LAW_PRESETS,
  PRIVACY_PACKS,
  privacyPresetPatch,
} from "./privacy-packs.js";
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

describe("GDPR: article numbers, a plain-language summary per article, the official EUR-Lex link (owner, 2026-11-15)", () => {
  it("links the regulation's official EUR-Lex address", () => {
    expect(GDPR_EUR_LEX_URL).toBe("https://eur-lex.europa.eu/eli/reg/2016/679/oj");
    expect(GDPR_PACK.provenance.source).toContain(GDPR_EUR_LEX_URL);
  });

  it("every control's articles are the ones its title cites, and each has a one-line summary", () => {
    expect(Object.keys(GDPR_CONTROL_ARTICLES).sort()).toEqual(GDPR_PACK.controls.map((c) => c.controlRef).sort());
    const used = new Set(Object.values(GDPR_CONTROL_ARTICLES).flat());
    expect([...used].sort()).toEqual(Object.keys(GDPR_ARTICLE_SUMMARIES).sort());
    // the title's citation, expanded: "Art. 12(3), 15" is two articles; "Art. 5(1)(b)-(c)" is points (b) and (c)
    const cited = (title: string) =>
      title
        .split(" — ")[0]!
        .replace(/^Art\. /, "")
        .split(", ")
        .flatMap((a) => (a === "5(1)(b)-(c)" ? ["5(1)(b)", "5(1)(c)"] : [a]))
        .map((a) => `Art. ${a}`);
    for (const c of GDPR_PACK.controls) expect(GDPR_CONTROL_ARTICLES[c.controlRef], c.controlRef).toEqual(cited(c.title));
    for (const [a, summary] of Object.entries(GDPR_ARTICLE_SUMMARIES)) {
      expect(summary.length, a).toBeLessThanOrEqual(120);
      expect(summary, a).toMatch(/^[A-Z][^.]*\.$/); // one sentence
    }
  });

  it("each description carries its articles' summaries, says they are not the legal text, and links the official text", () => {
    for (const c of GDPR_PACK.controls) {
      for (const a of GDPR_CONTROL_ARTICLES[c.controlRef]!) expect(c.description, c.controlRef).toContain(`${a}: ${GDPR_ARTICLE_SUMMARIES[a]}`);
      expect(c.description, c.controlRef).toContain("not the legal text");
      expect(c.description, c.controlRef).toContain(`Official text: ${GDPR_EUR_LEX_URL}`);
    }
  });
});

describe("records of processing: a law without the duty is marked, not overstated (review, 2026-11-15)", () => {
  it("CCPA and DPDP cite their nearest provision as no direct equivalent; GDPR and LGPD cite the duty itself", () => {
    const rec = (fw: string) => PRIVACY_PACKS.find((p) => p.framework === fw)!.controls.find((c) => c.controlRef === `${fw}:records-of-processing`)!;
    for (const fw of ["ccpa", "dpdp"]) {
      expect(rec(fw).title, fw).toMatch(/\(no direct equivalent\) — /);
      expect(rec(fw).ownerNote, fw).toMatch(/has no records-of-processing duty/);
    }
    for (const fw of ["gdpr", "lgpd"]) expect(rec(fw).title, fw).not.toMatch(/no direct equivalent/);
  });

  it("the DPDP preset says the DPDP Rules, 2025 exist, though their periods are not encoded", () => {
    expect(PRIVACY_LAW_PRESETS.dpdp.statutoryPeriod).toMatch(/DPDP Rules, 2025/);
    expect(PRIVACY_LAW_PRESETS.dpdp.notes).toMatch(/DPDP Rules, 2025 are notified/);
  });
});

/** content hashes of the published versions: a change is a new version (ADR-0058) */
const PINNED: Record<string, string> = {
  gdpr: "086a80a23faeb1add32d10152797f0c8d879455afe49e3da58f41836572fa039",
  ccpa: "61f5aaa663fc6a69d26e92d20ca5c7cb11347cc8d827f7ae2d428acf69478748",
  dpdp: "5b073afd565c33e3ead5734a05ada8a0c92b4b8f66adae0464bdcf5172f62806",
  lgpd: "c4ea8d6235311e572b8303a2095007117dee289a9a2269cfb9ae86d2a72f5b71",
};
