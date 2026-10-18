// ADR-0195 lane A6 wiring (review of #419): presence signature ids through
// SD0's classifier and SD3's endpoint reducer. Env-variable names are never
// stored as evidence (master decision): only the signature id travels.
import { describe, expect, it } from "vitest";
import {
  classifyObservation,
  correlateObservations,
  presenceBackingSignature,
  type AiSignature,
  type Observation,
} from "../shadow-ai.js";
import { reduceEndpointObservations, type EndpointObservation } from "../endpoint-discovery/index.js";

const row = (over: Partial<AiSignature>): AiSignature => ({
  provider: "openai",
  kind: "assistant_config",
  value: "OPENAI_API_KEY",
  matchType: "identifier",
  provenance: "test",
  enabled: true,
  ...over,
});

const obs = (over: Partial<Observation>): Observation => ({
  subjectKind: "repo",
  subject: "github:acme/app",
  signalSource: "repo_scan",
  observedAt: "2026-10-17T00:00:00.000Z",
  count: 1,
  ...over,
});

describe("classifyObservation: the presence step", () => {
  it("matches a presence id through the enabled row that backs it, and keeps the id, never the name", () => {
    const c = classifyObservation(obs({ presence: ["env.openai.api-key"], location: { path: ".env.example" } }), [row({})]);
    expect(c.matched).toBe(true);
    expect(c.provider).toBe("openai");
    expect(c.matchedValue).toBe("env.openai.api-key");
    expect(c.reason).not.toContain("OPENAI_API_KEY");
    const [f] = correlateObservations([{ observation: obs({ presence: ["env.openai.api-key"] }), classification: c }]);
    const stored = JSON.stringify(f);
    expect(stored).toContain("env.openai.api-key");
    expect(stored).not.toContain("OPENAI_API_KEY");
    expect(f!.evidence[0]!.presence).toEqual(["env.openai.api-key"]);
  });

  it("detection is data: no backing row, a disabled row or a row of another kind does not match", () => {
    const o = obs({ presence: ["env.openai.api-key"] });
    expect(classifyObservation(o, []).matched).toBe(false);
    expect(classifyObservation(o, [row({ enabled: false })]).matched).toBe(false);
    expect(classifyObservation(o, [row({ kind: "desktop_app" })]).matched).toBe(false);
    expect(classifyObservation(o, [row({ value: "OPENAI_ORG_ID" })]).matched).toBe(false);
    expect(classifyObservation(obs({ presence: ["env.acme.unknown"] }), [row({})]).matched).toBe(false);
  });

  it("an OS-scoped row backs only a sighting from that OS; a CLI id needs a CLI-kind row", () => {
    const cli = row({ provider: "anthropic", kind: "desktop_app", value: "claude", os: "macos" });
    expect(classifyObservation(obs({ presence: ["cli.anthropic.claude"], os: "macos" }), [cli]).matched).toBe(true);
    expect(classifyObservation(obs({ presence: ["cli.anthropic.claude"], os: "linux" }), [cli]).matched).toBe(false);
    expect(classifyObservation(obs({ presence: ["cli.anthropic.claude"] }), [row({ provider: "anthropic", value: "claude" })]).matched).toBe(false);
  });

  it("takes the lower of the presence row's and the catalogue row's confidence", () => {
    const c = classifyObservation(obs({ presence: ["env.google.api-key"] }), [row({ provider: "google", value: "GOOGLE_API_KEY" })]);
    expect(c.signatureConfidence).toBe("low");
    const m = classifyObservation(obs({ presence: ["cli.openai.codex"] }), [row({ kind: "desktop_app", value: "codex", confidence: "high" })]);
    expect(m.signatureConfidence).toBe("medium");
  });

  it("presenceBackingSignature resolves the id to the backing row", () => {
    expect(presenceBackingSignature("env.openai.api-key", [row({})])?.signature.value).toBe("OPENAI_API_KEY");
    expect(presenceBackingSignature("OPENAI_API_KEY", [row({})])).toBeNull();
  });
});

describe("reduceEndpointObservations: env and CLI names become presence ids", () => {
  const endpoint = (keys: EndpointObservation["keys"]): EndpointObservation => ({
    source: "endpoint_osquery",
    line: 1,
    query: "q",
    kindHint: null,
    device: "p_dev",
    user: null,
    os: "linux",
    observedAt: null,
    keys,
    traits: [],
    location: null,
    version: null,
    info: {},
  });
  const catalogue = [
    row({}),
    row({ provider: "anthropic", kind: "desktop_app", value: "claude" }),
    row({ provider: "ollama", kind: "local_runtime", value: "ollama" }),
  ];

  it("an env-variable name matches by presence id and is never the sighting value", () => {
    const red = reduceEndpointObservations({ observations: [endpoint([{ matchType: "env_var_name", value: "OPENAI_API_KEY" }])] }, catalogue);
    expect(red.matched).toEqual([
      expect.objectContaining({ provider: "openai", kind: "assistant_config", value: "env.openai.api-key", presenceSignatureId: "env.openai.api-key" }),
    ]);
    expect(JSON.stringify(red)).not.toContain("OPENAI_API_KEY");
  });

  it("an unmatched env-variable name is neither matched nor sampled as a gap", () => {
    const red = reduceEndpointObservations({ observations: [endpoint([{ matchType: "env_var_name", value: "ACME_INTERNAL_KEY" }])] }, catalogue);
    expect(red.matched).toEqual([]);
    expect(red.unmatched).toEqual([]);
    expect(red.unmatchedCount).toBe(1);
    expect(JSON.stringify(red)).not.toContain("ACME_INTERNAL_KEY");
  });

  it("a known CLI binary matches by presence id; one the presence catalogue lacks is still an artifact", () => {
    const red = reduceEndpointObservations(
      { observations: [endpoint([{ matchType: "cli_binary", value: "/usr/local/bin/claude" }]), endpoint([{ matchType: "cli_binary", value: "ollama" }])] },
      catalogue,
    );
    expect(red.matched.map((m) => [m.provider, m.value, m.presenceSignatureId ?? null])).toEqual([
      ["anthropic", "cli.anthropic.claude", "cli.anthropic.claude"],
      ["ollama", "ollama", null],
    ]);
  });

  it("disabling the backing row turns the presence detection off", () => {
    const red = reduceEndpointObservations({ observations: [endpoint([{ matchType: "env_var_name", value: "OPENAI_API_KEY" }])] }, [row({ enabled: false })]);
    expect(red.matched).toEqual([]);
  });
});
