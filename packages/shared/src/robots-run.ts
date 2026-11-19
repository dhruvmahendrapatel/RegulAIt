/**
 * ADR-0364 S3 (lane E45): THE ROBOT RUN CONTRACT — what the gateway hands one robot_browser sandbox for one run,
 * what the runner reports back, and the per-run egress ACL. Pure; shared by the gateway, the executor and the runner.
 *
 *   plan      GET  /v1/robot-runner/runs/:runId/plan       the runner's one read of its run, through the executor's
 *                                                          gateway-only task bridge (the sandbox has no other route
 *                                                          to the gateway). Secret values are in this answer once:
 *                                                          the plan is claimed on first read and never served again.
 *   heartbeat POST /v1/robot-runner/runs/:runId/heartbeat  between steps; answers {cancel} (the ADR-0187 pattern),
 *                                                          so `halted` cancels an in-flight run at the next step.
 *   evidence  POST /v1/robot-runner/runs/:runId/evidence   one redacted screenshot or download per call, bounded.
 *   result    POST /v1/robot-runner/runs/:runId/result     the terminal report; outputs are validated against the
 *                                                          version's output schema by the gateway, never trusted.
 *
 * Egress (§7): the sandbox's only peer is its own Smokescreen. `smokescreenAcl` generates that run's ACL from the
 * version's allowed origins: one enforce rule, nothing else allowed, no `open`/`report` action.
 */
import { z } from "zod";
import { ROBOT_LIMITS } from "./robots.js";

/** the run's hard limits; the gateway sets them, the runner and the executor both enforce them */
export const ROBOT_RUN_LIMITS = {
  /** the default wall clock for a scripted run (ADR-0364 §5); a version cannot ask for more */
  wallClockMs: 5 * 60_000,
  /** per Playwright action */
  actionTimeoutMs: 30_000,
  /** per `read` output, characters (§7: outputs are length-capped) */
  outputChars: 4096,
  /** per download, bytes */
  downloadBytes: 10 * 1024 * 1024,
  /** per screenshot, bytes */
  screenshotBytes: 2 * 1024 * 1024,
  /** evidence items per run */
  evidenceItems: 64,
} as const;

const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const httpsOrigin = z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/);
const selector = z.string().min(1).max(ROBOT_LIMITS.selectorChars);

/**
 * A compiled step: what the runner executes. Inputs are resolved to literal values by the gateway, so the only
 * indirection left is `secretRef` (a fill from the in-memory secret table, on the secret's own origin only).
 */
export const robotPlanStepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("goto"), url: z.string().url().max(2048) }).strict(),
  z.object({ op: z.literal("fill"), selector, value: z.string().max(ROBOT_LIMITS.valueChars) }).strict(),
  z.object({ op: z.literal("fill_secret"), selector, secretRef: fieldName }).strict(),
  z.object({ op: z.literal("click"), selector }).strict(),
  z.object({ op: z.literal("select"), selector, value: z.string().max(ROBOT_LIMITS.valueChars) }).strict(),
  z.object({ op: z.literal("read"), selector, output: fieldName }).strict(),
  z.object({ op: z.literal("download"), selector, output: fieldName }).strict(),
  z.object({ op: z.literal("check"), selector, text: z.string().max(ROBOT_LIMITS.valueChars).optional() }).strict(),
]);
export type RobotPlanStep = z.infer<typeof robotPlanStepSchema>;

export const ROBOT_SCREENSHOT_MODES = ["none", "masked"] as const;

export const robotRunPlanSchema = z
  .object({
    runId: z.string().uuid(),
    kind: z.enum(["test", "agent"]),
    allowedOrigins: z.array(httpsOrigin).min(1).max(ROBOT_LIMITS.allowedSites),
    steps: z.array(robotPlanStepSchema).min(1).max(ROBOT_LIMITS.steps),
    /** secret values for this run only, each bound to one origin (§6); held in memory, never logged */
    secrets: z
      .array(z.object({ ref: fieldName, origin: httpsOrigin, value: z.string().min(1).max(8192) }).strict())
      .max(ROBOT_LIMITS.secretBindings),
    limits: z
      .object({
        wallClockMs: z.number().int().positive().max(ROBOT_RUN_LIMITS.wallClockMs),
        actionTimeoutMs: z.number().int().positive().max(ROBOT_RUN_LIMITS.actionTimeoutMs),
        outputChars: z.number().int().positive().max(ROBOT_RUN_LIMITS.outputChars),
        downloadBytes: z.number().int().positive().max(ROBOT_RUN_LIMITS.downloadBytes),
      })
      .strict(),
    /** `none` under the compliance tag's PII mode `block`; otherwise masked over every filled field (§7) */
    screenshots: z.enum(ROBOT_SCREENSHOT_MODES),
  })
  .strict();
export type RobotRunPlan = z.infer<typeof robotRunPlanSchema>;

export const ROBOT_RUN_FAILURE_CODES = [
  "step_failed",
  "navigation_refused",
  "secret_origin_mismatch",
  "output_too_long",
  "download_too_large",
  "timed_out",
  "halted",
  "runner_error",
] as const;
export type RobotRunFailureCode = (typeof ROBOT_RUN_FAILURE_CODES)[number];

export const robotRunResultSchema = z
  .object({
    status: z.enum(["succeeded", "failed", "timed_out", "cancelled"]),
    failureCode: z.enum(ROBOT_RUN_FAILURE_CODES).optional(),
    /** 0-based index of the step that failed */
    failedStep: z.number().int().min(0).max(ROBOT_LIMITS.steps).optional(),
    stepsCompleted: z.number().int().min(0).max(ROBOT_LIMITS.steps),
    /** raw `read` values (and download sha256s); the gateway validates them against the output schema */
    outputs: z.record(fieldName, z.string().max(ROBOT_RUN_LIMITS.outputChars)),
  })
  .strict()
  .refine((r) => (r.status === "succeeded") === (r.failureCode === undefined), {
    message: "a failed run names a failureCode, a succeeded one does not",
  });
export type RobotRunResult = z.infer<typeof robotRunResultSchema>;

export const ROBOT_EVIDENCE_KINDS = ["screenshot", "download", "egress_log"] as const;
export type RobotEvidenceKind = (typeof ROBOT_EVIDENCE_KINDS)[number];

/** the JSON half of an evidence upload; the bytes are the request body (base64 here keeps one JSON route) */
export const robotEvidenceUploadSchema = z
  .object({
    kind: z.enum(ROBOT_EVIDENCE_KINDS),
    step: z.number().int().min(0).max(ROBOT_LIMITS.steps).nullable(),
    contentType: z.enum(["image/png", "application/octet-stream", "text/plain"]),
    dataBase64: z.string().max(Math.ceil((ROBOT_RUN_LIMITS.downloadBytes * 4) / 3) + 4),
  })
  .strict();
export type RobotEvidenceUpload = z.infer<typeof robotEvidenceUploadSchema>;

export const robotHeartbeatSchema = z.object({ step: z.number().int().min(0).max(ROBOT_LIMITS.steps) }).strict();
export const robotHeartbeatResponseSchema = z.object({ cancel: z.boolean() }).strict();

/** the cloud metadata ranges Smokescreen always denies on top of its non-public default (§7) */
export const ROBOT_EGRESS_DENY_RANGES = ["169.254.169.254/32", "fd00:ec2::254/128"] as const;

/** hosts and ports an allowed-origin list grants (an origin without a port is 443) */
export function robotEgressTargets(allowedOrigins: readonly string[]): { host: string; port: number }[] {
  const seen = new Map<string, { host: string; port: number }>();
  for (const o of allowedOrigins) {
    const u = new URL(o);
    if (u.protocol !== "https:") throw new Error(`robot origins are https only: ${o}`);
    const port = u.port ? Number(u.port) : 443;
    const host = u.hostname.toLowerCase();
    seen.set(`${host}:${port}`, { host, port });
  }
  return [...seen.values()].sort((a, b) => (a.host === b.host ? a.port - b.port : a.host < b.host ? -1 : 1));
}

/**
 * The run's Smokescreen ACL (stripe/smokescreen `acl` v1 YAML). A sandbox presents no client certificate, so every
 * request falls to the `default` rule: `enforce`, with exactly the version's hosts. Hosts are validated (lower-case
 * DNS names), so the YAML is built from known-safe scalars. No `services` entries, no `open` or `report` action.
 */
export function smokescreenAcl(allowedOrigins: readonly string[]): string {
  const hosts = [...new Set(robotEgressTargets(allowedOrigins).map((t) => t.host))];
  for (const h of hosts) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) {
      throw new Error(`not an egress host name: ${h}`);
    }
  }
  return ["---", "version: v1", "services: []", "default:", "  name: robot-run", "  project: regulait-robots", "  action: enforce", "  allowed_domains:", ...hosts.map((h) => `    - ${h}`), ""].join("\n");
}

/** true when `url` is on one of the allowed origins (the in-browser second line, §7) */
export function originAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return allowedOrigins.includes(`https://${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}`);
}

/**
 * Compile a validated `steps_v1` list into the runner's plan steps: a named input becomes its literal value (inputs
 * were validated against the version's input schema first), a named secret becomes a `fill_secret` reference. Pure:
 * the runner never sees step indirection it would have to interpret.
 */
export function compileRobotPlanSteps(
  steps: readonly import("./robots.js").RobotStep[],
  inputs: Readonly<Record<string, unknown>>,
): RobotPlanStep[] {
  const literal = (name: string): string => {
    const v = inputs[name];
    if (v === undefined || v === null) throw new Error(`input '${name}' has no value`);
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  return steps.map((s): RobotPlanStep => {
    switch (s.op) {
      case "goto":
        return { op: "goto", url: s.url };
      case "fill":
        if (s.secret !== undefined) return { op: "fill_secret", selector: s.selector, secretRef: s.secret };
        return { op: "fill", selector: s.selector, value: s.input !== undefined ? literal(s.input) : (s.value ?? "") };
      case "select":
        return { op: "select", selector: s.selector, value: s.input !== undefined ? literal(s.input) : (s.value ?? "") };
      case "click":
        return { op: "click", selector: s.selector };
      case "read":
        return { op: "read", selector: s.selector, output: s.output };
      case "download":
        return { op: "download", selector: s.selector, output: s.output };
      case "check":
        return s.text === undefined ? { op: "check", selector: s.selector } : { op: "check", selector: s.selector, text: s.text };
    }
  });
}
