/**
 * ADR-0251 (P-01 remainder) — the admin request shapes for the governed core's resource rules:
 * `resource_approval_rules` (model, connector and A2A calls) and `resource_rate_limits` (connector and A2A calls).
 *
 * One subject dimension (the `approval_rules` scope discriminant: user, role, team or fleet) and one resource
 * binding: the resource type plus an optional resource id (null = every resource of that type). The checks mirror the
 * tables' CHECK constraints so a bad body is a 400 with a field path, never a database error.
 */
import { z } from "zod";

export const RESOURCE_APPROVAL_RULE_TYPES = ["model", "connector", "a2a"] as const;
export const RESOURCE_RATE_LIMIT_TYPES = ["connector", "a2a"] as const;
export const RESOURCE_RULE_SCOPES = ["user", "role", "team", "fleet"] as const;
/** the bounds of `resource_rate_limits` (its CHECK constraints) */
export const RESOURCE_RATE_LIMIT_MAX_CALLS = 1_000_000;
export const RESOURCE_RATE_LIMIT_MAX_WINDOW_SECONDS = 30 * 24 * 3600;
/** a list page is bounded (ADR-0200: scalable APIs are bounded and paginated) */
export const RESOURCE_RULES_PAGE_MAX = 200;

const subjectFields = {
  scope: z.enum(RESOURCE_RULE_SCOPES).default("user"),
  userId: z.string().uuid().nullable().optional(),
  roleId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
};

function refineSubject(
  body: {
    scope: (typeof RESOURCE_RULE_SCOPES)[number];
    userId?: string | null | undefined;
    roleId?: string | null | undefined;
    teamId?: string | null | undefined;
  },
  ctx: z.RefinementCtx,
) {
  const set = { user: !!body.userId, role: !!body.roleId, team: !!body.teamId };
  for (const k of ["user", "role", "team"] as const) {
    if (body.scope === k && !set[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `scope '${k}' requires a ${k}Id`, path: [`${k}Id`] });
    if (body.scope !== k && set[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `scope '${body.scope}' takes no ${k}Id`, path: [`${k}Id`] });
  }
}

export const createResourceApprovalRuleSchema = z
  .object({
    ...subjectFields,
    resourceType: z.enum(RESOURCE_APPROVAL_RULE_TYPES),
    /** the model (agent), connector or remote agent; null or absent = every resource of the type */
    resourceId: z.string().uuid().nullable().optional(),
    writeOnly: z.boolean().default(false),
    approverUserId: z.string().uuid(),
  })
  .strict()
  .superRefine((b, ctx) => {
    refineSubject(b, ctx);
    // a model call never writes, so a write-only model rule could never bind: refuse it rather than store a no-op
    if (b.resourceType === "model" && b.writeOnly) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a model call is never a write: writeOnly cannot be set on a model rule", path: ["writeOnly"] });
    }
  });
export type CreateResourceApprovalRule = z.infer<typeof createResourceApprovalRuleSchema>;

/** what may change on a rule in place; its subject and resource binding are its identity (delete and re-create) */
export const updateResourceApprovalRuleSchema = z
  .object({
    writeOnly: z.boolean().optional(),
    approverUserId: z.string().uuid().optional(),
  })
  .strict()
  .refine((b) => b.writeOnly !== undefined || b.approverUserId !== undefined, { message: "nothing to change" });

export const createResourceRateLimitSchema = z
  .object({
    ...subjectFields,
    resourceType: z.enum(RESOURCE_RATE_LIMIT_TYPES),
    resourceId: z.string().uuid().nullable().optional(),
    maxCalls: z.number().int().min(1).max(RESOURCE_RATE_LIMIT_MAX_CALLS),
    windowSeconds: z.number().int().min(1).max(RESOURCE_RATE_LIMIT_MAX_WINDOW_SECONDS),
  })
  .strict()
  .superRefine(refineSubject);
export type CreateResourceRateLimit = z.infer<typeof createResourceRateLimitSchema>;

export const updateResourceRateLimitSchema = z
  .object({
    maxCalls: z.number().int().min(1).max(RESOURCE_RATE_LIMIT_MAX_CALLS).optional(),
    windowSeconds: z.number().int().min(1).max(RESOURCE_RATE_LIMIT_MAX_WINDOW_SECONDS).optional(),
  })
  .strict()
  .refine((b) => b.maxCalls !== undefined || b.windowSeconds !== undefined, { message: "nothing to change" });

/** keyset pagination: `after` is the last id of the previous page (rules are listed by id) */
export const listResourceRulesQuerySchema = z
  .object({
    resourceType: z.enum(RESOURCE_APPROVAL_RULE_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(RESOURCE_RULES_PAGE_MAX).default(50),
    after: z.string().uuid().optional(),
  })
  .strict();

/**
 * Is a rate-limit change a RELAXATION (a settings_relax step-up)? More calls, or the same calls over a shorter
 * window, lets more through. A change that moves both ways (more calls over a longer window) is compared by rate and
 * by burst: it is a relaxation unless it is no looser on both, so an ambiguous change always takes the step-up.
 */
export function rateLimitChangeRelaxes(
  before: { maxCalls: number; windowSeconds: number },
  after: { maxCalls: number; windowSeconds: number },
): boolean {
  const burstLooser = after.maxCalls > before.maxCalls;
  // rate = calls per second; compare cross-multiplied to stay in integers
  const rateLooser = after.maxCalls * before.windowSeconds > before.maxCalls * after.windowSeconds;
  return burstLooser || rateLooser;
}
