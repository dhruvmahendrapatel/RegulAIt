/**
 * ADR-0336 (lane E17): one adapter per agent platform vendor, serving read now and governed write later (lane E19,
 * ADR-0338). An adapter WRAPS the existing `Scanner` (ADR-0195 SD0, as #855 registered it); it does not replace it.
 * Every registry vendor is an adapter, #855's included, and the `agent_registry` family's scanners are built from
 * this one list, so E19 adds actions to the same interface for every vendor.
 *
 * Write side, fixed here and implemented only by E19 (decision 2): a write uses a SEPARATE credential (purpose
 * `platform_write`), never the read one; the read credential is still refused when it can write; every write is an
 * approval-gated, step-up, audited action; a vendor with no documented write declares no action. E17 ships the
 * declarations and no write code.
 *
 * Read side (decision 5): an adapter that talks to a vendor API directly declares its endpoints, and
 * `allowListedFetch` refuses any other (method, origin, path) BEFORE the request leaves, on top of the guarded fetch.
 * Pagination cursors are passed back as query parameters on an allowed path, never followed as URLs.
 */
import type { DiscoverySourceKind } from "@regulait/shared";
import { AGENT_REGISTRY_SCANNERS } from "./agent-registry-scanners.js";
import { AGENTFORCE_ENDPOINTS, AGENTFORCE_SCANNER } from "./agent-registry-agentforce.js";
import { COPILOT_STUDIO_ENDPOINTS, COPILOT_STUDIO_SCANNER } from "./agent-registry-copilot-studio.js";
import { N8N_ENDPOINTS, N8N_SCANNER } from "./agent-registry-n8n.js";
import { OPENAI_ENDPOINTS, OPENAI_SCANNER } from "./agent-registry-openai.js";
import type { EndpointRule } from "./agent-platform-endpoints.js";
import type { Scanner } from "./discovery-scanners.js";

export { allowListedFetch, type EndpointRule } from "./agent-platform-endpoints.js";

export const AGENT_PLATFORM_VENDORS = ["microsoft", "google", "aws", "salesforce", "openai", "n8n"] as const;
export type AgentPlatformVendor = (typeof AGENT_PLATFORM_VENDORS)[number];

/** what lane E19 may do to an imported agent on this platform; declared here, executed only by E19 */
export interface GovernedActionSpec {
  action: "disable" | "quarantine" | "unquarantine";
  reversible: boolean;
  /** the least permission the vendor documents for it */
  vendorPermission: string;
}

export interface AgentPlatformAdapter {
  vendor: AgentPlatformVendor;
  /** the read source kind */
  kind: DiscoverySourceKind;
  /** the read path, exactly as the worker runs it */
  scanner: Scanner;
  /**
   * The endpoints the read path may call (decision 5), enforced by `allowListedFetch` inside the scanner. Null for
   * #855's registry scanners, which reach fixed hosts through their own bounded helpers (ADR-0314); every E17 adapter
   * declares one.
   */
  readEndpoints: readonly EndpointRule[] | null;
  governedActions: readonly GovernedActionSpec[];
}

const VENDOR_OF_REGISTRY_KIND: Readonly<Partial<Record<DiscoverySourceKind, AgentPlatformVendor>>> = Object.freeze({
  agent_registry_entra: "microsoft",
  agent_registry_gemini: "google",
  agent_registry_agentcore: "aws",
});

/** the one adapter list; `agent_registry` scanners are registered from it (discovery-scanners.ts) */
export const AGENT_PLATFORM_ADAPTERS: readonly AgentPlatformAdapter[] = Object.freeze([
  // #855's registry scanners, wrapped unchanged: E19 fills in their actions through this same interface
  ...AGENT_REGISTRY_SCANNERS.map((scanner): AgentPlatformAdapter => {
    const vendor = VENDOR_OF_REGISTRY_KIND[scanner.kind];
    if (!vendor) throw new Error(`no vendor declared for registry kind ${scanner.kind}`);
    return Object.freeze({ vendor, kind: scanner.kind, scanner, readEndpoints: null, governedActions: Object.freeze([]) });
  }),
  // ADR-0336 slice 1. No action: SetAsQuarantined is documented only for a delegated admin user token (decision 2's
  // open constraint), which ADR-0195's credential model refuses, so E19 decides how, or whether, to close it.
  Object.freeze({ vendor: "microsoft", kind: "agent_registry_copilot_studio", scanner: COPILOT_STUDIO_SCANNER, readEndpoints: COPILOT_STUDIO_ENDPOINTS, governedActions: Object.freeze([]) }),
  // ADR-0336 slice 2. No action yet: deactivating the active BotVersion is E19's, with its own write credential.
  Object.freeze({ vendor: "salesforce", kind: "agent_registry_agentforce", scanner: AGENTFORCE_SCANNER, readEndpoints: AGENTFORCE_ENDPOINTS, governedActions: Object.freeze([]) }),
  // ADR-0336 slice 3. No action yet: GPT removal (Compliance API, destructive, irreversible) and n8n workflow
  // deactivation (`workflow:activate`) are E19's, each with its own write credential. n8n's allow-list is declared
  // for an instance at the root; the scanner builds the same rules under the target's path prefix.
  Object.freeze({ vendor: "openai", kind: "agent_registry_openai", scanner: OPENAI_SCANNER, readEndpoints: OPENAI_ENDPOINTS, governedActions: Object.freeze([]) }),
  Object.freeze({ vendor: "n8n", kind: "agent_registry_n8n", scanner: N8N_SCANNER, readEndpoints: N8N_ENDPOINTS, governedActions: Object.freeze([]) }),
]);

export const AGENT_PLATFORM_SCANNERS: readonly Scanner[] = Object.freeze(AGENT_PLATFORM_ADAPTERS.map((a) => a.scanner));
