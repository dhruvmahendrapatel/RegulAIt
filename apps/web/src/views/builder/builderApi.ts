/**
 * ADR-0172 — every Builder API call the web makes, in one place, so the wiring
 * pass can diff this file against the gateway's routes. All under /v1/builder.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type {
  BuilderAgentDetail,
  BuilderAgentSummary,
  BuilderBundle,
  BuilderCadence,
  BuilderChannel,
  BuilderChannelProvider,
  BuilderConnectionFormat,
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
  BuilderUsage,
  DirectoryUser,
  MyAgentsResponse,
} from "../../api/types";

const B = "/v1/builder";

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
  listAgents: () => api.get<{ agents: BuilderAgentSummary[] }>(`${B}/agents`),
  createAgent: (body: CreateAgentBody) => api.post<{ agent: BuilderAgentDetail }>(`${B}/agents`, body),
  getAgent: (id: string) => api.get<{ agent: BuilderAgentDetail }>(`${B}/agents/${id}`),
  patchAgent: (id: string, body: PatchAgentBody) => api.patch<{ agent: BuilderAgentDetail }>(`${B}/agents/${id}`, body),
  deleteAgent: (id: string) => api.del<unknown>(`${B}/agents/${id}`),
  putTools: (id: string, tools: Array<{ kind: "connector" | "mcp_tool"; refId: string; requiresApproval: boolean }>) =>
    api.put<{ agent: BuilderAgentDetail }>(`${B}/agents/${id}/tools`, { tools }),
  putSubagents: (id: string, subagents: Array<{ childId: string; name: string; description: string }>) =>
    api.put<{ agent: BuilderAgentDetail }>(`${B}/agents/${id}/subagents`, { subagents }),
  putSkills: (id: string, skillIds: string[]) => api.put<{ agent: BuilderAgentDetail }>(`${B}/agents/${id}/skills`, { skillIds }),
  addMemory: (id: string, content: string) => api.post<BuilderMemoryItem>(`${B}/agents/${id}/memory`, { content }),
  deleteMemory: (id: string, memoryId: string) => api.del<unknown>(`${B}/agents/${id}/memory/${memoryId}`),
  addSchedule: (id: string, body: ScheduleBody) => api.post<BuilderSchedule>(`${B}/agents/${id}/schedules`, body),
  patchSchedule: (id: string, scheduleId: string, body: Partial<ScheduleBody>) =>
    api.patch<BuilderSchedule>(`${B}/agents/${id}/schedules/${scheduleId}`, body),
  deleteSchedule: (id: string, scheduleId: string) => api.del<unknown>(`${B}/agents/${id}/schedules/${scheduleId}`),
  addChannel: (id: string, provider: BuilderChannelProvider) => api.post<BuilderChannel>(`${B}/agents/${id}/channels`, { provider }),
  deleteChannel: (id: string, channelId: string) => api.del<unknown>(`${B}/agents/${id}/channels/${channelId}`),
  exportAgent: (id: string) => api.get<{ bundle: BuilderBundle }>(`${B}/agents/${id}/export`),
  importAgent: (bundle: BuilderBundle) =>
    api.post<{ agent: BuilderAgentDetail; dropped?: Array<string | { name?: string; refId?: string }> }>(`${B}/agents/import`, { bundle }),

  chat: (agentId: string, message: string, threadId?: string) =>
    api.post<ChatResponse>(`${B}/agents/${agentId}/chat`, threadId ? { threadId, message } : { message }),
  listThreads: (status: "needs_attention" | "completed" | "all", agentId?: string) =>
    api.get<{ threads: BuilderThreadSummary[] }>(
      `${B}/threads?status=${status}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`,
    ),
  getThread: (id: string) => api.get<ChatResponse>(`${B}/threads/${id}`),
  patchThread: (id: string, status: BuilderThreadStatus) => api.patch<{ thread: BuilderThreadSummary }>(`${B}/threads/${id}`, { status }),

  listSkills: () => api.get<{ skills: BuilderSkillSummary[] }>(`${B}/skills`),
  getSkill: (id: string) => api.get<{ skill: BuilderSkillDetail }>(`${B}/skills/${id}`),
  createSkill: (body: { name: string; description: string; body: string; visibility: "private" | "workspace" }) =>
    api.post<{ skill: BuilderSkillDetail }>(`${B}/skills`, body),
  patchSkill: (id: string, body: Partial<{ name: string; description: string; body: string; visibility: "private" | "workspace" }>) =>
    api.patch<{ skill: BuilderSkillDetail }>(`${B}/skills/${id}`, body),
  deleteSkill: (id: string) => api.del<unknown>(`${B}/skills/${id}`),
  importSkill: (markdown: string) => api.post<{ skill: BuilderSkillDetail }>(`${B}/skills/import`, { markdown }),

  listTemplates: () => api.get<{ templates: BuilderTemplate[] }>(`${B}/templates`),
  getTemplate: (id: string) => api.get<{ template: BuilderTemplate }>(`${B}/templates/${id}`),
  integrations: () => api.get<BuilderIntegrationsResponse>(`${B}/integrations`),
  usage: (days: 7 | 30) => api.get<BuilderUsage>(`${B}/usage?days=${days}`),
};

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

export interface MyConnector {
  connectorId: string;
  name: string;
  kind: string;
  revoked?: boolean;
}
export interface VisibleTool {
  serverId: string;
  name: string;
  kind: string;
}

/** connectors the editor holds a grant for — candidates for the toolbox */
export const myConnectors = (userId: string) => api.get<{ connectors: MyConnector[] }>(`/v1/users/${userId}/connectors`);
/** MCP tools on one server the editor is entitled to see */
export const myServerTools = (userId: string, serverId: string) =>
  api.get<{ tools: VisibleTool[] }>(`/v1/users/${userId}/servers/${serverId}/tools`);

/** the toolbox refId of an MCP tool: server id and tool name (see the open question in the build summary) */
export const mcpToolRefId = (serverId: string, toolName: string) => `${serverId}:${toolName}`;

export function useAgents() {
  return useQuery({ queryKey: bk.agents, queryFn: builderApi.listAgents });
}
