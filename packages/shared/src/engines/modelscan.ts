/**
 * ADR-0187 B5-M — THE MODEL-SCANNER CONTRACT (PF-12), pure half: what a model artifact really is,
 * what modelscan is asked to do with it, how its report becomes an envelope, and what the artifact's
 * scan verdict may be. Shared by the gateway (upload, verdict) and the modelscan runner (scan, map).
 *
 * WHY THE FORMAT IS OURS (R10, G19 "Consequences for B5-M" 2). modelscan 0.8.8 chooses a scanner by
 * the file's EXTENSION: a pickle named `.safetensors` is skipped and the run exits "nothing scanned".
 * So the format is decided here from the bytes (magic numbers, the zip central directory, the
 * safetensors header), never from the name, and modelscan is handed the file under the extension of
 * its real format (`ARTIFACT_FORMAT_PLANS[format].scanAs`). A legacy-layout PyTorch file is handed
 * over as `.pkl`, because modelscan's PyTorch scanner reads only the first (magic-number) pickle of
 * that layout and its pickle scanner reads every pickle in the stream (measured: a legacy `.pt` with
 * `os.system` in its third pickle exits 0 clean as `.pt` and 1 with the issue as `.pkl`).
 *
 * WHAT CLEAN MEANS: SAFE FORMATS ONLY (owner decision, 2026-10-09; ADR-0187 decision 105). modelscan is
 * one signal and a deny-list: it cannot certify that an executable format is safe to load. So:
 *   - a pickle-family artifact (pickle, legacy or zip PyTorch, joblib, numpy, Keras H5) can never
 *     reach `clean`: at best `no_known_unsafe` ("no known-unsafe operator found") together with an
 *     explicit `executable_format` finding;
 *   - only a non-executable format verified by its own structure (safetensors: magic and header
 *     parse, every tensor's offsets covering the data exactly) can be `clean`;
 *   - anything not recognised, opaque (nested or encrypted archive members) or partly unreadable is
 *     `unknown`; an unsupported format is `not_run`. Nothing here ever says "safe".
 *
 * The mapper reads only modelscan's `-o` JSON report and its exit code, never stdout (G19 3).
 */
import { parse as parseJsonSyntax, type ValueNode } from "@humanwhocodes/momoa";
import { z } from "zod";
import type { EngineItemVerdict, EngineNotRunReason, EngineResultEnvelope, EngineResultItem, EngineTerminalRunStatus } from "./contract.js";
import type { RedTeamSeverity } from "../redteam.js";

/** the modelscan release the image is built from (engines/modelscan/requirements.txt pins it by hash) */
export const MODELSCAN_ENGINE_VERSION = "0.8.8";

// ---------------------------------------------------------------------------
// Formats (model_artifacts.format; migration 0175 keeps the CHECK in lockstep)
// ---------------------------------------------------------------------------

export const ARTIFACT_FORMATS = [
  "safetensors",
  "safetensors_invalid",
  "pickle",
  "pytorch_legacy",
  "pytorch_zip",
  "numpy",
  "numpy_npz",
  "keras_h5",
  "keras_v3",
  "zip",
  "zip_opaque",
  "gguf",
  "compressed",
  "tar",
  "empty",
  "unrecognised",
] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

/** the extension modelscan is handed (its dispatch is by extension; ours is chosen from content) */
export type ModelscanScanExtension = ".pkl" | ".pt" | ".npy" | ".zip" | ".h5";

/** the best artifact-scan verdict a format can ever reach */
export type ArtifactVerdictCeiling = "clean" | "no_known_unsafe" | "unknown" | "not_run";

export interface ArtifactFormatPlan {
  /** handed to modelscan under this extension, or null (not scanned by modelscan) */
  scanAs: ModelscanScanExtension | null;
  /** loading it can run code (or we cannot tell that it cannot): never `clean` */
  executable: boolean;
  ceiling: ArtifactVerdictCeiling;
  /** a sentence for the record */
  describe: string;
}

/**
 * THE RULE (PR #212 review [4234946089], ADR-0187 decision 123): anything not POSITIVELY proven to be
 * safetensors (magic and a verified header) is treated as executable, so its scan carries an
 * `executable_format` finding. Only `safetensors` is non-executable.
 */
export const ARTIFACT_FORMAT_PLANS: Readonly<Record<ArtifactFormat, ArtifactFormatPlan>> = Object.freeze({
  safetensors: { scanAs: null, executable: false, ceiling: "clean", describe: "safetensors: a JSON header and raw tensor bytes; it holds no code" },
  safetensors_invalid: {
    scanAs: null,
    // [4234946089]: a safetensors prefix whose header does not verify is NOT proven safetensors
    executable: true,
    ceiling: "unknown",
    describe: "looks like safetensors but its header does not verify (dtype, shapes or offsets do not account for the data exactly)",
  },
  pickle: { scanAs: ".pkl", executable: true, ceiling: "no_known_unsafe", describe: "a Python pickle (also joblib and dill): loading it runs code" },
  pytorch_legacy: {
    scanAs: ".pkl",
    executable: true,
    ceiling: "no_known_unsafe",
    describe: "a legacy-layout PyTorch file (a sequence of pickles): loading it runs code; scanned as a pickle stream so every pickle is read",
  },
  pytorch_zip: { scanAs: ".pt", executable: true, ceiling: "no_known_unsafe", describe: "a zip-layout PyTorch checkpoint (data.pkl inside): loading it runs code" },
  numpy: { scanAs: ".npy", executable: true, ceiling: "no_known_unsafe", describe: "a NumPy .npy array (object arrays are pickles)" },
  numpy_npz: { scanAs: ".zip", executable: true, ceiling: "no_known_unsafe", describe: "a NumPy .npz archive of .npy members" },
  keras_h5: { scanAs: ".h5", executable: true, ceiling: "no_known_unsafe", describe: "an HDF5 (Keras H5) model: Lambda layers carry code" },
  keras_v3: { scanAs: null, executable: true, ceiling: "not_run", describe: "a Keras v3 archive: its scanner needs TensorFlow, which this image does not ship" },
  zip: { scanAs: ".zip", executable: true, ceiling: "unknown", describe: "a zip archive of unrecognised layout: members are scanned by name only" },
  zip_opaque: { scanAs: ".zip", executable: true, ceiling: "unknown", describe: "a zip archive with nested archives or encrypted members, which are not scanned" },
  gguf: { scanAs: null, executable: true, ceiling: "not_run", describe: "a GGUF file: no scanner for it in this build" },
  compressed: { scanAs: null, executable: true, ceiling: "not_run", describe: "a compressed stream (gzip, zlib, bz2, xz, zstd, lz4): not decompressed or scanned" },
  tar: { scanAs: null, executable: true, ceiling: "not_run", describe: "a tar archive: not scanned" },
  empty: { scanAs: null, executable: true, ceiling: "not_run", describe: "an empty file" },
  unrecognised: {
    scanAs: ".pkl",
    executable: true,
    ceiling: "unknown",
    describe: "no known signature (old pickle protocols have none): scanned as a pickle, and never better than unknown",
  },
});

/** the file name the scanner gives the artifact (fixed; the uploaded name is never used) */
export function modelscanArtifactName(format: ArtifactFormat): string | null {
  const ext = ARTIFACT_FORMAT_PLANS[format].scanAs;
  return ext ? `artifact${ext}` : null;
}

// ---------------------------------------------------------------------------
// Detection from content
// ---------------------------------------------------------------------------

/** random access to the artifact's bytes (a file on the gateway or in the runner) */
export interface ArtifactReader {
  size: number;
  /** up to `length` bytes at `offset` (fewer at the end of the file) */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export const ARTIFACT_DETECTION_LIMITS = {
  /** a safetensors header larger than this is not parsed (real headers are kilobytes to a few MB) */
  maxSafetensorsHeaderBytes: 32 * 1024 * 1024,
  maxSafetensorsTensors: 1_000_000,
  /** a zip central directory larger than this is not walked (the archive is opaque) */
  maxZipCentralDirectoryBytes: 64 * 1024 * 1024,
  maxZipEntries: 1_000_000,
} as const;

export interface ArtifactDetection {
  format: ArtifactFormat;
  /** what decided it, for the record (no artifact text) */
  evidence: string;
  /** safetensors: the tensor count; zips: the member count */
  count?: number;
}

const bytesEq = (b: Uint8Array, at: number, sig: readonly number[]) => sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const SIG = {
  zipLocal: [0x50, 0x4b, 0x03, 0x04],
  zipEmpty: [0x50, 0x4b, 0x05, 0x06],
  hdf5: [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a],
  numpy: [0x93, ...ascii("NUMPY")],
  gguf: ascii("GGUF"),
  gzip: [0x1f, 0x8b],
  bzip2: ascii("BZh"),
  xz: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  zstd: [0x28, 0xb5, 0x2f, 0xfd],
  lz4: [0x04, 0x22, 0x4d, 0x18],
  /** PyTorch's legacy magic number 0x1950a86a20f9469cfc6c as a pickled LONG1 (10 bytes, little-endian) */
  torchLegacyMagic: [0x8a, 0x0a, 0x6c, 0xfc, 0x9c, 0x46, 0xf9, 0x20, 0x6a, 0xa8, 0x50, 0x19, 0x2e],
} as const;

/**
 * Where an HDF5 superblock may start: offset 0, then every power of two from 512 (a user block of any
 * power-of-two size, as the HDF5 library itself searches) while the 8-byte signature still fits in the
 * file. PR #212 review [4235322383] (ADR-0187 decision 131): the probe stopped at 2048, so a header behind
 * a larger user block read `unrecognised`. The bound is THE FILE SIZE, so every offset the library
 * would accept is probed; that is at most 24 reads of 8 bytes for the 8 GiB upload ceiling (2^33),
 * and never more than 54 for any size a reader can report.
 */
export function hdf5SuperblockOffsets(size: number): number[] {
  const out = size >= 8 ? [0] : [];
  for (let at = 512; at + 8 <= size && at <= Number.MAX_SAFE_INTEGER / 2; at *= 2) out.push(at);
  return out;
}

/**
 * What the artifact really is, from its bytes. Order matters: a pickle is recognised before anything
 * that could be parsed out of its tail; a zip is classified from its central directory; safetensors
 * only when its header verifies. No extension is consulted anywhere.
 */
export async function detectArtifactFormat(reader: ArtifactReader): Promise<ArtifactDetection> {
  if (reader.size === 0) return { format: "empty", evidence: "zero bytes" };
  const head = await reader.read(0, 4096);
  // pickle protocol 2-5 starts PROTO <n>; PyTorch's legacy layout starts with the magic-number pickle
  if (head[0] === 0x80 && head[1]! >= 2 && head[1]! <= 5) {
    if (bytesEq(head, 2, SIG.torchLegacyMagic)) return { format: "pytorch_legacy", evidence: "pickle PROTO opcode followed by PyTorch's legacy magic number" };
    return { format: "pickle", evidence: `pickle PROTO opcode, protocol ${head[1]}` };
  }
  if (bytesEq(head, 0, SIG.zipLocal) || bytesEq(head, 0, SIG.zipEmpty)) return classifyZip(reader);
  for (const at of hdf5SuperblockOffsets(reader.size)) {
    if (at === 0 ? bytesEq(head, 0, SIG.hdf5) : bytesEq(await reader.read(at, 8), 0, SIG.hdf5)) {
      return { format: "keras_h5", evidence: `HDF5 superblock signature at offset ${at}` };
    }
  }
  if (bytesEq(head, 0, SIG.numpy)) return { format: "numpy", evidence: "NumPy .npy magic" };
  if (bytesEq(head, 0, SIG.gguf)) return { format: "gguf", evidence: "GGUF magic" };
  if (
    bytesEq(head, 0, SIG.gzip) ||
    bytesEq(head, 0, SIG.bzip2) ||
    bytesEq(head, 0, SIG.xz) ||
    bytesEq(head, 0, SIG.zstd) ||
    bytesEq(head, 0, SIG.lz4) ||
    (head[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(head[1]!))
  ) {
    return { format: "compressed", evidence: "a compression container signature" };
  }
  if (reader.size >= 262 && bytesEq(head, 257, ascii("ustar"))) return { format: "tar", evidence: "ustar signature at offset 257" };
  const st = await verifySafetensors(reader, head);
  if (st) return st;
  return { format: "unrecognised", evidence: "no known signature" };
}

const SAFETENSORS_DTYPE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  BOOL: 1,
  U8: 1,
  I8: 1,
  F8_E5M2: 1,
  F8_E4M3: 1,
  F8_E8M0: 1,
  I16: 2,
  U16: 2,
  F16: 2,
  BF16: 2,
  I32: 4,
  U32: 4,
  F32: 4,
  I64: 8,
  U64: 8,
  F64: 8,
  C64: 8,
});

function u64le(b: Uint8Array, at: number): number {
  let n = 0;
  for (let i = 7; i >= 0; i--) n = n * 256 + b[at + i]!;
  return n;
}

/**
 * Does any JSON object in `text` name the same key twice (compared after unescaping, as a parser sees
 * it: `"w"` and `"w"` are the same key; `"a\"b"` and `"a\\b"` are not)? Read from momoa's syntax
 * tree, which keeps every member, walked without recursion. Throws on text that is not JSON.
 * Open-source check (ADR-0176): `@humanwhocodes/momoa` 3.3.13 (Apache-2.0, no dependencies, no
 * network) reports every member; JSON.parse silently keeps the last.
 */
export function jsonHasDuplicateKey(text: string): boolean {
  const stack: ValueNode[] = [parseJsonSyntax(text, { mode: "json" }).body];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "Object") {
      const seen = new Set<string>();
      for (const m of node.members) {
        const key = m.name.type === "String" ? m.name.value : m.name.name;
        if (seen.has(key)) return true;
        seen.add(key);
        stack.push(m.value);
      }
    } else if (node.type === "Array") {
      for (const el of node.elements) stack.push(el.value);
    }
  }
  return false;
}

/**
 * A safetensors file: an 8-byte little-endian header length N, N bytes of JSON, then the data. It is
 * a CANDIDATE when N is plausible and the header starts with `{`; it is `safetensors` only when the
 * header is valid UTF-8 JSON, every entry is `{dtype, shape, data_offsets}` with a known byte-sized
 * dtype, each tensor's byte length is exactly its shape times its dtype size, and the offsets tile the
 * data from 0 to its end with no gap and no overlap (the format's own rule). A candidate that fails
 * any of these is `safetensors_invalid` (unknown); a non-candidate returns null.
 */
export async function verifySafetensors(reader: ArtifactReader, head?: Uint8Array): Promise<ArtifactDetection | null> {
  if (reader.size < 10) return null;
  const h = head ?? (await reader.read(0, 4096));
  const n = u64le(h, 0);
  if (!Number.isSafeInteger(n) || n < 2 || n > reader.size - 8 || h[8] !== 0x7b) return null;
  const invalid = (why: string): ArtifactDetection => ({ format: "safetensors_invalid", evidence: why });
  if (n > ARTIFACT_DETECTION_LIMITS.maxSafetensorsHeaderBytes) return invalid("header larger than the parse limit");
  const raw = n + 8 <= h.length ? h.subarray(8, 8 + n) : await reader.read(8, n);
  if (raw.length !== n) return invalid("header shorter than its declared length");
  let parsed: unknown;
  let duplicate: boolean;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    duplicate = jsonHasDuplicateKey(text);
    parsed = JSON.parse(text);
  } catch {
    return invalid("header is not valid UTF-8 JSON");
  }
  // Codex review B5X-01 (ADR-0187 decision 132): JSON.parse keeps the LAST of two equal keys, so a
  // duplicate could hide a tensor or field the reference parser judges; any duplicate, at any level
  // (tensor names, a tensor's fields, `__metadata__` and its keys), is refused
  if (duplicate) return invalid("the header repeats a key in one object");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid("header is not a JSON object");
  const dataBytes = reader.size - 8 - n;
  const spans: Array<[number, number]> = [];
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (name === "__metadata__") {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry) || Object.values(entry).some((v) => typeof v !== "string")) {
        return invalid("__metadata__ is not a map of strings");
      }
      continue;
    }
    if (spans.length >= ARTIFACT_DETECTION_LIMITS.maxSafetensorsTensors) return invalid("too many tensors");
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return invalid("a tensor entry is not an object");
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "data_offsets,dtype,shape") return invalid("a tensor entry has fields other than dtype, shape and data_offsets");
    const size = typeof e.dtype === "string" && Object.prototype.hasOwnProperty.call(SAFETENSORS_DTYPE_BYTES, e.dtype) ? SAFETENSORS_DTYPE_BYTES[e.dtype]! : null;
    if (size === null) return invalid("a tensor has an unknown or sub-byte dtype");
    if (!Array.isArray(e.shape) || !e.shape.every((d) => Number.isSafeInteger(d) && (d as number) >= 0)) return invalid("a tensor shape is not a list of non-negative integers");
    const off = e.data_offsets;
    if (!Array.isArray(off) || off.length !== 2 || !off.every((d) => Number.isSafeInteger(d) && (d as number) >= 0)) return invalid("a tensor's data_offsets are not two non-negative integers");
    const [b, en] = off as [number, number];
    if (en < b) return invalid("a tensor's data_offsets run backwards");
    const elements = (e.shape as number[]).reduce((a, d) => a * d, 1);
    if (!Number.isSafeInteger(elements * size) || elements * size !== en - b) return invalid("a tensor's byte length is not its shape times its dtype size");
    spans.push([b, en]);
  }
  spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cursor = 0;
  for (const [b, en] of spans) {
    if (b !== cursor) return invalid(b < cursor ? "tensor data overlaps" : "the data has a gap no tensor accounts for");
    cursor = en;
  }
  if (cursor !== dataBytes) return invalid("the tensors do not account for the data exactly (trailing bytes or a short file)");
  return { format: "safetensors", evidence: "safetensors header verified", count: spans.length };
}

/** names that make a zip member an archive of its own (nested; modelscan does not open them) */
const NESTED_ARCHIVE_NAME = /\.(zip|npz|jar|whl|pt|pth|ckpt|keras|tar|tgz|gz|bz2|xz|zst|7z|rar)$/i;

async function classifyZip(reader: ArtifactReader): Promise<ArtifactDetection> {
  const opaque = (why: string, count?: number): ArtifactDetection => ({ format: "zip_opaque", evidence: why, ...(count !== undefined ? { count } : {}) });
  const tailLen = Math.min(reader.size, 22 + 65_535);
  const tail = await reader.read(reader.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return opaque("no end-of-central-directory record");
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let entries = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // zip64: the locator sits just before the EOCD
    const locAt = reader.size - tailLen + eocd - 20;
    if (locAt < 0) return opaque("zip64 locator missing");
    const loc = await reader.read(locAt, 20);
    if (!bytesEq(loc, 0, [0x50, 0x4b, 0x06, 0x07])) return opaque("zip64 locator missing");
    const z64At = u64le(loc, 8);
    if (!Number.isSafeInteger(z64At) || z64At + 56 > reader.size) return opaque("zip64 record out of range");
    const z = await reader.read(z64At, 56);
    if (!bytesEq(z, 0, [0x50, 0x4b, 0x06, 0x06])) return opaque("zip64 record missing");
    entries = u64le(z, 32);
    cdSize = u64le(z, 40);
    cdOffset = u64le(z, 48);
  }
  if (!Number.isSafeInteger(entries) || entries > ARTIFACT_DETECTION_LIMITS.maxZipEntries) return opaque("too many members");
  if (!Number.isSafeInteger(cdSize) || cdSize > ARTIFACT_DETECTION_LIMITS.maxZipCentralDirectoryBytes) return opaque("central directory too large");
  if (!Number.isSafeInteger(cdOffset) || cdOffset + cdSize > reader.size) return opaque("central directory out of range");
  const cd = await reader.read(cdOffset, cdSize);
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const names: string[] = [];
  let p = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > cd.length || !bytesEq(cd, p, [0x50, 0x4b, 0x01, 0x02])) return opaque("central directory entry malformed", names.length);
    const flags = cdv.getUint16(p + 8, true);
    const nameLen = cdv.getUint16(p + 28, true);
    const extraLen = cdv.getUint16(p + 30, true);
    const commentLen = cdv.getUint16(p + 32, true);
    if (p + 46 + nameLen > cd.length) return opaque("central directory entry malformed", names.length);
    const name = new TextDecoder("utf-8").decode(cd.subarray(p + 46, p + 46 + nameLen));
    if (flags & 0x1) return opaque("an encrypted member", entries);
    if (NESTED_ARCHIVE_NAME.test(name)) return opaque("a nested archive member", entries);
    names.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  const files = names.filter((n) => !n.endsWith("/"));
  if (files.some((n) => /(^|\/)data\.pkl$/.test(n))) return { format: "pytorch_zip", evidence: "zip with a data.pkl member (PyTorch layout)", count: files.length };
  if (files.includes("config.json") && (files.includes("model.weights.h5") || files.includes("metadata.json"))) {
    return { format: "keras_v3", evidence: "zip with config.json and Keras v3 members", count: files.length };
  }
  if (files.length > 0 && files.every((n) => n.endsWith(".npy"))) return { format: "numpy_npz", evidence: "zip of .npy members", count: files.length };
  return { format: "zip", evidence: "zip of unrecognised layout", count: files.length };
}

// ---------------------------------------------------------------------------
// The modelscan report (-r json -o <file>), as 0.8.8 writes it (R10)
// ---------------------------------------------------------------------------

export const MODELSCAN_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const modelscanReportSchema = z.object({
  summary: z.object({
    total_issues_by_severity: z.record(z.string(), z.number().int().min(0)).optional(),
    total_issues: z.number().int().min(0),
    modelscan_version: z.string(),
    scanned: z.object({ total_scanned: z.number().int().min(0), scanned_files: z.array(z.string()).optional() }),
    skipped: z
      .object({
        total_skipped: z.number().int().min(0),
        skipped_files: z.array(z.object({ category: z.string(), description: z.string(), source: z.string() })).optional(),
      })
      .optional(),
  }),
  issues: z.array(
    z.object({ description: z.string(), operator: z.string(), module: z.string(), source: z.string(), scanner: z.string(), severity: z.enum(MODELSCAN_SEVERITIES) }),
  ),
  errors: z.array(z.object({ category: z.string(), description: z.string(), source: z.string().optional() })),
});
export type ModelscanReport = z.infer<typeof modelscanReportSchema>;

/** modelscan's documented exit codes (R10): 0 clean, 1 issues, 2 errors, 3 nothing scanned, 4 usage */
export const MODELSCAN_EXIT = { clean: 0, issues: 1, errors: 2, nothingScanned: 3, usage: 4 } as const;

/** the largest report the runner reads (a report lists issues and errors, not data) */
export const MODELSCAN_MAX_REPORT_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The .npy header check (ADR-0187 decisions 180–184; closes open question 15(b))
// ---------------------------------------------------------------------------

/**
 * Every answer the scanner's header check (engines/modelscan/npy-header.py) can give for a refused
 * `.npy`, plus `npy_check_failed` (the check itself did not answer). Each one reads `unknown`.
 */
export const NPY_PROBLEMS = [
  "npy_truncated",
  "npy_magic_invalid",
  "npy_version_unsupported",
  "npy_header_length",
  "npy_header_encoding",
  "npy_header_not_literal",
  "npy_header_keys",
  "npy_header_value",
  "npy_dtype_unsupported",
  "npy_trailing_bytes",
  "npy_payload_too_large",
  "npy_check_failed",
] as const;
export type NpyProblem = (typeof NPY_PROBLEMS)[number];

/** the header check's one answer: a numeric array (no pickle), an object array (its payload is a pickle), or refused */
export const npyCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("numeric") }).strict(),
  z.object({ kind: z.literal("object"), payloadBytes: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("invalid"), problem: z.enum(NPY_PROBLEMS) }).strict(),
]);
export type NpyCheck = z.infer<typeof npyCheckSchema>;

/** an object array's payload is handed to modelscan's PICKLE scanner under this name */
export const NPY_OBJECT_PAYLOAD_NAME = "artifact.pkl";

/**
 * The largest object-array payload the scanner copies out for modelscan (larger: `npy_payload_too_large`,
 * unknown). The copy lands on the result volume, a 64 MiB tmpfs that also holds the report (at most 4 MiB).
 */
export const NPY_OBJECT_PAYLOAD_MAX_BYTES = 48 * 1024 * 1024;

/**
 * PR #212 review [4234946100]: does the report's summary disagree with its own lists? `total_issues`
 * and the per-severity counts against `issues[]`; `total_scanned` against `scanned_files`;
 * `total_skipped` against `skipped_files` (always listed: the runner passes --show-skipped). A fixed
 * sentence naming the disagreement, or null.
 */
export function modelscanSummaryProblem(report: ModelscanReport): string | null {
  const s = report.summary;
  if (s.total_issues !== report.issues.length) return "total_issues does not match the issues listed";
  if (s.total_issues_by_severity) {
    for (const sev of MODELSCAN_SEVERITIES) {
      const listed = report.issues.filter((i) => i.severity === sev).length;
      if ((s.total_issues_by_severity[sev] ?? 0) !== listed) return `the ${sev} count does not match the issues listed`;
    }
    if (Object.keys(s.total_issues_by_severity).some((k) => !(MODELSCAN_SEVERITIES as readonly string[]).includes(k))) return "an unknown severity is counted";
  }
  if (s.scanned.total_scanned !== (s.scanned.scanned_files ?? []).length) return "total_scanned does not match the files listed";
  if (!s.skipped) return "the skipped files are not listed";
  if (s.skipped.total_skipped !== (s.skipped.skipped_files ?? []).length) return "total_skipped does not match the files listed";
  return null;
}

/** the not-run keys this engine declares before any run (the manifest's reduced set) */
export const MODELSCAN_FORMAT_ITEM_KEY = "format";
export const MODELSCAN_SCAN_ITEM_KEY = "modelscan/scan";
export const MODELSCAN_ISSUE_SYSTEM = "modelscan-operator";
export const MODELSCAN_ERROR_SYSTEM = "modelscan-error";
export const ARTIFACT_FORMAT_SYSTEM = "regulait-artifact-format";

/** an artifact-controlled string reduced to a safe identifier (module.operator names, member paths) */
export function safeIdent(s: string, max = 120): string {
  const t = s.replace(/[^A-Za-z0-9_.\/-]/g, "?").slice(0, max);
  return t.length ? t : "?";
}

const SEVERITY: Readonly<Record<(typeof MODELSCAN_SEVERITIES)[number], RedTeamSeverity>> = { LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical" };

export type ModelscanEnvelopeBody = Omit<EngineResultEnvelope, "version" | "runId" | "engineId" | "engineVersion">;

function item(key: string, system: string, id: string, severity: RedTeamSeverity, attempts: number, defeated: number, verdict: EngineItemVerdict, reason: string): EngineResultItem {
  return { key, sourceTaxonomy: { system, id }, mappedClass: null, severity, attempts, defeated, verdict, reason, dispatchAuditIds: [] };
}

/** the format item every envelope carries: the format as the RUNNER detected it (the gateway compares) */
export function formatItem(format: ArtifactFormat, detail?: string): { item: EngineResultItem; notRun: Array<{ key: string; reason: EngineNotRunReason }> } {
  const plan = ARTIFACT_FORMAT_PLANS[format];
  if (plan.ceiling === "not_run") {
    return {
      item: item(MODELSCAN_FORMAT_ITEM_KEY, ARTIFACT_FORMAT_SYSTEM, format, "low", 0, 0, "not_run", `${plan.describe}; not scanned (unsupported format)`),
      notRun: [
        { key: MODELSCAN_FORMAT_ITEM_KEY, reason: "unsupported_format" },
        { key: MODELSCAN_SCAN_ITEM_KEY, reason: "unsupported_format" },
      ],
    };
  }
  if (plan.executable) {
    // owner decision 2026-10-09 (ADR-0187 decision 105): an executable format is a finding of its own
    return {
      item: item(
        MODELSCAN_FORMAT_ITEM_KEY,
        ARTIFACT_FORMAT_SYSTEM,
        format,
        "high",
        1,
        1,
        "fail",
        `executable format: ${plan.describe}. A scan that finds no known-unsafe operator does not make it safe to load`,
      ),
      notRun: [],
    };
  }
  if (format === "safetensors") {
    return {
      item: item(MODELSCAN_FORMAT_ITEM_KEY, ARTIFACT_FORMAT_SYSTEM, format, "low", 1, 0, "pass", `non-executable format verified: ${detail ?? "safetensors header verified"}`),
      // modelscan has no safetensors scanner: declared before any run
      notRun: [{ key: MODELSCAN_SCAN_ITEM_KEY, reason: "unsupported_format" }],
    };
  }
  return { item: item(MODELSCAN_FORMAT_ITEM_KEY, ARTIFACT_FORMAT_SYSTEM, format, "medium", 0, 0, "unknown", plan.describe), notRun: [] };
}

/**
 * Map one modelscan invocation into an envelope body. Inputs are the format the RUNNER detected, the
 * exit code, whether the runner killed it at its time limit, and the bytes of the `-o` report (null
 * when there is none). Rules (G19 "Consequences for B5-M" 3):
 *   - every `issues[]` entry is a finding (fail), whatever the exit code and however the run ended;
 *   - any `errors[]` entry makes the scan `unknown`;
 *   - an empty `scanned_files` makes the scan not run (`engine_error`, a run-time not-run);
 *   - exit 4, a missing, oversized or unparsable report, or a timeout: the run failed (`engine_error`
 *     / `engine_timeout` / `report_*`) and every reading is unknown;
 *   - a report naming a file other than the one handed over, or an exit code the report contradicts,
 *     fails the run (`report_inconsistent`), its findings still kept.
 * No artifact text is copied: operator names and member paths are reduced by `safeIdent`, error
 * descriptions are dropped, and every reason is a fixed sentence.
 */
export function mapModelscanReport(input: {
  format: ArtifactFormat;
  formatDetail?: string;
  exitCode: number | null;
  timedOut: boolean;
  /** the report's bytes; null = none written; "too_large" = over MODELSCAN_MAX_REPORT_BYTES, never read */
  report: Uint8Array | null | "too_large";
  /** sha256 of the report bytes, recorded as the raw report (nothing attached) */
  reportSha256?: string | null;
  /** the scanner's `.npy` header check (decisions 180–184); read only for the `numpy` format */
  npy?: NpyCheck | null;
}): ModelscanEnvelopeBody {
  const plan = ARTIFACT_FORMAT_PLANS[input.format];
  const fmt = formatItem(input.format, input.formatDetail);
  let name = modelscanArtifactName(input.format);
  const rawReport = input.reportSha256 ? { sha256: input.reportSha256, bytes: 0 } : null;
  const unknownScan = (why: string) => item(MODELSCAN_SCAN_ITEM_KEY, "modelscan", "scan", "medium", 0, 0, "unknown", why);
  if (!plan.scanAs || !name) {
    // not handed to modelscan at all (safetensors, unsupported formats): the format item decides
    return { status: "completed", errorCode: null, items: [fmt.item], notRun: fmt.notRun, rawReport: null };
  }
  const failed = (errorCode: string, why: string, extra: EngineResultItem[] = []): ModelscanEnvelopeBody => ({
    status: "failed",
    errorCode,
    items: [fmt.item, unknownScan(why), ...extra],
    notRun: [],
    rawReport,
  });
  if (input.timedOut) return failed("engine_timeout", "modelscan did not finish within the run's time limit");
  if (input.format === "numpy") {
    // decisions 180–184: modelscan 0.8.8's NumPy scanner cannot read a header under numpy 2.x, so the
    // scanner checks the header itself and modelscan sees only an object array's pickle payload
    const npy = npyCheckSchema.safeParse(input.npy);
    if (!npy.success) return failed("npy_check_missing", "the .npy header was not checked");
    if (npy.data.kind === "invalid") {
      const problem = npy.data.problem;
      return {
        status: "completed",
        errorCode: null,
        items: [
          fmt.item,
          unknownScan("the .npy header was refused: the array cannot be read safely, so its content is unknown"),
          item("modelscan/error/1", MODELSCAN_ERROR_SYSTEM, problem, "medium", 0, 0, "unknown", `the .npy header was refused (${problem}); the artifact is unknown`),
        ],
        notRun: [],
        rawReport: null,
      };
    }
    if (npy.data.kind === "numeric") {
      // a numeric array is raw bytes: no pickle, so modelscan has nothing to scan and was not started
      if (input.report !== null || input.exitCode !== null) return failed("report_inconsistent", "modelscan ran on a numeric .npy, which has nothing for it to scan");
      return {
        status: "completed",
        errorCode: null,
        items: [
          fmt.item,
          item(MODELSCAN_SCAN_ITEM_KEY, "regulait-npy-header", "numeric", "low", 1, 0, "pass", "the .npy header verified a plain numeric dtype and the payload is exactly its size: no pickle to scan"),
        ],
        notRun: [],
        rawReport: null,
      };
    }
    // an object array: modelscan's pickle scanner was handed exactly the payload, as artifact.pkl
    name = NPY_OBJECT_PAYLOAD_NAME;
  }
  if (input.report === null) return failed("report_missing", "modelscan wrote no report");
  if (input.report === "too_large" || input.report.length > MODELSCAN_MAX_REPORT_BYTES) return failed("report_too_large", "modelscan's report is larger than the runner reads");
  let report: ModelscanReport;
  try {
    const parsed = modelscanReportSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.report)));
    if (!parsed.success) return failed("report_invalid", "modelscan's report does not have the 0.8.8 shape");
    report = parsed.data;
  } catch {
    return failed("report_invalid", "modelscan's report is not valid JSON");
  }
  // findings first: an issue is a finding whatever else happened
  const issueItems = report.issues.slice(0, 1000).map((iss, i) => {
    const member = iss.source.startsWith(`${name}:`) ? safeIdent(iss.source.slice(name.length + 1)) : null;
    return item(
      `modelscan/issue/${i + 1}`,
      MODELSCAN_ISSUE_SYSTEM,
      safeIdent(`${iss.module}.${iss.operator}`, 180),
      SEVERITY[iss.severity],
      1,
      1,
      "fail",
      `modelscan found an unsafe operator (${iss.severity})${member ? ` in member ${member}` : ""}`,
    );
  });
  // PR #212 review [4234946100]: the summary must agree with the lists it summarises; a report that
  // contradicts itself decides nothing (its findings are still kept)
  const summaryProblem = modelscanSummaryProblem(report);
  if (summaryProblem) return failed("report_inconsistent", `modelscan's report contradicts itself: ${summaryProblem}`, issueItems);
  if (input.exitCode === null || input.exitCode === MODELSCAN_EXIT.usage || input.exitCode < 0 || input.exitCode > MODELSCAN_EXIT.usage) {
    return failed("engine_error", `modelscan exited ${input.exitCode ?? "without a code"}`, issueItems);
  }
  const scanned = report.summary.scanned.scanned_files ?? [];
  const foreign = [...scanned, ...report.issues.map((i) => i.source)].some((s) => s !== name && !s.startsWith(`${name}:`));
  if (foreign) return failed("report_inconsistent", "modelscan's report names a file other than the one it was given", issueItems);
  const expectedExit =
    scanned.length === 0 && report.issues.length === 0
      ? MODELSCAN_EXIT.nothingScanned
      : report.errors.length > 0
        ? MODELSCAN_EXIT.errors
        : report.issues.length > 0
          ? MODELSCAN_EXIT.issues
          : MODELSCAN_EXIT.clean;
  // exit 3 also covers "errors and nothing scanned" (a file whose only result was a parse error)
  const consistent = input.exitCode === expectedExit || (input.exitCode === MODELSCAN_EXIT.nothingScanned && scanned.length === 0);
  if (!consistent) return failed("report_inconsistent", `modelscan exited ${input.exitCode} but its report implies ${expectedExit}`, issueItems);
  const errorItems = report.errors.slice(0, 1000).map((e, i) =>
    item(`modelscan/error/${i + 1}`, MODELSCAN_ERROR_SYSTEM, safeIdent(e.category, 64), "medium", 0, 0, "unknown", `modelscan could not read part of the artifact (${safeIdent(e.category, 64)}); that part is unknown`),
  );
  const items: EngineResultItem[] = [fmt.item];
  const notRun: Array<{ key: string; reason: EngineNotRunReason }> = [...fmt.notRun];
  const skipped = report.summary.skipped?.total_skipped ?? 0;
  if (scanned.length === 0 && report.issues.length === 0) {
    // nothing was scanned: a run-time not-run, never clean
    items.push(item(MODELSCAN_SCAN_ITEM_KEY, "modelscan", "scan", "medium", 0, 0, "not_run", "modelscan scanned nothing"));
    notRun.push({ key: MODELSCAN_SCAN_ITEM_KEY, reason: "engine_error" });
  } else if (report.errors.length > 0) {
    items.push(unknownScan(`modelscan reported ${report.errors.length} error(s); the parts it could not read are unknown`));
  } else if (report.issues.length > 0) {
    items.push(item(MODELSCAN_SCAN_ITEM_KEY, "modelscan", "scan", "high", 1, 1, "fail", `modelscan found ${report.issues.length} unsafe operator(s)`));
  } else {
    items.push(
      item(
        MODELSCAN_SCAN_ITEM_KEY,
        "modelscan",
        "scan",
        "low",
        1,
        0,
        "pass",
        `no known-unsafe operator found in ${scanned.length} scanned file(s)${skipped ? `; ${skipped} member(s) skipped as not scannable` : ""}`,
      ),
    );
  }
  return { status: "completed", errorCode: null, items: [...items, ...issueItems, ...errorItems], notRun, rawReport };
}

/** the not-run keys modelscan declares before any run (planning-time exclusions, ADR-0187 decision 61) */
export function modelscanReducedSet(): Array<{ key: string; reason: EngineNotRunReason }> {
  return [
    { key: MODELSCAN_FORMAT_ITEM_KEY, reason: "unsupported_format" },
    { key: MODELSCAN_SCAN_ITEM_KEY, reason: "unsupported_format" },
  ];
}

// ---------------------------------------------------------------------------
// The artifact scan's verdict (artifact_scans.verdict), decided by the GATEWAY
// ---------------------------------------------------------------------------

/** the items the verdict reads (the normalised items: the server's verdicts, never the engine's claims) */
export interface ArtifactVerdictItem {
  key: string;
  sourceSystem: string;
  sourceId: string;
  verdict: EngineItemVerdict;
  severity: RedTeamSeverity;
}

export type ArtifactScanVerdictValue = "clean" | "no_known_unsafe" | "unsafe" | "unknown" | "not_run";

export interface ArtifactScanFinding {
  kind: "unsafe_operator" | "executable_format" | "scan_error";
  id: string;
  severity: RedTeamSeverity;
}

/**
 * The artifact scan verdict, from the format the GATEWAY detected at upload (stored on the artifact),
 * how the run ended, and the normalised items. Strictest wins:
 *   - any unsafe operator found → `unsafe` (however the run ended);
 *   - a run that did not complete → `unknown` (`not_run` when it never ran);
 *   - the runner saw another format than the gateway → `unknown`;
 *   - an unsupported format → `not_run`;
 *   - any unknown item or run-time not-run → `unknown`;
 *   - otherwise the format's ceiling: `clean` only for a verified non-executable format whose format
 *     item passed; `no_known_unsafe` for an executable format whose scan passed; else `unknown`.
 */
export function deriveArtifactScanVerdict(input: {
  storedFormat: string;
  runStatus: EngineTerminalRunStatus;
  runVerdict: "pass" | "fail" | "unknown" | "not_run";
  runtimeNotRun: number;
  items: readonly ArtifactVerdictItem[];
}): { verdict: ArtifactScanVerdictValue; findings: ArtifactScanFinding[]; why: string } {
  const plan = (ARTIFACT_FORMAT_PLANS as Record<string, ArtifactFormatPlan>)[input.storedFormat] ?? ARTIFACT_FORMAT_PLANS.unrecognised;
  const findings: ArtifactScanFinding[] = [];
  for (const it of input.items) {
    if (it.sourceSystem === MODELSCAN_ISSUE_SYSTEM && it.verdict === "fail") findings.push({ kind: "unsafe_operator", id: it.sourceId, severity: it.severity });
    if (it.sourceSystem === MODELSCAN_ERROR_SYSTEM) findings.push({ kind: "scan_error", id: it.sourceId, severity: it.severity });
  }
  if (plan.executable) findings.push({ kind: "executable_format", id: input.storedFormat, severity: "high" });
  const out = (verdict: ArtifactScanVerdictValue, why: string) => ({ verdict, findings, why });
  if (findings.some((f) => f.kind === "unsafe_operator")) return out("unsafe", "modelscan found an unsafe operator");
  if (input.runStatus !== "completed") return out(input.runStatus === "not_run" ? "not_run" : "unknown", `the scan run ended ${input.runStatus}`);
  const fmt = input.items.find((i) => i.key === MODELSCAN_FORMAT_ITEM_KEY && i.sourceSystem === ARTIFACT_FORMAT_SYSTEM);
  if (!fmt || fmt.sourceId !== input.storedFormat) return out("unknown", "the runner did not confirm the format the gateway detected");
  if (plan.ceiling === "not_run") return out("not_run", "unsupported format: not scanned");
  if (input.items.some((i) => i.verdict === "unknown") || input.runtimeNotRun > 0) return out("unknown", "part of the scan is unknown or did not run");
  if (plan.ceiling === "clean") {
    return fmt.verdict === "pass" && input.runVerdict === "pass"
      ? out("clean", "a non-executable format whose structure verified")
      : out("unknown", "the format did not verify");
  }
  if (plan.ceiling === "no_known_unsafe") {
    const scan = input.items.find((i) => i.key === MODELSCAN_SCAN_ITEM_KEY);
    return scan?.verdict === "pass" ? out("no_known_unsafe", "no known-unsafe operator found; the format can run code when loaded") : out("unknown", "the scan did not complete cleanly");
  }
  return out("unknown", "this format can never be better than unknown");
}

/** may this verdict pass an admission check? Only `clean` (owner decision 2026-10-09, ADR-0187 decision 105) */
export function artifactScanAdmissible(verdict: string): boolean {
  return verdict === "clean";
}

/** the model-card evidence chip's words. Never "safe". */
export const ARTIFACT_SCAN_CHIP: Readonly<Record<ArtifactScanVerdictValue, string>> = Object.freeze({
  clean: "Non-executable format verified; no finding",
  no_known_unsafe: "No known-unsafe operator found (executable format)",
  unsafe: "Unsafe operator found",
  unknown: "Scan inconclusive",
  not_run: "Not scanned (unsupported format)",
});
