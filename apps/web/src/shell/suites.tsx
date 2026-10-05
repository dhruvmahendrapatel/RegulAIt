/**
 * The navigation's single source of truth.
 *
 * Two layers, one file:
 *  - WORKSPACE + ADMIN_GROUPS — the ADR-0093 information architecture: every
 *    destination, grouped by the QUESTION a section answers, each entry keeping
 *    the ADR note that justifies its adjacency. Route paths are the API —
 *    bookmarks and the Playwright specs depend on them staying byte-identical.
 *  - SUITES — the ADR-0094 presentation layer over those same groups: each
 *    product suite is a set of 0093 sections, referenced BY NAME so membership
 *    can never be hand-duplicated. The home launcher tiles, the scoped sidebar
 *    and the suite switcher all render from this one array.
 *
 * A section that no suite claims is appended as its own suite at module load
 * (see SUITES below), so adding a group here can never strand its entries.
 */

export interface NavEntry {
  label: string;
  to: string;
  /** other route prefixes that belong to this entry (a detail page living under another path) */
  also?: string[];
}

export const WORKSPACE: NavEntry[] = [
  { label: "Home", to: "/" },
  { label: "Chat", to: "/chat" },
  // ADR-0172: every model a person may use, as a portal — pick, try, copy the code
  { label: "Models", to: "/models" },
  { label: "Runs", to: "/runs" },
  { label: "Workflows", to: "/workflows" },
  { label: "Inbox", to: "/inbox" },
  { label: "Projects", to: "/projects" },
  { label: "Shared context", to: "/context" },
  // pillars 5 + 6 for the person who generates the spend — self-scoped, and
  // the only place a non-admin can see their own cost and savings ledgers
  { label: "Spend & savings", to: "/spend" },
];

/**
 * The native admin surface: grouped real routes inside the shell.
 *
 * ADR-0093 — the console information architecture. The single "Governance"
 * group had absorbed ~26 entries and stopped reading as an organized console,
 * so it is split by the QUESTION a section answers, ordered most-used-first.
 * Grouping and labels only: every route path is unchanged (bookmarks and the
 * Playwright specs depend on them), and each entry keeps the ADR note that
 * justifies its adjacency. ADR-0094 scopes the sidebar to one suite at a
 * time, but the "/" filter still searches every group below.
 */
export const ADMIN_GROUPS: Array<{ group: string; items: NavEntry[] }> = [
  {
    // "where do we stand?" — the read-first, change-nothing surfaces
    group: "Overview",
    items: [
      // ADR-0082 — the one-page BOARD read beside the report machinery it
      // rides: pack coverage, open risks, ASR, spend vs budget, anchoring —
      // every figure computed from the ledgers at load, print-friendly with
      // CSS only, and an empty ledger says "unmeasured", never zero.
      { label: "Posture", to: "/admin/posture" },
      { label: "Trust & evidence", to: "/admin/governance/trust" },
      { label: "Governance alerts", to: "/admin/governance/alerts" },
      // ADR-0173 batch 2c — KRI tiles, thresholds that raise governance alerts, custom dashboards
      { label: "Monitoring", to: "/admin/monitoring" },
      // ADR-0047 — the BOARD-facing read of the same two ledgers the Cost
      // dashboard and the Audit log render operationally. Nothing new is
      // stored: a report is a read-only projection, scoped to the caller's own
      // entitlement, and it says on its face that spend is a list-price
      // estimate and that no scheduler drives its schedules.
      { label: "Reports", to: "/admin/reports" },
      // ADR-0056 — the natural-language front door onto the governance
      // ledgers: a governed tenant reading the governance record with the
      // caller's own entitlements and unable to change anything.
      { label: "Governance copilot", to: "/admin/copilot" },
    ],
  },
  {
    // "what is waiting on a human, and what happened?" — the daily loop
    group: "Approvals & Audit",
    items: [
      { label: "Approvals queue", to: "/admin/approvals" },
      // ADR-0046 — the SAME approvals, scaled: routing, SLA timers, escalation,
      // workload and bulk triage. A layer on the one queue, never a second one.
      { label: "Review workbench", to: "/admin/review-workbench" },
      // ADR-0061 — the Approvals Queue's chat courier. It sits beside the queue
      // it mirrors, because the identity link is a governance trust artifact and
      // not an integration setting.
      { label: "ChatOps approvals", to: "/admin/chatops" },
      { label: "Audit log", to: "/admin/audit" },
      // ADR-0050 — the audit log answers "who did what"; this answers "what
      // flowed into what". Adjacent on purpose: an e-discovery or DPIA question
      // starts in one and finishes in the other, and keeping them apart is what
      // makes both readable.
      { label: "Data lineage", to: "/admin/lineage" },
      // ADR-0070 — the audit log says a decision was taken; the trace says
      // where in the call it landed and what it stopped ("why did nothing
      // happen?" is a governance question, so traces stay beside the log).
      { label: "Traces", to: "/admin/traces" },
    ],
  },
  {
    // "is each USE of AI proposed, owned, risk-accepted?" — the registers
    group: "AI Governance",
    items: [
      // ADR-0080 — the PRE-BUILD gate before every runtime gate: "was this USE
      // of AI proposed, questionnaired, and signed off before anything ran?" —
      // an approved use case carries the same compliance tags the cascade
      // enforces.
      { label: "Use cases", to: "/admin/use-cases", also: ["/admin/governance/use-cases"] },
      { label: "AI intake", to: "/admin/governance/intake" },
      { label: "Review policy", to: "/admin/governance/review-policy" },
      { label: "Dependency graph", to: "/admin/governance/graph" },
      { label: "Regulatory intelligence", to: "/admin/governance/regulatory" },
      // ADR-0045 — the RISK-ACCEPTANCE gate beside the quality gate: "has a
      // human accepted the risk of using this model for this purpose, and is
      // that acceptance still valid?" A high eval score is an input to that
      // decision, never a substitute for it.
      { label: "Model risk", to: "/admin/model-risk" },
      // ADR-0084 — the THIRD-PARTY front door beside the first-party one:
      // use cases govern OUR use of AI; this governs a vendor's AI reaching
      // our data. Everything the vendor supplies is an attestation —
      // labelled, attributed, never blended into computed evidence.
      { label: "Vendors", to: "/admin/vendors" },
      // ADR-0081 — the RISK layer over the measurements: evals, red-team and
      // guardrails MEASURE; the register links each measurement to a named
      // risk scenario, an owner, the mitigating control we actually enforce,
      // and an audited residual-risk acceptance. Evidence is computed live
      // from the same ledgers those pages render — never hand-ticked.
      { label: "Risks", to: "/admin/risks" },
      // ADR-0055 — the land-and-expand wedge: what AI are we NOT governing?
      // A discovered row is a governance gap, not a connection to configure.
      { label: "Shadow-AI discovery", to: "/admin/shadow-ai" },
    ],
  },
  {
    // "who holds what, and should they still?" — the access-review loop
    group: "Access Reviews",
    items: [
      // ADR-0082 — the STANDING dependency view over the per-run records: per
      // agent, who MAY use it (the grant rows) beside what its runs actually
      // DID (usage, traces, orchestration history) — never blended, because an
      // unused permission is exactly the over-permissioning fact to surface.
      { label: "Agent inventory", to: "/admin/inventory" },
      // ADR-0092 — the WORKLIST over the same ledgers the inventory renders:
      // deterministic, versioned rules ("queries with reasons") flag grants
      // worth reviewing, each with hand-checkable evidence, feeding the
      // certification loop below. No scores, nothing auto-executes; the
      // model-judged half stays credential-blocked, not approximated.
      { label: "Access recommendations", to: "/admin/recommendations" },
      // ADR-0090 — the periodic RE-ATTESTATION loop over the grant rows the
      // inventory renders: named reviewers keep/revoke each gateway grant
      // through the one Approvals queue, revoke executes the real removal,
      // and a past-due campaign reads expired-incomplete rather than
      // silently vanishing. Gateway grants only — never a fabric campaign.
      { label: "Certification campaigns", to: "/admin/certification" },
      // ADR-0091 — the PREVENTIVE twin of the certification loop: toxic
      // capability combinations refused at mint time, existing violators
      // surfaced (never auto-revoked), and refused mints escalatable to the
      // one approvals queue for an arm's-length override.
      { label: "SoD rules", to: "/admin/sod" },
    ],
  },
  {
    // "may this call proceed, and under which version of the policy?"
    group: "Policies & Gates",
    items: [
      { label: "Rules engine", to: "/admin/rules" },
      // ADR-0040 — beside the rules engine because it is the same question
      // ("what may this call do?") asked with attributes instead of static
      // grants. It can only ever subtract from what Rules allows.
      { label: "ABAC policies", to: "/admin/abac-policies" },
      // ADR-0042 — the CONTENT gate, beside the destination and attribute
      // gates. Independent controls that happen to share one interception
      // point: what is in the payload vs. where the call may go vs. who may
      // make it under which attributes.
      { label: "Guardrails", to: "/admin/guardrails" },
      // ADR-0173 §3 — the same question asked of the MODEL: which bindings each
      // feature (chat, builder, copilot, …) may call, with a default per feature.
      // It only subtracts from a person's grants, like ABAC beside it.
      { label: "Model policy", to: "/admin/model-policy" },
      // ADR-0048 — the CHANGE-CONTROL layer under the gates. The gates decide
      // whether a call may proceed; this decides which VERSION of the
      // governing artifact it proceeds under, with a canary and a one-click
      // undo.
      { label: "Prompt versions", to: "/admin/prompt-versions" },
      { label: "Simulation", to: "/admin/simulation" },
      { label: "Workflow templates", to: "/admin/workflow-templates" },
    ],
  },
  {
    // "is the agent good, and does it hold under attack?" — measurement
    group: "Quality & Security",
    items: [
      // ADR-0044 — the QUALITY gate: "may this proceed?" asked of the agent's
      // OUTPUT against a fixed dataset, blocking promotion the same way the
      // runtime gates block a call.
      { label: "Evaluations", to: "/admin/evals" },
      // ADR-0057 — the SECURITY gate beside the quality gate: evals ask "is
      // this agent good on our cases?"; this asks "does it hold when someone
      // attacks it?", measured through the live guardrails and blocking
      // promotion through the same automated-check stage.
      { label: "Red-teaming", to: "/admin/redteam" },
      // ADR-0088 — the measuring instrument the operator brings: an
      // admin-typed outbound endpoint under the egress guard (register → test
      // → enable), scoring evals. Beside the evals it scores (ADR-0093);
      // registration rides the same rails as Custom LLM providers.
      { label: "External scorers", to: "/admin/external-scorers" },
    ],
  },
  {
    group: "Identity & Access",
    items: [
      { label: "Users", to: "/admin/users" },
      { label: "Roles", to: "/admin/roles" },
      { label: "Teams", to: "/admin/teams" },
      { label: "Client access", to: "/admin/client-access" },
      // ADR-0066 — sits beside Client access because it answers the adjacent
      // question. That one is "which programmatic client may reach us at all?";
      // this one is "which narrowed credential did we hand a developer INSTEAD
      // of the vendor key?". A virtual key is an entitlement ceiling, not an
      // integration setting, which is why it is here and not under Cost.
      { label: "Virtual keys", to: "/admin/virtual-keys" },
      // ADR-0175 A7 — beside the keys it inventories: every stored non-human
      // credential (keys, tokens, provider and integration secrets) with its
      // owner, age, use and flags, read-only, linking to where each is managed.
      { label: "Credentials", to: "/admin/credentials" },
      { label: "SSO & sessions", to: "/admin/sso" },
      { label: "Provisioning (SCIM)", to: "/admin/provisioning" },
      // ADR-0038: where an IdP group becomes a role — and where the ones that
      // grant nothing are visible rather than silently inert.
      { label: "Group → role mapping", to: "/admin/group-mappings" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { label: "Agents", to: "/admin/agents" },
      { label: "Model credentials", to: "/admin/model-credentials" },
      // ADR-0034 — sits next to Model credentials because it is the same
      // question ("what can our models talk to?") asked about an endpoint we
      // do not own, rather than a vendor we do.
      { label: "Custom LLM providers", to: "/admin/custom-providers" },
      // ADR-0065 — sits directly under Custom LLM providers because it answers
      // the adjacent question. That one is "which model that we do not own may
      // our people reach?"; this one is "which model may our people BUILD, out
      // of what data, and under whose sign-off?".
      { label: "regulAIt-LLM", to: "/admin/regulait-llm" },
      { label: "Connectors", to: "/admin/connectors" },
      { label: "MCP servers", to: "/admin/mcp-servers" },
      // ADR-0175 A6/A5 — flagged builder skills, share requests and the
      // release waiting period, beside the MCP servers they also cover.
      { label: "Admission review", to: "/admin/admission" },
      { label: "Git connections", to: "/admin/git-connections" },
      { label: "PM connections", to: "/admin/pm-connections" },
      { label: "Deploy targets", to: "/admin/deploy-targets" },
      // ADR-0173 batch 2b — signed outbound notifications: what leaves this
      // deployment and to where, under the same egress guard as the endpoints
      // above, with the delivery log as the evidence.
      { label: "Webhooks", to: "/admin/webhooks" },
    ],
  },
  {
    group: "Cost & Optimization",
    items: [
      { label: "Cost dashboard", to: "/admin/cost" },
      // ADR-0069 — directly under the Cost dashboard, because it is the same
      // question asked of money regulAIt never metered: a Copilot seat, a raw
      // vendor key, a cloud AI bill. The two are deliberately adjacent AND
      // deliberately separate: the dashboard reports what we observed, this
      // reports what we were told, and nothing adds them together.
      { label: "Cross-vendor consolidation", to: "/admin/cost-consolidation" },
      // ADR-0049 — budget-vs-FORECAST and spend-anomaly signals over the same
      // measured ledger the Cost dashboard renders as actuals. Next to it
      // because it is the same question asked forward in time rather than
      // backward, and because a forecast that lived somewhere else would
      // inevitably drift from the actuals it extrapolates.
      { label: "Spend forecast & anomalies", to: "/admin/spend-monitor" },
      // ADR-0051 — the same measured ledger again, turned into money. It sits
      // here rather than under Settings because the honest framing is that
      // billing is a READ of the cost data next to it: rate cards and invoices
      // never touch the meter, and a statement that disagreed with the Cost
      // dashboard would be the bug this placement makes obvious.
      { label: "Metering & billing", to: "/admin/billing" },
      { label: "Optimization", to: "/admin/optimization" },
    ],
  },
  {
    group: "Compliance & Infra",
    items: [
      { label: "Compliance profiles", to: "/admin/compliance" },
      // ADR-0058 — framework control mappings evidenced from the same ledgers
      // everything else here reads. It sits directly under Compliance profiles
      // because a pack DRIVES that cascade rather than forking it: one tag, one
      // cascade, one audit trail.
      { label: "Compliance packs", to: "/admin/compliance-packs" },
      { label: "Infrastructure", to: "/admin/infrastructure" },
    ],
  },
  {
    group: "Settings",
    items: [
      { label: "Organization", to: "/admin/organization" },
      // ADR-0052 — the COMMERCIAL ceiling, deliberately beside the org-wide
      // functional ceiling rather than under Cost: a license caps how many
      // entitled users and which tier features exist, which is the same kind of
      // org-level setting as the ones next to it. It is never a cost report.
      { label: "Licensing & seats", to: "/admin/licensing" },
      // ADR-0063 — the deployment's own envelope key: which one this box runs,
      // whether it agrees with the ciphertext in the database, and whether any
      // human has ever said they hold a copy. It sits in Settings rather than
      // under Compliance because it is a property of THIS installation, and it
      // is the one page whose absence of a record is itself the finding.
      { label: "Data key custody", to: "/admin/data-key" },
      // ADR-0064 — the six governance sweeps and whether anything is actually
      // driving them. In Settings for the same reason the data key is: it is a
      // property of THIS installation, and the page whose row of null
      // timestamps is itself the finding.
      { label: "Scheduled jobs", to: "/admin/scheduler" },
      // ADR-0118 — which enforcement gates are actually switched on in THIS
      // install, what each one would start refusing, and the one button that
      // turns them on. Settings rather than Governance because it is a
      // property of this installation and it WRITES; the Governance
      // "Posture" page is the read-only executive one-pager and stays there.
      { label: "Enforcement posture", to: "/admin/enforcement-posture" },
      // ADR-0124 — the emergency stop. Listed immediately after the posture
      // page and before the routine settings: it is the one screen here
      // somebody opens in a hurry, and hunting for it is part of the outage.
      { label: "Execution control", to: "/admin/execution" },
      { label: "First-run setup", to: "/admin/first-run" },
      { label: "Getting started", to: "/admin/setup" },
    ],
  },
];

/* ------------------------------------------------------------------------- *
 * ADR-0094 — the suite layer.
 * ------------------------------------------------------------------------- */

export interface Suite {
  id: string;
  name: string;
  /** one-line tile purpose — the suite's question, not a feature list */
  purpose: string;
  /** admin-only suite: hidden (tile, switcher, filter) from non-admins */
  admin: boolean;
  /** the ADR-0093 sections this suite presents, in order */
  sections: Array<{ group: string; items: NavEntry[] }>;
}

/** The workspace section, minus Home — Home is the launcher itself and renders
 *  as the sidebar's constant affordance, never as a suite entry. */
/**
 * ADR-0172 — the agent builder: a separate suite where people compose governed
 * agents (instructions, tools, sub-agents, skills, memory, schedules, channels)
 * without code. Every agent built here still runs through the gateway as the
 * person using it — their entitlements, budgets and approvals apply.
 */
// labels are unique across every suite: the "/" filter searches them all
export const BUILDER: NavEntry[] = [
  { label: "Agent chat", to: "/builder" },
  { label: "Agent inbox", to: "/builder/inbox" },
  { label: "Your agents", to: "/builder/agents" },
  { label: "Agent templates", to: "/builder/templates" },
  { label: "Apps & tools", to: "/builder/integrations" },
  { label: "Skills", to: "/builder/skills" },
  // ADR-0173 batch 2b — the governed prompt registry (commits, tags, prod
  // promotion through the approvals queue) and the playground that tries a
  // prompt as a governed call and saves it as a commit
  { label: "Prompts", to: "/builder/prompts" },
  { label: "Playground", to: "/builder/playground" },
  { label: "Agent usage", to: "/builder/usage" },
];

const BUILDER_SECTION = { group: "Agent builder", items: BUILDER };

const WORKSPACE_SECTION = {
  group: "Workspace",
  items: WORKSPACE.filter((n) => n.to !== "/"),
};

const groupByName = new Map(ADMIN_GROUPS.map((g) => [g.group, g]));
const claimed = new Set<string>();
const sectionsOf = (...names: string[]) =>
  names.map((name) => {
    const g = groupByName.get(name);
    if (!g) throw new Error(`suite references unknown nav group "${name}"`);
    claimed.add(name);
    return g;
  });

/**
 * One tile per product suite, launcher order. Membership is ADR-0093's
 * judgement referenced by section name — never re-listed here. The one
 * coalescence: Overview's three read-only surfaces (Posture, Reports,
 * Governance copilot) present under the AI Governance suite, because "where
 * do we stand?" is the read side of the same governance question; the
 * Overview section heading survives inside the suite's sidebar.
 */
export const SUITES: Suite[] = [
  {
    id: "workspace",
    name: "Workspace",
    purpose: "Chat, runs, workflows, projects and your own spend.",
    admin: false,
    sections: [WORKSPACE_SECTION],
  },
  {
    id: "agent-builder",
    name: "Agent Builder",
    purpose: "Build governed agents without code — instructions, tools, skills, memory and schedules.",
    admin: false,
    sections: [BUILDER_SECTION],
  },
  {
    id: "ai-governance",
    name: "AI Governance",
    purpose: "Is each use of AI proposed, owned and risk-accepted — and where do we stand?",
    admin: true,
    sections: sectionsOf("Overview", "AI Governance"),
  },
  {
    id: "access-reviews",
    name: "Access Reviews",
    purpose: "Who holds what, and should they still?",
    admin: true,
    sections: sectionsOf("Access Reviews"),
  },
  {
    id: "approvals-audit",
    name: "Approvals & Audit",
    purpose: "What waits on a human, and what happened.",
    admin: true,
    sections: sectionsOf("Approvals & Audit"),
  },
  {
    id: "policies-gates",
    name: "Policies & Gates",
    purpose: "May this call proceed, and under which policy version?",
    admin: true,
    sections: sectionsOf("Policies & Gates"),
  },
  {
    id: "quality-security",
    name: "Quality & Security",
    purpose: "Is the agent good, and does it hold under attack?",
    admin: true,
    sections: sectionsOf("Quality & Security"),
  },
  {
    id: "compliance-infra",
    name: "Compliance & Infra",
    purpose: "Compliance profiles and packs, and this installation's own infrastructure.",
    admin: true,
    sections: sectionsOf("Compliance & Infra"),
  },
  {
    id: "cost-optimization",
    name: "Cost & Optimization",
    purpose: "Per-project spend attribution, forecasts, billing and measured savings.",
    admin: true,
    sections: sectionsOf("Cost & Optimization"),
  },
  {
    id: "identity-access",
    name: "Identity & Access",
    purpose: "Users, roles, teams and the credentials they hold.",
    admin: true,
    sections: sectionsOf("Identity & Access"),
  },
  {
    id: "integrations",
    name: "Integrations",
    purpose: "Agents, models, connectors and the systems they reach.",
    admin: true,
    sections: sectionsOf("Integrations"),
  },
  {
    id: "settings",
    name: "Settings",
    purpose: "Org-wide configuration of this installation.",
    admin: true,
    sections: sectionsOf("Settings"),
  },
];

// Reachability guard: a section no suite claims becomes its own suite rather
// than silently vanishing from every sidebar. This should never fire — it is
// the structural version of "no entry becomes unreachable".
for (const g of ADMIN_GROUPS) {
  if (!claimed.has(g.group)) {
    SUITES.push({
      id: g.group.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: g.group,
      purpose: "",
      admin: true,
      sections: [g],
    });
  }
}

/** The route a suite's tile and the switcher land on: its first entry. */
export function suiteHome(suite: Suite): string {
  return suite.sections[0]!.items[0]!.to;
}

/**
 * Which suite a pathname belongs to — longest-prefix match over every entry,
 * so detail routes (/runs/:id, /projects/:id/context) resolve through their
 * list entry. Routes outside every suite (/, /account) fall back to Workspace.
 */
export function suiteOfPath(pathname: string, isAdmin = true): Suite {
  const path = pathname.replace(/\/+$/, "") || "/";
  let best: { suite: Suite; len: number } | null = null;
  // An admin-only suite is not this person's suite, whatever the URL says: a
  // non-admin who types /admin/users gets the refusal card inside the
  // Workspace navigation, not the whole Identity & access rail beside a card
  // saying it is not in their navigation (UIW-03).
  for (const suite of SUITES.filter((su) => !su.admin || isAdmin)) {
    for (const section of suite.sections) {
      for (const item of section.items) {
        for (const prefix of [item.to, ...(item.also ?? [])]) {
          if (path === prefix || path.startsWith(`${prefix}/`)) {
            if (!best || prefix.length > best.len) best = { suite, len: prefix.length };
          }
        }
      }
    }
  }
  return best?.suite ?? SUITES[0]!;
}

/**
 * Suite tile glyphs — the kit's icon discipline (EmptyState, adminKit):
 * inline SVG, stroke currentColor at 1.6, round caps, fill none, aria-hidden.
 * One glyph per suite id; an unknown id (a fallback suite from the guard
 * above) renders the workspace grid.
 */
export function SuiteGlyph(props: { suiteId: string }) {
  const p = {
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  const path = (() => {
    switch (props.suiteId) {
      case "agent-builder": // a spark over a small agent — compose, then run
        return <path {...p} d="M8 10h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zm2.5 4h.01m3 0h.01M12 10V7m0 0l-1.5-1.5M12 7l1.5-1.5M17.5 4.5v2m-1-1h2" />;
      case "ai-governance": // shield — the governance posture over every call
        return <path {...p} d="M12 4l7 2.6v5.1c0 4.2-2.9 7.1-7 8.3-4.1-1.2-7-4.1-7-8.3V6.6L12 4zm-2.6 8.2l1.9 1.9 3.4-3.6" />;
      case "access-reviews": // rotating review loop
        return <path {...p} d="M6 9a6.5 6.5 0 0 1 11.3-1.6M18 15a6.5 6.5 0 0 1-11.3 1.6M17.5 4v3.5H14M6.5 20v-3.5H10" />;
      case "approvals-audit": // clipboard with a decided check
        return <path {...p} d="M9 5h6M8 5H6.5v15h11V5H16M9.5 12.5l2 2 3.5-3.7" />;
      case "policies-gates": // gate sliders — what may proceed, at which setting
        return <path {...p} d="M5 7h14M5 12h14M5 17h14M9 5v4M15 10v4M7.5 15v4" />;
      case "quality-security": // target — measured, under attack
        return <path {...p} d="M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 2.4v1.2" />;
      case "compliance-infra": // layered stack — the cascade over the platform
        return <path {...p} d="M12 4.5L19 8l-7 3.5L5 8l7-3.5zM5 12l7 3.5L19 12M5 16l7 3.5 7-3.5" />;
      case "cost-optimization": // spend line finding its lower path
        return <path {...p} d="M5 5v14h14M8 14l3-3.5 2.5 2L17 8m0 0h-3.2M17 8v3.2" />;
      case "identity-access": // key — who may, and with which credential
        return <path {...p} d="M10 12a3.5 3.5 0 1 1 3.4 3.5H13l-1.5 1.5H10v1.7l-1.6 1.6H5.5V17l4.6-4.6" />;
      case "integrations": // plug joining two systems
        return <path {...p} d="M9 7v4m6-4v4M7 11h10v2a5 5 0 0 1-5 5 5 5 0 0 1-5-5v-2zm5 7v2" />;
      case "settings": // gear
        return <path {...p} d="M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM12 4.5v2m0 11v2m7.5-7.5h-2m-11 0h-2m11.8-5.3l-1.4 1.4m-7.8 7.8l-1.4 1.4m10.6 0l-1.4-1.4M8.1 8.1L6.7 6.7" />;
      default: // workspace — the working panels
        return <path {...p} d="M5 5h6v6H5V5zm8 0h6v4h-6V5zm0 6h6v8h-6v-8zm-8 2h6v6H5v-6z" />;
    }
  })();
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden>
      {path}
    </svg>
  );
}
