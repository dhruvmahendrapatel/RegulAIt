/**
 * ADR-0341 follow-up (Camunda gap row 10) — the sub-process catalogue, pure.
 *
 * A fragment is a reusable, versioned list of stages. A builder draft calls one with a `call` stage that pins an
 * approved version: `{ id, type: "call", fragment, version }`. The kernel never runs a `call` stage. Validation and
 * publish expand it into the fragment's stages (ids prefixed `<callId>.`), so every rule, reader and instance snapshot
 * sees a plain workflow definition. Opening a draft from a published version collapses the expansion back into the
 * call, so the builder still shows what the admin wrote.
 *
 * The same pattern as GitHub Actions' reusable workflows (`uses: …@ref`), Argo's `templateRef` and Camunda's call
 * activity with a version binding: a reference pinned by version. It is resolved at publish rather than at run time,
 * so the engine and the instance snapshot stay unchanged.
 */
import { z } from "zod";
import { workflowDefinitionSchema, type Stage, type WorkflowDefinition } from "./index.js";

export const CALL_STAGE_TYPE = "call";
export const FRAGMENT_MAX_STAGES = 50;
/** what joins a call stage's id to the id of a stage it expands into */
export const FRAGMENT_ID_SEPARATOR = ".";

/**
 * Rule 12: a fragment version's state, declared once. The state is not stored on the version: it is read from the
 * version's Approvals Queue row, so one fact lives in one place. Only an approved version is listed or callable.
 * Anything the queue reports that is not named here (a future status) reads as rejected, so it fails closed.
 */
export const FRAGMENT_VERSION_STATES = {
  pending_approval: { approvalStatus: "pending", listed: false, callable: false, next: ["approved", "rejected"] },
  approved: { approvalStatus: "approved", listed: true, callable: true, next: [] },
  rejected: { approvalStatus: "denied", listed: false, callable: false, next: [] },
} as const satisfies Record<string, { approvalStatus: string; listed: boolean; callable: boolean; next: readonly string[] }>;
export type FragmentVersionState = keyof typeof FRAGMENT_VERSION_STATES;

export function fragmentVersionState(approvalStatus: string | null | undefined): FragmentVersionState {
  for (const [state, def] of Object.entries(FRAGMENT_VERSION_STATES)) {
    if (def.approvalStatus === approvalStatus) return state as FragmentVersionState;
  }
  return "rejected";
}

export const callStageSchema = z
  .object({
    id: z.string().min(1).max(100).refine((s) => !s.includes(FRAGMENT_ID_SEPARATOR), `a call stage id cannot contain '${FRAGMENT_ID_SEPARATOR}'`),
    type: z.literal(CALL_STAGE_TYPE),
    fragment: z.string().uuid(),
    version: z.number().int().min(1),
  })
  .strict();
export type CallStage = z.infer<typeof callStageSchema>;

export function isCallStage(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { type?: unknown }).type === CALL_STAGE_TYPE;
}

export interface FragmentIssue {
  code: "fragment_empty" | "fragment_too_many_stages" | "fragment_trigger" | "fragment_call" | "fragment_schema" | "fragment_stage_id";
  message: string;
  stageId: string | null;
}

/**
 * A fragment's stages, checked by the same schema as a template (wrapped behind a trigger so every cross-stage rule
 * applies, such as a rollback target that must exist inside the fragment). A fragment has no trigger, calls no other
 * fragment (one level only) and uses no `.` in its stage ids, so an expanded id always splits back into its call.
 */
export function validateFragmentStages(raw: unknown): { ok: true; stages: Stage[] } | { ok: false; issues: FragmentIssue[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, issues: [{ code: "fragment_empty", message: "a fragment needs at least one stage", stageId: null }] };
  }
  if (raw.length > FRAGMENT_MAX_STAGES) {
    return { ok: false, issues: [{ code: "fragment_too_many_stages", message: `a fragment has at most ${FRAGMENT_MAX_STAGES} stages`, stageId: null }] };
  }
  const issues: FragmentIssue[] = [];
  for (const s of raw as Array<{ id?: unknown; type?: unknown }>) {
    const stageId = typeof s?.id === "string" ? s.id : null;
    if (s?.type === "trigger") issues.push({ code: "fragment_trigger", message: "a fragment cannot contain a trigger: the calling template has one", stageId });
    if (s?.type === CALL_STAGE_TYPE) issues.push({ code: "fragment_call", message: "a fragment cannot call another fragment", stageId });
    if (stageId?.includes(FRAGMENT_ID_SEPARATOR)) issues.push({ code: "fragment_stage_id", message: `a fragment stage id cannot contain '${FRAGMENT_ID_SEPARATOR}'`, stageId });
  }
  if (issues.length > 0) return { ok: false, issues };
  const wrapped = workflowDefinitionSchema.safeParse({ workflow: "fragment", stages: [{ id: "trigger", type: "trigger" }, ...raw] });
  if (!wrapped.success) {
    return {
      ok: false,
      issues: wrapped.error.issues.map((i) => {
        const idx = typeof i.path[1] === "number" ? i.path[1] - 1 : -1;
        const st = idx >= 0 ? (raw[idx] as { id?: unknown } | undefined) : undefined;
        return { code: "fragment_schema" as const, message: i.message, stageId: typeof st?.id === "string" ? st.id : null };
      }),
    };
  }
  return { ok: true, stages: wrapped.data.stages.slice(1) };
}

/** the stages a call expands into: ids prefixed with the call's, rollback targets moved with them */
export function expandCall(call: Pick<CallStage, "id">, stages: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const prefix = `${call.id}${FRAGMENT_ID_SEPARATOR}`;
  return stages.map((s) => {
    const out: Record<string, unknown> = { ...s, id: `${prefix}${String(s.id)}` };
    if (typeof s.rollbackStageId === "string") out.rollbackStageId = `${prefix}${s.rollbackStageId}`;
    return out;
  });
}

export interface ResolvedCall {
  callStageId: string;
  fragmentId: string;
  version: number;
  /** the pinned version's stages, as stored */
  stages: readonly Record<string, unknown>[];
}

export type CallResolver = (fragmentId: string, version: number) => readonly Record<string, unknown>[] | null;

export interface CallIssue {
  code: "call_schema" | "call_unresolved";
  message: string;
  stageId: string | null;
}

/**
 * Every call stage replaced by the stages of the version it pins. The result is the RAW definition the builder's
 * existing checks then run on, so a field a call stage does not have is refused and the plan gate sees the real
 * stages. `resolve` returns null for a version that does not exist or is not approved.
 */
export function expandCalls(
  raw: unknown,
  resolve: CallResolver,
): { ok: true; definition: unknown; calls: ResolvedCall[] } | { ok: false; issues: CallIssue[] } {
  const stages = (raw as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages) || !stages.some(isCallStage)) return { ok: true, definition: raw, calls: [] };
  const issues: CallIssue[] = [];
  const calls: ResolvedCall[] = [];
  const out: unknown[] = [];
  for (const s of stages) {
    if (!isCallStage(s)) {
      out.push(s);
      continue;
    }
    const parsed = callStageSchema.safeParse(s);
    const stageId = typeof (s as { id?: unknown }).id === "string" ? ((s as { id: string }).id) : null;
    if (!parsed.success) {
      for (const i of parsed.error.issues) issues.push({ code: "call_schema", message: i.message, stageId });
      continue;
    }
    const resolved = resolve(parsed.data.fragment, parsed.data.version);
    if (!resolved) {
      issues.push({ code: "call_unresolved", message: `stage '${parsed.data.id}' calls a sub-process version that does not exist or is not approved`, stageId });
      continue;
    }
    calls.push({ callStageId: parsed.data.id, fragmentId: parsed.data.fragment, version: parsed.data.version, stages: resolved });
    out.push(...expandCall(parsed.data, resolved));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, definition: { ...(raw as Record<string, unknown>), stages: out }, calls };
}

/**
 * The reverse of `expandCalls`, for opening a draft from a published version: each recorded call's expansion is put
 * back as its call stage. An expansion that is no longer where and what it was (which a publish never produces) is
 * left expanded rather than guessed at.
 */
export function collapseCalls(definition: WorkflowDefinition | Record<string, unknown>, calls: readonly ResolvedCall[]): Record<string, unknown> {
  const def = definition as { stages: Record<string, unknown>[] };
  let stages = [...def.stages];
  for (const c of calls) {
    const expected = expandCall({ id: c.callStageId }, c.stages);
    const at = stages.findIndex((s) => s.id === expected[0]?.id);
    if (at < 0) continue;
    const run = stages.slice(at, at + expected.length);
    if (JSON.stringify(run) !== JSON.stringify(expected)) continue;
    const call: CallStage = { id: c.callStageId, type: CALL_STAGE_TYPE, fragment: c.fragmentId, version: c.version };
    stages = [...stages.slice(0, at), call as unknown as Record<string, unknown>, ...stages.slice(at + expected.length)];
  }
  return { ...(definition as Record<string, unknown>), stages };
}
