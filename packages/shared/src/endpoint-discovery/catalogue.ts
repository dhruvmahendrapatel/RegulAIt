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
 * What SD0's columns cannot carry (reported to SD0, not worked around): a
 * row's OS restriction, extension ecosystem, tool id, note and confidence.
 * Dropping the OS and ecosystem only widens a match where values are already
 * OS-specific (`Claude.app`) or shared across ecosystems (chromium ids).
 */
import {
  artifactMatchesSignature,
  type AiSignature,
  type ArtifactSignatureKind,
} from "../shadow-ai.js";
import {
  ENDPOINT_SIGNATURE_SEED,
  canonicalTraitSet,
  type EndpointMatchType,
  type EndpointSignatureConfidence,
  type EndpointSignatureKind,
  type EndpointSignatureSeed,
} from "./endpoint-signatures.js";
import type { EndpointImportResult, EndpointObservation } from "./observation.js";

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

/** a seed row as an `ai_endpoint_signatures` row (SD0's `identifier` match type), plus what SD0 cannot store yet */
export interface EndpointCatalogueSignature extends AiSignature {
  kind: ArtifactSignatureKind;
  matchType: "identifier";
  /** carried for SD0; no column exists for it yet */
  confidence: EndpointSignatureConfidence;
  seedIds: string[];
}

/**
 * The SD3 seed as SD0 catalogue rows, de-duplicated on (kind, lower(value))
 * the way the seed route keys rows. A collision keeps the first row's
 * provider (the suite asserts no collision crosses providers) and the
 * lowest confidence of the merged rows.
 */
export function endpointCatalogueSignatures(seed: readonly EndpointSignatureSeed[] = ENDPOINT_SIGNATURE_SEED): EndpointCatalogueSignature[] {
  const out = new Map<string, EndpointCatalogueSignature>();
  for (const s of seed) {
    const value = endpointIdentifier(s.matchType, s.value);
    const key = `${s.kind}\u0000${value.toLowerCase()}`;
    const have = out.get(key);
    if (have) {
      have.seedIds.push(s.id);
      if (s.confidence === "low") have.confidence = "low";
      if (s.enabled) have.enabled = true;
      continue;
    }
    out.set(key, {
      provider: s.provider,
      kind: s.kind,
      value,
      matchType: "identifier",
      provenance: s.provenance,
      enabled: s.enabled,
      confidence: s.confidence,
      seedIds: [s.id],
    });
  }
  return [...out.values()];
}

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
export function endpointArtifactCandidates(obs: Pick<EndpointObservation, "keys" | "traits">): Array<{ kind: ArtifactSignatureKind; value: string }> {
  const out: Array<{ kind: ArtifactSignatureKind; value: string }> = [];
  const seen = new Set<string>();
  const push = (kind: ArtifactSignatureKind, value: string) => {
    const k = `${kind}\u0000${value.toLowerCase()}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ kind, value });
    }
  };
  for (const key of obs.keys) {
    const value = endpointIdentifier(key.matchType, key.value);
    for (const kind of KINDS_FOR[key.matchType]) push(kind, value);
  }
  const traits = [...new Set(obs.traits)].sort();
  // the trait vocabulary is closed (4 traits), so at most 15 subsets
  for (let mask = 1; mask < 1 << traits.length; mask++) {
    const subset = traits.filter((_, i) => (mask & (1 << i)) !== 0);
    for (const kind of KINDS_FOR.trait_set) push(kind, `${ENDPOINT_TRAIT_IDENTIFIER_PREFIX}${subset.join("+")}`);
  }
  return out;
}

export interface EndpointArtifactSighting {
  /** the device reference the importer produced (a pseudonym, or a request-local token the caller swaps) */
  device: string;
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
  unmatched: Array<{ device: string; kind: ArtifactSignatureKind; value: string }>;
  unmatchedCount: number;
}

/**
 * Match an import's observations against the ENABLED admin catalogue (detection
 * is data: the catalogue decides, not this code) and collapse them to one
 * sighting per device and artifact. Each observation contributes its first
 * matching candidate per provider.
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
  for (const obs of result.observations) {
    const providers = new Set<string>();
    const candidates = endpointArtifactCandidates(obs);
    for (const c of candidates) {
      const sig = enabled.find((s) => artifactMatchesSignature(c.kind, c.value, s));
      if (!sig || providers.has(sig.provider)) continue;
      providers.add(sig.provider);
      const key = `${obs.device}\u0000${c.kind}\u0000${sig.value.toLowerCase()}`;
      const have = matched.get(key);
      if (have) {
        have.count += 1;
        if (obs.observedAt && (!have.observedAt || obs.observedAt > have.observedAt)) have.observedAt = obs.observedAt;
      } else {
        matched.set(key, { device: obs.device, kind: c.kind, value: sig.value, provider: sig.provider, count: 1, observedAt: obs.observedAt });
      }
    }
    if (providers.size === 0) {
      unmatchedCount += 1;
      const first = candidates[0];
      if (first && unmatched.length < sample) {
        const k = `${first.kind}\u0000${first.value.toLowerCase()}`;
        if (!unmatchedSeen.has(k)) {
          unmatchedSeen.add(k);
          unmatched.push({ device: obs.device, kind: first.kind, value: first.value });
        }
      }
    }
  }
  return { matched: [...matched.values()], unmatched, unmatchedCount };
}
