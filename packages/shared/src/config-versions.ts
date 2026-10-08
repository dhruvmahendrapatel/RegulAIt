/**
 * ADR-0048 — IMMUTABLE VERSIONING / CANARY / ROLLBACK, the PURE half.
 *
 *   THIS FILE            the vocabularies, the zod shapes, the DETERMINISTIC
 *                        canary bucketing, the version RESOLUTION, and the
 *                        eval-gated promotion decision. No db, no clock of its
 *                        own, no crypto dependency.
 *   `apps/gateway/src/config-versions.ts`
 *                        persistence, the admin API, the activation ledger,
 *                        the audit rows, and the dispatch-time resolver.
 *
 * THE ONE IDEA WORTH STATING TWICE
 *
 *   `canaryBucket` is a PURE FUNCTION OF A STABLE KEY. Not a coin flip, not
 *   `Math.random()`, not the wall clock. Two consequences, both load-bearing:
 *
 *     - A multi-turn run cannot flip its base prompt mid-conversation (§2:
 *       "sticky, not per-call"). The key is the run id, else the conversation
 *       id, else the user id.
 *     - The split is AUDITABLE and REPRODUCIBLE. Given the artifact id, the
 *       stable key and the percentage, anyone can recompute which side a
 *       request fell on, months later, from the ledger row alone.
 *
 *   The hash is FNV-1a 32-bit, implemented here rather than imported. It is not
 *   a cryptographic hash and does not need to be: nothing about bucketing is a
 *   secret, and what IS required — determinism, no dependency, and an
 *   implementation a reviewer can read in ten lines — is exactly what a
 *   crypto library would obscure. Stated so nobody later "upgrades" it to
 *   sha256 and silently re-buckets every in-flight canary.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const CONFIG_ARTIFACT_TYPES = [
  "agent_system_prompt",
  "agent_config",
  "approval_rule",
  "rate_limit",
  "data_scope_rule",
  "compliance_profile",
] as const;
export type ConfigArtifactType = (typeof CONFIG_ARTIFACT_TYPES)[number];

export const CONFIG_VERSION_STATUSES = [
  "draft",
  "canary",
  "active",
  "rolled_back",
  "superseded",
  // batch B1 (migration 0095) — demoted because the artifact was deleted
  // through the explicit rule DELETE route; see packages/db schema comment
  "retired",
] as const;
export type ConfigVersionStatus = (typeof CONFIG_VERSION_STATUSES)[number];

/**
 * ADR-0048 §2 — WHICH artifact types canary LIVE and which canary in SHADOW.
 *
 * A prompt or a routing config sits on the GENERATIVE hot path: a 10% split
 * produces a 10% sample of differently-worded answers, which is a measurement.
 * A restriction rule sits on the ALLOW/DENY path: a 10%-enforced `deny` would
 * non-deterministically block real work, which is an outage with a percentage
 * sign on it. So restriction rules canary in shadow — evaluated and logged,
 * never enforcing — and the set is closed here rather than decided per call.
 *
 * BATCH B1 (2026-08-22, ADR-0073 amendment): `agent_config` LEFT this set.
 * ADR-0048 declared it live-canary and never wired a resolver, so for three
 * waves the declaration described nothing. When the resolver was finally
 * wired, it was wired in SHADOW, not live, and the intent statement moved to
 * match the fact rather than the fact being bent to match a declaration
 * nothing had ever exercised: a live agent_config canary would serve a
 * DIFFERENT MODEL to a percentage of real traffic — a candidate carrying a
 * model id the provider rejects would be a per-request outage at N%, the
 * rule-canary failure mode with a generative face on it. The shadow measures
 * exactly what the live split would have shown ("which model/price would this
 * dispatch have used") with zero served-path risk; a live ramp for
 * agent_config remains buildable as its own slice if a measured need appears.
 */
export const LIVE_CANARY_ARTIFACT_TYPES: readonly ConfigArtifactType[] = [
  "agent_system_prompt",
];

export function canaryIsLive(t: ConfigArtifactType): boolean {
  return LIVE_CANARY_ARTIFACT_TYPES.includes(t);
}

/**
 * ADR-0073 — THE SECOND PREDICATE, and the reason there has to be one.
 *
 * `canaryIsLive` answers "does the canary SERVE traffic?". Until ADR-0073 it
 * was also being read as "is the canary WORTH ANYTHING?", because for rule
 * types the answer to both was no: the kernels read their own tables and a
 * stored rule canary was a row, not a control.
 *
 * Those are two different questions and ADR-0073 separates them, because
 * conflating them makes one of the two answers a lie whichever way you flip
 * the flag:
 *
 *   - Flipping `canaryIsLive` to true for `approval_rule` would make
 *     `resolveVersion` SERVE the canary — i.e. enforce a candidate `deny` on a
 *     percentage of real work. That is the outage-with-a-percentage-sign §2
 *     exists to forbid, and it is exactly what a shadow canary must never do.
 *   - Leaving it false and saying nothing keeps claiming the canary is inert
 *     after it has become a genuine measurement.
 *
 * So: `canaryIsLive` keeps its meaning unchanged and stays FALSE for every
 * restriction rule for ever. `canaryIsEvaluated` is the new one — true when
 * something genuinely computes what the candidate WOULD have decided, whether
 * by serving it (prompts) or by shadowing it (rules and compliance profiles).
 *
 * BATCH B1 (2026-08-22): `agent_config` joined THIS set — the last inert type.
 * The dispatch core now resolves the ACTIVE agent_config version (model +
 * list price overlaid onto the agents row) and evaluates a sampled CANDIDATE
 * in parallel, recording each comparison in `config_canary_observations`
 * exactly like the rule kinds. The candidate can never reach the served
 * dispatch; see the LIVE set's comment for why it shadows rather than serves.
 */
export const SHADOW_CANARY_ARTIFACT_TYPES: readonly ConfigArtifactType[] = [
  "approval_rule",
  "rate_limit",
  "data_scope_rule",
  "compliance_profile",
  "agent_config",
];

export function canaryIsShadowEvaluated(t: ConfigArtifactType): boolean {
  return SHADOW_CANARY_ARTIFACT_TYPES.includes(t);
}

/**
 * The artifact types something in the product ACTUALLY RESOLVES. This is a
 * statement of FACT, where `LIVE_CANARY_ARTIFACT_TYPES` is a statement of
 * INTENT — ADR-0048 declared `agent_config` a live-canary type and then never
 * wired a resolver for it, so for two waves `canaryIsLive('agent_config')`
 * answered "yes" about something nothing reads.
 *
 * Keeping the two separate is what lets ADR-0073 close the rule half honestly
 * without either rewriting ADR-0048's declared intent or letting the API keep
 * claiming a measurement that does not exist.
 *
 * BATCH B1 (2026-08-22): with `agent_config` wired (in shadow) at the dispatch
 * core, intent and fact finally agree — every one of the six artifact types is
 * resolved by something, and `canaryModeOf` no longer has an `inert` type to
 * report. The `inert` vocabulary is kept: it is what an honest API says the
 * day a seventh type is declared before it is wired.
 */
export const RESOLVED_ARTIFACT_TYPES: readonly ConfigArtifactType[] = [
  "agent_system_prompt",
  ...SHADOW_CANARY_ARTIFACT_TYPES,
];

/** true when a canary of this type genuinely produces a signal — served
 * (live) or shadowed. False for the types nothing reads at all. */
export function canaryIsEvaluated(t: ConfigArtifactType): boolean {
  return RESOLVED_ARTIFACT_TYPES.includes(t);
}

export type CanaryMode = "live" | "shadow" | "inert";

export function canaryModeOf(t: ConfigArtifactType): CanaryMode {
  if (!canaryIsEvaluated(t)) return "inert";
  if (canaryIsLive(t)) return "live";
  return "shadow";
}

/** the sentence the lineage endpoint discloses. One place, so the API and the
 * SPA cannot drift from what the resolver actually does. */
export function canaryModeNote(t: ConfigArtifactType): string {
  switch (canaryModeOf(t)) {
    case "live":
      return (
        "Canary traffic is served LIVE and stamped onto usage_events.config_version_id — the " +
        "candidate version genuinely answers a share of requests."
      );
    case "shadow":
      return (
        "This artifact type canaries in SHADOW per ADR-0048 §2 — a partially-enforced deny would " +
        "non-deterministically block real work, so the ACTIVE version alone enforces. Since " +
        "ADR-0073 the candidate IS genuinely evaluated in parallel on every sampled decision and " +
        "each divergence is recorded in config_canary_observations, so you can see what would " +
        "change BEFORE promoting. canary_pct is the SHADOW SAMPLING RATE here, not a share of " +
        "enforcement."
      );
    default:
      return (
        "This artifact type is VOCABULARY ONLY: versions of it can be stored, activated and " +
        "rolled back, but nothing resolves them at dispatch and nothing shadows them. A canary " +
        "here changes nothing and measures nothing (ADR-0048 deviation 2, still open)."
      );
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const createConfigVersionSchema = z
  .object({
    body: z.record(z.unknown()),
    label: z.string().min(1).max(200).nullish(),
    /** activate immediately (the behaviour an in-place UPDATE used to have,
     * except the previous version row survives) */
    activate: z.boolean().default(false),
  })
  .strict();
export type CreateConfigVersion = z.infer<typeof createConfigVersionSchema>;

export const activateConfigVersionSchema = z
  .object({ version: z.number().int().positive(), reason: z.string().max(2000).nullish() })
  .strict();

export const startCanarySchema = z
  .object({
    version: z.number().int().positive(),
    pct: z.number().int().min(1).max(99),
    reason: z.string().max(2000).nullish(),
  })
  .strict();

export const promoteCanarySchema = z
  .object({
    /** the ADR-0044 run that proves the canary did not regress */
    evalRunId: z.string().uuid().nullish(),
    /** the honest escape hatch — refused unless a reason accompanies it */
    override: z.boolean().default(false),
    reason: z.string().max(2000).nullish(),
  })
  .strict();

export const rollbackConfigSchema = z
  .object({ reason: z.string().min(1).max(2000) })
  .strict();

// ---------------------------------------------------------------------------
// Deterministic canary bucketing
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Deliberately simple and deliberately NOT cryptographic —
 * see the file header before replacing it. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in uint32 via Math.imul
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which of 100 buckets a request falls in. The artifact id is mixed in so two
 * artifacts canarying at the same time do not put the SAME users on the canary
 * side of both — a user who is unlucky once should not be systematically
 * unlucky everywhere.
 */
export function canaryBucket(artifactId: string, stableKey: string): number {
  return fnv1a32(`${artifactId}:${stableKey}`) % 100;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface VersionLike {
  id: string;
  version: number;
  status: ConfigVersionStatus;
  canaryPct: number | null;
  body: Record<string, unknown>;
}

export interface ResolvedVersion {
  versionId: string;
  version: number;
  body: Record<string, unknown>;
  /** true when the CANARY served this request */
  canary: boolean;
  /** the bucket, recorded so the split is reproducible from the ledger */
  bucket: number | null;
  reason: string;
}

/**
 * Pick the version that serves ONE request. Total, and total on purpose:
 *
 *  - no rows at all            → null (the caller falls back to the
 *                                pre-versioning value; behaviour-preserving)
 *  - active only               → active
 *  - active + canary, live     → canary iff bucket < pct, else active
 *  - active + canary, shadow   → ACTIVE always (the canary is evaluated
 *                                elsewhere and never enforces)
 *  - canary but no active      → the canary, because there is nothing else;
 *                                this is only reachable for an artifact whose
 *                                first version is being trialled
 */
export function resolveVersion(input: {
  artifactType: ConfigArtifactType;
  artifactId: string;
  versions: VersionLike[];
  stableKey: string;
}): ResolvedVersion | null {
  const active = input.versions.find((v) => v.status === "active") ?? null;
  const canary = input.versions.find((v) => v.status === "canary") ?? null;

  if (canary && canaryIsLive(input.artifactType)) {
    const bucket = canaryBucket(input.artifactId, input.stableKey);
    if (bucket < (canary.canaryPct ?? 0)) {
      return {
        versionId: canary.id,
        version: canary.version,
        body: canary.body,
        canary: true,
        bucket,
        reason: `canary v${canary.version} at ${canary.canaryPct}% — stable-key bucket ${bucket}`,
      };
    }
    if (active) {
      return {
        versionId: active.id,
        version: active.version,
        body: active.body,
        canary: false,
        bucket,
        reason: `active v${active.version} — stable-key bucket ${bucket} is outside the ${canary.canaryPct}% canary`,
      };
    }
    // a first-ever version being trialled: there is no active to fall back to
    return {
      versionId: canary.id,
      version: canary.version,
      body: canary.body,
      canary: true,
      bucket,
      reason: `canary v${canary.version} — no active version exists to fall back to`,
    };
  }

  if (active) {
    return {
      versionId: active.id,
      version: active.version,
      body: active.body,
      canary: false,
      bucket: null,
      reason:
        canary && !canaryIsLive(input.artifactType)
          ? `active v${active.version} — a canary exists but ${input.artifactType} canaries in SHADOW and never enforces`
          : `active v${active.version}`,
    };
  }
  return null;
}

/** the prompt out of an `agent_system_prompt` body, or null if the version
 * carries no prompt (a deliberately-cleared base) */
export function promptFromBody(body: Record<string, unknown>): string | null {
  const v = body["systemPrompt"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// ADR-0073 — WHAT A RULE VERSION'S BODY MAY CONTAIN
// ---------------------------------------------------------------------------

/**
 * THE SCOPE LINE, and it is load-bearing rather than tidy-minded.
 *
 * A pillar-1 rule row has two kinds of column:
 *
 *   SELECTION columns  — `scope`, `serverScope`, `userId`, `roleId`, `teamId`,
 *                        `serverId`. `scopedRuleWhere` turns these into the SQL
 *                        predicate that decides WHICH rows are loaded for this
 *                        caller at all, and the kernel re-checks the user-scope
 *                        id it must never widen.
 *   ENFORCING columns  — everything below. These decide what a LOADED rule
 *                        DOES.
 *
 * Only the enforcing columns are versioned. Versioning a selection column would
 * create a version whose stored body claims the rule applies to somebody the
 * pre-filter never loads it for — a rule that is simultaneously "active" and
 * unreachable, which is the single most dangerous thing a governance config can
 * be. Rebinding a rule to a different subject is a NEW RULE, not a new version
 * of an old one; the API refuses it with a stated reason rather than accepting
 * a body it would then have to ignore.
 *
 * `id`, `createdAt` are identity, not definition, and are likewise refused.
 */
export const VERSIONED_RULE_FIELDS: Partial<Record<ConfigArtifactType, readonly string[]>> = {
  // ADR-0186 A: `quorum` and `approverRoleId` decide WHO may release a matched
  // call, so they are enforcing — an edit mints a version, which moves the
  // consent context of every call the rule binds
  approval_rule: ["toolName", "writeOnly", "approverUserId", "deployMode", "quorum", "approverRoleId"],
  rate_limit: ["toolName", "maxCalls", "windowSeconds", "deployMode"],
  data_scope_rule: ["toolName", "argPath", "allowedValues", "deployMode"],
  /**
   * BATCH B1 — `agent_config` versions the DISPATCH-EXECUTION config of an
   * agent registry row, and deliberately nothing else. The scope line here is
   * the same one §2 draws for rules: `model` and the two list-price columns
   * are what the ONE dispatch core reads when it executes and attributes a
   * call, so they are enforcing. Everything else on `agents` is refused:
   * `provider`/`customProviderId` select the credential + egress machinery (a
   * closed vocabulary four subsystems switch over — rebinding it is a NEW
   * agent, exactly as rebinding a rule's subject is a new rule); `tier` feeds
   * the ADR-0016 entitlement ceiling (a governance input, not a config);
   * `enabled`/`lifecycleStatus` are governance gates with their own audited
   * routes; `systemPrompt` is versioned as its own artifact type
   * (`agent_system_prompt`); `name`/`modes`/`ownerUserId` are identity and
   * accountability records.
   */
  agent_config: ["model", "costPerMTokIn", "costPerMTokOut"],
  compliance_profile: [
    "requiredTemplateIds",
    "mcpDefaultMode",
    "auditRetentionDays",
    "piiMode",
    "backupRetentionDays",
    "patchCadenceDays",
    "maxProjectBudgetUsd",
    "budgetEnforcement",
    "guardrailModes",
    "redteamGatingClasses",
    "redteamMinTrials",
    "redteamFailOnSeverity",
  ],
};

/** columns whose presence in a version body is REFUSED, with the reason named
 * per group so the 4xx tells an admin what to do instead */
export const RULE_SELECTION_FIELDS: readonly string[] = [
  "scope",
  "serverScope",
  "userId",
  "roleId",
  "teamId",
  "serverId",
  "tag",
];
export const RULE_IDENTITY_FIELDS: readonly string[] = ["id", "createdAt"];

/** true for the artifact types whose versions overlay a row in that type's own
 * table (as opposed to `agent_system_prompt`, whose body is free-form text) */
export function isRuleArtifact(t: ConfigArtifactType): boolean {
  return VERSIONED_RULE_FIELDS[t] != null;
}

export interface RuleBodyRejection {
  error: string;
  reason: string;
}

/**
 * The TYPE of each versionable field, because the key check alone is not
 * enough. A stored `{"windowSeconds": "sixty"}` would type-check as
 * `Record<string, unknown>`, activate cleanly, and then throw inside the rate
 * limit's window arithmetic on the SERVED path — turning a bad edit into an
 * outage rather than a refusal. Every field is optional (a version body may be
 * partial and the omitted fields keep the row's value); none is untyped.
 */
const deployModeField = z.enum(["hosted", "byoc", "air_gapped"]).nullish();
const RULE_BODY_SCHEMAS: Partial<Record<ConfigArtifactType, z.ZodTypeAny>> = {
  /** BATCH B1 — a null/absent `model` is legal (a routing-only agent) but the
   * dispatch gate then refuses with `agent_not_dispatchable`, same as a row
   * with no model; the prices are list prices and may legitimately be null
   * (unpriced — pillar 5 then attributes no invented dollar figure). */
  agent_config: z.object({
    model: z.string().min(1).nullish(),
    costPerMTokIn: z.number().nonnegative().nullish(),
    costPerMTokOut: z.number().nonnegative().nullish(),
  }),
  approval_rule: z.object({
    toolName: z.string().min(1).nullish(),
    writeOnly: z.boolean().optional(),
    approverUserId: z.string().uuid().optional(),
    deployMode: deployModeField,
    // ADR-0186 A (the bounds of APPROVAL_QUORUM_LIMITS and the DB CHECK)
    quorum: z.number().int().min(1).max(5).optional(),
    approverRoleId: z.string().uuid().nullish(),
  }),
  rate_limit: z.object({
    toolName: z.string().min(1).nullish(),
    maxCalls: z.number().int().min(0).optional(),
    windowSeconds: z.number().int().positive().optional(),
    deployMode: deployModeField,
  }),
  data_scope_rule: z.object({
    toolName: z.string().min(1).nullish(),
    argPath: z.string().min(1).optional(),
    allowedValues: z.array(z.string()).optional(),
    deployMode: deployModeField,
  }),
  compliance_profile: z.object({
    requiredTemplateIds: z.array(z.string()).nullish(),
    mcpDefaultMode: z.enum(["read_only", "read_write"]).optional(),
    auditRetentionDays: z.number().int().positive().nullish(),
    piiMode: z.enum(["block", "warn", "log"]).optional(),
    backupRetentionDays: z.number().int().positive().nullish(),
    patchCadenceDays: z.number().int().positive().nullish(),
    maxProjectBudgetUsd: z.number().nonnegative().nullish(),
    budgetEnforcement: z.enum(["block", "warn_only"]).nullish(),
    guardrailModes: z.record(z.string()).nullish(),
    redteamGatingClasses: z.array(z.string()).nullish(),
    redteamMinTrials: z.number().int().positive().nullish(),
    redteamFailOnSeverity: z.enum(["low", "medium", "high", "critical"]).nullish(),
  }),
};

/**
 * Validate a proposed rule-version body. Refuses — with a real reason, never a
 * silent drop — a body that names a selection column, an identity column, or a
 * field this artifact type has no such column for. A typo'd field name that was
 * quietly ignored would produce a version that looks like a change and is not
 * one, which for a governance artifact is worse than an error.
 */
export function validateRuleVersionBody(
  artifactType: ConfigArtifactType,
  body: Record<string, unknown>,
): RuleBodyRejection | null {
  const allowed = VERSIONED_RULE_FIELDS[artifactType];
  if (!allowed) return null;
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    if (RULE_SELECTION_FIELDS.includes(key)) {
      return {
        error: "selection_field_not_versionable",
        reason:
          `'${key}' selects WHICH callers this ${artifactType} is loaded for; it is not part of what the ` +
          `rule does. Versioning it would store a version that claims to apply to a subject the rule ` +
          `query never loads it for. Create a separate rule bound to the new subject instead.`,
      };
    }
    if (RULE_IDENTITY_FIELDS.includes(key)) {
      return {
        error: "identity_field_not_versionable",
        reason: `'${key}' is the artifact's identity, not its definition — a new version cannot change it.`,
      };
    }
    return {
      error: "unknown_versioned_field",
      reason:
        `'${key}' is not a versionable field of ${artifactType}. Versionable: ${allowed.join(", ")}. ` +
        `Refused rather than ignored, because a silently-dropped field looks like a change that did not happen.`,
    };
  }
  const schema = RULE_BODY_SCHEMAS[artifactType];
  if (schema) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return {
        error: "invalid_versioned_field",
        reason:
          `'${issue.path.join(".") || "(body)"}' ${issue.message}. A version body is TYPE-CHECKED before it is ` +
          `stored: an activated version carrying the wrong type would throw on the SERVED evaluation path, ` +
          `turning a bad edit into an outage instead of a refusal.`,
      };
    }
  }
  return null;
}

/** the version body for a rule row as it stands TODAY — the §7
 * behaviour-preserving baseline, extracted rather than hand-typed so a new
 * column cannot be forgotten by a human writing a migration. */
export function ruleBodyFrom(
  artifactType: ConfigArtifactType,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = VERSIONED_RULE_FIELDS[artifactType] ?? [];
  const out: Record<string, unknown> = {};
  for (const f of allowed) out[f] = row[f] ?? null;
  return out;
}

/**
 * Overlay a version body onto a rule row. Total and field-wise: only the
 * versionable fields are ever written, so a body that omits a field leaves the
 * table's value in place rather than nulling it — which matters because the
 * table row is the read-model `activateVersion` keeps in sync, and a partial
 * body must never silently clear a limit.
 */
export function applyRuleBody<T extends Record<string, unknown>>(
  artifactType: ConfigArtifactType,
  row: T,
  body: Record<string, unknown>,
): T {
  const allowed = VERSIONED_RULE_FIELDS[artifactType] ?? [];
  const out = { ...row } as Record<string, unknown>;
  for (const f of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// ADR-0074 — CLASSIFYING AN ORDINARY CRUD EDIT AGAINST THE VERSIONED FIELD SET
// ---------------------------------------------------------------------------

/**
 * ADR-0073 made the ACTIVE version the thing that enforces and demoted the rule
 * table row to a read-model. That left the read-model with a second class of
 * writer — the ordinary admin CRUD routes — which wrote enforcing columns
 * without minting a version, so dispatch went on serving the old body while
 * every listing surface showed the new one. ADR-0074 routes those writes through
 * one choke point, and this is the pure half of it: the classification that
 * decides which of three things a given patch is.
 *
 * `versioned` — fields that decide what a LOADED rule DOES. Changing one of
 *               these on a versioned artifact is a POLICY CHANGE and must
 *               become a version.
 * `selection` — fields that decide WHICH callers the rule is loaded for. These
 *               are deliberately un-versionable (see the scope comment above),
 *               so editing one is a plain row write with nothing to mint.
 * `unknown`   — a key this artifact type has no column for. Reported rather
 *               than dropped: a silently-ignored field looks like a change that
 *               did not happen, which is the exact failure this ADR exists to
 *               remove.
 */
export interface RulePatchPartition {
  versioned: Record<string, unknown>;
  selection: Record<string, unknown>;
  unknown: string[];
}

/**
 * ADR-0074 AMENDMENT (2026-08-09) — `undefined` IS AN ABSENT FIELD, NOT AN
 * EXPLICIT NULL.
 *
 * The choke point replaced calls that read `db.update(t).set(patch)`, and
 * drizzle's `.set()` OMITS a key whose value is `undefined` from the generated
 * SQL — `{ deployMode: undefined }` writes nothing at all. The first cut of
 * `partitionRulePatch` walked `Object.entries`, so the key landed in
 * `versioned` with the value `undefined`; `applyRuleBody` then copies it
 * because it tests `hasOwnProperty`, and the composed body would say
 * `deployMode: undefined` → totalised to `null` by `ruleBodyFrom`. A patch
 * that under the OLD code changed nothing would, under the choke point, have
 * WIPED a versioned field and minted a version claiming the admin asked for
 * it.
 *
 * No route can send it today — every caller builds its patch with `?? null` and
 * zod strips unknown keys — but "no caller does this right now" is exactly the
 * assurance that expires. A function every rule write in the product funnels
 * through must not carry "present-but-undefined means wipe it" semantics
 * waiting for the first caller that spreads an optional object into a patch.
 *
 * Dropping the key rather than refusing it is the behaviour-preserving choice:
 * `undefined` is JavaScript's "I am not saying anything about this field", it is
 * what `JSON.parse` never produces, and it is what drizzle already did.
 */
export function definedRulePatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function partitionRulePatch(
  artifactType: ConfigArtifactType,
  patch: Record<string, unknown>,
): RulePatchPartition {
  const allowed = VERSIONED_RULE_FIELDS[artifactType] ?? [];
  const out: RulePatchPartition = { versioned: {}, selection: {}, unknown: [] };
  for (const [k, v] of Object.entries(definedRulePatch(patch))) {
    if (allowed.includes(k)) out.versioned[k] = v;
    else if (RULE_SELECTION_FIELDS.includes(k) || RULE_IDENTITY_FIELDS.includes(k)) out.selection[k] = v;
    else out.unknown.push(k);
  }
  return out;
}

/**
 * THE LOAD-BEARING LINE OF ADR-0074, and the one place naive "mint a version on
 * every CRUD write" gets it wrong.
 *
 * The new body is composed onto the ACTIVE VERSION'S BODY, not onto the table
 * row. The row is a read-model that may ALREADY have drifted — every rule that
 * was versioned and then touched by a pre-0074 bare writer is drifted right
 * now. Minting from the row would promote that accumulated drift into an
 * enforcing version, i.e. the fix would ratify the bug it is fixing. Composing
 * onto the active body CORRECTS the drift instead.
 *
 * The row is still the fallback layer underneath, because a hand-authored
 * active body may be PARTIAL (every field in `RULE_BODY_SCHEMAS` is optional)
 * and `applyRuleBody` leaves an omitted field coming from the row. So the
 * order is row → active body → patch, and the result is TOTALISED through
 * `ruleBodyFrom` so the minted version states every enforcing field explicitly
 * and no later reader has to know which layer a value came from.
 */
export function composeRuleBody(
  artifactType: ConfigArtifactType,
  row: Record<string, unknown>,
  activeBody: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const effective = applyRuleBody(artifactType, row, activeBody);
  return ruleBodyFrom(artifactType, applyRuleBody(artifactType, effective, patch));
}

/** the body the artifact ENFORCES today, totalised the same way — the thing a
 * composed body must be compared against to answer "did this edit change
 * anything?" */
export function effectiveRuleBody(
  artifactType: ConfigArtifactType,
  row: Record<string, unknown>,
  activeBody: Record<string, unknown>,
): Record<string, unknown> {
  return composeRuleBody(artifactType, row, activeBody, {});
}

/** key-order-independent structural comparison. Needed because a compliance
 * profile's `guardrailModes` is a jsonb record whose key order is whatever
 * Postgres returned, and an accidental "changed" verdict would mint a version
 * and move a canary's baseline for nothing. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // null prototype: a `__proto__` key must stay an ordinary key, not be
    // swallowed as the copy's prototype (and so ignored by the comparison)
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}

export function ruleBodiesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * ADR-0074 — WHAT A CRUD EDIT IS, decided before anything is written.
 *
 * Four outcomes, and the branch names are the vocabulary the ADR, the audit
 * rows and the API responses all use:
 *
 *   `row`          the patch touches no versioned field (or the artifact has no
 *                  version rows at all) → a plain row UPDATE, mint nothing.
 *                  The second half of that is invariant 4: an unversioned rule
 *                  stays byte-identical to pre-ADR-0073 behaviour, and the §5
 *                  lazy baseline stays lazy.
 *   `no_change`    the artifact IS versioned and the composed body is equal to
 *                  what it already enforces → mint nothing. Without this, an
 *                  idempotent re-apply (the onboarding compliance pack is
 *                  explicitly designed to be re-run) would mint a version and
 *                  fill the activation ledger with meaningless moves.
 *   `mint`         the artifact IS versioned, one version is active, and the
 *                  composed body differs → mint + activate.
 *   `unresolvable` version rows exist and NONE is active → REFUSE. There is no
 *                  authoritative base body to compose onto, so minting would be
 *                  a guess. Default-deny extends to WRITES, not only to reads,
 *                  and repairing an unresolvable artifact belongs on the
 *                  explicit audited activate route rather than on a CRUD write
 *                  that would silently pick a winner.
 */
export type RuleEditPlanKind = "row" | "no_change" | "mint" | "unresolvable";

export interface RuleEditPlan {
  kind: RuleEditPlanKind;
  /** the body to mint, set exactly when `kind === "mint"` */
  body: Record<string, unknown> | null;
  /** the body the artifact enforces right now, for the audit diff */
  before: Record<string, unknown> | null;
  /** the enforcing fields whose value this edit actually moves */
  changed: string[];
  /** the non-versioned columns to write straight to the row, always */
  rowPatch: Record<string, unknown>;
  unknownFields: string[];
  reason: string;
}

export function planRuleEdit(input: {
  artifactType: ConfigArtifactType;
  row: Record<string, unknown>;
  patch: Record<string, unknown>;
  /** every stored version of this artifact; empty for an unversioned rule */
  versions: Array<{ status: string; body: Record<string, unknown> }>;
}): RuleEditPlan {
  const { artifactType, row } = input;
  // strip `undefined`-valued keys ONCE, here, so `rowPatch` cannot carry one
  // either: `db.update(t).set({ a: undefined })` generates an empty SET clause
  // and errors, and `Object.keys(...).length > 0` would have let it through.
  const patch = definedRulePatch(input.patch);
  const part = partitionRulePatch(artifactType, patch);
  const base: Omit<RuleEditPlan, "kind" | "reason"> = {
    body: null,
    before: null,
    changed: [],
    rowPatch: part.selection,
    unknownFields: part.unknown,
  };

  if (Object.keys(part.versioned).length === 0) {
    return {
      ...base,
      rowPatch: patch,
      kind: "row",
      reason:
        "this edit touches no enforcing field, so there is no policy change to version — selection columns " +
        "decide which callers a rule is loaded for, not what it does",
    };
  }
  if (input.versions.length === 0) {
    return {
      ...base,
      rowPatch: patch,
      kind: "row",
      reason:
        "this artifact has no stored versions, so its own row is what the kernel resolves — the write is " +
        "byte-identical to pre-ADR-0073 behaviour and minting here would drag an unversioned rule onto the " +
        "version path through ordinary CRUD",
    };
  }
  const active = input.versions.find((v) => v.status === "active") ?? null;
  if (!active) {
    return {
      ...base,
      kind: "unresolvable",
      reason:
        `${artifactType} has ${input.versions.length} stored version(s) but NONE is active, so there is no ` +
        `authoritative body to apply this edit to. Refusing the write rather than guessing a base — activate a ` +
        `version explicitly (POST /v1/config-versions/${artifactType}/:id/activate) and repeat the edit.`,
    };
  }

  const before = effectiveRuleBody(artifactType, row, active.body);
  const after = composeRuleBody(artifactType, row, active.body, part.versioned);
  const changed = Object.keys(after).filter(
    (k) => !ruleBodiesEqual({ v: before[k] }, { v: after[k] }),
  );
  if (changed.length === 0) {
    return {
      ...base,
      before,
      kind: "no_change",
      reason:
        "the composed body is identical to what this artifact already enforces, so no version is minted — " +
        "an idempotent re-apply must not fill the activation ledger with moves that changed nothing",
    };
  }
  return {
    ...base,
    body: after,
    before,
    changed,
    kind: "mint",
    reason:
      `this edit changes ${changed.join(", ")} on a VERSIONED artifact, so it is minted as a new version and ` +
      `activated — writing the row alone would leave dispatch serving the old body`,
  };
}

// ---------------------------------------------------------------------------
// ADR-0074 — THE BASELINE A SHADOW COMPARISON WAS MEASURED AGAINST
// ---------------------------------------------------------------------------

/**
 * A shadow observation records BOTH sides: `candidate_version_id` and
 * `active_version_id`. ADR-0073's two read surfaces aggregated on the candidate
 * ALONE, so observations taken against baseline v3 and against v4 pooled into
 * one `diverged` count with no seam — the number's shape unchanged, its meaning
 * changed, and it flowed into a promotion decision.
 *
 * ADR-0074 makes an ordinary admin edit able to move that baseline (that is the
 * whole point of the write fix), so the seam stops being hypothetical. The
 * posture is ADR-0072's, verbatim: mark history, never rewrite it, and refuse
 * the COMPARISON rather than the CHANGE.
 *
 * A NULL `activeVersionId` is treated as NOT comparable, never as a match. Rows
 * written before an artifact had an active version carry null, and bucketing
 * them with the current baseline would fail towards ALLOWING a promotion on an
 * unattributable sample — the wrong direction.
 */
export interface BaselineBucket {
  activeVersionId: string | null;
  observed: number;
  diverged: number;
  failed: number;
}

export interface BaselineAssessment {
  /** observations measured against the version that is active RIGHT NOW */
  current: BaselineBucket;
  /** observations measured against a baseline that has since moved */
  stranded: BaselineBucket[];
  /** observations that never recorded which baseline they used */
  unattributed: BaselineBucket | null;
  strandedObserved: number;
  stale: boolean;
  note: string | null;
}

export function assessCanaryBaseline(input: {
  activeVersionId: string | null;
  buckets: BaselineBucket[];
}): BaselineAssessment {
  const empty: BaselineBucket = { activeVersionId: input.activeVersionId, observed: 0, diverged: 0, failed: 0 };
  let current = empty;
  const stranded: BaselineBucket[] = [];
  let unattributed: BaselineBucket | null = null;
  for (const b of input.buckets) {
    if (b.activeVersionId == null) unattributed = b;
    else if (input.activeVersionId != null && b.activeVersionId === input.activeVersionId) current = b;
    else stranded.push(b);
  }
  const strandedObserved =
    stranded.reduce((n, b) => n + b.observed, 0) + (unattributed?.observed ?? 0);
  const stale = strandedObserved > 0;
  return {
    current,
    stranded,
    unattributed,
    strandedObserved,
    stale,
    note: stale
      ? `${strandedObserved} observation(s) compared this candidate against a version that is no longer active` +
        (unattributed ? ` (${unattributed.observed} of them recorded no baseline at all)` : "") +
        `; they are reported separately and are NOT included in the totals above, because pooling them would ` +
        `average two different comparisons into one number`
      : null,
  };
}

/**
 * The promote-time gate that goes with it. It lands on the PROMOTION, never on
 * the EDIT: an urgent policy change is never blocked by a running measurement,
 * and the only thing that becomes harder is ACTING ON a measurement whose
 * baseline moved — which is precisely the thing that should be hard.
 *
 * Mirrors ADR-0072 §3.2 case 3, including its refusal to silently re-scope: a
 * human chose this comparison, and quietly substituting the post-seam subset is
 * an answer to a question nobody asked.
 */
export interface StaleBaselineDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
}

export function evaluateBaselineFreshness(input: {
  assessment: BaselineAssessment;
  override: boolean;
  reason: string | null | undefined;
}): StaleBaselineDecision {
  const a = input.assessment;
  if (!a.stale) {
    return { allowed: true, ruleId: "canary-baseline-current", reason: "every observation was measured against the version that is active now" };
  }
  const why =
    `${a.strandedObserved} of this canary's observation(s) were measured against a baseline that has since ` +
    `moved, and ${a.current.observed} against the version active now. The sample you are promoting on is not ` +
    `one comparison.`;
  if (!input.override) {
    return {
      allowed: false,
      ruleId: "canary-promote-stale-baseline",
      reason:
        `${why} Re-point the canary (POST …/canary) to start a fresh comparison window against the current ` +
        `active version, or promote with an explicit override and a reason.`,
    };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return {
      allowed: false,
      ruleId: "canary-promote-override-no-reason",
      reason: "an override of the stale-baseline refusal must state why; an unexplained bypass is not accepted",
    };
  }
  return {
    allowed: true,
    ruleId: "canary-promote-stale-baseline-override",
    reason: `promoted on a MIXED-BASELINE sample (${why}) — manual override: ${input.reason}`,
  };
}

// ---------------------------------------------------------------------------
// ADR-0073 — SHADOW RESOLUTION
// ---------------------------------------------------------------------------

export interface ShadowResolution {
  /** the version that ENFORCES. Null only when the artifact has no versions at
   * all (pre-versioning fallback) or is unresolvable — see `unresolvable`. */
  served: VersionLike | null;
  /** the version to evaluate IN PARALLEL and never enforce. Null when there is
   * no canary, or when this stable key fell outside the sampling rate. */
  candidate: VersionLike | null;
  /** a canary exists but this key was not sampled — recorded so a zero
   * observation count is distinguishable from "no canary" */
  candidateSampledOut: boolean;
  bucket: number | null;
  /**
   * DEFAULT-DENY: set when version rows EXIST for this artifact but none of
   * them is `active`. There is then no answer to "what does this rule say", and
   * the caller must fail closed with this reason rather than treat the rule as
   * absent — a dropped RESTRICTION is a widening, which is precisely the
   * direction a governance kernel may never fail in.
   */
  unresolvable: string | null;
}

/**
 * Resolve one rule/profile artifact for enforcement plus shadow.
 *
 * `canaryPct` is honoured here as a SAMPLING RATE on the same deterministic
 * stable key `canaryBucket` already uses, not as a share of enforcement. Two
 * consequences, both deliberate:
 *
 *   - the same caller is sampled consistently, so a divergence report is not a
 *     scatter of unrelated one-off decisions;
 *   - an operator can shadow 5% of a busy fleet without writing an observation
 *     row per call, and 100% when they want the complete blast radius.
 *
 * Nothing about the sampling can reach the served decision: `served` is the
 * active version whatever the bucket says.
 */
export function resolveForShadow(input: {
  artifactType: ConfigArtifactType;
  artifactId: string;
  versions: VersionLike[];
  stableKey: string;
}): ShadowResolution {
  const none: ShadowResolution = {
    served: null,
    candidate: null,
    candidateSampledOut: false,
    bucket: null,
    unresolvable: null,
  };
  if (input.versions.length === 0) return none;

  const active = input.versions.find((v) => v.status === "active") ?? null;
  if (!active) {
    return {
      ...none,
      unresolvable:
        `${input.artifactType} ${input.artifactId} has ${input.versions.length} stored version(s) but NONE is ` +
        `active, so there is no authoritative definition of this rule. Refusing the call rather than ` +
        `evaluating without it — an unresolvable restriction that is skipped is a silent widening.`,
    };
  }

  const canary = canaryIsShadowEvaluated(input.artifactType)
    ? (input.versions.find((v) => v.status === "canary") ?? null)
    : null;
  if (!canary) return { ...none, served: active };

  const bucket = canaryBucket(input.artifactId, input.stableKey);
  const sampled = bucket < (canary.canaryPct ?? 0);
  return {
    served: active,
    candidate: sampled ? canary : null,
    candidateSampledOut: !sampled,
    bucket,
    unresolvable: null,
  };
}

// ---------------------------------------------------------------------------
// Eval-gated promotion (ADR-0048 §4)
// ---------------------------------------------------------------------------

export interface EvalEvidence {
  id: string;
  status: string;
  gatePassed: boolean | null;
  regression: boolean | null;
  /** the run must post-date the version it is claimed to prove */
  startedAt: Date;
}

export interface PromotionDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
  evalRunId: string | null;
  override: boolean;
}

/**
 * A canary may be promoted to active when an ADR-0044 run against a version
 * created NO EARLIER than the canary passed its thresholds. Otherwise promotion
 * is possible only as an explicit, audited manual override WITH A REASON —
 * `ruleId: canary-promote-override`, exactly as §4 names it.
 *
 * The "no earlier than" check is the part that makes this a gate rather than a
 * checkbox: without it, a passing run from before the change would satisfy the
 * gate for the change it never measured.
 */
export function evaluatePromotion(input: {
  canaryCreatedAt: Date;
  evidence: EvalEvidence | null;
  override: boolean;
  reason: string | null | undefined;
}): PromotionDecision {
  const ev = input.evidence;
  if (ev && ev.status === "completed" && ev.gatePassed === true && ev.startedAt >= input.canaryCreatedAt) {
    return {
      allowed: true,
      ruleId: "canary-promoted-eval-gated",
      reason: `promotion gated by ADR-0044 eval run ${ev.id}, which passed against this canary version`,
      evalRunId: ev.id,
      override: false,
    };
  }

  const why = !ev
    ? "no ADR-0044 eval run was cited"
    : ev.startedAt < input.canaryCreatedAt
      ? `eval run ${ev.id} predates the canary version and therefore never measured it`
      : ev.status !== "completed"
        ? `eval run ${ev.id} is '${ev.status}', not completed`
        : `eval run ${ev.id} did not pass the regression thresholds`;

  if (!input.override) {
    return {
      allowed: false,
      ruleId: "canary-promote-blocked",
      reason: `${why} — promote with an explicit override and a reason, or run an eval that passes`,
      evalRunId: ev?.id ?? null,
      override: false,
    };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return {
      allowed: false,
      ruleId: "canary-promote-override-no-reason",
      reason: "an override of the quality gate must state why; an unexplained bypass is not accepted",
      evalRunId: ev?.id ?? null,
      override: true,
    };
  }
  return {
    allowed: true,
    ruleId: "canary-promote-override",
    reason: `promoted WITHOUT a passing eval gate (${why}) — manual override: ${input.reason}`,
    evalRunId: ev?.id ?? null,
    override: true,
  };
}

/**
 * The stable key a dispatch buckets on, in ADR-0048 §2's priority order:
 * run id, else conversation id, else the initiating user. Extracted so the
 * ordering is one testable decision rather than an inline `??` chain.
 */
export function stableKeyFor(ctx: {
  runId?: string | null;
  conversationId?: string | null;
  userId: string;
}): string {
  return ctx.runId ?? ctx.conversationId ?? ctx.userId;
}
