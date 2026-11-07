/**
 * I-2 rollout B (#453): mocked gateway answers for the three pages this batch lays out again — First-run setup,
 * Regulatory intelligence and Scheduled jobs. Synthetic names and example hosts only.
 */
import type { Page, Route } from "@playwright/test";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
export const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000b2`;
export const T = "2026-10-20T12:00:00.000Z";
const ME = { userId: U(99), isAdmin: true, user: { id: U(99), email: "ada@example.test", displayName: "Ada Admin" } };

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** a table of `METHOD /path` → body (or a function of the request body); anything else answers `{}` */
export async function mockApi(page: Page, routes: Record<string, unknown>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method: req.method(), path: p + url.search, body });
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    const h = routes[`${req.method()} ${p}`];
    if (h === undefined) return json(route, {});
    const out = typeof h === "function" ? (h as (b: unknown) => unknown)(body) : h;
    if (out && typeof out === "object" && "status" in (out as Json) && "body" in (out as Json)) {
      const o = out as { status: number; body: unknown };
      return json(route, o.body, o.status);
    }
    return json(route, out);
  });
  return calls;
}

// --- First-run setup -------------------------------------------------------

const wizardStep = (key: string, title: string, over: Json = {}) => ({
  key,
  title,
  why: `Why ${title.toLowerCase()} matters.`,
  requires: [],
  status: "pending",
  satisfied: false,
  drift: false,
  evidence: {},
  blockedBy: [],
  completedAt: null,
  ...over,
});
/** the six steps in the gateway's order; the first is done, the third has drifted, the fifth is blocked */
export const WIZARD = {
  steps: [
    wizardStep("connect_idp", "Connect your identity provider", { status: "done", satisfied: true, completedAt: T, evidence: { providers: ["corp-sso"] } }),
    wizardStep("import_users", "Import your directory", { evidence: { users: 1 } }),
    wizardStep("seed_roles", "Seed starter roles", { status: "done", satisfied: false, drift: true, completedAt: T, evidence: { roles: [] } }),
    wizardStep("connect_model_provider", "Connect a model provider", { status: "in_progress", evidence: { note: "Only the mock provider is live." } }),
    wizardStep("compliance_pack", "Apply a compliance pack", { blockedBy: ["connect_model_provider"], evidence: { packsApplied: [] } }),
    wizardStep("first_governed_call", "Make the first governed call", { evidence: { realDispatches: 0 } }),
  ],
  resumeAt: "import_users",
  complete: false,
  doneCount: 2,
  satisfiedCount: 1,
  totalCount: 6,
  packs: [
    { tag: "soc2", label: "SOC 2", summary: "Raises retention and approval floors." },
    { tag: "eu-ai-act", label: "EU AI Act", summary: "Adds the high-risk workflow floors." },
  ],
  starterRoles: [
    { name: "Developer", description: "Builds agents." },
    { name: "Approver", description: "Decides approvals." },
  ],
};
export const FIRST_RUN_ROUTES: Record<string, unknown> = {
  "GET /v1/onboarding": WIZARD,
  "GET /v1/onboarding/imports": { imports: [], includesRefusals: true },
  "GET /v1/roles": { roles: [] },
};

// --- Regulatory intelligence ----------------------------------------------

const impact = (gaps: number) => ({ scopeBasis: "all_live_use_cases", useCases: [], controlsMapped: 2, controlsEvidenced: 2 - gaps, controlGaps: gaps, frameworkGaps: 0 });
const regBase = {
  frameworks: [{ framework: "nist-ai-rmf", packActive: true, activeVersion: 3 }],
  controls: [{ controlRef: "nist-ai-rmf:GOVERN-2.1", title: "Roles and responsibilities", framework: "nist-ai-rmf", status: "satisfied" }],
  verifiedOn: "2026-10-05",
  enforcementDate: null,
  withdrawnOn: null,
  daysUntilEnforcement: null,
};
export const REG_UPDATES = [
  {
    ...regBase,
    key: "withdrawn-circular",
    jurisdiction: "US",
    instrument: "Circular 2022-03",
    instrumentKind: "guidance",
    title: "Circular 2022-03 — Adverse-action notices (withdrawn)",
    summary: "Withdrawn on 12 May 2025.",
    effectiveDate: "2022-05-26",
    withdrawnOn: "2025-05-12",
    status: "withdrawn",
    daysUntilEffective: -1593,
    sourceUrl: "https://example.test/withdrawn",
    impact: impact(1),
  },
  {
    ...regBase,
    key: "city-law-144",
    jurisdiction: "US-NYC",
    instrument: "Local Law 144 of 2021",
    instrumentKind: "law",
    title: "Local Law 144 — Automated employment decision tool bias audits",
    summary: "Took effect on 1 January 2023; enforced from 5 July 2023.",
    effectiveDate: "2023-01-01",
    enforcementDate: "2023-07-05",
    daysUntilEnforcement: -1188,
    status: "in_force",
    daysUntilEffective: -1373,
    sourceUrl: "https://example.test/ll144",
    impact: impact(1),
  },
  {
    ...regBase,
    key: "rmf-1-0",
    jurisdiction: "US",
    instrument: "AI Risk Management Framework 1.0",
    instrumentKind: "voluntary_standard",
    title: "AI RMF 1.0 — Voluntary framework for managing AI risks",
    summary: "Published in January 2023.",
    effectiveDate: "2023-01-26",
    status: "published",
    daysUntilEffective: -1348,
    sourceUrl: "https://example.test/rmf",
    impact: impact(0),
  },
  {
    ...regBase,
    key: "state-sb-189",
    jurisdiction: "US-CO",
    instrument: "SB 26-189",
    instrumentKind: "law",
    title: "SB 26-189 — Automated decision-making technology in consequential decisions",
    summary: "Developer documentation duties start on 1 January 2027.",
    effectiveDate: "2027-01-01",
    status: "upcoming",
    daysUntilEffective: 88,
    sourceUrl: "https://example.test/sb189",
    frameworks: [{ framework: "eu-ai-act", packActive: false, activeVersion: null }],
    impact: { ...impact(1), scopeBasis: "eu_ai_act_tier", useCases: [{ id: U(40), name: "Loan triage", status: "under_review", euAiActTier: "high" }] },
    controls: [{ controlRef: "eu-ai-act:ART-9", title: null, framework: null, status: "not_in_active_pack" }],
  },
];
export const REG_FEED = {
  generatedAt: "2026-10-05T12:00:00.000Z",
  window: { days: 30 },
  summary: { total: 4, inForce: 1, upcoming: 1, proposed: 0, published: 1, withdrawn: 1, withControlGaps: 3, nextEffective: "state-sb-189" },
  updates: REG_UPDATES,
  filter: { status: null, kind: null, framework: null },
  notes: {
    source: "Each entry is curated from the primary source linked on it.",
    evidence: "Satisfied or attested counts as evidenced.",
    scope: "Scope is a prompt for review, not a legal determination.",
    status: "Voluntary standards are published, never in force.",
    applicability: "Whether an entry applies to this organisation has not had legal review.",
    feed: "4 curated entries.",
  },
};
export const REG_ROUTES: Record<string, unknown> = { "GET /v1/regulatory/updates": REG_FEED };

// --- Scheduled jobs --------------------------------------------------------

const run = (id: number, job: string, outcome: string, error: string | null = null) => ({
  id: U(id),
  jobName: job,
  trigger: "schedule",
  instanceId: "gw-1",
  startedAt: T,
  finishedAt: T,
  durationMs: 42,
  outcome,
  itemsProcessed: 3,
  error,
});
const job = (name: string, over: Json = {}) => ({
  name,
  description: `Sweeps ${name.replace(/-/g, " ")}.`,
  adr: null,
  enabled: true,
  intervalSeconds: 3600,
  nextDueAt: T,
  effectiveNextDueAt: T,
  lastRunAt: T,
  lastFinishedAt: T,
  lastOutcome: "ok",
  lastError: null,
  lastItemsProcessed: 3,
  lastDurationMs: 42,
  running: false,
  runs: 4,
  failures: 0,
  consecutiveFailures: 0,
  registered: true,
  recentRuns: [run(name.length * 10 + 1, name, "ok"), run(name.length * 10 + 2, name, "ok")],
  ...over,
});
export const JOBS = [
  job("mrm-expiry"),
  job("approval-sla", {
    lastOutcome: "failed",
    lastError: "database unreachable",
    consecutiveFailures: 2,
    failures: 2,
    recentRuns: [run(301, "approval-sla", "failed", "database unreachable"), run(302, "approval-sla", "failed", "database unreachable")],
  }),
  job("report-generation", { enabled: false, effectiveNextDueAt: null, intervalSeconds: 86400 }),
  job("spend-anomaly", { lastRunAt: null, lastOutcome: null, lastItemsProcessed: null, recentRuns: [] }),
  job("eval-drift", { running: true }),
  job("legacy-sweep", { registered: false, enabled: false, effectiveNextDueAt: null }),
];
export const SCHEDULER = {
  enabled: true,
  posture: "on",
  tickMs: 30000,
  leaseSeconds: 300,
  instanceId: "gw-1",
  jobs: JOBS,
  stuckRuns: [],
  note: "Timeliness, never enforcement.",
};
export const SCHEDULER_ROUTES: Record<string, unknown> = {
  "GET /v1/scheduler": SCHEDULER,
  "GET /v1/health/schedulers": { schedulers: [], healthy: true, note: "in-memory, per-process" },
  "GET /v1/scheduler/jobs/approval-sla/runs": {
    runs: [run(303, "approval-sla", "failed", "database unreachable")],
  },
};
