/**
 * ADR-0239 slice 2 — the approval-rule MATCH on Cedar (`@cedar-policy/cedar-wasm`, already pinned for ABAC and rate
 * limits).
 *
 * Which approval rules bind an MCP tool call was a hand-written conjunction in `index.ts` (`matchingApprovalRules`).
 * This evaluator asks Cedar instead, with the same shape as the rate-limit evaluator (`rate-limit-cedar.ts`):
 *
 *  - each rule is a `RegulAIt::ApprovalRule` entity carrying its fields, and gets one `forbid` policy that names the
 *    entity only by its POSITION. No stored value ever reaches policy text, so a tool name such as `x") || true || ("`
 *    cannot change a policy;
 *  - the policies are validated against a small schema and the policy set is preparsed once per size (cached up to
 *    256 rules; larger sets are parsed per call);
 *  - Cedar returns the satisfied forbids as an unordered set; the kernel sorts them by ADR-0229 precedence, and the
 *    gateway rolls up the strictest ADR-0104 scope, in TypeScript, as before;
 *  - any engine failure, per-policy error or exception is an ERROR verdict, which the kernel turns into a deny
 *    (`approval-rule-engine-error`): an error never reads as "nothing matched".
 *
 * PRE-FILTER (the latency budget, as ADR-0239 review finding 1 did for rate limits). A rule bound to ONE server that
 * is not this call's server, or a user-scoped rule for another user, can never be Cedar's answer: the server and
 * subject conjuncts are part of every policy. Those rules are dropped before the wasm call, so the common case (rules
 * that live on other servers or belong to other people) makes no wasm call. Cedar still decides every rule that could
 * match. The differential test holds the result to the hand-written predicate.
 *
 * Loaded only through `@regulait/policy-kernel/approval-rule-cedar`, so importing the kernel never loads wasm.
 */
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import type { ApprovalRule, ApprovalRuleEvaluator, ApprovalRuleMatchContext, ApprovalRuleVerdict } from "./index.js";

const NS = "RegulAIt";
const ACTION: cedar.EntityUid = { type: `${NS}::Action`, id: "ApprovalRuleCheck" };
const PRINCIPAL: cedar.EntityUid = { type: `${NS}::Caller`, id: "caller" };
const RESOURCE: cedar.EntityUid = { type: `${NS}::Call`, id: "call" };

export const APPROVAL_RULE_CEDAR_SCHEMA_TEXT = `
namespace ${NS} {
  entity Caller;
  entity Call;
  entity ApprovalRule = {
    scope: String,
    userId?: String,
    serverScope: String,
    serverId?: String,
    deployMode?: String,
    allTools: Bool,
    toolName?: String,
    writeOnly: Bool,
  };
  action ApprovalRuleCheck appliesTo {
    principal: [Caller],
    resource: [Call],
    context: {
      userId: String,
      serverId: String,
      toolName: String,
      toolKind: String,
      deployContext: Set<String>,
    },
  };
}
`;

const SCHEMA_NAME = "regulait-approval-rule-v1";
const PSET_PREFIX = "regulait-approval-rule-v1-";
const MAX_CACHED_SIZE = 256;
const POLICY_PREFIX = "approval-rule-";

/** the policy for the rule at position `i`: the old predicate, conjunct for conjunct */
export function approvalRulePolicyText(i: number): string {
  const R = `${NS}::ApprovalRule::"${i}"`;
  return [
    `forbid (principal, action == ${NS}::Action::"ApprovalRuleCheck", resource)`,
    `when {`,
    `  (${R}.scope != "user" || (${R} has userId && ${R}.userId == context.userId)) &&`,
    `  (${R}.serverScope == "all" || (${R} has serverId && ${R}.serverId == context.serverId)) &&`,
    `  (if ${R} has deployMode then context.deployContext.contains(${R}.deployMode) else true) &&`,
    `  (${R}.allTools || (${R} has toolName && ${R}.toolName == context.toolName)) &&`,
    `  (!${R}.writeOnly || context.toolKind == "write")`,
    `};`,
  ].join("\n");
}

export function approvalRulePolicySet(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`${POLICY_PREFIX}${i}`] = approvalRulePolicyText(i);
  return out;
}

let schemaReady = false;
const preparsed = new Set<number>();

function ensureSchema(): void {
  if (schemaReady) return;
  const answer = cedar.preparseSchema(SCHEMA_NAME, APPROVAL_RULE_CEDAR_SCHEMA_TEXT);
  if (answer.type !== "success") {
    throw new Error(`approval-rule schema failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  }
  schemaReady = true;
}

function ensurePolicySet(n: number): string | null {
  if (n > MAX_CACHED_SIZE) return null;
  const id = `${PSET_PREFIX}${n}`;
  if (preparsed.has(n)) return id;
  const answer = cedar.preparsePolicySet(id, { staticPolicies: approvalRulePolicySet(n) });
  if (answer.type !== "success") {
    throw new Error(`approval-rule policy set failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  }
  preparsed.add(n);
  return id;
}

/** `toolName: null` is "every tool"; an absent tool name (undefined) matches no tool, exactly as `matchesScope` */
function ruleEntity(r: ApprovalRule, i: number): cedar.EntityJson {
  const attrs: Record<string, cedar.CedarValueJson> = {
    scope: String(r.scope ?? "user"),
    serverScope: String(r.serverScope ?? "server"),
    allTools: r.toolName === null,
    writeOnly: r.writeOnly === true,
  };
  if (typeof r.userId === "string") attrs.userId = r.userId;
  if (typeof r.serverId === "string") attrs.serverId = r.serverId;
  if (r.deployMode != null) attrs.deployMode = String(r.deployMode);
  if (typeof r.toolName === "string") attrs.toolName = r.toolName;
  return { uid: { type: `${NS}::ApprovalRule`, id: String(i) }, attrs, parents: [] };
}

function evaluateOnCedar(rules: readonly ApprovalRule[], ctx: ApprovalRuleMatchContext): ApprovalRuleVerdict {
  ensureSchema();
  const entities = rules.map(ruleEntity);
  const context: cedar.Context = {
    userId: ctx.userId,
    serverId: ctx.serverId,
    toolName: ctx.toolName,
    toolKind: ctx.toolKind,
    deployContext: [...(ctx.deployContext ?? [])],
  };
  const psetId = ensurePolicySet(rules.length);
  const answer = psetId
    ? cedar.statefulIsAuthorized({
        principal: PRINCIPAL,
        action: ACTION,
        resource: RESOURCE,
        context,
        preparsedSchemaName: SCHEMA_NAME,
        validateRequest: true,
        preparsedPolicySetId: psetId,
        entities,
      })
    : cedar.isAuthorized({
        principal: PRINCIPAL,
        action: ACTION,
        resource: RESOURCE,
        context,
        schema: APPROVAL_RULE_CEDAR_SCHEMA_TEXT,
        validateRequest: true,
        policies: { staticPolicies: approvalRulePolicySet(rules.length) },
        entities,
      });
  if (answer.type === "failure") {
    return { kind: "error", message: answer.errors.map((e) => e.message).join("; ") };
  }
  const { diagnostics } = answer.response;
  // a skipped erroring forbid would otherwise read as "this rule does not match" (fail open)
  if (diagnostics.errors.length > 0) {
    return { kind: "error", message: diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`).join("; ") };
  }
  const matched: ApprovalRule[] = [];
  for (const id of diagnostics.reason) {
    const i = Number(id.slice(POLICY_PREFIX.length));
    if (!id.startsWith(POLICY_PREFIX) || !Number.isInteger(i) || i < 0 || i >= rules.length) {
      return { kind: "error", message: `unexpected policy id ${id}` };
    }
    matched.push(rules[i]!);
  }
  return { kind: "matched", rules: matched };
}

let wasmCalls = 0;
/** wasm calls made so far (tests pin the pre-filter with it) */
export function approvalRuleCedarCallCount(): number {
  return wasmCalls;
}

function guarded(rules: readonly ApprovalRule[], ctx: ApprovalRuleMatchContext): ApprovalRuleVerdict {
  if (rules.length === 0) return { kind: "matched", rules: [] };
  try {
    wasmCalls++;
    return evaluateOnCedar(rules, ctx);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** can this rule possibly be Cedar's answer? false only when a server or user-subject conjunct is plainly false */
function possiblyMatches(r: ApprovalRule, ctx: ApprovalRuleMatchContext): boolean {
  if ((r.serverScope ?? "server") === "server" && r.serverId !== ctx.serverId) return false;
  if ((r.scope ?? "user") === "user" && r.userId !== ctx.userId) return false;
  return true;
}

/** Every rule goes to Cedar (no pre-filter). For the differential test. */
export const cedarApprovalRuleEvaluatorUnfiltered: ApprovalRuleEvaluator = {
  engine: `cedar-wasm@${cedar.getCedarVersion()}`,
  matching: guarded,
};

/** THE evaluator the gateway injects: pre-filtered, then Cedar decides every rule that could match. */
export const cedarApprovalRuleEvaluator: ApprovalRuleEvaluator = {
  engine: `cedar-wasm@${cedar.getCedarVersion()}`,
  matching(rules, ctx) {
    return guarded(
      rules.filter((r) => possiblyMatches(r, ctx)),
      ctx,
    );
  },
};
