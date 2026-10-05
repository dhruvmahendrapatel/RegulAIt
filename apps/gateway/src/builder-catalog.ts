/**
 * ADR-0172 — the agent builder's shipped content: starter templates and the
 * integrations catalog. Both are code, not rows: they version with the
 * release, need no seeding, and an air-gapped install has them on first boot.
 *
 * Every text below is original and governance-flavoured. The `integrations`
 * and catalog `key` values are logo keys (file names under the web app's
 * vendored logo set); a key without a logo falls back to a monogram there.
 */
import type { BuilderCadenceValue } from "@regulait/shared";

export interface BuilderTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  integrations: string[];
  instructions: string;
  skills: Array<{ name: string; description: string; body: string }>;
  subagents: Array<{ name: string; description: string }>;
  schedules: Array<{ name: string; cadence: BuilderCadenceValue; timeUtc: string; prompt: string }>;
  steps: string[];
}

const GROUNDING = [
  "## Ground rules",
  "- You act with the permissions of the person you are working for, never more.",
  "- Say plainly when you do not know, and never invent a policy, a control or a figure.",
  "- Tools listed in your toolbox are described for planning only in this release; ask the person to run any action.",
].join("\n");

export const BUILDER_TEMPLATES: readonly BuilderTemplate[] = [
  {
    id: "ai-intake-reviewer",
    name: "AI intake reviewer",
    tagline: "Checks new AI use-case proposals for gaps before a reviewer sees them",
    description:
      "Reads a proposed AI use case, checks the intake answers for gaps and contradictions, suggests a " +
      "provisional risk tier with its reasons, and drafts the follow-up questions a reviewer would ask.",
    category: "Intake",
    integrations: ["jira", "confluence", "slack"],
    instructions: [
      "# AI intake reviewer",
      "",
      "You help the governance team triage proposed AI use cases before a human reviewer signs off.",
      "",
      "## For every proposal",
      "1. Summarise the use case in three sentences: purpose, affected people, and the decision it supports.",
      "2. List every intake answer that is missing, vague or contradicts another answer.",
      "3. Suggest a provisional risk tier and the answers that drive it. Label it a suggestion.",
      "4. Draft at most five follow-up questions, most important first.",
      "",
      GROUNDING,
    ].join("\n"),
    skills: [
      {
        name: "Intake completeness check",
        description: "A checklist of what a complete AI use-case proposal states.",
        body: [
          "# Intake completeness check",
          "A complete proposal states: the business owner, the purpose, who is affected, what data is used",
          "(and whether it includes personal data), whether a person reviews each outcome, the vendor or",
          "model involved, and how the outcome can be challenged. Flag each item that is absent.",
        ].join("\n"),
      },
      {
        name: "Risk tier screening",
        description: "How to reason about a provisional risk tier from intake answers.",
        body: [
          "# Risk tier screening",
          "Higher tiers follow from: decisions about access to essential services, employment or education;",
          "biometric identification; safety components; and fully automated outcomes with no human review.",
          "Always show which answers moved the tier, and call the result provisional.",
        ].join("\n"),
      },
    ],
    subagents: [{ name: "Evidence finder", description: "Finds prior decisions and policies that relate to the proposal." }],
    schedules: [
      {
        name: "Morning intake digest",
        cadence: "weekdays",
        timeUtc: "08:00",
        prompt: "List the AI use-case proposals that arrived since yesterday and the gaps you would ask about first.",
      },
    ],
    steps: [
      "Summarises each proposed use case in plain language",
      "Flags missing or contradictory intake answers",
      "Suggests a provisional risk tier with its reasons",
      "Drafts the follow-up questions for the reviewer",
    ],
  },
  {
    id: "vendor-ai-risk-assessor",
    name: "Vendor AI risk assessor",
    tagline: "Turns a vendor's questionnaire and terms into a first-pass risk view",
    description:
      "Reviews a third-party AI vendor's security questionnaire, model documentation and data terms, and " +
      "produces a first-pass assessment with open questions and the controls it would expect.",
    category: "Third-party risk",
    integrations: ["gdrive", "notion", "salesforce"],
    instructions: [
      "# Vendor AI risk assessor",
      "",
      "You prepare a first-pass assessment of an AI vendor for the third-party risk team.",
      "",
      "## Produce",
      "- What the vendor's AI does, and which of our data it would see.",
      "- Training and retention terms: is our data used to train their models, and for how long is it kept?",
      "- Sub-processors and hosting regions named in the documents.",
      "- Gaps: questions the documents do not answer.",
      "- Expected controls, each marked evidenced / claimed / missing.",
      "",
      GROUNDING,
    ].join("\n"),
    skills: [
      {
        name: "Data terms review",
        description: "What to look for in an AI vendor's data processing terms.",
        body: [
          "# Data terms review",
          "Check: use of customer data for training (default on or off, and how to opt out), retention",
          "period, deletion on request, sub-processor list and change notice, hosting regions, and breach",
          "notification time. Quote the clause for every finding.",
        ].join("\n"),
      },
    ],
    subagents: [{ name: "Contract reader", description: "Extracts clauses on data use, retention and liability." }],
    schedules: [
      {
        name: "Reassessment reminders",
        cadence: "weekly",
        timeUtc: "09:00",
        prompt: "List vendors whose assessment is older than twelve months and what changed in their terms since.",
      },
    ],
    steps: [
      "Reads the vendor's questionnaire, model documentation and terms",
      "Summarises data use, retention and hosting",
      "Marks each expected control as evidenced, claimed or missing",
      "Lists the questions to send back to the vendor",
    ],
  },
  {
    id: "policy-qa-assistant",
    name: "Policy Q&A assistant",
    tagline: "Answers questions about your AI policies, with the clause it relied on",
    description:
      "Answers staff questions about the organisation's AI acceptable-use and governance policies, always " +
      "citing the section it used, and hands off to a person when the policy is silent.",
    category: "Knowledge",
    integrations: ["confluence", "notion", "teams"],
    instructions: [
      "# Policy Q&A assistant",
      "",
      "You answer questions about the organisation's AI policies.",
      "",
      "- Quote or cite the policy section behind every answer.",
      "- If the policy does not cover the question, say so and suggest who to ask.",
      "- Never grant an exception; explain how to request one.",
      "",
      GROUNDING,
    ].join("\n"),
    skills: [
      {
        name: "Cite the source",
        description: "Every answer names the policy and section it relied on.",
        body: "# Cite the source\nEnd each answer with `Source: <policy name>, section <n>`. No source, no answer.",
      },
      {
        name: "Escalate when unsure",
        description: "When and how to hand a question to a person.",
        body: [
          "# Escalate when unsure",
          "Escalate when the policy is silent, when two sections conflict, or when the person asks for an",
          "exception. Say who owns the policy and what to include in the request.",
        ].join("\n"),
      },
    ],
    subagents: [],
    schedules: [],
    steps: [
      "Answers questions about AI acceptable use and governance policy",
      "Cites the policy section behind each answer",
      "Says so when the policy is silent and names who to ask",
    ],
  },
  {
    id: "evidence-collector",
    name: "Evidence collector",
    tagline: "Gathers control evidence on a schedule and lists what is missing",
    description:
      "Collects the evidence your AI controls need — change records, review sign-offs, test results — and " +
      "prepares a weekly list of what was found and what is still missing, ready for an auditor.",
    category: "Compliance",
    integrations: ["github", "jira", "gdrive", "aws"],
    instructions: [
      "# Evidence collector",
      "",
      "You prepare control evidence for AI systems.",
      "",
      "For each control: state what evidence would satisfy it, what you found (with a link or reference),",
      "and what is missing. Keep a neutral tone; an auditor will read this.",
      "",
      GROUNDING,
    ].join("\n"),
    skills: [
      {
        name: "Control evidence checklist",
        description: "The evidence each common AI control expects.",
        body: [
          "# Control evidence checklist",
          "- Change management: a linked change record and an approval before release.",
          "- Model evaluation: a dated test report with the metrics and thresholds used.",
          "- Access review: the reviewer, the date and the decisions made.",
          "- Incident response: the timeline, the owner and the closure note.",
        ].join("\n"),
      },
    ],
    subagents: [{ name: "Change log reader", description: "Summarises merged changes and their approvals for the period." }],
    schedules: [
      {
        name: "Weekly evidence sweep",
        cadence: "weekly",
        timeUtc: "07:30",
        prompt: "Collect this week's evidence for each AI control and list anything still missing.",
      },
    ],
    steps: [
      "Lists the evidence each control expects",
      "Finds change records, reviews and test reports for the period",
      "Prepares a found / missing summary for the auditor",
    ],
  },
  {
    id: "incident-triage",
    name: "AI incident triage",
    tagline: "Sorts reported AI incidents by severity and drafts the first response",
    description:
      "Reads reports of harmful or unexpected AI behaviour, rates severity against a rubric, groups duplicates, " +
      "and drafts the first internal update and the next steps for the incident owner.",
    category: "Operations",
    integrations: ["pagerduty", "slack", "jira", "datadog"],
    instructions: [
      "# AI incident triage",
      "",
      "You help the on-call owner triage AI incidents.",
      "",
      "1. Restate what happened, who was affected and when.",
      "2. Rate severity with the rubric skill and explain the rating.",
      "3. Group the report with any open incident that describes the same behaviour.",
      "4. Draft a short internal update and the next three steps.",
      "",
      GROUNDING,
    ].join("\n"),
    skills: [
      {
        name: "Incident severity rubric",
        description: "How to rate an AI incident from low to critical.",
        body: [
          "# Incident severity rubric",
          "Critical: harm to people or unlawful outcome, ongoing. High: personal data exposed or a wrong",
          "decision affecting customers. Medium: misleading output caught before use. Low: quality issue.",
        ].join("\n"),
      },
      {
        name: "Incident timeline",
        description: "Build a timeline from the report and its follow-ups.",
        body: "# Incident timeline\nList events oldest first as `time — what happened — source`. Mark guesses as unconfirmed.",
      },
    ],
    subagents: [{ name: "Log summariser", description: "Summarises the traces and logs attached to an incident." }],
    schedules: [
      {
        name: "Open incident check",
        cadence: "hourly",
        timeUtc: "00:15",
        prompt: "List open AI incidents without an owner or without an update in the last four hours.",
      },
    ],
    steps: [
      "Restates each report: what happened, who, and when",
      "Rates severity against a written rubric",
      "Groups duplicates with open incidents",
      "Drafts the first internal update and next steps",
    ],
  },
  {
    id: "weekly-governance-brief",
    name: "Weekly governance brief",
    tagline: "A Monday summary of AI approvals, risks, spend and open actions",
    description:
      "Writes a short weekly brief for leadership: use cases approved or sent back, new or rising risks, " +
      "AI spend against budget, overdue reviews, and the decisions needed this week.",
    category: "Reporting",
    integrations: ["slack", "gmail", "jira"],
    instructions: [
      "# Weekly governance brief",
      "",
      "You write a one-page weekly brief on AI governance for leadership.",
      "",
      "Sections, in order: Decisions needed · Approvals and send-backs · Risks · Spend · Overdue reviews.",
      "Use numbers where you have them and say where you do not. Keep it under 300 words.",
      "",
      GROUNDING,
    ].join("\n"),
    skills: [
      {
        name: "Brief writing style",
        description: "Short, factual, decision-first writing for leadership.",
        body: "# Brief writing style\nLead with the decision needed. One idea per bullet. No adjectives without a number behind them.",
      },
    ],
    subagents: [{ name: "Metrics gatherer", description: "Pulls the week's approval, risk and spend figures." }],
    schedules: [
      {
        name: "Monday brief",
        cadence: "weekly",
        timeUtc: "07:00",
        prompt: "Write this week's governance brief.",
      },
    ],
    steps: [
      "Collects the week's approvals, risks, spend and overdue reviews",
      "Leads with the decisions leadership needs to make",
      "Keeps the brief to one page",
    ],
  },
  {
    id: "access-review-helper",
    name: "Access review helper",
    tagline: "Prepares AI tool access reviews so managers can decide quickly",
    description:
      "Prepares a periodic review of who can use which AI models and tools, highlights unused or unusual " +
      "access, and drafts the reviewer's recommendations for a manager to confirm.",
    category: "Access",
    integrations: ["okta", "slack"],
    instructions: [
      "# Access review helper",
      "",
      "You prepare access reviews for AI models and tools.",
      "",
      "- Group access by person and by tool.",
      "- Flag access unused for 90 days, access that exceeds the person's role, and any shared accounts.",
      "- Recommend keep / reduce / remove for each flag, and leave the decision to the manager.",
      "",
      GROUNDING,
    ].join("\n"),
    skills: [
      {
        name: "Least privilege",
        description: "How to judge whether access matches a role.",
        body: "# Least privilege\nAccess should match the tasks of the role today. Unused or inherited access is a candidate to remove.",
      },
    ],
    subagents: [],
    schedules: [
      {
        name: "Quarterly review prep",
        cadence: "weekly",
        timeUtc: "06:00",
        prompt: "Prepare the access review list for any team whose review is due in the next two weeks.",
      },
    ],
    steps: [
      "Groups AI model and tool access by person and tool",
      "Flags unused or excessive access",
      "Drafts keep / reduce / remove recommendations for the manager",
    ],
  },
];

export function findTemplate(id: string): BuilderTemplate | undefined {
  return BUILDER_TEMPLATES.find((t) => t.id === id);
}

export type IntegrationCategory = "productivity" | "developer" | "communication" | "data" | "security" | "ai";
export type IntegrationKind = "connector" | "mcp" | "chatops";

export interface CatalogItem {
  key: string;
  name: string;
  description: string;
  category: IntegrationCategory;
  kind: IntegrationKind;
  /** lowercase tokens matched against connector kind/providerKind/name, MCP
   * server names, or (chatops) the ChatOps provider */
  match: string[];
}

const C = (
  key: string,
  name: string,
  description: string,
  category: IntegrationCategory,
  kind: IntegrationKind = "connector",
  match: string[] = [key],
): CatalogItem => ({ key, name, description, category, kind, match });

export const BUILDER_INTEGRATION_GROUPS: ReadonlyArray<{ name: string; items: CatalogItem[] }> = [
  {
    name: "Google",
    items: [
      C("gmail", "Gmail", "Read and draft email on the user's behalf.", "productivity", "connector", ["gmail"]),
      C("gdrive", "Google Drive", "Find and read documents and spreadsheets.", "productivity", "connector", ["gdrive", "google-drive", "drive"]),
      C("gcalendar", "Google Calendar", "Check availability and schedule meetings.", "productivity", "connector", ["gcalendar", "calendar"]),
    ],
  },
  {
    name: "Microsoft",
    items: [
      C("teams", "Microsoft Teams", "Post updates and approvals to Teams channels.", "communication", "chatops", ["teams"]),
      C("microsoft", "Outlook mail", "Send governed email notifications.", "communication", "chatops", ["outlook"]),
      C("onedrive", "OneDrive", "Find and read files.", "productivity", "connector", ["onedrive", "sharepoint"]),
    ],
  },
  {
    name: "Slack",
    items: [C("slack", "Slack", "Post updates and approval requests to channels.", "communication", "chatops", ["slack"])],
  },
  {
    name: "Atlassian",
    items: [
      C("jira", "Jira", "Read and update work items.", "developer", "connector", ["jira"]),
      C("confluence", "Confluence", "Search and read pages.", "productivity", "connector", ["confluence", "wiki"]),
      C("trello", "Trello", "Read and move cards.", "productivity"),
    ],
  },
  {
    name: "Code and delivery",
    items: [
      C("github", "GitHub", "Read repositories, issues and pull requests.", "developer", "connector", ["github"]),
      C("gitlab", "GitLab", "Read projects, issues and merge requests.", "developer"),
      C("bitbucket", "Bitbucket", "Read repositories and pull requests.", "developer"),
      C("linear", "Linear", "Read and update issues.", "developer"),
      C("sentry", "Sentry", "Read error reports.", "developer"),
    ],
  },
  {
    name: "Work management",
    items: [
      C("notion", "Notion", "Search and read workspace pages.", "productivity"),
      C("asana", "Asana", "Read and update tasks.", "productivity"),
      C("monday", "monday.com", "Read and update boards.", "productivity"),
      C("airtable", "Airtable", "Read and update bases.", "data"),
    ],
  },
  {
    name: "Customer systems",
    items: [
      C("salesforce", "Salesforce", "Read accounts, cases and opportunities.", "productivity", "connector", ["salesforce", "crm"]),
      C("hubspot", "HubSpot", "Read contacts and deals.", "productivity"),
      C("zendesk", "Zendesk", "Read and draft replies to tickets.", "communication"),
      C("intercom", "Intercom", "Read conversations.", "communication"),
    ],
  },
  {
    name: "Data",
    items: [
      C("snowflake", "Snowflake", "Run governed read queries.", "data", "connector", ["snowflake"]),
      C("databricks", "Databricks", "Query tables and notebooks.", "data"),
      C("postgresql", "PostgreSQL", "Run governed read queries.", "data", "connector", ["postgresql", "postgres"]),
      C("mongodb", "MongoDB", "Read collections.", "data"),
    ],
  },
  {
    name: "Security and operations",
    items: [
      C("okta", "Okta", "Read users, groups and app assignments.", "security"),
      C("splunk", "Splunk", "Search logs.", "security"),
      C("datadog", "Datadog", "Read monitors and dashboards.", "security"),
      C("pagerduty", "PagerDuty", "Read incidents and on-call schedules.", "security"),
      C("aws", "AWS", "Read account configuration and findings.", "security"),
    ],
  },
  {
    name: "AI and research",
    items: [
      C("huggingface", "Hugging Face", "Search models and datasets.", "ai", "mcp", ["huggingface", "hugging-face"]),
      C("perplexity", "Perplexity", "Search the web with citations.", "ai", "mcp", ["perplexity"]),
      C("webhooks", "Webhook", "Call an internal HTTP endpoint.", "developer", "connector", ["webhook", "http", "generic"]),
    ],
  },
];

export const CONNECT_HREF: Record<IntegrationKind, string> = {
  connector: "/admin/connectors",
  mcp: "/admin/mcp-servers",
  chatops: "/admin/chatops",
};
