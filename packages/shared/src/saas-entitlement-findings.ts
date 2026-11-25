/**
 * ADR-0337 §5 (lane E18, slice 3) — SaaS entitlement FINDINGS, the pure half: a frozen, versioned rule set in the
 * ADR-0092 discipline (a stated rule, its evidence, a severity CLASS, a limits paragraph; no score, no ranking).
 *
 * The gateway half (`apps/gateway/src/saas-entitlement-findings.ts`) computes every rule at read time over the
 * entitlement graph and the usage the readers observed, and serves each finding with its evidence. Nothing here or
 * there calls a vendor: a finding is a recommendation a person acts on (through the approvals queue, slice 3b), never
 * an automatic revoke.
 *
 * WHY A SIBLING SET, NOT ACCESS_RECOMMENDATION_RULES_V2: ADR-0092's rules judge RegulAIt's own gateway grants and feed
 * a certification campaign that revokes the real grant row. These judge vendor-side grants RegulAIt cannot revoke, so
 * they share the shape and the discipline (and the strict rationale renderer) but not the action path.
 */
import { UNUSED_GRANT_DEFAULT_WINDOW_DAYS, type AccessRecommendationSeverity } from "./access-recommendations.js";

export const SAAS_FINDING_RULES_VERSION = 1;

/** the default look-back for the usage rules; a parameter, not a truth (echoed into every finding) */
export const SAAS_FINDING_DEFAULT_WINDOW_DAYS = UNUSED_GRANT_DEFAULT_WINDOW_DAYS;
export const SAAS_FINDING_WINDOW_DAYS_MIN = 7;
export const SAAS_FINDING_WINDOW_DAYS_MAX = 365;

export const SAAS_FINDING_RULE_IDS = ["unused-grant", "excessive-scope", "oversharing", "publicly-exposed-agent"] as const;
export type SaasFindingRuleId = (typeof SAAS_FINDING_RULE_IDS)[number];

export interface SaasFindingRule {
  id: SaasFindingRuleId;
  title: string;
  severity: AccessRecommendationSeverity;
  /** `{placeholder}` slots filled strictly from each finding's evidence (`renderRecommendationRationale`) */
  rationaleTemplate: string;
  /** what the rule can and cannot see; travels on every payload */
  limits: string;
}

export const SAAS_FINDING_RULES_V1: readonly SaasFindingRule[] = [
  {
    id: "unused-grant",
    title: "vendor-side grants old enough to judge, held by an app with no observed use in the window",
    severity: "review-suggested",
    rationaleTemplate:
      "{app} holds {scope} ({access}) in {source}, first seen {ageDays} days ago, and the {platform} usage read saw " +
      "no use by the app in the last {windowDays} days (last use observed: {lastUse})",
    limits:
      "Use is observed per app, not per scope: an app that uses one scope keeps all of its grants out of this rule. " +
      "Only what the vendor reports is seen (Entra service-principal sign-ins, Google token API events on the editions " +
      "that record them); a platform or tenant with no read-only usage source is reported as not assessable, never as " +
      "unused. A grant first seen less than the window ago is not judged. The window is a parameter, not a truth about need.",
  },
  {
    id: "excessive-scope",
    title: "write, admin or unrecognised scopes held by an app that only read in the window",
    severity: "review-suggested",
    rationaleTemplate:
      "{app} holds {scope} ({access}: {reason}) in {source}, but every API call the {platform} usage read saw from it " +
      "in the last {windowDays} days was a read (last read: {lastRead}; last write observed: {lastWrite})",
    limits:
      "Needs a usage source that tells reads from writes (Google token activity events, whose method names are " +
      "classified by a frozen rule: get, list, search, query, batchGet and export read; anything else counts as a " +
      "write). Entra sign-in activity does not split them, so Microsoft 365 is not assessable here. The split is per " +
      "app, not per scope, and an app with no use at all is the unused-grant rule's, not this one's.",
  },
  {
    id: "oversharing",
    title: "tenant-wide consent to a write, admin or unrecognised scope",
    severity: "review-suggested",
    rationaleTemplate:
      "{app} holds {scope} ({access}: {reason}) for every user of {source} through a tenant-wide consent; its " +
      "publisher is {publisher}",
    limits:
      "Judged from the scope NAME by the frozen V1 classifier; a scope it does not recognise is treated like a write " +
      "(secure by default), which is why every Salesforce connected-app grant appears here while its OAuth scopes are " +
      "not readable. A tenant consent may be exactly what the business intends; the finding asks for a decision, it " +
      "does not say the consent is wrong. User consents are not oversharing by this rule.",
  },
  {
    id: "publicly-exposed-agent",
    title: "agents the platform exposes beyond the tenant",
    severity: "review-suggested",
    rationaleTemplate: "{agent} in {source} is published with {exposure}, so {audience}",
    limits:
      "Read from what the agent registry readers record: Copilot Studio's authentication mode and access-control " +
      "policy. Agentforce, OpenAI and n8n registries do not record publication audience, so they are listed as not " +
      "assessable. Channel-level settings (a website embed, a Teams app published to the store) are not read.",
  },
];
for (const r of SAAS_FINDING_RULES_V1) Object.freeze(r);
Object.freeze(SAAS_FINDING_RULES_V1);

export function saasFindingRuleById(id: string): SaasFindingRule | null {
  return SAAS_FINDING_RULES_V1.find((r) => r.id === id) ?? null;
}

/** a window from a query string: an integer number of days inside the bounds, or the default when absent */
export function parseSaasFindingWindowDays(raw: unknown): number | null {
  if (raw === undefined || raw === "") return SAAS_FINDING_DEFAULT_WINDOW_DAYS;
  if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= SAAS_FINDING_WINDOW_DAYS_MIN && n <= SAAS_FINDING_WINDOW_DAYS_MAX ? n : null;
}

/**
 * Copilot Studio exposure, from the registry reader's recorded attributes. Returns null when the agent is not exposed
 * beyond the tenant by what is recorded (or is not published at all).
 *  - authentication mode `none`: anyone with the link or channel can talk to it, unsigned;
 *  - access-control policy `any_multi_tenant`: signed-in users of ANY Entra tenant may use it.
 */
export function copilotStudioExposure(attrs: Readonly<Record<string, unknown>>): { exposure: string; audience: string } | null {
  if (typeof attrs.publishedOn !== "string" || attrs.publishedOn === "") return null;
  if (attrs.authenticationMode === "none") return { exposure: "no authentication", audience: "anyone who reaches one of its channels can use it without signing in" };
  if (attrs.accessControlPolicy === "any_multi_tenant") return { exposure: "the 'any multi-tenant' access policy", audience: "signed-in users of any Microsoft Entra tenant can use it" };
  return null;
}
