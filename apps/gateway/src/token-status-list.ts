/**
 * The IETF OAuth Token Status List encoding (draft-ietf-oauth-status-list §4): a byte array in which entry `i` takes
 * `bits` bits starting at bit `(i * bits) % 8` of byte `floor(i * bits / 8)` (least significant bit first), compressed
 * with ZLIB DEFLATE (RFC 1950) and carried as base64url in `status_list.lst`.
 *
 * Open source first (ADR-0176): the two maintained implementations were compared (ADR-0315 §"Approaches compared").
 * `@sd-jwt/jwt-status-list` is deprecated in favour of `@owf/token-status-list`, a pre-1.0 package with a CBOR and COSE
 * closure; both deflate through `pako`, whose "MIT AND Zlib" licence the workspace licence gate refuses. The format's
 * only algorithm is zlib, which the Node standard library provides (`node:zlib`); this file is the bit packing around
 * it, and its tests pin the draft's own encoded examples byte for byte.
 */
import { deflateSync, inflateSync } from "node:zlib";

export type StatusBits = 1 | 2 | 4 | 8;
export const STATUS_BITS: readonly StatusBits[] = [1, 2, 4, 8];
/** the largest list a verifier inflates: refuses a decompression bomb (our lists are 16 KiB) */
export const MAX_STATUS_LIST_BYTES = 4 * 1024 * 1024;

/** a fixed-size list of `bits`-wide statuses, all 0 (VALID) at first */
export class TokenStatusList {
  private constructor(
    readonly bits: StatusBits,
    private readonly bytes: Uint8Array,
  ) {}

  static empty(size: number, bits: StatusBits): TokenStatusList {
    if (!STATUS_BITS.includes(bits)) throw new RangeError("bits must be 1, 2, 4 or 8");
    if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError("size must be a positive integer");
    return new TokenStatusList(bits, new Uint8Array(Math.ceil((size * bits) / 8)));
  }

  /** decode `status_list.lst`; throws on a malformed or oversized list */
  static decode(lst: string, bits: StatusBits): TokenStatusList {
    if (!STATUS_BITS.includes(bits)) throw new RangeError("bits must be 1, 2, 4 or 8");
    if (!/^[A-Za-z0-9_-]+$/.test(lst)) throw new Error("the status list is not base64url");
    const bytes = inflateSync(Buffer.from(lst, "base64url"), { maxOutputLength: MAX_STATUS_LIST_BYTES });
    return new TokenStatusList(bits, new Uint8Array(bytes));
  }

  /** how many entries the list holds */
  get size(): number {
    return Math.floor((this.bytes.length * 8) / this.bits);
  }

  private place(index: number): { byte: number; shift: number; mask: number } {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.size) throw new RangeError("the index is outside the list");
    const bit = index * this.bits;
    return { byte: Math.floor(bit / 8), shift: bit % 8, mask: (1 << this.bits) - 1 };
  }

  get(index: number): number {
    const { byte, shift, mask } = this.place(index);
    return (this.bytes[byte]! >> shift) & mask;
  }

  set(index: number, value: number): void {
    const { byte, shift, mask } = this.place(index);
    if (!Number.isInteger(value) || value < 0 || value > mask) throw new RangeError(`a status must fit in ${this.bits} bit(s)`);
    this.bytes[byte] = (this.bytes[byte]! & ~(mask << shift)) | (value << shift);
  }

  /** `status_list.lst`: ZLIB DEFLATE at the best compression, base64url without padding */
  encode(): string {
    return deflateSync(this.bytes, { level: 9 }).toString("base64url");
  }
}
