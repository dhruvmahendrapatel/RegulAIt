/**
 * ADR-0187 B5-M — THE MODELSCAN ADAPTER: one lease → fetch the artifact (streamed, sha256 and size
 * checked) → decide its REAL format from its bytes → hand it to the scanner under the extension of
 * that format → map the `-o` report into the envelope body.
 *
 * Fail closed:
 *   - a lease with no artifact, or more than one → `not_run` (`no_artifact`) / `failed`;
 *   - a fetch that fails, is short, long or has another sha256 → `failed` (`artifact_fetch_failed`):
 *     every reading unknown;
 *   - a format modelscan does not scan → the format item decides (safetensors verified by its header;
 *     an unsupported format declared not run); modelscan is never started;
 *   - a cancel throws (the runner core posts nothing); a time-out, a missing or bad report → the
 *     mapper's `failed`, never clean.
 * The run's model access is none: the lease carries no key (`target: null`) and this adapter makes no
 * request but the artifact fetch.
 */
import { createReadStream } from "node:fs";
import { open, rename } from "node:fs/promises";
import path from "node:path";
import { ArtifactFetchError, downloadArtifact, type EngineAdapter } from "@regulait/engine-runner";
import {
  ARTIFACT_FORMAT_PLANS,
  detectArtifactFormat,
  mapModelscanReport,
  modelscanArtifactName,
  MODELSCAN_SCAN_ITEM_KEY,
  type ArtifactReader,
  type ModelscanEnvelopeBody,
} from "@regulait/shared";
import type { ScanExecutor } from "./exchange.js";

export interface ModelscanAdapterOptions {
  gatewayUrl: string;
  /** the runner's current token (read from its own token store at fetch time) */
  token: () => Promise<string | null>;
  executor: ScanExecutor;
  /** the scanner's time limit is the run's remaining time less this margin (to report before the deadline) */
  reportMarginMs?: number;
  /** seam for tests */
  fetch?: Parameters<typeof downloadArtifact>[0]["fetch"];
}

class Cancelled extends Error {}

/** a reader over a local file (for format detection) */
export async function fileReader(file: string): Promise<{ reader: ArtifactReader; close: () => Promise<void> }> {
  const fh = await open(file, "r");
  const size = (await fh.stat()).size;
  return {
    reader: {
      size,
      async read(offset, length) {
        const n = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.alloc(n);
        if (n > 0) await fh.read(buf, 0, n, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, n);
      },
    },
    close: () => fh.close(),
  };
}

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
    const artifact = lease.artifacts[0]!;
    const dir = await opts.executor.stage(lease.runId);
    try {
      const fetched = path.join(dir, "fetched.bin");
      try {
        await downloadArtifact({ gatewayUrl: opts.gatewayUrl, token: await opts.token(), artifact, destPath: fetched, deadlineAt: lease.deadlineAt, signal: ctx.signal, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
      } catch (e) {
        if (ctx.signal.aborted) throw new Cancelled("cancelled");
        const code = e instanceof ArtifactFetchError ? e.code : "artifact_http";
        return failedBody("artifact_fetch_failed", `the artifact could not be fetched intact (${code})`);
      }
      ctx.progress(0.2);
      // THE FORMAT IS DECIDED FROM THE BYTES (G19 2): never the uploaded name
      const { reader, close } = await fileReader(fetched);
      let detection;
      try {
        detection = await detectArtifactFormat(reader);
      } finally {
        await close();
      }
      const name = modelscanArtifactName(detection.format);
      if (!ARTIFACT_FORMAT_PLANS[detection.format].scanAs || !name) {
        // not a modelscan format: the format item alone decides (safetensors verified; else not run or unknown)
        return mapModelscanReport({ format: detection.format, formatDetail: detection.evidence, exitCode: null, timedOut: false, report: null });
      }
      await rename(fetched, path.join(dir, name));
      const margin = opts.reportMarginMs ?? 10_000;
      const timeoutMs = Math.max(1000, Date.parse(lease.deadlineAt) - Date.now() - margin);
      ctx.progress(0.3);
      const outcome = await opts.executor.scan({ runId: lease.runId, format: detection.format, artifactName: name, timeoutMs }, ctx.signal);
      if (ctx.signal.aborted || outcome.cancelled) throw new Cancelled("cancelled");
      ctx.progress(0.9);
      return mapModelscanReport({
        format: detection.format,
        formatDetail: detection.evidence,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        report: outcome.reportTooLarge ? "too_large" : outcome.report,
        reportSha256: outcome.reportSha256,
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
