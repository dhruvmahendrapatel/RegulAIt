"""ADR-0187 B5-G (decision 145) — remove the excluded garak data from the installed package, and check
that the probe metadata the shared catalogue was generated from is the metadata this image ships.

    python -I prune-data.py <site-packages> excluded-data.txt <expected plugin_cache sha256>

Fails (exit 1) when a listed path is missing (an upstream change must be re-reviewed), when a path
escapes garak/data, or when garak/resources/plugin_cache.json is not the file the catalogue was read
from (packages/shared/src/engines/garak-upstream.ts, GARAK_UPSTREAM_SOURCE_SHA256).
"""
import hashlib
import os
import shutil
import sys


def main() -> int:
    site, listing, expected = sys.argv[1], sys.argv[2], sys.argv[3]
    garak = os.path.join(site, "garak")
    data = os.path.realpath(os.path.join(garak, "data"))
    cache = os.path.join(garak, "resources", "plugin_cache.json")
    with open(cache, "rb") as f:
        got = hashlib.sha256(f.read()).hexdigest()
    if got != expected:
        print(f"prune-data: plugin_cache.json is {got}, the catalogue was generated from {expected}")
        return 1
    removed = 0
    with open(listing, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            target = os.path.realpath(os.path.join(data, line))
            if not target.startswith(data + os.sep):
                print(f"prune-data: {line} escapes garak/data")
                return 1
            if os.path.isdir(target):
                shutil.rmtree(target)
            elif os.path.isfile(target):
                os.remove(target)
            else:
                print(f"prune-data: {line} is listed but not in the package: re-review the release")
                return 1
            removed += 1
    print(f"prune-data: removed {removed} excluded data paths; plugin_cache.json matches the catalogue")
    return 0


if __name__ == "__main__":
    sys.exit(main())
