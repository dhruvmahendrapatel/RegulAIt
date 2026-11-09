/**
 * ADR-0245 — THE SPIKEE PLAN, INVOCATION AND ENVIRONMENT (as garak's config.ts, ADR-0187 decisions 149-151).
 *
 * What a lease asks for is planned against the shared catalogue (packages/shared/src/engines/spikee.ts): every
 * requested set is a dataset this build generates, a plugin this build applies to every planned dataset, a declared
 * planning-time exclusion (not run, with its reason), or unknown (not run, `engine_error`). Nothing outside the
 * catalogue reaches spikee.
 *
 * Each dataset runs as ITS OWN pair of spikee processes in a fresh workspace (one failing generation cannot drop
 * another dataset's entries):
 *
 *   python -I -B -c <boot> -q generate --seed-folder <image seeds>/seeds-<seed> --format full-prompt
 *          [--include-system-message] [--jailbreak-filter <allow-list>] --threads 1 [--plugins <local plugins>]
 *   python -I -B -c <boot> -q test --dataset datasets/selected.jsonl --target regulait_gateway --threads 1
 *          --attempts 1 --max-retries 1 --no-auto-resume
 *
 * Between the two the worker keeps at most `trials` entries per item (spikee-run.ts). The only target is this build's
 * workspace module (target-module.ts) at the gateway's `/v1/chat/completions`; no `--target-options`, no
 * `--judge-options`, no attack module, no `--include-fixes`, no plugin options ever reach spikee. The run's key is
 * only in SPIKEE_KEY_ENV. `assertGatewayOnly` re-checks the finished target config, argv and environment before
 * anything is written.
 */
import {
  SPIKEE_DATASET_GENERATION,
  SPIKEE_TAXONOMY_SYSTEM,
  SPIKEE_USAGE_DATA_ENV,
  spikeeEntryForSet,
  spikeeNotRunReason,
  type EngineNotRunEntry,
  type SpikeeGeneration,
  type SpikeeSetEntry,
} from "@regulait/shared";
import { SPIKEE_KEY_ENV, SPIKEE_TARGET_NAME } from "./target-module.js";

export { SPIKEE_KEY_ENV, SPIKEE_TARGET_NAME } from "./target-module.js";

/** the boot line: spikee's own CLI entry point (`spikee = spikee.cli:main`), run under `-I` (no cwd on sys.path) */
export const SPIKEE_BOOT = "import sys; from spikee.cli import main; sys.argv[0] = 'spikee'; main()";
/** the dataset the test step reads, relative to the workspace (the worker writes it from the generated one) */
export const SPIKEE_SELECTED_DATASET = "datasets/selected.jsonl";
/** one gateway call's time limit inside the target module (seconds) */
export const SPIKEE_TARGET_TIMEOUT_S = 120;
/** the image's read-only seed folders (engines/spikee/Dockerfile links them; image.test.ts checks it) */
export const SPIKEE_SEEDS_DIR = "/opt/spikee/seeds";

export class SpikeeConfigRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PlannedDataset {
  /** the set id (`dataset:<seed>`) */
  set: string;
  /** the seed folder name, without `seeds-` */
  seed: string;
  entry: SpikeeSetEntry;
  generation: SpikeeGeneration;
}

export interface PlannedPlugin {
  /** the set id (`plugin:<name>`) */
  set: string;
  name: string;
}

export interface SpikeePlan {
  datasets: PlannedDataset[];
  /** applied to every planned dataset */
  plugins: PlannedPlugin[];
  /** sets that will not run: a declared exclusion or an unknown set, keyed by the set id */
  notRun: EngineNotRunEntry[];
}

/** plan a run's sets against the catalogue (pure) */
export function planSpikeeRun(sets: readonly string[]): SpikeePlan {
  const datasets: PlannedDataset[] = [];
  const plugins: PlannedPlugin[] = [];
  const notRun: EngineNotRunEntry[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    if (seen.has(set)) continue;
    seen.add(set);
    const entry = spikeeEntryForSet(set);
    if (!entry) {
      notRun.push({ key: set, reason: "engine_error" });
      continue;
    }
    const reason = spikeeNotRunReason(entry.disposition);
    if (reason) {
      notRun.push({ key: set, reason });
      continue;
    }
    if (entry.kind === "plugin") {
      plugins.push({ set, name: entry.name });
      continue;
    }
    const generation = SPIKEE_DATASET_GENERATION[entry.name];
    if (!generation) notRun.push({ key: set, reason: "engine_error" });
    else datasets.push({ set, seed: entry.name, entry, generation });
  }
  // a plugin only transforms a dataset's payloads: with no dataset it runs nothing
  if (datasets.length === 0) {
    for (const p of plugins) notRun.push({ key: p.set, reason: "engine_error" });
    return { datasets, plugins: [], notRun };
  }
  return { datasets, plugins, notRun };
}

/** the envelope key of one item: a dataset alone, or a dataset transformed by one plugin */
export function spikeeItemKey(datasetSet: string, plugin: string | null): string {
  return plugin === null ? datasetSet : `${datasetSet}+plugin:${plugin}`;
}

/** the taxonomy id of every item of a dataset is the dataset's set id (a plugin inherits its dataset's class) */
export function spikeeSourceTaxonomy(datasetSet: string): { system: string; id: string } {
  return { system: SPIKEE_TAXONOMY_SYSTEM, id: datasetSet };
}

export interface SpikeeTarget {
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
}

const MODEL_RE = /^[\x21-\x7e]{1,200}$/;
const HEADER_NAME_RE = /^x-regulait-[a-z-]{1,40}$/;
const HEADER_VALUE_RE = /^[\x21-\x7e]{1,200}$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** a seed or plugin name as the catalogue writes them (checked against the catalogue too) */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** the gateway's chat route under its OpenAI-compatible base (`.../v1`) */
export function spikeeChatUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 0x2f) end--;
  return `${baseUrl.slice(0, end)}/chat/completions`;
}

/** the target module's config file (`targets/regulait_gateway.json`): never the key */
export function buildSpikeeTargetConfig(target: SpikeeTarget): Record<string, unknown> {
  if (!MODEL_RE.test(target.model)) throw new SpikeeConfigRefused("model_invalid", "a model name must be printable with no spaces");
  for (const [k, v] of Object.entries(target.headers)) {
    if (!HEADER_NAME_RE.test(k) || !HEADER_VALUE_RE.test(v)) throw new SpikeeConfigRefused("header_invalid", "only the gateway's own x-regulait headers may be sent");
  }
  return { url: spikeeChatUrl(target.baseUrl), model: target.model, headers: { ...target.headers }, timeout: SPIKEE_TARGET_TIMEOUT_S };
}

/** the generate step's argv (after the interpreter) */
export function spikeeGenerateArgs(dataset: Pick<PlannedDataset, "seed" | "generation">, plugins: readonly string[], seedsDir: string = SPIKEE_SEEDS_DIR): string[] {
  const g = dataset.generation;
  return [
    "-I",
    "-B",
    "-c",
    SPIKEE_BOOT,
    "-q",
    "generate",
    "--seed-folder",
    `${seedsDir}/seeds-${dataset.seed}`,
    "--format",
    g.format,
    ...(g.includeSystemMessage ? ["--include-system-message"] : []),
    ...(g.jailbreakTypes ? ["--jailbreak-filter", g.jailbreakTypes.join(",")] : []),
    "--threads",
    "1",
    // nargs="*": last, so nothing after it is read as a plugin
    ...(plugins.length > 0 ? ["--plugins", ...plugins] : []),
  ];
}

/** the test step's argv (after the interpreter): the one target, one thread, one attempt, no retry, no resume */
export function spikeeTestArgs(): string[] {
  return [
    "-I",
    "-B",
    "-c",
    SPIKEE_BOOT,
    "-q",
    "test",
    "--dataset",
    SPIKEE_SELECTED_DATASET,
    "--target",
    SPIKEE_TARGET_NAME,
    "--threads",
    "1",
    "--attempts",
    "1",
    "--max-retries",
    "1",
    "--no-auto-resume",
  ];
}

/** the directories one dataset's spikee processes own (all fresh and empty, on the worker's tmpfs) */
export interface SpikeeDirs {
  home: string;
  config: string;
  data: string;
  cache: string;
  /** the workspace: spikee's cwd (`targets/`, `datasets/`, `results/`) */
  workspace: string;
}

/**
 * The child's WHOLE environment, built from nothing: HOME and the XDG directories fresh per dataset, every usage-data
 * switch, the key in its one variable, PATH the venv's bin. No proxy, no vendor key, no `.env` (the workspace holds
 * none, and spikee reads only `<cwd>/.env`).
 */
export function buildSpikeeEnv(apiKey: string, dirs: SpikeeDirs, pathVar: string): Record<string, string> {
  return {
    PATH: pathVar,
    HOME: dirs.home,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    HF_HOME: `${dirs.cache}/huggingface`,
    TERM: "dumb",
    NO_COLOR: "1",
    TQDM_DISABLE: "1",
    ...SPIKEE_USAGE_DATA_ENV,
    [SPIKEE_KEY_ENV]: apiKey,
  };
}

/** the ONLY env names spikee may see (an allow-list: a proxy, a vendor key or a base-URL override is refused) */
const ALLOWED_ENV = new Set(["PATH", "HOME", "LANG", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "HF_HOME", "TERM", "NO_COLOR", "TQDM_DISABLE", SPIKEE_KEY_ENV, ...Object.keys(SPIKEE_USAGE_DATA_ENV)]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** the local entry of a set id of the given kind, or null */
function localEntry(set: string, kind: "dataset" | "plugin"): SpikeeSetEntry | null {
  const e = spikeeEntryForSet(set);
  return e && e.kind === kind && e.disposition === "local" ? e : null;
}

/** the generate argv must be exactly what this build writes for one local dataset and local plugins */
function assertGenerateArgs(argv: readonly string[], seedsDir: string): void {
  const head = ["-I", "-B", "-c", SPIKEE_BOOT, "-q", "generate", "--seed-folder"];
  if (argv.length < head.length + 1 || head.some((h, i) => argv[i] !== h)) throw new SpikeeConfigRefused("argv_generate", "the generate step is spikee's own CLI, isolated, with a seed folder");
  const folder = argv[head.length]!;
  const prefix = `${seedsDir}/seeds-`;
  const seed = folder.startsWith(prefix) ? folder.slice(prefix.length) : "";
  const entry = NAME_RE.test(seed) ? localEntry(`dataset:${seed}`, "dataset") : null;
  const generation = entry ? SPIKEE_DATASET_GENERATION[entry.name] : undefined;
  if (!entry || !generation) throw new SpikeeConfigRefused("argv_dataset", "the seed folder is one of the image's local datasets");
  const rest = argv.slice(head.length + 1);
  const pluginsAt = rest.indexOf("--plugins");
  const fixed = pluginsAt === -1 ? rest : rest.slice(0, pluginsAt);
  const plugins = pluginsAt === -1 ? [] : rest.slice(pluginsAt + 1);
  // the options before --plugins are exactly this dataset's fixed generation settings, in this build's order
  const want = spikeeGenerateArgs({ seed, generation }, [], seedsDir).slice(head.length + 1);
  if (fixed.length !== want.length || fixed.some((a, i) => a !== want[i])) throw new SpikeeConfigRefused("argv_generate", "the generate options are this build's fixed settings for the dataset");
  if (pluginsAt !== -1 && plugins.length === 0) throw new SpikeeConfigRefused("argv_plugin", "--plugins names at least one plugin");
  const seen = new Set<string>();
  for (const p of plugins) {
    if (!NAME_RE.test(p) || !localEntry(`plugin:${p}`, "plugin") || seen.has(p)) throw new SpikeeConfigRefused("argv_plugin", "every plugin is a local one the catalogue admits, once");
    seen.add(p);
  }
}

/**
 * THE INVARIANT, on one dataset's finished target config, argv and env before anything is written: the target is the
 * workspace module at the gateway's chat route with only `x-regulait-*` headers; no URL off the gateway; no key in
 * the config; spikee's own CLI isolated (`-I -B`) generating one local dataset with local plugins, then testing only
 * the selected dataset against that target with no options, no judge options, no attack; every usage-data switch
 * set; nothing else in the environment. Throws `SpikeeConfigRefused`.
 */
export function assertGatewayOnly(
  inv: { targetConfig: Record<string, unknown>; generateArgs: readonly string[]; testArgs: readonly string[]; env: Record<string, string> },
  gatewayBaseUrl: string,
  seedsDir: string = SPIKEE_SEEDS_DIR,
): void {
  let base: URL;
  try {
    base = new URL(gatewayBaseUrl);
  } catch {
    throw new SpikeeConfigRefused("gateway_url_invalid", "the lease's base URL is not a URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new SpikeeConfigRefused("gateway_url_invalid", "the gateway is reached over http(s)");
  if (base.username || base.password) throw new SpikeeConfigRefused("gateway_url_invalid", "the gateway URL carries no credentials");
  const c = inv.targetConfig;
  if (!isObj(c)) throw new SpikeeConfigRefused("config_unexpected_key", "the target config is an object");
  for (const k of Object.keys(c)) if (!["url", "model", "headers", "timeout"].includes(k)) throw new SpikeeConfigRefused("config_unexpected_key", `${k} is not a field this build writes`);
  if (c["url"] !== spikeeChatUrl(gatewayBaseUrl)) throw new SpikeeConfigRefused("config_not_gateway", "the target is the gateway's /v1/chat/completions");
  if (typeof c["model"] !== "string" || !MODEL_RE.test(c["model"])) throw new SpikeeConfigRefused("model_invalid", "a model name must be printable with no spaces");
  if (c["timeout"] !== SPIKEE_TARGET_TIMEOUT_S) throw new SpikeeConfigRefused("config_timeout", "the call time limit is fixed");
  const headers = c["headers"];
  if (!isObj(headers)) throw new SpikeeConfigRefused("header_invalid", "headers are an object");
  for (const [k, v] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(k) || typeof v !== "string" || !HEADER_VALUE_RE.test(v) || URL_RE.test(v)) {
      throw new SpikeeConfigRefused("header_invalid", "only the gateway's own x-regulait headers may be sent");
    }
  }
  const key = inv.env[SPIKEE_KEY_ENV];
  if (!key) throw new SpikeeConfigRefused("env_key_missing", "the run's key is required");
  if (JSON.stringify(c).includes(key) || [...inv.generateArgs, ...inv.testArgs].some((a) => a.includes(key))) {
    throw new SpikeeConfigRefused("config_inline_key", "the key travels only in the environment");
  }
  assertGenerateArgs(inv.generateArgs, seedsDir);
  const test = spikeeTestArgs();
  if (inv.testArgs.length !== test.length || inv.testArgs.some((a, i) => a !== test[i])) {
    throw new SpikeeConfigRefused("argv_test", "the test step runs the selected dataset against the gateway target only, with no options");
  }
  for (const [name, value] of Object.entries(SPIKEE_USAGE_DATA_ENV)) {
    if (inv.env[name] !== value) throw new SpikeeConfigRefused("env_usage_switch", `${name} must be ${value}`);
  }
  for (const name of Object.keys(inv.env)) {
    if (!ALLOWED_ENV.has(name)) throw new SpikeeConfigRefused("env_forbidden", `${name} must not reach spikee`);
  }
  const cache = inv.env["XDG_CACHE_HOME"];
  if (typeof cache !== "string" || !cache.startsWith("/") || cache.includes("..") || inv.env["HF_HOME"] !== `${cache}/huggingface`) {
    throw new SpikeeConfigRefused("env_dirs", "the caches are fresh per-dataset directories");
  }
}
