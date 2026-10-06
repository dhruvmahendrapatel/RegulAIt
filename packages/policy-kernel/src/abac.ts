/**
 * ADR-0040 — the THIN Cedar engine wrapper.
 *
 * This is the ONLY module in the codebase that knows Cedar exists. Everything
 * above it — the kernel, the gateway, the admin API — speaks the neutral
 * `AbacEngine` interface below, so swapping Cedar for OPA/Rego (the ADR's named
 * fallback) is a contained change: implement this interface again, and nothing
 * else moves.
 *
 * WHY IN-PROCESS. `@cedar-policy/cedar-wasm` embeds the Rust Cedar core as
 * WebAssembly and evaluates synchronously in this process. There is no sidecar
 * to run, patch or secure, and no network hop — which is the whole reason Cedar
 * was chosen over an OPA service (ADR-0040 §Decision): `policy-kernel` is
 * already a pure in-process module, and an air-gapped deployment must not gain
 * a network dependency in its enforcement path.
 *
 * WHAT THIS MODULE IS *NOT*. It is not imported by `index.ts`. The kernel stays
 * a zero-dependency, zero-I/O evaluator that receives an already-computed
 * `AbacDecision`; this file is what the GATEWAY calls to compute one. Importing
 * `@regulait/policy-kernel` never loads the wasm module.
 *
 * TWO INVARIANTS THIS FILE MUST NEVER BREAK:
 *
 *  1. **It cannot grant.** `evaluateAbac` returns `permit` (meaning "nothing
 *     forbade this"), `forbid`, or `require_approval` — there is deliberately
 *     no return value that means "allow something the RBAC layer did not".
 *     A Cedar `permit` policy in the stored set is inert: it can only fail to
 *     forbid. The kernel then consults the verdict strictly on its allow path.
 *  2. **Time is evaluated in the POLICY'S declared timezone**, never the
 *     server's incidental locale and never a client clock. Policies are grouped
 *     by their declared IANA zone and each group is evaluated against
 *     hour/minute/day-of-week computed in that zone (see `timeInZone`).
 */
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import type { AbacDecision, AbacEffect } from "./index.js";

export type { AbacDecision, AbacEffect };

/** the Cedar namespace every entity/action/schema identifier lives under */
export const ABAC_NAMESPACE = "RegulAIt";
/** the one action this ADR wires an enforcement point for — see SCOPE below */
export const ABAC_ACTION = "McpToolCall";
/** the default IANA zone when a policy declares none */
export const ABAC_DEFAULT_TIMEZONE = "UTC";

/**
 * SCOPE (honest deviation, ADR-0040 amendment). The attribute schema declares
 * exactly ONE action — `McpToolCall` — because that is the one governed path
 * with a single gateway choke point (`governedEvaluate`) where the attribute
 * context can be assembled once and enforced for every caller. Agent and
 * connector actions are deliberately ABSENT from the schema rather than
 * present-but-unwired: a policy that names them fails VALIDATION at write time,
 * so an admin can never author a policy that silently enforces nothing. Adding
 * them is a schema-version bump plus wiring, not a redesign.
 */

// ---------------------------------------------------------------------------
// The versioned attribute schema
// ---------------------------------------------------------------------------

/**
 * The schema version stored on every policy version row.
 *
 * v1 and v2 are BOTH evaluated, each against its own schema — `evaluate` groups
 * the stored policies by `schemaVersion` and runs one authorization per group.
 * A v1 policy is therefore not broken, not migrated and not re-validated by the
 * arrival of v2; it simply keeps meaning what it meant. That is the entire
 * reason this field is versioned rather than global.
 */
export type AbacSchemaVersion = "v1" | "v2" | "v3";
export const ABAC_SCHEMA_VERSIONS: readonly AbacSchemaVersion[] = ["v1", "v2", "v3"];
/** ADR-0182 A14: new policies are stamped v3, so `principal.aiTrainingCurrent` is reachable */
export const ABAC_CURRENT_SCHEMA_VERSION: AbacSchemaVersion = "v3";

/**
 * v1 of the Cedar schema. It is code, not data, on purpose: the attributes a
 * policy may reference are exactly the attributes the gateway assembles, and
 * those two things must move together or a policy can reference something that
 * is never populated. The stored `schema_version` on each policy version is
 * what ties a policy to the shape it was written against — and Cedar's
 * strict-mode validation turns "referenced an attribute that does not exist"
 * into a WRITE-TIME ERROR instead of a silent runtime no-match (ADR-0040 §
 * "The attribute schema is a Cedar schema, versioned with the policies").
 *
 * Attributes marked `required: false` may be genuinely absent (an unattributed
 * call has no project); Cedar strict validation then forces the policy author
 * to guard with `resource has projectId && …`, which is exactly the discipline
 * we want.
 */
const SCHEMA_V1 = {
  [ABAC_NAMESPACE]: {
    entityTypes: {
      // ---- principal: who is calling (ADR-0040 "User/principal" bag) -------
      User: {
        shape: {
          type: "Record" as const,
          attributes: {
            /** role NAMES the user holds, incl. group-derived ones (ADR-0038) */
            roles: { type: "Set" as const, element: { type: "String" as const } },
            /** role IDS, for policies that prefer to pin an immutable handle */
            roleIds: { type: "Set" as const, element: { type: "String" as const } },
            /** team NAMES the user belongs to */
            teams: { type: "Set" as const, element: { type: "String" as const } },
            isAdmin: { type: "Boolean" as const },
            /** ADR-0028 session origin: password|oidc|saml|api_key|bootstrap|unknown */
            sessionOrigin: { type: "String" as const },
            /** the caller completed a second factor to establish this session */
            mfaCompleted: { type: "Boolean" as const },
          },
        },
      },
      // ---- resource: what is being called (ADR-0040 "Resource" bag) --------
      Tool: {
        shape: {
          type: "Record" as const,
          attributes: {
            serverId: { type: "String" as const },
            serverName: { type: "String" as const },
            toolName: { type: "String" as const },
            /** "read" | "write" — the kernel's own ToolKind classification */
            kind: { type: "String" as const },
            /** "unpriced" | "free" | "metered" — coarse price tier */
            priceTier: { type: "String" as const },
            /** pillar-5 attribution; absent on an unattributed call */
            projectId: { type: "String" as const, required: false },
            projectName: { type: "String" as const, required: false },
            /** §8.3 compliance framework tags of the attributed project */
            classifications: { type: "Set" as const, element: { type: "String" as const } },
            /** the strictest data-sensitivity the cascade resolves to, if any */
            dataSensitivity: { type: "String" as const, required: false },
          },
        },
      },
    },
    actions: {
      [ABAC_ACTION]: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Tool"],
          // ---- context: the circumstances (ADR-0040 "Context" bag) --------
          // EVERY field here is SERVER-DERIVED. Nothing a client can assert
          // reaches this record — that is the ADR's honest-risk #2 mitigation.
          context: {
            type: "Record" as const,
            attributes: {
              /** A4 server-derived deploy modes: hosted | byoc | air_gapped */
              deployModes: { type: "Set" as const, element: { type: "String" as const } },
              /** server-derived target environments (e.g. production, sandbox) */
              environments: { type: "Set" as const, element: { type: "String" as const } },
              /** 0–23 in the POLICY'S declared timezone, never the server's */
              hour: { type: "Long" as const },
              minute: { type: "Long" as const },
              /** 0 = Sunday … 6 = Saturday, in the policy's declared timezone */
              dayOfWeek: { type: "Long" as const },
              /** the IANA zone the three fields above were computed in */
              timezone: { type: "String" as const },
              /** highest per-window rate-limit consumption at this call site, 0–100 */
              rateLimitUsagePct: { type: "Long" as const },
            },
          },
        },
      },
    },
  },
};

/**
 * v2 = v1 plus ONE context attribute: `clientIp`, the network location the
 * request came from.
 *
 * ── WHY CEDAR'S OWN `ipaddr` AND NOT A STRING ──────────────────────────────
 * Cedar ships an `ipaddr` extension type with `isInRange`, `isIpv4`, `isIpv6`
 * and `isLoopback`, so a policy author writes
 * `context.clientIp.isInRange(ip("10.0.0.0/8"))` and gets real CIDR semantics
 * from the engine. Exposing a String instead would have meant either shipping a
 * second CIDR matcher of our own (there is already one in the gateway's
 * `net-policy.ts`, for session IP allow-listing) or leaving authors to do prefix
 * comparisons on text — which is how `10.1.0.0/16` ends up matching `10.10.…`.
 *
 * ── WHY NOT REUSE `org_settings.session_ip_allowlist` ──────────────────────
 * That list governs SESSION CREATION. Deriving an `inCorporateNetwork` boolean
 * from it would mean an admin who tightened where people may log in had
 * silently changed what every ABAC policy sees — two different facts wearing one
 * control, which is the same mistake ADR-0126 refused when it kept the breaker,
 * ADR-0124's halt and `agents.enabled` in three separate columns. The raw
 * address goes to the policy and the policy decides; no new org column, and
 * nothing to keep in step.
 *
 * ── WHY `required: false`, WHICH IS THE LOAD-BEARING PART ──────────────────
 * The client IP is genuinely UNDETERMINABLE here. ADR-0031 trusts no proxy by
 * default, so behind an untrusted hop `req.ip` is the hop's address or nothing
 * at all. Declaring the attribute optional makes Cedar's strict validation
 * REFUSE a policy that says `context.clientIp.isInRange(…)` without first
 * guarding `context has clientIp` — so "we do not know where this came from"
 * becomes a case the author must decide at WRITE time, instead of a silent
 * no-match at runtime. A required attribute with a sentinel (`0.0.0.0`) would
 * have let an unknown origin quietly test as a real address.
 *
 * There is deliberately NO device-posture attribute. Nothing in this product
 * can observe device posture, and an attribute we cannot populate honestly is
 * the AER-036 mistake in a new place: a field that looks like evidence and is
 * an assertion nobody checked.
 */
const SCHEMA_V2 = (() => {
  const base = structuredClone(SCHEMA_V1) as typeof SCHEMA_V1;
  const ctx = base[ABAC_NAMESPACE].actions[ABAC_ACTION].appliesTo.context;
  (ctx.attributes as Record<string, unknown>).clientIp = {
    type: "Extension" as const,
    name: "ipaddr" as const,
    required: false,
  };
  return base;
})();

/**
 * ADR-0182 (ADR-0175 batch D4) A14 — v3 = v2 plus ONE principal attribute: `aiTrainingCurrent`, so a policy can
 * require current AI literacy for a grant or a sensitive tool:
 *
 *   forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
 *   when { resource.kind == "write" } unless { principal.aiTrainingCurrent };
 *
 * It is true only when at least one published AI policy or training applies to the person AND every one is
 * acknowledged at its current version and unexpired (shared `aiTrainingCurrentOf`). Never vacuously true: an org
 * that published nothing does not satisfy a policy that asks for current training.
 *
 * REQUIRED, not optional: the gateway always knows the answer (it is a fact about stored rows, unlike `clientIp`),
 * so an author need not guard it with `has`. v1 and v2 policies never see it — `entitiesFor` emits it only for a
 * v3 group, because an undeclared entity attribute fails request validation and this engine fails closed.
 */
const SCHEMA_V3 = (() => {
  const base = structuredClone(SCHEMA_V2) as typeof SCHEMA_V2;
  const user = base[ABAC_NAMESPACE].entityTypes.User.shape;
  (user.attributes as Record<string, unknown>).aiTrainingCurrent = { type: "Boolean" as const };
  return base;
})();

const SCHEMAS: Record<AbacSchemaVersion, unknown> = { v1: SCHEMA_V1, v2: SCHEMA_V2, v3: SCHEMA_V3 };

/** does this schema version carry `principal.aiTrainingCurrent`? (v3 and later) */
function hasAiTrainingAttribute(schemaVersion: string): boolean {
  return schemaVersion !== "v1" && schemaVersion !== "v2";
}

export function abacSchema(version: string): unknown | null {
  return SCHEMAS[version as AbacSchemaVersion] ?? null;
}

/** the human-readable Cedar schema text, for the admin editor's reference pane */
export function abacSchemaText(version: string): string | null {
  const json = abacSchema(version);
  if (!json) return null;
  const answer = cedar.schemaToText(json as cedar.Schema);
  return answer.type === "success" ? answer.text : null;
}

// ---------------------------------------------------------------------------
// The neutral interface everything above this file speaks
// ---------------------------------------------------------------------------

/** the effect a policy applies WHEN IT MATCHES — never "allow" (ABAC cannot grant) */
export type AbacPolicyMode = "forbid" | "require_approval";
export const ABAC_POLICY_MODES: readonly AbacPolicyMode[] = ["forbid", "require_approval"];

export interface AbacPolicy {
  /** stable policy id (survives version bumps) — this is what lands in `ruleId` */
  id: string;
  name: string;
  /** Cedar policy source text */
  source: string;
  mode: AbacPolicyMode;
  /** IANA timezone the policy's time attributes are evaluated in */
  timezone: string;
  schemaVersion: string;
  version?: number | null;
  approverUserId?: string | null;
  approverName?: string | null;
  description?: string | null;
}

export interface AbacPrincipalAttrs {
  id: string;
  roles: readonly string[];
  roleIds: readonly string[];
  teams: readonly string[];
  isAdmin: boolean;
  sessionOrigin: string;
  mfaCompleted: boolean;
  /**
   * Schema v3 (ADR-0182 A14). Built by the gateway's `assembleAbacRequest` — the one place enforcement AND the
   * simulation surface build the bag — from the stored AI policies and acknowledgements. Absent reads as false
   * (the strict answer) for a v3 policy; v1/v2 policies never see it.
   */
  aiTrainingCurrent?: boolean | undefined;
}

export interface AbacResourceAttrs {
  /** the tool's stable handle — "<serverId>/<toolName>" */
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  kind: string;
  priceTier: string;
  projectId?: string | null;
  projectName?: string | null;
  classifications: readonly string[];
  dataSensitivity?: string | null;
}

export interface AbacContextAttrs {
  deployModes: readonly string[];
  environments: readonly string[];
  rateLimitUsagePct: number;
  /**
   * The network location the request came from, as a plain address string
   * ("203.0.113.7", "2001:db8::1"). Absent or null = undeterminable, which is
   * an ordinary outcome here and not an error: ADR-0031 trusts no proxy by
   * default. Only reaches a policy evaluated under schema v2 or later, and only
   * when it parses — see `contextFor`.
   */
  clientIp?: string | null | undefined;
}

export interface AbacRequest {
  principal: AbacPrincipalAttrs;
  resource: AbacResourceAttrs;
  context: AbacContextAttrs;
  /** the instant to evaluate time-of-day at; defaults to now */
  at?: Date;
}

export interface AbacValidationIssue {
  message: string;
  help?: string | null;
}

export interface AbacValidationResult {
  ok: boolean;
  errors: AbacValidationIssue[];
  warnings: AbacValidationIssue[];
}

export interface AbacEngine {
  /** identifies the engine + version in audit prose and the admin UI */
  readonly engine: string;
  /**
   * Parse + strict-validate one policy source against a schema version.
   * A policy referencing an attribute the schema does not declare is an ERROR
   * here, at WRITE time — never a silent runtime no-match.
   */
  validate(source: string, schemaVersion: string, mode?: AbacPolicyMode): AbacValidationResult;
  /**
   * Evaluate the active policy set against one request. Returns `permit` when
   * nothing forbade — NEVER a grant. Pure and synchronous.
   */
  evaluate(policies: readonly AbacPolicy[], request: AbacRequest): AbacDecision;
}

// ---------------------------------------------------------------------------
// Time — in the POLICY'S zone, not the server's
// ---------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** true when the string is an IANA zone this runtime can actually resolve */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * hour/minute/day-of-week of `at`, computed in `timezone`.
 *
 * THE POINT: `process.env.TZ` is irrelevant here. A policy that says "not
 * between 22:00 and 06:00" means 22:00 in the zone the policy DECLARES — an
 * operator in Frankfurt and a container running in UTC must reach the same
 * verdict, and a client clock is never consulted at all.
 */
export function timeInZone(
  at: Date,
  timezone: string,
): { hour: number; minute: number; dayOfWeek: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Intl renders midnight as "24" in some ICU builds under hour12:false
  const hour = Number(get("hour")) % 24;
  return {
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number(get("minute")) || 0,
    dayOfWeek: WEEKDAYS[get("weekday")] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The Cedar implementation
// ---------------------------------------------------------------------------

const entityUid = (type: string, id: string) => ({ type: `${ABAC_NAMESPACE}::${type}`, id });

function detail(e: cedar.DetailedError): AbacValidationIssue {
  return { message: e.message, help: e.help ?? null };
}

/** drop undefined/null optional attrs so Cedar sees them as genuinely absent */
function compact(attrs: Record<string, unknown>): Record<string, cedar.CedarValueJson> {
  const out: Record<string, cedar.CedarValueJson> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    out[k] = v as cedar.CedarValueJson;
  }
  return out;
}

/**
 * The entities, per SCHEMA VERSION — for the same reason `contextFor` takes one: `isAuthorized` validates entities
 * against the group's schema, so an attribute v1/v2 do not declare (`aiTrainingCurrent`) would fail every v1/v2
 * evaluation closed. v3 and later get it, defaulting to false when the caller did not supply it.
 */
function entitiesFor(req: AbacRequest, schemaVersion: string): cedar.Entities {
  return [
    {
      uid: entityUid("User", req.principal.id),
      attrs: compact({
        roles: [...req.principal.roles],
        roleIds: [...req.principal.roleIds],
        teams: [...req.principal.teams],
        isAdmin: req.principal.isAdmin,
        sessionOrigin: req.principal.sessionOrigin,
        mfaCompleted: req.principal.mfaCompleted,
        ...(hasAiTrainingAttribute(schemaVersion) ? { aiTrainingCurrent: req.principal.aiTrainingCurrent === true } : {}),
      }),
      parents: [],
    },
    {
      uid: entityUid("Tool", req.resource.id),
      attrs: compact({
        serverId: req.resource.serverId,
        serverName: req.resource.serverName,
        toolName: req.resource.toolName,
        kind: req.resource.kind,
        priceTier: req.resource.priceTier,
        projectId: req.resource.projectId,
        projectName: req.resource.projectName,
        classifications: [...req.resource.classifications],
        dataSensitivity: req.resource.dataSensitivity,
      }),
      parents: [],
    },
  ];
}

/**
 * Is this a literal IP address Cedar's `ip()` constructor will accept?
 *
 * PARSED, NOT PATTERN-MATCHED where it matters: `ip("garbage")` is a Cedar
 * EVALUATION ERROR, and this engine fails closed on an evaluation failure — so
 * one malformed `X-Forwarded-For` reaching the context would turn every
 * IP-aware policy into a blanket deny. Anything that does not parse is treated
 * as "undeterminable" and the attribute is omitted, which is the case the
 * policy already has to guard with `context has clientIp`.
 *
 * Deliberately strict: no ports, no zone ids, no CIDR suffix, no brackets. A
 * value carrying any of those is not this request's address.
 */
function isLiteralIpAddress(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;
  if (value.includes("/") || value.includes("%") || value.includes("[")) return false;
  // IPv4: four decimal octets, no leading zeros beyond a bare "0"
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    return v4.slice(1).every((part) => {
      if (part.length > 1 && part.startsWith("0")) return false;
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }
  // IPv6: hex groups with at most one "::" elision, optional IPv4 tail
  if (!value.includes(":")) return false;
  if ((value.match(/::/g) ?? []).length > 1) return false;
  const tail = value.slice(value.lastIndexOf(":") + 1);
  const head = tail.includes(".") ? value.slice(0, value.lastIndexOf(":") + 1) : value;
  if (tail.includes(".") && !isLiteralIpAddress(tail)) return false;
  const groups = head.split(":").filter((g) => g.length > 0);
  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  const max = tail.includes(".") ? 6 : 8;
  return value.includes("::") ? groups.length <= max : groups.length === max;
}

/**
 * THE CONTEXT BAG, and note that it takes the SCHEMA VERSION.
 *
 * That parameter is load-bearing rather than tidy. `isAuthorized` is called
 * with `validateRequest: true`, so a context attribute the group's schema does
 * not declare is a REQUEST VALIDATION FAILURE — and this engine turns a failure
 * into `forbid` (correctly: an ABAC layer that stops enforcing when it errors is
 * worse than no ABAC layer). Emitting `clientIp` unconditionally would therefore
 * have fail-closed every call governed by a stored v1 policy, which is as close
 * to a self-inflicted outage as this file can get. v1 groups get exactly the v1
 * bag; only v2 and later see `clientIp`.
 */
function contextFor(req: AbacRequest, timezone: string, schemaVersion: string): cedar.Context {
  const t = timeInZone(req.at ?? new Date(), timezone);
  const ctx: cedar.Context = {
    deployModes: [...req.context.deployModes],
    environments: [...req.context.environments],
    hour: t.hour,
    minute: t.minute,
    dayOfWeek: t.dayOfWeek,
    timezone,
    rateLimitUsagePct: Math.max(0, Math.min(100, Math.trunc(req.context.rateLimitUsagePct))),
  };
  const ip = req.context.clientIp;
  if (schemaVersion !== "v1" && typeof ip === "string" && isLiteralIpAddress(ip)) {
    ctx.clientIp = { __extn: { fn: "ip", arg: ip } };
  }
  return ctx;
}

class CedarAbacEngine implements AbacEngine {
  readonly engine = `cedar-wasm@${cedar.getCedarVersion()}`;

  validate(source: string, schemaVersion: string, mode?: AbacPolicyMode): AbacValidationResult {
    const schema = abacSchema(schemaVersion);
    if (!schema) {
      return {
        ok: false,
        errors: [
          {
            message: `unknown ABAC schema version '${schemaVersion}'`,
            help: `known versions: ${ABAC_SCHEMA_VERSIONS.join(", ")}`,
          },
        ],
        warnings: [],
      };
    }

    // 1. it must parse at all
    const parsed = cedar.checkParsePolicySet({ staticPolicies: source });
    if (parsed.type === "failure") {
      return { ok: false, errors: parsed.errors.map(detail), warnings: [] };
    }

    // 2. exactly ONE statement per stored policy. The stored row's uuid is the
    //    Cedar policy id, and that id is what lands in `ruleId` and in the
    //    Approvals row — so "which policy denied this" must be unambiguous.
    const parts = cedar.policySetTextToParts(source);
    if (parts.type === "failure") {
      return { ok: false, errors: parts.errors.map(detail), warnings: [] };
    }
    if (parts.policy_templates.length > 0) {
      return {
        ok: false,
        errors: [{ message: "policy templates are not supported — write a concrete policy", help: null }],
        warnings: [],
      };
    }
    if (parts.policies.length !== 1) {
      return {
        ok: false,
        errors: [
          {
            message: `expected exactly one Cedar statement, found ${parts.policies.length}`,
            help: "store each policy as its own record so denials name one policy id",
          },
        ],
        warnings: [],
      };
    }

    // 3. ABAC CANNOT GRANT. A `permit` is inert here (it can only fail to
    //    forbid), and storing one would mislead an admin into thinking they
    //    had widened access, so it is refused outright rather than accepted
    //    and quietly ignored.
    const json = cedar.policyToJson(parts.policies[0]!);
    if (json.type === "success" && json.json.effect !== "forbid") {
      return {
        ok: false,
        errors: [
          {
            message: "ABAC policies must be `forbid` — ABAC can never grant access",
            help:
              "RBAC grants the base entitlement (ADR-0013/0014); an ABAC policy can only further restrict it. " +
              "Use mode 'require_approval' if the call should pause rather than be refused.",
          },
        ],
        warnings: [],
      };
    }

    // 4. strict schema validation — the write-time attribute check
    const answer = cedar.validate({
      schema: schema as cedar.Schema,
      policies: { staticPolicies: source },
      validationSettings: { mode: "strict" },
    });
    if (answer.type === "failure") {
      return { ok: false, errors: answer.errors.map(detail), warnings: answer.warnings.map(detail) };
    }
    if (answer.validationErrors.length > 0) {
      return {
        ok: false,
        errors: answer.validationErrors.map((e) => detail(e.error)),
        warnings: answer.validationWarnings.map((w) => detail(w.error)),
      };
    }
    const warnings = [
      ...answer.validationWarnings.map((w) => detail(w.error)),
      ...answer.otherWarnings.map(detail),
    ];
    if (mode && !ABAC_POLICY_MODES.includes(mode)) {
      return { ok: false, errors: [{ message: `unknown policy mode '${mode}'`, help: null }], warnings };
    }
    return { ok: true, errors: [], warnings };
  }

  evaluate(policies: readonly AbacPolicy[], request: AbacRequest): AbacDecision {
    if (policies.length === 0) return { effect: "permit" };

    // Group by DECLARED timezone: each group is evaluated against its own
    // clock, so two policies in two zones both mean what they say. Grouping
    // (rather than one call per policy) keeps the common single-zone case to
    // exactly one wasm call.
    const byZone = new Map<string, AbacPolicy[]>();
    for (const p of policies) {
      const tz = isValidTimezone(p.timezone) ? p.timezone : ABAC_DEFAULT_TIMEZONE;
      const list = byZone.get(tz) ?? [];
      list.push(p);
      byZone.set(tz, list);
    }

    const matched: AbacPolicy[] = [];
    for (const [tz, group] of byZone) {
      const bySchema = new Map<string, AbacPolicy[]>();
      for (const p of group) {
        const list = bySchema.get(p.schemaVersion) ?? [];
        list.push(p);
        bySchema.set(p.schemaVersion, list);
      }
      for (const [schemaVersion, subset] of bySchema) {
        const schema = abacSchema(schemaVersion);
        if (!schema) continue; // an unknown schema version cannot be evaluated
        const staticPolicies: Record<string, string> = {};
        for (const p of subset) staticPolicies[p.id] = p.source;
        const answer = cedar.isAuthorized({
          principal: entityUid("User", request.principal.id),
          action: { type: `${ABAC_NAMESPACE}::Action`, id: ABAC_ACTION },
          resource: entityUid("Tool", request.resource.id),
          context: contextFor(request, tz, schemaVersion),
          schema: schema as cedar.Schema,
          validateRequest: true,
          policies: { staticPolicies },
          entities: entitiesFor(request, schemaVersion),
        });
        if (answer.type === "failure") {
          // A malformed request/policy set must FAIL CLOSED, not silently
          // permit: an ABAC layer that stops enforcing when it errors is worse
          // than no ABAC layer. The whole evaluation degrades to a deny naming
          // the engine failure.
          return {
            effect: "forbid",
            policyId: "abac-engine-error",
            policyName: null,
            reason: `ABAC evaluation failed: ${answer.errors.map((e) => e.message).join("; ")}`,
          };
        }
        // Cedar returns "deny" both for "a forbid matched" and for "no permit
        // matched". Only the FIRST is a policy decision, and Cedar names the
        // satisfied forbids in diagnostics.reason — an empty reason on a deny
        // means nothing matched at all. That distinction is what keeps a
        // `permit`-less policy set from denying everything.
        const { decision, diagnostics } = answer.response;
        if (decision !== "deny" || diagnostics.reason.length === 0) continue;
        const hit = new Set(diagnostics.reason);
        for (const p of subset) if (hit.has(p.id)) matched.push(p);
      }
    }

    if (matched.length === 0) return { effect: "permit" };

    // PRECEDENCE among matched policies: a hard `forbid` beats a
    // `require_approval` (strictest wins — an approver must not be able to sign
    // away a policy that refuses outright), and within a mode the policies are
    // ordered by name so the governing policy is stable and explainable.
    matched.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === "forbid" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const governing = matched[0]!;
    return {
      effect: governing.mode,
      policyId: governing.id,
      policyName: governing.name,
      policyVersion: governing.version ?? null,
      matchedPolicyIds: matched.map((p) => p.id),
      approverUserId: governing.approverUserId ?? null,
      approverName: governing.approverName ?? null,
      reason: governing.description ?? null,
    };
  }
}

/** the process-wide engine. Stateless, so one instance is enough. */
export const abacEngine: AbacEngine = new CedarAbacEngine();

/**
 * Convenience for the kernel-facing path: no policies at all yields `null`
 * rather than `{effect:"permit"}`, so the gateway hands the kernel an ABSENT
 * input and the decision is byte-identical to the pre-ADR-0040 behaviour
 * (empty policy set = today, exactly).
 */
export function evaluateAbac(
  policies: readonly AbacPolicy[],
  request: AbacRequest,
): AbacDecision | null {
  if (policies.length === 0) return null;
  return abacEngine.evaluate(policies, request);
}
