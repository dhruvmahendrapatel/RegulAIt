"""ADR-0245 — remove the spikee data and modules the catalogue excludes from the installed package, and check that the
local seed folders the shared catalogue was read from are the ones this image ships (garak's prune-data.py pattern).

    python -I prune-data.py <site-packages> excluded-data.txt <expected local-seeds sha256>
    python -I prune-data.py <site-packages> --digest          (prints the local-seeds sha256 and exits)

The local-seeds digest is the sha256 of the sorted lines `<relative path> <file sha256>` of every file in the local
seed folders (packages/shared/src/engines/spikee.ts, SPIKEE_LOCAL_SEED_FOLDERS and SPIKEE_LOCAL_SEEDS_SHA256). Fails
(exit 1) when a listed path is missing (an upstream change must be re-reviewed), when a path escapes spikee/data, or
when the local seeds are not the files the catalogue was read from.
"""
import hashlib
import os
import shutil
import sys

LOCAL_SEED_FOLDERS = ["seeds-cybersec-2026-01", "seeds-llm-mailbox", "seeds-mini-test", "seeds-sysmsg-extraction-2025-04"]


def seeds_digest(data: str) -> str:
    rows = []
    base = os.path.join(data, "workspace", "datasets")
    for folder in LOCAL_SEED_FOLDERS:
        root = os.path.join(base, folder)
        for dirpath, _, files in os.walk(root):
            for name in files:
                full = os.path.join(dirpath, name)
                with open(full, "rb") as f:
                    rows.append(f"{os.path.relpath(full, base)} {hashlib.sha256(f.read()).hexdigest()}")
    return hashlib.sha256("\n".join(sorted(rows)).encode("utf-8")).hexdigest()


def main() -> int:
    site = sys.argv[1]
    data = os.path.realpath(os.path.join(site, "spikee", "data"))
    if sys.argv[2] == "--digest":
        print(seeds_digest(data))
        return 0
    listing, expected = sys.argv[2], sys.argv[3]
    got = seeds_digest(data)
    if got != expected:
        print(f"prune-data: the local seed folders are {got}, the catalogue was read from {expected}")
        return 1
    removed = 0
    with open(listing, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            target = os.path.realpath(os.path.join(data, line))
            if not target.startswith(data + os.sep):
                print(f"prune-data: {line} escapes spikee/data")
                return 1
            if os.path.isdir(target):
                shutil.rmtree(target)
            elif os.path.isfile(target):
                os.remove(target)
            else:
                print(f"prune-data: {line} is listed but not in the package: re-review the release")
                return 1
            removed += 1
    print(f"prune-data: removed {removed} excluded paths; the local seed folders match the catalogue")
    return 0


if __name__ == "__main__":
    sys.exit(main())
