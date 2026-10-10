/**
 * ADR-0189 slice B7 — the checked-in, reviewed INVENTORY OF AI TOOLS IN OUR
 * DEVELOPMENT STACK (PathForward's later-items table), as data.
 *
 * The list lives in `security/ai-dev-stack.json` (watched by `security.yml`'s
 * "security gate or allow-list changed" step, so every change is reviewed as a
 * security change) and is rendered into our own install-scope AI BOM per
 * release (`release-ai-bom.ts`) as CycloneDX `formulation` components: the
 * tools that MADE the release, never components of the running install.
 *
 * Content rules (each a refusal, never a redaction):
 *  - every field is an enum, a boolean, a date, an ADR/PR reference or a short
 *    description drawn from a narrow character set with no `@` and no `:` (so
 *    no email shape and no URL can be written), checked by one flat, anchored,
 *    length-capped character class (CodeQL js/redos, M-074);
 *  - the description also passes the audit scrubber (`scrubAuditText`): no
 *    credential-shaped material;
 *  - tools are described generically by role; the inventory names no vendor,
 *    product or model identifier (owner naming question, B7 report).
 */
import { z } from "zod";
import { scrubAuditText } from "../audit-scrub.js";

export const AI_DEV_STACK_VERSION = "regulait.ai-dev-stack.v1";
export const AI_DEV_STACK_CATEGORIES = ["coding_agent", "review_agent", "code_analysis", "agent_plugin"] as const;
export const AI_DEV_STACK_DEPLOYMENTS = ["hosted", "local", "hosted_and_local"] as const;
export const AI_DEV_STACK_REPO_ACCESS = ["read_write", "read_only", "none"] as const;
export const AI_DEV_STACK_DATA_SHARED = ["source_code", "design_docs", "ci_logs", "pull_request_diffs", "none"] as const;
export const AI_DEV_STACK_OUTPUT_CONTROLS = ["pull_request_review_and_ci", "review_comments_only", "local_only"] as const;
export const AI_DEV_STACK_MAX_TOOLS = 64;
export const AI_DEV_STACK_DESCRIPTION_MAX_CHARS = 400;

/** linear: one anchored, bounded character class each (no nested or overlapping quantifier) */
const TOOL_ID = /^[a-z0-9-]{1,63}$/;
const DESCRIPTION = /^[A-Za-z0-9 ,.;()'/-]{1,400}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ADR_REF = /^ADR-[0-9]{4}$/;
const REVIEW_REF = /^(?:ADR-[0-9]{4}|PR-[0-9]{1,6})$/;

const isDate = (v: string) => v.length === 10 && DATE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00.000Z`)) && new Date(`${v}T00:00:00.000Z`).toISOString().startsWith(v);

export const aiDevStackDateSchema = z.string().max(10).refine(isDate, "a calendar date YYYY-MM-DD");
export const aiDevStackToolSchema = z
  .object({
    id: z.string().max(63).refine((v) => TOOL_ID.test(v) && !v.startsWith("-"), "a lower-case id: letters, digits and '-'"),
    category: z.enum(AI_DEV_STACK_CATEGORIES),
    description: z
      .string()
      .max(AI_DEV_STACK_DESCRIPTION_MAX_CHARS)
      .refine((v) => DESCRIPTION.test(v), "plain text: letters, digits, spaces and , . ; ( ) ' / - only (no '@', no ':', so no email or URL)")
      .refine((v) => scrubAuditText(v) === v, "holds credential-shaped material"),
    deployment: z.enum(AI_DEV_STACK_DEPLOYMENTS),
    /** does the tool send repository content off the developer's machine? */
    networkEgress: z.boolean(),
    repositoryAccess: z.enum(AI_DEV_STACK_REPO_ACCESS),
    dataShared: z
      .array(z.enum(AI_DEV_STACK_DATA_SHARED))
      .min(1)
      .max(AI_DEV_STACK_DATA_SHARED.length)
      .refine((v) => new Set(v).size === v.length, "no duplicates")
      .refine((v) => !v.includes("none") || v.length === 1, "'none' stands alone"),
    outputControl: z.enum(AI_DEV_STACK_OUTPUT_CONTROLS),
    governedBy: z
      .array(z.string().max(8).refine((v) => ADR_REF.test(v), "ADR-NNNN"))
      .max(16)
      .refine((v) => new Set(v).size === v.length, "no duplicates"),
    introducedOn: aiDevStackDateSchema,
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!t.networkEgress && t.dataShared.some((d) => d !== "none")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dataShared"], message: "a tool with no network egress shares no data" });
    }
  });
export type AiDevStackTool = z.infer<typeof aiDevStackToolSchema>;

export const aiDevStackInventorySchema = z
  .object({
    v: z.literal(AI_DEV_STACK_VERSION),
    /** the date of the last review of the whole list */
    reviewedOn: aiDevStackDateSchema,
    /** where the review is recorded */
    reviewRef: z.string().max(12).refine((v) => REVIEW_REF.test(v), "ADR-NNNN or PR-N"),
    tools: z.array(aiDevStackToolSchema).min(1).max(AI_DEV_STACK_MAX_TOOLS),
  })
  .strict()
  .superRefine((inv, ctx) => {
    const seen = new Set<string>();
    inv.tools.forEach((t, i) => {
      if (seen.has(t.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tools", i, "id"], message: "duplicate tool id" });
      seen.add(t.id);
      if (t.introducedOn > inv.reviewedOn) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tools", i, "introducedOn"], message: "introduced after the review date" });
    });
  });
export type AiDevStackInventory = z.infer<typeof aiDevStackInventorySchema>;

/**
 * A zod issue WITHOUT the received value (zod's enum and type messages echo
 * it): our own refinement messages are kept, anything else is its code.
 */
export function bomSafeIssue(i: z.ZodIssue): string {
  return `${i.path.join(".") || "$"}: ${i.code === "custom" ? i.message : i.code}`;
}

export class AiDevStackError extends Error {
  constructor(readonly issues: string[]) {
    // the issue paths and rules only, never the offending value
    super(`ai dev-stack inventory refused: ${issues.slice(0, 8).join("; ")}`);
    this.name = "AiDevStackError";
  }
}

/** parse and validate the checked-in inventory; tools come back sorted by id (input order is not an input) */
export function parseAiDevStackInventory(value: unknown): AiDevStackInventory {
  const r = aiDevStackInventorySchema.safeParse(value);
  if (!r.success) throw new AiDevStackError(r.error.issues.map(bomSafeIssue));
  const tools = [...r.data.tools]
    .map((t) => ({ ...t, dataShared: [...t.dataShared].sort(), governedBy: [...t.governedBy].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...r.data, tools };
}
