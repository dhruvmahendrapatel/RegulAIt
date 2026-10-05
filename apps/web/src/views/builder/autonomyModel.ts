/**
 * ADR-0180 §5 (A8) — the autonomy class as the SPA sees it.
 *
 * The SPA does not depend on @regulait/shared, so the vocabulary and the
 * response shape below MIRROR `packages/shared/src/assurance.ts`
 * (AUTONOMY_CLASSES, AUTONOMY_CLASS_INFO) and `packages/shared/src/autonomy.ts`
 * (BuilderAgentAutonomyView). Change them together.
 */
export const AUTONOMY_CLASSES = ["assist", "supervised", "delegated", "autonomous"] as const;
export type AutonomyClass = (typeof AUTONOMY_CLASSES)[number];

export const AUTONOMY_CLASS_INFO: Readonly<Record<AutonomyClass, { label: string; description: string }>> = {
  assist: { label: "Assistant", description: "Answers when a person asks. It takes no action on its own." },
  supervised: { label: "Supervised", description: "Uses tools, but asks a person first before anything that changes data." },
  delegated: {
    label: "Delegated",
    description: "Acts within limits without asking: changes data, uses a computer or hands work to other agents.",
  },
  autonomous: { label: "Autonomous", description: "Runs unattended: starts work on a schedule or from incoming messages." },
};

export const autonomyLabel = (c: AutonomyClass) => AUTONOMY_CLASS_INFO[c].label;

export interface AutonomyReason {
  ruleId: string;
  class: AutonomyClass;
  basis: "setup" | "observed";
  text: string;
}

export interface AutonomyFloorCheck {
  id: string;
  minClass: AutonomyClass;
  label: string;
  met: boolean;
  detail: string;
  fix: string;
}

export interface BuilderAgentAutonomyView {
  agentId: string;
  observed: { class: AutonomyClass; reasons: AutonomyReason[]; facts: Record<string, number | boolean>; windowDays: number };
  declared: {
    class: AutonomyClass;
    note: string | null;
    declaredBy: { id: string; name: string | null } | null;
    declaredAt: string;
  } | null;
  effective: AutonomyClass;
  declaredBelowObserved: boolean;
  floors: AutonomyFloorCheck[];
  useCases: Array<{ id: string; name: string; status: string }>;
  scope: string;
}

/** the warning copy when a declaration is below the observed class */
export function belowObservedCopy(v: Pick<BuilderAgentAutonomyView, "declared" | "observed" | "effective">): string {
  if (!v.declared) return "";
  return (
    `You declared ${autonomyLabel(v.declared.class)}, but the agent is set up or seen acting as ${autonomyLabel(v.observed.class)}. ` +
    `The ${autonomyLabel(v.effective)} controls still apply, and governance monitoring reports the gap until the two match.`
  );
}

/** "2 of 4 not in place…" — the floor summary line */
export function floorSummary(floors: ReadonlyArray<Pick<AutonomyFloorCheck, "met">>): string {
  if (!floors.length) return "An assistant needs no extra controls.";
  const missing = floors.filter((f) => !f.met).length;
  return missing
    ? `${missing} of ${floors.length} not in place. While the assurance gate enforces (the default), a use case this agent serves is held until they are.`
    : `All ${floors.length} in place.`;
}
