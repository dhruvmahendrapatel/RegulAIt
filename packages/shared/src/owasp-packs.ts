/**
 * ADR-0243 (PENDING P24) — THE OWASP PACKS: authored data.
 *
 *  - `owasp-mcp-top-10@1`: the OWASP MCP Top 10 (2025 list, beta), one control
 *    per item, mapped onto MCP admission, the per-user tool allow-lists, the
 *    scheduled re-scan, the egress guard and the audit ledger.
 *  - `owasp-llm-top-10@1`: the OWASP Top 10 for LLM Applications, 2025 edition.
 *  - `owasp-llm-top-10@2`: the same risks under the 2026 edition's numbering.
 *    v1 is never edited; a new edition is a new version (ADR-0058), reviewed
 *    with the ADR-0087 diff before anyone activates it.
 *
 * LICENCES (ADR-0176, ADR-0215 decision 2). The OWASP MCP Top 10 is
 * CC BY-NC-SA 4.0 and the LLM Top 10 is CC BY-SA 4.0. Share-alike and
 * non-commercial content is CITED BY ID ONLY: each title starts with the OWASP
 * identifier (`MCP03:2025`, `LLM03:2026`) and the rest of every title,
 * description and owner note is regulAIt's own wording. No OWASP text, risk
 * name or description is reproduced; read the publication for that.
 *
 * WHY THE CONTROL REFS ARE NOT THE OWASP NUMBERS. The 2026 edition renumbers
 * the list (Excessive Agency moves from LLM06 to LLM03; LLM03 was Supply Chain
 * in 2025). A pack matched by `controlRef` (the ADR-0087 diff, the ADR-0215
 * import merge, attestations, reports) would carry Supply Chain's mapping and
 * attestations onto Excessive Agency if the ref were `LLM03`. So each ref names
 * the RISK in regulAIt's own words and stays stable across editions; the
 * edition's number lives in the title and in `OWASP_LLM_EDITIONS` below.
 *
 * HONEST COVERAGE. Every coverage class is regulAIt's self-assessment against
 * enforcing code, and every `audit_decisions` filter names a rule id or object
 * type the gateway writes (checked by `owasp-packs.test.ts`, the guard the
 * ISACA and NIST packs have). Where the platform does not address an item the
 * control is `unaddressed` and attestation-required, and says so.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this one
 * to append the packs to `DEFAULT_COMPLIANCE_PACKS`.
 */
import type { CreateCompliancePackInput } from "./compliance-packs.js";

type Control = CreateCompliancePackInput["controls"][number];

const evidenced = (
  controlRef: string,
  c: Pick<Control, "title" | "coverage" | "collector"> & Partial<Pick<Control, "collectorParams" | "description" | "ownerNote">>,
): Control => ({
  controlRef,
  title: c.title,
  ...(c.description ? { description: c.description } : {}),
  coverage: c.coverage,
  collector: c.collector,
  collectorParams: c.collectorParams ?? {},
  minEvidenceCount: 1,
  attestationRequired: false,
  ownerNote: c.ownerNote ?? null,
});

const attested = (controlRef: string, title: string, coverage: Control["coverage"], ownerNote: string): Control => ({
  controlRef,
  title,
  coverage,
  collector: "none",
  collectorParams: {},
  minEvidenceCount: 1,
  attestationRequired: true,
  ownerNote,
});

// ===========================================================================
// OWASP MCP Top 10 (2025 list, beta)
// ===========================================================================

export const OWASP_MCP_FRAMEWORK = "owasp-mcp-top-10";

/** the publication, its licence and what we may store from it */
export const OWASP_MCP_SOURCE = {
  title: "OWASP MCP Top 10 (2025 list, beta: phase 3 of 5)",
  upstreamUrl: "https://owasp.org/www-project-mcp-top-10/",
  licence: "CC-BY-NC-SA-4.0",
  licenceUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
  textPolicy: "id_only",
} as const;

const mcp = (slug: string) => `${OWASP_MCP_FRAMEWORK}:${slug}`;

/** the OWASP identifier each control cites, by control ref */
export const OWASP_MCP_IDS: Readonly<Record<string, string>> = {
  [mcp("secrets-and-tokens")]: "MCP01:2025",
  [mcp("permission-creep")]: "MCP02:2025",
  [mcp("tampered-tool-metadata")]: "MCP03:2025",
  [mcp("server-supply-chain")]: "MCP04:2025",
  [mcp("command-execution")]: "MCP05:2025",
  [mcp("instructions-in-tool-content")]: "MCP06:2025",
  [mcp("caller-authentication")]: "MCP07:2025",
  [mcp("audit-trail")]: "MCP08:2025",
  [mcp("unregistered-servers")]: "MCP09:2025",
  [mcp("context-oversharing")]: "MCP10:2025",
};

const mcpTitle = (slug: string, text: string) => `${OWASP_MCP_IDS[mcp(slug)]} — ${text}`;

export const OWASP_MCP_CONTROLS: Control[] = [
  attested(
    mcp("secrets-and-tokens"),
    mcpTitle("secrets-and-tokens", "Keep MCP credentials out of prompts, tool content, logs and clients"),
    "partial",
    "Partly met by the platform, but no collector counts it: upstream MCP credentials are held by the gateway and never " +
      "returned to a client or a model, the caller's own token is not passed through to the upstream server (a signed " +
      "identity assertion is sent instead, where the server accepts one), the audit ledger scrubs credential shapes " +
      "(ADR-0099) and content columns refuse typed credentials (ADR-0233). Not covered: a secret the upstream server " +
      "itself returns in tool output, and rotation of the stored upstream credentials. Attest the rotation practice.",
  ),
  evidenced(mcp("permission-creep"), {
    title: mcpTitle("permission-creep", "Grant each person only the MCP tools they need, and review the grants"),
    description: "Counts access-recertification decisions on tool grants (kept, revoked, reassigned) in the period.",
    coverage: "enforced",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "grant-cert-" },
    ownerNote:
      "Tool access is default-deny and granted per person and per tool; a tool a server adds later is not granted to " +
      "anyone until an admin grants it. Agents act with the entitlements of the person running them, not their own " +
      "narrower identity. A period with no recertification shows no evidence.",
  }),
  evidenced(mcp("tampered-tool-metadata"), {
    title: mcpTitle("tampered-tool-metadata", "Scan tool descriptions before they are served, and re-scan when they change"),
    description:
      "Counts MCP admission decisions in the period: servers held by the scan, cleared by an admin, re-held after the " +
      "manifest drifted, and the scheduled re-scan sweeps.",
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "mcp-admission-" },
    ownerNote:
      "A held server is refused before any outbound connection, a clearance is pinned to the manifest digest, and the " +
      "scheduled re-scan reaches servers nobody syncs (ADR-0097, ADR-0100). The scan is deterministic pattern matching: " +
      "it can miss a poisoned description it has no pattern for, and admission can be relaxed to log or off (audited).",
  }),
  evidenced(mcp("server-supply-chain"), {
    title: mcpTitle("server-supply-chain", "Pin and quarantine MCP server releases before they are trusted"),
    description: "Counts MCP server release decisions in the period (a release quarantined, or a release change recorded).",
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "mcp-release-" },
    ownerNote:
      "Release changes are quarantined and stdio images flagged when unpinned. There is no software bill of materials " +
      "and no signature verification for MCP server packages or images. Attest how server packages are sourced.",
  }),
  evidenced(mcp("command-execution"), {
    title: mcpTitle("command-execution", "Run locally launched MCP servers in an isolated sandbox"),
    description:
      "Counts workloads placed in a sandbox at L2 (user-space kernel) or L3 (microVM) in the period, each after the " +
      "gateway accepted the sandbox's own probe report. Org-wide: counted under an org-scoped report only.",
    coverage: "partial",
    collector: "isolation_placements",
    ownerNote:
      "Covers stdio servers the platform launches. A remote MCP server runs on someone else's host, and an injected " +
      "command inside its own code is that server's to prevent; changes to a stdio server's command are audited.",
  }),
  evidenced(mcp("instructions-in-tool-content"), {
    title: mcpTitle("instructions-in-tool-content", "Treat tool arguments and results as untrusted input"),
    description: "Configuration evidence: a prompt-injection detector set to block (it scans tool arguments and output).",
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "prompt_injection", minMode: "block" },
    ownerNote:
      "Detection is pattern-based. There is no instruction hierarchy that stops retrieved text from overriding system " +
      "instructions.",
  }),
  evidenced(mcp("caller-authentication"), {
    title: mcpTitle("caller-authentication", "Authenticate every caller and decide each tool call for that person"),
    description: "Counts identity assertions the gateway issued to upstream MCP servers (or refused to issue) in the period.",
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "mcp-identity-assertion-" },
    ownerNote:
      "Every call through the gateway is authenticated and authorised per person and per tool. Whether an upstream " +
      "server authenticates the gateway, and checks the assertion it is sent, is that server's configuration.",
  }),
  evidenced(mcp("audit-trail"), {
    title: mcpTitle("audit-trail", "Record every MCP tool decision in a tamper-evident log"),
    description: "Counts governed decisions on MCP tool calls recorded in the hash-chained audit ledger in the period.",
    coverage: "enforced",
    collector: "audit_decisions",
    collectorParams: { objectType: "mcp_tool" },
    ownerNote: "Tool calls made outside the gateway are not seen.",
  }),
  evidenced(mcp("unregistered-servers"), {
    title: mcpTitle("unregistered-servers", "Find MCP servers and AI services used outside the register"),
    description: "Counts shadow-AI discovery records (findings, unsanctioned agents, remediation) in the period.",
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "shadow-" },
    ownerNote:
      "Discovery sees only the sources an admin has connected, and the egress guard refuses outbound calls to hosts " +
      "not on the allow-list. A server run on a laptop that never touches a connected source is not seen.",
  }),
  evidenced(mcp("context-oversharing"), {
    title: mcpTitle("context-oversharing", "Limit which context reaches a tool and a model, by trust and by membership"),
    description: "Counts content-trust settings recorded in the period (tier assignments and the minimum trust floor).",
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "content-trust-" },
    ownerNote:
      "Caches are scoped per user and agent, conversations per owner and project context per membership. There is no " +
      "per-tool minimisation of what a model sends in a tool call's arguments.",
  }),
];

export const OWASP_MCP_PACK: CreateCompliancePackInput = {
  framework: OWASP_MCP_FRAMEWORK,
  version: 1,
  title: "OWASP MCP Top 10 (2025 list) — control mapping",
  description:
    "One control per item of the OWASP MCP Top 10 (2025 list, beta). Items are cited by their OWASP identifier only; " +
    "every title and note is regulAIt's own wording. Eight items count evidence from regulAIt's ledgers, one is " +
    "configuration evidence, and one needs the organisation's attestation. This is a mapping, not a certification.",
  provenance: {
    source: `${OWASP_MCP_SOURCE.title}, ${OWASP_MCP_SOURCE.upstreamUrl}`,
    catalogueRevision: "2025 (beta)",
    reviewedBy: null,
    reviewedOn: null,
    note:
      "Licence: CC BY-NC-SA 4.0 (non-commercial, share-alike), so items are cited by identifier only and no OWASP text " +
      "is reproduced. The list is a beta and may change before it is final. Coverage is regulAIt's self-assessment " +
      "against enforcing code. NOT reviewed by OWASP or by a domain reviewer — treat as a starting point.",
  },
  cascadeTag: null,
  controls: OWASP_MCP_CONTROLS,
};

// ===========================================================================
// OWASP Top 10 for LLM Applications — 2025 edition (v1) and 2026 edition (v2)
// ===========================================================================

export const OWASP_LLM_FRAMEWORK = "owasp-llm-top-10";

export const OWASP_LLM_SOURCES = {
  2025: {
    title: "OWASP Top 10 for LLM Applications, 2025 edition",
    upstreamUrl: "https://genai.owasp.org/llm-top-10/",
  },
  2026: {
    title: "OWASP Top 10 for LLM Applications, 2026 edition (published 2026-08)",
    upstreamUrl: "https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/",
  },
  licence: "CC-BY-SA-4.0",
  licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  textPolicy: "id_only",
} as const;

const llm = (slug: string) => `${OWASP_LLM_FRAMEWORK}:${slug}`;

/**
 * THE CROSSWALK: each risk's identifier in each edition, keyed by the stable
 * control ref. This table is the one place the renumbering is written; the
 * titles are built from it and the tests check both editions are complete.
 */
export const OWASP_LLM_EDITIONS: Readonly<Record<string, { 2025: string; 2026: string }>> = {
  [llm("prompt-manipulation")]: { 2025: "LLM01", 2026: "LLM01" },
  [llm("sensitive-data-disclosure")]: { 2025: "LLM02", 2026: "LLM02" },
  [llm("agent-overreach")]: { 2025: "LLM06", 2026: "LLM03" },
  [llm("model-supply-chain")]: { 2025: "LLM03", 2026: "LLM04" },
  [llm("training-data-poisoning")]: { 2025: "LLM04", 2026: "LLM05" },
  [llm("resource-exhaustion")]: { 2025: "LLM10", 2026: "LLM06" },
  [llm("false-output")]: { 2025: "LLM09", 2026: "LLM07" },
  [llm("hidden-context-leak")]: { 2025: "LLM07", 2026: "LLM08" },
  [llm("retrieval-store-weakness")]: { 2025: "LLM08", 2026: "LLM09" },
  [llm("unsafe-output-use")]: { 2025: "LLM05", 2026: "LLM10" },
};

type Edition = 2025 | 2026;
const llmTitle = (slug: string, edition: Edition, text: string) => `${OWASP_LLM_EDITIONS[llm(slug)]![edition]}:${edition} — ${text}`;

/** the mapping, which is the same in both editions except where a risk's scope changed */
function llmControls(edition: Edition): Control[] {
  const t = (slug: string, text: string) => llmTitle(slug, edition, text);
  return [
    evidenced(llm("prompt-manipulation"), {
      title: t("prompt-manipulation", "Detect and block attempts to override the model's instructions through its input"),
      description: "Configuration evidence: a prompt-injection detector set to block.",
      coverage: "partial",
      collector: "guardrail_configs",
      collectorParams: { detector: "prompt_injection", minMode: "block" },
      ownerNote:
        "Detection is pattern-based and scans prompts, tool arguments and tool output. Content hidden in images or " +
        "audio is not scanned.",
    }),
    evidenced(llm("sensitive-data-disclosure"), {
      title: t("sensitive-data-disclosure", "Keep personal and confidential data out of prompts and responses"),
      description: "Configuration evidence: a compliance profile whose cascade forces PII blocking.",
      coverage: "partial",
      collector: "compliance_profile_cascade",
      collectorParams: { cascadeAspect: "pii_block" },
      ownerNote:
        "PII detection is pattern- and model-based and runs at the gateway. Data a model provider retains is governed " +
        "by the organisation's contract with that provider.",
    }),
    evidenced(llm("agent-overreach"), {
      title: t("agent-overreach", "Limit what an agent may do: its tools, its permissions and how far it acts alone"),
      description: "Counts approvals decided by a named person in the period.",
      coverage: "partial",
      collector: "approvals",
      collectorParams: { status: "approved" },
      ownerNote:
        "Tool access is default-deny per person and per tool, state-changing tools can require a person's approval bound " +
        "to the payload, and the execution controls can halt an agent. Agents act with the entitlements of the person " +
        "running them rather than a narrower identity of their own.",
    }),
    evidenced(llm("model-supply-chain"), {
      title: t("model-supply-chain", "Approve the models, providers and components a system depends on before use"),
      description: "Counts approved, unexpired model cards.",
      coverage: "partial",
      collector: "model_cards_approved",
      ownerNote:
        "Models and providers are registered and approved, and served-model drift is detected. There is no AI or " +
        "software bill of materials and no verification of model weights.",
    }),
    attested(
      llm("training-data-poisoning"),
      t("training-data-poisoning", "Protect the data a model is trained or fine-tuned on from tampering"),
      "unaddressed",
      "Not addressed by the platform: regulAIt does not train or fine-tune models, so the integrity of training data is " +
        "the model provider's or the organisation's own pipeline's. Attest how training and fine-tuning data is sourced " +
        "and checked.",
    ),
    evidenced(llm("resource-exhaustion"), {
      title: t("resource-exhaustion", "Cap the spend and call volume a person, project or agent can consume"),
      description: "Configuration evidence: a compliance profile whose cascade forces a budget ceiling.",
      coverage: "enforced",
      collector: "compliance_profile_cascade",
      collectorParams: { cascadeAspect: "budget_ceiling" },
      ownerNote:
        "Budgets and rate limits are enforced at the gateway before a call is made. Capacity of the model provider and " +
        "of the deployment itself is the organisation's.",
    }),
    evidenced(llm("false-output"), {
      title: t("false-output", "Measure how often the system gives wrong or unsupported answers"),
      description: "Counts evaluation runs started in the period.",
      coverage: "partial",
      collector: "eval_runs",
      ownerNote:
        "Evaluations measure quality on the organisation's own test sets; they do not check answers at run time. " +
        "How people are told to rely on the output is the organisation's.",
    }),
    evidenced(llm("hidden-context-leak"), {
      title:
        edition === 2025
          ? t("hidden-context-leak", "Keep system instructions free of secrets, and stop them leaking")
          : t("hidden-context-leak", "Keep system instructions and other hidden context free of secrets, and stop them leaking"),
      description:
        edition === 2025
          ? "Configuration evidence: a semantic data-loss detector set to block."
          : "Configuration evidence: a semantic data-loss detector set to block. The 2026 edition widens this risk from " +
            "system instructions to all context a user does not see (retrieved content, tool results, memory).",
      coverage: "partial",
      collector: "guardrail_configs",
      collectorParams: { detector: "semantic_dlp", minMode: "block" },
      ownerNote:
        "Content columns refuse typed credentials (ADR-0233) and the audit ledger scrubs them (ADR-0099). Whether a " +
        "system prompt holds secrets is the author's choice; the detector catches only what it recognises.",
    }),
    evidenced(llm("retrieval-store-weakness"), {
      title: t("retrieval-store-weakness", "Control who can read and write retrieval stores, and how far their content is trusted"),
      description: "Counts content-trust settings recorded in the period (tier assignments and the minimum trust floor).",
      coverage: "partial",
      collector: "audit_decisions",
      collectorParams: { ruleIdPrefix: "content-trust-" },
      ownerNote:
        "Project context is shared per membership and content carries a trust tier. Embedding inversion and the access " +
        "controls of a vector store the organisation runs itself are not covered.",
    }),
    attested(
      llm("unsafe-output-use"),
      t("unsafe-output-use", "Validate and encode model output before another system acts on it"),
      "partial",
      "Partly met by the platform, but no collector counts it: regulAIt's own console renders model output as text under " +
        "a strict content security policy, and tool calls a model proposes pass the governance decision. What a " +
        "downstream system does with the output (a query, a shell, a page) is that system's. Attest how it is handled.",
    ),
  ];
}

export const OWASP_LLM_CONTROLS_2025: Control[] = llmControls(2025);
export const OWASP_LLM_CONTROLS_2026: Control[] = llmControls(2026);

export const OWASP_LLM_PACK: CreateCompliancePackInput = {
  framework: OWASP_LLM_FRAMEWORK,
  version: 1,
  title: "OWASP Top 10 for LLM Applications (2025 edition) — control mapping",
  description:
    "One control per risk of the OWASP Top 10 for LLM Applications, 2025 edition. Risks are cited by their OWASP " +
    "identifier only; every title and note is regulAIt's own wording. One risk is not addressed by the platform and one " +
    "more needs the organisation's attestation. This is a mapping, not a certification.",
  provenance: {
    source: `${OWASP_LLM_SOURCES[2025].title}, ${OWASP_LLM_SOURCES[2025].upstreamUrl}`,
    catalogueRevision: "2025",
    reviewedBy: null,
    reviewedOn: null,
    note:
      "Licence: CC BY-SA 4.0 (share-alike), so risks are cited by identifier only and no OWASP text is reproduced. " +
      "Coverage is regulAIt's self-assessment against enforcing code. NOT reviewed by OWASP or by a domain reviewer — " +
      "treat as a starting point.",
  },
  cascadeTag: null,
  controls: OWASP_LLM_CONTROLS_2025,
};

/**
 * `owasp-llm-top-10@2` — the 2026 edition. v1 is unchanged. The control refs
 * are the same ten risks, so the ADR-0087 diff shows each renumbering as a
 * title change with the mapping intact, plus the one scope change (hidden
 * context, LLM08:2026). No control is added or removed.
 */
export const OWASP_LLM_PACK_V2: CreateCompliancePackInput = {
  ...OWASP_LLM_PACK,
  version: 2,
  title: "OWASP Top 10 for LLM Applications (2026 edition) — control mapping",
  description:
    "One control per risk of the OWASP Top 10 for LLM Applications, 2026 edition, which renumbers the 2025 list. " +
    "Risks are cited by their OWASP identifier only; every title and note is regulAIt's own wording. One risk is not " +
    "addressed by the platform and one more needs the organisation's attestation. This is a mapping, not a certification.",
  provenance: {
    ...OWASP_LLM_PACK.provenance,
    source: `${OWASP_LLM_SOURCES[2026].title}, ${OWASP_LLM_SOURCES[2026].upstreamUrl}`,
    catalogueRevision: "2026",
    note:
      `${OWASP_LLM_PACK.provenance.note} v2 (ADR-0243): the same ten risks under the 2026 numbering; the mapping is ` +
      "unchanged except that the hidden-context risk (LLM08:2026) now covers all context a user does not see. v1 is unchanged.",
  },
  controls: OWASP_LLM_CONTROLS_2026,
};

/** what `compliance-packs.ts` appends to the seed catalogue */
export const OWASP_PACKS: CreateCompliancePackInput[] = [OWASP_MCP_PACK, OWASP_LLM_PACK, OWASP_LLM_PACK_V2];
