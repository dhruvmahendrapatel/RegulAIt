/**
 * ADR-0187 B5-M — THE MODELSCAN ADAPTER: one lease → stage the job (the artifact only PLACED) → the
 * scanner, in the executor's sandbox, decides the artifact's REAL format from its bytes and scans a
 * scannable one under that format's extension → map the `-o` report into the envelope body.
 *
 * ENG-IMG (ADR-0190 I5 open question 2): the runner no longer downloads the artifact. The gateway
 * streams it from its store to the executor, which writes it into the sandbox's read-only input and
 * checks its size and sha256 as it writes (`task-input.ts`; a mismatch starts nothing). The runner
 * makes no request for a scan at all, and the sandbox reaches nothing.
 *
 * Fail closed:
 *   - a lease with no artifact, or more than one → `not_run` (`no_artifact`) / `failed`;
 *   - a scanner that read no format (no done file, an unreadable artifact) → `failed`
 *     (`artifact_unread`, or `engine_timeout` past its limit): every reading unknown;
 *   - a format modelscan does not scan → the format item decides (safetensors verified by its header;
 *     an unsupported format declared not run); modelscan is never started;
 *   - a cancel throws (the runner core posts nothing); a time-out, a missing or bad report → the
 *     mapper's `failed`, never clean.
 * The run's model access is none: the lease carries no key (`target: null`).
 */
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { EngineAdapter } from "@regulait/engine-runner";
import { mapModelscanReport, MODELSCAN_SCAN_ITEM_KEY, type EngineLease, type ModelscanEnvelopeBody } from "@regulait/shared";
import { PLACED_ARTIFACT_NAME, type ScanExecutor } from "./exchange.js";

export interface ModelscanAdapterOptions {
  executor: ScanExecutor;
  /**
   * what is written at the artifact's place in the staged job. Default: nothing (an empty file): the bridge only
   * places it and the gateway streams the bytes to the executor. Tests write the bytes here, standing in for that
   * stream.
   */
  artifactInput?: (lease: EngineLease, placePath: string, signal: AbortSignal) => Promise<void>;
  /** the scanner's time limit is the run's remaining time less this margin (to report before the deadline) */
  reportMarginMs?: number;
}

class Cancelled extends Error {}

function failedBody(errorCode: string, reason: string): ModelscanEnvelopeBody {
  return {
    status: "failed",
    errorCode,
    items: [
      {
        key: MODELSCAN_SCAN_ITEM_KEY,
        sourceTaxonomy: { system: "modelscan", id: "scan" },
        mappedClass: null,
        severity: "medium",
        attempts: 0,
        defeated: 0,
        verdict: "unknown",
        reason,
        dispatchAuditIds: [],
      },
    ],
    notRun: [],
    rawReport: null,
  };
}

export function modelscanAdapter(opts: ModelscanAdapterOptions): EngineAdapter {
  return async (lease, ctx) => {
    if (lease.artifacts.length !== 1) {
      return { ...failedBody("no_artifact", "the lease named no single artifact to scan"), status: lease.artifacts.length === 0 ? "not_run" : "failed" };
    }
    // PR #212 review [4234946104]: before each scan, nothing of any other run stays in the exchange
    // (a runner that crashed after staging or publishing left it there)
    await opts.executor.reconcile(lease.runId);
    const dir = await opts.executor.stage(lease.runId);
    try {
      const place = path.join(dir, PLACED_ARTIFACT_NAME);
      if (opts.artifactInput) await opts.artifactInput(lease, place, ctx.signal);
      else await writeFile(place, "", { mode: 0o640 });
      if (ctx.signal.aborted) throw new Cancelled("cancelled");
      const margin = opts.reportMarginMs ?? 10_000;
      const timeoutMs = Math.max(1000, Date.parse(lease.deadlineAt) - Date.now() - margin);
      ctx.progress(0.3);
      const outcome = await opts.executor.scan({ runId: lease.runId, artifactName: PLACED_ARTIFACT_NAME, timeoutMs }, ctx.signal);
      if (ctx.signal.aborted || outcome.cancelled) throw new Cancelled("cancelled");
      ctx.progress(0.9);
      // THE FORMAT IS DECIDED FROM THE BYTES (G19 2), by the scanner that read them: never the uploaded name
      if (!outcome.detection) {
        return outcome.timedOut
          ? failedBody("engine_timeout", "the scanner did not finish within the run's time limit")
          : failedBody("artifact_unread", "the scanner read no format from the artifact");
      }
      return mapModelscanReport({
        format: outcome.detection.format,
        formatDetail: outcome.detection.evidence,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        report: outcome.reportTooLarge ? "too_large" : outcome.report,
        reportSha256: outcome.reportSha256,
        npy: outcome.npy,
        npz: outcome.npz,
      });
    } finally {
      await opts.executor.release(lease.runId);
    }
  };
}

/** stream a file's sha256 (used by tests and the image self-check) */
export async function sha256OfFile(file: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}
