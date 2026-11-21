/**
 * ADR-0333 — DETECTION SELECTORS EVALUATED ON CEDAR.
 *
 * A detection rule's selector answers one question per audit event: "does this event match?". The answer is a Cedar
 * policy, on the engine ABAC (ADR-0040), rate limits (ADR-0239) and approval rules already run on, never a
 * hand-written predicate. The engine is pinned, in-process WebAssembly, so it runs air-gapped.
 *
 * TWO POLICY SETS.
 *   Tool classes  one `permit` per glob, `context.toolName like "<glob>"`, Cedar's own wildcard match. A glob is the
 *                 only pack value that enters policy text, because `like` takes a literal pattern. The pack schema
 *                 holds globs to `[a-z0-9_.:*-]`, so no quote, backslash or brace can reach the source, and the set
 *                 must parse to exactly one policy per glob. It is parsed once per distinct class table.
 *   Selectors     one `permit` per selector POSITION, reading the selector as an entity (`RegulAIt::Selector::"i"`).
 *                 As in ADR-0239, the text depends only on the position, so no stored value is spliced in, and a set
 *                 is parsed once per size.
 *
 * FAIL CLOSED. Detection fails closed by not moving on: any engine failure, any per-policy error, or an unexpected
 * policy id throws. The sweep then keeps its cursor and re-reads the same rows, so no event is ever silently treated
 * as "matched nothing".
 *
 * Imported only through its own subpath (`@regulait/policy-kernel/detection-cedar`), so importing the kernel never
 * loads the wasm module.
 */
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";

const NS = "RegulAIt";
const ACTION_CLASS: cedar.EntityUid = { type: `${NS}::Action`, id: "DetectionToolClass" };
const ACTION_SELECT: cedar.EntityUid = { type: `${NS}::Action`, id: "DetectionSelect" };
const PRINCIPAL: cedar.EntityUid = { type: `${NS}::Detector`, id: "detector" };
const RESOURCE: cedar.EntityUid = { type: `${NS}::AuditEvent`, id: "event" };

export const DETECTION_SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;
export type DetectionSeverityName = keyof typeof DETECTION_SEVERITY_RANK;

/** a selector as the rule pack carries it (every field optional; all present fields must hold) */
export interface DetectionSelectorInput {
  objectType?: readonly string[];
  effect?: readonly string[];
  ruleId?: readonly string[];
  toolClass?: string;
  phase?: readonly string[];
  dataScoped?: boolean;
  addonSeverityAtLeast?: DetectionSeverityName;
  delegated?: boolean;
}

/** the facts of one audit event a selector may read */
export interface DetectionEventFacts {
  objectType: string;
  effect: string;
  ruleId: string;
  toolName: string | null;
  phase: string | null;
  dataScoped: boolean;
  addonSeverity: DetectionSeverityName | null;
  delegated: boolean;
}

export const DETECTION_CEDAR_SCHEMA_TEXT = `
namespace ${NS} {
  entity Detector;
  entity AuditEvent;
  entity ToolClassGlob;
  entity Selector = {
    objectType?: Set<String>,
    effect?: Set<String>,
    ruleId?: Set<String>,
    toolClass?: String,
    phase?: Set<String>,
    dataScoped?: Bool,
    addonSeverityAtLeast?: Long,
    delegated?: Bool,
  };
  action DetectionToolClass appliesTo {
    principal: [Detector],
    resource: [AuditEvent],
    context: { toolName: String },
  };
  action DetectionSelect appliesTo {
    principal: [Detector],
    resource: [AuditEvent],
    context: {
      objectType: String,
      effect: String,
      ruleId: String,
      phase?: String,
      dataScoped: Bool,
      addonSeverity?: Long,
      delegated: Bool,
      toolClasses: Set<String>,
    },
  };
}
`;

const SCHEMA_NAME = "regulait-detection-v1";
/** a glob as the pack schema admits it; re-checked here because it enters policy text */
const GLOB = /^[a-z0-9_.:*-]{1,64}$/;
const CLASS_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_SELECTORS = 1024;
const MAX_CLASS_SETS = 16;

/** The selector policy at position `i`: every clause is "absent, or holds". */
export function selectorPolicyText(i: number): string {
  const S = `${NS}::Selector::"${i}"`;
  return [
    `permit (principal, action == ${NS}::Action::"DetectionSelect", resource)`,
    `when {`,
    `  (if ${S} has objectType then ${S}.objectType.contains(context.objectType) else true) &&`,
    `  (if ${S} has effect then ${S}.effect.contains(context.effect) else true) &&`,
    `  (if ${S} has ruleId then ${S}.ruleId.contains(context.ruleId) else true) &&`,
    `  (if ${S} has phase then (context has phase && ${S}.phase.contains(context.phase)) else true) &&`,
    `  (if ${S} has dataScoped then ${S}.dataScoped == context.dataScoped else true) &&`,
    `  (if ${S} has delegated then ${S}.delegated == context.delegated else true) &&`,
    `  (if ${S} has addonSeverityAtLeast then (context has addonSeverity && context.addonSeverity >= ${S}.addonSeverityAtLeast) else true) &&`,
    `  (if ${S} has toolClass then context.toolClasses.contains(${S}.toolClass) else true)`,
    `};`,
  ].join("\n");
}

let schemaReady = false;
const selectorSets = new Set<number>();
const classSets = new Map<string, { id: string; policyClass: Map<string, string> }>();

function ensureSchema(): void {
  if (schemaReady) return;
  const answer = cedar.preparseSchema(SCHEMA_NAME, DETECTION_CEDAR_SCHEMA_TEXT);
  if (answer.type !== "success") throw new Error(`detection schema failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  schemaReady = true;
}

function ensureSelectorSet(n: number): string {
  if (n > MAX_SELECTORS) throw new Error(`too many detection selectors (${n})`);
  const id = `regulait-detection-selectors-${n}`;
  if (selectorSets.has(n)) return id;
  const policies: Record<string, string> = {};
  for (let i = 0; i < n; i++) policies[`selector-${i}`] = selectorPolicyText(i);
  const answer = cedar.preparsePolicySet(id, { staticPolicies: policies });
  if (answer.type !== "success") throw new Error(`detection selector set failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  selectorSets.add(n);
  return id;
}

/** the class policy set for one class table, parsed once and cached by its canonical text */
function ensureClassSet(classes: Readonly<Record<string, readonly string[]>>): { id: string; policyClass: Map<string, string> } {
  const names = Object.keys(classes).sort();
  const key = JSON.stringify(names.map((n) => [n, classes[n]]));
  const cached = classSets.get(key);
  if (cached) return cached;
  const policies: Record<string, string> = {};
  const policyClass = new Map<string, string>();
  for (const name of names) {
    if (!CLASS_NAME.test(name)) throw new Error(`invalid tool class name ${JSON.stringify(name)}`);
    classes[name]!.forEach((glob, i) => {
      if (!GLOB.test(glob)) throw new Error(`invalid tool class glob in ${name}`);
      const pid = `class-${name}-${i}`;
      policies[pid] = `permit (principal, action == ${NS}::Action::"DetectionToolClass", resource) when { context.toolName like "${glob}" };`;
      policyClass.set(pid, name);
    });
  }
  const id = `regulait-detection-classes-${classSets.size}`;
  const answer = cedar.preparsePolicySet(id, { staticPolicies: policies });
  if (answer.type !== "success") throw new Error(`detection tool classes failed to parse: ${answer.errors.map((e) => e.message).join("; ")}`);
  if (classSets.size >= MAX_CLASS_SETS) classSets.clear();
  const entry = { id, policyClass };
  classSets.set(key, entry);
  return entry;
}

function satisfied(answer: cedar.AuthorizationAnswer): string[] {
  if (answer.type === "failure") throw new Error(`detection evaluation failed: ${answer.errors.map((e) => e.message).join("; ")}`);
  const { diagnostics } = answer.response;
  if (diagnostics.errors.length > 0) {
    throw new Error(`detection evaluation failed: ${diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`).join("; ")}`);
  }
  return diagnostics.reason;
}

function selectorEntity(s: DetectionSelectorInput, i: number): cedar.EntityJson {
  const attrs: Record<string, cedar.CedarValueJson> = {};
  if (s.objectType) attrs.objectType = [...s.objectType];
  if (s.effect) attrs.effect = [...s.effect];
  if (s.ruleId) attrs.ruleId = [...s.ruleId];
  if (s.toolClass !== undefined) attrs.toolClass = s.toolClass;
  if (s.phase) attrs.phase = [...s.phase];
  if (s.dataScoped !== undefined) attrs.dataScoped = s.dataScoped;
  if (s.delegated !== undefined) attrs.delegated = s.delegated;
  if (s.addonSeverityAtLeast !== undefined) attrs.addonSeverityAtLeast = DETECTION_SEVERITY_RANK[s.addonSeverityAtLeast];
  return { uid: { type: `${NS}::Selector`, id: String(i) }, attrs, parents: [] };
}

/**
 * For each event, the set of selector positions it matches. Tool classes are resolved once per distinct tool name.
 * Throws on any engine failure (fail closed: the caller does not move on).
 */
export function matchDetectionSelectors(
  selectors: readonly DetectionSelectorInput[],
  classes: Readonly<Record<string, readonly string[]>>,
  events: readonly DetectionEventFacts[],
): Array<ReadonlySet<number>> {
  if (selectors.length === 0 || events.length === 0) return events.map(() => new Set<number>());
  ensureSchema();
  const selectorSet = ensureSelectorSet(selectors.length);
  const entities = selectors.map(selectorEntity);
  const classSet = Object.keys(classes).length > 0 ? ensureClassSet(classes) : null;
  const classCache = new Map<string, string[]>();
  const classesOf = (toolName: string | null): string[] => {
    if (toolName === null || !classSet) return [];
    const name = toolName.toLowerCase();
    const hit = classCache.get(name);
    if (hit) return hit;
    const reason = satisfied(
      cedar.statefulIsAuthorized({
        principal: PRINCIPAL,
        action: ACTION_CLASS,
        resource: RESOURCE,
        context: { toolName: name },
        preparsedSchemaName: SCHEMA_NAME,
        validateRequest: true,
        preparsedPolicySetId: classSet.id,
        entities: [],
      }),
    );
    const out = [...new Set(reason.map((pid) => {
      const c = classSet.policyClass.get(pid);
      if (!c) throw new Error(`unexpected detection policy id ${pid}`);
      return c;
    }))];
    classCache.set(name, out);
    return out;
  };
  return events.map((e) => {
    const context: cedar.Context = {
      objectType: e.objectType,
      effect: e.effect,
      ruleId: e.ruleId,
      dataScoped: e.dataScoped,
      delegated: e.delegated,
      toolClasses: classesOf(e.toolName),
    };
    if (e.phase !== null) context.phase = e.phase;
    if (e.addonSeverity !== null) context.addonSeverity = DETECTION_SEVERITY_RANK[e.addonSeverity];
    const reason = satisfied(
      cedar.statefulIsAuthorized({
        principal: PRINCIPAL,
        action: ACTION_SELECT,
        resource: RESOURCE,
        context,
        preparsedSchemaName: SCHEMA_NAME,
        validateRequest: true,
        preparsedPolicySetId: selectorSet,
        entities,
      }),
    );
    const matched = new Set<number>();
    for (const pid of reason) {
      const i = Number(pid.slice("selector-".length));
      if (!pid.startsWith("selector-") || !Number.isInteger(i) || i < 0 || i >= selectors.length) {
        throw new Error(`unexpected detection policy id ${pid}`);
      }
      matched.add(i);
    }
    return matched;
  });
}

export const DETECTION_CEDAR_ENGINE = `cedar-wasm@${cedar.getCedarVersion()}`;
