/**
 * ADR-0237 — NATIVE ADAPTERS FOR THIRD-PARTY GUARDRAIL PROVIDERS: the gateway half.
 *
 * The pure mapping (request bodies, strict reply parsing, kinds per adapter)
 * lives in `@regulait/shared` `guardrail-vendor-adapters.ts`. This module makes
 * the one HTTP call per scoring request and records it:
 *
 *   - OpenAI Moderation through the official `openai` SDK (Apache-2.0, the
 *     version already pinned for @regulait/model-provider), with the SDK's own
 *     retries off and its `fetch` replaced by the egress-guarded fetch;
 *   - Azure AI Content Safety and Lakera Guard over plain HTTPS through the same
 *     guarded fetch (the Azure REST SDK has had no stable release since
 *     2025-02 and lacks Prompt Shields; Lakera publishes no JavaScript SDK).
 *
 * The guarded fetch is built by `resolveExternalScorersByName`, so the egress
 * allow-list, DNS pinning and the ADR-0062 air-gapped refusal are decided
 * there, before this module is reached, and again inside the fetch per request.
 *
 * Every call writes a `usage_events` row (pillar 5: `object_type`
 * 'guardrail_scorer', the scorer's flat price on success, null on failure) and
 * an `audit_log` row. Neither carries the scanned text, the reply body, or the
 * credential.
 */

import OpenAiSdk from "openai";
import { auditLog, usageEvents, type Db, type ExternalScorerRow } from "@regulait/db";
import {
  buildVendorHttpRequest,
  isGuardrailScorerKind,
  parseVendorReply,
  VENDOR_ADAPTER_PROVIDER,
  VENDOR_MAX_TEXT_CHARS,
  OPENAI_MODERATION_DEFAULT_MODEL,
  type ExternalScorerVerdict,
  type GuardrailScorerKind,
  type VendorScoreInput,
  type VendorScorerAdapter,
} from "@regulait/shared";
import { egressRefusal } from "./egress-guard.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** who a vendor call is attributed to (pillar 5) */
export interface VendorCallAttribution {
  userId: string | null;
  projectId: string | null;
  /** where the call came from: the enforcement phase, or the admin connection test */
  source: "guardrail_input" | "guardrail_output" | "connection_test";
}

export class VendorScorerError extends Error {
  constructor(
    message: string,
    /** a short, content-free class for the audit row */
    readonly errorClass: "egress_refused" | "timeout" | "http_error" | "non_conforming" | "too_long" | "network",
  ) {
    super(message);
    this.name = "VendorScorerError";
  }
}

function isTimeout(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur; i += 1) {
    if (cur instanceof Error && (cur.name === "TimeoutError" || cur.name === "AbortError" || cur.name === "APIConnectionTimeoutError")) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function rethrow(row: ExternalScorerRow, err: unknown, timeoutMs: number): never {
  if (err instanceof VendorScorerError) throw err;
  const refusal = egressRefusal(err) ?? egressRefusal((err as { cause?: unknown })?.cause);
  if (refusal) throw new VendorScorerError(refusal, "egress_refused");
  if (isTimeout(err)) throw new VendorScorerError(`external scorer '${row.name}' timed out after ${timeoutMs}ms`, "timeout");
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    throw new VendorScorerError(`external scorer '${row.name}' returned HTTP ${status}`, "http_error");
  }
  throw new VendorScorerError(`external scorer '${row.name}' request failed`, "network");
}

async function callOpenAiModeration(
  row: ExternalScorerRow,
  apiKey: string,
  fetchImpl: typeof fetch,
  text: string,
  timeoutMs: number,
): Promise<unknown> {
  const client = new OpenAiSdk({
    apiKey,
    baseURL: row.baseUrl,
    fetch: fetchImpl,
    maxRetries: 0,
    timeout: timeoutMs,
  });
  const model = row.adapterOptions?.model ?? OPENAI_MODERATION_DEFAULT_MODEL;
  return client.moderations.create({ model, input: text });
}

async function callHttps(
  row: ExternalScorerRow,
  adapter: "azure_content_safety" | "lakera_guard",
  apiKey: string,
  fetchImpl: typeof fetch,
  input: VendorScoreInput,
  timeoutMs: number,
): Promise<unknown> {
  const { url, body } = buildVendorHttpRequest(adapter, row.baseUrl, input, row.adapterOptions);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(adapter === "azure_content_safety" ? { "ocp-apim-subscription-key": apiKey } : { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const textBody = await res.text();
  // the reply body is never quoted: it is the vendor's, and an error page can echo the request
  if (!res.ok) throw new VendorScorerError(`external scorer '${row.name}' returned HTTP ${res.status}`, "http_error");
  try {
    return JSON.parse(textBody) as unknown;
  } catch {
    throw new VendorScorerError(`external scorer '${row.name}' reply is not JSON`, "non_conforming");
  }
}

/**
 * ONE vendor call. Throws `VendorScorerError` on any failure; the caller turns
 * that into ADR-0220's fail-closed `trained_unavailable` hit (or a failed
 * connection test). Records spend and audit whatever the outcome.
 */
export async function callVendorScorer(
  db: Db,
  scorer: { row: ExternalScorerRow; apiKey: string | null; fetchImpl: typeof fetch },
  req: { scorerKind: string; phase: "input" | "output"; text: string },
  attribution: VendorCallAttribution,
  timeoutMs: number,
): Promise<ExternalScorerVerdict> {
  const adapter = scorer.row.adapter as VendorScorerAdapter;
  const started = Date.now();
  let verdict: ExternalScorerVerdict | null = null;
  let errorClass: VendorScorerError["errorClass"] | null = null;
  try {
    if (!isGuardrailScorerKind(req.scorerKind)) {
      throw new VendorScorerError(`adapter '${adapter}' serves guardrail kinds only`, "non_conforming");
    }
    const kind: GuardrailScorerKind = req.scorerKind;
    if (!scorer.apiKey) throw new VendorScorerError(`external scorer '${scorer.row.name}' has no API key`, "non_conforming");
    if (req.text.length > VENDOR_MAX_TEXT_CHARS[adapter]) {
      throw new VendorScorerError(
        `text of ${req.text.length} characters is over the ${VENDOR_MAX_TEXT_CHARS[adapter]}-character limit of '${adapter}'`,
        "too_long",
      );
    }
    let reply: unknown;
    try {
      reply =
        adapter === "openai_moderation"
          ? await callOpenAiModeration(scorer.row, scorer.apiKey, scorer.fetchImpl, req.text, timeoutMs)
          : await callHttps(scorer.row, adapter, scorer.apiKey, scorer.fetchImpl, { kind, phase: req.phase, text: req.text }, timeoutMs);
    } catch (err) {
      rethrow(scorer.row, err, timeoutMs);
    }
    const parsed = parseVendorReply(adapter, kind, reply);
    if (!parsed.ok) {
      throw new VendorScorerError(`external scorer '${scorer.row.name}' reply is non-conforming: ${parsed.error}`, "non_conforming");
    }
    verdict = parsed.verdict;
    return verdict;
  } catch (err) {
    errorClass = err instanceof VendorScorerError ? err.errorClass : "network";
    throw err instanceof VendorScorerError ? err : new VendorScorerError(`external scorer '${scorer.row.name}' failed`, "network");
  } finally {
    await recordVendorCall(db, scorer.row, adapter, req.scorerKind, attribution, {
      ok: verdict !== null,
      score: verdict?.score ?? null,
      errorClass,
      latencyMs: Date.now() - started,
    });
  }
}

/** the usage (spend) row and the audit row for one call; content-free by construction */
async function recordVendorCall(
  db: Db,
  row: ExternalScorerRow,
  adapter: VendorScorerAdapter,
  scorerKind: string,
  attribution: VendorCallAttribution,
  outcome: { ok: boolean; score: number | null; errorClass: string | null; latencyMs: number },
): Promise<void> {
  const userId = attribution.userId ?? NIL_UUID;
  await db.insert(usageEvents).values({
    userId,
    objectType: "guardrail_scorer",
    operation: scorerKind,
    provider: VENDOR_ADAPTER_PROVIDER[adapter],
    model: adapter === "openai_moderation" ? (row.adapterOptions?.model ?? OPENAI_MODERATION_DEFAULT_MODEL) : adapter,
    // a failed call is recorded unpriced: whether the vendor billed it is not known here
    costUsd: outcome.ok ? (row.pricePerCallUsd ?? null) : null,
    refusal: false,
    projectId: attribution.projectId,
  });
  await db.insert(auditLog).values({
    userId,
    objectType: "external_scorer",
    objectId: row.id,
    detail: {
      phase: "vendor_call",
      adapter,
      scorer: row.name,
      scorerKind,
      source: attribution.source,
      projectId: attribution.projectId,
      ok: outcome.ok,
      score: outcome.score,
      errorClass: outcome.errorClass,
      latencyMs: outcome.latencyMs,
      priced: outcome.ok && row.pricePerCallUsd != null,
    },
    effect: outcome.ok ? "allow" : "deny",
    ruleId: outcome.ok ? "guardrail-vendor-call" : "guardrail-vendor-call-failed",
    ruleChain: [],
    reason: `${adapter} call for ${scorerKind} via scorer '${row.name}' ${outcome.ok ? "answered" : `failed (${outcome.errorClass})`}`,
  });
}
