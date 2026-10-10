# ADR-0187 decisions 180-184 (closes open question 15(b)) — the strict .npy header check.
#
# modelscan 0.8.8's NumPy scanner reads the header through numpy's private `_check_version`, which
# numpy 2.x removed, so every .npy read `unknown`. This script runs in the SCANNER container (no
# network, no credential) BEFORE modelscan, on the artifact the runner fetched, and decides:
#
#   numeric  a plain numeric dtype: the array is raw bytes, there is no pickle and so nothing for
#            modelscan to scan; the payload must be exactly itemsize * product(shape) bytes;
#   object   descr '|O': the payload after the header IS a pickle stream; exactly those bytes are
#            copied to <payload-out> (a new file) and the caller hands them to modelscan's PICKLE
#            scanner;
#   invalid  anything malformed, oversized, ambiguous or outside what we accept, with ONE problem
#            code. The caller reads it `unknown`, never `clean`.
#
# It prints exactly one JSON line and exits 0 for every decided outcome; any other exit, or any other
# output, is read by the caller as `npy_check_failed` (unknown). It never prints artifact text: only
# fixed codes and integers.
#
# The header is parsed with Python's own `ast` (no eval, no import, no attribute access): ast.parse in
# 'eval' mode, the node must be a dict display whose keys are exactly 'descr', 'fortran_order' and
# 'shape', each once (numpy's own reader keeps the LAST of a repeated key, measured on numpy 2.4.6, so
# a repeated key is ambiguous and refused here), and each value goes through ast.literal_eval. Stdlib
# only (run with -I -S), so it needs nothing numpy-specific and the tests run it without numpy.
#
# Usage: python -I -S npy-header.py <artifact.npy> <payload-out> <max-object-payload-bytes>
#        python -I -S npy-header.py --npz <artifact.npz> <payload-dir> <max-object-payload-bytes>
#                                   <max-uncompressed-bytes> <max-members>    (decisions 219-224, below)
import ast
import json
import os
import re
import sys
import zipfile
import zlib

MAGIC = b"\x93NUMPY"
# numpy's own default bound for a header it will parse (numpy.lib.format._MAX_HEADER_SIZE)
MAX_HEADER_BYTES = 10000
# numpy 2.x's dimension limit (NPY_MAXDIMS)
MAX_DIMS = 64
# what numpy's writer emits as dtype.str for a plain numeric scalar dtype; anything else (strings,
# void, datetime, structured or subarray dtypes) is outside what we accept: `npy_dtype_unsupported`
NUMERIC_DESCR = re.compile(r"\A(?:\|(?:b1|i1|u1)|[<>](?:i2|i4|i8|u2|u4|u8|f2|f4|f8|f16|c8|c16|c32))\Z")
OBJECT_DESCR = "|O"
KEYS = ("descr", "fortran_order", "shape")
CHUNK = 1 << 20


class Refused(Exception):
    def __init__(self, problem):
        super().__init__(problem)
        self.problem = problem


def header_of(f, size):
    """(header text, offset of the data) from the framing: magic, version, header length."""
    if size < 8:
        raise Refused("npy_truncated")
    lead = f.read(8)
    if lead[:6] != MAGIC:
        raise Refused("npy_magic_invalid")
    version = (lead[6], lead[7])
    if version == (1, 0):
        width = 2
    elif version in ((2, 0), (3, 0)):
        width = 4
    else:
        raise Refused("npy_version_unsupported")
    raw_len = f.read(width)
    if len(raw_len) != width:
        raise Refused("npy_truncated")
    hlen = int.from_bytes(raw_len, "little")
    if hlen == 0 or hlen > MAX_HEADER_BYTES:
        raise Refused("npy_header_length")
    start = 8 + width
    if start + hlen > size:
        raise Refused("npy_truncated")
    raw = f.read(hlen)
    if len(raw) != hlen:
        raise Refused("npy_truncated")
    # 1.0 and 2.0 are latin-1, 3.0 is UTF-8; every header we accept is ASCII in all three
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError:
        raise Refused("npy_header_encoding")
    return text, start + hlen


def parse_header(text):
    """the header's three values, or Refused. Never evaluates anything."""
    # numpy's writer pads with spaces and ends the header with one newline
    if not text.endswith("\n") or not text.startswith("{"):
        raise Refused("npy_header_not_literal")
    try:
        tree = ast.parse(text, mode="eval")
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        raise Refused("npy_header_not_literal")
    node = tree.body
    if not isinstance(node, ast.Dict):
        raise Refused("npy_header_not_literal")
    names = []
    for k in node.keys:
        # `**x` has a None key; a key must be a plain string constant
        if not (isinstance(k, ast.Constant) and type(k.value) is str):
            raise Refused("npy_header_keys")
        names.append(k.value)
    if len(names) != len(KEYS) or set(names) != set(KEYS):
        raise Refused("npy_header_keys")
    values = {}
    for name, v in zip(names, node.values):
        try:
            values[name] = ast.literal_eval(v)
        except (ValueError, TypeError, SyntaxError, RecursionError, MemoryError):
            raise Refused("npy_header_not_literal")
    descr, fortran, shape = values["descr"], values["fortran_order"], values["shape"]
    if type(fortran) is not bool:
        raise Refused("npy_header_value")
    if type(shape) is not tuple or len(shape) > MAX_DIMS or any(type(d) is not int or d < 0 for d in shape):
        raise Refused("npy_header_value")
    if type(descr) is not str:
        # a list is a structured dtype (its fields may hold objects): not accepted
        raise Refused("npy_dtype_unsupported")
    if descr == OBJECT_DESCR:
        return "object", shape, 0
    if NUMERIC_DESCR.match(descr) is None:
        raise Refused("npy_dtype_unsupported")
    return "numeric", shape, int(descr[2:])


def check_npy(f, size, payload_out, max_payload):
    """one .npy read from the stream `f` of `size` bytes, positioned at its start (a file, or a zip member)"""
    text, data_at = header_of(f, size)
    kind, shape, itemsize = parse_header(text)
    payload = size - data_at
    if kind == "numeric":
        count = 1
        for d in shape:
            count *= d
        expected = count * itemsize
        if payload < expected:
            raise Refused("npy_truncated")
        if payload > expected:
            raise Refused("npy_trailing_bytes")
        return {"kind": "numeric"}
    if payload == 0:
        raise Refused("npy_truncated")
    if payload > max_payload:
        raise Refused("npy_payload_too_large")
    copied = 0
    # 'xb': a new file only, never one that is already there. `f` is at the data already: header_of
    # read exactly the magic, the version, the length field and the header.
    with open(payload_out, "xb") as out:
        while copied <= payload:
            chunk = f.read(min(CHUNK, payload + 1 - copied))
            if not chunk:
                break
            out.write(chunk)
            copied += len(chunk)
        out.flush()
        os.fsync(out.fileno())
    if copied != payload:
        raise Refused("npy_truncated")
    return {"kind": "object", "payloadBytes": copied}


def decide(artifact, payload_out, max_payload):
    size = os.stat(artifact).st_size
    with open(artifact, "rb") as f:
        return check_npy(f, size, payload_out, max_payload)


# ---------------------------------------------------------------------------------------------------
# ADR-0187 decisions 219-224 (closes open question 15(c)): .npz archives
# ---------------------------------------------------------------------------------------------------
#
# A .npz is a zip of .npy members. modelscan's zip path hands every member to its broken NumPy scanner,
# so the scanner checks the archive here instead, with Python's own `zipfile`, strictly:
#
#   1. archive-level refusals (the whole archive reads `unknown`, nothing is extracted, modelscan is not
#      started): not a zip or cut short; an archive comment, bytes before the first member, between
#      members or after the central directory, overlapping members, or a data descriptor; a central
#      directory that disagrees with a local header or with the end record; no member; too many
#      members; a declared total uncompressed size over the bound (a zip bomb); an encrypted member; a
#      name with a path separator, a drive colon, a NUL or a traversal; a name that is not `<plain>.npy`;
#      a repeated name; a compression method other than stored or deflate;
#   2. each member, in central-directory order, through the same .npy check as a lone .npy, reading at
#      most its declared size (zipfile's own cap) and verifying that exactly the declared size came out
#      and that the CRC matches; a member that is itself an archive is refused (`npz_member_nested`);
#   3. an object member's payload is copied to `<dir>/member-NNNN.pkl` (NNNN = its 1-based position),
#      all object payloads together bounded by <max-object-payload-bytes>.
#
# A member-level refusal does not stop the others: the caller combines the members (any unsafe ->
# unsafe; any unknown -> unknown). The answer names members by position only, never by name.
NPZ_SEPARATORS = ("/", "\\", ":", "\x00")
NPZ_NAME = re.compile(r"\A[A-Za-z0-9_][A-Za-z0-9_.-]{0,250}\.npy\Z")
ARCHIVE_MAGICS = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08", b"\x1f\x8b", b"BZh", b"\xfd7zXZ\x00", b"7z\xbc\xaf\x27\x1c", b"Rar!", b"\x28\xb5\x2f\xfd")
EOCD = b"PK\x05\x06"
LOCAL = b"PK\x03\x04"
Z64_LOCATOR = b"PK\x06\x07"
Z64_EOCD = b"PK\x06\x06"


def member_payload_name(index):
    return "member-%04d.pkl" % (index + 1)


def u16(b, at):
    return int.from_bytes(b[at:at + 2], "little")


def u32(b, at):
    return int.from_bytes(b[at:at + 4], "little")


def u64(b, at):
    return int.from_bytes(b[at:at + 8], "little")


def end_record(f, size):
    """(entries, central directory offset) from the end record, which must end the file exactly"""
    if size < 22:
        raise Refused("npz_malformed")
    f.seek(size - 22)
    end = f.read(22)
    if end[:4] != EOCD:
        # an end record further back (an archive comment, or bytes after it) is a layout numpy never
        # writes; none at all is not a zip (or one cut short)
        back = min(size, 22 + 0xFFFF)
        f.seek(size - back)
        raise Refused("npz_layout" if EOCD in f.read(back) else "npz_malformed")
    if u16(end, 20) != 0:
        raise Refused("npz_layout")
    if u16(end, 4) != 0 or u16(end, 6) != 0 or u16(end, 8) != u16(end, 10):
        raise Refused("npz_layout")
    entries, cd_size, cd_off = u16(end, 10), u32(end, 12), u32(end, 16)
    tail = 22
    if entries == 0xFFFF or cd_size == 0xFFFFFFFF or cd_off == 0xFFFFFFFF:
        if size < 22 + 20 + 56:
            raise Refused("npz_malformed")
        f.seek(size - 22 - 20)
        loc = f.read(20)
        if loc[:4] != Z64_LOCATOR or u32(loc, 4) != 0 or u32(loc, 16) != 1:
            raise Refused("npz_malformed")
        if u64(loc, 8) != size - 22 - 20 - 56:
            # extensible data in the zip64 record, or a record somewhere else
            raise Refused("npz_layout")
        f.seek(size - 22 - 20 - 56)
        z = f.read(56)
        if z[:4] != Z64_EOCD or u64(z, 4) != 44 or u32(z, 16) != 0 or u32(z, 20) != 0 or u64(z, 24) != u64(z, 32):
            raise Refused("npz_layout")
        entries, cd_size, cd_off = u64(z, 32), u64(z, 40), u64(z, 48)
        tail = 22 + 20 + 56
    if cd_off + cd_size != size - tail:
        raise Refused("npz_layout")
    return entries, cd_off


def local_sizes(header, extra):
    """(crc, compressed, uncompressed) from a local header, resolving its zip64 extra field"""
    crc, csize, usize = u32(header, 14), u32(header, 18), u32(header, 22)
    if usize == 0xFFFFFFFF or csize == 0xFFFFFFFF:
        at, z64 = 0, None
        while at + 4 <= len(extra):
            hid, hlen = u16(extra, at), u16(extra, at + 2)
            if at + 4 + hlen > len(extra):
                raise Refused("npz_header_mismatch")
            if hid == 0x0001:
                if z64 is not None:
                    raise Refused("npz_header_mismatch")
                z64 = extra[at + 4:at + 4 + hlen]
            at += 4 + hlen
        if z64 is None:
            raise Refused("npz_header_mismatch")
        pos = 0
        if usize == 0xFFFFFFFF:
            if pos + 8 > len(z64):
                raise Refused("npz_header_mismatch")
            usize, pos = u64(z64, pos), pos + 8
        if csize == 0xFFFFFFFF:
            if pos + 8 > len(z64):
                raise Refused("npz_header_mismatch")
            csize = u64(z64, pos)
    return crc, csize, usize


def check_layout(f, infos, entries, cd_off):
    """every local header agrees with the central directory; the members tile the file from 0 to the central directory"""
    if entries != len(infos):
        raise Refused("npz_header_mismatch")
    cursor = 0
    for info in sorted(infos, key=lambda i: i.header_offset):
        if info.header_offset != cursor:
            # bytes before or between members (a gap), or two members sharing bytes (an overlap)
            raise Refused("npz_layout")
        f.seek(info.header_offset)
        header = f.read(30)
        if len(header) != 30 or header[:4] != LOCAL:
            raise Refused("npz_header_mismatch")
        flags, method = u16(header, 6), u16(header, 8)
        name_len, extra_len = u16(header, 26), u16(header, 28)
        raw_name = f.read(name_len)
        extra = f.read(extra_len)
        if len(raw_name) != name_len or len(extra) != extra_len:
            raise Refused("npz_malformed")
        if (flags | info.flag_bits) & 0x0008:
            # a data descriptor: the local header carries no sizes to cross-check, and numpy never writes one
            raise Refused("npz_layout")
        if flags != info.flag_bits or method != info.compress_type:
            raise Refused("npz_header_mismatch")
        name = raw_name.decode("utf-8" if flags & 0x0800 else "cp437", "replace")
        if name != info.orig_filename:
            raise Refused("npz_header_mismatch")
        crc, csize, usize = local_sizes(header, extra)
        if crc != info.CRC or csize != info.compress_size or usize != info.file_size:
            raise Refused("npz_header_mismatch")
        cursor = info.header_offset + 30 + name_len + extra_len + csize
    if cursor != cd_off:
        raise Refused("npz_layout")


def check_names(infos):
    """encryption, names, repeats and compression methods, from the central directory"""
    for info in infos:
        # traditional (bit 0) or strong (bit 6) encryption, or an encrypted central directory (bit 13)
        if info.flag_bits & (0x0001 | 0x0040 | 0x2000):
            raise Refused("npz_member_encrypted")
    seen = set()
    for info in infos:
        # orig_filename is the name as stored; zipfile's `filename` is cut at a NUL and has '\\' turned to '/'
        name = info.orig_filename
        if any(c in name for c in NPZ_SEPARATORS) or name.startswith(".."):
            raise Refused("npz_member_path")
        if NPZ_NAME.match(name) is None:
            raise Refused("npz_member_not_npy")
        if name in seen:
            raise Refused("npz_member_duplicate")
        seen.add(name)
    for info in infos:
        if info.compress_type not in (0, 8):
            raise Refused("npz_compression_unsupported")


class Prefixed:
    """a stream whose first bytes were already read (to look for a nested archive), put back in front"""

    def __init__(self, head, rest):
        self.head = head
        self.rest = rest

    def read(self, n):
        if self.head:
            out, self.head = self.head[:n], self.head[n:]
            return out
        return self.rest.read(n)


def check_member(zf, info, payload_out, budget):
    """one member's answer (never raises Refused); a refused member leaves no payload file behind"""
    try:
        with zf.open(info) as stream:
            head = stream.read(8)
            if any(head.startswith(m) for m in ARCHIVE_MAGICS):
                raise Refused("npz_member_nested")
            result = check_npy(Prefixed(head, stream), info.file_size, payload_out, budget)
            # read to the member's end: zipfile never yields more than the declared size, raises if the
            # stream ends first, and checks the CRC when the last byte is read
            drained = 0
            while True:
                chunk = stream.read(CHUNK)
                if not chunk:
                    break
                drained += len(chunk)
            if result["kind"] == "object" and drained != 0:
                raise Refused("npz_member_corrupt")
        return result
    except Refused as r:
        problem = r.problem
    except (zipfile.BadZipFile, zlib.error, EOFError, OSError, ValueError, NotImplementedError, RuntimeError):
        problem = "npz_member_corrupt"
    try:
        os.unlink(payload_out)
    except FileNotFoundError:
        pass
    return {"kind": "invalid", "problem": problem}


def decide_npz(artifact, payload_dir, max_payload, max_uncompressed, max_members):
    size = os.stat(artifact).st_size
    with open(artifact, "rb") as f:
        entries, cd_off = end_record(f, size)
        if entries > max_members:
            raise Refused("npz_too_many_members")
        try:
            zf = zipfile.ZipFile(f)
        except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, OSError, EOFError, NotImplementedError):
            raise Refused("npz_malformed")
        with zf:
            infos = zf.infolist()
            if not infos:
                raise Refused("npz_empty")
            if len(infos) > max_members:
                raise Refused("npz_too_many_members")
            # zipfile shifts every offset by any bytes it finds before the archive: none are allowed
            if zf.start_dir != cd_off:
                raise Refused("npz_layout")
            check_names(infos)
            if sum(i.file_size for i in infos) > max_uncompressed:
                raise Refused("npz_too_large")
            check_layout(f, infos, entries, cd_off)
            members, used = [], 0
            for index, info in enumerate(infos):
                result = check_member(zf, info, os.path.join(payload_dir, member_payload_name(index)), max_payload - used)
                if result["kind"] == "object":
                    used += result["payloadBytes"]
                members.append(result)
            return {"kind": "npz", "members": members}


def main(argv):
    if len(argv) == 7 and argv[1] == "--npz" and all(a.isdigit() for a in argv[4:]):
        try:
            result = decide_npz(argv[2], argv[3], int(argv[4]), int(argv[5]), int(argv[6]))
        except Refused as r:
            result = {"kind": "invalid", "problem": r.problem}
        sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
        return 0
    if len(argv) != 4 or not argv[3].isdigit():
        sys.stderr.write(
            "usage: npy-header.py <artifact.npy> <payload-out> <max-object-payload-bytes>\n"
            "       npy-header.py --npz <artifact.npz> <payload-dir> <max-object-payload-bytes> <max-uncompressed-bytes> <max-members>\n"
        )
        return 2
    try:
        result = decide(argv[1], argv[2], int(argv[3]))
    except Refused as r:
        result = {"kind": "invalid", "problem": r.problem}
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
