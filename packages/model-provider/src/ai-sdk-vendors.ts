/**
 * ADR-0352 (lane E33, KrakenD parity slice 1) — native adapters for AWS Bedrock,
 * Google Vertex AI, Mistral, Cohere and Alibaba Qwen.
 *
 * Every one of them is the vendor's maintained implementation of the AI SDK
 * provider specification (`@ai-sdk/<vendor>`), driven through the same ADR-0253
 * bridge the Gemini adapter uses. Nothing here decides anything: entitlement,
 * budget, cost attribution, guardrails and audit all run upstream in the one
 * gateway dispatch core (ADR-0251), which only ever sees `ModelDispatchRequest`
 * and `ModelDispatchResult`.
 *
 * THE CREDENTIAL RULE. Each SDK falls back to an AMBIENT credential when none is
 * passed: `AWS_BEARER_TOKEN_BEDROCK` / `AWS_ACCESS_KEY_ID`, `GOOGLE_VERTEX_API_KEY`
 * or Google Application Default Credentials (which can reach the metadata server),
 * `MISTRAL_API_KEY`, `COHERE_API_KEY`, `ALIBABA_API_KEY`. A process-wide credential
 * standing in for the agent's own is exactly what ADR-0181 forbids, so:
 * - the key is always passed explicitly, and an empty one is refused here;
 * - Bedrock SigV4 and Vertex service-account auth are applied by OUR fetch wrapper.
 *   The SDK is handed an inert sentinel API key, so it takes its plain API-key path
 *   and never looks for ambient credentials; the wrapper removes the sentinel header
 *   and signs (AWS SDK signer, `@smithy/signature-v4`) or adds a bearer token minted
 *   from the stored service account (`google-auth-library`, whose token request also
 *   goes through the injected, egress-guarded fetch).
 *
 * THE DESTINATION RULE (ADR-0062). Bedrock endpoints are per region and Vertex
 * service-account endpoints are per project and location, so neither has a compiled
 * default the strict egress posture could adjudicate. Both therefore REQUIRE an
 * explicit `baseUrl` on the credential, which the gateway validates against the
 * egress allow-list like any other typed destination. Deriving the URL from a region
 * inside the secret would send traffic to a host the guard never saw.
 */
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createCohere } from "@ai-sdk/cohere";
import { createVertex } from "@ai-sdk/google-vertex";
import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Usage } from "@ai-sdk/provider";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { createHash } from "node:crypto";
import { JWT } from "google-auth-library";
import {
  collectStream,
  mapAiSdkError,
  toV4Prompt,
  toV4ResponseFormat,
  toV4ToolChoice,
  toV4Tools,
  toolCallsOf,
} from "./ai-sdk-bridge.js";
import {
  DEFAULT_MAX_TOKENS,
  ModelProviderError,
  STREAM_THRESHOLD_TOKENS,
  cacheUsage,
  modelDispatchTimeout,
  reportedModel,
} from "./core.js";
import type { ModelDispatchRequest, ModelDispatchResult, ModelProvider } from "./index.js";

/** The five kinds this module serves (a subset of MODEL_PROVIDER_KINDS). */
export const AI_SDK_VENDOR_KINDS = ["bedrock", "vertex", "mistral", "cohere", "qwen"] as const;
export type AiSdkVendorKind = (typeof AI_SDK_VENDOR_KINDS)[number];

/** Compiled default endpoints (ADR-0062), pinned against the SDKs by a drift test.
 * `null` = no compiled default; the credential must carry an explicit baseUrl. */
export const MISTRAL_DEFAULT_BASE = "https://api.mistral.ai/v1";
export const COHERE_DEFAULT_BASE = "https://api.cohere.com/v2";
export const QWEN_DEFAULT_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
/** Vertex "express mode": the global endpoint an API key reaches. A service account
 * has no compiled default (its URL names a project and a location). */
export const VERTEX_EXPRESS_BASE = "https://aiplatform.googleapis.com/v1/publishers/google";

export const AI_SDK_VENDOR_DEFAULT_BASE: Readonly<Record<AiSdkVendorKind, string | null>> = {
  bedrock: null,
  vertex: VERTEX_EXPRESS_BASE,
  mistral: MISTRAL_DEFAULT_BASE,
  cohere: COHERE_DEFAULT_BASE,
  qwen: QWEN_DEFAULT_BASE,
};

export function isAiSdkVendorKind(kind: string): kind is AiSdkVendorKind {
  return (AI_SDK_VENDOR_KINDS as readonly string[]).includes(kind);
}

/** Handed to an SDK so it takes its API-key path; never leaves this process. */
const SENTINEL_KEY = "regulait-credential-applied-by-fetch";

// ---------------------------------------------------------------------------
// Credential shapes. The stored secret is one string (the encrypted
// `key_ciphertext`), so the structured forms are JSON. Parsing happens at store
// time too (`validateVendorCredential`), so a malformed secret fails when an
// admin types it, not on a user's first call.
// ---------------------------------------------------------------------------

export type BedrockCredential =
  | { kind: "sigv4"; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region?: string }
  | { kind: "api_key"; apiKey: string };

export type VertexCredential =
  | { kind: "service_account"; clientEmail: string; privateKey: string }
  | { kind: "api_key"; apiKey: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseJsonSecret(secret: string, label: string): Record<string, unknown> | null {
  if (!secret.trim().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    // never echo the secret, or a fragment of it, into an error message
    throw new ModelProviderError(`${label} credential looks like JSON but does not parse`);
  }
  if (!isRecord(parsed)) throw new ModelProviderError(`${label} credential JSON must be an object`);
  return parsed;
}

export function parseBedrockCredential(secret: string): BedrockCredential {
  if (!nonEmpty(secret)) throw new ModelProviderError("bedrock requires a credential");
  const json = parseJsonSecret(secret, "bedrock");
  if (!json) return { kind: "api_key", apiKey: secret.trim() };
  if (!nonEmpty(json["accessKeyId"]) || !nonEmpty(json["secretAccessKey"])) {
    throw new ModelProviderError("bedrock SigV4 credential needs accessKeyId and secretAccessKey");
  }
  for (const f of ["sessionToken", "region"] as const) {
    if (json[f] !== undefined && !nonEmpty(json[f])) throw new ModelProviderError(`bedrock credential field '${f}' must be a non-empty string`);
  }
  return {
    kind: "sigv4",
    accessKeyId: json["accessKeyId"],
    secretAccessKey: json["secretAccessKey"],
    ...(nonEmpty(json["sessionToken"]) ? { sessionToken: json["sessionToken"] } : {}),
    ...(nonEmpty(json["region"]) ? { region: json["region"] } : {}),
  };
}

export function parseVertexCredential(secret: string): VertexCredential {
  if (!nonEmpty(secret)) throw new ModelProviderError("vertex requires a credential");
  const json = parseJsonSecret(secret, "vertex");
  if (!json) return { kind: "api_key", apiKey: secret.trim() };
  if (json["type"] !== "service_account" || !nonEmpty(json["client_email"]) || !nonEmpty(json["private_key"])) {
    throw new ModelProviderError("vertex JSON credential must be a service-account key (type, client_email, private_key)");
  }
  return {
    kind: "service_account",
    clientEmail: json["client_email"],
    privateKey: json["private_key"],
    // `token_uri` is deliberately ignored: tokens are always minted at Google's own
    // token endpoint, so a stored key cannot redirect the token request elsewhere
  };
}

/** `bedrock-runtime[-fips].<region>.amazonaws.com[.cn]` → region; null for any other host. */
export function bedrockRegionFromBaseUrl(baseUrl: string): string | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const m = /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host);
  return m ? m[1]! : null;
}

function bedrockRegion(cred: BedrockCredential, baseUrl: string): string {
  const fromUrl = bedrockRegionFromBaseUrl(baseUrl);
  const fromCred = cred.kind === "sigv4" ? cred.region ?? null : null;
  if (fromUrl && fromCred && fromUrl !== fromCred) {
    throw new ModelProviderError(`bedrock credential region '${fromCred}' does not match the baseUrl region '${fromUrl}'`);
  }
  const region = fromUrl ?? fromCred;
  if (!region) {
    throw new ModelProviderError(
      "bedrock needs a region: use a bedrock-runtime.<region>.amazonaws.com baseUrl, or set 'region' in the credential for a private endpoint",
    );
  }
  return region;
}

/**
 * Store-time validation for the five kinds (null = acceptable). The gateway calls
 * this when a platform or user credential is saved; the adapters re-check at
 * dispatch, because rows can predate a rule.
 */
export function validateVendorCredential(kind: string, secret: string, baseUrl: string | null | undefined): string | null {
  try {
    switch (kind) {
      case "bedrock": {
        const cred = parseBedrockCredential(secret);
        if (!baseUrl) return "bedrock requires a baseUrl (the regional bedrock-runtime endpoint or a private endpoint)";
        bedrockRegion(cred, baseUrl);
        return null;
      }
      case "vertex": {
        const cred = parseVertexCredential(secret);
        if (cred.kind === "service_account" && !baseUrl) {
          return "a vertex service-account credential requires a baseUrl naming the project and location";
        }
        return null;
      }
      default:
        return null;
    }
  } catch (err) {
    return err instanceof ModelProviderError ? err.message : "invalid credential";
  }
}

// ---------------------------------------------------------------------------
// Credential-applying fetch wrappers. Each wraps the injected fetch (deadline
// bound, and egress-guarded whenever the destination was overridden), so the
// signed request still goes through every check the gateway arranged.
// ---------------------------------------------------------------------------

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

/** SigV4 with the AWS SDK's own signer. Exported for tests. */
export function sigV4Fetch(
  cred: Extract<BedrockCredential, { kind: "sigv4" }>,
  region: string,
  inner: typeof fetch,
): typeof fetch {
  const signer = new SignatureV4({
    service: "bedrock",
    region,
    credentials: {
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
      ...(cred.sessionToken ? { sessionToken: cred.sessionToken } : {}),
    },
    sha256: Hash.bind(null, "sha256"),
  });
  return async (input, init) => {
    const url = requestUrl(input);
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      // the Converse API sends JSON strings; signing a stream would mean buffering it
      throw new ModelProviderError("bedrock: refusing to sign a non-string request body");
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      if (k !== "authorization") headers[k] = v;
    });
    headers["host"] = url.host;
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    const signed = await signer.sign({
      method: (init?.method ?? "GET").toUpperCase(),
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      path: url.pathname,
      query,
      headers,
      ...(typeof body === "string" ? { body } : {}),
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(signed.headers)) {
      if (k.toLowerCase() !== "host") out.set(k, v);
    }
    return inner(url.href, { ...init, headers: out });
  };
}

/** Access tokens minted from a service account, keyed by a hash of the secret so a
 * token is only ever reused for the credential that minted it (never across users
 * or credentials). Bounded; expired entries are replaced on use. */
const vertexTokens = new Map<string, { token: string; expiresAt: number }>();
const VERTEX_TOKEN_CACHE_MAX = 64;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** test hook */
export function clearVertexTokenCache(): void {
  vertexTokens.clear();
}

async function vertexAccessToken(
  cred: Extract<VertexCredential, { kind: "service_account" }>,
  inner: typeof fetch,
): Promise<string> {
  const key = createHash("sha256").update(`${cred.clientEmail}\n${cred.privateKey}`).digest("hex");
  const hit = vertexTokens.get(key);
  if (hit && hit.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return hit.token;
  const client = new JWT({
    email: cred.clientEmail,
    key: cred.privateKey,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    // the token request goes through the same injected (egress-guarded) fetch
    transporterOptions: { fetchImplementation: inner },
  });
  let token: string | null | undefined;
  let expiry: number | null | undefined;
  try {
    const res = await client.authorize();
    token = res.access_token;
    expiry = res.expiry_date;
  } catch (err) {
    throw new ModelProviderError("vertex: could not mint an access token from the service account", 502, { cause: err });
  }
  if (!token) throw new ModelProviderError("vertex: the token endpoint returned no access token", 502);
  if (vertexTokens.size >= VERTEX_TOKEN_CACHE_MAX) vertexTokens.delete(vertexTokens.keys().next().value!);
  vertexTokens.set(key, { token, expiresAt: expiry ?? Date.now() + 5 * 60_000 });
  return token;
}

function vertexServiceAccountFetch(
  cred: Extract<VertexCredential, { kind: "service_account" }>,
  inner: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("x-goog-api-key");
    headers.set("authorization", `Bearer ${await vertexAccessToken(cred, inner)}`);
    return inner(input, { ...init, headers });
  };
}

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

export interface AiSdkVendorOptions {
  kind: AiSdkVendorKind;
  /** the stored secret: an API key, or the JSON forms documented above */
  apiKey: string;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}

/** Content-filter finishes the SDKs report as `content-filter`. */
function mapStop(unified: string | undefined): ModelDispatchResult["stopReason"] {
  switch (unified) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "refusal";
    case "tool-calls":
      return "tool_use";
    default:
      return "other";
  }
}

function usageOf(u: LanguageModelV4Usage | undefined): ModelDispatchResult["usage"] {
  const reasoning = u?.outputTokens.reasoning;
  return {
    inputTokens: u?.inputTokens.total ?? 0,
    outputTokens: u?.outputTokens.total ?? 0,
    ...(typeof reasoning === "number" && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...cacheUsage(u?.inputTokens.cacheRead, u?.inputTokens.cacheWrite),
  };
}

/**
 * ADR-0175 A4: the model the VENDOR says it served, read from its own response body
 * (or the first streamed event that names one), never the SDK's echo of the request.
 * Mistral and Qwen (OpenAI-compatible) send `model`, Vertex sends `modelVersion`;
 * Bedrock Converse and Cohere v2 chat send none, so theirs is null.
 */
function servedModelOf(kind: AiSdkVendorKind, bodies: unknown[]): string | null {
  const field = kind === "vertex" ? "modelVersion" : kind === "mistral" || kind === "qwen" ? "model" : null;
  if (!field) return null;
  for (const b of bodies) {
    const v = isRecord(b) ? reportedModel(b[field]) : null;
    if (v) return v;
  }
  return null;
}

function buildModel(opts: AiSdkVendorOptions, fetchImpl: typeof fetch): (modelId: string) => LanguageModelV4 {
  const base = opts.baseUrl ? opts.baseUrl.replace(/\/$/, "") : null;
  switch (opts.kind) {
    case "bedrock": {
      if (!base) throw new ModelProviderError("bedrock requires a baseUrl (the regional bedrock-runtime endpoint or a private endpoint)");
      const cred = parseBedrockCredential(opts.apiKey);
      const region = bedrockRegion(cred, base);
      const provider = createAmazonBedrock({
        region,
        baseURL: base,
        // api_key: the real Bedrock API key; sigv4: an inert sentinel our fetch replaces
        apiKey: cred.kind === "api_key" ? cred.apiKey : SENTINEL_KEY,
        fetch: cred.kind === "sigv4" ? sigV4Fetch(cred, region, fetchImpl) : fetchImpl,
      });
      return (id) => provider.languageModel(id);
    }
    case "vertex": {
      const cred = parseVertexCredential(opts.apiKey);
      if (cred.kind === "service_account" && !base) {
        throw new ModelProviderError("a vertex service-account credential requires a baseUrl naming the project and location");
      }
      const provider = createVertex({
        baseURL: base ?? VERTEX_EXPRESS_BASE,
        apiKey: cred.kind === "api_key" ? cred.apiKey : SENTINEL_KEY,
        fetch: cred.kind === "service_account" ? vertexServiceAccountFetch(cred, fetchImpl) : fetchImpl,
      });
      return (id) => provider.languageModel(id);
    }
    case "mistral": {
      const provider = createMistral({ apiKey: opts.apiKey, baseURL: base ?? MISTRAL_DEFAULT_BASE, fetch: fetchImpl });
      return (id) => provider.languageModel(id);
    }
    case "cohere": {
      const provider = createCohere({ apiKey: opts.apiKey, baseURL: base ?? COHERE_DEFAULT_BASE, fetch: fetchImpl });
      return (id) => provider.languageModel(id);
    }
    case "qwen": {
      const provider = createAlibaba({ apiKey: opts.apiKey, baseURL: base ?? QWEN_DEFAULT_BASE, fetch: fetchImpl });
      return (id) => provider.languageModel(id);
    }
  }
}

export class AiSdkVendorProvider implements ModelProvider {
  readonly kind: AiSdkVendorKind;
  private readonly model: (modelId: string) => LanguageModelV4;

  constructor(opts: AiSdkVendorOptions) {
    if (!nonEmpty(opts.apiKey)) throw new ModelProviderError(`${opts.kind} requires an apiKey`);
    this.kind = opts.kind;
    this.model = buildModel(opts, opts.fetchImpl ?? fetch);
  }

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    if (req.thinking) {
      throw new ModelProviderError(
        `${this.kind} dispatch does not support 'thinking': RegulAIt has no verified native mapping for it on this ` +
          "provider yet, and never silently drops a field that changes what the model does",
      );
    }
    const model = this.model(req.model);
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const tools = toV4Tools(req);
    const toolChoice = toV4ToolChoice(req);
    const responseFormat = toV4ResponseFormat(req);
    const options: LanguageModelV4CallOptions = {
      prompt: toV4Prompt(req, { attachments: "placeholder", objectToolInput: true }),
      maxOutputTokens: maxTokens,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(responseFormat ? { responseFormat } : {}),
      // AER-021: one deadline for the whole dispatch, every hop and body read
      abortSignal: AbortSignal.timeout(modelDispatchTimeout()),
    };

    const useStream = req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS;
    let text: string;
    let calls: Array<{ id: string; name: string; arguments: unknown }>;
    let finish: string | undefined;
    let usage: LanguageModelV4Usage | undefined;
    let responseId: string | null;
    let servedModel: string | null;

    if (useStream) {
      const s = await collectStream(model, options, req.onText, this.kind);
      text = s.text;
      calls = toolCallsOf(s.content);
      finish = s.finishUnified;
      usage = s.usage;
      responseId = s.responseId;
      servedModel = servedModelOf(this.kind, s.rawChunks);
    } else {
      let result: Awaited<ReturnType<LanguageModelV4["doGenerate"]>>;
      try {
        result = await model.doGenerate(options);
      } catch (err) {
        throw mapAiSdkError(err, this.kind, "request");
      }
      text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      calls = toolCallsOf(result.content);
      finish = result.finishReason.unified;
      usage = result.usage;
      responseId = result.response?.id ?? null;
      servedModel = servedModelOf(this.kind, [result.response?.body]);
    }

    const refusal = mapStop(finish) === "refusal";
    return {
      // a refusal's content must never be surfaced as an answer
      outputText: refusal ? "" : text,
      stopReason: refusal ? "refusal" : calls.length > 0 ? "tool_use" : mapStop(finish),
      refusal,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      usage: usageOf(usage),
      // ADR-0241: the vendor's own decoded usage block, when the SDK kept it
      ...(usage?.raw !== undefined ? { usageSource: usage.raw } : {}),
      providerMessageId: responseId,
      // ADR-0175 A4: only what the vendor said it served, never the request echoed
      servedModel,
    };
  }
}
