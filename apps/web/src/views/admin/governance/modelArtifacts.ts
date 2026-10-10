/**
 * ADR-0187 B5-M / X28 — model artifacts and their scans, as the page reads them.
 *
 * Three rules this module exists to keep, whatever the server sends:
 *
 *  - Only a VERIFIED SAFETENSORS file can read "clean" (owner decision
 *    2026-10-09, ADR-0187 decision 105). The page re-checks it: a scan the
 *    server calls clean is shown as clean only when its verdict is `clean`, it
 *    is admissible, its format and the artifact's are both `safetensors`, the
 *    artifact is not executable, and there is no finding. Anything else that
 *    claims clean is shown as inconclusive, with the reason.
 *  - Nothing that was not run, is unknown, or was never scanned reads as clean.
 *    An unrecognised verdict is inconclusive.
 *  - Every "why" is built from structured fields (verdict, format, finding kind,
 *    finding id, severity, run status, error code) as fixed sentences. No file
 *    content and no free text from the scanner is shown; a finding id is
 *    reduced to the gateway's own `[A-Za-z0-9_./-]` alphabet before display.
 */
import { apiErrorFrom, ApiError, CSRF_HEADER, type ApiErrorPayload } from "../../../api/client";

export type ArtifactScanVerdict = "clean" | "no_known_unsafe" | "unsafe" | "unknown" | "not_run";

export interface ModelArtifact {
  id: string;
  sha256: string;
  sizeBytes: number;
  /** decided from the BYTES at upload, never from the file name */
  format: string;
  executable: boolean;
  formatDescription: string | null;
  /** display only */
  filename: string;
  projectId: string | null;
  uploadedByUserId: string | null;
  createdAt: string;
}

export interface ArtifactScanFinding {
  kind: "unsafe_operator" | "executable_format" | "scan_error" | string;
  id: string;
  severity: string;
}

export interface ArtifactScan {
  id: string;
  artifactId: string;
  engineRunId: string | null;
  sha256: string;
  format: string;
  verdict: ArtifactScanVerdict | string;
  /** the gateway's fixed wording; never says "safe" */
  chip: string;
  admissible: boolean;
  findings: ArtifactScanFinding[];
  scannerVersion: string | null;
  createdAt: string;
}

export interface EngineRunLite {
  id: string;
  engineId: string;
  engineVersion: string | null;
  status: string;
  targetArtifactId: string | null;
  createdAt: string;
  finishedAt: string | null;
  errorCode: string | null;
}

/** the scanner engine this page starts; it is the only one that writes artifact scans */
export const SCAN_ENGINE_ID = "modelscan";
export const LIVE_RUN_STATUSES = ["awaiting_approval", "queued", "leased"] as const;
export const isLiveRun = (status: string) => (LIVE_RUN_STATUSES as readonly string[]).includes(status);

/** the gateway's chip wording (ARTIFACT_SCAN_CHIP); the page shows no other words for a verdict */
export const SCAN_CHIP: Record<ArtifactScanVerdict, string> = {
  clean: "Non-executable format verified; no finding",
  no_known_unsafe: "No known-unsafe operator found (executable format)",
  unsafe: "Unsafe operator found",
  unknown: "Scan inconclusive",
  not_run: "Not scanned (unsupported format)",
};
const KNOWN_VERDICTS = Object.keys(SCAN_CHIP) as ArtifactScanVerdict[];

/** the one format that can ever be clean */
export const CLEAN_CAPABLE_FORMAT = "safetensors";

/** readable names for the detected formats (the gateway's ArtifactFormat list) */
const FORMAT_NAME: Record<string, string> = {
  safetensors: "safetensors",
  safetensors_invalid: "safetensors (header did not verify)",
  pickle: "Python pickle",
  pytorch_legacy: "PyTorch (legacy layout)",
  pytorch_zip: "PyTorch (zip layout)",
  numpy: "NumPy .npy",
  numpy_npz: "NumPy .npz",
  keras_h5: "Keras H5",
  keras_v3: "Keras v3",
  zip: "zip archive",
  zip_opaque: "zip archive (nested or encrypted members)",
  gguf: "GGUF",
  compressed: "compressed stream",
  tar: "tar archive",
  empty: "empty file",
  unrecognised: "unrecognised",
};
export const formatName = (format: string) => FORMAT_NAME[format] ?? "unrecognised";

/** file extensions a name may carry, and the format each suggests (display only: the name decides nothing) */
const EXTENSION_SUGGESTS: Record<string, string> = {
  safetensors: "safetensors",
  pkl: "pickle",
  pickle: "pickle",
  joblib: "pickle",
  dill: "pickle",
  pt: "pytorch_zip",
  pth: "pytorch_zip",
  bin: "pytorch_legacy",
  npy: "numpy",
  npz: "numpy_npz",
  h5: "keras_h5",
  hdf5: "keras_h5",
  keras: "keras_v3",
  zip: "zip",
  gguf: "gguf",
  tar: "tar",
  gz: "compressed",
};
const PYTORCH = new Set(["pytorch_zip", "pytorch_legacy"]);

/**
 * When the file's NAME suggests one format and its CONTENT is another (a pickle
 * renamed `.safetensors`), say so. Null when the name suggests nothing or agrees.
 */
export function nameMismatch(a: Pick<ModelArtifact, "filename" | "format">): string | null {
  const ext = /\.([A-Za-z0-9]{1,12})$/.exec(a.filename)?.[1]?.toLowerCase();
  if (!ext) return null;
  const suggested = EXTENSION_SUGGESTS[ext];
  if (!suggested) return null;
  if (suggested === a.format) return null;
  if (PYTORCH.has(suggested) && PYTORCH.has(a.format)) return null;
  if (suggested === "zip" && (a.format === "zip_opaque" || a.format === "numpy_npz" || a.format === "pytorch_zip" || a.format === "keras_v3")) return null;
  if (suggested === "safetensors" && a.format === "safetensors_invalid") return null;
  return `The file name ends in .${ext}, but its content is ${formatName(a.format)}. The format is decided from the content; the name decides nothing.`;
}

/** a finding id reduced to the gateway's display alphabet, bounded */
export function safeFindingId(id: unknown): string {
  const s = typeof id === "string" ? id : "";
  const clean = s.replace(/[^A-Za-z0-9_./-]/g, "?").slice(0, 120);
  return clean.length ? clean : "?";
}

export type ScanTone = "ok" | "warn" | "danger" | "neutral";

export interface ScanStatus {
  /** the words shown: the gateway's chip for a consistent known verdict, else a fixed fallback */
  label: string;
  tone: ScanTone;
  /** true only for a scan that passes every clean check above */
  clean: boolean;
  /** may it pass an admission check? only when clean */
  admissible: boolean;
  /** the verdict this page acted on (`none` when there is no scan) */
  verdict: ArtifactScanVerdict | "none";
  /** fixed sentences from structured fields: why it is (or is not) clean */
  reasons: string[];
}

const FINDING_SENTENCE: Record<string, (f: ArtifactScanFinding) => string> = {
  unsafe_operator: (f) => `An unsafe operator was found: ${safeFindingId(f.id)} (${severityWord(f.severity)}).`,
  executable_format: (f) =>
    `${formatName(safeFindingId(f.id))} is an executable format: loading it can run code, so it can never be clean. A scan that finds nothing does not make it safe to load.`,
  scan_error: (f) => `The scanner reported an error (${safeFindingId(f.id)}), so the result is inconclusive.`,
};
function severityWord(s: unknown): string {
  return typeof s === "string" && /^(critical|high|medium|low|info)$/.test(s) ? s : "unrated";
}
export function findingKindLabel(kind: string): string {
  return kind === "unsafe_operator" ? "Unsafe operator" : kind === "executable_format" ? "Executable format" : kind === "scan_error" ? "Scan error" : "Other finding";
}
export function findingSentence(f: ArtifactScanFinding): string {
  return (FINDING_SENTENCE[f.kind] ?? ((x) => `A finding of an unrecognised kind was recorded (${safeFindingId(x.id)}); it is treated as not clean.`))(f);
}

/**
 * The status of an artifact from its latest scan. `scan` undefined = never
 * scanned. `artifact` (when known) is cross-checked: its format and its
 * executable flag must agree with a clean verdict.
 */
export function scanStatus(scan: ArtifactScan | null | undefined, artifact?: Pick<ModelArtifact, "format" | "executable"> | null): ScanStatus {
  if (!scan) {
    return { label: "Not scanned", tone: "neutral", clean: false, admissible: false, verdict: "none", reasons: ["No scan has been recorded for this artifact, so it is not clean."] };
  }
  const known = (KNOWN_VERDICTS as string[]).includes(scan.verdict);
  const verdict: ArtifactScanVerdict = known ? (scan.verdict as ArtifactScanVerdict) : "unknown";
  const findings = Array.isArray(scan.findings) ? scan.findings : [];
  const reasons = findings.map(findingSentence);

  if (verdict === "clean") {
    const problems: string[] = [];
    if (scan.admissible !== true) problems.push("the scan record is not marked admissible");
    if (scan.format !== CLEAN_CAPABLE_FORMAT) problems.push(`the scanned format is ${formatName(scan.format)}, and only verified safetensors can be clean`);
    if (artifact && artifact.format !== CLEAN_CAPABLE_FORMAT) problems.push(`the artifact's content is ${formatName(artifact.format)}, and only verified safetensors can be clean`);
    if (artifact && artifact.executable !== false) problems.push("the artifact's format is executable");
    if (findings.length > 0) problems.push("the scan carries findings");
    if (problems.length === 0) {
      return {
        label: SCAN_CHIP.clean,
        tone: "ok",
        clean: true,
        admissible: true,
        verdict,
        reasons: ["A verified safetensors file holds no code, and the scan recorded no finding. This is the only format that can be clean."],
      };
    }
    return {
      label: SCAN_CHIP.unknown,
      tone: "warn",
      clean: false,
      admissible: false,
      verdict: "unknown",
      reasons: [`The scan record is inconsistent (${problems.join("; ")}), so it is treated as inconclusive.`, ...reasons],
    };
  }

  if (!known) reasons.unshift("The scan returned a result this page does not recognise, so it is treated as inconclusive.");
  if (verdict === "not_run") reasons.unshift(`This format (${formatName(scan.format)}) is not supported by the scanner, so it was not scanned and cannot be clean.`);
  if (verdict === "unknown" && reasons.length === 0) reasons.push("The scan did not complete, or its result could not be confirmed, so it is inconclusive.");
  if (verdict === "no_known_unsafe" && !findings.some((f) => f.kind === "executable_format")) {
    reasons.push(`${formatName(scan.format)} is an executable format: no known-unsafe operator was found, but that does not make it safe to load.`);
  }
  if (verdict === "unsafe" && !findings.some((f) => f.kind === "unsafe_operator")) reasons.unshift("The scan found an unsafe operator.");
  const tone: ScanTone = verdict === "unsafe" ? "danger" : verdict === "not_run" ? "neutral" : "warn";
  return { label: known ? SCAN_CHIP[verdict] : SCAN_CHIP.unknown, tone, clean: false, admissible: false, verdict, reasons };
}

/** a short word for the status, shown beside the chip so tone is never the only signal */
export function statusWord(s: ScanStatus): string {
  if (s.clean) return "Clean";
  if (s.verdict === "unsafe") return "Unsafe";
  if (s.verdict === "none") return "Not scanned";
  return "Not clean";
}

/** the newest scan (the gateway orders newest first; this does not trust that) */
export function latestScan(scans: ArtifactScan[] | undefined): ArtifactScan | null {
  if (!scans || scans.length === 0) return null;
  return [...scans].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))[0] ?? null;
}

/** a run's status as words (structured: status + error code only) */
export function runStatusText(run: Pick<EngineRunLite, "status" | "errorCode">): string {
  const base: Record<string, string> = {
    awaiting_approval: "Waiting for approval",
    queued: "Queued — waiting for a scanner",
    leased: "Scanning",
    completed: "Finished",
    failed: "Failed",
    timeout: "Timed out",
    cancelled: "Cancelled",
    not_run: "Not run",
  };
  const head = base[run.status] ?? "Unknown status";
  return run.errorCode ? `${head} (${run.errorCode.replace(/[^a-z0-9_]/g, "").slice(0, 64)})` : head;
}

// ---- sizes ----------------------------------------------------------------

export const MIB = 1024 * 1024;
/** the strict shipped default of `modelArtifactMaxMegabytes`, used until the org's value is read */
export const DEFAULT_MAX_MEGABYTES = 512;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < MIB) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * MIB) return `${(n / MIB).toFixed(1)} MiB`;
  return `${(n / (1024 * MIB)).toFixed(2)} GiB`;
}

/** null when the file may be sent; else why it is refused before any byte leaves the browser */
export function preUploadRefusal(size: number, maxMegabytes: number): string | null {
  if (size > maxMegabytes * MIB) {
    return `This file is ${formatBytes(size)}; the limit is ${maxMegabytes} MiB. Nothing was sent. An admin may raise the limit in settings (the change needs a step-up).`;
  }
  return null;
}

// ---- refusals ---------------------------------------------------------------

/** the artifact and scan refusals as sentences; anything else falls back to the client's own wording */
const REFUSAL_SENTENCE: Record<string, string> = {
  artifact_too_large: "The file is over the organisation's model-artifact size limit, so nothing of it was kept.",
  artifact_store_unavailable: "This deployment has no model-artifact store configured, so uploads are refused. Ask the operator to configure one.",
  artifact_content_type: "The upload was not sent as raw bytes, so it was refused.",
  artifact_not_accessible: "Only the person who uploaded this artifact, or an admin, can scan it.",
  unknown_artifact: "This artifact no longer exists, or you cannot see it.",
  engine_disabled: "The modelscan engine is switched off on this deployment, so no scan can start. An admin can enable it on the Engines page once its self-test passes.",
  engine_manifest_outdated: "This gateway is running an older engine manifest than the database records. Try again shortly.",
  engine_target_mismatch: "modelscan scans a model artifact; this target is not one.",
  engine_config_invalid: "The scan request was refused as invalid.",
  engine_approver_required: "This scan needs an approver before it can run.",
  human_required: "An artifact must be uploaded by a signed-in person.",
};

export function refusalText(e: unknown): string {
  if (e instanceof ApiError) {
    const code = typeof e.payload.error === "string" ? e.payload.error : "";
    const sentence = REFUSAL_SENTENCE[code];
    if (sentence) {
      const detail = code === "artifact_too_large" && typeof e.payload.detail === "string" ? ` (${e.payload.detail.replace(/[^\x20-\x7e]/g, "").slice(0, 160)})` : "";
      return sentence + detail;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---- the upload -------------------------------------------------------------

export interface UploadOptions {
  filename: string;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  /** a test injects its own XMLHttpRequest */
  xhr?: () => XMLHttpRequest;
}

/** the upload's URL: the name is display only, so it travels as a query parameter */
export function uploadPath(filename: string): string {
  const name = filename.split(/[\\/]/).pop()?.trim().slice(0, 255) || "artifact";
  return `/v1/model-artifacts?filename=${encodeURIComponent(name)}`;
}

/**
 * POST the file's raw bytes as `application/octet-stream`, reporting progress.
 * XMLHttpRequest because `fetch` cannot report upload progress. The session
 * cookie and the CSRF header ride exactly as on every other call; a refusal is
 * the same ApiError (and the same 401 handling) as `api.post`.
 */
export function uploadModelArtifact(file: Blob, opts: UploadOptions): Promise<{ artifact: ModelArtifact }> {
  const path = uploadPath(opts.filename);
  return new Promise((resolve, reject) => {
    const xhr = opts.xhr ? opts.xhr() : new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader(CSRF_HEADER, "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (ev) => opts.onProgress?.(ev.loaded, ev.lengthComputable ? ev.total : file.size);
    xhr.onload = () => {
      let payload: ApiErrorPayload | null = null;
      const text = typeof xhr.responseText === "string" ? xhr.responseText : "";
      if (text) {
        try {
          payload = JSON.parse(text) as ApiErrorPayload;
        } catch {
          payload = { raw: text.slice(0, 200) };
        }
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload && typeof payload === "object" && "artifact" in payload) {
        resolve(payload as unknown as { artifact: ModelArtifact });
        return;
      }
      reject(apiErrorFrom("POST", path, xhr.status || 0, payload));
    };
    xhr.onerror = () =>
      reject(
        new Error(
          "The upload was cut off before the server answered. The file may be over the size limit, or the connection dropped. Nothing is recorded unless the artifact appears in the list.",
        ),
      );
    xhr.onabort = () => reject(new Error("Upload cancelled. Check the list: an artifact is recorded only if the server received the whole file."));
    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
        return;
      }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}
