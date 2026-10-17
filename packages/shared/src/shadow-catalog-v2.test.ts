import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SHADOW_AI_CATALOG_V1 } from "./shadow-discovery.js";
import {
  PATRONAI_SOURCE,
  SHADOW_AI_CATALOG_V2,
  SHADOW_AI_CATALOG_V2_VERSION,
  SHADOW_AI_SEED_ROWS_SD1,
  assistantConfigMatches,
  catalogPatternLiteralLength,
  matchCatalogV2AssistantConfig,
  matchCatalogV2Endpoint,
  matchCatalogV2EnvVar,
  matchCatalogV2Extension,
  matchCatalogV2Package,
  shadowCatalogV2EntrySchema,
} from "./shadow-catalog-v2.js";

describe("SHADOW_AI_CATALOG_V2 (ADR-0195 decision 15)", () => {
  it("pins version, entry count and content hash — v2 can never drift silently", () => {
    expect(SHADOW_AI_CATALOG_V2_VERSION).toBe(2);
    expect(SHADOW_AI_CATALOG_V2).toHaveLength(180);
    const hash = createHash("sha256").update(JSON.stringify(SHADOW_AI_CATALOG_V2)).digest("hex");
    expect(hash).toBe("8cc76d3a0f7f13846ae0a50ff512c0563e9ca34b2faadfc90b1a3353aad06c8a");
    expect(Object.isFrozen(SHADOW_AI_CATALOG_V2)).toBe(true);
    expect(Object.isFrozen(SHADOW_AI_CATALOG_V2[100])).toBe(true);
  });

  it("starts with every v1 entry, unchanged in every v1 field and order", () => {
    SHADOW_AI_CATALOG_V1.forEach((v1, i) => {
      const v2 = SHADOW_AI_CATALOG_V2[i]!;
      expect({ id: v2.id, kind: v2.kind, pattern: v2.pattern, provider: v2.provider, notes: v2.notes }).toEqual(v1);
    });
  });

  it("every entry passes the schema; ids are unique", () => {
    for (const e of SHADOW_AI_CATALOG_V2) expect(shadowCatalogV2EntrySchema.safeParse(e).success, e.id).toBe(true);
    const ids = SHADOW_AI_CATALOG_V2.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every coding-assistant signature is verified against a vendor source (PENDING S17)", () => {
    const assistantProviders = new Set(["github-copilot", "amazon-q-developer", "gemini-code-assist"]);
    for (const e of SHADOW_AI_CATALOG_V2) {
      if (e.kind === "assistant_config" || e.kind === "ide_extension" || (e.kind === "endpoint" && assistantProviders.has(e.provider))) {
        expect(e.verified, e.id).not.toBeNull();
        expect(e.verified!.url.startsWith("https://"), e.id).toBe(true);
      }
    }
  });

  it("entries cross-checked with PatronAI carry its pinned commit and licence", () => {
    const fromPatron = SHADOW_AI_CATALOG_V2.filter((e) => e.source.project === PATRONAI_SOURCE.project);
    expect(fromPatron.length).toBeGreaterThan(0);
    for (const e of fromPatron) {
      expect(e.source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(e.source.licence).toBe("Apache-2.0");
    }
  });

  it("matches coding-assistant evidence, most specific first", () => {
    expect(matchCatalogV2Endpoint("api.business.githubcopilot.com")?.id).toBe("ep-github-copilot-api");
    expect(matchCatalogV2Endpoint("githubcopilot.com.evil.test")).toBeNull();
    expect(matchCatalogV2Endpoint("q.eu-central-1.amazonaws.com")?.provider).toBe("amazon-q-developer");
    expect(matchCatalogV2Endpoint("api.openai.com")?.id).toBe("ep-openai-api");
    expect(matchCatalogV2Endpoint("api-inference.huggingface.co")?.id).toBe("ep-huggingface-inference");
    expect(matchCatalogV2Package("com.openai:openai-java")?.provider).toBe("openai");
    expect(matchCatalogV2Package("dev.langchain4j:langchain4j-open-ai")?.id).toBe("sdk-maven-langchain4j");
    expect(matchCatalogV2Package("@modelcontextprotocol/sdk")?.id).toBe("sdk-mcp-js-ns");
    expect(matchCatalogV2Package("left-pad")).toBeNull();
    expect(matchCatalogV2Extension("GitHub.Copilot")?.id).toBe("ext-github-copilot");
    expect(matchCatalogV2EnvVar("ANTHROPIC_API_KEY")?.provider).toBe("anthropic");
    expect(matchCatalogV2EnvVar("anthropic_api_key")).toBeNull();
  });

  it("specificity counts every literal character and excludes EVERY wildcard (two-star pattern)", () => {
    // a single-occurrence replace would count the second `*` as a literal (CodeQL js/incomplete-sanitization)
    expect(catalogPatternLiteralLength("a*b*c")).toBe(3);
    expect(catalogPatternLiteralLength("**/AGENTS.md")).toBe(9);
    expect(catalogPatternLiteralLength("**/x*y")).toBe(2);
    expect(catalogPatternLiteralLength("*.githubcopilot.com")).toBe(18);
  });

  it("carries AI IDE and app-builder signatures as data, verified like the rest", () => {
    expect(matchCatalogV2Endpoint("api2.cursor.sh")?.provider).toBe("cursor");
    expect(matchCatalogV2Endpoint("my-app.lovable.app")?.provider).toBe("lovable");
    expect(matchCatalogV2AssistantConfig(".cursor/rules/style.mdc")?.id).toBe("cfg-cursor-rules");
    expect(matchCatalogV2AssistantConfig(".cursor/mcp.json")?.id).toBe("cfg-cursor-mcp-json");
  });

  it("assistant_config path patterns are literal", () => {
    expect(matchCatalogV2AssistantConfig("services/api/AGENTS.md")?.id).toBe("cfg-agents-md");
    expect(matchCatalogV2AssistantConfig("NOTAGENTS.md")).toBeNull();
    expect(matchCatalogV2AssistantConfig(".github/instructions/py.instructions.md")?.id).toBe("cfg-github-copilot-path-instructions");
    expect(matchCatalogV2AssistantConfig(".clinerules/style.md")?.id).toBe("cfg-cline-rules");
    expect(matchCatalogV2AssistantConfig("sub/.clinerules/style.md")).toBeNull();
    expect(matchCatalogV2AssistantConfig("docs/CLAUDE.md")).toBeNull();
    expect(assistantConfigMatches(".amazonq/rules/", ".amazonq/rules/")).toBe(false);
  });

  it("seed rows are data for the admin catalogue: only v2 additions, no regex, no wildcard the table cannot express", () => {
    expect(SHADOW_AI_SEED_ROWS_SD1.length).toBe(73);
    const v1Ids = new Set(SHADOW_AI_CATALOG_V1.map((e) => e.id));
    for (const r of SHADOW_AI_SEED_ROWS_SD1) {
      expect(v1Ids.has(r.catalogEntryId)).toBe(false);
      if (r.kind === "hostname" || r.kind === "sdk_package") expect(r.value.includes("*"), r.catalogEntryId).toBe(false);
      expect(r.provenance.startsWith("regulait-seed catalog-v2 ")).toBe(true);
    }
    for (const r of SHADOW_AI_SEED_ROWS_SD1) {
      if (r.kind === "assistant_config" || r.kind === "ide_extension") expect(r.matchType).toBe("identifier");
    }
    expect(SHADOW_AI_SEED_ROWS_SD1.find((r) => r.catalogEntryId === "ep-github-copilot-api")).toMatchObject({
      kind: "hostname",
      value: "githubcopilot.com",
      matchType: "host_suffix",
    });
  });
});
