/**
 * ADR-0195 SD0 — THE SCANNER REGISTRY INTERFACE.
 *
 * SD1 (repos), SD2 (clouds), SD3 (endpoint importers) and SD4 (the endpoint
 * agent) each add a `Scanner` for their source kinds to `DISCOVERY_SCANNERS`
 * below. SD0 ships NONE in production: the registry is empty, so no source
 * kind can be created yet, and the admin page says each kind is "not built
 * yet". The no-op scanner at the end exists for tests only.
 *
 * WHAT A SCANNER MAY DO, EXHAUSTIVELY
 *  - read the source's target and scope, and its credential (decrypted for it
 *    by the worker; never logged, never returned);
 *  - call out ONLY through `ctx.fetch`, the egress-guarded fetch (ADR-0034:
 *    allow list, DNS pinning, no redirects). A scanner never opens its own
 *    socket and never builds its own HTTP client: a cloud SDK is constructed
 *    with a transport that delegates to `ctx.fetch` (SD2's job);
 *  - call `ctx.throttle()` before every outbound request and `ctx.backoff(res)`
 *    on a 429 or 503 (the per-source rate-limit hook);
 *  - feed every raw response it reads to `ctx.recordRaw()`, which only digests
 *    it (SHA-256); raw output is never stored (decision 6);
 *  - turn any person's display name into a pseudonym with `ctx.pseudonymise()`
 *    before it goes anywhere near an observation (decision 20);
 *  - rely on the worker for its lease: the worker renews the run's lease on
 *    its own every third of the lease period for as long as `run` is pending,
 *    independently of the scheduler job's lease, so a long scan is never
 *    re-taken while its worker lives. `ctx.heartbeat()` renews it at once and
 *    answers false when the lease was lost; on that, or when `ctx.signal`
 *    aborts (lease lost, or the run's maximum duration), stop: another worker
 *    owns the run and nothing this one returns is written;
 *  - return OBSERVATIONS. It never writes a finding, never names a provider as
 *    a verdict, and never decides severity: the worker classifies each
 *    observation against this deployment's enabled admin catalogue (detection
 *    is data, decision 5), and an unmatched observation is a catalogue gap.
 *
 * WHAT A SCANNER MUST NEVER DO: write to, change or delete anything in a
 * scanned system (decision 1); store or return file contents, prompts or
 * responses, or a full secret (a key is reported only as its 8-character
 * prefix and length); or call a provider to test a key it found (decision 6).
 */
import type { DiscoveryEvidenceKind, DiscoveryPseudonymKind, DiscoverySourceKind, DiscoverySubjectKind, ArtifactSignatureKind } from "@regulait/shared";
import type { AgentRegistry, AiSignature, AiSignatureKind, DiscoveryCredentialMode, DiscoveryReadOutcome, LabelDefinition, RegistryComponentKind, RegistryComponentProvider, SaasEntitlementBatch } from "@regulait/shared";
import { REPO_SCANNERS } from "./discovery-repo-scanner.js";
import { cloudDiscoveryScanners } from "./discovery-cloud-scanners.js";
import { ENDPOINT_AGENT_SCANNER, ENDPOINT_IMPORT_SCANNERS } from "./endpoint-discovery-scanners.js";
import { WIDER_DISCOVERY_SCANNERS } from "./discovery-wider-scanners.js";
import { SAAS_ENTITLEMENT_SCANNERS } from "./saas-entitlement-readers.js";
import { AGENT_PLATFORM_SCANNERS } from "./agent-platform-adapters.js";

/** the source as a scanner sees it */
export interface ScanSource {
  id: string;
  name: string;
  kind: DiscoverySourceKind;
  target: Readonly<Record<string, string>>;
  scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>;
}

/** the source's live credential, decrypted for this run only */
export interface ScanCredential {
  mode: DiscoveryCredentialMode;
  publicConfig: Readonly<Record<string, string>>;
  /** null for a federated credential (it has no secret part) */
  secret: string | null;
}

export interface ScanContext {
  source: ScanSource;
  /** null when the source has no live credential (only for a scanner with `requiresCredential: false`) */
  credential: ScanCredential | null;
  /** the ONLY network access a scanner gets: the egress-guarded fetch */
  fetch: typeof fetch;
  /** the per-source rate-limit hook: await it before every outbound request */
  throttle: () => Promise<void>;
  /** on 429/503: waits the bounded Retry-After and answers true when the caller should retry, false to give up */
  backoff: (res: Response) => Promise<boolean>;
  /**
   * register a short-lived secret the scanner obtained (a federated access token, a signed URL) so that any error
   * text or read-outcome detail carrying it is scrubbed before it is stored. The source's own secret is registered
   * already.
   */
  registerSecret: (value: string) => void;
  /** digest raw output (it is hashed, never kept) */
  recordRaw: (chunk: string | Uint8Array) => void;
  /** a person's display name → the per-tenant pseudonym findings carry (`psn:` + 24 hex) */
  pseudonymise: (kind: DiscoveryPseudonymKind, displayName: string) => Promise<string>;
  /** extends the run's lease; false = the lease was lost, stop now */
  heartbeat: () => Promise<boolean>;
  /** aborted when the run's maximum duration is reached or its lease was lost */
  signal: AbortSignal;
  /** read-only: the enabled admin catalogue (see ScanCatalogue) */
  catalogue: ScanCatalogue;
  /**
   * ADR-0195 SD2b: RegulAIt's federation issuer, for a FEDERATED credential only (absent otherwise). Each call mints
   * a fresh RS256 token of at most 5 minutes; it fails when federation is off.
   */
  federation?: ScanFederation;
}

/** ADR-0195 SD2b: the federation tokens a run may mint (built by the worker from the source and its credential) */
export interface ScanFederation {
  /** a token whose `sub` is this source (`regulait:discovery-source:<id>`), only for an audience its credential names */
  sourceToken: (audience: string) => Promise<string>;
  /** RegulAIt's own AWS principal, when the deployment configures one: its role and a token for it (aud sts.amazonaws.com) */
  awsPrincipal: { roleArn: string; token: (audience: string) => Promise<string> } | null;
}

/** one thing a scanner saw. Classified by the worker against the admin catalogue; it is not yet a finding. */
export interface ScanObservation {
  evidenceKind: DiscoveryEvidenceKind;
  subjectKind: DiscoverySubjectKind;
  /**
   * the thing that would be remediated: a repo, a cloud resource, a cloud principal or a device. A
   * `cloud_principal` or `device` subject MUST be a pseudonym from `ctx.pseudonymise` (`psn:` + 24 hex; a device's
   * name with kind `device`, a principal's with `cloud_principal`); anything else is refused
   */
  subject: string;
  /** ISO time it was seen (default: now) */
  observedAt?: string;
  count?: number;
  host?: string;
  packageName?: string;
  /** at most the first 8 characters are kept, whatever is sent */
  keyFragment?: string;
  keyLength?: number;
  artifact?: { kind: ArtifactSignatureKind; value: string };
  /**
   * Optional (decision 6): where it was found. `path` at most 512 characters, normalised (forward slashes, no
   * leading `./` or `/`, no `..` segment); `line` 1 to 10,000,000; `commit` 7 to 64 hex. Never file contents.
   */
  location?: { path: string; line?: number; commit?: string };
  /**
   * Optional (decision 6): NAMES only, never values: an MCP server's command basename. At most 50, each at most 128
   * characters of `[A-Za-z0-9_.-]` starting with a letter or `_`. An environment-variable-shaped name
   * (`^[A-Z][A-Z0-9_]*$`) is refused: env names are never stored (ADR-0195 lane A6); send `presence` instead.
   */
  names?: string[];
  /**
   * Optional (ADR-0195 lane A6): the ids of the presence signatures the sighting matched (`envNamePresenceInText`,
   * `matchEnvNames`, `matchCliNames`), never the names. At most 50; an unknown id is refused.
   */
  presence?: string[];
  /** Optional (decision 20): the person behind the sighting, from `ctx.pseudonymise` (`psn:` + 24 hex) */
  actorPseudonym?: string;
  /** Optional: the OS the sighting came from; a catalogue row scoped to an OS matches only it */
  os?: "macos" | "windows" | "linux";
  /** Optional: the package ecosystem (npm, pypi…); a catalogue row scoped to an ecosystem matches only it */
  ecosystem?: string;
}

/**
 * Read-only access to this deployment's ENABLED admin catalogue (decision 5). A scanner may use it to keep an
 * observation only an admin-added row would match (for example an in-house package name); detection itself still
 * happens in the worker's matcher, and a scanner never decides a finding.
 */
export interface ScanCatalogue {
  /** would this observation match an enabled catalogue row? */
  matches: (observation: ScanObservation) => boolean;
  /** the enabled rows of the given signature kinds (provider, kind, value, match type), read-only */
  rows: (kinds?: readonly AiSignatureKind[]) => ReadonlyArray<Readonly<Pick<AiSignature, "provider" | "kind" | "value" | "matchType" | "minLength">>>;
}

export interface ScanResult {
  observations: ScanObservation[];
  /**
   * What the scanner could learn about its credential's scope (decision 7):
   * `write` refuses the run and marks the credential `refused` (never used
   * again; the source cannot be enabled or run until it is replaced),
   * `read_only` clears the posture row, `unverified` (or absent) leaves it.
   */
  credentialWriteScope?: "read_only" | "write" | "unverified";
  /**
   * Optional: each read the scanner attempted and what came of it (for
   * example "CloudTrail data events: not_enabled"), stored with the run and
   * shown on the run list as "could not read: …". At most 100; `read` at most
   * 200 characters, `detail` at most 500, and `detail` is scrubbed (known
   * secrets, credential shapes, URL query strings) before it is stored.
   */
  readOutcomes?: DiscoveryReadOutcome[];
  /**
   * ADR-0337: an entitlement reader's graph (only a kind whose spec says `entitlements`; anything else is refused).
   * The worker checks it and stores it in the run's own transaction.
   */
  entitlements?: SaasEntitlementBatch;
  /**
   * ADR-0314 (G6): an `agent_registry_*` scanner's agents, staged by the worker in `agent_registry_records` (never
   * findings). Only the registries `AGENT_REGISTRIES_BY_KIND` names for the source's kind are accepted.
   */
  registryAgents?: RegistryAgentRecord[];
  /**
   * ADR-0314: the registries this run read COMPLETELY (no page, item or region cap hit and no read failed). Only for
   * these does the worker mark a staged record the run did not list as absent; a partial read never does.
   */
  registriesComplete?: AgentRegistry[];
  /**
   * ADR-0363 slice 1, `idp_entra` only: the tenant's complete sensitivity-label list. Absent when it was not read (no
   * permission, or a listing cut short), which leaves the stored definitions as they are.
   */
  labelDefinitions?: LabelDefinition[];
}

/** ADR-0314: one agent a vendor registry listed, as a scanner reports it (bounded and shape-checked by the worker) */
export interface RegistryAgentRecord {
  registry: AgentRegistry;
  /** the vendor's id: an Entra object id, a Gemini resource name, an AgentCore runtime ARN (1 to 2048 characters) */
  externalId: string;
  /** 1 to 256 characters */
  displayName: string;
  /** at most 1000 characters */
  description?: string | null;
  /**
   * A bounded, verbatim subset of the vendor's record: at most 16 keys of `[a-zA-Z][a-zA-Z0-9_]{0,39}`, each a
   * string (at most 512 characters), a boolean, null, or a list of at most 20 strings. People only as pseudonyms
   * (`ctx.pseudonymise`), never names or emails.
   */
  attributes?: Record<string, string | string[] | boolean | null>;
  /**
   * ADR-0336 decision 3: what the agent uses, staged in `agent_registry_record_components`. Set ONLY when the adapter
   * read this agent's components completely; the worker then replaces the stored set (an empty list clears it).
   * Undefined after a partial read: the stored set is kept as it is. Never secrets, instructions or prompt text.
   */
  components?: RegistryAgentComponent[];
}

/** one thing a staged agent uses (ADR-0336 decision 3); every field bounded by `checkRegistryAgents` */
export interface RegistryAgentComponent {
  kind: RegistryComponentKind;
  /** the vendor's own reference: a connector id, a component id, a model name (1 to 512 characters) */
  vendorRef: string;
  /** 1 to 256 characters */
  displayName: string;
  /** whether the vendor reports it switched on; null when it does not say */
  enabled?: boolean | null;
  /** who supplies a connected app's connection; null when the vendor does not say */
  providedBy?: RegistryComponentProvider | null;
}

export interface Scanner {
  kind: DiscoverySourceKind;
  /** whether a run needs a live credential (repo and cloud scanners do) */
  requiresCredential: boolean;
  run: (ctx: ScanContext) => Promise<ScanResult>;
  /**
   * Optional (secure by default): shape-check a source's target and scope for
   * this kind. Null when acceptable, else the problem. The create and PATCH
   * routes refuse what it rejects (400 `target_invalid`) before anything is written.
   */
  validateTarget?: (target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>) => string | null;
}

export type ScannerRegistry = ReadonlyMap<DiscoverySourceKind, Scanner>;

export function scannerRegistry(scanners: readonly Scanner[]): ScannerRegistry {
  const map = new Map<DiscoverySourceKind, Scanner>();
  for (const s of scanners) {
    if (map.has(s.kind)) throw new Error(`duplicate discovery scanner for kind ${s.kind}`);
    map.set(s.kind, s);
  }
  return map;
}

/**
 * THE PRODUCTION REGISTRY. SD0 shipped it empty; SD1 to SD4 add their scanners here
 * (one line each), and the admin page and `POST /v1/discovery/sources` read it.
 */
export const DISCOVERY_SCANNERS: ScannerRegistry = scannerRegistry([
  // SD1: repo_github, repo_gitlab, repo_bitbucket, repo_azure_devops
  ...REPO_SCANNERS,
  // SD2: cloud_aws, cloud_gcp, cloud_azure
  ...cloudDiscoveryScanners(),
  // SD3: endpoint_osquery, endpoint_inventory, the no-agent endpoint kinds fed by upload (endpoint-import-routes.ts)
  ...ENDPOINT_IMPORT_SCANNERS,
  // SD4b: endpoint_agent, fed by the agents' signed reports (endpoint-agent-routes.ts)
  ENDPOINT_AGENT_SCANNER,
  // ADR-0235 (P9): saas_inventory_api, idp_entra, ml_mlflow, each family behind its default-off org switch
  ...WIDER_DISCOVERY_SCANNERS,
  // ADR-0337 (E18): entitlement_m365, entitlement_google_workspace (Salesforce and Slack follow in slice 2)
  ...SAAS_ENTITLEMENT_SCANNERS,
  // ADR-0314 (G6) and ADR-0336 (E17): the agent_registry family, built from the one agent platform adapter list
  // (agent_registry_entra, agent_registry_gemini, agent_registry_agentcore, agent_registry_copilot_studio, agent_registry_agentforce, agent_registry_openai, agent_registry_n8n)
  ...AGENT_PLATFORM_SCANNERS,
]);

/**
 * TEST ONLY: a scanner that calls nothing and reports the observations it was
 * given (none by default). Never registered in `DISCOVERY_SCANNERS`.
 */
export function noopTestScanner(
  kind: DiscoverySourceKind,
  observations: readonly ScanObservation[] = [],
  opts: { requiresCredential?: boolean; credentialWriteScope?: ScanResult["credentialWriteScope"] } = {},
): Scanner {
  return {
    kind,
    requiresCredential: opts.requiresCredential ?? false,
    run: async (ctx) => {
      ctx.recordRaw(JSON.stringify(observations));
      return {
        observations: [...observations],
        ...(opts.credentialWriteScope ? { credentialWriteScope: opts.credentialWriteScope } : {}),
      };
    },
  };
}
