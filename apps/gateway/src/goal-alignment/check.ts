/**
 * ADR-0359 §7 (lane E40) — goal alignment (OWASP ASI01, agent goal hijack): the pure half. Given an agent's declared
 * purpose and one tool call it made, say whether the call fits, why not, and which steering response the divergence
 * suggests in ADR-0354's vocabulary (PR #960). SHADOW ONLY: the suggestion is recorded on a finding; nothing here is
 * in a decision path and nothing it says changes a decision.
 *
 * The check is deterministic and explainable. A declared purpose is structured, not prose: the tools the purpose
 * needs, and whether it may write, run destructive writes or reach the open world. A call diverges when its tool is
 * not declared or it does something the purpose does not allow. The call's action comes from the same fail-closed
 * classification the agent risk score uses (`classifyCallTargets`, ADR-0339): an unknown tool counts as a destructive,
 * open-world write.
 */
import { AGENT_RESPONSE_TABLE, type AgentResponseKind } from "@regulait/policy-kernel";

/** why a call diverges from its agent's declared purpose, most severe last within the same response */
export const GOAL_DIVERGENCE_REASONS = [
  "no_declared_purpose",
  "tool_not_declared",
  "write_not_declared",
  "open_world_not_declared",
  "destructive_not_declared",
] as const;
export type GoalDivergenceReason = (typeof GOAL_DIVERGENCE_REASONS)[number];

/**
 * The declared steering table: each divergence suggests one ADR-0354 response. A suggestion is a label on a shadow
 * finding, for #960's policy authors and for lane E52's containment trigger; it is never applied here.
 *  - no declared purpose: advise (tell the steward to declare one; nothing can be judged yet);
 *  - a tool or an action the purpose does not name: correct (refuse and point the agent back to its declared tools);
 *  - a destructive write the purpose does not allow: block_session (the strongest signal short of disabling).
 */
export const GOAL_STEERING: Readonly<Record<GoalDivergenceReason, AgentResponseKind>> = Object.freeze({
  no_declared_purpose: "advise",
  tool_not_declared: "correct",
  write_not_declared: "correct",
  open_world_not_declared: "correct",
  destructive_not_declared: "block_session",
});

export const GOAL_TARGET_KINDS = ["mcp_tool", "connector"] as const;
export type GoalTargetKind = (typeof GOAL_TARGET_KINDS)[number];

export interface DeclaredPurpose {
  statement: string;
  allowWrite: boolean;
  allowDestructive: boolean;
  allowOpenWorld: boolean;
  /** `<kind>:<id>` of each declared tool */
  tools: readonly string[];
}

export interface GoalCall {
  targetKind: GoalTargetKind;
  /** mcp_tools.id or connectors.id; null when the tool is not in the registry */
  targetId: string | null;
  targetName: string;
  writes: boolean;
  destructive: boolean;
  openWorld: boolean;
}

export interface GoalVerdict {
  aligned: boolean;
  /** every reason that applies, in table order */
  reasons: GoalDivergenceReason[];
  /** the reason with the strictest suggested response (ties: the later reason in the table) */
  primary: GoalDivergenceReason | null;
  suggestedResponse: AgentResponseKind | null;
  explanation: string;
}

export const targetKey = (kind: GoalTargetKind, id: string) => `${kind}:${id}`;

function strictest(reasons: readonly GoalDivergenceReason[]): GoalDivergenceReason | null {
  let best: GoalDivergenceReason | null = null;
  for (const r of reasons) {
    if (!best || AGENT_RESPONSE_TABLE[GOAL_STEERING[r]].rank >= AGENT_RESPONSE_TABLE[GOAL_STEERING[best]].rank) best = r;
  }
  return best;
}

const actionWords = (c: Pick<GoalCall, "writes" | "destructive" | "openWorld">) =>
  [c.destructive ? "a destructive write" : c.writes ? "a write" : "a read", ...(c.openWorld ? ["reaching the open world"] : [])].join(", ");

/** Judge one call against the agent's declared purpose (null = none declared). */
export function evaluateGoalAlignment(purpose: DeclaredPurpose | null, call: GoalCall): GoalVerdict {
  const what = `${call.targetKind} '${call.targetName}' (${actionWords(call)})`;
  if (!purpose) {
    return {
      aligned: false,
      reasons: ["no_declared_purpose"],
      primary: "no_declared_purpose",
      suggestedResponse: GOAL_STEERING.no_declared_purpose,
      explanation: `${what}: the agent has no declared purpose, so no call can be judged against one; suggested response advise (declare its purpose)`,
    };
  }
  const reasons: GoalDivergenceReason[] = [];
  const declared = call.targetId !== null && purpose.tools.includes(targetKey(call.targetKind, call.targetId));
  if (!declared) reasons.push("tool_not_declared");
  if (call.writes && !purpose.allowWrite) reasons.push("write_not_declared");
  if (call.openWorld && !purpose.allowOpenWorld) reasons.push("open_world_not_declared");
  if (call.destructive && !purpose.allowDestructive) reasons.push("destructive_not_declared");
  const primary = strictest(reasons);
  const allowed = ["reads", ...(purpose.allowWrite ? ["writes"] : []), ...(purpose.allowDestructive ? ["destructive writes"] : []), ...(purpose.allowOpenWorld ? ["the open world"] : [])];
  const head = `${what} against the declared purpose (${purpose.tools.length} declared tools; allows ${allowed.join(", ")})`;
  if (!primary) return { aligned: true, reasons: [], primary: null, suggestedResponse: null, explanation: `${head}: fits` };
  const said: Record<GoalDivergenceReason, string> = {
    no_declared_purpose: "no declared purpose",
    tool_not_declared: "the tool is not one the purpose declares",
    write_not_declared: "the purpose does not allow writes",
    open_world_not_declared: "the purpose does not allow reaching the open world",
    destructive_not_declared: "the purpose does not allow destructive writes",
  };
  return {
    aligned: false,
    reasons,
    primary,
    suggestedResponse: GOAL_STEERING[primary],
    explanation: `${head}: DIVERGES — ${reasons.map((r) => said[r]).join("; ")}; suggested response ${GOAL_STEERING[primary]} (shadow: not applied)`,
  };
}
