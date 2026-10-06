/**
 * ADR-0182 (ADR-0175 batch D4) S5 — THE PACKS: `isaca-ai-agents@1`,
 * `nist-ai-rmf@4`, `eu-ai-act@3`, and the four accountability collectors.
 *
 *  1. Every version published BEFORE this batch is byte-for-byte unchanged
 *     (sha256 of its JSON, taken from the build before S5): a correction is a
 *     new version, never a rewrite.
 *  2. The ISACA pack is one control per checklist item, honest about items 3
 *     and 5, cites the publication and claims no review.
 *  3. GUARD: every `audit_decisions` filter in the new versions names a rule id
 *     (prefix) or an object type the gateway really writes, so no control is
 *     mapped onto evidence nobody produces (the NIST guard's pattern, D1).
 *  4. nist-ai-rmf@4 is v3 plus the accountability records; eu-ai-act@3 quotes
 *     Article 4 as replaced by Regulation (EU) 2026/1744 and adds Article 73.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPLIANCE_PACKS, EVIDENCE_COLLECTORS, createCompliancePackSchema } from "./compliance-packs.js";
import { ISACA_AI_AGENTS_PACK, ISACA_AI_AGENTS_SOURCE } from "./isaca-pack.js";
import { isNistAiRmfSubcategory } from "./nist-ai-rmf-subcategories.js";

const pack = (framework: string, version: number) => {
  const p = DEFAULT_COMPLIANCE_PACKS.find((x) => x.framework === framework && x.version === version);
  if (!p) throw new Error(`no ${framework}@${version}`);
  return p;
};
const digest = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");

describe("every pack version published before S5 is unchanged (content hash)", () => {
  // taken from the build at d4-p0 (0eee3ab), before this slice touched the file
  const PINNED: Record<string, string> = {
    "eu-ai-act@1": "9d2b3fde62bf3af3fe3db2d79564101db5650459387d96c4e23064727e4368e8",
    "nist-ai-rmf@1": "505b02ede976ece7148e14119ba21917f52774cfd61a31633135a83bdb0b988a",
    "iso-27001@1": "dae732bf0e565de7d9ef807ceb0c3b9a2d280dfc2dad808669af608f4da08c86",
    "iso-42001@1": "34be548f41dc1dd3401ac97d6dc6cd08915e790a1909b4808d8c15a2923168ef",
    "hipaa@1": "a69f07989a7d49c834345f2f658929116afb39a2360dbd4885d5efcf981769a0",
    "pci-dss@1": "0188e3c6d69cd896dd5d6ed4c44e02bbf333dd03c0719f46dc04549b6ccb5358",
    "finra@1": "597ca322928a0de576c323fd3628c256c155d35dad469d63d17672d330b8d77d",
    "soc-2@1": "1197cbf7c2c667028871fda8a65ecb5e6333abfb235352869654c90ea9aa60d2",
    "eu-ai-act@2": "8171fd72dc0add47cbf60a72963ac02462b7bcd542de84e648358da348164840",
    "nist-ai-rmf@2": "8a51156213b6a81253cae990f6e047da6be0701fd57d28106b3f3305ecaa110b",
    "nist-ai-rmf@3": "d4cbc513d4d0c7f8416ac97dc286639d19c889bd45f4a7ef593ad641306a4eb0",
  };
  it.each(Object.entries(PINNED))("%s", (key, hash) => {
    const [fw, v] = key.split("@");
    expect(digest(pack(fw!, Number(v)))).toBe(hash);
  });

  it("the new versions are exactly isaca-ai-agents@1, nist-ai-rmf@4 and eu-ai-act@3, and each parses", () => {
    const all = DEFAULT_COMPLIANCE_PACKS.map((p) => `${p.framework}@${p.version}`);
    expect(all.filter((k) => !(k in PINNED)).sort()).toEqual(["eu-ai-act@3", "isaca-ai-agents@1", "nist-ai-rmf@4"]);
    for (const k of ["eu-ai-act@3", "isaca-ai-agents@1", "nist-ai-rmf@4"]) {
      const [fw, v] = k.split("@");
      const res = createCompliancePackSchema.safeParse(pack(fw!, Number(v)));
      expect(res.success, `${k}: ${res.success ? "" : JSON.stringify(res.error.issues)}`).toBe(true);
    }
  });
});

describe("isaca-ai-agents@1 — one control per checklist item, honestly covered", () => {
  const controls = ISACA_AI_AGENTS_PACK.controls;

  it("has 15 controls, items 1–15 in order, each ref unique", () => {
    expect(controls).toHaveLength(15);
    controls.forEach((c, i) => expect(c.controlRef).toMatch(new RegExp(`^isaca-ai-agents:item-${String(i + 1).padStart(2, "0")}-[a-z-]+$`)));
    expect(new Set(controls.map((c) => c.controlRef)).size).toBe(15);
    expect(pack("isaca-ai-agents", 1)).toBe(ISACA_AI_AGENTS_PACK);
  });

  it("items 3 and 5 are unaddressed and attestation-required (ROADMAP §7.1: the platform does not do them)", () => {
    for (const n of [3, 5]) {
      const c = controls[n - 1]!;
      expect(c.coverage, `item ${n}`).toBe("unaddressed");
      expect(c.attestationRequired, `item ${n}`).toBe(true);
      expect(c.collector, `item ${n}`).toBe("none");
      expect(c.ownerNote, `item ${n}`).toMatch(/not addressed by the platform/i);
    }
    // nothing else is declared unaddressed, and no item claims more than §7.1 found
    expect(controls.filter((c) => c.coverage === "unaddressed").map((c) => c.controlRef)).toHaveLength(2);
    // §7.1 found exactly items 6, 9 and 11 fully met: only they may be declared enforced
    expect(controls.flatMap((c, i) => (c.coverage === "enforced" ? [i + 1] : []))).toEqual([6, 9, 11]);
  });

  it("cites the publication, says the titles are paraphrased, and claims no review", () => {
    expect(ISACA_AI_AGENTS_PACK.provenance.source).toBe(ISACA_AI_AGENTS_SOURCE);
    expect(ISACA_AI_AGENTS_SOURCE).toMatch(/ISACA/);
    expect(ISACA_AI_AGENTS_SOURCE).toMatch(/2026/);
    expect(ISACA_AI_AGENTS_PACK.provenance.note).toMatch(/paraphrase/);
    expect(ISACA_AI_AGENTS_PACK.provenance.note).toMatch(/copyrighted/);
    expect(ISACA_AI_AGENTS_PACK.provenance.reviewedBy ?? null).toBeNull();
    // a paraphrase is not a quotation: no control text carries quoted passages
    for (const c of controls) expect(`${c.title} ${c.description ?? ""}`, c.controlRef).not.toMatch(/["“”]/);
  });

  it("never claims compliance", () => {
    expect(JSON.stringify(ISACA_AI_AGENTS_PACK)).not.toMatch(/\bcompliant\b/i);
  });
});

describe("nist-ai-rmf@4 and eu-ai-act@3", () => {
  it("nist v4 keeps every v3 control unchanged except GOVERN 2.2, which is now evidenced by acknowledgements", () => {
    const v3 = new Map(pack("nist-ai-rmf", 3).controls.map((c) => [c.controlRef, c]));
    const v4 = new Map(pack("nist-ai-rmf", 4).controls.map((c) => [c.controlRef, c]));
    for (const [ref, c] of v3) {
      if (ref === "nist-ai-rmf:GOVERN-2.2") continue;
      expect(v4.get(ref), ref).toEqual(c);
    }
    expect(v3.get("nist-ai-rmf:GOVERN-2.2")?.attestationRequired).toBe(true);
    expect(v4.get("nist-ai-rmf:GOVERN-2.2")).toMatchObject({ collector: "literacy_acknowledgements", attestationRequired: false, coverage: "partial" });
  });

  it("nist v4 adds GOVERN 4.3, GOVERN 5.1, MANAGE 4.3, MEASURE 2.13 and MEASURE 3.3 on the new collectors", () => {
    const v4 = new Map(pack("nist-ai-rmf", 4).controls.map((c) => [c.controlRef, c]));
    expect(v4.get("nist-ai-rmf:GOVERN-4.3")?.collector).toBe("incident_register");
    expect(v4.get("nist-ai-rmf:MANAGE-4.3")?.collector).toBe("incident_register");
    expect(v4.get("nist-ai-rmf:GOVERN-5.1")?.collector).toBe("user_feedback_channel");
    expect(v4.get("nist-ai-rmf:MEASURE-3.3")?.collector).toBe("user_feedback_channel");
    expect(v4.get("nist-ai-rmf:MEASURE-2.13")?.collector).toBe("decision_regression_runs");
    expect(pack("nist-ai-rmf", 4).controls.length).toBe(pack("nist-ai-rmf", 3).controls.length + 5);
    for (const c of pack("nist-ai-rmf", 4).controls) expect(isNistAiRmfSubcategory(c.controlRef), c.controlRef).toBe(true);
    expect(pack("nist-ai-rmf", 4).provenance.note).toMatch(/v1, v2 and v3 are unchanged/);
  });

  it("eu v3 restates Article 4 in the amended wording (Reg. 2026/1744), never the 2024 wording", () => {
    const art4 = pack("eu-ai-act", 3).controls.find((c) => c.controlRef === "eu-ai-act:art-4-ai-literacy")!;
    expect(art4.description).toMatch(/take measures to support the development of AI literacy/);
    expect(art4.description).toMatch(/does not require providers or deployers to guarantee any specific level/);
    expect(art4.title).toMatch(/2026\/1744/);
    expect(JSON.stringify(art4)).not.toMatch(/sufficient level of AI literacy/);
    expect(art4).toMatchObject({ collector: "literacy_acknowledgements", attestationRequired: false });
    expect(pack("eu-ai-act", 3).provenance.note).toMatch(/2026\/1744/);
    expect(pack("eu-ai-act", 3).provenance.note).toMatch(/v1 and v2 are unchanged/);
  });

  it("eu v3 adds Article 73 on the incident register, with the periods and 'confirm with counsel'", () => {
    const art73 = pack("eu-ai-act", 3).controls.find((c) => c.controlRef === "eu-ai-act:art-73-serious-incident-reporting")!;
    expect(art73.collector).toBe("incident_register");
    expect(art73.description).toMatch(/15 days/);
    expect(art73.description).toMatch(/two days/);
    expect(art73.description).toMatch(/ten days/);
    expect(art73.ownerNote).toMatch(/not legal advice/);
    expect(art73.ownerNote).toMatch(/confirm with counsel/);
    // every v2 control is kept
    const v3 = new Set(pack("eu-ai-act", 3).controls.map((c) => c.controlRef));
    for (const c of pack("eu-ai-act", 2).controls) expect(v3, c.controlRef).toContain(c.controlRef);
  });

  it("each of the four accountability collectors evidences at least one shipped control", () => {
    const used = new Set(DEFAULT_COMPLIANCE_PACKS.flatMap((p) => p.controls.map((c) => c.collector)));
    for (const id of ["incident_register", "user_feedback_channel", "literacy_acknowledgements", "decision_regression_runs"] as const) {
      expect(EVIDENCE_COLLECTORS).toContain(id);
      expect(used, id).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// GUARD — the audit-log evidence of the new versions is evidence the gateway
// really writes (non-vacuous: it must read the gateway's sources)
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(HERE, "../../../apps/gateway/src");
function gatewaySources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules" && name !== "dist") walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push({ rel: path.relative(GATEWAY, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(GATEWAY);
  return out;
}

describe("GUARD: every audit_decisions filter in the S5 pack versions names evidence the gateway writes", () => {
  const files = gatewaySources();
  const source = files.map((f) => f.text).join("\n");
  const S5_VERSIONS = [pack("isaca-ai-agents", 1), pack("nist-ai-rmf", 4), pack("eu-ai-act", 3)];

  it("reads the gateway's sources (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => f.rel)).toContain("execution-control.ts");
  });

  it("each ruleIdPrefix is the start of a written rule id literal, each objectType a written object type", () => {
    const checked: string[] = [];
    for (const p of S5_VERSIONS) {
      for (const c of p.controls.filter((x) => x.collector === "audit_decisions")) {
        const { ruleIdPrefix, objectType } = c.collectorParams;
        if (ruleIdPrefix) {
          expect(source.includes(`"${ruleIdPrefix}`), `${p.framework}@${p.version} ${c.controlRef}: no gateway code writes a rule id starting '${ruleIdPrefix}'`).toBe(true);
          checked.push(ruleIdPrefix);
        }
        if (objectType) {
          expect(source.includes(`objectType: "${objectType}"`), `${p.framework}@${p.version} ${c.controlRef}: nothing writes objectType '${objectType}'`).toBe(true);
          checked.push(objectType);
        }
      }
    }
    expect(checked.length).toBeGreaterThan(20);
  });

  it("each approvals filter names an approval object type the gateway writes", () => {
    for (const p of S5_VERSIONS) {
      for (const c of p.controls.filter((x) => x.collector === "approvals" && x.collectorParams.approvalObjectType)) {
        const t = c.collectorParams.approvalObjectType!;
        expect(new RegExp(`objectType: "${t}"`).test(source), `${c.controlRef}: no approval of type '${t}' is written`).toBe(true);
      }
    }
  });
});
