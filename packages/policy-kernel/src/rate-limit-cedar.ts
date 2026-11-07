/**
 * ADR-0239 slice 1 — RATE LIMITS EVALUATED ON CEDAR.
 *
 * The kernel's rate-limit step asks one question: "which configured limit, if any, does this call exhaust?". Until
 * ADR-0239 the answer was a hand-written `Array.prototype.find` in `index.ts` (now `legacyRateLimitEvaluator`). This
 * module answers the same question with the Cedar engine ABAC already runs on (ADR-0040), so the match predicate is a
 * Cedar policy rather than JavaScript.
 *
 * SHAPE. Each limit in the request becomes one `RegulAIt::RateLimit` entity (its attributes are the limit's fields,
 * normalised exactly as the legacy predicate reads them) and one `forbid` policy that refers to that entity by its
 * POSITION ("0", "1", ...). The policy text therefore contains no stored value at all: no tool name, user id or
 * server id is ever spliced into Cedar source, so nothing a tenant writes can change a policy's structure. Every value
 * enters through entity and context JSON. Because the text depends only on the number of limits, a policy set is
 * parsed once per size and cached in the wasm module (`preparsePolicySet` / `statefulIsAuthorized`).
 *
 * WHICH LIMIT IS REPORTED. The legacy evaluator reports the FIRST exhausted limit in input order. Cedar reports the
 * set of satisfied `forbid`s; the lowest position in that set is the same limit.
 *
 * FAIL CLOSED. Any engine failure, any per-policy evaluation error (Cedar skips an erroring `forbid` and lists it in
 * `diagnostics.errors`, which would otherwise read as "nothing matched"), any count that is not a safe integer, or a
 * thrown exception is returned as `{ kind: "error" }`, which the kernel turns into a DENY. A rate-limit check that
 * cannot be evaluated never lets the call through.
 *
 * Like `abac.ts`, this file is imported only through its own subpath (`@regulait/policy-kernel/rate-limit-cedar`), so
 * importing the kernel never loads the wasm module. The gateway injects it through `EvaluationInput.rateLimitEvaluator`.
 */
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import type { RateLimit, RateLimitEvaluator, RateLimitMatchContext, RateLimitVerdict } from "./index.js";

const NS = "RegulAIt";
const ACTION: cedar.EntityUid = { type: `${NS}::Action`, id: "RateLimitCheck" };
const PRINCIPAL: cedar.EntityUid = { type: `${NS}::Caller`, id: "caller" };
const RESOURCE: cedar.EntityUid = { type: `${NS}::Call`, id: "call" };

/** The Cedar schema the rate-limit policies are validated against. Bump the version if it changes. */
export const RATE_LIMIT_CEDAR_SCHEMA_TEXT = `
namespace ${NS} {
  entity Caller;
  entity Call;
  entity RateLimit = {
    scope: String,
    userId?: String,
    serverScope: String,
    serverId?: String,
    deployMode?: String,
    allTools: Bool,
    toolName?: String,
    currentCount: Long,
    maxCalls: Long,
  };
  action RateLimitCheck appliesTo {
    principal: [Caller],
    resource: [Call],
    context: {
      userId: String,
      serverId: String,
      toolName: String,
      deployContext: Set<String>,
    },
  };
}
`;

const SCHEMA_NAME = "regulait-rate-limit-v1";
const PSET_PREFIX = "regulait-rate-limit-v1-";
/** Policy sets up to this size are parsed once and cached; larger ones are parsed per call (still correct). */
const MAX_CACHED_SIZE = 256;

/**
 * The policy for the limit at position `i`. `i` is the only thing that varies, so the text is fixed per position.
 *
 * Each clause mirrors one half of the legacy predicate (`index.ts`):
 *   subject      `(scope ?? "user") === "user" ? r.userId === userId : true`
 *   server       `(serverScope ?? "server") === "all" ? true : r.serverId === serverId`
 *   deploy mode  `r.deployMode == null ? true : deployContext.includes(r.deployMode)`
 *   tool         `r.toolName === null || r.toolName === tool.name`
 *   exhausted    `currentCount >= maxCalls`
 */
export function rateLimitPolicyText(i: number): string {
  const L = `${NS}::RateLimit::"${i}"`;
  return [
    `forbid (principal, action == ${NS}::Action::"RateLimitCheck", resource)`,
    `when {`,
    `  (${L}.scope != "user" || (${L} has userId && ${L}.userId == context.userId)) &&`,
    `  (${L}.serverScope == "all" || (${L} has serverId && ${L}.serverId == context.serverId)) &&`,
    `  (if ${L} has deployMode then context.deployContext.contains(${L}.deployMode) else true) &&`,
    `  (${L}.allTools || (${L} has toolName && ${L}.toolName == context.toolName)) &&`,
    `  ${L}.currentCount >= ${L}.maxCalls`,
    `};`,
  ].join("\n");
}

function policyId(i: number): string {
  return `rate-limit-${i}`;
}

export function rateLimitPolicySet(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[policyId(i)] = rateLimitPolicyText(i);
  return out;
}

let schemaReady = false;
const preparsed = new Set<number>();

function ensureSchema(): void {
  if (schemaReady) return;
  const answer = cedar.preparseSchema(SCHEMA_NAME, RATE_LIMIT_CEDAR_SCHEMA_TEXT);
  if (answer.type !== "success") {
    throw new Error(`rate-limit schema failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  }
  schemaReady = true;
}

function ensurePolicySet(n: number): string | null {
  if (n > MAX_CACHED_SIZE) return null;
  const id = `${PSET_PREFIX}${n}`;
  if (preparsed.has(n)) return id;
  const answer = cedar.preparsePolicySet(id, { staticPolicies: rateLimitPolicySet(n) });
  if (answer.type !== "success") {
    throw new Error(`rate-limit policy set failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  }
  preparsed.add(n);
  return id;
}

/** Normalise one limit into the entity the policy reads. Throws on a count Cedar cannot represent exactly. */
function limitEntity(l: RateLimit, i: number): cedar.EntityJson {
  if (!Number.isSafeInteger(l.currentCount) || !Number.isSafeInteger(l.maxCalls)) {
    throw new Error(`rate limit ${l.id} has a non-integer count or maximum`);
  }
  const attrs: Record<string, cedar.CedarValueJson> = {
    scope: String(l.scope ?? "user"),
    serverScope: String(l.serverScope ?? "server"),
    allTools: l.toolName === null,
    currentCount: l.currentCount,
    maxCalls: l.maxCalls,
  };
  if (typeof l.userId === "string") attrs.userId = l.userId;
  if (typeof l.serverId === "string") attrs.serverId = l.serverId;
  if (l.deployMode != null) attrs.deployMode = String(l.deployMode);
  if (typeof l.toolName === "string") attrs.toolName = l.toolName;
  return { uid: { type: `${NS}::RateLimit`, id: String(i) }, attrs, parents: [] };
}

function evaluateOnCedar(limits: readonly RateLimit[], ctx: RateLimitMatchContext): RateLimitVerdict {
  ensureSchema();
  const entities = limits.map(limitEntity);
  const context: cedar.Context = {
    userId: ctx.userId,
    serverId: ctx.serverId,
    toolName: ctx.toolName,
    deployContext: [...(ctx.deployContext ?? [])],
  };
  const psetId = ensurePolicySet(limits.length);
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
        schema: RATE_LIMIT_CEDAR_SCHEMA_TEXT,
        validateRequest: true,
        policies: { staticPolicies: rateLimitPolicySet(limits.length) },
        entities,
      });
  if (answer.type === "failure") {
    return { kind: "error", message: answer.errors.map((e) => e.message).join("; ") };
  }
  const { diagnostics } = answer.response;
  if (diagnostics.errors.length > 0) {
    return {
      kind: "error",
      message: diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`).join("; "),
    };
  }
  let first = -1;
  for (const id of diagnostics.reason) {
    const i = Number(id.slice("rate-limit-".length));
    if (!Number.isInteger(i) || i < 0 || i >= limits.length) {
      return { kind: "error", message: `unexpected policy id ${id}` };
    }
    if (first === -1 || i < first) first = i;
  }
  return first === -1 ? { kind: "none" } : { kind: "exhausted", limit: limits[first]! };
}

/** The Cedar rate-limit evaluator (the default from ADR-0239). Never throws: every failure is an `error` verdict. */
export const cedarRateLimitEvaluator: RateLimitEvaluator = {
  engine: `cedar-wasm@${cedar.getCedarVersion()}`,
  firstExhausted(limits, ctx) {
    if (limits.length === 0) return { kind: "none" };
    try {
      return evaluateOnCedar(limits, ctx);
    } catch (e) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
  },
};
