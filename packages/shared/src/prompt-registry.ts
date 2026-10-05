/**
 * ADR-0173 batch 2b — the governed prompt registry: request shapes, template
 * variables, and the commit hash. Pure (no db, no clock), so the gateway and
 * its tests compute the same hash and the same variable list.
 *
 * A prompt is versioned as COMMITS. A commit's hash is SHA-256 over the
 * canonical JSON (ADR-0060 `canonicalJson`) of exactly
 * `{template, modelConfig, variables, outputSchema, tools, parent}` under a
 * version tag, so two people committing the same content on the same parent
 * get the same hash, and any change to any of the six changes it. The author
 * and the message are deliberately NOT in the hash: they describe a commit,
 * they are not its content.
 *
 * Variables are written `{{name}}` — double braces, so a JSON example inside a
 * prompt is never mistaken for a variable. The variable list is DERIVED from
 * the template, never typed separately, so it cannot disagree with it.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./audit-chain.js";

export const PROMPT_VISIBILITY_VALUES = ["private", "workspace", "people"] as const;
export type PromptVisibility = (typeof PROMPT_VISIBILITY_VALUES)[number];

/** moving this tag goes through the approvals queue; every other tag moves directly */
export const PROMPT_PROD_TAG = "prod" as const;

export const PROMPT_LIMITS = {
  nameChars: 80,
  descriptionChars: 500,
  templateChars: 50_000,
  variables: 50,
  tools: 32,
  messageChars: 500,
  /** an output schema or a tool's input schema, as serialized JSON */
  schemaChars: 20_000,
  variableValueChars: 20_000,
  sharedPeople: 200,
  /** evaluate mode: each row is one governed call */
  rowsPerEvaluation: 50,
  maxTokens: 32_000,
} as const;

/** version tag of the hash input; changing the field set changes this */
export const PROMPT_COMMIT_HASH_VERSION = "regulait.prompt.v1" as const;

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g;

/** the variables a template uses, in order of first appearance */
export function extractPromptVariables(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(VARIABLE_RE)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** fill a template; refuses (never blanks) a variable with no value */
export function renderPromptTemplate(
  template: string,
  values: Record<string, string>,
): { ok: true; text: string } | { ok: false; missing: string[] } {
  const missing = extractPromptVariables(template).filter((v) => typeof values[v] !== "string");
  if (missing.length) return { ok: false, missing };
  return { ok: true, text: template.replace(VARIABLE_RE, (_m, name: string) => values[name]!) };
}

const jsonSized = (max: number) => (v: unknown) => JSON.stringify(v).length <= max;

/** a JSON Schema object: the shape is checked by the gateway's validator */
export const promptJsonSchemaSchema = z
  .record(z.unknown())
  .refine(jsonSized(PROMPT_LIMITS.schemaChars), { message: `at most ${PROMPT_LIMITS.schemaChars} characters as JSON` });

export const promptToolSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, '_' or '-', at most 64"),
    description: z.string().max(1000).default(""),
    inputSchema: promptJsonSchemaSchema.default({ type: "object", properties: {} }),
  })
  .strict();
export type PromptTool = z.infer<typeof promptToolSchema>;

export const promptToolsSchema = z
  .array(promptToolSchema)
  .max(PROMPT_LIMITS.tools)
  .superRefine((tools, ctx) => {
    const seen = new Set<string>();
    tools.forEach((t, i) => {
      if (seen.has(t.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "name"], message: `duplicate tool '${t.name}'` });
      seen.add(t.name);
    });
  });

/** which governed model binding the prompt is written for, and its limits */
export const promptModelConfigSchema = z
  .object({
    /** a registry agent (model binding); null = not pinned */
    agentId: z.string().uuid().nullable().default(null),
    maxTokens: z.number().int().min(1).max(PROMPT_LIMITS.maxTokens).nullable().default(null),
  })
  .strict();
export type PromptModelConfig = z.infer<typeof promptModelConfigSchema>;

export const promptTemplateSchema = z.string().min(1).max(PROMPT_LIMITS.templateChars);

export const promptNameSchema = z.string().trim().min(1).max(PROMPT_LIMITS.nameChars);

/** a tag name: lower-case, short, so `prod` / `staging` / `canary-2` read the same everywhere */
export const promptTagNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, "lower-case letters, digits, '_' or '-', starting with a letter, at most 32");

export const promptCreateSchema = z
  .object({
    name: promptNameSchema,
    description: z.string().max(PROMPT_LIMITS.descriptionChars).default(""),
    visibility: z.enum(PROMPT_VISIBILITY_VALUES).default("private"),
    sharedUserIds: z.array(z.string().uuid()).max(PROMPT_LIMITS.sharedPeople).default([]),
    projectId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type PromptCreate = z.infer<typeof promptCreateSchema>;

export const promptUpdateSchema = z
  .object({
    name: promptNameSchema.optional(),
    description: z.string().max(PROMPT_LIMITS.descriptionChars).optional(),
    visibility: z.enum(PROMPT_VISIBILITY_VALUES).optional(),
    sharedUserIds: z.array(z.string().uuid()).max(PROMPT_LIMITS.sharedPeople).optional(),
    projectId: z.string().uuid().nullable().optional(),
  })
  .strict();

/** the content of a commit; `variables` is derived from the template */
export const promptCommitContentSchema = z
  .object({
    template: promptTemplateSchema,
    modelConfig: promptModelConfigSchema.default({ agentId: null, maxTokens: null }),
    outputSchema: promptJsonSchemaSchema.nullable().default(null),
    tools: promptToolsSchema.default([]),
  })
  .strict();
export type PromptCommitContent = z.infer<typeof promptCommitContentSchema>;

export const promptCommitCreateSchema = promptCommitContentSchema
  .extend({
    /** the commit this one was edited from; null only for a prompt's first commit */
    parentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    message: z.string().trim().min(1).max(PROMPT_LIMITS.messageChars),
  })
  .strict();
export type PromptCommitCreate = z.infer<typeof promptCommitCreateSchema>;

export const promptTagMoveSchema = z
  .object({
    commitHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** required to move `prod`: the arm's-length approver (never the commit's author) */
    approverUserId: z.string().uuid().optional(),
  })
  .strict();

/** everything the hash covers, in one place */
export interface PromptHashInput {
  template: string;
  modelConfig: PromptModelConfig;
  variables: string[];
  outputSchema: Record<string, unknown> | null;
  tools: PromptTool[];
  parent: string | null;
}

export function promptCommitHash(input: PromptHashInput): string {
  return sha256Hex(
    `${PROMPT_COMMIT_HASH_VERSION}\n${canonicalJson({
      template: input.template,
      modelConfig: { agentId: input.modelConfig.agentId ?? null, maxTokens: input.modelConfig.maxTokens ?? null },
      variables: input.variables,
      outputSchema: input.outputSchema ?? null,
      tools: input.tools,
      parent: input.parent ?? null,
    })}`,
  );
}

/**
 * The binding a `prod` promotion approval is pinned to: the prompt, the tag
 * and the commit hash. The decide hook moves the tag only when the stored
 * binding still equals this digest recomputed from the promotion row.
 */
export function promptPromotionDigest(binding: { promptId: string; tag: string; commitHash: string }): string {
  return sha256Hex(
    `regulait.prompt-promotion.v1\n${canonicalJson({
      promptId: binding.promptId,
      tag: binding.tag,
      commitHash: binding.commitHash,
    })}`,
  );
}

// ---------------------------------------------------------------------------
// playground
// ---------------------------------------------------------------------------

const variableValues = z.record(z.string().max(PROMPT_LIMITS.variableValueChars)).refine(
  (v) => Object.keys(v).length <= PROMPT_LIMITS.variables,
  { message: `at most ${PROMPT_LIMITS.variables} variables` },
);

export const playgroundRunSchema = z
  .object({
    template: promptTemplateSchema,
    variables: variableValues.default({}),
    /** the governed model binding to run on (a registry agent the caller holds) */
    modelAgentId: z.string().uuid(),
    maxTokens: z.number().int().min(1).max(PROMPT_LIMITS.maxTokens).optional(),
    outputSchema: promptJsonSchemaSchema.nullable().default(null),
    tools: promptToolsSchema.default([]),
    projectId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type PlaygroundRun = z.infer<typeof playgroundRunSchema>;

export const playgroundEvaluateSchema = playgroundRunSchema
  .omit({ variables: true })
  .extend({
    /** inline rows: the variables for one call and an optional reference output */
    rows: z
      .array(
        z
          .object({
            inputs: variableValues,
            reference: z.string().max(PROMPT_LIMITS.variableValueChars).nullable().default(null),
          })
          .strict(),
      )
      .max(PROMPT_LIMITS.rowsPerEvaluation)
      .optional(),
    /** an evaluation dataset's cases instead of inline rows (admins only) */
    datasetId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => (v.rows ? 1 : 0) + (v.datasetId ? 1 : 0) === 1, {
    message: "give exactly one of rows or datasetId",
  });
export type PlaygroundEvaluate = z.infer<typeof playgroundEvaluateSchema>;

/**
 * An evaluation case's input as template variables: a JSON object of strings
 * is the variables; anything else is bound to the template's only variable
 * (or to `input` when the template has several or none).
 */
export function caseInputAsVariables(input: string, templateVariables: string[]): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.every(([, v]) => typeof v === "string")) return Object.fromEntries(entries) as Record<string, string>;
    }
  } catch {
    // not JSON: a plain input
  }
  return { [templateVariables.length === 1 ? templateVariables[0]! : "input"]: input };
}
