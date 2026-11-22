/**
 * ADR-0364 S3 — THE STEP EXECUTOR: one approved robot run's plan, executed in order against a page, inside the run's
 * robot_browser sandbox. Everything here is RegulAIt's own semantics (the step model, the origin rules, the evidence
 * format); the browser is Playwright behind the narrow `RobotPage` seam (`playwright.ts`), so this file is tested
 * without a browser.
 *
 * Rules (§7):
 *  - `goto` only to an allowed origin (`navigation_refused` otherwise); the browser's own route check repeats it;
 *  - `fill_secret` only while the page's current origin IS the secret's bound origin (`secret_origin_mismatch`);
 *  - `read` output length-capped (`output_too_long`); `download` byte-capped (`download_too_large`), its output is
 *    `sha256:<hex>` and its bytes go up as evidence; `check` waits for a visible element, and its text if given;
 *  - a heartbeat before every step; `{cancel: true}` ends the run `cancelled` / `halted` (ADR-0124 `halted`);
 *  - per-action timeout `limits.actionTimeoutMs`, whole-run `limits.wallClockMs` (`timed_out`);
 *  - screenshots (`masked` only) after every step, JPEG, masked over every selector a value was filled into so far;
 *  - secret values live in this module's run scope only: opened from their sealed form with the run key at the start,
 *    never written to a result, an evidence item, an error or a log, and dropped when the run ends.
 * Any unexpected exception becomes `failed` / `runner_error`, with no message text (a message could hold page content).
 */
import { createHash } from "node:crypto";
import {
  ROBOT_EVIDENCE_CHUNK_BYTES,
  ROBOT_RUN_LIMITS,
  openRobotSecret,
  originAllowed,
  type RobotEvidenceUpload,
  type RobotRunFailureCode,
  type RobotRunPlan,
  type RobotRunResult,
} from "@regulait/shared";

/** the few page operations a run uses; `playwright.ts` implements them over playwright-core */
export interface RobotPage {
  /** the page's current URL */
  url(): string;
  goto(url: string, timeoutMs: number): Promise<void>;
  fill(selector: string, value: string, timeoutMs: number): Promise<void>;
  click(selector: string, timeoutMs: number): Promise<void>;
  select(selector: string, value: string, timeoutMs: number): Promise<void>;
  /** the element's innerText */
  innerText(selector: string, timeoutMs: number): Promise<string>;
  /** wait until the element is visible, then its innerText */
  visibleText(selector: string, timeoutMs: number): Promise<string>;
  /** click the element and take the download it starts; `too_large` once it is past `maxBytes` */
  download(selector: string, timeoutMs: number, maxBytes: number): Promise<Buffer | "too_large">;
  /** a JPEG of the viewport with every element matching `mask` painted over */
  screenshot(mask: readonly string[], timeoutMs: number): Promise<Buffer>;
}

/** the run's four gateway requests (`channel.ts` sends them over the sandbox's gateway channel) */
export interface RobotGateway {
  heartbeat(step: number): Promise<{ cancel: boolean }>;
  evidence(chunk: RobotEvidenceUpload): Promise<void>;
  result(result: RobotRunResult): Promise<void>;
}

export interface RunOptions {
  page: RobotPage;
  gateway: RobotGateway;
  /** the run key (fd 3), used only to open the plan's sealed secrets */
  runKey: string;
  /** test seam: the clock */
  now?: () => number;
}

/** a step outcome the run reports with its own failure code */
class StepFailure extends Error {
  constructor(readonly code: RobotRunFailureCode) {
    super(code);
  }
}
class Cancelled extends Error {}
/** the runner's own channel or evidence failing (`runner_error`), never a step outcome */
class ChannelFailure extends Error {}

const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? `https://${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}` : null;
  } catch {
    return null;
  }
};

/** race `p` against the run's deadline (a step past it ends the run `timed_out`) */
function withDeadline<T>(p: Promise<T>, msLeft: number): Promise<T> {
  if (msLeft <= 0) {
    p.catch(() => undefined);
    return Promise.reject(new StepFailure("timed_out"));
  }
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepFailure("timed_out")), msLeft);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** send one evidence item, in order, in chunks of at most ROBOT_EVIDENCE_CHUNK_BYTES (the last names size and sha256) */
export async function uploadEvidence(
  gateway: Pick<RobotGateway, "evidence">,
  item: number,
  kind: RobotEvidenceUpload["kind"],
  step: number | null,
  contentType: RobotEvidenceUpload["contentType"],
  bytes: Buffer,
): Promise<void> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const n = Math.max(1, Math.ceil(bytes.length / ROBOT_EVIDENCE_CHUNK_BYTES));
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const part = bytes.subarray(i * ROBOT_EVIDENCE_CHUNK_BYTES, (i + 1) * ROBOT_EVIDENCE_CHUNK_BYTES);
    await gateway.evidence({ item, kind, step, contentType, chunk: i, dataBase64: part.toString("base64"), last, ...(last ? { size: bytes.length, sha256 } : {}) });
  }
}

/**
 * Execute the plan and report its result to the gateway. Returns the result it reported. Never throws for a run's own
 * failure; throws only when the result itself could not be delivered.
 */
export async function runRobotPlan(plan: RobotRunPlan, opts: RunOptions): Promise<RobotRunResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + plan.limits.wallClockMs;
  const left = () => deadline - now();
  const actionMs = () => Math.max(1, Math.min(plan.limits.actionTimeoutMs, left()));
  const { page } = opts;
  // a heartbeat or evidence request that fails is the runner's channel failing, not the step
  const channel = <T>(p: Promise<T>): Promise<T> =>
    p.catch(() => {
      throw new ChannelFailure();
    });
  const gateway: Pick<RobotGateway, "heartbeat" | "evidence"> = {
    heartbeat: (s) => channel(opts.gateway.heartbeat(s)),
    evidence: (c) => channel(opts.gateway.evidence(c)),
  };
  const outputs: Record<string, string> = {};
  const masked: string[] = [];
  let item = 0;
  let stepsCompleted = 0;
  // the secret table: opened here, in memory, dropped in `finally`
  const secrets = new Map<string, { origin: string; value: string }>();
  const execute = async (): Promise<RobotRunResult> => {
    for (const s of plan.secrets) {
      try {
        secrets.set(s.ref, { origin: s.origin, value: openRobotSecret(opts.runKey, plan.runId, s.ref, s.sealed) });
      } catch {
        return { status: "failed", failureCode: "runner_error", stepsCompleted, outputs };
      }
    }
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      try {
        const hb = await withDeadline(gateway.heartbeat(i), left());
        if (hb.cancel) throw new Cancelled();
        switch (step.op) {
          case "goto":
            if (!originAllowed(step.url, plan.allowedOrigins)) throw new StepFailure("navigation_refused");
            await withDeadline(page.goto(step.url, actionMs()), left());
            break;
          case "fill":
            masked.push(step.selector);
            await withDeadline(page.fill(step.selector, step.value, actionMs()), left());
            break;
          case "fill_secret": {
            const secret = secrets.get(step.secretRef);
            if (!secret || originOf(page.url()) !== secret.origin) throw new StepFailure("secret_origin_mismatch");
            masked.push(step.selector);
            await withDeadline(page.fill(step.selector, secret.value, actionMs()), left());
            break;
          }
          case "click":
            await withDeadline(page.click(step.selector, actionMs()), left());
            break;
          case "select":
            masked.push(step.selector);
            await withDeadline(page.select(step.selector, step.value, actionMs()), left());
            break;
          case "read": {
            const text = await withDeadline(page.innerText(step.selector, actionMs()), left());
            if (text.length > Math.min(plan.limits.outputChars, ROBOT_RUN_LIMITS.outputChars)) throw new StepFailure("output_too_long");
            outputs[step.output] = text;
            break;
          }
          case "download": {
            const max = Math.min(plan.limits.downloadBytes, ROBOT_RUN_LIMITS.downloadBytes);
            const bytes = await withDeadline(page.download(step.selector, actionMs(), max), left());
            if (bytes === "too_large" || bytes.length > max) throw new StepFailure("download_too_large");
            if (item >= ROBOT_RUN_LIMITS.evidenceItems) throw new StepFailure("step_failed");
            await withDeadline(uploadEvidence(gateway, item++, "download", i, "application/octet-stream", bytes), left());
            outputs[step.output] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
            break;
          }
          case "check": {
            const text = await withDeadline(page.visibleText(step.selector, actionMs()), left());
            if (step.text !== undefined && !text.includes(step.text)) throw new StepFailure("step_failed");
            break;
          }
        }
        stepsCompleted = i + 1;
        if (plan.screenshots === "masked" && item < ROBOT_RUN_LIMITS.evidenceItems) {
          // a screenshot that cannot be taken fails the run (evidence is part of the run), never the step's own outcome
          const shot = await withDeadline(
            page.screenshot([...masked], actionMs()).catch((e: unknown) => {
              throw e instanceof StepFailure ? e : new ChannelFailure();
            }),
            left(),
          );
          // an oversized screenshot is not kept (the step outcome stands); it never goes up unmasked or cropped
          if (shot.length <= ROBOT_RUN_LIMITS.screenshotBytes) await withDeadline(uploadEvidence(gateway, item++, "screenshot", i, "image/jpeg", shot), left());
        }
      } catch (e) {
        if (e instanceof Cancelled) return { status: "cancelled", failureCode: "halted", stepsCompleted, outputs };
        const code: RobotRunFailureCode = e instanceof StepFailure ? e.code : e instanceof ChannelFailure ? "runner_error" : "step_failed";
        return { status: code === "timed_out" ? "timed_out" : "failed", failureCode: code, failedStep: i, stepsCompleted, outputs };
      }
    }
    return { status: "succeeded", stepsCompleted, outputs };
  };
  let result: RobotRunResult;
  try {
    result = await execute();
  } catch {
    // outside a step (a secret that does not open): the runner's own failure, with no message text
    result = { status: "failed", failureCode: "runner_error", stepsCompleted, outputs };
  } finally {
    secrets.clear();
  }
  await opts.gateway.result(result);
  return result;
}
