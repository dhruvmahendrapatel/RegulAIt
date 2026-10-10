/**
 * ADR-0187 B5-M — hostile and benign model-artifact fixtures, written BYTE BY BYTE (never produced by
 * pickling anything, never loaded). Used by the tests only; not exported from the package index.
 */
import { crc32 } from "node:zlib";

const enc = (s: string) => Buffer.from(s, "utf8");
/** SHORT_BINUNICODE */
const su = (s: string) => Buffer.concat([Buffer.from([0x8c, enc(s).length]), enc(s)]);

/** a protocol-N pickle that calls `<module>.<name>("echo pwned")` on load (STACK_GLOBAL, REDUCE) */
export function maliciousPickle(module = "os", name = "system", protocol = 4): Buffer {
  return Buffer.concat([Buffer.from([0x80, protocol]), su(module), su(name), Buffer.from([0x93]), su("echo pwned"), Buffer.from([0x85, 0x52, 0x2e])]);
}

/** a protocol-0 pickle (no PROTO opcode, no magic): GLOBAL 'os system', then REDUCE */
export function protocol0MaliciousPickle(): Buffer {
  return enc("cos\nsystem\n(S'echo pwned'\ntR.");
}

/** a protocol-4 pickle of {"a": 1}: no global at all */
export function cleanPickle(): Buffer {
  return Buffer.concat([Buffer.from([0x80, 0x04, 0x7d, 0x94, 0x28]), su("a"), Buffer.from([0x4b, 0x01, 0x75, 0x2e])]);
}

/** a malicious pickle cut short before its STOP (genops fails before it yields the global) */
export function truncatedMaliciousPickle(): Buffer {
  const p = maliciousPickle();
  return p.subarray(0, p.length - 3);
}

/**
 * PyTorch's LEGACY layout: the magic-number pickle, the protocol pickle, the sys-info pickle, then
 * the model pickle (here `os.system`), the storage-keys pickle and raw storage bytes. torch.load
 * unpickles the third. modelscan's PyTorch scanner reads only the first.
 */
export function legacyTorchFile(): Buffer {
  const magic = Buffer.from([0x80, 0x02, 0x8a, 0x0a, 0x6c, 0xfc, 0x9c, 0x46, 0xf9, 0x20, 0x6a, 0xa8, 0x50, 0x19, 0x2e]);
  const proto = Buffer.from([0x80, 0x02, 0x4d, 0xe9, 0x03, 0x2e]);
  const sysinfo = Buffer.from([0x80, 0x02, 0x7d, 0x71, 0x00, 0x2e]);
  const keys = Buffer.from([0x80, 0x02, 0x5d, 0x71, 0x00, 0x2e]);
  const raw = Buffer.alloc(32, 0xfe);
  return Buffer.concat([magic, proto, sysinfo, maliciousPickle("os", "system", 2), keys, raw]);
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  encrypted?: boolean;
}

/** a STORED (uncompressed) zip with valid CRCs, a central directory and an end record */
export function storedZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc(e.name);
    const crc = crc32(e.data) >>> 0;
    const flags = e.encrypted ? 0x1 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** a zip-layout PyTorch checkpoint whose data.pkl is `pickle` */
export function torchZip(pickle: Buffer): Buffer {
  return storedZip([
    { name: "archive/data.pkl", data: pickle },
    { name: "archive/version", data: enc("3\n") },
  ]);
}

/** a zip holding a zip holding a malicious pickle */
export function nestedZip(): Buffer {
  return storedZip([{ name: "inner.zip", data: storedZip([{ name: "data.pkl", data: maliciousPickle() }]) }]);
}

/** a valid safetensors file: tensors as [name, dtype, shape] with zero-filled data */
export function safetensorsFile(tensors: ReadonlyArray<[string, string, number[]]> = [["w", "F32", [2, 2]], ["b", "F16", [3]]], opts: { trailing?: number; header?: Record<string, unknown> } = {}): Buffer {
  const sizes: Record<string, number> = { F32: 4, F16: 2, BF16: 2, I64: 8, U8: 1, BOOL: 1 };
  const header: Record<string, unknown> = { __metadata__: { format: "pt" } };
  let off = 0;
  for (const [name, dtype, shape] of tensors) {
    const len = shape.reduce((a, d) => a * d, 1) * (sizes[dtype] ?? 4);
    header[name] = { dtype, shape, data_offsets: [off, off + len] };
    off += len;
  }
  const json = enc(JSON.stringify(opts.header ?? header));
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([n, json, Buffer.alloc(off + (opts.trailing ?? 0))]);
}

/**
 * A NumPy .npy file, byte by byte: the magic, the version, the header length (2 bytes for 1.0, 4 for
 * 2.0 and 3.0), the header (padded with spaces to a 64-byte boundary and ended by a newline, as
 * numpy's writer does, unless `pad` is false), then `payload`. `headerLength` overrides the length
 * field (to lie about it).
 */
export function npyFile(opts: { header: string; payload: Buffer; version?: readonly [number, number]; headerLength?: number; pad?: boolean }): Buffer {
  const [major, minor] = opts.version ?? [1, 0];
  const width = major === 1 ? 2 : 4;
  let header = opts.header;
  if (opts.pad !== false) {
    while ((8 + width + enc(header).length + 1) % 64 !== 0) header += " ";
    header += "\n";
  }
  const pre = Buffer.alloc(8 + width);
  Buffer.from([0x93, ...enc("NUMPY"), major, minor]).copy(pre, 0);
  const len = opts.headerLength ?? enc(header).length;
  if (width === 2) pre.writeUInt16LE(len, 8);
  else pre.writeUInt32LE(len, 8);
  return Buffer.concat([pre, enc(header), opts.payload]);
}

/** the header numpy writes for `descr` and `shape` */
export function npyHeader(descr: string, shape: readonly number[]): string {
  const s = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
  return `{'descr': '${descr}', 'fortran_order': False, 'shape': ${s}, }`;
}

/** a float64 .npy of `n` zeros (numeric: no pickle anywhere) */
export function numericNpy(version: readonly [number, number] = [1, 0], n = 3): Buffer {
  return npyFile({ header: npyHeader("<f8", [n]), payload: Buffer.alloc(8 * n), version });
}

/** a NumPy .npy file with an object dtype whose payload is `pickle` */
export function objectNpy(pickle: Buffer, version: readonly [number, number] = [1, 0]): Buffer {
  return npyFile({ header: npyHeader("|O", [1]), payload: pickle, version });
}
