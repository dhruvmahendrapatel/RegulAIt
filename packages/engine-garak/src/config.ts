/**
 * ADR-0187 B5-G — THE GARAK PLAN, CONFIG AND ENVIRONMENT (decisions 149-151).
 *
 * What a lease asks for is planned against the shared catalogue (garak.ts): every requested set is
 * either a probe this build runs, a declared planning-time exclusion (not run, with its reason), or
 * unknown (not run, `engine_error`, which makes the run incomplete). Nothing outside the catalogue
 * reaches garak.
 *
 * Each probe runs as ITS OWN garak process (R10 consequence 4): one detector that cannot load aborts
 * the rest of garak's queue and still exits 0, so a shared process could silently drop probes.
 *
 * The config (garak reads JSON as YAML) and the child's environment are built from nothing:
 *   - the only generator is `openai.OpenAICompatible` at the gateway's `/v1/`, with the agent and
 *     project headers the lease names (as `extra_headers`); the key never appears in the config, only
 *     in `OPENAICOMPATIBLE_API_KEY`;
 *   - `extended_detectors: false`, so only the probe's primary detector runs (the hosted-API detectors
 *     are never loaded); one generation per prompt; the prompt cap is the run's trials;
 *   - the report directory and XDG config/data/cache directories are fresh and empty on the worker's
 *     tmpfs, so no `garak.site.yaml` and no data override can be picked up (R10);
 *   - every usage-data switch is set; no proxy, vendor key or inherited variable but PATH;
 *   - the pre-seeded Hugging Face assets (decisions 198-200) are read from the image's read-only tree:
 *     `HF_HUB_CACHE` is its hub cache, and `HF_DATASETS_CACHE` is a fresh per-probe directory whose
 *     entries are symlinks into it (datasets takes a lock file in its cache root); `HF_HOME` stays fresh;
 *   - a probe with settings in GARAK_PROBE_SETTINGS gets exactly those (the system-prompt probe names the
 *     pre-seeded dataset only).
 * `assertGatewayOnly` re-checks the finished config and environment before anything is written.
 */
import {
  GARAK_PROBE_SETTINGS,
  GARAK_TAXONOMY_SYSTEM,
  GARAK_USAGE_DATA_ENV,
  garakNotRunReason,
  garakPrimaryDetector,
  garakProbeForSet,
  type EngineNotRunEntry,
  type GarakProbeEntry,
} from "@regulait/shared";

/** the one env var the run's key travels in (garak's OpenAICompatible generator reads it) */
export const GARAK_KEY_ENV = "OPENAICOMPATIBLE_API_KEY";
/** the generator every garak process uses */
export const GARAK_TARGET_TYPE = "openai.OpenAICompatible";
/** a prompt's detector score at or above this is a hit (garak's default; written explicitly) */
export const GARAK_EVAL_THRESHOLD = 0.5;
/** the report prefix: garak writes `<report_dir>/<prefix>.report.jsonl` */
export const GARAK_REPORT_PREFIX = "garak";
/** the image's pre-seeded, read-only Hugging Face tree (engines/garak/Dockerfile; image.test.ts checks it) */
export const GARAK_HF_PRESEED_DIR = "/opt/garak/hf";

export class GarakConfigRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PlannedProbe {
  /** the set id the run asked for (lower case) */
  set: string;
  /** garak's `module.Class` */
  probe: string;
  /** its primary detector (the only one run) */
  detector: string;
  entry: GarakProbeEntry;
}

export interface GarakPlan {
  probes: PlannedProbe[];
  /** sets that will not run: a declared exclusion (keyed by probe name) or an unknown set (keyed by the set) */
  notRun: EngineNotRunEntry[];
}

/** plan a run's sets against the catalogue (pure) */
export function planGarakRun(sets: readonly string[]): GarakPlan {
  const probes: PlannedProbe[] = [];
  const notRun: EngineNotRunEntry[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    const entry = garakProbeForSet(set);
    if (!entry) {
      if (!seen.has(set)) notRun.push({ key: set, reason: "engine_error" });
      seen.add(set);
      continue;
    }
    if (seen.has(entry.probe)) continue;
    seen.add(entry.probe);
    const reason = garakNotRunReason(entry.disposition);
    const detector = garakPrimaryDetector(entry.probe);
    if (reason) notRun.push({ key: entry.probe, reason });
    else if (!detector) notRun.push({ key: entry.probe, reason: "engine_error" });
    else probes.push({ set, probe: entry.probe, detector, entry });
  }
  return { probes, notRun };
}

export interface GarakTarget {
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
}

const MODEL_RE = /^[\x21-\x7e]{1,200}$/;
const HEADER_NAME_RE = /^x-regulait-[a-z-]{1,40}$/;
const HEADER_VALUE_RE = /^[\x21-\x7e]{1,200}$/;

/** the gateway's OpenAI-compatible base as garak wants it (a trailing slash) */
export function garakUri(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

/** one probe's garak config (garak reads JSON with its YAML loader) */
export function buildGarakConfig(args: { target: GarakTarget; probe: string; trials: number; reportDir: string; seed?: number }): Record<string, unknown> {
  if (!MODEL_RE.test(args.target.model)) throw new GarakConfigRefused("model_invalid", "a model name must be printable with no spaces");
  for (const [k, v] of Object.entries(args.target.headers)) {
    if (!HEADER_NAME_RE.test(k) || !HEADER_VALUE_RE.test(v)) throw new GarakConfigRefused("header_invalid", "only the gateway's own x-regulait headers may be sent");
  }
  const cap = Math.max(1, Math.min(25, Math.trunc(args.trials)));
  return {
    system: {
      verbose: 0,
      narrow_output: true,
      parallel_requests: false,
      parallel_attempts: false,
      lite: true,
      show_z: false,
      enable_experimental: false,
    },
    run: {
      seed: args.seed ?? 0,
      deprefix: true,
      eval_threshold: GARAK_EVAL_THRESHOLD,
      generations: 1,
      soft_probe_prompt_cap: cap,
      spec: { include: [`probes.${args.probe}`] },
    },
    plugins: {
      target_type: GARAK_TARGET_TYPE,
      target_name: args.target.model,
      extended_detectors: false,
      ...probeSettings(args.probe),
      generators: {
        openai: {
          OpenAICompatible: {
            uri: garakUri(args.target.baseUrl),
            // the gateway does not take these; n would also be wrong for one generation
            suppressed_params: ["n", "stop", "frequency_penalty", "presence_penalty", "seed"],
            extra_params: { extra_headers: { ...args.target.headers } },
          },
        },
      },
    },
    reporting: {
      report_dir: args.reportDir,
      report_prefix: GARAK_REPORT_PREFIX,
    },
  };
}

/** `plugins.probes.<module>.<Class>` for a probe with fixed settings, else nothing */
function probeSettings(probe: string): { probes?: Record<string, Record<string, Record<string, unknown>>> } {
  const settings = GARAK_PROBE_SETTINGS[probe];
  if (!settings) return {};
  const [module, klass] = probe.split(".") as [string, string];
  return { probes: { [module]: { [klass]: JSON.parse(JSON.stringify(settings)) as Record<string, unknown> } } };
}

/** the directories one garak process owns (all fresh and empty, on the worker's tmpfs) */
export interface GarakDirs {
  home: string;
  config: string;
  data: string;
  cache: string;
  report: string;
}

/**
 * The child's WHOLE environment. HOME and the three XDG directories are fresh per probe; Python never
 * writes bytecode, never reads a user site and never puts the working directory on its path.
 */
export function buildGarakEnv(apiKey: string, dirs: GarakDirs, pathVar: string, hfPreseed: string = GARAK_HF_PRESEED_DIR): Record<string, string> {
  return {
    PATH: pathVar,
    HOME: dirs.home,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    HF_HOME: `${dirs.cache}/huggingface`,
    HF_HUB_CACHE: `${hfPreseed}/hub`,
    HF_DATASETS_CACHE: garakDatasetsCacheDir(dirs),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONSAFEPATH: "1",
    TERM: "dumb",
    NO_COLOR: "1",
    TQDM_DISABLE: "1",
    ...GARAK_USAGE_DATA_ENV,
    [GARAK_KEY_ENV]: apiKey,
  };
}

/** the per-probe datasets cache root (symlinks into the pre-seeded tree; garak-run.ts creates them) */
export function garakDatasetsCacheDir(dirs: GarakDirs): string {
  return `${dirs.cache}/hf-datasets`;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** the ONLY env names garak may see (an allow-list: a proxy, a vendor key or a base-URL override is refused) */
const ALLOWED_ENV = new Set([
  "PATH",
  "HOME",
  "LANG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HF_HOME",
  "HF_HUB_CACHE",
  "HF_DATASETS_CACHE",
  "PYTHONDONTWRITEBYTECODE",
  "PYTHONNOUSERSITE",
  "PYTHONSAFEPATH",
  "TERM",
  "NO_COLOR",
  "TQDM_DISABLE",
  GARAK_KEY_ENV,
  ...Object.keys(GARAK_USAGE_DATA_ENV),
]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** the config's shape is an allow-list: a field this build does not write is refused */
function onlyKeys(v: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isObj(v)) throw new GarakConfigRefused("config_unexpected_key", `${path} must be an object`);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new GarakConfigRefused("config_unexpected_key", `${path}.${k} is not a field this build writes`);
  return v;
}

/**
 * THE INVARIANT, on the finished config and env before they are written: one generator, garak's
 * OpenAI-compatible one, at the gateway; no URL off the gateway; no inline key; only the primary
 * detector; one probe that is in the catalogue and runs here; the report and XDG directories as given;
 * every usage-data switch set; nothing else in the environment. Throws `GarakConfigRefused`.
 */
export function assertGatewayOnly(config: Record<string, unknown>, env: Record<string, string>, gatewayBaseUrl: string, hfPreseed: string = GARAK_HF_PRESEED_DIR): void {
  let base: URL;
  try {
    base = new URL(gatewayBaseUrl);
  } catch {
    throw new GarakConfigRefused("gateway_url_invalid", "the lease's base URL is not a URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new GarakConfigRefused("gateway_url_invalid", "the gateway is reached over http(s)");
  const top = onlyKeys(config, "config", ["system", "run", "plugins", "reporting"]);
  onlyKeys(top["system"], "system", ["verbose", "narrow_output", "parallel_requests", "parallel_attempts", "lite", "show_z", "enable_experimental"]);
  const run = onlyKeys(top["run"], "run", ["seed", "deprefix", "eval_threshold", "generations", "soft_probe_prompt_cap", "spec"]);
  const spec = onlyKeys(run["spec"], "run.spec", ["include"]);
  const include = spec["include"];
  if (!Array.isArray(include) || include.length !== 1 || typeof include[0] !== "string" || !include[0].startsWith("probes.")) {
    throw new GarakConfigRefused("config_probe", "exactly one probe per garak process");
  }
  const entry = garakProbeForSet(include[0].slice("probes.".length).toLowerCase());
  if (!entry || entry.probe !== include[0].slice("probes.".length) || entry.disposition !== "local") {
    throw new GarakConfigRefused("config_probe", "the probe is not one this build runs");
  }
  if (run["generations"] !== 1 || run["eval_threshold"] !== GARAK_EVAL_THRESHOLD) throw new GarakConfigRefused("config_run", "one generation per prompt, the fixed threshold");
  const plugins = onlyKeys(top["plugins"], "plugins", ["target_type", "target_name", "extended_detectors", "generators", "probes"]);
  // a probe's settings are exactly the fixed ones this build writes for it, or none
  if (JSON.stringify(plugins["probes"]) !== JSON.stringify(probeSettings(entry.probe).probes)) {
    throw new GarakConfigRefused("config_probe_settings", "a probe gets exactly this build's fixed settings");
  }
  if (plugins["target_type"] !== GARAK_TARGET_TYPE) throw new GarakConfigRefused("config_generator", "the only generator is the gateway's OpenAI-compatible route");
  if (plugins["extended_detectors"] !== false) throw new GarakConfigRefused("config_detectors", "only the probe's primary detector may run");
  const generators = onlyKeys(plugins["generators"], "plugins.generators", ["openai"]);
  const openai = onlyKeys(generators["openai"], "plugins.generators.openai", ["OpenAICompatible"]);
  const gen = onlyKeys(openai["OpenAICompatible"], "plugins.generators.openai.OpenAICompatible", ["uri", "suppressed_params", "extra_params"]);
  if (gen["uri"] !== garakUri(gatewayBaseUrl)) throw new GarakConfigRefused("config_not_gateway", "the generator's URI is the gateway's /v1/");
  const extra = onlyKeys(gen["extra_params"], "extra_params", ["extra_headers"]);
  const headers = onlyKeys(extra["extra_headers"], "extra_params.extra_headers", Object.keys(extra["extra_headers"] as object));
  for (const [k, v] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(k) || typeof v !== "string" || !HEADER_VALUE_RE.test(v) || URL_RE.test(v)) {
      throw new GarakConfigRefused("header_invalid", "only the gateway's own x-regulait headers may be sent");
    }
  }
  if (!Array.isArray(gen["suppressed_params"]) || !gen["suppressed_params"].every((p) => typeof p === "string")) {
    throw new GarakConfigRefused("config_unexpected_key", "suppressed_params is a list of names");
  }
  const reporting = onlyKeys(top["reporting"], "reporting", ["report_dir", "report_prefix"]);
  if (typeof reporting["report_dir"] !== "string" || !reporting["report_dir"].startsWith("/")) throw new GarakConfigRefused("config_report_dir", "an absolute report directory");
  if (reporting["report_prefix"] !== GARAK_REPORT_PREFIX) throw new GarakConfigRefused("config_report_dir", "the fixed report prefix");
  // nothing in the config may carry the key
  if (env[GARAK_KEY_ENV] && JSON.stringify(config).includes(env[GARAK_KEY_ENV]!)) throw new GarakConfigRefused("config_inline_key", "the key travels only in the environment");
  for (const [name, value] of Object.entries(GARAK_USAGE_DATA_ENV)) {
    if (env[name] !== value) throw new GarakConfigRefused("env_usage_switch", `${name} must be ${value}`);
  }
  for (const name of Object.keys(env)) {
    if (!ALLOWED_ENV.has(name)) throw new GarakConfigRefused("env_forbidden", `${name} must not reach garak`);
  }
  if (!env[GARAK_KEY_ENV]) throw new GarakConfigRefused("env_key_missing", "the run's key is required");
  // the Hub caches: the image's read-only hub cache, and per-probe writable roots under the fresh cache dir
  const cache = env["XDG_CACHE_HOME"];
  const under = (v: string | undefined) => typeof cache === "string" && cache.startsWith("/") && typeof v === "string" && v.startsWith(`${cache}/`) && !v.includes("..");
  if (env["HF_HUB_CACHE"] !== `${hfPreseed}/hub` || !under(env["HF_HOME"]) || !under(env["HF_DATASETS_CACHE"])) {
    throw new GarakConfigRefused("env_hf_cache", "the Hub caches are the image's pre-seeded tree and fresh per-probe directories");
  }
}

/** the item key and taxonomy id of a probe (garak's `module.Class`) */
export function garakSourceTaxonomy(probe: string): { system: string; id: string } {
  return { system: GARAK_TAXONOMY_SYSTEM, id: probe };
}
