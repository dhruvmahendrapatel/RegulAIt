/**
 * ADR-0176 security fix 2 — the credential-material rules catch the current
 * provider token formats, reject near misses, and stay linear-time.
 *
 * Every sample is ASSEMBLED at runtime (`prefix + body.repeat(n)`), never
 * written out whole, so this file does not itself look like a leaked key to a
 * secret scanner or to push protection.
 *
 * The rules feed two consumers: the DLP guardrail (`semanticDlpDetector`,
 * which also drives the MCP and skill admission scanners) and the audit scrub
 * (`scrubAuditText`, which REPLACES the match with
 * `[redacted:<rules>:<len>:<fp>]`). Both are exercised.
 */
import { describe, expect, it } from "vitest";
import { CREDENTIAL_MATERIAL_RULES, semanticDlpDetector } from "./guardrails.js";
import { scrubAuditText } from "./audit-scrub.js";
import { evaluateTraceContent } from "./trace-evaluation.js";

const body = (alphabet: string, n: number) => alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);
const B64 = "aZ09_-Kq";
const ALNUM = "aZ09Kq7x";

/** rule id -> [a real-shaped sample, ...] */
const POSITIVE: Record<string, string[]> = {
  "dlp.secret.anthropic_key": [
    `sk-ant-api03-${body(B64, 93)}AA`,
    `sk-ant-admin01-${body(B64, 93)}AA`,
    `sk-ant-oat01-${body(B64, 64)}`,
  ],
  "dlp.secret.openai_key": [
    `sk-proj-${body(B64, 74)}T3BlbkFJ${body(B64, 74)}`,
    `sk-svcacct-${body(B64, 58)}T3BlbkFJ${body(B64, 58)}`,
    `sk-admin-${body(B64, 120)}`,
  ],
  "dlp.secret.github_fine_grained_pat": [`github_pat_${body("aZ09Kq_x", 82)}`],
  "dlp.secret.provider_token": [
    `ghp_${body(ALNUM, 36)}`,
    `gho_${body(ALNUM, 36)}`,
    `ghu_${body(ALNUM, 36)}`,
    `ghs_${body(ALNUM, 36)}`,
    `ghr_${body(ALNUM, 36)}`,
    `sk-${body(ALNUM, 48)}`,
  ],
  "dlp.secret.stripe_key": [`sk_live_${body(ALNUM, 24)}`, `rk_live_${body(ALNUM, 24)}`, `sk_test_${body(ALNUM, 24)}`],
  "dlp.secret.google_api_key": [`AIza${body("Sy09_-Kq", 35)}`],
  "dlp.secret.gitlab_pat": [`glpat-${body("aZ09_-Kq", 20)}`, `glpat-${body("aZ09_-Kq", 40)}.01abcdefg`],
};

/** near misses: the same prefixes, shapes that are NOT those credentials */
const NEGATIVE: string[] = [
  "sk-ant-api03-tooshort",
  `sk-ant-${body(B64, 60)}`, // no <kind><nn>- segment
  `mask-ant-api03-${body(B64, 93)}AA`, // not at a word start
  "sk-proj-abc123",
  `sk-project-${body(B64, 80)}`, // not a key kind
  `github_pat_${body("aZ09Kq_x", 60)}`, // too short for a fine-grained PAT
  "github_pat_",
  `pk_live_${body(ALNUM, 24)}`, // publishable, not secret
  "sk_live_short",
  `risk_live_${body(ALNUM, 24)}`, // not at a word start
  `AIza${body("Sy09_-Kq", 34)}`, // one short
  `AIza${body("Sy09_-Kq", 36)}`, // one long: not a Google key
  "glpat-short",
  "the gl-pat-plan and AIza-Rodriguez are not credentials",
  // bearer prose and short examples are not tokens
  "Bearer token missing from the request",
  "Bearer abc.def",
  `the Bearer of ${body("aZ09", 30)} news`,
  // ADR-0176 review: Stripe placeholders and Stripe's own docs example keys
  `sk_live_${"x".repeat(24)}`,
  `sk_test_${"0".repeat(10)}`,
  `rk_live_${"X".repeat(32)}`,
  `sk_test_${"4eC39HqLyjWD" + "arjtT1zdp7dc"}`,
  `sk_test_${"BQokikJOvBiI" + "2HlWgH4olfQ2"}`,
];

/** ADR-0186 V: the vendored upstream rule is broader than the native one; the
 * native rule still rejects these, the audit scrub redacts exactly this span */
const UPSTREAM_BROADER = new Map<string, { rule: string; keep: string }>([
  [`sk-ant-${body(B64, 60)}`, { rule: "anthropic_api_key", keep: "" }],
  [`github_pat_${body("aZ09Kq_x", 60)}`, { rule: "github_fine_grained_pat", keep: "" }],
  [`risk_live_${body(ALNUM, 24)}`, { rule: "stripe_key", keep: "ri" }],
  [`sk_live_${"x".repeat(24)}`, { rule: "stripe_key", keep: "" }],
  [`rk_live_${"X".repeat(32)}`, { rule: "stripe_key", keep: "" }],
  [`sk_test_${"4eC39HqLyjWD" + "arjtT1zdp7dc"}`, { rule: "stripe_key", keep: "" }],
  [`sk_test_${"BQokikJOvBiI" + "2HlWgH4olfQ2"}`, { rule: "stripe_key", keep: "" }],
]);

const ruleIdsMatching = (text: string): string[] =>
  CREDENTIAL_MATERIAL_RULES.filter((r) => {
    r.re.lastIndex = 0;
    const hit = r.re.test(text);
    r.re.lastIndex = 0;
    return hit;
  }).map((r) => r.id);

describe("current provider token formats are credential material", () => {
  for (const [id, samples] of Object.entries(POSITIVE)) {
    for (const sample of samples) {
      it(`${id} catches ${sample.slice(0, 14)}…`, () => {
        expect(ruleIdsMatching(sample)).toContain(id);
        const text = `the key ${sample}, pasted into a reason`;
        expect(semanticDlpDetector.detect(text).some((h) => h.category === "credential_material")).toBe(true);
        const scrubbed = scrubAuditText(text);
        expect(scrubbed).not.toContain(sample);
        const short = id.slice("dlp.secret.".length);
        expect(evaluateTraceContent({ inputPreview: null, outputPreview: scrubbed, contentWithheld: false }).flagged).toBe(true);
        expect(scrubbed).toMatch(new RegExp(`^the key \\[redacted:(?:[a-z0-9_.]+\\+)*${short}(?:\\+[a-z0-9_.]+)*:\\d+:[0-9a-f]{12}\\], pasted into a reason$`));
      });
    }
  }

  it("the marker records the full length removed", () => {
    const key = POSITIVE["dlp.secret.anthropic_key"]![0]!;
    expect(scrubAuditText(`k=${key} end`)).toContain(`:${key.length}:`);
  });
});

describe("the Stripe exclusions are narrow", () => {
  it("a docs example body under the LIVE prefix, or extended by one character, is still a key", () => {
    for (const s of [`sk_live_${"4eC39HqLyjWD" + "arjtT1zdp7dc"}`, `sk_test_${"4eC39HqLyjWD" + "arjtT1zdp7dc"}Z`, `sk_live_${"x".repeat(23)}y`]) {
      expect(ruleIdsMatching(s), s).toContain("dlp.secret.stripe_key");
    }
  });
});

describe("near misses are left alone", () => {
  for (const sample of NEGATIVE) {
    it(`does not flag ${sample.slice(0, 24)}…`, () => {
      const newRules = ruleIdsMatching(sample).filter((id) => Object.keys(POSITIVE).includes(id));
      expect(newRules).toEqual([]);
      const broader = UPSTREAM_BROADER.get(sample);
      if (!broader) expect(scrubAuditText(`note: ${sample} end`)).toBe(`note: ${sample} end`);
      else {
        const removed = sample.slice(broader.keep.length);
        expect(scrubAuditText(`note: ${sample} end`)).toMatch(new RegExp(`^note: ${broader.keep}\\[redacted:pipelock\\.secrets\\.${broader.rule}:${removed.length}:[0-9a-f]{12}\\] end$`));
      }
    });
  }
});

describe("linear time on pathological input (ReDoS)", () => {
  const N = 50_000;
  const prefixes = ["sk-ant-api03-", "sk-ant-", "sk-proj-", "sk-", "github_pat_", "ghp_", "sk_live_", "rk_live_", "AIza", "glpat-", "eyJ", "xoxb-", "rgl_", "api_key=", "-----BEGIN ", "Bearer ", "Bearer\t"];
  const shapes: Array<[string, string]> = [];
  for (const p of prefixes) {
    shapes.push([`${p} repeated`, p.repeat(Math.ceil(N / p.length)).slice(0, N)]);
    shapes.push([`${p} + long run`, p + "a".repeat(N)]);
    shapes.push([`${p} + dash run`, p + "-".repeat(N)]);
    shapes.push([`(${p}-)* `, `${p}-`.repeat(Math.ceil(N / (p.length + 1))).slice(0, N)]);
    shapes.push([`(${p}a.)*`, `${p}${"a".repeat(12)}.`.repeat(Math.ceil(N / (p.length + 13))).slice(0, N)]);
  }

  /** best of three, so a GC pause or a busy CI box is not read as a ReDoS: a
   * quadratic rule takes SECONDS here (the pre-fix JWT rule took ~5 s) */
  const bestOf3 = (fn: () => void): number => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      fn();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };

  for (const [name, input] of shapes) {
    it(`${name}: every credential rule and the scrub finish in under 100 ms`, () => {
      const rules = bestOf3(() => {
        for (const r of CREDENTIAL_MATERIAL_RULES) {
          r.re.lastIndex = 0;
          while (r.re.exec(input) !== null) {
            /* drain */
          }
          r.re.lastIndex = 0;
        }
      });
      const scrub = bestOf3(() => scrubAuditText(input));
      expect(rules, `${name}: rules took ${rules.toFixed(1)} ms`).toBeLessThan(100);
      expect(scrub, `${name}: scrub took ${scrub.toFixed(1)} ms`).toBeLessThan(100);
    });
  }
});
