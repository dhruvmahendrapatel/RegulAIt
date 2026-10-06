/**
 * ADR-0182 (ADR-0175 batch D4) S5 — THE ISACA AI AGENTS PACK
 * (`isaca-ai-agents@1`, ROADMAP I2): authored data. OWNER: S5 (D4).
 *
 * Source: ISACA, "Cybersecurity Recommendations for Securing AI Agents"
 * (2026), its 15-item Secure-by-Default checklist. ONE CONTROL PER ITEM.
 *
 * COPYRIGHT. ISACA's text is copyrighted, so nothing here reproduces it: every
 * title and description is regulAIt's own paraphrase of what an item asks, and
 * the provenance sends the reader to the publication for the wording.
 *
 * HONEST COVERAGE (ROADMAP §7.1, audited against enforcing code). Items 3
 * (per-agent identity and least privilege) and 5 (sandboxed execution and
 * network segmentation) are `unaddressed` and attestation-required: the
 * platform does not do them, and the pack says so on the customer's own
 * dashboard. Items 8 (memory retention) and 12 (pinning, SBOM, signing) are
 * partly met by the platform but no collector counts their evidence, so they
 * are attestation-required too. The rest are evidenced by collectors whose
 * rows really are the evidence named; every `audit_decisions` filter names a
 * rule id or object type the gateway actually writes (checked by
 * `isaca-pack.test.ts`, the same guard the NIST pack has).
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this
 * one to append the pack to `DEFAULT_COMPLIANCE_PACKS`, so a value import
 * back would be a runtime cycle.
 */
import type { CreateCompliancePackInput } from "./compliance-packs.js";

type Control = CreateCompliancePackInput["controls"][number];

export const ISACA_AI_AGENTS_FRAMEWORK = "isaca-ai-agents";

/** the publication the pack maps, cited on the pack and in the console */
export const ISACA_AI_AGENTS_SOURCE =
  'ISACA, "Cybersecurity Recommendations for Securing AI Agents" (2026), Secure-by-Default checklist (15 items)';

const ref = (item: number, slug: string) => `${ISACA_AI_AGENTS_FRAMEWORK}:item-${String(item).padStart(2, "0")}-${slug}`;

const evidenced = (
  item: number,
  slug: string,
  c: Pick<Control, "title" | "coverage" | "collector"> & Partial<Pick<Control, "collectorParams" | "description" | "ownerNote">>,
): Control => ({
  controlRef: ref(item, slug),
  title: c.title,
  ...(c.description ? { description: c.description } : {}),
  coverage: c.coverage,
  collector: c.collector,
  collectorParams: c.collectorParams ?? {},
  minEvidenceCount: 1,
  attestationRequired: false,
  ownerNote: c.ownerNote ?? null,
});

const attested = (item: number, slug: string, title: string, coverage: Control["coverage"], ownerNote: string): Control => ({
  controlRef: ref(item, slug),
  title,
  coverage,
  collector: "none",
  collectorParams: {},
  minEvidenceCount: 1,
  attestationRequired: true,
  ownerNote,
});

export const ISACA_AI_AGENTS_CONTROLS: Control[] = [
  evidenced(1, "inventory", {
    title: "Keep a register of the agents in use and what they rely on (tools, models, memory, providers)",
    description: "Counts changes to the agent registry recorded in the period.",
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { objectType: "agent" },
    ownerNote:
      "Agents, connectors, MCP servers, grants, providers, vendors and use cases are inventoried; memory stores are not.",
  }),
  evidenced(2, "boundaries-owners", {
    title: "Give every agent an accountable owner and know where its trust boundaries lie",
    description: "Counts agent stewardship records (a named steward set or a steward's review) in the period.",
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { objectType: "agent", ruleIdPrefix: "agent-stewardship-" },
    ownerNote:
      "Owners are recorded on agents, risks, vendors and use cases. Trust boundaries are implicit in the deployment " +
      "mode, the project cascade and the egress allow-list; MCP servers and connectors have no owner.",
  }),
  attested(
    3,
    "agent-identity-least-privilege",
    "Give each agent its own identity and only the permissions its task needs",
    "unaddressed",
    "Not addressed by the platform today: least privilege is enforced per PERSON (tool grants and ABAC name users), so an " +
      "agent acts with the entitlements of the person running it. Attest how agents are identified and constrained.",
  ),
  evidenced(4, "short-lived-credentials", {
    title: "Prefer short-lived, federated credentials over standing secrets",
    description: "Counts API-key lifecycle records (issued with an expiry, revoked, refused as expired) in the period.",
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "api-key-" },
    ownerNote:
      "API keys, virtual keys, sessions and approvals expire. There is no federated workload identity for agents, and " +
      "model-provider credentials are long-lived stored keys.",
  }),
  attested(
    5,
    "sandbox-segmentation",
    "Run agent actions in an isolated environment on a segmented network",
    "unaddressed",
    "Not addressed by the platform: tools run on remote MCP servers, so there is no local sandbox, and network " +
      "segmentation is the deployment's. Attest with a reference to the hosting design.",
  ),
  evidenced(6, "deny-egress", {
    title: "Refuse outbound connections unless they are explicitly allowed",
    description: "Counts egress decisions in the ledger (refused connections and allow-list changes) in the period.",
    coverage: "enforced",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "egress-" },
    ownerNote:
      "The application-layer egress guard is default-deny with an allow-list. Process- and network-level egress is the " +
      "deployment's. A quiet period with no refusal and no change shows no evidence.",
  }),
  evidenced(7, "untrusted-content", {
    title: "Treat retrieved content and tool output as untrusted input",
    description: "Configuration evidence: a prompt-injection detector set to block (it scans tool arguments and output).",
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "prompt_injection", minMode: "block" },
    ownerNote:
      "Detection is pattern-based. There is no provenance or trust-level tagging of content, and no instruction " +
      "hierarchy that stops retrieved text from overriding system instructions.",
  }),
  attested(
    8,
    "memory-isolation-retention",
    "Isolate agent memory per user and context, and delete it on a defined schedule",
    "partial",
    "Isolation is enforced (cache scoped per user and agent, conversations per owner, project context per membership); " +
      "retention of cached content and conversations is not enforced by a purge job yet. Attest the retention practice.",
  ),
  evidenced(9, "policy-enforcement-point", {
    title: "Route every tool action through one policy decision point before it runs",
    description: "Counts governed decisions on MCP tool calls recorded in the period.",
    coverage: "enforced",
    collector: "audit_decisions",
    collectorParams: { objectType: "mcp_tool" },
    ownerNote: "Tool calls the organisation runs outside the gateway are not seen.",
  }),
  evidenced(10, "human-approval", {
    title: "Require a person's approval before high-risk actions",
    description: "Counts approvals decided by a named person in the period.",
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved" },
    ownerNote:
      "Approval is bound to the payload and separated from the requester. Dual control on tool-call rules and step-up " +
      "re-authentication at the sensitive action are not built.",
  }),
  evidenced(11, "logging-redaction", {
    title: "Record prompts, tool calls, decisions and approvals, with sensitive values redacted",
    description: "Counts records in the hash-chained audit ledger in the period.",
    coverage: "enforced",
    collector: "audit_decisions",
  }),
  attested(
    12,
    "pinning-sbom-signing",
    "Pin model and dependency versions, keep a bill of materials, and verify signatures",
    "partial",
    "Update bundles are signed and verified before they apply, and a served-model drift rule compares served and " +
      "configured models. There is no software or AI bill of materials, no image signing and no enforced model-version " +
      "pinning. Attest the release and supply-chain practice.",
  ),
  evidenced(13, "change-control", {
    title: "Control changes to agents and their policies through a secure development lifecycle",
    description: "Counts workflow sign-offs (plan, merge and deploy gates) approved by a person in the period.",
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved", approvalObjectType: "workflow" },
    ownerNote:
      "In-product change control (versions, canary, rollback, dry runs, gates) is evidenced. The organisation's own " +
      "code scanning and CI controls are its own.",
  }),
  evidenced(14, "kill-switch-safe-mode", {
    title: "Be able to stop, roll back or restrict agents quickly",
    description: "Counts uses of the execution controls (the org-wide mode, agent and tool halts and their release) in the period.",
    coverage: "evidenced",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "execution-" },
    ownerNote:
      "The controls are enforced ahead of every rule; a period in which nobody used them shows no evidence, which is " +
      "not a missing control.",
  }),
  evidenced(15, "continuous-red-teaming", {
    title: "Red-team agents continuously, not once",
    description: "Counts red-team runs (scheduled and on demand) in the period.",
    coverage: "evidenced",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "redteam-run-" },
  }),
];

export const ISACA_AI_AGENTS_PACK: CreateCompliancePackInput = {
  framework: ISACA_AI_AGENTS_FRAMEWORK,
  version: 1,
  title: "ISACA — securing AI agents, Secure-by-Default checklist (control mapping)",
  description:
    "One control per item of the 15-item Secure-by-Default checklist in ISACA's recommendations for securing AI agents " +
    "(2026). Titles are regulAIt's paraphrases, not ISACA's text. Two items are not addressed by the platform and two " +
    "more need the organisation's attestation; the rest count evidence from regulAIt's own ledgers.",
  provenance: {
    source: ISACA_AI_AGENTS_SOURCE,
    catalogueRevision: "2026",
    reviewedBy: null,
    reviewedOn: null,
    note:
      "Authored from the publication. Control titles are regulAIt's own paraphrases: ISACA's text is copyrighted and is " +
      "not reproduced; read the publication for each item's wording. Coverage follows regulAIt's self-assessment " +
      "against enforcing code. NOT reviewed by ISACA or by counsel — treat as a starting point.",
  },
  cascadeTag: null,
  controls: ISACA_AI_AGENTS_CONTROLS,
};
