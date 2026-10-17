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
import type { AiSignature, AiSignatureKind, DiscoveryCredentialMode, DiscoveryReadOutcome } from "@regulait/shared";
import { REPO_SCANNERS } from "./discovery-repo-scanner.js";
import { cloudDiscoveryScanners } from "./discovery-cloud-scanners.js";
import { ENDPOINT_IMPORT_SCANNERS } from "./endpoint-discovery-scanners.js";

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
   * Optional (decision 6): NAMES only, never values: `.env.example` variable names, an MCP server's command
   * basename. At most 50, each at most 128 characters of `[A-Za-z0-9_.-]` starting with a letter or `_`.
   */
  names?: string[];
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
