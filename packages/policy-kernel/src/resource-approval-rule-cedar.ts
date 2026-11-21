/**
 * ADR-0239 slice 2b — the approval-rule MATCH for model, connector and A2A calls (the ADR-0251 decision core) on Cedar
 * (`@cedar-policy/cedar-wasm`, already pinned for ABAC, rate limits and the MCP approval match).
 *
 * Which `resource_approval_rules` bind a call was a hand-written conjunction in `resource.ts`
 * (`matchingResourceApprovalRules`): same resource type, every resource or this one, and `writeOnly` only on a write.
 * This evaluator asks Cedar instead, with the shape of the MCP evaluator (`approval-rule-cedar.ts`):
 *
 *  - each rule is a `RegulAIt::ResourceApprovalRule` entity carrying its fields, and gets one `forbid` policy that
 *    names the entity only by its POSITION. No stored value ever reaches policy text;
 *  - ALL of a call's rules go to Cedar in ONE `isAuthorized` request (one batched evaluation per call), against a
 *    small validated schema, with the policy set preparsed once per size (cached up to 256 rules);
 *  - Cedar returns the satisfied forbids as an unordered set; the kernel sorts them most specific first, in
 *    TypeScript, as before;
 *  - any engine failure, per-policy error or exception is an ERROR verdict, which the kernel turns into a deny
 *    (`approval-rule-engine-error`): an error never reads as "nothing matched".
 *
 * PRE-FILTER. A rule for another resource type, or bound to one other resource, can never be Cedar's answer (both are
 * conjuncts of every policy), so it is dropped before the wasm call. The gateway already loads only the caller's rules
 * for this resource, so in practice the filter is a guard, and a call with no rule makes no wasm call.
 *
 * ONE CALL PER GOVERNED CALL. The gateway reads the matched rules (to bind consents) and the kernel composes the
 * decision, sometimes twice (the hard-window path). `perCallResourceApprovalRuleEvaluator` wraps the engine for one
 * governed call so all of those reads share one Cedar answer.
 *
 * Loaded only through `@regulait/policy-kernel/resource-approval-rule-cedar`, so importing the kernel never loads wasm.
 */
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { resourceIsWrite, type GovernedResource, type ResourceApprovalRule, type ResourceApprovalRuleEvaluator, type ResourceApprovalRuleVerdict } from "./resource.js";

const NS = "RegulAIt";
const ACTION: cedar.EntityUid = { type: `${NS}::Action`, id: "ResourceApprovalRuleCheck" };
const PRINCIPAL: cedar.EntityUid = { type: `${NS}::Caller`, id: "caller" };
const RESOURCE: cedar.EntityUid = { type: `${NS}::GovernedCall`, id: "call" };

export const RESOURCE_APPROVAL_RULE_CEDAR_SCHEMA_TEXT = `
namespace ${NS} {
  entity Caller;
  entity GovernedCall;
  entity ResourceApprovalRule = {
    resourceType: String,
    allResources: Bool,
    resourceId?: String,
    writeOnly: Bool,
  };
  action ResourceApprovalRuleCheck appliesTo {
    principal: [Caller],
    resource: [GovernedCall],
    context: {
      resourceType: String,
      resourceId: String,
      isWrite: Bool,
    },
  };
}
`;

const SCHEMA_NAME = "regulait-resource-approval-rule-v1";
const PSET_PREFIX = "regulait-resource-approval-rule-v1-";
const MAX_CACHED_SIZE = 256;
const POLICY_PREFIX = "resource-approval-rule-";

/** the policy for the rule at position `i`: the old predicate, conjunct for conjunct */
export function resourceApprovalRulePolicyText(i: number): string {
  const R = `${NS}::ResourceApprovalRule::"${i}"`;
  return [
    `forbid (principal, action == ${NS}::Action::"ResourceApprovalRuleCheck", resource)`,
    `when {`,
    `  ${R}.resourceType == context.resourceType &&`,
    `  (${R}.allResources || (${R} has resourceId && ${R}.resourceId == context.resourceId)) &&`,
    `  (!${R}.writeOnly || context.isWrite)`,
    `};`,
  ].join("\n");
}

export function resourceApprovalRulePolicySet(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`${POLICY_PREFIX}${i}`] = resourceApprovalRulePolicyText(i);
  return out;
}

let schemaReady = false;
const preparsed = new Set<number>();

function ensureSchema(): void {
  if (schemaReady) return;
  const answer = cedar.preparseSchema(SCHEMA_NAME, RESOURCE_APPROVAL_RULE_CEDAR_SCHEMA_TEXT);
  if (answer.type !== "success") {
    throw new Error(`resource approval-rule schema failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  }
  schemaReady = true;
}

function ensurePolicySet(n: number): string | null {
  if (n > MAX_CACHED_SIZE) return null;
  const id = `${PSET_PREFIX}${n}`;
  if (preparsed.has(n)) return id;
  const answer = cedar.preparsePolicySet(id, { staticPolicies: resourceApprovalRulePolicySet(n) });
  if (answer.type !== "success") {
    throw new Error(`resource approval-rule policy set failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  }
  preparsed.add(n);
  return id;
}

/** `resourceId: null` is "every resource of the type"; an absent one (undefined) binds no resource, exactly as `binds`.
 * `writeOnly` is read for truthiness, as the old `!r.writeOnly`. */
function ruleEntity(r: ResourceApprovalRule, i: number): cedar.EntityJson {
  const attrs: Record<string, cedar.CedarValueJson> = {
    resourceType: String(r.resourceType),
    allResources: r.resourceId === null,
    writeOnly: Boolean(r.writeOnly),
  };
  if (typeof r.resourceId === "string") attrs.resourceId = r.resourceId;
  return { uid: { type: `${NS}::ResourceApprovalRule`, id: String(i) }, attrs, parents: [] };
}

function evaluateOnCedar(rules: readonly ResourceApprovalRule[], resource: GovernedResource): ResourceApprovalRuleVerdict {
  ensureSchema();
  const entities = rules.map(ruleEntity);
  const context: cedar.Context = { resourceType: resource.type, resourceId: resource.id, isWrite: resourceIsWrite(resource) };
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
        schema: RESOURCE_APPROVAL_RULE_CEDAR_SCHEMA_TEXT,
        validateRequest: true,
        policies: { staticPolicies: resourceApprovalRulePolicySet(rules.length) },
        entities,
      });
  if (answer.type === "failure") {
    return { kind: "error", message: answer.errors.map((e) => e.message).join("; ") };
  }
  const { diagnostics } = answer.response;
  // a skipped erroring forbid would otherwise read as "this rule does not bind" (fail open)
  if (diagnostics.errors.length > 0) {
    return { kind: "error", message: diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`).join("; ") };
  }
  const matched: ResourceApprovalRule[] = [];
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
/** wasm calls made so far (tests pin the pre-filter and the one-call-per-governed-call memo with it) */
export function resourceApprovalRuleCedarCallCount(): number {
  return wasmCalls;
}

function guarded(rules: readonly ResourceApprovalRule[], resource: GovernedResource): ResourceApprovalRuleVerdict {
  if (rules.length === 0) return { kind: "matched", rules: [] };
  try {
    wasmCalls++;
    return evaluateOnCedar(rules, resource);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** can this rule possibly be Cedar's answer? false only when the type or a one-resource binding is plainly another */
function possiblyBinds(r: ResourceApprovalRule, resource: GovernedResource): boolean {
  if (r.resourceType !== resource.type) return false;
  if (typeof r.resourceId === "string" && r.resourceId !== resource.id) return false;
  return true;
}

const ENGINE = `cedar-wasm@${cedar.getCedarVersion()}`;

/** Every rule goes to Cedar (no pre-filter). For the differential test. */
export const cedarResourceApprovalRuleEvaluatorUnfiltered: ResourceApprovalRuleEvaluator = { engine: ENGINE, matching: guarded };

/** The engine: pre-filtered, then Cedar decides every rule that could bind, in one request. */
export const cedarResourceApprovalRuleEvaluator: ResourceApprovalRuleEvaluator = {
  engine: ENGINE,
  matching(rules, resource) {
    return guarded(
      rules.filter((r) => possiblyBinds(r, resource)),
      resource,
    );
  },
};

/**
 * THE evaluator the gateway gives one governed call: the engine's answer for that call's rule set is computed once and
 * reused by every later read of the SAME rules array (unchanged length) for the SAME call (type, id, write). Anything
 * else is passed through to the engine, so a reuse can never answer for a different call. Errors are not kept: a later
 * read asks again, and an error there still denies.
 */
export function perCallResourceApprovalRuleEvaluator(engine: ResourceApprovalRuleEvaluator = cedarResourceApprovalRuleEvaluator): ResourceApprovalRuleEvaluator {
  let last: { rules: readonly ResourceApprovalRule[]; length: number; key: string; verdict: ResourceApprovalRuleVerdict } | null = null;
  return {
    engine: engine.engine,
    matching(rules, resource) {
      const key = `${resource.type}\u0000${resource.id}\u0000${resourceIsWrite(resource) ? "w" : "r"}`;
      if (last && last.rules === rules && last.length === rules.length && last.key === key) return last.verdict;
      const verdict = engine.matching(rules, resource);
      last = verdict.kind === "matched" ? { rules, length: rules.length, key, verdict } : null;
      return verdict;
    },
  };
}
