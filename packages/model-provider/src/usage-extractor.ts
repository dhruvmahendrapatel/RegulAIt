/**
 * ADR-0241 (backlog P21) — the configurable usage extractor.
 *
 * An admin-defined mapping from a provider's decoded response body to the usage counts pillar 5 prices: text input
 * and output, the ADR-0212 image and audio split, and the prompt-cache counts. It lets a new or custom provider be
 * priced without a code change, where today each adapter carries its own extraction.
 *
 * Expressions are RFC 6901 JSON Pointers, resolved by `@hyperjump/json-pointer` (ADR-0176), plus one bounded,
 * declarative array step for providers that report usage as a list keyed by modality (Gemini's
 * `promptTokensDetails`). There is no code, no template language, no regular expression and no recursion over the
 * body: every evaluation visits a fixed, small number of nodes, whatever the mapping or the body says.
 *
 * Design reference only (cited, no code copied): gravitee-io/gravitee-policy-ai-prompt-token-tracking (Apache-2.0),
 * whose custom extractor maps a response to sent/received token counts with JSON pointers. It covers text only; the
 * modality, cache, array-step and consistency parts here are new.
 *
 * Every function in this file is pure. A failure is a value (`{ ok: false, reason }`), never a throw, so the caller
 * decides how to fail closed (ADR-0241: the dispatch keeps the adapter's built-in counts).
 */
import { get as pointerGet, pointerSegments } from "@hyperjump/json-pointer";
import type { ModelDispatchResult } from "./index.js";

export const USAGE_MAPPING_FORMAT = "regulait.usage-mapping/v1" as const;

/** The counts a mapping can produce. inputTokens and outputTokens are required; the rest are optional. */
export const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "imageInputTokens",
  "imageOutputTokens",
  "audioInputTokens",
  "audioOutputTokens",
] as const;
export type UsageField = (typeof USAGE_FIELDS)[number];
const REQUIRED_FIELDS: readonly UsageField[] = ["inputTokens", "outputTokens"];

/** Hard bounds. They are part of the contract (ADR-0241) and the tests pin them. */
export const USAGE_EXTRACTOR_LIMITS = {
  /** the mapping document, as JSON text */
  mappingMaxBytes: 4096,
  pointerMaxLength: 256,
  pointerMaxSegments: 12,
  /** pointers in one `sum` */
  sumMaxTerms: 4,
  /** values in one `where.equals` */
  equalsMaxValues: 8,
  equalsValueMaxLength: 64,
  /** elements of an `arraySum` array that are examined; a longer array is refused, never truncated */
  arrayMaxElements: 256,
  /** the body: nodes visited by the size check, nesting depth, and string characters */
  bodyMaxNodes: 20_000,
  bodyMaxDepth: 64,
  bodyMaxStringChars: 1_048_576,
  /** a count above this is not a token count */
  countMax: 1_000_000_000_000,
} as const;

export type UsageSource =
  | { pointer: string }
  | { sum: string[] }
  | { arraySum: { array: string; value: string; where?: { pointer: string; equals: string[] } } };

export interface UsageMapping {
  format: typeof USAGE_MAPPING_FORMAT;
  /**
   * "all" (the default, as OpenAI and Gemini report): inputTokens/outputTokens already include the image and audio
   * counts, so text is the remainder (ADR-0212). "text_only": the provider reports text totals apart from the
   * modality counts, so the totals priced are text + image + audio.
   */
  totalsInclude?: "all" | "text_only";
  fields: Partial<Record<UsageField, UsageSource>>;
}

export type MappingCheck = { ok: true; mapping: UsageMapping } | { ok: false; errors: string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${at}: unknown key '${k.slice(0, 40)}'`);
}

function checkPointer(p: unknown, at: string, errors: string[]): p is string {
  if (typeof p !== "string") {
    errors.push(`${at}: a JSON pointer string is required`);
    return false;
  }
  if (p.length === 0 || p.length > USAGE_EXTRACTOR_LIMITS.pointerMaxLength) {
    errors.push(`${at}: a pointer is 1 to ${USAGE_EXTRACTOR_LIMITS.pointerMaxLength} characters`);
    return false;
  }
  let segments = 0;
  try {
    // the library validates RFC 6901 syntax (leading '/', '~' escapes only as ~0 and ~1)
    for (const _ of pointerSegments(p)) {
      if (++segments > USAGE_EXTRACTOR_LIMITS.pointerMaxSegments) break;
    }
  } catch {
    errors.push(`${at}: not an RFC 6901 JSON pointer`);
    return false;
  }
  if (segments > USAGE_EXTRACTOR_LIMITS.pointerMaxSegments) {
    errors.push(`${at}: at most ${USAGE_EXTRACTOR_LIMITS.pointerMaxSegments} segments`);
    return false;
  }
  return true;
}

function checkSource(src: unknown, at: string, errors: string[]): boolean {
  if (!isPlainObject(src)) {
    errors.push(`${at}: an object with exactly one of pointer, sum or arraySum is required`);
    return false;
  }
  const kinds = ["pointer", "sum", "arraySum"].filter((k) => k in src);
  if (kinds.length !== 1) {
    errors.push(`${at}: exactly one of pointer, sum or arraySum is required`);
    return false;
  }
  onlyKeys(src, kinds, at, errors);
  const before = errors.length;
  if (kinds[0] === "pointer") checkPointer(src.pointer, `${at}.pointer`, errors);
  else if (kinds[0] === "sum") {
    const terms = src.sum;
    if (!Array.isArray(terms) || terms.length < 1 || terms.length > USAGE_EXTRACTOR_LIMITS.sumMaxTerms) {
      errors.push(`${at}.sum: 1 to ${USAGE_EXTRACTOR_LIMITS.sumMaxTerms} pointers`);
    } else terms.forEach((t, i) => checkPointer(t, `${at}.sum[${i}]`, errors));
  } else {
    const a = src.arraySum;
    if (!isPlainObject(a)) errors.push(`${at}.arraySum: an object is required`);
    else {
      onlyKeys(a, ["array", "value", "where"], `${at}.arraySum`, errors);
      checkPointer(a.array, `${at}.arraySum.array`, errors);
      checkPointer(a.value, `${at}.arraySum.value`, errors);
      if (a.where !== undefined) {
        const w = a.where;
        if (!isPlainObject(w)) errors.push(`${at}.arraySum.where: an object is required`);
        else {
          onlyKeys(w, ["pointer", "equals"], `${at}.arraySum.where`, errors);
          checkPointer(w.pointer, `${at}.arraySum.where.pointer`, errors);
          const eq = w.equals;
          if (
            !Array.isArray(eq) ||
            eq.length < 1 ||
            eq.length > USAGE_EXTRACTOR_LIMITS.equalsMaxValues ||
            !eq.every((s) => typeof s === "string" && s.length >= 1 && s.length <= USAGE_EXTRACTOR_LIMITS.equalsValueMaxLength)
          ) {
            errors.push(
              `${at}.arraySum.where.equals: 1 to ${USAGE_EXTRACTOR_LIMITS.equalsMaxValues} strings of 1 to ` +
                `${USAGE_EXTRACTOR_LIMITS.equalsValueMaxLength} characters`,
            );
          }
        }
      }
    }
  }
  return errors.length === before;
}

/**
 * Validate an untrusted mapping document. Strict: unknown keys, a wrong format tag, an oversized document, a
 * malformed or over-long pointer, or a missing required field are each an error. Errors never echo the input beyond
 * a 40-character key name.
 */
export function validateUsageMapping(input: unknown): MappingCheck {
  const errors: string[] = [];
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    return { ok: false, errors: ["the mapping is not JSON-serialisable"] };
  }
  if (text === undefined || Buffer.byteLength(text, "utf8") > USAGE_EXTRACTOR_LIMITS.mappingMaxBytes) {
    return { ok: false, errors: [`the mapping is at most ${USAGE_EXTRACTOR_LIMITS.mappingMaxBytes} bytes of JSON`] };
  }
  if (!isPlainObject(input)) return { ok: false, errors: ["the mapping is a JSON object"] };
  onlyKeys(input, ["format", "totalsInclude", "fields"], "mapping", errors);
  if (input.format !== USAGE_MAPPING_FORMAT) errors.push(`mapping.format: must be '${USAGE_MAPPING_FORMAT}'`);
  if (input.totalsInclude !== undefined && input.totalsInclude !== "all" && input.totalsInclude !== "text_only") {
    errors.push("mapping.totalsInclude: 'all' or 'text_only'");
  }
  const fields = input.fields;
  if (!isPlainObject(fields)) errors.push("mapping.fields: an object is required");
  else {
    onlyKeys(fields, USAGE_FIELDS, "mapping.fields", errors);
    for (const f of REQUIRED_FIELDS) if (!(f in fields)) errors.push(`mapping.fields.${f}: required`);
    for (const f of USAGE_FIELDS) if (f in fields) checkSource(fields[f], `mapping.fields.${f}`, errors);
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 20) };
  // a structural copy: nothing of the caller's object (prototype, getters) survives into what is stored
  return { ok: true, mapping: JSON.parse(text) as UsageMapping };
}

export type BodyCheck = { ok: true } | { ok: false; reason: string };

/**
 * The input bound. An iterative walk that stops at the first limit crossed, so its cost is bounded by the limits,
 * not by the body. Run before any pointer is evaluated.
 */
export function checkUsageBody(body: unknown): BodyCheck {
  const L = USAGE_EXTRACTOR_LIMITS;
  if (body === undefined) return { ok: false, reason: "no response body to read usage from" };
  if (typeof body !== "object" || body === null) return { ok: false, reason: "the response body is not a JSON object" };
  const stack: Array<{ v: unknown; d: number }> = [{ v: body, d: 0 }];
  let nodes = 0;
  let chars = 0;
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (++nodes > L.bodyMaxNodes) return { ok: false, reason: `the response body has more than ${L.bodyMaxNodes} values` };
    if (d > L.bodyMaxDepth) return { ok: false, reason: `the response body nests deeper than ${L.bodyMaxDepth}` };
    if (typeof v === "string") {
      chars += v.length;
      if (chars > L.bodyMaxStringChars) return { ok: false, reason: `the response body has more than ${L.bodyMaxStringChars} characters of text` };
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push({ v: x, d: d + 1 });
    } else if (typeof v === "object" && v !== null) {
      for (const k of Object.keys(v)) {
        chars += k.length;
        stack.push({ v: (v as Record<string, unknown>)[k], d: d + 1 });
      }
      if (chars > L.bodyMaxStringChars) return { ok: false, reason: `the response body has more than ${L.bodyMaxStringChars} characters of text` };
    }
  }
  return { ok: true };
}

/** the library returns a curried getter when the subject is undefined, so an undefined subject is handled here */
function safeGet(pointer: string, subject: unknown): unknown {
  if (subject === undefined || subject === null || typeof subject !== "object") return undefined;
  try {
    return pointerGet(pointer, subject as never);
  } catch {
    // the library throws when a step crosses a scalar or a missing parent: the value is absent
    return undefined;
  }
}

type Resolved = { ok: true; value: number | undefined } | { ok: false; reason: string };

/** undefined = the pointer names nothing (absent); a present value must be a non-negative safe integer */
function resolveCount(body: unknown, pointer: string, at: string): Resolved {
  const v = safeGet(pointer, body);
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > USAGE_EXTRACTOR_LIMITS.countMax) {
    return { ok: false, reason: `${at}: the value is not a non-negative whole token count` };
  }
  return { ok: true, value: v };
}

function resolveSource(body: unknown, src: UsageSource, at: string): Resolved {
  if ("pointer" in src) return resolveCount(body, src.pointer, at);
  if ("sum" in src) {
    let total: number | undefined;
    for (const p of src.sum) {
      const r = resolveCount(body, p, at);
      if (!r.ok) return r;
      if (r.value !== undefined) total = (total ?? 0) + r.value;
    }
    return { ok: true, value: total };
  }
  const { array, value, where } = src.arraySum;
  const list = safeGet(array, body);
  if (list === undefined || list === null) return { ok: true, value: undefined };
  if (!Array.isArray(list)) return { ok: false, reason: `${at}: arraySum.array does not name an array` };
  if (list.length > USAGE_EXTRACTOR_LIMITS.arrayMaxElements) {
    return { ok: false, reason: `${at}: the array has more than ${USAGE_EXTRACTOR_LIMITS.arrayMaxElements} elements` };
  }
  let total = 0;
  for (const el of list) {
    if (where) {
      const key = safeGet(where.pointer, el);
      if (typeof key !== "string" || !where.equals.includes(key)) continue;
    }
    const r = resolveCount(el, value, at);
    if (!r.ok) return r;
    total += r.value ?? 0;
  }
  return { ok: true, value: total };
}

export type ExtractedUsage = ModelDispatchResult["usage"];
export type Extraction = { ok: true; usage: ExtractedUsage } | { ok: false; reason: string };

/**
 * Apply a VALIDATED mapping to a decoded response body. Fails (as a value) when the body is over a bound, a
 * required count is absent, a value is not a token count, or the modality counts exceed the totals they are part of.
 * The result has the adapters' own shape, so ADR-0212's `priceDispatchUsage` prices it unchanged.
 */
export function extractUsage(mapping: UsageMapping, body: unknown): Extraction {
  const size = checkUsageBody(body);
  if (!size.ok) return size;
  const counts: Partial<Record<UsageField, number>> = {};
  for (const f of USAGE_FIELDS) {
    const src = mapping.fields[f];
    if (!src) continue;
    const r = resolveSource(body, src, f);
    if (!r.ok) return r;
    if (r.value === undefined) {
      if (REQUIRED_FIELDS.includes(f)) return { ok: false, reason: `${f}: the response has no value at the mapped location` };
      continue;
    }
    counts[f] = r.value;
  }
  const image = { inputTokens: counts.imageInputTokens ?? 0, outputTokens: counts.imageOutputTokens ?? 0 };
  const audio = { inputTokens: counts.audioInputTokens ?? 0, outputTokens: counts.audioOutputTokens ?? 0 };
  let inputTokens = counts.inputTokens!;
  let outputTokens = counts.outputTokens!;
  if (mapping.totalsInclude === "text_only") {
    inputTokens += image.inputTokens + audio.inputTokens;
    outputTokens += image.outputTokens + audio.outputTokens;
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) {
      return { ok: false, reason: "the totals overflow" };
    }
  } else if (image.inputTokens + audio.inputTokens > inputTokens || image.outputTokens + audio.outputTokens > outputTokens) {
    // text is the remainder (ADR-0212); a negative remainder means the mapping or the response is wrong
    return { ok: false, reason: "the image and audio counts exceed the totals they are part of" };
  }
  const modality: NonNullable<ExtractedUsage["modality"]> = {};
  if (image.inputTokens > 0 || image.outputTokens > 0) modality.image = image;
  if (audio.inputTokens > 0 || audio.outputTokens > 0) modality.audio = audio;
  return {
    ok: true,
    usage: {
      inputTokens,
      outputTokens,
      ...(counts.cacheReadInputTokens ? { cacheReadInputTokens: counts.cacheReadInputTokens } : {}),
      ...(counts.cacheCreationInputTokens ? { cacheCreationInputTokens: counts.cacheCreationInputTokens } : {}),
      ...(modality.image || modality.audio ? { modality } : {}),
    },
  };
}
