"""ADR-0245 (fsspec CVE-2026-104851) — drop spikee's one unused declared requirement, `datasets`, from its INSTALLED
metadata, so the image need not carry `datasets` and its closure (fsspec, aiohttp, pyarrow, huggingface-hub and 15
others), and `pip check` still passes strictly.

spikee 0.9.4 pins `datasets==4.8.4`, and that release caps `fsspec<=2026.2.0`, which carries CVE-2026-104851 (HIGH,
fixed in 2026.6.0). No module spikee runs imports `datasets`: its only importers are the five Hub fetch scripts under
spikee/data/workspace/datasets, which prune-data.py already removes (excluded-data.txt). So the dependency is removed,
not allow-listed.

    python -I drop-unused-requirement.py <site-packages> <expected METADATA sha256>

Fails (exit 1) unless the installed METADATA is exactly the one reviewed (by sha256) and holds exactly one line
`Requires-Dist: datasets==4.8.4`. Removes that line only, then rewrites the METADATA row of RECORD with the new
hash and size (the wheel's RECORD format: urlsafe base64 sha256 without padding).
"""
import base64
import hashlib
import os
import sys

DIST = "spikee-0.9.4.dist-info"
DROP = "Requires-Dist: datasets==4.8.4"


def fail(msg: str) -> None:
    sys.stderr.write(f"drop-unused-requirement: {msg}\n")
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: drop-unused-requirement.py <site-packages> <expected METADATA sha256>")
    site, expected = sys.argv[1], sys.argv[2]
    meta = os.path.join(site, DIST, "METADATA")
    record = os.path.join(site, DIST, "RECORD")
    with open(meta, "rb") as f:
        before = f.read()
    if hashlib.sha256(before).hexdigest() != expected:
        fail("spikee's METADATA is not the reviewed one (an upstream change must be re-reviewed)")
    lines = before.decode("utf-8").split("\n")
    hits = [i for i, line in enumerate(lines) if line.rstrip("\r") == DROP]
    if len(hits) != 1:
        fail(f"expected exactly one '{DROP}' line, found {len(hits)}")
    del lines[hits[0]]
    after = "\n".join(lines).encode("utf-8")
    with open(meta, "wb") as f:
        f.write(after)
    digest = base64.urlsafe_b64encode(hashlib.sha256(after).digest()).rstrip(b"=").decode("ascii")
    row_prefix = f"{DIST}/METADATA,"
    with open(record, "r", encoding="utf-8") as f:
        rows = f.read().split("\n")
    matched = [i for i, row in enumerate(rows) if row.startswith(row_prefix)]
    if len(matched) != 1:
        fail("RECORD has no single METADATA row")
    rows[matched[0]] = f"{row_prefix}sha256={digest},{len(after)}"
    with open(record, "w", encoding="utf-8") as f:
        f.write("\n".join(rows))
    print(f"drop-unused-requirement: removed '{DROP}' from {DIST}/METADATA")


if __name__ == "__main__":
    main()
