/**
 * ADR-0341 slice 2 — the pipeline builder's working state, kept out of the components (ADR-0200 #2).
 *
 * The server draft is the source of truth; the page edits a local working copy of its definition. Every edit is a
 * pure function from the canvas model (definition → definition), pushed on an undo stack, and validated by the server
 * after a short pause (POST /v1/workflows/builder/validate, the same rules a publish runs). Saving sends the working
 * copy with the revision it was based on; a concurrent save elsewhere comes back as a conflict, never an overwrite.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/client";
import { pipelineBuilderApi, type BuilderDraftView, type BuilderIssue } from "./pipelineBuilderApi";
import type { TemplateDefinition } from "./pipelineCanvasModel";

/** how long the canvas waits after the last edit before asking the server to validate */
export const VALIDATE_DEBOUNCE_MS = 450;
const HISTORY_LIMIT = 100;

export const draftKey = (templateId: string) => ["admin", "pipeline-builder", "draft", templateId] as const;
export const versionsKey = (templateId: string) => ["admin", "pipeline-builder", "versions", templateId] as const;

export interface LiveValidation {
  valid: boolean | null;
  issues: BuilderIssue[];
  /** a validation request is waiting or in flight */
  pending: boolean;
  /** the validator itself could not be reached */
  error: string | null;
}

/** a draft view with the fields the screen reads; anything else (an empty or partial answer) is not a draft */
export function isDraftView(v: unknown): v is BuilderDraftView {
  const d = v as BuilderDraftView | null;
  return (
    !!d &&
    typeof d === "object" &&
    !!d.template &&
    typeof d.template.name === "string" &&
    !!d.draft &&
    typeof d.draft.revision === "number" &&
    !!d.draft.definition &&
    Array.isArray(d.draft.definition.stages)
  );
}

/** the issues per stage id (issues with no stage are keyed by the empty string) */
export function issuesByStage(issues: readonly BuilderIssue[]): Map<string, BuilderIssue[]> {
  const out = new Map<string, BuilderIssue[]>();
  for (const i of issues) {
    const k = i.stageId ?? "";
    out.set(k, [...(out.get(k) ?? []), i]);
  }
  return out;
}

/** true when the request failed because the template has no open draft (as against no such template) */
export function isNoDraft(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.payload?.error === "no_draft";
}

export interface History {
  working: TemplateDefinition | null;
  past: TemplateDefinition[];
  future: TemplateDefinition[];
}

export type HistoryAction =
  | { type: "reset"; definition: TemplateDefinition | null }
  | { type: "edit"; change: (d: TemplateDefinition) => TemplateDefinition }
  | { type: "undo" }
  | { type: "redo" };

/** the working copy and its undo/redo stacks; pure, so StrictMode's double call changes nothing */
export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case "reset":
      return { working: a.definition, past: [], future: [] };
    case "edit": {
      if (h.working === null) return h;
      const next = a.change(h.working);
      if (next === h.working) return h;
      return { working: next, past: [...h.past.slice(-(HISTORY_LIMIT - 1)), h.working], future: [] };
    }
    case "undo": {
      if (h.past.length === 0 || h.working === null) return h;
      return { working: h.past[h.past.length - 1]!, past: h.past.slice(0, -1), future: [h.working, ...h.future] };
    }
    case "redo": {
      if (h.future.length === 0 || h.working === null) return h;
      return { working: h.future[0]!, past: [...h.past, h.working], future: h.future.slice(1) };
    }
  }
}

export function usePipelineDraft(templateId: string) {
  const qc = useQueryClient();
  const draft = useQuery({
    queryKey: draftKey(templateId),
    queryFn: () => pipelineBuilderApi.getDraft(templateId),
  });
  const server = isDraftView(draft.data) ? draft.data : null;

  const [history, dispatch] = useReducer(historyReducer, { working: null, past: [], future: [] });
  const working = history.working;
  const [revision, setRevision] = useState<number | null>(null);
  const [validation, setValidation] = useState<LiveValidation>({ valid: null, issues: [], pending: false, error: null });

  // adopt the server copy when it first arrives or after a save/reload changes its revision
  useEffect(() => {
    if (!server) return;
    if (revision === server.draft.revision) return;
    dispatch({ type: "reset", definition: server.draft.definition });
    setRevision(server.draft.revision);
    setValidation({ valid: server.validation.valid, issues: server.validation.issues, pending: false, error: null });
  }, [server, revision]);

  const savedBytes = server ? JSON.stringify(server.draft.definition) : null;
  const dirty = working !== null && savedBytes !== null && JSON.stringify(working) !== savedBytes;

  // validate after a pause; a newer edit makes an older answer irrelevant
  const seq = useRef(0);
  const firstRender = useRef(true);
  useEffect(() => {
    if (working === null) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const mine = ++seq.current;
    setValidation((v) => ({ ...v, pending: true }));
    const timer = setTimeout(() => {
      pipelineBuilderApi.validate(working).then(
        (r) => {
          if (seq.current === mine) setValidation({ valid: r.valid, issues: r.issues ?? [], pending: false, error: null });
        },
        (e: unknown) => {
          if (seq.current === mine) setValidation((v) => ({ ...v, pending: false, error: e instanceof Error ? e.message : "validation failed" }));
        },
      );
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [working]);

  const edit = useCallback((change: (d: TemplateDefinition) => TemplateDefinition) => dispatch({ type: "edit", change }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  const adopt = useCallback(
    (view: BuilderDraftView) => {
      qc.setQueryData(draftKey(templateId), view);
    },
    [qc, templateId],
  );

  const save = useCallback(async () => {
    if (working === null || revision === null) return null;
    const view = await pipelineBuilderApi.saveDraft(templateId, revision, working);
    adopt(view);
    return view;
  }, [adopt, revision, templateId, working]);

  const open = useCallback(
    async (fromVersion?: number) => {
      const view = await pipelineBuilderApi.openDraft(templateId, fromVersion);
      setRevision(null);
      adopt(view);
      return view;
    },
    [adopt, templateId],
  );

  const discard = useCallback(async () => {
    await pipelineBuilderApi.discardDraft(templateId);
    dispatch({ type: "reset", definition: null });
    setRevision(null);
    await qc.invalidateQueries({ queryKey: draftKey(templateId) });
  }, [qc, templateId]);

  /** throw away local edits and take the server copy again */
  const reload = useCallback(async () => {
    setRevision(null);
    await draft.refetch();
  }, [draft]);

  const byStage = useMemo(() => issuesByStage(validation.issues), [validation.issues]);

  return {
    draft,
    server,
    working,
    dirty,
    validation,
    byStage,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    edit,
    undo,
    redo,
    save,
    open,
    discard,
    reload,
  };
}
