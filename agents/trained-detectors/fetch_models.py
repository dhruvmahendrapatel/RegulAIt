"""ADR-0220: BUILD-TIME model fetch for the trained-detector image.

Downloads exactly the files models.lock.json names, at the pinned repository
revision, into <out>/<dir>/, and refuses (exit 1) on any sha256 mismatch.
Runs only in the Dockerfile's `weights` stage; the final image carries the
verified files and no downloader. Standard library only.

    python3 -I fetch_models.py models.lock.json /opt/models
"""

import hashlib
import json
import os
import sys
import urllib.request

HF = "https://huggingface.co"


def fetch(url: str, dest: str, want: str) -> None:
    h = hashlib.sha256()
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            block = r.read(1 << 20)
            if not block:
                break
            h.update(block)
            f.write(block)
    if h.hexdigest() != want:
        os.unlink(tmp)
        sys.exit(f"sha256 mismatch for {url}: got {h.hexdigest()}, want {want}")
    os.replace(tmp, dest)


def main(lock_path: str, out: str) -> None:
    with open(lock_path) as f:
        lock = json.load(f)
    for m in lock["models"]:
        d = os.path.join(out, m["dir"])
        os.makedirs(d, exist_ok=True)
        for name, sha in m["files"].items():
            fetch(f"{HF}/{m['repo']}/resolve/{m['revision']}/{name}", os.path.join(d, name), sha)
    wheels = os.path.join(out, "wheels")
    os.makedirs(wheels, exist_ok=True)
    for w in lock["wheels"]:
        fetch(w["url"], os.path.join(wheels, w["url"].rsplit("/", 1)[1]), w["sha256"])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
