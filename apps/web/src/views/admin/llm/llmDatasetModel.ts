/**
 * ADR-0065 — regulAIt-LLM dataset tools, the browser's model: appending rows
 * to an editable dataset version, the dry-run validation, and the shapes the
 * gateway answers with (`apps/gateway/src/regulait-llm.ts`).
 */

/** one corpus row as `rowSchema` accepts it */
export interface CorpusRowInput {
  input: string;
  output?: string | null;
  tags?: string[];
}

export const ROW_LIMITS = { maxRows: 5000, maxChars: 50_000, maxTags: 20, maxTagChars: 64 } as const;

/**
 * JSON Lines to rows, refused here with the line number before anything is
 * sent (a 400 with an array index is a reason nobody can find in their file).
 */
export function parseCorpusRows(text: string): { error: string } | { rows: CorpusRowInput[] } {
  const rows: CorpusRowInput[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const n = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { error: `Line ${n} is not valid JSON.` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `Line ${n} must be a JSON object with an "input".` };
    const r = parsed as Record<string, unknown>;
    if (typeof r.input !== "string" || r.input.length === 0) return { error: `Line ${n} has no "input".` };
    if (r.input.length > ROW_LIMITS.maxChars) return { error: `Line ${n}: "input" is longer than ${ROW_LIMITS.maxChars} characters.` };
    if (r.output !== undefined && r.output !== null && typeof r.output !== "string") return { error: `Line ${n}: "output" must be text or null.` };
    if (typeof r.output === "string" && r.output.length > ROW_LIMITS.maxChars) return { error: `Line ${n}: "output" is longer than ${ROW_LIMITS.maxChars} characters.` };
    let tags: string[] | undefined;
    if (r.tags !== undefined) {
      if (!Array.isArray(r.tags) || r.tags.length > ROW_LIMITS.maxTags || !r.tags.every((t) => typeof t === "string" && t.length >= 1 && t.length <= ROW_LIMITS.maxTagChars))
        return { error: `Line ${n}: "tags" must be at most ${ROW_LIMITS.maxTags} labels of 1 to ${ROW_LIMITS.maxTagChars} characters.` };
      tags = r.tags as string[];
    }
    rows.push({ input: r.input, output: typeof r.output === "string" ? r.output : null, ...(tags ? { tags } : {}) });
    if (rows.length > ROW_LIMITS.maxRows) return { error: `At most ${ROW_LIMITS.maxRows} rows can be added at once.` };
  }
  if (rows.length === 0) return { error: "No rows to add: an empty addition changes nothing." };
  return { rows };
}

export interface ValidateDraft {
  method: string;
  backend: string;
  /** the method's dials, as typed; blank keeps the default */
  dials: Record<string, string>;
  /** vendor $ per million training tokens, blank = unknown */
  price: string;
}

/** `POST /v1/llm/datasets/:id/validate` body */
export function validateBody(d: ValidateDraft, dialKeys: readonly string[]): { error: string } | { body: Record<string, unknown> } {
  if (!d.method) return { error: "Choose a training method." };
  if (!d.backend) return { error: "Choose a backend." };
  const hyperparameters: Record<string, number> = {};
  for (const key of dialKeys) {
    const raw = (d.dials[key] ?? "").trim();
    if (raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: `${key} must be a number.` };
    hyperparameters[key] = n;
  }
  const body: Record<string, unknown> = { method: d.method, backend: d.backend, hyperparameters };
  if (d.price.trim() !== "") {
    const p = Number(d.price);
    if (!Number.isFinite(p) || p < 0 || p > 10_000) return { error: "The price per million training tokens must be from 0 to 10000." };
    body.pricePerMTokUsd = p;
  }
  return { body };
}

/** what the dry run answers */
export interface ValidateResponse {
  validation: { ok: boolean; rowCount: number; charCount: number; checksum: string; errors: string[]; warnings: string[]; labels: string[]; split?: { trainIdx: number[]; evalIdx: number[] } };
  hyperparameters: Record<string, unknown> | null;
  hyperparameterErrors: string[];
  estimatedCostUsd: number | null;
}

/** would a job train on this? Both the corpus and the dials have to pass. */
export function validationVerdict(r: ValidateResponse): { ok: boolean; problems: string[] } {
  const problems = [...r.validation.errors, ...r.hyperparameterErrors.map((e) => `Hyperparameters: ${e}`)];
  return { ok: r.validation.ok && r.hyperparameterErrors.length === 0, problems };
}

/** the dataset/job routes' own refusal codes, in words (pinned to regulait-llm.ts by the test) */
export const LLM_REFUSALS: Readonly<Record<string, string>> = {
  llm_training_disabled: "Custom-model creation is switched off for this organisation, so no rows are accepted. An admin turns it on in organisation settings.",
  unknown_training_dataset: "That dataset no longer exists. Refresh the list.",
  dataset_version_frozen: "A job has already trained on this version, so it is immutable. Mint the next version and add the rows there.",
  training_data_refused: "The ingest scan refused these rows, so nothing was added.",
  unknown_training_job: "That training job no longer exists. Refresh the list.",
  job_not_running: "This job is not running any more, so there is nothing to poll. Refresh the list.",
};
