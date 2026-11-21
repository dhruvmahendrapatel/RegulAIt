/**
 * ADR-0242 §6.1 — THE ADMISSION-SCAN ADAPTER: one subject lease → the subject scanned in the executor's sandbox →
 * the driver's `regulait.admission-scan.v1` report posted as the envelope's raw report, byte for byte.
 *
 * The runner decides nothing about the subject. It never sees the subject's bytes (the gateway places them), never
 * parses the report (the gateway does, strictly, in `recordSubjectRunEndTx`), and carries no key (the lease has none).
 * The envelope's items are empty: an admission scan's verdict is the report's, read by the gateway.
 *
 * Fail closed (the gateway records `unknown`, which holds, for every failed run; nothing for a not-run one):
 *   - a lease with no subject, or one whose file is not the one this engine's driver reads → `not_run` (`no_subject`);
 *   - no answer from the task, a report that is missing or not the bytes the task hashed → `failed`
 *     (`report_missing`), no report;
 *   - a report over the gateway's raw-report cap → `failed` (`report_too_large`), no report;
 *   - the driver killed at its limit, or no answer by the run's deadline → `failed` (`engine_timeout`);
 *   - a task that scanned nothing (its sandbox reached the network, the subject was unreadable, the driver did not
 *     start) → `failed` with that code;
 *   - a report from a driver that exited non-zero (its own `failed` report) → `failed` (`scan_failed`), the report
 *     attached for the record;
 *   - a cancel throws (the runner core posts nothing).
 */
import { createHash } from "node:crypto";
import type { EngineAdapter } from "@regulait/engine-runner";
import type { AdmissionScanEngineId, EngineLease, EngineResultEnvelope } from "@regulait/shared";
import { ADMISSION_SUBJECT_FILE } from "./config.js";
import type { SubjectScanExecutor, SubjectScanOutcome } from "./exchange.js";

export type AdmissionEnvelopeBody = Omit<EngineResultEnvelope, "version" | "runId" | "engineId" | "engineVersion">;

export class AdmissionScanCancelled extends Error {}

function body(status: AdmissionEnvelopeBody["status"], errorCode: string | null, report: Buffer | null): AdmissionEnvelopeBody {
  return {
    status,
    errorCode,
    items: [],
    notRun: [],
    rawReport: report ? { sha256: createHash("sha256").update(report).digest("hex"), bytes: report.length, contentBase64: report.toString("base64") } : null,
  };
}

/** the lease's subject file when it is the one this engine reads, else null */
export function leaseSubjectFile(engine: AdmissionScanEngineId, lease: EngineLease): string | null {
  const s = lease.subject;
  if (!s || lease.engineId !== engine || s.file !== ADMISSION_SUBJECT_FILE[engine]) return null;
  return s.file;
}

/** the task's answer → the envelope body (pure; exported for tests) */
export function admissionEnvelopeBody(outcome: SubjectScanOutcome): AdmissionEnvelopeBody {
  if (outcome.cancelled) throw new AdmissionScanCancelled("cancelled");
  if (outcome.timedOut) return body("failed", "engine_timeout", null);
  if (!outcome.answered) return body("failed", "report_missing", null);
  if (outcome.error) return body("failed", outcome.error, null);
  if (outcome.reportTooLarge) return body("failed", "report_too_large", null);
  if (outcome.reportMismatch || !outcome.report) return body("failed", "report_missing", null);
  return outcome.exitCode === 0 ? body("completed", null, outcome.report) : body("failed", "scan_failed", outcome.report);
}

export interface AdmissionScanAdapterOptions {
  engine: AdmissionScanEngineId;
  executor: SubjectScanExecutor;
  /** the wait is the run's remaining time less this margin (to report before the deadline) */
  reportMarginMs?: number;
}

export function admissionScanAdapter(opts: AdmissionScanAdapterOptions): EngineAdapter {
  return async (lease, ctx) => {
    const subjectFile = leaseSubjectFile(opts.engine, lease);
    if (!subjectFile) return body("not_run", "no_subject", null);
    // before each scan, nothing of any other run stays in the exchange (a runner that crashed left it there)
    await opts.executor.reconcile(lease.runId);
    try {
      const margin = opts.reportMarginMs ?? 10_000;
      const timeoutMs = Math.max(1000, Date.parse(lease.deadlineAt) - Date.now() - margin);
      ctx.progress(0.2);
      const outcome = await opts.executor.scan({ runId: lease.runId, subjectFile, timeoutMs }, ctx.signal);
      if (ctx.signal.aborted) throw new AdmissionScanCancelled("cancelled");
      ctx.progress(0.9);
      return admissionEnvelopeBody(outcome);
    } finally {
      await opts.executor.release(lease.runId);
    }
  };
}
