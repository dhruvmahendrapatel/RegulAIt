/**
 * ADR-0239 slice 1 — which engine evaluates rate limits.
 *
 * Default: the Cedar evaluator (`@regulait/policy-kernel/rate-limit-cedar`). For ONE release the hand-written
 * evaluator stays available behind `REGULAIT_RATE_LIMIT_EVALUATOR=legacy`, as a rollback if the Cedar path misbehaves
 * in a deployment. Both give the same answers (the kernel's differential test holds them to it); the Cedar one also
 * refuses a call when it cannot evaluate.
 *
 * The choice is made once, at boot, and written to the boot log (`describeRateLimitEvaluator`). Any value other than
 * unset, `cedar` or `legacy` refuses the boot, so a typo cannot pick an engine silently. Outside `boot` (tests, the
 * simulator) the first call resolves `process.env` the same way; an invalid value there gives an evaluator that
 * errors on every call, which the kernel turns into a deny.
 */
import { legacyRateLimitEvaluator, type RateLimitEvaluator } from "@regulait/policy-kernel";
import { cedarRateLimitEvaluator } from "@regulait/policy-kernel/rate-limit-cedar";

export const RATE_LIMIT_EVALUATOR_ENV = "REGULAIT_RATE_LIMIT_EVALUATOR";

export class RateLimitEvaluatorBootError extends Error {
  override name = "RateLimitEvaluatorBootError";
}

/** Read the setting. THROWS `RateLimitEvaluatorBootError` on a value it does not recognise. */
export function resolveRateLimitEvaluator(env: NodeJS.ProcessEnv = process.env): RateLimitEvaluator {
  const raw = (env[RATE_LIMIT_EVALUATOR_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "cedar") return cedarRateLimitEvaluator;
  if (raw === "legacy") return legacyRateLimitEvaluator;
  throw new RateLimitEvaluatorBootError(
    `${RATE_LIMIT_EVALUATOR_ENV} is '${env[RATE_LIMIT_EVALUATOR_ENV]}'; use 'cedar' (the default) or 'legacy'.`,
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
  return evaluator === legacyRateLimitEvaluator
    ? `legacy hand-written evaluator (${RATE_LIMIT_EVALUATOR_ENV}=legacy; kept for one release, ADR-0239)`
    : `Cedar (${evaluator.engine}, ADR-0239)`;
}
