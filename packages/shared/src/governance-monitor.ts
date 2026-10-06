/**
 * ADR-0157 — THE GOVERNANCE MONITOR: rules that turn the standing picture
 * (dependency graph, trust coverage, risk register) into alerts.
 *
 * Pure half: the rule catalogue, the evaluator and the reconciliation of
 * findings against stored alerts. The gateway gathers the inputs from the
 * registers and writes the rows.
 *
 * SCOPE, ON PURPOSE. Use-case rules fire only for APPROVED use cases — the
 * ones in production. A proposal that depends on a halted agent is a review
 * comment; an approved system that does is an incident. Firing on every
 * proposal would bury the second under the first.
 *
 * Every finding names the record it is about and carries the data a reviewer
 * needs to check it (the propagation path, the coverage figures). An alert is
 * a pointer at evidence, never a verdict.
 */
import type { PropagatedRating, RiskBand } from "./dependency-graph.js";
import type { TrustDimension } from "./risks.js";
import { KRI_METRICS, evaluateKri, formatKriValue, type KriComparator, type KriMetric, type KriState } from "./kri.js";
import type { KriOnBreach, SuggestedHaltAction } from "./accountability.js";

/** guardrail detector ids as words for alert titles (`semantic_dlp` → `semantic DLP`) */
const DETECTOR_LABELS: Record<string, string> = {
  semantic_dlp: "semantic DLP",
  pii: "PII",
  prompt_injection: "prompt injection",
  jailbreak: "jailbreak",
  toxicity: "toxicity",
};
export function detectorLabel(detector: string): string {
  return DETECTOR_LABELS[detector] ?? detector.replace(/_/g, " ");
}

export const MONITOR_SEVERITIES = ["low", "medium", "high"] as const;
export type MonitorSeverity = (typeof MONITOR_SEVERITIES)[number];

export const MONITOR_RULES = {
  use_case_inherited_high_risk: {
    label: "Approved use case carries a high rating",
    severity: "high",
    description:
      "An approved use case's propagated rating (ADR-0156) is high — from its own risks or from an agent, " +
      "model or vendor it depends on.",
  },
  use_case_agent_halted: {
    label: "Approved use case depends on a halted or retired agent",
    severity: "high",
    description:
      "An agent the approved use case depends on is halted, disabled, or not in active lifecycle; the " +
      "use case cannot run as approved.",
  },
  use_case_vendor_unapproved: {
    label: "Approved use case depends on an unapproved vendor",
    severity: "medium",
    description:
      "A vendor in the approved use case's dependency chain is not approved (proposed, under assessment, " +
      "rejected or retired).",
  },
  use_case_agent_unowned: {
    label: "Approved use case depends on an unowned agent",
    severity: "medium",
    description: "An agent the approved use case depends on has no accountable owner, or its owner is deactivated.",
  },
  use_case_agent_no_approved_model_card: {
    label: "Agent in production has no approved model card",
    severity: "medium",
    description:
      "An agent the approved use case depends on has no unexpired model-card approval (ADR-0045), so the " +
      "MRM gate would refuse it when enforced.",
  },
  agent_output_leakage: {
    label: "Agent in production returned flagged content",
    severity: "high",
    description:
      "Continuous trace evaluation (ADR-0160) found PII, credential material or toxic content in what an agent " +
      "of an approved use case returned in the evaluation window — content the inline guardrails let through.",
  },
  use_case_served_outside_stack: {
    label: "Approved use case traffic served outside its approved stack",
    severity: "high",
    description:
      "A call made to an agent of an approved use case was dispatched to an agent the use case's approval does " +
      "not name — typically right-size routing (pillar 6) moving it to a cheaper agent. The approval covered the " +
      "stack the reviewers saw; the monitor reports the measured dispatches (usage ledger) and changes no routing.",
  },
  high_risk_without_control: {
    label: "High risk with no mitigating control",
    severity: "high",
    description:
      "A live (open or mitigating) risk rated high has no linked pack control (ADR-0147). Accepted and " +
      "closed risks are excluded: they are decided.",
  },
  served_model_drift: {
    label: "Provider served a different model than configured",
    severity: "medium",
    description:
      "In the window, the model id a provider reported serving (usage ledger, ADR-0175 A4) differs from the agent's " +
      "configured model id, after version-suffix matching: an alias resolving to a dated snapshot of the same model " +
      "does not fire, a different model does. Where an approved model card pins an exact version, any other served id " +
      "fires at high severity, and an open high alert on an agent blocks the deploy gate (ADR-0161) of every use " +
      "case that depends on it until it is acknowledged or resolved: pin only the version you mean to run. A binding may name an expected served model (for an endpoint whose " +
      "configured id is a deployment name); served ids are then compared with it. Rows where the provider reported " +
      "no model are never counted — nothing is guessed.",
  },
  unregistered_ai_traffic: {
    label: "AI traffic no approved use case covers",
    severity: "medium",
    description:
      "In the window, model or MCP spend was attributed to a project that no approved use case links, or to no " +
      "project at all (grouped by virtual key, else by caller). It observes and never blocks. The use-case link is " +
      "the use case's project, the only join between the register and dispatch attribution, so this reports spend " +
      "outside that join — not proof that the traffic is ungoverned.",
  },
  stale_credentials: {
    label: "Credential needs attention",
    severity: "medium",
    description:
      "A stored non-human credential (API key, virtual key, SCIM token, provider key, connector or integration " +
      "secret) carries an inventory flag (ADR-0175 A7): never expires, past expiry, unused for longer than the org's " +
      "threshold, owner deactivated, or over-scoped by its type's rule. One episode per credential type and flag, " +
      "with the count and the first credential ids. Off by default: the flags show on the credential inventory, and " +
      "an admin turns alert episodes on there.",
  },
  kri_threshold_breached: {
    label: "Key risk indicator past its threshold",
    severity: "medium",
    description:
      "A key risk indicator (ADR-0173 batch 2c) measured over its window is past the threshold an admin set: trace " +
      "volume, error rate, p50/p99 latency, cost or annotation feedback, for the fleet, an agent or a project. The " +
      "episode carries the KRI's own severity. Below the KRI's minimum sample count it neither raises nor resolves, " +
      "and deleting or disabling the KRI resolves its episode.",
  },
  dimension_coverage_below_floor: {
    label: "Trust dimension evidence coverage below floor",
    severity: "medium",
    description:
      "A measured trust dimension's evidence coverage (ADR-0148) is below the floor. Unmeasured dimensions " +
      "do not fire — a gap is reported on the dashboard, not as an alert on every install.",
  },
  // --- ADR-0180 (ADR-0175 batch D3): continuous assurance -------------------
  condition_metric_breached: {
    label: "Measured condition breached",
    severity: "high",
    description:
      "A measured approval condition (ADR-0180 A2) on a use case failed its last evaluation: the metric, over its " +
      "window and with at least its minimum samples, is on the wrong side of the threshold. Too few samples " +
      "neither raises nor resolves the episode. A breach reopens review only when the condition says so and two " +
      "consecutive evaluations have breached.",
  },
  required_test_stale: {
    label: "Required AI test missing, stale or failing",
    severity: "high",
    description:
      "A test class the review policy requires for the use case's risk tier (ADR-0180 A3) has no completed run for " +
      "an agent of its stack on the stack's current configuration, or the newest run is older than the freshness " +
      "limit, did not measure the class, or is past its threshold.",
  },
  autonomy_declared_below_observed: {
    label: "Agent autonomy declared below what it does",
    severity: "medium",
    description:
      "A steward declared a builder agent's autonomy class (ADR-0180 A8) lower than the class derived from what " +
      "the agent is set up to do: schedules, sub-agents, write tools without Ask-first, inbound channels and " +
      "computer use.",
  },
  autonomy_floor_unmet: {
    label: "Autonomy control floor not met",
    severity: "high",
    description:
      "The controls an agent's autonomy class requires (ADR-0180 A8) are not all in place for a use case it " +
      "serves. Builder agents count toward a use case through their shared project.",
  },
  residual_above_tolerance: {
    label: "Residual risk above tolerance",
    severity: "high",
    description:
      "A risk's residual band is above the org's tolerance for its category or tier (ADR-0180 A10; by default " +
      "anything above medium) and no valid acceptance covers it.",
  },
  risk_acceptance_expired: {
    label: "Risk acceptance expired",
    severity: "medium",
    description:
      "A time-boxed residual-risk acceptance (ADR-0180 A10) passed its expiry. The risk is reopened and needs a " +
      "new decision.",
  },
  // --- ADR-0182 (ADR-0175 batch D4): accountability records ----------------
  incident_notification_due: {
    label: "Incident notification due",
    severity: "high",
    description:
      "A notification clock on an AI incident (ADR-0182 A12) falls due within 24 hours or is overdue, and the " +
      "notification is not recorded as sent, not required or tolled. The clock is a reminder computed from the " +
      "recorded awareness time and the cited text, not legal advice.",
  },
  incident_action_overdue: {
    label: "Incident action overdue",
    severity: "medium",
    description: "A corrective action on an AI incident (ADR-0182 A12) is still open past its due date.",
  },
  feedback_sla_breached: {
    label: "Feedback past its response time",
    severity: "medium",
    description:
      "A problem report or an appeal on a use case (ADR-0182 A13) was not acknowledged, or not resolved, within " +
      "the org's response times. The use case's owner and the admins are alerted.",
  },
  literacy_coverage_gap: {
    label: "AI policy acknowledgement coverage below 100%",
    severity: "low",
    description:
      "Some of the people a published AI policy or training applies to have not acknowledged its current version, " +
      "or their acknowledgement expired (ADR-0182 A14). Observe only.",
  },
} as const satisfies Record<string, { label: string; severity: MonitorSeverity; description: string }>;
export type MonitorRuleId = keyof typeof MONITOR_RULES;
export const MONITOR_RULE_IDS = Object.keys(MONITOR_RULES) as MonitorRuleId[];

/** default evidence-coverage floor for `dimension_coverage_below_floor` */
export const DEFAULT_COVERAGE_FLOOR_PCT = 50;

export interface MonitorFinding {
  ruleId: MonitorRuleId;
  subjectKey: string;
  severity: MonitorSeverity;
  title: string;
  detail: Record<string, unknown>;
}

export interface MonitorUseCaseInput {
  id: string;
  name: string;
  status: string;
  propagated: PropagatedRating;
  /** transitive dependencies from the graph */
  agentIds: string[];
  vendorIds: string[];
  /** ADR-0164 — dispatches requested for an agent of the approved stack but
   * served by one outside it, per served agent, over the window */
  servedOutsideStack?: OffStackServing[];
}

export interface OffStackServing {
  servedAgentId: string;
  servedAgentName: string;
  /** the approved-stack agents the calls were made to */
  requested: Array<{ agentId: string; name: string; calls: number }>;
  calls: number;
  lastServedAt: string;
  windowDays: number;
}

export interface MonitorAgentInput {
  id: string;
  name: string;
  halted: boolean;
  enabled: boolean;
  lifecycleStatus: string;
  /** "owned" | "unowned" | "orphaned" (ADR-0089) */
  ownership: "owned" | "unowned" | "orphaned";
  modelCardApproved: boolean;
  /** ADR-0160 — trace evaluation over the window, when any ran */
  outputLeaks?: { flagged: number; evaluated: number; byDetector: Record<string, number> } | null;
}

export interface MonitorVendorInput {
  id: string;
  name: string;
  status: string;
}

export interface MonitorRiskInput {
  id: string;
  title: string;
  status: string;
  band: RiskBand;
  controls: number;
}

export interface MonitorDimensionInput {
  key: TrustDimension;
  label: string;
  measured: boolean;
  evidenceCoveragePct: number | null;
  controlsEvidenced: number;
  controlsApplicable: number;
}

/**
 * ADR-0175 A4 — THE SERVED-MODEL MATCHING RULE, stated because it decides what
 * "differs" means.
 *
 * Both ids are compared case-insensitively, trimmed, with any path prefix
 * dropped (`models/x` and `publisher/x` compare as `x`). Each id then splits
 * into a BASE and a trailing VERSION SUFFIX — one or more segments, each a
 * separator (`-`, `@`, `:`, `_`, `.`) followed by:
 *   - a date: `20250101` or `2025-01-01`;
 *   - a 3–4 digit build or snapshot number: `001`, `0613`;
 *   - a `v` version: `v1`, `v2.1`, `v1:0`;
 *   - `latest` (which marks an alias, so it carries no version).
 *
 * The two ids MATCH when their bases are equal and at most one side carries a
 * version, or both carry the same one. So:
 *   `name` ↔ `name-20250101`             match (an alias resolved to its snapshot)
 *   `name-20250101` ↔ `name`             match (a pinned id reported as its alias)
 *   `name-latest` ↔ `name-20250101`      match
 *   `name-20250101` ↔ `name-20250301`    DRIFT (a pinned snapshot was swapped)
 *   `name` ↔ `name-mini-20250101`        DRIFT (a different model)
 * A card's `pinnedModelVersion` skips this rule: only the exact id (case and
 * surrounding whitespace aside) matches it.
 */
const VERSION_SEGMENT = /[-@:_.](?:\d{8}|\d{4}-\d{2}-\d{2}|\d{3,4}|v\d+(?:[.:]\d+)*|latest)$/i;

export function splitModelVersion(id: string): { base: string; version: string | null } {
  let s = id.trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  const segments: string[] = [];
  for (let m = VERSION_SEGMENT.exec(s); m && m.index > 0; m = VERSION_SEGMENT.exec(s)) {
    segments.unshift(m[0].slice(1));
    s = s.slice(0, m.index);
  }
  const version = segments.filter((v) => v !== "latest").join("-");
  return { base: s, version: version || null };
}

export function servedModelMatches(configured: string, served: string): boolean {
  const a = splitModelVersion(configured);
  const b = splitModelVersion(served);
  if (a.base !== b.base) return false;
  return a.version === null || b.version === null || a.version === b.version;
}

export function servedModelMatchesPin(pinned: string, served: string): boolean {
  return pinned.trim().toLowerCase() === served.trim().toLowerCase();
}

/**
 * ADR-0175 review fix — may this exact version be pinned on a model card for a
 * binding whose base is `base` (the binding's expected served model when one
 * is set, else its configured model id)? null = yes, else why not (the 422
 * detail). A pin is an EXACT version, so a floating alias (`latest`, or an id
 * ending in a `latest` segment) is refused, and so is a pin of a different
 * model than the binding is configured for: under `served_model_drift` such a
 * pin would fire at high severity on every call and hold the deploy gate.
 */
export function pinnedVersionProblem(pin: string, base: string | null): string | null {
  const p = pin.trim();
  if (!p) return "a pinned version may not be empty";
  if (/(?:^|[-@:_./])latest$/i.test(p)) {
    return `'${p}' is a floating alias, not a version; pin the exact version the provider reports serving`;
  }
  if (base !== null && base.trim() !== "" && !servedModelMatches(base, p)) {
    return (
      `'${p}' is not a version of the binding's model '${base}' (version-suffix matching); a pin must name the ` +
      `same model the binding is configured for (or its expected served model)`
    );
  }
  return null;
}

/** ADR-0175 A4 — what the ledger says the providers served for one agent */
export interface MonitorServedModelInput {
  agentId: string;
  agentName: string;
  /** ADR-0175 review fix: the binding's optional EXPECTED served model (e.g.
   * the model behind a custom or deployment-named endpoint). When set, served
   * ids are compared with it instead of the configured id. */
  expectedServedModel?: string | null;
  /** the exact versions pinned by the agent's APPROVED, unexpired model
   * cards (two intended uses can be two cards); empty = no pin */
  pinnedModelVersions: string[];
  windowDays: number;
  /** grouped ledger rows that carried a provider-reported model */
  observations: Array<{ configuredModel: string; servedModel: string; calls: number; lastServedAt: string }>;
}

/** ADR-0175 A9 — model/MCP ledger rows in the window, grouped */
export interface MonitorTrafficRow {
  projectId: string | null;
  virtualKeyId: string | null;
  userId: string;
  kind: "model" | "mcp";
  calls: number;
  costUsd: number | null;
  lastAt: string;
}

export interface MonitorTrafficInput {
  windowDays: number;
  rows: MonitorTrafficRow[];
  /** projects at least one APPROVED use case links (the use case's project) */
  coveredProjectIds: ReadonlySet<string>;
  /** use cases that link a project but are not approved — context on the finding */
  linkedNotApproved?: ReadonlyMap<string, Array<{ id: string; name: string; status: string; approvalExpired?: true }>>;
  projectNames?: ReadonlyMap<string, string>;
  virtualKeyNames?: ReadonlyMap<string, string>;
  userNames?: ReadonlyMap<string, string>;
}

export interface MonitorInput {
  useCases: MonitorUseCaseInput[];
  agents: ReadonlyMap<string, MonitorAgentInput>;
  vendors: ReadonlyMap<string, MonitorVendorInput>;
  risks: MonitorRiskInput[];
  dimensions: MonitorDimensionInput[];
  /** node key → label, for readable propagation paths */
  labels?: ReadonlyMap<string, string>;
  coverageFloorPct?: number;
  /** ADR-0175 A4 — per agent; absent = rule not evaluated */
  servedModels?: MonitorServedModelInput[];
  /** ADR-0175 A9 — absent = rule not evaluated */
  traffic?: MonitorTrafficInput;
  /** ADR-0175 A7 — absent = rule not evaluated */
  credentials?: MonitorCredentialInput;
  /** ADR-0173 batch 2c — every KRI with its measurement; absent = rule not evaluated */
  kris?: MonitorKriInput[];
  /** ADR-0180 — the continuous-assurance rules, each fed by its item owner's
   * loader; an absent rule key = that rule not evaluated */
  assurance?: Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>;
  /** ADR-0182 (D4) — the accountability rules, each fed by its slice's
   * loader (same shape as `assurance`); an absent rule key = not evaluated */
  accountability?: Partial<Record<AccountabilityMonitorRuleId, MonitorAssuranceInput>>;
}

/** ADR-0182 (ADR-0175 batch D4) — the four accountability rules. Their
 * evaluation is owned by the slices (A12 incidents, A13 feedback, A14
 * literacy); the monitor turns each reported breach into a finding and
 * reconciles it like any other. */
export const ACCOUNTABILITY_MONITOR_RULE_IDS = [
  "incident_notification_due",
  "incident_action_overdue",
  "feedback_sla_breached",
  "literacy_coverage_gap",
] as const satisfies readonly MonitorRuleId[];
export type AccountabilityMonitorRuleId = (typeof ACCOUNTABILITY_MONITOR_RULE_IDS)[number];

/** ADR-0180 — the six continuous-assurance rules. Their evaluation is owned by
 * the D3 items (the gateway loaders compute the breaches from the ledgers);
 * the monitor turns each breach into a finding and reconciles it like any other. */
export const ASSURANCE_MONITOR_RULE_IDS = [
  "condition_metric_breached",
  "required_test_stale",
  "autonomy_declared_below_observed",
  "autonomy_floor_unmet",
  "residual_above_tolerance",
  "risk_acceptance_expired",
] as const satisfies readonly MonitorRuleId[];
export type AssuranceMonitorRuleId = (typeof ASSURANCE_MONITOR_RULE_IDS)[number];

/** one breached subject of an assurance rule */
export interface MonitorAssuranceSubject {
  /** e.g. `use_case:<id>>condition:<id>`; stable across passes */
  subjectKey: string;
  /** reaches ChatOps channels: names and ids, never free text a person typed */
  title: string;
  /** absent = the rule's catalogue severity */
  severity?: MonitorSeverity;
  detail: Record<string, unknown>;
}

export interface MonitorAssuranceInput {
  breaches: MonitorAssuranceSubject[];
  /** subjects measured with too few samples: an open episode is HELD
   * (neither refreshed nor resolved), as for a KRI below its minimum samples */
  heldSubjectKeys?: string[];
}

/** ADR-0173 batch 2c — one KRI and what the monitor measured for it */
export interface MonitorKriInput {
  id: string;
  name: string;
  metric: KriMetric;
  scope: string;
  scopeId: string | null;
  scopeLabel: string | null;
  windowDays: number;
  comparator: KriComparator;
  threshold: number;
  minSamples: number;
  severity: MonitorSeverity;
  /** false = the KRI is switched off: no finding, and its open episode resolves */
  enabled: boolean;
  value: number | null;
  samples: number;
  /** ADR-0182 S5 (PF-03): `propose_halt` on an agent-scoped KRI makes the
   * breach episode carry a SUGGESTED halt. Absent = `alert`. Owner decision 4:
   * a suggestion only — nothing is filed and nothing halts on its own. */
  onBreach?: KriOnBreach;
}

/**
 * ADR-0182 S5 (PF-03) — the halt a breached KRI SUGGESTS, or null. Only an
 * agent-scoped KRI set to `propose_halt` suggests one (the DB refuses
 * `propose_halt` on any other scope). The suggestion rides on the episode's
 * detail; a person may file it as a proposal, which the normal approvals
 * queue decides (the proposer cannot approve it).
 */
export function suggestedHaltFor(k: Pick<MonitorKriInput, "scope" | "scopeId" | "onBreach">): SuggestedHaltAction | null {
  if (k.onBreach !== "propose_halt" || k.scope !== "agent" || !k.scopeId) return null;
  return { kind: "halt_agent", agentId: k.scopeId };
}

/** the subject key of a KRI's episode */
export function kriSubjectKey(kriId: string): string {
  return `kri:${kriId}`;
}

/** ADR-0173 batch 2c — each KRI's state, for the findings and for the
 * subjects whose open episode must be HELD (neither refreshed nor resolved)
 * because the KRI had too few samples to say anything */
export function kriStates(kris: readonly MonitorKriInput[]): Array<{ kri: MonitorKriInput; state: KriState | "disabled" }> {
  return kris.map((k) => ({ kri: k, state: k.enabled ? evaluateKri(k, { value: k.value, samples: k.samples }) : "disabled" }));
}

/** ADR-0175 A7 — the flagged credentials from the inventory */
export interface MonitorCredentialInput {
  /** false = observe only: the flags stay on the inventory page and no
   * episode is raised (an open one resolves) */
  alerting: boolean;
  credentials: Array<{
    /** `<type>:<row id>` */
    id: string;
    typeLabel: string;
    name: string;
    flags: string[];
    reasons: Record<string, string>;
    manageAt: string;
  }>;
}

const sev = (id: MonitorRuleId): MonitorSeverity => MONITOR_RULES[id].severity;

/** `<type>:<row uuid>` → the uuid's first 8 characters, prefixed "id " — an
 * identifier an admin can find on the inventory, never a typed name */
export function credentialShortId(id: string): string {
  const row = id.slice(id.indexOf(":") + 1);
  return `id ${row.replace(/[^0-9a-f-]/gi, "").slice(0, 8)}`;
}

/** how many credential ids (and names) one stale-credential episode's detail lists */
export const STALE_CREDENTIAL_DETAIL_IDS = 20;

export interface StaleCredentialEpisode {
  /** `credentials:<type>:<flag>` */
  subjectKey: string;
  type: string;
  typeLabel: string;
  flag: string;
  count: number;
  /** the first STALE_CREDENTIAL_DETAIL_IDS, in input order */
  credentials: Array<{ id: string; name: string; reason: string | null }>;
  manageAt: string;
}

/**
 * ADR-0175 A7 review fix — THE ROLL-UP. Flagged credentials grouped by
 * (type, flag): one episode each, carrying the count and the first ids. So
 * turning alerting on raises at most (types × flags) episodes, however many
 * credentials are flagged, and a credential with two flags counts in two. The
 * inventory page uses the same function to say how many would raise now.
 */
export function staleCredentialEpisodes(credentials: MonitorCredentialInput["credentials"]): StaleCredentialEpisode[] {
  const byKey = new Map<string, StaleCredentialEpisode>();
  for (const c of credentials) {
    const type = c.id.slice(0, Math.max(0, c.id.indexOf(":")));
    for (const flag of c.flags) {
      const subjectKey = `credentials:${type}:${flag}`;
      let ep = byKey.get(subjectKey);
      if (!ep) {
        ep = { subjectKey, type, typeLabel: c.typeLabel, flag, count: 0, credentials: [], manageAt: c.manageAt };
        byKey.set(subjectKey, ep);
      }
      ep.count += 1;
      if (ep.credentials.length < STALE_CREDENTIAL_DETAIL_IDS) {
        ep.credentials.push({ id: c.id, name: c.name, reason: c.reasons[flag] ?? null });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.subjectKey.localeCompare(b.subjectKey));
}

export function evaluateMonitorRules(input: MonitorInput): MonitorFinding[] {
  const out: MonitorFinding[] = [];
  const floor = input.coverageFloorPct ?? DEFAULT_COVERAGE_FLOOR_PCT;
  const label = (k: string) => input.labels?.get(k) ?? k;

  for (const uc of input.useCases) {
    if (uc.status !== "approved") continue;
    const subjectKey = `use_case:${uc.id}`;

    if (uc.propagated.band === "high") {
      const inherited = uc.propagated.sourceNodeKey !== null && uc.propagated.sourceNodeKey !== subjectKey;
      out.push({
        ruleId: "use_case_inherited_high_risk",
        subjectKey,
        severity: sev("use_case_inherited_high_risk"),
        title: inherited
          ? `${uc.name} inherits a HIGH rating from ${label(uc.propagated.sourceNodeKey!)}`
          : `${uc.name} carries a HIGH-rated risk of its own`,
        detail: {
          score: uc.propagated.score,
          sourceNodeKey: uc.propagated.sourceNodeKey,
          sourceRiskId: uc.propagated.sourceRiskId,
          path: uc.propagated.path,
          pathLabels: uc.propagated.path.map(label),
        },
      });
    }

    for (const agentId of uc.agentIds) {
      const a = input.agents.get(agentId);
      if (!a) continue;
      const agentKey = `agent:${a.id}`;
      // keyed by the PAIR: the same agent in two use cases is two conditions
      const pairKey = `${subjectKey}>${agentKey}`;
      if (a.halted || !a.enabled || a.lifecycleStatus !== "active") {
        out.push({
          ruleId: "use_case_agent_halted",
          subjectKey: pairKey,
          severity: sev("use_case_agent_halted"),
          title: `${uc.name} depends on ${a.name}, which is ${a.halted ? "halted" : !a.enabled ? "disabled" : a.lifecycleStatus}`,
          detail: { useCaseId: uc.id, agentId: a.id, halted: a.halted, enabled: a.enabled, lifecycleStatus: a.lifecycleStatus },
        });
      }
      if (a.ownership !== "owned") {
        out.push({
          ruleId: "use_case_agent_unowned",
          subjectKey: pairKey,
          severity: sev("use_case_agent_unowned"),
          title: `${uc.name} depends on ${a.name}, which is ${a.ownership}`,
          detail: { useCaseId: uc.id, agentId: a.id, ownership: a.ownership },
        });
      }
      if (a.outputLeaks && a.outputLeaks.flagged > 0) {
        out.push({
          ruleId: "agent_output_leakage",
          subjectKey: pairKey,
          severity: sev("agent_output_leakage"),
          title:
            `${a.name} returned flagged content in ${a.outputLeaks.flagged} of ${a.outputLeaks.evaluated} ` +
            `evaluated ${a.outputLeaks.evaluated === 1 ? "response" : "responses"} ` +
            `(${Object.keys(a.outputLeaks.byDetector).sort().map(detectorLabel).join(", ")})`,
          detail: { useCaseId: uc.id, agentId: a.id, ...a.outputLeaks },
        });
      }
      if (!a.modelCardApproved) {
        out.push({
          ruleId: "use_case_agent_no_approved_model_card",
          subjectKey: pairKey,
          severity: sev("use_case_agent_no_approved_model_card"),
          title: `${a.name} is in production via ${uc.name} without an approved model card`,
          detail: { useCaseId: uc.id, agentId: a.id },
        });
      }
    }

    for (const o of uc.servedOutsideStack ?? []) {
      if (o.calls <= 0) continue;
      out.push({
        ruleId: "use_case_served_outside_stack",
        subjectKey: `${subjectKey}>agent:${o.servedAgentId}`,
        severity: sev("use_case_served_outside_stack"),
        title:
          `${o.calls} ${o.calls === 1 ? "call" : "calls"} for ${uc.name} (to ${o.requested.map((r) => r.name).join(", ")}) ` +
          `${o.calls === 1 ? "was" : "were"} served by ${o.servedAgentName}, which is outside its approved stack`,
        detail: {
          useCaseId: uc.id,
          servedAgentId: o.servedAgentId,
          requested: o.requested,
          calls: o.calls,
          lastServedAt: o.lastServedAt,
          windowDays: o.windowDays,
        },
      });
    }

    for (const vendorId of uc.vendorIds) {
      const v = input.vendors.get(vendorId);
      if (!v || v.status === "approved") continue;
      out.push({
        ruleId: "use_case_vendor_unapproved",
        subjectKey: `${subjectKey}>vendor:${v.id}`,
        severity: sev("use_case_vendor_unapproved"),
        title: `${uc.name} depends on vendor ${v.name}, which is ${v.status.replace(/_/g, " ")}`,
        detail: { useCaseId: uc.id, vendorId: v.id, vendorStatus: v.status },
      });
    }
  }

  for (const sm of input.servedModels ?? []) {
    const pins = [...new Set(sm.pinnedModelVersions.map((p) => p.trim()).filter(Boolean))].sort();
    const drifted = sm.observations
      .filter((o) => o.calls > 0)
      .map((o) => ({
        ...o,
        pinMismatch: pins.length > 0 && !pins.some((p) => servedModelMatchesPin(p, o.servedModel)),
        configMismatch: !servedModelMatches(sm.expectedServedModel?.trim() || o.configuredModel, o.servedModel),
      }))
      .filter((o) => o.pinMismatch || o.configMismatch)
      .sort((a, b) => b.calls - a.calls || a.servedModel.localeCompare(b.servedModel));
    if (drifted.length === 0) continue;
    const calls = drifted.reduce((n, o) => n + o.calls, 0);
    const pinned = drifted.some((o) => o.pinMismatch);
    const servedIds = [...new Set(drifted.map((o) => o.servedModel))];
    const configuredIds = [...new Set(drifted.map((o) => o.configuredModel))];
    out.push({
      ruleId: "served_model_drift",
      subjectKey: `agent:${sm.agentId}`,
      severity: pinned ? "high" : sev("served_model_drift"),
      title:
        `${sm.agentName} was served ${servedIds.join(", ")} ` +
        (pinned
          ? `instead of its model card's pinned ${pins.join(", ")}`
          : sm.expectedServedModel?.trim()
            ? `instead of its expected ${sm.expectedServedModel.trim()}`
            : `instead of its configured ${configuredIds.join(", ")}`) +
        ` on ${calls} ${calls === 1 ? "call" : "calls"}`,
      detail: {
        agentId: sm.agentId,
        pinnedModelVersions: pins,
        expectedServedModel: sm.expectedServedModel?.trim() || null,
        calls,
        windowDays: sm.windowDays,
        lastServedAt: drifted.reduce((m, o) => (o.lastServedAt > m ? o.lastServedAt : m), drifted[0]!.lastServedAt),
        observations: drifted.map((o) => ({
          configuredModel: o.configuredModel,
          servedModel: o.servedModel,
          calls: o.calls,
          lastServedAt: o.lastServedAt,
          reason: o.pinMismatch ? "pinned_version_mismatch" : "configured_model_mismatch",
        })),
      },
    });
  }

  if (input.traffic) out.push(...unregisteredTrafficFindings(input.traffic));

  // ADR-0175 A7 — only when the org turned alerting on: one episode per
  // (credential type, flag), rolled up (review fix), with the count and the
  // first ids. Titles reach ChatOps channels, so they carry the type, flag,
  // count and (for a single credential) a short id — never a credential's
  // name, which is free text its creator typed (review fix); names stay in
  // the admin-only detail.
  if (input.credentials?.alerting) {
    for (const ep of staleCredentialEpisodes(input.credentials.credentials)) {
      const flagWord = ep.flag.replace(/_/g, " ");
      const which = ep.count === 1 ? `${ep.typeLabel} ${credentialShortId(ep.credentials[0]!.id)}` : `${ep.count} credentials of type ${ep.typeLabel}`;
      out.push({
        ruleId: "stale_credentials",
        subjectKey: ep.subjectKey,
        severity: sev("stale_credentials"),
        title: `${which}: ${flagWord}`,
        detail: {
          type: ep.type,
          typeLabel: ep.typeLabel,
          flag: ep.flag,
          count: ep.count,
          credentialIds: ep.credentials.map((c) => c.id),
          credentials: ep.credentials,
          listed: ep.credentials.length,
          manageAt: ep.manageAt,
        },
      });
    }
  }

  for (const { kri: k, state } of kriStates(input.kris ?? [])) {
    if (state !== "breached") continue;
    const scopeWords = k.scope === "fleet" ? "fleet-wide" : `for ${k.scope} ${k.scopeLabel ?? k.scopeId}`;
    out.push({
      ruleId: "kri_threshold_breached",
      subjectKey: kriSubjectKey(k.id),
      severity: k.severity,
      title:
        `${k.name}: ${KRI_METRICS[k.metric].label.toLowerCase()} ${scopeWords} is ${formatKriValue(k.metric, k.value)} ` +
        `over ${k.windowDays} ${k.windowDays === 1 ? "day" : "days"}, ${k.comparator} the threshold of ` +
        `${formatKriValue(k.metric, k.threshold)}`,
      detail: {
        kriId: k.id,
        metric: k.metric,
        scope: k.scope,
        scopeId: k.scopeId,
        windowDays: k.windowDays,
        comparator: k.comparator,
        threshold: k.threshold,
        value: k.value,
        samples: k.samples,
        minSamples: k.minSamples,
        // ADR-0182 S5 (PF-03): a suggestion for a person, never an action taken
        ...(suggestedHaltFor(k) ? { suggestedAction: suggestedHaltFor(k) } : {}),
      },
    });
  }

  // ADR-0180 — the continuous-assurance rules: the item owners' loaders decide
  // what breached; each breach is one finding under its rule.
  for (const ruleId of ASSURANCE_MONITOR_RULE_IDS) {
    for (const b of input.assurance?.[ruleId]?.breaches ?? []) {
      out.push({ ruleId, subjectKey: b.subjectKey, severity: b.severity ?? sev(ruleId), title: b.title, detail: b.detail });
    }
  }
  // ADR-0182 — the accountability rules, the same way: each slice's loader
  // decides what breached.
  for (const ruleId of ACCOUNTABILITY_MONITOR_RULE_IDS) {
    for (const b of input.accountability?.[ruleId]?.breaches ?? []) {
      out.push({ ruleId, subjectKey: b.subjectKey, severity: b.severity ?? sev(ruleId), title: b.title, detail: b.detail });
    }
  }

  for (const r of input.risks) {
    if (r.status !== "open" && r.status !== "mitigating") continue;
    if (r.band !== "high" || r.controls > 0) continue;
    out.push({
      ruleId: "high_risk_without_control",
      subjectKey: `risk:${r.id}`,
      severity: sev("high_risk_without_control"),
      title: `"${r.title}" is rated high and has no mitigating control`,
      detail: { riskId: r.id, status: r.status },
    });
  }

  for (const d of input.dimensions) {
    if (!d.measured || d.evidenceCoveragePct === null || d.evidenceCoveragePct >= floor) continue;
    out.push({
      ruleId: "dimension_coverage_below_floor",
      subjectKey: `dimension:${d.key}`,
      severity: sev("dimension_coverage_below_floor"),
      title: `${d.label} evidence coverage is ${d.evidenceCoveragePct}% (floor ${floor}%)`,
      detail: {
        dimension: d.key,
        evidenceCoveragePct: d.evidenceCoveragePct,
        controlsEvidenced: d.controlsEvidenced,
        controlsApplicable: d.controlsApplicable,
        floorPct: floor,
      },
    });
  }

  // deterministic: one finding per (rule, subject)
  const seen = new Map<string, MonitorFinding>();
  for (const f of out) seen.set(`${f.ruleId}|${f.subjectKey}`, f);
  return [...seen.values()].sort((a, b) =>
    a.ruleId === b.ruleId ? a.subjectKey.localeCompare(b.subjectKey) : a.ruleId.localeCompare(b.ruleId),
  );
}

/**
 * ADR-0175 A9 — one finding per project no approved use case links, per
 * virtual key that spent with no project, and per caller (the ledger's user
 * id: it does not record WHICH of a caller's API keys was used) that spent
 * with neither. A project finding lists the virtual keys and callers behind it.
 */
/** the ledger's null actor (the scheduler and other identity-less jobs) */
const NO_USER_IDENTITY = "00000000-0000-0000-0000-000000000000";

function unregisteredTrafficFindings(t: MonitorTrafficInput): MonitorFinding[] {
  type Kind = "project" | "virtual_key" | "caller";
  interface Acc {
    kind: Kind;
    id: string;
    modelCalls: number;
    mcpCalls: number;
    costUsd: number | null;
    lastAt: string;
    keys: Map<string, number>;
    callers: Map<string, number>;
  }
  const groups = new Map<string, Acc>();
  for (const r of t.rows) {
    if (r.calls <= 0) continue;
    if (r.projectId && t.coveredProjectIds.has(r.projectId)) continue;
    const kind: Kind = r.projectId ? "project" : r.virtualKeyId ? "virtual_key" : "caller";
    const id = r.projectId ?? r.virtualKeyId ?? r.userId;
    const key = `${kind}:${id}`;
    const g: Acc = groups.get(key) ?? {
      kind,
      id,
      modelCalls: 0,
      mcpCalls: 0,
      costUsd: null,
      lastAt: r.lastAt,
      keys: new Map(),
      callers: new Map(),
    };
    if (r.kind === "model") g.modelCalls += r.calls;
    else g.mcpCalls += r.calls;
    if (r.costUsd !== null) g.costUsd = (g.costUsd ?? 0) + r.costUsd;
    if (r.lastAt > g.lastAt) g.lastAt = r.lastAt;
    if (r.virtualKeyId) g.keys.set(r.virtualKeyId, (g.keys.get(r.virtualKeyId) ?? 0) + r.calls);
    g.callers.set(r.userId, (g.callers.get(r.userId) ?? 0) + r.calls);
    groups.set(key, g);
  }
  const nameIn = (m: ReadonlyMap<string, string> | undefined, id: string) => m?.get(id) ?? id;
  const ranked = (m: Map<string, number>, names: ReadonlyMap<string, string> | undefined) =>
    [...m.entries()]
      .map(([id, calls]) => ({ id, name: nameIn(names, id), calls }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  return [...groups.values()].map((g): MonitorFinding => {
    const subjectLabel =
      g.kind === "project"
        ? nameIn(t.projectNames, g.id)
        : g.kind === "virtual_key"
          ? nameIn(t.virtualKeyNames, g.id)
          : nameIn(t.userNames, g.id);
    // a caller's display name or email never goes in the TITLE: titles reach
    // ChatOps channels. The title says "a user (id ...)"; the name stays in
    // the admin-only detail (`subjectLabel`, `callers`).
    const lead =
      g.kind === "project"
        ? `Project ${subjectLabel}`
        : g.kind === "virtual_key"
          ? `Virtual key ${subjectLabel}`
          : g.id === NO_USER_IDENTITY
            ? "Platform traffic (no user identity)"
            : `A user (id ${g.id.slice(0, 8)})`;
    const volume = [
      ...(g.modelCalls ? [`${g.modelCalls} model ${g.modelCalls === 1 ? "call" : "calls"}`] : []),
      ...(g.mcpCalls ? [`${g.mcpCalls} MCP tool ${g.mcpCalls === 1 ? "call" : "calls"}`] : []),
    ].join(" and ");
    const why =
      g.kind === "project"
        ? "no approved use case links this project"
        : g.kind === "virtual_key"
          ? "attributed to no project"
          : "attributed to no project and on no virtual key";
    return {
      ruleId: "unregistered_ai_traffic",
      subjectKey: `${g.kind}:${g.id}`,
      severity: sev("unregistered_ai_traffic"),
      title: `${lead}: ${volume} in ${t.windowDays} days, ${why}`,
      detail: {
        subjectType: g.kind,
        subjectId: g.id,
        subjectLabel,
        modelCalls: g.modelCalls,
        mcpCalls: g.mcpCalls,
        costUsd: g.costUsd === null ? null : Math.round(g.costUsd * 1e6) / 1e6,
        lastAt: g.lastAt,
        windowDays: t.windowDays,
        virtualKeys: ranked(g.keys, t.virtualKeyNames),
        callers: ranked(g.callers, t.userNames),
        linkedUseCasesNotApproved: g.kind === "project" ? (t.linkedNotApproved?.get(g.id) ?? []) : [],
      },
    };
  });
}

export interface ActiveAlertRef {
  id: string;
  ruleId: string;
  subjectKey: string;
}

/**
 * Match findings against the ACTIVE (open/acknowledged) alerts:
 * new condition → raise; persisting → refresh (status untouched, so an
 * acknowledgement survives); cleared → resolve. Only rules in `evaluatedRules`
 * can resolve — an alert from a rule this pass did not run is left alone.
 * ADR-0173 batch 2c: an active alert whose `ruleId|subjectKey` is in `held`
 * is also left alone (a KRI below its minimum samples says nothing either way).
 */
export function reconcileAlerts(
  active: readonly ActiveAlertRef[],
  findings: readonly MonitorFinding[],
  evaluatedRules: ReadonlySet<string> = new Set(MONITOR_RULE_IDS),
  held: ReadonlySet<string> = new Set(),
): { raise: MonitorFinding[]; refresh: Array<{ id: string; finding: MonitorFinding }>; resolve: string[] } {
  const byKey = new Map(active.map((a) => [`${a.ruleId}|${a.subjectKey}`, a]));
  const raise: MonitorFinding[] = [];
  const refresh: Array<{ id: string; finding: MonitorFinding }> = [];
  const still = new Set<string>();
  for (const f of findings) {
    const k = `${f.ruleId}|${f.subjectKey}`;
    const existing = byKey.get(k);
    if (existing) {
      refresh.push({ id: existing.id, finding: f });
      still.add(existing.id);
    } else {
      raise.push(f);
    }
  }
  const resolve = active
    .filter((a) => !still.has(a.id) && evaluatedRules.has(a.ruleId) && !held.has(`${a.ruleId}|${a.subjectKey}`))
    .map((a) => a.id);
  return { raise, refresh, resolve };
}
