/**
 * ADR-0253 (P29) — the Gemini adapter on `@ai-sdk/google`.
 *
 * It replaces the hand-written raw-fetch adapter (request builder, JSON-Schema →
 * Gemini-Schema translator, SSE parser) with the AI SDK's maintained Google
 * implementation, which also brings what ours lacked: `parametersJsonSchema` (full
 * JSON Schema, so no lossy dialect translation), functionCall/functionResponse ids,
 * Gemini 3 thought-signature replay and long-output continuation.
 *
 * What stays ours, read from the VENDOR'S raw response so nothing downstream moves:
 * - usage: `promptTokenCount` / `candidatesTokenCount` exactly as before, plus the
 *   ADR-0212 modality split (the SDK re-sums tool-use prompt and thought tokens into
 *   its totals; adopting that would change a bill, which is P21's call, not this swap's);
 * - refusal: our SAFETY / PROHIBITED_CONTENT / BLOCKLIST / SPII set and prompt blocks;
 * - served model (ADR-0175 A4): `modelVersion`, which the SDK does not surface;
 * - tool-call ids: `<responseId>-fc-<n>` whenever Gemini sends no id of its own.
 *
 * Security: the key is always passed explicitly. The SDK would otherwise fall back
 * to the ambient `GOOGLE_GENERATIVE_AI_API_KEY`, so an empty key is refused here
 * rather than letting a process-wide credential stand in for the agent's own.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
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
  GOOGLE_DEFAULT_BASE,
  ModelProviderError,
  STREAM_THRESHOLD_TOKENS,
  geminiModality,
  reportedModel,
  type GeminiUsageMetadata,
} from "./core.js";
import type { ModelDispatchRequest, ModelDispatchResult, ModelProvider } from "./index.js";

export interface GoogleAdapterOptions {
  apiKey: string;
  /** override for BYOC/air-gapped bridges; default is the Gemini API */
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}

const REFUSAL_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);
/** ids the SDK mints when Gemini sends none; rewritten to our stable form */
const MINTED = "regulait-minted-";

function mapStop(finish: string | undefined): ModelDispatchResult["stopReason"] {
  if (finish === "STOP") return "end_turn";
  if (finish === "MAX_TOKENS") return "max_tokens";
  if (finish && REFUSAL_FINISH.has(finish)) return "refusal";
  return "other";
}

interface GeminiRaw {
  responseId?: string | undefined;
  modelVersion?: string | undefined;
  promptFeedback?: { blockReason?: string } | null | undefined;
  usageMetadata?: GeminiUsageMetadata | null | undefined;
}

function confirmedBlock(reason: unknown): string | null {
  return typeof reason === "string" && reason && !/^BLOCKE?D?_REASON_UNSPECIFIED$/.test(reason) ? reason : null;
}

export class GoogleProvider implements ModelProvider {
  readonly kind = "google" as const;
  private readonly provider: ReturnType<typeof createGoogleGenerativeAI>;

  constructor(opts: GoogleAdapterOptions) {
    if (!opts.apiKey) throw new ModelProviderError("google requires an apiKey");
    let minted = 0;
    const provider = createGoogleGenerativeAI({
      apiKey: opts.apiKey,
      baseURL: (opts.baseUrl ?? GOOGLE_DEFAULT_BASE).replace(/\/$/, ""),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      generateId: () => `${MINTED}${minted++}`,
    });
    this.provider = provider;
  }

  async dispatch(req: ModelDispatchRequest): Promise<ModelDispatchResult> {
    if (req.thinking) {
      throw new ModelProviderError(
        "google dispatch does not support 'thinking': extended thinking has no native mapping " +
          "on this provider, and RegulAIt never silently drops a field that changes what the model does",
      );
    }
    // an explicit provider instance, never a bare string id (ADR-0253)
    const model = this.provider.languageModel(req.model);
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const tools = toV4Tools(req);
    const toolChoice = toV4ToolChoice(req);
    const responseFormat = toV4ResponseFormat(req);
    const options: LanguageModelV4CallOptions = {
      // pillar-6 `cacheSystem` is a no-op here: generateContent has no per-request
      // ephemeral cache breakpoint, so the systemInstruction is sent unchanged
      prompt: toV4Prompt(req, { attachments: "placeholder", objectToolInput: true }),
      maxOutputTokens: maxTokens,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(responseFormat ? { responseFormat } : {}),
    };

    const useStream = req.onText !== undefined || maxTokens > STREAM_THRESHOLD_TOKENS;
    let text: string;
    let calls: Array<{ id: string; name: string; arguments: unknown }>;
    let finishRaw: string | undefined;
    const raw: GeminiRaw = {};
    let usageMeta: GeminiUsageMetadata | null | undefined;
    let responseId: string | null;

    if (useStream) {
      const s = await collectStream(model, options, req.onText, "google");
      for (const chunk of s.rawChunks as GeminiRaw[]) {
        raw.responseId ??= chunk?.responseId;
        raw.modelVersion ??= reportedModel(chunk?.modelVersion) ?? undefined;
        raw.promptFeedback ??= confirmedBlock(chunk?.promptFeedback?.blockReason) ? chunk.promptFeedback : undefined;
        if (chunk?.usageMetadata) usageMeta = chunk.usageMetadata;
      }
      text = s.text;
      calls = toolCallsOf(s.content);
      finishRaw = s.finishRaw;
      responseId = s.responseId ?? raw.responseId ?? null;
    } else {
      let result: Awaited<ReturnType<LanguageModelV4["doGenerate"]>>;
      try {
        result = await model.doGenerate(options);
      } catch (err) {
        throw mapAiSdkError(err, "google", "request");
      }
      const body = (result.response?.body ?? {}) as GeminiRaw;
      raw.modelVersion = reportedModel(body.modelVersion) ?? undefined;
      raw.promptFeedback = body.promptFeedback ?? undefined;
      const meta = (result.providerMetadata?.google ?? {}) as { usageMetadata?: GeminiUsageMetadata | null };
      // the SDK's per-hop sum when Gemini continued a long output, else the body's own block
      usageMeta = meta.usageMetadata ?? body.usageMetadata;
      text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      calls = toolCallsOf(result.content);
      finishRaw = result.finishReason.raw;
      responseId = result.response?.id ?? body.responseId ?? null;
    }

    const toolCalls = calls.map((c, i) => (c.id.startsWith(MINTED) ? { ...c, id: `${responseId ?? "gemini"}-fc-${i}` } : c));
    const blocked = confirmedBlock(raw.promptFeedback?.blockReason) !== null;
    // a prompt block arrives with no candidate, so the SDK reports the block
    // reason as the finish reason; only a real candidate finish counts as one here
    const refusal = blocked || mapStop(finishRaw) === "refusal";
    return {
      // a refusal's content must never be surfaced as an answer
      outputText: refusal ? "" : text,
      stopReason: refusal ? "refusal" : toolCalls.length > 0 ? "tool_use" : mapStop(finishRaw),
      refusal,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage: {
        inputTokens: usageMeta?.promptTokenCount ?? 0,
        outputTokens: usageMeta?.candidatesTokenCount ?? 0,
        ...geminiModality(usageMeta ?? undefined),
      },
      providerMessageId: responseId,
      servedModel: raw.modelVersion ?? null,
    };
  }
}
