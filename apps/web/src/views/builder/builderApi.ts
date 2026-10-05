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
  BuilderPendingStep,
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
import type { AutonomyClass, BuilderAgentAutonomyView } from "./autonomyModel";
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
  autonomy: (id: string) => ["builder", "autonomy", id] as const,
};

export interface CreateAgentBody {
  name: string;
  description?: string;
  modelAgentId?: string;
  connectionFormat: BuilderConnectionFormat;
  computerUse: boolean;
  templateId?: string;
  /** owner rule: every agent bills its spend to a project */
  projectId: string;
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
  /** can be changed, never cleared (owner rule) */
  projectId?: string;
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
  /** ADR-0173: set while the turn waits on a tool step */
  pending?: BuilderPendingStep | null;
}

/**
 * ADR-0173 — fold one chat turn's response into the cached thread: messages
 * replace by id (a resumed turn updates the agent message it already showed),
 * and the pause (if any) is the response's, never a stale one.
 */
export function mergeTurn(prev: ChatResponse | undefined, res: ChatResponse): ChatResponse {
  const byId = new Map((prev?.messages ?? []).map((m) => [m.id, m]));
  for (const m of res.messages) byId.set(m.id, m);
  const messages = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { thread: res.thread, messages, pending: res.pending ?? null };
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
  reattachSkill: (id: string, skillId: string) =>
    api.post<{ agent: BuilderAgentDetail }>(`/v1/builder/agents/${id}/skills/${skillId}/reattach`, {}),
  addMemory: (id: string, content: string) => api.post<BuilderMemoryItem>(`/v1/builder/agents/${id}/memory`, { content }),
  deleteMemory: (id: string, memoryId: string) => api.del<unknown>(`/v1/builder/agents/${id}/memory/${memoryId}`),
  addSchedule: (id: string, body: ScheduleBody) => api.post<BuilderSchedule>(`/v1/builder/agents/${id}/schedules`, body),
  patchSchedule: (id: string, scheduleId: string, body: Partial<ScheduleBody>) =>
    api.patch<BuilderSchedule>(`/v1/builder/agents/${id}/schedules/${scheduleId}`, body),
  deleteSchedule: (id: string, scheduleId: string) => api.del<unknown>(`/v1/builder/agents/${id}/schedules/${scheduleId}`),
  addChannel: (id: string, provider: BuilderChannelProvider) => api.post<BuilderChannel>(`/v1/builder/agents/${id}/channels`, { provider }),
  deleteChannel: (id: string, channelId: string) => api.del<unknown>(`/v1/builder/agents/${id}/channels/${channelId}`),
  exportAgent: (id: string) => api.get<{ bundle: BuilderBundle }>(`/v1/builder/agents/${id}/export`),
  importAgent: (bundle: BuilderBundle, projectId: string) =>
    api.post<{ agent: BuilderAgentDetail; dropped: BuilderImportDropped[] }>(`/v1/builder/agents/import`, { bundle, projectId }),

  chat: (agentId: string, message: string, threadId?: string) =>
    api.post<ChatResponse>(`/v1/builder/agents/${agentId}/chat`, threadId ? { threadId, message } : { message }),
  listThreads: (status: "needs_attention" | "completed" | "all", agentId?: string) =>
    api.get<{ threads: BuilderThreadSummary[] }>(
      `/v1/builder/threads?status=${status}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`,
    ),
  getThread: (id: string) => api.get<ChatResponse>(`/v1/builder/threads/${id}`),
  patchThread: (id: string, status: BuilderThreadStatus) => api.patch<{ thread: BuilderThreadSummary }>(`/v1/builder/threads/${id}`, { status }),
  /** ADR-0173: the thread owner answers an "Ask first" pause; returns the whole thread */
  confirmStep: (threadId: string, stepId: string, decision: "approve" | "deny") =>
    api.post<ChatResponse>(`/v1/builder/threads/${threadId}/steps/${stepId}/confirm`, { decision }),
  /** ADR-0173 review: the thread owner cancels a pause (confirmation or approval); nothing runs */
  cancelStep: (threadId: string, stepId: string) => api.post<ChatResponse>(`/v1/builder/threads/${threadId}/steps/${stepId}/cancel`, {}),

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
  /** ADR-0180 A8 — the agent's steward (owner) or an admin */
  getAutonomy: (id: string) => api.get<{ autonomy: BuilderAgentAutonomyView }>(`/v1/builder/agents/${id}/autonomy`),
  declareAutonomy: (id: string, body: { class: AutonomyClass | null; note?: string }) =>
    api.put<{ autonomy: BuilderAgentAutonomyView; flag?: { code: "declared_below_observed"; detail: string } }>(`/v1/builder/agents/${id}/autonomy`, body),
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

/** the projects the signed-in person may bill an agent to (a member's own;
 * an admin's: all) — GET /v1/projects already scopes it that way */
export function useMyProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api.get<{ projects: Array<{ id: string; name: string }> }>("/v1/projects") });
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
