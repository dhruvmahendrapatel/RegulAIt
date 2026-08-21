/**
 * ADR-0092 — ACCESS RECOMMENDATIONS, the pure half (gap L24,
 * docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
 *
 *   THIS FILE                                  the frozen, versioned rule
 *                                              set: id, plain-language
 *                                              rationale template, severity
 *                                              class. Pure data — no db, no
 *                                              clock, no network.
 *   `apps/gateway/src/access-recommendations.ts`  computes every rule at read
 *                                              time over the ledgers the
 *                                              gateway already writes, and
 *                                              serves the results with their
 *                                              evidence.
 *
 * WHAT THIS IS: QUERIES WITH REASONS, NOT INTELLIGENCE. Saviynt ships
 * peer-analytics access recommendations (model-judged "people like you don't
 * use this"). Ours splits honestly: everything here is a DETERMINISTIC rule
 * over ledgers we hold — each recommendation is a stated rule, its concrete
 * evidence attached (ids, counts, dates — enough to verify by hand), and its
 * action routed through machinery that already exists (an ADR-0090
 * certification campaign, or the ordinary revocation endpoints). There are
 * NO scores, NO ranking, NO weights: `severity` is a CLASS (how the finding
 * should be read), never an ordering claim, and the model-judged half of the
 * Saviynt story stays credential-blocked (L6) rather than being approximated
 * by a heuristic dressed up as intelligence.
 *
 * WHY FROZEN AND VERSIONED: a recommendation is only verifiable-by-hand if
 * the rule it cites means the same thing later. `ACCESS_RECOMMENDATION_
 * RULES_V1` is deep-frozen and the shared suite pins its ids and severities
 * — the ADR-0085/0068/0083 frozen-set discipline. A better rule is a NEW
 * VERSION alongside v1, never an in-place edit under results that cited v1.
 *
 * NOTHING EXECUTES: no rule here (or in the gateway half) revokes, notifies,
 * or auto-opens anything. A recommendation becomes an act only when a human
 * opens a campaign or calls a revocation endpoint themselves.
 */

export const ACCESS_RECOMMENDATION_RULES_VERSION = 1;

/** how long "unused" has to have lasted before the rule may say it — a
 * PARAMETER, not a truth: the gateway takes it per request and echoes it into
 * every finding's evidence */
export const UNUSED_GRANT_DEFAULT_WINDOW_DAYS = 90;

/**
 * Severity is a CLASS, not a score: `informational` = worth knowing, no
 * exposure implied (e.g. an already-inert grant that is pure dead weight);
 * `review-suggested` = a human review (a certification campaign or a
 * deliberate revocation) is the suggested next step. There is no ordering,
 * no weighting, and no third value to escalate into.
 */
export const ACCESS_RECOMMENDATION_SEVERITIES = ["informational", "review-suggested"] as const;
export type AccessRecommendationSeverity = (typeof ACCESS_RECOMMENDATION_SEVERITIES)[number];

export const ACCESS_RECOMMENDATION_RULE_IDS = [
  "unused-grant",
  "orphaned-agent-grants",
  "retired-agent-grants",
  "overreach",
  "sod-violation",
  "never-signed-in-holder",
] as const;
export type AccessRecommendationRuleId = (typeof ACCESS_RECOMMENDATION_RULE_IDS)[number];

export interface AccessRecommendationRule {
  id: AccessRecommendationRuleId;
  /** the stated rule, as a plain-language question over the ledgers */
  title: string;
  severity: AccessRecommendationSeverity;
  /**
   * Plain-language rationale with `{placeholder}` slots the gateway fills
   * from each finding's own evidence — the rendered sentence travels WITH
   * the finding, so a reader never has to reconstruct why a row was flagged.
   */
  rationaleTemplate: string;
  /** what the rule can and cannot see — travels on every payload */
  limits: string;
}

/**
 * THE V1 RULE SET. Every rule is computable from ledgers that exist today —
 * verified against the actual tables before each was admitted:
 *
 *  - `unused-grant` reads the pillar-5 usage ledger (`usage_events`), which
 *    every EXECUTED governed call writes unconditionally — model dispatches,
 *    connector invokes and MCP tool calls alike, per user — and which is
 *    never pruned. The ADR-0082 trace ledger is deliberately NOT the source:
 *    tracing attributes tool calls to AGENTS and can be switched off, but
 *    holder-level use is metered regardless, so "tracing off" does NOT make
 *    this rule unassessable. What DOES: a role-bundled grant whose role has
 *    no current assignee has no holder to attribute use to — that surfaces
 *    as `not_assessable`, never as `unused`.
 *  - `orphaned-agent-grants` / `retired-agent-grants` read the ADR-0089
 *    ownership/lifecycle columns.
 *  - `overreach` re-surfaces the ADR-0089 alignment flag with its evidence.
 *  - `sod-violation` re-surfaces the ADR-0091 read-time violators with each
 *    rule's recorded reason.
 *  - `never-signed-in-holder`: the users table itself records no last-login,
 *    so the rule reads what IS recorded — `users.disabled_at`, the
 *    `auth_sessions` ledger (rows are revoked, never deleted), API-key
 *    `last_used_at`, and the usage ledger — and says which signal fired.
 */
export const ACCESS_RECOMMENDATION_RULES_V1: readonly AccessRecommendationRule[] = [
  {
    id: "unused-grant",
    title: "grants old enough to judge, with zero governed use in the window",
    severity: "review-suggested",
    rationaleTemplate:
      "granted {ageDays} days ago and not used once in the last {windowDays} days — no metered " +
      "dispatch or governed call by {holder} touched {object} in the window (last governed use: " +
      "{lastUse})",
    limits:
      "reads the pillar-5 usage ledger: EXECUTED governed calls only. Denied attempts are not " +
      "use, activity that never crossed this gateway is invisible (though it also never " +
      "exercised a gateway grant), and the window is a parameter, not a truth about need. A " +
      "role-bundled grant with no current assignee is not assessable — no holder exists to " +
      "attribute use to — and is reported as such, never as unused.",
  },
  {
    id: "orphaned-agent-grants",
    title: "grants on agents with no accountable owner",
    severity: "review-suggested",
    rationaleTemplate:
      "{object} has {ownershipProblem}, so nobody is accountable for reviewing this grant — " +
      "the ADR-0089 ownership flag is '{flag}'",
    limits:
      "orphan detection sees only this deployment's own user rows (ADR-0089): an owner who " +
      "left but was never deactivated here still reads as owned.",
  },
  {
    id: "retired-agent-grants",
    title: "grants on retired agents (dispatch already refuses; the row is dead weight)",
    severity: "informational",
    rationaleTemplate:
      "{object} was retired {retiredAgo} ({reason}) — dispatch has refused it since (409 " +
      "agent_retired), so this grant row confers nothing and is dead weight in the entitlement " +
      "ledger",
    limits:
      "informational because the exposure is already closed by the ADR-0089 lifecycle gate; " +
      "removing the row is hygiene, not risk reduction.",
  },
  {
    id: "overreach",
    title: "granted agents no approved use case intends",
    severity: "review-suggested",
    rationaleTemplate:
      "{object} is granted to {holders} holder(s) yet named by NO approved use case — the " +
      "ADR-0089 overreach flag: access exists that the use-case register does not stand behind",
    limits:
      "compares grants to APPROVED register intent, never to traffic (ADR-0089's never-blend " +
      "rule): an overreaching agent may be legitimately mid-registration, and the flag is " +
      "deliberately coarse — any grant on an agent no approved use case names.",
  },
  {
    id: "sod-violation",
    title: "identities holding both sides of a declared toxic combination",
    severity: "review-suggested",
    rationaleTemplate:
      "{violator} holds both sides of SoD rule '{ruleName}' ({ruleReason}): {holdsA} and " +
      "{holdsB} — surfaced by ADR-0091's read-time sweep, never auto-revoked",
    limits:
      "re-surfaces ADR-0091's violators verbatim: mint-time enforcement already prevents NEW " +
      "co-holdings; these are pre-existing or IdP-acquired ones, and resolution is a human act.",
  },
  {
    id: "never-signed-in-holder",
    title: "direct grants held by deactivated or never-authenticated users",
    severity: "review-suggested",
    rationaleTemplate: "{holder} {holderProblem} — this direct grant on {object} has no active human behind it",
    limits:
      "the users table records no last-login timestamp, so 'never authenticated' is computed " +
      "from what IS recorded: no auth session was ever minted for the user (session rows are " +
      "revoked, never deleted), no API key of theirs was ever used, and no usage row names " +
      "them. Deactivated holders' grants are already inert at the auth wall (ADR-0022) — " +
      "flagged here because inert standing access is still standing access.",
  },
] as const;

// deep-freeze: the set is data, and data that enforcement cites must not be
// editable at runtime (the ADR-0085 discipline)
for (const rule of ACCESS_RECOMMENDATION_RULES_V1) Object.freeze(rule);
Object.freeze(ACCESS_RECOMMENDATION_RULES_V1);

export function accessRecommendationRuleById(id: string): AccessRecommendationRule | null {
  return ACCESS_RECOMMENDATION_RULES_V1.find((r) => r.id === id) ?? null;
}

/**
 * Render a rule's rationale template against one finding's evidence. STRICT:
 * a placeholder with no value throws — a rationale with a hole in it would
 * ship a sentence that claims less than the rule promised, and the suite
 * would rather fail loudly.
 */
export function renderRecommendationRationale(
  rule: AccessRecommendationRule,
  params: Record<string, string | number>,
): string {
  const out = rule.rationaleTemplate.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => {
    const v = params[key];
    if (v === undefined || v === null) {
      throw new Error(`rationale for '${rule.id}' is missing evidence value '${key}'`);
    }
    return String(v);
  });
  return out;
}

/**
 * Parse the `from_recommendations` campaign-scope value: a comma-separated
 * list of rule ids. Shared so the gateway's campaign feed and any client
 * agree on exactly one encoding. Unknown ids and an empty list are refused —
 * a campaign scoped to a rule that does not exist would silently review
 * nothing.
 */
export function parseRecommendationRuleIds(
  value: string,
): { ok: true; ids: AccessRecommendationRuleId[] } | { ok: false; invalid: string[] } {
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const known = new Set<string>(ACCESS_RECOMMENDATION_RULE_IDS);
  const invalid = tokens.filter((t) => !known.has(t));
  if (tokens.length === 0) return { ok: false, invalid: [] };
  if (invalid.length > 0) return { ok: false, invalid };
  // canonical order (the frozen set's order), deduplicated
  const wanted = new Set(tokens);
  return {
    ok: true,
    ids: ACCESS_RECOMMENDATION_RULE_IDS.filter((id) => wanted.has(id)),
  };
}
