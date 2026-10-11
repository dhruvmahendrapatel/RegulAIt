/**
 * ADR-0189 slice B4 — the B4.1 USTAR WRITER and the STRICT reader of an
 * `export-bundle/3` archive (B4.1 "Tar order and headers", B4.9 G9 first row).
 * Pure: bytes in, files out; no file system, no clock.
 *
 * The envelope is not malleable: after the entries are read, the archive is
 * REBUILT with the B4.1 writer from the files it carries and must equal the
 * archive received, byte for byte. So every header field (mode, uid, gid,
 * mtime, `uname`, `gname`, `linkname`, devices, the name/prefix split), the
 * zero padding after each name and between entries, the entry order (sorted by
 * full name) and the end of archive are exactly B4.1's; nothing that is not a
 * listed file's bytes can carry data past the signature or the R21 email scan
 * (ADR-0191 review of #344, item 1). The gzip stream is exactly one member, with
 * no flags (so no file name, comment or extra field) and MTIME 0, and its CRC
 * and length are checked.
 *
 * ADR-0176 check (2026-10-11): `tar-stream` is in the lockfile (transitively)
 * and `tar` is widely used, but both read pax (`x`/`g`) and GNU long-name (`L`)
 * extension headers transparently and merge them into the next entry, and
 * neither can say that an archive is byte-for-byte the canonical one. B4.9 G9
 * requires refusing all of that (`bundle_unreadable`): a stricter posture than
 * either library offers (ADR-0176 §4 exception). Decompression is `node:zlib`.
 */
import { crc32, inflateRawSync } from "node:zlib";

/** the uncompressed ceiling: eight times the largest admitted bundle (B4 contract, `BOM_VERIFY_MAX_BUNDLE_BYTES`) */
export const BOM_ARCHIVE_MAX_TAR_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 256;

export type BomArchiveRead =
  | { ok: true; root: string; files: Map<string, Buffer>; tarBytes: number }
  | { ok: false; why: string };

// ---------------------------------------------------------------------------
// the writer (B4.1 "Tar order and headers"; the same bytes as ADR-0116's buildTarGz)
// ---------------------------------------------------------------------------

/** ustar splits a long path at the LAST `/` that leaves a name of at most 99 bytes and a prefix of at most 154 */
function splitUstarPath(full: string): { name: string; prefix: string } {
  if (Buffer.byteLength(full, "utf8") <= 99) return { name: full, prefix: "" };
  for (let i = full.length - 1; i > 0; i--) {
    if (full[i] !== "/") continue;
    const name = full.slice(i + 1);
    const prefix = full.slice(0, i);
    if (Buffer.byteLength(name, "utf8") <= 99 && Buffer.byteLength(prefix, "utf8") <= 154) return { name, prefix };
  }
  throw new Error(`bom archive: path too long for ustar (${full})`);
}
function ustarHeader(full: string, size: number): Buffer {
  const { name, prefix } = splitUstarPath(full);
  const h = Buffer.alloc(512);
  const oct = (n: number, off: number, len: number) => h.write(`${n.toString(8).padStart(len - 1, "0")}\0`, off, len, "ascii");
  h.write(name, 0, 100, "utf8");
  oct(0o644, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(0, 136, 12);
  h.write("        ", 148, 8, "ascii");
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  if (prefix) h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}
/** the uncompressed B4.1 USTAR stream of `files` (full names), sorted by name, ending in two zero blocks */
export function writeBomTar(files: ReadonlyArray<{ path: string; body: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    parts.push(ustarHeader(f.path, f.body.length), f.body);
    const pad = (512 - (f.body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// the reader
// ---------------------------------------------------------------------------

/** exactly one gzip member: no flags, MTIME 0, a deflate stream, then CRC-32 and ISIZE, then nothing */
function gunzipOneMember(bytes: Buffer): Buffer | string {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) return "not a gzip stream";
  if (bytes[3] !== 0) return "a gzip header with flags (a file name, comment or extra field)";
  if (bytes.readUInt32LE(4) !== 0) return "a gzip header with a modification time";
  let out: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    out = inflateRawSync(bytes.subarray(10), { info: true, maxOutputLength: BOM_ARCHIVE_MAX_TAR_BYTES }) as unknown as typeof out;
  } catch {
    return "the gzip stream does not decompress (or is over the size cap)";
  }
  const trailer = bytes.subarray(10 + out.engine.bytesWritten);
  if (trailer.length !== 8) return "data after the gzip member (a second member, or trailing bytes)";
  if (trailer.readUInt32LE(0) !== crc32(out.buffer) || trailer.readUInt32LE(4) !== out.buffer.length % 2 ** 32) return "the gzip CRC or length does not match";
  return out.buffer;
}

/** gunzip (one member) then read the USTAR stream; every failure is a reason, never a throw */
export function readBomArchive(gz: Uint8Array): BomArchiveRead {
  const tar = gunzipOneMember(Buffer.from(gz.buffer, gz.byteOffset, gz.byteLength));
  return typeof tar === "string" ? { ok: false, why: tar } : readBomTar(tar);
}

const field = (h: Buffer, off: number, len: number): string => {
  const raw = h.subarray(off, off + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
};
const OCTAL = /^[0-7]{1,11}$/;
const octal = (h: Buffer, off: number, len: number): number | null => {
  const s = field(h, off, len);
  if (!OCTAL.test(s)) return null;
  const n = Number.parseInt(s, 8);
  return Number.isSafeInteger(n) ? n : null;
};
/** a path segment: printable, no `.`/`..`, no backslash */
const SEGMENT = /^[A-Za-z0-9._+@=-]+$/;

/** the uncompressed USTAR stream; accepted only when it is exactly what `writeBomTar` writes for its files */
export function readBomTar(tar: Buffer): BomArchiveRead {
  const entries: Array<{ full: string; body: Buffer }> = [];
  const files = new Map<string, Buffer>();
  let root: string | null = null;
  let off = 0;
  for (;;) {
    if (off + 512 > tar.length) return { ok: false, why: "the tar stream ends without its two zero blocks" };
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    if (entries.length >= MAX_ENTRIES) return { ok: false, why: "too many entries" };
    if (String.fromCharCode(h[156]!) !== "0") return { ok: false, why: "an entry that is not a regular file (directory, link or extension header)" };
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
    const body = Buffer.from(tar.subarray(start, end));
    files.set(path, body);
    entries.push({ full, body });
    off = start + Math.ceil(size / 512) * 512;
  }
  if (root === null) return { ok: false, why: "an empty archive" };
  // the envelope is exactly B4.1's: every header byte, the padding, the order and the end of archive
  let canonical: Buffer;
  try {
    canonical = writeBomTar(entries.map((e) => ({ path: e.full, body: e.body })));
  } catch {
    return { ok: false, why: "an entry name the B4.1 writer cannot write" };
  }
  if (!canonical.equals(tar)) return { ok: false, why: "the archive is not the B4.1 archive of its files (a header field, padding or entry order differs)" };
  return { ok: true, root, files, tarBytes: tar.length };
}
