/**
 * ADR-0190 I3 — building a report from a probe set, and the executor's own
 * pre-check with the gateway's evaluator. The executor evaluates its own
 * report before sending it NOT to decide anything (the gateway decides) but
 * so a backend that fails its own profile is logged as such on the host
 * where someone can fix it, and so the test for "a lying backend is refused"
 * can show the rule firing on both sides.
 */
import {
  ATTESTATION_STRENGTH,
  evaluateExecutorReport,
  EXECUTOR_REPORT_SCHEMA,
  type AppliedIsolationKind,
  type EvaluateReportInput,
  type ExecutorReport,
  type ReportVerdict,
} from "@regulait/shared";
import type { BackendDescription, ProbeSet } from "./backend.js";

export interface BuildReportInput {
  kind: ExecutorReport["kind"];
  identifier: string;
  backend: BackendDescription;
  profileDigest: string;
  cls: AppliedIsolationKind;
  probes: ProbeSet;
  offerId?: string;
  imageDigest?: string;
  now?: () => Date;
}

export function buildReport(input: BuildReportInput): ExecutorReport {
  const base = {
    schema: EXECUTOR_REPORT_SCHEMA,
    kind: input.kind,
    executor: { identifier: input.identifier, backend: input.backend.backend, runtimeVersion: input.backend.runtimeVersion },
    profileDigest: input.profileDigest,
    class: input.cls,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    probes: input.probes,
    strength: ATTESTATION_STRENGTH,
  } satisfies Partial<ExecutorReport>;
  return input.kind === "placement" ? { ...base, offerId: input.offerId!, imageDigest: input.imageDigest! } : base;
}

export function precheckReport(report: ExecutorReport, input: EvaluateReportInput): ReportVerdict {
  return evaluateExecutorReport(report, input);
}
