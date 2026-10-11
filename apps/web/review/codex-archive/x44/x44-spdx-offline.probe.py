"""Independent X44 SHACL cross-check for vectors written by x44-spdx.probe.ts.

Run inside a fresh network namespace with the hash-locked SPDX Python closure:
  unshare -Urn -- /tmp/x44-spdx-venv/bin/python -I apps/web/review/x44-spdx-offline.probe.py /tmp/x44-spdx-vectors
The missing-cardinality documents intentionally conform to the official checks:
ADR0189 R3 therefore requires the independent product check alongside them.
"""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
vectors = Path(sys.argv[1])
expected = {
    "valid.spdx.json": True,
    "ai-missing-mandatory.spdx.json": True,
    "dataset-missing-mandatory.spdx.json": True,
    "supplier-tool.expect-fail.json": False,
}
result = subprocess.run(
    [sys.executable, "-I", str(root / "scripts/spdx3/run_offline.py"), "--require-offline", *[str(vectors / name) for name in expected]],
    text=True, capture_output=True, check=False,
)
print(result.stdout, end="")
if result.returncode != 0:
    print(result.stderr, file=sys.stderr)
    raise SystemExit(result.returncode)
rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
assert len(rows) == len(expected), (len(rows), len(expected))
assert {row["file"]: row["conforms"] for row in rows} == expected
assert all(row["verdict"] == "PASS" for row in rows)
assert all(row["schemaErrors"] == 0 for row in rows)
assert next(row for row in rows if row["file"] == "supplier-tool.expect-fail.json")["shaclErrors"] > 0
print(json.dumps({"independentShaclChecks": 4, "failed": 0, "networkNamespaceRequired": True}))
