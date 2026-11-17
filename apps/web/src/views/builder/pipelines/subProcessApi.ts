/**
 * ADR-0341 follow-up — the sub-process catalogue's calls, written as full `/v1/...` literals (the route census finds a
 * screen's calls by their path text). The shapes mirror apps/gateway/src/workflow-fragments.ts.
 */
import { api } from "../../../api/client";

/** WORKFLOW_FRAGMENT_VERSION_MACHINE's states (@regulait/shared, ADR-0348), as the screen words them */
export type SubProcessState = "pending_approval" | "approved" | "rejected";
export const SUB_PROCESS_STATE_LABEL: Record<SubProcessState, { text: string; tone: "warn" | "ok" | "danger" }> = {
  pending_approval: { text: "Waiting for review", tone: "warn" },
  approved: { text: "Approved", tone: "ok" },
  rejected: { text: "Rejected", tone: "danger" },
};

export interface SubProcessListItem {
  id: string;
  name: string;
  description: string | null;
  /** the latest approved version, or null when none is approved yet */
  version: number | null;
  contentHash: string | null;
  stageCount: number | null;
  latest: { version: number; state: SubProcessState } | null;
}

export interface SubProcessVersion {
  id: string;
  version: number;
  contentHash: string;
  stageCount: number;
  state: SubProcessState;
  proposedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface SubProcessDetail {
  fragment: { id: string; name: string; description: string | null; createdAt: string };
  versions: SubProcessVersion[];
}

export interface SubProcessIssue {
  code: string;
  message: string;
  stageId: string | null;
}

export const subProcessKeys = {
  list: ["admin", "sub-processes", "list"] as const,
  detail: (id: string) => ["admin", "sub-processes", "detail", id] as const,
};

export const subProcessApi = {
  list: () => api.get<{ items: SubProcessListItem[]; nextOffset: number | null }>("/v1/workflows/fragments?include=all&limit=100"),
  detail: (id: string) => api.get<SubProcessDetail>(`/v1/workflows/fragments/${id}`),
  version: (id: string, version: number) =>
    api.get<{ fragment: { id: string; name: string }; version: { version: number; stages: unknown[]; state: SubProcessState } }>(
      `/v1/workflows/fragments/${id}/versions/${version}`,
    ),
  create: (body: { name: string; description?: string; stages: unknown[]; reviewerUserId: string }) =>
    api.post<{ fragment: { id: string; name: string }; version: { version: number } }>("/v1/workflows/fragments", body),
  proposeVersion: (id: string, body: { stages: unknown[]; reviewerUserId: string }) =>
    api.post<{ version: { version: number } }>(`/v1/workflows/fragments/${id}/versions`, body),
};

/** the stages text as the person typed it, or what is wrong with it */
export function parseStagesText(text: string): { stages: unknown[] } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: "This is not valid JSON." };
  }
  if (!Array.isArray(v)) return { error: "The stages are a JSON list: [ { \"id\": …, \"type\": … }, … ]." };
  if (v.length === 0) return { error: "A sub-process needs at least one stage." };
  return { stages: v };
}
