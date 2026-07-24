import { z } from "zod";

export const toolKindSchema = z.enum(["read", "write"]);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const decisionEffectSchema = z.enum(["allow", "deny"]);
export type DecisionEffect = z.infer<typeof decisionEffectSchema>;

export const evaluateRequestSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
});
export type EvaluateRequest = z.infer<typeof evaluateRequestSchema>;

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
});

export const createServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});

export const createToolSchema = z.object({
  name: z.string().min(1),
  kind: toolKindSchema,
  description: z.string().optional(),
});

export const createToolGrantSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
});

export const createServerGrantSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  readOnlyAll: z.boolean(),
});

export const createApprovalRuleSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
  writeOnly: z.boolean().optional(),
  approverUserId: z.string().uuid(),
});

export const createRateLimitSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
  maxCalls: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
});

export const decideApprovalSchema = z.object({
  deciderUserId: z.string().uuid(),
  decision: z.enum(["approved", "denied"]),
  reason: z.string().optional(),
});

export const createDataScopeRuleSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
  argPath: z.string().min(1),
  allowedValues: z.array(z.string()).min(1),
});
