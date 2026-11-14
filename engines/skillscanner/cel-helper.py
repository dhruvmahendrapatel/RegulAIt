# ADR-0242 §3 — install the CEL helper we rebuilt (Go 1.27.3, from skill-scanner 2.3.2's own hashed sdist, the same
# `go build` flags as its packaging script) in place of the one its wheel bundles (built with Go 1.27.1, whose standard
# library carries published advisories), and rewrite the helper's manifest to describe the new binary.
#
#   python -I cel-helper.py <site-packages> <new-binary> <go-version>
#
# skill-scanner checks the manifest against the binary at every start (size, sha256, a Go version at or above its
# minimum, and every fixed field). Only the four fields that describe the build change here; anything else that
# differs, or a binary that is not the expected file, fails the build.
import hashlib
import json
import os
import re
import shutil
import sys

FILENAME = "skill-scanner-cel-go-linux-amd64"


def main(argv):
    site, binary, go_version = argv[1], argv[2], argv[3]
    if not re.fullmatch(r"go\d+\.\d+\.\d+", go_version):
        sys.exit(f"bad go version {go_version!r}")
    bin_dir = os.path.join(site, "skill_scanner", "core", "cel", "_bin")
    manifest_path = os.path.join(bin_dir, "manifest.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    helper = manifest["helper"]
    if helper.get("filename") != FILENAME or helper.get("helper_version") != "2.3.2" or helper.get("cel_go_version") != "v0.32.0":
        sys.exit("the bundled helper manifest is not the one this build expects")
    with open(binary, "rb") as f:
        data = f.read()
    if not data.startswith(b"\x7fELF"):
        sys.exit("the rebuilt helper is not an ELF binary")
    target = os.path.join(bin_dir, FILENAME)
    shutil.copyfile(binary, target)
    os.chmod(target, 0o555)
    helper.update(
        {
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
            "go_version": go_version,
            "toolchain_version": go_version,
        }
    )
    with open(manifest_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"cel helper: {go_version}, sha256 {helper['sha256']}, {len(data)} bytes")


if __name__ == "__main__":
    main(sys.argv)
