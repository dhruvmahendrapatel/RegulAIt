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
 *  - call `ctx.heartbeat()` during a long scan to keep its lease, and stop when
 *    it answers false (the lease was lost; another worker owns the run);
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
import type { DiscoveryCredentialMode } from "@regulait/shared";

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
  /** digest raw output (it is hashed, never kept) */
  recordRaw: (chunk: string | Uint8Array) => void;
  /** a person's display name → the per-tenant pseudonym findings carry (`psn:` + 24 hex) */
  pseudonymise: (kind: DiscoveryPseudonymKind, displayName: string) => Promise<string>;
  /** extends the run's lease; false = the lease was lost, stop now */
  heartbeat: () => Promise<boolean>;
  /** aborted when the run's time is up */
  signal: AbortSignal;
}

/** one thing a scanner saw. Classified by the worker against the admin catalogue; it is not yet a finding. */
export interface ScanObservation {
  evidenceKind: DiscoveryEvidenceKind;
  subjectKind: DiscoverySubjectKind;
  /** the thing that would be remediated: a repo, a cloud resource or principal (pseudonymised), a device */
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
}

export interface ScanResult {
  observations: ScanObservation[];
  /**
   * What the scanner could learn about its credential's scope (decision 7):
   * `write` refuses the run (and the credential should be replaced), `read_only`
   * clears the posture row, `unverified` (or absent) leaves it.
   */
  credentialWriteScope?: "read_only" | "write" | "unverified";
}

export interface Scanner {
  kind: DiscoverySourceKind;
  /** whether a run needs a live credential (repo and cloud scanners do) */
  requiresCredential: boolean;
  run: (ctx: ScanContext) => Promise<ScanResult>;
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
 * THE PRODUCTION REGISTRY. Empty in SD0: SD1 to SD4 add their scanners here
 * (one line each), and the admin page and `POST /v1/discovery/sources` read it.
 */
export const DISCOVERY_SCANNERS: ScannerRegistry = scannerRegistry([]);

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
