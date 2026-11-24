/**
 * ADR-0354 — GRADUATED, AGENT-STEERING RESPONSES: the one response vocabulary.
 *
 * The kernel's `DecisionEffect` (allow / deny / require_approval) says what is ENFORCED. A response says what the
 * agent is TOLD and what happens to its session or to the agent itself. Every response maps onto exactly one effect,
 * so every existing consumer of `effect` (the dispatch paths, the audit writer, the approvals queue) keeps acting
 * correctly on a response it has never heard of; only the surfaces that answer an agent (the gateway's refusal body,
 * the endpoint hook adapters) read the response itself.
 *
 * The table below is the single declaration. The gateway (ADR-0251), the Cedar policy modes (ADR-0040) and the
 * endpoint hook adapters (ADR-0298 / ADR-0330, Go) all use it: the Go agent carries a mirror that a parity test pins
 * to the golden file `agents/endpoint/internal/enforce/testdata/responses/v1.json`, which this package's test also
 * reads, so the two languages cannot drift.
 *
 * Pure, zero I/O, zero dependencies (the kernel's rule).
 */
import type { DecisionEffect } from "./index.js";

/** the vocabulary, ordered from least to most restrictive */
export const AGENT_RESPONSES = ["allow", "advise", "ask", "correct", "deny", "block_session", "disable"] as const;
export type AgentResponseKind = (typeof AGENT_RESPONSES)[number];

/** the responses a Cedar policy may name as its mode (ADR-0040). `allow` is absent: ABAC never grants. */
export const POLICY_RESPONSES = ["advise", "require_approval", "correct", "forbid", "block_session", "disable"] as const;
export type PolicyResponseMode = (typeof POLICY_RESPONSES)[number];

export interface AgentResponseSpec {
  readonly kind: AgentResponseKind;
  /** what is enforced: every response is exactly one kernel effect */
  readonly effect: DecisionEffect;
  /** whether the response carries agent guidance: `required` means a policy naming it must supply a message */
  readonly guidance: "none" | "required";
  /** whether the response carries a safe alternative (Correct only); it is text the agent may act on, never a grant */
  readonly alternative: "none" | "required";
  /** what happens to the agent session the call came from */
  readonly session: "continues" | "ends";
  /** what happens to the agent itself. `quarantine` is narrowing-only: it can set a halt, never lift one. */
  readonly agent: "unchanged" | "quarantine";
  /**
   * How much the response restricts, for "is this change a relaxation?" (ADR-0180: relaxing is an audited
   * `settings_relax` step-up). Responses with the same effect and side effects share a rank: `correct` is a deny with
   * guidance, so moving between deny and correct neither widens nor narrows what runs.
   */
  readonly rank: number;
  /** the rule id the audit row carries for a decision answered with this response */
  readonly auditRuleId: string;
}

/**
 * THE DECLARED TABLE. One row per response; nothing else in the product decides what a response means.
 */
export const AGENT_RESPONSE_TABLE: Readonly<Record<AgentResponseKind, AgentResponseSpec>> = Object.freeze({
  allow: Object.freeze({ kind: "allow", effect: "allow", guidance: "none", alternative: "none", session: "continues", agent: "unchanged", rank: 0, auditRuleId: "response-allow" }),
  advise: Object.freeze({ kind: "advise", effect: "allow", guidance: "required", alternative: "none", session: "continues", agent: "unchanged", rank: 0, auditRuleId: "response-advise" }),
  ask: Object.freeze({ kind: "ask", effect: "require_approval", guidance: "none", alternative: "none", session: "continues", agent: "unchanged", rank: 1, auditRuleId: "response-ask" }),
  correct: Object.freeze({ kind: "correct", effect: "deny", guidance: "required", alternative: "required", session: "continues", agent: "unchanged", rank: 2, auditRuleId: "response-correct" }),
  deny: Object.freeze({ kind: "deny", effect: "deny", guidance: "none", alternative: "none", session: "continues", agent: "unchanged", rank: 2, auditRuleId: "response-deny" }),
  block_session: Object.freeze({ kind: "block_session", effect: "deny", guidance: "none", alternative: "none", session: "ends", agent: "unchanged", rank: 3, auditRuleId: "response-block-session" }),
  disable: Object.freeze({ kind: "disable", effect: "deny", guidance: "none", alternative: "none", session: "ends", agent: "quarantine", rank: 4, auditRuleId: "response-disable" }),
});

/** a policy mode's response (`forbid` is `deny`, `require_approval` is `ask`; the rest are their own names) */
export function responseOfPolicyMode(mode: PolicyResponseMode): AgentResponseKind {
  if (mode === "forbid") return "deny";
  if (mode === "require_approval") return "ask";
  return mode;
}

export function isPolicyResponseMode(v: unknown): v is PolicyResponseMode {
  return typeof v === "string" && (POLICY_RESPONSES as readonly string[]).includes(v);
}

export function isAgentResponseKind(v: unknown): v is AgentResponseKind {
  return typeof v === "string" && (AGENT_RESPONSES as readonly string[]).includes(v);
}

/**
 * Is changing a policy from `from` to `to` a relaxation (less is restricted afterwards)? A relaxation is a
 * `settings_relax` step-up and is audited (ADR-0180); a tightening is not. `block` → `advise` is the headline case.
 */
export function isResponseRelaxation(from: AgentResponseKind, to: AgentResponseKind): boolean {
  return AGENT_RESPONSE_TABLE[to].rank < AGENT_RESPONSE_TABLE[from].rank;
}

/**
 * Precedence among several matched policies: the strictest wins. Within one rank, a plain `deny` beats `correct`
 * (guidance written for one rule must not be shown as the answer to a refusal another rule made), and otherwise the
 * vocabulary order decides. Returns a negative number when `a` governs.
 */
export function compareResponseStrictness(a: AgentResponseKind, b: AgentResponseKind): number {
  const ra = AGENT_RESPONSE_TABLE[a].rank;
  const rb = AGENT_RESPONSE_TABLE[b].rank;
  if (ra !== rb) return rb - ra;
  return AGENT_RESPONSES.indexOf(b) - AGENT_RESPONSES.indexOf(a);
}

/**
 * Agent guidance: static, admin-authored policy text, already validated as plain text by
 * `@regulait/shared`'s `parseAgentGuidance` before it is stored. Never model output, never call arguments, never
 * HTML: surfaces render it as a JSON string, so an agent or UI receives data, not markup.
 */
export interface AgentGuidance {
  readonly message: string;
  /** Correct only: the approved route the agent may take instead. Advisory text; it carries no grant or consent. */
  readonly alternative?: string;
}

/** the response a decision is answered with, as it travels to the agent and into the audit row */
export interface AgentResponse {
  readonly kind: AgentResponseKind;
  readonly effect: DecisionEffect;
  /** the policy that chose it (null for a response derived from the effect alone) */
  readonly policyId: string | null;
  readonly guidance: AgentGuidance | null;
  readonly endSession: boolean;
  readonly quarantineAgent: boolean;
}

/** what a matched policy contributes: its mode and its stored guidance */
export interface PolicyResponseSource {
  readonly policyId: string;
  readonly mode: PolicyResponseMode;
  readonly guidance?: AgentGuidance | null;
}

function build(kind: AgentResponseKind, policyId: string | null, guidance: AgentGuidance | null): AgentResponse {
  const spec = AGENT_RESPONSE_TABLE[kind];
  return Object.freeze({
    kind,
    effect: spec.effect,
    policyId,
    guidance: spec.guidance === "required" ? guidance : null,
    endSession: spec.session === "ends",
    quarantineAgent: spec.agent === "quarantine",
  });
}

/** the plain response for an effect, when no policy chose a graduated one */
export function responseOfEffect(effect: DecisionEffect): AgentResponse {
  return build(effect === "allow" ? "allow" : effect === "deny" ? "deny" : "ask", null, null);
}

/**
 * THE ONE RESOLVER. Given the kernel's final decision and the policy that governed the ABAC step, the response the
 * agent gets. Error is the plain effect, never a wider one:
 *
 *  - The response's effect must EQUAL the decision's effect. A policy's response is used only when the decision is
 *    the one that policy produced (`decisionRuleId === policyId`) or, for `advise`, when the decision is an allow.
 *    So a graduated response can never change what is enforced: `advise` never rescues a deny, and a `correct`
 *    written for one rule never decorates another rule's refusal.
 *  - Guidance that is missing where the table requires it degrades to the plain response of the same effect
 *    (`correct` without an alternative answers `deny`; `advise` without a message answers `allow`).
 */
export function resolveAgentResponse(
  decision: { readonly effect: DecisionEffect; readonly ruleId: string },
  governing: PolicyResponseSource | null | undefined,
): AgentResponse {
  if (!governing || !isPolicyResponseMode(governing.mode)) return responseOfEffect(decision.effect);
  const kind = responseOfPolicyMode(governing.mode);
  const spec = AGENT_RESPONSE_TABLE[kind];
  if (spec.effect !== decision.effect) return responseOfEffect(decision.effect);
  if (kind !== "advise" && decision.ruleId !== governing.policyId) return responseOfEffect(decision.effect);
  const g = governing.guidance ?? null;
  if (spec.guidance === "required" && !g?.message) return responseOfEffect(decision.effect);
  if (spec.alternative === "required" && !g?.alternative) return responseOfEffect(decision.effect);
  return build(kind, governing.policyId, g);
}

/**
 * Attach the graduated response to a decision, or return the decision UNCHANGED when the response is the plain one
 * for its effect. So every decision that no graduated policy touched stays byte-identical to the pre-ADR-0354
 * kernel output, and `response` on a decision always means "a policy chose how to answer the agent".
 */
export function withAgentResponse<D extends { readonly effect: DecisionEffect; readonly ruleId: string }>(
  decision: D,
  governing: PolicyResponseSource | null | undefined,
): D & { response?: AgentResponse } {
  const r = resolveAgentResponse(decision, governing);
  if (r.kind === responseOfEffect(decision.effect).kind) return decision;
  return { ...decision, response: r };
}

/** the response a decision is answered with: its attached graduated response, else the plain one */
export function responseOfDecision(d: { readonly effect: DecisionEffect; readonly response?: AgentResponse }): AgentResponse {
  return d.response ?? responseOfEffect(d.effect);
}

/** the audit row's record of the response (every decision row carries one; ADR-0354 "every response is audited") */
export function agentResponseAuditFacts(d: { readonly effect: DecisionEffect; readonly response?: AgentResponse }): {
  kind: AgentResponseKind;
  ruleId: string;
  policyId: string | null;
  endSession: boolean;
  quarantineAgent: boolean;
} {
  const r = responseOfDecision(d);
  return {
    kind: r.kind,
    ruleId: AGENT_RESPONSE_TABLE[r.kind].auditRuleId,
    policyId: r.policyId,
    endSession: r.endSession,
    quarantineAgent: r.quarantineAgent,
  };
}

/** the agent-facing projection: structured data only, safe to serialise as JSON to any agent or client */
export function agentResponseBody(r: AgentResponse): {
  response: AgentResponseKind;
  message?: string;
  alternative?: string;
  sessionEnded?: true;
} {
  return {
    response: r.kind,
    ...(r.guidance?.message ? { message: r.guidance.message } : {}),
    ...(r.guidance?.alternative ? { alternative: r.guidance.alternative } : {}),
    ...(r.endSession ? { sessionEnded: true as const } : {}),
  };
}
