/**
 * ADR-0187 B5-M — a test harness: run the real adapter on artifact bytes (fetched from a fake
 * gateway), then normalise and judge the result EXACTLY as the gateway does (the shared normaliser
 * with the manifest's reduced set, then `deriveArtifactScanVerdict` against the format the gateway
 * detected at upload). Tests only; not exported from the package index.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deriveArtifactScanVerdict,
  detectArtifactFormat,
  ENGINE_MANIFEST,
  ENGINE_RESULT_VERSION,
  ENGINE_TAXONOMY,
  engineResultEnvelopeSchema,
  normaliseEngineResult,
  type ArtifactReader,
  type EngineLease,
  type EngineResultEnvelope,
} from "@regulait/shared";
import { modelscanAdapter } from "./adapter.js";
import type { ScanExecutor } from "./exchange.js";

export function bufferReader(b: Buffer): ArtifactReader {
  return { size: b.length, read: async (o, l) => new Uint8Array(b.subarray(o, Math.min(b.length, o + l))) };
}

export function leaseFor(bytes: Buffer, deadlineMs = 60_000): EngineLease {
  return {
    runId: randomUUID(),
    engineId: "modelscan",
    engineVersion: "0.8.8",
    spec: { config: { sets: ["scan"], params: {} }, trials: 1 },
    target: null,
    judge: null,
    artifacts: [{ id: randomUUID(), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }],
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
    budgetUsd: null,
  };
}

export function fakeFetch(bytes: Buffer, status = 200) {
  return async () => new Response(status === 200 ? new Uint8Array(bytes) : null, { status });
}

/** run the adapter, then judge as the gateway does */
export async function scanAndJudge(bytes: Buffer, makeExecutor: (root: string) => ScanExecutor, opts: { fetchBytes?: Buffer; signal?: AbortSignal } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "b5m-"));
  try {
    const lease = leaseFor(bytes);
    const adapter = modelscanAdapter({ gatewayUrl: "http://gateway.test", token: async () => "rge_test", executor: makeExecutor(root), fetch: fakeFetch(opts.fetchBytes ?? bytes) });
    const body = await adapter(lease, { workDir: root, signal: opts.signal ?? new AbortController().signal, progress: () => undefined });
    const envelope: EngineResultEnvelope = engineResultEnvelopeSchema.parse({ version: ENGINE_RESULT_VERSION, runId: lease.runId, engineId: "modelscan", engineVersion: "0.8.8", ...body });
    const normalised = normaliseEngineResult({
      envelope,
      status: envelope.status,
      taxonomy: ENGINE_TAXONOMY,
      scrub: (t) => t,
      declaredNotRun: new Set(ENGINE_MANIFEST.modelscan.airGappedReducedSet.map((e) => e.key)),
    });
    // the gateway's own detection at upload is the stored format
    const stored = (await detectArtifactFormat(bufferReader(bytes))).format;
    const judged = deriveArtifactScanVerdict({
      storedFormat: stored,
      runStatus: envelope.status,
      runVerdict: normalised.verdict,
      runtimeNotRun: normalised.runtimeNotRun,
      items: normalised.items.map((i) => ({ key: i.key, sourceSystem: i.sourceSystem, sourceId: i.sourceId, verdict: i.verdict, severity: i.severity })),
    });
    return { envelope, normalised, judged, stored };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
