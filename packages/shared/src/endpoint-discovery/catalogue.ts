/**
 * ADR-0195 SD3 phase B — the bridge between SD3's endpoint vocabulary and
 * SD0's catalogue model.
 *
 * SD0 matches an artifact as `{kind, value}` against an `ai_endpoint_signatures`
 * row of the SAME kind with match type `identifier`: whole-value,
 * case-insensitive equality (`artifactMatchesSignature`). SD3's richer match
 * types are therefore folded into one identifier space per kind:
 *
 *   app_name, bundle_id, executable_name, cli_binary, npm_package,
 *   process_name, ide_extension_id, browser_extension_id,
 *   env_var_name, config_path          the value itself
 *   listening_port                     `port:<n>`
 *   trait_set                          `trait:<canonical sorted set>`
 *
 * SD0's catalogue columns carry the rest: `os` (one OS, or null for any; a row
 * that SD3 scopes to two OSes is stored as any), `ecosystem` (extension rows:
 * `vscode`, `jetbrains`, `firefox`, `safari`, and `chromium` for Chrome and Edge,
 * which share one id space), `tool_id`, `note` and `confidence`. SD0's matcher
 * applies os/ecosystem: a scoped row matches only an observation that carries
 * the same OS or ecosystem, so this module scopes the same way.
 */
import {
  artifactMatchesSignature,
  type AiSignature,
  type ArtifactSignatureKind,
  type SignatureOs,
} from "../shadow-ai.js";
import {
  ENDPOINT_SIGNATURE_SEED,
  canonicalTraitSet,
  type EndpointExtensionEcosystem,
  type EndpointMatchType,
  type EndpointOs,
  type EndpointSignatureKind,
  type EndpointSignatureSeed,
} from "./endpoint-signatures.js";
import type { EndpointImportResult, EndpointObservation } from "./observation.js";
import { scrubAuditText } from "../audit-scrub.js";

export const ENDPOINT_PORT_IDENTIFIER_PREFIX = "port:";
export const ENDPOINT_TRAIT_IDENTIFIER_PREFIX = "trait:";

/** the provenance prefix of rows imported from the pinned registry (shipped rows, refreshable by the seed route) */
export const ENDPOINT_REGISTRY_PROVENANCE_PREFIX = "Apache-2.0; https://github.com/AmanSK5/shadow-ai-guard@";

/** is this provenance one RegulAIt ships (so re-seeding may refresh the row)? An admin edit sets `admin`. */
export function isShippedEndpointProvenance(provenance: string): boolean {
  return provenance === "regulait-seed" || provenance.startsWith(ENDPOINT_REGISTRY_PROVENANCE_PREFIX);
}

/** the SD0 identifier for an SD3 (matchType, value) pair */
export function endpointIdentifier(matchType: EndpointMatchType, value: string): string {
  if (matchType === "listening_port") return `${ENDPOINT_PORT_IDENTIFIER_PREFIX}${Number(value)}`;
  if (matchType === "trait_set") return `${ENDPOINT_TRAIT_IDENTIFIER_PREFIX}${canonicalTraitSet(value.split("+"))}`;
  return value;
}

/** SD3's OS name -> SD0's */
export function endpointOsToSignatureOs(os: EndpointOs | null): SignatureOs | null {
  if (os === null) return null;
  return os === "darwin" ? "macos" : os;
}

/** SD3's extension ecosystem -> SD0's ecosystem column (Chrome and Edge share one id space) */
export function endpointEcosystemToSignature(eco: EndpointExtensionEcosystem | null | undefined): string | null {
  if (!eco) return null;
  return eco === "chrome" || eco === "edge" ? "chromium" : eco;
}

/** a seed row as an `ai_endpoint_signatures` row (SD0's `identifier` match type and columns) */
export interface EndpointCatalogueSignature extends AiSignature {
  kind: ArtifactSignatureKind;
  matchType: "identifier";
  os: SignatureOs | null;
  ecosystem: string | null;
  toolId: string;
  note: string | null;
  confidence: NonNullable<AiSignature["confidence"]>;
  seedIds: string[];
}

/**
 * The SD3 seed as SD0 catalogue rows, de-duplicated on (kind, lower(value))
 * the way the seed route keys rows. A collision keeps the first row's
 * provider, tool and note (the suite asserts no collision crosses providers),
 * widens os/ecosystem to "any" where the merged rows differ, and keeps the
 * lowest confidence.
 */
export function endpointCatalogueSignatures(seed: readonly EndpointSignatureSeed[] = ENDPOINT_SIGNATURE_SEED): EndpointCatalogueSignature[] {
  const out = new Map<string, EndpointCatalogueSignature>();
  for (const s of seed) {
    const value = endpointIdentifier(s.matchType, s.value);
    const key = `${s.kind}\u0000${value.toLowerCase()}`;
    const os = s.os !== null && s.os.length === 1 ? endpointOsToSignatureOs(s.os[0]!) : null;
    const ecosystem = endpointEcosystemToSignature(s.ecosystem);
    const have = out.get(key);
    if (have) {
      have.seedIds.push(s.id);
      if (CONFIDENCE_RANK[s.confidence] < CONFIDENCE_RANK[have.confidence]) have.confidence = s.confidence;
      if (s.enabled) have.enabled = true;
      if (have.os !== os) have.os = null;
      if (have.ecosystem !== ecosystem) have.ecosystem = null;
      continue;
    }
    out.set(key, {
      provider: s.provider,
      kind: s.kind,
      value,
      matchType: "identifier",
      provenance: s.provenance,
      enabled: s.enabled,
      os,
      ecosystem,
      toolId: s.tool,
      note: s.note,
      confidence: s.confidence,
      seedIds: [s.id],
    });
  }
  return [...out.values()];
}

const CONFIDENCE_RANK: Readonly<Record<NonNullable<AiSignature["confidence"]>, number>> = { low: 0, medium: 1, high: 2 };

/** which artifact kinds a key of each SD3 match type may be compared against */
const KINDS_FOR: Readonly<Record<EndpointMatchType, readonly EndpointSignatureKind[]>> = {
  app_name: ["desktop_app", "local_runtime"],
  bundle_id: ["desktop_app", "local_runtime"],
  executable_name: ["desktop_app", "local_runtime"],
  cli_binary: ["desktop_app", "local_runtime"],
  npm_package: ["desktop_app", "local_runtime"],
  process_name: ["desktop_app", "local_runtime"],
  ide_extension_id: ["ide_extension"],
  browser_extension_id: ["browser_extension"],
  listening_port: ["local_runtime"],
  env_var_name: ["assistant_config", "local_runtime"],
  config_path: ["assistant_config", "local_runtime"],
  trait_set: ["local_runtime", "desktop_app"],
};

/** every (kind, identifier) an observation could be matched as. Traits yield each non-empty subset of the observed set. */
export function endpointArtifactCandidates(
  obs: Pick<EndpointObservation, "keys" | "traits">,
): Array<{ kind: ArtifactSignatureKind; value: string; ecosystem: string | null; from: EndpointMatchType }> {
  const out: Array<{ kind: ArtifactSignatureKind; value: string; ecosystem: string | null; from: EndpointMatchType }> = [];
  const seen = new Set<string>();
  const push = (kind: ArtifactSignatureKind, value: string, from: EndpointMatchType, ecosystem: string | null = null) => {
    const k = `${kind}\u0000${value.toLowerCase()}\u0000${ecosystem ?? ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ kind, value, ecosystem, from });
    }
  };
  for (const key of obs.keys) {
    const value = endpointIdentifier(key.matchType, key.value);
    for (const kind of KINDS_FOR[key.matchType]) push(kind, value, key.matchType, endpointEcosystemToSignature(key.ecosystem));
  }
  const traits = [...new Set(obs.traits)].sort();
  // the trait vocabulary is closed (4 traits), so at most 15 subsets
  for (let mask = 1; mask < 1 << traits.length; mask++) {
    const subset = traits.filter((_, i) => (mask & (1 << i)) !== 0);
    for (const kind of KINDS_FOR.trait_set) push(kind, `${ENDPOINT_TRAIT_IDENTIFIER_PREFIX}${subset.join("+")}`, "trait_set");
  }
  return out;
}

export interface EndpointArtifactSighting {
  /** the device reference the importer produced (a pseudonym, or a request-local token the caller swaps) */
  device: string;
  /** the device-user reference the importer produced, when the row named one */
  user: string | null;
  /** SD0's OS name, when the observation's OS is known */
  os: SignatureOs | null;
  /** SD0's ecosystem, for an extension sighting */
  ecosystem: string | null;
  kind: ArtifactSignatureKind;
  value: string;
  provider: string;
  count: number;
  observedAt: string | null;
}

export interface EndpointReduction {
  /** one entry per (device, kind, identifier) that matched an enabled catalogue row */
  matched: EndpointArtifactSighting[];
  /** observations no enabled row matched: a bounded sample, for the run's catalogue gaps */
  unmatched: Array<{ device: string; os: SignatureOs | null; kind: ArtifactSignatureKind; value: string }>;
  unmatchedCount: number;
  /** distinct values the audit scrubber would change (a credential shape): never matched, sampled or sent on */
  credentialShapedDropped: number;
}

/**
 * Match an import's observations against the ENABLED admin catalogue (detection
 * is data: the catalogue decides, not this code) and collapse them to one
 * sighting per device, device user and artifact. Each observation contributes
 * its first matching candidate per provider. A row scoped to an OS or an
 * ecosystem matches only a sighting with the same one, exactly as SD0's
 * classifier decides (`classifyObservation`).
 */
export function reduceEndpointObservations(
  result: Pick<EndpointImportResult, "observations">,
  catalogue: readonly AiSignature[],
  opts: { unmatchedSample?: number } = {},
): EndpointReduction {
  const enabled = catalogue.filter((s) => s.enabled && s.matchType === "identifier");
  const sample = opts.unmatchedSample ?? 50;
  const matched = new Map<string, EndpointArtifactSighting>();
  const unmatched: EndpointReduction["unmatched"] = [];
  const unmatchedSeen = new Set<string>();
  let unmatchedCount = 0;
  // counted as distinct values (one value is tried as several artifact kinds)
  const droppedValues = new Set<string>();
  for (const obs of result.observations) {
    const providers = new Set<string>();
    const os = endpointOsToSignatureOs(obs.os);
    // SD0 refuses an observation whose text the audit scrubber would change; such a value is likely a secret
    // someone placed in a name column, so it is dropped here, counted, and never matched, sampled or stored
    const all = endpointArtifactCandidates(obs);
    const candidates = all.filter((c) => {
      if (scrubAuditText(c.value) === c.value) return true;
      droppedValues.add(c.value);
      return false;
    });
    for (const c of candidates) {
      const sig = enabled.find(
        (s) =>
          (s.os == null || s.os === os) &&
          (s.ecosystem == null || s.ecosystem.toLowerCase() === c.ecosystem) &&
          artifactMatchesSignature(c.kind, c.value, s),
      );
      if (!sig || providers.has(sig.provider)) continue;
      providers.add(sig.provider);
      const key = `${obs.device}\u0000${obs.user ?? ""}\u0000${os ?? ""}\u0000${c.ecosystem ?? ""}\u0000${c.kind}\u0000${sig.value.toLowerCase()}`;
      const have = matched.get(key);
      if (have) {
        have.count += 1;
        if (obs.observedAt && (!have.observedAt || obs.observedAt > have.observedAt)) have.observedAt = obs.observedAt;
      } else {
        matched.set(key, {
          device: obs.device,
          user: obs.user,
          os,
          ecosystem: c.ecosystem,
          kind: c.kind,
          value: sig.value,
          provider: sig.provider,
          count: 1,
          observedAt: obs.observedAt,
        });
      }
    }
    if (providers.size === 0) {
      unmatchedCount += 1;
      // an environment variable name is never recorded as a gap: an unmatched "name" may be a value someone aliased
      const first = candidates.find((c) => c.from !== "env_var_name");
      if (first && unmatched.length < sample) {
        const k = `${first.kind}\u0000${first.value.toLowerCase()}`;
        if (!unmatchedSeen.has(k)) {
          unmatchedSeen.add(k);
          unmatched.push({ device: obs.device, os, kind: first.kind, value: first.value });
        }
      }
    }
  }
  return { matched: [...matched.values()], unmatched, unmatchedCount, credentialShapedDropped: droppedValues.size };
}
