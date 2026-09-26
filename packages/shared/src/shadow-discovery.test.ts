/**
 * ADR-0083 — the compiled catalogue and the first-party classifier.
 *
 * WHAT THIS SUITE PINS, AND WHY
 *  - THE CATALOGUE IS FROZEN. Version 1 is pinned by ENTRY COUNT and by a
 *    CONTENT HASH: any edit — adding a provider, softening a note — fails here
 *    loudly. That is the ADR-0068 corpus discipline: a result tagged
 *    "catalog v1" must mean the same thing forever; detection grows by adding
 *    a NEW version, never by editing this one.
 *  - MATCHING IS BOUNDED THE WAY ADR-0055's IS. Dot-boundary host matching
 *    (`openai.com` never matches `notopenai.com`, nothing ever matches
 *    `api.openai.com.evil.net`), exact package names, single-literal-wildcard
 *    only. Every positive assertion has a negative control (M-002).
 *  - GOVERNED-vs-SHADOW IS REAL. The classifier labels a governed host
 *    governed_via_gateway and a non-governed catalogue hit shadow — and the
 *    suite proves both labels can occur on the same input, so a constant-true
 *    (or constant-false) governed check cannot pass.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DiscoveryParseError,
  SHADOW_AI_CATALOG_V1,
  SHADOW_AI_CATALOG_VERSION,
  classifyDiscoveryContent,
  extractHostCandidatesFromLine,
  matchCatalogEndpoint,
  matchCatalogPackage,
  normalizePackageName,
  parseGoModManifest,
  parsePackageJsonManifest,
  parseRequirementsManifest,
  shadowCatalogEntrySchema,
} from "./shadow-discovery.js";

const NO_GOVERNED = new Map<string, string>();

// ===========================================================================
// 1. The catalogue: valid, unique, frozen, PINNED
// ===========================================================================

describe("SHADOW_AI_CATALOG_V1 is a valid, frozen, pinned corpus", () => {
  it("every entry passes the schema", () => {
    for (const entry of SHADOW_AI_CATALOG_V1) {
      const parsed = shadowCatalogEntrySchema.safeParse(entry);
      expect(parsed.success, `entry ${entry.id}: ${JSON.stringify(parsed.success ? "" : parsed.error.issues)}`).toBe(true);
    }
  });

  it("ids are unique, and so are (kind, pattern) pairs", () => {
    const ids = SHADOW_AI_CATALOG_V1.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pairs = SHADOW_AI_CATALOG_V1.map((e) => `${e.kind}|${e.pattern.toLowerCase()}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("pins version, entry count and content hash — v1 can never drift silently", () => {
    expect(SHADOW_AI_CATALOG_VERSION).toBe(1);
    // COUNT PIN: 37 endpoint signatures + 44 SDK signatures.
    expect(SHADOW_AI_CATALOG_V1.filter((e) => e.kind === "endpoint")).toHaveLength(37);
    expect(SHADOW_AI_CATALOG_V1.filter((e) => e.kind === "sdk")).toHaveLength(44);
    expect(SHADOW_AI_CATALOG_V1).toHaveLength(81);
    // CONTENT PIN: any edit to any field of any entry must fail HERE, loudly.
    // Changing detection is a NEW catalogue version, never an edit to v1.
    const hash = createHash("sha256").update(JSON.stringify(SHADOW_AI_CATALOG_V1)).digest("hex");
    expect(hash).toBe("a5379cfeef0fa26b767f68ea839e9ba97493cec40a1b622e57c0621c9a8912a7");
  });

  it("is deep-frozen — a mutation throws instead of landing", () => {
    expect(Object.isFrozen(SHADOW_AI_CATALOG_V1)).toBe(true);
    expect(Object.isFrozen(SHADOW_AI_CATALOG_V1[0])).toBe(true);
    expect(() => {
      (SHADOW_AI_CATALOG_V1 as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (SHADOW_AI_CATALOG_V1[0] as { provider: string }).provider = "someone-else";
    }).toThrow();
  });

  it("no wildcard pattern carries more than one star, and no pattern is a regex", () => {
    for (const e of SHADOW_AI_CATALOG_V1) {
      expect((e.pattern.match(/\*/g) ?? []).length, e.id).toBeLessThanOrEqual(1);
      // the characters that would make a pattern a regex have no business here
      expect(e.pattern, e.id).not.toMatch(/[()[\]{}+?^$\\]/);
    }
  });
});

// ===========================================================================
// 2. Endpoint matching: dot boundaries, wildcards, most-specific-wins
// ===========================================================================

describe("matchCatalogEndpoint", () => {
  it("matches exact hosts, URL forms, case and trailing-dot noise", () => {
    expect(matchCatalogEndpoint("api.openai.com")?.id).toBe("ep-openai-api");
    expect(matchCatalogEndpoint("https://api.openai.com/v1/chat/completions")?.id).toBe("ep-openai-api");
    expect(matchCatalogEndpoint("API.OPENAI.COM.")?.id).toBe("ep-openai-api");
    expect(matchCatalogEndpoint("api.anthropic.com:443")?.id).toBe("ep-anthropic-api");
  });

  it("matches subdomains on a DOT BOUNDARY only — the ADR-0055 rule", () => {
    // positive: a real subdomain
    expect(matchCatalogEndpoint("eu.api.openai.com")?.provider).toBe("openai");
    // control: a lookalike registered domain must NOT match
    expect(matchCatalogEndpoint("notopenai.com")).toBeNull();
    expect(matchCatalogEndpoint("fakeapi.openai.com.evil.net")).toBeNull();
    expect(matchCatalogEndpoint("api.openai.com.evil.net")).toBeNull();
  });

  it("wildcards are literal prefix/suffix pairs — Bedrock regional endpoints match", () => {
    expect(matchCatalogEndpoint("bedrock-runtime.us-east-1.amazonaws.com")?.id).toBe("ep-aws-bedrock");
    expect(matchCatalogEndpoint("bedrock.eu-west-1.amazonaws.com")?.id).toBe("ep-aws-bedrock");
    // control: other AWS services must NOT ride the Bedrock pattern
    expect(matchCatalogEndpoint("s3.us-east-1.amazonaws.com")).toBeNull();
    expect(matchCatalogEndpoint("ec2.amazonaws.com")).toBeNull();
  });

  it("`*.openai.azure.com` matches a resource host and not the bare zone", () => {
    expect(matchCatalogEndpoint("acme-prod.openai.azure.com")?.id).toBe("ep-azure-openai");
    expect(matchCatalogEndpoint("openai.azure.com")).toBeNull();
  });

  it("most specific wins deterministically: the API entry beats the consumer-web zone", () => {
    // perplexity.ai (web) and api.perplexity.ai (API) both match the API host;
    // the longer literal must win regardless of catalogue order
    expect(matchCatalogEndpoint("api.perplexity.ai")?.id).toBe("ep-perplexity-api");
    expect(matchCatalogEndpoint("perplexity.ai")?.id).toBe("ep-perplexity-web");
  });

  it("control: ordinary enterprise hosts match nothing", () => {
    for (const host of ["github.com", "api.github.com", "slack.com", "atlassian.net", "googleapis.com"]) {
      expect(matchCatalogEndpoint(host), host).toBeNull();
    }
  });
});

// ===========================================================================
// 3. Package matching: exact, folded, family prefixes
// ===========================================================================

describe("matchCatalogPackage", () => {
  it("matches exact names case-insensitively with PyPI _/- folding", () => {
    expect(matchCatalogPackage("openai")?.id).toBe("sdk-openai");
    expect(matchCatalogPackage("Anthropic")?.id).toBe("sdk-anthropic-python");
    expect(matchCatalogPackage("huggingface_hub")?.id).toBe("sdk-huggingface-hub-py");
    expect(normalizePackageName("Llama_Index")).toBe("llama-index");
  });

  it("family wildcards are prefix matches, and the bare name does not ride them", () => {
    expect(matchCatalogPackage("@langchain/openai")?.id).toBe("sdk-langchain-ns");
    expect(matchCatalogPackage("langchain-openai")?.id).toBe("sdk-langchain-py-family");
    expect(matchCatalogPackage("llama-index-llms-openai")?.id).toBe("sdk-llamaindex-py-family");
    // the exact package is its own entry, not a degenerate family member
    expect(matchCatalogPackage("langchain")?.id).toBe("sdk-langchain");
    expect(matchCatalogPackage("llama-index")?.id).toBe("sdk-llamaindex-py");
  });

  it("`ai` (the Vercel SDK) is matched EXACTLY — lookalikes stay unmatched", () => {
    expect(matchCatalogPackage("ai")?.id).toBe("sdk-vercel-ai");
    expect(matchCatalogPackage("aiohttp")).toBeNull();
    expect(matchCatalogPackage("aiofiles")).toBeNull();
  });

  it("control: near-miss names must NOT match — package identity is exact", () => {
    for (const name of ["openai-mock", "not-openai", "react", "express", "requests", "numpy"]) {
      expect(matchCatalogPackage(name), name).toBeNull();
    }
  });

  it("Go module paths match whole", () => {
    expect(matchCatalogPackage("github.com/sashabaranov/go-openai")?.provider).toBe("openai");
    expect(matchCatalogPackage("github.com/aws/aws-sdk-go-v2/service/bedrockruntime")?.provider).toBe("aws-bedrock");
    // control: the base AWS SDK module is NOT an AI signature
    expect(matchCatalogPackage("github.com/aws/aws-sdk-go-v2")).toBeNull();
  });
});

// ===========================================================================
// 4. Extraction from generic log lines
// ===========================================================================

describe("extractHostCandidatesFromLine", () => {
  it("finds hosts in dnsmasq-, BIND- and proxy-shaped lines", () => {
    expect(extractHostCandidatesFromLine("Aug 20 10:00:01 dnsmasq[812]: query[A] api.openai.com from 10.1.2.3"))
      .toEqual(["api.openai.com"]);
    expect(
      extractHostCandidatesFromLine(
        "20-Aug-2026 10:00:01.123 client @0x7f 10.1.2.3#53124 (claude.ai): query: claude.ai IN A +E(0)",
      ),
    ).toEqual(["claude.ai"]);
    expect(
      extractHostCandidatesFromLine("1755680000.123    204 10.1.2.3 TCP_TUNNEL/200 4512 CONNECT api.groq.com:443 - HIER_DIRECT/x -"),
    ).toContain("api.groq.com");
  });

  it("skips bare IPs, numbers and non-host tokens; dedupes within a line", () => {
    expect(extractHostCandidatesFromLine("10.1.2.3 192.168.0.1 12345 4.2.1 -- [] ()")).toEqual([]);
    expect(extractHostCandidatesFromLine("x api.x.ai api.x.ai again")).toEqual(["api.x.ai"]);
  });

  it("reads a URL token down to its host", () => {
    expect(extractHostCandidatesFromLine('GET "https://api.mistral.ai/v1/chat/completions" 200')).toEqual([
      "api.mistral.ai",
    ]);
  });
});

// ===========================================================================
// 5. Manifest parsers
// ===========================================================================

describe("manifest parsers", () => {
  it("package.json: all four dependency sections, and nothing else", () => {
    const entries = parsePackageJsonManifest(
      JSON.stringify({
        name: "acme-app",
        scripts: { start: "node ." },
        dependencies: { openai: "^4.0.0", express: "^4.18.0" },
        devDependencies: { "@langchain/core": "^0.3.0" },
        peerDependencies: { react: "^18" },
        optionalDependencies: { "llama-index-should-not-exist-on-npm": "1.0.0" },
      }),
    );
    expect(entries.map((e) => e.name)).toEqual([
      "openai",
      "express",
      "@langchain/core",
      "react",
      "llama-index-should-not-exist-on-npm",
    ]);
    expect(entries[0]!.origin).toBe("dependencies");
  });

  it("package.json: refuses a non-JSON document as a whole, loudly", () => {
    expect(() => parsePackageJsonManifest("openai==1.0")).toThrow(DiscoveryParseError);
  });

  it("requirements.txt: names survive pins, extras, comments and option lines", () => {
    const entries = parseRequirementsManifest(
      [
        "# AI deps",
        "openai==1.30.0",
        "anthropic>=0.30 # pinned later",
        "litellm[proxy]~=1.40",
        "-r base.txt",
        "--index-url https://pypi.internal/simple",
        "requests==2.32.0",
        "",
      ].join("\n"),
    );
    expect(entries.map((e) => e.name)).toEqual(["openai", "anthropic", "litellm", "requests"]);
    expect(entries[0]!.origin).toBe("line 2");
  });

  it("go.mod: reads inline and block requires, skipping comments and directives", () => {
    const entries = parseGoModManifest(
      [
        "module github.com/acme/tool",
        "",
        "go 1.22",
        "",
        "require github.com/sashabaranov/go-openai v1.26.0",
        "",
        "require (",
        "\tgithub.com/spf13/cobra v1.8.0 // indirect",
        "\tgoogle.golang.org/genai v0.5.0",
        ")",
      ].join("\n"),
    );
    expect(entries.map((e) => e.name)).toEqual([
      "github.com/sashabaranov/go-openai",
      "github.com/spf13/cobra",
      "google.golang.org/genai",
    ]);
  });
});

// ===========================================================================
// 6. The classifier: shadow vs governed_via_gateway vs unmatched
// ===========================================================================

describe("classifyDiscoveryContent", () => {
  const LOG = [
    "Aug 20 10:00:01 dnsmasq[812]: query[A] api.openai.com from 10.1.2.3",
    "Aug 20 10:00:02 dnsmasq[812]: query[A] api.anthropic.com from 10.1.2.4",
    "Aug 20 10:00:03 dnsmasq[812]: query[A] api.anthropic.com from 10.1.2.5",
    "Aug 20 10:00:04 dnsmasq[812]: query[A] github.com from 10.1.2.3",
    "Aug 20 10:00:05 dnsmasq[812]: query[A] vllm.corp.internal from 10.1.2.6",
  ].join("\n");

  it("splits the SAME input into shadow AND governed — neither label is constant", () => {
    const governed = new Map([
      ["api.anthropic.com", "platform model credential for provider 'anthropic'"],
      ["vllm.corp.internal", "custom model provider 'corp-vllm'"],
    ]);
    const r = classifyDiscoveryContent({ sourceKind: "dns_log", content: LOG, governedHosts: governed });

    expect(r.catalogVersion).toBe(1);
    expect(r.linesScanned).toBe(5);

    // shadow: a catalogue hit the gateway does NOT front
    expect(r.shadow.map((c) => c.value)).toEqual(["api.openai.com"]);
    expect(r.shadow[0]!.entryId).toBe("ep-openai-api");
    expect(r.shadow[0]!.provider).toBe("openai");

    // governed: the catalogue hit the gateway DOES front, with its reason —
    // and a custom in-house host the compiled catalogue has never heard of
    expect(r.governed.map((c) => c.value).sort()).toEqual(["api.anthropic.com", "vllm.corp.internal"]);
    const anthropic = r.governed.find((c) => c.value === "api.anthropic.com")!;
    expect(anthropic.classification).toBe("governed_via_gateway");
    expect(anthropic.governedReason).toMatch(/platform model credential/);
    expect(anthropic.occurrences).toBe(2);
    const vllm = r.governed.find((c) => c.value === "vllm.corp.internal")!;
    expect(vllm.entryId).toBeNull(); // recognised by the deployment, not by v1

    // unmatched: counted and sampled, never promoted
    expect(r.unmatchedCount).toBe(1);
    expect(r.unmatchedSample).toEqual(["github.com"]);
  });

  it("with NOTHING governed, the same hosts are shadow — the governed label is earned, not default", () => {
    const r = classifyDiscoveryContent({ sourceKind: "dns_log", content: LOG, governedHosts: NO_GOVERNED });
    expect(r.shadow.map((c) => c.value).sort()).toEqual(["api.anthropic.com", "api.openai.com"]);
    expect(r.governed).toEqual([]);
    // the in-house host is now just an unmatched name
    expect(r.unmatchedSample.sort()).toEqual(["github.com", "vllm.corp.internal"]);
  });

  it("classifies a package.json — and an SDK is NEVER labelled governed", () => {
    const r = classifyDiscoveryContent({
      sourceKind: "package_json",
      content: JSON.stringify({
        dependencies: { openai: "^4", express: "^4", "@ai-sdk/anthropic": "^1" },
      }),
      // even a fully governed deployment cannot tell where an SDK points
      governedHosts: new Map([["api.openai.com", "platform model credential for provider 'openai'"]]),
    });
    expect(r.shadow.map((c) => c.value).sort()).toEqual(["@ai-sdk/anthropic", "openai"]);
    expect(r.governed).toEqual([]);
    expect(r.shadow.every((c) => c.kind === "sdk")).toBe(true);
    expect(r.unmatchedSample).toEqual(["express"]);
  });

  it("classifies requirements.txt and go.mod through the same path", () => {
    const req = classifyDiscoveryContent({
      sourceKind: "requirements_txt",
      content: "litellm==1.40\nnumpy==2.0\n",
      governedHosts: NO_GOVERNED,
    });
    expect(req.shadow.map((c) => c.value)).toEqual(["litellm"]);
    expect(req.unmatchedSample).toEqual(["numpy"]);

    const gomod = classifyDiscoveryContent({
      sourceKind: "go_mod",
      content: "module m\nrequire github.com/anthropics/anthropic-sdk-go v1.0.0\n",
      governedHosts: NO_GOVERNED,
    });
    expect(gomod.shadow.map((c) => c.value)).toEqual(["github.com/anthropics/anthropic-sdk-go"]);
    expect(gomod.shadow[0]!.provider).toBe("anthropic");
  });

  it("aggregates occurrences by value and keeps manifest origins bounded", () => {
    const r = classifyDiscoveryContent({
      sourceKind: "proxy_log",
      content: Array.from({ length: 7 }, () => "CONNECT api.together.xyz:443").join("\n"),
      governedHosts: NO_GOVERNED,
    });
    expect(r.shadow).toHaveLength(1);
    expect(r.shadow[0]!.occurrences).toBe(7);
    expect(r.candidateCount).toBe(1);
  });
});
