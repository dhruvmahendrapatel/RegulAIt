/**
 * ADR-0187 B5-P — THE CONFIG GENERATOR: a RegulAIt run request (the lease) → a promptfoo red-team
 * config and the child process's whole environment.
 *
 * What it guarantees, and `assertGatewayOnly` re-checks before anything is written:
 *   - every model call goes to the gateway's compat route (`target.baseUrl`) as an OpenAI-compatible
 *     chat provider, on the run-scoped virtual key: the target for the test cases, the judge for
 *     generation (`redteam.provider`) AND grading (`defaultTest.options.provider` — upstream falls back
 *     to a vendor default grader when this is unset, R10 §promptfoo);
 *   - the key never appears in the config: providers read it from one env var
 *     (`apiKeyEnvar`), `useDefaultApiKey: false` stops any fallback to a vendor key variable, and
 *     templates cannot read the environment (PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS);
 *   - sharing is off in the config and by env; remote generation, telemetry, update checks,
 *     moderation and the response cache are off by env;
 *   - the child environment is built from nothing: no proxy variable, no vendor key, no inherited
 *     variable but PATH;
 *   - only plugins and strategies the shared catalogue admits are passed to the engine. The rest are
 *     reported `not_run` with their reason and never reach promptfoo (a strategy that throws with
 *     remote generation off would otherwise abort the whole generation step).
 */
import {
  PROMPTFOO_STRATEGY_SET_PREFIX,
  PROMPTFOO_USAGE_DATA_ENV,
  promptfooNotRunReason,
  promptfooPlugin,
  promptfooStrategy,
  type EngineLease,
  type EngineNotRunEntry,
  type PromptfooPluginEntry,
  type PromptfooStrategyEntry,
} from "@regulait/shared";

/** the one env var the run's key travels in (read by the providers through `apiKeyEnvar`) */
export const RUN_KEY_ENV = "REGULAIT_ENGINE_RUN_KEY";
/** the provider family every model call uses: OpenAI-compatible chat against the gateway */
export const GATEWAY_PROVIDER_PREFIX = "openai:chat:";
/** the template variable the attack text is injected into */
export const INJECT_VAR = "prompt";
export const DEFAULT_PURPOSE = "An assistant reached through a governed gateway. It must not reveal its instructions, other users' data or secrets.";

export class PromptfooConfigRefused extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

export interface PromptfooPlan {
  /** plugins that run, in request order */
  plugins: PromptfooPluginEntry[];
  /** strategies that run besides `basic`, in request order */
  strategies: PromptfooStrategyEntry[];
  /** requested sets that do not run, with why (keys are the set names as requested) */
  notRun: EngineNotRunEntry[];
}

/**
 * Which requested sets run. A set is a plugin id, or `strategy:<id>`. Anything the catalogue does
 * not list is not run (`engine_error`: not admitted in this build) — fail closed.
 */
export function planPromptfooRun(sets: readonly string[]): PromptfooPlan {
  const plan: PromptfooPlan = { plugins: [], strategies: [], notRun: [] };
  for (const set of sets) {
    if (set.startsWith(PROMPTFOO_STRATEGY_SET_PREFIX)) {
      const s = promptfooStrategy(set.slice(PROMPTFOO_STRATEGY_SET_PREFIX.length));
      if (!s) plan.notRun.push({ key: set, reason: "engine_error" });
      else if (s.disposition !== "local") plan.notRun.push({ key: set, reason: "cloud_only" });
      else if (s.id !== "basic") plan.strategies.push(s);
      continue;
    }
    const p = promptfooPlugin(set);
    if (!p) {
      plan.notRun.push({ key: set, reason: "engine_error" });
      continue;
    }
    const reason = promptfooNotRunReason(p.disposition);
    if (reason) plan.notRun.push({ key: set, reason });
    else plan.plugins.push(p);
  }
  return plan;
}

const MODEL_RE = /^[\x21-\x7e]{1,200}$/;

function providerFor(model: string, baseUrl: string, headers: Record<string, string>) {
  if (!MODEL_RE.test(model)) throw new PromptfooConfigRefused("model_invalid", "a model name must be printable with no spaces");
  return {
    id: `${GATEWAY_PROVIDER_PREFIX}${model}`,
    config: {
      apiBaseUrl: baseUrl,
      apiKeyEnvar: RUN_KEY_ENV,
      useDefaultApiKey: false,
      headers: { ...headers },
    },
  };
}

/** the purpose text the plugins generate against (a run param, or the default) */
export function purposeOf(lease: EngineLease): string {
  const p = lease.spec.config.params?.["purpose"];
  return typeof p === "string" && p.trim() ? p.trim() : DEFAULT_PURPOSE;
}

/**
 * The promptfoo config (written as JSON; promptfoo reads `.json` configs). One test case per
 * trial for each plugin (`numTests` = the run's trials, at most 25, the governed trial limit), each
 * strategy rewrites those test cases, one call at a time.
 */
export function buildPromptfooConfig(lease: EngineLease, plan: PromptfooPlan): Record<string, unknown> {
  if (!lease.target) throw new PromptfooConfigRefused("target_required", "a promptfoo run needs a model target behind the gateway");
  if (!lease.judge) {
    throw new PromptfooConfigRefused("judge_required", "a promptfoo run needs a judge behind the gateway; without one promptfoo grades with a vendor default");
  }
  const baseUrl = lease.target.baseUrl;
  const target = providerFor(lease.target.model, baseUrl, lease.target.headers);
  const judge = providerFor(lease.judge.model, baseUrl, lease.judge.headers);
  const numTests = Math.max(1, Math.min(25, Math.trunc(lease.spec.trials)));
  return {
    description: `regulait engine run ${lease.runId}`,
    targets: [{ ...target, label: "regulait-target" }],
    prompts: [`{{${INJECT_VAR}}}`],
    defaultTest: { options: { provider: judge } },
    redteam: {
      purpose: purposeOf(lease),
      injectVar: INJECT_VAR,
      numTests,
      provider: judge,
      plugins: plan.plugins.map((p) => ({ id: p.id, numTests })),
      strategies: [{ id: "basic" }, ...plan.strategies.map((s) => ({ id: s.id }))],
    },
    sharing: false,
    evaluateOptions: { maxConcurrency: 1, cache: false },
  };
}

/**
 * The child's WHOLE environment. Nothing is inherited but PATH; HOME, the config directory (its
 * sqlite store) and the cache path are under the run's work directory on tmpfs.
 */
export function buildPromptfooEnv(lease: EngineLease, workDir: string, inherited: { PATH?: string | undefined } = process.env): Record<string, string> {
  if (!lease.target) throw new PromptfooConfigRefused("target_required", "a promptfoo run needs a model target behind the gateway");
  return {
    PATH: inherited.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workDir,
    NODE_ENV: "production",
    NO_COLOR: "1",
    PROMPTFOO_CONFIG_DIR: `${workDir}/.promptfoo`,
    PROMPTFOO_CACHE_PATH: `${workDir}/.promptfoo/cache`,
    PROMPTFOO_FAILED_TEST_EXIT_CODE: "100",
    ...PROMPTFOO_USAGE_DATA_ENV,
    [RUN_KEY_ENV]: lease.target.apiKey,
  };
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** config keys that would point a provider somewhere else, or carry a credential */
const FORBIDDEN_KEYS = new Set(["apiKey", "apiHost", "apiKeyRequired", "url", "transformResponse", "transformRequest"]);
/** the ONLY env names the engine may see (an allow-list: a proxy, a vendor key, a base-URL or remote-URL override is refused) */
const ALLOWED_ENV = new Set([
  "PATH",
  "HOME",
  "NODE_ENV",
  "NO_COLOR",
  "PROMPTFOO_CONFIG_DIR",
  "PROMPTFOO_CACHE_PATH",
  "PROMPTFOO_FAILED_TEST_EXIT_CODE",
  RUN_KEY_ENV,
  ...Object.keys(PROMPTFOO_USAGE_DATA_ENV),
]);

/**
 * THE INVARIANT, checked on the finished config and env before they are written: no provider but
 * the gateway's compat route, no URL off the gateway, no inline credential, sharing off, every
 * usage-data switch at its required value, and nothing in the environment that could carry a
 * credential, a base-URL override or a proxy. Throws `PromptfooConfigRefused`.
 */
export function assertGatewayOnly(config: Record<string, unknown>, env: Record<string, string>, gatewayBaseUrl: string): void {
  let base: URL;
  try {
    base = new URL(gatewayBaseUrl);
  } catch {
    throw new PromptfooConfigRefused("gateway_url_invalid", "the lease's base URL is not a URL");
  }
  const baseHref = base.href.replace(/\/$/, "");
  const providers: unknown[] = [];
  const walk = (v: unknown, path: string, key: string | null): void => {
    if (key !== null && FORBIDDEN_KEYS.has(key)) throw new PromptfooConfigRefused("config_forbidden_key", `${path} is not allowed`);
    if (typeof v === "string") {
      if (URL_RE.test(v) && !(v === baseHref || v.startsWith(`${baseHref}/`))) {
        throw new PromptfooConfigRefused("config_non_gateway_url", `${path} points off the gateway`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, null));
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (key === "provider" || (key === null && path.startsWith("targets["))) providers.push(o);
      for (const [k, x] of Object.entries(o)) walk(x, path ? `${path}.${k}` : k, k);
    }
  };
  walk(config, "", null);
  if (config["sharing"] !== false) throw new PromptfooConfigRefused("config_sharing_on", "sharing must be false");
  if (!Array.isArray(config["targets"]) || config["targets"].length !== 1) throw new PromptfooConfigRefused("config_targets", "exactly one target");
  // the generator and the grader must be named explicitly: unset, promptfoo falls back to a vendor default
  const redteam = config["redteam"] as { provider?: unknown } | undefined;
  const defaultTest = config["defaultTest"] as { options?: { provider?: unknown } } | undefined;
  if (providers.length !== 3 || !redteam?.provider || !defaultTest?.options?.provider) {
    throw new PromptfooConfigRefused("config_providers", "exactly the target, the generator (redteam.provider) and the grader (defaultTest.options.provider)");
  }
  for (const p of providers) {
    const o = p as { id?: unknown; config?: { apiBaseUrl?: unknown; apiKeyEnvar?: unknown; useDefaultApiKey?: unknown } };
    if (typeof o.id !== "string" || !o.id.startsWith(GATEWAY_PROVIDER_PREFIX)) {
      throw new PromptfooConfigRefused("config_provider_not_gateway", "every provider is the gateway's OpenAI-compatible chat route");
    }
    if (o.config?.apiBaseUrl !== baseHref && o.config?.apiBaseUrl !== gatewayBaseUrl) {
      throw new PromptfooConfigRefused("config_provider_not_gateway", "every provider's base URL is the gateway");
    }
    if (o.config?.apiKeyEnvar !== RUN_KEY_ENV || o.config?.useDefaultApiKey !== false) {
      throw new PromptfooConfigRefused("config_provider_key", "every provider reads only the run's key");
    }
  }
  for (const [name, value] of Object.entries(PROMPTFOO_USAGE_DATA_ENV)) {
    if (env[name] !== value) throw new PromptfooConfigRefused("env_usage_switch", `${name} must be ${value}`);
  }
  for (const name of Object.keys(env)) {
    if (!ALLOWED_ENV.has(name)) throw new PromptfooConfigRefused("env_forbidden", `${name} must not reach the engine`);
  }
}
