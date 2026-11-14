/**
 * ADR-0243 (PENDING P24) — the OWASP packs.
 *
 *  1. SCHEMA: each new pack version parses with the pack schema, sits in the
 *     seed catalogue, and claims no review.
 *  2. LICENCE: cited by ID only. Every title starts with its OWASP identifier;
 *     no title, description or note carries an OWASP risk name.
 *  3. NO ORPHANED IDs: each edition cites each of its ten identifiers exactly
 *     once, the crosswalk is complete in both directions, and every v1 control
 *     has its successor in v2 (no risk is dropped by the new edition).
 *  4. THE EDITION DIFF (ADR-0087, the review an admin sees before activating
 *     v2): ten title changes, one scope change, no control added or removed and
 *     no mapping changed. And the reason the refs are risk slugs: matching by
 *     OWASP number would carry Supply Chain's mapping onto Excessive Agency.
 *  5. GUARD: every `audit_decisions` filter names a rule id or object type the
 *     gateway writes (the ISACA/NIST guard, reading the gateway's sources).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffCompliancePacks } from "./compliance-pack-diff.js";
import { COMPLIANCE_PACK_FRAMEWORKS, DEFAULT_COMPLIANCE_PACKS, createCompliancePackSchema } from "./compliance-packs.js";
import { IMPORT_ID_ONLY_LICENCES, importTextPolicy } from "./framework-imports.js";
import {
  OWASP_LLM_EDITIONS,
  OWASP_LLM_PACK,
  OWASP_LLM_PACK_V2,
  OWASP_LLM_SOURCES,
  OWASP_MCP_IDS,
  OWASP_MCP_PACK,
  OWASP_MCP_SOURCE,
  OWASP_PACKS,
} from "./owasp-packs.js";

const NEW = [OWASP_MCP_PACK, OWASP_LLM_PACK, OWASP_LLM_PACK_V2];
const ten = (prefix: string) => Array.from({ length: 10 }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
/** the identifier a title cites, e.g. "LLM03:2026" */
const citedId = (title: string) => /^((?:LLM|MCP)\d\d:\d{4}) — /.exec(title)?.[1] ?? null;

describe("schema: the OWASP pack versions parse and are seeded as drafts", () => {
  it.each(NEW.map((p) => [`${p.framework}@${p.version}`, p] as const))("%s parses with the pack schema", (_k, p) => {
    const res = createCompliancePackSchema.safeParse(p);
    expect(res.success, res.success ? "" : JSON.stringify(res.error.issues)).toBe(true);
  });

  it("all three are in the seed catalogue, once each, and their frameworks are in the picker vocabulary", () => {
    for (const p of OWASP_PACKS) {
      expect(DEFAULT_COMPLIANCE_PACKS.filter((x) => x.framework === p.framework && x.version === p.version)).toEqual([p]);
      expect(COMPLIANCE_PACK_FRAMEWORKS as readonly string[]).toContain(p.framework);
    }
  });

  it("every control ref is unique and starts with its framework id", () => {
    for (const p of NEW) {
      const refs = p.controls.map((c) => c.controlRef);
      expect(new Set(refs).size, `${p.framework}@${p.version}`).toBe(refs.length);
      for (const r of refs) expect(r.startsWith(`${p.framework}:`), r).toBe(true);
    }
  });

  it("no pack claims a review it has not had, and none claims compliance or certification", () => {
    for (const p of NEW) {
      expect(p.provenance.reviewedBy).toBeNull();
      expect(p.provenance.reviewedOn).toBeNull();
      expect(p.description).toMatch(/not a certification/);
      const prose = [p.title, p.description, ...p.controls.flatMap((c) => [c.title, c.description ?? "", c.ownerNote ?? ""])].join("\n");
      expect(prose).not.toMatch(/\bcompliant\b|\bcertified\b/i);
    }
  });
});

describe("licence: share-alike and non-commercial sources are cited by ID only (ADR-0176, ADR-0215)", () => {
  it("the recorded licences are ID-only licences under the import policy", () => {
    expect(OWASP_MCP_SOURCE.licence).toBe("CC-BY-NC-SA-4.0");
    expect(OWASP_LLM_SOURCES.licence).toBe("CC-BY-SA-4.0");
    for (const l of [OWASP_MCP_SOURCE.licence, OWASP_LLM_SOURCES.licence]) {
      expect(IMPORT_ID_ONLY_LICENCES as readonly string[]).toContain(l);
      expect(importTextPolicy(l)).toBe("id_only");
    }
  });

  it("the provenance of each pack names its licence", () => {
    expect(OWASP_MCP_PACK.provenance.note).toMatch(/CC BY-NC-SA 4\.0/);
    expect(OWASP_LLM_PACK.provenance.note).toMatch(/CC BY-SA 4\.0/);
    expect(OWASP_LLM_PACK_V2.provenance.note).toMatch(/CC BY-SA 4\.0/);
  });

  it("no OWASP risk name appears anywhere in the packs (our own wording only)", () => {
    // the published names, held here only to prove they are NOT in the data
    const names = [
      "Prompt Injection", "Sensitive Information Disclosure", "Supply Chain", "Data and Model Poisoning",
      "Improper Output Handling", "Excessive Agency", "System Prompt Leakage", "Vector and Embedding Weaknesses",
      "Misinformation", "Unbounded Consumption", "Hidden Context Exposure", "Token Mismanagement", "Scope Creep",
      "Tool Poisoning", "Dependency Tampering", "Command Injection", "Contextual Payloads",
      "Insufficient Authentication", "Lack of Audit", "Shadow MCP", "Over-Sharing",
    ];
    const prose = NEW.flatMap((p) => [p.title, p.description ?? "", ...p.controls.flatMap((c) => [c.title, c.description ?? "", c.ownerNote ?? ""])]).join("\n");
    for (const n of names) expect(prose.toLowerCase(), n).not.toContain(n.toLowerCase());
  });
});

describe("no orphaned control IDs", () => {
  it("owasp-mcp-top-10@1 cites MCP01:2025 … MCP10:2025, each exactly once, in order", () => {
    const ids = OWASP_MCP_PACK.controls.map((c) => citedId(c.title));
    expect(ids).toEqual(ten("MCP").map((x) => `${x}:2025`));
    expect(OWASP_MCP_PACK.controls.map((c) => OWASP_MCP_IDS[c.controlRef])).toEqual(ids);
    expect(Object.keys(OWASP_MCP_IDS).sort()).toEqual(OWASP_MCP_PACK.controls.map((c) => c.controlRef).sort());
  });

  it("each LLM edition cites its ten identifiers exactly once, and the crosswalk agrees with the titles", () => {
    for (const [pack, edition] of [[OWASP_LLM_PACK, 2025], [OWASP_LLM_PACK_V2, 2026]] as const) {
      const ids = pack.controls.map((c) => citedId(c.title));
      expect([...ids].sort(), `${edition}`).toEqual(ten("LLM").map((x) => `${x}:${edition}`));
      for (const c of pack.controls) expect(citedId(c.title)).toBe(`${OWASP_LLM_EDITIONS[c.controlRef]![edition]}:${edition}`);
    }
    // the crosswalk covers exactly the pack's controls, in both editions
    expect(Object.keys(OWASP_LLM_EDITIONS).sort()).toEqual(OWASP_LLM_PACK.controls.map((c) => c.controlRef).sort());
    for (const edition of [2025, 2026] as const) {
      expect(Object.values(OWASP_LLM_EDITIONS).map((e) => e[edition]).sort()).toEqual(ten("LLM"));
    }
  });

  it("the crosswalk records the 2026 renumbering (Excessive Agency is LLM03:2026, was LLM06:2025)", () => {
    expect(OWASP_LLM_EDITIONS["owasp-llm-top-10:agent-overreach"]).toEqual({ 2025: "LLM06", 2026: "LLM03" });
    expect(OWASP_LLM_EDITIONS["owasp-llm-top-10:model-supply-chain"]).toEqual({ 2025: "LLM03", 2026: "LLM04" });
    expect(OWASP_LLM_EDITIONS["owasp-llm-top-10:unsafe-output-use"]).toEqual({ 2025: "LLM05", 2026: "LLM10" });
  });

  it("every v1 control has its successor in v2, and v2 adds none (same ten risks)", () => {
    expect(OWASP_LLM_PACK_V2.controls.map((c) => c.controlRef)).toEqual(OWASP_LLM_PACK.controls.map((c) => c.controlRef));
  });
});

describe("the edition diff: owasp-llm-top-10@1 (2025) → @2 (2026), as an admin reviews it before activation", () => {
  const diff = diffCompliancePacks(OWASP_LLM_PACK, OWASP_LLM_PACK_V2);

  it("adds and removes nothing, and leaves the cascade tag alone", () => {
    expect(diff.controlsAdded).toEqual([]);
    expect(diff.controlsRemoved).toEqual([]);
    expect(diff.cascadeTagChange).toBeNull();
    expect(diff.identical).toBe(false);
  });

  it("changes every title (the edition's identifier), and only the hidden-context risk's description", () => {
    expect(diff.summary.controlsChanged).toBe(10);
    for (const ch of diff.controlsChanged) {
      const fields = ch.fields.map((f) => f.field);
      const expected = ch.controlRef === "owasp-llm-top-10:hidden-context-leak" ? ["title", "description"] : ["title"];
      expect(fields, ch.controlRef).toEqual(expected);
      const title = ch.fields.find((f) => f.field === "title")!;
      expect(citedId(String(title.from))).toMatch(/:2025$/);
      expect(citedId(String(title.to))).toMatch(/:2026$/);
    }
  });

  it("no coverage, collector, parameter, threshold, attestation or owner note moves between editions", () => {
    const mappingFields = new Set(["coverage", "collector", "collectorParams", "minEvidenceCount", "attestationRequired", "ownerNote"]);
    for (const ch of diff.controlsChanged) for (const f of ch.fields) expect(mappingFields.has(f.field), `${ch.controlRef} ${f.field}`).toBe(false);
  });

  it("pack-level changes are the title, description and provenance only", () => {
    expect(diff.packChanges.map((c) => c.field)).toEqual(["title", "description", "provenance"]);
  });

  it("matching by OWASP number instead would carry 2025's LLM03 mapping onto a different 2026 risk (why refs are risk slugs)", () => {
    const byNumber = (pack: typeof OWASP_LLM_PACK, edition: 2025 | 2026) =>
      new Map(pack.controls.map((c) => [OWASP_LLM_EDITIONS[c.controlRef]![edition], c.controlRef]));
    const v1 = byNumber(OWASP_LLM_PACK, 2025);
    const v2 = byNumber(OWASP_LLM_PACK_V2, 2026);
    const moved = ten("LLM").filter((n) => v1.get(n) !== v2.get(n));
    expect(moved).toEqual(["LLM03", "LLM04", "LLM05", "LLM06", "LLM07", "LLM08", "LLM09", "LLM10"]);
    expect(v1.get("LLM03")).toBe("owasp-llm-top-10:model-supply-chain");
    expect(v2.get("LLM03")).toBe("owasp-llm-top-10:agent-overreach");
  });
});

describe("honest coverage", () => {
  it("training-data poisoning is unaddressed and attestation-required (the platform does not train models)", () => {
    for (const p of [OWASP_LLM_PACK, OWASP_LLM_PACK_V2]) {
      const c = p.controls.find((x) => x.controlRef === "owasp-llm-top-10:training-data-poisoning")!;
      expect(c.coverage).toBe("unaddressed");
      expect(c.attestationRequired).toBe(true);
      expect(c.collector).toBe("none");
      expect(c.ownerNote).toMatch(/not addressed by the platform/i);
    }
  });

  it("every attestation-only control uses the `none` collector and says what the organisation attests", () => {
    for (const p of NEW) {
      for (const c of p.controls.filter((x) => x.attestationRequired)) {
        expect(c.collector, c.controlRef).toBe("none");
        expect(c.ownerNote ?? "", c.controlRef).toMatch(/Attest/);
      }
      for (const c of p.controls.filter((x) => !x.attestationRequired)) expect(c.collector, c.controlRef).not.toBe("none");
    }
  });
});

// ---------------------------------------------------------------------------
// GUARD — audit evidence is evidence the gateway really writes
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(HERE, "../../../apps/gateway/src");
/** pack data files cite rule ids; they are not producers of them */
const PACK_DATA = new Set(["compliance-packs.ts", "isaca-pack.ts", "owasp-packs.ts"]);
/** the gateway's sources plus the shared rule-id constants it writes with (tests and pack data excluded) */
function producerSource(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules" && name !== "dist" && name !== "framework-imports-data") walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !PACK_DATA.has(name)) {
        out.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(GATEWAY);
  walk(HERE);
  return out.join("\n");
}

describe("GUARD: every audit_decisions filter in the OWASP packs names evidence the gateway writes", () => {
  const source = producerSource();

  it("reads the gateway's sources (non-vacuous)", () => {
    expect(source.length).toBeGreaterThan(100_000);
    expect(source).toContain('"mcp-admission-held"');
  });

  it("each ruleIdPrefix starts a written rule id literal, each objectType is a written object type", () => {
    const checked: string[] = [];
    for (const p of NEW) {
      for (const c of p.controls.filter((x) => x.collector === "audit_decisions")) {
        const { ruleIdPrefix, objectType } = c.collectorParams ?? {};
        expect(ruleIdPrefix || objectType, `${c.controlRef}: an unfiltered audit count evidences nothing specific`).toBeTruthy();
        if (ruleIdPrefix) {
          expect(source.includes(`"${ruleIdPrefix}`), `${c.controlRef}: no gateway code writes a rule id starting '${ruleIdPrefix}'`).toBe(true);
          checked.push(ruleIdPrefix);
        }
        if (objectType) {
          expect(source.includes(`objectType: "${objectType}"`), `${c.controlRef}: nothing writes objectType '${objectType}'`).toBe(true);
          checked.push(objectType);
        }
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(7);
  });
});
