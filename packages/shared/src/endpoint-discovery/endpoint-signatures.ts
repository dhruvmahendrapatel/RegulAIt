/**
 * ADR-0195 SD3 — ENDPOINT SIGNATURE SEED (decision 5: detection is data).
 *
 * The seed rows SD3 contributes for the five endpoint signature kinds. They are
 * DATA for `ai_endpoint_signatures` (installed by SD0's seed route, then
 * editable like any admin row); they are not the matcher, and they are not the
 * compiled catalogue (SD1 owns `SHADOW_AI_CATALOG_V2`; nothing here edits V1).
 *
 * Two origins, recorded per row:
 *   - `third_party`: imported from a pinned, Apache-2.0 AI tool registry
 *     (`./vendor/ai-tool-registry`, PROVENANCE.json pins commit and digests;
 *     the NOTICE travels with it). Each row names the upstream entry.
 *   - `regulait`: written by us — local runtime process names and default
 *     ports, AI CLI npm packages, and TRAIT signatures for hidden or evasive
 *     assistants (no visible window, LAN remote control; ADR-0195 open-source
 *     evaluation: the traits are ours, no upstream code or data is used).
 *
 * Matching is character comparison only. No value here is a regular
 * expression, and no matcher evaluates one (ADR-0055 "no regex from data").
 */
import { z } from "zod";
import { ENDPOINT_REGISTRY_SIGNATURE_ROWS, ENDPOINT_REGISTRY_SOURCE_COMMIT } from "./registry-signatures.generated.js";

/** ADR-0195 decision 5: the five endpoint kinds SD0 adds to `ai_endpoint_signatures.kind`. */
export const ENDPOINT_SIGNATURE_KINDS = [
  "desktop_app",
  "ide_extension",
  "browser_extension",
  "local_runtime",
  "assistant_config",
] as const;
export type EndpointSignatureKind = (typeof ENDPOINT_SIGNATURE_KINDS)[number];

/**
 * How a row is compared with an observation. Every one is an exact,
 * case-insensitive string comparison except:
 *   - `config_path`: the home-relative path (after the home directory segment
 *     is removed) equals the value, separators normalised to `/`;
 *   - `listening_port`: the decimal port equals the value;
 *   - `trait_set`: every `+`-separated trait in the value is present on the
 *     observation (traits are a closed vocabulary, `ENDPOINT_TRAITS`).
 */
export const ENDPOINT_MATCH_TYPES = [
  "app_name",
  "bundle_id",
  "executable_name",
  "cli_binary",
  "npm_package",
  "process_name",
  "ide_extension_id",
  "browser_extension_id",
  "listening_port",
  "env_var_name",
  "config_path",
  "trait_set",
] as const;
export type EndpointMatchType = (typeof ENDPOINT_MATCH_TYPES)[number];

export const ENDPOINT_OSES = ["darwin", "windows", "linux"] as const;
export type EndpointOs = (typeof ENDPOINT_OSES)[number];

export const ENDPOINT_EXTENSION_ECOSYSTEMS = ["vscode", "jetbrains", "chrome", "edge", "firefox", "safari"] as const;
export type EndpointExtensionEcosystem = (typeof ENDPOINT_EXTENSION_ECOSYSTEMS)[number];

/**
 * Traits an importer may attach to an observation. Computed from columns the
 * pack collects; never from content.
 *   - `listen_all_interfaces`: a listening socket bound to 0.0.0.0 or :: (reachable from the LAN)
 *   - `user_writable_path`: the executable lives under a user's home or a temp directory
 *   - `hidden_path`: a path segment starts with `.` (a hidden directory)
 *   - `background_agent`: a macOS app that declares itself a background agent (no Dock icon, no menu bar)
 */
export const ENDPOINT_TRAITS = [
  "listen_all_interfaces",
  "user_writable_path",
  "hidden_path",
  "background_agent",
] as const;
export type EndpointTrait = (typeof ENDPOINT_TRAITS)[number];

/** Endpoint evidence retention default, in days (ADR-0195 decision 20). Lengthening it is a relaxation. */
export const ENDPOINT_EVIDENCE_DEFAULT_RETENTION_DAYS = 90;

/** a row exactly as the generator writes it from the vendored registry */
export interface EndpointRegistrySignatureRow {
  id: string;
  provider: string;
  tool: string;
  kind: EndpointSignatureKind;
  matchType: EndpointMatchType;
  value: string;
  os: EndpointOs[] | null;
  ecosystem: EndpointExtensionEcosystem | null;
  enabled: boolean;
  note: string | null;
  /** the upstream registry entry id */
  entry: string;
}

export type EndpointSignatureSource =
  | { origin: "regulait" }
  | { origin: "third_party"; repo: string; commit: string; path: string; entry: string; licence: "Apache-2.0" };

export interface EndpointSignatureSeed {
  /** stable id, also the ledger tag a finding carries */
  id: string;
  provider: string;
  /** the tool this row detects (a registry id, or our own label) */
  tool: string;
  kind: EndpointSignatureKind;
  matchType: EndpointMatchType;
  value: string;
  /** null = any OS */
  os: EndpointOs[] | null;
  /** extension rows only */
  ecosystem: EndpointExtensionEcosystem | null;
  enabled: boolean;
  note: string | null;
  source: EndpointSignatureSource;
  /** fits `ai_endpoint_signatures.provenance` (max 300 characters) */
  provenance: string;
}

const REGISTRY_REPO = "https://github.com/AmanSK5/shadow-ai-guard";
const REGISTRY_PATH = "registry/registry.yaml";

/** Rows written by us. Values are documented defaults or names, not guesses dressed up as facts. */
const OWN_ROWS: ReadonlyArray<Omit<EndpointSignatureSeed, "source" | "provenance">> = [
  // --- local model runtimes: process names and documented default ports --------------------------
  { id: "rgl.ollama.process_name.ollama", provider: "ollama", tool: "ollama", kind: "local_runtime", matchType: "process_name", value: "ollama", os: null, ecosystem: null, enabled: true, note: "Ollama server or CLI process." },
  { id: "rgl.ollama.listening_port.11434", provider: "ollama", tool: "ollama", kind: "local_runtime", matchType: "listening_port", value: "11434", os: null, ecosystem: null, enabled: true, note: "Ollama's default API port. Another program can use the same port; the process name in the same observation tells them apart." },
  { id: "rgl.lm-studio.process_name.lms", provider: "element-labs", tool: "lm-studio", kind: "local_runtime", matchType: "process_name", value: "lms", os: null, ecosystem: null, enabled: true, note: "LM Studio command-line tool." },
  { id: "rgl.lm-studio.listening_port.1234", provider: "element-labs", tool: "lm-studio", kind: "local_runtime", matchType: "listening_port", value: "1234", os: null, ecosystem: null, enabled: true, note: "LM Studio's default local server port. Another program can use the same port." },
  { id: "rgl.llama-cpp.process_name.llama-server", provider: "llama-cpp", tool: "llama-cpp", kind: "local_runtime", matchType: "process_name", value: "llama-server", os: null, ecosystem: null, enabled: true, note: "llama.cpp HTTP server binary." },
  { id: "rgl.llama-cpp.cli_binary.llama-server", provider: "llama-cpp", tool: "llama-cpp", kind: "local_runtime", matchType: "cli_binary", value: "llama-server", os: null, ecosystem: null, enabled: true, note: "llama.cpp HTTP server binary installed on the path." },
  // --- AI CLIs installed as global npm packages --------------------------------------------------
  { id: "rgl.claude-code.npm_package.anthropic-ai-claude-code", provider: "anthropic", tool: "claude-code", kind: "desktop_app", matchType: "npm_package", value: "@anthropic-ai/claude-code", os: null, ecosystem: null, enabled: true, note: "AI coding CLI installed globally with npm." },
  { id: "rgl.codex-cli.npm_package.openai-codex", provider: "openai", tool: "codex-cli", kind: "desktop_app", matchType: "npm_package", value: "@openai/codex", os: null, ecosystem: null, enabled: true, note: "AI coding CLI installed globally with npm." },
  { id: "rgl.gemini-cli.npm_package.google-gemini-cli", provider: "google", tool: "gemini-cli", kind: "desktop_app", matchType: "npm_package", value: "@google/gemini-cli", os: null, ecosystem: null, enabled: true, note: "AI coding CLI installed globally with npm." },
  // --- traits of hidden or evasive assistants (ours) ---------------------------------------------
  { id: "rgl.hidden-assistant.trait_set.lan-listener-hidden-dir", provider: "unattributed", tool: "hidden-assistant-trait", kind: "local_runtime", matchType: "trait_set", value: "listen_all_interfaces+hidden_path", os: null, ecosystem: null, enabled: true, note: "A program run from a hidden directory accepts connections from the network: the shape of a remote-controlled assistant. A lead, not proof of AI use." },
  { id: "rgl.hidden-assistant.trait_set.lan-listener-user-dir", provider: "unattributed", tool: "hidden-assistant-trait", kind: "local_runtime", matchType: "trait_set", value: "listen_all_interfaces+user_writable_path", os: null, ecosystem: null, enabled: true, note: "A program run from a user or temp directory accepts connections from the network. Developer servers share this shape; a lead, not proof of AI use." },
  { id: "rgl.hidden-assistant.trait_set.windowless-user-app", provider: "unattributed", tool: "hidden-assistant-trait", kind: "desktop_app", matchType: "trait_set", value: "background_agent+user_writable_path", os: ["darwin"], ecosystem: null, enabled: true, note: "A user-installed macOS app with no Dock icon or window: the shape of an assistant built to stay out of sight. A lead, not proof of AI use." },
];

function registryRowToSeed(r: EndpointRegistrySignatureRow): EndpointSignatureSeed {
  return {
    id: r.id,
    provider: r.provider,
    tool: r.tool,
    kind: r.kind,
    matchType: r.matchType,
    value: r.value,
    os: r.os,
    ecosystem: r.ecosystem,
    enabled: r.enabled,
    note: r.note,
    source: {
      origin: "third_party",
      repo: REGISTRY_REPO,
      commit: ENDPOINT_REGISTRY_SOURCE_COMMIT,
      path: REGISTRY_PATH,
      entry: r.entry,
      licence: "Apache-2.0",
    },
    provenance: `Apache-2.0; ${REGISTRY_REPO}@${ENDPOINT_REGISTRY_SOURCE_COMMIT}:${REGISTRY_PATH}#${r.entry}`,
  };
}

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as object)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

/** The complete SD3 seed: imported rows first, then ours. Frozen. */
export const ENDPOINT_SIGNATURE_SEED: ReadonlyArray<EndpointSignatureSeed> = deepFreeze([
  ...ENDPOINT_REGISTRY_SIGNATURE_ROWS.map(registryRowToSeed),
  ...OWN_ROWS.map((r) => ({ ...r, source: { origin: "regulait" } as const, provenance: "regulait-seed" })),
]);

/** characters a value may hold: printable ASCII minus quote and backslash, so it is safe in SQL literals */
const isSafeValueChar = (c: string) => c >= " " && c <= "~" && c !== "'" && c !== "\\" && c !== '"';

export const endpointSignatureSeedSchema = z
  .object({
    id: z.string().min(3).max(80),
    provider: z.string().min(2).max(100),
    tool: z.string().min(2).max(100),
    kind: z.enum(ENDPOINT_SIGNATURE_KINDS),
    matchType: z.enum(ENDPOINT_MATCH_TYPES),
    value: z
      .string()
      .min(1)
      .max(253)
      .refine((v) => [...v].every(isSafeValueChar), { message: "a value is printable ASCII with no quotes or backslashes" }),
    os: z.array(z.enum(ENDPOINT_OSES)).min(1).nullable(),
    ecosystem: z.enum(ENDPOINT_EXTENSION_ECOSYSTEMS).nullable(),
    enabled: z.boolean(),
    note: z.string().max(500).nullable(),
    source: z.union([
      z.object({ origin: z.literal("regulait") }).strict(),
      z
        .object({
          origin: z.literal("third_party"),
          repo: z.string().url(),
          commit: z.string().length(40),
          path: z.string().min(1),
          entry: z.string().min(1),
          licence: z.literal("Apache-2.0"),
        })
        .strict(),
    ]),
    provenance: z.string().min(1).max(300),
  })
  .strict()
  .refine((s) => (s.matchType === "ide_extension_id" || s.matchType === "browser_extension_id") === (s.ecosystem !== null), {
    message: "an ecosystem is set exactly on extension rows",
  })
  .refine((s) => s.matchType !== "listening_port" || isPort(s.value), { message: "a listening_port value is 1..65535" })
  .refine(
    (s) =>
      s.matchType !== "trait_set" ||
      s.value.split("+").every((t) => (ENDPOINT_TRAITS as readonly string[]).includes(t)),
    { message: "a trait_set value names traits from ENDPOINT_TRAITS joined by '+'" },
  );

function isPort(v: string): boolean {
  if (v.length === 0 || v.length > 5 || ![...v].every((c) => c >= "0" && c <= "9")) return false;
  const n = Number(v);
  return n >= 1 && n <= 65535;
}

// ===========================================================================
// MATCHING — pure, character comparison only
// ===========================================================================

export interface EndpointObservationKey {
  matchType: Exclude<EndpointMatchType, "trait_set">;
  value: string;
  ecosystem?: EndpointExtensionEcosystem;
}

export interface EndpointMatchable {
  os: EndpointOs | null;
  keys: readonly EndpointObservationKey[];
  traits: readonly EndpointTrait[];
}

export interface EndpointSignatureLike {
  id: string;
  matchType: EndpointMatchType;
  value: string;
  os: readonly EndpointOs[] | null;
  ecosystem: EndpointExtensionEcosystem | null;
  enabled: boolean;
}

/** chromium-family browsers share one extension id space */
const sameEcosystem = (a: EndpointExtensionEcosystem | undefined, b: EndpointExtensionEcosystem | null): boolean => {
  if (b === null || a === undefined) return true;
  if (a === b) return true;
  const chromium = (e: string) => e === "chrome" || e === "edge";
  return chromium(a) && chromium(b);
};

/** Return the enabled signatures an observation matches. An observation with an unknown OS still matches OS-bound rows. */
export function matchEndpointObservation<S extends EndpointSignatureLike>(
  obs: EndpointMatchable,
  signatures: readonly S[],
): S[] {
  const out: S[] = [];
  for (const sig of signatures) {
    if (!sig.enabled) continue;
    if (sig.os !== null && obs.os !== null && !sig.os.includes(obs.os)) continue;
    if (sig.matchType === "trait_set") {
      const need = sig.value.split("+");
      if (need.length > 0 && need.every((t) => (obs.traits as readonly string[]).includes(t))) out.push(sig);
      continue;
    }
    const want = sig.value.toLowerCase();
    if (obs.keys.some((k) => k.matchType === sig.matchType && k.value.toLowerCase() === want && sameEcosystem(k.ecosystem, sig.ecosystem))) {
      out.push(sig);
    }
  }
  return out;
}

/** Enabled seed values of one match type (lower-cased, de-duplicated, sorted), optionally for one OS. */
export function endpointSeedValues(
  matchType: EndpointMatchType,
  opts: { os?: EndpointOs; ecosystems?: readonly EndpointExtensionEcosystem[]; seed?: readonly EndpointSignatureSeed[] } = {},
): string[] {
  const seed = opts.seed ?? ENDPOINT_SIGNATURE_SEED;
  const set = new Set<string>();
  for (const s of seed) {
    if (!s.enabled || s.matchType !== matchType) continue;
    if (opts.os && s.os !== null && !s.os.includes(opts.os)) continue;
    if (opts.ecosystems && (s.ecosystem === null || !opts.ecosystems.includes(s.ecosystem))) continue;
    set.add(matchType === "config_path" || matchType === "env_var_name" ? s.value : s.value.toLowerCase());
  }
  return [...set].sort();
}
