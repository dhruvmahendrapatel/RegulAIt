/**
 * ADR-0186 decision 28 (PR #198 review round 8, finding 47) — IS THIS RULE EDIT
 * LOOSER? One comparator per rule kind over the rule's COMPLETE effective
 * semantics, typed over every column of its table: a column added to
 * `approval_rules`, `rate_limits` or `data_scope_rules` without a
 * classification here does not compile.
 *
 * A rule edit that loosens what the rule enforces needs the same
 * `settings_relax` step-up as removing the rule (B4S-05) or loosening dual
 * control (ADR-0180), judged against the rule AS IT IS ENFORCED NOW (the
 * stored value — the active version's body over the row), never against a
 * default. Run by every writer that changes what a rule enforces: the row
 * edit (`applyRuleEdit`, every PATCH and the other edit paths) and version
 * activation (mint-and-activate, activate, rollback, canary promotion). A
 * draft version enforces nothing; activating it is the guarded moment.
 *
 * The classes:
 *  - `pool`: who may release a matched call (approver, approver role, quorum).
 *    Decided by `approvalRuleLoosens`, the satisfiability guard's own pool.
 *  - `match`: which calls the rule applies to. `null` = every tool / every
 *    deploy mode; narrowing (null -> one, or one -> another) is looser.
 *  - `compare`: an ordered or set-valued enforcement field.
 *  - `selection` / `identity`: which callers the rule is loaded for, or its id.
 *    Every writer refuses them (a new subject is a new rule); a change is
 *    treated as looser anyway, so a writer that ever allowed one fails closed.
 */
import type { approvalRules, complianceProfiles, dataScopeRules, rateLimits } from "@regulait/db";
import { approvalRuleLoosens, approvalRuleShape, requireRuleStepUp, type ApprovalRuleStepUp } from "./approval-pool.js";

type Q = Parameters<typeof approvalRuleLoosens>[0];

type FieldClass =
  | { readonly kind: "pool"; readonly why: string }
  | { readonly kind: "compare"; readonly looser: (before: unknown, after: unknown) => boolean; readonly why: string }
  | { readonly kind: "selection" | "identity"; readonly why: string };

type Classified<Row> = { readonly [K in keyof Required<Row>]: FieldClass };

const changed = (b: unknown, a: unknown) => JSON.stringify(b ?? null) !== JSON.stringify(a ?? null);
/** null = every value; narrowing to one, or moving from one to another, stops it applying somewhere */
const narrowedMatch = (b: unknown, a: unknown) => changed(b, a) && a !== null && a !== undefined;
const SELECTION: FieldClass = {
  kind: "selection",
  why: "selects which callers the rule is loaded for; refused by every writer (a new subject is a new rule)",
};
const IDENTITY: FieldClass = { kind: "identity", why: "the rule's identity; never written" };
const TOOL: FieldClass = { kind: "compare", looser: narrowedMatch, why: "null = every tool; naming one tool (or another) narrows it" };
const DEPLOY_MODE: FieldClass = {
  kind: "compare",
  looser: narrowedMatch,
  why: "null = every deploy mode; naming one mode (or another) narrows it",
};
const SUBJECT = {
  userId: SELECTION,
  serverId: SELECTION,
  roleId: SELECTION,
  teamId: SELECTION,
  scope: SELECTION,
  serverScope: SELECTION,
} as const;

export const APPROVAL_RULE_LOOSENING: Classified<typeof approvalRules.$inferSelect> = {
  id: IDENTITY,
  createdAt: IDENTITY,
  ...SUBJECT,
  toolName: TOOL,
  deployMode: DEPLOY_MODE,
  writeOnly: { kind: "compare", looser: (b, a) => b !== true && a === true, why: "true = only write calls need approval" },
  approvalScope: {
    kind: "compare",
    looser: (b, a) => b !== "tool" && a === "tool",
    why: "'tool' lets one consent release calls with other arguments (ADR-0104); 'action' binds it to the arguments",
  },
  approverUserId: { kind: "pool", why: "the named approver" },
  approverRoleId: { kind: "pool", why: "the approver role" },
  quorum: { kind: "pool", why: "distinct approving principals needed" },
};

export const RATE_LIMIT_LOOSENING: Classified<typeof rateLimits.$inferSelect> = {
  id: IDENTITY,
  createdAt: IDENTITY,
  ...SUBJECT,
  toolName: TOOL,
  deployMode: DEPLOY_MODE,
  maxCalls: { kind: "compare", looser: (b, a) => Number(a) > Number(b), why: "more calls per window" },
  windowSeconds: { kind: "compare", looser: (b, a) => Number(a) < Number(b), why: "the same calls in a shorter window" },
};

export const DATA_SCOPE_RULE_LOOSENING: Classified<typeof dataScopeRules.$inferSelect> = {
  id: IDENTITY,
  createdAt: IDENTITY,
  ...SUBJECT,
  toolName: TOOL,
  deployMode: DEPLOY_MODE,
  argPath: { kind: "compare", looser: changed, why: "moving the constraint leaves the argument it guarded unconstrained" },
  allowedValues: {
    kind: "compare",
    looser: (b, a) => {
      const before = new Set((Array.isArray(b) ? b : []).map((v) => JSON.stringify(v)));
      return Array.isArray(a) && a.some((v) => !before.has(JSON.stringify(v)));
    },
    why: "an allowed value not allowed before widens the scope",
  },
};

// ---------------------------------------------------------------------------
// Compliance profiles (decision 29, finding 52): one profile edit cascades into
// every project carrying its tag, so each field is judged by what it forces.
// A null is "this framework has no opinion" — always the loosest value.
// ---------------------------------------------------------------------------
const num = (v: unknown) => (typeof v === "number" ? v : null);
/** a FLOOR that must be at least this much (retention, trials): lower, or none, is looser */
const floorLowered = (b: unknown, a: unknown) => num(b) !== null && (num(a) === null || num(a)! < num(b)!);
/** a CEILING that must be at most this much (budget, patch cadence): higher, or none, is looser */
const ceilingRaised = (b: unknown, a: unknown) => num(b) !== null && (num(a) === null || num(a)! > num(b)!);
/** a list of things the framework FORCES: dropping one is looser */
const forcedDropped = (b: unknown, a: unknown) => {
  const next = new Set((Array.isArray(a) ? a : []).map(String));
  return Array.isArray(b) && b.some((x) => !next.has(String(x)));
};
const rankLowered = (rank: Record<string, number>) => (b: unknown, a: unknown) =>
  (rank[String(a)] ?? -1) < (rank[String(b)] ?? -1);
const GUARDRAIL_RANK: Record<string, number> = { off: 0, log: 1, warn: 2, block: 3 };

export const COMPLIANCE_PROFILE_LOOSENING: Classified<typeof complianceProfiles.$inferSelect> = {
  id: IDENTITY,
  createdAt: IDENTITY,
  tag: { kind: "selection", why: "the framework tag the profile is for; an edit never re-tags (a new tag is a new profile)" },
  requiredTemplateIds: { kind: "compare", looser: forcedDropped, why: "a workflow template the framework no longer forces" },
  mcpDefaultMode: { kind: "compare", looser: rankLowered({ read_write: 0, read_only: 1 }), why: "read_only -> read_write" },
  auditRetentionDays: { kind: "compare", looser: floorLowered, why: "a shorter (or no) audit retention floor" },
  piiMode: { kind: "compare", looser: rankLowered({ log: 0, warn: 1, block: 2 }), why: "block > warn > log" },
  backupRetentionDays: { kind: "compare", looser: floorLowered, why: "a shorter (or no) backup retention floor" },
  patchCadenceDays: { kind: "compare", looser: ceilingRaised, why: "a longer (or no) patch cadence" },
  maxProjectBudgetUsd: { kind: "compare", looser: ceilingRaised, why: "a higher (or no) project budget ceiling" },
  budgetEnforcement: {
    kind: "compare",
    looser: rankLowered({ warn_only: 1, block: 2 }),
    why: "block > warn_only > no opinion",
  },
  guardrailModes: {
    kind: "compare",
    looser: (b, a) => {
      const before = (b ?? {}) as Record<string, string>;
      const after = (a ?? {}) as Record<string, string>;
      return Object.entries(before).some(([d, m]) => (GUARDRAIL_RANK[after[d] ?? ""] ?? -1) < (GUARDRAIL_RANK[m] ?? -1));
    },
    why: "a guardrail floor lowered or dropped for any detector",
  },
  redteamGatingClasses: { kind: "compare", looser: forcedDropped, why: "an attack class the framework no longer gates on" },
  redteamMinTrials: { kind: "compare", looser: floorLowered, why: "fewer (or no minimum) trials per probe" },
  redteamFailOnSeverity: {
    kind: "compare",
    // a defeat at or above this severity fails its class: a HIGHER threshold fails fewer
    looser: rankLowered({ critical: 0, high: 1, medium: 2, low: 3 }),
    why: "a higher (or no) severity at which a defeat fails its class",
  },
};

const BY_KIND: Readonly<Record<string, Readonly<Record<string, FieldClass>>>> = {
  approval_rule: APPROVAL_RULE_LOOSENING,
  rate_limit: RATE_LIMIT_LOOSENING,
  data_scope_rule: DATA_SCOPE_RULE_LOOSENING,
  compliance_profile: COMPLIANCE_PROFILE_LOOSENING,
};

/** does this comparator cover `artifactType`? */
export function ruleLooseningCovers(artifactType: string): boolean {
  return artifactType in BY_KIND;
}

/**
 * The loosened fields of moving a rule from `before` to `after` (both the
 * effective rule: the active body over the row), with their new values; null
 * when the edit loosens nothing. A field missing from both sides is unchanged.
 */
export async function ruleEditLoosening(
  db: Q,
  artifactType: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const fields = BY_KIND[artifactType];
  if (!fields) return null;
  const out: Record<string, unknown> = {};
  let poolChecked = false;
  for (const [field, cls] of Object.entries(fields)) {
    const [b, a] = [before[field], after[field]];
    if (!changed(b, a)) continue;
    if (cls.kind === "pool") {
      if (poolChecked) continue;
      poolChecked = true;
      if (await approvalRuleLoosens(db, approvalRuleShape(before), approvalRuleShape(after))) {
        const shaped = approvalRuleShape(after);
        Object.assign(out, { quorum: shaped.quorum ?? 1, approverRoleId: shaped.approverRoleId ?? null, approverUserId: shaped.approverUserId });
      }
      continue;
    }
    if (cls.kind === "compare" ? cls.looser(b, a) : true) out[field] = a ?? null;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * THE RULE-EDIT LOOSENING GUARD: a write that loosens what a rule enforces
 * needs the `settings_relax` step-up (`stepUp`, from the route), bound to the
 * rule and the loosened fields' new values; a writer with no request to step
 * up is refused while the stored policy asks for one (fail closed).
 */
export async function assertRuleLooseningStepUp(
  db: Q,
  args: {
    artifactType: string;
    ruleId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    stepUp?: ApprovalRuleStepUp | null;
  },
): Promise<void> {
  const values = await ruleEditLoosening(db, args.artifactType, args.before, args.after);
  if (!values) return;
  return requireRuleStepUp(
    db,
    { ruleId: args.ruleId, values },
    args.stepUp,
    "this change loosens what a governance rule enforces (a lower quorum, a wider approver pool, fewer calls matched, " +
      "a higher limit or a wider scope) and needs a step-up, which this write path cannot ask for: make the change as an " +
      "admin in RegulAIt",
  );
}
