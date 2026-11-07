/**
 * ADR-0237 — NATIVE ADAPTERS FOR THIRD-PARTY GUARDRAIL PROVIDERS: the pure half.
 *
 * ADR-0088 published one wire contract (`{input, output, context, scorerKind}`
 * in, `{score, reasons}` out) and told an operator whose vendor speaks another
 * dialect to run a translation shim. ADR-0220 put that shim on the inline
 * guardrail path. This file removes the shim for three widely used providers
 * whose APIs are public and documented, by translating in the gateway:
 *
 *   adapter                 provider API                                   kinds it may claim
 *   openai_moderation       OpenAI Moderation (POST /v1/moderations)        guardrail_harm
 *   azure_content_safety    Azure AI Content Safety text:analyze and        guardrail_harm,
 *                           text:shieldPrompt (api-version 2024-09-01)      guardrail_prompt_injection
 *   lakera_guard            Lakera Guard (POST /v2/guard, breakdown)        guardrail_prompt_injection,
 *                                                                           guardrail_pii, guardrail_harm
 *
 * `regulait` (the default) is the ADR-0088 contract, unchanged.
 *
 * Every adapter reduces the vendor reply to the SAME verdict shape the ADR-0088
 * parser produces, so the ADR-0220 merge, thresholds and fail-closed rules
 * apply unchanged. The rules this file enforces:
 *
 *  1. STRICT PARSING. A reply missing the field the mapping reads is an ERROR,
 *     never a 0. In particular a Lakera breakdown with no detector for the
 *     requested kind is an error: the vendor's policy did not run that check,
 *     and "not run" is not "clean".
 *  2. NO TRUNCATION. Text over the vendor's documented limit takes the failure
 *     path (ADR-0220's rule: a truncated scan would pass what it never read).
 *  3. BARE LABELS ONLY. Reasons are vendor category names normalised to
 *     `^[a-z][a-z0-9_]{0,39}$`; nothing else from the reply survives.
 *  4. GUARDRAIL KINDS ONLY. A vendor adapter cannot claim an evaluation kind,
 *     so the eval path (ADR-0088) never reaches a vendor through this file.
 *
 * Pure: no I/O, no clock, no fetch. The gateway half is
 * `apps/gateway/src/guardrail-vendor-adapters.ts`.
 */

import { z } from "zod";
import type { ExternalScorerVerdict } from "./external-scorer.js";
import type { GuardrailScorerKind } from "./trained-detectors.js";

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export const EXTERNAL_SCORER_ADAPTERS = ["regulait", "openai_moderation", "azure_content_safety", "lakera_guard"] as const;
export type ExternalScorerAdapter = (typeof EXTERNAL_SCORER_ADAPTERS)[number];

export const VENDOR_SCORER_ADAPTERS = ["openai_moderation", "azure_content_safety", "lakera_guard"] as const;
export type VendorScorerAdapter = (typeof VENDOR_SCORER_ADAPTERS)[number];

export function isVendorAdapter(adapter: string): adapter is VendorScorerAdapter {
  return (VENDOR_SCORER_ADAPTERS as readonly string[]).includes(adapter);
}

/** what each vendor adapter can honestly serve; a claim outside it is refused at registration */
export const VENDOR_ADAPTER_KINDS: Record<VendorScorerAdapter, readonly GuardrailScorerKind[]> = {
  openai_moderation: ["guardrail_harm"],
  azure_content_safety: ["guardrail_harm", "guardrail_prompt_injection"],
  lakera_guard: ["guardrail_prompt_injection", "guardrail_pii", "guardrail_harm"],
};

/** the provider name stamped on the usage (cost) row */
export const VENDOR_ADAPTER_PROVIDER: Record<VendorScorerAdapter, string> = {
  openai_moderation: "openai",
  azure_content_safety: "azure",
  lakera_guard: "lakera",
};

export const VENDOR_ADAPTER_LABEL: Record<ExternalScorerAdapter, string> = {
  regulait: "RegulAIt scorer contract",
  openai_moderation: "OpenAI Moderation",
  azure_content_safety: "Azure AI Content Safety",
  lakera_guard: "Lakera Guard",
};

/** documented per-request text limits; longer text fails (fail closed), it is never cut */
export const VENDOR_MAX_TEXT_CHARS: Record<VendorScorerAdapter, number> = {
  // OpenAI documents no character cap; this bound keeps one call well inside the model's context
  openai_moderation: 100_000,
  // text:analyze and text:shieldPrompt both document 10,000 characters per request
  azure_content_safety: 10_000,
  // Lakera chunks long content itself; the ADR-0220 bound applies
  lakera_guard: 256_000,
};

export const AZURE_CONTENT_SAFETY_API_VERSION = "2024-09-01";
export const OPENAI_MODERATION_DEFAULT_MODEL = "omni-moderation-latest";

// ---------------------------------------------------------------------------
// per-adapter options (a schema-validated configuration document)
// ---------------------------------------------------------------------------

const LAKERA_PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OPENAI_MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const vendorAdapterOptionsSchema = z
  .object({
    /** openai_moderation: the moderation model (default omni-moderation-latest) */
    model: z.string().regex(OPENAI_MODEL).optional(),
    /** lakera_guard: the Lakera project whose policy screens the request (absent = Lakera's default policy) */
    projectId: z.string().regex(LAKERA_PROJECT_ID).optional(),
  })
  .strict();
export type VendorAdapterOptions = z.infer<typeof vendorAdapterOptionsSchema>;

/** the option keys each adapter accepts; any other key is refused */
export const VENDOR_ADAPTER_OPTION_KEYS: Record<ExternalScorerAdapter, readonly (keyof VendorAdapterOptions)[]> = {
  regulait: [],
  openai_moderation: ["model"],
  azure_content_safety: [],
  lakera_guard: ["projectId"],
};

/**
 * Registration-time checks for an adapter choice. Returns the refusal reason,
 * or null when the combination is valid. Used by the create and update schemas
 * and by the gateway when a PATCH changes only part of the combination.
 */
export function vendorAdapterRefusal(args: {
  adapter: ExternalScorerAdapter;
  scorerKinds: readonly string[];
  allowPlaintextHttp: boolean;
  options: VendorAdapterOptions | null | undefined;
}): string | null {
  const keys = Object.keys(args.options ?? {});
  const allowed = VENDOR_ADAPTER_OPTION_KEYS[args.adapter];
  const stray = keys.filter((k) => !(allowed as readonly string[]).includes(k));
  if (stray.length > 0) return `adapter '${args.adapter}' does not take option(s) ${stray.join(", ")}`;
  if (!isVendorAdapter(args.adapter)) return null;
  const serves = VENDOR_ADAPTER_KINDS[args.adapter] as readonly string[];
  const outside = args.scorerKinds.filter((k) => !serves.includes(k));
  if (outside.length > 0) {
    return (
      `adapter '${args.adapter}' serves [${serves.join(", ")}] only; it cannot claim [${outside.join(", ")}]. ` +
      "A third-party guardrail adapter serves guardrail kinds, never an evaluation metric."
    );
  }
  if (args.allowPlaintextHttp) return `adapter '${args.adapter}' calls a vendor API over HTTPS only`;
  return null;
}

// ---------------------------------------------------------------------------
// request building
// ---------------------------------------------------------------------------

export interface VendorScoreInput {
  kind: GuardrailScorerKind;
  /** which side of the call the text is: input is the prompt or tool arguments, output the reply */
  phase: "input" | "output";
  text: string;
}

export interface VendorHttpRequest {
  /** path appended to the scorer's base URL (with its query string) */
  path: string;
  body: Record<string, unknown>;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** Azure and Lakera are called over plain HTTPS; the full URL and body for one call */
export function buildVendorHttpRequest(
  adapter: "azure_content_safety" | "lakera_guard",
  baseUrl: string,
  input: VendorScoreInput,
  options: VendorAdapterOptions | null | undefined,
): { url: string; body: Record<string, unknown> } {
  if (adapter === "azure_content_safety") {
    const q = `?api-version=${AZURE_CONTENT_SAFETY_API_VERSION}`;
    if (input.kind === "guardrail_prompt_injection") {
      return { url: joinUrl(baseUrl, `/contentsafety/text:shieldPrompt${q}`), body: { userPrompt: input.text, documents: [] } };
    }
    return { url: joinUrl(baseUrl, `/contentsafety/text:analyze${q}`), body: { text: input.text, outputType: "EightSeverityLevels" } };
  }
  return {
    url: joinUrl(baseUrl, "/v2/guard"),
    body: {
      messages: [{ role: input.phase === "output" ? "assistant" : "user", content: input.text }],
      breakdown: true,
      ...(options?.projectId ? { project_id: options.projectId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// response parsing
// ---------------------------------------------------------------------------

export type VendorParseResult = { ok: true; verdict: ExternalScorerVerdict } | { ok: false; error: string };

const BARE = /^[a-z][a-z0-9_]{0,39}$/;

/** a vendor category name as a bare label (`harassment/threatening` -> `harassment_threatening`), or null */
export function vendorLabel(raw: string): string | null {
  const label = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return BARE.test(label) ? label : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function labels(raw: readonly string[]): string[] {
  return [...new Set(raw.map(vendorLabel).filter((l): l is string => l !== null))].slice(0, 20);
}

/** OpenAI Moderation: score = the highest category score; reasons = the flagged categories */
export function parseOpenAiModeration(reply: unknown): VendorParseResult {
  const result = obj(Array.isArray(obj(reply)?.results) ? (obj(reply)!.results as unknown[])[0] : null);
  if (!result) return { ok: false, error: "moderation reply has no results[0]" };
  const scores = obj(result.category_scores);
  if (!scores) return { ok: false, error: "moderation reply has no category_scores" };
  const values = Object.values(scores);
  if (values.length === 0 || values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
    return { ok: false, error: "moderation category_scores are not numbers in [0,1]" };
  }
  const flagged = obj(result.categories) ?? {};
  return {
    ok: true,
    verdict: {
      score: Math.max(...(values as number[])),
      reasons: labels(Object.entries(flagged).filter(([, v]) => v === true).map(([k]) => k)),
    },
  };
}

/** Azure text:analyze (eight severity levels, 0..7): score = highest severity / 7 */
export function parseAzureAnalyze(reply: unknown): VendorParseResult {
  const cats = obj(reply)?.categoriesAnalysis;
  if (!Array.isArray(cats) || cats.length === 0) return { ok: false, error: "analyze reply has no categoriesAnalysis" };
  const rows: Array<{ category: string; severity: number }> = [];
  for (const c of cats) {
    const o = obj(c);
    if (!o || typeof o.category !== "string" || typeof o.severity !== "number" || !Number.isInteger(o.severity) || o.severity < 0 || o.severity > 7) {
      return { ok: false, error: "analyze categoriesAnalysis entry is not {category, severity 0..7}" };
    }
    rows.push({ category: o.category, severity: o.severity });
  }
  return {
    ok: true,
    verdict: {
      score: Math.max(...rows.map((r) => r.severity)) / 7,
      reasons: labels(rows.filter((r) => r.severity > 0).map((r) => r.category)),
    },
  };
}

/** Azure text:shieldPrompt: score 1 when a user-prompt attack is detected, else 0 */
export function parseAzureShieldPrompt(reply: unknown): VendorParseResult {
  const detected = obj(obj(reply)?.userPromptAnalysis)?.attackDetected;
  if (typeof detected !== "boolean") return { ok: false, error: "shieldPrompt reply has no userPromptAnalysis.attackDetected" };
  return { ok: true, verdict: { score: detected ? 1 : 0, reasons: detected ? ["user_prompt_attack"] : [] } };
}

/** which Lakera `detector_type` values answer each guardrail kind */
const LAKERA_PREFIX: Record<GuardrailScorerKind, readonly string[]> = {
  guardrail_prompt_injection: ["prompt_attack"],
  guardrail_pii: ["pii"],
  guardrail_harm: ["moderated_content"],
};

function lakeraMatches(detectorType: string, kind: GuardrailScorerKind): boolean {
  return LAKERA_PREFIX[kind].some((p) => detectorType === p || detectorType.startsWith(`${p}/`));
}

/**
 * Lakera Guard with `breakdown: true`: score 1 when any detector for the kind
 * detected, else 0. Reads the per-detector `detected`, which the project's
 * detect/enforce mode does not change, never the top-level `flagged`, which a
 * project in detect mode forces to false.
 */
export function parseLakeraGuard(reply: unknown, kind: GuardrailScorerKind): VendorParseResult {
  const breakdown = obj(reply)?.breakdown;
  if (!Array.isArray(breakdown)) return { ok: false, error: "guard reply has no breakdown" };
  const relevant: Array<{ type: string; detected: boolean }> = [];
  for (const b of breakdown) {
    const o = obj(b);
    if (!o || typeof o.detector_type !== "string") continue;
    if (!lakeraMatches(o.detector_type, kind)) continue;
    if (typeof o.detected !== "boolean") return { ok: false, error: "guard breakdown entry has no boolean detected" };
    relevant.push({ type: o.detector_type, detected: o.detected });
  }
  if (relevant.length === 0) {
    return {
      ok: false,
      error: `the Lakera policy ran no ${LAKERA_PREFIX[kind].join("/")} detector — not run is not clean`,
    };
  }
  const hits = relevant.filter((r) => r.detected);
  return { ok: true, verdict: { score: hits.length > 0 ? 1 : 0, reasons: labels(hits.map((h) => h.type)) } };
}

/** the parser for one (adapter, kind) pair */
export function parseVendorReply(adapter: VendorScorerAdapter, kind: GuardrailScorerKind, reply: unknown): VendorParseResult {
  if (adapter === "openai_moderation") return parseOpenAiModeration(reply);
  if (adapter === "azure_content_safety") {
    return kind === "guardrail_prompt_injection" ? parseAzureShieldPrompt(reply) : parseAzureAnalyze(reply);
  }
  return parseLakeraGuard(reply, kind);
}

/** the one sentence shown wherever a vendor adapter is offered */
export const VENDOR_ADAPTER_DISCLOSURE =
  "A third-party guardrail adapter sends the scanned text to that vendor's API. It is off until an admin " +
  "registers it, passes its connection test and enables it with step-up; an air-gapped deployment refuses it. " +
  "Each call is audited (no text) and recorded as spend, and a failed call fails closed.";
