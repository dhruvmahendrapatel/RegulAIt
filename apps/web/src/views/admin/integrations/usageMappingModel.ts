/**
 * ADR-0241 (P21) — the pure helpers behind the "Usage counts — custom mapping" card: the mapping form's draft and
 * the body it sends, the sample test's body and its per-count table, and the words for each server refusal.
 *
 * The gateway validates every mapping (`validateUsageMapping` in @regulait/model-provider) and is the only judge of
 * a pointer's syntax: these helpers only shape what the admin typed, and the 422's own `errors[]` are shown as sent.
 */
import type { UsageExtractorVersion, UsageField, UsageMapping, UsageSource } from "../../../api/types";

export const USAGE_MAPPING_FORMAT = "regulait.usage-mapping/v1" as const;

/** the gateway's order (USAGE_FIELDS); text in and text out are required */
export const USAGE_FIELDS: readonly UsageField[] = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "imageInputTokens",
  "imageOutputTokens",
  "audioInputTokens",
  "audioOutputTokens",
];
export const REQUIRED_FIELDS: readonly UsageField[] = ["inputTokens", "outputTokens"];

export const FIELD_LABEL: Record<UsageField, string> = {
  inputTokens: "Text in",
  outputTokens: "Text out",
  cacheReadInputTokens: "Cache read",
  cacheCreationInputTokens: "Cache write",
  imageInputTokens: "Image in",
  imageOutputTokens: "Image out",
  audioInputTokens: "Audio in",
  audioOutputTokens: "Audio out",
};

/** the fields shown open in the form; the rest sit under the disclosure with the sum over a list */
export const MAIN_FIELDS: readonly UsageField[] = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "imageInputTokens", "audioInputTokens"];
export const MORE_FIELDS: readonly UsageField[] = ["imageOutputTokens", "audioOutputTokens"];

/** the gateway's sample bound (SAMPLE_MAX_BYTES), for the copy only: the server decides */
export const SAMPLE_MAX_LABEL = "1 MB";

/** one count read as a sum over a list (e.g. usage reported per modality) */
export interface ListDraft {
  field: UsageField | "";
  array: string;
  value: string;
  wherePointer: string;
  equals: string;
}

export interface MappingDraft {
  /** one text box per count: a pointer, or pointers joined by " + " */
  sources: Record<UsageField, string>;
  totalsInclude: "all" | "text_only";
  /**
   * The sums over a list, one per count (review of #744): the gateway allows an `arraySum` on each field, and a
   * per-modality usage list needs one per modality (image in and audio in sum the same list with a different `where`).
   */
  lists: ListDraft[];
}

export const emptyList = (): ListDraft => ({ field: "", array: "", value: "", wherePointer: "", equals: "" });

export function emptyDraft(): MappingDraft {
  return {
    sources: Object.fromEntries(USAGE_FIELDS.map((f) => [f, ""])) as Record<UsageField, string>,
    totalsInclude: "all",
    lists: [emptyList()],
  };
}

const listUsed = (l: ListDraft) => l.field !== "" || [l.array, l.value, l.wherePointer, l.equals].some((x) => x.trim() !== "");

/** a text box's source: empty = not reported; " + " between pointers = their sum; else one pointer, as typed */
export function sourceOf(raw: string): UsageSource | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const terms = text.split(/\s\+\s/).map((t) => t.trim());
  if (terms.length > 1) return { sum: terms };
  return { pointer: text };
}

/** the text a stored source reads as in the form (the inverse of sourceOf for pointers and sums) */
export function sourceText(src: UsageSource | undefined): string {
  if (!src) return "";
  if ("pointer" in src) return src.pointer;
  if ("sum" in src) return src.sum.join(" + ");
  return "";
}

/**
 * The POST body for a new version, or what is missing before it can be sent. Only blanks are caught here (a
 * required count with nothing to read it, an incomplete list sum); everything else is the gateway's 422.
 */
export function buildMapping(draft: MappingDraft): { mapping: UsageMapping } | { errors: string[] } {
  const errors: string[] = [];
  const fields: Partial<Record<UsageField, UsageSource>> = {};
  for (const f of USAGE_FIELDS) {
    const src = sourceOf(draft.sources[f]);
    if (src) fields[f] = src;
  }
  const listFields = new Set<UsageField>();
  draft.lists.forEach((l, i) => {
    if (!listUsed(l)) return;
    const name = draft.lists.filter(listUsed).length > 1 ? `Sum over a list ${i + 1}` : "Sum over a list";
    const before = errors.length;
    if (l.field === "") errors.push(`${name}: choose the count it gives.`);
    if (l.array.trim() === "") errors.push(`${name}: enter the pointer to the list.`);
    if (l.value.trim() === "") errors.push(`${name}: enter the pointer to each entry's value.`);
    const equals = l.equals
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if ((l.wherePointer.trim() === "") !== (equals.length === 0)) {
      errors.push(`${name}: to count only some entries, enter both the pointer and the values it must equal.`);
    }
    if (l.field !== "" && fields[l.field] && !listFields.has(l.field)) errors.push(`${FIELD_LABEL[l.field]} has a pointer and a sum over a list: keep one.`);
    if (l.field !== "" && listFields.has(l.field)) errors.push(`${FIELD_LABEL[l.field]} has two sums over a list: keep one.`);
    if (l.field !== "" && errors.length === before) {
      listFields.add(l.field);
      fields[l.field] = {
        arraySum: {
          array: l.array.trim(),
          value: l.value.trim(),
          ...(equals.length ? { where: { pointer: l.wherePointer.trim(), equals } } : {}),
        },
      };
    }
  });
  for (const f of REQUIRED_FIELDS) if (!fields[f] && !draft.lists.some((l) => l.field === f)) errors.push(`${FIELD_LABEL[f]} is required.`);
  if (errors.length) return { errors };
  return {
    mapping: {
      format: USAGE_MAPPING_FORMAT,
      ...(draft.totalsInclude === "text_only" ? { totalsInclude: "text_only" as const } : {}),
      fields,
    },
  };
}

/** a stored version as a draft, so "New version" can start from the newest one */
export function draftFrom(mapping: UsageMapping | null | undefined): MappingDraft {
  const d = emptyDraft();
  if (!mapping?.fields) return d;
  d.totalsInclude = mapping.totalsInclude === "text_only" ? "text_only" : "all";
  const lists: ListDraft[] = [];
  for (const f of USAGE_FIELDS) {
    const src = mapping.fields[f];
    if (!src) continue;
    if ("arraySum" in src) {
      // every list sum is kept, one row each: none is dropped (a dropped count would test as 0 and go unpriced)
      lists.push({
        field: f,
        array: src.arraySum.array,
        value: src.arraySum.value,
        wherePointer: src.arraySum.where?.pointer ?? "",
        equals: src.arraySum.where?.equals.join(", ") ?? "",
      });
    } else d.sources[f] = sourceText(src);
  }
  if (lists.length) d.lists = lists;
  return d;
}

/** the counts a version maps, in the gateway's order */
export function mappedFields(mapping: UsageMapping | null | undefined): UsageField[] {
  const fields = mapping?.fields ?? {};
  return USAGE_FIELDS.filter((f) => fields[f] !== undefined);
}

/** "Text in, text out, cache read" */
export function fieldsMappedLabel(mapping: UsageMapping | null | undefined): string {
  const words = mappedFields(mapping).map((f, i) => (i === 0 ? FIELD_LABEL[f] : FIELD_LABEL[f].toLowerCase()));
  return words.length ? words.join(", ") : "None";
}

/**
 * The test body: the sample as JSON and the counts the admin says it carries. A blank optional count is left out
 * (the gateway reads it as 0); the two required counts must be given.
 */
export function buildTestBody(
  sampleText: string,
  expectedText: Partial<Record<UsageField, string>>,
  fields: readonly UsageField[],
): { body: { sample: unknown; expected: Partial<Record<UsageField, number>> } } | { error: string } {
  let sample: unknown;
  try {
    sample = JSON.parse(sampleText);
  } catch {
    return { error: "The sample response is not valid JSON." };
  }
  const expected: Partial<Record<UsageField, number>> = {};
  const asked = USAGE_FIELDS.filter((f) => fields.includes(f) || REQUIRED_FIELDS.includes(f));
  for (const f of asked) {
    const typed = (expectedText[f] ?? "").trim();
    // commas only as thousands separators ("1,840"); "1,8,4,0" is not a count
    if (typed.includes(",") && !/^\d{1,3}(,\d{3})+$/.test(typed)) return { error: `${FIELD_LABEL[f]}: a count is a whole number of tokens.` };
    const raw = typed.replaceAll(",", "");
    if (raw === "") {
      if (REQUIRED_FIELDS.includes(f)) return { error: `Enter the ${FIELD_LABEL[f].toLowerCase()} count the sample should give.` };
      continue;
    }
    if (!/^\d{1,13}$/.test(raw) || Number(raw) > 1_000_000_000_000) return { error: `${FIELD_LABEL[f]}: a count is a whole number of tokens.` };
    expected[f] = Number(raw);
  }
  return { body: { sample, expected } };
}

export interface TestRow {
  field: UsageField;
  label: string;
  expected: number;
  /** null when the mapping could not read the sample at all */
  read: number | null;
  match: boolean;
}

/** one row per count that was mapped, expected or read: the test passes only when every one matches exactly */
export function testRows(
  fields: readonly UsageField[],
  expected: Partial<Record<UsageField, number>>,
  extracted: Partial<Record<UsageField, number>> | null,
): TestRow[] {
  return USAGE_FIELDS.filter((f) => fields.includes(f) || (expected[f] ?? 0) !== 0 || (extracted?.[f] ?? 0) !== 0).map((f) => {
    const want = expected[f] ?? 0;
    const read = extracted ? (extracted[f] ?? 0) : null;
    return { field: f, label: FIELD_LABEL[f], expected: want, read, match: read === want };
  });
}

/** a version activates only after its latest test passed; the button says why it cannot, beside it */
export function activation(version: Pick<UsageExtractorVersion, "latestTest">): { allowed: boolean; reason: string | null } {
  return version.latestTest?.passed ? { allowed: true, reason: null } : { allowed: false, reason: "Activates only after its latest test passed" };
}

/**
 * A server refusal from the card's writes, in the card's words; `null` = show the gateway's own sentence. Matched on
 * the gateway's `code` only (review of #744): the activate route also answers `sample_test_required` from its
 * re-check under the row lock, after the step-up was used, so the words never say whether the grant was spent.
 */
export function refusalText(
  code: string | null,
  status: number | null,
  ctx: { version?: number } = {},
): { title: string; body: string } | null {
  if (code === "sample_test_required") {
    return {
      title: "Not activated.",
      body: `${ctx.version !== undefined ? `Version ${ctx.version}'s` : "This version's"} latest test has not passed. Run a passing test, then activate it again.`,
    };
  }
  if (code === "sample_too_large" || status === 413) {
    return { title: "Sample too large.", body: `A sample is at most ${SAMPLE_MAX_LABEL} of JSON.` };
  }
  return null;
}

/** the 422's `errors[]`, as the gateway wrote them */
export function mappingErrors(payload: Record<string, unknown> | null | undefined): string[] {
  const errs = payload?.errors;
  return Array.isArray(errs) ? errs.filter((e): e is string => typeof e === "string") : [];
}

/**
 * The gateway's failure sentence with its field names in the card's words ("expected counts for: outputTokens" reads
 * "expected counts for: text out"), so no raw field name reaches the copy
 */
export function failureText(failure: string | null | undefined): string {
  if (!failure) return "";
  return USAGE_FIELDS.reduce((text, f) => text.replace(new RegExp(`\\b${f}\\b`, "g"), FIELD_LABEL[f].toLowerCase()), failure);
}
