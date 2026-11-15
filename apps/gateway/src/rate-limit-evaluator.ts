/**
 * ADR-0239 slice 1 — which engine evaluates rate limits.
 *
 * The Cedar evaluator (`@regulait/policy-kernel/rate-limit-cedar`) is the only engine. The hand-written one and the
 * `REGULAIT_RATE_LIMIT_EVALUATOR=legacy` rollback were removed after their one release (ADR-0239 decision 4,
 * 2026-11-14); the kernel's differential test keeps the old predicate as its oracle. `legacy` now refuses the boot
 * with that reason, so a deployment that still sets it learns at start-up instead of running on an engine it did not
 * choose.
 *
 * The choice is made once, at boot, and written to the boot log (`describeRateLimitEvaluator`). Any value other than
 * unset or `cedar` refuses the boot, so a typo cannot pick an engine silently. Outside `boot` (tests, the
 * simulator) the first call resolves `process.env` the same way; an invalid value there gives an evaluator that
 * errors on every call, which the kernel turns into a deny.
 */
import type { RateLimitEvaluator } from "@regulait/policy-kernel";
import { cedarRateLimitEvaluator } from "@regulait/policy-kernel/rate-limit-cedar";

export const RATE_LIMIT_EVALUATOR_ENV = "REGULAIT_RATE_LIMIT_EVALUATOR";

export class RateLimitEvaluatorBootError extends Error {
  override name = "RateLimitEvaluatorBootError";
}

/** Read the setting. THROWS `RateLimitEvaluatorBootError` on a value it does not recognise. */
export function resolveRateLimitEvaluator(env: NodeJS.ProcessEnv = process.env): RateLimitEvaluator {
  const raw = (env[RATE_LIMIT_EVALUATOR_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "cedar") return cedarRateLimitEvaluator;
  if (raw === "legacy") {
    throw new RateLimitEvaluatorBootError(
      `${RATE_LIMIT_EVALUATOR_ENV}=legacy: the hand-written rate-limit evaluator was removed (ADR-0239 decision 4); ` +
        "unset the variable or set it to 'cedar'.",
    );
  }
  throw new RateLimitEvaluatorBootError(
    `${RATE_LIMIT_EVALUATOR_ENV} is '${env[RATE_LIMIT_EVALUATOR_ENV]}'; use 'cedar' (the default) or leave it unset.`,
  );
}

const refusing: RateLimitEvaluator = {
  engine: "invalid-setting",
  firstExhausted: () => ({
    kind: "error",
    message: `${RATE_LIMIT_EVALUATOR_ENV} has an unrecognised value, so rate limits cannot be evaluated`,
  }),
};

let active: RateLimitEvaluator | null = null;

/** Boot: resolve (or refuse) and remember the choice for every governed call in this process. */
export function configureRateLimitEvaluator(env: NodeJS.ProcessEnv = process.env): RateLimitEvaluator {
  active = resolveRateLimitEvaluator(env);
  return active;
}

/** The evaluator `governedEvaluate` passes to the kernel. */
export function activeRateLimitEvaluator(): RateLimitEvaluator {
  if (active) return active;
  try {
    active = resolveRateLimitEvaluator(process.env);
  } catch {
    active = refusing;
  }
  return active;
}

/** The boot-log line. */
export function describeRateLimitEvaluator(evaluator: RateLimitEvaluator): string {
  return `Cedar (${evaluator.engine}, ADR-0239)`;
}
