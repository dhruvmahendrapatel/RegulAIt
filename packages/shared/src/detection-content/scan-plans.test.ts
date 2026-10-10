/**
 * ADR-0186 decision 31 (B4I-02): the planned vendored-secret scan is exact.
 *   - differential: on the shared corpus (dense 400k inputs, forged markers, tokens, random fragments, near
 *     misses) and on seeded Unicode noise, the planned spans equal a plain full-text RE2 scan of every rule, and
 *     the candidate rules are exactly the rules RE2 matches anywhere;
 *   - equivalence: scrubAuditText output on the corpus is byte-identical to main before this change, pinned as
 *     per-group digests in scrub-equivalence.snapshot.json (generated from that implementation, never from this).
 * Correctness corpora, not latency budgets: the budgets live in scrub-dense.test.ts (timing project).
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scrubAuditText } from "../audit-scrub.js";
import { DENSE_INPUTS, scrubEquivalenceCorpus } from "../__fixtures__/scrub-equivalence-corpus.js";
import { GENERATED_SECRET_RULES, GENERATED_SECRET_SCAN_PLANS } from "./generated.js";
import { compileVendored, secretCandidateRules, spansOf, vendoredSecretSpans } from "./match.js";
import type { VendoredSecretRule } from "./types.js";

const RULES: readonly VendoredSecretRule[] = GENERATED_SECRET_RULES;

const identifier = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 45;
/** the reference: every rule, full text, RE2 only, no plan, no candidate selection. One pass per rule yields
 * both the redaction spans and whether RE2 matches the rule anywhere (before the provider boundary check). */
function fullScan(text: string) {
  const spans: Array<{ start: number; end: number; rule: string }> = [];
  const matched: string[] = [];
  for (const rule of RULES) {
    let any = false;
    for (const [start, end] of spansOf(compileVendored(rule.id, rule.pattern, rule.caseInsensitive)!, text)) {
      any = true;
      if (rule.leftBoundary === "ascii_identifier" && start > 0 && identifier(text.charCodeAt(start - 1))) continue;
      spans.push({ start, end, rule: rule.id });
    }
    if (any) matched.push(rule.id);
  }
  return { spans, matched };
}
function expectExact(text: string, label: string) {
  const reference = fullScan(text);
  expect(vendoredSecretSpans(text), label).toEqual(reference.spans);
  expect(secretCandidateRules(text).map((rule) => rule.id), label).toEqual(reference.matched);
}

describe("planned vendored-secret scan", () => {
  it("derives a plan for every shipped rule; no plan has a single-position gate", () => {
    const plans: Readonly<Record<string, { prefilter: string; maxLength: number | null }>> = GENERATED_SECRET_SCAN_PLANS;
    for (const rule of GENERATED_SECRET_RULES) {
      const plan = plans[rule.id];
      expect(plan, rule.id).toBeDefined();
      expect(() => new RegExp(plan!.prefilter, "gu"), rule.id).not.toThrow();
      // one class per position: the shortest shipped prefilter still pins eleven code points
      expect(plan!.prefilter.split("][").length, rule.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("equals a full RE2 scan of every rule on the dense 400k inputs", () => {
    for (const [name, text] of Object.entries(DENSE_INPUTS)) expectExact(text, name);
  }, 600_000);

  it("equals a full RE2 scan on the corpus: forged markers, tokens, random fragments, near misses", () => {
    for (const { group, inputs } of scrubEquivalenceCorpus()) {
      if (group === "dense") continue;
      inputs.forEach((text, i) => expectExact(text, `${group}[${i}]: ${JSON.stringify(text).slice(0, 120)}`));
    }
  }, 120_000);

  it("equals a full RE2 scan on seeded Unicode noise (astral, lone surrogates, case-fold lookalikes)", () => {
    let seed = 0x31b4_0202;
    const next = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
    const pool = [..."abcdefxyzABCDEFXYZ0123456789-_.:/=@+%'\" \t\nſKİéßﬁ", "😀", "\ud83d", "\ude00", " "];
    const words = ["sk", "SK", "key-", "xox", "AIza", "ghp_", "hf_", "r8_", "0x", "M", "postgres://", "sig=", "-----BEGIN ", "eyJ"];
    for (let i = 0; i < 1500; i++) {
      let text = "";
      for (let n = next() % 160; n > 0; n--) text += next() % 7 === 0 ? words[next() % words.length]! : pool[next() % pool.length]!;
      expectExact(text, `noise[${i}]: ${JSON.stringify(text)}`);
    }
  }, 120_000);

  it("scrubAuditText output is byte-identical to main before decision 31 on the whole corpus", () => {
    const snapshot = JSON.parse(readFileSync(path.join(import.meta.dirname, "scrub-equivalence.snapshot.json"), "utf8")) as { inputs: number; groups: Record<string, string> };
    const groups = scrubEquivalenceCorpus();
    expect(groups.reduce((n, g) => n + g.inputs.length, 0)).toBe(snapshot.inputs);
    for (const { group, inputs } of groups) {
      const digest = createHash("sha256").update(JSON.stringify(inputs.map((text) => scrubAuditText(text)))).digest("hex");
      expect(digest, group).toBe(snapshot.groups[group]);
    }
  }, 120_000);
});
