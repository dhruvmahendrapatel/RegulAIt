/**
 * ADR-0351 slice 3 — A CIS-STYLE BENCHMARK FOR AI CODING-AGENT ENDPOINTS: authored data.
 *
 * `ai-coding-endpoint-benchmark@1` is a hardening benchmark for the developer machines where coding agents (Claude
 * Code, Cursor, Copilot, Codex and the like) run, laid out the way a CIS Benchmark is: numbered recommendations in
 * sections, each with a profile level (L1 = a baseline every fleet should meet, L2 = defence in depth) and a check.
 *
 * NOT A CIS BENCHMARK. It is regulAIt's own benchmark in regulAIt's own words. CIS Benchmarks are published by the
 * Center for Internet Security under their own licence, and no CIS text, number or recommendation is reproduced.
 *
 * EVERY RECOMMENDATION MAPS TO A REAL CHECK. The endpoint ones run the `endpoint_benchmark_check` collector over the
 * endpoint agent's ledgers (devices, identities, MCP server configurations, add-on sightings) and the gateway's MCP
 * definition pins. It counts 1 only when the check passes over at least one enrolled device, so an empty fleet never
 * passes. The gateway ones use the existing collectors. What the platform cannot check is attestation-required and
 * the owner note says what to attest. A passed check is evidence the condition held when evaluated, not an audit
 * opinion. The endpoint ledgers keep the latest state, not history, so an endpoint check reports the fleet as it stands
 * when the report is generated, not as it stood at the period's end, and its evidence text says so.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this one to append the pack.
 */
import type { CreateCompliancePackInput, EndpointBenchmarkCheck } from "./compliance-packs.js";
import { attestedControl as att, evidencedControl as ev } from "./pack-builders.js";
import type { TrustDimension } from "./risks.js";

export const ENDPOINT_BENCHMARK_FRAMEWORK = "ai-coding-endpoint-benchmark";
const ref = (id: string, slug: string) => `${ENDPOINT_BENCHMARK_FRAMEWORK}:${id}-${slug}`;
const title = (id: string, level: "L1" | "L2", text: string) => `${id} (${level}) — ${text}`;
const check = (endpointCheck: EndpointBenchmarkCheck) => ({
  collector: "endpoint_benchmark_check" as const,
  collectorParams: { endpointCheck },
});

export const ENDPOINT_BENCHMARK_CONTROLS: CreateCompliancePackInput["controls"] = [
  // --- 1. Enrolment and identity ----------------------------------------------------------------------------------
  ev(ref("1.1", "endpoints-enrolled-and-reporting"), title("1.1", "L1", "Every coding-agent endpoint is enrolled and reported in the last 7 days"), {
    coverage: "evidenced",
    ...check("devices_reporting_7d"),
    evidence: "1 when every unrevoked enrolled device reported in the last 7 days, 0 otherwise, as the fleet stands when the report is generated",
    note: "Devices that were never enrolled are outside the check: compare the enrolled count with your device inventory.",
  }),
  ev(ref("1.2", "agent-keys-in-hardware"), title("1.2", "L2", "The endpoint agent's signing key is held in hardware"), {
    coverage: "evidenced",
    ...check("agent_keys_hardware"),
    evidence: "1 when every agent identity on an unrevoked device uses a TPM or Secure Enclave key, 0 otherwise, as the fleet stands when the report is generated",
    note: "A software key can be copied off the device. Machines with no TPM or Secure Enclave fail this check by design.",
  }),
  // --- 2. MCP server configuration ------------------------------------------------------------------------------------
  ev(ref("2.1", "no-auto-approved-tools"), title("2.1", "L1", "No MCP server is configured to run tools without asking"), {
    coverage: "evidenced",
    ...check("mcp_no_auto_approved_tools"),
    evidence: "1 when no enabled MCP server seen in the last 30 days auto-approves any tool, 0 otherwise, as the fleet stands when the report is generated",
    note: "Auto-approval lets an agent call a tool with no person in the loop. Remove the auto-approve entries from the agent's configuration.",
  }),
  ev(ref("2.2", "no-inline-credentials"), title("2.2", "L1", "No credential is written into an MCP server configuration"), {
    coverage: "evidenced",
    ...check("mcp_no_inline_secrets"),
    evidence: "1 when no enabled MCP server configuration seen in the last 30 days carries a credential, 0 otherwise, as the fleet stands when the report is generated",
    note: "The agent reports the credential's type, never its value. Move credentials to the OS keychain or a governed connector.",
  }),
  ev(ref("2.3", "no-high-risk-launchers"), title("2.3", "L1", "No MCP server is launched in a high-risk way"), {
    coverage: "evidenced",
    ...check("mcp_no_risky_servers"),
    evidence: "1 when no enabled MCP server seen in the last 30 days has a flagged risk (shell launcher, privileged container, host root mount and the like), 0 otherwise, as the fleet stands when the report is generated",
    note: "Each flag comes from the endpoint agent's static analysis of the configuration, not from watching the process run.",
  }),
  ev(ref("2.4", "mcp-servers-admitted"), title("2.4", "L2", "Every MCP server in use is admitted to the governed registry"), {
    coverage: "evidenced",
    ...check("mcp_servers_registered"),
    evidence: "1 when every enabled MCP server seen in the last 30 days is linked to an enabled registry server whose admission is clean, cleared or grandfathered (not held or unscanned), 0 otherwise, as the fleet stands when the report is generated",
    note: "An unlinked server is shadow MCP: its calls do not pass the gateway's governance. Link or remove it.",
  }),
  ev(ref("2.5", "mcp-definitions-unchanged"), title("2.5", "L1", "MCP tool definitions match the version an admin approved"), {
    coverage: "enforced",
    ...check("mcp_definitions_unchanged"),
    evidence: "1 when at least one MCP definition is pinned on an enabled server and none of those differs from its approved digest, 0 otherwise, as the fleet stands when the report is generated",
    note: "A changed definition is blocked until an admin re-approves it against the diff (ADR-0246).",
  }),
  // --- 3. IDE and agent add-ons -----------------------------------------------------------------------------------
  ev(ref("3.1", "addons-no-credentials"), title("3.1", "L1", "No IDE or agent add-on carries a credential"), {
    coverage: "evidenced",
    ...check("addons_no_secrets"),
    evidence: "1 when no add-on sighting in the last 30 days carries a credential, 0 otherwise, as the fleet stands when the report is generated",
    note: "The type of credential is recorded, never the value. Rotate any credential an add-on held.",
  }),
  // --- 4. Governed agent traffic ----------------------------------------------------------------------------------
  ev(ref("4.1", "agent-calls-governed-and-logged"), title("4.1", "L1", "Agent model and tool calls pass the governance gateway and are logged"), {
    coverage: "enforced",
    collector: "audit_decisions",
    evidence: "governed decisions written to the hash-chained audit log in the period",
    note: "Calls that bypass the gateway are not counted. Checks 2.4 and 1.1 show how much of the fleet is covered.",
  }),
  ev(ref("4.2", "prompt-injection-blocked"), title("4.2", "L1", "Prompt-injection screening blocks, not only logs"), {
    coverage: "enforced",
    collector: "guardrail_configs",
    collectorParams: { detector: "prompt_injection", minMode: "block" },
    evidence: "guardrail configurations with prompt-injection detection at block",
    note: "Screening applies to traffic through the gateway.",
  }),
  ev(ref("4.3", "risky-actions-need-approval"), title("4.3", "L2", "State-changing agent actions wait for a person's approval"), {
    coverage: "evidenced",
    collector: "approvals",
    collectorParams: { status: "approved" },
    evidence: "approvals decided by a named person in the period",
    note: "Which actions need approval is your policy: the count shows the approval path is used.",
  }),
  ev(ref("4.4", "attribute-based-access"), title("4.4", "L2", "Attribute-based access policies narrow what each agent may call"), {
    coverage: "enforced",
    collector: "abac_policies_active",
    evidence: "ABAC policies in the active set",
    note: "Per-user allow-lists apply regardless. ABAC adds conditions such as device posture or data sensitivity.",
  }),
  // --- 5. Organisational ------------------------------------------------------------------------------------------
  att(ref("5.1", "full-disk-encryption"), title("5.1", "L1", "Coding-agent endpoints use full-disk encryption"), "unaddressed",
    "The endpoint agent does not read disk-encryption state. Attest from your MDM, with a reference to its compliance report."),
  att(ref("5.2", "shell-command-policy"), title("5.2", "L1", "Shell commands run by coding agents follow a written allow, ask or deny policy"), "unaddressed",
    "On-device decisions cover MCP tool calls only, and built-in shell commands are not decided yet. Attest the policy and how it is enforced (for example, the agent's own permission file)."),
  att(ref("5.3", "agents-kept-current"), title("5.3", "L2", "Coding agents and the endpoint agent are kept on supported versions"), "unaddressed",
    "Versions are reported, but there is no source of 'supported' to compare them with. Attest the update policy and how it is enforced."),
];

export const ENDPOINT_BENCHMARK_PACK: CreateCompliancePackInput = {
  framework: ENDPOINT_BENCHMARK_FRAMEWORK,
  version: 1,
  title: "AI coding-agent endpoint benchmark (CIS-style, regulAIt authored)",
  description:
    "A hardening benchmark for the machines where coding agents run, in CIS layout: numbered recommendations with a " +
    "profile level (L1 baseline, L2 defence in depth), each mapped to a live check over the endpoint agent's and the " +
    "gateway's ledgers or, where none exists, to an attestation. Not a CIS Benchmark and not endorsed by CIS.",
  provenance: {
    source: "regulAIt, ADR-0351 (endpoint agent ADR-0298, ADR-0259, ADR-0332; MCP pins ADR-0246)",
    catalogueRevision: "1 (2026-11-17)",
    reviewedBy: null,
    reviewedOn: null,
    note: "Authored by regulAIt in CIS layout. No CIS text, numbering or recommendation is reproduced.",
  },
  cascadeTag: null,
  controls: ENDPOINT_BENCHMARK_CONTROLS,
};

export const ENDPOINT_BENCHMARK_PACKS: CreateCompliancePackInput[] = [ENDPOINT_BENCHMARK_PACK];

/** the attestation-only recommendations are endpoint security controls (ADR-0148) */
export const ENDPOINT_BENCHMARK_DIMENSIONS: Readonly<Record<string, TrustDimension>> = Object.fromEntries(
  ENDPOINT_BENCHMARK_CONTROLS.filter((c) => c.collector === "none").map((c) => [c.controlRef, "security" as TrustDimension]),
);
