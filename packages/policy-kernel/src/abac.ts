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

/** the schema version stored on every policy version row */
export type AbacSchemaVersion = "v1";
export const ABAC_SCHEMA_VERSIONS: readonly AbacSchemaVersion[] = ["v1"];
export const ABAC_CURRENT_SCHEMA_VERSION: AbacSchemaVersion = "v1";

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

const SCHEMAS: Record<AbacSchemaVersion, unknown> = { v1: SCHEMA_V1 };

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

function entitiesFor(req: AbacRequest): cedar.Entities {
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

function contextFor(req: AbacRequest, timezone: string): cedar.Context {
  const t = timeInZone(req.at ?? new Date(), timezone);
  return {
    deployModes: [...req.context.deployModes],
    environments: [...req.context.environments],
    hour: t.hour,
    minute: t.minute,
    dayOfWeek: t.dayOfWeek,
    timezone,
    rateLimitUsagePct: Math.max(0, Math.min(100, Math.trunc(req.context.rateLimitUsagePct))),
  };
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

    const entities = entitiesFor(request);
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
          context: contextFor(request, tz),
          schema: schema as cedar.Schema,
          validateRequest: true,
          policies: { staticPolicies },
          entities,
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
