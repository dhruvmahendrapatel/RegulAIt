/**
 * ADR-0175 (A1) — GUARD: every NIST AI RMF reference in the repository names a
 * real subcategory, and nothing outside the frozen pack versions points at a
 * superseded mapping.
 *
 * Before this test, `nist-ai-rmf@1/2` filed accountability under GOVERN 1.2
 * and deactivation under MANAGE 2.2, and those ids spread to intake
 * suggestions, the demo library, regulatory updates and a model card. Both are
 * REAL ids with a different meaning, so "is it one of the 72" alone could not
 * have caught them. The checks, from the list outward:
 *
 *  1. the checked-in list is the 72 subcategories, in the source's shape;
 *  2. every bare id (`GOVERN 1.2`, `MANAGE-2.4`) in scanned source is one of them;
 *  3. every `nist-ai-rmf:` ref OUTSIDE the pack definitions and tests is a
 *     control of the LATEST nist pack — v1/v2 are immutable history, and a
 *     consumer citing an id only they carry is citing a withdrawn mapping;
 *  4. every labelled ref (`NIST AI RMF 1.0 — MAP 1.1 (…)`) carries the list's
 *     title for that id, so a label cannot describe a different subcategory;
 *  5. the specific confusions are pinned in the data that caused them;
 *  6. every audit-log evidence filter in the latest pack names a rule id or
 *     object type the gateway actually writes, so a control cannot be added on
 *     evidence that is never produced.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPLIANCE_PACKS } from "./compliance-packs.js";
import { DEMO_INTAKE_FIXTURES } from "./demo-intake/fixtures.js";
import { SCENARIO_LIBRARY } from "./demo-intake/scenario-library.js";
import { CATEGORY_SUGGESTED_CONTROLS } from "./intake-assist.js";
import { NIST_AI_RMF_SUBCATEGORIES, isNistAiRmfSubcategory, nistAiRmfLabel, normaliseNistAiRmfId } from "./nist-ai-rmf-subcategories.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const SELF = path.relative(REPO, fileURLToPath(import.meta.url));

/** where references live: pack definitions, intake assist, demo library and
 * fixtures, the gateway (demo setup, tests), the console and its e2e mocks,
 * scripts, and the product docs (the demo runbook). ADRs and session notes are
 * immutable history and are deliberately not scanned. */
const SCAN_ROOTS = ["packages", "apps/gateway/src", "apps/web/src", "apps/web/e2e", "scripts", "docs/product"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".sh", ".yaml", ".yml"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "artifacts", "test-results", "playwright-report"]);

function walk(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(name))) out.push(full);
  }
}

const FILES = (() => {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO, root), out);
  return out.map((f) => ({ rel: path.relative(REPO, f), text: readFileSync(f, "utf8") })).filter((f) => f.rel !== SELF);
})();

function hits(re: RegExp): Array<{ rel: string; line: number; match: RegExpExecArray }> {
  const found: Array<{ rel: string; line: number; match: RegExpExecArray }> = [];
  for (const f of FILES) {
    const lines = f.text.split("\n");
    lines.forEach((text, i) => {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = g.exec(text)) !== null) found.push({ rel: f.rel, line: i + 1, match: m });
    });
  }
  return found;
}

const nistPacks = DEFAULT_COMPLIANCE_PACKS.filter((p) => p.framework === "nist-ai-rmf");
const latest = nistPacks.reduce((a, b) => (b.version > a.version ? b : a));
const latestRefs = new Set(latest.controls.map((c) => c.controlRef));

describe("the checked-in list is the 72 subcategories of NIST AI 100-1 Tables 1–4", () => {
  it("has the source's shape: per category, consecutive subcategories", () => {
    const shape: Record<string, number[]> = {
      // category number -> subcategory count, per function, from Tables 1-4
      GOVERN: [7, 3, 2, 3, 2, 2],
      MAP: [6, 3, 5, 2, 2],
      MEASURE: [3, 13, 3, 3],
      MANAGE: [4, 4, 2, 3],
    };
    const expected = Object.entries(shape).flatMap(([fn, counts]) =>
      counts.flatMap((n, cat) => Array.from({ length: n }, (_, i) => `${fn}-${cat + 1}.${i + 1}`)),
    );
    expect(expected).toHaveLength(72);
    expect(NIST_AI_RMF_SUBCATEGORIES.map((x) => x.id)).toEqual(expected);
    expect(new Set(NIST_AI_RMF_SUBCATEGORIES.map((x) => x.id)).size).toBe(72);
    for (const x of NIST_AI_RMF_SUBCATEGORIES) {
      expect(x.title.length, x.id).toBeGreaterThan(5);
      expect(x.title.length, `${x.id}: keep titles short paraphrases`).toBeLessThanOrEqual(90);
    }
  });

  it("normalises the three spellings and refuses an invented id", () => {
    expect(normaliseNistAiRmfId("nist-ai-rmf:MANAGE-2.4")).toBe("MANAGE-2.4");
    expect(normaliseNistAiRmfId("MANAGE 2.4")).toBe("MANAGE-2.4");
    expect(isNistAiRmfSubcategory("GOVERN 2.1")).toBe(true);
    expect(isNistAiRmfSubcategory(["GOVERN", "7.1"].join("-"))).toBe(false);
    expect(isNistAiRmfSubcategory(["MEASURE", "2.14"].join("-"))).toBe(false);
    expect(() => nistAiRmfLabel(["MAP", "6.1"].join(" "))).toThrow();
    expect(nistAiRmfLabel("MAP-1.1")).toMatch(/^NIST AI RMF 1\.0 — MAP 1\.1 \(.+\)$/);
  });
});

describe("every NIST AI RMF reference in the repository is real and current", () => {
  it("the scan actually reads the places references live (non-vacuity)", () => {
    const rels = FILES.map((f) => f.rel);
    for (const must of [
      "packages/shared/src/compliance-packs.ts",
      "packages/shared/src/intake-assist.ts",
      "packages/shared/src/demo-intake/scenario-library.ts",
      "packages/shared/src/demo-intake/fixtures.ts",
      "packages/shared/src/demo-intake/regulatory-updates.ts",
      "apps/gateway/src/demo-setup.ts",
      "docs/product/DEMO_RUNBOOK.md",
    ]) {
      expect(rels, must).toContain(must);
    }
    expect(hits(/nist-ai-rmf:[A-Z]+-\d+\.\d+/).length).toBeGreaterThan(50);
  });

  it("every bare subcategory id is one of the 72", () => {
    const bad = hits(/\b(GOVERN|MAP|MEASURE|MANAGE)[ -](\d{1,2}\.\d{1,2})\b/)
      .filter((h) => !isNistAiRmfSubcategory(`${h.match[1]}-${h.match[2]}`))
      .map((h) => `${h.rel}:${h.line} ${h.match[0]}`);
    expect(bad, "not a NIST AI RMF 1.0 subcategory (NIST AI 100-1 Tables 1-4)").toEqual([]);
  });

  it("every nist-ai-rmf: ref outside the pack definitions and tests is a control of the latest pack", () => {
    expect(latest.version).toBeGreaterThanOrEqual(3);
    const bad = hits(/nist-ai-rmf:([A-Z]+-\d+\.\d+)/)
      .filter((h) => h.rel !== "packages/shared/src/compliance-packs.ts" && !/\.test\.tsx?$/.test(h.rel))
      .filter((h) => !latestRefs.has(`nist-ai-rmf:${h.match[1]}`))
      .map((h) => `${h.rel}:${h.line} ${h.match[0]}`);
    expect(bad, `not a control of nist-ai-rmf v${latest.version} — v1/v2 refs are superseded mappings`).toEqual([]);
  });

  it("every nist-ai-rmf control in every shipped pack version names one of the 72", () => {
    for (const p of nistPacks) {
      for (const c of p.controls) expect(isNistAiRmfSubcategory(c.controlRef), `v${p.version} ${c.controlRef}`).toBe(true);
    }
  });

  it("every labelled reference carries the list's title for its id", () => {
    const bad = hits(/NIST AI RMF 1\.0 — (GOVERN|MAP|MEASURE|MANAGE) (\d+\.\d+) \(([^)]*)\)/)
      .filter((h) => nistAiRmfLabel(`${h.match[1]}-${h.match[2]}`) !== h.match[0])
      .map((h) => `${h.rel}:${h.line} ${h.match[0]}`);
    expect(bad, "label does not match NIST_AI_RMF_SUBCATEGORIES (use nistAiRmfLabel)").toEqual([]);
  });
});

describe("the specific confusions stay corrected", () => {
  it("intake suggestions cite fairness, deactivation and roles under their real ids", () => {
    expect(CATEGORY_SUGGESTED_CONTROLS.bias_fairness).toContain("nist-ai-rmf:MEASURE-2.11");
    expect(CATEGORY_SUGGESTED_CONTROLS.bias_fairness).not.toContain("nist-ai-rmf:MEASURE-2.7");
    expect(CATEGORY_SUGGESTED_CONTROLS.tool_misuse).toContain("nist-ai-rmf:MANAGE-2.4");
    expect(CATEGORY_SUGGESTED_CONTROLS.over_permissioning).toContain("nist-ai-rmf:GOVERN-2.1");
    const all = Object.values(CATEGORY_SUGGESTED_CONTROLS).flat();
    expect(all).not.toContain("nist-ai-rmf:MANAGE-2.2");
    expect(all).not.toContain("nist-ai-rmf:GOVERN-1.2");
  });

  it("no risk in the intake suggestions, demo library or demo fixtures cites a known-confused id for its category", () => {
    // GOVERN 1.2 and MEASURE 2.7 are real subcategories, so check 3 cannot see
    // them misused; the misuse was always by risk CATEGORY, so pin it there.
    const FORBIDDEN: Record<string, string[]> = {
      bias_fairness: ["nist-ai-rmf:MEASURE-2.7", "nist-ai-rmf:GOVERN-1.2"],
      hallucination: ["nist-ai-rmf:MEASURE-2.7"],
      data_leakage_pii: ["nist-ai-rmf:MEASURE-2.7"],
      over_permissioning: ["nist-ai-rmf:GOVERN-1.2"],
      tool_misuse: ["nist-ai-rmf:GOVERN-1.2"],
      prompt_injection: ["nist-ai-rmf:GOVERN-1.2"],
    };
    const cited: Array<{ where: string; category: string; refs: readonly string[] }> = [
      ...Object.entries(CATEGORY_SUGGESTED_CONTROLS).map(([category, refs]) => ({ where: "intake-assist", category, refs })),
      ...SCENARIO_LIBRARY.map((s) => ({ where: `scenario ${s.key}`, category: s.category, refs: s.suggestedControls })),
      ...DEMO_INTAKE_FIXTURES.risks.map((r) => ({ where: `fixture ${r.key}`, category: r.category, refs: r.controls })),
    ];
    expect(cited.length).toBeGreaterThan(40);
    const bad = cited.flatMap((c) =>
      c.refs.filter((r) => r === "nist-ai-rmf:MANAGE-2.2" || (FORBIDDEN[c.category] ?? []).includes(r)).map((r) => `${c.where} (${c.category}) ${r}`),
    );
    expect(bad).toEqual([]);
  });

  it("the latest pack keys accountability to GOVERN 2.1, deactivation to MANAGE 2.4, and GOVERN 1.2 to the trust dimensions", () => {
    const by = new Map(latest.controls.map((c) => [c.controlRef, c]));
    expect(by.get("nist-ai-rmf:GOVERN-2.1")?.collector).toBe("abac_policies_active");
    expect(by.get("nist-ai-rmf:MANAGE-2.4")?.collectorParams).toEqual({ effect: "deny" });
    expect(by.has("nist-ai-rmf:MANAGE-2.2")).toBe(false);
    expect(`${by.get("nist-ai-rmf:GOVERN-1.2")?.title} ${by.get("nist-ai-rmf:GOVERN-1.2")?.description}`).toMatch(/trust dimension/);
  });
});

describe("the latest pack's audit-log evidence is evidence the gateway really writes", () => {
  const gatewaySource = FILES.filter(
    (f) => f.rel.startsWith("apps/gateway/src/") && !/\.test\.ts$/.test(f.rel) && f.rel.endsWith(".ts"),
  )
    .map((f) => f.text)
    .join("\n");
  /** rule ids the gateway builds from a template rather than a literal: the
   * literal cannot be grepped, so the template is named and checked instead */
  const TEMPLATED: Record<string, string> = { "use-case-approved": "ruleId: `use-case-${next}`" };

  it("each ruleIdPrefix appears as a written rule id, and each objectType is a ledger object type", () => {
    const audit = latest.controls.filter((c) => c.collector === "audit_decisions");
    expect(audit.length).toBeGreaterThan(10);
    for (const c of audit) {
      const prefix = c.collectorParams.ruleIdPrefix;
      if (prefix) {
        const literal = gatewaySource.includes(`"${prefix}`);
        const templated = TEMPLATED[prefix] !== undefined && gatewaySource.includes(TEMPLATED[prefix]!);
        expect(literal || templated, `${c.controlRef}: no gateway code writes a rule id starting '${prefix}'`).toBe(true);
      }
      const objectType = c.collectorParams.objectType;
      if (objectType) {
        expect(gatewaySource.includes(`objectType: "${objectType}"`), `${c.controlRef}: nothing writes objectType '${objectType}'`).toBe(true);
      }
    }
  });
});
