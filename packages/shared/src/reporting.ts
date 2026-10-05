/**
 * ADR-0047 — EXECUTIVE & COMPLIANCE REPORTING, the PURE half.
 *
 * Division of labour, exactly where ADR-0042/0044/0045 drew it:
 *
 *   THIS FILE            the vocabularies, the zod shapes, the PERIOD
 *                        resolution, the ENTITLEMENT decision, the section
 *                        assembly, the compliance-control assessment, and the
 *                        CSV serialisation/round-trip. No db, no clock of its
 *                        own (every function that needs "now" takes it), no
 *                        Fastify.
 *   `apps/gateway/src/reporting.ts`
 *                        the ledger queries, the admin API, the run ledger,
 *                        the export streaming, and the audit rows.
 *
 * THE ONE IDEA WORTH STATING TWICE
 *
 *   `evaluateReportAccess` returns the EXACT set of project ids a generation is
 *   permitted to query, and the gateway builds its WHERE clause FROM that set.
 *   The scoping is therefore applied at QUERY CONSTRUCTION, not as a filter
 *   over already-computed numbers — a post-hoc filter over an aggregate cannot
 *   un-aggregate it, so a cross-team rollup computed first and filtered second
 *   has already leaked by the time the filter runs. That is the central thing
 *   ADR-0047 says the implementation must get right, and it is why this
 *   function returns ids rather than a boolean.
 *
 * WHAT THIS FILE DOES NOT DO
 *
 *   It does not render PDF. ADR-0047 §3 names PDF and flags the rendering
 *   dependency as unresolved; pulling a headless browser into the
 *   security-adjacent gateway is exactly what this repo's supply-chain posture
 *   resists. `renderReportCsv` and the JSON payload are the shipped paths, and
 *   the deviation is recorded in the ADR amendment rather than papered over
 *   with a `format: 'pdf'` that silently emits HTML.
 */
import { stringify } from "csv-stringify/sync";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const REPORT_KINDS = ["exec_summary", "team_scorecard", "compliance"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_SCOPE_KINDS = ["org", "initiative", "team", "project"] as const;
export type ReportScopeKind = (typeof REPORT_SCOPE_KINDS)[number];

export const REPORT_PERIODS = [
  "current_month",
  "last_month",
  "current_quarter",
  "last_quarter",
  "last_30_days",
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_FORMATS = ["csv", "json", "both"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** the reporting GRANT a caller must hold for a definition to produce anything */
export const REPORT_ENTITLEMENT_SCOPES = ["org", "team", "project"] as const;
export type ReportEntitlementScope = (typeof REPORT_ENTITLEMENT_SCOPES)[number];

export const REPORT_SECTIONS = ["spend", "governance", "workflow", "controls"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const REPORT_CADENCES = ["daily", "weekly", "monthly", "quarterly"] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

/**
 * GOVERNANCE_LAYER_SPEC §10.4 — spend is metered against LIST PRICE, not an
 * invoice. A board report that implies billing-grade precision is a lie of
 * omission, so every payload carries this string on its face.
 */
export const REPORT_ESTIMATE_DISCLAIMER =
  "Spend figures are ESTIMATES: measured token volumes priced at published list price " +
  "(GOVERNANCE_LAYER_SPEC §10.4). They are not invoice-reconciled and will not match a provider bill.";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const createReportDefinitionSchema = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(REPORT_KINDS),
    scopeKind: z.enum(REPORT_SCOPE_KINDS).default("org"),
    scopeId: z.string().uuid().nullish(),
    period: z.enum(REPORT_PERIODS).default("current_month"),
    sections: z.array(z.enum(REPORT_SECTIONS)).min(1).nullish(),
    format: z.enum(REPORT_FORMATS).default("json"),
    entitlementScope: z.enum(REPORT_ENTITLEMENT_SCOPES).default("project"),
    description: z.string().max(2000).nullish(),
    /** ADR-0058: the compliance pack whose control mapping the `controls`
     * section is computed from. Absent = ADR-0047's built-in fallback set,
     * which now says in its own note that it is a fallback and not a framework
     * mapping. */
    packId: z.string().uuid().nullish(),
  })
  .strict()
  .refine((d) => (d.scopeKind === "org") === (d.scopeId == null), {
    message: "scopeKind 'org' takes no scopeId; every other scopeKind requires one",
  })
  .refine((d) => d.entitlementScope !== "org" || d.scopeKind === "org", {
    message: "entitlementScope 'org' is only valid on an org-scoped definition",
  });
export type CreateReportDefinition = z.infer<typeof createReportDefinitionSchema>;

export const createReportScheduleSchema = z
  .object({
    cadence: z.enum(REPORT_CADENCES),
    enabled: z.boolean().default(true),
    recipientUserIds: z.array(z.string().uuid()).nullish(),
  })
  .strict();
export type CreateReportSchedule = z.infer<typeof createReportScheduleSchema>;

export const updateReportScheduleSchema = z
  .object({
    cadence: z.enum(REPORT_CADENCES).optional(),
    enabled: z.boolean().optional(),
    recipientUserIds: z.array(z.string().uuid()).nullish(),
  })
  .strict();

export const generateReportSchema = z
  .object({
    /** override the definition's period for a one-off generation */
    period: z.enum(REPORT_PERIODS).optional(),
    format: z.enum(REPORT_FORMATS).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

export interface ResolvedPeriod {
  period: ReportPeriod;
  start: Date;
  end: Date;
  label: string;
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
}

/**
 * Every window is computed in UTC and is half-open `[start, end)`. A report
 * that silently used the server's incidental locale would produce different
 * numbers on two machines from the same ledger, which is the one thing a board
 * report cannot do.
 */
export function resolveReportPeriod(period: ReportPeriod, now: Date): ResolvedPeriod {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (period) {
    case "current_month":
      return { period, start: utc(y, m, 1), end: utc(y, m + 1, 1), label: monthLabel(y, m) };
    case "last_month":
      return { period, start: utc(y, m - 1, 1), end: utc(y, m, 1), label: monthLabel(y, m - 1) };
    case "current_quarter": {
      const q = Math.floor(m / 3);
      return {
        period,
        start: utc(y, q * 3, 1),
        end: utc(y, q * 3 + 3, 1),
        label: `${y}-Q${q + 1}`,
      };
    }
    case "last_quarter": {
      const q = Math.floor(m / 3) - 1;
      const start = utc(y, q * 3, 1);
      return {
        period,
        start,
        end: utc(y, q * 3 + 3, 1),
        label: `${start.getUTCFullYear()}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`,
      };
    }
    case "last_30_days": {
      const end = new Date(now.getTime());
      const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
      return { period, start, end, label: "last 30 days" };
    }
  }
}

function monthLabel(y: number, m: number): string {
  const d = utc(y, m, 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// THE ENTITLEMENT DECISION — the load-bearing part of ADR-0047
// ---------------------------------------------------------------------------

export interface ReportAccessInput {
  isAdmin: boolean;
  userId: string | null;
  definition: {
    kind: ReportKind;
    scopeKind: ReportScopeKind;
    scopeId: string | null;
    entitlementScope: ReportEntitlementScope;
  };
  /** every project id the DEFINITION's scope covers, resolved from the db */
  scopeProjectIds: string[];
  /** every project the CALLER is a member of */
  callerProjectIds: string[];
  /** every team the CALLER belongs to */
  callerTeamIds: string[];
}

export interface ReportAccessDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
  /**
   * The EXACT project ids the generator may query. `null` means "org-wide,
   * including spend attributed to no project" and is only ever produced for an
   * admin under an org-scoped definition. `[]` with `allowed: false` means the
   * caller may query nothing.
   */
  projectIds: string[] | null;
}

/**
 * Never exceeds the caller's own visibility. Three refusals, one narrowing:
 *
 *  - an org-scoped grant is admin-only (a non-admin asking for the whole org's
 *    spend is the leak this ADR is about);
 *  - a team-scoped grant requires membership of the named team;
 *  - a project-scoped grant requires membership of the named project;
 *  - and in EVERY non-admin case the resulting id set is intersected with the
 *    caller's own memberships, so even a correctly-granted team report cannot
 *    reach a project inside that team the caller is not on.
 */
export function evaluateReportAccess(input: ReportAccessInput): ReportAccessDecision {
  const { isAdmin, definition } = input;

  if (isAdmin) {
    // an admin's report is still SCOPED to the definition — admin-ness widens
    // who may run it, never what it covers.
    if (definition.scopeKind === "org") {
      return {
        allowed: true,
        ruleId: "report-access-granted-org",
        reason: "admin caller under an org-scoped definition: org-wide rollup, including unattributed spend",
        projectIds: null,
      };
    }
    return {
      allowed: true,
      ruleId: "report-access-granted-admin-scoped",
      reason: `admin caller under a ${definition.scopeKind}-scoped definition`,
      projectIds: dedupe(input.scopeProjectIds),
    };
  }

  if (!input.userId) {
    return {
      allowed: false,
      ruleId: "report-access-denied-no-identity",
      reason: "an identity-less caller holds no reporting grant",
      projectIds: [],
    };
  }

  if (definition.entitlementScope === "org") {
    return {
      allowed: false,
      ruleId: "report-access-denied-org-scope",
      reason:
        "this definition requires an ORG reporting grant; an org-wide rollup aggregates across teams " +
        "and is refused to a caller who could not see those teams' data directly",
      projectIds: [],
    };
  }

  if (definition.entitlementScope === "team") {
    if (definition.scopeKind !== "team" || !definition.scopeId) {
      return {
        allowed: false,
        ruleId: "report-access-denied-scope-mismatch",
        reason: "a team reporting grant only satisfies a team-scoped definition",
        projectIds: [],
      };
    }
    if (!input.callerTeamIds.includes(definition.scopeId)) {
      return {
        allowed: false,
        ruleId: "report-access-denied-not-team-member",
        reason: "the caller is not a member of the team this report rolls up",
        projectIds: [],
      };
    }
  }

  if (definition.entitlementScope === "project") {
    if (definition.scopeKind === "org") {
      return {
        allowed: false,
        ruleId: "report-access-denied-scope-mismatch",
        reason: "a project reporting grant does not satisfy an org-scoped definition",
        projectIds: [],
      };
    }
    if (definition.scopeKind === "project" && definition.scopeId) {
      if (!input.callerProjectIds.includes(definition.scopeId)) {
        return {
          allowed: false,
          ruleId: "report-access-denied-not-project-member",
          reason: "the caller is not a member of the project this report covers",
          projectIds: [],
        };
      }
    }
  }

  // THE NARROWING. Even a granted team/initiative report is intersected with
  // the caller's own memberships: the grant says which report, membership says
  // which rows.
  const allowedSet = new Set(input.callerProjectIds);
  const projectIds = dedupe(input.scopeProjectIds).filter((p) => allowedSet.has(p));
  if (projectIds.length === 0) {
    return {
      allowed: false,
      ruleId: "report-access-denied-no-visible-projects",
      reason:
        "the caller is a member of none of the projects in this report's scope; " +
        "an empty report is refused rather than served as a zero, so absence is not mistaken for no spend",
      projectIds: [],
    };
  }
  return {
    allowed: true,
    ruleId: "report-access-granted-scoped",
    reason: `scoped to the ${projectIds.length} project(s) in scope the caller is a member of`,
    projectIds,
  };
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

// ---------------------------------------------------------------------------
// Section assembly — pure aggregation over rows the gateway fetched
// ---------------------------------------------------------------------------

export interface SpendLine {
  projectId: string | null;
  projectName: string | null;
  costUsd: number;
  events: number;
  inputTokens: number;
  outputTokens: number;
  budgetUsd: number | null;
}

export interface SpendSection {
  basis: "usage_events";
  estimate: true;
  disclaimer: string;
  totalCostUsd: number;
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalBudgetUsd: number | null;
  budgetVarianceUsd: number | null;
  overBudgetProjects: string[];
  lines: SpendLine[];
}

/** money is rounded ONCE, at the edge, to 6 dp — the same precision the cost
 * dashboard already reports, so the two surfaces cannot disagree by rounding */
export function round6(n: number): number {
  return Number(n.toFixed(6));
}

export function buildSpendSection(lines: SpendLine[]): SpendSection {
  const totalCostUsd = round6(lines.reduce((a, l) => a + l.costUsd, 0));
  const budgeted = lines.filter((l) => l.budgetUsd != null);
  const totalBudgetUsd = budgeted.length > 0 ? round6(budgeted.reduce((a, l) => a + (l.budgetUsd ?? 0), 0)) : null;
  return {
    basis: "usage_events",
    estimate: true,
    disclaimer: REPORT_ESTIMATE_DISCLAIMER,
    totalCostUsd,
    totalEvents: lines.reduce((a, l) => a + l.events, 0),
    totalInputTokens: lines.reduce((a, l) => a + l.inputTokens, 0),
    totalOutputTokens: lines.reduce((a, l) => a + l.outputTokens, 0),
    totalBudgetUsd,
    budgetVarianceUsd: totalBudgetUsd == null ? null : round6(totalBudgetUsd - totalCostUsd),
    overBudgetProjects: lines
      .filter((l) => l.budgetUsd != null && l.costUsd > l.budgetUsd)
      .map((l) => l.projectName ?? l.projectId ?? "(unattributed)"),
    lines: lines.map((l) => ({ ...l, costUsd: round6(l.costUsd) })),
  };
}

export interface GovernanceCount {
  effect: string;
  count: number;
}

export interface GovernanceSection {
  basis: "audit_log";
  totalDecisions: number;
  allow: number;
  deny: number;
  requireApproval: number;
  denyRate: number;
  topDenyRules: Array<{ ruleId: string; count: number }>;
}

export function buildGovernanceSection(
  counts: GovernanceCount[],
  topDenyRules: Array<{ ruleId: string; count: number }>,
): GovernanceSection {
  const pick = (e: string) => counts.find((c) => c.effect === e)?.count ?? 0;
  const allow = pick("allow");
  const deny = pick("deny");
  const requireApproval = pick("require_approval");
  const total = allow + deny + requireApproval;
  return {
    basis: "audit_log",
    totalDecisions: total,
    allow,
    deny,
    requireApproval,
    denyRate: total === 0 ? 0 : round6(deny / total),
    topDenyRules,
  };
}

export interface WorkflowSection {
  basis: "approvals";
  approvalsRequested: number;
  approvalsDecided: number;
  approvalsPending: number;
  approvalsApproved: number;
  approvalsDenied: number;
  medianDecisionMinutes: number | null;
}

export function buildWorkflowSection(input: {
  statuses: Array<{ status: string; count: number }>;
  decisionMinutes: number[];
}): WorkflowSection {
  const pick = (s: string) => input.statuses.find((x) => x.status === s)?.count ?? 0;
  const approved = pick("approved");
  const denied = pick("denied");
  const pending = pick("pending");
  return {
    basis: "approvals",
    approvalsRequested: approved + denied + pending,
    approvalsDecided: approved + denied,
    approvalsPending: pending,
    approvalsApproved: approved,
    approvalsDenied: denied,
    medianDecisionMinutes: median(input.decisionMinutes),
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round6(s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

// ---------------------------------------------------------------------------
// Compliance controls
// ---------------------------------------------------------------------------

/**
 * ADR-0047 §2 is explicit that this ADR does NOT own the control catalogue —
 * ADR-0058's compliance packs define framework → control → evidence-query
 * mappings, and ADR-0058 does not exist yet. What ships here is the RENDERER
 * plus a small built-in evidence set drawn from ledgers that DO exist, so the
 * shape is real and the gap-rendering rule is enforced rather than described.
 * When ADR-0058 lands, its mappings feed this same assessor.
 */
export const BUILT_IN_CONTROLS = [
  {
    id: "audit-trail-present",
    title: "Every governed decision is recorded in an immutable audit trail",
    evidenceKey: "auditRows",
  },
  {
    id: "approval-gate-coverage",
    title: "Sensitive changes route through a human approval gate",
    evidenceKey: "approvalRows",
  },
  {
    id: "model-inventory-signed-off",
    title: "Every dispatchable model carries a current risk sign-off (ADR-0045)",
    evidenceKey: "liveModelCards",
  },
  {
    id: "eval-quality-gate",
    title: "Agent quality is measured against a golden set (ADR-0044)",
    evidenceKey: "evalRuns",
  },
  {
    id: "spend-attribution",
    title: "AI spend is attributed to a cost-bearing project (pillar 5)",
    evidenceKey: "attributedSpendRows",
  },
] as const;

/** ADR-0058 widened this: a pack-sourced control also reports
 * `attestation_required` / `attested` / `unaddressed`, which are deliberately
 * NOT `met` — an organisational control never counts as evidenced. */
export type ControlStatus =
  | "met"
  | "gap"
  | "satisfied"
  | "unsatisfied"
  | "attestation_required"
  | "attested"
  | "unaddressed";

export interface ControlAssessment {
  id: string;
  title: string;
  status: ControlStatus;
  evidenceKey?: string;
  /** null when no collector ran — the attestation-required / unaddressed case */
  evidenceCount: number | null;
  note: string;
}

export interface ComplianceSection {
  framework: string;
  /** ADR-0058: 'pack' when the catalogue came from an activated compliance
   * pack; 'built-in' is the ADR-0047 fallback for a definition naming no pack. */
  catalogueSource: "built-in" | "pack";
  packId?: string;
  packVersion?: number;
  controls: ControlAssessment[];
  met: number;
  gaps: number;
  /** ADR-0058 counts, present only on a pack-sourced section */
  attestationRequired?: number;
  attested?: number;
  unaddressed?: number;
  note: string;
}

/**
 * A control with no evidence renders as an explicit GAP — never a silent pass.
 * That is the rule ADR-0047 §2 states, and it is the only interesting line in
 * this function.
 */
export function assessControls(
  framework: string,
  evidence: Record<string, number>,
): ComplianceSection {
  const controls: ControlAssessment[] = BUILT_IN_CONTROLS.map((c) => {
    const n = evidence[c.evidenceKey] ?? 0;
    return {
      id: c.id,
      title: c.title,
      status: n > 0 ? ("met" as const) : ("gap" as const),
      evidenceKey: c.evidenceKey,
      evidenceCount: n,
      note:
        n > 0
          ? `${n} evidence record(s) found in the reporting period`
          : "NO EVIDENCE in the reporting period — rendered as a gap, not a pass",
    };
  });
  return {
    framework,
    catalogueSource: "built-in",
    controls,
    met: controls.filter((c) => c.status === "met").length,
    gaps: controls.filter((c) => c.status === "gap").length,
    note:
      "FALLBACK CATALOGUE: this definition names no compliance pack, so the built-in evidence set is " +
      "used. It is NOT a framework mapping. ADR-0058's compliance packs own the " +
      "framework→control→evidence mapping — attach one (report_definitions.pack_id) to get a real, " +
      "versioned control mapping. Presence of evidence is NOT an assertion that the control is " +
      "operating effectively, and nothing here is a compliance certification.",
  };
}

// ---------------------------------------------------------------------------
// The report payload + CSV
// ---------------------------------------------------------------------------

export interface ReportPayload {
  kind: ReportKind;
  definitionName: string;
  scope: { kind: ReportScopeKind; id: string | null; projectIds: string[] | null };
  period: { period: ReportPeriod; label: string; start: string; end: string };
  generatedAt: string;
  disclaimer: string;
  spend?: SpendSection;
  governance?: GovernanceSection;
  workflow?: WorkflowSection;
  controls?: ComplianceSection;
}

export interface ReportCsvRow {
  section: string;
  key: string;
  metric: string;
  value: string;
}

const CSV_HEADER = "section,key,metric,value";

/**
 * ONE CSV record (no line terminator), formatted by `csv-stringify` (MIT,
 * pinned; ADR-0176 open source first) rather than a hand-written escaper:
 * RFC 4180 quoting, plus `escape_formulas`, which prefixes a single quote to a
 * cell a spreadsheet would read as a formula (a leading = + - @ tab or CR, and
 * their full-width forms; OWASP "CSV injection"). A JS number is written as a
 * number, so a negative number is not prefixed; a boolean as `true`/`false`; a
 * Date as ISO 8601; an object as JSON; null and undefined as an empty cell.
 *
 * Every CSV export that formats its own rows uses this (the report CSV below,
 * the audit-log export and the annotation-queue export), so there is one
 * answer to "is this cell neutralised".
 */
export function csvRecord(cells: readonly unknown[]): string {
  return stringify([cells as unknown[]], {
    eof: false,
    escape_formulas: true,
    cast: {
      boolean: (v) => String(v),
      date: (v) => v.toISOString(),
      number: (v) => String(v),
      object: (v) => JSON.stringify(v),
    },
  });
}

/** a report value that is a canonical number ("-12.5") goes to the formatter
 * as a number, so the formula guard does not prefix a negative amount */
function reportCell(v: string): string | number {
  if (v !== "" && /^-?[0-9.eE+-]+$/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n) && String(n) === v) return n;
  }
  return v;
}

/** The documented CSV shape: a long-format `section,key,metric,value` table.
 * Long format on purpose — a report's sections have different column sets, and
 * a wide CSV would either lose sections or grow ragged rows. */
export function reportCsvRows(payload: ReportPayload): ReportCsvRow[] {
  const rows: ReportCsvRow[] = [];
  const push = (section: string, key: string, metric: string, value: unknown) =>
    rows.push({ section, key, metric, value: value == null ? "" : String(value) });

  push("meta", "report", "kind", payload.kind);
  push("meta", "report", "definition", payload.definitionName);
  push("meta", "report", "period", payload.period.label);
  push("meta", "report", "period_start", payload.period.start);
  push("meta", "report", "period_end", payload.period.end);
  push("meta", "report", "generated_at", payload.generatedAt);
  push("meta", "report", "basis", "estimate");

  if (payload.spend) {
    push("spend", "total", "cost_usd", payload.spend.totalCostUsd);
    push("spend", "total", "events", payload.spend.totalEvents);
    push("spend", "total", "input_tokens", payload.spend.totalInputTokens);
    push("spend", "total", "output_tokens", payload.spend.totalOutputTokens);
    push("spend", "total", "budget_usd", payload.spend.totalBudgetUsd);
    push("spend", "total", "budget_variance_usd", payload.spend.budgetVarianceUsd);
    for (const l of payload.spend.lines) {
      const key = l.projectId ?? "(unattributed)";
      push("spend", key, "project_name", l.projectName ?? "");
      push("spend", key, "cost_usd", l.costUsd);
      push("spend", key, "events", l.events);
      push("spend", key, "budget_usd", l.budgetUsd);
    }
  }
  if (payload.governance) {
    push("governance", "total", "decisions", payload.governance.totalDecisions);
    push("governance", "total", "allow", payload.governance.allow);
    push("governance", "total", "deny", payload.governance.deny);
    push("governance", "total", "require_approval", payload.governance.requireApproval);
    push("governance", "total", "deny_rate", payload.governance.denyRate);
    for (const r of payload.governance.topDenyRules) push("governance", r.ruleId, "deny_count", r.count);
  }
  if (payload.workflow) {
    push("workflow", "approvals", "requested", payload.workflow.approvalsRequested);
    push("workflow", "approvals", "decided", payload.workflow.approvalsDecided);
    push("workflow", "approvals", "pending", payload.workflow.approvalsPending);
    push("workflow", "approvals", "approved", payload.workflow.approvalsApproved);
    push("workflow", "approvals", "denied", payload.workflow.approvalsDenied);
    push("workflow", "approvals", "median_decision_minutes", payload.workflow.medianDecisionMinutes);
  }
  if (payload.controls) {
    push("controls", "summary", "framework", payload.controls.framework);
    push("controls", "summary", "met", payload.controls.met);
    push("controls", "summary", "gaps", payload.controls.gaps);
    for (const c of payload.controls.controls) {
      push("controls", c.id, "status", c.status);
      push("controls", c.id, "evidence_count", c.evidenceCount);
    }
  }
  return rows;
}

export function renderReportCsv(payload: ReportPayload): string {
  const rows = reportCsvRows(payload);
  return (
    [CSV_HEADER, ...rows.map((r) => csvRecord([r.section, r.key, r.metric, reportCell(r.value)]))].join(
      "\r\n",
    ) + "\r\n"
  );
}

/** the round-trip half — a compliance export nobody can parse is not an export */
export function parseReportCsv(csv: string): ReportCsvRow[] {
  const cells = parseCsvCells(csv);
  if (cells.length === 0) return [];
  const header = cells[0]!;
  if (header.join(",") !== CSV_HEADER) {
    throw new Error(`unexpected report CSV header: ${header.join(",")}`);
  }
  return cells
    .slice(1)
    .filter((r) => r.length === 4)
    .map((r) => ({ section: r[0]!, key: r[1]!, metric: r[2]!, value: r[3]! }));
}

function parseCsvCells(csv: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  let i = 0;
  while (i < csv.length) {
    const c = csv[i]!;
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    out.push(row);
  }
  return out;
}

/** which sections a kind computes when a definition names none */
export function defaultSectionsFor(kind: ReportKind): ReportSection[] {
  switch (kind) {
    case "exec_summary":
      return ["spend", "governance", "workflow"];
    case "team_scorecard":
      return ["spend", "governance", "workflow"];
    case "compliance":
      return ["controls", "governance"];
  }
}

/**
 * Cadence → whether a schedule is DUE. Pure so the sweep endpoint has no clock
 * of its own and a test can prove the boundary. A never-generated schedule is
 * always due — the first run must not wait a full cadence.
 */
export function scheduleIsDue(
  cadence: ReportCadence,
  lastGeneratedAt: Date | null,
  now: Date,
): boolean {
  if (!lastGeneratedAt) return true;
  const elapsedMs = now.getTime() - lastGeneratedAt.getTime();
  const day = 24 * 3600 * 1000;
  switch (cadence) {
    case "daily":
      return elapsedMs >= day;
    case "weekly":
      return elapsedMs >= 7 * day;
    case "monthly":
      return elapsedMs >= 28 * day;
    case "quarterly":
      return elapsedMs >= 90 * day;
  }
}
