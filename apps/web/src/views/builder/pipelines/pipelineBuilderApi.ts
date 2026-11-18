/**
 * ADR-0341 — every call the pipeline builder makes, in one place, written as full `/v1/...` literals
 * (scripts/preflight-ui-affordances.mjs and the route census find a screen's calls by their path text).
 *
 * The shapes mirror apps/gateway/src/workflow-builder.ts. Reads and draft writes use the shared client; publishing
 * goes through `withStepUp` (the gateway asks for a `settings_relax` step-up bound to the template, the version it
 * replaces and the exact content hash), and the body is frozen before the first attempt so a retry sends exactly
 * what the person confirmed.
 */
import { api } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import type { TemplateDefinition } from "./pipelineCanvasModel";

export interface BuilderIssue {
  code: string;
  message: string;
  stageId: string | null;
  path: Array<string | number>;
}

export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

export interface StageDiff {
  added: string[];
  removed: string[];
  changed: string[];
  moved: string[];
  topLevel: string[];
}

export interface Relaxation {
  code: string;
  stageId: string | null;
  message: string;
}

export interface BuilderDiff {
  patch: JsonPatchOp[];
  /** null when either side no longer parses (the patch still shows the change) */
  stages: StageDiff | null;
  relaxations: Relaxation[];
}

export interface BuilderValidation {
  valid: boolean;
  issues: BuilderIssue[];
  contentHash: string | null;
}

export interface BuilderTemplateSummary {
  id: string;
  name: string;
  retiredAt: string | null;
  createdAt: string;
  stageCount: number;
  editable: boolean;
  liveVersion: number | null;
  draft: { revision: number; updatedAt: string; updatedByName: string | null } | null;
}

export interface BuilderDraftView {
  template: { id: string; name: string };
  draft: {
    id: string;
    revision: number;
    definition: TemplateDefinition;
    baseVersion: number | null;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  liveVersion: number | null;
  stale: boolean;
  validation: BuilderValidation;
  diff: BuilderDiff;
}

export interface BuilderVersionSummary {
  version: number;
  contentHash: string;
  origin: "baseline" | "builder";
  publishedBy: string | null;
  publishedByName: string | null;
  publishedAt: string;
  stageCount: number;
  live: boolean;
}

export interface BuilderVersionView {
  template: { id: string; name: string };
  version: Omit<BuilderVersionSummary, "stageCount" | "live"> & { definition: TemplateDefinition };
  diff: BuilderDiff;
}

export interface PublishBody {
  revision: number;
  acceptRelaxations?: boolean;
  reason?: string;
}

export interface PublishResult {
  template: { id: string; name: string };
  version: { version: number; contentHash: string; origin: "builder"; publishedAt: string };
}

const enc = encodeURIComponent;

export const pipelineBuilderApi = {
  listTemplates: (limit: 10 | 50 | 100 = 100, offset = 0) =>
    api.get<{ items: BuilderTemplateSummary[]; nextOffset: number | null }>(`/v1/workflows/builder/templates?limit=${limit}&offset=${offset}`),
  openDraft: (templateId: string, fromVersion?: number) =>
    api.post<BuilderDraftView>(`/v1/workflows/builder/templates/${enc(templateId)}/draft`, fromVersion === undefined ? {} : { fromVersion }),
  getDraft: (templateId: string) => api.get<BuilderDraftView>(`/v1/workflows/builder/templates/${enc(templateId)}/draft`),
  saveDraft: (templateId: string, revision: number, definition: TemplateDefinition) =>
    api.put<BuilderDraftView>(`/v1/workflows/builder/templates/${enc(templateId)}/draft`, { revision, definition }),
  discardDraft: (templateId: string) => api.del<void>(`/v1/workflows/builder/templates/${enc(templateId)}/draft`),
  validate: (definition: unknown) =>
    api.post<BuilderValidation & { definition?: TemplateDefinition }>("/v1/workflows/builder/validate", { definition }),
  publish: (templateId: string, body: PublishBody) => {
    const frozen = Object.freeze({ ...body });
    return withStepUp((headers) => stepUpApi.post<PublishResult>(`/v1/workflows/builder/templates/${enc(templateId)}/publish`, frozen, headers));
  },
  versions: (templateId: string, before?: number) =>
    api.get<{ template: { id: string; name: string }; liveVersion: number | null; items: BuilderVersionSummary[]; nextBefore: number | null }>(
      `/v1/workflows/builder/templates/${enc(templateId)}/versions${before === undefined ? "" : `?before=${before}`}`,
    ),
  version: (templateId: string, version: number) =>
    api.get<BuilderVersionView>(`/v1/workflows/builder/templates/${enc(templateId)}/versions/${version}`),
};
