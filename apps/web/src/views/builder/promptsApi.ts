/**
 * ADR-0173 batch 2b — every prompt-registry and playground call the web makes,
 * in one place, written as full `/v1/...` literals (scripts/preflight-ui-
 * affordances.mjs finds a screen's DELETE calls by their path text).
 *
 * The shapes mirror apps/gateway/src/prompt-registry.ts and playground.ts. The
 * SPA does not import @regulait/shared (the convention for every mirrored
 * shape), so these are restated here.
 */
import { api } from "../../api/client";

export type PromptVisibility = "private" | "workspace" | "people";

export interface PromptTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PromptModelConfig {
  agentId: string | null;
  maxTokens: number | null;
}

export interface PromptSummary {
  id: string;
  name: string;
  description: string;
  visibility: PromptVisibility;
  ownerUserId: string;
  ownerName: string | null;
  projectId: string | null;
  latestCommitHash: string | null;
  latestCommitAt: string | null;
  tags: Array<{ name: string; commitHash: string }>;
  canEdit: boolean;
  updatedAt: string;
}

export interface PromptCommit {
  id: string;
  hash: string;
  parentHash: string | null;
  template: string;
  modelConfig: PromptModelConfig;
  variables: string[];
  outputSchema: Record<string, unknown> | null;
  tools: PromptTool[];
  authorUserId: string;
  authorName?: string | null;
  message: string;
  createdAt: string;
}

export interface PromptTag {
  name: string;
  commitHash: string;
  movedByUserId: string | null;
  movedByName: string | null;
  movedAt: string;
}

export type PromotionStatus = "pending_approval" | "applied" | "denied" | "stale";

export interface PromptPromotion {
  id: string;
  tag: string;
  commitHash: string;
  previousCommitHash: string | null;
  status: PromotionStatus;
  approvalId: string | null;
  requestedByUserId: string;
  requestedByName: string | null;
  approverUserId: string;
  approverName: string | null;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
}

export interface PromptDetail {
  prompt: {
    id: string;
    name: string;
    description: string;
    ownerUserId: string;
    ownerName: string | null;
    visibility: PromptVisibility;
    projectId: string | null;
    sharedUsers: Array<{ id: string; name: string | null }>;
    createdAt: string;
    updatedAt: string;
    canEdit: boolean;
  };
  commits: PromptCommit[];
  tags: PromptTag[];
  promotions: PromptPromotion[];
}

export interface PromptDiff {
  from: string;
  to: string;
  template: Array<{ op: "add" | "remove" | "same"; text: string }>;
  variables: { added: string[]; removed: string[] };
  modelConfig: { from: PromptModelConfig; to: PromptModelConfig } | null;
  outputSchema: { from: unknown; to: unknown } | null;
  tools: { added: string[]; removed: string[]; changed: string[] };
}

export interface TagMoveResult {
  moved: boolean;
  tag?: string;
  commitHash?: string;
  pendingApproval?: boolean;
  promotion?: PromptPromotion;
}

export interface CommitBody {
  template: string;
  modelConfig: PromptModelConfig;
  outputSchema: Record<string, unknown> | null;
  tools: PromptTool[];
  parentHash: string | null;
  message: string;
}

// ---- playground ------------------------------------------------------------

export interface SchemaValidation {
  valid: boolean;
  errors: string[];
}

export interface PlaygroundRunBody {
  template: string;
  variables: Record<string, string>;
  modelAgentId: string;
  maxTokens?: number;
  outputSchema: Record<string, unknown> | null;
  tools: PromptTool[];
  projectId: string | null;
}

export interface PlaygroundToolCall {
  id?: string;
  name: string;
  input?: unknown;
  arguments?: unknown;
}

export interface PlaygroundRunResult {
  outputText: string | null;
  toolCalls: PlaygroundToolCall[];
  toolCallsExecuted: false;
  toolCallsNote: string;
  structuredOutput: "native" | "validated_after" | null;
  schemaValidation: SchemaValidation | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  costUsd: number | null;
  servedAgentId: string | null;
  model: string | null;
  variables: string[];
}

export interface EvaluateRow {
  inputs: Record<string, string>;
  reference: string | null;
}

export type PlaygroundEvaluateBody = Omit<PlaygroundRunBody, "variables"> & ({ rows: EvaluateRow[] } | { datasetId: string });

export interface EvaluateResultRow {
  index: number;
  caseId?: string;
  inputs: Record<string, string>;
  reference: string | null;
  ok: boolean;
  error: string | null;
  detail: string | null;
  outputText?: string | null;
  toolCalls?: PlaygroundToolCall[];
  costUsd?: number | null;
  schemaValidation?: SchemaValidation | null;
  referenceMatch?: "exact" | "contains" | "no" | null;
}

export interface EvaluateResult {
  source: { kind: "inline" } | { kind: "dataset"; datasetId: string; name: string; version: number };
  summary: {
    rows: number;
    succeeded: number;
    failed: number;
    totalCostUsd: number;
    unpricedCalls: number;
    schemaPassed: number;
    referenceMatched: number;
    withReference: number;
  };
  results: EvaluateResultRow[];
  toolCallsExecuted: false;
  toolCallsNote: string;
  structuredOutput: "native" | "validated_after" | null;
}

export const pk = {
  prompts: ["prompts"] as const,
  prompt: (id: string) => ["prompts", id] as const,
  diff: (id: string, from: string, to: string) => ["prompts", id, "diff", from, to] as const,
  datasets: ["playground", "datasets"] as const,
};

export const promptsApi = {
  list: () => api.get<{ prompts: PromptSummary[] }>(`/v1/prompts`),
  get: (id: string) => api.get<PromptDetail>(`/v1/prompts/${id}`),
  create: (body: { name: string; description: string; visibility: PromptVisibility; sharedUserIds: string[]; projectId: string | null }) =>
    api.post<PromptDetail>(`/v1/prompts`, body),
  patch: (id: string, body: Partial<{ name: string; description: string; visibility: PromptVisibility; sharedUserIds: string[]; projectId: string | null }>) =>
    api.patch<PromptDetail>(`/v1/prompts/${id}`, body),
  archive: (id: string) => api.del<{ archived: true; id: string }>(`/v1/prompts/${id}`),
  commit: (id: string, body: CommitBody) => api.post<PromptCommit>(`/v1/prompts/${id}/commits`, body),
  diff: (id: string, from: string, to: string) =>
    api.get<PromptDiff>(`/v1/prompts/${id}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  moveTag: (id: string, tag: string, body: { commitHash: string; approverUserId?: string }) =>
    api.put<TagMoveResult>(`/v1/prompts/${id}/tags/${encodeURIComponent(tag)}`, body),

  run: (body: PlaygroundRunBody) => api.post<PlaygroundRunResult>(`/v1/playground/run`, body),
  evaluate: (body: PlaygroundEvaluateBody) => api.post<EvaluateResult>(`/v1/playground/evaluate`, body),
  /** admins only: the evaluation datasets evaluate mode can reuse */
  datasets: () => api.get<{ datasets: Array<{ id: string; name: string; version: number; caseCount?: number }> }>(`/v1/evals/datasets`),
};
