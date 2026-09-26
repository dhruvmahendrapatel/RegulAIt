/**
 * ADR-0083 — FIRST-PARTY SHADOW-AI DISCOVERY, the pure half.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * --------------------------------------------
 * ADR-0055 ships the evidence pipeline; ADR-0071 ships format adapters that
 * read a file a customer's OTHER tools produced. Both leave one question a
 * buyer keeps asking unanswered without a third-party feed: "what AI is
 * running here that never touched the gateway?" This module is the first-party
 * answer RegulAIt can give WITHOUT reversing ADR-0071's refusal to ship
 * scrapers: a CLASSIFIER over inputs the operator already has — a DNS or proxy
 * log they exported, a dependency manifest out of their own repo — matched
 * against a catalogue that is COMPILED INTO THE BUILD.
 *
 *   - NO COLLECTOR. Nothing here makes a network call, reads a file from disk,
 *     or runs on a schedule. Every function is (text in, classification out).
 *   - NO SCRAPER. There is still no vendor-named integration that goes and
 *     fetches anything. The operator initiates every classification by
 *     uploading content they already hold.
 *   - NO PHONE-HOME. The catalogue ships in the binary (the ADR-0068 corpus
 *     pattern), so an air-gapped deployment classifies exactly as well as a
 *     hosted one, and no inventory of a customer's AI usage ever leaves the box.
 *
 * TWO CATALOGUES, TWO JOBS — this is the load-bearing distinction
 * ---------------------------------------------------------------
 * ADR-0055's `ai_endpoint_signatures` table is the deployment's OWN detection
 * surface: data, admin-editable, and the ONLY thing that can turn an
 * observation into a stored finding ("detection is data" — empty that table
 * and nothing is found). The compiled catalogue below does a different job: it
 * is a versioned, frozen REFERENCE the classifier uses to TRIAGE raw operator
 * input — which lines of this log even name an AI provider, which manifest
 * entries are AI SDKs — before anything reaches the pipeline. A compiled hit
 * never mints a finding by itself; the rows it forwards still go through
 * ADR-0055's pipeline and are matched against the ADMIN catalogue there. When
 * the compiled catalogue recognises something the deployment catalogue would
 * not, that is surfaced as a GAP for the admin to close with a catalogue row —
 * never silently promoted into a finding.
 *
 * WHY FROZEN (the ADR-0068 corpus discipline)
 * -------------------------------------------
 * A finding tagged "matched sdk-litellm @ catalog v1" must mean the same thing
 * in two years. So the catalogue is versioned, `SHADOW_AI_CATALOG_V1` is
 * deep-frozen, and the shared suite pins its entry count AND a content hash —
 * extending detection is a NEW VERSION (a v2 alongside v1), never a silent
 * edit under results already tagged with v1.
 *
 * HONESTY, stated where the code lives:
 *   - The catalogue is INHERENTLY INCOMPLETE AND DATED. It names the providers
 *     its authors knew of on its freeze date; a provider founded the week
 *     after is invisible to it. That is why gaps route to the ADMIN catalogue,
 *     which needs no release to grow.
 *   - A hit proves an ARTIFACT MENTIONED a provider — a resolved name, a
 *     declared dependency — never that traffic flowed, and never who sent it.
 *   - Matching is character comparison end to end. NO REGEX FROM DATA
 *     (ADR-0055's rule): the only wildcard is a single literal `*` split into
 *     a startsWith/endsWith pair.
 */
import { z } from "zod";
import { EVIDENCE_MAX_BYTES, HOST_MAX, normalizeEvidenceHost } from "./shadow-ai.js";

// ===========================================================================
// 1. THE CATALOGUE — versioned, compiled-in, frozen
// ===========================================================================

export const SHADOW_AI_CATALOG_VERSION = 1;

export const SHADOW_CATALOG_KINDS = ["endpoint", "sdk"] as const;
export type ShadowCatalogKind = (typeof SHADOW_CATALOG_KINDS)[number];

export interface ShadowCatalogEntry {
  /** stable id — the string a finding's ledger tag carries forever */
  id: string;
  kind: ShadowCatalogKind;
  /**
   * endpoint: a hostname, optionally with ONE `*` (`bedrock*.amazonaws.com`,
   * `*.openai.azure.com`). A bare hostname matches itself and any dot-boundary
   * subdomain. sdk: a package name, optionally with ONE trailing `*` for a
   * namespace/family (`@langchain/*`, `langchain-*`). Never a regex.
   */
  pattern: string;
  /** the provider label a match reports */
  provider: string;
  notes: string;
}

export const shadowCatalogEntrySchema = z
  .object({
    id: z.string().min(3).max(80),
    kind: z.enum(SHADOW_CATALOG_KINDS),
    pattern: z.string().min(2).max(HOST_MAX),
    provider: z.string().min(2).max(60),
    notes: z.string().min(10).max(400),
  })
  .strict()
  .refine((e) => (e.pattern.match(/\*/g) ?? []).length <= 1, {
    message: "a pattern carries at most one wildcard — anything richer is a regex in disguise",
  })
  .refine((e) => e.kind !== "sdk" || !e.pattern.includes("*") || e.pattern.endsWith("*"), {
    message: "an sdk wildcard is a trailing family prefix (`@langchain/*`), never infix",
  });

const deepFreeze = <T extends object>(o: T): T => {
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") deepFreeze(v as object);
  }
  return Object.freeze(o);
};

const E = (id: string, pattern: string, provider: string, notes: string): ShadowCatalogEntry => ({
  id,
  kind: "endpoint",
  pattern,
  provider,
  notes,
});
const S = (id: string, pattern: string, provider: string, notes: string): ShadowCatalogEntry => ({
  id,
  kind: "sdk",
  pattern,
  provider,
  notes,
});

/**
 * VERSION 1 — FROZEN 2026-08-20. Compiled from this project's own knowledge of
 * publicly documented provider endpoints and SDK package names; nothing here
 * was scraped, and NO entry claims to be exhaustive. The shared suite pins the
 * count and a content hash of this array: to change detection, add a v2.
 */
export const SHADOW_AI_CATALOG_V1: ReadonlyArray<ShadowCatalogEntry> = deepFreeze([
  // --- provider API endpoints (a DNS/proxy hit = something resolved or called it) ---
  E("ep-openai-api", "api.openai.com", "openai", "OpenAI platform API. Matches the host and any subdomain on a dot boundary."),
  E("ep-anthropic-api", "api.anthropic.com", "anthropic", "Anthropic Claude API endpoint for Messages and related APIs."),
  E("ep-google-generative-language", "generativelanguage.googleapis.com", "google", "Google Gemini API (Generative Language) endpoint used by AI Studio API keys."),
  E("ep-google-vertex-ai", "*aiplatform.googleapis.com", "google", "Google Vertex AI, including regional endpoints such as us-central1-aiplatform.googleapis.com. Vertex also serves non-generative ML — a hit means Vertex AI, not necessarily an LLM."),
  E("ep-xai-api", "api.x.ai", "xai", "xAI Grok API endpoint."),
  E("ep-mistral-api", "api.mistral.ai", "mistral", "Mistral AI platform API endpoint."),
  E("ep-mistral-codestral", "codestral.mistral.ai", "mistral", "Mistral Codestral code-model endpoint."),
  E("ep-cohere-api-ai", "api.cohere.ai", "cohere", "Cohere API endpoint (legacy .ai domain, still widely configured)."),
  E("ep-cohere-api-com", "api.cohere.com", "cohere", "Cohere API endpoint (current .com domain)."),
  E("ep-openrouter", "openrouter.ai", "openrouter", "OpenRouter model aggregator. One hit can front many upstream providers; the aggregator is what was reached."),
  E("ep-groq-api", "api.groq.com", "groq", "Groq LPU inference API endpoint."),
  E("ep-together-api", "api.together.xyz", "together", "Together AI inference API endpoint."),
  E("ep-aws-bedrock", "bedrock*.amazonaws.com", "aws-bedrock", "AWS Bedrock control-plane and runtime endpoints, e.g. bedrock-runtime.us-east-1.amazonaws.com, across regions."),
  E("ep-azure-openai", "*.openai.azure.com", "azure-openai", "Azure OpenAI per-resource endpoints (<resource>.openai.azure.com)."),
  E("ep-azure-cognitive", "*.cognitiveservices.azure.com", "azure-ai", "Azure AI services per-resource endpoints. Covers ALL Azure Cognitive Services (speech, vision, language) — a hit is Azure AI usage, not proof of an LLM."),
  E("ep-azure-ai-foundry", "*.services.ai.azure.com", "azure-ai", "Azure AI Foundry per-resource endpoints."),
  E("ep-deepseek-api", "api.deepseek.com", "deepseek", "DeepSeek platform API endpoint."),
  E("ep-perplexity-api", "api.perplexity.ai", "perplexity", "Perplexity Sonar API endpoint."),
  E("ep-fireworks-api", "api.fireworks.ai", "fireworks", "Fireworks AI inference API endpoint."),
  E("ep-replicate-api", "api.replicate.com", "replicate", "Replicate model-hosting API endpoint."),
  E("ep-huggingface-inference", "api-inference.huggingface.co", "huggingface", "Hugging Face serverless inference API endpoint."),
  E("ep-huggingface-router", "router.huggingface.co", "huggingface", "Hugging Face inference-providers router endpoint."),
  E("ep-stability-api", "api.stability.ai", "stability", "Stability AI image/video generation API endpoint."),
  E("ep-elevenlabs-api", "api.elevenlabs.io", "elevenlabs", "ElevenLabs speech-synthesis API endpoint."),
  E("ep-voyage-api", "api.voyageai.com", "voyage", "Voyage AI embeddings API endpoint."),
  E("ep-deepinfra-api", "api.deepinfra.com", "deepinfra", "DeepInfra open-weight model hosting API endpoint."),
  E("ep-cerebras-api", "api.cerebras.ai", "cerebras", "Cerebras inference API endpoint."),
  E("ep-sambanova-api", "api.sambanova.ai", "sambanova", "SambaNova inference API endpoint."),
  // --- consumer web apps (a DNS hit = someone browsed there; no API to re-route) ---
  E("ep-openai-chatgpt", "chatgpt.com", "openai", "ChatGPT consumer web app (current domain). Browser usage, not an API integration."),
  E("ep-openai-chat-legacy", "chat.openai.com", "openai", "ChatGPT consumer web app (legacy domain, still resolved by cached clients)."),
  E("ep-anthropic-claude-web", "claude.ai", "anthropic", "Claude consumer web app. Browser usage, not an API integration."),
  E("ep-google-gemini-web", "gemini.google.com", "google", "Gemini consumer web app. Browser usage, not an API integration."),
  E("ep-microsoft-copilot-web", "copilot.microsoft.com", "microsoft", "Microsoft Copilot consumer web app. Browser usage, not an API integration."),
  E("ep-perplexity-web", "perplexity.ai", "perplexity", "Perplexity consumer web app; api.perplexity.ai is carried by its own more-specific entry."),
  E("ep-deepseek-chat-web", "chat.deepseek.com", "deepseek", "DeepSeek consumer chat web app."),
  E("ep-poe-web", "poe.com", "quora-poe", "Poe multi-model consumer chat web app."),
  E("ep-characterai-web", "character.ai", "character-ai", "Character.AI consumer chat web app."),
  // --- SDK / package signatures (a manifest entry = a CAPABILITY, never observed traffic) ---
  S("sdk-openai", "openai", "openai", "Official OpenAI SDK — the same name on npm and PyPI. A dependency is a capability to call the API, not proof that anything did."),
  S("sdk-anthropic-node", "@anthropic-ai/sdk", "anthropic", "Official Anthropic TypeScript/JavaScript SDK on npm."),
  S("sdk-anthropic-python", "anthropic", "anthropic", "Official Anthropic Python SDK on PyPI."),
  S("sdk-google-generative-ai-js", "@google/generative-ai", "google", "Google Generative AI JavaScript SDK (legacy namespace)."),
  S("sdk-google-genai-js", "@google/genai", "google", "Google Gen AI JavaScript SDK (current namespace)."),
  S("sdk-google-generativeai-py", "google-generativeai", "google", "Google Generative AI Python SDK (legacy package)."),
  S("sdk-google-genai-py", "google-genai", "google", "Google Gen AI Python SDK (current package)."),
  S("sdk-google-vertex-py", "google-cloud-aiplatform", "google", "Google Vertex AI Python SDK. Vertex also serves non-generative ML."),
  S("sdk-google-vertex-js", "@google-cloud/vertexai", "google", "Google Vertex AI Node.js SDK."),
  S("sdk-aws-bedrock-js", "@aws-sdk/client-bedrock-runtime", "aws-bedrock", "AWS SDK v3 Bedrock runtime client on npm. Python callers typically use boto3, which this catalogue cannot distinguish from any other AWS usage."),
  S("sdk-azure-openai-js", "@azure/openai", "azure-openai", "Azure OpenAI client library on npm."),
  S("sdk-cohere-js", "cohere-ai", "cohere", "Cohere JavaScript SDK on npm."),
  S("sdk-cohere-py", "cohere", "cohere", "Cohere Python SDK on PyPI."),
  S("sdk-mistral-js", "@mistralai/mistralai", "mistral", "Mistral JavaScript SDK on npm."),
  S("sdk-mistral-py", "mistralai", "mistral", "Mistral Python SDK on PyPI."),
  S("sdk-groq-js", "groq-sdk", "groq", "Groq JavaScript SDK on npm."),
  S("sdk-groq-py", "groq", "groq", "Groq Python SDK on PyPI."),
  S("sdk-together-js", "together-ai", "together", "Together AI JavaScript SDK on npm."),
  S("sdk-together-py", "together", "together", "Together AI Python SDK on PyPI."),
  S("sdk-langchain", "langchain", "langchain", "LangChain core package — the same name on npm and PyPI. Framework, provider-agnostic: says AI plumbing exists, not which vendor serves it."),
  S("sdk-langchain-ns", "@langchain/*", "langchain", "LangChain npm namespace family (@langchain/core, @langchain/openai, ...)."),
  S("sdk-langchain-py-family", "langchain-*", "langchain", "LangChain PyPI family (langchain-core, langchain-openai, ...)."),
  S("sdk-llamaindex-js", "llamaindex", "llamaindex", "LlamaIndex TypeScript package on npm."),
  S("sdk-llamaindex-py", "llama-index", "llamaindex", "LlamaIndex Python package on PyPI."),
  S("sdk-llamaindex-py-family", "llama-index-*", "llamaindex", "LlamaIndex PyPI family (llama-index-core, llama-index-llms-openai, ...)."),
  S("sdk-litellm", "litellm", "litellm", "LiteLLM multi-provider gateway/SDK. Its presence says model calls are routed in code — to any of a hundred providers."),
  S("sdk-transformers", "transformers", "huggingface", "Hugging Face Transformers. Frequently LOCAL inference — a dependency implies models may run in-house, not that traffic leaves."),
  S("sdk-sentence-transformers", "sentence-transformers", "huggingface", "Sentence-Transformers embeddings library; usually local inference."),
  S("sdk-vllm", "vllm", "vllm", "vLLM serving engine — usually evidence of SELF-HOSTED model serving rather than SaaS usage."),
  S("sdk-ollama", "ollama", "ollama", "Ollama client — the same name on npm and PyPI; local model serving."),
  S("sdk-vercel-ai", "ai", "vercel-ai", "Vercel AI SDK — the npm package really is named `ai`. Matched exactly; provider-agnostic frontend/model plumbing."),
  S("sdk-vercel-ai-ns", "@ai-sdk/*", "vercel-ai", "Vercel AI SDK provider family (@ai-sdk/openai, @ai-sdk/anthropic, ...)."),
  S("sdk-huggingface-hub-py", "huggingface-hub", "huggingface", "Hugging Face Hub Python client (PyPI spells it huggingface_hub; names are compared with _ and - folded)."),
  S("sdk-huggingface-inference-js", "@huggingface/inference", "huggingface", "Hugging Face inference JavaScript client on npm."),
  S("sdk-replicate", "replicate", "replicate", "Replicate client — the same name on npm and PyPI."),
  S("sdk-crewai", "crewai", "crewai", "CrewAI multi-agent framework on PyPI; provider-agnostic."),
  S("sdk-semantic-kernel", "semantic-kernel", "microsoft", "Microsoft Semantic Kernel on PyPI; provider-agnostic orchestration."),
  S("sdk-openai-agents-py", "openai-agents", "openai", "OpenAI Agents SDK on PyPI."),
  S("sdk-go-openai-community", "github.com/sashabaranov/go-openai", "openai", "De-facto community Go client for the OpenAI API."),
  S("sdk-go-openai-official", "github.com/openai/openai-go", "openai", "Official OpenAI Go SDK module path."),
  S("sdk-go-anthropic", "github.com/anthropics/anthropic-sdk-go", "anthropic", "Official Anthropic Go SDK module path."),
  S("sdk-go-bedrock", "github.com/aws/aws-sdk-go-v2/service/bedrockruntime", "aws-bedrock", "AWS SDK for Go v2 Bedrock runtime module path."),
  S("sdk-go-google-genai", "google.golang.org/genai", "google", "Google Gen AI Go SDK module path."),
  S("sdk-go-langchaingo", "github.com/tmc/langchaingo", "langchain", "LangChainGo framework module path; provider-agnostic."),
]);

/** the sentence every response and screen carries, verbatim */
export const SHADOW_DISCOVERY_POSTURE =
  "First-party discovery classifies text YOU paste against a catalogue COMPILED INTO THIS BUILD (version " +
  SHADOW_AI_CATALOG_VERSION +
  ", frozen — inherently incomplete and dated). Nothing runs continuously, nothing is scraped, no network call is made, " +
  "and the pasted content is not stored — only the classification summary and any ingested evidence rows are. " +
  "A hit proves an artifact MENTIONED a provider (a resolved name, a declared dependency), never that traffic flowed; " +
  "encrypted or DoH traffic that bypasses your log is invisible here. Findings are still computed by this deployment's " +
  "OWN admin signature catalogue — the compiled catalogue triages and suggests, it cannot mint a finding.";

// ===========================================================================
// 2. MATCHING — character scans, most-specific-wins
// ===========================================================================

/** one wildcard split into a literal (startsWith, endsWith) pair — never a regex */
function wildcardMatch(value: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) return value === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    value.length >= prefix.length + suffix.length && value.startsWith(prefix) && value.endsWith(suffix)
  );
}

/** the specificity a tie is broken on: literal characters, wildcard excluded */
const literalLength = (pattern: string): number => pattern.replace("*", "").length;

/**
 * Match a host against an endpoint entry. A bare pattern matches itself and
 * any subdomain ON A DOT BOUNDARY (`openai.com` never matches `notopenai.com`,
 * and nothing here can match `api.openai.com.evil.net`). A wildcard pattern is
 * a literal startsWith/endsWith pair.
 */
export function endpointEntryMatches(host: string, entry: ShadowCatalogEntry): boolean {
  if (entry.kind !== "endpoint") return false;
  const h = normalizeEvidenceHost(host);
  if (!h) return false;
  const p = entry.pattern.toLowerCase();
  if (p.includes("*")) return wildcardMatch(h, p);
  return h === p || h.endsWith(`.${p}`);
}

/** PyPI treats `_` and `-` as the same character; fold both for comparison. */
export function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

export function sdkEntryMatches(packageName: string, entry: ShadowCatalogEntry): boolean {
  if (entry.kind !== "sdk") return false;
  const n = normalizePackageName(packageName);
  if (!n) return false;
  const p = normalizePackageName(entry.pattern);
  if (p.endsWith("*")) return n.startsWith(p.slice(0, -1)) && n.length > p.length - 1;
  return n === p;
}

/**
 * MOST SPECIFIC WINS, deterministically — the ADR-0055 rule restated here so a
 * host matched by both `perplexity.ai` and `api.perplexity.ai` reports the
 * API entry regardless of catalogue order. Ties break on literal length, then
 * id, so the same input always reports the same entry.
 */
export function matchCatalogEndpoint(
  host: string,
  catalog: ReadonlyArray<ShadowCatalogEntry> = SHADOW_AI_CATALOG_V1,
): ShadowCatalogEntry | null {
  const hits = catalog
    .filter((e) => endpointEntryMatches(host, e))
    .sort((a, b) => literalLength(b.pattern) - literalLength(a.pattern) || a.id.localeCompare(b.id));
  return hits[0] ?? null;
}

export function matchCatalogPackage(
  packageName: string,
  catalog: ReadonlyArray<ShadowCatalogEntry> = SHADOW_AI_CATALOG_V1,
): ShadowCatalogEntry | null {
  const hits = catalog
    .filter((e) => sdkEntryMatches(packageName, e))
    .sort((a, b) => literalLength(b.pattern) - literalLength(a.pattern) || a.id.localeCompare(b.id));
  return hits[0] ?? null;
}

// ===========================================================================
// 3. EXTRACTION — generic, attribution-free, and it says so
// ===========================================================================

export const SHADOW_DISCOVERY_SOURCE_KINDS = [
  "dns_log",
  "proxy_log",
  "package_json",
  "requirements_txt",
  "go_mod",
] as const;
export type ShadowDiscoverySourceKind = (typeof SHADOW_DISCOVERY_SOURCE_KINDS)[number];

/** thrown when a manifest is unreadable AS A WHOLE (not-JSON package.json) */
export class DiscoveryParseError extends Error {
  readonly code = "unreadable_discovery_input";
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryParseError";
  }
}

/** characters trimmed off a log token's edges before it is tried as a host */
const EDGE_PUNCT = new Set(["(", ")", "[", "]", "{", "}", '"', "'", ",", ";", "<", ">", "=", "|"]);

const trimEdges = (token: string): string => {
  let s = token;
  while (s.length > 0 && EDGE_PUNCT.has(s[0]!)) s = s.slice(1);
  while (s.length > 0 && (EDGE_PUNCT.has(s[s.length - 1]!) || s.endsWith(":"))) {
    s = s.endsWith(":") ? s.slice(0, -1) : s.slice(0, -1);
  }
  return s;
};

const looksLikeIpv4 = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/**
 * Pull the host-shaped tokens out of ONE log line — generic on purpose. This
 * is the honest floor for "a DNS/proxy log in whatever shape you have": it
 * finds every dotted name on the line and attributes NOTHING (for attributed,
 * per-row evidence use the ADR-0071 format adapters, which parse real
 * grammars). Bare IPs are skipped: an IP identifies no provider.
 */
export function extractHostCandidatesFromLine(line: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawToken of line.split(/\s+/)) {
    const token = trimEdges(rawToken);
    if (token.length < 4 || token.length > 2048) continue;
    const host = normalizeEvidenceHost(token);
    if (!host) continue;
    if (!host.includes(".")) continue;
    if (looksLikeIpv4(host)) continue;
    // a host has at least one letter — pure digit/dot tokens are versions/ids
    if (!/[a-z]/.test(host)) continue;
    if (!seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

export interface ManifestEntry {
  name: string;
  /** where in the manifest it sat — provenance for the operator, nothing more */
  origin: string;
}

const PKG_JSON_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export function parsePackageJsonManifest(content: string): ManifestEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    throw new DiscoveryParseError("this is not a JSON document — a package.json manifest must parse as JSON");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new DiscoveryParseError("a package.json manifest is a JSON object with dependency sections");
  }
  const out: ManifestEntry[] = [];
  for (const section of PKG_JSON_SECTIONS) {
    const deps = (doc as Record<string, unknown>)[section];
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (name.length > 0 && name.length <= 214) out.push({ name, origin: section });
    }
  }
  return out;
}

/** the first character that ends a requirements.txt package name */
const REQ_NAME_END = /[=<>!~;@\s[]/;

export function parseRequirementsManifest(content: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    // option lines (-r other.txt, --index-url …) declare no dependency
    if (line.startsWith("-")) continue;
    const hash = line.indexOf(" #");
    if (hash !== -1) line = line.slice(0, hash).trim();
    const end = line.search(REQ_NAME_END);
    const name = (end === -1 ? line : line.slice(0, end)).trim();
    if (name.length > 0 && name.length <= 214 && /^[a-zA-Z0-9._-]+$/.test(name)) {
      out.push({ name, origin: `line ${i + 1}` });
    }
  }
  return out;
}

export function parseGoModManifest(content: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const lines = content.split(/\r?\n/);
  let inRequireBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    const comment = line.indexOf("//");
    if (comment !== -1) line = line.slice(0, comment).trim();
    if (!line) continue;
    if (inRequireBlock) {
      if (line === ")") {
        inRequireBlock = false;
        continue;
      }
      const name = line.split(/\s+/)[0]!;
      if (name.length <= 300) out.push({ name, origin: `line ${i + 1}` });
      continue;
    }
    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (line.startsWith("require ")) {
      const rest = line.slice("require ".length).trim();
      if (rest === "(") {
        inRequireBlock = true;
        continue;
      }
      const name = rest.split(/\s+/)[0]!;
      if (name && name.length <= 300) out.push({ name, origin: `line ${i + 1}` });
    }
  }
  return out;
}

// ===========================================================================
// 4. CLASSIFICATION — matched / governed_via_gateway / unmatched
// ===========================================================================

export const SHADOW_DISCOVERY_CLASSES = ["shadow", "governed_via_gateway", "unmatched"] as const;
export type ShadowDiscoveryClass = (typeof SHADOW_DISCOVERY_CLASSES)[number];

export interface DiscoveryCandidate {
  /** the normalized host or (folded) package name */
  value: string;
  kind: ShadowCatalogKind;
  classification: ShadowDiscoveryClass;
  /** the compiled-catalogue entry that matched, when one did */
  entryId: string | null;
  provider: string | null;
  /** why this hit is NOT shadow — which gateway configuration fronts the host */
  governedReason: string | null;
  /** log kinds: lines that named it. Manifest kinds: entries that declared it. */
  occurrences: number;
  /** manifest kinds only — the sections/lines it came from, bounded */
  origins: string[];
}

export interface DiscoveryClassification {
  sourceKind: ShadowDiscoverySourceKind;
  catalogVersion: number;
  /** distinct hosts / packages seen, before classification */
  candidateCount: number;
  linesScanned: number;
  shadow: DiscoveryCandidate[];
  governed: DiscoveryCandidate[];
  unmatchedCount: number;
  unmatchedOccurrences: number;
  /** a bounded taste of what did NOT match, so "0 findings" is inspectable */
  unmatchedSample: string[];
}

export const DISCOVERY_MAX_BYTES = EVIDENCE_MAX_BYTES;
const UNMATCHED_SAMPLE_MAX = 20;
const ORIGINS_MAX = 5;

/**
 * THE CLASSIFIER. Pure: (text, compiled catalogue, governed hosts) in,
 * classification out. `governedHosts` is the deployment's OWN answer to "which
 * hosts does this gateway legitimately front" (model credentials, env-key
 * providers, custom providers) mapped to a human reason — computed by the
 * caller from live configuration, never by this module, and never guessed.
 *
 * The governed check is THE honest core: a DNS hit on api.anthropic.com in a
 * deployment whose gateway dispatches to api.anthropic.com is expected
 * background, and filing it as a shadow finding would MANUFACTURE findings.
 * It is also, deliberately, a weaker claim than it sounds — the label means
 * "this host is one the gateway is configured to reach; the log line cannot
 * tell gateway traffic from a rogue laptop's", and the reason string says so.
 *
 * A governed CUSTOM host (an in-house vLLM the compiled catalogue has never
 * heard of) is still labelled governed_via_gateway: the deployment's own
 * configuration recognises it even though the frozen catalogue cannot.
 */
export function classifyDiscoveryContent(input: {
  sourceKind: ShadowDiscoverySourceKind;
  content: string;
  governedHosts: ReadonlyMap<string, string>;
  catalog?: ReadonlyArray<ShadowCatalogEntry>;
}): DiscoveryClassification {
  const catalog = input.catalog ?? SHADOW_AI_CATALOG_V1;
  const byValue = new Map<string, DiscoveryCandidate>();
  let linesScanned = 0;

  const record = (
    value: string,
    kind: ShadowCatalogKind,
    entry: ShadowCatalogEntry | null,
    governedReason: string | null,
    origin: string | null,
  ) => {
    const existing = byValue.get(value);
    if (existing) {
      existing.occurrences += 1;
      if (origin && existing.origins.length < ORIGINS_MAX && !existing.origins.includes(origin)) {
        existing.origins.push(origin);
      }
      return;
    }
    byValue.set(value, {
      value,
      kind,
      classification: governedReason ? "governed_via_gateway" : entry ? "shadow" : "unmatched",
      entryId: entry?.id ?? null,
      provider: entry?.provider ?? null,
      governedReason,
      occurrences: 1,
      origins: origin ? [origin] : [],
    });
  };

  if (input.sourceKind === "dns_log" || input.sourceKind === "proxy_log") {
    for (const line of input.content.split(/\r?\n/)) {
      linesScanned += 1;
      for (const host of extractHostCandidatesFromLine(line)) {
        const entry = matchCatalogEndpoint(host, catalog);
        const governedReason = input.governedHosts.get(host) ?? null;
        // an unrecognised, ungoverned host: counted, sampled, never listed in full
        record(host, "endpoint", entry, governedReason, null);
      }
    }
  } else {
    const entries =
      input.sourceKind === "package_json"
        ? parsePackageJsonManifest(input.content)
        : input.sourceKind === "requirements_txt"
          ? parseRequirementsManifest(input.content)
          : parseGoModManifest(input.content);
    linesScanned = input.content.split(/\r?\n/).length;
    for (const dep of entries) {
      const entry = matchCatalogPackage(dep.name, catalog);
      // an SDK is NEVER labelled governed: a manifest cannot say whether the
      // dependency is pointed at this gateway's compat endpoint or straight at
      // the vendor — the undecidable case stays shadow and the ADR says why
      record(normalizePackageName(dep.name), "sdk", entry, null, dep.origin);
    }
  }

  const all = [...byValue.values()];
  const shadow = all
    .filter((c) => c.classification === "shadow")
    .sort((a, b) => b.occurrences - a.occurrences || a.value.localeCompare(b.value));
  const governed = all
    .filter((c) => c.classification === "governed_via_gateway")
    .sort((a, b) => b.occurrences - a.occurrences || a.value.localeCompare(b.value));
  const unmatched = all.filter((c) => c.classification === "unmatched");

  return {
    sourceKind: input.sourceKind,
    catalogVersion: SHADOW_AI_CATALOG_VERSION,
    candidateCount: all.length,
    linesScanned,
    shadow,
    governed,
    unmatchedCount: unmatched.length,
    unmatchedOccurrences: unmatched.reduce((n, c) => n + c.occurrences, 0),
    unmatchedSample: unmatched
      .sort((a, b) => b.occurrences - a.occurrences || a.value.localeCompare(b.value))
      .slice(0, UNMATCHED_SAMPLE_MAX)
      .map((c) => c.value),
  };
}
