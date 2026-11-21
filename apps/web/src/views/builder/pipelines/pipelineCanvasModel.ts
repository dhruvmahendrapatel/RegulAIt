/**
 * ADR-0341 — the pipeline builder's canvas model, pure.
 *
 * The canvas is a PROJECTION of a workflow template definition (`packages/workflow-kernel`): one node per stage,
 * holding the stage object exactly as the template has it (unknown and opaque fields, such as a nested `run` graph,
 * included), and edges derived from it (the stage order, plus a dashed edge from a check with
 * `onFailure: "rollback"` to its `rollbackStageId`). Nothing about the canvas is stored: positions are laid out from
 * the order every time. Every edit is a function from one definition to the next, so
 * `fromCanvas(toCanvas(d))` is `d`, byte for byte (pinned by pipelineCanvasModel.test.ts).
 *
 * The server is the authority on validity (POST /v1/workflows/builder/validate); this module only keeps the shape.
 * The SPA does not import the kernel (the convention for every mirrored shape), so the stage vocabulary is restated.
 */

/** a stage as the template holds it: `id` and `type` plus whatever fields the stage carries */
export type TemplateStage = { id: string; type: string } & Record<string, unknown>;

/** a workflow template definition: `workflow`, `stages`, and whatever else the template carries (kept verbatim) */
export type TemplateDefinition = { workflow: string; stages: TemplateStage[] } & Record<string, unknown>;

/** the stage types the kernel executes (EXECUTABLE_STAGE_TYPES), in the palette's order */
export const STAGE_TYPES = [
  "trigger",
  "planning",
  "artifact_generation",
  "human_approval",
  "automated_build",
  "automated_check",
  "git_operation",
  "deployment",
  "rollback",
] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export interface StageTypeInfo {
  label: string;
  /** one sentence, shown in the palette and read by a screen reader */
  description: string;
  /** the palette group */
  group: "Start" | "Plan and approve" | "Build and check" | "Ship";
  /** the fields a new stage of this type starts with (beyond id and type) */
  starter: Record<string, unknown>;
}

export const STAGE_TYPE_INFO: Readonly<Record<StageType, StageTypeInfo>> = {
  trigger: { label: "Trigger", description: "Starts the workflow when a change arrives. Always the first stage.", group: "Start", starter: {} },
  planning: {
    label: "Plan only",
    description: "Forced plan-only mode: nothing changes code or infrastructure until this stage is done.",
    group: "Plan and approve",
    starter: {},
  },
  artifact_generation: {
    label: "Requirements artifact",
    description: "Produces a named artifact, such as a requirements file, for sign-off.",
    group: "Plan and approve",
    starter: { output: "requirements" },
  },
  human_approval: {
    label: "Sign-off",
    description: "A person approves before the workflow continues.",
    group: "Plan and approve",
    starter: { approvers: ["requesting_user"] },
  },
  automated_build: { label: "Build", description: "Builds the change, scoped to an artifact when one is named.", group: "Build and check", starter: {} },
  automated_check: { label: "Checks", description: "Runs named checks; a failed check blocks or rolls back.", group: "Build and check", starter: { checks: ["unit_tests"] } },
  git_operation: {
    label: "Git operation",
    description: "Creates a branch, opens a pull request or merges, through a registered git connection.",
    group: "Ship",
    starter: { action: "create_branch", connection: "", repo: "" },
  },
  deployment: { label: "Deploy", description: "A governed deploy to a registered target, after sign-off and checks.", group: "Ship", starter: { connection: "" } },
  rollback: { label: "Rollback", description: "Reverses a deploy when a post-deploy check fails.", group: "Ship", starter: { connection: "" } },
};

export function isStageType(t: string): t is StageType {
  return (STAGE_TYPES as readonly string[]).includes(t);
}

export function stageTypeLabel(t: string): string {
  return isStageType(t) ? STAGE_TYPE_INFO[t].label : t;
}

export interface CanvasNode {
  /** the stage id (unique within a definition) */
  id: string;
  /** position in the stage order, from 0 */
  index: number;
  /** the stage, verbatim */
  stage: TemplateStage;
}

export type CanvasEdgeKind = "next" | "rollback";

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  kind: CanvasEdgeKind;
}

export interface CanvasModel {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** the canvas for a definition: nodes in stage order, the order edges, and the rollback edges */
export function toCanvas(def: TemplateDefinition): CanvasModel {
  const nodes = def.stages.map((stage, index) => ({ id: stage.id, index, stage }));
  const edges: CanvasEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ id: `next:${nodes[i - 1]!.id}:${nodes[i]!.id}`, from: nodes[i - 1]!.id, to: nodes[i]!.id, kind: "next" });
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const target = n.stage.rollbackStageId;
    if (n.stage.onFailure === "rollback" && typeof target === "string" && ids.has(target)) {
      edges.push({ id: `rollback:${n.id}:${target}`, from: n.id, to: target, kind: "rollback" });
    }
  }
  return { nodes, edges };
}

/** the definition a canvas shows: every top-level field of `def` as it was, with the stages in node order */
export function fromCanvas(def: TemplateDefinition, canvas: CanvasModel): TemplateDefinition {
  const ordered = [...canvas.nodes].sort((a, b) => a.index - b.index);
  return { ...def, stages: ordered.map((n) => n.stage) };
}

/** a stage id not yet used in `def`, from the type (`checks`, `checks-2`, …) */
export function freshStageId(def: TemplateDefinition, type: string): string {
  const used = new Set(def.stages.map((s) => s.id));
  const stem = type.replace(/_/g, "-");
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n++) if (!used.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** a new stage of `type` with its starter fields and a fresh id */
export function newStage(def: TemplateDefinition, type: StageType): TemplateStage {
  return { id: freshStageId(def, type), type, ...structuredClone(STAGE_TYPE_INFO[type].starter) };
}

/** `stage` inserted at `index` (clamped to the list) */
export function insertStage(def: TemplateDefinition, index: number, stage: TemplateStage): TemplateDefinition {
  if (def.stages.some((s) => s.id === stage.id)) throw new Error(`a stage '${stage.id}' already exists`);
  const at = Math.max(0, Math.min(index, def.stages.length));
  return { ...def, stages: [...def.stages.slice(0, at), stage, ...def.stages.slice(at)] };
}

/** the stage removed, and any rollback edge pointing at it cleared from the check that named it */
export function removeStage(def: TemplateDefinition, id: string): TemplateDefinition {
  return {
    ...def,
    stages: def.stages
      .filter((s) => s.id !== id)
      .map((s) => {
        if (s.rollbackStageId !== id) return s;
        const { rollbackStageId: _gone, ...rest } = s;
        return rest as TemplateStage;
      }),
  };
}

/** the stage moved to `toIndex` (clamped); the same definition when it is already there or unknown */
export function moveStage(def: TemplateDefinition, id: string, toIndex: number): TemplateDefinition {
  const from = def.stages.findIndex((s) => s.id === id);
  if (from < 0) return def;
  const to = Math.max(0, Math.min(toIndex, def.stages.length - 1));
  if (to === from) return def;
  const stages = [...def.stages];
  const [moved] = stages.splice(from, 1);
  stages.splice(to, 0, moved!);
  return { ...def, stages };
}

/**
 * The stage with `changes` applied: a key set to `undefined` is removed, every other key is set, and the stage's key
 * order is kept (a new key is appended). Renaming the id also renames a rollback target that named it.
 */
export function updateStage(def: TemplateDefinition, id: string, changes: Record<string, unknown>): TemplateDefinition {
  const nextId = typeof changes.id === "string" ? changes.id : id;
  if (nextId !== id && def.stages.some((s) => s.id === nextId)) throw new Error(`a stage '${nextId}' already exists`);
  return {
    ...def,
    stages: def.stages.map((s) => {
      if (s.id === id) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(s)) {
          if (!(k in changes)) out[k] = v;
          else if (changes[k] !== undefined) out[k] = changes[k];
        }
        for (const [k, v] of Object.entries(changes)) if (!(k in s) && v !== undefined) out[k] = v;
        return out as TemplateStage;
      }
      if (nextId !== id && s.rollbackStageId === id) return { ...s, rollbackStageId: nextId };
      return s;
    }),
  };
}

/** the check's failure path pointed at a rollback stage (`null` = back to "block") */
export function setRollbackTarget(def: TemplateDefinition, checkId: string, rollbackId: string | null): TemplateDefinition {
  return rollbackId === null
    ? updateStage(def, checkId, { onFailure: undefined, rollbackStageId: undefined })
    : updateStage(def, checkId, { onFailure: "rollback", rollbackStageId: rollbackId });
}

/** the sentence a screen reader hears for a stage node */
export function stageSentence(stage: TemplateStage, index: number, total: number, issues = 0): string {
  const what = `${stageTypeLabel(stage.type)} stage ${stage.id}`;
  const problems = issues === 0 ? "" : `, ${issues} problem${issues === 1 ? "" : "s"}`;
  return `Step ${index + 1} of ${total}: ${what}${problems}`;
}
