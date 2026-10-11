/**
 * ADR-0189 slice B4 — the STRICT reader of an `export-bundle/3` archive (B4.1,
 * B4.9 G9 first row). Pure: bytes in, files out; no file system, no clock.
 *
 * ADR-0176 check (2026-10-11): `tar-stream` is in the lockfile (transitively)
 * and `tar` is widely used, but both read pax (`x`/`g`) and GNU long-name (`L`)
 * extension headers transparently and merge them into the next entry, so an
 * archive carrying one would be accepted as a plain file. B4.9 G9 requires the
 * opposite: any typeflag other than a regular file, a second root, a name
 * outside the root, a repeated name, or an unreadable gzip or tar is refused
 * (`bundle_unreadable`). That is a stricter security posture than either
 * library offers (ADR-0176 §4 exception), so this ~80-line reader checks the raw
 * USTAR header fields instead. Decompression is `node:zlib`, with an output cap.
 */
import { gunzipSync } from "node:zlib";

/** the uncompressed ceiling: eight times the largest admitted bundle (B4 contract, `BOM_VERIFY_MAX_BUNDLE_BYTES`) */
export const BOM_ARCHIVE_MAX_TAR_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 256;

export type BomArchiveRead =
  | { ok: true; root: string; files: Map<string, Buffer>; tarBytes: number }
  | { ok: false; why: string };

const field = (h: Buffer, off: number, len: number): string => {
  const raw = h.subarray(off, off + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
};
const OCTAL = /^[0-7]{1,12}$/;
const octal = (h: Buffer, off: number, len: number): number | null => {
  const s = field(h, off, len).trim();
  if (!OCTAL.test(s)) return null;
  const n = Number.parseInt(s, 8);
  return Number.isSafeInteger(n) ? n : null;
};
/** a path segment: printable, no `.`/`..`, no backslash */
const SEGMENT = /^[A-Za-z0-9._+@=-]+$/;

/** gunzip (one member) then read the USTAR stream; every failure is a reason, never a throw */
export function readBomArchive(gz: Uint8Array): BomArchiveRead {
  const bytes = Buffer.from(gz.buffer, gz.byteOffset, gz.byteLength);
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { ok: false, why: "not a gzip stream" };
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: BOM_ARCHIVE_MAX_TAR_BYTES });
  } catch {
    return { ok: false, why: "the gzip stream does not decompress (or is over the size cap)" };
  }
  return readBomTar(tar);
}

/** the uncompressed USTAR stream (B4.1 "Tar order and headers") */
export function readBomTar(tar: Buffer): BomArchiveRead {
  const files = new Map<string, Buffer>();
  let root: string | null = null;
  let off = 0;
  for (;;) {
    if (off + 512 > tar.length) return { ok: false, why: "the tar stream ends without its two zero blocks" };
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      const next = tar.subarray(off + 512, off + 1024);
      if (next.length !== 512 || !next.every((b) => b === 0)) return { ok: false, why: "the end of archive is not two zero blocks" };
      // anything after the end marker must be zero padding
      if (!tar.subarray(off + 1024).every((b) => b === 0)) return { ok: false, why: "data after the end of the archive" };
      break;
    }
    if (files.size >= MAX_ENTRIES) return { ok: false, why: "too many entries" };
    // the checksum, computed with the field read as eight spaces
    const stored = octal(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (stored === null || stored !== sum) return { ok: false, why: "a header checksum does not match" };
    if (h.subarray(257, 263).toString("latin1") !== "ustar\0" || h.subarray(263, 265).toString("latin1") !== "00") return { ok: false, why: "not a USTAR header" };
    const type = String.fromCharCode(h[156]!);
    if (type !== "0") return { ok: false, why: "an entry that is not a regular file (directory, link or extension header)" };
    const size = octal(h, 124, 12);
    if (size === null) return { ok: false, why: "an entry size is not octal" };
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    const full = prefix ? `${prefix}/${name}` : name;
    const parts = full.split("/");
    if (parts.length < 2 || !parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) return { ok: false, why: "an entry name outside one root directory" };
    if (root === null) root = parts[0]!;
    else if (parts[0] !== root) return { ok: false, why: "entries under more than one root directory" };
    const path = parts.slice(1).join("/");
    if (files.has(path)) return { ok: false, why: "a repeated entry name" };
    const start = off + 512;
    const end = start + size;
    if (end > tar.length) return { ok: false, why: "an entry runs past the end of the archive" };
    files.set(path, Buffer.from(tar.subarray(start, end)));
    off = start + Math.ceil(size / 512) * 512;
  }
  if (root === null) return { ok: false, why: "an empty archive" };
  return { ok: true, root, files, tarBytes: tar.length };
}
