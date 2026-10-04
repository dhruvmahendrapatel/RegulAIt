/**
 * ADR-0172 — every Builder API call the web makes, in one place, so it can be
 * diffed against the gateway's routes. All under /v1/builder, written as full
 * literals: scripts/preflight-ui-affordances.mjs finds a screen's DELETE (and
 * add) calls by their `/v1/...` path text.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type {
  BuilderAgentDetail,
  BuilderAgentSummary,
  BuilderBundle,
  BuilderCadence,
  BuilderChannel,
  BuilderChannelProvider,
  BuilderConnectionFormat,
  BuilderImportDropped,
  BuilderIntegrationsResponse,
  BuilderMemoryItem,
  BuilderMessage,
  BuilderSchedule,
  BuilderSharing,
  BuilderSkillDetail,
  BuilderSkillSummary,
  BuilderTemplate,
  BuilderThreadStatus,
  BuilderThreadSummary,
  BuilderToolboxOption,
  BuilderUsage,
  DirectoryUser,
  MyAgentsResponse,
  ProviderStatusResponse,
} from "../../api/types";
import { bindingsFromGranted } from "../models/modelBindings";

export const bk = {
  agents: ["builder", "agents"] as const,
  agent: (id: string) => ["builder", "agent", id] as const,
  threads: (status: string, agentId?: string) => ["builder", "threads", status, agentId ?? ""] as const,
  thread: (id: string) => ["builder", "thread", id] as const,
  skills: ["builder", "skills"] as const,
  skill: (id: string) => ["builder", "skill", id] as const,
  templates: ["builder", "templates"] as const,
  template: (id: string) => ["builder", "template", id] as const,
  integrations: ["builder", "integrations"] as const,
  toolboxOptions: ["builder", "toolbox-options"] as const,
  usage: (days: number) => ["builder", "usage", days] as const,
};

export interface CreateAgentBody {
  name: string;
  description?: string;
  modelAgentId?: string;
  connectionFormat: BuilderConnectionFormat;
  computerUse: boolean;
  templateId?: string;
}
export interface PatchAgentBody {
  name?: string;
  description?: string;
  color?: string;
  instructions?: string;
  modelAgentId?: string;
  sharing?: BuilderSharing;
  sharedUserIds?: string[];
  monthlyLimitUsd?: number | null;
  computerUse?: boolean;
}
export interface ScheduleBody {
  name: string;
  cadence: BuilderCadence;
  timeUtc: string;
  prompt: string;
  enabled: boolean;
}
export interface ChatResponse {
  thread: BuilderThreadSummary;
  messages: BuilderMessage[];
}

export const builderApi = {
  listAgents: () => api.get<{ agents: BuilderAgentSummary[] }>(`/v1/builder/agents`),
  createAgent: (body: CreateAgentBody) => api.post<{ agent: BuilderAgentDetail }>(`/v1/builder/agents`, body),
  getAgent: (id: string) => api.get<{ agent: BuilderAgentDetail }>(`/v1/builder/agents/${id}`),
  patchAgent: (id: string, body: PatchAgentBody) => api.patch<{ agent: BuilderAgentDetail }>(`/v1/builder/agents/${id}`, body),
  deleteAgent: (id: string) => api.del<unknown>(`/v1/builder/agents/${id}`),
  putTools: (id: string, tools: Array<{ kind: "connector" | "mcp_tool"; refId: string; requiresApproval: boolean }>) =>
    api.put<{ agent: BuilderAgentDetail }>(`/v1/builder/agents/${id}/tools`, { tools }),
  putSubagents: (id: string, subagents: Array<{ childId: string; name: string; description: string }>) =>
    api.put<{ agent: BuilderAgentDetail }>(`/v1/builder/agents/${id}/subagents`, { subagents }),
  putSkills: (id: string, skillIds: string[]) => api.put<{ agent: BuilderAgentDetail }>(`/v1/builder/agents/${id}/skills`, { skillIds }),
  addMemory: (id: string, content: string) => api.post<BuilderMemoryItem>(`/v1/builder/agents/${id}/memory`, { content }),
  deleteMemory: (id: string, memoryId: string) => api.del<unknown>(`/v1/builder/agents/${id}/memory/${memoryId}`),
  addSchedule: (id: string, body: ScheduleBody) => api.post<BuilderSchedule>(`/v1/builder/agents/${id}/schedules`, body),
  patchSchedule: (id: string, scheduleId: string, body: Partial<ScheduleBody>) =>
    api.patch<BuilderSchedule>(`/v1/builder/agents/${id}/schedules/${scheduleId}`, body),
  deleteSchedule: (id: string, scheduleId: string) => api.del<unknown>(`/v1/builder/agents/${id}/schedules/${scheduleId}`),
  addChannel: (id: string, provider: BuilderChannelProvider) => api.post<BuilderChannel>(`/v1/builder/agents/${id}/channels`, { provider }),
  deleteChannel: (id: string, channelId: string) => api.del<unknown>(`/v1/builder/agents/${id}/channels/${channelId}`),
  exportAgent: (id: string) => api.get<{ bundle: BuilderBundle }>(`/v1/builder/agents/${id}/export`),
  importAgent: (bundle: BuilderBundle) =>
    api.post<{ agent: BuilderAgentDetail; dropped: BuilderImportDropped[] }>(`/v1/builder/agents/import`, { bundle }),

  chat: (agentId: string, message: string, threadId?: string) =>
    api.post<ChatResponse>(`/v1/builder/agents/${agentId}/chat`, threadId ? { threadId, message } : { message }),
  listThreads: (status: "needs_attention" | "completed" | "all", agentId?: string) =>
    api.get<{ threads: BuilderThreadSummary[] }>(
      `/v1/builder/threads?status=${status}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`,
    ),
  getThread: (id: string) => api.get<ChatResponse>(`/v1/builder/threads/${id}`),
  patchThread: (id: string, status: BuilderThreadStatus) => api.patch<{ thread: BuilderThreadSummary }>(`/v1/builder/threads/${id}`, { status }),

  listSkills: () => api.get<{ skills: BuilderSkillSummary[] }>(`/v1/builder/skills`),
  getSkill: (id: string) => api.get<{ skill: BuilderSkillDetail }>(`/v1/builder/skills/${id}`),
  createSkill: (body: { name: string; description: string; body: string; visibility: "private" | "workspace" }) =>
    api.post<{ skill: BuilderSkillDetail }>(`/v1/builder/skills`, body),
  patchSkill: (id: string, body: Partial<{ name: string; description: string; body: string; visibility: "private" | "workspace" }>) =>
    api.patch<{ skill: BuilderSkillDetail }>(`/v1/builder/skills/${id}`, body),
  deleteSkill: (id: string) => api.del<unknown>(`/v1/builder/skills/${id}`),
  importSkill: (markdown: string) => api.post<{ skill: BuilderSkillDetail }>(`/v1/builder/skills/import`, { markdown }),

  listTemplates: () => api.get<{ templates: BuilderTemplate[] }>(`/v1/builder/templates`),
  getTemplate: (id: string) => api.get<{ template: BuilderTemplate }>(`/v1/builder/templates/${id}`),
  integrations: () => api.get<BuilderIntegrationsResponse>(`/v1/builder/integrations`),
  usage: (days: 7 | 30) => api.get<BuilderUsage>(`/v1/builder/usage?days=${days}`),
};

/**
 * A refused chat turn, as the page needs it. A refusal decided AFTER the
 * thread existed (the model entitlement, or any governed-core refusal) comes
 * back with the `threadId` it was recorded in — the person's message and a
 * note naming the refusal — so the page opens that thread instead of losing
 * it. The spend-limit refusal (402) is decided first and records nothing.
 */
export function chatRefusal(e: unknown): { message: string; code: string | null; threadId: string | null } {
  if (e instanceof ApiError) {
    const threadId = typeof e.payload.threadId === "string" ? e.payload.threadId : null;
    return { message: e.message, code: e.payload.error ?? null, threadId };
  }
  return { message: e instanceof Error ? e.message : String(e), code: null, threadId: null };
}

// ---- existing (non-builder) routes the builder reads ----------------------

/** the models the signed-in person may use — the model choice for an agent */
export function useMyModels(userId: string | null) {
  return useQuery({
    queryKey: ["builder", "my-models", userId],
    queryFn: () => api.get<MyAgentsResponse>(`/v1/users/${userId}/agents`),
    enabled: !!userId,
  });
}

/** people to share an agent with (names only) */
export function useDirectory() {
  return useQuery({ queryKey: ["directory"], queryFn: () => api.get<{ users: DirectoryUser[] }>("/v1/users/directory") });
}

/**
 * The connectors and MCP tools the signed-in person may add to a toolbox —
 * decided by the gateway with the same entitlement helpers its PUT …/tools
 * check uses, and carrying the ids that PUT accepts (an MCP tool's own id).
 */
export const toolboxOptions = () => api.get<{ options: BuilderToolboxOption[] }>(`/v1/builder/toolbox-options`);

/**
 * The models the signed-in person may use, as picker tiles (logo, model id,
 * tier, readiness) — the same derivation the chat page and /models use.
 */
export function useMyModelTiles(userId: string | null) {
  const models = useMyModels(userId);
  const creds = useQuery({
    queryKey: ["my-credentials", userId],
    enabled: !!userId,
    queryFn: () => api.get<{ credentials: Array<{ provider: string }> }>(`/v1/users/${userId}/model-credentials`),
  });
  const status = useQuery({
    queryKey: ["provider-status"],
    enabled: !!userId,
    queryFn: () => api.get<ProviderStatusResponse>("/v1/model-providers/status"),
  });
  const tiles = useMemo(
    () =>
      bindingsFromGranted(
        (models.data?.agents ?? []).filter((a) => !a.revoked),
        {
          providerStatus: status.data?.providers ?? {},
          myProviders: (creds.data?.credentials ?? []).map((c) => c.provider),
        },
      ),
    [models.data, status.data, creds.data],
  );
  return { tiles, defaultAgentId: models.data?.defaultAgentId ?? null, isLoading: models.isLoading, error: models.error };
}

export function useAgents() {
  return useQuery({ queryKey: bk.agents, queryFn: builderApi.listAgents });
}
