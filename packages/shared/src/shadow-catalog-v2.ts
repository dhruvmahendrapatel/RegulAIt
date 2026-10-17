/**
 * ADR-0195 decision 15 — `SHADOW_AI_CATALOG_V2`, the compiled triage catalogue
 * the repo scanner (SD1) reads, alongside the frozen v1.
 *
 * WHY A V2 AND NOT AN EDIT. ADR-0083 §2: a finding tagged "matched X @ catalog
 * v1" must mean the same thing for ever, so `SHADOW_AI_CATALOG_V1` stays
 * byte-identical (its pin test is untouched) and every extension lands here.
 * V2 = every v1 entry, unchanged in id/kind/pattern/provider/notes, plus new
 * entries. V2 is deep-frozen and pinned by entry count AND content hash in
 * `shadow-catalog-v2.test.ts`; a v3 is the only way to change it.
 *
 * WHAT IS NEW IN V2
 *   - Coding-assistant signatures (PENDING S17): endpoints, repository
 *     instruction/config files and IDE extension ids, each checked against the
 *     vendor's own current documentation or marketplace listing on the date in
 *     its `verified` field.
 *   - Dependency names for the ecosystems the repo scanner reads (Maven, Gradle,
 *     NuGet, RubyGems, Cargo) and further agent frameworks, each confirmed to
 *     exist on its public registry on 2026-10-17.
 *   - AI provider environment-variable NAMES (never values), read from
 *     `.env.example`-style files.
 *
 * PROVENANCE. Every entry records where it came from. Entries cross-checked
 * against the PatronAI data files (giggsoinc/PatronAI, Apache-2.0, pinned by
 * commit below; the project publishes no release tags) carry that source; the
 * package names and file patterns themselves were confirmed by RegulAIt against
 * the registries and vendor documentation, and one PatronAI extension id that
 * no longer resolves on the marketplace was left out. See THIRD_PARTY.md.
 *
 * Only SD1 edits this compiled catalogue. SD2 and SD3 add their own seed-row
 * files for the admin catalogue; nothing here mints a finding (ADR-0083 §3,
 * ADR-0195 rule 5): a compiled hit that the admin catalogue does not also
 * match is a catalogue gap, never a finding.
 *
 * NO REGEX FROM DATA. Patterns are literal strings with at most one `*`, the
 * same rule v1 enforces.
 */
import { z } from "zod";
import { HOST_MAX } from "./shadow-ai.js";
import {
  SHADOW_AI_CATALOG_V1,
  endpointEntryMatches,
  sdkEntryMatches,
  type ShadowCatalogEntry,
} from "./shadow-discovery.js";

export const SHADOW_AI_CATALOG_V2_VERSION = 2;

export const SHADOW_CATALOG_V2_KINDS = ["endpoint", "sdk", "assistant_config", "ide_extension", "env_var"] as const;
export type ShadowCatalogV2Kind = (typeof SHADOW_CATALOG_V2_KINDS)[number];

export interface ShadowCatalogSource {
  /** "regulait" for our own entries, otherwise the upstream project */
  project: string;
  /** the upstream commit the entry was cross-checked against; null for ours */
  commit: string | null;
  licence: string;
}

export interface ShadowCatalogVerification {
  /** the vendor document or registry/marketplace listing the entry was checked against */
  url: string;
  /** ISO date the check was made */
  checkedOn: string;
}

export interface ShadowCatalogV2Entry {
  id: string;
  kind: ShadowCatalogV2Kind;
  /**
   * endpoint / sdk: as v1. assistant_config: a repo path —
   *   `**\/NAME` matches a file named NAME at any depth;
   *   a pattern ending in `/` matches anything under that directory at the root;
   *   one `*` is a literal startsWith/endsWith pair over the whole path;
   *   anything else is the exact path from the repo root.
   * ide_extension: an extension id, compared case-insensitively.
   * env_var: a variable name, compared exactly (upper case).
   */
  pattern: string;
  provider: string;
  notes: string;
  source: ShadowCatalogSource;
  verified: ShadowCatalogVerification | null;
}

export const PATRONAI_SOURCE: ShadowCatalogSource = Object.freeze({
  project: "giggsoinc/PatronAI (ghost-ai-scanner/config)",
  commit: "79bdcc88bd0bd9b9642a05800f55654eef626b7f",
  licence: "Apache-2.0",
});

const REGULAIT_V1: ShadowCatalogSource = Object.freeze({ project: "regulait (catalogue v1)", commit: null, licence: "regulait" });
const REGULAIT: ShadowCatalogSource = Object.freeze({ project: "regulait", commit: null, licence: "regulait" });

export const shadowCatalogV2EntrySchema = z
  .object({
    id: z.string().min(3).max(80),
    kind: z.enum(SHADOW_CATALOG_V2_KINDS),
    pattern: z.string().min(2).max(HOST_MAX),
    provider: z.string().min(2).max(60),
    notes: z.string().min(10).max(400),
    source: z.object({ project: z.string().min(3), commit: z.string().nullable(), licence: z.string().min(3) }).strict(),
    verified: z.object({ url: z.string().url(), checkedOn: z.string().length(10) }).strict().nullable(),
  })
  .strict()
  .refine((e) => (e.pattern.match(/\*/g) ?? []).length <= (e.pattern.startsWith("**/") ? 2 : 1), {
    message: "a pattern carries at most one wildcard (plus a leading **/ for assistant_config)",
  })
  .refine((e) => e.kind === "assistant_config" || !e.pattern.startsWith("**/"), {
    message: "only assistant_config patterns may use the any-depth **/ form",
  });

const deepFreeze = <T extends object>(o: T): T => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v as object);
  return Object.freeze(o);
};

const fromV1 = (e: ShadowCatalogEntry): ShadowCatalogV2Entry => ({
  id: e.id,
  kind: e.kind,
  pattern: e.pattern,
  provider: e.provider,
  notes: e.notes,
  source: REGULAIT_V1,
  verified: null,
});

const on = "2026-10-17";
const COPILOT_ALLOWLIST = { url: "https://docs.github.com/en/copilot/reference/copilot-allowlist-reference", checkedOn: on };
const COPILOT_INSTRUCTIONS = {
  url: "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions",
  checkedOn: on,
};
const AMAZON_Q_FIREWALL = { url: "https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/firewall.html", checkedOn: on };
const GEMINI_CODE_ASSIST = { url: "https://docs.cloud.google.com/gemini/docs/discover/set-up-gemini", checkedOn: on };
const marketplace = (id: string) => ({ url: `https://marketplace.visualstudio.com/items?itemName=${id}`, checkedOn: on });
const registry = (url: string) => ({ url, checkedOn: on });

type V2Input = Omit<ShadowCatalogV2Entry, "source" | "verified"> & {
  source?: ShadowCatalogSource;
  verified: ShadowCatalogVerification | null;
};
const N = (e: V2Input): ShadowCatalogV2Entry => ({ ...e, source: e.source ?? REGULAIT, verified: e.verified });

/**
 * VERSION 2 — FROZEN 2026-10-17. v1's 81 entries first, unchanged, then the
 * additions. Pinned by count and hash: to change detection, add a v3.
 */
export const SHADOW_AI_CATALOG_V2: ReadonlyArray<ShadowCatalogV2Entry> = deepFreeze([
  ...SHADOW_AI_CATALOG_V1.map(fromV1),

  // --- coding assistants: endpoints (vendor allow-list documentation) ---
  N({ id: "ep-github-copilot-api", kind: "endpoint", pattern: "*.githubcopilot.com", provider: "github-copilot", notes: "GitHub Copilot suggestion and chat API hosts (api., individual., business., enterprise.githubcopilot.com).", verified: COPILOT_ALLOWLIST }),
  N({ id: "ep-github-copilot-proxy", kind: "endpoint", pattern: "copilot-proxy.githubusercontent.com", provider: "github-copilot", notes: "GitHub Copilot suggestions API service host named in the Copilot allow-list reference.", verified: COPILOT_ALLOWLIST }),
  N({ id: "ep-github-copilot-origin-tracker", kind: "endpoint", pattern: "origin-tracker.githubusercontent.com", provider: "github-copilot", notes: "GitHub Copilot suggestions API service host named in the Copilot allow-list reference.", verified: COPILOT_ALLOWLIST }),
  N({ id: "ep-github-copilot-telemetry", kind: "endpoint", pattern: "copilot-telemetry.githubusercontent.com", provider: "github-copilot", notes: "GitHub Copilot client telemetry host. Evidence an installed Copilot client, not of suggestions served.", verified: COPILOT_ALLOWLIST }),
  N({ id: "ep-amazon-q-codewhisperer", kind: "endpoint", pattern: "codewhisperer.us-east-1.amazonaws.com", provider: "amazon-q-developer", notes: "Amazon Q Developer features endpoint (the former CodeWhisperer host) from the Q Developer firewall list.", verified: AMAZON_Q_FIREWALL }),
  N({ id: "ep-amazon-q-profile", kind: "endpoint", pattern: "q.*.amazonaws.com", provider: "amazon-q-developer", notes: "Amazon Q Developer features endpoint in the profile region (q.<region>.amazonaws.com).", verified: AMAZON_Q_FIREWALL }),
  N({ id: "ep-amazon-q-ide-integration", kind: "endpoint", pattern: "q-developer-integration.us-east-1.api.aws", provider: "amazon-q-developer", notes: "Amazon Q Developer in the IDE endpoint from the Q Developer firewall list.", verified: AMAZON_Q_FIREWALL }),
  N({ id: "ep-gemini-code-assist", kind: "endpoint", pattern: "cloudaicompanion.googleapis.com", provider: "gemini-code-assist", notes: "The primary Gemini Code Assist API endpoint, per Google's firewall guidance.", verified: GEMINI_CODE_ASSIST }),
  N({ id: "ep-gemini-code-assist-ide", kind: "endpoint", pattern: "cloudcode-pa.googleapis.com", provider: "gemini-code-assist", notes: "Internal API Gemini Code Assist uses for IDE features, per Google's firewall guidance.", verified: GEMINI_CODE_ASSIST }),

  // --- coding assistants: repository instruction and configuration files ---
  N({ id: "cfg-github-copilot-instructions", kind: "assistant_config", pattern: ".github/copilot-instructions.md", provider: "github-copilot", notes: "Repository-wide GitHub Copilot custom instructions.", verified: COPILOT_INSTRUCTIONS }),
  N({ id: "cfg-github-copilot-path-instructions", kind: "assistant_config", pattern: ".github/instructions/*.instructions.md", provider: "github-copilot", notes: "Path-specific GitHub Copilot custom instructions under .github/instructions.", verified: COPILOT_INSTRUCTIONS }),
  N({ id: "cfg-agents-md", kind: "assistant_config", pattern: "**/AGENTS.md", provider: "coding-agent", notes: "AGENTS.md agent instructions, read by several coding agents (GitHub Copilot among them); the nearest one in the tree applies.", verified: COPILOT_INSTRUCTIONS }),
  N({ id: "cfg-claude-md", kind: "assistant_config", pattern: "CLAUDE.md", provider: "anthropic", notes: "Root CLAUDE.md agent instructions (Claude Code; GitHub Copilot also reads it as an alternative).", verified: COPILOT_INSTRUCTIONS }),
  N({ id: "cfg-claude-settings", kind: "assistant_config", pattern: ".claude/settings.json", provider: "anthropic", notes: "Claude Code project settings, which hold MCP server approval settings.", verified: registry("https://code.claude.com/docs/en/mcp") }),
  N({ id: "cfg-gemini-md", kind: "assistant_config", pattern: "GEMINI.md", provider: "google", notes: "Root GEMINI.md context file (Gemini CLI default; GitHub Copilot also reads it).", verified: registry("https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html") }),
  N({ id: "cfg-gemini-settings", kind: "assistant_config", pattern: ".gemini/settings.json", provider: "google", notes: "Gemini CLI project settings (may declare MCP servers).", verified: registry("https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html") }),
  N({ id: "cfg-mcp-json", kind: "assistant_config", pattern: ".mcp.json", provider: "mcp", notes: "Project-scoped MCP server definitions at the repo root (mcpServers), shared by several clients.", verified: registry("https://code.claude.com/docs/en/mcp") }),
  N({ id: "cfg-vscode-mcp-json", kind: "assistant_config", pattern: ".vscode/mcp.json", provider: "mcp", notes: "VS Code workspace MCP server definitions (servers).", verified: registry("https://code.visualstudio.com/docs/copilot/customization/mcp-servers") }),
  N({ id: "cfg-amazon-q-rules", kind: "assistant_config", pattern: ".amazonq/rules/", provider: "amazon-q-developer", notes: "Amazon Q Developer project rules (Markdown files) at the project root.", verified: registry("https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/context-project-rules.html") }),
  N({ id: "cfg-jetbrains-ai-rules", kind: "assistant_config", pattern: ".aiassistant/rules/", provider: "jetbrains-ai", notes: "JetBrains AI Assistant project rules at the project root.", verified: registry("https://www.jetbrains.com/help/ai-assistant/configure-project-rules.html") }),
  N({ id: "cfg-windsurf-rules-legacy", kind: "assistant_config", pattern: ".windsurfrules", provider: "windsurf", notes: "Legacy single-file workspace rules for the Windsurf (now Devin Desktop) editor, still read.", verified: registry("https://docs.devin.ai/desktop/cascade/memories") }),
  N({ id: "cfg-windsurf-rules", kind: "assistant_config", pattern: ".windsurf/rules/", provider: "windsurf", notes: "Workspace rules folder for the Windsurf (now Devin Desktop) editor.", verified: registry("https://docs.devin.ai/desktop/cascade/memories") }),
  N({ id: "cfg-devin-rules", kind: "assistant_config", pattern: ".devin/rules/", provider: "windsurf", notes: "Preferred workspace rules folder for Devin Desktop (formerly Windsurf).", verified: registry("https://docs.devin.ai/desktop/cascade/memories") }),
  N({ id: "cfg-cline-rules", kind: "assistant_config", pattern: ".clinerules/", provider: "cline", notes: "Cline workspace rules folder at the project root.", verified: registry("https://docs.cline.bot/features/cline-rules") }),
  N({ id: "cfg-cline-rules-alt", kind: "assistant_config", pattern: ".cline/rules/", provider: "cline", notes: "Cline workspace rules, alternative folder at the project root.", verified: registry("https://docs.cline.bot/features/cline-rules") }),
  N({ id: "cfg-continue-rules", kind: "assistant_config", pattern: ".continue/rules/", provider: "continue", notes: "Continue workspace rules folder at the top level of the workspace.", verified: registry("https://docs.continue.dev/customize/deep-dives/rules") }),
  N({ id: "cfg-aider-conf", kind: "assistant_config", pattern: ".aider.conf.yml", provider: "aider", notes: "aider configuration file at the git repo root.", verified: registry("https://aider.chat/docs/config/aider_conf.html") }),

  N({ id: "ep-cursor-api", kind: "endpoint", pattern: "*.cursor.sh", provider: "cursor", notes: "Cursor editor API hosts (api2.cursor.sh and others), per the vendor's network configuration page.", verified: { url: "https://cursor.com/docs/enterprise/network-configuration", checkedOn: on } }),
  N({ id: "ep-cursor-marketplace", kind: "endpoint", pattern: "*.cursorapi.com", provider: "cursor", notes: "Cursor editor service hosts (marketplace.cursorapi.com and others), per the vendor's network configuration page.", verified: { url: "https://cursor.com/docs/enterprise/network-configuration", checkedOn: on } }),
  N({ id: "cfg-cursor-rules", kind: "assistant_config", pattern: ".cursor/rules/", provider: "cursor", notes: "Cursor project rules folder (.mdc files) at the project root.", verified: { url: "https://cursor.com/docs/rules", checkedOn: on } }),
  N({ id: "cfg-cursor-rules-legacy", kind: "assistant_config", pattern: ".cursorrules", provider: "cursor", notes: "Legacy single-file Cursor project rules at the project root.", verified: { url: "https://cursor.com/docs/rules", checkedOn: on } }),
  N({ id: "cfg-cursor-mcp-json", kind: "assistant_config", pattern: ".cursor/mcp.json", provider: "cursor", notes: "Cursor project MCP server definitions (mcpServers).", verified: { url: "https://cursor.com/docs/mcp", checkedOn: on } }),
  N({ id: "ep-lovable-app", kind: "endpoint", pattern: "lovable.dev", provider: "lovable", notes: "Lovable AI app builder web app.", verified: { url: "https://docs.lovable.dev/introduction", checkedOn: on } }),
  N({ id: "ep-lovable-published", kind: "endpoint", pattern: "*.lovable.app", provider: "lovable", notes: "Default domain of apps published from the Lovable AI app builder (<subdomain>.lovable.app).", verified: { url: "https://docs.lovable.dev/features/publish", checkedOn: on } }),

  // --- coding assistants: IDE extension ids (seen in .vscode/extensions.json) ---
  N({ id: "ext-github-copilot", kind: "ide_extension", pattern: "github.copilot", provider: "github-copilot", notes: "GitHub Copilot VS Code extension id.", source: PATRONAI_SOURCE, verified: marketplace("GitHub.copilot") }),
  N({ id: "ext-github-copilot-chat", kind: "ide_extension", pattern: "github.copilot-chat", provider: "github-copilot", notes: "GitHub Copilot Chat VS Code extension id.", source: PATRONAI_SOURCE, verified: marketplace("GitHub.copilot-chat") }),
  N({ id: "ext-tabnine", kind: "ide_extension", pattern: "tabnine.tabnine-vscode", provider: "tabnine", notes: "Tabnine VS Code extension id (listed by the marketplace as legacy).", source: PATRONAI_SOURCE, verified: marketplace("TabNine.tabnine-vscode") }),
  N({ id: "ext-continue", kind: "ide_extension", pattern: "continue.continue", provider: "continue", notes: "Continue open-source AI code agent VS Code extension id.", source: PATRONAI_SOURCE, verified: marketplace("Continue.continue") }),
  N({ id: "ext-amazon-q", kind: "ide_extension", pattern: "amazonwebservices.amazon-q-vscode", provider: "amazon-q-developer", notes: "Amazon Q VS Code extension id (the marketplace publisher is AmazonWebServices).", source: PATRONAI_SOURCE, verified: marketplace("AmazonWebServices.amazon-q-vscode") }),
  N({ id: "ext-gemini-code-assist", kind: "ide_extension", pattern: "google.geminicodeassist", provider: "gemini-code-assist", notes: "Gemini Code Assist VS Code extension id.", verified: marketplace("Google.geminicodeassist") }),
  N({ id: "ext-cline", kind: "ide_extension", pattern: "saoudrizwan.claude-dev", provider: "cline", notes: "Cline VS Code extension id (published under its historical name).", verified: marketplace("saoudrizwan.claude-dev") }),
  N({ id: "ext-roo-code", kind: "ide_extension", pattern: "rooveterinaryinc.roo-cline", provider: "roo-code", notes: "Roo Code VS Code extension id.", source: PATRONAI_SOURCE, verified: marketplace("RooVeterinaryInc.roo-cline") }),
  N({ id: "ext-claude-code", kind: "ide_extension", pattern: "anthropic.claude-code", provider: "anthropic", notes: "Claude Code for VS Code extension id.", verified: marketplace("anthropic.claude-code") }),

  // --- agent frameworks and MCP SDKs (cross-checked with PatronAI's code list) ---
  N({ id: "sdk-langgraph-py", kind: "sdk", pattern: "langgraph", provider: "langchain", notes: "LangGraph stateful agent framework on PyPI (npm uses @langchain/langgraph, covered by the v1 family).", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/langgraph/") }),
  N({ id: "sdk-haystack-py", kind: "sdk", pattern: "haystack-ai", provider: "deepset-haystack", notes: "Haystack LLM pipeline framework on PyPI.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/haystack-ai/") }),
  N({ id: "sdk-pydantic-ai-py", kind: "sdk", pattern: "pydantic-ai", provider: "pydantic-ai", notes: "Pydantic AI agent framework on PyPI; provider-agnostic.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/pydantic-ai/") }),
  N({ id: "sdk-smolagents-py", kind: "sdk", pattern: "smolagents", provider: "huggingface", notes: "Hugging Face smolagents library on PyPI.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/smolagents/") }),
  N({ id: "sdk-autogen-py", kind: "sdk", pattern: "autogen-agentchat", provider: "microsoft", notes: "AutoGen AgentChat multi-agent framework on PyPI.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/autogen-agentchat/") }),
  N({ id: "sdk-ag2-py", kind: "sdk", pattern: "ag2", provider: "ag2", notes: "AG2, the community continuation of AutoGen, on PyPI.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/ag2/") }),
  N({ id: "sdk-metagpt-py", kind: "sdk", pattern: "metagpt", provider: "metagpt", notes: "MetaGPT software-development multi-agent framework on PyPI.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/metagpt/") }),
  N({ id: "sdk-google-adk-py", kind: "sdk", pattern: "google-adk", provider: "google", notes: "Google Agent Development Kit on PyPI.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/google-adk/") }),
  N({ id: "sdk-mastra-ns", kind: "sdk", pattern: "@mastra/*", provider: "mastra", notes: "Mastra TypeScript agent framework npm namespace (@mastra/core, ...).", source: PATRONAI_SOURCE, verified: registry("https://www.npmjs.com/package/@mastra/core") }),
  N({ id: "sdk-openai-agents-js", kind: "sdk", pattern: "@openai/agents", provider: "openai", notes: "OpenAI Agents SDK on npm.", source: PATRONAI_SOURCE, verified: registry("https://www.npmjs.com/package/@openai/agents") }),
  N({ id: "sdk-mcp-py", kind: "sdk", pattern: "mcp", provider: "mcp", notes: "Model Context Protocol Python SDK on PyPI. An MCP client or server is in the code base.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/mcp/") }),
  N({ id: "sdk-mcp-js-ns", kind: "sdk", pattern: "@modelcontextprotocol/*", provider: "mcp", notes: "Model Context Protocol npm namespace (@modelcontextprotocol/sdk and servers).", source: PATRONAI_SOURCE, verified: registry("https://www.npmjs.com/package/@modelcontextprotocol/sdk") }),
  N({ id: "sdk-llama-cpp-py", kind: "sdk", pattern: "llama-cpp-python", provider: "llama-cpp", notes: "llama.cpp Python bindings: local model inference.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/llama-cpp-python/") }),
  N({ id: "sdk-node-llama-cpp", kind: "sdk", pattern: "node-llama-cpp", provider: "llama-cpp", notes: "llama.cpp Node.js bindings: local model inference.", verified: registry("https://www.npmjs.com/package/node-llama-cpp") }),
  N({ id: "sdk-gpt4all-py", kind: "sdk", pattern: "gpt4all", provider: "gpt4all", notes: "GPT4All local model runner on PyPI.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/gpt4all/") }),
  N({ id: "sdk-lmstudio-py", kind: "sdk", pattern: "lmstudio", provider: "lm-studio", notes: "LM Studio Python SDK: local model serving.", source: PATRONAI_SOURCE, verified: registry("https://pypi.org/project/lmstudio/") }),
  N({ id: "sdk-lmstudio-js", kind: "sdk", pattern: "@lmstudio/sdk", provider: "lm-studio", notes: "LM Studio TypeScript SDK: local model serving.", source: PATRONAI_SOURCE, verified: registry("https://www.npmjs.com/package/@lmstudio/sdk") }),

  // --- further ecosystems the repo scanner reads ---
  N({ id: "sdk-maven-openai-java", kind: "sdk", pattern: "com.openai:openai-java", provider: "openai", notes: "Official OpenAI Java SDK (Maven/Gradle coordinate groupId:artifactId).", verified: registry("https://central.sonatype.com/artifact/com.openai/openai-java") }),
  N({ id: "sdk-maven-anthropic-java", kind: "sdk", pattern: "com.anthropic:anthropic-java", provider: "anthropic", notes: "Official Anthropic Java SDK (Maven/Gradle coordinate).", verified: registry("https://central.sonatype.com/artifact/com.anthropic/anthropic-java") }),
  N({ id: "sdk-maven-google-genai", kind: "sdk", pattern: "com.google.genai:google-genai", provider: "google", notes: "Google Gen AI Java SDK (Maven/Gradle coordinate).", verified: registry("https://central.sonatype.com/artifact/com.google.genai/google-genai") }),
  N({ id: "sdk-maven-langchain4j", kind: "sdk", pattern: "dev.langchain4j:*", provider: "langchain", notes: "LangChain4j Java framework family (every artifact in the dev.langchain4j group); provider-agnostic.", verified: registry("https://central.sonatype.com/namespace/dev.langchain4j") }),
  N({ id: "sdk-maven-spring-ai", kind: "sdk", pattern: "org.springframework.ai:*", provider: "spring-ai", notes: "Spring AI family (every artifact in the org.springframework.ai group); provider-agnostic.", verified: registry("https://central.sonatype.com/namespace/org.springframework.ai") }),
  N({ id: "sdk-nuget-openai", kind: "sdk", pattern: "OpenAI", provider: "openai", notes: "Official OpenAI .NET library on NuGet (package ids compare case-insensitively).", verified: registry("https://www.nuget.org/packages/OpenAI") }),
  N({ id: "sdk-nuget-azure-openai", kind: "sdk", pattern: "Azure.AI.OpenAI", provider: "azure-openai", notes: "Azure OpenAI .NET client library on NuGet.", verified: registry("https://www.nuget.org/packages/Azure.AI.OpenAI") }),
  N({ id: "sdk-nuget-anthropic-community", kind: "sdk", pattern: "Anthropic.SDK", provider: "anthropic", notes: "Community Anthropic .NET client on NuGet.", verified: registry("https://www.nuget.org/packages/Anthropic.SDK") }),
  N({ id: "sdk-nuget-semantic-kernel", kind: "sdk", pattern: "Microsoft.SemanticKernel", provider: "microsoft", notes: "Microsoft Semantic Kernel for .NET on NuGet; provider-agnostic orchestration.", verified: registry("https://www.nuget.org/packages/Microsoft.SemanticKernel") }),
  N({ id: "sdk-nuget-extensions-ai", kind: "sdk", pattern: "Microsoft.Extensions.AI", provider: "microsoft", notes: "Microsoft.Extensions.AI abstractions for .NET; provider-agnostic model plumbing.", verified: registry("https://www.nuget.org/packages/Microsoft.Extensions.AI") }),
  N({ id: "sdk-gem-ruby-openai", kind: "sdk", pattern: "ruby-openai", provider: "openai", notes: "Community OpenAI Ruby gem.", verified: registry("https://rubygems.org/gems/ruby-openai") }),
  N({ id: "sdk-gem-langchainrb", kind: "sdk", pattern: "langchainrb", provider: "langchain", notes: "LangChain for Ruby gem; provider-agnostic.", verified: registry("https://rubygems.org/gems/langchainrb") }),
  N({ id: "sdk-crate-async-openai", kind: "sdk", pattern: "async-openai", provider: "openai", notes: "Community async OpenAI client crate for Rust.", verified: registry("https://crates.io/crates/async-openai") }),
  N({ id: "sdk-crate-ollama-rs", kind: "sdk", pattern: "ollama-rs", provider: "ollama", notes: "Ollama client crate for Rust: local model serving.", verified: registry("https://crates.io/crates/ollama-rs") }),

  // --- further endpoints (cross-checked with PatronAI's provider list) ---
  N({ id: "ep-ollama-registry", kind: "endpoint", pattern: "registry.ollama.ai", provider: "ollama", notes: "Ollama model registry: local models being pulled, not a hosted API call.", source: PATRONAI_SOURCE, verified: null }),
  N({ id: "ep-huggingface-hub", kind: "endpoint", pattern: "huggingface.co", provider: "huggingface", notes: "Hugging Face Hub (model and dataset downloads, web). The more specific inference entries win where they match.", source: PATRONAI_SOURCE, verified: null }),
  N({ id: "ep-langsmith", kind: "endpoint", pattern: "smith.langchain.com", provider: "langchain", notes: "LangSmith tracing and prompt hub: prompts and traces leaving the network.", source: PATRONAI_SOURCE, verified: null }),
  N({ id: "ep-llamaindex-cloud", kind: "endpoint", pattern: "api.llamaindex.ai", provider: "llamaindex", notes: "LlamaIndex cloud services API (parsing and managed indexes).", source: PATRONAI_SOURCE, verified: null }),

  // --- provider environment-variable NAMES (values are never read or kept) ---
  ...(
    [
      ["OPENAI_API_KEY", "openai"],
      ["OPENAI_BASE_URL", "openai"],
      ["ANTHROPIC_API_KEY", "anthropic"],
      ["GEMINI_API_KEY", "google"],
      ["GOOGLE_GENAI_USE_VERTEXAI", "google"],
      ["AZURE_OPENAI_API_KEY", "azure-openai"],
      ["AZURE_OPENAI_ENDPOINT", "azure-openai"],
      ["MISTRAL_API_KEY", "mistral"],
      ["CO_API_KEY", "cohere"],
      ["COHERE_API_KEY", "cohere"],
      ["GROQ_API_KEY", "groq"],
      ["TOGETHER_API_KEY", "together"],
      ["DEEPSEEK_API_KEY", "deepseek"],
      ["XAI_API_KEY", "xai"],
      ["PERPLEXITY_API_KEY", "perplexity"],
      ["OPENROUTER_API_KEY", "openrouter"],
      ["FIREWORKS_API_KEY", "fireworks"],
      ["REPLICATE_API_TOKEN", "replicate"],
      ["HF_TOKEN", "huggingface"],
      ["OLLAMA_HOST", "ollama"],
      ["LANGSMITH_API_KEY", "langchain"],
    ] as const
  ).map(([name, provider]) =>
    N({
      id: `env-${name.toLowerCase().replace(/_/g, "-")}`,
      kind: "env_var",
      pattern: name,
      provider,
      notes: `The ${provider} client's documented environment variable name. Only the NAME is matched; a value is never read or stored.`,
      verified: null,
    }),
  ),
]);

/** the v2 counterpart of SHADOW_DISCOVERY_POSTURE's catalogue clause */
export const SHADOW_AI_CATALOG_V2_NOTE =
  "Catalogue version 2 (frozen 2026-10-17; v1 is unchanged inside it). Inherently incomplete and dated: it triages " +
  "and suggests; findings come only from this deployment's own admin signature catalogue.";

// ===========================================================================
// MATCHING — literal comparisons, most specific wins (as v1)
// ===========================================================================

/**
 * The specificity a tie is broken on: the literal characters of a pattern. A
 * leading any-depth prefix and every `*` are excluded, counted character by
 * character (no string replacement, so no occurrence can be missed).
 */
export function catalogPatternLiteralLength(pattern: string): number {
  const body = pattern.startsWith("**/") ? pattern.slice(3) : pattern;
  let n = 0;
  for (const c of body) if (c !== "*") n++;
  return n;
}
const literalLength = catalogPatternLiteralLength;

const asV1 = (e: ShadowCatalogV2Entry): ShadowCatalogEntry | null =>
  e.kind === "endpoint" || e.kind === "sdk" ? { id: e.id, kind: e.kind, pattern: e.pattern, provider: e.provider, notes: e.notes } : null;

function best(hits: ShadowCatalogV2Entry[]): ShadowCatalogV2Entry | null {
  hits.sort((a, b) => literalLength(b.pattern) - literalLength(a.pattern) || a.id.localeCompare(b.id));
  return hits[0] ?? null;
}

export function matchCatalogV2Endpoint(host: string, catalog = SHADOW_AI_CATALOG_V2): ShadowCatalogV2Entry | null {
  return best(catalog.filter((e) => { const v = asV1(e); return v !== null && endpointEntryMatches(host, v); }));
}

export function matchCatalogV2Package(name: string, catalog = SHADOW_AI_CATALOG_V2): ShadowCatalogV2Entry | null {
  return best(catalog.filter((e) => { const v = asV1(e); return v !== null && sdkEntryMatches(name, v); }));
}

/** an assistant_config path pattern against a repo-relative path (see the entry doc) */
export function assistantConfigMatches(path: string, pattern: string): boolean {
  if (pattern.startsWith("**/")) {
    const name = pattern.slice(3);
    return path === name || path.endsWith(`/${name}`);
  }
  const star = pattern.indexOf("*");
  if (star !== -1) {
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    return path.length >= prefix.length + suffix.length && path.startsWith(prefix) && path.endsWith(suffix);
  }
  if (pattern.endsWith("/")) return path.startsWith(pattern) && path.length > pattern.length;
  return path === pattern;
}

export function matchCatalogV2AssistantConfig(path: string, catalog = SHADOW_AI_CATALOG_V2): ShadowCatalogV2Entry | null {
  return best(catalog.filter((e) => e.kind === "assistant_config" && assistantConfigMatches(path, e.pattern)));
}

export function matchCatalogV2Extension(id: string, catalog = SHADOW_AI_CATALOG_V2): ShadowCatalogV2Entry | null {
  const n = id.trim().toLowerCase();
  return best(catalog.filter((e) => e.kind === "ide_extension" && e.pattern.toLowerCase() === n));
}

export function matchCatalogV2EnvVar(name: string, catalog = SHADOW_AI_CATALOG_V2): ShadowCatalogV2Entry | null {
  return best(catalog.filter((e) => e.kind === "env_var" && e.pattern === name));
}

// ===========================================================================
// SEED ROWS — data for the admin catalogue (`ai_endpoint_signatures`)
// ===========================================================================

/**
 * A seed row for the admin catalogue. `kind`/`matchType` use the names the
 * existing table takes (`hostname`/`exact_host`/`host_suffix`,
 * `sdk_package`/`package`) and, for SD0's artifact kinds `assistant_config` and
 * `ide_extension`, the `identifier` match type. The repo scanner reports an
 * assistant config as the catalogue pattern it matched, so the identifier
 * equality lines up with these rows.
 */
export interface DiscoverySeedRow {
  provider: string;
  kind: "hostname" | "sdk_package" | "assistant_config" | "ide_extension";
  value: string;
  /** `identifier`: SD0's whole-identifier, case-insensitive match for the artifact kinds */
  matchType: "exact_host" | "host_suffix" | "package" | "identifier";
  provenance: string;
  /** the v2 catalogue entry this row was derived from */
  catalogEntryId: string;
}

const v1Ids = new Set(SHADOW_AI_CATALOG_V1.map((e) => e.id));

function seedFor(e: ShadowCatalogV2Entry): DiscoverySeedRow | null {
  const provenance = e.source.commit
    ? `regulait-seed catalog-v2 ${e.id} (cross-checked ${e.source.project}@${e.source.commit.slice(0, 12)}, ${e.source.licence})`
    : `regulait-seed catalog-v2 ${e.id}`;
  const base = { provider: e.provider, provenance, catalogEntryId: e.id };
  switch (e.kind) {
    case "endpoint": {
      const star = e.pattern.indexOf("*");
      if (star === -1) return { ...base, kind: "hostname", value: e.pattern, matchType: "exact_host" };
      // only a leading `*.` maps onto the table's dot-boundary suffix match
      if (e.pattern.startsWith("*.") && star === 0) return { ...base, kind: "hostname", value: e.pattern.slice(2), matchType: "host_suffix" };
      return null;
    }
    case "sdk":
      // the table's package match is exact; a family wildcard stays compiled-only (reported as a gap)
      return e.pattern.includes("*") ? null : { ...base, kind: "sdk_package", value: e.pattern, matchType: "package" };
    case "assistant_config":
      return { ...base, kind: "assistant_config", value: e.pattern, matchType: "identifier" };
    case "ide_extension":
      return { ...base, kind: "ide_extension", value: e.pattern, matchType: "identifier" };
    case "env_var":
      return null;
  }
}

/** the SD1 seed rows: every v2 addition the admin catalogue can express */
export const SHADOW_AI_SEED_ROWS_SD1: ReadonlyArray<DiscoverySeedRow> = deepFreeze(
  SHADOW_AI_CATALOG_V2.filter((e) => !v1Ids.has(e.id))
    .map(seedFor)
    .filter((r): r is DiscoverySeedRow => r !== null),
);
