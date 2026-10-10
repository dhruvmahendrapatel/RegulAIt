/**
 * ADR-0187 decisions 213-218 — our own per-probe OWASP 2025 table for garak (owner decision on open
 * question 19). These guards make a garak pin bump stop CI until every row has been re-reviewed.
 */
import { describe, expect, it } from "vitest";
import { OWASP_LLM_TOP_10_MAPPING, OWASP_LLM_TOP_10_NAMES } from "../owasp-framework-mappings.js";
import {
  ENGINE_MANIFEST,
  GARAK_OWASP_2025_REVIEW,
  GARAK_OWASP_2025_TABLE,
  GARAK_UPSTREAM_PROBES,
  GARAK_UPSTREAM_SOURCE_SHA256,
  GARAK_UPSTREAM_VERSION,
  OWASP_LLM_2025_IDS,
  garakOwasp2025,
  garakOwasp2025Coverage,
  garakOwasp2025Row,
} from "./index.js";

describe("garak OWASP 2025 table: one reviewed row per probe of the pinned release (decisions 215-216)", () => {
  it("has a row for every probe in garak-upstream.ts, and no row for a probe the release does not have", () => {
    const upstream = GARAK_UPSTREAM_PROBES.map((p) => p.probe);
    const rows = new Set(GARAK_OWASP_2025_TABLE.map((r) => r.probe));
    const missing = upstream.filter((p) => !rows.has(p));
    expect(missing, `probes with no OWASP 2025 row (review them and add a row each): ${missing.join(", ")}`).toEqual([]);
    const stale = [...rows].filter((p) => !upstream.includes(p));
    expect(stale, `rows for probes the pinned release does not have: ${stale.join(", ")}`).toEqual([]);
    expect(GARAK_OWASP_2025_TABLE).toHaveLength(upstream.length);
  });

  it("was reviewed against exactly the pinned release (a pin bump fails here until every row is re-read)", () => {
    expect(GARAK_OWASP_2025_REVIEW.garakVersion).toBe(GARAK_UPSTREAM_VERSION);
    expect(GARAK_OWASP_2025_REVIEW.pluginCacheSha256).toBe(GARAK_UPSTREAM_SOURCE_SHA256);
    expect(GARAK_OWASP_2025_REVIEW.garakVersion).toBe(ENGINE_MANIFEST.garak.version);
  });

  it("cites only official 2025 ids (an unknown risk id fails), each with a one-line rationale", () => {
    // the id vocabulary is the vendored 2025 table's, in order, with the official names
    expect([...OWASP_LLM_2025_IDS]).toEqual(Object.keys(OWASP_LLM_TOP_10_MAPPING));
    expect([...OWASP_LLM_TOP_10_NAMES]).toEqual([
      "Prompt Injection",
      "Sensitive Information Disclosure",
      "Supply Chain",
      "Data and Model Poisoning",
      "Improper Output Handling",
      "Excessive Agency",
      "System Prompt Leakage",
      "Vector and Embedding Weaknesses",
      "Misinformation",
      "Unbounded Consumption",
    ]);
    const known = new Set<string>(OWASP_LLM_2025_IDS);
    for (const r of GARAK_OWASP_2025_TABLE) {
      for (const id of r.owasp2025) expect(known.has(id), `${r.probe}: unknown OWASP 2025 id ${id}`).toBe(true);
      expect(new Set(r.owasp2025).size, `${r.probe}: duplicate id`).toBe(r.owasp2025.length);
      expect([...r.owasp2025], `${r.probe}: ids sorted`).toEqual([...r.owasp2025].sort());
      expect(r.rationale.trim().length, `${r.probe}: rationale`).toBeGreaterThan(20);
      expect(r.rationale, `${r.probe}: one line`).not.toMatch(/\n/);
    }
  });

  it("ignores garak's 2023 tags: the rows are our own judgement, not a renumbering", () => {
    // 2023 llm06 (Sensitive Information Disclosure) + llm10 (Model Theft) on the memorisation probes -> LLM02 only
    expect(garakOwasp2025("divergence.Repeat")).toEqual(["owasp:llm:02"]);
    expect(garakOwasp2025("leakreplay.NYTCloze")).toEqual(["owasp:llm:02"]);
    // the old crosswalk read web_injection's 2023 llm06 tag as a disclosure; the exfil payload carries planted
    // text, so only the output-handling risk is shown
    expect(garakOwasp2025("web_injection.MarkdownImageExfil")).toEqual(["owasp:llm:05"]);
    // agent_breaker: excessive agency through injected prompts
    expect(garakOwasp2025("agent_breaker.AgentBreaker")).toEqual(["owasp:llm:01", "owasp:llm:06"]);
    // untagged upstream, still mapped by evidence
    expect(garakOwasp2025("suffix.GCGCached")).toEqual(["owasp:llm:01"]);
    // tagged upstream (2023 llm01), but its failure is a content harm: none
    expect(garakOwasp2025("continuation.ContinueSlursReclaimedSlurs")).toEqual([]);
    expect(garakOwasp2025("sysprompt_extraction.SystemPromptExtraction")).toEqual(["owasp:llm:07"]);
    // a probe not in the table counts toward nothing
    expect(garakOwasp2025("nosuch.Probe")).toEqual([]);
    expect(garakOwasp2025Row("nosuch.Probe")).toBeNull();
    // the returned list is a copy: a caller cannot edit the table
    garakOwasp2025("divergence.Repeat").push("owasp:llm:10");
    expect(garakOwasp2025("divergence.Repeat")).toEqual(["owasp:llm:02"]);
  });

  it("coverage summary matches the reviewed snapshot (a changed row shows up here as a reviewed diff)", async () => {
    const c = garakOwasp2025Coverage();
    // headline counts, readable in the diff without opening the snapshot file
    expect(Object.fromEntries(c.risks.map((r) => [r.id, r.probes.length]))).toEqual({
      "owasp:llm:01": 94,
      "owasp:llm:02": 22,
      "owasp:llm:03": 1,
      "owasp:llm:04": 0,
      "owasp:llm:05": 17,
      "owasp:llm:06": 1,
      "owasp:llm:07": 1,
      "owasp:llm:08": 0,
      "owasp:llm:09": 16,
      "owasp:llm:10": 0,
    });
    expect(c.none).toHaveLength(40);
    await expect(`${JSON.stringify(c, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/garak-owasp-2025.coverage.json");
  });
});
