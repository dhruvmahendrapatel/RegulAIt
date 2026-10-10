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
import ast
import json
import os
import re
import sys

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


def decide(artifact, payload_out, max_payload):
    size = os.stat(artifact).st_size
    with open(artifact, "rb") as f:
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
        f.seek(data_at)
        copied = 0
        # 'xb': a new file only, never one that is already there
        with open(payload_out, "xb") as out:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                out.write(chunk)
                copied += len(chunk)
            out.flush()
            os.fsync(out.fileno())
        if copied != payload:
            raise Refused("npy_truncated")
        return {"kind": "object", "payloadBytes": copied}


def main(argv):
    if len(argv) != 4 or not argv[3].isdigit():
        sys.stderr.write("usage: npy-header.py <artifact.npy> <payload-out> <max-object-payload-bytes>\n")
        return 2
    try:
        result = decide(argv[1], argv[2], int(argv[3]))
    except Refused as r:
        result = {"kind": "invalid", "problem": r.problem}
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
