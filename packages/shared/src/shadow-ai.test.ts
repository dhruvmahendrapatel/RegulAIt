/**
 * ADR-0055 — the analyzer's adversarial suite.
 *
 * The bar these tests set is deliberately "an analyzer that flags everything
 * is not passing": every true-positive assertion below has a matching
 * true-NEGATIVE with a near-miss string (`notopenai.com`,
 * `api.openai.com.evil.net`, `openai-mock`, a short `sk-` fixture). A matcher
 * that returned `true` unconditionally would pass none of them.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_SIGNATURES,
  EVIDENCE_MAX_ROWS,
  KEY_FRAGMENT_KEPT,
  analyzeImport,
  classifyObservation,
  confidenceFor,
  coverageScorecard,
  correlateObservations,
  evidenceImportSchema,
  hostMatchesSignature,
  keyMatchesSignature,
  normalizeEvidenceHost,
  packageMatchesSignature,
  redactKeyFragment,
  screenEvidencePayload,
  type AiSignature,
  type Observation,
} from "./shadow-ai.js";

const CATALOGUE: AiSignature[] = DEFAULT_AI_SIGNATURES.map((s) => ({ ...s, lastUpdatedAt: null }));

const obs = (o: Partial<Observation>): Observation => ({
  subjectKind: "host",
  subject: "10.0.0.5",
  signalSource: "egress_log",
  observedAt: "2026-08-01T00:00:00.000Z",
  count: 1,
  ...o,
});

describe("host normalization", () => {
  it("accepts bare hosts, URLs, ports, trailing dots and mixed case", () => {
    expect(normalizeEvidenceHost("API.OpenAI.com")).toBe("api.openai.com");
    expect(normalizeEvidenceHost("https://api.openai.com/v1/chat")).toBe("api.openai.com");
    expect(normalizeEvidenceHost("api.openai.com:443")).toBe("api.openai.com");
    expect(normalizeEvidenceHost("api.openai.com.")).toBe("api.openai.com");
  });

  it("returns null rather than throwing on junk", () => {
    expect(normalizeEvidenceHost("")).toBeNull();
    expect(normalizeEvidenceHost("   ")).toBeNull();
    expect(normalizeEvidenceHost("not a host at all")).toBeNull();
    expect(normalizeEvidenceHost("x".repeat(300))).toBeNull();
  });
});

describe("matching is exact or dot-boundary — never substring", () => {
  const exact = CATALOGUE.find((s) => s.value === "api.openai.com")!;
  const suffix = CATALOGUE.find((s) => s.value === "openai.azure.com")!;

  it("true positives", () => {
    expect(hostMatchesSignature("api.openai.com", exact)).toBe(true);
    expect(hostMatchesSignature("https://api.openai.com/v1", exact)).toBe(true);
    expect(hostMatchesSignature("my-tenant.openai.azure.com", suffix)).toBe(true);
    expect(hostMatchesSignature("openai.azure.com", suffix)).toBe(true);
  });

  it("true negatives — the near misses an over-eager matcher would flag", () => {
    expect(hostMatchesSignature("notapi.openai.com", exact)).toBe(false);
    expect(hostMatchesSignature("api.openai.com.evil.net", exact)).toBe(false);
    expect(hostMatchesSignature("api.openai.com.evil.net", suffix)).toBe(false);
    expect(hostMatchesSignature("notopenai.azure.com", suffix)).toBe(false);
    expect(hostMatchesSignature("github.com", exact)).toBe(false);
  });

  it("packages compare whole", () => {
    const pkg = CATALOGUE.find((s) => s.value === "openai" && s.kind === "sdk_package")!;
    expect(packageMatchesSignature("openai", pkg)).toBe(true);
    expect(packageMatchesSignature("OpenAI", pkg)).toBe(true);
    expect(packageMatchesSignature("openai-mock", pkg)).toBe(false);
    expect(packageMatchesSignature("myopenai", pkg)).toBe(false);
    expect(packageMatchesSignature("requests", pkg)).toBe(false);
  });

  it("keys need the prefix AND the length", () => {
    const key = CATALOGUE.find((s) => s.kind === "api_key_prefix" && s.value === "sk-")!;
    expect(keyMatchesSignature("sk-abc12", 51, key)).toBe(true);
    // the same prefix on a short test fixture is NOT a credential
    expect(keyMatchesSignature("sk-test", 7, key)).toBe(false);
    expect(keyMatchesSignature("ghp_abc", 40, key)).toBe(false);
  });
});

describe("classification tiers severity by what the signal implies", () => {
  it("a catalogue-matched key in source is critical", () => {
    const c = classifyObservation(
      obs({ subjectKind: "repo", subject: "acme/billing", signalSource: "code_scan", keyFragment: "sk-ant-ab", keyLength: 64 }),
      CATALOGUE,
    );
    expect(c.matched).toBe(true);
    expect(c.severity).toBe("critical");
    expect(c.provider).toBe("anthropic");
  });

  it("an observed call to a model endpoint is high", () => {
    const c = classifyObservation(obs({ host: "api.openai.com" }), CATALOGUE);
    expect(c.severity).toBe("high");
    expect(c.provider).toBe("openai");
  });

  it("a consumer web app is medium", () => {
    const c = classifyObservation(obs({ host: "claude.ai" }), CATALOGUE);
    expect(c.severity).toBe("medium");
  });

  it("an SDK dependency with no observed call is only low", () => {
    const c = classifyObservation(
      obs({ subjectKind: "repo", subject: "acme/web", signalSource: "code_scan", packageName: "openai" }),
      CATALOGUE,
    );
    expect(c.severity).toBe("low");
    expect(c.reason).toMatch(/capability/);
  });

  it("does NOT flag ordinary traffic — the true-negative case", () => {
    for (const host of ["github.com", "registry.npmjs.org", "notopenai.com", "s3.amazonaws.com"]) {
      expect(classifyObservation(obs({ host }), CATALOGUE).matched).toBe(false);
    }
    expect(
      classifyObservation(obs({ subjectKind: "repo", subject: "r", signalSource: "code_scan", packageName: "express" }), CATALOGUE).matched,
    ).toBe(false);
  });

  it("matches nothing at all when the catalogue is empty — the matcher holds no provider names", () => {
    expect(classifyObservation(obs({ host: "api.openai.com" }), []).matched).toBe(false);
    expect(classifyObservation(obs({ host: "api.openai.com" }), CATALOGUE.map((s) => ({ ...s, enabled: false }))).matched).toBe(false);
  });

  it("a self-report cannot introduce a provider the catalogue does not know", () => {
    expect(classifyObservation(obs({ subjectKind: "system", signalSource: "self_reported", declaredProvider: "openai" }), CATALOGUE).matched).toBe(true);
    expect(classifyObservation(obs({ subjectKind: "system", signalSource: "self_reported", declaredProvider: "megacorp-llm" }), CATALOGUE).matched).toBe(false);
  });
});

describe("correlation dedupes one usage seen by many collectors", () => {
  it("merges on (subject, provider) and raises confidence with DISTINCT sources", () => {
    const pairs = [
      { subjectKind: "repo" as const, subject: "acme/billing", signalSource: "code_scan" as const, packageName: "openai", at: "2026-07-01T00:00:00.000Z" },
      { subjectKind: "repo" as const, subject: "acme/billing", signalSource: "code_scan" as const, packageName: "openai", at: "2026-07-02T00:00:00.000Z" },
    ].map((p) => {
      const o = obs({ subjectKind: p.subjectKind, subject: p.subject, signalSource: p.signalSource, packageName: p.packageName, observedAt: p.at });
      return { observation: o, classification: classifyObservation(o, CATALOGUE) };
    });
    const [merged] = correlateObservations(pairs);
    expect(merged).toBeDefined();
    if (!merged) return;
    expect(merged.observationCount).toBe(2);
    expect(merged.signalSources).toEqual(["code_scan"]);
    // same source twice is NOT corroboration
    expect(merged.confidence).toBe("low");
    expect(merged.firstSeenAt).toBe("2026-07-01T00:00:00.000Z");
    expect(merged.lastSeenAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("takes the MAX severity across corroborating signals", () => {
    const a = obs({ subjectKind: "repo", subject: "acme/billing", signalSource: "code_scan", packageName: "openai" });
    const b = obs({ subjectKind: "repo", subject: "acme/billing", signalSource: "self_reported", declaredProvider: "openai" });
    const [merged] = correlateObservations([
      { observation: a, classification: classifyObservation(a, CATALOGUE) },
      { observation: b, classification: classifyObservation(b, CATALOGUE) },
    ]);
    expect(merged).toBeDefined();
    if (!merged) return;
    expect(merged.severity).toBe("medium");
    expect(merged.confidence).toBe("medium");
    expect(merged.signalSources.sort()).toEqual(["code_scan", "self_reported"]);
  });

  it("confidence is corroboration count", () => {
    expect(confidenceFor(1)).toBe("low");
    expect(confidenceFor(2)).toBe("medium");
    expect(confidenceFor(4)).toBe("high");
  });

  it("carries the governed replacement through from the catalogue", () => {
    const agentId = "11111111-2222-3333-4444-555555555555";
    const cat = CATALOGUE.map((s) =>
      s.value === "api.openai.com" ? { ...s, replacementAgentId: agentId, replacementNote: "route via the governed GPT agent" } : s,
    );
    const o = obs({ host: "api.openai.com" });
    const [f] = correlateObservations([{ observation: o, classification: classifyObservation(o, cat) }]);
    expect(f).toBeDefined();
    if (!f) return;
    expect(f.replacementAgentId).toBe(agentId);
    expect(f.replacementNote).toBe("route via the governed GPT agent");
  });
});

describe("evidence is untrusted input", () => {
  it("refuses a payload carrying a privilege / governed-object word at any depth", () => {
    const hits = screenEvidencePayload({ kind: "egress_log", rows: [{ destinationHost: "api.openai.com", isAdmin: true }] });
    expect(hits.map((h) => h.key)).toContain("isAdmin");
    expect(screenEvidencePayload({ rows: [{ nested: { deeper: { grants: ["*"] } } }] }).length).toBe(1);
    expect(screenEvidencePayload({ kind: "egress_log", rows: [{ destinationHost: "api.openai.com" }] })).toEqual([]);
  });

  it("row schemas are strict — an unknown field is a refusal, not a silent strip", () => {
    const r = evidenceImportSchema.safeParse({
      kind: "egress_log",
      mode: "apply",
      rows: [{ destinationHost: "api.openai.com", roleId: "00000000-0000-0000-0000-000000000000" }],
    });
    expect(r.success).toBe(false);
  });

  it("bounds the batch", () => {
    const rows = Array.from({ length: EVIDENCE_MAX_ROWS + 1 }, () => ({ destinationHost: "api.openai.com" }));
    expect(evidenceImportSchema.safeParse({ kind: "egress_log", rows }).success).toBe(false);
    expect(evidenceImportSchema.safeParse({ kind: "egress_log", rows: [] }).success).toBe(false);
  });

  it("refuses a whole credential and only ever remembers a fragment", () => {
    const full = `sk-${"a".repeat(60)}`;
    expect(evidenceImportSchema.safeParse({ kind: "code_scan", rows: [{ repo: "r", keyFragment: full }] }).success).toBe(false);
    expect(redactKeyFragment("sk-ant-abcdef").length).toBe(KEY_FRAGMENT_KEPT);
  });

  it("a code_scan row that observes nothing is refused", () => {
    expect(evidenceImportSchema.safeParse({ kind: "code_scan", rows: [{ repo: "r", path: "a.py" }] }).success).toBe(false);
  });

  it("drops an unparseable log line instead of failing the whole file", () => {
    const parsed = evidenceImportSchema.parse({
      kind: "egress_log",
      rows: [{ destinationHost: "api.openai.com" }, { destinationHost: "!!! not a host !!!" }],
    });
    const out = analyzeImport(parsed, CATALOGUE);
    expect(out.dropped).toBe(1);
    expect(out.observed).toBe(1);
    expect(out.findings).toHaveLength(1);
  });
});

describe("analyzeImport end to end", () => {
  it("separates matched from unmatched instead of flagging everything", () => {
    const parsed = evidenceImportSchema.parse({
      kind: "egress_log",
      rows: [
        { destinationHost: "api.openai.com", sourceIdentity: "build-01", requestCount: 900 },
        { destinationHost: "github.com", sourceIdentity: "build-01", requestCount: 4000 },
        { destinationHost: "registry.npmjs.org", sourceIdentity: "build-01" },
      ],
    });
    const out = analyzeImport(parsed, CATALOGUE);
    expect(out.observed).toBe(3);
    expect(out.matched).toBe(1);
    expect(out.unmatched).toBe(2);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.observationCount).toBe(900);
    expect(out.findings[0]?.severity).toBe("high");
  });
});

describe("the coverage scorecard states the gap rather than a score", () => {
  it("counts sources actually fed and never claims completeness", () => {
    const card = coverageScorecard([{ kind: "egress_log", imports: 2, rows: 900, lastImportedAt: "2026-08-01T00:00:00.000Z" }]);
    expect(card.sourcesOn).toBe(1);
    expect(card.sourcesPossible).toBe(4);
    expect(card.statement).toMatch(/ships no collector/);
    expect(card.statement).toMatch(/does not prove its absence/);
    expect(card.sources.find((s) => s.kind === "code_scan")!.on).toBe(false);
  });
});
