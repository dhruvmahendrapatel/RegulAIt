"""ADR-0189 slice B5: run spdx3-validate 0.0.7's own checks (JSON schema + SHACL via pyshacl) with NO network, in CI.

Ported from spike B0 (spikes/bom-b0/spdx3/run_offline.py, R12 section 5). spdx3-validate's CLI downloads the JSON
schema and the SHACL model from spdx.org on every run, and rdflib's JSON-LD parser fetches the `@context` URL: unpinned
content at run time, and a failure air-gapped (amendment 4). This driver calls the library's public functions
(`schema_validator`, `check_graph`, `SPDX_VERSIONS`) with the vendored files, each checked against its pinned sha256
first, and parses each graph with the vendored context substituted in memory (the document itself is unchanged).

Usage: python -I run_offline.py [--require-offline] [--expect expected.json] <spdx.json> [...]

Fails closed:
  exit 2  no document given (R13), a vendored file whose sha256 is not the pinned one, or a document that is not
          SPDX 3.0.1;
  exit 3  --require-offline and a TCP connection to the outside could be opened (the step is not network-isolated);
  exit 1  a document does not conform, a `*.expect-fail.json` negative control DOES conform, or a triple count differs
          from --expect (every listed file must be present, and every given file must be listed).
"""
import hashlib
import json
import socket
import sys
from pathlib import Path

args = sys.argv[1:]
require_offline = "--require-offline" in args
args = [a for a in args if a != "--require-offline"]
expect_file = None
if "--expect" in args:
    i = args.index("--expect")
    if i + 1 >= len(args):
        print("run_offline.py: --expect needs a file", file=sys.stderr)
        sys.exit(2)
    expect_file = args[i + 1]
    del args[i:i + 2]

# R13: no document is a failure, checked before anything else so a misconfigured CI command cannot go green.
if not args:
    print("run_offline.py: no SPDX documents given; refusing to report success", file=sys.stderr)
    sys.exit(2)

if require_offline:
    # the CI step runs inside a fresh network namespace; if a connection can be opened, isolation failed
    for host, port in (("1.1.1.1", 443), ("8.8.8.8", 53)):
        try:
            socket.create_connection((host, port), timeout=3).close()
        except OSError:
            continue
        print(f"run_offline.py: reached {host}:{port}; this run is NOT network-isolated (refused)", file=sys.stderr)
        sys.exit(3)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PINNED = {
    ROOT / "packages" / "shared" / "vendor" / "spdx-3.0.1" / "spdx-json-schema.json": "582c64e809d5b3ef9bd0c4de13a32391b47b0284a3e8d199569fb96f649234b1",
    HERE / "spdx-model.ttl": "30ebb4af2d70a9809044ef46f44cc3dc5125226d70f818a50ed2e1d5f404c593",
    HERE / "spdx-context.jsonld": "c72b0928f094c83e5c127784edb1ebca2af74a104fcacc007c332b23cbc788bd",
}
for path, digest in PINNED.items():
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != digest:
        print(f"run_offline.py: {path} sha256 {actual} is not the pinned {digest}", file=sys.stderr)
        sys.exit(2)
schema_path, model_path, context_path = PINNED.keys()

import rdflib  # noqa: E402 (after the argument and pin checks on purpose)
from spdx3_validate.core import check_graph, schema_validator  # noqa: E402
from spdx3_validate.spdx_versions import SPDX_VERSIONS  # noqa: E402

VERSION = next(v for v in SPDX_VERSIONS if v.pretty == "3.0.1")
schema = json.loads(schema_path.read_text("utf-8"))
context = json.loads(context_path.read_text("utf-8"))
shacl = rdflib.Graph()
shacl.parse(str(model_path), format="turtle")
validator = schema_validator(schema)
expected = json.loads(Path(expect_file).read_text("utf-8")) if expect_file else None

failures = 0
seen = set()
for name in args:
    base = Path(name).name
    seen.add(base)
    data = json.loads(Path(name).read_text("utf-8"))
    if data.get("@context") != VERSION.context_url:
        print(f"run_offline.py: {name}: not an SPDX 3.0.1 document", file=sys.stderr)
        sys.exit(2)
    schema_errors = [f"{e.json_path}: {e.message}"[:200] for e in validator.iter_errors(data)]
    local = dict(data)
    local["@context"] = context["@context"]
    graph = rdflib.Graph()
    graph.parse(data=json.dumps(local), format="json-ld")
    shacl_errors = check_graph(graph, shacl, VERSION, True)
    ok = not schema_errors and not shacl_errors
    expect_fail = base.endswith(".expect-fail.json")
    verdict = "PASS" if ok != expect_fail else "UNEXPECTED"
    if ok == expect_fail:
        failures += 1
    if expected is not None and expected.get(base) != len(graph):
        print(f"run_offline.py: {base}: {len(graph)} triples, expected {expected.get(base)}", file=sys.stderr)
        failures += 1
    print(json.dumps({"file": base, "triples": len(graph), "schemaErrors": len(schema_errors),
                      "shaclErrors": len(shacl_errors), "conforms": ok, "expectFail": expect_fail, "verdict": verdict}))
    for e in (schema_errors + shacl_errors)[:5]:
        print("   ", e.replace("\n", "\n    ")[:600])
if expected is not None:
    missing = sorted(set(expected) - seen)
    if missing:
        print(f"run_offline.py: expected files not validated: {missing}", file=sys.stderr)
        failures += 1
sys.exit(1 if failures else 0)
